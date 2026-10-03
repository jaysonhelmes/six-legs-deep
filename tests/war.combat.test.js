// WP5 unit tests: systems/combat.js — unit stats, Army Power, the DESIGN §9.5 worked example, stepped vs closed form
// (Lanchester), previews (deterministic, never touching s.rng), retreat, battle end bookkeeping, offline freeze, rewards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as combat from '../src/systems/combat.js';
import { bakeFoe, createRival } from '../src/systems/rivals.js';
import { CASTES } from '../src/data/castes.js';
import { RIVALS, BOSSES } from '../src/data/rivals.js';
import { BATTLE, TACTICAL } from '../src/data/combat.js';
import { RESEARCH } from '../src/data/research.js';
import { SOFTCAPS } from '../src/data/balance.js';
import { addEffect } from '../src/core/effects.js';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';

const live = (rel) => !readFileSync(new URL('../src/' + rel, import.meta.url), 'utf8').startsWith('// STUB');
const WP2_LIVE = live('systems/population.js');
const CASTES_OK = !!(CASTES.minor && CASTES.soldier && CASTES.supermajor);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

/** HP of an army (base caste HP; neutral d). */
const armyHP = (a) => a.militia * CASTES.minor.hp + a.soldier * CASTES.soldier.hp + a.supermajor * CASTES.supermajor.hp;

/** Start a battle with fixed fortunes (1, 1) and no auto-retreat, run it to the end; returns the battleEnd payload. */
function fightOut(s, d, spec, { retreatAt = 1, f = 1 } = {}) {
  const uid = combat.startBattle(s, d, spec, fakeEnv());
  const b = s.run.war.battles.find((x) => x.uid === uid);
  b.f = { you: f, foe: f };
  b.retreatAt = retreatAt;
  let end = null;
  for (let i = 0; i < 1e5 && s.run.war.battles.some((x) => x.uid === uid); i++) {
    const ended = combat.stepBattles(s, d, BATTLE.step, fakeEnv({ dt: BATTLE.step }));
    if (ended.length) end = ended.find((e) => e.uid === uid) || end;
  }
  return end;
}

/** Fresh state with an army in the colony. */
function withArmy({ militia = 0, soldier = 0, supermajor = 0 } = {}) {
  const s = newState(7);
  s.run.colony.adults.minor = militia;
  s.run.colony.adults.soldier = soldier;
  s.run.colony.adults.supermajor = supermajor;
  return s;
}

test('unit table: √(ATK·HP) is 1.41 / 8.94 / 86.6 for militia / soldier / supermajor (DESIGN §9.1)', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = newState();
  const d = makeDerived();
  const ap = (c) => {
    const u = combat.unitStats(s, d, c);
    return Math.sqrt(u.atk * u.hp);
  };
  near(ap('militia'), 1.41, 0.01);
  near(ap('minor'), 1.41, 0.01);
  near(ap('soldier'), 8.94, 0.01);
  near(ap('supermajor'), 86.6, 0.05);
  assert.deepEqual(combat.unitStats(s, d, 'queen_bee'), { atk: 0, hp: 0 });
});

test('unitStats applies stats multipliers to soldiers/supermajors only, rally, venom, gate and phorid flies', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = newState();
  const d = makeDerived({ stats: { atk: 2, hp: 3 }, meta: { sp: { soldierAtk: 1.5 } }, nest: { agg: { gateL: 2 } } });
  const m = combat.unitStats(s, d, 'militia');
  assert.equal(m.atk, CASTES.minor.atk);
  assert.equal(m.hp, CASTES.minor.hp);
  const so = combat.unitStats(s, d, 'soldier');
  near(so.atk, CASTES.soldier.atk * 2 * 1.5, 1e-9);
  near(so.hp, CASTES.soldier.hp * 3, 1e-9);
  const sm = combat.unitStats(s, d, 'supermajor');
  near(sm.atk, CASTES.supermajor.atk * 2, 1e-9);
  const r = combat.unitStats(s, d, 'soldier', { rally: true, venom: true });
  near(r.atk, so.atk * TACTICAL.alarm_rally.atk, 1e-9);
  near(r.hp, so.hp * 0.8, 1e-9);
  const g = combat.unitStats(s, d, 'soldier', { gate: true });
  near(g.hp, so.hp * (1 + 0.25 * 2), 1e-9, 'gate +25 %/level');
  s.meta.achievements.ach_phragmosis = 0;
  near(combat.unitStats(s, d, 'soldier', { gate: true }).hp, so.hp * (1 + 0.25 * 2 * 1.05), 1e-9, 'ach_phragmosis');
  addEffect(s, { id: 'ev_phorid_flies', stat: 'atk_player', mult: 0.5, t: 90 });
  near(combat.unitStats(s, d, 'soldier').atk, so.atk * 0.5, 1e-9);
  near(combat.unitStats(s, d, 'militia').atk, CASTES.minor.atk, 1e-9, 'phorid flies hit soldiers, not militia');
});

