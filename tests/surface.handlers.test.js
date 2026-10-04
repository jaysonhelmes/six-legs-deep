// WP4 command handlers (ARCHITECTURE §9, §15.3 #16): validation codes for bad input, and what each apply changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as surface from '../src/systems/surface.js';
import * as trails from '../src/systems/trails.js';
import { ABILITIES, TRAIL, MOUND } from '../src/data/surface.js';
import { RESEARCH } from '../src/data/research.js';
import { hexIndex, countInRadius } from '../src/core/hex.js';
import { effectMult, hasEffect } from '../src/core/effects.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const H = { ...surface.handlers, ...trails.handlers };
const GARBAGE = [null, undefined, NaN, Infinity, -1, 0.5, 1e300, 'zzz', '', {}, [], true, '__proto__'];

function world(over = {}) {
  const s = newState(1);
  const d = makeDerived(over);
  surface.derive(s, d);
  return { s, d };
}

/** validate then apply, like core/commands.applyCommand. */
function run(s, d, cmd) {
  const env = fakeEnv();
  const reason = H[cmd.type].validate(s, d, cmd);
  if (reason === null) H[cmd.type].apply(s, d, cmd, env);
  return { reason, events: env.events };
}

function addSeed(s, hex) {
  const S = s.run.surface;
  const src = { uid: S.nextUid++, type: 'seed_patch', hex, stock: 300, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} };
  S.sources.push(src);
  S.revealed[hex] = 1;
  return src;
}

test('every WP4 handler rejects garbage arguments with a reason code and never throws', () => {
  const { s, d } = world();
  s.run.research.antennation = 1;
  s.run.research.aphid_shepherding = 1;
  for (const k of ['hex_claim', 'mound', 'ability_mark', 'ability_rally', 'ability_frenzy']) s.run.unlocked[k] = true;
  const before = JSON.stringify(s);
  const shapes = {
    claimHex: ['hex'], flagHex: ['hex', 'on'], moveAphids: ['src', 'hex'], drawTrail: ['origin', 'target', 'waypoints'],
    rerouteTrail: ['uid', 'waypoints'], deleteTrail: ['uid'], assignWorkers: ['uid', 'n'], assignEscorts: ['uid', 'n'],
    mark: ['uid'], rally: ['uid'], massRecruit: ['src'],
  };
  for (const [type, keys] of Object.entries(shapes)) {
    for (const g of GARBAGE) {
      const cmd = { type };
      for (const k of keys) cmd[k] = g;
      const r = H[type].validate(s, d, cmd);
      assert.equal(typeof r, 'string', `${type} with ${String(g)} must be rejected`);
    }
  }
  assert.equal(JSON.stringify(s), before, 'validate is pure');
});

test('drawTrail: creates a routed trail in a free slot; origin / target / slot / route reasons', () => {
  const { s, d } = world();
  const seed = addSeed(s, hexIndex(2, 0));
  let r = run(s, d, { type: 'drawTrail', origin: 0, target: seed.hex });
  assert.equal(r.reason, null);
  const t = s.run.surface.trails[s.run.surface.trails.length - 1];
  assert.equal(t.src, seed.uid);
  assert.equal(t.job, 'forager');
  assert.equal(t.path[0], 0);
  assert.equal(t.path[t.path.length - 1], seed.hex);
  assert.equal(t.len, 2);
  assert.ok(r.events.some((e) => e.type === 'trailCreated' && e.uid === t.uid));
  assert.equal(run(s, d, { type: 'drawTrail', origin: 7, target: seed.hex }).reason, 'invalid:origin');
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: hexIndex(0, 2) }).reason, 'invalid:target');
  const fog = addSeed(s, hexIndex(5, 0));
  s.run.surface.revealed[fog.hex] = 0;
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: fog.hex }).reason, 'invalid:target', 'fogged source');
  const prey = { uid: 300, type: 'prey_beetle', hex: hexIndex(0, 2), stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: 300, cd: 0, data: {} };
  s.run.surface.sources.push(prey);
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: prey.hex }).reason, 'invalid:target', 'prey is hunted, not trailed');
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: seed.hex, waypoints: [5000] }).reason, 'invalid:waypoints');
  const walled = addSeed(s, hexIndex(-2, 0));
  r = run(s, d, { type: 'drawTrail', origin: 0, target: walled.hex });
  assert.equal(r.reason, null, 'third slot');
  const another = addSeed(s, hexIndex(0, -2));
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: another.hex }).reason, 'noSlot:trail');
});

test('drawTrail reports blocked when no route exists', () => {
  const { s, d } = world();
  const seed = addSeed(s, hexIndex(3, 0));
  for (let i = countInRadius(1); i < countInRadius(2); i++) s.run.surface.terrain[i] = 5;   // ring 2 all stone
  surface.derive(s, d);
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: seed.hex }).reason, 'blocked');
});

