// WP8 pure helpers: largest-remainder allocation, sprite budgets (≤ 160 Below, ≤ 260 Above, hard cap 600), pools,
// BFS fields over the default nest, cameras (zoom 0.6–1.6, nest fit/scroll) and palette colour maths.
// Owner: WP8 (ARCHITECTURE §13.4, §15.3, §16 WP8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  largestRemainder, scaleK, createPool, addSprite, removeSprite, reconcile, allocBelow, allocAbove, belowCounts,
  openMap, bfsField, stepDown, randomNeighbor, createFieldCache, BUDGET,
} from '../src/render/sprites.js';
import { createSurfaceCamera, createNestCamera } from '../src/render/camera.js';
import { toRgb, toHex, mix, shade, rgba, ramp, rivalColor, rivalPatternKind, terrainColor } from '../src/render/palette.js';
import { shownCount } from '../src/render/battle.js';
import { compactInt } from '../src/render/ceremony.js';
import { decodeRle, reasonLabel, chamberName } from '../src/render/nestRenderer.js';
import { hexToPx, pxToHex, cellCenterPx, pxToCell } from '../src/render/geom.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { GRID, CELL } from '../src/data/balance.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('largestRemainder: sums to the total, proportional, deterministic tie-break', () => {
  assert.deepEqual(largestRemainder([1, 1, 1], 10), [4, 3, 3]);
  assert.deepEqual(largestRemainder([0.5, 0.25, 0.25], 4), [2, 1, 1]);
  const w = [123.4, 55.1, 0, 9.9, 300];
  const a = largestRemainder(w, 160);
  assert.equal(sum(a), 160);
  assert.equal(a[2], 0, 'zero weight gets nothing');
  assert.deepEqual(largestRemainder(w, 160), a, 'deterministic');
  // proportional within one unit
  const W = sum(w);
  for (let i = 0; i < w.length; i++) assert.ok(Math.abs(a[i] - (160 * w[i]) / W) < 1);
  assert.deepEqual(largestRemainder([], 5), []);
  assert.deepEqual(largestRemainder([1, 2], 0), [0, 0]);
  assert.deepEqual(largestRemainder([0, 0], 5), [0, 0]);
});

test('largestRemainder: minimums first, scaled down when they exceed the total; caps respected', () => {
  const a = largestRemainder([100, 1, 1], 20, [0, 2, 2]);
  assert.equal(sum(a), 20);
  assert.ok(a[1] >= 2 && a[2] >= 2);
  const b = largestRemainder([5, 5, 5], 4, [2, 2, 2]);
  assert.equal(sum(b), 4);
  assert.ok(b.every((x) => x <= 2));
  const c = largestRemainder([10, 10], 10, null, [3, 100]);
  assert.deepEqual(c, [3, 7]);
  const d = largestRemainder([10, 10], 10, null, [3, 4]);
  assert.deepEqual(d, [3, 4], 'cannot exceed caps even if total is larger');
});

test('scaleK: ceil(N / budget), at least 1', () => {
  assert.equal(scaleK(0, 160), 1);
  assert.equal(scaleK(160, 160), 1);
  assert.equal(scaleK(161, 160), 2);
  assert.equal(scaleK(1e6, 260), Math.ceil(1e6 / 260));
});

test('pools: add/remove/reconcile keep groups without churn', () => {
  const p = createPool(10);
  for (let k = 0; k < 4; k++) {
    const i = addSprite(p);
    p.group[i] = k % 2;
    p.x[i] = k;
  }
  assert.equal(p.n, 4);
  removeSprite(p, 0);
  assert.equal(p.n, 3);
  assert.equal(p.x[0], 3, 'swap-remove moved the last sprite into slot 0');
  const spawned = [];
  reconcile(p, [1, 3], (i, g) => spawned.push(g));
  assert.equal(p.n, 4);
  let g0 = 0;
  let g1 = 0;
  for (let i = 0; i < p.n; i++) (p.group[i] === 0 ? g0++ : g1++);
  assert.equal(g0, 1);
  assert.equal(g1, 3);
  assert.deepEqual(spawned, [1], 'only the missing group-1 sprite is spawned');
  reconcile(p, [20, 20], () => {});
  assert.equal(p.n, 10, 'never exceeds capacity');
  assert.equal(addSprite(p), -1);
});

