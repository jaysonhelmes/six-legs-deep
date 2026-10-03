// Ceremonies: Nuptial Flight (≤ 120 alates spiral out of the nuptial entrance, camera zooms out, counter ticks),
// Supercolony (trails link the daughter colonies, camera pulls back, a single queen lands), Speciation (amber block in
// the Strata band, cladogram unfolds), the welcome-back time-lapse (5 s replay of summary.cells / summary.chambers)
// and the ending. The renderers draw the active ceremony each frame; the Promise resolves on a wall-clock timer so it
// also resolves while a view is hidden. Owner: WP8. Contract: ARCHITECTURE §13.3 (playCeremony), §13.5; DESIGN §13.6,
// §14.6, §15.7, §21.6.

import { nowMs, reducedMotion } from './canvas.js';
import { FLIGHT } from '../data/prestige.js';
import { GRID } from '../data/balance.js';
import { BUDGET } from './sprites.js';
import { getAtlas } from './atlas.js';
import { hash01, clamp } from './geom.js';
import { rgba } from './palette.js';

/** Ceremony durations in seconds (reduced motion uses REDUCED_MULT of these). */
export const DURATION = Object.freeze({ flight: 4.5, supercolony: 4.5, speciation: 5, timelapse: 5, ending: 7 });
const REDUCED_MULT = 0.4;
/** Rows of the Strata band where the Speciation ceremony lays its amber block (bedrock and aquifer: rows 58–80). */
const SPEC_BAND = Object.freeze([58, GRID.rows]);

/** @type {null | { kind: string, start: number, dur: number, summary: any, resolve: () => void, timer: any, renderers: any }} */
let active = null;

/** Canvas element → the renderer drawing on it (WP8-internal), so callers may pass either to playCeremony. */
const BY_CANVAS = new WeakMap();

/**
 * Register a renderer under its canvas (called by createNestRenderer / createSurfaceRenderer).
 * @param {object} canvas
 * @param {object} renderer
 */
export function registerRenderer(canvas, renderer) {
  if (canvas && typeof canvas === 'object' && renderer) BY_CANVAS.set(canvas, renderer);
}

/** A renderer from a renderer or from the canvas it draws on (null when unknown). */
function rendererOf(x) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.render === 'function' && typeof x.pick === 'function') return x;
  return BY_CANVAS.get(x) || null;
}

/**
 * Play a ceremony. Resolves when it ends (a new ceremony ends the previous one early).
 * `nest` / `surface` are the renderers (§13.3); their canvases are accepted too and resolved to the renderers.
 * @param {'flight'|'supercolony'|'speciation'|'timelapse'|'ending'} kind
 * @param {{ nest?: any, surface?: any, summary?: any }} [opts]
 * @returns {Promise<void>}
 */
export function playCeremony(kind, { nest: nestIn = null, surface: surfaceIn = null, summary = null } = {}) {
  endCeremony();
  const nest = rendererOf(nestIn);
  const surface = rendererOf(surfaceIn);
  const k = Object.prototype.hasOwnProperty.call(DURATION, kind) ? kind : 'flight';
  let state = null;
  try {
    const s = (nest && nest.game && nest.game.s) || (surface && surface.game && surface.game.s) || null;
    state = s;
  } catch {
    state = null;
  }
  const dur = DURATION[k] * (reducedMotion(state) ? REDUCED_MULT : 1);
  return new Promise((resolve) => {
    active = { kind: k, start: nowMs(), dur, summary: summary || {}, resolve, timer: null, renderers: { nest, surface } };
    try {
      // The nest view shows the ceremony's spot; ceremonyView hands the camera back to the default framing around
      // the Royal Chamber when the ceremony ends (F20). scrollToRow is the fallback for other renderers.
      const show = (row) => {
        if (!nest) return;
        if (typeof nest.ceremonyView === 'function') nest.ceremonyView(row);
        else if (typeof nest.scrollToRow === 'function') nest.scrollToRow(Math.max(0, Math.round(row - 10)));
      };
      if (k === 'speciation') show((SPEC_BAND[0] + SPEC_BAND[1]) / 2);
      if (k === 'timelapse') {
        const cells = (summary && summary.cells) || [];
        if (cells.length && Number.isFinite(cells[0])) show(Math.floor(cells[0] / GRID.cols));
      }
      if ((k === 'flight' || k === 'supercolony') && surface && typeof surface.centerOn === 'function') surface.centerOn(0);
    } catch {
      // renderers are optional
    }
    const me = active;
    if (typeof setTimeout === 'function') {
      me.timer = setTimeout(() => {
        if (active === me) endCeremony();
      }, Math.ceil(dur * 1000) + 30);
    } else {
      endCeremony();
    }
  });
}

