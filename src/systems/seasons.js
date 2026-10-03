// Season clock (real time, never reset by prestige), season modifiers, frost line and forecast → d.season.
// Owner: WP6. Contract: ARCHITECTURE §8.5 (seasons.js), §5 (d.season), DESIGN §17.
// ARCH-R: under `eternal_winter` the season is always winter; the frost line then sits at F_max permanently (no
//   descent/retreat cycle every season length), because "always winter" has no season boundaries to animate.
// ARCH-R: seasonAt().index / d.season.index is the CANONICAL index in SEASON_ORDER (so SEASON_ORDER[index] === id even
//   under LONG_SUMMER_ORDER, where the year slot and the season index differ).
// ARCH-R: setChronobiology { start } jumps the clock to the start of that season now (the clock is shared by all runs,
//   so a "starting season" can only mean the current position); without `start` the position within the year is
//   kept proportionally when the length changes.
// ARCH-R: a tick with dt > 0 fills d.season.mods with the mods of the clock interval [t0, t0 + dt) the step covers,
//   time-weighted when it crosses a season boundary (booleans: the season that covered most of the step);
//   id/srcId/frost/forecast describe the clock AFTER the step. Online only one 0.1 s tick per boundary is blended;
//   offline it keeps a 60 s step that ends on a boundary from applying the next season's mods (e.g. the autumn food
//   cap) to the whole step (DESIGN §21.3 2 % invariant). A dt = 0 derive pass uses the current season's mods.
// ARCH-R: the clock snaps onto a season boundary when it lands within 1e-7 s of one (0.1 s float drift), so
//   seasonAt() and core/offline.js's floor(t / len) season count always agree.

import { SEASON_ORDER, LONG_SUMMER_ORDER, YEAR, SEASON_MODS, FROST } from '../data/seasons.js';
import { RESEARCH } from '../data/research.js';
import { MOUND } from '../data/surface.js';
import { effectAdd } from '../core/effects.js';
import { lvl } from '../core/math.js';

const SEASONS_IN_YEAR = SEASON_ORDER.length;
/** Boundary tolerance (s): 0.1 s ticks accumulate float drift, so a clock a hair below a boundary counts as past it
 *  (otherwise 36,000 online ticks and one exact offline step could disagree on the season at t = 3600). */
const EPS_T = 1e-7;

/** Valid season length of a meta.season (falls back to YEAR.lengthSec when corrupt). */
function lenOf(seasonState) {
  const L = seasonState && seasonState.lengthSec;
  return Number.isFinite(L) && L > 0 ? L : YEAR.lengthSec;
}

/** Season-order flags of the current cycle/run. */
function flagsOf(s) {
  return {
    longSummer: !!(s.cycle && s.cycle.edict === 'edict_of_long_summer'),
    eternalWinter: !!(s.run && s.run.hardship === 'eternal_winter'),
  };
}

/** Order array for the flags. */
function orderFor(longSummer) {
  return longSummer ? LONG_SUMMER_ORDER : SEASON_ORDER;
}

/**
 * Pure season lookup at time t (seconds into the year).
 * @param {Object} meta s.meta (reads meta.season.lengthSec)
 * @param {number} t seconds into the current year
 * @param {{ longSummer?: boolean, eternalWinter?: boolean }} [opts]
 * @returns {{ id: string, index: number, tIn: number }} index = position in SEASON_ORDER; tIn = seconds into the season
 */
export function seasonAt(meta, t, { longSummer = false, eternalWinter = false } = {}) {
  const len = lenOf(meta && meta.season);
  const yearLen = len * SEASONS_IN_YEAR;
  let tt = Number.isFinite(t) ? t % yearLen : 0;
  if (tt < 0) tt += yearLen;
  let slot = Math.floor((tt + EPS_T) / len);
  if (slot >= SEASONS_IN_YEAR) slot = SEASONS_IN_YEAR - 1;
  const tIn = Math.max(0, tt - slot * len);
  const id = eternalWinter ? 'winter' : orderFor(longSummer)[slot];
  return { id, index: SEASON_ORDER.indexOf(id), tIn };
}

/** Year slot (0..3) of time t. */
function slotAt(len, t) {
  const s = Math.floor((t + EPS_T) / len);
  return s < 0 ? 0 : s >= SEASONS_IN_YEAR ? SEASONS_IN_YEAR - 1 : s;
}

