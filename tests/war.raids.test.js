// WP5 unit tests: systems/raids.js — eligibility, timing, warning duration, target choice (safe trails never raided),
// trail fights and losses, the border → gate → theft sequence, the theft formula with its 2 % floor, slave-maker brood
// theft, guards (dispatchGuard, auto-guard, instant with a Barracks), and no raids offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as raids from '../src/systems/raids.js';
import * as rivals from '../src/systems/rivals.js';
import { RAIDS } from '../src/data/combat.js';
import { RIVALS, TRAITS } from '../src/data/rivals.js';
import { CHAMBERS } from '../src/data/chambers.js';
import { CASTES } from '../src/data/castes.js';
import { hexIndex } from '../src/core/hex.js';
import { addEffect } from '../src/core/effects.js';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';

const live = (rel) => !readFileSync(new URL('../src/' + rel, import.meta.url), 'utf8').startsWith('// STUB');
const WP2_LIVE = live('systems/population.js');
const WP4_LIVE = live('systems/trails.js');
const GATE = CHAMBERS.gate && CHAMBERS.gate.fx;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const { dispatchGuard } = raids.handlers;

const NEST = hexIndex(4, 0);
const PATH = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0)];

/** State with 60 minors (raid-eligible), a sighted rival, and big caps. */
function world({ type = 'black_garden_ants', seed = 1, minor = 60, soldier = 0 } = {}) {
  const s = newState(seed);
  s.run.colony.adults.minor = minor;
  s.run.colony.adults.soldier = soldier;
  const d = makeDerived({ stats: { foodCap: 1e9, honeydewCap: 1e9, housing: 1e6 } });
  const r = rivals.createRival(s, { type, hex: NEST });
  r.sighted = true;
  return { s, d, r };
}

/** One trail (uid 10) along PATH with `workers` workers; its d.surface.trails entry. */
function addTrail(s, d, { uid = 10, workers = 20, escorts = 0, safe = false, out = 2, path = PATH, job = 'forager' } = {}) {
  s.run.surface.trails.push({ uid, origin: 0, src: 1, path, len: path.length - 1, job, workers, escorts, S: 50, born: 0, reroutes: [] });
  d.surface.trails.push({ uid, workers, safe, out, escorted: escorts > 0 });
  s.run.colony.jobs.forager = Math.max(s.run.colony.jobs.forager, workers);
}

/** Run raids.tick (and rivals.tick, which steps battles) for `sec` seconds. */
function run(s, d, sec, { dt = 0.1, offline = false } = {}) {
  const events = [];
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt, offline });
    rivals.tick(s, d, dt, env);
    raids.tick(s, d, dt, env);
    s.run.time += dt;
    events.push(...env.events);
  }
  return events;
}

test('warning lasts min(60, 15 + 3 × scouts) s, +30 s with early_warning', () => {
  const s = newState();
  assert.equal(raids.warningSec(s), 15);
  s.run.colony.jobs.scout = 5;
  assert.equal(raids.warningSec(s), 30);
  s.run.colony.jobs.scout = 20;
  assert.equal(raids.warningSec(s), 60);
  s.run.research.early_warning = 1;
  assert.equal(raids.warningSec(s), 90);
});

test('raid mean interval: raidMin × 60 ÷ season factor ÷ aggression ÷ species raidMult', () => {
  const { s, d, r } = world();
  near(raids.raidMean(s, d, r), RIVALS.black_garden_ants.raidMin * 60 / 1.25, 1e-9, 'spring 1.25');
  d.season.id = 'summer';
  near(raids.raidMean(s, d, r), 480 / 1.5, 1e-9);
  d.season.id = 'autumn';
  d.meta.hardship.pacifist = 2;
  near(raids.raidMean(s, d, r), 480 / (1 - 0.08 * 2), 1e-9);
  d.meta.sp = { raidMult: 2 };
  near(raids.raidMean(s, d, r), 480 / (0.84 * 2), 1e-9);
  d.season.id = 'winter';
  assert.equal(raids.raidMean(s, d, r), Infinity);
});

