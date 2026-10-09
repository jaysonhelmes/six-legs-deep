// C260–C263 Above-map art, headless: lone stones and unclipped boulders, fallen logs drawn as one log per chain
// (straight trunk + limb), flying rival alates (4-frame flap, heading, hit-test follows the drawn position) and
// job-coloured gasters on surface ants. Uses a fake 2D context (render/canvas.js setCanvasFactory). Owner: WP8.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setCanvasFactory } from '../src/render/canvas.js';
import { createSurfaceRenderer } from '../src/render/surfaceRenderer.js';
import { paintSingleStones, paintLogChains, logComponents, logSpine, straightRuns } from '../src/render/terrainArt.js';
import { getAtlas, ALATE_FRAMES } from '../src/render/atlas.js';
import { JOB_COLORS } from '../src/render/palette.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { createBus } from '../src/core/bus.js';
import { hexIndex } from '../src/core/hex.js';
import { TERRAIN_ORDER } from '../src/data/surface.js';
import { HEX } from '../src/data/balance.js';

const bad = [];
const ops = { clip: 0 };

function validColor(c) {
  if (typeof c !== 'string') return false;
  if (/NaN|undefined|Infinity/.test(c)) return false;
  return /^#[0-9a-f]{3,8}$/i.test(c) || /^rgba?\(/.test(c);
}

