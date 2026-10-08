// C202–C204 new-player pass (player reports: the start is confusing, the Royal Chamber panel opens at once, an
// unexplained nest inset, an unexplained dashed box with a ghost ant). Reveal pacing over the first 20 minutes (core
// keys keep 30 s, the rest wait 50 s during the opening, reveal gates), the Royal Chamber inspect panel staying shut on
// a queen click, the labelled nest inset and its hand-over to the full view, the gated and labelled Gallery demo, and
// the one-line feature callouts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState, makeDerived, fakeEnv, makeFakeStorage } from './helpers.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const unlocks = await import('../src/systems/unlocks.js');
const { UNLOCKS, REVEAL } = await import('../src/data/unlocks.js');
const { mountUI, isInset, canvasInspectAllowed, NEST_OPEN_FLAG } = await import('../src/ui/app.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
const { createGame } = await import('../src/core/game.js');
const onb = await import('../src/ui/onboarding.js');
const { Bot } = await import('../tools/simulate.mjs');

before(() => { setRevealAll(false); setRevealProvider(null); });
after(() => {
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const DEF = new Map(UNLOCKS.map((u) => [u.key, u]));
const ALWAYS = new Set(['tab_guide', 'tab_stats', 'tab_settings']);

/** unlocks.tick for one step; returns the unlock keys emitted. */
function tick(s, d, dt = 1) {
  const env = fakeEnv({ dt });
  unlocks.tick(s, d, dt, env);
  s.meta.simTime += dt;
  s.run.time += dt;
  return env.events.filter((e) => e.type === 'unlock').map((e) => e.key);
}

/** Run until `key` reveals (or `max` seconds); returns the sim time of its reveal or -1. */
function until(s, d, key, max = 2000) {
  for (let i = 0; i < max; i++) {
    const at = s.meta.simTime;
    if (tick(s, d, 1).includes(key)) return at;
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------------------------
// Reveal pacing (systems/unlocks.js, data/unlocks.js)
// ------------------------------------------------------------------------------------------------------------------

test('C202 data: the core loop keeps the 30 s gap; the opening gap is longer; advanced reveals wait for the core loop', () => {
  assert.equal(REVEAL.gapSec, 30);
  assert.ok(REVEAL.openingGapSec >= 45 && REVEAL.openingGapSec <= 60, 'opening gap 45–60 s');
  assert.equal(REVEAL.openingSec, 1200, 'the opening is the first 20 minutes');
  for (const k of ['panel_colony', 'job_digger', 'panel_build', 'job_scout', 'trail_slots', 'panel_research', 'panel_map']) {
    assert.equal(DEF.get(k).core, true, k + ' is core');
  }
  for (const k of ['mound', 'chamber_midden', 'season_dial', 'events', 'panel_achievements', 'egg_reserve', 'climate_overlay', 'chamber_gate']) {
    assert.deepEqual(DEF.get(k).gate, { custom: 'coreLoop' }, k + ' waits for the core loop');
  }
  for (const k of ['adapt_basic', 'chamber_granary', 'chamber_nursery', 'royal_levelup']) {
    assert.deepEqual(DEF.get(k).gate, { custom: 'galleryPlaced' }, k + ' waits for the first Gallery');
  }
  assert.equal(DEF.get('adapt_basic').queued, true, 'the Adaptations tab no longer arrives with the Colony panel');
});

test('C202: a non-core reveal waits the opening gap; core keys keep 30 s; later runs and late openings use 30 s', () => {
  const s = newState();
  const d = makeDerived();
  s.run.nest.chambers.push({ uid: 50, type: 'gallery', x: 0, y: 0, w: 1, h: 1, level: 1 });
  s.run.colony.adults.minor = 8;                  // Diggers (core) and Nursery (gated on a chamber: placed)
  s.meta.reveal.lastAt = 0;
  s.meta.simTime = 1;
  s.run.time = 1;
  const at = {};
  for (let i = 0; i < 200; i++) {
    const t = s.meta.simTime;
    for (const k of tick(s, d, 1)) at[k] = t;
  }
  assert.equal(at.job_digger, 30, 'core: 30 s after the last reveal');
  assert.equal(at.chamber_nursery - at.job_digger, REVEAL.openingGapSec, 'non-core: the opening gap');
  assert.equal(unlocks.revealGap(s, 'chamber_nursery'), REVEAL.openingGapSec);
  s.run.time = REVEAL.openingSec;
  assert.equal(unlocks.revealGap(s, 'chamber_nursery'), REVEAL.gapSec, 'after the opening');
  s.run.time = 10;
  s.run.index = 1;
  assert.equal(unlocks.revealGap(s, 'chamber_nursery'), REVEAL.gapSec, 'later runs');
  s.run.index = 0;
  s.run.bottleneck.id = 'bn_brood_slots';
  assert.equal(unlocks.revealGap(s, 'chamber_nursery'), REVEAL.gapSec, 'urgent while it is the bottleneck');
});

test('C202: a gated reveal waits in the queue (gameplay unlocked) and the ribbon names the step once it is on screen', () => {
  const s = newState();
  const d = makeDerived({ stats: { layRate: 0 } });   // nothing timed is near …
  for (const k of ['golden_beetle', 'season_dial', 'chamber_gate']) s.meta.seen[k] = true;   // … nor the run-time reveals
  s.run.colony.adults.minor = 8;
  tick(s, d, 1);
  assert.equal(unlocks.isUnlocked(s, 'chamber_nursery'), true, 'gameplay unlock is immediate');
  for (let i = 0; i < 200; i++) tick(s, d, 1);
  assert.equal(unlocks.isRevealed(s, 'chamber_nursery'), false, 'no Gallery yet: the reveal waits');
  assert.ok(s.meta.reveal.queue.includes('chamber_nursery'));
  // Before the Build panel is on screen the ribbon must not ask for a Gallery (rule: nothing unrevealed is named).
  const nu0 = d.progress.nextUnlock;
  assert.ok(!nu0 || !/Gallery/.test(String(nu0.hint || '')), 'no Gallery hint before the Build panel: ' + JSON.stringify(nu0));
  s.run.unlocked.panel_build = true;
  s.meta.seen.panel_build = true;
  tick(s, d, 1);
  const nu = d.progress.nextUnlock;
  assert.equal(nu.eta, -1);
  assert.match(nu.hint, /Gallery/);
  s.run.nest.chambers.push({ uid: 50, type: 'gallery', x: 0, y: 0, w: 1, h: 1, level: 1 });
  assert.ok(until(s, d, 'chamber_nursery', 120) >= 0, 'revealed once a Gallery is placed');
});

test('C202: the gates open on their own late in the first run (a player who skips a step is not locked out)', () => {
  const s = newState();
  const d = makeDerived();
  s.run.colony.adults.minor = 130;
  s.run.res.soil = 1e6;
  const t = until(s, d, 'mound', 1400);
  assert.ok(t >= 900 && t < 1300, 'the Mound reveals after the 15 min fallback: ' + t);
});

test('C202: first 20 minutes of a bot run: core order, spacing, nothing advanced before the core loop', () => {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, 1);
  const bot = new Bot(g);
  const log = [];
  let coreAt = -1;
  for (let i = 0; i < 12000; i++) {
    bot.clicks(0.1);
    if (g.s.meta.simTime + 1e-9 >= bot.nextThink) { bot.nextThink = g.s.meta.simTime + 1; bot.think(); }
    const ev = g.tickOnce(0.1);
    if (coreAt < 0 && unlocks.coreLoopMissing(g.s) === null) coreAt = g.s.meta.simTime;
    for (const e of ev) if (e.type === 'unlock' && !ALWAYS.has(e.key)) log.push({ key: e.key, at: g.s.meta.simTime });
  }
  const at = (k) => { const e = log.find((x) => x.key === k); return e ? e.at : Infinity; };
  assert.ok(at('panel_colony') < at('job_digger') && at('job_digger') < at('panel_build'), 'Colony → Diggers → Build');
  assert.ok(at('panel_colony') <= 30, 'Colony panel with the first worker: ' + at('panel_colony'));
  assert.ok(at('adapt_basic') > at('panel_build'), 'Adaptations after the Build panel');
  assert.ok(Math.abs(at('chamber_gallery') - at('panel_build')) < 0.2, 'the Gallery comes with the Build panel');
  const queued = log.filter((x) => DEF.get(x.key) && DEF.get(x.key).queued);
  for (let i = 1; i < queued.length; i++) {
    assert.ok(queued[i].at - queued[i - 1].at >= REVEAL.gapSec - 1e-6, 'two queued reveals within 30 s: ' + queued[i - 1].key + ', ' + queued[i].key);
  }
  // Even for the (fast) bot, the first 5 minutes hold about ten reveals at most.
  assert.ok(queued.filter((x) => x.at <= 300).length <= 10, queued.filter((x) => x.at <= 300).map((x) => x.key).join(', '));
  for (const k of ['mound', 'chamber_midden', 'season_dial', 'events', 'panel_achievements', 'egg_reserve', 'climate_overlay', 'chamber_gate']) {
    if (at(k) === Infinity) continue;
    assert.ok(at(k) >= Math.min(coreAt, 900), k + ' before the core loop: ' + at(k) + ' vs ' + coreAt);
  }
});

// ------------------------------------------------------------------------------------------------------------------
// Onboarding: the Gallery demo, the advisor pulse, callouts (ui/onboarding.js)
// ------------------------------------------------------------------------------------------------------------------

/** A state whose reveal predicate is unlocked && seen, with the hints before the Gallery done. */
function onbState() {
  const s = newState(3);
  const d = makeDerived({ stats: { housing: 10 } });
  for (const k of ['hint_crumb', 'hint_colony_tab', 'hint_digger']) s.meta.onboarding.done[k] = true;
  s.meta.counters.clicks = 5;
  return { s, d };
}
const reveal = (s, ...keys) => { for (const k of keys) { s.run.unlocked[k] = true; s.meta.seen[k] = true; } };

test('C203: the Gallery demo only when the Gallery is revealed and housing is full, labelled, gone after placement', () => {
  const { s, d } = onbState();
  assert.equal(onb.nextHint(s, d, { tab: 'colony' }), null, 'no Build panel: no Gallery hint at all');
  reveal(s, 'panel_build', 'chamber_gallery');
  s.run.colony.adults.minor = 4;
  let hnt = onb.nextHint(s, d, { tab: 'colony' });
  assert.equal(hnt.id, 'hint_gallery');
  assert.equal(hnt.ghost, null, 'housing not full: no demo');
  s.run.colony.adults.minor = 10;
  hnt = onb.nextHint(s, d, { tab: 'colony' });
  assert.equal(hnt.glow, 'tab:build', 'the Build tab glows');
  if (hnt.ghost) {
    assert.equal(hnt.ghost.kind, 'chamber');
    assert.equal(hnt.ghost.label, onb.GALLERY_DEMO_LABEL);
    assert.match(hnt.ghost.label, /Build tab/);
  }
  s.run.nest.chambers.push({ uid: 50, type: 'gallery', x: 0, y: 0, w: 1, h: 1, level: 1 });
  hnt = onb.nextHint(s, d, { tab: 'build' });
  assert.equal(hnt.done, true, 'placed: the hint completes');
  assert.equal(hnt.ghost, null, 'and the demo is gone');
});

test('C203: the advisor pulse never points at a chamber the player has not been shown', () => {
  const { s, d } = onbState();
  s.run.bottleneck.id = 'bn_food_cap';
  const p = onb.advisorPulse(s, d);
  assert.ok(p === null || p === 'res:food', 'no Granary glow before the Granary: ' + p);
});

test('C204: callout copy is short, names only revealed things, and shows once', () => {
  for (const [k, text] of Object.entries(onb.CALLOUTS)) {
    assert.ok(DEF.has(k), k + ' is an unlock key');
    assert.ok(text.split(/\s+/).length <= 15, k + ': ' + text);
  }
  // Early callouts mention no later system (insight, research, pheromone, soldiers, seasons…).
  for (const k of ['panel_colony', 'job_digger', 'panel_build', 'job_scout']) {
    assert.doesNotMatch(onb.CALLOUTS[k], /insight|research|pheromone|soldier|season|mound|chitin/i, k);
  }
  const s = newState();
  assert.equal(onb.calloutFor(s, 'panel_colony'), null, 'not revealed: nothing');
  reveal(s, 'panel_colony');
  assert.equal(onb.calloutFor(s, 'panel_colony').key, 'panel_colony');
  s.meta.onboarding.done[onb.calloutFlag('panel_colony')] = true;
  assert.equal(onb.calloutFor(s, 'panel_colony'), null, 'seen: not again');
  assert.equal(onb.calloutFor(s, 'tab_stats'), null, 'no copy: no callout');
});

// ------------------------------------------------------------------------------------------------------------------
// The shell (ui/app.js): inset label and hand-over, Royal Chamber inspect, callout element
// ------------------------------------------------------------------------------------------------------------------

function mount() {
  uistate.resetUI();
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  game.newGame(1000, 7);
  const ui = mountUI(root, game, { loadRender: false });
  ui.frame(1000);
  const done = () => { ui.destroy(); if (root.parentNode) root.parentNode.removeChild(root); };
  return { root, game, ui, done };
}

test('C203: a new game shows a labelled nest inset; Expand opens the full view; the first housing cap ends it too', () => {
  const { root, game, ui, done } = mount();
  try {
    assert.equal(isInset(game.s), true);
    assert.equal(root.getAttribute('data-inset'), 'true');
    const label = root.querySelector('.inset-label');
    assert.ok(label, 'the inset carries a label');
    assert.match(label.textContent, /Your nest/);
    const btn = root.querySelector('.inset-expand');
    btn.click();
    const cmd = game.queue.find((c) => c.type === 'uiFlag' && c.key === NEST_OPEN_FLAG);
    assert.ok(cmd, 'Expand sends uiFlag nest_open');
    game.s.meta.onboarding.done[NEST_OPEN_FLAG] = true;   // applied at the next tick
    ui.frame(2000);
    assert.equal(isInset(game.s), false);
    assert.equal(root.getAttribute('data-inset'), 'false');
    // a fresh colony: the Build panel reveal (first housing cap) ends the inset as before
    delete game.s.meta.onboarding.done[NEST_OPEN_FLAG];
    assert.equal(isInset(game.s), true);
    reveal(game.s, 'panel_build');
    assert.equal(isInset(game.s), false);
  } finally { done(); }
});

test('C203: clicking the queen does not open the Royal Chamber inspect panel until it can level up', () => {
  const s = newState();
  const queen = { view: 'nest', kind: 'queen', id: 1 };
  const royal = { view: 'nest', kind: 'chamber', id: 1 };
  const gallery = { view: 'nest', kind: 'chamber', id: 5 };
  assert.equal(canvasInspectAllowed(s, queen), false, 'no Build tab yet');
  reveal(s, 'panel_build');
  assert.equal(canvasInspectAllowed(s, queen), false, 'Build tab, but no Royal level-ups');
  assert.equal(canvasInspectAllowed(s, royal), false);
  assert.equal(canvasInspectAllowed(s, gallery), true, 'other chambers still open their inspect view');
  reveal(s, 'royal_levelup');
  assert.equal(canvasInspectAllowed(s, queen), true);

  const { game, ui, done } = mount();
  try {
    reveal(game.s, 'panel_colony', 'panel_build');
    ui.frame(3000);
    uistate.setUI({ tab: 'colony', subTab: null });
    ui.bridge.select(queen);
    ui.bridge.openTab('build', 'inspect');
    assert.equal(uistate.getUI().tab, 'colony', 'the queen click left the open tab alone');
    reveal(game.s, 'royal_levelup');
    ui.bridge.openTab('build', 'inspect');
    assert.equal(uistate.getUI().tab, 'build');
    assert.equal(uistate.getUI().subTab, 'inspect');
  } finally { done(); }
});

test('C204: an unlock shows its one-line callout under the HUD; Got it hides it and records it', () => {
  const { root, game, ui, done } = mount();
  try {
    const el = root.querySelector('.callout');
    assert.ok(el, 'callout element');
    assert.equal(el.hidden, true);
    reveal(game.s, 'panel_colony');
    game.bus.emit('unlock', { key: 'panel_colony' });
    ui.frame(4000);
    assert.equal(el.hidden, false);
    assert.match(el.textContent, /Colony tab/);
    // a second reveal replaces it (one at a time) and the first counts as seen
    reveal(game.s, 'job_digger');
    game.bus.emit('unlock', { key: 'job_digger' });
    assert.match(el.textContent, /Diggers/);
    const flagged = (k) => game.queue.some((c) => c.type === 'uiFlag' && c.key === onb.calloutFlag(k));
    assert.ok(flagged('panel_colony'), 'the replaced callout is recorded as seen');
    root.querySelector('.callout-ok').click();
    assert.equal(el.hidden, true);
    assert.ok(flagged('job_digger'));
    game.bus.emit('unlock', { key: 'job_digger' });
    assert.equal(el.hidden, true, 'never twice');
  } finally { done(); }
});

test('C204: after a reload the latest unacknowledged callout comes back (within its lifetime only)', () => {
  const s = newState();
  reveal(s, 'panel_colony', 'job_digger');
  s.meta.simTime = 100;
  s.meta.reveal.lastAt = 90;
  const host = doc.createElement('div');
  const game = { s, actions: { do() { return { ok: true }; } } };
  const c = onb.createCallout(host, { game });
  assert.equal(c.resume(), true);
  assert.equal(c.current(), 'job_digger', 'the latest reveal');
  c.hide();
  assert.equal(c.current(), null);
  s.meta.reveal.lastAt = 0;
  assert.equal(c.resume(), false, 'too long ago');
  c.destroy();
});
