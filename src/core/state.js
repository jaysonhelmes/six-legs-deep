// State schema factories (createState / createRun / createCycle / createEra), the default nest grid, and shared
// population/click helpers. Owner: WP1. Contract: ARCHITECTURE §4 (schema, §4.2 skeleton, §4.3 helpers).
// The defaults below ARE the §4 schema (the contract pins createState's exact output). Defaults that are also balance
// numbers (radius, reveal rings, nanitics, spawn timers, first event countdown, season length) are read from the owning
// data tables so that tuning src/data/*.js never leaves the schema behind (ground rule 12).

import { GRID, CELL, HEX, CLICK_CAP, nestLayout } from '../data/balance.js';
import { MAP } from '../data/surface.js';
import { EGG } from '../data/economy.js';
import { SOURCES } from '../data/sources.js';
import { EVENT_RULES } from '../data/events.js';
import { YEAR } from '../data/seasons.js';
import { CHAMBERS } from '../data/chambers.js';
import { FLIGHT } from '../data/prestige.js';
import { GEOM } from '../data/strata.js';
import { countInRadius } from './hex.js';

/** Current save schema version. Bump together with a MIGRATIONS entry and a fixture (ARCHITECTURE §7.14). */
export const SCHEMA_VERSION = 1;

// Skeleton-world schema defaults (ARCHITECTURE §4 / §4.2).
const SKELETON = Object.freeze({
  radius: MAP.radiusBase,         // current surface radius (8)
  revealRings: MAP.revealStart,   // rings 0–2 revealed (19 hexes)
  crumbHex: 3,          // crumb_scatter due east of the entrance
  royalUid: 1,
  crumbUid: 1,
  trailUid: 2,
});

/**
 * C137 / C155: the original Royal Chamber's reservation: its full-size footprint (the level where footprints stop
 * growing, GEOM.footprintMaxL = L8: 9×4) with the L1 room in the top-right corner (it grows left, toward the shaft side,
 * and down; the Royal row rule keeps it from growing up). Its Flight-level (FLIGHT.royalLevel) room is the smaller
 * rectangle in the same corner, so the C66 guarantee holds. Footprint formula DESIGN §7.4.
 * @param {{ x: number, y: number, w: number, h: number }} r
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function royalRes(r) {
  const def = CHAMBERS.royal_chamber;
  const L = Math.max(1, Math.floor(Number(GEOM.footprintMaxL) || Number(FLIGHT.royalLevel) || 5));
  const tall = Math.floor((L - 1) / 3);
  const w = Math.max(r.w, def.w0 + L - 1 - tall);
  return { x: r.x + r.w - w, y: r.y, w, h: Math.max(r.h, def.h0 + tall) };
}

/**
 * Default nest grid: all SOIL, main shaft (column 20, rows 0–19) TUNNEL, Royal Chamber (rows 20–21, cols 18–21) CHAMBER.
 * @returns {number[]} 3,200 cell codes, index = y * 40 + x
 */
export function defaultNestCells(cols = GRID.baseCols) {
  // C215: laid out for a nest `cols` wide (default the base 40, whatever nest is active), centred on the main shaft
  const L = nestLayout(cols);
  const cells = new Array(L.cols * GRID.rows).fill(CELL.SOIL);
  for (let y = 0; y < GRID.shaftRows; y++) cells[y * L.cols + L.mainCol] = CELL.TUNNEL;
  const r = L.royal;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) cells[y * L.cols + x] = CELL.CHAMBER;
  }
  return cells;
}

/**
 * Fresh run subtree: the minimal playable skeleton (default nest, all-grass surface, crumb source + forager trail).
 * @param {number} seed uint32
 * @returns {Object} State['run']
 */
