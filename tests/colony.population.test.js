// WP2 unit tests — systems/population.js: first worker 15–30 s, laying limits (slots, housing, reserve, berths), nanitics,
// caste choice by largest deficit, alate rearing, development / hatching, allocation, frost, "larvae eat first",
// offline batches with no deaths, cross-calls (addAdults, killAdults, killBrood, stealBrood) and the colony commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';
import { recompute } from '../src/systems/stats.js';
import { tick as economyTick } from '../src/systems/economy.js';
import {
  tick as populationTick, handlers, addAdults, killAdults, killBrood, stealBrood, broodAllocation, broodSummary,
} from '../src/systems/population.js';
import { tick as jobsTick } from '../src/systems/jobs.js';
import { tick as bottleneckTick } from '../src/systems/bottleneck.js';
import { broodTotal } from '../src/core/state.js';
import { GENOME } from '../src/data/genome.js';

function near(a, b, rel = 1e-9, msg = '') {
  assert.ok(Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(a), Math.abs(b)), `${msg} ${a} ≉ ${b}`);
}

function setup() {
  return { s: newState(1), d: makeDerived() };
}
/** One colony tick (the WP2 systems in step order); returns the events. */
function tickColony(s, d, dt = 0.1, opts = {}, ledger = null) {
  const env = fakeEnv({ dt, ...opts });
  for (const r of Object.keys(d.ledger)) d.ledger[r] = {};
  if (ledger) for (const r of Object.keys(ledger)) d.ledger[r] = { ...ledger[r] };
  recompute(s, d, env);
  economyTick(s, d, dt, env);
  populationTick(s, d, dt, env);
  jobsTick(s, d, dt, env);
  bottleneckTick(s, d, dt, env);
  s.run.time += dt;
  return env.events;
}
/** Only laying / development: recompute then population.tick. */
function popTick(s, d, dt = 0.1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  recompute(s, d, env);
  populationTick(s, d, dt, env);
  s.run.time += dt;
  return env.events;
}
const eggs = (ev) => ev.filter((e) => e.type === 'eggLaid');
/** A roomy colony: lots of food, housing, slots; λ = 0.25 × layMult per second. */
function roomy(s, d, { layMult = 1, food = 1e9 } = {}) {
  s.run.res.food = food;
  s.run.colony.naniticsLeft = 0;
  s.run.colony.layAcc = 0;
  d.nest.agg.housingBase = 1e6;
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 1e6, factor: 1, exposed: false, snap: false, inReach: false }];
  d.meta.prestige.lay = layMult;
}

test('a new game hatches its first worker within 15–30 s with zero input (DESIGN §5.3, §28.1 #4)', () => {
  const { s, d } = setup();
  let at = -1;
  let firstEgg = null;
  for (let i = 0; i < 600 && at < 0; i++) {
    const t = s.run.time;
    const ev = tickColony(s, d);
    if (!firstEgg && eggs(ev).length) firstEgg = { t, e: eggs(ev)[0] };
    if (ev.some((e) => e.type === 'hatched')) at = s.run.time;
  }
  assert.deepEqual(firstEgg, { t: 0, e: { type: 'eggLaid', caste: 'minor', n: 1 } }, 'first egg at 0:00');
  assert.ok(at >= 15 && at <= 30, 'first worker at ' + at);
  assert.equal(s.run.colony.adults.minor, 1);
  assert.equal(s.run.colony.jobs.forager, 1, 'manual mode: new minors forage');
  assert.equal(s.run.stats.hatched, 1);
});

test('the first egg is a half-price nanitic paid with the 5 starting food', () => {
  const { s, d } = setup();
  popTick(s, d);
  assert.equal(s.run.res.food, 0);
  assert.equal(s.run.colony.naniticsLeft, 4);
  assert.equal(s.run.colony.eggs.minor, 1);
  assert.deepEqual(s.run.colony.brood.map((c) => [c.c, c.n, c.t]), [['minor', 1, 0]]);
});

