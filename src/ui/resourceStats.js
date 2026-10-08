// Resource statistics (ARCHITECTURE §18 C191; DESIGN §25.3): where each resource came from and what consumed it over the
// last ~60 s. Two inputs:
//  - continuous rates, sampled at the UI refresh (4 Hz) and time-averaged: d.rates[res].src (per-label gross after the
//    softcap; food trails split by source type from d.surface.trails), soil from digging, pheromone regeneration, food
//    upkeep, clay spoilage, leaves eaten by the fungus gardens, fungus fed to the colony and food wasted at the cap
//    (run.stats.foodWasted deltas);
//  - one-shot amounts from the wallet flow log (core/wallet.js flowTotals: every spend / grant / refund with the tag of
//    the command or system behind it), grouped into player-facing categories (Eggs & brood, Chambers & digging,
//    Adaptations, Research, Clicks, Events, Battle loot …).
// Whatever the stock change does not explain (a store clamped at its cap, direct mutations) is shown as "Wasted at cap"
// or "Other" when it is large enough to matter. Rates are per real second (× the Diapause speed while it runs).
// Owner: WP9. Pure apart from the tracker's own sample ring; no DOM (Node imports it).

import { flowTotals } from '../core/wallet.js';
import { nameOf, RES_NAMES } from './text.js';
import { num, arr, obj } from './reveal.js';
import { SPOILAGE, NUTRITION } from '../data/economy.js';
import { adultsTotal } from '../core/state.js';
import { diapauseInfo } from './hud.js';

/** Averaging window (s). */
export const STATS_WINDOW_SEC = 60;
/** Resources the breakdown covers, in rail order. */
export const STAT_RES = Object.freeze(['food', 'soil', 'insight', 'pheromone', 'chitin', 'honeydew', 'leaves', 'fungus']);
const CAP_KEY = Object.freeze({ food: 'foodCap', honeydew: 'honeydewCap', leaves: 'leafCap', fungus: 'fungusCap', pheromone: 'pheromoneCap' });

/** Names of continuous income labels (d.rates[res].src keys). */
const SRC_NAMES = Object.freeze({ trails: 'Trails', loose: 'Loose foraging', library: 'Scent Libraries', pens: 'Root Aphid Pens',
  flower: 'Flower trails', lycaenid: 'Lycaenid caterpillars', gardens: 'Fungus gardens', midden: 'Middens', dig: 'Diggers', regen: 'Regeneration' });

/** Spend categories by command type (flow tag 'cmd:<type>'). */
const CMD_SPEND = Object.freeze({
  placeChamber: 'chambers', levelChamber: 'chambers', relocateChamber: 'chambers', demolishChamber: 'chambers', digTunnel: 'chambers',
  digTo: 'chambers', backfill: 'chambers', helpDig: 'chambers', loadBlueprint: 'chambers', backfillUnneeded: 'chambers',
  drainPocket: 'chambers', relocatePocket: 'chambers', growRoot: 'chambers', reorderQueue: 'chambers',
  buyAdaptation: 'adaptations', buyResearch: 'research', buyRefinement: 'research', setChronobiology: 'research',
  claimHex: 'territory', buyMound: 'territory', placeSatellite: 'territory',
  drawTrail: 'trails', rerouteTrail: 'trails', mark: 'trails', rally: 'trails', frenzy: 'trails', massRecruit: 'trails', moveAphids: 'trails',
  assignEscorts: 'trails',
  launchParty: 'war', reinforce: 'war', bribe: 'war', tournament: 'war', battleAction: 'war', dispatchGuard: 'war',
  rearAlate: 'eggs', groomBrood: 'eggs', clickQueen: 'eggs',
  buyTrait: 'prestige', buyFederation: 'prestige', buyGenome: 'prestige', fly: 'prestige', supercolony: 'prestige', speciate: 'prestige',
  startHardship: 'prestige', setHeirlooms: 'prestige',
  eventChoice: 'events', clickEventObject: 'events', scrapeMold: 'events', bailFlood: 'events', cleanBlight: 'events',
});
/** Spend categories by system tick tag. */
const SYS_SPEND = Object.freeze({ population: 'eggs', nest: 'chambers', surface: 'territory', trails: 'trails', rivals: 'war', raids: 'raids',
  events: 'events', automation: 'auto', prestige: 'prestige', jobs: 'other' });
