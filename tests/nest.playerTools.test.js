// C117–C122 (player requests): drain / relocate water pockets (drainage), cultivated roots (root_cultivation), the
// Royal Chamber at its blueprint spot, blueprint Water Wells only by water, cancelling planned blueprint chambers,
// "Backfill all unneeded tunnels", and the "Level cheapest" button when the selected chamber is the cheapest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { DRAINAGE, ROOT_CULT } from '../src/data/soilFeatures.js';
import { RESEARCH } from '../src/data/research.js';
import { DIG } from '../src/data/strata.js';
import * as nest from '../src/systems/nest.js';
import { idx, perimeter, rectCells } from '../src/systems/nestgeom.js';
import { cheapestButton } from '../src/ui/panels/build.js';
import { blueprintNote } from '../src/ui/text.js';

const COLS = GRID.cols;

function setup() {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 1e9 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e9, soil: 1e9, chitin: 1e6, honeydew: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, fakeEnv());
  return r;
}

/** Tick the nest (dig everything queued), advancing run time so the blueprint re-check runs. */
function settle(s, d, sec = 1) {
  const env = fakeEnv({ dt: sec });
  s.run.time += sec;
  nest.derive(s, d);
  nest.tick(s, d, sec, env);
  nest.derive(s, d);
  d.stats.digW = 1e9;
  return env.events || [];
}

function addPocket(s, x, y, w, h, revealed = true) {
  for (const c of rectCells(x, y, w, h)) s.run.nest.cells[c] = CELL.WATER;
  s.run.nest.features.water.push({ x, y, w, h, revealed });
  s.run.nest.rev++;
}

function touchesWater(s, ch) {
  return perimeter(ch).some((c) => s.run.nest.cells[c] === CELL.WATER);
}

test('C117: Drainage gates draining; a drain digs to the pocket, turns its water into soil and removes it', () => {
  const { s, d } = setup();
  addPocket(s, 10, 40, 2, 2);
  nest.derive(s, d);
  assert.ok(RESEARCH.drainage, 'the existing drainage node carries the ability');
  assert.equal(run(s, d, { type: 'drainPocket', pocket: 0 }), 'locked');
  s.run.research.drainage = 1;
  const a = nest.pocketAction(s, d, 0, null);
  assert.equal(a.ok, true);
  assert.deepEqual(a.cost, { soil: DRAINAGE.drainSoil * 4 });
  assert.ok(a.work > 0);
  const soil0 = s.run.res.soil;
  assert.equal(run(s, d, { type: 'drainPocket', pocket: 0 }), null);
  assert.equal(s.run.res.soil, soil0 - DRAINAGE.drainSoil * 4, 'soil paid when queued');
  assert.equal(run(s, d, { type: 'drainPocket', pocket: 0 }), 'busy');
  const job = s.run.nest.queue.find((j) => j.kind === 'drain');
  assert.ok(job && job.drain.length === 4);
  settle(s, d);
  assert.equal(s.run.nest.queue.length, 0, 'drain finished');
  for (const c of rectCells(10, 40, 2, 2)) assert.equal(s.run.nest.cells[c], CELL.SOIL, 'drained cells are soil (diggable, not open)');
  assert.equal(s.run.nest.features.water.length, 0, 'pocket removed');
});

test('C117: draining the pocket a Water Well uses removes the Well with its placement food refunded in full', () => {
  const { s, d } = setup();
  s.run.research.drainage = 1;
  addPocket(s, 10, 40, 2, 2);
  nest.derive(s, d);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'water_well', x: 12, y: 40 }), null);
  settle(s, d);
  const well = s.run.nest.chambers.find((c) => c.type === 'water_well');
  assert.ok(well && well.status === 'active');
  assert.equal(nest.pocketAction(s, d, 0, null).wells, 1);
  s.run.res.food = 0;
  assert.equal(run(s, d, { type: 'drainPocket', pocket: 0 }), null);
  settle(s, d);
  assert.ok(!s.run.nest.chambers.some((c) => c.type === 'water_well'), 'Well removed');
  assert.equal(s.run.res.food, CHAMBERS.water_well.place.food, 'placement food refunded 100 %');
});

