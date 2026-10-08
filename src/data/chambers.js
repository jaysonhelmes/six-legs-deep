// The 19 chambers (DESIGN §7.6; War Hall C136; Carapace Store and Workshop C179), their cost model (§7.5), placement rules (§7.4) and adjacency rules (§7.7).
// Owner: WP3. Contract: ARCHITECTURE §6.3 (entry shape and `fx` keys per chamber).
//
// Entry fields: unlock (§11 key gating placement; null = pre-dug), maxInst (number | 'perPocket'), instBonus
// [{ research|trait|federation: id, add }], w0/h0 L1 footprint, grows (footprint grows to L8), rowMin/rowMax (footprint
// rows), rule (null | 'touchRoot' | 'touchRow0' | 'shaftTop' | 'touchWater' | 'nuptialShaft'), place (L0→L1 cost:
// food scales with placeGrowth^k, listed extras are flat), f0/s0/g (level-up food/soil: f0 × g^L × 2^k), levelExtra
// (× g^L), maxL (0 = no cap), maxLBonus, frostImmune, fx (effect numbers; consumers never hardcode them).
// WP3 extensions: levelUnlock (royal level-ups need 'royal_levelup', §11), deepFrom (scent library depth bonus layer),
// aquiferCount (a Water Well in the aquifer counts double in agg.wells, DESIGN §7.1).

const freeze = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') freeze(o[k]);
  return Object.freeze(o);
};

/** Chamber ids in Build-panel order (DESIGN §7.6 table order). */
export const CHAMBER_ORDER = freeze([
  'royal_chamber', 'gallery', 'nursery', 'granary', 'scent_library', 'midden', 'barracks', 'war_hall', 'carapace_store',
  'carapace_workshop', 'root_aphid_pen', 'fungus_garden', 'repletion_hall', 'hibernaculum', 'thermal_chimney', 'gate',
  'water_well', 'nuptial_chamber', 'deep_vault',
]);

/**
 * C219: stable one-character codes of chamber types for the Colony History record (s.meta.strata[].ch). APPEND ONLY:
 * a code, once used in a save, must keep meaning the same type.
 */
export const CHAMBER_CODES = freeze({
  royal_chamber: 'a', gallery: 'b', nursery: 'c', granary: 'd', scent_library: 'e', midden: 'f', barracks: 'g', war_hall: 'h',
  carapace_store: 'i', carapace_workshop: 'j', root_aphid_pen: 'k', fungus_garden: 'l', repletion_hall: 'm', hibernaculum: 'n',
  thermal_chimney: 'o', gate: 'p', water_well: 'q', nuptial_chamber: 'r', deep_vault: 's',
});

/** C219: chambers kept per Colony History record, the largest first (the save budget: about 9 characters each). */
export const HISTORY_CHAMBERS_MAX = 24;

