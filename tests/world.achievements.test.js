// WP6 unit tests: achievements (checks, grants, cosmetics, progress, Next Goals) — ARCHITECTURE §8.5, DESIGN §19.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import * as achievements from '../src/systems/achievements.js';
import { ACH_ORDER, ACHIEVEMENTS, ACH_PARAMS } from '../src/data/achievements.js';
import { FG_ORDER } from '../src/data/fieldGuide.js';
import { RESEARCH_ORDER } from '../src/data/research.js';
import { TRAIL } from '../src/data/surface.js';
import { addEffect } from '../src/core/effects.js';

const DESIGN_ACH = ['ach_first_brood', 'ach_hundred_mandibles', 'ach_thousand_strong', 'ach_ten_thousand', 'ach_myriad', 'ach_billion_backs',
  'ach_six_trillion_legs', 'ach_twenty_quadrillion', 'ach_first_crumb', 'ach_clickstorm', 'ach_hoarder', 'ach_feast', 'ach_ten_million',
  'ach_billion_bites', 'ach_trillion_tonnes', 'ach_diminishing_returns', 'ach_survivor', 'ach_going_under', 'ach_into_the_clay',
  'ach_gravel_pit', 'ach_bedrock_bound', 'ach_wellspring', 'ach_master_digger', 'ach_treasure_hunter', 'ach_amber_finder',
  'ach_royal_neighbours', 'ach_ant_farm', 'ach_grand_gallery', 'ach_clean_house', 'ach_seed_bank', 'ach_living_larder', 'ach_architect',
  'ach_royal_ascent', 'ach_pathfinder', 'ach_double_bridge', 'ach_highway', 'ach_cartographer', 'ach_land_grab', 'ach_shepherd',
  'ach_peach_fuzz', 'ach_picnic_crasher', 'ach_mutualist', 'ach_border_dispute', 'ach_square_law', 'ach_flawless', 'ach_pavement_is_ours',
  'ach_total_war', 'ach_david_and_goliath', 'ach_ritualist', 'ach_phragmosis', 'ach_big_game', 'ach_old_ridge_falls', 'ach_front_broken',
  'ach_first_winter', 'ach_seasoned', 'ach_golden_touch', 'ach_beetle_collector', 'ach_the_large_blue', 'ach_zombie_averted',
  'ach_rain_dancer', 'ach_mole_friend', 'ach_flying_ant_day', 'ach_first_flight', 'ach_swift_swarm', 'ach_gentle_giants', 'ach_peak_timing',
  'ach_sky_full_of_wings', 'ach_thousand_queens', 'ach_hardship_tier', 'ach_hardship_master', 'ach_one_family', 'ach_living_fossil',
  'ach_sociobiologist', 'ach_queens_favorite', 'ach_overthinker', 'ach_pheromone_picasso', 'ach_lady_luck', 'ach_pacifist_flight',
  'ach_wilsons_pride', 'ach_naturalist', 'ach_field_guide_complete'];

/** One achievements tick with injected events; returns the ids granted. */
function tick(s, d, events = [], dt = 0.1) {
  const env = fakeEnv({ dt });
  for (const e of events) env.events.push(e);
  achievements.tick(s, d, dt, env);
  s.meta.simTime += dt;
  s.run.time += dt;
  return env.events.filter((e) => e.type === 'achievement').map((e) => e.id);
}

/** Force a state-check pass (the module checks once per sim second): jump to the next whole second, tick with dt 0. */
function check(s, d) {
  s.meta.simTime = Math.floor(s.meta.simTime) + 1;
  return tick(s, d, [], 0);
}

/** Tick for `sec` seconds (state checks every second). */
function runFor(s, d, sec, dt = 1) {
  const out = [];
  for (let i = 0; i < Math.round(sec / dt); i++) out.push(...tick(s, d, [], dt));
  return out;
}

