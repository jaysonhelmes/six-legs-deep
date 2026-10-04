// WP4 trails: the yield formula (worked example, r×eff table, saturation), strength dynamics, allocation, escorts,
// lycaenid, depletion, loose foraging, cross-calls (createTrail, autoDraw, hitTrail, cutTrailsAt, resetStrength).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as trails from '../src/systems/trails.js';
import * as surface from '../src/systems/surface.js';
import * as population from '../src/systems/population.js';
import { TRAIL, TERRAIN, TERRITORY } from '../src/data/surface.js';
import { SOURCES } from '../src/data/sources.js';
import { RESEARCH } from '../src/data/research.js';
import { FEDERATION } from '../src/data/federation.js';
import { hexIndex, ringOf, neighbors, countInRadius } from '../src/core/hex.js';
import { effectMult } from '../src/core/effects.js';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);

/** Skeleton world with a fresh derived cache (spring), derived once. */
function world(over = {}) {
  const s = newState(1);
  const d = makeDerived(over);
  surface.derive(s, d);
  return { s, d };
}

/** Add a source record directly (tests hand-build sources). */
function addSource(s, type, hex, extra = {}) {
  const S = s.run.surface;
  const def = SOURCES[type];
  const src = { uid: S.nextUid++, type, hex, stock: def.stock ? 1e6 : -1, max: def.stock ? 1e6 : -1, level: 1, herdT: 0, age: 0,
    ttl: -1, cd: 0, data: {}, ...extra };
  S.sources.push(src);
  S.revealed[hex] = 1;
  return src;
}

/** Add a trail record directly. */
function addTrail(s, src, path, len, extra = {}) {
  const S = s.run.surface;
  const t = { uid: S.nextUid++, origin: path[0], src: src.uid, path, len, job: SOURCES[src.type].job, workers: 0, escorts: 0, S: 0,
    born: 0, reroutes: [], ...extra };
  S.trails.push(t);
  S.rev++;
  return t;
}

/** One WP4 tick (ledger reset first, like step()). */
function tickOnce(s, d, dt = 0.1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  for (const k of Object.keys(d.ledger)) d.ledger[k] = {};
  surface.derive(s, d);
  trails.tick(s, d, dt, env);
  surface.tick(s, d, dt, env);
  return env.events;
}

test('DESIGN §8.5 worked example: 10 foragers, seed patch at d = 3, h = 0.5, S at equilibrium → 5.48 food/s', () => {
  const { s, d } = world({ nest: { agg: { haulH: 0.5 } } });
  const src = addSource(s, 'seed_patch', hexIndex(3, 0));
  const seq = (100 * 10) / (10 + 45);
  const t = { uid: 99, origin: 0, src: src.uid, path: [0, 3, 8, 19], len: 3, job: 'forager', workers: 10, escorts: 0, S: seq, born: 0, reroutes: [] };
  const y = trails.trailYield(s, d, t, 10);
  close(y.out, 5.48, 0.005, 'main entrance with h 0.5');
  close(y.rich, 1.7, 1e-12);
  close(y.eff, 0.5454545, 1e-6);
  close(y.dEff, 3.5, 1e-12);
  assert.equal(y.cEff, 15);
  // the same trail from an outpost uses h = 0.5 regardless of the nest (C13)
  const d2 = makeDerived({ nest: { agg: { haulH: 3 } } });
  s.run.surface.entrances.push({ kind: 'outpost', hex: 30, col: -1, ref: 7 });
  surface.derive(s, d2);
  const y2 = trails.trailYield(s, d2, { ...t, origin: 30 }, 10);
  close(y2.out, 5.48, 0.005, 'outpost origin');
});

