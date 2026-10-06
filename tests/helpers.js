// Shared test helpers: state/derived builders, a fake env, a fixed-step runner, snapshots, a fake storage, state
// walkers, and a deterministic random-command generator (fuzz + determinism tests).
// Owner: WP1. Contract: ARCHITECTURE §15.2 (newState, makeDerived, fakeEnv, stepFor, snapshot).

import { createState, adultsTotal } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { step, makeEnv } from '../src/core/step.js';
import { addEffect } from '../src/core/effects.js';
import { rand, randInt, pick, chance } from '../src/core/rng.js';
import { TICK, CLAMP_MAX, GRID, HEX } from '../src/data/balance.js';
import { JOB_ORDER } from '../src/data/jobs.js';
import { ADAPTATION_ORDER } from '../src/data/adaptations.js';
import { CHAMBER_ORDER } from '../src/data/chambers.js';
import { RESEARCH_ORDER, BRANCH_ORDER } from '../src/data/research.js';
import { TRAIT_ORDER } from '../src/data/bloodline.js';
import { FED_ORDER } from '../src/data/federation.js';
import { GENOME_ORDER, SPECIES_ORDER } from '../src/data/genome.js';
import { BOONS, EDICTS, HARDSHIPS } from '../src/data/prestige.js';
import { UNLOCKS } from '../src/data/unlocks.js';

// ------------------------------------------------------------------------------------------------------------------
// §15.2 helpers
// ------------------------------------------------------------------------------------------------------------------

/**
 * Fresh skeleton state (ARCHITECTURE §4).
 * @param {number} [seed=1]
 */
export function newState(seed = 1) {
  return createState({ seed });
}

/** @returns {boolean} true for a plain object (not array / typed array) */
function isPlainObject(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o) && !ArrayBuffer.isView(o);
}

/** Deep-merge `src` into `dst` (plain objects merge; arrays, typed arrays and leaves replace). */
function mergeInto(dst, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isPlainObject(v) && isPlainObject(dst[k])) mergeInto(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}

/**
 * createDerived() with overrides deep-merged in (e.g. makeDerived({ stats: { foodCap: 300 } })).
 * @param {Object} [overrides]
 */
export function makeDerived(overrides = {}) {
  return mergeInto(createDerived(), overrides || {});
}

/**
 * A tick environment like step() builds (events collected in env.events).
 * @param {{ offline?: boolean, eff?: number, econScale?: number, dt?: number }} [opts]
 */
export function fakeEnv({ offline = false, eff = 1, econScale = 1, dt = TICK } = {}) {
  return makeEnv(dt, { offline, eff, econScale });
}

/**
 * Run the real step() for `seconds` in steps of dt. commands: { [tickIndex]: Command | Command[] } (tick 0 = first).
 * @returns {Array<Object>} every event emitted, in order
 */
export function stepFor(s, d, seconds, { dt = 0.1, commands = {} } = {}) {
  const n = Math.floor(seconds / dt + 1e-9);
  const all = [];
  for (let i = 0; i < n; i++) {
    const c = commands[i];
    const cmds = c === undefined ? [] : Array.isArray(c) ? c : [c];
    const ev = step(s, d, dt, cmds, {});
    for (const e of ev) all.push(e);
  }
  return all;
}

/** JSON deep copy of a state. */
export function snapshot(s) {
  return JSON.parse(JSON.stringify(s));
}

// ------------------------------------------------------------------------------------------------------------------
// Extra helpers (WP1 tests)
// ------------------------------------------------------------------------------------------------------------------

/**
 * In-memory Storage double. `failOn` (Set of op names 'get' | 'set' | 'remove') makes those calls throw.
 */
export function makeFakeStorage(initial = {}, failOn = new Set()) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    failOn,
    getItem(k) {
      if (failOn.has('get')) throw new Error('get failed');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (failOn.has('set')) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (failOn.has('remove')) throw new Error('remove failed');
      map.delete(k);
    },
  };
}

/**
 * Find schema violations in a state: non-finite numbers, |x| > CLAMP_MAX, undefined values, non-plain objects
 * (Map, Set, typed arrays, class instances). Returns up to `limit` problem strings.
 */
