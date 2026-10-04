// Gameplay-rules regression tests — systems/population.js laying at the food cap:
// F9 / F22 (C71): a slider caste (or alate) whose egg costs more food than storage can ever hold must not block every
// other egg — it is skipped like a caste with a full berth and minors are still laid (DESIGN §5.1, §5.5).
// F23 (C70): eggs due in a step may be paid with the food produced at the cap during that step, so one long (offline)
// step lays what the same time in 0.1 s ticks lays, instead of at most floor(cap / egg cost) eggs per step (§21.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { recompute } from '../src/systems/stats.js';
import { tick as economyTick } from '../src/systems/economy.js';
import { tick as populationTick } from '../src/systems/population.js';

/** recompute + economy + population for one step of dt (ledger = food production per second from `trails`). */
function colonyStep(s, d, dt, { food = 0, offline = false } = {}) {
  const env = fakeEnv({ dt, offline });
  for (const r of Object.keys(d.ledger)) d.ledger[r] = {};
  if (food > 0) d.ledger.food = { trails: food };
  recompute(s, d, env);
  economyTick(s, d, dt, env);
  populationTick(s, d, dt, env);
  s.run.time += dt;
  return env.events;
}

const laid = (ev, caste) => ev.filter((e) => e.type === 'eggLaid' && (!caste || e.caste === caste)).reduce((a, e) => a + e.n, 0);

/**
 * A colony of 100 minors (minor egg E(100) ≈ 52 food, soldier ×5 ≈ 260, supermajor ×50) with the starting 150-food cap,
 * roomy housing / slots / berths, λ = 10 eggs/s and plenty of chitin, honeydew and fungus.
 */
function capped({ layMult = 40 } = {}) {
  const s = newState(1);
  const d = makeDerived();
  const col = s.run.colony;
  col.naniticsLeft = 0;
  col.layAcc = 0;
  col.adults.minor = 100;
  col.jobs.forager = 100;
  s.run.res.food = 0;
  s.run.res.chitin = 1e6;
  s.run.res.honeydew = 1e6;
  s.run.res.fungus = 1e6;
  d.nest.agg.housingBase = 1e6;
  d.nest.agg.berthsBase = 1000;
  d.nest.agg.warBerthsBase = 1000; // C136: supermajors live in War Hall berths
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 1e6, factor: 1, exposed: false, snap: false, inReach: false }];
  d.meta.prestige.lay = layMult;
  s.run.unlocked.caste_soldier = true;
  s.run.unlocked.caste_supermajor = true;
  recompute(s, d, fakeEnv());
  return { s, d };
}

test('F22: a soldier egg that costs more than the food cap no longer stops minors from being laid', () => {
  const { s, d } = capped();
  s.run.colony.casteTargets = { soldier: 0.15, supermajor: 0, replete: 0 };
  assert.ok(d.stats.eggCost.soldier > d.stats.foodCap, `precondition: soldier egg ${d.stats.eggCost.soldier} > cap ${d.stats.foodCap}`);
  assert.ok(d.stats.eggCost.minor <= d.stats.foodCap, 'precondition: a minor egg fits in storage');
  let minors = 0;
  let soldiers = 0;
  for (let i = 0; i < 100; i++) {
    const ev = colonyStep(s, d, 0.1, { food: 400 });
    minors += laid(ev, 'minor');
    soldiers += laid(ev, 'soldier');
  }
  assert.equal(soldiers, 0, 'the soldier egg can never be paid');
  assert.ok(minors >= 50, 'minors are still laid (got ' + minors + ')');
  // Once storage can hold a soldier egg, the slider caste is laid again.
  d.nest.agg.granaryCap = 1e6;
  s.run.res.food = 1e5;
  let later = 0;
  for (let i = 0; i < 30; i++) later += laid(colonyStep(s, d, 0.1, { food: 400 }), 'soldier');
  assert.ok(later > 0, 'soldiers resume when the cap is raised');
});

test('F9: an unaffordable supermajor falls through to the next slider caste (soldier), then minors', () => {
  const { s, d } = capped();
  d.nest.agg.granaryCap = 250;                        // soldier (~260) fits, supermajor (~2,600) never does
  recompute(s, d, fakeEnv());
  assert.ok(d.stats.eggCost.soldier <= d.stats.foodCap && d.stats.eggCost.supermajor > d.stats.foodCap,
    `precondition: soldier ${d.stats.eggCost.soldier} ≤ cap ${d.stats.foodCap} < supermajor ${d.stats.eggCost.supermajor}`);
  s.run.colony.casteTargets = { soldier: 0.15, supermajor: 0.3, replete: 0 };
  s.run.res.food = d.stats.foodCap;
  const tally = { minor: 0, soldier: 0, supermajor: 0 };
  for (let i = 0; i < 200; i++) {
    const ev = colonyStep(s, d, 0.1, { food: 2000 });
    for (const c of Object.keys(tally)) tally[c] += laid(ev, c);
  }
  assert.equal(tally.supermajor, 0);
  assert.ok(tally.soldier > 0 && tally.minor > 0, JSON.stringify(tally));
});

