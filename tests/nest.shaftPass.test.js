// C125 (player report): shafts must not block chambers. A chamber may cover shaft cells below a shaft's top
// SHAFT_KEEP_ROWS rows; the shaft passes through it (entrance connectivity, path distances, raid reach), demolishing
// the chamber gives the shaft back, and a blueprint places such a chamber. C126: pending blueprint chambers say why
// they wait (nest.plannedWaits, text.plannedWaitText).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { DIG } from '../src/data/strata.js';
import * as nest from '../src/systems/nest.js';
import { idx, rectCells, SHAFT_KEEP_ROWS } from '../src/systems/nestgeom.js';
import { plannedWaitText } from '../src/ui/text.js';

const COL = GRID.mainCol; // 20; the main shaft runs rows 0–19 above the Royal Chamber (rows 20–21, x 18–21)

function setup({ food = 1e6, soil = 1e6, digW = 0, unlockAll = true } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW } });
  if (unlockAll) for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food, soil, chitin: 1e6, honeydew: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd, env = fakeEnv()) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  return r;
}

function stepNest(s, d, dt = 1) {
  const env = fakeEnv({ dt });
  nest.derive(s, d);
  s.run.nest.digAllow = 1e12; // C252: dig everything queued this step (the dig cap has its own tests)
  nest.tick(s, d, dt, env);
  return env.events;
}

function setCells(s, list, code) {
  for (const c of list) s.run.nest.cells[c] = code;
  s.run.nest.rev++;
}

const royalCell = idx(COL, 20);

test('C125: a nursery over the main shaft above the Royal Chamber is allowed and the shaft passes through it', () => {
  const { s, d } = setup({ digW: 1e6 });
  const distBefore = d.nest.dist[royalCell];
  assert.equal(distBefore, 20, 'Royal Chamber 20 path cells from the entrance');
  const v = nest.validatePlacement(s, d, 'nursery', 19, 17);
  assert.equal(v.reason, null);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'nursery', x: 19, y: 17 }), null);
  const sh = s.run.nest.shafts.find((x) => x.kind === 'main');
  assert.equal(sh.thru, 19, 'the shaft remembers it runs down to row 19');
  // The covered shaft cells are chamber (open) cells at once: the entrance stays connected while it is dug.
  for (const y of [17, 18]) {
    assert.equal(s.run.nest.cells[idx(COL, y)], CELL.CHAMBER);
    assert.equal(d.nest._pass[idx(COL, y)], 1, 'passes through at row ' + y);
  }
  assert.equal(d.nest._shaft[idx(COL, 19)], 1, 'still shaft below the chamber');
  assert.equal(d.nest._shaft[idx(COL, 16)], 1, 'still shaft above the chamber');
  assert.ok(d.nest.entDist[royalCell] >= 0, 'Royal Chamber connected while digging');
  stepNest(s, d, 1);
  const nur = s.run.nest.chambers.find((c) => c.type === 'nursery');
  assert.equal(nur.status, 'active');
  nest.derive(s, d);
  assert.equal(d.nest.dist[royalCell], distBefore, 'haul distance unchanged (straight down through the nursery)');
  assert.equal(d.nest.entDist[royalCell], distBefore);
  const j = s.run.nest.chambers.indexOf(nur);
  assert.equal(d.nest.chambers[j].minEntPath, 17, 'raid-reach path measured straight down the shaft (row 17)');
  assert.equal(d.nest._shaft[idx(COL, 19)], 1);
  assert.equal(d.nest._pass[idx(COL, 18)], 1);
  // Backfilling the shaft below it is still refused (shafts stay open; it would also cut the queen off).
  assert.notEqual(run(s, d, { type: 'backfill', cells: [idx(COL, 19)] }), null);
});

test('C125: demolishing (or relocating) a chamber over a shaft gives the shaft back as tunnel, entrance connected', () => {
  const { s, d } = setup({ digW: 1e6 });
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'nursery', x: 19, y: 17 }), null);
  stepNest(s, d, 1);
  const nur = s.run.nest.chambers.find((c) => c.type === 'nursery');
  assert.equal(run(s, d, { type: 'demolishChamber', uid: nur.uid }), null);
  nest.derive(s, d);
  for (let y = 0; y < 20; y++) {
    assert.equal(s.run.nest.cells[idx(COL, y)], CELL.TUNNEL, 'shaft cell row ' + y);
    assert.equal(d.nest._shaft[idx(COL, y)], 1, 'shaft mask row ' + y);
  }
  assert.equal(d.nest.entDist[royalCell], 20);
  // Relocate one away from the shaft: the shaft cells it covered become tunnel (shaft) again.
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 19, y: 10 }), null);
  stepNest(s, d, 1);
  const gal = s.run.nest.chambers.find((c) => c.type === 'gallery');
  assert.equal(gal.status, 'active');
  assert.equal(run(s, d, { type: 'relocateChamber', uid: gal.uid, x: 22, y: 10 }), null);
  stepNest(s, d, 1);
  nest.derive(s, d);
  for (const y of [10, 11]) assert.equal(d.nest._shaft[idx(COL, y)], 1, 'shaft again at row ' + y);
  assert.equal(d.nest.entDist[royalCell], 20);
});

