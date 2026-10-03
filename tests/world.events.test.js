// WP6 unit tests: random-event scheduler, pity rules, cards, processes, objects and handlers (ARCHITECTURE §8.5,
// DESIGN §18). Only events.tick (plus core tickEffects) runs; other systems are reached only through the documented
// cross-calls, and the assertions never depend on what those calls do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, snapshot } from './helpers.js';
import * as events from '../src/systems/events.js';
import { EVENTS, EVENT_ORDER, EVENT_RULES } from '../src/data/events.js';
import { FROST } from '../src/data/seasons.js';
import { tickEffects, hasEffect, effectMult, effectAdd, addEffect } from '../src/core/effects.js';

const DESIGN_EVENTS = ['ev_fallen_fruit', 'ev_picnic_spill', 'ev_termite_swarm', 'ev_seed_mast_year', 'ev_pheromone_bloom',
  'ev_lost_scout_returns', 'ev_queens_vigor', 'ev_rival_mating_flight', 'ev_rival_queen_dies', 'ev_flight_day', 'ev_golden_aphid',
  'ev_mole_tunnel', 'ev_wandering_queen', 'ev_myrmecophile_guest', 'ev_phengaris_caterpillar', 'ev_rainstorm', 'ev_drought',
  'ev_mold_bloom', 'ev_ophiocordyceps', 'ev_ladybug_raid', 'ev_antlion_pit', 'ev_horned_lizard', 'ev_footstep', 'ev_brood_mites',
  'ev_phorid_flies', 'ev_fungal_blight', 'ev_army_ant_column', 'ev_frost_snap'];

/** A derived cache with income so "seconds of income" rewards are measurable. */
function derived(season = 'spring') {
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, broodSlots: 3 }, rates: { food: { gross: 10 }, insight: { gross: 2 }, chitin: { gross: 1 } } });
  d.season.id = season;
  return d;
}

/** Run events.tick (with tickEffects) for `sec` seconds; returns [{...event, at}] with at = run.time. */
function run(s, d, sec, dt = 0.1, opts = {}) {
  const out = [];
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt, ...opts });
    if (!opts.offline) tickEffects(s, dt, env);
    events.tick(s, d, dt, env);
    for (const e of env.events) out.push({ ...e, at: s.run.time });
    s.run.time += dt;
    s.meta.simTime += dt;
  }
  return out;
}

/** A busy mid-game colony in a later run (no scripted-fruit logic). */
function busyState(seed = 1, { schedule = false } = {}) {
  const s = newState(seed);
  s.run.index = 1;
  s.run.time = 4000;
  s.run.colony.adults.minor = 2000;
  s.run.colony.jobs.scout = 10;
  s.run.colony.jobs.forager = 500;
  s.run.events.nextIn = schedule ? 1 : 1e12;   // forced-event tests keep the scheduler quiet
  return s;
}

const pc = (id) => (EVENTS[id].polarity === 'neg' ? 'neg' : EVENTS[id].polarity === 'pos' ? 'pos' : 'mix');

test('data: all 28 DESIGN events, in order, with the documented entry shape', () => {
  assert.deepEqual([...EVENT_ORDER], DESIGN_EVENTS);
  for (const id of EVENT_ORDER) {
    const e = EVENTS[id];
    assert.equal(e.id, id);
    assert.ok(['pos', 'neg', 'mix', 'choice'].includes(e.polarity), id);
    for (const k of ['name', 'seasons', 'weight', 'seasonWeight', 'minRunSec', 'minAdults', 'cond', 'weather', 'choices', 'num']) {
      assert.ok(k in e, id + '.' + k);
    }
    if (e.choices) assert.equal(e.choices.filter((c) => c.def).length, 1, id + ' has exactly one default choice');
    if (e.weather) assert.ok(['ev_rainstorm', 'ev_drought'].includes(id));
  }
  assert.deepEqual(EVENTS.ev_wandering_queen.num, { layMult: 2, sec: 600, parasiteChance: 0.2, parasiteMult: 0.5, parasiteSec: 300,
    devourSec: 120, devourMin: 100 });
  // Soldier remedies (C36)
  assert.deepEqual(EVENTS.ev_ladybug_raid.choices.map((c) => c.id), ['send', 'wait']);
  assert.deepEqual(EVENTS.ev_antlion_pit.choices.map((c) => c.id), ['send', 'wait']);
  assert.deepEqual(EVENTS.ev_horned_lizard.choices.map((c) => c.id), ['reroute', 'mob', 'ignore']);
  assert.equal(EVENTS.ev_horned_lizard.choices.find((c) => c.def).id, 'reroute');
});