test('laying respects brood slots and housing (minors + brood < housing)', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 100 });
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 3, factor: 1 }];
  popTick(s, d, 1);
  assert.equal(broodTotal(s), 3);
  const { s: s2, d: d2 } = setup();
  roomy(s2, d2, { layMult: 100 });
  d2.nest.agg.housingBase = 10;
  s2.run.colony.adults.minor = 8;
  s2.run.colony.jobs.forager = 8;
  popTick(s2, d2, 1);
  assert.equal(broodTotal(s2), 2);
});

test('egg reserve holds back reserve × food cap', () => {
  const { s, d } = setup();
  roomy(s, d, { food: 80 });
  s.run.colony.eggReserve = 0.5;                          // 75 of the 150 cap
  popTick(s, d, 4);
  assert.equal(broodTotal(s), 0, 'avail 5 < egg 10');
  s.run.res.food = 85.5;
  s.run.colony.layAcc = 1;
  popTick(s, d, 0.1);
  assert.equal(broodTotal(s), 1);
  assert.ok(s.run.res.food >= 75 - 1e-9);
});

test('nanitics: the first naniticsLeft minor eggs cost half; a batch pays nanitics first', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 100, food: 35 });
  s.run.colony.naniticsLeft = 5;
  popTick(s, d, 1);
  assert.equal(broodTotal(s), 6, '5 × 5 + 1 × 10');
  assert.equal(s.run.colony.naniticsLeft, 0);
  assert.ok(s.run.res.food < 1e-9);
});

test('blocked laying clamps layAcc to max(1, λ) (C18)', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 20 });                            // λ = 5
  d.nest.agg.housingBase = 0;
  popTick(s, d, 10);
  assert.equal(broodTotal(s), 0);
  assert.ok(s.run.colony.layAcc <= 5 + 1e-9, 'layAcc ' + s.run.colony.layAcc);
});

test('no laying while Hungry', () => {
  const { s, d } = setup();
  roomy(s, d);
  s.run.colony.hungry = true;
  popTick(s, d, 10);
  assert.equal(broodTotal(s), 0);
});

test('C151 caste targets: the caste with the largest deficit is laid until adults + brood reach each target, then minors', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 40 });                            // λ = 10 → one egg per 0.1 s tick
  s.run.unlocked.caste_soldier = true;
  s.run.unlocked.caste_replete = true;
  s.run.colony.casteGoals = { soldier: 20, supermajor: 0, replete: 30 };
  s.run.colony.casteTouched = { soldier: true, supermajor: true, replete: true }; // no C151 auto-fill
  s.run.res.chitin = 1e6;
  s.run.res.honeydew = 1e6;
  d.stats.honeydewCap = 1e9;
  Object.assign(d.nest.agg, { berthsBase: 1000, warBerthsBase: 1000, repleteBerthsBase: 1000 });
  for (let i = 0; i < 100; i++) popTick(s, d, 0.1);
  const e = s.run.colony.eggs;
  assert.equal(e.minor + e.soldier + e.replete, 100);
  assert.ok(Math.abs(e.soldier - 20) <= 1 && Math.abs(e.replete - 30) <= 1, JSON.stringify(e));
  assert.equal(s.run.stats.soldiersRaised, e.soldier);
});

test('a large batch (offline step) is split so each caste stops at its target count (C151)', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 40 });
  s.run.unlocked.caste_soldier = true;
  s.run.unlocked.caste_replete = true;
  s.run.colony.casteGoals = { soldier: 20, supermajor: 0, replete: 30 };
  s.run.colony.casteTouched = { soldier: true, supermajor: true, replete: true }; // no C151 auto-fill
  s.run.res.chitin = 1e6;
  s.run.res.honeydew = 1e6;
  Object.assign(d.nest.agg, { berthsBase: 1000, warBerthsBase: 1000, repleteBerthsBase: 1000 });
  s.run.colony.layAcc = 0;
  popTick(s, d, 10, { offline: true });
  assert.deepEqual([s.run.colony.eggs.soldier, s.run.colony.eggs.replete, s.run.colony.eggs.minor], [20, 30, 50]);
});

