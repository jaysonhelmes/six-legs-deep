// WP1 unit tests: core/hex.js (spiral fixtures, counts, distances, pixels, A*, lines; ARCHITECTURE §7.10, #10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRS, HEX_COUNT, countInRadius, hexIndex, hexQR, ringOf, neighbors, hexDist, hexToPixel, pixelToHex, hexesInRadius,
  hexPath, lineHexes, colForHex,
} from '../src/core/hex.js';

test('DIRS and HEX_COUNT', () => {
  assert.deepEqual(DIRS, [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]);
  assert.equal(HEX_COUNT, 817);
});

test('spiral order: index 0 is the centre, ring 1 order is fixed', () => {
  assert.deepEqual(hexQR(0), [0, 0]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(hexQR), [[-1, 1], [0, 1], [1, 0], [1, -1], [0, -1], [-1, 0]]);
  // ring 2 starts at 2 × DIRS[4]
  assert.deepEqual(hexQR(7), [-2, 2]);
  assert.deepEqual(hexQR(8), [-1, 2]);
  assert.deepEqual(hexQR(18), [-2, 1]);
});

test('counts 217 / 469 / 817 and ring index ranges', () => {
  assert.equal(countInRadius(0), 1);
  assert.equal(countInRadius(2), 19);
  assert.equal(countInRadius(8), 217);
  assert.equal(countInRadius(12), 469);
  assert.equal(countInRadius(16), 817);
  assert.equal(hexesInRadius(8).length, 217);
  assert.deepEqual(hexesInRadius(1), [0, 1, 2, 3, 4, 5, 6]);
  for (let k = 1; k <= 16; k++) {
    const first = 1 + 3 * k * (k - 1);
    const last = 3 * k * (k + 1);
    assert.equal(ringOf(first), k);
    assert.equal(ringOf(last), k);
    if (k > 1) assert.equal(ringOf(first - 1), k - 1);
  }
});

test('hexIndex / hexQR round-trip for all 817 hexes; outside radius → -1', () => {
  const seen = new Set();
  for (let i = 0; i < HEX_COUNT; i++) {
    const [q, r] = hexQR(i);
    assert.equal(hexIndex(q, r), i);
    assert.equal(ringOf(i), (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2);
    seen.add(q + ',' + r);
  }
  assert.equal(seen.size, 817);
  assert.equal(hexIndex(17, 0), -1);
  assert.equal(hexIndex(9, 9), -1); // q + r = 18 → ring 18
  assert.equal(hexIndex(0.5, 0), -1);
});

test('neighbours: 6 inside, fewer on the rim, symmetric', () => {
  assert.deepEqual([...neighbors(0)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  for (let i = 0; i < HEX_COUNT; i++) {
    const nb = neighbors(i);
    if (ringOf(i) < 16) assert.equal(nb.length, 6);
    else assert.ok(nb.length === 3 || nb.length === 4);
    for (const n of nb) {
      assert.equal(hexDist(i, n), 1);
      assert.ok(neighbors(n).includes(i));
    }
  }
});

test('hexDist fixtures', () => {
  assert.equal(hexDist(0, 3), 1);
  assert.equal(hexDist(0, 816), 16);
  assert.equal(hexDist(1, 4), 2); // (-1,1) to (1,-1)
  assert.equal(hexDist(hexIndex(-3, 0), hexIndex(3, 0)), 6);
  assert.equal(hexDist(hexIndex(2, -5), hexIndex(-1, 3)), 8);
});

test('hexToPixel / pixelToHex round-trip; hex 3 is due east', () => {
  const [x3, y3] = hexToPixel(3, 26);
  assert.ok(Math.abs(x3 - 26 * Math.sqrt(3)) < 1e-9 && Math.abs(y3) < 1e-12);
  for (let i = 0; i < HEX_COUNT; i++) {
    const [x, y] = hexToPixel(i, 26);
    assert.equal(pixelToHex(x, y, 26), i);
    assert.equal(pixelToHex(x + 8, y - 6, 26), i);
  }
  assert.equal(pixelToHex(1e6, 0, 26), -1);
});

test('hexPath on uniform cost: path length = distance, endpoints included, ties deterministic', () => {
  const r = hexPath(0, 816, () => 1);
  assert.equal(r.cost, 16);
  assert.equal(r.path.length, 17);
  assert.equal(r.path[0], 0);
  assert.equal(r.path[16], 816);
  for (let i = 1; i < r.path.length; i++) assert.equal(hexDist(r.path[i - 1], r.path[i]), 1);
  assert.deepEqual(hexPath(0, 816, () => 1), r);
  assert.deepEqual(hexPath(5, 5, () => 1), { path: [5], cost: 0 });
});

test('hexPath with costs and walls (hand-computed fixtures)', () => {
  // Wall the whole ring 1 except hex 6 (-1,0): going east to hex 3 must detour around through the west.
  const wall = new Set([1, 2, 3, 4, 5]);
  const target = hexIndex(2, 0);
  const r = hexPath(0, target, (i) => (wall.has(i) ? null : 1));
  assert.equal(r.path[1], 6);
  assert.ok(!r.path.some((i) => wall.has(i)));
  assert.equal(r.cost, r.path.length - 1);
  assert.equal(r.cost, 7); // west out through (-1,0), around ring 2 (north or south: 6 hexes), into (2,0)
  // impassable target → null; fully walled → null
  assert.equal(hexPath(0, 3, (i) => (i === 3 ? null : 1)), null);
  assert.equal(hexPath(0, 816, (i) => (i >= 1 && i <= 6 ? null : 1)), null);
  // cost of entering: a cheap garden path (0.5) beats the straight grass route
  const cheap = new Set([1, 7, 8, 9, hexIndex(0, 2)]);
  const g = hexPath(0, hexIndex(0, 2), (i) => (cheap.has(i) ? 0.5 : 1));
  assert.equal(g.cost, 1.5); // (-1,1) → (-1,2) → (0,2) at 0.5 each beats 2 × grass
  // maxCost cuts the search
  assert.equal(hexPath(0, 816, () => 1, 15), null);
  assert.equal(hexPath(0, 816, () => 1, 16).cost, 16);
  // move cost of 1.5 (leaf litter) everywhere
  assert.equal(hexPath(0, hexIndex(3, 0), () => 1.5).cost, 4.5);
});

test('lineHexes: inclusive, contiguous, length dist + 1', () => {
  assert.deepEqual(lineHexes(4, 4), [4]);
  for (const [a, b] of [[0, 816], [7, 600], [hexIndex(-5, 2), hexIndex(4, -3)]]) {
    const l = lineHexes(a, b);
    assert.equal(l[0], a);
    assert.equal(l[l.length - 1], b);
    assert.equal(l.length, hexDist(a, b) + 1);
    for (let i = 1; i < l.length; i++) assert.equal(hexDist(l[i - 1], l[i]), 1);
  }
});

test('colForHex: 20 + 6 × (q + r/2), clamped to 1..38', () => {
  assert.equal(colForHex(0), 20);
  assert.equal(colForHex(3), 26); // (1,0)
  assert.equal(colForHex(6), 14); // (-1,0)
  assert.equal(colForHex(1), 17); // (-1,1): 20 + 6 × -0.5
  assert.equal(colForHex(hexIndex(16, 0)), 38);
  assert.equal(colForHex(hexIndex(-16, 0)), 1);
});