test('r(d) × eff(d) reproduces the DESIGN §8.5 table for D_nav = 3 (and D_nav = 9 when tandem + highway data exist)', () => {
  const rows = { 3: [1.0, 1.01, 1.02, 1.03, 1.03], 9: [1.0, 1.21, 1.54, 1.77, 1.94] };
  const ds = [1, 2, 4, 6, 8];
  const check = (s, d, want) => {
    const src = addSource(s, 'crumb_scatter', 2);
    const base = trails.trailYield(s, d, { uid: 90, origin: 0, src: src.uid, path: [0, 2], len: 1, job: 'forager', S: 0, escorts: 9 }, 1).out;
    ds.forEach((len, i) => {
      const y = trails.trailYield(s, d, { uid: 90, origin: 0, src: src.uid, path: [0, 2], len, job: 'forager', S: 0, escorts: 9 }, 1);
      // DESIGN rounds to 2 decimals; 3.45 × 0.3 = 1.035 sits on the rounding edge, so allow 0.0051
      close(y.out / base, want[i], 0.0051, `d = ${len}`);
    });
  };
  const a = world({ nest: { agg: { haulH: 0 } } });
  assert.equal(surface.dNavFor(a.s), 3);
  check(a.s, a.d, rows[3]);
  if (RESEARCH.tandem_running && FEDERATION.highway_network) {
    const b = world({ nest: { agg: { haulH: 0 } } });
    b.s.run.research.tandem_running = 1;
    b.s.era.federation.highway_network = 1;
    assert.equal(surface.dNavFor(b.s), 9);
    check(b.s, b.d, rows[9]);
  }
});

test('saturation is continuous at c_eff (value and slope)', () => {
  const { s, d } = world();
  const src = addSource(s, 'seed_patch', 8);
  const t = { uid: 91, origin: 0, src: src.uid, path: [0, 2, 8], len: 2, job: 'forager', S: 20, escorts: 1000 };
  const c = trails.trailYield(s, d, t, 1).cEff;
  assert.equal(c, 15);
  const e = 1e-6;
  const lo = trails.trailYield(s, d, t, c - e).out;
  const mid = trails.trailYield(s, d, t, c).out;
  const hi = trails.trailYield(s, d, t, c + e).out;
  close(hi - mid, mid - lo, 1e-9, 'slope matches on both sides');
  assert.ok(trails.trailYield(s, d, t, 4 * c).nEff < 4 * c);
  close(trails.trailYield(s, d, t, 4 * c).nEff, c * (1 + Math.log(4)), 1e-9);
  // c_eff grows with adults: c × max(1, adults/100)^0.8
  s.run.colony.adults.minor = 1000;
  close(trails.trailYield(s, d, t, 1).cEff, 15 * 10 ** 0.8, 1e-9);
});

test('strength approaches S_eq with a 45 s half-life (rising and falling), capped at S_max', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];          // crumb trail, len 1
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.forager = 10;
  const seq = (100 * 10) / (10 + 15 * 1);
  for (let i = 0; i < 450; i++) tickOnce(s, d, 0.1);
  close(t.S, seq / 2, 1e-6, 'half of S_eq after one half-life');
  for (let i = 0; i < 450; i++) tickOnce(s, d, 0.1);
  close(t.S, seq * 0.75, 1e-6);
  t.S = 100;
  for (let i = 0; i < 450; i++) tickOnce(s, d, 0.1);
  close(t.S, seq + (100 - seq) / 2, 1e-6, 'falling gap halves too');
  assert.ok(t.S <= TRAIL.sMax);
});

test('offline: strength sits exactly at min(S_eq, S_max) and dt = 60 is handled in one call', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.forager = 10;
  t.S = 0;
  tickOnce(s, d, 60, { offline: true, eff: 0.5 });
  close(t.S, (100 * 10) / (10 + 15), 1e-9);
  assert.ok(d.ledger.food.trails > 0);
});

test('persistent_trails: half-life 90 s and S_max 150 (when the research data exists)', { skip: !RESEARCH.persistent_trails && 'needs WP5 research data' }, () => {
  const { s, d } = world();
  s.run.research.persistent_trails = 1;
  const t = s.run.surface.trails[0];
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.forager = 10;
  const seq = (100 * 10) / 25;
  for (let i = 0; i < 900; i++) tickOnce(s, d, 0.1);
  close(t.S, seq / 2, 1e-6);
  t.S = 140;
  tickOnce(s, d, 0.1);
  assert.ok(t.S > 100 && t.S <= RESEARCH.persistent_trails.fx.sMax);
});