test('slider castes fall back to minors without a free berth or their extras; soldiers fill at most the berths', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 40 });
  s.run.unlocked.caste_soldier = true;
  s.run.colony.casteGoals = { soldier: 1000, supermajor: 0, replete: 0 };
  s.run.res.chitin = 1e6;
  for (let i = 0; i < 10; i++) popTick(s, d, 0.1);
  assert.equal(s.run.colony.eggs.soldier, 0, 'no berths');
  assert.equal(s.run.colony.eggs.minor, 10);
  d.nest.agg.berthsBase = 2;
  s.run.colony.adults.soldier = 1;
  for (let i = 0; i < 10; i++) popTick(s, d, 0.1);
  assert.equal(s.run.colony.eggs.soldier, 1, 'one free berth (1 adult + 1 brood = 2)');
  const before = s.run.res.chitin;
  assert.ok(before < 1e6, 'chitin paid');
  d.nest.agg.berthsBase = 100;
  s.run.res.chitin = 0;
  for (let i = 0; i < 10; i++) popTick(s, d, 0.1);
  assert.equal(s.run.colony.eggs.soldier, 1, 'no chitin');
  assert.equal(s.run.colony.eggs.minor, 29);
});

test('pacifist and monomorphic runs never lay military / slider castes even with carried targets', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 40 });
  s.run.unlocked.caste_soldier = true;
  s.run.colony.casteGoals = { soldier: 1000, supermajor: 0, replete: 0 };
  s.run.res.chitin = 1e6;
  d.nest.agg.berthsBase = 100;
  s.run.hardship = 'pacifist';
  for (let i = 0; i < 10; i++) popTick(s, d, 0.1);
  assert.equal(s.run.colony.eggs.soldier, 0);
});

test('alate rearing: requested alates are laid first (alate cells, 5 × 1.15^k honeydew), then minors; autoRear', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 40 });
  s.run.colony.rearRequested = 2;
  s.run.res.honeydew = 100;
  d.nest.agg.alateCells = 10;
  popTick(s, d, 0.2);
  assert.equal(s.run.colony.eggs.alate, 2);
  assert.equal(s.run.colony.rearRequested, 0);
  near(s.run.res.honeydew, 100 - 5 - 5 * 1.15);
  popTick(s, d, 0.1);
  assert.equal(s.run.colony.eggs.alate, 2);
  assert.equal(s.run.colony.eggs.minor, 1);
  s.meta.automation.autoRear = true;
  popTick(s, d, 0.1);
  assert.equal(s.run.colony.eggs.alate, 3);
  d.nest.agg.alateCells = 3;
  popTick(s, d, 0.1);
  assert.equal(s.run.colony.eggs.alate, 3, 'alate cells full (3 brood)');
});

test('development: T = 25 s × M_bt × caste factor / nurse term / B_speed; hatching adds adults and emits hatched', () => {
  const { s, d } = setup();
  s.run.colony.jobs.nurse = 1;
  s.run.colony.adults.minor = 1;
  s.run.colony.layAcc = 0;
  s.run.time = 5;                                          // cohorts laid at second 0 are not fresh
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0, t: 0 }, { c: 'soldier', n: 1, p: 0, t: 0 }];
  popTick(s, d, 1);
  const T = 25 * 0.8 / (1 + 2 / 3);
  near(s.run.colony.brood[0].p, 1 / T);
  near(s.run.colony.brood[1].p, 1 / (T * 1.7));
  s.run.colony.brood[0].p = 0.999;
  const ev = popTick(s, d, 1);
  assert.deepEqual(ev.filter((e) => e.type === 'hatched'), [{ type: 'hatched', caste: 'minor', n: 2 }]);
  assert.equal(s.run.colony.adults.minor, 3);
  assert.equal(s.run.colony.jobs.forager, 2, 'hatched minors join forager');
  assert.equal(s.run.stats.hatched, 2);
  s.run.colony.brood = [{ c: 'alate', n: 3, p: 0.9999, t: 5 }];
  popTick(s, d, 1);
  assert.equal(s.run.colony.alatesReared, 3);
});

test('golden_brood: 1 % of hatched minors become golden workers', () => {
  const { s, d } = setup();
  s.meta.genome.golden_brood = 1;
  s.run.colony.layAcc = 0;
  s.run.colony.brood = [{ c: 'minor', n: 200, p: 0.9999, t: 0 }];
  d.nest.agg.housingBase = 1000;
  popTick(s, d, 1);
  const ch = GENOME.golden_brood && GENOME.golden_brood.fx ? GENOME.golden_brood.fx.chance : 0;
  near(s.run.colony.golden, 200 * ch);
});

