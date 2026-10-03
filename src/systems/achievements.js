// Achievement checks and progress, the Next Goals tracker (d.progress.goals). Grants write meta.achievements[id] =
// simTime, add the achievement's cosmetic to meta.cosmetics.owned and emit `achievement {id}`.
// Owner: WP6. Contract: ARCHITECTURE §8.5 (achievements.js), §12.5, DESIGN §19, §25.6 rule 9.
// Checks run every sim second and on any tick that emitted events; duration timers (hoarder, highway, mutualist) run
// every tick in d.progress._timers (not saved: they restart after a reload, as the contract allows).
// Private, unsaved bookkeeping lives in d.progress._ach (flight snapshot, winter watch, trail lengths, raid targets,
// hunt targets). The step does not run achievements while the landing chooser is open, so the run-end achievements
// (swift swarm, gentle giants, peak timing, flying ant day, pacifist flight, sky full of wings) compare a snapshot of the
// last tick before the Flight with the counters after it (meta.counters.flights increased).
// ARCH-R: "outnumbered" = start.you < start.foe (battleEnd units at start); "a trail ≥ N hexes" = path.length − 1;
//   ach_cartographer = every hex inside the CURRENT map radius revealed; "at cap" (hoarder, seed bank, C33) uses the
//   bottleneck's food ≥ 99 % of cap, since upkeep keeps stored food a hair below the exact cap every tick;
//   ach_highway = one trail with S ≥ 99 % of S_max for 5 min; ach_wilsons_pride counts alates (≥ 1 reared) as a caste.
// ARCH-R: a Flight whose landing is chosen after a reload (d rebuilt in between) loses the pre-flight snapshot, so the
//   snapshot-based Flight achievements cannot be judged for that one Flight (ach_sky_full_of_wings also has a
//   cycle.daughters fallback).

import { ACH_ORDER, ACHIEVEMENTS, ACH_PARAMS, ACH_REQ } from '../data/achievements.js';
import { RESEARCH, RESEARCH_ORDER } from '../data/research.js';
import { TRAIL } from '../data/surface.js';
import { BOTTLENECK } from '../data/economy.js';
import { GRID } from '../data/balance.js';
import { adultsTotal } from '../core/state.js';
import { hasEffect, effectMult } from '../core/effects.js';
import { countInRadius } from '../core/hex.js';

/** Finite number or 0. */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** Own-key check (values may legitimately be 0). */
function has(map, id) {
  return !!map && Object.prototype.hasOwnProperty.call(map, id);
}

/** True if the achievement is earned. */
function earned(s, id) {
  return has(s.meta.achievements, id);
}

/** Private bookkeeping in d.progress (created on demand; never saved). */
function priv(d) {
  if (!d.progress) d.progress = { nextUnlock: null, goals: [], _timers: {} };
  if (!d.progress._timers) d.progress._timers = {};
  if (!d.progress._ach) {
    d.progress._ach = { sec: null, flights: null, snap: null, winter: { prev: null, track: false, hungry: false, run: -1 },
      run: null, trails: {}, raids: {}, hunts: {}, dugRow: 0, offRef: null, offIdx: 0 };
  }
  return d.progress._ach;
}

// ------------------------------------------------------------------------------------------------------------------
// State readers
// ------------------------------------------------------------------------------------------------------------------

/** DESIGN census (d.meta.census from WP7; never below the live adult count). */
function census(s, d) {
  return Math.max(num(d && d.meta ? d.meta.census : 0), adultsTotal(s));
}

/** Food at its cap (bottleneck rule: ≥ capFrac × cap). */
function atCap(s, d) {
  const cap = d && d.stats ? num(d.stats.foodCap) : 0;
  return cap > 0 && num(s.run.res.food) >= cap * BOTTLENECK.capFrac;
}

/** Live (active or growing) chambers, optionally of one type. */
function liveChambers(s, type = null) {
  return s.run.nest.chambers.filter((c) => (c.status === 'active' || c.status === 'growing') && (!type || c.type === type));
}

/** Highest level among live chambers of a type. */
function maxLevel(s, type) {
  let m = 0;
  for (const c of liveChambers(s, type)) m = Math.max(m, num(c.level));
  return m;
}

