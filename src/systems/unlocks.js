// Unlock evaluation (run.unlocked, gameplay availability, immediate), the 30 s reveal queue (meta.reveal, meta.seen,
// `unlock {key}` events) and the next-unlock ribbon (d.progress.nextUnlock).
// Owner: WP6. Contract: ARCHITECTURE §8.5 (unlocks.js), §11, DESIGN §23, §18 C25.
// Same-tick order: evaluate every condition (UNLOCKS order) → pop one queued reveal if the gap allows → reveal the
// non-queued (purchase-triggered) keys and set lastAt. Popping first means a non-queued key unlocked in the same tick
// as a queued one (e.g. adapt_basic with panel_colony) never delays that queued reveal.
// ARCH-R: a non-queued key whose condition is `{ flag: parent }` (adapt_basic, chamber_gallery) is unlocked for
//   gameplay with its parent but its reveal (`unlock` event, meta.seen, lastAt) waits until the parent itself is
//   revealed, so the UI never announces the contents of a panel before the panel.
// ARCH-R: the always-on tabs (`{ all: [] }` conditions) are revealed at once but do NOT set meta.reveal.lastAt, so they
//   cannot push the first real reveal (the Colony panel at ~0:15, DESIGN §24.1) back to 0:30.
// ARCH-R: keys already in meta.seen (revealed in an earlier run) are unlocked without a second reveal or `unlock`
//   event; isRevealed() then reports them revealed immediately.
// ARCH-R: the reveal queue is ordered by schedule position (UNLOCKS order), not by arrival: a waiting key pops before
//   later-scheduled keys that unlocked earlier (C63). The 30 s spacing is unchanged.
// ARCH-R: `panel_achievements` ("3 achievements earned") uses the condition extension { achievements: n }.
// ARCH-R: custom `eggsBlockPurchase` = some unlocked food purchase (Adaptation level or chamber placement, via the [q]
//   cost queries) costs more than stored food but less than stored food + the food eggs used in the last ~30 s.

import { UNLOCKS, REVEAL, EGG_BLOCK } from '../data/unlocks.js';
import { SEASON_ORDER } from '../data/seasons.js';
import { FLIGHT } from '../data/prestige.js';
import { RAIDS } from '../data/combat.js';
import { BOTTLENECK, BROOD } from '../data/economy.js';
import { CASTES } from '../data/castes.js';
import { SOURCES } from '../data/sources.js';
import { MAP } from '../data/surface.js';
import { CHAMBERS, CHAMBER_ORDER } from '../data/chambers.js';
import { ADAPTATION_ORDER } from '../data/adaptations.js';
import { adultsTotal, broodTotal } from '../core/state.js';
import { countInRadius } from '../core/hex.js';
import { lvl } from '../core/math.js';
import * as adaptations from './adaptations.js';
import * as nest from './nest.js';
import * as population from './population.js';

/** UnlockDef by key. */
const BY_KEY = new Map(UNLOCKS.map((u) => [u.key, u]));
/** Purchase-triggered (non-queued) keys, revealed at once (the tick loops only these for instant reveals). */
const INSTANT = UNLOCKS.filter((u) => !u.queued);
/** Schedule position by key (the reveal queue is kept in this order, C63). */
const ORDER = new Map(UNLOCKS.map((u, i) => [u.key, i]));

/**
 * Insert a key into the reveal queue in schedule (UNLOCKS) order, so a core reveal (trail slots, Research) that unlocks
 * while a backlog is waiting does not sit behind minor ones (Egg reserve, Mound) that happened to unlock first.
 * Keys unknown to the schedule (old saves) stay at the end.
 * @param {string[]} queue
 * @param {string} key
 */
function enqueue(queue, key) {
  const at = ORDER.has(key) ? ORDER.get(key) : Infinity;
  let i = queue.length;
  while (i > 0) {
    const prev = ORDER.has(queue[i - 1]) ? ORDER.get(queue[i - 1]) : Infinity;
    if (prev <= at) break;
    i--;
  }
  queue.splice(i, 0, key);
}

