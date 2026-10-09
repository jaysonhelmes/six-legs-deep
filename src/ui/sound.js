// Sound effects (C234): short procedural sounds synthesised with Web Audio (oscillators and a noise buffer through
// gain envelopes), no audio files. Player actions, notifications and a little ambience, each sound rate-limited.
// Settings live per browser in localStorage (`sld.sound`, outside the save; every access in try/catch).
// Owner: WP9. Contract: ARCHITECTURE §18 C234–C235, DESIGN §25.9.
// Node-safe: nothing touches the DOM or Web Audio at import time, and every Web Audio call is guarded, so a browser
// without Web Audio (or a Node test) simply gets silence.

import { EVENTS } from '../data/events.js';
import { staleClickReject } from './text.js';   // C244: an already-collected spam click stays silent

/** localStorage key of the sound settings (per browser, not in the save). */
export const SOUND_KEY = 'sld.sound';
/** Sound categories the player can switch off separately. */
export const SOUND_CATEGORIES = Object.freeze(['actions', 'alerts', 'ambience']);
/** Defaults: on, at a moderate volume. */
export const DEFAULT_SOUND = Object.freeze({ on: true, volume: 0.5, actions: true, alerts: true, ambience: true });
/** Global limit: at most this many sounds in any 1 s window, and the same sound never closer than MIN_GAP_MS. */
export const MAX_PER_SEC = 8;
export const MIN_GAP_MS = 60;
/** Quiet window after the tab is shown again, so the catch-up burst of events stays silent. */
export const RESUME_QUIET_MS = 800;
/** Peak master gain at volume 1 (voices peak at ≤ 0.35, so the loudest sound stays well under full scale). */
const MASTER_MAX = 0.7;

// ------------------------------------------------------------------------------------------------ recipes
// A voice: { w: wave ('sine' | 'triangle' | 'square' | 'sawtooth' | 'noise'), f: [startHz, endHz], t: delay s,
//   d: duration s, g: peak gain, a: attack s, lp?: lowpass Hz }. A sound: { cat, gap (ms between repeats), v: voices }.
const note = (f, t, d, g, w = 'sine', a = 0.008, f2 = f) => ({ w, f: [f, f2], t, d, g, a });
const arp = (fs, step, d, g, w = 'sine') => fs.map((f, i) => note(f, i * step, d, g, w));

