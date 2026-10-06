// WP2 unit tests — data/castes.js, data/jobs.js, data/economy.js, data/adaptations.js: orders, ids, freezing, the
// documented DESIGN numbers, and that every unlock key used is an ARCHITECTURE §11 key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASTE_ORDER, CASTES } from '../src/data/castes.js';
import { JOB_ORDER, JOBS, LOOSE_FORAGE, THRESHOLDS, PRESETS } from '../src/data/jobs.js';
import * as ECON from '../src/data/economy.js';
import { ADAPTATION_ORDER, ADAPTATIONS, ADAPT } from '../src/data/adaptations.js';
import { DOC_UNLOCK_KEYS } from './helpers.js';

const tables = [[CASTE_ORDER, CASTES, ['queen']], [JOB_ORDER, JOBS, []], [ADAPTATION_ORDER, ADAPTATIONS, []]];

test('orders match the contract and every entry repeats its id', () => {
  assert.deepEqual(CASTE_ORDER, ['minor', 'soldier', 'supermajor', 'replete', 'alate']);
  assert.deepEqual(JOB_ORDER, ['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener']);
  assert.deepEqual(ADAPTATION_ORDER, ['quick_dispatch', 'strong_mandibles', 'royal_feeding', 'digging_claws', 'potent_trails',
    'serrated_mandibles', 'thick_cuticle', 'sweet_tooth', 'queens_feast', 'long_legs']);
  for (const [order, table, extra] of tables) {
    for (const id of order) assert.equal(table[id].id, id);
    assert.deepEqual(Object.keys(table).sort(), [...order, ...extra].sort());
    for (const id of Object.keys(table)) assert.equal(typeof table[id].name, 'string');
  }
});

test('data is deep-frozen', () => {
  for (const o of [CASTES, CASTES.soldier.extra.chitin, JOBS.gardener.fx, ADAPTATIONS.quick_dispatch.cost.base, ECON.BROOD.stages, ECON.ACH_FX.ach_myriad]) {
    assert.ok(Object.isFrozen(o));
  }
});

test('documented caste numbers (DESIGN §5.2, §5.7, §6.1, §13.5)', () => {
  const pick = (id) => [CASTES[id].eggMult, CASTES[id].upkeep, CASTES[id].broodFactor];
  assert.deepEqual(pick('minor'), [1, 0.05, 1]);
  assert.deepEqual(pick('soldier'), [5, 0.25, 1.7]);
  assert.deepEqual(pick('supermajor'), [50, 1.0, 3.75]);
  assert.deepEqual(pick('replete'), [20, 0.02, 2.5]);
  assert.deepEqual(pick('alate'), [20, 0.5, 5]);
  assert.deepEqual(CASTES.soldier.extra, { chitin: { base: 1, perOwned: 0.02 } });
  assert.deepEqual(CASTES.supermajor.extra, { chitin: 25, fungus: 5 });
  assert.deepEqual(CASTES.replete.extra, { honeydew: 10 });
  assert.deepEqual(CASTES.alate.extra, { honeydew: { base: 5, growth: 1.15 } });
  assert.deepEqual([CASTES.soldier.atk, CASTES.soldier.hp, CASTES.supermajor.atk, CASTES.supermajor.hp, CASTES.minor.atk, CASTES.minor.hp],
    [4, 20, 30, 250, 0.5, 4]);
  assert.deepEqual(CASTES.replete.fx, { capBonus: 0.02, winterCover: 0.05, winterCoverMax: 0.5 });
  assert.equal(CASTES.queen.upkeep, 0);
});

test('documented job, economy and Adaptation numbers (DESIGN §5, §6, §10, §12)', () => {
  assert.equal(JOBS.digger.fx.exp, 0.85);
  assert.equal(JOBS.herder.fx.capPerLevel, 8);
  assert.deepEqual(JOBS.gardener.fx, { leavesIn: 0.3, fungusOut: 0.1 });
  assert.equal(LOOSE_FORAGE, 0.1);
  assert.equal(THRESHOLDS.digQueueSec, 60);
  assert.equal(THRESHOLDS.rebalanceSec, 5);
  assert.equal(PRESETS.max, 3);
  assert.deepEqual(ECON.EGG, { base: 10, k: 0.02, exp: 1.5, nanitics: 5, naniticsVigor: 25, naniticMult: 0.5 });
  assert.deepEqual(ECON.LAY, { base: 0.2, perRF: 0.05, perRC: 1.15, highFrom: 8, perRCHigh: 1.25, courtPer: 0.25 });
  assert.equal(ECON.BROOD.baseSec, 25);
  assert.equal(ECON.BROOD.frostDeathPerSec, 0.005);
  assert.deepEqual(ECON.HUNGRY, { outputMult: 0.75, endFrac: 0.05, harshDeathPerSec: 0.005 });
  assert.deepEqual(ECON.NUTRITION, { perAdult: 0.005, coef: 0.5 });
  assert.deepEqual(ECON.PHEROMONE, { regenBase: 0.5, regenPerSqrtAdult: 0.05, capBase: 50, capPerMound: 5 });
  assert.equal(ECON.CAPS.royalFood, 150);
  assert.deepEqual(ECON.BOTTLENECK, { capFrac: 0.99, capSec: 5 });
  const costs = {
    quick_dispatch: [{ food: 15 }, 1.7], strong_mandibles: [{ food: 25 }, 1.9], royal_feeding: [{ food: 40 }, 1.75],
    digging_claws: [{ food: 30 }, 1.8], potent_trails: [{ food: 200 }, 3.5], serrated_mandibles: [{ food: 100, chitin: 5 }, 2.0],
    thick_cuticle: [{ food: 100, chitin: 5 }, 2.0], sweet_tooth: [{ food: 500, honeydew: 10 }, 1.9], queens_feast: [{ honeydew: 50 }, 3.0],
    long_legs: [{ food: 1000 }, 3.0],
  };
  for (const [id, [base, growth]] of Object.entries(costs)) {
    assert.deepEqual(ADAPTATIONS[id].cost, { base, growth }, id);
  }
  assert.equal(ADAPT.monomorphicCap, 10);
});

test('every unlock key in WP2 data is an ARCHITECTURE §11 key', () => {
  const keys = new Set(DOC_UNLOCK_KEYS);
  const used = [];
  for (const t of [CASTES, JOBS, ADAPTATIONS]) for (const e of Object.values(t)) if (typeof e.unlock === 'string') used.push(e.unlock);
  assert.ok(used.length > 10);
  for (const k of used) assert.ok(keys.has(k), k);
});
