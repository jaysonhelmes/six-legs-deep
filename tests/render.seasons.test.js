// C123 gradual seasons and weather seeding: palette.seasonBlend continuity across boundaries (endpoints equal the pure
// season palettes), blended sky / terrain / wash / weather, particle weather targets and pre-warm spread, and the Above
// renderer seeding weather from the current season on its first frame (page reload in winter / autumn). Owner: WP8.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  seasonBlend, blendSky, blendTerrainColor, blendSeasonColor, blendWash, blendWeather, quantizeBlend, toRgb,
  SKY, GRASS_LINE, SEASON_WASH, SEASON_BLEND_SEC, terrainColor, SEASON_IDS,
} from '../src/render/palette.js';
import { createParticles, weatherTargets, PK } from '../src/render/particles.js';
import { setCanvasFactory } from '../src/render/canvas.js';
import { createSurfaceRenderer } from '../src/render/surfaceRenderer.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { createBus } from '../src/core/bus.js';

const NEXT = { spring: 'summer', summer: 'autumn', autumn: 'winter', winter: 'spring' };
const ds = (id, toNext, len = 360) => ({ id, toNext, len, forecast: { next: NEXT[id] } });

function colorDist(a, b) {
  const x = toRgb(a);
  const y = toRgb(b);
  return Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]));
}

test('seasonBlend: pure season outside the window, eases toward the next season inside it', () => {
  assert.deepEqual(seasonBlend(ds('summer', 200)), { from: 'summer', to: 'autumn', t: 0 });
  assert.equal(seasonBlend(ds('summer', SEASON_BLEND_SEC)).t, 0);
  const mid = seasonBlend(ds('summer', SEASON_BLEND_SEC / 2)).t;
  assert.ok(Math.abs(mid - 0.5) < 1e-9, `half-way through the window t = 0.5 (got ${mid})`);
  assert.ok(seasonBlend(ds('summer', 0.01)).t > 0.999);
  // monotonic
  let prev = -1;
  for (let left = SEASON_BLEND_SEC; left >= 0; left -= 0.5) {
    const t = seasonBlend(ds('autumn', left)).t;
    assert.ok(t >= prev - 1e-12, 'blend never steps backwards');
    prev = t;
  }
  // short seasons (chronobiology 3 min) blend over 30 % of the season at most
  assert.equal(seasonBlend(ds('spring', 60, 180)).t, 0);
  assert.ok(seasonBlend(ds('spring', 50, 180)).t > 0);
  // no next season / eternal winter / missing data: pure current season
  assert.equal(seasonBlend({ id: 'winter', toNext: 5, len: 360, forecast: { next: 'winter' } }).t, 0);
  assert.deepEqual(seasonBlend(null), { from: 'spring', to: 'spring', t: 0 });
  assert.deepEqual(seasonBlend({ id: 'bogus' }), { from: 'spring', to: 'spring', t: 0 });
  const q = quantizeBlend({ from: 'a', to: 'b', t: 0.37 }, 4);
  assert.equal(q.t, 0.25);
});

test('blended palettes are continuous across every boundary and equal the pure palettes at the endpoints', () => {
  for (const id of SEASON_IDS) {
    const nx = NEXT[id];
    const pure = seasonBlend(ds(id, 200));
    assert.deepEqual(blendSky(pure), [...SKY[id]], `${id}: sky outside the window is the pure sky`);
    assert.equal(blendSeasonColor(GRASS_LINE, pure), GRASS_LINE[id]);
    assert.deepEqual(blendTerrainColor(pure, 'grass'), terrainColor(id, 'grass'));
    // just before the boundary ≈ the next season's pure palette; just after it (t = 0 in the next season) = exactly it
    const before0 = seasonBlend(ds(id, 1e-6));
    const after0 = seasonBlend(ds(nx, 360));
    for (const k of [0, 1]) assert.ok(colorDist(blendSky(before0)[k], blendSky(after0)[k]) <= 1, `${id}→${nx}: sky continuous`);
    assert.ok(colorDist(blendSeasonColor(GRASS_LINE, before0), GRASS_LINE[nx]) <= 1, `${id}→${nx}: grass continuous`);
    for (const ter of ['grass', 'sand', 'leaf_litter', 'puddle']) {
      const a = blendTerrainColor(before0, ter);
      const b = blendTerrainColor(after0, ter);
      assert.ok(colorDist(a[0], b[0]) <= 1 && colorDist(a[1], b[1]) <= 1, `${id}→${nx}: ${ter} continuous`);
    }
    // no large jump between consecutive 0.1 s frames anywhere in the window
    let last = blendSky(seasonBlend(ds(id, SEASON_BLEND_SEC + 1)))[0];
    for (let left = SEASON_BLEND_SEC; left >= 0; left -= 0.1) {
      const c = blendSky(seasonBlend(ds(id, left)))[0];
      assert.ok(colorDist(last, c) <= 3, `${id}: sky changes gradually (Δ ${colorDist(last, c)} at ${left.toFixed(1)} s)`);
      last = c;
    }
  }
});

