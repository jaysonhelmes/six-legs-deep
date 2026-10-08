// Sound effects (ARCHITECTURE §18 C234–C235): sound.js imports in Node without Web Audio; the rate limiter; settings
// persistence (localStorage, outside the save); event → sound and action → sound mapping, checked against a fake
// AudioContext that records what is scheduled; the shell wiring (first input starts audio, bus events and UI actions
// play, hidden tab mutes) and the Settings → Sound section. Owner: WP9.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument, FEvent } from './fakedom.js';
import { makeFakeStorage } from './helpers.js';

const sound = await import('../src/ui/sound.js');
const { EVENTS } = await import('../src/data/events.js');
const { createSound, createRateLimiter, soundForEvent, soundForAction, loadSoundSettings, saveSoundSettings, SOUNDS, SOUND_KEY,
  DEFAULT_SOUND, EVENT_SOUNDS, ACTION_SOUNDS, MAX_PER_SEC } = sound;

// ------------------------------------------------------------------------------------------------ fake Web Audio
function param() {
  const p = { value: 0, calls: [] };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
    p[m] = (...a) => { p.calls.push([m, ...a]); };
  }
  return p;
}
function node(kind, log) {
  return { kind, connect(n) { log.connects++; return n; }, disconnect() {} };
}
class FakeAC {
  constructor() {
    FakeAC.instances.push(this);
    this.state = 'running';
    this.currentTime = 1;
    this.sampleRate = 8000;
    this.destination = { kind: 'dest' };
    this.log = { osc: 0, noise: 0, gain: 0, filter: 0, connects: 0, starts: [], resumes: 0, suspends: 0 };
  }
  createOscillator() {
    this.log.osc++;
    const n = node('osc', this.log);
    n.frequency = param();
    n.start = (t) => this.log.starts.push(t);
    n.stop = () => {};
    return n;
  }
  createBufferSource() {
    this.log.noise++;
    const n = node('noise', this.log);
    n.start = (t) => this.log.starts.push(t);
    n.stop = () => {};
    return n;
  }
  createBuffer(ch, len) { const data = new Float32Array(len); return { getChannelData: () => data }; }
  createGain() { this.log.gain++; const n = node('gain', this.log); n.gain = param(); return n; }
  createBiquadFilter() { this.log.filter++; const n = node('filter', this.log); n.frequency = param(); return n; }
  resume() { this.log.resumes++; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.log.suspends++; this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
FakeAC.instances = [];

function engine(opts = {}) {
  let t = 10000;
  const clock = { now: () => t, add: (ms) => { t += ms; } };
  const storage = opts.storage || makeFakeStorage();
  const sfx = createSound({ storage, AudioContext: 'AudioContext' in opts ? opts.AudioContext : FakeAC, now: clock.now, doc: opts.doc || null });
  return { sfx, clock, storage };
}

// ------------------------------------------------------------------------------------------------ module
test('C234: sound.js imports in Node without Web Audio and never throws', () => {
  assert.equal(typeof globalThis.AudioContext, 'undefined');
  const sfx = createSound({ storage: null });
  assert.equal(sfx.unlock(), false, 'no AudioContext → no context');
  assert.equal(sfx.play('buy'), false);
  assert.equal(sfx.forEvent('achievement', { id: 'x' }), false);
  assert.equal(sfx.forAction('buyResearch', { ok: true }), false);
  assert.deepEqual(sfx.info(), { state: 'none', played: 0, hidden: false });
  const throwing = createSound({ AudioContext: function Broken() { throw new Error('no audio'); } });
  assert.equal(throwing.unlock(), false);
  assert.equal(throwing.play('tick'), false);
  sfx.destroy();
});

test('C234: every sound has a category, a gap and finite voices', () => {
  for (const [name, def] of Object.entries(SOUNDS)) {
    assert.ok(sound.SOUND_CATEGORIES.includes(def.cat), name + ' category');
    assert.ok(def.gap >= sound.MIN_GAP_MS, name + ' gap');
    assert.ok(def.v.length > 0, name + ' voices');
    for (const v of def.v) {
      assert.ok(Number.isFinite(v.d) && v.d > 0 && v.d <= 1.5, name + ' duration');
      assert.ok(v.g > 0 && v.g <= 0.35, name + ' gentle gain');
      assert.ok(v.w === 'noise' || (v.f[0] > 0 && v.f[1] > 0), name + ' frequencies');
    }
  }
  for (const n of Object.values(ACTION_SOUNDS)) assert.ok(SOUNDS[n], 'action sound ' + n);
});

// ------------------------------------------------------------------------------------------------ rate limiter
test('C234: rate limiter caps sounds per second and spaces repeats of the same sound', () => {
  const rl = createRateLimiter({ maxPerSec: 8, minGapMs: 60 });
  assert.equal(rl.allow('a', 0), true);
  assert.equal(rl.allow('a', 30), false, 'same sound < 60 ms apart');
  assert.equal(rl.allow('a', 60), true);
  assert.equal(rl.allow('b', 200, 500), true);
  assert.equal(rl.allow('b', 600, 500), false, 'own gap 500 ms');
  assert.equal(rl.allow('b', 700, 500), true);
  // fill the window: 4 accepted so far within [0, 1000)
  let ok = 0;
  for (let i = 0; i < 10; i++) if (rl.allow('n' + i, 800 + i)) ok++;
  assert.equal(ok, 4, 'at most 8 per second');
  assert.equal(rl.allow('late', 1001), true, 'window slides');
  // machine-gun clicking: 15 clicks per second → the tick plays at most ~1 per 70 ms and never more than 8/s
  const r2 = createRateLimiter();
  let played = 0;
  for (let t = 0; t < 1000; t += 66) if (r2.allow('tick', t, SOUNDS.tick.gap)) played++;
  assert.ok(played <= MAX_PER_SEC && played >= 6, 'clicks throttled: ' + played);
});

// ------------------------------------------------------------------------------------------------ settings
test('C234: settings persist in localStorage (not the save) and survive bad storage', () => {
  const storage = makeFakeStorage();
  assert.deepEqual(loadSoundSettings(storage), { ...DEFAULT_SOUND }, 'default on at moderate volume');
  assert.equal(DEFAULT_SOUND.on, true);
  assert.ok(DEFAULT_SOUND.volume > 0.2 && DEFAULT_SOUND.volume < 0.8);
  const { sfx } = engine({ storage });
  sfx.setSettings({ volume: 0.8, alerts: false });
  assert.deepEqual(JSON.parse(storage.getItem(SOUND_KEY)), { ...DEFAULT_SOUND, volume: 0.8, alerts: false });
  const again = engine({ storage }).sfx;
  assert.equal(again.getSettings().volume, 0.8);
  assert.equal(again.getSettings().alerts, false);
  // clamping and junk
  assert.equal(sound.normalizeSoundSettings({ volume: 7, on: 'yes', bogus: 1 }).volume, 1);
  assert.equal(sound.normalizeSoundSettings({ on: 'yes' }).on, true);
  assert.equal('bogus' in sound.normalizeSoundSettings({ bogus: 1 }), false);
  assert.deepEqual(loadSoundSettings(makeFakeStorage({ [SOUND_KEY]: '{not json' })), { ...DEFAULT_SOUND });
  const broken = makeFakeStorage({}, new Set(['get', 'set']));
  assert.deepEqual(loadSoundSettings(broken), { ...DEFAULT_SOUND });
  assert.equal(saveSoundSettings(broken, DEFAULT_SOUND), false);
  assert.equal(saveSoundSettings(null, DEFAULT_SOUND), false);
  assert.doesNotThrow(() => createSound({ storage: broken }).setSettings({ on: false }));
});

// ------------------------------------------------------------------------------------------------ mapping
test('C234: bus events map to sounds', () => {
  assert.equal(soundForEvent('raidWarning', {}), 'alarm');
  assert.equal(soundForEvent('battleEnd', { win: true }), 'victory');
  assert.equal(soundForEvent('battleEnd', { win: false }), 'defeat');
  assert.equal(soundForEvent('raidResult', { win: false }), 'defeat');
  assert.equal(soundForEvent('raidResult', { win: true, calledOff: 'fallen' }), null);
  assert.equal(soundForEvent('achievement', { id: 'a' }), 'achievement');
  assert.equal(soundForEvent('unlock', { key: 'k' }), 'reveal');
  for (const t of ['flightComplete', 'supercolonyComplete', 'speciationComplete']) assert.equal(soundForEvent(t, {}), 'flourish');
  assert.equal(soundForEvent('beetleSpawned', {}), 'beetle');
  assert.equal(soundForEvent('seasonChanged', { id: 'summer' }), 'season');
  assert.equal(soundForEvent('commandRejected', { reason: 'cost', cmd: { type: 'buyResearch' } }), 'buzz');
  assert.equal(soundForEvent('commandRejected', { reason: 'clickCap', cmd: { type: 'clickForage' } }), null);
  assert.equal(soundForEvent('hatched', {}), null, 'unmapped events are silent');
  // event cards: negative events warn, others chime
  const neg = Object.keys(EVENTS).find((id) => EVENTS[id].polarity === 'neg');
  const pos = Object.keys(EVENTS).find((id) => EVENTS[id].polarity !== 'neg');
  assert.equal(soundForEvent('eventSpawned', { id: neg }), 'warn');
  assert.equal(soundForEvent('eventSpawned', { id: pos }), 'event');
  for (const [type, m] of Object.entries(EVENT_SOUNDS)) if (typeof m === 'string') assert.ok(SOUNDS[m], type);
});

test('C234: UI action results map to sounds (refusals buzz, click spam stays quiet)', () => {
  assert.equal(soundForAction('clickForage', { ok: true }), 'tick');
  assert.equal(soundForAction('buyAdaptation', { ok: true }), 'buy');
  assert.equal(soundForAction('levelChamber', { ok: true }), 'level');
  assert.equal(soundForAction('placeChamber', { ok: true }), 'thud');
  assert.equal(soundForAction('buyResearch', { ok: true }), 'research');
  assert.equal(soundForAction('drawTrail', { ok: true }), 'trail');
  assert.equal(soundForAction('setJobs', { ok: true }), null, 'sliders and settings are silent');
  assert.equal(soundForAction('buyResearch', { ok: false, reason: 'cost' }), 'buzz');
  assert.equal(soundForAction('clickForage', { ok: false, reason: 'clickCap' }), null);
  assert.equal(soundForAction('uiFlag', { ok: false, reason: 'invalid' }), null);
  assert.equal(soundForAction('x', null), null);
});

test('C234: the engine schedules voices on a fake AudioContext only after a gesture, within the limits', () => {
  FakeAC.instances.length = 0;
  const { sfx, clock } = engine();
  assert.equal(sfx.play('buy'), false, 'nothing before the first input');
  assert.equal(FakeAC.instances.length, 0);
  assert.equal(sfx.unlock(), true);
  const ac = FakeAC.instances[0];
  assert.equal(sfx.play('buy'), true);
  assert.equal(ac.log.osc, SOUNDS.buy.v.length);
  assert.ok(ac.log.starts.every((t) => t >= ac.currentTime), 'scheduled from now');
  assert.equal(sfx.play('buy'), false, 'same sound too soon');
  clock.add(100);
  assert.equal(sfx.play('thud'), true);
  assert.equal(ac.log.noise, 1, 'thud has a noise layer');
  assert.ok(ac.log.filter >= 1, 'noise is low-passed');
  // global cap
  clock.add(2000);
  let n = 0;
  for (const name of Object.keys(SOUNDS)) if (sfx.play(name)) n++;
  assert.equal(n, MAX_PER_SEC);
  // categories and master switch
  clock.add(5000);
  sfx.setSettings({ alerts: false });
  assert.equal(sfx.play('achievement'), false);
  assert.equal(sfx.play('tick'), true);
  clock.add(5000);
  sfx.setSettings({ alerts: true, on: false });
  assert.equal(sfx.play('tick'), false);
  sfx.setSettings({ on: true, volume: 0 });
  assert.equal(sfx.play('tick'), false, 'volume 0 is silent');
  sfx.setSettings({ volume: 0.5 });
  assert.equal(sfx.play('tick'), true);
  sfx.destroy();
});

test('C234: hidden tab mutes and suspends; showing it again stays quiet for the catch-up burst', () => {
  FakeAC.instances.length = 0;
  const { sfx, clock } = engine();
  sfx.unlock();
  const ac = FakeAC.instances[0];
  sfx.setHidden(true);
  assert.equal(ac.log.suspends, 1);
  assert.equal(sfx.play('tick'), false);
  sfx.setHidden(false);
  assert.equal(ac.log.resumes >= 1, true);
  assert.equal(sfx.play('alarm'), false, 'quiet right after the tab returns');
  clock.add(sound.RESUME_QUIET_MS + 1);
  assert.equal(sfx.play('alarm'), true);
  sfx.destroy();
});

// ------------------------------------------------------------------------------------------------ shell + Settings
const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;
after(() => {
  delete doc.defaultView.localStorage;
  delete doc.defaultView.AudioContext;
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

test('C235: the shell starts audio on first input, plays bus events and UI actions, and Settings → Sound persists', async () => {
  const { mountUI } = await import('../src/ui/app.js');
  const { createGame } = await import('../src/core/game.js');
  const uistate = await import('../src/ui/uistate.js');
  const settingsPanel = await import('../src/ui/panels/settings.js');
  const storage = makeFakeStorage();
  doc.defaultView.localStorage = storage;
  doc.defaultView.AudioContext = FakeAC;
  FakeAC.instances.length = 0;
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  uistate.setUI({ tab: 'colony', subTab: null, tool: null, selection: null });
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  game.newGame(1000);
  const plainDo = game.actions.do;
  const ui = mountUI(root, game, { loadRender: false });
  assert.notEqual(game.actions.do, plainDo, 'actions wrapped');
  try {
    const sfx = sound.getActiveSound();
    assert.ok(sfx, 'engine registered for Settings');
    game.bus.emit('achievement', { id: 'ach_x' });
    assert.equal(sfx.info().played, 0, 'silent before any input');
    doc.dispatchEvent(new FEvent('pointerdown'));
    assert.equal(FakeAC.instances.length, 1, 'context created on first input');
    game.bus.emit('achievement', { id: 'ach_x' });
    assert.equal(sfx.info().played, 1);
    game.bus.emit('raidWarning', { uid: 1 });
    assert.equal(sfx.info().played, 2);
    const r = game.actions.do('buyResearch', { id: 'definitely_not_a_node' });
    assert.equal(r.ok, false, 'wrapper returns the result unchanged');
    assert.equal(sfx.info().played, 3, 'refusal buzzes');
    // Settings → Sound
    const sec = settingsPanel.soundControls(sound.getActiveSound);
    const boxes = [];
    (function walk(n) { if (n.tagName === 'INPUT' || n.tagName === 'input') boxes.push(n); for (const c of n.childNodes || []) walk(c); })(sec.el);
    const masterBox = boxes.find((b) => b.type === 'checkbox');
    assert.equal(masterBox.checked, true, 'on by default');
    masterBox.checked = false;
    masterBox.dispatchEvent(new FEvent('change'));
    assert.equal(JSON.parse(storage.getItem(SOUND_KEY)).on, false, 'saved per browser');
    assert.equal(game.s.meta.settings.sound, false, 'the save is untouched');
    game.bus.emit('battleEnd', { win: true });
    assert.equal(sfx.info().played, 3, 'muted');
    ui.destroy();
    assert.equal(sound.getActiveSound(), null);
    assert.equal(game.actions.do, plainDo, 'wrapper removed on destroy');
  } finally {
    if (root.parentNode) root.parentNode.removeChild(root);
  }
});