export function findBadValues(state, limit = 20) {
  const out = [];
  const visit = (v, path) => {
    if (out.length >= limit) return;
    if (v === undefined) { out.push(path + ' = undefined'); return; }
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) out.push(path + ' = ' + v);
      else if (Math.abs(v) > CLAMP_MAX) out.push(path + ' = ' + v + ' (> CLAMP_MAX)');
      return;
    }
    if (typeof v !== 'object') { out.push(path + ' has type ' + typeof v); return; }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) visit(v[i], path + '[' + i + ']');
      return;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) { out.push(path + ' is not a plain object'); return; }
    for (const k of Object.keys(v)) visit(v[k], path ? path + '.' + k : k);
  };
  visit(state, '');
  return out;
}

/** Remove randomness that the contract leaves to WP5/WP6 (events, beetles, raids) for comparison tests. */
export function quietWorld(s) {
  s.run.events.scripted = true;
  s.run.events.nextIn = 1e12;
  s.run.golden.beetleIn = 1e12;
  s.run.golden.lastPupaAt = 1e12;
  addEffect(s, { id: 'no_raids', stat: 'no_raids', t: -1 });
}

/** adultsTotal + alatesReared + Σ brood (the "nobody died" population measure). */
export function livePopulation(s) {
  let b = 0;
  for (const c of s.run.colony.brood) b += c.n;
  return adultsTotal(s) + s.run.colony.alatesReared + b;
}

// ------------------------------------------------------------------------------------------------------------------
// Deterministic random-command generator (ARCHITECTURE §9 argument shapes)
// ------------------------------------------------------------------------------------------------------------------

// Documented id lists (ARCHITECTURE §6 / DESIGN); unioned with the live data tables so the generator stays useful
// both against stubs and after integration.
const DOC = {
  castes: ['minor', 'soldier', 'supermajor', 'replete', 'alate'],
  jobs: ['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener'],
  adaptations: ['quick_dispatch', 'strong_mandibles', 'royal_feeding', 'digging_claws', 'potent_trails', 'serrated_mandibles',
    'thick_cuticle', 'sweet_tooth', 'queens_feast', 'long_legs'],
  chambers: ['royal_chamber', 'gallery', 'nursery', 'granary', 'scent_library', 'midden', 'barracks', 'war_hall', 'carapace_store',
    'carapace_workshop', 'root_aphid_pen',
    'fungus_garden', 'repletion_hall', 'hibernaculum', 'thermal_chimney', 'gate', 'water_well', 'nuptial_chamber', 'deep_vault'],
  research: ['trail_memory', 'scent_marking', 'tandem_running', 'recruitment_pheromones', 'double_bridge', 'persistent_trails',
    'sun_compass', 'mass_recruitment', 'frenzy_signal', 'trunk_trails', 'odometer_navigation', 'coordinated_digging',
    'load_chains', 'clay_masonry', 'mound_building', 'drainage', 'ventilation_shafts', 'thermoregulation', 'gallery_arches',
    'acid_excavation', 'compact_galleries', 'antennation', 'chemical_lexicon', 'pheromone_glands', 'early_warning',
    'seasonal_clock', 'overwintering', 'weather_sense', 'hive_mind', 'brood_care', 'age_polyethism', 'royal_pheromones',
    'trophic_eggs', 'thermal_brood_shuttling', 'nuptial_preparation', 'response_thresholds', 'living_larders',
    'spermathecal_reserve', 'supermajors', 'aphid_husbandry', 'leafcutting', 'aphid_shepherding', 'fungiculture',
    'lycaenid_clients', 'root_cultivation', 'sugar_economy', 'weeder_ants', 'fungal_symbiosis', 'polymorphism', 'formic_acid',
    'ritual_tournaments', 'phalanx', 'field_triage', 'propaganda_pheromones', 'siege_tactics', 'war_chemistry',
    'collective_memory', 'diapause_logic'],
  branches: ['foraging', 'excavation', 'brood', 'husbandry', 'warfare', 'communication'],
  traits: ['founding_stores', 'nanitic_vigor', 'remembered_paths', 'ancestral_blueprint', 'automaton_instincts', 'hardy_workers',
    'deep_diggers', 'keen_antennae', 'fertile_queen', 'ancestral_memory', 'long_memory', 'warrior_lineage', 'royal_court',
    'seasonal_wisdom', 'swarm_instinct', 'sweet_inheritance', 'wide_wings', 'vast_galleries', 'brood_bank', 'polygyny', 'budding'],
  federation: ['automated_brood', 'blueprint_memory', 'autobuyers', 'auto_flight', 'aquifer_access', 'heirloom_bloodline',
    'satellite_nest', 'regional_expansion', 'megacolony_galleries', 'highway_network', 'diapause_mastery', 'queens_council', 'megacolony'],
  genome: ['genetic_memory', 'haplodiploid_fecundity', 'eusocial_leap', 'metapleural_glands', 'venom_gland', 'species_leafcutter',
    'species_honeypot', 'species_fire_ant', 'dreaming_hive', 'golden_brood', 'ancient_instinct', 'deep_time_automation',
    'thermal_ceiling', 'chronobiology', 'fossil_record', 'colossal_nests', 'unicolonial_sprawl'],
  species: ['garden_ant', 'leafcutter', 'honeypot', 'fire_ant'],
  hardships: ['eternal_winter', 'claustral_founding', 'pacifist', 'barren_ground', 'shallow_soil', 'monomorphic'],
  seasons: ['spring', 'summer', 'autumn', 'winter'],
};

