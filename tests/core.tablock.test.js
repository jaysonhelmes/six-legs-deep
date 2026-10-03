// Regression tests for finding F5 (two tabs overwrote each other's save): the save generation in core/game.js and the
// single-writer tab lock in core/tablock.js (ARCHITECTURE §7.1, §7.16, §18 C80).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { createTabLock } from '../src/core/tablock.js';
import { fromExportString } from '../src/core/save.js';
import { SAVE, TABS } from '../src/data/balance.js';
import { makeFakeStorage } from './helpers.js';

const T0 = 1_700_000_000_000;

/** Decode the main save in a fake storage. */
function stored(storage) {
  const r = fromExportString(storage.map.get(SAVE.key));
  assert.equal(r.ok, true);
  return r.state;
}

// ---- save generation (core/game.js) --------------------------------------------------------------------------

test('F5: a stale tab never overwrites a newer save (a Flight in tab B survives tab A\'s autosave)', () => {
  const storage = makeFakeStorage();
  const first = createGame({ nowMs: T0, storage });
  first.loadOrNew(T0);
  first.save(T0);
  const a = createGame({ nowMs: T0, storage });
  a.loadOrNew(T0 + 1000);
  const b = createGame({ nowMs: T0, storage });
  b.loadOrNew(T0 + 2000);
  const staleSeen = [];
  a.bus.on('saveStale', (e) => staleSeen.push(e));
  b.s.meta.flights = 1;                                        // the prestige done in tab B
  b.s.meta.settings.colonyName = 'Flown';
  assert.equal(b.save(T0 + 3000).ok, true);
  const backups = SAVE.backups.map((k) => storage.map.get(k));
  assert.deepEqual(a.save(T0 + 16_000), { ok: false, error: 'stale' });   // tab A's next autosave
  assert.equal(a.stale, true);
  assert.equal(a.storageOk, true, 'no "Saving unavailable" banner for a stale tab');
  assert.equal(staleSeen.length, 1);
  assert.deepEqual(a.save(T0 + 31_000), { ok: false, error: 'stale' });   // stays stale, published once
  assert.equal(staleSeen.length, 1);
  assert.equal(stored(storage).meta.flights, 1);
  assert.equal(stored(storage).meta.settings.colonyName, 'Flown');
  assert.deepEqual(SAVE.backups.map((k) => storage.map.get(k)), backups, 'the backups are untouched too');
  const reopened = createGame({ nowMs: T0, storage });
  reopened.loadOrNew(T0 + 40_000);
  assert.equal(reopened.s.meta.flights, 1);
  assert.equal(reopened.save(T0 + 41_000).ok, true, 'a fresh load may save again');
});

test('F5: legacy saves without a generation load and save; the generation starts at 1 and counts writes', () => {
  const storage = makeFakeStorage();
  const old = createGame({ nowMs: T0, storage });
  old.newGame(T0, 4);
  old.save(T0);
  storage.map.delete(TABS.genKey);                              // a save written before the generation existed
  const g = createGame({ nowMs: T0, storage });
  g.loadOrNew(T0 + 1000);
  assert.equal(g.saveGen, 0);
  assert.equal(g.save(T0 + 2000).ok, true);
  assert.equal(storage.map.get(TABS.genKey), '1');
  g.save(T0 + 3000);
  assert.equal(storage.map.get(TABS.genKey), '2');
  assert.equal(g.saveGen, 2);
});

test('F5: a cleared generation (site data wiped while open) does not lock the tab out; an unreadable one degrades', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: T0, storage });
  g.loadOrNew(T0);
  g.save(T0 + 1000);
  g.save(T0 + 2000);
  storage.map.clear();
  assert.equal(g.save(T0 + 3000).ok, true);
  assert.equal(storage.map.get(TABS.genKey), '3');
  const flaky = makeFakeStorage();
  const h = createGame({ nowMs: T0, storage: flaky });
  h.loadOrNew(T0);
  flaky.map.set(TABS.genKey, '99');
  flaky.failOn.add('get');                                       // reads throw: the guard is skipped, writes still work
  assert.equal(h.save(T0 + 1000).ok, true);
});

test('F5: a hard reset in one tab turns the other tab stale instead of resurrecting the abandoned colony', () => {
  const storage = makeFakeStorage();
  const a = createGame({ nowMs: T0, storage });
  a.loadOrNew(T0);
  a.s.run.res.food = 77;
  a.save(T0 + 1000);
  const b = createGame({ nowMs: T0, storage });
  b.loadOrNew(T0 + 2000);
  b.hardReset(T0 + 3000);
  assert.equal(storage.map.has(SAVE.key), false);
  assert.equal(a.save(T0 + 4000).error, 'stale');
  assert.equal(storage.map.has(SAVE.key), false);
  assert.equal(b.save(T0 + 5000).ok, true);
  assert.notEqual(stored(storage).run.res.food, 77);
});

