// Surface constants: map, terrain, scouting, trails, trail slots, pheromone abilities, territory and the mound.
// Owner: WP4. Contract: ARCHITECTURE §6.4 (numbers from DESIGN §8.1–§8.8, §11.1, §12.9, §19 achievement rewards).
// Keys beyond §6.4 (each marked "extra") hold WP4-implemented DESIGN numbers the contract table did not list.

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

/**
 * Map geometry (DESIGN §8.1, §8.3). sun_compass / regional_expansion radii live in research / federation `fx.radius`.
 * revealStart = rings revealed at run start (keen_antennae / boon_scouts_lead values live in their own fx).
 */
export const MAP = deepFreeze({ radiusBase: 8, zoomMin: 0.6, zoomMax: 2.75, revealStart: 2,   // zoomMax: C163 (was 1.6)
  rootRing: 3 });   // rootRing (extra): plants within this ring seed the nest's root lines (DESIGN §8.9 step 5, §7.9)

/** Terrain ids; the stored terrain code is the index in this array. */
export const TERRAIN_ORDER = deepFreeze(['grass', 'sand', 'leaf_litter', 'garden_path', 'tree_root', 'stone', 'puddle', 'log']);

/**
 * Terrain table (DESIGN §8.2). share = target map share; move = move cost (null = impassable);
 * springMove = move cost while the season blocks puddles (null = impassable in spring).
 * log.fx: prey ×2 (spawn weight) within preyRadius hexes.
 */
export const TERRAIN = deepFreeze({
  grass:       { id: 'grass',       name: 'Grass',       code: 0, share: 0.58,  move: 1 },
  sand:        { id: 'sand',        name: 'Sand',        code: 1, share: 0.08,  move: 1.25 },
  leaf_litter: { id: 'leaf_litter', name: 'Leaf litter', code: 2, share: 0.12,  move: 1.5 },
  garden_path: { id: 'garden_path', name: 'Garden path', code: 3, share: 0.04,  move: 0.5, strips: [1, 2] },  // strips: extra (1–2 strips)
  tree_root:   { id: 'tree_root',   name: 'Tree root',   code: 4, share: 0.04,  move: 1, cluster: [3, 7] },   // cluster: extra (hexes per cluster)
  stone:       { id: 'stone',       name: 'Stone',       code: 5, share: 0.06,  move: null },
  puddle:      { id: 'puddle',      name: 'Puddle',      code: 6, share: 0.06,  move: 1, springMove: null },
  log:         { id: 'log',         name: 'Fallen log',  code: 7, share: 0.005, move: 1, count: [0, 1], ringMin: 3, ringMax: 8,   // count/rings: extra
                 fx: { preyRadius: 2, prey: 2 } },
});

/**
 * Scouting (DESIGN §8.3). Hex cost = base × ring^exp scout-seconds; insight per revealed hex = insightPerRing × ring ×
 * stats.insight.scouting; scout force = jobs.scout^forceExp × multipliers; flagged hexes get flagPriority × priority.
 * cartographer (extra): ach_cartographer scouts ×1.5 (DESIGN §19).
 */
export const SCOUT = deepFreeze({ base: 10, exp: 1.2, insightPerRing: 0.75, forceExp: 0.6, flagPriority: 3, cartographer: 1.5 });

/**
 * C188: scout expeditions (DESIGN §8.3). Once no frontier hex is left inside the map radius, the scout force works
 * beyond the border at its scouting rate (scouts^0.6 × multipliers) and each `cost × growth^(finds this season)`
 * scout-seconds brings back a find on a free, revealed hex of the edge ring (ring = map radius), at most perSeason
 * per season. Offline the work banks up to one find (it is placed on return). Each find lasts `ttl` seconds.
 * finds: weighted pick. Sources (rich_seed_patch, beetle_carcass: data/sources.js) are trail targets; objects
 * (fossil_cache, lost_queen) are clicked once: fossil = max(insightMin, insightSec of insight income); lost queen =
 * lay ×layMult for laySec.
 */