test('armyAP = SC_ap(Σ n√(ATK·HP)) × d.stats.ap × homeMult × apMult', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = newState();
  const d = makeDerived();
  near(combat.armyAP(s, d, { soldier: 17 }), 152.05, 0.01, '17 soldiers (DESIGN §9.5)');
  near(combat.armyAP(s, d, { militia: 10, soldier: 1, supermajor: 1 }), 10 * Math.sqrt(2) + Math.sqrt(80) + Math.sqrt(7500), 1e-6);
  d.stats.ap = 2;
  near(combat.armyAP(s, d, { soldier: 17 }, { homeMult: 1.25, apMult: 0.9 }), 152.05 * 2 * 1.25 * 0.9, 0.05);
  d.stats.ap = 1;
  const huge = 1e30;
  const raw = huge * Math.sqrt(80);
  const capped = SOFTCAPS.ap[0][0] * (raw / SOFTCAPS.ap[0][0]) ** SOFTCAPS.ap[0][1];
  near(combat.armyAP(s, d, { soldier: huge }) / capped, 1, 1e-9, 'AP softcap');
  assert.equal(combat.armyAP(s, d, { soldier: NaN, supermajor: -5 }), 0);
});

test('rival ladder base AP: 101 / 537 / 2,683 / 9,798 / 14,142 / 14,697 (DESIGN §9.2)', () => {
  const s = newState();
  const d = makeDerived();
  const want = { black_garden_ants: 101, pavement_ants: 537, red_wood_ants: 2683, carpenter_ants: 9798, fire_ants: 14142, slave_makers: 14697 };
  for (const [id, ap] of Object.entries(want)) {
    const r = createRival(s, { type: id, hex: 30 });
    near(combat.rivalAP(s, d, r), ap, 1, id);
    assert.equal(r.n, RIVALS[id].soldiers);
  }
});

test('rivalAP: effects (global and per uid), swarm only when outnumbering you, home bonus when defending', () => {
  const s = newState();
  const d = makeDerived();
  const r = createRival(s, { type: 'pavement_ants', hex: 30 });
  const base = combat.rivalAP(s, d, r);
  addEffect(s, { id: 'ev_rival_mating_flight', stat: 'ap_rival', mult: 0.7, t: 180 });
  addEffect(s, { id: 'ev_rival_queen_dies', stat: 'ap_rival', scope: r.uid, mult: 0.5, t: 300 });
  near(combat.rivalAP(s, d, r), base * 0.35, 1e-6);
  near(combat.rivalAP(s, d, r, { yourCount: 10 }), base * 0.35 * 1.2, 1e-6, 'swarm: 60 > 10');
  near(combat.rivalAP(s, d, r, { yourCount: 100 }), base * 0.35, 1e-6, 'no swarm: 60 < 100');
  near(combat.rivalAP(s, d, r, { defending: true }), base * 0.35 * 1.25, 1e-6);
  const c = createRival(s, { type: 'carpenter_ants', hex: 40 });
  near(combat.rivalAP(s, d, c, { defending: true }) / combat.rivalAP(s, d, c), 1.5 * 1, 1e-9, 'home_fortress 1.5');
  near(combat.rivalAP(s, d, r, { engage: 0.4 }), base * 0.35 * 0.4, 1e-6);
});

