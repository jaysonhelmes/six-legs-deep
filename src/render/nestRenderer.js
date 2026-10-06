// Below canvas: the warm soil cross-section, framed as one ant farm. Strata cache (offscreen; smooth depth gradient,
// wavy strata boundaries, flecks/pebbles, roots, stones, water; batched soil painting; dirty-region
// redraws on rev/cellDug/chamber changes) with passages drawn as smooth rounded tubes (dark rims, lit floors) and each
// chamber as one organic cavity (vaulted ceiling, flat floor, a doorway per run of touching passage) → decorative soil
// margins either side → cache hints → chamber set dressing (nestDecor, cached) and contents clipped to the cavity
// (seed piles, brood heaps, fungus domes, hanging repletes, alates…) → frost line → flood → ant sprites (BFS fields;
// the queen on top) → mold spots → labels (level badges, short names where they fit, full name on hover/selection)
// → placement ghost / tool previews → dig-queue progress → overlays → Hungry vignette, raid shaft flash, gate fight
// → camera buttons and the queen chip.
// Default framing keeps the Royal Chamber in view at every layout (camera.frame); the player can zoom and pan. A
// ceremony that moves the view (ceremonyView) hands it back to the default framing when it ends (F20); the public
// locate API glides to a cell (centerOnCell) and rings it (ping).
// Owner: WP8. Contract: ARCHITECTURE §13.3 (createNestRenderer), §13.4–§13.6, §13.8; DESIGN §7, §25.5.
// Reads game.s / game.d / ui only; never writes s. WP8-internal extensions on the returned object: game, input,
// scrollBy(dy), panBy(dx, dy), zoomAt(f, x, y), frameHome(), controlAt(x, y), pressControl(name), getView(),
// ghostAt(cell, tool), ceremonyView(row).

import { GRID, CELL } from '../data/balance.js';
import { LAYER_ORDER, LAYERS, GEOM, DIG } from '../data/strata.js';
import { CHAMBERS, ADJACENCY } from '../data/chambers.js';
import { BROOD } from '../data/economy.js';
import { FLIGHT } from '../data/prestige.js';
import * as nestSys from '../systems/nest.js';
import * as nestgeom from '../systems/nestgeom.js';
import { adultsTotal, broodTotal } from '../core/state.js';
import { bitsDecode } from '../core/save.js';
import { effectsFor } from '../core/effects.js';
import { createLayer, createOffscreen, pageHidden, nowMs, reducedMotion } from './canvas.js';
import { createNestCamera, FRAME_CELL } from './camera.js';
import { pxToCell, clamp, hash01, hash2 } from './geom.js';
import { STRATA, NEST, GRASS_LINE, ANT, CARRY_CODES, mix, shade, rgba, rivalColor, seasonBlend, blendSky, blendSeasonColor } from './palette.js';
import { getAtlas } from './atlas.js';
import * as cosmetics from './cosmetics.js';
import {
  BUDGET, REALLOC_SEC, createPool, reconcile, allocBelow, createFieldCache, stepDown, randomNeighbor, KIND,
  removeSprite,
} from './sprites.js';
import { createParticles } from './particles.js';
import { drawNestOverlays, adjacency as drawAdjacency, layerList, drawPing, PING_SEC } from './overlays.js';
import { drawGateFight } from './battle.js';
import { seamHub } from './seam.js';
import { activeCeremony, drawCeremonyNest, compactInt, registerRenderer } from './ceremony.js';
import { drawNestStrip } from './minimap.js';
import * as art from './nestArt.js';
import * as decor from './nestDecor.js';

const COLS = GRID.cols;
const ROWS = GRID.rows;
const NCELL = COLS * ROWS;
/** C118: cultivated roots are a little greener than wild ones. */
const ROOT_OWN = '#c4d48e';
const ROOT_OWN_DARK = '#8fa35c';
/** C156: the ▲ "upgrade affordable" badge shows from this cell size up (not at overview zoom) and refreshes this often. */
const UP_MIN_CELL = 12;
const UP_REFRESH_MS = 500;
/** C117 / C118: short ghost labels for refused pocket moves and root columns. */
const REASON_SHORT = Object.freeze({ 'blocked:water': 'Water in the way', 'blocked:stone': 'Stone in the way', 'blocked:open': 'Needs plain soil',
  'blocked:chamber': 'Chamber in the way', 'blocked:cache': 'Something is buried here', 'blocked:queued': 'Queued for digging',
  'blocked:backfill': 'Being backfilled', 'invalid:row': 'Too far from the pocket', 'invalid:bounds': 'Off the grid',
  'blocked:royalRoom': 'Would wall in the queen', 'blocked:route': 'No tunnel reaches it', queueFull: 'Dig queue full', hardship: 'Too deep',
  'invalid:root': 'A root grows here already', 'blocked:shaft': 'Shaft column', blocked: 'Top cell blocked', max: 'Root limit reached',
  cantAfford: 'Cannot afford', locked: 'Needs research', busy: 'Already moving',
  'blocked:disconnect': 'Filling these tunnels cuts a chamber off', 'blocked:reserved': 'Reserved for a chamber' });
const STAGES = (BROOD && BROOD.stages) || [0.25, 0.75];
const MAX_BROOD_SPRITES = 30;
const FROST_IMMUNE_FALLBACK = new Set(['royal_chamber', 'gate', 'thermal_chimney']);
/** Strata cache resolutions (device px per cell); the cache is redrawn only when the bucket changes. */
const CPP_STEPS = [6, 8, 10, 12, 14, 16, 18, 20, 24, 28];
/** Decorative soil columns cached either side of the grid (mirrored beyond that). */
const MARGIN_COLS = 24;
/** Tallest mound above the surface line, in cells (the camera shows 2 rows of sky at most: camera topRow −2). */
const MOUND_MAX_CELLS = 1.7;
/** Passage rim thickness and the floor-light inset (cell units). */
const RIM = 0.11;
/** Doorway bits (geo.door): from a cell toward its left / right / upper / lower neighbour. */
const DOOR = Object.freeze({ L: 1, R: 2, U: 4, D: 8 });
/** On-canvas camera buttons (top-right): zoom out, zoom in, frame the queen. */
const CONTROLS = Object.freeze(['out', 'in', 'home']);
/** Camera glide (centerOnCell, the re-frame after a ceremony) in seconds; reduced motion jumps instead. */
const GLIDE_SEC = 0.45;
/** A centerOnCell goal is re-applied on viewport changes for this long (the view is often switched in a frame later). */
const GOAL_HOLD_MS = 1500;
/** At most this many pings at once (oldest dropped). */
const PING_MAX = 6;

/** Sprite behaviour states (Below). */
const ST = Object.freeze({ GO: 0, WORK: 1, AWAY: 2, WANDER: 3, IDLE: 4 });

/**
 * C181: stone colour per stratum (mixed into NEST.stone): warm grey-brown flint near the top, rust-banded ironstone in
 * clay, pale speckled granite in gravel, dark blue-grey slate in bedrock, wet blue-green rock in the aquifer.
 */
const STONE_TINT = Object.freeze({ topsoil: '#8a7a68', loam: '#86745f', clay: '#946250', gravel: '#9a9890', bedrock: '#4c5266',
  aquifer: '#4f6a72' });

/** Row → layer id (data/strata.js when present, else the fallback rows). */
let LAYER_AT = null;
function layerAt(y) {
  if (!LAYER_AT) {
    LAYER_AT = new Array(ROWS).fill('topsoil');
    const list = LAYER_ORDER.map((id) => LAYERS[id]).filter(Boolean);
    for (const L of list) for (let r = Math.max(0, L.y0); r <= Math.min(ROWS - 1, L.y1); r++) LAYER_AT[r] = L.id;
  }
  return LAYER_AT[clamp(y | 0, 0, ROWS - 1)];
}

/** Display name of a chamber type. */
/**
 * An adjacency link (nest.chamberLinks / validatePlacement links) as a short canvas label (C109):
 * "+15% brood speed (next to Royal Chamber)", "Nursery: +15% brood speed"; lost links prefix "Lost: ".
 * @param {{ rule: string, partner: string, text: string, receiver: string }} l
 * @param {boolean} [lost=false]
 * @returns {string}
 */
export function linkLabel(l, lost = false) {
  if (!l) return '';
  const r = (ADJACENCY && ADJACENCY[l.rule]) || { path: 4 };
  const near = (Number(r.path) || 4) <= ((GEOM && GEOM.adjPathMax) || 4) ? 'next to' : 'within ' + r.path + ' cells of';
  const name = l.partner === 'entrance' ? 'an entrance' : chamberName(l.partner);
  const t = l.receiver === 'partner' ? name + ': ' + l.text : l.text + ' (' + near + ' ' + name + ')';
  return lost ? 'Lost: ' + t : t;
}

