// INTEGRATION TEST — DESIGN §21.3 / §28.1 #7 offline-vs-online invariant on a MID-GAME state where the food cap holds
// only one egg (gameplay fix F23, ARCHITECTURE §18 C70). integration.offline.test.js checks the invariant on a fresh
// game, where the cap never binds; here a 12 h pacing-bot save (run 17: food cap 5,173, minor egg 4,138, income
// 2e7 food/s) is played 20 minutes online in 0.1 s ticks and through the real offline schedule (10 s, then 60 s steps).
// Before the fix every offline step could lay at most floor(cap / egg cost) = 1 egg, so offline laid ~80 % fewer eggs.
// Fixture: tests/fixtures/mid_capbound.txt (export string of that save; no mold, so the C68 offline lifting of
// harmful event effects does not make the two runs differ).
// Scope: the laying pipeline (eggs, adults, hatched, the food store). f_run and soil are not compared here: on this save
// they drift 3–5 % apart over 20 min for reasons outside laying (threshold jobs read the bottleneck at the end of each
// long offline step, so the nurse shift seen online does not happen; temporary sources expire differently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame } from '../src/core/game.js';
import { createDerived } from '../src/core/derived.js';
import { step } from '../src/core/step.js';
import { simulateOffline, offlineSchedule } from '../src/core/offline.js';
import { adultsTotal } from '../src/core/state.js';
import { snapshot, quietWorld } from './helpers.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mid_capbound.txt');
const SECONDS = 1200;

/** Relative difference with an absolute floor. */
function within(a, b, rel, abs = 0) {
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

/** Install a JSON copy of `base` with a fresh derived cache and one derive pass. */
function install(base) {
  const s = JSON.parse(JSON.stringify(base));
  const d = createDerived();
  step(s, d, 0, [], {});
  return { s, d };
}

test('F23: 20 min offline at 100 % efficiency matches 20 min online on a cap-bound mid-game save (within 2 %)', () => {
  const g = createGame({ nowMs: 0, storage: null });
  const r = g.importString(readFileSync(FIXTURE, 'utf8'), 0);
  assert.ok(!r || r.ok !== false, 'fixture imports');
  quietWorld(g.s);
  // No harmful event effects in play (C68 lifts them offline only, which would be a different comparison).
  g.s.run.events.objects = g.s.run.events.objects.filter((o) => o.kind !== 'mold');
  g.s.effects = (g.s.effects || []).filter((e) => !(typeof e.id === 'string' && e.id.startsWith('mold:')));
  const base = snapshot(g.s);

  const online = install(base);
  const st = online.d.stats;
  const perStepCap = Math.floor(st.foodCap / st.eggCost.minor);
  assert.ok(perStepCap <= 2, `precondition: the cap holds at most 2 eggs (cap ${st.foodCap}, egg ${st.eggCost.minor})`);
  const eggs0 = online.s.run.stats.eggs;
  for (let i = 0; i < SECONDS * 10; i++) step(online.s, online.d, 0.1, [], { offline: false, eff: 1, econScale: 1 });

  const offline = install(base);
  const sum = simulateOffline(offline.s, offline.d, SECONDS, { eff: 1 });
  assert.equal(sum.seconds, SECONDS);

  const A = online.s, B = offline.s;
  const eggsOn = A.run.stats.eggs - eggs0;
  const eggsOff = B.run.stats.eggs - eggs0;
  const steps = offlineSchedule(SECONDS).length;
  assert.ok(eggsOn > 3 * perStepCap * steps,
    `precondition: online laid more (${eggsOn}) than the old per-step limit allows offline (${perStepCap} × ${steps} steps)`);

  const rows = [
    ['eggs laid', eggsOn, eggsOff, 0.02, 1],
    ['adultsTotal', adultsTotal(A), adultsTotal(B), 0.02, 1],
    ['hatched', A.run.stats.hatched, B.run.stats.hatched, 0.02, 1],
    ['run.res.food', A.run.res.food, B.run.res.food, 0.02, 2],
  ];
  const bad = rows.filter(([, a, b, rel, abs]) => !within(a, b, rel, abs)).map(([k, a, b]) => k + ': online ' + a + ' vs offline ' + b);
  assert.deepEqual(bad, []);
});
