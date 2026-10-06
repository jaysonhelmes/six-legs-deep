// WP4 data tables: shapes, ids, codes, and the cost sequences of DESIGN §8.6 (claims) and §8.7 (mound).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP, TERRAIN, TERRAIN_ORDER, SCOUT, TRAIL, SLOTS, ABILITIES, TERRITORY, MOUND } from '../src/data/surface.js';
import { SOURCES, SOURCE_ORDER } from '../src/data/sources.js';
import * as surface from '../src/systems/surface.js';
import { newState } from './helpers.js';

test('TERRAIN_ORDER is the documented order and codes equal indices', () => {
  assert.deepEqual([...TERRAIN_ORDER], ['grass', 'sand', 'leaf_litter', 'garden_path', 'tree_root', 'stone', 'puddle', 'log']);
  TERRAIN_ORDER.forEach((id, i) => {
    assert.equal(TERRAIN[id].id, id);
    assert.equal(TERRAIN[id].code, i);
  });
  assert.equal(TERRAIN.stone.move, null);
  assert.equal(TERRAIN.puddle.springMove, null);
  assert.equal(TERRAIN.puddle.move, 1);
  assert.equal(TERRAIN.garden_path.move, 0.5);
  assert.deepEqual(Object.keys(TERRAIN).sort(), [...TERRAIN_ORDER].sort());
  const total = TERRAIN_ORDER.reduce((a, id) => a + TERRAIN[id].share, 0);
  assert.ok(total <= 1 && total > 0.95);
});

test('SOURCE_ORDER has the 15 DESIGN sources plus the 2 C188 expedition finds (termite_swarm included, gift excluded) and every entry is well formed', () => {
  assert.equal(SOURCE_ORDER.length, 17);
  assert.ok(SOURCE_ORDER.includes('termite_swarm'));
  assert.ok(!SOURCE_ORDER.includes('gift'));
  assert.deepEqual(Object.keys(SOURCES).sort(), [...SOURCE_ORDER].sort());
  for (const id of SOURCE_ORDER) {
    const s = SOURCES[id];
    assert.equal(s.id, id);
    assert.equal(typeof s.name, 'string');
    assert.ok(s.job === null || ['forager', 'herder', 'leafcutter', 'lycaenid'].includes(s.job), id);
    assert.ok(s.y && typeof s.y === 'object');
    for (const k of ['spring', 'summer', 'autumn', 'winter']) assert.equal(typeof s.season[k], 'number', id + ' season ' + k);
    assert.ok(['fixed', 'random', 'event', 'research', 'conquest', 'expedition'].includes(s.spawn.mode), id);
    if (s.stock) for (const k of ['base', 'sec', 'regrow']) assert.equal(typeof s.stock[k], 'number', id);
  }
  assert.equal(SOURCES.seed_patch.stock.dynamic, true);
  assert.deepEqual(SOURCES.flower_patch.y, { food: 0.55, honeydew: 0.005 });
  assert.deepEqual(SOURCES.dead_insect.y, { food: 0.6, chitin: 0.01 });
  assert.deepEqual(SOURCES.termite_swarm.y, { food: 5, chitin: 0.05 });
  assert.equal(SOURCES.termite_swarm.cap, 30);
  assert.equal(SOURCES.termite_swarm.spawn.ttl, 45);
  assert.equal(SOURCES.lycaenid_caterpillar.minEscorts, 5);
  assert.equal(SOURCES.aphid_colony.capPerLevel, 8);
  assert.equal(SOURCES.prey_cricket.hunt.chitinMult, 2);
  assert.equal(SOURCES.prey_beetle.hunt.apPerRing, 800);
});

test('abilities, slots, trail, scout, territory and mound constants match DESIGN', () => {
  assert.deepEqual(Object.keys(ABILITIES).sort(), ['frenzy', 'mark', 'mass_recruit', 'rally']);
  for (const [id, a] of Object.entries(ABILITIES)) assert.equal(a.id, id);
  assert.deepEqual(ABILITIES.mark.cost, { pheromone: 5 });
  assert.equal(ABILITIES.rally.cd, 120);
  assert.equal(ABILITIES.frenzy.sec, 20);
  assert.equal(SLOTS.base, 3);
  assert.deepEqual([...SLOTS.moundLevels], [3, 6, 9]);
  assert.equal(TRAIL.tHalf, 45);
  assert.equal(TRAIL.sMax, 100);
  assert.equal(SCOUT.forceExp, 0.6);
  assert.equal(MAP.radiusBase, 8);
  assert.equal(TERRITORY.claimGrowth, 1.06);
  assert.equal(MOUND.growth, 1.9);
  assert.ok(Object.isFrozen(TERRAIN) && Object.isFrozen(SOURCES.seed_patch.stock));
});

test('claim cost sequence: claimed 0/10/30/50/80 → 10 / 18 / 57 / 184 / 1,059 pheromone', () => {
  const s = newState();
  const at = (k) => {
    s.run.surface.claims = k;
    return surface.claimCost(s).pheromone;
  };
  assert.equal(at(0), 10);
  assert.equal(Math.round(at(10)), 18);
  assert.equal(Math.round(at(30)), 57);
  assert.equal(Math.round(at(50)), 184);
  // DESIGN prints 1,059; the formula gives 10 × 1.06^80 = 1,057.96 (DESIGN rounded up), so allow ±1
  assert.ok(Math.abs(at(80) - 1059) <= 1.05, 'claim 80: ' + at(80));
  s.meta.achievements.ach_land_grab = 0; // earned at simTime 0 still counts
  s.run.surface.claims = 0;
  assert.ok(Math.abs(surface.claimCost(s).pheromone - 9) < 1e-9);
});

test('mound cost: L1 300, L5 3,910, L10 96,800, L20 5.9e7 soil; null past COST_MAX', () => {
  const s = newState();
  const lv = (L) => {
    s.run.surface.mound = L - 1;
    return surface.moundCost(s).soil;
  };
  assert.equal(lv(1), 300);
  assert.equal(Math.round(lv(5)), 3910);
  assert.ok(Math.abs(lv(10) - 96800) < 10);
  assert.ok(Math.abs(lv(20) / 5.9e7 - 1) < 0.01);
  s.run.surface.mound = 2000;
  assert.equal(surface.moundCost(s), null);
});