test('C125: the top SHAFT_KEEP_ROWS rows of a shaft stay shaft; growth may cover deeper shaft cells', () => {
  const { s, d } = setup({ digW: 1e6 });
  assert.equal(SHAFT_KEEP_ROWS, 2);
  assert.equal(nest.validatePlacement(s, d, 'gallery', 19, 1).reason, 'blocked:shaft', 'row 1 is kept');
  assert.equal(nest.validatePlacement(s, d, 'gallery', 19, 2).reason, null, 'row 2 may be covered');
  // A Thermal Chimney must touch row 0, so it may not sit on a shaft column at all; beside it is fine.
  assert.equal(nest.validatePlacement(s, d, 'thermal_chimney', 20, 0).reason, 'blocked:shaft');
  // Growth over the shaft: a gallery right of the shaft grows left across it (C137: its reserved room extends left over
  // the shaft, anchor top-right).
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12, anchor: 'tr' }), null);
  stepNest(s, d, 1);
  const g = s.run.nest.chambers.find((c) => c.type === 'gallery');
  assert.deepEqual(g.res, { x: 16, y: 12, w: 8, h: 4 });
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid }), null);
  stepNest(s, d, 1);
  nest.derive(s, d);
  assert.deepEqual([g.x, g.w, g.level], [20, 4, 2]);
  assert.equal(s.run.nest.shafts[0].thru, 19);
  assert.equal(d.nest._pass[idx(COL, 12)], 1);
  assert.equal(d.nest.entDist[royalCell], 20, 'still connected');
});

test('C125: a satellite shaft through a chamber keeps its entrance connected to the nest', () => {
  const { s, d } = setup({ digW: 1e6 });
  const uid = nest.queueShaft(s, d, 30, 'satellite', 0);
  assert.ok(uid > 0);
  stepNest(s, d, 1);
  nest.derive(s, d);
  const sat = s.run.nest.shafts.find((x) => x.kind === 'satellite');
  assert.equal(sat.open, true);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 29, y: 5 }), null);
  stepNest(s, d, 1);
  nest.derive(s, d);
  assert.ok(d.nest._pass[idx(30, 5)] === 2, 'satellite shaft passes through');
  assert.ok(d.nest.entDist[idx(30, 0)] === 0);
  assert.ok(d.nest.dist[idx(30, 0)] >= 0, 'satellite top still joins the main shaft');
});

test('C125: an active blueprint places a nursery over the main shaft (the player case)', () => {
  const { s, d } = setup();
  s.era.blueprints = [{ name: 'over shaft', tunnels: [], chambers: [{ type: 'nursery', x: 19, y: 17, w: 3, h: 2, level: 1 }] }];
  s.era.activeBlueprint = 0;
  s.cycle.traits.ancestral_blueprint = 1; // C258: blueprints apply only with the unlock
  nest.applyBlueprint(s, d);
  const nur = s.run.nest.chambers.find((c) => c.type === 'nursery');
  assert.ok(nur && nur.blueprint, 'placed');
  assert.deepEqual([nur.x, nur.y], [19, 17]);
  assert.deepEqual(s.run.nest.bpPending, []);
  nest.derive(s, d);
  assert.equal(d.nest.entDist[royalCell], 20);
});

test('C125: a blueprint spot over a shaft top is dropped; a Nuptial Chamber with no exit-shaft column for now waits', () => {
  const { s, d } = setup();
  s.era.blueprints = [{ name: 'top', tunnels: [], chambers: [{ type: 'gallery', x: 19, y: 1, w: 3, h: 2, level: 1 }] }];
  s.era.activeBlueprint = 0;
  s.cycle.traits.ancestral_blueprint = 1; // C258: blueprints apply only with the unlock
  nest.applyBlueprint(s, d);
  assert.ok(!s.run.nest.chambers.some((c) => c.type === 'gallery'));
  assert.deepEqual(s.run.nest.bpPending, [], 'dropped (permanent)');
});

// ------------------------------------------------------------------------------------------------ C126 waiting reasons
function pend(s, list) {
  s.run.nest.bpPending = list;
  s.run.nest.rev++;
}

