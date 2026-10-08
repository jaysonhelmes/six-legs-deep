// Browser boot: storage, the tab lock, the game (load or new, with offline catch-up), the UI shell, the renderers and
// canvas input, the single requestAnimationFrame loop, visibility handling and autosave. Owner: WP9. Contract:
// ARCHITECTURE §14.7.
// ARCH-R: the renderers are imported with dynamic import() (each in its own try/catch) instead of static imports, so a
// missing or broken render module degrades to "no canvas" instead of preventing the whole game and UI from booting.
// ARCH-R (§18 C78–C80): every save passes { hidden } (true while the loop is not advancing the game), so hidden-tab
// time survives a reload; the loop drains a short-gap backlog under a per-frame budget (FRAME); only the tab that owns
// the tab lock runs and saves the game, older tabs pause behind an overlay whose click reloads the latest save.
// C239: index.html loads src/boot.js, which runs the pre-boot version check and then imports this module; boot() starts
// the in-game update watch ("Update available" pill, saves through persist() before the refresh-and-reload).

import { createGame } from './core/game.js';
import { CURRENT_VERSION } from './data/changelog.js';
import { startUpdateWatch } from './ui/updater.js';
import { createTabLock } from './core/tablock.js';
import { FRAME, TABS } from './data/balance.js';
import { mountUI } from './ui/app.js';
import * as uistate from './ui/uistate.js';
import { setRevealAll } from './ui/reveal.js';

/** localStorage, or null when blocked (sandboxed iframe, disabled storage). Write failures are handled by game.save. */
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

/** Wall-clock milliseconds (the only place wall time enters the game). */
const wallNow = () => Date.now();

/** Show a readable failure instead of a blank page. */
function bootFailure(err) {
  console.error('[boot] Six Legs Deep failed to start', err);
  const app = document.getElementById('app') || document.body;
  const box = document.createElement('div');
  box.className = 'boot-error';
  box.setAttribute('role', 'alert');
  const h = document.createElement('h1');
  h.textContent = 'The colony could not start';
  const p = document.createElement('p');
  p.textContent = 'Something went wrong while loading. Your save is safe in this browser. Try reloading the page.';
  const pre = document.createElement('pre');
  pre.textContent = String((err && (err.stack || err.message)) || err);
  box.append(h, p, pre);
  app.appendChild(box);
}

/** Load one render module; returns the module or null (logged once). */
async function tryImport(path) {
  try {
    return await import(path);
  } catch (err) {
    console.error('[boot] render module unavailable:', path, err);
    return null;
  }
}

/**
 * Create the renderers, canvas input controllers and the seam (ARCHITECTURE §13.3). Each piece is optional.
 * @returns {Promise<{ nest: Object|null, surface: Object|null, seam: Object|null, detach: Function[] }>}
 */
async function startRenderers(game, ui) {
  const out = { nest: null, surface: null, seam: null, detach: [] };
  const [nr, sr, ni, si, sm] = await Promise.all([
    tryImport('./render/nestRenderer.js'), tryImport('./render/surfaceRenderer.js'), tryImport('./render/nestInput.js'),
    tryImport('./render/surfaceInput.js'), tryImport('./render/seam.js'),
  ]);
  try {
    if (nr) out.nest = nr.createNestRenderer(ui.canvases.below, { game, ui: uistate, bus: game.bus, strip: ui.canvases.nestStrip });
  } catch (err) { console.error('[boot] nest renderer failed', err); }
  try {
    if (sr) out.surface = sr.createSurfaceRenderer(ui.canvases.above, { game, ui: uistate, bus: game.bus });
  } catch (err) { console.error('[boot] surface renderer failed', err); }
  try {
    if (ni && out.nest) out.detach.push(ni.attachNestInput(ui.canvases.below, out.nest, { game, ui: uistate, bridge: ui.bridge }));
  } catch (err) { console.error('[boot] nest input failed', err); }
  try {
    if (si && out.surface) out.detach.push(si.attachSurfaceInput(ui.canvases.above, out.surface, { game, ui: uistate, bridge: ui.bridge }));
  } catch (err) { console.error('[boot] surface input failed', err); }
  try {
    if (sm) out.seam = sm.createSeam(ui.canvases.seam, { game });
  } catch (err) { console.error('[boot] seam failed', err); }
  return out;
}