test('rerouteTrail goes through waypoints, keeps workers/S, records reroutes (last 20) and emits trailRerouted', () => {
  const { s, d } = world();
  const seed = addSeed(s, hexIndex(2, 0));
  run(s, d, { type: 'drawTrail', origin: 0, target: seed.hex });
  const t = s.run.surface.trails[1];
  t.S = 33;
  const wp = hexIndex(0, 2);
  const r = run(s, d, { type: 'rerouteTrail', uid: t.uid, waypoints: [wp] });
  assert.equal(r.reason, null);
  assert.ok(t.path.includes(wp));
  assert.equal(t.S, 33);
  assert.equal(t.reroutes.length, 1);
  assert.ok(t.len > 2);
  assert.ok(r.events.some((e) => e.type === 'trailRerouted' && e.uid === t.uid && e.from === 2));
  for (let i = 0; i < 25; i++) run(s, d, { type: 'rerouteTrail', uid: t.uid, waypoints: [] });
  assert.equal(t.reroutes.length, TRAIL.overthinker.n);
  assert.equal(run(s, d, { type: 'rerouteTrail', uid: 999, waypoints: [] }).reason, 'notFound');
});

test('deleteTrail removes the trail and its Rally effect', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  s.run.effects.push({ id: 'rally:' + t.uid, stat: 'forage_trail', mult: 2, add: 0, scope: t.uid, t: 10 });
  const r = run(s, d, { type: 'deleteTrail', uid: t.uid });
  assert.equal(r.reason, null);
  assert.equal(s.run.surface.trails.length, 0);
  assert.equal(hasEffect(s, 'rally:' + t.uid), false);
  assert.ok(r.events.some((e) => e.type === 'trailDeleted'));
  assert.equal(run(s, d, { type: 'deleteTrail', uid: t.uid }).reason, 'notFound');
});

test('assignWorkers / assignEscorts: counts bounded by the job pool and the garrison', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  s.run.colony.jobs.forager = 6;
  assert.equal(run(s, d, { type: 'assignWorkers', uid: t.uid, n: 7 }).reason, 'invalid:count');
  assert.equal(run(s, d, { type: 'assignWorkers', uid: t.uid, n: -1 }).reason, 'invalid');
  assert.equal(run(s, d, { type: 'assignWorkers', uid: t.uid, n: 6 }).reason, null);
  assert.equal(t.workers, 6);
  d.combat.garrison.soldier = 3;
  assert.equal(run(s, d, { type: 'assignEscorts', uid: t.uid, n: 4 }).reason, 'invalid:count');
  assert.equal(run(s, d, { type: 'assignEscorts', uid: t.uid, n: 2.5 }).reason, 'invalid');
  assert.equal(run(s, d, { type: 'assignEscorts', uid: t.uid, n: 3 }).reason, null);
  assert.equal(t.escorts, 3);
  d.combat.garrison.soldier = 0;   // the 3 now escort; re-assigning up to the current escorts is allowed
  assert.equal(run(s, d, { type: 'assignEscorts', uid: t.uid, n: 3 }).reason, null);
});

test('mark: locked → cooldown → cantAfford gates; +25 strength capped at S_max, 5 pheromone, 3 s cooldown', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  assert.equal(run(s, d, { type: 'mark', uid: t.uid }).reason, 'locked');
  s.run.unlocked.ability_mark = true;
  assert.equal(run(s, d, { type: 'mark', uid: t.uid }).reason, 'cantAfford');
  s.run.res.pheromone = 12;
  t.S = 90;
  const r = run(s, d, { type: 'mark', uid: t.uid });
  assert.equal(r.reason, null);
  assert.equal(t.S, TRAIL.sMax);
  assert.equal(s.run.res.pheromone, 7);
  assert.equal(s.run.surface.cd.mark, ABILITIES.mark.cd);
  assert.ok(r.events.some((e) => e.type === 'abilityUsed' && e.id === 'mark' && e.uid === t.uid));
  assert.equal(run(s, d, { type: 'mark', uid: t.uid }).reason, 'cooldown');
  assert.equal(run(s, d, { type: 'mark', uid: 999 }).reason, 'notFound');
  trails.tick(s, d, 3, fakeEnv({ dt: 3 }));
  assert.equal(s.run.surface.cd.mark, 0);
});

