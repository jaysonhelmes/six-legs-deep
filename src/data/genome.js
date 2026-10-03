// Genome nodes (layer-3 purchases paid in genes; never reset), species and signature genes.
// Owner: WP7. Contract: ARCHITECTURE §6.7 (numbers from DESIGN §15.5, §15.6). cost(L) = base × growth^L genes; max 0 = uncapped.

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

/** Display and iteration order (DESIGN §15.5 table order). */
export const GENOME_ORDER = deepFreeze(['genetic_memory', 'haplodiploid_fecundity', 'eusocial_leap', 'metapleural_glands',
  'venom_gland', 'species_leafcutter', 'species_honeypot', 'species_fire_ant', 'dreaming_hive', 'golden_brood', 'ancient_instinct',
  'deep_time_automation', 'thermal_ceiling', 'chronobiology', 'fossil_record', 'colossal_nests', 'unicolonial_sprawl', 'biomes']);

/**
 * Genome nodes: { id, name, cost: { base, growth }, max, fx } (+ stretch: true for STRETCH nodes, which cannot be bought).
 * Consumers per ARCHITECTURE §12.3.
 */
export const GENOME = deepFreeze({
  genetic_memory: { id: 'genetic_memory', name: 'Genetic Memory', cost: { base: 1, growth: 1 }, max: 1, fx: {} },
  haplodiploid_fecundity: { id: 'haplodiploid_fecundity', name: 'Haplodiploid Fecundity', cost: { base: 1, growth: 2 }, max: 5, fx: { mult: 2 } },
  eusocial_leap: { id: 'eusocial_leap', name: 'Eusocial Leap', cost: { base: 2, growth: 1 }, max: 1, fx: {} },
  metapleural_glands: { id: 'metapleural_glands', name: 'Metapleural Glands', cost: { base: 2, growth: 1 }, max: 1, fx: {} },
  venom_gland: { id: 'venom_gland', name: 'Venom Gland', cost: { base: 2, growth: 1 }, max: 1, fx: { atk: 2 } },
  species_leafcutter: { id: 'species_leafcutter', name: 'Leafcutter lineage', cost: { base: 3, growth: 1 }, max: 1, fx: { species: 'leafcutter' } },
  species_honeypot: { id: 'species_honeypot', name: 'Honeypot lineage', cost: { base: 3, growth: 1 }, max: 1, fx: { species: 'honeypot' } },
  species_fire_ant: { id: 'species_fire_ant', name: 'Fire Ant lineage', cost: { base: 3, growth: 1 }, max: 1, fx: { species: 'fire_ant' } },
  dreaming_hive: { id: 'dreaming_hive', name: 'Dreaming Hive', cost: { base: 3, growth: 1 }, max: 1, fx: { capSec: 172800, eff: 1 } },
  golden_brood: { id: 'golden_brood', name: 'Golden Brood', cost: { base: 4, growth: 1 }, max: 1, fx: { chance: 0.01, mult: 10 } },
  ancient_instinct: { id: 'ancient_instinct', name: 'Ancient Instinct', cost: { base: 4, growth: 3 }, max: 3, fx: { mult: 10 } },
  deep_time_automation: { id: 'deep_time_automation', name: 'Deep-Time Automation', cost: { base: 5, growth: 1 }, max: 1, fx: {} },
  thermal_ceiling: { id: 'thermal_ceiling', name: 'Thermal Ceiling', cost: { base: 5, growth: 4 }, max: 5, fx: { mult: 1e6 } },
  chronobiology: { id: 'chronobiology', name: 'Chronobiology', cost: { base: 6, growth: 1 }, max: 1, fx: {} },
  fossil_record: { id: 'fossil_record', name: 'Fossil Record', cost: { base: 8, growth: 1 }, max: 1, fx: {} },
  colossal_nests: { id: 'colossal_nests', name: 'Colossal Nests', cost: { base: 10, growth: 3 }, max: 3, fx: { mult: 10 } },
  unicolonial_sprawl: { id: 'unicolonial_sprawl', name: 'Unicolonial Sprawl', cost: { base: 6, growth: 1.13 }, max: 0, fx: { mult: 2 } },
  biomes: { id: 'biomes', name: 'Biomes', cost: { base: 25, growth: 1 }, max: 1, fx: {}, stretch: true },
});

/** Species display order (DESIGN §15.6; only species that keep both views ship in v1). */
export const SPECIES_ORDER = deepFreeze(['garden_ant', 'leafcutter', 'honeypot', 'fire_ant']);

/** Species: { id, name, sci, gene, sig, mods } — `mods` keys per ARCHITECTURE §6.7 (absent = neutral). */
export const SPECIES = deepFreeze({
  garden_ant: { id: 'garden_ant', name: 'Black Garden Ant', sci: 'Lasius niger', gene: null, sig: 'sig_generalist', mods: {} },
  leafcutter: { id: 'leafcutter', name: 'Leafcutter', sci: 'Atta', gene: 'species_leafcutter', sig: 'sig_fungal_farmers',
    mods: { foodSource: 0.5, leafPlant: 2, phiCoef: 2, eggFungusFrac: 0.25, gardenRowMin: 10 } },
  honeypot: { id: 'honeypot', name: 'Honeypot', sci: 'Myrmecocystus', gene: 'species_honeypot', sig: 'sig_social_stomach',
    mods: { innate: ['living_larders'], repleteCost: 0.25, repleteCap: 5, winterForageHalf: true, foodCap: 0.5 } },
  fire_ant: { id: 'fire_ant', name: 'Fire Ant', sci: 'Solenopsis invicta', gene: 'species_fire_ant', sig: 'sig_polygyne',
    mods: { royalStart: 2, soldierAtk: 1.5, rafts: true, raidMult: 2 } },
});

/** Signature genes (permanent; earned on the first Supercolony as each species). */
export const SIGNATURES = deepFreeze({
  sig_generalist: { id: 'sig_generalist', name: 'Generalist', fx: { all: 1.1 } },
  sig_fungal_farmers: { id: 'sig_fungal_farmers', name: 'Fungal Farmers', fx: { fungus: 2 } },
  sig_social_stomach: { id: 'sig_social_stomach', name: 'Social Stomach', fx: { per: 5, pct: 0.01, max: 0.5 } },
  sig_polygyne: { id: 'sig_polygyne', name: 'Polygyne', fx: { lay: 1.5 } },
});
