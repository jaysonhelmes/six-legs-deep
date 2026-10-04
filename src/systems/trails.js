// Trails: routing (A*), strength, escort and worker allocation, the per-trail yield formula into the ledger, finite-stock
// depletion, loose foraging, pheromone abilities (Mark, Rally, Frenzy, Mass Recruit, hive_mind auto-Mark).
// Owner: WP4. Contract: ARCHITECTURE §8.3 (trails.js), §5 (d.surface.trails, d.ledger labels); DESIGN §8.4, §8.5, §12.1, §21.4.

import { TRAIL, ABILITIES, TERRAIN, TERRAIN_ORDER, TERRITORY } from '../data/surface.js';
import { SOURCES } from '../data/sources.js';
import { RESEARCH } from '../data/research.js';
import { HARDSHIPS, SITES } from '../data/prestige.js';
import { GEOM } from '../data/strata.js';
import { LOOSE_FORAGE } from '../data/jobs.js';
import { SEASON_MODS } from '../data/seasons.js';
import { adultsTotal } from '../core/state.js';
import { canAfford, spend } from '../core/wallet.js';
import { addEffect, removeEffect, effectMult } from '../core/effects.js';
import { HEX_COUNT, hexPath, ringOf, neighbors, countInRadius } from '../core/hex.js';
import { clampNum } from '../core/math.js';
import * as surface from './surface.js';        // moveCost, removeSource, trailSlots/dNavFor/slopeFor/queueEvent/flushEvents (WP4)
import * as population from './population.js';  // killAdults [x]
import * as seasons from './seasons.js';        // seasonAt [q]

const POOLS = Object.freeze(['forager', 'herder', 'leafcutter']);
const PRIMARY = Object.freeze({ forager: 'food', herder: 'honeydew', leafcutter: 'leaves', lycaenid: 'honeydew' });
const WAYPOINT_MAX = 32;   // input sanity bound for waypoint lists (not a balance number)

// ------------------------------------------------------------------------------------------------------------------
// Small private readers
// ------------------------------------------------------------------------------------------------------------------

/** fx value of a data-table entry, or `fallback` (neutral) when the owning package's table does not carry it. */
function fxOf(table, id, key, fallback) {
  const e = table && table[id];
  const v = e && e.fx ? e.fx[key] : undefined;
  return v === undefined || v === null ? fallback : v;
}
const owns = (s, id) => !!(s.run.research && s.run.research[id]);
const achieved = (s, id) => !!s.meta.achievements && s.meta.achievements[id] !== undefined && s.meta.achievements[id] !== null;
const unlocked = (s, key) => !!(s.run.unlocked && s.run.unlocked[key]);
const isHex = (h) => Number.isInteger(h) && h >= 0 && h < HEX_COUNT;
const num = (x, fb = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fb);

function sourceByUid(s, uid) {
  for (const src of s.run.surface.sources) if (src.uid === uid) return src;
  return null;
}
function trailByUid(s, uid) {
  if (!Number.isInteger(uid)) return null;
  for (const t of s.run.surface.trails) if (t.uid === uid) return t;
  return null;
}
/** A source can be a trail target: revealed, awake, sized (C34) and with a trail job. */
function targetable(s, src) {
  const def = SOURCES[src.type];
  return !!(def && def.job && s.run.surface.revealed[src.hex] && !(src.data && (src.data.dormant || src.data.unsized)));
}

/** S_max = 100 (150 persistent_trails) + 5 with ach_highway. */
function sMaxFor(s) {
  const base = owns(s, 'persistent_trails') ? fxOf(RESEARCH, 'persistent_trails', 'sMax', TRAIL.sMax) : TRAIL.sMax;
  return base + (achieved(s, 'ach_highway') ? TRAIL.achSMax : 0);
}
/** Evaporation half-life: 45 s (90 s persistent_trails). */
function tHalfFor(s) {
  return owns(s, 'persistent_trails') ? fxOf(RESEARCH, 'persistent_trails', 'tHalf', TRAIL.tHalf) : TRAIL.tHalf;
}
/** Rise speed-up while S < S_eq: ×2 double_bridge, ×1.1 ach_double_bridge. */
function riseFor(s) {
  return (owns(s, 'double_bridge') ? fxOf(RESEARCH, 'double_bridge', 'rise', 1) : 1) * (achieved(s, 'ach_double_bridge') ? TRAIL.achRise : 1);
}
/** Path-length multiplier: ×0.9 with double_bridge. */
function dMultFor(s) {
  return owns(s, 'double_bridge') ? fxOf(RESEARCH, 'double_bridge', 'dMult', 1) : 1;
}

// ------------------------------------------------------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------------------------------------------------------

/** Puddles block now? Pure from state (seasons.seasonAt), falling back to d.season when the season module is unavailable. */
function puddlesBlockNow(s, d) {
  try {
    const sa = seasons.seasonAt(s.meta, s.meta.season.t, {
      longSummer: s.cycle.edict === 'edict_of_long_summer', eternalWinter: s.run.hardship === 'eternal_winter' });
    if (sa && typeof sa.id === 'string') {
      const m = SEASON_MODS[sa.id];
      return m ? !!m.puddlesBlock : sa.id === 'spring';
    }
  } catch {
    // fall through
  }
  return !!(d && d.season && d.season.mods && d.season.mods.puddlesBlock);
}

/** Entering cost per hex: from d.surface (derived) or straight from terrain (live, valid before the next derive). */
function costArray(s, d, live) {
  const arr = new Array(HEX_COUNT);
  if (!live) {
    for (let i = 0; i < HEX_COUNT; i++) arr[i] = surface.moveCost(s, d, i);
    return arr;
  }
  const S = s.run.surface;
  const nIn = countInRadius(Math.max(0, Math.min(ringOf(HEX_COUNT - 1), num(S.radius))));
  const block = puddlesBlockNow(s, d);
  for (let i = 0; i < HEX_COUNT; i++) {
    const def = i < nIn ? TERRAIN[TERRAIN_ORDER[S.terrain[i]]] : null;
    if (!def) arr[i] = null;
    else if (block && Object.prototype.hasOwnProperty.call(def, 'springMove')) arr[i] = def.springMove ?? null;
    else arr[i] = def.move ?? null;
  }
  return arr;
}

