// INTEGRATION TEST — ARCHITECTURE §15.3 #17 (contract test). Owner: WP1.
// Every export named in §6–§8 exists with the right kind/arity (fn.length counts parameters before the first default),
// the command registry builds with no duplicates and covers the §9 catalogue, and the data tables are consistent.
// Against the WP1 stubs the export/arity checks pass; the catalogue, data-content and "no stubs left" checks are
// EXPECTED TO FAIL until every package has landed (§17 step 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRegistry, REGISTRY, HANDLER_MODULES } from '../src/core/commands.js';
import { createGame } from '../src/core/game.js';
import { DOC_UNLOCK_KEYS } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// kind: number = function arity; 'number' | 'string' | 'array' | 'object' | 'set' = value type.
const CORE = {
  'core/state.js': { SCHEMA_VERSION: 'number', createState: 0, createRun: 1, createCycle: 0, createEra: 0, defaultNestCells: 0,
    adultsTotal: 1, broodTotal: 1, popN: 1, clickAvailable: 1, consumeClick: 1 },
  'core/derived.js': { createDerived: 0 },
  'core/step.js': { step: 3 },
  'core/game.js': { createGame: 0 },
  'core/commands.js': { HANDLER_MODULES: 'array', CORE_HANDLERS: 'object', PAUSE_OK: 'set', buildRegistry: 0, validateCommand: 3, applyCommand: 4 },
  'core/actions.js': { createActions: 1, PRESTIGE_TYPES: 'set' },
  'core/bus.js': { createBus: 0 },
  'core/rng.js': { nextU32: 1, rand: 1, randInt: 3, randRange: 3, chance: 2, pick: 2, weighted: 2, shuffle: 2, expSample: 2, makeHolder: 1, deriveSeed: 1 },
  'core/math.js': { sc: 3, scChain: 2, clampNum: 1, geoCost: 3, costOrNull: 1, lvl: 2, safeDiv: 2, sumGeo: 4, lerp: 3, approxEq: 2 },
  'core/hex.js': { DIRS: 'array', HEX_COUNT: 'number', countInRadius: 1, hexIndex: 2, hexQR: 1, ringOf: 1, neighbors: 1, hexDist: 2,
    hexToPixel: 2, pixelToHex: 3, hexesInRadius: 1, hexPath: 3, lineHexes: 2, colForHex: 1 },
  'core/wallet.js': { canAfford: 2, missing: 2, spend: 2, refund: 3, grant: 4, incomeSeconds: 3, timeToAfford: 3, scaleCost: 2 },
  'core/effects.js': { addEffect: 2, removeEffect: 2, removeEffectsWhere: 2, tickEffects: 3, effectMult: 2, effectAdd: 2, hasEffect: 2, effectsFor: 2 },
  'core/guard.js': { guardTick: 2, guardAll: 1 },
  'core/save.js': { RLE_PATHS: 'array', rleEncode: 1, rleDecode: 1, encodeState: 1, decodeState: 1, fnv1a: 1, utf8ToBase64: 1, base64ToUtf8: 1,
    toExportString: 2, fromExportString: 1, storageWrap: 1 },
  'core/migrations.js': { MIGRATIONS: 'object', migrate: 1, fillDefaults: 1 },
  'core/offline.js': { offlineCapEff: 2, offlineSchedule: 1, simulateOffline: 3, bankBeyondCap: 2, bankSavedFinds: 2 },
};

