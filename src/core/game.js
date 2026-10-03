// The game object: owns s/d, the command queue, the fixed-step accumulator, catch-up after gaps, save/load/import/export,
// hard reset, and bus publishing. Owner: WP1. Contract: ARCHITECTURE §7.1 (DESIGN §21 offline, §22 saving).
// Wall-clock time is always passed in (nowMs); storage is injected (null in tools/tests).
// ARCH-R: (1) createGame() starts on the createState() skeleton with a fresh d and runs NO step (so an injected stepFn
// sees only the calls the caller makes); newGame()/loadOrNew() perform the documented derive pass. (2) After load and
// import the zero-dt derive-pass events are published on the bus (newGame publishes only 'reset', as documented).
// (3) save() also sets meta.lastSeen = nowMs (minus an undrained backlog) unless { hidden: true } says the simulation
// is paused; then lastSeen stays at the wall time it reached and loadOrNew credits lastSeen → savedAt as hidden-tab
// time (§18 C78). (4) loadOrNew() adds restoredFrom (backup key) to its result when a backup was used; error then
// carries the main save's error code. (5) advance() takes an optional per-frame budget that leaves a backlog in acc
// for later frames (C79). (6) Every save bumps TABS.genKey; a game whose save generation is behind the stored one is
// stale and never writes again (C80).

import { TICK, OFFLINE, LOOP, SAVE, DIAPAUSE, TABS } from '../data/balance.js';
import { createState } from './state.js';
import { createDerived } from './derived.js';
import { step } from './step.js';
import { createBus } from './bus.js';
import { createActions } from './actions.js';
import { toExportString, fromExportString, storageWrap } from './save.js';
import { offlineCapEff, simulateOffline, mergeSummaries, skipSeasonTime, bankBeyondCap, bankSavedFinds } from './offline.js';
import * as prestige from '../systems/prestige.js';

/** Event types re-published from an offline catch-up (everything else from the offline run stays silent). */
const OFFLINE_PUBLISH = new Set(['achievement', 'unlock', 'fieldGuide', 'chamberActivated', 'researchBought']);
/** Storage key that keeps an unreadable save for the user. */
const CORRUPT_KEY = 'sld_save_corrupt';

