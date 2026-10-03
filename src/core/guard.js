// NaN/Infinity guard and clamp pass: every tick on the hot numeric paths, a full state walk every GUARD.fullEveryTicks.
// Owner: WP1. Contract: ARCHITECTURE §7.12 (DESIGN §3 clamp rule).
// ARCH-R: §7.12 asks the full walk only to zero non-finite numbers; it additionally clamps |x| > CLAMP_MAX to
// ±CLAMP_MAX and normalises -0 to 0 (silently, not counted as a NaN guard) so DESIGN §3 "every stored number is clamped
// to [0, 1e295]" also holds for non-hot fields (negative sentinels such as -1 / -1e9 are left alone).

import { CLAMP_MAX, GUARD } from '../data/balance.js';

const RES_KEYS = ['food', 'soil', 'insight', 'pheromone', 'chitin', 'honeydew', 'leaves', 'fungus'];
const CASTE_KEYS = ['minor', 'soldier', 'supermajor', 'replete'];

/** Hot paths checked every tick: [dotted path, parent getter, key]. */
const HOT = [
  ...RES_KEYS.map((k) => ['run.res.' + k, (s) => s.run && s.run.res, k]),
  ['run.fRun', (s) => s.run, 'fRun'],
  ...CASTE_KEYS.map((k) => ['run.colony.adults.' + k, (s) => s.run && s.run.colony && s.run.colony.adults, k]),
  ['cycle.alates', (s) => s.cycle, 'alates'],
  ['cycle.alatesCycle', (s) => s.cycle, 'alatesCycle'],
  ['era.kinship', (s) => s.era, 'kinship'],
  ['era.kinshipLife', (s) => s.era, 'kinshipLife'],
  ['meta.genes', (s) => s.meta, 'genes'],
  ['meta.genesLife', (s) => s.meta, 'genesLife'],
];

/** Last good hot-path values per state object. @type {WeakMap<object, Float64Array>} */
const shadow = new WeakMap();
/** Paths already logged this session. */
const logged = new Set();

/** Count, report and log one fix. */
function report(s, env, path) {
  if (s.meta && s.meta.stats) s.meta.stats.nanGuards = (Number.isFinite(s.meta.stats.nanGuards) ? s.meta.stats.nanGuards : 0) + 1;
  if (env && typeof env.emit === 'function') env.emit('nanGuard', { path });
  if (!logged.has(path)) {
    logged.add(path);
    console.error('[guard] non-finite value fixed at ' + path);
  }
}

/** Clamp a finite hot value to [0, CLAMP_MAX] (also turns -0 into 0). */
function clampHot(v) {
  if (v > 0) return v < CLAMP_MAX ? v : CLAMP_MAX;
  return 0;
}

/**
 * Every tick: hot paths non-finite → last good value (or 0), clamp to [0, CLAMP_MAX], report.
 * Every GUARD.fullEveryTicks ticks (by s.meta.tick): full walk, any non-finite number → 0 (same reporting).
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Env} env
 * @returns {void}
 */
export function guardTick(s, env) {
  let last = shadow.get(s);
  if (!last) {
    last = new Float64Array(HOT.length);
    shadow.set(s, last);
  }
  for (let i = 0; i < HOT.length; i++) {
    const [path, parentOf, key] = HOT[i];
    const parent = parentOf(s);
    if (!parent) continue;
    let v = parent[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      v = last[i];
      report(s, env, path);
    }
    v = clampHot(v);
    parent[key] = v;
    last[i] = v;
  }
  if (s.meta && s.meta.tick % GUARD.fullEveryTicks === 0) walk(s, s, '', env);
}

/**
 * Recursive walk: non-finite numbers → 0 (reported), |x| > CLAMP_MAX → ±CLAMP_MAX, -0 → 0.
 * @returns {number} non-finite fixes
 */
function walk(s, node, path, env) {
  let fixes = 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'number') {
        const f = fixNumber(v);
        if (f !== v || Object.is(v, -0)) {
          node[i] = f;
          if (!Number.isFinite(v)) {
            fixes++;
            report(s, env, path + '[' + i + ']');
          }
        }
      } else if (v && typeof v === 'object') {
        fixes += walk(s, v, path + '[' + i + ']', env);
      }
    }
  } else {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'number') {
        const f = fixNumber(v);
        if (f !== v || Object.is(v, -0)) {
          node[k] = f;
          if (!Number.isFinite(v)) {
            fixes++;
            report(s, env, path ? path + '.' + k : k);
          }
        }
      } else if (v && typeof v === 'object') {
        fixes += walk(s, v, path ? path + '.' + k : k, env);
      }
    }
  }
  return fixes;
}

/** Non-finite → 0; clamp magnitude to CLAMP_MAX; -0 → 0. */
function fixNumber(v) {
  if (!Number.isFinite(v)) return 0;
  if (v > CLAMP_MAX) return CLAMP_MAX;
  if (v < -CLAMP_MAX) return -CLAMP_MAX;
  if (v === 0) return 0;
  return v;
}

/**
 * Full walk used after load/import: non-finite numbers → 0, hot paths that are not finite numbers (e.g. a NaN saved
 * as null) → 0 and clamped. Each fix increments meta.stats.nanGuards. Resets the hot-path shadow for this state.
 * @param {import('./types.js').State} s
 * @returns {number} number of fixes
 */
export function guardAll(s) {
  if (!s || typeof s !== 'object') return 0;
  let fixes = walk(s, s, '', null);
  const last = new Float64Array(HOT.length);
  for (let i = 0; i < HOT.length; i++) {
    const [path, parentOf, key] = HOT[i];
    const parent = parentOf(s);
    if (!parent || typeof parent !== 'object') continue;
    let v = parent[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      v = 0;
      fixes++;
      report(s, null, path);
    }
    v = clampHot(v);
    parent[key] = v;
    last[i] = v;
  }
  shadow.set(s, last);
  return fixes;
}
