// WP3 cross-callable mutators and blueprints (ARCHITECTURE §8.2 [x]): queueShaft (satellites), moleTunnel
// (ev_mole_tunnel), autoLevelStep (autobuyer), saveBlueprint / loadBlueprint / deleteBlueprint / applyBlueprint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { MOLE } from '../src/data/soilFeatures.js';
import { createRun } from '../src/core/state.js';
import * as nest from '../src/systems/nest.js';
import { idx, xy, cellWork } from '../src/systems/nestgeom.js';

function setup({ food = 1e6, soil = 1e6, digW = 0 } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
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

function stepNest(s, d, dt = 1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  nest.derive(s, d);
  nest.tick(s, d, dt, env);
  return env.events;
}

test('queueShaft: a satellite shaft from row 0 joins the nest, bypasses the queue limit and opens when dug', () => {
  const { s, d } = setup();
  for (let k = 0; k < 5; k++) {
    s.run.nest.queue.push({ uid: 800 + k, kind: 'tunnel', chamber: 0, cells: [], cur: 0, prog: 0, paidFood: 0, blueprint: false });
  }
  const uid = nest.queueShaft(s, d, 5, 'satellite', 0);
  assert.ok(uid > 0);
  const job = s.run.nest.queue.find((j) => j.uid === uid);
  assert.equal(job.kind, 'shaft');
  assert.equal(job.cells[0], idx(5, 0), 'dug from the surface down');
  for (let k = 1; k < job.cells.length; k++) {
    const [ax, ay] = xy(job.cells[k - 1]);
    const [bx, by] = xy(job.cells[k]);
    assert.equal(Math.abs(ax - bx) + Math.abs(ay - by), 1, 'contiguous');
  }
  const rec = s.run.nest.shafts.find((x) => x.kind === 'satellite');
  assert.deepEqual(rec, { kind: 'satellite', col: 5, open: false, ref: 0 });
  s.run.nest.queue = s.run.nest.queue.filter((j) => j.uid === uid);
  s.run.nest.rev++;
  d.stats.digW = 1e6;
  const ev = stepNest(s, d, 1);
  assert.equal(rec.open, true);
  assert.deepEqual(ev.filter((e) => e.type === 'entranceOpened').map((e) => [e.kind, e.col]), [['satellite', 5]]);
  nest.derive(s, d);
  assert.equal(d.nest.entDist[idx(5, 0)], 0);
  assert.ok(d.nest.dist[idx(5, 0)] > 0, 'connected to the main shaft');
  // Invalid columns
  assert.equal(nest.queueShaft(s, d, 20, 'satellite', 1), 0, 'main shaft top is not soil');
  assert.equal(nest.queueShaft(s, d, -1, 'satellite', 1), 0);
  assert.equal(nest.queueShaft(s, d, 40, 'satellite', 1), 0);
  assert.equal(nest.queueShaft(s, d, 1.5, 'satellite', 1), 0);
});

test('queueShaft stops at the first open cell beside or below the column', () => {
  const { s, d } = setup({ digW: 1e6 });
  run(s, d, { type: 'digTunnel', cells: [idx(21, 6), idx(22, 6), idx(23, 6)] });
  stepNest(s, d, 1);
  const uid = nest.queueShaft(s, d, 24, 'satellite', 0);
  const job = s.run.nest.queue.find((j) => j.uid === uid);
  assert.deepEqual(job.cells, [0, 1, 2, 3, 4, 5, 6].map((y) => idx(24, y)));
});

test('moleTunnel: deterministic staircase of 6–12 cells in rows 1–60, never chambers, free; hints the nearest unseen cache', () => {
  const mk = () => {
    const { s, d } = setup();
    s.rng = 4242;
    s.run.nest.features.caches = [
      { i: idx(3, 55), kind: 'fossil', found: false, hinted: false },
      { i: idx(36, 58), kind: 'seed_cache', found: false, hinted: false },
    ];
    s.run.nest.rev++;
    return { s, d };
  };
  const a = mk();
  const b = mk();
  const envA = fakeEnv();
  const ra = nest.moleTunnel(a.s, a.d, envA);
  const rb = nest.moleTunnel(b.s, b.d, fakeEnv());
  assert.deepEqual(ra, rb);
  assert.deepEqual(a.s.run.nest.cells, b.s.run.nest.cells);
  assert.notEqual(a.s.rng, 4242, 'main RNG used');
  assert.ok(ra.cells.length >= MOLE.lenMin && ra.cells.length <= MOLE.lenMax);
  for (let k = 0; k < ra.cells.length; k++) {
    const c = ra.cells[k];
    const [x, y] = xy(c);
    assert.ok(y >= 1 && y <= 60);
    assert.equal(a.s.run.nest.cells[c], CELL.TUNNEL);
    assert.equal(nest.chamberAtCell(a.s, a.d, c), null);
    if (k > 0) {
      const [px, py] = xy(ra.cells[k - 1]);
      assert.equal(Math.abs(px - x) + Math.abs(py - y), 1, 'staircase stays 4-connected');
    }
  }
  const xs = ra.cells.map((c) => xy(c)[0]);
  const ys = ra.cells.map((c) => xy(c)[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) >= 2 && Math.max(...ys) - Math.min(...ys) >= 2, 'diagonal');
  assert.ok(envA.events.filter((e) => e.type === 'cellDug').length > 0);
  assert.equal(a.s.run.res.soil, 1e6, 'free');
  assert.equal(a.s.run.stats.cellsDug, 0);
  assert.ok([idx(3, 55), idx(36, 58)].includes(ra.hint));
  assert.equal(a.s.run.nest.features.caches.find((c) => c.i === ra.hint).hinted, true);
  nest.derive(a.s, a.d);
  assert.ok(a.d.nest.hints.includes(ra.hint));
  // With no caches left the hint is −1.
  const { s, d } = setup();
  assert.equal(nest.moleTunnel(s, d, fakeEnv()).hint, -1);
});

test('autoLevelStep levels the cheapest affordable chamber and returns false when nothing is affordable', () => {
  const { s, d } = setup({ digW: 1e6 });
  run(s, d, { type: 'placeChamber', chamber: 'gate', x: 21, y: 0 });
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 22, y: 22 }), null); // C137: x ≤ 21 is the queen's reserved room
  stepNest(s, d, 1);
  const gal = s.run.nest.chambers.find((c) => c.type === 'gallery');
  assert.equal(nest.autoLevelStep(s, d, fakeEnv()), true);
  assert.equal(gal.status, 'growing', 'cheapest: the gallery (13 food)');
  stepNest(s, d, 1);
  assert.equal(gal.level, 2);
  s.run.res.food = 0;
  assert.equal(nest.autoLevelStep(s, d, fakeEnv()), false);
});

