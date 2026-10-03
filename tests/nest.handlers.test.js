// WP3 handler contract tests (ARCHITECTURE §15.3 #16): every nest handler's validate rejects bad input with the
// documented reason code and never throws; apply mutates only fields WP3 owns (or writes through core helpers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, findBadValues, snapshot } from './helpers.js';
import { CELL } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { makeHolder, rand, randInt } from '../src/core/rng.js';
import * as nest from '../src/systems/nest.js';
import { idx } from '../src/systems/nestgeom.js';

const TYPES = ['placeChamber', 'levelChamber', 'relocateChamber', 'demolishChamber', 'digTunnel', 'digTo', 'backfill',
  'reorderQueue', 'cancelJob', 'helpDig', 'saveBlueprint', 'loadBlueprint', 'deleteBlueprint'];

function setup({ digW = 0 } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e6, soil: 1e6, chitin: 1e6, honeydew: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd, env = fakeEnv()) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  return r;
}

test('handlers: exactly the §8.2 command set, each with validate and apply', () => {
  assert.deepEqual(Object.keys(nest.handlers).sort(), [...TYPES].sort());
  for (const t of TYPES) {
    assert.equal(typeof nest.handlers[t].validate, 'function');
    assert.equal(typeof nest.handlers[t].apply, 'function');
  }
});

test('validate returns the documented reason codes for bad input', () => {
  const { s, d } = setup();
  const v = (cmd) => nest.handlers[cmd.type].validate(s, d, cmd);
  const cases = [
    [{ type: 'placeChamber' }, 'invalid'],
    [{ type: 'placeChamber', chamber: 'castle', x: 1, y: 1 }, 'invalid'],
    [{ type: 'placeChamber', chamber: 'gallery', x: NaN, y: 12 }, 'invalid'],
    [{ type: 'placeChamber', chamber: 'gallery', x: '21', y: 12 }, 'invalid'],
    [{ type: 'placeChamber', chamber: 'gallery', x: 21, y: null }, 'invalid'],
    [{ type: 'placeChamber', chamber: 'gallery', x: 25, y: 12, route: 'east' }, 'invalid:route'],
    [{ type: 'placeChamber', chamber: 'nuptial_chamber', x: 18, y: 24, shaftCol: 2.5 }, 'invalid:shaftCol'],
    [{ type: 'levelChamber', uid: NaN }, 'invalid'],
    [{ type: 'levelChamber', uid: 999 }, 'notFound'],
    [{ type: 'levelChamber', uid: 1, dir: 'sideways' }, 'invalid:dir'],
    [{ type: 'relocateChamber', uid: null, x: 1, y: 1 }, 'invalid'],
    [{ type: 'relocateChamber', uid: 999, x: 1, y: 30 }, 'notFound'],
    [{ type: 'relocateChamber', uid: 1, x: 1, y: 30, route: 7 }, 'invalid:route'],
    [{ type: 'demolishChamber', uid: '1' }, 'invalid'],
    [{ type: 'demolishChamber', uid: 999 }, 'notFound'],
    [{ type: 'demolishChamber', uid: 1 }, 'blocked'],
    [{ type: 'digTunnel' }, 'invalid'],
    [{ type: 'digTunnel', cells: [] }, 'invalid'],
    [{ type: 'digTunnel', cells: [NaN] }, 'invalid'],
    [{ type: 'digTunnel', cells: [-5] }, 'invalid'],
    [{ type: 'digTunnel', cells: [1e9] }, 'invalid'],
    [{ type: 'digTunnel', cells: [idx(21, 5), idx(21, 5)] }, 'invalid:path'],
    [{ type: 'digTunnel', cells: 'down' }, 'invalid'],
    [{ type: 'digTo', cell: null }, 'invalid'],
    [{ type: 'digTo', cell: 1.5 }, 'invalid'],
    [{ type: 'digTo', cell: idx(20, 3) }, 'invalid'],
    [{ type: 'backfill', cells: 'x' }, 'invalid'],
    [{ type: 'backfill', cells: [null] }, 'invalid'],
    [{ type: 'backfill', cells: [idx(20, 5), idx(20, 5)] }, 'invalid'],
    [{ type: 'reorderQueue', to: 0 }, 'invalid'],
    [{ type: 'reorderQueue', uid: 5, to: NaN }, 'invalid'],
    [{ type: 'reorderQueue', uid: 5, to: 0 }, 'notFound'],
    [{ type: 'cancelJob', uid: {} }, 'invalid'],
    [{ type: 'cancelJob', uid: 77 }, 'notFound'],
    [{ type: 'helpDig' }, 'invalid'],
    [{ type: 'saveBlueprint', slot: 0 }, 'locked'],
    [{ type: 'loadBlueprint', slot: 0 }, 'locked'],
    [{ type: 'deleteBlueprint', slot: 0 }, 'locked'],
  ];
  for (const [cmd, want] of cases) assert.equal(v(cmd), want, JSON.stringify(cmd));
  s.cycle.traits.ancestral_blueprint = 1;
  assert.equal(v({ type: 'saveBlueprint', slot: -1 }), 'invalid');
  assert.equal(v({ type: 'saveBlueprint', slot: 'a' }), 'invalid');
  assert.equal(v({ type: 'saveBlueprint', slot: 0, name: 5 }), 'invalid');
  assert.equal(v({ type: 'loadBlueprint', slot: 0 }), 'notFound');
  assert.equal(v({ type: 'loadBlueprint', slot: 3 }), 'invalid');
  assert.equal(v({ type: 'deleteBlueprint', slot: 0 }), 'invalid');
  s.run.nest.cells[idx(30, 30)] = CELL.WATER;
  s.run.nest.rev++;
  assert.equal(v({ type: 'digTo', cell: idx(30, 30) }), 'blocked');
});