/** Grant categories by command type / system tag. */
const CMD_GRANT = Object.freeze({ clickForage: 'clicks', clickQueen: 'queen', eventChoice: 'events', clickEventObject: 'events', scrapeMold: 'events',
  bailFlood: 'events', cleanBlight: 'events', clickBeetle: 'golden', clickPupa: 'golden', openGift: 'golden', battleAction: 'loot',
  tournamentChoice: 'loot', bribe: 'loot', groomBrood: 'queen', demolishChamber: 'refund', cancelJob: 'refund', cancelPlanned: 'refund' });
const SYS_GRANT = Object.freeze({ events: 'events', golden: 'golden', rivals: 'loot', raids: 'loot', nest: 'caches', surface: 'scouting',
  population: 'moults', fieldguide: 'guide', achievements: 'achievements', unlocks: 'unlocks', trails: 'trails1', economy: 'colony', refund: 'refund',
  prestige: 'prestige', hardships: 'events', jobs: 'colony' });

/** Player-facing names of the categories. */
export const FLOW_NAMES = Object.freeze({
  eggs: 'Eggs & brood', chambers: 'Chambers & digging', adaptations: 'Adaptations', research: 'Research', territory: 'Territory & Mound',
  trails: 'Trails & abilities', war: 'War parties & bribes', raids: 'Stolen by raiders', events: 'Events', auto: 'Autobuyers', prestige: 'Prestige',
  clicks: 'Clicks', queen: 'Queen visits', golden: 'Golden beetles & gifts', loot: 'Battle loot', caches: 'Caches dug up', scouting: 'Scouting',
  moults: 'Moults', guide: 'Field Guide', achievements: 'Achievements', unlocks: 'Unlocks', trails1: 'Trail finds', colony: 'Colony', refund: 'Refunds',
  upkeep: 'Upkeep', spoilage: 'Clay spoilage', wasted: 'Wasted at cap', leavesEaten: 'Fed to fungus gardens', fed: 'Fed to the colony',
  other: 'Other',
});

/** Category of a spend tag. */
export function spendCategory(tag) {
  const t = String(tag || '');
  if (t.startsWith('cmd:')) return CMD_SPEND[t.slice(4)] || 'other';
  return SYS_SPEND[t] || 'other';
}

/** Category of a grant tag. */
export function grantCategory(tag) {
  const t = String(tag || '');
  if (t.startsWith('cmd:')) return CMD_GRANT[t.slice(4)] || 'other';
  return SYS_GRANT[t] || 'other';
}

/** Name of a flow key: 'src:<label>', 'trail:<sourceType>' or a category. */
export function flowName(key) {
  const k = String(key || '');
  if (k.startsWith('trail:')) return nameOf('source', k.slice(6)) + ' trails';
  if (k.startsWith('src:')) {
    const l = k.slice(4);
    return SRC_NAMES[l] || (l.charAt(0).toUpperCase() + l.slice(1).replace(/_/g, ' '));
  }
  return FLOW_NAMES[k] || k;
}

/**
 * Continuous in / out rates right now (per real second). Pure.
 * @param {Object} s
 * @param {Object} d
 * @returns {{ in: Object<string, Object<string, number>>, out: Object<string, Object<string, number>> }}
 */
