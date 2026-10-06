// WP7 unit tests: the Nuptial Flight flow (fly → landing chooser → chooseLanding → startRun), what a flight resets
// and keeps (DESIGN §13.4), innate research run counts (C44), strata / daughters caps, brood bank, startRun details
// (Founding Stores, nanitics, C39 carry, boons, rev carry-forward) and Hardships (C6). Assertions cover only WP7
// fields; startRun's calls into other packages are exercised but their effects are not asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, snapshot } from './helpers.js';
import { createRun } from '../src/core/state.js';
import { handlers, doFlight, startRun, newGame, derive } from '../src/systems/prestige.js';
import { handlers as hardshipHandlers, tick as hardshipTick } from '../src/systems/hardships.js';
import { SITES, BOONS, LANDING } from '../src/data/prestige.js';

/** A game after newGame whose run meets every flight requirement. */
function flyReady(seed = 5) {
  const s = newState(seed);
  const d = makeDerived();
  newGame(s, d);
  s.run.fRun = 1e9;
  s.run.tPeak = 120;
  s.run.research.nuptial_preparation = 1;
  d.nest.agg.royalL = 5;
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  return { s, d };
}

const fly = (s, d, env = fakeEnv()) => {
  assert.equal(handlers.fly.validate(s, d, { type: 'fly' }), null);
  handlers.fly.apply(s, d, { type: 'fly' }, env);
  return env;
};

test('newGame starts run 0 with a derived seed and counts it', () => {
  const s = newState(9);
  const d = makeDerived();
  const rng0 = s.rng;
  newGame(s, d);
  assert.equal(s.run.index, 0);
  assert.equal(s.meta.counters.runs, 1);
  assert.notEqual(s.rng, rng0, 'the run seed is drawn from the main RNG');
  assert.equal(s.run.mapSeed, s.run.seed);
});

test('fly validation: every requirement is needed', () => {
  const { s, d } = flyReady();
  assert.equal(handlers.fly.validate(s, d, { type: 'fly' }), null);
  for (const breakIt of [(x) => { x.d.nest.agg.royalL = 4; }, (x) => { delete x.s.run.research.nuptial_preparation; },
    (x) => { x.d.nest.agg.nuptial.active = false; }, (x) => { x.s.run.fRun = 5e7; }]) {
    const x = flyReady();
    breakIt(x);
    assert.equal(handlers.fly.validate(x.s, x.d, { type: 'fly' }), 'requirements');
  }
});

test('a flight resets exactly the run subtree and keeps the rest (DESIGN §13.4)', () => {
  const { s, d } = flyReady();
  s.cycle.traits.hardy_workers = 2;
  s.cycle.alates = 7;
  s.era.kinship = 4;
  s.era.federation.autobuyers = 1;
  s.era.blueprints.push({ name: 'A', chambers: [], tunnels: [] });
  s.meta.achievements.ach_first_brood = 3;
  s.meta.genome.venom_gland = 1;
  s.meta.diapause.bank = 1234;
  s.meta.settings.colonyName = 'Formica';
  s.run.colony.adults.minor = 400;
  const before = snapshot(s);
  const env = fly(s, d);
  const p = s.meta.pending;
  const alates = p.alates;
  assert.ok(alates >= 10);
  assert.deepEqual(env.events.filter((e) => e.type === 'flightComplete'), [{ type: 'flightComplete', alates }]);
  assert.deepEqual(s.run, createRun(0), 'run reset to the frozen skeleton');
  // cycle: only alates, alatesCycle and daughters change
  assert.equal(s.cycle.alates, 7 + alates);
  assert.equal(s.cycle.alatesCycle, alates);
  assert.equal(s.cycle.daughters.length, 1);
  assert.deepEqual({ ...s.cycle, alates: 0, alatesCycle: 0, daughters: [] }, { ...before.cycle, alates: 0, alatesCycle: 0, daughters: [] });
  // era: only innate-research bookkeeping may change
  assert.deepEqual({ ...s.era, researchRuns: {}, innate: {} }, { ...before.era, researchRuns: {}, innate: {} });
  assert.equal(s.era.researchRuns.nuptial_preparation, 1);
  // meta: counters, stats, strata, pending and the RNG state; everything else identical
  assert.equal(s.meta.counters.flights, 1);
  assert.equal(s.meta.counters.alatesLife, alates);
  assert.equal(s.meta.strata.length, 1);
  assert.equal(s.meta.strata[0].kind, 'run');
  // F26 (ARCHITECTURE §18): Strata records store the packed nest silhouette ("bits:"), no longer RLE cell codes.
  assert.match(s.meta.strata[0].cells, /^bits:/);
  const strip = (m) => ({ ...m, counters: null, stats: null, strata: null, pending: null });
  assert.deepEqual(strip(s.meta), strip(before.meta));
  assert.equal(s.meta.stats.firstFlightAt, before.meta.simTime);
  assert.deepEqual(Object.keys(s).sort(), Object.keys(before).sort());
});

