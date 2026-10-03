// World data (WP6): random-event scheduler rules, the 28 events of DESIGN §18.2, Golden Beetle / Pupa bonuses and the
// Saved Finds pool. Owner: WP6. Contract: ARCHITECTURE §6.6. Every number of an event's DESIGN row lives in its `num`.
// Extra entry fields beyond the documented shape: `disease` (DESIGN §18.2 disease events), `followUp` (only fired as
// the consequence of another event, never picked by the scheduler) and `obj` (EventObject kind it shows, if any).

import { FROST } from './seasons.js';

/** Deep-freeze helper (plain objects and arrays). */
const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/**
 * Scheduler rules (DESIGN §18.1). pityWindow = the "any 3 consecutive events" window of maxNegIn3.
 * harvestFrac: a tracked finite source (fruit, picnic) counts as fully harvested when it vanished while trailed with at
 * most this share of its stock left (or less than two ticks of drain).
 */
export const EVENT_RULES = f({ meanSec: 240, firstRunQuietSec: 360, scriptedFruitAt: 480, firstPositive: 3, maxNegIn3: 1, negGapSec: 60,
  cardSec: 30, weatherWarnSec: 30, pityWindow: 3, harvestFrac: 0.02 });

/** Default event weight (DESIGN §18.1: "the default is 10"). */
const W = 10;

/** Build an event entry with the documented defaults. */
const E = (id, name, polarity, o = {}) => ({
  id, name, polarity,
  seasons: o.seasons || null,
  weight: o.weight === undefined ? W : o.weight,
  seasonWeight: o.seasonWeight || null,
  minRunSec: o.minRunSec || 0,
  minAdults: o.minAdults || 0,
  cond: o.cond || null,
  weather: !!o.weather,
  disease: !!o.disease,
  followUp: !!o.followUp,
  obj: o.obj || null,
  choices: o.choices || null,
  num: o.num || {},
});

/** Ids in DESIGN §18.2 order. */
export const EVENT_ORDER = f([
  'ev_fallen_fruit', 'ev_picnic_spill', 'ev_termite_swarm', 'ev_seed_mast_year', 'ev_pheromone_bloom', 'ev_lost_scout_returns',
  'ev_queens_vigor', 'ev_rival_mating_flight', 'ev_rival_queen_dies', 'ev_flight_day', 'ev_golden_aphid', 'ev_mole_tunnel',
  'ev_wandering_queen', 'ev_myrmecophile_guest', 'ev_phengaris_caterpillar', 'ev_rainstorm', 'ev_drought', 'ev_mold_bloom',
  'ev_ophiocordyceps', 'ev_ladybug_raid', 'ev_antlion_pit', 'ev_horned_lizard', 'ev_footstep', 'ev_brood_mites',
  'ev_phorid_flies', 'ev_fungal_blight', 'ev_army_ant_column', 'ev_frost_snap',
]);

/**
 * The events. polarity 'pos' | 'neg' | 'mix' | 'choice' (pity: 'choice' counts as 'mix'; 'mix' never as negative).
 * cond: named predicate implemented in systems/events.js. choices: [{ id, def? }] — def marks the safe default (*).
 */
