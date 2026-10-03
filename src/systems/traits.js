// Bloodline / Federation / Genome purchases and their costs. Owner: WP7. Contract: ARCHITECTURE §8.6, §9
// (DESIGN §13.7, §14.5, §15.5). Costs: { alates } / { kinship } / { genes }; null = MAX (level cap or > COST_MAX).
// ARCH-R: §6.7 writes trait/node costs as { base, growth } with a NUMBER base (cost(L) = base × growth^L of the layer
// currency), unlike the generic { base: Cost, growth } shape of §6; the queries below return the Cost object.
// STRETCH Genome nodes (`stretch: true`, i.e. biomes) are listed but refused with 'locked'.
// Buying seasonal_wisdom while the landing chooser is open lets that landing choose its season.

import { TRAITS } from '../data/bloodline.js';
import { FEDERATION } from '../data/federation.js';
import { GENOME } from '../data/genome.js';
import { geoCost, costOrNull } from '../core/math.js';
import { canAfford, spend } from '../core/wallet.js';

/** Level of an id in a level map: a finite non-negative number, else 0. */
function lv(map, id) {
  const v = map ? map[id] : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Cost of the next level of a node in currency `res`, or null at the level cap / beyond COST_MAX.
 * @param {Object|undefined} node data entry { cost, max }
 * @param {number} L levels owned
 * @param {'alates'|'kinship'|'genes'} res
 * @returns {import('../core/types.js').Cost|null}
 */
function nodeCost(node, L, res) {
  if (!node || !node.cost) return null;
  if (node.max > 0 && L >= node.max) return null;
  const c = node.cost;
  if (Array.isArray(c.list)) {
    const i = Math.floor(L);
    return i < c.list.length ? costOrNull({ [res]: Math.ceil(c.list[i] - 1e-9) }) : null;
  }
  // Alates, kinship and genes are whole-number currencies (DESIGN §13.2 / §14.2 / §15.2 floor every award), so a
  // fractional geometric cost (5 × 3.5^1 = 17.5) is rounded UP to the next whole unit (F18, ARCHITECTURE §18).
  const g = geoCost({ [res]: c.base }, c.growth, L);
  return g ? costOrNull({ [res]: Math.ceil(g[res] - 1e-9) }) : null;
}

/**
 * Next Bloodline level cost { alates: base × growth^L }, null at max.
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {import('../core/types.js').Cost|null}
 */
export function traitCost(s, id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(TRAITS, id)) return null;
  return nodeCost(TRAITS[id], lv(s.cycle.traits, id), 'alates');
}

/**
 * Next Federation level cost { kinship }, null at max.
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {import('../core/types.js').Cost|null}
 */
export function fedCost(s, id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(FEDERATION, id)) return null;
  return nodeCost(FEDERATION[id], lv(s.era.federation, id), 'kinship');
}

/**
 * Next Genome level cost { genes }, null at max (max 0 = uncapped until COST_MAX).
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {import('../core/types.js').Cost|null}
 */
export function genomeCost(s, id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(GENOME, id)) return null;
  return nodeCost(GENOME[id], lv(s.meta.genome, id), 'genes');
}

/** Shared validate: unknown id → 'invalid:id', MAX → 'max', unaffordable → 'cantAfford'. */
function buyReason(table, id, costFn, s) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(table, id)) return 'invalid:id';
  const cost = costFn(s, id);
  if (!cost) return 'max';
  return canAfford(s, cost) ? null : 'cantAfford';
}

/** Commands owned by WP7 traits (ARCHITECTURE §9). */
export const handlers = {
  /** buyTrait { id }: next Bloodline level (alates). Allowed while paused. */
  buyTrait: {
    validate(s, d, cmd) {
      return buyReason(TRAITS, cmd.id, traitCost, s);
    },
    apply(s, d, cmd) {
      if (!spend(s, traitCost(s, cmd.id))) return;
      s.cycle.traits[cmd.id] = lv(s.cycle.traits, cmd.id) + 1;
      const p = s.meta.pending;
      if (cmd.id === 'seasonal_wisdom' && p && p.kind === 'landing') p.chooseSeason = true;
    },
  },

  /** buyFederation { id }: next Federation level (kinship). Allowed while paused. */
  buyFederation: {
    validate(s, d, cmd) {
      return buyReason(FEDERATION, cmd.id, fedCost, s);
    },
    apply(s, d, cmd) {
      if (!spend(s, fedCost(s, cmd.id))) return;
      s.era.federation[cmd.id] = lv(s.era.federation, cmd.id) + 1;
    },
  },

  /** buyGenome { id }: next Genome level (genes); species_* nodes also unlock their species. Allowed while paused. */
  buyGenome: {
    validate(s, d, cmd) {
      if (typeof cmd.id === 'string' && Object.prototype.hasOwnProperty.call(GENOME, cmd.id) && GENOME[cmd.id].stretch) return 'locked';
      return buyReason(GENOME, cmd.id, genomeCost, s);
    },
    apply(s, d, cmd) {
      if (!spend(s, genomeCost(s, cmd.id))) return;
      s.meta.genome[cmd.id] = lv(s.meta.genome, cmd.id) + 1;
      const sp = GENOME[cmd.id].fx && GENOME[cmd.id].fx.species;
      if (typeof sp === 'string') s.meta.speciesUnlocked[sp] = true;
    },
  },
};