test('first run: no event in the first 6:00 and the scripted fruit fires at 8:00', () => {
  const s = newState();
  const d = derived('summer');
  s.run.events.nextIn = 1;   // even a due roll must wait for the scripted fruit
  const ev = run(s, d, 480.15, 0.05);
  const spawned = ev.filter((e) => e.type === 'eventSpawned');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].id, 'ev_fallen_fruit');
  assert.ok(spawned[0].at >= EVENT_RULES.scriptedFruitAt - 0.05 && spawned[0].at < EVENT_RULES.scriptedFruitAt + 0.15, 'at ' + spawned[0].at);
  assert.equal(s.run.events.scripted, true);
  assert.equal(s.meta.counters.events, 1);
  assert.equal(s.run.stats.eventsSeen, 1);
  assert.deepEqual(s.run.events.recent, ['pos']);
  assert.ok(s.run.events.nextIn > 0);
});

test('the first 3 events of the game are positive; ≤ 1 negative in any 3; ≥ 60 s between negatives', () => {
  for (const seed of [1, 2, 3, 4]) {
    const s = busyState(seed, { schedule: true });
    const d = derived('summer');
    const ev = run(s, d, 30000, 1);
    const seq = ev.filter((e) => e.type === 'eventSpawned');
    assert.ok(seq.length >= 60, 'enough events to test (' + seq.length + ')');
    assert.deepEqual(seq.slice(0, 3).map((e) => pc(e.id)), ['pos', 'pos', 'pos'], 'seed ' + seed);
    const cls = seq.map((e) => pc(e.id));
    for (let i = 0; i + 2 < cls.length; i++) {
      assert.ok(cls.slice(i, i + 3).filter((c) => c === 'neg').length <= 1, 'window at ' + i + ': ' + cls.slice(i, i + 3));
    }
    const negs = seq.filter((e) => pc(e.id) === 'neg');
    assert.ok(negs.length > 0, 'negative events do happen');
    for (let i = 1; i < negs.length; i++) assert.ok(negs[i].at - negs[i - 1].at >= EVENT_RULES.negGapSec, 'neg gap');
    assert.ok(s.run.events.recent.length <= EVENT_RULES.pityWindow);
  }
});

test('the scheduler averages one roll per 240 s', () => {
  const s = busyState(9, { schedule: true });
  const d = derived('summer');
  let rolls = 0;
  let last = s.run.events.nextIn;
  for (let i = 0; i < 48000; i++) {
    events.tick(s, d, 1, fakeEnv({ dt: 1 }));
    tickEffects(s, 1, fakeEnv({ dt: 1 }));
    if (s.run.events.nextIn > last) rolls++;
    last = s.run.events.nextIn;
    s.run.time += 1;
  }
  const mean = 48000 / rolls;
  assert.ok(mean > 200 && mean < 285, 'mean interval ' + mean);
});

test('no negative event during a raid warning', () => {
  const s = busyState(5, { schedule: true });
  const d = derived('summer');
  s.meta.counters.events = 10;
  s.run.war.raids.push({ uid: 1, rival: 1, target: { type: 'nest' }, raiders: 5, warn: 1e9, phase: 'warning', guard: 0 });
  const ev = run(s, d, 20000, 1);
  const seq = ev.filter((e) => e.type === 'eventSpawned');
  assert.ok(seq.length > 20);
  assert.equal(seq.filter((e) => pc(e.id) === 'neg').length, 0);
});

test('no events offline (nothing in run.events changes, no rolls)', () => {
  const s = busyState(6);
  const d = derived('summer');
  events.forceEvent(s, d, 'ev_wandering_queen', fakeEnv());
  const before = snapshot(s);
  const ev = run(s, d, 3600, 60, { offline: true });
  assert.equal(ev.length, 0);
  assert.deepEqual(s.run.events, before.run.events);
  assert.deepEqual(s.run.effects, before.run.effects);
});

test('a card resolves to its default choice on timeout (wandering queen → devour: max(100, 120 s) food)', () => {
  const s = busyState(7);
  const d = derived();
  s.run.events.nextIn = 1e9;
  const env = fakeEnv();
  assert.equal(events.forceEvent(s, d, 'ev_wandering_queen', env), true);
  const card = s.run.events.card;
  assert.ok(card && card.id === 'ev_wandering_queen');
  assert.equal(card.t, EVENT_RULES.cardSec);
  assert.deepEqual(card.choices, ['adopt', 'devour']);
  assert.ok(s.run.events.objects.some((o) => o.kind === 'wandering_queen'));
  assert.ok(env.events.some((e) => e.type === 'eventSpawned' && e.uid === card.uid));
  const food0 = s.run.res.food;
  const ev = run(s, d, 30.1, 0.1);
  assert.equal(s.run.events.card, null);
  const res = ev.find((e) => e.type === 'eventResolved');
  assert.deepEqual([res.id, res.choice, res.uid], ['ev_wandering_queen', 'devour', card.uid]);
  assert.ok(Math.abs(s.run.res.food - food0 - Math.max(100, 120 * 10)) < 1e-6);
  assert.ok(!s.run.events.objects.some((o) => o.kind === 'wandering_queen'), 'card object removed');
});

