// Deterministic RNG: mulberry32 on a holder object (any object with a uint32 `rng` field; the state `s` is the main holder).
// Owner: WP1. Contract: ARCHITECTURE §7.9 (DESIGN §3 RNG).

/**
 * Advance the holder and return the next uint32 (mulberry32, exact).
 * @param {import('./types.js').Holder} h
 * @returns {number}
 */
export function nextU32(h) {
  let t = (h.rng = (h.rng + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/**
 * Uniform float in [0, 1).
 * @param {import('./types.js').Holder} h
 * @returns {number}
 */
export function rand(h) {
  return nextU32(h) / 4294967296;
}

/**
 * Uniform integer in [lo, hi] (inclusive). If hi < lo, returns lo.
 * @param {import('./types.js').Holder} h
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function randInt(h, lo, hi) {
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  if (!(b > a)) {
    rand(h);
    return a;
  }
  return a + Math.floor(rand(h) * (b - a + 1));
}

/**
 * Uniform float in [lo, hi).
 * @param {import('./types.js').Holder} h
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function randRange(h, lo, hi) {
  return lo + rand(h) * (hi - lo);
}

/**
 * True with probability p.
 * @param {import('./types.js').Holder} h
 * @param {number} p
 * @returns {boolean}
 */
export function chance(h, p) {
  return rand(h) < p;
}

/**
 * Uniform element of arr; null (no roll consumed) for an empty array.
 * @template T
 * @param {import('./types.js').Holder} h
 * @param {T[]} arr
 * @returns {T|null}
 */
export function pick(h, arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rand(h) * arr.length)];
}

/**
 * Weighted pick: entries carry a numeric `w` (negative or non-finite weights count as 0).
 * Returns null (no roll consumed) when there is no positive weight.
 * @template {{ w: number }} T
 * @param {import('./types.js').Holder} h
 * @param {T[]} entries
 * @returns {T|null}
 */
export function weighted(h, entries) {
  if (!entries || entries.length === 0) return null;
  let total = 0;
  for (const e of entries) if (e && e.w > 0 && Number.isFinite(e.w)) total += e.w;
  if (!(total > 0)) return null;
  let r = rand(h) * total;
  let last = null;
  for (const e of entries) {
    if (!(e && e.w > 0 && Number.isFinite(e.w))) continue;
    last = e;
    if (r < e.w) return e;
    r -= e.w;
  }
  return last;
}

/**
 * Fisher–Yates shuffle in place; returns arr.
 * @template T
 * @param {import('./types.js').Holder} h
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffle(h, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(h) * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Exponential sample with the given mean: −mean × ln(1 − rand).
 * @param {import('./types.js').Holder} h
 * @param {number} mean
 * @returns {number}
 */
export function expSample(h, mean) {
  return -mean * Math.log(1 - rand(h));
}

/**
 * New child holder from a seed: { rng: (seed >>> 0) || 1 }.
 * @param {number} seed
 * @returns {import('./types.js').Holder}
 */
export function makeHolder(seed) {
  return { rng: (seed >>> 0) || 1 };
}

/**
 * Child seed (map, nest, landing options) drawn from the holder's stream.
 * @param {import('./types.js').Holder} h
 * @returns {number} uint32
 */
export function deriveSeed(h) {
  return nextU32(h);
}
