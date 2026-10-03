// Offline catch-up cost (bug-hunt F24; DESIGN §21.3 / §27.3): advisor- and UI-only work (best untrailed source,
// Next Goals, the next-unlock ribbon) is skipped on offline steps and rebuilt by the closing online pass, and a 24 h
// catch-up of a late-game save stays within a generous time bound (a regression guard, not the 60 ms budget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fromExportString } from '../src/core/save.js';
import { createDerived } from '../src/core/derived.js';
import { step } from '../src/core/step.js';
import { simulateOffline, offlineSchedule } from '../src/core/offline.js';

const late = () => {
  const r = fromExportString(fs.readFileSync(new URL('./fixtures/late_21h.txt', import.meta.url), 'utf8').trim());
  assert.equal(r.ok, true, r.error);
  return r.state;
};

test('F24: offline steps skip the UI-only estimates; the next online pass rebuilds them', () => {
  const s = late();
  const d = createDerived();
  step(s, d, 0, [], {});
  assert.ok(d.surface.bestSource > 0 || d.surface._bestKey !== null, 'online derive computes the best untrailed source');
  const goals = ['sentinel'];
  const ribbon = { key: 'sentinel' };
  d.progress.goals = goals;
  d.progress.nextUnlock = ribbon;
  simulateOffline(s, d, 3600, { eff: 1 });
  assert.equal(d.surface._bestKey, null, 'best source not recomputed offline');
  assert.equal(d.progress.goals, goals, 'Next Goals not rebuilt offline');
  assert.equal(d.progress.nextUnlock, ribbon, 'ribbon not rebuilt offline');
  step(s, d, 0, [], {});
  assert.notEqual(d.surface._bestKey, null, 'the online pass recomputes the best source');
  assert.notEqual(d.progress.goals, goals);
  assert.ok(Array.isArray(d.progress.goals));
  assert.notEqual(d.progress.nextUnlock, ribbon);
});

test('F24: 24 h offline of a late-game save stays within a generous time bound', () => {
  assert.equal(offlineSchedule(86400).length, 1490, 'the DESIGN §21.3 schedule is unchanged');
  const st = late();
  let best = Infinity;
  for (let k = 0; k < 2; k++) {
    const s = structuredClone(st);
    const d = createDerived();
    step(s, d, 0, [], {});
    const t0 = performance.now();
    simulateOffline(s, d, 86400, { eff: 1 });
    best = Math.min(best, performance.now() - t0);
  }
  // Measured ≈ 0.2–0.3 s on the reference machine after the F24 pass (0.4–0.65 s before); DESIGN asks ≤ 60 ms.
  assert.ok(best < 2000, '24 h offline took ' + best.toFixed(0) + ' ms');
});
