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

/**
 * C215: nest width. The base nest is 40 columns; a run can start wider (Satellite Nest levels, see nest.runStartCols),
 * by the same number of columns on each side, so the main shaft and the Royal Chamber stay centred. The width of the
 * nest being worked on is the "active" width: nestgeom.syncCols(s) sets it from s.run.nest.cols before any nest work
 * (derive, tick, queries, each render frame), and GRID.cols / GRID.mainCol / GRID.royal read it. Old saves and every
 * run without the bonus are 40 wide, exactly as before; a run's width never changes mid-run, so stored cell indices
 * never move.
 */
const BASE_COLS = 40;
const MAX_COLS = 64;
let activeCols = BASE_COLS;
const ROYAL_BASE = Object.freeze({ x: 18, y: 20, w: 4, h: 2 });
const royalByCols = new Map();

/**
 * C215: the layout of a nest `cols` wide (even, 40–64): { cols, mainCol, royal }. 40 → main shaft 20, Royal 18–21.
 * @param {number} cols
 * @returns {{ cols: number, mainCol: number, royal: { x: number, y: number, w: number, h: number } }}
 */
export function nestLayout(cols) {
  const c = validCols(cols) ? cols : BASE_COLS;
  const side = (c - BASE_COLS) / 2;
  let royal = royalByCols.get(c);
  if (!royal) {
    royal = Object.freeze({ x: ROYAL_BASE.x + side, y: ROYAL_BASE.y, w: ROYAL_BASE.w, h: ROYAL_BASE.h });
    royalByCols.set(c, royal);
  }
  return { cols: c, mainCol: 20 + side, royal };
}

/** C215: an allowed nest width (an even integer from 40 to 64). */
export function validCols(n) {
  return Number.isInteger(n) && n >= BASE_COLS && n <= MAX_COLS && n % 2 === 0;
}

/** C215: set the active nest width (nestgeom.useCols / syncCols call this; anything invalid means 40). */
export function setActiveNestCols(n) {
  activeCols = validCols(n) ? n : BASE_COLS;
  return activeCols;
}

/** Nest grid geometry. cols, mainCol and royal follow the active nest width (C215); base* are the 40-wide values. */
export const GRID = deepFreeze({
  get cols() { return activeCols; },
  rows: 80, cellPx: 12, visibleRows: 45, shaftRows: 20,
  get mainCol() { return nestLayout(activeCols).mainCol; },
  get royal() { return nestLayout(activeCols).royal; },
  baseCols: BASE_COLS, maxCols: MAX_COLS, baseMainCol: 20, baseRoyal: ROYAL_BASE,
  /** C215: extra columns on each side per Satellite Nest level at run start (up to maxCols). */
  colsPerSide: 4,
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
