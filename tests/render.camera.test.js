// WP8 camera behaviour after ceremonies and run starts (F20), the public locate API (centerOnCell / ping) and the
// Above view's satellite placement tint and initial framing on small canvases. Headless: a fake 2D context injected
// through render/canvas.js setCanvasFactory. Owner: WP8 (ARCHITECTURE §13.3, §13.5, §13.7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setCanvasFactory } from '../src/render/canvas.js';
import { createNestRenderer } from '../src/render/nestRenderer.js';
import { createSurfaceRenderer } from '../src/render/surfaceRenderer.js';
import { playCeremony, endCeremony } from '../src/render/ceremony.js';
import { drawPing } from '../src/render/overlays.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { createBus } from '../src/core/bus.js';
import { GRID } from '../src/data/balance.js';
import { attachSurfaceInput } from '../src/render/surfaceInput.js';
import { ringOf, countInRadius, HEX_COUNT } from '../src/core/hex.js';

const COLS = GRID.cols;

// ---------------------------------------------------------------------------------------------------------------
// fakes (a permissive 2D context that records invalid numbers)
// ---------------------------------------------------------------------------------------------------------------

const bad = [];
function makeCtx() {
  const target = { globalAlpha: 1, lineWidth: 1, font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000',
    textAlign: 'left', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', lineDashOffset: 0 };
  const grad = { addColorStop() {} };
  const fns = {
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    setLineDash: () => {},
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in fns) return fns[k];
      if (k in t) return t[k];
      return (...args) => {
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${String(k)}(${args.join(',')})`);
        if ((k === 'arc' && args[2] < 0) || (k === 'ellipse' && (args[2] < 0 || args[3] < 0))) bad.push(`${String(k)} negative radius`);
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}
function makeOffscreen(w, h) {
  const ctx = makeCtx();
  return { canvas: { width: w, height: h, getContext: () => ctx }, ctx };
}
function makeCanvas(w, h) {
  const ctx = makeCtx();
  const listeners = {};
  return {
    width: w, height: h, rect: { left: 0, top: 0, width: w, height: h }, style: {}, parentElement: null,
    getContext: () => ctx,
    getBoundingClientRect() { return { ...this.rect }; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    setPointerCapture() {},
    releasePointerCapture() {},
    fire(type, e) { for (const fn of listeners[type] || []) fn(e); },
  };
}
const winListeners = {};
const fakeWindow = {
  devicePixelRatio: 1,
  addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
  removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn); },
};
function makeUI(extra = {}) {
  let st = { tool: null, selection: null, hover: null, overlays: {}, layout: 'wide-tall', view: 'split', ghostDemo: null, glow: null, ...extra };
  return { getUI: () => st, setUI: (p) => { st = { ...st, ...p }; }, onUI: () => () => {} };
}
function makeGame(seed = 7) {
  const calls = [];
  return { s: createState({ seed }), d: createDerived(), bus: createBus(), queue: [], calls,
    actions: { do(type, args) { calls.push({ type, args }); return { ok: true, reason: null }; } } };
}
/** Longer than the camera glide (nestRenderer GLIDE_SEC 0.45 s). */
const GLIDE_WAIT = 560;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function frames(rs, n = 3, dt = 1 / 60) {
  for (let k = 0; k < n; k++) for (const r of rs) r.render(dt);
}
function cellPt(r, i) {
  const v = r.getView();
  return { x: v.ox + ((i % COLS) + 0.5) * v.cell, y: v.oy + (Math.floor(i / COLS) + 0.5) * v.cell };
}
/** The queen's cell (Royal Chamber centre) is on screen. */
function queenInView(r, w, h) {
  const q = cellPt(r, (GRID.royal.y + 1) * COLS + GRID.royal.x + 1);
  return q.x >= 0 && q.x <= w && q.y >= 0 && q.y <= h;
}

let savedWindow;
before(() => {
  setCanvasFactory(makeOffscreen);
  savedWindow = globalThis.window;
  globalThis.window = fakeWindow;
});
after(() => {
  setCanvasFactory(null);
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
  endCeremony();
});

// ---------------------------------------------------------------------------------------------------------------
// F20: re-frame on the Royal Chamber after a ceremony and at run start
// ---------------------------------------------------------------------------------------------------------------

test('F20: after the Speciation ceremony the nest view re-frames on the new Royal Chamber (real event order)', async () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(1000, 420);
  let nest = null;
  let p = null;
  // the UI mounts before the renderers (main.js), so its ceremony trigger runs first on each event
  game.bus.on('speciationComplete', () => { p = playCeremony('speciation', { nest, summary: { genes: 6 } }); });
  nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  frames([nest]);
  assert.ok(queenInView(nest, 1000, 420), 'default framing shows the queen');
  // prestige.doSpeciation: startRun emits runStarted, then speciationComplete
  game.bus.emit('runStarted', { index: 0 });
  game.bus.emit('speciationComplete', { genes: 6 });
  frames([nest]);
  assert.ok(nest.getView().topRow > 40, 'during the ceremony the view shows the Strata band');
  endCeremony();
  await p;
  frames([nest]);
  assert.ok(nest.getView().topRow > 30, 'the camera glides back rather than jumping');
  await sleep(GLIDE_WAIT);
  frames([nest]);
  assert.ok(queenInView(nest, 1000, 420), `after the ceremony the Royal Chamber is back in view (topRow ${nest.getView().topRow.toFixed(1)})`);
  nest.destroy();
});

test('F20: the welcome-back time-lapse also hands the view back (instantly with reduced motion)', async () => {
  const game = makeGame();
  game.s.meta.settings.reducedMotion = true;
  const ui = makeUI();
  const nc = makeCanvas(900, 400);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  frames([nest]);
  const p = playCeremony('timelapse', { nest, summary: { seconds: 3600, cells: [46 * COLS + 10, 46 * COLS + 11], chambers: [] } });
  frames([nest]);
  assert.ok(!queenInView(nest, 900, 400), 'the time-lapse shows the dug cells deep down');
  endCeremony();
  await p;
  frames([nest]);
  assert.ok(queenInView(nest, 900, 400), 'reduced motion: back on the Royal Chamber at once');
  nest.destroy();
});

test('F20: a player who moves the camera during a ceremony keeps their view; a run start re-frames', async () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(900, 400);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  frames([nest]);
  const p = playCeremony('speciation', { nest, summary: {} });
  frames([nest]);
  nest.scrollBy(-60);
  const top = nest.getView().topRow;
  endCeremony();
  await p;
  await sleep(GLIDE_WAIT);
  frames([nest]);
  assert.ok(Math.abs(nest.getView().topRow - top) < 1e-6, 'the player scrolled during the ceremony: no re-frame');
  // a new run always re-frames, whatever the player did before
  nest.scrollBy(400);
  assert.ok(!queenInView(nest, 900, 400));
  game.bus.emit('runStarted', { index: 1 });
  frames([nest]);
  assert.ok(queenInView(nest, 900, 400), 'runStarted brings the Royal Chamber back');
  nest.destroy();
});

// ---------------------------------------------------------------------------------------------------------------
// Locate API (§13.3): nest.centerOnCell, nest.ping, surface.ping
// ---------------------------------------------------------------------------------------------------------------

/** Screen position of cell i relative to the view centre (0, 0 = centred). */
function offCentre(nest, i, w, h) {
  const p = cellPt(nest, i);
  return { dx: p.x - w / 2, dy: p.y - h / 2 };
}

test('nest.centerOnCell glides the cell to the view centre, zooms in when cells are tiny, and survives a resize', async () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(1000, 420);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  frames([nest]);
  assert.equal(typeof nest.centerOnCell, 'function');
  assert.equal(nest.centerOnCell(-1), false);
  assert.equal(nest.centerOnCell(80 * COLS), false);
  assert.equal(nest.centerOnCell(1.5), false);
  const target = 62 * COLS + 7;
  assert.ok(Math.abs(offCentre(nest, target, 1000, 420).dy) > 100, 'the target starts far off centre');
  assert.equal(nest.centerOnCell(target), true);
  frames([nest]);
  const mid = offCentre(nest, target, 1000, 420);
  assert.ok(Math.abs(mid.dy) > 20, 'it glides rather than jumping');
  await sleep(GLIDE_WAIT);
  frames([nest]);
  const end = offCentre(nest, target, 1000, 420);
  const v = nest.getView();
  assert.ok(Math.abs(end.dy) <= v.cell, `centred vertically (dy ${end.dy.toFixed(1)})`);
  assert.ok(v.cell >= 13 - 1e-6, 'cells at least the framing size');
  assert.equal(game.calls.length, 0, 'locate dispatches no game action');
  // zoomed far out, centerOnCell zooms back in so the spot is readable
  nest.zoomAt(0.2, 500, 210);
  assert.ok(nest.getView().cell < 13);
  game.s.meta.settings.reducedMotion = true;
  nest.centerOnCell(45 * COLS + 30);
  frames([nest]);
  const v2 = nest.getView();
  assert.ok(v2.cell >= 13 - 1e-6, `zoomed in to ${v2.cell.toFixed(1)} px`);
  const c2 = offCentre(nest, 45 * COLS + 30, 1000, 420);
  assert.ok(Math.abs(c2.dy) <= v2.cell && c2.dx >= -v2.cell * 0.6 && c2.dx <= 1000, 'reduced motion: there at once');
  // the view is switched in a moment later (hidden canvas → real size): the goal is re-applied at the new size
  nc.rect = { left: 0, top: 0, width: 375, height: 560 };
  for (const fn of winListeners.resize || []) fn();
  frames([nest]);
  const c3 = offCentre(nest, 45 * COLS + 30, 375, 560);
  const v3 = nest.getView();
  // vertically centred; horizontally as close as the grid edge allows (column 30 of 40 on a 375 px canvas)
  assert.ok(Math.abs(c3.dy) <= v3.cell, `still centred after the resize (dy ${c3.dy.toFixed(1)})`);
  assert.ok(c3.dx >= 0 && c3.dx < 375 / 2 - v3.cell, `in view, right of centre only by the grid edge (dx ${c3.dx.toFixed(1)})`);
  assert.ok(v3.ox + COLS * v3.cell <= 375 + 1, 'scrolled to the grid edge');
  // player input cancels a glide in progress
  game.s.meta.settings.reducedMotion = false;
  nest.centerOnCell(5 * COLS + 5);
  nest.scrollBy(200);
  const t0 = nest.getView().topRow;
  await sleep(GLIDE_WAIT);
  frames([nest]);
  assert.ok(Math.abs(nest.getView().topRow - t0) < 1e-6, 'scrolling cancels the glide');
  nest.destroy();
});

test('nest.scrollToRow is kept through the resize that follows a view switch (UI locate on narrow layouts)', () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(600, 300);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  frames([nest]);
  nest.scrollToRow(50);
  nc.rect = { left: 0, top: 0, width: 375, height: 260 };
  for (const fn of winListeners.resize || []) fn();
  frames([nest]);
  const v = nest.getView();
  // row 50 at the top as far as the scroll allows (the bottom of the grid is reached at row ≈ 48 here)
  assert.ok(v.topRow > 45 && v.topRow <= 50 + 1e-6, `row 50 still at the top (topRow ${v.topRow.toFixed(1)}, ${v.viewRows.toFixed(1)} rows)`);
  nest.destroy();
});

test('nest.ping and surface.ping draw a ring for ~1.5 s and then stop; invalid targets are refused', async () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(800, 400);
  const sc = makeCanvas(800, 400);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  const surf = createSurfaceRenderer(sc, { game, ui, bus: game.bus });
  frames([nest, surf]);
  assert.equal(typeof nest.ping, 'function');
  assert.equal(typeof surf.ping, 'function');
  assert.equal(nest.ping(-3), false);
  assert.equal(surf.ping(99999), false);
  assert.equal(surf.ping(-1), false);
  assert.equal(nest.ping(21 * COLS + 19), true);
  assert.equal(surf.ping(3), true);
  assert.equal(nest.pingCount(), 1, 'one live nest ping');
  assert.equal(surf.pingCount(), 1, 'one live surface ping');
  frames([nest, surf], 5);
  assert.equal(nest.pingCount(), 1);
  await sleep(1600);
  frames([nest, surf], 2);
  assert.equal(nest.pingCount(), 0, 'the nest ping expired after ~1.5 s');
  assert.equal(surf.pingCount(), 0, 'the surface ping expired after ~1.5 s');
  assert.deepEqual(bad, [], 'no invalid canvas calls');
  nest.destroy();
  surf.destroy();
});

test('drawPing: expanding rings while running, nothing after the end; reduced motion keeps the radius steady', () => {
  const arcs = [];
  const ctx = new Proxy({}, {
    get: (t, k) => (k === 'arc' ? (x, y, r) => arcs.push(r) : k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const radii = (u, reduced) => {
    arcs.length = 0;
    drawPing(ctx, 100, 100, u, { r0: 8, r1: 40, reduced });
    return arcs.slice();
  };
  const early = radii(0.1, false);
  const later = radii(0.5, false);
  assert.ok(early.length > 0 && later.length > 0, 'rings drawn while running');
  assert.ok(Math.max(...later) > Math.max(...early), 'the rings expand');
  assert.ok(later.every((r) => r >= 0 && r <= 40 + 1e-6), 'within r1');
  assert.equal(radii(1.2, false).length, 0, 'nothing once the ping has ended');
  const r1 = radii(0.1, true);
  const r2 = radii(0.6, true);
  assert.ok(r1.length > 0);
  assert.deepEqual(r1, r2, 'reduced motion: the same rings, no expansion');
});

// ---------------------------------------------------------------------------------------------------------------
// Above view: default framing on small canvases (intro), satellite placement tint
// ---------------------------------------------------------------------------------------------------------------

/** True when every hex of rings 0..k is drawn inside the canvas. */
function ringsInView(surf, k, w, h) {
  for (let i = 0; i < countInRadius(k); i++) {
    const p = surf.hexToScreen(i);
    if (!(p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h)) return false;
  }
  return true;
}

test('Above default framing: phone and tablet canvases start on the nest area at a comfortable zoom', () => {
  for (const [w, h, lo, hi] of [[341, 612, 1, 1.12], [998, 632, 1.2, 1.36], [700, 620, 1, 1], [1100, 560, 1.2, 1.36]]) {
    const game = makeGame();
    const surf = createSurfaceRenderer(makeCanvas(w, h), { game, ui: makeUI(), bus: game.bus });
    frames([surf], 2);
    const cam = surf.getCamera();
    assert.ok(cam.zoom >= lo - 1e-6 && cam.zoom <= hi + 1e-6, `zoom ${cam.zoom.toFixed(2)} at ${w}×${h} (want ${lo}–${hi})`);
    const c = surf.hexToScreen(0);
    assert.ok(Math.abs(c.x - w / 2) < 1 && Math.abs(c.y - h / 2) < 1, 'the nest is centred');
    assert.ok(ringsInView(surf, 2, w, h), `the start reveal (rings 0–2) is in view at ${w}×${h}`);
    surf.destroy();
  }
});

test('Above default framing follows layout changes until the player zooms; a new run re-applies it', () => {
  const game = makeGame();
  const sc = makeCanvas(1200, 900); // e.g. measured before the narrow layout settled
  const surf = createSurfaceRenderer(sc, { game, ui: makeUI(), bus: game.bus });
  frames([surf], 2);
  sc.rect = { left: 0, top: 0, width: 341, height: 612 };
  for (const fn of winListeners.resize || []) fn();
  frames([surf], 2);
  assert.ok(surf.getCamera().zoom >= 1 - 1e-6, 'the real (phone) size gets the phone framing');
  surf.zoomAt(1.3, 170, 300);
  const z = surf.getCamera().zoom;
  sc.rect = { left: 0, top: 0, width: 360, height: 640 };
  for (const fn of winListeners.resize || []) fn();
  frames([surf], 2);
  assert.ok(Math.abs(surf.getCamera().zoom - z) < 1e-9, 'the player zoom is kept through a layout change');
  surf.panBy(120, 40);
  game.bus.emit('runStarted', { index: 1 });
  frames([surf], 2);
  const c = surf.hexToScreen(0);
  assert.ok(Math.abs(c.x - 180) < 1 && Math.abs(c.y - 320) < 1, 'a new run centres the new map on the nest');
  surf.destroy();
});

/** A game with Satellite Nest at `level` and owned rings 0..4 (derived territory filled in by hand). */
function satelliteGame(level = 1) {
  const game = makeGame();
  game.s.era.federation.satellite_nest = level;
  const owned = new Uint8Array(HEX_COUNT);
  const passable = new Uint8Array(HEX_COUNT).fill(1);
  for (let i = 0; i < countInRadius(4); i++) owned[i] = 1;
  game.d.surface.owned = owned;
  game.d.surface.passable = passable;
  game.d.surface.ownedCount = countInRadius(4);
  game.d.surface.rev = 1;
  return { game, owned, passable };
}

/** First hex of ring k with no source on it (so a click hits the hex). */
function hexInRing(game, k) {
  for (let i = 0; i < HEX_COUNT; i++) {
    if (ringOf(i) === k && !game.s.run.surface.sources.some((x) => x && x.hex === i)) return i;
  }
  return -1;
}

test('F15 render side: the satellite tool knows which hexes are valid and why the rest are not (placeSatellite rules)', () => {
  const { game, passable } = satelliteGame(1);
  const ui = makeUI({ tool: { kind: 'placeSatellite' } });
  const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
  frames([surf], 2);
  assert.equal(surf.satelliteAt(0), 'blocked:entrance', 'the main entrance hex');
  assert.equal(surf.satelliteAt(hexInRing(game, 2)), 'blocked:entrance', 'ring 2: closer than 3 hexes to the entrance');
  const r3 = hexInRing(game, 3);
  assert.equal(surf.satelliteAt(r3), null, 'ring 3 of your own land: a valid site');
  assert.equal(surf.satelliteAt(hexInRing(game, 4)), null);
  assert.equal(surf.satelliteAt(hexInRing(game, 6)), 'blocked:unowned', 'outside your territory');
  passable[r3] = 0;
  assert.equal(surf.satelliteAt(r3), 'blocked:terrain', 'impassable ground (the cache follows d.surface.passable)');
  passable[r3] = 1;
  // a placed satellite uses the only level; with a second level its entrance counts for the distance rule
  game.s.run.surface.entrances.push({ kind: 'satellite', hex: r3, col: 4, ref: 0 });
  assert.equal(surf.satelliteAt(hexInRing(game, 4)), 'max', 'every Satellite Nest level is used');
  game.s.era.federation.satellite_nest = 2;
  assert.equal(surf.satelliteAt(r3), 'blocked:entrance', 'too close to the satellite entrance itself');
  game.s.era.federation.satellite_nest = 0;
  game.s.run.surface.entrances.pop();
  assert.equal(surf.satelliteAt(r3), 'locked', 'no Satellite Nest yet');
  // drawing the tool (tint, hover label, hint) makes no invalid canvas calls
  game.s.era.federation.satellite_nest = 1;
  surf.input.hoverHex = r3;
  frames([surf], 2);
  surf.input.hoverHex = 0;
  frames([surf], 2);
  assert.deepEqual(bad, []);
  surf.destroy();
});

test('F15 render side: with no free shaft column every hex is refused', () => {
  const { game } = satelliteGame(1);
  // shafts every 4 columns leave no column 4+ away from all of them
  for (let c = 0; c < COLS; c += 4) game.s.run.nest.shafts.push({ kind: 'satellite', col: c, open: false, ref: 9 });
  const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui: makeUI({ tool: { kind: 'placeSatellite' } }), bus: game.bus });
  frames([surf], 2);
  assert.equal(surf.satelliteAt(hexInRing(game, 3)), 'blocked:shaft');
  surf.destroy();
});

test('F15 render side: an invalid hex is refused on the spot with its reason; a valid one opens the column chooser', () => {
  const { game } = satelliteGame(1);
  const ui = makeUI({ tool: { kind: 'placeSatellite' } });
  const sc = makeCanvas(800, 600);
  const surf = createSurfaceRenderer(sc, { game, ui, bus: game.bus });
  frames([surf], 2);
  const rec = [];
  const bridge = {};
  for (const k of ['hover', 'select', 'openTab', 'openChooser', 'contextMenu', 'reject', 'toast']) bridge[k] = (...a) => rec.push([k, ...a]);
  const detach = attachSurfaceInput(sc, surf, { game, ui, bridge });
  const tap = (hex) => {
    const p = surf.hexToScreen(hex);
    const e = { clientX: p.x, clientY: p.y, button: 0, pointerId: 1, pointerType: 'mouse', preventDefault() {} };
    sc.fire('pointerdown', e);
    sc.fire('pointerup', e);
  };
  tap(hexInRing(game, 2));
  assert.deepEqual(rec.filter((r) => r[0] === 'reject').map((r) => r[1]), ['blocked:entrance'], 'refused with the reason');
  assert.equal(rec.filter((r) => r[0] === 'openChooser').length, 0, 'no column chooser for an invalid hex');
  assert.equal(ui.getUI().tool && ui.getUI().tool.kind, 'placeSatellite', 'the tool stays active for another try');
  const ok3 = hexInRing(game, 3);
  tap(ok3);
  const open = rec.filter((r) => r[0] === 'openChooser');
  assert.equal(open.length, 1);
  assert.equal(open[0][1], 'satelliteColumn');
  assert.equal(open[0][2].hex, ok3);
  assert.equal(ui.getUI().tool, null, 'the tool completes');
  assert.equal(game.calls.length, 0, 'the tool itself dispatches no game action');
  detach();
  surf.destroy();
});

test('a hidden canvas (0 × 0 while display: none) keeps its last size instead of growing on every resize', () => {
  const game = makeGame();
  fakeWindow.devicePixelRatio = 2;
  const nc = makeCanvas(300, 400);
  const nest = createNestRenderer(nc, { game, ui: makeUI(), bus: game.bus });
  frames([nest]);
  assert.equal(nc.width, 600);
  nc.rect = { left: 0, top: 0, width: 0, height: 0 };
  for (let k = 0; k < 3; k++) for (const fn of winListeners.resize || []) fn();
  frames([nest]);
  assert.equal(nc.width, 600, 'backing store unchanged while hidden');
  assert.equal(nc.height, 800);
  const v = nest.getView();
  assert.equal(v.W, 300, 'the camera keeps the real CSS size');
  assert.equal(v.H, 400);
  nc.rect = { left: 0, top: 0, width: 320, height: 420 };
  for (const fn of winListeners.resize || []) fn();
  frames([nest]);
  assert.equal(nest.getView().W, 320, 'shown again: the new size is measured');
  fakeWindow.devicePixelRatio = 1;
  nest.destroy();
});
