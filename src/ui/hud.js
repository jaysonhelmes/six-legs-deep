// HUD: resource rail (value, rate, cap bar, "sc" badge, red when negative; only revealed resources), colony scale,
// prestige currencies, diapause; HUD top (season dial with forecast, bottleneck badge, raid badge, next-unlock
// ribbon); flow strip text; overlay toggle bar. Owner: WP9. Contract: ARCHITECTURE §14.6, DESIGN §25.2, §2.2, §17.1.

import { h, setText, show, toggleClass, setStyle, setBar, syncList } from './dom.js';
import { fmt, fmtRate, fmtCount, fmtTime, fmtClock, fmtMult } from './format.js';
import {
  RES_NAMES, SEASON_NAMES, BOTTLENECK_NAMES, BOTTLENECK_STATE, OVERLAY_NAMES, OVERLAY_TIPS, OVERLAY_VIEW, nameOf, unlockLabel, unlockHint,
  colonyTitle,
} from './text.js';
import { isShown, hasResearch, num, arr, obj } from './reveal.js';
import { OVERLAY_IDS, setOverlay, viewShows } from './uistate.js';
import { broodSummary } from '../systems/population.js';
import { firstHatchEta, adultsEta } from './intro.js';
import { UNLOCKS, REVEAL } from '../data/unlocks.js';
import { GRID, DIAPAUSE, OFFLINE } from '../data/balance.js';
import { offlineCapEff } from '../core/offline.js';
import { frontWindows } from './rules.js';
import { rivalName } from '../systems/rivals.js';

/** C152: rows of the rail's Ants breakdown, in order, and their labels. */
export const ANT_ROWS = Object.freeze(['minor', 'soldier', 'supermajor', 'replete', 'alate', 'queen']);
export const ANT_LABELS = Object.freeze({ minor: 'Workers', soldier: 'Soldiers', supermajor: 'Supermajors', replete: 'Repletes',
  alate: 'Alates (reared)', queen: 'Queens' });
/** Icon class per breakdown row (alates use the flight-currency icon, queens the egg). */
const ANT_ICON = Object.freeze({ minor: 'minor', soldier: 'soldier', supermajor: 'supermajor', replete: 'replete', alate: 'alates', queen: 'egg' });
/** Reveal key per breakdown row (a row also shows whenever its count is above zero). */
const ANT_KEYS = Object.freeze({ soldier: 'caste_soldier', supermajor: 'caste_supermajor', replete: 'caste_replete', alate: 'alate_rearing' });

/** C193: what caps each caste on the rail (unit shown after "n / cap"). */
export const ANT_CAP_UNITS = Object.freeze({ minor: 'housing', soldier: 'berths', supermajor: 'War Hall berths', replete: 'replete berths',
  alate: 'cells' });

/**
 * C152: the rail's Ants breakdown — [{ id, label, n, cap, unit }] for workers (minors), soldiers, supermajors, repletes,
 * reared alates and queens (one per active Royal Chamber, at least 1). A caste row shows once its caste is unlocked or
 * its count is above zero; workers and queens show with the rest. Empty (no breakdown) while the colony has only workers
 * and one queen.
 * C193: each caste also carries its cap — workers d.stats.housing (brood takes housing too), soldiers Barracks berths,
 * supermajors War Hall berths (d.stats.warBerths; without that field they share the Barracks berths: unit 'berths'),
 * repletes replete berths, alates the Nuptial Chamber's alate cells. cap is null for queens or when unknown.
 * @param {Object} s
 * @param {Object} d
 * @returns {Array<{ id: string, label: string, n: number, cap: number|null, unit: string }>}
 */
export function antBreakdown(s, d) {
  const col = obj(s && s.run && s.run.colony);
  const a = obj(col.adults);
  const royal = arr(d && d.nest && d.nest.agg && d.nest.agg.royal).filter((L) => num(L) > 0).length;
  const n = { minor: num(a.minor), soldier: num(a.soldier), supermajor: num(a.supermajor), replete: num(a.replete),
    alate: num(col.alatesReared), queen: Math.max(1, royal) };
  const rows = [];
  for (const id of ['soldier', 'supermajor', 'replete', 'alate']) if (n[id] > 0 || isShown(s, ANT_KEYS[id])) rows.push(id);
  if (rows.length === 0 && n.queen <= 1) return [];
  const st = obj(d && d.stats);
  const capNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const hasWar = capNum(st.warBerths) !== null;
  const caps = { minor: capNum(st.housing), soldier: capNum(st.berths), supermajor: hasWar ? capNum(st.warBerths) : capNum(st.berths),
    replete: capNum(st.repleteBerths), alate: capNum(st.alateCells), queen: null };
  const unit = (id) => (id === 'supermajor' && !hasWar ? 'berths' : ANT_CAP_UNITS[id] || '');
  return ['minor', ...rows, 'queen'].map((id) => ({ id, label: ANT_LABELS[id], n: n[id], cap: caps[id], unit: caps[id] === null ? '' : unit(id) }));
}

/** Rail resources in order with their reveal keys (ARCHITECTURE §11; leaves live in the fungus widget only). */
export const RAIL_RES = Object.freeze([
  { res: 'food', key: null, cap: 'foodCap' },
  { res: 'soil', key: 'job_digger', cap: null },
  { res: 'insight', key: 'panel_research', cap: null },
  { res: 'pheromone', key: 'res_pheromone', cap: 'pheromoneCap' },
  { res: 'chitin', key: 'res_chitin', cap: 'chitinCap' },   // C199: chitin storage cap
  { res: 'honeydew', key: 'res_honeydew', cap: 'honeydewCap' },
  { res: 'fungus', key: 'res_fungus', cap: 'fungusCap' },
]);

/** Reveal keys of the overlay buttons (ARCH-R: only `climate_overlay` is pinned; the others follow the feature that makes them meaningful). */
export const OVERLAY_KEYS = Object.freeze({
  climate: 'climate_overlay', raid_reach: ['raid_warnings', 'chamber_gate'], haul: 'chamber_granary', adjacency: 'chamber_nursery',
  territory: ['hex_claim', 'panel_rivals'], trail_strength: 'trail_slots', danger: 'raid_warnings', richness: 'trail_slots',
});

/**
 * Diapause state for the HUD (C112; DESIGN §21.5, core/game.js advance). Pure. While active with a bank, every tick
 * runs with econScale = speed and the bank drains by (speed − 1) s per real second, so it lasts bank / (speed − 1).
 * @param {Object} s
 * @param {Object} [d]
 * @returns {{ bank: number, active: boolean, running: boolean, speed: number, mastery: boolean, endsIn: number,
 *   drain: number, bankMax: number, bankRate: number, capSec: number }}
 */
export function diapauseInfo(s, d) {
  const dp = obj(s && s.meta && s.meta.diapause);
  const bank = Math.max(0, num(dp.bank));
  const mastery = num(s && s.era && s.era.federation && s.era.federation.diapause_mastery) > 0;
  const speed = mastery ? DIAPAUSE.speedMastery : DIAPAUSE.speed;
  const active = !!dp.active;
  let capSec = OFFLINE.baseCapSec;
  try {
    capSec = offlineCapEff(s, d).capSec;
  } catch {
    capSec = OFFLINE.baseCapSec;
  }
  return { bank, active, running: active && bank > 0, speed, mastery, endsIn: bank / (speed - 1), drain: speed - 1,
    bankMax: OFFLINE.bankMaxSec, bankRate: OFFLINE.bankRate, capSec };
}