/** Finite number or 0. */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** Own-key check. */
function has(map, k) {
  return !!map && Object.prototype.hasOwnProperty.call(map, k);
}

/** Read a dotted path (undefined when missing). */
function getPath(obj, path) {
  if (typeof path !== 'string') return undefined;
  let o = obj;
  for (const k of path.split('.')) {
    if (o === null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
    o = o[k];
  }
  return o;
}

/** Private, unsaved bookkeeping in d.progress. */
function priv(d) {
  if (!d.progress) d.progress = { nextUnlock: null, goals: [], _timers: {} };
  if (!d.progress._unl) d.progress._unl = { hexRevealed: false, eggFood: 0 };
  return d.progress._unl;
}

/** True when every `{ flag: key }` inside a condition names a key already revealed (meta.seen). */
function parentsSeen(cond, seen) {
  if (!cond || typeof cond !== 'object') return true;
  if (cond.flag !== undefined) return has(seen, cond.flag);
  const kids = Array.isArray(cond.all) ? cond.all : Array.isArray(cond.any) ? cond.any : null;
  return kids ? kids.every((c) => parentsSeen(c, seen)) : true;
}

/** True for the "always" condition `{ all: [] }`. */
function isAlways(cond) {
  return !!cond && Array.isArray(cond.all) && cond.all.length === 0;
}

/** d.surface.trails entry for a trail uid. */
function dTrail(d, uid) {
  const list = d && d.surface && Array.isArray(d.surface.trails) ? d.surface.trails : [];
  for (const e of list) if (e && e.uid === uid) return e;
  return null;
}

/** Cheapest food cost among unlocked purchases that storage can hold (Infinity when none). */
function cheapestFoodPurchase(s, d) {
  const cap = d && d.stats ? num(d.stats.foodCap) : 0;
  let best = Infinity;
  const consider = (cost) => {
    const c = cost && typeof cost === 'object' ? cost.food : undefined;
    if (typeof c === 'number' && Number.isFinite(c) && c > 0 && (cap <= 0 || c <= cap) && c < best) best = c;
  };
  for (const id of ADAPTATION_ORDER) if (adaptations.isAvailable(s, id)) consider(adaptations.cost(s, id, 1));
  for (const type of CHAMBER_ORDER) {
    const def = CHAMBERS[type];
    if (def && typeof def.unlock === 'string' && s.run.unlocked[def.unlock]) consider(nest.placementCost(s, type));
  }
  return best;
}

/** Named predicates of the §11 condition language. */
const CUSTOM = {
  housingFull(s, d) {
    const h = d && d.stats ? num(d.stats.housing) : 0;
    return h > 0 && num(s.run.colony.adults.minor) + broodTotal(s) >= h;
  },
  foodCapReached(s, d) {
    const cap = d && d.stats ? num(d.stats.foodCap) : 0;
    return cap > 0 && num(s.run.res.food) >= cap * BOTTLENECK.capFrac;
  },
  crumbSaturated(s, d) {
    let any = false;
    for (const t of s.run.surface.trails) {
      const src = s.run.surface.sources.find((x) => x.uid === t.src);
      if (!src || src.type !== 'crumb_scatter') continue;
      const e = dTrail(d, t.uid);
      if (!e) continue;
      any = true;
      if (num(e.sat) > 1 || (num(e.cEff) > 0 && num(e.workers) > num(e.cEff))) return true;
    }
    if (any) return false;
    const cap = SOURCES && SOURCES.crumb_scatter ? SOURCES.crumb_scatter.cap : undefined;
    return typeof cap === 'number' && cap > 0 && num(s.run.colony.jobs.forager) > cap;
  },
  firstHexRevealed(s, d) {
    // (Stored insight is no signal: the Field Guide pays insight from 0:00.)
    if (d && d.progress && d.progress._unl && d.progress._unl.hexRevealed) return true;
    if (Object.keys(s.run.research || {}).length > 0) return true;
    const R = Number.isFinite(s.run.surface.radius) ? Math.max(0, Math.min(16, Math.floor(s.run.surface.radius))) : 8;
    const n = countInRadius(R);
    const start = countInRadius(Math.max(0, Math.min(16, num(MAP.revealStart))));
    let c = 0;
    const rev = s.run.surface.revealed;
    for (let i = 0; i < n; i++) if (rev[i] === 1) c++;
    return c > start;
  },
  eggsBlockPurchase(s, d) {
    const eggFood = d && d.progress && d.progress._unl ? num(d.progress._unl.eggFood) : 0;
    if (!(eggFood > 0)) return false;
    const c = cheapestFoodPurchase(s, d);
    const food = num(s.run.res.food);
    return Number.isFinite(c) && food < c && food + eggFood >= c;
  },
  firstChitin: (s, d) => num(s.run.res.chitin) > 0 || num(d && d.rates && d.rates.chitin ? d.rates.chitin.gross : 0) > 0,
  firstDigger: (s) => num(s.run.colony.jobs.digger) >= 1,
  rivalRevealed: (s) => s.run.rivals.list.some((r) => r && r.sighted),
  rivalEligible(s, d) {
    if (adultsTotal(s) < RAIDS.minAdults) return false;
    if (d && d.season && d.season.id === 'winter') return false;
    const t = num(s.run.time);
    return s.run.rivals.list.some((r) => r && r.alive && (r.sighted || t >= RAIDS.minRunSec) && !(num(r.truce) > 0));
  },
  firstRaidWarning: (s) => num(s.run.stats.raidsIncoming) >= 1,
  autumnYear0(s, d) {
    if (num(s.meta.season.year) >= 1) return true;
    const idx = d && d.season ? d.season.index : 0;
    return idx >= SEASON_ORDER.indexOf('autumn');
  },
  firstWinter: (s, d) => num(s.meta.season.year) >= 1 || !!(d && d.season && d.season.id === 'winter'),
  prestigeTab: (s) => num(s.run.fRun) >= FLIGHT.tabFRun || !!(s.run.research && s.run.research.nuptial_preparation),
  flightReady(s, d) {
    const fly = d && d.meta && d.meta.proj ? d.meta.proj.fly : null;
    if (fly && fly.ok === true) return true;
    const agg = d && d.nest ? d.nest.agg : null;
    return !!(agg && num(agg.royalL) >= FLIGHT.royalLevel && s.run.research && s.run.research.nuptial_preparation &&
      agg.nuptial && agg.nuptial.active && num(s.run.fRun) >= FLIGHT.fRunMin);
  },
  waterRevealed: (s) => s.run.nest.features.water.some((w) => w && w.revealed),
  secondTrailOrClaim: (s) => s.run.surface.trails.length >= 2 || num(s.run.surface.claims) >= 1,
};

/** Compare a value with a { gte } / { eq } leaf. */
function cmp(v, c) {
  if (Object.prototype.hasOwnProperty.call(c, 'eq')) return v === c.eq;
  if (typeof c.gte === 'number') return typeof v === 'number' && Number.isFinite(v) && v >= c.gte;
  return false;
}

/**
 * [q] Evaluate an unlock condition (ARCHITECTURE §11). Pure; reads s and d (incl. this module's d.progress facts).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {Object} cond
 * @returns {boolean}
 */
export function evalCond(s, d, cond) {
  if (!cond || typeof cond !== 'object') return false;
  if (Array.isArray(cond.all)) return cond.all.every((c) => evalCond(s, d, c));
  if (Array.isArray(cond.any)) return cond.any.some((c) => evalCond(s, d, c));
  if (cond.adults !== undefined) return adultsTotal(s) >= cond.adults;
  if (cond.research !== undefined) return !!(s.run.research && s.run.research[cond.research]);
  if (cond.trait !== undefined) return lvl(s.cycle.traits, cond.trait) >= 1;
  if (cond.fed !== undefined) return lvl(s.era.federation, cond.fed) >= 1;
  if (cond.genome !== undefined) return lvl(s.meta.genome, cond.genome) >= 1;
  if (cond.flag !== undefined) return !!s.run.unlocked[cond.flag];
  if (cond.path !== undefined) return cmp(getPath(s, cond.path), cond);
  if (cond.dpath !== undefined) return cmp(getPath(d, cond.dpath), cond);
  if (cond.counter !== undefined) return num(s.meta.counters[cond.counter]) >= num(cond.gte);
  if (cond.runTime !== undefined) {
    if (cond.firstRun && s.run.index > 0) return true;   // a first-run timer: later runs have it from the start
    return num(s.run.time) >= cond.runTime;
  }
  if (cond.achievements !== undefined) return Object.keys(s.meta.achievements).length >= cond.achievements;
  if (cond.custom !== undefined) {
    const fn = CUSTOM[cond.custom];
    return !!(fn && fn(s, d));
  }
  return false;
}

/**
 * [q] Gameplay availability of an unlock key.
 * @param {import('../core/types.js').State} s
 * @param {string} key
 * @returns {boolean}
 */
export function isUnlocked(s, key) {
  return !!(s && s.run && s.run.unlocked && s.run.unlocked[key]);
}

/**
 * [q] UI visibility: unlocked and (already revealed, or a non-queued key).
 * @param {import('../core/types.js').State} s
 * @param {string} key
 * @returns {boolean}
 */
export function isRevealed(s, key) {
  const def = BY_KEY.get(key);
  if (!def || !isUnlocked(s, key)) return false;
  return has(s.meta.seen, key) || def.queued === false;
}

/**
 * [x] WP7 startRun: grant every persist key that was already seen (C25).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {void}
 */
export function onRunStart(s, d) {
  for (const def of UNLOCKS) if (def.persist && has(s.meta.seen, def.key)) s.run.unlocked[def.key] = true;
  // F7: a reveal still waiting in the queue at the end of the last run (e.g. flight_button when the player flew the
  // moment the button lit up) belongs to that run. Keep only keys the new run has unlocked; the rest re-queue when
  // their conditions hold again in this run.
  const rv = s.meta.reveal;
  if (rv && Array.isArray(rv.queue)) rv.queue = rv.queue.filter((k) => !!s.run.unlocked[k] && !has(s.meta.seen, k));
}

// ------------------------------------------------------------------------------------------------------------------
// Next-unlock ribbon
// ------------------------------------------------------------------------------------------------------------------

/** Rate of a state path's value (units/s) for ETAs; 0 when unknown. */
function pathRate(path, d) {
  const r = d && d.rates ? d.rates : null;
  if (!r) return 0;
  if (path === 'run.fRun') return num(r.food && r.food.gross);
  const m = /^run\.res\.(\w+)$/.exec(path);
  if (m && r[m[1]]) return num(r[m[1]].net);
  return 0;
}

/**
 * Expected adult growth rate for an `{ adults: N }` ETA: the lay rate, or 0 while laying is blocked by housing
 * (minors + brood ≥ housing, DESIGN §5.1) or the colony is Hungry (the lay rate is then already 0). Brood-slot
 * blocks keep the lay rate, since the brood in the slots still hatches into adults.
 */
function adultRate(s, d) {
  if (!d || !d.stats) return 0;
  const col = s.run.colony;
  if (col.hungry) return 0;
  if (num(col.adults.minor) + population.housingBrood(s) >= num(d.stats.housing)) return 0;
  return num(d.stats.layRate);
}

/** Positive finite number, else the fallback. */
function numOr(x, fb) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : fb;
}

