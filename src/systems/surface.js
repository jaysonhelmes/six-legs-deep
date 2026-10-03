// Surface rules: derive (passability, territory, borders, slots, D_nav, slope, frontier, scout rate, claim cost, best
// source), scouting, the source lifecycle and spawning, map radius, claims and channels, the mound, entrances.
// Owner: WP4. Contract: ARCHITECTURE §8.3 (surface.js), §4 (s.run.surface), §5 (d.surface); DESIGN §8.1–§8.8, §21.4.

import { GRID } from '../data/balance.js';
import { MAP, TERRAIN, TERRAIN_ORDER, SCOUT, TRAIL, SLOTS, TERRITORY, MOUND } from '../data/surface.js';
import { SOURCES, SOURCE_ORDER } from '../data/sources.js';
import { RESEARCH } from '../data/research.js';
import { TRAITS as BLOODLINE } from '../data/bloodline.js';
import { FEDERATION } from '../data/federation.js';
import { ADAPTATIONS } from '../data/adaptations.js';
import { HARDSHIPS, BOONS } from '../data/prestige.js';
import { GEOM } from '../data/strata.js';
import { HEX_COUNT, ringOf, neighbors, hexDist, hexIndex, countInRadius } from '../core/hex.js';
import { grant, spend, canAfford, refund } from '../core/wallet.js';
import { geoCost, clampNum } from '../core/math.js';
import { randInt, weighted } from '../core/rng.js';
import * as rivals from './rivals.js';   // rivalLand [q]
import * as trails from './trails.js';   // bestTargets, trailOrigins [q]; routeTrail (WP4-internal)

const CODE = Object.freeze(Object.fromEntries(TERRAIN_ORDER.map((id, i) => [id, i])));
const ENTRANCE_KINDS = Object.freeze(['main', 'nuptial', 'satellite', 'outpost']);
const PENDING_MAX = 2000;

// ------------------------------------------------------------------------------------------------------------------
// Small private readers (ownership, data fx with neutral fallbacks)
// ------------------------------------------------------------------------------------------------------------------

/** fx value of a data-table entry, or `fallback` (neutral) when the owning package's table does not carry it. */
function fxOf(table, id, key, fallback) {
  const e = table && table[id];
  const v = e && e.fx ? e.fx[key] : undefined;
  return v === undefined || v === null ? fallback : v;
}
const owns = (s, id) => !!(s.run.research && s.run.research[id]);
const traitL = (s, id) => (s.cycle.traits && s.cycle.traits[id]) || 0;
const fedL = (s, id) => (s.era.federation && s.era.federation[id]) || 0;
const adaptL = (s, id) => (s.run.adaptations && s.run.adaptations[id]) || 0;
const achieved = (s, id) => !!s.meta.achievements && s.meta.achievements[id] !== undefined && s.meta.achievements[id] !== null;
const unlocked = (s, key) => !!(s.run.unlocked && s.run.unlocked[key]);
const isHex = (h) => Number.isInteger(h) && h >= 0 && h < HEX_COUNT;
const num = (x, fb = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fb);

/** Hex count of the current map (radius clamped to the stored map). */
function hexesIn(s) {
  return countInRadius(Math.max(0, Math.min(ringOf(HEX_COUNT - 1), num(s.run.surface.radius, MAP.radiusBase))));
}

/** Hexes currently blocked by molehill event objects (WP6, ev_mole_tunnel). */
function molehills(s) {
  const out = new Set();
  const objs = s.run.events && Array.isArray(s.run.events.objects) ? s.run.events.objects : [];
  for (const o of objs) if (o && o.kind === 'molehill' && isHex(o.hex)) out.add(o.hex);
  return out;
}

/** Move cost of a terrain code (null = impassable), honouring the spring puddle rule. */
function terrainMove(code, puddlesBlock) {
  const def = TERRAIN[TERRAIN_ORDER[code]];
  if (!def) return null;
  if (puddlesBlock && Object.prototype.hasOwnProperty.call(def, 'springMove')) return def.springMove ?? null;
  return def.move ?? null;
}

/** Passability by terrain code, [no puddle block, spring puddle block] (derive's per-tick pass reads this, F24 perf). */
const PASS_BY_CODE = [false, true].map((block) => TERRAIN_ORDER.map((_, code) => terrainMove(code, block) !== null));

// ------------------------------------------------------------------------------------------------------------------
// WP4-internal helpers shared with trails.js (not part of the cross-package contract)
// ------------------------------------------------------------------------------------------------------------------

/**
 * Emit now when an env is at hand, else queue the event in d.surface until the next WP4 tick flushes it
 * (removeSource / spawnSource / revealHexes / hitTrail are called by other packages without an env).
 * WP4-internal.
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env|null} env
 * @param {string} type
 * @param {Object} payload
 */
export function queueEvent(d, env, type, payload) {
  if (env && typeof env.emit === 'function') {
    env.emit(type, payload);
    return;
  }
  if (!d || !d.surface) return;
  if (!Array.isArray(d.surface._pending)) d.surface._pending = [];
  if (d.surface._pending.length < PENDING_MAX) d.surface._pending.push({ type, payload });
}