test('eventChoice validation codes and the adopt outcome', () => {
  const s = busyState(8);
  const d = derived();
  const h = events.handlers.eventChoice;
  assert.equal(h.validate(s, d, { type: 'eventChoice', uid: 1, choice: 'adopt' }), 'notFound');
  events.forceEvent(s, d, 'ev_wandering_queen', fakeEnv());
  const uid = s.run.events.card.uid;
  assert.equal(h.validate(s, d, { uid: uid + 1, choice: 'adopt' }), 'notFound');
  assert.equal(h.validate(s, d, { uid: String(uid), choice: 'adopt' }), 'notFound');
  assert.match(h.validate(s, d, { uid, choice: 'eat' }), /^invalid/);
  assert.match(h.validate(s, d, { uid, choice: null }), /^invalid/);
  assert.equal(h.validate(s, d, { uid, choice: 'adopt' }), null);
  const env = fakeEnv();
  h.apply(s, d, { uid, choice: 'adopt' }, env);
  assert.equal(s.run.events.card, null);
  assert.equal(effectMult(s, 'lay'), EVENTS.ev_wandering_queen.num.layMult);
  assert.ok(env.events.some((e) => e.type === 'eventResolved' && e.choice === 'adopt'));
});

test('soldier remedies are validated against the garrison (C36)', () => {
  const s = busyState(10);
  const d = derived();
  s.run.surface.trails[0].path = [0, 3, 10, 22, 38, 56];
  s.run.surface.trails[0].len = 5;
  assert.equal(events.eligible(s, d, 'ev_antlion_pit'), true);
  events.forceEvent(s, d, 'ev_antlion_pit', fakeEnv());
  const card = s.run.events.card;
  assert.equal(card.id, 'ev_antlion_pit');
  const hex = card.data.hex;
  assert.ok([3, 10, 22, 38].includes(hex), 'antlion sits between origin and source');
  const h = events.handlers.eventChoice;
  assert.match(h.validate(s, d, { uid: card.uid, choice: 'send' }), /^requirements/);
  d.combat.garrison.soldier = EVENTS.ev_antlion_pit.num.soldiers;
  assert.equal(h.validate(s, d, { uid: card.uid, choice: 'send' }), null);
  h.apply(s, d, { uid: card.uid, choice: 'send' }, fakeEnv());
  assert.equal(s.run.events.active.filter((a) => a.data.k === 'antlion').length, 0, 'threat ended at once');
  assert.equal(s.run.events.objects.filter((o) => o.kind === 'antlion').length, 0);
});

test('antlion: the default "wait" keeps the threat until the trail is rerouted away from its hex', () => {
  const s = busyState(11);
  const d = derived();
  s.run.surface.trails[0].path = [0, 3, 10, 22, 38, 56];
  events.forceEvent(s, d, 'ev_antlion_pit', fakeEnv());
  run(s, d, 31, 0.5);
  assert.equal(s.run.events.card, null);
  assert.equal(s.run.events.active.filter((a) => a.data.k === 'antlion').length, 1);
  s.run.surface.trails[0].path = [0, 1, 7, 19, 37, 56].filter((h) => h !== 3 && h !== 10 && h !== 22 && h !== 38);
  const ev = run(s, d, 1, 0.5);
  assert.equal(s.run.events.active.filter((a) => a.data.k === 'antlion').length, 0);
  assert.ok(ev.some((e) => e.type === 'eventResolved' && e.choice === 'rerouted'));
});

test('horned lizard: mob needs AP ≥ 200 × ring; reroute (default) ends with no process', () => {
  const s = busyState(12);
  const d = derived('summer');
  s.run.surface.trails[0].path = [0, 3, 10];
  events.forceEvent(s, d, 'ev_horned_lizard', fakeEnv());
  const card = s.run.events.card;
  assert.equal(card.id, 'ev_horned_lizard');
  assert.equal(card.data.hex, 3);
  assert.match(events.handlers.eventChoice.validate(s, d, { uid: card.uid, choice: 'mob' }), /^requirements/);
  run(s, d, 30.1, 0.1);
  assert.equal(s.run.events.card, null);
  assert.equal(s.run.events.active.filter((a) => a.data.k === 'lizard').length, 0);
});

