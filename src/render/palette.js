// Render palette: colours per season, stratum, terrain, caste, carried item and rival; colour-blind-safe hatch
// patterns for rival land; small pure colour helpers. Owner: WP8. Contract: ARCHITECTURE §13 (render/palette.js).
// Rival hues use the Okabe-Ito colour-blind-safe set and every rival also gets a distinct hatch pattern.

import { createOffscreen } from './canvas.js';

// ----------------------------------------------------------------------------------------------------------------
// Pure colour helpers
// ----------------------------------------------------------------------------------------------------------------

const RGB_CACHE = new Map();

/**
 * Parse '#rgb' / '#rrggbb' into [r, g, b] (0..255). Unknown input gives mid grey.
 * @param {string} c
 * @returns {number[]}
 */
export function toRgb(c) {
  if (Array.isArray(c)) return c;
  let v = RGB_CACHE.get(c);
  if (v) return v;
  let s = typeof c === 'string' ? c.trim() : '';
  if (s[0] === '#') s = s.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = s.length === 6 ? parseInt(s, 16) : NaN;
  v = Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
  RGB_CACHE.set(c, v);
  return v;
}

/** @param {number} v */
function h2(v) {
  const n = Math.max(0, Math.min(255, Math.round(v)));
  return (n < 16 ? '0' : '') + n.toString(16);
}

/**
 * [r, g, b] → '#rrggbb'.
 * @param {number[]} rgb
 * @returns {string}
 */
export function toHex(rgb) {
  return '#' + h2(rgb[0]) + h2(rgb[1]) + h2(rgb[2]);
}

/**
 * Linear mix of two colours (t = 0 → a, 1 → b).
 * @param {string} a
 * @param {string} b
 * @param {number} t
 * @returns {string}
 */
export function mix(a, b, t) {
  const x = toRgb(a);
  const y = toRgb(b);
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return toHex([x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u]);
}

/**
 * Lighten (amt > 0, toward white) or darken (amt < 0, toward black).
 * @param {string} c
 * @param {number} amt −1..1
 * @returns {string}
 */
export function shade(c, amt) {
  return amt >= 0 ? mix(c, '#ffffff', amt) : mix(c, '#000000', -amt);
}

/**
 * CSS rgba() string.
 * @param {string} c
 * @param {number} a
 * @returns {string}
 */
export function rgba(c, a) {
  const v = toRgb(c);
  const al = a < 0 ? 0 : a > 1 ? 1 : a;
  return `rgba(${v[0]},${v[1]},${v[2]},${Math.round(al * 1000) / 1000})`;
}

const VIRIDIS = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

/**
 * Colour-blind-safe sequential ramp (viridis), t ∈ [0, 1].
 * @param {number} t
 * @returns {string}
 */
export function ramp(t) {
  const u = (t < 0 ? 0 : t > 1 ? 1 : t || 0) * (VIRIDIS.length - 1);
  const k = Math.min(VIRIDIS.length - 2, Math.floor(u));
  return mix(VIRIDIS[k], VIRIDIS[k + 1], u - k);
}

// ----------------------------------------------------------------------------------------------------------------
// Tables
// ----------------------------------------------------------------------------------------------------------------

/** Season ids in calendar order (fallback while data/seasons.js is a stub). */
export const SEASON_IDS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);

/** Strata colours per layer id: base, light, dark, fleck, cavity tint. */
export const STRATA = Object.freeze({
  topsoil: { base: '#5d3b24', light: '#704a2e', dark: '#432917', fleck: '#8a6440', cavity: '#26170d' },
  loam: { base: '#7b4f2d', light: '#8d5e37', dark: '#5f3b20', fleck: '#a2774b', cavity: '#2a190e' },
  clay: { base: '#9b5b3b', light: '#ab6a48', dark: '#7c442a', fleck: '#c08060', cavity: '#2e1b10' },
  gravel: { base: '#8a7e6c', light: '#a19583', dark: '#6b604f', fleck: '#c2b8a4', cavity: '#27211a' },
  bedrock: { base: '#4b4b54', light: '#5f5f6a', dark: '#34343b', fleck: '#787886', cavity: '#18181d' },
  aquifer: { base: '#3e5662', light: '#4f6e7b', dark: '#2c3f48', fleck: '#79a3b3', cavity: '#121d24' },
});