/**
 * Emit every queued WP4 event into env (called at the start of trails.tick and surface.tick). WP4-internal.
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 */
export function flushEvents(d, env) {
  const q = d && d.surface && d.surface._pending;
  if (!Array.isArray(q) || q.length === 0 || !env || typeof env.emit !== 'function') return;
  d.surface._pending = [];
  for (const e of q) env.emit(e.type, e.payload);
}

/**
 * Trail slots from state alone (valid before the next derive): base + research fx.slots + Mound milestones + outposts
 * + satellites (DESIGN §8.5). WP4-internal [q].
 * @param {import('../core/types.js').State} s
 * @returns {number}
 */
export function trailSlots(s) {
  const S = s.run.surface;
  let n = SLOTS.base;
  for (const id of ['trail_memory', 'sun_compass', 'mass_recruitment']) if (owns(s, id)) n += fxOf(RESEARCH, id, 'slots', 0);
  for (const lv of SLOTS.moundLevels) if (num(S.mound) >= lv) n += 1;
  for (const e of S.entrances) {
    if (e && e.kind === 'outpost') n += SLOTS.outpost;
    else if (e && e.kind === 'satellite') n += SLOTS.satellite;
  }
  return n;
}

/**
 * D_nav = 3 + tandem 1 + mass 2 + odometer 3 + 0.25 × long_legs + highway 5 (DESIGN §8.5). WP4-internal [q].
 * @param {import('../core/types.js').State} s
 * @returns {number}
 */
export function dNavFor(s) {
  let v = TRAIL.dNavBase;
  for (const id of ['tandem_running', 'mass_recruitment', 'odometer_navigation']) if (owns(s, id)) v += fxOf(RESEARCH, id, 'dNav', 0);
  v += adaptL(s, 'long_legs') * fxOf(ADAPTATIONS, 'long_legs', 'dNav', 0);
  if (fedL(s, 'highway_network') >= 1) v += fxOf(FEDERATION, 'highway_network', 'dNav', 0);
  return v;
}

/**
 * Richness slope = 0.35 (0.5 with odometer_navigation) + 0.05 × barren_ground reward tier. WP4-internal [q].
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number}
 */
export function slopeFor(s, d) {
  const base = owns(s, 'odometer_navigation') ? fxOf(RESEARCH, 'odometer_navigation', 'slope', TRAIL.slope) : TRAIL.slope;
  const tier = num(d && d.meta && d.meta.hardship ? d.meta.hardship.barren_ground : 0);
  return base + fxOf(HARDSHIPS, 'barren_ground', 'slope', 0) * tier;
}

/** Scout-seconds per second of the whole scout force, before offline efficiency (DESIGN §8.3). */
function scoutRateFor(s) {
  const scouts = Math.max(0, num(s.run.colony.jobs.scout));
  let r = scouts ** SCOUT.forceExp;
  if (owns(s, 'antennation')) r *= fxOf(RESEARCH, 'antennation', 'scout', 1);
  if (traitL(s, 'keen_antennae') >= 1) r *= fxOf(BLOODLINE, 'keen_antennae', 'scout', 1);
  if (achieved(s, 'ach_cartographer')) r *= SCOUT.cartographer;
  return clampNum(r);
}

/** Map radius the run is entitled to: 8, 12 with sun_compass, 16 with regional_expansion (DESIGN §8.1). */
function targetRadius(s) {
  let r = MAP.radiusBase;
  if (owns(s, 'sun_compass')) r = Math.max(r, fxOf(RESEARCH, 'sun_compass', 'radius', MAP.radiusBase));
  if (fedL(s, 'regional_expansion') >= 1) r = Math.max(r, fxOf(FEDERATION, 'regional_expansion', 'radius', MAP.radiusBase));
  return Math.min(ringOf(HEX_COUNT - 1), r);
}

/** Size a finite source now: max = max(base, sec × current gross food/s), stock = max (C34). */
function sizeSource(d, src) {
  const def = SOURCES[src.type];
  if (!def || !def.stock) return;
  const gross = Math.max(0, num(d && d.rates && d.rates.food ? d.rates.food.gross : 0));
  const max = clampNum(Math.max(def.stock.base, def.stock.sec * gross));
  src.max = max;
  src.stock = max;
  delete src.data.unsized;
}

/** Reveal one hex: flag, scouting insight, C34 sizing, flag cleanup, hexRevealed. Caller bumps rev. */
function revealOne(s, d, hex, insight, env) {
  const S = s.run.surface;
  S.revealed[hex] = 1;
  if (insight) {
    const scouting = num(d && d.stats && d.stats.insight ? d.stats.insight.scouting : 1, 1);
    grant(s, d, 'insight', SCOUT.insightPerRing * ringOf(hex) * scouting);
  }
  for (const src of S.sources) if (src.hex === hex && src.data && src.data.unsized && !src.data.dormant) sizeSource(d, src);
  const fi = S.flagged.indexOf(hex);
  if (fi >= 0) S.flagged.splice(fi, 1);
  queueEvent(d, env, 'hexRevealed', { hex });
}

