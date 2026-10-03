// Nest geometry: cell indexing, layers, footprints, cell work, diggability, BFS / Dijkstra routing, adjacency,
// frost exposure, and the geometry cache (chamberAt / open / dist / entDist) shared with nest.js. Owner: WP3.
// Contract: ARCHITECTURE §8.2 (nestgeom.js), §5 (d.nest typed arrays), DESIGN §7.1–§7.9.
// Pure helpers: render and the pacing bot may call every export; nothing here mutates the state.

import { GRID, CELL } from '../data/balance.js';
import { LAYER_ORDER, LAYERS, DIG, GEOM } from '../data/strata.js';
import { CHAMBERS } from '../data/chambers.js';
import { RESEARCH } from '../data/research.js';
import { TRAITS } from '../data/bloodline.js';
import { FEDERATION } from '../data/federation.js';
import { BOONS, EDICTS, HARDSHIP } from '../data/prestige.js';

const COLS = GRID.cols;
const ROWS = GRID.rows;
const NCELLS = COLS * ROWS;
const LAYER_INDEX = Object.freeze(Object.fromEntries(LAYER_ORDER.map((id, i) => [id, i])));

// ------------------------------------------------------------------------------------------------------------------
// Ownership / modifier lookups (WP3-internal helpers, exported for nest.js and nestgen.js)
// ------------------------------------------------------------------------------------------------------------------

/**
 * True if research `id` is owned this run (innate research is granted into run.research by WP5 at run start).
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {boolean}
 */
export function hasResearch(s, id) {
  return !!(s.run.research && s.run.research[id]);
}

/**
 * Bloodline trait level (0 if not owned).
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {number}
 */
export function traitLevel(s, id) {
  const v = s.cycle.traits && s.cycle.traits[id];
  return v > 0 ? v : 0;
}

/**
 * Federation node level (0 if not owned).
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {number}
 */
export function fedLevel(s, id) {
  const v = s.era.federation && s.era.federation[id];
  return v > 0 ? v : 0;
}

/**
 * True if achievement `id` is earned (meta.achievements stores the simTime, which may be 0).
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {boolean}
 */
export function hasAch(s, id) {
  const a = s.meta.achievements;
  return !!a && Object.prototype.hasOwnProperty.call(a, id);
}

/**
 * True if the run carries landing-site tag `tag`.
 * @param {import('../core/types.js').State} s
 * @param {string} tag
 * @returns {boolean}
 */
export function hasTag(s, tag) {
  const t = s.run.landingTags;
  return Array.isArray(t) && t.includes(tag);
}

/**
 * Effective hardship reward tier: max(cycle tier, carry × era best) (same formula as hardships.effectiveTier, read
 * straight from state so cellWork needs no derived cache).
 * @param {import('../core/types.js').State} s
 * @param {string} id hardship id
 * @returns {number}
 */
export function hardshipTier(s, id) {
  const c = (s.cycle.hardshipTier && s.cycle.hardshipTier[id]) || 0;
  const e = (s.era.hardshipBest && s.era.hardshipBest[id]) || 0;
  const carry = Number.isFinite(HARDSHIP && HARDSHIP.carry) ? HARDSHIP.carry : 0;
  return Math.max(c, carry * e);
}

const FX_TABLES = Object.freeze({ research: RESEARCH, trait: TRAITS, federation: FEDERATION, edict: EDICTS, boon: BOONS });

/**
 * Read an fx number from another package's table (ARCHITECTURE §6: consumers read fx and never hardcode the number);
 * 0 when the entry is missing.
 * @param {'research'|'trait'|'federation'|'edict'|'boon'} table
 * @param {string} id
 * @param {string} key
 * @returns {number}
 */
