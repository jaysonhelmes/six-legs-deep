// Cameras: surface pan/zoom (zoom 0.6–2.75 from data/surface.js MAP, C163) clamped to the map radius, and the nest's
// fitted cell size with player zoom, vertical scroll, horizontal pan while zoomed past the width, and a default
// framing around the Royal Chamber. Pure (no DOM); renderers own one instance each. Owner: WP8.
// Contract: ARCHITECTURE §13 (render/camera.js), DESIGN §8.1 (zoom range), §7.1 (≈45 visible rows).

import { GRID, HEX } from '../data/balance.js';
import { MAP } from '../data/surface.js';
import { SQRT3, clamp, hexWorld } from './geom.js';

const ZOOM_MIN = MAP && MAP.zoomMin > 0 ? MAP.zoomMin : 0.6;
const ZOOM_MAX = MAP && MAP.zoomMax > 0 ? MAP.zoomMax : 2.75;
/** Nest cell size (CSS px) the default framing aims for: chambers readable and tappable, the colony in view. */
export const FRAME_CELL = 13;

/**
 * Surface camera. (x, y) is the world point drawn at the viewport centre (cx, cy).
 * @param {{ zoomMin?: number, zoomMax?: number, size?: number, zoom?: number }} [opts]
 */
export function createSurfaceCamera({ zoomMin = ZOOM_MIN, zoomMax = ZOOM_MAX, size = HEX.px, zoom = 1 } = {}) {
  const cam = {
    x: 0, y: 0, zoom: clamp(zoom, zoomMin, zoomMax), cx: 0, cy: 0, size,
    zoomMin, zoomMax, radius: 8, w: 0, h: 0,
    /** override zoom (ceremonies); null = none */
    zoomOverride: null,
    /** Set the viewport size in CSS px (keeps the centred world point). */
    setViewport(w, h) {
      cam.w = w;
      cam.h = h;
      cam.cx = w / 2;
      cam.cy = h / 2;
      cam.clamp();
    },
    /** Pan by a screen delta (CSS px). */
    pan(dx, dy) {
      const z = cam.effZoom();
      cam.x -= dx / z;
      cam.y -= dy / z;
      cam.clamp();
    },
    /** Zoom by a factor keeping the screen point (sx, sy) fixed. */
    zoomAt(factor, sx = cam.cx, sy = cam.cy) {
      if (!(factor > 0)) return;
      const z0 = cam.zoom;
      const z1 = clamp(z0 * factor, cam.zoomMin, cam.zoomMax);
      if (z1 === z0) return;
      const wx = cam.x + (sx - cam.cx) / z0;
      const wy = cam.y + (sy - cam.cy) / z0;
      cam.zoom = z1;
      cam.x = wx - (sx - cam.cx) / z1;
      cam.y = wy - (sy - cam.cy) / z1;
      cam.clamp();
    },
    /** Centre the view on a world point. */
    centerOnWorld(wx, wy) {
      cam.x = wx;
      cam.y = wy;
      cam.clamp();
    },
    /** Centre the view on a hex. */
    centerOnHex(hex) {
      const p = hexWorld(hex, cam.size);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) cam.centerOnWorld(p.x, p.y);
    },
    /** Set the map radius used for pan clamping. */
    setRadius(r) {
      cam.radius = r > 0 ? r : 8;
      cam.clamp();
    },
    /** The zoom actually used for drawing (ceremony override or the player zoom). */
    effZoom() {
      return cam.zoomOverride > 0 ? cam.zoomOverride : cam.zoom;
    },
    /** A plain camera object for geom.js ({ x, y, zoom, cx, cy, size }). */
    view() {
      return { x: cam.x, y: cam.y, zoom: cam.effZoom(), cx: cam.cx, cy: cam.cy, size: cam.size };
    },
    /** Keep the map in view: the centre may move at most to the map edge. */
    clamp() {
      const ext = (cam.radius + 0.5) * cam.size * SQRT3;
      const exty = (cam.radius + 0.5) * cam.size * 1.5;
      cam.x = clamp(cam.x, -ext, ext);
      cam.y = clamp(cam.y, -exty, exty);
      if (!Number.isFinite(cam.x)) cam.x = 0;
      if (!Number.isFinite(cam.y)) cam.y = 0;
    },
  };
  return cam;
}