/**
 * Advance meta.season by sec (spring holds while extraSpring > 0; the year wraps). O(1) for any sec.
 * @returns {void}
 */
function advance(s, sec) {
  const se = s.meta.season;
  if (!(sec > 0) || !Number.isFinite(sec)) return;
  const len = lenOf(se);
  const yearLen = len * SEASONS_IN_YEAR;
  if (!Number.isFinite(se.t) || se.t < 0) se.t = 0;
  if (!Number.isFinite(se.year) || se.year < 0) se.year = 0;
  if (!Number.isFinite(se.extraSpring) || se.extraSpring < 0) se.extraSpring = 0;
  let rest = sec;
  const flags = flagsOf(s);
  // boon_long_spring: while it is spring and bonus seconds remain, the clock does not advance.
  if (se.extraSpring > 0) {
    const now = seasonAt(s.meta, se.t, flags);
    if (now.id === 'spring') {
      const hold = Math.min(se.extraSpring, rest);
      se.extraSpring -= hold;
      if (se.extraSpring < 1e-9) se.extraSpring = 0;
      rest -= hold;
    } else if (!flags.eternalWinter) {
      // The bonus is spent the next time spring comes round; if that happens inside this step, hold there.
      const toSpring = yearLen - se.t;
      if (rest > toSpring) {
        se.t = 0;
        se.year += 1;
        rest -= toSpring;
        const hold = Math.min(se.extraSpring, rest);
        se.extraSpring -= hold;
        if (se.extraSpring < 1e-9) se.extraSpring = 0;
        rest -= hold;
      }
    }
  }
  if (!(rest > 0)) return;
  const total = se.t + rest;
  const wraps = Math.floor((total + EPS_T) / yearLen);
  se.year += wraps;
  se.t = total - wraps * yearLen;
  if (se.t < 0 || !Number.isFinite(se.t)) se.t = 0;
  // Snap onto a season boundary when within EPS_T of it, so accumulated 0.1 s drift never leaves the clock a hair
  // below a boundary (core/offline.js counts seasons as year × 4 + floor(t / len), which has no tolerance).
  const b = Math.round(se.t / len) * len;
  if (Math.abs(se.t - b) < EPS_T) {
    if (b >= yearLen) {
      se.year += 1;
      se.t = 0;
    } else {
      se.t = b;
    }
  }
}

/** Numeric keys of d.season.mods (time-weighted over a step) and boolean keys (majority of the step). */
const NUM_MODS = ['forage', 'lay', 'broodTime', 'dig', 'insight', 'foodCap', 'rivalAggro', 'flightW'];
const BOOL_MODS = ['rivalDormant', 'puddlesBlock'];

/**
 * Write the modifiers of season `id` into `out` (mild year-0 winter forage; C38 long-summer autumn foodCap 1).
 * @param {Object} out
 * @param {string} id
 * @param {boolean} mild
 * @param {boolean} longSummer
 * @returns {Object} out
 */
function modsFor(out, id, mild, longSummer) {
  const src = SEASON_MODS[id];
  out.forage = id === 'winter' && mild ? src.forageMild : src.forage;
  out.lay = src.lay;
  out.broodTime = src.broodTime;
  out.dig = src.dig;
  out.insight = src.insight;
  out.foodCap = longSummer && id === 'autumn' ? 1 : src.foodCap;
  out.rivalAggro = src.rivalAggro;
  out.rivalDormant = src.rivalDormant;
  out.flightW = src.flightW;
  out.puddlesBlock = src.puddlesBlock;
  return out;
}

/** Most segments walked by stepMods (a step never spans more than a few season boundaries). */
const MAX_SEGMENTS = 12;

/**
 * Season modifiers averaged over the clock interval a step of `sec` seconds covers, starting from the CURRENT
 * (pre-advance) clock: numeric mods are time-weighted, boolean mods follow the season that covered most of the step.
 * Returns null only for a non-positive step (the caller then uses the current season's mods).
 * Pure: walks a copy of the clock with the same rules as advance() (extra-spring hold, year wrap, mild year 0).
 * @param {Object} s
 * @param {number} sec
 * @returns {Object|null} mods-shaped object or null
 */