export function chamberName(type) {
  const def = CHAMBERS && CHAMBERS[type];
  if (def && def.name) return def.name;
  return String(type || '').split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** Short reason text for the red ghost label (render-local; full copy lives in ui/text.js). */
export function reasonLabel(reason) {
  if (!reason) return '';
  const [code, detail] = String(reason).split(':');
  const base = {
    cantAfford: "Can't afford", blocked: 'Blocked', invalid: 'Invalid spot', max: 'Max reached', locked: 'Locked',
    queueFull: 'Dig queue full', noSlot: 'No room', requirements: 'Requirements not met', hardship: 'Hardship rule',
    busy: 'Busy', notFound: 'Not found', paused: 'Paused', unknown: 'Unavailable', cooldown: 'Cooling down',
  }[code] || code;
  return detail ? `${base}: ${detail}` : base;
}

/** Placement-ghost refusal copy for rule reasons (C99; the Build panel lists the same rules, ui/text.js). */
const GHOST_RULE_TEXT = Object.freeze({
  'invalid:root': 'Must touch a root',
  // C137: reservations
  'blocked:reserved': 'Reserved for another chamber',
  'resv:chamber': 'Full size overlaps a chamber (F: other corner)',
  'resv:reserved': 'Full size overlaps a reserved space (F: other corner)',
  'resv:bounds': 'Full size does not fit here (F: other corner)',
  'resv:row': 'Full size breaks the depth rule (F: other corner)',
  'resv:shaft': 'Full size covers a shaft entrance (F: other corner)',
  'resv:hardship': 'Full size goes too deep for this Hardship',
  'invalid:row0': 'Must touch the surface (row 0)',
  'invalid:shaft': 'Must sit beside an entrance shaft',
  'invalid:water': 'Must touch a revealed water pocket no other Well uses',
  'invalid:bounds': 'Does not fit inside the nest',
  'blocked:shaft': 'A shaft is in the way',
  'blocked:route': 'No tunnel route reaches it',
  'blocked:chamber': 'Another chamber is in the way',
  'blocked:stone': 'Stone in the way',
  'blocked:water': 'Water in the way',
  'blocked:layer': 'That layer is closed',
  'blocked:queued': 'Already queued for digging',
  'blocked:backfill': 'Being backfilled',
});

/**
 * Ghost refusal line (C99): the row rule with its numbers ("Must be at depth 24 or deeper (you are at 17)"), the
 * other placement rules in words, anything else as the generic reason label.
 * @param {{ reason?: string, rows?: { min: number, max: number }, rect?: { y: number, h: number } }} res PlacementResult
 * @returns {string}
 */
export function ghostRefusal(res) {
  const reason = res && res.reason;
  if (!reason) return '';
  if (reason === 'invalid:row' && res.rows && res.rect) {
    const top = res.rect.y;
    const bot = res.rect.y + res.rect.h - 1;
    if (top < res.rows.min) return `Must be at depth ${res.rows.min} or deeper (you are at ${top})`;
    if (bot > res.rows.max) return `Must stay within rows ${res.rows.min}–${res.rows.max} (you reach ${bot})`;
  }
  return GHOST_RULE_TEXT[reason] || reasonLabel(reason);
}

/** Rounded-rect path with per-corner radii (tl, tr, br, bl). */
function rrect(g, x, y, w, h, tl, tr, br, bl) {
  g.beginPath();
  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  if (tr) g.arcTo(x + w, y, x + w, y + tr, tr);
  else g.lineTo(x + w, y);
  g.lineTo(x + w, y + h - br);
  if (br) g.arcTo(x + w, y + h, x + w - br, y + h, br);
  else g.lineTo(x + w, y + h);
  g.lineTo(x + bl, y + h);
  if (bl) g.arcTo(x, y + h, x, y + h - bl, bl);
  else g.lineTo(x, y + h);
  g.lineTo(x, y + tl);
  if (tl) g.arcTo(x, y, x + tl, y, tl);
  else g.lineTo(x, y);
  g.closePath();
}

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

/** Decode a "rle:v*n,v" string (StrataRecord.cells) into a number array (render-private copy of the codec rule). */
export function decodeRle(str) {
  if (Array.isArray(str)) return str;
  if (typeof str !== 'string') return [];
  // Strata silhouettes are packed open-cell masks since F26 (core/save bitsEncode); open cells decode as tunnels.
  if (str.startsWith('bits:')) return bitsDecode(str, NCELL, CELL.TUNNEL, CELL.SOIL);
  const body = str.startsWith('rle:') ? str.slice(4) : str;
  if (!body) return [];
  const out = [];
  for (const part of body.split(',')) {
    const star = part.indexOf('*');
    const v = Number(star >= 0 ? part.slice(0, star) : part);
    const n = star >= 0 ? Number(part.slice(star + 1)) : 1;
    if (!Number.isFinite(v) || !(n > 0)) continue;
    for (let k = 0; k < n && out.length < NCELL; k++) out.push(v);
  }
  return out;
}

/**
 * Create the Below renderer.
 * @param {HTMLCanvasElement} canvas
 * @param {{ game: any, ui: any, bus: any, strip?: HTMLCanvasElement|null }} opts
 */
export function createNestRenderer(canvas, { game, ui, bus, strip = null } = {}) {
  const cam = createNestCamera();
  let layerVersion = -1;
  const layer = createLayer(canvas, { maxDpr: 2 });
  const atlas = getAtlas();
  const fields = createFieldCache();
  const pool = createPool(BUDGET.below);
  const fx = createParticles(220);
  const hub = seamHub(game);

  let visible = true;
  let destroyed = false;
  let time = 0;
  let lastS = null;
  let reallocIn = 0;
  let K = 1;
  let queenPulse = 0;
  let reduced = false;
  let reducedAt = -1;
  let rectCache = null;
  let rectAt = -1e9;
  let stripKey = '';
  let stripAt = -1e9;
  /** true once the player scrolled, panned or zoomed: until then every viewport change re-applies the default framing */
  let userMoved = false;
  /** camera glide between two camera states (wall clock, so it also completes while the view is hidden); null = none */
  let glide = null;
  /** a ceremony moved the view (ceremonyView): when it ends the default framing returns, unless the player moved the camera */
  let ceremonyHold = false;
  /** last centerOnCell goal { cell, until }: re-applied when the viewport changes shortly after the call */
  let goal = null;
  /** locate pings { i, start } (start in nowMs()) */
  const pings = [];
  /** wanted strata-cache resolution (applied after the zoom settles) */
  let cppWant = 0;
  let cppWantAt = 0;
  /** frame counter, and the last frame that redrew most of the strata cache (the margin rebuild waits a frame) */
  let frameNo = 0;
  let heavyAt = -9;

  /** strata cache */
  const cache = { canvas: null, ctx: null, cpp: 0, drawn: new Int8Array(NCELL).fill(-9), rev: -1, cellsRef: null, waterKey: '',
    rootsKey: '', roots: new Uint8Array(NCELL), rootOwn: new Uint8Array(NCELL), water: new Uint8Array(NCELL), pristine: null,
    // C181: each boulder's identity (lowest cell index of its 8-connected stone group + 1), for its own tint and grain
    stoneKey: '', stoneId: new Int16Array(NCELL),
    featRev: -1, featRef: null, featCpp: 0, force: new Uint8Array(NCELL), grad: null, chamberKeys: new Map() };
  /** decorative soil either side of the grid */
  const margin = { canvas: null, ctx: null, cpm: 0 };
  /** chamber geometry rebuilt on rev change */
  const geo = { rev: -1, cellsRef: null, at: new Int16Array(NCELL).fill(-1), cells: [], shaftCells: new Uint8Array(NCELL), passCells: new Uint8Array(NCELL), tops: [],
    hints: [], hintsKey: '', chambersRef: null, door: new Uint8Array(NCELL), full: [], shape: [], sig: 0 };
  const glows = []; // { uid, t, max }
  const ghostMemo = { key: '', res: null };
  const levelMemo = { key: '', res: null };
  /** C109: adjacency links per chamber uid (nest.chamberLinks), rebuilt when the nest changes */
  const linkMemo = { key: '', map: new Map() };
  /** C156: affordable-upgrade uids (affordableSet) */
  const upMemo = { t: -Infinity, rev: -1, set: null };
  /** per-chamber static decoration cache (nestDecor.js), at the strata-cache resolution */
  const decorCache = decor.createDecorCache();

  /** Preview channel written by nestInput.js (WP8-internal). ctlHover: hovered camera button. */
  const input = { hoverCell: -1, drag: null, rect: null, levelDir: null, pointer: null, ctlHover: null };

  const offs = [];
  function sub(type, fn) {
    if (bus && typeof bus.on === 'function') offs.push(bus.on(type, fn));
  }
  sub('cellDug', (e) => {
    if (!e || !(e.i >= 0)) return;
    const p = cellCenter(e.i);
    if (!reduced) fx.dust(p.x, p.y, 5, (STRATA[layerAt(Math.floor(e.i / COLS))] || STRATA.loam).fleck);
  });
  sub('eggLaid', () => {
    queenPulse = 0.45;
  });
  sub('chamberActivated', (e) => {
    if (!e) return;
    glows.push({ uid: e.uid, t: 0, max: 1.8 });
    const c = chamberByUid(e.uid);
    if (c) {
      const r = chamberRectPx(c);
      fx.ripple(r.x + r.w / 2, r.y + r.h / 2, '#ffe08a', 50, 1.1);
      if (!reduced) fx.sparkle(r.x + r.w / 2, r.y + r.h / 2, 10, 26);
    }
  });
  sub('chamberLeveled', (e) => {
    if (e) glows.push({ uid: e.uid, t: 0, max: 0.9 });
  });
  sub('cacheFound', (e) => {
    if (!e || !(e.i >= 0)) return;
    const p = cellCenter(e.i);
    fx.sparkle(p.x, p.y, 12, 30);
    if (Number.isFinite(e.amount) && e.amount > 0) fx.float(p.x, p.y - 8, `+${compactInt(e.amount)} ${e.res || ''}`.trim());
  });
  sub('entranceOpened', (e) => {
    if (!e || !(e.col >= 0)) return;
    const p = cellCenter(e.col);
    fx.sparkle(p.x, p.y, 10, 24);
  });
  for (const t of ['runStarted', 'supercolonyComplete', 'speciationComplete', 'reset', 'imported']) sub(t, () => dropCaches());

  // ---------------------------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------------------------

  function S() {
    return game && game.s ? game.s : null;
  }
  function D() {
    return game && game.d ? game.d : null;
  }
  function view() {
    return cam.view();
  }
  function cellCenter(i) {
    const v = view();
    return { x: v.ox + ((i % COLS) + 0.5) * v.cell, y: v.oy + (Math.floor(i / COLS) + 0.5) * v.cell };
  }
  function chamberByUid(uid) {
    const s = S();
    const list = (s && s.run && s.run.nest && s.run.nest.chambers) || [];
    for (const c of list) if (c && c.uid === uid) return c;
    return null;
  }
  function chamberRectPx(c) {
    const v = view();
    return { x: v.ox + c.x * v.cell, y: v.oy + c.y * v.cell, w: c.w * v.cell, h: c.h * v.cell };
  }
  function chamberCenter(c) {
    const r = chamberRectPx(c);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  function dropCaches() {
    cache.drawn.fill(-9);
    cache.rev = -1;
    cache.cellsRef = null;
    cache.rootsKey = '';
    cache.waterKey = '';
    cache.pristine = null;
    cache.featRev = -1;
    cache.featRef = null;
    cache.chamberKeys.clear();
    decorCache.clear();
    cache.force.fill(0);
    geo.rev = -1;
    geo.cellsRef = null;
    fields.rev = -1;
    pool.n = 0;
    fx.clear();
    glows.length = 0;
    ghostMemo.key = '';
    levelMemo.key = '';
    reallocIn = 0;
    hub.clear();
    // a new run / reset / import: back to the default framing on the next viewport check (F20). A ceremony that has
    // just moved the view (ceremonyView, called before this on speciationComplete) keeps it until it ends.
    userMoved = false;
    layerVersion = -1;
    glide = null;
    goal = null;
    pings.length = 0;
  }

  function ensureViewport() {
    if (layer.version !== layerVersion || cam.w !== layer.cssW || cam.h !== layer.cssH) {
      layerVersion = layer.version;
      glide = null;
      cam.setViewport(layer.cssW, layer.cssH);
      if (layer.cssW > 0 && layer.cssH > 0) {
        if (goal && !cam.inset && nowMs() < goal.until) {
          // a locate request made just before the view was switched in: centre it at the real size
          applyGoal(goal);
        } else if (ceremonyHold && !cam.inset) {
          // keep the ceremony's view (setViewport kept its centre row)
        } else if (cam.inset || !userMoved) {
          // default framing (the Royal Chamber in view) at boot, on first show and after layout changes, until the
          // player moves the camera themselves
          focusRoyal();
          demoKey = '';
        }
      }
    }
    // F20: when the ceremony that moved the view has ended, glide back to the colony (the player's own camera wins)
    if (ceremonyHold && !activeCeremony()) {
      ceremonyHold = false;
      if (!userMoved && layer.cssW > 0 && layer.cssH > 0) glideTo(focusRoyal);
    }
    stepGlide();
  }

  /** Camera state as { zoom, cx, cy } (cy = the fractional grid row at the vertical centre of the view). */
  function camState() {
    return { zoom: cam.zoom, cx: cam.cx, cy: cam.cell > 0 ? (cam.scroll + cam.h / 2) / cam.cell - cam.skyCells : 0 };
  }

  function applyCamState(st) {
    if (!cam.inset) {
      cam.zoom = st.zoom;
      cam.cell = cam.fit * st.zoom;
    }
    cam.cx = st.cx;
    cam.scroll = (st.cy + cam.skyCells) * cam.cell - cam.h / 2;
    cam.clamp();
  }

  /**
   * Move the camera with `apply` (a function that sets the goal framing on `cam`), then glide there from the current
   * framing over GLIDE_SEC. Reduced motion (or a negligible move) jumps straight to the goal.
   * @param {() => void} apply
   */
  function glideTo(apply) {
    glide = null;
    const from = camState();
    apply();
    const to = camState();
    const far = Math.abs(Math.log(to.zoom / from.zoom)) > 0.01 || Math.abs(to.cy - from.cy) > 0.05 || Math.abs(to.cx - from.cx) > 0.05;
    if (!far || reducedMotion(S()) || !(cam.h > 0)) return;
    applyCamState(from);
    glide = { t0: nowMs(), dur: GLIDE_SEC * 1000, from, to };
  }

  /** Advance the glide to the current wall-clock time (smoothstep; zoom interpolated geometrically). */
  function stepGlide() {
    if (!glide) return;
    const u = clamp((nowMs() - glide.t0) / glide.dur, 0, 1);
    const e = u * u * (3 - 2 * u);
    const f = glide.from;
    const t = glide.to;
    const z = f.zoom > 0 && t.zoom > 0 ? f.zoom * Math.pow(t.zoom / f.zoom, e) : t.zoom;
    applyCamState({ zoom: z, cx: f.cx + (t.cx - f.cx) * e, cy: f.cy + (t.cy - f.cy) * e });
    if (u >= 1) glide = null;
  }

  /** Wall-clock time at which the current glide arrives (now when there is none). */
  function glideEnd() {
    return glide ? glide.t0 + glide.dur : nowMs();
  }

  /**
   * Frame a locate goal. { row } (scrollToRow): that row at the top. { cell } (centerOnCell): at least FRAME_CELL px
   * per cell (zooming in only), the cell at the view centre.
   */
  function applyGoal(g) {
    if (!Number.isInteger(g.cell)) {
      if (Number.isFinite(g.row)) cam.scrollToRow(g.row);
      return;
    }
    const x = g.cell % COLS;
    const y = Math.floor(g.cell / COLS);
    if (!cam.inset && cam.cell < FRAME_CELL && cam.fit > 0) {
      cam.zoom = clamp(FRAME_CELL / cam.fit, cam.zoomMin(), cam.zoomMax());
      cam.cell = cam.fit * cam.zoom;
    }
    cam.centerOnCell(x, y);
  }

  /** The player took the camera: cancel any glide or pending locate goal. */
  function playerCamera() {
    glide = null;
    goal = null;
    userMoved = true;
  }

  /** The Royal Chamber's footprint (live state, else the default grid position). */
  function royalRect() {
    const s = S();
    const list = (s && s.run && s.run.nest && s.run.nest.chambers) || [];
    for (const c of list) if (c && c.type === 'royal_chamber') return c;
    return GRID.royal;
  }

  /**
   * The onboarding chamber demo (uistate.ghostDemo) must be on screen: if its target row is out of view and the
   * player has not moved the camera, scroll once to show it (with the Royal Chamber when both fit).
   */
  let demoKey = '';
  function revealDemo() {
    const demo = uiOf(ui).ghostDemo;
    if (!demo || demo.kind !== 'chamber' || !Number.isFinite(demo.to) || cam.inset) {
      demoKey = '';
      return;
    }
    const key = String(demo.to);
    if (key === demoKey) return;
    demoKey = key;
    if (userMoved) return;
    const row = Math.floor(demo.to / COLS);
    const top = cam.topRow();
    const vr = cam.viewRows();
    if (row >= top + 1 && row + 3 <= top + vr - 0.5) return;
    const r = royalRect();
    const lo = Math.min(row, r.y);
    const hi = Math.max(row + 3, r.y + r.h);
    cam.centerOnRow(hi - lo + 2 <= vr ? (lo + hi) / 2 - 0.5 : row + 1);
  }

  /** Default framing: the Royal Chamber in view, the sky down to the deepest chamber when that fits. */
  function focusRoyal() {
    const s = S();
    const list = (s && s.run && s.run.nest && s.run.nest.chambers) || [];
    let deepest = 0;
    for (const c of list) if (c && c.y + c.h > deepest) deepest = c.y + c.h;
    cam.frame(royalRect(), deepest);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // geometry (chamber map, shafts, hints)
  // ---------------------------------------------------------------------------------------------------------------

  /** Cheap signature of the chamber footprints (level-ups can change w/h without a grid rev). */
  function chamberSig(chs) {
    let h = chs ? chs.length : 0;
    for (let k = 0; chs && k < chs.length; k++) {
      const c = chs[k];
      if (c) h = (Math.imul(h, 31) + c.uid * 13 + c.x * 7 + c.y * 5 + c.w * 3 + c.h + (c.status === 'active' ? 1 : 2) * 977) | 0;
    }
    return h;
  }

  function syncGeo(s) {
    const nest = s.run.nest;
    const sig = chamberSig(nest.chambers);
    if (geo.rev === nest.rev && geo.cellsRef === nest.cells && geo.chambersRef === nest.chambers && geo.sig === sig) return;
    geo.rev = nest.rev;
    geo.sig = sig;
    geo.cellsRef = nest.cells;
    geo.chambersRef = nest.chambers;
    geo.at.fill(-1);
    geo.cells = [];
    const chs = nest.chambers || [];
    for (let k = 0; k < chs.length; k++) {
      const c = chs[k];
      const list = [];
      if (c) {
        for (let y = c.y; y < c.y + c.h; y++) {
          for (let x = c.x; x < c.x + c.w; x++) {
            if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
            const i = y * COLS + x;
            geo.at[i] = k;
            if (fields.open[i]) list.push(i);
          }
        }
      }
      geo.cells.push(list);
    }
    geo.shaftCells.fill(0);
    geo.passCells.fill(0);
    geo.tops = [];
    const shafts = nest.shafts && nest.shafts.length ? nest.shafts : [{ kind: 'main', col: GRID.mainCol, open: true }];
    for (const sh of shafts) {
      if (!sh || !(sh.col >= 0) || sh.col >= COLS) continue;
      // C125: the shaft passes through chambers that cover it (down to its recorded bottom row sh.thru)
      const thru = Number.isInteger(sh.thru) ? sh.thru : -1;
      for (let y = 0; y < ROWS; y++) {
        const i = y * COLS + sh.col;
        if (!fields.open[i]) break;
        if (geo.at[i] >= 0) {
          if (y > thru) break;
          geo.passCells[i] = 1;
          continue;
        }
        geo.shaftCells[i] = 1;
      }
      if (fields.open[sh.col]) geo.tops.push({ col: sh.col, kind: sh.kind, i: sh.col });
    }
    if (!geo.tops.length && fields.open[GRID.mainCol]) geo.tops.push({ col: GRID.mainCol, kind: 'main', i: GRID.mainCol });
    geo.hintsKey = '';
    syncDoors(chs);
  }

  /**
   * Doorways: where open cells outside a chamber touch its footprint, one opening per contiguous run (in its middle)
   * is cut through the cavity wall, so tunnels running alongside a chamber read as passing it, not merging into it.
   * Also records which chambers are fully dug (drawn as one organic cavity) and forces a strata redraw of any chamber
   * whose footprint, completion or doorways changed.
   */
  function syncDoors(chs) {
    geo.door.fill(0);
    geo.full = [];
    geo.shape = chs.map((c) => (c ? art.cavityShape(c) : null));
    const open = fields.open;
    const keys = new Map();
    for (let k = 0; k < chs.length; k++) {
      const c = chs[k];
      if (!c) {
        geo.full.push(false);
        continue;
      }
      geo.full.push((geo.cells[k] || []).length >= c.w * c.h);
      const doors = [];
      // [inside dx, inside dy] start, step along the side, outside offset, bit inside→outside, bit outside→inside
      const sides = [
        [c.x, c.y, 0, 1, -1, 0, DOOR.L, DOOR.R, c.h],
        [c.x + c.w - 1, c.y, 0, 1, 1, 0, DOOR.R, DOOR.L, c.h],
        [c.x, c.y, 1, 0, 0, -1, DOOR.U, DOOR.D, c.w],
        [c.x, c.y + c.h - 1, 1, 0, 0, 1, DOOR.D, DOOR.U, c.w],
      ];
      for (const [sx, sy, stx, sty, ox, oy, bIn, bOut, len] of sides) {
        let run = [];
        let runRegion = -2;
        const flush = () => {
          if (run.length) {
            const [a, b] = run[(run.length - 1) >> 1];
            geo.door[a] |= bIn;
            geo.door[b] |= bOut;
            doors.push(a);
          }
          run = [];
          runRegion = -2;
        };
        for (let t = 0; t < len; t++) {
          const ix = sx + stx * t;
          const iy = sy + sty * t;
          const xx = ix + ox;
          const yy = iy + oy;
          if (ix < 0 || iy < 0 || ix >= COLS || iy >= ROWS || xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) {
            flush();
            continue;
          }
          const a = iy * COLS + ix;
          const b = yy * COLS + xx;
          const region = geo.at[b];
          if (!open[a] || !open[b] || region === k) {
            flush();
            continue;
          }
          if (region !== runRegion) flush();
          runRegion = region;
          run.push([a, b]);
        }
        flush();
      }
      keys.set(c.uid, { key: `${c.x},${c.y},${c.w},${c.h},${geo.full[k] ? 1 : 0},${doors.join('.')}`, c });
    }
    // force-redraw chambers whose geometry changed (old and new footprints, plus the rim ring)
    const markRect = (c) => {
      for (let y = c.y - 1; y <= c.y + c.h; y++) {
        for (let x = c.x - 1; x <= c.x + c.w; x++) if (x >= 0 && y >= 0 && x < COLS && y < ROWS) cache.force[y * COLS + x] = 1;
      }
    };
    for (const [uid, v] of keys) {
      const old = cache.chamberKeys.get(uid);
      if (!old || old.key !== v.key) {
        markRect(v.c);
        if (old) markRect(old.c);
      }
    }
    for (const [uid, old] of cache.chamberKeys) if (!keys.has(uid)) markRect(old.c);
    cache.chamberKeys = new Map([...keys].map(([uid, v]) => [uid, { key: v.key, c: { x: v.c.x, y: v.c.y, w: v.c.w, h: v.c.h } }]));
  }

  /** Cache hint cells: d.nest.hints when filled, else unfound caches that are hinted or within the hint radius. */
  function hintCells(s, d) {
    const dh = d && d.nest && Array.isArray(d.nest.hints) ? d.nest.hints : null;
    if (dh && dh.length) return dh;
    const caches = (s.run.nest.features && s.run.nest.features.caches) || [];
    const key = `${geo.rev}|${caches.length}|${caches.filter((c) => c && c.found).length}`;
    if (key === geo.hintsKey) return geo.hints;
    geo.hintsKey = key;
    const R = (GEOM && GEOM.hintRadius) || 4;
    const out = [];
    for (const c of caches) {
      if (!c || c.found || !(c.i >= 0)) continue;
      if (c.hinted) {
        out.push(c.i);
        continue;
      }
      const cx = c.i % COLS;
      const cy = Math.floor(c.i / COLS);
      let near = false;
      for (let y = Math.max(0, cy - R); y <= Math.min(ROWS - 1, cy + R) && !near; y++) {
        for (let x = Math.max(0, cx - R); x <= Math.min(COLS - 1, cx + R); x++) {
          if (fields.open[y * COLS + x]) {
            near = true;
            break;
          }
        }
      }
      if (near) out.push(c.i);
    }
    geo.hints = out;
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // strata cache
  // ---------------------------------------------------------------------------------------------------------------

  /** Cache resolution bucket for the current zoom (device px per cell). */
  function cppFor(cell) {
    const want = cell * layer.dpr;
    for (const c of CPP_STEPS) if (c >= want - 0.5) return c;
    return CPP_STEPS[CPP_STEPS.length - 1];
  }

  function syncCacheSize() {
    const cpp = cppFor(cam.cell);
    if (cache.canvas && cache.cpp === cpp) return;
    // while the player is zooming keep drawing the old cache scaled; rebuild once the zoom has settled
    if (cache.canvas) {
      const now = nowMs();
      if (cpp !== cppWant) {
        cppWant = cpp;
        cppWantAt = now;
        return;
      }
      if (now - cppWantAt < 220) return;
    }
    const off = createOffscreen(COLS * cpp, ROWS * cpp);
    cache.canvas = off.canvas;
    cache.ctx = off.ctx;
    cache.cpp = cpp;
    cache.grad = null;
    cache.drawn.fill(-9);
    cache.pristine = null;
  }

  function syncFeatures(s) {
    const f = s.run.nest.features || {};
    // features only change with the grid (reveals happen when a cell is dug, rev++) or with a new run / prestige
    // (C127: past runs' Strata silhouettes are no longer drawn in the bedrock band; the Colony History gallery shows them)
    if (cache.featRev === s.run.nest.rev && cache.featRef === f && cache.featCpp === cache.cpp) return;
    cache.featRev = s.run.nest.rev;
    cache.featRef = f;
    cache.featCpp = cache.cpp;
    const roots = f.roots || [];
    const rk = roots.map((r) => `${r.col},${r.y0},${r.y1}${r.own ? 'c' : ''}`).join(';');
    if (rk !== cache.rootsKey) {
      cache.rootsKey = rk;
      cache.roots.fill(0);
      cache.rootOwn.fill(0);
      for (const r of roots) {
        if (!r || !(r.col >= 0) || r.col >= COLS) continue;
        const y0 = Math.max(0, r.y0);
        const y1 = Math.min(ROWS - 1, r.y1);
        // store the remaining thickness (255 at the top → ~40 at the tip) so the root tapers with depth
        for (let y = y0; y <= y1; y++) cache.roots[y * COLS + r.col] = Math.round(255 - 215 * ((y - y0) / Math.max(1, y1 - y0 + 1)));
        // C118: cultivated roots are drawn a little greener
        if (r.own) for (let y = y0; y <= y1; y++) cache.rootOwn[y * COLS + r.col] = 1;
      }
      cache.drawn.fill(-9);
    }
    syncStones(s);
    const water = f.water || [];
    const wk = water.map((w) => `${w.x},${w.y},${w.w},${w.h},${w.revealed ? 1 : 0}`).join(';');
    if (wk !== cache.waterKey) {
      const before = cache.water.slice();
      cache.waterKey = wk;
      cache.water.fill(0);
      for (const w of water) {
        if (!w || !w.revealed) continue;
        for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) if (x >= 0 && y >= 0 && x < COLS && y < ROWS) cache.water[y * COLS + x] = 1;
      }
      for (let i = 0; i < NCELL; i++) if (before[i] !== cache.water[i]) cache.drawn[i] = -9;
    }
  }

  /** C181: boulder identities (8-connected stone groups) when the stone cells change. */
  function syncStones(s) {
    const cells = s.run.nest.cells || [];
    let n = 0;
    let sum = 0;
    for (let i = 0; i < NCELL; i++) if (cells[i] === CELL.STONE) { n++; sum = (sum * 31 + i) % 1000003; }
    const key = n + ':' + sum;
    if (key === cache.stoneKey) return;
    cache.stoneKey = key;
    const id = cache.stoneId;
    id.fill(0);
    for (let i = 0; i < NCELL; i++) {
      if (cells[i] !== CELL.STONE || id[i]) continue;
      const st = [i];
      id[i] = i + 1;
      while (st.length) {
        const c = st.pop();
        const x = c % COLS;
        const y = (c / COLS) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) continue;
          const k = yy * COLS + xx;
          if (!id[k] && cells[k] === CELL.STONE) { id[k] = i + 1; st.push(k); }
        }
      }
    }
    for (let i = 0; i < NCELL; i++) if (id[i]) cache.drawn[i] = -9;
  }

  function codeAt(cells, i) {
    if (!cells || i < 0 || i >= NCELL) return CELL.SOIL;
    const c = cells[i];
    return Number.isFinite(c) ? c : CELL.SOIL;
  }

  function isOpenCode(c) {
    return c === CELL.TUNNEL || c === CELL.CHAMBER;
  }

  /** Vertical soil gradient for a canvas of `cs` px per cell: smooth darkening with depth, hard steps between strata. */
  function soilGradient(g, cs) {
    const grad = g.createLinearGradient(0, 0, 0, ROWS * cs);
    for (const L of layerList()) {
      const P = STRATA[L.id] || STRATA.loam;
      const a = clamp(L.y0 / ROWS, 0, 1);
      const b = clamp((L.y1 + 1) / ROWS, 0, 1);
      grad.addColorStop(a, P.base);
      grad.addColorStop(Math.max(a, b - 0.0005), mix(P.base, P.dark, 0.38));
    }
    return grad;
  }

  /** Passage colours per stratum (memoised). */
  const cavMemo = {};
  function cavCols(y) {
    const lid = layerAt(y);
    let c = cavMemo[lid];
    if (!c) {
      const P = STRATA[lid] || STRATA.loam;
      c = {
        rim: mix(P.dark, '#000000', 0.5),
        cav: mix(P.cavity, P.base, 0.14),
        floor: mix(P.cavity, P.base, 0.36),
        top: mix(P.cavity, '#000000', 0.15),
        mid: mix(P.cavity, P.base, 0.26),
        chFloor: mix(mix(P.base, NEST.chamberFloor, 0.35), '#000000', 0.32),
        dust: mix(mix(P.base, NEST.chamberFloor, 0.4), '#000000', 0.12),
      };
      cavMemo[lid] = c;
    }
    return c;
  }

  /** Per-stratum texture colours (memoised strings: no per-cell colour parsing). */
  const texMemo = {};
  function texCols(lid) {
    let t = texMemo[lid];
    if (!t) {
      const P = STRATA[lid] || STRATA.loam;
      t = {
        fleck: rgba(P.fleck, 0.5), dark: rgba(P.dark, 0.55), pebble: mix(P.light, '#9d907c', 0.55),
        streak: rgba(P.light, 0.45), waveTop: P.base, waveBottom: mix(P.base, P.dark, 0.38),
      };
      texMemo[lid] = t;
    }
    return t;
  }

  /** Batched draw lists keyed by style: { style, kind: 'rect'|'ell'|'quad'|'poly'|'line', lw, a: number[] }. */
  function bucket(B, key, style, kind, lw = 1) {
    let b = B.get(key);
    if (!b) {
      b = { style, kind, lw, a: [] };
      B.set(key, b);
    }
    return b.a;
  }

  function flushBuckets(g, B) {
    for (const b of B.values()) {
      const a = b.a;
      if (!a.length) continue;
      g.beginPath();
      if (b.kind === 'rect') {
        for (let k = 0; k < a.length; k += 4) g.rect(a[k], a[k + 1], a[k + 2], a[k + 3]);
      } else if (b.kind === 'ell') {
        for (let k = 0; k < a.length; k += 5) {
          g.moveTo(a[k] + a[k + 2], a[k + 1]);
          g.ellipse(a[k], a[k + 1], a[k + 2], a[k + 3], a[k + 4], 0, Math.PI * 2);
        }
      } else if (b.kind === 'quad') {
        for (let k = 0; k < a.length; k += 6) {
          g.moveTo(a[k], a[k + 1]);
          g.quadraticCurveTo(a[k + 2], a[k + 3], a[k + 4], a[k + 5]);
        }
      } else if (b.kind === 'line') {
        for (let k = 0; k < a.length; k += 6) {
          g.moveTo(a[k], a[k + 1]);
          g.lineTo(a[k + 2], a[k + 3]);
          g.lineTo(a[k + 4], a[k + 5]);
        }
      } else if (b.kind === 'poly') {
        // fixed 7-point polygons (wavy strata slivers)
        for (let k = 0; k < a.length; k += 14) {
          g.moveTo(a[k], a[k + 1]);
          for (let j = 2; j < 14; j += 2) g.lineTo(a[k + j], a[k + j + 1]);
          g.closePath();
        }
      }
      if (b.kind === 'quad' || b.kind === 'line') {
        g.strokeStyle = b.style;
        g.lineWidth = b.lw;
        g.lineCap = 'round';
        g.stroke();
        g.lineCap = 'butt';
      } else {
        g.fillStyle = b.style;
        g.fill();
      }
    }
  }

  /**
   * Soil for many cells at once, batched by colour: the depth gradient, the wavy boundary with a neighbouring
   * stratum, flecks, the odd pebble and per-layer texture. items = flat [gx, gy, px, py, …]; gx may lie outside
   * the grid (the decorative margins), so the texture continues seamlessly into them.
   */
  function paintSoilBatch(g, items, cs, grad) {
    const n = items.length;
    if (!n) return;
    g.fillStyle = grad;
    g.beginPath();
    for (let k = 0; k < n; k += 4) g.rect(items[k + 2], items[k + 3], cs, cs);
    g.fill();
    const B = new Map();
    const s1min = Math.max(1, cs * 0.06);
    for (let k = 0; k < n; k += 4) {
      const x = items[k];
      const y = items[k + 1];
      const px = items[k + 2];
      const py = items[k + 3];
      const lid = layerAt(y);
      const T = texCols(lid);
      // wavy boundaries
      if (y + 1 < ROWS && layerAt(y + 1) !== lid) waveSliver(bucket(B, `w:${texCols(layerAt(y + 1)).waveTop}`, texCols(layerAt(y + 1)).waveTop, 'poly'), x, y + 1, px, py, cs, true);
      if (y > 0 && layerAt(y - 1) !== lid) waveSliver(bucket(B, `w:${texCols(layerAt(y - 1)).waveBottom}`, texCols(layerAt(y - 1)).waveBottom, 'poly'), x, y, px, py, cs, false);
      const h = hash2(x * 31 + 7, y * 17 + 11);
      const dots = 2 + (h % 3);
      const fl = bucket(B, `f:${lid}`, T.fleck, 'rect');
      const dk = bucket(B, `d:${lid}`, T.dark, 'rect');
      for (let j = 0; j < dots; j++) {
        const s1 = Math.max(s1min, cs * (0.06 + 0.07 * (((h >>> (j * 3 + 1)) & 7) / 7)));
        const hx = ((h >>> (j * 5)) & 31) / 31;
        const hy = ((h >>> (j * 5 + 3)) & 31) / 31;
        (j % 2 ? fl : dk).push(px + hx * (cs - s1), py + hy * (cs - s1), s1, s1 * 0.8);
      }
      // the odd pebble (kept inside the cell so partial redraws stay seamless)
      if (lid !== 'gravel' && lid !== 'bedrock' && (h >>> 20) % 17 === 0) {
        const r = cs * (0.15 + 0.1 * hash01(x + 3, y + 1));
        const cx = px + r + (cs - 2 * r) * hash01(x, y + 41);
        const cy = py + r + (cs - 2 * r) * hash01(x + 41, y);
        bucket(B, `p:${lid}`, T.pebble, 'ell').push(cx, cy, r, r * 0.72, hash01(x, y) * 3);
        bucket(B, 'phi', 'rgba(255,255,255,0.22)', 'ell').push(cx - r * 0.3, cy - r * 0.3, r * 0.4, r * 0.22, 0);
      }
      switch (lid) {
        case 'topsoil':
          if ((h & 15) === 3) {
            bucket(B, 'rootlet', 'rgba(42,26,14,0.5)', 'quad', Math.max(1, cs * 0.06))
              .push(px + cs * 0.2, py + cs * 0.3, px + cs * 0.45, py + cs * 0.5, px + cs * 0.7, py + cs * 0.42);
          }
          if (y <= 1) bucket(B, y === 0 ? 'top0' : 'top1', y === 0 ? 'rgba(30,20,10,0.2)' : 'rgba(30,20,10,0.1)', 'rect').push(px, py, cs, cs);
          break;
        case 'clay':
          if ((y + (h & 1)) % 3 === 0) bucket(B, 'streak', T.streak, 'rect').push(px, py + cs * (0.35 + 0.3 * hash01(x, y)), cs, Math.max(1, cs * 0.07));
          break;
        case 'gravel': {
          const m = 1 + (h % 3);
          for (let j = 0; j < m; j++) {
            const gx = px + cs * (0.15 + 0.7 * hash01(x * 5 + j, y));
            const gy = py + cs * (0.15 + 0.7 * hash01(x, y * 5 + j));
            const r = cs * (0.1 + 0.08 * hash01(j, x + y));
            bucket(B, j % 2 ? 'g1' : 'g2', j % 2 ? '#b3a894' : '#7d7262', 'ell').push(gx, gy, r, r * 0.75, 0);
            bucket(B, 'ghi', 'rgba(255,255,255,0.25)', 'rect').push(gx - r * 0.4, gy - r * 0.5, r * 0.5, Math.max(1, r * 0.3));
          }
          break;
        }
        case 'bedrock':
          if ((h & 7) === 1) {
            bucket(B, 'crack', 'rgba(20,20,26,0.6)', 'line', Math.max(1, cs * 0.06))
              .push(px, py + cs * hash01(x, y), px + cs * 0.5, py + cs * 0.5, px + cs, py + cs * hash01(y, x + 1));
          }
          if ((h & 31) === 9) bucket(B, 'mineral', 'rgba(200,205,225,0.35)', 'rect').push(px + cs * 0.4, py + cs * 0.3, Math.max(1, cs * 0.08), Math.max(1, cs * 0.08));
          break;
        case 'aquifer':
          bucket(B, 'aq', 'rgba(140,200,230,0.12)', 'rect').push(px, py + cs * 0.6, cs, Math.max(1, cs * 0.1));
          break;
        default:
          break;
      }
    }
    flushBuckets(g, B);
  }

  /** Polygon (7 points) of the sliver of a cell that belongs to the neighbouring stratum across the boundary at Y. */
  function waveSliver(out, x, Y, px, py, cs, below) {
    const base = below ? py + cs : py;
    out.push(px, base);
    for (let k = 0; k <= 4; k++) {
      const d = (art.waveY(x + k / 4, Y) - Y) * cs;
      out.push(px + (cs * k) / 4, base + (below ? Math.min(0, d) : Math.max(0, d)));
    }
    out.push(px + cs, base);
  }

  /** Base layer of grid cells in the strata cache: soil (batched), then stone / revealed water and roots. */
  function paintBaseBatch(g, cells, list, cs, grad, forceSoil = false) {
    const items = [];
    for (const i of list) items.push(i % COLS, (i / COLS) | 0, (i % COLS) * cs, ((i / COLS) | 0) * cs);
    paintSoilBatch(g, items, cs, grad);
    for (const i of list) {
      let code = forceSoil ? CELL.SOIL : codeAt(cells, i);
      if (code === CELL.WATER && !cache.water[i]) code = CELL.SOIL;
      if (code === CELL.SOIL) {
        const x = i % COLS;
        const y = (i / COLS) | 0;
        if (cache.roots[i]) rootSegment(g, x, y, x * cs, y * cs, cs, cache.roots[i], cache.rootOwn[i] === 1);
      } else if (code === CELL.STONE || code === CELL.WATER) {
        paintSolid(g, cells, i, cs, code);
      }
    }
  }

  /** A stone or revealed-water cell (rounded where exposed, lit from above). */
  function paintSolid(g, cells, i, cs, code) {
    const x = i % COLS;
    const y = (i / COLS) | 0;
    const px = x * cs;
    const py = y * cs;
    const nb = (dx, dy) => {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) return CELL.SOIL;
      const c = codeAt(cells, yy * COLS + xx);
      return c === CELL.WATER && !cache.water[yy * COLS + xx] ? CELL.SOIL : c;
    };
    if (code === CELL.STONE) {
      const isS = (dx, dy) => nb(dx, dy) === CELL.STONE;
      const r = cs * 0.45;
      const up = !isS(0, -1);
      const dn = !isS(0, 1);
      const lf = !isS(-1, 0);
      const rt = !isS(1, 0);
      const tl = up && lf ? r : 0;
      const tr = up && rt ? r : 0;
      const br = dn && rt ? r : 0;
      const bl = dn && lf ? r : 0;
      // C181: colour by stratum, each boulder its own shade (its group id), a little grain per cell
      const lid = layerAt(y);
      const sid = cache.stoneId[i] || i + 1;
      const v = hash01(sid, 77);
      g.fillStyle = shade(mix(NEST.stone, STONE_TINT[lid] || NEST.stone, 0.6), 0.14 * (v - 0.5) + 0.04 * (hash01(x + 11, y + 3) - 0.5));
      rrect(g, px, py, cs, cs, tl, tr, br, bl);
      g.fill();
      if (lid === 'clay' && (sid + y) % 2 === 0) {
        g.fillStyle = 'rgba(150,70,40,0.28)'; // rusty band
        g.fillRect(px + tl * 0.4, py + cs * (0.35 + 0.2 * v), cs - (tl + tr) * 0.4, Math.max(1, cs * 0.12));
      } else if (lid === 'gravel') {
        g.fillStyle = 'rgba(235,230,220,0.35)'; // granite speckle
        for (let k = 0; k < 4; k++) g.fillRect(px + cs * (0.15 + 0.7 * hash01(x * 7 + k, y + sid)), py + cs * (0.15 + 0.7 * hash01(y * 7 + k, x)), Math.max(1, cs * 0.07), Math.max(1, cs * 0.07));
      } else if (lid === 'bedrock' || lid === 'aquifer') {
        if (hash01(x + sid, y * 3) > 0.55) { // a crystalline glint
          g.fillStyle = lid === 'aquifer' ? 'rgba(170,225,235,0.45)' : 'rgba(190,200,235,0.4)';
          g.fillRect(px + cs * (0.25 + 0.5 * hash01(x, sid)), py + cs * (0.25 + 0.5 * hash01(sid, y)), Math.max(1, cs * 0.1), Math.max(1, cs * 0.05));
        }
      }
      // exposed edges: light from the top-left, shade to the bottom-right
      const e = Math.max(1, cs * 0.12);
      g.fillStyle = 'rgba(255,255,255,0.2)';
      if (up) g.fillRect(px + tl * 0.6, py + cs * 0.06, cs - tl * 0.6 - tr * 0.6, e);
      if (lf) g.fillRect(px + cs * 0.06, py + tl * 0.6, e * 0.8, cs - tl * 0.6 - bl * 0.6);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      if (dn) g.fillRect(px + bl * 0.6, py + cs * 0.82, cs - bl * 0.6 - br * 0.6, e);
      if (rt) g.fillRect(px + cs * 0.86, py + tr * 0.6, e * 0.8, cs - tr * 0.6 - br * 0.6);
      // grain
      g.fillStyle = 'rgba(60,60,66,0.35)';
      for (let k = 0; k < 3; k++) g.fillRect(px + cs * (0.2 + 0.6 * hash01(x + k, y * 3)), py + cs * (0.2 + 0.6 * hash01(y + k, x * 3)), Math.max(1, cs * 0.06), Math.max(1, cs * 0.06));
      if (hash01(x * 3, y * 5) > 0.6) {
        g.strokeStyle = 'rgba(40,40,46,0.45)';
        g.lineWidth = Math.max(1, cs * 0.05);
        g.beginPath();
        g.moveTo(px + cs * 0.2, py + cs * (0.3 + 0.4 * hash01(x, y)));
        g.lineTo(px + cs * 0.55, py + cs * 0.5);
        g.lineTo(px + cs * 0.8, py + cs * (0.4 + 0.3 * hash01(y, x)));
        g.stroke();
      }
      return;
    }
    const isW = (dx, dy) => nb(dx, dy) === CELL.WATER;
    const r = cs * 0.4;
    const tl = !isW(0, -1) && !isW(-1, 0) ? r : 0;
    const tr = !isW(0, -1) && !isW(1, 0) ? r : 0;
    const br = !isW(0, 1) && !isW(1, 0) ? r : 0;
    const bl = !isW(0, 1) && !isW(-1, 0) ? r : 0;
    g.fillStyle = mix(NEST.water, '#1e4a6a', clamp((y % 3) / 4, 0, 1) * 0.3);
    rrect(g, px, py, cs, cs, tl, tr, br, bl);
    g.fill();
    if (!isW(0, -1)) {
      g.fillStyle = rgba(NEST.waterLight, 0.8);
      g.fillRect(px + tl * 0.5, py + cs * 0.12, cs - tl * 0.5 - tr * 0.5, Math.max(1, cs * 0.08));
    }
    if (hash01(x, y + 9) > 0.5) {
      g.fillStyle = 'rgba(200,235,255,0.35)';
      g.fillRect(px + cs * 0.2, py + cs * 0.55, cs * 0.4, Math.max(1, cs * 0.05));
    }
  }

  /** One cell of a hanging root: a gently meandering, tapering pale line with the odd rootlet. */
  function rootSegment(g, x, y, px, py, cpp, thick, own = false) {
    const wob = (yy) => (Math.sin(yy * 0.55 + x * 1.3) * 0.22 + Math.sin(yy * 1.31 + x) * 0.06) * cpp;
    const k = clamp((thick || 255) / 255, 0.15, 1);
    const w = Math.max(1, cpp * (0.07 + 0.13 * k));
    const ax = px + cpp / 2 + wob(y);
    const bx = px + cpp / 2 + wob(y + 1);
    const mx = px + cpp / 2 + wob(y + 0.5);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(40,24,12,0.45)';
    g.lineWidth = w + Math.max(1, cpp * 0.06);
    g.beginPath();
    g.moveTo(ax, py);
    g.quadraticCurveTo(mx, py + cpp / 2, bx, py + cpp);
    g.stroke();
    g.strokeStyle = own ? ROOT_OWN : NEST.root;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(ax, py);
    g.quadraticCurveTo(mx, py + cpp / 2, bx, py + cpp);
    g.stroke();
    if (hash01(x + 5, y) > 0.72) {
      const side = hash01(y, x) > 0.5 ? 1 : -1;
      g.lineWidth = Math.max(0.8, w * 0.45);
      g.strokeStyle = own ? ROOT_OWN_DARK : NEST.rootDark;
      g.beginPath();
      g.moveTo(mx, py + cpp / 2);
      g.quadraticCurveTo(mx + side * cpp * 0.3, py + cpp * 0.6, mx + side * cpp * 0.5, py + cpp * 0.95);
      g.stroke();
    }
    g.lineCap = 'butt';
  }

  /** Passage node of a tunnel cell in cache px: [cx, cy, r]. */
  function nodeOf(i, cs) {
    const x = i % COLS;
    const y = (i / COLS) | 0;
    const n = art.tunnelNode(x, y);
    return [(x + 0.5 + n.dx) * cs, (y + 0.5 + n.dy) * cs, n.r * cs];
  }

  /**
   * Links of a tunnel cell: open tunnel neighbours, doorways into chambers, and the sky above row 0.
   * @returns {number[][]} [[x2, y2, r], …]
   */
  function linksOf(cells, i, cs, node) {
    const out = [];
    const x = i % COLS;
    const y = (i / COLS) | 0;
    const dirs = [[-1, 0, DOOR.L], [1, 0, DOOR.R], [0, -1, DOOR.U], [0, 1, DOOR.D]];
    for (const [dx, dy, bit] of dirs) {
      const xx = x + dx;
      const yy = y + dy;
      if (yy < 0 && dy < 0) {
        out.push([node[0], -0.6 * cs, node[2]]);
        continue;
      }
      if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) continue;
      const j = yy * COLS + xx;
      if (!isOpenCode(codeAt(cells, j))) continue;
      if (geo.at[j] < 0) {
        const m = nodeOf(j, cs);
        out.push([m[0], m[1], Math.min(node[2], m[2])]);
      } else if (geo.door[i] & bit) {
        out.push([(xx + 0.5) * cs, (yy + 0.5) * cs, node[2] * 0.95]);
      }
    }
    return out;
  }

  /**
   * Redraw the strata cache where cells changed: base soil for the changed cells and their neighbours, then — clipped
   * to that region — every passage and cavity that reaches into it, in three layered passes (dark rims, cavities, lit
   * floors) so tunnels read as smooth rounded passages and chambers as one organic cavity each.
   */
  function syncCache(s) {
    syncCacheSize();
    if (!cache.ctx) return;
    syncFeatures(s);
    const cells = s.run.nest.cells || [];
    const g = cache.ctx;
    const cs = cache.cpp;
    if (!cache.grad) cache.grad = soilGradient(g, cs);
    const dirty = scratchA;
    dirty.fill(0);
    let any = false;
    for (let i = 0; i < NCELL; i++) {
      let c = codeAt(cells, i);
      if (c === CELL.WATER && !cache.water[i]) c = 10;
      if (cache.drawn[i] !== c || cache.force[i]) {
        dirty[i] = 1;
        any = true;
      }
    }
    if (!any) return;
    const R = scratchB;
    dilate(dirty, R);
    const SRC = scratchC;
    dilate(R, SRC);
    const rList = [];
    for (let i = 0; i < NCELL; i++) if (R[i]) rList.push(i);
    paintBaseBatch(g, cells, rList, cs, cache.grad);
    g.save();
    g.beginPath();
    for (let i = 0; i < NCELL; i++) if (R[i]) g.rect((i % COLS) * cs, ((i / COLS) | 0) * cs, cs, cs);
    g.clip();
    const tun = [];
    const chs = new Set();
    const chLinks = [];
    for (let i = 0; i < NCELL; i++) {
      if (!SRC[i] || !isOpenCode(codeAt(cells, i))) continue;
      const k = geo.at[i];
      if (k < 0) {
        const node = nodeOf(i, cs);
        tun.push({ i, node, links: linksOf(cells, i, cs, node) });
      } else {
        chs.add(k);
        // doorways between two touching chambers
        const x = i % COLS;
        const y = (i / COLS) | 0;
        if ((geo.door[i] & DOOR.R) && x + 1 < COLS && geo.at[i + 1] >= 0) chLinks.push([(x + 0.5) * cs, (y + 0.5) * cs, (x + 1.5) * cs, (y + 0.5) * cs, y]);
        if ((geo.door[i] & DOOR.D) && y + 1 < ROWS && geo.at[i + COLS] >= 0) chLinks.push([(x + 0.5) * cs, (y + 0.5) * cs, (x + 0.5) * cs, (y + 1.5) * cs, y]);
      }
    }
    const chambers = s.run.nest.chambers || [];
    g.lineCap = 'round';
    // pass 1: rims
    for (const t of tun) strokeNode(g, t, cavCols((t.i / COLS) | 0).rim, RIM * cs, 0);
    for (const l of chLinks) strokeLink(g, l, cavCols(l[4]).rim, (0.36 + RIM) * cs);
    for (const k of chs) {
      const c = chambers[k];
      if (!c) continue;
      const cc = cavCols(Math.floor(c.y + c.h / 2));
      if (geo.full[k]) {
        g.strokeStyle = cc.rim;
        g.lineWidth = 2 * RIM * cs;
        g.beginPath();
        art.tracePath(g, art.chamberOutline(c), 0, 0, cs);
        g.stroke();
      } else {
        g.fillStyle = cc.rim;
        for (const i of geo.cells[k] || []) g.fillRect((i % COLS) * cs - RIM * cs, ((i / COLS) | 0) * cs - RIM * cs, cs * (1 + 2 * RIM), cs * (1 + 2 * RIM));
      }
    }
    // pass 2: passage cavities (+ fill between 2×2 open blocks)
    for (const t of tun) strokeNode(g, t, cavCols((t.i / COLS) | 0).cav, 0, 0);
    for (const l of chLinks) strokeLink(g, l, cavCols(l[4]).cav, 0.36 * cs);
    for (const t of tun) {
      const i = t.i;
      const x = i % COLS;
      if (x + 1 >= COLS || i + COLS + 1 >= NCELL) continue;
      const q = [i + 1, i + COLS, i + COLS + 1];
      if (!q.every((j) => geo.at[j] < 0 && isOpenCode(codeAt(cells, j)))) continue;
      const a = t.node;
      const b = nodeOf(i + 1, cs);
      const c2 = nodeOf(i + COLS + 1, cs);
      const d = nodeOf(i + COLS, cs);
      g.fillStyle = cavCols((i / COLS) | 0).cav;
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.lineTo(c2[0], c2[1]);
      g.lineTo(d[0], d[1]);
      g.closePath();
      g.fill();
    }
    // pass 3: lit floors (the ceiling keeps a dark crescent)
    for (const t of tun) strokeNode(g, t, cavCols((t.i / COLS) | 0).floor, -RIM * cs, 0.1 * cs);
    // pass 4: chamber cavities on top (doorway ends merge into them)
    for (const k of chs) {
      const c = chambers[k];
      if (!c) continue;
      const cc = cavCols(Math.floor(c.y + c.h / 2));
      const grad = g.createLinearGradient(0, c.y * cs, 0, (c.y + c.h) * cs);
      grad.addColorStop(0, cc.top);
      grad.addColorStop(0.45, cc.mid);
      grad.addColorStop(1, cc.chFloor);
      if (geo.full[k]) {
        const pts = art.chamberOutline(c);
        g.fillStyle = grad;
        g.beginPath();
        art.tracePath(g, pts, 0, 0, cs);
        g.fill();
        // packed-earth floor and a few dust specks
        g.save();
        g.clip();
        const b = art.cavityBox(c);
        g.fillStyle = cc.dust;
        g.fillRect(b.x0 * cs, (b.y1 - 0.14) * cs, (b.x1 - b.x0) * cs, 0.3 * cs);
        g.fillStyle = rgba(cc.dust, 0.8);
        for (let n = 0; n < Math.ceil(c.w * 1.5); n++) {
          g.fillRect((b.x0 + (b.x1 - b.x0) * hash01(c.uid + n, 7)) * cs, (b.y1 - 0.28 - 0.2 * hash01(n, c.uid)) * cs, Math.max(1, cs * 0.07), Math.max(1, cs * 0.05));
        }
        g.restore();
      } else {
        g.fillStyle = grad;
        for (const i of geo.cells[k] || []) g.fillRect((i % COLS) * cs, ((i / COLS) | 0) * cs, cs, cs);
      }
    }
    // pass 5 (C178): root lines grow down through chambers and tunnels: drawn hanging through the open cells, a little
    // paler than in soil, with a hair-root tip where the root ends inside the cavity
    for (const i of rList) {
      if (!cache.roots[i] || !isOpenCode(codeAt(cells, i))) continue;
      const x = i % COLS;
      const y = (i / COLS) | 0;
      g.globalAlpha = 0.8;
      rootSegment(g, x, y, x * cs, y * cs, cs, cache.roots[i], cache.rootOwn[i] === 1);
      if (y + 1 >= ROWS || !cache.roots[i + COLS]) {
        g.strokeStyle = cache.rootOwn[i] === 1 ? ROOT_OWN_DARK : NEST.rootDark;
        g.lineWidth = Math.max(0.8, cs * 0.05);
        g.beginPath();
        for (const dx of [-0.18, 0, 0.16]) {
          g.moveTo((x + 0.5) * cs, (y + 0.95) * cs);
          g.quadraticCurveTo((x + 0.5 + dx) * cs, (y + 1.1) * cs, (x + 0.5 + dx * 1.6) * cs, (y + 1.3) * cs);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    }
    g.lineCap = 'butt';
    g.restore();
    heavyAt = rList.length > 600 ? frameNo : heavyAt;
    for (let i = 0; i < NCELL; i++) {
      if (!R[i]) continue;
      let c = codeAt(cells, i);
      if (c === CELL.WATER && !cache.water[i]) c = 10;
      cache.drawn[i] = c;
      cache.force[i] = 0;
    }
  }

  const scratchA = new Uint8Array(NCELL);
  const scratchB = new Uint8Array(NCELL);
  const scratchC = new Uint8Array(NCELL);
  /** out = 8-neighbour dilation of `src`. */
  function dilate(src, out) {
    out.fill(0);
    for (let i = 0; i < NCELL; i++) {
      if (!src[i]) continue;
      const x = i % COLS;
      const y = (i / COLS) | 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(ROWS - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(COLS - 1, x + 1); xx++) out[yy * COLS + xx] = 1;
      }
    }
  }

  /** Disc + links of a tunnel node, grown by `grow` px and shifted down by `dy` px, in one colour. */
  function strokeNode(g, t, color, grow, dy) {
    const [cx, cy, r] = t.node;
    const rr = Math.max(0.5, r + grow);
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cy + dy, rr, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = color;
    for (const [x2, y2, lr] of t.links) {
      g.lineWidth = Math.max(1, 2 * (lr + grow));
      g.beginPath();
      g.moveTo(cx, cy + dy);
      g.lineTo(x2, y2 + dy);
      g.stroke();
    }
  }

  function strokeLink(g, l, color, r) {
    g.strokeStyle = color;
    g.lineWidth = 2 * r;
    g.beginPath();
    g.moveTo(l[0], l[1]);
    g.lineTo(l[2], l[3]);
    g.stroke();
  }

  /** Soil-only copy of the strata cache (ceremonies cover cells with it). */
  function pristine() {
    if (cache.pristine) return cache.pristine;
    const off = createOffscreen(COLS * cache.cpp, ROWS * cache.cpp);
    if (!off.ctx) return null;
    const grad = soilGradient(off.ctx, cache.cpp);
    const all = [];
    for (let i = 0; i < NCELL; i++) all.push(i);
    paintBaseBatch(off.ctx, null, all, cache.cpp, grad, true);
    cache.pristine = off;
    return off;
  }

  /**
   * Decorative soil either side of the grid (MARGIN_COLS columns per side, continuous with the strata: same gradient,
   * wavy boundaries and texture) with roots hanging from the surface and the odd boulder (drawMargins dims it a
   * little so the diggable grid still reads). Rebuilt only when the cache resolution changes.
   */
  function syncMargin() {
    const cpm = Math.min(cache.cpp || 12, 18);
    if (margin.canvas && margin.cpm === cpm) return;
    // never in the same frame as a full strata redraw: keep showing the old margins (scaled) one more frame
    if (margin.canvas && heavyAt === frameNo) return;
    const W = 2 * MARGIN_COLS * cpm;
    const off = createOffscreen(W, ROWS * cpm);
    if (!off.ctx) return;
    const g = off.ctx;
    const grad = soilGradient(g, cpm);
    const items = [];
    for (let side = 0; side < 2; side++) {
      for (let m = 0; m < MARGIN_COLS; m++) {
        const gx = side ? COLS + m : m - MARGIN_COLS;
        const px = (side ? MARGIN_COLS + m : m) * cpm;
        for (let y = 0; y < ROWS; y++) items.push(gx, y, px, y * cpm);
      }
    }
    paintSoilBatch(g, items, cpm, grad);
    for (let side = 0; side < 2; side++) {
      for (let m = 0; m < MARGIN_COLS; m++) {
        const gx = side ? COLS + m : m - MARGIN_COLS;
        const px = (side ? MARGIN_COLS + m : m) * cpm;
        // roots hanging from the surface
        if (hash01(gx + 101, 7) < 0.16) {
          const len = 4 + Math.floor(hash01(gx, 13) * 16);
          for (let y = 0; y < len; y++) rootSegment(g, gx, y, px, y * cpm, cpm, Math.round(255 - 215 * (y / len)));
        }
      }
    }
    // boulders
    for (let k = 0; k < 18; k++) {
      const side = k % 2;
      const m = Math.floor(hash01(k, 3) * (MARGIN_COLS - 2)) + 1;
      const y = 3 + Math.floor(hash01(k, 5) * (ROWS - 6));
      const cx = ((side ? MARGIN_COLS + m : m) + 0.5) * cpm;
      const cy = (y + 0.5) * cpm;
      const r = cpm * (0.5 + 0.6 * hash01(k, 9));
      g.fillStyle = 'rgba(25,20,18,0.4)';
      g.beginPath();
      g.ellipse(cx, cy + r * 0.08, r * 1.08, r * 0.8, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = shade(NEST.stone, 0.08 * (hash01(k, 11) - 0.5) - (y > 57 ? 0.15 : 0));
      g.beginPath();
      g.ellipse(cx, cy, r, r * 0.74, (hash01(k, 13) - 0.5) * 0.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.beginPath();
      g.ellipse(cx - r * 0.25, cy - r * 0.32, r * 0.45, r * 0.18, 0, 0, Math.PI * 2);
      g.fill();
    }
    margin.canvas = off.canvas;
    margin.ctx = g;
    margin.cpm = cpm;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sprites
  // ---------------------------------------------------------------------------------------------------------------

  function digFace(s, d) {
    const f = d && d.nest ? d.nest.digFace : -1;
    if (f >= 0) return f;
    const q = s.run.nest.queue || [];
    for (const job of q) if (job && Array.isArray(job.cells) && job.cur < job.cells.length) return job.cells[job.cur];
    return -1;
  }

  function chambersOf(s, types) {
    const out = [];
    const chs = s.run.nest.chambers || [];
    for (let k = 0; k < chs.length; k++) {
      const c = chs[k];
      if (c && types.includes(c.type) && geo.cells[k] && geo.cells[k].length) out.push(k);
    }
    return out;
  }

  function topFor(col) {
    for (const t of geo.tops) if (t.col === col) return t;
    return geo.tops[0] || null;
  }

  function randomOpenCell() {
    const tops = geo.tops;
    if (tops.length) {
      const t = tops[Math.floor(Math.random() * tops.length)];
      const ys = [];
      for (let y = 0; y < ROWS; y++) {
        const i = y * COLS + t.col;
        if (!fields.open[i]) break;
        ys.push(i);
      }
      if (ys.length) return ys[Math.floor(Math.random() * ys.length)];
    }
    for (let k = 0; k < 40; k++) {
      const i = Math.floor(Math.random() * NCELL);
      if (fields.open[i]) return i;
    }
    return -1;
  }

  function placeAt(i, c) {
    const v = view();
    pool.cell[i] = c;
    pool.next[i] = c;
    pool.t[i] = 1;
    pool.x[i] = v.ox + ((c % COLS) + 0.5) * v.cell;
    pool.y[i] = v.oy + (Math.floor(c / COLS) + 0.5) * v.cell;
  }

  /** Choose a home chamber index for a group sprite. */
  function homeFor(s, group, i) {
    let list = [];
    if (group === 1) list = chambersOf(s, ['nursery']);
    else if (group === 3) list = chambersOf(s, ['fungus_garden', 'root_aphid_pen']);
    else if (group === 4) list = chambersOf(s, ['barracks']);
    else if (group === 5) list = chambersOf(s, ['gallery']);
    else if (group === 2) list = chambersOf(s, ['granary']);
    if (!list.length) list = chambersOf(s, ['royal_chamber']);
    if (!list.length) return -1;
    return list[i % list.length];
  }

  function spawnSprite(s, i, g) {
    const adults = s.run.colony.adults || {};
    pool.type[i] = KIND.minor;
    if (g === 4) pool.type[i] = adults.supermajor > 0 && Math.random() < adults.supermajor / Math.max(1, adults.soldier + adults.supermajor) ? KIND.supermajor : KIND.soldier;
    else if (s.run.colony.golden > 0 && Math.random() < s.run.colony.golden / Math.max(1, adults.minor)) pool.type[i] = KIND.golden;
    pool.speed[i] = 2.2 + Math.random() * 1.4;
    pool.ox[i] = (Math.random() - 0.5) * 0.4;
    pool.oy[i] = (Math.random() - 0.5) * 0.3;
    pool.path[i] = homeFor(s, g, i + Math.floor(Math.random() * 7));
    let c = -1;
    if (pool.path[i] >= 0 && g !== 0 && g !== 2) {
      const list = geo.cells[pool.path[i]];
      if (list && list.length) c = list[Math.floor(Math.random() * list.length)];
    }
    if (c < 0) c = randomOpenCell();
    if (c < 0) c = GRID.mainCol;
    placeAt(i, c);
    pool.state[i] = g === 0 || g === 2 ? ST.GO : ST.WANDER;
    pool.carry[i] = g === 2 && Math.random() < 0.5 ? 1 : 0;
    // some nurses tend the brood carrying a pupa (white, ARCHITECTURE §13.4 carried colours)
    if (g === 1 && Math.random() < 0.3 && safe(() => broodTotal(s), 0) > 0) pool.carry[i] = 5;
    pool.aux[i] = Math.random() * 2;
  }

  function realloc(s) {
    const { alloc, K: k } = allocBelow(s, BUDGET.below);
    K = k;
    reconcile(pool, alloc, (i, g) => spawnSprite(s, i, g));
  }

  /** Field toward a chamber (any of its open cells). */
  function chamberField(k) {
    return fields.get(`ch:${k}`, () => geo.cells[k] || []);
  }

  function topField(col) {
    return fields.get(`top:${col}`, () => [col]);
  }

  function updateSprites(s, d, dt) {
    const face = digFace(s, d);
    const v = view();
    const storeList = chambersOf(s, ['granary', 'royal_chamber']);
    for (let i = pool.n - 1; i >= 0; i--) {
      // validity after grid changes
      const c0 = pool.cell[i];
      if (!(c0 >= 0) || !fields.open[c0]) {
        const c = randomOpenCell();
        if (c < 0) {
          removeSprite(pool, i);
          continue;
        }
        placeAt(i, c);
        pool.state[i] = pool.group[i] === 0 || pool.group[i] === 2 ? ST.GO : ST.WANDER;
      }
      pool.anim[i] += dt * pool.speed[i] * 6;
      const g = pool.group[i];
      if (pool.state[i] === ST.AWAY) {
        pool.aux[i] -= dt;
        const top = topFor(pool.cell[i] % COLS);
        let tok = null;
        if (g === 2) tok = hub.take('down', top ? top.col : null) || (top && top.kind === 'main' ? hub.take('down', -1) : null);
        if (tok || pool.aux[i] <= 0) {
          pool.state[i] = ST.GO;
          if (g === 2) pool.carry[i] = tok ? (tok.carry || 1) : 1;
          else pool.carry[i] = 0;
          if (top) placeAt(i, top.i);
        }
        continue;
      }
      if (pool.state[i] === ST.WORK) {
        pool.aux[i] -= dt;
        if (face >= 0 && Math.random() < dt * 2 && !reduced) {
          const p = cellCenter(face);
          fx.dust(p.x, p.y, 1, (STRATA[layerAt(Math.floor(face / COLS))] || STRATA.loam).fleck);
        }
        if (pool.aux[i] <= 0) {
          pool.state[i] = ST.GO;
          pool.carry[i] = 6; // pellet
        }
        continue;
      }
      if (pool.state[i] === ST.IDLE) {
        pool.aux[i] -= dt;
        if (pool.aux[i] > 0) {
          positionSprite(i, v);
          continue;
        }
        pool.state[i] = ST.WANDER;
      }
      // movement between cell centres
      if (pool.t[i] < 1) {
        pool.t[i] = Math.min(1, pool.t[i] + dt * pool.speed[i]);
      }
      if (pool.t[i] >= 1) {
        pool.cell[i] = pool.next[i];
        const cur = pool.cell[i];
        let nxt = cur;
        const r = Math.random();
        if (g === 0) {
          // diggers: face ↔ shaft top (pellets up)
          if (pool.carry[i] === 6) {
            const top = geo.tops[0];
            if (top) {
              const f = topField(top.col);
              if (f[cur] === 0) {
                hub.send('up', 'pellet', top.kind === 'main' ? -1 : top.col);
                pool.state[i] = ST.AWAY;
                pool.aux[i] = 0.5 + Math.random() * 0.8;
                pool.carry[i] = 0;
                continue;
              }
              nxt = stepDown(f, fields.open, cur, r);
            }
          } else if (face >= 0) {
            const f = fields.get(`dig:${face}`, () => [face]);
            if (f[cur] <= 1 && f[cur] >= 0) {
              pool.state[i] = ST.WORK;
              pool.aux[i] = 0.8 + Math.random() * 1.2;
              continue;
            }
            nxt = f[cur] > 0 ? stepDown(f, fields.open, cur, r) : randomNeighbor(fields.open, cur, r, pool.cell[i]);
          } else {
            nxt = randomNeighbor(fields.open, cur, r, -1);
          }
        } else if (g === 2) {
          // haulers: shaft top ↔ storage
          if (pool.carry[i] > 0) {
            const k = storeList.length ? storeList[i % storeList.length] : -1;
            if (k >= 0) {
              const f = chamberField(k);
              if (f[cur] === 0) {
                pool.carry[i] = 0;
                pool.state[i] = ST.GO;
                nxt = randomNeighbor(fields.open, cur, r, -1);
              } else nxt = stepDown(f, fields.open, cur, r);
            } else pool.carry[i] = 0;
          } else {
            const top = geo.tops[i % Math.max(1, geo.tops.length)] || geo.tops[0];
            if (top) {
              const f = topField(top.col);
              if (f[cur] === 0) {
                hub.send('up', 'none', top.kind === 'main' ? -1 : top.col);
                pool.state[i] = ST.AWAY;
                pool.aux[i] = 1.6 + Math.random() * 1.6;
                continue;
              }
              nxt = stepDown(f, fields.open, cur, r);
            }
          }
        } else {
          // wanderers: stay in (or return to) the home chamber
          const k = pool.path[i];
          if (k >= 0 && geo.cells[k] && geo.cells[k].length) {
            const inside = geo.at[cur] === k;
            if (!inside) {
              nxt = stepDown(chamberField(k), fields.open, cur, r);
            } else {
              const cand = randomNeighbor(fields.open, cur, r, -1);
              nxt = geo.at[cand] === k || Math.random() < 0.02 ? cand : cur;
              if (nxt === cur) {
                pool.state[i] = ST.IDLE;
                pool.aux[i] = 0.4 + Math.random() * 1.5;
              }
            }
          } else {
            pool.path[i] = homeFor(s, g, i);
            nxt = randomNeighbor(fields.open, cur, r, -1);
          }
        }
        if (pool.state[i] === ST.IDLE) {
          positionSprite(i, v);
          continue;
        }
        if (nxt !== cur) {
          pool.next[i] = nxt;
          pool.t[i] = 0;
          const dx = (nxt % COLS) - (cur % COLS);
          const dy = Math.floor(nxt / COLS) - Math.floor(cur / COLS);
          pool.a[i] = Math.atan2(dy, dx);
        }
      }
      positionSprite(i, v);
    }
  }

  /**
   * C180: the dig crew. Wherever the first queued job is digging (a tunnel, a new chamber, a chamber growing into its
   * reserved space, a shaft, a drain), the face cell is shown being excavated (a cavity bite growing from the open side
   * as its work completes, so the room is revealed cell by cell), two workers at the face (heads bobbing as they dig) and
   * two carriers walking soil pellets out along the passage toward the main shaft, with a small spoil heap. Drawn with
   * the shared ant sprites; under reduced motion the crew stands still. Only when cells are at least 7 px.
   */
  const crewMemo = { face: -1, rev: -1, stand: -1, path: [] };
  function digCrewPlan(s, face) {
    if (crewMemo.face === face && crewMemo.rev === s.run.nest.rev) return crewMemo;
    crewMemo.face = face;
    crewMemo.rev = s.run.nest.rev;
    crewMemo.stand = -1;
    crewMemo.path = [];
    const top = geo.tops[0];
    const tf = top ? topField(top.col) : null;
    let best = -1;
    let bestD = Infinity;
    for (const n of [face - COLS, face + COLS, face % COLS > 0 ? face - 1 : -1, face % COLS < COLS - 1 ? face + 1 : -1]) {
      if (n < 0 || n >= NCELL || !fields.open[n]) continue;
      const dd = tf && tf[n] >= 0 ? tf[n] : 9999;
      if (dd < bestD) { bestD = dd; best = n; }
    }
    if (best < 0) return crewMemo;
    crewMemo.stand = best;
    const path = [best];
    let cur = best;
    for (let k = 0; k < 6 && tf; k++) {
      const nx = stepDown(tf, fields.open, cur, 0.5);
      if (nx === cur) break;
      path.push(nx);
      cur = nx;
    }
    crewMemo.path = path;
    return crewMemo;
  }

  function drawDigCrew(ctx, s, d, unit, H) {
    const face = digFace(s, d);
    if (face < 0 || unit < 7) return;
    const v = view();
    const fy = Math.floor(face / COLS);
    const fpy = v.oy + fy * v.cell;
    if (fpy < -v.cell * 8 || fpy > H + v.cell * 8) return;
    const plan = digCrewPlan(s, face);
    if (plan.stand < 0) return;
    const q = s.run.nest.queue || [];
    const job = q[0];
    const work = job ? safe(() => nestgeom.cellWork(s, face, job.kind), 0) : 0;
    const frac = job && work > 0 ? clamp(job.prog / work, 0, 1) : 0.3;
    const fx0 = v.ox + (face % COLS) * v.cell;
    const st = plan.stand;
    const dxs = (st % COLS) - (face % COLS);
    const dys = Math.floor(st / COLS) - fy;
    // the bite: cavity colour growing from the side the crew digs from
    const cc = cavCols(fy);
    const b = Math.max(0.15, frac) * v.cell;
    ctx.fillStyle = cc.cav;
    ctx.beginPath();
    if (dxs < 0) rrect(ctx, fx0, fpy + v.cell * 0.12, b, v.cell * 0.76, 0, v.cell * 0.3, v.cell * 0.3, 0);
    else if (dxs > 0) rrect(ctx, fx0 + v.cell - b, fpy + v.cell * 0.12, b, v.cell * 0.76, v.cell * 0.3, 0, 0, v.cell * 0.3);
    else if (dys < 0) rrect(ctx, fx0 + v.cell * 0.12, fpy, v.cell * 0.76, b, 0, 0, v.cell * 0.3, v.cell * 0.3);
    else rrect(ctx, fx0 + v.cell * 0.12, fpy + v.cell - b, v.cell * 0.76, b, v.cell * 0.3, v.cell * 0.3, 0, 0);
    ctx.fill();
    // spoil heap on the floor of the stand cell
    const sp = cellCenter(st);
    const fleck = (STRATA[layerAt(fy)] || STRATA.loam).fleck;
    ctx.fillStyle = rgba(fleck, 0.85);
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.ellipse(sp.x + (k - 1.5) * v.cell * 0.13, sp.y + v.cell * 0.36 - (k % 2) * v.cell * 0.05, v.cell * 0.09, v.cell * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // two diggers at the face, facing it
    const fc = cellCenter(face);
    const ang = Math.atan2(fc.y - sp.y, fc.x - sp.x);
    const still = reduced;
    for (let k = 0; k < 2; k++) {
      const off = (k ? 1 : -1) * v.cell * 0.18;
      const px = sp.x + (fc.x - sp.x) * 0.38 + (dxs === 0 ? off : 0);
      const py = sp.y + (fc.y - sp.y) * 0.38 + (dys === 0 ? off * 0.6 : 0) + v.cell * 0.08;
      const bob = still ? 0 : Math.sin(time * 13 + k * 2.1) * 0.3;
      atlas.drawAnt(ctx, KIND.minor, 'none', ang + bob, still ? 0 : (Math.floor(time * 6 + k) & 1), px, py, unit, null, NEST.antOutline);
    }
    // carriers walking pellets out along the passage
    const path = plan.path;
    if (path.length >= 2) {
      const len = path.length - 1;
      for (let k = 0; k < 2; k++) {
        const p = still ? 0.3 + 0.4 * k : ((time * 0.35 + k * 0.5) % 1);
        const at = p * len;
        const a = Math.min(len - 1, Math.floor(at));
        const u = at - a;
        const A = cellCenter(path[a]);
        const B = cellCenter(path[a + 1]);
        const x = A.x + (B.x - A.x) * u;
        const y = A.y + (B.y - A.y) * u + v.cell * 0.1;
        atlas.drawAnt(ctx, KIND.minor, 'pellet', Math.atan2(B.y - A.y, B.x - A.x), still ? 0 : (Math.floor(time * 8 + k) & 1), x, y, unit, null, NEST.antOutline);
      }
    }
  }

  function positionSprite(i, v) {
    const c = pool.cell[i];
    const n = pool.next[i];
    const t = clamp(pool.t[i], 0, 1);
    const cx = (c % COLS) + (n % COLS - c % COLS) * t;
    const cy = Math.floor(c / COLS) + (Math.floor(n / COLS) - Math.floor(c / COLS)) * t;
    const inShaft = geo.shaftCells[c] && geo.shaftCells[n];
    let gx = cx + 0.5 + (inShaft ? pool.ox[i] * 0.4 : pool.ox[i]);
    let gy = cy + 0.5 + (inShaft ? 0 : pool.oy[i] * 0.6 + 0.12);
    // inside an organic cavity: keep the ant off the rounded walls and on (or near) the floor
    const k = geo.at[c];
    if (k >= 0 && geo.at[n] === k && geo.full[k] && geo.shape[k]) {
      const sh = geo.shape[k];
      gy = clamp(gy, sh.y0 + 0.32, sh.y1 - 0.3);
      const span = art.cavitySpan(sh, gy - 0.2, 0.32);
      gx = clamp(gx, span[0], span[1]);
    }
    pool.x[i] = v.ox + gx * v.cell;
    pool.y[i] = v.oy + gy * v.cell;
  }

  function drawSprites(ctx, unit, H) {
    let n = 0;
    for (let i = 0; i < pool.n; i++) {
      if (pool.state[i] === ST.AWAY) continue;
      const y = pool.y[i];
      if (y < -unit || y > H + unit) continue;
      const frame = pool.state[i] === ST.IDLE ? 0 : (Math.floor(pool.anim[i]) & 1);
      const ang = pool.state[i] === ST.WORK ? pool.a[i] + Math.sin(time * 14 + i) * 0.25 : pool.a[i];
      atlas.drawAnt(ctx, pool.type[i], CARRY_CODES[pool.carry[i]] || 'none', ang, frame, pool.x[i], y, unit, null, NEST.antOutline);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // chambers
  // ---------------------------------------------------------------------------------------------------------------

  function chamberExposed(s, d, c, k) {
    const dc = d && d.nest && d.nest.chambers ? d.nest.chambers[k] : null;
    if (dc && dc.uid === c.uid && typeof dc.exposed === 'boolean') return dc.exposed || !!dc.snap;
    const def = CHAMBERS && CHAMBERS[c.type];
    const immune = def ? !!def.frostImmune : FROST_IMMUNE_FALLBACK.has(c.type);
    if (immune) return false;
    const row = Math.max(d && d.season ? d.season.frostRow || 0 : 0, d && d.season ? d.season.snapRow || 0 : 0);
    if (!(row > 0)) return false;
    let above = 0;
    for (let y = c.y; y < c.y + c.h; y++) if (y < row) above += c.w;
    return above > (c.w * c.h) / 2;
  }

  /** Brood counts by stage, split over brood groups by cap. */
  function broodPlan(s, d) {
    const brood = s.run.colony.brood || [];
    let egg = 0;
    let larva = 0;
    let pupa = 0;
    for (const b of brood) {
      if (!b) continue;
      if (b.p < STAGES[0]) egg += b.n;
      else if (b.p < STAGES[1]) larva += b.n;
      else pupa += b.n;
    }
    const groups = (d && d.nest && d.nest.agg && d.nest.agg.broodGroups) || [];
    let capT = 0;
    for (const g of groups) capT += g && g.cap > 0 ? g.cap : 0;
    const per = new Map();
    for (const g of groups) {
      if (!g || !(g.cap > 0)) continue;
      const share = capT > 0 ? g.cap / capT : 0;
      per.set(g.uid, { egg: egg * share, larva: larva * share, pupa: pupa * share, frozen: false });
    }
    if (!groups.length) per.set(1, { egg, larva, pupa, frozen: false });
    return per;
  }

  function chamberStatusAlpha(c) {
    return c.status === 'digging' || c.status === 'relocating' ? 0.5 : 1;
  }

  /** Cavity interior of a chamber in CSS px. */
  function cavityPx(c, v) {
    const b = art.cavityBox(c);
    return { x: v.ox + b.x0 * v.cell, y: v.oy + b.y0 * v.cell, w: (b.x1 - b.x0) * v.cell, h: (b.y1 - b.y0) * v.cell };
  }

  /** Begin a path along a chamber's organic outline (grown outward by `grow` CSS px). */
  function chamberPath(ctx, c, v, grow = 0) {
    ctx.beginPath();
    art.tracePath(ctx, art.chamberOutline(c), v.ox, v.oy, v.cell, grow);
  }

  /** Labels collected while drawing chambers; drawn after the sprites so ants never hide them. */
  const labelQueue = [];

  function drawChambers(ctx, s, d, unit, W, H) {
    const v = view();
    const chs = s.run.nest.chambers || [];
    const plan = broodPlan(s, d);
    const res = s.run.res || {};
    const stats = (d && d.stats) || {};
    const colony = s.run.colony || {};
    const blight = (s.run.events && (s.run.events.active || []).some((a) => a && a.id === 'ev_fungal_blight'))
      || (s.run.events && (s.run.events.objects || []).some((o) => o && o.kind === 'blight'));
    const ventilated = !!(s.run.research && s.run.research.ventilation_shafts);
    const winter = !!(d && d.season && d.season.id === 'winter');
    const ui0 = uiOf(ui);
    const sel = ui0.selection && ui0.selection.view === 'nest' ? ui0.selection : null;
    const hov = ui0.hover && ui0.hover.view === 'nest' ? ui0.hover : null;
    labelQueue.length = 0;
    for (let k = 0; k < chs.length; k++) {
      const c = chs[k];
      if (!c) continue;
      const r = chamberRectPx(c);
      if (r.y > H || r.y + r.h < 0 || r.x > W || r.x + r.w < 0) continue;
      const box = cavityPx(c, v);
      const exposed = chamberExposed(s, d, c, k);
      const active = c.status === 'active' || c.status === 'growing';
      const full = !!geo.full[k];
      const isSel = !!(sel && (sel.kind === 'chamber' || sel.kind === 'nursery' || sel.kind === 'queen') && sel.id === c.uid);
      const isHov = !!(hov && (hov.kind === 'chamber' || hov.kind === 'nursery') && hov.id === c.uid);
      // interior content, clipped to the cavity (and to the dug cells while it is still being dug)
      if (active) {
        ctx.save();
        chamberPath(ctx, c, v);
        ctx.clip();
        if (!full) {
          ctx.beginPath();
          for (const i of geo.cells[k] || []) ctx.rect(v.ox + (i % COLS) * v.cell, v.oy + ((i / COLS) | 0) * v.cell, v.cell, v.cell);
          ctx.clip();
        }
        ctx.globalAlpha = chamberStatusAlpha(c);
        drawContent(ctx, s, d, c, k, r, box, unit, { plan, res, stats, colony, blight, ventilated, exposed, winter });
        ctx.globalAlpha = 1;
        if (exposed) {
          ctx.fillStyle = 'rgba(200,230,255,0.16)';
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        ctx.restore();
      }
      const building = c.status === 'digging' || c.status === 'relocating' || c.status === 'growing';
      // outlines: the planned cavity (dashed) while digging, selection / hover rings
      if (!full || !active) {
        ctx.strokeStyle = 'rgba(255,226,170,0.6)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        chamberPath(ctx, c, v);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (isSel) {
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 4;
        chamberPath(ctx, c, v, 1.5);
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.8;
        chamberPath(ctx, c, v, 0.5);
        ctx.stroke();
      } else if (isHov) {
        ctx.strokeStyle = 'rgba(255,240,200,0.85)';
        ctx.lineWidth = 1.5;
        chamberPath(ctx, c, v, 0.5);
        ctx.stroke();
      }
      // onboarding / advisor glow on the Royal Chamber ('canvas:royal', vocabulary shared with ui/onboarding.js)
      if (ui0.glow === 'canvas:royal' && c.type === 'royal_chamber') {
        const g = (time * 0.9) % 1;
        ctx.strokeStyle = `rgba(255,224,138,${0.85 * (1 - g)})`;
        ctx.lineWidth = 2;
        chamberPath(ctx, c, v, unit * 0.2 + g * unit * 0.9);
        ctx.stroke();
      }
      // dig / growth / relocation progress: a thin bar along the cavity floor
      let pct = 100;
      if (building) {
        const list = geo.cells[k] || [];
        pct = Math.round((100 * list.length) / Math.max(1, c.w * c.h));
        const bw = Math.max(4, box.w - 4);
        const bh = Math.max(2, Math.min(4, unit * 0.2));
        const by = box.y + box.h - bh - 1;
        ctx.fillStyle = 'rgba(15,8,3,0.7)';
        ctx.fillRect(box.x + 2, by, bw, bh);
        ctx.fillStyle = NEST.digFace;
        ctx.fillRect(box.x + 2, by, bw * clamp(pct / 100, 0, 1), bh);
      }
      labelQueue.push({ c, r, box, isSel, isHov, pct, building });
    }
    // activation glows
    for (let gI = glows.length - 1; gI >= 0; gI--) {
      const gl = glows[gI];
      const c = chamberByUid(gl.uid);
      if (!c || gl.t > gl.max) {
        glows.splice(gI, 1);
        continue;
      }
      const a = 1 - gl.t / gl.max;
      ctx.strokeStyle = `rgba(255,224,138,${0.9 * a})`;
      ctx.lineWidth = 2 + 3 * a;
      chamberPath(ctx, c, v, 2 + (1 - a) * unit * 0.4);
      ctx.stroke();
    }
  }

  function drawContent(ctx, s, d, c, k, r, box, unit, o) {
    // set dressing first (cached static layer), then the live contents, then the subtle animated layer
    const dOpts = decorOpts(c, r, box, unit, o.winter);
    decorCache.draw(ctx, c, box, unit, cache.cpp || cppFor(unit), dOpts);
    switch (c.type) {
      case 'royal_chamber':
        drawRoyal(ctx, s, d, c, r, unit, o.plan.get(c.uid), box);
        break;
      case 'nursery':
      case 'hibernaculum':
        art.drawBroodHeaps(ctx, box, o.plan.get(c.uid) || { egg: 0, larva: 0, pupa: 0 }, c.type === 'nursery' && o.exposed, unit, MAX_BROOD_SPRITES);
        break;
      case 'granary':
        art.drawSeedPile(ctx, box, unit, clamp((o.res.food || 0) / Math.max(1, o.stats.foodCap || 150), 0, 1),
          layerOfChamber(d, c, k) === 'clay' && !o.ventilated && (o.res.food || 0) > 0, c.uid);
        break;
      case 'fungus_garden':
        art.drawFungusBed(ctx, box, unit, clamp((o.res.fungus || 0) / Math.max(1, o.stats.fungusCap || 1000), 0, 1), o.blight, time);
        break;
      case 'repletion_hall': {
        const n = o.colony.adults ? o.colony.adults.replete || 0 : 0;
        const per = Math.max(1, Math.floor(box.w / (unit * 0.62)));
        art.drawRepletes(ctx, box, unit, n, Math.min(0.6, (0.02 * n) / per * 0.5));
        break;
      }
      case 'nuptial_chamber':
        drawAlates(ctx, box, unit, o.colony.alatesReared || 0, (d && d.stats && d.stats.alateCells) || 25);
        break;
      case 'midden': {
        const load = adultsTotal(s) / Math.max(1, 100 * Math.max(1, c.level || 1) * ((d && d.meta && d.meta.colonyScale) || 1));
        // ARCH-R: "overloaded" read as more than 100 adults × colonyScale per midden level (DESIGN §7.13 gives no number)
        const dark = clamp(load - 1, 0, 1);
        if (dark > 0) {
          ctx.fillStyle = `rgba(10,6,3,${(0.5 * dark).toFixed(3)})`;
          ctx.fillRect(box.x - unit, box.y - unit, box.w + 2 * unit, box.h + 2 * unit);
        }
        break;
      }
      default:
        break;
    }
    if (decor.hasDecorAnim(c.type)) {
      dOpts.still = reduced;
      decor.drawDecorAnim(ctx, c.type, box, unit, reduced ? 0 : time, c.uid, dOpts);
    }
  }

  /**
   * Decoration options for a chamber: season flag, the level tier (C159: richer adornment as it levels) and, for the
   * Royal Chamber, where the queen rests.
   */
  function decorOpts(c, r, box, unit, winter) {
    const tier = decor.decorTier(c.level);
    if (c.type !== 'royal_chamber') return { winter, tier };
    const grow = 1 + Math.min(0.5, 0.07 * (Math.max(1, c.level || 1) - 1));
    const q = queenPos(c, r, unit);
    const qf = box.w > 0 ? (q.x - box.x) / box.w : 0.4;
    const qh = (box.y + box.h - q.y) / unit;
    return { winter, tier, grow, qf, qh, key: `${grow.toFixed(2)}|${qf.toFixed(3)}` };
  }

  /**
   * Chamber labels after the sprites: a level badge in each chamber's ceiling corner (hidden at far zoom), a short
   * name where it fits without touching another label, and the full name + level above the hovered / selected
   * chamber, always on top.
   */
  /** C109: refresh the per-chamber adjacency links (cheap; only when the nest or its statuses change). */
  function syncLinks(s, d) {
    const chs = s.run.nest.chambers || [];
    let sig = s.run.nest.rev + '|' + chs.length;
    for (const c of chs) sig += c ? c.status[0] : '';
    if (linkMemo.key === sig) return;
    linkMemo.key = sig;
    linkMemo.map = new Map();
    for (const c of chs) {
      if (!c) continue;
      const l = safe(() => nestSys.chamberLinks(s, d, c.uid), []);
      if (l && l.length) linkMemo.map.set(c.uid, l);
    }
  }

  /** A small chain-link badge: two interlocked rings (green = bonus, red = penalty, amber ring = both). */
  function drawLinkBadge(ctx, x, y, r, bad, good) {
    ctx.fillStyle = 'rgba(18,10,5,0.82)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    const col = bad && good ? '#f0b43c' : bad ? NEST.ghostBad : NEST.ghostOk;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, r * 0.22);
    ctx.beginPath();
    ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
    ctx.stroke();
    const lr = r * 0.32;
    ctx.lineWidth = Math.max(1, r * 0.2);
    ctx.beginPath();
    ctx.ellipse(x - lr * 0.6, y + lr * 0.6, lr, lr * 0.62, -Math.PI / 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x + lr * 0.6, y - lr * 0.6, lr, lr * 0.62, -Math.PI / 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * C106: pending blueprint chambers as faint dashed "planned" outlines with the chamber name (they queue themselves
   * once unlocked and affordable).
   */
  function drawPlanned(ctx, s) {
    const list = safe(() => nestSys.plannedChambers(s), []);
    if (!list || !list.length) return;
    const v = view();
    const ui0 = uiOf(ui);
    const hov = ui0.hover && ui0.hover.view === 'nest' && ui0.hover.kind === 'planned' ? ui0.hover : null;
    for (const p of list) {
      const x = v.ox + p.x * v.cell;
      const y = v.oy + p.y * v.cell;
      const w = p.w * v.cell;
      const hgt = p.h * v.cell;
      const on = !!(hov && hov.i === p.y * COLS + p.x);
      ctx.fillStyle = on ? 'rgba(170,210,255,0.16)' : 'rgba(170,210,255,0.07)';
      ctx.beginPath();
      art.tracePath(ctx, art.chamberOutline({ uid: 0, x: p.x, y: p.y, w: p.w, h: p.h }), v.ox, v.oy, v.cell);
      ctx.fill();
      ctx.strokeStyle = on ? 'rgba(190,225,255,0.9)' : 'rgba(170,210,255,0.55)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (v.cell >= 9) {
        const fpx = v.cell >= 18 ? 11 : 9;
        ctx.font = `italic 600 ${fpx}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const text = (w >= 70 ? 'Planned: ' : '') + art.shortName(p.type);
        ctx.fillStyle = 'rgba(15,8,3,0.55)';
        const tw = ctx.measureText(text).width;
        ctx.fillRect(x + w / 2 - tw / 2 - 3, y + hgt / 2 - fpx / 2 - 2, tw + 6, fpx + 4);
        ctx.fillStyle = 'rgba(200,228,255,0.92)';
        ctx.fillText(text, x + w / 2, y + hgt / 2 + 0.5);
        ctx.textAlign = 'left';
      }
    }
  }

  /**
   * C137 / C154: every chamber's reserved full-size room (the cells it will grow into), drawn as works in progress: the
   * reserved soil it does not fill yet looks freshly excavated but unfinished (art.drawReservedWorks: sandy fresh-dug
   * wash, pick marks, a faint construction hatch, timber props and, close up, workers at the face), brighter (with its
   * dashed extent) while a placement / relocation ghost is up or for the hovered / selected chamber. Cells already open
   * (old tunnels), stone and water inside are left as they are. Planned blueprint chambers show their saved reservation
   * as a faint dashed outline in the planned blue. Drawn under the chambers.
   */
  function drawReservations(ctx, s) {
    const chs = s.run.nest.chambers || [];
    const v = view();
    const ui0 = uiOf(ui);
    const t = ui0.tool;
    const placing = !!(t && (t.kind === 'placeChamber' || t.kind === 'relocate'));
    const focus = new Set();
    for (const r of [ui0.hover, ui0.selection]) if (r && r.view === 'nest' && (r.kind === 'chamber' || r.kind === 'nursery' || r.kind === 'queen')) focus.add(r.id);
    const one = (R, room, strong, blue) => {
      if (!R || !(R.w > 0) || !(R.h > 0)) return;
      if (room && room.w >= R.w && room.h >= R.h) return; // grown to full size: nothing left to show
      const x = v.ox + R.x * v.cell;
      const y = v.oy + R.y * v.cell;
      ctx.fillStyle = blue ? 'rgba(170,210,255,0.05)' : strong ? 'rgba(255,226,170,0.13)' : 'rgba(255,226,170,0.06)';
      ctx.beginPath();
      for (let yy = R.y; yy < R.y + R.h; yy++) {
        for (let xx = R.x; xx < R.x + R.w; xx++) {
          if (room && xx >= room.x && xx < room.x + room.w && yy >= room.y && yy < room.y + room.h) continue;
          ctx.rect(v.ox + xx * v.cell, v.oy + yy * v.cell, v.cell, v.cell);
        }
      }
      ctx.fill();
      ctx.strokeStyle = blue ? 'rgba(170,210,255,0.35)' : strong ? 'rgba(255,226,170,0.75)' : 'rgba(255,226,170,0.32)';
      ctx.lineWidth = strong ? 1.4 : 1;
      ctx.setLineDash([3, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, R.w * v.cell - 1, R.h * v.cell - 1);
      ctx.setLineDash([]);
    };
    const cells = s.run.nest.cells;
    for (const c of chs) {
      if (!c || !c.res || !(c.res.w > 0) || !(c.res.h > 0)) continue;
      if (c.w >= c.res.w && c.h >= c.res.h) continue; // grown to full size
      const R = c.res;
      const soil = [];
      for (let yy = R.y; yy < R.y + R.h; yy++) {
        for (let xx = R.x; xx < R.x + R.w; xx++) {
          if (xx >= c.x && xx < c.x + c.w && yy >= c.y && yy < c.y + c.h) continue;
          if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) continue;
          const ci = yy * COLS + xx;
          // C173: an unrevealed pocket reads as plain soil here too (no gap in the works gives it away)
          if (cells[ci] === CELL.SOIL || (cells[ci] === CELL.WATER && !cache.water[ci])) soil.push([xx, yy]);
        }
      }
      art.drawReservedWorks(ctx, { R, room: c, soil, ox: v.ox, oy: v.oy, u: v.cell, seed: c.uid,
        strong: placing || focus.has(c.uid), t: time, still: reduced });
    }
    for (const p of safe(() => nestSys.plannedChambers(s), []) || []) if (p.res) one(p.res, p, false, true);
  }

  /**
   * C125: where a chamber covers a shaft, the shaft carries on through the cavity: a faint vertical passage (darker
   * strip with pale dashed walls) per contiguous run of pass cells, under the chamber's contents.
   */
  function drawShaftPass(ctx, H) {
    const v = view();
    const pc = geo.passCells;
    for (let x = 0; x < COLS; x++) {
      let y = 0;
      while (y < ROWS) {
        if (!pc[y * COLS + x]) { y++; continue; }
        const y0 = y;
        while (y < ROWS && pc[y * COLS + x]) y++;
        const px = v.ox + (x + 0.28) * v.cell;
        const pw = v.cell * 0.44;
        const py = v.oy + y0 * v.cell;
        const ph = (y - y0) * v.cell;
        if (py > H || py + ph < 0) continue;
        ctx.fillStyle = 'rgba(18,9,3,0.3)';
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeStyle = 'rgba(236,206,160,0.42)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(px + 0.5, py);
        ctx.lineTo(px + 0.5, py + ph);
        ctx.moveTo(px + pw - 0.5, py);
        ctx.lineTo(px + pw - 0.5, py + ph);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  /**
   * C156: uids of the chambers whose next level is affordable right now (nest.affordableUpgrades), refreshed at most
   * every UP_REFRESH_MS of wall time, or at once when the nest changes; only while the badge can show (cell ≥ UP_MIN_CELL).
   */
  function affordableSet(s, d) {
    const now = nowMs();
    const rev = s.run.nest.rev;
    if (upMemo.set && upMemo.rev === rev && now - upMemo.t < UP_REFRESH_MS && now >= upMemo.t) return upMemo.set;
    upMemo.t = now;
    upMemo.rev = rev;
    upMemo.set = new Set(safe(() => nestSys.affordableUpgrades(s, d), []) || []);
    return upMemo.set;
  }

  /** C156: the small ▲ "upgrade affordable" badge under a chamber's level badge. */
  function drawUpBadge(ctx, x, y, r) {
    ctx.fillStyle = 'rgba(18,10,5,0.82)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,222,120,0.75)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#a8f08a';
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.55);
    ctx.lineTo(x + r * 0.55, y + r * 0.4);
    ctx.lineTo(x - r * 0.55, y + r * 0.4);
    ctx.closePath();
    ctx.fill();
  }

  function drawLabels(ctx, W) {
    const v = view();
    const u = v.cell;
    if (!labelQueue.length) return;
    // C156: chambers whose next level is affordable now get a small ▲ under the level badge (hidden at overview zoom)
    const ups = u >= UP_MIN_CELL ? affordableSet(S(), D()) : null;
    // badges
    const br = clamp(u * 0.34, 5.5, 8.5);
    ctx.font = `700 ${Math.round(br * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const badges = [];
    for (const L of labelQueue) {
      if (!(u >= 8 || L.isSel || L.isHov) || L.box.w < br * 2.6 || L.box.h < br * 2) continue;
      const bx = L.box.x + L.box.w - br - Math.max(1.5, u * 0.18);
      const by = L.box.y + br + Math.max(1.5, u * 0.16);
      badges.push({ L, bx, by });
      ctx.fillStyle = 'rgba(18,10,5,0.8)';
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      if (L.building) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, br - 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = NEST.digFace;
        ctx.beginPath();
        ctx.arc(bx, by, br - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(L.pct / 100, 0, 1));
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(255,224,138,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(bx, by, br - 0.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffe08a';
      ctx.fillText(L.c.status === 'growing' ? '↑' : String(Math.max(0, L.c.level | 0) || '·'), bx, by + 0.5);
      if (ups && ups.has(L.c.uid) && L.box.h >= br * 4.4) {
        drawUpBadge(ctx, bx, by + br * 2.05, br * 0.78);
        ctx.fillStyle = '#ffe08a';
      }
      // C109: link badge left of the level badge when the chamber receives an adjacency bonus (red: a hygiene hit)
      const links = (linkMemo.map.get(L.c.uid) || []).filter((l) => l.receiver === 'self');
      if (links.length && L.box.w >= br * 5.4) drawLinkBadge(ctx, bx - br * 2 - 3, by, br * 0.9, links.some((l) => !l.good), links.some((l) => l.good));
      ctx.fillStyle = '#ffe08a';
      ctx.font = `700 ${Math.round(br * 1.25)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }
    // short names where there is room
    const fontPx = u >= 18 ? 11 : 10;
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    const placed = [];
    const overlaps = (a) => placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    if (u >= 11) {
      for (const L of labelQueue) {
        if (L.isSel || L.isHov) continue;
        const text = art.shortName(L.c.type);
        const tw = ctx.measureText(text).width;
        const badgeW = badges.some((b) => b.L === L) ? br * 2 + 5 : 0;
        const avail = L.box.w - badgeW - 6;
        // only where the name cannot sit on the contents: tall chambers, or long ones (never over a small Royal Chamber)
        const roomy = L.box.h >= 2.4 * u || (L.box.w >= 4.5 * u && L.c.type !== 'royal_chamber');
        if (!roomy || tw + 8 > avail || L.box.h < fontPx + 9) continue;
        const cx = L.box.x + 3 + (avail - tw) / 2 + tw / 2;
        const cy = L.box.y + Math.max(fontPx * 0.5 + 3, u * 0.42);
        const rect = { x: cx - tw / 2 - 4, y: cy - fontPx / 2 - 2, w: tw + 8, h: fontPx + 4 };
        if (overlaps(rect)) continue;
        placed.push(rect);
        ctx.fillStyle = 'rgba(15,8,3,0.5)';
        rrect(ctx, rect.x, rect.y, rect.w, rect.h, 4, 4, 4, 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(246,234,210,0.95)';
        ctx.fillText(text, cx, cy + 0.5);
      }
    }
    // focus labels: hovered then selected (selected wins when both)
    const focus = labelQueue.filter((L) => L.isHov && !L.isSel).concat(labelQueue.filter((L) => L.isSel));
    ctx.font = '600 11px system-ui, sans-serif';
    for (const L of focus) {
      const c = L.c;
      let text = chamberName(c.type);
      if (c.status === 'digging' || c.status === 'relocating') text += ` · ${L.pct}%`;
      else text += ` · L${c.level}${c.status === 'growing' ? ' ↑' : ''}`;
      const tw = ctx.measureText(text).width;
      const lh = 17;
      const lx = clamp(L.r.x + L.r.w / 2 - tw / 2 - 6, 2, Math.max(2, W - tw - 14));
      const ly = L.r.y - lh - 2 >= 0 ? L.r.y - lh - 2 : L.r.y + L.r.h + 3;
      ctx.fillStyle = 'rgba(15,8,3,0.88)';
      rrect(ctx, lx, ly, tw + 12, lh, 6, 6, 6, 6);
      ctx.fill();
      ctx.strokeStyle = L.isSel ? 'rgba(255,255,255,0.55)' : 'rgba(255,224,138,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = NEST.label;
      ctx.fillText(text, lx + 6 + tw / 2, ly + lh / 2 + 0.5);
    }
    ctx.textAlign = 'left';
  }

  function layerOfChamber(d, c, k) {
    const dc = d && d.nest && d.nest.chambers ? d.nest.chambers[k] : null;
    if (dc && dc.uid === c.uid && dc.layer) return dc.layer;
    const counts = {};
    let best = null;
    let bestN = -1;
    for (let y = c.y; y < c.y + c.h; y++) {
      const L = layerAt(y);
      counts[L] = (counts[L] || 0) + c.w;
      if (counts[L] >= bestN) {
        bestN = counts[L];
        best = L;
      }
    }
    return best;
  }

  function queenPos(c, r, unit) {
    const grow = 1 + Math.min(0.5, 0.07 * ((c.level || 1) - 1));
    return { x: r.x + r.w * 0.4, y: r.y + r.h - unit * (0.18 + 0.42 * grow) };
  }

  function drawRoyal(ctx, s, d, c, r, unit, plan, box) {
    const lvl = Math.max(1, c.level || 1);
    const grow = 1 + Math.min(0.5, 0.07 * (lvl - 1));
    const q = queenPos(c, r, unit);
    const pulse = queenPulse > 0 ? Math.sin((1 - queenPulse / 0.45) * Math.PI) : 0;
    // her eggs heaped beside her
    if (plan) {
      const ex = q.x + unit * 1.25 * grow;
      art.drawBroodHeaps(ctx, { x: ex, y: box.y, w: Math.max(unit, box.x + box.w - ex - unit * 0.15), h: box.h }, plan, false, unit * 0.9, 18);
    }
    // a soft warm glow on the floor under the queen
    ctx.fillStyle = 'rgba(255,214,150,0.08)';
    ctx.beginPath();
    ctx.ellipse(q.x, q.y + unit * 0.3, unit * 1.5 * grow, unit * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(q.x, q.y + unit * 0.36 * grow, unit * 0.85 * grow, unit * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
    // abdomen pulse glow
    if (pulse > 0) {
      ctx.fillStyle = `rgba(255,236,190,${0.35 * pulse})`;
      ctx.beginPath();
      ctx.ellipse(q.x - unit * 0.45 * grow, q.y, unit * 0.42 * grow * (1 + 0.15 * pulse), unit * 0.3 * grow * (1 + 0.15 * pulse), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The queen herself, drawn after the worker sprites so attendants never hide her. */
  function drawQueen(ctx, s, unit) {
    cosmetics.syncAntTint(s);   // C149 palette cosmetic: amber-tinted ants (once per frame, before any ant is drawn)
    const c = royalRect();
    if (!c || !(c.uid >= 0) || !(c.status === 'active' || c.status === 'growing')) return;
    const r = chamberRectPx(c);
    if (r.y > layer.cssH || r.y + r.h < 0) return;
    const lvl = Math.max(1, c.level || 1);
    const grow = 1 + Math.min(0.5, 0.07 * (lvl - 1));
    const q = queenPos(c, r, unit);
    const hungry = !!s.run.colony.hungry;
    const pulse = queenPulse > 0 ? Math.sin((1 - queenPulse / 0.45) * Math.PI) : 0;
    const ang = hungry ? 0.22 : Math.sin(time * 0.8) * 0.04;
    atlas.drawAnt(ctx, 'queen', 'none', ang, 0, q.x, q.y + (hungry ? unit * 0.08 : 0), unit * grow * (1 + 0.04 * pulse), cosmetics.queenTint(s), NEST.antOutline);
    if (hungry) {
      ctx.fillStyle = 'rgba(80,60,50,0.25)';
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, unit * 1.0 * grow, unit * 0.4 * grow, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // C149 crown cosmetic (Crown, or Golden Queen: glow + jewelled crown)
    cosmetics.drawQueenCosmetic(ctx, s, q.x, q.y, unit * grow, time);
  }

  /** "House full" pip over the Royal Chamber (diegetic hint, DESIGN §25.6); drawn outside the cavity clip. */
  function drawHousePip(ctx, s, d, unit) {
    const st = d && d.stats;
    if (!st || !(st.housing > 0)) return;
    const used = (s.run.colony.adults ? s.run.colony.adults.minor || 0 : 0) + broodTotal(s);
    if (used < st.housing) return;
    const c = royalRect();
    if (!c || !(c.uid >= 0)) return;
    const r = chamberRectPx(c);
    const px = r.x + r.w - unit * 0.5;
    const py = r.y - unit * 0.1;
    const bob = Math.sin(time * 3) * 1.5;
    const k = Math.max(6, unit * 0.4);
    ctx.fillStyle = '#ffe08a';
    ctx.beginPath();
    ctx.moveTo(px - k, py + bob);
    ctx.lineTo(px, py - k * 0.85 + bob);
    ctx.lineTo(px + k, py + bob);
    ctx.lineTo(px + k * 0.8, py + bob);
    ctx.lineTo(px + k * 0.8, py + k * 0.85 + bob);
    ctx.lineTo(px - k * 0.8, py + k * 0.85 + bob);
    ctx.lineTo(px - k * 0.8, py + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#5a2a10';
    ctx.font = `700 ${Math.round(k * 1.2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', px, py + k * 0.25 + bob);
    ctx.textAlign = 'left';
  }

  function drawAlates(ctx, box, unit, n, cellsCap) {
    if (!(n > 0)) return;
    const per = Math.max(1, Math.floor(box.w / (unit * 0.75)));
    const rows = Math.max(1, Math.floor(box.h / (unit * 0.8)));
    const shown = Math.min(Math.ceil(n), cellsCap > 0 ? Math.min(25, cellsCap) : 25, per * rows);
    for (let k = 0; k < shown; k++) {
      const x = box.x + unit * 0.45 + (k % per) * ((box.w - unit * 0.9) / Math.max(1, per - 1));
      const y = box.y + box.h - unit * 0.45 - Math.floor(k / per) * unit * 0.7;
      atlas.drawAnt(ctx, 'alate', 'none', k % 2 ? Math.PI : 0, (reduced ? 0 : Math.floor(time * 4 + k) & 1), x, y, unit * 0.9, null, NEST.antOutline);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // world layers: sky, frost, flood, mold, pupa, dig queue, ghost
  // ---------------------------------------------------------------------------------------------------------------

  function drawSky(ctx, s, d, W) {
    const v = view();
    // C123: sky and grass line blend into the next season over its last SEASON_BLEND_SEC (palette.seasonBlend)
    const sb = seasonBlend(d && d.season);
    const [top, bot] = blendSky(sb);
    // C113 (player report): the mound is sized in cells (world units, by its level) and anchored to the surface line, so
    // it scrolls with the nest. It used to be capped at 90 % of the visible sky band (min(oy × 0.9, …)), so scrolling
    // squashed it into a sliver (and zooming bloated it into a dome filling the sky) until it vanished at oy = 0.
    const mound = (s.run.surface && s.run.surface.mound) || 0;
    const mh = v.cell * Math.min(MOUND_MAX_CELLS, 0.6 + Math.log2(1 + mound) * 0.45);
    if (v.oy > -mh) {
      if (v.oy > 0) {
        const g = ctx.createLinearGradient(0, 0, 0, v.oy);
        g.addColorStop(0, top);
        g.addColorStop(1, bot);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, v.oy);
      }
      // mound silhouette over the main shaft (peak at oy − mh)
      const mx = v.ox + (GRID.mainCol + 0.5) * v.cell;
      ctx.fillStyle = '#7a5232';
      ctx.beginPath();
      ctx.moveTo(mx - mh * 2.4, v.oy + 1);
      ctx.quadraticCurveTo(mx, v.oy - mh * 2, mx + mh * 2.4, v.oy + 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#1e120a';
      ctx.beginPath();
      ctx.ellipse(mx, v.oy - mh * 0.15, v.cell * 0.35, v.cell * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      // grass line
      const grass = blendSeasonColor(GRASS_LINE, sb);
      ctx.strokeStyle = grass;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let x = 0; x < W; x += 3) {
        if (Math.abs(x - mx) < mh * 2.2) continue;
        const h = 3 + hash01(x, 7) * 5;
        const sway = Math.sin(time * 1.5 + x * 0.1) * (reduced ? 0 : 1);
        ctx.moveTo(x, v.oy);
        ctx.lineTo(x + sway + (hash01(x, 9) - 0.5) * 2, v.oy - h);
      }
      ctx.stroke();
      // extra entrances
      for (const t of geo.tops) {
        if (t.kind === 'main') continue;
        const x = v.ox + (t.col + 0.5) * v.cell;
        ctx.fillStyle = '#6a4628';
        ctx.beginPath();
        ctx.moveTo(x - v.cell * 1.2, v.oy + 1);
        ctx.quadraticCurveTo(x, v.oy - v.cell * 0.9, x + v.cell * 1.2, v.oy + 1);
        ctx.fill();
        ctx.fillStyle = '#1e120a';
        ctx.beginPath();
        ctx.ellipse(x, v.oy - v.cell * 0.1, v.cell * 0.3, v.cell * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Soil either side of the grid, continuous with the strata (the margin cache; mirrored when the margin is wider
   * than the cached columns), so the cross-section reads as one ant farm at any width.
   */
  function drawMargins(ctx, W, H) {
    const v = view();
    const gw = COLS * v.cell;
    if (v.ox <= 0 && v.ox + gw >= W) return;
    syncMargin();
    const r0 = clamp(Math.floor(-v.oy / v.cell), 0, ROWS);
    const r1 = clamp(Math.ceil((H - v.oy) / v.cell), 0, ROWS);
    if (r1 <= r0) return;
    const y = v.oy + r0 * v.cell;
    const h = (r1 - r0) * v.cell;
    const M = MARGIN_COLS;
    const span = M * v.cell;
    if (!margin.canvas) {
      for (const L of layerList()) {
        const P = STRATA[L.id] || STRATA.loam;
        ctx.fillStyle = shade(P.base, -0.3);
        const ly = v.oy + L.y0 * v.cell;
        const lh = (L.y1 - L.y0 + 1) * v.cell;
        if (v.ox > 0) ctx.fillRect(0, ly, v.ox, lh);
        if (v.ox + gw < W) ctx.fillRect(v.ox + gw, ly, W - v.ox - gw, lh);
      }
      return;
    }
    const cpm = margin.cpm;
    const sy = r0 * cpm;
    const sh = (r1 - r0) * cpm;
    // left: the cached columns right next to the grid, then alternately mirrored copies (seamless) to the edge
    if (v.ox > 0) {
      const n = Math.min(M, Math.ceil(v.ox / v.cell));
      ctx.drawImage(margin.canvas, (M - n) * cpm, sy, n * cpm, sh, v.ox - n * v.cell, y, n * v.cell, h);
      for (let k = 1; v.ox - k * span > 0 && k < 12; k++) {
        const right = v.ox - k * span;
        ctx.save();
        if (k % 2) {
          ctx.translate(right, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(margin.canvas, 0, sy, M * cpm, sh, 0, y, span, h);
        } else {
          ctx.drawImage(margin.canvas, 0, sy, M * cpm, sh, right - span, y, span, h);
        }
        ctx.restore();
      }
    }
    const rx = v.ox + gw;
    if (rx < W) {
      const room = W - rx;
      const n = Math.min(M, Math.ceil(room / v.cell));
      ctx.drawImage(margin.canvas, M * cpm, sy, n * cpm, sh, rx, y, n * v.cell, h);
      for (let k = 1; k * span < room && k < 12; k++) {
        const left = rx + k * span;
        ctx.save();
        if (k % 2) {
          ctx.translate(left + span, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(margin.canvas, M * cpm, sy, M * cpm, sh, 0, y, span, h);
        } else {
          ctx.drawImage(margin.canvas, M * cpm, sy, M * cpm, sh, left, y, span, h);
        }
        ctx.restore();
      }
    }
    // dim the margins (soft ramp at the grid edge) so the diggable grid reads as the lit stage
    const ramp = Math.min(3 * v.cell, 40);
    ctx.fillStyle = 'rgba(14,8,3,0.3)';
    if (v.ox > ramp) ctx.fillRect(0, y, v.ox - ramp, h);
    if (W - rx > ramp) ctx.fillRect(rx + ramp, y, W - rx - ramp, h);
    if (v.ox > 0) {
      const gL = ctx.createLinearGradient(v.ox - ramp, 0, v.ox, 0);
      gL.addColorStop(0, 'rgba(14,8,3,0.3)');
      gL.addColorStop(1, 'rgba(14,8,3,0.04)');
      ctx.fillStyle = gL;
      ctx.fillRect(Math.max(0, v.ox - ramp), y, Math.min(ramp, v.ox), h);
    }
    if (rx < W) {
      const gR = ctx.createLinearGradient(rx, 0, rx + ramp, 0);
      gR.addColorStop(0, 'rgba(14,8,3,0.04)');
      gR.addColorStop(1, 'rgba(14,8,3,0.3)');
      ctx.fillStyle = gR;
      ctx.fillRect(rx, y, Math.min(ramp, W - rx), h);
    }
  }

  function drawHints(ctx, s, d) {
    const v = view();
    const hints = hintCells(s, d);
    const a = 0.45 + 0.25 * Math.sin(time * 2.4);
    for (const i of hints) {
      const x = v.ox + (i % COLS) * v.cell;
      const y = v.oy + Math.floor(i / COLS) * v.cell;
      ctx.fillStyle = rgba(NEST.hint, a * 0.55);
      ctx.beginPath();
      ctx.ellipse(x + v.cell / 2, y + v.cell / 2, v.cell * 0.62, v.cell * 0.5, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba('#fff2c8', a * 0.9);
      ctx.fillRect(x + v.cell * 0.45, y + v.cell * 0.3, Math.max(1, v.cell * 0.12), Math.max(1, v.cell * 0.12));
    }
  }

  function drawFrost(ctx, d, W) {
    const v = view();
    const fr = d && d.season ? d.season.frostRow || 0 : 0;
    const sn = d && d.season ? d.season.snapRow || 0 : 0;
    // the frost reaches across the whole cross-section, margins included
    const x0 = Math.min(0, v.ox);
    const w = Math.max(W, COLS * v.cell);
    if (sn > 0) {
      ctx.fillStyle = 'rgba(210,235,255,0.16)';
      ctx.fillRect(x0, v.oy, w, sn * v.cell);
    }
    if (!(fr > 0)) return;
    const y = v.oy + fr * v.cell;
    const g = ctx.createLinearGradient(0, v.oy, 0, y);
    g.addColorStop(0, 'rgba(225,242,255,0.10)');
    g.addColorStop(1, 'rgba(225,242,255,0.26)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, v.oy, w, y - v.oy);
    ctx.strokeStyle = 'rgba(159,208,255,0.45)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + w, y);
    ctx.stroke();
    ctx.strokeStyle = NEST.frostEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0 + 3; x < x0 + w; x += 7) {
      const h = 2 + hash01(Math.round(x), 5) * 4;
      ctx.moveTo(x, y);
      ctx.lineTo(x + 1, y - h);
      ctx.moveTo(x - 1.5, y - h * 0.5);
      ctx.lineTo(x + 2.5, y - h * 0.6);
    }
    ctx.stroke();
  }

  function floodActive(s) {
    const eff = safe(() => effectsFor(s, 'chamber_layer'), []);
    for (const e of eff) if (e && e.scope === 'topsoil' && e.mult === 0) return true;
    const act = (s.run.events && s.run.events.active) || [];
    for (const a of act) if (a && a.id === 'ev_rainstorm' && a.data && a.data.flood) return true;
    return false;
  }

  function drawFlood(ctx, s) {
    if (!floodActive(s)) return;
    const v = view();
    const fr = (DIG && DIG.floodRows) || [0, 5];
    ctx.fillStyle = rgba(NEST.flood, 0.62);
    ctx.beginPath();
    for (let y = fr[0]; y <= fr[1]; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        if (fields.open[i]) ctx.rect(v.ox + x * v.cell, v.oy + y * v.cell, v.cell, v.cell);
      }
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,235,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const y0 = v.oy + fr[0] * v.cell + 2;
    for (let x = v.ox; x < v.ox + COLS * v.cell; x += 6) {
      ctx.moveTo(x, y0 + Math.sin(time * 3 + x * 0.2) * 1.5);
      ctx.lineTo(x + 3, y0 + Math.sin(time * 3 + (x + 3) * 0.2) * 1.5);
    }
    ctx.stroke();
  }

  function moldSpots(s) {
    const out = [];
    for (const o of (s.run.events && s.run.events.objects) || []) {
      if (!o || o.kind !== 'mold') continue;
      let i = o.cell;
      if (!(i >= 0) && o.data && o.data.chamber) {
        const c = chamberByUid(o.data.chamber);
        if (c) i = (c.y + Math.floor(c.h / 2)) * COLS + c.x + Math.floor(c.w * hash01(o.uid, 3));
      }
      if (i >= 0) out.push({ uid: o.uid, i });
    }
    return out;
  }

  function drawMold(ctx, s) {
    const v = view();
    // A pulsing ring makes each spot findable at overview zoom (a spot is one cell; each halves its chamber until
    // clicked, and unscraped spots spread). No pulse with reduced motion.
    for (const m of moldSpots(s)) {
      const p = cellCenter(m.i);
      if (p.y < -30 || p.y > layer.cssH + 30) continue;
      const pulse = reduced ? 1 : ((time * 0.4 + hash01(m.uid, 1)) % 1);
      art.drawMoldSpot(ctx, p.x, p.y, v.cell, m.uid, pulse);
    }
  }

  function pupaPos(s) {
    const pu = s.run.golden && s.run.golden.pupa;
    if (!pu) return null;
    const c = chamberByUid(pu.chamber);
    if (!c) return null;
    const r = chamberRectPx(c);
    return { x: r.x + r.w * 0.7, y: r.y + r.h * 0.55 };
  }

  function drawPupa(ctx, s, unit) {
    const p = pupaPos(s);
    if (!p) return;
    const a = 0.5 + 0.5 * Math.sin(time * 6);
    ctx.fillStyle = `rgba(255,214,80,${0.25 + 0.25 * a})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, unit * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd447';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, unit * 0.18, unit * 0.32, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff6c2';
    ctx.beginPath();
    ctx.ellipse(p.x - unit * 0.05, p.y - unit * 0.1, unit * 0.05, unit * 0.1, 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawDigQueue(ctx, s, d) {
    const v = view();
    const q = s.run.nest.queue || [];
    let budget = 400;
    ctx.lineWidth = 1;
    for (let j = 0; j < q.length; j++) {
      const job = q[j];
      if (!job || !Array.isArray(job.cells)) continue;
      ctx.strokeStyle = j === 0 ? 'rgba(255,210,122,0.75)' : 'rgba(244,227,193,0.45)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      for (let k = Math.max(0, job.cur); k < job.cells.length && budget > 0; k++, budget--) {
        const i = job.cells[k];
        ctx.rect(v.ox + (i % COLS) * v.cell + 1.5, v.oy + Math.floor(i / COLS) * v.cell + 1.5, v.cell - 3, v.cell - 3);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const head = job.cells[job.cur];
      if (head >= 0) {
        const p = cellCenter(head);
        ctx.fillStyle = 'rgba(20,12,6,0.8)';
        ctx.beginPath();
        ctx.arc(p.x + v.cell * 0.45, p.y - v.cell * 0.45, Math.max(5, v.cell * 0.36), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = NEST.queueTag;
        ctx.font = `700 ${Math.max(7, v.cell * 0.5)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(j + 1), p.x + v.cell * 0.45, p.y - v.cell * 0.43);
      }
    }
    const face = digFace(s, d);
    if (face >= 0) {
      const p = cellCenter(face);
      const job = q[0];
      const work = job ? safe(() => nestgeom.cellWork(s, face, job.kind), 0) : 0;
      const frac = job && work > 0 ? clamp(job.prog / work, 0, 1) : (time * 0.5) % 1;
      ctx.strokeStyle = NEST.digFace;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, v.cell * 0.42, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,210,122,${0.25 + 0.2 * Math.sin(time * 8)})`;
      ctx.fillRect(p.x - v.cell / 2, p.y - v.cell / 2, v.cell, v.cell);
      if (uiOf(ui).glow === 'canvas:digFace') {
        const k = (time * 0.9) % 1;
        ctx.strokeStyle = `rgba(255,236,160,${0.85 * (1 - k)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, v.cell * (0.6 + 1.1 * k), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /**
   * C117 / C118 tool ghosts: the moved water pocket (same size, centred on the cursor) or the cultivated root's column
   * (row y0 down to where it would stop). res = { ok, tint, reason }.
   */
  const featMemo = { key: '', res: null };
  function featureGhost(s, d, cellIdx, tool) {
    const cx = cellIdx % COLS;
    const cy = Math.floor(cellIdx / COLS);
    if (tool.kind === 'growRoot') {
      const key = 'root|' + cx + '|' + s.run.nest.rev + '|' + JSON.stringify(s.run.res && [s.run.res.food, s.run.res.honeydew]);
      if (featMemo.key !== key) {
        featMemo.key = key;
        featMemo.res = safe(() => nestSys.rootPreview(s, d, cx), null) || { ok: false, reason: 'invalid', y0: 1, y1: 1 };
      }
      const r = featMemo.res;
      return { type: 'root', x: cx, y: r.y0 || 1, w: 1, h: Math.max(1, (r.y1 || 1) - (r.y0 || 1) + 1), col: cx,
        res: { ok: !!r.ok, tint: r.ok ? 'green' : 'red', reason: r.reason, cost: r.cost } };
    }
    const water = (s.run.nest.features && s.run.nest.features.water) || [];
    const p = water[tool.pocket];
    if (!p) return null;
    const x = clamp(cx - Math.floor((p.w - 1) / 2), 0, COLS - p.w);
    const y = clamp(cy - Math.floor((p.h - 1) / 2), 0, ROWS - p.h);
    const key = 'pocket|' + tool.pocket + '|' + x + '|' + y + '|' + s.run.nest.rev;
    if (featMemo.key !== key) {
      featMemo.key = key;
      const a = safe(() => nestSys.pocketAction(s, d, tool.pocket, { x, y }), null);
      featMemo.res = a ? { ok: a.ok, tint: a.ok ? 'green' : 'red', reason: a.reason, work: a.work, fill: a.fill || [] } : { ok: false, tint: 'red', reason: 'invalid' };
    }
    return { type: 'pocket', x, y, w: p.w, h: p.h, res: featMemo.res };
  }

  /** C117 / C118: draw the pocket-move or grow-root ghost under the cursor. */
  function drawFeatureGhost(ctx, s, d, tool, v) {
    const cell = input.hoverCell;
    if (!(cell >= 0)) return;
    const g = featureGhost(s, d, cell, tool);
    if (!g) return;
    const ok = g.res && g.res.ok;
    const x = v.ox + g.x * v.cell;
    const y = v.oy + g.y * v.cell;
    ctx.fillStyle = g.type === 'pocket' ? (ok ? 'rgba(80,160,220,0.45)' : 'rgba(229,72,77,0.35)') : (ok ? 'rgba(150,200,110,0.35)' : 'rgba(229,72,77,0.3)');
    ctx.fillRect(x, y, g.w * v.cell, g.h * v.cell);
    ctx.strokeStyle = ok ? 'rgba(170,230,140,0.9)' : 'rgba(229,72,77,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, g.w * v.cell - 1, g.h * v.cell - 1);
    ctx.setLineDash([]);
    // C157: tunnel cells under the new spot are filled in as part of the move (soil-brown hatch)
    const fill = ok && g.res && Array.isArray(g.res.fill) ? g.res.fill : [];
    if (fill.length) hatchCells(ctx, fill, v, 'rgba(196,150,96,0.85)', Math.max(4, v.cell * 0.35));
    let text = '';
    if (!ok) text = g.res && g.res.reason ? String(g.res.reason) : 'invalid';
    else if (g.type === 'root') text = 'Root to row ' + (g.y + g.h - 1);
    else text = 'Move here' + (fill.length ? ' · fills ' + fill.length + ' tunnel cell' + (fill.length === 1 ? '' : 's') : '')
      + (g.res && g.res.work > 0 ? ' · ' + Math.round(g.res.work) + ' work' : '');
    if (!ok) text = REASON_SHORT[text] || 'Cannot go here';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const lx = x + g.w * v.cell + 6;
    const ly = y + 8;
    ctx.fillStyle = 'rgba(15,8,3,0.82)';
    ctx.fillRect(lx - 3, ly - 7, tw + 6, 14);
    ctx.fillStyle = ok ? '#e8ffd0' : '#ffb4b4';
    ctx.fillText(text, lx, ly);
  }

  /** Ghost rect for a tool at a cursor cell (shared with nestInput.js). */
  function ghostAt(cellIdx, tool) {
    const s = S();
    const d = D();
    if (!s || !tool || !(cellIdx >= 0)) return null;
    if (tool.kind === 'movePocket' || tool.kind === 'growRoot') return featureGhost(s, d, cellIdx, tool);
    let type = null;
    let w = 0;
    let h = 0;
    let relocateUid = 0;
    if (tool.kind === 'placeChamber') {
      type = tool.chamber;
      const fp = safe(() => nestgeom.footprint(type, 1), null);
      w = fp && fp.w > 0 ? fp.w : 0;
      h = fp && fp.h > 0 ? fp.h : 0;
      const def = CHAMBERS && CHAMBERS[type];
      if (!(w > 0) && def) {
        w = def.w0 || 0;
        h = def.h0 || 0;
      }
      if (!(w > 0)) {
        w = 3;
        h = 2;
      }
    } else if (tool.kind === 'relocate') {
      const c = chamberByUid(tool.uid);
      if (!c) return null;
      type = c.type;
      w = c.w;
      h = c.h;
      relocateUid = c.uid;
    } else return null;
    const cx = cellIdx % COLS;
    const cy = Math.floor(cellIdx / COLS);
    const x = clamp(cx - Math.floor((w - 1) / 2), 0, COLS - w);
    const y = clamp(cy - Math.floor((h - 1) / 2), 0, ROWS - h);
    const rev = d && d.nest ? d.nest.rev : 0;
    const anchor = tool.anchor || null; // C137: the start corner picked with F / right-click (null = auto)
    const key = `${type}|${x}|${y}|${rev}|${s.run.nest.rev}|${relocateUid}|${anchor}`;
    if (ghostMemo.key !== key) {
      ghostMemo.key = key;
      ghostMemo.res = safe(() => nestSys.validatePlacement(s, d, type, x, y, { relocateUid, anchor }), null)
        || { ok: false, tint: 'red', reason: 'invalid', route: null, mods: [] };
    }
    return { type, x, y, w, h, res: ghostMemo.res, relocateUid };
  }

  /** A planned passage: a rounded, dashed tube through the cell centres (ordered cells), dots where it turns. */
  function previewPassage(ctx, cells, color, v) {
    if (!cells || !cells.length) return;
    const pt = (i) => [v.ox + ((i % COLS) + 0.5) * v.cell, v.oy + (((i / COLS) | 0) + 0.5) * v.cell];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(15,8,3,0.45)';
    ctx.lineWidth = Math.max(4, v.cell * 0.62);
    const trace = () => {
      ctx.beginPath();
      let prev = -1;
      for (const i of cells) {
        const [x, y] = pt(i);
        const adj = prev >= 0 && (Math.abs(prev - i) === COLS || (Math.abs(prev - i) === 1 && ((prev / COLS) | 0) === ((i / COLS) | 0)));
        if (adj) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.01, y);
        }
        prev = i;
      }
      ctx.stroke();
    };
    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2.5, v.cell * 0.44);
    ctx.setLineDash([Math.max(3, v.cell * 0.5), Math.max(2, v.cell * 0.3)]);
    trace();
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
  }

  /**
   * C99: while placing a chamber with a row rule (Nuptial Chamber and Fungus Garden at depth 24, Hibernaculum 30, Deep
   * Vault 58, Gate rows 0–6…), the rows it may not use are dimmed and the limit is a labelled line across the nest.
   */
  function drawDepthRule(ctx, rows, v) {
    if (!rows) return;
    const minRow = Number(rows.min);
    const maxRow = Number(rows.max);
    const left = v.ox;
    const width = COLS * v.cell;
    const line = (row, label) => {
      const y = v.oy + row * v.cell;
      ctx.strokeStyle = 'rgba(255,214,120,0.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(15,8,3,0.82)';
      ctx.fillRect(left + width - tw - 8, y - 15, tw + 6, 14);
      ctx.fillStyle = '#ffd27a';
      ctx.fillText(label, left + width - 4, y - 2);
    };
    if (Number.isFinite(minRow) && minRow > 1) {
      ctx.fillStyle = 'rgba(229,72,77,0.10)';
      ctx.fillRect(left, v.oy, width, minRow * v.cell);
      line(minRow, `Depth ${minRow}: place at or below this line`);
    }
    if (Number.isFinite(maxRow) && maxRow < ROWS - 1) {
      ctx.fillStyle = 'rgba(229,72,77,0.10)';
      ctx.fillRect(left, v.oy + (maxRow + 1) * v.cell, width, (ROWS - maxRow - 1) * v.cell);
      line(maxRow + 1, `Row ${maxRow}: place at or above this line`);
    }
  }

  function drawGhost(ctx, s, d, tool, unit) {
    const v = view();
    const hc = input.hoverCell >= 0 ? input.hoverCell : (() => {
      const h = uiOf(ui).hover;
      return h && h.view === 'nest' && h.i >= 0 ? h.i : -1;
    })();
    const g = ghostAt(hc, tool);
    if (!g) return;
    const res = g.res || {};
    const tint = res.tint === 'green' ? NEST.ghostOk : res.tint === 'amber' ? NEST.ghostWarn : NEST.ghostBad;
    // raid reach zone while placing
    drawNestOverlays(ctx, { raid_reach: true }, overlayInfo(s, d));
    drawDepthRule(ctx, res.rows, v);
    if (Array.isArray(res.route)) previewPassage(ctx, res.route, rgba(tint, 0.55), v);
    const x = v.ox + g.x * v.cell;
    const y = v.oy + g.y * v.cell;
    // C137: the full-size room it reserves (dashed, a light wash), the small L1 room drawn inside it below; red when the
    // reservation itself is refused. Obstacles inside (stone, water) are crossed: growth waits for them.
    const R = res.res;
    if (R && (R.w > g.w || R.h > g.h)) {
      const resBad = typeof res.reason === 'string' && res.reason.startsWith('resv:');
      const rc = resBad ? NEST.ghostBad : tint;
      ctx.fillStyle = rgba(rc, resBad ? 0.16 : 0.1);
      ctx.fillRect(v.ox + R.x * v.cell, v.oy + R.y * v.cell, R.w * v.cell, R.h * v.cell);
      ctx.strokeStyle = rgba(rc, 0.8);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(v.ox + R.x * v.cell + 0.5, v.oy + R.y * v.cell + 0.5, R.w * v.cell - 1, R.h * v.cell - 1);
      ctx.setLineDash([]);
      const cellsArr = s.run.nest.cells;
      ctx.strokeStyle = 'rgba(255,200,120,0.85)';
      ctx.lineWidth = Math.max(1, v.cell * 0.08);
      ctx.beginPath();
      for (let yy = R.y; yy < R.y + R.h; yy++) {
        for (let xx = R.x; xx < R.x + R.w; xx++) {
          if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) continue;
          const code = cellsArr[yy * COLS + xx];
          if (code !== CELL.STONE && code !== CELL.WATER) continue;
          if (code === CELL.WATER && !cache.water[yy * COLS + xx]) continue; // C173: an unrevealed pocket never shows
          const px = v.ox + xx * v.cell;
          const py = v.oy + yy * v.cell;
          const m = v.cell * 0.25;
          ctx.moveTo(px + m, py + m);
          ctx.lineTo(px + v.cell - m, py + v.cell - m);
          ctx.moveTo(px + v.cell - m, py + m);
          ctx.lineTo(px + m, py + v.cell - m);
        }
      }
      ctx.stroke();
    }
    // the footprint (thin, dashed) and the cavity it will become
    ctx.strokeStyle = rgba(tint, 0.55);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, g.w * v.cell - 1, g.h * v.cell - 1);
    ctx.setLineDash([]);
    ctx.beginPath();
    art.tracePath(ctx, art.chamberOutline({ uid: 0, x: g.x, y: g.y, w: g.w, h: g.h }), v.ox, v.oy, v.cell);
    ctx.fillStyle = rgba(tint, 0.32);
    ctx.fill();
    ctx.strokeStyle = tint;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const lines = [];
    if (!res.ok && res.reason) lines.push({ t: ghostRefusal(res), c: '#ffb3b0' });
    else lines.push({ t: chamberName(g.type), c: '#f6ead2' });
    // C109: the chambers the ghost would link to: highlighted, joined by a line, and labelled with the bonus (red for a
    // Midden hygiene hit); when relocating, the links it would lose are listed too.
    const links = Array.isArray(res.links) ? res.links : [];
    const lost = Array.isArray(res.lost) ? res.lost : [];
    const gcx = x + (g.w * v.cell) / 2;
    const gcy = y + (g.h * v.cell) / 2;
    for (const l of links) {
      const pc = l.uid ? chamberByUid(l.uid) : null;
      if (!pc) continue;
      const col = l.good ? NEST.ghostOk : NEST.ghostBad;
      const pr = chamberRectPx(pc);
      ctx.strokeStyle = rgba(col, 0.9);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(gcx, gcy);
      ctx.lineTo(pr.x + pr.w / 2, pr.y + pr.h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      chamberPath(ctx, pc, v, 2);
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    for (const l of lost) {
      const pc = l.uid ? chamberByUid(l.uid) : null;
      if (!pc) continue;
      ctx.strokeStyle = rgba(NEST.ghostWarn, 0.8);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      chamberPath(ctx, pc, v, 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const modText = { frostExposed: 'Frost-exposed in winter', floodZone: 'Flood zone', raidReach: 'Within raid reach', haul: 'Haul', layer: 'Layer', adjacency: 'Adjacency', hygiene: 'Hygiene −20%',
      royalRoom: 'Boxes in the Royal Chamber (Flight needs L' + FLIGHT.royalLevel + ')' };
    const WARN = new Set(['frostExposed', 'raidReach', 'hygiene', 'floodZone', 'royalRoom']);
    for (const l of links) lines.push({ t: linkLabel(l), c: l.good ? '#c8f0c0' : '#ffb3b0' });
    for (const l of lost) if (l.good) lines.push({ t: linkLabel(l, true), c: '#ffd27a' });
    // C137: the reserved room and the F key
    if (R && (R.w > g.w || R.h > g.h)) {
      const nAnc = Array.isArray(res.anchors) ? res.anchors.length : 0;
      if (res.obstacles > 0) lines.push({ t: `Full size ${R.w}×${R.h}: ${res.obstacles} stone/water cell${res.obstacles === 1 ? '' : 's'} hold growth back`, c: '#ffd27a' });
      else lines.push({ t: `Full size ${R.w}×${R.h} reserved`, c: '#f6ead2' });
      if (nAnc > 1) lines.push({ t: 'F / right-click: start in another corner', c: '#d8c8a8' });
    }
    for (const m of res.mods || []) {
      if (!m || !m.key) continue;
      // adjacency / hygiene are spelled out by the link lines above (C109)
      if ((m.key === 'adjacency' || m.key === 'hygiene') && (links.length || lost.length)) continue;
      // raidReach carries the path distance to the nearest entrance; the others are multipliers or bonuses.
      const val = m.key === 'raidReach' && Number.isFinite(m.value) ? ` (${Math.round(m.value)} cells)`
        : Number.isFinite(m.value) ? ` ${m.value > 0 && m.key !== 'haul' ? '+' : ''}${Math.round(m.value * 100) / 100}` : '';
      lines.push({ t: `${modText[m.key] || m.key}${val}`, c: WARN.has(m.key) ? '#ffd27a' : '#c8f0c0' });
    }
    let ly = y - 4;
    for (let k = lines.length - 1; k >= 0; k--) {
      const tw = ctx.measureText(lines[k].t).width;
      ctx.fillStyle = 'rgba(15,8,3,0.8)';
      ctx.fillRect(x - 2, ly - 13, tw + 6, 14);
      ctx.fillStyle = lines[k].c;
      ctx.fillText(lines[k].t, x + 1, ly);
      ly -= 15;
    }
    void unit;
  }

  /** Diagonal hatch over a list of cells (clipped to them). */
  function hatchCells(ctx, list, v, color, gap) {
    if (!list.length) return;
    let x0 = COLS;
    let y0 = ROWS;
    let x1 = -1;
    let y1 = -1;
    ctx.save();
    ctx.beginPath();
    for (const i of list) {
      const x = i % COLS;
      const y = (i / COLS) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      ctx.rect(v.ox + x * v.cell, v.oy + y * v.cell, v.cell, v.cell);
    }
    ctx.clip();
    const L = v.ox + x0 * v.cell;
    const T = v.oy + y0 * v.cell;
    const Wd = (x1 - x0 + 1) * v.cell;
    const Ht = (y1 - y0 + 1) * v.cell;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, v.cell * 0.1);
    ctx.beginPath();
    for (let k = -Ht; k < Wd; k += gap) {
      ctx.moveTo(L + k, T + Ht);
      ctx.lineTo(L + k + Ht, T);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Cells being backfilled (C98; DESIGN §7.3, 10 s each): a soil-coloured fill rising from the floor with the timer, a
   * hatch and a dashed outline, so the player sees what is filling and how far along it is. Always drawn.
   */
  function drawPendingBackfill(ctx, s) {
    const list = s.run.nest.backfill || [];
    if (!list.length) return;
    const v = view();
    const total = Math.max(0.001, Number(DIG && DIG.backfillSec) || 10);
    const cells = [];
    for (const b of list) {
      if (!b || !(b.i >= 0 && b.i < NCELL)) continue;
      cells.push(b.i);
      const p = clamp(1 - (Number(b.t) || 0) / total, 0, 1);
      const x = v.ox + (b.i % COLS) * v.cell;
      const y = v.oy + ((b.i / COLS) | 0) * v.cell;
      ctx.fillStyle = 'rgba(40,22,10,0.35)';
      ctx.fillRect(x, y, v.cell, v.cell);
      ctx.fillStyle = 'rgba(176,122,70,0.85)';
      ctx.fillRect(x, y + v.cell * (1 - p), v.cell, v.cell * p);
    }
    hatchCells(ctx, cells, v, 'rgba(255,214,150,0.55)', Math.max(4, v.cell * 0.4));
    ctx.strokeStyle = 'rgba(255,214,150,0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    for (const i of cells) ctx.rect(v.ox + (i % COLS) * v.cell + 0.5, v.oy + ((i / COLS) | 0) * v.cell + 0.5, v.cell - 1, v.cell - 1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const BACKFILL_WHY = Object.freeze({ 'blocked:disconnect': 'would cut a chamber off', 'blocked:shaft': 'shafts stay open' });

  /**
   * Backfill tool preview (C98): what this stroke (or the hovered cell) will fill (amber hatch), what it cannot (red,
   * with the reason) and what is already filling; a label sums it up.
   */
  function drawBackfillPreview(ctx, s, v) {
    const pv = input.backfill;
    const r = input.rect;
    if (r) {
      ctx.strokeStyle = '#ffd27a';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(v.ox + Math.min(r.x0, r.x1) * v.cell, v.oy + Math.min(r.y0, r.y1) * v.cell,
        (Math.abs(r.x1 - r.x0) + 1) * v.cell, (Math.abs(r.y1 - r.y0) + 1) * v.cell);
      ctx.setLineDash([]);
    }
    if (!pv) return;
    const fill = (list, color) => {
      if (!list.length) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const i of list) ctx.rect(v.ox + (i % COLS) * v.cell, v.oy + ((i / COLS) | 0) * v.cell, v.cell, v.cell);
      ctx.fill();
    };
    const bad = pv.bad.map((b) => b.i);
    fill(pv.ok, 'rgba(255,200,120,0.35)');
    hatchCells(ctx, pv.ok, v, 'rgba(255,226,170,0.8)', Math.max(4, v.cell * 0.35));
    fill(bad, 'rgba(229,72,77,0.45)');
    ctx.strokeStyle = 'rgba(255,170,170,0.95)';
    ctx.lineWidth = Math.max(1, v.cell * 0.09);
    ctx.beginPath();
    for (const i of bad) {
      const x = v.ox + (i % COLS) * v.cell;
      const y = v.oy + ((i / COLS) | 0) * v.cell;
      const m = v.cell * 0.28;
      ctx.moveTo(x + m, y + m);
      ctx.lineTo(x + v.cell - m, y + v.cell - m);
      ctx.moveTo(x + v.cell - m, y + m);
      ctx.lineTo(x + m, y + v.cell - m);
    }
    ctx.stroke();
    // label: "Backfill 6 cells" / "2 stay open: would cut a chamber off"
    const lines = [];
    if (pv.ok.length) lines.push({ t: `Backfill ${pv.ok.length} cell${pv.ok.length === 1 ? '' : 's'} (free, ${Math.round(Number(DIG && DIG.backfillSec) || 10)} s)`, c: '#ffe2aa' });
    if (bad.length) {
      const why = BACKFILL_WHY[pv.bad[0].reason] || 'cannot be filled';
      lines.push({ t: pv.ok.length || bad.length > 1 ? `${bad.length} stay open: ${why}` : `Can't backfill: ${why}`, c: '#ffb3b0' });
    }
    if (pv.pending.length && !pv.ok.length && !bad.length) lines.push({ t: 'Already being backfilled', c: '#ffe2aa' });
    if (!lines.length) {
      if (!r || (r.x0 === r.x1 && r.y0 === r.y1)) return;
      lines.push({ t: 'No tunnel cells here', c: '#f6ead2' });
    }
    const ax = v.ox + pv.x0 * v.cell;
    let ly = v.oy + pv.y0 * v.cell - 4;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (let k = lines.length - 1; k >= 0; k--) {
      const tw = ctx.measureText(lines[k].t).width;
      ctx.fillStyle = 'rgba(15,8,3,0.82)';
      ctx.fillRect(ax - 2, ly - 13, tw + 6, 14);
      ctx.fillStyle = lines[k].c;
      ctx.fillText(lines[k].t, ax + 1, ly);
      ly -= 15;
    }
  }

  function drawToolPreviews(ctx, s, d, unit) {
    const tool = uiOf(ui).tool;
    const v = view();
    if (tool && (tool.kind === 'placeChamber' || tool.kind === 'relocate')) drawGhost(ctx, s, d, tool, unit);
    if (tool && (tool.kind === 'movePocket' || tool.kind === 'growRoot')) drawFeatureGhost(ctx, s, d, tool, v);
    if (input.drag && Array.isArray(input.drag.cells)) {
      previewPassage(ctx, input.drag.cells, input.drag.ok === false ? 'rgba(229,72,77,0.7)' : 'rgba(94,209,122,0.75)', v);
      if (Number.isFinite(input.drag.work) && input.drag.work > 0 && input.drag.cells.length) {
        const last = cellCenter(input.drag.cells[input.drag.cells.length - 1]);
        const text = `${input.drag.cells.length} cells`;
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(15,8,3,0.8)';
        ctx.fillRect(last.x + 8, last.y - 8, ctx.measureText(text).width + 6, 13);
        ctx.fillStyle = '#e8ffd0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, last.x + 11, last.y - 1.5);
      }
    }
    if (tool && tool.kind === 'backfill') drawBackfillPreview(ctx, s, v);
    else if (input.rect) {
      const r = input.rect;
      ctx.strokeStyle = '#ffd27a';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(v.ox + Math.min(r.x0, r.x1) * v.cell, v.oy + Math.min(r.y0, r.y1) * v.cell,
        (Math.abs(r.x1 - r.x0) + 1) * v.cell, (Math.abs(r.y1 - r.y0) + 1) * v.cell);
      ctx.setLineDash([]);
    }
    if (tool && tool.kind === 'levelDir') {
      const c = chamberByUid(tool.uid);
      if (c) {
        const key = `${tool.uid}|${s.run.nest.rev}|${c.level}`;
        if (levelMemo.key !== key) {
          levelMemo.key = key;
          levelMemo.res = safe(() => nestSys.levelInfo(s, d, tool.uid), null);
        }
        const dirs = (levelMemo.res && levelMemo.res.dirs) || {};
        // C97: the exact cells the hovered direction adds (one row or one column), so the player sees the growth
        // before confirming; the other offered directions are outlined faintly.
        const rects = (levelMemo.res && levelMemo.res.dirRects) || {};
        for (const dir of ['left', 'right', 'up', 'down']) {
          const nr = rects[dir];
          if (!nr || !dirs[dir]) continue;
          const hot = input.levelDir === dir;
          const add = [];
          for (let y = nr.y; y < nr.y + nr.h; y++) {
            for (let x = nr.x; x < nr.x + nr.w; x++) {
              if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) continue;
              add.push(y * COLS + x);
            }
          }
          if (!add.length) continue;
          ctx.fillStyle = hot ? 'rgba(94,209,122,0.45)' : 'rgba(94,209,122,0.12)';
          ctx.beginPath();
          for (const i of add) ctx.rect(v.ox + (i % COLS) * v.cell, v.oy + ((i / COLS) | 0) * v.cell, v.cell, v.cell);
          ctx.fill();
          if (hot) {
            ctx.strokeStyle = NEST.ghostOk;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 2]);
            ctx.stroke();
            ctx.setLineDash([]);
            const tx = v.ox + nr.x * v.cell;
            const ty = v.oy + nr.y * v.cell - 4;
            const label = `+${add.length} cells (${dir})`;
            ctx.font = '600 11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(15,8,3,0.82)';
            ctx.fillRect(tx - 2, ty - 13, ctx.measureText(label).width + 6, 14);
            ctx.fillStyle = '#c8f0c0';
            ctx.fillText(label, tx + 1, ty);
          }
        }
        const r = chamberRectPx(c);
        const arrows = [['left', r.x - unit * 0.6, r.y + r.h / 2, Math.PI], ['right', r.x + r.w + unit * 0.6, r.y + r.h / 2, 0],
          ['up', r.x + r.w / 2, r.y - unit * 0.6, -Math.PI / 2], ['down', r.x + r.w / 2, r.y + r.h + unit * 0.6, Math.PI / 2]];
        for (const [dir, ax, ay, ang] of arrows) {
          const ok = !!dirs[dir];
          const hot = input.levelDir === dir;
          ctx.save();
          ctx.translate(ax, ay);
          ctx.rotate(ang);
          ctx.fillStyle = ok ? (hot ? '#ffffff' : NEST.ghostOk) : 'rgba(160,160,160,0.6)';
          ctx.beginPath();
          ctx.moveTo(unit * 0.5, 0);
          ctx.lineTo(-unit * 0.3, -unit * 0.4);
          ctx.lineTo(-unit * 0.3, unit * 0.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
    // onboarding ghost-ant demo (chamber drop): ui/onboarding.js sends { kind: 'chamber', from: chamberType, to: cell }
    // (the top-left cell of the suggested footprint); a cell index or {x, y} in `from` is accepted as a start cell too
    const demo = uiOf(ui).ghostDemo;
    if (demo && demo.kind === 'chamber') drawChamberDemo(ctx, demo, unit);
  }

  function drawChamberDemo(ctx, demo, unit) {
    const toCell = (p) => (Number.isFinite(p) ? p : p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p.y * COLS + p.x : -1);
    const b = toCell(demo.to);
    if (!(b >= 0 && b < NCELL)) return;
    const v = view();
    const type = typeof demo.from === 'string' ? demo.from : null;
    const fp = type ? safe(() => nestgeom.footprint(type, 1), null) : null;
    const w = fp && fp.w > 0 ? fp.w : 3;
    const h = fp && fp.h > 0 ? fp.h : 2;
    const bx = (b % COLS) * v.cell + v.ox;
    const by = Math.floor(b / COLS) * v.cell + v.oy;
    // the ghost ant carries the dashed footprint from the start cell (or from the shaft, a few rows up) to the spot
    const a = toCell(demo.from);
    const start = a >= 0 && a < NCELL ? { x: (a % COLS) * v.cell + v.ox, y: Math.floor(a / COLS) * v.cell + v.oy }
      : { x: v.ox + (GRID.mainCol - (w - 1) / 2) * v.cell, y: by - 6 * v.cell };
    const u = (time % 2.6) / 2.2;
    const k = clamp(u, 0, 1);
    const e = k * k * (3 - 2 * k);
    const x = start.x + (bx - start.x) * e;
    const y = start.y + (by - start.y) * e;
    ctx.globalAlpha = 0.9 * clamp(u / 0.12, 0, 1) * (1 - clamp((u - 1) / 0.18, 0, 1));
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w * v.cell, h * v.cell);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, w * v.cell - 1, h * v.cell - 1);
    ctx.setLineDash([]);
    atlas.drawAnt(ctx, 'ghost', 'none', Math.atan2(by - start.y, bx - start.x), (Math.floor(time * 8) & 1),
      x + (w * v.cell) / 2, y - unit * 0.7, unit * 1.3);
    ctx.globalAlpha = 1;
    if (u >= 1) {
      // landed: the target footprint pulses once
      const p = clamp((u - 1) / 0.18, 0, 1);
      ctx.strokeStyle = `rgba(255,236,160,${0.8 * (1 - p)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx - 2 - p * 4, by - 2 - p * 4, w * v.cell + 4 + p * 8, h * v.cell + 4 + p * 8);
    }
  }

  function overlayInfo(s, d) {
    const v = view();
    const ents = geo.tops.map((t) => t.i);
    const entField = fields.get('ents', () => ents);
    const mainField = fields.get('top:main', () => [GRID.mainCol]);
    return {
      s, d, view: v, W: layer.cssW, H: layer.cssH, open: fields.open, entField, mainField,
      rowTop: cam.topRow(), rowBot: cam.topRow() + cam.viewRows(), chamberCenter,
    };
  }

  function drawRaidFlash(ctx, s, unit) {
    const raids = (s.run.war && s.run.war.raids) || [];
    const warn = raids.filter((r) => r && r.phase === 'warning');
    hub.raid = warn.length > 0;
    const v = view();
    if (warn.length) {
      const nestTarget = warn.some((r) => r.target && r.target.type === 'nest');
      const a = (0.25 + 0.25 * Math.sin(time * 9)) * (nestTarget ? 1.4 : 1);
      ctx.fillStyle = rgba(NEST.raid, clamp(a, 0, 0.7));
      ctx.beginPath();
      for (let i = 0; i < NCELL; i++) if (geo.shaftCells[i]) ctx.rect(v.ox + (i % COLS) * v.cell, v.oy + Math.floor(i / COLS) * v.cell, v.cell, v.cell);
      ctx.fill();
    }
    const battles = (s.run.war && s.run.war.battles) || [];
    for (const b of battles) {
      if (!b || !b.below) continue;
      const top = geo.tops.find((t) => t.kind === 'main') || geo.tops[0];
      if (!top) continue;
      let bottom = 0;
      for (let y = 0; y < ROWS; y++) {
        if (!geo.shaftCells[y * COLS + top.col]) break;
        bottom = y;
      }
      const raid = (s.run.war.raids || []).find((r) => r && r.uid === b.raid);
      const rival = raid ? (s.run.rivals.list || []).find((rv) => rv && rv.uid === raid.rival) : null;
      drawGateFight(ctx, b, { x: v.ox + (top.col + 0.5) * v.cell, top: v.oy, bottom: v.oy + (bottom + 1) * v.cell, unit, t: time, outline: NEST.antOutline,
        color: rivalColor(rival ? rival.type : '', rival ? rival.tier : 1) });
    }
  }

  function drawVignette(ctx, s, W, H) {
    if (!s.run.colony.hungry) return;
    const a = 0.32 + 0.08 * Math.sin(time * 1.4);
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(60,10,0,0)');
    g.addColorStop(1, `rgba(60,10,0,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawScaleLabel(ctx, s, H) {
    const show = !(s.meta && s.meta.settings && s.meta.settings.showScaleLabel === false);
    if (!show || pool.n === 0) return;
    const text = `1 ● = ${compactInt(K)} ant${K === 1 ? '' : 's'}`;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(15,8,3,0.6)';
    ctx.fillRect(6, H - 22, tw + 10, 16);
    ctx.fillStyle = '#f6ead2';
    ctx.fillText(text, 11, H - 14);
  }

  /** Layout of the on-canvas camera buttons (top-right corner), CSS px. */
  function controlRects() {
    const W = layer.cssW;
    const s = W < 420 ? 30 : 26;
    const gap = 4;
    const out = [];
    let x = W - 8 - CONTROLS.length * s - (CONTROLS.length - 1) * gap;
    for (const name of CONTROLS) {
      out.push({ name, x, y: 8, w: s, h: s });
      x += s + gap;
    }
    return out;
  }

  /** Camera button under a canvas point ('out' | 'in' | 'home'), or null. */
  function controlAt(x, y) {
    if (cam.inset || !(layer.cssW > 120) || !(layer.cssH > 90)) return null;
    for (const r of controlRects()) if (x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2) return r.name;
    const q = queenChip();
    if (q && x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h) return 'queen';
    return null;
  }

  /** Press a camera button: zoom around the view centre, or frame the queen. */
  function pressControl(name) {
    ensureViewport();
    if (name === 'in' || name === 'out') {
      glide = null;
      goal = null;
      if (cam.zoomAt(name === 'in' ? 1.35 : 1 / 1.35, layer.cssW / 2, layer.cssH / 2)) userMoved = true;
      return true;
    }
    if (name === 'home' || name === 'queen') {
      glide = null;
      goal = null;
      ceremonyHold = false;
      userMoved = false;
      focusRoyal();
      return true;
    }
    return false;
  }

  function drawControls(ctx) {
    if (cam.inset || !(layer.cssW > 120) || !(layer.cssH > 90)) return;
    const zMin = cam.zoomMin();
    const zMax = cam.zoomMax();
    for (const r of controlRects()) {
      const hot = input.ctlHover === r.name;
      const disabled = (r.name === 'in' && cam.zoom >= zMax - 1e-3) || (r.name === 'out' && cam.zoom <= zMin + 1e-3);
      ctx.fillStyle = hot && !disabled ? 'rgba(40,24,12,0.92)' : 'rgba(20,12,6,0.62)';
      rrect(ctx, r.x, r.y, r.w, r.h, 7, 7, 7, 7);
      ctx.fill();
      ctx.strokeStyle = hot && !disabled ? 'rgba(255,224,138,0.85)' : 'rgba(255,224,138,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const k = r.w * 0.22;
      ctx.strokeStyle = disabled ? 'rgba(246,234,210,0.3)' : '#f6ead2';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (r.name === 'out' || r.name === 'in') {
        ctx.moveTo(cx - k, cy);
        ctx.lineTo(cx + k, cy);
        if (r.name === 'in') {
          ctx.moveTo(cx, cy - k);
          ctx.lineTo(cx, cy + k);
        }
        ctx.stroke();
      } else {
        // a tiny crown: frame the queen
        ctx.lineWidth = 1.5;
        ctx.moveTo(cx - k * 1.15, cy + k * 0.75);
        ctx.lineTo(cx - k * 1.15, cy - k * 0.55);
        ctx.lineTo(cx - k * 0.5, cy + k * 0.05);
        ctx.lineTo(cx, cy - k * 0.85);
        ctx.lineTo(cx + k * 0.5, cy + k * 0.05);
        ctx.lineTo(cx + k * 1.15, cy - k * 0.55);
        ctx.lineTo(cx + k * 1.15, cy + k * 0.75);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineCap = 'butt';
    }
  }

  /** Small edge chip pointing at the queen when the Royal Chamber is scrolled out of view (click = frame her). */
  function queenChip() {
    if (cam.inset) return null;
    const c = royalRect();
    const r = chamberRectPx(c);
    const H = layer.cssH;
    const W = layer.cssW;
    if (r.y + r.h > 4 && r.y < H - 4 && r.x + r.w > 4 && r.x < W - 4) return null;
    const below = r.y >= H - 4;
    const above = r.y + r.h <= 4;
    const w = 74;
    const h = 20;
    const x = clamp(r.x + r.w / 2 - w / 2, 6, Math.max(6, W - w - 6));
    const y = below ? H - h - 6 : above ? 40 : clamp(r.y + r.h / 2 - h / 2, 40, H - h - 6);
    return { x, y, w, h, dir: below ? 1 : above ? -1 : 0 };
  }

  function drawQueenChip(ctx) {
    const q = queenChip();
    if (!q) return;
    const hot = input.ctlHover === 'queen';
    ctx.fillStyle = hot ? 'rgba(60,36,14,0.95)' : 'rgba(20,12,6,0.78)';
    rrect(ctx, q.x, q.y, q.w, q.h, 10, 10, 10, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,224,138,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffe08a';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Queen ${q.dir > 0 ? '↓' : q.dir < 0 ? '↑' : '↔'}`, q.x + q.w / 2, q.y + q.h / 2 + 0.5);
    ctx.textAlign = 'left';
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
    const v = view();
    const left = rectCache ? rectCache.left : 0;
    hub.nestX = left + v.ox + (GRID.mainCol + 0.5) * v.cell;
  }

  function drawStrip(s) {
    if (!strip) return;
    const now = nowMs();
    const key = `${s.run.nest.rev}|${Math.round(cam.topRow() * 2)}|${Math.round(cam.viewRows())}|${(s.run.nest.chambers || []).length}`;
    if (key === stripKey && now - stripAt < 2000) return;
    stripKey = key;
    stripAt = now;
    try {
      drawNestStrip(strip, s, cam.topRow(), cam.viewRows());
    } catch {
      // strip is cosmetic
    }
  }

  // strip interaction: click or drag to scroll
  let stripDrag = false;
  function stripPointer(e) {
    if (!strip || !strip.getBoundingClientRect) return;
    const r = strip.getBoundingClientRect();
    if (!(r.height > 0)) return;
    const row = ((e.clientY - r.top) / r.height) * ROWS;
    playerCamera();
    cam.centerOnRow(row);
  }
  const onStripDown = (e) => {
    stripDrag = true;
    stripPointer(e);
    try {
      strip.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };
  const onStripMove = (e) => {
    if (stripDrag) stripPointer(e);
  };
  const onStripUp = () => {
    stripDrag = false;
  };
  if (strip && typeof strip.addEventListener === 'function') {
    strip.addEventListener('pointerdown', onStripDown);
    strip.addEventListener('pointermove', onStripMove);
    strip.addEventListener('pointerup', onStripUp);
    strip.addEventListener('pointercancel', onStripUp);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------------------------------------------

  function render(frameDt) {
    if (destroyed || !visible || pageHidden()) return;
    const s = S();
    const d = D();
    const ctx = layer.ctx;
    if (!s || !s.run || !s.run.nest || !ctx) return;
    if (s !== lastS) {
      if (lastS) dropCaches();
      lastS = s;
    }
    const dt = clamp(Number.isFinite(frameDt) ? frameDt : 0, 0, 0.1);
    time += dt;
    frameNo++;
    const nowS = nowMs();
    if (nowS - reducedAt > 1000) {
      reducedAt = nowS;
      reduced = reducedMotion(s);
    }
    ensureViewport();
    revealDemo();
    const W = layer.cssW;
    const H = layer.cssH;
    fields.sync(s.run.nest.cells, s.run.nest.rev);
    syncGeo(s);
    syncCache(s);
    if (queenPulse > 0) queenPulse = Math.max(0, queenPulse - dt);
    for (const gl of glows) gl.t += dt;

    ctx.setTransform(layer.dpr, 0, 0, layer.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // army ants make the shaft tremble (DESIGN §18.2)
    const tremble = !reduced && ((s.run.events && (s.run.events.objects || []).some((o) => o && o.kind === 'army_column'))
      || (s.run.events && (s.run.events.active || []).some((a) => a && a.id === 'ev_army_ant_column')));
    if (tremble) ctx.translate(Math.sin(time * 40) * 0.8, Math.cos(time * 37) * 0.6);
    const v = view();
    const unit = v.cell;

    drawSky(ctx, s, d, W);
    drawMargins(ctx, W, H);
    // strata cache (visible rows only)
    if (cache.canvas) {
      const r0 = clamp(Math.floor(-v.oy / v.cell), 0, ROWS);
      const r1 = clamp(Math.ceil((H - v.oy) / v.cell), 0, ROWS);
      if (r1 > r0) {
        ctx.drawImage(cache.canvas, 0, r0 * cache.cpp, COLS * cache.cpp, (r1 - r0) * cache.cpp, v.ox, v.oy + r0 * v.cell, COLS * v.cell, (r1 - r0) * v.cell);
      }
    }
    drawReservations(ctx, s); // C154: under the cache hints, so discoloured soil in a reserved room still shows
    drawHints(ctx, s, d);
    syncLinks(s, d);
    drawPlanned(ctx, s);
    drawShaftPass(ctx, H);
    drawChambers(ctx, s, d, unit, W, H);
    drawHousePip(ctx, s, d, unit);
    drawFrost(ctx, d, W);
    drawFlood(ctx, s);
    drawPupa(ctx, s, unit);

    // sprites
    reallocIn -= dt;
    if (reallocIn <= 0) {
      reallocIn = REALLOC_SEC;
      realloc(s);
    }
    updateSprites(s, d, dt);
    drawSprites(ctx, unit, H);
    drawQueen(ctx, s, unit);
    drawMold(ctx, s);
    drawLabels(ctx, W);

    drawPendingBackfill(ctx, s);
    drawToolPreviews(ctx, s, d, unit);
    drawDigQueue(ctx, s, d);
    drawDigCrew(ctx, s, d, unit, H); // C180: workers at the dig face (over the queue marks), soil carried out
    const ui0 = uiOf(ui);
    const ov = ui0.overlays || {};
    if (ov.climate || ov.raid_reach || ov.haul || ov.adjacency) drawNestOverlays(ctx, ov, overlayInfo(s, d));
    const hov = ui0.hover && ui0.hover.view === 'nest' && (ui0.hover.kind === 'chamber' || ui0.hover.kind === 'nursery') ? ui0.hover : null;
    if (hov && !ov.adjacency) drawAdjacency(ctx, overlayInfo(s, d), hov.id);
    const sel = ui0.selection && ui0.selection.view === 'nest' && (ui0.selection.kind === 'cell' || ui0.selection.kind === 'shaft' || ui0.selection.kind === 'cacheHint') ? ui0.selection : null;
    if (sel && sel.i >= 0) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(v.ox + (sel.i % COLS) * v.cell + 0.5, v.oy + Math.floor(sel.i / COLS) * v.cell + 0.5, v.cell - 1, v.cell - 1);
    }
    if (input.hoverCell >= 0 && !ui0.tool) {
      ctx.strokeStyle = 'rgba(255,240,200,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(v.ox + (input.hoverCell % COLS) * v.cell + 0.5, v.oy + Math.floor(input.hoverCell / COLS) * v.cell + 0.5, v.cell - 1, v.cell - 1);
    }
    drawRaidFlash(ctx, s, unit);
    fx.update(dt, { x: 0, y: 0, w: W, h: H });
    fx.draw(ctx);
    drawVignette(ctx, s, W, H);
    drawPings(ctx);
    if (activeCeremony()) {
      drawCeremonyNest(ctx, {
        W, H, s, view: v,
        coverCells: (cells) => coverCells(ctx, cells),
        cellRect: (i) => ({ x: v.ox + (i % COLS) * v.cell, y: v.oy + Math.floor(i / COLS) * v.cell, w: v.cell, h: v.cell }),
        chamberRect: (uid) => {
          const c = chamberByUid(uid);
          return c ? chamberRectPx(c) : null;
        },
      });
    }
    drawScaleLabel(ctx, s, H);
    if (tremble) ctx.setTransform(layer.dpr, 0, 0, layer.dpr, 0, 0);
    if (!activeCeremony()) {
      drawQueenChip(ctx);
      drawControls(ctx);
    }
    publishSeamX();
    drawStrip(s);
  }

  /** Locate pings (ping(i)): rings at the cell centre, following the camera; expired pings are dropped. */
  function drawPings(ctx) {
    if (!pings.length) return;
    const now = nowMs();
    const dur = PING_SEC * 1000;
    const v = view();
    for (let k = pings.length - 1; k >= 0; k--) {
      const p = pings[k];
      const age = now - p.start;
      if (age >= dur) {
        pings.splice(k, 1);
        continue;
      }
      if (age < 0) continue; // waiting for the camera glide to arrive
      const x = v.ox + ((p.i % COLS) + 0.5) * v.cell;
      const y = v.oy + (Math.floor(p.i / COLS) + 0.5) * v.cell;
      drawPing(ctx, x, y, age / dur, { r0: Math.max(6, v.cell * 0.6), r1: Math.max(28, v.cell * 3), reduced });
    }
  }

  function coverCells(ctx, cells) {
    const p = pristine();
    if (!p || !p.canvas || !cells.length) return;
    const v = view();
    ctx.save();
    ctx.beginPath();
    for (const i of cells) {
      if (!(i >= 0 && i < NCELL)) continue;
      ctx.rect(v.ox + (i % COLS) * v.cell, v.oy + Math.floor(i / COLS) * v.cell, v.cell + 0.5, v.cell + 0.5);
    }
    ctx.clip();
    ctx.drawImage(p.canvas, 0, 0, COLS * cache.cpp, ROWS * cache.cpp, v.ox, v.oy, COLS * v.cell, ROWS * v.cell);
    ctx.restore();
  }

  /**
   * Hit-test (priority: pupa > mold > flood water > queen > dig face > chamber > reserved room cell (its chamber, C154) > cache hint > planned > pocket > shaft > cell).
   * @param {number} cssX
   * @param {number} cssY
   * @returns {{ view: 'nest', kind: string, id?: number, i?: number } | null}
   */
  function pick(cssX, cssY) {
    const s = S();
    const d = D();
    if (!s || !s.run || !s.run.nest) return null;
    ensureViewport();
    fields.sync(s.run.nest.cells, s.run.nest.rev);
    syncGeo(s);
    const v = view();
    const unit = v.cell;
    const i = pxToCell(cssX, cssY, v);
    const pp = pupaPos(s);
    if (pp && Math.hypot(cssX - pp.x, cssY - pp.y) <= unit * 0.9) return { view: 'nest', kind: 'pupa' };
    for (const m of moldSpots(s)) {
      const c = cellCenter(m.i);
      if (Math.hypot(cssX - c.x, cssY - c.y) <= Math.max(9, unit * 0.8)) return { view: 'nest', kind: 'mold', id: m.uid };
    }
    if (i < 0) return null;
    const y = Math.floor(i / COLS);
    const fr = (DIG && DIG.floodRows) || [0, 5];
    if (y >= fr[0] && y <= fr[1] && fields.open[i] && floodActive(s)) return { view: 'nest', kind: 'flood' };
    const chs = s.run.nest.chambers || [];
    for (const c of chs) {
      if (!c || c.type !== 'royal_chamber' || !(c.status === 'active' || c.status === 'growing')) continue;
      const q = queenPos(c, chamberRectPx(c), unit);
      const grow = 1 + Math.min(0.5, 0.07 * ((c.level || 1) - 1));
      if (Math.abs(cssX - q.x) <= unit * 0.95 * grow && Math.abs(cssY - q.y) <= unit * 0.5 * grow) return { view: 'nest', kind: 'queen', id: c.uid };
    }
    const face = digFace(s, d);
    if (face >= 0) {
      const c = cellCenter(face);
      if (Math.abs(cssX - c.x) <= unit * 0.8 && Math.abs(cssY - c.y) <= unit * 0.8) return { view: 'nest', kind: 'digFace', i: face };
    }
    const k = geo.at[i];
    if (k >= 0 && chs[k]) return { view: 'nest', kind: chs[k].type === 'nursery' ? 'nursery' : 'chamber', id: chs[k].uid };
    // C154: a cell of a chamber's reserved full-size room (discoloured fresh-dug soil, an old tunnel or a cache hint in
    // it) selects / inspects that chamber (kind 'chamber' even for a Nursery: a click here never grooms). A revealed water
    // pocket inside keeps its own inspect view (drain / move it to clear the room).
    if (s.run.nest.cells[i] !== CELL.WATER) {
      const rb = safe(() => nestSys.reservedBy(s, d, i), null);
      if (rb && chs.some((c) => c && c.uid === rb.uid)) return { view: 'nest', kind: 'chamber', id: rb.uid, reserved: true, i };
    }
    const hints = hintCells(s, d);
    if (hints.includes(i)) return { view: 'nest', kind: 'cacheHint', i };
    // C106: a planned (pending blueprint) chamber; i = its top-left cell
    for (const p of safe(() => nestSys.plannedChambers(s), []) || []) {
      const cx = i % COLS;
      const cy = Math.floor(i / COLS);
      if (cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h) return { view: 'nest', kind: 'planned', i: p.y * COLS + p.x, chamberType: p.type };
    }
    // C117: a revealed water pocket (inspect: drain / move); i = the clicked cell, id = its features.water index
    if (s.run.nest.cells[i] === CELL.WATER) {
      const k = safe(() => nestSys.pocketAt(s, i), -1);
      if (k >= 0) return { view: 'nest', kind: 'pocket', i, id: k };
    }
    if (geo.shaftCells[i]) return { view: 'nest', kind: 'shaft', i };
    return { view: 'nest', kind: 'cell', i };
  }

  function cellAt(cssX, cssY) {
    ensureViewport();
    const i = pxToCell(cssX, cssY, view());
    if (i < 0) return null;
    return { x: i % COLS, y: Math.floor(i / COLS), i };
  }

  function setVisible(on) {
    visible = !!on;
  }

  function setInset(on) {
    cam.inset = !!on;
    glide = null;
    goal = null;
    userMoved = false;
    layerVersion = -1;
    ensureViewport();
    focusRoyal();
  }

  /**
   * Put `row` at the top of the view (instant). Like centerOnCell it is a deliberate camera move: layout changes keep
   * it, and a resize within GOAL_HOLD_MS re-applies it (the view is often switched in a frame later).
   * @param {number} row
   */
  function scrollToRow(row) {
    ensureViewport();
    if (!Number.isFinite(row)) return;
    playerCamera();
    ceremonyHold = false;
    goal = { row, until: nowMs() + GOAL_HOLD_MS };
    cam.scrollToRow(row);
  }

  /**
   * Public locate API (§13.3): glide (scroll, and zoom in while cells are under FRAME_CELL px) so cell `i` sits at the
   * centre of the view. Reduced motion jumps. Layout changes keep the result. Returns false for an invalid cell.
   * @param {number} i cell index (y × 40 + x)
   * @returns {boolean}
   */
  function centerOnCell(i) {
    if (!Number.isInteger(i) || i < 0 || i >= NCELL) return false;
    ensureViewport();
    playerCamera();
    ceremonyHold = false;
    const g = { cell: i, until: nowMs() + GOAL_HOLD_MS };
    glideTo(() => applyGoal(g));
    goal = g;
    return true;
  }

  /**
   * Public locate API (§13.3): a brief expanding highlight ring on cell `i` (PING_SEC; a steady fading ring with
   * reduced motion). A ping requested during a centerOnCell glide starts when the glide arrives.
   * @param {number} i cell index
   * @returns {boolean}
   */
  function ping(i) {
    if (!Number.isInteger(i) || i < 0 || i >= NCELL) return false;
    pings.push({ i, start: glideEnd() });
    while (pings.length > PING_MAX) pings.shift();
    return true;
  }

  /**
   * WP8-internal (ceremony.js): centre `row` for the ceremony that is starting. When that ceremony ends the view
   * glides back to the default framing around the Royal Chamber, unless the player moved the camera meanwhile (F20).
   * @param {number} row
   */
  function ceremonyView(row) {
    ensureViewport();
    if (!Number.isFinite(row)) return;
    glide = null;
    goal = null;
    cam.centerOnRow(row);
    ceremonyHold = true;
  }

  /** Player scroll (wheel, drag, keys): from now on layout changes keep the player's framing. */
  function scrollBy(dy) {
    ensureViewport();
    if (Number.isFinite(dy) && dy) {
      playerCamera();
      cam.scrollBy(dy);
    }
  }

  /** Player pan in both axes (horizontal only while zoomed in past the canvas width). */
  function panBy(dx, dy) {
    ensureViewport();
    if ((Number.isFinite(dx) && dx) || (Number.isFinite(dy) && dy)) {
      playerCamera();
      cam.panBy(Number.isFinite(dx) ? dx : 0, Number.isFinite(dy) ? dy : 0);
    }
  }

  /** Player zoom by `factor` around a canvas point. */
  function zoomAt(factor, cssX, cssY) {
    ensureViewport();
    glide = null;
    goal = null;
    const ok = cam.zoomAt(factor, Number.isFinite(cssX) ? cssX : layer.cssW / 2, Number.isFinite(cssY) ? cssY : layer.cssH / 2);
    if (ok) userMoved = true;
    return ok;
  }

  /** Back to the default framing around the Royal Chamber. */
  function frameHome() {
    pressControl('home');
  }

  function getView() {
    ensureViewport();
    return { ...view(), topRow: cam.topRow(), viewRows: cam.viewRows(), W: layer.cssW, H: layer.cssH, zoom: cam.zoom,
      zoomMin: cam.zoomMin(), zoomMax: cam.zoomMax() };
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
    if (strip && typeof strip.removeEventListener === 'function') {
      strip.removeEventListener('pointerdown', onStripDown);
      strip.removeEventListener('pointermove', onStripMove);
      strip.removeEventListener('pointerup', onStripUp);
      strip.removeEventListener('pointercancel', onStripUp);
    }
    layer.destroy();
  }

  const api = { render, pick, cellAt, setVisible, setInset, scrollToRow, centerOnCell, ping, destroy,
    // WP8-internal extensions
    game, input, scrollBy, panBy, zoomAt, frameHome, controlAt, pressControl, getView, ghostAt, ceremonyView,
    get spriteCount() { return pool.n; },
    /** live locate pings (expired ones are dropped when drawn or counted) */
    pingCount() {
      const now = nowMs();
      for (let k = pings.length - 1; k >= 0; k--) if (now - pings[k].start >= PING_SEC * 1000) pings.splice(k, 1);
      return pings.length;
    } };
  registerRenderer(canvas, api);
  return api;
}

/** Exposed for tests: the Below sprite budget. */
export const NEST_BUDGET = BUDGET.below;
/** Exposed for tests: ant body colour table (palette re-export). */
export const NEST_ANT_COLORS = ANT;
