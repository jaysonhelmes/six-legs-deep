// d.progress.nextUnlock at the source (UI hand-off): the first hatch (run.stats.hatched), housing full and
// "reach N adults" conditions get ETAs from the brood pipeline, season reveals get clock ETAs, and player-driven
// steps (trail slots, Research, Map) are named (eta −1) when nothing timed is near. The HUD ribbon agrees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import * as unlocks from '../src/systems/unlocks.js';
import { ribbonInfo } from '../src/ui/hud.js';
import { BROOD } from '../src/data/economy.js';

/** Skeleton state + derived with one warm brood group (the Royal Chamber), so brood develops at base speed. */
function world() {
  const s = newState(7);
  const d = makeDerived({ stats: { layRate: 0.5, housing: 10 } });
  d.nest.agg.broodGroups = [{ uid: 1, kind: 'royal', cap: 3, factor: 1 }];
  return { s, d };
}
const T = (d) => BROOD.baseSec * d.stats.mbt / Math.max(1, d.stats.nurseTerm);
const seen = (s, ...keys) => { for (const k of keys) { s.run.unlocked[k] = true; s.meta.seen[k] = true; } };
const next = (s, d) => {
  unlocks.tick(s, d, 0, fakeEnv({ dt: 0 }));
  return d.progress.nextUnlock;
};

test('the Colony panel (first hatch) has an ETA from the brood already growing', () => {
  const { s, d } = world();
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0.5, t: 0 }];
  const n = next(s, d);
  assert.equal(n.key, 'panel_colony');
  assert.ok(Math.abs(n.eta - 0.5 * T(d)) < 1e-9, 'half-grown egg: ' + n.eta);
  // No brood yet: the next egg at the lay rate plus its development time.
  s.run.colony.brood = [];
  assert.ok(Math.abs(next(s, d).eta - (1 / 0.5 + T(d))) < 1e-9);
});

test('"reach N adults" counts the brood pipeline: growing cohorts first, then eggs plus one development time', () => {
  const { s, d } = world();
  seen(s, 'panel_colony');
  s.run.colony.adults.minor = 1;
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0.9, t: 0 }, { c: 'minor', n: 1, p: 0.2, t: 0 }];
  let n = next(s, d);
  assert.equal(n.key, 'job_digger');
  assert.ok(Math.abs(n.eta - 0.8 * T(d)) < 1e-9, 'the third adult is the p = 0.2 egg: ' + n.eta);
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0.9, t: 0 }];
  n = next(s, d);
  assert.ok(Math.abs(n.eta - Math.max(0.1 * T(d), 1 / 0.5 + T(d))) < 1e-9, 'one more egg needed: ' + n.eta);
  // Alate brood does not become adults.
  s.run.colony.brood = [{ c: 'alate', n: 5, p: 0.99, t: 0 }];
  assert.ok(next(s, d).eta > T(d));
});

test('the Build panel (housing full) has an ETA: each egg laid fills a place at once', () => {
  const { s, d } = world();
  seen(s, 'panel_colony', 'job_digger');
  s.run.colony.adults.minor = 6;
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0.1, t: 0 }];
  d.stats.housing = 10;
  const n = next(s, d);
  assert.equal(n.key, 'panel_build');
  assert.ok(Math.abs(n.eta - 2 / 0.5) < 1e-9, '2 free places at 0.5 eggs/s: ' + n.eta);
  assert.ok(Math.abs(n.frac - 0.8) < 1e-9);
});

test('player-driven steps are named (eta −1) when nothing timed is within two minutes', () => {
  const { s, d } = world();
  seen(s, 'panel_colony', 'job_digger', 'panel_build', 'chamber_granary', 'chamber_nursery', 'golden_beetle', 'season_dial', 'chamber_gate');
  seen(s, 'job_scout');
  s.run.colony.adults.minor = 13;
  d.stats.housing = 13;               // housing full: no adult ETA (Royal Chamber upgrades at 20 adults is unknown)
  const n = next(s, d);
  assert.equal(n.key, 'trail_slots', 'first pending step in schedule order: ' + JSON.stringify(n));
  assert.equal(n.eta, -1);
  seen(s, 'trail_slots');
  s.meta.reveal.queue = [];
  assert.equal(next(s, d).key, 'panel_research', 'Research named once Scouts exist');
});

test('season reveals (Climate overlay in autumn of year 0) get a clock ETA', () => {
  const { s, d } = world();
  seen(s, 'panel_colony', 'job_digger', 'panel_build', 'chamber_granary', 'chamber_nursery', 'job_scout', 'trail_slots', 'panel_research',
    'royal_levelup', 'chamber_scent_library', 'adapt_potent_trails', 'golden_beetle', 'season_dial', 'chamber_midden', 'mound', 'events', 'panel_rivals');
  d.stats.layRate = 0;
  d.season.index = 1;
  d.season.toNext = 100;
  const n = next(s, d);
  assert.equal(n.key, 'climate_overlay');
  assert.equal(n.eta, 100);
});

test('the HUD ribbon shows the same adult ETA as d.progress.nextUnlock', () => {
  const { s, d } = world();
  seen(s, 'panel_colony');
  s.run.colony.adults.minor = 1;
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0.5, t: 0 }];
  const nu = next(s, d);
  const r = ribbonInfo(s, d);
  assert.equal(r.key, nu.key);
  assert.ok(Math.abs(r.eta - nu.eta) < 1e-6, r.eta + ' vs ' + nu.eta);
});