test('eligibility: ≥ 50 adults, not winter, online, no no_raids effect, no truce, nest seen or run time ≥ 15 min', () => {
  const check = (mutate, expectRaid, opts = {}) => {
    const { s, d, r } = world();
    r.raidIn = 0.05;
    mutate(s, d, r);
    run(s, d, 0.2, opts);
    assert.equal(s.run.war.raids.length > 0, expectRaid, mutate.toString());
  };
  check(() => {}, true);
  check((s) => { s.run.colony.adults.minor = 49; }, false);
  check((s, d) => { d.season.id = 'winter'; }, false);
  check(() => {}, false, { offline: true, dt: 0.1 });
  check((s) => addEffect(s, { id: 'boon_peaceful_start', stat: 'no_raids', t: 1200 }), false);
  check((s, d, r) => { r.truce = 10; }, false);
  check((s, d, r) => { r.sighted = false; }, false);
  check((s, d, r) => { r.sighted = false; s.run.time = 900; }, true);
  check((s, d, r) => { r.alive = false; }, false);
});

test('raid launch: 30 % of the rival (taken from it), raidsIncoming, raidWarning, next roll; one raid per rival at a time', () => {
  const { s, d, r } = world();
  r.raidIn = 0.05;
  const ev = run(s, d, 0.1);
  assert.equal(s.run.war.raids.length, 1);
  const raid = s.run.war.raids[0];
  near(raid.raiders, 15 * RAIDS.partyFrac, 0.001);
  near(r.n, 15 * (1 - RAIDS.partyFrac), 0.01);
  near(raid.raiders / (raid.raiders + r.n), RAIDS.partyFrac, 1e-9);
  assert.equal(raid.phase, 'warning');
  assert.equal(raid.warn, raids.warningSec(s));
  assert.equal(raid.guard, 0);
  assert.equal(s.run.stats.raidsIncoming, 1);
  const w = ev.find((e) => e.type === 'raidWarning');
  assert.deepEqual({ uid: w.uid, rival: w.rival, warn: w.warn }, { uid: raid.uid, rival: r.uid, warn: raid.warn });
  assert.ok(r.raidIn > 0);
  r.raidIn = 0;
  run(s, d, 0.5);
  assert.equal(s.run.war.raids.filter((x) => x.rival === r.uid).length, 1);
});

test('targets: nest for tier ≥ 4 and slave-makers (40 % party); never a safe trail; busiest trail, border ×2', () => {
  for (const type of ['carpenter_ants', 'slave_makers']) {
    const { s, d, r } = world({ type });
    addTrail(s, d);
    const n0 = r.n;
    r.raidIn = 0.01;
    run(s, d, 0.1);
    const raid = s.run.war.raids[0];
    assert.deepEqual(raid.target, { type: 'nest' }, type);
    const frac = type === 'slave_makers' ? TRAITS.brood_raiders.partyFrac : RAIDS.partyFrac;
    near(raid.raiders, n0 * frac, 0.01, type);
  }
  let trailHits = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { s, d, r } = world({ seed });
    addTrail(s, d, { uid: 10, workers: 50, safe: true });
    addTrail(s, d, { uid: 11, workers: 10 });
    addTrail(s, d, { uid: 12, workers: 0 });
    r.raidIn = 0.01;
    run(s, d, 0.1);
    const t = s.run.war.raids[0].target;
    assert.notEqual(t.uid, 10, 'safe trail never raided');
    assert.notEqual(t.uid, 12, 'trails without workers are not targets');
    if (t.type === 'trail') {
      assert.equal(t.uid, 11);
      trailHits++;
    }
  }
  assert.ok(trailHits > 20 && trailHits < 40, `~75 % trail targets, got ${trailHits}/40`);
  let border = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { s, d, r } = world({ seed });
    addTrail(s, d, { uid: 10, workers: 30 });
    addTrail(s, d, { uid: 11, workers: 20, path: [0, hexIndex(0, 1), hexIndex(1, 1), hexIndex(2, 1)] });
    d.surface.border[hexIndex(1, 1)] = 1;
    r.raidIn = 0.01;
    run(s, d, 0.1);
    const t = s.run.war.raids[0].target;
    if (t.type === 'trail') border += t.uid === 11 ? 1 : -100;
  }
  assert.ok(border > 0, '20 workers × 2 (border) beats 30');
  const { s, d, r } = world();
  r.hex = hexIndex(6, 0);
  addTrail(s, d, { uid: 10, workers: 30, path: [0, hexIndex(-1, 0), hexIndex(-2, 0), hexIndex(-3, 0), hexIndex(-4, 0)] });
  for (let i = 0; i < 10; i++) {
    r.raidIn = 0.01;
    r.n = r.base;
    s.run.war.raids.length = 0;
    run(s, d, 0.1);
    assert.deepEqual(s.run.war.raids[0].target, { type: 'nest' }, 'a trail farther than 2 hexes from rival land is not a target');
  }
});

