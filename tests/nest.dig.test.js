// WP3 dig tests: placeChamber → dig queue → activation exactly at the last cell (ARCHITECTURE §16 WP3), level-ups with
// growth and blocked directions, relocate, demolish, cancel, tunnels, digTo, backfill (disconnection refused), Help Dig,
// caches / water reveal, offline log, nuptial shaft → entrance (DESIGN §7.2–§7.11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import * as nest from '../src/systems/nest.js';
import { idx, rectCells } from '../src/systems/nestgeom.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

function setup({ food = 1e6, soil = 1e6, digW = 0 } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food, soil, chitin: 1e6, honeydew: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

/** validate + apply a nest command; returns the reason (null on success). */
function run(s, d, cmd, env = fakeEnv()) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  return r;
}

/** One nest step: derive then tick (as step() does). */
function stepNest(s, d, dt = 1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  nest.derive(s, d);
  nest.tick(s, d, dt, env);
  return env.events;
}

function setCells(s, list, code) {
  for (const c of list) s.run.nest.cells[c] = code;
  s.run.nest.rev++;
}

test('a placed Gallery activates exactly when its last cell is dug', () => {
  const { s, d } = setup({ digW: 9 });
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12 }), null);
  const ch = s.run.nest.chambers[1];
  assert.equal(ch.type, 'gallery');
  assert.equal(ch.status, 'digging');
  assert.equal(ch.level, 0);
  assert.equal(ch.target, 1);
  assert.equal(ch.k, 0);
  assert.equal(s.run.res.food, 1e6 - 40);
  const job = s.run.nest.queue[0];
  assert.equal(job.kind, 'chamber');
  assert.equal(job.chamber, ch.uid);
  assert.equal(job.cells.length, 6);
  assert.equal(job.paidFood, 40);
  assert.deepEqual(new Set(job.cells), new Set(rectCells(21, 12, 3, 2)));
  // First cell dug must touch an open cell (BFS order from the shaft).
  assert.ok([idx(21, 12), idx(21, 13)].includes(job.cells[0]));
  // 9 work per cell (loam 6 × 1.5), digW 9 → one cell per second.
  for (let t = 1; t <= 5; t++) {
    const ev = stepNest(s, d, 1);
    assert.equal(ev.filter((e) => e.type === 'cellDug').length, 1, 'tick ' + t);
    assert.equal(ev.filter((e) => e.type === 'chamberActivated').length, 0);
    assert.equal(ch.status, 'digging');
  }
  assert.equal(d.nest.queueInfo.length, 1);
  assert.equal(d.nest.queueInfo[0].work, 9);
  assert.equal(d.nest.queueInfo[0].eta, 1);
  const ev = stepNest(s, d, 1);
  const act = ev.filter((e) => e.type === 'chamberActivated');
  // §10 payload { uid, type, level }: the chamber type rides in 'chamber' because the event's own 'type' wins.
  assert.deepEqual({ ...act[0] }, { type: 'chamberActivated', uid: ch.uid, chamberType: 'gallery', level: 1 }); // §10 (integration rename)
  assert.equal(act.length, 1);
  assert.equal(act[0].uid, ch.uid);
  assert.equal(act[0].level, 1);
  assert.equal(ch.status, 'active');
  assert.equal(ch.level, 1);
  assert.equal(s.run.nest.queue.length, 0);
  assert.equal(s.run.stats.chambersDone, 1);
  assert.equal(s.run.stats.cellsDug, 6);
  assert.equal(s.meta.counters.cellsDug, 6);
  for (const c of rectCells(21, 12, 3, 2)) assert.equal(s.run.nest.cells[c], CELL.CHAMBER);
  assert.equal(d.nest.digFace, -1);
  nest.derive(s, d);
  assert.ok(near(d.nest.agg.housingBase, 10 + CHAMBERS.gallery.fx.housing * 1.1));
  assert.equal(stepNest(s, d, 1).length, 0, 'idle afterwards');
  assert.ok(s.run.nest.maint > 0, 'leftover work → maint');
});

