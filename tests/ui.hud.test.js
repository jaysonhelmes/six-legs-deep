// UI unit tests — HUD helpers added in the UX polish pass: the next-unlock ribbon follows the real reveal order
// (Colony panel first, adult-count ETAs include brood time), warning chips for active negative effects (mold, flood,
// event objects) with spots to locate, and the opening step shown by the welcome card / map coach. Pure functions:
// no DOM. Owner: WP9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ribbonInfo, ribbonText, activeThreats, EVENT_THREAT } from '../src/ui/hud.js';
import { introStep, isIntro, firstHatchEta, adultsEta, broodTime, CRUMB_CLICKS } from '../src/ui/intro.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { GRID } from '../src/data/balance.js';

/** Skeleton state + derived with one warm brood group (the Royal Chamber), so brood develops at base speed. */
function world() {
  const s = createState({ seed: 7 });
  const d = createDerived();
  d.nest.agg.broodGroups = [{ uid: 1, kind: 'royal', cap: 3, factor: 1 }];
  d.stats.mbt = 1;
  d.stats.nurseTerm = 1;
  return { s, d };
}

test('ribbon at 0:00 names the Colony panel with the first-hatch ETA, not a later key that has an ETA', () => {
  const { s, d } = world();
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0.4, t: 0 }];
  // what the systems estimate shows at 0:00: a later key that happens to have a rate
  d.progress.nextUnlock = { key: 'job_digger', label: 'Diggers and Soil', frac: 0, eta: 12 };
  const T = broodTime(s, d, 'minor');
  assert.ok(T > 0);
  const nu = ribbonInfo(s, d);
  assert.equal(nu.key, 'panel_colony');
  assert.ok(Math.abs(nu.eta - 0.6 * T) < 1e-9, 'remaining development of the most advanced cohort');
  assert.ok(Math.abs(nu.frac - 0.4) < 1e-9);
  assert.match(ribbonText(nu), /^Next: Colony panel · \d+s$/);
});

test('ribbon: the head of the reveal queue passes through unchanged', () => {
  const { s, d } = world();
  s.meta.reveal.queue = ['panel_colony'];
  s.run.unlocked.panel_colony = true;
  d.progress.nextUnlock = { key: 'panel_colony', label: 'Colony panel', frac: 1, eta: 4 };
  assert.deepEqual(ribbonInfo(s, d), d.progress.nextUnlock);
});

test('ribbon: an adult-count key waits for brood to develop, not just for eggs to be laid', () => {
  const { s, d } = world();
  s.run.unlocked.panel_colony = true;
  s.meta.seen.panel_colony = true;
  s.run.colony.adults.minor = 1;
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0.9, t: 0 }, { c: 'minor', n: 1, p: 0.1, t: 0 }];
  d.stats.layRate = 0.5;
  d.progress.nextUnlock = { key: 'job_digger', label: 'Diggers and Soil', frac: 1 / 3, eta: 4 };   // (3 − 1) / 0.5
  const T = broodTime(s, d, 'minor');
  const nu = ribbonInfo(s, d);
  assert.equal(nu.key, 'job_digger');
  assert.ok(Math.abs(nu.eta - 0.9 * T) < 1e-9, 'the third adult is the second cohort hatching');
  assert.ok(nu.eta > 4);
  assert.equal(adultsEta(s, d, 1), 0, 'already there');
  assert.ok(adultsEta(s, d, 10) > T, 'beyond the pipeline: new eggs plus a full development time');
  d.stats.layRate = 0;
  assert.equal(adultsEta(s, d, 10), -1, 'unknown when nothing is laid');
  assert.match(ribbonText({ key: 'x', label: 'X', frac: 0.42, eta: -1 }), /42%$/);
});

test('ribbon: the Build panel (housing full) goes ahead of a later row due at about the same time', () => {
  const { s, d } = world();
  for (const k of ['panel_colony', 'job_digger', 'trail_slots', 'panel_map']) { s.run.unlocked[k] = true; s.meta.seen[k] = true; }
  s.run.colony.adults.minor = 4;
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0.5, t: 0 }];
  d.stats.housing = 10;
  d.stats.layRate = 0.25;   // 4 places left → 16 s
  d.progress.nextUnlock = { key: 'chamber_nursery', label: 'Nursery', frac: 0.5, eta: 23 };
  let nu = ribbonInfo(s, d);
  assert.equal(nu.key, 'panel_build', 'earlier table row due within one reveal gap');
  assert.ok(Math.abs(nu.eta - 16) < 1e-9);
  assert.ok(Math.abs(nu.frac - 0.6) < 1e-9);
  d.stats.layRate = 0.01;   // 400 s away: the nursery really is next
  nu = ribbonInfo(s, d);
  assert.equal(nu.key, 'chamber_nursery');
});

