// Random events: Poisson scheduler with pity rules, the 28 events of DESIGN §18.2, event cards, event processes
// (s.run.events.active) and clickable/visible event objects (s.run.events.objects).
// Owner: WP6. Contract: ARCHITECTURE §8.5 (events.js), §4 (s.run.events), §7.7 (effect stats), DESIGN §18.
// Frozen offline (DESIGN §21.4 "Events … frozen"): with env.offline nothing in this module runs, so no event harms the
// colony offline (card timers, processes and objects resume on return). Harmful event effects (mold spots, drought,
// flood, sealed entrance …) are also lifted for each offline step and put back afterwards, timers unchanged (C68:
// suspendOffline / resumeOffline, called by core/step.js); helpful ones keep running offline as before.
// ARCH-R: ev_termite_swarm ("within 2 min after a rainstorm (50 %)") is a follow-up: each rainstorm rolls 50 % and, on
//   success, fires the swarm at a uniform time within the next 120 s. The scheduler never picks it on its own.
// ARCH-R: "Reroute* (free)" (horned lizard) has no reroute cross-call; the default resolves the threat with no losses
//   (the colony walks round the lizard). Rerouting the trail away from the lizard / antlion hex also ends the threat.
// ARCH-R: "a trail ≥ 4 hexes" counts the hexes walked from the origin (path.length − 1); the antlion and lizard sit on
//   a hex strictly between the origin and the source, so rerouting can avoid them.
// ARCH-R: myrmecophile "50 % chance it then eats 5 % of brood over 60 s" — the eating happens in the 60 s after the
//   10-minute bonus ends. Cordyceps: the infected (1 % of foragers × 1.5/min) die when the 3-minute outbreak ends.
//   Its eventResolved choice is 'averted' when those deaths stay under num.avertLoss of the foragers at its start
//   (e.g. foragers moved off the job), else 'ended'; quarantine and averted both earn ach_zombie_averted.
// ARCH-R: mold spreads +1 spot per 60 s per outbreak while any of its spots is unscraped, capped at num.maxSpots live
//   spots in total (a safety cap DESIGN does not state).
// ARCH-R: event food rewards use the one-shot overflow rule of DESIGN §3 (up to 2× cap).
// C74: a mold spot follows its chamber: when the chamber is gone (demolished) the spot and its 'mold:<uid>' effect are
//   removed; when the chamber moved (relocated) the spot moves into the new footprint (same offset, wrapped). Swept at
//   the start of every online events.tick (commands run before the systems, so it happens on the same tick).
// C75: in run 1 the gap to the next random event is capped at EVENT_GAP.firstRunMaxSec (one draw, so the RNG stream
//   is unchanged); later runs use the plain exponential draw.
// F2: from Mound L5 a Footstep cannot hit the 7 hexes of the main entrance (DESIGN §8.7) nor any other entrance hex.
// ARCH-R: fully harvesting a fallen fruit / picnic is detected here (eventResolved choice 'harvested') because
//   sourceRemoved reasons are not pinned: the tracked source vanished while it had been worked by a trail and its last
//   observed stock was ≤ max(harvestFrac × max, two ticks of drain).

import { EVENT_RULES, EVENT_ORDER, EVENTS, EVENT_GAP, OUTCOMES } from '../data/events.js';
import { FROST } from '../data/seasons.js';
import { GRID } from '../data/balance.js';
import { CHAMBERS } from '../data/chambers.js';
import { RESEARCH } from '../data/research.js';
import { BOSSES } from '../data/rivals.js';
import { MOUND, TERRAIN, TERRAIN_ORDER, EXPEDITION } from '../data/surface.js';
import { SPECIES } from '../data/genome.js';
import { randInt, randRange, chance, pick, weighted, expSample } from '../core/rng.js';
import { addEffect, removeEffect, hasEffect, effectsFor } from '../core/effects.js';
import { grant, incomeSeconds, spend } from '../core/wallet.js';
import { adultsTotal, broodTotal, clickAvailable, consumeClick } from '../core/state.js';
import { ringOf, neighbors, countInRadius } from '../core/hex.js';
import { lvl } from '../core/math.js';
import * as surface from './surface.js';
import * as trails from './trails.js';
import * as population from './population.js';
import * as rivals from './rivals.js';
import * as nest from './nest.js';
import * as combat from './combat.js';

/** Object kinds the player may click through clickEventObject. */
const CLICKABLE = new Set(['ladybug', 'footstep', 'rival_alate', 'golden_aphid', 'fossil_cache', 'lost_queen']);
/** Clickable kinds that yield resources (refused under claustral_founding, C32). */
const YIELDING = new Set(['rival_alate', 'golden_aphid', 'fossil_cache']);

// ------------------------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------------------------

/** Finite number or 0. */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** Research owned this run. */
function owns(s, id) {
  return !!(s.run.research && s.run.research[id]);
}

