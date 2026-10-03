// WP5 unit tests: systems/rivals.js — rival creation and land, growth / creep / timers, garrison, war parties (raid,
// assault, hunt, termite), conquest and respawn, bosses (Old Ridge, Argentine Front), bribes, tournaments, battle
// actions, previews, d.combat, offline freeze and determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as rivals from '../src/systems/rivals.js';
import * as combat from '../src/systems/combat.js';
import { RIVALS, ELDER, GROWTH, BOSSES, SPAWN, RIVAL_TRAIT_ORDER } from '../src/data/rivals.js';
import { ACTIONS, REWARDS, TACTICAL, BATTLE } from '../src/data/combat.js';
import { SOURCES } from '../src/data/sources.js';
import { CASTES } from '../src/data/castes.js';
import { CHAMBERS } from '../src/data/chambers.js';
import { MOUND } from '../src/data/surface.js';
import { ringOf, hexDist, hexIndex, neighbors } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv, findBadValues, snapshot } from './helpers.js';

const live = (rel) => !readFileSync(new URL('../src/' + rel, import.meta.url), 'utf8').startsWith('// STUB');
const WP2_LIVE = live('systems/population.js');
const WP4_LIVE = live('systems/surface.js');
const DATA_OK = !!(CASTES.soldier && SOURCES.prey_caterpillar && SOURCES.termite_mound);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const { launchParty, recallParty, reinforce, battleAction, bribe, tournament, tournamentChoice } = rivals.handlers;

/** Skeleton state with an army, panel_war unlocked, food/insight caps that never bind. */
function world({ soldier = 0, supermajor = 0, minor = 0, seed = 3 } = {}) {
  const s = newState(seed);
  s.run.colony.adults.soldier = soldier;
  s.run.colony.adults.supermajor = supermajor;
  s.run.colony.adults.minor = minor;
  s.run.unlocked.panel_war = true;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  return { s, d };
}

/** Run rivals.tick for `sec` seconds (advancing run.time); returns every event. */
function run(s, d, sec, { dt = 0.1, offline = false } = {}) {
  const events = [];
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt, offline });
    rivals.tick(s, d, dt, env);
    s.run.time += dt;
    events.push(...env.events);
  }
  return events;
}

/** A sighted rival of a type at a hex. */
function rival(s, type, hex) {
  const r = rivals.createRival(s, { type, hex });
  r.sighted = true;
  return r;
}

/** Apply a handler after asserting it validates. */
function act(h, s, d, cmd) {
  const env = fakeEnv();
  assert.equal(h.validate(s, d, cmd), null, `${cmd.type} should validate`);
  h.apply(s, d, cmd, env);
  return env.events;
}

test('createRival: ladder stats from the table, type from tier, elder colonies, uids and land revision', () => {
  const s = newState(9);
  const rev0 = s.run.surface.rev;
  const a = rivals.createRival(s, { type: 'red_wood_ants', hex: 40 });
  assert.equal(a.uid, 1);
  assert.equal(a.tier, 3);
  assert.equal(a.radius, RIVALS.red_wood_ants.radius);
  assert.deepEqual(a.traits, ['acid_volley']);
  assert.equal(a.n, 200);
  assert.ok(a.raidIn > 0 && a.alive && !a.sighted && a.fallenAt === -1);
  assert.ok(s.run.surface.rev > rev0, 'surface.touch');
  const b = rivals.createRival(s, { tier: 2, hex: 50 });
  assert.equal(b.type, 'pavement_ants');
  const e = rivals.createRival(s, { tier: 10, hex: 60 });
  assert.equal(e.type, ELDER.id);
  assert.equal(e.radius, ELDER.radius);
  near(e.n * Math.sqrt(e.atk * e.hp), 3.84e6, 1, 'elder k10 AP');
  near(e.atk, 12 * 1.2 ** 4, 1e-9);
  assert.ok(e.traits.length >= ELDER.traitsMin && e.traits.length <= ELDER.traitsMax);
  for (const t of e.traits) assert.ok(RIVAL_TRAIT_ORDER.includes(t));
  for (const [k, ap] of [[7, 6e4], [15, 3.93e9]]) {
    const x = rivals.createRival(s, { tier: k, hex: 70 });
    near(x.n * Math.sqrt(x.atk * x.hp) / ap, 1, 0.002, `elder k${k}`);
  }
  assert.deepEqual(s.run.rivals.list.map((r) => r.uid), [1, 2, 3, 4, 5]);
  assert.equal(s.run.rivals.nextUid, 6);
  const c = rivals.createRival(s, {});
  assert.equal(c.type, 'black_garden_ants');
  assert.ok(ringOf(c.hex) >= 7 && ringOf(c.hex) <= 8, 'no hex → outermost band');
  assert.deepEqual(findBadValues(s), []);
});

