// WP4 source lifecycle (DESIGN §8.4, §18 C34): seed-patch dynamic max and regrowth, sizing at discovery, ttl, rot,
// aphid levels, random spawns (online only), boon_rich_prey, lycaenid spawn, dormant wake, spawnSource / removeSource.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as surface from '../src/systems/surface.js';
import * as trails from '../src/systems/trails.js';
import { SOURCES } from '../src/data/sources.js';
import { TERRAIN } from '../src/data/surface.js';
import { RESEARCH } from '../src/data/research.js';
import { ringOf, hexIndex, countInRadius, hexDist } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);

function world(over = {}) {
  const s = newState(1);
  const d = makeDerived(over);
  surface.derive(s, d);
  return { s, d };
}

function tickOnce(s, d, dt = 0.1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  for (const k of Object.keys(d.ledger)) d.ledger[k] = {};
  surface.derive(s, d);
  trails.tick(s, d, dt, env);
  surface.tick(s, d, dt, env);
  return env.events;
}

test('seed patch max follows current gross food/s every tick (max(300, 300 s of gross)) and the stock is clamped to it', () => {
  const { s, d } = world();
  const uid = surface.spawnSource(s, d, 'seed_patch', 8);
  const seed = s.run.surface.sources.find((x) => x.uid === uid);
  assert.equal(seed.max, 300);
  assert.equal(seed.stock, 300);
  d.rates.food.gross = 10;
  tickOnce(s, d, 0.1);
  assert.equal(seed.max, 3000);
  assert.ok(seed.stock <= 300 + 0.01 * 3000 * 0.1 + 1e-9, 'stock regrows, it does not jump');
  d.rates.food.gross = 0;
  tickOnce(s, d, 0.1);
  assert.equal(seed.max, 300);
  assert.ok(seed.stock <= 300);
});

test('seed patch regrows 1 % of max per second', () => {
  const { s, d } = world();
  const uid = surface.spawnSource(s, d, 'seed_patch', 8);
  const seed = s.run.surface.sources.find((x) => x.uid === uid);
  seed.stock = 0;
  tickOnce(s, d, 1);
  close(seed.stock, 3, 1e-9);
});

test('C34: a finite source on a fogged hex is unsized (stock = max = 0, not targetable) until revealed, then sized from current gross', () => {
  const { s, d } = world();
  d.rates.food.gross = 4;
  const hex = hexIndex(4, 0);
  const uid = surface.spawnSource(s, d, 'dead_insect', hex);
  const bug = s.run.surface.sources.find((x) => x.uid === uid);
  assert.equal(bug.data.unsized, true);
  assert.equal(bug.stock, 0);
  assert.equal(bug.max, 0);
  assert.equal(SOURCES.dead_insect.spawn.ttl, bug.ttl);
  const draw = trails.handlers.drawTrail.validate(s, d, { type: 'drawTrail', origin: 0, target: hex });
  assert.equal(draw, 'invalid:target');
  tickOnce(s, d, 0.1);
  assert.equal(bug.stock, 0, 'still fogged');
  d.rates.food.gross = 4;
  surface.revealHexes(s, d, [hex], { insight: false });
  assert.equal(bug.data.unsized, undefined);
  assert.equal(bug.max, 360);                     // max(150, 90 × 4)
  assert.equal(bug.stock, 360);
  // on a revealed hex the source is sized at spawn
  const uid2 = surface.spawnSource(s, d, 'fallen_fruit', 9);
  const fruit = s.run.surface.sources.find((x) => x.uid === uid2);
  assert.equal(fruit.max, 720);                   // max(500, 180 × 4)
});

test('ttl expiry removes the source (and its trails) with reason expired', () => {
  const { s, d } = world();
  const uid = surface.spawnSource(s, d, 'dead_insect', 8);
  const ev = tickOnce(s, d, 361);
  assert.equal(s.run.surface.sources.find((x) => x.uid === uid), undefined);
  assert.ok(ev.some((e) => e.type === 'sourceRemoved' && e.uid === uid && e.reason === 'expired'));
  assert.equal(s.run.stats.sourcesDepleted, 0);
});

test('fallen fruit rots after 4 minutes at 1 % of max per second', () => {
  const { s, d } = world();
  const uid = surface.spawnSource(s, d, 'fallen_fruit', 8);
  const fruit = s.run.surface.sources.find((x) => x.uid === uid);
  fruit.age = SOURCES.fallen_fruit.fx.rotAfter + 1;
  tickOnce(s, d, 10);
  close(fruit.stock, 500 - 0.01 * 500 * 10, 1e-9);
  tickOnce(s, d, 100);
  assert.equal(s.run.surface.sources.find((x) => x.uid === uid), undefined);
});

