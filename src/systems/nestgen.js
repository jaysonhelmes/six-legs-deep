// Per-run nest generation: the default grid plus seeded soil features (root lines, stones, water pockets, caches and
// the amber bead) and, for polygyne species, extra pre-dug Royal Chambers. Owner: WP3.
// Contract: ARCHITECTURE §8.2 (nestgen.js), §7.9 (RNG holder), DESIGN §7.1, §7.9, §13.6 (site tags), §15.6 (fire ant).

import { GRID, CELL } from '../data/balance.js';
import { ROOTS, STONES, CACHES, WATER, SITE_MODS, GEN } from '../data/soilFeatures.js';
import { LAYERS, GEOM } from '../data/strata.js';
import { CHAMBERS } from '../data/chambers.js';
import { FLIGHT } from '../data/prestige.js';
import { makeHolder, randInt, weighted } from '../core/rng.js';
import { defaultNestCells } from '../core/state.js';
import { idx, inBounds, footprint, useCols, COLS } from './nestgeom.js';
import { validCols } from '../data/balance.js';

// C215: COLS is nestgeom's live binding; generateNest makes the new run's width the active one first.
const ROWS = GRID.rows;

// Occupancy codes of the generator's scratch grid.
const FREE = 0;
const RESERVED = 1; // shaft, Royal Chambers, their connecting tunnels
const STONE = 2;
const WATER_OCC = 3;
const ROOT = 4;
const CACHE = 5;

/**
 * Generate the nest subtree of a new run (ARCHITECTURE §8.2): the default grid (§4.2) plus stones (C181: varied shapes,
 * 1–9 cells, rows 8–55, their own seeded stream; ×2 with site_stony_ground) as CELL.STONE, caches (rows 5–60; ×2 stony; exactly one amber_bead in bedrock), water
 * pockets (2–3, +2 with site_wet_hollow, rows 40–70) as CELL.WATER and root lines at `rootCols` (y0 = 1,
 * y1 = randInt(6, 25); random columns are added until there are at least 6, at most 10 are kept). Features never
 * overlap the shaft, the Royal Chambers or each other; boulders and pockets also keep a 1-cell margin from the shaft,
 * the Royal Chambers and each other. royalCount ≥ 2 pre-digs extra Royal Chambers at rows 20–21 beside the first one,
 * linked by tunnel. Deterministic per (seed, options); uses makeHolder((seed ^ 0x9E3779B9) >>> 0).
 * @param {number} seed uint32 run seed
 * @param {{ tags?: string[], rootCols?: number[], royalCount?: number, cols?: number }} [opts] cols: the nest width (C215; 40)
 * @returns {Object} State['run']['nest']
 */