/**
 * Brood pipeline for adult / hatch ETAs, computed once per computeNext (lazily: only while an { adults } or hatch
 * condition is still pending). Mirrors population.js develop(): a cohort of caste c needs
 * T_c = BROOD.baseSec × mbt / max(1, nurseTerm) / bSpeed × broodFactor_c seconds and is at progress p.
 * @returns {{ sched: Array<{ t: number, n: number, adult: boolean }>, T: number }} T = a new minor egg's time (−1: brood not developing)
 */
function broodPipe(s, d, cache) {
  if (cache.pipe) return cache.pipe;
  let bSpeed = 0;
  try { bSpeed = num(population.broodAllocation(s, d).bSpeed); } catch { bSpeed = 0; }
  const st = d && d.stats ? d.stats : {};
  const base = bSpeed > 0 ? numOr(BROOD.baseSec, 25) * numOr(st.mbt, 1) / Math.max(1, numOr(st.nurseTerm, 1)) / bSpeed : -1;
  const factor = (c) => (CASTES[c] ? numOr(CASTES[c].broodFactor, 1) : 1);
  const sched = [];
  if (base > 0) {
    for (const c of s.run.colony.brood) {
      if (!c || !(num(c.n) > 0)) continue;
      const p = Math.max(0, Math.min(1, num(c.p)));
      sched.push({ t: (1 - p) * base * factor(c.c), n: num(c.n), adult: c.c !== 'alate' });
    }
    sched.sort((a, b) => a.t - b.t);
  }
  cache.pipe = { sched, T: base > 0 ? base * factor('minor') : -1 };
  return cache.pipe;
}

