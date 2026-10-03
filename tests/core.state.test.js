// WP1 unit tests: core/state.js (schema, skeleton world, helpers, click cap) and core/derived.js defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, createState, createRun, createCycle, createEra, defaultNestCells, adultsTotal, broodTotal, popN,
  clickAvailable, consumeClick,
} from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';
import { CELL } from '../src/data/balance.js';
import { findBadValues } from './helpers.js';

test('createState passes JSON deep-equality and has no schema violations', () => {
  const s = createState();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
  assert.deepEqual(findBadValues(s), []);
  const s2 = createState({ seed: 987654321 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s2)), s2);
});

test('top-level shape, version and seed handling', () => {
  const s = createState();
  assert.deepEqual(Object.keys(s), ['v', 'rng', 'meta', 'era', 'cycle', 'run']);
  assert.equal(s.v, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(s.rng, 1);
  assert.equal(s.run.seed, 1);
  assert.equal(s.run.mapSeed, 1);
  assert.equal(createState({ seed: 0 }).rng, 1);
  assert.equal(createState({ seed: 2 ** 32 + 7 }).rng, 7);
  assert.equal(createState({ seed: 42 }).run.seed, 42);
  // fresh objects every call
  const a = createState();
  const b = createState();
  a.run.res.food = 99;
  a.meta.automation.autobuy.priority.push('x');
  assert.equal(b.run.res.food, 5);
  assert.deepEqual(b.meta.automation.autobuy.priority, ['adaptations', 'chambers', 'mound']);
});

test('meta defaults per ARCHITECTURE §4', () => {
  const m = createState().meta;
  assert.deepEqual(m.settings, { notation: 'suffix', autosaveSec: 15, reducedMotion: false, sound: false, harshNature: false,
    retreatAt: 0.6, colonyName: '', queenName: '', showScaleLabel: true });
  assert.equal(m.pending, null);
  assert.deepEqual(m.season, { t: 0, year: 0, lengthSec: 360, extraSpring: 0 });
  assert.deepEqual(m.reveal, { queue: [], lastAt: -1e9 });
  assert.deepEqual(m.speciesUnlocked, { garden_ant: true });
  assert.deepEqual(m.diapause, { bank: 0, active: false });
  assert.deepEqual(m.cosmetics, { owned: {}, equipped: {} });
  assert.deepEqual(m.automation.autoFlight, { on: false, mode: 'peak', alates: 0, minutes: 30 });
  assert.deepEqual(m.automation.autoSuper, { on: false, mode: 'kinship', kinship: 0, hours: 6 });
  assert.deepEqual(m.automation.keep, { jobTargets: null, casteTargets: null });
  assert.equal(Object.keys(m.counters).length, 21);
  assert.ok(Object.values(m.counters).every((v) => v === 0));
  assert.equal(m.stats.nanGuards, 0);
  assert.deepEqual(m.onboarding, { done: {} });
  assert.deepEqual(m.flags, { clockSkew: false, endingSeen: false });
});

test('era and cycle factories', () => {
  assert.deepEqual(createEra(), { species: 'garden_ant', kinship: 0, kinshipLife: 0, federation: {}, heirlooms: [], innate: {},
    researchRuns: {}, hardshipBest: {}, blueprints: [], activeBlueprint: -1, startedAt: 0 });
  assert.deepEqual(createCycle(), { alates: 0, alatesCycle: 0, traits: {}, hardshipTier: {}, edict: null, daughters: [], startedAt: 0 });
});

test('default nest grid: shaft, Royal Chamber, everything else soil (§4.2)', () => {
  const c = defaultNestCells();
  assert.equal(c.length, 3200);
  let tunnels = 0, chambers = 0;
  for (let i = 0; i < c.length; i++) {
    const x = i % 40, y = Math.floor(i / 40);
    let want = CELL.SOIL;
    if (x === 20 && y <= 19) want = CELL.TUNNEL;
    if (y >= 20 && y <= 21 && x >= 18 && x <= 21) want = CELL.CHAMBER;
    assert.equal(c[i], want, 'cell ' + x + ',' + y);
    if (c[i] === CELL.TUNNEL) tunnels++;
    if (c[i] === CELL.CHAMBER) chambers++;
  }
  assert.equal(tunnels, 20);
  assert.equal(chambers, 8);
});

test('skeleton run: nest, surface, crumb source and trail (§4, §4.2)', () => {
  const r = createRun(5);
  assert.equal(r.seed, 5);
  assert.deepEqual(r.res, { food: 5, soil: 0, insight: 0, pheromone: 0, chitin: 0, honeydew: 0, leaves: 0, fungus: 0 });
  assert.equal(r.colony.layAcc, 1);
  assert.equal(r.colony.naniticsLeft, 5);
  assert.deepEqual(r.colony.jobTargets, { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 });
  assert.deepEqual(r.nest.chambers, [{ uid: 1, type: 'royal_chamber', k: 0, x: 18, y: 20, w: 4, h: 2, level: 1, target: 1,
    status: 'active', blueprint: false, bornAt: 0 }]);
  assert.equal(r.nest.nextUid, 2);
  assert.deepEqual(r.nest.shafts, [{ kind: 'main', col: 20, open: true, ref: -1 }]);
  assert.equal(r.nest.deepestRow, 21);
  assert.equal(r.nest.rev, 1);
  const sf = r.surface;
  assert.equal(sf.radius, 8);
  for (const k of ['terrain', 'revealed', 'claimed', 'conquered']) assert.equal(sf[k].length, 817);
  assert.ok(sf.terrain.every((t) => t === 0));
  assert.equal(sf.revealed.filter((v) => v === 1).length, 19);
  assert.ok(sf.revealed.slice(0, 19).every((v) => v === 1));
  assert.ok(sf.claimed.every((v) => v === 0) && sf.conquered.every((v) => v === 0));
  assert.deepEqual(sf.sources, [{ uid: 1, type: 'crumb_scatter', hex: 3, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} }]);
  assert.deepEqual(sf.trails, [{ uid: 2, origin: 0, src: 1, path: [0, 3], len: 1, job: 'forager', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] }]);
  assert.equal(sf.nextUid, 3);
  assert.deepEqual(sf.entrances, [{ kind: 'main', hex: 0, col: 20, ref: -1 }]);
  assert.deepEqual(sf.spawn, { insect: 180, prey: 360, boonPrey: 0 });
  assert.deepEqual(r.rivals, { list: [], nextUid: 1, respawn: [], topTier: 0 });
  assert.deepEqual(r.war, { parties: [], battles: [], raids: [], triage: [], nextUid: 1 });
  assert.equal(r.events.nextIn, 480);
  assert.equal(r.events.lastNegAt, -1e9);
  assert.deepEqual(r.golden, { beetleIn: 0, beetle: null, pupa: null, lastPupaAt: -1e9, gifts: [] });
  assert.deepEqual(r.clicks, { sec: -1, n: 0 });
  assert.deepEqual(r.bottleneck, { id: null, since: 0, capT: 0 });
  assert.deepEqual(Object.keys(r.stats), ['eggs', 'hatched', 'soldiersRaised', 'maxAdults', 'foodWasted', 'hungryEver',
    'winterHungry', 'cellsDug', 'chambersDone', 'relocations', 'sourcesDepleted', 'battles', 'battlesWon', 'conquests', 'kills',
    'raidsIncoming', 'eventsSeen']);
});

