// Prestige-layer constants: Flight / Supercolony / Speciation formulas, Lineage, passives, achievement bonuses,
// Hardships, landing sites, Founding Boons, Royal Edicts, reset bookkeeping and Founding Stores.
// Owner: WP7. Contract: ARCHITECTURE §6.7 (numbers from DESIGN §13–§16, §19, §25.8).

/**
 * Deep-freeze a plain object/array tree (local helper; data modules import nothing from core).
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

/** Nuptial Flight (DESIGN §13.1, §13.2): alates = floor(SC(base × (fRun/div)^exp × (1 + tPeak/tPeakDiv) × (1 + rearedPer × reared) × …)).
 *  fRunMin (the Flight gate, 1.85e8 → 13 alates; ARCHITECTURE §18 C97, raised in feedback pass 7) is above div (the formula anchor, 1e8 → 10). */
export const FLIGHT = deepFreeze({
  fRunMin: 1.85e8, base: 10, div: 1e8, exp: 0.5, tPeakDiv: 400, rearedPer: 0.02, rearedMax: 25, rearedMaxCourt: 50,
  royalLevel: 5, tabFRun: 2e7, peakGlow: 0.97, ceremonySprites: 120,
});

/** Lineage Λ (DESIGN §13.3): a ≤ knee ? 1 + per × a : high × √(a / knee) (continuous at a = knee: 6). */
export const LINEAGE = deepFreeze({ per: 0.05, knee: 100, high: 6 });

/** Lay rate takes Λ^LINEAGE_LAY_EXP (DESIGN §13.3 "×Λ^0.25 to lay rate", §12.4). */
export const LINEAGE_LAY_EXP = 0.25;

/** Supercolony (DESIGN §14.1, §14.2): kinship = floor(SC(mult × (alatesCycle / div)^exp)). */
export const SUPER = deepFreeze({ alatesMin: 5000, mult: 2, div: 1000, exp: 0.35, teaserAlates: 1000 });

/** Speciation (DESIGN §15.1, §15.2): genes = floor(SC(mult × (kinshipLife / div)^exp)) = floor(SC(kinship_era / 50)); the gate 1,000 → 20. */
export const SPEC = deepFreeze({ kinshipMin: 1000, mult: 1, div: 50, exp: 1, teaserKinship: 20 });

/** Passive exponents on (1 + K) and (1 + G) (DESIGN §14.3, §15.3). */
export const PASSIVE = deepFreeze({ kFood: 1.25, kOther: 0.5, kAlates: 0.25, kScale: 0.2, gFood: 1.5, gOther: 0.25, gAP: 1 });

/** Global achievement bonus per achievement (DESIGN §19; ×1.02 with fossil_record). */
export const ACH_BONUS = deepFreeze({ per: 1.01, perFossil: 1.02 });

/**
 * Achievement extra rewards implemented by WP7 (ARCHITECTURE §12.5): `all` multiplies every d.meta.prestige
 * production channel (ach_wilsons_pride +3 %); `alates` multiplies flight alates (DESIGN §13.2 A_bonus).
 */
export const ACH_META = deepFreeze({
  ach_wilsons_pride: { all: 1.03 },
  ach_swift_swarm: { alates: 1.1 },
  ach_gentle_giants: { alates: 1.05 },
  ach_flying_ant_day: { alates: 1.05 },
});

/** Hardships (DESIGN §13.8): goal(t) = goalBase × goalGrowth^(t−1); rewards carried at `carry` through a Supercolony. */
export const HARDSHIP = deepFreeze({ unlockAlates: 150, goalBase: 1e9, goalGrowth: 100, tiers: 5, carry: 0.5 });

/** Hardship display / iteration order. */
export const HARDSHIP_ORDER = deepFreeze(['eternal_winter', 'claustral_founding', 'pacifist', 'barren_ground', 'shallow_soil', 'monomorphic']);