test('rivalLand = disc(hex, radius) ∪ extra − lost, inside the map radius, sorted', () => {
  const s = newState();
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(4, 0) });
  const land = rivals.rivalLand(s, r);
  assert.equal(land.length, 19);
  for (const h of land) assert.ok(hexDist(h, r.hex) <= 2);
  assert.deepEqual(land, [...land].sort((a, b) => a - b));
  r.extra.push(hexIndex(7, -1));
  r.lost.push(r.hex);
  const land2 = rivals.rivalLand(s, r);
  assert.ok(land2.includes(hexIndex(7, -1)) && !land2.includes(r.hex));
  assert.equal(land2.length, 19);
  const edge = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(8, 0) });
  const el = rivals.rivalLand(s, edge);
  assert.ok(el.length < 19 && el.every((h) => ringOf(h) <= 8), 'clipped at radius 8');
  s.run.surface.radius = 12;
  assert.equal(rivals.rivalLand(s, edge).length, 19);
  assert.deepEqual(rivals.rivalLand(s, null), []);
});

test('growth +1 %/min of base (+3 % in summer) up to ×3; none in winter or offline; timers pause offline', () => {
  const { s, d } = world();
  const r = rival(s, 'pavement_ants', 60);
  r.truce = 100;
  r.bribeCd = 1000;
  run(s, d, 60);
  near(r.n, 60 + 60 * GROWTH.perMin, 1e-6, 'spring');
  near(r.truce, 40, 1e-6);
  d.season.id = 'summer';
  run(s, d, 60);
  near(r.n, 60 + 60 * (GROWTH.perMin + GROWTH.perMinSummer), 1e-6, 'summer');
  const n1 = r.n;
  run(s, d, 600, { dt: 60, offline: true });
  assert.equal(r.n, n1, 'frozen offline');
  near(r.bribeCd, 880, 1e-6, 'timers paused offline');
  d.season.id = 'winter';
  run(s, d, 60);
  assert.equal(r.n, n1, 'dormant in winter');
  d.season.id = 'summer';
  run(s, d, 6000, { dt: 1 });
  near(r.n, 3 * 60, 1e-9, 'capped at ×3 base');
});

test('sighting: a revealed nest is sighted once (rivalSighted)', () => {
  const { s, d } = world();
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: 40 });
  let ev = run(s, d, 0.1);
  assert.equal(ev.filter((e) => e.type === 'rivalSighted').length, 0);
  s.run.surface.revealed[40] = 1;
  ev = run(s, d, 0.5);
  const seen = ev.filter((e) => e.type === 'rivalSighted');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].uid, r.uid);
  assert.equal(seen[0].rivalType, 'black_garden_ants');
  assert.equal(r.sighted, true);
});

test('fire-ant creep: one unowned adjacent hex every 180 s, not in winter', () => {
  const { s, d } = world();
  const r = rival(s, 'fire_ants', hexIndex(4, 0));
  const land0 = rivals.rivalLand(s, r).length;
  run(s, d, 179);
  assert.equal(r.extra.length, 0);
  run(s, d, 2);
  assert.equal(r.extra.length, 1);
  assert.equal(rivals.rivalLand(s, r).length, land0 + 1);
  assert.ok(hexDist(r.extra[0], r.hex) === r.radius + 1);
  d.season.id = 'winter';
  run(s, d, 400, { dt: 1 });
  assert.equal(r.extra.length, 1);
});

test('garrison excludes escorts, marching parties and units committed to battles', () => {
  const { s, d } = world({ soldier: 50, supermajor: 5 });
  s.run.surface.trails[0].escorts = 10;
  assert.deepEqual(rivals.garrison(s, d), { soldier: 40, supermajor: 5 });
  rivals.makeParty(s, 'raid', { type: 'rival', uid: 1 }, 5, 1, [0, 1]);
  assert.deepEqual(rivals.garrison(s, d), { soldier: 35, supermajor: 4 });
  s.run.war.raids.push({ uid: 99, rival: 1, target: { type: 'trail', uid: 2 }, raiders: 1, warn: 0, phase: 'trail', guard: 4 });
  combat.startBattle(s, d, { kind: 'trail', hex: 3, you: { soldier: 14 }, foe: { n: 1, atk: 1, hp: 1 }, raid: 99, esc: 10 }, null);
  assert.deepEqual(rivals.garrison(s, d), { soldier: 31, supermajor: 4 }, 'escorts in a trail fight are not double-counted');
  s.run.surface.trails = [];
  assert.deepEqual(rivals.garrison(s, d), { soldier: 31, supermajor: 4 }, 'trail deleted: its escorts are counted through the battle');
  s.run.colony.adults.soldier = 0;
  assert.deepEqual(rivals.garrison(s, d), { soldier: 0, supermajor: 4 }, 'never negative');
});