export function fxNum(table, id, key) {
  const t = FX_TABLES[table];
  const e = t && t[id];
  const v = e && e.fx && e.fx[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * True for an open cell code (TUNNEL or a dug CHAMBER cell).
 * @param {number} code
 * @returns {boolean}
 */
export function isOpenCode(code) {
  return code === CELL.TUNNEL || code === CELL.CHAMBER;
}

// ------------------------------------------------------------------------------------------------------------------
// §8.2 pure helpers
// ------------------------------------------------------------------------------------------------------------------

/**
 * Cell index of (x, y): y * 40 + x.
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function idx(x, y) {
  return y * COLS + x;
}

/**
 * Cell coordinates of index i.
 * @param {number} i
 * @returns {[number, number]}
 */
export function xy(i) {
  return [i % COLS, Math.floor(i / COLS)];
}

/**
 * True if (x, y) is an integer cell inside the 40 × 80 grid.
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function inBounds(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < COLS && y < ROWS;
}

/**
 * Layer id holding row y (rows outside the grid clamp to the top / bottom layer).
 * @param {number} y
 * @returns {string}
 */
export function layerOf(y) {
  const r = y < 0 ? 0 : y >= ROWS ? ROWS - 1 : y;
  for (let k = 0; k < LAYER_ORDER.length; k++) {
    const L = LAYERS[LAYER_ORDER[k]];
    if (r >= L.y0 && r <= L.y1) return L.id;
  }
  return LAYER_ORDER[LAYER_ORDER.length - 1];
}

/**
 * Chamber footprint at a level (DESIGN §7.4): growing types w = w0 + min(L,8) − 1, h = h0 + floor((min(L,8) − 1)/3);
 * others w0 × h0. Level 0 (being dug) uses the L1 footprint. Unknown type → { w: 0, h: 0 }.
 * @param {string} type
 * @param {number} level
 * @returns {{ w: number, h: number }}
 */
export function footprint(type, level) {
  const def = CHAMBERS[type];
  if (!def) return { w: 0, h: 0 };
  if (!def.grows) return { w: def.w0, h: def.h0 };
  const L = Math.max(1, Math.min(Math.floor(level) || 1, GEOM.footprintMaxL));
  return { w: def.w0 + L - 1, h: def.h0 + Math.floor((L - 1) / 3) };
}

/**
 * In-bounds cell indices of a rectangle, row by row.
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {number[]}
 */
export function rectCells(x, y, w, h) {
  const out = [];
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) if (inBounds(xx, yy)) out.push(idx(xx, yy));
  }
  return out;
}

/**
 * Work-modifier context for a state (computed once, reused for many cells by routing and queue estimates).
 * @param {import('../core/types.js').State} s
 * @returns {Object}
 */
export function workCtx(s) {
  const tier = hardshipTier(s, 'shallow_soil');
  let bpDiv = 1;
  if (fedLevel(s, 'blueprint_memory') > 0) bpDiv = fxNum('federation', 'blueprint_memory', 'cellDiv') || 1;
  else if (traitLevel(s, 'ancestral_blueprint') > 0) bpDiv = DIG.blueprintCellDiv;
  let rush = 1;
  if (s.run.boon === 'boon_blueprint_rush' && s.run.time < fxNum('boon', 'boon_blueprint_rush', 'sec')) {
    rush = fxNum('boon', 'boon_blueprint_rush', 'mult') || 1;
  }
  return {
    cells: s.run.nest.cells,
    masonry: hasResearch(s, 'clay_masonry'),
    richLoam: hasTag(s, 'site_rich_loam'),
    shallow: tier > 0 ? Math.max(0, 1 - DIG.shallowSoilRewardPerTier * tier) : 1,
    stone: fxNum('research', 'acid_excavation', 'stone') || 1,
    tunnel: (hasResearch(s, 'load_chains') ? fxNum('research', 'load_chains', 'tunnel') || 1 : 1)
      * (hasAch(s, 'ach_going_under') ? DIG.goingUnderTunnelMult : 1),
    bpDiv,
    rush,
  };
}

/**
 * Cell work with a precomputed context (see cellWork).
 * @param {Object} ctx from workCtx(s)
 * @param {number} i
 * @param {string} kind 'tunnel'|'shaft'|'chamber'|'grow'|'relocate'
 * @param {boolean} [blueprint=false]
 * @returns {number}
 */
export function workAt(ctx, i, kind, blueprint = false) {
  const y = Math.floor(i / COLS);
  const layer = layerOf(y);
  const L = LAYERS[layer];
  let w = L.work;
  if (ctx.masonry && Number.isFinite(L.workMasonry)) w = L.workMasonry;
  if (ctx.richLoam && (layer === 'topsoil' || layer === 'loam')) w *= DIG.richLoamMult;
  w *= ctx.shallow;
  if (ctx.cells[i] === CELL.STONE) w *= ctx.stone;
  if (kind === 'chamber' || kind === 'grow' || kind === 'relocate') w *= DIG.chamberCellMult;
  else if (kind === 'tunnel' || kind === 'shaft') w *= ctx.tunnel;
  if (blueprint) w = w / ctx.bpDiv / ctx.rush;
  return w;
}