/** Claim a hex outright (claimed, claims++, rev++, claimDone). */
function doClaim(s, d, hex, env) {
  const S = s.run.surface;
  S.claimed[hex] = 1;
  S.claims += 1;
  S.rev += 1;
  queueEvent(d, env, 'claimDone', { hex });
}

/** Source by uid. */
function sourceByUid(s, uid) {
  for (const src of s.run.surface.sources) if (src.uid === uid) return src;
  return null;
}

// ------------------------------------------------------------------------------------------------------------------
// Derive
// ------------------------------------------------------------------------------------------------------------------

/** Rebuild rival land, owned land, borders and the scouting frontier (gated on rev / mound / trunk / run identity). */
function rebuildTerritory(s, d, trunk) {
  const S = s.run.surface;
  const D = d.surface;
  const nIn = hexesIn(s);
  D.owned.fill(0);
  D.border.fill(0);
  D.rival.fill(0);
  const list = s.run.rivals && Array.isArray(s.run.rivals.list) ? s.run.rivals.list : [];
  for (const r of list) {
    if (!r || !r.alive) continue;
    let land = [];
    try {
      land = rivals.rivalLand(s, r);
    } catch {
      land = [];
    }
    if (!Array.isArray(land)) continue;
    const uid = Math.max(1, Math.min(32767, num(r.uid, 1)));
    for (const h of land) if (isHex(h) && D.rival[h] === 0) D.rival[h] = uid;
  }
  const autoR = TERRITORY.autoBase + Math.floor(Math.max(0, num(S.mound)) / TERRITORY.autoPerMound);
  for (const e of S.entrances) {
    if (!e || !isHex(e.hex)) continue;
    for (let i = 0; i < nIn; i++) if (D.owned[i] === 0 && D.rival[i] === 0 && hexDist(i, e.hex) <= autoR) D.owned[i] = 1;
  }
  for (let i = 0; i < HEX_COUNT; i++) {
    if (D.owned[i] !== 0 || D.rival[i] !== 0) continue;
    if (S.claimed[i]) D.owned[i] = 2;
    else if (S.conquered[i]) D.owned[i] = 3;
  }
  if (trunk) {
    const minLen = fxOf(RESEARCH, 'trunk_trails', 'minLen', Infinity);
    for (const t of S.trails) {
      if (!t || !Array.isArray(t.path) || t.path.length < minLen) continue;
      for (const h of t.path) if (isHex(h) && h < nIn && D.owned[h] === 0 && D.rival[h] === 0) D.owned[h] = 4;
    }
  }
  let count = 0;
  for (let i = 0; i < HEX_COUNT; i++) {
    if (D.owned[i] === 0) continue;
    count++;
    for (const n of neighbors(i)) {
      if (D.rival[n] !== 0) {
        D.border[i] = 1;
        break;
      }
    }
  }
  D.ownedCount = count;
  const frontier = [];
  for (let i = 0; i < nIn; i++) {
    if (S.revealed[i]) continue;
    for (const n of neighbors(i)) {
      if (S.revealed[n]) {
        frontier.push(i);
        break;
      }
    }
  }
  D.frontier = frontier;
  D.rev = S.rev;
  D._ref = S;
  D._mound = S.mound;
  D._trunk = trunk;
  D._bestKey = null;
}

/**
 * Recompute d.surface: passability every tick; territory/borders/frontier when rev, the mound level, trunk_trails or the
 * run changed; slots, D_nav, slope, scout rate, claim cost; the best untrailed source (gated).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {void}
 */