/**
 * Route origin → waypoints → hex with A* (core/hex.hexPath); len = Σ move costs after the first hex × double_bridge.
 * WP4-internal (surface.moveAphids re-routes with it).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} origin
 * @param {number} hex
 * @param {number[]} [waypoints=[]]
 * @param {boolean} [live=false] route on terrain directly instead of d.surface.passable
 * @returns {{ path: number[], len: number } | null}
 */
export function routeTrail(s, d, origin, hex, waypoints = [], live = false) {
  if (!isHex(origin) || !isHex(hex)) return null;
  const arr = costArray(s, d, live);
  const fn = (i) => arr[i];
  const pts = [origin, ...(Array.isArray(waypoints) ? waypoints : []), hex];
  const path = [origin];
  let cost = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    if (pts[k] === pts[k + 1]) continue;
    const seg = hexPath(pts[k], pts[k + 1], fn);
    if (!seg) return null;
    for (let j = 1; j < seg.path.length; j++) path.push(seg.path[j]);
    cost += seg.cost;
  }
  return { path, len: cost * dMultFor(s) };
}

/** Single-pass multi-source Dijkstra over a cost array; root = the start hex each hex is reached from. */
function dijkstra(arr, starts) {
  const dist = new Float64Array(HEX_COUNT).fill(Infinity);
  const root = new Int16Array(HEX_COUNT).fill(-1);
  const hp = [];
  const hv = [];
  const push = (p, v) => {
    hp.push(p);
    hv.push(v);
    let i = hv.length - 1;
    while (i > 0) {
      const u = (i - 1) >> 1;
      if (hp[u] < hp[i] || (hp[u] === hp[i] && hv[u] <= hv[i])) break;
      [hp[u], hp[i]] = [hp[i], hp[u]];
      [hv[u], hv[i]] = [hv[i], hv[u]];
      i = u;
    }
  };
  const pop = () => {
    const top = [hp[0], hv[0]];
    const lp = hp.pop();
    const lv = hv.pop();
    if (hv.length > 0) {
      hp[0] = lp;
      hv[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < hv.length && (hp[l] < hp[m] || (hp[l] === hp[m] && hv[l] < hv[m]))) m = l;
        if (r < hv.length && (hp[r] < hp[m] || (hp[r] === hp[m] && hv[r] < hv[m]))) m = r;
        if (m === i) break;
        [hp[m], hp[i]] = [hp[i], hp[m]];
        [hv[m], hv[i]] = [hv[i], hv[m]];
        i = m;
      }
    }
    return top;
  };
  for (const o of starts) {
    if (!isHex(o) || dist[o] === 0) continue;
    dist[o] = 0;
    root[o] = o;
    push(0, o);
  }
  while (hv.length > 0) {
    const [dd, i] = pop();
    if (dd > dist[i]) continue;
    for (const n of neighbors(i)) {
      const c = arr[n];
      if (c === null || c === undefined) continue;
      const nd = dd + c;
      if (nd < dist[n]) {
        dist[n] = nd;
        root[n] = root[i];
        push(nd, n);
      }
    }
  }
  return { dist, root };
}

// ------------------------------------------------------------------------------------------------------------------
// Yield formula (ARCHITECTURE §8.3, DESIGN §8.5 / §12.1)
// ------------------------------------------------------------------------------------------------------------------

/** Haul h of a trail origin: main/nuptial entrance (or a trunk fork of one) → d.nest.agg.haulH, else 0.5 (C13). */
function originHaul(s, d, origin, depth = 0) {
  const S = s.run.surface;
  let found = false;
  let mainLike = false;
  for (const e of S.entrances) {
    if (!e || e.hex !== origin) continue;
    found = true;
    if (e.kind === 'main' || e.kind === 'nuptial') mainLike = true;
  }
  if (found) {
    if (!mainLike) return GEOM.satelliteHaul;
    const h = d && d.nest && d.nest.agg ? d.nest.agg.haulH : 0;
    return Math.max(0, num(h));
  }
  if (depth < 8) {
    for (const t of S.trails) {
      if (t.origin !== origin && Array.isArray(t.path) && t.path.includes(origin)) return originHaul(s, d, t.origin, depth + 1);
    }
  }
  return GEOM.satelliteHaul;
}

/**
 * Per-tick memo for yieldParts (F24 perf): slope, D_nav, sources by uid and origin hauls, which do not change while a
 * tick computes its trails' parts.
 */
function partsCtx(s, d) {
  const bySrc = new Map();
  for (const src of s.run.surface.sources) if (!bySrc.has(src.uid)) bySrc.set(src.uid, src);
  const hauls = new Map();
  return {
    slope: surface.slopeFor(s, d),
    dNav: surface.dNavFor(s),
    src: (uid) => bySrc.get(uid) || null,
    haul: (origin) => {
      if (!hauls.has(origin)) hauls.set(origin, originHaul(s, d, origin));
      return hauls.get(origin);
    },
  };
}