test('DESIGN §9.5 worked example: 17 soldiers assault Black Garden Ants → s ≈ 0.56, 9–10 survive; a raid → s ≈ 0.96', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = withArmy({ soldier: 17 });
  const d = makeDerived();
  const r = createRival(s, { type: 'black_garden_ants', hex: 30 });
  const you = { militia: 0, soldier: 17, supermajor: 0 };
  const foeA = bakeFoe(s, d, r, r.n, { home: 1.25, yourCount: 17, assault: true });
  near(combat.foeAP(foeA), 126, 0.5, 'defender AP 101 × 1.25');
  const sA = combat.survivorFraction(combat.armyAP(s, d, you), combat.foeAP(foeA));
  near(sA, 0.56, 0.005, 'closed-form s (assault)');
  const end = fightOut(s, d, { kind: 'assault', hex: r.hex, you, foe: foeA });
  assert.equal(end.win, true);
  assert.ok(end.survivors.soldier >= 9 && end.survivors.soldier <= 10, `9–10 survive, got ${end.survivors.soldier}`);
  near(end.survivors.soldier / 17, sA, 0.05 * sA, 'stepped within 5 % of s');
  const foeR = bakeFoe(s, d, r, r.n * 0.4, { home: 1, yourCount: 17 });
  near(combat.foeAP(foeR), 40.2, 0.1);
  near(combat.survivorFraction(combat.armyAP(s, d, you), combat.foeAP(foeR)), 0.96, 0.005, 'closed-form s (raid)');
});

test('Lanchester: homogeneous stepped survivors within 5 % of s; mixed forces within 10 % (HP-weighted)', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const d = makeDerived();
  const homogeneous = [
    [{ soldier: 17 }, { n: 15, atk: 3.75, hp: 18.75 }],
    [{ soldier: 100 }, { n: 60, atk: 4, hp: 20 }],
    [{ soldier: 100 }, { n: 90, atk: 4, hp: 20 }],
    [{ supermajor: 20 }, { n: 400, atk: 4, hp: 20 }],
    [{ militia: 300 }, { n: 40, atk: 3, hp: 15 }],
  ];
  for (const [a, foe] of homogeneous) {
    const s = newState();
    const you = combat.normArmy(a);
    const A = combat.armyAP(s, d, you);
    const F = combat.foeAP(foe);
    const sv = combat.survivorFraction(Math.max(A, F), Math.min(A, F));
    const end = fightOut(s, d, { kind: 'border', hex: 0, you, foe });
    const frac = end.win ? combat.armyCount(end.survivors) / combat.armyCount(you) : end.foeLeft / foe.n;
    near(frac, sv, 0.05 * sv, `homogeneous ${JSON.stringify(a)} vs ${JSON.stringify(foe)}`);
    assert.equal(end.win, A > F);
  }
  const mixed = [
    [{ militia: 60, soldier: 30, supermajor: 3 }, { n: 60, atk: 4, hp: 20 }],
    [{ militia: 200, soldier: 10, supermajor: 1 }, { n: 40, atk: 4, hp: 20 }],
    [{ soldier: 40, supermajor: 4 }, { n: 60, atk: 4, hp: 20 }],
    [{ soldier: 40, supermajor: 4 }, { n: 100, atk: 4, hp: 20 }],
    [{ militia: 100, soldier: 20 }, { n: 30, atk: 4, hp: 20 }],
    [{ militia: 50, soldier: 50 }, { n: 40, atk: 4, hp: 20 }],
    [{ soldier: 100, supermajor: 10 }, { n: 200, atk: 6, hp: 30 }],
  ];
  for (const [a, foe] of mixed) {
    const s = newState();
    const you = combat.normArmy(a);
    const A = combat.armyAP(s, d, you);
    const F = combat.foeAP(foe);
    const sv = combat.survivorFraction(Math.max(A, F), Math.min(A, F));
    const end = fightOut(s, d, { kind: 'border', hex: 0, you, foe });
    const frac = end.win ? armyHP(end.survivors) / armyHP(you) : end.foeLeft / foe.n;
    near(frac, sv, 0.10 * sv, `mixed ${JSON.stringify(a)} vs ${JSON.stringify(foe)}`);
  }
});