test('theft fraction: 10 % × reach share (3 % if none) × (1 − 0.1 × gate level), floor 2 %', { skip: !GATE && 'needs WP3 data/chambers.js gate fx' }, () => {
  near(raids.theftFraction(1, 0), RAIDS.theft, 1e-12);
  near(raids.theftFraction(0.5, 0), 0.05, 1e-12);
  near(raids.theftFraction(0, 0), RAIDS.theftFallback, 1e-12);
  near(raids.theftFraction(1, 3), 0.1 * (1 - GATE.theft * 3), 1e-12);
  near(raids.theftFraction(0, 2), 0.03 * 0.8, 1e-12);
  near(raids.theftFraction(0.1, 0), GATE.theftFloor, 1e-12, 'floor 2 %');
  near(raids.theftFraction(1, 9), GATE.theftFloor, 1e-12, 'floor 2 %');
  near(raids.theftFraction(1, 50), GATE.theftFloor, 1e-12, 'never negative');
  near(GATE.theftFloor, 0.02, 1e-12);
});

test('undefended nest raid: theft of stored food and 20 % of the brood in reach; slave-makers steal it', { skip: !WP2_LIVE && 'needs WP2 population' }, () => {
  for (const type of ['black_garden_ants', 'slave_makers']) {
    const { s, d, r } = world({ type });
    s.run.res.food = 1000;
    s.run.colony.brood = [{ c: 'minor', n: 10, p: 0.5, t: 0 }];
    d.nest.agg.reachStorageShare = 0.5;
    d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 30, factor: 1, exposed: false, snap: false, inReach: true }];
    s.run.war.raids.push({ uid: 500, rival: r.uid, target: { type: 'nest' }, raiders: 5, warn: 0.05, phase: 'warning', guard: 0 });
    const n0 = r.n;
    const ev = run(s, d, 0.2);
    const res = ev.find((e) => e.type === 'raidResult');
    assert.equal(res.win, false);
    near(res.foodLost, 1000 * raids.theftFraction(0.5, 0), 1e-9);
    near(s.run.res.food, 1000 - res.foodLost, 1e-9);
    near(res.broodLost, 10 * RAIDS.broodKill, 1e-9);
    near(s.run.colony.brood[0].n, 8, 1e-9);
    if (type === 'slave_makers') {
      near(r.stolen, 2, 1e-9);
      assert.ok(ev.some((e) => e.type === 'broodDied' && e.cause === 'stolen'));
    } else {
      assert.equal(r.stolen, 0);
      assert.ok(ev.some((e) => e.type === 'broodDied' && e.cause === 'raid'));
    }
    near(r.n, n0 + 5, 0.05, 'raiders return');
    assert.equal(s.run.war.raids.length, 0);
    assert.deepEqual(findBadValues(s), []);
  }
});