export const EVENTS = f({
  ev_fallen_fruit: E('ev_fallen_fruit', 'Fallen Fruit', 'pos', {
    seasons: ['spring', 'summer', 'autumn'], seasonWeight: { summer: 2 }, obj: 'fruit',
    num: { rMin: 3, rMax: 6 } }),
  ev_picnic_spill: E('ev_picnic_spill', 'Picnic Spill', 'pos', {
    seasons: ['summer', 'autumn'], weight: 3, minRunSec: 1200,
    num: { rMin: 6, rMax: 12 } }),
  ev_termite_swarm: E('ev_termite_swarm', 'Termite Swarm', 'pos', {
    cond: 'afterRain', followUp: true, obj: 'termite_swarm',
    num: { chance: 0.5, withinSec: 120, sec: 45, rMin: 2, rMax: 6 } }),
  ev_seed_mast_year: E('ev_seed_mast_year', 'Seed Mast Year', 'pos', {
    seasons: ['autumn'], weight: 5, cond: 'seedMast',
    num: { mult: 3 } }),
  ev_pheromone_bloom: E('ev_pheromone_bloom', 'Pheromone Bloom', 'pos', {
    weight: 6,
    num: { mult: 2, sec: 90 } }),
  ev_lost_scout_returns: E('ev_lost_scout_returns', 'Lost Scout Returns', 'pos', {
    cond: 'hasScout',
    num: { scouts: 1, hexes: 3, insightSec: 120, insightMin: 30 } }),
  ev_queens_vigor: E('ev_queens_vigor', "Queen's Vigor", 'pos', {
    num: { mult: 3, sec: 60 } }),
  ev_rival_mating_flight: E('ev_rival_mating_flight', 'Rival Mating Flight', 'pos', {
    seasons: ['summer'], cond: 'rivalExists', obj: 'rival_alate',
    num: { apMult: 0.7, sec: 180, alates: 30, foodSec: 2 } }),
  ev_rival_queen_dies: E('ev_rival_queen_dies', 'Rival Queen Dies', 'pos', {
    cond: 'rivalExists',
    num: { apMult: 0.5, sec: 300 } }),
  ev_flight_day: E('ev_flight_day', 'Flight Day', 'pos', {
    seasons: ['summer'], weight: 2, cond: 'nuptialPrep',
    num: { w: 1.5, sec: 180 } }),
  ev_golden_aphid: E('ev_golden_aphid', 'Golden Aphid', 'pos', {
    seasons: ['spring', 'summer'], cond: 'aphidHerded', obj: 'golden_aphid',
    num: { sec: 15, mult: 7, buffSec: 60 } }),
  ev_mole_tunnel: E('ev_mole_tunnel', 'Mole Tunnel', 'mix', {
    minRunSec: 600, obj: 'molehill',
    num: { blockSec: 180 } }),
  ev_wandering_queen: E('ev_wandering_queen', 'Wandering Queen', 'choice', {
    minAdults: 200, obj: 'wandering_queen',
    choices: [{ id: 'adopt' }, { id: 'devour', def: true }],
    num: { layMult: 2, sec: 600, parasiteChance: 0.2, parasiteMult: 0.5, parasiteSec: 300, devourSec: 120, devourMin: 100 } }),
  ev_myrmecophile_guest: E('ev_myrmecophile_guest', 'Myrmecophile Guest', 'choice', {
    minAdults: 100, obj: 'myrmecophile',
    choices: [{ id: 'accept' }, { id: 'expel', def: true }],
    num: { forageAdd: 0.15, sec: 600, eatChance: 0.5, eatFrac: 0.05, eatSec: 60, expelSec: 30, expelMin: 20 } }),
  ev_phengaris_caterpillar: E('ev_phengaris_caterpillar', 'Phengaris Caterpillar', 'choice', {
    seasons: ['summer'], minAdults: 150, obj: 'phengaris',
    choices: [{ id: 'adopt' }, { id: 'reject', def: true }],
    num: { cuckooChance: 0.5, honeydewMult: 0.9, sec: 180, larvaEverySec: 10, larvae: 1, insightSec: 120, insightMin: 100 } }),
  ev_rainstorm: E('ev_rainstorm', 'Rainstorm', 'neg', {
    seasons: ['spring', 'summer'], seasonWeight: { summer: 0.3 }, weather: true,
    choices: [{ id: 'seal', def: true }, { id: 'keep' }],
    num: { sealSec: 60, keepMult: 0.5, keepSec: 60, floodChance: 0.25, floodSec: 120, bailSec: 5, layer: 'topsoil',
      raftMult: 1.25, raftSec: 60 } }),
  ev_drought: E('ev_drought', 'Drought', 'neg', {
    seasons: ['summer'], weather: true,
    num: { sec: 180, leaves: 0.5, flowers: 0.3, honeydew: 1.5 } }),
  ev_mold_bloom: E('ev_mold_bloom', 'Mold Bloom', 'neg', {
    minAdults: 50, disease: true, obj: 'mold',
    num: { min: 3, max: 6, mult: 0.5, spreadSec: 60, maxSpots: 24, cleanHouse: 0.9 } }),
  ev_ophiocordyceps: E('ev_ophiocordyceps', 'Ophiocordyceps', 'neg', {
    minAdults: 300, minRunSec: 1200, disease: true,
    choices: [{ id: 'quarantine', def: true }, { id: 'ignore' }],
    num: { forageMult: 0.8, quarantineSec: 120, infectFrac: 0.01, spreadPerMin: 1.5, sec: 180, avertLoss: 0.01 } }),
  ev_ladybug_raid: E('ev_ladybug_raid', 'Ladybug Raid', 'neg', {
    seasons: ['spring', 'summer'], cond: 'aphidHerded', obj: 'ladybug',
    choices: [{ id: 'send' }, { id: 'wait', def: true }],
    num: { soldiers: 5, apPerRing: 50, ladybugs: 10, yieldMult: 0.5, sec: 300 } }),
  ev_antlion_pit: E('ev_antlion_pit', 'Antlion Pit', 'neg', {
    cond: 'trailMin4', obj: 'antlion',
    choices: [{ id: 'send' }, { id: 'wait', def: true }],
    num: { minHexes: 4, soldiers: 3, lossPerMin: 0.02 } }),
  ev_horned_lizard: E('ev_horned_lizard', 'Horned Lizard', 'neg', {
    seasons: ['summer'], cond: 'trailMid', obj: 'lizard',
    choices: [{ id: 'reroute', def: true }, { id: 'mob' }, { id: 'ignore' }],
    num: { sec: 120, apPerRing: 200, foodSec: 60, lossFrac: 0.01, lossEverySec: 10 } }),
  ev_footstep: E('ev_footstep', 'Footstep', 'neg', {
    seasons: ['spring', 'summer'], cond: 'gardenPath', obj: 'footstep',
    num: { sec: 5, areaRadius: 1, tagMult: 2 } }),
  ev_brood_mites: E('ev_brood_mites', 'Brood Mites', 'neg', {
    minAdults: 500, disease: true,
    num: { mult: 1.5, sec: 120, nursesPerSlot: 1 } }),
  ev_phorid_flies: E('ev_phorid_flies', 'Phorid Flies', 'neg', {
    seasons: ['summer'],
    num: { atkMult: 0.5, forageMult: 0.9, sec: 90 } }),
  ev_fungal_blight: E('ev_fungal_blight', 'Fungal Blight', 'neg', {
    disease: true, cond: 'fungusGarden',
    choices: [{ id: 'quarantine', def: true }, { id: 'clean' }],
    num: { loss: 0.3, clicks: 20, cleanSec: 15 } }),
  ev_army_ant_column: E('ev_army_ant_column', 'Army Ant Column', 'neg', {
    minRunSec: 1800, minAdults: 500, obj: 'army_column',
    choices: [{ id: 'evacuate', def: true }, { id: 'fight' }],
    num: { evacSec: 60, evacFood: 0.05 } }),
  ev_frost_snap: E('ev_frost_snap', 'Frost Snap', 'neg', {
    seasons: ['autumn', 'winter'],
    num: { rows: FROST.snapRows, sec: FROST.snapSec } }),
});