test('work splits across cells within one tick; partial progress carries; eff and econDt scale dig work', () => {
  const { s, d } = setup({ digW: 4 });
  run(s, d, { type: 'digTunnel', cells: [idx(21, 5), idx(22, 5), idx(23, 5)] });
  stepNest(s, d, 1); // 4 work: exactly one topsoil cell
  assert.equal(s.run.nest.cells[idx(21, 5)], CELL.TUNNEL);
  stepNest(s, d, 0.5); // 2 work: half a cell
  assert.equal(s.run.nest.queue[0].prog, 2);
  assert.equal(s.run.nest.cells[idx(22, 5)], CELL.SOIL);
  stepNest(s, d, 1, { eff: 0.5 }); // 2 more work → completes
  assert.equal(s.run.nest.cells[idx(22, 5)], CELL.TUNNEL);
  stepNest(s, d, 0.5, { econScale: 2 }); // 4 work
  assert.equal(s.run.nest.cells[idx(23, 5)], CELL.TUNNEL);
  assert.equal(s.run.nest.queue.length, 0);
  assert.equal(s.run.nest.deepestRow, 21);
});

test('digging deeper updates deepestRow (run and lifetime) and rev', () => {
  const { s, d } = setup({ digW: 1000 });
  const path = [];
  for (let y = 21; y <= 26; y++) path.push(idx(22, y)); // C137: x 15–21 below the queen is her reserved room
  const rev = s.run.nest.rev;
  assert.equal(run(s, d, { type: 'digTunnel', cells: path }), null);
  stepNest(s, d, 1);
  assert.equal(s.run.nest.deepestRow, 26);
  assert.equal(s.meta.stats.deepestRow, 26);
  assert.ok(s.run.nest.rev > rev);
});

test('level-up (legacy chamber without a reservation): growing types queue growth cells in the chosen direction; level applies when dug', () => {
  const { s, d } = setup({ digW: 9 });
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12 });
  stepNest(s, d, 100);
  const ch = s.run.nest.chambers[1];
  // C137: chambers from older saves with no free full-size rectangle keep the grow-a-side rule
  delete ch.res;
  ch.noRes = true;
  s.run.nest.rev++;
  assert.equal(ch.status, 'active');
  const info = nest.levelInfo(s, d, ch.uid);
  assert.equal(info.grows, true);
  // C125: left grows over the main shaft (it passes through the chamber)
  assert.deepEqual(info.dirs, { left: true, right: true, up: false, down: false });
  assert.equal(info.blocked, false);
  assert.ok(near(info.cost.food, 10 * 1.3) && near(info.cost.soil, 24 * 1.3), 'f0 × g^L, s0 × g^L at L1');
  assert.deepEqual(info.dirRects.left, { x: 20, y: 12, w: 4, h: 2 }, 'left takes the shaft column');
  assert.equal(run(s, d, { type: 'levelChamber', uid: ch.uid, dir: 'up' }), 'invalid:dir', 'height does not grow at L1→L2');
  const ev = fakeEnv();
  assert.equal(run(s, d, { type: 'levelChamber', uid: ch.uid, dir: 'right' }, ev), null);
  assert.equal(ch.status, 'growing');
  assert.equal(ch.level, 1);
  assert.equal(ch.target, 2);
  assert.deepEqual([ch.x, ch.y, ch.w, ch.h], [21, 12, 4, 2]);
  assert.ok(near(s.run.res.soil, 1e6 - 24 * 1.3));
  const job = s.run.nest.queue[0];
  assert.equal(job.kind, 'grow');
  assert.deepEqual(new Set(job.cells), new Set([idx(24, 12), idx(24, 13)]));
  assert.equal(run(s, d, { type: 'levelChamber', uid: ch.uid }), 'busy');
  stepNest(s, d, 1);
  assert.equal(ch.level, 1);
  const evs = stepNest(s, d, 1);
  assert.equal(ch.level, 2);
  assert.equal(ch.status, 'active');
  assert.deepEqual(evs.filter((e) => e.type === 'chamberLeveled').map((e) => e.level), [2]);
  // L3 → L4 grows only the height (C97: one side per level-up, never width and height at once).
  ch.level = 3;
  ch.target = 3;
  ch.w = 5;
  ch.h = 2;
  setCells(s, rectCells(21, 12, 5, 2), CELL.CHAMBER);
  const i3 = nest.levelInfo(s, d, ch.uid);
  assert.equal(i3.dirs.right, false);
  assert.equal(i3.dirs.left, false);
  assert.equal(i3.dirs.up, true);
  assert.equal(i3.dirs.down, true);
  assert.deepEqual(i3.dirRects.up, { x: 21, y: 11, w: 5, h: 3 });
  assert.deepEqual(i3.dirRects.down, { x: 21, y: 12, w: 5, h: 3 });
  assert.equal(run(s, d, { type: 'levelChamber', uid: ch.uid, dir: 'right' }), 'invalid:dir');
  assert.equal(run(s, d, { type: 'levelChamber', uid: ch.uid, dir: 'up' }), null);
  assert.deepEqual([ch.x, ch.y, ch.w, ch.h], [21, 11, 5, 3]);
  assert.deepEqual(new Set(s.run.nest.queue.at(-1).cells), new Set(rectCells(21, 11, 5, 1)), 'one new row, nothing else');
});

