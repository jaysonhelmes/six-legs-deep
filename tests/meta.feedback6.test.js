// WP7 feedback pass 6 (ARCHITECTURE §18 C166–C172): Federation-only job automation and Adaptation autobuyer, the
// Auto-Flight peak rule (8 min, weather-free, 30 s persistence) and scored landing, Innate research reset at every
// Supercolony, the merging run's alates counted toward kinship, the Brood Bank bought at landing, Architect's Table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { tick as autoTick, pickLanding, peakPassed, handlers as autoHandlers } from '../src/systems/automation.js';
import { handlers as jobHandlers } from '../src/systems/jobs.js';
import { handlers as traitHandlers } from '../src/systems/traits.js';
import {
  newGame, tick as prestigeTick, projectAlates, projectKinship, kinshipBreakdown, doSupercolony, doFlight, landingCarry,
  handlers as prestigeHandlers,
} from '../src/systems/prestige.js';
import { kinshipFor } from '../tools/meta-model.mjs';
import { AUTO_FLIGHT, RESET } from '../src/data/prestige.js';
import { FEDERATION, FED_ORDER } from '../src/data/federation.js';
import { adultsTotal } from '../src/core/state.js';
import { addAdults } from '../src/systems/population.js';
import { autobuyPatch, autobuyOn } from '../src/ui/panels/automation.js';
import { blueprintSaveHint, autoFlightPeakText } from '../src/ui/text.js';

/** A game after newGame whose run meets every flight requirement. */
function flyReady(seed = 12) {
  const s = newState(seed);
  const d = makeDerived();
  newGame(s, d);
  s.run.fRun = 1e9;
  s.run.research.nuptial_preparation = 1;
  d.nest.agg.royalL = 5;
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  return { s, d };
}

/**
 * Drive prestige.tick + automation.tick once per run second up to `secs`, with fRun(t) and flight weather W(t).
 * Returns the run time of the first flight, or -1.
 */
function drive(s, d, secs, fRunAt, wAt = () => 1) {
  const env = fakeEnv();
  for (let t = 1; t <= secs; t++) {
    s.run.time = t - 0.05;
    s.run.fRun = fRunAt(t);
    d.season.mods.flightW = wAt(t);
    prestigeTick(s, d, 0.1, env);
    autoTick(s, d, 0.1, env);
    if (s.meta.counters.flights > 0) return t;
  }
  return -1;
}

function peakSetup() {
  const x = flyReady();
  x.s.era.federation.auto_flight = 1;
  Object.assign(x.s.meta.automation.autoFlight, { on: true, mode: 'peak' });
  return x;
}

test('C166: automatic jobs and the Adaptation autobuyer are Federation-only', () => {
  const s = newState(2);
  const d = makeDerived();
  newGame(s, d);
  const v = (type, args) => jobHandlers[type].validate(s, d, { type, ...args });
  s.cycle.traits.automaton_instincts = 1;
  assert.equal(v('setAutoJobs', { on: true }), 'locked', 'Automaton Instincts alone: no automatic jobs');
  assert.equal(v('setThresholdJobs', { on: true }), 'locked');
  assert.equal(v('setJobTargets', { targets: { scout: 0 } }), null, 'targets (carried into each run) still settable');
  assert.equal(autoHandlers.setAutomation.validate(s, d, { type: 'setAutomation', patch: { autobuy: { adaptations: true } } }), 'locked');
  s.era.federation.automated_brood = 1;
  assert.equal(v('setAutoJobs', { on: true }), null);
  assert.equal(v('setThresholdJobs', { on: true }), null);
  s.era.federation.autobuyers = 1;
  assert.equal(autoHandlers.setAutomation.validate(s, d, { type: 'setAutomation', patch: { autobuy: { adaptations: true } } }), null);
});

test('C166 peak rule: never before 8 min, waits while the rate rises, needs 30 s below 97 % of the best', () => {
  // Rising rate the whole time (alates ∝ t², rate ∝ t): never flies.
  let x = peakSetup();
  assert.equal(drive(x.s, x.d, 1800, (t) => 1e6 * t ** 4), -1, 'a rising rate never trips the rule');
  // The rate peaks early (food stops at 4 min): the drop starts before 8 min, so it flies at 8:00 + 30 s, not earlier.
  x = peakSetup();
  const flown = drive(x.s, x.d, 1200, (t) => 1e6 * Math.min(t, 240) ** 4);
  assert.ok(flown >= AUTO_FLIGHT.minSec + AUTO_FLIGHT.holdSec && flown <= AUTO_FLIGHT.minSec + AUTO_FLIGHT.holdSec + 2, 'drop counted from 8 min, held 30 s; got ' + flown);
  // Food stops at 10 min: the rate must fall 3 % (≈ 18 s at 10 min) and stay there 30 s.
  x = peakSetup();
  const t2 = drive(x.s, x.d, 1200, (t) => 1e6 * Math.min(t, 600) ** 4);
  assert.ok(t2 > 600 + AUTO_FLIGHT.holdSec && t2 < 600 + 60, 'flies about 18 s + 30 s after the peak, got ' + t2);
});