export function derive(s, d) {
  const S = s.run.surface;
  const D = d.surface;
  const nIn = hexesIn(s);
  const block = !!(d.season && d.season.mods && d.season.mods.puddlesBlock);
  const holes = molehills(s);
  const pass = PASS_BY_CODE[block ? 1 : 0];
  const terr = S.terrain;
  for (let i = 0; i < HEX_COUNT; i++) {
    D.passable[i] = i < nIn && pass[terr[i]] === true && !holes.has(i) ? 1 : 0;
  }
  const trunk = owns(s, 'trunk_trails');
  if (D._ref !== S || D.rev !== S.rev || D._mound !== S.mound || D._trunk !== trunk) rebuildTerritory(s, d, trunk);
  D.slots = trailSlots(s);
  D.slotsUsed = S.trails.length;
  D.dNav = dNavFor(s);
  D.slope = slopeFor(s, d);
  D.scoutRate = scoutRateFor(s);
  D.claimCost = claimCost(s).pheromone;
  const srcId = d.season && d.season.srcId;
  const key = S.rev + '|' + S.nextUid + '|' + S.sources.length + '|' + S.trails.length + '|' + srcId + '|' + D.dNav + '|' + D.slope;
  // The best untrailed source is advisor-only (onboarding glow, renderer): skipped inside an offline simulation
  // (d.offlineLog is set only there), and recomputed by the next online derive (F24).
  if (d.offlineLog) D._bestKey = null;
  else if (D._bestKey !== key) {
    D._bestKey = key;
    const best = trails.bestTargets(s, d, 'forager');
    D.bestSource = best.length > 0 ? best[0].src : 0;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Tick
// ------------------------------------------------------------------------------------------------------------------

/** Scouting: spend scout-seconds on the best frontier hex, revealing as many hexes as the work allows (O(reveals)). */
function scoutTick(s, d, dt, env) {
  const S = s.run.surface;
  const sc = S.scout;
  if (!(sc.prog >= 0) || !Number.isFinite(sc.prog)) sc.prog = 0;
  const nIn = hexesIn(s);
  const front = new Set();
  for (const i of d.surface.frontier) if (i < nIn && !S.revealed[i]) front.add(i);
  const flagged = new Set(S.flagged);
  let work = num(d.surface.scoutRate) * num(env.eff, 1) * dt;
  let revealed = 0;
  for (let guard = 0; guard <= nIn; guard++) {
    let best = -1;
    let bestKey = Infinity;
    for (const i of front) {
      const k = ringOf(i) / (flagged.has(i) ? SCOUT.flagPriority : 1);
      if (k < bestKey || (k === bestKey && i < best)) {
        bestKey = k;
        best = i;
      }
    }
    sc.target = best;
    if (best < 0 || !(work > 0)) break;
    const cost = SCOUT.base * ringOf(best) ** SCOUT.exp;
    if (sc.prog + work >= cost) {
      work -= Math.max(0, cost - sc.prog);
      sc.prog = 0;
      revealOne(s, d, best, true, env);
      revealed++;
      front.delete(best);
      for (const n of neighbors(best)) if (n < nIn && !S.revealed[n]) front.add(n);
    } else {
      sc.prog = clampNum(sc.prog + work);
      work = 0;
    }
  }
  if (revealed > 0) S.rev += 1;
}

/** Re-arm a spawn timer that reached 0: carry the overshoot, never bank more than one interval of backlog. */
function rearm(t, every) {
  if (!(every > 0)) return 0;
  const next = t + every;
  return next > 0 ? next : every;
}

/** Spawn one source of a random group if under its cap (shared timer). */
function spawnRandom(s, d, timer, env) {
  const S = s.run.surface;
  const group = SOURCE_ORDER.filter((id) => SOURCES[id].spawn && SOURCES[id].spawn.mode === 'random' && SOURCES[id].spawn.timer === timer);
  if (group.length === 0) return 0;
  const spec = SOURCES[group[0]].spawn;
  const alive = S.sources.filter((x) => group.includes(x.type)).length;
  if (alive < (spec.max ?? Infinity)) {
    const pickOne = weighted(s, group.map((id) => ({ id, w: SOURCES[id].spawn.w ?? 1 })));
    if (pickOne) spawnSource(s, d, pickOne.id, -1, { env });
  }
  return spec.every;
}

/** Source lifecycle: wake, age, ttl, C34 sizing, seed-patch dynamic max and regrowth, fruit rot, depletion, aphid levels, spawns. */
function sourcesTick(s, d, dt, env) {
  const S = s.run.surface;
  const gross = Math.max(0, num(d.rates && d.rates.food ? d.rates.food.gross : 0));
  const workersByTrail = new Map();
  for (const e of d.surface.trails) if (e) workersByTrail.set(e.uid, num(e.workers));
  for (const src of S.sources.slice()) {
    const def = SOURCES[src.type];
    if (!def) continue;
    if (!src.data || typeof src.data !== 'object') src.data = {};
    if (src.data.dormant) {
      if (ringOf(src.hex) > S.radius) continue;
      delete src.data.dormant;
    }
    src.age = clampNum(num(src.age) + dt);
    if (src.ttl >= 0) {
      src.ttl = Math.max(0, num(src.ttl) - dt);
      if (src.ttl <= 0) {
        removeSource(s, d, src.uid, 'expired', env);
        continue;
      }
    }
    if (def.stock) {
      if (src.data.unsized) {
        if (!S.revealed[src.hex]) continue;
        sizeSource(d, src);
      }
      // A dt = 0 derive pass (load, import, catch-up rebuild) runs on a fresh d whose food rate is still 0: it must not
      // shrink the seed patch (integration fix: every reload used to reset it to its base stock).
      if (def.stock.dynamic && dt > 0) {
        src.max = clampNum(Math.max(def.stock.base, def.stock.sec * gross));
        if (src.stock > src.max) src.stock = src.max;
      }
      if (def.stock.regrow > 0) src.stock = Math.min(src.max, num(src.stock) + def.stock.regrow * src.max * dt);
      const fx = def.fx || {};
      if (fx.rotPerSec > 0 && src.age > fx.rotAfter) {
        // ARCH-R: "rots at −1 % stock/s" read as 1 % of max per second (linear), so the fruit is gone 100 s later.
        src.stock = Math.max(0, num(src.stock) - fx.rotPerSec * src.max * dt);
        if (src.stock <= 0) {
          removeSource(s, d, src.uid, 'rotted', env);
          continue;
        }
      }
      if (!(def.stock.regrow > 0) && src.stock <= 0) {
        s.run.stats.sourcesDepleted += 1;
        removeSource(s, d, src.uid, 'depleted', env);
        continue;
      }
    }
    const fx = def.fx || {};
    if (def.capPerLevel && fx.levelSec > 0 && src.level < (fx.maxLevel ?? 1)) {
      let herders = 0;
      for (const t of S.trails) if (t.src === src.uid) herders += workersByTrail.get(t.uid) || 0;
      if (herders > 0 && herders >= (fx.herdFrac ?? 1) * def.capPerLevel * src.level * (1 - 1e-9)) {   // float-safe threshold
        src.herdT = num(src.herdT) + dt;
        if (src.herdT >= fx.levelSec) {
          src.level += 1;
          src.herdT = 0;
        }
      }
    }
  }
  // Random spawns are world surprises: paused offline (ARCH-R, DESIGN §21.4 spirit "nothing happens offline").
  if (!env.offline) {
    const timers = new Set();
    for (const id of SOURCE_ORDER) {
      const sp = SOURCES[id].spawn;
      if (sp && sp.mode === 'random' && sp.timer) timers.add(sp.timer);
    }
    for (const timer of timers) {
      if (typeof S.spawn[timer] !== 'number' || !Number.isFinite(S.spawn[timer])) continue;
      S.spawn[timer] -= dt;
      if (S.spawn[timer] <= 0) {
        const every = spawnRandom(s, d, timer, env);
        S.spawn[timer] = rearm(S.spawn[timer], every);
      }
    }
    if (s.run.boon === 'boon_rich_prey' && s.run.time < fxOf(BOONS, 'boon_rich_prey', 'until', 0)) {
      S.spawn.boonPrey = num(S.spawn.boonPrey) - dt;
      if (S.spawn.boonPrey <= 0) {
        S.spawn.boonPrey = rearm(S.spawn.boonPrey, fxOf(BOONS, 'boon_rich_prey', 'every', 0));
        // "A dead insect respawns at ring 2": one boon insect at a time.
        if (!S.sources.some((x) => x.data && x.data.boon)) {
          const ring = fxOf(BOONS, 'boon_rich_prey', 'ring', null);
          if (ring !== null) spawnSource(s, d, 'dead_insect', -1, { rMin: ring, rMax: ring, data: { boon: true }, env });
        }
      }
    }
  }
  for (const id of SOURCE_ORDER) {
    const sp = SOURCES[id].spawn;
    if (!sp || sp.mode !== 'research' || !owns(s, sp.research)) continue;
    if (S.sources.some((x) => x.type === id)) continue;
    const n = randInt(s, sp.countMin ?? 1, sp.countMax ?? 1);
    for (let k = 0; k < n; k++) spawnSource(s, d, id, -1, { env });
  }
}

/** Claim channel: move all available pheromone into it each tick; claim when paid. */
function channelTick(s, d, env) {
  const S = s.run.surface;
  const ch = S.channel;
  if (!ch) return;
  if (!isHex(ch.hex) || d.surface.rival[ch.hex] !== 0 || S.claimed[ch.hex] || !(ch.cost > 0)) {
    refund(s, d, { pheromone: num(ch.paid) });
    S.channel = null;
    return;
  }
  // ARCH-R: pheromone already accrues at regen × eff (economy); draining all of it is the "full regen" channel, so eff
  // is not applied a second time here.
  const amt = Math.min(Math.max(0, ch.cost - ch.paid), Math.max(0, num(s.run.res.pheromone)));
  if (amt > 0 && spend(s, { pheromone: amt })) ch.paid = clampNum(ch.paid + amt);
  if (ch.paid >= ch.cost * (1 - 1e-12)) {
    S.channel = null;
    doClaim(s, d, ch.hex, env);
  }
}

/**
 * Advance the surface: map radius, scouting, sources (lifecycle and spawns), the claim channel, tPeak, longest trail.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  flushEvents(d, env);
  const S = s.run.surface;
  const step = dt > 0 ? dt : 0;
  const want = targetRadius(s);
  if (want > S.radius) {
    S.radius = want;
    S.rev += 1;
    env.emit('radiusChanged', { radius: want });
  }
  scoutTick(s, d, step, env);
  sourcesTick(s, d, step, env);
  channelTick(s, d, env);
  s.run.tPeak = Math.max(num(s.run.tPeak), num(d.surface.ownedCount));
  // ARCH-R: "longest trail (hexes)" counted as hex steps from origin to source (path.length − 1).
  let longest = num(s.meta.stats.longestTrail);
  for (const t of S.trails) if (Array.isArray(t.path)) longest = Math.max(longest, t.path.length - 1);
  s.meta.stats.longestTrail = longest;
}

// ------------------------------------------------------------------------------------------------------------------
// Queries
// ------------------------------------------------------------------------------------------------------------------

/**
 * True if the hex can be walked now (inside the radius; not stone, spring puddle or molehill), per d.surface.passable.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} hex
 * @returns {boolean}
 */
export function isPassable(s, d, hex) {
  return isHex(hex) && hex < hexesIn(s) && d.surface.passable[hex] === 1;
}

/**
 * Cost of entering the hex (TERRAIN move), or null if impassable now.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} hex
 * @returns {number|null}
 */
export function moveCost(s, d, hex) {
  if (!isPassable(s, d, hex)) return null;
  return terrainMove(s.run.surface.terrain[hex], false);
}

/**
 * Pheromone cost of the next claim: 10 × 1.06^claims (× 0.9 with ach_land_grab).
 * @param {import('../core/types.js').State} s
 * @returns {import('../core/types.js').Cost}
 */
export function claimCost(s) {
  const mult = achieved(s, 'ach_land_grab') ? TERRITORY.landGrabAch : 1;
  const c = geoCost({ pheromone: TERRITORY.claimBase * mult }, TERRITORY.claimGrowth, Math.max(0, num(s.run.surface.claims)));
  return c || { pheromone: clampNum(Infinity) };
}

/**
 * Reason the hex cannot be claimed now, or null.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} hex
 * @returns {import('../core/types.js').ReasonCode|null}
 */
export function canClaim(s, d, hex) {
  const S = s.run.surface;
  if (!unlocked(s, 'hex_claim')) return 'locked';
  if (!isHex(hex) || hex >= hexesIn(s)) return 'invalid';
  if (!S.revealed[hex]) return 'invalid:fog';
  if (d.surface.owned[hex] || S.claimed[hex]) return 'invalid:owned';
  if (d.surface.rival[hex]) return 'blocked:rival';
  const adj = neighbors(hex).some((n) => d.surface.owned[n] !== 0 || (S.claimed[n] && d.surface.rival[n] === 0));
  if (!adj) return 'invalid:adjacent';
  if (S.channel) return 'busy';
  return null;
}

/**
 * Soil cost of the next Mound level (300 × 1.9^(L−1) for level L), or null at MAX.
 * @param {import('../core/types.js').State} s
 * @returns {import('../core/types.js').Cost|null}
 */
export function moundCost(s) {
  return geoCost({ soil: MOUND.base }, MOUND.growth, Math.max(0, num(s.run.surface.mound)));
}

/**
 * First source on the hex, or null.
 * @param {import('../core/types.js').State} s
 * @param {number} hex
 * @returns {import('../core/types.js').Source|null}
 */
export function sourceAt(s, hex) {
  for (const src of s.run.surface.sources) if (src.hex === hex) return src;
  return null;
}

/**
 * Surface hex of a nuptial entrance for shaft column `col` (DESIGN §7.11): west if col < 20 else east, at distance
 * 1 + floor(|col − 20| / 8); if impassable (or already an entrance), the nearest passable hex (ties by lower index).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} col
 * @returns {number}
 */
export function nuptialHex(s, d, col) {
  const c = Number.isFinite(col) ? col : GRID.mainCol;
  const radius = Math.max(1, ringOf(hexesIn(s) - 1));
  const dist = Math.min(radius, 1 + Math.floor(Math.abs(c - GRID.mainCol) / GEOM.nuptialEntranceStep));
  const want = hexIndex(c < GRID.mainCol ? -dist : dist, 0);
  const taken = new Set(s.run.surface.entrances.map((e) => e && e.hex));
  const ok = (i) => isPassable(s, d, i) && !taken.has(i);
  if (ok(want)) return want;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < hexesIn(s); i++) {
    if (!ok(i)) continue;
    const k = hexDist(i, want);
    if (k < bestD) {
      bestD = k;
      best = i;
    }
  }
  return best >= 0 ? best : want;
}

// ------------------------------------------------------------------------------------------------------------------
// Cross-callable mutators [x]
// ------------------------------------------------------------------------------------------------------------------

/**
 * Spawn a source (WP5, WP6). hex −1 → a passable, free hex in ring [opts.rMin ?? spawn.rMin, opts.rMax ?? spawn.rMax]
 * (clipped to the radius; opts.terrain filter; prey favour hexes near a fallen log), picked with s as RNG holder.
 * opts.ttl / opts.data / opts.level override defaults; finite stocks are sized per C34; emits sourceSpawned
 * (immediately with opts.env, otherwise on the next WP4 tick).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} type
 * @param {number} [hex=-1]
 * @param {{ rMin?: number, rMax?: number, terrain?: string, ttl?: number, data?: Object, level?: number, env?: Object }} [opts]
 * @returns {number} the new uid, or 0 if nothing was spawned
 */
export function spawnSource(s, d, type, hex = -1, opts = {}) {
  const def = typeof type === 'string' ? SOURCES[type] : null;
  if (!def) return 0;
  const o = opts && typeof opts === 'object' ? opts : {};
  const S = s.run.surface;
  const sp = def.spawn || {};
  let at = hex;
  if (at === -1 || at === undefined || at === null) {
    const radius = ringOf(hexesIn(s) - 1);
    const rMax = Math.min(radius, Number.isFinite(o.rMax) ? o.rMax : (sp.rMax ?? radius));
    const rMin = Math.max(1, Math.min(rMax, Number.isFinite(o.rMin) ? o.rMin : (sp.rMin ?? 1)));
    const terrainId = typeof o.terrain === 'string' ? o.terrain : sp.terrain;
    const want = terrainId && CODE[terrainId] !== undefined ? CODE[terrainId] : -1;
    const busy = new Set();
    for (const x of S.sources) busy.add(x.hex);
    for (const e of S.entrances) if (e) busy.add(e.hex);
    const rl = s.run.rivals && Array.isArray(s.run.rivals.list) ? s.run.rivals.list : [];
    for (const r of rl) if (r && r.alive) busy.add(r.hex);
    const holes = molehills(s);
    const isPrey = !!(def.hunt && def.hunt.apPerRing);
    const logs = [];
    if (isPrey) for (let i = 0; i < HEX_COUNT; i++) if (S.terrain[i] === CODE.log) logs.push(i);
    const lfx = (TERRAIN.log && TERRAIN.log.fx) || {};
    const entries = [];
    const lo = rMin <= 0 ? 0 : countInRadius(rMin - 1);
    const hi = countInRadius(rMax);
    for (let i = lo; i < hi; i++) {
      const code = S.terrain[i];
      if (busy.has(i) || holes.has(i) || code === CODE.stone || code === CODE.puddle) continue;
      if (want >= 0 && code !== want) continue;
      let w = 1;
      if (isPrey && logs.some((g) => hexDist(g, i) <= (lfx.preyRadius ?? 0))) w = lfx.prey ?? 1;
      entries.push({ i, w });
    }
    const chosen = weighted(s, entries);
    if (!chosen) return 0;
    at = chosen.i;
  } else if (!isHex(at)) {
    return 0;
  }
  let data = {};
  if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) {
    try {
      data = JSON.parse(JSON.stringify(o.data)) || {};
    } catch {
      data = {};
    }
  }
  const level = Number.isInteger(o.level) && o.level >= 1 ? o.level : 1;
  const ttl = Number.isFinite(o.ttl) && o.ttl > 0 ? o.ttl : (Number.isFinite(sp.ttl) ? sp.ttl : -1);
  const src = { uid: S.nextUid++, type, hex: at, stock: -1, max: -1, level, herdT: 0, age: 0, ttl, cd: 0, data };
  const dormant = ringOf(at) > S.radius;
  if (dormant) src.data.dormant = true;
  if (def.stock) {
    if (!dormant && S.revealed[at]) sizeSource(d, src);
    else {
      src.stock = 0;
      src.max = 0;
      src.data.unsized = true;
    }
  }
  S.sources.push(src);
  queueEvent(d, o.env, 'sourceSpawned', { uid: src.uid, sourceType: type });
  return src.uid;
}

