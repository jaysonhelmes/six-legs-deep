// Map and combat pass (ARCHITECTURE §18 C185, C186, C188, C189): clearing an antlion pit from the map at any time,
// conquest calling off the fallen rival's raids at once, scout expeditions beyond a fully revealed map, and the
// eventResolved outcome payload (eventId, choice, outcomeText) of every event choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as events from '../src/systems/events.js';
import * as rivals from '../src/systems/rivals.js';
import * as surface from '../src/systems/surface.js';
import { EVENTS, OUTCOMES } from '../src/data/events.js';
import { EXPEDITION } from '../src/data/surface.js';
import { SOURCES } from '../src/data/sources.js';
import { hexIndex, ringOf, countInRadius } from '../src/core/hex.js';
import { effectMult } from '../src/core/effects.js';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';

// ------------------------------------------------------------------------------------------------------------------
// C185: antlion pit cleared from the map
// ------------------------------------------------------------------------------------------------------------------

function antlionWorld() {
  const s = newState(7);
  s.run.time = 2000;
  s.run.colony.adults.minor = 300;
  s.run.colony.jobs.forager = 50;
  const d = makeDerived({ stats: { foodCap: 1e9 }, rates: { food: { gross: 10 } } });
  const S = s.run.surface;
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), hexIndex(4, 0), hexIndex(5, 0)];
  S.sources.push({ uid: 50, type: 'seed_patch', hex: path[5], stock: 1e6, max: 1e6, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  S.trails.push({ uid: 51, origin: 0, src: 50, path, len: 5, job: 'forager', workers: 30, escorts: 0, S: 40, born: 0, reroutes: [] });
  return { s, d };
}

function evTick(s, d, sec, dt = 0.1) {
  const out = [];
  for (let i = 0; i < Math.round(sec / dt); i++) {
    const env = fakeEnv({ dt });
    events.tick(s, d, dt, env);
    s.run.time += dt;
    out.push(...env.events);
  }
  return out;
}

test('C185: an antlion pit can be cleared with garrison soldiers after its card timed out (same rule as the card)', () => {
  const { s, d } = antlionWorld();
  const env = fakeEnv();
  assert.equal(events.forceEvent(s, d, 'ev_antlion_pit', env), true);
  const obj = s.run.events.objects.find((o) => o.kind === 'antlion');
  assert.ok(obj, 'the pit is on the map');
  // the card times out to its default (wait): the pit stays
  const ev = evTick(s, d, EVENTS.ev_antlion_pit.num.soldiers ? 31 : 31);
  const res = ev.find((e) => e.type === 'eventResolved' && e.id === 'ev_antlion_pit');
  assert.equal(res.choice, 'wait');
  assert.equal(s.run.events.card, null);
  assert.ok(s.run.events.objects.some((o) => o.uid === obj.uid), 'still there after the card');
  // not enough soldiers at home
  d.combat.garrison.soldier = EVENTS.ev_antlion_pit.num.soldiers - 1;
  assert.equal(events.handlers.clearAntlion.validate(s, d, { uid: obj.uid }), 'requirements:soldiers');
  assert.equal(events.handlers.clearAntlion.validate(s, d, { uid: 99999 }), 'notFound');
  const mole = { uid: 777, kind: 'molehill', hex: 3, cell: -1, t: 10, data: {} };
  s.run.events.objects.push(mole);
  assert.equal(events.handlers.clearAntlion.validate(s, d, { uid: 777 }), 'invalid:kind');
  // enough: cleared, no losses, process ended, outcome reported
  d.combat.garrison.soldier = EVENTS.ev_antlion_pit.num.soldiers;
  assert.equal(events.handlers.clearAntlion.validate(s, d, { uid: obj.uid }), null);
  const env2 = fakeEnv();
  events.handlers.clearAntlion.apply(s, d, { uid: obj.uid }, env2);
  assert.ok(!s.run.events.objects.some((o) => o.kind === 'antlion'));
  assert.ok(!s.run.events.active.some((a) => a.data && a.data.k === 'antlion'));
  const r2 = env2.events.find((e) => e.type === 'eventResolved');
  assert.deepEqual({ id: r2.id, eventId: r2.eventId, choice: r2.choice }, { id: 'ev_antlion_pit', eventId: 'ev_antlion_pit', choice: 'send' });
  assert.equal(r2.outcomeText, 'Soldiers cleared the antlion pit.');
  assert.equal(s.run.colony.adults.soldier, 0, 'no soldiers are spent (none were alive to begin with)');
});

test('C185: clearing while the card is still open closes the card once', () => {
  const { s, d } = antlionWorld();
  events.forceEvent(s, d, 'ev_antlion_pit', fakeEnv());
  const obj = s.run.events.objects.find((o) => o.kind === 'antlion');
  d.combat.garrison.soldier = 10;
  const env = fakeEnv();
  events.handlers.clearAntlion.apply(s, d, { uid: obj.uid }, env);
  assert.equal(s.run.events.card, null);
  assert.equal(env.events.filter((e) => e.type === 'eventResolved').length, 1);
});

// ------------------------------------------------------------------------------------------------------------------
// C186: conquest calls off the fallen rival's raids in warning
// ------------------------------------------------------------------------------------------------------------------

test('C186: conquering a rival cancels its raids still in warning at once ("Raid called off — their nest has fallen")', () => {
  const s = newState(3);
  s.run.colony.adults.soldier = 60;
  s.run.unlocked.panel_war = true;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(3, 0) });
  r.sighted = true;
  const cmd = { type: 'launchParty', kind: 'assault', target: { type: 'rival', uid: r.uid }, soldier: 60, supermajor: 0 };
  assert.equal(rivals.handlers.launchParty.validate(s, d, cmd), null);
  rivals.handlers.launchParty.apply(s, d, cmd, fakeEnv());
  s.run.war.raids.push({ uid: 900, rival: r.uid, target: { type: 'nest' }, raiders: 4, warn: 9999, phase: 'warning', guard: 0 });
  s.run.war.raids.push({ uid: 901, rival: 12345, target: { type: 'nest' }, raiders: 4, warn: 9999, phase: 'warning', guard: 0 });
  let conquestAt = -1;
  let called = null;
  for (let i = 0; i < 900 && conquestAt < 0; i++) {
    const env = fakeEnv({ dt: 0.1 });
    rivals.tick(s, d, 0.1, env);
    s.run.time += 0.1;
    if (env.events.some((e) => e.type === 'conquest')) {
      conquestAt = i;
      called = env.events.find((e) => e.type === 'raidResult' && e.uid === 900);
    }
  }
  assert.ok(conquestAt >= 0, 'the assault conquers the nest');
  assert.ok(called, 'raidResult in the same tick as the conquest');
  assert.equal(called.win, true);
  assert.equal(called.calledOff, 'fallen');
  assert.equal(called.foodLost, 0);
  assert.ok(!s.run.war.raids.some((x) => x.uid === 900), 'the raid (chip, arrow) is gone at once');
  assert.ok(s.run.war.raids.some((x) => x.uid === 901), "another rival's raid is untouched");
  assert.deepEqual(findBadValues(s), []);
});