test('adultsTotal, broodTotal, popN', () => {
  const s = createState();
  assert.equal(adultsTotal(s), 0);
  s.run.colony.adults = { minor: 10, soldier: 2, supermajor: 1, replete: 3 };
  s.run.colony.alatesReared = 4;
  s.run.colony.brood = [{ c: 'minor', n: 3, p: 0, t: 0 }, { c: 'soldier', n: 1.5, p: 0.2, t: 1 }];
  assert.equal(adultsTotal(s), 16);
  assert.equal(broodTotal(s), 4.5);
  assert.equal(popN(s), 24.5);
});

test('click cap: 15 per integer second of run.time, shared, pure availability check', () => {
  const s = createState();
  for (let i = 0; i < 15; i++) {
    assert.equal(clickAvailable(s), true);
    assert.equal(consumeClick(s), true);
  }
  assert.equal(clickAvailable(s), false);
  assert.equal(consumeClick(s), false);
  assert.equal(s.meta.counters.clicks, 15);
  assert.deepEqual(s.run.clicks, { sec: 0, n: 15 });
  // clickAvailable never mutates
  const before = JSON.stringify(s);
  clickAvailable(s);
  assert.equal(JSON.stringify(s), before);
  // the next integer second resets the bucket (run.time accumulated in 0.1 steps)
  for (let i = 0; i < 10; i++) s.run.time += 0.1;
  assert.equal(clickAvailable(s), true);
  assert.equal(consumeClick(s), true);
  assert.deepEqual(s.run.clicks, { sec: 1, n: 1 });
  assert.equal(s.meta.counters.clicks, 16);
});