test('launchParty validation codes', () => {
  const { s, d } = world({ soldier: 20 });
  const r = rival(s, 'black_garden_ants', 40);
  const ok = { type: 'launchParty', kind: 'raid', target: { type: 'rival', uid: r.uid }, soldier: 10, supermajor: 0 };
  assert.equal(launchParty.validate(s, d, ok), null);
  s.run.unlocked.panel_war = false;
  assert.equal(launchParty.validate(s, d, ok), 'locked');
  s.run.unlocked.panel_war = true;
  s.run.hardship = 'pacifist';
  assert.equal(launchParty.validate(s, d, ok), 'hardship');
  s.run.hardship = null;
  for (const bad of [{ kind: 'bogus' }, { soldier: -1 }, { soldier: NaN }, { soldier: 0 }, { target: null }, { target: { type: 'source', uid: r.uid } }]) {
    assert.equal(launchParty.validate(s, d, { ...ok, ...bad }), 'invalid', JSON.stringify(bad));
  }
  assert.equal(launchParty.validate(s, d, { ...ok, target: { type: 'rival', uid: 99 } }), 'notFound');
  assert.equal(launchParty.validate(s, d, { ...ok, soldier: 21 }), 'requirements:garrison');
  r.sighted = false;
  assert.equal(launchParty.validate(s, d, ok), 'blocked:unsighted');
  r.sighted = true;
  r.alive = false;
  assert.equal(launchParty.validate(s, d, ok), 'notFound');
});

test('raid party: marches 2 s/hex, fights 40 % of defenders, loot food + chitin, rival loses kills, survivors return', { skip: (!DATA_OK || !WP2_LIVE) && 'needs WP2/WP4 data' }, () => {
  const { s, d } = world({ soldier: 30 });
  d.season.id = 'winter'; // rivals dormant: no growth muddying the kill count (player raids still allowed)
  const hex = hexIndex(3, 0);
  const r = rival(s, 'black_garden_ants', hex);
  act(launchParty, s, d, { type: 'launchParty', kind: 'raid', target: { type: 'rival', uid: r.uid }, soldier: 30, supermajor: 0 });
  const p = s.run.war.parties[0];
  assert.equal(p.path.length, 4);
  assert.equal(p.state, 'out');
  assert.deepEqual(rivals.garrison(s, d), { soldier: 0, supermajor: 0 });
  run(s, d, 5.9);
  assert.equal(s.run.war.battles.length, 0, 'still marching at 5.9 s');
  let ev = run(s, d, 0.2);
  assert.equal(p.state, 'fighting');
  const b = s.run.war.battles[0];
  assert.equal(b.kind, 'raid');
  near(b.foe.n, r.n * 0.4, 1e-9);
  assert.equal(b.homeMult, 1);
  ev = ev.concat(run(s, d, 60));
  const end = ev.find((e) => e.type === 'battleEnd');
  assert.ok(end && end.win);
  near(r.n, 15 - end.kills, 1e-9, 'rival lost the killed soldiers');
  near(s.run.res.chitin, REWARDS.chitinPerKillTier * 1 * end.kills, 1e-6);
  assert.ok(s.run.res.food >= 5 + Math.max(50, 30 * 10) - 1e-6, 'raid food max(50·tier, 30 s × √tier)');
  run(s, d, 30);
  assert.equal(s.run.war.parties.length, 0, 'home');
  near(rivals.garrison(s, d).soldier, 30 - end.lost.soldier, 1e-9);
  assert.deepEqual(findBadValues(s), []);
});