/**
 * Seconds until `need` more brood hatch (adultsOnly: alates excluded): the brood already growing first, then eggs at
 * `lay` per second, each needing a full development time. −1 when it cannot happen at the current rates.
 */
function hatchEta(s, d, cache, need, lay, adultsOnly) {
  if (!(need > 0)) return 0;
  const pipe = broodPipe(s, d, cache);
  let left = need;
  let last = 0;
  for (const c of pipe.sched) {
    if (adultsOnly && !c.adult) continue;
    left -= c.n;
    last = c.t;
    if (left <= 0) return c.t;
  }
  if (!(lay > 0) || !(pipe.T > 0)) return -1;
  return Math.max(last, left / lay + pipe.T);
}

/** Season-clock ETA (s) to the start of season index `target` in year 0 (d.season), or 0 once reached. */
function seasonEta(s, d, target) {
  const se = d && d.season ? d.season : null;
  if (!se || num(s.meta.season.year) >= 1) return { frac: 1, eta: 0 };
  const idx = Number.isInteger(se.index) ? se.index : 0;
  if (idx >= target) return { frac: 1, eta: 0 };
  const len = numOr(se.len, 360);
  const eta = num(se.toNext) + (target - idx - 1) * len;
  return { frac: Math.max(0, Math.min(1, (idx * len + num(se.tIn)) / (target * len))), eta };
}