/** Hexes walked by a trail (path.length − 1). */
function trailHexes(t) {
  return Array.isArray(t.path) ? Math.max(0, t.path.length - 1) : 0;
}

/** Longest trail of the run (hexes). */
function longestTrail(s) {
  let m = 0;
  for (const t of s.run.surface.trails) m = Math.max(m, trailHexes(t));
  return m;
}

/** d.surface.trails entry of a trail. */
function dTrail(d, uid) {
  const list = d && d.surface && Array.isArray(d.surface.trails) ? d.surface.trails : [];
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].uid === uid) return list[i];
  return null;
}

/** Effective workers of a trail. */
function workersOf(d, t) {
  const e = dTrail(d, t.uid);
  return e ? num(e.workers) : num(t.workers);
}

/** Source by uid. */
function findSrc(s, uid) {
  for (const x of s.run.surface.sources) if (x.uid === uid) return x;
  return null;
}

/** Number of distinct aphid colonies herded right now. */
function herdedCount(s, d) {
  const set = new Set();
  for (const t of s.run.surface.trails) {
    if (t.job !== 'herder') continue;
    const src = findSrc(s, t.src);
    if (src && src.type === 'aphid_colony' && workersOf(d, t) > 0) set.add(src.uid);
  }
  return set.size;
}

/** A Lycaenid caterpillar is being milked (its trail pays). */
function lycaenidMilked(s, d) {
  for (const t of s.run.surface.trails) {
    if (t.job !== 'lycaenid') continue;
    const e = dTrail(d, t.uid);
    if (e && num(e.out) > 0) return true;
  }
  return false;
}

/** Trail S_max (persistent_trails raises it). */
function sMax(s) {
  if (s.run.research && s.run.research.persistent_trails) {
    const r = RESEARCH && RESEARCH.persistent_trails;
    const v = r && r.fx ? r.fx.sMax : undefined;
    if (Number.isFinite(v)) return v;
  }
  return TRAIL.sMax;
}

/** Every hex inside the current radius is revealed. */
function mapRevealed(s) {
  const R = Number.isFinite(s.run.surface.radius) ? Math.max(0, Math.min(16, Math.floor(s.run.surface.radius))) : 8;
  const n = countInRadius(R);
  const rev = s.run.surface.revealed;
  for (let i = 0; i < n; i++) if (rev[i] !== 1) return false;
  return true;
}

/** Deepest dug row known (WP3's lifetime record, or a dug cell seen by this module). */
function deepest(s, d) {
  const P = d && d.progress && d.progress._ach ? d.progress._ach : null;
  return Math.max(num(s.meta.stats.deepestRow), P ? num(P.dugRow) : 0);
}

/** Best tier of a Hardship (this cycle or this era). */
function hardshipBest(s, id) {
  return Math.max(num(s.cycle.hardshipTier ? s.cycle.hardshipTier[id] : 0), num(s.era.hardshipBest ? s.era.hardshipBest[id] : 0));
}

/** Count of own keys. */
function count(map) {
  return map ? Object.keys(map).length : 0;
}

/** A trail was rerouted N times within the overthinker window. */
function overthought(s) {
  const o = TRAIL.overthinker;
  for (const t of s.run.surface.trails) {
    const r = Array.isArray(t.reroutes) ? t.reroutes : [];
    if (r.length >= o.n && num(r[r.length - 1]) - num(r[r.length - o.n]) <= o.sec) return true;
  }
  return false;
}

/** Every caste present and every job staffed. */
function wilson(s) {
  const a = s.run.colony.adults;
  for (const c of ACH_REQ.castes) {
    if (c === 'alate') {
      if (!(num(s.run.colony.alatesReared) >= 1)) return false;
    } else if (!(num(a[c]) >= 1)) return false;
  }
  for (const j of ACH_REQ.jobs) if (!(num(s.run.colony.jobs[j]) >= 1)) return false;
  return true;
}

/** Every Front nest of this run is down (or WP7's requirement flag says so). */
function frontDown(s, d) {
  if (d && d.meta && d.meta.proj && d.meta.proj.spec && d.meta.proj.spec.front === true) return true;
  const front = s.run.rivals.list.filter((r) => r && r.type === 'great_rival');
  return front.length > 0 && front.every((r) => !r.alive);
}