test('season wash and weather intensity blend smoothly (no wash pop entering or leaving spring)', () => {
  const alpha = (w) => (w ? Number(/,([\d.]+)\)$/.exec(w)[1]) : 0);
  assert.equal(blendWash(seasonBlend(ds('spring', 200))), null);
  assert.equal(blendWash(seasonBlend(ds('winter', 200))), SEASON_WASH.winter);
  assert.ok(Math.abs(alpha(blendWash(seasonBlend(ds('winter', 1e-6)))) - 0) < 0.002, 'winter wash fades out into spring');
  assert.ok(Math.abs(alpha(blendWash(seasonBlend(ds('spring', 1e-6)))) - 0.06) < 0.002, 'summer wash fades in from spring');
  // the hue of a fading wash stays the season's hue (no grey midway)
  const w = blendWash(seasonBlend(ds('winter', SEASON_BLEND_SEC / 2)));
  assert.match(w, /^rgba\(205,228,255,/);

  assert.deepEqual(blendWeather(seasonBlend(ds('summer', 200))), { snow: 0, leaves: 0 });
  assert.deepEqual(blendWeather(seasonBlend(ds('autumn', 200))), { snow: 0, leaves: 0.6 });
  assert.deepEqual(blendWeather(seasonBlend(ds('winter', 200))), { snow: 0.8, leaves: 0 });
  assert.deepEqual(blendWeather(seasonBlend(ds('winter', 200)), true), { snow: 0.4, leaves: 0 }, 'mild winter snows at half');
  const half = blendWeather(seasonBlend(ds('autumn', SEASON_BLEND_SEC / 2)));
  assert.ok(Math.abs(half.snow - 0.4) < 1e-9 && Math.abs(half.leaves - 0.3) < 1e-9, 'autumn → winter: leaves out, snow in');
  const end = blendWeather(seasonBlend(ds('winter', 1e-6)));
  assert.ok(end.snow < 0.001, 'snow has ramped out by the first spring frame');
});

test('particles: weather targets scale with intensity and area and fit the pool', () => {
  const b = { x: 0, y: 0, w: 800, h: 600 };
  const t1 = weatherTargets({ snow: 0.8 }, b, false, 999);
  const t2 = weatherTargets({ snow: 0.4 }, b, false, 999);
  assert.ok(t1.snow > 0 && Math.abs(t1.snow - 2 * t2.snow) <= 1);
  assert.equal(t1.leaves, 0);
  const red = weatherTargets({ snow: 0.8 }, b, true, 999);
  assert.ok(red.snow < t1.snow / 2, 'reduced motion thins the weather');
  const cramped = weatherTargets({ rain: 1, snow: 1, leaves: 1 }, b, false, 50);
  assert.ok(cramped.rain + cramped.snow + cramped.leaves <= 51);
});

