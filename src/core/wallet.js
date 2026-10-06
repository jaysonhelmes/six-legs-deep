// Wallet: affordability, all-or-nothing spending, refunds, one-shot grants (food cap / overflow / f_run rules),
// "seconds of income", time-to-afford. Owner: WP1. Contract: ARCHITECTURE §7.8 (DESIGN §3 overflow, §18 C1).
// Resource keys: run resources → s.run.res; alates → s.cycle.alates; kinship → s.era.kinship; genes → s.meta.genes.
// ARCH-R: timeToAfford also returns -1 when a capped resource (food, honeydew, leaves, fungus, pheromone) is needed
// beyond its current cap, since production can never reach it.
// C199 (WP2): chitin is capped at d.stats.chitinCap. grant() multiplies chitin by d.stats.chitinBoost (Carapace
// Workshops; opts.boost false skips it) and lets it overflow to CHITIN.overflow × cap (opts.overflow false: up to the
// cap only, e.g. moults); incomeSeconds('chitin') is measured on the unboosted income, so the boost is applied once.

import { CLAMP_MAX, FOOD_OVERFLOW } from '../data/balance.js';
import { CHITIN } from '../data/economy.js';
import { clampNum } from './math.js';

const RUN_RES = Object.freeze(['food', 'soil', 'insight', 'pheromone', 'chitin', 'honeydew', 'leaves', 'fungus']);
const RUN_SET = new Set(RUN_RES);
/** Resources clamped at a derived cap (key into d.stats). Food has its own overflow rule. */
const CAP_KEY = Object.freeze({ food: 'foodCap', honeydew: 'honeydewCap', leaves: 'leafCap', fungus: 'fungusCap', pheromone: 'pheromoneCap',
  chitin: 'chitinCap' });

/** @returns {boolean} true if `k` is a wallet resource key */
function isRes(k) {
  return RUN_SET.has(k) || k === 'alates' || k === 'kinship' || k === 'genes';
}

/** Current amount of a resource (0 for unknown keys). */
function getRes(s, k) {
  if (RUN_SET.has(k)) return s.run.res[k];
  if (k === 'alates') return s.cycle.alates;
  if (k === 'kinship') return s.era.kinship;
  if (k === 'genes') return s.meta.genes;
  return 0;
}

/** Write a resource amount (clamped to [0, CLAMP_MAX]). */
function setRes(s, k, v) {
  const c = clampNum(v);
  if (RUN_SET.has(k)) s.run.res[k] = c;
  else if (k === 'alates') s.cycle.alates = c;
  else if (k === 'kinship') s.era.kinship = c;
  else if (k === 'genes') s.meta.genes = c;
}

/** Cap of a capped resource from d.stats, or CLAMP_MAX. */
function capOf(d, k) {
  const key = CAP_KEY[k];
  if (!key || !d || !d.stats) return CLAMP_MAX;
  const c = d.stats[key];
  return Number.isFinite(c) && c >= 0 ? c : CLAMP_MAX;
}

/**
 * True if every component of the cost is covered. A null cost (MAX) is never affordable; unknown keys or
 * negative/non-finite amounts make the cost unaffordable.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Cost|null} cost
 * @returns {boolean}
 */
export function canAfford(s, cost) {
  if (!cost || typeof cost !== 'object') return false;
  for (const k of Object.keys(cost)) {
    const need = cost[k];
    if (!(need >= 0) || !Number.isFinite(need) || !isRes(k)) return false;
    if (getRes(s, k) < need) return false;
  }
  return true;
}

/**
 * Per-resource deficit ({} when affordable, and {} for a null cost).
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Cost|null} cost
 * @returns {import('./types.js').Cost}
 */
export function missing(s, cost) {
  const out = {};
  if (!cost || typeof cost !== 'object') return out;
  for (const k of Object.keys(cost)) {
    const need = cost[k];
    if (!(need > 0)) continue;
    const have = isRes(k) ? getRes(s, k) : 0;
    if (have < need) out[k] = need - have;
  }
  return out;
}

/**
 * All-or-nothing spend.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Cost|null} cost
 * @returns {boolean} true if paid
 */
export function spend(s, cost) {
  if (!canAfford(s, cost)) return false;
  for (const k of Object.keys(cost)) setRes(s, k, getRes(s, k) - cost[k]);
  logFlow(s, 'spend', cost);
  return true;
}

/**
 * Add frac × cost back. Food and the other capped resources never rise above their cap through a refund
 * (an amount already above the cap is kept, not reduced); others clamp at CLAMP_MAX. Not counted in f_run.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @param {import('./types.js').Cost|null} cost
 * @param {number} [frac=1]
 * @returns {void}
 */
