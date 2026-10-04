// WP8 render/geom.js: cell/hex <-> pixel round-trips at zoom 0.6 / 1 / 1.6, polyline distance, Catmull-Rom endpoints,
// arc-length sampling, rotation index. Owner: WP8 (ARCHITECTURE §15.3, §16 WP8 acceptance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellToPx, cellCenterPx, pxToCell, hexToPx, pxToHex, pxToHexInRadius, worldToScreen, screenToWorld, distToPolyline,
  distToSegment, catmullRom, sampleSpline, polylineLength, arcTable, pointAtArc, rotIndex, hexCorners, hash01, clamp,
} from '../src/render/geom.js';
import { GRID, HEX } from '../src/data/balance.js';
import { countInRadius, hexToPixel, ringOf } from '../src/core/hex.js';

const ZOOMS = [0.6, 1, 1.6];

test('cellToPx / pxToCell round-trip for every cell at several views', () => {
  const views = [
    { ox: 0, oy: 0, cell: 12 },
    { ox: 37.5, oy: -213.25, cell: 9.4 },
    { ox: -10, oy: 24, cell: 17.3 },
  ];
  for (const v of views) {
    for (let i = 0; i < GRID.cols * GRID.rows; i++) {
      const tl = cellToPx(i, v);
      const c = cellCenterPx(i, v);
      assert.equal(pxToCell(c.x, c.y, v), i, `centre of cell ${i}`);
      assert.equal(pxToCell(tl.x + 0.01, tl.y + 0.01, v), i, `top-left of cell ${i}`);
      assert.equal(pxToCell(tl.x + v.cell - 0.01, tl.y + v.cell - 0.01, v), i, `bottom-right of cell ${i}`);
    }
  }
});

test('pxToCell is −1 outside the grid and for non-finite input', () => {
  const v = { ox: 10, oy: 10, cell: 12 };
  assert.equal(pxToCell(5, 50, v), -1);
  assert.equal(pxToCell(50, 5, v), -1);
  assert.equal(pxToCell(10 + 40 * 12 + 1, 50, v), -1);
  assert.equal(pxToCell(50, 10 + 80 * 12 + 1, v), -1);
  assert.equal(pxToCell(NaN, 50, v), -1);
});

test('cellToPx defaults to GRID.cellPx with no view', () => {
  const p = cellToPx(41, undefined);
  assert.deepEqual(p, { x: GRID.cellPx, y: GRID.cellPx });
});

test('hexToPx / pxToHex round-trip for all 817 hexes at zoom 0.6, 1 and 1.6', () => {
  for (const zoom of ZOOMS) {
    for (const cam of [{ x: 0, y: 0, zoom, cx: 400, cy: 300 }, { x: 123.4, y: -77.7, zoom, cx: 187.5, cy: 410 }]) {
      for (let h = 0; h < HEX.count; h++) {
        const p = hexToPx(h, cam);
        assert.equal(pxToHex(p.x, p.y, cam), h, `hex ${h} zoom ${zoom}`);
        // a point well inside the hex (40 % of the inner radius) maps back too
        const r = HEX.px * zoom * 0.4;
        assert.equal(pxToHex(p.x + r, p.y, cam), h);
        assert.equal(pxToHex(p.x, p.y - r, cam), h);
      }
    }
  }
});

test('hexToPx scales distances by the zoom and is centred on (cx, cy)', () => {
  const cam = { x: 0, y: 0, zoom: 1.6, cx: 100, cy: 50 };
  const p0 = hexToPx(0, cam);
  assert.deepEqual(p0, { x: 100, y: 50 });
  const [wx, wy] = hexToPixel(3, HEX.px);
  const p3 = hexToPx(3, cam);
  assert.ok(Math.abs(p3.x - (100 + wx * 1.6)) < 1e-9);
  assert.ok(Math.abs(p3.y - (50 + wy * 1.6)) < 1e-9);
  assert.ok(p3.x > p0.x, 'hex 3 is due east of the entrance');
});