const SYSTEMS = {
  'systems/stats.js': { recompute: 3, eggCost: 3, winterR: 2 },
  'systems/economy.js': { tick: 4, handlers: 'object', winterProjection: 2 },
  'systems/population.js': { tick: 4, handlers: 'object', addAdults: 4, killAdults: 5, killBrood: 3, stealBrood: 2, broodAllocation: 2, broodSummary: 2 },
  'systems/jobs.js': { tick: 4, handlers: 'object', idleMinors: 1, jobCap: 3, releaseMinors: 2 },
  'systems/adaptations.js': { handlers: 'object', cost: 2, isAvailable: 2, autobuyStep: 3 },
  'systems/bottleneck.js': { tick: 4 },
  'systems/nestgeom.js': { idx: 2, xy: 1, inBounds: 2, layerOf: 1, footprint: 2, rectCells: 4, cellWork: 3, isDiggable: 2, bfs: 2, routeTo: 3,
    adjacent: 4, exposedTo: 2 },
  'systems/nestgen.js': { generateNest: 1 },
  'systems/nest.js': { derive: 2, tick: 4, handlers: 'object', validatePlacement: 5, placementCost: 2, levelInfo: 3, findPlacement: 3,
    chamberAtCell: 3, cellInfo: 3, queueShaft: 5, applyBlueprint: 2, autoLevelStep: 3, moleTunnel: 3 },
  'systems/mapgen.js': { generateMap: 1 },
  'systems/surface.js': { derive: 2, tick: 4, handlers: 'object', isPassable: 3, moveCost: 3, claimCost: 1, canClaim: 3, moundCost: 1, sourceAt: 2,
    nuptialHex: 3, spawnSource: 3, removeSource: 4, revealHexes: 3, conquerHexes: 3, grantHex: 3, touch: 1, addEntrance: 6 },   // C246: autoMoundStep removed (no Mound autobuyer)
  'systems/trails.js': { tick: 4, handlers: 'object', previewTrail: 4, trailYield: 4, bestTargets: 2, trailOrigins: 2, hitTrail: 3, cutTrailsAt: 3,
    resetStrength: 2, autoDraw: 4, createTrail: 4 },
  'systems/combat.js': { unitStats: 3, armyAP: 3, rivalAP: 3, preview: 4, startBattle: 4, stepBattles: 4, grantReward: 4 },
  'systems/rivals.js': { tick: 4, handlers: 'object', spawnInitial: 3, createRival: 2, rivalLand: 2, previewAction: 5, garrison: 2, startEventBattle: 4 },
  'systems/raids.js': { tick: 4, handlers: 'object' },
  'systems/research.js': { handlers: 'object', isAvailable: 2, isOwned: 2, cost: 2, refinementCost: 2, branchComplete: 2, grantInnate: 1 },
  'systems/seasons.js': { tick: 4, skipTime: 2, setSeason: 2, addExtraSpring: 2, seasonAt: 2, handlers: 'object' },
  'systems/events.js': { tick: 4, handlers: 'object', forceEvent: 4, eligible: 3 },
  'systems/golden.js': { tick: 4, handlers: 'object', spawnBeetle: 2 },
  'systems/achievements.js': { tick: 4, progress: 3, nextGoals: 2 },
  'systems/fieldguide.js': { tick: 4 },
  'systems/unlocks.js': { tick: 4, evalCond: 3, isUnlocked: 2, isRevealed: 2, onRunStart: 2 },
  'systems/prestige.js': { derive: 2, tick: 4, handlers: 'object', newGame: 2, startRun: 3, doFlight: 3, doSupercolony: 4, projectAlates: 2,
    projectKinship: 2, projectGenes: 2, landingPreview: 2 },
  'systems/traits.js': { handlers: 'object', traitCost: 2, fedCost: 2, genomeCost: 2 },
  'systems/hardships.js': { tick: 4, handlers: 'object', goal: 1, effectiveTier: 2 },
  'systems/automation.js': { tick: 4, handlers: 'object' },
};

