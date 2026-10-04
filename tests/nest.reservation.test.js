// C136–C142 (player-approved nest changes): the War Hall (supermajor-only berths; Barracks berths soldier-only), full-size
// footprint reservations (anchors, growth order, what they block), Q to place another chamber of a type, the L / Shift+L
// swap, moving a water pocket one tile over its own cells, blueprint "Use" during a run, and access tunnels for planned
// blueprint chambers the open nest does not reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { CASTES } from '../src/data/castes.js';
import { UNLOCKS } from '../src/data/unlocks.js';
import * as nest from '../src/systems/nest.js';
import { recompute } from '../src/systems/stats.js';
import { addAdults } from '../src/systems/population.js';
import { idx, rectCells, footprint, anchorRect, anchorOf } from '../src/systems/nestgeom.js';
import { chamberHotkey, placeAnotherAction, growthText, levelMessage } from '../src/ui/panels/build.js';
import { plannedWaitText, CHAMBER_ABOUT, reasonText } from '../src/ui/text.js';

function setup({ unlockAll = true } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 1e9 } });
  if (unlockAll) for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
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

/** Tick the nest (dig everything queued at digW), advancing run time so the blueprint re-check runs. */
function settle(s, d, sec = 1, digW = 1e9) {
  const env = fakeEnv({ dt: sec });
  s.run.time += sec;
  d.stats.digW = digW;
  nest.derive(s, d);
  nest.tick(s, d, sec, env);
  nest.derive(s, d);
  return env.events || [];
}

const last = (s) => s.run.nest.chambers[s.run.nest.chambers.length - 1];

// ------------------------------------------------------------------------------------------------ C136 War Hall
test('C136: War Hall data — unlocked by Supermajors research, deep, pricier than the Barracks; supermajors live there', () => {
  const w = CHAMBERS.war_hall;
  assert.ok(CHAMBER_ORDER.indexOf('war_hall') === CHAMBER_ORDER.indexOf('barracks') + 1);
  assert.equal(w.unlock, 'chamber_war_hall');
  const u = UNLOCKS.find((x) => x.key === 'chamber_war_hall');
  assert.deepEqual(u.cond, { research: 'supermajors' });
  assert.ok(w.rowMin >= 30);
  assert.ok(w.place.food > CHAMBERS.barracks.place.food * 10 && w.f0 > CHAMBERS.barracks.f0);
  assert.equal(w.place.food, 4 * w.f0, 'F_place = 4 × F0');
  assert.ok(w.g > CHAMBERS.barracks.g);
  assert.equal(w.fx.berths, 4);
  assert.equal(CASTES.supermajor.house, 'warBerths');
  assert.equal(CASTES.soldier.house, 'berths');
  assert.ok(CHAMBER_ABOUT.war_hall.includes('supermajor'));
  const { s, d } = setup();
  assert.equal(nest.validatePlacement(s, d, 'war_hall', 10, 25).reason, 'invalid:row');
});

test('C136: Barracks berths are soldier-only, War Hall berths supermajor-only (× colony scale); overflow from older saves lives on but blocks supermajor eggs', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'barracks', x: 24, y: 12 }), null);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'war_hall', x: 22, y: 34 }), null);
  settle(s, d);
  recompute(s, d, fakeEnv());
  assert.equal(d.stats.berths, CHAMBERS.barracks.fx.berths * d.stats.colonyScale);
  assert.equal(d.stats.warBerths, CHAMBERS.war_hall.fx.berths * d.stats.colonyScale);
  const g = nest.levelGain(s, d, last(s).uid).lines;
  assert.deepEqual(g.map((l) => [l.stat, l.from, l.to]), [['warBerths', 4, 8]]);
  // An older save: 6 supermajors used to share the Barracks; now only 4 War Hall berths exist.
  s.run.colony.adults.supermajor = 6;
  s.run.colony.adults.soldier = 3;
  assert.equal(addAdults(s, d, 'supermajor', 1, { capped: true }), 0, 'no room for another supermajor (overflow 2)');
  assert.equal(s.run.colony.adults.supermajor, 6, 'the overflow is not killed');
  assert.equal(addAdults(s, d, 'soldier', 10, { capped: true }), 5, 'soldiers: 8 Barracks berths − 3 soldiers');
  s.run.colony.adults.supermajor = 2;
  assert.equal(addAdults(s, d, 'supermajor', 5, { capped: true }), 2, 'room frees as the overflow goes');
});