/**
 * Diapause tooltip: what runs faster (exactly the systems that integrate env.econDt), what keeps real time, the drain
 * and how the bank is earned (C112).
 * @param {ReturnType<typeof diapauseInfo>} x
 * @returns {string}
 */
export function diapauseTip(x) {
  // Longer than the §25.6 12-word rule on purpose (C112): the full list lives in the Stats panel's Diapause section.
  const sp = x.speed + '×';
  const head = x.running
    ? 'Diapause ' + sp + ': ' + fmtTime(x.bank) + ' banked, ends in ' + fmtTime(x.endsIn) + '.'
    : 'Diapause: ' + fmtTime(x.bank) + ' banked (max ' + fmtTime(x.bankMax) + '). Spend to run ' + sp + '.';
  return head
    + ' Economy runs ' + sp + ': income, upkeep, laying, brood, digging.'
    + ' Seasons, events and raids stay real-time.'
    + ' Uses ' + x.drain + ' s of bank per second.'
    + ' Earned: ' + Math.round(x.bankRate * 100) + '% of offline time beyond the ' + fmtTime(x.capSec) + ' cap.';
}

const SEASON_FALLBACK = ['spring', 'summer', 'autumn', 'winter'];
const LONG_SUMMER = ['spring', 'summer', 'summer', 'autumn'];

/**
 * Bottleneck badge text (DESIGN §2.2, §5.8, §9.10, §17.3).
 * @param {Object} s
 * @param {Object} d
 * @returns {string} '' when nothing binds
 */
export function bottleneckText(s, d) {
  const bn = obj(s && s.run && s.run.bottleneck);
  if (!bn.id) return '';
  const p = bottleneckParts(bn.id, Math.max(0, num(s.run.time) - num(bn.since)), s, d);
  return p.time ? p.label + ' ' + p.time : p.label;
}

/** C194: the badge's explicit idle state. */
export const NO_BOTTLENECK = 'No bottleneck';

/**
 * Badge parts for a bottleneck id that has bound for `secs` seconds: { label, time } ('No bottleneck' for null; urgent
 * ids have no time). The badge keeps the time in its own fixed slot so a long label truncates without hiding it (C194).
 * @param {string|null} id
 * @param {number} secs
 * @param {Object} s
 * @param {Object} d
 * @returns {{ label: string, time: string }}
 */
export function bottleneckParts(id, secs, s, d) {
  if (!id) return { label: NO_BOTTLENECK, time: '' };
  if (id === 'raid') return { label: 'Raid incoming!', time: '' };
  if (id === 'hungry') return { label: 'Hungry: assign more foragers', time: '' };
  if (id === 'frost') {
    let frozen = 0;
    try { frozen = num(broodSummary(s, d).frozen); } catch { frozen = 0; }
    return { label: 'Frost: ' + fmtCount(frozen) + ' brood freezing', time: '' };
  }
  const name = BOTTLENECK_NAMES[id] || nameOf('unlock', id);
  const stateText = BOTTLENECK_STATE[id] || 'binding';
  return { label: 'Bottleneck: ' + name + ' · ' + stateText, time: fmtTime(Math.max(0, num(secs))) };
}

/** C194: seconds a new bottleneck must hold before the badge switches to it. */
export const BN_DEBOUNCE_SEC = 3;
/** Bottlenecks that show at once (they need the player now). */
const BN_URGENT = new Set(['raid', 'hungry', 'frost']);

/**
 * C194: debounce for the bottleneck badge. update(id, t, since) → { id, since }: the id to show and when it began
 * binding. A different id must hold for delaySec of run time before it replaces the shown one, so the badge stops
 * flickering between two limits that trade places, and the shown one keeps its own start time through such flips (its
 * timer does not restart). Urgent ids (raid, hungry, frost) and any limit replacing "No bottleneck" show at once. A
 * run-time jump backwards (new run, load, import) starts over. Pure (no clock of its own).
 * @param {number} [delaySec]
 */
export function createBottleneckDebounce(delaySec = BN_DEBOUNCE_SEC) {
  let started = false;
  let shown = null;
  let shownSince = 0;
  let cand;          // candidate id (undefined = none)
  let candAt = 0;    // run time the candidate was first seen
  let candSince = 0; // its own start time (s.run.bottleneck.since)
  let lastT = -Infinity;
  return {
    update(id, t, since) {
      const want = id || null;
      const tt = Number.isFinite(t) ? t : 0;
      const sn = Number.isFinite(since) ? since : tt;
      if (!started || tt < lastT) {
        started = true;
        shown = want;
        shownSince = want ? sn : tt;
        cand = undefined;
      } else if (want === shown) {
        cand = undefined;
      } else {
        if (cand !== want) { cand = want; candAt = tt; candSince = want ? sn : tt; }
        if (shown === null || BN_URGENT.has(want) || tt - candAt >= delaySec) {
          shown = want;
          shownSince = candSince;
          cand = undefined;
        }
      }
      lastT = tt;
      return { id: shown, since: shownSince };
    },
    reset() { started = false; shown = null; cand = undefined; lastT = -Infinity; },
  };
}

/**
 * C196: how long the current run has lasted, for the brand line ("45s", "12m", "1h 14m"; nothing while landing).
 * @param {Object} s
 * @returns {string}
 */
export function runTimeText(s) {
  if (!s || !s.run || (s.meta && s.meta.pending)) return '';
  const t = Math.max(0, num(s.run.time));
  if (t < 60) return Math.floor(t) + 's';
  if (t < 3600) return Math.floor(t / 60) + 'm';
  return fmtTime(t);
}

/** UnlockDef by key (for the ribbon's ETA corrections). */
const UNLOCK_DEFS = new Map(arr(UNLOCKS).filter(Boolean).map((u) => [u.key, u]));

/**
 * What the next-unlock ribbon shows (DESIGN §23 "always shows the nearest upcoming reveal and its ETA"):
 * d.progress.nextUnlock, corrected for two readings the systems estimate cannot make:
 *  - the Colony panel (first hatch) has no measurable rate there, so a later key with an ETA used to win
 *    ("Diggers ~12s" at 0:00); it is now the first-hatch time from the brood pipeline;
 *  - `{ adults: n }` keys there use the lay rate alone; brood still needs its development time, so the ETA is the
 *    hatch schedule of the brood already growing plus new eggs.
 * The head of the reveal queue is shown unchanged. Pure.
 * @param {Object} s
 * @param {Object} d
 * @returns {{ key: string, label: string, frac: number, eta: number } | null}
 */