test('the landing chooser: 3 options with 1–2 distinct site tags, 3 distinct boons', () => {
  const { s, d } = flyReady(77);
  s.cycle.traits.seasonal_wisdom = 1;
  fly(s, d);
  const p = s.meta.pending;
  assert.equal(p.kind, 'landing');
  assert.equal(p.options.length, LANDING.options);
  for (const o of p.options) {
    assert.ok(Number.isInteger(o.seed) && o.seed >= 0);
    assert.ok(o.tags.length >= LANDING.tagsMin && o.tags.length <= LANDING.tagsMax);
    assert.equal(new Set(o.tags).size, o.tags.length);
    for (const t of o.tags) assert.ok(SITES[t]);
  }
  assert.equal(p.boons.length, LANDING.boons);
  assert.equal(new Set(p.boons).size, p.boons.length);
  for (const b of p.boons) assert.ok(BOONS[b]);
  assert.equal(p.chooseSeason, true);
  assert.equal(p.hardship, null);
  assert.equal(p.carryAdults, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p, 'pending is plain JSON');
});

test('chooseLanding validation codes', () => {
  const { s, d } = flyReady();
  const v = (cmd) => handlers.chooseLanding.validate(s, d, { type: 'chooseLanding', ...cmd });
  assert.equal(v({ index: 0, boon: 'boon_old_trails' }), 'invalid', 'no pending choice');
  fly(s, d);
  const p = s.meta.pending;
  assert.equal(v({ index: 3, boon: p.boons[0] }), 'invalid:index');
  assert.equal(v({ index: -1, boon: p.boons[0] }), 'invalid:index');
  assert.equal(v({ index: 'x', boon: p.boons[0] }), 'invalid:index');
  const other = Object.keys(BOONS).find((b) => !p.boons.includes(b));
  assert.equal(v({ index: 0, boon: other }), 'invalid:boon');
  assert.equal(v({ index: 0, boon: null }), 'invalid:boon');
  assert.equal(v({ index: 0, boon: p.boons[0], season: 'summer' }), 'locked', 'no seasonal_wisdom');
  p.chooseSeason = true;
  assert.equal(v({ index: 0, boon: p.boons[0], season: 'monsoon' }), 'invalid:season');
  assert.equal(v({ index: 1, boon: p.boons[2], season: 'summer' }), null);
  assert.equal(v({ index: 1, boon: p.boons[2] }), null);
});

test('chooseLanding starts the next run with the chosen seed, tags and boon', () => {
  const { s, d } = flyReady(11);
  fly(s, d);
  const p = s.meta.pending;
  const env = fakeEnv();
  const boon = p.boons[1];
  handlers.chooseLanding.apply(s, d, { type: 'chooseLanding', index: 2, boon }, env);
  assert.equal(s.meta.pending, null);
  assert.equal(s.run.index, 1);
  assert.equal(s.meta.counters.runs, 2);
  assert.equal(s.run.seed, p.options[2].seed);
  assert.equal(s.run.mapSeed, p.options[2].seed);
  assert.deepEqual(s.run.landingTags, p.options[2].tags);
  assert.equal(s.run.boon, boon);
  assert.equal(s.run.hardship, null);
  assert.deepEqual(env.events.filter((e) => e.type === 'runStarted'), [{ type: 'runStarted', index: 1 }]);
});

