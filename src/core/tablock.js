// Single-writer tab lock (ARCHITECTURE §7.16, §18 C80; finding F5): the newest tab of the game owns the save and every
// older tab steps aside (main.js pauses it behind a "Game open in another tab" overlay). Owner: WP1 (main.js wires it).
// Zero dependencies and no ambient effects (§1 rule 3): storage, the message channel, the storage-event listener, the
// clock and the timers are all injected, so the protocol runs in Node tests.
//
// Protocol. The lock entry TABS.lockKey = { id, at, beat, deadline } is the ground truth: `at` orders claims (a later
// claim wins; ties go to the larger id), `beat` is the owner's heartbeat (every TABS.beatMs), `deadline` closes the
// hand-over window. acquire() claims at once; when the entry shows another live owner (heartbeat younger than
// TABS.staleMs) it also waits up to TABS.handoverMs + settleMs for that owner to flush its save and answer
// 'released' (with the save generation it wrote), so the new tab loads the freshest save. Messages travel over a
// BroadcastChannel when there is one, otherwise over 'storage' events of TABS.msgKey; the lock entry's own storage
// events count as claims too. check() re-reads the entry (main.js calls it before every save and when the tab is
// shown again), so a missed message only delays the hand-over. An owner flushes only inside the claimer's window;
// later it steps aside without writing. The save generation in core/game.js is the last line of defence: a stale
// tab can never overwrite a newer save, even when every message is lost.
// Without readable storage the lock is disabled: acquire() resolves at once and the tab always owns the game.

import { TABS } from '../data/balance.js';

/**
 * @typedef {Object} TabLock
 * @property {string} id
 * @property {boolean} enabled  false without readable storage (the tab then always owns the game)
 * @property {boolean} owner    true while this tab may run and save the game
 * @property {() => Promise<{ waited: boolean, released: boolean }>} acquire  claim the game (once, at boot)
 * @property {() => boolean} check    true while this tab still owns the lock; steps aside when a newer tab holds it
 * @property {() => void} release     pagehide: drop this tab's lock entry (no-op unless owner)
 * @property {() => void} destroy     detach listeners and timers (tests)
 */

/**
 * Create the tab lock.
 * @param {{
 *   id: string,
 *   storage: (import('./types.js').StorageLike|null),
 *   channel?: ({ postMessage: (m: Object) => void, onmessage: (Function|null) }|null),
 *   listenStorage?: ((fn: (key: (string|null), newValue: (string|null)) => void) => (() => void))|null,
 *   now: () => number,
 *   setTimer: (fn: () => void, ms: number) => *,
 *   clearTimer: (handle: *) => void,
 *   onYield?: (info: { flush: boolean, by: string }) => (number|null|void),
 * }} opts  onYield runs when a newer tab takes over: flush the save when `flush` is true and return the save
 *          generation written (or null), then pause.
 * @returns {TabLock}
 */