export function ribbonInfo(s, d) {
  if (!s || !s.run || !s.meta) return null;
  const nu = d && d.progress ? d.progress.nextUnlock : null;
  const queued = arr(s.meta.reveal && s.meta.reveal.queue).length > 0;
  if (queued) return nu;
  const pending = (key) => !obj(s.run.unlocked)[key] && !obj(s.meta.seen)[key];
  const labelOf = (key) => (UNLOCK_DEFS.get(key) || {}).label || unlockLabel(key);
  if (pending('panel_colony')) {
    const fh = firstHatchEta(s, d);
    return { key: 'panel_colony', label: labelOf('panel_colony'), frac: fh.frac, eta: fh.eta };
  }
  let best = nu;
  const def = nu ? UNLOCK_DEFS.get(nu.key) : null;
  if (def && def.cond && typeof def.cond.adults === 'number') {
    const est = adultsEta(s, d, def.cond.adults);
    if (est >= 0) best = { ...nu, eta: Math.max(num(nu.eta, -1), est) };
  }
  // Build panel (custom housingFull: minors + brood ≥ housing): each egg laid fills a place at once.
  if (pending('panel_build')) {
    const housing = num(d && d.stats && d.stats.housing);
    let brood = 0;
    for (const c of arr(s.run.colony && s.run.colony.brood)) brood += num(c && c.n);
    const used = num(s.run.colony && s.run.colony.adults && s.run.colony.adults.minor) + brood;
    const lay = num(d && d.stats && d.stats.layRate);
    if (housing > 0) {
      const eta = used >= housing ? 0 : lay > 0 ? (housing - used) / lay : -1;
      best = earlierReveal({ key: 'panel_build', label: labelOf('panel_build'), frac: Math.min(1, used / housing), eta }, best);
    }
  }
  // Early reveals on player-driven conditions have no ETA, so the estimate skips them and the ribbon jumped to a key
  // many minutes away ("Gate · 15m") while Research was one scout away. Name the pending one with its condition.
  // Same for adult-count reveals while laying is blocked (housing full): "Scent Library · reach 30 adults".
  if (!best || num(best.eta, -1) < 0 || num(best.eta) > CUSTOM_AFTER_SEC) {
    let pick = null;
    for (const c of CUSTOM_NEXT) {
      if (!pending(c.key) || (c.after && !obj(s.meta.seen)[c.after])) continue;
      pick = { key: c.key, label: labelOf(c.key), frac: 0, eta: -1, hint: unlockHint(c.key) };
      break;
    }
    const a = obj(s.run.colony && s.run.colony.adults);
    const adults = num(a.minor) + num(a.soldier) + num(a.supermajor) + num(a.replete);
    for (const u of arr(UNLOCKS)) {
      if (!u || !u.queued || !pending(u.key) || !u.cond || typeof u.cond.adults !== 'number') continue;
      if (pick && UNLOCK_INDEX.get(pick.key) < UNLOCK_INDEX.get(u.key)) break;
      pick = { key: u.key, label: labelOf(u.key), frac: Math.min(1, adults / Math.max(1, u.cond.adults)), eta: -1, hint: unlockHint(u.key) };
      break;
    }
    if (pick && (!best || num(best.eta, -1) < 0 || UNLOCK_INDEX.get(pick.key) < (UNLOCK_INDEX.has(best.key) ? UNLOCK_INDEX.get(best.key) : 1e9))) best = pick;
  }
  return best;
}

/** Player-driven early reveals the ribbon names (with their condition) when nothing timed is near. */
const CUSTOM_NEXT = Object.freeze([
  { key: 'trail_slots', after: null }, { key: 'panel_research', after: 'job_scout' }, { key: 'panel_map', after: 'trail_slots' },
]);
const CUSTOM_AFTER_SEC = 120;

/** Table order of an unlock key (reveals run in this order, REVEAL.gapSec apart). */
const UNLOCK_INDEX = new Map(arr(UNLOCKS).filter(Boolean).map((u, i) => [u.key, i]));

/**
 * Which of two candidates reveals first: the sooner one, unless the other comes earlier in the table and is due within
 * one reveal gap of it (the queue then shows the earlier row first). Unknown ETAs lose to known ones.
 */
function earlierReveal(a, b) {
  if (!b) return a;
  if (!a) return b;
  const ea = num(a.eta, -1);
  const eb = num(b.eta, -1);
  if (ea < 0 && eb < 0) return num(a.frac) >= num(b.frac) ? a : b;
  if (ea < 0) return b;
  if (eb < 0) return a;
  const gap = num(REVEAL && REVEAL.gapSec, 30);
  const ia = UNLOCK_INDEX.has(a.key) ? UNLOCK_INDEX.get(a.key) : 1e9;
  const ib = UNLOCK_INDEX.has(b.key) ? UNLOCK_INDEX.get(b.key) : 1e9;
  if (ia < ib) return ea <= eb + gap ? a : b;
  return eb <= ea + gap ? b : a;
}

/**
 * Rail brand subtitle: 'Queen <name>', else 'Year Y · run N'. While the landing chooser is open (meta.pending) s.run
 * is the frozen skeleton (index 0), so the run shown is the one about to start, from meta.counters.runs (F21).
 * @param {Object} s
 * @param {Object} d
 * @returns {string}
 */
export function brandSubtitle(s, d) {
  if (s.meta.settings && s.meta.settings.queenName) return 'Queen ' + s.meta.settings.queenName;
  const year = 'Year ' + fmtCount(num(d && d.season && d.season.year));
  if (s.meta.pending) return year + ' · run ' + fmtCount(Math.floor(num(s.meta.counters && s.meta.counters.runs)) + 1) + ' · landing';
  return year + ' · run ' + fmtCount(num(s.run.index) + 1);
}

/** Ribbon text for ribbonInfo(). */
export function ribbonText(nu) {
  if (!nu) return '';
  const eta = num(nu.eta, -1);
  const label = nu.label || unlockLabel(nu.key);
  if (eta >= 0.5) return 'Next: ' + label + ' · ' + fmtTime(Math.ceil(eta));
  if (eta >= 0) return 'Next: ' + label + ' · now';
  if (nu.hint) return 'Next: ' + label + ' · ' + String(nu.hint).replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase());
  return 'Next: ' + label + ' · ' + Math.floor(num(nu.frac) * 100) + '%';
}

/**
 * Negative effects worth a HUD warning chip, by source (ids are prefixes of s.run.effects ids). `where`: how to
 * locate it ('top' = the topsoil rows of the nest; an object kind = that event object).
 */
