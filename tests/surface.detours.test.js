// C182: trails round temporary obstacles — a molehill or a spring puddle on an existing trail's route gives it a free
// detour while blocked, it returns to its own route once clear, and with no way round it pauses (no workers, no yield).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as trails from '../src/systems/trails.js';
import * as surface from '../src/systems/surface.js';
import { TERRAIN } from '../src/data/surface.js';
import { SOURCES } from '../src/data/sources.js';
import { hexIndex, neighbors } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

/** A world with a seed patch 4 hexes east of the nest and a straight trail to it. */
function world() {
  const s = newState(1);
  const d = makeDerived({ nest: { agg: { haulH: 0.5 } } });
  surface.derive(s, d);
  const S = s.run.surface;
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), hexIndex(4, 0)];
  for (const h of path) S.revealed[h] = 1;
  const def = SOURCES.seed_patch;
  const src = { uid: S.nextUid++, type: 'seed_patch', hex: path[4], stock: 1e6, max: 1e6, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} };
  S.sources.push(src);
  const t = { uid: S.nextUid++, origin: 0, src: src.uid, path: path.slice(), len: 4, job: def.job, workers: 0, escorts: 0, S: 20, born: 0, reroutes: [] };
  S.trails.push(t);
  S.rev++;
  s.run.colony.adults.minor = 30;
  s.run.colony.jobs.forager = 20;
  return { s, d, t, path, src };
}

function tick(s, d, dt = 0.1) {
  const env = fakeEnv({ dt });
  for (const k of Object.keys(d.ledger)) d.ledger[k] = {};
  surface.derive(s, d);
  trails.tick(s, d, dt, env);
  return env.events;
}

function molehill(s, hex, uid = 900 + hex) {
  s.run.events.objects.push({ uid, kind: 'molehill', hex, cell: -1, t: 180, data: {} });
}

test('C182: a molehill on an existing trail gives it a free detour, and it returns to its own route when cleared', () => {
  const { s, d, t, path } = world();
  tick(s, d);
  assert.equal(t.detour, undefined, 'clear route: no detour');
  molehill(s, path[2]);
  const ev = tick(s, d);
  assert.ok(t.detour && !t.detour.paused, 'on a detour');
  assert.deepEqual(t.detour.home, path, 'its own route is kept');
  assert.deepEqual(t.detour.block, [path[2]]);
  assert.ok(!t.path.includes(path[2]), 'the detour avoids the molehill');
  assert.equal(t.path[0], 0);
  assert.equal(t.path[t.path.length - 1], path[4]);
  for (let k = 1; k < t.path.length; k++) assert.ok(neighbors(t.path[k - 1]).includes(t.path[k]), 'a connected hex path');
  assert.ok(t.len > 4, 'the way round is longer');
  assert.ok(ev.some((e) => e.type === 'trailDetour' && e.uid === t.uid && e.mode === 'detour'));
  assert.equal(s.run.surface.trails.filter((x) => x.src === t.src).length, 1, 'still one trail to it (no extra slot)');
  const de = d.surface.trails.find((x) => x.uid === t.uid);
  assert.equal(de.detour, 'detour');
  assert.ok(de.out > 0, 'a detour still pays');
  assert.deepEqual(trails.detourInfo(s, t), { mode: 'detour', block: [path[2]], why: 'molehill' });
  // cleared
  s.run.events.objects = [];
  const ev2 = tick(s, d);
  assert.equal(t.detour, undefined);
  assert.deepEqual(t.path, path, 'back on its own route');
  assert.equal(t.len, 4);
  assert.ok(ev2.some((e) => e.type === 'trailDetour' && e.mode === 'restored'));
  assert.equal(trails.detourInfo(s, t), null);
  assert.deepEqual(JSON.parse(JSON.stringify(s.run.surface.trails)), s.run.surface.trails, 'JSON-safe');
});

test('C182: with no way round the trail pauses (no workers, no yield, explicit count kept) and reopens when clear', () => {
  const { s, d, t, path, src } = world();
  t.workers = 5;
  // ring the source with molehills except nothing: every neighbour of the source is blocked
  let u = 950;
  for (const h of neighbors(src.hex)) molehill(s, h, u++);
  const ev = tick(s, d);
  assert.ok(t.detour && t.detour.paused, 'paused');
  assert.deepEqual(t.path, path, 'drawn on its own route while paused');
  const de = d.surface.trails.find((x) => x.uid === t.uid);
  assert.equal(de.detour, 'paused');
  assert.equal(de.out, 0);
  assert.equal(de.workers, 0);
  assert.equal(t.workers, 5, 'the explicit worker count is kept for later');
  assert.ok(ev.some((e) => e.type === 'trailDetour' && e.mode === 'paused'));
  assert.equal(trails.detourInfo(s, t).mode, 'paused');
  // still blocked: no new event, no change
  const ev1 = tick(s, d);
  assert.ok(!ev1.some((e) => e.type === 'trailDetour'));
  s.run.events.objects = [];
  tick(s, d);
  assert.equal(t.detour, undefined);
  assert.ok(d.surface.trails.find((x) => x.uid === t.uid).out > 0, 'pays again');
});

test('C182: a spring puddle on the route detours too; outside spring the trail walks through it', () => {
  const { s, d, t, path } = world();
  s.run.surface.terrain[path[2]] = TERRAIN.puddle.code;
  s.meta.season.t = 0;   // spring: puddles block
  tick(s, d);
  assert.ok(t.detour && !t.detour.paused);
  assert.ok(!t.path.includes(path[2]));
  assert.equal(trails.detourInfo(s, t).why, 'puddle');
  // summer: the puddle no longer blocks, the trail goes back to its route
  s.meta.season.t = s.meta.season.lengthSec + 1;   // lengthSec is one season
  tick(s, d);
  assert.equal(t.detour, undefined);
  assert.deepEqual(t.path, path);
});

test('C182: a player reroute while on a detour becomes the trail\'s own route', () => {
  const { s, d, t, path } = world();
  molehill(s, path[2]);
  tick(s, d);
  assert.ok(t.detour);
  const wp = [hexIndex(2, -1)];
  assert.equal(trails.handlers.rerouteTrail.validate(s, d, { uid: t.uid, waypoints: wp }), null);
  trails.handlers.rerouteTrail.apply(s, d, { uid: t.uid, waypoints: wp }, fakeEnv());
  assert.equal(t.detour, undefined);
  assert.ok(t.path.includes(wp[0]));
  tick(s, d);
  assert.equal(t.detour, undefined, 'the new route is clear');
});

test('C182: new trails still route round obstacles (drawTrail) and a quiet tick does no work', () => {
  const { s, d, t, path } = world();
  tick(s, d);
  const key = d.surface._detourKey;
  tick(s, d);
  assert.equal(d.surface._detourKey, key, 'unchanged key: nothing re-checked');
  molehill(s, path[1]);
  tick(s, d);
  assert.notEqual(d.surface._detourKey, key);
  assert.ok(!t.path.includes(path[1]));
});