/**
 * [q] Work to dig cell i (DESIGN §7.1–§7.3, §12.3): layer work (clay 7.2 with clay_masonry; topsoil/loam ×0.8 with
 * site_rich_loam; ×(1 − 0.05 × shallow_soil reward tier); stone ×3 with acid_excavation) × kind ('chamber' | 'grow' |
 * 'relocate' ×1.5; 'tunnel' / 'shaft' ×0.5 with load_chains and ×0.95 with ach_going_under) ÷ 3 (ancestral_blueprint)
 * or ÷ 5 (blueprint_memory) for blueprint jobs, ÷ 2 while boon_blueprint_rush. Relocation's 50 % factor is applied by
 * the job, not here.
 * @param {import('../core/types.js').State} s
 * @param {number} i cell index
 * @param {string} kind
 * @param {{ blueprint?: boolean }} [opts]
 * @returns {number}
 */
export function cellWork(s, i, kind, { blueprint = false } = {}) {
  if (!(i >= 0 && i < NCELLS)) return 0;
  return workAt(workCtx(s), i, kind, blueprint);
}

/**
 * True if the layer requirement of row y is met (bedrock: acid_excavation; aquifer: federation aquifer_access).
 * @param {import('../core/types.js').State} s
 * @param {number} y
 * @returns {boolean}
 */
export function layerOpen(s, y) {
  const req = LAYERS[layerOf(y)].req;
  if (!req) return true;
  if (req.research && !hasResearch(s, req.research)) return false;
  if (req.federation && fedLevel(s, req.federation) <= 0) return false;
  return true;
}

/**
 * [q] True if cell i can be dug now: SOIL (or STONE with acid_excavation), its layer requirement met, and, in a
 * shallow_soil hardship run, y ≤ 23.
 * @param {import('../core/types.js').State} s
 * @param {number} i
 * @returns {boolean}
 */
export function isDiggable(s, i) {
  if (!(Number.isInteger(i) && i >= 0 && i < NCELLS)) return false;
  const code = s.run.nest.cells[i];
  if (code !== CELL.SOIL && !(code === CELL.STONE && hasResearch(s, 'acid_excavation'))) return false;
  const y = Math.floor(i / COLS);
  if (!layerOpen(s, y)) return false;
  if (s.run.hardship === 'shallow_soil' && y > DIG.shallowSoilRow) return false;
  return true;
}

/**
 * Path distances (in cells) over open cells, 4-neighbour BFS. Only open start cells are seeded (distance 0).
 * @param {ArrayLike<number>} open 1 = open
 * @param {number[]} starts
 * @returns {Int16Array} −1 = unreachable
 */
export function bfs(open, starts) {
  const n = open ? open.length : 0;
  const dist = new Int16Array(n).fill(-1);
  if (!n) return dist;
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const st of starts || []) {
    if (st >= 0 && st < n && open[st] && dist[st] < 0) {
      dist[st] = 0;
      q[tail++] = st;
    }
  }
  while (head < tail) {
    const c = q[head++];
    const x = c % COLS;
    const nd = dist[c] + 1;
    if (x > 0 && open[c - 1] && dist[c - 1] < 0) { dist[c - 1] = nd; q[tail++] = c - 1; }
    if (x < COLS - 1 && open[c + 1] && dist[c + 1] < 0) { dist[c + 1] = nd; q[tail++] = c + 1; }
    if (c >= COLS && open[c - COLS] && dist[c - COLS] < 0) { dist[c - COLS] = nd; q[tail++] = c - COLS; }
    if (c + COLS < n && open[c + COLS] && dist[c + COLS] < 0) { dist[c + COLS] = nd; q[tail++] = c + COLS; }
  }
  return dist;
}

/**
 * 4-neighbours of cell i inside the grid (fresh array).
 * @param {number} i
 * @returns {number[]}
 */