test('blueprints: save needs ancestral_blueprint; 1 slot (5 with blueprint_memory); load / delete', () => {
  const { s, d } = setup({ digW: 1e6 });
  assert.equal(run(s, d, { type: 'saveBlueprint', slot: 0 }), 'locked');
  s.cycle.traits.ancestral_blueprint = 1;
  assert.equal(run(s, d, { type: 'saveBlueprint', slot: 1 }), 'invalid');
  run(s, d, { type: 'digTunnel', cells: [idx(21, 12), idx(22, 12), idx(23, 12)] });
  stepNest(s, d, 1);
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 24, y: 12 });
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'saveBlueprint', slot: 0, name: 'Home' }), null);
  const bp = s.era.blueprints[0];
  assert.equal(bp.name, 'Home');
  // C137: saved with its reserved full-size room (the L1 room sits in one corner of it)
  assert.deepEqual(bp.chambers.map(({ res, ...c }) => c), [{ type: 'gallery', x: 24, y: 12, w: 3, h: 2, level: 1 }]);
  assert.deepEqual(bp.chambers[0].res, s.run.nest.chambers.find((c) => c.type === 'gallery').res);
  assert.deepEqual(bp.tunnels.sort((a, b) => a - b), [idx(21, 12), idx(22, 12), idx(23, 12)]);
  assert.deepEqual(JSON.parse(JSON.stringify(s.era.blueprints)), s.era.blueprints);
  assert.equal(run(s, d, { type: 'loadBlueprint', slot: 0 }), null);
  assert.equal(s.era.activeBlueprint, 0);
  s.era.federation.blueprint_memory = 1;
  assert.equal(run(s, d, { type: 'saveBlueprint', slot: 4 }), null);
  assert.equal(s.era.blueprints.length, 5);
  assert.equal(s.era.blueprints[4].name, 'Layout 5');
  assert.equal(run(s, d, { type: 'loadBlueprint', slot: 2 }), 'notFound');
  assert.equal(run(s, d, { type: 'deleteBlueprint', slot: 4 }), null);
  assert.equal(s.era.blueprints.length, 1, 'trailing empty slots trimmed');
  assert.equal(run(s, d, { type: 'deleteBlueprint', slot: 0 }), null);
  assert.equal(s.era.activeBlueprint, -1);
  assert.equal(run(s, d, { type: 'deleteBlueprint', slot: 0 }), 'invalid');
});