test('C117: a pocket can move to plain soil within DRAINAGE.moveRows rows; refusals name the reason', () => {
  const { s, d } = setup();
  s.run.research.drainage = 1;
  addPocket(s, 10, 40, 2, 2);
  nest.derive(s, d);
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 10, y: 40 + DRAINAGE.moveRows + 1 }), 'invalid:row');
  // C140 (player report): one tile over its own cells is fine; another pocket's water is not
  assert.equal(nest.handlers.relocatePocket.validate(s, d, { type: 'relocatePocket', pocket: 0, x: 10, y: 39 }), null, 'over its own cells');
  addPocket(s, 14, 40, 2, 2);
  nest.derive(s, d);
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 13, y: 40 }), 'blocked:water', 'overlapping another pocket');
  s.run.nest.features.water.pop();
  for (const c of rectCells(14, 40, 2, 2)) s.run.nest.cells[c] = CELL.SOIL;
  s.run.nest.rev++;
  nest.derive(s, d);
  s.run.nest.cells[idx(30, 45)] = CELL.STONE;
  s.run.nest.rev++;
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 29, y: 44 }), 'blocked:stone');
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 4, y: 48 }), null);
  assert.equal(run(s, d, { type: 'cancelJob', uid: s.run.nest.queue[0].uid }), 'blocked', 'a pocket move cannot be cancelled');
  settle(s, d);
  const p = s.run.nest.features.water[0];
  assert.deepEqual([p.x, p.y, p.w, p.h, p.revealed], [4, 48, 2, 2, true]);
  for (const c of rectCells(4, 48, 2, 2)) assert.equal(s.run.nest.cells[c], CELL.WATER);
  for (const c of rectCells(10, 40, 2, 2)) assert.equal(s.run.nest.cells[c], CELL.SOIL);
});

test('C117: cancelling a drain refunds the soil of the cells still under water', () => {
  const { s, d } = setup();
  s.run.research.drainage = 1;
  addPocket(s, 10, 40, 2, 2);
  nest.derive(s, d);
  const soil0 = s.run.res.soil;
  assert.equal(run(s, d, { type: 'drainPocket', pocket: 0 }), null);
  assert.equal(run(s, d, { type: 'cancelJob', uid: s.run.nest.queue[0].uid }), null);
  assert.equal(s.run.res.soil, soil0, 'nothing drained yet: full refund');
});

test('C118: Root Cultivation grows a root a few rows a second, capped per run; it counts for Root Aphid Pens', () => {
  const { s, d } = setup();
  assert.equal(RESEARCH.root_cultivation.prereq[0], 'aphid_husbandry');
  assert.equal(run(s, d, { type: 'growRoot', col: 5 }), 'locked');
  s.run.research.root_cultivation = 1;
  assert.equal(run(s, d, { type: 'growRoot', col: GRID.mainCol }), 'blocked:shaft');
  const hd0 = s.run.res.honeydew;
  assert.equal(run(s, d, { type: 'growRoot', col: 5 }), null);
  assert.equal(s.run.res.honeydew, hd0 - ROOT_CULT.cost.honeydew);
  assert.equal(run(s, d, { type: 'growRoot', col: 5 }), 'invalid:root');
  const r = s.run.nest.features.roots.find((x) => x.own);
  assert.deepEqual([r.col, r.y0, r.y1, r.to], [5, ROOT_CULT.y0, ROOT_CULT.y0, ROOT_CULT.maxRow]);
  settle(s, d, 2);
  assert.equal(r.y1, ROOT_CULT.y0 + 2 * ROOT_CULT.rowsPerSec, 'grows rowsPerSec rows per second');
  settle(s, d, 60);
  assert.equal(r.y1, ROOT_CULT.maxRow, 'stops at the max depth');
  assert.equal(nest.cellInfo(s, d, idx(5, 10)).rootOwn, true);
  // C178: a root grows down through a chamber: column 19 runs through the Royal Chamber (rows 20–21) to the max depth.
  assert.equal(run(s, d, { type: 'growRoot', col: 19 }), null);
  settle(s, d, 60);
  assert.equal(s.run.nest.features.roots.find((x) => x.own && x.col === 19).y1, ROOT_CULT.maxRow);
  // Cost grows; cap 3 (+1 per 5 Mound levels).
  assert.deepEqual(nest.rootCost(s), { honeydew: ROOT_CULT.cost.honeydew * ROOT_CULT.growth ** 2, food: ROOT_CULT.cost.food * ROOT_CULT.growth ** 2 });
  assert.equal(run(s, d, { type: 'growRoot', col: 30 }), null);
  assert.equal(run(s, d, { type: 'growRoot', col: 33 }), 'max');
  s.run.surface.mound = ROOT_CULT.moundPer;
  assert.equal(nest.rootCap(s), ROOT_CULT.cap + 1);
  // Root Aphid Pen: touching the cultivated root is enough; far from any root it is refused.
  s.run.nest.features.roots = s.run.nest.features.roots.filter((x) => x.own);
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.equal(nest.validatePlacement(s, d, 'root_aphid_pen', 6, 8).reason, null);
  assert.equal(nest.validatePlacement(s, d, 'root_aphid_pen', 10, 8).reason, 'invalid:root');
});

