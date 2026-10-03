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