test('innate research after 3 runs, or 2 with ancestral_memory (C44); species innate not counted', () => {
  for (const [ancestral, need] of [[false, 3], [true, 2]]) {
    const s = newState(2);
    const d = makeDerived();
    if (ancestral) s.cycle.traits.ancestral_memory = 1;
    for (let i = 1; i <= need; i++) {
      s.meta.pending = null;
      s.run.research = { trail_memory: 1 };
      if (i > 1) s.run.research.living_larders = 1;
      doFlight(s, d, fakeEnv());
      assert.equal(s.era.researchRuns.trail_memory, i);
      assert.equal(!!s.era.innate.trail_memory, i >= need, 'run ' + i);
    }
    s.meta.pending = null;
    s.run.research = { trail_memory: 1 };
    doFlight(s, d, fakeEnv());
    assert.equal(s.era.researchRuns.trail_memory, need, 'innate nodes stop counting');
  }
  const s = newState(2);
  const d = makeDerived();
  s.era.species = 'honeypot';
  s.run.research = { living_larders: 1 };
  doFlight(s, d, fakeEnv());
  assert.equal(s.era.researchRuns.living_larders, undefined);
});

test('strata keep the last 12 records and daughters the last 8', () => {
  const s = newState(2);
  const d = makeDerived();
  for (let i = 0; i < 15; i++) {
    s.meta.pending = null;
    s.run.fRun = 1e8 * (i + 1);
    doFlight(s, d, fakeEnv());
  }
  assert.equal(s.meta.strata.length, 12);
  assert.equal(s.cycle.daughters.length, 8);
  assert.equal(s.cycle.daughters[7].alates, s.meta.pending.alates);
  // C130: each record also carries the Colony History metadata (no hardship key on a normal run, no date while meta.lastSeen is 0)
  for (const r of s.meta.strata) assert.deepEqual(Object.keys(r).sort(), ['at', 'cells', 'dur', 'gain', 'kind', 'n', 'peak', 'sp']);
});

test('flight stats: fastest flight and first flight time', () => {
  const s = newState(2);
  const d = makeDerived();
  s.meta.simTime = 5000;
  s.run.time = 3000;
  doFlight(s, d, fakeEnv());
  assert.equal(s.meta.stats.fastestFlightSec, 3000);
  assert.equal(s.meta.stats.firstFlightAt, 5000);
  s.meta.pending = null;
  s.meta.simTime = 9000;
  s.run.time = 1800;
  doFlight(s, d, fakeEnv());
  assert.equal(s.meta.stats.fastestFlightSec, 1800);
  assert.equal(s.meta.stats.firstFlightAt, 5000);
});

test('brood bank keeps 10 % of adults, max 1,000', () => {
  for (const [adults, want] of [[5000, 500], [20000, 1000], [9, 0]]) {
    const s = newState(2);
    const d = makeDerived();
    s.cycle.traits.brood_bank = 1;
    s.run.colony.adults.minor = adults;
    doFlight(s, d, fakeEnv());
    assert.equal(s.meta.pending.carryAdults, want);
  }
  const s = newState(2);
  s.run.colony.adults.minor = 5000;
  doFlight(s, makeDerived(), fakeEnv());
  assert.equal(s.meta.pending.carryAdults, 0, 'no trait, no carry');
});

test('startRun: Founding Stores, nanitics, run-scoped derived caches reset, run fields', () => {
  const s = newState(4);
  const d = makeDerived();
  s.cycle.traits.founding_stores = 2;
  s.cycle.traits.nanitic_vigor = 1;
  d.nest.rev = 41;
  d.surface.rev = 77;
  d.rates.food.gross = 1e9;
  d.season.id = 'winter';
  startRun(s, d, { seed: 1234, tags: ['site_rich_loam', 'bogus', 'site_rich_loam'], boon: 'boon_rich_prey', hardship: 'pacifist' });
  assert.equal(s.run.seed, 1234);
  assert.equal(s.run.res.food, 5 + 5000);
  assert.equal(s.run.res.soil, 1000);
  assert.equal(s.run.fRun, 0, 'Founding Stores are not counted in f_run (C43)');
  assert.equal(s.run.colony.naniticsLeft, 25);
  assert.deepEqual(s.run.landingTags, ['site_rich_loam']);
  assert.equal(s.run.boon, 'boon_rich_prey');
  assert.equal(s.run.hardship, 'pacifist');
  assert.equal(d.nest.rev, 0, 'rev-gated nest caches rebuild on the next derive');
  assert.ok(d.surface.rev !== s.run.surface.rev, 'surface caches rebuild on the next derive');
  assert.equal(d.rates.food.gross, 0, 'no stale food rate from the previous run');
  assert.equal(d.season.id, 'winter', 'the persistent season cache is kept');
  startRun(s, d, { seed: 1, boon: 'boon_nope', hardship: 'nope' });
  assert.equal(s.run.boon, null);
  assert.equal(s.run.hardship, null);
  assert.equal(s.run.index, 1);
});