/**
 * Nest camera. The default framing fills the canvas width with the 40 columns (a 12 px grid at the reference 480 px
 * canvas), capped so at least `minRows` rows stay visible and no cell grows past `maxCell`; a short canvas therefore
 * shows the grid centred with soil margins either side. On top of that fitted size the player can zoom (`zoom`
 * multiplies the fitted cell, 1 = default framing) from "the whole column fits the height" to ~40 px cells; once the
 * grid is wider than the canvas it pans horizontally too. A sky margin of `skyCells` rows sits above row 0.
 * `scroll` is the vertical offset in CSS px; `cx` is the grid column (fractional) drawn at the horizontal centre when
 * the grid overflows the width.
 * @param {{ cols?: number, rows?: number, baseCell?: number, visibleRows?: number, skyCells?: number, minRows?: number,
 *   maxCell?: number }} [opts]
 */
export function createNestCamera({ cols = GRID.cols, rows = GRID.rows, baseCell = GRID.cellPx, visibleRows = GRID.visibleRows,
  skyCells = 2, minRows = 16, maxCell = 24 } = {}) {
  void visibleRows;
  const cam = {
    cols, rows, cell: baseCell, scroll: 0, w: 0, h: 0, ox: 0, skyCells, inset: false,
    /** fitted (zoom 1) cell size and the player zoom multiplier */
    fit: baseCell, zoom: 1,
    /** grid column at the horizontal centre (used only while the grid is wider than the canvas) */
    cx: cols / 2,
    /** Fit the cell size to a viewport (CSS px). Keeps the grid point at the view centre stable. */
    setViewport(w, h) {
      const hadView = cam.w > 0 && cam.h > 0 && cam.cell > 0;
      const midRow = hadView ? (cam.scroll + cam.h / 2) / cam.cell - skyCells : 0;
      cam.w = w;
      cam.h = h;
      cam.fit = cam.fitCell(w, h);
      cam.zoom = clamp(cam.zoom, cam.zoomMin(), cam.zoomMax());
      cam.cell = cam.inset ? cam.fit : cam.fit * cam.zoom;
      if (hadView) cam.scroll = (midRow + skyCells) * cam.cell - h / 2;
      else cam.scroll = 0;
      cam.clamp();
    },
    /** Zoom-1 cell size for a viewport: fill the width, keep ≥ minRows rows visible, never above maxCell. */
    fitCell(w, h) {
      if (!(w > 0) || !(h > 0)) return baseCell;
      if (cam.inset) return clamp(Math.min(w / 14, h / 9), 4, 40);
      const c = Math.min(w / cols, maxCell, h / minRows);
      return clamp(c, 3, 32);
    },
    /** Smallest zoom: the whole column (sky + rows) fits the height, but cells never under 4 px and never above 1. */
    zoomMin() {
      if (!(cam.fit > 0) || !(cam.h > 0)) return 1;
      const whole = cam.h / (rows + skyCells);
      return clamp(Math.max(4, whole) / cam.fit, 0.2, 1);
    },
    /** Largest zoom: ~40 px cells (at least 2× the fitted size on big canvases). */
    zoomMax() {
      if (!(cam.fit > 0)) return 1;
      return Math.max(1, Math.max(40, cam.fit * 2) / cam.fit);
    },
    /** Total content height in CSS px (sky margin + grid). */
    contentH() {
      return (rows + skyCells) * cam.cell;
    },
    /** Maximum scroll in CSS px. */
    maxScroll() {
      return Math.max(0, cam.contentH() - cam.h);
    },
    /** True when the grid is wider than the canvas (horizontal pan active). */
    overflowX() {
      return cols * cam.cell > cam.w + 0.5;
    },
    clamp() {
      cam.scroll = clamp(cam.scroll, 0, cam.maxScroll());
      if (!Number.isFinite(cam.scroll)) cam.scroll = 0;
      if (cam.overflowX()) {
        const half = cam.w / 2 / cam.cell;
        cam.cx = clamp(Number.isFinite(cam.cx) ? cam.cx : cols / 2, half, cols - half);
        cam.ox = Math.round(cam.w / 2 - cam.cx * cam.cell);
      } else {
        cam.cx = cols / 2;
        cam.ox = Math.round((cam.w - cols * cam.cell) / 2);
      }
    },
    /** Scroll by a CSS px delta. */
    scrollBy(dy) {
      cam.scroll += dy;
      cam.clamp();
    },
    /** Pan by a CSS px delta in both axes (horizontal only matters while the grid overflows). */
    panBy(dx, dy) {
      if (cam.cell > 0 && Number.isFinite(dx)) cam.cx += dx / cam.cell;
      if (Number.isFinite(dy)) cam.scroll += dy;
      cam.clamp();
    },
    /** Multiply the zoom by `factor`, keeping the grid point under (sx, sy) fixed. Returns true when it changed. */
    zoomAt(factor, sx = cam.w / 2, sy = cam.h / 2) {
      if (cam.inset || !(factor > 0) || !(cam.cell > 0)) return false;
      const z1 = clamp(cam.zoom * factor, cam.zoomMin(), cam.zoomMax());
      if (Math.abs(z1 - cam.zoom) < 1e-6) return false;
      const v = cam.view();
      const gx = (sx - v.ox) / cam.cell;
      const gy = (sy - v.oy) / cam.cell;
      cam.zoom = z1;
      cam.cell = cam.fit * z1;
      cam.cx = gx + (cam.w / 2 - sx) / cam.cell;
      cam.scroll = (gy + skyCells) * cam.cell - sy;
      cam.clamp();
      return true;
    },
    /** Set the zoom directly (1 = default framing), keeping the view centre fixed. */
    setZoom(z) {
      if (!(z > 0)) return;
      cam.zoomAt(z / cam.zoom, cam.w / 2, cam.h / 2);
    },
    /** Put `row` at the top of the view (the sky margin shows when row ≤ 0). */
    scrollToRow(row) {
      cam.scroll = (row + skyCells) * cam.cell;
      if (row <= 0) cam.scroll = 0;
      cam.clamp();
    },
    /** Centre the view vertically on a row. */
    centerOnRow(row) {
      cam.scroll = (row + skyCells + 0.5) * cam.cell - cam.h / 2;
      cam.clamp();
    },
    /** Centre on a cell (horizontally too in inset mode or while the grid overflows the width). */
    centerOnCell(x, y) {
      cam.cx = x + 0.5;
      cam.centerOnRow(y);
    },
    /**
     * Default framing: show the sky down to the deepest row of interest (`deepest`, e.g. the lowest chamber) with
     * cells between FRAME_CELL and the width fit (a narrow canvas may zoom in past its width fit up to FRAME_CELL,
     * so chambers stay big enough to tap, and then pans), centred on the focus rect (the Royal Chamber), which is
     * always kept fully in view. Inset mode just centres the focus at the inset scale.
     * @param {{ x: number, y: number, w: number, h: number }} f
     * @param {number} [deepest]
     */
    frame(f, deepest = f.y + f.h) {
      cam.cx = f.x + f.w / 2;
      if (cam.inset) {
        cam.zoom = 1;
        cam.cell = cam.fit;
        cam.centerOnRow(f.y + f.h / 2 - 0.5);
        return;
      }
      const top = -skyCells;
      const bottom = Math.max(f.y + f.h, Number.isFinite(deepest) ? deepest : 0);
      const n = bottom - top + 1;
      const cell = clamp(cam.h / n, Math.min(cam.fit, FRAME_CELL), Math.max(cam.fit, FRAME_CELL));
      cam.zoom = clamp(cell / cam.fit, cam.zoomMin(), cam.zoomMax());
      cam.cell = cam.fit * cam.zoom;
      const vr = cam.viewRows();
      let mid = (top + bottom + 1) / 2;
      const lo = f.y + f.h + 0.5 - vr / 2;
      const hi = f.y - 0.5 + vr / 2;
      if (lo <= hi) mid = clamp(mid, lo, hi);
      else mid = f.y + f.h / 2;
      cam.scroll = (mid + skyCells) * cam.cell - cam.h / 2;
      cam.clamp();
    },
    /** First (fractional) grid row visible at the top. */
    topRow() {
      return cam.scroll / cam.cell - skyCells;
    },
    /** Number of rows that fit in the view. */
    viewRows() {
      return cam.cell > 0 ? cam.h / cam.cell : 0;
    },
    /** geom.js NestView. */
    view() {
      return { ox: cam.ox, oy: skyCells * cam.cell - cam.scroll, cell: cam.cell, cols, rows };
    },
  };
  return cam;
}