// ------------------------------------------------------------------------------------------------------------------
// C188: scout expeditions
// ------------------------------------------------------------------------------------------------------------------

function revealedWorld(scouts = 20) {
  const s = newState(11);
  const S = s.run.surface;
  const n = countInRadius(S.radius);
  for (let i = 0; i < n; i++) S.revealed[i] = 1;
  s.run.colony.adults.minor = scouts + 10;
  s.run.colony.jobs.scout = scouts;
  const d = makeDerived({ rates: { food: { gross: 5 }, insight: { gross: 2 } } });
  surface.derive(s, d);
  return { s, d };
}

function surfTick(s, d, sec, { dt = 0.5, offline = false } = {}) {
  const out = [];
  for (let i = 0; i < Math.round(sec / dt); i++) {
    const env = fakeEnv({ dt, offline });
    surface.derive(s, d);
    surface.tick(s, d, dt, env);
    out.push(...env.events);
  }
  return out;
}

test('C188: with nothing left to reveal, scouts bring back finds on the edge ring (scouts^0.6 work, per-season cap)', () => {
  const { s, d } = revealedWorld(20);
  assert.equal(d.surface.frontier.length, 0);
  const rate = d.surface.scoutRate;
  assert.ok(Math.abs(rate - 20 ** 0.6) < 1e-9);
  const t1 = EXPEDITION.cost / rate;
  let ev = surfTick(s, d, Math.floor(t1) - 1);
  assert.ok(!ev.some((e) => e.type === 'expeditionFind'), 'not yet');
  const info = surface.expeditionInfo(s, d);
  assert.equal(info.active, true);
  assert.ok(info.prog > 0.8 && info.prog < 1);
  ev = surfTick(s, d, 3);
  const f1 = ev.find((e) => e.type === 'expeditionFind');
  assert.ok(f1, 'first find');
  assert.equal(ringOf(f1.hex), s.run.surface.radius, 'on the edge ring');
  assert.ok(EXPEDITION.finds.some((f) => f.id === f1.kind));
  const isSource = s.run.surface.sources.some((x) => x.uid === f1.uid && x.hex === f1.hex);
  const isObj = s.run.events.objects.some((o) => o.uid === f1.uid && o.hex === f1.hex);
  assert.ok(isSource || isObj, 'placed as a source or a map object');
  // the second costs growth× more; then the season is full
  ev = surfTick(s, d, (EXPEDITION.cost * EXPEDITION.growth) / rate + 2);
  assert.equal(ev.filter((e) => e.type === 'expeditionFind').length, 1, 'second find');
  ev = surfTick(s, d, 2000 / rate);
  assert.equal(ev.filter((e) => e.type === 'expeditionFind').length, 0, 'at most perSeason per season');
  assert.equal(surface.expeditionInfo(s, d).full, true);
  // next season: the count starts over
  d.season.id = 'summer';
  ev = surfTick(s, d, EXPEDITION.cost / rate + 2);
  assert.equal(ev.filter((e) => e.type === 'expeditionFind').length, 1);
  assert.deepEqual(findBadValues(s), []);
});