export function createRun(seed) {
  const s32 = seed >>> 0;
  const revealed = new Array(HEX.count).fill(0);
  const nReveal = countInRadius(SKELETON.revealRings);
  for (let i = 0; i < nReveal; i++) revealed[i] = 1;
  const r = GRID.baseRoyal; // C215: a fresh run skeleton is always the base 40-wide nest
  return {
    index: 0,
    seed: s32, mapSeed: s32,
    time: 0,
    hardship: null,
    landingTags: [],
    boon: null,
    res: { food: 5, soil: 0, insight: 0, pheromone: 0, chitin: 0, honeydew: 0, leaves: 0, fungus: 0 },
    fRun: 0,
    tPeak: 0,
    colony: {
      adults: { minor: 0, soldier: 0, supermajor: 0, replete: 0 },
      alatesReared: 0,
      brood: [],
      layAcc: 1,
      eggs: { minor: 0, soldier: 0, supermajor: 0, replete: 0, alate: 0 },
      naniticsLeft: EGG.nanitics,
      rearRequested: 0,
      // C151: caste TARGET COUNTS (adults + brood of that caste the queen lays toward), "Keep berths filled" toggles
      // (target = the caste's berth cap) and whether the player (or the first Barracks / War Hall) set them this run.
      // The old share map `casteTargets` (≤ 0.9 of eggs) is converted on the first step after load (population.js).
      casteGoals: { soldier: 0, supermajor: 0, replete: 0 },
      casteFill: { soldier: false, supermajor: false, replete: false },
      casteTouched: { soldier: false, supermajor: false, replete: false },
      eggReserve: 0,
      chitinReserve: 0,   // C104: chitin held back from soldier / supermajor eggs (absolute; per run)
      fungalBrood: false,
      hungry: false,
      phi: 0,
      golden: 0,
      jobs: { forager: 0, digger: 0, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 },
      jobTargets: { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 },
      autoJobs: false,
      thresholdJobs: false,
      militia: 0,
    },
    nest: {
      rev: 1,
      cells: defaultNestCells(),
      chambers: [
        { uid: SKELETON.royalUid, type: 'royal_chamber', k: 0, x: r.x, y: r.y, w: r.w, h: r.h,
          level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0, res: royalRes(r) },
      ],
      nextUid: 2,
      queue: [],
      features: { caches: [], water: [], roots: [] },
      backfill: [],
      shafts: [{ kind: 'main', col: GRID.baseMainCol, open: true, ref: -1 }],
      maint: 0,
      deepestRow: r.y + r.h - 1,
      // C106: pending blueprint chambers [{ type, x, y }] and the blueprint tunnel cells behind them (nest.applyBlueprint).
      bpPending: [],
      bpTunnels: [],
      // C119: blueprint notes for the player (Royal Chamber / Water Well), flushed as blueprintDropped events by nest.tick.
      bpNotes: [],
      // C214: who dug the tunnels the player did not draw ([{ w: why, t?: chamber type, c: cells }], newest last; nest.tagTunnel)
      dugBy: [],
    },
    surface: {
      rev: 1,
      radius: SKELETON.radius,
      terrain: new Array(HEX.count).fill(0),
      revealed,
      claimed: new Array(HEX.count).fill(0),
      conquered: new Array(HEX.count).fill(0),
      flagged: [],
      scout: { target: -1, prog: 0 },
      sources: [
        { uid: SKELETON.crumbUid, type: 'crumb_scatter', hex: SKELETON.crumbHex, stock: -1, max: -1, level: 1,
          herdT: 0, age: 0, ttl: -1, cd: 0, data: {} },
      ],
      trails: [
        { uid: SKELETON.trailUid, origin: 0, src: SKELETON.crumbUid, path: [0, SKELETON.crumbHex], len: 1, job: 'forager',
          workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] },
      ],
      nextUid: 3,
      claims: 0,
      channel: null,
      mound: 0,
      entrances: [{ kind: 'main', hex: 0, col: GRID.baseMainCol, ref: -1 }],
      spawn: { insect: SOURCES.dead_insect.spawn.every, prey: SOURCES.prey_caterpillar.spawn.every, boonPrey: 0 },
      cd: { mark: 0, rally: 0, frenzy: 0 },
    },
    rivals: { list: [], nextUid: 1, respawn: [], topTier: 0 },
    war: { parties: [], battles: [], raids: [], triage: [], nextUid: 1 },
    events: {
      nextIn: EVENT_RULES.scriptedFruitAt,
      recent: [],
      lastNegAt: -1e9,
      card: null,
      active: [],
      objects: [],
      scripted: false,
      seedMastYear: -1,
      nextUid: 1,
    },
    golden: { beetleIn: 0, beetle: null, pupa: null, lastPupaAt: -1e9, gifts: [] },
    effects: [],
    research: {},
    refinements: {},
    adaptations: {},
    unlocked: {},
    bottleneck: { id: null, since: 0, capT: 0 },
    prestige: { peakRate: 0, peakAt: 0, calmPeak: 0, belowAt: -1 },   // C166: weather-free peak + drop start (Auto-Flight)
    clicks: { sec: -1, n: 0 },
    stats: {
      eggs: 0, hatched: 0, soldiersRaised: 0, maxAdults: 0, foodWasted: 0, hungryEver: false, winterHungry: false,
      cellsDug: 0, chambersDone: 0, relocations: 0,
      sourcesDepleted: 0,
      battles: 0, battlesWon: 0, conquests: 0, kills: 0, raidsIncoming: 0,
      eventsSeen: 0,
    },
  };
}

/**
 * Fresh cycle subtree (reset at Supercolony).
 * @returns {Object} State['cycle']
 */
export function createCycle() {
  return { alates: 0, alatesCycle: 0, traits: {}, hardshipTier: {}, edict: null, daughters: [], startedAt: 0 };
}

/**
 * Fresh era subtree (reset at Speciation).
 * @returns {Object} State['era']
 */
export function createEra() {
  return {
    species: 'garden_ant',
    kinship: 0,
    kinshipLife: 0,
    federation: {},
    heirlooms: [],
    innate: {},
    researchRuns: {},
    archive: {},        // C200: Archive level per research branch (insight sink; kept through Flights and Supercolonies)
    hardshipBest: {},
    blueprints: [],
    activeBlueprint: -1,
    startedAt: 0,
  };
}