const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));
const IDS = {
  castes: DOC.castes,
  jobs: union(JOB_ORDER, DOC.jobs),
  adaptations: union(ADAPTATION_ORDER, DOC.adaptations),
  chambers: union(CHAMBER_ORDER, DOC.chambers),
  research: union(RESEARCH_ORDER, DOC.research),
  branches: union(BRANCH_ORDER, DOC.branches),
  traits: union(TRAIT_ORDER, DOC.traits),
  federation: union(FED_ORDER, DOC.federation),
  genome: union(GENOME_ORDER, DOC.genome),
  species: union(SPECIES_ORDER, DOC.species),
  hardships: union(Object.keys(HARDSHIPS), DOC.hardships),
  boons: Object.keys(BOONS),
  edicts: Object.keys(EDICTS),
  unlocks: UNLOCKS.map((u) => u.key),
};

/** Every unlock key (live table ∪ ARCHITECTURE §11 list). */
export const DOC_UNLOCK_KEYS = ['panel_colony', 'adapt_basic', 'job_digger', 'adapt_digging_claws', 'panel_build',
  'chamber_gallery', 'chamber_granary', 'chamber_nursery', 'job_scout', 'trail_slots', 'panel_research', 'royal_levelup',
  'egg_reserve', 'chamber_scent_library', 'panel_achievements', 'adapt_potent_trails', 'golden_beetle', 'res_chitin',
  'chamber_midden', 'season_dial', 'res_pheromone', 'ability_mark', 'hex_claim', 'mound', 'events', 'panel_war',
  'caste_soldier', 'chamber_barracks', 'adapt_military', 'panel_rivals', 'job_presets', 'job_herder', 'res_honeydew',
  'chamber_root_aphid_pen', 'adapt_honeydew', 'climate_overlay', 'panel_prestige', 'ability_rally', 'raid_warnings',
  'frost_line', 'chamber_gate', 'job_leafcutter', 'chamber_hibernaculum', 'chamber_nuptial_chamber', 'alate_rearing',
  'fungus_widget', 'chamber_fungus_garden', 'job_gardener', 'res_fungus', 'chamber_thermal_chimney', 'chamber_repletion_hall',
  'caste_replete', 'chamber_deep_vault', 'chamber_water_well', 'caste_supermajor', 'chamber_war_hall', 'chamber_carapace_store',
  'chamber_carapace_workshop', 'adapt_long_legs', 'ability_frenzy',
  'panel_map', 'flight_button', 'tab_bloodline', 'tab_hardships', 'tab_federation_teaser', 'tab_federation', 'tab_edicts',
  'tab_genome_teaser', 'tab_genome', 'tab_guide', 'tab_stats', 'tab_settings'];

/** Documented id lists (exported for the contract test). */
export const DOC_IDS = DOC;

