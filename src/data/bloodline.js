// Bloodline traits (layer-1 purchases paid in alates; reset at a Supercolony except Heirlooms).
// Owner: WP7. Contract: ARCHITECTURE §6.7 (numbers from DESIGN §13.7). cost(L) = cost.base × cost.growth^L alates.

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

/** Display and iteration order (DESIGN §13.7 table order). */
export const TRAIT_ORDER = deepFreeze(['founding_stores', 'nanitic_vigor', 'remembered_paths', 'ancestral_blueprint',
  'automaton_instincts', 'hardy_workers', 'deep_diggers', 'keen_antennae', 'fertile_queen', 'ancestral_memory', 'long_memory',
  'warrior_lineage', 'royal_court', 'seasonal_wisdom', 'swarm_instinct', 'sweet_inheritance', 'wide_wings', 'vast_galleries',
  'brood_bank', 'polygyny', 'budding']);

/** Bloodline traits: { id, name, cost: { base, growth }, max, fx }. Consumers per ARCHITECTURE §12.2. */
export const TRAITS = deepFreeze({
  founding_stores: { id: 'founding_stores', name: 'Founding Stores', cost: { base: 1, growth: 3 }, max: 3, fx: {} },
  nanitic_vigor: { id: 'nanitic_vigor', name: 'Nanitic Vigor', cost: { base: 2, growth: 1 }, max: 1, fx: { eggs: 25, workers: 50, mult: 3 } },
  remembered_paths: { id: 'remembered_paths', name: 'Remembered Paths', cost: { base: 2, growth: 1 }, max: 1, fx: { trails: 2, strength: 0.5 } },
  ancestral_blueprint: { id: 'ancestral_blueprint', name: 'Ancestral Blueprint', cost: { base: 3, growth: 1 }, max: 1,
    fx: { cellDiv: 3, placeMult: 0.5 } },
  automaton_instincts: { id: 'automaton_instincts', name: 'Automaton Instincts', cost: { base: 5, growth: 1 }, max: 1, fx: { queue: 2 } },
  hardy_workers: { id: 'hardy_workers', name: 'Hardy Workers', cost: { base: 5, growth: 3.5 }, max: 12, fx: { mult: 1.4 } },
  deep_diggers: { id: 'deep_diggers', name: 'Deep Diggers', cost: { base: 5, growth: 3.5 }, max: 12, fx: { mult: 1.4 } },
  keen_antennae: { id: 'keen_antennae', name: 'Keen Antennae', cost: { base: 5, growth: 1 }, max: 1, fx: { reveal: 4, scout: 2 } },
  fertile_queen: { id: 'fertile_queen', name: 'Fertile Queen', cost: { base: 8, growth: 3.5 }, max: 10, fx: { mult: 1.25 } },
  ancestral_memory: { id: 'ancestral_memory', name: 'Ancestral Memory', cost: { base: 8, growth: 1 }, max: 1, fx: { runs: 2 } },
  long_memory: { id: 'long_memory', name: 'Long Memory', cost: { base: 10, growth: 4 }, max: 3, fx: { capSec: 7200, eff: 0.10 } },
  warrior_lineage: { id: 'warrior_lineage', name: 'Warrior Lineage', cost: { base: 10, growth: 3 }, max: 5, fx: { mult: 1.25 } },
  royal_court: { id: 'royal_court', name: 'Royal Court', cost: { base: 15, growth: 1 }, max: 1, fx: { cells: 50, maxL: 9, reared: 50 } },
  seasonal_wisdom: { id: 'seasonal_wisdom', name: 'Seasonal Wisdom', cost: { base: 20, growth: 1 }, max: 1, fx: { winterR: 0.25 } },
  swarm_instinct: { id: 'swarm_instinct', name: 'Swarm Instinct', cost: { base: 20, growth: 4 }, max: 5, fx: { mult: 1.5 } },
  sweet_inheritance: { id: 'sweet_inheritance', name: 'Sweet Inheritance', cost: { base: 25, growth: 1 }, max: 1,
    fx: { mult: 2, aphidLevel: 2, ring: 2 } },
  wide_wings: { id: 'wide_wings', name: 'Wide Wings', cost: { base: 40, growth: 5 }, max: 5, fx: { mult: 1.15 } },
  vast_galleries: { id: 'vast_galleries', name: 'Vast Galleries', cost: { base: 50, growth: 4 }, max: 10, fx: { mult: 1.2 } },
  brood_bank: { id: 'brood_bank', name: 'Brood Bank', cost: { base: 100, growth: 1 }, max: 1, fx: {} },
  polygyny: { id: 'polygyny', name: 'Polygyny', cost: { base: 250, growth: 1 }, max: 1, fx: { royal: 1 } },
  budding: { id: 'budding', name: 'Budding', cost: { base: 500, growth: 1 }, max: 1, fx: {} },
});
