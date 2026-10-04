// Colony History (C130): the gallery of past runs opened from the Prestige tab. One card per Strata record
// (s.meta.strata, newest first): a mini drawing of that run's nest silhouette on the soil strata, the run number, the
// layer that ended it (Nuptial Flight / Supercolony / Speciation), species, duration, peak ants, the currency earned
// and when. Older records (before C130) carry only kind / cells / at; their cards show what they have.
// Owner: WP9. Contract: ARCHITECTURE §14.5 (Prestige row), §18 C130; DESIGN §25.8.
// The silhouette decoder here is a small standalone copy of the 'bits:' (and legacy 'rle:') formats written by
// systems/prestige.strataSilhouette (core/save bitsEncode), so the UI imports neither core/save nor the nest renderer.

import { h } from './dom.js';
import { fmtCount, fmtTime } from './format.js';
import { nameOf, HISTORY_LAYERS, HISTORY_GAINS } from './text.js';
import { arr } from './reveal.js';
import { GRID, CELL } from '../data/balance.js';
import { LAYER_ORDER, LAYERS } from '../data/strata.js';

const BITS_PREFIX = 'bits:';
const RLE_PREFIX = 'rle:';
const BITS_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Soil colour per layer for the mini drawing (close to the Below view's strata). */
const LAYER_COLORS = { topsoil: '#6b4a2b', loam: '#5c3f25', clay: '#7a4b2c', gravel: '#5d554b', bedrock: '#45403c', aquifer: '#34424a' };
const CAVITY = '#1a110a';
const GRASS = '#5f8f3a';
/** Fewest rows a drawing shows (shallow nests still read as a nest under the surface). */
const MIN_ROWS = 18;

/**
 * Decode a Strata silhouette to an open-cell mask (1 = tunnel or chamber). 'bits:' = one base64url character per
 * 6 cells (bit i mod 6 of character ⌊i/6⌋); legacy 'rle:v*n,…' = full cell codes. Anything else → all closed.
 * @param {string} str
 * @param {number} [n=GRID.cols × GRID.rows]
 * @returns {Uint8Array}
 */
export function decodeSilhouette(str, n = GRID.cols * GRID.rows) {
  const out = new Uint8Array(Math.max(0, n | 0));
  if (typeof str !== 'string') return out;
  if (str.startsWith(BITS_PREFIX)) {
    for (let k = BITS_PREFIX.length; k < str.length; k++) {
      const v = BITS_ALPHA.indexOf(str[k]);
      if (v <= 0) continue;
      const base = (k - BITS_PREFIX.length) * 6;
      for (let b = 0; b < 6; b++) if ((v >> b) & 1 && base + b < out.length) out[base + b] = 1;
    }
  } else if (str.startsWith(RLE_PREFIX)) {
    let i = 0;
    for (const part of str.slice(RLE_PREFIX.length).split(',')) {
      if (!part) continue;
      const star = part.indexOf('*');
      const v = Number(star < 0 ? part : part.slice(0, star));
      const c = star < 0 ? 1 : Number(part.slice(star + 1));
      if (!Number.isFinite(c) || c < 1) break;
      const open = v === CELL.TUNNEL || v === CELL.CHAMBER;
      for (let j = 0; j < c && i < out.length; j++, i++) if (open) out[i] = 1;
    }
  }
  return out;
}

/**
 * Rows a drawing shows: the surface down to 3 rows below the deepest open cell, at least MIN_ROWS.
 * @param {Uint8Array} mask
 * @param {number} [cols=GRID.cols]
 * @param {number} [rows=GRID.rows]
 * @returns {number}
 */
export function silhouetteRows(mask, cols = GRID.cols, rows = GRID.rows) {
  let deep = -1;
  for (let i = mask.length - 1; i >= 0; i--) {
    if (mask[i]) {
      deep = Math.floor(i / cols);
      break;
    }
  }
  return Math.min(rows, Math.max(MIN_ROWS, deep + 4));
}

/** Layer id of a nest row. */
function layerAt(y) {
  for (const id of LAYER_ORDER) if (LAYERS[id] && y >= LAYERS[id].y0 && y <= LAYERS[id].y1) return id;
  return LAYER_ORDER[LAYER_ORDER.length - 1];
}

/**
 * Draw a nest silhouette into a canvas: a grass line, soil bands per layer, open cells as dark cavities.
 * Sizes the canvas backing store itself (CSS scales it). Returns false without a 2D context (tests, old browsers).
 * @param {HTMLCanvasElement} canvas
 * @param {string} cells Strata record cells
 * @param {{ cell?: number }} [opts]
 * @returns {boolean}
 */
export function drawSilhouette(canvas, cells, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return false;
  const cols = GRID.cols;
  const mask = decodeSilhouette(cells, cols * GRID.rows);
  const rows = silhouetteRows(mask, cols, GRID.rows);
  const k = opts.cell > 0 ? opts.cell : 4;
  const top = 2 * k;
  canvas.width = cols * k;
  canvas.height = rows * k + top;
  let g = null;
  try { g = canvas.getContext('2d'); } catch { g = null; }
  if (!g) return false;
  g.fillStyle = GRASS;
  g.fillRect(0, 0, canvas.width, top);
  for (let y = 0; y < rows; y++) {
    g.fillStyle = LAYER_COLORS[layerAt(y)] || LAYER_COLORS.loam;
    g.fillRect(0, top + y * k, canvas.width, k);
  }
  g.fillStyle = CAVITY;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!mask[y * cols + x]) continue;
      // merge horizontal runs into one rect (fewer calls, no seams)
      let x2 = x;
      while (x2 + 1 < cols && mask[y * cols + x2 + 1]) x2++;
      g.fillRect(x * k, top + y * k, (x2 - x + 1) * k, k);
      x = x2;
    }
  }
  return true;
}