test('ladybug raid: send needs 5 garrison soldiers; clicking all 10 ladybugs ends it; wait halves the colony', () => {
  const s = busyState(13);
  const d = derived('spring');
  s.run.surface.sources.push({ uid: 7, type: 'aphid_colony', hex: 10, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 8, origin: 0, src: 7, path: [0, 3, 10], len: 2, job: 'herder', workers: 4, escorts: 0, S: 0, born: 0, reroutes: [] });
  d.surface.trails = [];
  assert.equal(events.eligible(s, d, 'ev_ladybug_raid'), true);
  events.forceEvent(s, d, 'ev_ladybug_raid', fakeEnv());
  let card = s.run.events.card;
  const bugs = s.run.events.objects.filter((o) => o.kind === 'ladybug');
  assert.equal(bugs.length, EVENTS.ev_ladybug_raid.num.ladybugs);
  assert.ok(bugs.every((o) => o.hex === 10));
  assert.match(events.handlers.eventChoice.validate(s, d, { uid: card.uid, choice: 'send' }), /^requirements/);
  d.combat.escortAP = { 8: 50 * 2 };   // escort AP ≥ 50 × ring (hex 10 is ring 2)
  assert.equal(events.handlers.eventChoice.validate(s, d, { uid: card.uid, choice: 'send' }), null);
  d.combat.escortAP = {};
  const click = events.handlers.clickEventObject;
  for (const b of bugs) {
    s.run.clicks = { sec: -1, n: 0 };
    assert.equal(click.validate(s, d, { uid: b.uid }), null);
    click.apply(s, d, { uid: b.uid }, fakeEnv());
  }
  assert.equal(s.run.events.card, null, 'all ladybugs clicked away');
  assert.equal(s.meta.counters.ladybugs, 10);
  assert.equal(effectMult(s, 'source', 7), 1, 'no yield penalty');
  // Again, but wait it out.
  events.forceEvent(s, d, 'ev_ladybug_raid', fakeEnv());
  card = s.run.events.card;
  run(s, d, 30.1, 0.1);
  assert.equal(effectMult(s, 'source', 7), EVENTS.ev_ladybug_raid.num.yieldMult);
  assert.equal(s.run.events.objects.filter((o) => o.kind === 'ladybug').length, 0);
});

test('clickEventObject validation: notFound / invalid kind / hardship (C32) / clickCap', () => {
  const s = busyState(14);
  const d = derived('summer');
  const h = events.handlers.clickEventObject;
  assert.equal(h.validate(s, d, { uid: 999 }), 'notFound');
  assert.equal(h.validate(s, d, { uid: NaN }), 'notFound');
  s.run.events.objects.push({ uid: 50, kind: 'molehill', hex: 4, cell: -1, t: 100, data: {} });
  assert.match(h.validate(s, d, { uid: 50 }), /^invalid/);
  s.run.events.objects.push({ uid: 51, kind: 'golden_aphid', hex: 4, cell: -1, t: 10, data: { occ: 1 } });
  s.run.events.objects.push({ uid: 52, kind: 'footstep', hex: 4, cell: -1, t: 5, data: { occ: 2 } });
  s.run.hardship = 'claustral_founding';
  assert.equal(h.validate(s, d, { uid: 51 }), 'hardship');
  assert.equal(h.validate(s, d, { uid: 52 }), null, 'counterplay clicks stay allowed');
  s.run.hardship = null;
  s.run.clicks = { sec: Math.floor(s.run.time + 1e-9), n: 15 };
  assert.equal(h.validate(s, d, { uid: 51 }), 'clickCap');
  s.run.clicks = { sec: -1, n: 0 };
  h.apply(s, d, { uid: 51 }, fakeEnv());
  assert.equal(effectMult(s, 'honeydew'), EVENTS.ev_golden_aphid.num.mult);
  assert.equal(s.meta.counters.clicks, 1);
});

test('rival mating flight: rivals AP ×0.7 for 3 min and 30 clickable alates worth 2 s of food each', () => {
  const s = busyState(15);
  const d = derived('summer');
  s.run.rivals.list.push({ uid: 1, type: 'black_garden_ants', tier: 1, hex: 70, radius: 2, base: 15, n: 15, atk: 3, hp: 15, traits: [],
    alive: true, sighted: true, raidIn: 100, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1, extra: [], lost: [], stolen: 0 });
  assert.equal(events.eligible(s, d, 'ev_rival_mating_flight'), true);
  events.forceEvent(s, d, 'ev_rival_mating_flight', fakeEnv());
  assert.equal(effectMult(s, 'ap_rival'), 0.7);
  const alates = s.run.events.objects.filter((o) => o.kind === 'rival_alate');
  assert.equal(alates.length, 30);
  const food0 = s.run.res.food;
  events.handlers.clickEventObject.apply(s, d, { uid: alates[0].uid }, fakeEnv());
  assert.ok(Math.abs(s.run.res.food - food0 - 2 * 10) < 1e-9);
  run(s, d, 181, 1);
  assert.equal(s.run.events.objects.filter((o) => o.kind === 'rival_alate').length, 0, 'they fly off after 3 min');
});