/** Nest misc colours. */
export const NEST = Object.freeze({
  chamberFloor: '#7a5636', chamberRim: '#a8835a', tunnelRim: '#2a1a10',
  stone: '#7d7c80', stoneLight: '#a2a1a6', stoneDark: '#58575c',
  water: '#3b7ba6', waterLight: '#8cc4e2', root: '#dccaa0', rootDark: '#a99468',
  hint: '#c9a35a', frost: '#e6f4ff', frostEdge: '#ffffff', frostTint: '#9fd0ff',
  ghostOk: '#5ed17a', ghostWarn: '#f0b43c', ghostBad: '#e5484d',
  digFace: '#ffd27a', queueTag: '#f4e3c1', mold: '#9aa39a', flood: '#3f86b8', raid: '#ff3b30',
  fossilRun: '#d9cfb8', fossilCycle: '#e8a33c', amber: '#d98e1f', seed: '#e8d3a0', fungus: '#f4f1ea', fungusGrey: '#9c9a94',
  label: '#f6ead2', labelShadow: '#1a0f08',
  /** Silhouette outline of Below-view ants (atlas outlined strips), so dark ants read on dark tunnels. */
  antOutline: 'rgba(238,208,160,0.5)',
});

/** Sky above the soil line, per season: [top, bottom]. */
export const SKY = Object.freeze({
  spring: ['#a9dcf2', '#e4f3dc'], summer: ['#8ccdf5', '#f3ecc7'],
  autumn: ['#e9c79a', '#f5e2c0'], winter: ['#c8d6e2', '#eef3f7'],
});

/** Grass tuft colour on the soil line, per season. */
export const GRASS_LINE = Object.freeze({ spring: '#5fa83e', summer: '#4f8f30', autumn: '#a3963c', winter: '#c8d4cc' });

/** Surface terrain colours per season ([base, detail]). */
export const TERRAIN_COLORS = Object.freeze({
  spring: {
    grass: ['#6aa84a', '#82c05c'], sand: ['#d8c38c', '#e8d6a6'], leaf_litter: ['#7d6a38', '#9a7f42'],
    garden_path: ['#b6a790', '#cfc2ad'], tree_root: ['#5b4630', '#7a5f40'], stone: ['#8a8a8e', '#a8a8ad'],
    puddle: ['#4f86b0', '#86b8d8'], log: ['#6a4829', '#8b6239'],
  },
  summer: {
    grass: ['#9aa23e', '#b8b656'], sand: ['#e6cb84', '#f2dba0'], leaf_litter: ['#7a6330', '#977a3e'],
    garden_path: ['#bcad94', '#d4c7b0'], tree_root: ['#5b4630', '#7a5f40'], stone: ['#909094', '#b0b0b4'],
    puddle: ['#7d7458', '#968b6a'], log: ['#6a4829', '#8b6239'],
  },
  autumn: {
    grass: ['#8c883d', '#a49849'], sand: ['#d6bd86', '#e6cf9c'], leaf_litter: ['#a9602a', '#c9783a'],
    garden_path: ['#b2a28a', '#cbbca4'], tree_root: ['#5a4430', '#78593c'], stone: ['#87878b', '#a5a5aa'],
    puddle: ['#4d7fa6', '#7fb0cf'], log: ['#66442a', '#865c38'],
  },
  winter: {
    grass: ['#a7b6a8', '#c4d0c6'], sand: ['#d6d2c4', '#e6e3d9'], leaf_litter: ['#8c7d68', '#a69780'],
    garden_path: ['#c4beb4', '#dad5cc'], tree_root: ['#6a5a4a', '#857360'], stone: ['#9a9ca2', '#b9bbc0'],
    puddle: ['#b4d2e6', '#dbeaf4'], log: ['#6e5642', '#8a6f58'],
  },
});