test('assault conquest: hexes, outpost, harvester stash, spoils, topTier, respawn, counters, conquest event', { skip: (!DATA_OK || !WP2_LIVE || !WP4_LIVE) && 'needs WP2/WP4' }, () => {
  const { s, d } = world({ soldier: 60 });
  const hex = hexIndex(3, 0);
  const r = rival(s, 'black_garden_ants', hex);
  const land = rivals.rivalLand(s, r);
  act(launchParty, s, d, { type: 'launchParty', kind: 'assault', target: { type: 'rival', uid: r.uid }, soldier: 60, supermajor: 0 });
  const ev = run(s, d, 90);
  const be = ev.find((e) => e.type === 'battleEnd');
  assert.equal(be.kind, 'assault');
  assert.equal(be.win, true);
  assert.equal(r.alive, false);
  assert.ok(r.fallenAt > 0);
  const cqs = ev.filter((e) => e.type === 'conquest');
  assert.equal(cqs.length, 1);
  assert.deepEqual({ uid: cqs[0].uid, tier: cqs[0].tier, rivalType: cqs[0].rivalType }, { uid: r.uid, tier: 1, rivalType: 'black_garden_ants' });
  for (const h of land) assert.equal(s.run.surface.conquered[h], 1);
  assert.ok(s.run.surface.entrances.some((e) => e.kind === 'outpost' && e.hex === hex && e.ref === r.uid));
  const stash = s.run.surface.sources.find((x) => x.type === 'harvester_stash');
  assert.ok(stash && land.includes(stash.hex) && stash.hex !== hex);
  near(s.run.res.insight, REWARDS.conquestInsightPerTier * 1, 1e-9);
  assert.equal(s.run.colony.adults.minor, REWARDS.capturedPerTier2, 'captured 5 × tier² minors');
  assert.equal(s.run.rivals.topTier, 1);
  assert.equal(s.run.rivals.respawn.length, 1);
  const rs = s.run.rivals.respawn[0];
  assert.equal(rs.tier, 2);
  assert.ok(rs.in >= SPAWN.respawnSec[0] - 90 && rs.in <= SPAWN.respawnSec[1]);
  assert.equal(s.meta.counters.conquests, 1);
  assert.equal(s.run.stats.conquests, 1);
  run(s, d, SPAWN.respawnSec[1] + 1, { dt: 1 });
  const next = s.run.rivals.list.find((x) => x.alive);
  assert.ok(next && next.tier === 2 && next.type === 'pavement_ants');
  assert.ok(ringOf(next.hex) >= 8 - SPAWN.outerBand + 1, 'outermost band');
  assert.deepEqual(findBadValues(s), []);
});