test('applyBlueprint queues tunnels then chambers in BFS order at −50 % placement food; blueprint cells dig ×3', () => {
  const { s, d } = setup({ digW: 1e6 });
  s.cycle.traits.ancestral_blueprint = 1;
  run(s, d, { type: 'digTunnel', cells: [idx(21, 12), idx(22, 12), idx(23, 12)] });
  stepNest(s, d, 1);
  run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 24, y: 12 });
  run(s, d, { type: 'placeChamber', chamber: 'nursery', x: 22, y: 20 });
  stepNest(s, d, 1);
  run(s, d, { type: 'saveBlueprint', slot: 0 });
  run(s, d, { type: 'loadBlueprint', slot: 0 });
  // New run (what WP7 startRun does before calling applyBlueprint)
  s.run = createRun(77);
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  Object.assign(s.run.res, { food: 1000, soil: 0 });
  const d2 = makeDerived({ stats: { foodCap: 1e12, digW: 0 } });
  nest.derive(s, d2);
  const n = nest.applyBlueprint(s, d2);
  // BFS from the open nest: tunnel (21,12) → nursery (reached from the Royal Chamber) → tunnels (22–23,12) → gallery.
  assert.equal(n, 4);
  const q = s.run.nest.queue;
  assert.deepEqual(q.map((j) => j.kind), ['tunnel', 'chamber', 'tunnel', 'chamber']);
  assert.ok(q.every((j) => j.blueprint === true));
  const tIdx = q.map((j) => j.kind).lastIndexOf('tunnel');
  const gIdx = q.findIndex((j) => j.kind === 'chamber' && s.run.nest.chambers.find((c) => c.uid === j.chamber).type === 'gallery');
  assert.ok(tIdx < gIdx, 'the tunnel that reaches the gallery is queued before it');
  assert.equal(s.run.res.food, 1000 - 20 - 40, '−50 % placement food');
  const gal = s.run.nest.chambers.find((c) => c.type === 'gallery');
  assert.equal(gal.blueprint, true);
  assert.equal(cellWork(s, idx(25, 12), 'chamber', { blueprint: true }), 3);
  d2.stats.digW = 1e6;
  stepNest(s, d2, 1);
  assert.ok(s.run.nest.chambers.every((c) => c.status === 'active'));
  // Unaffordable / locked chambers are skipped
  s.run = createRun(78);
  Object.assign(s.run.res, { food: 1000 });
  s.run.unlocked.chamber_nursery = true;
  const d3 = makeDerived({ stats: { foodCap: 1e12 } });
  nest.derive(s, d3);
  assert.equal(nest.applyBlueprint(s, d3), 3, 'gallery locked → two tunnel jobs + nursery only');
  assert.equal(s.run.nest.chambers.filter((c) => c.type === 'gallery').length, 0);
  // C106: the locked gallery is kept as a pending blueprint chamber (it queues itself once unlocked).
  assert.deepEqual(s.run.nest.bpPending.map(({ res, ...p }) => p), [{ type: 'gallery', x: 24, y: 12 }]);
  assert.ok(s.run.nest.bpPending[0].res, 'its reservation travels with it');
  s.era.activeBlueprint = -1;
  assert.equal(nest.applyBlueprint(s, d3), 0);
});
