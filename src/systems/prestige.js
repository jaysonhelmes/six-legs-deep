// Prestige layers: d.meta (prestige multipliers, colony scale, census, projections, requirement flags), the Nuptial
// Flight / landing / Supercolony / Speciation flows, startRun / newGame, heirlooms, satellites, strata, ending.
// Owner: WP7. Contract: ARCHITECTURE §8.6 (DESIGN §13–§16, §25.8).
// ARCH-R (startRun env): startRun(s, d, opts) has no env, but runStarted must be emitted; callers inside WP7 pass
//   opts.env (still one argument, so the arity stays 3) and startRun emits runStarted when it is present. newGame emits
//   nothing (core/game.js publishes 'reset').
// ARCH-R (run-scoped derived caches): after a prestige, d still holds the previous run's caches — rev-gated geometry
//   (a new run starts at nest.rev / surface.rev = 1, which may equal the cached rev, so it would never rebuild) and
//   last-tick rates (d.rates.food.gross sizes the new run's finite sources on its first tick, C34). startRun therefore
//   resets the run-scoped subtrees (ledger, nest, surface, stats, rates, combat, progress) to createDerived() defaults,
//   as core/game.js does on load / import / reset; d.season (the persistent clock), d.meta and d.offlineLog are kept.
//   doFlight does the same when it freezes the empty skeleton run behind the landing chooser.
// ARCH-R (boss detection): "Old Ridge / all 3 Front nests conquered this run" is read from s.run.rivals.list: a rival
//   of that type with fallenAt ≥ 0 and alive === false. Assumes WP5 keeps conquered rivals in the list (the fallenAt
//   field exists for that) and that a regrown Front nest gets alive = true again.
// ARCH-R (brood bank carry): PendingChoice gains `carryAdults` (adults kept by brood_bank, set by the flight, consumed
//   by chooseLanding) because s.run is reset at the flight. Kept adults return as minors (capped: false). Brood bank
//   applies to Flights (and Hardship starts) only, not to Supercolony / Speciation runs ("through a flight").
// ARCH-R (strata kinds): run-end bookkeeping pushes ONE record per finished run; a Supercolony marks it 'cycle' and a
//   Speciation 'era' instead of pushing a duplicate silhouette of the same nest.
// ARCH-R (daughters): only Flights found daughter colonies ({ seed: the finished run's seed, alates }); a merge resets
//   the cycle (and its daughters) anyway.
// ARCH-R (Peaceful Start): the no-raid effect uses id AND stat 'no_raids' so WP5 can test either hasEffect or effectsFor.

import { SOFTCAPS, CLAMP_MAX, GRID, HEX, CELL } from '../data/balance.js';
import {
  FLIGHT, LINEAGE, LINEAGE_LAY_EXP, SUPER, SPEC, PASSIVE, ACH_BONUS, ACH_META, HARDSHIP_ORDER, HARDSHIPS, SITES, SITE_ORDER,
  BOONS, BOON_ORDER, EDICTS, LANDING, RESET, FOUNDING_STORES, LANDING_USELESS, AUTO_FLIGHT,
} from '../data/prestige.js';
import { TRAITS } from '../data/bloodline.js';
import { FEDERATION } from '../data/federation.js';
import { GENOME, SPECIES, SIGNATURES } from '../data/genome.js';
import { CHAMBERS } from '../data/chambers.js';
import { BOSSES } from '../data/rivals.js';
import { INNATE } from '../data/research.js';
import { SEASON_MODS } from '../data/seasons.js';
import { createRun, createCycle, createEra, adultsTotal } from '../core/state.js';
import { createDerived } from '../core/derived.js';
import { scChain, clampNum } from '../core/math.js';
import { deriveSeed, randInt, shuffle } from '../core/rng.js';
import { addEffect, effectMult } from '../core/effects.js';
import { grant } from '../core/wallet.js';
import { countInRadius, hexDist } from '../core/hex.js';
import { rleDecode, bitsEncode } from '../core/save.js';
import * as mapgen from './mapgen.js';
import * as nestgen from './nestgen.js';
import * as trails from './trails.js';
import * as surface from './surface.js';
import * as nest from './nest.js';
import * as rivals from './rivals.js';
import * as research from './research.js';
import * as unlocks from './unlocks.js';
import * as seasons from './seasons.js';
import * as population from './population.js';
import { effectiveTier } from './hardships.js';

/** Federation nodes every era starts with when eusocial_leap is owned (DESIGN §15.5). */
const EUSOCIAL_NODES = Object.freeze(['automated_brood', 'blueprint_memory', 'autobuyers']);
/** Boss type ids (WP5 data keys) whose defeat gates the layer-2 / layer-3 prestiges. */
const OLD_RIDGE = 'old_ridge_supercolony';
const FRONT = 'great_rival';
/** Neutral species mods when the species is unknown. */
const NO_MODS = Object.freeze({});
/** Run-scoped derived subtrees reset at every run start (ARCH-R above). */
const RUN_CACHES = Object.freeze(['ledger', 'nest', 'surface', 'stats', 'rates', 'combat', 'progress']);

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

/** Finite, non-negative number or 0. */
function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Level of an id in a level map: a finite non-negative number, else 0. */
function lv(map, id) {
  const v = map ? map[id] : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** A multiplier kept finite for d: NaN → 1, above CLAMP_MAX → CLAMP_MAX. */
function mul(x) {
  if (Number.isNaN(x)) return 1;
  return x > CLAMP_MAX ? CLAMP_MAX : x;
}

/** fx object of a data-table entry, or {} while that table has no such entry (another package's stub). */
function fxOf(table, id) {
  const e = table && table[id];
  return (e && e.fx) || NO_MODS;
}

/** True for a plain (non-array) object. */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Lineage Λ from alates_cycle (DESIGN §13.3): a ≤ knee ? 1 + per × a : high × √(a / knee).
 * @param {number} a alates earned this cycle
 * @returns {number}
 */
export function lineage(a) {
  const x = num(a);
  return x <= LINEAGE.knee ? 1 + LINEAGE.per * x : LINEAGE.high * Math.sqrt(x / LINEAGE.knee);
}

/** Species mods of the current era (frozen object; {} when unknown). */
function speciesMods(s) {
  const sp = SPECIES[s.era.species];
  return (sp && sp.mods) || NO_MODS;
}

/** Number of satellite entrances on the surface. */
function satelliteCount(s) {
  const ents = s.run.surface.entrances;
  let n = 0;
  for (let i = 0; i < ents.length; i++) if (ents[i] && ents[i].kind === 'satellite') n++;
  return n;
}

/** True if a boss of this type was conquered this run (fallen and not alive). */
function bossFallen(r) {
  return !!r && r.alive === false && Number.isFinite(r.fallenAt) && r.fallenAt >= 0;
}

/** Old Ridge conquered this run (ARCH-R above). */
function oldRidgeConquered(s) {
  const list = s.run.rivals.list;
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].type === OLD_RIDGE && bossFallen(list[i])) return true;
  return false;
}