const earned = (s, id) => Object.prototype.hasOwnProperty.call(s.meta.achievements, id);
const rival = (uid, type, extra = {}) => ({ uid, type, tier: 1, hex: 70, radius: 2, base: 15, n: 15, atk: 3, hp: 15, traits: [], alive: true,
  sighted: true, raidIn: 100, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1, extra: [], lost: [], stolen: 0, ...extra });

test('data: all 81 DESIGN achievements, in order, with the documented shape and a check each', () => {
  assert.deepEqual([...ACH_ORDER], DESIGN_ACH);
  const cats = new Set(['population', 'food', 'excavation', 'chambers', 'surface', 'combat', 'seasons', 'prestige', 'secret', 'guide']);
  for (const id of ACH_ORDER) {
    const a = ACHIEVEMENTS[id];
    assert.equal(a.id, id);
    assert.ok(cats.has(a.cat), id);
    for (const k of ['name', 'desc', 'secret', 'target', 'reward', 'cosmetic']) assert.ok(k in a, id + '.' + k);
    assert.ok(a.reward === null || typeof a.reward.text === 'string');
    assert.equal(a.secret, a.cat === 'secret');
    assert.ok(achievements.hasCheck(id), 'no check for ' + id);
  }
  assert.equal(ACH_ORDER.filter((id) => ACHIEVEMENTS[id].secret).length, 6);
  assert.equal(ACHIEVEMENTS.ach_field_guide_complete.target, FG_ORDER.length);
  const cos = ACH_ORDER.map((id) => ACHIEVEMENTS[id].cosmetic).filter(Boolean);
  assert.equal(cos.length, 11);
  assert.equal(new Set(cos).size, cos.length);
});

test('a grant records simTime, owns the cosmetic, emits once', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.simTime = 42;
  s.meta.season.year = 1;
  const got = tick(s, d);
  assert.ok(got.includes('ach_first_winter'));
  assert.equal(s.meta.achievements.ach_first_winter, 42);
  assert.equal(s.meta.cosmetics.owned.cos_snowcap_mound, true);
  assert.deepEqual(runFor(s, d, 3).filter((id) => id === 'ach_first_winter'), []);
});

test('population and census thresholds', () => {
  const s = newState();
  const d = makeDerived();
  s.run.colony.adults.minor = 99;
  tick(s, d);
  assert.equal(earned(s, 'ach_hundred_mandibles'), false);
  s.run.colony.adults.soldier = 1;
  check(s, d);
  assert.equal(earned(s, 'ach_hundred_mandibles'), true);
  d.meta.census = 1e9;
  check(s, d);
  assert.ok(earned(s, 'ach_myriad') && earned(s, 'ach_billion_backs'));
  assert.equal(earned(s, 'ach_six_trillion_legs'), false);
  d.meta.census = 2e16;
  check(s, d);
  assert.ok(earned(s, 'ach_twenty_quadrillion'));
  assert.equal(s.meta.cosmetics.owned.cos_golden_queen, true);
});

test('food: f_run thresholds, clickstorm, first crumb, diminishing returns', () => {
  const s = newState();
  const d = makeDerived();
  s.run.fRun = 1.5e7;
  s.meta.counters.clicks = 10000;
  check(s, d);
  for (const id of ['ach_feast', 'ach_ten_million', 'ach_clickstorm']) assert.ok(earned(s, id), id);
  assert.equal(earned(s, 'ach_billion_bites'), false);
  assert.ok(tick(s, d, [{ type: 'clicked', src: 1, amount: 1 }]).includes('ach_first_crumb'));
  assert.ok(tick(s, d, [{ type: 'softcapHit', stat: 'food' }]).includes('ach_diminishing_returns'));
});

test('hoarder: food at cap for 10 minutes straight (timer resets when it drops)', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1000 } });
  s.run.res.food = 995;
  runFor(s, d, 500, 1);
  s.run.res.food = 500;
  tick(s, d, [], 1);
  assert.equal(d.progress._timers.ach_hoarder, 0);
  s.run.res.food = 1000;
  runFor(s, d, 599, 1);
  assert.equal(earned(s, 'ach_hoarder'), false);
  runFor(s, d, 2, 1);
  assert.equal(earned(s, 'ach_hoarder'), true);
});

