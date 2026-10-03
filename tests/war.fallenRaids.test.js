// Final-QA regression tests: raids from a rival that is conquered while the raid is still out (found by the balance
// tuner: a 16 h bot run crashed in raids.theft() with "Cannot read properties of undefined (reading 'includes')").
// Since C77 a conquered non-boss rival is compacted to { uid, type, tier, hex, alive, sighted, fallenAt, n } at the end
// of rivals.tick, so its record has no traits / atk / hp. C90: a raid whose rival is no longer alive when its warning
// ends is called off (it fizzles like a raid on a deleted trail); a raid that is already fighting finishes normally and
// never reads the missing fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as raids from '../src/systems/raids.js';
import * as rivals from '../src/systems/rivals.js';
import { hexIndex } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';

const NEST = hexIndex(4, 0);

function world({ type = 'black_garden_ants', soldier = 0 } = {}) {
  const s = newState(5);
  s.run.colony.adults.minor = 60;
  s.run.colony.adults.soldier = soldier;
  const d = makeDerived({ stats: { foodCap: 1e9, honeydewCap: 1e9, housing: 1e6 } });
  const r = rivals.createRival(s, { type, hex: NEST });
  r.sighted = true;
  return { s, d, r };
}

function run(s, d, sec, dt = 0.1) {
  const events = [];
  for (let i = 0; i < Math.round(sec / dt); i++) {
    const env = fakeEnv({ dt });
    rivals.tick(s, d, dt, env);
    raids.tick(s, d, dt, env);
    s.run.time += dt;
    events.push(...env.events);
  }
  return events;
}

/** Conquer r the way rivals.conquer leaves it (alive false, fallenAt set); the next rivals.tick compacts it (C77). */
function fall(s, r) {
  r.alive = false;
  r.fallenAt = s.run.time;
  r.n = 0;
}

test('C90: a nest raid in warning from a rival conquered (and compacted) meanwhile is called off without a throw', () => {
  for (const type of ['black_garden_ants', 'slave_makers']) {
    const { s, d, r } = world({ type });
    s.run.res.food = 1000;
    s.run.colony.brood = [{ c: 'minor', n: 10, p: 0.5, t: 0 }];
    d.nest.agg.reachStorageShare = 0.5;
    d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 30, factor: 1, exposed: false, snap: false, inReach: true }];
    s.run.war.raids.push({ uid: 700, rival: r.uid, target: { type: 'nest' }, raiders: 5, warn: 1, phase: 'warning', guard: 0 });
    fall(s, r);
    run(s, d, 0.2); // compacts the record
    assert.equal(r.traits, undefined, 'the record is compact (C77)');
    let ev;
    assert.doesNotThrow(() => { ev = run(s, d, 2); }, type);
    const res = ev.find((e) => e.type === 'raidResult');
    assert.ok(res, 'the raid closes');
    assert.equal(res.win, true);
    assert.equal(res.foodLost, 0);
    assert.equal(res.broodLost, 0);
    assert.equal(s.run.res.food, 1000, 'nothing is stolen by a fallen rival');
    assert.equal(s.run.colony.brood[0].n, 10);
    assert.equal(s.run.war.raids.length, 0);
    assert.equal(s.run.war.battles.length, 0, 'no fight is started');
    assert.equal(r.n, 0, 'raiders do not return to a fallen nest');
    assert.deepEqual(findBadValues(s), []);
  }
});

test('C90: a trail raid in warning from a conquered rival fizzles too; the bot crash save no longer throws', () => {
  const { s, d, r } = world();
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0)];
  s.run.surface.trails.push({ uid: 10, origin: 0, src: 1, path, len: 3, job: 'forager', workers: 20, escorts: 0, S: 50, born: 0, reroutes: [] });
  d.surface.trails.push({ uid: 10, workers: 20, safe: false, out: 3, escorted: false });
  s.run.colony.jobs.forager = 20;
  s.run.war.raids.push({ uid: 701, rival: r.uid, target: { type: 'trail', uid: 10 }, raiders: 5, warn: 1, phase: 'warning', guard: 0 });
  fall(s, r);
  const ev = run(s, d, 2);
  const res = ev.find((e) => e.type === 'raidResult');
  assert.equal(res.win, true);
  assert.equal(res.workersLost, 0);
  assert.equal(s.run.war.battles.length, 0);
  assert.equal(s.run.war.raids.length, 0);
});

test('C90: a raid already fighting when its rival falls finishes without reading the compact record', () => {
  for (const type of ['black_garden_ants', 'slave_makers']) {
    const { s, d, r } = world({ type, soldier: 2 });
    s.meta.settings.retreatAt = 1;
    s.run.res.food = 100;
    s.run.colony.brood = [{ c: 'minor', n: 10, p: 0.5, t: 0 }];
    d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 30, factor: 1, exposed: false, snap: false, inReach: true }];
    s.run.war.raids.push({ uid: 702, rival: r.uid, target: { type: 'nest' }, raiders: 40, warn: 0.05, phase: 'warning', guard: 0 });
    run(s, d, 0.1);
    assert.equal(s.run.war.raids[0].phase, 'border', 'the border fight has started');
    fall(s, r);
    let ev;
    assert.doesNotThrow(() => { ev = run(s, d, 120); }, type);
    assert.ok(ev.some((e) => e.type === 'raidResult'), 'the raid closes');
    assert.equal(s.run.war.raids.length, 0);
    assert.deepEqual(findBadValues(s), []);
  }
});