/**
 * Fresh meta subtree (never reset).
 * @returns {Object} State['meta']
 */
function createMeta() {
  return {
    createdAt: 0, lastSeen: 0, savedAt: 0,
    tick: 0,
    simTime: 0,
    settings: {
      notation: 'suffix',
      autosaveSec: 15,
      reducedMotion: false,
      sound: false,
      harshNature: false,
      retreatAt: 0.6,
      colonyName: '', queenName: '',
      showScaleLabel: true,
    },
    pending: null,
    season: { t: 0, year: 0, lengthSec: YEAR.lengthSec, extraSpring: 0 },
    seen: {},
    reveal: { queue: [], lastAt: -1e9 },
    achievements: {},
    fieldGuide: {},
    genes: 0, genesLife: 0,
    genome: {},
    speciesUnlocked: { garden_ant: true },
    signatureGenes: {},
    diapause: { bank: 0, active: false },
    savedFinds: 0,
    strata: [],
    cosmetics: { owned: {}, equipped: {} },
    automation: {
      autobuy: { adaptations: false, chambers: false },   // C246: one switch per autobuyer, each independent
      autoFlight: { on: false, mode: 'peak', alates: 0, minutes: 30 },
      autoSuper: { on: false, mode: 'kinship', kinship: 0, hours: 6 },
      autoGuard: false,
      autoRear: false,
      jobPresets: [],
      keep: { jobTargets: null, casteTargets: null, casteGoals: null, casteFill: null }, // casteTargets: legacy shares (C151)
    },
    counters: {
      runs: 0, flights: 0, supercolonies: 0, speciations: 0, alatesLife: 0, kinshipEver: 0,
      clicks: 0, queenClicks: 0,
      cellsDug: 0, caches: 0, amber: 0, relocations: 0,
      battlesWon: 0, conquests: 0, tournamentsWon: 0,
      beetles: 0, moldScraped: 0, ladybugs: 0, rainstorms: 0, moleTunnels: 0, events: 0,
    },
    stats: {
      foodEver: 0,
      deepestRow: 0,
      longestTrail: 0,
      largestBattle: 0,
      fastestFlightSec: 0,
      firstFlightAt: 0, firstSuperAt: 0, firstSpecAt: 0,
      nanGuards: 0,
    },
    onboarding: { done: {} },
    flags: { clockSkew: false, endingSeen: false },
  };
}

/**
 * Complete fresh game state (ARCHITECTURE §4): the skeleton world with the given seed.
 * @param {{ seed?: number }} [opts]
 * @returns {import('./types.js').State}
 */
export function createState({ seed = 1 } = {}) {
  return {
    v: SCHEMA_VERSION,
    rng: (seed >>> 0) || 1,
    meta: createMeta(),
    era: createEra(),
    cycle: createCycle(),
    run: createRun(seed),
  };
}

/**
 * DESIGN "adults": minor + soldier + supermajor + replete (excludes alates).
 * @param {import('./types.js').State} s
 * @returns {number}
 */
export function adultsTotal(s) {
  const a = s.run.colony.adults;
  return a.minor + a.soldier + a.supermajor + a.replete;
}

/**
 * Σ cohort n over all brood.
 * @param {import('./types.js').State} s
 * @returns {number}
 */
export function broodTotal(s) {
  const b = s.run.colony.brood;
  let n = 0;
  for (let i = 0; i < b.length; i++) n += b[i].n;
  return n;
}

/**
 * DESIGN N for egg cost: adultsTotal + alatesReared + broodTotal.
 * @param {import('./types.js').State} s
 * @returns {number}
 */
export function popN(s) {
  return adultsTotal(s) + s.run.colony.alatesReared + broodTotal(s);
}

/** Integer run second used by the click bucket (tiny epsilon absorbs 0.1-step float drift). */
function clickSecond(s) {
  return Math.floor(s.run.time + 1e-9);
}

/**
 * Pure: true if fewer than CLICK_CAP clicks are counted in the current integer run second (for validate()).
 * @param {import('./types.js').State} s
 * @returns {boolean}
 */
export function clickAvailable(s) {
  const c = s.run.clicks;
  return c.sec !== clickSecond(s) || c.n < CLICK_CAP;
}

/**
 * Count one click against the 15/s cap (for apply()). Returns false if the cap is already reached this second;
 * otherwise increments run.clicks and meta.counters.clicks and returns true.
 * @param {import('./types.js').State} s
 * @returns {boolean}
 */
export function consumeClick(s) {
  const c = s.run.clicks;
  const sec = clickSecond(s);
  if (c.sec !== sec) {
    c.sec = sec;
    c.n = 0;
  }
  if (c.n >= CLICK_CAP) return false;
  c.n++;
  s.meta.counters.clicks++;
  return true;
}