/** The n-independent parts of a trail's yield, or null when its source is gone. ctx: partsCtx (optional). */
function yieldParts(s, d, trail, ctx = null) {
  const src = ctx ? ctx.src(trail.src) : sourceByUid(s, trail.src);
  const def = src ? SOURCES[src.type] : null;
  if (!def) return null;
  const st = d.stats || {};
  const ch = {
    food: num(st.forage ? st.forage.total : 0),
    honeydew: num(st.honeydew),
    leaves: num(st.leaves),
    chitin: num(st.chitin),
  };
  const job = trail.job;
  const keys = Object.keys(def.y || {});
  const res = PRIMARY[job] && keys.includes(PRIMARY[job]) ? PRIMARY[job] : (keys[0] ?? null);
  const res2 = keys.find((k) => k !== res) ?? null;
  const len = Math.max(0, num(trail.len));
  if (job === 'lycaenid') {
    return { lyc: true, src, def, res, res2: null, y1: res ? def.y[res] : 0, ring: def.perRing ? ringOf(src.hex) : 1,
      ch1: res ? (ch[res] ?? 0) : 0, minEsc: def.minEscorts ?? 0, cap: def.cap || 0, cEff: 0, rich: 1, eff: 1, dEff: len };
  }
  const rich = 1 + (ctx ? ctx.slope : surface.slopeFor(s, d)) * (len - 1);
  const dEff = len + (ctx ? ctx.haul(trail.origin) : originHaul(s, d, trail.origin));
  const dNav = ctx ? ctx.dNav : surface.dNavFor(s);
  const eff = 1 / (1 + (dEff - 1) / dNav);
  const cap = def.capPerLevel ? def.capPerLevel * Math.max(1, num(src.level, 1)) : (def.cap || 0);
  const herd = job === 'herder' && owns(s, 'aphid_shepherding') ? fxOf(RESEARCH, 'aphid_shepherding', 'herderCap', 1) : 1;
  const cEff = cap * Math.max(1, adultsTotal(s) / TRAIL.cEffDiv) ** TRAIL.cEffExp * herd;
  const ownedMult = d.surface.owned[src.hex] ? TERRITORY.ownedSource : 1;
  let rivalHexes = 0;
  const path = Array.isArray(trail.path) ? trail.path : [];
  for (const h of path) if (isHex(h) && d.surface.rival[h] !== 0) rivalHexes++;
  const srcId = d.season ? d.season.srcId : null;
  let season = srcId === 'neutral' ? 1 : num(def.season ? def.season[srcId] : 1, 1);
  if (src.type === 'seed_patch' && srcId === 'autumn' && Array.isArray(s.run.landingTags) && s.run.landingTags.includes('site_seed_meadow')) {
    season = fxOf(SITES, 'site_seed_meadow', 'autumnSeed', season);
  }
  const sp = (d.meta && d.meta.sp) || {};
  let srcMult = effectMult(s, 'source_type', src.type) * effectMult(s, 'source', src.uid);
  if (s.run.hardship === 'barren_ground') srcMult *= fxOf(HARDSHIPS, 'barren_ground', 'yield', 1);
  if (def.job === 'forager' && def.y.food) srcMult *= num(sp.foodSource, 1);
  if (src.type === 'leaf_plant') srcMult *= num(sp.leafPlant, 1);
  const trunk = owns(s, 'trunk_trails') && path.length >= fxOf(RESEARCH, 'trunk_trails', 'minLen', Infinity)
    ? fxOf(RESEARCH, 'trunk_trails', 'mult', 1) : 1;
  return {
    lyc: false, src, def, res, res2,
    y1: res ? def.y[res] : 0, y2: res2 ? def.y[res2] : 0, ch1: res ? (ch[res] ?? 0) : 0, ch2: res2 ? (ch[res2] ?? 0) : 0,
    rich, dEff, eff, cap, cEff, ownedMult, rivalHexes, season, srcMult, trunk,
    rally: effectMult(s, 'forage_trail', trail.uid), unesc: effectMult(s, 'forage_unescorted'),
    contest: def.fx && def.fx.contest > 0 ? def.fx.contest : 1,
  };
}

/** Yield of a trail with n workers at strength S and `escorts` escorts. */
function yieldAt(p, n, S, escorts) {
  if (p.lyc) {
    const on = escorts >= p.minEsc;
    return { out: on ? clampNum(p.y1 * p.ring * p.ch1) : 0, out2: 0, nEff: 0, escorted: on };
  }
  const nn = Math.max(0, n);
  const nEff = p.cEff > 0 ? (nn <= p.cEff ? nn : p.cEff * (1 + Math.log(nn / p.cEff))) : 0;
  const escorted = escorts >= Math.ceil(nn / TRAIL.escortPer);
  const terr = p.ownedMult * (escorted ? 1 : Math.max(0, 1 - TRAIL.rivalHexPenalty * p.rivalHexes));
  const extra = p.rally * (escorted ? 1 : p.unesc);
  const base = p.rich * nEff * p.eff * (1 + S / TRAIL.sScale) * terr * p.season * p.srcMult * (escorted ? 1 : p.contest) * p.trunk * extra;
  return { out: clampNum(p.y1 * base * p.ch1), out2: clampNum(p.y2 * base * p.ch2), nEff, escorted };
}

/** Herder cap of the aphid colony behind a trail (8 × level, ×2 aphid_shepherding); Infinity for other trails. */
function herdCap(s, p) {
  if (!p || !p.def.capPerLevel || p.def.job !== 'herder') return Infinity;
  const mult = owns(s, 'aphid_shepherding') ? fxOf(RESEARCH, 'aphid_shepherding', 'herderCap', 1) : 1;
  return p.def.capPerLevel * Math.max(1, num(p.src.level, 1)) * mult;
}

/**
 * The pure per-trail yield formula (DESIGN §8.5, §12.1) for n workers at the trail's current S and escorts.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Trail} trail
 * @param {number} n workers
 * @returns {{ out: number, out2: number, nEff: number, cEff: number, eff: number, rich: number, dEff: number }}
 */
export function trailYield(s, d, trail, n) {
  const zero = { out: 0, out2: 0, nEff: 0, cEff: 0, eff: 0, rich: 1, dEff: 0 };
  if (!trail || typeof trail !== 'object') return zero;
  const p = yieldParts(s, d, trail);
  if (!p) return zero;
  const y = yieldAt(p, num(n), Math.max(0, num(trail.S)), Math.max(0, num(trail.escorts)));
  return { out: y.out, out2: y.out2, nEff: y.nEff, cEff: p.cEff, eff: p.eff, rich: p.rich, dEff: p.dEff };
}

// ------------------------------------------------------------------------------------------------------------------
// Tick
// ------------------------------------------------------------------------------------------------------------------

/** Ledger label of a trail output (ARCHITECTURE §5). */
function ledgerLabel(job, res) {
  if (res === 'honeydew') return job === 'herder' ? 'trails' : job === 'lycaenid' ? 'lycaenid' : 'flower';
  return 'trails';
}
function addLedger(d, res, label, v) {
  if (!(v > 0) || !d.ledger[res]) return;
  d.ledger[res][label] = clampNum((d.ledger[res][label] || 0) + v);
}

/** Σ escorts ≤ soldiers not in parties or battles (= garrison + current escorts, ≤ soldiers alive); largest remainder. */
function clampEscorts(s, d, T) {
  let sum = 0;
  for (const t of T) {
    t.escorts = Math.max(0, Math.floor(num(t.escorts)));
    sum += t.escorts;
  }
  const soldiers = Math.max(0, num(s.run.colony.adults.soldier));
  const gar = Math.max(0, num(d.combat && d.combat.garrison ? d.combat.garrison.soldier : 0));
  const avail = Math.floor(Math.min(soldiers, gar + sum));
  if (sum <= avail) return;
  const raw = T.map((t) => (t.escorts * avail) / sum);
  const fl = raw.map(Math.floor);
  let left = avail - fl.reduce((a, b) => a + b, 0);
  const order = raw.map((_, i) => i).sort((a, b) => (raw[b] - fl[b]) - (raw[a] - fl[a]) || a - b);
  for (let k = 0; k < order.length && left > 0; k++, left--) fl[order[k]] += 1;
  T.forEach((t, i) => { t.escorts = fl[i]; });
}