test('non-growing chambers (and L > 8) level up at once; max level reported', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gate', x: 21, y: 0 }), null);
  d.stats.digW = 1e6;
  stepNest(s, d, 1);
  const gate = s.run.nest.chambers.find((c) => c.type === 'gate');
  assert.equal(gate.status, 'active');
  const env = fakeEnv();
  assert.equal(run(s, d, { type: 'levelChamber', uid: gate.uid }, env), null);
  assert.equal(gate.level, 2);
  assert.deepEqual(env.events.filter((e) => e.type === 'chamberLeveled').map((e) => e.level), [2]);
  assert.equal(s.run.nest.queue.length, 0);
  gate.level = 10;
  assert.equal(run(s, d, { type: 'levelChamber', uid: gate.uid }), 'max');
  // Royal Chamber level-ups need the royal_levelup unlock
  delete s.run.unlocked.royal_levelup;
  assert.equal(run(s, d, { type: 'levelChamber', uid: 1 }), 'locked');
});

test('blocked level-up is reported (every growth direction blocked)', () => {
  const { s, d } = setup();
  // Gallery at x 25..27 y 12..13 with stones either side of it (C125: a shaft would no longer block growth).
  const g = { uid: s.run.nest.nextUid++, type: 'gallery', k: 0, x: 25, y: 12, w: 3, h: 2, level: 1, target: 1, status: 'active',
    blueprint: false, bornAt: 0 };
  s.run.nest.chambers.push(g);
  setCells(s, rectCells(25, 12, 3, 2), CELL.CHAMBER);
  setCells(s, [idx(24, 12), idx(24, 13), idx(28, 12), idx(28, 13)], CELL.STONE);
  const info = nest.levelInfo(s, d, g.uid);
  assert.equal(info.grows, true);
  assert.equal(info.blocked, true);
  assert.deepEqual(info.dirs, { left: false, right: false, up: false, down: false });
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid }), 'blocked');
  assert.equal(run(s, d, { type: 'levelChamber', uid: g.uid, dir: 'right' }), 'blocked');
});

test('cancelJob refunds paid food 100 %; dug cells stay dug as tunnel and the chamber is removed', () => {
  const { s, d } = setup({ digW: 9 });
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12 });
  stepNest(s, d, 2);
  const job = s.run.nest.queue[0];
  const food = s.run.res.food;
  assert.equal(run(s, d, { type: 'cancelJob', uid: job.uid }), null);
  assert.equal(s.run.res.food, food + 40);
  assert.equal(s.run.nest.chambers.length, 1);
  assert.equal(s.run.nest.queue.length, 0);
  const dug = rectCells(21, 12, 3, 2).filter((c) => s.run.nest.cells[c] === CELL.TUNNEL);
  assert.equal(dug.length, 2);
  assert.ok(rectCells(21, 12, 3, 2).every((c) => s.run.nest.cells[c] !== CELL.CHAMBER));
  assert.equal(run(s, d, { type: 'cancelJob', uid: 12345 }), 'notFound');
});

test('cancelling a growth reverts the footprint; relocation and shaft jobs cannot be cancelled', () => {
  const { s, d } = setup({ digW: 1000 });
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12 });
  stepNest(s, d, 1);
  const ch = s.run.nest.chambers[1];
  d.stats.digW = 0;
  run(s, d, { type: 'levelChamber', uid: ch.uid, dir: 'right' });
  const job = s.run.nest.queue[0];
  assert.equal(run(s, d, { type: 'cancelJob', uid: job.uid }), null);
  assert.deepEqual([ch.x, ch.y, ch.w, ch.h, ch.level, ch.status], [21, 12, 3, 2, 1, 'active']);
  assert.equal(run(s, d, { type: 'relocateChamber', uid: ch.uid, x: 21, y: 14 }), null);
  assert.equal(run(s, d, { type: 'cancelJob', uid: s.run.nest.queue[0].uid }), 'blocked');
});