test('hunt: prey AP 50·r, reward 60 s food + 15·r chitin × season, prey removed; termite cooldown 300 s', { skip: (!DATA_OK || !WP2_LIVE || !WP4_LIVE) && 'needs WP2/WP4' }, () => {
  const { s, d } = world({ soldier: 200 });
  const hex = hexIndex(4, 0);
  s.run.surface.revealed[hex] = 1;
  s.run.surface.sources.push({ uid: 50, type: 'prey_cricket', hex, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: 300, cd: 0, data: {} });
  const pv = rivals.previewAction(s, d, 'hunt', 50, { soldier: 200 });
  assert.equal(pv.ok, true);
  near(pv.foeAP, SOURCES.prey_cricket.hunt.apPerRing * 4, 1e-9);
  near(pv.loot.chitin, 15 * 4 * 2, 1e-9);
  d.season.srcId = 'autumn';
  act(launchParty, s, d, { type: 'launchParty', kind: 'hunt', target: { type: 'source', uid: 50 }, soldier: 200, supermajor: 0 });
  const ev = run(s, d, 30);
  const be = ev.find((e) => e.type === 'battleEnd');
  assert.ok(be.win);
  assert.equal(s.run.surface.sources.some((x) => x.uid === 50), false, 'prey removed');
  near(s.run.res.chitin, 15 * 4 * 2 * 1.5, 1e-6, 'autumn ×1.5');
  near(s.run.res.food, 5 + 60 * 10 * 1.5, 1e-6);
  const th = hexIndex(5, 0);
  s.run.surface.revealed[th] = 1;
  s.run.surface.sources.push({ uid: 51, type: 'termite_mound', hex: th, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.colony.adults.supermajor = 600;
  act(launchParty, s, d, { type: 'launchParty', kind: 'termite', target: { type: 'source', uid: 51 }, soldier: 0, supermajor: 600 });
  run(s, d, 40);
  const tm = s.run.surface.sources.find((x) => x.uid === 51);
  assert.ok(tm.cd > ACTIONS.termite.cdSec - 30 && tm.cd <= ACTIONS.termite.cdSec);
  assert.equal(launchParty.validate(s, d, { type: 'launchParty', kind: 'termite', target: { type: 'source', uid: 51 }, soldier: 0, supermajor: 1 }), 'cooldown');
});

test('bribe: 2 × rival AP honeydew, truce 300 s, cooldown 600 s, cancels raids in warning', () => {
  const { s, d } = world();
  const r = rival(s, 'pavement_ants', 60);
  const cost = rivals.bribeCost(s, d, r);
  near(cost.honeydew, 2 * combat.rivalAP(s, d, r), 1e-9);
  assert.equal(bribe.validate(s, d, { type: 'bribe', rival: r.uid }), 'cantAfford');
  assert.equal(bribe.validate(s, d, { type: 'bribe', rival: 77 }), 'notFound');
  s.run.res.honeydew = 2000;
  s.run.war.raids.push({ uid: 900, rival: r.uid, target: { type: 'nest' }, raiders: 18, warn: 20, phase: 'warning', guard: 0 });
  const n0 = r.n;
  const ev = act(bribe, s, d, { type: 'bribe', rival: r.uid });
  near(s.run.res.honeydew, 2000 - cost.honeydew, 1e-6);
  assert.equal(r.truce, ACTIONS.bribe.truceSec);
  assert.equal(r.bribeCd, ACTIONS.bribe.cdSec);
  assert.equal(s.run.war.raids.length, 0);
  assert.equal(r.n, n0 + 18);
  assert.ok(ev.some((e) => e.type === 'raidResult' && e.win));
  assert.equal(bribe.validate(s, d, { type: 'bribe', rival: r.uid }), 'cooldown');
});

test('tournaments: flip on ratio ≥ 1.5, withdraw ≤ 1/1.5, otherwise choose; escalate starts a 25 % battle', { skip: (!DATA_OK || !WP4_LIVE) && 'needs WP4' }, () => {
  const { s, d } = world({ minor: 1000, soldier: 100 });
  s.run.research.ritual_tournaments = 1;
  const r = rival(s, 'black_garden_ants', hexIndex(4, 0));
  const hex = hexIndex(2, 0);
  for (const n of neighbors(hex)) if (!rivals.rivalLand(s, r).includes(n)) d.surface.owned[n] = 1;
  const cmd = { type: 'tournament', rival: r.uid, hex, minor: 0, soldier: 10, supermajor: 0 };
  assert.equal(tournament.validate(s, d, { ...cmd, hex: r.hex }), 'invalid:hex');
  assert.equal(tournament.validate(s, d, { ...cmd, hex: hexIndex(-3, 0) }), 'invalid:hex');
  assert.equal(tournament.validate(s, d, { ...cmd, soldier: 101 }), 'requirements:garrison');
  // 10 soldiers × 3 = 30 vs 3 × 15 = 45 → 0.667 = 1/1.5 → withdraw
  act(tournament, s, d, cmd);
  assert.equal(r.tourCd, ACTIONS.tournament.cdSec);
  assert.equal(tournament.validate(s, d, cmd), 'cooldown');
  let ev = run(s, d, ACTIONS.tournament.sec + 0.2);
  assert.equal(ev.find((e) => e.type === 'tournamentEnd').result, 'withdraw');
  // 40 soldiers → 120 / ~45 ≥ 1.5 → win
  r.tourCd = 0;
  act(tournament, s, d, { ...cmd, soldier: 40 });
  const n0 = r.n;
  ev = run(s, d, ACTIONS.tournament.sec + 0.2);
  assert.equal(ev.find((e) => e.type === 'tournamentEnd').result, 'win');
  assert.ok(r.lost.includes(hex));
  assert.equal(s.run.surface.claimed[hex], 1);
  assert.ok(r.n < n0);
  assert.equal(s.meta.counters.tournamentsWon, 1);
  assert.equal(rivals.rivalLand(s, r).includes(hex), false);
  // in between (ratio ≈ 1.07): choose escalate
  r.tourCd = 0;
  const hex2 = hexIndex(2, 1);
  for (const n of neighbors(hex2)) if (!rivals.rivalLand(s, r).includes(n)) d.surface.owned[n] = 1;
  act(tournament, s, d, { ...cmd, hex: hex2, soldier: 0, minor: 48 });
  assert.equal(s.run.colony.militia, 48);
  run(s, d, ACTIONS.tournament.sec + 0.2);
  const tb = s.run.war.battles.find((b) => b.kind === 'tournament');
  assert.ok(tb && tb.odds > 1 / 1.5 && tb.odds < 1.5);
  assert.equal(tournamentChoice.validate(s, d, { type: 'tournamentChoice', uid: tb.uid, choice: 'dance' }), 'invalid');
  ev = act(tournamentChoice, s, d, { type: 'tournamentChoice', uid: tb.uid, choice: 'escalate' });
  const esc = s.run.war.battles.find((b) => b.kind === 'escalate');
  assert.ok(esc);
  near(esc.foe.n, r.n * ACTIONS.tournament.escalateEngage, 1e-9);
  assert.equal(esc.you.militia, 48);
  assert.ok(ev.some((e) => e.type === 'battleStart' && e.kind === 'escalate'));
  r.truce = 10;
  r.tourCd = 0;
  assert.equal(tournament.validate(s, d, cmd), 'blocked:truce');
});

test('battleAction: alarm rally (cost, cooldown), mobilize only at the border/gate, retreat', { skip: !DATA_OK && 'needs data' }, () => {
  const { s, d } = world({ soldier: 10, minor: 100 });
  s.run.colony.jobs.forager = 60;
  s.run.res.pheromone = 100;
  const uid = combat.startBattle(s, d, { kind: 'border', hex: 0, you: { soldier: 10 }, foe: { n: 50, atk: 1, hp: 50 } }, null);
  const ar = { type: 'battleAction', battle: uid, action: 'alarm_rally' };
  act(battleAction, s, d, ar);
  assert.equal(s.run.res.pheromone, 75);
  assert.equal(s.run.war.battles[0].rally, TACTICAL.alarm_rally.sec);
  assert.equal(battleAction.validate(s, d, ar), 'cooldown');
  act(battleAction, s, d, { type: 'battleAction', battle: uid, action: 'mobilize' });
  near(s.run.war.battles[0].you.militia, 0.25 * (40 + 60), 1e-9);
  near(s.run.colony.militia, 25, 1e-9);
  assert.equal(battleAction.validate(s, d, { type: 'battleAction', battle: uid, action: 'mobilize' }), 'busy');
  assert.equal(battleAction.validate(s, d, { type: 'battleAction', battle: uid, action: 'dance' }), 'invalid');
  assert.equal(battleAction.validate(s, d, { type: 'battleAction', battle: 999, action: 'retreat' }), 'notFound');
  const far = combat.startBattle(s, d, { kind: 'raid', hex: 30, you: { soldier: 0.0 }, foe: { n: 1, atk: 1, hp: 1 } }, null);
  assert.equal(battleAction.validate(s, d, { type: 'battleAction', battle: far, action: 'mobilize' }), 'invalid:kind');
  const ev = act(battleAction, s, d, { type: 'battleAction', battle: uid, action: 'retreat' });
  assert.ok(ev.some((e) => e.type === 'battleEnd' && e.uid === uid && e.retreat === true));
  s.meta.achievements.ach_flawless = 1;
  s.run.effects.length = 0;
  const b2 = combat.startBattle(s, d, { kind: 'border', hex: 0, you: { soldier: 5 }, foe: { n: 50, atk: 1, hp: 50 } }, null);
  const p0 = s.run.res.pheromone;
  act(battleAction, s, d, { type: 'battleAction', battle: b2, action: 'alarm_rally' });
  near(p0 - s.run.res.pheromone, 25 * 0.8, 1e-9, 'ach_flawless −20 %');
});

test('reinforce joins the battle on arrival; recallParty turns a marching party home', { skip: !DATA_OK && 'needs data' }, () => {
  const { s, d } = world({ soldier: 30 });
  const r = rival(s, 'carpenter_ants', hexIndex(5, 0));
  act(launchParty, s, d, { type: 'launchParty', kind: 'raid', target: { type: 'rival', uid: r.uid }, soldier: 10, supermajor: 0 });
  assert.equal(recallParty.validate(s, d, { type: 'recallParty', uid: 999 }), 'notFound');
  run(s, d, 10.1);
  const b = s.run.war.battles[0];
  assert.ok(b);
  assert.equal(recallParty.validate(s, d, { type: 'recallParty', uid: s.run.war.parties[0].uid }), 'busy');
  b.foe.atk = 0;
  act(reinforce, s, d, { type: 'reinforce', battle: b.uid, soldier: 5, supermajor: 0 });
  assert.equal(s.run.war.parties.length, 2);
  run(s, d, 9.9);
  assert.equal(s.run.war.parties.length, 2);
  run(s, d, 0.2);
  assert.equal(s.run.war.parties.length, 1, 'reinforcement merged');
  assert.ok(b.you.soldier > 10 && b.you.soldier <= 15);
  assert.equal(s.run.war.parties[0].soldier, 15);
  const { s: s2, d: d2 } = world({ soldier: 30 });
  const r2 = rival(s2, 'black_garden_ants', hexIndex(6, 0));
  act(launchParty, s2, d2, { type: 'launchParty', kind: 'raid', target: { type: 'rival', uid: r2.uid }, soldier: 10, supermajor: 0 });
  run(s2, d2, 4);
  act(recallParty, s2, d2, { type: 'recallParty', uid: s2.run.war.parties[0].uid });
  run(s2, d2, 4.1);
  assert.equal(s2.run.war.parties.length, 0);
  assert.equal(s2.run.war.battles.length, 0);
});

test('Old Ridge: spawns once with budding and alatesCycle ≥ 2,500 at the outer ring, assault-immune below 25 owned hexes', () => {
  const { s, d } = world({ soldier: 10 });
  run(s, d, 0.1);
  assert.equal(s.run.rivals.list.length, 0);
  s.cycle.traits.budding = 1;
  s.cycle.alatesCycle = 2500;
  run(s, d, 0.2);
  const or = s.run.rivals.list.filter((r) => r.type === 'old_ridge_supercolony');
  assert.equal(or.length, 1);
  assert.equal(ringOf(or[0].hex), 8);
  assert.equal(or[0].radius, BOSSES.old_ridge_supercolony.radius);
  or[0].sighted = true;
  const cmd = { type: 'launchParty', kind: 'assault', target: { type: 'rival', uid: or[0].uid }, soldier: 10, supermajor: 0 };
  assert.equal(launchParty.validate(s, d, cmd), 'blocked:immune');
  assert.equal(launchParty.validate(s, d, { ...cmd, kind: 'raid' }), null, 'raids allowed');
  d.surface.ownedCount = 25;
  assert.equal(launchParty.validate(s, d, cmd), null);
  or[0].alive = false;
  run(s, d, 0.2);
  assert.equal(s.run.rivals.list.filter((r) => r.type === 'old_ridge_supercolony').length, 1, 'never respawned that run');
  const s2 = newState(5);
  s2.cycle.traits.budding = 1;
  s2.cycle.alatesCycle = 3000;
  rivals.spawnInitial(s2, makeDerived(), [{ type: 'black_garden_ants', tier: 1, hex: hexIndex(4, 0) }]);
  assert.deepEqual(s2.run.rivals.list.map((r) => r.type), ['black_garden_ants', 'old_ridge_supercolony'], 'spawned at run start');
});

test('Argentine Front: 3 nests in one group; partial falls regrow after 10 min; all 3 in the window are conquered', { skip: (!DATA_OK || !WP2_LIVE || !WP4_LIVE) && 'needs WP2/WP4' }, () => {
  const { s, d } = world();
  s.era.federation.megacolony = 1;
  run(s, d, 0.1);
  const front = s.run.rivals.list.filter((r) => r.type === 'great_rival');
  assert.equal(front.length, 3);
  assert.ok(front.every((r) => r.group === front[0].uid));
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(hexDist(front[i].hex, front[j].hex) >= BOSSES.great_rival.minGap);
  const fall = (r) => {
    const env = fakeEnv();
    env.events.push({ type: 'battleEnd', uid: 1, kind: 'assault', win: true, kills: r.n, party: 0, rival: r.uid, raid: 0, survivors: { militia: 0, soldier: 0, supermajor: 0 } });
    rivals.tick(s, d, 0.1, env);
    return env.events;
  };
  let ev = fall(front[0]);
  assert.equal(front[0].alive, false);
  assert.equal(ev.filter((e) => e.type === 'conquest').length, 0, 'pending, not conquered');
  run(s, d, 300, { dt: 1, offline: true });
  run(s, d, 590, { dt: 1 });
  assert.equal(front[0].alive, false, 'window paused offline');
  run(s, d, 15, { dt: 1 });
  assert.equal(front[0].alive, true, 'regrew after the window');
  assert.equal(front[0].n, front[0].base);
  ev = [];
  for (const r of front) ev.push(...fall(r));
  assert.equal(ev.filter((e) => e.type === 'conquest').length, 3);
  assert.ok(front.every((r) => !r.alive && r.fallenAt > 0));
  assert.equal(s.meta.counters.conquests, 3);
  assert.equal(s.run.rivals.respawn.length, 0, 'bosses queue no respawn');
  assert.equal(s.run.rivals.topTier, 0);
});

test('extra rivals when the map radius grows (up to SPAWN.maxByRadius), none at the base radius', () => {
  const { s, d } = world();
  rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(4, 0) });
  run(s, d, 0.1);
  assert.equal(s.run.rivals.list.length, 1);
  s.run.surface.radius = 12;
  run(s, d, 0.1);
  const alive = s.run.rivals.list.filter((r) => r.alive);
  assert.equal(alive.length, SPAWN.maxByRadius[12]);
  const added = alive.slice(1);
  assert.ok(added.every((r) => ringOf(r.hex) >= 11 && r.tier >= 2));
  s.run.surface.radius = 16;
  run(s, d, 0.1);
  assert.equal(s.run.rivals.list.filter((r) => r.alive).length, SPAWN.maxByRadius[16]);
});

