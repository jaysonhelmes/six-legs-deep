// Mini-maps: drawMiniMap() for the landing-site previews (terrain + sources of a MapGenResult) and drawNestStrip()
// for the whole-column nest strip beside the Below view (layers, open cells, chambers, the visible window).
// Owner: WP8. Contract: ARCHITECTURE §13.3 (render/minimap.js), DESIGN §13.6, §7.1.

import { GRID, CELL, HEX } from '../data/balance.js';
import { hexToPixel, countInRadius } from '../core/hex.js';
import { TERRAIN_ORDER } from '../data/surface.js';
import { LAYER_ORDER, LAYERS } from '../data/strata.js';
import { terrainColor, STRATA, NEST, SURFACE, rgba } from './palette.js';
import { SQRT3 } from './geom.js';

/** Source type → minimap dot colour. */
const SOURCE_DOT = {
  crumb_scatter: '#e8d3a0', seed_patch: '#e2c06a', flower_patch: '#f4a6c8', dead_insect: '#9aa0a8', leaf_plant: '#4caf50',
  aphid_colony: '#a6d85a', prey_caterpillar: '#8fd45a', prey_cricket: '#a5753c', prey_beetle: '#3d6a4a', fallen_fruit: '#e0443e',
  picnic_spill: '#ff6b6b', termite_mound: '#b07a4a', lycaenid_caterpillar: '#9fd0c8', harvester_stash: '#f2b134',
  termite_swarm: '#efe2c0',
};

/** Prepare a 2D context for a canvas in CSS pixels; returns [ctx, w, h] or null. */
function prep(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  let w = 0;
  let h = 0;
  let dpr = 1;
  try {
    if (typeof window !== 'undefined' && window.devicePixelRatio > 0) dpr = Math.min(2, window.devicePixelRatio);
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    if (r && r.width > 0 && r.height > 0) {
      w = r.width;
      h = r.height;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
    }
  } catch {
    // headless
  }
  if (!(w > 0) || !(h > 0)) {
    dpr = 1;
    w = canvas.width || 120;
    h = canvas.height || 120;
  }
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}

/** Terrain id from a stored terrain code. */
function terrainId(code) {
  const order = TERRAIN_ORDER;
  return order[code] || 'grass';
}

/**
 * Draw a landing-site preview: every hex of `radius` coloured by terrain, sources as dots, the entrance ringed.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} terrain 817 terrain codes
 * @param {Array<{ type: string, hex: number, data?: any }>} sources
 * @param {number} radius
 */
export function drawMiniMap(canvas, terrain, sources, radius) {
  const p = prep(canvas);
  if (!p) return;
  const [ctx, w, h] = p;
  const R = Math.max(1, Math.min(HEX.maxRadius, Math.floor(radius > 0 ? radius : 8)));
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = SURFACE.void;
  ctx.fillRect(0, 0, w, h);
  // fit: map width = size·√3·(2R+1), height = size·(3R+2)
  const size = Math.max(1, Math.min(w / (SQRT3 * (2 * R + 1)), h / (1.5 * (2 * R) + 2)));
  const cx = w / 2;
  const cy = h / 2;
  const n = countInRadius(R);
  const rr = size * 1.02;
  for (let i = 0; i < n; i++) {
    const [x, y] = hexToPixel(i, size);
    const code = terrain && Number.isFinite(terrain[i]) ? terrain[i] : 0;
    ctx.fillStyle = terrainColor('spring', terrainId(code))[0];
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 180) * (60 * k - 30);
      const px = cx + x + rr * Math.cos(a);
      const py = cy + y + rr * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  for (const src of sources || []) {
    if (!src || !(src.hex >= 0) || src.hex >= n) continue;
    if (src.data && src.data.dormant) continue;
    const [x, y] = hexToPixel(src.hex, size);
    ctx.fillStyle = SOURCE_DOT[src.type] || '#ffffff';
    ctx.strokeStyle = 'rgba(20,14,8,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx + x, cy + y, Math.max(1.6, size * 0.55), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.strokeStyle = SURFACE.player;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, size * 0.9), 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Draw the nest minimap strip: the whole 40 × 80 column scaled into the canvas, with layer colours, open cells,
 * chamber footprints and a rectangle for the rows currently visible in the Below view.
 * @param {HTMLCanvasElement} canvas
 * @param {any} s game state (read only)
 * @param {number} viewRow0 first visible row (may be fractional or negative)
 * @param {number} viewRows number of visible rows
 */
export function drawNestStrip(canvas, s, viewRow0, viewRows) {
  const p = prep(canvas);
  if (!p) return;
  const [ctx, w, h] = p;
  const cols = GRID.cols;
  const rows = GRID.rows;
  ctx.clearRect(0, 0, w, h);
  const cw = w / cols;
  const ch = h / rows;
  const layers = LAYER_ORDER.map((id) => LAYERS[id]).filter(Boolean);
  for (const L of layers) {
    const col = (STRATA[L.id] || STRATA.loam).base;
    ctx.fillStyle = col;
    ctx.fillRect(0, L.y0 * ch, w, (L.y1 - L.y0 + 1) * ch);
  }
  const nest = s && s.run && s.run.nest;
  const cells = nest && nest.cells;
  if (cells && cells.length >= cols * rows) {
    ctx.fillStyle = 'rgba(16,9,4,0.9)';
    ctx.beginPath();
    for (let y = 0; y < rows; y++) {
      let run = -1;
      for (let x = 0; x <= cols; x++) {
        const c = x < cols ? cells[y * cols + x] : -1;
        const open = c === CELL.TUNNEL || c === CELL.CHAMBER;
        if (open && run < 0) run = x;
        if (!open && run >= 0) {
          ctx.rect(run * cw, y * ch, (x - run) * cw, ch + 0.3);
          run = -1;
        }
      }
    }
    ctx.fill();
    ctx.fillStyle = rgba(NEST.stone, 0.9);
    ctx.beginPath();
    for (let i = 0; i < cols * rows; i++) {
      if (cells[i] === CELL.STONE) ctx.rect((i % cols) * cw, Math.floor(i / cols) * ch, cw + 0.3, ch + 0.3);
    }
    ctx.fill();
  }
  for (const c of (nest && nest.chambers) || []) {
    if (!c) continue;
    ctx.fillStyle = c.status === 'active' || c.status === 'growing' ? 'rgba(232,196,128,0.85)' : 'rgba(232,196,128,0.35)';
    ctx.fillRect(c.x * cw, c.y * ch, Math.max(1, c.w * cw), Math.max(1, c.h * ch));
  }
  if (Number.isFinite(viewRow0) && viewRows > 0) {
    const y0 = Math.max(0, viewRow0) * ch;
    const y1 = Math.min(rows, viewRow0 + viewRows) * ch;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, y0, w, Math.max(2, y1 - y0));
    ctx.strokeStyle = 'rgba(255,240,200,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, y0 + 0.5, w - 1, Math.max(2, y1 - y0) - 1);
  }
}
