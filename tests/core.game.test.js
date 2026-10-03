// WP1 unit tests: core/game.js (fixed-step loop with an injected stepFn, queue draining, catch-up routing, diapause,
// save/load/backups, import/export, hard reset, storage failures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { toExportString } from '../src/core/save.js';
import { TICK, SAVE, OFFLINE } from '../src/data/balance.js';
import { makeFakeStorage, snapshot } from './helpers.js';
import { deriveSeed, makeHolder } from '../src/core/rng.js';

/** A fake stepFn that records calls and advances only the time fields (like the real step). */
function recorder(eventsFor = () => []) {
  const calls = [];
  const fn = (s, d, dt, cmds, opts) => {
    calls.push({ dt, cmds, opts });
    s.meta.tick++;
    s.meta.simTime += dt;
    if (!s.meta.pending) s.run.time += dt;
    return eventsFor(calls.length, dt, opts);
  };
  return { fn, calls };
}

/** Collect every bus event by type. */
function listen(game) {
  const seen = [];
  game.bus.on('*', (e) => seen.push(e));
  return seen;
}

test('newGame: fresh state with createdAt/lastSeen, one zero-dt derive pass, publishes reset', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 5000, stepFn: rec.fn });
  const seen = listen(g);
  assert.equal(rec.calls.length, 0);
  g.queue.push({ type: 'x' });
  g.acc = 0.05;
  g.newGame(123456, 77);
  // ARCHITECTURE §8.6: prestige.newGame starts the first run with seed = deriveSeed(s), s.rng = the game seed.
  assert.equal(g.s.run.seed, deriveSeed(makeHolder(77)));
  assert.equal(g.s.meta.createdAt, 123456);
  assert.equal(g.s.meta.lastSeen, 123456);
  assert.deepEqual(rec.calls, [{ dt: 0, cmds: [], opts: {} }]);
  assert.deepEqual(g.queue, []);
  assert.equal(g.acc, 0);
  assert.deepEqual(seen.map((e) => e.type), ['reset']);
  g.newGame(2 ** 32 + 9);
  assert.equal(g.s.run.seed, deriveSeed(makeHolder(9))); // game seed defaults to nowMs >>> 0
});

test('advance runs floor(acc / TICK) ticks and carries the remainder', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  rec.calls.length = 0;
  g.advance(0.35, 350);
  assert.equal(rec.calls.length, 3);
  assert.ok(rec.calls.every((c) => c.dt === TICK && c.opts.offline === false && c.opts.eff === 1 && c.opts.econScale === 1));
  assert.ok(Math.abs(g.acc - 0.05) < 1e-9);
  assert.equal(g.s.meta.lastSeen, 350);
  g.advance(0.06, 410);
  assert.equal(rec.calls.length, 4);
  assert.ok(Math.abs(g.acc - 0.01) < 1e-9);
  g.advance(0, 420);
  g.advance(NaN, 430);
  g.advance(-3, 440);
  g.advance(undefined, 450);
  assert.equal(rec.calls.length, 4);
  g.advance(1 / 60, 460);
  g.advance(1 / 60, 470);
  assert.equal(rec.calls.length, 4); // 0.01 + 2/60 < 0.1
  g.advance(59.9, 60000);
  assert.ok(rec.calls.length >= 4 + 599 && rec.calls.length <= 4 + 600);
  assert.ok(g.acc >= 0 && g.acc <= TICK);
});

test('advance caps a frame at LOOP.maxTicksPerFrame and never banks more than one tick', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  rec.calls.length = 0;
  g.acc = 0.099;
  g.advance(59.999, 1);
  assert.equal(rec.calls.length, 600);
  assert.ok(g.acc <= TICK + 1e-12);
});