test('createDerived: neutral defaults (§5) and typed-array geometry caches', () => {
  const d = createDerived();
  assert.deepEqual(Object.keys(d), ['ledger', 'season', 'meta', 'nest', 'surface', 'stats', 'rates', 'combat', 'progress', 'offlineLog']);
  assert.deepEqual(d.ledger, { food: {}, honeydew: {}, leaves: {}, chitin: {}, insight: {}, fungus: {} });
  assert.equal(d.season.id, 'spring');
  assert.deepEqual(d.season.mods, { forage: 1, lay: 1.25, broodTime: 0.8, dig: 1, insight: 1, foodCap: 1, rivalAggro: 1.25,
    rivalDormant: false, flightW: 1, puddlesBlock: true });
  assert.equal(d.season.srcId, 'spring');
  assert.ok(d.nest.chamberAt instanceof Int16Array && d.nest.chamberAt.length === 3200 && d.nest.chamberAt[0] === -1);
  assert.ok(d.nest.open instanceof Uint8Array && d.nest.open.length === 3200);
  assert.ok(d.nest.dist[5] === -1 && d.nest.entDist[5] === -1);
  assert.deepEqual(d.nest.agg.broodGroups, [{ kind: 'royal', uid: 1, cap: 3, factor: 1, exposed: false, snap: false, inReach: false }]);
  assert.equal(d.nest.agg.haulH, 0.83);
  assert.deepEqual(d.nest.agg.royal, [1]);
  assert.ok(d.surface.owned instanceof Uint8Array && d.surface.owned.length === 817);
  assert.ok(d.surface.passable[816] === 1 && d.surface.rival instanceof Int16Array);
  assert.equal(d.stats.foodCap, 150);
  assert.equal(d.stats.layRate, 0.25);
  assert.deepEqual(d.stats.eggCost, { minor: 10, soldier: 50, supermajor: 500, replete: 200, alate: 200 });
  assert.deepEqual(d.stats.forage, { aAdd: 1, mRun: 1, mTime: 1, mPrestige: 1, total: 1 });
  assert.deepEqual(d.rates.food, { raw: 0, gross: 0, net: 0, upkeep: 0, clicks: 0, sc: false, src: {} });
  assert.deepEqual(Object.keys(d.rates), ['food', 'soil', 'insight', 'pheromone', 'chitin', 'honeydew', 'leaves', 'fungus']);
  assert.deepEqual(d.meta.prestige, { food: 1, dig: 1, insight: 1, honeydew: 1, leaves: 1, fungus: 1, chitin: 1, lay: 1, ap: 1, alates: 1 });
  assert.deepEqual(d.meta.proj.fly, { ok: false, royal5: false, prep: false, chamber: false, fRun: false });
  assert.deepEqual(d.combat, { garrison: { soldier: 0, supermajor: 0 }, garrisonAP: 0, homeMult: 1, escortAP: {}, rivalAP: {}, danger: [] });
  assert.deepEqual(d.progress, { nextUnlock: null, goals: [], _timers: {} });
  assert.equal(d.offlineLog, null);
  assert.notEqual(createDerived().nest.open, d.nest.open);
});