const DATA = {
  'data/balance.js': { TICK: 'number', COMBAT_STEP: 'number', CLAMP_MAX: 'number', COST_MAX: 'number', CLICK_CAP: 'number', FOOD_OVERFLOW: 'number',
    GRID: 'object', CELL: 'object', HEX: 'object', SOFTCAPS: 'object', OFFLINE: 'object', DIAPAUSE: 'object', SAVE: 'object', LOOP: 'object', GUARD: 'object' },
  'data/castes.js': { CASTE_ORDER: 'array', CASTES: 'object' },
  'data/jobs.js': { JOB_ORDER: 'array', JOBS: 'object', LOOSE_FORAGE: 'number', THRESHOLDS: 'object' },
  'data/economy.js': { EGG: 'object', LAY: 'object', BROOD: 'object', UPKEEP: 'object', HUNGRY: 'object', NUTRITION: 'object', PHEROMONE: 'object',
    CAPS: 'object', CLICK: 'object', SPOILAGE: 'object', BOTTLENECK: 'object' },
  'data/adaptations.js': { ADAPTATION_ORDER: 'array', ADAPTATIONS: 'object', ADAPT: 'object' },
  'data/strata.js': { LAYER_ORDER: 'array', LAYERS: 'object', MICRO: 'object', DIG: 'object', GEOM: 'object' },
  'data/chambers.js': { CHAMBER_ORDER: 'array', CHAMBERS: 'object', CHAMBER_RULES: 'object', ADJACENCY: 'object' },
  'data/soilFeatures.js': { ROOTS: 'object', STONES: 'object', CACHES: 'object', WATER: 'object', SITE_MODS: 'object' },
  'data/surface.js': { MAP: 'object', TERRAIN_ORDER: 'array', TERRAIN: 'object', SCOUT: 'object', TRAIL: 'object', SLOTS: 'object', ABILITIES: 'object',
    TERRITORY: 'object', MOUND: 'object' },
  'data/sources.js': { SOURCE_ORDER: 'array', SOURCES: 'object' },
  'data/rivals.js': { RIVAL_ORDER: 'array', RIVALS: 'object', ELDER: 'object', GROWTH: 'object', TRAITS: 'object', BOSSES: 'object', SPAWN: 'object' },
  'data/combat.js': { BATTLE: 'object', ACTIONS: 'object', REWARDS: 'object', TACTICAL: 'object', RAIDS: 'object' },
  'data/research.js': { BRANCH_ORDER: 'array', BRANCHES: 'object', RESEARCH_ORDER: 'array', RESEARCH: 'object', REFINEMENT: 'object', INNATE: 'object' },
  'data/seasons.js': { SEASON_ORDER: 'array', LONG_SUMMER_ORDER: 'array', YEAR: 'object', SEASON_MODS: 'object', FROST: 'object' },
  'data/events.js': { EVENT_RULES: 'object', EVENT_ORDER: 'array', EVENTS: 'object', GOLDEN: 'object', SAVED_FINDS: 'object' },
  'data/achievements.js': { ACH_ORDER: 'array', ACHIEVEMENTS: 'object' },
  'data/fieldGuide.js': { FG_ORDER: 'array', FIELD_GUIDE: 'object', FG_REWARD: 'object' },
  'data/unlocks.js': { UNLOCKS: 'array' },
  'data/prestige.js': { FLIGHT: 'object', LINEAGE: 'object', SUPER: 'object', SPEC: 'object', PASSIVE: 'object', ACH_BONUS: 'object', HARDSHIP: 'object',
    HARDSHIPS: 'object', SITES: 'object', BOONS: 'object', EDICTS: 'object', LANDING: 'object', RESET: 'object', FOUNDING_STORES: 'array' },
  'data/bloodline.js': { TRAIT_ORDER: 'array', TRAITS: 'object' },
  'data/federation.js': { FED_ORDER: 'array', FEDERATION: 'object' },
  'data/genome.js': { GENOME_ORDER: 'array', GENOME: 'object', SPECIES_ORDER: 'array', SPECIES: 'object', SIGNATURES: 'object' },
};

