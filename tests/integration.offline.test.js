// INTEGRATION TEST — ARCHITECTURE §15.3 #7 / DESIGN §21.3, §28.1 #7. Owner: WP1.
// simulateOffline(s, 3600) at 100 % efficiency is within 2 % of 36,000 online ticks of 0.1 s, events disabled.
// EXPECTED TO FAIL against the WP1 stubs only on the "the colony actually grew" precondition (the stub systems
// produce nothing, so the 2 % comparison would be vacuous).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { createDerived } from '../src/core/derived.js';
import { step } from '../src/core/step.js';
import { simulateOffline } from '../src/core/offline.js';
import { adultsTotal } from '../src/core/state.js';
import { snapshot, quietWorld } from './helpers.js';

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

test('1 h offline at 100 % efficiency is within 2 % of 1 h online (events off)', () => {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, 7);
  quietWorld(g.s);
  const base = snapshot(g.s);

  const online = install(base);
  for (let i = 0; i < 36000; i++) step(online.s, online.d, 0.1, [], { offline: false, eff: 1, econScale: 1 });

  const offline = install(base);
  const sum = simulateOffline(offline.s, offline.d, 3600, { eff: 1 });
  assert.equal(sum.seconds, 3600);

  const A = online.s, B = offline.s;
  // precondition: the comparison is meaningful only if the colony did something in that hour
  assert.ok(adultsTotal(A) >= 5 && A.run.fRun > 100,
    'online colony grew (adults ' + adultsTotal(A) + ', fRun ' + A.run.fRun.toFixed(1) + ')');

  const rows = [
    ['run.fRun', A.run.fRun, B.run.fRun, 0.02, 0],
    ['adultsTotal', adultsTotal(A), adultsTotal(B), 0.02, 1],
    ['run.res.food', A.run.res.food, B.run.res.food, 0.02, 2],
    ['run.res.soil', A.run.res.soil, B.run.res.soil, 0.02, 2],
    ['meta.foodEver', A.meta.stats.foodEver, B.meta.stats.foodEver, 0.02, 0],
  ];
  const bad = rows.filter(([, a, b, rel, abs]) => !within(a, b, rel, abs)).map(([k, a, b]) => k + ': online ' + a + ' vs offline ' + b);
  assert.deepEqual(bad, []);
  assert.ok(Math.abs(A.run.time - B.run.time) < 1e-6);
  assert.equal(A.meta.season.year, B.meta.season.year);
  assert.ok(Math.abs(A.meta.season.t - B.meta.season.t) < 1e-6);
});