/** Chambers by id (ARCHITECTURE §6.3 shape). */
export const CHAMBERS = freeze({
  royal_chamber: {
    id: 'royal_chamber', name: 'Royal Chamber', unlock: null, levelUnlock: 'royal_levelup',
    maxInst: 1, instBonus: [{ trait: 'polygyny', add: 1 }, { federation: 'queens_council', add: 2 }],
    w0: 4, h0: 2, grows: true, rowMin: 20, rowMax: 79, rule: null,
    place: { food: 1e5 }, placeGrowth: 10,
    f0: 50, s0: 90, g: 2.20, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: true,
    fx: { lay: 1.15, housing: 10, storage: 150, slots: 3, flightLevel: 5 },
  },
  gallery: {
    id: 'gallery', name: 'Gallery', unlock: 'chamber_gallery',
    maxInst: 4, instBonus: [{ research: 'gallery_arches', add: 2 }],
    w0: 3, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 40 }, placeGrowth: 2.5,
    f0: 10, s0: 24, g: 1.30, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { housing: 11, highL: 30, loam: 1.1 },
  },
  nursery: {
    id: 'nursery', name: 'Nursery', unlock: 'chamber_nursery',
    maxInst: 3, instBonus: [],
    w0: 3, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 80 }, placeGrowth: 2.5,
    f0: 20, s0: 45, g: 1.60, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { slots: 3, royalAdj: 0.15 },
  },
  granary: {
    id: 'granary', name: 'Granary', unlock: 'chamber_granary',
    maxInst: 3, instBonus: [],
    w0: 2, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 60 }, placeGrowth: 2.5,
    f0: 15, s0: 36, g: 1.55, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { cap: 400, capGrowth: 1.65, layer: { clay: 1.25, gravel: 1.5, bedrock: 1.75, aquifer: 1.75 }, claySpoil: 0.005 },
  },
  scent_library: {
    id: 'scent_library', name: 'Scent Library', unlock: 'chamber_scent_library',
    maxInst: 2, instBonus: [],
    w0: 3, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 600 }, placeGrowth: 2.5,
    f0: 150, s0: 120, g: 2.00, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    deepFrom: 'gravel',
    fx: { insight: 0.05, deep: 1.25, royalAdj: 1.10 },
  },
  midden: {
    id: 'midden', name: 'Midden', unlock: 'chamber_midden',
    maxInst: 2, instBonus: [],
    w0: 2, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 200 }, placeGrowth: 2.5,
    f0: 50, s0: 75, g: 1.60, levelExtra: null, maxL: 8, maxLBonus: null, frostImmune: false,
    fx: { disease: 0.10, diseaseMax: 0.8, output: 0.02, outputMax: 0.2, hygiene: 0.8, chitin: 0.05 }, // chitin: C103 /s per effective level
  },
  barracks: {
    id: 'barracks', name: 'Barracks', unlock: 'chamber_barracks',
    maxInst: 2, instBonus: [],
    w0: 3, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 1200 }, placeGrowth: 2.5,
    f0: 300, s0: 150, g: 1.70, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { berths: 8, atk: 0.05, atkMax: 0.5, homeAP: 1.10 },
  },
  // C136: supermajors live only here (Barracks berths are soldier-only). Deep (row ≥ 30), pricier than the Barracks.
  war_hall: {
    id: 'war_hall', name: 'War Hall', unlock: 'chamber_war_hall',
    maxInst: 2, instBonus: [],
    w0: 4, h0: 2, grows: true, rowMin: 30, rowMax: 79, rule: null,
    place: { food: 25000 }, placeGrowth: 2.5,
    f0: 6250, s0: 2500, g: 1.80, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { berths: 4 },
  },
  // C179 (player decision): the chitin chambers. The Store raises the chitin storage cap (chitinCap × capGrowth^(L−1)
  // per Store, summed into d.nest.agg.chitinCapBase); the Workshop boosts chitin from every source (+chitinBoost per
  // level, all Workshops together at most boostMax, d.nest.agg.chitinBoost) and recycles `recycle` chitin per level
  // from every fallen soldier or supermajor (d.nest.agg.chitinRecycle).
  carapace_store: {
    id: 'carapace_store', name: 'Carapace Store', unlock: 'chamber_carapace_store',
    maxInst: 2, instBonus: [],
    w0: 2, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 600 }, placeGrowth: 2.5,
    f0: 150, s0: 90, g: 1.60, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { chitinCap: 300, capGrowth: 1.6 },
  },
  carapace_workshop: {
    id: 'carapace_workshop', name: 'Carapace Workshop', unlock: 'chamber_carapace_workshop',
    maxInst: 1, instBonus: [],
    w0: 3, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 3000, chitin: 30 }, placeGrowth: 2.5,
    f0: 750, s0: 300, g: 1.75, levelExtra: null, maxL: 10, maxLBonus: null, frostImmune: false,
    fx: { chitinBoost: 0.10, boostMax: 1.0, recycle: 0.25 },
  },
  root_aphid_pen: {
    id: 'root_aphid_pen', name: 'Root Aphid Pen', unlock: 'chamber_root_aphid_pen',
    maxInst: 2, instBonus: [],
    w0: 3, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: 'touchRoot',
    place: { food: 1600 }, placeGrowth: 2.5,
    f0: 400, s0: 240, g: 1.75, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { honeydew: 0.05, herders: 1.10, winter: 0.5 },
  },
  fungus_garden: {
    id: 'fungus_garden', name: 'Fungus Garden', unlock: 'chamber_fungus_garden',
    maxInst: 3, instBonus: [],
    w0: 3, h0: 3, grows: true, rowMin: 24, rowMax: 79, rule: null,
    place: { food: 4000 }, placeGrowth: 2.5,
    f0: 1000, s0: 450, g: 1.70, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { gardeners: 5, leafCap: 500, fungusCap: 1000, clay: 1.5, wellAdj: 1.30 },
  },
  repletion_hall: {
    id: 'repletion_hall', name: 'Repletion Hall', unlock: 'chamber_repletion_hall',
    maxInst: 2, instBonus: [],
    w0: 3, h0: 2, grows: true, rowMin: 1, rowMax: 79, rule: null,
    place: { food: 8000 }, placeGrowth: 2.5,
    f0: 2000, s0: 900, g: 1.80, levelExtra: null, maxL: 0, maxLBonus: null, frostImmune: false,
    fx: { berths: 5 },
  },
  hibernaculum: {
    id: 'hibernaculum', name: 'Hibernaculum', unlock: 'chamber_hibernaculum',
    maxInst: 2, instBonus: [],
    w0: 4, h0: 2, grows: true, rowMin: 30, rowMax: 79, rule: null,
    place: { food: 8000, honeydew: 150 }, placeGrowth: 2.5,
    f0: 2000, s0: 600, g: 1.50, levelExtra: null, maxL: 10, maxLBonus: null, frostImmune: false,
    fx: { shelter: 10, upkeep: 0.10, upkeepMax: 0.5 },
  },
  thermal_chimney: {
    id: 'thermal_chimney', name: 'Thermal Chimney', unlock: 'chamber_thermal_chimney',
    maxInst: 1, instBonus: [],
    w0: 2, h0: 4, grows: false, rowMin: 0, rowMax: 79, rule: 'touchRow0',
    place: { food: 6000 }, placeGrowth: 2.5,
    f0: 1500, s0: 600, g: 2.00, levelExtra: null, maxL: 6, maxLBonus: null, frostImmune: true,
    fx: { winterForage: 0.10, max: 0.6 },
  },
  gate: {
    id: 'gate', name: 'Gate', unlock: 'chamber_gate',
    maxInst: 1, instBonus: [],
    w0: 2, h0: 2, grows: false, rowMin: 0, rowMax: 6, rule: 'shaftTop',
    place: { food: 2000, chitin: 20 }, placeGrowth: 2.5,
    f0: 500, s0: 300, g: 1.70, levelExtra: { chitin: 5 }, maxL: 10, maxLBonus: null, frostImmune: true,
    fx: { hp: 0.25, theft: 0.10, theftFloor: 0.02 },
  },
  water_well: {
    id: 'water_well', name: 'Water Well', unlock: 'chamber_water_well',
    maxInst: 'perPocket', instBonus: [],
    w0: 2, h0: 3, grows: false, rowMin: 1, rowMax: 79, rule: 'touchWater',
    place: { food: 2000 }, placeGrowth: 2.5,
    f0: 0, s0: 0, g: 1, levelExtra: null, maxL: 1, maxLBonus: null, frostImmune: false,
    aquiferCount: 2,
    fx: { gardenAdj: 1.30 },
  },
  nuptial_chamber: {
    id: 'nuptial_chamber', name: 'Nuptial Chamber', unlock: 'chamber_nuptial_chamber',
    maxInst: 1, instBonus: [],
    w0: 5, h0: 3, grows: true, rowMin: 24, rowMax: 79, rule: 'nuptialShaft',
    place: { food: 20000 }, placeGrowth: 2.5,
    f0: 5000, s0: 1500, g: 2.00, levelExtra: null, maxL: 4, maxLBonus: { trait: 'royal_court', maxL: 9 }, frostImmune: false,
    fx: { cellsBase: 10, cellsPer: 5, cellsMax: 25, cellsMaxCourt: 50 },
  },
  deep_vault: {
    id: 'deep_vault', name: 'Deep Vault', unlock: 'chamber_deep_vault',
    maxInst: 1, instBonus: [],
    w0: 4, h0: 3, grows: true, rowMin: 58, rowMax: 79, rule: null,
    place: { food: 1e5 }, placeGrowth: 2.5,
    f0: 25000, s0: 15000, g: 2.50, levelExtra: null, maxL: 8, maxLBonus: null, frostImmune: false,
    fx: { offlineSec: 3600, alates: 0.05 },
  },
});

