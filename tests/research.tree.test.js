// WP5 unit tests: data/research.js and systems/research.js — the 57-node tree (costs, prerequisites, fx contract),
// purchases and their reason codes, refinements (10,000 × 2.5^L, null until the branch is complete), innate grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH, RESEARCH_ORDER, BRANCHES, BRANCH_ORDER, REFINEMENT, INNATE } from '../src/data/research.js';
import * as research from '../src/systems/research.js';
import { COST_MAX } from '../src/data/balance.js';
import { newState, makeDerived, fakeEnv, DOC_IDS } from './helpers.js';

const { buyResearch, buyRefinement } = research.handlers;

/** Own every node of a branch (or every node). */
function ownAll(s, branch = null) {
  for (const id of RESEARCH_ORDER) if (!branch || RESEARCH[id].branch === branch) s.run.research[id] = 1;
}

test('the tree has all 57 DESIGN nodes, branch by branch, with valid prerequisites and grid rows', () => {
  assert.equal(RESEARCH_ORDER.length, 57);
  assert.deepEqual([...RESEARCH_ORDER].sort(), [...DOC_IDS.research].sort());
  assert.deepEqual(Object.keys(RESEARCH).sort(), [...RESEARCH_ORDER].sort());
  assert.deepEqual(BRANCH_ORDER, ['foraging', 'excavation', 'brood', 'husbandry', 'warfare', 'communication']);
  const counts = { foraging: 11, excavation: 10, brood: 10, husbandry: 8, warfare: 8, communication: 10 };
  for (const b of BRANCH_ORDER) {
    assert.equal(BRANCHES[b].id, b);
    const ids = RESEARCH_ORDER.filter((id) => RESEARCH[id].branch === b);
    assert.equal(ids.length, counts[b], b);
    assert.deepEqual(ids.map((id) => RESEARCH[id].tier), ids.map((_, i) => i), `${b} rows 0..n−1 in DESIGN order`);
  }
  let lastBranch = -1;
  for (const id of RESEARCH_ORDER) {
    const r = RESEARCH[id];
    assert.equal(r.id, id);
    assert.ok(BRANCH_ORDER.indexOf(r.branch) >= lastBranch, 'branch by branch');
    lastBranch = BRANCH_ORDER.indexOf(r.branch);
    assert.ok(Number.isFinite(r.cost) && r.cost > 0);
    assert.ok(typeof r.name === 'string' && r.name.length > 0);
    assert.ok(r.fx && typeof r.fx === 'object');
    for (const p of r.prereq) {
      assert.ok(RESEARCH[p], `${id}: prerequisite ${p}`);
      if (RESEARCH[p].branch === r.branch) assert.ok(RESEARCH[p].tier < r.tier, `${id} sits below ${p}`);
    }
  }
  assert.ok(Object.isFrozen(RESEARCH) && Object.isFrozen(RESEARCH.trail_memory.fx));
});

test('costs and prerequisites are copied verbatim from DESIGN §11', () => {
  const want = {
    trail_memory: [10, []], scent_marking: [25, ['trail_memory']], mass_recruitment: [2500, ['sun_compass', 'persistent_trails']],
    odometer_navigation: [15000, ['trunk_trails']], coordinated_digging: [15, []], compact_galleries: [20000, ['acid_excavation']],
    supermajors: [5000, ['spermathecal_reserve', 'polymorphism']], fungal_symbiosis: [6000, ['weeder_ants']],
    polymorphism: [300, []], formic_acid: [250, ['polymorphism']], war_chemistry: [12000, ['siege_tactics']],
    pheromone_glands: [250, ['scent_marking']], hive_mind: [12000, ['collective_memory', 'response_thresholds']],
    lycaenid_clients: [1200, ['aphid_shepherding']], living_larders: [1500, ['trophic_eggs']],
  };
  for (const [id, [cost, prereq]] of Object.entries(want)) {
    assert.equal(RESEARCH[id].cost, cost, id);
    assert.deepEqual(RESEARCH[id].prereq, prereq, id);
  }
  // Per-branch cost sums of the DESIGN §11.1–§11.6 tables.
  const sums = { foraging: 29725, excavation: 37795, brood: 13885, husbandry: 14250, warfare: 25950, communication: 20600 };
  for (const [b, want] of Object.entries(sums)) {
    let total = 0;
    for (const id of RESEARCH_ORDER) if (RESEARCH[id].branch === b) total += RESEARCH[id].cost;
    assert.equal(total, want, b);
  }
});

