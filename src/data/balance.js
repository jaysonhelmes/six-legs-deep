// Global balance constants: tick, clamps, softcaps, grid/hex geometry, offline, save and loop constants.
// Owner: WP1. Contract: ARCHITECTURE §6.1 (numbers from DESIGN §3, §12.10, §21, §22).

/**
 * Deep-freeze a plain object/array tree (local helper; data modules import nothing from core).
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

/** Simulation tick in seconds (10 Hz). */
export const TICK = 0.1;
/** Combat sub-step in seconds (4 Hz). */
export const COMBAT_STEP = 0.25;
/** Upper clamp for every stored number. */
export const CLAMP_MAX = 1e295;
/** Costs above this are reported as null (MAX). */
export const COST_MAX = 1e280;
/** Clicks counted per integer second of run time. */
export const CLICK_CAP = 15;
/** One-shot food rewards may push food up to this multiple of the cap. */
export const FOOD_OVERFLOW = 2;

/** Nest grid geometry. */
export const GRID = deepFreeze({
  cols: 40, rows: 80, cellPx: 12, visibleRows: 45, mainCol: 20, shaftRows: 20,
  royal: { x: 18, y: 20, w: 4, h: 2 },
});

/** Nest cell codes stored in s.run.nest.cells. */
export const CELL = deepFreeze({ SOIL: 0, TUNNEL: 1, CHAMBER: 2, STONE: 3, WATER: 4 });

/** Surface hex geometry. */
export const HEX = deepFreeze({ maxRadius: 16, count: 817, px: 26 });

/** Softcap chains: [threshold, power] applied in sequence (DESIGN §12.10). alates 3e4 is load-bearing (DESIGN §16). */
export const SOFTCAPS = deepFreeze({
  food: [[1e24, 0.5], [1e60, 0.25]],
  dig: [[1e20, 0.5], [1e50, 0.25]],
  insight: [[1e12, 0.5]],
  honeydew: [[1e16, 0.5]],
  fungus: [[1e16, 0.5]],
  chitin: [[1e16, 0.5]],
  ap: [[1e24, 0.5]],
  alates: [[3e4, 0.5]],
  kinship: [[1e5, 0.5]],
  genes: [[1e4, 0.5]],
});

/** Offline progress (DESIGN §21). */
export const OFFLINE = deepFreeze({
  onlineGapSec: 60, hiddenFullSec: 14400, baseCapSec: 14400, baseEff: 0.5,
  earlyStep: 10, earlyWindow: 600, lateStep: 60, maxSteps: 1500,
  bankRate: 0.10, bankMaxSec: 28800, findEverySec: 7200, findMax: 3,
});

/** Diapause speed-up factors (DESIGN §21.5). */
export const DIAPAUSE = deepFreeze({ speed: 2, speedMastery: 3 });

/** Save keys and format (DESIGN §22). */
export const SAVE = deepFreeze({
  key: 'sld_save',
  backups: ['sld_save_bak_0', 'sld_save_bak_1', 'sld_save_bak_2'],
  backupEverySec: 300, prefix: 'SLD1:', targetBytes: 61440,
});

/** Frame loop limits. */
export const LOOP = deepFreeze({ maxTicksPerFrame: 600, welcomeMinSec: 300 });

/** NaN guard cadence. */
export const GUARD = deepFreeze({ fullEveryTicks: 100 });

/**
 * Frame-loop catch-up spreading (ARCHITECTURE §14.7, §18 C79): main.js runs at most `maxTicks` fixed ticks and about
 * `budgetMs` of simulation per animation frame, so a backlog under OFFLINE.onlineGapSec (a short tab switch) drains
 * over the next frames instead of freezing one frame.
 */
export const FRAME = deepFreeze({ maxTicks: 60, budgetMs: 8 });

/**
 * Single-writer tab lock and save generation (ARCHITECTURE §7.16, §18 C80). genKey counts the writes of SAVE.key;
 * lockKey holds { id, at, beat, deadline } of the tab that owns the save; msgKey carries tab messages when
 * BroadcastChannel is unavailable. A lock with no heartbeat for staleMs is free; a newer tab waits up to handoverMs
 * (+ settleMs) for a live owner to flush its save and step aside.
 */
export const TABS = deepFreeze({
  genKey: 'sld_save_gen', lockKey: 'sld_tab_lock', msgKey: 'sld_tab_msg', channel: 'sld_tabs',
  beatMs: 5000, staleMs: 90000, handoverMs: 400, settleMs: 150, pollMs: 15,
});
