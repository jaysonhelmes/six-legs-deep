// WP1 unit tests: core/offline.js (schedule, cap/efficiency, simulateOffline bookkeeping, banking).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  offlineCapEff, offlineSchedule, simulateOffline, bankBeyondCap, bankSavedFinds, mergeSummaries, emptySummary,
} from '../src/core/offline.js';
import { OFFLINE } from '../src/data/balance.js';
import { RESEARCH } from '../src/data/research.js';
import { TRAITS } from '../src/data/bloodline.js';
import { CHAMBERS } from '../src/data/chambers.js';
import { FEDERATION } from '../src/data/federation.js';
import { GENOME } from '../src/data/genome.js';
import { newState, makeDerived } from './helpers.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);
const fx = (table, id) => (table[id] && table[id].fx) || {};

test('offlineSchedule(86400): 1,490 steps (≤ 1,500) summing to exactly 86,400', () => {
  const st = offlineSchedule(86400);
  assert.equal(st.length, 1490);
  assert.ok(st.length <= OFFLINE.maxSteps);
  assert.equal(sum(st), 86400);
  assert.ok(st.slice(0, 60).every((x) => x === 10));
  assert.ok(st.slice(60).every((x) => x === 60));
});

test('offlineSchedule: short gaps, trimmed last step, empty for ≤ 0', () => {
  assert.deepEqual(offlineSchedule(25), [10, 10, 5]);
  assert.equal(offlineSchedule(600).length, 60);
  assert.deepEqual(offlineSchedule(700), [...new Array(60).fill(10), 60, 40]);
  assert.deepEqual(offlineSchedule(0), []);
  assert.deepEqual(offlineSchedule(-5), []);
  assert.deepEqual(offlineSchedule(NaN), []);
  assert.equal(sum(offlineSchedule(3600)), 3600);
});

test('offlineSchedule: gaps needing more than 1,500 steps scale every step up uniformly', () => {
  for (const sec of [172800, 7 * 86400, 1e9]) {
    const st = offlineSchedule(sec);
    assert.ok(st.length <= 1500 && st.length >= 1400, sec + ' → ' + st.length);
    assert.ok(Math.abs(sum(st) - sec) <= sec * 1e-12);
    const big = Math.max(...st);
    assert.ok(st[0] > 10 && big > 60);
  }
});

test('offlineCapEff: base 4 h at 50 %', () => {
  assert.deepEqual(offlineCapEff(newState(), makeDerived()), { capSec: 14400, eff: 0.5 });
});

test('offlineCapEff applies research, traits, deep vault, federation and genome from the data tables', () => {
  const s = newState();
  const d = makeDerived({ nest: { agg: { deepVaultL: 3 } } });
  s.run.research.collective_memory = 1;
  s.run.research.diapause_logic = 1;
  s.cycle.traits.long_memory = 2;
  const cap = 14400 + (fx(RESEARCH, 'collective_memory').offlineSec || 0) + (fx(TRAITS, 'long_memory').capSec || 0) * 2
    + (fx(CHAMBERS, 'deep_vault').offlineSec || 0) * 3;
  const eff = Math.min(1, 0.5 + (fx(TRAITS, 'long_memory').eff || 0) * 2 + (fx(RESEARCH, 'diapause_logic').offlineEff || 0));
  const r = offlineCapEff(s, d);
  assert.equal(r.capSec, cap);
  assert.ok(Math.abs(r.eff - eff) < 1e-12);
  s.era.federation.diapause_mastery = 1;
  const m = offlineCapEff(s, d);
  assert.equal(m.capSec, Math.max(cap, fx(FEDERATION, 'diapause_mastery').capSec || 0));
  if (fx(FEDERATION, 'diapause_mastery').eff !== undefined) assert.equal(m.eff, 1);
  s.meta.genome.dreaming_hive = 1;
  assert.equal(offlineCapEff(s, d).capSec, Math.max(m.capSec, fx(GENOME, 'dreaming_hive').capSec || 0));
});