/** §8 handler keys per system module (= the §9 catalogue minus the core handlers). */
const HANDLERS = {
  'systems/economy.js': ['clickForage'],
  'systems/population.js': ['setCasteTargets', 'setCasteFill', 'setEggReserve', 'setChitinReserve', 'setFungalBrood', 'rearAlate', 'cancelRear', 'groomBrood', 'clickQueen', 'retireAdults'],
  'systems/jobs.js': ['shiftJob', 'setJobs', 'setJobTargets', 'setAutoJobs', 'setThresholdJobs', 'saveJobPreset', 'applyJobPreset'],
  'systems/adaptations.js': ['buyAdaptation'],
  'systems/nest.js': ['placeChamber', 'levelChamber', 'relocateChamber', 'demolishChamber', 'digTunnel', 'digTo', 'backfill', 'reorderQueue',
    'cancelJob', 'helpDig', 'saveBlueprint', 'loadBlueprint', 'deleteBlueprint', 'cancelPlanned', 'backfillUnneeded', 'drainPocket',
    'relocatePocket', 'growRoot', 'editBlueprint', 'setAutoBackfill', 'clearBlueprint'],
  'systems/surface.js': ['claimHex', 'cancelChannel', 'flagHex', 'moveAphids'],   // C220: buyMound removed (the Mound grows on its own)
  'systems/trails.js': ['drawTrail', 'rerouteTrail', 'deleteTrail', 'assignWorkers', 'assignEscorts', 'mark', 'rally', 'frenzy', 'massRecruit'],
  'systems/rivals.js': ['launchParty', 'recallParty', 'reinforce', 'battleAction', 'bribe', 'tournament', 'tournamentChoice'],
  'systems/raids.js': ['dispatchGuard'],
  'systems/research.js': ['buyResearch', 'buyRefinement', 'buyArchive'],
  'systems/seasons.js': ['setChronobiology'],
  'systems/events.js': ['eventChoice', 'clickEventObject', 'scrapeMold', 'bailFlood', 'cleanBlight', 'clearAntlion'],
  'systems/golden.js': ['clickBeetle', 'clickPupa', 'openGift'],
  'systems/prestige.js': ['fly', 'chooseLanding', 'supercolony', 'speciate', 'setHeirlooms', 'placeSatellite'],
  'systems/traits.js': ['buyTrait', 'buyFederation', 'buyGenome'],
  'systems/hardships.js': ['startHardship'],
  'systems/automation.js': ['setAutomation', 'spendDiapause'],
};

const mods = {};
async function load(rel) {
  if (!mods[rel]) mods[rel] = await import('../src/' + rel);
  return mods[rel];
}

/** Describe the kind of a value for messages. */
function kindOf(v) {
  if (typeof v === 'function') return 'function/' + v.length;
  if (Array.isArray(v)) return 'array';
  if (v instanceof Set) return 'set';
  if (v === null) return 'null';
  return typeof v;
}

/** Check a module against its spec; returns problem strings. */
function checkExports(rel, m, spec) {
  const out = [];
  for (const [name, want] of Object.entries(spec)) {
    const v = m[name];
    if (v === undefined) { out.push(rel + ': missing export ' + name); continue; }
    if (typeof want === 'number') {
      if (typeof v !== 'function') out.push(rel + ': ' + name + ' should be a function, is ' + kindOf(v));
      else if (v.length !== want) out.push(rel + ': ' + name + ' arity ' + v.length + ', contract ' + want);
    } else if (want === 'array' ? !Array.isArray(v) : want === 'set' ? !(v instanceof Set)
      : want === 'object' ? !(v && typeof v === 'object' && !Array.isArray(v)) : typeof v !== want) {
      out.push(rel + ': ' + name + ' should be ' + want + ', is ' + kindOf(v));
    }
  }
  return out;
}

test('core exports match ARCHITECTURE §7 (names, kinds, arity)', async () => {
  const problems = [];
  for (const [rel, spec] of Object.entries(CORE)) problems.push(...checkExports(rel, await load(rel), spec));
  const g = createGame({ nowMs: 0 });
  const api = { newGame: 1, loadOrNew: 1, advance: 2, catchUp: 2, dispatch: 1, tickOnce: 0, runFor: 1, save: 1, exportString: 1, importString: 2, hardReset: 1 };
  problems.push(...checkExports('game instance', g, api));
  problems.push(...checkExports('bus instance', g.bus, { on: 2, off: 2, emit: 1, clear: 0 }));
  assert.deepEqual(problems, []);
});

test('system exports match ARCHITECTURE §8 (names, kinds, arity)', async () => {
  const problems = [];
  for (const [rel, spec] of Object.entries(SYSTEMS)) problems.push(...checkExports(rel, await load(rel), spec));
  assert.deepEqual(problems, []);
});

test('data exports match ARCHITECTURE §6 (names and kinds)', async () => {
  const problems = [];
  for (const [rel, spec] of Object.entries(DATA)) problems.push(...checkExports(rel, await load(rel), spec));
  assert.deepEqual(problems, []);
});