/**
 * yieldAt(p, n, S, escorts).out without building the result object: the allocator's inner loop (F24 perf). The
 * arithmetic is yieldAt's, operation for operation, so the numbers are identical.
 */
function yieldOut(p, n, S, escorts) {
  if (p.lyc) return escorts >= p.minEsc ? clampNum(p.y1 * p.ring * p.ch1) : 0;
  const nn = Math.max(0, n);
  const nEff = p.cEff > 0 ? (nn <= p.cEff ? nn : p.cEff * (1 + Math.log(nn / p.cEff))) : 0;
  const escorted = escorts >= Math.ceil(nn / TRAIL.escortPer);
  const terr = p.ownedMult * (escorted ? 1 : Math.max(0, 1 - TRAIL.rivalHexPenalty * p.rivalHexes));
  const extra = p.rally * (escorted ? 1 : p.unesc);
  const base = p.rich * nEff * p.eff * (1 + S / TRAIL.sScale) * terr * p.season * p.srcMult * (escorted ? 1 : p.contest) * p.trunk * extra;
  return clampNum(p.y1 * base * p.ch1);
}

/**
 * Clamp explicit workers per job pool, then auto-fill the free workers greedily (≤ TRAIL.allocChunks chunks).
 * Each chunk goes to the trail with the best marginal yield (unsaturated trails first, ties to the earlier trail).
 * Perf (F24): a trail's candidate (room, add, next yield, marginal) only changes when the chunk size changes, when it
 * took the last chunk, or when its source group's herder-cap room did, so candidates are cached in per-pool typed
 * arrays and refreshed for exactly those trails: the same choices and numbers as re-evaluating every trail every chunk.
 */
function allocate(s, T, parts) {
  const n = new Array(T.length).fill(0);
  for (let i = 0; i < T.length; i++) if (!parts[i] || parts[i].lyc || !POOLS.includes(T[i].job)) T[i].workers = 0;
  for (const job of POOLS) {
    const idx = [];
    for (let i = 0; i < T.length; i++) if (T[i].job === job && parts[i] && !parts[i].lyc) idx.push(i);
    if (idx.length === 0) continue;
    const avail = Math.max(0, num(s.run.colony.jobs[job]));
    let sum = 0;
    for (const i of idx) {
      T[i].workers = Math.max(0, num(T[i].workers));
      sum += T[i].workers;
    }
    if (sum > avail) for (const i of idx) T[i].workers = sum > 0 ? (T[i].workers * avail) / sum : 0;
    const groupSum = new Map();
    for (const i of idx) groupSum.set(parts[i].src.uid, (groupSum.get(parts[i].src.uid) || 0) + T[i].workers);
    for (const [uid, gsum] of groupSum) {
      const first = idx.find((i) => parts[i].src.uid === uid);
      const cap = herdCap(s, parts[first]);
      if (gsum > cap) {
        for (const i of idx) if (parts[i].src.uid === uid) T[i].workers = (T[i].workers * cap) / gsum;
        groupSum.set(uid, cap);
      }
    }
    let free = avail;
    for (const i of idx) {
      n[i] = T[i].workers;
      free -= n[i];
    }
    if (!(free > 1e-12)) continue;
    const chunk = free / TRAIL.allocChunks;
    // Per-pool arrays (j = position in idx); g = source group (one aphid colony shared by several herder trails).
    const m = idx.length;
    const grp = new Int32Array(m);
    const gUid = [];
    const gSum = [];
    const members = [];
    const cap = new Float64Array(m);
    const nj = new Float64Array(m);
    const cE = new Float64Array(m);
    const Sj = new Float64Array(m);
    const esc = new Array(m);
    const cur = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const i = idx[j];
      const uid = parts[i].src.uid;
      let g = gUid.indexOf(uid);
      if (g < 0) {
        g = gUid.length;
        gUid.push(uid);
        gSum.push(groupSum.get(uid));
        members.push([]);
      }
      grp[j] = g;
      members[g].push(j);
      cap[j] = herdCap(s, parts[i]);
      nj[j] = n[i];
      cE[j] = parts[i].cEff;
      Sj[j] = num(T[i].S);
      esc[j] = T[i].escorts;
      cur[j] = yieldOut(parts[i], nj[j], Sj[j], esc[j]);
    }
    const cAdd = new Float64Array(m);
    const cNext = new Float64Array(m);
    const cM = new Float64Array(m);
    const evalJ = (j, want) => {
      const room = cap[j] - gSum[grp[j]];
      if (!(room > 1e-12)) {
        cAdd[j] = 0;
        return;
      }
      const add = Math.min(want, room);
      const next = yieldOut(parts[idx[j]], nj[j] + add, Sj[j], esc[j]);
      cAdd[j] = add;
      cNext[j] = next;
      cM[j] = (next - cur[j]) / add;
    };
    let cWant = NaN;
    let remaining = free;
    for (let k = 0; k < TRAIL.allocChunks && remaining > 0; k++) {
      const want = k === TRAIL.allocChunks - 1 ? remaining : Math.min(chunk, remaining);
      if (want !== cWant) {
        cWant = want;
        for (let j = 0; j < m; j++) evalJ(j, want);
      }
      let best = -1;
      let bestM = -Infinity;
      let bestUnsat = false;
      for (let j = 0; j < m; j++) {
        if (!(cAdd[j] > 0)) continue;
        const mj = cM[j];
        const unsat = nj[j] < cE[j] && mj > 0;
        if ((unsat && !bestUnsat) || (unsat === bestUnsat && mj > bestM)) {
          best = j;
          bestM = mj;
          bestUnsat = unsat;
        }
      }
      if (best < 0) break;
      const bestAdd = cAdd[best];
      nj[best] += bestAdd;
      remaining -= bestAdd;
      cur[best] = cNext[best];
      const g = grp[best];
      gSum[g] += bestAdd;
      for (const j of members[g]) evalJ(j, want);
    }
    for (let j = 0; j < m; j++) n[idx[j]] = nj[j];
  }
  return n;
}