/**
 * Player-driven custom reveals the ribbon names (eta −1, shown with their condition) when nothing timed is near.
 * firstHexRevealed only once Scouts exist (nothing reveals hexes before that).
 */
const NAMED_PENDING = Object.freeze({
  crumbSaturated: () => true,
  firstHexRevealed: (s) => !!s.run.unlocked.job_scout,
  secondTrailOrClaim: () => true,
});

/** Measurable custom predicates: { frac, eta } (eta −1 = unknown), or null (not shown). */
function measureCustom(s, d, name, cache) {
  const st = d && d.stats ? d.stats : null;
  if (name === 'housingFull') {
    // Every egg laid fills a place at once (minors + brood ≥ housing).
    const h = st ? num(st.housing) : 0;
    if (!(h > 0)) return null;
    const used = num(s.run.colony.adults.minor) + broodTotal(s);
    const lay = s.run.colony.hungry ? 0 : num(st.layRate);
    return { frac: Math.min(1, used / h), eta: used >= h ? 0 : lay > 0 ? (h - used) / lay : -1 };
  }
  if (name === 'foodCapReached') {
    const cap = st ? num(st.foodCap) * BOTTLENECK.capFrac : 0;
    if (!(cap > 0)) return null;
    const food = num(s.run.res.food);
    const net = d && d.rates && d.rates.food ? num(d.rates.food.net) : 0;
    return { frac: Math.min(1, food / cap), eta: food >= cap ? 0 : net > 0 ? (cap - food) / net : -1 };
  }
  if (name === 'autumnYear0') return seasonEta(s, d, SEASON_ORDER.indexOf('autumn'));
  if (name === 'firstWinter') return seasonEta(s, d, SEASON_ORDER.indexOf('winter'));
  const named = NAMED_PENDING[name];
  return named && named(s) ? { frac: 0, eta: -1 } : null;
}