/** End the active ceremony now (resolves its Promise). */
export function endCeremony() {
  const a = active;
  active = null;
  if (!a) return;
  try {
    if (a.timer && typeof clearTimeout === 'function') clearTimeout(a.timer);
  } catch {
    // ignore
  }
  a.resolve();
}

/**
 * The active ceremony with its progress u ∈ [0, 1], or null.
 * @returns {{ kind: string, u: number, t: number, dur: number, summary: any } | null}
 */
export function activeCeremony() {
  if (!active) return null;
  const t = (nowMs() - active.start) / 1000;
  if (t >= active.dur + 0.25) {
    endCeremony();
    return null;
  }
  return { kind: active.kind, u: clamp(t / active.dur, 0, 1), t, dur: active.dur, summary: active.summary };
}

/** True when the ceremony takes over the Above view's sprite budget (flight and supercolony). */
export function ceremonyHidesSurfaceSprites() {
  const c = activeCeremony();
  return !!c && (c.kind === 'flight' || c.kind === 'supercolony');
}

/**
 * Zoom override for the Above camera during flight/supercolony (pull back), or null.
 * @param {number} zoom current player zoom
 * @param {number} zoomMin
 * @returns {number|null}
 */
export function ceremonyZoom(zoom, zoomMin) {
  const c = activeCeremony();
  if (!c || (c.kind !== 'flight' && c.kind !== 'supercolony')) return null;
  const e = c.u < 0.35 ? c.u / 0.35 : c.u > 0.85 ? (1 - c.u) / 0.15 : 1;
  const ease = e * e * (3 - 2 * e);
  return zoom + (zoomMin * 0.9 - zoom) * ease;
}

/** Compact integer label (render-local; the UI's number formatting lives in ui/format.js). */
export function compactInt(n) {
  if (!Number.isFinite(n)) return '0';
  const a = Math.abs(n);
  if (a < 100 && Math.abs(n - Math.round(n)) > 0.05) return n.toFixed(1);
  if (a < 1000) return String(Math.round(n));
  const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
  let v = a;
  let u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  if (v >= 1000) return n.toExponential(2);
  return (n < 0 ? '-' : '') + (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)) + units[u];
}

function banner(ctx, W, y, text, sub, alpha, color = '#fff3c4') {
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 22px Georgia, "Times New Roman", serif';
  ctx.fillStyle = 'rgba(20,12,6,0.65)';
  ctx.fillText(text, W / 2 + 1.5, y + 1.5);
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, y);
  if (sub) {
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(20,12,6,0.65)';
    ctx.fillText(sub, W / 2 + 1, y + 23);
    ctx.fillStyle = '#f6ead2';
    ctx.fillText(sub, W / 2, y + 22);
  }
  ctx.globalAlpha = 1;
}

/**
 * Draw the active ceremony on the Above canvas (screen space, after the world).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ W: number, H: number, s: any, hexToScreen: (hex: number) => {x:number,y:number}, unit: number, zoom: number }} info
 */