const EFFECT_THREATS = Object.freeze([
  { id: 'flood', prefix: 'ev_flood', label: 'Flood', tip: 'Topsoil chambers are underwater. Click the water to bail it out.', where: 'top' },
  { id: 'rain', prefix: 'ev_rainstorm_keep', label: 'Rain', tip: 'Topsoil chambers work at half strength until it passes.', where: 'top' },
  { id: 'sealed', prefix: 'ev_rainstorm_seal', label: 'Sealed in', tip: 'Entrances sealed against the rain: no surface work.' },
  { id: 'drought', prefix: 'ev_drought', label: 'Drought', tip: 'Leaves and flowers yield less until it rains.' },
  { id: 'phorid', prefix: 'ev_phorid_flies', label: 'Phorid flies', tip: 'Soldiers fight at half strength; bare trails yield less.' },
  { id: 'cordyceps', prefix: 'ev_ophiocordyceps', label: 'Quarantine', tip: 'Foraging is slower while the sick are isolated.' },
  { id: 'mites', prefix: 'ev_brood_mites', label: 'Brood mites', tip: 'Brood develops slower. Nurses help.' },
  { id: 'ladybugs', prefix: 'ev_ladybug_raid', label: 'Ladybugs', tip: 'Aphid yield halved. Click the ladybugs to shoo them.', where: 'ladybug' },
  { id: 'evacuated', prefix: 'ev_army_evacuate', label: 'Evacuated', tip: 'Army ants are passing: no surface work for now.' },
  { id: 'parasite', prefix: 'ev_wandering_queen_parasite', label: 'Parasite queen', tip: 'The adopted queen was a parasite: laying slowed.' },
  { id: 'frostsnap', prefix: 'ev_frost_snap', label: 'Frost snap', tip: 'The frost reaches deeper for a while. Shallow brood freezes.' },
]);
/** Event objects that are threats on their own (the player clicks them away or routes around them). */
const OBJECT_THREATS = Object.freeze({
  antlion: { label: 'Antlion pit', tip: 'A trail runs past an antlion pit and loses ants. Reroute it.' },
  lizard: { label: 'Horned lizard', tip: 'A lizard is eating ants on a trail. Reroute or mob it.' },
  footstep: { label: 'Footstep!', tip: 'A shoe is coming down. Click the shadow to scatter.' },
  army_column: { label: 'Army ants', tip: 'An army ant column is crossing your land.' },
});

/** Map cell of a mold spot (its own cell, else the middle of its chamber). */
function moldCell(s, o) {
  if (num(o.cell, -1) >= 0) return num(o.cell);
  const ch = arr(s.run.nest && s.run.nest.chambers).find((c) => c && c.uid === (o.data && o.data.chamber));
  if (!ch) return -1;
  const cols = num(GRID && GRID.cols, 40);
  return (num(ch.y) + Math.floor(num(ch.h, 1) / 2)) * cols + num(ch.x) + Math.floor(num(ch.w, 1) / 2);
}

/**
 * Raids in warning for the HUD raid chip (C72, C96), soonest first. Pure. The raid has its own chip so the bottleneck
 * badge keeps naming the colony's real limit. Each: { uid, t (seconds to arrival), target: 'nest' | 'trail', rival
 * (display name), locate: { view: 'surface', hex } (the raiders' nest, else the main entrance) | null }.
 * @param {Object} s
 * @returns {Array<Object>}
 */
export function raidAlerts(s) {
  const raids = arr(s && s.run && s.run.war && s.run.war.raids).filter((r) => r && r.phase === 'warning');
  const list = arr(s && s.run && s.run.rivals && s.run.rivals.list);
  const entr = arr(s && s.run && s.run.surface && s.run.surface.entrances).find((e) => e && e.kind === 'main');
  return raids.map((r) => {
    const rv = list.find((x) => x && x.uid === r.rival);
    const hex = rv && Number.isInteger(rv.hex) ? rv.hex : entr && Number.isInteger(entr.hex) ? entr.hex : -1;
    return { uid: num(r.uid), t: Math.max(0, num(r.warn)), target: r.target && r.target.type === 'trail' ? 'trail' : 'nest',
      rival: rv ? rivalName(rv.type) : 'Rivals', locate: hex >= 0 ? { view: 'surface', hex } : null };
  }).sort((a, b) => a.t - b.t || a.uid - b.uid);
}

/**
 * Active negative effects for the HUD warning chips, most severe first. Pure.
 * Each: { id, label, tip, t (seconds left, -1 = until cleared), n (count), locate (for bridge.locate) | null }.
 * locate: { view: 'nest', cell?, row?, chamber? } | { view: 'surface', hex }.
 * @param {Object} s
 * @returns {Array<Object>}
 */
export function activeThreats(s) {
  if (!s || !s.run) return [];
  const out = [];
  // Argentine Front window (F13): a nest fell; the others must fall before the timer ends or the fallen ones regrow.
  frontWindows(s).forEach((w, i) => {
    out.push({ id: i === 0 ? 'front' : 'front:' + w.group, label: 'Front ' + w.fallen + '/' + w.total + ' down',
      tip: 'Take the other Argentine Front nests before the timer ends, or the fallen ones regrow at full strength.',
      t: w.remaining, tLabel: 'Fallen nests regrow in ', n: w.total - w.fallen,
      locate: w.target ? { view: 'surface', hex: num(w.target.hex) } : null });
  });
  const objects = arr(s.run.events && s.run.events.objects).filter(Boolean);
  // Mold: each spot halves its chamber and spreads until scraped (DESIGN §18.2).
  const molds = objects.filter((o) => o.kind === 'mold');
  if (molds.length) {
    const chambers = new Set(molds.map((o) => o.data && o.data.chamber).filter(Boolean));
    const spots = molds.map((o) => ({ view: 'nest', cell: moldCell(s, o), chamber: num(o.data && o.data.chamber) }))
      .filter((l) => l.cell >= 0 || l.chamber > 0);
    out.push({
      id: 'mold', label: 'Mold ×' + fmtCount(molds.length),
      tip: fmtCount(chambers.size) + ' chamber' + (chambers.size === 1 ? '' : 's') + ' at half strength. Click each spot to scrape it.',
      t: -1, n: molds.length, locate: spots[0] || null, spots,
    });
  }
  if (arr(s.run.events && s.run.events.active).some((a) => a && a.id === 'ev_fungal_blight' && a.data && a.data.k === 'blight')) {
    const g = arr(s.run.nest && s.run.nest.chambers).find((c) => c && c.type === 'fungus_garden');
    out.push({ id: 'blight', label: 'Fungal blight', tip: 'Click the fungus garden quickly to clean the blight.', t: -1, n: 1,
      locate: g ? { view: 'nest', chamber: g.uid, cell: (num(g.y) + Math.floor(num(g.h, 1) / 2)) * num(GRID && GRID.cols, 40) + num(g.x) } : null });
  }
  const effects = arr(s.run.effects).filter((e) => e && typeof e.id === 'string');
  for (const th of EFFECT_THREATS) {
    const hits = effects.filter((e) => e.id === th.prefix || e.id.startsWith(th.prefix + '_') || e.id.startsWith(th.prefix + ':'));
    if (!hits.length) continue;
    const t = Math.max(...hits.map((e) => num(e.t, -1)));
    let locate = null;
    if (th.where === 'top') locate = { view: 'nest', row: 0 };
    else if (th.where) {
      const o = objects.find((x) => x.kind === th.where && num(x.hex, -1) >= 0);
      if (o) locate = { view: 'surface', hex: num(o.hex) };
    }
    out.push({ id: th.id, label: th.label, tip: th.tip, t, n: hits.length, locate });
  }
  for (const kind of Object.keys(OBJECT_THREATS)) {
    const list = objects.filter((o) => o.kind === kind);
    if (!list.length) continue;
    const o = list[0];
    const def = OBJECT_THREATS[kind];
    const spots = list.filter((x) => num(x.hex, -1) >= 0).map((x) => ({ view: 'surface', hex: num(x.hex) }));
    out.push({ id: kind, label: def.label + (list.length > 1 ? ' ×' + fmtCount(list.length) : ''), tip: def.tip, t: num(o.t, -1), n: list.length,
      locate: spots[0] || null, spots });
  }
  return out;
}