/**
 * Global chamber constants. seedBankMult (ach_seed_bank: granary capacity ×1.1) is a WP3 extension.
 */
export const CHAMBER_RULES = freeze({ instancePlaceGrowth: 2.5, instanceLevelGrowth: 2, frostMult: 0.5, aquiferMult: 1.2,
  seedBankMult: 1.1 });

/** Adjacency / proximity rule ids (overlay and tooltip order). */
export const ADJACENCY_ORDER = freeze(['adj_nursery_royal', 'adj_library_royal', 'adj_granary_repletion', 'adj_garden_well',
  'hyg_midden', 'prox_barracks_entrance']);

/**
 * Adjacency rules for the overlay and tooltips (DESIGN §7.7). a/b are chamber ids (b may list several ids, or be
 * 'entrance' for a shaft top); path = max path cells (numbers of the effect come from the chamber fx).
 */
export const ADJACENCY = freeze({
  adj_nursery_royal:      { id: 'adj_nursery_royal', a: 'nursery', b: 'royal_chamber', path: 4, text: '+15% brood speed' },
  adj_library_royal:      { id: 'adj_library_royal', a: 'scent_library', b: 'royal_chamber', path: 4, text: 'Scent Library ×1.10' },
  adj_granary_repletion:  { id: 'adj_granary_repletion', a: 'granary', b: 'repletion_hall', path: 4, text: 'Replete cap bonus ×1.25' },
  adj_garden_well:        { id: 'adj_garden_well', a: 'fungus_garden', b: 'water_well', path: 4, text: 'Garden +30%' },
  hyg_midden:             { id: 'hyg_midden', a: 'midden', b: ['nursery', 'fungus_garden'], path: 6, text: 'Hygiene −20%' },
  prox_barracks_entrance: { id: 'prox_barracks_entrance', a: 'barracks', b: 'entrance', path: 12, text: 'Instant deploy, +10% home AP' },
});