test('C188: no expeditions while a frontier remains; offline the work banks one find, placed on return', () => {
  const { s, d } = revealedWorld(20);
  const far = countInRadius(s.run.surface.radius) - 1;
  s.run.surface.revealed[far] = 0;
  s.run.surface.rev++;
  let ev = surfTick(s, d, 5);
  assert.equal(surface.expeditionInfo(s, d).active, false, 'a frontier hex is left');
  assert.equal(s.run.surface.revealed[far], 0);
  ev = surfTick(s, d, 60);
  assert.equal(s.run.surface.revealed[far], 1, 'scouting comes first');
  const before = s.run.surface.scout.exp || 0;
  ev = surfTick(s, d, 20000, { dt: 60, offline: true });
  assert.ok(!ev.some((e) => e.type === 'expeditionFind'), 'nothing is placed offline');
  assert.ok(s.run.surface.scout.exp >= before);
  assert.ok(s.run.surface.scout.exp <= surface.expeditionInfo(s, d).cost + 1e-9, 'banked up to one find');
  assert.equal(surface.expeditionInfo(s, d).prog, 1);
  ev = surfTick(s, d, 0.5);
  assert.equal(ev.filter((e) => e.type === 'expeditionFind').length, 1, 'placed on return');
});

test('C188: finds — rich seed patches and beetle carcasses are trail sources; fossils give insight; a lost queen lays', () => {
  assert.equal(SOURCES.rich_seed_patch.job, 'forager');
  assert.ok(SOURCES.beetle_carcass.y.chitin > SOURCES.dead_insect.y.chitin);
  const { s, d } = revealedWorld(0);
  const hex = countInRadius(s.run.surface.radius) - 2;
  const u1 = events.addFindObject(s, 'fossil_cache', hex, EXPEDITION.ttl);
  assert.ok(u1 > 0);
  assert.equal(events.addFindObject(s, 'ladybug', hex, 10), 0, 'only find kinds');
  s.run.clicks = s.run.clicks || {};
  assert.equal(events.handlers.clickEventObject.validate(s, d, { uid: u1 }), null);
  const insight0 = s.run.res.insight;
  const env = fakeEnv();
  events.handlers.clickEventObject.apply(s, d, { uid: u1 }, env);
  const fossil = EXPEDITION.finds.find((f) => f.id === 'fossil_cache');
  assert.ok(s.run.res.insight - insight0 >= fossil.insightMin - 1e-9, 'insight granted');
  assert.ok(env.events.some((e) => e.type === 'findClaimed' && e.kind === 'fossil_cache' && /insight/.test(e.text)));
  const u2 = events.addFindObject(s, 'lost_queen', hex, EXPEDITION.ttl);
  s.run.time += 2;   // next click second
  events.handlers.clickEventObject.apply(s, d, { uid: u2 }, fakeEnv());
  const q = EXPEDITION.finds.find((f) => f.id === 'lost_queen');
  assert.ok(Math.abs(effectMult(s, 'lay') - q.layMult) < 1e-9, 'lay ×' + q.layMult);
});