test('simulateOffline: calls step on the schedule with offline env, fills and clears offlineLog, diffs counters', () => {
  const s = newState();
  const d = makeDerived();
  const calls = [];
  const fake = (st, dd, dt, cmds, opts) => {
    calls.push({ dt, cmds, opts });
    assert.ok(dd.offlineLog && Array.isArray(dd.offlineLog.cells));
    dd.offlineLog.cells.push(calls.length);
    if (calls.length === 2) dd.offlineLog.chambers.push(9);
    st.run.fRun += 10 * dt;
    st.run.stats.foodWasted += 1;
    st.run.stats.hatched += 2;
    st.run.stats.cellsDug += 1;
    st.meta.season.t += dt;
    return [];
  };
  const r = simulateOffline(s, d, 700, { eff: 0.5, stepFn: fake });
  assert.equal(calls.length, 62);
  assert.ok(calls.every((c) => c.opts.offline === true && c.opts.eff === 0.5 && c.cmds.length === 0));
  assert.equal(sum(calls.map((c) => c.dt)), 700);
  assert.equal(d.offlineLog, null);
  assert.equal(r.seconds, 700);
  assert.equal(r.eff, 0.5);
  assert.equal(r.foodGained, 7000);
  assert.equal(r.foodWasted, 62);
  assert.equal(r.hatched, 124);
  assert.equal(r.cellsDug, 62);
  assert.equal(r.seasons, 1); // 700 s of a 360 s season clock from t = 0
  assert.equal(r.cells.length, 62);
  assert.deepEqual(r.chambers, [9]);
  assert.deepEqual(Object.keys(r), ['seconds', 'eff', 'foodGained', 'foodWasted', 'hatched', 'cellsDug', 'chambersDone', 'seasons',
    'sourcesDepleted', 'savedFinds', 'diapause', 'cells', 'chambers']);
});

test('simulateOffline with the real step (stub-safe) and zero seconds', () => {
  const s = newState();
  const d = makeDerived();
  const r = simulateOffline(s, d, 120, { eff: 1 });
  assert.equal(r.seconds, 120);
  assert.equal(s.meta.tick, 12);
  assert.ok(Math.abs(s.run.time - 120) < 1e-9);
  assert.equal(d.offlineLog, null);
  const z = simulateOffline(s, d, 0, { eff: 1 });
  assert.equal(z.seconds, 0);
  assert.equal(s.meta.tick, 12);
  // eff defaults to offlineCapEff
  assert.equal(simulateOffline(newState(), makeDerived(), 10).eff, 0.5);
});

test('bankBeyondCap: 10 % of time beyond the cap, up to 8 h', () => {
  const s = newState();
  assert.equal(bankBeyondCap(s, 3600), 360);
  assert.equal(s.meta.diapause.bank, 360);
  assert.equal(bankBeyondCap(s, 1e9), 28800 - 360);
  assert.equal(s.meta.diapause.bank, 28800);
  assert.equal(bankBeyondCap(s, 100), 0);
  assert.equal(bankBeyondCap(s, -5), 0);
});

test('bankSavedFinds: one per 2 h of gap, max 3', () => {
  const s = newState();
  assert.equal(bankSavedFinds(s, 7199), 0);
  assert.equal(bankSavedFinds(s, 7200), 1);
  assert.equal(bankSavedFinds(s, 4 * 7200), 2);
  assert.equal(s.meta.savedFinds, 3);
  assert.equal(bankSavedFinds(s, 1e6), 0);
});

test('mergeSummaries sums fields and concatenates logs', () => {
  const a = { ...emptySummary(1), seconds: 100, foodGained: 5, cells: [1] };
  const b = { ...emptySummary(0.5), seconds: 50, foodGained: 2, cells: [2], chambers: [7] };
  const m = mergeSummaries(a, b);
  assert.equal(m.seconds, 150);
  assert.equal(m.eff, 0.5);
  assert.equal(m.foodGained, 7);
  assert.deepEqual(m.cells, [1, 2]);
  assert.deepEqual(m.chambers, [7]);
  assert.equal(mergeSummaries(a, emptySummary(0.5)).eff, 1);
});