test('rally adds forage_trail ×2 on that trail for 30 s; frenzy adds forage ×2 for 20 s', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  s.run.unlocked.ability_rally = true;
  s.run.unlocked.ability_frenzy = true;
  s.run.res.pheromone = 100;
  assert.equal(run(s, d, { type: 'rally', uid: t.uid }).reason, null);
  assert.equal(effectMult(s, 'forage_trail', t.uid), ABILITIES.rally.mult);
  assert.equal(s.run.effects.find((e) => e.id === 'rally:' + t.uid).t, ABILITIES.rally.sec);
  assert.equal(s.run.surface.cd.rally, 120);
  assert.equal(run(s, d, { type: 'rally', uid: t.uid }).reason, 'cooldown');
  assert.equal(run(s, d, { type: 'frenzy' }).reason, null);
  assert.equal(effectMult(s, 'forage'), 2);
  assert.equal(s.run.effects.find((e) => e.id === 'frenzy').t, 20);
  assert.equal(s.run.res.pheromone, 100 - 20 - 60);
  assert.equal(run(s, d, { type: 'frenzy' }).reason, 'cooldown');
});

test('rally lasts 60 s with mass_recruitment (when its data exists)', { skip: !RESEARCH.mass_recruitment && 'needs WP5 research data' }, () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  s.run.unlocked.ability_rally = true;
  s.run.research.mass_recruitment = 1;
  s.run.res.pheromone = 100;
  run(s, d, { type: 'rally', uid: t.uid });
  assert.equal(s.run.effects.find((e) => e.id === 'rally:' + t.uid).t, RESEARCH.mass_recruitment.fx.rallySec);
});

test('massRecruit: only on a termite swarm / picnic with a trail; pins half the unassigned foragers on it', () => {
  const { s, d } = world();
  s.run.unlocked.ability_mark = true;
  s.run.res.pheromone = 50;
  const seed = addSeed(s, hexIndex(2, 0));
  assert.equal(run(s, d, { type: 'massRecruit', src: seed.uid }).reason, 'invalid');
  const pic = surface.spawnSource(s, d, 'picnic_spill', hexIndex(0, 2));
  assert.equal(run(s, d, { type: 'massRecruit', src: pic }).reason, 'requirements');
  run(s, d, { type: 'drawTrail', origin: 0, target: hexIndex(0, 2) });
  const t = s.run.surface.trails.find((x) => x.src === pic);
  s.run.colony.jobs.forager = 30;
  s.run.surface.trails[0].workers = 10;
  const r = run(s, d, { type: 'massRecruit', src: pic });
  assert.equal(r.reason, null);
  assert.equal(t.workers, 10);   // 50 % of (30 − 10 explicit)
  assert.equal(s.run.res.pheromone, 30);
  assert.equal(run(s, d, { type: 'massRecruit', src: 4242 }).reason, 'notFound');
});

test('claimHex pays when affordable, otherwise channels; the channel drains pheromone and claims; cancel refunds', () => {
  const { s, d } = world({ stats: { pheromoneCap: 50 } });
  const h = hexIndex(2, 0);
  assert.equal(run(s, d, { type: 'claimHex', hex: h }).reason, 'locked');
  s.run.unlocked.hex_claim = true;
  assert.equal(run(s, d, { type: 'claimHex', hex: hexIndex(4, 0) }).reason, 'invalid:fog');
  assert.equal(run(s, d, { type: 'claimHex', hex: hexIndex(1, 0) }).reason, 'invalid:owned');
  assert.equal(run(s, d, { type: 'claimHex', hex: 5000 }).reason, 'invalid');
  s.run.surface.revealed[hexIndex(3, 0)] = 1;
  assert.equal(run(s, d, { type: 'claimHex', hex: hexIndex(3, 0) }).reason, 'invalid:adjacent');
  s.run.res.pheromone = 15;
  let r = run(s, d, { type: 'claimHex', hex: h });
  assert.equal(r.reason, null);
  assert.equal(s.run.surface.claimed[h], 1);
  assert.equal(s.run.surface.claims, 1);
  assert.equal(s.run.res.pheromone, 5);
  assert.ok(r.events.some((e) => e.type === 'claimDone' && e.hex === h));
  assert.equal(run(s, d, { type: 'claimHex', hex: h }).reason, 'invalid:owned', 'same tick, before derive');
  // channel: cost 10.6 > 5 available
  surface.derive(s, d);
  const h2 = hexIndex(2, -1);
  r = run(s, d, { type: 'claimHex', hex: h2 });
  assert.equal(r.reason, null);
  assert.deepEqual(s.run.surface.channel, { hex: h2, paid: 0, cost: 10 * 1.06 });
  assert.equal(run(s, d, { type: 'claimHex', hex: hexIndex(-2, 2) }).reason, 'busy');
  let env = fakeEnv();
  surface.tick(s, d, 0.1, env);
  assert.equal(s.run.res.pheromone, 0);
  assert.equal(s.run.surface.channel.paid, 5);
  s.run.res.pheromone = 3;
  run(s, d, { type: 'cancelChannel' });
  assert.equal(s.run.surface.channel, null);
  assert.equal(s.run.res.pheromone, 8, 'everything paid comes back');
  assert.equal(run(s, d, { type: 'cancelChannel' }).reason, 'notFound');
  run(s, d, { type: 'claimHex', hex: h2 });
  s.run.res.pheromone = 20;
  env = fakeEnv();
  surface.tick(s, d, 0.1, env);
  assert.equal(s.run.surface.channel, null);
  assert.equal(s.run.surface.claimed[h2], 1);
  assert.ok(env.events.some((e) => e.type === 'claimDone' && e.hex === h2));
  assert.ok(Math.abs(s.run.res.pheromone - (20 - 10.6)) < 1e-9);
});

