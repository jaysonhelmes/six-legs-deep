// WP3 nest geometry tests: indexing, layers, footprints (DESIGN §7.4), cell work per layer incl. modifiers (§7.1–§7.3),
// diggability, BFS and A* fixtures (ARCHITECTURE §15.3 #10), adjacency (§7.7), frost exposure majority rule (§17.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import * as G from '../src/systems/nestgeom.js';

const { idx } = G;

function setCells(s, list, code) {
  for (const c of list) s.run.nest.cells[c] = code;
  s.run.nest.rev++;
}

function addChamber(s, type, x, y, w, h, { level = 1, status = 'active' } = {}) {
  const nest = s.run.nest;
  const ch = { uid: nest.nextUid++, type, k: nest.chambers.filter((c) => c.type === type).length, x, y, w, h, level, target: level,
    status, blueprint: false, bornAt: 0 };
  nest.chambers.push(ch);
  if (status !== 'digging') setCells(s, G.rectCells(x, y, w, h), CELL.CHAMBER);
  else nest.rev++;
  return ch;
}

test('idx / xy / inBounds round-trip on the 40 × 80 grid', () => {
  assert.equal(idx(20, 0), 20);
  assert.equal(idx(0, 1), 40);
  assert.deepEqual(G.xy(idx(13, 57)), [13, 57]);
  assert.equal(G.inBounds(39, 79), true);
  assert.equal(G.inBounds(40, 0), false);
  assert.equal(G.inBounds(-1, 0), false);
  assert.equal(G.inBounds(0, 80), false);
  assert.equal(G.inBounds(1.5, 2), false);
});

test('layerOf follows the DESIGN §7.1 strata table', () => {
  const want = [[0, 'topsoil'], [9, 'topsoil'], [10, 'loam'], [23, 'loam'], [24, 'clay'], [39, 'clay'], [40, 'gravel'],
    [57, 'gravel'], [58, 'bedrock'], [73, 'bedrock'], [74, 'aquifer'], [79, 'aquifer']];
  for (const [y, id] of want) assert.equal(G.layerOf(y), id, 'row ' + y);
});

test('footprint growth: 3×2 Gallery becomes 10×4 at L8 and stops growing; no-growth types keep w0 × h0', () => {
  assert.deepEqual(G.footprint('gallery', 1), { w: 3, h: 2 });
  assert.deepEqual(G.footprint('gallery', 4), { w: 6, h: 3 });
  assert.deepEqual(G.footprint('gallery', 8), { w: 10, h: 4 });
  assert.deepEqual(G.footprint('gallery', 20), { w: 10, h: 4 });
  assert.deepEqual(G.footprint('gallery', 0), { w: 3, h: 2 });
  assert.deepEqual(G.footprint('royal_chamber', 5), { w: 8, h: 3 });
  assert.deepEqual(G.footprint('thermal_chimney', 6), { w: 2, h: 4 });
  assert.deepEqual(G.footprint('gate', 3), { w: 2, h: 2 });
  assert.deepEqual(G.footprint('nope', 3), { w: 0, h: 0 });
});

test('rectCells clips to the grid', () => {
  assert.deepEqual(G.rectCells(0, 0, 2, 2), [0, 1, 40, 41]);
  assert.equal(G.rectCells(38, 78, 5, 5).length, 4);
});