test('allocation: proportional to cap; exposed nurseries freeze (B_speed brood-weighted, C4); hibernaculum shelters', () => {
  const { s, d } = setup();
  s.run.colony.brood = [{ c: 'minor', n: 6, p: 0, t: 0 }];
  d.nest.agg.broodGroups = [
    { kind: 'royal', uid: 1, cap: 3, factor: 1, exposed: false, snap: false, inReach: true },
    { kind: 'nursery', uid: 2, cap: 3, factor: 1.15, exposed: true, snap: false, inReach: false },
  ];
  let a = broodAllocation(s, d);
  near(a.frozenShare, 0.5);
  near(a.frostShare, 0.5);
  near(a.bSpeed, 0.5);
  near(a.reachShare, 0.5);
  assert.deepEqual(a.groups.map((g) => [g.uid, g.brood, g.frozen]), [[1, 3, 0], [2, 3, 3]]);
  s.run.colony.layAcc = 0;
  s.run.time = 5;
  popTick(s, d, 1);
  near(s.run.colony.brood[0].p, 0.5 / (25 * 0.8 / (1 + 1 / 6)), 1e-9, 'frozen half develops at 0 (applied once)');
  d.nest.agg.broodGroups.push({ kind: 'hib', uid: 3, cap: 10, factor: 1, exposed: false, snap: false, inReach: false });
  a = broodAllocation(s, d);
  assert.equal(a.frozenShare, 0, 'free hibernaculum capacity shelters the exposed brood');
  near(a.bSpeed, 1);
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 3, factor: 1 }, { kind: 'nursery', uid: 2, cap: 3, factor: 1.2, snap: true }];
  a = broodAllocation(s, d);
  near(a.frozenShare, 0.5);
  assert.equal(a.frostShare, 0, 'snap freezes are not frost exposure');
  s.run.colony.brood = [];
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 3, factor: 1 }, { kind: 'nursery', uid: 2, cap: 3, factor: 1.2 }];
  near(broodAllocation(s, d).bSpeed, 1.1, 1e-12, 'slot-weighted with no brood');
});

test('thermal_brood_shuttling fills unexposed groups by factor first', () => {
  const { s, d } = setup();
  s.run.research.thermal_brood_shuttling = 1;
  s.run.colony.brood = [{ c: 'minor', n: 5, p: 0, t: 0 }];
  d.nest.agg.broodGroups = [
    { kind: 'royal', uid: 1, cap: 3, factor: 1 },
    { kind: 'nursery', uid: 2, cap: 3, factor: 1.15, exposed: true },
    { kind: 'nursery', uid: 3, cap: 3, factor: 1.3 },
  ];
  const a = broodAllocation(s, d);
  assert.deepEqual(a.groups.map((g) => g.brood), [2, 0, 3]);
  assert.equal(a.frozenShare, 0);
  near(a.bSpeed, (3 * 1.3 + 2) / 5);
});

test('frost deaths: online winter, year ≥ 1, not mild, 0.5 %/s of the frost-exposed share; never mild, year 0 or offline', () => {
  const make = () => {
    const { s, d } = setup();
    s.run.colony.layAcc = 0;
    s.run.colony.brood = [{ c: 'minor', n: 6, p: 0, t: 0 }];
    d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 3, factor: 1 }, { kind: 'nursery', uid: 2, cap: 3, factor: 1, exposed: true }];
    Object.assign(d.season, { id: 'winter', year: 1, mild: false });
    return { s, d };
  };
  let { s, d } = make();
  const ev = popTick(s, d, 1);
  const died = ev.filter((e) => e.type === 'broodDied');
  assert.equal(died.length, 1);
  assert.equal(died[0].cause, 'frost');
  near(died[0].n, 6 * 0.5 * 0.005);
  near(broodTotal(s), 6 - 6 * 0.5 * 0.005);
  for (const tweak of [(x) => { x.d.season.mild = true; }, (x) => { x.d.season.year = 0; }, (x) => { x.offline = true; }]) {
    const w = make();
    tweak(w);
    const evs = popTick(w.s, w.d, 1, { offline: !!w.offline });
    assert.equal(evs.filter((e) => e.type === 'broodDied').length, 0);
    assert.equal(broodTotal(w.s), 6);
  }
});

