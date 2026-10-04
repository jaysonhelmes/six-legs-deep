// WP3 placement tests: validatePlacement reasons, tints and modifiers, auto-route and player routes, placement rules,
// queue limit, placement / level cost curves (ARCHITECTURE §15.3 #1), findPlacement (DESIGN §7.4–§7.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived } from './helpers.js';
import { CELL } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import * as nest from '../src/systems/nest.js';
import { idx, rectCells, xy, footprint as nestgeomFootprint } from '../src/systems/nestgeom.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

function setup({ food = 1e6, soil = 1e6 } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 0 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  s.run.res.food = food;
  s.run.res.soil = soil;
  s.run.res.chitin = 1e6;
  s.run.res.honeydew = 1e6;
  nest.derive(s, d);
  return { s, d };
}

function setCells(s, list, code) {
  for (const c of list) s.run.nest.cells[c] = code;
  s.run.nest.rev++;
}

function addChamber(s, type, x, y, w, h, { level = 1, status = 'active' } = {}) {
  const n = s.run.nest;
  const ch = { uid: n.nextUid++, type, k: n.chambers.filter((c) => c.type === type).length, x, y, w, h, level, target: level,
    status, blueprint: false, bornAt: 0 };
  n.chambers.push(ch);
  setCells(s, rectCells(x, y, w, h), CELL.CHAMBER);
  return ch;
}

const vp = (s, d, type, x, y, o) => nest.validatePlacement(s, d, type, x, y, o);

test('valid direct placement: ok, route null, work = footprint chamber work, cost = placement food', () => {
  const { s, d } = setup();
  const r = vp(s, d, 'gallery', 21, 24); // loam/clay border: rows 24–25 clay (10 × 1.5 = 15 per cell)
  // Not connected at row 24 → auto-route; use a spot next to the shaft instead.
  assert.ok(r.reason === null || r.route);
  const g = vp(s, d, 'gallery', 21, 12);
  assert.equal(g.ok, true);
  assert.equal(g.reason, null);
  assert.equal(g.route, null);
  assert.equal(g.work, 6 * 6 * 1.5);
  assert.deepEqual(g.cost, { food: 40 });
  assert.equal(g.eta, -1, 'no diggers → unknown eta');
  d.stats.digW = 9;
  assert.equal(vp(s, d, 'gallery', 21, 12).eta, 6);
  assert.ok(Array.isArray(g.mods));
});

test('reasons: locked, max, invalid:bounds, invalid:row, blocked:* cells, hardship, cantAfford', () => {
  const { s, d } = setup();
  delete s.run.unlocked.chamber_gallery;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, 'locked');
  s.run.unlocked.chamber_gallery = true;
  assert.equal(vp(s, d, 'nope', 21, 12).reason, 'invalid');
  assert.equal(vp(s, d, 'gallery', 38, 12).reason, 'invalid:bounds');
  assert.equal(vp(s, d, 'gallery', -1, 12).reason, 'invalid:bounds');
  assert.equal(vp(s, d, 'gallery', 21, 0).reason, 'invalid:row');
  assert.equal(vp(s, d, 'fungus_garden', 21, 12).reason, 'invalid:row');
  assert.equal(vp(s, d, 'hibernaculum', 21, 25).reason, 'invalid:row');
  assert.equal(vp(s, d, 'deep_vault', 5, 50).reason, 'invalid:row');
  // Cells
  setCells(s, [idx(22, 12)], CELL.STONE);
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, 'blocked:stone');
  s.run.research.acid_excavation = 1;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, null);
  delete s.run.research.acid_excavation;
  setCells(s, [idx(22, 12)], CELL.WATER);
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, 'blocked:water');
  setCells(s, [idx(22, 12)], CELL.SOIL);
  // C125: a footprint may cover shaft cells below the shaft's top two rows (the shaft passes through it)
  assert.equal(vp(s, d, 'gallery', 19, 18).reason, null);
  assert.equal(vp(s, d, 'gallery', 19, 1).reason, 'blocked:shaft');
  assert.equal(vp(s, d, 'gallery', 20, 21).reason, 'blocked:chamber');
  assert.equal(vp(s, d, 'deep_vault', 5, 60).reason, 'blocked:layer');
  s.run.hardship = 'shallow_soil';
  assert.equal(vp(s, d, 'gallery', 21, 23).reason, 'hardship');
  s.run.hardship = null;
  s.run.res.food = 10;
  const poor = vp(s, d, 'gallery', 21, 12);
  assert.equal(poor.reason, 'cantAfford');
  assert.equal(poor.tint, 'red');
  assert.equal(poor.ok, false);
  assert.equal(poor.work, 54, 'work still reported for the ghost');
});