export function drawCeremonySurface(ctx, info) {
  const c = activeCeremony();
  if (!c || !ctx) return;
  const { W, H, s } = info;
  const atlas = getAtlas();
  const u = c.u;
  const fadeIn = clamp(u / 0.12, 0, 1);
  const fadeOut = clamp((1 - u) / 0.12, 0, 1);
  const fade = Math.min(fadeIn, fadeOut);
  if (c.kind === 'flight') {
    const ent = entranceHex(s, 'nuptial');
    const p = info.hexToScreen(ent);
    const alates = Math.max(0, Number(c.summary && c.summary.alates) || 0);
    const cap = (FLIGHT && FLIGHT.ceremonySprites) || BUDGET.flight;
    const n = Math.min(cap, BUDGET.flight, Math.max(12, Math.ceil(Math.sqrt(alates + 1) * 8)));
    ctx.fillStyle = `rgba(255,236,190,${0.12 * fade})`;
    ctx.fillRect(0, 0, W, H);
    const unit = Math.max(8, info.unit * 1.1);
    for (let i = 0; i < n; i++) {
      const li = (i / n) * 0.55;
      const v = u - li;
      if (v <= 0) continue;
      const ang = i * 2.399963 + v * 7;
      const r = v * Math.max(W, H) * 0.75 * (0.6 + hash01(i, 7) * 0.6);
      const x = p.x + Math.cos(ang) * r;
      const y = p.y + Math.sin(ang) * r - v * H * 0.35;
      const heading = ang + Math.PI / 2;
      ctx.globalAlpha = clamp(1.2 - v * 1.1, 0, 1);
      atlas.drawAnt(ctx, 'alate', 'none', heading, (Math.floor(c.t * 18 + i) & 1), x, y, unit);
    }
    ctx.globalAlpha = 1;
    const shown = Math.floor(alates * clamp(u / 0.75, 0, 1));
    const wx = info.flightW || 1;
    banner(ctx, W, H * 0.18, `+${compactInt(shown)} alates`, wx > 1 ? `Flight weather ×${wx}` : 'The nuptial flight', fade);
  } else if (c.kind === 'supercolony') {
    const daughters = (s && s.cycle && s.cycle.daughters) || [];
    const R = ((s && s.run && s.run.surface && s.run.surface.radius) || 8) + 1.5;
    const home = info.hexToScreen(0);
    ctx.fillStyle = `rgba(255,214,120,${0.1 * fade})`;
    ctx.fillRect(0, 0, W, H);
    const m = Math.max(3, daughters.length);
    ctx.lineCap = 'round';
    for (let i = 0; i < m; i++) {
      const a = (i / m) * Math.PI * 2 - Math.PI / 2;
      const ex = home.x + Math.cos(a) * R * 26 * info.zoom * 1.7;
      const ey = home.y + Math.sin(a) * R * 26 * info.zoom * 1.5;
      const k = clamp((u - i * 0.04) / 0.5, 0, 1);
      ctx.strokeStyle = rgba('#ffd166', 0.85 * fade);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + (home.x - ex) * k, ey + (home.y - ey) * k);
      ctx.stroke();
      ctx.fillStyle = '#f6c66b';
      ctx.beginPath();
      ctx.arc(ex, ey, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    if (u > 0.7) {
      const q = clamp((u - 0.7) / 0.25, 0, 1);
      const y = home.y - (1 - q) * H * 0.4;
      ctx.fillStyle = `rgba(0,0,0,${0.25 * q})`;
      ctx.beginPath();
      ctx.ellipse(home.x, home.y + 8, 14 * q, 5 * q, 0, 0, Math.PI * 2);
      ctx.fill();
      atlas.drawAnt(ctx, 'queen', 'none', -Math.PI / 2, (Math.floor(c.t * 10) & 1), home.x, y, 16);
    }
    banner(ctx, W, H * 0.18, 'Supercolony', 'The daughter colonies merge', fade);
  } else if (c.kind === 'speciation') {
    ctx.fillStyle = `rgba(217,142,31,${0.22 * fade})`;
    ctx.fillRect(0, 0, W, H);
    // cladogram: a deterministic branching tree growing from the bottom centre
    ctx.strokeStyle = rgba('#fff0c8', 0.9 * fade);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const grow = clamp(u / 0.8, 0, 1);
    branch(ctx, W / 2, H * 0.92, -Math.PI / 2, H * 0.22, 0, grow, 1);
    banner(ctx, W, H * 0.14, 'Speciation', 'Your lineage becomes a new species', fade);
  } else if (c.kind === 'timelapse') {
    ctx.fillStyle = `rgba(10,8,4,${0.25 * fade})`;
    ctx.fillRect(0, 0, W, H);
    const secs = Number(c.summary && c.summary.seconds) || 0;
    banner(ctx, W, H * 0.2, 'While you were away', secs > 0 ? `${compactDuration(secs * clamp(u, 0, 1))} replayed` : 'Time-lapse', fade);
  } else if (c.kind === 'ending') {
    const g = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, `rgba(255,236,160,${0.5 * fade})`);
    g.addColorStop(1, `rgba(120,70,10,${0.3 * fade})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 60; i++) {
      const x = hash01(i, 3) * W;
      const y = H - ((c.t * (30 + hash01(i, 5) * 50) + hash01(i, 9) * H) % (H + 20));
      ctx.fillStyle = `rgba(255,240,180,${0.8 * fade})`;
      ctx.fillRect(x, y, 2, 2);
    }
    banner(ctx, W, H * 0.4, 'Twenty Quadrillion', 'As many ants as the whole Earth holds', fade, '#ffe9a8');
  }
}

/** Recursive cladogram branch. */
function branch(ctx, x, y, a, len, depth, grow, alpha) {
  if (depth > 5 || len < 4) return;
  const reach = clamp(grow * 6 - depth, 0, 1);
  if (reach <= 0) return;
  const x2 = x + Math.cos(a) * len * reach;
  const y2 = y + Math.sin(a) * len * reach;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (reach < 1) return;
  const spread = 0.45 + hash01(depth, Math.round(x)) * 0.25;
  branch(ctx, x2, y2, a - spread, len * 0.72, depth + 1, grow, alpha * 0.92);
  branch(ctx, x2, y2, a + spread, len * 0.72, depth + 1, grow, alpha * 0.92);
}

function compactDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Hex of the first entrance of a kind (falls back to the main entrance, hex 0). */
function entranceHex(s, kind) {
  const ents = (s && s.run && s.run.surface && s.run.surface.entrances) || [];
  for (const e of ents) if (e && e.kind === kind && e.hex >= 0) return e.hex;
  return 0;
}

/**
 * Draw the active ceremony on the Below canvas. `coverCells(list)` redraws pristine soil over cells (time-lapse);
 * `cellRect(i)` gives the CSS rect of a cell.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ W: number, H: number, s: any, view: any, coverCells: (cells: number[]) => void,
 *           cellRect: (i: number) => {x:number,y:number,w:number,h:number}, chamberRect: (uid: number) => any }} info
 */
export function drawCeremonyNest(ctx, info) {
  const c = activeCeremony();
  if (!c || !ctx) return;
  const { W, H } = info;
  const u = c.u;
  const fade = Math.min(clamp(u / 0.12, 0, 1), clamp((1 - u) / 0.12, 0, 1));
  if (c.kind === 'timelapse') {
    const cells = (c.summary && Array.isArray(c.summary.cells)) ? c.summary.cells : [];
    const chambers = (c.summary && Array.isArray(c.summary.chambers)) ? c.summary.chambers : [];
    const k = Math.floor(cells.length * clamp(u / 0.9, 0, 1));
    if (k < cells.length) info.coverCells(cells.slice(k));
    if (k > 0 && k <= cells.length) {
      const r = info.cellRect(cells[Math.min(cells.length - 1, k - 1)]);
      if (r) {
        ctx.fillStyle = 'rgba(255,210,122,0.8)';
        ctx.beginPath();
        ctx.arc(r.x + r.w / 2, r.y + r.h / 2, r.w * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let i = 0; i < chambers.length; i++) {
      const at = ((i + 1) / chambers.length) * 0.9;
      const g = 1 - clamp((u - at) / 0.25, 0, 1);
      if (u < at || g <= 0) continue;
      const rc = info.chamberRect(chambers[i]);
      if (!rc) continue;
      ctx.strokeStyle = `rgba(255,224,138,${0.9 * g})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(rc.x - 2, rc.y - 2, rc.w + 4, rc.h + 4);
    }
  } else if (c.kind === 'speciation') {
    const v = info.view;
    const y0 = v.oy + SPEC_BAND[0] * v.cell;
    const y1 = v.oy + SPEC_BAND[1] * v.cell;
    const grow = clamp(u / 0.7, 0, 1);
    ctx.fillStyle = `rgba(217,142,31,${0.55 * fade})`;
    ctx.fillRect(v.ox, y1 - (y1 - y0) * grow, 40 * v.cell, (y1 - y0) * grow);
    ctx.strokeStyle = `rgba(255,236,170,${0.8 * fade})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(v.ox + 1, y1 - (y1 - y0) * grow, 40 * v.cell - 2, (y1 - y0) * grow);
  } else if (c.kind === 'ending' || c.kind === 'supercolony') {
    ctx.fillStyle = c.kind === 'ending' ? `rgba(255,220,120,${0.25 * fade})` : `rgba(255,200,110,${0.12 * fade})`;
    ctx.fillRect(0, 0, W, H);
  } else if (c.kind === 'flight') {
    ctx.fillStyle = `rgba(220,235,255,${0.1 * fade})`;
    ctx.fillRect(0, 0, W, H);
  }
}
