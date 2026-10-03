// WP2 unit tests — systems/bottleneck.js: the pinned priority order, the 5 s food-cap timer, `since`, change events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { tick } from '../src/systems/bottleneck.js';
import { recompute } from '../src/systems/stats.js';

function setup() {
  const s = newState(1);
  const d = makeDerived();
  s.run.colony.naniticsLeft = 0;
  s.run.colony.layAcc = 0.5;
  return { s, d };
}
/** recompute + bottleneck.tick; returns the events. */
function bn(s, d, dt = 0.1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  recompute(s, d, env);
  tick(s, d, dt, env);
  s.run.time += dt;
  return env.events;
}

test('bn_food when food < egg cost; bn_lay_rate when food, slot and housing are free but layAcc < 1', () => {
  const { s, d } = setup();
  s.run.res.food = 5;
  const ev = bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_food');
  assert.deepEqual(ev, [{ type: 'bottleneckChanged', id: 'bn_food' }]);
  s.run.res.food = 50;
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_lay_rate');
  s.run.colony.layAcc = 1.2;
  bn(s, d);
  assert.equal(s.run.bottleneck.id, null, 'eggs are due: nothing binds');
  s.run.colony.layAcc = 0.5;
  s.run.colony.eggReserve = 0.5;
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_food', 'food above the reserve counts');
});

test('housing > brood slots > lay rate; since = run.time of the change; no event without a change', () => {
  const { s, d } = setup();
  s.run.res.food = 50;
  s.run.colony.brood = [{ c: 'minor', n: 3, p: 0, t: 0 }];
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_brood_slots');
  s.run.colony.adults.minor = 7;
  s.run.time = 12;
  const ev = bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_housing');
  assert.equal(s.run.bottleneck.since, 12);
  assert.equal(ev.length, 1);
  assert.equal(bn(s, d).length, 0);
  assert.equal(s.run.bottleneck.since, 12);
});

test('bn_food_cap only after food ≥ 99 % of the cap for more than 5 s; capT resets below', () => {
  const { s, d } = setup();
  s.run.res.food = 149;
  for (let i = 0; i < 50; i++) bn(s, d);
  assert.notEqual(s.run.bottleneck.id, 'bn_food_cap');
  for (let i = 0; i < 2; i++) bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_food_cap');
  s.run.res.food = 100;
  bn(s, d);
  assert.equal(s.run.bottleneck.capT, 0);
  assert.notEqual(s.run.bottleneck.id, 'bn_food_cap');
});

test('priority: frost (online) > hungry > housing > food cap; an incoming raid never hides the bottleneck (C72)', () => {
  const { s, d } = setup();
  s.run.res.food = 150;
  s.run.bottleneck.capT = 10;
  s.run.colony.adults.minor = 10;
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_housing', 'eggs blocked by housing: the full larder is a symptom (C72)');
  s.run.colony.adults.minor = 5;
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_food_cap', 'housing free, food parked at the cap');
  s.run.colony.adults.minor = 10;
  s.run.colony.hungry = true;
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'hungry');
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0, t: 0 }];
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 3, factor: 1 }, { kind: 'nursery', uid: 2, cap: 3, factor: 1, exposed: true }];
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'frost');
  bn(s, d, 10, { offline: true });
  assert.equal(s.run.bottleneck.id, 'hungry', 'frost is reported online only');
  s.run.war.raids.push({ uid: 1, rival: 1, target: { type: 'nest' }, raiders: 5, warn: 20, phase: 'warning', guard: 0 });
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'frost', 'a raid in warning has its own HUD chip; the badge keeps the real limit');
});

test('C72: housing and brood slots outrank a full food store; food cap outranks the lay rate', () => {
  const { s, d } = setup();
  s.run.res.food = 150;                                    // at the 150 cap
  for (let i = 0; i < 60; i++) bn(s, d);                   // > 5 s at the cap
  assert.equal(s.run.bottleneck.id, 'bn_food_cap', 'nothing blocks eggs: the cap (and the lay timer) bind');
  s.run.colony.brood = [{ c: 'minor', n: 3, p: 0, t: 0 }]; // 3 brood = 3 slots
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_brood_slots', 'eggs wait for a slot while food sits at the cap');
  s.run.colony.adults.minor = 7;                           // 7 + 3 = 10 = housing
  bn(s, d);
  assert.equal(s.run.bottleneck.id, 'bn_housing', 'eggs blocked by housing while food sits at the cap');
  assert.ok(s.run.bottleneck.capT > 5, 'the cap timer keeps running underneath');
});

test('a dt = 0 pass changes nothing', () => {
  const { s, d } = setup();
  const before = JSON.stringify(s);
  recompute(s, d, fakeEnv());
  tick(s, d, 0, fakeEnv());
  assert.equal(JSON.stringify(s), before);
});