// ------------------------------------------------------------------------------------------------------------------
// C189: eventResolved payloads
// ------------------------------------------------------------------------------------------------------------------

test('C189: every card choice has an outcome template', () => {
  for (const id of Object.keys(EVENTS)) {
    const def = EVENTS[id];
    if (!def.choices) continue;
    for (const c of def.choices) assert.ok(OUTCOMES[id + ':' + c.id], id + ':' + c.id);
  }
});

test('C189: eventResolved carries { uid, id, eventId, choice, outcomeText } with numbers filled in, for every card choice', () => {
  const seen = [];
  for (const id of Object.keys(EVENTS)) {
    const def = EVENTS[id];
    if (!def.choices) continue;
    for (const c of def.choices) {
      const { s, d } = antlionWorld();
      s.run.colony.adults.soldier = 200;
      d.combat.garrison.soldier = 200;
      s.run.res.fungus = 100;
      s.run.res.food = 1000;
      // a herded aphid colony for the ladybugs
      s.run.surface.sources.push({ uid: 60, type: 'aphid_colony', hex: hexIndex(0, 3), stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
      s.run.surface.trails.push({ uid: 61, origin: 0, src: 60, path: [0, hexIndex(0, 1), hexIndex(0, 2), hexIndex(0, 3)], len: 3, job: 'herder', workers: 5, escorts: 0, S: 10, born: 0, reroutes: [] });
      d.surface.trails = [{ uid: 61, workers: 5 }, { uid: 51, workers: 30 }];
      if (!events.forceEvent(s, d, id, fakeEnv())) continue;
      const card = s.run.events.card;
      if (!card) continue;
      const cmd = { uid: card.uid, choice: c.id };
      if (events.handlers.eventChoice.validate(s, d, cmd) !== null) continue;
      const env = fakeEnv();
      events.handlers.eventChoice.apply(s, d, cmd, env);
      const e = env.events.find((x) => x.type === 'eventResolved');
      assert.ok(e, id + ':' + c.id + ' emits eventResolved');
      assert.equal(e.id, id);
      assert.equal(e.eventId, id);
      assert.equal(e.choice, c.id);
      assert.equal(typeof e.outcomeText, 'string');
      assert.ok(e.outcomeText.length > 10, e.outcomeText);
      assert.ok(!/[{}]/.test(e.outcomeText), 'placeholders filled: ' + e.outcomeText);
      seen.push(id + ':' + c.id);
    }
  }
  assert.ok(seen.includes('ev_wandering_queen:adopt'));
  assert.ok(seen.includes('ev_antlion_pit:send'));
  assert.ok(seen.length >= 15, 'covered ' + seen.length + ' choices: ' + seen.join(', '));
});

test('C189: outcome text examples read like the event log wants them', () => {
  const n = EVENTS.ev_wandering_queen.num;
  assert.equal(events.outcomeText('ev_wandering_queen', 'adopt', { mult: n.layMult, time: events.fmtOutcomeTime(n.sec) }),
    'Adopted the wandering queen: lay ×2 for 10 min.');
  assert.equal(events.fmtOutcomeTime(45), '45 s');
  assert.equal(events.fmtOutcomeTime(150), '2:30');
  assert.equal(events.fmtOutcomeNum(1234), '1.23K');
  assert.equal(events.fmtOutcomeNum(7.25), '7.3');
  assert.equal(events.outcomeText('ev_unknown', 'x'), 'ev_unknown: x.');
  // non-card resolutions carry the payload too (golden aphid expiry)
  const { s, d } = antlionWorld();
  s.run.events.objects.push({ uid: 5, kind: 'golden_aphid', hex: 3, cell: -1, t: 0.05, data: { occ: 4 } });
  const ev = evTick(s, d, 0.1);
  const e = ev.find((x) => x.type === 'eventResolved' && x.id === 'ev_golden_aphid');
  assert.equal(e.outcomeText, 'The golden aphid flew away.');
  assert.equal(e.eventId, 'ev_golden_aphid');
});