/** Surface misc colours. */
export const SURFACE = Object.freeze({
  void: '#1d2318', voidEdge: '#2b3524', fog: '#18200f', fogEdge: '#2a3620', shimmer: '#e9f7d8',
  player: '#f2b134', playerDark: '#a8741a', border: '#ffe08a', mound: '#8a5d38', moundDark: '#5d3c22',
  trail: '#f3d9a4', trailHerder: '#f0a830', trailLeaf: '#7fd36a', trailLycaenid: '#a99cf0',
  raid: '#ff3b30', beetle: '#ffcf33', gift: '#e85d75', giftRibbon: '#ffe08a', selection: '#ffffff', hover: '#fff3c4',
  daughter: '#f6c66b', claimOk: '#5ed17a', claimBad: '#e5484d', flag: '#ff7a3d', text: '#fbf3e0', textShadow: '#141a10',
});

/** Ant body colours by kind (caste/role). */
export const ANT = Object.freeze({
  minor: { body: '#3b2416', head: '#2f1c10', leg: '#24150c' },
  soldier: { body: '#4a2a18', head: '#5c2a14', leg: '#2a170d' },
  supermajor: { body: '#5a2e1a', head: '#6d3016', leg: '#2e190e' },
  replete: { body: '#3b2416', head: '#2f1c10', leg: '#24150c', gaster: '#e39b2b' },
  alate: { body: '#2c1c14', head: '#22150e', leg: '#1d120b', wing: '#dceaff' },
  queen: { body: '#2a1810', head: '#21130b', leg: '#1b100a', gaster: '#3a2216' },
  golden: { body: '#d9a51e', head: '#c08b12', leg: '#8a6410' },
  militia: { body: '#3b2416', head: '#2f1c10', leg: '#24150c' },
  ghost: { body: '#f6ead2', head: '#f6ead2', leg: '#e8dcc0' },
});

/** Carried item colours (ARCHITECTURE §13.4). */
export const CARRY = Object.freeze({
  none: null, seed: '#e8d6a8', honeydew: '#f0a830', leaf: '#4caf50', chitin: '#1a1a1a', pupa: '#f8f4ea',
  pellet: '#7a5232', golden: '#ffd447',
});
/** Carry codes used in sprite pools (index → CARRY key). */
export const CARRY_CODES = Object.freeze(['none', 'seed', 'honeydew', 'leaf', 'chitin', 'pupa', 'pellet', 'golden']);

/** Okabe-Ito hues assigned to rivals by type (bosses dark crimson, elders indigo). */
export const RIVAL_COLORS = Object.freeze({
  black_garden_ants: '#0072b2', pavement_ants: '#cc79a7', red_wood_ants: '#d55e00', carpenter_ants: '#56b4e9',
  fire_ants: '#e69f00', slave_makers: '#009e73', elder: '#5b4a8a',
  old_ridge_supercolony: '#7d1d2a', great_rival: '#3d0f3d', army_ant_column: '#2a1a12',
});
const RIVAL_FALLBACK = ['#0072b2', '#cc79a7', '#d55e00', '#56b4e9', '#e69f00', '#009e73'];

/** Hatch pattern per rival type (colour-blind safe: hue AND texture differ). */
export const RIVAL_PATTERNS = Object.freeze({
  black_garden_ants: 'diag', pavement_ants: 'dots', red_wood_ants: 'cross', carpenter_ants: 'horiz',
  fire_ants: 'chevron', slave_makers: 'vert', elder: 'grid', old_ridge_supercolony: 'diag2',
  great_rival: 'checker', army_ant_column: 'grid',
});
const PATTERN_FALLBACK = ['diag', 'dots', 'cross', 'horiz', 'chevron', 'vert', 'grid', 'diag2'];

