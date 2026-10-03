// Regression tests for the browser runtime contract of core/game.js (ARCHITECTURE §7.1, §14.7, §18 C78–C80):
// F4  hidden-tab time survives a reload (saves while hidden keep lastSeen at the wall time the simulation reached);
// F6  meta.flags.clockSkew is cleared by the next load with a non-negative gap;
// F25 a < 60 s backlog (tab return) can be spread over several frames with identical results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { TICK, OFFLINE } from '../src/data/balance.js';
import { makeFakeStorage, snapshot } from './helpers.js';

/** A fake stepFn that records calls and advances only the time fields (like the real step). */
function recorder() {
  const calls = [];
  const fn = (s, d, dt, cmds, opts) => {
    calls.push({ dt, cmds, opts });
    s.meta.tick++;
    s.meta.simTime += dt;
    if (!s.meta.pending) s.run.time += dt;
    return [];
  };
  return { fn, calls };
}

/** Seconds simulated offline at efficiency `eff` (offline calls only). */
function offlineSec(calls, eff) {
  return calls.filter((c) => c.opts.offline === true && c.opts.eff === eff).reduce((a, c) => a + c.dt, 0);
}

const T0 = 1_700_000_000_000;

// ---- F4 ----------------------------------------------------------------------------------------------------------

test('F4: hidden-tab time survives a reload: hidden saves keep lastSeen; the load credits it at 100 %, then offline', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: T0, storage, stepFn: recorder().fn });
  g.newGame(T0, 1);
  let now = T0;
  for (let i = 0; i < 600; i++) { now += 100; g.advance(0.1, now); }    // 60 s visible play
  const hideAt = now;
  assert.equal(g.save(now, { hidden: true }).ok, true);                // visibilitychange → hidden
  for (let t = 15; t <= 3 * 3600; t += 15) g.save(hideAt + t * 1000, { hidden: true });   // autosave keeps firing
  assert.equal(g.s.meta.lastSeen, hideAt, 'lastSeen stays at the wall time the simulation reached');
  assert.equal(g.s.meta.savedAt, hideAt + 3 * 3600 * 1000, 'savedAt records that the tab was still alive');
  now = hideAt + 3 * 3600 * 1000;
  g.save(now, { hidden: true });                                       // pagehide: browser closed / tab discarded
  now += 600 * 1000;                                                   // … reopened 10 minutes later
  const rec = recorder();
  const g2 = createGame({ nowMs: now, storage, stepFn: rec.fn });
  const r = g2.loadOrNew(now);
  assert.equal(r.loaded, true);
  assert.equal(r.welcome.seconds, 3 * 3600 + 600, 'the whole absence is credited');
  assert.equal(offlineSec(rec.calls, 1), 3 * 3600, 'the hidden span counts at 100 % (DESIGN §21.1)');
  assert.equal(offlineSec(rec.calls, OFFLINE.baseEff), 600, 'the closed span follows the offline rules');
  assert.equal(g2.s.meta.lastSeen, now);
});

test('F4: the hidden-tab budget (4 h) still applies across a reload; the rest follows the offline cap', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: T0, storage, stepFn: recorder().fn });
  g.newGame(T0, 1);
  g.save(T0, { hidden: true });
  g.save(T0 + 8 * 3600e3, { hidden: true });                            // 8 h hidden, then closed for 2 h
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, storage, stepFn: rec.fn });
  const r = g2.loadOrNew(T0 + 10 * 3600e3);
  assert.equal(r.welcome.seconds, 10 * 3600);
  assert.equal(offlineSec(rec.calls, 1), OFFLINE.hiddenFullSec, 'the first 4 h at 100 %');
  assert.equal(offlineSec(rec.calls, OFFLINE.baseEff), OFFLINE.baseCapSec, '6 h remain: the 4 h offline cap applies');
  assert.equal(g2.s.meta.diapause.bank, 2 * 3600 * OFFLINE.bankRate, 'the 2 h beyond the cap are banked');
});

test('F4: no double counting: after an in-tab catch-up a reload credits only the time since', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: T0, storage, stepFn: recorder().fn });
  g.newGame(T0, 1);
  let now = T0 + 1000;
  g.advance(1, now);
  g.save(now, { hidden: true });                                        // hidden
  for (let t = 60; t <= 3 * 3600; t += 60) g.save(now + t * 1000, { hidden: true });
  now += 3 * 3600 * 1000;
  g.advance(3 * 3600, now);                                             // shown again: one big frame → catchUp
  assert.equal(g.s.meta.lastSeen, now);
  g.save(now + 50, { hidden: true });                                   // hidden again at once, then closed
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, storage, stepFn: rec.fn });
  const r = g2.loadOrNew(now + 50);
  assert.equal(r.welcome, null);
  assert.equal(rec.calls.filter((c) => c.opts.offline === true).length, 0, 'the 3 h were credited once, in the tab');
});

test('F4: a plain save (tools, tests) still stamps lastSeen = nowMs; legacy saves (savedAt = lastSeen) are unchanged', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: T0, storage, stepFn: recorder().fn });
  g.newGame(T0, 1);
  g.save(T0 + 5000);
  assert.equal(g.s.meta.lastSeen, T0 + 5000);
  assert.equal(g.s.meta.savedAt, T0 + 5000);
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, storage, stepFn: rec.fn });
  const r = g2.loadOrNew(T0 + 5000 + 3600e3);
  assert.equal(r.welcome.eff, OFFLINE.baseEff);
  assert.equal(offlineSec(rec.calls, 1), 0, 'a closed browser earns no hidden-tab time');
});