test('eligibility: season filter, minimum run time and adults, disease immunity, one card at a time', () => {
  const s = busyState(16);
  const d = derived('winter');
  assert.equal(events.eligible(s, d, 'ev_fallen_fruit'), false, 'not in winter');
  assert.equal(events.eligible(s, d, 'ev_frost_snap'), true);
  d.season.id = 'summer';
  assert.equal(events.eligible(s, d, 'ev_fallen_fruit'), true);
  assert.equal(events.eligible(s, d, 'ev_bogus'), false);
  s.run.time = 100;
  assert.equal(events.eligible(s, d, 'ev_mole_tunnel'), false, 'needs 10 min');
  s.run.time = 4000;
  assert.equal(events.eligible(s, d, 'ev_mole_tunnel'), true);
  assert.equal(events.eligible(s, d, 'ev_mold_bloom'), true);
  s.meta.genome.metapleural_glands = 1;
  for (const id of ['ev_mold_bloom', 'ev_ophiocordyceps', 'ev_brood_mites', 'ev_fungal_blight']) assert.equal(events.eligible(s, d, id), false, id);
  s.run.colony.adults.minor = 10;
  assert.equal(events.eligible(s, d, 'ev_wandering_queen'), false, 'needs 200 adults');
  s.run.colony.adults.minor = 1000;
  assert.equal(events.eligible(s, d, 'ev_wandering_queen'), true);
  events.forceEvent(s, d, 'ev_myrmecophile_guest', fakeEnv());
  assert.equal(events.eligible(s, d, 'ev_wandering_queen'), false, 'a card is open');
  assert.equal(events.forceEvent(s, d, 'ev_wandering_queen', fakeEnv()), false);
  assert.equal(events.forceEvent(s, d, 'ev_bogus', fakeEnv()), false);
  assert.equal(events.eligible(s, d, 'ev_termite_swarm'), false, 'only after a rainstorm');
});

test('rainstorm: trail strength reset, seal (default) stops foraging 60 s, rain counter, 50 % termite swarm follow-up', () => {
  let swarms = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = busyState(seed);
    const d = derived('spring');
    s.run.events.nextIn = 1e9;
    events.forceEvent(s, d, 'ev_rainstorm', fakeEnv());
    assert.equal(s.meta.counters.rainstorms, 1);
    assert.equal(s.run.events.card.id, 'ev_rainstorm');
    assert.equal(events.eligible(s, d, 'ev_termite_swarm'), true);
    const ev = run(s, d, 125, 0.5);
    if (seed === 1) {
      const res = ev.find((e) => e.type === 'eventResolved' && e.id === 'ev_rainstorm');
      assert.equal(res.choice, 'seal');
    }
    if (ev.some((e) => e.type === 'eventSpawned' && e.id === 'ev_termite_swarm')) swarms++;
    assert.equal(events.eligible(s, d, 'ev_termite_swarm'), false, 'window closed');
  }
  assert.ok(swarms >= 10 && swarms <= 30, 'about half: ' + swarms);
  const s = busyState(3);
  const d = derived('spring');
  events.forceEvent(s, d, 'ev_rainstorm', fakeEnv());
  events.handlers.eventChoice.apply(s, d, { uid: s.run.events.card.uid, choice: 'seal' }, fakeEnv());
  assert.equal(effectMult(s, 'surface_work'), 0);
});

test('rainstorm keep: topsoil chambers −50 % for 60 s with a 25 % flood; bailFlood shortens the flood; drainage prevents both', () => {
  let floods = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const s = busyState(seed);
    const d = derived('spring');
    events.forceEvent(s, d, 'ev_rainstorm', fakeEnv());
    events.handlers.eventChoice.apply(s, d, { uid: s.run.events.card.uid, choice: 'keep' }, fakeEnv());
    assert.equal(effectMult(s, 'chamber_layer', 'topsoil') <= 0.5, true);
    if (hasEffect(s, 'ev_flood')) {
      floods++;
      assert.equal(events.handlers.bailFlood.validate(s, d, {}), null);
      const t0 = s.run.effects.find((e) => e.id === 'ev_flood').t;
      events.handlers.bailFlood.apply(s, d, {}, fakeEnv());
      assert.equal(s.run.effects.find((e) => e.id === 'ev_flood').t, t0 - EVENTS.ev_rainstorm.num.bailSec);
    } else {
      assert.equal(events.handlers.bailFlood.validate(s, d, {}), 'notFound');
    }
  }
  assert.ok(floods >= 6 && floods <= 26, 'about a quarter: ' + floods);
  const s = busyState(2);
  const d = derived('spring');
  s.run.research.drainage = 1;
  events.forceEvent(s, d, 'ev_rainstorm', fakeEnv());
  events.handlers.eventChoice.apply(s, d, { uid: s.run.events.card.uid, choice: 'keep' }, fakeEnv());
  assert.equal(effectMult(s, 'chamber_layer', 'topsoil'), 1);
});