/** Argument kinds per command type (ARCHITECTURE §9). */
export const COMMAND_ARGS = {
  setSetting: { key: 'settingKey', value: 'settingValue' },
  uiFlag: { key: 'flagKey', value: 'bool' },
  equipCosmetic: { slot: 'cosSlot', id: 'cosmeticId' },
  clickForage: { src: 'sourceUid' },
  setCasteTargets: { soldier: 'count', supermajor: 'count', replete: 'count' },
  setCasteFill: { caste: 'caste', on: 'bool' },
  setEggReserve: { frac: 'frac' },
  setChitinReserve: { amount: 'count' },
  setFungalBrood: { on: 'bool' },
  rearAlate: { n: 'count' },
  groomBrood: { chamber: 'chamberUid' },
  clickQueen: {},
  retireAdults: { caste: 'caste', n: 'count' },
  shiftJob: { from: 'jobOrIdle', to: 'jobOrIdle', n: 'count' },
  setJobs: { jobs: 'jobMap' },
  setJobTargets: { targets: 'jobFracMap' },
  setAutoJobs: { on: 'bool' },
  setThresholdJobs: { on: 'bool' },
  saveJobPreset: { slot: 'slot', name: 'name' },
  applyJobPreset: { slot: 'slot' },
  buyAdaptation: { id: 'adaptationId', n: 'smallCount' },
  placeChamber: { chamber: 'chamberType', x: 'col', y: 'row', route: 'cellsOrNull', shaftCol: 'col' },
  levelChamber: { uid: 'chamberUid', dir: 'dir' },
  relocateChamber: { uid: 'chamberUid', x: 'col', y: 'row', route: 'cellsOrNull' },
  demolishChamber: { uid: 'chamberUid' },
  digTunnel: { cells: 'cells' },
  digTo: { cell: 'cell' },
  backfill: { cells: 'cells' },
  reorderQueue: { uid: 'jobUid', to: 'smallCount' },
  cancelJob: { uid: 'jobUid' },
  helpDig: {},
  saveBlueprint: { slot: 'slot', name: 'name' },
  loadBlueprint: { slot: 'slot' },
  deleteBlueprint: { slot: 'slot' },
  cancelPlanned: { cell: 'cell', all: 'bool' },
  backfillUnneeded: {},
  drainPocket: { pocket: 'smallCount' },
  relocatePocket: { pocket: 'smallCount', x: 'col', y: 'row' },
  growRoot: { col: 'col' },
  editBlueprint: { slot: 'slot', blueprint: 'name' },
  claimHex: { hex: 'hex' },
  cancelChannel: {},
  flagHex: { hex: 'hex', on: 'bool' },
  buyMound: {},
  moveAphids: { src: 'sourceUid', hex: 'hex' },
  drawTrail: { origin: 'originHex', target: 'sourceHex', waypoints: 'hexes' },
  rerouteTrail: { uid: 'trailUid', waypoints: 'hexes' },
  deleteTrail: { uid: 'trailUid' },
  assignWorkers: { uid: 'trailUid', n: 'count' },
  assignEscorts: { uid: 'trailUid', n: 'count' },
  mark: { uid: 'trailUid' },
  rally: { uid: 'trailUid' },
  frenzy: {},
  massRecruit: { src: 'sourceUid' },
  launchParty: { kind: 'partyKind', target: 'partyTarget', soldier: 'count', supermajor: 'count' },
  recallParty: { uid: 'partyUid' },
  reinforce: { battle: 'battleUid', soldier: 'count', supermajor: 'count' },
  battleAction: { battle: 'battleUid', action: 'battleAction' },
  bribe: { rival: 'rivalUid' },
  tournament: { rival: 'rivalUid', hex: 'hex', minor: 'count', soldier: 'count', supermajor: 'count' },
  tournamentChoice: { uid: 'battleUid', choice: 'word' },
  dispatchGuard: { raid: 'raidUid' },
  buyResearch: { id: 'researchId' },
  buyRefinement: { branch: 'branchId' },
  buyArchive: { branch: 'branchId' },
  setChronobiology: { lengthSec: 'seasonLen', start: 'seasonId' },
  eventChoice: { uid: 'cardUid', choice: 'eventChoice' },
  clickEventObject: { uid: 'objectUid' },
  scrapeMold: { uid: 'objectUid' },
  bailFlood: {},
  cleanBlight: {},
  clickBeetle: {},
  clickPupa: { choice: 'pupaChoice' },
  openGift: { index: 'slot' },
  fly: {},
  chooseLanding: { index: 'slot', boon: 'boonId', season: 'seasonId' },
  supercolony: { edict: 'edictId' },
  speciate: { species: 'speciesId' },
  setHeirlooms: { ids: 'traitIds' },
  placeSatellite: { hex: 'hex', col: 'col' },
  buyTrait: { id: 'traitId' },
  buyFederation: { id: 'fedId' },
  buyGenome: { id: 'genomeId' },
  startHardship: { id: 'hardshipId' },
  setAutomation: { patch: 'automationPatch' },
  spendDiapause: { on: 'bool' },
};

