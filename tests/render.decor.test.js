// WP8 Below-view chamber decorations (render/nestDecor.js): every chamber type has a decoration routine; painting the
// static layer and the animated layer (moving and reduced-motion still frames, spring and winter) with a fake 2D
// context throws nothing and never passes a non-finite number, negative radius or invalid colour; layouts are
// deterministic per chamber; the offscreen cache paints once and only repaints when its key changes.
// Owner: WP8 (ARCHITECTURE §13.5, DESIGN §7.6).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setCanvasFactory } from '../src/render/canvas.js';
import { DECOR, decorLayout, paintDecor, drawDecorAnim, hasDecorAnim, createDecorCache } from '../src/render/nestDecor.js';
import { cavityBox } from '../src/render/nestArt.js';
import { CHAMBERS } from '../src/data/chambers.js';

const bad = [];
let painted = 0;

function checkNums(name, args) {
  for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${name}(${args.join(',')})`);
}

function validColor(c) {
  if (typeof c !== 'string') return typeof c === 'object' && c !== null; // gradients / patterns
  if (/NaN|undefined|Infinity/.test(c)) return false;
  return /^#[0-9a-f]{3,8}$/i.test(c) || /^rgba?\(/.test(c);
}

function makeCtx() {
  const target = { globalAlpha: 1, lineWidth: 1, fillStyle: '#000', strokeStyle: '#000', lineCap: 'butt' };
  const grad = () => ({ addColorStop: (o, c) => { if (!validColor(c) || !(o >= 0 && o <= 1)) bad.push(`addColorStop(${o},${c})`); } });
  const fns = {
    createLinearGradient: (...a) => { checkNums('createLinearGradient', a); return grad(); },
    createRadialGradient: (...a) => {
      checkNums('createRadialGradient', a);
      if (a[2] < 0 || a[5] < 0) bad.push('createRadialGradient negative radius');
      return grad();
    },
    arc: (...a) => { checkNums('arc', a); if (a[2] < 0) bad.push(`arc negative radius ${a[2]}`); },
    ellipse: (...a) => { checkNums('ellipse', a); if (a[2] < 0 || a[3] < 0) bad.push(`ellipse negative radius ${a[2]},${a[3]}`); },
    drawImage: (...a) => { checkNums('drawImage', a.slice(1)); if (!a[0]) bad.push('drawImage(null)'); },
    fill: () => { painted++; },
    stroke: () => { painted++; },
    fillRect: (...a) => { checkNums('fillRect', a); painted++; },
    setLineDash: () => {},
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in fns) return fns[k];
      if (k in t) return t[k];
      return (...args) => checkNums(String(k), args);
    },
    set(t, k, v) {
      if ((k === 'fillStyle' || k === 'strokeStyle') && !validColor(v)) bad.push(`${k}=${v}`);
      if (k === 'globalAlpha' && !(v >= 0 && v <= 1)) bad.push(`globalAlpha=${v}`);
      if (k === 'lineWidth' && !(v > 0)) bad.push(`lineWidth=${v}`);
      t[k] = v;
      return true;
    },
  });
}

let offscreens = 0;
before(() => setCanvasFactory((w, h) => {
  offscreens++;
  const ctx = makeCtx();
  return { canvas: { width: w, height: h, getContext: () => ctx }, ctx };
}));
after(() => setCanvasFactory(null));

/** Chamber footprints to try per type: L1, a grown one and a tiny 2×2. */
function footprints(type) {
  const def = CHAMBERS[type];
  const out = [{ w: def.w0, h: def.h0 }, { w: 2, h: 2 }];
  if (def.grows) out.push({ w: def.w0 + 7, h: def.h0 + 2 });
  return out;
}

test('every chamber type has a decoration routine', () => {
  const types = Object.keys(CHAMBERS);
  assert.ok(types.length >= 16);
  for (const type of types) {
    assert.ok(DECOR[type], `${type} has a decoration`);
    assert.equal(typeof DECOR[type].layout, 'function');
    assert.equal(typeof DECOR[type].back, 'function');
    if (DECOR[type].anim) assert.ok(hasDecorAnim(type));
  }
  for (const type of Object.keys(DECOR)) assert.ok(CHAMBERS[type], `${type} is a real chamber type`);
  // the animated set: scent wisps, heat shimmer, ripples, drips, motes, glints
  for (const type of ['scent_library', 'thermal_chimney', 'water_well', 'root_aphid_pen', 'nuptial_chamber']) assert.ok(hasDecorAnim(type), type);
});

test('drawing each decoration with a fake 2D context throws nothing and passes only valid values', () => {
  const ctx = makeCtx();
  for (const type of Object.keys(CHAMBERS)) {
    for (const fp of footprints(type)) {
      for (const u of [4, 13, 20, 40]) {
        for (const winter of [false, true]) {
          const c = { uid: 7, type, x: 3, y: 9, ...fp };
          const b = cavityBox(c);
          const box = { x: 10 + b.x0 * u, y: 20 + b.y0 * u, w: (b.x1 - b.x0) * u, h: (b.y1 - b.y0) * u };
          const o = type === 'royal_chamber' ? { winter, qf: 0.35, qh: 0.6, grow: 1.2, key: 'q' } : { winter };
          const before0 = painted;
          assert.doesNotThrow(() => paintDecor(ctx, type, box, u, c.uid, o), `${type} ${fp.w}×${fp.h} @${u}`);
          assert.ok(painted > before0, `${type} paints something`);
          for (const t of [0, 0.37, 2.9, 61.2]) {
            assert.doesNotThrow(() => drawDecorAnim(ctx, type, box, u, t, c.uid, { ...o, still: false }));
            assert.doesNotThrow(() => drawDecorAnim(ctx, type, box, u, t, c.uid, { ...o, still: true }));
          }
          assert.equal(ctx.globalAlpha, 1, `${type} restores globalAlpha`);
        }
      }
    }
  }
  // degenerate input is ignored
  assert.doesNotThrow(() => paintDecor(ctx, 'gallery', { x: 0, y: 0, w: 0, h: 10 }, 13, 1));
  assert.doesNotThrow(() => paintDecor(ctx, 'mystery_room', { x: 0, y: 0, w: 10, h: 10 }, 13, 1));
  assert.doesNotThrow(() => drawDecorAnim(ctx, 'water_well', { x: 0, y: 0, w: 30, h: 40 }, 13, NaN, 1));
  assert.deepEqual(bad, []);
});

test('layouts are deterministic per chamber uid and differ between chambers', () => {
  for (const type of Object.keys(DECOR)) {
    const a = DECOR[type].layout(5.66, 2.75, 12, {});
    const b = DECOR[type].layout(5.66, 2.75, 12, {});
    assert.deepEqual(a, b, `${type} deterministic`);
  }
  assert.notDeepEqual(DECOR.gallery.layout(9.66, 3.75, 1, {}), DECOR.gallery.layout(9.66, 3.75, 2, {}));
  assert.equal(decorLayout('midden', 1.66, 1.75, 3), decorLayout('midden', 1.66, 1.75, 3), 'memoised');
});

test('the decoration cache paints once per chamber and repaints only when its key changes', () => {
  const cacheD = createDecorCache();
  const ctx = makeCtx();
  const c = { uid: 41, type: 'deep_vault', x: 5, y: 40, w: 4, h: 3 };
  const box = { x: 100, y: 200, w: 3.66 * 20, h: 2.75 * 20 };
  const n0 = offscreens;
  for (let k = 0; k < 10; k++) assert.ok(cacheD.draw(ctx, c, box, 20, 20, { winter: false }));
  assert.equal(offscreens - n0, 1, 'one offscreen for ten frames');
  assert.equal(cacheD.size, 1);
  cacheD.draw(ctx, c, { ...box, x: 50 }, 20, 20, { winter: false });
  assert.equal(offscreens - n0, 1, 'panning reuses the cache');
  cacheD.draw(ctx, c, box, 20, 20, { winter: true });
  cacheD.draw(ctx, { ...c, w: 5, h: 3 }, box, 20, 20, { winter: true });
  cacheD.draw(ctx, c, box, 20, 28, { winter: true });
  assert.ok(offscreens - n0 >= 2 && offscreens - n0 <= 4, 'season, footprint and resolution changes repaint');
  assert.equal(cacheD.draw(ctx, { ...c, type: 'mystery_room' }, box, 20, 20), false);
  cacheD.clear();
  assert.equal(cacheD.size, 0);
  assert.deepEqual(bad, []);
});

// ------------------------------------------------------------------------------------------------ C159 level adornment
test('C159: level-scaled decor draws for every chamber type at L1 / L4 / L8, richer at each tier, deterministic', async () => {
  const { decorTier, adornmentLayout } = await import('../src/render/nestDecor.js');
  assert.deepEqual([1, 2, 3, 4, 6, 7, 8, 12].map(decorTier), [0, 0, 1, 1, 1, 2, 2, 2]);
  const ctx = makeCtx();
  for (const type of Object.keys(CHAMBERS)) {
    const def = CHAMBERS[type];
    const counts = [];
    for (const L of [1, 4, 8]) {
      const tier = decorTier(L);
      // the chamber's footprint at that level (fixed-size types keep theirs)
      const tall = def.grows ? Math.floor((L - 1) / 3) : 0;
      const c = { uid: 9, type, x: 3, y: 9, w: def.grows ? def.w0 + L - 1 - tall : def.w0, h: def.grows ? def.h0 + tall : def.h0 };
      const b = cavityBox(c);
      for (const u of [8, 20, 40]) {
        const box = { x: 10 + b.x0 * u, y: 20 + b.y0 * u, w: (b.x1 - b.x0) * u, h: (b.y1 - b.y0) * u };
        const o = type === 'royal_chamber' ? { qf: 0.35, qh: 0.6, grow: 1.2, key: 'q', tier } : { tier };
        const before0 = painted;
        assert.doesNotThrow(() => paintDecor(ctx, type, box, u, c.uid, o), `${type} L${L} @${u}`);
        if (u === 20) counts.push(painted - before0);
      }
      // same footprint, compare tiers directly: each tier paints more than the one below
    }
    const c = { uid: 9, type, x: 3, y: 9, w: Math.max(def.w0, 6), h: Math.max(def.h0, 3) };
    const b = cavityBox(c);
    const box = { x: 0, y: 0, w: (b.x1 - b.x0) * 20, h: (b.y1 - b.y0) * 20 };
    const per = [0, 1, 2].map((tier) => {
      const p0 = painted;
      paintDecor(ctx, type, box, 20, 9, type === 'royal_chamber' ? { qf: 0.35, qh: 0.6, grow: 1, key: 'q', tier } : { tier });
      return painted - p0;
    });
    assert.ok(per[1] > per[0] && per[2] > per[1], `${type} richer with level: ${per.join(' < ')}`);
    assert.ok(counts.length === 3);
    assert.deepEqual(adornmentLayout(type, 5.66, 2.75, 12, 2), adornmentLayout(type, 5.66, 2.75, 12, 2), `${type} deterministic`);
    assert.equal(adornmentLayout(type, 5.66, 2.75, 12, 0), null, 'tier 0: no adornment');
  }
  assert.notDeepEqual(adornmentLayout('gallery', 9.66, 3.75, 1, 2), adornmentLayout('gallery', 9.66, 3.75, 2, 2), 'differs per chamber');
  assert.deepEqual(bad, []);
});

test('C159: the decoration cache repaints when the level tier changes, not on every level', () => {
  const cacheD = createDecorCache();
  const ctx = makeCtx();
  const c = { uid: 77, type: 'granary', x: 5, y: 40, w: 4, h: 3 };
  const box = { x: 100, y: 200, w: 3.66 * 20, h: 2.75 * 20 };
  const n0 = offscreens;
  cacheD.draw(ctx, c, box, 20, 20, { tier: 1 });
  cacheD.draw(ctx, c, box, 20, 20, { tier: 1 });
  const n1 = offscreens;
  assert.equal(n1 - n0, 1);
  const p0 = painted;
  cacheD.draw(ctx, c, box, 20, 20, { tier: 1 });
  const same = painted - p0;
  cacheD.draw(ctx, c, box, 20, 20, { tier: 2 });
  assert.ok(painted - p0 > same, 'a new tier repaints the static layer');
  assert.deepEqual(bad, []);
});

test('C159: painting every type at its top tier costs about what the plain set dressing does (cached, measured)', () => {
  const ctx = makeCtx();
  const time = (tier) => {
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 20; k++) {
      for (const type of Object.keys(CHAMBERS)) {
        const box = { x: 0, y: 0, w: 7.66 * 20, h: 3.75 * 20 };
        paintDecor(ctx, type, box, 20, 100 + k, type === 'royal_chamber' ? { qf: 0.35, qh: 0.6, grow: 1, key: 'q' + k, tier } : { tier });
      }
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time(2);
  const base = time(0);
  const top = time(2);
  // a cache repaint happens once per chamber per tier change (not per frame); keep it in the same ballpark
  assert.ok(top < base * 4 + 20, `top tier ${top.toFixed(1)} ms vs plain ${base.toFixed(1)} ms for 340 repaints`);
});

// ------------------------------------------------------------------------------------------------ C154 reserved works
test('C154: reserved rooms draw as works in progress (wash, hatch, props, workers) with valid values at every zoom', async () => {
  const { drawReservedWorks } = await import('../src/render/nestArt.js');
  const ctx = makeCtx();
  const room = { x: 10, y: 20, w: 3, h: 2 };
  const R = { x: 10, y: 20, w: 8, h: 4 };
  const soil = [];
  for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) if (!(x < 13 && y < 22)) soil.push([x, y]);
  for (const u of [4, 9, 12, 24, 40]) {
    for (const strong of [false, true]) {
      for (const still of [false, true]) {
        const p0 = painted;
        const n = drawReservedWorks(ctx, { R, room, soil, ox: 5, oy: -30, u, seed: 3, strong, t: 12.3, still });
        assert.equal(n, soil.length);
        assert.ok(painted - p0 >= 3, 'wash, hatch and edge at least');
      }
    }
  }
  assert.equal(drawReservedWorks(ctx, { R, room, soil: [], ox: 0, oy: 0, u: 20, seed: 1 }), 0, 'nothing left to dig: nothing drawn');
  assert.equal(drawReservedWorks(ctx, null), 0);
  // close up adds props and workers on top of the overview look
  const far = (() => { const p0 = painted; drawReservedWorks(ctx, { R, room, soil, ox: 0, oy: 0, u: 8, seed: 3 }); return painted - p0; })();
  const near = (() => { const p0 = painted; drawReservedWorks(ctx, { R, room, soil, ox: 0, oy: 0, u: 24, seed: 3 }); return painted - p0; })();
  assert.ok(near > far, `close up is richer (${near} > ${far})`);
  assert.deepEqual(bad, []);
});