/**
 * Wall-clock minutes since the epoch → "4 Oct 2026, 14:32" (local time).
 * @param {number} min
 * @returns {string}
 */
export function fmtDate(min) {
  const t = new Date(min * 60000);
  if (!Number.isFinite(t.getTime())) return '';
  const p2 = (v) => (v < 10 ? '0' : '') + v;
  return t.getDate() + ' ' + MONTHS[t.getMonth()] + ' ' + t.getFullYear() + ', ' + p2(t.getHours()) + ':' + p2(t.getMinutes());
}

/**
 * Card data for every Strata record, newest first. Fields a record lacks are null (the card skips that row).
 * @param {Object} s
 * @returns {Array<{ key: string, kind: string, title: string, layer: string, species: string|null, duration: string|null,
 *   peak: string|null, gain: string|null, when: string, hardship: string|null, cells: string }>}
 */
export function historyCards(s) {
  const recs = arr(s && s.meta && s.meta.strata);
  const out = [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (!r || typeof r !== 'object') continue;
    const kind = HISTORY_LAYERS[r.kind] ? r.kind : 'run';
    const has = (k) => typeof r[k] === 'number' && Number.isFinite(r[k]);
    out.push({
      key: (has('at') ? r.at : i) + ':' + kind + ':' + i,
      kind,
      title: has('n') ? 'Run ' + fmtCount(r.n) : 'Past run',
      layer: HISTORY_LAYERS[kind],
      species: typeof r.sp === 'string' ? nameOf('species', r.sp) : null,
      duration: has('dur') ? fmtTime(Math.max(0, r.dur)) : null,
      peak: has('peak') ? fmtCount(Math.max(0, r.peak)) + ' ants' : null,
      gain: has('gain') ? '+' + fmtCount(Math.max(0, r.gain)) + ' ' + HISTORY_GAINS[kind] : null,
      when: has('date') && r.date > 0 ? fmtDate(r.date) : has('at') ? 'After ' + fmtTime(Math.max(0, r.at)) + ' of play' : '',
      hardship: typeof r.hs === 'string' && r.hs ? nameOf('hardship', r.hs) : null,
      cells: typeof r.cells === 'string' ? r.cells : '',
    });
  }
  return out;
}

/**
 * One gallery card element (the canvas is drawn by the caller once attached, or right away).
 * @param {ReturnType<typeof historyCards>[number]} c
 * @returns {HTMLElement}
 */
export function historyCard(c) {
  const canvas = h('canvas', { class: 'history-nest', attrs: { role: 'img', 'aria-label': c.title + ' nest layout' } });
  drawSilhouette(canvas, c.cells);
  const kv = h('dl', { class: 'history-kv' });
  const row = (label, value) => {
    if (value) kv.append(h('dt', { text: label }), h('dd', { text: value }));
  };
  row('Species', c.species);
  row('Duration', c.duration);
  row('Peak', c.peak);
  row('Earned', c.gain);
  row('Hardship', c.hardship);
  return h('article', { class: 'history-card history-' + c.kind, dataset: { key: c.key } },
    canvas,
    h('div', { class: 'history-head' },
      h('h4', { class: 'history-title', text: c.title }),
      h('span', { class: 'history-layer', text: c.layer })),
    kv,
    c.when ? h('p', { class: 'history-when', text: c.when }) : null);
}

/**
 * Gallery body: a note and a responsive grid of cards (or an empty-state note).
 * @param {Object} s
 * @returns {HTMLElement}
 */
export function historyGallery(s) {
  const cards = historyCards(s);
  if (!cards.length) return h('p', { class: 'note', text: 'No past runs yet. Your first Nuptial Flight starts the record.' });
  return h('div', { class: 'history-wrap' },
    h('p', { class: 'note', text: 'Your last ' + fmtCount(cards.length) + ' nests, newest first. Older runs fade from the record.' }),
    h('div', { class: 'history-grid' }, cards.map(historyCard)));
}

/**
 * Open the Colony History gallery in a modal.
 * @param {{ game: Object, modals: Object }} ctx
 */
export function openColonyHistory(ctx) {
  const { game, modals } = ctx;
  return modals.open({
    title: 'Colony History', className: 'modal-wide modal-history', tag: 'history',
    body: [historyGallery(game.s)],
    actions: [{ label: 'Close', kind: 'primary', id: 'close' }],
  });
}

/** Number of recorded past runs (Prestige tab button label). */
export function historyCount(s) {
  return arr(s && s.meta && s.meta.strata).filter((r) => r && typeof r === 'object').length;
}