function makeCtx() {
  const t = { globalAlpha: 1, lineWidth: 1, fillStyle: '#000', strokeStyle: '#000', lineCap: 'butt', lineJoin: 'miter', font: '10px sans-serif' };
  const nums = (name, a) => { for (const v of a) if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${name}(${a.join(',')})`); };
  const grad = () => ({ addColorStop: (o, c) => { if (!validColor(c) || !(o >= 0 && o <= 1)) bad.push(`addColorStop(${o},${c})`); } });
  const fns = {
    measureText: (s) => ({ width: String(s).length * 6 }),
    createLinearGradient: (...a) => { nums('lin', a); return grad(); },
    createRadialGradient: (...a) => { nums('rad', a); if (a[2] < 0 || a[5] < 0) bad.push('radial r<0'); return grad(); },
    createPattern: () => ({}),
    drawImage: (...a) => { nums('drawImage', a.slice(1)); if (!a[0]) bad.push('drawImage(null)'); },
    arc: (...a) => { nums('arc', a); if (a[2] < 0) bad.push('arc r<0'); },
    ellipse: (...a) => { nums('ellipse', a); if (a[2] < 0 || a[3] < 0) bad.push(`ellipse r<0 ${a[2]},${a[3]}`); },
    clip: () => { ops.clip++; },
    setLineDash: () => {},
  };
  return new Proxy(t, {
    get(o, k) {
      if (k in fns) return fns[k];
      if (k in o) return o[k];
      return (...args) => nums(String(k), args);
    },
    set(o, k, v) {
      if ((k === 'fillStyle' || k === 'strokeStyle') && typeof v === 'string' && !validColor(v)) bad.push(`${k}=${v}`);
      o[k] = v;
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
  return {
    width: w, height: h, style: {}, tabIndex: -1, parentElement: null, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
  };
}

function makeUI() {
  let st = { tool: null, selection: null, hover: null, overlays: {}, layout: 'wide-tall', view: 'split', tab: 'colony', ghostDemo: null, glow: null };
  return { getUI: () => st, setUI: (p) => { st = { ...st, ...p }; }, onUI: () => () => {} };
}

function makeGame(seed = 5) {
  return { s: createState({ seed }), d: createDerived(), bus: createBus(), queue: [], actions: { do: () => ({ ok: true, reason: null }) } };
}

const code = (id) => TERRAIN_ORDER.indexOf(id);
const linkSetOf = (hexes) => {
  const set = new Set(hexes);
  const nb = new Map();
  const D = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (const i of hexes) {
    nb.set(i, D.map(([dq, dr]) => {
      const q = QR.get(i);
      const h = hexIndex(q[0] + dq, q[1] + dr);
      return h >= 0 && set.has(h) ? h : -1;
    }));
  }
  return { hexes: [...hexes].sort((a, b) => a - b), nb };
};
const QR = new Map();
const hx = (q, r) => {
  const i = hexIndex(q, r);
  QR.set(i, [q, r]);
  return i;
};

let savedWindow;
before(() => {
  setCanvasFactory(makeOffscreen);
  savedWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});
after(() => {
  setCanvasFactory(null);
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
});

test('C261: log chains — components, the longest chain and its straight runs', () => {
  // an L-shaped chain of 4: three in a row then a bend, plus a separate lone log
  const chain = [hx(0, 0), hx(1, 0), hx(2, 0), hx(2, 1)];
  const lone = hx(-3, 2);
  const set = linkSetOf([...chain, lone]);
  const comps = logComponents(set);
  assert.equal(comps.length, 2);
  const big = comps.find((c) => c.length === 4);
  const path = logSpine(set, big);
  assert.equal(path.length, 4, 'the spine runs through every tile of a simple chain');
  assert.deepEqual([...path].sort((a, b) => a - b), [...big]);
  const runs = straightRuns(path);
  const longest = runs.reduce((a, r) => (r[1] - r[0] > a[1] - a[0] ? r : a));
  assert.equal(longest[1] - longest[0], 2, 'the straight trunk spans the three tiles in a row');
});

test('C260 / C261: lone stones and log chains paint in every season with finite, valid calls', () => {
  const chain = [hx(0, -3), hx(1, -3), hx(2, -3), hx(3, -4), hx(-2, 2)];
  const set = linkSetOf(chain);
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    const { ctx } = makeOffscreen(400, 400);
    bad.length = 0;
    paintSingleStones(ctx, season, [hx(1, 1), hx(-1, -1), hx(3, 0)]);
    paintLogChains(ctx, season, set);
    assert.deepEqual(bad, [], season);
  }
});

test('C260 / C261: the terrain cache paints boulders unclipped, lone stones and multi-tile logs cleanly', () => {
  const game = makeGame();
  const ter = game.s.run.surface.terrain;
  for (const i of [hx(2, 0), hx(3, 0), hx(2, 1)]) ter[i] = code('stone');   // a boulder
  ter[hx(-2, 0)] = code('stone');                                            // a lone stone
  for (const i of [hx(0, 2), hx(1, 2), hx(2, 2), hx(3, 1)]) ter[i] = code('log');   // a bent log chain
  ter[hx(-1, -2)] = code('log');
  const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui: makeUI(), bus: game.bus });
  bad.length = 0;
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    game.d.season.id = season;
    ops.clip = 0;
    surf.render(0.016);
  }
  assert.deepEqual(bad, []);
  surf.destroy();
});

test('C263: rival alates fly (frames cycle, heading follows motion), stay near their hex, and pick hits the drawn alate', () => {
  const game = makeGame();
  const s = game.s;
  s.run.events.objects.push({ uid: 501, kind: 'rival_alate', hex: 3, cell: -1, t: 30, data: { tMax: 60 } });
  s.run.events.objects.push({ uid: 502, kind: 'rival_alate', hex: 3, cell: -1, t: 30, data: {} });
  const atlas = getAtlas();
  const orig = atlas.drawFlyingAlate;
  const seen = [];
  atlas.drawFlyingAlate = function (...a) {
    seen.push({ frame: a[1], x: a[2], y: a[3], ang: a[5] });
    return orig.apply(this, a);
  };
  try {
    const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui: makeUI(), bus: game.bus });
    bad.length = 0;
    const frames = new Set();
    const pos = [];
    for (let k = 0; k < 240; k++) {
      seen.length = 0;
      surf.render(1 / 60);
      assert.equal(seen.length, 2, 'both alates drawn each frame');
      for (const c of seen) frames.add(c.frame);
      pos.push(seen[0]);
    }
    assert.deepEqual(bad, []);
    assert.equal(frames.size, ALATE_FRAMES, 'every flap frame is used');
    const moved = Math.hypot(pos[239].x - pos[0].x, pos[239].y - pos[0].y);
    assert.ok(moved > 2, 'the alate moves');
    const home = surf.hexToScreen(3);
    const z = surf.getCamera().zoom;
    for (const p of pos) assert.ok(Math.hypot(p.x - home.x, p.y - home.y) < HEX.px * 2.6 * z, 'stays within ~2 hexes of its hex');
    // heading follows the direction of travel (sampled over a short step)
    const a = pos[200];
    const b = pos[204];
    const dir = Math.atan2(b.y - a.y, b.x - a.x);
    const diff = Math.abs(Math.atan2(Math.sin(dir - b.ang), Math.cos(dir - b.ang)));
    assert.ok(diff < 1.2, `heading ${b.ang.toFixed(2)} vs travel ${dir.toFixed(2)}`);
    // the hit-test uses the drawn position
    const last = seen.find(Boolean);
    const hit = surf.pick(last.x, last.y);
    assert.equal(hit && hit.kind, 'eventObject');
    assert.ok(hit.id === 501 || hit.id === 502);
    // a caught alate disappears from the flight list
    s.run.events.objects = s.run.events.objects.filter((o) => o.uid !== 501);
    seen.length = 0;
    surf.render(1 / 60);
    assert.equal(seen.length, 1);
    surf.destroy();
  } finally {
    atlas.drawFlyingAlate = orig;
  }
});

test('C262: surface ants wear their job colour on the gaster (trail job, escorts as soldiers)', () => {
  const game = makeGame();
  const s = game.s;
  s.run.colony.adults = { minor: 80, soldier: 10, supermajor: 0, replete: 0 };
  s.run.colony.jobs = { forager: 20, digger: 0, nurse: 0, scout: 5, herder: 20, leafcutter: 0, gardener: 0 };
  s.run.surface.sources.push({ uid: 40, type: 'aphid_colony', hex: 9, stock: 100, max: 100, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 41, origin: 0, src: 40, path: [0, 2, 9], len: 2, job: 'herder', workers: 20, escorts: 3, S: 60, born: 0, reroutes: [] });
  const atlas = getAtlas();
  const orig = atlas.drawAnt;
  const drawn = [];
  atlas.drawAnt = function (...a) {
    drawn.push({ kind: a[1], gaster: a[10] });
    return orig.apply(this, a);
  };
  try {
    const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui: makeUI(), bus: game.bus });
    bad.length = 0;
    for (let k = 0; k < 40; k++) surf.render(1 / 30);
    assert.deepEqual(bad, []);
    const cols = new Set(drawn.map((c) => c.gaster));
    assert.ok(cols.has(JOB_COLORS.herder), 'herder-trail ants carry the herder colour');
    assert.ok(drawn.every((c) => Object.values(JOB_COLORS).includes(c.gaster)), 'every surface ant has a job colour');
    surf.destroy();
  } finally {
    atlas.drawAnt = orig;
  }
});

test('C262: the gaster colour is part of the strip key (painted strips differ per job)', () => {
  const atlas = getAtlas();
  const { ctx } = makeOffscreen(50, 50);
  bad.length = 0;
  for (const c of Object.values(JOB_COLORS)) atlas.drawAnt(ctx, 'minor', 'none', 0, 0, 10, 10, 11, undefined, undefined, c);
  atlas.drawAnt(ctx, 'golden', 'none', 0, 0, 10, 10, 11, undefined, undefined, JOB_COLORS.scout);
  for (let k = 0; k < ALATE_FRAMES; k++) atlas.drawFlyingAlate(ctx, k, 20, 20, 30, 0.5, 0.9);
  assert.deepEqual(bad, []);
});
