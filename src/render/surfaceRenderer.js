// Above canvas: the top-down backyard hex map. Terrain cache (seasonal palette, textured per terrain; rebuilt on map or
// season change) → territory tint, patterned rival land and fog (land cache, rebuilt on surface rev) → frontier shimmer
// → trails (width 1 + log10(workers), opacity S/S_max) → sources (icons + stock ring) → mound, entrances, rival nests,
// party markers, raid arrows → event objects, Golden Beetle, gifts, daughter colonies → ant sprites on Catmull-Rom
// trail splines → battle bubbles → weather → overlays → tool previews. Owner: WP8. Contract: ARCHITECTURE §13.3
// (createSurfaceRenderer), §13.4–§13.6, §13.8; DESIGN §8, §9.9, §25.5. Reads game.s / game.d / ui only.
// WP8-internal extensions on the returned object: game, input, panBy(dx, dy), zoomAt(f, x, y), getCamera(),
// trailScreenPolyline(uid), entranceAt(hex).

import { HEX, GRID } from '../data/balance.js';
import { TERRAIN, TERRAIN_ORDER, TRAIL, SCOUT, TERRITORY } from '../data/surface.js';
import { SOURCES } from '../data/sources.js';
import { RESET } from '../data/prestige.js';
import { GOLDEN } from '../data/events.js';
import { FEDERATION } from '../data/federation.js';
import * as surfaceSys from '../systems/surface.js';
import { OWN_TRAIL } from '../systems/surface.js';
import * as nestSys from '../systems/nest.js';
import { hexToPixel, hexQR, hexIndex, ringOf, countInRadius, hexDist, DIRS, HEX_COUNT } from '../core/hex.js';
import { createLayer, createOffscreen, pageHidden, nowMs, reducedMotion } from './canvas.js';
import { createSurfaceCamera } from './camera.js';
import { drawIconAmbient, drawAmbientExtras, windStrength } from './ambient.js';
import { hexToPx, pxToHexInRadius, worldToScreen, hexCorners, clamp, hash01, arcTable, pointAtArc, distToPolyline, trailCurve, pathObstacles, laneLayout, laneCurve, SQRT3 } from './geom.js';
import {
  terrainColor, SURFACE, CARRY_CODES, mix, shade, rgba, hatchPattern, rivalColor,
  rivalPatternKind, seasonBlend, blendWash, blendWeather,
} from './palette.js';
import { getAtlas } from './atlas.js';
import * as cosmetics from './cosmetics.js';
import { BUDGET, REALLOC_SEC, createPool, reconcile, allocAbove, KIND } from './sprites.js';
import { createParticles, PK, MAX_PARTICLES } from './particles.js';
import { drawSurfaceOverlays, drawPing, PING_SEC } from './overlays.js';
import { createBattleBubbles } from './battle.js';
import { seamHub } from './seam.js';
import { activeCeremony, drawCeremonySurface, ceremonyZoom, ceremonyHidesSurfaceSprites, compactInt, registerRenderer } from './ceremony.js';

const SIZE = HEX.px;
/** Default framing (introZoom): rings around the nest kept in view, the width share they fill on wide canvases, the
 *  zoom cap, and the canvas width under which the area simply fills the width (phones). */
const INTRO_RINGS = 3;
const INTRO_FILL = 0.42;
const INTRO_ZOOM_MAX = 1.35;
const INTRO_NARROW = 480;
/** C163: fine cache resolution (zoomed in): pixel budget, scale cap, and the zoom × DPR over base scale that turns it
 *  on / off (hysteresis). */
const HI_CACHE_PX = 9e6;
const HI_CACHE_SCALE = 3.2;
const HI_ON = 1.6;
const HI_OFF = 1.3;
/** C163: …and only past the old 1.6 zoom cap, so the default views keep the base caches (memory). */
const HI_ZOOM_ON = 1.6;
const HI_ZOOM_OFF = 1.45;
/** Satellite placement tint: valid sites. */
const SAT_OK = '#6fdc82';
/** Pointy-top corner pairs of the edge shared with the neighbour in DIRS[k]. */
const EDGE = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
/** Sources that are hunted / raided instead of hand-foraged (DESIGN §8.10). */
export const WAR_SOURCES = new Set(['prey_caterpillar', 'prey_cricket', 'prey_beetle', 'termite_mound']);
/** Event object kinds that the Above view draws. */
const OBJECT_ICON = {
  fruit: 'fallen_fruit', ladybug: 'ladybug', molehill: 'molehill', antlion: 'antlion', lizard: 'lizard', termite_swarm: 'termite_swarm',
  golden_aphid: 'golden_aphid', rival_alate: 'rival_alate', phengaris: 'phengaris', myrmecophile: 'myrmecophile',
  wandering_queen: 'wandering_queen', army_column: 'army_column', footstep: 'footstep',
  fossil_cache: 'fossil', lost_queen: 'wandering_queen',   // C188 expedition finds (the fossil is drawn here, drawFossil)
};
/** C188: expedition-find sources drawn with an existing icon (rich seed patch: a seed patch with a gold rim). */
const ICON_ALIAS = { rich_seed_patch: 'seed_patch', beetle_carcass: 'prey_beetle' };

/** Behaviour states (Above). */
const ST = Object.freeze({ OUT: 0, BACK: 1, AWAY: 2, WANDER: 3, HOME: 4 });