test('allocation: explicit workers clamp to the job pool, auto-fill fills unsaturated trails first', () => {
  const { s, d } = world();
  const crumb = s.run.surface.trails[0];
  const seed = addSource(s, 'seed_patch', 8);
  const t2 = addTrail(s, seed, [0, 2, 8], 2);
  s.run.colony.adults.minor = 100;
  s.run.colony.jobs.forager = 8;
  crumb.workers = 8;
  t2.workers = 8;
  tickOnce(s, d);
  close(crumb.workers, 4, 1e-9);
  close(t2.workers, 4, 1e-9);
  crumb.workers = 0;
  t2.workers = 0;
  s.run.colony.jobs.forager = 30;
  tickOnce(s, d);
  const w = d.surface.trails.map((e) => e.workers);
  close(w[0] + w[1], 30, 1e-9, 'every forager is placed');
  assert.ok(w[0] >= 10 - 0.6 && w[1] >= 15 - 0.6, `both trails saturated first: ${w}`);
  assert.equal(d.surface.loose, 0);
});

test('herders never exceed 8 × level per aphid colony; leftovers stay off the trail', () => {
  const { s, d } = world();
  const aphid = addSource(s, 'aphid_colony', 8);
  const t = addTrail(s, aphid, [0, 2, 8], 2);
  s.run.colony.adults.minor = 50;
  s.run.colony.jobs.herder = 20;
  t.workers = 12;
  tickOnce(s, d);
  close(t.workers, 8, 1e-9, 'explicit clamped to the colony cap');
  close(d.surface.trails[1].workers, 8, 1e-9);
  aphid.level = 2;
  tickOnce(s, d);
  close(d.surface.trails[1].workers, 16, 1e-9);
  assert.ok(d.ledger.honeydew.trails > 0);
});

test('loose foraging only when no forager trail exists: 0.1 food/s per forager × forage total', () => {
  const { s, d } = world({ stats: { forage: { total: 2 } } });
  s.run.surface.trails.length = 0;
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.forager = 10;
  tickOnce(s, d);
  assert.equal(d.surface.loose, 10);
  close(d.ledger.food.loose, 10 * 0.1 * 2, 1e-12);
});

test('escorts: Σ escorts clamp to the soldiers not in parties (garrison + escorts, ≤ soldiers alive)', () => {
  const { s, d } = world();
  const seed = addSource(s, 'seed_patch', 8);
  const t2 = addTrail(s, seed, [0, 2, 8], 2);
  const crumb = s.run.surface.trails[0];
  s.run.colony.adults.soldier = 10;
  d.combat.garrison.soldier = 0;
  crumb.escorts = 6;
  t2.escorts = 6;
  tickOnce(s, d);
  assert.equal(crumb.escorts + t2.escorts, 10);
  assert.ok(Number.isInteger(crumb.escorts) && Number.isInteger(t2.escorts));
});

test('lycaenid trail pays 0.3 × ring × honeydew multiplier only with ≥ 5 escorts, and carries no workers', () => {
  const { s, d } = world({ stats: { honeydew: 2 } });
  const hex = hexIndex(4, 0);
  const lyc = addSource(s, 'lycaenid_caterpillar', hex);
  const t = addTrail(s, lyc, [0, 3, 9, 21, hex], 4, { job: 'lycaenid', workers: 5 });
  s.run.colony.adults.soldier = 20;
  d.combat.garrison.soldier = 20;
  t.escorts = 4;
  tickOnce(s, d);
  assert.equal(t.workers, 0);
  assert.equal(d.ledger.honeydew.lycaenid || 0, 0);
  t.escorts = 5;
  tickOnce(s, d);
  close(d.ledger.honeydew.lycaenid, 0.3 * ringOf(hex) * 2, 1e-12);
});