test('command registry builds with no duplicate types; HANDLER_MODULES order per §7.4', async () => {
  assert.doesNotThrow(() => buildRegistry());
  const order = ['economy', 'population', 'jobs', 'adaptations', 'nest', 'surface', 'trails', 'rivals', 'raids', 'research', 'seasons',
    'events', 'golden', 'prestige', 'traits', 'hardships', 'automation'];
  for (let i = 0; i < order.length; i++) assert.equal(HANDLER_MODULES[i], await load('systems/' + order[i] + '.js'), order[i]);
});

test('[post-integration] every §9 command is registered by its owner with validate() and apply()', async () => {
  const problems = [];
  for (const [rel, types] of Object.entries(HANDLERS)) {
    const h = (await load(rel)).handlers || {};
    for (const t of types) {
      if (!h[t]) problems.push(rel + ': missing handler ' + t);
      else if (typeof h[t].validate !== 'function' || typeof h[t].apply !== 'function') problems.push(rel + ': ' + t + ' needs validate() and apply()');
    }
    for (const t of Object.keys(h)) if (!types.includes(t)) problems.push(rel + ': command ' + t + ' is not in the §9 catalogue');
  }
  const all = new Set(['setSetting', 'uiFlag', 'equipCosmetic', ...Object.values(HANDLERS).flat()]);
  for (const t of Object.keys(REGISTRY)) if (!all.has(t)) problems.push('registry: unexpected type ' + t);
  assert.equal(all.size, 3 + Object.values(HANDLERS).flat().length, 'catalogue has no duplicates');
  assert.deepEqual(problems, []);
});

/** [ORDER export, table export, extra table keys allowed outside ORDER]. */
const ORDER_PAIRS = [
  ['data/castes.js', 'CASTE_ORDER', 'CASTES', ['queen']],
  ['data/jobs.js', 'JOB_ORDER', 'JOBS', []],
  ['data/adaptations.js', 'ADAPTATION_ORDER', 'ADAPTATIONS', []],
  ['data/strata.js', 'LAYER_ORDER', 'LAYERS', []],
  ['data/chambers.js', 'CHAMBER_ORDER', 'CHAMBERS', []],
  ['data/surface.js', 'TERRAIN_ORDER', 'TERRAIN', []],
  ['data/sources.js', 'SOURCE_ORDER', 'SOURCES', []],
  ['data/rivals.js', 'RIVAL_ORDER', 'RIVALS', []],
  ['data/research.js', 'BRANCH_ORDER', 'BRANCHES', []],
  ['data/research.js', 'RESEARCH_ORDER', 'RESEARCH', []],
  ['data/events.js', 'EVENT_ORDER', 'EVENTS', []],
  ['data/achievements.js', 'ACH_ORDER', 'ACHIEVEMENTS', []],
  ['data/fieldGuide.js', 'FG_ORDER', 'FIELD_GUIDE', []],
  ['data/bloodline.js', 'TRAIT_ORDER', 'TRAITS', []],
  ['data/federation.js', 'FED_ORDER', 'FEDERATION', []],
  ['data/genome.js', 'GENOME_ORDER', 'GENOME', []],
  ['data/genome.js', 'SPECIES_ORDER', 'SPECIES', []],
];

test('data integrity: every *_ORDER matches its table, entries repeat their id, no duplicates', async () => {
  const problems = [];
  for (const [rel, oName, tName, extra] of ORDER_PAIRS) {
    const m = await load(rel);
    const order = m[oName];
    const table = m[tName];
    if (new Set(order).size !== order.length) problems.push(rel + ': ' + oName + ' has duplicates');
    for (const id of order) {
      if (!table[id]) problems.push(rel + ': ' + oName + ' id ' + id + ' missing from ' + tName);
      else if (table[id].id !== id) problems.push(rel + ': ' + tName + '.' + id + '.id is ' + table[id].id);
    }
    for (const id of Object.keys(table)) {
      if (!order.includes(id) && !extra.includes(id)) problems.push(rel + ': ' + tName + '.' + id + ' not in ' + oName);
    }
  }
  const seasons = await load('data/seasons.js');
  for (const id of seasons.SEASON_ORDER) if (!seasons.SEASON_MODS[id]) problems.push('data/seasons.js: SEASON_MODS.' + id + ' missing');
  const unlocks = (await load('data/unlocks.js')).UNLOCKS;
  const keys = unlocks.map((u) => u && u.key);
  if (new Set(keys).size !== keys.length) problems.push('data/unlocks.js: duplicate unlock keys');
  for (const u of unlocks) {
    if (!u || typeof u.key !== 'string' || !u.cond || typeof u.persist !== 'boolean' || typeof u.queued !== 'boolean') {
      problems.push('data/unlocks.js: malformed UnlockDef ' + JSON.stringify(u));
    }
  }
  assert.deepEqual(problems, []);
});

