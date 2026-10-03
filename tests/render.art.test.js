// WP8 Below-view framing and cavity art: the nest camera's default framing (Royal Chamber always in view, sky shown
// when the colony fits), player zoom about a fixed point, horizontal pan only while the grid overflows, and the
// organic chamber outlines / cavity spans / wavy strata used by the strata cache and the sprites.
// Owner: WP8 (ARCHITECTURE §13.3, §13.5, §13.7; DESIGN §7.1, §7.13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNestCamera } from '../src/render/camera.js';
import { cellCenterPx, pxToCell } from '../src/render/geom.js';
import {
  chamberOutline, cavityBox, cavityShape, cavitySpan, tunnelNode, waveY, shortName, SHORT_NAMES,
} from '../src/render/nestArt.js';
import { CHAMBERS } from '../src/data/chambers.js';
import { GRID } from '../src/data/balance.js';

const ROYAL = { x: GRID.royal.x, y: GRID.royal.y, w: GRID.royal.w, h: GRID.royal.h };

/** Is grid cell (x, y) fully inside the view? */
function inView(cam, x, y) {
  const v = cam.view();
  const c = cellCenterPx(y * GRID.cols + x, v);
  return c.x >= 0 && c.x <= cam.w && c.y >= 0 && c.y <= cam.h;
}

test('nest framing keeps the Royal Chamber in view at every reference layout', () => {
  // canvas sizes of the Below view at 1440×900, 1280×720 (side column), 1024×768 split / Below-only, 375×812
  for (const [w, h] of [[808, 346], [332, 564], [984, 263], [984, 592], [327, 515], [600, 300]]) {
    for (const deepest of [22, 29, 60]) {
      const cam = createNestCamera();
      cam.setViewport(w, h);
      cam.frame(ROYAL, deepest);
      for (const [x, y] of [[ROYAL.x, ROYAL.y], [ROYAL.x + ROYAL.w - 1, ROYAL.y + ROYAL.h - 1]]) {
        assert.ok(inView(cam, x, y), `royal cell (${x},${y}) visible at ${w}×${h}, deepest ${deepest}`);
      }
      assert.ok(cam.cell >= Math.min(cam.fit, 13) - 1e-9, `readable cells at ${w}×${h}`);
    }
  }
});

test('nest framing shows the sky when the young colony fits, and fills the width on wide canvases', () => {
  const cam = createNestCamera();
  cam.setViewport(808, 346);
  cam.frame(ROYAL, ROYAL.y + ROYAL.h);
  assert.equal(cam.scroll, 0, 'sky and surface in view');
  assert.ok(cam.topRow() <= -1.99);
  assert.ok(cam.cols * cam.cell <= 808 + 1e-6, 'no horizontal overflow on a wide canvas');
  // a narrow canvas zooms in past its width fit (tappable chambers) and centres the shaft
  const nar = createNestCamera();
  nar.setViewport(327, 515);
  nar.frame(ROYAL, 29);
  assert.ok(nar.overflowX(), 'narrow canvas pans horizontally');
  const shaft = cellCenterPx(10 * GRID.cols + GRID.mainCol, nar.view());
  assert.ok(Math.abs(shaft.x - 327 / 2) < nar.cell, 'the main shaft is centred');
});

