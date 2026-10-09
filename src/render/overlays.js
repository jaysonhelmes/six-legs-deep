// Map overlays. Below: climate (season microclimate per layer, projected frost line, flood zone), raid_reach (red
// shading within 15 path cells of each entrance), haul (path distance to storage and the current h), adjacency (link
// lines with bonus/penalty colours). Above: territory (owned hexes by kind, borders, patterned rival land),
// trail_strength (strength heat), danger (raid targets, border hexes, antlion/lizard hexes), richness (r(d) and
// capacity per source). Owner: WP8. Contract: ARCHITECTURE §13 (render/overlays.js), DESIGN §25.7.

import { GRID, CELL } from '../data/balance.js';
import { GEOM, DIG, MICRO, LAYER_ORDER, LAYERS } from '../data/strata.js';
import { FROST } from '../data/seasons.js';
import { MOUND, TRAIL } from '../data/surface.js';
import { SOURCES } from '../data/sources.js';
import { RESEARCH } from '../data/research.js';
import { hexDist } from '../core/hex.js';
import { rgba, ramp, OWNED_TINT, NEST, SURFACE, hatchPattern, rivalColor, rivalPatternKind, anchorPattern } from './palette.js';
import { hexCorners } from './geom.js';
import { COLS } from '../systems/nestgeom.js';

// C215: COLS is nestgeom's live binding (the active nest width)

/** Layer list (data/strata.js LAYER_ORDER). */
export function layerList() {
  return LAYER_ORDER.map((id) => LAYERS[id]).filter(Boolean);
}

/**
 * Projected frost depth for the coming (or current) winter: d.season.frostMax when set, else
 * max(minRow, (mild ? maxRowMild : maxRow) − thermoregulation − min(frostMax, floor(mound / frostPerLevels))).
 * ARCH-R: the projection outside winter mirrors WP6's F formula (DESIGN §17.3) for display only.
 * @param {any} s
 * @param {any} d
 * @returns {number}
 */
export function projectedFrostRow(s, d) {
  if (d && d.season && d.season.frostMax > 0) return d.season.frostMax;
  const year = (s && s.meta && s.meta.season && s.meta.season.year) || 0;
  const eternal = s && s.run && s.run.hardship === 'eternal_winter';
  const mild = year === 0 && !eternal && !(d && d.season && d.season.id === 'winter' && d.season.year > 0);
  const base = mild ? FROST.maxRowMild : FROST.maxRow;
  const thermo = s && s.run && s.run.research && s.run.research.thermoregulation
    ? ((RESEARCH.thermoregulation && RESEARCH.thermoregulation.fx && RESEARCH.thermoregulation.fx.frost) || 0) : 0;
  const mound = (s && s.run && s.run.surface && s.run.surface.mound) || 0;
  const moundCut = Math.min(MOUND.frostMax, Math.floor(mound / MOUND.frostPerLevels));
  return Math.max(FROST.minRow, base - thermo - moundCut);
}

/**
 * Draw the active Below overlays.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Record<string, boolean>} ov
 * @param {{ s: any, d: any, view: {ox:number,oy:number,cell:number}, W: number, H: number, open: Uint8Array,
 *           entField: Int16Array, mainField: Int16Array, rowTop: number, rowBot: number, chamberCenter: (ch:any)=>{x:number,y:number} }} info
 */
export function drawNestOverlays(ctx, ov, info) {
  if (!ov || !ctx) return;
  if (ov.climate) climate(ctx, info);
  if (ov.raid_reach) raidReach(ctx, info);
  if (ov.haul) haul(ctx, info);
  if (ov.adjacency) adjacency(ctx, info, null);
}