test('worldToScreen and screenToWorld are inverse', () => {
  for (const zoom of ZOOMS) {
    const cam = { x: -40, y: 25, zoom, cx: 300, cy: 200 };
    for (const [wx, wy] of [[0, 0], [123.5, -88], [-400, 300]]) {
      const s = worldToScreen(wx, wy, cam);
      const w = screenToWorld(s.x, s.y, cam);
      assert.ok(Math.abs(w.x - wx) < 1e-9 && Math.abs(w.y - wy) < 1e-9);
    }
  }
});

test('pxToHexInRadius clips to the map radius', () => {
  const cam = { x: 0, y: 0, zoom: 1, cx: 0, cy: 0 };
  const inside = countInRadius(8) - 1; // last hex of ring 8
  const outside = countInRadius(8); // first hex of ring 9
  const a = hexToPx(inside, cam);
  const b = hexToPx(outside, cam);
  assert.equal(pxToHexInRadius(a.x, a.y, cam, 8), inside);
  assert.equal(ringOf(outside), 9);
  assert.equal(pxToHexInRadius(b.x, b.y, cam, 8), -1);
  assert.equal(pxToHex(1e6, 1e6, cam), -1);
});

test('distToPolyline: points on, beside and beyond a polyline', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.equal(distToPolyline(5, 0, pts), 0);
  assert.equal(distToPolyline(5, 3, pts), 3);
  assert.equal(distToPolyline(13, 5, pts), 3);
  assert.equal(distToPolyline(-3, -4, pts), 5);
  assert.equal(distToPolyline(10, 14, pts), 4);
  // [x, y] pairs work as well
  assert.equal(distToPolyline(5, 3, [[0, 0], [10, 0]]), 3);
  assert.equal(distToPolyline(1, 1, []), Infinity);
  assert.equal(distToPolyline(3, 4, [{ x: 0, y: 0 }]), 5);
  assert.equal(distToSegment(0, 5, 0, 0, 0, 0), 5);
});

test('catmullRom passes exactly through its endpoints and its control points', () => {
  const pts = [{ x: 0, y: 0 }, { x: 30, y: 10 }, { x: 60, y: -20 }, { x: 90, y: 5 }];
  assert.deepEqual(catmullRom(pts, 0), { x: 0, y: 0 });
  const end = catmullRom(pts, 1);
  assert.ok(Math.abs(end.x - 90) < 1e-9 && Math.abs(end.y - 5) < 1e-9);
  for (let k = 1; k < pts.length - 1; k++) {
    const p = catmullRom(pts, k / (pts.length - 1));
    assert.ok(Math.abs(p.x - pts[k].x) < 1e-9 && Math.abs(p.y - pts[k].y) < 1e-9, `control point ${k}`);
  }
  // clamped outside [0, 1]
  assert.deepEqual(catmullRom(pts, -1), { x: 0, y: 0 });
  const c = catmullRom(pts, 7);
  assert.ok(Math.abs(c.x - 90) < 1e-9);
  // degenerate inputs
  assert.deepEqual(catmullRom([], 0.5), { x: 0, y: 0 });
  assert.deepEqual(catmullRom([[4, 5]], 0.5), { x: 4, y: 5 });
  // two points: a straight line
  const mid = catmullRom([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.5);
  assert.ok(Math.abs(mid.x - 5) < 1e-9 && Math.abs(mid.y) < 1e-9);
});

test('sampleSpline keeps the endpoints; arc-length lookup is monotonic', () => {
  const pts = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }];
  const sp = sampleSpline(pts, 6);
  assert.equal(sp.length, 13);
  assert.deepEqual(sp[0], { x: 0, y: 0 });
  assert.ok(Math.abs(sp[12].x - 40) < 1e-9 && Math.abs(sp[12].y - 40) < 1e-9);
  const tab = arcTable(sp);
  assert.ok(Math.abs(tab.total - polylineLength(sp)) < 1e-3);
  const out = { x: 0, y: 0, a: 0 };
  let prev = null;
  const step = tab.total / 20;
  for (let k = 0; k <= 20; k++) {
    pointAtArc(tab, k / 20, out);
    assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.a));
    if (prev) {
      // constant speed along the curve: chord ≤ arc step, and not much shorter on this gentle curve
      const chord = Math.hypot(out.x - prev.x, out.y - prev.y);
      assert.ok(chord <= step + 1e-3 && chord > step * 0.8, `sample ${k}: chord ${chord} vs step ${step}`);
    }
    prev = { x: out.x, y: out.y };
  }
  pointAtArc(tab, 0, out);
  assert.deepEqual([out.x, out.y], [0, 0]);
  pointAtArc(tab, 1, out);
  assert.ok(Math.abs(out.x - 40) < 1e-4 && Math.abs(out.y - 40) < 1e-4);
});

