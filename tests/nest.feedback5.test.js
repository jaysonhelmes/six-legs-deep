// C154–C159 (player-approved nest changes, feedback pass 5): clicking a reserved cell inspects its chamber (C154), the
// Royal Chamber reserves its full-size room (C155), the "upgrade affordable" predicate behind the ▲ badge (C156), moving
// a water pocket over spare tunnels (C157), and the Bloodline traits Deep Spring and Root Memory (C158).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { TRAITS, TRAIT_ORDER } from '../src/data/bloodline.js';
import { DRAINAGE, DEEP_SPRING, ROOT_CULT, STONES } from '../src/data/soilFeatures.js';
import { FLIGHT } from '../src/data/prestige.js';
import * as nest from '../src/systems/nest.js';
import { generateNest } from '../src/systems/nestgen.js';
import { idx, rectCells, footprint, perimeter } from '../src/systems/nestgeom.js';
import { tipForTarget, reservedTitle } from '../src/ui/tooltips.js';
import { plannedWaitText, blueprintNote, TRAIT_TIPS } from '../src/ui/text.js';

const COLS = GRID.cols;

function setup() {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 1e9 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e9, soil: 1e9, chitin: 1e6, honeydew: 1e6, fungus: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, fakeEnv());
  return r;
}

function settle(s, d, sec = 1) {
  const env = fakeEnv({ dt: sec });
  s.run.time += sec;
  d.stats.digW = 1e9;
  nest.derive(s, d);
  s.run.nest.digAllow = 1e12; // C252: dig everything queued this step (the dig cap has its own tests)
  nest.tick(s, d, sec, env);
  nest.derive(s, d);
  return env.events || [];
}

function addChamber(s, type, x, y, w, h, extra = {}) {
  const n = s.run.nest;
  const ch = { uid: n.nextUid++, type, k: 0, x, y, w, h, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0, ...extra };
  n.chambers.push(ch);
  for (const c of rectCells(x, y, w, h)) n.cells[c] = CELL.CHAMBER;
  n.rev++;
  return ch;
}

function addPocket(s, x, y, w, h, revealed = true) {
  for (const c of rectCells(x, y, w, h)) s.run.nest.cells[c] = CELL.WATER;
  s.run.nest.features.water.push({ x, y, w, h, revealed });
  s.run.nest.rev++;
}

const last = (s) => s.run.nest.chambers[s.run.nest.chambers.length - 1];

// ------------------------------------------------------------------------------------------------ C154 reserved cells
test('C154: a reserved cell belongs to its chamber: reservedBy names it, its level and where it reaches full size', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'tl' }), null);
  settle(s, d);
  const g = last(s);
  assert.deepEqual(g.res, { x: 26, y: 30, w: 8, h: 4 });
  const cell = idx(30, 32); // inside the reservation, outside the 3×2 room
  assert.deepEqual(nest.reservedBy(s, d, cell), { uid: g.uid, type: 'gallery', level: 1, fullL: 8 });
  assert.equal(nest.reservedBy(s, d, idx(27, 30)), null, 'its own room is the chamber itself, not a reserved cell');
  assert.equal(nest.reservedBy(s, d, idx(5, 60)), null);
  // the Royal Chamber's reserved room (L8 9×4 since C155)
  const rb = nest.reservedBy(s, d, idx(14, 23));
  assert.equal(rb.uid, 1);
  assert.equal(rb.fullL, 8);
  // hover tooltip: "Reserved for Gallery (L1 → full size at L8)", even over a buried cache
  s.run.nest.features.caches.push({ i: cell, kind: 'seed_cache', found: false, hinted: true });
  s.run.nest.rev++;
  nest.derive(s, d);
  const tip = tipForTarget({ view: 'nest', kind: 'chamber', id: g.uid, reserved: true, i: cell }, s, d);
  assert.equal(tip.title, 'Reserved for Gallery (L1 → full size at L8)');
  assert.ok(tip.lines.some((l) => /buried/.test(l)), tip.lines.join(' | '));
  assert.ok(tip.lines.some((l) => /Click to inspect the Gallery/.test(l)));
  g.level = 3;
  assert.equal(reservedTitle(g, nest.reservedBy(s, d, cell)), 'Reserved for Gallery (L3 → full size at L8)');
  // the level shown follows the chamber
  const m = nest.reservedBy(s, d, cell);
  assert.equal(m.level, 3);
});