test('weather_sense: weather events are announced 30 s ahead (forecast entry), then fire', () => {
  const s = busyState(17, { schedule: true });
  const d = derived('summer');
  s.run.research.weather_sense = 1;
  s.meta.counters.events = 10;
  // Only weather events eligible: summer, but block everything else by making it the only candidate.
  let forecastSeen = false;
  let fired = null;
  for (let i = 0; i < 40000 && !fired; i++) {
    const env = fakeEnv({ dt: 1 });
    tickEffects(s, 1, env);
    events.tick(s, d, 1, env);
    if (s.run.events.active.some((a) => a.data.forecast === true)) forecastSeen = true;
    const sp = env.events.find((e) => e.type === 'eventSpawned' && EVENTS[e.id].weather);
    if (sp) fired = sp;
    s.run.time += 1;
  }
  assert.ok(fired, 'a weather event fired');
  assert.ok(forecastSeen, 'it was forecast first');
});

test('drought: leaves ×0.5, flowers ×0.3, honeydew ×1.5 for 3 min; a Water Well makes the colony immune', () => {
  const s = busyState(18);
  const d = derived('summer');
  events.forceEvent(s, d, 'ev_drought', fakeEnv());
  assert.equal(effectMult(s, 'source_type', 'leaf_plant'), 0.5);
  assert.equal(effectMult(s, 'source_type', 'flower_patch'), 0.3);
  assert.equal(effectMult(s, 'honeydew'), 1.5);
  const s2 = busyState(18);
  const d2 = derived('summer');
  d2.nest.agg.wells = 1;
  events.forceEvent(s2, d2, 'ev_drought', fakeEnv());
  assert.equal(effectMult(s2, 'source_type', 'leaf_plant'), 1);
  assert.equal(effectMult(s2, 'source_type', 'flower_patch'), 1);
});

test('mold bloom: 3–6 spots halve their chambers until scraped; unscraped spots spread +1 per 60 s', () => {
  const s = busyState(19);
  const d = derived();
  events.forceEvent(s, d, 'ev_mold_bloom', fakeEnv());
  const spots = s.run.events.objects.filter((o) => o.kind === 'mold');
  assert.ok(spots.length >= 3 && spots.length <= 6);
  for (const o of spots) {
    assert.equal(o.data.chamber, 1, 'the Royal Chamber is the only chamber');
    assert.ok(s.run.effects.some((e) => e.id === 'mold:' + o.uid && e.stat === 'chamber' && e.scope === 1 && e.mult === 0.5 && e.t === -1));
  }
  run(s, d, 60.5, 0.5);
  assert.equal(s.run.events.objects.filter((o) => o.kind === 'mold').length, spots.length + 1);
  const h = events.handlers.scrapeMold;
  assert.equal(h.validate(s, d, { uid: 12345 }), 'notFound');
  for (const o of s.run.events.objects.filter((x) => x.kind === 'mold')) {
    s.run.clicks = { sec: -1, n: 0 };
    assert.equal(h.validate(s, d, { uid: o.uid }), null);
    h.apply(s, d, { uid: o.uid }, fakeEnv());
  }
  assert.equal(s.run.effects.filter((e) => e.id.startsWith('mold:')).length, 0);
  assert.equal(s.meta.counters.moldScraped, spots.length + 1);
  run(s, d, 61, 1);
  assert.equal(s.run.events.objects.filter((o) => o.kind === 'mold').length, 0, 'spreading stops once scraped');
});

test('frost snap freezes rows 0–3 for 2 min (frost_snap effect)', () => {
  const s = busyState(20);
  const d = derived('autumn');
  events.forceEvent(s, d, 'ev_frost_snap', fakeEnv());
  assert.equal(effectAdd(s, 'frost_snap'), FROST.snapRows);
  assert.equal(s.run.effects.find((e) => e.id === 'ev_frost_snap').t, FROST.snapSec);
});

test('timed buffs: queen\'s vigor, pheromone bloom, phorid flies, flight day, seed mast', () => {
  const s = busyState(21);
  const d = derived('autumn');
  d.season.toNext = 123;
  events.forceEvent(s, d, 'ev_queens_vigor', fakeEnv());
  events.forceEvent(s, d, 'ev_pheromone_bloom', fakeEnv());
  events.forceEvent(s, d, 'ev_phorid_flies', fakeEnv());
  events.forceEvent(s, d, 'ev_flight_day', fakeEnv());
  events.forceEvent(s, d, 'ev_seed_mast_year', fakeEnv());
  assert.equal(effectMult(s, 'lay'), 3);
  assert.equal(effectMult(s, 'insight'), 2);
  assert.equal(effectMult(s, 'atk_player'), 0.5);
  assert.equal(effectMult(s, 'forage_unescorted'), 0.9);
  assert.equal(effectMult(s, 'flight_w'), 1.5);
  assert.equal(effectMult(s, 'source_type', 'seed_patch'), 3);
  assert.equal(s.run.effects.find((e) => e.id === 'ev_seed_mast_year').t, 123, 'for the rest of the season');
  assert.equal(s.run.events.seedMastYear, s.meta.season.year);
  assert.equal(events.eligible(s, d, 'ev_seed_mast_year'), false, 'once per year');
});