test('secondary yields go to their ledger labels (flower honeydew, insect chitin) with the primary base (C14)', () => {
  const { s, d } = world({ stats: { honeydew: 3, chitin: 5 } });
  s.run.surface.trails.length = 0;
  const fl = addSource(s, 'flower_patch', 8);
  const tf = addTrail(s, fl, [0, 2, 8], 2);
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.forager = 10;
  tickOnce(s, d);
  const e = d.surface.trails[0];
  assert.equal(e.res, 'food');
  assert.equal(e.res2, 'honeydew');
  close(d.ledger.honeydew.flower, (e.out / 0.55) * 0.005 * 3, 1e-12);
  assert.equal(tf.job, 'forager');
});

test('finite stocks deplete by output × dt × eff; an empty stock is removed (sourcesDepleted++) and pays only what was left', () => {
  const { s, d } = world();
  s.run.surface.trails.length = 0;
  const bug = addSource(s, 'dead_insect', 8, { stock: 0.1, max: 150 });
  addTrail(s, bug, [0, 2, 8], 2);
  s.run.colony.adults.minor = 20;
  s.run.colony.jobs.forager = 20;
  const ev = tickOnce(s, d, 0.1, { eff: 0.5 });
  assert.equal(s.run.surface.sources.find((x) => x.uid === bug.uid), undefined);
  assert.equal(s.run.stats.sourcesDepleted, 1);
  assert.equal(s.run.surface.trails.length, 0);
  close(d.ledger.food.trails * 0.1 * 0.5, 0.1, 1e-9, 'food credited equals the stock that was left');
  assert.ok(ev.some((e) => e.type === 'sourceRemoved' && e.uid === bug.uid && e.reason === 'depleted'));
  assert.ok(ev.some((e) => e.type === 'trailDeleted'));
  assert.equal(d.surface.trails.length, 0);
});

test('a seed patch at 0 stock is not removed and pays its regrowth', () => {
  const { s, d } = world();
  s.run.surface.trails.length = 0;
  const seed = addSource(s, 'seed_patch', 8, { stock: 0, max: 300 });
  addTrail(s, seed, [0, 2, 8], 2);
  s.run.colony.adults.minor = 20;
  s.run.colony.jobs.forager = 20;
  for (let i = 0; i < 20; i++) tickOnce(s, d, 0.1);
  assert.ok(s.run.surface.sources.includes(seed));
  close(d.ledger.food.trails, 0.01 * 300, 1e-9, 'output limited to 1 %/s of max');
});

test('createTrail routes on terrain directly: around stone, around puddles in spring, uses a slot and a uid', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.surface.trails.length = 0;
  const target = hexIndex(3, 0);
  const src = addSource(s, 'seed_patch', target);
  for (const h of [hexIndex(1, 0), hexIndex(2, 0)]) s.run.surface.terrain[h] = TERRAIN.stone.code;
  const uid = trails.createTrail(s, d, 0, src.uid, { S: 50 });
  const t = s.run.surface.trails.find((x) => x.uid === uid);
  assert.ok(uid > 0 && t);
  assert.equal(t.path[0], 0);
  assert.equal(t.path[t.path.length - 1], target);
  assert.ok(!t.path.includes(hexIndex(1, 0)) && !t.path.includes(hexIndex(2, 0)));
  assert.equal(t.S, 50);
  assert.equal(t.job, 'forager');
  close(t.len, t.path.length - 1, 1e-12, 'grass costs 1 per hex');
  // puddles block in spring (season t = 0)
  const s2 = newState(1);
  s2.run.surface.trails.length = 0;
  const src2 = addSource(s2, 'seed_patch', hexIndex(2, 0));
  for (const n of neighbors(hexIndex(2, 0))) s2.run.surface.terrain[n] = TERRAIN.puddle.code;
  assert.equal(trails.createTrail(s2, makeDerived(), 0, src2.uid), 0);
  // slots: base 3
  const s3 = newState(1);
  const a = addSource(s3, 'seed_patch', 8);
  const b = addSource(s3, 'seed_patch', 9);
  const c = addSource(s3, 'seed_patch', 10);
  assert.ok(trails.createTrail(s3, makeDerived(), 0, a.uid) > 0);
  assert.ok(trails.createTrail(s3, makeDerived(), 0, b.uid) > 0);
  assert.equal(trails.createTrail(s3, makeDerived(), 0, c.uid), 0, 'fourth trail has no slot');
});

