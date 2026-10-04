// Underground nest rules: derive (geometry caches gated on rev, frost exposure, chamber eff, every d.nest.agg field),
// the dig queue and dig tick (caches, hints, water, activation, shafts/entrances), placement validation with ghost
// tints / modifiers / auto-route, level-ups with growth direction, relocate, demolish, tunnels, backfill, Help Dig,
// blueprints, and the cross-calls queueShaft / applyBlueprint / autoLevelStep / moleTunnel. Owner: WP3.
// Contract: ARCHITECTURE §8.2 (nest.js), §4 (s.run.nest, era.blueprints), §5 (d.nest), §9, §10; DESIGN §7, §17.3.

import { GRID, CELL, CLAMP_MAX } from '../data/balance.js';
import { MICRO, DIG, GEOM, ADVISOR } from '../data/strata.js';
import { CHAMBERS, CHAMBER_RULES, ADJACENCY, ADJACENCY_ORDER } from '../data/chambers.js';
import { CACHES, MOLE, DRAINAGE, ROOT_CULT } from '../data/soilFeatures.js';
import { FROST } from '../data/seasons.js';
import { MOUND } from '../data/surface.js';
import { CAPS } from '../data/economy.js';
import { FLIGHT } from '../data/prestige.js';
import { canAfford, spend, refund, grant, incomeSeconds } from '../core/wallet.js';
import { effectMult } from '../core/effects.js';
import { costOrNull } from '../core/math.js';
import { clickAvailable, consumeClick } from '../core/state.js';
import { randInt } from '../core/rng.js';
import * as G from './nestgeom.js';
import { addEntrance, nuptialHex } from './surface.js';
import { spawnBeetle } from './golden.js';

const COLS = GRID.cols;
const ROWS = GRID.rows;
const N = COLS * ROWS;
const DUG_KINDS = new Set(['chamber', 'grow', 'relocate']);
const DIRS = new Set(['left', 'right', 'up', 'down']);
const NAME_MAX = 40;

// ------------------------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------------------------

function emit(env, type, payload) {
  if (env && typeof env.emit === 'function') env.emit(type, payload);
}

function isInt(v) {
  return Number.isInteger(v);
}