function climate(ctx, info) {
  const { s, d, view } = info;
  const season = (d && d.season && d.season.id) || 'spring';
  const x0 = view.ox;
  const w = COLS * view.cell;
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (const L of layerList()) {
    const y = view.oy + L.y0 * view.cell;
    const h = (L.y1 - L.y0 + 1) * view.cell;
    if (y > info.H || y + h < 0) continue;
    const m = MICRO && MICRO[L.id];
    let tint = null;
    let label = '';
    const nb = m && m.nursery ? m.nursery[season] : undefined;
    if (Number.isFinite(nb) && nb !== 0) {
      tint = nb > 0 ? '#ffb347' : '#5fb0ff';
      label = `Nursery ${nb > 0 ? '+' : ''}${Math.round(nb * 100)}%`;
    }
    if (m && m.garden) label += `${label ? ' · ' : ''}Fungus ×${m.garden}`;
    if (m && m.granarySpoil) label += `${label ? ' · ' : ''}Granary spoilage`;
    if (tint) {
      ctx.fillStyle = rgba(tint, 0.16);
      ctx.fillRect(x0, y, w, h);
    }
    if (label) {
      ctx.fillStyle = 'rgba(15,9,4,0.65)';
      const tw = ctx.measureText(label).width + 8;
      ctx.fillRect(x0 + 4, y + 3, tw, 14);
      ctx.fillStyle = '#ffeacc';
      ctx.fillText(label, x0 + 8, y + 5);
    }
  }
  // flood zone (topsoil rows that flood during rainstorms)
  const fr = DIG && DIG.floodRows ? DIG.floodRows : [0, 5];
  const fy = view.oy + fr[0] * view.cell;
  const fh = (fr[1] - fr[0] + 1) * view.cell;
  const pat = hatchPattern(ctx, 'horiz', '#5fb0ff', 0.4, 8);
  ctx.fillStyle = pat || 'rgba(95,176,255,0.12)';
  ctx.fillRect(x0, fy, w, fh);
  // projected frost line
  const row = projectedFrostRow(s, d);
  const y = view.oy + row * view.cell;
  ctx.strokeStyle = 'rgba(220,240,255,0.95)';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x0 + w, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(15,9,4,0.65)';
  ctx.fillRect(x0 + w - 108, y - 15, 104, 13);
  ctx.fillStyle = '#e6f4ff';
  ctx.textAlign = 'right';
  ctx.fillText(`Frost line: row ${row}`, x0 + w - 8, y - 14);
  ctx.textAlign = 'left';
}

function raidReach(ctx, info) {
  const { view, entField, open } = info;
  const reach = (GEOM && GEOM.raidReach) || 15;
  const r0 = Math.max(0, Math.floor(info.rowTop));
  const r1 = Math.min(GRID.rows - 1, Math.ceil(info.rowBot));
  for (let y = r0; y <= r1; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      const dd = entField[i];
      if (dd < 0 || dd > reach || !open[i]) continue;
      ctx.fillStyle = rgba(NEST.raid, 0.32 * (1 - dd / (reach + 4)));
      ctx.fillRect(view.ox + x * view.cell, view.oy + y * view.cell, view.cell, view.cell);
    }
  }
  // the reach also covers soil next to reachable cells (where a chamber placed there would be robbed)
  const pat = hatchPattern(ctx, 'diag', NEST.raid, 0.35, 8);
  if (pat) {
    ctx.fillStyle = pat;
    ctx.beginPath();
    for (let y = r0; y <= r1; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        if (open[i]) continue;
        const nb = [i - COLS, i + COLS, x > 0 ? i - 1 : -1, x < COLS - 1 ? i + 1 : -1];
        let near = false;
        for (const n of nb) if (n >= 0 && n < entField.length && entField[n] >= 0 && entField[n] < reach) near = true;
        if (near) ctx.rect(view.ox + x * view.cell, view.oy + y * view.cell, view.cell, view.cell);
      }
    }
    ctx.fill();
  }
}