test('cellWork: base layer work and every modifier of ARCHITECTURE §8.2', () => {
  const s = newState();
  const rows = { topsoil: 5, loam: 12, clay: 30, gravel: 45, bedrock: 60, aquifer: 76 };
  const base = { topsoil: 4, loam: 6, clay: 10, gravel: 16, bedrock: 40, aquifer: 120 };
  for (const [layer, y] of Object.entries(rows)) {
    assert.equal(G.cellWork(s, idx(5, y), 'tunnel'), base[layer], layer + ' tunnel');
    assert.equal(G.cellWork(s, idx(5, y), 'chamber'), base[layer] * 1.5, layer + ' chamber');
    assert.equal(G.cellWork(s, idx(5, y), 'grow'), base[layer] * 1.5, layer + ' grow');
  }
  // clay_masonry: clay 10 → 7.2
  s.run.research.clay_masonry = 1;
  assert.equal(G.cellWork(s, idx(5, 30), 'tunnel'), 7.2);
  delete s.run.research.clay_masonry;
  // load_chains: tunnel ×0.5 (and shafts), chambers unchanged
  s.run.research.load_chains = 1;
  assert.equal(G.cellWork(s, idx(5, 12), 'tunnel'), 3);
  assert.equal(G.cellWork(s, idx(5, 12), 'shaft'), 3);
  assert.equal(G.cellWork(s, idx(5, 12), 'chamber'), 9);
  // ach_going_under: tunnel ×0.95 (stacks)
  s.meta.achievements.ach_going_under = 0;
  assert.ok(Math.abs(G.cellWork(s, idx(5, 12), 'tunnel') - 6 * 0.5 * 0.95) < 1e-12);
  delete s.run.research.load_chains;
  delete s.meta.achievements.ach_going_under;
  // site_rich_loam: topsoil and loam ×0.8 only
  s.run.landingTags = ['site_rich_loam'];
  assert.ok(Math.abs(G.cellWork(s, idx(5, 5), 'tunnel') - 3.2) < 1e-12);
  assert.ok(Math.abs(G.cellWork(s, idx(5, 12), 'tunnel') - 4.8) < 1e-12);
  assert.equal(G.cellWork(s, idx(5, 30), 'tunnel'), 10);
  s.run.landingTags = [];
  // shallow_soil reward: −5 % per effective tier (cycle tier, or 50 % of the era best)
  s.cycle.hardshipTier.shallow_soil = 2;
  assert.ok(Math.abs(G.cellWork(s, idx(5, 12), 'tunnel') - 6 * 0.9) < 1e-12);
  s.cycle.hardshipTier = {};
  s.era.hardshipBest.shallow_soil = 4;
  assert.ok(Math.abs(G.cellWork(s, idx(5, 12), 'tunnel') - 6 * 0.9) < 1e-12);
  s.era.hardshipBest = {};
  // stone ×3
  s.run.nest.cells[idx(5, 45)] = CELL.STONE;
  assert.equal(G.cellWork(s, idx(5, 45), 'tunnel'), 48);
  // blueprint jobs: ÷3 with ancestral_blueprint, ÷5 with blueprint_memory, ÷2 more during boon_blueprint_rush
  s.cycle.traits.ancestral_blueprint = 1;
  assert.equal(G.cellWork(s, idx(5, 12), 'chamber', { blueprint: true }), 3);
  s.era.federation.blueprint_memory = 1;
  assert.ok(Math.abs(G.cellWork(s, idx(5, 12), 'chamber', { blueprint: true }) - 1.8) < 1e-12);
  s.run.boon = 'boon_blueprint_rush';
  s.run.time = 100;
  assert.ok(Math.abs(G.cellWork(s, idx(5, 12), 'chamber', { blueprint: true }) - 0.9) < 1e-12);
  s.run.time = 700;
  assert.ok(Math.abs(G.cellWork(s, idx(5, 12), 'chamber', { blueprint: true }) - 1.8) < 1e-12);
  assert.equal(G.cellWork(s, idx(5, 12), 'chamber'), 9, 'non-blueprint jobs unaffected');
  assert.equal(G.cellWork(s, -1, 'tunnel'), 0);
});