// ------------------------------------------------------------------------------------------------ C155 Royal room
test('C155: a new game\'s Royal Chamber reserves its L8 room; nest generation keeps boulders and pockets out of it', () => {
  const { s } = setup();
  const r = s.run.nest.chambers[0];
  const fp = footprint('royal_chamber', 8);
  assert.deepEqual(r.res, { x: GRID.royal.x + GRID.royal.w - fp.w, y: GRID.royal.y, w: fp.w, h: fp.h });
  for (let seed = 1; seed <= 300; seed++) {
    const n = generateNest(seed, { tags: seed % 3 ? [] : ['site_stony_ground', 'site_wet_hollow'] });
    const R = n.chambers[0].res;
    assert.deepEqual(R, { x: 13, y: 20, w: 9, h: 4 }, 'seed ' + seed);
    for (const c of rectCells(R.x, R.y, R.w, R.h)) {
      assert.notEqual(n.cells[c], CELL.STONE, 'no boulder in the queen\'s room, seed ' + seed);
      assert.notEqual(n.cells[c], CELL.WATER, 'no pocket in the queen\'s room, seed ' + seed);
    }
  }
  assert.ok(STONES.size > 0);
});

test('C155: older saves (a Flight-level reservation) get the full-size room once where it is free, else keep L5 (C66)', () => {
  const { s, d } = setup();
  const r = s.run.nest.chambers[0];
  r.res = { x: 15, y: 20, w: 7, h: 3 }; // saved while the queen reserved only her L5 room
  settle(s, d);
  assert.deepEqual(r.res, { x: 13, y: 20, w: 9, h: 4 }, 'same corner, full size');
  assert.equal(r.resKeep, undefined);
  // blocked: another chamber sits where the L7/L8 rows would go → keeps the L5 room, grows past it the legacy way
  const b = setup();
  const r2 = b.s.run.nest.chambers[0];
  r2.res = { x: 15, y: 20, w: 7, h: 3 };
  addChamber(b.s, 'granary', 15, 23, 2, 2);
  addChamber(b.s, 'granary', 22, 23, 2, 2);
  settle(b.s, b.d);
  assert.deepEqual(r2.res, { x: 15, y: 20, w: 7, h: 3 });
  assert.equal(r2.resKeep, true, 'tried once');
  const before = JSON.stringify(r2);
  settle(b.s, b.d);
  assert.equal(JSON.stringify(r2), before, 'runs once');
  // C66 guarantee: nothing may take the Flight-level room (its reservation) while the queen is below L5
  assert.equal(nest.blocksRoyalGrowth(b.s, { x: 15, y: 22, w: 2, h: 1 }, 0, { d: b.d }), true);
  for (let L = 1; L < FLIGHT.royalLevel; L++) {
    assert.equal(run(b.s, b.d, { type: 'levelChamber', uid: 1 }), null, 'reaches L' + (L + 1));
    settle(b.s, b.d);
  }
  assert.equal(r2.level, FLIGHT.royalLevel);
  assert.equal(nest.levelInfo(b.s, b.d, 1).reserved, false, 'past its L5 room: the legacy side choice');
});

test('C155: with its L8 room taken in an older save it picks the free full-size corner; the Flight-level room is guarded', () => {
  const { s, d } = setup();
  const r = s.run.nest.chambers[0];
  delete r.res; // pre-C137 save
  addChamber(s, 'granary', 13, 22, 2, 2); // blocks the top-right anchor's L8 room
  settle(s, d);
  assert.deepEqual(r.res, { x: 18, y: 20, w: 9, h: 4 }, 'top-left anchor: grows right');
  const room = nest.blocksRoyalGrowth(s, { x: 24, y: 22, w: 1, h: 1 }, 0, { d });
  assert.equal(room, true, 'its Flight-level part (x 18–24, rows 20–22) is guarded');
  assert.equal(nest.blocksRoyalGrowth(s, { x: 26, y: 23, w: 1, h: 1 }, 0, { d }), false, 'beyond the L5 part only the reservation holds it');
});

