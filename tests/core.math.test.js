// WP1 unit tests: core/math.js (softcap continuity #2, geoCost MAX #1, helpers) and data/balance.js values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sc, scChain, clampNum, geoCost, costOrNull, lvl, safeDiv, sumGeo, lerp, approxEq } from '../src/core/math.js';
import * as B from '../src/data/balance.js';

test('balance.js matches ARCHITECTURE §6.1 exactly', () => {
  assert.equal(B.TICK, 0.1);
  assert.equal(B.COMBAT_STEP, 0.25);
  assert.equal(B.CLAMP_MAX, 1e295);
  assert.equal(B.COST_MAX, 1e280);
  assert.equal(B.CLICK_CAP, 15);
  assert.equal(B.FOOD_OVERFLOW, 2);
  assert.deepEqual(B.GRID, { cols: 40, rows: 80, cellPx: 12, visibleRows: 45, mainCol: 20, shaftRows: 20, royal: { x: 18, y: 20, w: 4, h: 2 } });
  assert.deepEqual(B.CELL, { SOIL: 0, TUNNEL: 1, CHAMBER: 2, STONE: 3, WATER: 4 });
  assert.deepEqual(B.HEX, { maxRadius: 16, count: 817, px: 26 });
  assert.deepEqual(B.SOFTCAPS, {
    food: [[1e24, 0.5], [1e60, 0.25]], dig: [[1e20, 0.5], [1e50, 0.25]], insight: [[1e12, 0.5]],
    honeydew: [[1e16, 0.5]], fungus: [[1e16, 0.5]], chitin: [[1e16, 0.5]], ap: [[1e24, 0.5]],
    alates: [[3e4, 0.5]], kinship: [[1e5, 0.5]], genes: [[1e4, 0.5]] });
  assert.deepEqual(B.OFFLINE, { onlineGapSec: 60, hiddenFullSec: 14400, baseCapSec: 14400, baseEff: 0.5,
    earlyStep: 10, earlyWindow: 600, lateStep: 60, maxSteps: 1500, bankRate: 0.10, bankMaxSec: 28800, findEverySec: 7200, findMax: 3 });
  assert.deepEqual(B.DIAPAUSE, { speed: 2, speedMastery: 3 });
  assert.deepEqual(B.SAVE, { key: 'sld_save', backups: ['sld_save_bak_0', 'sld_save_bak_1', 'sld_save_bak_2'],
    backupEverySec: 300, prefix: 'SLD1:', targetBytes: 61440 });
  assert.deepEqual(B.LOOP, { maxTicksPerFrame: 600, welcomeMinSec: 300 });
  assert.deepEqual(B.GUARD, { fullEveryTicks: 100 });
  assert.ok(Object.isFrozen(B.GRID) && Object.isFrozen(B.GRID.royal) && Object.isFrozen(B.SOFTCAPS.food[0]));
});

test('sc: identity below the threshold, continuous and monotonic across it (#2)', () => {
  assert.equal(sc(5, 10, 0.5), 5);
  assert.equal(sc(10, 10, 0.5), 10);
  assert.equal(sc(40, 10, 0.5), 20);
  for (const [s, p] of [[10, 0.5], [1e24, 0.5], [3e4, 0.5], [1e60, 0.25]]) {
    const eps = s * 1e-9;
    assert.ok(approxEq(sc(s - eps, s, p), sc(s + eps, s, p), 1e-8), 'continuous at ' + s);
    let prev = -Infinity;
    for (let k = 0.5; k <= 4; k += 0.01) {
      const v = sc(s * k, s, p);
      assert.ok(v > prev, 'monotonic at ' + s + ' × ' + k);
      prev = v;
    }
  }
});

test('scChain: every SOFTCAPS chain is continuous and monotonic at each threshold (#2)', () => {
  for (const [name, chain] of Object.entries(B.SOFTCAPS)) {
    for (let i = 0; i < chain.length; i++) {
      // the i-th threshold applies to the value after the earlier softcaps: find the raw x that maps onto it
      let lo = 0, hi = 1e300;
      const target = chain[i][0];
      for (let it = 0; it < 2000; it++) {
        const mid = Math.sqrt(Math.max(lo, 1e-300) * hi);
        if (scChain(mid, chain).value < target) lo = mid; else hi = mid;
      }
      const x = hi;
      const a = scChain(x * (1 - 1e-9), chain).value;
      const b = scChain(x * (1 + 1e-9), chain).value;
      assert.ok(approxEq(a, b, 1e-6), name + ' continuous at threshold ' + i);
      assert.ok(b >= a, name + ' monotonic at threshold ' + i);
    }
    let prev = -Infinity;
    for (let e = 0; e <= 299; e += 0.5) {
      const v = scChain(10 ** e, chain).value;
      assert.ok(v >= prev, name + ' monotonic at 1e' + e);
      prev = v;
    }
  }
});