export function createTabLock({ id, storage = null, channel = null, listenStorage = null, now, setTimer, clearTimer, onYield = () => null }) {
  const enabled = !!storage && readable(storage);
  let owner = !enabled;
  let myAt = 0;
  let deadline = 0;
  let beat = null;
  let pending = null;
  let unlisten = null;
  let listening = false;
  let seq = 0;

  /** True when the storage can be read at all. */
  function readable(st) {
    try {
      st.getItem(TABS.lockKey);
      return true;
    } catch {
      return false;
    }
  }

  /** Parse a JSON object, or null. */
  function parseObj(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  }

  /** A valid lock entry, or null. */
  function parseLock(raw) {
    const o = parseObj(raw);
    return o && typeof o.id === 'string' && o.id !== '' && Number.isFinite(o.at) ? o : null;
  }

  function readLock() {
    try {
      return parseLock(storage.getItem(TABS.lockKey));
    } catch {
      return null;
    }
  }

  function writeLock() {
    try {
      storage.setItem(TABS.lockKey, JSON.stringify({ id, at: myAt, beat: now(), deadline }));
    } catch {
      // storage full or gone: the save generation still guards the save
    }
  }

  function readGen() {
    try {
      const n = Number(storage.getItem(TABS.genKey));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  }

  /** True when a claim { id, at } is newer than this tab's own claim. */
  function newer(o) {
    return o.at > myAt || (o.at === myAt && String(o.id) > id);
  }

  function post(msg) {
    const m = { ...msg, from: id };
    if (channel) {
      try {
        channel.postMessage(m);
        return;
      } catch {
        // a closed channel: fall back to storage events
      }
    }
    try {
      storage.setItem(TABS.msgKey, JSON.stringify({ ...m, nonce: id + ':' + (++seq) }));
    } catch {
      // nothing else to try
    }
  }

  function stopBeat() {
    if (beat !== null) clearTimer(beat);
    beat = null;
  }

  function armBeat() {
    stopBeat();
    beat = setTimer(() => {
      beat = null;
      if (check()) {
        writeLock();
        armBeat();
      }
    }, TABS.beatMs);
  }

  /** A newer tab owns the game now: flush (only inside its hand-over window), pause, answer 'released'. */
  function stepAside(other) {
    if (!owner) return;
    owner = false;
    stopBeat();
    const flush = Number.isFinite(other.deadline) && now() < other.deadline;
    let gen = null;
    try {
      const g = onYield({ flush, by: String(other.id) });
      if (Number.isFinite(g)) gen = g;
    } catch {
      // main.js guards its own handler
    }
    post({ kind: 'released', to: other.id, gen });
    if (pending) finish(false);
  }

  function onMessage(m) {
    if (!m || m.from === id) return;
    if (m.kind === 'claim' && typeof m.from === 'string' && Number.isFinite(m.at)) {
      if (owner && newer({ id: m.from, at: m.at })) stepAside({ id: m.from, deadline: m.deadline });
    } else if (m.kind === 'released' && m.to === id && pending) {
      awaitGen(m.gen);
    }
  }

  function onStorage(key, value) {
    if (key === TABS.msgKey) onMessage(parseObj(value));
    else if (key === TABS.lockKey) {
      const o = parseLock(value);
      if (o && o.id !== id && owner && newer(o)) stepAside(o);
    }
  }

  function listen() {
    if (listening) return;
    listening = true;
    if (channel) channel.onmessage = (e) => onMessage(e && e.data);
    if (listenStorage) unlisten = listenStorage(onStorage);
  }

  function finish(released) {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimer(p.timer);
    if (p.poll !== null) clearTimer(p.poll);
    p.resolve({ waited: true, released });
  }

  /** The old owner answered: wait until its flushed save is visible here (cross-process storage may lag a little). */
  function awaitGen(gen) {
    const p = pending;
    if (!Number.isFinite(gen) || readGen() >= gen) {
      finish(true);
      return;
    }
    const poll = () => {
      if (pending !== p) return;
      p.poll = null;
      if (readGen() >= gen) finish(true);
      else p.poll = setTimer(poll, TABS.pollMs);
    };
    if (p.poll === null) p.poll = setTimer(poll, TABS.pollMs);
  }

  function acquire() {
    if (!enabled) return Promise.resolve({ waited: false, released: false });
    listen();
    const cur = readLock();
    const t = now();
    const other = cur && cur.id !== id ? cur : null;
    myAt = other ? Math.max(t, other.at + 1) : t;
    const live = !!other && t - (Number.isFinite(other.beat) ? other.beat : -Infinity) < TABS.staleMs;
    deadline = live ? t + TABS.handoverMs : t;
    owner = true;
    writeLock();
    post({ kind: 'claim', at: myAt, deadline });
    armBeat();
    if (!live) return Promise.resolve({ waited: false, released: false });
    return new Promise((resolve) => {
      pending = { resolve, poll: null, timer: null };
      pending.timer = setTimer(() => finish(false), TABS.handoverMs + TABS.settleMs);
    });
  }

  function check() {
    if (!enabled) return true;
    if (!owner) return false;
    const cur = readLock();
    if (cur && cur.id !== id && newer(cur)) {
      stepAside(cur);
      return false;
    }
    if (!cur || cur.id !== id) writeLock(); // lost (storage cleared) or overwritten by an older tab: re-assert
    return true;
  }

  function release() {
    if (!enabled) return;
    stopBeat();
    if (!owner) return;
    owner = false;
    const cur = readLock();
    if (cur && cur.id === id) {
      try {
        storage.removeItem(TABS.lockKey);
      } catch {
        // the heartbeat simply goes stale
      }
    }
  }

  function destroy() {
    stopBeat();
    if (pending) finish(false);
    if (unlisten) unlisten();
    unlisten = null;
    if (channel && listening) channel.onmessage = null;
    listening = false;
  }

  return {
    id,
    get enabled() { return enabled; },
    get owner() { return owner; },
    acquire,
    check,
    release,
    destroy,
  };
}