test('fx keys match the ARCHITECTURE §6.5 contract table', () => {
  const want = {
    trail_memory: { forage: 1.25, slots: 1 }, scent_marking: {}, tandem_running: { dNav: 1 }, recruitment_pheromones: { forage: 1.75 },
    double_bridge: { dMult: 0.9, rise: 2 }, persistent_trails: { tHalf: 90, sMax: 150 }, sun_compass: { radius: 12, slots: 2 },
    mass_recruitment: { dNav: 2, rallySec: 60, slots: 2 }, frenzy_signal: {}, trunk_trails: { minLen: 5, mult: 1.5 },
    odometer_navigation: { dNav: 3, slope: 0.5 }, coordinated_digging: { dig: 1.5 }, load_chains: { tunnel: 0.5, queue: 2 },
    clay_masonry: { clayWork: 7.2 }, mound_building: {}, drainage: { drought: 0.5 }, ventilation_shafts: { chamber: 1.10 },
    thermoregulation: { frost: 5 }, gallery_arches: { galleries: 2, housing: 1.25 }, acid_excavation: { dig: 2, stone: 3 },
    compact_galleries: { housing: 2 }, antennation: { scout: 2, insightHex: 1.5 }, chemical_lexicon: { library: 1.5 },
    pheromone_glands: { cap: 50, regen: 1.5 }, early_warning: { warnSec: 30 }, seasonal_clock: { winterR: 0.2 },
    overwintering: { winterUpkeep: 0.8 }, weather_sense: { warnSec: 30 }, hive_mind: { insight: 1.5 }, brood_care: { broodTime: 0.75 },
    age_polyethism: {}, royal_pheromones: { lay: 1.5 }, trophic_eggs: { eggCost: 0.7 }, thermal_brood_shuttling: {},
    nuptial_preparation: {}, response_thresholds: {}, living_larders: {}, spermathecal_reserve: { lay: 2 }, supermajors: {},
    aphid_husbandry: {}, leafcutting: {}, aphid_shepherding: { herderCap: 2 }, fungiculture: {}, lycaenid_clients: {},
    sugar_economy: { honeydew: 2 }, weeder_ants: { blight: 0.25, fungus: 1.5 }, fungal_symbiosis: { phiCoef: 1.0 },
    polymorphism: {}, formic_acid: { atk: 1.3 }, ritual_tournaments: {}, phalanx: { escortAP: 1.5, retreatLoss: 0.1 },
    field_triage: { frac: 0.3, sec: 60, nurses: 5 }, propaganda_pheromones: { enemyAP: 0.9, convert: 0.05 },
    siege_tactics: { home: 0.5 }, war_chemistry: { ap: 2 }, collective_memory: { insight: 2, offlineSec: 7200 },
    diapause_logic: { offlineEff: 0.25, winterUpkeep: 0.75 },
  };
  assert.deepEqual(Object.keys(want).sort(), [...RESEARCH_ORDER].sort());
  for (const id of RESEARCH_ORDER) assert.deepEqual({ ...RESEARCH[id].fx }, want[id], id);
  assert.deepEqual({ ...REFINEMENT }, { base: 10000, growth: 2.5, mult: 1.10 });
  assert.deepEqual({ ...INNATE }, { runs: 3, runsAncestral: 2 });
});

test('isOwned / isAvailable / cost', () => {
  const s = newState();
  assert.equal(research.isOwned(s, 'trail_memory'), false);
  assert.equal(research.isAvailable(s, 'trail_memory'), true);
  assert.equal(research.isAvailable(s, 'scent_marking'), false);
  s.run.research.trail_memory = 1;
  assert.equal(research.isOwned(s, 'trail_memory'), true);
  assert.equal(research.isAvailable(s, 'trail_memory'), false, 'owned is not available');
  assert.equal(research.isAvailable(s, 'scent_marking'), true);
  assert.equal(research.isAvailable(s, 'mass_recruitment'), false);
  assert.deepEqual(research.cost(s, 'polymorphism'), { insight: 300 });
  assert.equal(research.cost(s, 'nope'), null);
  assert.equal(research.isOwned(s, '__proto__'), false);
  assert.equal(research.isAvailable(s, 'constructor'), false);
});