test('data integrity: every unlock key referenced by a data table exists in UNLOCKS; research prerequisites exist', async () => {
  const problems = [];
  const keys = new Set((await load('data/unlocks.js')).UNLOCKS.map((u) => u.key));
  const walk = (v, path) => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v) && typeof v.unlock === 'string' && !keys.has(v.unlock)) problems.push(path + '.unlock = ' + v.unlock + ' (not in UNLOCKS)');
    for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
  };
  for (const rel of Object.keys(DATA)) {
    if (rel === 'data/unlocks.js') continue;
    const m = await load(rel);
    for (const [name, v] of Object.entries(m)) walk(v, rel + ':' + name);
  }
  const { RESEARCH, BRANCHES } = await load('data/research.js');
  for (const [id, r] of Object.entries(RESEARCH)) {
    for (const p of r.prereq || []) if (!RESEARCH[p]) problems.push('research ' + id + ': prerequisite ' + p + ' does not exist');
    if (!BRANCHES[r.branch]) problems.push('research ' + id + ': unknown branch ' + r.branch);
  }
  assert.deepEqual(problems, []);
});

test('[post-integration] data content: documented ORDER arrays, table sizes and every §11 unlock key', async () => {
  const problems = [];
  const eq = (rel, name, want) => async () => {
    const got = (await load(rel))[name];
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(rel + ': ' + name + ' = ' + JSON.stringify(got));
  };
  await eq('data/castes.js', 'CASTE_ORDER', ['minor', 'soldier', 'supermajor', 'replete', 'alate'])();
  await eq('data/jobs.js', 'JOB_ORDER', ['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener'])();
  await eq('data/strata.js', 'LAYER_ORDER', ['topsoil', 'loam', 'clay', 'gravel', 'bedrock', 'aquifer'])();
  await eq('data/surface.js', 'TERRAIN_ORDER', ['grass', 'sand', 'leaf_litter', 'garden_path', 'tree_root', 'stone', 'puddle', 'log'])();
  await eq('data/rivals.js', 'RIVAL_ORDER', ['black_garden_ants', 'pavement_ants', 'red_wood_ants', 'carpenter_ants', 'fire_ants', 'slave_makers'])();
  await eq('data/research.js', 'BRANCH_ORDER', ['foraging', 'excavation', 'brood', 'husbandry', 'warfare', 'communication'])();
  await eq('data/seasons.js', 'SEASON_ORDER', ['spring', 'summer', 'autumn', 'winter'])();
  await eq('data/seasons.js', 'LONG_SUMMER_ORDER', ['spring', 'summer', 'summer', 'autumn'])();
  const size = async (rel, name, n) => {
    const got = (await load(rel))[name].length;
    if (got !== n) problems.push(rel + ': ' + name + ' has ' + got + ' entries, DESIGN has ' + n);
  };
  await size('data/chambers.js', 'CHAMBER_ORDER', 19); // C136 War Hall, C179 Carapace Store / Workshop
  await size('data/adaptations.js', 'ADAPTATION_ORDER', 10);
  await size('data/research.js', 'RESEARCH_ORDER', 58);
  await size('data/events.js', 'EVENT_ORDER', 28);
  await size('data/achievements.js', 'ACH_ORDER', 81);
  await size('data/fieldGuide.js', 'FG_ORDER', 40);
  await size('data/sources.js', 'SOURCE_ORDER', 17); // C188 expedition finds (rich seed patch, beetle carcass)
  const src = (await load('data/sources.js')).SOURCE_ORDER;
  if (!src.includes('termite_swarm')) problems.push('data/sources.js: termite_swarm missing (C7)');
  if (src.includes('gift')) problems.push('data/sources.js: gift must not be a source');
  const terrain = (await load('data/surface.js')).TERRAIN;
  (await load('data/surface.js')).TERRAIN_ORDER.forEach((id, i) => {
    if (terrain[id] && terrain[id].code !== i) problems.push('TERRAIN.' + id + '.code should be ' + i);
  });
  const keys = new Set((await load('data/unlocks.js')).UNLOCKS.map((u) => u.key));
  for (const k of DOC_UNLOCK_KEYS) if (!keys.has(k)) problems.push('UNLOCKS: missing §11 key ' + k);
  assert.deepEqual(problems, []);
});