/**
 * Advance trails: cooldowns, escort and worker allocation, strength, yields into d.ledger, finite-stock depletion,
 * loose foraging, d.surface.trails, hive_mind auto-Mark. Writes raw (pre-efficiency) rates.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  surface.flushEvents(d, env);
  const S = s.run.surface;
  const step = dt > 0 ? dt : 0;
  for (const k of Object.keys(S.cd)) S.cd[k] = Math.max(0, num(S.cd[k]) - step);
  const T = S.trails;
  for (let i = T.length - 1; i >= 0; i--) {
    if (sourceByUid(s, T[i].src)) continue;
    const gone = T.splice(i, 1)[0];
    forgetTrail(s, gone.uid);
    env.emit('trailDeleted', { uid: gone.uid });
    S.rev += 1;
  }
  const ctx = partsCtx(s, d);
  const parts = T.map((t) => yieldParts(s, d, t, ctx));
  clampEscorts(s, d, T);
  const n = allocate(s, T, parts);

  // Strength: online exponential approach to S_eq (exact solution of dS/dt = (S_eq − S)·ln2/t½); offline at equilibrium.
  const sMax = sMaxFor(s);
  const k0 = Math.LN2 / tHalfFor(s);
  const rise = riseFor(s);
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const nn = n[i];
    const seq = nn > 0 ? (TRAIL.sScale * nn) / (nn + TRAIL.sEqK * Math.max(0, num(t.len))) : 0;
    let sv = Math.min(sMax, Math.max(0, num(t.S)));
    if (env.offline) sv = Math.min(seq, sMax);
    else if (step > 0) sv = seq + (sv - seq) * Math.exp(-k0 * (seq > sv ? rise : 1) * step);
    t.S = Math.min(sMax, Math.max(0, sv));
  }

  // Yields, then finite stocks drop by the food-equivalent output × econDt × eff (pro rata when the stock runs out).
  const ys = T.map((t, i) => (parts[i] ? yieldAt(parts[i], n[i], t.S, t.escorts) : null));
  const need = new Map();
  for (let i = 0; i < T.length; i++) {
    const p = parts[i];
    if (!p || !ys[i] || !p.def.stock || (p.src.data && p.src.data.unsized)) continue;
    need.set(p.src.uid, (need.get(p.src.uid) || 0) + ys[i].out);
  }
  // ARCH-R: stocks deplete over env.econDt (not dt) so the food taken equals the food the economy credits under Diapause.
  const span = num(env.eff, 1) * num(env.econDt, step);
  const scale = new Map();
  const depleted = [];
  for (const [uid, rate] of need) {
    const src = sourceByUid(s, uid);
    const stock = Math.max(0, num(src.stock));
    const amount = rate * span;
    if (span <= 0) {
      if (stock <= 0 && rate > 0) scale.set(uid, 0);
      continue;
    }
    if (amount <= 0) continue;
    if (amount >= stock) {
      scale.set(uid, amount > 0 ? stock / amount : 0);
      src.stock = 0;
      // ARCH-R: regrowing stocks (seed patches) are never removed at 0; they keep paying their regrowth (DESIGN §8.4).
      if (!(SOURCES[src.type].stock.regrow > 0)) depleted.push(uid);
    } else {
      src.stock = clampNum(stock - amount);
    }
  }

  const entries = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const p = parts[i];
    const y = ys[i];
    if (!p || !y) continue;
    const f = scale.has(p.src.uid) ? scale.get(p.src.uid) : 1;
    const out = y.out * f;
    const out2 = y.out2 * f;
    if (p.res) addLedger(d, p.res, ledgerLabel(t.job, p.res), out);
    if (p.res2) addLedger(d, p.res2, ledgerLabel(t.job, p.res2), out2);
    let safe = Array.isArray(t.path) && t.path.length > 0;
    if (safe) for (const h of t.path) if (!isHex(h) || d.surface.owned[h] === 0) { safe = false; break; }
    entries.push({ uid: t.uid, dEff: p.dEff, rich: p.rich, eff: p.eff, cEff: p.cEff, nEff: y.nEff, workers: n[i],
      sat: p.cEff > 0 ? n[i] / p.cEff : 0, res: p.res, out, res2: p.res2, out2, escorted: y.escorted, safe });
  }

  const hasForager = T.some((t) => t.job === 'forager');
  const loose = hasForager ? 0 : Math.max(0, num(s.run.colony.jobs.forager));
  d.surface.loose = loose;
  if (loose > 0) addLedger(d, 'food', 'loose', loose * LOOSE_FORAGE * num(d.stats.forage ? d.stats.forage.total : 0));

  for (const uid of depleted) {
    s.run.stats.sourcesDepleted += 1;
    surface.removeSource(s, d, uid, 'depleted', env);
  }
  const alive = new Set(T.map((t) => t.uid));
  d.surface.trails = entries.filter((e) => alive.has(e.uid));

  // hive_mind: auto-Mark the weakest trail whenever pheromone is full (online; respects the Mark cooldown).
  if (!env.offline && owns(s, 'hive_mind') && T.length > 0 && num(S.cd.mark) <= 0) {
    const cap = num(d.stats.pheromoneCap, Infinity);
    if (num(s.run.res.pheromone) >= cap && canAfford(s, ABILITIES.mark.cost)) {
      let best = 0;
      for (let i = 1; i < T.length; i++) if (T[i].S < T[best].S) best = i;
      applyMark(s, T[best], env);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Queries
// ------------------------------------------------------------------------------------------------------------------

/** Sources at a hex that can be trail targets; `srcUid` (optional) picks one of them. */
function targetSource(s, hex, srcUid) {
  const list = s.run.surface.sources.filter((x) => x.hex === hex && targetable(s, x));
  if (Number.isInteger(srcUid)) return list.find((x) => x.uid === srcUid) || null;
  return list[0] || null;
}

/** Validated waypoint list ([] when absent), or null when malformed. */
function waypointsOf(w) {
  if (w === undefined || w === null) return [];
  if (!Array.isArray(w) || w.length > WAYPOINT_MAX) return null;
  for (const h of w) if (!isHex(h)) return null;
  return w.slice();
}

/**
 * Trail preview for the drawing tool: route, d, d_eff, yield per worker (fresh trail, S = 0), capacity, c_eff.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} origin
 * @param {number} target hex holding the source
 * @param {number[]} [waypoints=[]]
 * @returns {{ ok: boolean, reason: (string|null), path: number[], len: number, dEff: number, perWorker: number, cap: number, cEff: number }}
 */