export function instantFlows(s, d) {
  const rates = obj(d && d.rates);
  const inn = {};
  const out = {};
  let speed = 1;
  try { const x = diapauseInfo(s, d); if (x.running) speed = x.speed; } catch { speed = 1; }
  const add = (box, res, key, v) => {
    const x = num(v) * speed;
    if (!(x > 0) || !Number.isFinite(x)) return;
    const b = box[res] || (box[res] = {});
    b[key] = (b[key] || 0) + x;
  };
  // food / honeydew / chitin / leaves trails: split by source type, scaled to the softcapped label total
  const trailsS = arr(s && s.run && s.run.surface && s.run.surface.trails);
  const trailsD = arr(d && d.surface && d.surface.trails);
  const sources = arr(s && s.run && s.run.surface && s.run.surface.sources);
  const srcType = (uid) => { const x = sources.find((q) => q && q.uid === uid); return x ? x.type : 'unknown'; };
  const perType = {};
  for (let i = 0; i < trailsD.length; i++) {
    const td = trailsD[i];
    const ts = trailsS[i];
    if (!td || !ts) continue;
    const label = (res) => (res === 'honeydew' ? (ts.job === 'herder' ? 'trails' : ts.job === 'lycaenid' ? 'lycaenid' : 'flower') : 'trails');
    for (const [res, v] of [[td.res, td.out], [td.res2, td.out2]]) {
      if (!res || !(num(v) > 0) || label(res) !== 'trails') continue;
      const box = perType[res] || (perType[res] = {});
      const k = 'trail:' + srcType(ts.src);
      box[k] = (box[k] || 0) + num(v);
    }
  }
  for (const res of STAT_RES) {
    const r = obj(rates[res]);
    const src = obj(r.src);
    for (const label of Object.keys(src)) {
      const v = num(src[label]);
      if (!(v > 0)) continue;
      if (label === 'trails' && perType[res]) {
        const raw = Object.values(perType[res]).reduce((a, b) => a + b, 0);
        const f = raw > 0 ? v / raw : 0;
        for (const k of Object.keys(perType[res])) add(inn, res, k, perType[res][k] * f);
      } else {
        add(inn, res, 'src:' + label, v);
      }
    }
  }
  // outflows
  const food = obj(rates.food);
  add(out, 'food', 'upkeep', num(food.upkeep));
  const share = num(d && d.nest && d.nest.agg && d.nest.agg.clayFoodShare);
  if (share > 0) add(out, 'food', 'spoilage', num(s.run.res.food) * share * num(SPOILAGE.clayPerMin) / 60 / speed);
  const lv = obj(rates.leaves);
  add(out, 'leaves', 'leavesEaten', num(lv.gross) - num(lv.net));
  if (s && s.run && s.run.research && s.run.research.fungiculture) {
    let adults = 0;
    try { adults = adultsTotal(s); } catch { adults = 0; }
    add(out, 'fungus', 'fed', num(NUTRITION.perAdult) * adults * Math.max(0, Math.min(1, num(s.run.colony.phi))));
  }
  return { in: inn, out };
}

/**
 * The tracker: sample(s, d) at each UI refresh; breakdown(s, d, res) for the panel and tooltips.
 * @param {{ windowSec?: number }} [o]
 */
