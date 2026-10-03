// Per-run surface generation: terrain (value noise → shares, garden-path strips, root clusters, puddles, logs), fixed
// sources, rival spawn specs, root columns for the nest, reveal rings. Pure and seeded. Owner: WP4.
// Contract: ARCHITECTURE §8.3 (mapgen.js), §7.9 (makeHolder(mapSeed)); DESIGN §8.2, §8.4, §8.9, §13.6, §13.7.

import { MAP, TERRAIN, TERRAIN_ORDER } from '../data/surface.js';
import { SOURCES, SOURCE_ORDER } from '../data/sources.js';
import { SITES, BOONS } from '../data/prestige.js';
import { TRAITS as BLOODLINE } from '../data/bloodline.js';
import { RIVALS, RIVAL_ORDER, SPAWN, ELDER } from '../data/rivals.js';
import { makeHolder, rand, randInt, pick } from '../core/rng.js';
import { HEX_COUNT, DIRS, hexIndex, hexQR, ringOf, neighbors, hexDist, hexToPixel, pixelToHex, countInRadius, lineHexes,
  colForHex, hexPath } from '../core/hex.js';

/**
 * @typedef {Object} MapGenResult
 * @property {number[]} terrain       817 terrain codes (index = hex spiral index)
 * @property {import('../core/types.js').Source[]} sources   uids 1..n
 * @property {number} nextUid
 * @property {Array<{ type: (string|null), tier: number, hex: number }>} rivalSpecs
 * @property {number[]} rootCols      nest columns of plants within MAP.rootRing (unique, in source order)
 * @property {number} revealRings
 */

const CODE = Object.freeze(Object.fromEntries(TERRAIN_ORDER.map((id, i) => [id, i])));
const ROOT_PLANTS = Object.freeze(['flower_patch', 'leaf_plant', 'aphid_colony']);   // DESIGN §7.9: plants that hang root lines
const SQRT3 = Math.sqrt(3);
/** Pixel centre (size 1) of every hex, used to sample the noise fields. */
const PIX = Array.from({ length: HEX_COUNT }, (_, i) => hexToPixel(i, 1));

/**
 * fx value of a data-table entry, or `fallback` when the owning package's table does not carry it (yet).
 * @param {Object} table
 * @param {string} id
 * @param {string} key
 * @param {*} fallback
 */
function fxOf(table, id, key, fallback) {
  const e = table && table[id];
  const v = e && e.fx ? e.fx[key] : undefined;
  return v === undefined || v === null ? fallback : v;
}

/** @returns {boolean} true when the generator treats this terrain code as walkable in every season */
function passableGen(code) {
  return code !== CODE.stone && code !== CODE.puddle;
}

/** Hex indices of rings rMin..rMax (inclusive, clipped to the stored map). */
function ringRange(rMin, rMax) {
  const lo = Math.max(0, Math.floor(rMin));
  const hi = Math.min(ringOf(HEX_COUNT - 1), Math.floor(rMax));
  if (hi < lo) return [];
  const start = lo === 0 ? 0 : countInRadius(lo - 1);
  const end = countInRadius(hi);
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/**
 * Lattice value noise sampled in pixel space (bilinear with smoothstep), from `cell`-sized lattice squares.
 * @param {import('../core/types.js').Holder} h
 * @param {number} cell lattice spacing in pixel units (hex size 1)
 * @returns {(x: number, y: number) => number}
 */
function valueNoise(h, cell) {
  const x0 = -32;
  const y0 = -28;
  const nx = Math.ceil(64 / cell) + 2;
  const ny = Math.ceil(56 / cell) + 2;
  const v = new Float64Array(nx * ny);
  for (let i = 0; i < v.length; i++) v[i] = rand(h);
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x - x0) / cell;
    const fy = (y - y0) / cell;
    const ix = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
    const iy = Math.max(0, Math.min(ny - 2, Math.floor(fy)));
    const tx = sm(Math.min(1, Math.max(0, fx - ix)));
    const ty = sm(Math.min(1, Math.max(0, fy - iy)));
    const a = v[iy * nx + ix];
    const b = v[iy * nx + ix + 1];
    const c = v[(iy + 1) * nx + ix];
    const e = v[(iy + 1) * nx + ix + 1];
    return (a + (b - a) * tx) + ((c + (e - c) * tx) - (a + (b - a) * tx)) * ty;
  };
}

/** Two-octave noise value for every hex. */
function noiseValues(h) {
  const n1 = valueNoise(h, 5);
  const n2 = valueNoise(h, 2.5);
  const out = new Float64Array(HEX_COUNT);
  for (let i = 0; i < HEX_COUNT; i++) out[i] = n1(PIX[i][0], PIX[i][1]) + 0.5 * n2(PIX[i][0], PIX[i][1]);
  return out;
}