/** [q] True if a trail already leads to this source (C100: one trail per destination). */
export function hasTrailTo(s, srcUid) {
  return s.run.surface.trails.some((t) => t.src === srcUid);
}

export function previewTrail(s, d, origin, target, waypoints = []) {
  const res = { ok: false, reason: null, path: [], len: 0, dEff: 0, perWorker: 0, cap: 0, cEff: 0 };
  const wps = waypointsOf(waypoints);
  if (!isHex(origin) || !isHex(target) || wps === null) {
    res.reason = 'invalid';
    return res;
  }
  if (!trailOrigins(s, d).includes(origin)) {
    res.reason = 'invalid:origin';
    return res;
  }
  const src = targetSource(s, target);
  if (!src || src.hex === origin) {
    res.reason = 'invalid:target';
    return res;
  }
  if (hasTrailTo(s, src.uid)) {
    res.reason = 'duplicate';
    return res;
  }
  const r = routeTrail(s, d, origin, src.hex, wps);
  if (!r || r.path.length < 2) {
    res.reason = 'blocked';
    return res;
  }
  const def = SOURCES[src.type];
  const hypo = { uid: 0, origin, src: src.uid, path: r.path, len: r.len, job: def.job, workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] };
  const p = yieldParts(s, d, hypo);
  res.path = r.path;
  res.len = r.len;
  res.dEff = p.dEff;
  res.cap = p.cap;
  res.cEff = p.cEff;
  res.perWorker = yieldAt(p, 1, 0, 0).out;
  res.reason = s.run.surface.trails.length >= surface.trailSlots(s) ? 'noSlot:trail' : null;
  res.ok = res.reason === null;
  return res;
}

/**
 * Best untrailed sources for a job (bot / advisor / diegetic hint), by the output of a saturated trail at equilibrium
 * strength from the nearest origin. Routes on terrain directly, so it is valid right after a map is generated.
 * Each entry also carries the `origin` hex it was measured from (WP4 extension).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} [job='forager']
 * @returns {Array<{ src: number, hex: number, score: number, origin: number }>}
 */
export function bestTargets(s, d, job = 'forager') {
  const S = s.run.surface;
  const trailed = new Set(S.trails.map((t) => t.src));
  const cands = S.sources.filter((x) => !trailed.has(x.uid) && targetable(s, x) && SOURCES[x.type].job === job);
  if (cands.length === 0) return [];
  const groups = new Map();
  for (const o of trailOrigins(s, d)) {
    const h = originHaul(s, d, o);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(o);
  }
  const arr = costArray(s, d, true);
  const runs = [...groups.values()].map((starts) => dijkstra(arr, starts));
  const dm = dMultFor(s);
  const out = [];
  for (const src of cands) {
    let best = -1;
    let bestOrigin = -1;
    for (const run of runs) {
      const dist = run.dist[src.hex];
      if (!Number.isFinite(dist)) continue;
      const origin = run.root[src.hex];
      const len = dist * dm;
      const hypo = { uid: 0, origin, src: src.uid, path: [], len, job, workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] };
      const p = yieldParts(s, d, hypo);
      if (!p) continue;
      const nn = p.cEff;
      const seq = nn > 0 ? (TRAIL.sScale * nn) / (nn + TRAIL.sEqK * len) : 0;
      const score = yieldAt(p, nn, Math.min(seq, sMaxFor(s)), Infinity).out;
      if (score > best) {
        best = score;
        bestOrigin = origin;
      }
    }
    if (best >= 0) out.push({ src: src.uid, hex: src.hex, score: best, origin: bestOrigin });
  }
  out.sort((a, b) => (b.score - a.score) || (a.src - b.src));
  return out;
}

/**
 * Valid trail origins: entrance / outpost / satellite hexes, plus every trail hex with trunk_trails (forks).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number[]}
 */