/**
 * Colour of a rival by type (elders and unknown types fall back by tier).
 * @param {string} type
 * @param {number} [tier=1]
 * @returns {string}
 */
export function rivalColor(type, tier = 1) {
  if (RIVAL_COLORS[type]) return RIVAL_COLORS[type];
  if (tier >= 7) return RIVAL_COLORS.elder;
  return RIVAL_FALLBACK[Math.abs(Math.floor(tier || 0)) % RIVAL_FALLBACK.length];
}

/**
 * Pattern kind of a rival by type.
 * @param {string} type
 * @param {number} [tier=1]
 * @returns {string}
 */
export function rivalPatternKind(type, tier = 1) {
  if (RIVAL_PATTERNS[type]) return RIVAL_PATTERNS[type];
  if (tier >= 7) return RIVAL_PATTERNS.elder;
  return PATTERN_FALLBACK[Math.abs(Math.floor(tier || 0)) % PATTERN_FALLBACK.length];
}

/** Whole-view colour grade per season (drawn as a translucent wash). */
export const SEASON_WASH = Object.freeze({
  spring: null, summer: 'rgba(255,214,140,0.06)', autumn: 'rgba(255,160,70,0.08)', winter: 'rgba(205,228,255,0.14)',
});

/** Territory overlay tints by owned code (1 auto, 2 claimed, 3 conquered, 4 trunk). */
export const OWNED_TINT = Object.freeze({ 1: '#f2b134', 2: '#ffd166', 3: '#ef8a3a', 4: '#c6e06a' });

/**
 * Terrain colours for a terrain id in a season.
 * @param {string} season
 * @param {string} terrain
 * @returns {string[]} [base, detail]
 */
export function terrainColor(season, terrain) {
  const t = TERRAIN_COLORS[season] || TERRAIN_COLORS.spring;
  return t[terrain] || t.grass;
}

// ----------------------------------------------------------------------------------------------------------------
// Patterns (DOM-dependent; created lazily inside functions)
// ----------------------------------------------------------------------------------------------------------------

const PATTERN_CACHE = new WeakMap();

/**
 * A repeating hatch pattern for colour-blind-safe area fills. Returns null when no canvas is available.
 * @param {CanvasRenderingContext2D} ctx the context that will use the pattern
 * @param {string} kind 'diag'|'diag2'|'dots'|'cross'|'horiz'|'vert'|'chevron'|'grid'|'checker'
 * @param {string} color
 * @param {number} [alpha=0.55]
 * @param {number} [size=10]
 * @returns {CanvasPattern|null}
 */
