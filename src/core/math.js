// Numeric helpers: softcaps, clamps, geometric costs, safe division, interpolation.
// Owner: WP1. Contract: ARCHITECTURE §7.11 (DESIGN §3 cost cap and clamp, §12.10 softcaps).

import { CLAMP_MAX, COST_MAX } from '../data/balance.js';

/**
 * Single softcap: x ≤ s ? x : s × (x / s)^p.
 * @param {number} x
 * @param {number} s threshold
 * @param {number} p power (0 < p ≤ 1)
 * @returns {number}
 */
export function sc(x, s, p) {
  return x <= s ? x : s * (x / s) ** p;
}

/**
 * Softcap chain applied in sequence; each threshold applies to the already-softcapped value.
 * `sMult` multiplies the FIRST threshold only (thermal_ceiling).
 * @param {number} x
 * @param {import('./types.js').SoftcapChain} chain
 * @param {number} [sMult=1]
 * @returns {{ value: number, capped: boolean }}
 */
export function scChain(x, chain, sMult = 1) {
  let value = x;
  let capped = false;
  if (!chain) return { value, capped };
  for (let i = 0; i < chain.length; i++) {
    const s = i === 0 ? chain[i][0] * sMult : chain[i][0];
    if (value > s) {
      value = sc(value, s, chain[i][1]);
      capped = true;
    }
  }
  return { value, capped };
}

/**
 * Clamp to [lo, hi]. NaN → lo, -0 → lo when lo is 0, ±Infinity → the matching bound.
 * @param {number} x
 * @param {number} [lo=0]
 * @param {number} [hi=CLAMP_MAX]
 * @returns {number}
 */
export function clampNum(x, lo = 0, hi = CLAMP_MAX) {
  if (x > lo) return x < hi ? x : hi;
  return lo;
}

/**
 * Geometric cost of level L: base × growth^L per component. null (MAX) if any component exceeds COST_MAX or is not finite.
 * @param {import('./types.js').Cost|null} base
 * @param {number} growth
 * @param {number} L levels already owned
 * @returns {import('./types.js').Cost|null}
 */
export function geoCost(base, growth, L) {
  if (!base || typeof base !== 'object') return null;
  const f = growth ** L;
  const out = {};
  for (const k of Object.keys(base)) {
    const v = base[k] * f;
    if (!(v <= COST_MAX) || !(v >= 0)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Returns the cost unchanged, or null if it is null or any component is above COST_MAX / not finite / negative.
 * @param {import('./types.js').Cost|null} cost
 * @returns {import('./types.js').Cost|null}
 */
export function costOrNull(cost) {
  if (!cost || typeof cost !== 'object') return null;
  for (const k of Object.keys(cost)) {
    const v = cost[k];
    if (!(v <= COST_MAX) || !(v >= 0)) return null;
  }
  return cost;
}

/**
 * Level lookup: map[id] || 0.
 * @param {Object<string, number>|null|undefined} map
 * @param {string} id
 * @returns {number}
 */
export function lvl(map, id) {
  return (map && map[id]) || 0;
}

/**
 * a / b, or `fallback` when b is 0 or the result is not finite.
 * @param {number} a
 * @param {number} b
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function safeDiv(a, b, fallback = 0) {
  if (b === 0) return fallback;
  const r = a / b;
  return Number.isFinite(r) ? r : fallback;
}

/**
 * Total cost of n consecutive levels starting at level `fromL` (bulk buy):
 * Σ_{i=0}^{n-1} base × growth^(fromL + i). null (MAX) if any component exceeds COST_MAX.
 * @param {import('./types.js').Cost|null} baseCost
 * @param {number} growth
 * @param {number} fromL
 * @param {number} n
 * @returns {import('./types.js').Cost|null}
 */
export function sumGeo(baseCost, growth, fromL, n) {
  if (!baseCost || typeof baseCost !== 'object') return null;
  const count = n > 0 ? Math.floor(n) : 0;
  const start = growth ** fromL;
  const series = growth === 1 ? count : (growth ** count - 1) / (growth - 1);
  const out = {};
  for (const k of Object.keys(baseCost)) {
    const v = count === 0 ? 0 : baseCost[k] * start * series;
    if (!(v <= COST_MAX) || !(v >= 0)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Linear interpolation.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Relative approximate equality.
 * @param {number} a
 * @param {number} b
 * @param {number} [rel=1e-9]
 * @returns {boolean}
 */
export function approxEq(a, b, rel = 1e-9) {
  if (a === b) return true;
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}