test('isDiggable: SOIL; STONE only with acid; bedrock needs acid_excavation, aquifer needs aquifer_access; shallow_soil row cap', () => {
  const s = newState();
  assert.equal(G.isDiggable(s, idx(5, 5)), true);
  assert.equal(G.isDiggable(s, idx(20, 5)), false, 'tunnel is not diggable');
  assert.equal(G.isDiggable(s, idx(19, 20)), false, 'royal chamber cell');
  s.run.nest.cells[idx(5, 30)] = CELL.STONE;
  s.run.nest.cells[idx(6, 30)] = CELL.WATER;
  assert.equal(G.isDiggable(s, idx(5, 30)), false);
  assert.equal(G.isDiggable(s, idx(6, 30)), false);
  assert.equal(G.isDiggable(s, idx(5, 60)), false, 'bedrock locked');
  assert.equal(G.isDiggable(s, idx(5, 76)), false, 'aquifer locked');
  s.run.research.acid_excavation = 1;
  assert.equal(G.isDiggable(s, idx(5, 30)), true, 'stone with acid');
  assert.equal(G.isDiggable(s, idx(6, 30)), false, 'water never');
  assert.equal(G.isDiggable(s, idx(5, 60)), true);
  assert.equal(G.isDiggable(s, idx(5, 76)), false);
  s.era.federation.aquifer_access = 1;
  assert.equal(G.isDiggable(s, idx(5, 76)), true);
  s.run.hardship = 'shallow_soil';
  assert.equal(G.isDiggable(s, idx(5, 23)), true);
  assert.equal(G.isDiggable(s, idx(5, 24)), false);
  assert.equal(G.isDiggable(s, 99999), false);
});

test('bfs fixture: path distances over open cells, unreachable = −1', () => {
  const s = newState();
  const open = new Uint8Array(GRID.cols * GRID.rows);
  for (let i = 0; i < open.length; i++) open[i] = s.run.nest.cells[i] === CELL.TUNNEL || s.run.nest.cells[i] === CELL.CHAMBER ? 1 : 0;
  const dist = G.bfs(open, [idx(20, 0)]);
  assert.equal(dist[idx(20, 0)], 0);
  assert.equal(dist[idx(20, 19)], 19);
  assert.equal(dist[idx(20, 20)], 20);
  assert.equal(dist[idx(18, 21)], 23);
  assert.equal(dist[idx(5, 5)], -1);
  // Non-open starts are ignored.
  const none = G.bfs(open, [idx(5, 5)]);
  assert.ok(none.every((v) => v === -1));
  // Multi-source
  const two = G.bfs(open, [idx(20, 0), idx(21, 21)]);
  assert.equal(two[idx(21, 20)], 1);
});

test('routeTo (A*) fixtures: shortest work route, stones and chambers impassable, already-adjacent target', () => {
  const s = newState();
  const d = makeDerived();
  // Target 3 cells east of the shaft in topsoil: dig (21,5),(22,5) to touch (23,5).
  const r = G.routeTo(s, d, [idx(23, 5)]);
  assert.deepEqual(r.cells, [idx(21, 5), idx(22, 5)]);
  assert.equal(r.work, 8);
  // Already touching: empty route.
  assert.deepEqual(G.routeTo(s, d, [idx(21, 5)]), { cells: [], work: 0 });
  // load_chains halves the route work.
  s.run.research.load_chains = 1;
  assert.equal(G.routeTo(s, d, [idx(23, 5)]).work, 4);
  delete s.run.research.load_chains;
  // A wall of stone at column 22 rows 0..12 forces the route below it (cheaper than nothing; stones never crossed).
  const wall = [];
  for (let y = 0; y <= 12; y++) wall.push(idx(22, y));
  setCells(s, wall, CELL.STONE);
  const r2 = G.routeTo(s, d, [idx(24, 5)]);
  assert.ok(r2 && r2.cells.length > 0);
  for (const c of r2.cells) assert.notEqual(s.run.nest.cells[c], CELL.STONE);
  assert.ok(r2.cells.some((c) => G.xy(c)[1] === 13), 'goes around the stone wall at row 13');
  // Work equals the sum of tunnel work of the returned cells.
  let w = 0;
  for (const c of r2.cells) w += G.cellWork(s, c, 'tunnel');
  assert.ok(Math.abs(w - r2.work) < 1e-9);
  // Fully enclosed target → null.
  const box = [];
  for (let x = 30; x <= 34; x++) for (let y = 30; y <= 34; y++) if (x === 30 || x === 34 || y === 30 || y === 34) box.push(idx(x, y));
  setCells(s, box, CELL.STONE);
  assert.equal(G.routeTo(s, d, [idx(32, 32)]), null);
  assert.equal(G.routeTo(s, d, []), null);
});

