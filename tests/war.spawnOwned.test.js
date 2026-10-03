// Regression (player report, C95): "Anthill appeared over an area I had already battled for and claimed that area."
// Rival spawns (respawns after a conquest, extra rivals as the map grows, bosses, run-start specs) never land on or
// spread their land over hexes the player holds (claimed, conquered, or an entrance's auto-claim radius); when no hex
// is clear the spawn waits. Rival land never includes a claimed/conquered hex, and fire-ant creep never takes one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rivals from '../src/systems/rivals.js';
import { RIVALS, SPAWN, BOSSES } from '../src/data/rivals.js';
import { TERRITORY } from '../src/data/surface.js';
import { hexDist, hexIndex, countInRadius, ringOf } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

function world(seed = 3) {
  const s = newState(seed);
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 } });
  return { s, d };
}

function run(s, d, sec, dt = 0.1) {
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    rivals.tick(s, d, dt, fakeEnv({ dt }));
    s.run.time += dt;
  }
}

/** Every hex a player holds: claimed ∪ conquered ∪ each entrance's auto-claim radius. */
function held(s) {
  const S = s.run.surface;
  const autoR = TERRITORY.autoBase + Math.floor(Math.max(0, S.mound || 0) / TERRITORY.autoPerMound);
  const out = new Set();
  for (let i = 0; i < S.claimed.length; i++) if (S.claimed[i] || S.conquered[i]) out.add(i);
  for (const e of S.entrances) if (e) for (let i = 0; i < countInRadius(S.radius); i++) if (hexDist(i, e.hex) <= autoR) out.add(i);
  return out;
}

/** The rival's full disc (what its land would be without the C95 subtraction) overlaps held hexes. */
function discOverlap(s, r) {
  const own = held(s);
  const bad = [];
  for (let i = 0; i < countInRadius(s.run.surface.radius); i++) if (hexDist(i, r.hex) <= r.radius && own.has(i)) bad.push(i);
  return bad;
}

test('C95: a respawn never lands on or over conquered / claimed land; with no clear hex it waits and retries', () => {
  const { s, d } = world(5);
  const S = s.run.surface;
  const R = S.radius;
  // the player holds the whole outer band except one far pocket
  const pocket = hexIndex(R, -Math.floor(R / 2));
  const landR = RIVALS.black_garden_ants.radius;
  for (let i = countInRadius(R - 3); i < countInRadius(R); i++) if (hexDist(i, pocket) > landR + 1) S.conquered[i] = 1;
  // first: block the pocket too, so nothing qualifies
  for (let i = 0; i < countInRadius(R); i++) if (hexDist(i, pocket) <= landR + 1 && ringOf(i) >= R - 2) S.claimed[i] = 1;
  s.run.rivals.respawn.push({ in: 0, tier: 1 });
  run(s, d, 0.1);
  assert.equal(s.run.rivals.list.length, 0, 'no anthill on held land');
  assert.equal(s.run.rivals.respawn.length, 1, 'the respawn waits');
  assert.ok(s.run.rivals.respawn[0].in > 0 && s.run.rivals.respawn[0].in <= SPAWN.retrySec);
  // the pocket frees up: the respawn lands there, clear of every held hex
  for (let i = 0; i < countInRadius(R); i++) if (hexDist(i, pocket) <= landR + 1) S.claimed[i] = 0;
  run(s, d, SPAWN.retrySec + 1, 1);
  const alive = s.run.rivals.list.filter((r) => r.alive);
  assert.equal(alive.length, 1, 'spawned once a clear hex exists');
  assert.deepEqual(discOverlap(s, alive[0]), [], 'its land touches no held hex');
});

test('C95: across seeds and random holdings, respawns and map-growth rivals never overlap held hexes', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { s, d } = world(seed);
    const S = s.run.surface;
    S.radius = 12;
    // scatter claims and conquests over the outer rings (about 60 %)
    let x = seed * 7919;
    for (let i = countInRadius(8); i < countInRadius(12); i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      if (x / 2147483648 < 0.6) (x & 1 ? S.claimed : S.conquered)[i] = 1;
    }
    s.run.rivals.respawn.push({ in: 0, tier: 1 }, { in: 0, tier: 2 });
    run(s, d, 0.2);
    for (const r of s.run.rivals.list) {
      assert.deepEqual(discOverlap(s, r), [], 'seed ' + seed + ': rival ' + r.uid + ' at ' + r.hex);
      assert.ok(!S.claimed[r.hex] && !S.conquered[r.hex]);
    }
  }
});

test('C95: Old Ridge waits while the outer ring is held; run-start specs move off held land', () => {
  const { s, d } = world(4);
  const S = s.run.surface;
  const R = S.radius;
  for (let i = countInRadius(R - 3); i < countInRadius(R); i++) S.conquered[i] = 1;
  s.cycle.traits.budding = 1;
  s.cycle.alatesCycle = BOSSES.old_ridge_supercolony.alatesCycle;
  run(s, d, 1);
  assert.equal(s.run.rivals.list.filter((r) => r.type === 'old_ridge_supercolony').length, 0, 'postponed');
  for (let i = countInRadius(R - 3); i < countInRadius(R); i++) S.conquered[i] = 0;
  s.run.surface.rev++;   // un-holding hexes goes through surface.touch in the game
  run(s, d, 0.2);
  const or = s.run.rivals.list.filter((r) => r.type === 'old_ridge_supercolony');
  assert.equal(or.length, 1, 'spawns once the ring is free');

  const w = world(6);
  const hex = hexIndex(6, 0);
  for (let i = 0; i < countInRadius(w.s.run.surface.radius); i++) if (hexDist(i, hex) <= 1) w.s.run.surface.claimed[i] = 1;
  rivals.spawnInitial(w.s, w.d, [{ type: 'black_garden_ants', tier: 1, hex }]);
  const r = w.s.run.rivals.list[0];
  assert.ok(r, 'the spec still spawns');
  assert.notEqual(r.hex, hex, 'moved off the held hex');
  assert.deepEqual(discOverlap(w.s, r), []);
});

test('C95: rival land never includes a claimed or conquered hex; fire-ant creep never takes one', () => {
  const { s, d } = world(3);
  const r = rivals.createRival(s, { type: 'fire_ants', hex: hexIndex(4, 0) });
  const land0 = rivals.rivalLand(s, r);
  const h = land0.find((x) => x !== r.hex);
  s.run.surface.claimed[h] = 1;
  assert.ok(!rivals.rivalLand(s, r).includes(h), 'a held hex is not rival land');
  s.run.surface.claimed[h] = 0;
  // hold every hex around the land: creep has nowhere to go
  const ring = [];
  for (let i = 0; i < countInRadius(s.run.surface.radius); i++) if (hexDist(i, r.hex) === r.radius + 1) ring.push(i);
  for (const i of ring) s.run.surface.claimed[i] = 1;
  run(s, d, 400, 1);
  assert.equal(r.extra.length, 0, 'no creep onto claimed hexes');
  assert.ok(rivals.rivalLand(s, r).every((x) => !s.run.surface.claimed[x] && !s.run.surface.conquered[x]));
});
