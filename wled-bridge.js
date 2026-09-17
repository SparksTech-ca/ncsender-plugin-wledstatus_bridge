#!/usr/bin/env node
/**
 * WLED Status Light — Standalone Background Bridge
 *
 * ncSender's plugin sandbox (JsPluginEngine / Jint) can't make outbound
 * HTTP calls in the background, so this script runs as a completely
 * separate, always-on process instead. It connects to ncSender's own
 * WebSocket and REST API — the same ones the browser UI itself uses — to
 * read live machine status and drive WLED continuously, with no dialog
 * needing to stay open.
 *
 * Settings are read from the SAME plugin settings you configure in
 * ncSender's "WLED Status Light" dialog (Settings -> Plugins), via the
 * documented GET /api/plugins/:pluginId/settings endpoint. This script is
 * just an extra always-on delivery mechanism for that same configuration —
 * the dialog stays the single place you edit settings.
 *
 * Setup:
 *   1. npm install
 *   2. node wled-bridge.js
 *   (see README.md in this folder for running this automatically at login)
 *
 * Idle auto-off is owned exclusively by this bridge. The plugin dialog does
 * not run its own idle timer — running two would race each other and
 * double-send `{ on: false }` when both are active (the normal case).
 */

import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  EFFECTS,
  flattenStatePayload,
  resolveDisplayState,
  extractXPosition,
  buildFollowerSegments,
  buildPlainColorSegments,
  buildJobProgressSegments,
  computeFollowerIndex,
  createSegmentTracker,
  createJobLoadedTracker,
  DEFAULT_STATE_COLORS
} from './lib/wled-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let BRIDGE_VERSION = 'unknown';
try {
  BRIDGE_VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown';
} catch (_) {}

let WebSocketImpl;
try {
  WebSocketImpl = require('ws');
} catch (_) {
  if (typeof WebSocket !== 'undefined') {
    WebSocketImpl = WebSocket;
  } else {
    console.error('No WebSocket implementation available. Run "npm install ws", or use Node.js 22+.');
    process.exit(1);
  }
}

const NCSENDER_HOST = process.env.NCSENDER_HOST || 'localhost';
const NCSENDER_PORT = Number(process.env.NCSENDER_PORT) || 8090;
const WLED_PORT = Number(process.env.WLED_PORT) || 80;
const PLUGIN_ID = 'com.sparkstech.wledstatus';
const SETTINGS_REFRESH_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

// Verbose state + WLED traffic logging. Off by default because the state
// handler runs on every server tick; set WLED_DEBUG=1 in the environment
// to turn it on without editing this file.
const DEBUG = /^(1|true|yes)$/i.test(process.env.WLED_DEBUG || '');
const log = DEBUG ? function () { console.log(new Date().toISOString(), '[wled-bridge]', ...arguments); } : function () {};
// Always-printed lines: lifecycle events worth seeing even in production,
// so the bridge isn't silently dead when something goes wrong.
function logAlways() { console.log(new Date().toISOString(), '[wled-bridge]', ...arguments); }

const FALLBACK_COLORS = DEFAULT_STATE_COLORS;

let settings = null;
let lastDisplayState = null;
let lastFollowerIndex = null;
let lastJobStatus = null;
let celebrating = false;
let cachedXMax = null;
let wledRequestInFlight = false;
let pendingApply = null;
let jobProgressActive = false;
let lastJobProgressLit = null;

let lastKnownMachineState = {};
const jobLoaded = createJobLoadedTracker();
const segTracker = createSegmentTracker();

function fetchJson(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: NCSENDER_HOST, port: NCSENDER_PORT, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

function settingsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const va = a[k], vb = b[k];
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      if (!settingsEqual(va, vb)) return false;
    } else if (va !== vb) {
      return false;
    }
  }
  return true;
}

async function refreshSettings() {
  try {
    const fresh = await fetchJson(`/api/plugins/${PLUGIN_ID}/settings`);
    if (fresh && typeof fresh === 'object') {
      const prev = settings;
      settings = fresh;
      if (prev && !settingsEqual(prev, fresh)) {
        jobProgressActive = false;
        lastJobProgressLit = null;
        lastDisplayState = null;
        lastFollowerIndex = null;
        cachedXMax = null;
        segTracker.forget();
        log('settings changed — reset derived state');
      }
    }
  } catch (err) {
    // Connection failures are common enough at startup that spamming this
    // every 5s would drown the console — log once per attempt only when
    // DEBUG is on. The user will see the effect (nothing lights up) and
    // check the log, at which point they'll turn WLED_DEBUG on.
    log('failed to load plugin settings (is ncSender running on port ' + NCSENDER_PORT + '?):', err.message);
  }
}