// ------------------------------------------------------------------------------------------------ C137 reservations
test('C137: placing reserves the full-size (max-level) room; anchors pick the corner; the advisor and refusals respect it', () => {
  const { s, d } = setup();
  const fp8 = footprint('gallery', 8);
  const v = nest.validatePlacement(s, d, 'gallery', 26, 30);
  assert.equal(v.reason, null);
  assert.deepEqual(v.res, { x: 26, y: 30, w: fp8.w, h: fp8.h }, 'auto: top-left anchor first');
  assert.deepEqual(v.anchors.map((a) => a.anchor), ['tl', 'tr', 'bl', 'br']);
  const br = nest.validatePlacement(s, d, 'gallery', 26, 30, { anchor: 'br' });
  assert.deepEqual(br.res, anchorRect({ x: 26, y: 30, w: 3, h: 2 }, 'br', fp8.w, fp8.h));
  assert.equal(br.anchor, 'br');
  // a type that never grows reserves nothing; one with a capped max level reserves the footprint at that level
  assert.equal(nest.validatePlacement(s, d, 'gate', 21, 0).res, null);
  const mid = nest.validatePlacement(s, d, 'midden', 4, 30);
  assert.deepEqual([mid.res.w, mid.res.h], [footprint('midden', CHAMBERS.midden.maxL).w, footprint('midden', CHAMBERS.midden.maxL).h]);
  // explicit corner that does not fit: refused with the reservation reason; the auto choice still finds one
  assert.equal(nest.validatePlacement(s, d, 'gallery', 37, 30, { anchor: 'tl' }).reason, 'resv:bounds');
  assert.equal(nest.validatePlacement(s, d, 'gallery', 37, 30).reason, null);
  assert.match(reasonText('resv:reserved'), /reserved space/);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'tl' }), null);
  const g = last(s);
  assert.deepEqual(g.res, { x: 26, y: 30, w: fp8.w, h: fp8.h });
  // Another chamber may not use the reserved cells, nor reserve over them; tunnels may not be queued through them.
  assert.equal(nest.validatePlacement(s, d, 'nursery', 30, 32).reason, 'blocked:reserved');
  assert.equal(nest.validatePlacement(s, d, 'nursery', 22, 33, { anchor: 'tl' }).reason, 'resv:reserved');
  settle(s, d);
  const path = [idx(26, 32), idx(26, 33)];
  assert.equal(run(s, d, { type: 'digTunnel', cells: path }), 'blocked:reserved');
  assert.equal(nest.cellInfo(s, d, idx(30, 32)).reserved, 'gallery');
  // the advisor never suggests a spot inside it
  for (let k = 0; k < 3; k++) {
    const p = nest.findPlacement(s, d, 'nursery');
    assert.ok(p);
    for (const c of rectCells(p.x, p.y, 3, 2)) assert.ok(!(c % 40 >= 26 && c % 40 < 34 && c / 40 >= 30 && c / 40 < 34), 'not in the reservation');
  }
});

test('C137: growth fills the reserved rectangle in a fixed order (no direction), ending exactly on it', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 30, y: 40, anchor: 'br' }), null);
  settle(s, d);
  const g = last(s);
  const R = { ...g.res };
  assert.equal(anchorOf(g, R), 'br');
  for (let L = 1; L < 8; L++) {
    const info = nest.levelInfo(s, d, g.uid);
    assert.equal(info.reserved, true);
    assert.deepEqual(info.dirs, { left: false, right: false, up: false, down: false }, 'no side to pick');
    assert.match(growthText(g, info), /into its reserved space/);
    assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid, dir: 'right' }), null, 'a direction is ignored');
    settle(s, d);
    assert.equal(g.level, L + 1);
    const fp = footprint('gallery', L + 1);
    assert.deepEqual([g.w, g.h], [fp.w, fp.h]);
    assert.deepEqual([g.x + g.w, g.y + g.h], [R.x + R.w, R.y + R.h], 'stays in its bottom-right corner: grows left / up');
  }
  assert.deepEqual([g.x, g.y, g.w, g.h], [R.x, R.y, R.w, R.h]);
  assert.equal(nest.levelInfo(s, d, g.uid).grows, false, 'L9+ works at once');
});