// ------------------------------------------------------------------------------------------------------------------
// Check table
// ------------------------------------------------------------------------------------------------------------------

/** Current value of every numeric achievement (compared with its target). */
const CUR = {
  ach_first_brood: (s) => num(s.run.stats.hatched),
  ach_hundred_mandibles: (s) => adultsTotal(s),
  ach_thousand_strong: (s) => adultsTotal(s),
  ach_ten_thousand: (s) => adultsTotal(s),
  ach_myriad: (s, d) => census(s, d),
  ach_billion_backs: (s, d) => census(s, d),
  ach_six_trillion_legs: (s, d) => census(s, d),
  ach_twenty_quadrillion: (s, d) => census(s, d),
  ach_clickstorm: (s) => num(s.meta.counters.clicks),
  ach_hoarder: (s, d) => num(d.progress && d.progress._timers ? d.progress._timers.ach_hoarder : 0),
  ach_feast: (s) => num(s.run.fRun),
  ach_ten_million: (s) => num(s.run.fRun),
  ach_billion_bites: (s) => num(s.run.fRun),
  ach_trillion_tonnes: (s) => num(s.run.fRun),
  ach_into_the_clay: (s, d) => deepest(s, d),
  ach_gravel_pit: (s, d) => deepest(s, d),
  ach_bedrock_bound: (s, d) => deepest(s, d),
  ach_wellspring: (s, d) => deepest(s, d),
  ach_master_digger: (s) => num(s.meta.counters.cellsDug),
  ach_treasure_hunter: (s) => num(s.meta.counters.caches),
  ach_amber_finder: (s) => num(s.meta.counters.amber),
  ach_ant_farm: (s) => liveChambers(s).length,
  ach_grand_gallery: (s) => maxLevel(s, 'gallery'),
  ach_clean_house: (s) => num(s.meta.counters.moldScraped),
  ach_living_larder: (s) => num(s.run.colony.adults.replete),
  ach_architect: (s) => num(s.meta.counters.relocations),
  ach_royal_ascent: (s) => maxLevel(s, 'royal_chamber'),
  ach_pathfinder: (s) => longestTrail(s),
  ach_highway: (s, d) => {
    let m = 0;
    const T = d.progress && d.progress._timers ? d.progress._timers : {};
    for (const k of Object.keys(T)) if (k.startsWith('ach_highway:')) m = Math.max(m, num(T[k]));
    return m;
  },
  ach_land_grab: (s, d) => Math.max(num(d && d.surface ? d.surface.ownedCount : 0), num(s.run.tPeak)),
  ach_shepherd: (s, d) => herdedCount(s, d),
  ach_mutualist: (s, d) => num(d.progress && d.progress._timers ? d.progress._timers.ach_mutualist : 0),
  ach_border_dispute: (s) => num(s.meta.counters.battlesWon),
  ach_total_war: (s) => num(s.run.stats.conquests),
  ach_ritualist: (s) => num(s.meta.counters.tournamentsWon),
  ach_first_winter: (s) => num(s.meta.season.year),
  ach_seasoned: (s) => num(s.meta.season.year),
  ach_golden_touch: (s) => num(s.meta.counters.beetles),
  ach_beetle_collector: (s) => num(s.meta.counters.beetles),
  ach_rain_dancer: (s) => num(s.meta.counters.rainstorms),
  ach_mole_friend: (s) => num(s.meta.counters.moleTunnels),
  ach_first_flight: (s) => num(s.meta.counters.flights),
  ach_thousand_queens: (s) => num(s.meta.counters.alatesLife),
  ach_hardship_tier: (s) => {
    let m = 0;
    for (const id of ACH_REQ.hardships) m = Math.max(m, hardshipBest(s, id));
    for (const v of Object.values(s.cycle.hardshipTier || {})) m = Math.max(m, num(v));
    return m;
  },
  ach_hardship_master: (s) => {
    let t = 0;
    for (const id of ACH_REQ.hardships) t += Math.min(ACH_PARAMS.hardshipTier, hardshipBest(s, id));
    return t;
  },
  ach_one_family: (s) => num(s.meta.counters.supercolonies),
  ach_living_fossil: (s) => num(s.meta.counters.speciations),
  ach_queens_favorite: (s) => num(s.meta.counters.queenClicks),
  ach_pheromone_picasso: (s) => Math.max(longestTrail(s), num(s.meta.stats.longestTrail)),
  ach_lady_luck: (s) => num(s.meta.counters.ladybugs),
  ach_naturalist: (s) => count(s.meta.fieldGuide),
  ach_field_guide_complete: (s) => count(s.meta.fieldGuide),
};