// ------------------------------------------------------------------------------------------------ C156 affordable
test('C156: upgradeAffordable — affordable food and soil, not blocked, active; affordableUpgrades lists them', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'tl' }), null);
  assert.equal(nest.upgradeAffordable(s, d, last(s).uid), false, 'still being dug');
  settle(s, d);
  const g = last(s);
  assert.equal(nest.upgradeAffordable(s, d, g.uid), true);
  assert.deepEqual(nest.affordableUpgrades(s, d), [1, g.uid]);
  const tip = tipForTarget({ view: 'nest', kind: 'chamber', id: g.uid }, s, d);
  assert.ok(tip.lines.includes('Upgrade affordable'));
  // short of soil: not affordable
  const cost = nest.levelInfo(s, d, g.uid).cost;
  s.run.res.soil = cost.soil * 0.5;
  assert.equal(nest.upgradeAffordable(s, d, g.uid), false);
  assert.ok(!tipForTarget({ view: 'nest', kind: 'chamber', id: g.uid }, s, d).lines.includes('Upgrade affordable'));
  s.run.res.soil = 1e9;
  s.run.res.food = cost.food * 0.5;
  assert.equal(nest.upgradeAffordable(s, d, g.uid), false, 'short of food');
  s.run.res.food = 1e9;
  // blocked: stone in the next column of its reservation
  s.run.nest.cells[idx(29, 30)] = CELL.STONE;
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.equal(nest.levelInfo(s, d, g.uid).blocked, true);
  assert.equal(nest.upgradeAffordable(s, d, g.uid), false, 'blocked growth is not an affordable upgrade');
  s.run.nest.cells[idx(29, 30)] = CELL.SOIL;
  s.run.nest.rev++;
  // a full dig queue does not hide it (it clears by itself)
  const qn = s.run.nest.queue.length;
  for (let k = 0; k < 12; k++) s.run.nest.queue.push({ uid: 900 + k, kind: 'tunnel', chamber: 0, cells: [idx(1, 70 - k)], cur: 0, prog: 0, paidFood: 0, blueprint: false });
  s.run.nest.rev++;
  assert.equal(nest.upgradeAffordable(s, d, g.uid), true);
  s.run.nest.queue.length = qn;
  // max level: never affordable
  const m = addChamber(s, 'thermal_chimney', 2, 0, 2, 4, { level: CHAMBERS.thermal_chimney.maxL, target: CHAMBERS.thermal_chimney.maxL });
  assert.equal(nest.upgradeAffordable(s, d, m.uid), false);
  assert.equal(nest.upgradeAffordable(s, d, 9999), false);
});

// ------------------------------------------------------------------------------------------------ C157 pocket over tunnels
/** A tunnel from the Royal Chamber down column 24 to row 46 with a dead-end stub east along row 46 to x 26. */
function tunnelSetup() {
  const t = setup();
  const { s } = t;
  s.run.research.drainage = 1;
  const cells = s.run.nest.cells;
  for (const x of [22, 23]) cells[idx(x, 21)] = CELL.TUNNEL;
  for (let y = 21; y <= 46; y++) cells[idx(24, y)] = CELL.TUNNEL;
  for (const x of [25, 26]) cells[idx(x, 46)] = CELL.TUNNEL;
  addPocket(s, 10, 40, 2, 2);
  s.run.nest.rev++;
  nest.derive(s, t.d);
  return t;
}

test('C157: a pocket may move over spare tunnel cells; they are filled as part of the move (and its work)', () => {
  const { s, d } = tunnelSetup();
  const a = nest.pocketAction(s, d, 0, { x: 25, y: 45 });
  assert.equal(a.ok, true, a.reason);
  assert.deepEqual(a.fill.slice().sort((x, y) => x - y), [idx(25, 46), idx(26, 46)]);
  const plain = nest.pocketAction(s, d, 0, { x: 28, y: 44 });
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.fill, []);
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 25, y: 45 }), null);
  const job = s.run.nest.queue.find((j) => j.kind === 'drain');
  assert.deepEqual(job.fill.slice().sort((x, y) => x - y), [idx(25, 46), idx(26, 46)]);
  const fillWork = job.fill.reduce((w, c) => w + nest.cellInfo(s, d, c).work * DRAINAGE.fillWork, 0);
  assert.ok(fillWork > 0);
  nest.derive(s, d);
  nest.tick(s, d, 0, fakeEnv({ dt: 0 }));
  const info = d.nest.queueInfo.find((q) => q.uid === job.uid);
  assert.ok(info.work >= fillWork, 'the fill work is part of the job');
  settle(s, d);
  const p = s.run.nest.features.water[0];
  assert.deepEqual([p.x, p.y, p.w, p.h], [25, 45, 2, 2]);
  for (const c of rectCells(25, 45, 2, 2)) assert.equal(s.run.nest.cells[c], CELL.WATER);
  assert.equal(s.run.nest.cells[idx(24, 46)], CELL.TUNNEL, 'the rest of the tunnel stays');
  for (const c of rectCells(10, 40, 2, 2)) assert.equal(s.run.nest.cells[c], CELL.SOIL, 'old spot is soil');
});