test('rotIndex maps headings to 8 atlas rotations', () => {
  assert.equal(rotIndex(0), 0);
  assert.equal(rotIndex(Math.PI / 2), 2);
  assert.equal(rotIndex(Math.PI), 4);
  assert.equal(rotIndex(-Math.PI / 2), 6);
  assert.equal(rotIndex(2 * Math.PI), 0);
  assert.equal(rotIndex(Math.PI / 8 - 0.01), 0);
  assert.equal(rotIndex(Math.PI / 8 + 0.01), 1);
  assert.equal(rotIndex(NaN), 0);
});

test('hexCorners: 6 corners at the given radius; hash noise is deterministic; clamp handles NaN', () => {
  const c = hexCorners(10, 20, 26);
  assert.equal(c.length, 12);
  for (let k = 0; k < 6; k++) assert.ok(Math.abs(Math.hypot(c[2 * k] - 10, c[2 * k + 1] - 20) - 26) < 1e-9);
  assert.equal(hash01(3, 4), hash01(3, 4));
  assert.ok(hash01(3, 4) >= 0 && hash01(3, 4) < 1);
  assert.notEqual(hash01(3, 4), hash01(4, 3));
  assert.equal(clamp(NaN, 0, 1), 0);
  assert.equal(clamp(5, 0, 1), 1);
});

// C128 (player report): a drawn trail must never look as if it crosses a stone hex. Impassable hexes are drawn as
// full hexes, so the smoothed curve (and the worn-earth stroke around it) must keep a margin off their corners.
test('C128: trail curves keep clear of impassable hexes beside the path; the plain spline did not', async () => {
  const { trailCurve, hexSdf, hexWorld } = await import('../src/render/geom.js');
  const { hexIndex, neighbors, DIRS } = await import('../src/core/hex.js');
  const walk = (dirs) => {
    let q = 0;
    let r = 0;
    const p = [hexIndex(0, 0)];
    for (const k of dirs) {
      q += DIRS[k][0];
      r += DIRS[k][1];
      p.push(hexIndex(q, r));
    }
    return p;
  };
  const size = HEX.px;
  const margin = 0.3 * size;
  let naiveHits = 0;
  let cases = 0;
  // every 4-step self-avoiding zig-zag from the centre, with each off-path neighbour in turn as the stone
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++) {
    const path = walk([0, a, b, c]);
    const on = new Set(path);
    if (on.size < path.length) continue;
    const stones = new Set();
    for (const hx of path) for (const nb of neighbors(hx)) if (!on.has(nb)) stones.add(nb);
    for (const stone of stones) {
      cases++;
      const o = hexWorld(stone, size);
      const naive = sampleSpline(path.map((hx) => hexWorld(hx, size)), 24);
      if (naive.some((p) => hexSdf(p.x, p.y, o.x, o.y, size) < margin)) naiveHits++;
      const curve = trailCurve(path, (hx) => hx === stone, { size, perSeg: 24 });
      assert.equal(curve.length, naive.length, 'same sample layout as sampleSpline');
      assert.deepEqual(curve[0], naive[0]);
      assert.ok(Math.hypot(curve.at(-1).x - naive.at(-1).x, curve.at(-1).y - naive.at(-1).y) < 1e-9);
      for (const p of curve) {
        const sd = hexSdf(p.x, p.y, o.x, o.y, size);
        assert.ok(sd >= margin - 1e-6, `path ${path} stone ${stone}: sample ${sd.toFixed(2)} px from the stone hex`);
      }
    }
  }
  assert.ok(cases > 100);
  assert.ok(naiveHits > 0, 'the plain spline does come within the margin of a stone corner (the reported bug)');
  // no obstacles → exactly the plain spline (trails away from stone look as before)
  const path = walk([0, 1, 0, 5]);
  assert.deepEqual(trailCurve(path, () => false, { size, perSeg: 6 }), sampleSpline(path.map((hx) => hexWorld(hx, size)), 6));
});