/** Which threat chip a negative event spawns (for the "Show" button on its toast). */
export const EVENT_THREAT = Object.freeze({
  ev_mold_bloom: 'mold', ev_rainstorm: 'rain', ev_ladybug_raid: 'ladybugs', ev_antlion_pit: 'antlion', ev_horned_lizard: 'lizard',
  ev_footstep: 'footstep', ev_army_ant_column: 'army_column', ev_fungal_blight: 'blight',
});

/**
 * Season dial data: current season, seconds to the next, year fraction for the hand, quadrant order.
 * @param {Object} s
 * @param {Object} d
 */
export function seasonInfo(s, d) {
  const se = obj(d && d.season);
  const longSummer = s && s.cycle && s.cycle.edict === 'edict_of_long_summer';
  const order = longSummer ? LONG_SUMMER : SEASON_FALLBACK;
  const idx = Math.max(0, Math.min(3, num(se.index)));
  const len = num(se.len, num(s && s.meta && s.meta.season && s.meta.season.lengthSec, 360)) || 360;
  const tIn = num(se.tIn);
  const frac = (idx + Math.max(0, Math.min(1, tIn / len))) / 4;
  return {
    id: se.id || 'spring', next: se.forecast && se.forecast.next ? se.forecast.next : order[(idx + 1) % 4],
    toNext: num(se.toNext, len - tIn), year: num(se.year), mild: !!se.mild, frac, order,
  };
}