export function neighbors4(i) {
  const out = [];
  const x = i % COLS;
  if (x > 0) out.push(i - 1);
  if (x < COLS - 1) out.push(i + 1);
  if (i >= COLS) out.push(i - COLS);
  if (i + COLS < NCELLS) out.push(i + COLS);
  return out;
}

/**
 * Cells 4-adjacent to a rectangle (outside it, inside the grid).
 * @param {{ x: number, y: number, w: number, h: number }} r
 * @returns {number[]}
 */
export function perimeter(r) {
  const out = [];
  for (let xx = r.x; xx < r.x + r.w; xx++) {
    if (inBounds(xx, r.y - 1)) out.push(idx(xx, r.y - 1));
    if (inBounds(xx, r.y + r.h)) out.push(idx(xx, r.y + r.h));
  }
  for (let yy = r.y; yy < r.y + r.h; yy++) {
    if (inBounds(r.x - 1, yy)) out.push(idx(r.x - 1, yy));
    if (inBounds(r.x + r.w, yy)) out.push(idx(r.x + r.w, yy));
  }
  return out;
}

/**
 * True if cell i lies in rectangle r.
 * @param {{ x: number, y: number, w: number, h: number }} r
 * @param {number} i
 * @returns {boolean}
 */
export function inRect(r, i) {
  const x = i % COLS;
  const y = Math.floor(i / COLS);
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// ------------------------------------------------------------------------------------------------------------------
// Geometry cache (d.nest typed arrays). Rebuilt by nest.js whenever s.run.nest.rev changes.
// ------------------------------------------------------------------------------------------------------------------

/**
 * Build (or rebuild in place) the geometry cache of the nest: chamberAt, open, dist (BFS from the main shaft top),
 * entDist (BFS from every open shaft top), plus WP3-private masks _shaft (1 main shaft, 2 other shafts), _queued
 * (undug cells of queued jobs), _backfill (pending backfill), _root (root-line cells), _pocket (water pocket index).
 * @param {import('../core/types.js').State} s
 * @param {Object} [out] object to fill (d.nest); a fresh object when omitted
 * @returns {Object} out
 */
export function buildGeom(s, out = {}) {
  const nest = s.run.nest;
  const cells = nest.cells;
  const reuse = (k, Ctor, fill) => {
    let a = out[k];
    if (!(a instanceof Ctor) || a.length !== NCELLS) a = new Ctor(NCELLS);
    a.fill(fill);
    out[k] = a;
    return a;
  };
  const chamberAt = reuse('chamberAt', Int16Array, -1);
  const open = reuse('open', Uint8Array, 0);
  const shaft = reuse('_shaft', Uint8Array, 0);
  const queued = reuse('_queued', Uint8Array, 0);
  const backfill = reuse('_backfill', Uint8Array, 0);
  const root = reuse('_root', Uint8Array, 0);
  const pocket = reuse('_pocket', Int8Array, -1);

  for (let i = 0; i < NCELLS; i++) if (isOpenCode(cells[i])) open[i] = 1;
  const chs = nest.chambers;
  for (let j = 0; j < chs.length; j++) {
    const ch = chs[j];
    for (let yy = ch.y; yy < ch.y + ch.h; yy++) {
      for (let xx = ch.x; xx < ch.x + ch.w; xx++) if (inBounds(xx, yy)) chamberAt[idx(xx, yy)] = j;
    }
  }
  const tops = [];
  for (const sh of nest.shafts) {
    if (!sh || !sh.open || !(sh.col >= 0 && sh.col < COLS)) continue;
    const top = idx(sh.col, 0);
    if (open[top]) tops.push(top);
    for (let y = 0; y < ROWS; y++) {
      const c = idx(sh.col, y);
      if (cells[c] !== CELL.TUNNEL) break;
      if (!shaft[c] || sh.kind === 'main') shaft[c] = sh.kind === 'main' ? 1 : 2;
    }
  }
  for (const job of nest.queue) {
    for (let k = job.cur; k < job.cells.length; k++) {
      const c = job.cells[k];
      if (c >= 0 && c < NCELLS && !open[c]) queued[c] = 1;
    }
  }
  for (const b of nest.backfill) if (b && b.i >= 0 && b.i < NCELLS) backfill[b.i] = 1;
  const f = nest.features || {};
  for (const r of f.roots || []) {
    for (let y = r.y0; y <= r.y1; y++) if (inBounds(r.col, y)) root[idx(r.col, y)] = 1;
  }
  const water = f.water || [];
  for (let p = 0; p < water.length && p < 127; p++) {
    const w = water[p];
    for (let yy = w.y; yy < w.y + w.h; yy++) {
      for (let xx = w.x; xx < w.x + w.w; xx++) if (inBounds(xx, yy)) pocket[idx(xx, yy)] = p;
    }
  }
  out.dist = bfs(open, [idx(GRID.mainCol, 0)]);
  out.entDist = bfs(open, tops);
  out.rev = nest.rev;
  out._cells = cells;
  return out;
}

const GEO_MEMO = new WeakMap();

/**
 * Fresh geometry for queries: d.nest when it matches s.run.nest (same cells array and rev), otherwise a temporary
 * geometry built from the state (memoised per cells array and rev; d is not written).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} [d]
 * @returns {Object}
 */
export function getGeom(s, d) {
  const nest = s.run.nest;
  const dn = d && d.nest;
  if (dn && dn._cells === nest.cells && dn.rev === nest.rev && dn.chamberAt && dn._shaft) return dn;
  const m = GEO_MEMO.get(nest.cells);
  if (m && m.rev === nest.rev && m.chambers === nest.chambers && m.queue === nest.queue) return m.geo;
  const geo = buildGeom(s, {});
  GEO_MEMO.set(nest.cells, { rev: nest.rev, chambers: nest.chambers, queue: nest.queue, geo });
  return geo;
}

/**
 * True if the geometry stored in d.nest is current for s.run.nest.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {boolean}
 */
export function geomFresh(s, d) {
  const dn = d.nest;
  return !!dn && dn._cells === s.run.nest.cells && dn.rev === s.run.nest.rev && !!dn.chamberAt && !!dn._shaft;
}

/**
 * Gap field around a source cell set: source cells get 0; open tunnel cells (open and outside every chamber footprint
 * and outside `exclude`) reached through 4-neighbours get the number of tunnel cells on the path (1 = adjacent to the
 * source), up to maxGap. −1 elsewhere. A target rectangle is within the gap when any of its perimeter cells has a
 * value ≥ 0 (DESIGN §7.7: footprints touch, or a path of ≤ N open cells joins them).
 * ARCH-R: path cells are tunnels only (not other chambers' cells); the contract says "open cells".
 * @param {Object} geo
 * @param {number[]} src
 * @param {number} maxGap
 * @param {Uint8Array|null} [exclude] cells that may not be path cells (e.g. a hypothetical footprint)
 * @returns {Int16Array}
 */
export function gapField(geo, src, maxGap, exclude = null) {
  const field = new Int16Array(NCELLS).fill(-1);
  const q = new Int32Array(NCELLS);
  let head = 0;
  let tail = 0;
  for (const c of src) {
    if (c >= 0 && c < NCELLS && field[c] < 0) { field[c] = 0; q[tail++] = c; }
  }
  while (head < tail) {
    const c = q[head++];
    const nd = field[c] + 1;
    if (nd > maxGap) continue;
    const x = c % COLS;
    const ns = [x > 0 ? c - 1 : -1, x < COLS - 1 ? c + 1 : -1, c - COLS, c + COLS];
    for (const n of ns) {
      if (n < 0 || n >= NCELLS || field[n] >= 0) continue;
      if (!geo.open[n] || geo.chamberAt[n] >= 0 || (exclude && exclude[n])) continue;
      field[n] = nd;
      q[tail++] = n;
    }
  }
  return field;
}

/**
 * True if any perimeter cell of rectangle r has a field value ≥ 0 (see gapField), or r overlaps a source cell.
 * @param {Int16Array} field
 * @param {{ x: number, y: number, w: number, h: number }} r
 * @returns {boolean}
 */
export function rectNear(field, r) {
  for (const p of perimeter(r)) if (field[p] >= 0) return true;
  return false;
}

/** Resolve a chamber reference (Chamber object, uid or rect) to a rect, or null. */
function toRect(s, ref) {
  if (ref && typeof ref === 'object' && Number.isFinite(ref.x) && Number.isFinite(ref.w)) return ref;
  if (typeof ref === 'number') {
    for (const ch of s.run.nest.chambers) if (ch.uid === ref) return ch;
  }
  return null;
}

/**
 * [q] Two chambers are adjacent if their footprints touch or a path of ≤ 4 open (tunnel) cells joins them
 * (DESIGN §7.7). a and b may be Chamber objects, chamber uids, or { x, y, w, h } rectangles (ghost footprints).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {Object|number} a
 * @param {Object|number} b
 * @returns {boolean}
 */
export function adjacent(s, d, a, b) {
  const ra = toRect(s, a);
  const rb = toRect(s, b);
  if (!ra || !rb || ra === rb) return false;
  const geo = getGeom(s, d);
  const ex = new Uint8Array(NCELLS);
  for (const c of rectCells(rb.x, rb.y, rb.w, rb.h)) ex[c] = 1;
  const field = gapField(geo, rectCells(ra.x, ra.y, ra.w, ra.h), GEOM.adjPathMax, ex);
  return rectNear(field, rb);
}

/**
 * True if more than half of the chamber's cells have y < row (frost line / frost snap exposure, DESIGN §17.3).
 * @param {{ y: number, h: number }} ch
 * @param {number} row
 * @returns {boolean}
 */
export function exposedTo(ch, row) {
  if (!ch || !(row > 0) || !(ch.h > 0)) return false;
  const above = Math.max(0, Math.min(ch.h, Math.ceil(row) - ch.y));
  return 2 * above > ch.h;
}

// ------------------------------------------------------------------------------------------------------------------
// Routing (Dijkstra over cell work; the heuristic would be 0 because open cells cost nothing, so plain Dijkstra)
// ------------------------------------------------------------------------------------------------------------------

/** Binary min-heap keyed by (cost, index) for deterministic ties. */
function heapPush(hc, hi, n, cost, i) {
  let k = n;
  hc[k] = cost;
  hi[k] = i;
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (hc[p] < hc[k] || (hc[p] === hc[k] && hi[p] <= hi[k])) break;
    const tc = hc[p]; hc[p] = hc[k]; hc[k] = tc;
    const ti = hi[p]; hi[p] = hi[k]; hi[k] = ti;
    k = p;
  }
  return n + 1;
}

