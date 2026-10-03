// WP2 unit tests — systems/adaptations.js: cost curves (strictly increasing, MAX past 1e280, bulk), the monomorphic cap,
// availability, buyAdaptation validation codes and effects, and the autobuyer step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { cost, isAvailable, autobuyStep, handlers } from '../src/systems/adaptations.js';
import { ADAPTATIONS, ADAPTATION_ORDER } from '../src/data/adaptations.js';
import { COST_MAX } from '../src/data/balance.js';

const buy = handlers.buyAdaptation;
const v = (s, cmd) => buy.validate(s, makeDerived(), { type: 'buyAdaptation', ...cmd });

function unlockAll(s) {
  for (const id of ADAPTATION_ORDER) s.run.unlocked[ADAPTATIONS[id].unlock] = true;
}

test('cost(L) = base × growth^L per resource; strictly increasing; null (MAX) once above 1e280', () => {
  const s = newState(1);
  for (const id of ADAPTATION_ORDER) {
    const def = ADAPTATIONS[id].cost;
    let prev = null;
    let maxed = false;
    for (let L = 0; L < 5000 && !maxed; L++) {
      s.run.adaptations[id] = L;
      const c = cost(s, id);
      if (c === null) {
        maxed = true;
        assert.ok(Object.keys(def.base).some((k) => def.base[k] * def.growth ** L > COST_MAX), id + ' MAX only past 1e280');
        break;
      }
      for (const k of Object.keys(def.base)) {
        assert.ok(Math.abs(c[k] - def.base[k] * def.growth ** L) <= 1e-9 * c[k], id + ' L' + L);
        if (prev) assert.ok(c[k] > prev[k], id + ' strictly increasing at L' + L);
      }
      prev = c;
    }
    assert.ok(maxed, id + ' reaches MAX');
  }
});

test('documented base costs (DESIGN §10)', () => {
  const s = newState(1);
  assert.deepEqual(cost(s, 'quick_dispatch'), { food: 15 });
  assert.deepEqual(cost(s, 'serrated_mandibles'), { food: 100, chitin: 5 });
  assert.deepEqual(cost(s, 'queens_feast'), { honeydew: 50 });
  s.run.adaptations.quick_dispatch = 2;
  assert.ok(Math.abs(cost(s, 'quick_dispatch').food - 15 * 1.7 ** 2) < 1e-9);
});

test('bulk cost of n levels is the sum of the next n levels; bad n or id → null', () => {
  const s = newState(1);
  s.run.adaptations.strong_mandibles = 3;
  const c3 = cost(s, 'strong_mandibles', 3);
  const expect = 25 * (1.9 ** 3 + 1.9 ** 4 + 1.9 ** 5);
  assert.ok(Math.abs(c3.food - expect) < 1e-9 * expect);
  for (const n of [0, -1, 1.5, NaN, '2']) assert.equal(cost(s, 'strong_mandibles', n), null, String(n));
  for (const id of ['bogus', '__proto__', null]) assert.equal(cost(s, id), null);
});

test('monomorphic caps every Adaptation at L10', () => {
  const s = newState(1);
  s.run.hardship = 'monomorphic';
  s.run.adaptations.quick_dispatch = 9;
  assert.ok(cost(s, 'quick_dispatch', 1));
  assert.equal(cost(s, 'quick_dispatch', 2), null);
  s.run.adaptations.quick_dispatch = 10;
  assert.equal(cost(s, 'quick_dispatch'), null);
});

test('isAvailable: unlock key set; claustral_founding blocks royal_feeding', () => {
  const s = newState(1);
  assert.equal(isAvailable(s, 'quick_dispatch'), false);
  s.run.unlocked.adapt_basic = true;
  assert.equal(isAvailable(s, 'quick_dispatch'), true);
  assert.equal(isAvailable(s, 'royal_feeding'), true);
  s.run.hardship = 'claustral_founding';
  assert.equal(isAvailable(s, 'royal_feeding'), false);
  assert.equal(isAvailable(s, 'bogus'), false);
});

test('buyAdaptation: validation codes', () => {
  const s = newState(1);
  for (const bad of [undefined, null, 'bogus', 7, '__proto__', {}]) assert.equal(v(s, { id: bad }), 'invalid', String(bad));
  assert.equal(v(s, { id: 'quick_dispatch' }), 'locked');
  unlockAll(s);
  assert.equal(v(s, { id: 'quick_dispatch' }), 'cantAfford');
  s.run.res.food = 1000;
  assert.equal(v(s, { id: 'quick_dispatch' }), null);
  for (const n of [0, -1, 2.5, NaN, '1', null]) assert.equal(v(s, { id: 'quick_dispatch', n }), 'invalid', String(n));
  assert.equal(v(s, { id: 'quick_dispatch', n: 1e9 }), 'max');
  assert.equal(v(s, { id: 'serrated_mandibles' }), 'cantAfford', 'needs chitin too');
  s.run.hardship = 'claustral_founding';
  assert.equal(v(s, { id: 'royal_feeding' }), 'hardship');
  s.run.hardship = 'monomorphic';
  s.run.adaptations.quick_dispatch = 10;
  assert.equal(v(s, { id: 'quick_dispatch' }), 'max');
});

test('buyAdaptation: spends, raises the level and emits adaptationBought; bulk buy', () => {
  const s = newState(1);
  const d = makeDerived();
  unlockAll(s);
  s.run.res.food = 100;
  const env = fakeEnv();
  buy.apply(s, d, { type: 'buyAdaptation', id: 'quick_dispatch' }, env);
  assert.equal(s.run.adaptations.quick_dispatch, 1);
  assert.equal(s.run.res.food, 85);
  assert.deepEqual(env.events, [{ type: 'adaptationBought', id: 'quick_dispatch', level: 1 }]);
  const env2 = fakeEnv();
  s.run.res.food = 1000;
  buy.apply(s, d, { type: 'buyAdaptation', id: 'quick_dispatch', n: 3 }, env2);
  assert.equal(s.run.adaptations.quick_dispatch, 4);
  assert.ok(Math.abs(s.run.res.food - (1000 - 15 * (1.7 + 1.7 ** 2 + 1.7 ** 3))) < 1e-9);
  assert.deepEqual(env2.events, [{ type: 'adaptationBought', id: 'quick_dispatch', level: 4 }]);
});

test('autobuyStep buys one level of the cheapest affordable available Adaptation', () => {
  const s = newState(1);
  const d = makeDerived();
  assert.equal(autobuyStep(s, d, fakeEnv()), false, 'nothing available');
  s.run.unlocked.adapt_basic = true;
  s.run.res.food = 30;
  const env = fakeEnv();
  assert.equal(autobuyStep(s, d, env), true);
  assert.equal(s.run.adaptations.quick_dispatch, 1, '15 food is the cheapest');
  assert.equal(env.events[0].type, 'adaptationBought');
  assert.equal(autobuyStep(s, d, fakeEnv()), false, '15 left: quick_dispatch L1 costs 25.5, mandibles 25');
  s.run.res.food = 25.2;
  assert.equal(autobuyStep(s, d, fakeEnv()), true);
  assert.equal(s.run.adaptations.strong_mandibles, 1);
});