test('instance limit: Gallery 4 (+2 gallery_arches); Royal 1 (+1 polygyny, +2 queens_council, + species royalStart − 1)', () => {
  const { s, d } = setup();
  for (let k = 0; k < 4; k++) addChamber(s, 'gallery', 2 + 4 * k, 40, 3, 2);
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, 'max');
  s.run.research.gallery_arches = 1;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, null);
  assert.equal(vp(s, d, 'royal_chamber', 22, 20).reason, 'max');
  s.cycle.traits.polygyny = 1;
  assert.equal(vp(s, d, 'royal_chamber', 22, 20).reason, null);
  assert.equal(vp(s, d, 'royal_chamber', 22, 19).reason, 'invalid:row', 'extra Royal Chambers need row ≥ 20');
  delete s.cycle.traits.polygyny;
  d.meta.sp = { royalStart: 2 };
  assert.equal(vp(s, d, 'royal_chamber', 22, 20).reason, null);
});

test('leafcutter species: Fungus Gardens allowed from row 10', () => {
  const { s, d } = setup();
  d.meta.sp = { gardenRowMin: 10 };
  assert.notEqual(vp(s, d, 'fungus_garden', 21, 12).reason, 'invalid:row');
  assert.equal(vp(s, d, 'fungus_garden', 21, 12).reason, null);
});

test('auto-route: a footprint that touches no open cell gets the cheapest tunnel; route work is included', () => {
  const { s, d } = setup();
  const r = vp(s, d, 'gallery', 25, 12);
  assert.equal(r.ok, true);
  assert.deepEqual(r.route, [idx(21, 12), idx(22, 12), idx(23, 12), idx(24, 12)]);
  assert.equal(r.work, 4 * 6 + 6 * 9);
  // Unreachable (enclosed by stone) → blocked:route
  const box = [];
  for (let x = 4; x <= 10; x++) for (let y = 40; y <= 45; y++) if (x === 4 || x === 10 || y === 40 || y === 45) box.push(idx(x, y));
  setCells(s, box, CELL.STONE);
  assert.equal(vp(s, d, 'gallery', 6, 42).reason, 'blocked:route');
});

test('player-drawn routes are validated (contiguous, start next to the nest, end next to the footprint)', () => {
  const { s, d } = setup();
  const good = [idx(21, 11), idx(22, 11), idx(23, 11), idx(24, 11), idx(24, 12)];
  const r = vp(s, d, 'gallery', 25, 12, { route: good });
  assert.equal(r.reason, null);
  assert.deepEqual(r.route, good);
  assert.equal(vp(s, d, 'gallery', 25, 12, { route: [idx(21, 11), idx(23, 11)] }).reason, 'invalid:route');
  assert.equal(vp(s, d, 'gallery', 25, 12, { route: [idx(22, 11), idx(23, 11), idx(24, 11), idx(24, 12)] }).reason, 'invalid:route');
  assert.equal(vp(s, d, 'gallery', 25, 12, { route: [idx(21, 11), idx(22, 11)] }).reason, 'invalid:route');
  setCells(s, [idx(23, 11)], CELL.STONE);
  assert.equal(vp(s, d, 'gallery', 25, 12, { route: good }).reason, 'blocked:route');
});