function heapPop(hc, hi, n) {
  const last = n - 1;
  hc[0] = hc[last];
  hi[0] = hi[last];
  let k = 0;
  for (;;) {
    const l = 2 * k + 1;
    const r = l + 1;
    let m = k;
    if (l < last && (hc[l] < hc[m] || (hc[l] === hc[m] && hi[l] < hi[m]))) m = l;
    if (r < last && (hc[r] < hc[m] || (hc[r] === hc[m] && hi[r] < hi[m]))) m = r;
    if (m === k) break;
    const tc = hc[m]; hc[m] = hc[k]; hc[k] = tc;
    const ti = hi[m]; hi[m] = hi[k]; hi[k] = ti;
    k = m;
  }
  return last;
}

/**
 * Multi-source Dijkstra over the nest: from reachable open cells (or `from`) through open cells (free) and diggable
 * SOIL cells outside every footprint and pending backfill (cost = tunnel work). Stones and water are impassable
 * (DESIGN §7.2). Returns the cost field and predecessor array; stops early when `isGoal(i)` is popped.
 * @param {import('../core/types.js').State} s
 * @param {Object} geo
 * @param {{ from?: number[]|null, isGoal?: ((i: number) => boolean)|null, blocked?: Uint8Array|null }} opts
 * @returns {{ cost: Float64Array, prev: Int32Array, goal: number }}
 */