test('excavation: a dug cell in row 10, depth records, counters', () => {
  const s = newState();
  const d = makeDerived();
  assert.deepEqual(tick(s, d, [{ type: 'cellDug', i: 9 * 40 + 5 }]).filter((x) => x === 'ach_going_under'), []);
  assert.ok(tick(s, d, [{ type: 'cellDug', i: 10 * 40 + 5 }]).includes('ach_going_under'));
  s.meta.stats.deepestRow = 41;
  s.meta.counters.cellsDug = 1000;
  s.meta.counters.caches = 10;
  s.meta.counters.amber = 1;
  check(s, d);
  for (const id of ['ach_into_the_clay', 'ach_gravel_pit', 'ach_master_digger', 'ach_treasure_hunter', 'ach_amber_finder']) assert.ok(earned(s, id), id);
  assert.equal(earned(s, 'ach_bedrock_bound'), false);
  // Offline digging is seen through d.offlineLog.
  d.offlineLog = { cells: [58 * 40 + 1], chambers: [] };
  tick(s, d);
  assert.ok(earned(s, 'ach_bedrock_bound'));
});

test('chambers: royal neighbours, ant farm, grand gallery, royal ascent, living larder, seed bank (C33)', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1000 } });
  d.nest.agg.adjNurseryRoyal = true;
  for (let i = 0; i < 9; i++) {
    s.run.nest.chambers.push({ uid: 10 + i, type: i === 0 ? 'gallery' : 'granary', k: i, x: i * 4, y: 45, w: 3, h: 2, level: i === 0 ? 8 : 1,
      target: 1, status: 'active', blueprint: false, bornAt: 0 });
  }
  s.run.nest.chambers[0].level = 10;
  s.run.colony.adults.replete = 50;
  check(s, d);
  for (const id of ['ach_royal_neighbours', 'ach_ant_farm', 'ach_grand_gallery', 'ach_royal_ascent', 'ach_living_larder']) assert.ok(earned(s, id), id);
  assert.equal(s.meta.cosmetics.owned.cos_royal_amber, true);
  assert.equal(earned(s, 'ach_seed_bank'), false);
  s.run.res.food = 1000;
  d.nest.chambers = s.run.nest.chambers.map((c) => ({ uid: c.uid, layer: c.type === 'granary' ? 'gravel' : 'topsoil' }));
  check(s, d);
  assert.ok(earned(s, 'ach_seed_bank'));
});

