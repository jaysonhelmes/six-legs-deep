// WP3 data tests: strata, chambers and soil features match ARCHITECTURE §6.3 and DESIGN §7.1, §7.6, §7.7, §7.9.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_ORDER, LAYERS, MICRO, DIG, GEOM } from '../src/data/strata.js';
import { CHAMBER_ORDER, CHAMBERS, CHAMBER_RULES, ADJACENCY, ADJACENCY_ORDER } from '../src/data/chambers.js';
import { ROOTS, STONES, CACHES, WATER, SITE_MODS } from '../src/data/soilFeatures.js';
import { GRID } from '../src/data/balance.js';

test('strata: six contiguous layers covering rows 0–79 with DESIGN work and requirements', () => {
  assert.deepEqual(LAYER_ORDER, ['topsoil', 'loam', 'clay', 'gravel', 'bedrock', 'aquifer']);
  let next = 0;
  for (const id of LAYER_ORDER) {
    const L = LAYERS[id];
    assert.equal(L.id, id);
    assert.equal(L.y0, next);
    next = L.y1 + 1;
  }
  assert.equal(next, GRID.rows);
  assert.deepEqual(LAYER_ORDER.map((id) => LAYERS[id].work), [4, 6, 10, 16, 40, 120]);
  assert.equal(LAYERS.clay.workMasonry, 7.2);
  assert.deepEqual(LAYERS.bedrock.req, { research: 'acid_excavation' });
  assert.deepEqual(LAYERS.aquifer.req, { federation: 'aquifer_access' });
  assert.equal(MICRO.topsoil.nursery.spring, 0.15);
  assert.equal(MICRO.topsoil.nursery.summer, -0.15);
  assert.equal(MICRO.gravel.nursery.winter, 0.10);
  assert.equal(DIG.chamberCellMult, 1.5);
  assert.equal(DIG.queueBase, 5);
  assert.equal(GEOM.raidReach, 15);
  assert.equal(GEOM.haulDiv, 24);
  assert.ok(Object.isFrozen(LAYERS) && Object.isFrozen(LAYERS.clay) && Object.isFrozen(DIG.floodRows));
});

test('chambers: 16 entries in DESIGN order with the §6.3 shape', () => {
  assert.equal(CHAMBER_ORDER.length, 16);
  assert.deepEqual(Object.keys(CHAMBERS).sort(), [...CHAMBER_ORDER].sort());
  const keys = ['id', 'name', 'unlock', 'maxInst', 'instBonus', 'w0', 'h0', 'grows', 'rowMin', 'rowMax', 'rule', 'place', 'placeGrowth',
    'f0', 's0', 'g', 'levelExtra', 'maxL', 'maxLBonus', 'frostImmune', 'fx'];
  for (const id of CHAMBER_ORDER) {
    const c = CHAMBERS[id];
    assert.equal(c.id, id);
    for (const k of keys) assert.ok(k in c, id + '.' + k);
    assert.ok(typeof c.name === 'string' && c.name.length > 0);
    assert.ok(c.place.food > 0);
    assert.ok([null, 'touchRoot', 'touchRow0', 'shaftTop', 'touchWater', 'nuptialShaft'].includes(c.rule));
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.fx));
  }
  // F_place = 4 × F0 unless the table lists it (royal, hibernaculum extras, water well)
  for (const id of ['gallery', 'nursery', 'granary', 'scent_library', 'midden', 'barracks', 'root_aphid_pen', 'fungus_garden',
    'repletion_hall', 'hibernaculum', 'thermal_chimney', 'gate', 'nuptial_chamber', 'deep_vault']) {
    assert.equal(CHAMBERS[id].place.food, 4 * CHAMBERS[id].f0, id);
  }
  assert.deepEqual(CHAMBERS.hibernaculum.place, { food: 8000, honeydew: 150 });
  assert.deepEqual(CHAMBERS.gate.place, { food: 2000, chitin: 20 });
  assert.deepEqual(CHAMBERS.gate.levelExtra, { chitin: 5 });
  assert.equal(CHAMBERS.royal_chamber.place.food, 1e5);
  assert.equal(CHAMBERS.royal_chamber.placeGrowth, 10);
  assert.deepEqual(CHAMBERS.royal_chamber.instBonus, [{ trait: 'polygyny', add: 1 }, { federation: 'queens_council', add: 2 }]);
  assert.deepEqual(CHAMBERS.gallery.instBonus, [{ research: 'gallery_arches', add: 2 }]);
  assert.equal(CHAMBERS.water_well.maxInst, 'perPocket');
  assert.deepEqual(CHAMBERS.nuptial_chamber.maxLBonus, { trait: 'royal_court', maxL: 9 });
  assert.deepEqual(CHAMBER_ORDER.filter((id) => CHAMBERS[id].frostImmune), ['royal_chamber', 'thermal_chimney', 'gate']);
  assert.deepEqual(CHAMBER_ORDER.filter((id) => !CHAMBERS[id].grows), ['thermal_chimney', 'gate', 'water_well']);
  // DESIGN §7.6 footprints, max instances, max levels, growth g
  const table = {
    royal_chamber: [4, 2, 1, 0, 2.20], gallery: [3, 2, 4, 0, 1.30], nursery: [3, 2, 3, 0, 1.60], granary: [2, 2, 3, 0, 1.55],
    scent_library: [3, 2, 2, 0, 2.00], midden: [2, 2, 2, 8, 1.60], barracks: [3, 2, 2, 0, 1.70], root_aphid_pen: [3, 2, 2, 0, 1.75],
    fungus_garden: [3, 3, 3, 0, 1.70], repletion_hall: [3, 2, 2, 0, 1.80], hibernaculum: [4, 2, 2, 10, 1.50],
    thermal_chimney: [2, 4, 1, 6, 2.00], gate: [2, 2, 1, 10, 1.70], water_well: [2, 3, 'perPocket', 1, 1], nuptial_chamber: [5, 3, 1, 4, 2.00],
    deep_vault: [4, 3, 1, 8, 2.50],
  };
  for (const [id, [w, h, inst, maxL, g]] of Object.entries(table)) {
    const c = CHAMBERS[id];
    assert.deepEqual([c.w0, c.h0, c.maxInst, c.maxL, c.g], [w, h, inst, maxL, g], id);
  }
  assert.deepEqual(CHAMBER_RULES, { instancePlaceGrowth: 2.5, instanceLevelGrowth: 2, frostMult: 0.5, aquiferMult: 1.2, seedBankMult: 1.1 });
});

