// WP1 unit tests: core/rng.js (mulberry32 golden values, helpers, determinism).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextU32, rand, randInt, randRange, chance, pick, weighted, shuffle, expSample, makeHolder, deriveSeed,
} from '../src/core/rng.js';

test('mulberry32 golden values for seed 1', () => {
  const h = makeHolder(1);
  const got = [];
  for (let i = 0; i < 5; i++) got.push(nextU32(h));
  assert.deepEqual(got, [2693262067, 11749833, 2265367787, 4213581821, 4159151403]);
  assert.equal(h.rng, 567894474);
  const h2 = makeHolder(1);
  assert.equal(rand(h2), 0.6270739405881613);
  assert.equal(rand(h2), 0.002735721180215478);
  assert.equal(rand(h2), 0.5274470399599522);
});

test('golden values for seed 42 and holder state is uint32', () => {
  const h = makeHolder(42);
  assert.deepEqual([nextU32(h), nextU32(h), nextU32(h)], [2581720956, 1925393290, 3661312704]);
  assert.ok(Number.isInteger(h.rng) && h.rng >= 0 && h.rng <= 0xffffffff);
});

test('makeHolder: seed 0 maps to 1, seeds are coerced to uint32', () => {
  assert.deepEqual(makeHolder(0), { rng: 1 });
  assert.deepEqual(makeHolder(-1), { rng: 0xffffffff });
  assert.deepEqual(makeHolder(2 ** 32 + 5), { rng: 5 });
});

test('the state object works as a holder', () => {
  const s = { rng: 1, other: 'x' };
  const a = rand(s);
  assert.equal(a, 0.6270739405881613);
  assert.notEqual(s.rng, 1);
});

test('rand in [0,1), randInt inclusive bounds, randRange', () => {
  const h = makeHolder(7);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const r = rand(h);
    assert.ok(r >= 0 && r < 1);
    const k = randInt(h, 3, 6);
    assert.ok(Number.isInteger(k) && k >= 3 && k <= 6);
    seen.add(k);
    const f = randRange(h, -2, 5);
    assert.ok(f >= -2 && f < 5);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6]);
  assert.equal(randInt(h, 4, 4), 4);
  assert.equal(randInt(h, 5, 2), 5);
});

test('chance and expSample statistics', () => {
  const h = makeHolder(99);
  let hits = 0;
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    if (chance(h, 0.25)) hits++;
    sum += expSample(h, 240);
  }
  assert.ok(Math.abs(hits / n - 0.25) < 0.02);
  assert.ok(Math.abs(sum / n - 240) < 10);
  assert.equal(chance(makeHolder(3), 0), false);
  assert.equal(chance(makeHolder(3), 1), true);
});

test('pick, weighted and shuffle are deterministic and well-formed', () => {
  const arr = ['a', 'b', 'c', 'd'];
  const run = () => {
    const h = makeHolder(123);
    return [pick(h, arr), weighted(h, [{ id: 'x', w: 1 }, { id: 'y', w: 3 }]).id, shuffle(h, arr.slice()).join('')];
  };
  assert.deepEqual(run(), run());
  assert.equal(pick(makeHolder(1), []), null);
  assert.equal(weighted(makeHolder(1), []), null);
  assert.equal(weighted(makeHolder(1), [{ w: 0 }, { w: -2 }, { w: NaN }]), null);
  const h = makeHolder(5);
  const counts = { x: 0, y: 0 };
  for (let i = 0; i < 8000; i++) counts[weighted(h, [{ id: 'x', w: 1 }, { id: 'y', w: 3 }]).id]++;
  assert.ok(Math.abs(counts.y / 8000 - 0.75) < 0.03);
  const sh = shuffle(makeHolder(8), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(sh.slice().sort(), [1, 2, 3, 4, 5, 6]);
});

test('weighted skips zero weights and never returns them', () => {
  const h = makeHolder(11);
  for (let i = 0; i < 2000; i++) assert.equal(weighted(h, [{ id: 'z', w: 0 }, { id: 'p', w: 2 }]).id, 'p');
});

test('deriveSeed gives uint32 child seeds from the stream', () => {
  const h = makeHolder(1);
  const a = deriveSeed(h);
  const b = deriveSeed(h);
  assert.equal(a, 2693262067);
  assert.equal(b, 11749833);
  assert.notEqual(a, b);
});