/** Set the `count` eligible hexes with the highest noise value (ties by lower index) to `code`. */
function assignTop(terrain, values, code, count, eligible) {
  if (!(count > 0)) return;
  const cand = [];
  for (let i = 0; i < HEX_COUNT; i++) if (eligible(i)) cand.push(i);
  cand.sort((a, b) => (values[b] - values[a]) || (a - b));
  for (let k = 0; k < cand.length && k < count; k++) terrain[cand[k]] = code;
}

/** Nearest valid hex to a pixel point, shrinking toward (cx, cy) until it lies on the map. */
function hexNear(x, y, cx, cy) {
  for (let t = 1; t > 0; t -= 0.05) {
    const i = pixelToHex(cx + (x - cx) * t, cy + (y - cy) * t, 1);
    if (i >= 0) return i;
  }
  return pixelToHex(cx, cy, 1);
}

/** Target hex count of a terrain type (share × map size). */
function targetCount(id) {
  return Math.round(TERRAIN[id].share * HEX_COUNT);
}

/** Garden-path strips: straight 1-hex lines through the playable area (DESIGN §8.2: 1–2 strips, ×2 with site_garden_path). */
function placePaths(h, terrain, pathMult) {
  const def = TERRAIN.garden_path;
  const lo = def.strips ? def.strips[0] : 1;
  const hi = def.strips ? def.strips[1] : 1;
  const strips = randInt(h, lo, hi) * pathMult;
  const per = Math.max(2, Math.round((targetCount('garden_path') * pathMult) / Math.max(1, strips)));
  const centres = ringRange(2, Math.max(2, MAP.radiusBase - 1));
  for (let k = 0; k < strips; k++) {
    const c = pick(h, centres);
    const theta = rand(h) * Math.PI;
    const [cx, cy] = PIX[c];
    const half = (per / 2) * SQRT3;
    const dx = Math.cos(theta) * half;
    const dy = Math.sin(theta) * half;
    const a = hexNear(cx - dx, cy - dy, cx, cy);
    const b = hexNear(cx + dx, cy + dy, cx, cy);
    for (const i of lineHexes(a, b)) terrain[i] = CODE.garden_path;
  }
}

/** Tree-root clusters grown from random grass seeds until the target count is reached. */
function placeRootClusters(h, terrain) {
  const def = TERRAIN.tree_root;
  const cMin = def.cluster ? def.cluster[0] : 1;
  const cMax = def.cluster ? def.cluster[1] : 1;
  let left = targetCount('tree_root');
  for (let guard = 0; left > 0 && guard < HEX_COUNT; guard++) {
    const seeds = [];
    for (let i = countInRadius(1); i < HEX_COUNT; i++) if (terrain[i] === CODE.grass) seeds.push(i);
    const seed = pick(h, seeds);
    if (seed === null) break;
    const size = Math.min(left, randInt(h, cMin, cMax));
    const members = [seed];
    terrain[seed] = CODE.tree_root;
    let frontier = [seed];
    while (members.length < size && frontier.length > 0) {
      const from = pick(h, frontier);
      const open = neighbors(from).filter((n) => terrain[n] === CODE.grass && ringOf(n) > 1);
      if (open.length === 0) {
        frontier = frontier.filter((f) => f !== from);
        continue;
      }
      const n = pick(h, open);
      terrain[n] = CODE.tree_root;
      members.push(n);
      frontier.push(n);
    }
    left -= members.length;
  }
}

/** 0–1 fallen logs: short straight runs of grass turned to log (DESIGN §8.2). */
function placeLogs(h, terrain) {
  const def = TERRAIN.log;
  const n = randInt(h, def.count ? def.count[0] : 0, def.count ? def.count[1] : 1);
  const len = Math.max(1, targetCount('log'));
  for (let k = 0; k < n; k++) {
    const starts = ringRange(def.ringMin ?? 1, def.ringMax ?? MAP.radiusBase).filter((i) => terrain[i] === CODE.grass);
    const start = pick(h, starts);
    if (start === null) return;
    const dir = DIRS[randInt(h, 0, DIRS.length - 1)];
    let [q, r] = hexQR(start);
    for (let s = 0; s < len; s++) {
      const i = hexIndex(q, r);
      if (i < 0 || terrain[i] !== CODE.grass) break;
      terrain[i] = CODE.log;
      q += dir[0];
      r += dir[1];
    }
  }
}