export function digField(s, geo, { from = null, isGoal = null, blocked = null } = {}) {
  const cost = new Float64Array(NCELLS).fill(Infinity);
  const prev = new Int32Array(NCELLS).fill(-1);
  const ctx = workCtx(s);
  const cells = s.run.nest.cells;
  const hc = new Float64Array(NCELLS * 6 + 8);
  const hi = new Int32Array(NCELLS * 6 + 8);
  let n = 0;
  const starts = [];
  if (Array.isArray(from)) {
    for (const c of from) if (c >= 0 && c < NCELLS) starts.push(c);
  } else {
    for (let i = 0; i < NCELLS; i++) if (geo.open[i] && geo.entDist[i] >= 0 && !geo._backfill[i]) starts.push(i);
  }
  for (const c of starts) {
    if (cost[c] === 0) continue;
    cost[c] = 0;
    n = heapPush(hc, hi, n, 0, c);
  }
  const passCost = (i) => {
    if (blocked && blocked[i]) return -1;
    if (geo._backfill[i]) return -1;
    if (geo.open[i]) return 0;
    if (cells[i] !== CELL.SOIL || geo.chamberAt[i] >= 0) return -1;
    if (!isDiggable(s, i)) return -1;
    return workAt(ctx, i, 'tunnel');
  };
  let goal = -1;
  while (n > 0) {
    const c = hc[0];
    const i = hi[0];
    n = heapPop(hc, hi, n);
    if (c > cost[i]) continue;
    if (isGoal && isGoal(i)) { goal = i; break; }
    const x = i % COLS;
    const ns = [x > 0 ? i - 1 : -1, x < COLS - 1 ? i + 1 : -1, i - COLS, i + COLS];
    for (const nb of ns) {
      if (nb < 0 || nb >= NCELLS) continue;
      const w = passCost(nb);
      if (w < 0) continue;
      const nc = c + w;
      if (nc < cost[nb]) {
        cost[nb] = nc;
        prev[nb] = i;
        if (n >= hc.length) break;
        n = heapPush(hc, hi, n, nc, nb);
      }
    }
  }
  return { cost, prev, goal };
}