test('nest zoom keeps the point under the cursor fixed and stays within its limits; pan clamps to the grid', () => {
  const cam = createNestCamera();
  cam.setViewport(808, 346);
  cam.frame(ROYAL, 29);
  const v0 = cam.view();
  const sx = 300;
  const sy = 200;
  const gx = (sx - v0.ox) / v0.cell;
  const gy = (sy - v0.oy) / v0.cell;
  assert.ok(cam.zoomAt(2.5, sx, sy));
  const v1 = cam.view();
  assert.ok(cam.overflowX(), 'zoomed past the width');
  assert.ok(Math.abs((sx - v1.ox) / v1.cell - gx) < 0.06, 'x fixed (rounded ox)');
  assert.ok(Math.abs((sy - v1.oy) / v1.cell - gy) < 1e-6, 'y fixed');
  for (let k = 0; k < 20; k++) cam.zoomAt(2, sx, sy);
  assert.ok(Math.abs(cam.zoom - cam.zoomMax()) < 1e-9);
  assert.ok(cam.overflowX());
  cam.panBy(-1e6, 0);
  assert.ok(cam.view().ox <= 0.5, 'left edge clamped');
  cam.panBy(1e6, 0);
  assert.ok(cam.view().ox + cam.cols * cam.cell >= cam.w - 0.5, 'right edge clamped');
  for (let k = 0; k < 20; k++) cam.zoomAt(0.5, sx, sy);
  assert.ok(Math.abs(cam.zoom - cam.zoomMin()) < 1e-9);
  assert.ok(cam.contentH() <= cam.h + 1e-6 || cam.cell <= 4 + 1e-9, 'fully zoomed out shows the whole column (or 4 px cells)');
  assert.ok(!cam.overflowX());
  // picking stays exact at any zoom
  for (const z of [0.3, 1, 1.7]) {
    cam.setZoom(z);
    const v = cam.view();
    for (const i of [0, 21 * 40 + 19, 3199]) assert.equal(pxToCell(cellCenterPx(i, v).x, cellCenterPx(i, v).y, v), i);
  }
});

test('chamber outlines stay inside their footprint and leave a wall to the neighbours', () => {
  for (const c of [{ uid: 1, x: 18, y: 20, w: 4, h: 2 }, { uid: 2, x: 21, y: 16, w: 10, h: 4 }, { uid: 3, x: 0, y: 1, w: 2, h: 2 },
    { uid: 4, x: 30, y: 60, w: 5, h: 3 }]) {
    const pts = chamberOutline(c);
    assert.ok(pts.length >= 24 && pts.length % 2 === 0);
    for (let k = 0; k < pts.length; k += 2) {
      assert.ok(Number.isFinite(pts[k]) && Number.isFinite(pts[k + 1]));
      assert.ok(pts[k] > c.x + 0.05 && pts[k] < c.x + c.w - 0.05, `x inside for ${c.uid}`);
      assert.ok(pts[k + 1] > c.y + 0.02 && pts[k + 1] < c.y + c.h - 0.02, `y inside for ${c.uid}`);
    }
    assert.equal(chamberOutline(c), pts, 'cached per footprint');
    const b = cavityBox(c);
    const sh = cavityShape(c);
    assert.ok(sh.rT >= sh.rB && sh.rT + sh.rB <= b.y1 - b.y0 + 1e-9, 'vaulted ceiling, flatter floor');
    // sprites near the ceiling are squeezed inwards, never outside the box
    const top = cavitySpan(sh, b.y0 + 0.05, 0.3);
    const mid = cavitySpan(sh, (b.y0 + b.y1) / 2, 0.3);
    assert.ok(top[0] >= mid[0] - 1e-9 && top[1] <= mid[1] + 1e-9);
    assert.ok(mid[0] >= b.x0 && mid[1] <= b.x1);
  }
});

test('passage nodes, strata waves and short names are deterministic and bounded', () => {
  for (let y = 0; y < 80; y += 7) {
    for (let x = 0; x < 40; x += 3) {
      const n = tunnelNode(x, y);
      assert.deepEqual(tunnelNode(x, y), n);
      assert.ok(Math.abs(n.dx) <= 0.06 && Math.abs(n.dy) <= 0.04 && n.r >= 0.34 && n.r <= 0.4);
    }
  }
  for (const Y of [10, 24, 40, 58, 74]) {
    for (let u = -30; u < 70; u += 0.7) assert.ok(Math.abs(waveY(u, Y) - Y) < 0.47, 'wave stays within one row');
  }
  for (const type of Object.keys(CHAMBERS || {})) {
    const n = shortName(type);
    assert.ok(n.length > 0 && n.length <= 10, `${type} → ${n}`);
  }
  assert.ok(Object.keys(SHORT_NAMES).length >= 16);
  assert.equal(shortName('mystery_room'), 'Mystery');
});