test('[post-integration] ids are unique per namespace and carry their prefixes (DESIGN Appendix A)', async () => {
  const problems = [];
  const owner = new Map();
  const claim = (set, ids) => {
    for (const id of ids) {
      if (owner.has(id) && owner.get(id) !== set) problems.push('id ' + id + ' appears in ' + owner.get(id) + ' and ' + set);
      owner.set(id, set);
    }
  };
  claim('resources', ['food', 'soil', 'insight', 'pheromone', 'chitin', 'honeydew', 'leaves', 'fungus']);
  claim('castes', Object.keys((await load('data/castes.js')).CASTES));
  claim('jobs', (await load('data/jobs.js')).JOB_ORDER);
  claim('chambers', (await load('data/chambers.js')).CHAMBER_ORDER);
  claim('layers', (await load('data/strata.js')).LAYER_ORDER);
  claim('research', (await load('data/research.js')).RESEARCH_ORDER);
  claim('adaptations', (await load('data/adaptations.js')).ADAPTATION_ORDER);
  claim('traits', (await load('data/bloodline.js')).TRAIT_ORDER);
  claim('federation', (await load('data/federation.js')).FED_ORDER);
  claim('genome', (await load('data/genome.js')).GENOME_ORDER);
  claim('sources', (await load('data/sources.js')).SOURCE_ORDER);
  claim('rivals', (await load('data/rivals.js')).RIVAL_ORDER);
  claim('abilities', Object.keys((await load('data/surface.js')).ABILITIES));
  const prefixed = [
    ['data/achievements.js', 'ACH_ORDER', /^ach_/], ['data/events.js', 'EVENT_ORDER', /^ev_/], ['data/fieldGuide.js', 'FG_ORDER', /^fg_/],
  ];
  for (const [rel, name, re] of prefixed) for (const id of (await load(rel))[name]) if (!re.test(id)) problems.push(name + ': ' + id + ' lacks prefix');
  const p = await load('data/prestige.js');
  for (const [name, re] of [['SITES', /^site_/], ['BOONS', /^boon_/], ['EDICTS', /^edict_/]]) {
    for (const id of Object.keys(p[name])) if (!re.test(id)) problems.push(name + ': ' + id + ' lacks prefix');
  }
  for (const id of Object.keys((await load('data/genome.js')).SIGNATURES)) if (!/^sig_/.test(id)) problems.push('SIGNATURES: ' + id);
  for (const id of Object.keys((await load('data/chambers.js')).ADJACENCY)) if (!/^(adj|hyg|prox)_/.test(id)) problems.push('ADJACENCY: ' + id);
  assert.deepEqual(problems, []);
});

test('[post-integration] no STUB files remain in src/systems and src/data', () => {
  const stubs = [];
  for (const dir of ['systems', 'data']) {
    for (const f of readdirSync(join(ROOT, 'src', dir))) {
      if (!f.endsWith('.js')) continue;
      const first = readFileSync(join(ROOT, 'src', dir, f), 'utf8').split('\n', 1)[0];
      if (first.startsWith('// STUB')) stubs.push(dir + '/' + f);
    }
  }
  assert.deepEqual(stubs, []);
});