test('particles: a pre-warm fill spreads weather over the whole view; steady state replaces from the top', () => {
  const p = createParticles(190);
  const b = { x: 0, y: 0, w: 800, h: 600 };
  p.weatherMix({ snow: 0.8 }, b, 1 / 60, false, true);
  const n = p.weatherCounts().snow;
  const want = weatherTargets({ snow: 0.8 }, b, false, Math.floor(190 * 0.66)).snow;
  assert.equal(n, want, 'fill reaches the target in one frame');
  let lower = 0;
  for (let i = 0; i < p.n; i++) if (p.kind[i] === PK.snow && p.y[i] > b.h / 2) lower++;
  assert.ok(lower > n * 0.3, `flakes cover the lower half too (${lower}/${n})`);
  // no fill: a fresh pool trickles in from the top edge only, a few per frame
  const q = createParticles(190);
  q.weatherMix({ leaves: 0.6 }, b, 1 / 60, false, false);
  assert.ok(q.weatherCounts().leaves <= 2);
  for (let i = 0; i < q.n; i++) assert.ok(q.y[i] < 0);
  // ramping intensity down: no new particles, the old ones fall out naturally (no pop)
  const before0 = p.weatherCounts().snow;
  p.weatherMix({ snow: 0 }, b, 1 / 60, false, false);
  assert.equal(p.weatherCounts().snow, before0);
  // compatibility wrapper
  const r = createParticles(190);
  r.weather('rain', 1, b, 0.1, false);
  assert.ok(r.weatherCounts().rain > 0);
});

// ---------------------------------------------------------------------------------------------------------------
// renderer: first frame after a reload seeds the current season's weather
// ---------------------------------------------------------------------------------------------------------------

function makeCtx() {
  const t = { globalAlpha: 1, lineWidth: 1, font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000' };
  const fns = {
    measureText: (s) => ({ width: String(s).length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
  };
  return new Proxy(t, {
    get(o, k) {
      if (k in fns) return fns[k];
      if (k in o) return o[k];
      return () => {};
    },
    set(o, k, v) {
      o[k] = v;
      return true;
    },
  });
}
const makeOffscreen = (w, h) => {
  const ctx = makeCtx();
  return { canvas: { width: w, height: h, getContext: () => ctx }, ctx };
};
function makeCanvas(w, h) {
  const ctx = makeCtx();
  return {
    width: w, height: h, style: {}, parentElement: null, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener() {}, removeEventListener() {},
  };
}
const ui = { getUI: () => ({ tool: null, selection: null, hover: null, overlays: {} }), setUI() {}, onUI: () => () => {} };

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

function gameIn(season, toNext = 200) {
  const game = { s: createState({ seed: 11 }), d: createDerived(), bus: createBus(), queue: [], actions: { do: () => ({ ok: true }) } };
  Object.assign(game.d.season, { id: season, toNext, len: 360, mild: false, forecast: { ...(game.d.season.forecast || {}), next: NEXT[season] } });
  return game;
}

test('Above renderer: the first frame (reload) in winter / autumn already shows spread-out snow / leaves', () => {
  for (const [season, kind] of [['winter', 'snow'], ['autumn', 'leaves']]) {
    const game = gameIn(season);
    const r = createSurfaceRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
    r.render(1 / 60);
    const w = r.getWeather();
    assert.ok(w.counts[kind] >= 10, `${season}: ${kind} present on the first frame (${w.counts[kind]})`);
    assert.equal(w.terrainCaches, 1);
    r.destroy();
  }
  const game = gameIn('summer');
  const r = createSurfaceRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
  r.render(1 / 60);
  assert.deepEqual(r.getWeather().counts, { rain: 0, snow: 0, leaves: 0 });
  // import / run start re-seeds for the new state's season
  game.d.season.id = 'winter';
  game.d.season.forecast.next = 'spring';
  game.bus.emit('imported', {});
  r.render(1 / 60);
  assert.ok(r.getWeather().counts.snow >= 10, 'imported winter save shows snow at once');
  r.destroy();
});

test('Above renderer: a season transition cross-fades two terrain caches and ramps the weather in', () => {
  const game = gameIn('autumn', SEASON_BLEND_SEC + 5);
  const r = createSurfaceRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
  r.render(1 / 60);
  assert.equal(r.getWeather().terrainCaches, 1);
  game.d.season.toNext = SEASON_BLEND_SEC / 2;
  r.render(1 / 60);
  const w = r.getWeather();
  assert.equal(w.terrainCaches, 2, 'next season cache built for the cross-fade');
  assert.ok(w.blend.t > 0.4 && w.blend.t < 0.6);
  for (let k = 0; k < 600; k++) r.render(1 / 60);
  assert.ok(r.getWeather().counts.snow > 0, 'snow begins before winter');
  // boundary: winter now, the autumn cache is dropped
  Object.assign(game.d.season, { id: 'winter', toNext: 360 });
  game.d.season.forecast.next = 'spring';
  r.render(1 / 60);
  assert.equal(r.getWeather().terrainCaches, 1);
  r.destroy();
});