test('C166 peak rule: a season change (summer → autumn flight weather) does not trigger it', () => {
  const x = peakSetup();
  // Rising rate; flight weather ×1.25 in "summer" until 15 min, then ×1 — the weather-free rate keeps rising.
  const t = drive(x.s, x.d, 1500, (tt) => 1e6 * tt ** 4, (tt) => (tt < 900 ? 1.25 : 1));
  assert.equal(t, -1);
  assert.ok(!peakPassed(x.s));
});

test('C166 landing pick: scores sites and boons; situational bonuses; Seasonal Wisdom starts in spring', () => {
  const s = newState(5);
  const p = { kind: 'landing', options: [{ seed: 1, tags: ['site_stony_ground'] }, { seed: 2, tags: ['site_rich_loam', 'site_aphid_dense'] },
    { seed: 3, tags: ['site_hostile_neighbours', 'site_garden_path'] }], boons: ['boon_chitin_hoard', 'boon_scouts_lead', 'boon_royal_vigor'],
  chooseSeason: false, hardship: null };
  assert.deepEqual(pickLanding(s, p, null), { index: 1, boon: 'boon_royal_vigor', season: null });
  const p2 = { ...p, boons: ['boon_scouts_lead', 'boon_insight_cache'] };
  assert.equal(pickLanding(s, p2, null).boon, 'boon_insight_cache', 'ties keep the first offered: 3 > 2');
  s.cycle.traits.keen_antennae = 1;
  const p3 = { ...p, boons: ['boon_scouts_lead', 'boon_long_spring'] };
  assert.equal(pickLanding(s, p3, 'winter').boon, 'boon_long_spring', "Scout's Lead is worth little with Keen Antennae");
  s.era.activeBlueprint = 0;
  assert.equal(pickLanding(s, { ...p, boons: ['boon_royal_vigor', 'boon_blueprint_rush'] }, null).boon, 'boon_blueprint_rush');
  const sw = pickLanding(s, { ...p, chooseSeason: true, options: [{ seed: 1, tags: ['site_rich_loam'] }, { seed: 2, tags: ['site_seed_meadow', 'site_sunny_slope'] }] });
  assert.equal(sw.season, 'spring');
  assert.equal(sw.index, 0, 'spring: Seed Meadow gets no autumn bonus');
  assert.equal(pickLanding(s, { ...p, options: [{ seed: 1, tags: ['site_rich_loam'] }, { seed: 2, tags: ['site_seed_meadow', 'site_sunny_slope'] }] }, 'autumn').index, 1);
});

test('C166 auto-flight lands with the scored pick', () => {
  const x = flyReady(21);
  x.s.era.federation.auto_flight = 1;
  Object.assign(x.s.meta.automation.autoFlight, { on: true, mode: 'alates', alates: 1 });
  x.s.run.time = 600.95;
  // Pre-compute what pickLanding would choose on the same RNG draw: run the flight on a copy.
  const copy = structuredClone(x.s);
  const dc = makeDerived();
  Object.assign(dc.nest.agg, x.d.nest.agg);
  doFlight(copy, dc, fakeEnv());
  const pick = pickLanding(copy, copy.meta.pending, x.d.season.id);
  autoTick(x.s, x.d, 0.1, fakeEnv());
  assert.equal(x.s.meta.counters.flights, 1);
  assert.equal(x.s.meta.pending, null);
  assert.equal(x.s.run.boon, pick.boon);
  assert.deepEqual(x.s.run.landingTags, copy.meta.pending.options[pick.index].tags);
});

test('C167: Innate research and run counts reset at every Supercolony (Genetic Memory protects only at Speciation)', () => {
  const s = newState(3);
  const d = makeDerived();
  newGame(s, d);
  s.meta.genome.genetic_memory = 1;
  s.era.innate = { age_polyethism: true };
  s.era.researchRuns = { age_polyethism: 3, seed_caching: 1 };
  s.run.research.seed_caching = 1;
  doSupercolony(s, d, fakeEnv(), { edict: null });
  assert.deepEqual(s.era.innate, {});
  assert.deepEqual(s.era.researchRuns, {});
  assert.ok(!s.run.research.age_polyethism, 'not granted in the new run');
});