export const SOUNDS = Object.freeze({
  // actions
  tick: { cat: 'actions', gap: 70, v: [{ w: 'triangle', f: [1500, 900], t: 0, d: 0.045, g: 0.14, a: 0.002 }] },
  tab: { cat: 'actions', gap: 120, v: [{ w: 'sine', f: [1900, 1700], t: 0, d: 0.03, g: 0.04, a: 0.002 }] },
  coin: { cat: 'actions', gap: 150, v: [note(1318, 0, 0.12, 0.12), note(1760, 0.06, 0.22, 0.12)] },
  buy: { cat: 'actions', gap: 80, v: [note(1046.5, 0, 0.22, 0.14), note(1318.5, 0.07, 0.3, 0.14)] },
  level: { cat: 'actions', gap: 80, v: arp([784, 1046.5, 1318.5], 0.06, 0.3, 0.12) },
  research: { cat: 'actions', gap: 120, v: [...arp([659.3, 880, 1318.5], 0.07, 0.35, 0.1, 'triangle'), note(1975.5, 0.21, 0.45, 0.05)] },
  thud: { cat: 'actions', gap: 120, v: [{ w: 'sine', f: [160, 55], t: 0, d: 0.2, g: 0.35, a: 0.004 },
    { w: 'noise', f: [0, 0], t: 0, d: 0.09, g: 0.12, a: 0.002, lp: 450 }] },
  dig: { cat: 'actions', gap: 90, v: [{ w: 'noise', f: [0, 0], t: 0, d: 0.07, g: 0.12, a: 0.003, lp: 900 },
    { w: 'sine', f: [120, 70], t: 0, d: 0.08, g: 0.14, a: 0.003 }] },
  trail: { cat: 'actions', gap: 150, v: [{ w: 'triangle', f: [480, 900], t: 0, d: 0.16, g: 0.08, a: 0.02 },
    { w: 'sine', f: [720, 1200], t: 0.05, d: 0.18, g: 0.06, a: 0.02 }] },
  march: { cat: 'actions', gap: 200, v: [note(110, 0, 0.12, 0.3, 'sine', 0.004, 60), note(110, 0.14, 0.12, 0.3, 'sine', 0.004, 60)] },
  buzz: { cat: 'actions', gap: 250, v: [{ w: 'square', f: [140, 130], t: 0, d: 0.12, g: 0.05, a: 0.004, lp: 900 },
    { w: 'square', f: [147, 137], t: 0, d: 0.12, g: 0.04, a: 0.004, lp: 900 }] },
  // alerts (notifications)
  event: { cat: 'alerts', gap: 500, v: [note(987.8, 0, 0.3, 0.1), note(1318.5, 0.09, 0.4, 0.1)] },
  warn: { cat: 'alerts', gap: 500, v: [note(523.3, 0, 0.22, 0.13, 'triangle'), note(392, 0.14, 0.32, 0.13, 'triangle')] },
  alarm: { cat: 'alerts', gap: 2000, v: [660, 495, 660, 495].map((f, i) => ({ ...note(f, i * 0.14, 0.13, 0.12, 'triangle'), lp: 2200 })) },
  victory: { cat: 'alerts', gap: 1200, v: [...arp([523.3, 659.3, 784], 0.07, 0.25, 0.12, 'triangle'), note(1046.5, 0.21, 0.5, 0.13, 'triangle')] },
  defeat: { cat: 'alerts', gap: 1200, v: arp([392, 329.6, 261.6], 0.13, 0.36, 0.12, 'triangle') },
  achievement: { cat: 'alerts', gap: 600, v: [...arp([784, 987.8, 1174.7], 0.06, 0.2, 0.1), note(1568, 0.18, 0.6, 0.11)] },
  reveal: { cat: 'alerts', gap: 700, v: [{ w: 'sine', f: [880, 1320], t: 0, d: 0.7, g: 0.1, a: 0.02 }] },
  flourish: { cat: 'alerts', gap: 3000, v: [note(196, 0, 1.3, 0.1, 'sine', 0.08),
    ...arp([392, 523.3, 659.3, 784, 1046.5], 0.08, 0.5, 0.1, 'triangle'), note(1318.5, 0.4, 0.9, 0.1)] },
  beetle: { cat: 'alerts', gap: 1500, v: arp([1568, 2093, 2637, 3136], 0.045, 0.18, 0.06) },
  // ambience
  season: { cat: 'ambience', gap: 3000, v: [note(220, 0, 1.4, 0.06, 'sine', 0.4), note(329.6, 0.1, 1.4, 0.05, 'sine', 0.4)] },
  chamber: { cat: 'ambience', gap: 800, v: [note(330, 0, 0.4, 0.08, 'triangle'), note(495, 0.05, 0.45, 0.06, 'triangle')] },
});