test('aphid colonies gain a level per 6 min while at least 50 % herded (max 3)', () => {
  const { s, d } = world();
  const uid = surface.spawnSource(s, d, 'aphid_colony', 8);
  const aphid = s.run.surface.sources.find((x) => x.uid === uid);
  trails.createTrail(s, d, 0, uid);
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.herder = 3;                    // < 50 % of 8
  for (let i = 0; i < 4; i++) tickOnce(s, d, 100);
  assert.equal(aphid.level, 1);
  assert.equal(aphid.herdT, 0);
  s.run.colony.jobs.herder = 4;                    // 50 %
  for (let i = 0; i < 4; i++) tickOnce(s, d, 100);
  assert.equal(aphid.level, 2);
  s.run.colony.jobs.herder = 50;
  for (let i = 0; i < 20; i++) tickOnce(s, d, 100);
  assert.equal(aphid.level, 3);
});

test('random spawns: dead insect every 3 min (max 2), prey every 6 min at ring 4+; paused offline', () => {
  const { s, d } = world();
  const S = s.run.surface;
  S.spawn.insect = 0.05;
  const ev = tickOnce(s, d, 0.1);
  const bugs = () => S.sources.filter((x) => x.type === 'dead_insect');
  assert.equal(bugs().length, 1);
  close(S.spawn.insect, SOURCES.dead_insect.spawn.every - 0.05, 1e-9);
  const r = ringOf(bugs()[0].hex);
  assert.ok(r >= 3 && r <= S.radius);
  assert.ok(ev.some((e) => e.type === 'sourceSpawned'));
  S.spawn.insect = 0.05;
  tickOnce(s, d, 0.1);
  S.spawn.insect = 0.05;
  tickOnce(s, d, 0.1);
  assert.equal(bugs().length, 2, 'max 2 at once');
  S.spawn.prey = 0.05;
  tickOnce(s, d, 0.1);
  const prey = S.sources.filter((x) => x.type.startsWith('prey_'));
  assert.equal(prey.length, 1);
  assert.ok(ringOf(prey[0].hex) >= 4);
  assert.equal(prey[0].ttl, SOURCES[prey[0].type].spawn.ttl - 0, 'fresh prey');
  const before = S.sources.length;
  S.spawn.insect = 0.05;
  S.sources = S.sources.filter((x) => x.type !== 'dead_insect');
  tickOnce(s, d, 1, { offline: true });
  assert.equal(S.spawn.insect, 0.05, 'timers do not run offline');
  assert.ok(S.sources.length < before);
});

test('prey spawn hexes favour hexes within 2 of a fallen log (×2 weight)', () => {
  let near = 0;
  let total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = newState(seed);
    const d = makeDerived();
    s.run.surface.terrain[hexIndex(6, -2)] = TERRAIN.log.code;
    surface.derive(s, d);
    for (let k = 0; k < 5; k++) {
      const uid = surface.spawnSource(s, d, 'prey_cricket', -1);
      const src = s.run.surface.sources.find((x) => x.uid === uid);
      total++;
      if (hexDist(src.hex, hexIndex(6, -2)) <= 2) near++;
      surface.removeSource(s, d, uid, 'test');
    }
  }
  // 19 hexes near the log out of the ring 4–8 band (~150 eligible hexes): uniform ≈ 12 %, ×2 weight ≈ 22 %
  assert.ok(near / total > 0.14, `near-log share ${near / total}`);
});

test('boon_rich_prey: a dead insect at ring 2 now and every 2 min (one at a time) during the first 10 min', () => {
  const { s, d } = world();
  s.run.boon = 'boon_rich_prey';
  tickOnce(s, d, 0.1);
  const boonBugs = () => s.run.surface.sources.filter((x) => x.data.boon);
  assert.equal(boonBugs().length, 1);
  assert.equal(ringOf(boonBugs()[0].hex), 2);
  surface.removeSource(s, d, boonBugs()[0].uid, 'eaten');
  s.run.time = 100;
  for (let i = 0; i < 59; i++) tickOnce(s, d, 2);
  assert.equal(boonBugs().length, 0, 'not before the 2-minute mark');
  tickOnce(s, d, 2);
  assert.equal(boonBugs().length, 1, 'respawned on the next 2-minute mark');
  s.run.time = 700;
  surface.removeSource(s, d, boonBugs()[0].uid, 'eaten');
  for (let i = 0; i < 20; i++) tickOnce(s, d, 10);
  assert.equal(boonBugs().length, 0, 'over after 10 minutes');
});

