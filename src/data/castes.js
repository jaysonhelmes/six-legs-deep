// Caste table: egg multipliers, extra egg costs, upkeep, combat stats, brood-time factors and housing kind per caste.
// Owner: WP2. Contract: ARCHITECTURE §6.2 (numbers from DESIGN §5.2, §5.3, §5.7, §6.1, §13.5).

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

/** Display and iteration order of the castes that lay eggs and develop (the queen is not in it). */
export const CASTE_ORDER = deepFreeze(['minor', 'soldier', 'supermajor', 'replete', 'alate']);

/**
 * Castes keyed by id.
 * - eggMult: multiplier on E(N) (DESIGN §5.2).
 * - extra: extra egg cost per resource. Value forms: number (flat) | { base, perOwned } = base + perOwned × adults of that
 *   caste | { base, growth } = base × growth^(eggs of that caste laid this run).
 * - upkeep: food/s per adult (alates: per reared alate in its cell). broodFactor: caste factor on brood time.
 * - house: the d.stats capacity the caste lives in ('housing' | 'berths' (Barracks: soldiers) | 'warBerths'
 *   (War Hall: supermajors, C136) | 'repleteBerths' | 'alateCells').
 * - atk / hp: per-unit base combat stats (minor = militia). size: tournament size (DESIGN §9.7).
 * - unlock: unlock key (§11) that makes the caste available on the caste slider, or null.
 */
export const CASTES = deepFreeze({
  queen: { id: 'queen', name: 'Queen', upkeep: 0 },
  minor: { id: 'minor', name: 'Minor worker', eggMult: 1, extra: {}, upkeep: 0.05, atk: 0.5, hp: 4, broodFactor: 1, house: 'housing',
    size: 1, unlock: null },
  soldier: { id: 'soldier', name: 'Soldier', eggMult: 5, extra: { chitin: { base: 1, perOwned: 0.02 } }, upkeep: 0.25, atk: 4, hp: 20,
    broodFactor: 1.7, house: 'berths', size: 3, unlock: 'caste_soldier' },
  supermajor: { id: 'supermajor', name: 'Supermajor', eggMult: 50, extra: { chitin: 25, fungus: 5 }, upkeep: 1.0, atk: 30, hp: 250,
    broodFactor: 3.75, house: 'warBerths', size: 10, unlock: 'caste_supermajor' },
  replete: { id: 'replete', name: 'Replete', eggMult: 20, extra: { honeydew: 10 }, upkeep: 0.02, broodFactor: 2.5, house: 'repleteBerths',
    size: 1, unlock: 'caste_replete', fx: { capBonus: 0.02, winterCover: 0.05, winterCoverMax: 0.5 } },
  alate: { id: 'alate', name: 'Alate', eggMult: 20, extra: { honeydew: { base: 5, growth: 1.15 } }, upkeep: 0.5, broodFactor: 5,
    house: 'alateCells', size: 1, unlock: 'alate_rearing' },
});
