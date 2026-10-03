// WP4 territory and derive (DESIGN §8.5 slots, §8.6 territory, §8.7 mound, §7.11 entrances): auto-claim radius,
// claimed / conquered / trunk land, rival land and borders, passability, slot accounting, D_nav, tPeak, nuptialHex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as surface from '../src/systems/surface.js';
import * as trails from '../src/systems/trails.js';
import * as rivals from '../src/systems/rivals.js';
import { TERRAIN, SLOTS, TRAIL } from '../src/data/surface.js';
import { RESEARCH } from '../src/data/research.js';
import { hexIndex, ringOf, neighbors, countInRadius, hexDist } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

function world(over = {}) {
  const s = newState(1);
  const d = makeDerived(over);
  surface.derive(s, d);
  return { s, d };
}

test('auto-claim radius 1 + floor(mound / 5) around every entrance; owned codes and ownedCount', () => {
  const { s, d } = world();
  assert.equal(d.surface.ownedCount, 7);
  assert.equal(d.surface.owned[0], 1);
  assert.ok(neighbors(0).every((h) => d.surface.owned[h] === 1));
  s.run.surface.mound = 4;
  surface.derive(s, d);
  assert.equal(d.surface.ownedCount, 7);
  s.run.surface.mound = 5;
  surface.derive(s, d);
  assert.equal(d.surface.ownedCount, countInRadius(2), 'mound level change alone rebuilds territory');
  s.run.surface.mound = 0;
  const out = hexIndex(5, -2);
  surface.addEntrance(s, d, 'outpost', out, -1, 3);
  surface.addEntrance(s, d, 'outpost', out, -1, 3); // duplicate ignored
  assert.equal(s.run.surface.entrances.length, 2);
  surface.derive(s, d);
  assert.equal(d.surface.ownedCount, 14);
  assert.equal(d.surface.owned[out], 1);
  surface.addEntrance(s, d, 'bogus', 5, 0, 0);
  surface.addEntrance(s, d, 'satellite', -3, 0, 0);
  assert.equal(s.run.surface.entrances.length, 2);
});

test('claimed (2), conquered (3) land; grantHex does not raise claims; conquerHexes bumps rev', () => {
  const { s, d } = world();
  const h1 = hexIndex(2, 0);
  const rev = s.run.surface.rev;
  surface.grantHex(s, d, h1);
  assert.equal(s.run.surface.claims, 0);
  assert.equal(s.run.surface.rev, rev + 1);
  surface.conquerHexes(s, d, [hexIndex(6, 0), hexIndex(6, -1), 99999]);
  surface.derive(s, d);
  assert.equal(d.surface.owned[h1], 2);
  assert.equal(d.surface.owned[hexIndex(6, 0)], 3);
  assert.equal(d.surface.ownedCount, 10);
  surface.touch(s);
  assert.equal(s.run.surface.rev, rev + 3);
});

test('rival land is never owned; owned hexes next to it are border hexes (rivals.rivalLand)', (t) => {
  const { s, d } = world();
  const rivalHex = hexIndex(3, 0);
  s.run.rivals.list.push({ uid: 4, type: 'black_garden_ants', tier: 1, hex: rivalHex, radius: 2, base: 15, n: 15, atk: 3, hp: 15,
    traits: [], alive: true, sighted: false, raidIn: 0, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1,
    extra: [], lost: [], stolen: 0 });
  const land = rivals.rivalLand(s, s.run.rivals.list[0]);
  if (!Array.isArray(land) || land.length === 0) {
    t.skip('rivals.rivalLand is still a stub (WP5)');
    return;
  }
  surface.touch(s);
  surface.derive(s, d);
  for (const h of land) {
    assert.equal(d.surface.owned[h], 0, 'rival land excluded');
    assert.equal(d.surface.rival[h], 4);
  }
  const own = [];
  for (let i = 0; i < 817; i++) if (d.surface.owned[i]) own.push(i);
  for (const h of own) assert.equal(d.surface.border[h], neighbors(h).some((n) => d.surface.rival[n]) ? 1 : 0);
  assert.ok(own.some((h) => d.surface.border[h] === 1));
  // a dead rival's land is free again
  s.run.rivals.list[0].alive = false;
  surface.touch(s);
  surface.derive(s, d);
  assert.equal(d.surface.rival[rivalHex], 0);
  // rival land on a trail path costs 5 % per hex unless escorted
  s.run.rivals.list[0].alive = true;
  surface.touch(s);
  surface.derive(s, d);
  const src = { uid: 50, type: 'seed_patch', hex: hexIndex(4, 0), stock: 1e6, max: 1e6, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} };
  s.run.surface.sources.push(src);
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), rivalHex, src.hex];
  const rivalOnPath = path.filter((h) => d.surface.rival[h]).length;
  const tr = { uid: 51, origin: 0, src: 50, path, len: 4, job: 'forager', S: 0, escorts: 0 };
  const open = trails.trailYield(s, d, tr, 10).out;
  const guarded = trails.trailYield(s, d, { ...tr, escorts: 1 }, 10).out;
  assert.ok(Math.abs(open / guarded - (1 - TRAIL.rivalHexPenalty * rivalOnPath)) < 1e-12);
});