/**
 * Remove a source (WP4, WP5, WP6): deletes every trail to it and emits sourceRemoved {uid, reason} (and trailDeleted per
 * trail) — immediately when `env` is given, otherwise on the next WP4 tick.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} uid
 * @param {string} reason
 * @param {import('../core/types.js').Env|null} [env=null] WP4 extension (optional)
 * @returns {void}
 */
export function removeSource(s, d, uid, reason, env = null) {
  const S = s.run.surface;
  const idx = S.sources.findIndex((x) => x.uid === uid);
  if (idx < 0) return;
  S.sources.splice(idx, 1);
  let cut = 0;
  for (let i = S.trails.length - 1; i >= 0; i--) {
    if (S.trails[i].src !== uid) continue;
    const t = S.trails.splice(i, 1)[0];
    trails.forgetTrail(s, t.uid);
    queueEvent(d, env, 'trailDeleted', { uid: t.uid });
    cut++;
  }
  if (cut > 0) S.rev += 1;
  queueEvent(d, env, 'sourceRemoved', { uid, reason: typeof reason === 'string' ? reason : '' });
}

/**
 * Reveal hexes (WP6 lost scout, WP7 boons). Grants scouting insight when `insight`; returns the number revealed.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number[]} hexes
 * @param {{ insight?: boolean }} [opts]
 * @returns {number}
 */
