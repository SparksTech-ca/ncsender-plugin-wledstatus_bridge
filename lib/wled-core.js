/**
 * WLED Status Light — shared pure logic (bridge copy)
 *
 * IMPORTANT: This file is the source of truth for the bridge. The plugin's
 * config.html contains an inlined copy of the same functions (search for
 * "Shared core" in config.html). When you change anything here, mirror the
 * change into config.html.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EFFECTS = { fireworks: 42, chase: 28, theaterchase: 11, colorloop: 8, strobe: 23 };

// WLED segments persist across API calls until explicitly cleared - if a
// previous update created segment ids 1, 2, 3... (follower cursor, job
// progress blend LEDs) and a later update only touches segment 0 (e.g. a
// plain color, or an effect), those leftover segments keep showing their
// last color indefinitely. MAX_EXTRA_SEGMENT_ID covers the largest number
// of segments either feature could ever create (job progress: 2 range
// segments + up to 20 blend LEDs).
export const MAX_EXTRA_SEGMENT_ID = 21;

export const STATES = ['idle', 'homing', 'run', 'hold', 'alarm', 'door', 'check', 'probing', 'tool-changing'];

export const DEFAULT_STATE_COLORS = {
  idle: { r: 255, g: 255, b: 255 },
  homing: { r: 0, g: 100, b: 255 },
  run: { r: 0, g: 255, b: 0 },
  hold: { r: 255, g: 220, b: 0 },
  alarm: { r: 255, g: 0, b: 0 },
  door: { r: 255, g: 220, b: 0 },
  check: { r: 0, g: 123, b: 255 },
  probing: { r: 26, g: 188, b: 156 },
  'tool-changing': { r: 160, g: 32, b: 240 }
};

// Colors used when a settings field is missing/malformed. Kept in sync with
// commands.js's sanitizeColor fallbacks.
export const FALLBACK_JOB_PROGRESS_START_COLOR = { r: 0, g: 255, b: 0 };  // green
export const FALLBACK_JOB_PROGRESS_END_COLOR = { r: 255, g: 0, b: 0 };    // red
export const FALLBACK_FOLLOWER_COLOR = { r: 255, g: 255, b: 255 };        // white

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

export function rgbToHex(c) {
  if (!c || !Number.isFinite(c.r) || !Number.isFinite(c.g) || !Number.isFinite(c.b)) return '#FFFFFF';
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

export function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16)
  };
}

export function interpolateColor(c1, c2, t) {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t)
  };
}

// ---------------------------------------------------------------------------
// State / position extraction
// ---------------------------------------------------------------------------

// ncSender may nest machine state under `machineState`/`MachineState`, or
// put it at the top level. Merge both so downstream code sees a single flat
// object regardless.
export function flattenStatePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const nested = payload.machineState || payload.MachineState || {};
  return Object.assign({}, payload, nested);
}

export function resolveDisplayState(ms, jobStatus) {
  if (!ms) return 'idle';
  if (ms.isToolChanging || ms.IsToolChanging) return 'tool-changing';
  if (ms.isProbing || ms.IsProbing) return 'probing';
  const raw = ms.status || ms.Status || ms.controllerState || ms.ControllerState || ms.state || ms.State || 'Idle';
  const s = String(raw).toLowerCase();
  if (s === 'jog') return 'run';
  if (s === 'home') return 'homing';
  if (['run', 'hold', 'alarm', 'door', 'check'].includes(s)) return s;
  // Controller reports Idle, but the job is already actively running - a
  // pre-motion window (spindle spin-up, dwell, startup G-code) where
  // nothing's physically moving yet. Show "run" immediately rather than
  // waiting for the first real move to happen.
  if (s === 'idle' && jobStatus === 'running') return 'run';
  return 'idle';
}

// Returns the raw coordinate object/string/array, regardless of which field
// ncSender chose to use this time. Callers destructure as needed.
export function extractCoords(ms) {
  return (ms && (
    ms.machineCoords ||
    ms.MachineCoords ||
    ms.machineCoordinates ||
    ms.MPos ||
    ms.mpos
  )) || null;
}

export function extractXPosition(ms) {
  const coords = extractCoords(ms);
  if (!coords) return null;
  if (typeof coords === 'string') {
    const parts = coords.split(',').map((p) => Number.parseFloat(p.trim()));
    return Number.isFinite(parts[0]) ? parts[0] : null;
  }
  if (Array.isArray(coords)) return Number.isFinite(coords[0]) ? coords[0] : null;
  if (typeof coords === 'object' && Number.isFinite(coords.x)) return coords.x;
  return null;
}

export function extractXYZ(ms) {
  const coords = extractCoords(ms);
  if (!coords) return null;
  if (typeof coords === 'string') {
    const parts = coords.split(',').map((p) => Number.parseFloat(p.trim()));
    return { x: parts[0], y: parts[1], z: parts[2] };
  }
  if (Array.isArray(coords)) return { x: coords[0], y: coords[1], z: coords[2] };
  if (typeof coords === 'object') return { x: coords.x, y: coords.y, z: coords.z };
  return null;
}

// ---------------------------------------------------------------------------
// Follower / progress segment builders
// ---------------------------------------------------------------------------

// WLED persists segments until explicitly cleared. Rather than blindly
// clearing every id above the current max on every call, track which ids
// each host last used and clear only the ones that dropped out this frame.
// For a steady jog, that's zero extra segments per request; for a mode
// transition, it's exactly the ids that are no longer in use.
export function createSegmentTracker() {
  const perHost = new Map();
  return {
    reconcile(host, desiredSegments) {
      const desiredIds = new Set(desiredSegments.map((s) => s.id));
      const prevIds = perHost.get(host) || new Set();
      const toClear = [];
      for (const id of prevIds) {
        if (!desiredIds.has(id)) toClear.push({ id, stop: 0 });
      }
      perHost.set(host, desiredIds);
      return desiredSegments.concat(toClear);
    },
    // Force-forget a host's history (e.g. after settings change), so the
    // next reconcile sees a clean slate. Optional; the tracker self-heals
    // on the next call regardless.
    forget(host) {
      if (host) perHost.delete(host);
      else perHost.clear();
    }
  };
}

export function buildFollowerSegments(bgColor, followerIndex, settings) {
  const ledCount = Math.max(1, settings.ledCount || 30);
  if (!settings.xFollowEnabled || followerIndex == null) {
    return [{ id: 0, start: 0, stop: ledCount, fx: 0, col: [[bgColor.r, bgColor.g, bgColor.b]] }];
  }
  const width = Math.max(1, settings.followerWidth || 3);
  const halfWidth = Math.floor(width / 2);
  const start = Math.max(0, Math.min(ledCount - width, followerIndex - halfWidth));
  const stop = Math.min(ledCount, start + width);
  const fc = settings.followerColor || FALLBACK_FOLLOWER_COLOR;
  return [
    { id: 0, start: 0, stop: ledCount, fx: 0, col: [[bgColor.r, bgColor.g, bgColor.b]] },
    { id: 1, start, stop, fx: 0, col: [[fc.r, fc.g, fc.b]] }
  ];
}

export function buildPlainColorSegments(color, ledCount) {
  return [{ id: 0, start: 0, stop: Math.max(1, ledCount || 30), fx: 0, col: [[color.r, color.g, color.b]] }];
}

export function buildJobProgressSegments(progressPercent, settings) {
  const ledCount = Math.max(1, settings.jobProgressLedCount || 30);
  const ratio = Math.max(0, Math.min(1, (progressPercent || 0) / 100));
  const completedColor = settings.jobProgressStartColor || FALLBACK_JOB_PROGRESS_START_COLOR;
  const remainingColor = settings.jobProgressEndColor || FALLBACK_JOB_PROGRESS_END_COLOR;
  const invert = !!settings.jobProgressInvert;
  const litCount = Math.max(0, Math.min(ledCount, Math.round(ledCount * ratio)));

  // Solid and gradient share the same completed/remaining color model - the
  // only difference is whether the boundary between them is a hard cutoff
  // (solid) or a smoothly blended transition zone (gradient).
  const blendWidth = settings.jobProgressFillStyle === 'solid'
    ? 0
    : Math.max(1, settings.jobProgressBlendWidth || 3);

  if (ratio <= 0) {
    return {
      segments: [{ id: 0, start: 0, stop: ledCount, fx: 0, col: [[remainingColor.r, remainingColor.g, remainingColor.b]] }],
      litCount
    };
  }
  if (ratio >= 1) {
    return {
      segments: [{ id: 0, start: 0, stop: ledCount, fx: 0, col: [[completedColor.r, completedColor.g, completedColor.b]] }],
      litCount
    };
  }

  const rawBoundary = ratio * ledCount;
  const boundary = invert ? ledCount - rawBoundary : rawBoundary;
  const segments = [];
  let segId = 0;

  if (blendWidth <= 0) {
    const roundedBoundary = Math.round(boundary);
    const doneRange = invert ? [roundedBoundary, ledCount] : [0, roundedBoundary];
    const remainingRange = invert ? [0, roundedBoundary] : [roundedBoundary, ledCount];
    if (doneRange[1] > doneRange[0]) {
      segments.push({ id: segId++, start: doneRange[0], stop: doneRange[1], fx: 0, col: [[completedColor.r, completedColor.g, completedColor.b]] });
    }
    if (remainingRange[1] > remainingRange[0]) {
      segments.push({ id: segId++, start: remainingRange[0], stop: remainingRange[1], fx: 0, col: [[remainingColor.r, remainingColor.g, remainingColor.b]] });
    }
    return { segments, litCount };
  }

  const half = blendWidth / 2;
  let blendStart = Math.max(0, Math.min(ledCount, Math.floor(boundary - half)));
  let blendEnd = Math.max(0, Math.min(ledCount, Math.ceil(boundary + half)));
  if (blendEnd < blendStart) blendEnd = blendStart;

  const doneRange = invert ? [blendEnd, ledCount] : [0, blendStart];
  const remainingRange = invert ? [0, blendStart] : [blendEnd, ledCount];

  if (doneRange[1] > doneRange[0]) {
    segments.push({ id: segId++, start: doneRange[0], stop: doneRange[1], fx: 0, col: [[completedColor.r, completedColor.g, completedColor.b]] });
  }
  if (remainingRange[1] > remainingRange[0]) {
    segments.push({ id: segId++, start: remainingRange[0], stop: remainingRange[1], fx: 0, col: [[remainingColor.r, remainingColor.g, remainingColor.b]] });
  }
  for (let i = blendStart; i < blendEnd; i++) {
    const localT = blendEnd > blendStart ? (i - blendStart + 0.5) / (blendEnd - blendStart) : 0;
    const t = invert ? 1 - localT : localT;
    const c = interpolateColor(completedColor, remainingColor, t);
    segments.push({ id: segId++, start: i, stop: i + 1, fx: 0, col: [[c.r, c.g, c.b]] });
  }

  return { segments, litCount };
}

export function computeFollowerIndex(ratio, settings) {
  if (settings.xFollowInvert) ratio = 1 - ratio;
  const ledCount = Math.max(1, settings.ledCount || 30);
  return Math.round(ratio * (ledCount - 1));
}

// ---------------------------------------------------------------------------
// Shared state-tracking helper
// ---------------------------------------------------------------------------

// jobLoaded arrives as partial updates across messages (one tick has only
// currentLine/totalLines, the next only runtimeSec/remainingSec, another
// only currentLine/progressPercent) - never a complete snapshot. Merge
// incrementally, the same way machine state is merged.
//
// This is a tiny stateful helper returned as a closure so both the plugin
// and the bridge can each hold their own independent instance.
export function createJobLoadedTracker() {
  let current = null;
  return {
    merge(source) {
      if (!Object.prototype.hasOwnProperty.call(source, 'jobLoaded')) return;
      if (source.jobLoaded === null) {
        current = null;
      } else if (source.jobLoaded && typeof source.jobLoaded === 'object') {
        current = Object.assign({}, current || {}, source.jobLoaded);
      }
    },
    get() {
      return current;
    },
    reset() {
      current = null;
    }
  };
}