test('validate is pure: it never mutates the state', () => {
  const { s, d } = setup();
  const before = snapshot(s);
  for (const cmd of [
    { type: 'placeChamber', chamber: 'gallery', x: 25, y: 12 },
    { type: 'levelChamber', uid: 1 },
    { type: 'digTunnel', cells: [idx(21, 5)] },
    { type: 'digTo', cell: idx(25, 8) },
    { type: 'backfill', cells: [idx(20, 3)] },
    { type: 'helpDig' },
  ]) nest.handlers[cmd.type].validate(s, d, cmd);
  nest.validatePlacement(s, d, 'nursery', 22, 20);
  nest.levelInfo(s, d, 1);
  nest.findPlacement(s, d, 'granary');
  nest.cellInfo(s, d, idx(5, 5));
  assert.deepEqual(snapshot(s), before);
});

/** Leaf paths that differ between two JSON snapshots. */
function changedPaths(a, b, path = '', out = []) {
  if (a === b) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) changedPaths(a[k], b[k], path ? path + '.' + k : k, out);
    return out;
  }
  out.push(path);
  return out;
}

const ALLOWED = ['run.nest', 'run.res', 'run.fRun', 'run.clicks', 'run.stats.cellsDug', 'run.stats.chambersDone',
  'run.stats.relocations', 'run.stats.foodWasted', 'meta.counters.cellsDug', 'meta.counters.caches', 'meta.counters.amber',
  'meta.counters.relocations', 'meta.counters.clicks', 'meta.stats.deepestRow', 'meta.stats.foodEver', 'era.blueprints',
  'era.activeBlueprint',
  'run.surface']; // run.surface only through the surface.addEntrance cross-call when a nuptial shaft opens

