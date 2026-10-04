// Research data: the six branches, all 58 nodes (cost in insight, prerequisites, effect numbers), refinements and
// innate thresholds. Owner: WP5. Contract: ARCHITECTURE §6.5 (fx key table); DESIGN §11.1–§11.7.
// `tier` = row in the Research grid (0-based, by cost within the branch; a node never sits above its prerequisite).
// ARCH-R: warfare's formic_acid (250) is cheaper than its prerequisite polymorphism (300); it is placed one row
// below polymorphism (tier 1) instead of above it.

const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/** Branch order (grid columns). */
export const BRANCH_ORDER = f(['foraging', 'excavation', 'brood', 'husbandry', 'warfare', 'communication']);

/** Branches; `main` names the output each refinement level multiplies by REFINEMENT.mult (consumed by WP2 stats). */
export const BRANCHES = f({
  foraging: { id: 'foraging', name: 'Foraging', main: 'forage' },
  excavation: { id: 'excavation', name: 'Excavation', main: 'dig' },
  brood: { id: 'brood', name: 'Brood and Royalty', main: 'lay' },
  husbandry: { id: 'husbandry', name: 'Husbandry', main: 'honeydew+fungus' },
  warfare: { id: 'warfare', name: 'Warfare', main: 'ap' },
  communication: { id: 'communication', name: 'Communication and Climate', main: 'insight' },
});

/** Node helper: { id, name, branch, tier, cost, prereq, fx }. */
const n = (id, name, branch, tier, cost, prereq, fx = {}) => ({ id, name, branch, tier, cost, prereq, fx });