/** Hardships: constraint consumers per ARCHITECTURE §8.6; `fx` = reward per tier (§12.4). */
export const HARDSHIPS = deepFreeze({
  eternal_winter: { id: 'eternal_winter', name: 'Eternal Winter', fx: { winterR: 0.10 } },
  claustral_founding: { id: 'claustral_founding', name: 'Claustral Founding', fx: { lay: 1.3 } },
  pacifist: { id: 'pacifist', name: 'Pacifist', fx: { aggro: 0.08, tourney: 0.05 } },
  barren_ground: { id: 'barren_ground', name: 'Barren Ground', fx: { yield: 0.5, slope: 0.05 } },
  shallow_soil: { id: 'shallow_soil', name: 'Shallow Soil', fx: { maxRow: 23, work: 0.05 } },
  monomorphic: { id: 'monomorphic', name: 'Monomorphic', fx: { adaptCap: 10, worker: 1.3 } },
});

/** Landing-site tag display / draw order. */
export const SITE_ORDER = deepFreeze(['site_rich_loam', 'site_seed_meadow', 'site_aphid_dense', 'site_hostile_neighbours',
  'site_stony_ground', 'site_garden_path', 'site_wet_hollow', 'site_sunny_slope']);

/** Landing-site tags (DESIGN §13.6). Consumers per ARCHITECTURE §12.4. */
export const SITES = deepFreeze({
  site_rich_loam: { id: 'site_rich_loam', name: 'Rich Loam', fx: { work: 0.8 } },
  site_seed_meadow: { id: 'site_seed_meadow', name: 'Seed Meadow', fx: { seedAdd: 2, autumnSeed: 2.5 } },
  site_aphid_dense: { id: 'site_aphid_dense', name: 'Aphid-Dense', fx: { aphidAdd: 2 } },
  site_hostile_neighbours: { id: 'site_hostile_neighbours', name: 'Hostile Neighbours', fx: { tiers: [2, 3], conquest: 1.5 } },
  site_stony_ground: { id: 'site_stony_ground', name: 'Stony Ground', fx: {} },
  site_garden_path: { id: 'site_garden_path', name: 'Garden Path', fx: { paths: 2 } },
  site_wet_hollow: { id: 'site_wet_hollow', name: 'Wet Hollow', fx: { puddles: 2, fungus: 1.2 } },
  site_sunny_slope: { id: 'site_sunny_slope', name: 'Sunny Slope', fx: {} },
});

/** Founding Boon display / draw order. */
export const BOON_ORDER = deepFreeze(['boon_next_to_aphids', 'boon_rich_prey', 'boon_peaceful_start', 'boon_royal_vigor',
  'boon_scouts_lead', 'boon_old_trails', 'boon_chitin_hoard', 'boon_blueprint_rush', 'boon_long_spring', 'boon_insight_cache']);

/** Founding Boons (DESIGN §13.6). Consumers per ARCHITECTURE §12.4. */
export const BOONS = deepFreeze({
  boon_next_to_aphids: { id: 'boon_next_to_aphids', name: 'Next to Aphids', fx: { ring: 2 } },
  boon_rich_prey: { id: 'boon_rich_prey', name: 'Rich Prey', fx: { every: 120, until: 600, ring: 2 } },
  boon_peaceful_start: { id: 'boon_peaceful_start', name: 'Peaceful Start', fx: { sec: 1200 } },
  boon_royal_vigor: { id: 'boon_royal_vigor', name: 'Royal Vigor', fx: { lay: 2, sec: 600 } },
  boon_scouts_lead: { id: 'boon_scouts_lead', name: "Scout's Lead", fx: { reveal: 3 } },
  boon_old_trails: { id: 'boon_old_trails', name: 'Old Trails', fx: { trails: 2 } },
  boon_chitin_hoard: { id: 'boon_chitin_hoard', name: 'Chitin Hoard', fx: { chitin: 50 } },
  boon_blueprint_rush: { id: 'boon_blueprint_rush', name: 'Blueprint Rush', fx: { mult: 2, sec: 600 } },
  boon_long_spring: { id: 'boon_long_spring', name: 'Long Spring', fx: { sec: 180 } },
  boon_insight_cache: { id: 'boon_insight_cache', name: 'Insight Cache', fx: { insight: 100 } },
});

/** Royal Edict display order. */
export const EDICT_ORDER = deepFreeze(['edict_of_plenty', 'edict_of_war', 'edict_of_depth', 'edict_of_long_summer']);