test('relocate: old cells become tunnel, chamber inactive until dug, work = 50 % of the new footprint (×0.75 architect)', () => {
  const { s, d } = setup({ digW: 1000 });
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12 });
  stepNest(s, d, 1);
  d.stats.digW = 0;
  const ch = s.run.nest.chambers[1];
  const v = nest.validatePlacement(s, d, 'gallery', 21, 15, { relocateUid: ch.uid });
  assert.equal(v.reason, null);
  assert.equal(v.work, 6 * 9 * 0.5);
  assert.deepEqual(v.cost, {});
  s.meta.achievements.ach_architect = 0;
  assert.equal(nest.validatePlacement(s, d, 'gallery', 21, 15, { relocateUid: ch.uid }).work, 6 * 9 * 0.5 * 0.75);
  delete s.meta.achievements.ach_architect;
  assert.equal(run(s, d, { type: 'relocateChamber', uid: ch.uid, x: 21, y: 12 }), 'invalid', 'same spot');
  assert.equal(run(s, d, { type: 'relocateChamber', uid: ch.uid, x: 21, y: 15 }), null);
  assert.equal(ch.status, 'relocating');
  assert.deepEqual([ch.x, ch.y, ch.level], [21, 15, 1]);
  for (const c of rectCells(21, 12, 3, 2)) assert.equal(s.run.nest.cells[c], CELL.TUNNEL);
  assert.equal(s.meta.counters.relocations, 1);
  assert.equal(s.run.stats.relocations, 1);
  nest.derive(s, d);
  assert.equal(d.nest.agg.housingBase, 10, 'inactive while relocating');
  d.stats.digW = 1000;
  const ev = stepNest(s, d, 1);
  assert.equal(ch.status, 'active');
  assert.ok(ev.some((e) => e.type === 'chamberActivated' && e.uid === ch.uid));
  assert.equal(s.run.stats.chambersDone, 1, 'relocation does not count as a new chamber');
});

test('demolish: refund 50 % of placement food, cells become tunnel; never the Royal Chamber', () => {
  const { s, d } = setup({ digW: 1000 });
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12 });
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 5, y: 12 }), null); // C137: clear of the first one's reservation
  stepNest(s, d, 1);
  const food = s.run.res.food;
  const first = s.run.nest.chambers[1];
  const second = s.run.nest.chambers[2];
  assert.equal(second.k, 1);
  assert.equal(run(s, d, { type: 'demolishChamber', uid: first.uid }), null);
  assert.equal(s.run.res.food, food + 20);
  assert.equal(second.k, 0, 'k recomputed on demolish');
  for (const c of rectCells(21, 12, 3, 2)) assert.equal(s.run.nest.cells[c], CELL.TUNNEL);
  assert.equal(run(s, d, { type: 'demolishChamber', uid: 1 }), 'blocked');
  assert.equal(run(s, d, { type: 'demolishChamber', uid: 999 }), 'notFound');
});

test('digTunnel / digTo: contiguous paths from the nest, queue limit, caches collected when dug', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(22, 5), idx(23, 5)] }), 'invalid:start');
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(21, 5), idx(23, 5)] }), 'invalid:path');
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(20, 5)] }), 'invalid:empty');
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(22, 21)] }), null, 'next to the Royal Chamber');
  s.run.nest.queue.length = 0;
  s.run.nest.rev++;
  setCells(s, [idx(22, 6)], CELL.STONE);
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(21, 6), idx(22, 6)] }), 'blocked:stone');
  // digTo a cache hint: route + the cell itself; the cache pays max(min, sec × gross income).
  s.run.nest.features.caches = [{ i: idx(24, 8), kind: 'seed_cache', found: false, hinted: false }];
  s.run.nest.rev++;
  d.rates.food.gross = 2;
  assert.equal(run(s, d, { type: 'digTo', cell: idx(24, 8) }), null);
  const job = s.run.nest.queue[0];
  assert.equal(job.cells[job.cells.length - 1], idx(24, 8));
  d.stats.digW = 1000;
  const food = s.run.res.food;
  const ev = stepNest(s, d, 1);
  const found = ev.find((e) => e.type === 'cacheFound');
  assert.deepEqual({ ...found }, { type: 'cacheFound', i: idx(24, 8), kind: 'seed_cache', res: 'food', amount: 180 });
  assert.equal(s.run.res.food, food + 180);
  assert.equal(s.meta.counters.caches, 1);
  assert.equal(s.run.nest.features.caches[0].found, true);
  assert.equal(run(s, d, { type: 'digTo', cell: idx(20, 3) }), 'invalid', 'already open');
});