export function refund(s, d, cost, frac = 1) {
  if (!cost || typeof cost !== 'object' || !(frac > 0)) return;
  for (const k of Object.keys(cost)) {
    if (!isRes(k)) continue;
    const amt = cost[k] * frac;
    if (!(amt > 0)) continue;
    const cur = getRes(s, k);
    const cap = capOf(d, k);
    setRes(s, k, Math.max(cur, Math.min(cap, cur + amt)));
    logFlow(s, 'grant', { [k]: getRes(s, k) - cur }, 'refund');
  }
}

/**
 * One-shot reward.
 * food: added up to d.stats.foodCap (FOOD_OVERFLOW × cap with overflow); the excess goes to run.stats.foodWasted;
 *   with countFRun the FULL amount is added to run.fRun and meta.stats.foodEver.
 * chitin (C199): × d.stats.chitinBoost (unless boost is false), up to CHITIN.overflow × chitinCap (chitinCap with
 *   overflow false).
 * honeydew / leaves / fungus / pheromone clamp at their d.stats caps; others clamp at CLAMP_MAX.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @param {import('./types.js').ResKey} res
 * @param {number} amount
 * @param {{ overflow?: boolean, countFRun?: boolean, boost?: boolean }} [opts]
 * @returns {number} the amount actually added
 */
export function grant(s, d, res, amount, { overflow, countFRun = true, boost = true } = {}) {
  if (!isRes(res) || !(amount > 0) || !Number.isFinite(amount)) return 0;
  const cur = getRes(s, res);
  if (res === 'chitin') {
    const b = boost && d && d.stats && Number.isFinite(d.stats.chitinBoost) && d.stats.chitinBoost > 0 ? d.stats.chitinBoost : 1;
    const want = clampNum(amount * b);
    const cap = capOf(d, 'chitin') * (overflow === false ? 1 : CHITIN.overflow);
    const added = Math.max(0, Math.min(want, cap - cur));
    setRes(s, 'chitin', cur + added);
    if (added > 0) logFlow(s, 'grant', { chitin: added });
    return added;
  }
  if (res === 'food') {
    const cap = capOf(d, 'food') * (overflow ? FOOD_OVERFLOW : 1);
    const added = Math.max(0, Math.min(amount, cap - cur));
    setRes(s, 'food', cur + added);
    const wasted = amount - added;
    if (wasted > 0) s.run.stats.foodWasted = clampNum(s.run.stats.foodWasted + wasted);
    if (countFRun) {
      s.run.fRun = clampNum(s.run.fRun + amount);
      s.meta.stats.foodEver = clampNum(s.meta.stats.foodEver + amount);
    }
    logFlow(s, 'grant', { food: amount }); // the full amount: the part over the cap is counted in foodWasted
    return added;
  }
  const cap = capOf(d, res);
  const added = Math.max(0, Math.min(amount, cap - cur));
  setRes(s, res, cur + added);
  if (added > 0) logFlow(s, 'grant', { [res]: added });
  return added;
}

/**
 * "Seconds of income": max(min, sec × smoothed gross rate) — d.rates[res].avg, the ~60 s moving average economy.tick
 * keeps (ARCHITECTURE §18 C76), so a momentary income spike does not multiply one-shot rewards; d.rates[res].gross when
 * no average exists (a hand-filled derived cache, soil, pheromone).
 * @param {import('./types.js').Derived} d
 * @param {string} res
 * @param {number} sec
 * @param {number} [min=0]
 * @returns {number}
 */
export function incomeSeconds(d, res, sec, min = 0) {
  const r = d && d.rates && d.rates[res];
  let rate = 0;
  if (r && typeof r.avg === 'number' && Number.isFinite(r.avg)) rate = r.avg;
  else if (r && Number.isFinite(r.gross)) rate = r.gross;
  if (res === 'chitin' && d && d.stats && Number.isFinite(d.stats.chitinBoost) && d.stats.chitinBoost > 1) rate /= d.stats.chitinBoost;
  const v = sec * rate;
  return Number.isFinite(v) ? Math.max(min, v) : min;
}

/**
 * Seconds until the cost is affordable at current net rates: 0 if affordable, −1 if never (null cost, a resource with
 * no positive net rate, or a capped resource whose need exceeds its cap).
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @param {import('./types.js').Cost|null} cost
 * @returns {number}
 */