test('startRun: C39 carry of job / caste targets with automaton_instincts / automated_brood and hardship limits', () => {
  const s = newState(4);
  const d = makeDerived();
  const jt = { forager: 0.5, digger: 0.3, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 };
  const zeros = { soldier: 0, supermajor: 0, replete: 0 };
  const off = { soldier: false, supermajor: false, replete: false };
  s.meta.automation.keep = { jobTargets: jt, casteTargets: null, casteGoals: { soldier: 20, supermajor: 4, replete: 7 },
    casteFill: { soldier: true, supermajor: false } };
  startRun(s, d, { seed: 3 });
  assert.equal(s.run.colony.autoJobs, false);
  assert.deepEqual(s.run.colony.casteGoals, zeros);
  assert.deepEqual(s.run.colony.casteTouched, off, 'nothing carried: the first Barracks may switch filling on');
  s.cycle.traits.automaton_instincts = 1;
  startRun(s, d, { seed: 3 });
  assert.deepEqual(s.run.colony.jobTargets, jt);
  assert.equal(s.run.colony.autoJobs, false, 'C166: Automaton Instincts no longer makes automatic jobs innate');
  assert.equal(s.run.colony.thresholdJobs, false);
  s.era.innate.age_polyethism = true;
  startRun(s, d, { seed: 3 });
  assert.equal(s.run.colony.autoJobs, true, 'C166: auto jobs start on when Age Polyethism is known (Innate)');
  assert.equal(s.run.colony.thresholdJobs, false);
  delete s.era.innate.age_polyethism;
  assert.deepEqual(s.run.colony.casteGoals, zeros, 'caste presets need automated_brood');
  s.era.federation.automated_brood = 1;
  startRun(s, d, { seed: 3 });
  assert.equal(s.run.colony.autoJobs, true, 'Automated Brood: automatic jobs innate');
  assert.equal(s.run.colony.thresholdJobs, true);
  assert.deepEqual(s.run.colony.casteGoals, { soldier: 20, supermajor: 4, replete: 7 });
  assert.deepEqual(s.run.colony.casteFill, { soldier: true, supermajor: false, replete: false });
  assert.deepEqual(s.run.colony.casteTouched, { soldier: true, supermajor: true, replete: true });
  startRun(s, d, { seed: 3, hardship: 'pacifist' });
  assert.deepEqual(s.run.colony.casteGoals, { soldier: 0, supermajor: 0, replete: 7 });
  assert.deepEqual(s.run.colony.casteFill, off);
  startRun(s, d, { seed: 3, hardship: 'monomorphic' });
  assert.deepEqual(s.run.colony.casteGoals, zeros);
  // C151: a legacy share preset carries as "Keep berths filled" for each caste with a share.
  s.meta.automation.keep = { jobTargets: jt, casteTargets: { soldier: 0.2, supermajor: 0, replete: 0.05 }, casteGoals: null, casteFill: null };
  startRun(s, d, { seed: 3 });
  assert.deepEqual(s.run.colony.casteGoals, zeros);
  assert.deepEqual(s.run.colony.casteFill, { soldier: true, supermajor: false, replete: true });
  assert.deepEqual(s.run.colony.casteTouched, { soldier: true, supermajor: false, replete: true });
});