export function createResourceTracker({ windowSec = STATS_WINDOW_SEC } = {}) {
  /** @type {Array<{ t: number, run: Object, in: Object, out: Object, wasted: number, stock: Object, at: number }>} */
  let samples = [];
  let cache = null;

  function sample(s, d) {
    if (!s || !s.run) return;
    const t = num(s.run.time);
    const last = samples[samples.length - 1];
    if (last && (last.run !== s.run || t < last.t)) samples = [];   // a new run, a load or an import
    else if (last && t - last.t < 0.2) return;                       // paused, or several refreshes in one tick
    const f = instantFlows(s, d);
    const stock = {};
    for (const r of STAT_RES) stock[r] = num(s.run.res[r]);
    samples.push({ t, run: s.run, in: f.in, out: f.out, wasted: num(s.run.stats && s.run.stats.foodWasted), stock });
    while (samples.length > 2 && t - samples[1].t > windowSec) samples.shift();
    cache = null;
  }

  /**
   * In / out per second over the window for one resource, biggest first, plus totals.
   * @param {Object} s
   * @param {Object} d
   * @param {string} res
   * @returns {{ res: string, inflow: Array<{ key: string, label: string, rate: number }>, outflow: Array<{ key: string, label: string, rate: number }>,
   *   totalIn: number, totalOut: number, net: number, sec: number }}
   */
  function breakdown(s, d, res) {
    if (cache && cache.s === s && cache.n === samples.length && cache.t === num(s && s.run && s.run.time) && cache.by[res]) return cache.by[res];
    const inn = {};
    const out = {};
    // continuous: time-weighted average over the samples in the window
    let span = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const dt = b.t - a.t;
      if (!(dt > 0)) continue;
      span += dt;
      for (const [box, src] of [[inn, a.in[res]], [out, a.out[res]]]) {
        if (!src) continue;
        for (const k of Object.keys(src)) box[k] = (box[k] || 0) + src[k] * dt;
      }
    }
    if (span > 0) {
      for (const box of [inn, out]) for (const k of Object.keys(box)) box[k] /= span;
    } else if (samples.length) {
      const a = samples[samples.length - 1];
      Object.assign(inn, a.in[res] || {});
      Object.assign(out, a.out[res] || {});
    }
    // food wasted at the cap (counter deltas)
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (res === 'food' && span > 0) {
      const w = last.wasted - first.wasted;
      if (w > 0) out.wasted = (out.wasted || 0) + w / span;
    }
    // one-shots from the wallet flow log
    const ft = flowTotals(s, windowSec);
    const fsec = Math.max(1, ft.sec);
    for (const [kind, box, cat] of [['grant', inn, grantCategory], ['spend', out, spendCategory]]) {
      const byTag = obj(ft[kind][res]);
      for (const tag of Object.keys(byTag)) {
        const k = cat(tag);
        box[k] = (box[k] || 0) + num(byTag[tag]) / fsec;
      }
    }
    // what the stock change does not explain
    if (span >= 5 && first && last) {
      const totalIn = Object.values(inn).reduce((a, b) => a + b, 0);
      const totalOut = Object.values(out).reduce((a, b) => a + b, 0);
      const actual = (last.stock[res] - first.stock[res]) / span;
      const resid = totalIn - totalOut - actual;   // > 0: something else took it; < 0: something else added it
      const scale = Math.max(totalIn, totalOut, 1e-9);
      if (Math.abs(resid) > 0.05 * scale && Math.abs(resid) > 1e-4) {
        const capV = CAP_KEY[res] ? num(d && d.stats && d.stats[CAP_KEY[res]]) : 0;
        const atCap = capV > 0 && last.stock[res] >= capV * 0.98;
        if (resid > 0) { const k = atCap ? 'wasted' : 'other'; out[k] = (out[k] || 0) + resid; } else inn.other = (inn.other || 0) - resid;
      }
    }
    const list = (box) => Object.keys(box).filter((k) => box[k] > 1e-6).map((k) => ({ key: k, label: flowName(k), rate: box[k] }))
      .sort((a, b) => b.rate - a.rate);
    const inflow = list(inn);
    const outflow = list(out);
    const totalIn = inflow.reduce((a, x) => a + x.rate, 0);
    const totalOut = outflow.reduce((a, x) => a + x.rate, 0);
    const r = { res, inflow, outflow, totalIn, totalOut, net: totalIn - totalOut, sec: Math.max(span, Math.min(windowSec, num(s && s.run && s.run.time))) };
    if (!cache || cache.s !== s || cache.n !== samples.length) cache = { s, n: samples.length, t: num(s && s.run && s.run.time), by: {} };
    cache.by[res] = r;
    return r;
  }

  return {
    sample,
    breakdown,
    /** Number of samples held (tests). */
    size() { return samples.length; },
    reset() { samples = []; cache = null; },
  };
}

/** The tracker the shell samples (tooltips and the Stats panel read it); null outside the app. */
let active = null;
/** @param {ReturnType<typeof createResourceTracker>|null} t */
export function setActiveTracker(t) { active = t || null; }
/** @returns {ReturnType<typeof createResourceTracker>|null} */
export function activeTracker() { return active; }

/**
 * Tooltip lines: top 3 sources and sinks of a resource ("In: Seed patch trails 3.2/s · Clicks 0.4/s").
 * @param {Object} s
 * @param {Object} d
 * @param {string} res
 * @param {(x: number) => string} fmtRate
 * @returns {string[]}
 */
export function topFlowLines(s, d, res, fmtRate) {
  const t = active;
  if (!t || !STAT_RES.includes(res)) return [];
  let b;
  try { b = t.breakdown(s, d, res); } catch { return []; }
  const part = (list) => list.slice(0, 3).map((x) => x.label + ' ' + fmtRate(x.rate)).join(' · ');
  const lines = [];
  if (b.inflow.length) lines.push('In: ' + part(b.inflow));
  if (b.outflow.length) lines.push('Out: ' + part(b.outflow));
  if (lines.length) lines.push('Last ' + Math.round(Math.min(STATS_WINDOW_SEC, b.sec)) + ' s · details in Stats.');
  return lines;
}

export { RES_NAMES };