test('C119: a blueprint pre-digs the Royal Chamber at its saved spot, connected to the shaft; a bad spot keeps the default', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  // The snapshot records the Royal Chamber's corner.
  assert.equal(run(s, d, { type: 'saveBlueprint', slot: 0, name: 'Plan' }), null);
  // C137: with its reservation (the L1 room sits in its top-right corner)
  assert.deepEqual(s.era.blueprints[0].royal, { x: GRID.royal.x, y: GRID.royal.y, res: { x: 13, y: 20, w: 9, h: 4 } }); // C155: its L8 room
  s.era.blueprints = [{ name: 'Deep', chambers: [], tunnels: [], royal: { x: 8, y: 30 } }];
  s.era.activeBlueprint = 0;
  nest.applyBlueprint(s, d);
  nest.derive(s, d);
  const royal = s.run.nest.chambers.find((c) => c.uid === 1);
  assert.deepEqual([royal.x, royal.y], [8, 30]);
  for (const c of rectCells(GRID.royal.x, GRID.royal.y, GRID.royal.w, GRID.royal.h)) assert.equal(s.run.nest.cells[c], CELL.SOIL, 'default cells undug');
  for (const c of rectCells(8, 30, royal.w, royal.h)) assert.equal(s.run.nest.cells[c], CELL.CHAMBER);
  const j = s.run.nest.chambers.indexOf(royal);
  assert.ok(d.nest.chambers[j].minEntPath >= 0, 'connected to the entrance shaft');
  assert.equal(s.run.nest.cells[idx(GRID.mainCol, 0)], CELL.TUNNEL, 'main shaft intact');
  const ev = settle(s, d);
  assert.ok(ev.some((e) => e.type === 'blueprintDropped' && e.reason === 'royal:moved'));
  assert.match(blueprintNote({ reason: 'royal:moved' }).text, /planned spot/);

  // A stone in the saved spot: the Royal Chamber stays at the default and the player is told why.
  const b = setup();
  b.s.era.blueprints = [{ name: 'Deep', chambers: [], tunnels: [], royal: { x: 8, y: 30 } }];
  b.s.era.activeBlueprint = 0;
  b.s.run.nest.cells[idx(9, 31)] = CELL.STONE;
  b.s.run.nest.rev++;
  nest.applyBlueprint(b.s, b.d);
  const r2 = b.s.run.nest.chambers.find((c) => c.uid === 1);
  assert.deepEqual([r2.x, r2.y], [GRID.royal.x, GRID.royal.y]);
  assert.deepEqual(b.s.run.nest.bpNotes.map((n) => n.reason), ['royal:kept:blocked:stone']);
  assert.match(blueprintNote({ reason: 'royal:kept:blocked:stone' }).text, /stays at the usual spot/);
  // Above the Royal row rule: kept.
  const c3 = setup();
  c3.s.era.blueprints = [{ name: 'High', chambers: [], tunnels: [], royal: { x: 8, y: 10 } }];
  c3.s.era.activeBlueprint = 0;
  nest.applyBlueprint(c3.s, c3.d);
  assert.equal(c3.s.run.nest.chambers.find((c) => c.uid === 1).y, GRID.royal.y);
  assert.equal(c3.s.run.nest.bpNotes[0].reason, 'royal:kept:invalid:row');
});