export function trailOrigins(s, d) {
  const S = s.run.surface;
  const out = [];
  const seen = new Set();
  for (const e of S.entrances) {
    if (e && isHex(e.hex) && !seen.has(e.hex)) {
      seen.add(e.hex);
      out.push(e.hex);
    }
  }
  if (owns(s, 'trunk_trails')) {
    for (const t of S.trails) {
      if (!Array.isArray(t.path)) continue;
      for (const h of t.path) {
        if (isHex(h) && !seen.has(h)) {
          seen.add(h);
          out.push(h);
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// Cross-callable mutators [x]
// ------------------------------------------------------------------------------------------------------------------

/**
 * Drop per-trail effects of a deleted trail (its Rally). WP4-internal.
 * @param {import('../core/types.js').State} s
 * @param {number} uid
 */
export function forgetTrail(s, uid) {
  removeEffect(s, 'rally:' + uid);
}

/**
 * A raid hits a trail (WP5): kills workers via population.killAdults(…, { job: trail.job }), lowers S, reduces escorts.
 * Emits adultsDied {caste: 'minor', n, cause: 'raid'} on the next WP4 tick (no env here).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} uid
 * @param {{ workersLost?: number, sLoss?: number, escortsLost?: number }} [opts]
 * @returns {void}
 */
export function hitTrail(s, d, uid, { workersLost = 0, sLoss = 0, escortsLost = 0 } = {}) {
  const t = trailByUid(s, uid);
  if (!t) return;
  const wl = Math.max(0, num(workersLost));
  if (wl > 0 && POOLS.includes(t.job)) {
    const killed = Math.max(0, num(population.killAdults(s, d, 'minor', wl, 'raid', { job: t.job })));
    t.workers = Math.max(0, num(t.workers) - killed);
    if (killed > 0) surface.queueEvent(d, null, 'adultsDied', { caste: 'minor', n: killed, cause: 'raid' });
  }
  t.S = Math.max(0, num(t.S) - Math.max(0, num(sLoss)));
  t.escorts = Math.max(0, Math.floor(num(t.escorts) - Math.max(0, num(escortsLost))));
}

/**
 * Delete every trail whose path crosses one of the hexes (WP6 footstep). Returns the number deleted.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number[]} hexes
 * @returns {number}
 */
export function cutTrailsAt(s, d, hexes) {
  if (!Array.isArray(hexes)) return 0;
  const set = new Set(hexes.filter(isHex));
  const T = s.run.surface.trails;
  let n = 0;
  for (let i = T.length - 1; i >= 0; i--) {
    if (!Array.isArray(T[i].path) || !T[i].path.some((h) => set.has(h))) continue;
    const t = T.splice(i, 1)[0];
    forgetTrail(s, t.uid);
    surface.queueEvent(d, null, 'trailDeleted', { uid: t.uid });
    n++;
  }
  if (n > 0) s.run.surface.rev += 1;
  return n;
}

/**
 * Reset every trail's strength to 0 (WP6 rainstorm; the caller skips it with weather_sense).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {void}
 */
export function resetStrength(s, d) {
  for (const t of s.run.surface.trails) t.S = 0;
}

/**
 * Run start (WP7): draw trails from the nearest origin to the `count` best revealed untrailed food sources at
 * S = strengthFrac × S_max. Returns the number of trails created.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} count
 * @param {number} strengthFrac
 * @returns {number}
 */
export function autoDraw(s, d, count, strengthFrac) {
  const k = Math.max(0, Math.floor(num(count)));
  const frac = Math.min(1, Math.max(0, num(strengthFrac)));
  let made = 0;
  for (const tg of bestTargets(s, d, 'forager')) {
    if (made >= k) break;
    const origin = isHex(tg.origin) ? tg.origin : 0;
    if (createTrail(s, d, origin, tg.src, { S: frac * sMaxFor(s) }) > 0) made++;
  }
  return made;
}

/**
 * Create a trail (WP7 startRun crumb trail, autoDraw). Routes with hexPath over the terrain directly (stone impassable;
 * puddles impassable in spring per seasons.seasonAt), so it is valid before the next surface.derive. Takes a slot and a
 * uid from surface.nextUid. Returns the uid, or 0 if there is no route, no free slot or no valid target.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} originHex
 * @param {number} srcUid
 * @param {{ S?: number }} [opts]
 * @returns {number}
 */
export function createTrail(s, d, originHex, srcUid, { S = 0 } = {}) {
  const sf = s.run.surface;
  const src = sourceByUid(s, srcUid);
  const def = src ? SOURCES[src.type] : null;
  if (!def || !def.job || (src.data && (src.data.dormant || src.data.unsized))) return 0;
  if (sf.trails.length >= surface.trailSlots(s)) return 0;
  if (hasTrailTo(s, src.uid)) return 0;
  const r = routeTrail(s, d, originHex, src.hex, [], true);
  if (!r || r.path.length < 2) return 0;
  const uid = sf.nextUid++;
  sf.trails.push({ uid, origin: originHex, src: src.uid, path: r.path, len: r.len, job: def.job, workers: 0, escorts: 0,
    S: Math.min(sMaxFor(s), Math.max(0, num(S))), born: num(s.run.time), reroutes: [] });
  sf.rev += 1;
  surface.queueEvent(d, null, 'trailCreated', { uid });
  return uid;
}

// ------------------------------------------------------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------------------------------------------------------

/** Mark: +add strength (cap S_max), cooldown, abilityUsed. Caller has validated (or checked affordability). */
function applyMark(s, t, env) {
  const a = ABILITIES.mark;
  if (!spend(s, a.cost)) return;
  t.S = Math.min(sMaxFor(s), Math.max(0, num(t.S)) + a.add);
  s.run.surface.cd.mark = a.cd;
  env.emit('abilityUsed', { id: a.id, uid: t.uid });
}

/** Shared ability gate: unlock, then cooldown, then cost. `target` = reason from target checks (or null). */
function abilityGate(s, id, target) {
  const a = ABILITIES[id];
  if (!unlocked(s, a.unlock)) return 'locked';
  if (target) return target;
  if (a.cd && num(s.run.surface.cd[id]) > 0) return 'cooldown';
  if (!canAfford(s, a.cost)) return 'cantAfford';
  return null;
}

/** Player commands owned by trails.js (ARCHITECTURE §9). */
export const handlers = {
  /** drawTrail { origin, target, waypoints?, src? }: free, uses a trail slot (src: optional uid when a hex holds two sources). */
  drawTrail: {
    validate(s, d, cmd) {
      if (!isHex(cmd.origin) || !isHex(cmd.target)) return 'invalid';
      const wps = waypointsOf(cmd.waypoints);
      if (wps === null) return 'invalid:waypoints';
      if (!trailOrigins(s, d).includes(cmd.origin)) return 'invalid:origin';
      const src = targetSource(s, cmd.target, cmd.src);
      if (!src || src.hex === cmd.origin) return 'invalid:target';
      if (hasTrailTo(s, src.uid)) return 'duplicate'; // one trail per destination (C100)
      if (s.run.surface.trails.length >= surface.trailSlots(s)) return 'noSlot:trail';
      const r = routeTrail(s, d, cmd.origin, src.hex, wps);
      if (!r || r.path.length < 2) return 'blocked';
      return null;
    },
    apply(s, d, cmd, env) {
      const S = s.run.surface;
      const src = targetSource(s, cmd.target, cmd.src);
      const r = routeTrail(s, d, cmd.origin, src.hex, waypointsOf(cmd.waypoints));
      const uid = S.nextUid++;
      S.trails.push({ uid, origin: cmd.origin, src: src.uid, path: r.path, len: r.len, job: SOURCES[src.type].job,
        workers: 0, escorts: 0, S: 0, born: num(s.run.time), reroutes: [] });
      S.rev += 1;
      env.emit('trailCreated', { uid });
    },
  },

  /** rerouteTrail { uid, waypoints }: free re-route through waypoints; keeps workers, escorts and strength. */
  rerouteTrail: {
    validate(s, d, cmd) {
      const t = trailByUid(s, cmd.uid);
      if (!t) return Number.isInteger(cmd.uid) ? 'notFound' : 'invalid';
      const wps = waypointsOf(cmd.waypoints);
      if (wps === null) return 'invalid:waypoints';
      const src = sourceByUid(s, t.src);
      if (!src) return 'notFound';
      const r = routeTrail(s, d, t.origin, src.hex, wps);
      if (!r || r.path.length < 2) return 'blocked';
      return null;
    },
    apply(s, d, cmd, env) {
      const t = trailByUid(s, cmd.uid);
      const src = sourceByUid(s, t.src);
      const r = routeTrail(s, d, t.origin, src.hex, waypointsOf(cmd.waypoints));
      const from = t.len;
      t.path = r.path;
      t.len = r.len;
      t.reroutes.push(num(s.run.time));
      while (t.reroutes.length > TRAIL.overthinker.n) t.reroutes.shift();
      s.run.surface.rev += 1;
      // WP4 extension event (not in §10): lets WP6 check ach_double_bridge (≥ 30 % shorter) without diffing paths.
      env.emit('trailRerouted', { uid: t.uid, from, to: t.len });
    },
  },

  /** deleteTrail { uid } */
  deleteTrail: {
    validate(s, d, cmd) {
      if (trailByUid(s, cmd.uid)) return null;
      return Number.isInteger(cmd.uid) ? 'notFound' : 'invalid';
    },
    apply(s, d, cmd, env) {
      const T = s.run.surface.trails;
      const i = T.findIndex((t) => t.uid === cmd.uid);
      T.splice(i, 1);
      forgetTrail(s, cmd.uid);
      s.run.surface.rev += 1;
      env.emit('trailDeleted', { uid: cmd.uid });
    },
  },

  /** assignWorkers { uid, n }: explicit worker count on a forager / herder / leafcutter trail. */
  assignWorkers: {
    validate(s, d, cmd) {
      const t = trailByUid(s, cmd.uid);
      if (!t) return Number.isInteger(cmd.uid) ? 'notFound' : 'invalid';
      if (!POOLS.includes(t.job)) return 'invalid:job';
      const n = cmd.n;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'invalid';
      const jobsN = Math.max(0, num(s.run.colony.jobs[t.job]));
      let others = 0;
      let sameSrc = 0;
      for (const o of s.run.surface.trails) {
        if (o === t || o.job !== t.job) continue;
        others += Math.max(0, num(o.workers));
        if (o.src === t.src) sameSrc += Math.max(0, num(o.workers));
      }
      if (n > jobsN - others + 1e-9) return 'invalid:count';
      const src = sourceByUid(s, t.src);
      const p = src ? { def: SOURCES[src.type], src } : null;
      if (p && p.def && n > herdCap(s, p) - sameSrc + 1e-9) return 'max';
      return null;
    },
    apply(s, d, cmd) {
      trailByUid(s, cmd.uid).workers = cmd.n;
    },
  },

  /** assignEscorts { uid, n }: soldiers from the garrison (≤ garrison soldiers + this trail's escorts). */
  assignEscorts: {
    validate(s, d, cmd) {
      const t = trailByUid(s, cmd.uid);
      if (!t) return Number.isInteger(cmd.uid) ? 'notFound' : 'invalid';
      if (!Number.isInteger(cmd.n) || cmd.n < 0) return 'invalid';
      const gar = Math.max(0, num(d.combat && d.combat.garrison ? d.combat.garrison.soldier : 0));
      if (cmd.n > Math.floor(gar + Math.max(0, num(t.escorts)))) return 'invalid:count';
      return null;
    },
    apply(s, d, cmd) {
      trailByUid(s, cmd.uid).escorts = cmd.n;
    },
  },

  /** mark { uid }: +25 strength (up to S_max); 5 pheromone; 3 s cooldown. */
  mark: {
    validate(s, d, cmd) {
      const t = trailByUid(s, cmd.uid);
      return abilityGate(s, 'mark', t ? null : Number.isInteger(cmd.uid) ? 'notFound' : 'invalid');
    },
    apply(s, d, cmd, env) {
      applyMark(s, trailByUid(s, cmd.uid), env);
    },
  },

  /** rally { uid }: that trail ×2 output for 30 s (60 s with mass_recruitment); 20 pheromone; 120 s cooldown. */
  rally: {
    validate(s, d, cmd) {
      const t = trailByUid(s, cmd.uid);
      let target = null;
      if (!t) target = Number.isInteger(cmd.uid) ? 'notFound' : 'invalid';
      else if (t.job === 'lycaenid') target = 'invalid';
      return abilityGate(s, 'rally', target);
    },
    apply(s, d, cmd, env) {
      const a = ABILITIES.rally;
      if (!spend(s, a.cost)) return;
      const sec = owns(s, 'mass_recruitment') ? fxOf(RESEARCH, 'mass_recruitment', 'rallySec', a.sec) : a.sec;
      addEffect(s, { id: 'rally:' + cmd.uid, stat: 'forage_trail', scope: cmd.uid, mult: a.mult, t: sec });
      s.run.surface.cd.rally = a.cd;
      env.emit('abilityUsed', { id: a.id, uid: cmd.uid });
    },
  },

  /** frenzy {}: all forage ×2 for 20 s; 60 pheromone; 120 s cooldown. */
  frenzy: {
    validate(s) {
      return abilityGate(s, 'frenzy', null);
    },
    apply(s, d, cmd, env) {
      const a = ABILITIES.frenzy;
      if (!spend(s, a.cost)) return;
      addEffect(s, { id: 'frenzy', stat: 'forage', mult: a.mult, t: a.sec });
      s.run.surface.cd.frenzy = a.cd;
      env.emit('abilityUsed', { id: a.id, uid: 0 });
    },
  },

  /**
   * massRecruit { src }: during a termite swarm / picnic with a trail to it, pin 50 % of the unassigned foragers on that
   * trail as explicit workers; 20 pheromone.
   */
  massRecruit: {
    validate(s, d, cmd) {
      const a = ABILITIES.mass_recruit;
      let target = null;
      if (!Number.isInteger(cmd.src)) target = 'invalid';
      else {
        const src = sourceByUid(s, cmd.src);
        if (!src) target = 'notFound';
        else if (!(a.targets || []).includes(src.type)) target = 'invalid';
        else if (!s.run.surface.trails.some((t) => t.src === src.uid && POOLS.includes(t.job))) target = 'requirements';
      }
      return abilityGate(s, 'mass_recruit', target);
    },
    apply(s, d, cmd, env) {
      const a = ABILITIES.mass_recruit;
      if (!spend(s, a.cost)) return;
      const T = s.run.surface.trails;
      const t = T.find((x) => x.src === cmd.src && POOLS.includes(x.job));
      // ARCH-R: idle minors cannot be moved into the forager job from WP4 (colony.jobs is WP2's and no [x] helper exists),
      // so "idle and loose foragers" is read as the foragers not explicitly assigned to any trail (the auto-fill pool).
      let explicit = 0;
      for (const o of T) if (o.job === t.job) explicit += Math.max(0, num(o.workers));
      const pool = Math.max(0, num(s.run.colony.jobs[t.job]) - explicit);
      t.workers = clampNum(Math.max(0, num(t.workers)) + a.frac * pool);
      env.emit('abilityUsed', { id: a.id, uid: t.uid });
    },
  },
};