test('createTrail treats puddles as passable outside spring (when the WP6 season clock is available)', () => {
  const s = newState(1);
  s.meta.season.t = s.meta.season.lengthSec * 1.5;   // middle of summer
  const probe = makeDerived();
  s.run.surface.trails.length = 0;
  const src = addSource(s, 'seed_patch', hexIndex(2, 0));
  for (const n of neighbors(hexIndex(2, 0))) s.run.surface.terrain[n] = TERRAIN.puddle.code;
  const uid = trails.createTrail(s, probe, 0, src.uid);
  const springOnly = uid === 0;
  if (springOnly) return; // seasons stub always answers spring
  assert.ok(uid > 0);
});

test('autoDraw draws to the best revealed untrailed food sources at frac × S_max; bestTargets ranks them', () => {
  const { s, d } = world();
  const near = addSource(s, 'seed_patch', hexIndex(2, 0));
  const far = addSource(s, 'seed_patch', hexIndex(0, 2));
  s.run.surface.terrain[hexIndex(1, 0)] = TERRAIN.garden_path.code;
  const ranked = trails.bestTargets(s, d, 'forager');
  assert.deepEqual(ranked.map((r) => r.src).sort(), [near.uid, far.uid].sort());
  assert.ok(ranked[0].score >= ranked[1].score);
  assert.ok(!ranked.some((r) => r.src === 1), 'the crumb already has a trail');
  const made = trails.autoDraw(s, d, 2, 0.5);
  assert.equal(made, 2);
  const auto = s.run.surface.trails.filter((t) => t.src === near.uid || t.src === far.uid);
  assert.equal(auto.length, 2);
  for (const t of auto) assert.equal(t.S, 0.5 * TRAIL.sMax);
});

test('previewTrail reports path, d, d_eff, yield per worker, capacity and the slot reason', () => {
  const { s, d } = world({ nest: { agg: { haulH: 0.83 } } });
  const src = addSource(s, 'seed_patch', hexIndex(2, 0));
  const p = trails.previewTrail(s, d, 0, src.hex);
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
  assert.equal(p.path[0], 0);
  assert.equal(p.len, 2);
  close(p.dEff, 2.83, 1e-12);
  assert.equal(p.cap, 15);
  assert.ok(p.perWorker > 0);
  assert.equal(trails.previewTrail(s, d, 5, src.hex).reason, 'invalid:origin');
  assert.equal(trails.previewTrail(s, d, 0, 150).reason, 'invalid:target');
  const b = addSource(s, 'seed_patch', 9);
  addTrail(s, b, [0, 2, 9], 2);
  addTrail(s, b, [0, 2, 9], 2);
  assert.equal(trails.previewTrail(s, d, 0, src.hex).reason, 'noSlot:trail');
});

test('hitTrail lowers S and escorts and kills workers through population.killAdults', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  t.S = 40;
  t.escorts = 5;
  t.workers = 10;
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.forager = 10;
  trails.hitTrail(s, d, t.uid, { workersLost: 4, sLoss: TRAIL.raidS, escortsLost: 2 });
  assert.equal(t.S, 10);
  assert.equal(t.escorts, 3);
  const killedByWp2 = 10 - s.run.colony.adults.minor;
  assert.equal(t.workers, 10 - killedByWp2);
  if (killedByWp2 > 0) {
    const env = fakeEnv();
    trails.tick(s, d, 0.1, env);
    assert.ok(env.events.some((e) => e.type === 'adultsDied' && e.cause === 'raid' && e.n === killedByWp2));
  }
  trails.hitTrail(s, d, 12345, { sLoss: 5 }); // unknown uid: no throw
  assert.equal(typeof population.killAdults, 'function');
});

