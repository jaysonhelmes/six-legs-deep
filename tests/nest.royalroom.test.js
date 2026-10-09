// WP3 regression tests (ARCHITECTURE §18 C64, C66, C67): the Royal Chamber can never be permanently walled in below the
// Flight level (Royal L5, DESIGN §13.1). Growth (directed or not) that would take its last room is refused with
// 'blocked:royalRoom'; the Royal Chamber's own growth stays inside a footprint it can complete; the guard sees the row rule,
// shafts and stones; the Nuptial exit shaft, satellite shafts and blueprints avoid the room; nest generation keeps
// boulders out of it; a Shallow Soil run can still build its Nuptial Chamber.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { FLIGHT } from '../src/data/prestige.js';
import * as nest from '../src/systems/nest.js';
import * as prestige from '../src/systems/prestige.js';
import { countInRadius } from '../src/core/hex.js';
import { generateNest } from '../src/systems/nestgen.js';
import { idx, rectCells, footprint } from '../src/systems/nestgeom.js';

function setup({ food = 1e6, soil = 1e6 } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 0 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food, soil, chitin: 1e6, honeydew: 1e6 });
  // C137: these tests cover the C66 guard of a Royal Chamber without a reservation (older saves where its Flight-level
  // room was not free); a reserved Royal Chamber is covered in nest.reservation.test.js.
  const r = s.run.nest.chambers.find((c) => c.uid === 1);
  delete r.res;
  r.noRes = true;
  s.run.nest.rev++;
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

/** validate + apply a nest command; returns the reason (null on success). */
function run(s, d, cmd, env = fakeEnv()) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  nest.derive(s, d);
  return r;
}

const royalOf = (s) => s.run.nest.chambers.find((c) => c.uid === 1);

test('default layout: the Royal Chamber (4×2 at 18,20) has its Flight-level room; nothing blocks yet', () => {
  const { s } = setup();
  const r = royalOf(s);
  assert.deepEqual([r.x, r.y, r.w, r.h, r.level], [GRID.royal.x, GRID.royal.y, GRID.royal.w, GRID.royal.h, 1]);
  assert.equal(FLIGHT.royalLevel, 5);
  assert.equal(nest.blocksRoyalGrowth(s, { x: 30, y: 30, w: 3, h: 2 }), false);
});

test('a chamber right under the Royal Chamber is flagged (it cannot grow up: row rule ≥ 20 and the main shaft)', () => {
  // Before C66 the guard counted Flight footprints starting on row 19 as free, so this, the most common box-in
  // (Nursery adjacency bonus), was never flagged.
  const { s, d } = setup();
  assert.equal(nest.blocksRoyalGrowth(s, { x: 18, y: 22, w: 3, h: 2 }), true);
  const v = nest.validatePlacement(s, d, 'nursery', 18, 22);
  assert.equal(v.ok, true, 'placement stays legal (DESIGN §7.4)');
  assert.ok(v.mods.some((m) => m.key === 'royalRoom'), JSON.stringify(v.mods));
  assert.equal(v.tint, 'amber');
  // Beside it on the Royal rows leaves room on the other side: no warning.
  assert.equal(nest.blocksRoyalGrowth(s, { x: 15, y: 20, w: 3, h: 2 }), false);
  // The advisor never suggests a box-in spot for the Nursery (its adjacency partner is the Royal Chamber).
  const spot = nest.findPlacement(s, d, 'nursery');
  assert.ok(spot);
  assert.equal(nest.blocksRoyalGrowth(s, { x: spot.x, y: spot.y, w: 3, h: 2 }), false, JSON.stringify(spot));
});

test('directed growth that would take the last room is refused with royalRoom; the other direction still works', () => {
  const { s, d } = setup();
  addChamber(s, 'nursery', 15, 22, 3, 2);          // takes every Flight footprint reaching column 17 → room: x 18..24 only
  const g = addChamber(s, 'gallery', 25, 20, 3, 2);  // growing left would take column 24
  nest.derive(s, d);
  const info = nest.levelInfo(s, d, g.uid);
  assert.equal(info.grows, true);
  assert.deepEqual(info.dirs, { left: false, right: true, up: false, down: false });
  assert.equal(info.royalRoom, true);
  assert.equal(info.blocked, false);
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid, dir: 'left' }), 'blocked:royalRoom');
  assert.deepEqual([g.x, g.w, g.status], [25, 3, 'active'], 'nothing paid or changed');
  // Without a direction the engine picks the safe one.
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid }), null);
  assert.deepEqual([g.x, g.w, g.status], [25, 4, 'growing']);
  assert.equal(nest.blocksRoyalGrowth(s, { x: 17, y: 25, w: 1, h: 1 }), false);
});

