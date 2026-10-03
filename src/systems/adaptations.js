// Adaptations: repeatable food-bought upgrades — costs (incl. bulk and the monomorphic cap), availability, purchase
// command and the autobuyer step used by WP7 automation.
// Owner: WP2. Contract: ARCHITECTURE §8.1 (adaptations.js), §9 (buyAdaptation), DESIGN §10, §13.8.
// Effects are applied by stats.recompute (and WP4 for long_legs D_nav), reading ADAPTATIONS[id].fx.
// ARCH-R: the autobuyer's "cheapest" compares the sum of a level's cost components (ties: ADAPTATION_ORDER).

import { ADAPTATION_ORDER, ADAPTATIONS, ADAPT } from '../data/adaptations.js';
import { sumGeo, lvl, clampNum } from '../core/math.js';
import { canAfford, spend } from '../core/wallet.js';

/** Own-property test that is safe for '__proto__' and friends. */
function own(obj, k) {
  return !!obj && typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
}

/** claustral_founding forbids Royal Feeding (DESIGN §13.8). */
function hardshipBlocked(s, id) {
  return id === 'royal_feeding' && s.run.hardship === 'claustral_founding';
}

/**
 * [q] Cost of the next n levels (bulk): Σ base × growth^(L+i). null = MAX (above 1e280), unknown id, bad n, or past
 * the monomorphic cap (L10).
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @param {number} [n=1]
 * @returns {import('../core/types.js').Cost|null}
 */
export function cost(s, id, n = 1) {
  if (!own(ADAPTATIONS, id) || !Number.isInteger(n) || n < 1) return null;
  const L = lvl(s.run.adaptations, id);
  if (s.run.hardship === 'monomorphic' && L + n > ADAPT.monomorphicCap) return null;
  const def = ADAPTATIONS[id].cost;
  return sumGeo(def.base, def.growth, L, n);
}

/**
 * [q] True if the Adaptation's unlock key is set and no hardship blocks it.
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {boolean}
 */
export function isAvailable(s, id) {
  if (!own(ADAPTATIONS, id) || hardshipBlocked(s, id)) return false;
  const u = ADAPTATIONS[id].unlock;
  return !u || !!s.run.unlocked[u];
}

/** Buy n levels (already validated); emits adaptationBought {id, level}. */
function buy(s, id, n, c, env) {
  if (!spend(s, c)) return false;
  const level = clampNum(lvl(s.run.adaptations, id) + n);
  s.run.adaptations[id] = level;
  if (env && typeof env.emit === 'function') env.emit('adaptationBought', { id, level });
  return true;
}

/**
 * [x] WP7 automation: buy one level of the cheapest affordable available Adaptation.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @returns {boolean} true if a level was bought
 */
export function autobuyStep(s, d, env) {
  let best = null;
  let bestCost = null;
  let bestSum = Infinity;
  for (const id of ADAPTATION_ORDER) {
    if (!isAvailable(s, id)) continue;
    const c = cost(s, id, 1);
    if (!c || !canAfford(s, c)) continue;
    let sum = 0;
    for (const k of Object.keys(c)) sum += c[k];
    if (sum < bestSum) {
      best = id;
      bestCost = c;
      bestSum = sum;
    }
  }
  return best ? buy(s, best, 1, bestCost, env) : false;
}

/** Adaptation command handlers (ARCHITECTURE §9). */
export const handlers = {
  /** buyAdaptation { id, n = 1 } */
  buyAdaptation: {
    validate(s, d, cmd) {
      const id = cmd.id;
      if (!own(ADAPTATIONS, id)) return 'invalid';
      const n = cmd.n === undefined ? 1 : cmd.n;
      if (!Number.isInteger(n) || n < 1) return 'invalid';
      if (hardshipBlocked(s, id)) return 'hardship';
      if (!isAvailable(s, id)) return 'locked';
      const c = cost(s, id, n);
      if (!c) return 'max';
      if (!canAfford(s, c)) return 'cantAfford';
      return null;
    },
    apply(s, d, cmd, env) {
      const n = cmd.n === undefined ? 1 : cmd.n;
      const c = cost(s, cmd.id, n);
      if (c) buy(s, cmd.id, n, c, env);
    },
  },
};
