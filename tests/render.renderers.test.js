// WP8 renderers and canvas input, headless: both views render a hand-built createState() game without exceptions or
// invalid canvas calls, never write s, keep within the sprite budgets, pick the documented Target kinds, stay accurate
// after resize/DPR changes, and the input controllers dispatch only through game.actions / uistate / bridge.
// Uses a fake 2D context injected through render/canvas.js setCanvasFactory. Owner: WP8 (ARCHITECTURE §13, §16 WP8).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setCanvasFactory } from '../src/render/canvas.js';
import { createNestRenderer } from '../src/render/nestRenderer.js';
import { createSurfaceRenderer } from '../src/render/surfaceRenderer.js';
import { attachNestInput } from '../src/render/nestInput.js';
import { attachSurfaceInput } from '../src/render/surfaceInput.js';
import { createSeam, seamHub } from '../src/render/seam.js';
import { drawMiniMap, drawNestStrip } from '../src/render/minimap.js';
import { playCeremony, endCeremony, activeCeremony } from '../src/render/ceremony.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { createBus } from '../src/core/bus.js';
import { GRID, CELL } from '../src/data/balance.js';

const COLS = GRID.cols;

// ---------------------------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------------------------

const stats = { drawImage: 0, bad: [], calls: 0 };

function checkNums(name, args) {
  for (const a of args) {
    if (typeof a === 'number' && !Number.isFinite(a)) stats.bad.push(`${name}(${args.join(',')})`);
  }
}

function validColor(c) {
  if (typeof c !== 'string') return false;
  if (/NaN|undefined|Infinity/.test(c)) return false;
  return /^#[0-9a-f]{3,8}$/i.test(c) || /^rgba?\(/.test(c);
}

function makeCtx() {
  const target = {
    globalAlpha: 1, lineWidth: 1, font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineDashOffset: 0,
    textAlign: 'left', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter',
  };
  const fns = {
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...a) => {
      checkNums('createLinearGradient', a);
      return { addColorStop: (o, c) => { if (!validColor(c) || !(o >= 0 && o <= 1)) stats.bad.push(`addColorStop(${o},${c})`); } };
    },
    createRadialGradient: (...a) => {
      checkNums('createRadialGradient', a);
      if (a[2] < 0 || a[5] < 0) stats.bad.push('createRadialGradient negative radius');
      return { addColorStop: (o, c) => { if (!validColor(c) || !(o >= 0 && o <= 1)) stats.bad.push(`addColorStop(${o},${c})`); } };
    },
    createPattern: () => ({ fakePattern: true }),
    drawImage: (...a) => {
      stats.drawImage++;
      checkNums('drawImage', a.slice(1));
      if (!a[0]) stats.bad.push('drawImage(null)');
    },
    arc: (...a) => {
      checkNums('arc', a);
      if (a[2] < 0) stats.bad.push(`arc negative radius ${a[2]}`);
    },
    ellipse: (...a) => {
      checkNums('ellipse', a);
      if (a[2] < 0 || a[3] < 0) stats.bad.push(`ellipse negative radius ${a[2]},${a[3]}`);
    },
    arcTo: (...a) => {
      checkNums('arcTo', a);
      if (a[4] < 0) stats.bad.push('arcTo negative radius');
    },
    setLineDash: () => {},
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in fns) return fns[k];
      if (k in t) return t[k];
      return (...args) => {
        stats.calls++;
        checkNums(String(k), args);
      };
    },
    set(t, k, v) {
      if ((k === 'fillStyle' || k === 'strokeStyle') && typeof v === 'string' && !validColor(v)) stats.bad.push(`${k}=${v}`);
      t[k] = v;
      return true;
    },
  });
}

function makeOffscreen(w, h) {
  const ctx = makeCtx();
  const canvas = { width: w, height: h, getContext: () => ctx };
  return { canvas, ctx };
}

function makeCanvas(w, h) {
  const ctx = makeCtx();
  const listeners = {};
  const c = {
    width: w, height: h, rect: { left: 0, top: 0, width: w, height: h }, style: {}, tabIndex: -1, parentElement: null,
    getContext: () => ctx,
    getBoundingClientRect() { return { ...this.rect }; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    setPointerCapture() {},
    releasePointerCapture() {},
    fire(type, e) { for (const fn of listeners[type] || []) fn(e); },
    listeners,
  };
  return c;
}

const winListeners = {};
const fakeWindow = {
  devicePixelRatio: 1,
  addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
  removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn); },
};

function makeUI() {
  let st = {
    tool: null, selection: null, hover: null,
    overlays: { climate: false, raid_reach: false, haul: false, adjacency: false, territory: false, trail_strength: false, danger: false, richness: false },
    layout: 'wide-tall', view: 'split', tab: 'colony', subTab: null, ghostDemo: null, glow: null,
  };
  return { getUI: () => st, setUI: (p) => { st = { ...st, ...p }; }, onUI: () => () => {} };
}

function makeBridge() {
  const rec = [];
  const b = {};
  for (const k of ['hover', 'select', 'openTab', 'openChooser', 'contextMenu', 'reject', 'toast']) b[k] = (...args) => rec.push([k, ...args]);
  b.rec = rec;
  b.of = (k) => rec.filter((r) => r[0] === k);
  return b;
}

function makeGame(seed = 7) {
  const calls = [];
  const game = {
    s: createState({ seed }),
    d: createDerived(),
    bus: createBus(),
    queue: [],
    actions: { do(type, args) { calls.push({ type, args }); return { ok: true, reason: null }; } },
  };
  game.calls = calls;
  return game;
}