test('C119: a blueprint Water Well is never placed away from water: it waits, then takes the nearest spot by a revealed pocket', () => {
  const { s, d } = setup();
  s.run.unlocked.chamber_water_well = false;
  addPocket(s, 30, 50, 2, 2, false);
  s.era.blueprints = [{ name: 'W', chambers: [{ type: 'water_well', x: 4, y: 30, w: 2, h: 3, level: 1 }], tunnels: [] }];
  s.era.activeBlueprint = 0;
  nest.applyBlueprint(s, d);
  assert.deepEqual(s.run.nest.bpPending, [{ type: 'water_well', x: 4, y: 30, float: true }]);
  assert.deepEqual(nest.plannedChambers(s), [], 'no planned outline at the saved (dry) spot');
  // Unlocked and a pocket revealed: placed touching it, never at the saved spot.
  s.run.unlocked.chamber_water_well = true;
  s.run.nest.features.water[0].revealed = true;
  s.run.nest.rev++;
  let events = [];
  for (let k = 0; k < 5 && !s.run.nest.chambers.some((c) => c.type === 'water_well'); k++) events = events.concat(settle(s, d, 1.1));
  events = events.concat(settle(s, d, 1.1));
  const well = s.run.nest.chambers.find((c) => c.type === 'water_well');
  assert.ok(well, 'placed');
  assert.ok(touchesWater(s, well), 'touches the water pocket');
  assert.deepEqual(s.run.nest.bpPending, []);
  assert.ok(events.some((e) => e.type === 'blueprintDropped' && e.reason === 'well:moved'));
});

test('C119: with no water pocket on the new soil, a blueprint Water Well is dropped with a note', () => {
  const { s, d } = setup();
  s.era.blueprints = [{ name: 'W', chambers: [{ type: 'water_well', x: 4, y: 30, w: 2, h: 3, level: 1 }], tunnels: [] }];
  s.era.activeBlueprint = 0;
  nest.applyBlueprint(s, d);
  assert.deepEqual(s.run.nest.bpPending, []);
  const ev = settle(s, d);
  assert.ok(ev.some((e) => e.type === 'blueprintDropped' && e.reason === 'well:none' && e.chamberType === 'water_well'));
  assert.match(blueprintNote({ reason: 'well:none' }).text, /left out/);
});

test('C120: cancelPlanned drops one planned chamber (and tunnels only it needed) or all of them', () => {
  const { s, d } = setup();
  const nestS = s.run.nest;
  nestS.bpPending = [{ type: 'gallery', x: 4, y: 40 }, { type: 'gallery', x: 12, y: 40 }];
  // tunnels: one group leads only to the first spot, one joins both spots
  const onlyA = [idx(4, 39), idx(4, 38)];
  const both = [idx(7, 40), idx(8, 40), idx(9, 40), idx(10, 40), idx(11, 40)];
  nestS.bpTunnels = [...onlyA, ...both].sort((a, b) => a - b);
  assert.equal(run(s, d, { type: 'cancelPlanned', cell: idx(5, 40) }), 'notFound', 'the top-left cell names the spot');
  assert.equal(run(s, d, { type: 'cancelPlanned', cell: idx(4, 40) }), null);
  assert.deepEqual(nestS.bpPending, [{ type: 'gallery', x: 12, y: 40 }]);
  assert.deepEqual(nestS.bpTunnels, both.slice().sort((a, b) => a - b), 'tunnels still leading to the other spot stay');
  assert.equal(run(s, d, { type: 'cancelPlanned', all: true }), null);
  assert.deepEqual(nestS.bpPending, []);
  assert.deepEqual(nestS.bpTunnels, []);
  assert.equal(run(s, d, { type: 'cancelPlanned', all: true }), 'notFound');
});