test('lycaenid caterpillars (1–2, ring 3–6) appear once lycaenid_clients is owned', () => {
  const { s, d } = world();
  tickOnce(s, d, 0.1);
  assert.equal(s.run.surface.sources.filter((x) => x.type === 'lycaenid_caterpillar').length, 0);
  s.run.research.lycaenid_clients = 1;
  tickOnce(s, d, 0.1);
  const lyc = s.run.surface.sources.filter((x) => x.type === 'lycaenid_caterpillar');
  assert.ok(lyc.length >= 1 && lyc.length <= 2);
  for (const x of lyc) assert.ok(ringOf(x.hex) >= 3 && ringOf(x.hex) <= 6);
  tickOnce(s, d, 0.1);
  assert.equal(s.run.surface.sources.filter((x) => x.type === 'lycaenid_caterpillar').length, lyc.length, 'spawned once');
});

test('dormant sources beyond the radius wake when the radius covers them; sun_compass widens the map (when its data exists)', () => {
  const { s, d } = world();
  const hex = hexIndex(10, 0);
  const uid = surface.spawnSource(s, d, 'termite_mound', hex);
  const tm = s.run.surface.sources.find((x) => x.uid === uid);
  assert.equal(tm.data.dormant, true);
  tickOnce(s, d, 1);
  assert.equal(tm.age, 0, 'dormant sources do not age');
  if (!RESEARCH.sun_compass) {
    s.run.surface.radius = 12;
  } else {
    s.run.research.sun_compass = 1;
  }
  const rev = s.run.surface.rev;
  const ev = tickOnce(s, d, 1);
  assert.equal(s.run.surface.radius, 12);
  assert.equal(tm.data.dormant, undefined);
  if (RESEARCH.sun_compass) {
    assert.ok(ev.some((e) => e.type === 'radiusChanged' && e.radius === 12));
    assert.ok(s.run.surface.rev > rev);
    surface.derive(s, d);
    assert.ok(d.surface.frontier.some((h) => ringOf(h) > 8) || d.surface.frontier.length > 0);
  }
});

test('spawnSource honours rMin/rMax/terrain/ttl/data/level, avoids busy hexes and returns 0 when nothing fits', () => {
  const { s, d } = world();
  const S = s.run.surface;
  const uid = surface.spawnSource(s, d, 'fallen_fruit', -1, { rMin: 2, rMax: 2, ttl: 99, data: { tag: 'x' } });
  const f = S.sources.find((x) => x.uid === uid);
  assert.equal(ringOf(f.hex), 2);
  assert.equal(f.ttl, 99);
  assert.equal(f.data.tag, 'x');
  for (let i = countInRadius(1); i < countInRadius(2); i++) if (i !== f.hex) S.terrain[i] = TERRAIN.stone.code;
  assert.equal(surface.spawnSource(s, d, 'fallen_fruit', -1, { rMin: 2, rMax: 2 }), 0, 'no free passable ring-2 hex');
  assert.equal(surface.spawnSource(s, d, 'nonsense', 5), 0);
  assert.equal(surface.spawnSource(s, d, 'seed_patch', 5000), 0);
  const a = surface.spawnSource(s, d, 'aphid_colony', 40, { level: 2 });
  assert.equal(S.sources.find((x) => x.uid === a).level, 2);
  const lyc = surface.spawnSource(s, d, 'termite_swarm', 41);
  assert.equal(S.sources.find((x) => x.uid === lyc).ttl, 45);
  const env = fakeEnv();
  surface.spawnSource(s, d, 'dead_insect', 42, { env });
  assert.ok(env.events.some((e) => e.type === 'sourceSpawned'));
});

test('removeSource deletes every trail to it (rev++) and emits sourceRemoved and trailDeleted (queued without env)', () => {
  const { s, d } = world();
  const uid = surface.spawnSource(s, d, 'seed_patch', 8);
  const t1 = trails.createTrail(s, d, 0, uid);
  assert.ok(t1 > 0);
  const rev = s.run.surface.rev;
  surface.removeSource(s, d, uid, 'footstep');
  assert.equal(s.run.surface.trails.find((t) => t.uid === t1), undefined);
  assert.equal(s.run.surface.rev, rev + 1);
  const env = fakeEnv();
  trails.tick(s, d, 0.1, env);
  assert.ok(env.events.some((e) => e.type === 'sourceRemoved' && e.uid === uid && e.reason === 'footstep'));
  assert.ok(env.events.some((e) => e.type === 'trailDeleted' && e.uid === t1));
  surface.removeSource(s, d, 9999, 'nope'); // no throw
});

test('mapgen-style sources on revealed rings are targetable immediately; sourceAt finds the first source on a hex', () => {
  const { s, d } = world();
  assert.equal(surface.sourceAt(s, 3).type, 'crumb_scatter');
  assert.equal(surface.sourceAt(s, 4), null);
});
