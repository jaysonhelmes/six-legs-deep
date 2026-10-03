// Every number and time formatter used by the UI (and by the renderers for labels). Pure module, no DOM.
// Owner: WP9. Contract: ARCHITECTURE §14.3, DESIGN §26. The core never formats numbers.
// Rules: values below 1,000 print as integers (counts) or one decimal below 100 (resources); from 1,000 on, three
// significant digits plus a suffix (K … Dc) up to 1e36, then scientific. Values are TRUNCATED, never rounded up, so
// the display never claims more than the player has (9.96 food shows "9.9", 999,999 shows "999K"). Multipliers and
// percentages are rounded (they describe a factor, not an amount). Never prints NaN or Infinity: prints "—".

/** Suffixes per power of 1,000 (index 1 = K = 1e3 … index 11 = Dc = 1e33). */
export const SUFFIXES = Object.freeze(['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc']);
/** Shown for costs above the cost cap (null costs). */
export const MAX_LABEL = 'MAX';
/** Printed instead of NaN / Infinity. */
export const INVALID = '—';
/** Typographic minus used for negative numbers. */
export const MINUS = '−';

/** Resource display order for cost lists. */
export const RES_ORDER = Object.freeze(['food', 'soil', 'insight', 'pheromone', 'chitin', 'honeydew', 'leaves', 'fungus', 'alates', 'kinship', 'genes']);

const NOTATIONS = ['suffix', 'scientific', 'engineering'];
const SUFFIX_LIMIT = 1e36; // ≥ this: scientific even in suffix mode
const EPS = 1e-7;          // absorbs binary float error before truncation (values here are < 1e5 after scaling)

let notation = 'suffix';
let errorLogged = false;

/**
 * Set the big-number notation (from settings.notation). Unknown modes are ignored.
 * @param {'suffix'|'scientific'|'engineering'} mode
 */
export function setNotation(mode) {
  if (NOTATIONS.includes(mode)) notation = mode;
}

/** @returns {string} the current notation */
export function getNotation() {
  return notation;
}

/** Report an invalid number once per session and return the placeholder. */
function invalid(x) {
  if (!errorLogged) {
    errorLogged = true;
    console.error('[format] refused to print a non-finite number:', x);
  }
  return INVALID;
}

/** Truncate v ≥ 0 to `dec` decimals and print exactly that many. */
function truncFixed(v, dec) {
  const p = 10 ** dec;
  return (Math.floor(v * p + EPS) / p).toFixed(dec);
}

/** Round v to `dec` decimals and print exactly that many. */
function roundFixed(v, dec) {
  const p = 10 ** dec;
  return (Math.round(v * p) / p).toFixed(dec);
}

/** Decimal exponent of x > 0 (robust against log10 rounding). */
function exp10(x) {
  let e = Math.floor(Math.log10(x));
  const m = x / 10 ** e;
  if (m >= 10 - 1e-12) e += 1;
  else if (m < 1) e -= 1;
  return e;
}

/** Three significant digits of a mantissa m in [1, 1000), truncated ("1.23", "45.6", "789"). */
function sig3(m) {
  let v = m;
  if (v >= 1000) v = 999.999; // guards a float edge right below the next group
  if (v < 10) return truncFixed(v, 2);
  if (v < 100) return truncFixed(v, 1);
  return truncFixed(v, 0);
}

/** Scientific with 3 significant digits: "1.23e45". */
function scientific(x) {
  const e = exp10(x);
  let m = x / 10 ** e;
  if (m >= 10) m = 9.999;
  return truncFixed(m, 2) + 'e' + e;
}

/** Engineering (exponent a multiple of 3): "12.3e6". */
function engineering(x) {
  const e = exp10(x);
  const g = Math.floor(e / 3) * 3;
  return sig3(x / 10 ** g) + 'e' + g;
}

/** x ≥ 1000 in the current notation. */
function big(x) {
  if (notation === 'scientific') return scientific(x);
  if (notation === 'engineering') return engineering(x);
  if (x >= SUFFIX_LIMIT) return scientific(x);
  const g = Math.floor(exp10(x) / 3);
  return sig3(x / 10 ** (3 * g)) + SUFFIXES[g];
}

/**
 * Format a number. kind 'count': integers below 1,000 (ants, hexes, levels). kind 'res' (default): one decimal below
 * 100, integer 100–999. From 1,000: 3 significant digits + suffix (K M B T Qa Qi Sx Sp Oc No Dc), then scientific
 * from 1e36 (or per notation). Negative values get a leading "−".
 * @param {number} x
 * @param {{ kind?: 'res'|'count' }} [opts]
 * @returns {string}
 */
export function fmt(x, { kind = 'res' } = {}) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return invalid(x);
  if (x < 0) return MINUS + fmt(-x, { kind });
  if (x < 1000) {
    if (kind === 'count') {
      const n = Math.floor(x + 1e-9);
      if (n < 1000) return String(n);
    } else if (x < 100) {
      const t = truncFixed(x, 1);
      if (Number(t) < 100) return t;
      return '100';
    } else {
      const n = Math.floor(x + 1e-9);
      if (n < 1000) return String(n);
    }
  }
  return big(x);
}