/** All Argentine Front nests (BOSSES.great_rival.nests) conquered at once this run. */
function frontBroken(s) {
  const list = s.run.rivals.list;
  const need = (BOSSES[FRONT] && BOSSES[FRONT].nests) || 1;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || r.type !== FRONT) continue;
    if (!bossFallen(r)) return false;
    n++;
  }
  return n >= need;
}

/** Weather factor W = max(season flightW, effect flight_w) (DESIGN §13.2). */
function flightW(s, d) {
  const season = d && d.season && d.season.mods && Number.isFinite(d.season.mods.flightW) ? d.season.mods.flightW : 1;
  return Math.max(season, effectMult(s, 'flight_w'));
}

/** Flight-alates multiplier: (1+K)^0.25 × 1.15^wide_wings × achievement A_bonus (DESIGN §13.2). */
function alatesMult(s) {
  const K = num(s.era.kinshipLife);
  let m = (1 + K) ** PASSIVE.kAlates * TRAITS.wide_wings.fx.mult ** lv(s.cycle.traits, 'wide_wings');
  const ach = s.meta.achievements;
  for (const id of Object.keys(ACH_META)) if (ach[id] !== undefined && ACH_META[id].alates) m *= ACH_META[id].alates;
  return mul(m);
}

// ---------------------------------------------------------------------------------------------------------------
// Projections and requirements
// ---------------------------------------------------------------------------------------------------------------

/**
 * Projected alates if the colony flew now (DESIGN §13.2):
 * floor(SC_alates(10 × √(fRun/1e8) × (1 + tPeak/400) × (1 + 0.02 × min(reared, 25|50)) × W × prestige.alates × (1 + 0.05 × deepVaultL))).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number}
 */
export function projectAlates(s, d) {
  return Math.floor(clampNum(alatesUnfloored(s, d, true)));
}

/**
 * The softcapped, unfloored alates projection; `weather` false leaves out the weather factor W (C166: the Auto-Flight
 * peak rule watches this weather-free value, so a season change or a Flight Day never looks like a falling rate).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {boolean} [weather=true]
 * @returns {number}
 */
export function alatesUnfloored(s, d, weather = true) {
  const run = s.run;
  const fRun = num(run.fRun);
  if (!(fRun > 0)) return 0;
  const court = lv(s.cycle.traits, 'royal_court') > 0;
  const reared = Math.min(num(run.colony.alatesReared), court ? FLIGHT.rearedMaxCourt : FLIGHT.rearedMax);
  const vaultL = d && d.nest && d.nest.agg ? num(d.nest.agg.deepVaultL) : 0;
  const vault = num(fxOf(CHAMBERS, 'deep_vault').alates) * vaultL;
  const raw = FLIGHT.base * (fRun / FLIGHT.div) ** FLIGHT.exp * (1 + num(run.tPeak) / FLIGHT.tPeakDiv)
    * (1 + FLIGHT.rearedPer * reared) * (weather ? flightW(s, d) : 1) * alatesMult(s) * (1 + vault);
  return num(scChain(raw, SOFTCAPS.alates).value);
}

/** Kinship for an alate total (DESIGN §14.2): floor(SC_kinship(2 × (alates / 1000)^0.35)). */
function kinshipOf(a) {
  if (!(a > 0)) return 0;
  return Math.floor(clampNum(scChain(SUPER.mult * (a / SUPER.div) ** SUPER.exp, SOFTCAPS.kinship).value));
}

/**
 * C168: the kinship formula's terms with the player's values. A Supercolony counts the merging run's projected alates
 * as if that run had flown: alates = alatesCycle (banked by flights) + projectAlates (this run).
 * nextAt = the alate total that gives one more kinship (null when past the softcap's reach of this search).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ banked: number, run: number, total: number, raw: number, softcapped: boolean, kinship: number, nextAt: number|null }}
 */
export function kinshipBreakdown(s, d) {
  const banked = num(s.cycle.alatesCycle);
  const run = projectAlates(s, d);
  const total = clampNum(banked + run);
  const raw = total > 0 ? SUPER.mult * (total / SUPER.div) ** SUPER.exp : 0;
  const sc = scChain(raw, SOFTCAPS.kinship);
  const kinship = kinshipOf(total);
  // Alates for kinship + 1, ignoring the softcap (1e5 kinship is far beyond a merge's reach); verified upward.
  let nextAt = SUPER.div * ((kinship + 1) / SUPER.mult) ** (1 / SUPER.exp);
  if (!Number.isFinite(nextAt) || nextAt > CLAMP_MAX) nextAt = null;
  else {
    nextAt = Math.ceil(nextAt);
    for (let i = 0; i < 8 && kinshipOf(nextAt) <= kinship; i++) nextAt = Math.ceil(nextAt * 1.0001 + 1);
  }
  return { banked, run, total, raw, softcapped: !!sc.capped, kinship, nextAt };
}

/**
 * Projected kinship of a merge now (DESIGN §14.2, C168): floor(SC_kinship(2 × ((alatesCycle + this run's projected
 * alates) / 1000)^0.35)).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number}
 */
export function projectKinship(s, d) {
  return kinshipOf(num(s.cycle.alatesCycle) + projectAlates(s, d));
}