/**
 * Golden Beetle and Golden Pupa (DESIGN §18.3). Beetle every U(beetleMin, beetleMax) s while online; lifetime `life`
 * (`lifeAch` with ach_beetle_collector, + lifePicnicAch with ach_picnic_crasher). Pupa: pupaChance per egg laid, at
 * most one per pupaGapSec, visible pupaLife s.
 */
export const GOLDEN = f({ beetleMin: 300, beetleMax: 600, life: 13, lifeAch: 20, lifePicnicAch: 5,
  rolls: [{ id: 'windfall', w: 45, foodSec: 600 }, { id: 'frenzy', w: 25, mult: 5, sec: 60 }, { id: 'lay_burst', w: 15, mult: 3, sec: 30 },
    { id: 'discovery', w: 15, insightSec: 60, insightFlat: 20 }],
  pupaChance: 0.002, pupaGapSec: 180, pupaLife: 15 });

/** Saved Finds (DESIGN §18.5): each gift opens one of these, uniformly. */
export const SAVED_FINDS = f({ pool: ['ev_fallen_fruit', 'ev_pheromone_bloom', 'ev_queens_vigor', 'ev_lost_scout_returns', 'golden_beetle'] });

/**
 * Run-1 event gap (ARCHITECTURE §18 C75, balance tuner request): in the first run (run.index 0) the next random event is
 * due at most firstRunMaxSec after the previous one (the exponential draw is capped); later runs are not capped.
 */
export const EVENT_GAP = f({ firstRunMaxSec: 150 });