// ---- single-writer tab lock (ARCHITECTURE §7.16, §18 C80) ----

/** A random id for this tab. */
const tabId = (() => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
})();

/** BroadcastChannel for tab messages, or null (the lock then talks through storage events). */
const channel = (() => {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(TABS.channel) : null;
  } catch {
    return null;
  }
})();

/** Set by boot(): what the lock needs to flush the save when a newer tab takes over. */
let runtime = null;
/** True once another tab owns the game: no frames, no saves; the overlay offers to play here (a reload). */
let tabPaused = false;

const lock = createTabLock({
  id: tabId,
  storage,
  channel,
  listenStorage: (fn) => {
    const handler = (e) => fn(e ? e.key : null, e ? e.newValue : null);
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  },
  now: wallNow,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
  onYield: ({ flush }) => {
    let gen = null;
    if (runtime && !tabPaused && flush) {
      try {
        const r = runtime.game.save(wallNow(), { hidden: runtime.loopPaused() });
        if (r.ok) gen = runtime.game.saveGen;
      } catch (err) {
        console.error('[tabs] flush before hand-over failed', err);
      }
    }
    pauseForOtherTab();
    return gen;
  },
});

/** Stop this tab (another tab owns the game) and show the overlay. Also drops this tab's lock entry, so a tab that
 *  turned stale through the save generation (lost messages) stops claiming the game with its heartbeat. */
function pauseForOtherTab() {
  if (tabPaused) return;
  tabPaused = true;
  if (runtime) {
    runtime.stop();
    // Final QA: a paused tab never writes again, whatever calls game.save (Settings "Save now", the import autosave,
    // the console). Otherwise its write landed before the new owner's first save and turned the new owner stale.
    runtime.game.stale = true;
  }
  lock.release();
  showTabOverlay();
}

/** Full-page "Game open in another tab" overlay; a click anywhere reloads, which takes the game over with its latest save. */
function showTabOverlay() {
  if (document.getElementById('tab-lock')) return;
  const app = document.getElementById('app');
  if (app) app.inert = true;
  const wrap = document.createElement('div');
  wrap.id = 'tab-lock';
  wrap.className = 'modal-backdrop tab-lock';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'tab-lock-title');
  wrap.style.zIndex = '1000';
  wrap.style.cursor = 'pointer';
  const box = document.createElement('div');
  box.className = 'modal';
  box.style.width = 'min(420px, 100%)';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.id = 'tab-lock-title';
  title.textContent = 'Game open in another tab';
  head.appendChild(title);
  const body = document.createElement('div');
  body.className = 'modal-body';
  const p1 = document.createElement('p');
  p1.textContent = 'Your colony is running in another tab or window. Only one can play at a time, so this one is paused and does not save.';
  const p2 = document.createElement('p');
  p2.textContent = 'Click to play here instead. The colony reloads from its latest save, and the other tab pauses.';
  body.append(p1, p2);
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Play here';
  actions.appendChild(btn);
  box.append(head, body, actions);
  wrap.appendChild(box);
  wrap.addEventListener('click', () => window.location.reload());
  document.body.appendChild(wrap);
  try { btn.focus(); } catch { /* ignore */ }
}