/** Royal Edicts (DESIGN §14.6). Consumers per ARCHITECTURE §12.4. */
export const EDICTS = deepFreeze({
  edict_of_plenty: { id: 'edict_of_plenty', name: 'Edict of Plenty', fx: { forage: 2, ap: 0.75 } },
  edict_of_war: { id: 'edict_of_war', name: 'Edict of War', fx: { ap: 2, conquest: 1.5, forage: 0.9 } },
  edict_of_depth: { id: 'edict_of_depth', name: 'Edict of Depth', fx: { dig: 3, chamberCost: 0.5 } },
  edict_of_long_summer: { id: 'edict_of_long_summer', name: 'Edict of Long Summer', fx: {} },
});

/**
 * C147: landing tags and Founding Boons that do nothing (or only harm) under a Hardship, left out of that landing's
 * draw: Eternal Winter never has spring, summer or autumn (Seed Meadow's autumn bonus, Sunny Slope's autumn nursery /
 * summer shade, Long Spring); Pacifist raises no soldiers, so Hostile Neighbours only adds danger (no conquests).
 */
export const LANDING_USELESS = deepFreeze({
  eternal_winter: { sites: ['site_seed_meadow', 'site_sunny_slope'], boons: ['boon_long_spring'] },
  pacifist: { sites: ['site_hostile_neighbours'], boons: [] },
});

/** Landing chooser: options per flight, tags per option, boons offered. */
export const LANDING = deepFreeze({ options: 3, tagsMin: 1, tagsMax: 2, boons: 3 });

/** Reset bookkeeping: brood bank, strata and daughter caps, census per satellite, ending census (DESIGN §13.4, §14.6, §15.7, §25.8). */
export const RESET = deepFreeze({ broodBankFrac: 0.1, broodBankMax: 1000, strataMax: 12, daughtersMax: 8, censusPerSatellite: 0.25,
  endingCensus: 2e16 });

/** Founding Stores by trait level (DESIGN §13.7): food / soil written directly into run.res at run start (C43). */
export const FOUNDING_STORES = deepFreeze([null, { food: 500, soil: 100 }, { food: 5000, soil: 1000 }, { food: 50000, soil: 10000 }]);

/** Automation cadence (ARCHITECTURE §8.6 "1 Hz"): passes per run second, and a bound on passes per (offline) tick. */
export const AUTOMATION = deepFreeze({ passSec: 1, maxPassesPerTick: 60 });

/**
 * Auto-Flight 'peak' trigger (C166): the run must be at least `minSec` old, and the weather-free alates/min (the
 * unfloored projection without the seasonal / Flight Day weather factor, so a season change never trips it) must stay
 * below `drop` × this run's best weather-free rate for `holdSec` seconds in a row.
 */
export const AUTO_FLIGHT = deepFreeze({ minSec: 480, holdSec: 30, drop: 0.97 });

/**
 * Auto-Flight landing pick (C166): every landing option scores the sum of its tags' `sites` points (+ `seasonSites` for
 * the season the run starts in), every boon its `boons` points (+ `seasonBoons`), plus the situational bonuses below;
 * the highest score wins (ties: the first offered). `season` = the starting season auto-flight picks with Seasonal
 * Wisdom. The points favour early growth: lay rate, food sources, insight.
 */
export const AUTO_LANDING = deepFreeze({
  sites: { site_rich_loam: 3, site_seed_meadow: 2, site_aphid_dense: 3, site_hostile_neighbours: -1, site_stony_ground: 1,
    site_garden_path: 1, site_wet_hollow: 1, site_sunny_slope: 1 },
  seasonSites: { summer: { site_seed_meadow: 2, site_sunny_slope: 1 }, autumn: { site_seed_meadow: 3, site_sunny_slope: 1 } },
  boons: { boon_royal_vigor: 5, boon_next_to_aphids: 4, boon_rich_prey: 3, boon_old_trails: 3, boon_insight_cache: 3,
    boon_scouts_lead: 2, boon_peaceful_start: 2, boon_long_spring: 1, boon_chitin_hoard: 1, boon_blueprint_rush: 1 },
  seasonBoons: { spring: { boon_long_spring: 3 } },
  blueprintRush: 5,        // added to boon_blueprint_rush while a blueprint is active
  pacifistPeace: 2,        // added to boon_peaceful_start in a Pacifist run (no soldiers to defend)
  rememberedOldTrails: -2, // added to boon_old_trails with Remembered Paths (trails are drawn anyway)
  keenScouts: -2,          // added to boon_scouts_lead with Keen Antennae (rings 0–4 are revealed anyway)
  season: 'spring',
});