export function revealHexes(s, d, hexes, { insight = true } = {}) {
  if (!Array.isArray(hexes)) return 0;
  const S = s.run.surface;
  let n = 0;
  for (const h of hexes) {
    if (!isHex(h) || S.revealed[h]) continue;
    revealOne(s, d, h, insight !== false, null);
    n++;
  }
  if (n > 0) S.rev += 1;
  return n;
}

/**
 * Mark conquered hexes (WP5 conquest): conquered[h] = 1, rev++.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number[]} hexes
 * @returns {void}
 */
export function conquerHexes(s, d, hexes) {
  if (!Array.isArray(hexes)) return;
  const S = s.run.surface;
  for (const h of hexes) if (isHex(h)) S.conquered[h] = 1;
  S.rev += 1;
}

/**
 * Grant a hex won in a tournament (WP5): claimed[hex] = 1 without raising `claims`, rev++.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} hex
 * @returns {void}
 */
export function grantHex(s, d, hex) {
  if (!isHex(hex)) return;
  s.run.surface.claimed[hex] = 1;
  s.run.surface.rev += 1;
}

/**
 * Bump the surface revision (WP5: rival land changed).
 * @param {import('../core/types.js').State} s
 * @returns {void}
 */
export function touch(s) {
  s.run.surface.rev += 1;
}