test('brood mites: brood time ×1.5 unless nurses ≥ 1 per brood slot', () => {
  const s = busyState(22);
  const d = derived();
  events.forceEvent(s, d, 'ev_brood_mites', fakeEnv());
  assert.equal(effectMult(s, 'brood_time'), 1.5);
  s.run.colony.jobs.nurse = 3;
  run(s, d, 1, 0.5);
  assert.equal(effectMult(s, 'brood_time'), 1);
  s.run.colony.jobs.nurse = 0;
  run(s, d, 1, 0.5);
  assert.equal(effectMult(s, 'brood_time'), 1.5);
  run(s, d, 120, 1);
  assert.equal(effectMult(s, 'brood_time'), 1);
  assert.equal(s.run.events.active.length, 0);
});

test('fungal blight: quarantine loses 30 % fungus; 20 clean clicks within 15 s save it all', () => {
  const s = busyState(23);
  const d = derived();
  s.run.nest.chambers.push({ uid: 5, type: 'fungus_garden', k: 0, x: 10, y: 12, w: 3, h: 2, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 });
  s.run.res.fungus = 100;
  assert.equal(events.eligible(s, d, 'ev_fungal_blight'), true);
  events.forceEvent(s, d, 'ev_fungal_blight', fakeEnv());
  run(s, d, 30.1, 0.1);
  assert.ok(Math.abs(s.run.res.fungus - 70) < 1e-9);
  events.forceEvent(s, d, 'ev_fungal_blight', fakeEnv());
  const h = events.handlers.cleanBlight;
  for (let i = 0; i < 20; i++) {
    s.run.clicks = { sec: -1, n: 0 };
    assert.equal(h.validate(s, d, {}), null);
    h.apply(s, d, {}, fakeEnv());
  }
  assert.equal(s.run.events.card, null);
  assert.equal(s.run.events.active.length, 0);
  run(s, d, 20, 1);
  assert.ok(Math.abs(s.run.res.fungus - 70) < 1e-9, 'no loss');
  assert.equal(h.validate(s, d, {}), 'notFound');
});

test('army ant column: evacuate (default) stops foraging 60 s and costs 5 % of stored food; fight needs soldiers', () => {
  const s = busyState(24);
  const d = derived();
  s.run.res.food = 1000;
  events.forceEvent(s, d, 'ev_army_ant_column', fakeEnv());
  const card = s.run.events.card;
  assert.equal(card.id, 'ev_army_ant_column');
  assert.ok(s.run.events.objects.some((o) => o.kind === 'army_column'));
  assert.match(events.handlers.eventChoice.validate(s, d, { uid: card.uid, choice: 'fight' }), /^requirements/);
  d.combat.garrison.soldier = 10;
  assert.equal(events.handlers.eventChoice.validate(s, d, { uid: card.uid, choice: 'fight' }), null);
  run(s, d, 30.1, 0.1);
  assert.equal(effectMult(s, 'surface_work'), 0);
  assert.ok(Math.abs(s.run.res.food - 950) < 1e-6);
});

test('footstep: a garden-path hex is required; clicking scatters it, otherwise it lands after 5 s', () => {
  const s = busyState(25);
  const d = derived('summer');
  assert.equal(events.eligible(s, d, 'ev_footstep'), false, 'all-grass skeleton has no garden path');
  s.run.surface.terrain[20] = 3;   // TERRAIN_ORDER index of garden_path
  const ok = events.eligible(s, d, 'ev_footstep');
  if (!ok) return;   // terrain table not loaded yet
  events.forceEvent(s, d, 'ev_footstep', fakeEnv());
  const o = s.run.events.objects.find((x) => x.kind === 'footstep');
  assert.equal(o.hex, 20);
  assert.equal(o.t, EVENTS.ev_footstep.num.sec);
  const ev = run(s, d, 5.1, 0.1);
  assert.ok(ev.some((e) => e.type === 'eventResolved' && e.choice === 'stomped'));
  events.forceEvent(s, d, 'ev_footstep', fakeEnv());
  const o2 = s.run.events.objects.find((x) => x.kind === 'footstep');
  const env = fakeEnv();
  s.run.clicks = { sec: -1, n: 0 };
  events.handlers.clickEventObject.apply(s, d, { uid: o2.uid }, env);
  assert.ok(env.events.some((e) => e.type === 'eventResolved' && e.choice === 'scattered'));
});

test('phengaris: adopting ends 3 min later as a butterfly worth max(100, 120 s) insight', () => {
  const s = busyState(26);
  const d = derived('summer');
  events.forceEvent(s, d, 'ev_phengaris_caterpillar', fakeEnv());
  const uid = s.run.events.card.uid;
  events.handlers.eventChoice.apply(s, d, { uid, choice: 'adopt' }, fakeEnv());
  const ins0 = s.run.res.insight;
  const ev = run(s, d, 181, 1);
  assert.ok(ev.some((e) => e.type === 'eventResolved' && e.id === 'ev_phengaris_caterpillar' && e.choice === 'butterfly' && e.uid === uid));
  assert.ok(Math.abs(s.run.res.insight - ins0 - Math.max(100, 120 * 2)) < 1e-9);
  assert.equal(s.run.events.objects.filter((o) => o.kind === 'phengaris').length, 0);
});