test('advance drains the queue into the first tick only', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  rec.calls.length = 0;
  assert.equal(g.actions.setSetting({ key: 'sound', value: true }).ok, true);
  assert.equal(g.dispatch({ type: 'setSetting', key: 'notation', value: 'scientific' }).ok, true);
  assert.deepEqual(g.dispatch({ type: 'nope' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(g.dispatch(null), { ok: false, reason: 'invalid' });
  assert.equal(g.queue.length, 2);
  g.advance(0.3, 300);
  assert.equal(rec.calls.length, 3);
  assert.deepEqual(rec.calls[0].cmds.map((c) => c.type), ['setSetting', 'setSetting']);
  assert.deepEqual(rec.calls[1].cmds, []);
  assert.deepEqual(rec.calls[2].cmds, []);
  assert.deepEqual(g.queue, []);
});

test('advance routes gaps ≥ 60 s to catchUp (hidden: 100 % efficiency); welcome only for ≥ 300 s', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  const seen = listen(g);
  rec.calls.length = 0;
  g.advance(120, 120000);
  const online = rec.calls.filter((c) => c.opts.offline === false);
  const offline = rec.calls.filter((c) => c.opts.offline === true);
  assert.equal(online.length, 0);
  assert.equal(offline.length, 12);
  assert.ok(offline.every((c) => c.opts.eff === 1 && c.cmds.length === 0));
  assert.equal(offline.reduce((a, c) => a + c.dt, 0), 120);
  assert.deepEqual(rec.calls[rec.calls.length - 1], { dt: 0, cmds: [], opts: {} }); // derive pass after the rebuild
  assert.deepEqual(seen.map((e) => e.type), ['offlineDone']);
  assert.equal(seen[0].summary.seconds, 120);
  assert.equal(g.s.meta.lastSeen, 120000);
  assert.equal(g.acc, 0);
  g.advance(60, 180000);
  assert.equal(seen.filter((e) => e.type === 'offlineDone').length, 2);
  g.advance(400, 580000);
  const welcome = seen.filter((e) => e.type === 'welcome');
  assert.equal(welcome.length, 1);
  assert.equal(welcome[0].summary.seconds, 400);
  assert.equal(welcome[0].summary.eff, 1);
});

test('catchUp: hidden full time, then offline at the capped efficiency, the rest banked; d rebuilt', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  rec.calls.length = 0;
  const dBefore = g.d;
  const sum = g.catchUp(20000, 20000000, { hidden: false });
  const effs = rec.calls.filter((c) => c.opts.offline).map((c) => c.opts.eff);
  assert.ok(effs.every((e) => e === OFFLINE.baseEff));
  assert.equal(rec.calls.filter((c) => c.opts.offline).reduce((a, c) => a + c.dt, 0), OFFLINE.baseCapSec);
  assert.equal(sum.seconds, 20000);
  assert.equal(sum.eff, 0.5);
  assert.equal(sum.diapause, (20000 - 14400) * 0.1);
  assert.equal(g.s.meta.diapause.bank, 560);
  assert.equal(sum.savedFinds, 2);
  assert.equal(g.s.meta.savedFinds, 2);
  assert.notEqual(g.d, dBefore);
  assert.equal(g.d.offlineLog, null);
  // hidden: first 4 h at 100 %, then up to the cap at 50 %
  rec.calls.length = 0;
  g.catchUp(30000, 1, { hidden: true });
  const off = rec.calls.filter((c) => c.opts.offline);
  const full = off.filter((c) => c.opts.eff === 1).reduce((a, c) => a + c.dt, 0);
  const half = off.filter((c) => c.opts.eff === 0.5).reduce((a, c) => a + c.dt, 0);
  assert.equal(full, 14400);
  assert.equal(half, 14400); // the remaining 15,600 s are capped at the 4 h offline cap; 1,200 s are banked
  assert.equal(g.s.meta.diapause.bank, 560 + 120);
});

test('catchUp publishes only milestone events from the offline run, then offlineDone', () => {
  const types = ['achievement', 'unlock', 'hatched', 'cellDug', 'fieldGuide', 'chamberActivated', 'researchBought', 'eggLaid'];
  const rec = recorder((n) => [{ type: types[n % types.length], n }]);
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  const seen = listen(g);
  g.catchUp(600, 600000, { hidden: true });
  const published = new Set(seen.map((e) => e.type));
  for (const t of ['hatched', 'cellDug', 'eggLaid']) assert.equal(published.has(t), false, t);
  for (const t of ['achievement', 'unlock', 'fieldGuide', 'chamberActivated', 'researchBought']) assert.equal(published.has(t), true, t);
  assert.equal(seen[seen.length - 1].type, 'offlineDone');
});

test('diapause: econScale 2 (3 with diapause_mastery) while active with bank; the bank drains and switches off', () => {
  const rec = recorder();
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  rec.calls.length = 0;
  g.s.meta.diapause.active = true;
  g.s.meta.diapause.bank = 10;
  g.advance(0.5, 500);
  assert.ok(rec.calls.every((c) => c.opts.econScale === 2));
  assert.ok(Math.abs(g.s.meta.diapause.bank - 9.5) < 1e-9);
  g.s.era.federation.diapause_mastery = 1;
  rec.calls.length = 0;
  g.advance(0.2, 700);
  assert.ok(rec.calls.every((c) => c.opts.econScale === 3));
  assert.ok(Math.abs(g.s.meta.diapause.bank - 9.1) < 1e-9);
  g.s.meta.diapause.bank = 0.05;
  g.advance(0.1, 800);
  assert.equal(g.s.meta.diapause.bank, 0);
  assert.equal(g.s.meta.diapause.active, false);
  rec.calls.length = 0;
  g.advance(0.1, 900);
  assert.equal(rec.calls[0].opts.econScale, 1);
});