test('previewAction: odds, AP, losses, loot, march time and "what would raise it" hints', { skip: !DATA_OK && 'needs data' }, () => {
  const { s, d } = world({ soldier: 17 });
  const r = rival(s, 'black_garden_ants', hexIndex(3, 0));
  const pv = rivals.previewAction(s, d, 'assault', r.uid, { soldier: 17 });
  assert.equal(pv.ok, true);
  near(pv.youAP, 152.05, 0.01);
  near(pv.foeAP, 125.8, 0.1);
  assert.ok(pv.win > 0.5 && pv.win < 1);
  assert.equal(pv.marchSec, 3 * BATTLE.marchSecPerHex);
  assert.ok(pv.loot.insight > 0 && pv.loot.minors === REWARDS.capturedPerTier2);
  assert.ok(pv.raise.some((x) => x.key === 'soldiers'));
  const weak = rivals.previewAction(s, d, 'raid', r.uid, { soldier: 50 });
  assert.equal(weak.reason, 'requirements:garrison');
  assert.equal(weak.ok, false);
  assert.ok(weak.win > 0.99);
  assert.equal(rivals.previewAction(s, d, 'bogus', r.uid, {}).ok, false);
  assert.equal(rivals.previewAction(s, d, 'raid', 999, { soldier: 1 }).reason, 'notFound');
  const rng0 = s.rng;
  rivals.previewAction(s, d, 'raid', r.uid, { soldier: 5 });
  assert.equal(s.rng, rng0, 'previews never touch s.rng');
  s.run.research.ritual_tournaments = 1;
  const tp = rivals.previewAction(s, d, 'tournament', r.uid, { soldier: 30 });
  assert.equal(tp.win, 1);
  near(tp.youAP, 90, 1e-9);
});