/** Boot the game (this tab owns it). */
function boot() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('reveal') === 'all') setRevealAll(true);

  const game = createGame({ nowMs: wallNow(), storage });
  const loaded = game.loadOrNew(wallNow());

  // ---- saving: only while this tab owns the game; { hidden } while the loop is not advancing (C78) ----
  let lastAdvanceAt = performance.now();
  /** True while the frame loop is not advancing the game (hidden tab, or no animation frame for over a second). */
  const loopPaused = () => document.hidden || performance.now() - lastAdvanceAt > 1000;
  /** Save when this tab still owns the game; returns the save result or null. */
  function persist() {
    if (tabPaused || !lock.check()) return null;
    return game.save(wallNow(), { hidden: loopPaused() });
  }
  game.hooks.beforePrestige = () => { persist(); };
  game.bus.on('saveStale', () => pauseForOtherTab());

  // C150: hadSave (a save existed at boot, even a damaged one) lets the shell offer the patch notes after an update
  const ui = mountUI(document.getElementById('app'), game, { hadSave: !!(loaded.loaded || loaded.error) });
  if (!storage) ui.bridge.toast('This browser blocks saving. Use Export in Settings to keep your colony.', 'danger');
  if (loaded.error) ui.bridge.toast(loaded.restoredFrom ? 'Your save was damaged; a backup was restored.' : 'Your save could not be read; a new colony began.', 'danger');
  if (loaded.welcome) ui.showWelcome(loaded.welcome);

  /** @type {{ nest: Object|null, surface: Object|null, seam: Object|null, detach: Function[] }} */
  let r = { nest: null, surface: null, seam: null, detach: [] };
  startRenderers(game, ui).then((res) => {
    r = res;
    ui.attachRenderers({ nest: r.nest, surface: r.surface, seam: r.seam });
  });

  // ---- frame loop (ARCHITECTURE §14.7) ----
  const errors = new Set();
  const guarded = (label, fn) => {
    try {
      fn();
    } catch (err) {
      const key = label + ':' + String(err && err.message);
      if (!errors.has(key)) {
        errors.add(key);
        console.error('[loop] ' + label + ' failed', err);
      }
    }
  };
  // `last` only moves while the page is visible: if a browser still fires rAF for a hidden page, the hidden gap is
  // kept and arrives as one large realDt on return, which game.advance routes to catchUp (ARCHITECTURE §14.7). A
  // shorter gap is drained under the FRAME budget over the next frames instead of freezing one frame (C79).
  const clock = () => performance.now();
  const frameOpts = { maxTicks: FRAME.maxTicks, budgetMs: FRAME.budgetMs, clock };
  let last = performance.now();
  function frame(now) {
    if (tabPaused) return; // another tab owns the game; "Play here" reloads the page
    if (!document.hidden) {
      const dt = Math.max(0, (now - last) / 1000);
      lastAdvanceAt = performance.now();
      guarded('advance', () => game.advance(dt, wallNow(), frameOpts));
      if (r.nest) guarded('nest', () => r.nest.render(dt));
      if (r.surface) guarded('surface', () => r.surface.render(dt));
      if (r.seam) guarded('seam', () => r.seam.render(dt));
      guarded('ui', () => ui.frame(now));
      armAutosave();
      last = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- autosave: every settings.autosaveSec (re-armed on change); on hide and pagehide ----
  let armedSec = -1;
  let timer = null;
  function armAutosave() {
    const sec = Number(game.s.meta.settings.autosaveSec) || 0;
    if (sec === armedSec) return;
    armedSec = sec;
    if (timer) clearInterval(timer);
    timer = sec > 0 ? setInterval(persist, sec * 1000) : null;
  }
  armAutosave();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persist();
    else if (!tabPaused) lock.check(); // shown again: a tab opened meanwhile may own the game now
  });
  document.addEventListener('resume', () => { if (!tabPaused) lock.check(); }); // Page Lifecycle: a frozen tab thawed
  window.addEventListener('pagehide', () => {
    persist();
    lock.release();
  });

  // C239: quiet live-version check every 10 min and on tab show; the pill saves, refreshes every file and reloads
  let updates = { check: async () => null, stop() {} };
  try {
    updates = startUpdateWatch({ current: CURRENT_VERSION, beforeReload: () => { persist(); } });
  } catch (err) { console.warn('[update] watch unavailable', err); }

  runtime = {
    game,
    loopPaused,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      armedSec = -1;
    },
  };

  // Debug handle for the console (read-only use; mutate only through game.actions).
  window.sld = {
    game, ui, uistate,
    /** The tab lock: { id, owner, enabled, check() }. */
    tabLock: lock,
    /** The renderers once loaded: { nest, surface, seam } (each may be null). */
    get renderers() { return { nest: r.nest, surface: r.surface, seam: r.seam }; },
    /** Run the in-game update check now; resolves to the live version (or null). */
    checkForUpdate: () => updates.check(),
  };
}

// A page restored from the back/forward cache released its lock on pagehide and its state may be old: start afresh.
window.addEventListener('pageshow', (e) => { if (e.persisted) window.location.reload(); });

lock.acquire()
  .then(() => {
    if (!lock.owner || tabPaused) {
      showTabOverlay(); // a newer tab claimed the game while this one waited to boot
      tabPaused = true;
      return;
    }
    boot();
  })
  .catch(bootFailure);