// ------------------------------------------------------------------------------------------------ mapping
/** Player command → sound on success (UI actions only: game.actions.do is wrapped in app.js; automation is silent). */
export const ACTION_SOUNDS = Object.freeze({
  clickForage: 'tick', clickQueen: 'tick', helpDig: 'tick', groomBrood: 'tick', scrapeMold: 'tick', bailFlood: 'tick',
  cleanBlight: 'tick', clickEventObject: 'tick', clearAntlion: 'tick', eventChoice: 'tick',
  clickBeetle: 'coin', openGift: 'coin', clickPupa: 'coin',
  buyAdaptation: 'buy', buyMound: 'buy', buyTrait: 'buy', buyFederation: 'buy', buyGenome: 'buy', rearAlate: 'buy', claimHex: 'buy',
  levelChamber: 'level',
  buyResearch: 'research', buyRefinement: 'research',
  placeChamber: 'thud', relocateChamber: 'thud', placeSatellite: 'thud', loadBlueprint: 'thud',
  digTo: 'dig', digTunnel: 'dig', backfill: 'dig',
  drawTrail: 'trail', rerouteTrail: 'trail', mark: 'trail', rally: 'trail', massRecruit: 'trail', frenzy: 'trail',
  launchParty: 'march', reinforce: 'march',
});
/** Refusals that stay silent: the click cap (spam clicking) and bookkeeping commands. */
const SILENT_REJECT = new Set(['uiFlag', 'setSetting']);
const quietReason = (reason) => /^clickCap/.test(String(reason || ''));

/**
 * Sound for a UI action result.
 * @param {string} type command type
 * @param {{ ok: boolean, reason?: string }|null} res
 * @returns {string|null}
 */
export function soundForAction(type, res) {
  if (!res) return null;
  if (!res.ok) return SILENT_REJECT.has(type) || quietReason(res.reason) ? null : 'buzz';
  return ACTION_SOUNDS[type] || null;
}

/** Bus event → sound (function of the event payload, or a fixed name). */
export const EVENT_SOUNDS = Object.freeze({
  eventSpawned: (e) => (EVENTS[e.id] && EVENTS[e.id].polarity === 'neg' ? 'warn' : 'event'),
  raidWarning: 'alarm',
  raidResult: (e) => (e.calledOff ? null : e.win ? 'victory' : 'defeat'),
  battleEnd: (e) => (e.win ? 'victory' : 'defeat'),
  conquest: 'victory',
  achievement: 'achievement',
  unlock: 'reveal',
  flightComplete: 'flourish',
  supercolonyComplete: 'flourish',
  speciationComplete: 'flourish',
  ending: 'flourish',
  beetleSpawned: 'beetle',
  pupaSpawned: 'beetle',
  seasonChanged: 'season',
  chamberActivated: 'chamber',
  commandRejected: (e) => (quietReason(e.reason) || staleClickReject(e) || (e.cmd && SILENT_REJECT.has(e.cmd.type)) ? null : 'buzz'),
});

/**
 * Sound for a bus event, or null.
 * @param {string} type
 * @param {Object} [e]
 * @returns {string|null}
 */
export function soundForEvent(type, e = {}) {
  const m = EVENT_SOUNDS[type];
  if (!m) return null;
  const name = typeof m === 'function' ? m(e || {}) : m;
  return name && SOUNDS[name] ? name : null;
}

// ------------------------------------------------------------------------------------------------ rate limiter
/**
 * Rate limiter: at most `maxPerSec` sounds in any 1 s window, and each sound at least max(minGapMs, its gap) apart.
 * @param {{ maxPerSec?: number, minGapMs?: number }} [o]
 */
export function createRateLimiter({ maxPerSec = MAX_PER_SEC, minGapMs = MIN_GAP_MS } = {}) {
  const recent = [];        // timestamps of accepted sounds in the last second
  const last = new Map();   // sound → last accepted time
  return {
    /** True (and recorded) when `name` may play at `now` ms. */
    allow(name, now, gapMs = 0) {
      while (recent.length && now - recent[0] >= 1000) recent.shift();
      if (recent.length >= maxPerSec) return false;
      const prev = last.get(name);
      if (prev !== undefined && now - prev < Math.max(minGapMs, gapMs)) return false;
      recent.push(now);
      last.set(name, now);
      return true;
    },
    reset() { recent.length = 0; last.clear(); },
  };
}