test('d.combat: garrison, home bonus (mound, barracks near an entrance), escort AP, rival AP, danger hexes', { skip: !DATA_OK && 'needs data' }, () => {
  const { s, d } = world({ soldier: 30 });
  s.run.surface.mound = 4;
  d.nest.agg.barracksNear = true;
  s.run.surface.trails[0].escorts = 10;
  const r = rival(s, 'black_garden_ants', hexIndex(3, 1));
  d.surface.border[hexIndex(1, 0)] = 1;
  run(s, d, 0.1);
  assert.deepEqual(d.combat.garrison, { soldier: 20, supermajor: 0 });
  near(d.combat.homeMult, (1 + MOUND.homeAP * 4) * (CHAMBERS.barracks ? CHAMBERS.barracks.fx.homeAP : 1), 1e-9);
  near(d.combat.garrisonAP, 20 * Math.sqrt(80) * d.combat.homeMult, 1e-6);
  near(d.combat.escortAP[2], 10 * Math.sqrt(80), 1e-6);
  near(d.combat.rivalAP[r.uid], r.n * Math.sqrt(45), 1e-6);
  assert.ok(d.combat.danger.includes(hexIndex(1, 0)));
  assert.ok(d.combat.danger.includes(3), 'crumb trail hex near rival land');
  s.run.research.phalanx = 1;
  run(s, d, 0.1);
  near(d.combat.escortAP[2], 10 * Math.sqrt(80) * 1.5, 1e-6);
});

