// WP7 unit tests: prestige formulas against the DESIGN tables — alates (§13.2), Lineage (§13.3), kinship (§14.2),
// genes (§15.2), passives (§14.3, §15.3), hardship goals (§13.8) and the §16.6 thresholds (ARCHITECTURE §15.3 #5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived } from './helpers.js';
import { projectAlates, projectKinship, projectGenes, lineage, derive } from '../src/systems/prestige.js';
import { goal } from '../src/systems/hardships.js';

/** Projected alates for one row of the DESIGN §13.2 table. */
function alatesRow({ fRun, tPeak, reared, W, K = 0, court = false }) {
  const s = newState(1);
  const d = makeDerived({ season: { mods: { flightW: W } } });
  s.run.fRun = fRun;
  s.run.tPeak = tPeak;
  s.run.colony.alatesReared = reared;
  s.era.kinshipLife = K;
  if (court) s.cycle.traits.royal_court = 1;
  return projectAlates(s, d);
}

const within1 = (got, want, msg) => assert.ok(Math.abs(got - want) <= 1, msg + ': got ' + got + ', want ' + want + ' ±1');

test('alates table (DESIGN §13.2) matches ±1', () => {
  within1(alatesRow({ fRun: 1e8, tPeak: 20, reared: 0, W: 1 }), 10, 'threshold');
  within1(alatesRow({ fRun: 1.3e8, tPeak: 175, reared: 25, W: 1 }), 24, 'run 1 ~45 min');
  within1(alatesRow({ fRun: 2.1e8, tPeak: 200, reared: 25, W: 1.25 }), 40, 'run 1 ~60 min summer');
  within1(alatesRow({ fRun: 4.5e8, tPeak: 215, reared: 25, W: 1 }), 48, 'run 1 ~90 min');
  within1(alatesRow({ fRun: 1e11, tPeak: 250, reared: 25, W: 1 }), 770, 'late layer 1');
  const big = alatesRow({ fRun: 1e13, tPeak: 400, reared: 50, W: 1.25, K: 10, court: true });
  within1(big, 28795, 'layer-2 run (K 10, royal_court)');
  assert.ok(big < 3e4, 'the last row stays just under the 3e4 softcap');
});

test('threshold f_run 1e8 → 10 alates before other factors; 0 f_run → 0', () => {
  assert.equal(alatesRow({ fRun: 1e8, tPeak: 0, reared: 0, W: 1 }), 10);
  assert.equal(alatesRow({ fRun: 0, tPeak: 0, reared: 0, W: 1 }), 0);
});

test('reared alates cap at 25 (50 with royal_court); W uses max(season, flight_w effect)', () => {
  assert.equal(alatesRow({ fRun: 1e10, tPeak: 0, reared: 25, W: 1 }), alatesRow({ fRun: 1e10, tPeak: 0, reared: 500, W: 1 }));
  assert.ok(alatesRow({ fRun: 1e10, tPeak: 0, reared: 50, W: 1, court: true }) > alatesRow({ fRun: 1e10, tPeak: 0, reared: 50, W: 1 }));
  const s = newState(1);
  const d = makeDerived();
  s.run.fRun = 1e10;
  const base = projectAlates(s, d);
  s.run.effects.push({ id: 'ev_flight_day', stat: 'flight_w', mult: 1.5, add: 0, scope: null, t: 60 });
  assert.ok(Math.abs(projectAlates(s, d) / base - 1.5) < 0.01, 'flight_w 1.5 overrides the spring W of 1');
});

test('alates achievement bonuses and wide_wings multiply flight alates', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.fRun = 1e12;
  const base = projectAlates(s, d);
  s.meta.achievements.ach_swift_swarm = 1;
  s.meta.achievements.ach_gentle_giants = 1;
  s.meta.achievements.ach_flying_ant_day = 1;
  s.cycle.traits.wide_wings = 2;
  const want = base * 1.1 * 1.05 * 1.05 * 1.15 ** 2;
  assert.ok(Math.abs(projectAlates(s, d) - want) <= 2, 'got ' + projectAlates(s, d) + ', want ≈ ' + want);
});