/** State conditions of the non-numeric achievements. */
const TEST = {
  ach_diminishing_returns: (s, d) => !!(d && d.rates && Object.values(d.rates).some((r) => r && r.sc === true)),
  ach_royal_neighbours: (s, d) => !!(d && d.nest && d.nest.agg && d.nest.agg.adjNurseryRoyal),
  ach_seed_bank: (s, d) => {
    if (!atCap(s, d)) return false;
    const dch = d && d.nest && Array.isArray(d.nest.chambers) ? d.nest.chambers : [];
    const chs = s.run.nest.chambers;
    for (let i = 0; i < chs.length; i++) {
      const c = chs[i];
      if (c.type !== 'granary' || !(c.status === 'active' || c.status === 'growing')) continue;
      const e = dch[i] && dch[i].uid === c.uid ? dch[i] : dch.find((x) => x && x.uid === c.uid);
      if (e && e.layer === 'gravel') return true;
    }
    return false;
  },
  ach_cartographer: (s) => mapRevealed(s),
  ach_front_broken: (s, d) => frontDown(s, d),
  ach_sky_full_of_wings: (s) => (s.cycle.daughters || []).some((x) => x && num(x.alates) >= ACH_PARAMS.flightAlates),
  ach_swift_swarm: (s) => {
    const f = num(s.meta.stats.fastestFlightSec);
    return f > 0 && f <= ACH_PARAMS.swiftSec;
  },
  ach_sociobiologist: (s) => RESEARCH_ORDER.length > 0 && RESEARCH_ORDER.every((id) => s.run.research && s.run.research[id]),
  ach_overthinker: (s) => overthought(s),
  ach_wilsons_pride: (s) => wilson(s),
};

/** Event conditions: (e, s, d, P) → boolean, checked for every event of this tick. */
const EV = {
  ach_first_brood: (e) => e.type === 'hatched' && num(e.n) > 0,
  ach_first_crumb: (e) => e.type === 'clicked',
  ach_diminishing_returns: (e) => e.type === 'softcapHit',
  ach_going_under: (e) => e.type === 'cellDug' && Math.floor(num(e.i) / GRID.cols) >= ACH_PARAMS.goingUnderRow,
  ach_square_law: (e) => e.type === 'battleEnd' && e.win === true && !!e.start && num(e.start.you) < num(e.start.foe),
  ach_flawless: (e) => {
    if (e.type !== 'battleEnd' || e.kind !== 'assault' || e.win !== true || !e.start || !(num(e.start.you) > 0)) return false;
    const l = e.lost || {};
    return num(l.soldier) + num(l.supermajor) + num(l.militia) < ACH_PARAMS.flawlessLoss * num(e.start.you);
  },
  ach_david_and_goliath: (e) => e.type === 'battleEnd' && e.win === true && typeof e.odds === 'number' && e.odds < ACH_PARAMS.underdogOdds,
  ach_pavement_is_ours: (e, s) => e.type === 'conquest' && conquestType(e, s) === 'pavement_ants',
  ach_old_ridge_falls: (e, s) => e.type === 'conquest' && conquestType(e, s) === 'old_ridge_supercolony',
  ach_front_broken: (e, s, d) => e.type === 'conquest' && conquestType(e, s) === 'great_rival' && frontDown(s, d),
  ach_phragmosis: (e, s, d, P) => e.type === 'raidResult' && e.win === true && num(e.broodLost) === 0 && P.raids[e.uid] === 'nest',
  ach_big_game: (e, s, d, P) => e.type === 'battleEnd' && e.kind === 'hunt' && e.win === true &&
    (e.tag === 'prey_beetle' || P.hunts[e.uid] === 'prey_beetle'),
  ach_the_large_blue: (e) => e.type === 'eventResolved' && e.id === 'ev_phengaris_caterpillar' && e.choice === 'butterfly',
  ach_zombie_averted: (e) => e.type === 'eventResolved' && e.id === 'ev_ophiocordyceps' && (e.choice === 'quarantine' || e.choice === 'averted'),
  ach_peach_fuzz: (e) => e.type === 'eventResolved' && e.id === 'ev_fallen_fruit' && e.choice === 'harvested',
  ach_picnic_crasher: (e) => e.type === 'eventResolved' && e.id === 'ev_picnic_spill' && e.choice === 'harvested',
  ach_hardship_tier: (e) => e.type === 'hardshipTier' && num(e.tier) >= 1,
};