function stepMods(s, sec) {
  if (!(sec > 0) || !Number.isFinite(sec)) return null;
  const se = s.meta.season;
  const flags = flagsOf(s);
  const len = lenOf(se);
  const yearLen = len * SEASONS_IN_YEAR;
  let t = Number.isFinite(se.t) && se.t >= 0 ? se.t % yearLen : 0;
  let year = Number.isFinite(se.year) && se.year >= 0 ? se.year : 0;
  let extra = Number.isFinite(se.extraSpring) && se.extraSpring > 0 ? se.extraSpring : 0;
  let rest = sec;
  const segs = [];
  for (let n = 0; rest > 1e-12 && n < MAX_SEGMENTS; n++) {
    const cur = seasonAt(s.meta, t, flags);
    const mild = year === 0 && !flags.eternalWinter;
    if (cur.id === 'spring' && extra > 0) {
      const hold = Math.min(extra, rest);
      segs.push({ id: cur.id, mild, sec: hold });
      extra -= hold;
      rest -= hold;
      continue;
    }
    const boundary = (slotAt(len, t) + 1) * len;
    const seg = Math.min(rest, Math.max(boundary - t, 0));
    if (seg > 0) segs.push({ id: cur.id, mild, sec: seg });
    rest -= seg;
    t += seg;
    if (t + EPS_T >= yearLen) {
      t = 0;
      year += 1;
    } else if (seg <= 0) {
      t = boundary;
    }
  }
  if (rest > 1e-12 && segs.length > 0) segs[segs.length - 1].sec += rest;
  if (segs.length === 0) return null;
  let total = 0;
  const first = segs[0];
  let mixed = false;
  for (const g of segs) {
    total += g.sec;
    if (g.id !== first.id || g.mild !== first.mild) mixed = true;
  }
  // One season for the whole step: its mods (this is the current season, except when the step ends exactly on a
  // boundary — the interval is right-open, so the season that starts there contributed no time).
  if (!mixed || !(total > 0)) return modsFor({}, first.id, first.mild, flags.longSummer);
  const out = {};
  for (const k of NUM_MODS) out[k] = 0;
  const tmp = {};
  const boolWeight = {};
  for (const g of segs) {
    modsFor(tmp, g.id, g.mild, flags.longSummer);
    const w = g.sec / total;
    for (const k of NUM_MODS) out[k] += tmp[k] * w;
    for (const k of BOOL_MODS) {
      const key = k + ':' + tmp[k];
      boolWeight[key] = (boolWeight[key] || 0) + g.sec;
    }
  }
  for (const k of BOOL_MODS) out[k] = (boolWeight[k + ':true'] || 0) > (boolWeight[k + ':false'] || 0);
  return out;
}

/** Thermoregulation frost reduction (0 when not owned or the research table is not loaded). */
function thermoRows(s) {
  if (!(s.run && s.run.research && s.run.research.thermoregulation)) return 0;
  const r = RESEARCH && RESEARCH.thermoregulation;
  const v = r && r.fx && r.fx.frost;
  return Number.isFinite(v) ? v : 0;
}

/** Mound frost reduction: min(frostMax, floor(mound / frostPerLevels)). */
function moundRows(s) {
  const m = s.run && s.run.surface ? s.run.surface.mound : 0;
  const per = MOUND && MOUND.frostPerLevels;
  const max = MOUND && MOUND.frostMax;
  if (!(m > 0) || !(per > 0)) return 0;
  return Math.min(Number.isFinite(max) ? max : 0, Math.floor(m / per));
}

/**
 * F_max of the current (or upcoming) winter: max(minRow, (mild ? maxRowMild : maxRow) − thermo − mound).
 * @param {Object} s
 * @param {boolean} mild
 * @returns {number}
 */
export function frostMaxFor(s, mild) {
  const base = mild ? FROST.maxRowMild : FROST.maxRow;
  return Math.max(FROST.minRow, base - thermoRows(s) - moundRows(s));
}

/** Seconds until the next season change (incl. held extra spring) and the next season id. */
function nextOf(s, flags, len, cur) {
  const se = s.meta.season;
  if (flags.eternalWinter) return { next: 'winter', inSec: Math.max(0, len - cur.tIn) };
  const order = orderFor(flags.longSummer);
  const slot = slotAt(len, se.t);
  let inSec = Math.max(0, len - cur.tIn);
  if (cur.id === 'spring' && se.extraSpring > 0) inSec += se.extraSpring;
  return { next: order[(slot + 1) % SEASONS_IN_YEAR], inSec };
}