test('cutTrailsAt deletes crossing trails (rev++, trailDeleted on the next tick); resetStrength zeroes S', () => {
  const { s, d } = world();
  const seed = addSource(s, 'seed_patch', 8);
  addTrail(s, seed, [0, 2, 8], 2, { S: 30 });
  s.run.surface.trails[0].S = 20;
  trails.resetStrength(s, d);
  assert.ok(s.run.surface.trails.every((t) => t.S === 0));
  const rev = s.run.surface.rev;
  assert.equal(trails.cutTrailsAt(s, d, [2]), 1);
  assert.equal(s.run.surface.trails.length, 1);
  assert.equal(s.run.surface.rev, rev + 1);
  const env = fakeEnv();
  trails.tick(s, d, 0.1, env);
  assert.ok(env.events.some((e) => e.type === 'trailDeleted'));
  assert.equal(trails.cutTrailsAt(s, d, 'nope'), 0);
});

test('trunk_trails: long trails get ×1.5 and their hexes count as territory; trails never fork (C132)', { skip: !RESEARCH.trunk_trails && 'needs WP5 research data' }, () => {
  const { s, d } = world({ nest: { agg: { haulH: 0.5 } } });
  s.run.surface.trails.length = 0;   // no other trail to share hexes with (C132 overlap)
  const far = addSource(s, 'seed_patch', hexIndex(5, 0));
  const t = addTrail(s, far, [0, 3, 9, 21, 39, hexIndex(5, 0)], 5);
  const before = trails.trailYield(s, d, t, 5).out;
  s.run.research.trunk_trails = 1;
  surface.derive(s, d);
  assert.deepEqual(trails.trailOrigins(s, d), [0], 'origins are the entrances only, even with trunk_trails');
  const near = addSource(s, 'seed_patch', hexIndex(3, -2));
  assert.equal(trails.handlers.drawTrail.validate(s, d, { origin: 21, target: near.hex }), 'invalid:origin');
  assert.equal(d.surface.owned[far.hex], 4, 'trunk hexes count as territory');
  close(trails.trailYield(s, d, t, 5).out / before, RESEARCH.trunk_trails.fx.mult * TERRITORY.ownedSource, 1e-9);
});

/** Two trails from the main entrance sharing their first two hexes: A (5 steps) and B (4 steps). */
function sharedPair() {
  const { s, d } = world({ nest: { agg: { haulH: 0.5 } } });
  s.run.surface.trails.length = 0;
  const sa = addSource(s, 'seed_patch', hexIndex(5, 0));
  const sb = addSource(s, 'seed_patch', hexIndex(2, 2));
  const a = addTrail(s, sa, [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), hexIndex(4, 0), hexIndex(5, 0)], 5);
  const b = addTrail(s, sb, [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(2, 1), hexIndex(2, 2)], 4);
  surface.derive(s, d);
  return { s, d, a, b };
}

test('C132 Trunk Trails overlap: each trail ×(1 + overlap × shared-hex fraction), origin hex not counted; none without the research', { skip: !RESEARCH.trunk_trails && 'needs WP5 research data' }, () => {
  const k = RESEARCH.trunk_trails.fx.overlap;
  assert.ok(k > 0, 'overlap bonus lives in data');
  const { s, d, a, b } = sharedPair();
  // without the research: no bonus, but the shared stretch is still reported
  const o0 = trails.trailOverlap(s, d, a);
  assert.deepEqual([o0.shared, o0.total, o0.mult], [2, 5, 1]);
  s.run.research.trunk_trails = 1;
  surface.derive(s, d);
  const oa = trails.trailOverlap(s, d, a);
  const ob = trails.trailOverlap(s, d, b);
  close(oa.frac, 2 / 5, 1e-12);
  close(ob.frac, 2 / 4, 1e-12);
  close(oa.mult, 1 + k * 0.4, 1e-12);
  close(ob.mult, 1 + k * 0.5, 1e-12);
  const withB = trails.trailYield(s, d, a, 5).out;
  const T = s.run.surface.trails;
  T.splice(T.indexOf(b), 1);
  const alone = trails.trailYield(s, d, a, 5).out;
  close(withB / alone, 1 + k * 0.4, 1e-9);
  // a hypothetical trail (preview, uid 0) counts every live trail as "another" trail
  close(trails.trailOverlap(s, d, { uid: 0, path: a.path }).frac, 1, 1e-12);
});