test('amber bead counts amber and caches; minimum cache rewards apply with no income', () => {
  const { s, d } = setup({ digW: 1000 });
  s.run.nest.features.caches = [
    { i: idx(21, 3), kind: 'amber_bead', found: false, hinted: false },
    { i: idx(21, 4), kind: 'fossil', found: false, hinted: false },
    { i: idx(21, 5), kind: 'beetle_husk', found: false, hinted: false },
  ];
  s.run.nest.rev++;
  s.run.res.insight = 0;
  s.run.res.chitin = 0;
  run(s, d, { type: 'digTunnel', cells: [idx(21, 3), idx(21, 4), idx(21, 5)] });
  const ev = stepNest(s, d, 1);
  assert.equal(s.meta.counters.amber, 1);
  assert.equal(s.meta.counters.caches, 3);
  assert.equal(s.run.res.insight, 50);
  assert.equal(s.run.res.chitin, 25);
  assert.deepEqual(ev.filter((e) => e.type === 'cacheFound').map((e) => e.kind), ['amber_bead', 'fossil', 'beetle_husk']);
});

test('water pockets are revealed when an open cell comes within 4 cells', () => {
  const { s, d } = setup({ digW: 1000 });
  s.run.nest.features.water = [{ x: 26, y: 5, w: 2, h: 2, revealed: false }];
  setCells(s, rectCells(26, 5, 2, 2), CELL.WATER);
  stepNest(s, d, 1);
  assert.equal(s.run.nest.features.water[0].revealed, false, '6 cells away from the shaft');
  run(s, d, { type: 'digTunnel', cells: [idx(21, 5), idx(22, 5)] });
  stepNest(s, d, 1);
  assert.equal(s.run.nest.features.water[0].revealed, true);
  assert.equal(nest.cellInfo(s, d, idx(26, 5)).water, true);
});

test('backfill: refused when it would disconnect a chamber; dead-ends refill to soil after 10 s', () => {
  const { s, d } = setup({ digW: 1000 });
  // Tunnel from the shaft east along row 10 to a gallery at x 25.
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(21, 10), idx(22, 10), idx(23, 10), idx(24, 10)] }), null);
  // Dead-end branch: refused until its first cell touches an open cell.
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(22, 9), idx(22, 8)] }), 'invalid:start');
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(22, 9), idx(22, 8)] }), null);
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 25, y: 10 }), null);
  assert.equal(nest.validatePlacement(s, d, 'gallery', 25, 14).route.length > 0, true);
  stepNest(s, d, 1);
  assert.equal(s.run.nest.chambers[1].status, 'active');
  assert.equal(run(s, d, { type: 'backfill', cells: [idx(23, 10)] }), 'blocked');
  assert.equal(run(s, d, { type: 'backfill', cells: [idx(20, 5)] }), 'blocked:shaft');
  assert.equal(run(s, d, { type: 'backfill', cells: [idx(25, 10)] }), 'blocked:chamber');
  assert.equal(run(s, d, { type: 'backfill', cells: [idx(5, 5)] }), 'invalid:cell');
  assert.equal(run(s, d, { type: 'backfill', cells: [idx(22, 8), idx(22, 9)] }), null);
  assert.equal(run(s, d, { type: 'backfill', cells: [idx(22, 8)] }), 'invalid:pending');
  stepNest(s, d, 5);
  assert.equal(s.run.nest.cells[idx(22, 8)], CELL.TUNNEL);
  stepNest(s, d, 5);
  assert.equal(s.run.nest.cells[idx(22, 8)], CELL.SOIL);
  assert.equal(s.run.nest.cells[idx(22, 9)], CELL.SOIL);
  assert.equal(s.run.nest.backfill.length, 0);
});