test('preview: deterministic, never touches s.rng, win chance on the fortune grid, losses and loot', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = withArmy({ soldier: 17 });
  const d = makeDerived({ rates: { food: { gross: 10 } } });
  const rng0 = s.rng;
  const you = { soldier: 17 };
  const even = combat.preview(s, d, you, { n: 17, atk: 4, hp: 20 });
  near(even.win, 0.5, 0.02, 'parity ≈ 50 %');
  const strong = combat.preview(s, d, you, { n: 3, atk: 3, hp: 15 }, { reward: { foodSec: 30, foodMin: 50, chitin: 4 } });
  assert.equal(strong.win, 1);
  assert.ok(strong.lossesLo <= strong.lossesHi && strong.lossesHi < 1);
  assert.ok(strong.survivors.soldier > 16 && strong.survivors.soldier <= 17);
  assert.deepEqual(strong.loot, { food: 300, chitin: 4, insight: 0, minors: 0 });
  const weak = combat.preview(s, d, you, { n: 100, atk: 4, hp: 20 });
  assert.equal(weak.win, 0);
  assert.equal(weak.lossesLo, 17);
  const again = combat.preview(s, d, you, { n: 17, atk: 4, hp: 20 });
  assert.deepEqual(again, even, 'deterministic');
  assert.equal(s.rng, rng0, 's.rng untouched');
  const withRetreat = combat.preview(s, d, you, { n: 15, atk: 3.75, hp: 18.75 }, { retreatAt: 0.6 });
  const noRetreat = combat.preview(s, d, you, { n: 15, atk: 3.75, hp: 18.75 });
  assert.ok(withRetreat.win < noRetreat.win, 'auto-retreat lowers the win chance of close fights');
  assert.ok(noRetreat.win > 0.99);
});

test('startBattle: odds before fortunes, fortunes from s.rng in [0.9, 1.1), battleStart, committed militia', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = withArmy({ militia: 10, soldier: 5 });
  const d = makeDerived();
  const env = fakeEnv();
  const rng0 = s.rng;
  const expectOdds = combat.preview(s, d, { militia: 4, soldier: 5 }, { n: 5, atk: 3, hp: 15 }, { homeMult: 1.2, retreatAt: 0.6 }).win;
  const uid = combat.startBattle(s, d, { kind: 'border', hex: 0, you: { militia: 4, soldier: 5 }, foe: { n: 5, atk: 3, hp: 15 }, homeMult: 1.2 }, env);
  assert.notEqual(s.rng, rng0);
  const b = s.run.war.battles[0];
  assert.equal(b.uid, uid);
  assert.equal(b.odds, expectOdds);
  for (const f of [b.f.you, b.f.foe]) assert.ok(f >= 0.9 && f < 1.1);
  assert.deepEqual(b.start, { you: 9, foe: 5 });
  assert.equal(s.run.colony.militia, 4);
  assert.deepEqual(env.events.filter((e) => e.type === 'battleStart'), [{ type: 'battleStart', uid, kind: 'border', hex: 0, below: false }]);
  assert.deepEqual(findBadValues(s), []);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(s))), JSON.stringify(s));
});

test('stepBattles: 4 Hz accumulator, frozen offline and at dt = 0', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = withArmy({ soldier: 10 });
  const d = makeDerived();
  combat.startBattle(s, d, { kind: 'border', hex: 0, you: { soldier: 10 }, foe: { n: 10, atk: 4, hp: 20 } }, null);
  const b = s.run.war.battles[0];
  combat.stepBattles(s, d, 60, fakeEnv({ offline: true, dt: 60 }));
  combat.stepBattles(s, d, 0, fakeEnv({ dt: 0 }));
  assert.equal(b.you.soldier, 10);
  assert.equal(b.foe.n, 10);
  assert.equal(b.t, 0);
  combat.stepBattles(s, d, 0.1, fakeEnv());
  combat.stepBattles(s, d, 0.1, fakeEnv());
  assert.equal(b.you.soldier, 10, 'no exchange before 0.25 s');
  combat.stepBattles(s, d, 0.1, fakeEnv());
  assert.ok(b.you.soldier < 10 && b.foe.n < 10, 'first exchange at 0.3 s');
  assert.ok(Math.abs(b.acc - 0.05) < 1e-9);
});