export function hatchPattern(ctx, kind, color, alpha = 0.55, size = 10) {
  if (!ctx || typeof ctx.createPattern !== 'function') return null;
  let per = PATTERN_CACHE.get(ctx);
  if (!per) {
    per = new Map();
    PATTERN_CACHE.set(ctx, per);
  }
  const key = `${kind}|${color}|${alpha}|${size}`;
  if (per.has(key)) return per.get(key);
  let pat = null;
  try {
    const off = createOffscreen(size, size);
    const g = off.ctx;
    if (g) {
      g.clearRect(0, 0, size, size);
      g.strokeStyle = rgba(color, alpha);
      g.fillStyle = rgba(color, alpha);
      g.lineWidth = Math.max(1, size / 7);
      g.beginPath();
      const s = size;
      switch (kind) {
        case 'diag2':
          g.moveTo(0, 0); g.lineTo(s, s); g.moveTo(-s / 2, s / 2); g.lineTo(s / 2, s * 1.5); g.moveTo(s / 2, -s / 2); g.lineTo(s * 1.5, s / 2);
          g.stroke();
          break;
        case 'dots':
          g.arc(s / 2, s / 2, s / 6, 0, Math.PI * 2);
          g.fill();
          break;
        case 'cross':
          g.moveTo(0, 0); g.lineTo(s, s); g.moveTo(s, 0); g.lineTo(0, s);
          g.stroke();
          break;
        case 'horiz':
          g.moveTo(0, s / 2); g.lineTo(s, s / 2);
          g.stroke();
          break;
        case 'vert':
          g.moveTo(s / 2, 0); g.lineTo(s / 2, s);
          g.stroke();
          break;
        case 'chevron':
          g.moveTo(0, s * 0.7); g.lineTo(s / 2, s * 0.3); g.lineTo(s, s * 0.7);
          g.stroke();
          break;
        case 'grid':
          g.moveTo(0, 0.5); g.lineTo(s, 0.5); g.moveTo(0.5, 0); g.lineTo(0.5, s);
          g.stroke();
          break;
        case 'checker':
          g.rect(0, 0, s / 2, s / 2); g.rect(s / 2, s / 2, s / 2, s / 2);
          g.fill();
          break;
        case 'diag':
        default:
          g.moveTo(0, s); g.lineTo(s, 0); g.moveTo(-s / 2, s / 2); g.lineTo(s / 2, -s / 2); g.moveTo(s / 2, s * 1.5); g.lineTo(s * 1.5, s / 2);
          g.stroke();
          break;
      }
      pat = ctx.createPattern(off.canvas, 'repeat') || null;
    }
  } catch {
    pat = null;
  }
  per.set(key, pat);
  return pat;
}

// ----------------------------------------------------------------------------------------------------------------
// Gradual seasons (C123): every seasonal colour blends toward the next season over the last BLEND_SEC of a season
// ----------------------------------------------------------------------------------------------------------------

/** Seconds before a season boundary over which visuals blend into the next season (capped at 30 % of the season). */
export const SEASON_BLEND_SEC = 60;

/** Whole-view wash per season as [r, g, b, a] (SEASON_WASH as numbers; spring has no wash). */
export const SEASON_WASH_RGBA = Object.freeze({
  spring: Object.freeze([255, 255, 255, 0]), summer: Object.freeze([255, 214, 140, 0.06]),
  autumn: Object.freeze([255, 160, 70, 0.08]), winter: Object.freeze([205, 228, 255, 0.14]),
});

/** Weather particle intensity per season (0..1); winter snow is halved in the mild year-0 winter. */
export const SEASON_WEATHER = Object.freeze({
  spring: Object.freeze({ snow: 0, leaves: 0 }), summer: Object.freeze({ snow: 0, leaves: 0 }),
  autumn: Object.freeze({ snow: 0, leaves: 0.6 }), winter: Object.freeze({ snow: 0.8, leaves: 0 }),
});

function smooth01(x) {
  const u = x < 0 ? 0 : x > 1 ? 1 : x;
  return u * u * (3 - 2 * u);
}

function seasonKey(id) {
  return typeof id === 'string' && SKY[id] ? id : 'spring';
}

/**
 * Visual season blend from d.season: `from` (the current season) eases into `to` (the next one, d.season.forecast.next)
 * over the last `win` seconds before the boundary (d.season.toNext, which includes a held extra spring). Outside that
 * window t = 0 (the pure current season). The value approaches 1 as toNext → 0, and right after the boundary the new
 * season starts at t = 0 — the same colours — so the blend is continuous across the boundary.
 * @param {{ id?: string, toNext?: number, len?: number, forecast?: { next?: string } }|null|undefined} ds d.season
 * @param {number} [win=SEASON_BLEND_SEC]
 * @returns {{ from: string, to: string, t: number }}
 */