/**
 * Fill d.season from s.meta.season (no clock change).
 * @param {Object} s
 * @param {Object} d
 * @param {Object|null} [blend] mods of the step just advanced (stepMods); null = the current season's mods
 * @returns {void}
 */
function fill(s, d, blend = null) {
  const se = s.meta.season;
  const ds = d.season;
  const flags = flagsOf(s);
  const len = lenOf(se);
  const cur = seasonAt(s.meta, se.t, flags);
  const year = Number.isFinite(se.year) ? se.year : 0;
  const mild = year === 0 && !flags.eternalWinter;
  const nx = nextOf(s, flags, len, cur);
  ds.id = cur.id;
  ds.index = cur.index;
  ds.year = year;
  ds.tIn = cur.tIn;
  ds.toNext = nx.inSec;
  ds.len = len;
  ds.mild = mild;

  // Modifiers (in place; d.season.mods keeps its shape). C38: "autumn bonuses off" under edict_of_long_summer.
  if (!ds.mods || typeof ds.mods !== 'object') ds.mods = {};
  const m = modsFor(ds.mods, cur.id, mild, flags.longSummer);
  if (blend) {
    // The systems after seasons.tick integrate this step's dt with the mods of the interval it covered, time-weighted
    // across a boundary (one 60 s offline step ending exactly on a boundary must not apply the new season's food cap
    // to the whole step).
    for (const k of NUM_MODS) m[k] = blend[k];
    for (const k of BOOL_MODS) m[k] = blend[k];
  }
  ds.srcId = flags.longSummer && cur.id === 'autumn' ? 'neutral' : cur.id;

  // Frost line (winter only). Outside winter frostMax previews the upcoming winter (0 when no winter can come).
  const F = frostMaxFor(s, mild);
  if (cur.id === 'winter') {
    ds.frostMax = F;
    if (flags.eternalWinter) {
      ds.frostRow = F;
    } else {
      const e = cur.tIn;
      const remain = len - e;
      if (e < FROST.descendSec) ds.frostRow = (F * e) / FROST.descendSec;
      else if (remain < FROST.retreatSec) ds.frostRow = (F * Math.max(0, remain)) / FROST.retreatSec;
      else ds.frostRow = F;
    }
  } else {
    ds.frostRow = 0;
    ds.frostMax = flags.longSummer ? 0 : F;
  }

  // Frost snap: rows y < snapRow freeze brood; thermal_brood_shuttling makes the colony immune (ARCHITECTURE §12.1).
  const shuttling = !!(s.run && s.run.research && s.run.research.thermal_brood_shuttling);
  const snap = effectAdd(s, 'frost_snap');
  ds.snapRow = shuttling || !(snap > 0) ? 0 : snap;

  // Forecast: next season + a weather event announced by events.js (active entry with data.forecast).
  const fc = ds.forecast;
  fc.next = nx.next;
  fc.inSec = nx.inSec;
  fc.weather = null;
  const act = s.run && s.run.events && Array.isArray(s.run.events.active) ? s.run.events.active : [];
  for (let i = 0; i < act.length; i++) {
    const a = act[i];
    if (a && a.data && a.data.forecast === true) {
      fc.weather = a.id;
      break;
    }
  }
}