function sendToHost(host, body) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    try {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: host,
          port: WLED_PORT,
          path: '/json/state',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 3000
        },
        (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(data);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

function getAllHosts() {
  const hosts = [];
  const primary = (typeof settings.wledHost === 'string' ? settings.wledHost : '').trim();
  if (primary) hosts.push(primary);
  (settings.secondaryWledHosts || []).forEach((entry) => {
    const h = entry && typeof entry === 'object' ? entry.host : entry;
    if (typeof h === 'string' && h && !hosts.includes(h)) hosts.push(h);
  });
  return hosts;
}

async function getXMaxTravel() {
  if (settings.xMaxOverride && settings.xMaxOverride > 0) return settings.xMaxOverride;
  if (cachedXMax) return cachedXMax;
  try {
    const data = await fetchJson('/api/firmware');
    const setting130 = data && data.settings && data.settings['130'];
    const value = setting130 ? Number.parseFloat(setting130.value) : null;
    if (value && value > 0) cachedXMax = value;
  } catch (_) {}
  return cachedXMax;
}

async function applyJobProgress(progressPercent) {
  const host = (typeof settings.jobProgressHost === 'string' ? settings.jobProgressHost : '').trim();
  if (!host) return;
  const { segments } = buildJobProgressSegments(progressPercent, settings);
  const finalSegments = segTracker.reconcile(host, segments);
  const ok = await sendToHost(host, { on: true, bri: settings.brightness ?? 255, seg: finalSegments });
  log('applyJobProgress', progressPercent + '%', ok ? 'ok' : 'FAILED');
}

async function applyColor(state, followerIndex) {
  const color = (settings.colors && settings.colors[state]) || FALLBACK_COLORS[state] || { r: 255, g: 255, b: 255 };
  const brightness = settings.brightness ?? 255;
  const followerHost = (typeof settings.followerHost === 'string' && settings.followerHost.trim())
    ? settings.followerHost.trim()
    : (typeof settings.wledHost === 'string' ? settings.wledHost.trim() : '');
  const jobProgressHost = (typeof settings.jobProgressHost === 'string' ? settings.jobProgressHost : '').trim();

  const tasks = getAllHosts().map((host) => {
    if (settings.xFollowEnabled && host === followerHost) {
      const desired = buildFollowerSegments(color, followerIndex, settings);
      return sendToHost(host, { on: true, bri: brightness, seg: segTracker.reconcile(host, desired) })
        .then((ok) => log('applyColor[follower:' + host + ']', state, followerIndex != null ? '(LED ' + followerIndex + ')' : '', ok ? 'ok' : 'FAILED'));
    }
    if (settings.jobProgressEnabled && host === jobProgressHost && jobProgressActive) {
      return Promise.resolve(true);
    }
    const ledCount = host === followerHost
      ? (settings.ledCount || 30)
      : host === jobProgressHost
        ? (settings.jobProgressLedCount || 30)
        : undefined;
    const desired = buildPlainColorSegments(color, ledCount);
    return sendToHost(host, { on: true, bri: brightness, seg: segTracker.reconcile(host, desired) })
      .then((ok) => log('applyColor[' + host + ']', state, ok ? 'ok' : 'FAILED'));
  });

  await Promise.all(tasks);
}

async function queueApplyColor(state, followerIndex) {
  if (wledRequestInFlight) {
    pendingApply = { state, followerIndex };
    return;
  }
  wledRequestInFlight = true;
  try {
    await applyColor(state, followerIndex);
  } finally {
    wledRequestInFlight = false;
    if (pendingApply) {
      const next = pendingApply;
      pendingApply = null;
      queueApplyColor(next.state, next.followerIndex);
    }
  }
}

async function playCompletionEffect() {
  celebrating = true;
  const fx = EFFECTS[settings.completionEffect] ?? EFFECTS.fireworks;
  log('job completed — playing', settings.completionEffect || 'fireworks');
  const body = (host) => ({
    on: true,
    bri: settings.brightness ?? 255,
    seg: segTracker.reconcile(host, [{ id: 0, fx, sx: 180, ix: 200 }])
  });
  await Promise.all(getAllHosts().map((host) => sendToHost(host, body(host))));

  const durationMs = (settings.completionDurationSec ?? 6) * 1000;
  setTimeout(async () => {
    celebrating = false;
    lastDisplayState = 'idle';
    lastFollowerIndex = null;
    await queueApplyColor('idle', null);
  }, durationMs);
}

// Idle auto-off — owned exclusively by the bridge.
let idleSince = null;
let poweredOffForIdle = false;

function trackIdleTiming(state) {
  if (state === 'idle') {
    if (idleSince === null) {
      idleSince = Date.now();
      log('idle timer started (state=idle)');
    }
  } else {
    if (idleSince !== null) log('idle timer reset (state=' + state + ')');
    idleSince = null;
    poweredOffForIdle = false;
  }
}

async function checkIdleTimeout() {
  if (!settings || !settings.idleOffMinutes || settings.idleOffMinutes <= 0) return;
  if (idleSince === null || poweredOffForIdle || celebrating) return;
  if (Date.now() - idleSince >= settings.idleOffMinutes * 60000) {
    poweredOffForIdle = true;
    const hosts = getAllHosts();
    await Promise.all(hosts.map((h) => sendToHost(h, { on: false })));
    logAlways('idle timeout reached (' + settings.idleOffMinutes + ' min) — turned off ' + hosts.length + ' instance(s)');
  }
}

async function handleServerState(payload) {
  if (!settings || celebrating) return;
  const ms = flattenStatePayload(payload);
  if (!ms || Object.keys(ms).length === 0) return;

  lastKnownMachineState = Object.assign({}, lastKnownMachineState, ms);
  const merged = lastKnownMachineState;
  jobLoaded.merge(payload);

  const jl = jobLoaded.get();
  const jobStatus = (jl && jl.status) || merged.jobStatus || merged.senderStatus || null;

  const state = resolveDisplayState(merged, jobStatus);
  log('jobStatus resolved to:', jobStatus, '(state=' + state + ')');
  trackIdleTiming(state);

  let followerIndex = null;
  if (settings.xFollowEnabled && state !== 'homing') {
    const rawX = extractXPosition(merged);
    if (typeof rawX === 'number') {
      const x = rawX + (settings.followerPositionOffsetMm || 0);
      const xMax = await getXMaxTravel();
      if (xMax) {
        const ratio = Math.max(0, Math.min(1, Math.abs(x) / xMax));
        followerIndex = computeFollowerIndex(ratio, settings);
      }
    }
  }

  const progressPercent = jl && typeof jl.progressPercent === 'number' ? jl.progressPercent : null;
  const jobProgressHost = (typeof settings.jobProgressHost === 'string' ? settings.jobProgressHost : '').trim();
  const shouldShowProgress = !!(settings.jobProgressEnabled && jobProgressHost && jobStatus === 'running' && progressPercent != null);
  if (shouldShowProgress !== jobProgressActive) {
    jobProgressActive = shouldShowProgress;
    lastJobProgressLit = null;
  }

  if (state !== lastDisplayState || followerIndex !== lastFollowerIndex) {
    lastDisplayState = state;
    lastFollowerIndex = followerIndex;
    queueApplyColor(state, followerIndex).catch((err) => log('queueApplyColor error:', err.message));
  }

  if (shouldShowProgress) {
    const { litCount } = buildJobProgressSegments(progressPercent, settings);
    if (litCount !== lastJobProgressLit) {
      lastJobProgressLit = litCount;
      applyJobProgress(progressPercent).catch((err) => log('applyJobProgress error:', err.message));
    }
  }

  if (jobStatus) {
    if (lastJobStatus === 'running' && jobStatus === 'completed') {
      await playCompletionEffect();
    }
    lastJobStatus = jobStatus;
  }
}

function connect() {
  const ws = new WebSocketImpl(`ws://${NCSENDER_HOST}:${NCSENDER_PORT}`);

  ws.addEventListener('open', () => logAlways('connected to ncSender WebSocket at ' + NCSENDER_HOST + ':' + NCSENDER_PORT));

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      const text = typeof event.data === 'string' ? event.data : event.data.toString();
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (msg.type === 'server-state-updated') {
      handleServerState(msg.data).catch((err) => log('handleServerState error:', err.message));
    }
  });

  ws.addEventListener('close', () => {
    logAlways('WebSocket closed, reconnecting in ' + RECONNECT_DELAY_MS + 'ms');
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', (event) => log('WebSocket error:', (event && (event.message || event.error)) || event));
}

async function main() {
  logAlways('starting — wled-status-bridge v' + BRIDGE_VERSION + ' — ncSender expected at ' + NCSENDER_HOST + ':' + NCSENDER_PORT);
  logAlways('verbose logging ' + (DEBUG ? 'ON (WLED_DEBUG=1)' : 'off (set WLED_DEBUG=1 to enable)'));

  await refreshSettings();
  if (!settings) {
    logAlways('WARNING: could not load plugin settings on startup — will keep retrying every ' + SETTINGS_REFRESH_MS + 'ms');
  }

  setInterval(refreshSettings, SETTINGS_REFRESH_MS);
  setInterval(() => { checkIdleTimeout().catch((err) => log('checkIdleTimeout error:', err.message)); }, 30000);
  connect();
}

main();