test('surface: pathfinder, picasso, cartographer, land grab, shepherd, mutualist, highway', () => {
  const s = newState();
  const d = makeDerived();
  s.run.surface.trails[0].path = [0, 3, 10, 22, 38];
  check(s, d);
  assert.ok(earned(s, 'ach_pathfinder'));
  assert.equal(earned(s, 'ach_pheromone_picasso'), false);
  s.meta.stats.longestTrail = 30;
  d.surface.ownedCount = 50;
  for (let i = 0; i < 217; i++) s.run.surface.revealed[i] = 1;
  check(s, d);
  for (const id of ['ach_pheromone_picasso', 'ach_land_grab', 'ach_cartographer']) assert.ok(earned(s, id), id);
  for (let k = 0; k < 3; k++) {
    s.run.surface.sources.push({ uid: 20 + k, type: 'aphid_colony', hex: 40 + k, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
    s.run.surface.trails.push({ uid: 30 + k, origin: 0, src: 20 + k, path: [0, 40 + k], len: 1, job: 'herder', workers: 3, escorts: 0, S: 0, born: 0, reroutes: [] });
  }
  check(s, d);
  assert.ok(earned(s, 'ach_shepherd'));
  s.run.surface.trails.push({ uid: 40, origin: 0, src: 20, path: [0, 40], len: 1, job: 'lycaenid', workers: 0, escorts: 5, S: 0, born: 0, reroutes: [] });
  d.surface.trails = [{ uid: 40, out: 0.6, workers: 0 }];
  runFor(s, d, 299, 1);
  assert.equal(earned(s, 'ach_mutualist'), false);
  runFor(s, d, 2, 1);
  assert.ok(earned(s, 'ach_mutualist'));
  s.run.surface.trails[0].S = TRAIL.sMax;
  runFor(s, d, 301, 1);
  assert.ok(earned(s, 'ach_highway'));
});

test('double bridge: a reroute that makes the trail ≥ 30 % shorter', () => {
  const s = newState();
  const d = makeDerived();
  const t = s.run.surface.trails[0];
  t.len = 10;
  tick(s, d);
  t.len = 8;
  t.reroutes.push(1);
  tick(s, d);
  assert.equal(earned(s, 'ach_double_bridge'), false, '20 % shorter is not enough');
  t.len = 5;
  t.reroutes.push(2);
  tick(s, d);
  assert.equal(earned(s, 'ach_double_bridge'), true);
});

test('overthinker: one trail rerouted 20 times within a minute', () => {
  const s = newState();
  const d = makeDerived();
  const t = s.run.surface.trails[0];
  for (let i = 0; i < TRAIL.overthinker.n; i++) t.reroutes.push(100 + i * 4);
  check(s, d);
  assert.equal(earned(s, 'ach_overthinker'), false, '76 s window');
  t.reroutes = Array.from({ length: TRAIL.overthinker.n }, (_, i) => 200 + i * 2);
  check(s, d);
  assert.ok(earned(s, 'ach_overthinker'));
});

test('harvest deeds: peach fuzz, picnic crasher, the large blue, zombie averted', () => {
  const s = newState();
  const d = makeDerived();
  const ids = tick(s, d, [
    { type: 'eventResolved', uid: 1, id: 'ev_fallen_fruit', choice: 'lost' },
    { type: 'eventResolved', uid: 2, id: 'ev_picnic_spill', choice: 'harvested' },
    { type: 'eventResolved', uid: 3, id: 'ev_phengaris_caterpillar', choice: 'butterfly' },
    { type: 'eventResolved', uid: 4, id: 'ev_ophiocordyceps', choice: 'quarantine' },
  ]);
  assert.deepEqual(['ach_picnic_crasher', 'ach_the_large_blue', 'ach_zombie_averted'].filter((x) => ids.includes(x)).length, 3);
  assert.equal(earned(s, 'ach_peach_fuzz'), false);
  assert.ok(tick(s, d, [{ type: 'eventResolved', uid: 5, id: 'ev_fallen_fruit', choice: 'harvested' }]).includes('ach_peach_fuzz'));
  // An ignored outbreak that ends with under 1 % losses ('averted') also counts; one with real losses ('ended') does not.
  const s2 = newState();
  assert.equal(tick(s2, d, [{ type: 'eventResolved', uid: 6, id: 'ev_ophiocordyceps', choice: 'ended' }]).includes('ach_zombie_averted'), false);
  assert.ok(tick(s2, d, [{ type: 'eventResolved', uid: 7, id: 'ev_ophiocordyceps', choice: 'averted' }]).includes('ach_zombie_averted'));
});

test('combat: square law, flawless, David and Goliath, conquests by rival lookup, total war, front broken', () => {
  const s = newState();
  const d = makeDerived();
  const end = (o) => ({ type: 'battleEnd', uid: 1, kind: 'raid', tag: '', win: true, lost: { soldier: 0, supermajor: 0, militia: 0 }, kills: 5,
    odds: 0.9, start: { you: 20, foe: 10 }, ...o });
  assert.deepEqual(tick(s, d, [end({ win: false, start: { you: 5, foe: 10 } })]).filter((x) => x === 'ach_square_law'), []);
  assert.ok(tick(s, d, [end({ start: { you: 5, foe: 10 } })]).includes('ach_square_law'));
  assert.deepEqual(tick(s, d, [end({ kind: 'assault', lost: { soldier: 2, supermajor: 0, militia: 0 }, start: { you: 20, foe: 10 } })])
    .filter((x) => x === 'ach_flawless'), []);
  assert.ok(tick(s, d, [end({ kind: 'assault', lost: { soldier: 0.5, supermajor: 0, militia: 0 }, start: { you: 20, foe: 10 } })]).includes('ach_flawless'));
  assert.ok(tick(s, d, [end({ odds: 0.39 })]).includes('ach_david_and_goliath'));
  assert.equal(s.meta.cosmetics.owned.cos_title_underdog, true);
  s.run.rivals.list.push(rival(4, 'pavement_ants', { alive: false }));
  assert.ok(tick(s, d, [{ type: 'conquest', uid: 4, tier: 2 }]).includes('ach_pavement_is_ours'));
  s.run.rivals.list.push(rival(5, 'old_ridge_supercolony', { alive: false }));
  assert.ok(tick(s, d, [{ type: 'conquest', uid: 5, tier: 9 }]).includes('ach_old_ridge_falls'));
  s.run.rivals.list.push(rival(6, 'great_rival', { alive: false, group: 1 }), rival(7, 'great_rival', { alive: true, group: 1 }));
  assert.deepEqual(tick(s, d, [{ type: 'conquest', uid: 6, tier: 9 }]).filter((x) => x === 'ach_front_broken'), []);
  s.run.rivals.list[s.run.rivals.list.length - 1].alive = false;
  assert.ok(tick(s, d, [{ type: 'conquest', uid: 7, tier: 9 }]).includes('ach_front_broken'));
  s.run.stats.conquests = 5;
  s.meta.counters.battlesWon = 1;
  s.meta.counters.tournamentsWon = 10;
  check(s, d);
  for (const id of ['ach_total_war', 'ach_border_dispute', 'ach_ritualist']) assert.ok(earned(s, id), id);
});

test('phragmosis needs a repelled NEST raid; big game needs a won beetle hunt', () => {
  const s = newState();
  const d = makeDerived();
  tick(s, d, [{ type: 'raidWarning', uid: 3, rival: 1, target: { type: 'trail', uid: 2 }, warn: 15 }]);
  assert.deepEqual(tick(s, d, [{ type: 'raidResult', uid: 3, win: true, foodLost: 0, broodLost: 0, workersLost: 0 }]).filter((x) => x === 'ach_phragmosis'), []);
  tick(s, d, [{ type: 'raidWarning', uid: 4, rival: 1, target: { type: 'nest' }, warn: 15 }]);
  assert.ok(tick(s, d, [{ type: 'raidResult', uid: 4, win: true, foodLost: 0, broodLost: 0, workersLost: 0 }]).includes('ach_phragmosis'));
  s.run.surface.sources.push({ uid: 9, type: 'prey_beetle', hex: 50, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: 300, cd: 0, data: {} });
  s.run.war.parties.push({ uid: 2, kind: 'hunt', target: { type: 'source', uid: 9 }, soldier: 50, supermajor: 0, path: [0, 50], pos: 1, state: 'fighting' });
  s.run.war.battles.push({ uid: 8, kind: 'hunt', hex: 50, party: 2 });
  tick(s, d);
  s.run.war.battles = [];
  s.run.surface.sources = s.run.surface.sources.filter((x) => x.uid !== 9);
  const got = tick(s, d, [{ type: 'battleEnd', uid: 8, kind: 'hunt', tag: '', win: true, lost: {}, kills: 1, odds: 1, start: { you: 50, foe: 1 } }]);
  assert.ok(got.includes('ach_big_game'));
});

test('survivor: a whole winter watched from its start with no Hungry tick', () => {
  const s = newState();
  const d = makeDerived();
  const season = (id, n = 3) => { for (let i = 0; i < n; i++) { d.season.id = id; tick(s, d); } };
  season('autumn');
  season('winter');
  s.run.colony.hungry = true;
  season('winter', 1);
  s.run.colony.hungry = false;
  season('winter');
  season('spring');
  assert.equal(earned(s, 'ach_survivor'), false, 'went hungry');
  season('summer');
  season('winter');
  season('spring');
  assert.equal(earned(s, 'ach_survivor'), true);
  // A winter joined midway (fresh d) does not count.
  const s2 = newState();
  const d2 = makeDerived();
  d2.season.id = 'winter';
  tick(s2, d2);
  d2.season.id = 'spring';
  tick(s2, d2);
  assert.equal(earned(s2, 'ach_survivor'), false);
});

test('Flight achievements are judged against the last pre-flight tick', () => {
  const s = newState();
  const d = makeDerived();
  s.run.time = 900;
  s.run.prestige.peakAt = 880;
  addEffect(s, { id: 'ev_flight_day', stat: 'flight_w', mult: 1.5, t: 100 });
  tick(s, d);
  // The fly command resets the run and awards alates (WP7); simulate its visible results.
  s.meta.counters.flights = 1;
  s.meta.counters.alatesLife = 150;
  s.run.time = 0;
  s.run.effects = [];
  s.run.stats.battles = 3;
  s.run.stats.soldiersRaised = 9;
  const got = tick(s, d);
  for (const id of ['ach_first_flight', 'ach_swift_swarm', 'ach_gentle_giants', 'ach_peak_timing', 'ach_sky_full_of_wings',
    'ach_pacifist_flight', 'ach_flying_ant_day']) assert.ok(got.includes(id), id);
  // A second, slow, warlike flight earns none of the run-end deeds.
  const s2 = newState();
  const d2 = makeDerived();
  s2.run.time = 5000;
  s2.run.stats.battles = 2;
  s2.run.stats.soldiersRaised = 4;
  s2.run.prestige.peakAt = 1000;
  tick(s2, d2);
  s2.meta.counters.flights = 1;
  s2.meta.counters.alatesLife = 20;
  const got2 = tick(s2, d2);
  assert.deepEqual(got2.filter((id) => ['ach_swift_swarm', 'ach_gentle_giants', 'ach_peak_timing', 'ach_sky_full_of_wings',
    'ach_pacifist_flight', 'ach_flying_ant_day'].includes(id)), []);
  assert.ok(got2.concat(check(s2, d2)).includes('ach_first_flight'), 'state checks run within the second');
  // Fallbacks that survive a reload: fastest flight and daughter colonies.
  const s3 = newState();
  s3.meta.stats.fastestFlightSec = ACH_PARAMS.swiftSec - 1;
  s3.cycle.daughters.push({ seed: 1, alates: 120 });
  check(s3, makeDerived());
  assert.ok(earned(s3, 'ach_swift_swarm') && earned(s3, 'ach_sky_full_of_wings'));
});

test('prestige counters, hardships and the sociobiologist', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.counters.alatesLife = 1000;
  s.meta.counters.supercolonies = 1;
  s.meta.counters.speciations = 1;
  s.cycle.hardshipTier.pacifist = 1;
  check(s, d);
  for (const id of ['ach_thousand_queens', 'ach_one_family', 'ach_living_fossil', 'ach_hardship_tier']) assert.ok(earned(s, id), id);
  assert.equal(s.meta.cosmetics.owned.cos_gold_trail, true);
  assert.equal(s.meta.cosmetics.owned.cos_amber_frame, true);
  for (const id of ['eternal_winter', 'claustral_founding', 'pacifist', 'barren_ground', 'shallow_soil']) s.era.hardshipBest[id] = 5;
  check(s, d);
  assert.equal(earned(s, 'ach_hardship_master'), false);
  s.era.hardshipBest.monomorphic = 5;
  check(s, d);
  assert.ok(earned(s, 'ach_hardship_master'));
  if (RESEARCH_ORDER.length) {
    for (const id of RESEARCH_ORDER.slice(1)) s.run.research[id] = 1;
    check(s, d);
    assert.equal(earned(s, 'ach_sociobiologist'), false);
    s.run.research[RESEARCH_ORDER[0]] = 1;
    check(s, d);
    assert.ok(earned(s, 'ach_sociobiologist'));
  }
});

test('secret and event counters: queen clicks, ladybugs, mold, rain, moles, beetles; Wilson\'s pride; field guide counts', () => {
  const s = newState();
  const d = makeDerived();
  Object.assign(s.meta.counters, { queenClicks: 500, ladybugs: 50, moldScraped: 10, rainstorms: 10, moleTunnels: 5, beetles: 50, relocations: 5 });
  check(s, d);
  for (const id of ['ach_queens_favorite', 'ach_lady_luck', 'ach_clean_house', 'ach_rain_dancer', 'ach_mole_friend', 'ach_golden_touch',
    'ach_beetle_collector', 'ach_architect']) assert.ok(earned(s, id), id);
  Object.assign(s.run.colony.adults, { minor: 50, soldier: 1, supermajor: 1, replete: 1 });
  for (const j of Object.keys(s.run.colony.jobs)) s.run.colony.jobs[j] = 1;
  check(s, d);
  assert.equal(earned(s, 'ach_wilsons_pride'), false, 'no alates yet');
  s.run.colony.alatesReared = 1;
  check(s, d);
  assert.ok(earned(s, 'ach_wilsons_pride'));
  for (const id of FG_ORDER.slice(0, 25)) s.meta.fieldGuide[id] = 0;
  check(s, d);
  assert.ok(earned(s, 'ach_naturalist'));
  assert.equal(earned(s, 'ach_field_guide_complete'), false);
  for (const id of FG_ORDER) s.meta.fieldGuide[id] = 0;
  check(s, d);
  assert.ok(earned(s, 'ach_field_guide_complete'));
});

test('progress(): numeric achievements report { cur, target } clamped; deeds return null', () => {
  const s = newState();
  const d = makeDerived();
  s.run.colony.adults.minor = 40;
  assert.deepEqual(achievements.progress(s, d, 'ach_hundred_mandibles'), { cur: 40, target: 100 });
  s.run.colony.adults.minor = 400;
  assert.deepEqual(achievements.progress(s, d, 'ach_hundred_mandibles'), { cur: 100, target: 100 });
  assert.equal(achievements.progress(s, d, 'ach_first_crumb'), null);
  assert.equal(achievements.progress(s, d, 'ach_bogus'), null);
  s.meta.achievements.ach_land_grab = 1;
  assert.deepEqual(achievements.progress(s, d, 'ach_land_grab'), { cur: 50, target: 50 });
});

test('nextGoals returns the 3 closest unearned, non-secret achievements and tick writes d.progress.goals', () => {
  const s = newState();
  const d = makeDerived();
  s.run.colony.adults.minor = 90;           // hundred mandibles 0.9
  s.meta.counters.relocations = 4;          // architect 0.8
  s.meta.counters.queenClicks = 499;        // secret: excluded
  s.run.fRun = 0.95e6;                       // feast 0.95
  s.meta.counters.caches = 7;               // treasure hunter 0.7
  s.run.stats.hatched = 0;
  const g = achievements.nextGoals(s, d);
  assert.deepEqual(g.map((x) => x.id), ['ach_feast', 'ach_hundred_mandibles', 'ach_architect']);
  assert.deepEqual(g[1], { id: 'ach_hundred_mandibles', cur: 90, target: 100 });
  assert.equal(achievements.nextGoals(s, d, 1).length, 1);
  tick(s, d);
  assert.deepEqual(d.progress.goals, achievements.nextGoals(s, d, 3));
  for (const x of d.progress.goals) assert.equal(ACHIEVEMENTS[x.id].secret, false);
});

test('ticks never throw on an empty derived cache and leave state JSON-safe', () => {
  const s = newState();
  const d = makeDerived();
  for (let i = 0; i < 50; i++) tick(s, d, [{ type: 'battleEnd' }, { type: 'conquest' }, { type: 'raidResult' }, { type: 'cellDug' }], 0.1);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
