// WP1 unit tests: core/wallet.js (afford/spend, grant overflow and f_run, caps, refunds, income, time to afford).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAfford, missing, spend, refund, grant, incomeSeconds, timeToAfford, scaleCost } from '../src/core/wallet.js';
import { newState, makeDerived } from './helpers.js';
import { CLAMP_MAX } from '../src/data/balance.js';

test('canAfford / missing / spend are all-or-nothing', () => {
  const s = newState();
  s.run.res.food = 100;
  s.run.res.soil = 10;
  assert.equal(canAfford(s, { food: 50, soil: 10 }), true);
  assert.equal(canAfford(s, { food: 50, soil: 11 }), false);
  assert.deepEqual(missing(s, { food: 120, soil: 5 }), { food: 20 });
  assert.deepEqual(missing(s, { food: 10 }), {});
  assert.equal(spend(s, { food: 50, soil: 11 }), false);
  assert.equal(s.run.res.food, 100);
  assert.equal(s.run.res.soil, 10);
  assert.equal(spend(s, { food: 50, soil: 10 }), true);
  assert.equal(s.run.res.food, 50);
  assert.equal(s.run.res.soil, 0);
  assert.equal(canAfford(s, {}), true);
});

test('null (MAX), malformed and unknown costs are never affordable', () => {
  const s = newState();
  s.run.res.food = 1e9;
  assert.equal(canAfford(s, null), false);
  assert.equal(spend(s, null), false);
  assert.deepEqual(missing(s, null), {});
  assert.equal(canAfford(s, { food: NaN }), false);
  assert.equal(canAfford(s, { food: -1 }), false);
  assert.equal(canAfford(s, { gold: 1 }), false);
  assert.equal(canAfford(s, { food: Infinity }), false);
});

test('meta currencies route to cycle / era / meta', () => {
  const s = newState();
  s.cycle.alates = 10;
  s.era.kinship = 3;
  s.meta.genes = 2;
  assert.equal(spend(s, { alates: 4, kinship: 1, genes: 2 }), true);
  assert.equal(s.cycle.alates, 6);
  assert.equal(s.era.kinship, 2);
  assert.equal(s.meta.genes, 0);
  const d = makeDerived();
  assert.equal(grant(s, d, 'alates', 5), 5);
  assert.equal(grant(s, d, 'kinship', 1), 1);
  assert.equal(grant(s, d, 'genes', 7), 7);
  assert.equal(s.cycle.alates, 11);
  assert.equal(s.cycle.alatesCycle, 0); // lifetime counters are WP7's
});

test('grant food: capped at foodCap, excess wasted, FULL amount counted in fRun and foodEver', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 150 } });
  s.run.res.food = 100;
  assert.equal(grant(s, d, 'food', 80), 50);
  assert.equal(s.run.res.food, 150);
  assert.equal(s.run.stats.foodWasted, 30);
  assert.equal(s.run.fRun, 80);
  assert.equal(s.meta.stats.foodEver, 80);
  // above the cap nothing is added
  assert.equal(grant(s, d, 'food', 10), 0);
  assert.equal(s.run.fRun, 90);
  assert.equal(s.run.stats.foodWasted, 40);
});

test('grant food with overflow reaches 2 × cap; countFRun false skips the counters', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 150 } });
  s.run.res.food = 140;
  assert.equal(grant(s, d, 'food', 500, { overflow: true }), 160);
  assert.equal(s.run.res.food, 300);
  assert.equal(s.run.stats.foodWasted, 340);
  assert.equal(s.run.fRun, 500);
  const s2 = newState();
  s2.run.res.food = 0;
  grant(s2, d, 'food', 20, { countFRun: false });
  assert.equal(s2.run.res.food, 20);
  assert.equal(s2.run.fRun, 0);
  assert.equal(s2.meta.stats.foodEver, 0);
});

test('grant clamps capped resources at their d.stats caps; uncapped at CLAMP_MAX; bad amounts ignored', () => {
  const s = newState();
  const d = makeDerived({ stats: { honeydewCap: 65, leafCap: 0, fungusCap: 10, pheromoneCap: 50 } });
  assert.equal(grant(s, d, 'honeydew', 100), 65);
  assert.equal(grant(s, d, 'leaves', 5), 0);
  assert.equal(grant(s, d, 'fungus', 4), 4);
  assert.equal(grant(s, d, 'pheromone', 60), 50);
  s.run.res.insight = CLAMP_MAX * 0.9;
  grant(s, d, 'insight', CLAMP_MAX);
  assert.equal(s.run.res.insight, CLAMP_MAX);
  assert.equal(grant(s, d, 'soil', 12), 12);
  assert.equal(grant(s, d, 'chitin', NaN), 0);
  assert.equal(grant(s, d, 'chitin', -5), 0);
  assert.equal(grant(s, d, 'chitin', Infinity), 0);
  assert.equal(grant(s, d, 'gold', 5), 0);
  assert.equal(s.run.res.chitin, 0);
});

test('refund: frac × cost, never above the cap for capped resources, keeps overflow', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 150 } });
  s.run.res.food = 100;
  refund(s, d, { food: 200, soil: 30 }, 0.5);
  assert.equal(s.run.res.food, 150);
  assert.equal(s.run.res.soil, 15);
  s.run.res.food = 280; // overflow from a one-shot reward
  refund(s, d, { food: 40 });
  assert.equal(s.run.res.food, 280);
  assert.equal(s.run.fRun, 0);
  refund(s, d, null);
  refund(s, d, { soil: 10 }, 0);
  assert.equal(s.run.res.soil, 15);
});

test('incomeSeconds: max(min, sec × gross)', () => {
  const d = makeDerived({ rates: { food: { gross: 4 } } });
  assert.equal(incomeSeconds(d, 'food', 120), 480);
  assert.equal(incomeSeconds(d, 'food', 120, 1000), 1000);
  assert.equal(incomeSeconds(d, 'insight', 30, 10), 10);
  assert.equal(incomeSeconds(d, 'nothing', 30, 3), 3);
});

test('timeToAfford: 0 when affordable, deficit / net, -1 when never', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 150 }, rates: { food: { net: 2 }, soil: { net: 0.5 } } });
  s.run.res.food = 10;
  assert.equal(timeToAfford(s, d, { food: 5 }), 0);
  assert.equal(timeToAfford(s, d, { food: 50 }), 20);
  assert.equal(timeToAfford(s, d, { food: 50, soil: 10 }), 20);
  assert.equal(timeToAfford(s, d, { food: 50, soil: 20 }), 40);
  assert.equal(timeToAfford(s, d, { food: 151 }), -1); // above the cap
  assert.equal(timeToAfford(s, d, { insight: 1 }), -1); // no income
  assert.equal(timeToAfford(s, d, null), -1);
  assert.equal(timeToAfford(s, d, { alates: 1 }), -1);
});

test('scaleCost', () => {
  assert.deepEqual(scaleCost({ food: 10, chitin: 2 }, 0.5), { food: 5, chitin: 1 });
  assert.equal(scaleCost(null, 2), null);
});