test('Lineage table (DESIGN §13.3): 2.5 / 6 / 18.97 / 189.7, continuous at the knee', () => {
  assert.equal(lineage(0), 1);
  assert.equal(lineage(30), 2.5);
  assert.equal(lineage(100), 6);
  assert.ok(Math.abs(lineage(1000) - 18.97) < 0.01);
  assert.ok(Math.abs(lineage(1e5) - 189.7) < 0.05);
  assert.ok(Math.abs(lineage(100 + 1e-9) - lineage(100)) < 1e-6, 'continuous at a = 100');
  for (let a = 1; a < 2000; a += 7) assert.ok(lineage(a + 1) > lineage(a), 'monotonic');
});

test('kinship table (DESIGN §14.2): 5,000 → 3, 20,000 → 5, 1e5 → 10, 1e6 → 22, 1e8 → 112', () => {
  const s = newState(1);
  const d = makeDerived();
  const rows = [[5000, 3], [20000, 5], [1e5, 10], [1e6, 22], [1e8, 112]];
  for (const [a, k] of rows) {
    s.cycle.alatesCycle = a;
    assert.equal(projectKinship(s, d), k, 'alatesCycle ' + a);
  }
  s.cycle.alatesCycle = 0;
  assert.equal(projectKinship(s, d), 0);
});

test('genes table (DESIGN §15.2): kinship_era / 50 — 200 → 4, 1,000 → 20, 2,000 → 40, 10,000 → 200, 1e6 → 1e4 × √2 (softcap)', () => {
  const s = newState(1);
  const d = makeDerived();
  const rows = [[200, 4], [1000, 20], [2000, 40], [10000, 200], [1e6, Math.floor(1e4 * Math.SQRT2)]];
  for (const [k, g] of rows) {
    s.era.kinshipLife = k;
    assert.equal(projectGenes(s, d), g, 'kinshipLife ' + k);
  }
});

test('softcaps keep huge inputs finite (alates 3e4, kinship 1e5, genes 1e4)', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.fRun = 1e290;
  s.cycle.alatesCycle = 1e290;
  s.era.kinshipLife = 1e290;
  for (const v of [projectAlates(s, d), projectKinship(s, d), projectGenes(s, d)]) assert.ok(Number.isFinite(v) && v > 0);
  s.era.kinshipLife = 0;
  s.run.fRun = 1e8 * (3e4 / 10) ** 2 * 4; // raw 6e4 alates (tPeak 0, reared 0, W 1) → sc = 3e4 × 2^0.5
  assert.ok(Math.abs(projectAlates(s, d) - Math.floor(3e4 * Math.SQRT2)) <= 1);
});

test('kinship passive table (DESIGN §14.3) at K = 3 and K = 30', () => {
  for (const [K, food, other, alates, scale] of [[3, 5.66, 2, 1.41, 1.32], [30, 73, 5.6, 2.36, 1.99]]) {
    const s = newState(1);
    const d = makeDerived();
    s.era.kinshipLife = K;
    derive(s, d);
    const p = d.meta.prestige;
    const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, 'K ' + K + ': ' + a + ' vs ' + b);
    near(p.food, food, 0.5);
    for (const k of ['dig', 'insight', 'honeydew', 'fungus', 'chitin']) near(p[k], other, 0.05);
    near(p.alates, alates, 0.01);
    near(d.meta.colonyScale, scale, 0.01);
  }
});

test('genes passive table (DESIGN §15.3) at G = 4 and G = 30', () => {
  for (const [G, food, other, ap] of [[4, 11.2, 1.5, 5], [30, 173, 2.36, 31]]) {
    const s = newState(1);
    const d = makeDerived();
    s.meta.genesLife = G;
    derive(s, d);
    const p = d.meta.prestige;
    assert.ok(Math.abs(p.food - food) < 0.5, 'food ' + p.food);
    for (const k of ['dig', 'insight', 'honeydew', 'fungus', 'chitin']) assert.ok(Math.abs(p[k] - other) < 0.01, k + ' ' + p[k]);
    assert.equal(p.ap, ap);
  }
});

test('hardship goals (DESIGN §13.8): 1e9, 1e11, 1e13, 1e15, 1e17', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(goal), [1e9, 1e11, 1e13, 1e15, 1e17]);
});