test('tickOnce publishes step events on the bus and returns them; runFor calls onTick', () => {
  const rec = recorder(() => [{ type: 'hatched', caste: 'minor', n: 1 }]);
  const g = createGame({ nowMs: 0, stepFn: rec.fn });
  g.newGame(0, 1);
  const got = [];
  g.bus.on('hatched', (e) => got.push(e));
  const ev = g.tickOnce();
  assert.deepEqual(ev, [{ type: 'hatched', caste: 'minor', n: 1 }]);
  assert.equal(got.length, 1);
  let ticks = 0;
  g.runFor(2, { onTick: (events, i, game) => { ticks++; assert.equal(game, g); assert.equal(events.length, 1); } });
  assert.equal(ticks, 20);
  g.runFor(3, { dt: 1 });
  assert.equal(got.length, 1 + 20 + 3);
  assert.equal(rec.calls[rec.calls.length - 1].dt, 1);
});

test('save writes the export string, rotates backups every 5 min of wall time, publishes saved', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage });
  g.newGame(0, 3);
  const seen = listen(g);
  const t0 = 1_000_000;
  assert.deepEqual(g.save(t0), { ok: true, error: null });
  assert.equal(g.s.meta.savedAt, t0);
  assert.ok(storage.map.get(SAVE.key).startsWith('SLD1:'));
  assert.equal(storage.map.get('sld_save_bak_0'), storage.map.get(SAVE.key));
  g.s.run.res.food = 50;
  g.save(t0 + 1000);
  assert.notEqual(storage.map.get('sld_save_bak_0'), storage.map.get(SAVE.key)); // no rotation yet
  const firstBackup = storage.map.get('sld_save_bak_0');
  g.save(t0 + 301_000);
  assert.equal(storage.map.get('sld_save_bak_1'), firstBackup);
  assert.equal(storage.map.get('sld_save_bak_0'), storage.map.get(SAVE.key));
  g.save(t0 + 602_000);
  assert.equal(storage.map.get('sld_save_bak_2'), firstBackup);
  assert.equal(seen.filter((e) => e.type === 'saved').length, 4);
  assert.equal(g.storageOk, true);
});

test('storage failure: save returns ok false, storageOk false, storageError published', () => {
  const storage = makeFakeStorage({}, new Set(['set']));
  const g = createGame({ nowMs: 0, storage });
  g.newGame(0, 1);
  const seen = listen(g);
  const orig = console.error;
  console.error = () => {};
  let r;
  try { r = g.save(1); } finally { console.error = orig; }
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(g.storageOk, false);
  assert.deepEqual(seen.map((e) => e.type), ['storageError']);
  const g2 = createGame({ nowMs: 0, storage: null });
  g2.newGame(0, 1);
  assert.equal(g2.save(1).ok, false);
  assert.equal(g2.storageOk, false);
});

test('loadOrNew: no save → new game; a save loads, credits a < 60 s gap as online ticks', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage });
  assert.deepEqual(g.loadOrNew(1000), { loaded: false, error: null, welcome: null });
  g.s.run.res.food = 42;
  g.s.meta.settings.colonyName = 'Loaded';
  g.save(10_000);
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, storage, stepFn: rec.fn });
  const r = g2.loadOrNew(10_000 + 25_000);
  assert.deepEqual(r, { loaded: true, error: null, welcome: null });
  assert.equal(g2.s.run.res.food, 42);
  assert.equal(g2.s.meta.settings.colonyName, 'Loaded');
  assert.deepEqual(rec.calls[0], { dt: 0, cmds: [], opts: {} });
  const online = rec.calls.filter((c) => c.opts.offline === false);
  assert.ok(online.length >= 249 && online.length <= 250);
  assert.equal(g2.s.meta.lastSeen, 35_000);
});

test('loadOrNew: long gap → catchUp; welcome returned only for gaps ≥ 300 s', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage });
  g.newGame(0, 1);
  g.save(0);
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, storage, stepFn: rec.fn });
  const r = g2.loadOrNew(120_000);
  assert.equal(r.loaded, true);
  assert.equal(r.welcome, null);
  assert.ok(rec.calls.some((c) => c.opts.offline === true));
  const g3 = createGame({ nowMs: 0, storage, stepFn: recorder().fn });
  const r3 = g3.loadOrNew(3_600_000);
  assert.equal(r3.welcome.seconds, 3600);
  assert.equal(r3.welcome.eff, 0.5);
  assert.equal(g3.s.meta.lastSeen, 3_600_000);
});