test('C168: the merging run counts its projected alates toward kinship, projection and payout', () => {
  const s = newState(4);
  const d = makeDerived();
  newGame(s, d);
  s.cycle.alatesCycle = 5000;
  s.run.fRun = 0;
  assert.equal(projectKinship(s, d), kinshipFor(5000));
  s.run.fRun = 1e13;
  const runA = projectAlates(s, d);
  assert.ok(runA > 1000);
  assert.equal(projectKinship(s, d), kinshipFor(5000 + runA));
  assert.ok(projectKinship(s, d) > kinshipFor(5000));
  const kb = kinshipBreakdown(s, d);
  assert.equal(kb.banked, 5000);
  assert.equal(kb.run, runA);
  assert.equal(kb.total, 5000 + runA);
  assert.equal(kb.kinship, projectKinship(s, d));
  assert.ok(kinshipFor(kb.nextAt) === kb.kinship + 1 && kinshipFor(kb.nextAt - 1) === kb.kinship, 'nextAt is the exact threshold');
  const life0 = s.meta.counters.alatesLife;
  const kin = doSupercolony(s, d, fakeEnv(), { edict: null });
  assert.equal(kin, kinshipFor(5000 + runA));
  assert.equal(s.era.kinshipLife, kin);
  assert.equal(s.meta.counters.alatesLife, life0 + runA, 'lifetime alates count the merging run');
});

test('C171: a Brood Bank bought in the landing chooser applies to that landing', () => {
  const s = newState(6);
  const d = makeDerived();
  newGame(s, d);
  s.run.fRun = 1e9;
  addAdults(s, d, 'minor', 5000, { capped: false });
  const adults = adultsTotal(s);
  doFlight(s, d, fakeEnv());
  const p = s.meta.pending;
  assert.equal(p.carryAdults, 0, 'no Brood Bank at the flight');
  assert.equal(landingCarry(s, p), 0);
  s.cycle.traits.brood_bank = 1; // bought in the chooser
  const want = Math.floor(Math.min(RESET.broodBankMax, RESET.broodBankFrac * adults));
  assert.equal(landingCarry(s, p), want);
  const ref = structuredClone(s);
  delete ref.cycle.traits.brood_bank;
  prestigeHandlers.chooseLanding.apply(ref, makeDerived(), { type: 'chooseLanding', index: 0, boon: p.boons[0] }, fakeEnv());
  prestigeHandlers.chooseLanding.apply(s, d, { type: 'chooseLanding', index: 0, boon: p.boons[0] }, fakeEnv());
  assert.equal(adultsTotal(s) - adultsTotal(ref), want, 'the carried adults arrive');
  // An older pending without `adults` keeps the stored carry.
  assert.equal(landingCarry(s, { carryAdults: 7 }), 7);
});

test("C172: Architect's Table (3 kinship) needs Blueprint Library", () => {
  assert.ok(FED_ORDER.includes('architects_table'));
  assert.equal(FEDERATION.architects_table.cost.base, 3);
  const s = newState(7);
  const d = makeDerived();
  s.era.kinship = 10;
  const v = () => traitHandlers.buyFederation.validate(s, d, { type: 'buyFederation', id: 'architects_table' });
  assert.equal(v(), 'locked');
  s.era.federation.blueprint_memory = 1;
  assert.equal(v(), null);
  traitHandlers.buyFederation.apply(s, d, { type: 'buyFederation', id: 'architects_table' });
  assert.equal(s.era.federation.architects_table, 1);
  assert.equal(s.era.kinship, 7);
});

test('C166 UI helpers: per-tab autobuyer switches; C170 blueprint hint; peak text', () => {
  const s = newState(8);
  const a = s.meta.automation.autobuy;
  // C246: one switch per autobuyer; a patch touches only its own category
  assert.deepEqual(autobuyPatch(s, 'chambers', true), { autobuy: { chambers: true } });
  assert.deepEqual(autobuyPatch(s, 'chambers', false), { autobuy: { chambers: false } });
  Object.assign(a, { adaptations: false, chambers: true });
  assert.ok(autobuyOn(s, 'chambers') && !autobuyOn(s, 'adaptations'));
  a.on = false;   // a pre-C246 save with the master switch off: shown off
  assert.ok(!autobuyOn(s, 'chambers'));
  assert.equal(blueprintSaveHint(s), '', 'nothing saved');
  s.era.blueprints = [{ name: 'A', chambers: [] }];
  assert.match(blueprintSaveHint(s), /Ancestral Blueprint/);
  s.era.federation.blueprint_memory = 1;
  assert.equal(blueprintSaveHint(s), '');
  assert.match(autoFlightPeakText(), /3% below this run's best for 30 s \(after 8 min\)/);
});