test('nest raid: border fight at hex 0 with the home bonus; a loss goes to the gate fight (below, gate HP bonus)', { skip: (!WP2_LIVE || !CASTES.soldier) && 'needs WP2' }, () => {
  const { s, d, r } = world({ soldier: 40 });
  s.run.surface.mound = 2;
  s.run.war.raids.push({ uid: 501, rival: r.uid, target: { type: 'nest' }, raiders: 5, warn: 0.05, phase: 'warning', guard: 0 });
  run(s, d, 0.1);
  const b = s.run.war.battles[0];
  assert.equal(b.kind, 'border');
  assert.equal(b.hex, 0);
  assert.equal(b.below, false);
  near(b.homeMult, rivals.homeMultOf(s, d), 1e-12);
  assert.ok(b.homeMult > 1);
  assert.equal(s.run.war.raids[0].phase, 'border');
  const ev = run(s, d, 30);
  const res = ev.find((e) => e.type === 'raidResult');
  assert.equal(res.win, true);
  assert.equal(res.foodLost, 0);
  const w = world({ soldier: 3 });
  w.s.meta.settings.retreatAt = 1;
  w.d.nest.agg.gateL = 2;
  w.s.run.war.raids.push({ uid: 502, rival: w.r.uid, target: { type: 'nest' }, raiders: 30, warn: 0.05, phase: 'warning', guard: 0 });
  w.s.run.res.food = 100;
  const ev2 = run(w.s, w.d, 120);
  const kinds = ev2.filter((e) => e.type === 'battleStart').map((e) => [e.kind, e.below]);
  assert.deepEqual(kinds[0], ['border', false]);
  assert.ok(!kinds[1] || (kinds[1][0] === 'gate' && kinds[1][1] === true));
  const res2 = ev2.find((e) => e.type === 'raidResult');
  assert.equal(res2.win, false);
  assert.ok(res2.foodLost > 0);
});

test('trail raid: undefended → workers, strength and 30 s of income lost; escorts fight; deleted trail fizzles', { skip: (!WP2_LIVE || !CASTES.soldier) && 'needs WP2' }, () => {
  const { s, d, r } = world();
  addTrail(s, d, { workers: 20, out: 3 });
  s.run.res.food = 500;
  s.run.war.raids.push({ uid: 600, rival: r.uid, target: { type: 'trail', uid: 10 }, raiders: 4, warn: 0.05, phase: 'warning', guard: 0 });
  const ev = run(s, d, 0.2);
  const res = ev.find((e) => e.type === 'raidResult');
  assert.equal(res.win, false);
  assert.equal(res.workersLost, Math.min(20, RAIDS.trailKillMult * 4));
  near(res.foodLost, 3 * RAIDS.trailIncomeSec, 1e-9);
  near(s.run.res.food, 500 - 90, 1e-9);
  if (WP4_LIVE) {
    assert.equal(s.run.surface.trails.find((x) => x.uid === 10).S, 50 - RAIDS.trailS);
    near(s.run.colony.adults.minor, 60 - 8, 1e-9);
  }
  const w = world({ soldier: 30 });
  addTrail(w.s, w.d, { workers: 20, escorts: 30 });
  w.s.run.war.raids.push({ uid: 601, rival: w.r.uid, target: { type: 'trail', uid: 10 }, raiders: 4, warn: 0.05, phase: 'warning', guard: 0 });
  run(w.s, w.d, 0.1);
  const b = w.s.run.war.battles[0];
  assert.equal(b.kind, 'trail');
  assert.equal(b.esc, 30);
  assert.equal(b.you.soldier, 30);
  assert.ok(PATH.includes(b.hex));
  assert.deepEqual(rivals.garrison(w.s, w.d), { soldier: 0, supermajor: 0 });
  const ev2 = run(w.s, w.d, 30);
  assert.equal(ev2.find((e) => e.type === 'raidResult').win, true);
  const f = world();
  addTrail(f.s, f.d);
  f.s.run.war.raids.push({ uid: 602, rival: f.r.uid, target: { type: 'trail', uid: 10 }, raiders: 4, warn: 0.05, phase: 'warning', guard: 0 });
  f.s.run.surface.trails = f.s.run.surface.trails.filter((t) => t.uid !== 10);
  const ev3 = run(f.s, f.d, 0.2);
  const r3 = ev3.find((e) => e.type === 'raidResult');
  assert.equal(r3.win, true);
  assert.equal(r3.workersLost, 0);
});