test('passable: stone never, puddles only outside spring, molehill objects, nothing beyond the radius', () => {
  const { s, d } = world();
  const st = hexIndex(2, 0);
  const pu = hexIndex(0, 2);
  const mh = hexIndex(-2, 2);
  s.run.surface.terrain[st] = TERRAIN.stone.code;
  s.run.surface.terrain[pu] = TERRAIN.puddle.code;
  s.run.events.objects.push({ uid: 1, kind: 'molehill', hex: mh, cell: -1, t: 180, data: {} });
  surface.derive(s, d);
  assert.equal(surface.isPassable(s, d, st), false);
  assert.equal(surface.moveCost(s, d, st), null);
  assert.equal(surface.isPassable(s, d, pu), false, 'spring');
  assert.equal(surface.isPassable(s, d, mh), false);
  assert.equal(surface.isPassable(s, d, countInRadius(8)), false, 'outside radius 8');
  assert.equal(surface.isPassable(s, d, -1), false);
  d.season.mods.puddlesBlock = false;
  surface.derive(s, d);
  assert.equal(surface.isPassable(s, d, pu), true);
  assert.equal(surface.moveCost(s, d, pu), 1);
  s.run.surface.terrain[hexIndex(1, -1)] = TERRAIN.leaf_litter.code;
  surface.derive(s, d);
  assert.equal(surface.moveCost(s, d, hexIndex(1, -1)), 1.5);
});

test('slots: base 3 + Mound 3/6/9 + outposts + satellites (+ research slots when the data exists); slotsUsed = trails', () => {
  const { s, d } = world();
  assert.equal(d.surface.slots, SLOTS.base);
  assert.equal(d.surface.slotsUsed, 1);
  const at = (mound) => {
    s.run.surface.mound = mound;
    surface.derive(s, d);
    return d.surface.slots;
  };
  assert.deepEqual([2, 3, 5, 6, 8, 9, 20].map(at), [3, 4, 4, 5, 5, 6, 6]);
  s.run.surface.mound = 0;
  surface.addEntrance(s, d, 'outpost', 40, -1, 2);
  surface.addEntrance(s, d, 'satellite', 60, 10, 0);
  surface.derive(s, d);
  assert.equal(d.surface.slots, SLOTS.base + SLOTS.outpost + SLOTS.satellite);
  if (RESEARCH.trail_memory && RESEARCH.sun_compass) {
    s.run.research.trail_memory = 1;
    s.run.research.sun_compass = 1;
    surface.derive(s, d);
    assert.equal(d.surface.slots, 5 + RESEARCH.trail_memory.fx.slots + RESEARCH.sun_compass.fx.slots);
    assert.equal(surface.trailSlots(s), d.surface.slots);
  }
});

test('D_nav and slope from research / adaptations / federation / hardship (when the data exists)', { skip: !RESEARCH.odometer_navigation && 'needs WP5 research data' }, () => {
  const { s, d } = world();
  assert.equal(d.surface.dNav, 3);
  assert.equal(d.surface.slope, 0.35);
  s.run.research.tandem_running = 1;
  s.run.research.mass_recruitment = 1;
  s.run.research.odometer_navigation = 1;
  surface.derive(s, d);
  assert.equal(d.surface.dNav, 9);
  assert.equal(d.surface.slope, RESEARCH.odometer_navigation.fx.slope);
  d.meta.hardship.barren_ground = 2;
  surface.derive(s, d);
  assert.ok(d.surface.slope >= RESEARCH.odometer_navigation.fx.slope);
});

test('trunk_trails: hexes of trails with ≥ 5 hexes become territory (code 4)', { skip: !RESEARCH.trunk_trails && 'needs WP5 research data' }, () => {
  const { s, d } = world();
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), hexIndex(4, 0)];
  s.run.surface.sources.push({ uid: 60, type: 'seed_patch', hex: hexIndex(4, 0), stock: 1, max: 1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 61, origin: 0, src: 60, path, len: 4, job: 'forager', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  s.run.surface.rev++;
  surface.derive(s, d);
  assert.equal(d.surface.owned[hexIndex(3, 0)], 0);
  s.run.research.trunk_trails = 1;
  surface.derive(s, d);   // research change alone rebuilds territory
  assert.equal(d.surface.owned[hexIndex(3, 0)], 4);
  assert.equal(d.surface.owned[hexIndex(4, 0)], 4);
});

test('frontier = unrevealed hexes within the radius next to revealed ones; tPeak and longestTrail track maxima', () => {
  const { s, d } = world();
  assert.equal(d.surface.frontier.length, 18);
  assert.ok(d.surface.frontier.every((h) => ringOf(h) === 3));
  surface.grantHex(s, d, hexIndex(2, 0));
  surface.derive(s, d);
  const env = fakeEnv();
  surface.tick(s, d, 0.1, env);
  assert.equal(s.run.tPeak, 8);
  s.run.surface.claimed.fill(0);
  surface.touch(s);
  surface.derive(s, d);
  surface.tick(s, d, 0.1, env);
  assert.equal(s.run.tPeak, 8, 'peak is kept');
  assert.equal(s.meta.stats.longestTrail, 1);
});

test('nuptialHex: west if col < 20 else east at distance 1 + floor(|col − 20| / 8); blocked → nearest passable', () => {
  const { s, d } = world();
  assert.equal(surface.nuptialHex(s, d, 10), hexIndex(-2, 0));
  assert.equal(surface.nuptialHex(s, d, 23), hexIndex(1, 0));
  assert.equal(surface.nuptialHex(s, d, 37), hexIndex(3, 0));
  s.run.surface.terrain[hexIndex(-2, 0)] = TERRAIN.stone.code;
  surface.derive(s, d);
  const h = surface.nuptialHex(s, d, 10);
  assert.notEqual(h, hexIndex(-2, 0));
  assert.equal(hexDist(h, hexIndex(-2, 0)), 1);
  assert.ok(surface.isPassable(s, d, h));
});

test('the best untrailed source hint follows bestTargets', () => {
  const { s, d } = world();
  assert.equal(d.surface.bestSource, 0);
  s.run.surface.sources.push({ uid: 70, type: 'seed_patch', hex: hexIndex(2, 0), stock: 300, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.nextUid = 71;
  surface.derive(s, d);
  assert.equal(d.surface.bestSource, 70);
});