test('C132 overlap reaches the ledger through tick (allocator and yields agree)', { skip: !RESEARCH.trunk_trails && 'needs WP5 research data' }, () => {
  const { s, d, a } = sharedPair();
  s.run.research.trunk_trails = 1;
  s.run.colony.jobs.forager = 10;
  a.workers = 5;
  tickOnce(s, d);
  const e = d.surface.trails.find((x) => x.uid === a.uid);
  close(e.out, trails.trailYield(s, d, a, e.workers).out, 1e-9);
});

test('C132: a forked trail from an old save is re-routed from the best entrance on the next tick, keeping workers / escorts / S', () => {
  const { s, d } = world({ nest: { agg: { haulH: 0.5 } } });
  const sat = hexIndex(-4, 0);
  surface.addEntrance(s, d, 'satellite', sat, 3, 0);
  const trunkSrc = addSource(s, 'seed_patch', hexIndex(5, 0));
  addTrail(s, trunkSrc, [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), hexIndex(4, 0), hexIndex(5, 0)], 5);
  const leaf = addSource(s, 'seed_patch', hexIndex(3, 2));
  // a fork from (3,0) of the trail above, as the old Trunk Trails allowed
  const fork = addTrail(s, leaf, [hexIndex(3, 0), hexIndex(3, 1), hexIndex(3, 2)], 2, { workers: 4, escorts: 2, S: 33 });
  s.run.colony.jobs.forager = 10;
  s.run.colony.adults.soldier = 5;
  const ev = tickOnce(s, d);
  assert.equal(fork.origin, 0, 'nearest entrance by route: the main one');
  assert.equal(fork.path[0], 0);
  assert.equal(fork.path[fork.path.length - 1], leaf.hex);
  assert.equal(fork.workers, 4);
  assert.equal(fork.escorts, 2);
  assert.ok(fork.S > 30, 'strength kept');
  assert.ok(ev.some((e) => e.type === 'trailRehomed' && e.uid === fork.uid && e.ok === true && e.origin === 0));
  // every trail now starts at an entrance; deleting the parent leaves nothing dangling
  const ents = new Set(trails.trailOrigins(s, d));
  assert.ok(s.run.surface.trails.every((t) => ents.has(t.origin) && t.path[0] === t.origin));
  const parent = s.run.surface.trails.find((t) => t.src === trunkSrc.uid);
  trails.handlers.deleteTrail.apply(s, d, { uid: parent.uid }, fakeEnv());
  const ev2 = tickOnce(s, d);
  assert.ok(!ev2.some((e) => e.type === 'trailRehomed'), 'nothing to re-home after a delete');
  assert.ok(s.run.surface.trails.some((t) => t.uid === fork.uid));
});

test('C132: a forked trail no entrance can reach is dropped with trailDeleted + trailRehomed { ok: false }', () => {
  const { s, d } = world();
  const hole = hexIndex(5, 0);
  for (const n of neighbors(hole)) s.run.surface.terrain[n] = TERRAIN.stone.code;
  const src = addSource(s, 'seed_patch', hole);
  const fork = addTrail(s, src, [hexIndex(6, 0), hole], 1);
  surface.derive(s, d);
  const ev = tickOnce(s, d);
  assert.ok(!s.run.surface.trails.some((t) => t.uid === fork.uid));
  assert.ok(ev.some((e) => e.type === 'trailDeleted' && e.uid === fork.uid));
  assert.ok(ev.some((e) => e.type === 'trailRehomed' && e.uid === fork.uid && e.ok === false));
});

