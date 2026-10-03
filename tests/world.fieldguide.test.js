// WP6 unit tests: Field Guide entries, triggers and insight payouts (ARCHITECTURE §8.5, DESIGN §20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import * as fieldguide from '../src/systems/fieldguide.js';
import { FG_ORDER, FIELD_GUIDE, FG_REWARD } from '../src/data/fieldGuide.js';

const DESIGN_FG = ['fg_founding_queen', 'fg_nanitics', 'fg_trail_pheromone', 'fg_double_bridge', 'fg_tandem_running', 'fg_polyethism',
  'fg_polymorphism', 'fg_trophic_eggs', 'fg_repletes', 'fg_supermajors', 'fg_alates', 'fg_nuptial_flight', 'fg_trophobiosis',
  'fg_root_aphids', 'fg_lycaenid', 'fg_fungus_gardens', 'fg_weeder_ants', 'fg_midden', 'fg_mound_heat', 'fg_overwintering',
  'fg_seed_harvesting', 'fg_square_law', 'fg_ritual_tournaments', 'fg_black_garden_ant', 'fg_pavement_ant', 'fg_red_wood_ant',
  'fg_carpenter_ant', 'fg_fire_ant', 'fg_slave_maker', 'fg_army_ant', 'fg_argentine_ant', 'fg_ladybird', 'fg_antlion',
  'fg_horned_lizard', 'fg_ophiocordyceps', 'fg_phengaris', 'fg_phorid_flies', 'fg_myrmecophiles', 'fg_twenty_quadrillion', 'fg_amber'];

/** One field-guide tick with injected events; returns the unlocked ids. */
function tick(s, d, events = []) {
  const env = fakeEnv();
  for (const e of events) env.events.push(e);
  fieldguide.tick(s, d, 0.1, env);
  s.meta.simTime += 0.1;
  return env.events.filter((e) => e.type === 'fieldGuide').map((e) => e.id);
}

const has = (s, id) => Object.prototype.hasOwnProperty.call(s.meta.fieldGuide, id);
const rival = (uid, type, sighted) => ({ uid, type, tier: 1, hex: 70, radius: 2, base: 15, n: 15, atk: 3, hp: 15, traits: [], alive: true,
  sighted, raidIn: 100, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1, extra: [], lost: [], stolen: 0 });