test('C137: stone and water inside a reservation are allowed but hold growth back until cleared', () => {
  const { s, d } = setup();
  s.run.nest.cells[idx(13, 40)] = CELL.STONE; // the column L2 adds (anchor tl → it grows right)
  s.run.nest.rev++;
  nest.derive(s, d);
  const v = nest.validatePlacement(s, d, 'gallery', 10, 40, { anchor: 'tl' });
  assert.equal(v.reason, null);
  assert.equal(v.obstacles, 1);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 10, y: 40, anchor: 'tl' }), null);
  settle(s, d);
  const g = last(s);
  const info = nest.levelInfo(s, d, g.uid);
  assert.equal(info.blocked, true);
  assert.equal(info.blockWhy, 'blocked:stone');
  assert.match(levelMessage(info, g), /Growth waits.*stone/);
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid }), 'blocked:stone');
  s.run.research.acid_excavation = 1;
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid }), null, 'acid digs it as part of the growth');
});

test('C137: older saves get reservations once where the full rectangle is free; chambers with no room keep the side choice', () => {
  const { s, d } = setup();
  const n = s.run.nest;
  const royal = n.chambers[0];
  delete royal.res; // an older save
  const add = (type, x, y, w, h) => {
    const ch = { uid: n.nextUid++, type, k: 0, x, y, w, h, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 };
    n.chambers.push(ch);
    for (const c of rectCells(x, y, w, h)) n.cells[c] = CELL.CHAMBER;
    return ch;
  };
  const a = add('gallery', 24, 12, 3, 2);
  const b = add('gallery', 1, 76, 3, 2);     // bottom-left corner: only one corner can fit
  const c = add('nursery', 33, 40, 3, 2);
  add('granary', 35, 37, 2, 2);              // walls the nursery in on every side (with the grid edge)
  add('granary', 31, 42, 2, 2);
  add('granary', 31, 37, 2, 2);
  add('granary', 37, 42, 2, 2);
  n.rev++;
  settle(s, d);
  assert.deepEqual(royal.res, { x: 15, y: 20, w: 7, h: 3 }, 'the queen keeps her obstacle-free Flight-level room');
  assert.ok(a.res && a.res.w === 8 && a.res.h === 4);
  assert.deepEqual(b.res, { x: 1, y: 76, w: 8, h: 4 });
  assert.equal(c.noRes, true, 'no free full-size rectangle: legacy');
  assert.equal(nest.levelInfo(s, d, c.uid).reserved, false);
  const before = JSON.stringify(n.chambers);
  settle(s, d);
  assert.equal(JSON.stringify(n.chambers), before, 'runs once');
});

test('C137: the Royal Chamber reserves its Flight-level room at the start; nothing may be placed in it (C66 simplified)', () => {
  const { s, d } = setup();
  const r = s.run.nest.chambers[0];
  assert.deepEqual(r.res, { x: 15, y: 20, w: 7, h: 3 });
  assert.equal(nest.validatePlacement(s, d, 'nursery', 15, 22).reason, 'blocked:reserved');
  assert.equal(nest.blocksRoyalGrowth(s, { x: 22, y: 20, w: 3, h: 2 }, 0, { d }), false, 'right of it is free');
  for (let L = 1; L < 5; L++) {
    assert.equal(run(s, d, { type: 'levelChamber', uid: 1 }), null);
    settle(s, d);
  }
  assert.deepEqual([r.x, r.y, r.w, r.h, r.level], [15, 20, 7, 3, 5]);
  // Past the reservation it grows the legacy way (a side to pick).
  const info = nest.levelInfo(s, d, 1);
  assert.equal(info.reserved, false);
  assert.ok(info.dirs.left || info.dirs.right);
});