test('larvae eat first: fungus for exactly one supermajor egg plus a big Nutrition demand → the egg is laid, φ uses the remainder', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 4 });                             // λ = 1
  s.run.research.fungiculture = 1;
  s.run.unlocked.caste_supermajor = true;
  s.run.colony.casteGoals = { soldier: 0, supermajor: 1000, replete: 0 };
  s.run.colony.adults.minor = 10000;                       // demand 50 fungus/s
  s.run.colony.layAcc = 1;
  d.nest.agg.warBerthsBase = 10; // C136: War Hall berths
  s.run.res.chitin = 25;
  s.run.res.fungus = 5;
  const ev = popTick(s, d, 0.1);
  assert.deepEqual(eggs(ev), [{ type: 'eggLaid', caste: 'supermajor', n: 1 }]);
  assert.equal(s.run.res.fungus, 0);
  assert.equal(s.run.colony.phi, 0, 'Nutrition got only what was left (nothing)');
  s.run.res.fungus = 2.5;
  s.run.res.chitin = 0;
  s.run.colony.layAcc = 0;
  popTick(s, d, 0.1);
  near(s.run.colony.phi, 2.5 / (0.005 * 10000 * 0.1));
});

test('Nutrition: φ = supplied / demand once fungiculture is owned; unchanged by a dt = 0 pass', () => {
  const { s, d } = setup();
  s.run.colony.layAcc = 0;
  s.run.research.fungiculture = 1;
  s.run.colony.adults.minor = 100;
  s.run.res.fungus = 0.25;
  popTick(s, d, 1);
  near(s.run.colony.phi, 0.5);
  popTick(s, d, 0);
  near(s.run.colony.phi, 0.5);
});

test('Fungal Brood: 0.5 × caste factor fungus per egg; switches itself off when fungus runs short (C19)', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 4 });
  s.run.colony.fungalBrood = true;
  s.run.res.fungus = 10;
  s.run.colony.layAcc = 1;
  popTick(s, d, 0.1);
  near(s.run.res.fungus, 9.5);
  s.run.res.fungus = 0.2;
  s.run.colony.layAcc = 1;
  const ev = popTick(s, d, 0.1);
  assert.equal(eggs(ev).length, 1, 'the egg is still laid');
  assert.equal(s.run.colony.fungalBrood, false);
  near(s.run.res.fungus, 0.2);
});

test('offline dt = 60: lays in one batch, no deaths (frost, starvation) and no population loss', () => {
  const { s, d } = setup();
  roomy(s, d, { layMult: 4 });                             // λ = 1 → 60 eggs
  s.meta.settings.harshNature = true;
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.forager = 10;
  s.run.colony.brood = [{ c: 'minor', n: 4, p: 0.1, t: 0 }];
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 1e6, factor: 1 }, { kind: 'nursery', uid: 2, cap: 10, factor: 1, exposed: true }];
  Object.assign(d.season, { id: 'winter', year: 2, mild: false });
  s.run.colony.layAcc = 0;
  const ev = tickColony(s, d, 60, { offline: true });
  assert.equal(eggs(ev).length, 1, 'one batch');
  assert.ok(eggs(ev)[0].n >= 59 && eggs(ev)[0].n <= 60);
  assert.deepEqual(ev.filter((e) => e.type === 'adultsDied' || e.type === 'broodDied'), []);
  assert.ok(s.run.colony.adults.minor >= 10, 'adults never drop offline');
  assert.ok(s.run.colony.adults.minor + broodTotal(s) >= 10 + 4 + 59, 'population only grows');
  assert.equal(s.run.colony.hungry, false);
});

test('a dt = 0 pass lays, develops and kills nothing', () => {
  const { s, d } = setup();
  s.run.colony.brood.push({ c: 'minor', n: 2, p: 0.9999, t: 0 });
  Object.assign(d.season, { id: 'winter', year: 3, mild: false });
  d.nest.agg.broodGroups = [{ kind: 'nursery', uid: 2, cap: 9, factor: 1, exposed: true }];
  const before = JSON.stringify(s);
  assert.deepEqual(popTick(s, d, 0), []);
  assert.equal(JSON.stringify(s), before);
});