export function timeToAfford(s, d, cost) {
  if (!cost || typeof cost !== 'object') return -1;
  if (canAfford(s, cost)) return 0;
  let worst = 0;
  for (const k of Object.keys(cost)) {
    const need = cost[k];
    if (!isRes(k) || !(need >= 0) || !Number.isFinite(need)) return -1;
    const have = getRes(s, k);
    if (have >= need) continue;
    if (need > capOf(d, k)) return -1;
    const r = d && d.rates && d.rates[k];
    const net = r && Number.isFinite(r.net) ? r.net : 0;
    if (!(net > 0)) return -1;
    const t = (need - have) / net;
    if (t > worst) worst = t;
  }
  return worst;
}

/**
 * Multiply every component by k (null stays null).
 * @param {import('./types.js').Cost|null} cost
 * @param {number} k
 * @returns {import('./types.js').Cost|null}
 */
export function scaleCost(cost, k) {
  if (!cost || typeof cost !== 'object') return null;
  const out = {};
  for (const key of Object.keys(cost)) out[key] = cost[key] * k;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Flow log (ARCHITECTURE §18 C191): a small per-run ring of one-second buckets recording what spend() paid and what
// grant() / refund() added, keyed by the "flow tag" of whoever is paying or earning (core/step.js sets 'cmd:<type>'
// around each command and the system name around each system tick). The UI reads it for the Stats tab's resource
// breakdown and the resource tooltips. Not saved and not part of the state: it lives in a WeakMap keyed by s.run, so a
// new run (or a load) starts empty. Purely additive: nothing in the simulation reads it.
// ---------------------------------------------------------------------------------------------------------------

/** Seconds of history kept (the UI shows the last 60 s). */
export const FLOW_LOG_SEC = 64;
/** @type {WeakMap<Object, { buckets: Array<Object|null> }>} */
const flowLogs = new WeakMap();
let flowTag = null;

/**
 * Set the flow tag for the spends and grants that follow ('cmd:placeChamber', 'population', …; null = untagged).
 * @param {string|null} tag
 * @returns {string|null} the previous tag
 */
export function setFlowTag(tag) {
  const prev = flowTag;
  flowTag = typeof tag === 'string' && tag ? tag : null;
  return prev;
}

/** The current flow tag (tests). */
export function getFlowTag() {
  return flowTag;
}

/** Record amounts into the bucket of the current run second. */
function logFlow(s, kind, amounts, tagOverride = null) {
  const run = s && s.run;
  if (!run || typeof run !== 'object' || !amounts) return;
  const t = Number.isFinite(run.time) ? run.time : 0;
  const sec = Math.floor(t);
  let log = flowLogs.get(run);
  if (!log) {
    log = { buckets: new Array(FLOW_LOG_SEC).fill(null) };
    flowLogs.set(run, log);
  }
  const i = ((sec % FLOW_LOG_SEC) + FLOW_LOG_SEC) % FLOW_LOG_SEC;
  let b = log.buckets[i];
  if (!b || b.sec !== sec) {
    b = { sec, spend: {}, grant: {} };
    log.buckets[i] = b;
  }
  const tag = tagOverride || flowTag || 'other';
  const box = b[kind];
  for (const k of Object.keys(amounts)) {
    const v = amounts[k];
    if (!(v > 0) || !Number.isFinite(v)) continue;
    const byTag = box[k] || (box[k] = {});
    byTag[tag] = (byTag[tag] || 0) + v;
  }
}

/**
 * Totals over the last `windowSec` run seconds (the current, partial second included):
 * { spend: { res: { tag: amount } }, grant: { res: { tag: amount } }, sec } where sec = the seconds covered
 * (min(windowSec, run time)). Amounts are totals, not rates.
 * @param {import('./types.js').State} s
 * @param {number} [windowSec=60]
 * @returns {{ spend: Object<string, Object<string, number>>, grant: Object<string, Object<string, number>>, sec: number }}
 */
export function flowTotals(s, windowSec = 60) {
  const out = { spend: {}, grant: {}, sec: 0 };
  const run = s && s.run;
  if (!run) return out;
  const t = Number.isFinite(run.time) ? run.time : 0;
  const w = Math.max(1, Math.min(FLOW_LOG_SEC - 1, Math.floor(windowSec)));
  out.sec = Math.min(w, t);
  const log = flowLogs.get(run);
  if (!log) return out;
  const now = Math.floor(t);
  for (const b of log.buckets) {
    if (!b || b.sec > now || now - b.sec >= w) continue;
    for (const kind of ['spend', 'grant']) {
      for (const res of Object.keys(b[kind])) {
        const dst = out[kind][res] || (out[kind][res] = {});
        const src = b[kind][res];
        for (const tag of Object.keys(src)) dst[tag] = (dst[tag] || 0) + src[tag];
      }
    }
  }
  return out;
}