/**
 * The rival type of a conquest event: the §10 `rivalType` payload key, else looked up by uid (conquered rivals stay in
 * the list with alive = false).
 */
function conquestType(e, s) {
  if (typeof e.rivalType === 'string') return e.rivalType;
  const r = s.run.rivals.list.find((x) => x && x.uid === e.uid);
  return r ? r.type : null;
}

const EV_IDS = Object.keys(EV);

/** Achievements checked by dedicated routines in tick (timers, Flight snapshot, winter watch, reroutes, dug cells). */
const SPECIAL = new Set(['ach_hoarder', 'ach_highway', 'ach_mutualist', 'ach_swift_swarm', 'ach_gentle_giants', 'ach_peak_timing',
  'ach_sky_full_of_wings', 'ach_pacifist_flight', 'ach_flying_ant_day', 'ach_survivor', 'ach_double_bridge', 'ach_going_under']);

/**
 * True if the achievement has a check in this module (tests and tooling; not part of the §8.5 contract).
 * @param {string} id
 * @returns {boolean}
 */
export function hasCheck(id) {
  return has(CUR, id) || has(TEST, id) || has(EV, id) || SPECIAL.has(id);
}

// ------------------------------------------------------------------------------------------------------------------
// Grant, progress, goals
// ------------------------------------------------------------------------------------------------------------------

/**
 * Grant an achievement once: meta.achievements[id] = simTime, cosmetic owned, emit `achievement {id}`.
 * @returns {boolean} true if newly granted
 */
function grantAch(s, id, env) {
  const def = ACHIEVEMENTS[id];
  if (!def || earned(s, id)) return false;
  s.meta.achievements[id] = num(s.meta.simTime);
  if (def.cosmetic) s.meta.cosmetics.owned[def.cosmetic] = true;
  if (env && typeof env.emit === 'function') env.emit('achievement', { id });
  return true;
}

/**
 * [q] Progress toward a numeric achievement: { cur, target } with cur clamped to [0, target] (cur = target once
 * earned); null for one-off deeds (target null) and unknown ids.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} id
 * @returns {{ cur: number, target: number } | null}
 */
export function progress(s, d, id) {
  const def = ACHIEVEMENTS[id];
  if (!def || def.target === null || def.target === undefined) return null;
  const target = def.target;
  if (earned(s, id)) return { cur: target, target };
  const fn = CUR[id];
  const cur = fn ? num(fn(s, d)) : 0;
  return { cur: Math.max(0, Math.min(target, cur)), target };
}

/**
 * [q] The n unearned, non-secret achievements closest to completion (highest cur / target; ties in ACH_ORDER).
 * achievements.tick also writes this list to d.progress.goals.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} [n=3]
 * @returns {Array<{ id: string, cur: number, target: number }>}
 */
export function nextGoals(s, d, n = 3) {
  const rows = [];
  for (let i = 0; i < ACH_ORDER.length; i++) {
    const id = ACH_ORDER[i];
    const def = ACHIEVEMENTS[id];
    if (def.secret || earned(s, id)) continue;
    const p = progress(s, d, id);
    if (!p || !(p.target > 0)) continue;
    rows.push({ id, cur: p.cur, target: p.target, frac: p.cur / p.target, i });
  }
  rows.sort((a, b) => b.frac - a.frac || a.i - b.i);
  const k = Math.max(0, Math.floor(Number.isFinite(n) ? n : 3));
  return rows.slice(0, k).map((r) => ({ id: r.id, cur: r.cur, target: r.target }));
}