test('addAdults: minors join forager (manual) or follow targets (auto); capped clamps to housing / berths', () => {
  const { s, d } = setup();
  recompute(s, d, fakeEnv());
  assert.equal(addAdults(s, d, 'minor', 4), 4);
  assert.equal(s.run.colony.jobs.forager, 4);
  s.run.colony.brood = [{ c: 'minor', n: 3, p: 0, t: 0 }];
  assert.equal(addAdults(s, d, 'minor', 10, { capped: true }), 3, 'housing 10 − 4 minors − 3 brood');
  d.nest.agg.berthsBase = 5;
  recompute(s, d, fakeEnv());
  assert.equal(addAdults(s, d, 'soldier', 9, { capped: true }), 5);
  assert.equal(addAdults(s, d, 'soldier', 9, { capped: true }), 0);
  assert.equal(addAdults(s, d, 'soldier', 2), 2, 'uncapped');
  for (const bad of ['queen', 'alate', 'x', null]) assert.equal(addAdults(s, d, bad, 1), 0);
  for (const bad of [0, -1, NaN, Infinity, '3']) assert.equal(addAdults(s, d, 'minor', bad), 0);
  s.run.unlocked.job_digger = true;
  s.run.colony.autoJobs = true;
  s.run.colony.jobTargets = { forager: 0.5, digger: 0.5, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  s.run.colony.jobs.forager = 0;
  addAdults(s, d, 'minor', 10);
  assert.equal(s.run.colony.jobs.forager, 5);
  assert.equal(s.run.colony.jobs.digger, 5);
});

test('killAdults: minors leave `job` first, then idle, then all jobs proportionally; golden shrink in proportion', () => {
  const { s, d } = setup();
  const col = s.run.colony;
  col.adults.minor = 20;
  col.jobs = { forager: 10, digger: 6, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };   // idle 4
  col.golden = 2;
  assert.equal(killAdults(s, d, 'minor', 3, 'battle', { job: 'digger' }), 3);
  assert.deepEqual([col.adults.minor, col.jobs.forager, col.jobs.digger], [17, 10, 3]);
  assert.equal(killAdults(s, d, 'minor', 4, 'event'), 4, 'idle first');
  assert.deepEqual([col.adults.minor, col.jobs.forager, col.jobs.digger], [13, 10, 3]);
  assert.equal(killAdults(s, d, 'minor', 6.5, 'event'), 6.5);
  near(col.jobs.forager + col.jobs.digger, 6.5);
  near(col.jobs.forager / col.jobs.digger, 10 / 3);
  near(col.golden, 2 * 6.5 / 20);
  assert.equal(killAdults(s, d, 'minor', 100, 'event'), 6.5, 'never more than alive');
  assert.equal(col.adults.minor, 0);
  assert.equal(col.jobs.forager + col.jobs.digger, 0);
  col.adults.soldier = 5;
  assert.equal(killAdults(s, d, 'soldier', 2, 'battle'), 2);
  assert.equal(col.adults.soldier, 3);
  for (const bad of [0, -1, NaN]) assert.equal(killAdults(s, d, 'soldier', bad, 'x'), 0);
  assert.equal(killAdults(s, d, 'queen', 1, 'x'), 0);
  assert.deepEqual(findBadValues(s), []);
});

test('killBrood / stealBrood remove a fraction of every cohort and return the count', () => {
  const { s } = setup();
  s.run.colony.brood = [{ c: 'minor', n: 10, p: 0.2, t: 0 }, { c: 'soldier', n: 4, p: 0.5, t: 1 }];
  near(killBrood(s, 0.25, 'raid'), 3.5);
  assert.deepEqual(s.run.colony.brood.map((c) => c.n), [7.5, 3]);
  near(stealBrood(s, 1), 10.5);
  assert.deepEqual(s.run.colony.brood, []);
  for (const bad of [0, -1, NaN, null]) assert.equal(killBrood(s, bad, 'x'), 0);
});

test('broodSummary: stages by progress, frozen count, per-caste totals', () => {
  const { s, d } = setup();
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0.1, t: 0 }, { c: 'minor', n: 3, p: 0.5, t: 1 }, { c: 'soldier', n: 1, p: 0.8, t: 2 }];
  const b = broodSummary(s, d);
  assert.deepEqual([b.egg, b.larva, b.pupa, b.total, b.frozen], [2, 3, 1, 6, 0]);
  assert.equal(b.byCaste.minor, 5);
  assert.equal(b.byCaste.soldier, 1);
  assert.equal(b.byCaste.alate, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------

test('setCasteTargets (C151 counts): locked castes, pacifist / monomorphic hardships, floors; copies into keep', () => {
  const { s, d } = setup();
  const v = (cmd) => handlers.setCasteTargets.validate(s, d, { type: 'setCasteTargets', ...cmd });
  assert.equal(v({ soldier: 0, supermajor: 0, replete: 0 }), null, 'zeros are always fine');
  assert.equal(v({}), 'invalid', 'nothing to set');
  assert.equal(v({ soldier: 3 }), 'locked');
  s.run.unlocked.caste_soldier = true;
  s.run.unlocked.caste_replete = true;
  for (const bad of [-1, 1e31, NaN, Infinity, null, '2', {}]) assert.equal(v({ soldier: bad }), 'invalid', String(bad));
  assert.equal(v({ soldier: 50, replete: 400 }), null, 'counts have no sum limit');
  s.run.hardship = 'pacifist';
  assert.equal(v({ soldier: 1 }), 'hardship');
  assert.equal(v({ replete: 1 }), null);
  s.run.hardship = 'monomorphic';
  assert.equal(v({ replete: 1 }), 'hardship');
  s.run.hardship = null;
  s.run.colony.casteFill.soldier = true;
  handlers.setCasteTargets.apply(s, d, { type: 'setCasteTargets', soldier: 30.7, replete: -0 });
  assert.deepEqual(s.run.colony.casteGoals, { soldier: 30, supermajor: 0, replete: 0 });
  assert.ok(!Object.is(s.run.colony.casteGoals.replete, -0));
  assert.equal(s.run.colony.casteFill.soldier, false, 'a typed target stops tracking the berths');
  assert.deepEqual(s.run.colony.casteTouched, { soldier: true, supermajor: false, replete: true });
  assert.deepEqual(s.meta.automation.keep.casteGoals, { soldier: 30, supermajor: 0, replete: 0 });
  assert.deepEqual(s.meta.automation.keep.casteFill, { soldier: false, replete: false }, 'only castes the player set');
  handlers.setCasteTargets.apply(s, d, { type: 'setCasteTargets', supermajor: 2 });
  assert.deepEqual(s.run.colony.casteGoals, { soldier: 30, supermajor: 2, replete: 0 }, 'omitted keys keep their value');
});

test('setEggReserve, setFungalBrood, rearAlate validation and effects', () => {
  const { s, d } = setup();
  const v = (type, cmd) => handlers[type].validate(s, d, { type, ...cmd });
  assert.equal(v('setEggReserve', { frac: 0.9 }), null);
  for (const bad of [0.95, -0.1, NaN, null, '0.5']) assert.equal(v('setEggReserve', { frac: bad }), 'invalid');
  handlers.setEggReserve.apply(s, d, { type: 'setEggReserve', frac: 0.4 });
  assert.equal(s.run.colony.eggReserve, 0.4);
  assert.equal(v('setFungalBrood', { on: true }), 'locked');
  assert.equal(v('setFungalBrood', { on: false }), null);
  assert.equal(v('setFungalBrood', { on: 1 }), 'invalid');
  s.run.research.fungiculture = 1;
  assert.equal(v('setFungalBrood', { on: true }), null);
  handlers.setFungalBrood.apply(s, d, { type: 'setFungalBrood', on: true });
  assert.equal(s.run.colony.fungalBrood, true);
  assert.equal(v('rearAlate', { n: 3 }), 'locked');
  s.run.unlocked.alate_rearing = true;
  assert.equal(v('rearAlate', { n: 3 }), 'requirements');
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  for (const bad of [0, -1, 1.5, NaN, null, '2']) assert.equal(v('rearAlate', { n: bad }), 'invalid');
  assert.equal(v('rearAlate', { n: 3 }), null);
  handlers.rearAlate.apply(s, d, { type: 'rearAlate', n: 3 });
  assert.equal(s.run.colony.rearRequested, 3);
});

test('groomBrood (click): +1 % × that group\'s share of brood capacity to every cohort; refused under claustral_founding', () => {
  const { s, d } = setup();
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 3, factor: 1 }, { kind: 'nursery', uid: 4, cap: 6, factor: 1 }];
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0.2, t: 0 }];
  const v = (cmd) => handlers.groomBrood.validate(s, d, { type: 'groomBrood', ...cmd });
  assert.equal(v({ chamber: 4 }), null);
  for (const bad of [2, null, '4', NaN]) assert.equal(v({ chamber: bad }), 'notFound');
  handlers.groomBrood.apply(s, d, { type: 'groomBrood', chamber: 4 });
  near(s.run.colony.brood[0].p, 0.2 + 0.01 * 6 / 9);
  assert.equal(s.meta.counters.clicks, 1);
  s.run.hardship = 'claustral_founding';
  assert.equal(v({ chamber: 4 }), 'hardship');
  s.run.hardship = null;
  for (let i = 1; i < 15; i++) handlers.groomBrood.apply(s, d, { type: 'groomBrood', chamber: 4 });
  assert.equal(v({ chamber: 4 }), 'clickCap');
});