function ev(x, y, extra = {}) {
  return { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', preventDefault() {}, ...extra };
}

function click(canvas, x, y, extra = {}) {
  canvas.fire('pointerdown', ev(x, y, extra));
  canvas.fire('pointerup', ev(x, y, extra));
}

function drag(canvas, x0, y0, x1, y1) {
  canvas.fire('pointerdown', ev(x0, y0));
  const n = 6;
  for (let k = 1; k <= n; k++) canvas.fire('pointermove', ev(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
  canvas.fire('pointerup', ev(x1, y1));
}

function cellPt(r, i) {
  const v = r.getView();
  return { x: v.ox + ((i % COLS) + 0.5) * v.cell, y: v.oy + (Math.floor(i / COLS) + 0.5) * v.cell };
}

function frames(rs, n = 30, dt = 1 / 60) {
  for (let k = 0; k < n; k++) for (const r of rs) r.render(dt);
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
// tests
// ---------------------------------------------------------------------------------------------------------------

test('both views render the skeleton world (and a busy world) without exceptions, invalid calls or writes to s', () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(800, 480);
  const sc = makeCanvas(800, 520);
  const strip = makeCanvas(24, 300);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus, strip });
  const surf = createSurfaceRenderer(sc, { game, ui, bus: game.bus });
  stats.bad.length = 0;
  let snap = JSON.stringify(game.s);
  frames([nest, surf], 40);
  assert.equal(JSON.stringify(game.s), snap, 'rendering never writes s');

  // a busy world: colony, chambers, brood, queue, features, winter frost, raids, battles, events, golden, strata
  const s = game.s;
  const d = game.d;
  s.run.colony.adults = { minor: 400, soldier: 40, supermajor: 5, replete: 12 };
  s.run.colony.jobs = { forager: 220, digger: 60, nurse: 30, scout: 20, herder: 10, leafcutter: 10, gardener: 10 };
  s.run.colony.brood = [{ c: 'minor', n: 12, p: 0.1, t: 1 }, { c: 'minor', n: 9, p: 0.5, t: 2 }, { c: 'soldier', n: 4, p: 0.9, t: 3 }];
  s.run.colony.alatesReared = 7;
  s.run.colony.hungry = true;
  s.run.res.food = 120;
  s.run.res.fungus = 300;
  const addCh = (uid, type, x, y, w, h, status = 'active') => {
    s.run.nest.chambers.push({ uid, type, k: 0, x, y, w, h, level: 2, target: 2, status, blueprint: false, bornAt: 0 });
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) s.run.nest.cells[yy * COLS + xx] = status === 'digging' ? CELL.SOIL : CELL.CHAMBER;
  };
  // connect a tunnel along row 22 to the right
  for (let x = 21; x < 36; x++) s.run.nest.cells[22 * COLS + x] = CELL.TUNNEL;
  for (let y = 22; y < 40; y++) s.run.nest.cells[y * COLS + 30] = CELL.TUNNEL;
  const types = ['nursery', 'granary', 'gallery', 'fungus_garden', 'repletion_hall', 'nuptial_chamber', 'midden', 'scent_library',
    'root_aphid_pen', 'hibernaculum', 'thermal_chimney', 'gate', 'water_well', 'deep_vault', 'barracks'];
  types.forEach((t, k) => addCh(10 + k, t, 1 + (k % 4) * 7, 24 + Math.floor(k / 4) * 6, 4, 3));
  addCh(40, 'gallery', 32, 30, 3, 2, 'digging');
  s.run.nest.cells[60 * COLS + 5] = CELL.STONE;
  s.run.nest.cells[61 * COLS + 5] = CELL.STONE;
  s.run.nest.cells[50 * COLS + 10] = CELL.WATER;
  s.run.nest.features = { caches: [{ i: 23 * COLS + 25, kind: 'seed_cache', found: false, hinted: false }],
    water: [{ x: 10, y: 50, w: 1, h: 1, revealed: true }], roots: [{ col: 5, y0: 1, y1: 14 }] };
  s.run.nest.queue = [{ uid: 99, kind: 'tunnel', chamber: 0, cells: [22 * COLS + 36, 22 * COLS + 37], cur: 0, prog: 1, paidFood: 0, blueprint: false }];
  s.run.nest.rev++;
  s.meta.strata = [{ kind: 'run', cells: 'rle:0*20,1*20,0*3160', at: 10 }, { kind: 'era', cells: 'rle:1*40,0*3160', at: 20 }];
  d.season.id = 'winter';
  d.season.frostRow = 12;
  d.season.snapRow = 3;
  s.run.effects.push({ id: 'flood', stat: 'chamber_layer', mult: 0, add: 0, scope: 'topsoil', t: 30 });
  s.run.events.active.push({ uid: 1, id: 'ev_rainstorm', t: 30, data: {} });
  s.run.events.objects.push({ uid: 2, kind: 'mold', hex: -1, cell: 25 * COLS + 2, t: -1, data: {} });
  for (const kind of ['ladybug', 'footstep', 'molehill', 'antlion', 'lizard', 'termite_swarm', 'golden_aphid', 'rival_alate',
    'army_column', 'phengaris', 'myrmecophile', 'wandering_queen', 'fruit']) {
    s.run.events.objects.push({ uid: 10 + s.run.events.objects.length, kind, hex: 5 + s.run.events.objects.length, cell: -1, t: 4, data: { tMax: 15 } });
  }
  s.run.golden.beetle = { hex: 7, t: 6 };
  s.run.golden.pupa = { chamber: 10, t: 9 };
  s.run.golden.gifts = [{ hex: 12 }];
  s.run.rivals.list.push({ uid: 3, type: 'black_garden_ants', tier: 1, hex: 40, radius: 2, base: 15, n: 15, atk: 3, hp: 15, traits: [], alive: true,
    sighted: true, raidIn: 100, truce: 30, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1, extra: [], lost: [], stolen: 0 });
  s.run.war.raids.push({ uid: 4, rival: 3, target: { type: 'nest' }, raiders: 5, warn: 12, phase: 'warning', guard: 0 });
  s.run.war.parties.push({ uid: 5, kind: 'raid', target: { type: 'rival', uid: 3 }, soldier: 10, supermajor: 1, path: [0, 1, 7, 19], pos: 1.5, state: 'out' });
  s.run.war.battles.push({ uid: 6, kind: 'raid', hex: 20, below: false, party: 5, raid: 0, you: { militia: 0, soldier: 8, supermajor: 1 }, foe: { n: 9, atk: 3, hp: 15 },
    start: { you: 11, foe: 15 }, f: { you: 1, foe: 1 }, homeMult: 1, acc: 0, t: 2, rally: 0, retreatAt: 0.6, reward: null, tag: '', odds: 0.5 });
  s.run.war.battles.push({ uid: 7, kind: 'gate', hex: -1, below: true, party: 0, raid: 4, you: { militia: 3, soldier: 5, supermajor: 0 }, foe: { n: 4, atk: 3, hp: 15 },
    start: { you: 8, foe: 6 }, f: { you: 1, foe: 1 }, homeMult: 1, acc: 0, t: 1, rally: 0, retreatAt: 0.6, reward: null, tag: '', odds: 0.5 });
  s.run.surface.sources.push({ uid: 20, type: 'seed_patch', hex: 9, stock: 150, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.sources.push({ uid: 21, type: 'dead_insect', hex: 14, stock: 30, max: 150, level: 1, herdT: 0, age: 0, ttl: 10, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 22, origin: 0, src: 20, path: [0, 2, 9], len: 2, job: 'forager', workers: 0, escorts: 3, S: 60, born: 0, reroutes: [] });
  s.run.surface.claimed[8] = 1;
  s.run.surface.flagged = [25];
  s.run.surface.scout = { target: 20, prog: 10 };
  s.run.surface.mound = 4;
  s.run.surface.entrances.push({ kind: 'nuptial', hex: 4, col: 30, ref: -1 });
  s.run.nest.shafts.push({ kind: 'nuptial', col: 30, open: true, ref: -1 });
  for (let y = 0; y < 22; y++) s.run.nest.cells[y * COLS + 30] = CELL.TUNNEL;
  s.cycle.daughters = [{ seed: 11, alates: 10 }, { seed: 12, alates: 30 }];
  s.cycle.traits.budding = 1;
  s.run.effects.push({ id: 'rally:2', stat: 'forage_trail', mult: 2, add: 0, scope: 2, t: 10 });
  d.surface.bestSource = 20;
  d.nest.agg.broodGroups.push({ kind: 'nursery', uid: 10, cap: 3, factor: 1, exposed: false, snap: false, inReach: false });
  ui.setUI({ overlays: { climate: true, raid_reach: true, haul: true, adjacency: true, territory: true, trail_strength: true, danger: true, richness: true },
    ghostDemo: { kind: 'trail', from: 0, to: 3 }, glow: 'crumb' });
  nest.input.hoverCell = 26 * COLS + 20;
  ui.setUI({ tool: { kind: 'placeChamber', chamber: 'gallery' } });
  game.bus.emit('eggLaid', { type: 'eggLaid', caste: 'minor', n: 1 });
  game.bus.emit('chamberActivated', { type: 'chamberActivated', uid: 10, type2: 'nursery', level: 1 });
  game.bus.emit('cellDug', { type: 'cellDug', i: 22 * COLS + 35 });
  game.bus.emit('cacheFound', { type: 'cacheFound', i: 23 * COLS + 25, kind: 'seed_cache', res: 'food', amount: 50 });
  game.bus.emit('clicked', { type: 'clicked', src: 1, amount: 1.5 });
  game.bus.emit('conquest', { type: 'conquest', uid: 3, tier: 1 });
  game.bus.emit('abilityUsed', { type: 'abilityUsed', id: 'mark', uid: 2 });
  game.bus.emit('abilityUsed', { type: 'abilityUsed', id: 'frenzy', uid: 0 });
  snap = JSON.stringify(game.s);
  stats.bad.length = 0;
  frames([nest, surf], 90, 1 / 30);
  ui.setUI({ tool: { kind: 'levelDir', uid: 12 } });
  frames([nest, surf], 5);
  ui.setUI({ tool: { kind: 'claim' } });
  surf.input.hoverHex = 30;
  frames([nest, surf], 5);
  ui.setUI({ tool: null });
  nest.input.drag = { cells: [22 * COLS + 36], ok: true, work: 4 };
  nest.input.rect = { x0: 21, y0: 22, x1: 25, y1: 22 };
  surf.input.trailDrag = { path: [0, 1, 2], ok: false, label: 'No source here' };
  surf.input.warDrag = { from: 0, to: 40, ok: true };
  frames([nest, surf], 5);
  assert.equal(JSON.stringify(game.s), snap, 'rendering the busy world never writes s');
  assert.deepEqual(stats.bad, [], 'no NaN arguments, negative radii or invalid colours reach the canvas');
  // the run reset event drops caches and rendering still works
  game.bus.emit('runStarted', { type: 'runStarted', index: 1 });
  game.s = createState({ seed: 99 });
  game.d = createDerived();
  frames([nest, surf], 10);
  assert.deepEqual(stats.bad, []);
  nest.destroy();
  surf.destroy();
});

test('sprite budgets: ≤ 160 Below, ≤ 260 Above, ≤ 600 drawImage calls per frame for both views', () => {
  const game = makeGame(5);
  const ui = makeUI();
  const s = game.s;
  s.run.colony.adults = { minor: 2e6, soldier: 3e5, supermajor: 2e4, replete: 1e3 };
  s.run.colony.jobs = { forager: 1.2e6, digger: 3e5, nurse: 1e5, scout: 1e5, herder: 5e4, leafcutter: 5e4, gardener: 1e5 };
  s.run.surface.trails[0].workers = 1e6;
  game.d.combat.garrison = { soldier: 2e5, supermajor: 1e4 };
  const nest = createNestRenderer(makeCanvas(900, 500), { game, ui, bus: game.bus });
  const surf = createSurfaceRenderer(makeCanvas(900, 520), { game, ui, bus: game.bus });
  frames([nest, surf], 20);
  assert.ok(nest.spriteCount > 0 && nest.spriteCount <= 160, `Below sprites ${nest.spriteCount}`);
  assert.ok(surf.spriteCount > 0 && surf.spriteCount <= 260, `Above sprites ${surf.spriteCount}`);
  stats.drawImage = 0;
  nest.render(1 / 60);
  surf.render(1 / 60);
  assert.ok(stats.drawImage <= 600, `drawImage calls ${stats.drawImage}`);
});

test('nest pick returns the documented Target kinds in priority order', () => {
  const game = makeGame();
  const ui = makeUI();
  const s = game.s;
  const nest = createNestRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
  nest.render(0.016);
  const at = (i) => {
    const p = cellPt(nest, i);
    return nest.pick(p.x, p.y);
  };
  assert.deepEqual(at(21 * COLS + 19), { view: 'nest', kind: 'queen', id: 1 });
  assert.deepEqual(at(20 * COLS + 21), { view: 'nest', kind: 'chamber', id: 1 });
  assert.deepEqual(at(10 * COLS + GRID.mainCol), { view: 'nest', kind: 'shaft', i: 10 * COLS + GRID.mainCol });
  assert.deepEqual(at(30 * COLS + 5), { view: 'nest', kind: 'cell', i: 30 * COLS + 5 });
  assert.equal(nest.pick(-50, -50), null);
  // dig face (first queued job's next cell)
  const face = 20 * COLS + 22;
  s.run.nest.queue = [{ uid: 9, kind: 'tunnel', chamber: 0, cells: [face], cur: 0, prog: 0, paidFood: 0, blueprint: false }];
  assert.deepEqual(at(face), { view: 'nest', kind: 'digFace', i: face });
  // cache hint
  const hint = 25 * COLS + 20;
  s.run.nest.features.caches = [{ i: hint, kind: 'seed_cache', found: false, hinted: true }];
  s.run.nest.rev++;
  assert.deepEqual(at(hint), { view: 'nest', kind: 'cacheHint', i: hint });
  // nursery
  s.run.nest.chambers.push({ uid: 7, type: 'nursery', k: 0, x: 10, y: 22, w: 3, h: 2, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 });
  for (let y = 22; y < 24; y++) for (let x = 10; x < 13; x++) s.run.nest.cells[y * COLS + x] = CELL.CHAMBER;
  s.run.nest.rev++;
  assert.deepEqual(at(23 * COLS + 11), { view: 'nest', kind: 'nursery', id: 7 });
  // mold beats the queen; pupa beats everything
  s.run.events.objects.push({ uid: 6, kind: 'mold', hex: -1, cell: 21 * COLS + 19, t: -1, data: {} });
  assert.deepEqual(at(21 * COLS + 19), { view: 'nest', kind: 'mold', id: 6 });
  s.run.golden.pupa = { chamber: 7, t: 10 };
  const v = nest.getView();
  const pp = { x: v.ox + (10 + 3 * 0.7) * v.cell, y: v.oy + (22 + 2 * 0.55) * v.cell };
  assert.deepEqual(nest.pick(pp.x, pp.y), { view: 'nest', kind: 'pupa' });
  // flood water in the topsoil rows
  s.run.effects.push({ id: 'flood', stat: 'chamber_layer', mult: 0, add: 0, scope: 'topsoil', t: 30 });
  assert.deepEqual(at(3 * COLS + GRID.mainCol), { view: 'nest', kind: 'flood' });
  assert.deepEqual(nest.cellAt(cellPt(nest, 33).x, cellPt(nest, 33).y), { x: 33, y: 0, i: 33 });
});

test('surface pick returns the documented Target kinds in priority order', () => {
  const game = makeGame();
  const ui = makeUI();
  const s = game.s;
  const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
  surf.render(0.016);
  const at = (h) => {
    const p = surf.hexToScreen(h);
    return surf.pick(p.x, p.y);
  };
  assert.deepEqual(at(3), { view: 'surface', kind: 'source', id: 1, hex: 3 });
  assert.deepEqual(at(0), { view: 'surface', kind: 'entrance', hex: 0 });
  assert.deepEqual(at(10), { view: 'surface', kind: 'hex', hex: 10 });
  const a = surf.hexToScreen(0);
  const b = surf.hexToScreen(3);
  assert.deepEqual(surf.pick((a.x + b.x) / 2, (a.y + b.y) / 2 + 2), { view: 'surface', kind: 'trail', id: 2 });
  assert.equal(surf.hexAt(-5000, -5000), -1);
  assert.equal(surf.hexAt(a.x, a.y), 0);
  s.run.rivals.list.push({ uid: 3, type: 'black_garden_ants', tier: 1, hex: 40, radius: 2, base: 15, n: 15, atk: 3, hp: 15, traits: [], alive: true,
    sighted: true, raidIn: 100, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1, extra: [], lost: [], stolen: 0 });
  assert.deepEqual(at(40), { view: 'surface', kind: 'rival', id: 3, hex: 40 });
  s.run.war.parties.push({ uid: 9, kind: 'raid', target: { type: 'rival', uid: 3 }, soldier: 5, supermajor: 0, path: [0, 1, 7], pos: 1, state: 'out' });
  assert.deepEqual(at(1), { view: 'surface', kind: 'party', id: 9 });
  s.run.events.objects.push({ uid: 5, kind: 'molehill', hex: 15, cell: -1, t: 20, data: {} });
  assert.deepEqual(at(15), { view: 'surface', kind: 'eventObject', id: 5, hex: 15 });
  s.run.golden.gifts = [{ hex: 12 }];
  assert.deepEqual(at(12), { view: 'surface', kind: 'gift', id: 0, hex: 12 });
  s.run.golden.beetle = { hex: 15, t: 10 };
  assert.equal(at(15).kind, 'beetle', 'beetle beats the event object on the same hex');
});

test('resizing and DPR changes keep picking accurate', () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(800, 480);
  const sc = makeCanvas(800, 480);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  const surf = createSurfaceRenderer(sc, { game, ui, bus: game.bus });
  frames([nest, surf], 2);
  for (const [w, h, dpr] of [[375, 812, 2], [1440, 900, 1.5], [640, 360, 3]]) {
    nc.rect = { left: 0, top: 0, width: w, height: h };
    sc.rect = { left: 0, top: 0, width: w, height: h };
    fakeWindow.devicePixelRatio = dpr;
    for (const fn of winListeners.resize || []) fn();
    frames([nest, surf], 2);
    assert.equal(nc.width, Math.round(w * Math.min(2, dpr)), 'backing store follows the capped DPR');
    const v = nest.getView();
    assert.ok(v.cell >= 3 && v.cell <= 40, `cell ${v.cell} at ${w}×${h}`);
    const q = cellPt(nest, 21 * COLS + 19);
    assert.ok(q.x >= 0 && q.x <= w && q.y >= 0 && q.y <= h, `the default framing keeps the queen in view at ${w}×${h}`);
    assert.equal(nest.pick(q.x, q.y).kind, 'queen');
    for (const i of [33, 20 * COLS + 21, 50 * COLS + 7]) {
      const p = cellPt(nest, i);
      assert.equal(nest.cellAt(p.x, p.y).i, i);
    }
    for (const hx of [0, 3, 10, 18]) {
      const p = surf.hexToScreen(hx);
      assert.equal(surf.hexAt(p.x, p.y), hx, `hex ${hx} at ${w}×${h}@${dpr}`);
    }
  }
  fakeWindow.devicePixelRatio = 1;
});

test('nest input dispatches only through actions / uistate / bridge', () => {
  const game = makeGame();
  const ui = makeUI();
  const bridge = makeBridge();
  const nc = makeCanvas(800, 600);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  nest.render(0.016);
  const detach = attachNestInput(nc, nest, { game, ui, bridge });
  const snap = JSON.stringify(game.s);
  const q = cellPt(nest, 21 * COLS + 19);
  click(nc, q.x, q.y);
  assert.deepEqual(game.calls.pop(), { type: 'clickQueen', args: {} });
  assert.equal(bridge.of('select').pop()[1].kind, 'queen');
  const ch = cellPt(nest, 20 * COLS + 21);
  click(nc, ch.x, ch.y);
  assert.deepEqual(bridge.of('openTab').pop(), ['openTab', 'build', 'inspect']);
  // dig face → helpDig
  const face = 20 * COLS + 22;
  game.s.run.nest.queue = [{ uid: 9, kind: 'tunnel', chamber: 0, cells: [face], cur: 0, prog: 0, paidFood: 0, blueprint: false }];
  const fp = cellPt(nest, face);
  click(nc, fp.x, fp.y);
  assert.deepEqual(game.calls.pop(), { type: 'helpDig', args: {} });
  game.s.run.nest.queue = [];
  // drag a tunnel from the shaft into the soil → digTunnel with a contiguous path
  const from = cellPt(nest, 10 * COLS + GRID.mainCol);
  const to = cellPt(nest, 10 * COLS + GRID.mainCol + 4);
  drag(nc, from.x, from.y, to.x, to.y);
  const dt = game.calls.pop();
  assert.equal(dt.type, 'digTunnel');
  // contiguous soil path from next to an open cell to the drop cell (nestgeom.routeTo or the straight fallback)
  const cells0 = game.s.run.nest.cells;
  const tc = dt.args.cells;
  assert.ok(tc.length >= 4);
  assert.equal(tc[tc.length - 1], 10 * COLS + GRID.mainCol + 4);
  const adj4 = (a, b) => (Math.abs(a - b) === COLS) || (Math.abs(a - b) === 1 && Math.floor(a / COLS) === Math.floor(b / COLS));
  const openAt = (i) => cells0[i] === CELL.TUNNEL || cells0[i] === CELL.CHAMBER;
  assert.ok([tc[0] - 1, tc[0] + 1, tc[0] - COLS, tc[0] + COLS].some((n) => n >= 0 && adj4(n, tc[0]) && openAt(n)), 'starts next to an open cell');
  for (let k = 1; k < tc.length; k++) assert.ok(adj4(tc[k - 1], tc[k]), 'contiguous');
  for (const i of tc) assert.equal(cells0[i], CELL.SOIL);
  // placement tool: click places at the ghost's top-left and clears the tool
  ui.setUI({ tool: { kind: 'placeChamber', chamber: 'gallery' } });
  const pc = cellPt(nest, 30 * COLS + 10);
  nc.fire('pointermove', ev(pc.x, pc.y));
  nest.render(0.016);
  click(nc, pc.x, pc.y);
  const place = game.calls.pop();
  assert.equal(place.type, 'placeChamber');
  assert.equal(place.args.chamber, 'gallery');
  assert.ok(Number.isInteger(place.args.x) && Number.isInteger(place.args.y));
  assert.equal(ui.getUI().tool, null, 'tool = null after a successful place');
  // Esc and right-click cancel a tool; right-click without a tool opens the context menu
  ui.setUI({ tool: { kind: 'backfill' } });
  for (const fn of winListeners.keydown || []) fn({ key: 'Escape', preventDefault() {} });
  assert.equal(ui.getUI().tool, null);
  nc.fire('contextmenu', ev(ch.x, ch.y, { button: 2 }));
  assert.equal(bridge.of('contextMenu').pop()[1].kind, 'chamber');
  // hover writes uistate.hover and calls bridge.hover
  nc.fire('pointermove', ev(q.x, q.y));
  assert.equal(ui.getUI().hover.kind, 'queen');
  assert.ok(bridge.of('hover').length > 0);
  // a rejected action is reported through bridge.reject
  game.actions.do = (type, args) => {
    game.calls.push({ type, args });
    return { ok: false, reason: 'clickCap' };
  };
  click(nc, q.x, q.y);
  assert.equal(bridge.of('reject').pop()[1], 'clickCap');
  // wheel scrolls
  const top0 = nest.getView().topRow;
  nc.fire('wheel', { deltaY: 300, deltaMode: 0, clientX: 10, clientY: 10, preventDefault() {} });
  assert.ok(nest.getView().topRow > top0);
  assert.equal(JSON.stringify(game.s.run.colony), JSON.stringify(JSON.parse(snap).run.colony), 'input never mutates the colony');
  detach();
  assert.equal((nc.listeners.pointerdown || []).length, 0, 'detach removes listeners');
});

test('nest camera input: Ctrl+wheel and the on-canvas buttons zoom, drag pans, Home re-frames, none reach the bridge', () => {
  const game = makeGame();
  const ui = makeUI();
  const bridge = makeBridge();
  const nc = makeCanvas(800, 400);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  frames([nest], 2);
  const detach = attachNestInput(nc, nest, { game, ui, bridge });
  const z0 = nest.getView().zoom;
  nc.fire('wheel', { deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: 400, clientY: 200, preventDefault() {} });
  const z1 = nest.getView().zoom;
  assert.ok(z1 > z0, 'Ctrl+wheel zooms in');
  // the "−" button (top-right cluster) zooms out without selecting anything
  let out = null;
  for (let x = 600; x < 800 && !out; x += 2) if (nest.controlAt(x, 20) === 'out') out = x;
  assert.ok(out, 'zoom-out button found');
  const before = bridge.rec.length;
  click(nc, out, 20);
  assert.ok(nest.getView().zoom < z1, 'button zooms out');
  assert.equal(bridge.of('select').length, 0);
  assert.ok(bridge.rec.slice(before).every((r) => r[0] === 'hover' || r[0] === 'reject'), 'buttons never select or open panels');
  // zoomed in past the width, a drag on soil pans horizontally
  nest.zoomAt(3, 400, 200);
  const v0 = nest.getView();
  assert.ok(v0.cell * COLS > 800);
  // start the drag on plain soil (a drag from an open cell plans a tunnel instead)
  let start = null;
  for (let y = 150; y < 390 && !start; y += 10) {
    for (let x = 300; x < 700 && !start; x += 10) {
      const c = nest.cellAt(x, y);
      if (c && game.s.run.nest.cells[c.i] === CELL.SOIL) start = { x, y };
    }
  }
  assert.ok(start, 'soil in view');
  drag(nc, start.x, start.y, start.x - 120, start.y);
  const v1 = nest.getView();
  assert.ok(v1.ox < v0.ox, 'dragged left: the grid followed the pointer');
  // Home (the crown button) brings back the default framing with the queen in view
  let home = null;
  for (let x = 600; x < 800 && !home; x += 2) if (nest.controlAt(x, 20) === 'home') home = x;
  click(nc, home, 20);
  const q = cellPt(nest, 21 * COLS + 19);
  assert.ok(q.x > 0 && q.x < 800 && q.y > 0 && q.y < 400, 'queen framed');
  assert.equal(game.calls.length, 0, 'camera input dispatches no game actions');
  detach();
});

test('surface input: forage click, trail drag, war drag, claim tool, beetle click, wheel zoom', () => {
  const game = makeGame();
  const ui = makeUI();
  const bridge = makeBridge();
  const sc = makeCanvas(800, 600);
  const surf = createSurfaceRenderer(sc, { game, ui, bus: game.bus });
  surf.render(0.016);
  const detach = attachSurfaceInput(sc, surf, { game, ui, bridge });
  const snap = JSON.stringify(game.s);
  const crumb = surf.hexToScreen(3);
  click(sc, crumb.x, crumb.y);
  assert.deepEqual(game.calls.pop(), { type: 'clickForage', args: { src: 1 } });
  assert.equal(bridge.of('select').pop()[1].kind, 'source');
  // trail drag from the entrance onto a source
  game.s.run.surface.sources.push({ uid: 20, type: 'seed_patch', hex: 9, stock: 150, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  const e0 = surf.hexToScreen(0);
  const sp = surf.hexToScreen(9);
  drag(sc, e0.x, e0.y, sp.x, sp.y);
  assert.deepEqual(game.calls.pop(), { type: 'drawTrail', args: { origin: 0, target: 9 } });
  // drag onto a rival nest → war chooser
  game.s.run.rivals.list.push({ uid: 3, type: 'pavement_ants', tier: 2, hex: 40, radius: 2, base: 15, n: 15, atk: 3, hp: 15, traits: [], alive: true,
    sighted: true, raidIn: 100, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1, extra: [], lost: [], stolen: 0 });
  surf.centerOn(0);
  surf.render(0.016);
  const e1 = surf.hexToScreen(0);
  const rv = surf.hexToScreen(40);
  drag(sc, e1.x, e1.y, rv.x, rv.y);
  assert.deepEqual(bridge.of('openChooser').pop(), ['openChooser', 'war', { kind: 'raid', target: { type: 'rival', uid: 3 } }]);
  // clicking a rival opens the war panel
  click(sc, rv.x, rv.y);
  assert.deepEqual(bridge.of('openTab').pop(), ['openTab', 'map', 'war']);
  // claim tool
  ui.setUI({ tool: { kind: 'claim' } });
  const h = surf.hexToScreen(10);
  click(sc, h.x, h.y);
  assert.deepEqual(game.calls.pop(), { type: 'claimHex', args: { hex: 10 } });
  ui.setUI({ tool: null });
  // golden beetle
  game.s.run.golden.beetle = { hex: 15, t: 10 };
  const bt = surf.hexToScreen(15);
  click(sc, bt.x, bt.y);
  assert.deepEqual(game.calls.pop(), { type: 'clickBeetle', args: {} });
  // wheel zooms around the cursor
  const z0 = surf.getCamera().zoom;
  sc.fire('wheel', { deltaY: -400, deltaMode: 0, clientX: 400, clientY: 300, preventDefault() {} });
  assert.ok(surf.getCamera().zoom > z0);
  // pan by dragging empty ground
  const c0 = surf.getCamera();
  const g0 = surf.hexToScreen(16);
  drag(sc, g0.x, g0.y, g0.x + 60, g0.y + 20);
  const c1 = surf.getCamera();
  assert.ok(c1.x !== c0.x || c1.y !== c0.y, 'the camera panned');
  assert.equal(game.calls.filter((c) => c.type === 'drawTrail').length, 0, 'a pan from empty ground draws no trail');
  assert.equal(JSON.stringify(game.s.run.colony), JSON.stringify(JSON.parse(snap).run.colony));
  detach();
});

test('surface input (C110): an event object on the entrance never blocks a trail drag; a plain click still hits it', () => {
  const game = makeGame();
  const ui = makeUI();
  const bridge = makeBridge();
  const sc = makeCanvas(800, 600);
  const surf = createSurfaceRenderer(sc, { game, ui, bus: game.bus });
  surf.render(0.016);
  const detach = attachSurfaceInput(sc, surf, { game, ui, bridge });
  game.s.run.surface.sources.push({ uid: 20, type: 'seed_patch', hex: 9, stock: 150, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  const objs = game.s.run.events.objects;
  for (const kind of ['myrmecophile', 'wandering_queen', 'army_column', 'footstep']) {
    objs.length = 0;
    objs.push({ uid: 900, kind, hex: 0, cell: -1, t: -1, data: { card: true } });
    surf.render(0.016);
    const e0 = surf.hexToScreen(0);
    assert.equal(surf.pick(e0.x, e0.y).kind, 'eventObject', `${kind} is picked on the entrance`);
    const sp = surf.hexToScreen(9);
    drag(sc, e0.x, e0.y, sp.x, sp.y);
    assert.deepEqual(game.calls.pop(), { type: 'drawTrail', args: { origin: 0, target: 9 } }, `${kind}: the drag drew a trail`);
    click(sc, e0.x, e0.y);
    assert.deepEqual(game.calls.pop(), { type: 'clickEventObject', args: { uid: 900 } }, `${kind}: a click still opens it`);
  }
  objs.length = 0;
  detach();
});

test('ceremonies draw on both views and resolve; minimaps and the seam draw headless', async () => {
  const game = makeGame();
  const ui = makeUI();
  const nest = createNestRenderer(makeCanvas(600, 400), { game, ui, bus: game.bus });
  const surf = createSurfaceRenderer(makeCanvas(600, 400), { game, ui, bus: game.bus });
  stats.bad.length = 0;
  for (const kind of ['flight', 'supercolony', 'speciation', 'timelapse', 'ending']) {
    const p = playCeremony(kind, { nest, surface: surf, summary: { alates: 42, seconds: 7200, cells: [22 * COLS + 22, 22 * COLS + 23], chambers: [1] } });
    assert.ok(activeCeremony(), `${kind} is active`);
    frames([nest, surf], 6);
    endCeremony();
    await p;
    assert.equal(activeCeremony(), null);
  }
  assert.deepEqual(stats.bad, []);
  const mm = makeCanvas(120, 120);
  drawMiniMap(mm, game.s.run.surface.terrain, game.s.run.surface.sources, 8);
  drawNestStrip(makeCanvas(24, 200), game.s, 5, 30);
  const seamCanvas = makeCanvas(800, 24);
  const seam = createSeam(seamCanvas, { game });
  const hub = seamHub(game);
  hub.clear();
  seam.toSurface(3, 'seed');
  seam.toNest(2, 'pellet');
  assert.equal(hub.pending('up'), 3);
  assert.equal(hub.pending('down'), 2);
  seam.render(0.016);
  assert.equal(hub.take('down').carry, 6, 'carry codes follow palette CARRY_CODES (pellet = 6)');
  seam.destroy();
  assert.deepEqual(stats.bad, []);
});

test('onboarding glows and ghost demos use the shared vocabulary; Below ants are drawn outlined', async () => {
  const { sourceGlows } = await import('../src/render/surfaceRenderer.js');
  const { getAtlas } = await import('../src/render/atlas.js');
  const crumb = { uid: 1, type: 'crumb_scatter' };
  const seeds = { uid: 20, type: 'seed_patch' };
  const d0 = { surface: { bestSource: 20 } };
  assert.equal(sourceGlows('canvas:crumb', crumb, d0), true);
  assert.equal(sourceGlows('canvas:crumb', seeds, d0), false);
  assert.equal(sourceGlows('canvas:bestSource', seeds, d0), true);
  assert.equal(sourceGlows('canvas:bestSource', crumb, d0), false);
  assert.equal(sourceGlows('source:1', crumb, d0), true);
  assert.equal(sourceGlows('tab:colony', crumb, d0), false);
  assert.equal(sourceGlows(null, crumb, d0), false);

  const atlas = getAtlas();
  const orig = atlas.drawAnt;
  const drawn = [];
  atlas.drawAnt = function (...args) {
    drawn.push({ kind: args[1], outline: args[9] || null });
    return orig.apply(this, args);
  };
  try {
    const game = makeGame(3);
    const ui = makeUI();
    game.s.run.colony.adults = { minor: 60, soldier: 0, supermajor: 0, replete: 0 };
    game.s.run.colony.jobs = { forager: 20, digger: 20, nurse: 10, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
    const nest = createNestRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
    const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
    stats.bad.length = 0;
    // ui/onboarding.js sends { kind: 'chamber', from: chamberType, to: cellIndex } and glow keys 'canvas:royal' / 'canvas:digFace'
    ui.setUI({ ghostDemo: { kind: 'chamber', from: 'gallery', to: 24 * COLS + 22 }, glow: 'canvas:royal' });
    game.s.run.nest.queue = [{ uid: 9, kind: 'tunnel', chamber: 0, cells: [20 * COLS + 22], cur: 0, prog: 0, paidFood: 0, blueprint: false }];
    frames([nest], 20, 1 / 30);
    assert.ok(drawn.some((c) => c.kind === 'ghost'), 'the chamber ghost-ant demo is drawn for a chamber-type `from`');
    const below = drawn.filter((c) => c.kind !== 'ghost');
    assert.ok(below.length > 0 && below.every((c) => typeof c.outline === 'string'), 'Below-view ants use outlined atlas strips');
    ui.setUI({ glow: 'canvas:digFace', ghostDemo: { kind: 'trail', from: 0, to: 3 } });
    drawn.length = 0;
    frames([nest, surf], 10, 1 / 30);
    assert.ok(drawn.some((c) => c.kind === 'ghost'), 'the trail ghost-ant demo is drawn on the Above view');
    ui.setUI({ glow: 'canvas:crumb', ghostDemo: null });
    frames([surf], 5, 1 / 30);
    assert.deepEqual(stats.bad, []);
    nest.destroy();
    surf.destroy();
  } finally {
    atlas.drawAnt = orig;
  }
});

test('battle bubbles: a gate fight in the shaft takes one sprite-battle slot (600 hard cap)', async () => {
  const { createBattleBubbles, MAX_SPRITE_BATTLES } = await import('../src/render/battle.js');
  const mk = (uid, hex, below = false) => ({ uid, kind: below ? 'gate' : 'raid', hex: below ? -1 : hex, below, party: 0, raid: 0,
    you: { militia: 0, soldier: 60, supermajor: 0 }, foe: { n: 60, atk: 3, hp: 15 }, start: { you: 60, foe: 60 }, f: { you: 1, foe: 1 },
    homeMult: 1, acc: 0, t: 1, rally: 0, retreatAt: 0.6, reward: null, tag: '', odds: 0.5 });
  const s = createState({ seed: 4 });
  s.run.war.battles = [mk(1, 5), mk(2, 9), mk(3, 12)];
  const bb = createBattleBubbles();
  bb.sync(s, null, null);
  assert.equal([...bb.views.values()].filter((v) => v.full).length, MAX_SPRITE_BATTLES);
  s.run.war.battles.push(mk(4, -1, true));
  bb.sync(s, null, null);
  const full = [...bb.views.values()].filter((v) => v.full);
  assert.equal(full.length, MAX_SPRITE_BATTLES - 1, 'the gate fight uses one slot');
  for (const v of full) assert.ok(v.you.length <= 40 && v.foe.length <= 40, '≤ 40 sprites per side');
});

test('playCeremony accepts the renderers or their canvases (speciation scrolls the nest to the Strata band)', async () => {
  const game = makeGame();
  const ui = makeUI();
  const nc = makeCanvas(600, 300);
  const sc = makeCanvas(600, 300);
  const nest = createNestRenderer(nc, { game, ui, bus: game.bus });
  const surf = createSurfaceRenderer(sc, { game, ui, bus: game.bus });
  frames([nest, surf], 2);
  assert.ok(nest.getView().topRow < 25, 'default framing sits around the Royal Chamber, well above the Strata band');
  const p = playCeremony('speciation', { nest: nc, surface: sc, summary: {} });
  assert.ok(nest.getView().topRow > 40, 'the canvas resolved to its renderer');
  frames([nest, surf], 3);
  endCeremony();
  await p;
  nest.scrollToRow(0);
  const p2 = playCeremony('speciation', { nest, surface: surf, summary: {} });
  assert.ok(nest.getView().topRow > 40, 'a renderer works directly');
  endCeremony();
  await p2;
});

test('terrain (C111): linked puddles and garden paths paint in every season with finite, valid calls; groundUnder', async () => {
  const { groundUnder } = await import('../src/render/surfaceRenderer.js');
  const game = makeGame();
  const ter = game.s.run.surface.terrain;
  // a 3-hex pool around the centre ring and a garden-path strip through ring 2, plus a lone puddle
  for (const i of [1, 2, 7]) ter[i] = 6;
  for (const i of [9, 10, 11, 23]) ter[i] = 3;
  ter[40] = 6;
  const n = ter.length;
  assert.ok(['grass', 'sand', 'leaf_litter'].includes(groundUnder(ter, 1, n)));
  assert.equal(groundUnder(ter, 1, n), groundUnder(ter, 1, n), 'deterministic');
  const surf = createSurfaceRenderer(makeCanvas(800, 600), { game, ui: makeUI(), bus: game.bus });
  stats.bad.length = 0;
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    game.d.season.id = season;
    surf.render(0.016);
  }
  assert.deepEqual(stats.bad, []);
});

test('C154 / C156: a reserved cell picks its chamber (no grooming), water inside keeps its pocket; the badge pass draws cleanly', () => {
  const game = makeGame();
  const ui = makeUI();
  const s = game.s;
  const nest = createNestRenderer(makeCanvas(800, 600), { game, ui, bus: game.bus });
  nest.render(0.016);
  const at = (i) => {
    const p = cellPt(nest, i);
    return nest.pick(p.x, p.y);
  };
  // the Royal Chamber's reserved L8 room: x 13–21, rows 20–23 (its room is x 18–21, rows 20–21)
  const cell = 23 * COLS + 14;
  assert.deepEqual(at(cell), { view: 'nest', kind: 'chamber', id: 1, reserved: true, i: cell });
  // discoloured soil (a cache hint) inside the reservation selects the chamber too
  const hint = 22 * COLS + 15;
  s.run.nest.features.caches = [{ i: hint, kind: 'seed_cache', found: false, hinted: true }];
  s.run.nest.rev++;
  assert.deepEqual(at(hint), { view: 'nest', kind: 'chamber', id: 1, reserved: true, i: hint });
  // a nursery's reserved cell is kind 'chamber' (a click there inspects, never grooms)
  s.run.nest.chambers.push({ uid: 7, type: 'nursery', k: 0, x: 4, y: 40, w: 3, h: 2, level: 1, target: 1, status: 'active', blueprint: false,
    bornAt: 0, res: { x: 4, y: 40, w: 8, h: 4 } });
  for (let y = 40; y < 42; y++) for (let x = 4; x < 7; x++) s.run.nest.cells[y * COLS + x] = CELL.CHAMBER;
  s.run.nest.rev++;
  assert.deepEqual(at(43 * COLS + 9), { view: 'nest', kind: 'chamber', id: 7, reserved: true, i: 43 * COLS + 9 });
  assert.deepEqual(at(41 * COLS + 5), { view: 'nest', kind: 'nursery', id: 7 }, 'its room still grooms');
  // a revealed water pocket inside a reservation keeps its own inspect (drain / move clears the room)
  for (const c of [42 * COLS + 10, 42 * COLS + 11, 43 * COLS + 10, 43 * COLS + 11]) s.run.nest.cells[c] = CELL.WATER;
  s.run.nest.features.water.push({ x: 10, y: 42, w: 2, h: 2, revealed: true });
  s.run.nest.rev++;
  assert.equal(at(42 * COLS + 10).kind, 'pocket');
  // rendering with reservations, an affordable upgrade (▲ badge) and every zoom stays valid
  Object.assign(s.run.res, { food: 1e9, soil: 1e9 });
  s.run.unlocked.royal_levelup = true;
  stats.bad.length = 0;
  for (const z of [1, 2, 3]) {
    nest.setZoom ? nest.setZoom(z) : null;
    frames([nest], 3);
  }
  ui.setUI({ hover: { view: 'nest', kind: 'chamber', id: 1, reserved: true, i: cell } });
  frames([nest], 3);
  assert.deepEqual(stats.bad, []);
});