const GARBAGE = [null, undefined, NaN, Infinity, -Infinity, -1, -0, 0.5, 1e300, -1e300, 'zzz', '', {}, [], true, '__proto__'];
const COUNTS = [0, 1, 2, 3, 5, 10, 25, 100, 1e4, 1e9];
const FRACS = [0, 0.05, 0.1, 0.25, 0.3, 0.5, 0.9];

/** Uids from a list of objects with `uid`, plus a random miss. */
function uidFrom(h, list) {
  if (list && list.length > 0 && chance(h, 0.85)) return pick(h, list).uid;
  return randInt(h, 0, 50);
}

/** A short contiguous cell path starting next to the main shaft or a random cell. */
function cellPath(h) {
  const len = randInt(h, 1, 8);
  let x = chance(h, 0.6) ? GRID.mainCol + (chance(h, 0.5) ? 1 : -1) : randInt(h, 0, GRID.cols - 1);
  let y = randInt(h, 0, 30);
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(y * GRID.cols + x);
    if (chance(h, 0.5)) x += chance(h, 0.5) ? 1 : -1;
    else y += 1;
    x = Math.max(0, Math.min(GRID.cols - 1, x));
    y = Math.max(0, Math.min(GRID.rows - 1, y));
  }
  return out;
}

/** Generate one value of the given argument kind. */
function genArg(h, kind, s) {
  const run = s.run;
  switch (kind) {
    case 'settingKey': return pick(h, ['notation', 'autosaveSec', 'reducedMotion', 'sound', 'harshNature', 'retreatAt', 'colonyName', 'queenName', 'showScaleLabel', 'bogus']);
    case 'settingValue': return pick(h, ['suffix', 'scientific', 'engineering', 15, 30, 60, 0, true, false, 0.5, 'Formica', 2, -1]);
    case 'flagKey': return pick(h, ['hint_trail', 'hint_dig', 'ending', 'x'.repeat(100), '']);
    case 'bool': return chance(h, 0.5);
    case 'cosSlot': return pick(h, ['banner', 'queen', 'trail']);
    case 'cosmeticId': {
      const owned = Object.keys(s.meta.cosmetics.owned);
      return chance(h, 0.3) ? null : owned.length && chance(h, 0.5) ? pick(h, owned) : 'cos_unknown';
    }
    case 'sourceUid': return uidFrom(h, run.surface.sources);
    case 'frac': return pick(h, FRACS);
    case 'count': return pick(h, COUNTS);
    case 'smallCount': return randInt(h, 0, 5);
    case 'chamberUid': return uidFrom(h, run.nest.chambers);
    case 'caste': return pick(h, [...IDS.castes, 'queen']);
    case 'jobOrIdle': return pick(h, [...IDS.jobs, 'idle']);
    case 'jobMap': {
      const m = {};
      for (const j of IDS.jobs) if (chance(h, 0.6)) m[j] = pick(h, COUNTS);
      return m;
    }
    case 'jobFracMap': {
      const m = {};
      for (const j of IDS.jobs) m[j] = pick(h, FRACS);
      return m;
    }
    case 'slot': return randInt(h, -1, 5);
    case 'name': return pick(h, ['Preset', 'Deep', '']);
    case 'adaptationId': return pick(h, IDS.adaptations);
    case 'chamberType': return pick(h, IDS.chambers);
    case 'col': return randInt(h, 0, GRID.cols - 1);
    case 'row': return randInt(h, 0, 40);
    case 'cellsOrNull': return chance(h, 0.7) ? null : cellPath(h);
    case 'dir': return pick(h, ['left', 'right', 'up', 'down', undefined]);
    case 'cells': return cellPath(h);
    case 'cell': return randInt(h, 0, GRID.cols * GRID.rows - 1);
    case 'jobUid': return uidFrom(h, run.nest.queue);
    case 'hex': return chance(h, 0.8) ? randInt(h, 0, 216) : randInt(h, 0, HEX.count - 1);
    case 'originHex': return chance(h, 0.8) ? 0 : randInt(h, 0, 60);
    case 'sourceHex': return run.surface.sources.length && chance(h, 0.8) ? pick(h, run.surface.sources).hex : randInt(h, 0, 216);
    case 'hexes': {
      const n = randInt(h, 0, 2);
      const out = [];
      for (let i = 0; i < n; i++) out.push(randInt(h, 0, 60));
      return out;
    }
    case 'trailUid': return uidFrom(h, run.surface.trails);
    case 'partyKind': return pick(h, ['raid', 'assault', 'hunt', 'termite', 'bogus']);
    case 'partyTarget': {
      if (chance(h, 0.5)) return { type: 'rival', uid: uidFrom(h, run.rivals.list) };
      if (chance(h, 0.8)) return { type: 'source', uid: uidFrom(h, run.surface.sources) };
      return null;
    }
    case 'partyUid': return uidFrom(h, run.war.parties);
    case 'battleUid': return uidFrom(h, run.war.battles);
    case 'battleAction': return pick(h, ['alarm_rally', 'mobilize', 'retreat', 'dance']);
    case 'rivalUid': return uidFrom(h, run.rivals.list);
    case 'raidUid': return uidFrom(h, run.war.raids);
    case 'word': return pick(h, ['yes', 'no', 'flip', 'escalate']);
    case 'researchId': return pick(h, IDS.research);
    case 'branchId': return pick(h, IDS.branches);
    case 'seasonLen': return pick(h, [180, 360, 720, 100, 1000]);
    case 'seasonId': return pick(h, [...DOC.seasons, undefined]);
    case 'cardUid': return run.events.card && chance(h, 0.8) ? run.events.card.uid : randInt(h, 0, 20);
    case 'eventChoice': return pick(h, ['adopt', 'devour', 'send', 'wait', 'mob', 'reroute', 'ignore']);
    case 'objectUid': return uidFrom(h, run.events.objects);
    case 'pupaChoice': return pick(h, ['frenzy', 'windfall', 'nap']);
    case 'boonId': {
      const p = s.meta.pending;
      return p && Array.isArray(p.boons) && p.boons.length && chance(h, 0.8) ? pick(h, p.boons) : pick(h, IDS.boons.length ? IDS.boons : ['boon_x']);
    }
    case 'edictId': return pick(h, [...IDS.edicts, null]);
    case 'speciesId': return pick(h, IDS.species);
    case 'traitIds': return IDS.traits.slice(0, randInt(h, 0, 4));
    case 'traitId': return pick(h, IDS.traits);
    case 'fedId': return pick(h, IDS.federation);
    case 'genomeId': return pick(h, IDS.genome);
    case 'hardshipId': return pick(h, IDS.hardships);
    case 'automationPatch': return pick(h, [
      { autobuy: { on: true } }, { autoGuard: true }, { autoRear: true }, { autoFlight: { on: true, mode: 'alates', alates: 10 } },
      { autobuy: { priority: ['mound', 'chambers', 'adaptations'] } }, { bogus: 1 }, null]);
    default: return null;
  }
}

/**
 * Random command for the current state. types: candidate command types (sorted for determinism).
 * pGarbage: chance that each argument is replaced by a garbage value (NaN, null, strings …).
 * @returns {Object}
 */
export function randomCommand(h, s, types, { pGarbage = 0.05 } = {}) {
  const type = pick(h, types);
  const cmd = { type };
  const spec = COMMAND_ARGS[type] || {};
  for (const [key, kind] of Object.entries(spec)) {
    cmd[key] = chance(h, pGarbage) ? GARBAGE[Math.floor(rand(h) * GARBAGE.length)] : genArg(h, kind, s);
  }
  return cmd;
}

/** All unlock keys known to the data table or the contract. */
export function allUnlockKeys() {
  return union(IDS.unlocks, DOC_UNLOCK_KEYS);
}

/** Documented-or-live id lists used by extreme-state builders. */
export const LIVE_IDS = IDS;