test('C157: not over tunnels something needs, chambers, shafts or reserved rooms', () => {
  const { s, d } = tunnelSetup();
  addChamber(s, 'granary', 27, 46, 2, 2); // the stub now leads to a chamber
  nest.derive(s, d);
  assert.equal(nest.pocketAction(s, d, 0, { x: 25, y: 45 }).reason, 'blocked:disconnect');
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 25, y: 45 }), 'blocked:disconnect');
  assert.equal(nest.pocketAction(s, d, 0, { x: 27, y: 45 }).reason, 'blocked:chamber');
  // the column-24 tunnel joins the Royal Chamber's room to the granary: covering it cuts that granary off too
  assert.equal(nest.pocketAction(s, d, 0, { x: 23, y: 40 }).reason, 'blocked:disconnect');
  // a reserved room (another chamber's) stays off limits
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 2, y: 44, anchor: 'tl' }), null);
  settle(s, d);
  assert.equal(nest.pocketAction(s, d, 0, { x: 6, y: 46 }).reason, 'blocked:reserved');
  // a shaft cell
  const b = setup();
  b.s.run.research.drainage = 1;
  addPocket(b.s, 18, 26, 2, 2);
  b.s.run.nest.shafts.push({ kind: 'satellite', col: 30, open: true, ref: 0 });
  for (let y = 0; y <= 30; y++) b.s.run.nest.cells[idx(30, y)] = CELL.TUNNEL;
  for (let x = 21; x < 30; x++) b.s.run.nest.cells[idx(x, 30)] = CELL.TUNNEL;
  b.s.run.nest.rev++;
  nest.derive(b.s, b.d);
  assert.equal(nest.pocketAction(b.s, b.d, 0, { x: 29, y: 20 }).reason, 'blocked:shaft');
});

test('C157: a fill cell something came to need before it was filled stays open; the move then ends as a drain', () => {
  const { s, d } = tunnelSetup();
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 25, y: 45 }), null);
  addChamber(s, 'granary', 27, 46, 2, 2); // built at the stub's end after the move was queued
  settle(s, d);
  assert.equal(s.run.nest.cells[idx(26, 46)], CELL.TUNNEL, 'still open: the granary needs it');
  assert.equal(s.run.nest.features.water.length, 0, 'the pocket was drained instead');
});

// ------------------------------------------------------------------------------------------------ C158 traits
test('C158: Deep Spring and Root Memory are one-level Bloodline traits at blueprint-helper prices', () => {
  for (const id of ['deep_spring', 'root_memory']) {
    assert.ok(TRAIT_ORDER.includes(id));
    assert.equal(TRAITS[id].max, 1);
    assert.equal(TRAITS[id].cost.growth, 1);
    assert.ok(TRAITS[id].cost.base >= 10 && TRAITS[id].cost.base <= 20, id + ' ~15 alates');
    assert.ok(TRAIT_TIPS[id]);
  }
  assert.ok(TRAIT_ORDER.indexOf('root_memory') < TRAIT_ORDER.indexOf('deep_spring'), 'ordered by cost');
});

function wellBlueprint(s, x = 10, y = 45) {
  s.era.blueprints = [{ name: 'W', chambers: [{ type: 'water_well', x, y, w: 2, h: 3, level: 1 }], tunnels: [] }];
  s.era.activeBlueprint = 0;
}

test('C158 Deep Spring: a blueprint Water Well with no pocket in reach gets a spring by its saved spot and is built there', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  s.cycle.traits.deep_spring = 1;
  wellBlueprint(s);
  nest.applyBlueprint(s, d);
  const water = s.run.nest.features.water;
  assert.equal(water.length, 1, 'one spring');
  const sp = water[0];
  assert.equal(sp.spring, true);
  assert.equal(sp.revealed, true);
  assert.deepEqual([sp.w, sp.h], [DEEP_SPRING.size, DEEP_SPRING.size]);
  const well = { x: 10, y: 45, w: 2, h: 3 };
  assert.ok(perimeter(well).some((c) => rectCells(sp.x, sp.y, sp.w, sp.h).includes(c)), 'touches the saved Well spot');
  let events = [];
  for (let k = 0; k < 8 && !s.run.nest.chambers.some((c) => c.type === 'water_well'); k++) events = events.concat(settle(s, d, 1.1));
  const w = s.run.nest.chambers.find((c) => c.type === 'water_well');
  assert.ok(w, 'built');
  assert.deepEqual([w.x, w.y], [10, 45], 'at its saved spot');
  assert.equal(s.run.nest.features.water.length, 1, 'no second spring');
  events = events.concat(settle(s, d));
  assert.ok(events.some((e) => e.type === 'blueprintDropped' && e.reason === 'well:spring'));
  assert.match(blueprintNote({ reason: 'well:spring' }).text, /Deep Spring/);
});