test('C121: backfillUnneeded fills dead-end tunnels and keeps what chambers, planned chambers and shafts need', () => {
  const { s, d } = setup();
  const T = (x, y) => { s.run.nest.cells[idx(x, y)] = CELL.TUNNEL; };
  for (const x of [21, 22, 23]) T(x, 5); // dead-end stub off the shaft
  for (const x of [21, 22, 23]) T(x, 12); // the gallery's only way in
  for (const x of [19, 18, 17]) T(x, 8); // leads to a planned blueprint chamber
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 24, y: 12 }), null);
  settle(s, d);
  s.run.nest.bpPending = [{ type: 'gallery', x: 14, y: 8 }];
  nest.derive(s, d);
  const list = nest.unneededTunnels(s, d);
  assert.deepEqual(list, [idx(21, 5), idx(22, 5), idx(23, 5)]);
  assert.equal(run(s, d, { type: 'backfillUnneeded' }), null);
  assert.deepEqual(s.run.nest.backfill.map((b) => b.i).sort((a, b) => a - b), list);
  for (let k = 0; k < 11; k++) settle(s, d, 1);
  for (const c of list) assert.equal(s.run.nest.cells[c], CELL.SOIL);
  const g = s.run.nest.chambers.findIndex((c) => c.type === 'gallery');
  assert.ok(d.nest.chambers[g].minEntPath >= 0, 'gallery still connected');
  assert.equal(s.run.nest.cells[idx(GRID.mainCol, 3)], CELL.TUNNEL, 'shaft kept');
  assert.equal(run(s, d, { type: 'backfillUnneeded' }), 'invalid:empty');
  assert.equal(DIG.backfillSec, 10);
});

test('C122: "Level cheapest" still shows (and levels) the selected chamber when it is the cheapest; compact list label', () => {
  const { s, d } = setup();
  run(s, d, { type: 'digTunnel', cells: [idx(21, 12), idx(22, 12), idx(23, 12)] });
  settle(s, d);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 24, y: 12 }), null);
  settle(s, d);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 24, y: 16 }), null); // C137: clear of the first one's reserved room
  settle(s, d);
  const [a, b] = s.run.nest.chambers.filter((c) => c.type === 'gallery');
  a.level = 6;
  b.level = 3;
  const sel = cheapestButton(s, d, 'gallery', { selectedUid: b.uid });
  assert.equal(sel.show, true, 'shown although the selected chamber is the cheapest');
  assert.equal(sel.uid, b.uid, 'it levels the selected one');
  assert.equal(sel.self, true);
  assert.match(sel.label, /\(L\)$/, 'C142: L levels the cheapest');
  assert.match(sel.tip, /This one is the cheapest/);
  const other = cheapestButton(s, d, 'gallery', { selectedUid: a.uid });
  assert.equal(other.uid, b.uid);
  assert.equal(other.self, false);
  const list = cheapestButton(s, d, 'gallery', { compact: true });
  assert.match(list.label, /^Lvl cheapest · /);
  // C212: the compact label names every resource of the cost (the button also draws them with icons)
  assert.match(list.label, /^Lvl cheapest · .+ food · .+ soil$/, 'compact: ' + list.label);
  assert.equal(list.head, 'Lvl cheapest');
  assert.ok(list.cost.food > 0 && list.cost.soil > 0);
  assert.equal(list.ok, true);
  s.run.res.food = 0;
  assert.equal(cheapestButton(s, d, 'gallery', { compact: true }).ok, false, 'quiet when unaffordable');
});