/**
 * Create the HUD.
 * @param {{ rail: HTMLElement, hudTop: HTMLElement, flowStrip: HTMLElement, overlayBar: HTMLElement }} els
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createHud({ rail, hudTop, flowStrip, overlayBar }, { game, ui, bridge }) {
  // ---------------------------------------------------------------- rail
  const brand = h('div', { class: 'rail-brand' }, h('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }),
      h('span', { class: 'brand-line' }, h('span', { class: 'brand-sub' }),
        h('span', { class: 'brand-time', dataset: { tip: 'How long this run has lasted.' } }))));
  const brandName = brand.querySelector('.brand-name');
  const brandSub = brand.querySelector('.brand-sub');
  const brandTime = brand.querySelector('.brand-time');   // C196 run timer
  const resList = h('div', { class: 'res-list', role: 'list' });
  const rows = {};
  for (const r of RAIL_RES) {
    const val = h('span', { class: 'res-val' });
    const rate = h('span', { class: 'res-rate' });
    const sc = h('span', { class: 'sc-badge', text: 'sc', dataset: { tipKey: 'sc:' + r.res } });
    const capFill = h('span', { class: 'cap-fill' });
    const cap = h('span', { class: 'cap-bar' }, capFill);
    const row = h('div', { class: 'res-row res-' + r.res, role: 'listitem', dataset: { tipKey: 'res:' + r.res, glowKey: 'res:' + r.res } },
      h('i', { class: 'ico ico-' + r.res, attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'res-name', text: RES_NAMES[r.res] }), val, sc, rate, cap);
    rows[r.res] = { row, val, rate, sc, cap, capFill, def: r };
    resList.appendChild(row);
  }
  // fungus widget: leaves buffer + nutrition ring
  const leavesFill = h('span', { class: 'cap-fill' });
  const leavesVal = h('span', { class: 'res-val' });
  const ring = h('span', { class: 'nutri-ring', dataset: { tipKey: 'nutrition' } });
  const ringVal = h('span', { class: 'nutri-val' });
  ring.appendChild(ringVal);
  const fungusWidget = h('div', { class: 'fungus-widget', dataset: { tipKey: 'fungusWidget' } },
    h('div', { class: 'fw-leaves' }, h('i', { class: 'ico ico-leaves', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'res-name', text: 'Leaves' }), leavesVal,
      h('span', { class: 'cap-bar' }, leavesFill)),
    h('div', { class: 'fw-ring' }, ring, h('span', { class: 'res-name', text: 'Nutrition' })));
  const popRow = h('div', { class: 'res-row res-pop', dataset: { tipKey: 'pop' } }, h('i', { class: 'ico ico-minor', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'res-name', text: 'Ants' }), h('span', { class: 'res-val' }), h('span', { class: 'res-rate' }));
  const popVal = popRow.querySelector('.res-val');
  const popRate = popRow.querySelector('.res-rate');
  // C152: per-caste breakdown under the Ants row (click / Enter on the row folds it; remembered per browser).
  const popChev = h('span', { class: 'pop-chev', text: '▾', attrs: { 'aria-hidden': 'true' } });
  popChev.style.marginLeft = '4px';
  popChev.style.opacity = '0.7';
  popRow.insertBefore(popChev, popRate);
  const popList = h('div', { class: 'res-list pop-castes', role: 'list', attrs: { 'aria-label': 'Ants by caste' } });
  const popSub = {};
  for (const id of ANT_ROWS) {
    const numEl = h('span', { class: 'pop-n' });
    const capEl = h('span', { class: 'pop-cap' });   // C193 "/ 1.5K housing"
    const val = h('span', { class: 'res-val' }, numEl, capEl);
    const row = h('div', { class: 'res-row res-sub pop-' + id, role: 'listitem', dataset: id === 'queen' ? { tipKey: 'lay' } : {} },
      h('i', { class: 'ico ico-' + ANT_ICON[id], attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'res-name', text: ANT_LABELS[id] }), val);
    row.style.paddingLeft = '14px';
    row.style.fontSize = '0.9em';
    popSub[id] = { row, val, num: numEl, cap: capEl };
    popList.appendChild(row);
  }
  let popOpen = true;
  try { popOpen = globalThis.localStorage ? globalThis.localStorage.getItem('sld.railAnts') !== 'closed' : true; } catch { popOpen = true; }
  const togglePop = () => {
    popOpen = !popOpen;
    try { if (globalThis.localStorage) globalThis.localStorage.setItem('sld.railAnts', popOpen ? 'open' : 'closed'); } catch { /* per-viewer convenience */ }
    if (game.s && game.s.run) updateRail(game.s, game.d);
  };
  popRow.addEventListener('click', togglePop);
  popRow.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { if (ev.preventDefault) ev.preventDefault(); togglePop(); }
  });
  const metaList = h('div', { class: 'res-list res-meta' });
  const metaRows = {};
  for (const [k, label] of [['alates', 'Alates'], ['kinship', 'Kinship'], ['genes', 'Genes']]) {
    const val = h('span', { class: 'res-val' });
    const row = h('div', { class: 'res-row res-' + k, dataset: { tipKey: 'res:' + k } }, h('i', { class: 'ico ico-' + k, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'res-name', text: label }), val);
    metaRows[k] = { row, val };
    metaList.appendChild(row);
  }
  const scaleRow = h('div', { class: 'res-row res-scale', dataset: { tipKey: 'scale' } }, h('span', { class: 'res-name', text: 'Colony Scale' }), h('span', { class: 'res-val' }));
  const scaleVal = scaleRow.querySelector('.res-val');
  const diaRow = h('div', { class: 'res-row res-diapause', dataset: { tip: 'Diapause: banked offline time. Spend it to run the colony economy 2× as fast.' } },
    h('span', { class: 'res-name', text: 'Diapause' }), h('span', { class: 'res-val' }));
  const diaVal = diaRow.querySelector('.res-val');
  const diaBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Spend',
    on: { click: () => {
      const on = !(game.s.meta.diapause && game.s.meta.diapause.active);
      const res = game.actions.do('spendDiapause', { on });
      if (!res.ok) bridge.reject(res.reason, 0, 0, 'spendDiapause');
    } } });
  diaRow.appendChild(diaBtn);
  if (rail) {
    rail.append(brand, resList, fungusWidget, h('div', { class: 'rail-sep' }), popRow, popList, metaList, scaleRow, diaRow);
  }

  // ---------------------------------------------------------------- HUD top
  const dial = h('div', { class: 'season-dial', dataset: { tipKey: 'season' }, role: 'img' });
  const dialFace = h('span', { class: 'dial-face' });
  const dialHand = h('span', { class: 'dial-hand' });
  dial.append(dialFace, dialHand);
  const seasonName = h('span', { class: 'season-name' });
  const seasonNext = h('span', { class: 'season-next' });
  const forecast = h('span', { class: 'forecast' });
  const seasonBox = h('div', { class: 'season-box' }, dial, h('span', { class: 'season-text' }, seasonName, seasonNext, forecast));
  // C194: fixed-width badge (the label truncates, the timer keeps its slot), a 3 s debounce before a new limit replaces
  // the shown one, and an explicit "No bottleneck" state.
  const badgeName = h('span', { class: 'bn-name' });
  const badgeTime = h('span', { class: 'bn-time' });
  const badge = h('button', { type: 'button', class: 'bn-badge', dataset: { tipKey: 'bottleneck', glowKey: 'badge' },
    on: { click: () => onBadge() } }, badgeName, badgeTime);
  const bnDebounce = createBottleneckDebounce();
  let bnShown = { id: null, since: 0 };
  // Raid chip (C72, C96): an incoming raid gets its own chip with the countdown; the bottleneck badge keeps the real
  // limit. A click brings the raiders' nest into view (repeated clicks step through several raids).
  const raidLabel = h('span', { class: 'threat-label' });
  const raidTime = h('span', { class: 'threat-time' });
  const raidBadge = h('button', { type: 'button', class: 'threat-chip raid-chip locatable', dataset: { threat: 'raid' } },
    h('span', { class: 'threat-ico', attrs: { 'aria-hidden': 'true' } }), raidLabel, raidTime);
  let raidNext = 0;
  raidBadge.addEventListener('click', () => {
    const spots = raidAlerts(game.s).filter((x) => x.locate);
    if (!spots.length || typeof bridge.locate !== 'function') { bridge.openTab('map', 'war'); return; }
    bridge.locate(spots[raidNext % spots.length].locate);
    raidNext = (raidNext + 1) % spots.length;
  });
  // Warning chips for active negative effects (mold, flood, ladybugs…): the bottleneck badge names only the binding
  // limit, so a chamber halved by mold used to read as "Food cap". Click → bridge.locate (scroll / centre on it).
  const threatBox = h('div', { class: 'threats', role: 'group', attrs: { 'aria-label': 'Active threats' } });
  const ribbonFill = h('span', { class: 'ribbon-fill' });
  const ribbonLabel = h('span', { class: 'ribbon-text' });
  const ribbon = h('div', { class: 'unlock-ribbon', dataset: { tipKey: 'ribbon' } }, ribbonFill, ribbonLabel);
  const notices = h('div', { class: 'hud-notices' });
  const skewNote = h('div', { class: 'hud-notice' }, h('span', { text: 'Your clock went backwards; no offline time was credited.' }),
    h('button', { type: 'button', class: 'btn btn-icon', text: '×', attrs: { 'aria-label': 'Dismiss' }, on: { click: () => { skewDismissed = true; show(skewNote, false); } } }));
  notices.appendChild(skewNote);
  const actions = h('div', { class: 'hud-actions' });
  // Diapause chip (C112): while the bank is being spent, the speed, bank and time left, with what it accelerates
  const diaChipText = h('span', { class: 'dia-chip-text' });
  const diaChip = h('button', { type: 'button', class: 'dia-chip', dataset: { tip: '' } },
    h('span', { class: 'dia-chip-ico', attrs: { 'aria-hidden': 'true' } }), diaChipText);
  diaChip.addEventListener('click', () => {
    const res = game.actions.do('spendDiapause', { on: false });
    if (!res.ok) bridge.reject(res.reason, 0, 0, 'spendDiapause');
  });
  if (hudTop) hudTop.append(seasonBox, badge, raidBadge, diaChip, threatBox, ribbon, notices, actions);
  let skewDismissed = false;

  // ---------------------------------------------------------------- flow strip
  const flowText = h('div', { class: 'flow-text', attrs: { 'aria-live': 'off' } });
  const flowFood = h('span', { class: 'flow-food' });
  const flowAnts = h('span', { class: 'flow-ants' });
  const flowWar = h('span', { class: 'flow-war' });
  flowText.append(flowFood, h('span', { class: 'flow-sep', text: '▸' }), flowAnts, flowWar);
  if (flowStrip) flowStrip.appendChild(flowText);

  // ---------------------------------------------------------------- overlay bar
  const ovBtns = {};
  const ovGroups = { below: h('div', { class: 'ov-group' }, h('span', { class: 'ov-label', text: 'Below' })),
    above: h('div', { class: 'ov-group' }, h('span', { class: 'ov-label', text: 'Above' })) };
  for (const id of OVERLAY_IDS) {
    const b = h('button', { type: 'button', class: 'ov-btn', text: OVERLAY_NAMES[id], dataset: { ov: id, tip: OVERLAY_TIPS[id] }, attrs: { 'aria-pressed': 'false' },
      on: { click: () => setOverlay(id) } });
    ovBtns[id] = b;
    ovGroups[OVERLAY_VIEW[id] || 'above'].appendChild(b);
  }
  if (overlayBar) overlayBar.append(ovGroups.below, ovGroups.above);

  function canSpendDiapause() {
    return !!(game.actions && typeof game.actions.spendDiapause === 'function');
  }

  function onBadge() {
    const id = bnShown.id;
    if (id === 'raid') bridge.openTab('map', 'war');
    else if (id === 'bn_housing' || id === 'bn_brood_slots' || id === 'bn_food_cap' || id === 'bn_lay_rate') bridge.openTab('build');
    else if (id === 'hungry' || id === 'bn_food') bridge.openTab('colony');
  }

  // ---------------------------------------------------------------- update
  function updateRail(s, d) {
    const st = obj(d && d.stats);
    const rates = obj(d && d.rates);
    setText(brandName, colonyTitle(s));   // C149: with the equipped title cosmetic
    setText(brandSub, brandSubtitle(s, d));
    const rt = runTimeText(s);
    show(brandTime, !!rt);
    if (rt) setText(brandTime, rt);   // '· ' (or 'Run ' in the top bar) comes from CSS
    for (const r of RAIL_RES) {
      const x = rows[r.res];
      const vis = isShown(s, r.key);
      show(x.row, vis);
      if (!vis) continue;
      const v = num(s.run.res[r.res]);
      setText(x.val, fmt(v));
      const rt = obj(rates[r.res]);
      const net = num(rt.net);
      setText(x.rate, fmtRate(net));
      toggleClass(x.rate, 'neg', net < 0);
      toggleClass(x.rate, 'zero', net === 0);
      show(x.sc, !!rt.sc);
      const capV = r.cap ? num(st[r.cap], 0) : 0;
      show(x.cap, capV > 0);
      if (capV > 0) {
        setBar(x.capFill, v / capV);
        toggleClass(x.row, 'full', v >= capV * 0.99);
        toggleClass(x.row, 'over', v > capV * 1.001);
      }
      toggleClass(x.row, 'glow', ui.getUI().glow === 'res:' + r.res);
    }
    const fw = isShown(s, 'fungus_widget');
    show(fungusWidget, fw);
    if (fw) {
      const lv = num(s.run.res.leaves);
      const lc = num(st.leafCap);
      setText(leavesVal, fmt(lv));
      setBar(leavesFill, lc > 0 ? lv / lc : 0);
      const phi = Math.max(0, Math.min(1, num(s.run.colony.phi)));
      setStyle(ring, '--phi', String(Math.round(phi * 100) / 100));
      setText(ringVal, Math.round(phi * 100) + '%');
    }
    const a = obj(s.run.colony.adults);
    const adults = num(a.minor) + num(a.soldier) + num(a.supermajor) + num(a.replete);
    let brood = 0;
    for (const c of arr(s.run.colony.brood)) brood += num(c && c.n);
    setText(popVal, fmtCount(adults));
    setText(popRate, brood > 0 ? '+' + fmtCount(brood) + ' brood' : '');
    // C152 caste breakdown
    const parts = antBreakdown(s, d);
    const hasList = parts.length > 0;
    show(popChev, hasList);
    show(popList, hasList && popOpen);
    setText(popChev, popOpen ? '▾' : '▸');
    if (hasList) {
      popRow.setAttribute('role', 'button');
      popRow.setAttribute('tabindex', '0');
      popRow.setAttribute('aria-expanded', popOpen ? 'true' : 'false');
    } else {
      popRow.removeAttribute('role');
      popRow.removeAttribute('tabindex');
      popRow.removeAttribute('aria-expanded');
    }
    const shown = new Set(parts.map((p) => p.id));
    for (const id of ANT_ROWS) {
      show(popSub[id].row, shown.has(id));
      const p = parts.find((x) => x.id === id);
      if (!p) continue;
      const x = popSub[id];
      setText(x.num, fmtCount(p.n));
      const hasCap = p.cap !== null && p.cap !== undefined;
      show(x.cap, hasCap);
      toggleClass(x.row, 'at-cap', hasCap && p.cap > 0 && p.n >= p.cap - 1e-9);
      if (hasCap) {
        setText(x.cap, ' / ' + fmtCount(p.cap) + ' ' + p.unit);
        const tip = p.label + ': ' + fmtCount(p.n) + ' of ' + fmtCount(p.cap) + ' ' + p.unit + (id === 'minor' ? ' (brood takes housing too).' : '.');
        if (x.row.dataset.tip !== tip) x.row.dataset.tip = tip;
      }
    }
    const showMeta = (k, vis, v) => { show(metaRows[k].row, vis); if (vis) setText(metaRows[k].val, fmtCount(v)); };
    showMeta('alates', num(s.meta.counters.flights) > 0 || num(s.cycle.alates) > 0, num(s.cycle.alates));
    showMeta('kinship', num(s.era.kinshipLife) > 0 || num(s.era.kinship) > 0, num(s.era.kinship));
    showMeta('genes', num(s.meta.genesLife) > 0 || num(s.meta.genes) > 0, num(s.meta.genes));
    const scale = num(d && d.meta && d.meta.colonyScale, num(st.colonyScale, 1));
    show(scaleRow, scale > 1.0001);
    setText(scaleVal, fmtMult(scale));
    const dia = diapauseInfo(s, d);
    const hasDia = dia.bank > 0 && canSpendDiapause();
    show(diaRow, hasDia);
    if (hasDia) {
      setText(diaVal, dia.running ? dia.speed + '× · ' + fmtTime(dia.bank) : fmtTime(dia.bank));
      setText(diaBtn, dia.active ? 'Pause' : 'Spend');
      toggleClass(diaRow, 'active', !!dia.active);
      const tip = diapauseTip(dia);
      if (diaRow.dataset.tip !== tip) diaRow.dataset.tip = tip;
      diaBtn.setAttribute('aria-label', (dia.active ? 'Pause Diapause. ' : 'Spend Diapause. ') + tip);
    }
  }

  function updateTop(s, d) {
    // season dial
    const dialOn = isShown(s, 'season_dial');
    show(seasonBox, dialOn);
    if (dialOn) {
      const si = seasonInfo(s, d);
      setStyle(dialHand, 'transform', 'rotate(' + Math.round(si.frac * 3600) / 10 + 'deg)');
      setAttrOnce(dialFace, si.order.join('-'));
      setText(seasonName, (SEASON_NAMES[si.id] || si.id) + (si.id === 'winter' && si.mild ? ' (mild)' : ''));
      setText(seasonNext, fmtClock(si.toNext) + ' → ' + (SEASON_NAMES[si.next] || si.next));
      dial.setAttribute('aria-label', (SEASON_NAMES[si.id] || si.id) + ', ' + fmtClock(si.toNext) + ' until ' + (SEASON_NAMES[si.next] || si.next));
      const fcOn = hasResearch(s, 'seasonal_clock');
      show(forecast, fcOn);
      if (fcOn) {
        const w = d && d.season && d.season.forecast ? d.season.forecast.weather : null;
        setText(forecast, w ? 'Forecast: ' + nameOf('event', w) + ' soon' : 'Forecast: clear');
      }
      for (const k of ['spring', 'summer', 'autumn', 'winter']) toggleClass(seasonBox, 'is-' + k, si.id === k);
    }
    // bottleneck badge (C194: debounced, with a "No bottleneck" state)
    const bnRaw = s.run.bottleneck || {};
    bnShown = bnDebounce.update(bnRaw.id || null, num(s.run.time), num(bnRaw.since, num(s.run.time)));
    const bnId = bnShown.id;
    const urgent = bnId === 'raid' || bnId === 'hungry' || bnId === 'frost';
    const badgeOn = isShown(s, 'panel_build') || urgent;
    show(badge, badgeOn);
    if (badgeOn) {
      const bp = bottleneckParts(bnId, num(s.run.time) - num(bnShown.since), s, d);
      // narrow: drop the "Bottleneck:" prefix so the badge fits beside the season dial (the tooltip still names it)
      setText(badgeName, ui.getUI().layout === 'narrow' ? bp.label.replace(/^Bottleneck: /, '') : bp.label);
      setText(badgeTime, bp.time);
      show(badgeTime, !!bp.time);
      const aria = bp.time ? bp.label + ' ' + bp.time : bp.label;
      if (badge.getAttribute('aria-label') !== aria) badge.setAttribute('aria-label', aria);
      const cls = 'bn-badge bn-' + (bnId || 'none') + (ui.getUI().glow === 'badge' ? ' glow' : '');
      if (badge.__cls !== cls) { badge.__cls = cls; badge.className = cls; }
    }
    // Diapause chip (C112)
    const dia = diapauseInfo(s, d);
    show(diaChip, dia.running && canSpendDiapause());
    if (dia.running) {
      setText(diaChipText, 'Diapause ' + dia.speed + '× · ' + fmtTime(dia.bank) + ' banked · ends in ' + fmtTime(dia.endsIn));
      const tip = diapauseTip(dia) + ' Click to pause.';
      if (diaChip.dataset.tip !== tip) diaChip.dataset.tip = tip;
      diaChip.setAttribute('aria-label', tip);
    }
    // raid chip (every raid in warning, soonest first)
    const raids = raidAlerts(s);
    show(raidBadge, raids.length > 0);
    if (raids.length) {
      const first = raids[0];
      setText(raidLabel, raids.length > 1 ? fmtCount(raids.length) + ' raids' : 'Raid');
      setText(raidTime, fmtTime(Math.ceil(first.t)));
      const tip = first.rival + ' raid your ' + first.target + ' in ' + fmtTime(Math.ceil(first.t)) + '. Click to show.';
      if (raidBadge.dataset.tip !== tip) raidBadge.dataset.tip = tip;
      raidBadge.setAttribute('aria-label', tip);
    }
    // warning chips
    const threats = activeThreats(s);
    const shown = threats.slice(0, 3);
    if (threats.length > 3) shown.push({ id: 'more', label: '+' + fmtCount(threats.length - 3), tip: threats.slice(3).map((x) => x.label).join(', '), t: -1, locate: null });
    syncList(threatBox, shown, (x) => x.id, createThreatChip, updateThreatChip);
    show(threatBox, shown.length > 0);
    // next-unlock ribbon
    const nu = ribbonInfo(s, d);
    show(ribbon, !!nu);
    if (nu) {
      setBar(ribbonFill, num(nu.frac));
      setText(ribbonLabel, ribbonText(nu));
    }
    show(skewNote, !!(s.meta.flags && s.meta.flags.clockSkew) && !skewDismissed);
  }

  function createThreatChip(x) {
    const label = h('span', { class: 'threat-label' });
    const time = h('span', { class: 'threat-time' });
    const chip = h('button', { type: 'button', class: 'threat-chip', dataset: { threat: x.id } },
      h('span', { class: 'threat-ico', attrs: { 'aria-hidden': 'true' } }), label, time);
    let next = 0; // repeated clicks step through the spots (mold in several chambers, two antlion pits…)
    chip.addEventListener('click', () => {
      const cur = activeThreats(game.s).find((t) => t.id === chip.dataset.threat);
      if (!cur || typeof bridge.locate !== 'function') return;
      const spots = arr(cur.spots).length ? cur.spots : cur.locate ? [cur.locate] : [];
      if (!spots.length) return;
      bridge.locate(spots[next % spots.length]);
      next = (next + 1) % spots.length;
    });
    chip.__r = { label, time };
    return chip;
  }

  function updateThreatChip(chip, x) {
    const r = chip.__r;
    setText(r.label, x.label);
    setText(r.time, num(x.t, -1) > 0 ? fmtTime(Math.ceil(x.t)) : '');
    // live tooltip (tooltips.js 'threat:<id>'); the "+N" overflow chip lists the hidden ones as plain text
    if (x.id === 'more') { if (chip.dataset.tip !== x.tip) chip.dataset.tip = x.tip; } else if (!chip.dataset.tipKey) chip.dataset.tipKey = 'threat:' + x.id;
    chip.setAttribute('aria-label', x.label + '. ' + x.tip);
    toggleClass(chip, 'locatable', !!x.locate);
    toggleClass(chip, 'more', x.id === 'more');
  }

  function setAttrOnce(el, order) {
    if (el.__order === order) return;
    el.__order = order;
    el.setAttribute('data-order', order);
  }

  function updateFlow(s, d) {
    const gross = num(d && d.rates && d.rates.food && d.rates.food.gross);
    setText(flowFood, '+' + fmtRate(gross).replace('/s', ' food/s'));
    const j = obj(s.run.colony.jobs);
    const out = num(j.forager) + num(j.scout) + num(j.herder) + num(j.leafcutter);
    setText(flowAnts, fmtCount(out) + ' ants out');
    const raids = arr(s.run.war && s.run.war.raids).filter((r) => r && r.phase !== 'done').length;
    const parties = arr(s.run.war && s.run.war.parties).length;
    const battles = arr(s.run.war && s.run.war.battles).length;
    const parts = [];
    if (raids) parts.push(fmtCount(raids) + ' raid' + (raids > 1 ? 's' : ''));
    if (parties) parts.push(fmtCount(parties) + ' campaign' + (parties > 1 ? 's' : ''));
    if (battles) parts.push(fmtCount(battles) + ' battle' + (battles > 1 ? 's' : ''));
    setText(flowWar, parts.length ? ' ▸ ' + parts.join(', ') : '');
    toggleClass(flowWar, 'danger', raids > 0);
  }

  function updateOverlays(s) {
    const st = ui.getUI();
    let any = false;
    const vis = { below: false, above: false };
    const shows = viewShows(st.view, st.layout);   // overlays for the canvases on screen (every layout, C96)
    for (const id of OVERLAY_IDS) {
      const view = OVERLAY_VIEW[id];
      const inView = view === 'below' ? shows.below : shows.above;
      const on = isShown(s, OVERLAY_KEYS[id]) && inView;
      show(ovBtns[id], on);
      if (on) { any = true; vis[view] = true; }
      const pressed = !!st.overlays[id];
      toggleClass(ovBtns[id], 'on', pressed);
      ovBtns[id].setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
    show(ovGroups.below, vis.below);
    show(ovGroups.above, vis.above);
    if (overlayBar) show(overlayBar, any);
  }

  return {
    /** Container for app-level buttons (drawer / sheet toggles). */
    actions,
    update(s, d) {
      if (!s || !s.run || !s.meta) return;
      updateRail(s, d);
      updateTop(s, d);
      updateFlow(s, d);
      updateOverlays(s);
    },
    destroy() {
      for (const el of [rail, hudTop, flowStrip, overlayBar]) {
        if (!el) continue;
        for (const c of Array.from(el.childNodes)) {
          if (c.tagName && c.tagName.toLowerCase() === 'canvas') continue;
          el.removeChild(c);
        }
      }
    },
    /** The bottleneck the badge shows after the debounce (C194; tests). */
    bottleneckShown() { return bnShown; },
    /** Rail rows by resource (tests). */
    _rows: rows,
  };
}