test('startRun boons: chitin hoard, insight cache, royal vigor, peaceful start', () => {
  const s = newState(4);
  const d = makeDerived();
  s.era.kinshipLife = 3;
  startRun(s, d, { seed: 8, boon: 'boon_chitin_hoard' });
  assert.equal(s.run.res.chitin, 50 * 2);
  s.cycle.traits.swarm_instinct = 1;
  startRun(s, d, { seed: 8, boon: 'boon_insight_cache' });
  derive(s, d);
  assert.ok(Math.abs(s.run.res.insight - 100 * d.meta.prestige.insight) < 1e-9);
  startRun(s, d, { seed: 8, boon: 'boon_royal_vigor' });
  assert.deepEqual(s.run.effects.find((e) => e.id === 'boon_royal_vigor'), { id: 'boon_royal_vigor', stat: 'lay', mult: 2, add: 0, scope: null, t: 600 });
  startRun(s, d, { seed: 8, boon: 'boon_peaceful_start' });
  assert.deepEqual(s.run.effects.find((e) => e.stat === 'no_raids'), { id: 'no_raids', stat: 'no_raids', mult: 1, add: 0, scope: null, t: 1200 });
});

test('startHardship: validation, then a flight whose next run carries the constraint (C6)', () => {
  const { s, d } = flyReady();
  const v = (id) => hardshipHandlers.startHardship.validate(s, d, { type: 'startHardship', id });
  assert.equal(v('pacifist'), 'locked');
  s.meta.counters.alatesLife = 150;
  assert.equal(v('pacifist'), null);
  s.meta.counters.alatesLife = 0;
  s.run.unlocked.tab_hardships = true;
  assert.equal(v('pacifist'), null);
  assert.equal(v('nope'), 'invalid:id');
  assert.equal(v(null), 'invalid:id');
  s.run.fRun = 1;
  assert.equal(v('pacifist'), 'requirements');
  s.run.fRun = 1e9;
  const env = fakeEnv();
  hardshipHandlers.startHardship.apply(s, d, { type: 'startHardship', id: 'claustral_founding' }, env);
  assert.equal(s.meta.counters.flights, 1, 'alates are awarded like a flight');
  assert.equal(s.meta.pending.hardship, 'claustral_founding');
  assert.ok(env.events.some((e) => e.type === 'flightComplete'));
  handlers.chooseLanding.apply(s, d, { type: 'chooseLanding', index: 0, boon: s.meta.pending.boons[0] }, fakeEnv());
  assert.equal(s.run.hardship, 'claustral_founding');
});

test('hardship tiers: f_run goals → cycle tier, era best, one event per new tier', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.hardship = 'barren_ground';
  s.run.fRun = 5e8;
  let env = fakeEnv();
  hardshipTick(s, d, 0.1, env);
  assert.equal(s.cycle.hardshipTier.barren_ground, undefined);
  s.run.fRun = 2e11;
  hardshipTick(s, d, 0.1, env);
  assert.deepEqual(env.events, [{ type: 'hardshipTier', id: 'barren_ground', tier: 1 }, { type: 'hardshipTier', id: 'barren_ground', tier: 2 }]);
  assert.equal(s.cycle.hardshipTier.barren_ground, 2);
  assert.equal(s.era.hardshipBest.barren_ground, 2);
  env = fakeEnv();
  hardshipTick(s, d, 0.1, env);
  assert.equal(env.events.length, 0, 'no repeat');
  s.run.fRun = 1e300;
  hardshipTick(s, d, 0.1, env);
  assert.equal(s.cycle.hardshipTier.barren_ground, 5, 'tier 5 is the cap');
  s.era.hardshipBest.barren_ground = 5;
  s.cycle.hardshipTier = {};
  s.run.fRun = 1e9;
  env = fakeEnv();
  hardshipTick(s, d, 0.1, env);
  assert.equal(s.cycle.hardshipTier.barren_ground, 1);
  assert.equal(s.era.hardshipBest.barren_ground, 5, 'the era best never drops');
  s.run.hardship = null;
  s.run.fRun = 1e20;
  hardshipTick(s, d, 0.1, env);
  assert.equal(s.cycle.hardshipTier.barren_ground, 1, 'no hardship run, no detection');
});