test('placement rules: touchRoot, touchRow0, shaftTop (rows 0–6), touchWater (one well per revealed pocket)', () => {
  const { s, d } = setup();
  s.run.nest.features.roots = [{ col: 24, y0: 1, y1: 12 }];
  s.run.nest.rev++;
  assert.equal(vp(s, d, 'root_aphid_pen', 21, 3).reason, null, 'pen at x 21..23 touches root column 24');
  assert.equal(vp(s, d, 'root_aphid_pen', 21, 14).reason, 'invalid:root');
  assert.equal(vp(s, d, 'thermal_chimney', 21, 0).reason, null);
  assert.equal(vp(s, d, 'thermal_chimney', 21, 1).reason, 'invalid:row0');
  assert.equal(vp(s, d, 'gate', 21, 0).reason, null);
  assert.equal(vp(s, d, 'gate', 18, 3).reason, null);
  assert.equal(vp(s, d, 'gate', 22, 0).reason, 'invalid:shaft');
  assert.equal(vp(s, d, 'gate', 21, 6).reason, 'invalid:row', 'gate must lie within rows 0–6');
  // Water well: needs a revealed pocket; one well per pocket.
  s.run.nest.features.water = [{ x: 24, y: 12, w: 2, h: 2, revealed: false }];
  setCells(s, rectCells(24, 12, 2, 2), CELL.WATER);
  assert.equal(vp(s, d, 'water_well', 22, 11).reason, 'max', 'no revealed pocket → limit 0');
  s.run.nest.features.water[0].revealed = true;
  s.run.nest.rev++;
  assert.equal(vp(s, d, 'water_well', 22, 11).reason, null);
  assert.equal(vp(s, d, 'water_well', 21, 15).reason, 'invalid:water');
  addChamber(s, 'water_well', 22, 11, 2, 3);
  assert.equal(vp(s, d, 'water_well', 26, 11).reason, 'max');
});

test('nuptial chamber: row ≥ 24, plans its own exit shaft ≥ 3 columns from every shaft (not through the main shaft)', () => {
  const { s, d } = setup();
  assert.equal(vp(s, d, 'nuptial_chamber', 18, 20).reason, 'invalid:row');
  const r = vp(s, d, 'nuptial_chamber', 18, 24);
  assert.equal(r.reason, null);
  assert.ok(r.route && r.route.length >= 2, 'auto-routed from the Royal Chamber');
  assert.equal(vp(s, d, 'nuptial_chamber', 18, 24, { shaftCol: 21 }).reason, 'invalid:shaftCol');
  assert.equal(vp(s, d, 'nuptial_chamber', 18, 24, { shaftCol: 30 }).reason, null);
  // Blocked: stones across every candidate column at row 22 except the shaft-adjacent ones
  const wall = [];
  for (let x = 0; x < 40; x++) if (Math.abs(x - 20) >= 3) wall.push(idx(x, 10));
  setCells(s, wall, CELL.STONE);
  assert.equal(vp(s, d, 'nuptial_chamber', 18, 24).reason, 'blocked:shaft');
});

test('queue limit: 5 jobs (+2 load_chains, +2 automaton_instincts) → queueFull', () => {
  const { s, d } = setup();
  for (let k = 0; k < 5; k++) {
    s.run.nest.queue.push({ uid: 900 + k, kind: 'tunnel', chamber: 0, cells: [idx(1, 60 + k)], cur: 0, prog: 0, paidFood: 0, blueprint: false });
  }
  s.run.nest.rev++;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, 'queueFull');
  s.run.research.load_chains = 1;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, null);
  for (let k = 5; k < 7; k++) {
    s.run.nest.queue.push({ uid: 900 + k, kind: 'tunnel', chamber: 0, cells: [idx(1, 60 + k)], cur: 0, prog: 0, paidFood: 0, blueprint: false });
  }
  s.run.nest.rev++;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, 'queueFull');
  s.cycle.traits.automaton_instincts = 1;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, null);
  // Cells already queued by another job cannot hold a footprint.
  s.run.nest.queue.push({ uid: 999, kind: 'tunnel', chamber: 0, cells: [idx(22, 12)], cur: 0, prog: 0, paidFood: 0, blueprint: false });
  s.run.nest.rev++;
  assert.equal(vp(s, d, 'gallery', 21, 12).reason, 'blocked:queued');
});