test('ribbon: a player-driven early reveal is named with its condition instead of a key many minutes away', () => {
  const { s, d } = world();
  for (const k of ['panel_colony', 'job_digger', 'panel_build', 'chamber_nursery', 'job_scout', 'trail_slots']) { s.run.unlocked[k] = true; s.meta.seen[k] = true; }
  d.progress.nextUnlock = { key: 'chamber_gate', label: 'Gate', frac: 0.4, eta: 925 };
  let nu = ribbonInfo(s, d);
  assert.equal(nu.key, 'panel_research');
  assert.equal(ribbonText(nu), 'Next: Research · reveal your first hex');
  d.progress.nextUnlock = { key: 'chamber_gate', label: 'Gate', frac: 0.9, eta: 60 };
  assert.equal(ribbonInfo(s, d).key, 'chamber_gate', 'a timed reveal within two minutes still wins');
  // housing full: adult-count reveals have no ETA; the nearest one is named with its condition
  for (const k of ['panel_research', 'royal_levelup', 'panel_map']) { s.run.unlocked[k] = true; s.meta.seen[k] = true; }
  s.run.colony.adults.minor = 21;
  d.progress.nextUnlock = { key: 'chamber_gate', label: 'Gate', frac: 0.4, eta: 925 };
  nu = ribbonInfo(s, d);
  assert.equal(nu.key, 'chamber_scent_library');
  assert.equal(ribbonText(nu), 'Next: Scent Library · reach 30 adults');
  assert.ok(Math.abs(nu.frac - 0.7) < 1e-9);
});

test('first hatch: no brood → unknown ETA; the most advanced cohort sets progress', () => {
  const { s, d } = world();
  s.run.colony.brood = [];
  assert.deepEqual(firstHatchEta(s, d), { eta: -1, frac: 0 });
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0.2, t: 0 }, { c: 'alate', n: 1, p: 0.95, t: 0 }];
  assert.ok(Math.abs(firstHatchEta(s, d).frac - 0.2) < 1e-9, 'alates are not workers');
});

test('opening: welcome only while no gameplay tab is revealed; the step follows the crumb clicks', () => {
  assert.equal(isIntro(['guide', 'stats', 'settings']), true);
  assert.equal(isIntro(['colony', 'guide', 'stats', 'settings']), false);
  assert.equal(isIntro([]), true);
  const { s, d } = world();
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0, t: 0 }];
  let st = introStep(s, d);
  assert.equal(st.id, 'crumb');
  assert.match(st.text, /^Click the glowing crumb/);
  assert.match(introStep(s, d, { touch: true }).text, /^Tap /);
  s.meta.counters.clicks = CRUMB_CLICKS;
  st = introStep(s, d);
  assert.equal(st.id, 'hatch');
  assert.ok(st.eta > 0);
});

test('warning chips: mold lists every spot (cell + chamber) so repeated clicks can step through them', () => {
  const { s } = world();
  const cols = GRID.cols;
  s.run.nest.chambers.push({ uid: 9, type: 'gallery', x: 4, y: 10, w: 4, h: 2, level: 1, status: 'active' });
  s.run.events.objects.push({ uid: 50, kind: 'mold', hex: -1, cell: 12 * cols + 5, t: -1, data: { occ: 1, chamber: 9 } });
  s.run.events.objects.push({ uid: 51, kind: 'mold', hex: -1, cell: -1, t: -1, data: { occ: 1, chamber: 9 } });
  const th = activeThreats(s);
  assert.equal(th.length, 1);
  assert.equal(th[0].id, 'mold');
  assert.equal(th[0].label, 'Mold ×2');
  assert.match(th[0].tip, /^1 chamber at half strength/);
  assert.equal(th[0].spots.length, 2);
  assert.deepEqual(th[0].locate, { view: 'nest', cell: 12 * cols + 5, chamber: 9 });
  assert.deepEqual(th[0].spots[1], { view: 'nest', cell: 11 * cols + 6, chamber: 9 }, 'a spot without a cell sits mid-chamber');
});

test('warning chips: timed effects (flood, drought), surface objects, and nothing when all is well', () => {
  const { s } = world();
  assert.deepEqual(activeThreats(s), []);
  s.run.effects.push({ id: 'ev_flood', stat: 'chamber_layer', scope: 'topsoil', mult: 0, t: 90 });
  s.run.effects.push({ id: 'ev_drought_leaves', stat: 'source_type', scope: 'leaf_plant', mult: 0.5, t: 40 });
  s.run.effects.push({ id: 'ev_drought_flowers', stat: 'source_type', scope: 'flower_patch', mult: 0.7, t: 60 });
  s.run.events.objects.push({ uid: 60, kind: 'antlion', hex: 14, cell: -1, t: -1, data: {} });
  s.run.effects.push({ id: 'ev_queens_vigor', stat: 'lay', mult: 3, t: 60 });   // positive: no chip
  const th = activeThreats(s);
  const by = Object.fromEntries(th.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ['antlion', 'drought', 'flood']);
  assert.equal(by.flood.t, 90);
  assert.deepEqual(by.flood.locate, { view: 'nest', row: 0 });
  assert.equal(by.drought.t, 60, 'the longest of its effects');
  assert.equal(by.drought.locate, null);
  assert.deepEqual(by.antlion.locate, { view: 'surface', hex: 14 });
  for (const id of Object.values(EVENT_THREAT)) assert.equal(typeof id, 'string');
  assert.deepEqual(activeThreats(null), []);
});
