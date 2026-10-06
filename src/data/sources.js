// Every surface source type: yields, capacities, stocks, spawn rules, season factors, hunt rewards.
// Owner: WP4. Contract: ARCHITECTURE §6.4 (numbers from DESIGN §8.4, §17.2, §18.2; §18 C7, C34, C35, C45).
//
// Entry shape: { id, name, job, y, cap, stock, spawn, season, hunt, fx } (+ capPerLevel / perRing / minEscorts where used).
//   job:    'forager' | 'herder' | 'leafcutter' | 'lycaenid' | null (null = not a trail target: hunted or raided)
//   y:      per-worker yields (first key = primary resource, second = secondary trace)
//   cap:    capacity c (aphid_colony: capPerLevel × level)
//   stock:  null = infinite; { base, sec, regrow, dynamic } → max = max(base, sec × gross food/s) (C34); regrow = fraction of max per s
//   spawn:  { mode: 'fixed' | 'random' | 'event' | 'research' | 'conquest', count, rMin, rMax, terrain, … }
//           random: { every, max, ttl, timer: key of s.run.surface.spawn, group, w } (group = shared timer/max, w = pick weight)
//   season: season_src factor per season id (s.run → d.season.srcId; 'neutral' means 1 for every source)
//   hunt:   prey / termite rewards (AP and cooldowns of the termite raid live in data/combat.js ACTIONS.termite)
//   cd (state): raid/hunt cooldown, written and counted down by WP5; WP4 never touches it.
// ARCH-R: DESIGN gives one prey spawn per 6 min for the three prey types; the type is a weighted pick (w 1 each) and at
// most one prey is alive at a time (it despawns after 5 min anyway). TERRAIN.log.fx 'prey ×2 within 2 hexes' is read as
// a ×2 spawn weight for prey on hexes within 2 of a fallen log.

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

const FLAT = { spring: 1, summer: 1, autumn: 1, winter: 1 };

/** Source ids in display / iteration order (DESIGN §8.4 plus termite_swarm, §18 C7). */
export const SOURCE_ORDER = deepFreeze(['crumb_scatter', 'seed_patch', 'flower_patch', 'dead_insect', 'leaf_plant', 'aphid_colony',
  'prey_caterpillar', 'prey_cricket', 'prey_beetle', 'fallen_fruit', 'picnic_spill', 'termite_mound', 'lycaenid_caterpillar',
  'harvester_stash', 'termite_swarm', 'rich_seed_patch', 'beetle_carcass']);