export function generateNest(seed, { tags = [], rootCols = [], royalCount = 1, cols: nestCols = GRID.baseCols } = {}) {
  // C215: a run may start wider than 40 columns (nest.runStartCols); everything below is laid out in that width
  const width = useCols(validCols(nestCols) ? nestCols : GRID.baseCols);
  const h = makeHolder((((seed >>> 0) ^ 0x9E3779B9) >>> 0));
  const tagList = Array.isArray(tags) ? tags : [];
  const stony = tagList.includes('site_stony_ground');
  const wet = tagList.includes('site_wet_hollow');
  const cells = defaultNestCells(width);
  const occ = new Uint8Array(COLS * ROWS);
  const royalDef = CHAMBERS.royal_chamber;
  const r0 = GRID.royal;

  // Reserved: main shaft and the Royal Chamber.
  for (let y = 0; y < GRID.shaftRows; y++) occ[idx(GRID.mainCol, y)] = RESERVED;
  const chambers = [{ uid: 1, type: 'royal_chamber', k: 0, x: r0.x, y: r0.y, w: r0.w, h: r0.h, level: 1, target: 1,
    status: 'active', blueprint: false, bornAt: 0 }];
  markRect(occ, r0.x, r0.y, r0.w, r0.h, RESERVED);
  let nextUid = 2;

  // Extra pre-dug Royal Chambers (fire ants: royalCount 2), alternating sides, joined by a tunnel along the bottom row.
  const extra = Math.max(0, Math.floor(Number(royalCount) || 1) - 1);
  const court = []; // C214: the passage cells joining the queens' chambers (tagged in dugBy)
  if (extra > 0) {
    const w = royalDef.w0;
    const hh = royalDef.h0;
    const gap = GEN.royalGap;
    const row = r0.y + hh - 1;
    let left = r0.x;              // leftmost x of the left chain
    let right = r0.x + r0.w - 1;  // rightmost x of the right chain
    let side = randInt(h, 0, 1);
    for (let n = 0; n < extra; n++) {
      let placed = false;
      for (let tries = 0; tries < 2 && !placed; tries++) {
        if (side === 0 && left - gap - w >= 0) {
          const x = left - gap - w;
          for (let c = x + w; c < left; c++) { cells[idx(c, row)] = CELL.TUNNEL; occ[idx(c, row)] = RESERVED; court.push(idx(c, row)); }
          digRect(cells, occ, x, r0.y, w, hh);
          chambers.push(royalAt(nextUid++, chambers.length, x, r0.y, w, hh));
          left = x;
          placed = true;
        } else if (side === 1 && right + gap + w <= COLS - 1) {
          const x = right + gap + 1;
          for (let c = right + 1; c < x; c++) { cells[idx(c, row)] = CELL.TUNNEL; occ[idx(c, row)] = RESERVED; court.push(idx(c, row)); }
          digRect(cells, occ, x, r0.y, w, hh);
          chambers.push(royalAt(nextUid++, chambers.length, x, r0.y, w, hh));
          right = x + w - 1;
          placed = true;
        }
        side = 1 - side;
      }
      if (!placed) break;
    }
  }

  // C137 / C155: the first Royal Chamber reserves its full-size room (its L8 footprint, GEOM.footprintMaxL; top-right
  // anchor: it grows left, as in a new game; top-left when an extra pre-dug Royal Chamber sits on the left). When no
  // full-size room is free it reserves its Flight-level room (C66: L5 always fits), else it keeps the legacy grow-a-side
  // rule (noRes).
  {
    const hit = (R) => chambers.some((c) => c.uid !== 1 && c.x < R.x + R.w && R.x < c.x + c.w && c.y < R.y + R.h && R.y < c.y + c.h);
    let R = null;
    for (const L of [GEOM.footprintMaxL, FLIGHT.royalLevel]) {
      const fp = footprint('royal_chamber', L);
      const W = Math.max(fp.w, r0.w);
      const H = Math.max(fp.h, r0.h);
      const opts = [{ x: r0.x + r0.w - W, y: r0.y, w: W, h: H }, { x: r0.x, y: r0.y, w: W, h: H }];
      R = opts.find((o) => o.x >= 0 && o.x + o.w <= COLS && !hit(o)) || null;
      if (R) break;
    }
    if (R) chambers[0].res = R;
    else chambers[0].noRes = true;
  }

  // Root lines.
  const cols = [];
  // C215: rootCols come in the base 40-wide frame (hex.colForHex); a wider nest shifts them by its extra columns per side
  const side = (width - GRID.baseCols) / 2;
  for (const c of Array.isArray(rootCols) ? rootCols : []) {
    let col = Math.round(Number(c)) + side;
    if (!Number.isFinite(col)) continue;
    col = Math.max(1, Math.min(COLS - 2, col));
    if (col === GRID.mainCol) col = cols.includes(col + 1) ? col - 1 : col + 1;
    if (!cols.includes(col)) cols.push(col);
  }
  let guard = 0;
  while (cols.length < ROOTS.min && guard++ < 500) {
    const col = randInt(h, 1, COLS - 2);
    if (col !== GRID.mainCol && !cols.includes(col)) cols.push(col);
  }
  cols.length = Math.min(cols.length, ROOTS.max);
  const roots = [];
  for (const col of cols) {
    let y1 = randInt(h, ROOTS.yMin, ROOTS.yMax);
    // C178: roots grow down through chambers (the pre-dug Royal Chambers and their tunnels included); only a shaft
    // stops one (the main shaft column is never a root column).
    for (let y = 1; y <= y1; y++) {
      const v = occ[idx(col, y)];
      if (v !== FREE && v !== RESERVED) { y1 = y - 1; break; }
      if (v === RESERVED && col === GRID.mainCol) { y1 = y - 1; break; }
    }
    y1 = Math.max(y1, 1);
    for (let y = 1; y <= y1; y++) if (occ[idx(col, y)] === FREE) occ[idx(col, y)] = ROOT;
    roots.push({ col, y0: 1, y1 });
  }

  // Royal growth zone (C66, C155): every full-size (L8) footprint the first Royal Chamber can grow into (row rule: it
  // never grows up), which holds every Flight-level one. Boulders and water pockets never land there, so no seed can
  // wall the queen in (before Royal L5, a Flight requirement, a stone there needed the 10,000-insight acid_excavation)
  // or hold her reserved growth back. Roots and caches may (they do not block).
  const keep = new Uint8Array(COLS * ROWS);
  {
    const fp = footprint('royal_chamber', GEOM.footprintMaxL);
    const sx = Math.max(0, fp.w - r0.w);
    markRect(keep, r0.x - sx, r0.y, r0.w + 2 * sx, Math.max(fp.h, r0.h), 1);
  }

  // Stones. C181: varied shapes (pebbles, bars, blocks, slabs, Ls, blobs, the odd big boulder) from their own seeded
  // stream, so a seed always gives the same stones; still never in the Royal growth zone, with the 1-cell margin.
  const hs = makeHolder((((seed >>> 0) ^ 0x5BD1E995) >>> 0));
  const stoneMult = stony ? SITE_MODS.site_stony_ground.stones : 1;
  const nStones = randInt(hs, STONES.min, STONES.max) * stoneMult;
  const shapeW = Object.keys(STONES.shapes).map((id) => ({ id, w: STONES.shapes[id] }));
  for (let n = 0; n < nStones; n++) {
    const shape = stoneShape(hs, shapeW);
    let sw = 0;
    let sh = 0;
    for (const [dx, dy] of shape) { sw = Math.max(sw, dx + 1); sh = Math.max(sh, dy + 1); }
    for (let t = 0; t < GEN.attempts; t++) {
      const x = randInt(hs, 0, COLS - sw);
      const y = randInt(hs, STONES.yMin, STONES.yMax - sh + 1);
      const list = shape.map(([dx, dy]) => idx(x + dx, y + dy));
      if (!cellsFree(occ, list, keep)) continue;
      for (const c of list) { cells[c] = CELL.STONE; occ[c] = STONE; }
      break;
    }
  }

  // Water pockets.
  const nWater = randInt(h, WATER.min, WATER.max) + (wet ? SITE_MODS.site_wet_hollow.waterAdd : 0);
  const water = [];
  for (let n = 0; n < nWater; n++) {
    for (let t = 0; t < GEN.attempts; t++) {
      const w = randInt(h, WATER.sizeMin, WATER.sizeMax);
      const hh = randInt(h, WATER.sizeMin, WATER.sizeMax);
      const x = randInt(h, 0, COLS - w);
      const y = randInt(h, WATER.yMin, WATER.yMax - hh + 1);
      if (!blockFree(occ, x, y, w, hh, keep)) continue;
      for (let yy = y; yy < y + hh; yy++) {
        for (let xx = x; xx < x + w; xx++) { cells[idx(xx, yy)] = CELL.WATER; occ[idx(xx, yy)] = WATER_OCC; }
      }
      water.push({ x, y, w, h: hh, revealed: false });
      break;
    }
  }

  // Caches, then the amber bead(s) in bedrock.
  const kinds = Object.keys(CACHES.kinds).map((id) => ({ id, w: CACHES.kinds[id].weight }));
  const cacheMult = stony ? SITE_MODS.site_stony_ground.caches : 1;
  const nCaches = randInt(h, CACHES.min, CACHES.max) * cacheMult;
  const caches = [];
  for (let n = 0; n < nCaches; n++) {
    const kind = weighted(h, kinds);
    for (let t = 0; t < GEN.attempts; t++) {
      const x = randInt(h, 0, COLS - 1);
      const y = randInt(h, CACHES.yMin, CACHES.yMax);
      const i = idx(x, y);
      if (occ[i] !== FREE || cells[i] !== CELL.SOIL) continue;
      occ[i] = CACHE;
      caches.push({ i, kind: kind ? kind.id : 'seed_cache', found: false, hinted: false });
      break;
    }
  }
  const amberLayer = LAYERS[CACHES.amber.layer];
  for (let n = 0; n < CACHES.amber.count; n++) {
    for (let t = 0; t < GEN.attempts; t++) {
      const x = randInt(h, 0, COLS - 1);
      const y = randInt(h, amberLayer.y0, amberLayer.y1);
      const i = idx(x, y);
      if (occ[i] !== FREE || cells[i] !== CELL.SOIL) continue;
      occ[i] = CACHE;
      caches.push({ i, kind: 'amber_bead', found: false, hinted: false });
      break;
    }
  }

  return {
    rev: 1,
    cells,
    chambers,
    nextUid,
    queue: [],
    features: { caches, water, roots },
    backfill: [],
    shafts: [{ kind: 'main', col: GRID.mainCol, open: true, ref: -1 }],
    maint: 0,
    deepestRow: r0.y + r0.h - 1,
    bpPending: [],
    bpTunnels: [],
    bpNotes: [],
    dugBy: court.length ? [{ w: 'court', t: 'royal_chamber', c: court }] : [],
    ...(width !== GRID.baseCols ? { cols: width } : {}),
  };
}

