// World data (WP6): the reveal / unlock schedule (DESIGN §23) as UnlockDef[] (ARCHITECTURE §11).
// Owner: WP6. Contract: ARCHITECTURE §6.6, §11. Conditions are evaluated by systems/unlocks.js#evalCond.
// UnlockDef = { key, label, cond, persist, queued, core?, gate? }:
//   persist — once seen (meta.seen) the key is granted at the start of every later run (unlocks.onRunStart, C25);
//   queued  — the UI reveal goes through the REVEAL.gapSec queue; false = immediate (purchase-triggered reveals);
//   core    — C202: a core-loop reveal (crumb → workers → jobs → Gallery → trail → research). It keeps the 30 s gap,
//             while the other queued reveals wait REVEAL.openingGapSec during the opening of the first run;
//   gate    — C202: a reveal-only condition. The key unlocks for gameplay on `cond` as before, but its reveal (UI,
//             `unlock` event) waits in the queue until `gate` also holds (e.g. the Granary waits for the first Gallery);
//   urgent  — C202: a bottleneck id (run.bottleneck.id); while it is the colony's bottleneck the key counts as core
//             (the Granary while the food store is full), so a reveal the player needs right now is not held back.
// Condition language (§11): { adults } · { research } · { trait } · { fed } · { genome } · { flag } · { path, gte | eq } ·
//   { dpath, gte | eq } · { counter, gte } · { runTime, firstRun? } · { custom } · { all: [...] } · { any: [...] },
//   plus the extensions { achievements: n } (achievements earned, lifetime) and { seen: key } (key already revealed,
//   meta.seen; C202). `{ all: [] }` is "always".

import { MOUND } from './surface.js';
import { HARDSHIP, SUPER, SPEC } from './prestige.js';

/** Deep-freeze helper (plain objects and arrays). */
const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/**
 * Reveal queue spacing (DESIGN §23: no two queued reveals within 30 s). C202 (new-player pacing): during the opening of
 * the first run (run.index 0, run.time < openingSec) a reveal that is not `core` waits openingGapSec after the last one.
 */
export const REVEAL = f({ gapSec: 30, openingGapSec: 50, openingSec: 1200 });

/**
 * `eggsBlockPurchase` (egg reserve slider): a purchase is blocked by eggs when its food cost is above stored food but
 * below stored food + the food eggs consumed recently (exponentially weighted over windowSec).
 */
export const EGG_BLOCK = f({ windowSec: 30 });

/** Entry builder: P = persist, Q = queued; x = { core?, gate?, urgent? } (C202). */
const U = (key, label, cond, P, Q, x = null) => ({ key, label, cond, persist: P, queued: Q, ...(x || {}) });
const R = (id) => ({ research: id });
const ALWAYS = { all: [] };
/** C202 extras: a core-loop reveal; reveals that wait for the first Gallery; reveals that wait for the core loop. */
const CORE = { core: true };
const AFTER_GALLERY = { gate: { custom: 'galleryPlaced' } };
const AFTER_CORE = { gate: { custom: 'coreLoop' } };
/** C202: waits until another key is revealed (or 15 min into the first run, like the core-loop gate). */
const AFTER = (key) => ({ gate: { any: [{ seen: key }, { runTime: 900, firstRun: true }] } });