/** Every research node (DESIGN §11.1–§11.6; costs and prerequisites verbatim). */
export const RESEARCH = f({
  // ---- §11.1 Foraging ----
  trail_memory: n('trail_memory', 'Trail Memory', 'foraging', 0, 10, [], { forage: 1.25, slots: 1 }),
  scent_marking: n('scent_marking', 'Scent Marking', 'foraging', 1, 25, ['trail_memory']),
  tandem_running: n('tandem_running', 'Tandem Running', 'foraging', 2, 40, ['trail_memory'], { dNav: 1 }),
  recruitment_pheromones: n('recruitment_pheromones', 'Recruitment Pheromones', 'foraging', 3, 150, ['scent_marking'], { forage: 1.75 }),
  double_bridge: n('double_bridge', 'Double Bridge', 'foraging', 4, 300, ['tandem_running'], { dMult: 0.9, rise: 2 }),
  persistent_trails: n('persistent_trails', 'Persistent Trails', 'foraging', 5, 700, ['double_bridge'], { tHalf: 90, sMax: 150 }),
  sun_compass: n('sun_compass', 'Sun Compass', 'foraging', 6, 1000, ['recruitment_pheromones'], { radius: 12, slots: 2 }),
  mass_recruitment: n('mass_recruitment', 'Mass Recruitment', 'foraging', 7, 2500, ['sun_compass', 'persistent_trails'],
    { dNav: 2, rallySec: 60, slots: 2 }),
  frenzy_signal: n('frenzy_signal', 'Frenzy Signal', 'foraging', 8, 4000, ['mass_recruitment']),
  trunk_trails: n('trunk_trails', 'Trunk Trails', 'foraging', 9, 6000, ['mass_recruitment'], { minLen: 5, mult: 1.5, overlap: 0.25 }),
  odometer_navigation: n('odometer_navigation', 'Odometer Navigation', 'foraging', 10, 15000, ['trunk_trails'], { dNav: 3, slope: 0.5 }),

  // ---- §11.2 Excavation ----
  coordinated_digging: n('coordinated_digging', 'Coordinated Digging', 'excavation', 0, 15, [], { dig: 1.5 }),
  load_chains: n('load_chains', 'Load Chains', 'excavation', 1, 80, ['coordinated_digging'], { tunnel: 0.5, queue: 2 }),
  clay_masonry: n('clay_masonry', 'Clay Masonry', 'excavation', 2, 300, ['load_chains'], { clayWork: 7.2 }),
  mound_building: n('mound_building', 'Mound Building', 'excavation', 3, 400, ['coordinated_digging']),
  // C117: also unlocks draining and relocating water pockets (numbers: data/soilFeatures.js DRAINAGE).
  drainage: n('drainage', 'Drainage', 'excavation', 4, 800, ['clay_masonry'], { drought: 0.5 }),
  ventilation_shafts: n('ventilation_shafts', 'Ventilation Shafts', 'excavation', 5, 1200, ['clay_masonry'], { chamber: 1.10 }),
  thermoregulation: n('thermoregulation', 'Thermoregulation', 'excavation', 6, 2000, ['ventilation_shafts'], { frost: 5 }),
  gallery_arches: n('gallery_arches', 'Gallery Arches', 'excavation', 7, 3000, ['ventilation_shafts'], { galleries: 2, housing: 1.25 }),
  acid_excavation: n('acid_excavation', 'Acid Excavation', 'excavation', 8, 10000, ['gallery_arches'], { dig: 2, stone: 3 }),
  compact_galleries: n('compact_galleries', 'Compact Galleries', 'excavation', 9, 20000, ['acid_excavation'], { housing: 2 }),

  // ---- §11.3 Brood and Royalty ----
  brood_care: n('brood_care', 'Brood Care', 'brood', 0, 25, [], { broodTime: 0.75 }),
  age_polyethism: n('age_polyethism', 'Age Polyethism', 'brood', 1, 60, ['brood_care']),
  royal_pheromones: n('royal_pheromones', 'Royal Pheromones', 'brood', 2, 200, ['brood_care'], { lay: 1.5 }),
  trophic_eggs: n('trophic_eggs', 'Trophic Eggs', 'brood', 3, 500, ['royal_pheromones'], { eggCost: 0.7 }),
  thermal_brood_shuttling: n('thermal_brood_shuttling', 'Thermal Brood Shuttling', 'brood', 4, 600, ['brood_care']),
  nuptial_preparation: n('nuptial_preparation', 'Nuptial Preparation', 'brood', 5, 800, ['royal_pheromones']),
  response_thresholds: n('response_thresholds', 'Response Thresholds', 'brood', 6, 1200, ['age_polyethism']),
  living_larders: n('living_larders', 'Living Larders', 'brood', 7, 1500, ['trophic_eggs']),
  spermathecal_reserve: n('spermathecal_reserve', 'Spermathecal Reserve', 'brood', 8, 4000, ['nuptial_preparation'], { lay: 2 }),
  supermajors: n('supermajors', 'Supermajors', 'brood', 9, 5000, ['spermathecal_reserve', 'polymorphism']),

  // ---- §11.4 Husbandry ----
  aphid_husbandry: n('aphid_husbandry', 'Aphid Husbandry', 'husbandry', 0, 100, []),
  leafcutting: n('leafcutting', 'Leafcutting', 'husbandry', 1, 350, ['aphid_husbandry']),
  aphid_shepherding: n('aphid_shepherding', 'Aphid Shepherding', 'husbandry', 2, 700, ['aphid_husbandry'], { herderCap: 2 }),
  fungiculture: n('fungiculture', 'Fungiculture', 'husbandry', 3, 900, ['leafcutting']),
  lycaenid_clients: n('lycaenid_clients', 'Lycaenid Clients', 'husbandry', 4, 1200, ['aphid_shepherding']),
  // C118: grow your own root lines down into the nest (numbers: data/soilFeatures.js ROOT_CULT).
  root_cultivation: n('root_cultivation', 'Root Cultivation', 'husbandry', 5, 1500, ['aphid_husbandry']),
  sugar_economy: n('sugar_economy', 'Sugar Economy', 'husbandry', 6, 2000, ['aphid_shepherding'], { honeydew: 2 }),
  weeder_ants: n('weeder_ants', 'Weeder Ants', 'husbandry', 7, 3000, ['fungiculture'], { blight: 0.25, fungus: 1.5 }),
  fungal_symbiosis: n('fungal_symbiosis', 'Fungal Symbiosis', 'husbandry', 8, 6000, ['weeder_ants'], { phiCoef: 1.0 }),

  // ---- §11.5 Warfare ----
  polymorphism: n('polymorphism', 'Polymorphism', 'warfare', 0, 300, []),
  formic_acid: n('formic_acid', 'Formic Acid', 'warfare', 1, 250, ['polymorphism'], { atk: 1.3 }),
  ritual_tournaments: n('ritual_tournaments', 'Ritual Tournaments', 'warfare', 2, 400, ['polymorphism']),
  phalanx: n('phalanx', 'Phalanx', 'warfare', 3, 1000, ['formic_acid'], { escortAP: 1.5, retreatLoss: 0.1 }),
  field_triage: n('field_triage', 'Field Triage', 'warfare', 4, 1500, ['phalanx'], { frac: 0.3, sec: 60, nurses: 5 }),
  propaganda_pheromones: n('propaganda_pheromones', 'Propaganda Pheromones', 'warfare', 5, 3500, ['phalanx'], { enemyAP: 0.9, convert: 0.05 }),
  siege_tactics: n('siege_tactics', 'Siege Tactics', 'warfare', 6, 7000, ['propaganda_pheromones'], { home: 0.5 }),
  war_chemistry: n('war_chemistry', 'War Chemistry', 'warfare', 7, 12000, ['siege_tactics'], { ap: 2 }),

  // ---- §11.6 Communication and Climate ----
  antennation: n('antennation', 'Antennation', 'communication', 0, 30, [], { scout: 2, insightHex: 1.5 }),
  chemical_lexicon: n('chemical_lexicon', 'Chemical Lexicon', 'communication', 1, 120, ['antennation'], { library: 1.5 }),
  pheromone_glands: n('pheromone_glands', 'Pheromone Glands', 'communication', 2, 250, ['scent_marking'], { cap: 50, regen: 1.5 }),
  early_warning: n('early_warning', 'Early Warning', 'communication', 3, 400, ['antennation'], { warnSec: 30 }),
  seasonal_clock: n('seasonal_clock', 'Seasonal Clock', 'communication', 4, 600, ['antennation'], { winterR: 0.2 }),
  overwintering: n('overwintering', 'Overwintering', 'communication', 5, 900, ['seasonal_clock'], { winterUpkeep: 0.8 }),
  weather_sense: n('weather_sense', 'Weather Sense', 'communication', 6, 1500, ['seasonal_clock'], { warnSec: 30 }),
  collective_memory: n('collective_memory', 'Collective Memory', 'communication', 7, 1800, ['chemical_lexicon'],
    { insight: 2, offlineSec: 7200 }),
  diapause_logic: n('diapause_logic', 'Diapause Logic', 'communication', 8, 3000, ['overwintering'], { offlineEff: 0.25, winterUpkeep: 0.75 }),
  hive_mind: n('hive_mind', 'Hive Mind', 'communication', 9, 12000, ['collective_memory', 'response_thresholds'], { insight: 1.5 }),
});