function uiOf(ui) {
  try {
    if (ui && typeof ui.getUI === 'function') return ui.getUI() || {};
  } catch {
    return {};
  }
  return ui && typeof ui === 'object' ? ui : {};
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Terrain id of a stored code. */
function terrainId(code) {
  const order = TERRAIN_ORDER;
  return order[code] || 'grass';
}

const GROUND_IDS = ['grass', 'leaf_litter', 'sand'];

/**
 * C111: the ground a puddle / garden-path hex is drawn on — its most common grass / leaf-litter / sand neighbour
 * (ties: that order), grass when it has none. Deterministic from the terrain alone.
 */
export function groundUnder(ter, i, n) {
  const [q, r] = hexQR(i);
  const c = { grass: 0, leaf_litter: 0, sand: 0 };
  for (const [dq, dr] of DIRS) {
    const h = hexIndex(q + dq, r + dr);
    if (h < 0 || h >= n) continue;
    const id = terrainId(ter[h]);
    if (id in c) c[id]++;
  }
  let best = 'grass';
  let bn = 0;
  for (const id of GROUND_IDS) {
    if (c[id] > bn) {
      bn = c[id];
      best = id;
    }
  }
  return best;
}

/** 2-D value noise in [0, 1] (deterministic). */
function noise2(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash01(xi * 73 + seed, yi * 37);
  const b = hash01((xi + 1) * 73 + seed, yi * 37);
  const c = hash01(xi * 73 + seed, (yi + 1) * 37);
  const d = hash01((xi + 1) * 73 + seed, (yi + 1) * 37);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/**
 * Is a source the target of the onboarding / advisor glow (uistate.glow)? Keys are the vocabulary shared with
 * ui/onboarding.js: 'canvas:crumb' (crumb sources), 'canvas:bestSource' (d.surface.bestSource), 'source:<uid>'.
 * ARCH-R: §14.4 types glow only as a string; the 'canvas:*' keys follow WP9's documented vocabulary (the Below view
 * handles 'canvas:royal' and 'canvas:digFace').
 * @param {string|null} glow
 * @param {{ uid: number, type: string }} src
 * @param {any} d
 * @returns {boolean}
 */
export function sourceGlows(glow, src, d) {
  if (!glow || typeof glow !== 'string' || !src) return false;
  if (glow === `source:${src.uid}`) return true;
  if (glow === 'canvas:crumb' || glow === 'crumb' || glow === 'crumb_scatter') return src.type === 'crumb_scatter';
  if (glow === 'canvas:bestSource') return !!(d && d.surface && d.surface.bestSource === src.uid);
  return false;
}

/** Carried item for a trail's job/source. */
function carryFor(job, srcType, k) {
  if (job === 'herder' || job === 'lycaenid') return 2;
  if (job === 'leafcutter') return 3;
  if (srcType === 'dead_insect' || srcType === 'termite_swarm') return k % 4 === 0 ? 4 : 1;
  return 1;
}

/**
 * Create the Above renderer.
 * @param {HTMLCanvasElement} canvas
 * @param {{ game: any, ui: any, bus: any }} opts
 */
export function createSurfaceRenderer(canvas, { game, ui, bus } = {}) {
  const layer = createLayer(canvas, { maxDpr: 2 });
  const cam = createSurfaceCamera();
  const atlas = getAtlas();
  const pool = createPool(BUDGET.above);
  // ARCH-R: "particles ≤ 300" (DESIGN §25.5, §13.5) read as per view: the two pools of this view share the cap
  // (world-space effects + screen-space weather); the Below view has its own pool of 220.
  const fxWorld = createParticles(110);
  const fxScreen = createParticles(MAX_PARTICLES - 110);
  const battles = createBattleBubbles();
  const hub = seamHub(game);

  let layerVersion = -1;
  let visible = true;
  let destroyed = false;
  let time = 0;
  let lastS = null;
  let reallocIn = 0;
  let K = 1;
  let reduced = false;
  let reducedAt = -1;
  let rectCache = null;
  let rectAt = -1e9;
  let trailSig = '';
  let scentIn = 0;
  /** apply the default framing (nest centred, introZoom) at the next viewport check */
  let firstFrame = true;
  /** true once the player panned / zoomed or a caller centred the view: layout changes then keep the framing */
  let userMoved = false;
  /** locate pings { hex, start } (start in nowMs()) */
  const pings = [];
  /** satellite placement tint (tool 'placeSatellite'): world-space offscreen cache + per-hex reasons */
  const satCache = { canvas: null, ctx: null, key: '', scale: 1, R: 0, ox: 0, oy: 0, reasons: [], valid: 0, global: null };

  /** C123: terrain caches by key (one per season; ≤ 2 live: the current season and, during the last
   *  SEASON_BLEND_SEC of a season, the next one, cross-faded over it). */
  const terrainCaches = new Map();
  /** last terrain build time in ms (perf probe, getPerf) */
  let terrainBuildMs = 0;
  let laneBuildMs = 0;
  /** C161 perf probe: smoothed ms of the sources + objects pass (icons with their ambient life) */
  let ambientMs = 0;
  /** C163: terrain / land caches at the fine resolution (zoomed in; syncHiRes) */
  let hiRes = false;
  /** C123: pre-warm weather on the next frame (load, import, run start, view shown again, resize, long gap) */
  let weatherFill = true;
  let lastRenderAt = 0;
  const landCache = { canvas: null, key: '', scale: 1, R: 0, ox: 0, oy: 0 };
  /** Fallback territory when d.surface is not derived yet. */
  const terr = { key: '', owned: new Uint8Array(HEX_COUNT), border: new Uint8Array(HEX_COUNT), rival: new Int16Array(HEX_COUNT), frontier: [] };
  /** trail uid → { sig, world, tab } */
  const trailGeo = new Map();
  /** C128: signature of the impassable-terrain hexes (stone, spring puddles) the trail curves avoid; set per frame */
  let blockKey = '';
  /** C134: lane layout of the live trails (geom.laneLayout) and the signature of the trail paths it was built for */
  let lanes = new Map();
  let laneKey = '';
  const claimMemo = { key: '', res: null };
  /** C161: ambient life this frame: wind strength from the weather (windStrength) and whether it runs at all */
  const amb = { wind: 1, on: true };
  const pulses = []; // { kind, uid, hex, t, max }

  /** Preview channel written by surfaceInput.js (WP8-internal). */
  const input = { hoverHex: -1, trailDrag: null, reroute: null, warDrag: null, pointer: null };

  const offs = [];
  function sub(type, fn) {
    if (bus && typeof bus.on === 'function') offs.push(bus.on(type, fn));
  }
  sub('clicked', (e) => {
    const s = S();
    if (!s || !e) return;
    const src = (s.run.surface.sources || []).find((x) => x && x.uid === e.src);
    const p = src ? hexWorldPt(src.hex) : hexWorldPt(0);
    fxWorld.float(p.x + (Math.random() - 0.5) * 8, p.y - 10, `+${compactInt(Number(e.amount) || 0)} ${e.res || 'food'}`, '#fff3c4', e.res || 'food');
  });
  // C223: a clicked event object that pays out (a caught rival alate, a fossil cache) shows its gain like a crumb
  sub('objectGain', (e) => {
    if (!e || !(e.hex >= 0) || !(Number(e.amount) > 0)) return;
    const p = hexWorldPt(e.hex);
    fxWorld.float(p.x + (Math.random() - 0.5) * 8, p.y - 12, `+${compactInt(Number(e.amount) || 0)} ${e.res || ''}`.trim(), '#fff3c4', e.res || null);
  });
  sub('hexRevealed', (e) => {
    if (!e || !(e.hex >= 0) || reduced) return;
    const p = hexWorldPt(e.hex);
    fxWorld.sparkle(p.x, p.y, 4, 14);
  });
  sub('sourceSpawned', (e) => {
    const s = S();
    if (!s || !e) return;
    const src = (s.run.surface.sources || []).find((x) => x && x.uid === e.uid);
    if (!src || !(src.hex >= 0)) return;
    const p = hexWorldPt(src.hex);
    fxWorld.ripple(p.x, p.y, '#fff3c4', 40, 0.8);
  });
  sub('abilityUsed', (e) => {
    if (!e) return;
    pulses.push({ kind: e.id, uid: e.uid, t: 0, max: e.id === 'mark' ? 0.8 : 1.4 });
  });
  sub('claimDone', (e) => {
    if (!e || !(e.hex >= 0)) return;
    const p = hexWorldPt(e.hex);
    fxWorld.ripple(p.x, p.y, SURFACE.player, 40, 0.9);
  });
  sub('moundLeveled', () => {
    const p = hexWorldPt(0);
    fxWorld.dust(p.x, p.y, 10, '#8a5d38');
    fxWorld.sparkle(p.x, p.y - 6, 6, 18);
  });
  sub('radiusChanged', (e) => {
    if (e && e.radius > 0) cam.setRadius(e.radius);
  });
  sub('conquest', (e) => {
    const s = S();
    if (!s || !e) return;
    const r = (s.run.rivals.list || []).find((x) => x && x.uid === e.uid);
    const p = hexWorldPt(r ? r.hex : 0);
    fxWorld.ripple(p.x, p.y, SURFACE.player, 70, 1.6);
    fxWorld.ripple(p.x, p.y, '#ffffff', 45, 1.1);
  });
  sub('beetleClaimed', (e) => {
    const s = S();
    const b = s && s.run.golden && s.run.golden.beetle;
    const p = hexWorldPt(b ? b.hex : lastBeetleHex);
    fxWorld.sparkle(p.x, p.y, 16, 40);
    if (e && e.roll) fxWorld.float(p.x, p.y - 14, String(e.roll).replace(/_/g, ' '), '#ffe066');
  });
  sub('eventSpawned', () => {
    reallocIn = Math.min(reallocIn, 0.1);
  });
  for (const t of ['trailCreated', 'trailDeleted']) sub(t, () => {
    trailSig = '';
    reallocIn = 0;
  });
  for (const t of ['runStarted', 'supercolonyComplete', 'speciationComplete', 'reset', 'imported']) sub(t, () => dropCaches());
  let lastBeetleHex = 0;

  // ---------------------------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------------------------

  function S() {
    return game && game.s ? game.s : null;
  }
  function D() {
    return game && game.d ? game.d : null;
  }
  function hexWorldPt(hex) {
    if (!(hex >= 0 && hex < HEX_COUNT)) return { x: 0, y: 0 };
    const [x, y] = hexToPixel(hex, SIZE);
    return { x, y };
  }
  function camView() {
    const z = ceremonyZoom(cam.zoom, cam.zoomMin);
    cam.zoomOverride = z;
    return cam.view();
  }
  let curView = cam.view();
  function hexToScreen(hex) {
    return hexToPx(hex, curView);
  }
  function w2s(x, y) {
    return worldToScreen(x, y, curView);
  }
  function radiusOf(s) {
    const r = s && s.run && s.run.surface ? s.run.surface.radius : 8;
    return clamp(Math.floor(r > 0 ? r : 8), 1, HEX.maxRadius);
  }
  function visiblePt(p, m = 40) {
    return p.x > -m && p.y > -m && p.x < layer.cssW + m && p.y < layer.cssH + m;
  }

  function dropCaches() {
    terrainCaches.clear();
    weatherFill = true;
    landCache.key = '';
    terr.key = '';
    trailGeo.clear();
    laneKey = '';
    trailSig = '';
    pool.n = 0;
    fxWorld.clear();
    fxScreen.clear();
    battles.clear();
    pulses.length = 0;
    claimMemo.key = '';
    reallocIn = 0;
    hub.clear();
    satCache.key = '';
    pings.length = 0;
    // a new run / reset / import: the new map starts on the default framing around the nest
    firstFrame = true;
    userMoved = false;
  }

  function ensureViewport(s) {
    if (layer.version !== layerVersion || cam.w !== layer.cssW || cam.h !== layer.cssH) {
      layerVersion = layer.version;
      weatherFill = true;
      cam.setViewport(layer.cssW, layer.cssH);
      // until the player moves the camera, every layout change (boot, the view being switched in, rotation)
      // re-applies the default framing for the real canvas size
      if (!userMoved) firstFrame = true;
    }
    const R = radiusOf(s);
    if (cam.radius !== R) cam.setRadius(R);
    if (firstFrame && layer.cssW > 0 && layer.cssH > 0) {
      firstFrame = false;
      cam.zoom = introZoom(layer.cssW, layer.cssH);
      cam.centerOnHex(0);
    }
  }

  /**
   * Default Above zoom: the nest area (rings 0–INTRO_RINGS: the start reveal, the crumb and a margin) at a comfortable
   * size. A phone-width canvas fills its width with that area (the old fit-the-whole-map rule dropped it to zoom 0.6);
   * a wide canvas zooms in until the area spans INTRO_FILL of the width, so it is not a small island; zoom 1 (the
   * desktop default) otherwise. Always within the camera's zoom range and the canvas height.
   * @param {number} W canvas CSS width
   * @param {number} H canvas CSS height
   * @returns {number}
   */
  function introZoom(W, H) {
    if (!(W > 0) || !(H > 0)) return clamp(1, cam.zoomMin, cam.zoomMax);
    const wNeed = (2 * INTRO_RINGS + 1) * SQRT3 * SIZE;
    const hNeed = (3 * INTRO_RINGS + 2) * SIZE;
    const fitW = (0.98 * W) / wNeed;
    const fitH = (0.8 * H) / hNeed;
    const want = W < INTRO_NARROW ? fitW : Math.max(1, (INTRO_FILL * W) / wNeed);
    return clamp(Math.min(want, fitW, fitH, INTRO_ZOOM_MAX), cam.zoomMin, cam.zoomMax);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // territory (derived or fallback)
  // ---------------------------------------------------------------------------------------------------------------

  function territory(s, d) {
    const ds = d && d.surface;
    if (ds && (ds.rev > 0 || ds.ownedCount > 0) && ds.owned && ds.owned.length === HEX_COUNT) {
      return { owned: ds.owned, border: ds.border, rival: ds.rival, frontier: Array.isArray(ds.frontier) && ds.frontier.length ? ds.frontier : fallbackFrontier(s) };
    }
    const surf = s.run.surface;
    const key = `${surf.rev}|${surf.mound}|${(surf.entrances || []).length}|${(s.run.rivals.list || []).length}`;
    if (key !== terr.key) {
      terr.key = key;
      terr.owned.fill(0);
      terr.rival.fill(0);
      terr.border.fill(0);
      const R = radiusOf(s);
      const n = countInRadius(R);
      for (const rv of s.run.rivals.list || []) {
        if (!rv || !rv.alive || !(rv.hex >= 0)) continue;
        const [q0, r0] = hexQR(rv.hex);
        const rad = rv.radius > 0 ? rv.radius : 2;
        for (let dq = -rad; dq <= rad; dq++) {
          for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad); dr++) {
            const h = hexIndex(q0 + dq, r0 + dr);
            if (h >= 0 && h < n) terr.rival[h] = rv.uid;
          }
        }
        for (const h of rv.extra || []) if (h >= 0 && h < n) terr.rival[h] = rv.uid;
        for (const h of rv.lost || []) if (h >= 0 && h < n && terr.rival[h] === rv.uid) terr.rival[h] = 0;
      }
      const autoR = ((TERRITORY && TERRITORY.autoBase) || 1) + Math.floor((surf.mound || 0) / ((TERRITORY && TERRITORY.autoPerMound) || 5));
      for (const e of surf.entrances || []) {
        if (!e || !(e.hex >= 0)) continue;
        const [q0, r0] = hexQR(e.hex);
        for (let dq = -autoR; dq <= autoR; dq++) {
          for (let dr = Math.max(-autoR, -dq - autoR); dr <= Math.min(autoR, -dq + autoR); dr++) {
            const h = hexIndex(q0 + dq, r0 + dr);
            if (h >= 0 && h < n && !terr.rival[h]) terr.owned[h] = 1;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (surf.claimed && surf.claimed[i] && !terr.rival[i]) terr.owned[i] = 2;
        if (surf.conquered && surf.conquered[i]) terr.owned[i] = 3;
      }
      for (let i = 0; i < n; i++) {
        if (!terr.owned[i]) continue;
        const [q, r] = hexQR(i);
        for (const [dq, dr] of DIRS) {
          const h = hexIndex(q + dq, r + dr);
          if (h >= 0 && terr.rival[h]) terr.border[i] = 1;
        }
      }
      terr.frontier = fallbackFrontier(s);
    }
    return terr;
  }

  function fallbackFrontier(s) {
    const surf = s.run.surface;
    const n = countInRadius(radiusOf(s));
    const out = [];
    const rev = surf.revealed || [];
    for (let i = 0; i < n; i++) {
      if (rev[i]) continue;
      const [q, r] = hexQR(i);
      for (const [dq, dr] of DIRS) {
        const h = hexIndex(q + dq, r + dr);
        if (h >= 0 && h < n && rev[h]) {
          out.push(i);
          break;
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // caches
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * World-space cache geometry for map radius R. The base resolution keeps ~4.2 M cache pixels (scale ≤ 2); C163: the
   * fine one (`hi`, used while zoomed in, see syncHiRes) allows ~9 M pixels and scale ≤ 3.2, so terrain and borders
   * stay crisp up to zoom 2.75 on 2× screens.
   */
  function cacheGeom(R, hi = false) {
    const wx = (R + 1) * SIZE * SQRT3;
    const wy = (R + 1) * SIZE * 1.5 + SIZE;
    const W = wx * 2;
    const H = wy * 2;
    const base = clamp(Math.sqrt(4.2e6 / (W * H)), 0.6, 2);
    const scale = hi ? Math.max(base, clamp(Math.sqrt(HI_CACHE_PX / (W * H)), 0.6, HI_CACHE_SCALE)) : base;
    return { W, H, wx, wy, scale };
  }

  /**
   * C163: switch the terrain and land caches to the fine resolution while the device-pixel zoom (zoom × DPR) is well
   * past what the base cache covers, and back once it drops again (hysteresis, so a pinch does not thrash rebuilds).
   * @param {number} R map radius
   */
  function syncHiRes(R) {
    const base = cacheGeom(R, false).scale;
    const need = curView.zoom * (layer.dpr > 0 ? layer.dpr : 1);
    const z = curView.zoom;
    if (!hiRes && z >= HI_ZOOM_ON && need > base * HI_ON) hiRes = true;
    else if (hiRes && (z < HI_ZOOM_OFF || need < base * HI_OFF)) hiRes = false;
  }

  function hexPathOn(g, cx, cy, r) {
    const c = hexCorners(cx, cy, r);
    g.moveTo(c[0], c[1]);
    for (let k = 1; k < 6; k++) g.lineTo(c[2 * k], c[2 * k + 1]);
    g.closePath();
  }

  function terrainChecksum(t) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + (t[i] | 0) + 7) | 0;
    return h;
  }

  /**
   * The terrain cache of `season` for the current map, built on first use. Keeps the caches still in use this frame
   * (`keep`: keys) and drops the others, so a season transition holds two canvases at most.
   * @returns {{ canvas: any, key: string, scale: number, R: number, ox: number, oy: number }}
   */
  function terrainFor(s, season, keep) {
    const surf = s.run.surface;
    const R = radiusOf(s);
    const key = `${surf.terrain && surf.terrain.length}|${terrainChecksum(surf.terrain || [])}|${season}|${R}|${s.run.seed}|${hiRes ? 'hi' : 'lo'}`;
    if (keep) keep.push(key);
    let terrainCache = terrainCaches.get(key);
    if (terrainCache && terrainCache.canvas) return terrainCache;
    const t0 = nowMs();
    terrainCache = { canvas: null, key, scale: 1, R: 0, ox: 0, oy: 0 };
    terrainCaches.set(key, terrainCache);
    buildTerrain(s, season, R, terrainCache);
    terrainBuildMs = nowMs() - t0;
    return terrainCache;
  }

  function pruneTerrain(keep) {
    if (terrainCaches.size <= keep.length) return;
    for (const k of [...terrainCaches.keys()]) if (!keep.includes(k)) terrainCaches.delete(k);
  }

  function buildTerrain(s, season, R, terrainCache) {
    const surf = s.run.surface;
    const gm = cacheGeom(R, hiRes);
    const off = createOffscreen(gm.W * gm.scale, gm.H * gm.scale);
    terrainCache.canvas = off.canvas;
    terrainCache.scale = gm.scale;
    terrainCache.R = R;
    terrainCache.ox = gm.wx;
    terrainCache.oy = gm.wy;
    const g = off.ctx;
    if (!g) return;
    g.setTransform(gm.scale, 0, 0, gm.scale, gm.wx * gm.scale, gm.wy * gm.scale);
    const n = countInRadius(Math.min(HEX.maxRadius, R + 1));
    // C135: terrain FEATURES (puddles, garden paths, stones, boulders, logs, roots) exist only inside the map radius;
    // the extra ring R + 1 (under the map-edge void, hiding seams) is plain ground
    const nMap = countInRadius(Math.min(HEX.maxRadius, R));
    const ter = surf.terrain || [];
    const stones = linkSet(ter, nMap, 'stone');
    const boulder = new Set(stones.hexes.filter((i) => stones.nb.get(i).some((h) => h >= 0)));
    // C111: puddle and garden-path hexes sit on the ground around them (their dominant grass / sand / leaf-litter
    // neighbour); the pool / path is then drawn once over the union of linked hexes (paintPaths / paintPools).
    // C135: so do linked stone hexes (one boulder over the union, paintBoulders) and every non-ground hex beyond the map
    const under = new Map();
    for (let i = 0; i < n; i++) {
      const id = terrainId(ter[i]);
      if (id === 'puddle' || id === 'garden_path' || boulder.has(i) || (i >= nMap && !GROUND_IDS.includes(id))) {
        under.set(i, groundUnder(ter, i, n));
      }
    }
    // base fill, slightly enlarged to hide seams
    const groundOf = (i) => under.get(i) || terrainId(ter[i]);
    const fillCol = new Array(n);
    for (let i = 0; i < n; i++) {
      const [x, y] = hexToPixel(i, SIZE);
      const id = groundOf(i);
      const [base, detail] = terrainColor(season, id);
      const nz = noise2(x / 70, y / 70, 3);
      fillCol[i] = mix(base, detail, nz * 0.45 + (hash01(i, 5) - 0.5) * 0.08);
      g.fillStyle = fillCol[i];
      g.beginPath();
      hexPathOn(g, x, y, SIZE * 1.03);
      g.fill();
    }
    // C183: soft ground transitions where two grounds meet (under the details, then a lighter pass over them)
    paintTransitions(g, n, groundOf, fillCol, 1);
    for (let i = 0; i < n; i++) {
      const [x, y] = hexToPixel(i, SIZE);
      const id = groundOf(i);
      paintTerrainDetail(g, id, season, i, x, y);
    }
    paintTransitions(g, n, groundOf, fillCol, 0.35);
    paintPaths(g, season, linkSet(ter, nMap, 'garden_path'));
    paintPools(g, season, linkSet(ter, nMap, 'puddle'), under);
    paintBoulders(g, season, { hexes: stones.hexes.filter((i) => boulder.has(i)), nb: stones.nb });
  }

  /**
   * C183: feathered, noise-shaped boundaries between different grounds (grass / sand / leaf litter / roots, and the
   * ground under puddles, paths and boulders). Along each edge shared by two different grounds, a few radial blobs
   * push one side's colour across the edge by a noise-driven amount (so the boundary wanders instead of following the
   * hex edge) and a soft wash of each colour fades into the other. `k` scales the opacity (the second, lighter pass runs
   * over the ground details). Deterministic (geom.hash01 / value noise), cached with the terrain.
   * @param {CanvasRenderingContext2D} g
   * @param {number} n hexes to consider
   * @param {(i: number) => string} groundOf ground id of a hex
   * @param {string[]} fillCol base fill colour per hex
   * @param {number} k opacity scale
   */
  function paintTransitions(g, n, groundOf, fillCol, k) {
    if (typeof g.createRadialGradient !== 'function') return;
    const blob = (x, y, r, col, a) => {
      if (!(r > 0.5) || !(a > 0.01)) return;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, rgba(col, a));
      gr.addColorStop(0.55, rgba(col, a * 0.6));
      gr.addColorStop(1, rgba(col, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    for (let i = 0; i < n; i++) {
      const gi = groundOf(i);
      const [q, r] = hexQR(i);
      const [x, y] = hexToPixel(i, SIZE);
      for (const [dq, dr] of DIRS) {
        const h = hexIndex(q + dq, r + dr);
        if (h <= i || h >= n || groundOf(h) === gi) continue;
        const [hx, hy] = hexToPixel(h, SIZE);
        const L = Math.hypot(hx - x, hy - y) || 1;
        const ux = (hx - x) / L;
        const uy = (hy - y) / L;
        const mx = (x + hx) / 2;
        const my = (y + hy) / 2;
        const S2 = 4;
        for (let s2 = 0; s2 < S2; s2++) {
          const t = ((s2 + 0.5) / S2 - 0.5) * SIZE * 0.98 + (hash01(i * 7 + h, s2 + 31) - 0.5) * SIZE * 0.12;
          const ex = mx - uy * t;
          const ey = my + ux * t;
          // the boundary wanders: positive pushes this hex's ground into the neighbour, negative the other way
          const off = (noise2(ex / 17, ey / 17, 13) - 0.5) * SIZE * 0.85 + (hash01(i * 13 + h, s2 + 37) - 0.5) * SIZE * 0.2;
          const rad = SIZE * (0.2 + 0.22 * noise2(ex / 23, ey / 23, 17)) + Math.abs(off) * 0.55;
          const into = off >= 0 ? fillCol[i] : fillCol[h];
          blob(ex + ux * off * 0.55, ey + uy * off * 0.55, rad, into, 0.85 * k);
          // soft wash both ways across the edge
          blob(ex - ux * SIZE * 0.12, ey - uy * SIZE * 0.12, SIZE * 0.34, fillCol[h], 0.32 * k);
          blob(ex + ux * SIZE * 0.12, ey + uy * SIZE * 0.12, SIZE * 0.34, fillCol[i], 0.32 * k);
        }
      }
    }
  }

  /** C135: clip to the union of a set's hexes (corner radius SIZE: the fog / void hexes, 1.04 x SIZE, cover it). */
  function clipToHexes(g, hexes) {
    g.beginPath();
    for (const i of hexes) {
      const [x, y] = hexToPixel(i, SIZE);
      hexPathOn(g, x, y, SIZE);
    }
    g.clip();
  }

  /**
   * C135: one irregular rock mass over the union of a linked stone set (like the C111 pools): a jagged polygon per hex,
   * a band to each linked neighbour and the triangle between three mutually linked hexes, one path with uniform
   * winding so a single fill is the union. k scales it, pad grows it.
   */
  function rockPath(g, set, k, pad) {
    g.beginPath();
    for (const i of set.hexes) {
      const [x, y] = hexToPixel(i, SIZE);
      const row = set.nb.get(i);
      const poly = [];
      const m = 9;
      const rot = hash01(i, 61) * 6.28;
      for (let v = 0; v < m; v++) {
        const a = rot + (v / m) * Math.PI * 2;
        const rr = SIZE * (0.72 + 0.16 * hash01(i * 11 + v, 63)) * k + pad;
        poly.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.92);
      }
      polyOn(g, poly);
      for (let dd = 0; dd < 6; dd++) {
        const h = row[dd];
        if (h < i) continue;
        const [hx, hy] = hexToPixel(h, SIZE);
        const len = Math.hypot(hx - x, hy - y) || 1;
        const w1 = SIZE * (0.56 + 0.14 * hash01(i * 97 + h, 65)) * k + pad;
        const w2 = SIZE * (0.56 + 0.14 * hash01(i * 97 + h, 67)) * k + pad;
        const ux = -(hy - y) / len;
        const uy = (hx - x) / len;
        polyOn(g, [x + ux * w1, y + uy * w1, hx + ux * w2, hy + uy * w2, hx - ux * w2, hy - uy * w2, x - ux * w1, y - uy * w1]);
        const h2 = row[(dd + 1) % 6];
        if (k >= 0.9 && h2 > i) {
          const [x2, y2] = hexToPixel(h2, SIZE);
          polyOn(g, [x, y, hx, hy, x2, y2]);
        }
      }
    }
  }

  /** C135: boulders - adjacent stone hexes drawn as one shaded, cracked rock mass (single stones keep their own art). */
  function paintBoulders(g, season, set) {
    if (!set.hexes.length) return;
    const [base, detail] = terrainColor(season, 'stone');
    const mids = linkMids(set);
    g.save();
    clipToHexes(g, set.hexes);
    // cast shadow (down-right), then the rock
    g.save();
    g.translate(SIZE * 0.08, SIZE * 0.14);
    g.fillStyle = 'rgba(0,0,0,0.28)';
    rockPath(g, set, 1, 0);
    g.fill();
    g.restore();
    g.fillStyle = shade(base, -0.28);
    rockPath(g, set, 1, 0);
    g.fill();
    // lit top face: the same mass nudged up-left leaves a dark rim on the lower-right edge
    g.save();
    rockPath(g, set, 1, 0);
    g.clip();
    g.save();
    g.translate(-SIZE * 0.06, -SIZE * 0.1);
    g.fillStyle = base;
    rockPath(g, set, 0.97, 0);
    g.fill();
    g.restore();
    // facets: lighter bulges per hex and link, toward the light (up-left)
    g.fillStyle = rgba(mix(base, '#ffffff', 0.35), 0.35);
    g.beginPath();
    const stations = set.hexes.map((i) => {
      const [x, y] = hexToPixel(i, SIZE);
      return { x, y, seed: i };
    }).concat(mids);
    for (const st of stations) {
      const r = (q) => hash01(st.seed * 17 + q, q * 5 + 1);
      const rx = SIZE * (0.26 + 0.12 * r(1));
      const ry = SIZE * (0.15 + 0.07 * r(2));
      const cx = st.x - SIZE * (0.14 + 0.08 * r(3));
      const cy = st.y - SIZE * (0.2 + 0.06 * r(4));
      const rot = -0.5 + 0.4 * r(5);
      g.moveTo(cx + rx * Math.cos(rot), cy + rx * Math.sin(rot));
      g.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
    }
    g.fill();
    if (season === 'winter') {
      g.fillStyle = 'rgba(250,252,255,0.7)';
      g.save();
      g.translate(-SIZE * 0.08, -SIZE * 0.2);
      rockPath(g, set, 0.6, 0);
      g.fill();
      g.restore();
    } else if (season !== 'summer') {
      // moss in the shaded seams
      g.fillStyle = rgba(mix(detail, '#4f7a2a', 0.6), 0.35);
      g.beginPath();
      for (const st of mids) {
        const r = (q) => hash01(st.seed * 23 + q, q * 3 + 7);
        if (r(1) < 0.45) continue;
        const rot = r(2) * 3;
        g.moveTo(st.x + SIZE * 0.08 + SIZE * 0.14 * Math.cos(rot), st.y + SIZE * 0.16 + SIZE * 0.14 * Math.sin(rot));
        g.ellipse(st.x + SIZE * 0.08, st.y + SIZE * 0.16, SIZE * 0.14, SIZE * 0.07, rot, 0, Math.PI * 2);
      }
      g.fill();
    }
    // C183: mottled shading — darker and lighter weathering patches scattered over the mass (not per hex outline)
    if (typeof g.createRadialGradient === 'function') {
      for (const st of stations) {
        for (let q = 0; q < 2; q++) {
          const r = (k) => hash01(st.seed * 41 + q * 7 + k, k * 11 + 3);
          const px = st.x + (r(1) - 0.5) * SIZE * 0.9;
          const py = st.y + (r(2) - 0.5) * SIZE * 0.8;
          const rad = SIZE * (0.22 + 0.26 * r(3));
          const col = r(4) < 0.55 ? shade(base, -0.3) : mix(base, '#ffffff', 0.3);
          const gr = g.createRadialGradient(px, py, 0, px, py, rad);
          gr.addColorStop(0, rgba(col, 0.3 + 0.14 * r(5)));
          gr.addColorStop(1, rgba(col, 0));
          g.fillStyle = gr;
          g.beginPath();
          g.arc(px, py, rad, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    // C183: organic fissures — noise-steered cracks that wander across the whole rock (they ignore the hex grid), taper
    // toward their tips and sometimes branch; a lit lip above each (light from the upper left)
    const cracks = boulderCracks(set);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const pass of [0, 1]) {
      g.save();
      if (pass === 1) g.translate(-0.7, -0.8);
      g.strokeStyle = pass === 0 ? 'rgba(32,30,36,0.58)' : 'rgba(255,255,255,0.13)';
      for (const c of cracks) {
        const m = c.pts.length;
        for (let j = 1; j < m; j++) {
          g.lineWidth = Math.max(0.35, c.w * (1 - (0.8 * (j - 1)) / Math.max(1, m - 1)) * (pass ? 0.7 : 1));
          g.beginPath();
          g.moveTo(c.pts[j - 1][0], c.pts[j - 1][1]);
          g.lineTo(c.pts[j][0], c.pts[j][1]);
          g.stroke();
        }
      }
      g.restore();
    }
    g.restore();
    g.restore();
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
  }

  /**
   * C183: fissure polylines for a boulder: about one main crack per stone hex, started at a hashed point of a hashed
   * hex and steered by value noise (so neighbouring cracks bend alike), 5–9 steps long, with a branch now and then.
   * Deterministic from the hexes. Each crack: { pts: [[x, y]…], w } (w = start width).
   */
  function boulderCracks(set) {
    const out = [];
    const hexes = set.hexes;
    if (!hexes.length) return out;
    const nC = Math.max(1, hexes.length);
    const seed0 = hexes[0];
    const walk = (x, y, ang, steps, seed, w) => {
      const pts = [[x, y]];
      let a = ang;
      let px = x;
      let py = y;
      for (let k = 0; k < steps; k++) {
        a += (noise2(px / 11, py / 11, 19 + (seed % 7)) - 0.5) * 0.95;
        const L = SIZE * (0.11 + 0.08 * hash01(seed * 5 + k, 83));
        px += Math.cos(a) * L;
        py += Math.sin(a) * L * 0.92;
        pts.push([px, py]);
      }
      return { pts, w };
    };
    for (let c = 0; c < nC; c++) {
      const r = (k) => hash01(seed0 * 131 + c * 17 + k, k * 13 + 7);
      const i0 = hexes[c % hexes.length];   // one per stone hex, so the fissures spread over the whole mass
      const [x, y] = hexToPixel(i0, SIZE);
      const sx = x + (r(2) - 0.5) * SIZE * 0.8;
      const sy = y + (r(3) - 0.5) * SIZE * 0.7;
      const main = walk(sx, sy, r(4) * Math.PI * 2, 5 + Math.floor(r(5) * 5), seed0 + c * 3, 1.6 + 1.1 * r(6));
      out.push(main);
      if (r(7) < 0.55 && main.pts.length > 3) {
        const at = 1 + Math.floor(r(8) * (main.pts.length - 2));
        const [bx, by] = main.pts[at];
        const [px, py] = main.pts[at - 1];
        const dir = Math.atan2(by - py, bx - px) + (r(9) < 0.5 ? -1 : 1) * (0.6 + 0.5 * r(10));
        out.push(walk(bx, by, dir, 2 + Math.floor(r(11) * 3), seed0 + c * 3 + 1, main.w * 0.6));
      }
    }
    return out;
  }

  /**
   * C111 linked terrain: the hexes of one terrain id in [0, n) with, per hex, its same-id neighbours in DIRS order
   * (-1 where the neighbour differs), so adjacent hexes draw as one body.
   * @returns {{ hexes: number[], nb: Map<number, number[]> }}
   */
  function linkSet(ter, n, id) {
    const hexes = [];
    const nb = new Map();
    for (let i = 0; i < n; i++) if (terrainId(ter[i]) === id) hexes.push(i);
    const isIn = new Set(hexes);
    for (const i of hexes) {
      const [q, r] = hexQR(i);
      const row = [];
      for (let k = 0; k < 6; k++) {
        const h = hexIndex(q + DIRS[k][0], r + DIRS[k][1]);
        row.push(h >= 0 && isIn.has(h) ? h : -1);
      }
      nb.set(i, row);
    }
    return { hexes, nb };
  }

  /** A closed polygon (flat x,y list) added with positive (canvas-clockwise) winding, matching arc()/ellipse(). */
  function polyOn(g, pts) {
    let a = 0;
    const m = pts.length;
    for (let j = 0; j < m; j += 2) {
      const k = (j + 2) % m;
      a += pts[j] * pts[k + 1] - pts[k] * pts[j + 1];
    }
    const at = (j) => (a < 0 ? m - 2 - j : j);
    g.moveTo(pts[at(0)], pts[at(0) + 1]);
    for (let j = 2; j < m; j += 2) g.lineTo(pts[at(j)], pts[at(j) + 1]);
    g.closePath();
  }

  /**
   * Pool outline (one path, uniform winding, so a single fill is the union): a rounded blob per hex, a band to each
   * linked neighbour and the triangle between three mutually linked hexes. `k` scales the shape, `pad` grows it.
   */
  function poolPath(g, set, k, pad) {
    g.beginPath();
    for (const i of set.hexes) {
      const [x, y] = hexToPixel(i, SIZE);
      const row = set.nb.get(i);
      const lone = row.every((h) => h < 0);
      const rx = SIZE * (lone ? 0.8 : 0.84 + 0.1 * hash01(i, 41)) * k + pad;
      const ry = SIZE * (lone ? 0.6 : 0.74 + 0.08 * hash01(i, 43)) * k + pad;
      const rot = hash01(i * 13 + 2, 17);
      g.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
      g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
      for (let d = 0; d < 6; d++) {
        const h = row[d];
        if (h < i) continue;
        const [hx, hy] = hexToPixel(h, SIZE);
        const len = Math.hypot(hx - x, hy - y) || 1;
        const w = SIZE * (0.6 + 0.12 * hash01(i * 97 + h, 7)) * k + pad;
        const vx = (-(hy - y) / len) * w;
        const vy = ((hx - x) / len) * w;
        polyOn(g, [x + vx, y + vy, hx + vx, hy + vy, hx - vx, hy - vy, x - vx, y - vy]);
        const h2 = row[(d + 1) % 6];
        if (k >= 1 && h2 > i) {
          const [x2, y2] = hexToPixel(h2, SIZE);
          polyOn(g, [x, y, hx, hy, x2, y2]);
        }
      }
    }
  }

  /** Midpoints (and edge angles) between linked hexes, each pair once. */
  function linkMids(set) {
    const out = [];
    for (const i of set.hexes) {
      const [x, y] = hexToPixel(i, SIZE);
      for (const h of set.nb.get(i)) {
        if (h < i) continue;
        const [hx, hy] = hexToPixel(h, SIZE);
        out.push({ x: (x + hx) / 2, y: (y + hy) / 2, ang: Math.atan2(hy - y, hx - x), seed: i * 97 + h });
      }
    }
    return out;
  }

  /** C111: puddles — one pool over the union of linked puddle hexes, shore only on its outer edge, even ripples. */
  function paintPools(g, season, set, under) {
    if (!set.hexes.length) return;
    // C135: the pool, its shore and ripples stay inside the puddle hexes, so the fog and the map-edge void cover an
    // unrevealed or out-of-map puddle exactly like any other terrain (the blobs and the shore pad used to spill out)
    g.save();
    clipToHexes(g, set.hexes);
    paintPoolsIn(g, season, set, under);
    g.restore();
  }

  function paintPoolsIn(g, season, set, under) {
    const [base] = terrainColor(season, 'puddle');
    const groundOf = (i) => terrainColor(season, under.get(i) || 'grass')[0];
    const ground = groundOf(set.hexes[0]);
    const mids = linkMids(set);
    const stations = set.hexes.map((i) => {
      const [x, y] = hexToPixel(i, SIZE);
      return { x, y, seed: i };
    }).concat(mids);
    if (season === 'summer') {
      // dried bed: cracked mud over the same outline
      g.fillStyle = rgba(mix(base, ground, 0.25), 0.92);
      poolPath(g, set, 1, 0);
      g.fill();
      g.save();
      poolPath(g, set, 1, -1);
      g.clip();
      g.strokeStyle = 'rgba(70,55,35,0.5)';
      g.lineWidth = 1;
      g.beginPath();
      for (const st of stations) {
        const r = (k) => hash01(st.seed * 13 + k, k * 7 + 3);
        for (let k = 0; k < 4; k++) {
          g.moveTo(st.x + (r(k) - 0.5) * SIZE, st.y + (r(k + 5) - 0.5) * SIZE * 0.8);
          g.lineTo(st.x + (r(k + 9) - 0.5) * SIZE, st.y + (r(k + 13) - 0.5) * SIZE * 0.8);
        }
      }
      g.stroke();
      g.restore();
      return;
    }
    const winter = season === 'winter';
    const water = winter ? '#cfe2ef' : mix(base, '#2d5f86', 0.25);
    // shore: the union grown a little, only visible beyond the water's outer edge
    g.fillStyle = winter ? mix(ground, '#ffffff', 0.45) : mix(ground, '#3a2c1c', 0.45);
    poolPath(g, set, 1, SIZE * 0.1);
    g.fill();
    g.fillStyle = water;
    poolPath(g, set, 1, 0);
    g.fill();
    // deeper middle, merged along the links too
    g.fillStyle = winter ? mix(water, '#9fc2da', 0.45) : shade(water, -0.12);
    poolPath(g, set, 0.55, 0);
    g.fill();
    // ripples / ice streaks: one direction across the whole pool, clipped to the water
    g.save();
    poolPath(g, set, 1, -SIZE * 0.06);
    g.clip();
    g.strokeStyle = winter ? 'rgba(255,255,255,0.75)' : 'rgba(220,240,255,0.6)';
    g.lineWidth = 1.2;
    g.beginPath();
    for (const st of stations) {
      const r = (k) => hash01(st.seed * 31 + k, k * 5 + 9);
      for (let k = 0; k < 2; k++) {
        const px = st.x + (r(k) - 0.5) * SIZE * 0.9;
        const py = st.y + (r(k + 3) - 0.5) * SIZE * 0.7;
        if (winter) {
          g.moveTo(px - SIZE * 0.22, py + SIZE * 0.12);
          g.lineTo(px + SIZE * 0.22, py - SIZE * 0.12);
        } else {
          const rx = SIZE * (0.2 + 0.12 * r(k + 6));
          g.moveTo(px + rx * Math.cos(Math.PI * 1.15 - 0.25), py + rx * 0.35 * Math.sin(Math.PI * 1.15 - 0.25));
          g.ellipse(px, py, rx, rx * 0.35, -0.25, Math.PI * 1.15, Math.PI * 1.85);
        }
      }
    }
    g.stroke();
    g.restore();
  }

  /**
   * C111: garden paths — continuous strips through the linked path hexes, rounded ends. C183: the strip runs through
   * the midpoints of the links and bends at each hex centre on a quadratic curve (tangent along the link at every
   * midpoint), so turns and zig-zags read as smooth curves instead of polygon steps; junctions join every pair of links.
   */
  function pathMid(i, h) {
    const [x, y] = hexToPixel(i, SIZE);
    const [hx, hy] = hexToPixel(h, SIZE);
    return [(x + hx) / 2, (y + hy) / 2];
  }

  function paintPaths(g, season, set) {
    if (!set.hexes.length) return;
    const [base, detail] = terrainColor(season, 'garden_path');
    const strip = (width, color) => {
      g.strokeStyle = color;
      g.fillStyle = color;
      g.lineWidth = width;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      for (const i of set.hexes) {
        const [x, y] = hexToPixel(i, SIZE);
        const links = set.nb.get(i).filter((h) => h >= 0);
        if (links.length === 1) {
          const [mx, my] = pathMid(i, links[0]);
          g.moveTo(x, y);
          g.lineTo(mx, my);
          continue;
        }
        for (let a = 0; a < links.length; a++) {
          for (let b = a + 1; b < links.length; b++) {
            const [ax, ay] = pathMid(i, links[a]);
            const [bx, by] = pathMid(i, links[b]);
            g.moveTo(ax, ay);
            g.quadraticCurveTo(x, y, bx, by);
          }
        }
      }
      g.stroke();
      // lone hexes and strip ends as discs (a zero-length segment's cap is not drawn everywhere)
      g.beginPath();
      for (const i of set.hexes) {
        const links = set.nb.get(i).filter((h) => h >= 0).length;
        if (links > 1) continue;
        const [x, y] = hexToPixel(i, SIZE);
        g.moveTo(x + width / 2, y);
        g.arc(x, y, width / 2, 0, Math.PI * 2);
      }
      g.fill();
    };
    strip(SIZE * 1.26, shade(base, -0.32));
    strip(SIZE * 1.12, mix(base, shade(base, -0.25), 0.55));
    // gravel speckle
    const stations = set.hexes.map((i) => {
      const [x, y] = hexToPixel(i, SIZE);
      const links = set.nb.get(i).filter((h) => h >= 0);
      let ang = 0;
      if (links.length === 2) {
        // C183: on a bend, the stones sit on the curve's apex and follow its direction there
        const [ax, ay] = pathMid(i, links[0]);
        const [bx, by] = pathMid(i, links[1]);
        return { x: 0.25 * ax + 0.5 * x + 0.25 * bx, y: 0.25 * ay + 0.5 * y + 0.25 * by, ang: Math.atan2(by - ay, bx - ax), seed: i };
      }
      if (links.length) {
        const [hx, hy] = hexToPixel(links[0], SIZE);
        ang = Math.atan2(hy - y, hx - x);
      }
      return { x, y, ang, seed: i };
    }).concat(linkMids(set));
    g.fillStyle = rgba(shade(base, -0.4), 0.55);
    for (const st of stations) {
      for (let k = 0; k < 5; k++) {
        const a = hash01(st.seed * 7 + k, 51) * Math.PI * 2;
        const d = hash01(st.seed * 7 + k, 53) * SIZE * 0.45;
        g.fillRect(st.x + Math.cos(a) * d, st.y + Math.sin(a) * d, 1, 1);
      }
    }
    // flagstones: two abreast at every hex centre and link midpoint, laid along the strip
    for (const st of stations) {
      const r = (k) => hash01(st.seed * 13 + k, k * 7 + 3);
      const ux = Math.cos(st.ang);
      const uy = Math.sin(st.ang);
      for (let k = 0; k < 2; k++) {
        const side = (k ? 1 : -1) * SIZE * (0.22 + 0.04 * r(k + 20));
        const along = (r(k) - 0.5) * SIZE * 0.25;
        const sx = st.x - uy * side + ux * along;
        const sy = st.y + ux * side + uy * along;
        const rot = st.ang + (r(k + 3) - 0.5) * 0.6;
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.beginPath();
        g.ellipse(sx + 0.8, sy + 1.2, SIZE * 0.24, SIZE * 0.18, rot, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = mix(detail, base, 0.15 + 0.4 * r(k + 9));
        g.beginPath();
        g.ellipse(sx, sy, SIZE * 0.24, SIZE * 0.18, rot, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
  }

  function paintTerrainDetail(g, id, season, i, x, y) {
    const [base, detail] = terrainColor(season, id);
    const r = (k) => hash01(i * 13 + k, k * 7 + 3);
    g.lineCap = 'round';
    switch (id) {
      case 'grass': {
        g.strokeStyle = rgba(shade(detail, 0.08), 0.75);
        g.lineWidth = 1.1;
        g.beginPath();
        for (let k = 0; k < 9; k++) {
          const bx = x + (r(k) - 0.5) * SIZE * 1.4;
          const by = y + (r(k + 20) - 0.5) * SIZE * 1.2;
          g.moveTo(bx, by);
          g.lineTo(bx + (r(k + 40) - 0.5) * 3, by - 3 - r(k + 60) * 4);
        }
        g.stroke();
        g.strokeStyle = rgba(shade(base, -0.18), 0.6);
        g.beginPath();
        for (let k = 0; k < 5; k++) {
          const bx = x + (r(k + 80) - 0.5) * SIZE * 1.4;
          const by = y + (r(k + 90) - 0.5) * SIZE * 1.2;
          g.moveTo(bx, by);
          g.lineTo(bx + (r(k + 70) - 0.5) * 3, by - 2 - r(k + 50) * 3);
        }
        g.stroke();
        if (season === 'spring' && r(99) > 0.7) {
          g.fillStyle = r(98) > 0.5 ? '#fff6d0' : '#ffd84a';
          g.beginPath();
          g.arc(x + (r(97) - 0.5) * SIZE, y + (r(96) - 0.5) * SIZE, 1.4, 0, Math.PI * 2);
          g.fill();
        }
        if (season === 'winter') {
          g.fillStyle = 'rgba(255,255,255,0.55)';
          for (let k = 0; k < 4; k++) g.fillRect(x + (r(k + 120) - 0.5) * SIZE * 1.3, y + (r(k + 130) - 0.5) * SIZE * 1.2, 1.5, 1.5);
        }
        break;
      }
      case 'sand': {
        g.fillStyle = rgba(shade(base, -0.15), 0.6);
        for (let k = 0; k < 10; k++) g.fillRect(x + (r(k) - 0.5) * SIZE * 1.4, y + (r(k + 20) - 0.5) * SIZE * 1.2, 1, 1);
        g.strokeStyle = rgba(shade(detail, 0.1), 0.5);
        g.lineWidth = 1;
        g.beginPath();
        for (let k = 0; k < 2; k++) {
          const yy = y + (k - 0.5) * SIZE * 0.5;
          g.moveTo(x - SIZE * 0.6, yy);
          g.quadraticCurveTo(x, yy - 3, x + SIZE * 0.6, yy);
        }
        g.stroke();
        break;
      }
      case 'leaf_litter': {
        const cols = season === 'winter' ? ['#8c7d68', '#a69780'] : season === 'autumn' ? ['#c9783a', '#a9502a', '#d8a23a'] : ['#8a7238', '#6e5a2c', '#a0823e'];
        for (let k = 0; k < 6; k++) {
          g.save();
          g.translate(x + (r(k) - 0.5) * SIZE * 1.3, y + (r(k + 10) - 0.5) * SIZE * 1.1);
          g.rotate(r(k + 30) * 6.28);
          g.fillStyle = cols[k % cols.length];
          g.beginPath();
          g.ellipse(0, 0, 4.5, 2.2, 0, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = 'rgba(60,40,20,0.4)';
          g.lineWidth = 0.6;
          g.beginPath();
          g.moveTo(-4, 0);
          g.lineTo(4, 0);
          g.stroke();
          g.restore();
        }
        break;
      }
      case 'tree_root': {
        g.strokeStyle = shade(detail, -0.2);
        g.lineWidth = 4;
        g.beginPath();
        const a = r(1) * 6.28;
        g.moveTo(x - Math.cos(a) * SIZE, y - Math.sin(a) * SIZE);
        g.quadraticCurveTo(x + (r(2) - 0.5) * 10, y + (r(3) - 0.5) * 10, x + Math.cos(a) * SIZE, y + Math.sin(a) * SIZE);
        g.stroke();
        g.strokeStyle = rgba(shade(detail, 0.15), 0.6);
        g.lineWidth = 1;
        g.stroke();
        break;
      }
      case 'stone': {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath();
        g.ellipse(x + 2, y + 4, SIZE * 0.62, SIZE * 0.42, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = base;
        g.beginPath();
        const pts = 7;
        for (let k = 0; k < pts; k++) {
          const ang = (k / pts) * 6.28;
          const rr = SIZE * (0.55 + 0.15 * r(k));
          const px = x + Math.cos(ang) * rr;
          const py = y + Math.sin(ang) * rr * 0.8;
          if (k === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.22)';
        g.beginPath();
        g.ellipse(x - SIZE * 0.15, y - SIZE * 0.18, SIZE * 0.25, SIZE * 0.14, -0.4, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(50,50,55,0.4)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x - SIZE * 0.2, y + SIZE * 0.05);
        g.lineTo(x + SIZE * 0.1, y + SIZE * 0.15);
        g.stroke();
        break;
      }
      case 'log': {
        g.save();
        g.translate(x, y);
        g.rotate(r(3) * Math.PI);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(-SIZE * 0.85, -SIZE * 0.2, SIZE * 1.7, SIZE * 0.55);
        g.fillStyle = base;
        g.fillRect(-SIZE * 0.85, -SIZE * 0.3, SIZE * 1.7, SIZE * 0.55);
        g.strokeStyle = shade(base, -0.3);
        g.lineWidth = 1;
        g.beginPath();
        for (let k = 0; k < 4; k++) {
          g.moveTo(-SIZE * 0.8, -SIZE * 0.2 + k * SIZE * 0.12);
          g.lineTo(SIZE * 0.8, -SIZE * 0.2 + k * SIZE * 0.12);
        }
        g.stroke();
        g.fillStyle = detail;
        g.beginPath();
        g.ellipse(SIZE * 0.85, -SIZE * 0.025, SIZE * 0.12, SIZE * 0.27, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
        break;
      }
      default:
        break;
    }
  }

  function syncLand(s, d, T) {
    const surf = s.run.surface;
    const R = radiusOf(s);
    let revCount = 0;
    const rev = surf.revealed || [];
    for (let i = 0; i < rev.length; i++) revCount += rev[i] ? 1 : 0;
    let ownedSum = 0;
    let rivalSum = 0;
    const n = countInRadius(R);
    for (let i = 0; i < n; i++) {
      ownedSum += T.owned[i] * (i + 1);
      rivalSum += T.rival[i] * (i + 3);
    }
    let sightSum = 0;
    for (const rv of s.run.rivals.list || []) if (rv && rivalVisible(s, rv)) sightSum += rv.uid * 7 + 1;
    const key = `${surf.rev}|${R}|${revCount}|${ownedSum}|${rivalSum}|${sightSum}|${hiRes ? 'hi' : 'lo'}`;
    if (key === landCache.key && landCache.canvas) return;
    landCache.key = key;
    const gm = cacheGeom(R, hiRes);
    if (!landCache.canvas || landCache.R !== R || landCache.scale !== gm.scale) {
      const off = createOffscreen(gm.W * gm.scale, gm.H * gm.scale);
      landCache.canvas = off.canvas;
      landCache.ctx = off.ctx;
    }
    landCache.scale = gm.scale;
    landCache.R = R;
    landCache.ox = gm.wx;
    landCache.oy = gm.wy;
    const g = landCache.ctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, gm.W * gm.scale, gm.H * gm.scale);
    g.setTransform(gm.scale, 0, 0, gm.scale, gm.wx * gm.scale, gm.wy * gm.scale);
    const rivals = new Map();
    for (const rv of s.run.rivals.list || []) if (rv) rivals.set(rv.uid, rv);
    // owned tint (permanent land: auto, claimed, conquered)
    const perm = (h) => T.owned[h] !== 0 && T.owned[h] !== OWN_TRAIL;
    g.fillStyle = rgba(SURFACE.player, 0.14);
    g.beginPath();
    for (let i = 0; i < n; i++) {
      if (!perm(i)) continue;
      const [x, y] = hexToPixel(i, SIZE);
      hexPathOn(g, x, y, SIZE * 1.01);
    }
    g.fill();
    // C162: hexes held only by a trail (Trunk Trails; lost with the trail): a lighter tint with a fine diagonal hatch
    const held = [];
    for (let i = 0; i < n; i++) if (T.owned[i] === OWN_TRAIL) held.push(i);
    if (held.length) {
      g.fillStyle = rgba(SURFACE.trailHeld, 0.1);
      g.beginPath();
      for (const i of held) {
        const [x, y] = hexToPixel(i, SIZE);
        hexPathOn(g, x, y, SIZE * 1.01);
      }
      g.fill();
      const pat = hatchPattern(g, 'diag', SURFACE.trailHeld, 0.42, 7);
      if (pat) {
        g.fillStyle = pat;
        g.fill();
      }
    }
    // rival land: tint + hatch, per rival
    const byRival = new Map();
    // C124: a rival's land shows only where it can be known — on revealed hexes, or everywhere once its nest is sighted
    // (the fog is not fully opaque, so unsighted hatching used to show faintly through it on a fresh map)
    const seen = new Set();
    for (const rv of s.run.rivals.list || []) if (rv && rivalVisible(s, rv)) seen.add(rv.uid);
    for (let i = 0; i < n; i++) {
      const u = T.rival[i];
      if (!u) continue;
      if (!rev[i] && !seen.has(u)) continue;
      if (!byRival.has(u)) byRival.set(u, []);
      byRival.get(u).push(i);
    }
    for (const [u, hexes] of byRival) {
      const rv = rivals.get(u);
      const col = rivalColor(rv ? rv.type : '', rv ? rv.tier : 1);
      g.fillStyle = rgba(col, 0.16);
      g.beginPath();
      for (const i of hexes) {
        const [x, y] = hexToPixel(i, SIZE);
        hexPathOn(g, x, y, SIZE * 1.01);
      }
      g.fill();
      const pat = hatchPattern(g, rivalPatternKind(rv ? rv.type : '', rv ? rv.tier : 1), col, 0.5, 10);
      if (pat) {
        g.fillStyle = pat;
        g.fill();
      }
      // border edges of this rival's land
      g.strokeStyle = rgba(col, 0.9);
      g.lineWidth = 1.6;
      g.setLineDash([4, 3]);
      g.beginPath();
      for (const i of hexes) edgesOf(g, i, (h) => T.rival[h] !== u);
      g.stroke();
      g.setLineDash([]);
    }
    // owned outline: a dark under-stroke so the amber border reads on gold summer grass and orange leaf litter alike.
    // C162: solid round permanent land (also where it meets trail-held hexes), dashed and paler round trail-held land
    g.beginPath();
    for (let i = 0; i < n; i++) if (perm(i)) edgesOf(g, i, (h) => !perm(h));
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(40,24,6,0.45)';
    g.lineWidth = 4.2;
    g.stroke();
    g.strokeStyle = rgba(SURFACE.player, 0.95);
    g.lineWidth = 2.2;
    g.stroke();
    if (held.length) {
      g.beginPath();
      for (const i of held) edgesOf(g, i, (h) => !T.owned[h]);
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(40,24,6,0.4)';
      g.lineWidth = 3.4;
      g.stroke();
      g.strokeStyle = rgba(SURFACE.trailHeld, 0.95);
      g.lineWidth = 1.6;
      g.stroke();
      g.setLineDash([]);
    }
    g.lineJoin = 'miter';
    // faint grid on revealed hexes
    g.strokeStyle = 'rgba(20,30,10,0.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      if (!rev[i]) continue;
      const [x, y] = hexToPixel(i, SIZE);
      hexPathOn(g, x, y, SIZE);
    }
    g.stroke();
    // fog: unrevealed hexes (clouded), then outside the radius (map edge)
    const nAll = countInRadius(Math.min(HEX.maxRadius, R + 1));
    for (let i = 0; i < nAll; i++) {
      const inside = i < n;
      if (inside && rev[i]) continue;
      const [x, y] = hexToPixel(i, SIZE);
      const nz = noise2(x / 45, y / 45, 11);
      g.fillStyle = inside ? rgba(mix(SURFACE.fog, SURFACE.fogEdge, nz), 0.86) : rgba(SURFACE.void, 0.94);
      g.beginPath();
      hexPathOn(g, x, y, SIZE * 1.04);
      g.fill();
    }
  }

  function edgesOf(g, i, isOther) {
    const [q, r] = hexQR(i);
    const [x, y] = hexToPixel(i, SIZE);
    const c = hexCorners(x, y, SIZE);
    for (let k = 0; k < 6; k++) {
      const h = hexIndex(q + DIRS[k][0], r + DIRS[k][1]);
      if (h >= 0 && !isOther(h)) continue;
      const [a, b] = EDGE[k];
      g.moveTo(c[2 * a], c[2 * a + 1]);
      g.lineTo(c[2 * b], c[2 * b + 1]);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // satellite placement (tool 'placeSatellite', F15): which hexes can take a satellite, and why not
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Hex-level rules of prestige placeSatellite (ARCHITECTURE §8.6 / §9; DESIGN §15): a free Satellite Nest level, an
   * owned and passable hex, at least fx.minDist hexes from every entrance; and somewhere in the nest a column at least
   * fx.colGap from every shaft and entrance column whose shaft keeps the Royal Chamber's room (C66,
   * nest.shaftBoxesRoyal). Mirrors the validator's per-hex checks (the column itself is picked in the chooser).
   * Rebuilds satCache.reasons (reason code or null per hex in radius), .global (a reason for every hex, or null) and
   * the tint cache when anything they read changed.
   */
  function syncSatellite(s, d) {
    const surf = s.run.surface;
    const R = radiusOf(s);
    const n = countInRadius(R);
    const ents = surf.entrances || [];
    const shafts = (s.run.nest && s.run.nest.shafts) || [];
    const owned = d && d.surface && d.surface.owned && d.surface.owned.length >= n ? d.surface.owned : null;
    const passable = d && d.surface && d.surface.passable && d.surface.passable.length >= n ? d.surface.passable : null;
    const fed = (s.era && s.era.federation) || {};
    const level = Number.isFinite(fed.satellite_nest) && fed.satellite_nest > 0 ? fed.satellite_nest : 0;
    let sats = 0;
    for (const e of ents) if (e && e.kind === 'satellite') sats++;
    let ownedSum = 0;
    let passSum = 0;
    for (let i = 0; i < n; i++) {
      if (owned && owned[i] > 0) ownedSum += i + 1;
      if (passable && passable[i] === 0) passSum += i + 3;
    }
    const entSig = ents.map((e) => (e ? `${e.kind}:${e.hex}:${e.col}` : '-')).join(',');
    const shaftSig = shafts.map((sh) => (sh ? sh.col : '-')).join(',');
    const key = `${surf.rev}|${R}|${level}|${sats}|${ownedSum}|${passSum}|${entSig}|${shaftSig}|${s.run.nest ? s.run.nest.rev : 0}`;
    if (key === satCache.key) return;
    satCache.key = key;

    const fx = (FEDERATION.satellite_nest && FEDERATION.satellite_nest.fx) || {};
    const minDist = Number.isFinite(fx.minDist) ? fx.minDist : 3;
    const colGap = Number.isFinite(fx.colGap) ? fx.colGap : 4;
    let global = null;
    if (level <= sats) global = level > 0 ? 'max' : 'locked';
    if (!global) {
      // a shaft column for it: clear of every other shaft / entrance column, and not walling in the Royal Chamber
      const taken = [];
      for (const e of ents) if (e && Number.isInteger(e.col) && e.col >= 0) taken.push(e.col);
      for (const sh of shafts) if (sh && Number.isInteger(sh.col)) taken.push(sh.col);
      let gapFree = false;
      let anyCol = false;
      for (let c = 0; c < GRID.cols && !anyCol; c++) {
        if (taken.some((t) => Math.abs(t - c) < colGap)) continue;
        gapFree = true;
        anyCol = !safe(() => nestSys.shaftBoxesRoyal(s, d, c), false);
      }
      if (!anyCol) global = gapFree ? 'blocked:royalRoom' : 'blocked:shaft';
    }
    const reasons = new Array(n);
    let valid = 0;
    for (let i = 0; i < n; i++) {
      let why = global;
      if (!why && !(owned && owned[i] > 0)) why = 'blocked:unowned';
      if (!why && passable && passable[i] === 0) why = 'blocked:terrain';
      if (!why) {
        for (const e of ents) {
          if (e && Number.isInteger(e.hex) && e.hex >= 0 && hexDist(e.hex, i) < minDist) {
            why = 'blocked:entrance';
            break;
          }
        }
      }
      reasons[i] = why;
      if (!why) valid++;
    }
    satCache.reasons = reasons;
    satCache.valid = valid;
    satCache.global = global;

    // tint cache (world space, like the land cache): valid hexes green with a bright rim, the rest greyed out
    const gm = cacheGeom(R);
    if (!satCache.canvas || satCache.R !== R || satCache.scale !== gm.scale) {
      const off = createOffscreen(gm.W * gm.scale, gm.H * gm.scale);
      satCache.canvas = off.canvas;
      satCache.ctx = off.ctx;
    }
    satCache.scale = gm.scale;
    satCache.R = R;
    satCache.ox = gm.wx;
    satCache.oy = gm.wy;
    const g = satCache.ctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, gm.W * gm.scale, gm.H * gm.scale);
    g.setTransform(gm.scale, 0, 0, gm.scale, gm.wx * gm.scale, gm.wy * gm.scale);
    g.fillStyle = 'rgba(16,16,18,0.46)';
    g.beginPath();
    for (let i = 0; i < n; i++) {
      if (!reasons[i]) continue;
      const [x, y] = hexToPixel(i, SIZE);
      hexPathOn(g, x, y, SIZE * 1.01);
    }
    g.fill();
    if (valid > 0) {
      g.fillStyle = rgba(SAT_OK, 0.3);
      g.beginPath();
      for (let i = 0; i < n; i++) {
        if (reasons[i]) continue;
        const [x, y] = hexToPixel(i, SIZE);
        hexPathOn(g, x, y, SIZE * 1.01);
      }
      g.fill();
      g.beginPath();
      for (let i = 0; i < n; i++) if (!reasons[i]) edgesOf(g, i, (h) => h >= n || !!reasons[h]);
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(10,30,12,0.55)';
      g.lineWidth = 4.4;
      g.stroke();
      g.strokeStyle = rgba(SAT_OK, 0.95);
      g.lineWidth = 2.2;
      g.stroke();
      g.lineJoin = 'miter';
    }
  }

  /** Short hover text for a satellite reason (render-local; the full copy is ui/text.js REASON_DETAILS). */
  function satelliteLabel(why) {
    if (!why) return 'Place the satellite here';
    const fx = (FEDERATION.satellite_nest && FEDERATION.satellite_nest.fx) || {};
    const minDist = Number.isFinite(fx.minDist) ? fx.minDist : 3;
    return {
      'blocked:unowned': 'Not your territory',
      'blocked:terrain': 'Impassable ground',
      'blocked:entrance': `Too close: ${minDist}+ hexes from every entrance`,
      'blocked:shaft': 'No free shaft column in the nest',
      'blocked:royalRoom': 'A shaft here would wall in the queen',
      max: 'Every satellite is placed',
      locked: 'Needs Satellite Nest',
    }[why] || String(why);
  }

  /** The satellite tool (the tint is blitted under the icons): outline and label the hovered hex, say what it needs. */
  function drawSatelliteTool(ctx, s, d, hh) {
    syncSatellite(s, d);
    const W = layer.cssW;
    const fx = (FEDERATION.satellite_nest && FEDERATION.satellite_nest.fx) || {};
    const minDist = Number.isFinite(fx.minDist) ? fx.minDist : 3;
    let hint;
    if (satCache.valid > 0) hint = `Satellite: pick a green hex (your land, ${minDist}+ hexes from every entrance)`;
    else if (satCache.global) hint = `No satellite site: ${satelliteLabel(satCache.global).toLowerCase()}`;
    else hint = `No site yet: expand your territory to ${minDist}+ hexes from every entrance`;
    labelBox(ctx, W / 2, 14, hint, satCache.valid > 0 ? '#e8ffd0' : '#ffd8b0', 'center', Math.max(120, W - 16));
    if (!(hh >= 0)) return;
    const why = hh < satCache.reasons.length ? satCache.reasons[hh] : satCache.global || 'blocked:unowned';
    const p = hexToScreen(hh);
    const r = SIZE * curView.zoom;
    if (!why) {
      ctx.fillStyle = rgba(SAT_OK, 0.35);
      ctx.beginPath();
      hexPathOn(ctx, p.x, p.y, r * 0.95);
      ctx.fill();
    }
    hexOutline(ctx, hh, why ? SURFACE.claimBad : '#f4fff0', 3);
    labelBox(ctx, p.x, p.y - r - 12, satelliteLabel(why), why ? '#ffd0cc' : '#e8ffd0', 'center', Math.max(120, W - 16));
  }

  /** A small dark label box with text (screen space), kept inside the canvas. */
  function labelBox(ctx, x, y, text, color, align = 'center', maxW = 400) {
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const fits = (str) => ctx.measureText(str).width + 10 <= maxW;
    let t = String(text);
    if (!fits(t)) {
      while (t.length > 4 && !fits(t + '…')) t = t.slice(0, -1);
      t += '…';
    }
    const w = ctx.measureText(t).width + 10;
    let x0 = align === 'center' ? x - w / 2 : x;
    x0 = clamp(x0, 4, Math.max(4, layer.cssW - w - 4));
    const y0 = clamp(y - 9, 4, Math.max(4, layer.cssH - 22));
    ctx.fillStyle = 'rgba(15,20,10,0.86)';
    ctx.fillRect(x0, y0, w, 18);
    ctx.fillStyle = color;
    ctx.fillText(t, x0 + 5, y0 + 9);
  }

  function blit(ctx, cacheObj) {
    if (!cacheObj.canvas) return;
    const v = curView;
    const p = w2s(-cacheObj.ox, -cacheObj.oy);
    const w = cacheObj.ox * 2 * v.zoom;
    const h = cacheObj.oy * 2 * v.zoom;
    ctx.drawImage(cacheObj.canvas, 0, 0, cacheObj.ox * 2 * cacheObj.scale, cacheObj.oy * 2 * cacheObj.scale, p.x, p.y, w, h);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // trails
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * C128: true for a hex the trail curve must stay out of: impassable now (d.surface.passable) because of its terrain
   * (TERRAIN move null, or a puddle while puddles block in spring). Molehills etc. are drawn as objects, not as full
   * hexes, and are not obstacles for the curve.
   */
  function isBlockedHex(hex) {
    return blockedIn(S(), D(), hex, -1);
  }

  /** isBlockedHex with an optional precomputed map hex count n (−1 = compute). */
  function blockedIn(s, d, hex, n) {
    const pass = d && d.surface && d.surface.passable;
    const terrain = s && s.run && s.run.surface && s.run.surface.terrain;
    if (!pass || !terrain || !(hex >= 0) || pass[hex] !== 0) return false;
    if (hex >= (n >= 0 ? n : countInRadius(radiusOf(s)))) return false;
    const def = TERRAIN[TERRAIN_ORDER[terrain[hex]]];
    return !!def && (def.move === null || def.springMove === null);
  }

  /** C128: blockKey from the current impassable terrain (cheap: one pass over the map's hexes). */
  function syncBlockKey(s, d) {
    const pass = d && d.surface && d.surface.passable;
    const n = countInRadius(radiusOf(s));
    let h1 = n;
    let h2 = 0;
    if (pass) {
      for (let i = 0; i < n; i++) {
        if (blockedIn(s, d, i, n)) {
          h1 = (Math.imul(h1, 31) + i) | 0;
          h2++;
        }
      }
    }
    blockKey = h1 + ':' + h2;
  }

  /** C128: the world-space curve for a hex path (trail, drag ghost, reroute ghost), clear of impassable hexes. */
  function pathCurve(path, perSeg) {
    return trailCurve(path, isBlockedHex, { size: SIZE, perSeg });
  }

  /**
   * C134: rebuild the lane layout when any trail path changed (a cheap per-frame hash of uids and paths); trail curves
   * are cached per path + blockKey + laneKey.
   */
  function syncLanes(trails) {
    let h = trails.length | 0;
    for (const tr of trails) {
      if (!tr) continue;
      h = (Math.imul(h, 31) + (tr.uid | 0)) | 0;
      const p = Array.isArray(tr.path) ? tr.path : [];
      for (let k = 0; k < p.length; k++) h = (Math.imul(h, 31) + (p[k] | 0) + 1) | 0;
    }
    const key = String(h);
    if (key === laneKey) return;
    const t0 = nowMs();
    laneKey = key;
    lanes = laneLayout(trails.filter(Boolean).map((tr) => ({ uid: tr.uid, path: Array.isArray(tr.path) ? tr.path : [] })), { size: SIZE });
    laneBuildMs = nowMs() - t0;
  }

  function trailWorld(tr) {
    const path = Array.isArray(tr.path) ? tr.path : [];
    const sig = path.join(',') + '|' + blockKey + '|' + laneKey;
    let g = trailGeo.get(tr.uid);
    if (g && g.sig === sig) return g;
    const centre = pathCurve(path, 6);
    const off = lanes.get(tr.uid);
    const world = off ? laneCurve(centre, path, off, { perSeg: 6, size: SIZE, obstacles: pathObstacles(path, isBlockedHex, SIZE) }) : centre;
    g = { sig, world, tab: arcTable(world) };
    trailGeo.set(tr.uid, g);
    return g;
  }

  function trailScreen(tr) {
    const g = trailWorld(tr);
    const out = new Array(g.world.length);
    for (let k = 0; k < g.world.length; k++) out[k] = w2s(g.world[k].x, g.world[k].y);
    return out;
  }

  function trailColor(job) {
    if (job === 'herder') return SURFACE.trailHerder;
    if (job === 'leafcutter') return SURFACE.trailLeaf;
    if (job === 'lycaenid') return SURFACE.trailLycaenid;
    return SURFACE.trail;
  }

  /**
   * C182: trails off their own route. A detour shows the trail's own (blocked) route as a faint dashed line and an
   * amber marker with a bend arrow on each blocked hex; a paused trail (no way round) gets a red marker with a pause
   * sign (its line is drawn dotted in drawTrails).
   */
  function drawDetours(ctx, trails, zoomK) {
    for (const tr of trails) {
      const det = tr && tr.detour;
      if (!det || !Array.isArray(det.home) || det.home.length < 2) continue;
      const paused = !!det.paused;
      if (!paused) {
        ctx.strokeStyle = 'rgba(255,236,190,0.42)';
        ctx.lineWidth = Math.max(1, 1.6 * zoomK);
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        det.home.forEach((h, j) => {
          const p = hexToScreen(h);
          if (j) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = 6.5 * zoomK;
      for (const h of Array.isArray(det.block) ? det.block : []) {
        const p = hexToScreen(h);
        if (!visiblePt(p, 20)) continue;
        ctx.fillStyle = paused ? 'rgba(170,40,30,0.92)' : 'rgba(205,140,30,0.92)';
        ctx.strokeStyle = 'rgba(20,14,8,0.75)';
        ctx.lineWidth = 1.2;
        const cy = p.y - SIZE * curView.zoom * 0.55;
        ctx.beginPath();
        ctx.arc(p.x, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#fff6e0';
        ctx.fillStyle = '#fff6e0';
        ctx.lineWidth = Math.max(1, r * 0.22);
        ctx.beginPath();
        if (paused) {
          ctx.fillRect(p.x - r * 0.42, cy - r * 0.45, r * 0.26, r * 0.9);
          ctx.fillRect(p.x + r * 0.16, cy - r * 0.45, r * 0.26, r * 0.9);
        } else {
          // a bend-around arrow
          ctx.arc(p.x, cy + r * 0.15, r * 0.48, Math.PI, Math.PI * 1.95);
          ctx.stroke();
          const ax = p.x + r * 0.48;
          const ay = cy + r * 0.05;
          ctx.beginPath();
          ctx.moveTo(ax - r * 0.3, ay - r * 0.12);
          ctx.lineTo(ax + r * 0.02, ay + r * 0.3);
          ctx.lineTo(ax + r * 0.3, ay - r * 0.16);
          ctx.stroke();
        }
      }
    }
  }

  function drawTrails(ctx, s, d, polys) {
    const trails = s.run.surface.trails || [];
    const dts = (d && d.surface && d.surface.trails) || [];
    const sMax = (TRAIL && TRAIL.sMax) || 100;
    const wMin = (TRAIL && TRAIL.widthMin) || 1;
    const wMax = (TRAIL && TRAIL.widthMax) || 6;
    const ui0 = uiOf(ui);
    const sel = ui0.selection && ui0.selection.view === 'surface' && ui0.selection.kind === 'trail' ? ui0.selection.id : -1;
    const hov = ui0.hover && ui0.hover.view === 'surface' && ui0.hover.kind === 'trail' ? ui0.hover.id : -1;
    const zoomK = Math.sqrt(curView.zoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < trails.length; i++) {
      const tr = trails[i];
      const poly = polys[i];
      if (!tr || !poly || poly.length < 2) continue;
      const dd = dts[i] && dts[i].uid === tr.uid ? dts[i] : null;
      const workers = dd ? dd.workers : tr.workers;
      // ARCH-R: width 1 + log10(workers) clamped 1–6 px and opacity S/S_max (§13.5) are kept, with two readability
      // tweaks: the width scales with √zoom, and the opacity never drops below 0.18 so a fresh trail stays visible.
      const width = clamp(1 + Math.log10(Math.max(1, workers || 0)), wMin, wMax) * zoomK;
      const alpha = clamp((tr.S || 0) / sMax, 0.18, 1);
      const col = tr.job && tr.job !== 'forager' ? trailColor(tr.job) : cosmetics.trailColour(s, i, trailColor(tr.job));   // C149 trail cosmetics
      const stroke = () => {
        ctx.beginPath();
        for (let k = 0; k < poly.length; k++) {
          if (k === 0) ctx.moveTo(poly[k].x, poly[k].y);
          else ctx.lineTo(poly[k].x, poly[k].y);
        }
        ctx.stroke();
      };
      if (tr.uid === sel || tr.uid === hov) {
        ctx.strokeStyle = tr.uid === sel ? 'rgba(255,255,255,0.75)' : 'rgba(255,243,196,0.5)';
        ctx.lineWidth = width + 5;
        stroke();
      }
      // worn earth under the pheromone line: the ants' highway stays visible between the walkers
      ctx.strokeStyle = `rgba(70,48,22,${0.16 + 0.14 * alpha})`;
      ctx.lineWidth = width + 6 * zoomK;
      stroke();
      ctx.strokeStyle = `rgba(30,22,10,${0.35 * alpha})`;
      ctx.lineWidth = width + 2;
      stroke();
      ctx.strokeStyle = rgba(col, alpha);
      ctx.lineWidth = width;
      const paused = !!(tr.detour && tr.detour.paused);   // C182: blocked with no way round
      if (tr.job === 'lycaenid') ctx.setLineDash([5, 5]);
      else if (paused) ctx.setLineDash([2, 6]);
      stroke();
      ctx.setLineDash([]);
      // rally: travelling dashes
      const rallied = (s.run.effects || []).some((e) => e && e.id === `rally:${tr.uid}`);
      if (rallied) {
        ctx.strokeStyle = 'rgba(255,240,170,0.9)';
        ctx.lineWidth = Math.max(1, width * 0.6);
        ctx.setLineDash([3, 9]);
        ctx.lineDashOffset = -time * 30;
        stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
    }
    drawDetours(ctx, trails, zoomK);
    // ability pulses
    for (let k = pulses.length - 1; k >= 0; k--) {
      const p = pulses[k];
      if (p.t > p.max) {
        pulses.splice(k, 1);
        continue;
      }
      const a = 1 - p.t / p.max;
      if (p.kind === 'frenzy') {
        for (const poly of polys) {
          if (!poly || poly.length < 2) continue;
          ctx.strokeStyle = `rgba(255,120,60,${0.6 * a})`;
          ctx.lineWidth = 6 * a + 2;
          ctx.beginPath();
          poly.forEach((pt, j) => (j ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
          ctx.stroke();
        }
      } else {
        const idx = trails.findIndex((t) => t && t.uid === p.uid);
        const poly = polys[idx];
        if (!poly || poly.length < 2) continue;
        ctx.strokeStyle = p.kind === 'mark' ? `rgba(255,236,160,${0.8 * a})` : `rgba(255,200,90,${0.8 * a})`;
        ctx.lineWidth = 8 * a + 2;
        ctx.beginPath();
        poly.forEach((pt, j) => (j ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sources, mound, rivals, parties, raids, objects
  // ---------------------------------------------------------------------------------------------------------------

  function sourceVisible(s, src) {
    if (!src || !(src.hex >= 0) || src.hex >= HEX_COUNT) return false;
    if (src.data && (src.data.dormant || src.data.unsized)) return !!(s.run.surface.revealed && s.run.surface.revealed[src.hex]) && !src.data.dormant;
    return !!(s.run.surface.revealed && s.run.surface.revealed[src.hex]);
  }

  function iconSize() {
    return SIZE * 1.25 * curView.zoom;
  }

  function drawSources(ctx, s, d) {
    const size = iconSize();
    const ui0 = uiOf(ui);
    const glow = ui0.glow;
    const sel = ui0.selection && ui0.selection.view === 'surface' && ui0.selection.kind === 'source' ? ui0.selection.id : -1;
    const hov = ui0.hover && ui0.hover.view === 'surface' && ui0.hover.kind === 'source' ? ui0.hover.id : -1;
    for (const src of s.run.surface.sources || []) {
      if (!sourceVisible(s, src)) continue;
      const p = hexToScreen(src.hex);
      if (!visiblePt(p)) continue;
      const glowing = sourceGlows(glow, src, d);
      if (glowing || src.uid === sel || src.uid === hov) {
        const a = glowing ? 0.35 + 0.3 * Math.sin(time * 4) : src.uid === sel ? 0.5 : 0.3;
        ctx.fillStyle = `rgba(255,240,180,${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.62, 0, Math.PI * 2);
        ctx.fill();
        if (glowing) {
          // expanding ring so the one intended action reads at a glance (DESIGN §25.6 "one glow at a time")
          const k = (time * 0.9) % 1;
          ctx.strokeStyle = `rgba(255,236,160,${0.8 * (1 - k)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, size * (0.6 + 0.5 * k), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      let alpha = 1;
      if (src.ttl > 0 && src.ttl < 20) alpha = 0.55 + 0.45 * Math.abs(Math.sin(time * 5));
      ctx.globalAlpha = alpha;
      if (src.type === 'rich_seed_patch') {
        // C188: a gold rim marks the scouts' rich find
        ctx.strokeStyle = `rgba(255,214,90,${0.55 + 0.25 * Math.sin(time * 2.2 + src.uid)})`;
        ctx.lineWidth = Math.max(1.5, size * 0.07);
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (src.type === 'beetle_carcass') {
        // C188: a beetle on its back (static), with the dead insect's fly
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI * 0.85);
        ctx.globalAlpha = alpha * 0.85;
        atlas.drawIcon(ctx, 'prey_beetle', 0, 0, size * 1.05);
        ctx.restore();
        ctx.globalAlpha = alpha;
        if (amb.on) drawAmbientExtras(ctx, 'dead_insect', p.x, p.y, size, { t: time, uid: src.uid, wind: amb.wind });
      } else if (amb.on) {
        // C161: idle life (sway / crawl / inch, then a fly, termites …), visual only, deterministic phase per uid
        const wp = hexWorldPt(src.hex);
        const ao = { t: time, uid: src.uid, wind: amb.wind, wx: wp.x, wy: wp.y };
        drawIconAmbient(ctx, atlas, ICON_ALIAS[src.type] || src.type, p.x, p.y, size, ao);
        drawAmbientExtras(ctx, ICON_ALIAS[src.type] || src.type, p.x, p.y, size, ao);
      } else {
        atlas.drawIcon(ctx, ICON_ALIAS[src.type] || src.type, p.x, p.y, size);
      }
      ctx.globalAlpha = 1;
      if (src.max > 0 && src.stock >= 0) {
        const f = clamp(src.stock / src.max, 0, 1);
        ctx.strokeStyle = 'rgba(20,14,8,0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.52, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = f > 0.25 ? '#f6e3a8' : '#ff8a6a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.52, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
        ctx.stroke();
      }
      if (src.type === 'aphid_colony' && src.level > 1) {
        for (let k = 0; k < src.level; k++) {
          ctx.fillStyle = '#c6f07a';
          ctx.beginPath();
          ctx.arc(p.x - size * 0.2 + k * size * 0.2, p.y + size * 0.55, Math.max(1.5, size * 0.06), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (src.cd > 0 && WAR_SOURCES.has(src.type)) {
        ctx.fillStyle = 'rgba(20,14,8,0.45)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** C220: the drawn mound size eases toward the Mound's growth value (level + progress), so it rises smoothly. */
  let moundDisp = -1;
  let moundAt = 0;
  function moundSize(s) {
    const lvl = Number(s.run.surface.mound) || 0;
    let want = lvl;
    try {
      const g = surfaceSys.moundGrowth(s);
      if (g && Number.isFinite(g.shown)) want = Math.max(lvl, g.shown);
    } catch { want = lvl; }
    const t = nowMs();
    const dt = moundAt > 0 ? Math.min(1, Math.max(0, (t - moundAt) / 1000)) : 1;
    moundAt = t;
    if (moundDisp < 0 || reduced || Math.abs(want - moundDisp) > 3) moundDisp = want;
    else moundDisp += (want - moundDisp) * Math.min(1, dt * 1.5);
    return moundDisp;
  }

  function drawMound(ctx, s) {
    const surf = s.run.surface;
    const level = moundSize(s);
    const p = hexToScreen(0);
    const z = curView.zoom;
    const r = SIZE * z * (0.48 + Math.min(0.5, 0.09 * Math.log2(1 + level)));
    const h = SIZE * z * (0.18 + Math.min(0.55, 0.12 * Math.log2(1 + level)));
    const base = SURFACE.mound;   // C149: mound skins are drawn on top (render/cosmetics.drawMoundCosmetics)
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(p.x + 2, p.y + 3, r * 1.1, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - h, r * 0.1, p.x, p.y, r * 1.2);
    g.addColorStop(0, shade(base, 0.18));
    g.addColorStop(1, shade(base, -0.25));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(60,40,20,0.35)';
    for (let k = 0; k < 10; k++) {
      ctx.beginPath();
      ctx.arc(p.x + (hash01(k, 1) - 0.5) * r * 1.5, p.y + (hash01(k, 2) - 0.5) * r * 1.1, Math.max(0.8, r * 0.05), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#1e120a';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - h * 0.15, r * 0.24, r * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    cosmetics.drawMoundCosmetics(ctx, s, p, r, h);   // C149: snow cap, white flag, ladybug pet (and the ant tint sync)
    // other entrances
    for (const e of surf.entrances || []) {
      if (!e || e.kind === 'main' || !(e.hex >= 0)) continue;
      const q = hexToScreen(e.hex);
      if (!visiblePt(q)) continue;
      const rr = SIZE * z * 0.36;
      ctx.fillStyle = e.kind === 'outpost' ? shade(SURFACE.player, -0.35) : shade(SURFACE.mound, -0.05);
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, rr, rr * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e120a';
      ctx.beginPath();
      ctx.ellipse(q.x, q.y - rr * 0.1, rr * 0.32, rr * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      if (e.kind === 'outpost' || e.kind === 'satellite') {
        ctx.strokeStyle = '#3a2a1a';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(q.x + rr * 0.6, q.y);
        ctx.lineTo(q.x + rr * 0.6, q.y - rr * 1.6);
        ctx.stroke();
        ctx.fillStyle = SURFACE.player;
        ctx.beginPath();
        ctx.moveTo(q.x + rr * 0.6, q.y - rr * 1.6);
        ctx.lineTo(q.x + rr * 1.3, q.y - rr * 1.35);
        ctx.lineTo(q.x + rr * 0.6, q.y - rr * 1.1);
        ctx.fill();
      }
    }
  }

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    const c = (hue / 60) | 0;
    const x = Math.round(255 * (1 - Math.abs(((hue / 60) % 2) - 1)));
    const t = [[255, x, 60], [x, 255, 60], [60, 255, x], [60, x, 255], [x, 60, 255], [255, 60, x]][c] || [200, 160, 60];
    return (t[0] << 16) | (t[1] << 8) | t[2];
  }

  function rivalVisible(s, rv) {
    if (!rv || !rv.alive || !(rv.hex >= 0)) return false;
    return !!rv.sighted || !!(s.run.surface.revealed && s.run.surface.revealed[rv.hex]);
  }

  function drawRivals(ctx, s) {
    const z = curView.zoom;
    const ui0 = uiOf(ui);
    const sel = ui0.selection && ui0.selection.view === 'surface' && ui0.selection.kind === 'rival' ? ui0.selection.id : -1;
    for (const rv of s.run.rivals.list || []) {
      if (!rivalVisible(s, rv)) continue;
      const p = hexToScreen(rv.hex);
      if (!visiblePt(p)) continue;
      const col = rivalColor(rv.type, rv.tier);
      const boss = rv.type === 'old_ridge_supercolony' || rv.type === 'great_rival';
      const r = SIZE * z * (0.42 + Math.min(0.3, 0.04 * (rv.tier || 1)) + (boss ? 0.2 : 0));
      if (rv.uid === sel) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(p.x + 2, p.y + 3, r * 1.05, r * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade(col, -0.35);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
      const pat = hatchPattern(ctx, rivalPatternKind(rv.type, rv.tier), shade(col, 0.4), 0.8, 7);
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fill();
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = boss ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = '#120a06';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - r * 0.1, r * 0.25, r * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      if (boss) {
        ctx.fillStyle = col;
        for (let k = 0; k < 5; k++) {
          const a = -Math.PI / 2 + (k - 2) * 0.45;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * r * 0.9, p.y + Math.sin(a) * r * 0.7);
          ctx.lineTo(p.x + Math.cos(a) * r * 1.35, p.y + Math.sin(a) * r * 1.05);
          ctx.lineTo(p.x + Math.cos(a + 0.15) * r * 0.9, p.y + Math.sin(a + 0.15) * r * 0.7);
          ctx.fill();
        }
      }
      // tier badge
      const label = boss ? '★' : `T${rv.tier || 1}`;
      ctx.font = `700 ${Math.max(8, 10 * Math.sqrt(z))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 6;
      ctx.fillStyle = 'rgba(15,10,5,0.8)';
      ctx.fillRect(p.x - tw / 2, p.y + r * 0.85, tw, 12);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, p.x, p.y + r * 0.85 + 6);
      if (rv.truce > 0) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(p.x + r * 0.7, p.y - r * 1.1, Math.max(5, r * 0.45), Math.max(4, r * 0.3));
        ctx.strokeStyle = '#3a2a1a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x + r * 0.7, p.y - r * 1.1);
        ctx.lineTo(p.x + r * 0.7, p.y - r * 0.2);
        ctx.stroke();
        // C225: the truce's time left beside the white flag ("Truce 4:12")
        const secs = Math.max(0, Math.ceil(Number(rv.truce) || 0));
        const tl = 'Truce ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
        ctx.font = `600 ${Math.max(8, 9 * Math.sqrt(z))}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const fw = ctx.measureText(tl).width + 6;
        const fx = p.x + r * 0.7 + Math.max(5, r * 0.45) + 3;
        const fy = p.y - r * 1.1 + Math.max(4, r * 0.3) / 2;
        ctx.fillStyle = 'rgba(15,10,5,0.8)';
        ctx.fillRect(fx, fy - 6, fw, 12);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(tl, fx + 3, fy);
      }
    }
  }

  function partyPos(pt) {
    const path = Array.isArray(pt.path) ? pt.path : [];
    if (!path.length) return hexToScreen(0);
    const pos = clamp(Number(pt.pos) || 0, 0, path.length - 1);
    const k = Math.floor(pos);
    const u = pos - k;
    const a = hexWorldPt(path[k]);
    const b = hexWorldPt(path[Math.min(path.length - 1, k + 1)]);
    return w2s(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
  }

  function drawParties(ctx, s) {
    const z = curView.zoom;
    for (const pt of (s.run.war && s.run.war.parties) || []) {
      if (!pt || pt.state === 'fighting') continue;
      const p = partyPos(pt);
      if (!visiblePt(p)) continue;
      const n = (pt.soldier || 0) + (pt.supermajor || 0);
      const unit = 9 * Math.pow(z, 0.7);
      const heading = pt.state === 'home' ? Math.PI : 0;
      for (let k = 0; k < Math.min(3, Math.ceil(n)); k++) {
        atlas.drawAnt(ctx, k === 0 && pt.supermajor > 0 ? 'supermajor' : 'soldier', 'none', heading, (Math.floor(time * 8 + k) & 1),
          p.x - k * unit * 0.7, p.y + (k % 2 ? 3 : -3), unit);
      }
      ctx.strokeStyle = '#3a2a1a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x + unit * 0.4, p.y);
      ctx.lineTo(p.x + unit * 0.4, p.y - unit * 2);
      ctx.stroke();
      ctx.fillStyle = SURFACE.player;
      ctx.beginPath();
      ctx.moveTo(p.x + unit * 0.4, p.y - unit * 2);
      ctx.lineTo(p.x + unit * 1.6, p.y - unit * 1.65);
      ctx.lineTo(p.x + unit * 0.4, p.y - unit * 1.3);
      ctx.fill();
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(15,10,5,0.8)';
      const text = compactInt(Math.ceil(n));
      ctx.fillRect(p.x + unit * 1.7, p.y - unit * 2.1, ctx.measureText(text).width + 6, 12);
      ctx.fillStyle = '#fff3c4';
      ctx.fillText(text, p.x + unit * 1.7 + 3, p.y - unit * 2.1 + 6);
    }
  }

  function drawRaidArrows(ctx, s) {
    const raids = (s.run.war && s.run.war.raids) || [];
    const trails = s.run.surface.trails || [];
    for (const r of raids) {
      if (!r || r.phase !== 'warning') continue;
      const rv = (s.run.rivals.list || []).find((x) => x && x.uid === r.rival);
      if (!rv || !(rv.hex >= 0)) continue;
      const a = hexToScreen(rv.hex);
      let b = hexToScreen(0);
      if (r.target && r.target.type === 'trail') {
        const tr = trails.find((t) => t && t.uid === r.target.uid);
        if (tr && Array.isArray(tr.path) && tr.path.length) b = hexToScreen(tr.path[Math.floor(tr.path.length / 2)]);
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L;
      const uy = dy / L;
      const bx = b.x - ux * 12;
      const by = b.y - uy * 12;
      ctx.strokeStyle = SURFACE.raid;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -time * 24;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.fillStyle = SURFACE.raid;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(bx - uy * 7, by + ux * 7);
      ctx.lineTo(bx + uy * 7, by - ux * 7);
      ctx.closePath();
      ctx.fill();
      const text = `${Math.max(0, Math.ceil(r.warn || 0))}s`;
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.fillStyle = 'rgba(40,0,0,0.85)';
      ctx.fillRect(mx - 15, my - 8, 30, 16);
      ctx.fillStyle = '#ffe0dc';
      ctx.fillText(text, mx, my);
    }
  }

  function objectsList(s) {
    return ((s.run.events && s.run.events.objects) || []).filter((o) => o && o.hex >= 0 && o.kind !== 'mold' && OBJECT_ICON[o.kind]);
  }

  function objectScreen(o) {
    const p = hexToScreen(o.hex);
    if (o.kind === 'rival_alate') {
      return { x: p.x + Math.sin(time * 1.3 + o.uid) * 10 * curView.zoom, y: p.y - 10 * curView.zoom + Math.cos(time * 2.1 + o.uid) * 6 };
    }
    return p;
  }

  function drawObjects(ctx, s) {
    const size = iconSize();
    for (const o of objectsList(s)) {
      const p = objectScreen(o);
      if (!visiblePt(p, 80)) continue;
      if (o.kind === 'footstep') {
        const life = o.t > 0 ? o.t : 0;
        const grow = clamp(1 - life / 5, 0.2, 1);
        ctx.fillStyle = `rgba(0,0,0,${0.15 + 0.3 * grow})`;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, SIZE * curView.zoom * 2.4 * grow, SIZE * curView.zoom * 1.6 * grow, 0.4, 0, Math.PI * 2);
        ctx.fill();
        atlas.drawIcon(ctx, 'footstep', p.x, p.y, size * 2.2 * grow);
        continue;
      }
      if (o.kind === 'army_column') {
        const ang = (o.data && Number.isFinite(o.data.angle)) ? o.data.angle : 0.6;
        const L = SIZE * curView.zoom * 5;
        ctx.strokeStyle = 'rgba(25,15,10,0.65)';
        ctx.lineWidth = SIZE * curView.zoom * 0.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x - Math.cos(ang) * L, p.y - Math.sin(ang) * L);
        ctx.lineTo(p.x + Math.cos(ang) * L, p.y + Math.sin(ang) * L);
        ctx.stroke();
        ctx.fillStyle = 'rgba(60,35,20,0.9)';
        for (let k = 0; k < 18; k++) {
          const u = ((time * 0.15 + k / 18) % 1) * 2 - 1;
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(ang) * L * u + Math.sin(k) * 4, p.y + Math.sin(ang) * L * u + Math.cos(k * 1.7) * 4, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }
      if (o.kind === 'ladybug') {
        const n = Math.min(10, Math.max(1, (o.data && Number.isFinite(o.data.n)) ? o.data.n : 5));
        for (let k = 0; k < n; k++) {
          const a = k * 2.4 + time * 0.6;
          atlas.drawIcon(ctx, 'ladybug', p.x + Math.cos(a) * size * 0.45, p.y + Math.sin(a) * size * 0.3, size * 0.45);
        }
        continue;
      }
      if (o.kind === 'fossil_cache') {
        drawFossil(ctx, p.x, p.y, size, o.uid);
        continue;
      }
      if (o.kind === 'lost_queen') {
        // C188: a soft gold halo marks the scouts' find
        ctx.fillStyle = `rgba(255,226,140,${0.22 + 0.12 * Math.sin(time * 2.5 + o.uid)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.62, 0, Math.PI * 2);
        ctx.fill();
      }
      const bob = o.kind === 'golden_aphid' || o.kind === 'wandering_queen' || o.kind === 'lost_queen' ? Math.sin(time * 3) * 2 : 0;
      const osz = size * (o.kind === 'lizard' ? 1.3 : 1);
      if (amb.on) {
        // C161: molehill soil puffs, swarm alates, the rove beetle's antennae, the Phengaris caterpillar's inching
        const ao = { t: time, uid: o.uid, wind: amb.wind };
        drawIconAmbient(ctx, atlas, OBJECT_ICON[o.kind], p.x, p.y + bob, osz, ao);
        drawAmbientExtras(ctx, OBJECT_ICON[o.kind], p.x, p.y + bob, osz, ao);
      } else {
        atlas.drawIcon(ctx, OBJECT_ICON[o.kind], p.x, p.y + bob, osz);
      }
      if (o.t > 0 && o.t < 600) {
        const max = o.data && o.data.tMax > 0 ? o.data.tMax : null;
        if (max) {
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, size * 0.55, -Math.PI / 2, -Math.PI / 2 + clamp(o.t / max, 0, 1) * Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  /** C188: a fossil cache — a pale stone slab with an ammonite spiral, glinting. */
  function drawFossil(ctx, x, y, size, uid) {
    const r = size * 0.42;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.12, y + r * 0.22, r * 1.05, r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9cbb0';
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.05, r * 0.75, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8a7556';
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    for (let k = 0; k <= 40; k++) {
      const a = k * 0.42;
      const rr = r * 0.08 + (r * 0.62 * k) / 40;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr * 0.8;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    const g = (time * 0.6 + hash01(uid | 0, 71)) % 1;
    if (g < 0.25) {
      ctx.fillStyle = `rgba(255,250,220,${0.9 * Math.sin((g / 0.25) * Math.PI)})`;
      ctx.beginPath();
      ctx.arc(x - r * 0.45, y - r * 0.3, Math.max(1.2, size * 0.06), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function beetlePos(s) {
    const b = s.run.golden && s.run.golden.beetle;
    if (!b || !(b.hex >= 0)) return null;
    lastBeetleHex = b.hex;
    const p = hexToScreen(b.hex);
    return { x: p.x + Math.sin(time * 2.2) * 4 * curView.zoom, y: p.y + Math.cos(time * 3.1) * 2 * curView.zoom, b };
  }

  function giftList(s) {
    return (s.run.golden && s.run.golden.gifts) || [];
  }

  function drawGolden(ctx, s) {
    const size = iconSize();
    const bp = beetlePos(s);
    if (bp) {
      ctx.fillStyle = `rgba(255,220,80,${0.25 + 0.2 * Math.sin(time * 6)})`;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, size * 0.8, 0, Math.PI * 2);
      ctx.fill();
      atlas.drawIcon(ctx, 'golden_beetle', bp.x, bp.y, size * 1.1);
      const life = (GOLDEN && GOLDEN.life) || 13;
      if (bp.b.t > 0) {
        ctx.strokeStyle = 'rgba(255,246,194,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, size * 0.7, -Math.PI / 2, -Math.PI / 2 + clamp(bp.b.t / life, 0, 1) * Math.PI * 2);
        ctx.stroke();
      }
      if (!reduced && Math.random() < 0.15) {
        const w = hexWorldPt(bp.b.hex);
        fxWorld.sparkle(w.x + (Math.random() - 0.5) * 16, w.y + (Math.random() - 0.5) * 12, 1, 10);
      }
    }
    const gifts = giftList(s);
    for (let k = 0; k < gifts.length; k++) {
      const gft = gifts[k];
      if (!gft || !(gft.hex >= 0)) continue;
      const p = hexToScreen(gft.hex);
      if (!visiblePt(p)) continue;
      atlas.drawIcon(ctx, 'gift', p.x, p.y + Math.sin(time * 2.5 + k) * 2, size * 0.9);
    }
  }

  function daughterPositions(s) {
    const list = ((s.cycle && s.cycle.daughters) || []).slice(-((RESET && RESET.daughtersMax) || 8));
    const R = radiusOf(s) + 1.6;
    return list.map((dg, k) => {
      const a = ((hash01((dg && dg.seed) || k, 7) + k / Math.max(1, list.length)) % 1) * Math.PI * 2;
      return { x: Math.cos(a) * R * SIZE * SQRT3 * 0.98, y: Math.sin(a) * R * SIZE * 1.5 * 0.98, a };
    });
  }

  /**
   * Daughter colonies (DESIGN §14.6, `cycle.daughters`): allied nests founded by earlier Flights, shown beyond the map
   * edge. C124 (player report "enemy anthills through the fog"): they used to be bare gold mounds that read as unscouted
   * rival nests; they now carry wings, a dashed allied ring in the player's colour and a "Daughter colony" label.
   */
  function drawDaughters(ctx, s) {
    const pos = daughterPositions(s);
    if (!pos.length) return;
    const list = ((s.cycle && s.cycle.daughters) || []).slice(-((RESET && RESET.daughtersMax) || 8));
    const budding = !!(s.cycle && s.cycle.traits && s.cycle.traits.budding > 0);
    const z = curView.zoom;
    for (let k = 0; k < pos.length; k++) {
      const p = pos[k];
      const sp = w2s(p.x, p.y);
      if (budding) {
        const end = w2s(p.x * 0.55, p.y * 0.55);
        ctx.strokeStyle = rgba(SURFACE.daughter, 0.35);
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (!visiblePt(sp)) continue;
      const r = SIZE * z * 0.45;
      // allied ring (dashed, player amber) so it never reads as a rival nest
      ctx.strokeStyle = rgba(SURFACE.player, 0.75);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r * 1.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(sp.x + 2, sp.y + 2, r * 1.05, r * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade(SURFACE.daughter, -0.25);
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y, r, r * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = SURFACE.daughter;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#1e120a';
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y - r * 0.1, r * 0.25, r * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      // a pair of alate wings above the mound: the colony a Flight founded
      ctx.fillStyle = 'rgba(232,242,255,0.85)';
      ctx.strokeStyle = 'rgba(60,70,90,0.6)';
      ctx.lineWidth = 0.8;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(sp.x + side * r * 0.42, sp.y - r * 0.95, r * 0.42, r * 0.17, side * -0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      const dg = list[k];
      const label = z >= 0.8 && dg && dg.alates > 0 ? `Daughter colony · ${compactInt(dg.alates)} alates` : 'Daughter colony';
      ctx.font = `600 ${Math.max(9, Math.round(10 * Math.sqrt(z)))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 8;
      const ly = sp.y + r * 1.55 + 9;
      // kept inside the canvas: the colonies sit beyond the map edge, often near the canvas border
      const lx = layer.cssW > tw + 8 ? clamp(sp.x, tw / 2 + 4, layer.cssW - tw / 2 - 4) : sp.x;
      ctx.fillStyle = 'rgba(20,14,6,0.72)';
      ctx.fillRect(lx - tw / 2, ly - 7, tw, 14);
      ctx.fillStyle = SURFACE.daughter;
      ctx.fillText(label, lx, ly);
    }
  }

  function drawFrontier(ctx, s, d, T) {
    const showShimmer = (s.run.colony && s.run.colony.jobs && s.run.colony.jobs.scout > 0) || (s.run.unlocked && s.run.unlocked.job_scout);
    const z = curView.zoom;
    const hexR = SIZE * z;
    if (showShimmer && !reduced) {
      ctx.lineWidth = 1.2;
      for (const h of T.frontier) {
        const p = hexToScreen(h);
        if (!visiblePt(p)) continue;
        const a = 0.12 + 0.12 * Math.sin(time * 2 + h * 0.7);
        ctx.strokeStyle = rgba(SURFACE.shimmer, a);
        ctx.beginPath();
        hexPathOn(ctx, p.x, p.y, hexR * 0.9);
        ctx.stroke();
      }
    }
    const sc = s.run.surface.scout;
    if (sc && sc.target >= 0) {
      const p = hexToScreen(sc.target);
      const ring = Math.max(1, ringOf(sc.target));
      const cost = ((SCOUT && SCOUT.base) || 10) * Math.pow(ring, (SCOUT && SCOUT.exp) || 1.2);
      const f = clamp((sc.prog || 0) / cost, 0, 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, hexR * 0.5, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      ctx.stroke();
    }
    const flagged = s.run.surface.flagged || [];
    for (const h of flagged) {
      const p = hexToScreen(h);
      if (visiblePt(p)) atlas.drawIcon(ctx, 'flag', p.x + hexR * 0.15, p.y - hexR * 0.2, hexR * 0.9);
    }
    void d;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sprites
  // ---------------------------------------------------------------------------------------------------------------

  function entranceForOrigin(s, hex) {
    for (const e of s.run.surface.entrances || []) if (e && e.hex === hex) return e;
    return null;
  }

  function realloc(s, d) {
    const trails = s.run.surface.trails || [];
    const sig = trails.map((t) => (t ? t.uid : 0)).join(',');
    if (sig !== trailSig) {
      trailSig = sig;
      pool.n = 0;
    }
    const a = allocAbove(s, d, BUDGET.above);
    K = a.K;
    const counts = [...a.trail, ...a.escort, a.scouts, a.garrison, a.loose];
    const T = trails.length;
    reconcile(pool, counts, (i, g) => spawnSprite(s, i, g, T), (i) => pool.path[i]);
  }

  function spawnSprite(s, i, g, T) {
    pool.path[i] = g;
    pool.speed[i] = 0.85 + Math.random() * 0.3;
    pool.ox[i] = (Math.random() - 0.5) * 6;
    pool.type[i] = KIND.minor;
    if (s.run.colony.golden > 0 && Math.random() < s.run.colony.golden / Math.max(1, s.run.colony.adults.minor)) pool.type[i] = KIND.golden;
    if (g < T) {
      pool.state[i] = Math.random() < 0.5 ? ST.OUT : ST.BACK;
      pool.t[i] = Math.random();
      const tr = s.run.surface.trails[g];
      const src = tr ? (s.run.surface.sources || []).find((x) => x && x.uid === tr.src) : null;
      pool.carry[i] = pool.state[i] === ST.BACK ? carryFor(tr && tr.job, src && src.type, i) : 0;
    } else if (g < 2 * T) {
      pool.type[i] = KIND.soldier;
      pool.state[i] = ST.OUT;
      pool.t[i] = 0.2 + Math.random() * 0.7;
      pool.carry[i] = 0;
    } else {
      const home = hexWorldPt(0);
      pool.x[i] = home.x + (Math.random() - 0.5) * SIZE;
      pool.y[i] = home.y + (Math.random() - 0.5) * SIZE;
      pool.state[i] = ST.WANDER;
      pool.carry[i] = 0;
      pool.aux[i] = 0;
      pool.cell[i] = -1;
      if (g === 2 * T + 1) pool.type[i] = KIND.soldier;
      newWanderTarget(s, i, g, T);
    }
  }

  function newWanderTarget(s, i, g, T) {
    const home = hexWorldPt(0);
    if (g === 2 * T) {
      // scouts: toward the current scouting target or a frontier hex
      const sc = s.run.surface.scout;
      let h = sc && sc.target >= 0 ? sc.target : -1;
      const fr = territoryCache && territoryCache.frontier;
      if ((h < 0 || Math.random() < 0.4) && fr && fr.length) h = fr[Math.floor(Math.random() * fr.length)];
      const p = h >= 0 ? hexWorldPt(h) : home;
      pool.next[i] = h;
      pool.tx[i] = p.x + (Math.random() - 0.5) * SIZE;
      pool.ty[i] = p.y + (Math.random() - 0.5) * SIZE;
    } else if (g === 2 * T + 1) {
      const a = Math.random() * Math.PI * 2;
      const r = SIZE * (0.4 + Math.random() * 0.6);
      pool.tx[i] = home.x + Math.cos(a) * r;
      pool.ty[i] = home.y + Math.sin(a) * r * 0.8;
    } else {
      if (pool.carry[i]) {
        pool.tx[i] = home.x;
        pool.ty[i] = home.y;
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = SIZE * (1 + Math.random() * 1.6);
        pool.tx[i] = home.x + Math.cos(a) * r * SQRT3 * 0.8;
        pool.ty[i] = home.y + Math.sin(a) * r * 1.2;
      }
    }
  }

  let territoryCache = null;
  const tmpPt = { x: 0, y: 0, a: 0 };

  function updateSprites(s, d, dt) {
    const trails = s.run.surface.trails || [];
    const T = trails.length;
    const sMax = (TRAIL && TRAIL.sMax) || 100;
    const srcByUid = new Map();
    for (const src of s.run.surface.sources || []) if (src) srcByUid.set(src.uid, src);
    // tokens from the nest: pellets fly onto the mound; empty hand-offs wake a waiting trail ant
    let tok = hub.take('up');
    let guard = 0;
    while (tok && guard++ < 12) {
      const ent = tok.col >= 0 ? (s.run.surface.entrances || []).find((e) => e && e.col === tok.col) : null;
      const w = hexWorldPt(ent ? ent.hex : 0);
      if (CARRY_CODES[tok.carry] === 'pellet') {
        const a = Math.random() * Math.PI * 2;
        const r = SIZE * (0.25 + Math.random() * 0.3);
        fxWorld.pellet(w.x, w.y - 3, w.x + Math.cos(a) * r, w.y + Math.sin(a) * r * 0.7, 1.4);
      } else {
        for (let i = 0; i < pool.n; i++) {
          if (pool.state[i] !== ST.AWAY) continue;
          pool.state[i] = ST.OUT;
          pool.t[i] = 0;
          pool.carry[i] = 0;
          break;
        }
      }
      tok = hub.take('up');
    }
    for (let i = 0; i < pool.n; i++) {
      const g = pool.path[i];
      pool.anim[i] += dt * 9 * pool.speed[i];
      if (g < T) {
        const tr = trails[g];
        if (!tr) continue;
        const geo = trailWorld(tr);
        if (!(geo.tab.total > 0)) {
          const p = hexWorldPt(tr.origin >= 0 ? tr.origin : 0);
          pool.x[i] = p.x;
          pool.y[i] = p.y;
          continue;
        }
        if (pool.state[i] === ST.AWAY) {
          pool.aux[i] -= dt;
          if (pool.aux[i] <= 0) {
            pool.state[i] = ST.OUT;
            pool.t[i] = 0;
            pool.carry[i] = 0;
          }
          continue;
        }
        const v = (SIZE * 1.15 * pool.speed[i] * (0.85 + 0.5 * clamp((tr.S || 0) / sMax, 0, 1))) / geo.tab.total;
        if (pool.state[i] === ST.OUT) {
          pool.t[i] += v * dt;
          if (pool.t[i] >= 1) {
            pool.t[i] = 1;
            pool.state[i] = ST.BACK;
            const src = srcByUid.get(tr.src);
            pool.carry[i] = carryFor(tr.job, src && src.type, i);
          }
        } else {
          pool.t[i] -= v * dt;
          if (pool.t[i] <= 0) {
            pool.t[i] = 0;
            const ent = entranceForOrigin(s, tr.origin);
            if (ent && (ent.kind === 'main' || ent.kind === 'nuptial' || ent.kind === 'satellite') && Math.random() < 0.75) {
              hub.send('down', pool.carry[i] || 1, ent.kind === 'main' ? -1 : ent.col);
              pool.state[i] = ST.AWAY;
              pool.aux[i] = 1.2 + Math.random() * 1.4;
            } else {
              pool.state[i] = ST.OUT;
              pool.carry[i] = 0;
            }
          }
        }
        pointAtArc(geo.tab, pool.t[i], tmpPt);
        const back = pool.state[i] === ST.BACK;
        const lane = pool.ox[i] * (back ? -1 : 1);
        pool.x[i] = tmpPt.x + Math.cos(tmpPt.a + Math.PI / 2) * lane;
        pool.y[i] = tmpPt.y + Math.sin(tmpPt.a + Math.PI / 2) * lane;
        pool.a[i] = back ? tmpPt.a + Math.PI : tmpPt.a;
      } else if (g < 2 * T) {
        // escorts patrol their trail
        const tr = trails[g - T];
        if (!tr) continue;
        const geo = trailWorld(tr);
        if (!(geo.tab.total > 0)) continue;
        const v = (SIZE * 0.6 * pool.speed[i]) / geo.tab.total;
        const dir = pool.state[i] === ST.OUT ? 1 : -1;
        pool.t[i] += v * dt * dir;
        if (pool.t[i] > 0.92) pool.state[i] = ST.BACK;
        if (pool.t[i] < 0.15) pool.state[i] = ST.OUT;
        pointAtArc(geo.tab, pool.t[i], tmpPt);
        pool.x[i] = tmpPt.x + Math.cos(tmpPt.a + Math.PI / 2) * pool.ox[i] * 1.6;
        pool.y[i] = tmpPt.y + Math.sin(tmpPt.a + Math.PI / 2) * pool.ox[i] * 1.6;
        pool.a[i] = dir > 0 ? tmpPt.a : tmpPt.a + Math.PI;
      } else {
        // scouts, garrison, loose foragers: steer toward a target point
        const dx = pool.tx[i] - pool.x[i];
        const dy = pool.ty[i] - pool.y[i];
        const L = Math.hypot(dx, dy);
        const speed = SIZE * (g === 2 * T + 1 ? 0.35 : 0.9) * pool.speed[i];
        if (L < 2) {
          pool.aux[i] += dt;
          if (pool.aux[i] > (g === 2 * T + 1 ? 1.5 : 0.4)) {
            pool.aux[i] = 0;
            if (g === 2 * T + 2) {
              const home = hexWorldPt(0);
              const atHome = Math.hypot(pool.x[i] - home.x, pool.y[i] - home.y) < SIZE * 0.6;
              pool.carry[i] = atHome ? 0 : 1;
            }
            newWanderTarget(s, i, g, T);
          }
        } else {
          const step = Math.min(L, speed * dt);
          pool.x[i] += (dx / L) * step;
          pool.y[i] += (dy / L) * step;
          pool.a[i] = Math.atan2(dy, dx) + Math.sin(time * 6 + i) * 0.15;
        }
      }
    }
  }

  function drawSprites(ctx) {
    const unit = 11 * Math.pow(curView.zoom, 0.75);
    let n = 0;
    for (let i = 0; i < pool.n; i++) {
      if (pool.state[i] === ST.AWAY) continue;
      const p = w2s(pool.x[i], pool.y[i]);
      if (!visiblePt(p, 10)) continue;
      atlas.drawAnt(ctx, pool.type[i], CARRY_CODES[pool.carry[i]] || 'none', pool.a[i], Math.floor(pool.anim[i]) & 1, p.x, p.y, unit);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // weather, previews, labels
  // ---------------------------------------------------------------------------------------------------------------

  function raining(s) {
    const act = (s.run.events && s.run.events.active) || [];
    for (const a of act) if (a && a.id === 'ev_rainstorm' && !(a.data && a.data.forecast)) return true;
    for (const e of s.run.effects || []) if (e && typeof e.id === 'string' && e.id.startsWith('ev_rainstorm')) return true;
    return false;
  }

  /**
   * Weather intensities for this frame (C123): snow and leaves follow the season blend (ramping in and out over the
   * transition window); a rainstorm replaces them while it lasts.
   * @returns {{ rain: number, snow: number, leaves: number }}
   */
  function weatherNow(s, d, sb) {
    if (raining(s)) return { rain: 1, snow: 0, leaves: 0 };
    const w = blendWeather(sb || seasonBlend(d && d.season), !!(d && d.season && d.season.mild));
    return { rain: 0, snow: w.snow, leaves: w.leaves };
  }

  function drawWeather(ctx, s, d, dt, W, H, sb) {
    const bounds = { x: 0, y: 0, w: W, h: H };
    // C123 (player report): weather is seeded from the current season on load, import, a new run, the view shown
    // again and resizes, spread over the whole view, instead of trickling in as a band from the top edge
    fxScreen.weatherMix(weatherNow(s, d, sb), bounds, dt, reduced, weatherFill);
    if (W > 0 && H > 0) weatherFill = false;
    fxScreen.update(dt, bounds);
    fxScreen.draw(ctx);
    const drought = ((s.run.events && s.run.events.active) || []).some((a) => a && a.id === 'ev_drought' && !(a.data && a.data.forecast));
    if (drought) {
      ctx.fillStyle = 'rgba(190,150,60,0.12)';
      ctx.fillRect(0, 0, W, H);
    }
    if (raining(s)) {
      ctx.fillStyle = 'rgba(40,60,90,0.16)';
      ctx.fillRect(0, 0, W, H);
    }
    const wash = blendWash(sb || seasonBlend(d && d.season));
    if (wash) {
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function hexOutline(ctx, hex, color, width = 2, scale = 0.95) {
    const p = hexToScreen(hex);
    if (!visiblePt(p)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    hexPathOn(ctx, p.x, p.y, SIZE * curView.zoom * scale);
    ctx.stroke();
  }

  function drawPathHexes(ctx, path, color, dashed = true) {
    if (!Array.isArray(path) || path.length < 2) return;
    const sp = pathCurve(path, 5).map((p) => w2s(p.x, p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    if (dashed) ctx.setLineDash([6, 5]);
    ctx.beginPath();
    sp.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** C237: valid aphid-move hexes, memoised on the surface revision and the colony. */
  const aphidMemo = { key: '', list: [] };
  function aphidTargetsFor(s, d, src) {
    const key = `${src}|${s.run.surface.rev}|${(s.run.surface.sources || []).length}`;
    if (aphidMemo.key !== key) {
      aphidMemo.key = key;
      aphidMemo.list = safe(() => surfaceSys.aphidTargets(s, d, src), []) || [];
    }
    return aphidMemo.list;
  }

  function drawToolPreviews(ctx, s, d) {
    const ui0 = uiOf(ui);
    const tool = ui0.tool;
    const hh = input.hoverHex >= 0 ? input.hoverHex : (ui0.hover && ui0.hover.view === 'surface' && ui0.hover.hex >= 0 ? ui0.hover.hex : -1);
    if (tool && hh >= 0) {
      if (tool.kind === 'claim') {
        const key = `${hh}|${s.run.surface.rev}|${Math.floor((s.run.res && s.run.res.pheromone) || 0)}`;
        if (claimMemo.key !== key) {
          claimMemo.key = key;
          claimMemo.res = safe(() => surfaceSys.canClaim(s, d, hh), 'invalid');
        }
        const ok = claimMemo.res === null;
        hexOutline(ctx, hh, ok ? SURFACE.claimOk : SURFACE.claimBad, 3);
        const p = hexToScreen(hh);
        ctx.fillStyle = rgba(ok ? SURFACE.claimOk : SURFACE.claimBad, 0.25);
        ctx.beginPath();
        hexPathOn(ctx, p.x, p.y, SIZE * curView.zoom * 0.95);
        ctx.fill();
      } else if (tool.kind === 'moveAphids') {
        const ok = aphidTargetsFor(s, d, tool.src).includes(hh);   // C237
        hexOutline(ctx, hh, ok ? SURFACE.claimOk : SURFACE.claimBad, 3);
      } else if (tool.kind === 'flag' || tool.kind === 'tournament') {
        hexOutline(ctx, hh, tool.kind === 'flag' ? SURFACE.flag : '#ffffff', 2.5);
      }
    }
    // C237: while moving an aphid colony, every hex it may move to is tinted green
    if (tool && tool.kind === 'moveAphids') {
      for (const hx of aphidTargetsFor(s, d, tool.src)) {
        const p = hexToScreen(hx);
        if (!visiblePt(p)) continue;
        ctx.fillStyle = rgba(SURFACE.claimOk, 0.28);
        ctx.beginPath();
        hexPathOn(ctx, p.x, p.y, SIZE * curView.zoom * 0.95);
        ctx.fill();
        hexOutline(ctx, hx, SURFACE.claimOk, 1.5);
      }
    }
    if (tool && tool.kind === 'placeSatellite') drawSatelliteTool(ctx, s, d, hh);
    if (input.trailDrag && Array.isArray(input.trailDrag.path)) {
      drawPathHexes(ctx, input.trailDrag.path, input.trailDrag.ok ? 'rgba(160,255,170,0.9)' : 'rgba(255,140,130,0.9)');
      const last = input.trailDrag.path[input.trailDrag.path.length - 1];
      if (last >= 0 && input.trailDrag.label) {
        const p = hexToScreen(last);
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(input.trailDrag.label).width + 8;
        ctx.fillStyle = 'rgba(15,20,10,0.85)';
        ctx.fillRect(p.x + 12, p.y - 9, tw, 18);
        ctx.fillStyle = input.trailDrag.ok ? '#e8ffd0' : '#ffd0cc';
        ctx.fillText(input.trailDrag.label, p.x + 16, p.y);
      }
    }
    if (input.reroute && Array.isArray(input.reroute.path)) {
      drawPathHexes(ctx, input.reroute.path, 'rgba(255,230,150,0.9)');
      for (const w of input.reroute.waypoints || []) {
        const p = hexToScreen(w);
        ctx.fillStyle = '#ffe08a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (input.warDrag) {
      const a = hexToScreen(input.warDrag.from);
      const b = input.warDrag.toPt || hexToScreen(input.warDrag.to);
      ctx.strokeStyle = input.warDrag.ok ? 'rgba(255,120,90,0.95)' : 'rgba(220,220,220,0.7)';
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // onboarding ghost-ant demo (trail drag)
    const demo = ui0.ghostDemo;
    if (demo && demo.kind === 'trail' && demo.from >= 0 && demo.to >= 0) {
      const u = (time % 2.8) / 2.3;
      const a = hexToScreen(demo.from);
      const b = hexToScreen(demo.to);
      const k = clamp(u, 0, 1);
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      ctx.globalAlpha = 0.9 * (1 - clamp((u - 1) / 0.2, 0, 1));
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
      atlas.drawAnt(ctx, 'ghost', 'none', Math.atan2(b.y - a.y, b.x - a.x), (Math.floor(time * 8) & 1), x, y, 16 * Math.sqrt(curView.zoom));
      ctx.globalAlpha = 1;
    }
    // hover / selection outlines
    if (!tool && hh >= 0) hexOutline(ctx, hh, 'rgba(255,243,196,0.55)', 1.5);
    const sel = ui0.selection && ui0.selection.view === 'surface' ? ui0.selection : null;
    if (sel && (sel.kind === 'hex' || sel.kind === 'entrance') && sel.hex >= 0) hexOutline(ctx, sel.hex, SURFACE.selection, 2.5);
  }

  function drawScaleLabel(ctx, s, H) {
    const show = !(s.meta && s.meta.settings && s.meta.settings.showScaleLabel === false);
    if (!show || pool.n === 0) return;
    const text = `1 ● = ${compactInt(K)} ant${K === 1 ? '' : 's'}`;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(15,20,10,0.6)';
    ctx.fillRect(6, H - 22, tw + 10, 16);
    ctx.fillStyle = '#f4ecd8';
    ctx.fillText(text, 11, H - 14);
  }

  /** C184: "Trails 7 / 11" (slots used / available) at the bottom left, above the scale label; amber when full. */
  function drawTrailBadge(ctx, s, d, H) {
    const used = (s.run.surface.trails || []).length;
    const slots = d && d.surface && Number.isFinite(d.surface.slots) ? d.surface.slots : 0;
    if (!(slots > 0) || used === 0) return;
    const text = `Trails ${used} / ${slots}`;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const y = H - 42;
    ctx.fillStyle = 'rgba(15,20,10,0.6)';
    ctx.fillRect(6, y, tw + 10, 16);
    ctx.fillStyle = used >= slots ? '#ffcf6a' : '#f4ecd8';
    ctx.fillText(text, 11, y + 8);
  }

  function publishSeamX() {
    const now = nowMs();
    if (now - rectAt > 1000 || !rectCache) {
      rectAt = now;
      try {
        rectCache = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
      } catch {
        rectCache = null;
      }
    }
    const p = hexToScreen(0);
    hub.surfaceX = (rectCache ? rectCache.left : 0) + p.x;
  }

  function scentHint(s, d, dt) {
    const best = d && d.surface ? d.surface.bestSource : 0;
    if (!best || reduced) return;
    scentIn -= dt;
    if (scentIn > 0) return;
    scentIn = 0.7;
    const src = (s.run.surface.sources || []).find((x) => x && x.uid === best);
    if (!src || !sourceVisible(s, src)) return;
    const a = hexWorldPt(0);
    const b = hexWorldPt(src.hex);
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const v = Math.min(60, L / 2.2);
    fxWorld.scent(a.x, a.y, ((b.x - a.x) / L) * v, ((b.y - a.y) / L) * v);
  }

  function drawWorldFx(ctx) {
    const v = curView;
    ctx.save();
    ctx.setTransform(layer.dpr * v.zoom, 0, 0, layer.dpr * v.zoom, layer.dpr * (v.cx - v.x * v.zoom), layer.dpr * (v.cy - v.y * v.zoom));
    fxWorld.draw(ctx);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------------------------------------------

  function render(frameDt) {
    if (destroyed || !visible || pageHidden()) return;
    const s = S();
    const d = D();
    const ctx = layer.ctx;
    if (!s || !s.run || !s.run.surface || !ctx) return;
    if (s !== lastS) {
      if (lastS) dropCaches();
      lastS = s;
    }
    const dt = clamp(Number.isFinite(frameDt) ? frameDt : 0, 0, 0.1);
    time += dt;
    const nowS = nowMs();
    // C123: back from a hidden tab / hidden view (no frames for a while): re-seed the weather for the current season
    if (nowS - lastRenderAt > 1500) weatherFill = true;
    lastRenderAt = nowS;
    if (nowS - reducedAt > 1000) {
      reducedAt = nowS;
      reduced = reducedMotion(s);
    }
    ensureViewport(s);
    curView = camView();
    const W = layer.cssW;
    const H = layer.cssH;
    const T = territory(s, d);
    territoryCache = T;
    // C123: gradual seasons — the next season's terrain cross-fades over the current one in the last
    // SEASON_BLEND_SEC of a season (two cached canvases, no per-step rebuilds; continuous at the boundary, where the
    // next season's cache simply becomes the current one)
    const sb = seasonBlend(d && d.season);
    syncHiRes(radiusOf(s));
    const keepT = [];
    const terrA = terrainFor(s, sb.from, keepT);
    const terrB = sb.t > 0 && sb.to !== sb.from ? terrainFor(s, sb.to, keepT) : null;
    pruneTerrain(keepT);
    syncLand(s, d, T);
    for (const p of pulses) p.t += dt;

    ctx.setTransform(layer.dpr, 0, 0, layer.dpr, 0, 0);
    ctx.fillStyle = SURFACE.void;
    ctx.fillRect(0, 0, W, H);
    blit(ctx, terrA);
    if (terrB) {
      ctx.globalAlpha = sb.t;
      blit(ctx, terrB);
      ctx.globalAlpha = 1;
    }
    blit(ctx, landCache);
    const tool0 = uiOf(ui).tool;
    if (tool0 && tool0.kind === 'placeSatellite') {
      syncSatellite(s, d);
      blit(ctx, satCache);
    }
    drawFrontier(ctx, s, d, T);
    const trails = s.run.surface.trails || [];
    syncBlockKey(s, d);
    syncLanes(trails);
    const polys = trails.map((tr) => (tr ? trailScreen(tr) : null));
    drawDaughters(ctx, s);
    drawTrails(ctx, s, d, polys);
    drawMound(ctx, s);
    amb.on = !reduced;
    amb.wind = amb.on ? windStrength(weatherNow(s, d, sb)) : 0;
    const tAmb = nowMs();
    drawSources(ctx, s, d);
    drawRivals(ctx, s);
    drawRaidArrows(ctx, s);
    drawObjects(ctx, s);
    ambientMs = ambientMs * 0.9 + (nowMs() - tAmb) * 0.1;
    drawGolden(ctx, s);

    reallocIn -= dt;
    if (reallocIn <= 0) {
      reallocIn = REALLOC_SEC;
      realloc(s, d);
    }
    updateSprites(s, d, dt);
    if (!ceremonyHidesSurfaceSprites()) drawSprites(ctx);
    drawParties(ctx, s);
    battles.sync(s, fxWorld, hexWorldPt);
    battles.update(dt, fxWorld, hexWorldPt);
    const rivalByBattle = (uid) => {
      const b = ((s.run.war && s.run.war.battles) || []).find((x) => x && x.uid === uid);
      if (!b) return null;
      let rv = null;
      if (b.raid) {
        const r = (s.run.war.raids || []).find((x) => x && x.uid === b.raid);
        rv = r ? (s.run.rivals.list || []).find((x) => x && x.uid === r.rival) : null;
      }
      if (!rv && b.party) {
        const pt = (s.run.war.parties || []).find((x) => x && x.uid === b.party);
        if (pt && pt.target && pt.target.type === 'rival') rv = (s.run.rivals.list || []).find((x) => x && x.uid === pt.target.uid);
      }
      return rv ? rivalColor(rv.type, rv.tier) : null;
    };
    if (!ceremonyHidesSurfaceSprites()) battles.draw(ctx, hexToScreen, 11 * Math.pow(curView.zoom, 0.75), rivalByBattle, (p) => visiblePt(p, 60));
    scentHint(s, d, dt);
    fxWorld.update(dt, null);
    drawWorldFx(ctx);
    drawWeather(ctx, s, d, dt, W, H, sb);
    const ui0 = uiOf(ui);
    const ov = ui0.overlays || {};
    if (ov.territory || ov.trail_strength || ov.danger || ov.richness) {
      const rivals = new Map();
      for (const rv of s.run.rivals.list || []) if (rv) rivals.set(rv.uid, rv);
      drawSurfaceOverlays(ctx, ov, {
        s, d, hexToScreen, hexR: SIZE * curView.zoom, owned: T.owned, border: T.border, rivalOf: T.rival, rivalByUid: rivals,
        radiusCount: countInRadius(radiusOf(s)), revealed: s.run.surface.revealed || [], trailPolys: polys, visible: (p) => visiblePt(p),
      });
    }
    drawToolPreviews(ctx, s, d);
    drawPings(ctx);
    if (activeCeremony()) {
      const w = d && d.season && d.season.mods ? d.season.mods.flightW : 1;
      drawCeremonySurface(ctx, { W, H, s, hexToScreen, unit: 11 * Math.pow(curView.zoom, 0.75), zoom: curView.zoom, flightW: w });
    }
    drawScaleLabel(ctx, s, H);
    drawTrailBadge(ctx, s, d, H);
    publishSeamX();
  }

  /**
   * Hit-test (priority: beetle > gift > event object > party marker > rival nest > source > trail (≤ 6 px) > hex).
   * @param {number} cssX
   * @param {number} cssY
   * @returns {{ view: 'surface', kind: string, id?: number, hex?: number } | null}
   */
  function pick(cssX, cssY) {
    const s = S();
    if (!s || !s.run || !s.run.surface) return null;
    ensureViewport(s);
    curView = camView();
    const z = curView.zoom;
    const R = radiusOf(s);
    const hex = pxToHexInRadius(cssX, cssY, curView, R);
    const icon = iconSize();
    const near = (p, r) => Math.hypot(cssX - p.x, cssY - p.y) <= r;
    const bp = beetlePos(s);
    if (bp && near(bp, icon * 0.75)) return { view: 'surface', kind: 'beetle', hex: bp.b.hex };
    const gifts = giftList(s);
    for (let k = 0; k < gifts.length; k++) {
      if (gifts[k] && gifts[k].hex >= 0 && near(hexToScreen(gifts[k].hex), icon * 0.55)) return { view: 'surface', kind: 'gift', id: k, hex: gifts[k].hex };
    }
    for (const o of objectsList(s)) {
      const r = o.kind === 'footstep' ? SIZE * z * 2.2 : o.kind === 'army_column' ? SIZE * z * 1.2 : icon * 0.6;
      if (near(objectScreen(o), r)) return { view: 'surface', kind: 'eventObject', id: o.uid, hex: o.hex };
    }
    for (const pt of (s.run.war && s.run.war.parties) || []) {
      if (!pt || pt.state === 'fighting') continue;
      if (near(partyPos(pt), Math.max(10, 12 * z))) return { view: 'surface', kind: 'party', id: pt.uid };
    }
    for (const rv of s.run.rivals.list || []) {
      if (!rivalVisible(s, rv)) continue;
      if (near(hexToScreen(rv.hex), SIZE * z * 0.75)) return { view: 'surface', kind: 'rival', id: rv.uid, hex: rv.hex };
    }
    for (const src of s.run.surface.sources || []) {
      if (!sourceVisible(s, src)) continue;
      if (near(hexToScreen(src.hex), icon * 0.55)) return { view: 'surface', kind: 'source', id: src.uid, hex: src.hex };
    }
    for (const e of s.run.surface.entrances || []) {
      if (e && e.hex >= 0 && near(hexToScreen(e.hex), SIZE * z * 0.5)) return { view: 'surface', kind: 'entrance', hex: e.hex };
    }
    const trails = s.run.surface.trails || [];
    let best = null;
    let bestD = 6;
    for (const tr of trails) {
      if (!tr) continue;
      const dd = distToPolyline(cssX, cssY, trailScreen(tr));
      if (dd <= bestD) {
        bestD = dd;
        best = tr;
      }
    }
    if (best) return { view: 'surface', kind: 'trail', id: best.uid };
    if (hex >= 0) return { view: 'surface', kind: 'hex', hex };
    return null;
  }

  function hexAt(cssX, cssY) {
    const s = S();
    ensureViewport(s);
    curView = camView();
    return pxToHexInRadius(cssX, cssY, curView, radiusOf(s));
  }

  function hexToScreenPub(hex) {
    const s = S();
    ensureViewport(s);
    curView = camView();
    return hexToPx(hex, curView);
  }

  function centerOn(hex) {
    const s = S();
    ensureViewport(s);
    if (hex >= 0 && hex < HEX_COUNT) {
      cam.centerOnHex(hex);
      userMoved = true;
    }
  }

  /**
   * Public locate API (§13.3): a brief expanding highlight ring on a hex (PING_SEC; a steady fading ring with reduced
   * motion). Returns false for a hex outside the map.
   * @param {number} hex
   * @returns {boolean}
   */
  function ping(hex) {
    if (!Number.isInteger(hex) || hex < 0 || hex >= HEX_COUNT) return false;
    pings.push({ hex, start: nowMs() });
    while (pings.length > 6) pings.shift();
    return true;
  }

  function drawPings(ctx) {
    if (!pings.length) return;
    const now = nowMs();
    const dur = PING_SEC * 1000;
    const r = SIZE * curView.zoom;
    for (let k = pings.length - 1; k >= 0; k--) {
      const p = pings[k];
      const age = now - p.start;
      if (age >= dur) {
        pings.splice(k, 1);
        continue;
      }
      if (age < 0) continue;
      const q = hexToScreen(p.hex);
      drawPing(ctx, q.x, q.y, age / dur, { r0: Math.max(6, r * 0.45), r1: Math.max(30, r * 2.2), reduced });
    }
  }

  function setVisible(on) {
    if (on && !visible) weatherFill = true;
    visible = !!on;
  }

  function destroy() {
    destroyed = true;
    for (const off of offs) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    offs.length = 0;
    layer.destroy();
  }

  const api = {
    render, pick, hexAt, hexToScreen: hexToScreenPub, centerOn, ping, setVisible, destroy,
    // WP8-internal extensions
    game, input,
    panBy(dx, dy) {
      ensureViewport(S());
      cam.pan(dx, dy);
      userMoved = true;
    },
    zoomAt(f, x, y) {
      ensureViewport(S());
      cam.zoomAt(f, x, y);
      userMoved = true;
    },
    /** Satellite placement: why `hex` cannot take a satellite (a placeSatellite reason code), or null when it can. */
    satelliteAt(hex) {
      const s = S();
      if (!s || !s.run || !s.run.surface) return 'invalid';
      syncSatellite(s, D());
      if (!Number.isInteger(hex) || hex < 0 || hex >= HEX_COUNT) return 'invalid:hex';
      const why = satCache.reasons[hex];
      return why === undefined ? satCache.global || 'blocked:unowned' : why;
    },
    /** live locate pings (expired ones are dropped) */
    pingCount() {
      const now = nowMs();
      for (let k = pings.length - 1; k >= 0; k--) if (now - pings[k].start >= PING_SEC * 1000) pings.splice(k, 1);
      return pings.length;
    },
    getCamera() {
      return { ...cam.view(), radius: cam.radius, W: layer.cssW, H: layer.cssH };
    },
    trailScreenPolyline(uid) {
      const s = S();
      const tr = s && (s.run.surface.trails || []).find((t) => t && t.uid === uid);
      return tr ? trailScreen(tr) : [];
    },
    entranceAt(hex) {
      const s = S();
      return s ? entranceForOrigin(s, hex) : null;
    },
    get spriteCount() {
      return pool.n;
    },
    /** C123 test / perf probe: live weather counts, the season blend and the last terrain cache build time (ms). */
    getWeather() {
      const d = D();
      return { counts: fxScreen.weatherCounts(), blend: seasonBlend(d && d.season), terrainCaches: terrainCaches.size, terrainBuildMs };
    },
    /** C134 perf / test probe: lane layout build time (ms), the lanes in use and the cached trail curves. */
    getLanes() {
      let shared = 0;
      for (const off of lanes.values()) if (off.some((v) => v !== 0)) shared++;
      return { laneBuildMs, trails: lanes.size, sharedTrails: shared, cachedCurves: trailGeo.size };
    },
    /** C161 / C163 perf / test probe: ambient life state, the smoothed sources-to-objects pass (ms) and the cache resolution. */
    getAmbient() {
      return { on: amb.on, wind: amb.wind, passMs: ambientMs, hiRes, terrainScale: (terrainCaches.values().next().value || {}).scale || 0, landScale: landCache.scale };
    },
  };
  registerRenderer(canvas, api);
  return api;
}

/** Exposed for tests. */
export const SURFACE_BUDGET = BUDGET.above;
/** Particle kinds re-export (tests). */
export const SURFACE_PK = PK;