test('tints and modifiers: frost-exposed / flood zone / raid reach → amber; deep connected → green; adjacency, layer, haul', () => {
  const { s, d } = setup();
  const shallow = vp(s, d, 'gallery', 21, 12);
  assert.equal(shallow.tint, 'amber');
  assert.ok(shallow.mods.some((m) => m.key === 'frostExposed' && m.value === 0.5));
  assert.ok(shallow.mods.some((m) => m.key === 'layer' && near(m.value, 1.1)), 'loam galleries ×1.1');
  // A gallery below the hard frost line, next to the royal chamber: green.
  const deep = vp(s, d, 'gallery', 22, 20);
  assert.equal(deep.reason, null);
  assert.equal(deep.tint, 'green');
  // Nursery next to the Royal Chamber: adjacency 1.15.
  const nur = vp(s, d, 'nursery', 22, 20);
  assert.ok(nur.mods.some((m) => m.key === 'adjacency' && near(m.value, 1.15)));
  // Flood zone (rows 0–5) and raid reach for granaries / nurseries
  const g = vp(s, d, 'granary', 21, 4);
  assert.ok(g.mods.some((m) => m.key === 'floodZone'));
  const rr = g.mods.find((m) => m.key === 'raidReach');
  assert.ok(rr && rr.value === 5);
  assert.equal(g.tint, 'amber');
  // Haul preview for a granary: with ventilation (capacity cap × 1.10) at path 8
  s.run.research.ventilation_shafts = 1;
  const h = vp(s, d, 'granary', 21, 7).mods.find((m) => m.key === 'haul');
  const gcap = CHAMBERS.granary.fx.cap * 1.1;
  assert.ok(h && near(h.value, (150 * 20 + gcap * 8) / (150 + gcap) / 24));
  // Hygiene: a nursery within 6 path cells of an active midden
  addChamber(s, 'midden', 25, 20, 2, 2);
  const hy = vp(s, d, 'nursery', 22, 20);
  assert.ok(hy.mods.some((m) => m.key === 'hygiene' && m.value === 0.8));
  assert.equal(hy.tint, 'amber');
  // Granary layer modifier in gravel ×1.5
  const gg = vp(s, d, 'granary', 21, 45);
  assert.ok(gg.mods.some((m) => m.key === 'layer' && near(m.value, 1.5)));
});

test('placementCost: food × 2.5^k (extras flat), edict_of_depth ×0.5, royal extras 1e5 × 10^k', () => {
  const { s } = setup();
  assert.deepEqual(nest.placementCost(s, 'gallery'), { food: 40 });
  addChamber(s, 'gallery', 2, 40, 3, 2);
  assert.deepEqual(nest.placementCost(s, 'gallery'), { food: 100 });
  addChamber(s, 'gallery', 6, 40, 3, 2);
  assert.deepEqual(nest.placementCost(s, 'gallery'), { food: 250 });
  assert.deepEqual(nest.placementCost(s, 'hibernaculum'), { food: 8000, honeydew: 150 });
  addChamber(s, 'hibernaculum', 2, 50, 4, 2);
  assert.deepEqual(nest.placementCost(s, 'hibernaculum'), { food: 20000, honeydew: 150 });
  assert.deepEqual(nest.placementCost(s, 'gate'), { food: 2000, chitin: 20 });
  assert.deepEqual(nest.placementCost(s, 'royal_chamber'), { food: 1e6 });
  s.cycle.edict = 'edict_of_depth';
  assert.deepEqual(nest.placementCost(s, 'gate'), { food: 1000, chitin: 10 });
  assert.equal(nest.placementCost(s, 'nope'), null);
});

test('cost curves strictly increase; beyond 1e280 → null (MAX)', () => {
  const { s, d } = setup();
  // Placement food increases with k.
  let last = 0;
  for (let k = 0; k < 6; k++) {
    const c = nest.placementCost(s, 'nursery').food;
    assert.ok(c > last);
    last = c;
    addChamber(s, 'nursery', 1 + (k % 8) * 4, 50 + Math.floor(k / 8) * 3, 3, 2);
  }
  // Level costs increase with L, for food and soil.
  const ch = addChamber(s, 'gallery', 30, 40, 3, 2);
  let lf = 0;
  let ls = 0;
  for (let L = 1; L < 60; L++) {
    ch.level = L;
    ch.target = L;
    const c = nest.levelInfo(s, d, ch.uid).cost;
    assert.ok(c.food > lf && c.soil > ls, 'L' + L);
    lf = c.food;
    ls = c.soil;
  }
  assert.ok(near(nest.levelInfo(s, d, ch.uid).cost.food, 10 * 1.3 ** 59));
  ch.level = 2600; // 10 × 1.3^2600 > 1e280
  const max = nest.levelInfo(s, d, ch.uid);
  assert.equal(max.cost, null);
  assert.equal(max.max, true);
  // Instance factor 2^k and gate chitin extra × g^L
  const gate = addChamber(s, 'gate', 21, 0, 2, 2, { level: 3 });
  const gc = nest.levelInfo(s, d, gate.uid).cost;
  assert.ok(near(gc.food, 500 * 1.7 ** 3) && near(gc.soil, 300 * 1.7 ** 3) && near(gc.chitin, 5 * 1.7 ** 3));
  gate.level = 10;
  assert.equal(nest.levelInfo(s, d, gate.uid).max, true, 'gate max L10');
});