test('auto-retreat at the retreat threshold costs 30 % of survivors (10 % with phalanx)', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  for (const phalanx of [false, true]) {
    const s = withArmy({ soldier: 20 });
    if (phalanx) s.run.research.phalanx = 1;
    const d = makeDerived();
    const end = fightOut(s, d, { kind: 'border', hex: 0, you: { soldier: 20 }, foe: { n: 40, atk: 4, hp: 20 } }, { retreatAt: 0.6 });
    assert.equal(end.win, false);
    assert.equal(end.retreat, true);
    const cost = phalanx ? RESEARCH.phalanx.fx.retreatLoss : TACTICAL.retreat.loss;
    const before = end.survivors.soldier / (1 - cost);
    const lostBefore = 20 - before;
    assert.ok(lostBefore / 20 >= 0.6 - 1e-9 && lostBefore / 20 < 0.7, `retreat triggered near 60 %, at ${lostBefore / 20}`);
    near(end.lost.soldier, lostBefore + before * cost, 1e-9);
    near(end.survivors.soldier + end.lost.soldier, 20, 1e-9);
  }
});

test('battle end: casualties via killAdults, adultsDied, counters, largestBattle, reward on a win, battleEnd payload', { skip: (!CASTES_OK || !WP2_LIVE) && 'needs WP2' }, () => {
  const s = withArmy({ militia: 40, soldier: 30 });
  s.run.colony.jobs.forager = 30;
  const d = makeDerived({ rates: { food: { gross: 2 }, chitin: { gross: 0.5 } }, stats: { foodCap: 1e6 } });
  const uid = combat.startBattle(s, d, { kind: 'army', hex: 5, you: { militia: 10, soldier: 30 }, foe: { n: 20, atk: 4, hp: 20 },
    reward: { foodSec: 1800, chitinSec: 600, chitinMin: 2000 }, tag: 'ev_army_ant_column' }, null);
  const b = s.run.war.battles[0];
  b.f = { you: 1, foe: 1 };
  b.retreatAt = 1;
  const food0 = s.run.res.food;
  let end = null;
  const events = [];
  while (s.run.war.battles.length) {
    const env = fakeEnv({ dt: 0.25 });
    const e = combat.stepBattles(s, d, 0.25, env);
    events.push(...env.events);
    if (e.length) end = e[0];
  }
  assert.equal(end.uid, uid);
  assert.equal(end.win, true);
  assert.equal(end.tag, 'ev_army_ant_column');
  near(end.kills, 20, 1e-9);
  near(s.run.colony.adults.soldier, 30 - end.lost.soldier, 1e-9);
  near(s.run.colony.adults.minor, 40 - end.lost.militia, 1e-9);
  assert.equal(s.run.colony.militia, 0);
  assert.ok(events.some((e) => e.type === 'adultsDied' && e.caste === 'minor' && e.cause === 'battle'));
  assert.equal(s.run.stats.battles, 1);
  assert.equal(s.run.stats.battlesWon, 1);
  assert.equal(s.meta.counters.battlesWon, 1);
  near(s.run.stats.kills, 20, 1e-9);
  near(s.meta.stats.largestBattle, 60, 1e-9);
  near(s.run.res.food - food0, 3600, 1e-6, '1,800 s of food');
  near(s.run.res.chitin, 2000, 1e-6, 'max(2,000, 600 s) chitin');
  const be = events.find((e) => e.type === 'battleEnd');
  for (const k of ['uid', 'kind', 'tag', 'win', 'lost', 'kills', 'odds', 'start']) assert.ok(k in be, k);
  assert.deepEqual(Object.keys(be.lost).sort(), ['militia', 'soldier', 'supermajor']);
  assert.deepEqual(findBadValues(s), []);
});