/** The schedule, in evaluation (and same-tick reveal) order. */
export const UNLOCKS = f([
  U('panel_colony', 'Colony panel', { path: 'run.stats.hatched', gte: 1 }, true, true, CORE),
  U('job_digger', 'Diggers and Soil', { adults: 3 }, true, true, CORE),
  U('panel_build', 'Build panel', { custom: 'housingFull' }, true, true, CORE),
  U('chamber_gallery', 'Gallery', { flag: 'panel_build' }, true, false),
  // C202: the Adaptations tab no longer arrives with the Colony panel (two tabs at 0:15); it waits for the first Gallery.
  U('adapt_basic', 'First Adaptations', { flag: 'panel_colony' }, true, true, AFTER_GALLERY),
  U('adapt_digging_claws', 'Digging Claws', { all: [{ custom: 'firstDigger' }, { flag: 'adapt_basic' }] }, true, false),
  U('chamber_granary', 'Granary', { any: [{ path: 'run.fRun', gte: 120 }, { custom: 'foodCapReached' }] }, true, true, { ...AFTER_GALLERY, urgent: 'bn_food_cap' }),
  U('chamber_nursery', 'Nursery', { adults: 8 }, true, true, { ...AFTER_GALLERY, urgent: 'bn_brood_slots' }),
  U('job_scout', 'Scouts', { adults: 12 }, true, true, CORE),
  U('trail_slots', 'Trail slots', { custom: 'crumbSaturated' }, true, true, CORE),
  U('panel_research', 'Research', { custom: 'firstHexRevealed' }, true, true, CORE),
  U('royal_levelup', 'Royal Chamber upgrades', { adults: 20 }, true, true, { ...AFTER_GALLERY, urgent: 'bn_lay_rate' }),
  U('egg_reserve', 'Egg reserve', { all: [{ custom: 'eggsBlockPurchase' }, { flag: 'panel_build' }] }, true, true, AFTER_CORE),
  U('chamber_scent_library', 'Scent Library', { adults: 30 }, true, true, AFTER('panel_research')),
  U('panel_achievements', 'Achievements', { achievements: 3 }, true, true, AFTER_CORE),
  U('adapt_potent_trails', 'Potent Trails', { adults: 40 }, true, true, AFTER('trail_slots')),
  U('golden_beetle', 'Golden Beetles', { runTime: 300, firstRun: true }, true, true, CORE),   // C202: announces a beetle on screen
  U('res_chitin', 'Chitin', { custom: 'firstChitin' }, true, true, CORE),
  U('chamber_midden', 'Midden', { adults: 120 }, true, true, AFTER_CORE),
  U('season_dial', 'Season dial', { runTime: 330, firstRun: true }, true, true, AFTER_CORE),
  U('res_pheromone', 'Pheromone', R('scent_marking'), false, false),
  U('ability_mark', 'Mark and Mass Recruit', R('scent_marking'), false, false),
  U('hex_claim', 'Hex claiming', R('scent_marking'), false, false),
  U('mound', 'Mound', { path: 'run.res.soil', gte: MOUND.unlockSoil }, true, true, AFTER_CORE),
  U('events', 'Random events', { any: [{ path: 'run.events.scripted', eq: true }, { path: 'run.index', gte: 1 }] }, true, true, AFTER_CORE),
  U('panel_war', 'War panel', R('polymorphism'), false, false),
  U('caste_soldier', 'Soldiers', R('polymorphism'), false, false),
  U('chamber_barracks', 'Barracks', R('polymorphism'), false, false),
  U('adapt_military', 'Military Adaptations', R('polymorphism'), false, false),
  U('panel_rivals', 'Rivals', { custom: 'rivalRevealed' }, true, true, { core: true, gate: { custom: 'coreLoop' } }),
  U('job_presets', 'Job presets', { any: [R('age_polyethism'), { trait: 'automaton_instincts' }, { fed: 'automated_brood' }] }, false, false),
  U('job_herder', 'Herders', R('aphid_husbandry'), false, false),
  U('res_honeydew', 'Honeydew', R('aphid_husbandry'), false, false),
  U('chamber_root_aphid_pen', 'Root Aphid Pen', R('aphid_husbandry'), false, false),
  U('adapt_honeydew', 'Honeydew Adaptations', R('aphid_husbandry'), false, false),
  U('climate_overlay', 'Climate overlay', { custom: 'autumnYear0' }, true, true, AFTER_CORE),
  U('panel_prestige', 'Prestige', { custom: 'prestigeTab' }, true, true, CORE),
  U('ability_rally', 'Rally', R('recruitment_pheromones'), false, false),
  U('raid_warnings', 'Raid warnings', { custom: 'rivalEligible' }, true, true, CORE),
  U('frost_line', 'Frost line', { custom: 'firstWinter' }, true, true),
  U('chamber_gate', 'Gate', { any: [{ custom: 'firstRaidWarning' }, { runTime: 1500 }] }, true, true, AFTER_CORE),
  U('job_leafcutter', 'Leafcutters', R('leafcutting'), false, false),
  U('chamber_hibernaculum', 'Hibernaculum', R('overwintering'), false, false),
  U('chamber_nuptial_chamber', 'Nuptial Chamber', R('nuptial_preparation'), false, false),
  U('alate_rearing', 'Alate rearing', R('nuptial_preparation'), false, false),
  U('fungus_widget', 'Fungus and Nutrition', R('fungiculture'), false, false),
  U('chamber_fungus_garden', 'Fungus Garden', R('fungiculture'), false, false),
  U('job_gardener', 'Gardeners', R('fungiculture'), false, false),
  U('res_fungus', 'Fungus', R('fungiculture'), false, false),
  U('chamber_thermal_chimney', 'Thermal Chimney', R('ventilation_shafts'), false, false),
  U('chamber_repletion_hall', 'Repletion Hall', R('living_larders'), false, false),
  U('caste_replete', 'Repletes', R('living_larders'), false, false),
  U('chamber_deep_vault', 'Deep Vault', R('acid_excavation'), false, false),
  U('chamber_water_well', 'Water Well', { custom: 'waterRevealed' }, false, true),
  U('caste_supermajor', 'Supermajors', R('supermajors'), false, false),
  U('chamber_war_hall', 'War Hall', R('supermajors'), false, false),
  // C179: the chitin chambers. The Store comes with chitin itself (or Polymorphism); the Workshop with a built Barracks
  // (any contributing level) or the Phalanx research.
  U('chamber_carapace_store', 'Carapace Store', { any: [{ flag: 'res_chitin' }, R('polymorphism')] }, false, true),
  U('chamber_carapace_workshop', 'Carapace Workshop', { any: [R('phalanx'), { dpath: 'nest.agg.barracksL', gte: 0.01 }] }, false, false),
  U('adapt_long_legs', 'Long Legs', R('tandem_running'), false, false),
  U('ability_frenzy', 'Frenzy', R('frenzy_signal'), false, false),
  U('panel_map', 'Map', { all: [{ custom: 'secondTrailOrClaim' }, { flag: 'trail_slots' }] }, true, true, CORE),
  U('flight_button', 'Nuptial Flight', { custom: 'flightReady' }, false, true, CORE),
  U('tab_bloodline', 'Bloodline', { counter: 'flights', gte: 1 }, true, true),
  U('tab_hardships', 'Hardships', { counter: 'alatesLife', gte: HARDSHIP.unlockAlates }, true, true),
  U('tab_federation_teaser', 'Federation (preview)', { counter: 'alatesLife', gte: SUPER.teaserAlates }, true, true),
  U('tab_federation', 'Federation', { counter: 'supercolonies', gte: 1 }, true, true),
  U('tab_edicts', 'Royal Edicts', { counter: 'supercolonies', gte: 1 }, true, true),
  U('tab_genome_teaser', 'Genome (preview)', { any: [{ path: 'era.kinshipLife', gte: SPEC.teaserKinship }, { counter: 'speciations', gte: 1 }] },
    true, true),
  U('tab_genome', 'Genome and Species', { counter: 'speciations', gte: 1 }, true, true),
  U('tab_guide', 'Field Guide', ALWAYS, true, false),
  U('tab_stats', 'Stats', ALWAYS, true, false),
  U('tab_settings', 'Settings', ALWAYS, true, false),
]);