/**
 * C181: one boulder's cells as [dx, dy] offsets from its top-left corner (normalised to start at 0, 0), shape drawn by
 * weight (STONES.shapes) from the stone stream `hs`.
 */
export function stoneShape(hs, shapeW) {
  const pick = weighted(hs, shapeW);
  const id = pick ? pick.id : 'block';
  let out;
  switch (id) {
    case 'pebble': out = [[0, 0]]; break;
    case 'bar': out = randInt(hs, 0, 1) ? [[0, 0], [1, 0]] : [[0, 0], [0, 1]]; break;
    case 'block': out = [[0, 0], [1, 0], [0, 1], [1, 1]]; break;
    case 'slab': {
      const wide = randInt(hs, 0, 1) === 1;
      out = [];
      for (let a = 0; a < (wide ? 3 : 2); a++) for (let b = 0; b < (wide ? 2 : 3); b++) out.push([a, b]);
      break;
    }
    case 'ell': {
      const base = randInt(hs, 0, 1) ? [[0, 0], [0, 1], [1, 1]] : [[0, 0], [0, 1], [0, 2], [1, 2]];
      const rot = randInt(hs, 0, 3);
      const flip = randInt(hs, 0, 1) === 1;
      out = base.map(([a, b]) => {
        let p = flip ? [-a, b] : [a, b];
        for (let r = 0; r < rot; r++) p = [-p[1], p[0]];
        return p;
      });
      break;
    }
    case 'blob': {
      const n = randInt(hs, STONES.blobMin, STONES.blobMax);
      out = [[0, 0]];
      const has = (a, b) => out.some(([p, q]) => p === a && q === b);
      let guard = 0;
      while (out.length < n && guard++ < 200) {
        const [a, b] = out[randInt(hs, 0, out.length - 1)];
        const dir = randInt(hs, 0, 3);
        const na = a + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
        const nb = b + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
        if (!has(na, nb)) out.push([na, nb]);
      }
      break;
    }
    default: {
      out = [];
      for (let a = 0; a < STONES.size; a++) for (let b = 0; b < STONES.size; b++) out.push([a, b]);
    }
  }
  let mx = Infinity;
  let my = Infinity;
  for (const [a, b] of out) { mx = Math.min(mx, a); my = Math.min(my, b); }
  return out.map(([a, b]) => [a - mx, b - my]);
}