test('ophiocordyceps quarantine: forage −20 % for 2 min; myrmecophile expel: max(20, 30 s) chitin', () => {
  const s = busyState(27);
  const d = derived();
  events.forceEvent(s, d, 'ev_ophiocordyceps', fakeEnv());
  run(s, d, 30.1, 0.1);
  assert.equal(effectMult(s, 'forage'), 0.8);
  events.forceEvent(s, d, 'ev_myrmecophile_guest', fakeEnv());
  const c0 = s.run.res.chitin;
  run(s, d, 30.1, 0.1);
  assert.ok(Math.abs(s.run.res.chitin - c0 - Math.max(20, 30 * 1)) < 1e-9);
  events.forceEvent(s, d, 'ev_myrmecophile_guest', fakeEnv());
  events.handlers.eventChoice.apply(s, d, { uid: s.run.events.card.uid, choice: 'accept' }, fakeEnv());
  assert.equal(s.run.effects.find((e) => e.id === 'ev_myrmecophile_guest').add, 0.15);
});

test('ophiocordyceps ignore: the outbreak ends after 3 min; under 1 % losses resolves as "averted", else "ended"', () => {
  // Foragers taken off the job: the infection has no hosts, nobody dies → averted.
  const s = busyState(31);
  const d = derived();
  events.forceEvent(s, d, 'ev_ophiocordyceps', fakeEnv());
  events.handlers.eventChoice.apply(s, d, { uid: s.run.events.card.uid, choice: 'ignore' }, fakeEnv());
  s.run.colony.jobs.forager = 0;
  const ev = run(s, d, 181, 1);
  const res = ev.find((e) => e.type === 'eventResolved' && e.id === 'ev_ophiocordyceps');
  assert.ok(res, 'the outbreak resolved');
  assert.equal(res.choice, 'averted');
  // Left alone with 500 foragers: 1 % × 1.5^3 ≈ 3.4 % of them die → ended.
  const s2 = busyState(32);
  const d2 = derived();
  events.forceEvent(s2, d2, 'ev_ophiocordyceps', fakeEnv());
  events.handlers.eventChoice.apply(s2, d2, { uid: s2.run.events.card.uid, choice: 'ignore' }, fakeEnv());
  const ev2 = run(s2, d2, 181, 1);
  const died = ev2.filter((e) => e.type === 'adultsDied' && e.cause === 'cordyceps').reduce((a, e) => a + e.n, 0);
  const res2 = ev2.find((e) => e.type === 'eventResolved' && e.id === 'ev_ophiocordyceps');
  assert.ok(died >= EVENTS.ev_ophiocordyceps.num.avertLoss * 500, 'died ' + died);
  assert.equal(res2.choice, 'ended');
});

test('lost scout returns: reveals the 3 nearest frontier hexes and grants max(30, 120 s) insight', () => {
  const s = busyState(28);
  const d = derived();
  const ins0 = s.run.res.insight;
  events.forceEvent(s, d, 'ev_lost_scout_returns', fakeEnv());
  assert.ok(s.run.res.insight - ins0 >= Math.max(30, 120 * 2) - 1e-9);
});

test('every event can be forced from a prepared state without throwing and leaves JSON-safe state', () => {
  const s = busyState(29);
  s.run.surface.sources.push({ uid: 7, type: 'aphid_colony', hex: 10, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 8, origin: 0, src: 7, path: [0, 3, 10, 22, 38, 56], len: 5, job: 'herder', workers: 4, escorts: 0, S: 0, born: 0, reroutes: [] });
  s.run.rivals.list.push({ uid: 1, type: 'black_garden_ants', tier: 1, hex: 70, radius: 2, base: 15, n: 15, atk: 3, hp: 15, traits: [],
    alive: true, sighted: true, raidIn: 100, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 0, fallenAt: -1, extra: [], lost: [], stolen: 0 });
  s.run.nest.chambers.push({ uid: 5, type: 'fungus_garden', k: 0, x: 10, y: 12, w: 3, h: 2, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 });
  const d = derived('summer');
  for (const id of EVENT_ORDER) {
    if (s.run.events.card) run(s, d, 31, 1);
    const env = fakeEnv();
    const ok = events.forceEvent(s, d, id, env);
    assert.equal(typeof ok, 'boolean');
    if (ok) assert.ok(env.events.some((e) => e.type === 'eventSpawned' && e.id === id), id);
    run(s, d, 5, 1);
  }
  run(s, d, 400, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.meta.counters.events >= 20, true);
});