test('loadOrNew: backward clock sets clockSkew and credits nothing', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage });
  g.newGame(0, 1);
  g.save(500_000);
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, storage, stepFn: rec.fn });
  const r = g2.loadOrNew(100_000);
  assert.equal(r.loaded, true);
  assert.equal(g2.s.meta.flags.clockSkew, true);
  assert.equal(rec.calls.length, 1); // only the derive pass
  assert.equal(g2.s.meta.lastSeen, 100_000);
});

test('loadOrNew: corrupt main save falls back to a backup and keeps the corrupt string', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage });
  g.newGame(0, 11);
  g.s.run.res.food = 99;
  g.save(1000);
  const good = storage.map.get(SAVE.key);
  storage.map.set(SAVE.key, good.slice(0, -3) + 'zzz');
  const g2 = createGame({ nowMs: 0, storage });
  const r = g2.loadOrNew(1000); // zero gap: no online ticks replayed (a 1 s gap would lay the 0:00 egg)
  assert.equal(r.loaded, true);
  assert.equal(r.restoredFrom, 'sld_save_bak_0');
  assert.equal(r.error, 'badChecksum');
  assert.equal(g2.s.run.res.food, 99);
  assert.ok(storage.map.get('sld_save_corrupt').endsWith('zzz'));
});

test('loadOrNew: every save corrupt → new game, error returned', () => {
  const storage = makeFakeStorage({ [SAVE.key]: 'garbage', sld_save_bak_0: 'SLD1:also:bad' });
  const g = createGame({ nowMs: 0, storage });
  const seen = listen(g);
  const r = g.loadOrNew(5000);
  assert.deepEqual(r, { loaded: false, error: 'badPrefix', welcome: null });
  assert.equal(storage.map.get('sld_save_corrupt'), 'garbage');
  assert.equal(g.s.meta.createdAt, 5000);
  assert.ok(seen.some((e) => e.type === 'reset'));
});

test('exportString / importString: round trip, no offline credit, failure leaves the state untouched', () => {
  const g = createGame({ nowMs: 0 });
  g.newGame(0, 21);
  g.runFor(1);
  g.s.run.res.food = 64;
  const str = g.exportString(10_000);
  const snap = snapshot(g.s);
  const rec = recorder();
  const g2 = createGame({ nowMs: 0, stepFn: rec.fn });
  g2.newGame(0, 1);
  const seen = listen(g2);
  g2.queue.push({ type: 'setSetting', key: 'sound', value: true });
  g2.acc = 0.07;
  rec.calls.length = 0;
  assert.deepEqual(g2.importString(str, 9_999_999), { ok: true, error: null });
  assert.equal(g2.s.meta.lastSeen, 9_999_999);
  assert.equal(rec.calls.length, 1); // only the derive pass: no offline credit
  assert.deepEqual(g2.queue, []);
  assert.equal(g2.acc, 0);
  assert.ok(seen.some((e) => e.type === 'imported'));
  const expected = { ...snap, meta: { ...snap.meta, lastSeen: 9_999_999, tick: snap.meta.tick + 1 } };
  assert.deepStrictEqual(g2.s, expected);
  const before = snapshot(g2.s);
  assert.deepEqual(g2.importString('SLD1:nope', 1), { ok: false, error: 'badChecksum' });
  assert.deepStrictEqual(g2.s, before);
  assert.equal(toExportString(g.s, 10_000), str);
});

test('hardReset removes the save and backups, then starts a new game', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage });
  g.newGame(0, 1);
  g.s.run.res.food = 77;
  g.save(1000);
  const seen = listen(g);
  g.hardReset(50_000);
  assert.equal(storage.map.has(SAVE.key), false);
  for (const k of SAVE.backups) assert.equal(storage.map.has(k), false);
  assert.equal(g.s.run.res.food, 5);
  assert.equal(g.s.meta.createdAt, 50_000);
  assert.deepEqual(seen.map((e) => e.type), ['reset']);
});

test('the game object exposes the contract API', () => {
  const g = createGame({ nowMs: 0 });
  for (const k of ['s', 'd', 'bus', 'actions', 'queue', 'acc', 'storageOk', 'hooks']) assert.ok(k in g, k);
  assert.deepEqual(g.hooks, { beforePrestige: null });
  for (const k of ['newGame', 'loadOrNew', 'advance', 'catchUp', 'dispatch', 'tickOnce', 'runFor', 'save', 'exportString', 'importString', 'hardReset']) {
    assert.equal(typeof g[k], 'function', k);
  }
  assert.equal(typeof g.actions.do, 'function');
  assert.equal(typeof g.actions.uiFlag, 'function');
});