/**
 * Add an entrance (WP3 nuptial, WP5 outpost, WP7 satellite). Duplicates (same kind, hex and ref) are ignored.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {'main'|'nuptial'|'satellite'|'outpost'} kind
 * @param {number} hex
 * @param {number} col nest shaft column (−1 for outposts)
 * @param {number} ref rival uid (outposts), satellite index, or −1
 * @returns {void}
 */
export function addEntrance(s, d, kind, hex, col, ref) {
  if (!ENTRANCE_KINDS.includes(kind) || !isHex(hex)) return;
  const S = s.run.surface;
  const c = Number.isInteger(col) ? col : -1;
  const r = Number.isInteger(ref) ? ref : -1;
  if (S.entrances.some((e) => e && e.kind === kind && e.hex === hex && e.ref === r)) return;
  S.entrances.push({ kind, hex, col: c, ref: r });
  S.rev += 1;
}

/**
 * Autobuyer step (WP7): buy one Mound level if allowed and affordable.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @returns {boolean} true if a level was bought
 */
export function autoMoundStep(s, d, env) {
  const cmd = { type: 'buyMound' };
  if (handlers.buyMound.validate(s, d, cmd) !== null) return false;
  handlers.buyMound.apply(s, d, cmd, env);
  return true;
}

// ------------------------------------------------------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------------------------------------------------------