/**
 * { frac, eta } toward a measurable condition, or null. eta = seconds (−1 unknown).
 * `{ adults: n }` and `run.stats.hatched` ETAs follow the brood pipeline (brood already growing, then eggs at the
 * lay rate plus one development time), not the lay rate alone (UI hand-off; ARCHITECTURE §18).
 */
function measure(s, d, c, cache = {}) {
  if (!c || typeof c !== 'object') return null;
  const ratio = (v, n, rate) => ({ frac: n > 0 ? Math.max(0, Math.min(1, v / n)) : 1, eta: v >= n ? 0 : rate > 0 ? (n - v) / rate : -1 });
  if (Array.isArray(c.all)) {
    if (!c.all.length) return null;
    const parts = c.all.map((x) => measure(s, d, x, cache));
    if (parts.some((p) => !p)) return null;
    return { frac: Math.min(...parts.map((p) => p.frac)), eta: parts.some((p) => p.eta < 0) ? -1 : Math.max(...parts.map((p) => p.eta)) };
  }
  if (Array.isArray(c.any)) {
    const parts = c.any.map((x) => measure(s, d, x, cache)).filter(Boolean);
    if (!parts.length) return null;
    const timed = parts.filter((p) => p.eta >= 0);
    if (timed.length) return timed.reduce((a, b) => (b.eta < a.eta ? b : a));
    return parts.reduce((a, b) => (b.frac > a.frac ? b : a));
  }
  if (c.adults !== undefined) {
    const have = adultsTotal(s);
    const n = num(c.adults);
    return { frac: n > 0 ? Math.max(0, Math.min(1, have / n)) : 1, eta: hatchEta(s, d, cache, n - have, adultRate(s, d), true) };
  }
  if (c.path === 'run.stats.hatched' && typeof c.gte === 'number') {
    const have = num(s.run.stats.hatched);
    return { frac: c.gte > 0 ? Math.max(0, Math.min(1, have / c.gte)) : 1, eta: hatchEta(s, d, cache, c.gte - have, adultRate(s, d), false) };
  }
  if (c.path !== undefined && typeof c.gte === 'number') return ratio(num(getPath(s, c.path)), c.gte, pathRate(c.path, d));
  if (c.dpath !== undefined && typeof c.gte === 'number') return ratio(num(getPath(d, c.dpath)), c.gte, 0);
  if (c.counter !== undefined) return ratio(num(s.meta.counters[c.counter]), num(c.gte), 0);
  if (c.runTime !== undefined) {
    if (c.firstRun && s.run.index > 0) return null;
    return ratio(num(s.run.time), c.runTime, 1);
  }
  if (c.achievements !== undefined) return ratio(Object.keys(s.meta.achievements).length, c.achievements, 0);
  if (c.flag !== undefined) return s.run.unlocked[c.flag] ? { frac: 1, eta: 0 } : null;
  if (c.custom !== undefined) return measureCustom(s, d, c.custom, cache);
  return null;
}

/** A timed candidate is shown over a pending (unknown-ETA) one only while it is this close (s). */
const PENDING_AFTER_SEC = 120;

/**
 * Which of two timed candidates reveals first: the sooner one, unless the other comes earlier in the schedule and is
 * due within one reveal gap of it (the queue then reveals the earlier row first, C63).
 */
function earlierReveal(a, b) {
  if (!b) return a;
  const ia = ORDER.has(a.key) ? ORDER.get(a.key) : Infinity;
  const ib = ORDER.has(b.key) ? ORDER.get(b.key) : Infinity;
  if (ia < ib) return a.eta <= b.eta + REVEAL.gapSec ? a : b;
  return b.eta <= a.eta + REVEAL.gapSec ? b : a;
}

