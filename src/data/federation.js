// Federation nodes (layer-2 purchases paid in kinship; reset at a Speciation).
// Owner: WP7. Contract: ARCHITECTURE §6.7 (numbers from DESIGN §14.5).
// cost: { base, growth } → base × growth^L kinship, or { list: [...] } → list[L] kinship.

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

/** Display and iteration order (DESIGN §14.5 table order). */
export const FED_ORDER = deepFreeze(['automated_brood', 'blueprint_memory', 'architects_table', 'autobuyers', 'auto_flight', 'aquifer_access',
  'heirloom_bloodline', 'satellite_nest', 'regional_expansion', 'megacolony_galleries', 'highway_network', 'diapause_mastery',
  'queens_council', 'megacolony']);

/** Federation nodes: { id, name, cost, max, fx, requires? }. Consumers per ARCHITECTURE §12.3. */
export const FEDERATION = deepFreeze({
  automated_brood: { id: 'automated_brood', name: 'Automated Brood', cost: { base: 1, growth: 1 }, max: 1, fx: {} },
  blueprint_memory: { id: 'blueprint_memory', name: 'Blueprint Library', cost: { base: 1, growth: 1 }, max: 1, fx: { slots: 5, cellDiv: 5 } },
  // C172: Architect's Table, the hand editor for saved blueprints (the nest UI reads fedLevel(s, 'architects_table')).
  // `requires`: buyFederation refuses the node with 'locked' until that node is owned.
  architects_table: { id: 'architects_table', name: "Architect's Table", cost: { base: 3, growth: 1 }, max: 1, requires: 'blueprint_memory',
    fx: {} },
  autobuyers: { id: 'autobuyers', name: 'Autobuyers', cost: { base: 2, growth: 1 }, max: 1, fx: {} },
  auto_flight: { id: 'auto_flight', name: 'Auto-Flight', cost: { base: 3, growth: 1 }, max: 1, fx: {} },
  aquifer_access: { id: 'aquifer_access', name: 'Aquifer Access', cost: { base: 3, growth: 1 }, max: 1, fx: {} },
  heirloom_bloodline: { id: 'heirloom_bloodline', name: 'Heirloom Bloodline', cost: { base: 5, growth: 1 }, max: 1, fx: { keep: 3 } },
  satellite_nest: { id: 'satellite_nest', name: 'Satellite Nest', cost: { list: [2, 3, 5, 8, 13, 21, 34] }, max: 7,
    fx: { foodDig: 0.25, slots: 1, radius: 1, census: 0.25, minDist: 3, colGap: 4 } },
  regional_expansion: { id: 'regional_expansion', name: 'Regional Expansion', cost: { base: 6, growth: 1 }, max: 1, fx: { radius: 16, rivals: 4 } },
  megacolony_galleries: { id: 'megacolony_galleries', name: 'Megacolony Galleries', cost: { base: 4, growth: 2 }, max: 5, fx: { mult: 2 } },
  highway_network: { id: 'highway_network', name: 'Highway Network', cost: { base: 8, growth: 1 }, max: 1, fx: { dNav: 5 } },
  diapause_mastery: { id: 'diapause_mastery', name: 'Diapause Mastery', cost: { base: 10, growth: 1 }, max: 1,
    fx: { capSec: 86400, eff: 1, speed: 3 } },
  queens_council: { id: 'queens_council', name: "Queens' Council", cost: { base: 13, growth: 1 }, max: 1, fx: { royal: 2 } },
  megacolony: { id: 'megacolony', name: 'Megacolony', cost: { base: 50, growth: 1 }, max: 1, fx: {} },
});