test('Below allocation: ≤ 160 sprites, never more sprites than ants, by job group', () => {
  const s = createState({ seed: 3 });
  assert.deepEqual(allocBelow(s).alloc, [0, 0, 0, 0, 0, 0], 'no ants, no sprites');
  s.run.colony.adults.minor = 12;
  s.run.colony.jobs = { forager: 5, digger: 3, nurse: 1, scout: 1, herder: 0, leafcutter: 0, gardener: 0 };
  let r = allocBelow(s);
  assert.equal(sum(r.alloc), 11, 'diggers 3 + nurse 1 + haulers 5 + idle 2 (scouts are surface-only)');
  assert.equal(r.K, 1);
  const bc = belowCounts(s);
  assert.equal(bc.counts[5], 2, 'idle = minors − Σ jobs');
  s.run.colony.adults.minor = 1e6;
  s.run.colony.adults.soldier = 5e4;
  s.run.colony.jobs = { forager: 6e5, digger: 2e5, nurse: 5e4, scout: 1e4, herder: 1e4, leafcutter: 1e4, gardener: 2e4 };
  r = allocBelow(s);
  assert.equal(sum(r.alloc), BUDGET.below);
  assert.ok(r.K > 1);
  assert.ok(r.alloc[2] > r.alloc[0], 'haulers (∝ foragers) outnumber diggers');
});

test('Above allocation: ≤ 260, min 2 per active trail, ≥ 3 scouts, escorts/garrison/loose groups', () => {
  const s = createState({ seed: 3 });
  const d = createDerived();
  s.run.colony.adults.minor = 5000;
  s.run.colony.jobs.forager = 4000;
  s.run.colony.jobs.scout = 40;
  s.run.surface.trails.push({ uid: 9, origin: 0, src: 1, path: [0, 1], len: 1, job: 'forager', workers: 0, escorts: 6, S: 10, born: 0, reroutes: [] });
  d.surface.trails = [
    { uid: 2, workers: 3990, sat: 1 },
    { uid: 9, workers: 1, sat: 0.1 },
  ];
  d.combat.garrison = { soldier: 200, supermajor: 0 };
  const a = allocAbove(s, d);
  const total = sum(a.trail) + sum(a.escort) + a.scouts + a.garrison + a.loose;
  assert.ok(total <= BUDGET.above, `total ${total}`);
  assert.equal(a.trail.length, 2);
  assert.ok(a.trail[1] >= 2, 'min 2 sprites on an active trail');
  assert.ok(a.scouts >= 3, 'at least 3 scouts at the frontier');
  assert.ok(a.trail[0] > a.trail[1]);
  assert.ok(a.escort[1] >= 0 && a.escort[1] <= 6);
  assert.ok(a.garrison > 0);
  assert.ok(BUDGET.below + BUDGET.above + 2 * 40 * 2 <= BUDGET.hardCap, 'budgets fit the 600 hard cap');
});

test('Above allocation with an empty derived cache shows loose foragers when no trail exists', () => {
  const s = createState({ seed: 3 });
  s.run.surface.trails = [];
  s.run.colony.adults.minor = 30;
  s.run.colony.jobs.forager = 30;
  const a = allocAbove(s, createDerived());
  assert.equal(a.loose, 30);
});

test('BFS field over the default nest: distances along the shaft, stepDown walks downhill', () => {
  const s = createState();
  const open = openMap(s.run.nest.cells);
  assert.equal(open[GRID.mainCol], 1);
  const top = GRID.mainCol;
  const f = bfsField(open, [top]);
  assert.equal(f[top], 0);
  assert.equal(f[10 * GRID.cols + GRID.mainCol], 10);
  const royal = 21 * GRID.cols + 18;
  assert.ok(f[royal] > 0);
  assert.equal(f[0], -1, 'soil is unreachable');
  let c = royal;
  let guard = 0;
  while (f[c] > 0 && guard++ < 100) {
    const n = stepDown(f, open, c, Math.random());
    assert.equal(f[n], f[c] - 1);
    c = n;
  }
  assert.equal(c, top);
  // a closed start (a dig face) seeds its open neighbours at distance 1
  const face = 20 * GRID.cols + 22; // soil right of the royal chamber
  const g = bfsField(open, [face]);
  assert.equal(g[20 * GRID.cols + 21], 1);
  const n = randomNeighbor(open, 10 * GRID.cols + GRID.mainCol, 0.1);
  assert.ok(n === 9 * GRID.cols + GRID.mainCol || n === 11 * GRID.cols + GRID.mainCol);
  const cache = createFieldCache();
  assert.equal(cache.sync(s.run.nest.cells, 1), true);
  assert.equal(cache.sync(s.run.nest.cells, 1), false);
  const f1 = cache.get('top', () => [top]);
  assert.equal(cache.get('top', () => [0]), f1, 'cached by key');
  s.run.nest.cells[22 * GRID.cols + 20] = CELL.TUNNEL;
  assert.equal(cache.sync(s.run.nest.cells, 2), true, 'rev change refreshes');
  assert.notEqual(cache.get('top', () => [top]), f1);
});