/**
 * The nearest upcoming reveal: the head of the reveal queue; else the timed candidate that reveals first; else (or
 * when that is more than PENDING_AFTER_SEC away and later in the schedule) the first pending player-driven step
 * (eta −1: an adult count while laying is blocked, trail slots, Research, Map), which the HUD names with its condition.
 */
function computeNext(s, d) {
  const rv = s.meta.reveal;
  const now = num(s.meta.simTime);
  if (rv.queue.length) {
    const key = rv.queue[0];
    const def = BY_KEY.get(key);
    return { key, label: def ? def.label : key, frac: 1, eta: Math.max(0, num(rv.lastAt) + REVEAL.gapSec - now) };
  }
  const cache = {};
  let timed = null;
  let pending = null;
  for (const def of UNLOCKS) {
    if (!def.queued || s.run.unlocked[def.key] || has(s.meta.seen, def.key)) continue;
    const m = measure(s, d, def.cond, cache);
    if (!m) continue;
    const c = { key: def.key, label: def.label, frac: m.frac, eta: m.eta };
    if (m.eta >= 0) timed = earlierReveal(c, timed);
    else if (!pending) pending = c;
  }
  if (timed && timed.eta <= PENDING_AFTER_SEC) return timed;
  if (pending && (!timed || ORDER.get(pending.key) < ORDER.get(timed.key))) return pending;
  return timed || pending;
}

// ------------------------------------------------------------------------------------------------------------------
// Tick
// ------------------------------------------------------------------------------------------------------------------

/**
 * Evaluate UNLOCKS: set run.unlocked at once, queue reveals (≥ REVEAL.gapSec apart), reveal non-queued keys
 * immediately, and refresh d.progress.nextUnlock.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const P = priv(d);
  const events = env && Array.isArray(env.events) ? env.events : [];
  const emit = env && typeof env.emit === 'function' ? (t, p) => env.emit(t, p) : () => {};

  // Facts from this tick's events.
  let spent = 0;
  const eggCost = d && d.stats && d.stats.eggCost ? d.stats.eggCost : {};
  for (const e of events) {
    if (e.type === 'hexRevealed') P.hexRevealed = true;
    else if (e.type === 'eggLaid' && num(e.n) > 0) spent += num(e.n) * num(eggCost[e.caste]);
  }
  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
  P.eggFood = num(P.eggFood) * Math.exp(-step / EGG_BLOCK.windowSec) + spent;
  if (P.eggFood < 1e-9) P.eggFood = 0;

  const un = s.run.unlocked;
  const seen = s.meta.seen;
  const rv = s.meta.reveal;
  const now = num(s.meta.simTime);
  for (const def of UNLOCKS) {
    if (un[def.key]) continue;
    if (!evalCond(s, d, def.cond)) continue;
    un[def.key] = true;
    if (def.queued && !has(seen, def.key) && !rv.queue.includes(def.key)) enqueue(rv.queue, def.key);
  }

  // One queued reveal per gap. Keys already seen, or not unlocked in this run (a stale entry from an earlier run or an
  // old save, F7), are dropped instead of revealed.
  if (rv.queue.some((k) => has(seen, k) || !un[k])) rv.queue = rv.queue.filter((k) => !has(seen, k) && !!un[k]);
  if (rv.queue.length && now - num(rv.lastAt) >= REVEAL.gapSec) {
    const key = rv.queue.shift();
    seen[key] = true;
    rv.lastAt = now;
    emit('unlock', { key });
  }

  // Purchase-triggered (non-queued) reveals happen at once — after the keys they hang off (`flag`) are revealed.
  for (const def of INSTANT) {
    if (!un[def.key] || has(seen, def.key) || !parentsSeen(def.cond, seen)) continue;
    seen[def.key] = true;
    if (!isAlways(def.cond)) rv.lastAt = now;
    emit('unlock', { key: def.key });
  }

  // The ribbon estimate is UI-only: not rebuilt on offline steps (the catch-up ends with a fresh online pass, F24).
  if (!(env && env.offline)) d.progress.nextUnlock = computeNext(s, d);
}