// ------------------------------------------------------------------------------------------------ settings
/** Clean a stored settings object (unknown keys dropped, volume clamped to 0..1). */
export function normalizeSoundSettings(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SOUND };
  for (const k of ['on', ...SOUND_CATEGORIES]) if (typeof o[k] === 'boolean') out[k] = o[k];
  const v = Number(o.volume);
  if (Number.isFinite(v)) out.volume = Math.max(0, Math.min(1, v));
  return out;
}

/** Read the settings from storage (defaults when missing, unreadable or blocked). */
export function loadSoundSettings(storage) {
  try {
    const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(SOUND_KEY) : null;
    return normalizeSoundSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SOUND };
  }
}

/** Write the settings to storage. Returns false when storage is unavailable. */
export function saveSoundSettings(storage, settings) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(SOUND_KEY, JSON.stringify(normalizeSoundSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ engine
/**
 * Create the sound engine. The AudioContext is created on the first pointer or key input (browsers block audio
 * until a user gesture), and only while sound is on.
 * @param {{ storage?: Storage|null, AudioContext?: Function|null, doc?: Document|null, now?: () => number }} [o]
 */
export function createSound({ storage = null, AudioContext: AC = null, doc = null, now = null } = {}) {
  const clock = typeof now === 'function' ? now
    : () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());
  let settings = loadSoundSettings(storage);
  const limiter = createRateLimiter();
  let ctx = null;
  let master = null;
  let noise = null;
  let hidden = false;
  let quietUntil = -Infinity;
  let lastGesture = -Infinity;
  let resuming = false;
  let played = 0;
  const listeners = new Set();
  const Ctor = () => AC || (globalThis.window && (globalThis.window.AudioContext || globalThis.window.webkitAudioContext)) || null;

  const masterLevel = () => MASTER_MAX * settings.volume * settings.volume * 2 / (1 + settings.volume);   // gentle curve, 0.5 → ~0.23

  function resume() {
    if (!ctx || hidden || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
    resuming = true;
    try {
      Promise.resolve(ctx.resume()).catch(() => {}).finally(() => { resuming = false; });
    } catch { resuming = false; }
  }

  /** Create or resume the AudioContext (call from a user gesture). Returns true when a context exists. */
  function unlock() {
    lastGesture = clock();
    if (!settings.on) return !!ctx;
    if (!ctx) {
      const C = Ctor();
      if (typeof C !== 'function') return false;
      try {
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = masterLevel();
        master.connect(ctx.destination);
      } catch {
        ctx = null;
        master = null;
        return false;
      }
    }
    resume();
    return true;
  }

  function noiseBuffer() {
    if (noise) return noise;
    const rate = ctx.sampleRate || 44100;
    noise = ctx.createBuffer(1, Math.floor(rate * 0.5), rate);
    const data = noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; data[i] = (seed / 4294967296) * 2 - 1; }
    return noise;
  }

  function voice(v, t0) {
    const t = t0 + (v.t || 0);
    const d = Math.max(0.02, v.d || 0.1);
    let src;
    if (v.w === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = noiseBuffer();
    } else {
      src = ctx.createOscillator();
      src.type = v.w || 'sine';
      src.frequency.setValueAtTime(Math.max(1, v.f[0]), t);
      if (v.f[1] && v.f[1] !== v.f[0]) src.frequency.exponentialRampToValueAtTime(Math.max(1, v.f[1]), t + d);
    }
    const g = ctx.createGain();
    const peak = Math.max(0.0002, v.g || 0.1);
    const a = Math.min(d * 0.5, Math.max(0.001, v.a || 0.005));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    let head = src;
    if (v.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(v.lp, t);
      src.connect(f);
      head = f;
    }
    head.connect(g);
    g.connect(master);
    src.onended = () => { try { g.disconnect(); } catch { /* already gone */ } };
    src.start(t);
    src.stop(t + d + 0.03);
  }

  /** Whether `name` would be heard right now (settings, hidden tab, context state). */
  function audible(name) {
    const def = SOUNDS[name];
    if (!def || !settings.on || !settings[def.cat] || settings.volume <= 0) return false;
    if (hidden || (doc && doc.hidden)) return false;
    if (!ctx || !master || ctx.state === 'closed' || (ctx.state === 'suspended' && !resuming)) return false;
    return clock() >= quietUntil;
  }

  /**
   * Play a sound by name. Returns true when it was scheduled (false: muted, no context yet, or rate-limited).
   * Never throws.
   */
  function play(name) {
    try {
      if (!audible(name)) return false;
      const def = SOUNDS[name];
      if (!limiter.allow(name, clock(), def.gap)) return false;
      const t0 = (ctx.currentTime || 0) + 0.005;
      for (const v of def.v) voice(v, t0);
      played++;
      return true;
    } catch {
      return false;
    }
  }

  function setHidden(h) {
    const was = hidden;
    hidden = !!h;
    if (!ctx) return;
    try {
      if (hidden && !was && typeof ctx.suspend === 'function') Promise.resolve(ctx.suspend()).catch(() => {});
      if (!hidden && was) { quietUntil = clock() + RESUME_QUIET_MS; resume(); }
    } catch { /* optional */ }
  }

  function setSettings(patch) {
    settings = normalizeSoundSettings({ ...settings, ...(patch || {}) });
    saveSoundSettings(storage, settings);
    if (settings.on && !ctx && clock() - lastGesture <= 1000) unlock();   // switched on by a click: start audio now
    try { if (master) master.gain.setTargetAtTime(masterLevel(), ctx.currentTime || 0, 0.03); } catch { /* optional */ }
    for (const fn of listeners) { try { fn(settings); } catch { /* listener errors are not ours */ } }
    return settings;
  }

  /** Listen for first input (unlock) and tab visibility on `d`. Returns a detach function. */
  function attach(d = doc) {
    if (!d || typeof d.addEventListener !== 'function') return () => {};
    doc = d;
    const onInput = () => unlock();
    const onVis = () => setHidden(!!d.hidden);
    const types = ['pointerdown', 'keydown', 'touchstart'];
    for (const tp of types) d.addEventListener(tp, onInput, true);
    d.addEventListener('visibilitychange', onVis);
    if (d.hidden) setHidden(true);
    return () => {
      for (const tp of types) { try { d.removeEventListener(tp, onInput, true); } catch { /* ignore */ } }
      try { d.removeEventListener('visibilitychange', onVis); } catch { /* ignore */ }
    };
  }

  return {
    play,
    unlock,
    attach,
    setHidden,
    setSettings,
    getSettings: () => ({ ...settings }),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Play the sound for a bus event (see EVENT_SOUNDS). */
    forEvent(type, e) { const n = soundForEvent(type, e); return n ? play(n) : false; },
    /** Play the sound for a UI action result (see ACTION_SOUNDS). */
    forAction(type, res) { const n = soundForAction(type, res); return n ? play(n) : false; },
    /** True when a pointer or key input happened in the last `ms` milliseconds (tab sound only on player switches). */
    recentGesture(ms = 400) { return clock() - lastGesture <= ms; },
    /** Debug / tests: context state and the number of sounds scheduled. */
    info: () => ({ state: ctx ? ctx.state : 'none', played, hidden }),
    destroy() {
      listeners.clear();
      const c = ctx;
      ctx = null;
      master = null;
      noise = null;
      try { if (c && typeof c.close === 'function') Promise.resolve(c.close()).catch(() => {}); } catch { /* ignore */ }
    },
  };
}

// The engine the shell created, for the Settings panel (same pattern as resourceStats.setActiveTracker).
let active = null;
/** @param {ReturnType<typeof createSound>|null} s */
export function setActiveSound(s) { active = s || null; }
/** @returns {ReturnType<typeof createSound>|null} */
export function getActiveSound() { return active; }