test('surface camera: zoom clamped to 0.6–1.6, zoomAt keeps the cursor point fixed, pan clamps to the map', () => {
  const cam = createSurfaceCamera();
  cam.setViewport(800, 600);
  cam.setRadius(8);
  assert.equal(cam.zoomMin, 0.6);
  assert.equal(cam.zoomMax, 1.6);
  const v0 = cam.view();
  const h = 50;
  const p0 = hexToPx(h, v0);
  cam.zoomAt(1.3, p0.x, p0.y);
  const p1 = hexToPx(h, cam.view());
  assert.ok(Math.abs(p1.x - p0.x) < 1e-6 && Math.abs(p1.y - p0.y) < 1e-6, 'point under the cursor stays put');
  for (let k = 0; k < 20; k++) cam.zoomAt(1.5, 400, 300);
  assert.equal(cam.zoom, 1.6);
  for (let k = 0; k < 20; k++) cam.zoomAt(0.5, 400, 300);
  assert.equal(cam.zoom, 0.6);
  cam.pan(-1e6, -1e6);
  assert.ok(Number.isFinite(cam.x) && Math.abs(cam.x) < 1000, 'pan is clamped to the map extent');
  cam.centerOnHex(0);
  assert.equal(pxToHex(400, 300, cam.view()), 0);
});

test('nest camera: 12 px baseline, never wider than the canvas, scroll clamped, picking stays exact after resize', () => {
  const cam = createNestCamera();
  cam.setViewport(480, 540);
  assert.equal(cam.cell, 12);
  assert.ok(Math.abs(cam.viewRows() - 45) < 1e-9, 'about 45 rows visible at 12 px');
  cam.setViewport(375, 600);
  assert.ok(cam.cell * GRID.cols <= 375 + 1e-9);
  cam.scrollBy(1e9);
  assert.equal(cam.scroll, cam.maxScroll());
  cam.scrollBy(-1e9);
  assert.equal(cam.scroll, 0);
  for (const [w, h] of [[800, 400], [375, 812], [1440, 900]]) {
    cam.setViewport(w, h);
    cam.scrollToRow(15);
    const v = cam.view();
    for (const i of [0, 820, 21 * 40 + 19, 3199]) {
      const c = cellCenterPx(i, v);
      assert.equal(pxToCell(c.x, c.y, v), i);
    }
    assert.ok(Math.abs(cam.topRow() - 15) < 1e-6 || cam.scroll === cam.maxScroll());
  }
});

test('palette colour helpers', () => {
  assert.deepEqual(toRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(toRgb('#fff'), [255, 255, 255]);
  assert.equal(toHex([255, 128, 0]), '#ff8000');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#000000', '#ffffff', 2), '#ffffff');
  assert.equal(shade('#808080', 1), '#ffffff');
  assert.equal(shade('#808080', -1), '#000000');
  assert.equal(rgba('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.equal(ramp(0), '#440154');
  assert.equal(ramp(1), '#fde725');
  assert.ok(/^#[0-9a-f]{6}$/.test(ramp(0.37)));
  assert.notEqual(rivalColor('black_garden_ants'), rivalColor('fire_ants'));
  assert.notEqual(rivalPatternKind('black_garden_ants'), rivalPatternKind('fire_ants'));
  assert.equal(terrainColor('winter', 'nope').length, 2);
});

test('misc render helpers: battle sprite counts, compact labels, RLE decode, reason labels, chamber names', () => {
  assert.equal(shownCount(10, 10), 10);
  assert.equal(shownCount(100, 100), 40);
  assert.equal(shownCount(50, 100), 20);
  assert.equal(shownCount(0.4, 1000), 1, 'a surviving fraction still shows one sprite');
  assert.equal(shownCount(0, 1000), 0);
  assert.equal(compactInt(5), '5');
  assert.equal(compactInt(1.25), '1.3');
  assert.equal(compactInt(1234), '1.23K');
  assert.equal(compactInt(4.5e6), '4.50M');
  assert.deepEqual(decodeRle('rle:0*3,1,2*2'), [0, 0, 0, 1, 2, 2]);
  assert.deepEqual(decodeRle(''), []);
  assert.equal(reasonLabel('blocked:stone'), 'Blocked: stone');
  assert.equal(reasonLabel(null), '');
  assert.equal(typeof chamberName('royal_chamber'), 'string');
  assert.ok(chamberName('fungus_garden').length > 0);
});