/**
 * Projected genes of a Speciation now (DESIGN §15.2): floor(SC_genes(3 × √(kinshipLife / 100))).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number}
 */
export function projectGenes(s, d) {
  const k = num(s.era.kinshipLife);
  if (!(k > 0)) return 0;
  return Math.floor(clampNum(scChain(SPEC.mult * (k / SPEC.div) ** SPEC.exp, SOFTCAPS.genes).value));
}

/**
 * Flight requirements (DESIGN §13.1). Package-internal helper (also used by hardships / automation).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ ok: boolean, royal5: boolean, prep: boolean, chamber: boolean, fRun: boolean }}
 */
export function flightRequirements(s, d) {
  const agg = d && d.nest && d.nest.agg;
  const royal5 = !!agg && num(agg.royalL) >= FLIGHT.royalLevel;
  const prep = !!s.run.research.nuptial_preparation;
  const chamber = !!(agg && agg.nuptial && agg.nuptial.active);
  const fRun = num(s.run.fRun) >= FLIGHT.fRunMin;
  return { ok: royal5 && prep && chamber && fRun, royal5, prep, chamber, fRun };
}

/**
 * Supercolony requirements (DESIGN §14.1). Package-internal helper.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ ok: boolean, budding: boolean, alates: boolean, oldRidge: boolean }}
 */
export function superRequirements(s, d) {
  const budding = lv(s.cycle.traits, 'budding') > 0;
  const alates = num(s.cycle.alatesCycle) >= SUPER.alatesMin;
  const oldRidge = oldRidgeConquered(s);
  return { ok: budding && alates && oldRidge, budding, alates, oldRidge };
}

/**
 * Speciation requirements (DESIGN §15.1). Package-internal helper.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ ok: boolean, megacolony: boolean, front: boolean, kinship: boolean }}
 */
export function specRequirements(s, d) {
  const megacolony = lv(s.era.federation, 'megacolony') > 0;
  const front = frontBroken(s);
  const kinship = num(s.era.kinshipLife) >= SPEC.kinshipMin;
  return { ok: megacolony && front && kinship, megacolony, front, kinship };
}

/**
 * Pure mini-map preview of a landing option (render/minimap). Same generator as startRun, without traits/boon.
 * @param {number} seed
 * @param {string[]} tags
 * @returns {Object} MapGenResult
 */
export function landingPreview(seed, tags) {
  return mapgen.generateMap(seed >>> 0, { tags: Array.isArray(tags) ? tags.slice() : [] });
}

// ---------------------------------------------------------------------------------------------------------------
// derive / tick
// ---------------------------------------------------------------------------------------------------------------

/** d.meta skeleton (when a hand-built d lacks it). */
function ensureMeta(d) {
  if (!d.meta) d.meta = {};
  const m = d.meta;
  if (!m.prestige) m.prestige = { food: 1, dig: 1, insight: 1, honeydew: 1, leaves: 1, fungus: 1, chitin: 1, lay: 1, ap: 1, alates: 1 };
  if (!m.hardship) m.hardship = {};
  if (!m.proj) m.proj = { alates: 0, perMin: 0, kinship: 0, genes: 0 };
  const p = m.proj;
  if (!p.fly) p.fly = { ok: false, royal5: false, prep: false, chamber: false, fRun: false };
  if (!p.superc) p.superc = { ok: false, budding: false, alates: false, oldRidge: false };
  if (!p.spec) p.spec = { ok: false, megacolony: false, front: false, kinship: false };
  return m;
}

/**
 * Recompute d.meta (composition pinned in ARCHITECTURE §8.6): Λ, K, G, achievement multiplier, every prestige
 * multiplier, colony scale, census, effective hardship tiers, species mods and edict. Idempotent; cheap every tick.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 */
export function derive(s, d) {
  const m = ensureMeta(d);
  const tr = s.cycle.traits;
  const fed = s.era.federation;
  const gen = s.meta.genome;
  const sig = s.meta.signatureGenes;
  const ach = s.meta.achievements;
  const K = num(s.era.kinshipLife);
  const G = num(s.meta.genesLife);
  const lam = lineage(s.cycle.alatesCycle);
  const achCount = Object.keys(ach).length;
  const achMult = mul((lv(gen, 'fossil_record') > 0 ? ACH_BONUS.perFossil : ACH_BONUS.per) ** achCount);
  let sigAll = sig.sig_generalist ? SIGNATURES.sig_generalist.fx.all : 1;
  for (const id of Object.keys(ACH_META)) if (ach[id] !== undefined && ACH_META[id].all) sigAll *= ACH_META[id].all;
  const kO = (1 + K) ** PASSIVE.kOther;
  const gO = (1 + G) ** PASSIVE.gOther;
  const common = kO * gO * achMult * sigAll;
  const mono = HARDSHIPS.monomorphic.fx.worker ** effectiveTier(s, 'monomorphic');
  const hardy = TRAITS.hardy_workers.fx.mult ** lv(tr, 'hardy_workers');
  const p = m.prestige;
  p.food = mul(lam * hardy * (1 + K) ** PASSIVE.kFood * (1 + G) ** PASSIVE.gFood * achMult * mono * sigAll);
  p.dig = mul(TRAITS.deep_diggers.fx.mult ** lv(tr, 'deep_diggers') * common * mono);
  p.insight = mul(TRAITS.swarm_instinct.fx.mult ** lv(tr, 'swarm_instinct') * GENOME.ancient_instinct.fx.mult ** lv(gen, 'ancient_instinct')
    * common);
  p.honeydew = mul(hardy * (lv(tr, 'sweet_inheritance') > 0 ? TRAITS.sweet_inheritance.fx.mult : 1) * common * mono);
  p.leaves = mul(hardy * common * mono);
  p.fungus = mul(common * (sig.sig_fungal_farmers ? SIGNATURES.sig_fungal_farmers.fx.fungus : 1));
  p.chitin = mul(common);
  p.lay = mul(lam ** LINEAGE_LAY_EXP * TRAITS.fertile_queen.fx.mult ** lv(tr, 'fertile_queen')
    * GENOME.haplodiploid_fecundity.fx.mult ** lv(gen, 'haplodiploid_fecundity')
    * HARDSHIPS.claustral_founding.fx.lay ** effectiveTier(s, 'claustral_founding')
    * (sig.sig_polygyne ? SIGNATURES.sig_polygyne.fx.lay : 1));
  p.ap = mul((1 + G) ** PASSIVE.gAP);
  p.alates = alatesMult(s);
  m.colonyScale = mul(TRAITS.vast_galleries.fx.mult ** lv(tr, 'vast_galleries') * (1 + K) ** PASSIVE.kScale
    * FEDERATION.megacolony_galleries.fx.mult ** lv(fed, 'megacolony_galleries')
    * GENOME.colossal_nests.fx.mult ** lv(gen, 'colossal_nests')
    * GENOME.unicolonial_sprawl.fx.mult ** lv(gen, 'unicolonial_sprawl'));
  m.lineage = mul(lam);
  m.K = K;
  m.G = G;
  m.achCount = achCount;
  m.achMult = achMult;
  m.census = clampNum(adultsTotal(s) * (1 + RESET.censusPerSatellite * satelliteCount(s)));
  for (const id of HARDSHIP_ORDER) m.hardship[id] = effectiveTier(s, id);
  m.species = s.era.species;
  m.sp = speciesMods(s);
  m.edict = s.cycle.edict;
}