test('C128: hexSdf is negative inside a hex, ~0 on its corners and edges, positive outside', async () => {
  const { hexSdf } = await import('../src/render/geom.js');
  const c = hexCorners(10, 20, 26);
  assert.ok(hexSdf(10, 20, 10, 20, 26) < 0);
  for (let k = 0; k < 6; k++) assert.ok(Math.abs(hexSdf(c[2 * k], c[2 * k + 1], 10, 20, 26)) < 1e-9);
  assert.ok(Math.abs(hexSdf(10 + 26 * Math.sqrt(3) / 2, 20, 10, 20, 26)) < 1e-9);
  assert.ok(hexSdf(10 + 40, 20, 10, 20, 26) > 0);
});

test('C134 laneLayout: trails sharing hex steps get symmetric parallel lanes ordered by uid; unshared steps stay centred', async () => {
  const { laneLayout, hexWorld } = await import('../src/render/geom.js');
  const { hexIndex } = await import('../src/core/hex.js');
  const size = HEX.px;
  const A = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0)];
  const B = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(2, 1)];
  const L = laneLayout([{ uid: 9, path: B }, { uid: 4, path: A }], { size });
  const a = L.get(4);
  const b = L.get(9);
  assert.equal(a.length, 6);
  const sp = 0.24 * size;
  for (const k of [0, 1]) {
    // perpendicular to the step, half a spacing each side, A (lower uid) and B mirrored
    const p = hexWorld(A[k], size);
    const q = hexWorld(A[k + 1], size);
    const dot = (a[2 * k] * (q.x - p.x) + a[2 * k + 1] * (q.y - p.y));
    assert.ok(Math.abs(dot) < 1e-9, 'perpendicular');
    assert.ok(Math.abs(Math.hypot(a[2 * k], a[2 * k + 1]) - sp / 2) < 1e-9);
    assert.ok(Math.abs(a[2 * k] + b[2 * k]) < 1e-9 && Math.abs(a[2 * k + 1] + b[2 * k + 1]) < 1e-9, 'mirrored');
  }
  assert.deepEqual([a[4], a[5], b[4], b[5]], [0, 0, 0, 0], 'after the split each trail is alone on its step');
  // consistent order along a shared stretch: same side on both shared steps (no crossing)
  const side = (k) => Math.sign(a[2 * k] * -(hexWorld(A[k + 1], size).y - hexWorld(A[k], size).y) * -1 + a[2 * k + 1] * (hexWorld(A[k + 1], size).x - hexWorld(A[k], size).x));
  assert.equal(side(0), side(1));
  // a trail walking the same steps the other way still gets its own lane (offsets differ, sum to zero)
  const C = A.slice().reverse();
  const L2 = laneLayout([{ uid: 4, path: A }, { uid: 5, path: C }], { size });
  const c = L2.get(5);
  const a2 = L2.get(4);
  // C's step k is A's step 2 − k
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(a2[2 * k] + c[2 * (2 - k)]) < 1e-9 && Math.abs(a2[2 * k + 1] + c[2 * (2 - k) + 1]) < 1e-9);
    assert.ok(Math.hypot(a2[2 * k], a2[2 * k + 1]) > 0);
  }
  // many trails on one step: the bundle stays within 0.6 × size, ordered by uid
  const many = [];
  for (let u = 1; u <= 8; u++) many.push({ uid: u, path: A });
  const L3 = laneLayout(many, { size });
  const xs = many.map((t) => L3.get(t.uid)[1]);   // step 0 runs along +x, so lanes differ in y
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 0.6 * size) < 1e-9);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.sign(xs[i] - xs[i - 1]) === Math.sign(xs[1] - xs[0]), 'monotone by uid');
});