test('apply (and tick) mutate only WP3-owned fields or write through core helpers', () => {
  const { s, d } = setup({ digW: 50 });
  s.cycle.traits.ancestral_blueprint = 1;
  s.run.nest.features.caches = [{ i: idx(21, 14), kind: 'seed_cache', found: false, hinted: false }];
  s.run.nest.rev++;
  const env = fakeEnv();
  const cmds = [
    { type: 'placeChamber', chamber: 'gallery', x: 22, y: 20 },
    { type: 'digTunnel', cells: [idx(21, 14), idx(22, 14)] },
    { type: 'placeChamber', chamber: 'nuptial_chamber', x: 5, y: 26 },
    { type: 'helpDig' },
  ];
  for (const cmd of cmds) {
    const before = snapshot(s);
    assert.equal(run(s, d, cmd, env), null, JSON.stringify(cmd));
    for (const p of changedPaths(before, snapshot(s))) assert.ok(ALLOWED.some((a) => p === a || p.startsWith(a + '.')), cmd.type + ' wrote ' + p);
  }
  for (let t = 0; t < 400; t++) {
    const before = snapshot(s);
    nest.derive(s, d);
    nest.tick(s, d, 0.5, fakeEnv({ dt: 0.5 }));
    for (const p of changedPaths(before, snapshot(s))) assert.ok(ALLOWED.some((a) => p === a || p.startsWith(a + '.')), 'tick wrote ' + p);
  }
  const later = [
    { type: 'levelChamber', uid: s.run.nest.chambers[1].uid, dir: 'right' },
    { type: 'saveBlueprint', slot: 0 },
    { type: 'loadBlueprint', slot: 0 },
    { type: 'backfill', cells: [idx(22, 14)] },
    { type: 'demolishChamber', uid: s.run.nest.chambers[1].uid },
    { type: 'deleteBlueprint', slot: 0 },
  ];
  for (const cmd of later) {
    const before = snapshot(s);
    const r = run(s, d, cmd, env);
    assert.ok(r === null || typeof r === 'string');
    for (const p of changedPaths(before, snapshot(s))) assert.ok(ALLOWED.some((a) => p === a || p.startsWith(a + '.')), cmd.type + ' wrote ' + p);
  }
  assert.deepEqual(findBadValues(s), []);
});

test('fuzz: random garbage and random valid-looking commands never throw and keep the state JSON-safe', () => {
  const { s, d } = setup({ digW: 30 });
  s.cycle.traits.ancestral_blueprint = 1;
  const h = makeHolder(99);
  const junk = [null, undefined, NaN, Infinity, -1, 0, 1, 2.5, 1e9, '3', 'left', {}, [], [NaN], [1, 2, 3], true];
  const pickJ = () => junk[randInt(h, 0, junk.length - 1)];
  const cell = () => idx(randInt(h, 0, 39), randInt(h, 0, 40));
  for (let k = 0; k < 2500; k++) {
    const type = TYPES[randInt(h, 0, TYPES.length - 1)];
    let cmd;
    if (rand(h) < 0.4) {
      cmd = { type, chamber: pickJ(), x: pickJ(), y: pickJ(), uid: pickJ(), dir: pickJ(), cells: pickJ(), cell: pickJ(), to: pickJ(),
        slot: pickJ(), name: pickJ(), route: pickJ(), shaftCol: pickJ() };
    } else {
      const uids = [...s.run.nest.chambers.map((c) => c.uid), ...s.run.nest.queue.map((j) => j.uid), 999];
      const c0 = cell();
      cmd = { type, chamber: CHAMBER_ORDER[randInt(h, 0, CHAMBER_ORDER.length - 1)], x: randInt(h, -1, 40), y: randInt(h, -1, 50),
        uid: uids[randInt(h, 0, uids.length - 1)], dir: ['left', 'right', 'up', 'down', undefined][randInt(h, 0, 4)],
        cells: [c0, c0 + 1, c0 + 2].filter((c) => c < 3200), cell: cell(), to: randInt(h, 0, 3), slot: randInt(h, 0, 1) };
    }
    const r = nest.handlers[type].validate(s, d, cmd);
    assert.ok(r === null || typeof r === 'string', type + ' returned ' + r);
    if (r === null) nest.handlers[type].apply(s, d, cmd, fakeEnv());
    if (k % 10 === 0) {
      nest.derive(s, d);
      nest.tick(s, d, 1, fakeEnv({ dt: 1 }));
    }
  }
  assert.deepEqual(findBadValues(s), []);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  // Chamber cells and records stay consistent: every active chamber's footprint is fully dug.
  for (const ch of s.run.nest.chambers) {
    if (ch.status !== 'active') continue;
    for (let y = ch.y; y < ch.y + ch.h; y++) for (let x = ch.x; x < ch.x + ch.w; x++) assert.equal(s.run.nest.cells[idx(x, y)], CELL.CHAMBER);
  }
});