test('F22: the egg reserve counts — a soldier egg above cap × (1 − reserve) is skipped, minors still come', () => {
  const { s, d } = capped();
  d.nest.agg.granaryCap = 250;
  recompute(s, d, fakeEnv());
  const cap = d.stats.foodCap;
  assert.ok(d.stats.eggCost.soldier < cap && d.stats.eggCost.soldier > cap * 0.4, 'precondition');
  s.run.colony.casteTargets = { soldier: 0.15, supermajor: 0, replete: 0 };
  s.run.colony.eggReserve = 0.6;                      // only 40 % of the cap is ever spendable on eggs
  s.run.res.food = cap;
  let minors = 0;
  for (let i = 0; i < 50; i++) minors += laid(colonyStep(s, d, 0.1, { food: 20 }), 'minor');
  assert.ok(minors > 0, 'minors laid despite the reserve and the soldier slider');
  assert.equal(s.run.colony.eggs.soldier, 0);
});

test('F22: requested alates whose egg storage can never pay for do not block minors', () => {
  const { s, d } = capped();
  s.run.unlocked.alate_rearing = true;
  s.run.colony.rearRequested = 10;
  d.nest.agg.alateCells = 10;
  recompute(s, d, fakeEnv());
  assert.equal(d.stats.alateCells, 10, 'precondition: free alate cells');
  assert.ok(d.stats.eggCost.alate > d.stats.foodCap, 'precondition: alate egg (×20) above the cap');
  let minors = 0;
  for (let i = 0; i < 50; i++) minors += laid(colonyStep(s, d, 0.1, { food: 400 }), 'minor');
  assert.ok(minors > 0);
  assert.equal(s.run.colony.eggs.alate, 0);
  assert.equal(s.run.colony.rearRequested, 10, 'the request waits for a bigger cap');
});

test('F23: one 10 s step at the cap lays what 100 ticks of 0.1 s lay (food produced at the cap pays for eggs)', () => {
  const run = (dt, n, offline) => {
    const { s, d } = capped();
    s.run.res.food = d.stats.foodCap;
    let eggs = 0;
    for (let i = 0; i < n; i++) eggs += laid(colonyStep(s, d, dt, { food: 5000, offline }));
    return { eggs, s, d };
  };
  const online = run(0.1, 100, false);
  const offline = run(10, 1, true);
  assert.ok(online.eggs >= 95, 'online lays ~λ × 10 s = 100 (got ' + online.eggs + ')');
  assert.ok(Math.abs(offline.eggs - online.eggs) <= 0.02 * online.eggs + 1,
    'offline ' + offline.eggs + ' vs online ' + online.eggs + ' (before the fix: floor(cap / egg) = 2)');
  // The store is left full: eggs were paid from the step's production first, and what they used is not "wasted".
  assert.ok(offline.s.run.res.food >= offline.d.stats.foodCap * 0.99, 'food stays at the cap');
  const produced = 5000 * 10;
  assert.ok(offline.s.run.stats.foodWasted < produced - offline.eggs * 50, 'egg food is not counted as wasted');
});

test('F23: without spare production at the cap the store pays as before (no spill, no change)', () => {
  const { s, d } = capped();
  s.run.res.food = 120;                                // below the cap: no food is produced at the cap
  const ev = colonyStep(s, d, 0.1, { food: 10 });
  assert.equal(laid(ev), 1, 'one egg due, paid from the store');
  assert.ok(s.run.res.food < 120 - 40, 'the store paid for it');
});

test('C91: full housing does not block soldier eggs while Barracks berths are free', () => {
  const { s, d } = capped();
  d.nest.agg.housingBase = 100; // every Gallery place is taken by the 100 minors
  d.nest.agg.foodCapBase = 1e6;
  recompute(s, d, fakeEnv());
  s.run.res.food = 5e5;
  s.run.colony.casteTargets = { soldier: 0.9, supermajor: 0, replete: 0 };
  let soldiers = 0;
  let minors = 0;
  for (let i = 0; i < 50; i++) {
    const ev = colonyStep(s, d, 0.1);
    soldiers += laid(ev, 'soldier');
    minors += laid(ev, 'minor');
  }
  assert.ok(soldiers > 0, 'soldier eggs are laid into free berths');
  assert.equal(minors, 0, 'no minor eggs: housing is full');
});