test('chamber fx keys match the §6.3 contract table', () => {
  const fx = {
    royal_chamber: { lay: 1.15, housing: 10, storage: 150, slots: 3, flightLevel: 5 },
    gallery: { housing: 10, highL: 30, loam: 1.1 },
    nursery: { slots: 3, royalAdj: 0.15 },
    granary: { cap: 300, capGrowth: 1.65, layer: { clay: 1.25, gravel: 1.5, bedrock: 1.75, aquifer: 1.75 }, claySpoil: 0.005 },
    scent_library: { insight: 0.05, deep: 1.25, royalAdj: 1.10 },
    midden: { disease: 0.10, diseaseMax: 0.8, output: 0.02, outputMax: 0.2, hygiene: 0.8 },
    barracks: { berths: 8, atk: 0.05, atkMax: 0.5, homeAP: 1.10 },
    root_aphid_pen: { honeydew: 0.05, herders: 1.10, winter: 0.5 },
    fungus_garden: { gardeners: 5, leafCap: 500, fungusCap: 1000, clay: 1.5, wellAdj: 1.30 },
    repletion_hall: { berths: 5 },
    hibernaculum: { shelter: 10, upkeep: 0.10, upkeepMax: 0.5 },
    thermal_chimney: { winterForage: 0.10, max: 0.6 },
    gate: { hp: 0.25, theft: 0.10, theftFloor: 0.02 },
    water_well: { gardenAdj: 1.30 },
    nuptial_chamber: { cellsBase: 10, cellsPer: 5, cellsMax: 25, cellsMaxCourt: 50 },
    deep_vault: { offlineSec: 3600, alates: 0.05 },
  };
  for (const id of CHAMBER_ORDER) assert.deepEqual(CHAMBERS[id].fx, fx[id], id);
});

test('unlock keys are the §11 keys', () => {
  const want = {
    royal_chamber: null, gallery: 'chamber_gallery', nursery: 'chamber_nursery', granary: 'chamber_granary',
    scent_library: 'chamber_scent_library', midden: 'chamber_midden', barracks: 'chamber_barracks',
    root_aphid_pen: 'chamber_root_aphid_pen', fungus_garden: 'chamber_fungus_garden', repletion_hall: 'chamber_repletion_hall',
    hibernaculum: 'chamber_hibernaculum', thermal_chimney: 'chamber_thermal_chimney', gate: 'chamber_gate',
    water_well: 'chamber_water_well', nuptial_chamber: 'chamber_nuptial_chamber', deep_vault: 'chamber_deep_vault',
  };
  for (const id of CHAMBER_ORDER) assert.equal(CHAMBERS[id].unlock, want[id], id);
  assert.equal(CHAMBERS.royal_chamber.levelUnlock, 'royal_levelup');
});

test('adjacency rules and soil-feature tables', () => {
  assert.deepEqual(ADJACENCY_ORDER, ['adj_nursery_royal', 'adj_library_royal', 'adj_granary_repletion', 'adj_garden_well', 'hyg_midden',
    'prox_barracks_entrance']);
  for (const id of ADJACENCY_ORDER) {
    assert.equal(ADJACENCY[id].id, id);
    assert.ok(typeof ADJACENCY[id].text === 'string' && ADJACENCY[id].path > 0);
  }
  assert.equal(ADJACENCY.hyg_midden.path, GEOM.hygienePath);
  assert.equal(ADJACENCY.adj_nursery_royal.path, GEOM.adjPathMax);
  assert.equal(ADJACENCY.prox_barracks_entrance.path, GEOM.barracksPath);
  assert.deepEqual(ROOTS, { min: 6, max: 10, yMin: 6, yMax: 25 });
  assert.deepEqual(STONES, { min: 4, max: 8, size: 3, yMin: 8, yMax: 55 });
  assert.deepEqual(WATER, { min: 2, max: 3, sizeMin: 2, sizeMax: 3, yMin: 40, yMax: 70 });
  assert.deepEqual(CACHES.kinds.seed_cache, { weight: 4, res: 'food', sec: 90, min: 50 });
  assert.deepEqual(CACHES.kinds.beetle_husk, { weight: 3, res: 'chitin', sec: 60, min: 25 });
  assert.deepEqual(CACHES.kinds.fossil, { weight: 3, res: 'insight', sec: 60, min: 50 });
  assert.deepEqual(CACHES.amber, { count: 1, layer: 'bedrock' });
  assert.deepEqual(SITE_MODS, { site_stony_ground: { stones: 2, caches: 2 }, site_wet_hollow: { waterAdd: 2 } });
});