test('clickQueen (click): queenClicks++; allowed under claustral_founding; capped at 15/s', () => {
  const { s, d } = setup();
  s.run.hardship = 'claustral_founding';
  for (let i = 0; i < 15; i++) {
    assert.equal(handlers.clickQueen.validate(s, d, { type: 'clickQueen' }), null);
    handlers.clickQueen.apply(s, d, { type: 'clickQueen' });
  }
  assert.equal(s.meta.counters.queenClicks, 15);
  assert.equal(handlers.clickQueen.validate(s, d, { type: 'clickQueen' }), 'clickCap');
});

test('retireAdults: garrison soldiers / supermajors → minors, limited by the garrison and free housing; emits adultsRetired', () => {
  const { s, d } = setup();
  s.run.colony.adults.soldier = 10;
  s.run.colony.adults.minor = 4;
  s.run.colony.jobs.forager = 4;
  d.combat.garrison = { soldier: 6, supermajor: 0 };
  recompute(s, d, fakeEnv());
  const v = (cmd) => handlers.retireAdults.validate(s, d, { type: 'retireAdults', ...cmd });
  assert.equal(v({ caste: 'minor', n: 1 }), 'invalid');
  assert.equal(v({ caste: 'queen', n: 1 }), 'invalid');
  for (const bad of [0, -2, NaN, null, '1']) assert.equal(v({ caste: 'soldier', n: bad }), 'invalid');
  assert.equal(v({ caste: 'soldier', n: 7 }), 'invalid:garrison');
  assert.equal(v({ caste: 'supermajor', n: 1 }), 'invalid:garrison');
  assert.equal(v({ caste: 'soldier', n: 6 }), null, 'garrison 6, free housing 10 − 4 = 6');
});

test('retireAdults applies within housing', () => {
  const { s, d } = setup();
  s.run.colony.adults.soldier = 10;
  s.run.colony.adults.minor = 4;
  s.run.colony.jobs.forager = 4;
  s.run.colony.brood = [{ c: 'minor', n: 1, p: 0, t: 0 }];
  d.combat.garrison = { soldier: 10, supermajor: 0 };
  recompute(s, d, fakeEnv());
  const v = (cmd) => handlers.retireAdults.validate(s, d, { type: 'retireAdults', ...cmd });
  assert.equal(v({ caste: 'soldier', n: 6 }), 'noSlot:housing');
  assert.equal(v({ caste: 'soldier', n: 5 }), null);
  const env = fakeEnv();
  handlers.retireAdults.apply(s, d, { type: 'retireAdults', caste: 'soldier', n: 5 }, env);
  assert.deepEqual([s.run.colony.adults.soldier, s.run.colony.adults.minor, s.run.colony.jobs.forager], [5, 9, 9]);
  assert.deepEqual(env.events, [{ type: 'adultsRetired', caste: 'soldier', n: 5 }]);
});