test('C137: a relocated chamber takes its reservation along (same corner unless another is asked for)', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'tr' }), null);
  settle(s, d);
  const g = last(s);
  assert.equal(run(s, d, { type: 'relocateChamber', uid: g.uid, x: 30, y: 50 }), null);
  assert.equal(anchorOf(g, g.res), 'tr');
  assert.deepEqual(g.res, anchorRect({ x: 30, y: 50, w: 3, h: 2 }, 'tr', 8, 4));
  settle(s, d);
  assert.equal(run(s, d, { type: 'relocateChamber', uid: g.uid, x: 10, y: 50, anchor: 'bl' }), null);
  assert.equal(anchorOf(g, g.res), 'bl');
});

test('C137: blueprints save and reuse reservations (the L1 room at its saved corner)', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'br' }), null);
  settle(s, d);
  const g = last(s);
  for (let L = 1; L < 3; L++) { run(s, d, { type: 'levelChamber', uid: g.uid }); settle(s, d); }
  assert.equal(run(s, d, { type: 'saveBlueprint', slot: 0 }), null);
  const spec = s.era.blueprints[0].chambers[0];
  assert.deepEqual(spec.res, g.res);
  assert.deepEqual([spec.x, spec.y], [26, 30], 'saved by its L1 room corner');
  const { s: s2, d: d2 } = setup();
  s2.cycle.traits.ancestral_blueprint = 1;
  s2.era.blueprints = [s.era.blueprints[0]];
  s2.era.activeBlueprint = 0;
  nest.applyBlueprint(s2, d2);
  const g2 = s2.run.nest.chambers.find((c) => c.type === 'gallery');
  assert.ok(g2, 'placed (auto access tunnel)');
  assert.deepEqual([g2.x, g2.y, g2.w, g2.h], [26, 30, 3, 2]);
  assert.deepEqual(g2.res, spec.res);
});

// ------------------------------------------------------------------------------------------------ C142 keys
test('C142: Q on a chamber picks its type to place another (refused when locked or at its limit); L / Shift+L swapped', () => {
  const { s, d } = setup({ unlockAll: false });
  s.run.unlocked.chamber_gallery = true;
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30 });
  const g = last(s);
  assert.deepEqual(placeAnotherAction(s, d, { view: 'nest', kind: 'chamber', id: g.uid }), { tool: { kind: 'placeChamber', chamber: 'gallery' } });
  assert.match(placeAnotherAction(s, d, { view: 'nest', kind: 'queen', id: 1 }).reject, /limit reached \(1\/1\)/);
  s.run.unlocked.chamber_gallery = false;
  assert.match(placeAnotherAction(s, d, { view: 'nest', kind: 'chamber', id: g.uid }).reject, /not unlocked/);
  assert.equal(placeAnotherAction(s, d, { view: 'surface', kind: 'trail', id: 1 }), null);
  const sel = { view: 'nest', kind: 'chamber', id: g.uid };
  assert.equal(chamberHotkey('l', false, sel).kind, 'levelCheapest');
  assert.equal(chamberHotkey('L', true, sel).kind, 'level');
  const src = (p) => import('node:fs').then((fs) => fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
  return Promise.all([src('../src/ui/app.js'), src('../src/render/nestInput.js')]).then(([app, inp]) => {
    assert.match(app, /placeAnotherAction/, 'app.js routes Q');
    assert.match(inp, /flipAnchor/, 'nestInput flips the corner with F / right-click');
  });
});

// ------------------------------------------------------------------------------------------------ C140 pocket
test('C140: a water pocket moves one tile over its own cells', () => {
  const { s, d } = setup();
  s.run.research.drainage = 1;
  for (const c of rectCells(10, 40, 2, 2)) s.run.nest.cells[c] = CELL.WATER;
  s.run.nest.features.water.push({ x: 10, y: 40, w: 2, h: 2, revealed: true });
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 10, y: 40 }), 'invalid', 'not onto itself');
  assert.equal(run(s, d, { type: 'relocatePocket', pocket: 0, x: 11, y: 40 }), null);
  const job = s.run.nest.queue.at(-1);
  assert.ok(!job.cells.includes(idx(12, 40)) && !job.cells.includes(idx(12, 41)), 'the access tunnel avoids the target cells');
  settle(s, d, 5);
  const p = s.run.nest.features.water[0];
  assert.deepEqual([p.x, p.y], [11, 40]);
  for (const c of rectCells(11, 40, 2, 2)) assert.equal(s.run.nest.cells[c], CELL.WATER);
  assert.equal(s.run.nest.cells[idx(10, 40)], CELL.SOIL);
});