test('dispatchGuard: validation; the garrison marches 2 s/hex (instant with a Barracks near) and joins the trail fight', { skip: (!WP2_LIVE || !CASTES.soldier) && 'needs WP2' }, () => {
  const { s, d, r } = world({ soldier: 20 });
  addTrail(s, d, { workers: 10 });
  s.run.war.raids.push({ uid: 700, rival: r.uid, target: { type: 'trail', uid: 10 }, raiders: 4, warn: 30, phase: 'warning', guard: 0 },
    { uid: 701, rival: r.uid, target: { type: 'nest' }, raiders: 4, warn: 30, phase: 'warning', guard: 0 });
  assert.equal(dispatchGuard.validate(s, d, { type: 'dispatchGuard', raid: 999 }), 'notFound');
  assert.equal(dispatchGuard.validate(s, d, { type: 'dispatchGuard', raid: 701 }), 'invalid:nest');
  const cmd = { type: 'dispatchGuard', raid: 700 };
  assert.equal(dispatchGuard.validate(s, d, cmd), null);
  dispatchGuard.apply(s, d, cmd, fakeEnv());
  const p = s.run.war.parties[0];
  assert.equal(p.kind, 'guard');
  assert.equal(p.soldier, 20);
  assert.equal(p.pos, 0);
  assert.equal(s.run.war.raids[0].guard, 20);
  assert.equal(dispatchGuard.validate(s, d, cmd), 'busy');
  run(s, d, 30.1);
  assert.equal(s.run.war.parties.length, 0, 'guards merged into the trail fight');
  const b = s.run.war.battles.find((x) => x.raid === 700);
  assert.ok(b && b.you.soldier === 20 && b.esc === 0);
  const w = world({ soldier: 20 });
  addTrail(w.s, w.d, { workers: 10 });
  w.d.nest.agg.barracksNear = true;
  w.s.run.war.raids.push({ uid: 710, rival: w.r.uid, target: { type: 'trail', uid: 10 }, raiders: 4, warn: 30, phase: 'warning', guard: 0 });
  dispatchGuard.apply(w.s, w.d, { type: 'dispatchGuard', raid: 710 }, fakeEnv());
  const gp = w.s.run.war.parties[0];
  assert.equal(gp.pos, gp.path.length - 1, 'instant deploy');
  const z = world();
  addTrail(z.s, z.d);
  z.s.run.war.raids.push({ uid: 720, rival: z.r.uid, target: { type: 'trail', uid: 10 }, raiders: 4, warn: 30, phase: 'warning', guard: 0 });
  assert.equal(dispatchGuard.validate(z.s, z.d, { type: 'dispatchGuard', raid: 720 }), 'requirements:garrison');
});

test('auto-guard (meta.automation.autoGuard + early_warning) dispatches the garrison to trail raids', { skip: !CASTES.soldier && 'needs WP2 data' }, () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { s, d, r } = world({ soldier: 10, seed });
    s.meta.automation.autoGuard = true;
    s.run.research.early_warning = 1;
    addTrail(s, d, { workers: 10 });
    r.raidIn = 0.01;
    run(s, d, 0.1);
    const raid = s.run.war.raids[0];
    assert.equal(raid.warn, raids.warningSec(s));
    if (raid.target.type === 'trail') {
      assert.equal(raid.guard, 10);
      assert.equal(s.run.war.parties[0].kind, 'guard');
      return;
    }
  }
  assert.fail('no trail raid in 10 seeds');
});

test('no raids offline: timers, warnings and fights are frozen', () => {
  const { s, d, r } = world();
  r.raidIn = 30;
  s.run.war.raids.push({ uid: 800, rival: r.uid, target: { type: 'nest' }, raiders: 4, warn: 10, phase: 'warning', guard: 0 });
  run(s, d, 3600, { dt: 60, offline: true });
  assert.equal(r.raidIn, 30);
  assert.equal(s.run.war.raids[0].warn, 10);
  assert.equal(s.run.war.battles.length, 0);
  assert.equal(s.run.stats.raidsIncoming, 0);
});

test('dispatchGuard rejects garbage without throwing', () => {
  const { s, d } = world();
  for (const g of [null, undefined, NaN, -1, 'zzz', {}, [], true, 1e300]) {
    const r = dispatchGuard.validate(s, d, { type: 'dispatchGuard', raid: g });
    assert.equal(typeof r, 'string');
  }
});