test('scChain: DESIGN §12.10 example (raw 1e200 food/s → ≈ 1e73), capped flag and sMult on the first threshold', () => {
  const r = scChain(1e200, B.SOFTCAPS.food);
  assert.ok(approxEq(r.value, 1e73, 1e-9));
  assert.equal(r.capped, true);
  assert.deepEqual(scChain(1e20, B.SOFTCAPS.food), { value: 1e20, capped: false });
  // thermal_ceiling: first threshold × 1e6
  assert.deepEqual(scChain(1e28, B.SOFTCAPS.food, 1e6), { value: 1e28, capped: false });
  assert.ok(approxEq(scChain(1e32, B.SOFTCAPS.food, 1e6).value, 1e30 * Math.sqrt(100), 1e-9));
  assert.deepEqual(scChain(7, null), { value: 7, capped: false });
});

test('clampNum: NaN → lo, ±Infinity → bounds, -0 → 0', () => {
  assert.equal(clampNum(NaN), 0);
  assert.equal(clampNum(Infinity), B.CLAMP_MAX);
  assert.equal(clampNum(-Infinity), 0);
  assert.equal(clampNum(-5), 0);
  assert.equal(clampNum(5), 5);
  assert.equal(clampNum(2e295), 1e295);
  assert.ok(Object.is(clampNum(-0), 0));
  assert.equal(clampNum(3, 1, 2), 2);
  assert.equal(clampNum(NaN, 1, 2), 1);
});

test('geoCost: strictly increasing, null (MAX) above 1e280 (#1)', () => {
  const base = { food: 15, chitin: 2 };
  let prev = geoCost(base, 1.7, 0);
  assert.deepEqual(prev, { food: 15, chitin: 2 });
  let L = 1;
  for (;; L++) {
    const c = geoCost(base, 1.7, L);
    if (c === null) break;
    assert.ok(c.food > prev.food && c.chitin > prev.chitin, 'increasing at L=' + L);
    assert.ok(c.food <= B.COST_MAX);
    prev = c;
  }
  assert.ok(15 * 1.7 ** L > B.COST_MAX);
  assert.equal(geoCost(base, 1.7, L + 100), null);
  assert.equal(geoCost(base, 10, 1e6), null); // Infinity
  assert.equal(geoCost(null, 2, 1), null);
  assert.ok(approxEq(geoCost({ food: 10 }, 1.3, 5).food, 10 * 1.3 ** 5));
});

test('costOrNull, lvl, safeDiv, lerp, approxEq', () => {
  assert.deepEqual(costOrNull({ food: 5 }), { food: 5 });
  assert.equal(costOrNull({ food: 2e280 }), null);
  assert.equal(costOrNull({ food: NaN }), null);
  assert.equal(costOrNull(null), null);
  assert.equal(lvl({ a: 3 }, 'a'), 3);
  assert.equal(lvl({ a: 3 }, 'b'), 0);
  assert.equal(lvl(null, 'b'), 0);
  assert.equal(safeDiv(6, 3), 2);
  assert.equal(safeDiv(1, 0), 0);
  assert.equal(safeDiv(1, 0, -1), -1);
  assert.equal(safeDiv(1e300, 1e-300, 7), 7);
  assert.equal(lerp(2, 6, 0.25), 3);
  assert.ok(approxEq(1, 1 + 1e-12));
  assert.ok(!approxEq(1, 1.001));
  assert.ok(approxEq(0, 0));
  assert.ok(approxEq(1, 1.0009, 1e-3));
});

test('sumGeo equals the sum of consecutive geoCost levels; MAX → null', () => {
  const base = { food: 25, soil: 3 };
  const sum = sumGeo(base, 1.9, 4, 5);
  let food = 0, soil = 0;
  for (let L = 4; L < 9; L++) {
    const c = geoCost(base, 1.9, L);
    food += c.food;
    soil += c.soil;
  }
  assert.ok(approxEq(sum.food, food, 1e-12) && approxEq(sum.soil, soil, 1e-12));
  assert.deepEqual(sumGeo(base, 1, 0, 3), { food: 75, soil: 9 });
  assert.deepEqual(sumGeo(base, 2, 0, 0), { food: 0, soil: 0 });
  assert.equal(sumGeo(base, 10, 270, 20), null);
});