// ---- tab lock protocol (core/tablock.js) -----------------------------------------------------------------------

/**
 * A fake browser: one shared localStorage with cross-tab 'storage' events, an optional BroadcastChannel hub, a manual
 * clock with timers. Deliveries are queued (both are asynchronous in browsers) and run by flush() / run(ms).
 */
function makeWorld({ bc = true, storageOk = true } = {}) {
  const map = new Map();
  const tabs = [];
  const queue = [];
  let clock = T0;
  let timers = [];
  let nextTimer = 1;
  const world = {
    map, tabs,
    get now() { return clock; },
    flush() {
      for (let guard = 0; queue.length && guard < 10_000; guard++) queue.shift()();
    },
    /** Advance the clock by ms, firing due timers in order and delivering messages in between. */
    run(ms) {
      const end = clock + ms;
      world.flush();
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((x, y) => x.at - y.at || x.n - y.n)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock = Math.max(clock, due.at);
        due.fn();
        world.flush();
      }
      clock = end;
    },
    tab(id, { onYield = () => null } = {}) {
      const listeners = [];
      const storage = storageOk ? {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem(k, v) {
          const val = String(v);
          const changed = map.get(k) !== val;
          map.set(k, val);
          if (changed) for (const t of tabs) if (t !== tab) queue.push(() => t.fire(k, val));
        },
        removeItem(k) {
          const had = map.has(k);
          map.delete(k);
          if (had) for (const t of tabs) if (t !== tab) queue.push(() => t.fire(k, null));
        },
      } : { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() {} };
      const channel = bc ? {
        onmessage: null,
        postMessage(m) {
          const data = JSON.parse(JSON.stringify(m));
          for (const t of tabs) if (t !== tab && t.channel) queue.push(() => t.channel.onmessage && t.channel.onmessage({ data }));
        },
      } : null;
      const yields = [];
      const tab = {
        id, storage, channel, yields,
        fire(k, v) { for (const l of listeners) l(k, v); },
      };
      tab.lock = createTabLock({
        id, storage, channel,
        listenStorage: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
        now: () => clock,
        setTimer: (fn, ms) => { const t = { fn, at: clock + ms, n: nextTimer++ }; timers.push(t); return t; },
        clearTimer: (t) => { timers = timers.filter((x) => x !== t); },
        onYield: (info) => { yields.push({ ...info, at: clock }); return onYield(info); },
      });
      tabs.push(tab);
      return tab;
    },
  };
  return world;
}

/** Resolve a promise that settles once the fake world has run `ms`. */
async function settle(world, p, ms = 1000) {
  let out;
  let done = false;
  p.then((v) => { out = v; done = true; });
  for (let i = 0; i < 50 && !done; i++) {
    world.run(ms / 50);
    await null;
  }
  assert.equal(done, true, 'acquire() settled');
  return out;
}

test('F5 lock: a single tab acquires at once and keeps a heartbeat; release on pagehide drops only its own entry', async () => {
  const w = makeWorld();
  const a = w.tab('a');
  const res = await a.lock.acquire();
  assert.deepEqual(res, { waited: false, released: false });
  assert.equal(a.lock.owner, true);
  const e1 = JSON.parse(w.map.get(TABS.lockKey));
  assert.equal(e1.id, 'a');
  w.run(TABS.beatMs + 1);
  assert.ok(JSON.parse(w.map.get(TABS.lockKey)).beat > e1.beat, 'heartbeat refreshed');
  assert.equal(a.lock.check(), true);
  a.lock.release();
  assert.equal(w.map.has(TABS.lockKey), false);
  assert.equal(a.lock.owner, false);
  a.lock.destroy();
});

test('F5 lock: a newer tab takes over; the live owner flushes inside the window, answers with its generation, pauses', async () => {
  const w = makeWorld();
  let gen = 6;
  const a = w.tab('a', { onYield: ({ flush }) => (flush ? (w.map.set(TABS.genKey, String(++gen)), gen) : null) });
  await a.lock.acquire();
  w.run(2000);
  const b = w.tab('b');
  const res = await settle(w, b.lock.acquire());
  assert.deepEqual(res, { waited: true, released: true });
  assert.equal(b.lock.owner, true);
  assert.equal(a.lock.owner, false);
  assert.equal(a.yields.length, 1);
  assert.equal(a.yields[0].flush, true);
  assert.equal(a.yields[0].by, 'b');
  assert.equal(w.map.get(TABS.genKey), '7', 'tab B boots only after the flushed save is visible');
  assert.equal(JSON.parse(w.map.get(TABS.lockKey)).id, 'b');
  assert.equal(a.lock.check(), false, 'the old tab no longer may save');
  w.run(3 * TABS.beatMs);
  assert.equal(JSON.parse(w.map.get(TABS.lockKey)).id, 'b', 'the paused tab stops its heartbeat');
  assert.equal(a.yields.length, 1);
  a.lock.destroy();
  b.lock.destroy();
});