/**
 * Projections, requirement flags, the alates/min peak (run.prestige) and the Twenty Quadrillion ending.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 */
export function tick(s, d, dt, env) {
  const m = ensureMeta(d);
  const p = m.proj;
  const run = s.run;
  p.alates = projectAlates(s, d);
  p.perMin = run.time > 0 ? p.alates / (run.time / 60) : 0;
  p.kinship = projectKinship(s, d);
  p.genes = projectGenes(s, d);
  Object.assign(p.fly, flightRequirements(s, d));
  Object.assign(p.superc, superRequirements(s, d));
  Object.assign(p.spec, specRequirements(s, d));
  const pr = run.prestige;
  if (Number.isFinite(p.perMin) && p.perMin > pr.peakRate) {
    pr.peakRate = clampNum(p.perMin);
    pr.peakAt = run.time;
  }
  // C166 Auto-Flight peak rule: the weather-free, unfloored rate, its best this run, and since when it has been more
  // than (1 − AUTO_FLIGHT.drop) below that best (counted only from AUTO_FLIGHT.minSec; -1 = not below).
  // Saved peak/hold state only moves when time passes: a zero-time derive pass (load, import) must not change s.
  if (dt > 0) {
    const calm = run.time > 0 ? alatesUnfloored(s, d, false) / (run.time / 60) : 0;
    if (Number.isFinite(calm) && calm > num(pr.calmPeak)) pr.calmPeak = clampNum(calm);
    const below = run.time >= AUTO_FLIGHT.minSec && num(pr.calmPeak) > 0 && calm < AUTO_FLIGHT.drop * pr.calmPeak;
    if (!below) pr.belowAt = -1;
    else if (!(Number.isFinite(pr.belowAt) && pr.belowAt >= 0)) pr.belowAt = run.time;
  }
  // Ending: emitted once per derived cache while unacknowledged (the UI acknowledges with uiFlag 'ending').
  if (!env || env.offline || s.meta.flags.endingSeen || m._ending) return;
  if (num(m.census) >= RESET.endingCensus) {
    m._ending = true;
    env.emit('ending', {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Run start
// ---------------------------------------------------------------------------------------------------------------

/** Reset the run-scoped derived subtrees to createDerived() defaults (ARCH-R at the top of this file). */
function resetRunCaches(d) {
  if (!d) return;
  const fresh = createDerived();
  for (const k of RUN_CACHES) d[k] = fresh[k];
}

/** Keep only valid, unique landing-site tags. */
function validTags(tags) {
  const out = [];
  if (!Array.isArray(tags)) return out;
  for (const t of tags) if (typeof t === 'string' && SITES[t] && !out.includes(t)) out.push(t);
  return out;
}

/** JSON copy of plain data produced by another package (sources), so the state owns fresh objects. */
function plainCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

/** Copy finite fractions for the keys present in `dst` from `src` (C39 carry of player targets). */
function copyTargets(dst, src, zeroKeys = null) {
  if (!isObj(src)) return;
  for (const k of Object.keys(dst)) {
    const v = src[k];
    if (Number.isFinite(v) && v >= 0) dst[k] = v + 0;
    if (zeroKeys && zeroKeys.includes(k)) dst[k] = 0;
  }
}

/**
 * Start a fresh run (ARCHITECTURE §8.6): createRun(seed), map, crumb trail, nest, rivals, innate research,
 * persistent unlocks, Founding Stores, carried adults, nanitics, automation carry (C39), boons, blueprint.
 * opts = { seed, tags = [], boon = null, hardship = null, startSeason = null, carryAdults = 0, env = null }.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {{ seed: number, tags?: string[], boon?: string|null, hardship?: string|null, startSeason?: string|null, carryAdults?: number, env?: import('../core/types.js').Env|null }} opts
 */
export function startRun(s, d, opts) {
  const o = opts || {};
  const seed = Number.isFinite(o.seed) ? o.seed >>> 0 : 1;
  resetRunCaches(d);
  const run = createRun(seed);
  run.index = Math.floor(num(s.meta.counters.runs));
  s.meta.counters.runs = run.index + 1;
  run.hardship = typeof o.hardship === 'string' && HARDSHIPS[o.hardship] ? o.hardship : null;
  run.landingTags = validTags(o.tags);
  run.boon = typeof o.boon === 'string' && BOONS[o.boon] ? o.boon : null;
  s.run = run;
  derive(s, d); // fresh d.meta (K, M_insight, species) for the boons below

  const tr = s.cycle.traits;
  const fed = s.era.federation;
  const sp = speciesMods(s);

  // Surface: generated map, revealed rings, then the starting crumb trail (it takes 1 of the 3 base slots).
  const map = mapgen.generateMap(run.mapSeed, { tags: run.landingTags.slice(), boon: run.boon, traits: plainCopy(tr), species: s.era.species }) || {};
  const surf = run.surface;
  if (Array.isArray(map.terrain) && map.terrain.length === HEX.count) surf.terrain = map.terrain.slice();
  if (Array.isArray(map.sources)) surf.sources = plainCopy(map.sources);
  if (Number.isFinite(map.nextUid) && map.nextUid >= 1) surf.nextUid = Math.floor(map.nextUid);
  const rings = Number.isFinite(map.revealRings) ? Math.max(0, Math.min(HEX.maxRadius, Math.floor(map.revealRings))) : 0;
  const nReveal = countInRadius(rings);
  const extra = [];
  for (let i = 0; i < nReveal; i++) if (!surf.revealed[i]) extra.push(i);
  if (extra.length > 0) {
    surface.revealHexes(s, d, extra, { insight: false });
    for (const i of extra) surf.revealed[i] = 1;
    surf.rev++;
  }
  surf.trails = [];
  const crumb = surf.sources.find((src) => src && src.type === 'crumb_scatter');
  if (crumb) trails.createTrail(s, d, 0, crumb.uid);

  // Nest.
  const royalCount = Number.isFinite(sp.royalStart) && sp.royalStart > 0 ? sp.royalStart : 1;
  const genNest = nestgen.generateNest(run.seed, {
    tags: run.landingTags.slice(), rootCols: Array.isArray(map.rootCols) ? map.rootCols.slice() : [], royalCount });
  if (genNest && Array.isArray(genNest.cells) && genNest.cells.length === GRID.cols * GRID.rows) run.nest = plainCopy(genNest);

  rivals.spawnInitial(s, d, Array.isArray(map.rivalSpecs) ? map.rivalSpecs.slice() : []);
  research.grantInnate(s);
  unlocks.onRunStart(s, d);

  // Founding Stores: written directly (may exceed the cap; not counted in fRun, C43).
  const fsL = Math.min(Math.floor(lv(tr, 'founding_stores')), FOUNDING_STORES.length - 1);
  const store = FOUNDING_STORES[fsL];
  if (store) {
    run.res.food = clampNum(run.res.food + num(store.food));
    run.res.soil = clampNum(run.res.soil + num(store.soil));
  }
  const carry = Math.floor(num(o.carryAdults));
  if (carry > 0) population.addAdults(s, d, 'minor', carry, { capped: false });
  if (lv(tr, 'nanitic_vigor') > 0) run.colony.naniticsLeft = TRAITS.nanitic_vigor.fx.eggs;

  // Automation carry (C39, C166): job targets with automaton_instincts or automated_brood; automatic jobs (ratio +
  // thresholds) are innate with automated_brood only. Automaton Instincts switches the modes on when they are known this
  // run anyway (Age Polyethism / Response Thresholds, e.g. Innate); caste targets carry with automated_brood.
  const brood = lv(fed, 'automated_brood') > 0;
  const keep = s.meta.automation.keep || {};
  if (brood || lv(tr, 'automaton_instincts') > 0) {
    copyTargets(run.colony.jobTargets, keep.jobTargets);
    run.colony.autoJobs = brood || !!run.research.age_polyethism;
    run.colony.thresholdJobs = brood || !!run.research.response_thresholds;
  }
  // C151: caste target counts + "Keep berths filled" flags. keep.casteFill holds a boolean only for castes the player
  // set; those (and any caste with a carried target > 0) count as set this run, so the first Barracks / War Hall does
  // not override them. A legacy share preset (keep.casteTargets) carries as "Keep berths filled" for each caste with a
  // share.
  if (lv(fed, 'automated_brood') > 0) {
    const col = run.colony;
    const zero = run.hardship === 'monomorphic' ? Object.keys(col.casteGoals)
      : run.hardship === 'pacifist' ? ['soldier', 'supermajor'] : [];
    let fill = isObj(keep.casteFill) ? keep.casteFill : null;
    if (isObj(keep.casteGoals)) copyTargets(col.casteGoals, keep.casteGoals, zero);
    else if (isObj(keep.casteTargets)) {
      fill = {};
      for (const k of Object.keys(col.casteFill)) if (Number.isFinite(keep.casteTargets[k]) && keep.casteTargets[k] > 0) fill[k] = true;
    }
    for (const k of Object.keys(col.casteFill)) {
      col.casteGoals[k] = Math.floor(col.casteGoals[k]);
      const set = (fill && typeof fill[k] === 'boolean') || col.casteGoals[k] > 0;
      if (!set) continue;
      col.casteFill[k] = !!(fill && fill[k] === true) && !zero.includes(k);
      col.casteTouched[k] = true;
    }
  }

  // Founding Boon.
  const K = num(s.era.kinshipLife);
  if (run.boon === 'boon_chitin_hoard') grant(s, d, 'chitin', BOONS.boon_chitin_hoard.fx.chitin * (1 + K) ** PASSIVE.kOther);
  if (run.boon === 'boon_insight_cache') grant(s, d, 'insight', BOONS.boon_insight_cache.fx.insight * d.meta.prestige.insight);
  if (run.boon === 'boon_royal_vigor') {
    addEffect(s, { id: 'boon_royal_vigor', stat: 'lay', mult: BOONS.boon_royal_vigor.fx.lay, t: BOONS.boon_royal_vigor.fx.sec });
  }
  if (run.boon === 'boon_peaceful_start') addEffect(s, { id: 'no_raids', stat: 'no_raids', t: BOONS.boon_peaceful_start.fx.sec });
  if (run.boon === 'boon_long_spring') seasons.addExtraSpring(s, BOONS.boon_long_spring.fx.sec);
  const oldTrails = run.boon === 'boon_old_trails';
  const remembered = lv(tr, 'remembered_paths') > 0;
  if (oldTrails || remembered) {
    const count = Math.max(oldTrails ? BOONS.boon_old_trails.fx.trails : 0, remembered ? TRAITS.remembered_paths.fx.trails : 0);
    trails.autoDraw(s, d, count, oldTrails ? 1 : TRAITS.remembered_paths.fx.strength);
  }

  // Starting season: the landing's Seasonal Wisdom pick, else the Chronobiology starting season (F17: applied here at
  // run start, never by jumping the running clock).
  const startSeason = typeof o.startSeason === 'string' && Object.prototype.hasOwnProperty.call(SEASON_MODS, o.startSeason)
    ? o.startSeason : seasons.chronoStart(s);
  if (startSeason) seasons.setSeason(s, startSeason);
  if (Number.isInteger(s.era.activeBlueprint) && s.era.activeBlueprint >= 0 && s.era.blueprints[s.era.activeBlueprint]) {
    nest.applyBlueprint(s, d);
  }
  if (o.env && typeof o.env.emit === 'function') o.env.emit('runStarted', { index: run.index });
}

/**
 * The very first run of a new game (core/game.js): startRun with seed = deriveSeed(s).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 */
export function newGame(s, d) {
  s.cycle.startedAt = s.meta.simTime;
  s.era.startedAt = s.meta.simTime;
  startRun(s, d, { seed: deriveSeed(s) });
}

// ---------------------------------------------------------------------------------------------------------------
// Run end and prestige flows
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run-end bookkeeping shared by Flight, Hardship start, Supercolony and Speciation (always before any reset):
 * innate research run counts (C44), one strata record, a daughter colony for flights.
 * `gain` = the currency the reset awards (alates for a flight, kinship for a Supercolony, genes for a Speciation).
 */
function runEndBookkeeping(s, kind, gain) {
  const era = s.era;
  const need = lv(s.cycle.traits, 'ancestral_memory') > 0 ? TRAITS.ancestral_memory.fx.runs : INNATE.runs;
  const spInnate = Array.isArray(speciesMods(s).innate) ? speciesMods(s).innate : [];
  for (const id of Object.keys(s.run.research)) {
    if (!s.run.research[id] || era.innate[id] || spInnate.includes(id)) continue;
    era.researchRuns[id] = Math.floor(lv(era.researchRuns, id)) + 1;
    if (era.researchRuns[id] >= need) era.innate[id] = true;
  }
  const strata = s.meta.strata;
  strata.push({ kind, cells: strataSilhouette(s.run.nest.cells), at: s.meta.simTime, ...strataMeta(s, gain) });
  while (strata.length > RESET.strataMax) strata.shift();
  compactStrata(strata);
  if (kind === 'run') {
    const dau = s.cycle.daughters;
    dau.push({ seed: s.run.seed >>> 0, alates: gain });
    while (dau.length > RESET.daughtersMax) dau.shift();
  }
}

/**
 * C130: run metadata kept on a Strata record for the Colony History gallery (Prestige tab). Short keys (save size):
 * n = run number (1-based), sp = species, dur = run seconds, peak = peak adults, gain = currency awarded (alates /
 * kinship / genes by record kind), date = wall-clock minutes since the epoch (meta.lastSeen, ≤ one autosave old),
 * hs = the run's Hardship (only when set). Older records have none of these; the gallery shows what a record has.
 * @param {import('../core/types.js').State} s
 * @param {number} gain
 * @returns {Object}
 */
export function strataMeta(s, gain) {
  const run = s.run;
  const out = {
    n: Math.max(1, Math.floor(num(run.index)) + 1),
    sp: typeof s.era.species === 'string' ? s.era.species : 'garden_ant',
    dur: Math.max(0, Math.round(num(run.time))),
    peak: Math.max(0, Math.round(Math.max(num(run.stats && run.stats.maxAdults), adultsTotal(s)))),
    gain: Math.max(0, Number(clampNum(num(gain)).toPrecision(4))),
  };
  const seen = num(s.meta.lastSeen);
  if (seen > 0) out.date = Math.round(seen / 60000);
  if (typeof run.hardship === 'string' && run.hardship) out.hs = run.hardship;
  return out;
}

/** True for an open nest cell (tunnel or chamber): the part of a nest a Strata fossil shows. */
function isOpenCell(c) {
  return c === CELL.TUNNEL || c === CELL.CHAMBER;
}

/**
 * Strata record cells (F26, ARCHITECTURE §18): the nest silhouette (open cells) packed with core/save bitsEncode,
 * ≤ ⌈cols × rows / 6⌉ characters whatever the nest looks like. The renderer only draws open cells, so nothing is lost.
 * @param {number[]} cells
 * @returns {string}
 */
export function strataSilhouette(cells) {
  const n = Array.isArray(cells) ? cells.length : 0;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (isOpenCell(cells[i])) mask[i] = 1;
  return bitsEncode(mask);
}

/** Re-pack older RLE strata records (full cell codes) as silhouettes; a malformed record is dropped. */
function compactStrata(strata) {
  for (let i = strata.length - 1; i >= 0; i--) {
    const rec = strata[i];
    if (!rec || typeof rec.cells !== 'string' || !rec.cells.startsWith('rle:')) continue;
    try {
      rec.cells = strataSilhouette(rleDecode(rec.cells));
    } catch {
      strata.splice(i, 1);
    }
  }
}

/**
 * C147: the landing-site tags and Founding Boons a landing may offer under a Hardship (null = a normal run): the full
 * draw orders minus LANDING_USELESS[hardship]. Pure; the draw stays seeded from the main RNG.
 * @param {string|null} hardship
 * @returns {{ sites: string[], boons: string[] }}
 */
export function landingPool(hardship) {
  const skip = typeof hardship === 'string' && Object.prototype.hasOwnProperty.call(LANDING_USELESS, hardship) ? LANDING_USELESS[hardship] : null;
  const sites = skip ? SITE_ORDER.filter((id) => !skip.sites.includes(id)) : SITE_ORDER.slice();
  const boons = skip ? BOON_ORDER.filter((id) => !skip.boons.includes(id)) : BOON_ORDER.slice();
  return { sites, boons };
}

/**
 * Landing chooser for a flight (3 seeded options with 1–2 tags, 3 boons), drawn from the main RNG. Options useless
 * under the coming Hardship are never drawn (landingPool, C147), and Eternal Winter offers no starting season.
 */
function buildPending(s, alates, hardship, carryAdults, adults) {
  const hs = typeof hardship === 'string' && HARDSHIPS[hardship] ? hardship : null;
  const pool = landingPool(hs);
  const options = [];
  for (let i = 0; i < LANDING.options; i++) {
    const seed = deriveSeed(s);
    const n = randInt(s, LANDING.tagsMin, LANDING.tagsMax);
    options.push({ seed, tags: shuffle(s, pool.sites.slice()).slice(0, n) });
  }
  const boons = shuffle(s, pool.boons.slice()).slice(0, LANDING.boons);
  return { kind: 'landing', options, boons, chooseSeason: lv(s.cycle.traits, 'seasonal_wisdom') > 0 && hs !== 'eternal_winter', alates,
    hardship: hs, carryAdults, adults };
}

/**
 * C171: adults the Brood Bank carries into the landing, recomputed when the landing is chosen so a Brood Bank bought in
 * the landing chooser applies to that landing. pending.adults = adults at the flight; older pendings without it keep
 * the carryAdults stored at the flight.
 * @param {import('../core/types.js').State} s
 * @param {Object} p meta.pending (kind 'landing')
 * @returns {number}
 */
export function landingCarry(s, p) {
  if (!p) return 0;
  if (!Number.isFinite(p.adults)) return Math.floor(num(p.carryAdults));
  return lv(s.cycle.traits, 'brood_bank') > 0 ? Math.floor(Math.min(RESET.broodBankMax, RESET.broodBankFrac * num(p.adults))) : 0;
}

/**
 * The Nuptial Flight (fly handler, hardships.startHardship, auto-flight): award alates, run-end bookkeeping, flight
 * stats, brood bank, open the landing chooser (meta.pending), freeze an empty run, emit flightComplete.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @param {{ hardship?: string|null }} [opts]
 * @returns {number} alates awarded
 */
export function doFlight(s, d, env, { hardship = null } = {}) {
  const alates = projectAlates(s, d);
  const run = s.run;
  const meta = s.meta;
  s.cycle.alates = clampNum(s.cycle.alates + alates);
  s.cycle.alatesCycle = clampNum(s.cycle.alatesCycle + alates);
  meta.counters.alatesLife = clampNum(meta.counters.alatesLife + alates);
  meta.counters.flights++;
  const adults = adultsTotal(s);
  runEndBookkeeping(s, 'run', alates);
  const st = meta.stats;
  if (!(st.fastestFlightSec > 0) || run.time < st.fastestFlightSec) st.fastestFlightSec = run.time;
  if (!(st.firstFlightAt > 0)) st.firstFlightAt = meta.simTime;
  const carry = lv(s.cycle.traits, 'brood_bank') > 0 ? Math.floor(Math.min(RESET.broodBankMax, RESET.broodBankFrac * adults)) : 0;
  meta.pending = buildPending(s, alates, hardship, carry, Math.floor(num(adults)));
  s.run = createRun(0);
  resetRunCaches(d); // the frozen skeleton run is shown with neutral caches while the landing chooser is open
  if (env && typeof env.emit === 'function') env.emit('flightComplete', { alates });
  return alates;
}

/**
 * Supercolony (supercolony handler, auto-supercolony): run-end bookkeeping, kinship award, signature gene, new cycle
 * keeping the Heirloom traits, the chosen edict, a fresh run. opts = { edict }.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @param {{ edict: string|null }} opts
 * @returns {number} kinship awarded
 */
export function doSupercolony(s, d, env, opts) {
  const o = opts || {};
  const edict = typeof o.edict === 'string' && EDICTS[o.edict] ? o.edict : null;
  const kin = projectKinship(s, d);
  const runAlates = projectAlates(s, d); // C168: the merging run's alates count as if it had flown
  const meta = s.meta;
  const era = s.era;
  runEndBookkeeping(s, 'cycle', kin);
  meta.counters.alatesLife = clampNum(meta.counters.alatesLife + runAlates);
  // C167: Innate research and its per-node run counts reset at every Supercolony (Genetic Memory protects them only
  // at a Speciation). Cleared after the bookkeeping above, which counts this run first.
  era.innate = {};
  era.researchRuns = {};
  era.kinship = clampNum(era.kinship + kin);
  era.kinshipLife = clampNum(era.kinshipLife + kin);
  meta.counters.kinshipEver = clampNum(meta.counters.kinshipEver + kin);
  meta.counters.supercolonies++;
  const sp = SPECIES[era.species];
  if (sp && sp.sig && SIGNATURES[sp.sig]) meta.signatureGenes[sp.sig] = true;
  const kept = {};
  if (lv(era.federation, 'heirloom_bloodline') > 0) {
    for (const id of era.heirlooms) if (TRAITS[id] && lv(s.cycle.traits, id) > 0) kept[id] = s.cycle.traits[id];
  }
  s.cycle = createCycle();
  s.cycle.traits = kept;
  s.cycle.edict = edict;
  s.cycle.startedAt = meta.simTime;
  if (!(meta.stats.firstSuperAt > 0)) meta.stats.firstSuperAt = meta.simTime;
  startRun(s, d, { seed: deriveSeed(s), env });
  if (env && typeof env.emit === 'function') env.emit('supercolonyComplete', { kinship: kin });
  return kin;
}

/** Speciation: run-end bookkeeping, genes award, new era (genetic_memory / eusocial_leap), new cycle, fresh run. */
function doSpeciation(s, d, env, species) {
  const g = projectGenes(s, d);
  const meta = s.meta;
  runEndBookkeeping(s, 'era', g);
  meta.genes = clampNum(meta.genes + g);
  meta.genesLife = clampNum(meta.genesLife + g);
  meta.counters.speciations++;
  const keepInnate = lv(meta.genome, 'genetic_memory') > 0;
  const innate = keepInnate ? { ...s.era.innate } : {};
  const runs = keepInnate ? { ...s.era.researchRuns } : {};
  s.era = createEra();
  s.era.species = species;
  s.era.innate = innate;
  s.era.researchRuns = runs;
  s.era.startedAt = meta.simTime;
  if (lv(meta.genome, 'eusocial_leap') > 0) for (const id of EUSOCIAL_NODES) if (FEDERATION[id]) s.era.federation[id] = 1;
  s.cycle = createCycle();
  s.cycle.startedAt = meta.simTime;
  if (!(meta.stats.firstSpecAt > 0)) meta.stats.firstSpecAt = meta.simTime;
  startRun(s, d, { seed: deriveSeed(s), env });
  if (env && typeof env.emit === 'function') env.emit('speciationComplete', { genes: g });
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------------------------

/** Satellite placement constraints (hex owned and ≥ minDist from entrances; column ≥ colGap from shafts). */
function satelliteReason(s, d, hex, col) {
  const L = lv(s.era.federation, 'satellite_nest');
  const sats = satelliteCount(s);
  if (L <= sats) return L > 0 ? 'max' : 'locked';
  if (!Number.isInteger(hex) || hex < 0 || hex >= HEX.count) return 'invalid:hex';
  if (!Number.isInteger(col) || col < 0 || col >= GRID.cols) return 'invalid:col';
  const owned = d && d.surface && d.surface.owned;
  if (!owned || !(owned[hex] > 0)) return 'blocked:unowned';
  const passable = d.surface.passable;
  if (passable && passable[hex] === 0) return 'blocked:terrain';
  const fx = FEDERATION.satellite_nest.fx;
  const ents = s.run.surface.entrances;
  for (const e of ents) {
    if (!e) continue;
    if (Number.isInteger(e.hex) && e.hex >= 0 && hexDist(e.hex, hex) < fx.minDist) return 'blocked:entrance';
    if (Number.isInteger(e.col) && e.col >= 0 && Math.abs(e.col - col) < fx.colGap) return 'blocked:shaft';
  }
  for (const sh of s.run.nest.shafts) {
    if (sh && Number.isInteger(sh.col) && Math.abs(sh.col - col) < fx.colGap) return 'blocked:shaft';
  }
  // C66: the satellite shaft may not take the Royal Chamber's last room to reach the Flight level (Royal L5).
  if (nest.shaftBoxesRoyal(s, d, col)) return 'blocked:royalRoom';
  return null;
}

/** Commands owned by WP7 prestige (ARCHITECTURE §9). */
export const handlers = {
  /** fly {}: Nuptial Flight. */
  fly: {
    validate(s, d) {
      return flightRequirements(s, d).ok ? null : 'requirements';
    },
    apply(s, d, cmd, env) {
      doFlight(s, d, env);
    },
  },

  /** chooseLanding { index, boon, season? }: allowed while paused; starts the next run. */
  chooseLanding: {
    validate(s, d, cmd) {
      const p = s.meta.pending;
      if (!isObj(p) || p.kind !== 'landing' || !Array.isArray(p.options)) return 'invalid';
      if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= p.options.length || !isObj(p.options[cmd.index])) {
        return 'invalid:index';
      }
      const boons = Array.isArray(p.boons) ? p.boons : [];
      if (boons.length > 0 ? !(typeof cmd.boon === 'string' && boons.includes(cmd.boon)) : cmd.boon != null) return 'invalid:boon';
      if (cmd.season != null) {
        if (!p.chooseSeason) return 'locked';
        if (typeof cmd.season !== 'string' || !Object.prototype.hasOwnProperty.call(SEASON_MODS, cmd.season)) return 'invalid:season';
      }
      return null;
    },
    apply(s, d, cmd, env) {
      const p = s.meta.pending;
      const opt = p.options[cmd.index];
      s.meta.pending = null;
      startRun(s, d, {
        seed: opt.seed, tags: opt.tags, boon: cmd.boon ?? null, hardship: p.hardship ?? null,
        startSeason: p.chooseSeason && typeof cmd.season === 'string' ? cmd.season : null, carryAdults: landingCarry(s, p), env,
      });
    },
  },

  /** supercolony { edict }: merge into a supercolony. */
  supercolony: {
    validate(s, d, cmd) {
      if (!superRequirements(s, d).ok) return 'requirements';
      if (typeof cmd.edict !== 'string' || !EDICTS[cmd.edict]) return 'invalid:edict';
      return null;
    },
    apply(s, d, cmd, env) {
      doSupercolony(s, d, env, { edict: cmd.edict });
    },
  },

  /** speciate { species }: Speciation into an unlocked species. */
  speciate: {
    validate(s, d, cmd) {
      if (!specRequirements(s, d).ok) return 'requirements';
      if (typeof cmd.species !== 'string' || !SPECIES[cmd.species]) return 'invalid:species';
      if (s.meta.speciesUnlocked[cmd.species] !== true) return 'locked';
      return null;
    },
    apply(s, d, cmd, env) {
      doSpeciation(s, d, env, cmd.species);
    },
  },

  /** setHeirlooms { ids }: ≤ 3 owned Bloodline traits kept through Supercolonies (heirloom_bloodline). */
  setHeirlooms: {
    validate(s, d, cmd) {
      if (!(lv(s.era.federation, 'heirloom_bloodline') > 0)) return 'locked';
      const ids = cmd.ids;
      if (!Array.isArray(ids)) return 'invalid';
      if (ids.length > FEDERATION.heirloom_bloodline.fx.keep) return 'max';
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (typeof id !== 'string' || !TRAITS[id] || ids.indexOf(id) !== i) return 'invalid:id';
        if (!(lv(s.cycle.traits, id) > 0)) return 'locked';
      }
      return null;
    },
    apply(s, d, cmd) {
      s.era.heirlooms = cmd.ids.slice();
    },
  },

  /** placeSatellite { hex, col }: a satellite entrance (functional at once) and its shaft (queued, C8). */
  placeSatellite: {
    validate(s, d, cmd) {
      return satelliteReason(s, d, cmd.hex, cmd.col);
    },
    apply(s, d, cmd) {
      const index = satelliteCount(s);
      surface.addEntrance(s, d, 'satellite', cmd.hex, cmd.col, index);
      nest.queueShaft(s, d, cmd.col, 'satellite', index);
    },
  },
};