test('C126: plannedWaits names why each pending blueprint chamber waits; the text reads "Waiting: …"', () => {
  const { s, d } = setup({ unlockAll: false });
  s.run.unlocked[CHAMBERS.gallery.unlock] = true;
  s.run.unlocked[CHAMBERS.nursery.unlock] = true;
  s.run.unlocked[CHAMBERS.granary.unlock] = true;
  // C66 case below needs a Royal Chamber without a reservation (a reserved one makes that spot 'blocked:reserved')
  const r1 = s.run.nest.chambers.find((c) => c.uid === 1);
  delete r1.res;
  r1.noRes = true;
  nest.derive(s, d);
  setCells(s, [idx(31, 12)], CELL.STONE);
  pend(s, [
    { type: 'barracks', x: 24, y: 8 },          // locked
    { type: 'gallery', x: 30, y: 12 },          // stone in the footprint
    { type: 'nursery', x: 18, y: 22 },          // right under the queen: walls in the Royal Chamber
    { type: 'granary', x: 22, y: 15 },          // fine: next to nothing open → C138 access tunnel on the next check
    { type: 'water_well', x: 4, y: 50, float: true },
  ]);
  const w = nest.plannedWaits(s, d);
  const by = (t) => w.find((x) => x.type === t);
  assert.equal(by('barracks').code, 'locked');
  assert.equal(by('barracks').detail.key, CHAMBERS.barracks.unlock);
  assert.match(plannedWaitText(by('barracks')), /^Waiting: locked — unlocks: research Polymorphism$/);
  assert.equal(by('gallery').code, 'blocked:stone');
  assert.equal(plannedWaitText(by('gallery')), 'Waiting: stone in the way — needs Acid Excavation');
  assert.equal(by('nursery').code, 'blocked:royalRoom');
  assert.equal(plannedWaitText(by('nursery')), 'Waiting: would wall in the Royal Chamber (level it to L5 first)');
  assert.equal(by('granary').code, 'wait:next');
  assert.equal(by('water_well').code, 'locked', 'locked comes first');
  assert.equal(nest.plannedWait(s, d, 12 * 40 + 30).code, 'blocked:stone');
  assert.equal(nest.plannedWait(s, d, 0), null);
  // Cached: the same list until the nest, the unlocks, the pending list or a second of run time changes.
  assert.equal(nest.plannedWaits(s, d), w);
  s.run.time = (s.run.time || 0) + 1.5;
  assert.notEqual(nest.plannedWaits(s, d), w);
});

test('C126: cost (blueprint half price), instance limit, queued cells, floating Wells and the next check', () => {
  const { s, d } = setup({ food: 10 });
  const half = CHAMBERS.scent_library.place.food * DIG.blueprintPlaceMult;
  pend(s, [{ type: 'scent_library', x: 21, y: 12 }]);
  let w = nest.plannedWaits(s, d)[0];
  assert.equal(w.code, 'cantAfford');
  assert.equal(w.detail.cost.food, half);
  assert.match(plannedWaitText(w), /^Waiting: \S+ food \(blueprint half price\)$/);
  s.run.res.food = 1e6;
  pend(s, [{ type: 'scent_library', x: 21, y: 12 }]);
  w = nest.plannedWaits(s, d)[0];
  assert.equal(w.code, 'wait:next', 'touches the open shaft: queues on the next check');
  assert.equal(plannedWaitText(w), 'Waiting: queues on the next check');
  // Instance limit
  const max = CHAMBERS.thermal_chimney.maxInst;
  for (let k = 0; k < max; k++) {
    s.run.nest.chambers.push({ uid: s.run.nest.nextUid++, type: 'thermal_chimney', k, x: 2 + 3 * k, y: 0, w: 2, h: 4, level: 1, target: 1,
      status: 'active', blueprint: false, bornAt: 0 });
  }
  pend(s, [{ type: 'thermal_chimney', x: 30, y: 0 }]);
  w = nest.plannedWaits(s, d)[0];
  assert.equal(w.code, 'max');
  assert.equal(plannedWaitText(w), 'Waiting: Thermal Chimney limit reached (' + max + '/' + max + ')');
  // Queued cells (another dig job runs through the footprint)
  s.run.nest.queue.push({ uid: s.run.nest.nextUid++, kind: 'tunnel', chamber: 0, cells: [idx(26, 30)], cur: 0, prog: 0, paidFood: 0, blueprint: false });
  pend(s, [{ type: 'gallery', x: 25, y: 30 }]);
  w = nest.plannedWaits(s, d)[0];
  assert.equal(w.code, 'blocked:queued');
  assert.equal(plannedWaitText(w), 'Waiting: cells still being dug');
  // A floating Water Well with no revealed pocket
  s.run.nest.features.water = [];
  pend(s, [{ type: 'water_well', x: 4, y: 50, float: true }]);
  w = nest.plannedWaits(s, d)[0];
  assert.equal(w.code, 'max', 'no revealed pocket: the per-pocket limit is 0');
  for (const t of ['blocked:backfill', 'blocked:layer', 'hardship', 'invalid:water', 'wait:water', 'wait:path', 'blocked:shaft', 'invalid:row']) {
    const txt = plannedWaitText({ type: 'gallery', code: t, detail: null });
    assert.match(txt, /^Waiting: [a-z]/, t);
    assert.ok(txt.length > 15 && !/That will not work here/.test(txt), t + ': ' + txt);
  }
  assert.equal(plannedWaitText({ type: 'nuptial_chamber', code: 'blocked:shaft' }), 'Waiting: no free column for its own exit shaft yet');
});