function haul(ctx, info) {
  const { view, mainField, open, s, d } = info;
  let maxD = 1;
  for (let i = 0; i < mainField.length; i++) if (mainField[i] > maxD) maxD = mainField[i];
  const r0 = Math.max(0, Math.floor(info.rowTop));
  const r1 = Math.min(GRID.rows - 1, Math.ceil(info.rowBot));
  for (let y = r0; y <= r1; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      if (!open[i] || mainField[i] < 0) continue;
      ctx.fillStyle = rgba(ramp(1 - mainField[i] / maxD), 0.45);
      ctx.fillRect(view.ox + x * view.cell, view.oy + y * view.cell, view.cell, view.cell);
    }
  }
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const ch of (s && s.run && s.run.nest && s.run.nest.chambers) || []) {
    if (!ch || (ch.type !== 'granary' && ch.type !== 'royal_chamber')) continue;
    let best = -1;
    for (let yy = ch.y; yy < ch.y + ch.h; yy++) {
      for (let xx = ch.x; xx < ch.x + ch.w; xx++) {
        const v = mainField[yy * COLS + xx];
        if (v >= 0 && (best < 0 || v < best)) best = v;
      }
    }
    if (best < 0) continue;
    const c = info.chamberCenter(ch);
    const text = `path ${best}`;
    ctx.fillStyle = 'rgba(15,9,4,0.7)';
    ctx.fillRect(c.x - 24, c.y - 7, 48, 14);
    ctx.fillStyle = '#ffeacc';
    ctx.fillText(text, c.x, c.y);
  }
  const h = d && d.nest && d.nest.agg && Number.isFinite(d.nest.agg.haulH) ? d.nest.agg.haulH : null;
  if (h !== null) {
    const text = `Haul h = ${h.toFixed(2)}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(15,9,4,0.75)';
    ctx.fillRect(8, 8, ctx.measureText(text).width + 12, 18);
    ctx.fillStyle = '#ffeacc';
    ctx.fillText(text, 14, 17);
  }
}

/** Chamber type pair → adjacency rule colour (bonus green, penalty red). */
export function adjacencyColor(a, b) {
  const pair = (x, y) => (a === x && b === y) || (a === y && b === x);
  if (pair('nursery', 'royal_chamber') || pair('scent_library', 'royal_chamber') || pair('granary', 'repletion_hall')
    || pair('fungus_garden', 'water_well')) return '#5ed17a';
  if (pair('midden', 'nursery') || pair('midden', 'fungus_garden')) return '#e5484d';
  return 'rgba(240,226,200,0.55)';
}

/**
 * Adjacent chamber uid pairs: d.nest.chambers[].adj when available, otherwise footprints that touch.
 * @param {any} s
 * @param {any} d
 * @returns {Array<[any, any]>}
 */
export function adjacencyPairs(s, d) {
  const chs = (s && s.run && s.run.nest && s.run.nest.chambers) || [];
  const dch = (d && d.nest && d.nest.chambers) || [];
  const byUid = new Map();
  for (const c of chs) if (c) byUid.set(c.uid, c);
  const out = [];
  const seen = new Set();
  let usedDerived = false;
  for (let i = 0; i < dch.length; i++) {
    const dc = dch[i];
    if (!dc || !Array.isArray(dc.adj)) continue;
    usedDerived = true;
    for (const u of dc.adj) {
      const k = dc.uid < u ? `${dc.uid}:${u}` : `${u}:${dc.uid}`;
      if (seen.has(k) || !byUid.has(u) || !byUid.has(dc.uid)) continue;
      seen.add(k);
      out.push([byUid.get(dc.uid), byUid.get(u)]);
    }
  }
  if (usedDerived) return out;
  for (let i = 0; i < chs.length; i++) {
    for (let j = i + 1; j < chs.length; j++) {
      const a = chs[i];
      const b = chs[j];
      if (!a || !b) continue;
      const touch = a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
        && !((a.x + a.w === b.x || b.x + b.w === a.x) && (a.y + a.h === b.y || b.y + b.h === a.y));
      if (touch) out.push([a, b]);
    }
  }
  return out;
}

/**
 * Adjacency link lines (all pairs, or only those involving `focusUid`).
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} info
 * @param {number|null} focusUid
 */
export function adjacency(ctx, info, focusUid) {
  const pairs = adjacencyPairs(info.s, info.d);
  ctx.lineCap = 'round';
  for (const [a, b] of pairs) {
    if (focusUid !== null && a.uid !== focusUid && b.uid !== focusUid) continue;
    const pa = info.chamberCenter(a);
    const pb = info.chamberCenter(b);
    ctx.strokeStyle = adjacencyColor(a.type, b.type);
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [pa, pb]) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Surface overlays
// ----------------------------------------------------------------------------------------------------------------

function hexPath(ctx, p, r) {
  const c = hexCorners(p.x, p.y, r);
  ctx.moveTo(c[0], c[1]);
  for (let k = 1; k < 6; k++) ctx.lineTo(c[2 * k], c[2 * k + 1]);
  ctx.closePath();
}

/**
 * Draw the active Above overlays.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Record<string, boolean>} ov
 * @param {{ s: any, d: any, hexToScreen: (h:number)=>{x:number,y:number}, hexR: number, owned: Uint8Array, border: Uint8Array,
 *           rivalOf: Int16Array, rivalByUid: Map<number, any>, radiusCount: number, revealed: number[], trailPolys: any[], visible: (p:any)=>boolean }} info
 */
export function drawSurfaceOverlays(ctx, ov, info) {
  if (!ov || !ctx) return;
  if (ov.territory) territory(ctx, info);
  if (ov.danger) danger(ctx, info);
  if (ov.trail_strength) trailStrength(ctx, info);
  if (ov.richness) richness(ctx, info);
}

/** C242: anchor a screen-space fill pattern to the map (info.origin = screen point of world (0, 0), info.zoom). */
function mapPattern(pat, info) {
  const o = info && info.origin;
  return o ? anchorPattern(pat, o.x, o.y, info.zoom || 1) : pat;
}

function territory(ctx, info) {
  const { owned, border, rivalOf, rivalByUid, radiusCount, hexR } = info;
  for (const code of [1, 2, 3, 4]) {
    ctx.fillStyle = rgba(OWNED_TINT[code], 0.35);
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < radiusCount; i++) {
      if (owned[i] !== code) continue;
      const p = info.hexToScreen(i);
      if (!info.visible(p)) continue;
      hexPath(ctx, p, hexR * 0.96);
      any = true;
    }
    if (any) ctx.fill();
    // C162: trail-held hexes (temporary, lost with the trail) also carry a fine diagonal hatch
    if (any && code === 4) {
      const pat = mapPattern(hatchPattern(ctx, 'diag', OWNED_TINT[4], 0.8, 6), info);
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fill();
      }
    }
  }
  // border hexes
  ctx.strokeStyle = SURFACE.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < radiusCount; i++) {
    if (!border[i]) continue;
    const p = info.hexToScreen(i);
    if (info.visible(p)) hexPath(ctx, p, hexR * 0.8);
  }
  ctx.stroke();
  // rival land, patterned per rival
  const groups = new Map();
  for (let i = 0; i < radiusCount; i++) {
    const u = rivalOf[i];
    if (!u) continue;
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push(i);
  }
  for (const [u, hexes] of groups) {
    const r = rivalByUid.get(u);
    const col = rivalColor(r ? r.type : '', r ? r.tier : 1);
    const pat = mapPattern(hatchPattern(ctx, rivalPatternKind(r ? r.type : '', r ? r.tier : 1), col, 0.85, 9), info);
    ctx.fillStyle = pat || rgba(col, 0.35);
    ctx.beginPath();
    for (const i of hexes) {
      const p = info.hexToScreen(i);
      if (info.visible(p)) hexPath(ctx, p, hexR * 0.96);
    }
    ctx.fill();
  }
  legend(ctx, [['Auto', OWNED_TINT[1]], ['Claimed', OWNED_TINT[2]], ['Conquered', OWNED_TINT[3]], ['Held by trail', OWNED_TINT[4], 'diag'],
    ['Border', SURFACE.border]]);
}

function legend(ctx, items) {
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let x = 8;
  const y = 14;
  ctx.fillStyle = 'rgba(15,20,10,0.7)';
  let w = 8;
  for (const [t] of items) w += ctx.measureText(t).width + 22;
  ctx.fillRect(4, 4, w, 20);
  for (const [t, c, hatch] of items) {
    ctx.fillStyle = hatch ? rgba(c, 0.35) : c;
    ctx.fillRect(x, y - 5, 10, 10);
    const pat = hatch ? hatchPattern(ctx, hatch, c, 0.95, 4) : null;
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(x, y - 5, 10, 10);
    }
    ctx.fillStyle = '#f4ecd8';
    ctx.fillText(t, x + 13, y);
    x += ctx.measureText(t).width + 22;
  }
}

function danger(ctx, info) {
  const { s, d, hexR, radiusCount, border } = info;
  const set = new Set();
  for (const h of (d && d.combat && d.combat.danger) || []) if (h >= 0 && h < radiusCount) set.add(h);
  for (let i = 0; i < radiusCount; i++) if (border[i]) set.add(i);
  for (const o of (s && s.run && s.run.events && s.run.events.objects) || []) {
    if (o && (o.kind === 'antlion' || o.kind === 'lizard') && o.hex >= 0) set.add(o.hex);
  }
  const pat = mapPattern(hatchPattern(ctx, 'cross', SURFACE.raid, 0.7, 9), info);
  ctx.fillStyle = pat || 'rgba(255,59,48,0.3)';
  ctx.beginPath();
  for (const h of set) {
    const p = info.hexToScreen(h);
    if (info.visible(p)) hexPath(ctx, p, hexR * 0.92);
  }
  ctx.fill();
  // trails most likely to be raided: not entirely inside owned land
  const dts = (d && d.surface && d.surface.trails) || [];
  ctx.strokeStyle = 'rgba(255,90,70,0.9)';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i < info.trailPolys.length; i++) {
    const tp = info.trailPolys[i];
    const dd = dts[i];
    if (!tp || (dd && dd.safe)) continue;
    ctx.beginPath();
    for (let k = 0; k < tp.length; k++) {
      if (k === 0) ctx.moveTo(tp[k].x, tp[k].y);
      else ctx.lineTo(tp[k].x, tp[k].y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function trailStrength(ctx, info) {
  const { s } = info;
  const trails = (s && s.run && s.run.surface && s.run.surface.trails) || [];
  const sMax = (TRAIL && TRAIL.sMax) || 100;
  ctx.lineCap = 'round';
  for (let i = 0; i < trails.length; i++) {
    const tp = info.trailPolys[i];
    if (!tp || tp.length < 2) continue;
    const f = Math.max(0, Math.min(1, (trails[i].S || 0) / sMax));
    ctx.strokeStyle = rgba(ramp(f), 0.9);
    ctx.lineWidth = 7;
    ctx.beginPath();
    for (let k = 0; k < tp.length; k++) {
      if (k === 0) ctx.moveTo(tp[k].x, tp[k].y);
      else ctx.lineTo(tp[k].x, tp[k].y);
    }
    ctx.stroke();
    const mid = tp[Math.floor(tp.length / 2)];
    const text = `S ${Math.round(trails[i].S || 0)}`;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(15,20,10,0.75)';
    ctx.fillRect(mid.x - 18, mid.y - 16, 36, 13);
    ctx.fillStyle = '#f4ecd8';
    ctx.fillText(text, mid.x, mid.y - 9.5);
  }
}

function richness(ctx, info) {
  const { s, d } = info;
  const slope = d && d.surface && d.surface.slope > 0 ? d.surface.slope : (TRAIL && TRAIL.slope) || 0.35;
  const trails = (s && s.run && s.run.surface && s.run.surface.trails) || [];
  const lenBySrc = new Map();
  for (const t of trails) if (t && t.src) lenBySrc.set(t.src, t.len);
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const src of (s && s.run && s.run.surface && s.run.surface.sources) || []) {
    if (!src || !(src.hex >= 0) || !info.revealed[src.hex] || (src.data && src.data.dormant)) continue;
    const p = info.hexToScreen(src.hex);
    if (!info.visible(p)) continue;
    const known = lenBySrc.has(src.uid);
    const len = known ? lenBySrc.get(src.uid) : hexDist(0, src.hex);
    const r = 1 + slope * (Math.max(1, len) - 1);
    const def = SOURCES && SOURCES[src.type];
    let cap = def ? def.cap : null;
    if (src.type === 'aphid_colony' && def && def.capPerLevel) cap = def.capPerLevel * (src.level || 1);
    const text = `r${known ? '' : '≈'}${r.toFixed(2)}${Number.isFinite(cap) && cap > 0 ? ` · c${cap}` : ''}`;
    const tw = ctx.measureText(text).width + 8;
    ctx.fillStyle = 'rgba(15,20,10,0.78)';
    ctx.fillRect(p.x - tw / 2, p.y + info.hexR * 0.55, tw, 13);
    ctx.fillStyle = '#e8ffd0';
    ctx.fillText(text, p.x, p.y + info.hexR * 0.55 + 6.5);
  }
}

/** True when a cell code is open (tunnel or dug chamber cell). */
export function isOpenCode(c) {
  return c === CELL.TUNNEL || c === CELL.CHAMBER;
}

/** Locate ping (nest.ping / surface.ping): seconds a highlight ring stays on screen. */
export const PING_SEC = 1.5;

/**
 * Locate ping (nest.ping / surface.ping, ARCHITECTURE §13.3): highlight rings at a screen point. `u` ∈ [0, 1] is the
 * ping's progress. Normally three staggered rings expand from r0 to r1 and fade; with reduced motion a steady double
 * ring fades out over the last 30 % instead. A dark under-stroke keeps the warm stroke readable on any ground.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} u
 * @param {{ r0: number, r1: number, reduced?: boolean, color?: string }} o
 */
export function drawPing(ctx, x, y, u, { r0, r1, reduced = false, color = '#ffe08a' }) {
  if (!ctx || !Number.isFinite(x) || !Number.isFinite(y) || !(u >= 0 && u <= 1)) return;
  const a0 = Math.max(2, Number.isFinite(r0) ? r0 : 8);
  const a1 = Math.max(a0 + 4, Number.isFinite(r1) ? r1 : 30);
  const ring = (r, alpha, w) => {
    if (!(alpha > 0.01) || !(r > 0)) return;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(20,12,6,${(0.55 * alpha).toFixed(3)})`;
    ctx.lineWidth = w + 2.5;
    ctx.stroke();
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = w;
    ctx.stroke();
  };
  if (reduced) {
    const alpha = u < 0.7 ? 1 : Math.max(0, (1 - u) / 0.3);
    ring(a0 + (a1 - a0) * 0.35, alpha, 2.5);
    ring(a0 + (a1 - a0) * 0.7, alpha * 0.6, 1.5);
    return;
  }
  for (let k = 0; k < 3; k++) {
    const w = (u - k * 0.18) / 0.64;
    if (w <= 0 || w >= 1) continue;
    const e = 1 - (1 - w) * (1 - w);
    ring(a0 + (a1 - a0) * e, Math.pow(1 - w, 1.4), 2.5 - k * 0.5);
  }
  // a soft dot marks the exact spot while the rings run
  const dot = Math.max(0, 1 - u / 0.8);
  if (dot > 0.01) {
    ctx.fillStyle = rgba(color, 0.55 * dot);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, a0 * 0.45), 0, Math.PI * 2);
    ctx.fill();
  }
}