test('C158 Deep Spring: not when a revealed pocket with room is in reach; without the trait the Well is left out', () => {
  const a = setup();
  a.s.cycle.traits.ancestral_blueprint = 1;
  a.s.cycle.traits.deep_spring = 1;
  addPocket(a.s, 14, 46, 2, 2);
  nest.derive(a.s, a.d);
  wellBlueprint(a.s);
  nest.applyBlueprint(a.s, a.d);
  assert.equal(a.s.run.nest.features.water.length, 1, 'the pocket in reach is used, no spring');
  const b = setup();
  wellBlueprint(b.s);
  b.s.cycle.traits.ancestral_blueprint = 1;
  nest.applyBlueprint(b.s, b.d);
  assert.equal(b.s.run.nest.features.water.length, 0);
  assert.deepEqual(b.s.run.nest.bpPending, []);
  assert.ok(settle(b.s, b.d).some((e) => e.reason === 'well:none'));
  // waiting copy while a spring is due
  assert.match(plannedWaitText({ type: 'water_well', code: 'wait:spring' }), /Deep Spring/);
});

function penBlueprint(s, x = 4, y = 30) {
  s.era.blueprints = [{ name: 'P', chambers: [{ type: 'root_aphid_pen', x, y, w: 3, h: 2, level: 1 }], tunnels: [] }];
  s.era.activeBlueprint = 0;
}

test('C158 Root Memory: a rootless blueprint Root Aphid Pen gets a free root grown to it, then queues', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  s.cycle.traits.root_memory = 1;
  s.run.research.root_cultivation = 1;
  const cost0 = nest.rootCost(s);
  penBlueprint(s);
  nest.applyBlueprint(s, d);
  const roots = s.run.nest.features.roots;
  assert.equal(roots.length, 1);
  const r = roots[0];
  assert.equal(r.free, true);
  assert.equal(r.own, true);
  assert.ok(r.col >= 4 && r.col <= 6, 'over the pen');
  assert.equal(r.to, 29, 'down to the row above it');
  assert.deepEqual(s.run.nest.bpPending.map((p) => p.type), ['root_aphid_pen']);
  const w = nest.plannedWait(s, d, idx(4, 30));
  assert.equal(w.code, 'wait:root');
  assert.match(plannedWaitText(w), /Root Memory/);
  assert.deepEqual(nest.rootCost(s), cost0, 'free: the next cultivated root costs the same');
  assert.equal(nest.rootPreview(s, d, 30).reason, null, 'not counted against the root cap');
  for (let k = 0; k < 40 && !s.run.nest.chambers.some((c) => c.type === 'root_aphid_pen'); k++) settle(s, d, 1.1);
  const pen = s.run.nest.chambers.find((c) => c.type === 'root_aphid_pen');
  assert.ok(pen, 'placed once the root touches it');
  assert.deepEqual([pen.x, pen.y], [4, 30]);
  assert.equal(r.y1, 29);
  assert.equal(s.run.nest.features.roots.length, 1, 'one root only');
});

test('C158 / C177: without the trait (or with no column a root can grow down) the pen waits and says why', () => {
  const a = setup();
  a.s.cycle.traits.ancestral_blueprint = 1;
  penBlueprint(a.s);
  nest.applyBlueprint(a.s, a.d);
  // C177: no longer dropped: it waits for Root Cultivation (no research yet)
  assert.deepEqual(a.s.run.nest.bpPending.map((p) => p.type), ['root_aphid_pen']);
  assert.equal(nest.plannedWaits(a.s, a.d)[0].code, 'wait:rootResearch');
  assert.equal(a.s.run.nest.features.roots.length, 0);
  const b = setup();
  b.s.cycle.traits.ancestral_blueprint = 1;
  b.s.cycle.traits.root_memory = 1;
  // stone over every column above and beside the pen
  for (let x = 3; x <= 7; x++) b.s.run.nest.cells[idx(x, 10)] = CELL.STONE;
  b.s.run.nest.rev++;
  penBlueprint(b.s);
  nest.applyBlueprint(b.s, b.d);
  assert.deepEqual(b.s.run.nest.bpPending.map((p) => p.type), ['root_aphid_pen']);
  assert.equal(nest.plannedWaits(b.s, b.d)[0].code, 'wait:rootPath');
  assert.equal(b.s.run.nest.features.roots.length, 0);
  assert.equal(ROOT_CULT.y0, 1);
});