test('offline: parties do not march and battles do not progress; same seed + inputs → same state', { skip: !DATA_OK && 'needs data' }, () => {
  const build = () => {
    const w = world({ soldier: 40, seed: 11 });
    const r = rival(w.s, 'pavement_ants', hexIndex(4, 0));
    act(launchParty, w.s, w.d, { type: 'launchParty', kind: 'assault', target: { type: 'rival', uid: r.uid }, soldier: 40, supermajor: 0 });
    return w;
  };
  const a = build();
  run(a.s, a.d, 3600, { dt: 60, offline: true });
  assert.equal(a.s.run.war.parties[0].pos, 0);
  run(a.s, a.d, 9);
  run(a.s, a.d, 600, { dt: 60, offline: true });
  const b0 = a.s.run.war.battles[0];
  const snap = JSON.stringify(b0);
  run(a.s, a.d, 600, { dt: 60, offline: true });
  assert.equal(JSON.stringify(a.s.run.war.battles[0]), snap);
  const x = build();
  const y = build();
  run(x.s, x.d, 120);
  run(y.s, y.d, 120);
  assert.deepEqual(snapshot(x.s), snapshot(y.s));
  assert.deepEqual(findBadValues(x.s), []);
});

test('handlers reject garbage without throwing', () => {
  const { s, d } = world({ soldier: 5 });
  rival(s, 'black_garden_ants', 30);
  const garbage = [null, undefined, NaN, Infinity, -1, 'zzz', {}, [], true, '__proto__', 1e300];
  for (const [type, h] of Object.entries(rivals.handlers)) {
    for (const g of garbage) {
      for (const key of ['kind', 'target', 'soldier', 'supermajor', 'uid', 'battle', 'action', 'rival', 'hex', 'minor', 'choice']) {
        const cmd = { type, kind: 'raid', target: { type: 'rival', uid: 1 }, soldier: 1, supermajor: 0, uid: 1, battle: 1, action: 'retreat',
          rival: 1, hex: 30, minor: 0, choice: 'withdraw', [key]: g };
        const r = h.validate(s, d, cmd);
        assert.ok(r === null || typeof r === 'string', `${type}.${key}`);
      }
    }
  }
});