test('F4: a hidden save never moves lastSeen forward and never past nowMs', () => {
  const g = createGame({ nowMs: T0, storage: makeFakeStorage(), stepFn: recorder().fn });
  g.newGame(T0, 1);
  g.advance(0.1, T0 + 100);
  g.save(T0 + 9000, { hidden: true });
  assert.equal(g.s.meta.lastSeen, T0 + 100);
  g.s.meta.lastSeen = T0 + 99_000;                                      // clock went backwards since the last frame
  g.save(T0 + 10_000, { hidden: true });
  assert.equal(g.s.meta.lastSeen, T0 + 10_000);
});

// ---- F6 ----------------------------------------------------------------------------------------------------------

test('F6: clockSkew is cleared by the next load with a non-negative gap', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage, stepFn: recorder().fn });
  g.newGame(500_000, 1);
  g.save(500_000);
  const g2 = createGame({ nowMs: 0, storage, stepFn: recorder().fn });
  g2.loadOrNew(498_000);                                                 // clock 2 s behind
  assert.equal(g2.s.meta.flags.clockSkew, true);
  g2.save(498_000);                                                      // the flag is persisted with the save
  const g3 = createGame({ nowMs: 0, storage, stepFn: recorder().fn });
  const r = g3.loadOrNew(498_000 + 7_200_000);
  assert.equal(r.welcome.seconds, 7200);
  assert.equal(g3.s.meta.flags.clockSkew, false, 'the notice does not return on a normal load');
});

// ---- F25 ---------------------------------------------------------------------------------------------------------

/** A real game that has played 20 s (so systems are warm), with an empty accumulator. */
function warmGame(seed) {
  const g = createGame({ nowMs: T0 });
  g.newGame(T0, seed);
  g.runFor(20);
  g.s.meta.lastSeen = T0 + 20_000;
  g.acc = 0;
  return g;
}

test('F25: a frame budget spreads a < 60 s backlog over frames; the end state equals one big frame', () => {
  const now = T0 + 65_000;
  const a = warmGame(7);
  a.advance(45, now);                                                    // old behaviour: 450 ticks in one call
  const b = warmGame(7);
  const tick0 = b.s.meta.tick;
  b.advance(45, now, { maxTicks: 20 });
  assert.equal(b.s.meta.tick - tick0, 20, 'only 20 ticks in the return frame');
  assert.ok(Math.abs(b.acc - 43) < 1e-6, 'the rest waits in the accumulator');
  assert.equal(b.s.meta.lastSeen, now - Math.round(b.acc * 1000), 'lastSeen trails by the undrained backlog');
  let frames = 1;
  while (b.acc > TICK + 1e-9 && frames < 100) { b.advance(0, now, { maxTicks: 20 }); frames++; }
  assert.equal(frames, 23);
  assert.equal(b.s.meta.lastSeen, now);
  assert.deepStrictEqual(snapshot(b.s), snapshot(a.s));
});

test('F25: the per-frame time budget stops the drain early but always runs at least one due tick', () => {
  const b = warmGame(3);
  let clockMs = 0;
  const clock = () => (clockMs += 1);                                     // every reading costs 1 ms
  const tick0 = b.s.meta.tick;
  b.advance(30, T0 + 50_000, { budgetMs: 5, clock });
  const ran = b.s.meta.tick - tick0;
  assert.ok(ran >= 1 && ran <= 5, 'ran ' + ran);
  const t1 = b.s.meta.tick;
  b.advance(0, T0 + 50_000, { budgetMs: 0.5, clock });                     // a budget smaller than one tick
  assert.equal(b.s.meta.tick - t1, 1);
});

test('F25: a backlog plus a new gap of ≥ 60 s goes to catchUp as one hidden-tab gap', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  const seen = [];
  g.bus.on('offlineDone', (e) => seen.push(e));
  g.advance(50, 50_000, { maxTicks: 10 });
  assert.ok(Math.abs(g.acc - 49) < 1e-6);
  rec.calls.length = 0;
  g.advance(15, 65_000, { maxTicks: 10 });
  assert.equal(seen.length, 1);
  assert.ok(Math.abs(seen[0].summary.seconds - 64) < 1e-6);
  assert.ok(rec.calls.filter((c) => c.opts.offline === true).every((c) => c.opts.eff === 1));
  assert.equal(g.acc, 0);
  assert.equal(g.s.meta.lastSeen, 65_000);
});

test('F25: a save during the drain keeps the undrained backlog, and the reload credits it', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage, stepFn: recorder().fn });
  g.newGame(0, 1);
  g.advance(45, 45_000, { maxTicks: 20 });
  g.save(45_000);
  assert.equal(g.s.meta.lastSeen, 45_000 - 43_000);
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, storage, stepFn: rec.fn });
  g2.loadOrNew(45_000);
  const online = rec.calls.filter((c) => c.opts.offline === false).length;
  assert.ok(online >= 429 && online <= 430, 'credited ' + online + ' ticks');
});