/** All 58 node ids, branch by branch, in DESIGN order. */
export const RESEARCH_ORDER = f([
  'trail_memory', 'scent_marking', 'tandem_running', 'recruitment_pheromones', 'double_bridge', 'persistent_trails', 'sun_compass',
  'mass_recruitment', 'frenzy_signal', 'trunk_trails', 'odometer_navigation',
  'coordinated_digging', 'load_chains', 'clay_masonry', 'mound_building', 'drainage', 'ventilation_shafts', 'thermoregulation',
  'gallery_arches', 'acid_excavation', 'compact_galleries',
  'brood_care', 'age_polyethism', 'royal_pheromones', 'trophic_eggs', 'thermal_brood_shuttling', 'nuptial_preparation',
  'response_thresholds', 'living_larders', 'spermathecal_reserve', 'supermajors',
  'aphid_husbandry', 'leafcutting', 'aphid_shepherding', 'fungiculture', 'lycaenid_clients', 'root_cultivation', 'sugar_economy', 'weeder_ants',
  'fungal_symbiosis',
  'polymorphism', 'formic_acid', 'ritual_tournaments', 'phalanx', 'field_triage', 'propaganda_pheromones', 'siege_tactics',
  'war_chemistry',
  'antennation', 'chemical_lexicon', 'pheromone_glands', 'early_warning', 'seasonal_clock', 'overwintering', 'weather_sense',
  'collective_memory', 'diapause_logic', 'hive_mind',
]);

/** Refinements (DESIGN §11.7): `<branch>_refinement` level L costs base × growth^L insight; each level × mult main output. */
export const REFINEMENT = f({ base: 10000, growth: 2.5, mult: 1.10 });

/** Innate research (DESIGN §11.7): a node owned at the end of `runs` runs becomes Innate (runsAncestral with ancestral_memory). */
export const INNATE = f({ runs: 3, runsAncestral: 2 });