// ------------------------------------------------------------------------------------------------------------------
// Tick
// ------------------------------------------------------------------------------------------------------------------

/** Reset per-run bookkeeping when the run changes. */
function runGuard(s, P) {
  if (P.run !== s.run.index) {
    P.run = s.run.index;
    P.trails = {};
    P.raids = {};
    P.hunts = {};
  }
}

/** Duration timers (every tick). */
function timers(s, d, dt, env) {
  const T = d.progress._timers;
  // A timer only feeds its own grant and progress bar (which reads "done" once earned), so an earned achievement's
  // timer is no longer kept (F24 perf: this ran for every trail on every tick, offline steps included).
  if (!earned(s, 'ach_hoarder')) {
    T.ach_hoarder = atCap(s, d) ? num(T.ach_hoarder) + dt : 0;
    if (T.ach_hoarder >= ACHIEVEMENTS.ach_hoarder.target) grantAch(s, 'ach_hoarder', env);
  }
  if (!earned(s, 'ach_mutualist')) {
    T.ach_mutualist = lycaenidMilked(s, d) ? num(T.ach_mutualist) + dt : 0;
    if (T.ach_mutualist >= ACHIEVEMENTS.ach_mutualist.target) grantAch(s, 'ach_mutualist', env);
  }
  if (earned(s, 'ach_highway')) {
    for (const k of Object.keys(T)) if (k.startsWith('ach_highway:')) delete T[k];
    return;
  }
  const cap = sMax(s) * ACH_PARAMS.atMaxFrac;
  const live = new Set();
  for (const t of s.run.surface.trails) {
    const key = 'ach_highway:' + t.uid;
    live.add(key);
    T[key] = num(t.S) >= cap ? num(T[key]) + dt : 0;
    if (T[key] >= ACHIEVEMENTS.ach_highway.target) grantAch(s, 'ach_highway', env);
  }
  for (const k of Object.keys(T)) if (k.startsWith('ach_highway:') && !live.has(k)) delete T[k];
}

/** Flight detection: judge the run-end achievements against the pre-flight snapshot. */
function flightCheck(s, d, P, env) {
  const flights = num(s.meta.counters.flights);
  if (P.flights !== null && flights > P.flights && P.snap) {
    const sn = P.snap;
    if (sn.time <= ACH_PARAMS.swiftSec) grantAch(s, 'ach_swift_swarm', env);
    if (sn.soldiersRaised === 0) grantAch(s, 'ach_gentle_giants', env);
    if (Math.abs(sn.time - sn.peakAt) <= ACH_PARAMS.peakSec) grantAch(s, 'ach_peak_timing', env);
    if (num(s.meta.counters.alatesLife) - sn.alatesLife >= ACH_PARAMS.flightAlates) grantAch(s, 'ach_sky_full_of_wings', env);
    if (sn.battles === 0) grantAch(s, 'ach_pacifist_flight', env);
    if (sn.flightDay) grantAch(s, 'ach_flying_ant_day', env);
  }
  P.flights = flights;
}

/** Snapshot of the run as it would be judged by a Flight on the next tick. */
function snapshot(s, dt, P) {
  P.snap = {
    time: num(s.run.time) + dt,
    soldiersRaised: num(s.run.stats.soldiersRaised),
    battles: num(s.run.stats.battles),
    peakAt: num(s.run.prestige ? s.run.prestige.peakAt : 0),
    alatesLife: num(s.meta.counters.alatesLife),
    flightDay: hasEffect(s, 'ev_flight_day') || effectMult(s, 'flight_w') > 1,
  };
}

/** Survivor: a whole winter, watched from its first tick, with no Hungry tick in this run. */
function winterCheck(s, d, P, env) {
  const W = P.winter;
  const id = d.season ? d.season.id : null;
  const runIdx = s.run.index;
  if (id === 'winter') {
    if (W.prev !== null && W.prev !== 'winter') {
      W.track = true;
      W.hungry = false;
      W.run = runIdx;
    }
    if (W.track && W.run !== runIdx) W.track = false;
    if (W.track && s.run.colony.hungry) W.hungry = true;
  } else if (W.prev === 'winter') {
    if (W.track && !W.hungry && W.run === runIdx) grantAch(s, 'ach_survivor', env);
    W.track = false;
  }
  W.prev = id;
}