test('when every valid direction would wall the queen in, the level-up is refused (even with no direction)', () => {
  const { s, d } = setup();
  addChamber(s, 'nursery', 15, 22, 3, 2);
  const g = addChamber(s, 'gallery', 25, 20, 3, 2);
  setCells(s, [idx(28, 20), idx(28, 21)], CELL.STONE);   // the right side is stone
  nest.derive(s, d);
  const info = nest.levelInfo(s, d, g.uid);
  assert.equal(info.blocked, true);
  assert.equal(info.royalRoom, true, 'the UI can say why: level the Royal Chamber to L5 first, or relocate');
  assert.deepEqual(info.dirs, { left: false, right: false, up: false, down: false });
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid }), 'blocked:royalRoom');
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid, dir: 'right' }), 'blocked', 'stone is a plain block');
  // The autobuyer skips it too.
  assert.equal(nest.autoLevelStep(s, d, fakeEnv()), true, 'something else (the Royal Chamber) is levelled');
  assert.equal(g.status, 'active');
  // Once the Royal Chamber has reached the Flight level the guard is gone.
  const r = royalOf(s);
  r.level = 5;
  r.target = 5;
  r.status = 'active';
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid, dir: 'left' }), null);
});

test('a chamber that already walls the queen in is not frozen by the guard (nothing left to protect)', () => {
  const { s, d } = setup();
  const n = addChamber(s, 'nursery', 18, 22, 3, 2);    // placed despite the amber warning
  nest.derive(s, d);
  assert.equal(nest.blocksRoyalGrowth(s, { x: 30, y: 30, w: 3, h: 2 }), false);
  const info = nest.levelInfo(s, d, n.uid);
  assert.equal(info.royalRoom, false);
  assert.equal(info.blocked, false);
  // Relocating it away frees the room again (relocation keeps the level: no demolition needed).
  assert.equal(nest.blocksRoyalGrowth(s, { x: 18, y: 22, w: 3, h: 2 }, n.uid), true);
  assert.equal(run(s, d, { type: 'relocateChamber', uid: n.uid, x: 12, y: 20 }), null);
});

test('the Royal Chamber itself only grows inside a Flight-level footprint it can still complete', () => {
  const { s, d } = setup();
  const r = royalOf(s);
  Object.assign(r, { x: 18, y: 20, w: 5, h: 2, level: 2, target: 2 });   // L2 footprint
  setCells(s, rectCells(18, 20, 5, 2), CELL.CHAMBER);
  setCells(s, [idx(14, 20), idx(14, 21), idx(14, 22)], CELL.STONE);      // no footprint from column 14
  setCells(s, [idx(23, 22)], CELL.STONE);                                // none reaching column 23 (row 22)
  nest.derive(s, d);
  // The only room left is x 16..22: growing right (to column 23, rows 20–21 are free) would strand it.
  const info = nest.levelInfo(s, d, 1);
  assert.deepEqual(info.dirs, { left: true, right: false, up: false, down: false });
  assert.equal(info.royalRoom, true);
  assert.equal(run(s, d, { type: 'levelChamber', uid: 1, dir: 'right' }), 'blocked:royalRoom');
  assert.equal(run(s, d, { type: 'levelChamber', uid: 1 }), null);
  assert.deepEqual([r.x, r.w], [17, 6], 'grew left');
});

test('the full path to L5 always exists from the default layout when every level is grown with no direction', () => {
  const { s, d } = setup();
  addChamber(s, 'nursery', 15, 22, 3, 2);
  const r = royalOf(s);
  for (let L = 1; L < FLIGHT.royalLevel; L++) {
    assert.equal(run(s, d, { type: 'levelChamber', uid: 1 }), null, 'level ' + L);
    // dig the growth instantly
    for (const job of s.run.nest.queue.splice(0)) for (const c of job.cells) s.run.nest.cells[c] = CELL.CHAMBER;
    r.level = r.target;
    r.status = 'active';
    s.run.nest.rev++;
    nest.derive(s, d);
  }
  assert.equal(r.level, FLIGHT.royalLevel);
  const fp = footprint('royal_chamber', FLIGHT.royalLevel);
  assert.deepEqual([r.w, r.h], [fp.w, fp.h]);
});

test('relocating the Royal Chamber into a spot with no growth room warns (amber royalRoom)', () => {
  const { s, d } = setup();
  for (let y = 26; y <= 34; y++) setCells(s, [idx(35, y)], CELL.STONE);  // column 35 stone: no 8-wide footprint at x ≥ 32
  nest.derive(s, d);
  const v = nest.validatePlacement(s, d, 'royal_chamber', 36, 30, { relocateUid: 1 });
  assert.equal(v.reason, null);
  assert.ok(v.mods.some((m) => m.key === 'royalRoom'), JSON.stringify(v.mods));
  const ok = nest.validatePlacement(s, d, 'royal_chamber', 10, 30, { relocateUid: 1 });
  assert.ok(!ok.mods.some((m) => m.key === 'royalRoom'));
});