/**
 * C181: blockFree for any cell set: every cell free (and outside `keep`) and no reserved / stone / water cell within the
 * margin around the set (other than the set itself).
 */
function cellsFree(occ, list, keep = null) {
  const m = GEN.margin;
  const inSet = new Set(list);
  for (const c of list) {
    if (c < 0 || c >= occ.length || occ[c] !== FREE || (keep && keep[c])) return false;
    const x = c % COLS;
    const y = Math.floor(c / COLS);
    for (let yy = y - m; yy <= y + m; yy++) {
      for (let xx = x - m; xx <= x + m; xx++) {
        if (!inBounds(xx, yy)) continue;
        const k = idx(xx, yy);
        if (inSet.has(k)) continue;
        const v = occ[k];
        if (v === RESERVED || v === STONE || v === WATER_OCC) return false;
      }
    }
  }
  return true;
}

/** A pre-dug Royal Chamber record. */
function royalAt(uid, k, x, y, w, h) {
  return { uid, type: 'royal_chamber', k, x, y, w, h, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 };
}

function markRect(occ, x, y, w, h, v) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (inBounds(xx, yy)) occ[idx(xx, yy)] = v;
}

function digRect(cells, occ, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) { cells[idx(xx, yy)] = CELL.CHAMBER; occ[idx(xx, yy)] = RESERVED; }
  }
}

/**
 * True if every cell of the block is free (and outside the `keep` zone, when given) and no reserved / stone / water
 * cell lies within the margin around it (roots and caches only need to be outside the block itself).
 */
function blockFree(occ, x, y, w, h, keep = null) {
  const m = GEN.margin;
  for (let yy = y - m; yy < y + h + m; yy++) {
    for (let xx = x - m; xx < x + w + m; xx++) {
      if (!inBounds(xx, yy)) continue;
      const v = occ[idx(xx, yy)];
      const inside = xx >= x && xx < x + w && yy >= y && yy < y + h;
      if (inside && (v !== FREE || (keep && keep[idx(xx, yy)]))) return false;
      if (!inside && (v === RESERVED || v === STONE || v === WATER_OCC)) return false;
    }
  }
  return true;
}