/** Finite number or the fallback. */
function fin(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/** A stored save generation: a non-negative integer, 0 when absent or unreadable. */
function parseGen(raw) {
  const n = typeof raw === 'string' && raw !== '' ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Create a game. The initial state is the skeleton world (createState); call newGame() or loadOrNew() to start.
 * @param {{ nowMs?: number, storage?: import('./types.js').StorageLike|null, stepFn?: typeof step }} [opts]
 * @returns {import('./types.js').Game}
 */
export function createGame({ nowMs, storage = null, stepFn = step } = {}) {
  const now0 = fin(nowMs);
  const store = storageWrap(storage);
  let lastBackupAt = -Infinity;

  /** @type {import('./types.js').Game} */
  const game = {
    s: createState({ seed: now0 >>> 0 }),
    d: createDerived(),
    bus: createBus(),
    actions: null,
    queue: [],
    acc: 0,
    storageOk: true,
    saveGen: 0,
    stale: false,
    hooks: { beforePrestige: null },
    newGame,
    loadOrNew,
    advance,
    catchUp,
    dispatch,
    tickOnce,
    runFor,
    save,
    exportString,
    importString,
    hardReset,
  };
  game.s.meta.createdAt = now0;
  game.s.meta.lastSeen = now0;
  game.actions = createActions(game);

  /** Publish a list of step events on the bus. */
  function publish(events) {
    for (const e of events) game.bus.emit(e.type, e);
  }

  /** The stored save generation, or null when storage cannot be read (the generation guard is then skipped). */
  function storedGen() {
    const raw = store.get(TABS.genKey);
    if (raw === null && store.lastError !== null) return null;
    return parseGen(raw);
  }

  /** Seconds of an undrained backlog in the accumulator (only budgeted advance() calls leave more than one tick). */
  function backlogSec() {
    return game.acc > TICK + 1e-9 ? game.acc : 0;
  }

  /** Install a state (load/import/new): fresh derived cache, one zero-dt derive pass, empty queue and accumulator. */
  function install(state) {
    game.s = state;
    game.d = createDerived();
    game.queue = [];
    game.acc = 0;
    return stepFn(game.s, game.d, 0, [], {});
  }

  /**
   * Start a brand-new game: createState, prestige.newGame (first map and nest), a zero-dt derive pass, publish 'reset'.
   * @param {number} nowMs
   * @param {number} [seed] defaults to nowMs >>> 0
   */
  function newGame(nowMs, seed = undefined) {
    const now = fin(nowMs);
    const s = createState({ seed: seed ?? (now >>> 0) });
    s.meta.createdAt = now;
    s.meta.lastSeen = now;
    game.s = s;
    game.d = createDerived();
    game.queue = [];
    game.acc = 0;
    prestige.newGame(game.s, game.d);
    stepFn(game.s, game.d, 0, [], {});
    game.bus.emit('reset', { type: 'reset' });
  }

  /**
   * Load the local save (falling back to the backups) or start a new game; then credit the time since lastSeen
   * (< 60 s as online ticks, otherwise an offline catch-up whose first savedAt − lastSeen seconds were spent in a
   * hidden tab, C78). welcome is returned only for gaps ≥ LOOP.welcomeMinSec. clockSkew is set when the clock went
   * backwards and cleared otherwise (F6).
   * @param {number} nowMs
   * @returns {{ loaded: boolean, error: (string|null), welcome: (import('./types.js').OfflineSummary|null), restoredFrom?: string }}
   */
  function loadOrNew(nowMs) {
    const now = fin(nowMs);
    // The generation is read before the save: a write landing in between (save first, then generation) can only make
    // this game look stale, never let it overwrite a newer save.
    game.saveGen = storedGen() ?? 0;
    game.stale = false;
    const main = store.get(SAVE.key);
    if (store.lastError && store.lastError !== 'noStorage') game.storageOk = false;
    if (main === null) {
      newGame(now);
      return { loaded: false, error: null, welcome: null };
    }
    let res = fromExportString(main);
    let restoredFrom = null;
    const primaryError = res.ok ? null : res.error;
    if (!res.ok) {
      store.set(CORRUPT_KEY, main);
      for (const key of SAVE.backups) {
        const b = store.get(key);
        if (b === null) continue;
        const r = fromExportString(b);
        if (r.ok) {
          res = r;
          restoredFrom = key;
          break;
        }
      }
    }
    if (!res.ok) {
      newGame(now);
      return { loaded: false, error: primaryError, welcome: null };
    }
    publish(install(res.state));
    const s = game.s;
    const lastSeen = fin(s.meta.lastSeen);
    let gap = (now - lastSeen) / 1000;
    if (!Number.isFinite(gap)) gap = 0;
    s.meta.flags.clockSkew = gap < 0; // one-shot: a later load with a sane clock clears the notice (F6)
    if (gap < 0) gap = 0;
    // A save made while the simulation was paused in a hidden tab keeps lastSeen at the hide time and stamps savedAt
    // with the time the tab was last known alive; that span is hidden-tab time (DESIGN §21.1), the rest is offline.
    const hiddenSec = Math.min(gap, Math.max(0, (fin(s.meta.savedAt) - lastSeen) / 1000));
    let welcome = null;
    if (gap < OFFLINE.onlineGapSec) {
      game.acc += gap;
      const n = Math.min(Math.floor(game.acc / TICK + 1e-9), LOOP.maxTicksPerFrame);
      for (let i = 0; i < n; i++) tickOnce(TICK);
      game.acc = Math.min(Math.max(0, game.acc - n * TICK), TICK);
    } else {
      const sum = catchUp(gap, now, { hidden: false, hiddenSec });
      if (gap >= LOOP.welcomeMinSec) welcome = sum;
    }
    game.s.meta.lastSeen = now;
    const out = { loaded: true, error: null, welcome };
    if (restoredFrom) {
      out.restoredFrom = restoredFrom;
      out.error = primaryError;
    }
    return out;
  }

  /**
   * Per-frame entry point: runs floor(acc / TICK) fixed ticks (≤ LOOP.maxTicksPerFrame), keeps at most one tick in
   * the accumulator, applies the diapause speed-up, and routes gaps ≥ OFFLINE.onlineGapSec to catchUp (hidden).
   * With a frame budget (opts.maxTicks and/or opts.budgetMs + opts.clock, C79) the frame stops early (always after at
   * least one due tick) and the undrained time stays in acc as a backlog for the next frames: the same ticks run, only
   * spread out. lastSeen then trails nowMs by the backlog; a backlog plus a new gap of ≥ onlineGapSec is caught up.
   * @param {number} realDtSec
   * @param {number} nowMs
   * @param {{ maxTicks?: number, budgetMs?: number, clock?: () => number }} [opts]
   */
  function advance(realDtSec, nowMs, opts = {}) {
    let realDt = realDtSec;
    if (!(realDt >= 0) || !Number.isFinite(realDt)) realDt = 0; // NaN, a backward clock or garbage gives no time
    const o = opts || {};
    const maxTicks = Number.isFinite(o.maxTicks) && o.maxTicks >= 1 ? Math.floor(o.maxTicks) : Infinity;
    const clock = typeof o.clock === 'function' && o.budgetMs > 0 ? o.clock : null;
    const budgeted = maxTicks !== Infinity || clock !== null;
    const s = game.s;
    const gap = realDt + backlogSec(); // the backlog is 0 unless an earlier budgeted frame left one
    if (gap >= OFFLINE.onlineGapSec) {
      if (Number.isFinite(nowMs)) s.meta.lastSeen = nowMs;
      const sum = catchUp(gap, nowMs, { hidden: true });
      if (gap >= LOOP.welcomeMinSec) game.bus.emit('welcome', { type: 'welcome', summary: sum });
      return;
    }
    game.acc += realDt;
    const due = Math.floor(game.acc / TICK + 1e-9);
    const cap = Math.min(due, LOOP.maxTicksPerFrame, maxTicks);
    // A save from inside a tick (the beforePrestige hook) must not count the not-yet-simulated backlog as seen.
    const stamp = () => {
      if (Number.isFinite(nowMs)) game.s.meta.lastSeen = nowMs - Math.round(backlogSec() * 1000);
    };
    stamp();
    const dp = game.s.meta.diapause;
    const mastery = (game.s.era.federation.diapause_mastery || 0) > 0;
    const econScale = dp.active && dp.bank > 0 ? (mastery ? DIAPAUSE.speedMastery : DIAPAUSE.speed) : 1;
    const t0 = clock ? clock() : 0;
    let n = 0;
    while (n < cap) {
      game.acc -= TICK;
      n++;
      tickOnce(TICK, { econScale });
      if (clock && clock() - t0 >= o.budgetMs) break;
    }
    if (game.acc < 1e-9) game.acc = 0;
    if (!budgeted && game.acc > TICK) game.acc = TICK; // unbudgeted: never bank more than one tick
    stamp(); // the state object may have been replaced by a prestige during the ticks
    if (econScale > 1 && n > 0) {
      const dp2 = game.s.meta.diapause; // the state object may have been replaced by a prestige during the ticks
      dp2.bank -= n * TICK * (econScale - 1);
      if (dp2.bank <= 0) {
        dp2.bank = 0;
        dp2.active = false;
      }
    }
  }

  /**
   * Credit a long gap: hidden-tab time at 100 % (up to OFFLINE.hiddenFullSec), the rest at the offline efficiency up
   * to the offline cap; time beyond the cap advances only the season clock and is banked as diapause; Saved Finds are
   * banked. Rebuilds d, publishes the milestone events of the offline run, then 'offlineDone'.
   * hidden: true counts the whole gap as hidden-tab time; hiddenSec counts only its first hiddenSec seconds (a reload
   * after a hidden tab was closed, C78).
   * @param {number} gapSec
   * @param {number} nowMs
   * @param {{ hidden?: boolean, hiddenSec?: number }} [opts]
   * @returns {import('./types.js').OfflineSummary}
   */
  function catchUp(gapSec, nowMs, { hidden = false, hiddenSec = undefined } = {}) {
    const gap = gapSec > 0 && Number.isFinite(gapSec) ? gapSec : 0;
    const collected = [];
    const wrapped = (s, d, dt, cmds, opts) => {
      const ev = stepFn(s, d, dt, cmds, opts);
      if (ev) for (const e of ev) if (OFFLINE_PUBLISH.has(e.type)) collected.push(e);
      return ev;
    };
    const hiddenPart = Number.isFinite(hiddenSec) ? Math.max(0, hiddenSec) : hidden ? gap : 0;
    const full = Math.min(gap, hiddenPart, OFFLINE.hiddenFullSec);
    const rest = gap - full;
    const { capSec, eff } = offlineCapEff(game.s, game.d);
    const offSec = Math.min(rest, capSec);
    const beyond = rest - offSec;
    const a = simulateOffline(game.s, game.d, full, { eff: 1, stepFn: wrapped });
    const b = simulateOffline(game.s, game.d, offSec, { eff, stepFn: wrapped });
    const summary = mergeSummaries(a, b);
    summary.seconds = gap;
    summary.seasons += skipSeasonTime(game.s, beyond);
    summary.diapause = bankBeyondCap(game.s, beyond);
    bankSavedFinds(game.s, gap);
    summary.savedFinds = game.s.meta.savedFinds;
    game.d = createDerived();
    wrapped(game.s, game.d, 0, [], {}); // rebuild caches
    game.acc = 0;
    if (Number.isFinite(nowMs)) game.s.meta.lastSeen = nowMs;
    publish(collected);
    game.bus.emit('offlineDone', { type: 'offlineDone', summary });
    return summary;
  }

  /**
   * Same as actions.do(cmd.type, cmd).
   * @param {import('./types.js').Command} cmd
   * @returns {import('./types.js').ActionResult}
   */
  function dispatch(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return { ok: false, reason: 'invalid' };
    return game.actions.do(cmd.type, cmd);
  }

  /**
   * One step with every queued command (applied at the start of this tick); publishes and returns the events.
   * @param {number} [dt=TICK]
   * @param {{ econScale?: number }} [opts]
   * @returns {import('./types.js').GameEvent[]}
   */
  function tickOnce(dt = TICK, opts = {}) {
    const cmds = game.queue.splice(0);
    const events = stepFn(game.s, game.d, dt, cmds, { offline: false, eff: 1, econScale: opts.econScale ?? 1 }) || [];
    publish(events);
    return events;
  }

  /**
   * Run `seconds` of simulation in steps of dt (tools/tests); onTick(events, index, game) after each step.
   * @param {number} seconds
   * @param {{ dt?: number, onTick?: (events: import('./types.js').GameEvent[], i: number, g: import('./types.js').Game) => void }} [opts]
   */
  function runFor(seconds, { dt = TICK, onTick = null } = {}) {
    if (!(seconds > 0) || !(dt > 0)) return;
    const n = Math.floor(seconds / dt + 1e-9);
    for (let i = 0; i < n; i++) {
      const events = tickOnce(dt);
      if (onTick) onTick(events, i, game);
    }
  }

  /** Record a storage failure. */
  function storageFailed(error) {
    game.storageOk = false;
    game.bus.emit('storageError', { type: 'storageError', error });
    return { ok: false, error };
  }

  /**
   * Save to SAVE.key (and rotate the backups every SAVE.backupEverySec of wall time). Publishes 'saved' or
   * 'storageError'. lastSeen becomes nowMs minus an undrained backlog; with { hidden: true } (main.js, whenever the
   * frame loop is not advancing the game) it stays at the wall time the simulation reached, so the next load credits
   * lastSeen → savedAt as hidden-tab time (C78). Single writer (C80): if another game wrote the save since this one
   * loaded or last saved it (TABS.genKey is ahead), nothing is written, the game turns stale, 'saveStale' is
   * published once and { ok: false, error: 'stale' } is returned (storageOk is untouched).
   * @param {number} nowMs
   * @param {{ hidden?: boolean }} [opts]
   * @returns {{ ok: boolean, error: (string|null) }}
   */
  function save(nowMs, { hidden = false } = {}) {
    if (game.stale) return { ok: false, error: 'stale' };
    const gen = storedGen();
    if (gen !== null && gen > game.saveGen) {
      game.stale = true;
      game.bus.emit('saveStale', { type: 'saveStale', stored: gen, mine: game.saveGen });
      return { ok: false, error: 'stale' };
    }
    const now = fin(nowMs);
    game.s.meta.savedAt = now;
    if (Number.isFinite(nowMs)) {
      const meta = game.s.meta;
      meta.lastSeen = hidden ? Math.min(fin(meta.lastSeen, nowMs), nowMs) : nowMs - Math.round(backlogSec() * 1000);
    }
    let str;
    try {
      str = toExportString(game.s, now);
    } catch (e) {
      return storageFailed('encode: ' + String((e && e.message) || e));
    }
    if (!store.set(SAVE.key, str)) return storageFailed(store.lastError || 'write');
    // The generation is written after the save, so a reader that sees the new generation also sees the new save.
    const next = Math.max(gen ?? 0, game.saveGen) + 1;
    if (!store.set(TABS.genKey, String(next))) return storageFailed(store.lastError || 'write');
    game.saveGen = next;
    if (now - lastBackupAt >= SAVE.backupEverySec * 1000) {
      const bk = SAVE.backups;
      for (let i = bk.length - 1; i > 0; i--) {
        const prev = store.get(bk[i - 1]);
        if (prev !== null && !store.set(bk[i], prev)) return storageFailed(store.lastError || 'write');
      }
      if (!store.set(bk[0], str)) return storageFailed(store.lastError || 'write');
      lastBackupAt = now;
    }
    game.storageOk = true;
    game.bus.emit('saved', { type: 'saved', ok: true });
    return { ok: true, error: null };
  }

  /**
   * Export string of the current state (same format as the local save).
   * @param {number} nowMs
   * @returns {string}
   */
  function exportString(nowMs) {
    return toExportString(game.s, fin(nowMs));
  }

  /**
   * Replace the state from an export string. No offline credit (lastSeen = nowMs). On failure the state is untouched.
   * @param {string} str
   * @param {number} nowMs
   * @returns {{ ok: boolean, error: (string|null) }}
   */
  function importString(str, nowMs) {
    const res = fromExportString(str);
    if (!res.ok) return { ok: false, error: res.error };
    res.state.meta.lastSeen = fin(nowMs);
    publish(install(res.state));
    game.bus.emit('imported', { type: 'imported' });
    return { ok: true, error: null };
  }

  /**
   * Remove the save and its backups, then start a new game. The save generation is bumped, so a game still open in
   * another tab turns stale instead of writing the abandoned colony back (C80).
   * @param {number} nowMs
   */
  function hardReset(nowMs) {
    const next = Math.max(storedGen() ?? 0, game.saveGen) + 1;
    if (store.set(TABS.genKey, String(next))) game.saveGen = next;
    game.stale = false;
    store.remove(SAVE.key);
    for (const key of SAVE.backups) store.remove(key);
    lastBackupAt = -Infinity;
    newGame(nowMs);
  }

  return game;
}