/** Shorthand for fmt(x, { kind: 'count' }). */
export function fmtCount(x) {
  return fmt(x, { kind: 'count' });
}

/** Two significant digits for 0 < x < 10 ("0.53", "3.2", "0.012"). */
function sig2(x) {
  if (x >= 1) return truncFixed(x, 1);
  if (x < 1e-4) return x.toExponential(1);
  const dec = 1 - exp10(x);
  return truncFixed(x, Math.min(dec, 6));
}

/**
 * Per-second rate: "0.53/s", "3.2/s", "12.4/s", "4.20K/s"; negative with a leading "−" (the caller adds the red
 * class). Below 10: two significant digits.
 * @param {number} x
 * @returns {string}
 */
export function fmtRate(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return invalid(x) + '/s';
  if (x < 0) return MINUS + fmtRate(-x);
  if (x === 0) return '0/s';
  if (x < 10) return sig2(x) + '/s';
  return fmt(x) + '/s';
}

/**
 * Multiplier: "×1.25", "×12.5", "×640", "×4.20M" (2 decimals below 10, then the suffix rules).
 * @param {number} x
 * @returns {string}
 */
export function fmtMult(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '×' + invalid(x);
  if (x < 0) return '×' + MINUS + fmtMult(-x).slice(1);
  if (Math.round(x * 100) / 100 < 10) return '×' + roundFixed(x, 2);
  if (Math.round(x * 10) / 10 < 100) return '×' + roundFixed(x, 1);
  if (Math.round(x) < 1000) return '×' + String(Math.round(x));
  return '×' + big(x);
}

/**
 * Percentage of a fraction: "+15%", "+2.5%" (one decimal below 10 %), "−20%".
 * @param {number} frac 0.15 → 15 %
 * @param {{ signed?: boolean }} [opts] signed (default) prefixes "+" on positive values
 * @returns {string}
 */
export function fmtPct(frac, { signed = true } = {}) {
  if (typeof frac !== 'number' || !Number.isFinite(frac)) return invalid(frac) + '%';
  const v = frac * 100;
  const sign = v < 0 ? MINUS : signed && v > 0 ? '+' : '';
  const a = Math.abs(v);
  let body;
  if (Math.round(a * 10) / 10 < 10) body = roundFixed(a, 1);
  else if (Math.round(a) < 1000) body = String(Math.round(a));
  else body = fmt(a, { kind: 'count' });
  return sign + body + '%';
}

/** Two-digit zero padding. */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * Duration: "45s", "4m 05s", "1h 23m", "2d 4h". Negative values (e.g. the −1 "never" sentinel) print "—".
 * @param {number} sec
 * @returns {string}
 */
export function fmtTime(sec) {
  if (typeof sec !== 'number' || Number.isNaN(sec)) return invalid(sec);
  if (sec < 0) return INVALID;
  if (!Number.isFinite(sec)) return invalid(sec);
  const s = Math.floor(sec + 1e-9);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + pad2(s % 60) + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + pad2(Math.floor((s % 3600) / 60)) + 'm';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  if (days >= 1000) return fmt(days, { kind: 'count' }) + 'd';
  return days + 'd ' + hours + 'h';
}

/**
 * Clock style "m:ss" (season dial, timers under an hour); longer values fall back to fmtTime.
 * @param {number} sec
 * @returns {string}
 */
export function fmtClock(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return INVALID;
  const s = Math.floor(sec + 1e-9);
  if (s >= 3600) return fmtTime(s);
  return Math.floor(s / 60) + ':' + pad2(s % 60);
}

/** Amount of a wallet resource held in state (0 when unknown). */
export function resAmount(s, res) {
  if (!s) return 0;
  let v;
  if (res === 'alates') v = s.cycle && s.cycle.alates;
  else if (res === 'kinship') v = s.era && s.era.kinship;
  else if (res === 'genes') v = s.meta && s.meta.genes;
  else v = s.run && s.run.res ? s.run.res[res] : 0;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Cost as display parts: [{ res, text, ok }] in resource order (ok = affordable now when `s` is given).
 * A null cost (above the cost cap) → [{ text: 'MAX', ok: false }]; an empty cost → [].
 * @param {Object|null} cost
 * @param {Object} [s] state, for affordability
 * @returns {Array<{ res?: string, text: string, ok: boolean }>}
 */
/** Prestige currencies counted in whole units (costs and balances print without decimals). */
const WHOLE_RES = new Set(['alates', 'kinship', 'genes']);

export function fmtCost(cost, s) {
  if (cost === null || cost === undefined) return [{ text: MAX_LABEL, ok: false }];
  if (typeof cost !== 'object') return [{ text: MAX_LABEL, ok: false }];
  const keys = Object.keys(cost).sort((a, b) => {
    const ia = RES_ORDER.indexOf(a);
    const ib = RES_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const out = [];
  for (const res of keys) {
    const need = cost[res];
    if (need === 0) continue;
    // Alates, kinship and genes are whole-number currencies: "5", not "5.0" (F18).
    const text = WHOLE_RES.has(res) ? fmtCount(need) : fmt(need);
    const ok = s ? Number.isFinite(need) && resAmount(s, res) >= need : true;
    out.push({ res, text, ok });
  }
  return out;
}
