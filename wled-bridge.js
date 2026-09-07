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
 */

const http = require('http');

let WebSocketImpl;
try {
  WebSocketImpl = require('ws');
} catch (_) {
  if (typeof WebSocket !== 'undefined') {
    WebSocketImpl = WebSocket; // Node 22+ has a native global WebSocket client
  } else {
    console.error('No WebSocket implementation available. Run "npm install ws", or use Node.js 22+.');
    process.exit(1);
  }
}

const NCSENDER_HOST = process.env.NCSENDER_HOST || 'localhost';
const NCSENDER_PORT = Number(process.env.NCSENDER_PORT) || 8090; // change if you set a custom "Remote Control Port" in ncSender
const WLED_PORT = Number(process.env.WLED_PORT) || 80; // WLED normally listens on 80; override only for testing
const PLUGIN_ID = 'com.sparkstech.wledstatus';
const SETTINGS_REFRESH_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

const EFFECTS = { fireworks: 42, chase: 28, theaterchase: 11, colorloop: 8, strobe: 23 };

let settings = null;
let lastDisplayState = null;
let lastFollowerIndex = null;
let lastJobStatus = null;
let celebrating = false;
let cachedXMax = null;
let wledRequestInFlight = false;
let pendingApply = null;

function log(...args) {
  console.log(new Date().toISOString(), '[wled-bridge]', ...args);
}

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: NCSENDER_HOST, port: NCSENDER_PORT, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function refreshSettings() {
  try {
    const fresh = await fetchJson(`/api/plugins/${PLUGIN_ID}/settings`);
    if (fresh && typeof fresh === 'object') settings = fresh;
  } catch (err) {
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
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.write(data);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

function getAllHosts() {
  const hosts = [];
  const primary = (settings.wledHost || '').trim();
  if (primary) hosts.push(primary);
  (settings.secondaryWledHosts || []).forEach((h) => { if (h) hosts.push(h); });
  return hosts;
}

function resolveDisplayState(ms) {
  if (!ms) return 'idle';
  if (ms.isToolChanging) return 'tool-changing';
  if (ms.isProbing) return 'probing';
  const s = String(ms.status || 'idle').toLowerCase();
  if (s === 'jog') return 'run';
  if (s === 'home') return 'homing';
  if (['run', 'hold', 'alarm', 'door', 'check'].includes(s)) return s;
  return 'idle';
}

function extractXPosition(ms) {
  const pos = ms && ms.MPos;
  if (!pos) return null;
  // Handle both the documented { x, y, z } shape and the comma-separated
  // string actually observed on the wire ("x,y,z,a").
  if (typeof pos === 'string') {
    const parts = pos.split(',').map((p) => Number.parseFloat(p.trim()));
    return Number.isFinite(parts[0]) ? parts[0] : null;
  }
  if (typeof pos === 'object' && Number.isFinite(pos.x)) return pos.x;
  return null;
}

async function getXMaxTravel() {
  if (settings.xMaxOverride && settings.xMaxOverride > 0) return settings.xMaxOverride;
  if (cachedXMax) return cachedXMax;
  try {
    const data = await fetchJson('/api/firmware');
    const setting130 = data && data.settings && data.settings['130'];
    const value = setting130 ? Number.parseFloat(setting130.value) : null;
    if (value && value > 0) cachedXMax = value;
  } catch (_) {
    /* ignore, fall back to null */
  }
  return cachedXMax;
}

const FALLBACK_COLORS = {
  idle: { r: 255, g: 255, b: 255 }, run: { r: 0, g: 255, b: 0 }, hold: { r: 255, g: 193, b: 7 },
  alarm: { r: 255, g: 0, b: 0 }, door: { r: 253, g: 126, b: 20 }, check: { r: 0, g: 123, b: 255 },
  probing: { r: 26, g: 188, b: 156 }, 'tool-changing': { r: 201, g: 18, b: 168 },
  homing: { r: 0, g: 210, b: 255 }
};

async function applyColor(state, followerIndex) {
  const color = (settings.colors && settings.colors[state]) || FALLBACK_COLORS[state] || { r: 255, g: 255, b: 255 };
  const brightness = settings.brightness ?? 255;

  const tasks = [];
  const primaryHost = (settings.wledHost || '').trim();
  if (primaryHost) {
    const seg = [{ fx: 0, col: [[color.r, color.g, color.b]] }];
    if (settings.xFollowEnabled && followerIndex != null) {
      const width = Math.max(1, settings.followerWidth || 1);
      const ledCount = Math.max(1, settings.ledCount || 30);
      // Center the cursor on followerIndex rather than starting there.
      const halfWidth = Math.floor(width / 2);
      const start = Math.max(0, Math.min(ledCount - width, followerIndex - halfWidth));
      const stop = Math.min(ledCount, start + width);
      const fc = settings.followerColor || { r: 255, g: 255, b: 255 };
      seg[0].id = 0;
      seg[0].start = 0;
      seg[0].stop = ledCount;
      seg.push({ id: 1, start, stop, fx: 0, col: [[fc.r, fc.g, fc.b]] });
    }
    tasks.push(sendToHost(primaryHost, { on: true, bri: brightness, seg }).then((ok) => log('applyColor[primary]', state, followerIndex != null ? '(LED ' + followerIndex + ')' : '', ok ? 'ok' : 'FAILED')));
  }

  const secondaryBody = { on: true, bri: brightness, seg: [{ fx: 0, col: [[color.r, color.g, color.b]] }] };
  (settings.secondaryWledHosts || []).forEach((host) => {
    tasks.push(sendToHost(host, secondaryBody).then((ok) => log('applyColor[' + host + ']', state, ok ? 'ok' : 'FAILED')));
  });

  await Promise.all(tasks);
}

// Ensures at most one outbound request to WLED is ever in flight at once.
// WLED's onboard web server (typically an ESP8266/ESP32) can't keep up with
// rapid overlapping requests during continuous jogging - this coalesces
// any state changes that arrive mid-request into just the latest one,
// applied as soon as the current request finishes, instead of firing a
// flood of concurrent requests that time out or get refused.
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
  const body = { on: true, bri: settings.brightness ?? 255, seg: [{ fx, sx: 180, ix: 200 }] };
  await Promise.all(getAllHosts().map((host) => sendToHost(host, body)));

  const durationMs = (settings.completionDurationSec ?? 6) * 1000;
  setTimeout(async () => {
    celebrating = false;
    lastDisplayState = 'idle';
    lastFollowerIndex = null;
    await queueApplyColor('idle', null);
  }, durationMs);
}

let lastKnownMachineState = {};

function computeFollowerIndex(ratio) {
  if (settings.xFollowInvert) ratio = 1 - ratio;
  const ledCount = Math.max(1, settings.ledCount || 30);
  const startOffset = Math.max(0, settings.followerStartOffset || 0);
  const endOffset = Math.max(0, settings.followerEndOffset || 0);
  const usableStart = Math.min(ledCount - 1, startOffset);
  const usableEnd = Math.max(usableStart, ledCount - 1 - endOffset);
  return Math.round(usableStart + ratio * (usableEnd - usableStart));
}

let idleSince = null;
let poweredOffForIdle = false;

function trackIdleTiming(state) {
  if (state === 'idle') {
    if (idleSince === null) idleSince = Date.now();
  } else {
    idleSince = null;
    poweredOffForIdle = false;
  }
}

async function checkIdleTimeout() {
  if (!settings || !settings.idleOffMinutes || settings.idleOffMinutes <= 0) return;
  if (idleSince === null || poweredOffForIdle || celebrating) return;
  const elapsedMs = Date.now() - idleSince;
  if (elapsedMs >= settings.idleOffMinutes * 60000) {
    poweredOffForIdle = true;
    const hosts = getAllHosts();
    await Promise.all(hosts.map((h) => sendToHost(h, { on: false })));
    log('idle timeout reached (' + settings.idleOffMinutes + ' min) — turned off ' + hosts.length + ' instance(s)');
  }
}

async function handleServerState(payload) {
  if (!settings || celebrating) return;
  const ms = payload && payload.machineState;
  if (!ms) return;

  // Real telemetry only includes a `status` field on some messages - mid-jog
  // ticks often carry just MPos/WPos with no status at all. Merge into what
  // we already knew so a position-only message doesn't wipe out the last
  // known status.
  lastKnownMachineState = Object.assign({}, lastKnownMachineState, ms);
  const merged = lastKnownMachineState;

  const state = resolveDisplayState(merged);
  trackIdleTiming(state);
  let followerIndex = null;
  if (settings.xFollowEnabled) {
    const x = extractXPosition(merged);
    if (typeof x === 'number') {
      const xMax = await getXMaxTravel();
      if (xMax) {
        const ratio = Math.max(0, Math.min(1, Math.abs(x) / xMax));
        followerIndex = computeFollowerIndex(ratio);
      }
    }
  }

  if (state !== lastDisplayState || followerIndex !== lastFollowerIndex) {
    lastDisplayState = state;
    lastFollowerIndex = followerIndex;
    queueApplyColor(state, followerIndex).catch((err) => log('queueApplyColor error:', err.message));
  }

  const jobStatus = payload.jobLoaded && payload.jobLoaded.status;
  if (jobStatus) {
    if (lastJobStatus === 'running' && jobStatus === 'completed') {
      await playCompletionEffect();
    }
    lastJobStatus = jobStatus;
  }
}

function connect() {
  const ws = new WebSocketImpl(`ws://${NCSENDER_HOST}:${NCSENDER_PORT}`);

  ws.addEventListener('open', () => log('connected to ncSender WebSocket at ' + NCSENDER_HOST + ':' + NCSENDER_PORT));

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
    log('WebSocket closed, reconnecting in ' + RECONNECT_DELAY_MS + 'ms');
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', (event) => log('WebSocket error:', (event && (event.message || event.error)) || event));
}

async function main() {
  log('starting — ncSender expected at ' + NCSENDER_HOST + ':' + NCSENDER_PORT);
  await refreshSettings();
  if (!settings) {
    log('WARNING: could not load plugin settings on startup — will keep retrying every ' + SETTINGS_REFRESH_MS + 'ms');
  }
  setInterval(refreshSettings, SETTINGS_REFRESH_MS);
  setInterval(() => { checkIdleTimeout().catch((err) => log('checkIdleTimeout error:', err.message)); }, 30000);
  connect();
}

main();