export const EXPEDITION = deepFreeze({ cost: 240, growth: 2, perSeason: 2, ttl: 300,
  finds: [
    { id: 'rich_seed_patch', kind: 'source', w: 3 },
    { id: 'beetle_carcass', kind: 'source', w: 3 },
    { id: 'fossil_cache', kind: 'object', w: 2, insightSec: 120, insightMin: 40 },
    { id: 'lost_queen', kind: 'object', w: 1, layMult: 1.5, laySec: 120 },
  ] });

/**
 * Trails (DESIGN §8.5). Extras: achRise (ach_double_bridge strength rise ×1.1), achSMax (ach_highway S_max +5),
 * allocChunks (auto-fill chunks, ARCHITECTURE §8.3 "≤ 50 chunks").
 */
export const TRAIL = deepFreeze({ slope: 0.35, dNavBase: 3, sEqK: 15, tHalf: 45, sMax: 100, raidS: 30, cEffDiv: 100, cEffExp: 0.8,
  rivalHexPenalty: 0.05, escortPer: 10, widthMin: 1, widthMax: 6, overthinker: { n: 20, sec: 60 },
  achRise: 1.1, achSMax: 5, allocChunks: 50,
  sScale: 100 });   // sScale (extra): strength scale of S_eq = sScale·n/(n + sEqK·d) and of the (1 + S/sScale) yield term

/** Trail slots (DESIGN §8.5): base, +1 at each listed Mound level, +1 per outpost, +1 per satellite. Research slots live in research fx. */
export const SLOTS = deepFreeze({ base: 3, moundLevels: [3, 6, 9], outpost: 1, satellite: 1 });

/** Pheromone abilities (DESIGN §8.5). Rally's 60 s with mass_recruitment lives in RESEARCH.mass_recruitment.fx.rallySec. */
export const ABILITIES = deepFreeze({
  mark:         { id: 'mark', name: 'Mark', cost: { pheromone: 5 }, cd: 3, add: 25, unlock: 'ability_mark' },
  rally:        { id: 'rally', name: 'Rally', cost: { pheromone: 20 }, cd: 120, mult: 2, sec: 30, unlock: 'ability_rally' },
  frenzy:       { id: 'frenzy', name: 'Frenzy', cost: { pheromone: 60 }, cd: 120, mult: 2, sec: 20, unlock: 'ability_frenzy' },
  mass_recruit: { id: 'mass_recruit', name: 'Mass Recruit', cost: { pheromone: 20 }, frac: 0.5, unlock: 'ability_mark',
                  targets: ['termite_swarm', 'picnic_spill'] },   // targets (extra): the event sources it can be used on
});

/**
 * Territory (DESIGN §8.6). Claim cost = claimBase × claimGrowth^claims pheromone (× landGrabAch with ach_land_grab);
 * auto-claim radius = autoBase + floor(mound / autoPerMound) around every entrance; owned sources × ownedSource.
 * yieldPerHex / yieldMax are consumed by WP2 (A_add territory term); creepSec by WP5 (fire-ant creep).
 */
export const TERRITORY = deepFreeze({ claimBase: 10, claimGrowth: 1.06, autoBase: 1, autoPerMound: 5, yieldPerHex: 0.005, yieldMax: 1,
  ownedSource: 1.25, creepSec: 180, landGrabAch: 0.9 });

/**
 * Mound (DESIGN §8.7). Level L costs base × growth^(L−1) soil; levels above freeMax need mound_building.
 * homeAP → WP5, winterForage/winterMax → WP2, frostPerLevels/frostMax → WP6, shieldLevel → WP6, unlockSoil → WP6 unlocks.
 */
export const MOUND = deepFreeze({ base: 300, growth: 1.9, freeMax: 5, homeAP: 0.05, winterForage: 0.03, winterMax: 0.3,
  frostPerLevels: 3, frostMax: 6, shieldLevel: 5, unlockSoil: 300 });