test('C125: a Nuptial exit shaft through the Royal room does not take it (the Royal Chamber may grow over a shaft)', () => {
  const { s, d } = setup();
  addChamber(s, 'gallery', 15, 20, 3, 3);   // room left: x 18..24 only (C97: the L5 Royal footprint is 7×3)
  nest.derive(s, d);
  // Column 24 (centre of the chamber at x 22..26) runs through every free Flight-level footprint, but below its top
  // rows a shaft passes through chambers, so it is no obstacle any more: no warning, and the default keeps column 24.
  const v = nest.validatePlacement(s, d, 'nuptial_chamber', 22, 24, { shaftCol: 24 });
  assert.equal(v.ok, true);
  assert.ok(!v.mods.some((m) => m.key === 'royalRoom'), 'explicit column 24 no longer warns');
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'nuptial_chamber', x: 22, y: 24 }), null);
  const sh = s.run.nest.shafts.find((x) => x.kind === 'nuptial');
  assert.equal(sh.col, 24);
  assert.equal(nest.blocksRoyalGrowth(s, { x: 0, y: 70, w: 1, h: 1 }), false, 'room kept with the queued shaft counted');
});

test('C125: a satellite shaft through the Royal room no longer takes it (shaftBoxesRoyal only counts the shaft top rows)', () => {
  const { s, d } = setup();
  addChamber(s, 'gallery', 15, 20, 3, 3);
  nest.derive(s, d);
  assert.equal(nest.shaftBoxesRoyal(s, d, 24), false, 'the Royal Chamber may grow over the shaft');
  assert.equal(nest.shaftBoxesRoyal(s, d, 30), false);
  assert.equal(nest.shaftBoxesRoyal(s, d, 4), false);
  // Through the WP7 command.
  const ring3 = countInRadius(2);
  d.surface.owned[ring3] = 1;
  s.era.federation.satellite_nest = 1;
  const v = (col) => prestige.handlers.placeSatellite.validate(s, d, { type: 'placeSatellite', hex: ring3, col });
  assert.equal(v(24), null);
  assert.equal(v(30), null);
});

test('an active blueprint never places a chamber that walls the queen in', () => {
  const { s, d } = setup();
  s.era.blueprints = [{ name: 'boxed', tunnels: [], chambers: [
    { type: 'nursery', x: 18, y: 22, w: 3, h: 2, level: 1 },
    { type: 'gallery', x: 21, y: 12, w: 3, h: 2, level: 1 },
  ] }];
  s.era.activeBlueprint = 0;
  s.cycle.traits.ancestral_blueprint = 1; // C258: blueprints apply only with the unlock
  nest.applyBlueprint(s, d);
  const types = s.run.nest.chambers.map((c) => c.type);
  assert.ok(types.includes('gallery'), 'the harmless chamber is queued');
  assert.ok(!types.includes('nursery'), 'the box-in is skipped');
});

test('nest generation keeps boulders and water out of the Royal Chamber’s Flight-level growth zone', () => {
  const fp = footprint('royal_chamber', FLIGHT.royalLevel);
  const r = GRID.royal;
  const x0 = r.x - (fp.w - r.w);
  const x1 = r.x + r.w - 1 + (fp.w - r.w);
  // Seeds 273, 303, 691 and 1289 (stony ground) walled the queen in with boulders before C66 (about 1 run in 1,100,
  // 1 in 240 on stony ground); fixing them needed the 10,000-insight acid_excavation.
  const seeds = [273, 303, 691, 1289];
  for (let k = 1; k <= 400; k++) seeds.push(k * 2654435761 >>> 0);
  for (const seed of seeds) {
    const n = generateNest(seed, { tags: seed % 2 || seed < 2000 ? ['site_stony_ground'] : [] });
    for (let y = r.y; y < r.y + fp.h; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = n.cells[idx(x, y)];
        assert.ok(c !== CELL.STONE && c !== CELL.WATER, 'seed ' + seed + ': obstacle at ' + x + ',' + y);
      }
    }
  }
});

test('Shallow Soil (C67): the Nuptial Chamber can be placed above row 24, so the Flight stays possible', () => {
  const { s, d } = setup();
  assert.equal(nest.validatePlacement(s, d, 'nuptial_chamber', 4, 21).reason, 'invalid:row', 'normal runs: row ≥ 24');
  s.run.hardship = 'shallow_soil';
  nest.derive(s, d);
  assert.equal(nest.validatePlacement(s, d, 'nuptial_chamber', 4, 26).reason, 'hardship', 'nothing below row 23');
  const v = nest.validatePlacement(s, d, 'nuptial_chamber', 4, 20);
  assert.equal(v.ok, true, String(v.reason));
  // Its largest footprint (L4: 8×4) still fits above row 24, so it can reach its max level.
  assert.equal(nest.validatePlacement(s, d, 'nuptial_chamber', 4, 19).reason, 'invalid:row');
  assert.ok(nest.findPlacement(s, d, 'nuptial_chamber'), 'the advisor finds a spot');
});