test('flagHex needs antennation; toggles a fogged hex in the flag list', () => {
  const { s, d } = world();
  const h = hexIndex(3, 0);
  assert.equal(run(s, d, { type: 'flagHex', hex: h, on: true }).reason, 'locked');
  s.run.research.antennation = 1;
  assert.equal(run(s, d, { type: 'flagHex', hex: 0, on: true }).reason, 'invalid:revealed');
  assert.equal(run(s, d, { type: 'flagHex', hex: h, on: 1 }).reason, 'invalid');
  assert.equal(run(s, d, { type: 'flagHex', hex: h, on: true }).reason, null);
  run(s, d, { type: 'flagHex', hex: h, on: true });
  assert.deepEqual(s.run.surface.flagged, [h]);
  run(s, d, { type: 'flagHex', hex: h, on: false });
  assert.deepEqual(s.run.surface.flagged, []);
});

test('buyMound: unlock, soil cost, levels above 5 need mound_building; autoMoundStep buys one level', () => {
  const { s, d } = world();
  assert.equal(run(s, d, { type: 'buyMound' }).reason, 'locked');
  s.run.unlocked.mound = true;
  assert.equal(run(s, d, { type: 'buyMound' }).reason, 'cantAfford');
  s.run.res.soil = 1e6;
  const r = run(s, d, { type: 'buyMound' });
  assert.equal(r.reason, null);
  assert.equal(s.run.surface.mound, 1);
  assert.equal(s.run.res.soil, 1e6 - MOUND.base);
  assert.ok(r.events.some((e) => e.type === 'moundLeveled' && e.level === 1));
  s.run.surface.mound = MOUND.freeMax;
  assert.equal(run(s, d, { type: 'buyMound' }).reason, 'requirements');
  assert.equal(surface.autoMoundStep(s, d, fakeEnv()), false);
  s.run.research.mound_building = 1;
  assert.equal(surface.autoMoundStep(s, d, fakeEnv()), true);
  assert.equal(s.run.surface.mound, MOUND.freeMax + 1);
});

test('moveAphids moves a colony onto an owned plant hex and re-routes its trails', () => {
  const { s, d } = world();
  const aphid = surface.spawnSource(s, d, 'aphid_colony', hexIndex(3, 0));
  const flower = surface.spawnSource(s, d, 'flower_patch', hexIndex(-1, 1));
  trails.createTrail(s, d, 0, aphid);
  const cmd = { type: 'moveAphids', src: aphid, hex: hexIndex(-1, 1) };
  assert.equal(run(s, d, cmd).reason, 'locked');
  s.run.research.aphid_shepherding = 1;
  assert.equal(run(s, d, { ...cmd, src: flower }).reason, 'invalid');
  assert.equal(run(s, d, { ...cmd, hex: hexIndex(0, 1) }).reason, 'invalid:target');
  assert.equal(run(s, d, { ...cmd, hex: hexIndex(4, 0) }).reason, 'invalid:owned');
  assert.equal(run(s, d, cmd).reason, null);
  const a = s.run.surface.sources.find((x) => x.uid === aphid);
  assert.equal(a.hex, hexIndex(-1, 1));
  const t = s.run.surface.trails.find((x) => x.src === aphid);
  assert.equal(t.path[t.path.length - 1], hexIndex(-1, 1));
  assert.equal(t.len, 1);
});

test('C100: only one trail may lead to a destination (drawTrail, preview, createTrail)', () => {
  const { s, d } = world();
  const seed = addSeed(s, hexIndex(2, 0));
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: seed.hex }).reason, null);
  const before = s.run.surface.trails.length;
  assert.equal(run(s, d, { type: 'drawTrail', origin: 0, target: seed.hex }).reason, 'duplicate');
  assert.equal(trails.previewTrail(s, d, 0, seed.hex).reason, 'duplicate');
  assert.equal(trails.createTrail(s, d, 0, seed.uid), 0);
  assert.equal(s.run.surface.trails.length, before);
});