// ------------------------------------------------------------------------------------------------ C139 / C138 blueprints
test('C139: Use during a run applies the blueprint now (queues what it can, plans the rest, skips what is built)', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 12 });
  settle(s, d);
  s.era.blueprints = [{ name: 'Plan', tunnels: [], chambers: [
    { type: 'gallery', x: 26, y: 12, w: 3, h: 2, level: 1 },         // already built: skipped quietly
    { type: 'nursery', x: 22, y: 21, w: 3, h: 2, level: 1 },         // next to the queen: queued now
    { type: 'deep_vault', x: 10, y: 60, w: 4, h: 3, level: 1 },      // locked: planned
  ] }];
  s.run.unlocked.chamber_deep_vault = false;
  const before = s.run.nest.chambers.length;
  assert.equal(run(s, d, { type: 'loadBlueprint', slot: 0 }), null);
  assert.equal(s.era.activeBlueprint, 0);
  assert.equal(s.run.nest.chambers.filter((c) => c.type === 'gallery').length, 1, 'the built gallery is not doubled or dropped');
  assert.ok(s.run.nest.chambers.some((c) => c.type === 'nursery' && c.blueprint), 'queued at once');
  assert.equal(s.run.nest.chambers.length, before + 1);
  assert.deepEqual(s.run.nest.bpPending.map((p) => p.type), ['deep_vault']);
  assert.deepEqual(s.run.nest.bpNotes || [], [], 'nothing dropped');
});

test('C138: a planned chamber the open nest does not reach gets an access tunnel first ("Waiting: digging access tunnel"), then queues', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  s.era.blueprints = [{ name: 'Far', tunnels: [], chambers: [{ type: 'granary', x: 4, y: 30, w: 2, h: 2, level: 1 }] }];
  s.era.activeBlueprint = 0;
  // a reservation between the nest and the spot: the tunnel goes around it
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 10, y: 28, anchor: 'tl' });
  const resCells = new Set(rectCells(10, 28, 8, 4));
  nest.applyBlueprint(s, d);
  assert.deepEqual(s.run.nest.bpPending.map((p) => p.type), ['granary']);
  const acc = s.run.nest.queue.find((j) => j.bpAccess);
  assert.ok(acc && acc.kind === 'tunnel' && acc.blueprint, 'an access tunnel (blueprint speed) is queued');
  assert.ok(acc.cells.every((c) => !resCells.has(c)), 'never through a reserved room');
  assert.ok(acc.cells.every((c) => s.run.nest.cells[c] === CELL.SOIL), 'diggable soil only');
  const w = nest.plannedWaits(s, d)[0];
  assert.equal(w.code, 'wait:access');
  assert.equal(plannedWaitText(w), 'Waiting: digging access tunnel');
  for (let k = 0; k < 4 && !s.run.nest.chambers.some((c) => c.type === 'granary'); k++) settle(s, d, 1.2);
  const gr = s.run.nest.chambers.find((c) => c.type === 'granary');
  assert.ok(gr && gr.blueprint, 'placed once the tunnel is dug');
  assert.deepEqual([gr.x, gr.y], [4, 30]);
  assert.deepEqual(s.run.nest.bpPending, []);
  // with no diggable route at all it waits ("no access tunnel can reach it")
  const b = setup();
  b.s.cycle.traits.ancestral_blueprint = 1;
  for (const c of [...rectCells(2, 49, 6, 1), ...rectCells(2, 54, 6, 1), ...rectCells(2, 49, 1, 6), ...rectCells(7, 49, 1, 6)]) b.s.run.nest.cells[c] = CELL.STONE;
  b.s.run.nest.rev++;
  b.s.era.blueprints = [{ name: 'Walled', tunnels: [], chambers: [{ type: 'granary', x: 4, y: 51, w: 2, h: 2, level: 1 }] }];
  b.s.era.activeBlueprint = 0;
  nest.applyBlueprint(b.s, b.d);
  assert.equal(nest.plannedWaits(b.s, b.d)[0].code, 'wait:path');
  assert.match(plannedWaitText(nest.plannedWaits(b.s, b.d)[0]), /no access tunnel/);
  void GRID;
});