/** Guarded fx lookup in a data table (undefined while the owner's table is not loaded). */
function fxOf(table, id, key) {
  const e = table && table[id];
  const v = e && e.fx ? e.fx[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Current season id (d.season is filled by seasons.tick earlier in the step). */
function seasonId(d) {
  return d && d.season && typeof d.season.id === 'string' ? d.season.id : 'spring';
}

/** Species with rafts (fire ants): rainstorms raise forage instead of offering the seal/keep card. */
function hasRafts(s) {
  const sp = SPECIES && SPECIES[s.era.species];
  return !!(sp && sp.mods && sp.mods.rafts);
}

/** True if this run is a claustral_founding hardship run. */
function claustral(s) {
  return s.run.hardship === 'claustral_founding';
}

/** Next event uid (cards, processes and objects share the counter). */
function nextUid(s) {
  const ev = s.run.events;
  const u = Number.isFinite(ev.nextUid) && ev.nextUid >= 1 ? Math.floor(ev.nextUid) : 1;
  ev.nextUid = u + 1;
  return u;
}

/** Source by uid. */
function findSrc(s, uid) {
  const list = s.run.surface.sources;
  for (let i = 0; i < list.length; i++) if (list[i].uid === uid) return list[i];
  return null;
}

/** Trail by uid. */
function findTrail(s, uid) {
  const list = s.run.surface.trails;
  for (let i = 0; i < list.length; i++) if (list[i].uid === uid) return list[i];
  return null;
}

/** Effective workers of a trail (d.surface.trails when filled, else the explicit count). */
function trailWorkers(s, d, trail) {
  const dl = d && d.surface && Array.isArray(d.surface.trails) ? d.surface.trails : [];
  for (let i = 0; i < dl.length; i++) if (dl[i] && dl[i].uid === trail.uid) return num(dl[i].workers);
  return num(trail.workers);
}

/** Aphid colonies currently herded: [{ trail, src }]. */
function herdedAphids(s, d) {
  const out = [];
  for (const t of s.run.surface.trails) {
    if (t.job !== 'herder') continue;
    const src = findSrc(s, t.src);
    if (!src || src.type !== 'aphid_colony') continue;
    if (trailWorkers(s, d, t) > 0) out.push({ trail: t, src });
  }
  return out;
}

/** Hexes inside the current map radius. */
function radiusCount(s) {
  const R = Number.isFinite(s.run.surface.radius) ? s.run.surface.radius : 8;
  return countInRadius(Math.max(0, Math.min(16, Math.floor(R))));
}

/** Revealed hexes inside the radius (ring ≥ minRing). */
function revealedHexes(s, minRing = 0) {
  const n = radiusCount(s);
  const rev = s.run.surface.revealed;
  const out = [];
  for (let i = 0; i < n; i++) if (rev[i] === 1 && ringOf(i) >= minRing) out.push(i);
  return out;
}

/** Terrain code of garden paths (−1 while the terrain table is not loaded). */
function gardenPathCode() {
  const t = TERRAIN && TERRAIN.garden_path;
  if (t && Number.isFinite(t.code)) return t.code;
  return TERRAIN_ORDER ? TERRAIN_ORDER.indexOf('garden_path') : -1;
}

/** Garden-path hexes inside the radius. */
function gardenPathHexes(s) {
  const code = gardenPathCode();
  if (code < 0) return [];
  const n = radiusCount(s);
  const ter = s.run.surface.terrain;
  const out = [];
  for (let i = 0; i < n; i++) if (ter[i] === code) out.push(i);
  return out;
}

/** Live (non-digging, non-relocating) chambers, optionally of one type. */
function liveChambers(s, type = null) {
  return s.run.nest.chambers.filter((c) => (c.status === 'active' || c.status === 'growing') && (!type || c.type === type));
}

/** A random cell of a chamber's footprint. */
function cellOf(s, ch) {
  const x = ch.x + randInt(s, 0, Math.max(0, ch.w - 1));
  const y = ch.y + randInt(s, 0, Math.max(0, ch.h - 1));
  return y * GRID.cols + x;
}

/** The garrison (soldiers not escorting, marching or fighting) from d.combat. */
function garrisonOf(d) {
  const g = d && d.combat && d.combat.garrison ? d.combat.garrison : null;
  return { soldier: g ? num(g.soldier) : 0, supermajor: g ? num(g.supermajor) : 0 };
}

/** Pity class of a polarity: 'choice' counts as 'mix'. */
function pityClass(p) {
  return p === 'neg' ? 'neg' : p === 'pos' ? 'pos' : 'mix';
}

/** Add an event object; returns its uid. */
function addObj(s, kind, hex, cell, t, data) {
  const uid = nextUid(s);
  s.run.events.objects.push({ uid, kind, hex, cell, t, data: data || {} });
  return uid;
}

/** Event object by uid. */
function findObj(s, uid) {
  const list = s.run.events.objects;
  for (let i = 0; i < list.length; i++) if (list[i].uid === uid) return list[i];
  return null;
}

/** Remove objects matching pred; returns how many. */
function removeObjs(s, pred) {
  const ev = s.run.events;
  const before = ev.objects.length;
  ev.objects = ev.objects.filter((o) => !pred(o));
  return before - ev.objects.length;
}

/** Add an event process; returns its uid. */
function addActive(s, id, t, data) {
  const uid = nextUid(s);
  s.run.events.active.push({ uid, id, t, data: data || {} });
  return uid;
}

/** True while an occurrence of this event is still running (card, process or one of its effects). */
function isRunning(s, id) {
  const ev = s.run.events;
  if (ev.card && ev.card.id === id) return true;
  for (const a of ev.active) if (a.id === id) return true;
  for (const e of s.run.effects) {
    if (e.id === id || e.id.startsWith(id + '_') || e.id.startsWith(id + ':')) return true;
  }
  return false;
}

/** Kill minors working a job (online only; this module never runs offline) and report the deaths. */
function killWorkers(s, d, n, cause, job, env) {
  if (!(n > 0)) return 0;
  const killed = num(population.killAdults(s, d, 'minor', n, cause, { job }));
  if (killed > 0) env.emit('adultsDied', { caste: 'minor', n: killed, cause });
  return killed;
}

/** Kill a fraction of the brood and report it. */
function killBroodFrac(s, frac, cause, env) {
  if (!(frac > 0)) return 0;
  const killed = num(population.killBrood(s, Math.min(1, frac), cause));
  if (killed > 0) env.emit('broodDied', { n: killed, cause });
  return killed;
}

/** One-shot food reward (seconds of income, with a minimum; may overflow to 2× cap, DESIGN §3). */
function grantFoodSec(s, d, sec, min = 0) {
  return grant(s, d, 'food', incomeSeconds(d, 'food', sec, min), { overflow: true });
}

/** The nearest frontier hexes (unrevealed, inside the radius, next to a revealed hex), ring then index order. */
function frontierHexes(s, count) {
  const n = radiusCount(s);
  const rev = s.run.surface.revealed;
  const out = [];
  for (let i = 0; i < n && out.length < count; i++) {
    if (rev[i] === 1) continue;
    const nb = neighbors(i);
    for (let k = 0; k < nb.length; k++) {
      if (nb[k] < n && rev[nb[k]] === 1) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/** Midden disease-chance reduction: min(diseaseMax, disease × middenL). */
function middenReduction(d) {
  const per = fxOf(CHAMBERS, 'midden', 'disease');
  const max = fxOf(CHAMBERS, 'midden', 'diseaseMax');
  const L = d && d.nest && d.nest.agg ? num(d.nest.agg.middenL) : 0;
  if (per === undefined || !(L > 0)) return 0;
  return Math.min(max === undefined ? 1 : max, per * L);
}

/** C189: compact number for outcome text (12, 3.4K, 1.25M, 2.0e15). */
export function fmtOutcomeNum(x) {
  const v = num(x);
  const a = Math.abs(v);
  if (a < 10) return String(Math.round(v * 10) / 10);
  if (a < 1000) return String(Math.round(v));
  const units = ['K', 'M', 'B', 'T'];
  let u = -1;
  let m = v;
  while (Math.abs(m) >= 1000 && u < units.length - 1) {
    m /= 1000;
    u++;
  }
  if (Math.abs(m) >= 1000) return v.toExponential(1).replace('+', '');
  return (Math.abs(m) < 10 ? m.toFixed(2) : Math.abs(m) < 100 ? m.toFixed(1) : String(Math.round(m))) + units[u];
}

/** C189: a duration for outcome text: "45 s", "3 min", "2:30". */
export function fmtOutcomeTime(sec) {
  const t = Math.max(0, Math.round(num(sec)));
  if (t < 60) return t + ' s';
  if (t % 60 === 0) return t / 60 + ' min';
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

/** C189: a share for outcome text: 0.15 → "15%". */
function fmtOutcomePct(x) {
  return Math.round(num(x) * 100) + '%';
}

/**
 * [q] C189: the player-facing outcome of an event choice (OUTCOMES template, placeholders filled from `vals`), or a
 * plain fallback ("Wandering Queen: adopt.") for a key without a template.
 * @param {string} id event id
 * @param {string} key choice id or variant key
 * @param {Object<string, string|number>} [vals]
 * @returns {string}
 */
export function outcomeText(id, key, vals = {}) {
  const tpl = OUTCOMES[id + ':' + key];
  if (!tpl) {
    const name = EVENTS[id] ? EVENTS[id].name : String(id || 'Event');
    return name + ': ' + String(key || 'resolved') + '.';
  }
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vals && vals[k] !== undefined && vals[k] !== null ? String(vals[k]) : m));
}

/**
 * C189: emit eventResolved { uid, id, eventId, choice, outcomeText } (eventId repeats id for the event log; `key`
 * picks an OUTCOMES variant, defaulting to the choice).
 */
function emitResolved(env, uid, id, choice, vals = {}, key = null) {
  if (!env || typeof env.emit !== 'function') return;
  env.emit('eventResolved', { uid: num(uid), id, eventId: id, choice, outcomeText: outcomeText(id, key || choice, vals) });
}

/** True if this achievement is earned. */
function earned(s, id) {
  return Object.prototype.hasOwnProperty.call(s.meta.achievements, id);
}

// ------------------------------------------------------------------------------------------------------------------
// Conditions and weights
// ------------------------------------------------------------------------------------------------------------------

/** Named predicates referenced by EVENTS[id].cond. */
const COND = {
  afterRain: (s) => s.run.events.active.some((a) => a.data && a.data.k === 'rain'),
  seedMast: (s) => s.run.events.seedMastYear !== s.meta.season.year,
  hasScout: (s, d, def) => num(s.run.colony.jobs.scout) >= (def.num.scouts || 1),
  rivalExists: (s) => s.run.rivals.list.some((r) => r && r.alive),
  nuptialPrep: (s) => owns(s, 'nuptial_preparation'),
  aphidHerded: (s, d) => herdedAphids(s, d).length > 0,
  trailMin4: (s, d, def) => s.run.surface.trails.some((t) => Array.isArray(t.path) && t.path.length >= 3 && t.path.length - 1 >= def.num.minHexes),
  trailMid: (s) => s.run.surface.trails.some((t) => Array.isArray(t.path) && t.path.length >= 3),
  gardenPath: (s) => gardenPathHexes(s).length > 0,
  fungusGarden: (s) => liveChambers(s, 'fungus_garden').length > 0,
};

/**
 * Relative weight of an eligible event right now.
 * @returns {number}
 */
function weightOf(s, d, def) {
  let w = num(def.weight);
  const sw = def.seasonWeight;
  if (sw && Object.prototype.hasOwnProperty.call(sw, seasonId(d))) w *= sw[seasonId(d)];
  if (def.disease) w *= 1 - middenReduction(d);
  if (def.id === 'ev_mold_bloom' && earned(s, 'ach_clean_house')) w *= def.num.cleanHouse;
  if (def.id === 'ev_fungal_blight' && owns(s, 'weeder_ants')) {
    const b = fxOf(RESEARCH, 'weeder_ants', 'blight');
    if (b !== undefined) w *= b;
  }
  if (def.id === 'ev_footstep' && Array.isArray(s.run.landingTags) && s.run.landingTags.includes('site_garden_path')) w *= def.num.tagMult;
  return w > 0 ? w : 0;
}

/**
 * [q] True if the event could be picked right now (season filter, minimum run time and adults, its condition, disease
 * immunity, one card at a time, not already running). Pity rules are not part of eligibility.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} id
 * @returns {boolean}
 */
export function eligible(s, d, id) {
  const def = EVENTS[id];
  if (!def) return false;
  if (def.seasons && !def.seasons.includes(seasonId(d))) return false;
  if (num(s.run.time) < def.minRunSec) return false;
  if (adultsTotal(s) < def.minAdults) return false;
  if (def.disease && lvl(s.meta.genome, 'metapleural_glands') >= 1) return false;
  if (def.choices && s.run.events.card && !(id === 'ev_rainstorm' && hasRafts(s))) return false;
  if (isRunning(s, id)) return false;
  if (def.cond) {
    const fn = COND[def.cond];
    if (!fn || !fn(s, d, def)) return false;
  }
  return true;
}

/** Pity: may a negative event fire now? */
function negAllowed(s) {
  const ev = s.run.events;
  const win = Math.max(1, EVENT_RULES.pityWindow - 1);
  let negs = 0;
  for (const p of ev.recent.slice(-win)) if (p === 'neg') negs++;
  if (negs + 1 > EVENT_RULES.maxNegIn3) return false;
  if (num(s.run.time) - num(ev.lastNegAt) < EVENT_RULES.negGapSec) return false;
  if (s.run.war.raids.some((r) => r && r.phase === 'warning')) return false;
  if (ev.active.some((a) => a.data && a.data.forecast === true)) return false;
  return true;
}

/** Weighted pick among eligible events, honouring the pity rules. */
function rollEvent(s, d) {
  const firstPos = num(s.meta.counters.events) < EVENT_RULES.firstPositive;
  const negOk = negAllowed(s);
  const cands = [];
  for (const id of EVENT_ORDER) {
    const def = EVENTS[id];
    if (def.followUp) continue;
    const pc = pityClass(def.polarity);
    if (firstPos && pc !== 'pos') continue;
    if (pc === 'neg' && !negOk) continue;
    if (!eligible(s, d, id)) continue;
    const w = weightOf(s, d, def);
    if (w > 0) cands.push({ id, w });
  }
  const e = weighted(s, cands);
  return e ? e.id : null;
}

// ------------------------------------------------------------------------------------------------------------------
// Firing events
// ------------------------------------------------------------------------------------------------------------------

/** Open the event card for an occurrence. */
function openCard(s, def, occ, data = {}) {
  s.run.events.card = { uid: occ, id: def.id, t: EVENT_RULES.cardSec, choices: def.choices.map((c) => c.id), data };
}

/** Start tracking a finite source (fallen fruit, picnic) for the "fully harvested" achievements. */
function trackSource(s, id, occ, srcUid, objUid) {
  const src = findSrc(s, srcUid);
  addActive(s, id, -1, { k: 'track', occ, src: srcUid, obj: objUid, last: src ? num(src.stock) : 0, max: src ? num(src.max) : 0,
    drop: 0, trailed: false });
}

/**
 * C221: spawn an event source the player is asked to draw a trail to (fallen fruit, picnic, termite swarm) only on a
 * revealed hex a trail can reach (trails.reachDist), off rival land when possible: first in the event's ring band,
 * then anywhere from ring 2 out. Returns the new source uid, or 0 (the event then does not happen).
 */
function spawnTrailTarget(s, d, type, def, extra = {}) {
  let reach = null;
  try {
    reach = trails.reachDist(s, d);
  } catch {
    reach = null;
  }
  if (!reach) return 0;
  const base = { revealed: true, reach, ...extra };
  const tries = [
    { rMin: def.num.rMin, rMax: def.num.rMax, noRival: true },
    { rMin: def.num.rMin, rMax: def.num.rMax },
    { rMin: 2, rMax: 99, noRival: true },
    { rMin: 2, rMax: 99 },
  ];
  for (const t of tries) {
    const uid = num(surface.spawnSource(s, d, type, -1, { ...base, ...t }));
    if (uid > 0) return uid;
  }
  return 0;
}

/** Spawn behaviour of every event: (s, d, def, occ, env) → true when the event happened. */
const SPAWN = {
  ev_fallen_fruit(s, d, def, occ) {
    const uid = spawnTrailTarget(s, d, 'fallen_fruit', def);
    const src = uid > 0 ? findSrc(s, uid) : null;
    if (!src) return false;   // C221: nowhere a trail can reach: skip the event
    const obj = addObj(s, 'fruit', src.hex, -1, -1, { occ, src: uid });
    trackSource(s, def.id, occ, uid, obj);
    return true;
  },
  ev_picnic_spill(s, d, def, occ) {
    const uid = spawnTrailTarget(s, d, 'picnic_spill', def);
    if (!(uid > 0 && findSrc(s, uid))) return false;
    trackSource(s, def.id, occ, uid, 0);
    return true;
  },
  ev_termite_swarm(s, d, def, occ) {
    const uid = spawnTrailTarget(s, d, 'termite_swarm', def, { ttl: def.num.sec });
    const src = uid > 0 ? findSrc(s, uid) : null;
    if (!src) return false;
    addObj(s, 'termite_swarm', src.hex, -1, def.num.sec, { occ, src: uid });
    return true;
  },
  ev_seed_mast_year(s, d, def) {
    s.run.events.seedMastYear = s.meta.season.year;
    const left = d && d.season && d.season.toNext > 0 ? d.season.toNext : 1;
    addEffect(s, { id: def.id, stat: 'source_type', scope: 'seed_patch', mult: def.num.mult, t: left });
    return true;
  },
  ev_pheromone_bloom(s, d, def) {
    addEffect(s, { id: def.id, stat: 'insight', mult: def.num.mult, t: def.num.sec });
    return true;
  },
  ev_lost_scout_returns(s, d, def) {
    const hexes = frontierHexes(s, def.num.hexes);
    if (hexes.length) surface.revealHexes(s, d, hexes);
    grant(s, d, 'insight', incomeSeconds(d, 'insight', def.num.insightSec, def.num.insightMin));
    return true;
  },
  ev_queens_vigor(s, d, def) {
    addEffect(s, { id: def.id, stat: 'lay', mult: def.num.mult, t: def.num.sec });
    return true;
  },
  ev_rival_mating_flight(s, d, def, occ) {
    addEffect(s, { id: def.id, stat: 'ap_rival', scope: null, mult: def.num.apMult, t: def.num.sec });
    const hexes = revealedHexes(s, 1);
    if (hexes.length) {
      for (let i = 0; i < def.num.alates; i++) addObj(s, 'rival_alate', pick(s, hexes), -1, def.num.sec, { occ });
    }
    return true;
  },
  ev_rival_queen_dies(s, d, def) {
    const alive = s.run.rivals.list.filter((r) => r && r.alive);
    const r = pick(s, alive);
    if (!r) return false;
    addEffect(s, { id: def.id + ':' + r.uid, stat: 'ap_rival', scope: r.uid, mult: def.num.apMult, t: def.num.sec });
    return true;
  },
  ev_flight_day(s, d, def) {
    addEffect(s, { id: def.id, stat: 'flight_w', mult: def.num.w, t: def.num.sec });
    return true;
  },
  ev_golden_aphid(s, d, def, occ) {
    const h = pick(s, herdedAphids(s, d));
    if (!h) return false;
    addObj(s, 'golden_aphid', h.src.hex, -1, def.num.sec, { occ, src: h.src.uid });
    return true;
  },
  ev_mole_tunnel(s, d, def, occ, env) {
    nest.moleTunnel(s, d, env);
    s.meta.counters.moleTunnels = num(s.meta.counters.moleTunnels) + 1;
    const blocked = new Set(s.run.surface.sources.map((x) => x.hex));
    for (const e of s.run.surface.entrances) blocked.add(e.hex);
    const cands = revealedHexes(s, 1).filter((h) => !blocked.has(h) && surface.isPassable(s, d, h));
    const hex = pick(s, cands);
    if (hex !== null && hex !== undefined) addObj(s, 'molehill', hex, -1, def.num.blockSec, { occ });
    return true;
  },
  ev_wandering_queen(s, d, def, occ) {
    addObj(s, 'wandering_queen', 0, -1, -1, { occ, card: true });
    openCard(s, def, occ);
    return true;
  },
  ev_myrmecophile_guest(s, d, def, occ) {
    addObj(s, 'myrmecophile', 0, -1, -1, { occ, card: true });
    openCard(s, def, occ);
    return true;
  },
  ev_phengaris_caterpillar(s, d, def, occ) {
    addObj(s, 'phengaris', -1, broodCell(s), -1, { occ, card: true });
    openCard(s, def, occ);
    return true;
  },
  ev_rainstorm(s, d, def, occ) {
    s.meta.counters.rainstorms = num(s.meta.counters.rainstorms) + 1;
    if (!owns(s, 'weather_sense')) trails.resetStrength(s, d);
    const sw = EVENTS.ev_termite_swarm.num;
    const swarmIn = chance(s, sw.chance) ? randRange(s, 0, sw.withinSec) : -1;
    addActive(s, def.id, sw.withinSec, { k: 'rain', occ, swarmIn });
    if (hasRafts(s)) {
      addEffect(s, { id: 'ev_rafts', stat: 'forage', mult: def.num.raftMult, t: def.num.raftSec });
      return true;
    }
    openCard(s, def, occ);
    return true;
  },
  ev_drought(s, d, def) {
    const sec = def.num.sec;
    const immune = !!(d && d.nest && d.nest.agg && num(d.nest.agg.wells) > 0);
    if (!immune) {
      const k = owns(s, 'drainage') ? fxOf(RESEARCH, 'drainage', 'drought') : undefined;
      const soften = (p) => (k === undefined ? p : 1 - (1 - p) * k);
      addEffect(s, { id: 'ev_drought_leaves', stat: 'source_type', scope: 'leaf_plant', mult: soften(def.num.leaves), t: sec });
      addEffect(s, { id: 'ev_drought_flowers', stat: 'source_type', scope: 'flower_patch', mult: soften(def.num.flowers), t: sec });
    }
    addEffect(s, { id: 'ev_drought_honeydew', stat: 'honeydew', mult: def.num.honeydew, t: sec });
    return true;
  },
  ev_mold_bloom(s, d, def, occ) {
    if (liveChambers(s).length === 0) return false;
    const n = randInt(s, def.num.min, def.num.max);
    for (let i = 0; i < n; i++) addMold(s, def, occ);
    addActive(s, def.id, def.num.spreadSec, { k: 'mold', occ });
    return true;
  },
  ev_ophiocordyceps(s, d, def, occ) {
    openCard(s, def, occ);
    return true;
  },
  ev_ladybug_raid(s, d, def, occ) {
    const h = pick(s, herdedAphids(s, d));
    if (!h) return false;
    for (let i = 0; i < def.num.ladybugs; i++) addObj(s, 'ladybug', h.src.hex, -1, -1, { occ, card: true });
    openCard(s, def, occ, { src: h.src.uid, hex: h.src.hex, trail: h.trail.uid, left: def.num.ladybugs });
    return true;
  },
  ev_antlion_pit(s, d, def, occ) {
    const list = s.run.surface.trails.filter((t) => Array.isArray(t.path) && t.path.length >= 3 && t.path.length - 1 >= def.num.minHexes);
    const t = pick(s, list);
    if (!t) return false;
    const hex = pick(s, t.path.slice(1, -1));
    const obj = addObj(s, 'antlion', hex, -1, -1, { occ, trail: t.uid });
    addActive(s, def.id, -1, { k: 'antlion', occ, trail: t.uid, hex, obj, acc: 0 });
    openCard(s, def, occ, { trail: t.uid, hex });
    return true;
  },
  ev_horned_lizard(s, d, def, occ) {
    const list = s.run.surface.trails.filter((t) => Array.isArray(t.path) && t.path.length >= 3);
    const t = pick(s, list);
    if (!t) return false;
    const hex = pick(s, t.path.slice(1, -1));
    addObj(s, 'lizard', hex, -1, def.num.sec, { occ, trail: t.uid });
    openCard(s, def, occ, { trail: t.uid, hex });
    return true;
  },
  ev_footstep(s, d, def, occ) {
    const hex = pick(s, gardenPathHexes(s));
    if (hex === null || hex === undefined) return false;
    addObj(s, 'footstep', hex, -1, def.num.sec, { occ });
    return true;
  },
  ev_brood_mites(s, d, def, occ) {
    addActive(s, def.id, def.num.sec, { k: 'mites', occ });
    syncMites(s, d, def, def.num.sec);
    return true;
  },
  ev_phorid_flies(s, d, def) {
    addEffect(s, { id: def.id, stat: 'atk_player', mult: def.num.atkMult, t: def.num.sec });
    addEffect(s, { id: def.id + '_trails', stat: 'forage_unescorted', mult: def.num.forageMult, t: def.num.sec });
    return true;
  },
  ev_fungal_blight(s, d, def, occ) {
    openCard(s, def, occ);
    return true;
  },
  ev_army_ant_column(s, d, def, occ) {
    const owned = d && d.surface && d.surface.owned ? d.surface.owned : null;
    let cands = revealedHexes(s, 1);
    if (owned) {
      const o = cands.filter((h) => owned[h] > 0);
      if (o.length) cands = o;
    }
    const hex = pick(s, cands);
    const cross = BOSSES && BOSSES.army_ant_column ? num(BOSSES.army_ant_column.crossSec) : 0;
    addObj(s, 'army_column', hex === null || hex === undefined ? 0 : hex, -1, cross > 0 ? cross : -1, { occ });
    openCard(s, def, occ, { hex: hex === null || hex === undefined ? 0 : hex });
    return true;
  },
  ev_frost_snap(s, d, def) {
    addEffect(s, { id: def.id, stat: 'frost_snap', add: def.num.rows || FROST.snapRows, t: def.num.sec || FROST.snapSec });
    return true;
  },
};

/** A brood cell for the phengaris caterpillar: a nursery cell, else the Royal Chamber. */
function broodCell(s) {
  const ch = pick(s, liveChambers(s, 'nursery')) || liveChambers(s, 'royal_chamber')[0] || s.run.nest.chambers[0];
  return ch ? cellOf(s, ch) : -1;
}

/** Number of live mold spots. */
function moldCount(s) {
  let n = 0;
  for (const o of s.run.events.objects) if (o.kind === 'mold') n++;
  return n;
}

/** Add one mold spot on a random live chamber (cap: num.maxSpots). */
function addMold(s, def, occ) {
  if (moldCount(s) >= def.num.maxSpots) return 0;
  const ch = pick(s, liveChambers(s));
  if (!ch) return 0;
  const uid = addObj(s, 'mold', -1, cellOf(s, ch), -1, { occ, chamber: ch.uid });
  addEffect(s, { id: 'mold:' + uid, stat: 'chamber', scope: ch.uid, mult: def.num.mult, t: -1 });
  return uid;
}

/**
 * C74: keep mold spots on their chambers. A spot whose chamber no longer exists (demolished) is removed with its
 * 'mold:<uid>' effect; a spot outside its chamber's footprint (relocated) moves inside it, keeping its offset (wrapped),
 * so distinct spots stay distinct. No RNG is used. The outbreak process ends by itself once none of its spots is left.
 */
function sweepMold(s) {
  const objs = s.run.events.objects;
  if (!objs.some((o) => o && o.kind === 'mold')) return;
  const byUid = new Map();
  for (const c of s.run.nest.chambers) if (c) byUid.set(c.uid, c);
  const gone = [];
  for (const o of objs) {
    if (!o || o.kind !== 'mold') continue;
    const ch = byUid.get(o.data && o.data.chamber);
    if (!ch) {
      gone.push(o.uid);
      continue;
    }
    const cols = GRID.cols;
    const cx = Number.isInteger(o.cell) && o.cell >= 0 ? o.cell % cols : ch.x;
    const cy = Number.isInteger(o.cell) && o.cell >= 0 ? Math.floor(o.cell / cols) : ch.y;
    const w = Math.max(1, num(ch.w, 1));
    const h = Math.max(1, num(ch.h, 1));
    if (cx >= ch.x && cx < ch.x + w && cy >= ch.y && cy < ch.y + h) continue;
    const x = ch.x + (((cx - ch.x) % w) + w) % w;
    const y = ch.y + (((cy - ch.y) % h) + h) % h;
    o.cell = y * cols + x;
  }
  if (!gone.length) return;
  const set = new Set(gone);
  removeObjs(s, (o) => set.has(o.uid));
  for (const uid of gone) removeEffect(s, 'mold:' + uid);
}

/** Brood mites: the effect holds unless nurses ≥ 1 per brood slot. */
function syncMites(s, d, def, left) {
  const slots = d && d.stats ? num(d.stats.broodSlots) : 0;
  const nurses = num(s.run.colony.jobs.nurse);
  if (slots > 0 && nurses >= slots * def.num.nursesPerSlot) removeEffect(s, def.id);
  else if (left > 0) addEffect(s, { id: def.id, stat: 'brood_time', mult: def.num.mult, t: left, reset: true });
}

/**
 * Fire an event now: run its spawn behaviour, then do the pity bookkeeping, counters and eventSpawned.
 * @returns {boolean} false if it could not happen (no target)
 */
function fire(s, d, id, env) {
  const def = EVENTS[id];
  if (!def) return false;
  if (def.choices && s.run.events.card && !(id === 'ev_rainstorm' && hasRafts(s))) return false;   // one card at a time
  const ev = s.run.events;
  const occ = nextUid(s);
  if (!SPAWN[id](s, d, def, occ, env)) return false;
  const pc = pityClass(def.polarity);
  ev.recent.push(pc);
  while (ev.recent.length > EVENT_RULES.pityWindow) ev.recent.shift();
  if (pc === 'neg') ev.lastNegAt = num(s.run.time);
  s.meta.counters.events = num(s.meta.counters.events) + 1;
  s.run.stats.eventsSeen = num(s.run.stats.eventsSeen) + 1;
  env.emit('eventSpawned', { uid: occ, id });
  return true;
}

/**
 * [x] Fire an event immediately, bypassing the scheduler and eligibility (tests; golden.js Saved Finds gifts).
 * Returns false for an unknown id, or a card event while another card is open, or when it has no target.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} id
 * @param {import('../core/types.js').Env} env
 * @returns {boolean}
 */
export function forceEvent(s, d, id, env) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(EVENTS, id)) return false;
  return fire(s, d, id, env);
}

// ------------------------------------------------------------------------------------------------------------------
// Army Ant Column preview (C114)
// ------------------------------------------------------------------------------------------------------------------

/**
 * The army ant column's force (BOSSES.army_ant_column): AP = apBase × (1 + supercolonies)^apExp, as n ants of atk / hp.
 * @param {import('../core/types.js').State} s
 * @returns {{ n: number, atk: number, hp: number }}
 */
export function armyColumnFoe(s) {
  const b = BOSSES && BOSSES.army_ant_column;
  if (!b) return { n: 0, atk: 0, hp: 0 };
  const m = num(s && s.meta && s.meta.counters ? s.meta.counters.supercolonies : 0);
  const ap = b.apBase * Math.pow(1 + m, b.apExp);
  const per = Math.sqrt(b.atk * b.hp);
  return { n: per > 0 ? ap / per : 0, atk: b.atk, hp: b.hp };
}

/** Loot spec of a won army column fight. */
function armyColumnReward() {
  const b = BOSSES && BOSSES.army_ant_column;
  return b ? { foodSec: b.lootFoodSec, chitinSec: b.lootChitinSec, chitinMin: b.lootChitinMin } : null;
}

/**
 * [q] C114: what "Fight" would put on the field right now — the column (count, AP), the garrison that would march
 * (soldiers, supermajors; the fight starts with no militia), its AP, and combat.preview's win chance, loss range and
 * loot, with the options the battle start uses (home ×1, no gate, the player's auto-retreat setting). Never touches
 * s.rng.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ foe: { n: number, atk: number, hp: number }, foeAP: number, soldier: number, supermajor: number,
 *   yourAP: number, win: number, lossesLo: number, lossesHi: number, loot: Object, canFight: boolean }}
 */
export function armyColumnPreview(s, d) {
  const foe = armyColumnFoe(s);
  const g = garrisonOf(d);
  const you = { militia: 0, soldier: g.soldier, supermajor: g.supermajor };
  const rs = s && s.meta && s.meta.settings ? s.meta.settings.retreatAt : 1;
  const retreatAt = Number.isFinite(rs) ? Math.min(1, Math.max(0, rs)) : 1;
  const pv = combat.preview(s, d, you, foe, { homeMult: 1, retreatAt, reward: armyColumnReward() });
  return {
    foe, foeAP: num(combat.foeAP(foe)), soldier: g.soldier, supermajor: g.supermajor,
    yourAP: num(combat.armyAP(s, d, you, { homeMult: 1 })),
    win: num(pv.win), lossesLo: num(pv.lossesLo), lossesHi: num(pv.lossesHi), loot: pv.loot,
    canFight: g.soldier + g.supermajor > 0,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// Cards and choices
// ------------------------------------------------------------------------------------------------------------------

/** Requirement checks of the soldier remedies (C36) and the army fight: (s, d, card) → ReasonCode | null. */
const REQ = {
  'ev_ladybug_raid:send'(s, d, card) {
    const def = EVENTS.ev_ladybug_raid;
    if (garrisonOf(d).soldier >= def.num.soldiers) return null;
    const ap = d && d.combat && d.combat.escortAP ? num(d.combat.escortAP[card.data.trail]) : 0;
    return ap >= def.num.apPerRing * ringOf(num(card.data.hex)) ? null : 'requirements:soldiers';
  },
  'ev_antlion_pit:send'(s, d) {
    return garrisonOf(d).soldier >= EVENTS.ev_antlion_pit.num.soldiers ? null : 'requirements:soldiers';
  },
  'ev_horned_lizard:mob'(s, d, card) {
    const g = garrisonOf(d);
    const ap = num(combat.armyAP(s, d, { militia: 0, soldier: g.soldier, supermajor: g.supermajor }, {}));
    return ap >= EVENTS.ev_horned_lizard.num.apPerRing * ringOf(num(card.data.hex)) ? null : 'requirements:ap';
  },
  'ev_army_ant_column:fight'(s, d) {
    const g = garrisonOf(d);
    return g.soldier + g.supermajor > 0 ? null : 'requirements:soldiers';
  },
};

/**
 * Outcomes of every card choice: (s, d, card, env) → outcome values for the C189 outcome text ({ key? } picks a
 * variant template), or nothing.
 */
const CHOICES = {
  'ev_wandering_queen:adopt'(s, d, card) {
    const n = EVENTS.ev_wandering_queen.num;
    addEffect(s, { id: 'ev_wandering_queen', stat: 'lay', mult: n.layMult, t: n.sec });
    if (chance(s, n.parasiteChance)) addActive(s, 'ev_wandering_queen', n.sec, { k: 'parasite', occ: card.uid });
    return { mult: n.layMult, time: fmtOutcomeTime(n.sec) };
  },
  'ev_wandering_queen:devour'(s, d) {
    const n = EVENTS.ev_wandering_queen.num;
    return { food: fmtOutcomeNum(grantFoodSec(s, d, n.devourSec, n.devourMin)) };
  },
  'ev_myrmecophile_guest:accept'(s, d, card) {
    const n = EVENTS.ev_myrmecophile_guest.num;
    addEffect(s, { id: 'ev_myrmecophile_guest', stat: 'forage_add', add: n.forageAdd, t: n.sec });
    addObj(s, 'myrmecophile', 0, -1, n.sec, { occ: card.uid });
    if (chance(s, n.eatChance)) addActive(s, 'ev_myrmecophile_guest', n.sec + n.eatSec, { k: 'myrmeco', occ: card.uid, acc: 0 });
    return { pct: fmtOutcomePct(n.forageAdd), time: fmtOutcomeTime(n.sec) };
  },
  'ev_myrmecophile_guest:expel'(s, d) {
    const n = EVENTS.ev_myrmecophile_guest.num;
    return { chitin: fmtOutcomeNum(grant(s, d, 'chitin', incomeSeconds(d, 'chitin', n.expelSec, n.expelMin))) };
  },
  'ev_phengaris_caterpillar:adopt'(s, d, card) {
    const n = EVENTS.ev_phengaris_caterpillar.num;
    const mode = chance(s, n.cuckooChance) ? 'cuckoo' : 'predator';
    if (mode === 'cuckoo') addEffect(s, { id: 'ev_phengaris_caterpillar', stat: 'honeydew', mult: n.honeydewMult, t: n.sec });
    addObj(s, 'phengaris', -1, broodCell(s), n.sec, { occ: card.uid });
    addActive(s, 'ev_phengaris_caterpillar', n.sec, { k: 'phengaris', occ: card.uid, mode, acc: 0 });
    return { time: fmtOutcomeTime(n.sec) };
  },
  'ev_phengaris_caterpillar:reject'() {},
  'ev_rainstorm:seal'(s) {
    const n = EVENTS.ev_rainstorm.num;
    addEffect(s, { id: 'ev_rainstorm_seal', stat: 'surface_work', mult: 0, t: n.sealSec });
    return { time: fmtOutcomeTime(n.sealSec) };
  },
  'ev_rainstorm:keep'(s) {
    const n = EVENTS.ev_rainstorm.num;
    if (owns(s, 'drainage')) return { key: 'keepDry' };   // drainage: no flood and no −50 %
    addEffect(s, { id: 'ev_rainstorm_keep', stat: 'chamber_layer', scope: n.layer, mult: n.keepMult, t: n.keepSec });
    const flood = chance(s, n.floodChance);
    if (flood) addEffect(s, { id: 'ev_flood', stat: 'chamber_layer', scope: n.layer, mult: 0, t: n.floodSec });
    return { key: flood ? 'keepFlood' : 'keep', pct: fmtOutcomePct(1 - n.keepMult), time: fmtOutcomeTime(n.keepSec), flood: fmtOutcomeTime(n.floodSec) };
  },
  'ev_ophiocordyceps:quarantine'(s) {
    const n = EVENTS.ev_ophiocordyceps.num;
    addEffect(s, { id: 'ev_ophiocordyceps', stat: 'forage', mult: n.forageMult, t: n.quarantineSec });
    return { pct: fmtOutcomePct(1 - n.forageMult), time: fmtOutcomeTime(n.quarantineSec) };
  },
  'ev_ophiocordyceps:ignore'(s, d, card) {
    const n = EVENTS.ev_ophiocordyceps.num;
    const foragers = num(s.run.colony.jobs.forager);
    addActive(s, 'ev_ophiocordyceps', n.sec, { k: 'cordyceps', occ: card.uid, infected: foragers * n.infectFrac, start: foragers });
    return { time: fmtOutcomeTime(n.sec) };
  },
  'ev_ladybug_raid:send'() {},
  'ev_ladybug_raid:wait'(s, d, card) {
    const n = EVENTS.ev_ladybug_raid.num;
    const src = num(card.data.src);
    addEffect(s, { id: 'ev_ladybug_raid:' + src, stat: 'source', scope: src, mult: n.yieldMult, t: n.sec });
    return { pct: fmtOutcomePct(n.yieldMult), time: fmtOutcomeTime(n.sec) };
  },
  'ev_antlion_pit:send'(s, d, card) {
    endAntlion(s, card.uid, null, null);
  },
  'ev_antlion_pit:wait'() {
    return { pct: fmtOutcomePct(EVENTS.ev_antlion_pit.num.lossPerMin) };
  },
  'ev_horned_lizard:reroute'() {},
  'ev_horned_lizard:mob'(s, d, card) {
    removeObjs(s, (o) => o.kind === 'lizard' && o.data && o.data.occ === card.uid);
    return { food: fmtOutcomeNum(grantFoodSec(s, d, EVENTS.ev_horned_lizard.num.foodSec, 0)) };
  },
  'ev_horned_lizard:ignore'(s, d, card) {
    const obj = s.run.events.objects.find((o) => o.kind === 'lizard' && o.data && o.data.occ === card.uid);
    const left = obj && obj.t > 0 ? obj.t : EVENTS.ev_horned_lizard.num.sec;
    addActive(s, 'ev_horned_lizard', left, { k: 'lizard', occ: card.uid, trail: card.data.trail, hex: card.data.hex, acc: 0 });
    return { time: fmtOutcomeTime(left) };
  },
  'ev_fungal_blight:quarantine'(s) {
    const amt = num(s.run.res.fungus) * EVENTS.ev_fungal_blight.num.loss;
    if (amt > 0) spend(s, { fungus: amt });
    return { fungus: fmtOutcomeNum(amt) };
  },
  'ev_fungal_blight:clean'(s, d, card) {
    const n = EVENTS.ev_fungal_blight.num;
    addActive(s, 'ev_fungal_blight', n.cleanSec, { k: 'blight', occ: card.uid, clicks: 0 });
    return { n: n.clicks, time: fmtOutcomeTime(n.cleanSec) };
  },
  'ev_army_ant_column:evacuate'(s) {
    const n = EVENTS.ev_army_ant_column.num;
    addEffect(s, { id: 'ev_army_evacuate', stat: 'surface_work', mult: 0, t: n.evacSec });
    const loss = num(s.run.res.food) * n.evacFood;
    if (loss > 0) spend(s, { food: loss });
    return { time: fmtOutcomeTime(n.evacSec), food: fmtOutcomeNum(loss) };
  },
  'ev_army_ant_column:fight'(s, d, card, env) {
    const b = BOSSES && BOSSES.army_ant_column;
    if (!b) return;
    const g = garrisonOf(d);
    rivals.startEventBattle(s, d, {
      kind: 'army', hex: num(card.data.hex), below: false,
      you: { militia: 0, soldier: g.soldier, supermajor: g.supermajor },
      foe: armyColumnFoe(s),   // C114: the card's preview uses the same foe
      homeMult: 1, party: 0, raid: 0,
      reward: armyColumnReward(),
      tag: 'ev_army_ant_column',
    }, env);
  },
};

/** Resolve the open card with a choice (player or timeout). */
function resolveCard(s, d, choice, env) {
  const card = s.run.events.card;
  if (!card) return;
  s.run.events.card = null;
  removeObjs(s, (o) => o.data && o.data.card === true && o.data.occ === card.uid);
  const fn = CHOICES[card.id + ':' + choice];
  const vals = (fn ? fn(s, d, card, env) : null) || {};
  emitResolved(env, card.uid, card.id, choice, vals, vals.key || null);
}

/** The default (*) choice of a card. */
function defaultChoice(card) {
  const def = EVENTS[card.id];
  const c = def && def.choices ? def.choices.find((x) => x.def) : null;
  return c ? c.id : card.choices[card.choices.length - 1];
}

/**
 * [x] C188 (surface.js scout expeditions): put a clickable expedition find (fossil_cache, lost_queen) on a hex for
 * `ttl` seconds. Returns its object uid (0 for an unknown kind).
 * @param {import('../core/types.js').State} s
 * @param {string} kind
 * @param {number} hex
 * @param {number} ttl
 * @returns {number}
 */
export function addFindObject(s, kind, hex, ttl) {
  const f = EXPEDITION.finds.find((x) => x.id === kind && x.kind === 'object');
  if (!f || !Number.isInteger(hex) || hex < 0) return 0;
  return addObj(s, kind, hex, -1, ttl > 0 ? ttl : -1, { find: true });
}

/** C188: a clicked expedition find: fossil cache → insight (seconds of income, minimum); lost queen → lay ×mult. */
function claimFind(s, d, o, env) {
  const f = EXPEDITION.finds.find((x) => x.id === o.kind);
  if (!f) return;
  if (o.kind === 'fossil_cache') {
    const got = grant(s, d, 'insight', incomeSeconds(d, 'insight', f.insightSec, f.insightMin));
    env.emit('findClaimed', { kind: o.kind, res: 'insight', amount: got, text: 'Fossil cache: +' + fmtOutcomeNum(got) + ' insight.' });
    env.emit('objectGain', { kind: o.kind, hex: o.hex, res: 'insight', amount: num(got) });   // C223
  } else {
    addEffect(s, { id: 'find_lost_queen', stat: 'lay', mult: f.layMult, t: f.laySec });
    env.emit('findClaimed', { kind: o.kind, res: null, amount: 0,
      text: 'A lost queen joins the colony: lay ×' + f.layMult + ' for ' + fmtOutcomeTime(f.laySec) + '.' });
  }
}

/** End an antlion occurrence (send, reroute, trail gone); closes its card if still open. */
function endAntlion(s, occ, env, choice) {
  const ev = s.run.events;
  ev.active = ev.active.filter((a) => !(a.data && a.data.k === 'antlion' && a.data.occ === occ));
  removeObjs(s, (o) => o.kind === 'antlion' && o.data && o.data.occ === occ);
  if (env && ev.card && ev.card.uid === occ) {
    ev.card = null;
    emitResolved(env, occ, 'ev_antlion_pit', choice || 'send', choice === 'wait' ? { pct: fmtOutcomePct(EVENTS.ev_antlion_pit.num.lossPerMin) } : {});
  } else if (env && choice) {
    emitResolved(env, occ, 'ev_antlion_pit', choice);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Tick: card timer, objects, processes, scheduler
// ------------------------------------------------------------------------------------------------------------------

/** Object timers and expiry. */
function tickObjects(s, d, dt, env) {
  const ev = s.run.events;
  const cur = ev.objects;
  ev.objects = [];
  const expired = [];
  for (const o of cur) {
    if (o.t > 0) {
      o.t -= dt;
      if (o.t <= 0) {
        expired.push(o);
        continue;
      }
    }
    ev.objects.push(o);
  }
  for (const o of expired) {
    if (o.kind === 'footstep') stomp(s, d, o, env);
    else if (o.kind === 'golden_aphid') emitResolved(env, o.data.occ, 'ev_golden_aphid', 'expired');
  }
}

/**
 * The footstep lands: cut trails and remove finite sources in the 7-hex area. Mound L5+ shields the 7 hexes of the main
 * entrance (the entrance hex and its ring, DESIGN §8.7) and every other entrance hex.
 */
function stomp(s, d, o, env) {
  const def = EVENTS.ev_footstep;
  const n = radiusCount(s);
  let area = [o.hex];
  if (def.num.areaRadius >= 1) for (const h of neighbors(o.hex)) if (h < n) area.push(h);
  if (num(s.run.surface.mound) >= num(MOUND && MOUND.shieldLevel) && num(MOUND && MOUND.shieldLevel) > 0) {
    const shield = new Set(s.run.surface.entrances.map((e) => e.hex));
    const main = s.run.surface.entrances.find((e) => e && e.kind === 'main');
    const mainHex = main && Number.isInteger(main.hex) ? main.hex : 0;
    shield.add(mainHex);
    for (const h of neighbors(mainHex)) shield.add(h);
    area = area.filter((h) => !shield.has(h));
  }
  let cut = 0;
  let crushed = 0;
  if (area.length) {
    cut = num(trails.cutTrailsAt(s, d, area));
    const set = new Set(area);
    const doomed = s.run.surface.sources.filter((x) => set.has(x.hex) && x.max !== -1 && x.stock !== -1).map((x) => x.uid);
    for (const uid of doomed) surface.removeSource(s, d, uid, 'footstep');
    crushed = doomed.length;
  }
  emitResolved(env, o.data.occ, 'ev_footstep', 'stomped', { n: cut, m: crushed });
}

/** True if a trail with workers is working this source. */
function trailedSource(s, d, uid) {
  for (const t of s.run.surface.trails) if (t.src === uid && trailWorkers(s, d, t) > 0) return true;
  return false;
}

/** True if the trail still passes this hex. */
function trailPasses(s, trailUid, hex) {
  const t = findTrail(s, trailUid);
  return !!(t && Array.isArray(t.path) && t.path.indexOf(hex) > 0);
}

/**
 * Advance one process. Returns true to keep it.
 * @returns {boolean}
 */
function stepActive(s, d, a, dt, env) {
  const k = a.data ? a.data.k : null;
  const timed = a.t > 0;
  if (timed) a.t -= dt;
  const ended = timed && a.t <= 0;
  switch (k) {
    case 'track': {
      const src = findSrc(s, a.data.src);
      if (src) {
        const stock = num(src.stock);
        if (stock < a.data.last) a.data.drop = a.data.last - stock;
        a.data.last = stock;
        a.data.max = Math.max(num(a.data.max), num(src.max));
        if (stock > 0 && trailedSource(s, d, src.uid)) a.data.trailed = true;
        return true;
      }
      const full = a.data.trailed && a.data.max > 0 &&
        a.data.last <= Math.max(a.data.max * EVENT_RULES.harvestFrac, 2 * num(a.data.drop));
      if (a.data.obj) removeObjs(s, (o) => o.uid === a.data.obj);
      emitResolved(env, a.data.occ, a.id, full ? 'harvested' : 'lost');
      return false;
    }
    case 'forecast':
      if (ended) {
        fire(s, d, a.id, env);
        return false;
      }
      return true;
    case 'rain':
      if (a.data.swarmIn >= 0) {
        a.data.swarmIn -= dt;
        if (a.data.swarmIn < 0) {
          a.data.swarmIn = -1;
          fire(s, d, 'ev_termite_swarm', env);
        }
      }
      return !ended;
    case 'parasite':
      if (ended) {
        const n = EVENTS.ev_wandering_queen.num;
        addEffect(s, { id: 'ev_wandering_queen_parasite', stat: 'lay', mult: n.parasiteMult, t: n.parasiteSec });
        return false;
      }
      return true;
    case 'myrmeco': {
      const n = EVENTS.ev_myrmecophile_guest.num;
      const eating = a.t < n.eatSec || ended;
      if (eating) {
        const span = Math.min(dt, n.eatSec);
        a.data.acc = num(a.data.acc) + killBroodFrac(s, (n.eatFrac * span) / n.eatSec, 'myrmecophile', { emit() {} });
        if (a.data.acc >= 1 || (ended && a.data.acc > 0)) {
          env.emit('broodDied', { n: a.data.acc, cause: 'myrmecophile' });
          a.data.acc = 0;
        }
      }
      return !ended;
    }
    case 'phengaris': {
      const n = EVENTS.ev_phengaris_caterpillar.num;
      if (a.data.mode === 'predator') {
        a.data.acc = num(a.data.acc) + dt;
        while (a.data.acc >= n.larvaEverySec) {
          a.data.acc -= n.larvaEverySec;
          const b = broodTotal(s);
          if (b > 0) killBroodFrac(s, n.larvae / b, 'phengaris', env);
        }
      }
      if (ended) {
        const gotInsight = grant(s, d, 'insight', incomeSeconds(d, 'insight', n.insightSec, n.insightMin));
        removeObjs(s, (o) => o.kind === 'phengaris' && o.data && o.data.occ === a.data.occ);
        emitResolved(env, a.data.occ, a.id, 'butterfly', { insight: fmtOutcomeNum(gotInsight) });
        return false;
      }
      return true;
    }
    case 'cordyceps': {
      const n = EVENTS.ev_ophiocordyceps.num;
      const foragers = num(s.run.colony.jobs.forager);
      a.data.infected = Math.min(foragers, num(a.data.infected) * Math.pow(n.spreadPerMin, dt / 60));
      if (ended) {
        const killed = killWorkers(s, d, a.data.infected, 'cordyceps', 'forager', env);
        // Losses under num.avertLoss of the foragers at the outbreak's start count as averted (ach_zombie_averted).
        const averted = killed <= 0 || killed < n.avertLoss * num(a.data.start);
        emitResolved(env, a.data.occ, a.id, averted ? 'averted' : 'ended', { n: fmtOutcomeNum(killed) });
        return false;
      }
      return true;
    }
    case 'antlion': {
      if (!trailPasses(s, a.data.trail, a.data.hex)) {
        endAntlion(s, a.data.occ, env, 'rerouted');
        return false;
      }
      const t = findTrail(s, a.data.trail);
      const n = EVENTS.ev_antlion_pit.num;
      a.data.acc = num(a.data.acc) + (trailWorkers(s, d, t) * n.lossPerMin * dt) / 60;
      if (a.data.acc >= 1) {
        const whole = Math.floor(a.data.acc);
        a.data.acc -= whole;
        killWorkers(s, d, whole, 'antlion', t.job, env);
      }
      return true;
    }
    case 'lizard': {
      if (!trailPasses(s, a.data.trail, a.data.hex)) return false;
      const t = findTrail(s, a.data.trail);
      const n = EVENTS.ev_horned_lizard.num;
      a.data.acc = num(a.data.acc) + (trailWorkers(s, d, t) * n.lossFrac * dt) / n.lossEverySec;
      if (a.data.acc >= 1) {
        const whole = Math.floor(a.data.acc);
        a.data.acc -= whole;
        killWorkers(s, d, whole, 'lizard', t.job, env);
      }
      return !ended;
    }
    case 'mites': {
      const def = EVENTS.ev_brood_mites;
      if (ended) {
        removeEffect(s, def.id);
        return false;
      }
      syncMites(s, d, def, a.t);
      return true;
    }
    case 'blight':
      if (ended) {
        const amt = num(s.run.res.fungus) * EVENTS.ev_fungal_blight.num.loss;
        if (amt > 0) spend(s, { fungus: amt });
        emitResolved(env, a.data.occ, a.id, 'failed', { fungus: fmtOutcomeNum(amt) });
        return false;
      }
      return true;
    case 'mold': {
      const occ = a.data.occ;
      const mine = s.run.events.objects.some((o) => o.kind === 'mold' && o.data && o.data.occ === occ);
      if (!mine) return false;
      if (ended) {
        addMold(s, EVENTS.ev_mold_bloom, occ);
        a.t = EVENTS.ev_mold_bloom.num.spreadSec;
      }
      return true;
    }
    default:
      return !ended;
  }
}

/** Advance every process. */
function tickActive(s, d, dt, env) {
  const ev = s.run.events;
  const cur = ev.active;
  ev.active = [];
  const keep = [];
  for (const a of cur) {
    if (!a || !a.data) continue;
    if (stepActive(s, d, a, dt, env)) keep.push(a);
  }
  // Processes started during this pass were pushed onto ev.active; keep them after the survivors.
  ev.active = keep.concat(ev.active);
}

/** Gap to the next random event: an exponential draw, capped at EVENT_GAP.firstRunMaxSec in run 1 (C75). */
function nextGap(s) {
  const g = expSample(s, EVENT_RULES.meanSec);
  return s.run.index === 0 ? Math.min(g, EVENT_GAP.firstRunMaxSec) : g;
}

/** Poisson scheduler (online only). */
function schedule(s, d, dt, env) {
  const ev = s.run.events;
  const run = s.run;
  if (run.index === 0 && !ev.scripted) {
    // First run: quiet until the scripted fruit at 8:00, which also starts the regular schedule.
    if (num(run.time) >= EVENT_RULES.scriptedFruitAt - 1e-9) {
      ev.scripted = true;
      fire(s, d, 'ev_fallen_fruit', env);
      ev.nextIn = nextGap(s);
    }
    return;
  }
  if (run.index === 0 && num(run.time) < EVENT_RULES.firstRunQuietSec) return;
  if (!Number.isFinite(ev.nextIn)) ev.nextIn = run.index === 0 ? Math.min(EVENT_RULES.meanSec, EVENT_GAP.firstRunMaxSec) : EVENT_RULES.meanSec;
  ev.nextIn -= dt;
  if (ev.nextIn > 0) return;
  ev.nextIn = nextGap(s);
  const id = rollEvent(s, d);
  if (!id) return;
  const def = EVENTS[id];
  if (def.weather && owns(s, 'weather_sense')) {
    addActive(s, id, EVENT_RULES.weatherWarnSec, { k: 'forecast', forecast: true });
    return;
  }
  fire(s, d, id, env);
}

/**
 * Advance events by dt (online only): card timeout → default choice, object timers, event processes, the scheduler.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  if (!env || env.offline || !(dt > 0) || !Number.isFinite(dt)) return;
  const ev = s.run.events;
  sweepMold(s);
  if (ev.card) {
    ev.card.t -= dt;
    if (ev.card.t <= 0) resolveCard(s, d, defaultChoice(ev.card), env);
  }
  tickObjects(s, d, dt, env);
  tickActive(s, d, dt, env);
  schedule(s, d, dt, env);
}

// ------------------------------------------------------------------------------------------------------------------
// Offline freeze of event harm (DESIGN §3, §18.1, §21.4; ARCHITECTURE §18 C68)
// ------------------------------------------------------------------------------------------------------------------

/** Effect stats where a larger value hurts the colony (everything else: a smaller mult / negative add hurts). */
const WORSE_WHEN_HIGHER = new Set(['ap_rival', 'brood_time', 'frost_snap']);

/**
 * True for an effect this module created ('ev_…' and 'mold:…' ids) that hurts the colony: a mold spot, a drought,
 * flood, sealed entrance, phorid flies, brood mites, a parasite queen, a ladybug-raided colony, an evacuation…
 * Helpful event effects (Queen's Vigor, a rival's AP drop, the drought's honeydew bonus) are not harmful.
 * @param {import('../core/types.js').Effect} e
 * @returns {boolean}
 */
export function isHarmfulEffect(e) {
  if (!e || typeof e.id !== 'string' || !(e.id.startsWith('ev_') || e.id.startsWith('mold:'))) return false;
  const m = Number.isFinite(e.mult) ? e.mult : 1;
  const a = Number.isFinite(e.add) ? e.add : 0;
  return WORSE_WHEN_HIGHER.has(e.stat) ? m > 1 || a > 0 : m < 1 || a < 0;
}

/**
 * [q] C245: the fungal blight the player can click away: 'card' while its card is open (a garden click picks Clean),
 * 'clean' during the cleaning window; clicks done, clicks needed, clicks left and seconds left. null when none.
 * @param {import('../core/types.js').State} s
 * @returns {{ phase: 'card'|'clean', clicks: number, need: number, left: number, t: number } | null}
 */
export function blightStatus(s) {
  const ev = s && s.run && s.run.events;
  if (!ev) return null;
  const need = num(EVENTS.ev_fungal_blight.num.clicks);
  const a = (ev.active || []).find((x) => x && x.id === 'ev_fungal_blight' && x.data && x.data.k === 'blight');
  if (a) return { phase: 'clean', clicks: num(a.data.clicks), need, left: Math.max(0, need - num(a.data.clicks)), t: Math.max(0, num(a.t)) };
  if (ev.card && ev.card.id === 'ev_fungal_blight') return { phase: 'card', clicks: 0, need, left: need, t: Math.max(0, num(ev.card.t)) };
  return null;
}

/**
 * [x] core/step.js, offline steps only: take the harmful event effects out of s.run.effects for the step, so that
 * offline they neither apply nor count down (events are frozen offline and nothing harmful happens offline; their
 * processes, objects and card timers already wait in this module). resumeOffline puts them back after the step.
 * @param {import('../core/types.js').State} s
 * @returns {{ run: Object, list: import('../core/types.js').Effect[] } | null} null when nothing was held
 */
export function suspendOffline(s) {
  const list = s.run && Array.isArray(s.run.effects) ? s.run.effects : null;
  if (!list) return null;
  const held = [];
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (isHarmfulEffect(e)) held.push(e);
    else list[w++] = e;
  }
  list.length = w;
  return held.length ? { run: s.run, list: held } : null;
}

/**
 * [x] core/step.js: return the effects held by suspendOffline (unchanged, timers included). Skipped when the run was
 * replaced during the step; an id re-added during the step keeps the newer copy.
 * @param {import('../core/types.js').State} s
 * @param {{ run: Object, list: import('../core/types.js').Effect[] } | null} held
 */
export function resumeOffline(s, held) {
  if (!held || !s.run || s.run !== held.run || !Array.isArray(s.run.effects)) return;
  const list = s.run.effects;
  for (const e of held.list) if (!list.some((x) => x.id === e.id)) list.push(e);
}

// ------------------------------------------------------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------------------------------------------------------

/** Player commands owned by events.js. */
export const handlers = {
  /** eventChoice { uid, choice } — answer the open card. */
  eventChoice: {
    validate(s, d, cmd) {
      const card = s.run.events.card;
      if (!card || card.uid !== cmd.uid) return 'notFound';
      if (typeof cmd.choice !== 'string' || !card.choices.includes(cmd.choice)) return 'invalid:choice';
      const req = REQ[card.id + ':' + cmd.choice];
      return req ? req(s, d, card) : null;
    },
    apply(s, d, cmd, env) {
      resolveCard(s, d, cmd.choice, env);
    },
  },

  /** clickEventObject { uid } — click a ladybug, footstep shadow, flying rival alate or golden aphid. */
  clickEventObject: {
    validate(s, d, cmd) {
      const o = findObj(s, cmd.uid);
      if (!o) return 'notFound';
      if (!CLICKABLE.has(o.kind)) return 'invalid:kind';
      if (YIELDING.has(o.kind) && claustral(s)) return 'hardship';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!consumeClick(s)) return;
      const o = findObj(s, cmd.uid);
      if (!o) return;
      removeObjs(s, (x) => x.uid === o.uid);
      const occ = num(o.data && o.data.occ);
      if (o.kind === 'rival_alate') {
        const got = grantFoodSec(s, d, EVENTS.ev_rival_mating_flight.num.foodSec, 0);
        // C223: the map shows "+X food" over the caught alate, like a hand-foraged crumb
        env.emit('objectGain', { kind: o.kind, hex: o.hex, res: 'food', amount: num(got) });
      } else if (o.kind === 'golden_aphid') {
        const n = EVENTS.ev_golden_aphid.num;
        addEffect(s, { id: 'ev_golden_aphid', stat: 'honeydew', mult: n.mult, t: n.buffSec });
        emitResolved(env, occ, 'ev_golden_aphid', 'clicked', { mult: n.mult, time: fmtOutcomeTime(n.buffSec) });
      } else if (o.kind === 'fossil_cache' || o.kind === 'lost_queen') {
        claimFind(s, d, o, env);   // C188 expedition finds
      } else if (o.kind === 'footstep') {
        emitResolved(env, occ, 'ev_footstep', 'scattered');
      } else if (o.kind === 'ladybug') {
        s.meta.counters.ladybugs = num(s.meta.counters.ladybugs) + 1;
        const card = s.run.events.card;
        const left = s.run.events.objects.some((x) => x.kind === 'ladybug' && x.data && x.data.occ === occ);
        if (card && card.uid === occ) {
          card.data.left = Math.max(0, num(card.data.left) - 1);
          if (!left) {
            s.run.events.card = null;
            emitResolved(env, occ, 'ev_ladybug_raid', 'clicked');
          }
        }
      }
    },
  },

  /**
   * clearAntlion { uid } — C185: send garrison soldiers to clear an antlion pit (the map object uid) at any time while
   * it exists, with the card's rule (EVENTS.ev_antlion_pit.num.soldiers garrison soldiers, none lost). Closes the card
   * if it is still open; eventResolved choice 'send'.
   */
  clearAntlion: {
    validate(s, d, cmd) {
      const o = Number.isInteger(cmd.uid) ? findObj(s, cmd.uid) : null;
      if (!o) return Number.isInteger(cmd.uid) ? 'notFound' : 'invalid';
      if (o.kind !== 'antlion') return 'invalid:kind';
      return REQ['ev_antlion_pit:send'](s, d);
    },
    apply(s, d, cmd, env) {
      const o = findObj(s, cmd.uid);
      if (!o) return;
      endAntlion(s, num(o.data && o.data.occ), env, 'send');
    },
  },

  /** scrapeMold { uid } — click a mold spot away. */
  scrapeMold: {
    validate(s, d, cmd) {
      const o = findObj(s, cmd.uid);
      if (!o) return 'notFound';
      if (o.kind !== 'mold') return 'invalid:kind';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd) {
      if (!consumeClick(s)) return;
      const o = findObj(s, cmd.uid);
      if (!o) return;
      removeObjs(s, (x) => x.uid === o.uid);
      removeEffect(s, 'mold:' + o.uid);
      s.meta.counters.moldScraped = num(s.meta.counters.moldScraped) + 1;
    },
  },

  /** bailFlood {} — each click shortens the flood by num.bailSec. */
  bailFlood: {
    validate(s) {
      if (!hasEffect(s, 'ev_flood')) return 'notFound';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s) {
      if (!consumeClick(s)) return;
      const e = effectsFor(s, 'chamber_layer').find((x) => x.id === 'ev_flood');
      if (!e) return;
      const left = e.t - EVENTS.ev_rainstorm.num.bailSec;
      removeEffect(s, 'ev_flood');
      if (left > 0) addEffect(s, { id: e.id, stat: e.stat, mult: e.mult, add: e.add, scope: e.scope, t: left, reset: true });
    },
  },

  /** cleanBlight {} — click the blighted garden; num.clicks clicks within num.cleanSec clear it with no loss. */
  cleanBlight: {
    validate(s) {
      const ev = s.run.events;
      const open = ev.card && ev.card.id === 'ev_fungal_blight';
      const act = ev.active.some((a) => a.data && a.data.k === 'blight');
      if (!open && !act) return 'notFound';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!consumeClick(s)) return;
      const ev = s.run.events;
      if (ev.card && ev.card.id === 'ev_fungal_blight') resolveCard(s, d, 'clean', env);
      const a = ev.active.find((x) => x.data && x.data.k === 'blight');
      if (!a) return;
      a.data.clicks = num(a.data.clicks) + 1;
      if (a.data.clicks >= EVENTS.ev_fungal_blight.num.clicks) {
        ev.active = ev.active.filter((x) => x !== a);
        emitResolved(env, a.data.occ, 'ev_fungal_blight', 'cleaned');
      }
    },
  },
};