test('F5 lock: without BroadcastChannel the claim and the answer travel by storage events', async () => {
  const w = makeWorld({ bc: false });
  const a = w.tab('a', { onYield: ({ flush }) => (flush ? 1 : null) });
  await a.lock.acquire();
  w.map.set(TABS.genKey, '1');
  w.run(1000);
  const b = w.tab('b');
  const res = await settle(w, b.lock.acquire());
  assert.deepEqual(res, { waited: true, released: true });
  assert.equal(a.lock.owner, false);
  assert.equal(a.yields[0].flush, true);
  a.lock.destroy();
  b.lock.destroy();
});

test('F5 lock: a missed claim is noticed by check() before the next save; the old tab steps aside without writing', async () => {
  const w = makeWorld({ bc: false });
  const a = w.tab('a');
  await a.lock.acquire();
  w.run(1000);
  const b = w.tab('b');
  const p = b.lock.acquire();
  a.fire = () => {};                                             // tab A was frozen: it misses every event
  const res = await settle(w, p);
  assert.deepEqual(res, { waited: true, released: false }, 'tab B waited out the window, then booted');
  assert.equal(a.lock.owner, true, 'tab A does not know yet');
  assert.equal(a.lock.check(), false, 'its next autosave (or visibilitychange) checks the lock entry');
  assert.equal(a.yields.length, 1);
  assert.equal(a.yields[0].flush, false, 'past the window: it must not write over what tab B loaded');
  a.lock.destroy();
  b.lock.destroy();
});

test('F5 lock: two tabs that start together end with exactly one owner (the newest claim)', async () => {
  for (const bc of [true, false]) {
    const w = makeWorld({ bc });
    const a = w.tab('a');
    const b = w.tab('b');
    const pa = a.lock.acquire();
    const pb = b.lock.acquire();                                  // same clock reading: ties go to the larger id
    await settle(w, pa);
    await settle(w, pb);
    w.run(2 * TABS.beatMs);
    assert.deepEqual([a.lock.owner, b.lock.owner], [false, true], 'bc ' + bc);
    assert.equal(JSON.parse(w.map.get(TABS.lockKey)).id, 'b');
    a.lock.destroy();
    b.lock.destroy();
  }
});

test('F5 lock: a stale entry (no heartbeat for staleMs: closed or frozen tab) is taken over without waiting', async () => {
  const w = makeWorld();
  w.map.set(TABS.lockKey, JSON.stringify({ id: 'ghost', at: T0 - 5e5, beat: T0 - TABS.staleMs - 1, deadline: 0 }));
  const b = w.tab('b');
  const res = await b.lock.acquire();
  assert.deepEqual(res, { waited: false, released: false });
  assert.equal(b.lock.owner, true);
  assert.ok(JSON.parse(w.map.get(TABS.lockKey)).at > T0 - 5e5);
  b.lock.destroy();
});

test('F5 lock: a newer claim during the boot wait makes the waiting tab give up (it shows the overlay, never boots)', async () => {
  const w = makeWorld();
  const a = w.tab('a');
  await a.lock.acquire();
  w.run(500);
  const b = w.tab('b');
  const pb = b.lock.acquire();
  const c = w.tab('c');                                         // opened before tab A could answer tab B
  const pc = c.lock.acquire();
  const rb = await settle(w, pb);
  const rc = await settle(w, pc);
  assert.deepEqual(rb, { waited: true, released: false });
  assert.equal(b.lock.owner, false);
  assert.equal(b.yields.length, 1, 'main.js then shows the overlay instead of booting');
  assert.deepEqual(rc, { waited: true, released: true }, 'tab B answers tab C at once');
  assert.equal(c.lock.owner, true);
  assert.equal(a.lock.owner, false);
  assert.equal(a.yields.length, 1);
  for (const t of [a, b, c]) t.lock.destroy();
});

test('F5 lock: without readable storage the lock is disabled and the tab always owns the game', async () => {
  const w = makeWorld({ storageOk: false });
  const a = w.tab('a');
  assert.equal(a.lock.enabled, false);
  assert.deepEqual(await a.lock.acquire(), { waited: false, released: false });
  assert.equal(a.lock.owner, true);
  assert.equal(a.lock.check(), true);
  a.lock.release();
  assert.equal(a.lock.owner, true);
  const n = createTabLock({ id: 'n', storage: null, now: () => 0, setTimer: () => 0, clearTimer: () => {} });
  assert.equal(n.enabled, false);
  assert.equal(n.check(), true);
});