test('data: all 40 DESIGN entries in order; notes are 40–60 words, in-house, no quotations', () => {
  assert.deepEqual([...FG_ORDER], DESIGN_FG);
  assert.equal(FG_ORDER.length, 40);
  assert.deepEqual({ ...FG_REWARD }, { sec: 30, min: 10 });
  for (const id of FG_ORDER) {
    const e = FIELD_GUIDE[id];
    assert.equal(e.id, id);
    assert.ok(e.title && e.cat && e.trigger, id);
    const words = e.note.trim().split(/\s+/).length;
    assert.ok(words >= 40 && words <= 60, id + ' has ' + words + ' words');
    assert.ok(!/["“”«»]/.test(e.note), id + ' contains a quotation mark');
  }
  assert.equal(new Set(FG_ORDER.map((id) => FIELD_GUIDE[id].note)).size, 40, 'notes are distinct');
});

test('the founding queen unlocks on the first tick of a new game and pays max(10, 30 s of insight)', () => {
  const s = newState();
  const d = makeDerived({ rates: { insight: { gross: 0 } } });
  const ids = tick(s, d);
  assert.deepEqual(ids, ['fg_founding_queen']);
  assert.equal(s.meta.fieldGuide.fg_founding_queen, 0);
  assert.equal(s.run.res.insight, FG_REWARD.min);
  assert.deepEqual(tick(s, d), [], 'once only');
  d.rates.insight.gross = 2;
  s.run.colony.adults.minor = 1;
  tick(s, d);
  assert.equal(s.run.res.insight, FG_REWARD.min + 60);
});

test('research, caste, chamber, season, mound, counter and census triggers', () => {
  const s = newState();
  const d = makeDerived();
  tick(s, d);
  s.run.research.double_bridge = 1;
  s.run.research.weeder_ants = 1;
  s.run.colony.adults.replete = 1;
  s.run.colony.alatesReared = 1;
  s.run.nest.chambers.push({ uid: 9, type: 'midden', k: 0, x: 2, y: 10, w: 2, h: 2, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 });
  s.run.nest.chambers.push({ uid: 10, type: 'fungus_garden', k: 0, x: 6, y: 10, w: 3, h: 2, level: 0, target: 1, status: 'digging', blueprint: false, bornAt: 0 });
  s.run.surface.mound = 5;
  s.meta.counters.flights = 1;
  s.meta.counters.amber = 1;
  d.season.id = 'winter';
  d.meta.census = 1e9;
  const ids = tick(s, d);
  for (const id of ['fg_double_bridge', 'fg_weeder_ants', 'fg_repletes', 'fg_alates', 'fg_midden', 'fg_mound_heat', 'fg_nuptial_flight',
    'fg_amber', 'fg_overwintering', 'fg_twenty_quadrillion', 'fg_nanitics']) assert.ok(ids.includes(id), id);
  assert.equal(has(s, 'fg_fungus_gardens'), false, 'a chamber still being dug does not count');
  assert.equal(has(s, 'fg_supermajors'), false);
});

test('rival entries unlock when that rival is sighted (state flag or rivalSighted looked up by uid)', () => {
  const s = newState();
  const d = makeDerived();
  s.run.rivals.list.push(rival(1, 'black_garden_ants', false), rival(2, 'fire_ants', true), rival(3, 'pavement_ants', false));
  const ids = tick(s, d);
  assert.ok(ids.includes('fg_fire_ant'));
  assert.equal(has(s, 'fg_black_garden_ant'), false);
  const ids2 = tick(s, d, [{ type: 'rivalSighted', uid: 3 }]);
  assert.ok(ids2.includes('fg_pavement_ant'));
});

test('event entries unlock from eventSpawned; first trail from trailCreated; first battle from battleStart', () => {
  const s = newState();
  const d = makeDerived();
  assert.ok(!tick(s, d, [{ type: 'trailCreated', uid: 2 }]).includes('fg_trail_pheromone'), 'the starting trail at run.time 0 does not count');
  s.run.time = 30;
  const ids = tick(s, d, [
    { type: 'eventSpawned', uid: 4, id: 'ev_antlion_pit' }, { type: 'eventSpawned', uid: 5, id: 'ev_phorid_flies' },
    { type: 'trailCreated', uid: 9 }, { type: 'battleStart', uid: 1, kind: 'raid', hex: 5, below: false },
  ]);
  for (const id of ['fg_antlion', 'fg_phorid_flies', 'fg_trail_pheromone', 'fg_square_law']) assert.ok(ids.includes(id), id);
  assert.equal(has(s, 'fg_ladybird'), false);
  s.run.events.card = { uid: 7, id: 'ev_ladybug_raid', t: 20, choices: ['send', 'wait'], data: {} };
  assert.ok(tick(s, d).includes('fg_ladybird'), 'an open card counts as the encounter');
});

test('surface encounters: seed patch and Lycaenid on revealed hexes; herded aphids', () => {
  const s = newState();
  const d = makeDerived();
  tick(s, d);
  s.run.surface.sources.push({ uid: 5, type: 'seed_patch', hex: 200, stock: 300, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  tick(s, d);
  assert.equal(has(s, 'fg_seed_harvesting'), false, 'hidden in the fog');
  s.run.surface.revealed[200] = 1;
  assert.ok(tick(s, d).includes('fg_seed_harvesting'));
  s.run.surface.sources.push({ uid: 6, type: 'aphid_colony', hex: 10, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 7, origin: 0, src: 6, path: [0, 3, 10], len: 2, job: 'herder', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  tick(s, d);
  assert.equal(has(s, 'fg_trophobiosis'), false, 'no herders yet');
  d.surface.trails = [{ uid: 7, workers: 2 }];
  assert.ok(tick(s, d).includes('fg_trophobiosis'));
});

test('every entry has a reachable trigger (each unlocks from a state built for it)', () => {
  const s = newState();
  const d = makeDerived();
  for (const r of ['black_garden_ants', 'pavement_ants', 'red_wood_ants', 'carpenter_ants', 'fire_ants', 'slave_makers', 'great_rival']) {
    s.run.rivals.list.push(rival(s.run.rivals.list.length + 1, r, true));
  }
  for (const id of ['double_bridge', 'tandem_running', 'age_polyethism', 'polymorphism', 'trophic_eggs', 'weeder_ants']) s.run.research[id] = 1;
  Object.assign(s.run.colony.adults, { minor: 5, supermajor: 1, replete: 1 });
  s.run.colony.alatesReared = 1;
  for (const [i, type] of ['root_aphid_pen', 'fungus_garden', 'midden'].entries()) {
    s.run.nest.chambers.push({ uid: 20 + i, type, k: 0, x: 2 + 5 * i, y: 12, w: 3, h: 2, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 });
  }
  s.run.surface.sources.push({ uid: 30, type: 'lycaenid_caterpillar', hex: 5, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.sources.push({ uid: 31, type: 'seed_patch', hex: 6, stock: 300, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.sources.push({ uid: 32, type: 'aphid_colony', hex: 4, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 33, origin: 0, src: 32, path: [0, 4], len: 1, job: 'herder', workers: 3, escorts: 0, S: 0, born: 0, reroutes: [] });
  s.run.surface.mound = 5;
  Object.assign(s.meta.counters, { flights: 1, amber: 1, tournamentsWon: 1 });
  s.run.stats.battles = 1;
  d.season.id = 'winter';
  d.meta.census = 1e9;
  tick(s, d);
  const evs = ['ev_army_ant_column', 'ev_ladybug_raid', 'ev_antlion_pit', 'ev_horned_lizard', 'ev_ophiocordyceps', 'ev_phengaris_caterpillar',
    'ev_phorid_flies', 'ev_myrmecophile_guest'].map((id, i) => ({ type: 'eventSpawned', uid: 100 + i, id }));
  tick(s, d, evs);
  const missing = FG_ORDER.filter((id) => !has(s, id));
  assert.deepEqual(missing, []);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