test('field triage: 30 % of fallen soldiers return after 60 s with ≥ 5 nurses', { skip: (!CASTES_OK || !WP2_LIVE) && 'needs WP2' }, () => {
  const s = withArmy({ soldier: 20 });
  s.run.research.field_triage = 1;
  s.run.colony.adults.minor = 5;
  s.run.colony.jobs.nurse = 5;
  const d = makeDerived();
  const end = fightOut(s, d, { kind: 'border', hex: 0, you: { soldier: 20 }, foe: { n: 10, atk: 4, hp: 20 } });
  assert.equal(s.run.war.triage.length, 1);
  const tri = s.run.war.triage[0];
  near(tri.soldier, end.lost.soldier * RESEARCH.field_triage.fx.frac, 1e-9);
  assert.equal(tri.t, RESEARCH.field_triage.fx.sec);
  const s2 = withArmy({ soldier: 20 });
  s2.run.research.field_triage = 1;
  s2.run.colony.jobs.nurse = 4;
  fightOut(s2, d, { kind: 'border', hex: 0, you: { soldier: 20 }, foe: { n: 10, atk: 4, hp: 20 } });
  assert.equal(s2.run.war.triage.length, 0, 'needs ≥ 5 nurses');
});

test('endBattle (retreat command path) and a battle with no units ends as a loss', { skip: !CASTES_OK && 'needs WP2 data/castes.js' }, () => {
  const s = withArmy({ soldier: 10 });
  const d = makeDerived();
  combat.startBattle(s, d, { kind: 'border', hex: 0, you: { soldier: 0 }, foe: { n: 1, atk: 1, hp: 1 } }, null);
  const ended = combat.stepBattles(s, d, 0.1, fakeEnv());
  assert.equal(ended.length, 1);
  assert.equal(ended[0].win, false);
  combat.startBattle(s, d, { kind: 'border', hex: 0, you: { soldier: 10 }, foe: { n: 10, atk: 4, hp: 20 } }, null);
  const env = fakeEnv();
  const p = combat.endBattle(s, d, s.run.war.battles[0], env, 'retreat');
  assert.equal(p.retreat, true);
  near(p.lost.soldier, 3, 1e-9);
  assert.equal(s.run.war.battles.length, 0);
});

test('boss AP formulas: Old Ridge 1e6 × (1+m)^1.5, Front 1e8 × 10^s split over 3 nests, army column 43,000 × (1+m)^1.5', () => {
  const d = makeDerived();
  for (const [m, want] of [[0, 1e6], [20, 9.62e7]]) {
    const s = newState();
    s.meta.counters.supercolonies = m;
    const r = createRival(s, { type: 'old_ridge_supercolony', hex: 200 });
    near(combat.rivalAP(s, d, r) / want, 1, 0.002, `Old Ridge m=${m}`);
    assert.equal(r.atk, BOSSES.old_ridge_supercolony.atk);
  }
  for (const sp of [0, 1, 2]) {
    const s = newState();
    s.meta.counters.speciations = sp;
    const r = createRival(s, { type: 'great_rival', hex: 200 });
    near(combat.rivalAP(s, d, r) * 3 / (1e8 * 10 ** sp), 1, 1e-9, `Front s=${sp}`); // DESIGN §9.3: 1e8 × 10^s
  }
  const ac = BOSSES.army_ant_column;
  for (const [m, want] of [[0, 43000], [3, 344000]]) near(ac.apBase * (1 + m) ** ac.apExp, want, 1e-6);
});

test('grantReward: food may overflow to 2 × cap, minors are capped by housing', { skip: !WP2_LIVE && 'needs WP2 population' }, () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 100, housing: 10 }, rates: { food: { gross: 1 } } });
  s.run.res.food = 90;
  const got = combat.grantReward(s, d, { food: 500, insight: 7, minors: 1e6 }, null);
  assert.equal(s.run.res.food, 200);
  assert.equal(got.food, 110);
  assert.equal(s.run.res.insight, 7);
  assert.ok(got.minors <= 10 && s.run.colony.adults.minor === got.minors);
  assert.equal(s.run.fRun, 500);
});