export function seasonBlend(ds, win = SEASON_BLEND_SEC) {
  const from = seasonKey(ds && ds.id);
  const nx = ds && ds.forecast && ds.forecast.next;
  const to = typeof nx === 'string' && SKY[nx] ? nx : from;
  if (to === from) return { from, to, t: 0 };
  const len = ds && ds.len > 0 ? ds.len : 360;
  const w = Math.max(1, Math.min(win, len * 0.3));
  const left = ds && Number.isFinite(ds.toNext) ? ds.toNext : Infinity;
  if (!(left < w)) return { from, to, t: 0 };
  return { from, to, t: smooth01(1 - Math.max(0, left) / w) };
}

/**
 * Quantise a blend to `steps` levels (cache keys for layers that are rebuilt per step).
 * @param {{ from: string, to: string, t: number }} b
 * @param {number} steps
 * @returns {{ from: string, to: string, t: number }}
 */
export function quantizeBlend(b, steps) {
  const n = Math.max(1, Math.floor(steps));
  return { from: b.from, to: b.to, t: Math.round(b.t * n) / n };
}

/**
 * Blend a per-season colour table ({ spring: '#…', … }) by a season blend.
 * @param {Record<string, string>} table
 * @param {{ from: string, to: string, t: number }} b
 * @returns {string}
 */
export function blendSeasonColor(table, b) {
  const a = table[b.from] || table.spring;
  if (!(b.t > 0) || b.to === b.from) return a;
  return mix(a, table[b.to] || table.spring, b.t);
}

/**
 * Sky gradient [top, bottom] for a season blend.
 * @param {{ from: string, to: string, t: number }} b
 * @returns {string[]}
 */
export function blendSky(b) {
  const a = SKY[b.from] || SKY.spring;
  if (!(b.t > 0) || b.to === b.from) return a;
  const c = SKY[b.to] || SKY.spring;
  return [mix(a[0], c[0], b.t), mix(a[1], c[1], b.t)];
}

/**
 * Terrain colours [base, detail] for a terrain id under a season blend.
 * @param {{ from: string, to: string, t: number }} b
 * @param {string} terrain
 * @returns {string[]}
 */
export function blendTerrainColor(b, terrain) {
  const a = terrainColor(b.from, terrain);
  if (!(b.t > 0) || b.to === b.from) return a;
  const c = terrainColor(b.to, terrain);
  return [mix(a[0], c[0], b.t), mix(a[1], c[1], b.t)];
}

/**
 * Whole-view wash for a season blend as a CSS colour, or null when fully transparent.
 * @param {{ from: string, to: string, t: number }} b
 * @returns {string|null}
 */
export function blendWash(b) {
  const a = SEASON_WASH_RGBA[b.from] || SEASON_WASH_RGBA.spring;
  const c = SEASON_WASH_RGBA[b.to] || SEASON_WASH_RGBA.spring;
  const t = b.to === b.from ? 0 : b.t;
  const al = a[3] + (c[3] - a[3]) * t;
  if (!(al > 0.001)) return null;
  // colour weighted by alpha so a fade from / to the clear spring wash keeps its hue instead of greying out
  const wa = a[3] * (1 - t);
  const wc = c[3] * t;
  const ws = wa + wc || 1;
  const ch = (k) => Math.round((a[k] * wa + c[k] * wc) / ws);
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${Math.round(al * 1000) / 1000})`;
}

/**
 * Weather intensities { snow, leaves } (0..1) for a season blend; a mild (year-0) winter snows at half strength.
 * @param {{ from: string, to: string, t: number }} b
 * @param {boolean} [mild=false]
 * @returns {{ snow: number, leaves: number }}
 */
export function blendWeather(b, mild = false) {
  const a = SEASON_WEATHER[b.from] || SEASON_WEATHER.spring;
  const c = SEASON_WEATHER[b.to] || SEASON_WEATHER.spring;
  const t = b.to === b.from ? 0 : b.t;
  const snowK = mild ? 0.5 : 1;
  return { snow: (a.snow + (c.snow - a.snow) * t) * snowK, leaves: a.leaves + (c.leaves - a.leaves) * t };
}