/** Source table keyed by id. */
export const SOURCES = deepFreeze({
  crumb_scatter: {
    id: 'crumb_scatter', name: 'Crumb scatter', job: 'forager',
    y: { food: 0.5 }, cap: 10, stock: null,
    spawn: { mode: 'fixed', count: 1, rMin: 1, rMax: 1, terrain: null },
    season: { ...FLAT }, hunt: null, fx: {},
  },
  seed_patch: {
    id: 'seed_patch', name: 'Seed patch', job: 'forager',
    y: { food: 0.5 }, cap: 15,
    stock: { base: 300, sec: 300, regrow: 0.01, dynamic: true },
    spawn: { mode: 'fixed', count: 3, rMin: 2, rMax: 5, terrain: null, firstAtMin: true },   // firstAtMin (extra): one patch at ring 2, seen at 0:00
    season: { spring: 1, summer: 1, autumn: 2, winter: 1 }, hunt: null, fx: {},
  },
  flower_patch: {
    id: 'flower_patch', name: 'Flower patch', job: 'forager',
    y: { food: 0.55, honeydew: 0.005 }, cap: 20, stock: null,
    spawn: { mode: 'fixed', count: 2, rMin: 3, rMax: 6, terrain: null },
    season: { spring: 1, summer: 1.5, autumn: 1, winter: 0 }, hunt: null, fx: {},
  },
  dead_insect: {
    id: 'dead_insect', name: 'Dead insect', job: 'forager',
    y: { food: 0.6, chitin: 0.01 }, cap: 20,
    stock: { base: 150, sec: 90, regrow: 0, dynamic: false },
    spawn: { mode: 'random', timer: 'insect', group: 'dead_insect', every: 180, max: 2, rMin: 3, rMax: 8, ttl: 360, w: 1, terrain: null },
    season: { ...FLAT }, hunt: null, fx: {},
  },
  leaf_plant: {
    id: 'leaf_plant', name: 'Leaf plant', job: 'leafcutter',
    y: { leaves: 0.3 }, cap: 20, stock: null,
    spawn: { mode: 'fixed', count: 4, rMin: 2, rMax: 8, terrain: 'leaf_litter' },
    season: { spring: 1.25, summer: 1.5, autumn: 1.25, winter: 0 }, hunt: null, fx: {},
  },
  aphid_colony: {
    id: 'aphid_colony', name: 'Aphid colony', job: 'herder',
    y: { honeydew: 0.08 }, cap: 8, capPerLevel: 8, stock: null,
    spawn: { mode: 'fixed', count: 3, rMin: 3, rMax: 7, terrain: 'tree_root' },
    season: { spring: 1.2, summer: 1, autumn: 0.75, winter: 0 }, hunt: null,
    fx: { levelSec: 360, herdFrac: 0.5, maxLevel: 3 },          // +1 level per 6 min while ≥ 50 % herded (max 3)
  },
  prey_caterpillar: {
    id: 'prey_caterpillar', name: 'Caterpillar', job: null,
    y: {}, cap: 0, stock: null,
    spawn: { mode: 'random', timer: 'prey', group: 'prey', every: 360, max: 1, rMin: 4, rMax: 10, ttl: 300, w: 1, terrain: null },
    season: { spring: 1, summer: 1, autumn: 1.5, winter: 1 },
    hunt: { apPerRing: 50, foodSec: 60, chitinPerRing: 15, chitinMult: 1 }, fx: {},
  },
  prey_cricket: {
    id: 'prey_cricket', name: 'Cricket', job: null,
    y: {}, cap: 0, stock: null,
    spawn: { mode: 'random', timer: 'prey', group: 'prey', every: 360, max: 1, rMin: 4, rMax: 10, ttl: 300, w: 1, terrain: null },
    season: { spring: 1, summer: 1, autumn: 1.5, winter: 1 },
    hunt: { apPerRing: 200, foodSec: 60, chitinPerRing: 15, chitinMult: 2 }, fx: {},
  },
  prey_beetle: {
    id: 'prey_beetle', name: 'Beetle', job: null,
    y: {}, cap: 0, stock: null,
    spawn: { mode: 'random', timer: 'prey', group: 'prey', every: 360, max: 1, rMin: 4, rMax: 10, ttl: 300, w: 1, terrain: null },
    season: { spring: 1, summer: 1, autumn: 1.5, winter: 1 },
    hunt: { apPerRing: 800, foodSec: 60, chitinPerRing: 15, chitinMult: 4 }, fx: {},
  },
  fallen_fruit: {
    id: 'fallen_fruit', name: 'Fallen fruit', job: 'forager',
    y: { food: 2 }, cap: 30,
    stock: { base: 500, sec: 180, regrow: 0, dynamic: false },
    spawn: { mode: 'event', rMin: 3, rMax: 6, terrain: null },
    season: { ...FLAT }, hunt: null,
    fx: { rotAfter: 240, rotPerSec: 0.01 },                     // after 4 min it rots at −1 % (of max) per s
  },
  picnic_spill: {
    id: 'picnic_spill', name: 'Picnic spill', job: 'forager',
    y: { food: 5 }, cap: 60,
    stock: { base: 2000, sec: 600, regrow: 0, dynamic: false },
    spawn: { mode: 'event', rMin: 6, rMax: 12, terrain: null },
    season: { ...FLAT }, hunt: null,
    fx: { contest: 0.7 },                                        // −30 % yield unless escorted (1 escort per 10 foragers)
  },
  termite_mound: {
    id: 'termite_mound', name: 'Termite mound', job: null,
    y: {}, cap: 0, stock: null,
    spawn: { mode: 'fixed', count: 1, rMin: 9, rMax: 12, terrain: null },   // visible once sun_compass widens the map
    season: { ...FLAT },
    hunt: { foodSec: 120, chitinPerRing: 50, chitinMult: 1 }, fx: {},
  },
  lycaenid_caterpillar: {
    id: 'lycaenid_caterpillar', name: 'Lycaenid caterpillar', job: 'lycaenid',
    y: { honeydew: 0.3 }, perRing: true, minEscorts: 5, cap: 0, stock: null,
    spawn: { mode: 'research', research: 'lycaenid_clients', countMin: 1, countMax: 2, rMin: 3, rMax: 6, terrain: null },
    season: { ...FLAT }, hunt: null, fx: {},
  },
  harvester_stash: {
    id: 'harvester_stash', name: 'Harvester stash', job: 'forager',
    y: { food: 2.5 }, cap: 20,
    stock: { base: 800, sec: 300, regrow: 0, dynamic: false },
    spawn: { mode: 'conquest', terrain: null },
    season: { ...FLAT }, hunt: null, fx: {},
  },
  termite_swarm: {
    id: 'termite_swarm', name: 'Termite swarm', job: 'forager',
    y: { food: 5, chitin: 0.05 }, cap: 30, stock: null,
    spawn: { mode: 'event', rMin: 2, rMax: 6, ttl: 45, terrain: null },   // ARCH-R: DESIGN gives no ring; 2–6 chosen
    season: { ...FLAT }, hunt: null, fx: {},
  },
  // C188: scout expedition finds (DESIGN §8.3), placed on the map's edge ring by surface.js (EXPEDITION in data/surface.js)
  rich_seed_patch: {
    id: 'rich_seed_patch', name: 'Rich seed patch', job: 'forager',
    y: { food: 1 }, cap: 20,
    stock: { base: 600, sec: 240, regrow: 0, dynamic: false },
    spawn: { mode: 'expedition', ttl: 300, terrain: null },
    season: { ...FLAT }, hunt: null, fx: {},
  },
  beetle_carcass: {
    id: 'beetle_carcass', name: 'Beetle carcass', job: 'forager',
    y: { food: 0.3, chitin: 0.05 }, cap: 20,
    stock: { base: 250, sec: 90, regrow: 0, dynamic: false },
    spawn: { mode: 'expedition', ttl: 300, terrain: null },
    season: { ...FLAT }, hunt: null, fx: {},
  },
});