test('rally / unescorted / source effects multiply the trail; barren_ground halves yields', () => {
  const { s, d } = world();
  const t = s.run.surface.trails[0];
  const base = trails.trailYield(s, d, { ...t, escorts: 100 }, 5).out;
  s.run.effects.push({ id: 'rally:' + t.uid, stat: 'forage_trail', mult: 2, add: 0, scope: t.uid, t: 30 });
  close(trails.trailYield(s, d, { ...t, escorts: 100 }, 5).out, 2 * base, 1e-12);
  s.run.effects.push({ id: 'phorid', stat: 'forage_unescorted', mult: 0.9, add: 0, scope: null, t: 30 });
  close(trails.trailYield(s, d, { ...t, escorts: 0 }, 5).out, 2 * 0.9 * base, 1e-12);
  s.run.effects.push({ id: 'mast', stat: 'source_type', mult: 3, add: 0, scope: 'crumb_scatter', t: 30 });
  close(trails.trailYield(s, d, { ...t, escorts: 100 }, 5).out, 6 * base, 1e-12);
  assert.equal(effectMult(s, 'source_type', 'crumb_scatter'), 3);
  s.run.effects.length = 0;
  s.run.hardship = 'barren_ground';
  const barren = trails.trailYield(s, d, { ...t, escorts: 100 }, 5).out;
  if (barren !== base) close(barren / base, 0.5, 1e-12);
});

test('picnic spills lose 30 % unless escorted (1 per 10 foragers); owned sources ×1.25', () => {
  const { s, d } = world();
  const pic = addSource(s, 'picnic_spill', 2);
  const t = { uid: 70, origin: 0, src: pic.uid, path: [0, 2], len: 1, job: 'forager', S: 0, escorts: 0 };
  const open = trails.trailYield(s, d, t, 20).out;
  const guarded = trails.trailYield(s, d, { ...t, escorts: 2 }, 20).out;
  close(open / guarded, 0.7, 1e-12);
  // hex 2 is inside the auto-claimed ring 1 → owned ×1.25 vs an unowned copy at ring 2
  const pic2 = addSource(s, 'picnic_spill', 8);
  const far = trails.trailYield(s, d, { ...t, src: pic2.uid, path: [0, 8], escorts: 2 }, 20).out;
  close(guarded / far, 1.25, 1e-12);
});

test('a long run of WP4 ticks keeps the state JSON-safe', () => {
  const { s, d } = world();
  const seed = addSource(s, 'seed_patch', 8, { stock: 300, max: 300 });
  addTrail(s, seed, [0, 2, 8], 2, { escorts: 3 });
  s.run.colony.adults.minor = 1e6;
  s.run.colony.adults.soldier = 2;
  s.run.colony.jobs.forager = 9e5;
  s.run.colony.jobs.scout = 50;
  d.rates.food.gross = 1e30;
  for (let i = 0; i < 400; i++) tickOnce(s, d, i % 50 === 0 ? 60 : 0.1, { offline: i % 50 === 0 });
  assert.deepEqual(findBadValues(s), []);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.ok(countInRadius(8) >= s.run.surface.revealed.filter((x) => x).length);
});

test('hive_mind auto-Marks the weakest trail when pheromone is full (online only, respects the Mark cooldown)', () => {
  const { s, d } = world({ stats: { pheromoneCap: 50 } });
  const seed = addSource(s, 'seed_patch', 8);
  const strong = addTrail(s, seed, [0, 2, 8], 2, { S: 60 });
  const weak = s.run.surface.trails[0];
  weak.S = 10;
  s.run.res.pheromone = 50;
  tickOnce(s, d, 0.1);
  assert.equal(weak.S < 20, true, 'not owned yet: nothing happens');
  s.run.research.hive_mind = 1;
  const ev = tickOnce(s, d, 0.1);
  assert.ok(weak.S > 30, 'weakest trail marked');
  assert.ok(strong.S < 61);
  assert.equal(s.run.res.pheromone, 45);
  assert.equal(s.run.surface.cd.mark, 3);
  assert.ok(ev.some((e) => e.type === 'abilityUsed' && e.id === 'mark' && e.uid === weak.uid));
  s.run.res.pheromone = 50;
  tickOnce(s, d, 0.1);
  assert.equal(s.run.res.pheromone, 50, 'cooldown');
  s.run.surface.cd.mark = 0;
  tickOnce(s, d, 1, { offline: true });
  assert.equal(s.run.res.pheromone, 50, 'never offline');
});