test('C134 laneCurve: full lane mid-segment, smooth merge to the shared centre at entrance and source; base when alone', async () => {
  const { laneLayout, laneCurve, trailCurve, hexWorld } = await import('../src/render/geom.js');
  const { hexIndex } = await import('../src/core/hex.js');
  const size = HEX.px;
  const per = 6;
  const A = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), hexIndex(4, 0)];
  const B = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(2, 1), hexIndex(2, 2)];
  const L = laneLayout([{ uid: 1, path: A }, { uid: 2, path: B }], { size });
  const baseA = trailCurve(A, null, { size, perSeg: per });
  const lane = laneCurve(baseA, A, L.get(1), { size, perSeg: per });
  assert.equal(lane.length, baseA.length);
  assert.deepEqual(lane[0], baseA[0], 'starts on the entrance centre');
  assert.ok(Math.hypot(lane.at(-1).x - baseA.at(-1).x, lane.at(-1).y - baseA.at(-1).y) < 1e-9, 'ends on the source centre');
  const mid0 = per / 2;   // middle of shared step 0
  assert.ok(Math.abs(Math.hypot(lane[mid0].x - baseA[mid0].x, lane[mid0].y - baseA[mid0].y) - 0.12 * size) < 1e-9);
  // smooth: no jump between consecutive samples larger than a plain step plus a little
  for (let i = 1; i < lane.length; i++) {
    const dl = Math.hypot(lane[i].x - lane[i - 1].x, lane[i].y - lane[i - 1].y);
    const db = Math.hypot(baseA[i].x - baseA[i - 1].x, baseA[i].y - baseA[i - 1].y);
    assert.ok(dl < db + 0.1 * size, 'sample ' + i);
  }
  // past the split (step 3, alone) the lane is back on the centre line
  for (let j = 3 * per + 1; j <= 4 * per; j++) assert.ok(Math.hypot(lane[j].x - baseA[j].x, lane[j].y - baseA[j].y) < 1e-9);
  // the two lanes really are apart on the shared stretch
  const laneB = laneCurve(trailCurve(B, null, { size, perSeg: per }), B, L.get(2), { size, perSeg: per });
  const gap = Math.hypot(lane[mid0].x - laneB[mid0].x, lane[mid0].y - laneB[mid0].y);
  assert.ok(Math.abs(gap - 0.24 * size) < 1e-6, 'one lane spacing apart on the first shared step: ' + gap);
  // a trail with nobody beside it is returned untouched
  const solo = laneLayout([{ uid: 1, path: A }], { size });
  assert.equal(laneCurve(baseA, A, solo.get(1), { size, perSeg: per }), baseA);
});

test('C134 + C128: lanes give way near stone, never closer to a stone hex than the margin (or than the centre line)', async () => {
  const { laneLayout, laneCurve, trailCurve, pathObstacles, hexSdf, hexWorld } = await import('../src/render/geom.js');
  const { hexIndex, neighbors, DIRS } = await import('../src/core/hex.js');
  const size = HEX.px;
  const per = 6;
  const margin = 0.18 * size;
  const walk = (dirs) => {
    let q = 0;
    let r = 0;
    const p = [hexIndex(0, 0)];
    for (const k of dirs) {
      q += DIRS[k][0];
      r += DIRS[k][1];
      p.push(hexIndex(q, r));
    }
    return p;
  };
  let cases = 0;
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
    const path = walk([0, a, b]);
    const on = new Set(path);
    if (on.size < path.length) continue;
    const L = laneLayout([{ uid: 1, path }, { uid: 2, path }, { uid: 3, path }], { size });
    const stones = new Set();
    for (const hx of path) for (const nb of neighbors(hx)) if (!on.has(nb)) stones.add(nb);
    for (const stone of stones) {
      const blocked = (hx) => hx === stone;
      const base = trailCurve(path, blocked, { size, perSeg: per });
      const obstacles = pathObstacles(path, blocked, size);
      const o = hexWorld(stone, size);
      for (const uid of [1, 3]) {
        const lane = laneCurve(base, path, L.get(uid), { size, perSeg: per, obstacles });
        for (let i = 0; i < lane.length; i++) {
          const sd = hexSdf(lane[i].x, lane[i].y, o.x, o.y, size);
          const sb = hexSdf(base[i].x, base[i].y, o.x, o.y, size);
          assert.ok(sd >= Math.min(margin, sb) - 1e-6, `path ${path} stone ${stone} uid ${uid} sample ${i}: ${sd.toFixed(2)}`);
        }
        cases++;
      }
    }
  }
  assert.ok(cases > 50);
});