function isCell(v) {
  return Number.isInteger(v) && v >= 0 && v < N;
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function adj4(a, b) {
  const d = Math.abs(a - b);
  if (d === COLS) return true;
  return d === 1 && Math.floor(a / COLS) === Math.floor(b / COLS);
}

function fail(P, reason) {
  P.reason = reason;
  return P;
}

/** Chamber is contributing: 'active' or 'growing' (at its current level). */
function contributes(ch) {
  return ch.status === 'active' || ch.status === 'growing';
}

function findChamber(s, uid) {
  const chs = s.run.nest.chambers;
  for (let j = 0; j < chs.length; j++) if (chs[j].uid === uid) return { ch: chs[j], j };
  return null;
}

function findJob(s, uid) {
  const q = s.run.nest.queue;
  for (let j = 0; j < q.length; j++) if (q[j].uid === uid) return { job: q[j], j };
  return null;
}

function countType(s, type) {
  let n = 0;
  for (const ch of s.run.nest.chambers) if (ch.type === type) n++;
  return n;
}

function bonusOwned(s, b) {
  if (!b) return false;
  if (b.research) return G.hasResearch(s, b.research);
  if (b.trait) return G.traitLevel(s, b.trait) > 0;
  if (b.federation) return G.fedLevel(s, b.federation) > 0;
  return false;
}

/** Blueprints are available with ancestral_blueprint or blueprint_memory. */
function blueprintsAllowed(s) {
  return G.traitLevel(s, 'ancestral_blueprint') > 0 || G.fedLevel(s, 'blueprint_memory') > 0;
}

function blueprintSlots(s) {
  return G.fedLevel(s, 'blueprint_memory') > 0 ? Math.max(1, G.fxNum('federation', 'blueprint_memory', 'slots')) : 1;
}

/** Dig queue limit: 5 + 2·[load_chains] + 2·[automaton_instincts] (DESIGN §7.2). */
function queueLimit(s) {
  let n = DIG.queueBase;
  if (G.hasResearch(s, 'load_chains')) n += G.fxNum('research', 'load_chains', 'queue');
  if (G.traitLevel(s, 'automaton_instincts') > 0) n += G.fxNum('trait', 'automaton_instincts', 'queue');
  return n;
}

/**
 * Row minimum with the leafcutter Fungus Garden override (species mods.gardenRowMin) and the Shallow Soil Nuptial
 * Chamber override (C67): in a shallow_soil run nothing is dug below row 23, so the Nuptial Chamber (row ≥ 24, a
 * Flight requirement) may instead sit high enough that its largest footprint (its max level) still ends on row 23;
 * without this the Flight, the only way out of that Hardship run, could never be taken.
 */
function effRowMin(s, d, type) {
  const def = CHAMBERS[type];
  if (type === 'fungus_garden') {
    const sp = d && d.meta && d.meta.sp;
    if (sp && Number.isFinite(sp.gardenRowMin)) return sp.gardenRowMin;
  }
  if (type === 'nuptial_chamber' && s.run.hardship === 'shallow_soil') {
    const maxL = effMaxL(s, def);
    const top = G.footprint(type, maxL > 0 ? Math.min(maxL, GEOM.footprintMaxL) : GEOM.footprintMaxL);
    return Math.max(1, Math.min(def.rowMin, DIG.shallowSoilRow - top.h + 1));
  }
  return def.rowMin;
}

/** Effective max level (maxLBonus, e.g. royal_court → Nuptial Chamber L9); 0 = uncapped. */
function effMaxL(s, def) {
  if (def.maxLBonus && bonusOwned(s, def.maxLBonus)) return def.maxLBonus.maxL;
  return def.maxL;
}

/** Instance limit (DESIGN §7.6): maxInst + owned bonuses; water wells: one per revealed pocket. */
function instLimit(s, d, type) {
  const def = CHAMBERS[type];
  if (def.maxInst === 'perPocket') {
    let n = 0;
    for (const w of s.run.nest.features.water || []) if (w.revealed) n++;
    return n;
  }
  let n = def.maxInst;
  for (const b of def.instBonus || []) if (bonusOwned(s, b)) n += b.add;
  if (type === 'royal_chamber') {
    // ARCH-R: species royalStart (fire ants start with 2) raises the Royal Chamber limit so the pre-dug extra queen
    // does not consume the polygyny / queens_council bonus.
    const sp = d && d.meta && d.meta.sp;
    const start = sp && Number.isFinite(sp.royalStart) ? sp.royalStart : 1;
    n += Math.max(0, start - 1);
  }
  return n;
}

function edictCostMult(s) {
  return s.cycle.edict === 'edict_of_depth' ? (G.fxNum('edict', 'edict_of_depth', 'chamberCost') || 1) : 1;
}

/** Hard-winter frost row for placement previews: max(4, 18 − 5·[thermoregulation] − min(6, floor(mound / 3))). */
function hardFrostRow(s, d) {
  const thermo = G.hasResearch(s, 'thermoregulation') ? G.fxNum('research', 'thermoregulation', 'frost') : 0;
  const mound = num(s.run.surface && s.run.surface.mound);
  const fromMound = Math.min(num(MOUND.frostMax), Math.floor(mound / (MOUND.frostPerLevels || 1)));
  const v = Math.max(num(FROST.minRow), num(FROST.maxRow) - thermo - fromMound);
  if (Number.isFinite(v) && v > 0) return v;
  return num(d && d.season && d.season.frostMax);
}

/** Additive nursery microclimate term for a layer in the current season (DESIGN §17.2). */
function nurseryMicro(s, layer, sid) {
  const m = MICRO[layer] && MICRO[layer].nursery;
  if (!m) return 0;
  let v = num(m[sid]);
  if (layer === 'topsoil') {
    const sunny = G.hasTag(s, 'site_sunny_slope');
    if (v < 0 && (sunny || G.hasResearch(s, 'thermoregulation') || G.hasResearch(s, 'thermal_brood_shuttling'))) v = 0;
    if (sid === 'autumn' && sunny) v = num(m.spring);
  }
  return v;
}

/** Gallery housing at level L: +10 per level; each level above 30 adds 10 + (L − 30) instead (DESIGN §7.6). */
function galleryHousing(fx, L) {
  const over = Math.max(0, L - fx.highL);
  return fx.housing * L + (over * (over + 1)) / 2;
}

// ------------------------------------------------------------------------------------------------------------------
// Geometry maintenance (d.nest)
// ------------------------------------------------------------------------------------------------------------------

/**
 * Chamber indices whose footprint is touched by, or joined through ≤ maxGap tunnel cells to, the source cells.
 * @returns {number[]} ascending chamber indices (never `self`)
 */
function nearChambers(geo, src, maxGap, self) {
  const field = G.gapField(geo, src, maxGap);
  const found = new Set();
  const stack = [];
  for (const c of src) stack.push(c);
  const seen = new Uint8Array(N);
  for (const c of src) seen[c] = 1;
  while (stack.length) {
    const c = stack.pop();
    for (const n of G.neighbors4(c)) {
      const m = geo.chamberAt[n];
      if (m >= 0 && m !== self) found.add(m);
      if (!seen[n] && field[n] > 0) { seen[n] = 1; stack.push(n); }
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Rebuild the rev-gated geometry and the static per-chamber entries, keeping dynamic fields by uid. */
function rebuild(s, d) {
  const dn = d.nest;
  const old = new Map();
  for (const c of dn.chambers || []) if (c && c.uid !== undefined) old.set(c.uid, c);
  G.buildGeom(s, dn);
  const chs = s.run.nest.chambers;
  const cells = s.run.nest.cells;
  const out = new Array(chs.length);
  const cellLists = new Array(chs.length);
  for (let j = 0; j < chs.length; j++) {
    const ch = chs[j];
    const rc = G.rectCells(ch.x, ch.y, ch.w, ch.h);
    cellLists[j] = rc;
    let minDist = -1;
    let minEnt = -1;
    let dug = 0;
    for (const c of rc) {
      if (!G.isOpenCode(cells[c])) continue;
      dug++;
      const dd = dn.dist[c];
      const de = dn.entDist[c];
      if (dd >= 0 && (minDist < 0 || dd < minDist)) minDist = dd;
      if (de >= 0 && (minEnt < 0 || de < minEnt)) minEnt = de;
    }
    const adj = nearChambers(dn, rc, GEOM.adjPathMax, j).map((m) => chs[m].uid);
    const prev = old.get(ch.uid);
    out[j] = {
      uid: ch.uid,
      layer: G.rectLayer(ch),
      exposed: prev ? !!prev.exposed : false,
      snap: prev ? !!prev.snap : false,
      eff: prev && Number.isFinite(prev.eff) ? prev.eff : 1,
      minEntPath: minEnt,
      inReach: minEnt >= 0 && minEnt <= GEOM.raidReach,
      adj,
      hygiene: false,
      hygieneBy: 0,
      cellsDug: dug,
      cellsTotal: ch.w * ch.h,
      minDist,
    };
  }
  // Hygiene: a Nursery or Fungus Garden within 6 path cells of a contributing Midden (DESIGN §7.7 hyg_midden).
  for (let j = 0; j < chs.length; j++) {
    if (chs[j].type !== 'midden' || !contributes(chs[j])) continue;
    for (const m of nearChambers(dn, cellLists[j], GEOM.hygienePath, j)) {
      const t = chs[m].type;
      if (t === 'nursery' || t === 'fungus_garden') {
        if (!out[m].hygiene) out[m].hygieneBy = chs[j].uid; // C109: the Midden named in the link badge
        out[m].hygiene = true;
      }
    }
  }
  dn.chambers = out;
}

/** Rebuild d.nest geometry if it does not match s.run.nest. */
function ensureGeom(s, d) {
  if (!G.geomFresh(s, d) || !Array.isArray(d.nest.chambers) || d.nest.chambers.length !== s.run.nest.chambers.length) {
    rebuild(s, d);
  }
  return d.nest;
}

/** Unfound caches that are hinted or within the hint radius (Chebyshev) of any open cell (DESIGN §7.9). */
function computeHints(s, geo) {
  const r = GEOM.hintRadius + (G.hasAch(s, 'ach_treasure_hunter') ? GEOM.hintRadiusAch : 0);
  const out = [];
  for (const c of s.run.nest.features.caches || []) {
    if (!c || c.found) continue;
    if (c.hinted || openWithin(geo.open, c.i % COLS, Math.floor(c.i / COLS), 1, 1, r)) out.push(c.i);
  }
  return out;
}

/** True if any open cell lies within Chebyshev distance r of the rectangle (x, y, w, h). */
function openWithin(open, x, y, w, h, r) {
  const x0 = Math.max(0, x - r);
  const x1 = Math.min(COLS - 1, x + w - 1 + r);
  const y0 = Math.max(0, y - r);
  const y1 = Math.min(ROWS - 1, y + h - 1 + r);
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * COLS;
    for (let xx = x0; xx <= x1; xx++) if (open[row + xx]) return true;
  }
  return false;
}

/** Reveal water pockets within the hint radius of any open cell (state; called from tick). */
function revealWater(s, geo) {
  const r = GEOM.hintRadius + (G.hasAch(s, 'ach_treasure_hunter') ? GEOM.hintRadiusAch : 0);
  for (const w of s.run.nest.features.water || []) {
    if (!w || w.revealed) continue;
    if (openWithin(geo.open, w.x, w.y, w.w, w.h, r)) w.revealed = true;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Job work
// ------------------------------------------------------------------------------------------------------------------

function jobChamber(s, job) {
  if (!job.chamber) return null;
  const f = findChamber(s, job.chamber);
  return f ? f.ch : null;
}

/** C117: cell c is one of a drain job's water cells (drained to soil, not dug open). */
function isDrainCell(job, c) {
  return job.kind === 'drain' && Array.isArray(job.drain) && job.drain.includes(c);
}

/** Cell c of a job still needs work: undug (not open), or for a drain cell, still water. */
function cellPending(s, job, c) {
  const code = s.run.nest.cells[c];
  return isDrainCell(job, c) ? code === CELL.WATER : !G.isOpenCode(code);
}

/** Work of cell c inside a job (route cells are tunnels; relocation cells × 0.5 × architect). */
function jobCellWork(s, ctx, job, ch, c) {
  if (isDrainCell(job, c)) return G.workAt(ctx, c, job.to ? 'movePocket' : 'drain');
  const inFoot = !!ch && DUG_KINDS.has(job.kind) && G.inRect(ch, c);
  const kind = job.kind === 'shaft' ? 'shaft' : inFoot ? job.kind : 'tunnel';
  let w = G.workAt(ctx, c, kind, job.blueprint);
  if (inFoot && job.kind === 'relocate') {
    w *= DIG.relocateWorkFrac * (G.hasAch(s, 'ach_architect') ? DIG.architectMult : 1);
  }
  return w;
}

/** Remaining work of a job (undug cells from cur, minus progress on the current cell). */
function remainingWork(s, ctx, job) {
  const ch = jobChamber(s, job);
  let w = 0;
  let first = true;
  for (let k = job.cur; k < job.cells.length; k++) {
    const c = job.cells[k];
    if (!isCell(c) || !cellPending(s, job, c)) continue;
    let cw = jobCellWork(s, ctx, job, ch, c);
    if (first && k === job.cur) cw = Math.max(0, cw - num(job.prog));
    first = false;
    w += cw;
  }
  return w;
}

function totalQueueWork(s) {
  const ctx = G.workCtx(s);
  let w = 0;
  for (const job of s.run.nest.queue) w += remainingWork(s, ctx, job);
  return w;
}

/** d.nest.queueInfo ([{ uid, work, eta }]) and d.nest.digFace. */
function fillQueueInfo(s, d) {
  const nest = s.run.nest;
  const ctx = G.workCtx(s);
  const W = Math.max(0, num(d.stats && d.stats.digW));
  let cum = 0;
  const info = [];
  for (const job of nest.queue) {
    const work = remainingWork(s, ctx, job);
    cum += work;
    info.push({ uid: job.uid, work, eta: W > 0 ? cum / W : -1 });
  }
  d.nest.queueInfo = info;
  let face = -1;
  if (nest.queue.length) {
    const job = nest.queue[0];
    for (let k = job.cur; k < job.cells.length; k++) {
      const c = job.cells[k];
      if (isCell(c) && cellPending(s, job, c)) { face = c; break; }
    }
  }
  d.nest.digFace = face;
}

// ------------------------------------------------------------------------------------------------------------------
// Digging
// ------------------------------------------------------------------------------------------------------------------

/** Collect the cache on cell c, if any (DESIGN §7.9). */
function collectCache(s, d, c, env) {
  for (const cache of s.run.nest.features.caches || []) {
    if (!cache || cache.i !== c || cache.found) continue;
    cache.found = true;
    s.meta.counters.caches++;
    if (cache.kind === 'amber_bead') {
      s.meta.counters.amber++;
      // ARCH-R: Golden Beetles are frozen offline (DESIGN §21.4), so an amber bead dug offline spawns no beetle.
      if (!(env && env.offline)) spawnBeetle(s, d);
      emit(env, 'cacheFound', { i: c, kind: cache.kind, res: null, amount: 0 });
    } else {
      const spec = CACHES.kinds[cache.kind];
      if (!spec) continue;
      const amt = incomeSeconds(d, spec.res, spec.sec, spec.min);
      // F3: a seed cache is a one-shot food reward, so it may overflow to FOOD_OVERFLOW × cap (DESIGN §3).
      const added = grant(s, d, spec.res, amt, { overflow: spec.res === 'food' });
      emit(env, 'cacheFound', { i: c, kind: cache.kind, res: spec.res, amount: added });
    }
  }
}

/** A queued cell is finished: set its code, bump rev, counters, cache, events / offline log. */
function completeCell(s, d, job, ch, c, env) {
  const nest = s.run.nest;
  if (isDrainCell(job, c)) {
    // C117: a drained water cell becomes plain, diggable soil (not a dug cell: no counters, no cache).
    nest.cells[c] = CELL.SOIL;
    nest.rev++;
    if (!(env && env.offline)) emit(env, 'cellDug', { i: c });
    return;
  }
  const inFoot = !!ch && DUG_KINDS.has(job.kind) && G.inRect(ch, c);
  nest.cells[c] = inFoot ? CELL.CHAMBER : CELL.TUNNEL;
  nest.rev++;
  const y = Math.floor(c / COLS);
  if (y > nest.deepestRow) nest.deepestRow = y;
  if (nest.deepestRow > s.meta.stats.deepestRow) s.meta.stats.deepestRow = nest.deepestRow;
  s.meta.counters.cellsDug++;
  s.run.stats.cellsDug++;
  if (env && env.offline) {
    if (d.offlineLog && Array.isArray(d.offlineLog.cells)) d.offlineLog.cells.push(c);
  } else {
    emit(env, 'cellDug', { i: c });
  }
  collectCache(s, d, c, env);
}

/** Remove a finished job from the queue and apply its completion (activation, level, shaft opening). */
function finishJob(s, d, job, env) {
  const nest = s.run.nest;
  const k = nest.queue.indexOf(job);
  if (k >= 0) nest.queue.splice(k, 1);
  nest.rev++;
  const ch = jobChamber(s, job);
  if (job.kind === 'chamber' && ch) {
    ch.status = 'active';
    ch.level = Math.max(1, ch.target);
    ch.target = ch.level;
    s.run.stats.chambersDone++;
    emit(env, 'chamberActivated', { uid: ch.uid, chamberType: ch.type, level: ch.level });
    if (env && env.offline && d.offlineLog && Array.isArray(d.offlineLog.chambers)) d.offlineLog.chambers.push(ch.uid);
  } else if (job.kind === 'grow' && ch) {
    ch.status = 'active';
    ch.level = Math.max(ch.level, ch.target);
    ch.target = ch.level;
    emit(env, 'chamberLeveled', { uid: ch.uid, level: ch.level });
  } else if (job.kind === 'relocate' && ch) {
    ch.status = 'active';
    emit(env, 'chamberActivated', { uid: ch.uid, chamberType: ch.type, level: ch.level });
    if (env && env.offline && d.offlineLog && Array.isArray(d.offlineLog.chambers)) d.offlineLog.chambers.push(ch.uid);
  } else if (job.kind === 'shaft') {
    let col = -1;
    for (const c of job.cells) if (isCell(c) && c < COLS) { col = c; break; }
    const sh = nest.shafts.find((x) => x && !x.open && x.col === col);
    if (sh) {
      sh.open = true;
      if (sh.kind === 'nuptial') addEntrance(s, d, 'nuptial', nuptialHex(s, d, col), col, -1);
      emit(env, 'entranceOpened', { kind: sh.kind, col });
    }
  } else if (job.kind === 'drain') {
    finishDrain(s, d, job);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Water pockets: drain / relocate (C117, research `drainage`)
// ------------------------------------------------------------------------------------------------------------------

/** Index of the water pocket with this rectangle in features.water, or −1. */
function pocketIndex(s, pk) {
  const water = s.run.nest.features.water || [];
  if (!pk) return -1;
  return water.findIndex((p) => p && p.x === pk.x && p.y === pk.y && p.w === pk.w && p.h === pk.h);
}

/** A drain / relocate job is queued for this pocket. */
function pocketBusy(s, p) {
  return s.run.nest.queue.some((j) => j && j.kind === 'drain' && j.pocket && j.pocket.x === p.x && j.pocket.y === p.y
    && j.pocket.w === p.w && j.pocket.h === p.h);
}

/**
 * Reason a pocket rectangle cannot move to `rect`, or null: inside the grid, top row ≥ 1 and within DRAINAGE.moveRows
 * rows of the pocket, every cell plain undug SOIL (no stone, water, tunnel, chamber, shaft, queued or backfilling cell,
 * no buried cache), Shallow Soil's depth limit.
 */
function pocketSpotBlock(s, geo, rect, p) {
  if (!rect || !isInt(rect.x) || !isInt(rect.y)) return 'invalid';
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > COLS || rect.y + rect.h > ROWS) return 'invalid:bounds';
  if (rect.y < 1 || Math.abs(rect.y - p.y) > DRAINAGE.moveRows) return 'invalid:row';
  if (s.run.hardship === 'shallow_soil' && rect.y + rect.h - 1 > DIG.shallowSoilRow) return 'hardship';
  const cells = s.run.nest.cells;
  const cache = new Set();
  for (const k of s.run.nest.features.caches || []) if (k && !k.found) cache.add(k.i);
  for (const c of G.rectCells(rect.x, rect.y, rect.w, rect.h)) {
    const code = cells[c];
    if (code === CELL.WATER) return 'blocked:water';
    if (geo.chamberAt[c] >= 0) return 'blocked:chamber';
    if (code === CELL.STONE) return 'blocked:stone';
    if (code !== CELL.SOIL) return 'blocked:open';
    if (geo._queued[c]) return 'blocked:queued';
    if (geo._backfill[c]) return 'blocked:backfill';
    if (cache.has(c)) return 'blocked:cache';
  }
  return null;
}

/**
 * Drain (to = null) or relocate (to = { x, y }) plan for water pocket k: research, revealed, not busy, an auto-routed
 * tunnel to it (DESIGN §7.2 route), queue room, the target spot (relocate) and, for a drain, the soil.
 * @returns {{ reason: string|null, k?: number, p?: Object, wet?: number[], route?: number[], cost?: Object, work?: number }}
 */
function planPocket(s, d, k, to = null) {
  if (!G.hasResearch(s, DRAINAGE.research)) return { reason: 'locked' };
  const water = s.run.nest.features.water || [];
  if (!isInt(k) || k < 0 || k >= water.length || !water[k] || !water[k].revealed) return { reason: 'notFound' };
  const p = water[k];
  if (pocketBusy(s, p)) return { reason: 'busy' };
  const cells = s.run.nest.cells;
  const wetList = G.rectCells(p.x, p.y, p.w, p.h).filter((c) => cells[c] === CELL.WATER);
  if (!wetList.length) return { reason: 'invalid' };
  const geo = G.getGeom(s, d);
  if (to) {
    const rect = { x: to.x, y: to.y, w: p.w, h: p.h };
    const why = pocketSpotBlock(s, geo, rect, p);
    if (why) return { reason: why };
    if (blocksRoyalGrowth(s, rect, 0, { d })) return { reason: 'blocked:royalRoom' };
  }
  const r = G.routeTo(s, d, wetList);
  if (!r) return { reason: 'blocked:route' };
  if (s.run.nest.queue.length + 1 > queueLimit(s)) return { reason: 'queueFull' };
  const wet = orderCells(geo, wetList, r.cells);
  const ctx = G.workCtx(s);
  let work = 0;
  for (const c of r.cells) work += G.workAt(ctx, c, 'tunnel');
  for (const c of wet) work += G.workAt(ctx, c, to ? 'movePocket' : 'drain');
  const cost = to ? {} : { soil: DRAINAGE.drainSoil * wet.length };
  if (!to && !canAfford(s, cost)) return { reason: 'cantAfford', k, p, wet, route: r.cells, cost, work };
  return { reason: null, k, p, wet, route: r.cells, cost, work };
}

/** Queue a drain / relocate job from a successful planPocket (soil paid now). */
function executePocket(s, d, P, to) {
  const nest = s.run.nest;
  if (P.cost && P.cost.soil > 0 && !spend(s, P.cost)) return 0;
  const uid = nest.nextUid++;
  nest.queue.push({ uid, kind: 'drain', chamber: 0, cells: [...P.route, ...P.wet], cur: 0, prog: 0, paidFood: 0,
    paidSoil: P.cost && P.cost.soil > 0 ? P.cost.soil : 0, blueprint: false, drain: P.wet.slice(),
    pocket: { x: P.p.x, y: P.p.y, w: P.p.w, h: P.p.h }, to: to ? { x: to.x, y: to.y } : null });
  nest.rev++;
  rebuild(s, d);
  return uid;
}

/**
 * A drain / relocate job finished: the pocket's last water cells become soil; a relocated pocket fills its new spot
 * (if that spot is still plain soil, else it is simply drained), a drained one is removed. Water Wells left touching
 * no pocket are removed with their placement food refunded in full (C117).
 */
function finishDrain(s, d, job) {
  const nest = s.run.nest;
  const water = nest.features.water || [];
  const k = pocketIndex(s, job.pocket);
  const p = k >= 0 ? water[k] : job.pocket;
  if (p) for (const c of G.rectCells(p.x, p.y, p.w, p.h)) if (nest.cells[c] === CELL.WATER) nest.cells[c] = CELL.SOIL;
  nest.rev++;
  let moved = false;
  if (k >= 0 && job.to && isInt(job.to.x) && isInt(job.to.y)) {
    const rect = { x: job.to.x, y: job.to.y, w: p.w, h: p.h };
    if (!pocketSpotBlock(s, ensureGeom(s, d), rect, p)) {
      for (const c of G.rectCells(rect.x, rect.y, rect.w, rect.h)) nest.cells[c] = CELL.WATER;
      p.x = rect.x;
      p.y = rect.y;
      p.revealed = true;
      moved = true;
    }
  }
  if (!moved && k >= 0) water.splice(k, 1);
  nest.rev++;
  rebuild(s, d);
  removeDryWells(s, d);
}

/** Water Wells that touch no revealed water pocket any more: removed, placement food refunded 100 % (C117). */
function removeDryWells(s, d) {
  const nest = s.run.nest;
  const geo = ensureGeom(s, d);
  const def = CHAMBERS.water_well;
  let changed = false;
  for (let j = nest.chambers.length - 1; j >= 0; j--) {
    const ch = nest.chambers[j];
    if (!ch || ch.type !== 'water_well' || pocketsTouched(s, geo, ch).size) continue;
    let food = 0;
    let queued = false;
    for (let q = nest.queue.length - 1; q >= 0; q--) {
      const job = nest.queue[q];
      if (job.chamber !== ch.uid) continue;
      queued = true;
      food += num(job.paidFood);
      nest.queue.splice(q, 1);
    }
    if (!queued && def.place && def.place.food > 0) {
      food = def.place.food * def.placeGrowth ** ch.k * edictCostMult(s) * (ch.blueprint ? DIG.blueprintPlaceMult : 1);
    }
    if (food > 0) refund(s, d, { food }, 1);
    for (const c of G.rectCells(ch.x, ch.y, ch.w, ch.h)) if (nest.cells[c] === CELL.CHAMBER) nest.cells[c] = CELL.TUNNEL;
    nest.chambers.splice(j, 1);
    changed = true;
  }
  if (changed) {
    renumberK(s, 'water_well');
    nest.rev++;
    rebuild(s, d);
  }
}

/**
 * [q] Drain / relocate preview for the inspect panel and the relocate ghost (C117): ok, reason, dig work, cost and,
 * for a drain, whether a Water Well would be lost.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} k water pocket index (features.water)
 * @param {{ x: number, y: number }|null} [to] relocation spot (top-left), null = drain
 * @returns {{ ok: boolean, reason: string|null, work: number, cost: Object, wells: number, busy: boolean }}
 */
export function pocketAction(s, d, k, to = null) {
  const P = planPocket(s, d, k, to);
  const water = s.run.nest.features.water || [];
  const p = isInt(k) ? water[k] : null;
  let wells = 0;
  if (p) {
    const geo = G.getGeom(s, d);
    for (const ch of s.run.nest.chambers) if (ch.type === 'water_well' && pocketsTouched(s, geo, ch).has(k)) wells++;
  }
  return { ok: !P.reason, reason: P.reason, work: num(P.work), cost: P.cost ? { ...P.cost } : {}, wells,
    busy: !!p && pocketBusy(s, p) };
}

/**
 * [q] Index of the revealed water pocket covering cell i (features.water), or −1.
 * @param {import('../core/types.js').State} s
 * @param {number} i
 * @returns {number}
 */
export function pocketAt(s, i) {
  if (!isCell(i)) return -1;
  const x = i % COLS;
  const y = Math.floor(i / COLS);
  const water = s.run.nest.features.water || [];
  for (let k = 0; k < water.length; k++) {
    const p = water[k];
    if (p && p.revealed && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return k;
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------------------------
// Cultivated roots (C118, research `root_cultivation`)
// ------------------------------------------------------------------------------------------------------------------

/** A root cannot grow into cell c: chamber footprint, stone, water or an open shaft cell. */
function rootBlocked(s, geo, c) {
  const code = s.run.nest.cells[c];
  return code === CELL.STONE || code === CELL.WATER || geo.chamberAt[c] >= 0 || !!geo._shaft[c];
}

/**
 * [q] Cultivated-root cap this run: ROOT_CULT.cap + 1 per moundPer Mound levels (at most +moundMax).
 * @param {import('../core/types.js').State} s
 * @returns {number}
 */
export function rootCap(s) {
  const mound = num(s.run.surface && s.run.surface.mound);
  return ROOT_CULT.cap + Math.min(ROOT_CULT.moundMax, Math.floor(mound / ROOT_CULT.moundPer));
}

/** Cultivated roots grown this run. */
function ownRoots(s) {
  return (s.run.nest.features.roots || []).filter((r) => r && r.own).length;
}

/**
 * [q] Cost of the next cultivated root: ROOT_CULT.cost × growth^n (n = cultivated roots this run).
 * @param {import('../core/types.js').State} s
 * @returns {import('../core/types.js').Cost}
 */
export function rootCost(s) {
  const m = ROOT_CULT.growth ** ownRoots(s);
  const cost = {};
  for (const r of Object.keys(ROOT_CULT.cost)) cost[r] = ROOT_CULT.cost[r] * m;
  return cost;
}

/** growRoot plan: research, cap, a free column (no root, no shaft), the top cell free; depth = rows it can grow. */
function planRoot(s, d, col) {
  if (!G.hasResearch(s, ROOT_CULT.research)) return { reason: 'locked' };
  if (!isInt(col) || col < 0 || col >= COLS) return { reason: 'invalid' };
  if (ownRoots(s) >= rootCap(s)) return { reason: 'max' };
  if ((s.run.nest.features.roots || []).some((r) => r && r.col === col)) return { reason: 'invalid:root' };
  if (s.run.nest.shafts.some((x) => x && x.col === col)) return { reason: 'blocked:shaft' };
  const geo = G.getGeom(s, d);
  const y0 = ROOT_CULT.y0;
  if (rootBlocked(s, geo, G.idx(col, y0))) return { reason: 'blocked' };
  let y1 = y0;
  while (y1 + 1 <= ROOT_CULT.maxRow && !rootBlocked(s, geo, G.idx(col, y1 + 1))) y1++;
  const cost = rootCost(s);
  if (!canAfford(s, cost)) return { reason: 'cantAfford', cost, y0, y1 };
  return { reason: null, cost, y0, y1 };
}

/**
 * [q] Grow-root preview for the Build panel and the column ghost (C118).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} col
 * @returns {{ ok: boolean, reason: string|null, cost: Object, y0: number, y1: number }}
 */
export function rootPreview(s, d, col) {
  const P = planRoot(s, d, col);
  return { ok: !P.reason, reason: P.reason, cost: P.cost ? { ...P.cost } : rootCost(s), y0: num(P.y0), y1: num(P.y1) };
}

/** Grow cultivated roots by ROOT_CULT.rowsPerSec (real seconds); a root stops above a chamber, stone, water or shaft. */
function growRoots(s, d, step) {
  const roots = s.run.nest.features.roots || [];
  let geo = null;
  let changed = false;
  for (const r of roots) {
    if (!r || !r.own || !(num(r.to) > r.y1)) continue;
    r.prog = num(r.prog) + ROOT_CULT.rowsPerSec * step;
    while (r.prog >= 1 && r.y1 < r.to) {
      if (!geo) geo = ensureGeom(s, d);
      if (rootBlocked(s, geo, G.idx(r.col, r.y1 + 1))) { r.to = r.y1; break; }
      r.y1++;
      r.prog -= 1;
      changed = true;
    }
    if (r.y1 >= r.to) r.prog = 0;
  }
  if (changed) {
    s.run.nest.rev++;
    rebuild(s, d);
  }
}

/** Skip cells of the first job that are already open or no longer diggable. */
function skipDone(s, job) {
  while (job.cur < job.cells.length) {
    const c = job.cells[job.cur];
    if (isCell(c) && cellPending(s, job, c) && (isDrainCell(job, c) || G.isDiggable(s, c))) break;
    job.cur++;
    job.prog = 0;
  }
}

/**
 * Spend `work` on the queue (all work goes to the first job, DESIGN §7.2). firstOnly stops after the first job.
 * @returns {number} leftover work
 */
function digWork(s, d, work, env, firstOnly = false) {
  const nest = s.run.nest;
  let ctx = null;
  let w = work > 0 ? work : 0;
  const firstUid = nest.queue.length ? nest.queue[0].uid : 0;
  while (nest.queue.length) {
    const job = nest.queue[0];
    if (firstOnly && job.uid !== firstUid) break;
    skipDone(s, job);
    if (job.cur >= job.cells.length) {
      finishJob(s, d, job, env);
      ctx = null;
      if (firstOnly) break;
      continue;
    }
    if (!(w > 0)) break;
    if (!ctx) ctx = G.workCtx(s);
    const c = job.cells[job.cur];
    const ch = jobChamber(s, job);
    const need = Math.max(0, jobCellWork(s, ctx, job, ch, c) - num(job.prog));
    if (w >= need) {
      w -= need;
      job.cur++;
      job.prog = 0;
      completeCell(s, d, job, ch, c, env);
    } else {
      job.prog = num(job.prog) + w;
      w = 0;
    }
  }
  return w;
}

// ------------------------------------------------------------------------------------------------------------------
// derive / tick
// ------------------------------------------------------------------------------------------------------------------

/**
 * Nest derive (ARCHITECTURE §8.2): rebuild geometry caches when s.run.nest.rev changed; every tick recompute frost
 * exposure, frost-snap exposure, chamber eff and every d.nest.agg field, plus hints, queueInfo and digFace.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {void}
 */
export function derive(s, d) {
  const dn = ensureGeom(s, d);
  const chs = s.run.nest.chambers;
  const season = d.season || {};
  const frostRow = num(season.frostRow);
  const snapRow = num(season.snapRow);
  const sid = season.id || 'spring';
  const vent = G.hasResearch(s, 'ventilation_shafts') ? (G.fxNum('research', 'ventilation_shafts', 'chamber') || 1) : 1;
  const byUid = new Map();
  for (let j = 0; j < chs.length; j++) byUid.set(chs[j].uid, j);

  for (let j = 0; j < chs.length; j++) {
    const ch = chs[j];
    const info = dn.chambers[j];
    const def = CHAMBERS[ch.type];
    info.exposed = !!def && !def.frostImmune && G.exposedTo(ch, frostRow);
    info.snap = G.exposedTo(ch, snapRow);
    let eff = vent;
    if (info.exposed) eff *= CHAMBER_RULES.frostMult;
    if (info.layer === 'aquifer') eff *= CHAMBER_RULES.aquiferMult;
    eff *= effectMult(s, 'chamber', ch.uid) * effectMult(s, 'chamber_layer', info.layer);
    if (info.hygiene) eff *= CHAMBERS.midden.fx.hygiene;
    info.eff = Number.isFinite(eff) && eff > 0 ? eff : 0;
  }

  const partner = (j, type) => {
    for (const u of dn.chambers[j].adj) {
      const m = byUid.get(u);
      if (m !== undefined && chs[m].type === type && contributes(chs[m])) return true;
    }
    return false;
  };

  const royalFx = CHAMBERS.royal_chamber.fx;
  const agg = {
    housingBase: royalFx.housing,
    broodGroups: [],
    berthsBase: 0, repleteBerthsBase: 0,
    alateCells: 0,
    granaryCap: 0,
    clayFoodShare: 0,
    reachStorageShare: 0,
    nearestGranaryUid: 0,
    haulH: 0,
    libraryInsight: 0,
    middenL: 0,
    barracksL: 0, barracksNear: false,
    rootPenL: 0, rootPenCount: 0,
    gardenL: 0, gardenerSlots: 0, leafCap: 0, fungusCap: 0, fungusMod: 1,
    hibCap: 0, hibL: 0,
    chimneyL: 0, gateL: 0, deepVaultL: 0,
    royal: [],
    royalL: 0,
    nuptial: { active: false, level: 0, shaftOpen: false },
    wells: 0, chambersActive: 0,
    adjGranaryRepletion: false, adjNurseryRoyal: false,
  };

  // Original Royal Chamber (uid 1; first Royal Chamber as a fallback): base housing / storage / slots, haul node.
  let royalJ = byUid.has(1) && chs[byUid.get(1)].type === 'royal_chamber' ? byUid.get(1) : -1;
  if (royalJ < 0) royalJ = chs.findIndex((c) => c.type === 'royal_chamber');
  if (royalJ >= 0) {
    agg.royalL = chs[royalJ].level;
    agg.broodGroups.push({ kind: 'royal', uid: chs[royalJ].uid, cap: royalFx.slots, factor: 1, exposed: false, snap: false,
      inReach: !!dn.chambers[royalJ].inReach });
  } else {
    agg.broodGroups.push({ kind: 'royal', uid: 1, cap: royalFx.slots, factor: 1, exposed: false, snap: false, inReach: false });
  }
  const storage = royalFx.storage;
  let haulNum = 0;
  let haulDen = 0;
  if (royalJ >= 0 && dn.chambers[royalJ].minDist >= 0) {
    haulNum += storage * dn.chambers[royalJ].minDist;
    haulDen += storage;
  }

  const seedBank = G.hasAch(s, 'ach_seed_bank') ? CHAMBER_RULES.seedBankMult : 1;
  const ventOwned = G.hasResearch(s, 'ventilation_shafts');
  const nuptialShaftOpen = s.run.nest.shafts.some((x) => x && x.kind === 'nuptial' && x.open);
  agg.nuptial.shaftOpen = nuptialShaftOpen;
  let clayCap = 0;
  let reachCap = 0;
  let nearestEnt = -1;
  let fungusW = 0;
  let fungusSlots = 0;
  const hibGroups = [];

  for (let j = 0; j < chs.length; j++) {
    const ch = chs[j];
    const def = CHAMBERS[ch.type];
    if (!def || !contributes(ch)) continue;
    const info = dn.chambers[j];
    const L = ch.level;
    const eff = info.eff;
    const fx = def.fx;
    agg.chambersActive++;
    switch (ch.type) {
      case 'royal_chamber':
        agg.royal.push(L);
        break;
      case 'gallery':
        agg.housingBase += galleryHousing(fx, L) * (info.layer === 'loam' ? fx.loam : 1) * eff;
        break;
      case 'nursery': {
        const adjB = partner(j, 'royal_chamber') ? fx.royalAdj : 0;
        if (adjB > 0) agg.adjNurseryRoyal = true;
        const factor = (1 + adjB + nurseryMicro(s, info.layer, sid)) * eff;
        agg.broodGroups.push({ kind: 'nursery', uid: ch.uid, cap: fx.slots * L, factor, exposed: info.exposed, snap: info.snap,
          inReach: info.inReach });
        break;
      }
      case 'granary': {
        const cap = fx.cap * fx.capGrowth ** (L - 1) * (fx.layer[info.layer] || 1) * eff * seedBank;
        agg.granaryCap += cap;
        if (info.layer === 'clay' && !ventOwned) clayCap += cap;
        if (info.inReach) reachCap += cap;
        if (info.minEntPath >= 0 && (nearestEnt < 0 || info.minEntPath < nearestEnt)) {
          nearestEnt = info.minEntPath;
          agg.nearestGranaryUid = ch.uid;
        }
        if (info.minDist >= 0) { haulNum += cap * info.minDist; haulDen += cap; }
        if (partner(j, 'repletion_hall')) agg.adjGranaryRepletion = true;
        break;
      }
      case 'scent_library': {
        const deep = G.layerIndex(info.layer) >= G.layerIndex(def.deepFrom) ? fx.deep : 1;
        const adjM = partner(j, 'royal_chamber') ? fx.royalAdj : 1;
        agg.libraryInsight += fx.insight * L * deep * adjM * eff;
        break;
      }
      case 'midden':
        agg.middenL += L * eff;
        break;
      case 'barracks':
        agg.barracksL += L * eff;
        agg.berthsBase += fx.berths * L * eff;
        if (info.minEntPath >= 0 && info.minEntPath <= GEOM.barracksPath) agg.barracksNear = true;
        break;
      case 'root_aphid_pen':
        agg.rootPenL += L * eff;
        agg.rootPenCount++;
        break;
      case 'fungus_garden': {
        agg.gardenL += L;
        const slots = fx.gardeners * L;
        const mod = (info.layer === 'clay' ? fx.clay : 1) * (partner(j, 'water_well') ? fx.wellAdj : 1) * eff;
        fungusW += slots * mod;
        fungusSlots += slots;
        break;
      }
      case 'repletion_hall':
        agg.repleteBerthsBase += fx.berths * L * eff;
        break;
      case 'hibernaculum': {
        const cap = fx.shelter * L * eff;
        agg.hibCap += cap;
        agg.hibL += L;
        hibGroups.push({ kind: 'hib', uid: ch.uid, cap, factor: 1, exposed: false, snap: false, inReach: info.inReach });
        break;
      }
      case 'thermal_chimney':
        agg.chimneyL += L * eff;
        break;
      case 'gate':
        agg.gateL += L * eff;
        break;
      case 'water_well':
        agg.wells += info.layer === 'aquifer' ? def.aquiferCount : 1;
        break;
      case 'nuptial_chamber': {
        agg.nuptial.level = L;
        if (nuptialShaftOpen) {
          agg.nuptial.active = true;
          const max = G.traitLevel(s, 'royal_court') > 0 ? fx.cellsMaxCourt : fx.cellsMax;
          agg.alateCells = Math.min(max, fx.cellsBase + fx.cellsPer * (L - 1));
        }
        break;
      }
      case 'deep_vault':
        agg.deepVaultL += L * eff;
        break;
      default:
        break;
    }
  }
  for (const g of hibGroups) agg.broodGroups.push(g);
  const totalStore = storage + agg.granaryCap;
  agg.clayFoodShare = totalStore > 0 ? clayCap / totalStore : 0;
  agg.reachStorageShare = totalStore > 0 ? reachCap / totalStore : 0;
  agg.haulH = haulDen > 0 ? haulNum / haulDen / GEOM.haulDiv : 0;
  const gfx = CHAMBERS.fungus_garden.fx;
  agg.gardenerSlots = gfx.gardeners * agg.gardenL;
  agg.leafCap = gfx.leafCap * agg.gardenL;
  agg.fungusCap = gfx.fungusCap * agg.gardenL;
  agg.fungusMod = fungusSlots > 0 ? fungusW / fungusSlots : 1;

  dn.agg = agg;
  dn.hints = computeHints(s, dn);
  fillQueueInfo(s, d);
}

/**
 * Nest tick (ARCHITECTURE §8.2): backfill timers, dig work = d.stats.digW × env.eff × env.econDt spent on the queue
 * (leftover → maint), water-pocket reveal, geometry refresh, queueInfo and digFace. O(cells dug) per call.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const nest = s.run.nest;
  const geo = ensureGeom(s, d);
  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
  if (nest.backfill.length && step > 0) {
    const keep = [];
    for (const b of nest.backfill) {
      if (!b || !isCell(b.i)) continue;
      b.t = num(b.t) - step;
      if (b.t > 0) { keep.push(b); continue; }
      if (nest.cells[b.i] === CELL.TUNNEL && geo.chamberAt[b.i] < 0) nest.cells[b.i] = CELL.SOIL;
      nest.rev++;
    }
    nest.backfill = keep;
  }
  const econDt = env && Number.isFinite(env.econDt) ? env.econDt : step;
  const eff = env && Number.isFinite(env.eff) ? env.eff : 1;
  const W = Math.max(0, num(d.stats && d.stats.digW)) * Math.max(0, eff) * Math.max(0, econDt);
  const left = digWork(s, d, W, env, false);
  if (left > 0) nest.maint = Math.min(CLAMP_MAX, num(nest.maint) + left);
  if (step > 0) growRoots(s, d, step);
  const g2 = ensureGeom(s, d);
  revealWater(s, g2);
  if (step > 0) bpTick(s, d, env);
  fillQueueInfo(s, d);
}

// ------------------------------------------------------------------------------------------------------------------
// Placement planning
// ------------------------------------------------------------------------------------------------------------------

/** Reason a footprint cell is unusable, or null (relIdx = index of the chamber being relocated / grown). */
function cellBlock(s, geo, c, relIdx) {
  const cells = s.run.nest.cells;
  if (relIdx >= 0 && geo.chamberAt[c] === relIdx) return null;
  const code = cells[c];
  if (code === CELL.WATER) return 'blocked:water';
  if (geo.chamberAt[c] >= 0) return 'blocked:chamber';
  // C125: only a shaft's top SHAFT_KEEP_ROWS rows block a footprint; a chamber over deeper shaft cells lets it pass.
  if (geo._shaft[c] && c < G.SHAFT_KEEP_ROWS * COLS) return 'blocked:shaft';
  if (geo._backfill[c]) return 'blocked:backfill';
  if (code === CELL.STONE && !G.hasResearch(s, 'acid_excavation')) return 'blocked:stone';
  if (geo._queued[c]) return 'blocked:queued';
  if (code === CELL.SOIL || code === CELL.STONE) {
    if (s.run.hardship === 'shallow_soil' && Math.floor(c / COLS) > DIG.shallowSoilRow) return 'hardship';
    if (!G.isDiggable(s, c)) return 'blocked:layer';
  }
  return null;
}

/** Water pocket indices touched (4-adjacent) by a rectangle; only revealed pockets. */
function pocketsTouched(s, geo, rect) {
  const out = new Set();
  const water = s.run.nest.features.water || [];
  for (const p of G.perimeter(rect)) {
    const k = geo._pocket[p];
    if (k >= 0 && water[k] && water[k].revealed && s.run.nest.cells[p] === CELL.WATER) out.add(k);
  }
  return out;
}

/** Special placement rule of a chamber type (DESIGN §7.6); nuptialShaft is planned separately. */
function ruleCheck(s, geo, def, rect, relUid) {
  switch (def.rule) {
    case 'touchRoot': {
      for (const c of G.rectCells(rect.x, rect.y, rect.w, rect.h)) if (geo._root[c]) return null;
      for (const p of G.perimeter(rect)) if (geo._root[p]) return null;
      return 'invalid:root';
    }
    case 'touchRow0':
      return rect.y === 0 ? null : 'invalid:row0';
    case 'shaftTop': {
      for (const p of G.perimeter(rect)) if (geo._shaft[p]) return null;
      return 'invalid:shaft';
    }
    case 'touchWater': {
      const mine = pocketsTouched(s, geo, rect);
      if (!mine.size) return 'invalid:water';
      for (const ch of s.run.nest.chambers) {
        if (ch.type !== 'water_well' || ch.uid === relUid) continue;
        for (const k of pocketsTouched(s, geo, ch)) mine.delete(k);
      }
      return mine.size ? null : 'invalid:water';
    }
    default:
      return null;
  }
}

/**
 * BFS order for the undug cells of a footprint / growth area: seeded from cells next to an open cell or a cell of
 * `extraOpen` (route cells), expanding inside the list (ARCHITECTURE §8.2: cells queued in BFS order).
 */
function orderCells(geo, list, extraOpen) {
  if (!list.length) return [];
  const inList = new Uint8Array(N);
  for (const c of list) inList[c] = 1;
  const extra = new Uint8Array(N);
  for (const c of extraOpen || []) if (isCell(c)) extra[c] = 1;
  const seen = new Uint8Array(N);
  const out = [];
  const q = [];
  for (const c of list) {
    for (const n of G.neighbors4(c)) {
      if ((geo.open[n] && !inList[n]) || extra[n]) { q.push(c); seen[c] = 1; break; }
    }
  }
  if (!q.length) { q.push(list[0]); seen[list[0]] = 1; }
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    out.push(c);
    for (const n of G.neighbors4(c)) {
      if (inList[n] && !seen[n]) { seen[n] = 1; q.push(n); }
    }
  }
  for (const c of list) if (!seen[c]) out.push(c);
  return out;
}

/** Validate a player-drawn route (contiguous, starts next to a reachable open cell, ends next to the footprint). */
function checkRoute(s, geo, route, rect) {
  if (!Array.isArray(route) || route.length === 0 || route.length > N) return 'invalid:route';
  const cells = s.run.nest.cells;
  for (let k = 0; k < route.length; k++) {
    const c = route[k];
    if (!isCell(c) || G.inRect(rect, c)) return 'invalid:route';
    if (k > 0 && !adj4(route[k - 1], c)) return 'invalid:route';
    if (geo.open[c]) continue;
    if (cells[c] !== CELL.SOIL || geo.chamberAt[c] >= 0 || geo._backfill[c] || !G.isDiggable(s, c)) return 'blocked:route';
  }
  const first = route[0];
  const reach = (c) => geo.open[c] && geo.entDist[c] >= 0 && !geo._backfill[c];
  if (!reach(first) && !G.neighbors4(first).some(reach)) return 'invalid:route';
  const last = route[route.length - 1];
  if (!G.neighbors4(last).some((n) => G.inRect(rect, n))) return 'invalid:route';
  return null;
}

/** Exit-shaft path of a Nuptial Chamber at column col (connector along the row above the chamber, then up). */
function shaftPath(s, geo, rect, col) {
  const r = rect.y - 1;
  if (r < 0) return null;
  const cells = s.run.nest.cells;
  const start = Math.max(rect.x, Math.min(rect.x + rect.w - 1, col));
  const path = [];
  const stepX = col > start ? 1 : col < start ? -1 : 0;
  for (let x = start; ; x += stepX) {
    path.push(G.idx(x, r));
    if (x === col || stepX === 0) break;
  }
  for (let y = r - 1; y >= 0; y--) path.push(G.idx(col, y));
  const top = G.idx(col, 0);
  if (cells[top] !== CELL.SOIL) return null;
  const dig = [];
  for (const c of path) {
    if (geo.open[c]) {
      if (geo._shaft[c] === 1 || geo._pass[c] === 1) return null; // never through the main shaft
      continue;
    }
    if (geo.chamberAt[c] >= 0 || geo._backfill[c] || geo._queued[c]) return null;
    if (!G.isDiggable(s, c)) return null;
    dig.push(c);
  }
  return dig;
}

/**
 * Plan a Nuptial Chamber's exit shaft (default column: nearest to the chamber at distance ≥ 3 from every shaft; C66:
 * the nearest one whose shaft, with the chamber, leaves the Royal Chamber room to reach the Flight level, when any
 * does). `guard` = royalGuard (or null).
 */
function planNuptialShaft(s, geo, rect, shaftCol, guard = null) {
  const cols = s.run.nest.shafts.map((x) => x.col);
  const okCol = (c) => isInt(c) && c >= 0 && c < COLS && cols.every((e) => Math.abs(e - c) >= GEOM.shaftGap);
  let cands;
  if (shaftCol !== null && shaftCol !== undefined) {
    if (!okCol(shaftCol)) return { reason: 'invalid:shaftCol' };
    cands = [shaftCol];
  } else {
    const center = rect.x + (rect.w - 1) / 2;
    const span = (c) => (c < rect.x ? rect.x - c : c > rect.x + rect.w - 1 ? c - (rect.x + rect.w - 1) : 0);
    cands = [];
    for (let c = 0; c < COLS; c++) if (okCol(c)) cands.push(c);
    cands.sort((a, b) => span(a) - span(b) || Math.abs(a - center) - Math.abs(b - center) || a - b);
  }
  let first = null;
  for (const c of cands) {
    const cells = shaftPath(s, geo, rect, c);
    if (!cells) continue;
    if (!guard || cands.length === 1 || !guard.blocks(rect, shaftCells(rect, c))) return { col: c, cells };
    if (!first) first = { col: c, cells };
  }
  return first || { reason: 'blocked:shaft' };
}

/**
 * The cells of a Nuptial exit shaft at column col that become permanent obstacles once it opens, for the Royal guard.
 * C125: only the shaft's top G.SHAFT_KEEP_ROWS rows (chambers may cover the rest; the shaft passes through them).
 */
function shaftCells(rect, col) {
  const out = [];
  for (let y = Math.min(rect.y - 1, G.SHAFT_KEEP_ROWS - 1); y >= 0; y--) out.push(G.idx(col, y));
  return out;
}

/**
 * Full placement plan used by validatePlacement, the handlers, blueprints and the advisor.
 * @returns {Object} { reason, rect, layer, direct, routeCells, footSoil, footOpen, shaft, cost, work, rel }
 */
function planPlacement(s, d, type, x, y, opts = {}) {
  const { route = null, relocateUid = 0, shaftCol = null, blueprint = false, ignoreQueue = false, ignoreCost = false,
    assumeConnected = false, seedCells = null } = opts;
  const P = { reason: null, rect: null, layer: null, direct: false, routeCells: null, footSoil: [], footOpen: [], shaft: null,
    cost: null, work: 0, rel: null };
  const def = CHAMBERS[type];
  if (!def) return fail(P, 'invalid');
  const geo = G.getGeom(s, d);
  let rel = null;
  if (relocateUid) {
    rel = findChamber(s, relocateUid);
    if (!rel) return fail(P, 'notFound');
    if (rel.ch.type !== type) return fail(P, 'invalid');
    P.rel = rel;
  }
  const dims = rel ? { w: rel.ch.w, h: rel.ch.h } : G.footprint(type, 1);
  const rect = { x, y, w: dims.w, h: dims.h };
  P.rect = rect;
  if (!isInt(x) || !isInt(y)) return fail(P, 'invalid');
  if (rel) {
    if (rel.ch.status !== 'active') return fail(P, 'busy');
    if (rel.ch.x === x && rel.ch.y === y) return fail(P, 'invalid');
  } else {
    if (def.unlock && !s.run.unlocked[def.unlock]) return fail(P, 'locked');
    if (countType(s, type) >= instLimit(s, d, type)) return fail(P, 'max');
  }
  if (x < 0 || y < 0 || x + rect.w > COLS || y + rect.h > ROWS) return fail(P, 'invalid:bounds');
  P.layer = G.rectLayer(rect);
  if (y < effRowMin(s, d, type) || y + rect.h - 1 > def.rowMax) return fail(P, 'invalid:row');
  if (s.run.hardship === 'shallow_soil' && y + rect.h - 1 > DIG.shallowSoilRow) return fail(P, 'hardship');
  const relIdx = rel ? rel.j : -1;
  const rc = G.rectCells(x, y, rect.w, rect.h);
  for (const c of rc) {
    const r = cellBlock(s, geo, c, relIdx);
    if (r) return fail(P, r);
  }
  const rr = ruleCheck(s, geo, def, rect, rel ? rel.ch.uid : 0);
  if (rr) return fail(P, rr);
  const cells = s.run.nest.cells;
  const soil = [];
  for (const c of rc) {
    if (G.isOpenCode(cells[c])) P.footOpen.push(c);
    else soil.push(c);
  }
  // Connectivity: an open reachable cell inside or 4-adjacent to the footprint, else a route.
  const reach = (c) => geo.open[c] && geo.entDist[c] >= 0 && !geo._backfill[c];
  let connected = !!assumeConnected;
  if (!connected) for (const c of rc) if (reach(c)) { connected = true; break; }
  if (!connected) for (const p of G.perimeter(rect)) if (reach(p)) { connected = true; break; }
  P.direct = connected;
  if (!connected) {
    if (route !== null && route !== undefined) {
      const why = checkRoute(s, geo, route, rect);
      if (why) return fail(P, why);
      P.routeCells = route.filter((c) => !geo.open[c]);
    } else {
      const r = G.routeTo(s, d, rc);
      if (!r) return fail(P, 'blocked:route');
      P.routeCells = r.cells;
    }
  }
  if (def.rule === 'nuptialShaft' && !rel && !s.run.nest.shafts.some((x2) => x2 && x2.kind === 'nuptial')) {
    const sh = planNuptialShaft(s, geo, rect, shaftCol, royalGuard(s, d, 0));
    if (sh.reason) return fail(P, sh.reason);
    P.shaft = sh;
  }
  P.footSoil = orderCells(geo, soil, P.routeCells || seedCells);
  // Work of the job(s).
  const ctx = G.workCtx(s);
  let work = 0;
  for (const c of P.routeCells || []) work += G.workAt(ctx, c, 'tunnel', blueprint);
  const relMult = rel ? DIG.relocateWorkFrac * (G.hasAch(s, 'ach_architect') ? DIG.architectMult : 1) : 1;
  for (const c of P.footSoil) work += G.workAt(ctx, c, rel ? 'relocate' : 'chamber', blueprint) * relMult;
  if (P.shaft) for (const c of P.shaft.cells) work += G.workAt(ctx, c, 'shaft');
  P.work = work;
  if (!ignoreQueue) {
    const need = 1 + (P.shaft ? 1 : 0);
    if (s.run.nest.queue.length + need > queueLimit(s)) return fail(P, 'queueFull');
  }
  if (rel) {
    P.cost = {};
  } else {
    let cost = placementCost(s, type);
    if (!cost) return fail(P, 'max');
    if (blueprint && cost.food !== undefined) cost = { ...cost, food: cost.food * DIG.blueprintPlaceMult };
    P.cost = cost;
    if (!ignoreCost && !canAfford(s, cost)) return fail(P, 'cantAfford');
  }
  return P;
}

/**
 * C125: before a footprint `rect` turns open shaft cells into chamber cells, remember on each such shaft how deep it
 * runs (sh.thru = its bottom row), so the geometry keeps tracing it through the chamber (_pass) and below it. When the
 * chamber goes (demolish, relocation, cancel), its cells become tunnel again and the plain shaft trace takes over.
 */
function markShaftPass(s, d, rect) {
  const geo = ensureGeom(s, d);
  for (const sh of s.run.nest.shafts) {
    if (!sh || !sh.open || !isInt(sh.col) || sh.col < rect.x || sh.col >= rect.x + rect.w) continue;
    let bottom = -1;
    let hit = false;
    for (let y = 0; y < ROWS; y++) {
      const c = G.idx(sh.col, y);
      if (!geo._shaft[c] && !geo._pass[c]) break;
      bottom = y;
      if (geo._shaft[c] && y >= rect.y && y < rect.y + rect.h) hit = true;
    }
    if (hit) sh.thru = Math.max(isInt(sh.thru) ? sh.thru : -1, bottom);
  }
}

/** Renumber instance indices k of a type by placement order (uid). */
function renumberK(s, type) {
  const list = s.run.nest.chambers.filter((c) => c.type === type).sort((a, b) => a.uid - b.uid);
  for (let k = 0; k < list.length; k++) list[k].k = k;
}

/** Execute a successful placement plan: pay, add the chamber and its job(s). Returns the chamber uid. */
function executePlacement(s, d, type, P, env, blueprint = false) {
  const nest = s.run.nest;
  if (P.cost && Object.keys(P.cost).length && !spend(s, P.cost)) return 0;
  const r = P.rect;
  const uid = nest.nextUid++;
  const ch = { uid, type, k: countType(s, type), x: r.x, y: r.y, w: r.w, h: r.h, level: 0, target: 1, status: 'digging',
    blueprint: !!blueprint, bornAt: s.run.time };
  markShaftPass(s, d, r);
  nest.chambers.push(ch);
  for (const c of P.footOpen) nest.cells[c] = CELL.CHAMBER;
  const job = { uid: nest.nextUid++, kind: 'chamber', chamber: uid, cells: [...(P.routeCells || []), ...P.footSoil], cur: 0, prog: 0,
    paidFood: P.cost && P.cost.food > 0 ? P.cost.food : 0, blueprint: !!blueprint };
  nest.queue.push(job);
  if (P.shaft) {
    nest.shafts.push({ kind: 'nuptial', col: P.shaft.col, open: false, ref: -1 });
    nest.queue.push({ uid: nest.nextUid++, kind: 'shaft', chamber: uid, cells: P.shaft.cells.slice(), cur: 0, prog: 0, paidFood: 0,
      blueprint: false });
  }
  nest.rev++;
  rebuild(s, d);
  if (!job.cells.length) {
    finishJob(s, d, job, env);
    rebuild(s, d);
  }
  return uid;
}

/** Execute a relocation plan (old cells → tunnel, chamber inactive until the new footprint is dug). */
function executeRelocation(s, d, P, env) {
  const nest = s.run.nest;
  const ch = P.rel.ch;
  const nr = P.rect;
  markShaftPass(s, d, nr);
  for (const c of G.rectCells(ch.x, ch.y, ch.w, ch.h)) {
    if (!G.inRect(nr, c) && nest.cells[c] === CELL.CHAMBER) nest.cells[c] = CELL.TUNNEL;
  }
  ch.x = nr.x;
  ch.y = nr.y;
  ch.status = 'relocating';
  for (const c of G.rectCells(nr.x, nr.y, nr.w, nr.h)) if (G.isOpenCode(nest.cells[c])) nest.cells[c] = CELL.CHAMBER;
  const job = { uid: nest.nextUid++, kind: 'relocate', chamber: ch.uid, cells: [...(P.routeCells || []), ...P.footSoil], cur: 0,
    prog: 0, paidFood: 0, blueprint: false };
  nest.queue.push(job);
  s.meta.counters.relocations++;
  s.run.stats.relocations++;
  nest.rev++;
  rebuild(s, d);
  if (!job.cells.length) {
    finishJob(s, d, job, env);
    rebuild(s, d);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Level-ups
// ------------------------------------------------------------------------------------------------------------------

/** Level-up cost (DESIGN §7.5): food f0 × g^L × 2^k, soil s0 × g^L × 2^k, extras × g^L; × chamberCost with edict_of_depth. */
function levelCost(s, ch) {
  const def = CHAMBERS[ch.type];
  if (!def) return null;
  const maxL = effMaxL(s, def);
  if (maxL > 0 && ch.level >= maxL) return null;
  const gL = def.g ** ch.level;
  const kk = CHAMBER_RULES.instanceLevelGrowth ** ch.k;
  const cost = {};
  if (def.f0 > 0) cost.food = def.f0 * gL * kk;
  if (def.s0 > 0) cost.soil = def.s0 * gL * kk;
  if (def.levelExtra) for (const r of Object.keys(def.levelExtra)) cost[r] = def.levelExtra[r] * gL;
  if (!Object.keys(cost).length) return null;
  const m = edictCostMult(s);
  if (m !== 1) for (const r of Object.keys(cost)) cost[r] *= m;
  return costOrNull(cost);
}

/** Growth rectangle for directions hd ('left'|'right'|null) and vd ('up'|'down'|null); validity and cells. */
function growthCheck(s, d, geo, ch, j, hd, vd, dw, dh) {
  const def = CHAMBERS[ch.type];
  const nr = { x: ch.x - (hd === 'left' ? dw : 0), y: ch.y - (vd === 'up' ? dh : 0), w: ch.w + dw, h: ch.h + dh };
  if (nr.x < 0 || nr.y < 0 || nr.x + nr.w > COLS || nr.y + nr.h > ROWS) return null;
  if (nr.y < effRowMin(s, d, ch.type) || nr.y + nr.h - 1 > def.rowMax) return null;
  if (s.run.hardship === 'shallow_soil' && nr.y + nr.h - 1 > DIG.shallowSoilRow) return null;
  const soil = [];
  const open = [];
  for (const c of G.rectCells(nr.x, nr.y, nr.w, nr.h)) {
    if (G.inRect(ch, c)) continue;
    if (cellBlock(s, geo, c, j)) return null;
    if (G.isOpenCode(s.run.nest.cells[c])) open.push(c);
    else soil.push(c);
  }
  return { rect: nr, soil, open };
}

/**
 * Level-up plan (DESIGN §7.4 enlarge with direction).
 * @returns {Object} { reason, cost, grows, rect, growSoil, growOpen, work, dirs, blocked, max, royalRoom }
 */
function planLevel(s, d, ch, dir, { ignoreQueue = false, ignoreCost = false } = {}) {
  const P = { reason: null, cost: null, grows: false, rect: null, growSoil: [], growOpen: [], work: 0,
    dirs: { left: false, right: false, up: false, down: false }, dirRects: { left: null, right: null, up: null, down: null },
    blocked: false, max: false, royalRoom: false };
  const def = CHAMBERS[ch.type];
  if (!def) return fail(P, 'invalid');
  const maxL = effMaxL(s, def);
  P.cost = levelCost(s, ch);
  P.max = (maxL > 0 && ch.level >= maxL) || !P.cost;
  P.grows = !!def.grows && ch.level >= 1 && ch.level < GEOM.footprintMaxL && !P.max;
  let choice = null;
  let dirReason = null;
  if (P.grows) {
    const geo = G.getGeom(s, d);
    const j = s.run.nest.chambers.indexOf(ch);
    const fp = G.footprint(ch.type, ch.level + 1);
    const dw = Math.max(0, fp.w - ch.w);
    const dh = Math.max(0, fp.h - ch.h);
    if (dw === 0 && dh === 0) {
      P.grows = false;
    } else {
      const hOpts = dw > 0 ? ['right', 'left'] : [null];
      const vOpts = dh > 0 ? ['down', 'up'] : [null];
      const memo = new Map();
      const combo = (hd, vd) => {
        const key = hd + '|' + vd;
        if (!memo.has(key)) memo.set(key, growthCheck(s, d, geo, ch, j, hd, vd, dw, dh));
        return memo.get(key);
      };
      // C66: no growth takes the Royal Chamber's last room to reach the Flight level. Another chamber may not grow
      // over every free Flight-level Royal footprint; the Royal Chamber itself may only grow inside one it can still
      // complete. Such directions are withheld (dirs false); asked for explicitly, or when they are the only valid
      // ones, the level-up is refused with 'blocked:royalRoom'. The guard is relUid 0 here: the growing chamber's
      // current cells stay an obstacle (its new rectangle contains them), and once the room is gone nothing is refused.
      const guard = royalGuard(s, d, 0);
      const safeOf = (c) => !!c && (!guard || (ch.uid === 1 ? guard.keeps(c.rect) : !guard.blocks(c.rect)));
      // C97: footprints grow one side per level, so exactly one of dw / dh is non-zero for a fresh chamber; dirRects
      // holds the rectangle each offered direction would grow to (the level-direction tool previews its new cells).
      if (dw > 0) {
        for (const hd of ['left', 'right']) {
          const c = vOpts.map((vd) => combo(hd, vd)).find(safeOf);
          P.dirs[hd] = !!c;
          P.dirRects[hd] = c ? { ...c.rect } : null;
        }
      }
      if (dh > 0) {
        for (const vd of ['up', 'down']) {
          const c = hOpts.map((hd) => combo(hd, vd)).find(safeOf);
          P.dirs[vd] = !!c;
          P.dirRects[vd] = c ? { ...c.rect } : null;
        }
      }
      let any = null;
      let safe = null;
      for (const hd of hOpts) {
        for (const vd of vOpts) {
          const c = combo(hd, vd);
          if (!c) continue;
          if (!any) any = c;
          if (!safe && safeOf(c)) safe = c;
        }
      }
      P.blocked = !safe;
      P.royalRoom = !!any && !!guard && hOpts.some((hd) => vOpts.some((vd) => combo(hd, vd) && !safeOf(combo(hd, vd))));
      if (dir === null || dir === undefined) {
        // Auto direction: the first valid one that leaves the Royal Chamber room to reach the Flight level.
        choice = safe;
        if (!choice && any) dirReason = 'blocked:royalRoom';
      } else if (dir === 'left' || dir === 'right') {
        if (dw === 0) dirReason = 'invalid:dir';
        else {
          for (const vd of vOpts) if (!choice && safeOf(combo(dir, vd))) choice = combo(dir, vd);
          if (!choice && vOpts.some((vd) => combo(dir, vd))) dirReason = 'blocked:royalRoom';
        }
      } else if (dir === 'up' || dir === 'down') {
        if (dh === 0) dirReason = 'invalid:dir';
        else {
          for (const hd of hOpts) if (!choice && safeOf(combo(hd, dir))) choice = combo(hd, dir);
          if (!choice && hOpts.some((hd) => combo(hd, dir))) dirReason = 'blocked:royalRoom';
        }
      } else {
        dirReason = 'invalid:dir';
      }
      if (choice) {
        P.rect = choice.rect;
        P.growOpen = choice.open;
        P.growSoil = orderCells(geo, choice.soil, null);
        const ctx = G.workCtx(s);
        for (const c of P.growSoil) P.work += G.workAt(ctx, c, 'grow');
      }
    }
  }
  if (ch.status !== 'active') return fail(P, 'busy');
  if (def.levelUnlock && !s.run.unlocked[def.levelUnlock]) return fail(P, 'locked');
  if (P.max) return fail(P, 'max');
  if (P.grows) {
    if (dirReason) return fail(P, dirReason);
    if (!choice) return fail(P, 'blocked');
    if (!ignoreQueue && s.run.nest.queue.length + 1 > queueLimit(s)) return fail(P, 'queueFull');
  }
  if (!ignoreCost && !canAfford(s, P.cost)) return fail(P, 'cantAfford');
  return P;
}

/** Execute a level-up plan: pay; growing types queue a 'grow' job, others level at once. */
function doLevel(s, d, ch, P, env) {
  const nest = s.run.nest;
  if (!spend(s, P.cost)) return false;
  if (P.grows && P.rect) {
    const from = { x: ch.x, y: ch.y, w: ch.w, h: ch.h };
    markShaftPass(s, d, P.rect);
    ch.x = P.rect.x;
    ch.y = P.rect.y;
    ch.w = P.rect.w;
    ch.h = P.rect.h;
    for (const c of P.growOpen) nest.cells[c] = CELL.CHAMBER;
    ch.status = 'growing';
    ch.target = ch.level + 1;
    const job = { uid: nest.nextUid++, kind: 'grow', chamber: ch.uid, cells: P.growSoil.slice(), cur: 0, prog: 0,
      paidFood: P.cost.food > 0 ? P.cost.food : 0, blueprint: false, from };
    nest.queue.push(job);
    nest.rev++;
    rebuild(s, d);
    if (!job.cells.length) {
      finishJob(s, d, job, env);
      rebuild(s, d);
    }
  } else {
    ch.level += 1;
    ch.target = ch.level;
    nest.rev++;
    rebuild(s, d);
    emit(env, 'chamberLeveled', { uid: ch.uid, level: ch.level });
  }
  return true;
}

// ------------------------------------------------------------------------------------------------------------------
// Placement modifiers (ghost tooltip) and queries
// ------------------------------------------------------------------------------------------------------------------

/** Estimated path cells from the footprint to the nearest seed of a distance array (dist / entDist), −1 unknown. */
function estPath(geo, distArr, P) {
  const r = P.rect;
  let best = -1;
  const take = (v) => { if (v >= 0 && (best < 0 || v < best)) best = v; };
  if (P.routeCells && P.routeCells.length) {
    const first = P.routeCells[0];
    let d0 = -1;
    for (const n of G.neighbors4(first)) if (geo.open[n] && distArr[n] >= 0 && (d0 < 0 || distArr[n] < d0)) d0 = distArr[n];
    if (d0 >= 0) take(d0 + P.routeCells.length + 1);
  } else {
    for (const c of G.rectCells(r.x, r.y, r.w, r.h)) if (geo.open[c]) take(distArr[c]);
    for (const p of G.perimeter(r)) if (geo.open[p] && distArr[p] >= 0) take(distArr[p] + 1);
  }
  return best;
}

/** True when rectangles a and b share a cell. */
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when rectangle `outer` contains rectangle `inner`. */
function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Every sum of a subset of `list` (non-negative integers), ascending. */
function subsetSums(list) {
  let set = new Set([0]);
  for (const v of list) {
    if (!(v > 0)) continue;
    const next = new Set(set);
    for (const a of set) next.add(a + v);
    set = next;
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Royal Chamber growth room (DESIGN §7.4 and §13.1: Royal L5 is a Flight requirement; ARCHITECTURE §18 C64, C66).
 * The Flight-level (FLIGHT.royalLevel) footprints the original Royal Chamber (uid 1) can still grow into from `rect`
 * (default: where it is now): each contains `rect`, is reachable by the remaining growth steps (its left / up offsets
 * are subset sums of the per-level width / height growth), meets the Royal row rule, the bounds and Shallow Soil, and
 * holds no permanent obstacle: another chamber (except `relUid`), water, an undiggable cell (stone without
 * acid_excavation, a locked layer), or a shaft cell (or queued shaft cell) in a shaft's top G.SHAFT_KEEP_ROWS rows (C125:
 * deeper shaft cells pass through chambers, so they are no obstacle). Transient blockers (queued dig cells,
 * pending backfill) do not count: they clear by themselves.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived|null} d
 * @param {{ relUid?: number, rect?: Object|null, level?: number }} [opts] rect / level: a hypothetical Royal Chamber
 *   (its own growth step, or a relocation preview with relUid 1)
 * @returns {null | { free: Array<{ x: number, y: number, w: number, h: number }> }} null = no guard (no original Royal
 *   Chamber below the Flight level, or nothing left to grow)
 */
function royalRoom(s, d, { relUid = 0, rect = null, level = 0 } = {}) {
  const chs = s.run.nest.chambers;
  const royal = chs.find((c) => c && c.uid === 1 && c.type === 'royal_chamber');
  const target = num(FLIGHT.royalLevel) || 5;
  if (!royal || num(royal.level) >= target) return null;
  if (relUid === 1 && !rect) return null;
  const R0 = rect || royal;
  // A growing Royal Chamber already has its next footprint: count the steps from that level.
  const Lc = Math.max(1, Math.floor(level || Math.max(num(royal.level), num(royal.target))));
  const dws = [];
  const dhs = [];
  let W = R0.w;
  let H = R0.h;
  for (let L = Lc + 1; L <= target; L++) {
    const fp = G.footprint('royal_chamber', L);
    const dw = Math.max(0, fp.w - W);
    const dh = Math.max(0, fp.h - H);
    dws.push(dw);
    dhs.push(dh);
    W += dw;
    H += dh;
  }
  if (W === R0.w && H === R0.h) return null;
  const def = CHAMBERS.royal_chamber;
  const rowMin = effRowMin(s, d, 'royal_chamber');
  const geo = G.getGeom(s, d);
  const cells = s.run.nest.cells;
  // Queued shafts: their column becomes shaft once open (a connector or connecting route stays plain tunnel).
  const shaftJob = new Uint8Array(N);
  for (const job of s.run.nest.queue) {
    if (!job || job.kind !== 'shaft' || !Array.isArray(job.cells)) continue;
    const top = job.cells.find((c) => isCell(c) && c < COLS);
    if (top === undefined) continue;
    for (const c of job.cells) if (isCell(c) && c % COLS === top) shaftJob[c] = 1;
  }
  const permanent = (c) => {
    const j = geo.chamberAt[c];
    if (j >= 0) {
      const o = chs[j];
      if (o && o.uid !== 1 && o.uid !== relUid) return true;
    }
    // C125: shafts pass through chambers, so only their top rows (which the Royal row rule never reaches) are permanent.
    if ((geo._shaft[c] || shaftJob[c]) && c < G.SHAFT_KEEP_ROWS * COLS) return true;
    const code = cells[c];
    if (code === CELL.WATER) return true;
    return (code === CELL.SOIL || code === CELL.STONE) && !G.isDiggable(s, c);
  };
  const free = [];
  for (const oy of subsetSums(dhs)) {
    for (const ox of subsetSums(dws)) {
      const R = { x: R0.x - ox, y: R0.y - oy, w: W, h: H };
      if (R.x < 0 || R.y < 0 || R.x + W > COLS || R.y + H > ROWS) continue;
      if (R.y < rowMin || R.y + H - 1 > def.rowMax) continue;
      if (s.run.hardship === 'shallow_soil' && R.y + H - 1 > DIG.shallowSoilRow) continue;
      let ok = true;
      for (const c of G.rectCells(R.x, R.y, W, H)) {
        if (G.inRect(R0, c)) continue;
        if (permanent(c)) { ok = false; break; }
      }
      if (ok) free.push(R);
    }
  }
  return { free };
}

/**
 * Guard built on royalRoom (null when it does not apply or the room is already gone, so a box-in that already
 * happened never blocks anything else).
 *   blocks(rect, cells?) — a footprint `rect` (and permanent extra cells such as a new shaft) takes the last room;
 *   keeps(rect)          — the Royal Chamber's own growth to `rect` still leaves it a way to the Flight level.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived|null} d
 * @param {number} [relUid=0] chamber being relocated (its current cells are not an obstacle)
 * @returns {null | { blocks: Function, keeps: Function }}
 */
function royalGuard(s, d, relUid = 0) {
  const room = royalRoom(s, d, { relUid });
  if (!room || !room.free.length) return null;
  const free = room.free;
  const royal = s.run.nest.chambers.find((c) => c && c.uid === 1);
  const Lc = Math.max(num(royal.level), num(royal.target));
  return {
    blocks(rect, cells = null) {
      return free.every((R) => (!!rect && rectsOverlap(R, rect)) || (!!cells && cells.some((c) => isCell(c) && G.inRect(R, c))));
    },
    keeps(rect) {
      if (!free.some((R) => rectContains(R, rect))) return false;
      const next = royalRoom(s, d, { rect, level: Lc + 1 });
      return !next || next.free.length > 0;
    },
  };
}

/**
 * [q] True when a footprint at `rect` (plus permanent extra `cells`, e.g. a Nuptial exit shaft) would take away the
 * original Royal Chamber's last room to reach the Flight level (FLIGHT.royalLevel; see royalRoom). Placement and
 * relocation only warn (ghost modifier royalRoom, DESIGN §7.4); growth and new shafts are refused (C66).
 * @param {import('../core/types.js').State} s
 * @param {{ x: number, y: number, w: number, h: number }|null} rect
 * @param {number} [relUid=0] chamber being relocated (0 = none)
 * @param {{ d?: Object|null, cells?: number[]|null }} [opts]
 * @returns {boolean}
 */
export function blocksRoyalGrowth(s, rect, relUid = 0, { d = null, cells = null } = {}) {
  const g = royalGuard(s, d, relUid);
  return !!g && g.blocks(rect, cells);
}

/** Ghost modifiers (DESIGN §7.4 tooltip): layer, adjacency, hygiene, frostExposed, floodZone, raidReach, haul, royalRoom. */
function placementMods(s, d, type, P, relUid) {
  const mods = [];
  const def = CHAMBERS[type];
  const r = P.rect;
  if (!def || !r || !isInt(r.x) || !isInt(r.y) || r.x < 0 || r.y < 0 || r.x + r.w > COLS || r.y + r.h > ROWS) return mods;
  const geo = G.getGeom(s, d);
  const layer = P.layer || G.rectLayer(r);
  const fx = def.fx;
  const sid = (d && d.season && d.season.id) || 'spring';
  let lm = layer === 'aquifer' ? CHAMBER_RULES.aquiferMult : 1;
  if (type === 'gallery' && layer === 'loam') lm *= fx.loam;
  else if (type === 'granary') lm *= fx.layer[layer] || 1;
  else if (type === 'scent_library' && G.layerIndex(layer) >= G.layerIndex(def.deepFrom)) lm *= fx.deep;
  else if (type === 'fungus_garden' && layer === 'clay') lm *= fx.clay;
  else if (type === 'nursery') lm *= 1 + nurseryMicro(s, layer, sid);
  if (Math.abs(lm - 1) > 1e-12) mods.push({ key: 'layer', value: lm });

  const ghost = G.rectCells(r.x, r.y, r.w, r.h);
  const chs = s.run.nest.chambers;
  const f4 = G.gapField(geo, ghost, GEOM.adjPathMax);
  const nearType = (types, field, needActive = true) => chs.some((ch) => ch.uid !== relUid && types.includes(ch.type)
    && (!needActive || contributes(ch)) && G.rectNear(field, ch));
  if (type === 'nursery' && nearType(['royal_chamber'], f4)) mods.push({ key: 'adjacency', value: 1 + fx.royalAdj });
  if (type === 'scent_library' && nearType(['royal_chamber'], f4)) mods.push({ key: 'adjacency', value: fx.royalAdj });
  if (type === 'granary' && nearType(['repletion_hall'], f4)) mods.push({ key: 'adjacency', value: num(CAPS.repleteAdj) || 1 });
  if (type === 'repletion_hall' && nearType(['granary'], f4)) mods.push({ key: 'adjacency', value: num(CAPS.repleteAdj) || 1 });
  if (type === 'fungus_garden' && nearType(['water_well'], f4)) mods.push({ key: 'adjacency', value: fx.wellAdj });
  if (type === 'water_well' && nearType(['fungus_garden'], f4)) mods.push({ key: 'adjacency', value: fx.gardenAdj });
  if (type === 'barracks') {
    const e = estPath(geo, geo.entDist, P);
    if (e >= 0 && e <= GEOM.barracksPath) mods.push({ key: 'adjacency', value: fx.homeAP });
  }
  if (type === 'nursery' || type === 'fungus_garden' || type === 'midden') {
    const f6 = G.gapField(geo, ghost, GEOM.hygienePath);
    const hit = type === 'midden' ? nearType(['nursery', 'fungus_garden'], f6, false) : nearType(['midden'], f6);
    if (hit) mods.push({ key: 'hygiene', value: CHAMBERS.midden.fx.hygiene });
  }
  if (relUid === 1) {
    // Relocating the Royal Chamber itself: warn when the new spot has no way to the Flight level but the old one had.
    const now = royalRoom(s, d);
    const there = royalRoom(s, d, { relUid: 1, rect: r });
    if (now && now.free.length && there && !there.free.length) mods.push({ key: 'royalRoom', value: true });
  } else if (blocksRoyalGrowth(s, r, relUid, { d, cells: P.shaft ? shaftCells(r, P.shaft.col) : null })) {
    mods.push({ key: 'royalRoom', value: true });
  }
  if (!def.frostImmune && G.exposedTo(r, hardFrostRow(s, d))) mods.push({ key: 'frostExposed', value: CHAMBER_RULES.frostMult });
  if (r.y <= DIG.floodRows[1] && r.y + r.h - 1 >= DIG.floodRows[0]) mods.push({ key: 'floodZone', value: true });
  if (type === 'granary' || type === 'nursery') {
    const e = estPath(geo, geo.entDist, P);
    if (e >= 0 && e <= GEOM.raidReach) mods.push({ key: 'raidReach', value: e });
  }
  if (type === 'granary') {
    const dist = estPath(geo, geo.dist, P);
    if (dist >= 0) {
      const t = haulTerms(s, d, geo);
      const vent = G.hasResearch(s, 'ventilation_shafts') ? (G.fxNum('research', 'ventilation_shafts', 'chamber') || 1) : 1;
      const cap = fx.cap * (fx.layer[layer] || 1) * vent * (layer === 'aquifer' ? CHAMBER_RULES.aquiferMult : 1)
        * (G.hasAch(s, 'ach_seed_bank') ? CHAMBER_RULES.seedBankMult : 1);
      mods.push({ key: 'haul', value: (t.num + cap * dist) / (t.den + cap) / GEOM.haulDiv });
    }
  }
  return mods;
}

/** Current haul numerator / denominator (Royal storage + contributing granaries with a known path). */
function haulTerms(s, d, geo) {
  const chs = s.run.nest.chambers;
  const fresh = d && d.nest === geo && Array.isArray(geo.chambers) && geo.chambers.length === chs.length;
  let n = 0;
  let den = 0;
  const royalFx = CHAMBERS.royal_chamber.fx;
  let royalDone = false;
  for (let j = 0; j < chs.length; j++) {
    const ch = chs[j];
    const minDist = fresh ? geo.chambers[j].minDist : minOver(geo.dist, ch);
    if (minDist < 0) continue;
    if (ch.type === 'royal_chamber' && !royalDone && (ch.uid === 1 || !chs.some((c) => c.uid === 1))) {
      n += royalFx.storage * minDist;
      den += royalFx.storage;
      royalDone = true;
    } else if (ch.type === 'granary' && contributes(ch)) {
      const fx = CHAMBERS.granary.fx;
      const layer = fresh ? geo.chambers[j].layer : G.rectLayer(ch);
      const eff = fresh ? geo.chambers[j].eff : 1;
      const cap = fx.cap * fx.capGrowth ** (ch.level - 1) * (fx.layer[layer] || 1) * eff
        * (G.hasAch(s, 'ach_seed_bank') ? CHAMBER_RULES.seedBankMult : 1);
      n += cap * minDist;
      den += cap;
    }
  }
  return { num: n, den };
}

function minOver(arr, r) {
  let m = -1;
  for (const c of G.rectCells(r.x, r.y, r.w, r.h)) if (arr[c] >= 0 && (m < 0 || arr[c] < m)) m = arr[c];
  return m;
}

/**
 * [q] Placement check for the Build ghost and the placeChamber / relocateChamber handlers (DESIGN §7.4).
 * PlacementResult = { ok, tint: 'green'|'amber'|'red', reason, route, work, eta, cost, mods: [{ key, value }] }.
 * route = the tunnel cells that will be dug to connect the footprint (auto-route or the given route), null if direct.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} type chamber id
 * @param {number} x footprint left column
 * @param {number} y footprint top row
 * @param {{ route?: number[]|null, relocateUid?: number, shaftCol?: number|null }} [opts]
 * @returns {Object} PlacementResult
 */
export function validatePlacement(s, d, type, x, y, { route = null, relocateUid = 0, shaftCol = null } = {}) {
  const P = planPlacement(s, d, type, x, y, { route, relocateUid, shaftCol });
  const mods = P.rect ? placementMods(s, d, type, P, relocateUid || 0) : [];
  // C109: which chambers the ghost would link to (and, when relocating, the links it would lose).
  const r = P.rect;
  const inBounds = !!r && isInt(r.x) && isInt(r.y) && r.x >= 0 && r.y >= 0 && r.x + r.w <= COLS && r.y + r.h <= ROWS;
  const links = inBounds && CHAMBERS[type] ? ghostLinks(s, d, type, P, relocateUid || 0) : [];
  const lost = relocateUid && inBounds ? chamberLinks(s, d, relocateUid).filter((c) => !links.some((l) => l.rule === c.rule && l.uid === c.uid)) : [];
  const penalty = mods.some((m) => m.key === 'hygiene' || m.key === 'frostExposed' || m.key === 'floodZone' || m.key === 'raidReach'
    || m.key === 'royalRoom');
  const W = Math.max(0, num(d && d.stats && d.stats.digW));
  const ahead = totalQueueWork(s);
  return {
    ok: !P.reason,
    tint: P.reason ? 'red' : penalty ? 'amber' : 'green',
    reason: P.reason,
    route: P.routeCells && P.routeCells.length ? P.routeCells.slice() : null,
    work: P.work,
    eta: W > 0 ? (ahead + P.work) / W : -1,
    cost: P.cost,
    mods,
    // C99: the row rule and the footprint, so a refusal can say "Must be at depth 24 or deeper (you are at 17)".
    rows: placementRows(s, d, type),
    rect: P.rect ? { ...P.rect } : null,
    links,
    lost,
  };
}

/**
 * [q] Row range a chamber type's footprint must stay inside (C99; DESIGN §7.4 step 2 row rule): min = the effective
 * top row (species / Shallow Soil adjustments included), max = the data rowMax. Unknown type → { min: 0, max: ROWS − 1 }.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} type
 * @returns {{ min: number, max: number }}
 */
export function placementRows(s, d, type) {
  const def = CHAMBERS[type];
  if (!def) return { min: 0, max: ROWS - 1 };
  return { min: effRowMin(s, d, type), max: def.rowMax };
}

/**
 * [q] Food (+ extras) to place the next instance of a chamber type: place.food × placeGrowth^k (listed extras flat),
 * × chamberCost with edict_of_depth (DESIGN §7.5). null = MAX (or unknown type).
 * ARCH-R: DESIGN writes "F_place × 2.5^k (+ listed extras)", read as extras not scaling with k.
 * @param {import('../core/types.js').State} s
 * @param {string} type
 * @returns {import('../core/types.js').Cost|null}
 */
export function placementCost(s, type) {
  const def = CHAMBERS[type];
  if (!def) return null;
  const k = countType(s, type);
  const cost = {};
  for (const r of Object.keys(def.place)) cost[r] = def.place[r] * (r === 'food' ? def.placeGrowth ** k : 1);
  const m = edictCostMult(s);
  if (m !== 1) for (const r of Object.keys(cost)) cost[r] *= m;
  return costOrNull(cost);
}

/**
 * [q] Level-up info for the inspect panel: next-level cost (null = MAX), whether it grows the footprint, valid growth
 * directions, growth-cell work (auto direction), blocked (grows but every direction blocked), max, and royalRoom
 * (extra, C66): some otherwise valid direction is withheld because it would take the Royal Chamber's last room to
 * reach the Flight level (with blocked, that is the only reason left: level the Royal Chamber to L5 first, or relocate).
 * Extras (C97): dirRects = the rectangle each offered direction grows to (null when not offered), rect = the auto choice.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} uid
 * @returns {{ cost: Object|null, grows: boolean, dirs: { left: boolean, right: boolean, up: boolean, down: boolean },
 *   dirRects: Object, rect: Object|null, work: number, blocked: boolean, max: boolean, royalRoom: boolean }}
 */
export function levelInfo(s, d, uid) {
  const f = findChamber(s, uid);
  if (!f) {
    return { cost: null, grows: false, dirs: { left: false, right: false, up: false, down: false },
      dirRects: { left: null, right: null, up: null, down: null }, rect: null, work: 0, blocked: true, max: true, royalRoom: false };
  }
  const P = planLevel(s, d, f.ch, null, { ignoreQueue: true, ignoreCost: true });
  const dirRects = {};
  for (const k of Object.keys(P.dirRects)) dirRects[k] = P.dirRects[k] ? { ...P.dirRects[k] } : null;
  return { cost: P.cost, grows: P.grows, dirs: { ...P.dirs }, dirRects, rect: P.rect ? { ...P.rect } : null, work: P.work,
    blocked: P.grows && P.blocked, max: P.max, royalRoom: P.grows && !P.max && P.royalRoom };
}

/** Contributing chamber of a type among the adjacency partners (≤ adjPathMax path cells) of chamber index j, or null. */
function partnerOf(s, dn, j, type) {
  const chs = s.run.nest.chambers;
  for (const u of dn.chambers[j].adj || []) {
    const p = chs.find((c) => c.uid === u);
    if (p && p.type === type && contributes(p)) return p;
  }
  return null;
}

/** Implied multiplier of a derived stat over its nest base (colony scale, research), else the colony scale. */
function impliedMult(d, stat, base) {
  const st = (d && d.stats) || {};
  const v = num(st[stat]);
  if (v > 0 && base > 0) return v / base;
  const cs = num(d && d.meta && d.meta.colonyScale) || num(st.colonyScale);
  return cs > 0 ? cs : 1;
}

/**
 * [q] What the next level of a chamber gives (C107; DESIGN §7.6 "Effect per level"): one line per stat with the
 * chamber's own value at its level L and at L + 1, with its layer modifier, adjacency, current effect multiplier
 * (frost, ventilation, hygiene, aquifer, events) and, for housing / slots / berths / gardener slots, the colony
 * multiplier the stats pass applies, so the numbers match what the colony gains.
 * Line: { stat, from, to, kind: 'count'|'num'|'rate'|'pct'|'mult'|'time'|'flag', sign?: −1 (a reduction), cap?: combined cap }.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} uid
 * @returns {null | { type: string, from: number, to: number, max: boolean, eff: number, layer: string, layerMult: number,
 *   lines: Array<Object> }}
 */
export function levelGain(s, d, uid) {
  const f = findChamber(s, uid);
  if (!f) return null;
  const ch = f.ch;
  const def = CHAMBERS[ch.type];
  if (!def) return null;
  const dn = ensureGeom(s, d);
  const info = dn.chambers[f.j] || {};
  const L0 = Math.max(0, Math.floor(num(ch.level)));
  const L1 = L0 + 1;
  const maxL = effMaxL(s, def);
  const out = { type: ch.type, from: L0, to: L1, max: (maxL > 0 && L0 >= maxL) || !levelCost(s, ch), eff: 1, layer: '', layerMult: 1, lines: [] };
  if (out.max) return out;
  const fx = def.fx;
  const eff = Number.isFinite(info.eff) ? info.eff : 1;
  const layer = info.layer || G.rectLayer(ch);
  out.eff = eff;
  out.layer = layer;
  const agg = (dn.agg) || {};
  const line = (stat, fn, kind, extra = {}) => out.lines.push({ stat, from: fn(L0), to: fn(L1), kind, ...extra });
  const pos = (L) => Math.max(0, L);
  switch (ch.type) {
    case 'royal_chamber':
      line('lay', (L) => fx.lay ** Math.max(0, L - 1), 'mult');
      if (L1 === (num(FLIGHT.royalLevel) || fx.flightLevel)) out.lines.push({ stat: 'flight', from: 0, to: 1, kind: 'flag' });
      break;
    case 'gallery': {
      const lm = layer === 'loam' ? fx.loam : 1;
      out.layerMult = lm;
      const m = impliedMult(d, 'housing', num(agg.housingBase));
      line('housing', (L) => galleryHousing(fx, pos(L)) * lm * eff * m, 'count');
      break;
    }
    case 'nursery': {
      let cap = 0;
      for (const g of agg.broodGroups || []) if (g) cap += Math.max(0, num(g.cap));
      const m = impliedMult(d, 'broodSlots', cap);
      line('broodSlots', (L) => fx.slots * pos(L) * m, 'count');
      break;
    }
    case 'granary': {
      const lm = fx.layer[layer] || 1;
      out.layerMult = lm;
      const seed = G.hasAch(s, 'ach_seed_bank') ? CHAMBER_RULES.seedBankMult : 1;
      line('granaryCap', (L) => (L >= 1 ? fx.cap * fx.capGrowth ** (L - 1) * lm * eff * seed : 0), 'num');
      break;
    }
    case 'scent_library': {
      const deep = G.layerIndex(layer) >= G.layerIndex(def.deepFrom) ? fx.deep : 1;
      const adjM = partnerOf(s, dn, f.j, 'royal_chamber') ? fx.royalAdj : 1;
      out.layerMult = deep;
      line('insight', (L) => fx.insight * pos(L) * deep * adjM * eff, 'rate');
      break;
    }
    case 'midden':
      line('disease', (L) => fx.disease * pos(L) * eff, 'pct', { sign: -1, cap: fx.diseaseMax });
      line('output', (L) => fx.output * pos(L) * eff, 'pct', { cap: fx.outputMax });
      break;
    case 'barracks': {
      const m = impliedMult(d, 'berths', num(agg.berthsBase));
      line('berths', (L) => fx.berths * pos(L) * eff * m, 'count');
      line('atk', (L) => fx.atk * pos(L) * eff, 'pct', { cap: fx.atkMax });
      break;
    }
    case 'root_aphid_pen':
      line('honeydew', (L) => fx.honeydew * pos(L) * eff, 'rate');
      break;
    case 'fungus_garden': {
      const m = impliedMult(d, 'gardenerSlots', num(agg.gardenerSlots));
      line('gardeners', (L) => fx.gardeners * pos(L) * m, 'count');
      line('leafCap', (L) => fx.leafCap * pos(L), 'num');
      line('fungusCap', (L) => fx.fungusCap * pos(L), 'num');
      break;
    }
    case 'repletion_hall': {
      const m = impliedMult(d, 'repleteBerths', num(agg.repleteBerthsBase));
      line('repleteBerths', (L) => fx.berths * pos(L) * eff * m, 'count');
      break;
    }
    case 'hibernaculum': {
      let cap = 0;
      for (const g of agg.broodGroups || []) if (g) cap += Math.max(0, num(g.cap));
      const m = impliedMult(d, 'broodSlots', cap);
      line('shelter', (L) => fx.shelter * pos(L) * eff * m, 'count');
      line('upkeep', (L) => fx.upkeep * pos(L), 'pct', { sign: -1, cap: fx.upkeepMax });
      break;
    }
    case 'thermal_chimney':
      line('winterForage', (L) => fx.winterForage * pos(L) * eff, 'pct', { sign: -1, cap: fx.max });
      break;
    case 'gate':
      line('gateHp', (L) => fx.hp * pos(L) * eff, 'pct');
      line('theft', (L) => fx.theft * pos(L) * eff, 'pct', { sign: -1 });
      break;
    case 'nuptial_chamber': {
      const max = G.traitLevel(s, 'royal_court') > 0 ? fx.cellsMaxCourt : fx.cellsMax;
      line('alateCells', (L) => (L >= 1 ? Math.min(max, fx.cellsBase + fx.cellsPer * (L - 1)) : 0), 'count');
      break;
    }
    case 'deep_vault':
      line('offline', (L) => fx.offlineSec * pos(L) * eff, 'time');
      line('alates', (L) => fx.alates * pos(L) * eff, 'pct');
      break;
    default:
      break;
  }
  return out;
}

/**
 * [q] The instance of a chamber type with the lowest next level-up cost (food, then soil, then uid) that can level now
 * apart from cost and queue room: active, unlocked, not at max, not blocked (C108; Build panel "Level cheapest",
 * Shift+L). null when none can.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} type
 * @returns {null | { uid: number, level: number, cost: Object, count: number }} count = instances of the type
 */
export function cheapestLevel(s, d, type) {
  if (!CHAMBERS[type]) return null;
  ensureGeom(s, d);
  let best = null;
  let count = 0;
  for (const ch of s.run.nest.chambers) {
    if (ch.type !== type) continue;
    count++;
    if (ch.status !== 'active') continue;
    const P = planLevel(s, d, ch, null, { ignoreQueue: true, ignoreCost: true });
    if (P.reason || !P.cost) continue;
    const fo = num(P.cost.food);
    const so = num(P.cost.soil);
    if (!best || fo < best.fo || (fo === best.fo && (so < best.so || (so === best.so && ch.uid < best.ch.uid)))) best = { ch, cost: P.cost, fo, so };
  }
  return best ? { uid: best.ch.uid, level: best.ch.level, cost: { ...best.cost }, count } : null;
}

/** Adjacency partner list of rule r for chamber type t: 'self' (t receives) / 'partner' (t gives) / null. */
function ruleRole(r, t) {
  const bs = Array.isArray(r.b) ? r.b : [r.b];
  if (r.a === t) return r.id === 'hyg_midden' ? 'partner' : 'self';
  if (bs.includes(t)) return r.id === 'hyg_midden' ? 'self' : r.id === 'adj_granary_repletion' ? 'self' : 'partner';
  return null;
}

/**
 * [q] Adjacency links a chamber has right now (C109; DESIGN §7.7, data ADJACENCY): [{ rule, uid (partner, 0 for an
 * entrance), partner (type | 'entrance'), text, good, receiver: 'self'|'partner' }]. receiver 'self' = this chamber
 * receives the bonus (a Nursery next to the Royal Chamber), 'partner' = it gives one (the Royal Chamber). Only
 * contributing chambers link (as in derive); the Midden's hygiene hit is good: false. One entry per rule and partner.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} uid
 * @returns {Array<Object>}
 */
export function chamberLinks(s, d, uid) {
  const f = findChamber(s, uid);
  if (!f || !contributes(f.ch)) return [];
  const dn = ensureGeom(s, d);
  const info = dn.chambers[f.j];
  if (!info) return [];
  const chs = s.run.nest.chambers;
  const out = [];
  const t = f.ch.type;
  for (const id of ADJACENCY_ORDER) {
    const r = ADJACENCY[id];
    const role = ruleRole(r, t);
    if (!role) continue;
    if (r.b === 'entrance') {
      if (info.minEntPath >= 0 && info.minEntPath <= r.path) out.push({ rule: id, uid: 0, partner: 'entrance', text: r.text, good: true, receiver: 'self' });
      continue;
    }
    if (id === 'hyg_midden') {
      if (role === 'self' && info.hygiene) {
        const m = chs.find((c) => c.uid === info.hygieneBy);
        out.push({ rule: id, uid: m ? m.uid : 0, partner: 'midden', text: r.text, good: false, receiver: 'self' });
      } else if (role === 'partner') {
        for (let k = 0; k < chs.length; k++) {
          if (dn.chambers[k] && dn.chambers[k].hygieneBy === f.ch.uid) out.push({ rule: id, uid: chs[k].uid, partner: chs[k].type, text: r.text, good: false, receiver: 'partner' });
        }
      }
      continue;
    }
    const want = r.a === t ? (Array.isArray(r.b) ? r.b : [r.b]) : [r.a];
    for (const u of info.adj || []) {
      const p = chs.find((c) => c.uid === u);
      if (!p || !want.includes(p.type) || !contributes(p)) continue;
      out.push({ rule: id, uid: p.uid, partner: p.type, text: r.text, good: true, receiver: role });
    }
  }
  return out;
}

/**
 * Links a footprint `rect` of type `type` would have (ghost preview, C109): partners of each ADJACENCY rule within its
 * path, through open cells (the auto-route not counted). Same entry shape as chamberLinks.
 */
function ghostLinks(s, d, type, P, relUid) {
  const r0 = P.rect;
  const geo = G.getGeom(s, d);
  const ghost = G.rectCells(r0.x, r0.y, r0.w, r0.h);
  const chs = s.run.nest.chambers;
  const fields = new Map();
  const field = (path) => {
    if (!fields.has(path)) fields.set(path, G.gapField(geo, ghost, path));
    return fields.get(path);
  };
  const out = [];
  for (const id of ADJACENCY_ORDER) {
    const r = ADJACENCY[id];
    const role = ruleRole(r, type);
    if (!role) continue;
    if (r.b === 'entrance') {
      const e = estPath(geo, geo.entDist, P);
      if (e >= 0 && e <= r.path) out.push({ rule: id, uid: 0, partner: 'entrance', text: r.text, good: true, receiver: 'self' });
      continue;
    }
    const bs = Array.isArray(r.b) ? r.b : [r.b];
    const want = r.a === type ? bs : [r.a];
    const fld = field(r.path);
    for (const ch of chs) {
      if (ch.uid === relUid || !want.includes(ch.type)) continue;
      // Bonuses the ghost receives need a working partner (derive); effects it gives land on any partner.
      if (role === 'self' && id !== 'hyg_midden' && !contributes(ch)) continue;
      if (id === 'hyg_midden' && role === 'self' && !contributes(ch)) continue;
      if (!G.rectNear(fld, ch)) continue;
      out.push({ rule: id, uid: ch.uid, partner: ch.type, text: r.text, good: id !== 'hyg_midden', receiver: role });
    }
  }
  return out;
}

/**
 * [q] Advisor / bot: the best valid spot for a chamber type (adjacency bonuses first; granaries and nurseries deep,
 * below the hard-winter frost line, from minute 15; shallow granaries before that). Ignores affordability and the
 * queue limit; null when the type is locked, at its instance limit, or nothing fits.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} type
 * @returns {{ x: number, y: number } | null}
 */
export function findPlacement(s, d, type) {
  const def = CHAMBERS[type];
  if (!def) return null;
  if (def.unlock && !s.run.unlocked[def.unlock]) return null;
  if (countType(s, type) >= instLimit(s, d, type)) return null;
  const geo = G.getGeom(s, d);
  const fp = G.footprint(type, 1);
  const cells = s.run.nest.cells;
  const field = G.digField(s, geo).cost;
  const ctx = G.workCtx(s);
  const chs = s.run.nest.chambers;
  const late = s.run.time >= ADVISOR.deepAfterSec;
  const frostRow = hardFrostRow(s, d);
  const partnerField = (types, gap, needActive = true) => {
    const src = [];
    for (const ch of chs) if (types.includes(ch.type) && (!needActive || contributes(ch))) src.push(...G.rectCells(ch.x, ch.y, ch.w, ch.h));
    return src.length ? G.gapField(geo, src, gap) : null;
  };
  const goodTypes = { nursery: ['royal_chamber'], scent_library: ['royal_chamber'], granary: ['repletion_hall'],
    repletion_hall: ['granary'], fungus_garden: ['water_well'], water_well: ['fungus_garden'] }[type];
  const good = goodTypes ? partnerField(goodTypes, GEOM.adjPathMax) : null;
  const hyg = type === 'nursery' || type === 'fungus_garden' ? partnerField(['midden'], GEOM.hygienePath)
    : type === 'midden' ? partnerField(['nursery', 'fungus_garden'], GEOM.hygienePath, false) : null;
  const BIG = 1e7;
  // Growth room (integration fix; DESIGN §7.4 footprints grow to L8): the advisor keeps one free L8 growth envelope
  // per existing growing chamber (the Royal Chamber's centred one first: Royal L5 is a Flight requirement) and prefers
  // spots whose own L8 envelope fits, so following its suggestions never boxes chambers in. Adjacency partners still
  // win (their bonus is far larger); both are soft penalties used only when an alternative exists.
  const overlaps = (a, x, y, w, h) => !(x + w - 1 < a.x || x > a.x + a.w - 1 || y + h - 1 < a.y || y > a.y + a.h - 1);
  const envFree = (x0, y0, w, h, relIdx, t, avoid) => {
    if (x0 < 0 || y0 < effRowMin(s, d, t) || x0 + w > COLS || y0 + h > ROWS || y0 + h - 1 > CHAMBERS[t].rowMax) return false;
    if (avoid && avoid.some((r) => overlaps(r, x0, y0, w, h))) return false;
    for (let yy = y0; yy < y0 + h; yy++) for (let xx = x0; xx < x0 + w; xx++) if (cellBlock(s, geo, yy * COLS + xx, relIdx)) return false;
    return true;
  };
  const envelopes = (t, rx, ry, rw, rh, centred) => {
    const fm = G.footprint(t, GEOM.footprintMaxL);
    if (!CHAMBERS[t].grows || (fm.w <= rw && fm.h <= rh)) return null;
    const W = Math.max(fm.w, rw);
    const H = Math.max(fm.h, rh);
    const list = [[rx, ry], [rx + rw - W, ry], [rx, ry + rh - H], [rx + rw - W, ry + rh - H]];
    if (centred) list.unshift([rx - Math.floor((W - rw) / 2), ry]);
    return list.map(([x0, y0]) => ({ x: x0, y: y0, w: W, h: H }));
  };
  const reserve = [];
  chs.forEach((ch, j) => {
    if (!ch || !CHAMBERS[ch.type] || ch.level >= GEOM.footprintMaxL) return;
    const envs = envelopes(ch.type, ch.x, ch.y, ch.w, ch.h, ch.type === 'royal_chamber');
    const free = envs && envs.find((e) => envFree(e.x, e.y, e.w, e.h, j, ch.type, reserve));
    if (free) reserve.push(free);
  });
  const inReserve = (x, y, w, h) => reserve.some((r) => overlaps(r, x, y, w, h));
  // Browser integration: a spot that takes the Royal Chamber's last room to reach the Flight level ranks below every
  // other spot, adjacency partners included (the ghost warns a player with royalRoom for the same spots).
  const royalG = royalGuard(s, d, 0);
  const boxesRoyal = (rect) => !!royalG && royalG.blocks(rect);
  const selfRoom = (x, y) => {
    const envs = envelopes(type, x, y, fp.w, fp.h, false);
    return !envs || envs.some((e) => envFree(e.x, e.y, e.w, e.h, -1, type, reserve));
  };
  const cands = [];
  const rowMin = effRowMin(s, d, type);
  for (let y = rowMin; y + fp.h - 1 <= def.rowMax && y + fp.h <= ROWS; y++) {
    if (s.run.hardship === 'shallow_soil' && y + fp.h - 1 > DIG.shallowSoilRow) break;
    for (let x = 0; x + fp.w <= COLS; x++) {
      const rect = { x, y, w: fp.w, h: fp.h };
      const rc = G.rectCells(x, y, fp.w, fp.h);
      let bad = false;
      let footWork = 0;
      let direct = false;
      for (const c of rc) {
        if (cellBlock(s, geo, c, -1)) { bad = true; break; }
        if (G.isOpenCode(cells[c])) { if (geo.entDist[c] >= 0) direct = true; } else footWork += G.workAt(ctx, c, 'chamber');
      }
      if (bad || ruleCheck(s, geo, def, rect, 0)) continue;
      let connect = Infinity;
      for (const p of G.perimeter(rect)) {
        if (geo.open[p] && geo.entDist[p] >= 0 && !geo._backfill[p]) { direct = true; break; }
        if (Number.isFinite(field[p]) && field[p] < connect) connect = field[p];
      }
      if (direct) connect = 0;
      if (!Number.isFinite(connect)) continue;
      let score = connect + footWork;
      if (good && G.rectNear(good, rect)) score -= BIG;
      if (hyg && G.rectNear(hyg, rect)) score += BIG;
      const exposed = !def.frostImmune && G.exposedTo(rect, frostRow);
      if (type === 'granary' || type === 'nursery') {
        if (late) {
          if (exposed) score += BIG / 2;
          score -= y * 5;
        } else if (type === 'granary') {
          score += y * 50;
        }
      } else if (exposed) {
        score += BIG / 10;
      }
      if (y <= DIG.floodRows[1]) score += BIG / 20;
      if (inReserve(x, y, fp.w, fp.h)) score += BIG / 15;
      if (boxesRoyal(rect)) score += 3 * BIG;
      cands.push({ x, y, score });
    }
  }
  // The self-room check is the costly part: run it only on the best-scored candidates.
  cands.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);
  for (let k = 0; k < cands.length && k < 400; k++) if (!selfRoom(cands[k].x, cands[k].y)) cands[k].score += BIG / 15;
  cands.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);
  for (let k = 0; k < cands.length && k < 40; k++) {
    const c = cands[k];
    const P = planPlacement(s, d, type, c.x, c.y, { ignoreQueue: true, ignoreCost: true });
    if (!P.reason) return { x: c.x, y: c.y };
  }
  return null;
}

/**
 * [q] Chamber whose footprint covers cell i (including chambers still being dug), or null.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} i
 * @returns {import('../core/types.js').Chamber|null}
 */
export function chamberAtCell(s, d, i) {
  if (!isCell(i)) return null;
  const geo = G.getGeom(s, d);
  const j = geo.chamberAt[i];
  return j >= 0 ? s.run.nest.chambers[j] || null : null;
}

/**
 * [q] Cell tooltip data: layer id, cell code, tunnel work, visible cache-hint kind (null unless shown as a hint),
 * water (a revealed pocket cell), root (on a root line), rootOwn (a cultivated root, C118).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} i
 * @returns {{ layer: string, code: number, work: number, cache: string|null, water: boolean, root: boolean, rootOwn: boolean }}
 */
export function cellInfo(s, d, i) {
  if (!isCell(i)) return { layer: G.layerOf(0), code: CELL.SOIL, work: 0, cache: null, water: false, root: false, rootOwn: false };
  const geo = G.getGeom(s, d);
  const y = Math.floor(i / COLS);
  const hints = geo === (d && d.nest) && Array.isArray(geo.hints) ? geo.hints : computeHints(s, geo);
  let cache = null;
  if (hints.includes(i)) {
    const c = (s.run.nest.features.caches || []).find((k) => k && k.i === i && !k.found);
    cache = c ? c.kind : null;
  }
  const p = geo._pocket[i];
  const water = p >= 0 && !!(s.run.nest.features.water[p] && s.run.nest.features.water[p].revealed) && s.run.nest.cells[i] === CELL.WATER;
  const x = i % COLS;
  const rootOwn = geo._root[i] === 1 && (s.run.nest.features.roots || []).some((r) => r && r.own && r.col === x && y >= r.y0 && y <= r.y1);
  return { layer: G.layerOf(y), code: s.run.nest.cells[i], work: G.cellWork(s, i, 'tunnel'), cache, water, root: geo._root[i] === 1, rootOwn };
}

// ------------------------------------------------------------------------------------------------------------------
// Cross-callable mutators [x]
// ------------------------------------------------------------------------------------------------------------------

/**
 * [x] WP7: queue a 'shaft' job from row 0 down column `col` to the first open cell (a tunnel route joins the nest if
 * the column meets no open cell), and record the shaft ({ kind, col, open: false, ref }; opened when dug). Bypasses
 * the queue limit. Returns the job uid, or 0 if no shaft can be dug there.
 * ARCH-R: the shaft record is pushed with open: false when queued (the contract pushes nuptial shafts on completion);
 * it lets the ≥ 3-column rule and the renderer see pending shafts. entDist only uses open shafts.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} col
 * @param {string} kind 'satellite' (or 'nuptial')
 * @param {number} ref satellite index or −1
 * @returns {number}
 */
export function queueShaft(s, d, col, kind, ref) {
  if (!isInt(col) || col < 0 || col >= COLS) return 0;
  const nest = s.run.nest;
  const list = planShaftCells(s, ensureGeom(s, d), col);
  if (!list) return 0;
  nest.shafts.push({ kind: typeof kind === 'string' && kind ? kind : 'satellite', col, open: false, ref: isInt(ref) ? ref : -1 });
  const job = { uid: nest.nextUid++, kind: 'shaft', chamber: 0, cells: list, cur: 0, prog: 0, paidFood: 0, blueprint: false };
  nest.queue.push(job);
  nest.rev++;
  rebuild(s, d);
  return job.uid;
}

/**
 * [q] Extra (C66): true when a satellite shaft at column col (as queueShaft would dig it) would take the original Royal
 * Chamber's last room to reach the Flight level; placeSatellite refuses such a column with 'blocked:royalRoom'.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} col
 * @returns {boolean}
 */
export function shaftBoxesRoyal(s, d, col) {
  if (!isInt(col) || col < 0 || col >= COLS) return false;
  const guard = royalGuard(s, d, 0);
  if (!guard) return false;
  const list = planShaftCells(s, G.getGeom(s, d), col);
  if (!list) return false;
  // Only the column becomes shaft (the connecting route, if any, stays tunnel), and C125 only its top rows are a
  // permanent obstacle (a chamber, the Royal Chamber included, may cover the rest: the shaft passes through).
  return guard.blocks(null, list.filter((c) => c % COLS === col && c < G.SHAFT_KEEP_ROWS * COLS));
}

/** Cells of a shaft dug from row 0 at column col down to the open nest (null when it cannot be dug). */
function planShaftCells(s, geo, col) {
  const nest = s.run.nest;
  const cells = nest.cells;
  const top = G.idx(col, 0);
  if (cells[top] !== CELL.SOIL || geo.chamberAt[top] >= 0 || geo._backfill[top] || !G.isDiggable(s, top)) return null;
  const list = [];
  let connected = false;
  const reach = (c) => geo.open[c] && geo.entDist[c] >= 0;
  for (let y = 0; y < ROWS; y++) {
    const c = G.idx(col, y);
    if (geo.open[c]) {
      if (reach(c)) { connected = true; break; }
      continue;
    }
    if (cells[c] !== CELL.SOIL || geo.chamberAt[c] >= 0 || geo._backfill[c] || !G.isDiggable(s, c)) break;
    list.push(c);
    if ((col > 0 && reach(c - 1)) || (col < COLS - 1 && reach(c + 1))) { connected = true; break; }
    if (y >= nest.deepestRow) break;
  }
  if (!list.length) return null;
  if (!connected) {
    const bottom = list[list.length - 1];
    const blocked = new Uint8Array(N);
    for (const c of list) blocked[c] = 1;
    const isGoal = (i) => !blocked[i] && G.neighbors4(i).includes(bottom);
    const { prev, goal } = G.digField(s, geo, { isGoal, blocked });
    if (goal < 0) return null;
    const path = G.pathCells(s, prev, goal);
    for (let k = path.length - 1; k >= 0; k--) list.push(path[k]);
  }
  return list;
}

/**
 * Placement refusals that can never clear during this run for a pending blueprint chamber (C106): the spot is out
 * of bounds or breaks the row rule, sits on water or another chamber, the run's hardship forbids it, or a seeded rule
 * (root, row 0, entrance shaft) fails; 'max' only when no instance bonus is left to raise the limit. C125: a shaft only
 * blocks a footprint at its top G.SHAFT_KEEP_ROWS rows (deeper, it passes through the chamber), and shafts never close,
 * so 'blocked:shaft' is permanent too (bpPermanent; not for a Nuptial Chamber, whose exit shaft may find a column
 * later). Everything else
 * (locked, cost, queued / backfilling cells, stone or a locked layer, the Royal room, an unrevealed water pocket)
 * waits.
 */
const BP_PERMANENT = new Set(['invalid', 'invalid:bounds', 'invalid:row', 'invalid:row0', 'invalid:shaft', 'invalid:root',
  'blocked:water', 'blocked:chamber', 'hardship']);

function bpPermanent(s, type, reason) {
  if (BP_PERMANENT.has(reason)) return true;
  // C125: a footprint over a shaft's top rows never clears; a Nuptial Chamber's 'blocked:shaft' (no exit-shaft column
  // for now) can.
  if (reason === 'blocked:shaft') return !!CHAMBERS[type] && CHAMBERS[type].rule !== 'nuptialShaft';
  if (reason === 'max') {
    const def = CHAMBERS[type];
    if (!def || def.maxInst === 'perPocket') return false;
    return !(def.instBonus || []).some((b) => !bonusOwned(s, b));
  }
  return false;
}

/** Try to place one blueprint chamber (half price, fast dig, no queue limit; C66 Royal room kept). Reason or null. */
function bpPlace(s, d, sp, opts) {
  const P = planPlacement(s, d, sp.type, sp.x, sp.y, { blueprint: true, ignoreQueue: true, ...opts });
  if (P.reason) return P.reason;
  // C66: a blueprint never boxes the queen in (a saved layout may have been boxed in before Royal L5).
  if (blocksRoyalGrowth(s, P.rect, 0, { d, cells: P.shaft ? shaftCells(P.rect, P.shaft.col) : null })) return 'blocked:royalRoom';
  return executePlacement(s, d, sp.type, P, null, true) ? null : 'cantAfford';
}

/** Note for the player about the blueprint (flushed as blueprintDropped events by the next tick; C119). */
function bpNote(s, type, x, y, reason) {
  const nest = s.run.nest;
  if (!Array.isArray(nest.bpNotes)) nest.bpNotes = [];
  if (nest.bpNotes.length < 20) nest.bpNotes.push({ chamberType: type, x, y, reason });
}

/**
 * Water Well spots touching pocket k (L1 footprint, not overlapping water): [{ x, y }]. strict = only cells a chamber
 * can use now (cellBlock); otherwise only water, chambers and shafts rule a spot out (run-start feasibility, C119).
 */
function wellSpots(s, geo, k, strict) {
  const p = (s.run.nest.features.water || [])[k];
  if (!p) return [];
  const fp = G.footprint('water_well', 1);
  const def = CHAMBERS.water_well;
  const cells = s.run.nest.cells;
  const out = [];
  for (let y = p.y - fp.h; y <= p.y + p.h; y++) {
    for (let x = p.x - fp.w; x <= p.x + p.w; x++) {
      const rect = { x, y, w: fp.w, h: fp.h };
      if (x < 0 || y < 0 || x + fp.w > COLS || y + fp.h > ROWS || y < def.rowMin || y + fp.h - 1 > def.rowMax) continue;
      if (rectsOverlap(rect, p)) continue;
      if (!G.perimeter(rect).some((c) => geo._pocket[c] === k && cells[c] === CELL.WATER)) continue;
      let ok = true;
      for (const c of G.rectCells(x, y, fp.w, fp.h)) {
        if (strict ? cellBlock(s, geo, c, -1) : (cells[c] === CELL.WATER || geo.chamberAt[c] >= 0 || (geo._shaft[c] && c < G.SHAFT_KEEP_ROWS * COLS))) { ok = false; break; }
      }
      if (ok) out.push({ x, y });
    }
  }
  return out;
}

/**
 * C119: the spot a floating blueprint Water Well takes now — the valid spot nearest its saved corner that touches a
 * revealed water pocket no Well uses (and no other floating Well of this pass took), or null.
 */
function wellTarget(s, d, sp, taken) {
  const def = CHAMBERS.water_well;
  if (def.unlock && !s.run.unlocked[def.unlock]) return null;
  const geo = ensureGeom(s, d);
  const water = s.run.nest.features.water || [];
  const used = new Set(taken);
  for (const ch of s.run.nest.chambers) if (ch.type === 'water_well') for (const k of pocketsTouched(s, geo, ch)) used.add(k);
  const cands = [];
  for (let k = 0; k < water.length; k++) {
    if (!water[k] || !water[k].revealed || used.has(k)) continue;
    for (const c of wellSpots(s, geo, k, true)) cands.push({ x: c.x, y: c.y, k, dist: Math.abs(c.x - sp.x) + Math.abs(c.y - sp.y) });
  }
  cands.sort((a, b) => a.dist - b.dist || a.y - b.y || a.x - b.x);
  for (const c of cands) {
    const P = planPlacement(s, d, 'water_well', c.x, c.y, { blueprint: true, ignoreQueue: true, ignoreCost: true });
    if (P.reason || blocksRoyalGrowth(s, P.rect, 0, { d })) continue;
    return c;
  }
  return null;
}

/**
 * One blueprint pass (run start, then each pending re-check; C106). BFS from the open, connected nest through open
 * cells, queued dig cells and the blueprint's tunnel cells: tunnel cells are queued in groups (blueprint jobs), and a
 * chamber spot is placed when reached (its tunnels follow it). A chamber that cannot be placed blocks the BFS and stays
 * pending, unless its refusal is permanent (dropped). Spots the BFS never reaches and that no blueprint tunnel or spot
 * touches are tried once with the auto-route.
 * @returns {{ jobs: number, pending: Array<{type: string, x: number, y: number}>, tunnels: number[],
 *   dropped: Array<{type: string, x: number, y: number, reason: string}> }}
 */
function bpPass(s, d, specList, tunnelList) {
  const nest = s.run.nest;
  let geo = ensureGeom(s, d);
  const tunnel = new Uint8Array(N);
  const later = [];
  for (const c of tunnelList) {
    if (!isCell(c) || geo.chamberAt[c] >= 0 || geo._queued[c]) continue;
    const code = nest.cells[c];
    if (code !== CELL.SOIL && code !== CELL.STONE) continue;
    if (G.isDiggable(s, c) && code === CELL.SOIL) tunnel[c] = 1;
    else later.push(c); // stone / a locked layer: wait for acid_excavation or the layer
  }
  const specs = [];
  const dropped = [];
  const floats = [];
  const taken = [];
  const specAt = new Int16Array(N).fill(-1);
  for (const sp0 of specList) {
    if (!sp0 || !CHAMBERS[sp0.type] || !isInt(sp0.x) || !isInt(sp0.y)) continue;
    let sp = sp0;
    let auto = !!sp0.auto;
    if (sp0.float || (sp0.type === 'water_well' && !sp0.auto)) {
      // C119: a blueprint Water Well takes the nearest valid spot by a revealed free pocket once there is one.
      const t = wellTarget(s, d, sp0, taken);
      if (!t) { floats.push({ type: sp0.type, x: sp0.x, y: sp0.y, float: true }); continue; }
      taken.push(t.k);
      if (t.x !== sp0.x || t.y !== sp0.y) bpNote(s, sp0.type, t.x, t.y, 'well:moved');
      sp = { type: sp0.type, x: t.x, y: t.y };
      auto = true;
    }
    const fp = G.footprint(sp.type, 1);
    if (sp.x < 0 || sp.y < 0 || sp.x + fp.w > COLS || sp.y + fp.h > ROWS) {
      dropped.push({ type: sp.type, x: sp.x, y: sp.y, reason: 'invalid:bounds' });
      continue;
    }
    const rc = G.rectCells(sp.x, sp.y, fp.w, fp.h);
    if (rc.some((c) => specAt[c] >= 0)) continue;
    const k = specs.length;
    for (const c of rc) { specAt[c] = k; tunnel[c] = 0; }
    specs.push({ type: sp.type, x: sp.x, y: sp.y, cells: rc, state: 0, reason: null, auto });
  }
  const visited = new Uint8Array(N);
  const q = [];
  for (let i = 0; i < N; i++) if (geo.open[i] && geo.entDist[i] >= 0 && !geo._backfill[i]) { visited[i] = 1; q.push(i); }
  let group = [];
  let jobs = 0;
  const flush = () => {
    if (!group.length) return;
    nest.queue.push({ uid: nest.nextUid++, kind: 'tunnel', chamber: 0, cells: group, cur: 0, prog: 0, paidFood: 0, blueprint: true });
    nest.rev++;
    jobs++;
    group = [];
    geo = ensureGeom(s, d);
  };
  const placed = (sp) => {
    sp.state = 1;
    jobs += nest.queue.length && nest.queue[nest.queue.length - 1].kind === 'shaft' ? 2 : 1;
    geo = ensureGeom(s, d);
  };
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    for (const n of G.neighbors4(c)) {
      if (visited[n]) continue;
      if (tunnel[n]) {
        visited[n] = 1;
        group.push(n);
        q.push(n);
      } else if (specAt[n] >= 0 && specs[specAt[n]].state === 0) {
        const sp = specs[specAt[n]];
        flush();
        sp.reason = bpPlace(s, d, sp, { assumeConnected: true, seedCells: [c] });
        if (!sp.reason) {
          placed(sp);
          for (const k of sp.cells) if (!visited[k]) { visited[k] = 1; q.push(k); }
        } else {
          sp.state = 2;
          for (const k of sp.cells) visited[k] = 1;
        }
      } else if ((geo.open[n] && !geo._backfill[n]) || geo._queued[n]) {
        visited[n] = 1;
        q.push(n);
      }
    }
  }
  flush();
  // Unreached spots that nothing in the layout leads to: one auto-routed try (DESIGN §7.2 A* route).
  for (const sp of specs) {
    if (sp.state !== 0) continue;
    const fp = G.footprint(sp.type, 1);
    const linked = !sp.auto && G.perimeter({ x: sp.x, y: sp.y, w: fp.w, h: fp.h }).some((p) => tunnel[p] || (specAt[p] >= 0 && specs[specAt[p]] !== sp));
    if (linked) continue;
    sp.reason = bpPlace(s, d, sp, {});
    if (!sp.reason) placed(sp);
  }
  const pending = [];
  for (const sp of specs) {
    if (sp.state === 1) continue;
    // C119: a Water Well whose spot stopped working (its pocket went, something was built there) floats again.
    if (sp.type === 'water_well' && sp.reason && (sp.reason === 'invalid:water' || BP_PERMANENT.has(sp.reason))) {
      pending.push({ type: sp.type, x: sp.x, y: sp.y, float: true });
      continue;
    }
    if (sp.reason && bpPermanent(s, sp.type, sp.reason)) dropped.push({ type: sp.type, x: sp.x, y: sp.y, reason: sp.reason });
    else pending.push(sp.auto ? { type: sp.type, x: sp.x, y: sp.y, auto: true } : { type: sp.type, x: sp.x, y: sp.y });
  }
  for (const f of floats) pending.push(f);
  const tunnels = later.slice();
  for (let i = 0; i < N; i++) if (tunnel[i] && !visited[i]) tunnels.push(i);
  tunnels.sort((a, b) => a - b);
  if (jobs) rebuild(s, d);
  return { jobs, pending, tunnels, dropped };
}

/**
 * [x] WP7 at run start: queue the active blueprint (era.blueprints[activeBlueprint]). Tunnels and chambers are queued
 * in BFS order from the open nest (a chamber's job follows the tunnels that reach it), bypassing the queue limit;
 * blueprint jobs dig ×3 (×5 with blueprint_memory) and chambers cost 50 % placement food, paid now.
 * C106: chambers that are locked, unaffordable or otherwise not placeable yet are kept as pending blueprint chambers
 * (s.run.nest.bpPending, with the tunnels behind them in bpTunnels) and queue themselves later (see bpTick); spots that
 * can never be used this run (water, out of bounds, a seeded rule) are dropped. Chambers go in at their L1 footprint
 * at the saved top-left corner.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number} jobs queued
 */
export function applyBlueprint(s, d) {
  const era = s.era;
  const bi = era.activeBlueprint;
  if (!isInt(bi) || bi < 0 || !Array.isArray(era.blueprints) || !era.blueprints[bi]) return 0;
  const bp = era.blueprints[bi];
  const nest = s.run.nest;
  // C119: the Royal Chamber first (blueprint chambers may sit where the default one is), then the Water Wells.
  if (bp.royal && typeof bp.royal === 'object') placeRoyal(s, d, bp.royal);
  const specs = wellSpecs(s, d, Array.isArray(bp.chambers) ? bp.chambers : []);
  const r = bpPass(s, d, specs, Array.isArray(bp.tunnels) ? bp.tunnels : []);
  nest.bpPending = r.pending;
  nest.bpTunnels = r.pending.length ? r.tunnels : [];
  return r.jobs;
}

/**
 * C119: the blueprint's Water Wells at run start. Water pockets are seeded per run, so a saved Well spot means nothing
 * on new soil: each Well becomes a floating spec (placed later by the nearest free pocket, see wellTarget). Wells beyond
 * the number of this run's pockets that have any usable Well spot are dropped with a note.
 */
function wellSpecs(s, d, list) {
  const geo = ensureGeom(s, d);
  const water = s.run.nest.features.water || [];
  let usable = 0;
  for (let k = 0; k < water.length; k++) if (water[k] && wellSpots(s, geo, k, false).length) usable++;
  const out = [];
  for (const sp of list) {
    if (!sp || sp.type !== 'water_well') { out.push(sp); continue; }
    if (!isInt(sp.x) || !isInt(sp.y)) continue;
    if (usable > 0) {
      usable--;
      out.push({ type: sp.type, x: sp.x, y: sp.y, float: true });
    } else bpNote(s, sp.type, sp.x, sp.y, 'well:none');
  }
  return out;
}

/** Reason the original Royal Chamber's L1 footprint cannot be pre-dug at (x, y) on this run's soil, or null (C119). */
function royalSpotBlock(s, d, ch, x, y) {
  const def = CHAMBERS.royal_chamber;
  if (x < 0 || y < 0 || x + ch.w > COLS || y + ch.h > ROWS) return 'invalid:bounds';
  if (y < effRowMin(s, d, 'royal_chamber') || y + ch.h - 1 > def.rowMax) return 'invalid:row';
  if (s.run.hardship === 'shallow_soil' && y + ch.h - 1 > DIG.shallowSoilRow) return 'hardship';
  const geo = ensureGeom(s, d);
  const self = s.run.nest.chambers.indexOf(ch);
  for (const c of G.rectCells(x, y, ch.w, ch.h)) {
    const j = geo.chamberAt[c];
    if (j >= 0 && j !== self) return 'blocked:chamber';
    if (j === self) continue;
    if (geo._shaft[c]) return 'blocked:shaft';
    const code = s.run.nest.cells[c];
    if (code === CELL.WATER) return 'blocked:water';
    if (code === CELL.STONE && !G.hasResearch(s, 'acid_excavation')) return 'blocked:stone';
    if ((code === CELL.SOIL || code === CELL.STONE) && !G.layerOpen(s, Math.floor(c / COLS))) return 'blocked:layer';
  }
  return null;
}

/**
 * C119: at run start, move the pre-dug L1 Royal Chamber (uid 1) to the blueprint's saved corner when that spot works
 * on this run's soil: its cells are free (no stone, water, shaft or other chamber, an open layer), it meets the row
 * rule, it connects to the entrance (a free pre-dug tunnel from the nearest open cell when it does not touch one) and
 * it keeps room to reach the Flight level (C66). The default cells become soil again (tunnel when extra pre-dug Royal
 * Chambers hang off them). Otherwise it stays at the default spot. Either way a note tells the player.
 */
function placeRoyal(s, d, spot) {
  const nest = s.run.nest;
  const f = findChamber(s, 1);
  if (!f || f.ch.type !== 'royal_chamber' || !isInt(spot.x) || !isInt(spot.y)) return;
  const ch = f.ch;
  if (spot.x === ch.x && spot.y === ch.y) return;
  const why = royalSpotBlock(s, d, ch, spot.x, spot.y);
  if (why) {
    bpNote(s, 'royal_chamber', spot.x, spot.y, 'royal:kept:' + why);
    return;
  }
  const bak = nest.cells.slice();
  const old = { x: ch.x, y: ch.y };
  const keepOpen = nest.chambers.some((c) => c.uid !== 1 && c.type === 'royal_chamber');
  for (const c of G.rectCells(ch.x, ch.y, ch.w, ch.h)) nest.cells[c] = keepOpen ? CELL.TUNNEL : CELL.SOIL;
  ch.x = spot.x;
  ch.y = spot.y;
  const rc = G.rectCells(ch.x, ch.y, ch.w, ch.h);
  for (const c of rc) nest.cells[c] = CELL.CHAMBER;
  nest.rev++;
  rebuild(s, d);
  let fail = null;
  let route = [];
  const geo = ensureGeom(s, d);
  if (!rc.some((c) => geo.entDist[c] >= 0)) {
    const r = G.routeTo(s, d, rc);
    if (!r) fail = 'blocked:route';
    else {
      route = r.cells;
      for (const c of route) nest.cells[c] = CELL.TUNNEL;
      nest.rev++;
      rebuild(s, d);
    }
  }
  if (!fail) {
    const room = royalRoom(s, d);
    if (room && !room.free.length) fail = 'blocked:royalRoom';
  }
  if (fail) {
    for (let i = 0; i < N; i++) nest.cells[i] = bak[i];
    ch.x = old.x;
    ch.y = old.y;
    nest.rev++;
    rebuild(s, d);
    bpNote(s, 'royal_chamber', spot.x, spot.y, 'royal:kept:' + fail);
    return;
  }
  // Buried caches under the new cells are collected (as if dug).
  for (const c of [...rc, ...route]) collectCache(s, d, c, null);
  let deep = 0;
  for (let i = 0; i < N; i++) if (G.isOpenCode(nest.cells[i])) deep = Math.max(deep, Math.floor(i / COLS));
  nest.deepestRow = deep;
  bpNote(s, 'royal_chamber', spot.x, spot.y, 'royal:moved');
}

/** Pending re-check bookkeeping per nest object (not saved): last check time, unlock count, last idle signature. */
const bpMemo = new WeakMap();
const BP_CHECK_SEC = 1;

/** Pending spot ready to try: unlocked, below the instance limit, blueprint price affordable. */
function bpReady(s, d, sp) {
  const def = CHAMBERS[sp.type];
  if (!def) return false;
  if (def.unlock && !s.run.unlocked[def.unlock]) return false;
  if (countType(s, sp.type) >= instLimit(s, d, sp.type)) return false;
  const cost = placementCost(s, sp.type);
  if (!cost) return false;
  return canAfford(s, cost.food !== undefined ? { ...cost, food: cost.food * DIG.blueprintPlaceMult } : cost);
}

/**
 * Pending blueprint chambers (C106): every BP_CHECK_SEC of run time, or at once when the unlock count changes, drop
 * spots that another chamber or water now covers, and when some spot is ready (bpReady) and the nest, unlocks or the
 * ready set changed since the last idle pass, run a blueprint pass over the pending spots and tunnels. Emits
 * blueprintDropped { chamberType, x, y, reason } per dropped spot.
 */
function bpTick(s, d, env) {
  const nest = s.run.nest;
  // C119: notes left by the run-start blueprint pass (Royal Chamber, Water Wells) and by earlier passes.
  if (Array.isArray(nest.bpNotes) && nest.bpNotes.length) {
    for (const n of nest.bpNotes) if (n) emit(env, 'blueprintDropped', { ...n });
    nest.bpNotes = [];
  }
  const pend = nest.bpPending;
  if (!Array.isArray(pend) || !pend.length) {
    if (Array.isArray(nest.bpTunnels) && nest.bpTunnels.length) nest.bpTunnels = [];
    return;
  }
  let m = bpMemo.get(nest);
  if (!m) { m = { t: -Infinity, u: -1, sig: '' }; bpMemo.set(nest, m); }
  const t = num(s.run.time);
  let u = 0;
  for (const k in s.run.unlocked) if (s.run.unlocked[k]) u++;
  if (u === m.u && t - m.t < BP_CHECK_SEC && t >= m.t) return;
  m.t = t;
  m.u = u;
  const geo = ensureGeom(s, d);
  const keep = [];
  let ready = '';
  for (const sp of pend) {
    const def = sp && CHAMBERS[sp.type];
    if (!def || !isInt(sp.x) || !isInt(sp.y)) continue;
    const fp = G.footprint(sp.type, 1);
    let why = null;
    if (sp.float) why = null;
    else if (sp.x < 0 || sp.y < 0 || sp.x + fp.w > COLS || sp.y + fp.h > ROWS) why = 'invalid:bounds';
    else {
      for (const c of G.rectCells(sp.x, sp.y, fp.w, fp.h)) {
        if (nest.cells[c] === CELL.WATER) { why = 'blocked:water'; break; }
        if (geo.chamberAt[c] >= 0) { why = 'blocked:chamber'; break; }
      }
    }
    if (why && sp.type === 'water_well') {
      // C119: a Water Well's spot is never final: it floats until a pocket has a free valid spot.
      keep.push({ type: sp.type, x: sp.x, y: sp.y, float: true });
      ready += bpReady(s, d, sp) ? '1' : '0';
      continue;
    }
    if (why) {
      emit(env, 'blueprintDropped', { chamberType: sp.type, x: sp.x, y: sp.y, reason: why });
      continue;
    }
    keep.push(sp);
    ready += bpReady(s, d, sp) ? '1' : '0';
  }
  if (keep.length !== pend.length) nest.bpPending = keep;
  if (!keep.length || ready.indexOf('1') < 0) return;
  const sig = nest.rev + '|' + u + '|' + ready;
  if (sig === m.sig) return;
  const r = bpPass(s, d, keep, Array.isArray(nest.bpTunnels) ? nest.bpTunnels : []);
  nest.bpPending = r.pending;
  nest.bpTunnels = r.pending.length ? r.tunnels : [];
  for (const x of r.dropped) emit(env, 'blueprintDropped', { chamberType: x.type, x: x.x, y: x.y, reason: x.reason });
  m.sig = r.jobs ? '' : nest.rev + '|' + u + '|' + ready;
}

/**
 * [q] Pending blueprint chambers (C106) for the nest view's "planned" outlines: [{ type, x, y, w, h }] at the L1
 * footprint (empty when none).
 * @param {import('../core/types.js').State} s
 * @returns {Array<{ type: string, x: number, y: number, w: number, h: number }>}
 */
export function plannedChambers(s) {
  const out = [];
  for (const sp of Array.isArray(s.run.nest.bpPending) ? s.run.nest.bpPending : []) {
    if (!sp || !CHAMBERS[sp.type] || !isInt(sp.x) || !isInt(sp.y) || sp.float || (sp.type === 'water_well' && !sp.auto)) continue; // C119: floating Wells have no spot yet
    const fp = G.footprint(sp.type, 1);
    out.push({ type: sp.type, x: sp.x, y: sp.y, w: fp.w, h: fp.h });
  }
  return out;
}

/** Waiting-reason cache per nest object (not saved; C126): { rev, t, u, pend, list }. */
const waitMemo = new WeakMap();

/**
 * Why one pending blueprint spec is still waiting (C126). Same checks as the blueprint pass (bpPlace), in the order a
 * player can act on them: locked, instance limit, the spot itself (planPlacement with the connection assumed: bounds,
 * row rule, Shallow Soil, water / chamber / shaft top / backfill / stone / queued / closed layer cells, the type's rule,
 * a Nuptial exit shaft), the Royal room (C66), the blueprint price; then whether anything open reaches it yet.
 */
function waitOf(s, d, sp) {
  const def = CHAMBERS[sp.type];
  const base = { type: sp.type, x: sp.x, y: sp.y, float: !!sp.float, cell: sp.y * COLS + sp.x };
  if (!def) return { ...base, code: 'invalid', detail: null };
  if (def.unlock && !s.run.unlocked[def.unlock]) return { ...base, code: 'locked', detail: { key: def.unlock } };
  const n = countType(s, sp.type);
  const max = instLimit(s, d, sp.type);
  if (n >= max) return { ...base, code: 'max', detail: { n, max } };
  let at = sp;
  if (sp.float || (sp.type === 'water_well' && !sp.auto)) {
    // C119: a floating Water Well has no spot until a revealed pocket has a free one; then it is judged there.
    at = wellTarget(s, d, sp, []);
    if (!at) return { ...base, code: 'wait:water', detail: null };
  }
  const P = planPlacement(s, d, sp.type, at.x, at.y, { blueprint: true, ignoreQueue: true, assumeConnected: true });
  if (P.reason === 'cantAfford') return { ...base, code: 'cantAfford', detail: { cost: P.cost } };
  if (P.reason) return { ...base, code: P.reason, detail: null };
  if (blocksRoyalGrowth(s, P.rect, 0, { d, cells: P.shaft ? shaftCells(P.rect, P.shaft.col) : null })) {
    return { ...base, code: 'blocked:royalRoom', detail: null };
  }
  const geo = G.getGeom(s, d);
  const reach = (c) => geo.open[c] && geo.entDist[c] >= 0 && !geo._backfill[c];
  const r = P.rect;
  const near = G.rectCells(r.x, r.y, r.w, r.h).some(reach) || G.perimeter(r).some(reach);
  return { ...base, code: near ? 'wait:next' : 'wait:path', detail: null };
}

/**
 * [q] C126: the waiting reason of every pending blueprint chamber (s.run.nest.bpPending order), for the planned
 * outline's tooltip, its inspect view and the Build panel's Blueprints list. Derived, never saved: cached per nest and
 * recomputed when the nest (rev), the unlocks or the pending list change, or after BP_CHECK_SEC of run time (the
 * pending re-check cadence of bpTick). Codes: 'locked' { key }, 'max' { n, max }, 'cantAfford' { cost } (blueprint
 * price), any planPlacement reason ('blocked:stone', 'blocked:queued', 'blocked:backfill', 'blocked:layer',
 * 'blocked:shaft', 'hardship', 'invalid:water', …), 'blocked:royalRoom', 'wait:water' (a floating Water Well: no
 * revealed pocket has a free spot yet), 'wait:path' (nothing open reaches it yet: the planned tunnels or chambers before
 * it come first), 'wait:next' (it queues on the next re-check).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {Array<{ type: string, x: number, y: number, float: boolean, cell: number, code: string, detail: Object|null }>}
 */
export function plannedWaits(s, d) {
  const nest = s.run.nest;
  const pend = Array.isArray(nest.bpPending) ? nest.bpPending : [];
  if (!pend.length) return [];
  const t = num(s.run.time);
  let u = 0;
  for (const k in s.run.unlocked) if (s.run.unlocked[k]) u++;
  const m = waitMemo.get(nest);
  if (m && m.rev === nest.rev && m.u === u && m.pend === pend && m.n === pend.length && t >= m.t && t - m.t < BP_CHECK_SEC) return m.list;
  const list = [];
  for (const sp of pend) {
    if (!sp || !CHAMBERS[sp.type] || !isInt(sp.x) || !isInt(sp.y)) continue;
    let w;
    try { w = waitOf(s, d, sp); } catch { w = { type: sp.type, x: sp.x, y: sp.y, float: !!sp.float, cell: sp.y * COLS + sp.x, code: 'invalid', detail: null }; }
    list.push(w);
  }
  waitMemo.set(nest, { rev: nest.rev, u, pend, n: pend.length, t, list });
  return list;
}

/**
 * [q] C126: the waiting reason of the pending blueprint chamber whose top-left cell is `cell` (see plannedWaits), or
 * null.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} cell
 * @returns {Object|null}
 */
export function plannedWait(s, d, cell) {
  return plannedWaits(s, d).find((w) => w.cell === cell) || null;
}

/**
 * [x] WP7 autobuyer: level the cheapest affordable chamber (food, then soil, then uid) in the auto direction.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @returns {boolean} true if a level-up was bought
 */
export function autoLevelStep(s, d, env) {
  ensureGeom(s, d);
  let best = null;
  for (const ch of s.run.nest.chambers) {
    if (ch.status !== 'active') continue;
    // Perf (F24): an unaffordable level fails planLevel with 'cantAfford' only after its growth geometry; check the cost first.
    const c0 = levelCost(s, ch);
    if (!c0 || !canAfford(s, c0)) continue;
    const P = planLevel(s, d, ch, null);
    if (P.reason) continue;
    const f = num(P.cost.food);
    const so = num(P.cost.soil);
    if (!best || f < best.f || (f === best.f && (so < best.so || (so === best.so && ch.uid < best.ch.uid)))) best = { ch, P, f, so };
  }
  if (!best) return false;
  return doLevel(s, d, best.ch, best.P, env);
}

/**
 * [x] WP6 ev_mole_tunnel: a diagonal (staircase) run of 6–12 SOIL or TUNNEL cells, never chamber, stone, water or
 * cache cells, rows 1–60, chosen with the main RNG (s as holder); SOIL cells become TUNNEL (free: no work, no soil),
 * rev++, cellDug per changed cell; the nearest unfound cache not yet visible (else the nearest unfound) gets
 * hinted = true. Returns { cells, hint } (hint = that cache's cell index or −1).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @returns {{ cells: number[], hint: number }}
 */
export function moleTunnel(s, d, env) {
  const nest = s.run.nest;
  const geo = ensureGeom(s, d);
  const cellsArr = nest.cells;
  const cacheCell = new Uint8Array(N);
  for (const c of nest.features.caches || []) if (c && !c.found && isCell(c.i)) cacheCell[c.i] = 1;
  let path = null;
  for (let t = 0; t < MOLE.attempts && !path; t++) {
    const len = randInt(s, MOLE.lenMin, MOLE.lenMax);
    const dx = randInt(s, 0, 1) ? 1 : -1;
    const dy = randInt(s, 0, 1) ? 1 : -1;
    let x = randInt(s, 0, COLS - 1);
    let y = randInt(s, MOLE.rowMin, MOLE.rowMax);
    const cand = [];
    let ok = true;
    for (let k = 0; k < len; k++) {
      if (x < 0 || x >= COLS || y < MOLE.rowMin || y > MOLE.rowMax) { ok = false; break; }
      const c = G.idx(x, y);
      const code = cellsArr[c];
      if ((code !== CELL.SOIL && code !== CELL.TUNNEL) || geo.chamberAt[c] >= 0 || cacheCell[c] || geo._backfill[c]) { ok = false; break; }
      cand.push(c);
      if (k % 2 === 0) x += dx;
      else y += dy;
    }
    if (ok && cand.length === len) path = cand;
  }
  const out = path || [];
  let changed = 0;
  for (const c of out) {
    if (cellsArr[c] === CELL.SOIL) {
      cellsArr[c] = CELL.TUNNEL;
      changed++;
      if (!(env && env.offline)) emit(env, 'cellDug', { i: c });
    }
  }
  if (changed) {
    nest.rev++;
    rebuild(s, d);
  }
  // Hint the nearest unfound cache (Chebyshev distance to the tunnel; to the main shaft top if no tunnel was dug).
  const ref = out.length ? out : [G.idx(GRID.mainCol, 0)];
  const visible = new Set(computeHints(s, d.nest));
  let best = null;
  for (const pass of [0, 1]) {
    for (const c of nest.features.caches || []) {
      if (!c || c.found || !isCell(c.i)) continue;
      if (pass === 0 && (c.hinted || visible.has(c.i))) continue;
      const cx = c.i % COLS;
      const cy = Math.floor(c.i / COLS);
      let dist = Infinity;
      for (const r of ref) dist = Math.min(dist, Math.max(Math.abs((r % COLS) - cx), Math.abs(Math.floor(r / COLS) - cy)));
      if (!best || dist < best.dist || (dist === best.dist && c.i < best.c.i)) best = { c, dist };
    }
    if (best) break;
  }
  if (best) {
    best.c.hinted = true;
    nest.rev++;
    rebuild(s, d);
  }
  return { cells: out.slice(), hint: best ? best.c.i : -1 };
}

// ------------------------------------------------------------------------------------------------------------------
// Command plans shared by validate / apply
// ------------------------------------------------------------------------------------------------------------------

function planTunnel(s, d, list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > N) return { reason: 'invalid' };
  const geo = G.getGeom(s, d);
  const cells = s.run.nest.cells;
  const seen = new Set();
  const soil = [];
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (!isCell(c)) return { reason: 'invalid' };
    if (seen.has(c)) return { reason: 'invalid:path' };
    seen.add(c);
    if (k > 0 && !adj4(list[k - 1], c)) return { reason: 'invalid:path' };
    if (geo.open[c]) continue;
    const code = cells[c];
    if (code === CELL.WATER) return { reason: 'blocked:water' };
    if (code === CELL.STONE && !G.hasResearch(s, 'acid_excavation')) return { reason: 'blocked:stone' };
    if (geo.chamberAt[c] >= 0) return { reason: 'blocked:chamber' };
    if (s.run.hardship === 'shallow_soil' && Math.floor(c / COLS) > DIG.shallowSoilRow) return { reason: 'hardship' };
    if (!G.isDiggable(s, c)) return { reason: 'blocked:layer' };
    soil.push(c);
  }
  const reach = (c) => geo.open[c] && geo.entDist[c] >= 0 && !geo._backfill[c];
  if (!reach(list[0]) && !G.neighbors4(list[0]).some(reach)) return { reason: 'invalid:start' };
  if (!soil.length) return { reason: 'invalid:empty' };
  if (s.run.nest.queue.length + 1 > queueLimit(s)) return { reason: 'queueFull' };
  return { reason: null, soil };
}

function planDigTo(s, d, cell) {
  if (!isCell(cell)) return { reason: 'invalid' };
  const geo = G.getGeom(s, d);
  const cells = s.run.nest.cells;
  if (geo.open[cell]) return { reason: 'invalid' };
  if (cells[cell] !== CELL.SOIL || geo.chamberAt[cell] >= 0 || geo._backfill[cell]) return { reason: 'blocked' };
  if (s.run.hardship === 'shallow_soil' && Math.floor(cell / COLS) > DIG.shallowSoilRow) return { reason: 'hardship' };
  if (!G.isDiggable(s, cell)) return { reason: 'blocked:layer' };
  const r = G.routeTo(s, d, [cell]);
  if (!r) return { reason: 'blocked:route' };
  if (s.run.nest.queue.length + 1 > queueLimit(s)) return { reason: 'queueFull' };
  return { reason: null, cells: [...r.cells, cell] };
}

/** Would removing these cells (plus pending backfill) disconnect a chamber or a queued job from every entrance? */
function disconnects(s, geo, list) {
  const nest = s.run.nest;
  const openAfter = Uint8Array.from(geo.open);
  for (const c of list) openAfter[c] = 0;
  for (const b of nest.backfill) if (b && isCell(b.i)) openAfter[b.i] = 0;
  const tops = [];
  for (const sh of nest.shafts) if (sh && sh.open && sh.col >= 0 && sh.col < COLS && openAfter[G.idx(sh.col, 0)]) tops.push(G.idx(sh.col, 0));
  const reach = G.bfs(openAfter, tops);
  for (const ch of nest.chambers) {
    const rc = G.rectCells(ch.x, ch.y, ch.w, ch.h);
    if (rc.some((c) => geo.open[c] && geo.entDist[c] >= 0) && !rc.some((c) => reach[c] >= 0)) return true;
  }
  for (const job of nest.queue) {
    let c = -1;
    for (let k = job.cur; k < job.cells.length; k++) if (isCell(job.cells[k]) && !geo.open[job.cells[k]]) { c = job.cells[k]; break; }
    if (c < 0) continue;
    const ns = G.neighbors4(c);
    const before = ns.some((n) => geo.open[n] && geo.entDist[n] >= 0);
    const after = ns.some((n) => reach[n] >= 0);
    if (before && !after) return true;
  }
  return false;
}

function planBackfill(s, d, list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > N) return 'invalid';
  const geo = G.getGeom(s, d);
  const cells = s.run.nest.cells;
  const seen = new Set();
  for (const c of list) {
    if (!isCell(c) || seen.has(c)) return 'invalid';
    seen.add(c);
  }
  for (const c of list) {
    if (geo.chamberAt[c] >= 0 || cells[c] === CELL.CHAMBER) return 'blocked:chamber';
    if (cells[c] !== CELL.TUNNEL) return 'invalid:cell';
    if (geo._shaft[c]) return 'blocked:shaft';
    if (geo._backfill[c]) return 'invalid:pending';
  }
  if (disconnects(s, geo, list)) return 'blocked';
  return null;
}

/**
 * [q] Backfill preview for a painted area (ARCHITECTURE §18 C98; the Backfill tool, DESIGN §7.3). Splits the cells of
 * `list` into those that can be backfilled together (`ok`, a valid `backfill` command as they are), those that cannot
 * (`bad`: { i, reason } with 'blocked:shaft' or 'blocked:disconnect') and those already being backfilled (`pending`).
 * Soil, chamber and other non-tunnel cells are ignored, so a rough rectangle over a tunnel network just works. When the
 * whole set would cut a chamber (or a queued job) off from every entrance, cells are kept greedily, deepest path
 * distance first, so dead-end stubs are filled and the cells a chamber still needs are flagged.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number[]} list cell indices (any order; duplicates and out-of-range values are skipped)
 * @returns {{ ok: number[], bad: Array<{ i: number, reason: string }>, pending: number[] }}
 */
export function backfillPreview(s, d, list) {
  const out = { ok: [], bad: [], pending: [] };
  if (!Array.isArray(list) || !list.length) return out;
  const geo = G.getGeom(s, d);
  const cells = s.run.nest.cells;
  const seen = new Set();
  const cand = [];
  for (const c of list) {
    if (!isCell(c) || seen.has(c)) continue;
    seen.add(c);
    if (cells[c] !== CELL.TUNNEL || geo.chamberAt[c] >= 0) continue;
    if (geo._backfill[c]) out.pending.push(c);
    else if (geo._shaft[c]) out.bad.push({ i: c, reason: 'blocked:shaft' });
    else cand.push(c);
  }
  if (!cand.length) return out;
  if (!disconnects(s, geo, cand)) {
    out.ok = cand;
    return out;
  }
  const key = (c) => (geo.entDist[c] >= 0 ? geo.entDist[c] : N + 1);
  cand.sort((a, b) => key(b) - key(a) || a - b);
  const acc = [];
  for (const c of cand) {
    acc.push(c);
    if (disconnects(s, geo, acc)) {
      acc.pop();
      out.bad.push({ i: c, reason: 'blocked:disconnect' });
    }
  }
  out.ok = acc;
  return out;
}

/**
 * Would backfilling the cells of `mask` (plus pending backfill) cut anything off (C121, the bulk check)? Everything
 * connected to an entrance now must stay connected: every chamber, the first undug cell of every queued job, every
 * planned blueprint chamber (an open cell in or next to its footprint), and every open shaft top still joins the main
 * shaft when it does now.
 */
function bulkCuts(s, geo, mask, planned) {
  const nest = s.run.nest;
  const openAfter = Uint8Array.from(geo.open);
  for (let i = 0; i < N; i++) if (mask[i]) openAfter[i] = 0;
  for (const b of nest.backfill) if (b && isCell(b.i)) openAfter[b.i] = 0;
  const tops = [];
  for (const sh of nest.shafts) if (sh && sh.open && sh.col >= 0 && sh.col < COLS && openAfter[G.idx(sh.col, 0)]) tops.push(G.idx(sh.col, 0));
  const reach = G.bfs(openAfter, tops);
  const main = G.idx(GRID.mainCol, 0);
  const reachMain = G.bfs(openAfter, openAfter[main] ? [main] : []);
  for (const sh of nest.shafts) {
    if (!sh || !sh.open || !(sh.col >= 0 && sh.col < COLS)) continue;
    const t = G.idx(sh.col, 0);
    if (geo.open[t] && geo.dist[t] >= 0 && reachMain[t] < 0) return true;
  }
  const was = (c) => geo.open[c] && geo.entDist[c] >= 0;
  for (const ch of nest.chambers) {
    const rc = G.rectCells(ch.x, ch.y, ch.w, ch.h);
    if (rc.some(was) && !rc.some((c) => reach[c] >= 0)) return true;
  }
  for (const job of nest.queue) {
    let c = -1;
    for (let k = job.cur; k < job.cells.length; k++) if (isCell(job.cells[k]) && !geo.open[job.cells[k]]) { c = job.cells[k]; break; }
    if (c < 0) continue;
    const ns = G.neighbors4(c);
    if (ns.some(was) && !ns.some((n) => reach[n] >= 0)) return true;
  }
  for (const p of planned) {
    const around = [...G.rectCells(p.x, p.y, p.w, p.h), ...G.perimeter(p)];
    if (around.some(was) && !around.some((c) => reach[c] >= 0)) return true;
  }
  return false;
}

/**
 * [q] Every open tunnel cell that can be backfilled without cutting anything off (C121, "Backfill all unneeded
 * tunnels"): not a chamber or shaft cell, not already backfilling, not inside a planned blueprint chamber, and, taken
 * together, keeping every chamber, queued job, planned blueprint chamber and entrance connected (bulkCuts). Greedy,
 * deepest path distance first (dead-end stubs go first).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number[]} cell indices, ascending
 */
export function unneededTunnels(s, d) {
  const geo = G.getGeom(s, d);
  const cells = s.run.nest.cells;
  const planned = plannedChambers(s);
  const inPlanned = new Uint8Array(N);
  for (const p of planned) for (const c of G.rectCells(p.x, p.y, p.w, p.h)) inPlanned[c] = 1;
  const cand = [];
  for (let i = 0; i < N; i++) {
    if (cells[i] !== CELL.TUNNEL || geo.chamberAt[i] >= 0 || geo._shaft[i] || geo._backfill[i] || inPlanned[i]) continue;
    cand.push(i);
  }
  if (!cand.length) return [];
  const mask = new Uint8Array(N);
  for (const c of cand) mask[c] = 1;
  if (!bulkCuts(s, geo, mask, planned)) return cand;
  mask.fill(0);
  const key = (c) => (geo.entDist[c] >= 0 ? geo.entDist[c] : N + 1);
  cand.sort((a, b) => key(b) - key(a) || a - b);
  const out = [];
  for (const c of cand) {
    mask[c] = 1;
    if (bulkCuts(s, geo, mask, planned)) mask[c] = 0;
    else out.push(c);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Remove pending blueprint chambers (C120): `all`, or the one whose top-left cell is `cell`. Their waiting blueprint
 * tunnels go too when a group of them (4-connected) leads only to removed chambers. Returns the number removed.
 */
function removePlanned(s, cell, all) {
  const nest = s.run.nest;
  const pend = Array.isArray(nest.bpPending) ? nest.bpPending : [];
  if (all) {
    const n = pend.length;
    nest.bpPending = [];
    nest.bpTunnels = [];
    return n;
  }
  const j = pend.findIndex((sp) => sp && isInt(sp.x) && isInt(sp.y) && G.idx(sp.x, sp.y) === cell);
  if (j < 0) return 0;
  const gone = pend[j];
  nest.bpPending = pend.filter((_, k) => k !== j);
  const tunnels = Array.isArray(nest.bpTunnels) ? nest.bpTunnels : [];
  if (!nest.bpPending.length) { nest.bpTunnels = []; return 1; }
  if (!tunnels.length || gone.float || !CHAMBERS[gone.type]) return 1;
  const rectOf = (sp) => { const fp = G.footprint(sp.type, 1); return { x: sp.x, y: sp.y, w: fp.w, h: fp.h }; };
  const touch = (r, m) => { for (const c of [...G.rectCells(r.x, r.y, r.w, r.h), ...G.perimeter(r)]) m[c] = 1; return m; };
  const goneM = touch(rectOf(gone), new Uint8Array(N));
  const otherM = new Uint8Array(N);
  for (const sp of nest.bpPending) {
    if (!sp || sp.float || !CHAMBERS[sp.type] || !isInt(sp.x) || !isInt(sp.y)) continue;
    touch(rectOf(sp), otherM);
  }
  const inT = new Uint8Array(N);
  for (const c of tunnels) if (isCell(c)) inT[c] = 1;
  const seen = new Uint8Array(N);
  const drop = new Uint8Array(N);
  for (const c0 of tunnels) {
    if (!isCell(c0) || seen[c0]) continue;
    const comp = [];
    const stack = [c0];
    seen[c0] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      for (const n of G.neighbors4(c)) if (inT[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
    if (comp.some((c) => goneM[c]) && !comp.some((c) => otherM[c])) for (const c of comp) drop[c] = 1;
  }
  nest.bpTunnels = tunnels.filter((c) => !drop[c]);
  return 1;
}

/**
 * Blueprint snapshot of the current layout (chambers except the original Royal Chamber; tunnel cells off-shaft) and,
 * C119, the original Royal Chamber's top-left corner (royal: { x, y }; its L1 footprint is pre-dug there next run).
 */
function snapshotBlueprint(s, d, name) {
  const geo = ensureGeom(s, d);
  const nest = s.run.nest;
  const chambers = nest.chambers.filter((ch) => ch.uid !== 1)
    .map((ch) => ({ type: ch.type, x: ch.x, y: ch.y, w: ch.w, h: ch.h, level: ch.level }));
  const tunnels = [];
  for (let i = 0; i < N; i++) if (nest.cells[i] === CELL.TUNNEL && geo.chamberAt[i] < 0 && geo._shaft[i] !== 1) tunnels.push(i);
  const r = nest.chambers.find((ch) => ch.uid === 1 && ch.type === 'royal_chamber');
  return r ? { name, chambers, tunnels, royal: { x: r.x, y: r.y } } : { name, chambers, tunnels };
}

// ------------------------------------------------------------------------------------------------------------------
// Command handlers (ARCHITECTURE §9)
// ------------------------------------------------------------------------------------------------------------------

function validSlot(s, slot) {
  return isInt(slot) && slot >= 0 && slot < blueprintSlots(s);
}

/** Nest command handlers (validate is pure; apply mutates). */
export const handlers = {
  /** placeChamber { chamber, x, y, route?, shaftCol? } */
  placeChamber: {
    validate(s, d, cmd) {
      if (typeof cmd.chamber !== 'string' || !CHAMBERS[cmd.chamber]) return 'invalid';
      if (!isInt(cmd.x) || !isInt(cmd.y)) return 'invalid';
      if (cmd.route !== undefined && cmd.route !== null && !Array.isArray(cmd.route)) return 'invalid:route';
      if (cmd.shaftCol !== undefined && cmd.shaftCol !== null && !isInt(cmd.shaftCol)) return 'invalid:shaftCol';
      return planPlacement(s, d, cmd.chamber, cmd.x, cmd.y, { route: cmd.route ?? null, shaftCol: cmd.shaftCol ?? null }).reason;
    },
    apply(s, d, cmd, env) {
      const P = planPlacement(s, d, cmd.chamber, cmd.x, cmd.y, { route: cmd.route ?? null, shaftCol: cmd.shaftCol ?? null });
      if (P.reason) return;
      executePlacement(s, d, cmd.chamber, P, env, false);
    },
  },

  /** levelChamber { uid, dir? } */
  levelChamber: {
    validate(s, d, cmd) {
      if (!isInt(cmd.uid)) return 'invalid';
      if (cmd.dir !== undefined && cmd.dir !== null && !DIRS.has(cmd.dir)) return 'invalid:dir';
      const f = findChamber(s, cmd.uid);
      if (!f) return 'notFound';
      return planLevel(s, d, f.ch, cmd.dir ?? null).reason;
    },
    apply(s, d, cmd, env) {
      const f = findChamber(s, cmd.uid);
      if (!f) return;
      const P = planLevel(s, d, f.ch, cmd.dir ?? null);
      if (P.reason) return;
      doLevel(s, d, f.ch, P, env);
    },
  },

  /** relocateChamber { uid, x, y, route? } */
  relocateChamber: {
    validate(s, d, cmd) {
      if (!isInt(cmd.uid) || !isInt(cmd.x) || !isInt(cmd.y)) return 'invalid';
      if (cmd.route !== undefined && cmd.route !== null && !Array.isArray(cmd.route)) return 'invalid:route';
      const f = findChamber(s, cmd.uid);
      if (!f) return 'notFound';
      return planPlacement(s, d, f.ch.type, cmd.x, cmd.y, { route: cmd.route ?? null, relocateUid: cmd.uid }).reason;
    },
    apply(s, d, cmd, env) {
      const f = findChamber(s, cmd.uid);
      if (!f) return;
      const P = planPlacement(s, d, f.ch.type, cmd.x, cmd.y, { route: cmd.route ?? null, relocateUid: cmd.uid });
      if (P.reason) return;
      executeRelocation(s, d, P, env);
    },
  },

  /** demolishChamber { uid }: refund 50 % of that instance's placement food; cells become tunnel. */
  demolishChamber: {
    validate(s, d, cmd) {
      if (!isInt(cmd.uid)) return 'invalid';
      const f = findChamber(s, cmd.uid);
      if (!f) return 'notFound';
      if (f.ch.type === 'royal_chamber' && (f.ch.uid === 1 || countType(s, 'royal_chamber') <= 1)) return 'blocked';
      if (f.ch.status !== 'active') return 'busy';
      return null;
    },
    apply(s, d, cmd) {
      const f = findChamber(s, cmd.uid);
      if (!f) return;
      const nest = s.run.nest;
      const ch = f.ch;
      const def = CHAMBERS[ch.type];
      if (def && def.place && def.place.food > 0) {
        const food = def.place.food * def.placeGrowth ** ch.k * edictCostMult(s) * (ch.blueprint ? DIG.blueprintPlaceMult : 1);
        refund(s, d, { food }, DIG.demolishRefund);
      }
      for (const c of G.rectCells(ch.x, ch.y, ch.w, ch.h)) if (nest.cells[c] === CELL.CHAMBER) nest.cells[c] = CELL.TUNNEL;
      nest.chambers.splice(f.j, 1);
      renumberK(s, ch.type);
      nest.rev++;
      rebuild(s, d);
    },
  },

  /** digTunnel { cells }: a contiguous path starting next to an open cell. */
  digTunnel: {
    validate(s, d, cmd) {
      return planTunnel(s, d, cmd.cells).reason;
    },
    apply(s, d, cmd) {
      const P = planTunnel(s, d, cmd.cells);
      if (P.reason) return;
      const nest = s.run.nest;
      nest.queue.push({ uid: nest.nextUid++, kind: 'tunnel', chamber: 0, cells: P.soil, cur: 0, prog: 0, paidFood: 0, blueprint: false });
      nest.rev++;
      rebuild(s, d);
    },
  },

  /** digTo { cell }: auto-routed tunnel to a cell (cache hints), digging the cell itself. */
  digTo: {
    validate(s, d, cmd) {
      return planDigTo(s, d, cmd.cell).reason;
    },
    apply(s, d, cmd) {
      const P = planDigTo(s, d, cmd.cell);
      if (P.reason) return;
      const nest = s.run.nest;
      nest.queue.push({ uid: nest.nextUid++, kind: 'tunnel', chamber: 0, cells: P.cells, cur: 0, prog: 0, paidFood: 0, blueprint: false });
      nest.rev++;
      rebuild(s, d);
    },
  },

  /** backfill { cells }: tunnel cells refill (become SOIL) after 10 s; refused if it disconnects anything. */
  backfill: {
    validate(s, d, cmd) {
      return planBackfill(s, d, cmd.cells);
    },
    apply(s, d, cmd) {
      if (planBackfill(s, d, cmd.cells)) return;
      const nest = s.run.nest;
      for (const c of cmd.cells) nest.backfill.push({ i: c, t: DIG.backfillSec });
      nest.rev++;
      rebuild(s, d);
    },
  },

  /** reorderQueue { uid, to } */
  reorderQueue: {
    validate(s, d, cmd) {
      if (!isInt(cmd.uid) || !isInt(cmd.to)) return 'invalid';
      const f = findJob(s, cmd.uid);
      if (!f) return 'notFound';
      if (cmd.to < 0 || cmd.to >= s.run.nest.queue.length) return 'invalid';
      return null;
    },
    apply(s, d, cmd) {
      const f = findJob(s, cmd.uid);
      if (!f) return;
      const q = s.run.nest.queue;
      q.splice(f.j, 1);
      q.splice(Math.max(0, Math.min(q.length, cmd.to)), 0, f.job);
      s.run.nest.rev++;
      rebuild(s, d);
    },
  },

  /**
   * cancelJob { uid }: refund paidFood 100 %; dug cells stay dug (as tunnel). Cancelling a new chamber removes it;
   * cancelling a growth reverts the footprint.
   * ARCH-R: relocation and shaft jobs cannot be cancelled ('blocked'); level-up soil and extras are not refunded
   * (the DigJob only records paidFood).
   */
  cancelJob: {
    validate(s, d, cmd) {
      if (!isInt(cmd.uid)) return 'invalid';
      const f = findJob(s, cmd.uid);
      if (!f) return 'notFound';
      if (f.job.kind === 'relocate' || f.job.kind === 'shaft') return 'blocked';
      // C117: a pocket relocation cannot be cancelled half-way (its water is already moving); a drain can.
      if (f.job.kind === 'drain' && f.job.to) return 'blocked';
      return null;
    },
    apply(s, d, cmd) {
      const f = findJob(s, cmd.uid);
      if (!f) return;
      const nest = s.run.nest;
      const job = f.job;
      nest.queue.splice(f.j, 1);
      if (job.paidFood > 0) refund(s, d, { food: job.paidFood }, DIG.cancelRefund);
      // C117: a cancelled drain refunds the soil of the cells still under water.
      if (job.kind === 'drain' && num(job.paidSoil) > 0 && Array.isArray(job.drain) && job.drain.length) {
        const wet = job.drain.filter((c) => isCell(c) && nest.cells[c] === CELL.WATER).length;
        if (wet > 0) refund(s, d, { soil: job.paidSoil * wet / job.drain.length }, DIG.cancelRefund);
      }
      const fc = job.chamber ? findChamber(s, job.chamber) : null;
      if (job.kind === 'chamber' && fc) {
        const ch = fc.ch;
        for (const c of G.rectCells(ch.x, ch.y, ch.w, ch.h)) if (nest.cells[c] === CELL.CHAMBER) nest.cells[c] = CELL.TUNNEL;
        nest.chambers.splice(fc.j, 1);
        renumberK(s, ch.type);
        // A Nuptial Chamber's pending exit shaft goes with it.
        for (let k = nest.queue.length - 1; k >= 0; k--) {
          const q = nest.queue[k];
          if (q.kind !== 'shaft' || q.chamber !== ch.uid) continue;
          let col = -1;
          for (const c of q.cells) if (isCell(c) && c < COLS) { col = c; break; }
          nest.queue.splice(k, 1);
          const si = nest.shafts.findIndex((x) => x && !x.open && x.col === col);
          if (si >= 0) nest.shafts.splice(si, 1);
        }
      } else if (job.kind === 'grow' && fc) {
        const ch = fc.ch;
        const fp = G.footprint(ch.type, ch.level);
        const dw = ch.w - fp.w;
        const dh = ch.h - fp.h;
        const jobSet = new Set(job.cells);
        let old = null;
        // C97: a growth job remembers the footprint it grew from (older saves fall back to the footprint formula).
        const jf = job.from;
        if (jf && isInt(jf.x) && isInt(jf.y) && isInt(jf.w) && isInt(jf.h) && jf.w > 0 && jf.h > 0 && jf.w <= ch.w && jf.h <= ch.h
          && jf.x >= ch.x && jf.y >= ch.y && jf.x + jf.w <= ch.x + ch.w && jf.y + jf.h <= ch.y + ch.h) old = { x: jf.x, y: jf.y, w: jf.w, h: jf.h };
        for (const ox of [ch.x, ch.x + dw]) {
          for (const oy of [ch.y, ch.y + dh]) {
            if (old) break;
            const r = { x: ox, y: oy, w: fp.w, h: fp.h };
            if (!G.rectCells(r.x, r.y, r.w, r.h).some((c) => jobSet.has(c))) old = r;
          }
        }
        if (!old) old = { x: ch.x, y: ch.y, w: fp.w, h: fp.h };
        for (const c of G.rectCells(ch.x, ch.y, ch.w, ch.h)) {
          if (!G.inRect(old, c) && nest.cells[c] === CELL.CHAMBER) nest.cells[c] = CELL.TUNNEL;
        }
        ch.x = old.x;
        ch.y = old.y;
        ch.w = old.w;
        ch.h = old.h;
        ch.status = 'active';
        ch.target = ch.level;
      }
      nest.rev++;
      rebuild(s, d);
    },
  },

  /** helpDig {}: click; +5 + 3 % of W work to the first job and the same amount of soil (DESIGN §7.2). */
  helpDig: {
    validate(s, d, cmd) {
      if (s.run.hardship === 'claustral_founding') return 'hardship';
      if (!s.run.nest.queue.length) return 'invalid';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!consumeClick(s)) return;
      const amount = DIG.helpFlat + DIG.helpFracW * Math.max(0, num(d.stats && d.stats.digW));
      ensureGeom(s, d);
      const left = digWork(s, d, amount, env, true);
      if (left > 0) s.run.nest.maint = Math.min(CLAMP_MAX, num(s.run.nest.maint) + left);
      grant(s, d, 'soil', amount);
      ensureGeom(s, d);
      fillQueueInfo(s, d);
    },
  },

  /**
   * saveBlueprint { slot, name? }: needs ancestral_blueprint (or blueprint_memory); 1 slot, 5 with blueprint_memory.
   * ARCH-R: blueprint_memory alone also enables blueprints (it is "Save 5 layouts").
   */
  saveBlueprint: {
    validate(s, d, cmd) {
      if (!blueprintsAllowed(s)) return 'locked';
      if (!validSlot(s, cmd.slot)) return 'invalid';
      if (cmd.name !== undefined && cmd.name !== null && typeof cmd.name !== 'string') return 'invalid';
      return null;
    },
    apply(s, d, cmd) {
      const name = typeof cmd.name === 'string' && cmd.name.trim() ? cmd.name.trim().slice(0, NAME_MAX) : 'Layout ' + (cmd.slot + 1);
      const list = s.era.blueprints;
      while (list.length < cmd.slot) list.push(null);
      list[cmd.slot] = snapshotBlueprint(s, d, name);
    },
  },

  /** loadBlueprint { slot }: make it the active blueprint (queued at the next run start). */
  loadBlueprint: {
    validate(s, d, cmd) {
      if (!blueprintsAllowed(s)) return 'locked';
      if (!validSlot(s, cmd.slot)) return 'invalid';
      if (!s.era.blueprints[cmd.slot]) return 'notFound';
      return null;
    },
    apply(s, d, cmd) {
      s.era.activeBlueprint = cmd.slot;
    },
  },

  /** deleteBlueprint { slot } */
  deleteBlueprint: {
    validate(s, d, cmd) {
      if (!blueprintsAllowed(s)) return 'locked';
      if (!isInt(cmd.slot) || cmd.slot < 0 || cmd.slot >= s.era.blueprints.length) return 'invalid';
      if (!s.era.blueprints[cmd.slot]) return 'notFound';
      return null;
    },
    apply(s, d, cmd) {
      const list = s.era.blueprints;
      list[cmd.slot] = null;
      while (list.length && !list[list.length - 1]) list.pop();
      if (s.era.activeBlueprint === cmd.slot) s.era.activeBlueprint = -1;
    },
  },
  /** cancelPlanned { cell?, all? } (C120): drop a pending blueprint chamber (top-left cell), or all of them. */
  cancelPlanned: {
    validate(s, d, cmd) {
      const pend = Array.isArray(s.run.nest.bpPending) ? s.run.nest.bpPending : [];
      if (cmd.all !== undefined && cmd.all !== null && typeof cmd.all !== 'boolean') return 'invalid';
      if (cmd.all === true) return pend.length ? null : 'notFound';
      if (!isCell(cmd.cell)) return 'invalid';
      return pend.some((sp) => sp && isInt(sp.x) && isInt(sp.y) && G.idx(sp.x, sp.y) === cmd.cell) ? null : 'notFound';
    },
    apply(s, d, cmd) {
      removePlanned(s, cmd.cell, cmd.all === true);
      s.run.nest.rev++;
      rebuild(s, d);
    },
  },

  /** backfillUnneeded {} (C121): backfill (free, 10 s) every tunnel cell nothing needs (unneededTunnels). */
  backfillUnneeded: {
    validate(s, d) {
      return unneededTunnels(s, d).length ? null : 'invalid:empty';
    },
    apply(s, d) {
      const list = unneededTunnels(s, d);
      if (!list.length) return;
      const nest = s.run.nest;
      for (const c of list) nest.backfill.push({ i: c, t: DIG.backfillSec });
      nest.rev++;
      rebuild(s, d);
    },
  },

  /** drainPocket { pocket } (C117, drainage): queue draining a revealed water pocket (soil paid now). */
  drainPocket: {
    validate(s, d, cmd) {
      return planPocket(s, d, cmd.pocket, null).reason;
    },
    apply(s, d, cmd) {
      const P = planPocket(s, d, cmd.pocket, null);
      if (!P.reason) executePocket(s, d, P, null);
    },
  },

  /** relocatePocket { pocket, x, y } (C117, drainage): queue moving a water pocket to a same-size soil spot. */
  relocatePocket: {
    validate(s, d, cmd) {
      if (!isInt(cmd.x) || !isInt(cmd.y)) return 'invalid';
      return planPocket(s, d, cmd.pocket, { x: cmd.x, y: cmd.y }).reason;
    },
    apply(s, d, cmd) {
      const to = { x: cmd.x, y: cmd.y };
      const P = planPocket(s, d, cmd.pocket, to);
      if (!P.reason) executePocket(s, d, P, to);
    },
  },

  /** growRoot { col } (C118, root_cultivation): pay and start a cultivated root down column col. */
  growRoot: {
    validate(s, d, cmd) {
      return planRoot(s, d, cmd.col).reason;
    },
    apply(s, d, cmd) {
      const P = planRoot(s, d, cmd.col);
      if (P.reason || !spend(s, P.cost)) return;
      const nest = s.run.nest;
      if (!Array.isArray(nest.features.roots)) nest.features.roots = [];
      nest.features.roots.push({ col: cmd.col, y0: P.y0, y1: P.y0, own: true, to: P.y1, prog: 0 });
      nest.rev++;
      rebuild(s, d);
    },
  },

};
