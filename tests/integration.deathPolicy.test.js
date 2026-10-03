// INTEGRATION TEST — ARCHITECTURE §15.3 #15 / DESIGN §3 death policy, §21.4 torpor floor. Owner: WP1.
// No adult or brood deaths offline (any settings, any season); no starvation deaths online with harsh_nature off.
// The invariants hold trivially against the WP1 stubs; the "scenario was meaningful" preconditions (the colony
// actually went Hungry / actually progressed offline) are EXPECTED TO FAIL until WP2/WP3/WP6 land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { step } from '../src/core/step.js';
import { simulateOffline } from '../src/core/offline.js';
import { adultsTotal } from '../src/core/state.js';
import { CELL, GRID } from '../src/data/balance.js';
import { quietWorld, livePopulation } from './helpers.js';

/** A fresh full game with the random world hazards (events, raids, beetles) switched off. */
function quietGame(seed) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  quietWorld(g.s);
  return g;
}

test('online with harsh_nature off: food 0 and heavy upkeep never kill an adult', () => {
  const g = quietGame(3);
  const s = g.s;
  s.meta.settings.harshNature = false;
  s.run.colony.adults.minor = 8;
  s.run.colony.adults.soldier = 200; // 50 food/s upkeep
  s.run.colony.jobs.forager = 8;
  s.run.res.food = 0;
  let wentHungry = false;
  let minAdults = adultsTotal(s);
  const deaths = [];
  for (let i = 0; i < 1200; i++) {
    const ev = g.tickOnce();
    for (const e of ev) if (e.type === 'adultsDied' || e.type === 'broodDied') deaths.push(e);
    if (s.run.colony.hungry) wentHungry = true;
    minAdults = Math.min(minAdults, adultsTotal(s));
  }
  assert.deepEqual(deaths.filter((e) => e.cause === 'starvation'), [], 'no starvation deaths');
  assert.deepEqual(deaths, [], 'no deaths at all in a quiet world');
  assert.ok(minAdults >= 208 - 1e-9, 'adults never dropped (min ' + minAdults + ')');
  assert.ok(wentHungry, 'precondition: the colony entered the Hungry state');
});

test('offline (harsh_nature on, hard winter, exposed nursery, empty larder): nobody dies, population never shrinks', () => {
  const g = quietGame(4);
  const s = g.s;
  s.meta.settings.harshNature = true;
  s.meta.season.year = 2;
  s.meta.season.t = 3 * s.meta.season.lengthSec - 30; // 30 s before winter
  // a shallow, exposed nursery joined to the main shaft
  const W = GRID.cols;
  for (let y = 2; y <= 3; y++) for (let x = 5; x <= 7; x++) s.run.nest.cells[y * W + x] = CELL.CHAMBER;
  for (let x = 8; x < GRID.mainCol; x++) s.run.nest.cells[3 * W + x] = CELL.TUNNEL;
  s.run.nest.chambers.push({ uid: s.run.nest.nextUid, type: 'nursery', k: 0, x: 5, y: 2, w: 3, h: 2, level: 1, target: 1,
    status: 'active', blueprint: false, bornAt: 0 });
  s.run.nest.nextUid++;
  s.run.nest.rev++;
  s.run.colony.adults.minor = 9;
  s.run.colony.adults.soldier = 60;
  s.run.colony.jobs.forager = 9;
  s.run.colony.brood = [{ c: 'minor', n: 4, p: 0.1, t: 0 }, { c: 'soldier', n: 2, p: 0.3, t: 0 }];
  s.run.res.food = 0;
  step(s, g.d, 0, [], {});

  const startAdults = adultsTotal(s);
  const startPop = livePopulation(s);
  let pop = startPop;
  let adults = startAdults;
  const problems = [];
  const deaths = [];
  const watched = (st, dd, dt, cmds, opts) => {
    const ev = step(st, dd, dt, cmds, opts);
    for (const e of ev) if (e.type === 'adultsDied' || e.type === 'broodDied') deaths.push(e);
    const a = adultsTotal(st);
    const p = livePopulation(st);
    if (a < adults - 1e-9) problems.push('adults fell ' + adults + ' → ' + a + ' at run.time ' + st.run.time);
    if (p < pop - 1e-9) problems.push('population fell ' + pop + ' → ' + p + ' at run.time ' + st.run.time);
    adults = a;
    pop = p;
    return ev;
  };
  const sum = simulateOffline(s, g.d, 4 * 3600, { eff: 0.5, stepFn: watched });
  assert.deepEqual(deaths, [], 'no adultsDied / broodDied events offline');
  assert.deepEqual(problems.slice(0, 5), [], 'torpor floor: adults and live population never decrease offline');
  assert.equal(s.run.colony.hungry, false, 'Hungry is never set offline');
  assert.ok(sum.hatched > 0 || livePopulation(s) > startPop, 'precondition: the colony progressed offline (hatched ' + sum.hatched + ')');
});
