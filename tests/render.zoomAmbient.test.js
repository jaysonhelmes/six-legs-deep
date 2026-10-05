// C163: the Above view zooms to 2.75× (was 1.6) with exact picking (hexes, sources, trails) at max zoom and finer
// terrain / land caches while zoomed in on 2× screens. C161: ambient life helpers (wind, phases, motion kinds), the
// renderer drawing every animated source / object without invalid numbers, and reduced motion turning it off.
// Headless: fake 2D contexts through render/canvas.js setCanvasFactory. Owner: WP8 (ARCHITECTURE §18 C161, C163).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setCanvasFactory } from '../src/render/canvas.js';
import { createSurfaceRenderer } from '../src/render/surfaceRenderer.js';
import { createSurfaceCamera } from '../src/render/camera.js';
import { hexToPx, pxToHex } from '../src/render/geom.js';
import { AMBIENT_KIND, ambientPhase, windAt, windStrength, drawIconAmbient, drawAmbientExtras } from '../src/render/ambient.js';
import { MAP } from '../src/data/surface.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { createBus } from '../src/core/bus.js';
import { hexIndex } from '../src/core/hex.js';

const bad = [];
const calls = [];
function makeCtx() {
  const target = { globalAlpha: 1, lineWidth: 1, font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000',
    textAlign: 'left', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', lineDashOffset: 0 };
  const grad = { addColorStop() {} };
  const fns = { measureText: (t) => ({ width: String(t).length * 6 }), createLinearGradient: () => grad, createRadialGradient: () => grad,
    createPattern: () => ({}), setLineDash: () => {} };
  return new Proxy(target, {
    get(t, k) {
      if (k in fns) return fns[k];
      if (k in t) return t[k];
      return (...args) => {
        calls.push(k);
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${String(k)}(${args.join(',')})`);
        if ((k === 'arc' && args[2] < 0) || (k === 'ellipse' && (args[2] < 0 || args[3] < 0))) bad.push(`${String(k)} negative radius`);
      };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function makeOffscreen(w, h) {
  const ctx = makeCtx();
  return { canvas: { width: w, height: h, getContext: () => ctx }, ctx };
}
function makeCanvas(w, h) {
  const ctx = makeCtx();
  return {
    width: w, height: h, rect: { left: 0, top: 0, width: w, height: h }, style: {}, parentElement: null,
    getContext: () => ctx,
    getBoundingClientRect() { return { ...this.rect }; },
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
  };
}
const fakeWindow = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
function makeUI(extra = {}) {
  let st = { tool: null, selection: null, hover: null, overlays: {}, layout: 'wide-tall', view: 'split', ghostDemo: null, glow: null, ...extra };
  return { getUI: () => st, setUI: (p) => { st = { ...st, ...p }; }, onUI: () => () => {} };
}
function makeGame(seed = 7) {
  return { s: createState({ seed }), d: createDerived(), bus: createBus(), queue: [],
    actions: { do() { return { ok: true, reason: null }; } } };
}
function frames(r, n = 3, dt = 1 / 60) {
  for (let k = 0; k < n; k++) r.render(dt);
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
});

/** A game with every hex in rings 0–4 revealed, a source at (3, 0) and a trail out to it, and event objects. */
function richGame() {
  const game = makeGame();
  const S = game.s.run.surface;
  for (let i = 0; i < S.revealed.length; i++) S.revealed[i] = 1;
  S.sources.length = 0;
  const types = ['seed_patch', 'flower_patch', 'leaf_plant', 'aphid_colony', 'prey_beetle', 'prey_cricket', 'prey_caterpillar',
    'lycaenid_caterpillar', 'dead_insect', 'termite_mound'];
  const hexes = [hexIndex(3, 0), hexIndex(-3, 0), hexIndex(0, 3), hexIndex(0, -3), hexIndex(3, -3), hexIndex(-3, 3), hexIndex(2, 2),
    hexIndex(-2, -2), hexIndex(4, -1), hexIndex(-4, 1)];
  types.forEach((type, k) => S.sources.push({ uid: 100 + k, type, hex: hexes[k], stock: 50, max: 100, level: 2, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} }));
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0)];
  S.trails.push({ uid: 300, origin: 0, src: 100, path, len: 3, job: 'forager', workers: 5, escorts: 0, S: 40, born: 0, reroutes: [] });
  game.s.run.events.objects.push(
    { uid: 900, kind: 'molehill', hex: hexIndex(1, 2), t: 30, data: {} },
    { uid: 901, kind: 'termite_swarm', hex: hexIndex(-1, -2), t: 30, data: {} },
    { uid: 902, kind: 'myrmecophile', hex: hexIndex(2, -4), t: 30, data: {} },
    { uid: 903, kind: 'phengaris', hex: hexIndex(-2, 4), t: 30, data: {} },
  );
  return game;
}

test('C163: the surface camera zooms to 2.75× and picking stays exact at max zoom', () => {
  assert.equal(MAP.zoomMax, 2.75);
  const cam = createSurfaceCamera();
  cam.setViewport(900, 600);
  cam.setRadius(12);
  for (let k = 0; k < 30; k++) cam.zoomAt(1.4, 450, 300);
  assert.equal(cam.zoom, 2.75);
  const v = cam.view();
  for (const h of [0, 1, 7, 19, 60, 200]) {
    const p = hexToPx(h, v);
    if (p.x < 0 || p.y < 0 || p.x > 900 || p.y > 600) continue;
    assert.equal(pxToHex(p.x, p.y, v), h, 'hex ' + h + ' round-trips at max zoom');
  }
  cam.pan(1e6, 1e6);
  assert.ok(Math.abs(cam.x) < 1e4 && Math.abs(cam.y) < 1e4, 'pan is clamped at max zoom too');
});

test('C163: at max zoom the renderer picks sources, trails and hexes where they are drawn', () => {
  const game = richGame();
  const surf = createSurfaceRenderer(makeCanvas(900, 600), { game, ui: makeUI(), bus: game.bus });
  frames(surf, 2);
  surf.centerOn(hexIndex(2, 0));
  for (let k = 0; k < 30; k++) surf.zoomAt(1.4, 450, 300);
  frames(surf, 2);
  assert.equal(surf.getCamera().zoom, 2.75);
  const sp = surf.hexToScreen(hexIndex(3, 0));
  const t1 = surf.pick(sp.x, sp.y);
  assert.equal(t1 && t1.kind, 'source');
  assert.equal(t1.id, 100);
  // a point on the trail's drawn line between hexes (1, 0) and (2, 0)
  const poly = surf.trailScreenPolyline(300);
  assert.ok(poly.length > 4);
  const mid = poly[Math.floor(poly.length * 0.4)];
  const t2 = surf.pick(mid.x, mid.y);
  assert.equal(t2 && t2.kind, 'trail', 'the lane is hit where it is drawn');
  // an empty hex picks the hex, its centre round-trips through hexAt
  const empty = hexIndex(1, 1);
  const ep = surf.hexToScreen(empty);
  const t3 = surf.pick(ep.x + 2, ep.y - 3);
  assert.equal(t3 && t3.kind, 'hex');
  assert.equal(t3.hex, empty);
  assert.equal(surf.hexAt(ep.x, ep.y), empty);
  assert.deepEqual(bad, []);
  surf.destroy();
});

test('C163: zoomed in on a 2× screen the terrain and land caches switch to the finer resolution, and back when zoomed out', () => {
  fakeWindow.devicePixelRatio = 2;
  try {
    const game = richGame();
    const surf = createSurfaceRenderer(makeCanvas(900, 600), { game, ui: makeUI(), bus: game.bus });
    frames(surf, 2);
    const a0 = surf.getAmbient();
    assert.equal(a0.hiRes, false, 'default zoom: base caches');
    assert.ok(a0.terrainScale <= 2 + 1e-9);
    for (let k = 0; k < 30; k++) surf.zoomAt(1.4, 450, 300);
    frames(surf, 2);
    const a1 = surf.getAmbient();
    assert.equal(a1.hiRes, true);
    assert.ok(a1.terrainScale > a0.terrainScale, `finer terrain cache (${a1.terrainScale} > ${a0.terrainScale})`);
    assert.ok(a1.landScale > a0.terrainScale - 1e-9);
    assert.equal(surf.getWeather().terrainCaches, 1, 'the coarse cache was dropped');
    for (let k = 0; k < 30; k++) surf.zoomAt(0.7, 450, 300);
    frames(surf, 2);
    assert.equal(surf.getAmbient().hiRes, false, 'zoomed out: back to the base caches');
    assert.deepEqual(bad, []);
    surf.destroy();
  } finally {
    fakeWindow.devicePixelRatio = 1;
  }
});

test('C161: wind field and strength, deterministic phases, a motion kind for every animated type', () => {
  for (const t of [0, 1.3, 50, 1234.5]) {
    const w = windAt(100, -40, t);
    assert.ok(w >= -1 && w <= 1, 'wind in [-1, 1]');
  }
  assert.notEqual(windAt(0, 0, 3), windAt(300, 0, 3), 'the wind differs across the map');
  assert.equal(windStrength({}), 1);
  assert.ok(windStrength({ rain: 1 }) > windStrength({ leaves: 1 }));
  assert.ok(windStrength({ leaves: 1 }) > 1);
  assert.ok(windStrength({ snow: 1 }) < 0.2, 'almost still in deep winter');
  assert.equal(ambientPhase(42), ambientPhase(42));
  assert.notEqual(ambientPhase(42), ambientPhase(43));
  for (const u of [0, 1, 99, 1e6]) assert.ok(ambientPhase(u) >= 0 && ambientPhase(u) < 1);
  for (const t of ['seed_patch', 'flower_patch', 'leaf_plant', 'prey_beetle', 'prey_caterpillar', 'lycaenid_caterpillar', 'dead_insect',
    'termite_mound', 'termite_swarm', 'molehill']) assert.ok(AMBIENT_KIND[t], t);
  // drawing: every kind draws its icon exactly once (plain types too) and keeps the context balanced
  const drawn = [];
  const atlas = { drawIcon: (ctx, name) => drawn.push(name) };
  for (const type of [...Object.keys(AMBIENT_KIND), 'crumb_scatter']) {
    calls.length = 0;
    const ctx = makeCtx();
    for (const t of [0, 0.4, 7.7]) {
      drawIconAmbient(ctx, atlas, type, 100, 100, 40, { t, uid: 5, wind: 1.4, wx: 10, wy: 20 });
      drawAmbientExtras(ctx, type, 100, 100, 40, { t, uid: 5 });
    }
    assert.equal(calls.filter((c) => c === 'save').length, calls.filter((c) => c === 'restore').length, type + ': save / restore balanced');
  }
  assert.equal(drawn.length, (Object.keys(AMBIENT_KIND).length + 1) * 3);
  assert.deepEqual(bad, []);
});

test('C161: the Above view animates every source / object type without invalid numbers; reduced motion turns it off', () => {
  const game = richGame();
  const surf = createSurfaceRenderer(makeCanvas(900, 600), { game, ui: makeUI(), bus: game.bus });
  for (let k = 0; k < 120; k++) surf.render(1 / 20);   // 6 s: molehill puffs, fly landings, cricket hops all come round
  const a = surf.getAmbient();
  assert.equal(a.on, true);
  assert.ok(a.wind > 0);
  assert.ok(Number.isFinite(a.passMs) && a.passMs >= 0);
  game.s.meta.settings.reducedMotion = true;
  const t0 = Date.now();
  while (Date.now() - t0 < 1100) { /* reducedMotion is re-read once a second */ }
  frames(surf, 2);
  assert.equal(surf.getAmbient().on, false, 'reduced motion: no ambient life');
  assert.deepEqual(bad, []);
  surf.destroy();
});