/**
 * Advance the season clock by dt, fill d.season and emit seasonChanged {id, year} / winterSoon.
 * Runs every tick, including while the landing chooser is open and offline (real-time clock).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const se = s.meta.season;
  const flags = flagsOf(s);
  const len = lenOf(se);
  let blend = null;
  if (dt > 0 && Number.isFinite(dt)) {
    const t0 = Number.isFinite(se.t) ? se.t : 0;
    const y0 = Number.isFinite(se.year) ? se.year : 0;
    const before = seasonAt(s.meta, t0, flags);
    const nx0 = nextOf(s, flags, len, before);
    const toNext0 = nx0.inSec;
    const nextId0 = nx0.next;
    blend = stepMods(s, dt);
    advance(s, dt);
    const after = seasonAt(s.meta, se.t, flags);
    if (env && typeof env.emit === 'function') {
      if (after.id !== before.id || se.year !== y0) env.emit('seasonChanged', { id: after.id, year: se.year });
      // winterSoon: the forecast lead (60 s) before winter is crossed within the same season.
      if (before.id !== 'winter' && nextId0 === 'winter' && after.id === before.id && se.year === y0 &&
          slotAt(len, t0) === slotAt(len, se.t)) {
        const toNext1 = nextOf(s, flags, len, after).inSec;
        if (toNext0 > YEAR.forecastSec && toNext1 <= YEAR.forecastSec) env.emit('winterSoon', {});
      }
    }
  }
  fill(s, d, blend);
}

/**
 * [x] core/offline.js: advance the clock only (year wraps); no events, no d writes.
 * @param {import('../core/types.js').State} s
 * @param {number} sec
 * @returns {void}
 */
export function skipTime(s, sec) {
  advance(s, sec);
}

/**
 * [x] WP7 landing (seasonal_wisdom): jump t to the start of that season in the current year.
 * Unknown ids (or a season absent from the current order) are ignored.
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {void}
 */
export function setSeason(s, id) {
  const flags = flagsOf(s);
  const slot = orderFor(flags.longSummer).indexOf(id);
  if (slot < 0) return;
  const se = s.meta.season;
  se.t = slot * lenOf(se);
}

/**
 * [q] WP7 startRun: the Chronobiology starting season stored by setChronobiology (meta.season.start), or null when
 * none is set or the gene is not owned (F17).
 * @param {import('../core/types.js').State} s
 * @returns {string|null}
 */
export function chronoStart(s) {
  const st = s && s.meta && s.meta.season ? s.meta.season.start : null;
  if (typeof st !== 'string' || !SEASON_ORDER.includes(st)) return null;
  return lvl(s.meta.genome, 'chronobiology') >= 1 ? st : null;
}

/**
 * [x] WP7 startRun (boon_long_spring): meta.season.extraSpring += sec.
 * @param {import('../core/types.js').State} s
 * @param {number} sec
 * @returns {void}
 */
export function addExtraSpring(s, sec) {
  if (!(sec > 0) || !Number.isFinite(sec)) return;
  const se = s.meta.season;
  const cur = Number.isFinite(se.extraSpring) && se.extraSpring > 0 ? se.extraSpring : 0;
  se.extraSpring = cur + sec;
}

/** Player commands owned by seasons.js. */
export const handlers = {
  /**
   * setChronobiology { lengthSec, start } — needs Genome `chronobiology`; season length 180..720 s.
   * The length applies at once and keeps the position within the year (t scales). `start` is the starting season of
   * every later run (DESIGN §17.1): it is stored in meta.season.start and applied by WP7 startRun at the next landing
   * or cycle / era start, never by jumping the running clock (F17, ARCHITECTURE §18). start: null clears it; an absent
   * start keeps the stored one.
   */
  setChronobiology: {
    validate(s, d, cmd) {
      if (!(lvl(s.meta.genome, 'chronobiology') >= 1)) return 'locked';
      const L = cmd.lengthSec;
      if (typeof L !== 'number' || !Number.isFinite(L) || L < YEAR.chronoMin || L > YEAR.chronoMax) return 'invalid:length';
      const st = cmd.start;
      if (st !== undefined && st !== null && !SEASON_ORDER.includes(st)) return 'invalid:season';
      return null;
    },
    apply(s, d, cmd, env) {
      const se = s.meta.season;
      const flags = flagsOf(s);
      const before = seasonAt(s.meta, se.t, flags);
      const oldLen = lenOf(se);
      const newLen = cmd.lengthSec;
      se.lengthSec = newLen;
      se.t = Math.min(se.t * (newLen / oldLen), newLen * SEASONS_IN_YEAR - 1e-6);
      if (!(se.t >= 0)) se.t = 0;
      if (cmd.start === null) delete se.start;
      else if (typeof cmd.start === 'string') se.start = cmd.start;
      const after = seasonAt(s.meta, se.t, flags);
      if (after.id !== before.id && env && typeof env.emit === 'function') env.emit('seasonChanged', { id: after.id, year: se.year });
      fill(s, d);
    },
  },
};