/** Double Bridge: a reroute that shortens the trail by ≥ shorterFrac. */
function rerouteCheck(s, P, env) {
  const next = {};
  for (const t of s.run.surface.trails) {
    const r = Array.isArray(t.reroutes) ? t.reroutes : [];
    const cur = { len: num(t.len), n: r.length, last: r.length ? num(r[r.length - 1]) : -1 };
    const prev = P.trails[t.uid];
    if (prev && (cur.n !== prev.n || cur.last !== prev.last) && prev.len > 0 && cur.len <= prev.len * (1 - ACH_PARAMS.shorterFrac)) {
      grantAch(s, 'ach_double_bridge', env);
    }
    next[t.uid] = cur;
  }
  P.trails = next;
}

/** Remember raid targets and hunt targets for the event checks. */
function trackWar(s, P, events) {
  for (const r of s.run.war.raids) if (r && r.target) P.raids[r.uid] = r.target.type;
  for (const e of events) if (e.type === 'raidWarning' && e.target && typeof e.target === 'object') P.raids[e.uid] = e.target.type;
  for (const b of s.run.war.battles) {
    if (!b || b.kind !== 'hunt' || has(P.hunts, b.uid)) continue;
    const party = s.run.war.parties.find((p) => p && p.uid === b.party);
    const tgt = party && party.target;
    const src = tgt && tgt.type === 'source' ? findSrc(s, tgt.uid) : null;
    if (src) P.hunts[b.uid] = src.type;
  }
}

/** Dug cells seen this tick (events online, d.offlineLog offline) → deepest row and Going Under. */
function dugCells(s, d, P, events, env) {
  const see = (i) => {
    const row = Math.floor(num(i) / GRID.cols);
    if (row > P.dugRow) P.dugRow = row;
    if (row >= ACH_PARAMS.goingUnderRow) grantAch(s, 'ach_going_under', env);
  };
  for (const e of events) if (e.type === 'cellDug') see(e.i);
  const log = d.offlineLog;
  if (log && Array.isArray(log.cells)) {
    if (P.offRef !== log) {
      P.offRef = log;
      P.offIdx = 0;
    }
    for (; P.offIdx < log.cells.length; P.offIdx++) see(log.cells[P.offIdx]);
  } else {
    P.offRef = null;
    P.offIdx = 0;
  }
}

/** Every state check (numeric targets and conditions). */
function stateChecks(s, d, env) {
  for (const id of ACH_ORDER) {
    if (earned(s, id)) continue;
    const def = ACHIEVEMENTS[id];
    const t = TEST[id];
    if (t) {
      if (t(s, d)) grantAch(s, id, env);
      continue;
    }
    const c = CUR[id];
    if (!c || def.target === null) continue;
    const target = def.target;
    if (target > 0 && num(c(s, d)) >= target) grantAch(s, id, env);
  }
}

/**
 * Check achievements (timers every tick; state checks each sim second and on ticks with events) and refresh
 * d.progress.goals.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const P = priv(d);
  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
  const events = env && Array.isArray(env.events) ? env.events : [];
  runGuard(s, P);
  trackWar(s, P, events);
  timers(s, d, step, env);
  flightCheck(s, d, P, env);
  winterCheck(s, d, P, env);
  rerouteCheck(s, P, env);
  const deep0 = P.dugRow;
  dugCells(s, d, P, events, env);
  for (const e of events) {
    if (!e || e.type === 'achievement') continue;
    for (const id of EV_IDS) if (!earned(s, id) && EV[id](e, s, d, P)) grantAch(s, id, env);
  }
  const sec = Math.floor(num(s.meta.simTime));
  if (P.sec !== sec || events.length > 0 || P.dugRow !== deep0) {
    P.sec = sec;
    stateChecks(s, d, env);
    // The Next Goals list is UI-only: not rebuilt on offline steps (the catch-up ends with a fresh online pass, F24).
    if (!(env && env.offline)) d.progress.goals = nextGoals(s, d, 3);
  }
  snapshot(s, step, P);
}