test('helpDig: click adds 5 + 3 % of W work to the first job and the same soil; refused under claustral_founding', () => {
  const { s, d } = setup({ digW: 100 });
  assert.equal(run(s, d, { type: 'helpDig' }), 'invalid', 'no dig face');
  const long = [];
  for (let y = 21; y <= 40; y++) long.push(idx(22, y));
  assert.equal(run(s, d, { type: 'digTunnel', cells: long }), null);
  const soil = s.run.res.soil;
  assert.equal(run(s, d, { type: 'helpDig' }), null);
  assert.equal(s.run.res.soil, soil + 8);
  assert.equal(s.run.nest.queue[0].prog, 2, '8 work: one 6-work cell + 2 progress');
  assert.equal(s.run.nest.cells[idx(22, 21)], CELL.TUNNEL);
  assert.equal(s.meta.counters.clicks, 1);
  for (let k = 0; k < 14; k++) run(s, d, { type: 'helpDig' });
  assert.equal(run(s, d, { type: 'helpDig' }), 'clickCap');
  s.run.hardship = 'claustral_founding';
  assert.equal(run(s, d, { type: 'helpDig' }), 'hardship');
});

test('offline: dug cells go to d.offlineLog (no cellDug events); chamberActivated is emitted and logged', () => {
  const { s, d } = setup({ digW: 9 });
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 21, y: 12 });
  d.offlineLog = { cells: [], chambers: [] };
  const ev = stepNest(s, d, 60, { offline: true, eff: 0.5 }); // 9 × 0.5 × 60 = 270 work ≥ 54
  assert.equal(ev.filter((e) => e.type === 'cellDug').length, 0);
  assert.equal(d.offlineLog.cells.length, 6);
  assert.deepEqual(d.offlineLog.chambers, [s.run.nest.chambers[1].uid]);
  assert.equal(ev.filter((e) => e.type === 'chamberActivated').length, 1);
});

test('reorderQueue moves a job; all work goes to the first job', () => {
  const { s, d } = setup({ digW: 4 });
  run(s, d, { type: 'digTunnel', cells: [idx(21, 5)] });
  run(s, d, { type: 'digTunnel', cells: [idx(19, 5)] });
  const second = s.run.nest.queue[1].uid;
  assert.equal(run(s, d, { type: 'reorderQueue', uid: second, to: 0 }), null);
  assert.equal(s.run.nest.queue[0].uid, second);
  stepNest(s, d, 1);
  assert.equal(s.run.nest.cells[idx(19, 5)], CELL.TUNNEL);
  assert.equal(s.run.nest.cells[idx(21, 5)], CELL.SOIL);
  assert.equal(run(s, d, { type: 'reorderQueue', uid: s.run.nest.queue[0].uid, to: 3 }), 'invalid');
});

test('nuptial chamber: shaft job dug to row 0 opens a nuptial shaft and an entrance; agg.nuptial becomes active', () => {
  const { s, d } = setup();
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'nuptial_chamber', x: 18, y: 24 }), null);
  assert.equal(s.run.nest.queue.length, 2);
  const shaftJob = s.run.nest.queue[1];
  assert.equal(shaftJob.kind, 'shaft');
  const rec = s.run.nest.shafts.find((x) => x.kind === 'nuptial');
  assert.equal(rec.open, false);
  assert.ok(Math.abs(rec.col - 20) >= 3);
  assert.ok(shaftJob.cells.includes(idx(rec.col, 0)));
  d.stats.digW = 1e6;
  const ev = stepNest(s, d, 1);
  assert.equal(rec.open, true);
  assert.deepEqual(ev.filter((e) => e.type === 'entranceOpened').map((e) => [e.kind, e.col]), [['nuptial', rec.col]]);
  nest.derive(s, d);
  assert.equal(d.nest.agg.nuptial.active, true);
  assert.equal(d.nest.agg.alateCells, 10);
  assert.equal(d.nest.entDist[idx(rec.col, 0)], 0, 'second entrance seeds entDist');
  // Only one nuptial chamber
  assert.equal(nest.validatePlacement(s, d, 'nuptial_chamber', 5, 40).reason, 'max');
});