/**
 * Reconstruct the undug cells of a digField path ending at `end` (start → end order, open cells dropped).
 * @param {import('../core/types.js').State} s
 * @param {Int32Array} prev
 * @param {number} end
 * @returns {number[]}
 */
export function pathCells(s, prev, end) {
  const out = [];
  const cells = s.run.nest.cells;
  let c = end;
  let guard = 0;
  while (c >= 0 && guard++ < NCELLS) {
    if (!isOpenCode(cells[c])) out.push(c);
    c = prev[c];
  }
  return out.reverse();
}

/**
 * [q] A* / Dijkstra tunnel route from any reachable open cell (or from `from`) to a cell 4-adjacent to any target
 * (DESIGN §7.2 auto-route): weight = cellWork('tunnel'); stone, water, chamber footprints and pending backfill are
 * impassable; target cells themselves are never path cells. Returns the cells to dig (in dig order) and their work;
 * { cells: [], work: 0 } when a start already touches a target; null when unreachable.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number[]} targets
 * @param {{ from?: number[]|null }} [opts]
 * @returns {{ cells: number[], work: number } | null}
 */
export function routeTo(s, d, targets, { from = null } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const geo = getGeom(s, d);
  const tgt = new Uint8Array(NCELLS);
  let any = false;
  for (const t of targets) if (Number.isInteger(t) && t >= 0 && t < NCELLS) { tgt[t] = 1; any = true; }
  if (!any) return null;
  const isGoal = (i) => {
    if (tgt[i]) return false;
    const x = i % COLS;
    return (x > 0 && tgt[i - 1] === 1) || (x < COLS - 1 && tgt[i + 1] === 1)
      || (i >= COLS && tgt[i - COLS] === 1) || (i + COLS < NCELLS && tgt[i + COLS] === 1);
  };
  const { prev, goal } = digField(s, geo, { from, isGoal, blocked: tgt });
  if (goal < 0) return null;
  const cells = pathCells(s, prev, goal);
  const ctx = workCtx(s);
  let work = 0;
  for (const c of cells) work += workAt(ctx, c, 'tunnel');
  return { cells, work };
}

/** Index of a layer id in LAYER_ORDER (−1 unknown). */
export function layerIndex(id) {
  const k = LAYER_INDEX[id];
  return k === undefined ? -1 : k;
}

/**
 * Majority layer of a rectangle (DESIGN §7.1: ties go to the deeper layer).
 * @param {{ y: number, h: number, w: number }} r
 * @returns {string}
 */
export function rectLayer(r) {
  const count = new Array(LAYER_ORDER.length).fill(0);
  for (let yy = r.y; yy < r.y + r.h; yy++) count[layerIndex(layerOf(yy))] += r.w;
  let best = 0;
  for (let k = 1; k < count.length; k++) if (count[k] >= count[best] && count[k] > 0) best = k;
  return LAYER_ORDER[best];
}

/** Grid size helpers re-exported for nest.js: cell count, columns, rows. */
export { NCELLS, COLS, ROWS };