test('findPlacement: a valid spot; nurseries go next to the Royal Chamber; null when locked', () => {
  const { s, d } = setup();
  const g = nest.findPlacement(s, d, 'gallery');
  assert.ok(g);
  assert.equal(nest.validatePlacement(s, d, 'gallery', g.x, g.y).reason, null);
  const n = nest.findPlacement(s, d, 'nursery');
  assert.ok(n);
  const res = nest.validatePlacement(s, d, 'nursery', n.x, n.y);
  assert.equal(res.reason, null);
  assert.ok(res.mods.some((m) => m.key === 'adjacency'), 'adjacent to the Royal Chamber at ' + JSON.stringify(n));
  delete s.run.unlocked.chamber_granary;
  assert.equal(nest.findPlacement(s, d, 'granary'), null);
  s.run.unlocked.chamber_granary = true;
  const early = nest.findPlacement(s, d, 'granary');
  s.run.time = 1000;
  const late = nest.findPlacement(s, d, 'granary');
  assert.ok(late.y > early.y, 'granaries go deep from minute 15: ' + early.y + ' → ' + late.y);
  void xy;
});

test('findPlacement keeps growth room (C60): galleries stay out of the Royal Chamber\'s L8 envelope and can grow', () => {
  const { s, d } = setup();
  const royal = s.run.nest.chambers.find((c) => c.uid === 1);
  const fm = nestgeomFootprint('royal_chamber', 8);
  const side = Math.floor((fm.w - royal.w) / 2);
  const env = { x0: royal.x - side, x1: royal.x - side + fm.w - 1, y0: royal.y, y1: royal.y + fm.h - 1 };
  for (let k = 0; k < 4; k++) {
    const g = nest.findPlacement(s, d, 'gallery');
    assert.ok(g, 'gallery ' + k + ' placed');
    const fp = nestgeomFootprint('gallery', 1);
    const overlap = !(g.x + fp.w - 1 < env.x0 || g.x > env.x1 || g.y + fp.h - 1 < env.y0 || g.y > env.y1);
    assert.equal(overlap, false, 'gallery ' + k + ' at ' + JSON.stringify(g) + ' blocks the Royal envelope ' + JSON.stringify(env));
    addChamber(s, 'gallery', g.x, g.y, fp.w, fp.h);
    nest.derive(s, d);
  }
  for (const ch of s.run.nest.chambers) {
    const info = nest.levelInfo(s, d, ch.uid);
    assert.equal(info.blocked, false, ch.type + ' ' + ch.uid + ' can still grow');
  }
});

test('ghost warns (amber, royalRoom) when a footprint takes the Royal Chamber’s last room to reach the Flight level', () => {
  const { s, d } = setup();
  const royal = s.run.nest.chambers.find((c) => c.uid === 1);
  Object.assign(royal, { x: 18, y: 20, w: 6, h: 3, level: 4, target: 4 });   // L4 footprint, one column short of L5
  setCells(s, rectCells(18, 20, 6, 3), CELL.CHAMBER);
  addChamber(s, 'nursery', 15, 19, 3, 2);                                    // boxes in the left side
  nest.derive(s, d);
  assert.equal(nest.blocksRoyalGrowth(s, { x: 24, y: 20, w: 3, h: 2 }), true, 'the right side was the last room');
  const r = vp(s, d, 'scent_library', 24, 20);
  assert.ok(r.mods.some((m) => m.key === 'royalRoom'), JSON.stringify(r.mods));
  assert.equal(r.tint === 'amber' || r.tint === 'red', true);
  // Further right leaves the column free: no warning.
  assert.equal(nest.blocksRoyalGrowth(s, { x: 25, y: 20, w: 3, h: 2 }), false);
  // Relocating the boxing chamber itself frees the room again.
  const nur = s.run.nest.chambers.find((c) => c.type === 'nursery');
  assert.equal(nest.blocksRoyalGrowth(s, { x: 24, y: 20, w: 3, h: 2 }, nur.uid), false);
  // Once the Royal Chamber has reached the Flight level, nothing warns.
  royal.level = 5;
  assert.equal(nest.blocksRoyalGrowth(s, { x: 24, y: 20, w: 3, h: 2 }), false);
});