/** Flood fill from hex 0 over hexes walkable in every season. */
function reachable(terrain) {
  const seen = new Uint8Array(HEX_COUNT);
  const queue = [0];
  seen[0] = 1;
  for (let k = 0; k < queue.length; k++) {
    for (const n of neighbors(queue[k])) {
      if (!seen[n] && passableGen(terrain[n])) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  return seen;
}

/** Guarantee a walkable route from hex 0 to every target hex by turning blocking hexes on the cheapest route to grass. */
function carveRoutes(terrain, targets) {
  let seen = reachable(terrain);
  for (const t of targets) {
    if (seen[t]) continue;
    const route = hexPath(0, t, (i) => {
      if (passableGen(terrain[i])) return TERRAIN[TERRAIN_ORDER[terrain[i]]].move || 1;
      return HEX_COUNT; // blocked hexes are crossed only when no walkable detour exists
    });
    if (!route) continue;
    for (const i of route.path) if (!passableGen(terrain[i])) terrain[i] = CODE.grass;
    seen = reachable(terrain);
  }
}

/** Rival type for a ladder tier (first RIVAL_ORDER entry with that tier), or null if the rival table is not available. */
function rivalTypeForTier(tier) {
  for (const id of RIVAL_ORDER) if (RIVALS[id] && RIVALS[id].tier === tier) return id;
  return RIVAL_ORDER[tier - 1] ?? null;
}

/**
 * Build one source record. Finite stocks are sized now (at base: a fresh run has no income yet) when the hex starts
 * revealed, otherwise flagged unsized (C34); sources beyond the starting radius are dormant.
 */
function makeSource(uid, type, hex, revealRings, level = 1) {
  const def = SOURCES[type];
  const ring = ringOf(hex);
  const src = { uid, type, hex, stock: -1, max: -1, level, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} };
  // ARCH-R: revealed finite sources are sized at map generation with gross food/s = 0 (the new run has no income yet),
  // i.e. max = stock.base; seed patches then follow the live gross rate every tick (DESIGN §8.4).
  const dormant = ring > MAP.radiusBase;
  if (def.stock) {
    if (!dormant && ring <= revealRings) {
      src.max = def.stock.base;
      src.stock = def.stock.base;
    } else {
      src.stock = 0;
      src.max = 0;
      src.data.unsized = true;
    }
  }
  if (dormant) src.data.dormant = true;
  return src;
}

/**
 * Generate a whole surface map from a seed (all 817 hexes at once).
 * @param {number} seed uint32 map seed
 * @param {{ tags?: string[], boon?: (string|null), traits?: Object<string, number>, species?: string }} [opts]
 * @returns {MapGenResult}
 */
export function generateMap(seed, { tags = [], boon = null, traits = {}, species = 'garden_ant' } = {}) {
  const h = makeHolder(seed);
  const tagList = Array.isArray(tags) ? tags : [];
  const has = (t) => tagList.includes(t);
  const tr = traits && typeof traits === 'object' ? traits : {};
  void species; // ARCH-R: no species changes the surface in DESIGN; the option is accepted for the contract signature.

  // ---- terrain -------------------------------------------------------------------------------------------------
  const terrain = new Array(HEX_COUNT).fill(CODE.grass);
  const pathMult = has('site_garden_path') ? fxOf(SITES, 'site_garden_path', 'paths', 1) : 1;
  const puddleMult = has('site_wet_hollow') ? fxOf(SITES, 'site_wet_hollow', 'puddles', 1) : 1;
  placePaths(h, terrain, pathMult);
  const outer = (i) => ringOf(i) > 1 && terrain[i] === CODE.grass;   // rings 0–1 stay passable
  assignTop(terrain, noiseValues(h), CODE.stone, targetCount('stone'), outer);
  assignTop(terrain, noiseValues(h), CODE.puddle, targetCount('puddle') * puddleMult, outer);
  assignTop(terrain, noiseValues(h), CODE.leaf_litter, targetCount('leaf_litter'), (i) => terrain[i] === CODE.grass);
  assignTop(terrain, noiseValues(h), CODE.sand, targetCount('sand'), (i) => terrain[i] === CODE.grass);
  placeRootClusters(h, terrain);
  placeLogs(h, terrain);
  for (let i = 0; i < countInRadius(1); i++) if (!passableGen(terrain[i])) terrain[i] = CODE.grass;

  // ---- reveal rings ----------------------------------------------------------------------------------------------
  let revealRings = MAP.revealStart;
  if ((tr.keen_antennae || 0) >= 1) revealRings = Math.max(revealRings, fxOf(BLOODLINE, 'keen_antennae', 'reveal', MAP.revealStart));
  if (boon === 'boon_scouts_lead') revealRings = Math.max(revealRings, fxOf(BOONS, 'boon_scouts_lead', 'reveal', MAP.revealStart));

  // ---- sources ---------------------------------------------------------------------------------------------------
  const used = new Set([0]);
  const sources = [];
  let nextUid = 1;
  const pickHex = (rMin, rMax, terrainId) => {
    const ring = ringRange(Math.max(1, rMin), rMax).filter((i) => !used.has(i) && passableGen(terrain[i]));
    const want = terrainId && CODE[terrainId] !== undefined ? CODE[terrainId] : -1;
    const match = want >= 0 ? ring.filter((i) => terrain[i] === want) : ring;
    let hex = pick(h, match);
    if (hex === null && want >= 0) {
      hex = pick(h, ring);
      if (hex !== null) terrain[hex] = want; // no hex of the required terrain in the band: grow one
    }
    return hex === null ? -1 : hex;
  };
  const add = (type, rMin, rMax, terrainId, level = 1) => {
    const hex = pickHex(rMin, rMax, terrainId);
    if (hex < 0) return;
    used.add(hex);
    sources.push(makeSource(nextUid++, type, hex, revealRings, level));
  };

  const crumb = SOURCES.crumb_scatter.spawn;
  add('crumb_scatter', crumb.rMin, crumb.rMax, crumb.terrain);
  const aphid = SOURCES.aphid_colony.spawn;
  if (boon === 'boon_next_to_aphids') {
    const ring = fxOf(BOONS, 'boon_next_to_aphids', 'ring', null);
    if (ring !== null) add('aphid_colony', ring, ring, aphid.terrain);
  }
  if ((tr.sweet_inheritance || 0) >= 1) {
    // ARCH-R: without the WP7 trait data (fx.ring / fx.aphidLevel) the bonus colony is skipped rather than guessed.
    const ring = fxOf(BLOODLINE, 'sweet_inheritance', 'ring', null);
    const level = fxOf(BLOODLINE, 'sweet_inheritance', 'aphidLevel', null);
    if (ring !== null && level !== null) add('aphid_colony', ring, ring, aphid.terrain, level);
  }
  for (const type of SOURCE_ORDER) {
    const sp = SOURCES[type].spawn;
    if (type === 'crumb_scatter' || !sp || sp.mode !== 'fixed') continue;
    let count = sp.count || 0;
    if (type === 'seed_patch' && has('site_seed_meadow')) count += fxOf(SITES, 'site_seed_meadow', 'seedAdd', 0);
    if (type === 'aphid_colony' && has('site_aphid_dense')) count += fxOf(SITES, 'site_aphid_dense', 'aphidAdd', 0);
    // ARCH-R: DESIGN §24.1 (2:00 beat) and the Balance Verification rely on a seed patch 2 hexes out, visible at 0:00;
    // spawn.firstAtMin places the first one on ring rMin, the rest anywhere in rMin..rMax.
    for (let k = 0; k < count; k++) add(type, sp.rMin, k === 0 && sp.firstAtMin ? sp.rMin : sp.rMax, sp.terrain);
  }

  // ---- rival spawn specs -----------------------------------------------------------------------------------------
  const tiers = has('site_hostile_neighbours') ? fxOf(SITES, 'site_hostile_neighbours', 'tiers', [1, 2]) : [1, 2];
  const bands = [SPAWN.tier1Ring, SPAWN.tier2Ring];
  const maxRivals = (SPAWN.maxByRadius && SPAWN.maxByRadius[MAP.radiusBase]) ?? bands.length;
  const rivalSpecs = [];
  for (let k = 0; k < Math.min(tiers.length, bands.length, maxRivals); k++) {
    const tier = tiers[k];
    const type = rivalTypeForTier(tier);
    const rad = (type && RIVALS[type] && RIVALS[type].radius) || ELDER.radius;
    const band = ringRange(bands[k][0], bands[k][1]).filter((i) => !used.has(i) && passableGen(terrain[i]));
    const apart = band.filter((i) => rivalSpecs.every((r) => hexDist(i, r.hex) > 2 * rad));
    const hex = pick(h, apart.length ? apart : band);
    if (hex === null) continue;
    used.add(hex);
    rivalSpecs.push({ type, tier, hex });
  }

  // ---- reachability: every source and rival nest can be walked to from the entrance --------------------------------
  carveRoutes(terrain, [...sources.map((s) => s.hex), ...rivalSpecs.map((r) => r.hex)]);

  // ---- root columns (plants within MAP.rootRing) -----------------------------------------------------------------
  // ARCH-R: duplicate columns are dropped so the nest never gets two root lines in one column.
  const rootCols = [];
  for (const src of sources) {
    if (!ROOT_PLANTS.includes(src.type) || ringOf(src.hex) > MAP.rootRing) continue;
    const col = colForHex(src.hex);
    if (!rootCols.includes(col)) rootCols.push(col);
  }

  return { terrain, sources, nextUid, rivalSpecs, rootCols, revealRings };
}