test('routeTo prefers cheap layers: equal-length detours through topsoil beat loam', () => {
  const s = newState();
  const d = makeDerived();
  const r = G.routeTo(s, d, [idx(25, 9)]);
  // 4 cells from the shaft along row 9 (topsoil, 4 each) = 16
  assert.equal(r.work, 16);
  assert.equal(r.cells.length, 4);
});

test('adjacent: footprints touching, or joined by ≤ 4 open tunnel cells (DESIGN §7.7)', () => {
  const s = newState();
  const d = makeDerived();
  const royal = s.run.nest.chambers[0]; // x 18..21, y 20..21
  const touch = addChamber(s, 'nursery', 22, 20, 3, 2);
  assert.equal(G.adjacent(s, d, touch, royal), true);
  assert.equal(G.adjacent(s, d, royal.uid, touch.uid), true);
  // Tunnel of 4 cells (x 22..25 at y 23 under a far nursery) — build a fresh state for clarity.
  const s2 = newState();
  const t4 = [];
  for (let x = 22; x <= 25; x++) t4.push(idx(x, 21));
  setCells(s2, t4, CELL.TUNNEL);
  const far4 = addChamber(s2, 'nursery', 26, 20, 3, 2);
  assert.equal(G.adjacent(s2, makeDerived(), far4, s2.run.nest.chambers[0]), true, '4 tunnel cells');
  const s3 = newState();
  const t5 = [];
  for (let x = 22; x <= 26; x++) t5.push(idx(x, 21));
  setCells(s3, t5, CELL.TUNNEL);
  const far5 = addChamber(s3, 'nursery', 27, 20, 3, 2);
  assert.equal(G.adjacent(s3, makeDerived(), far5, s3.run.nest.chambers[0]), false, '5 tunnel cells');
  // Rect (ghost) arguments
  assert.equal(G.adjacent(s, d, { x: 14, y: 20, w: 4, h: 2 }, royal), true);
  assert.equal(G.adjacent(s, d, { x: 5, y: 40, w: 3, h: 2 }, royal), false);
});

test('exposedTo: more than half of the cells above the frost row (majority rule)', () => {
  const ch2 = { x: 0, y: 17, w: 3, h: 2 };
  assert.equal(G.exposedTo(ch2, 18), false, '1 of 2 rows is not a majority');
  assert.equal(G.exposedTo(ch2, 19), true);
  const ch3 = { x: 0, y: 16, w: 3, h: 3 };
  assert.equal(G.exposedTo(ch3, 18), true, '2 of 3 rows');
  assert.equal(G.exposedTo(ch3, 17), false);
  assert.equal(G.exposedTo(ch3, 0), false);
  assert.equal(G.exposedTo(ch3, 17.5), true, 'fractional frost row covers row 17');
  assert.equal(G.exposedTo({ x: 0, y: 20, w: 4, h: 2 }, 18), false, 'Royal Chamber below the hard frost line');
});

test('rectLayer: majority of cells, ties go deeper', () => {
  assert.equal(G.rectLayer({ x: 0, y: 8, w: 3, h: 2 }), 'topsoil');
  assert.equal(G.rectLayer({ x: 0, y: 9, w: 3, h: 2 }), 'loam', 'tie → deeper');
  assert.equal(G.rectLayer({ x: 0, y: 8, w: 3, h: 3 }), 'topsoil');
  assert.equal(G.rectLayer({ x: 0, y: 20, w: 4, h: 2 }), 'loam');
});