/** Player commands owned by surface.js (ARCHITECTURE §9). */
export const handlers = {
  /** claimHex { hex }: pay now if affordable, otherwise open a channel. */
  claimHex: {
    validate(s, d, cmd) {
      return canClaim(s, d, cmd.hex);
    },
    apply(s, d, cmd, env) {
      const cost = claimCost(s);
      if (spend(s, cost)) doClaim(s, d, cmd.hex, env);
      else s.run.surface.channel = { hex: cmd.hex, paid: 0, cost: cost.pheromone };
    },
  },

  /** cancelChannel {}: refund everything paid into the channel (up to the pheromone cap). */
  cancelChannel: {
    validate(s) {
      return s.run.surface.channel ? null : 'notFound';
    },
    apply(s, d) {
      const ch = s.run.surface.channel;
      // ARCH-R: wallet.refund clamps at the pheromone cap, so a channel holding more than the cap refunds only up to it.
      refund(s, d, { pheromone: num(ch.paid) });
      s.run.surface.channel = null;
    },
  },

  /** flagHex { hex, on }: scouting priority flag (needs antennation). */
  flagHex: {
    validate(s, d, cmd) {
      if (!owns(s, 'antennation')) return 'locked';
      if (!isHex(cmd.hex) || cmd.hex >= hexesIn(s)) return 'invalid';
      if (typeof cmd.on !== 'boolean') return 'invalid';
      if (cmd.on && s.run.surface.revealed[cmd.hex]) return 'invalid:revealed';
      return null;
    },
    apply(s, d, cmd) {
      const f = s.run.surface.flagged;
      const i = f.indexOf(cmd.hex);
      if (cmd.on && i < 0) f.push(cmd.hex);
      if (!cmd.on && i >= 0) f.splice(i, 1);
    },
  },

  /** buyMound {}: next Mound level for soil (levels above MOUND.freeMax need mound_building). */
  buyMound: {
    validate(s) {
      if (!unlocked(s, 'mound')) return 'locked';
      if (num(s.run.surface.mound) >= MOUND.freeMax && !owns(s, 'mound_building')) return 'requirements';
      const cost = moundCost(s);
      if (!cost) return 'max';
      if (!canAfford(s, cost)) return 'cantAfford';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!spend(s, moundCost(s))) return;
      s.run.surface.mound += 1;
      env.emit('moundLeveled', { level: s.run.surface.mound });
    },
  },

  /** moveAphids { src, hex }: move an aphid colony onto an owned flower/leaf hex (aphid_shepherding); its trails re-route. */
  moveAphids: {
    validate(s, d, cmd) {
      if (!owns(s, 'aphid_shepherding')) return 'locked';
      if (!Number.isInteger(cmd.src)) return 'invalid';
      const src = sourceByUid(s, cmd.src);
      if (!src) return 'notFound';
      if (src.type !== 'aphid_colony') return 'invalid';
      if (!isHex(cmd.hex) || cmd.hex >= hexesIn(s) || cmd.hex === src.hex) return 'invalid';
      if (!d.surface.owned[cmd.hex]) return 'invalid:owned';
      const here = s.run.surface.sources.filter((x) => x.hex === cmd.hex && !(x.data && x.data.dormant));
      // ARCH-R: "owned plant hex" read as an owned hex holding a flower_patch or leaf_plant source; the colony then shares it.
      if (!here.some((x) => x.type === 'flower_patch' || x.type === 'leaf_plant')) return 'invalid:target';
      if (here.some((x) => x.type === 'aphid_colony')) return 'blocked';
      return null;
    },
    apply(s, d, cmd, env) {
      const S = s.run.surface;
      const src = sourceByUid(s, cmd.src);
      src.hex = cmd.hex;
      for (let i = S.trails.length - 1; i >= 0; i--) {
        const t = S.trails[i];
        if (t.src !== src.uid) continue;
        const r = trails.routeTrail(s, d, t.origin, src.hex, []);
        if (r && r.path.length >= 2) {
          t.path = r.path;
          t.len = r.len;
        } else {
          S.trails.splice(i, 1);
          trails.forgetTrail(s, t.uid);
          env.emit('trailDeleted', { uid: t.uid });
        }
      }
      S.rev += 1;
    },
  },
};