test('buyResearch: reason codes, spends insight, sets run.research, emits researchBought', () => {
  const s = newState();
  const d = makeDerived();
  for (const bad of [{}, { id: 'nope' }, { id: 7 }, { id: null }, { id: '__proto__' }]) {
    assert.equal(buyResearch.validate(s, d, { type: 'buyResearch', ...bad }), 'invalid');
  }
  assert.equal(buyResearch.validate(s, d, { type: 'buyResearch', id: 'trail_memory' }), 'cantAfford');
  s.run.res.insight = 1000;
  assert.match(buyResearch.validate(s, d, { type: 'buyResearch', id: 'scent_marking' }), /^locked/);
  const env = fakeEnv();
  const cmd = { type: 'buyResearch', id: 'trail_memory' };
  assert.equal(buyResearch.validate(s, d, cmd), null);
  buyResearch.apply(s, d, cmd, env);
  assert.equal(s.run.research.trail_memory, 1);
  assert.equal(s.run.res.insight, 990);
  assert.deepEqual(env.events, [{ type: 'researchBought', id: 'trail_memory' }]);
  assert.equal(buyResearch.validate(s, d, cmd), 'max');
  s.run.research.spermathecal_reserve = 1;
  s.run.res.insight = 1e6;
  assert.match(buyResearch.validate(s, d, { type: 'buyResearch', id: 'supermajors' }), /^locked/, 'both prerequisites needed');
  s.run.research.polymorphism = 1;
  assert.equal(buyResearch.validate(s, d, { type: 'buyResearch', id: 'supermajors' }), null);
});

test('branchComplete and refinementCost: null until complete, then 10,000 × 2.5^L, MAX past 1e280', () => {
  const s = newState();
  assert.equal(research.branchComplete(s, 'warfare'), false);
  assert.equal(research.refinementCost(s, 'warfare'), null);
  ownAll(s, 'warfare');
  s.run.research.war_chemistry = 0;
  assert.equal(research.branchComplete(s, 'warfare'), false);
  s.run.research.war_chemistry = 1;
  assert.equal(research.branchComplete(s, 'warfare'), true);
  assert.equal(research.branchComplete(s, 'foraging'), false);
  assert.equal(research.branchComplete(s, 'nope'), false);
  assert.deepEqual(research.refinementCost(s, 'warfare'), { insight: 10000 });
  s.run.refinements.warfare = 3;
  assert.deepEqual(research.refinementCost(s, 'warfare'), { insight: 10000 * 2.5 ** 3 });
  let prev = 0;
  for (let L = 0; L < 20; L++) {
    s.run.refinements.warfare = L;
    const c = research.refinementCost(s, 'warfare').insight;
    assert.ok(c > prev, 'strictly increasing');
    prev = c;
  }
  s.run.refinements.warfare = 800;
  assert.ok(10000 * 2.5 ** 800 > COST_MAX);
  assert.equal(research.refinementCost(s, 'warfare'), null);
});

test('buyRefinement: reason codes, level up, refinementBought', () => {
  const s = newState();
  const d = makeDerived();
  assert.equal(buyRefinement.validate(s, d, { type: 'buyRefinement', branch: 'nope' }), 'invalid');
  assert.equal(buyRefinement.validate(s, d, { type: 'buyRefinement' }), 'invalid');
  assert.equal(buyRefinement.validate(s, d, { type: 'buyRefinement', branch: 'brood' }), 'locked');
  ownAll(s, 'brood');
  assert.equal(buyRefinement.validate(s, d, { type: 'buyRefinement', branch: 'brood' }), 'cantAfford');
  s.run.res.insight = 40000;
  const env = fakeEnv();
  buyRefinement.apply(s, d, { type: 'buyRefinement', branch: 'brood' }, env);
  buyRefinement.apply(s, d, { type: 'buyRefinement', branch: 'brood' }, env);
  assert.equal(s.run.refinements.brood, 2);
  assert.equal(s.run.res.insight, 40000 - 10000 - 25000);
  assert.deepEqual(env.events, [{ type: 'refinementBought', branch: 'brood', level: 1 }, { type: 'refinementBought', branch: 'brood', level: 2 }]);
  assert.equal(buyRefinement.validate(s, d, { type: 'buyRefinement', branch: 'brood' }), 'cantAfford');
  s.run.refinements.brood = 900;
  s.run.res.insight = 1e295;
  assert.equal(buyRefinement.validate(s, d, { type: 'buyRefinement', branch: 'brood' }), 'max');
});

test('grantInnate: era.innate ids and the species innate list, free, counted once', () => {
  const s = newState();
  s.era.innate = { trail_memory: true, brood_care: true, bogus_node: true };
  s.run.research.brood_care = 1;
  assert.equal(research.grantInnate(s), 1);
  assert.equal(s.run.research.trail_memory, 1);
  assert.equal(s.run.research.bogus_node, undefined);
  assert.equal(research.grantInnate(s), 0, 'idempotent');
  assert.equal(s.run.res.insight, 0, 'free');
  const s2 = newState();
  s2.era.species = 'honeypot';
  const n = research.grantInnate(s2);
  assert.ok(n === 0 || s2.run.research.living_larders === 1, 'honeypot innate living_larders (when WP7 species data is present)');
  assert.equal(research.grantInnate({}), 0);
});
