// Offline progress: cap/efficiency, the chunked step schedule, the offline simulation through the real step(),
// diapause banking and Saved Finds banking. Owner: WP1. Contract: ARCHITECTURE §7.15 (DESIGN §21).
// ARCH-R: simulateOffline's eff has no documented default; when omitted it uses offlineCapEff(s, d).eff.
// Extra exports (emptySummary, mergeSummaries, skipSeasonTime) let game.js reach seasons.skipTime through the
// spine module §3 allows to import it, instead of importing a system directly.

import { OFFLINE } from '../data/balance.js';
import { step } from './step.js';
import { clampNum } from './math.js';
import * as seasons from '../systems/seasons.js';
import { RESEARCH } from '../data/research.js';
import { TRAITS } from '../data/bloodline.js';
import { CHAMBERS } from '../data/chambers.js';
import { FEDERATION } from '../data/federation.js';
import { GENOME } from '../data/genome.js';

/** fx object of a data-table entry, or {} while the table has no such entry. */
function fxOf(table, id) {
  const e = table && table[id];
  return (e && e.fx) || {};
}

/** Finite number or 0. */
function num(v) {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Offline cap (seconds) and efficiency (0..1) from research, traits, chambers, federation and genome (DESIGN §21.2):
 *   capSec = baseCapSec + collective_memory.offlineSec·[owned] + long_memory.capSec·L + deep_vault.offlineSec·deepVaultL
 *   eff    = min(1, baseEff + long_memory.eff·L + diapause_logic.offlineEff·[owned])
 *   diapause_mastery → capSec = max(capSec, its capSec), eff = its eff; dreaming_hive likewise.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @returns {{ capSec: number, eff: number }}
 */
export function offlineCapEff(s, d) {
  const research = (s.run && s.run.research) || {};
  const longL = num(s.cycle && s.cycle.traits && s.cycle.traits.long_memory);
  const vaultL = num(d && d.nest && d.nest.agg && d.nest.agg.deepVaultL);
  const longFx = fxOf(TRAITS, 'long_memory');
  let capSec = OFFLINE.baseCapSec
    + (research.collective_memory ? num(fxOf(RESEARCH, 'collective_memory').offlineSec) : 0)
    + num(longFx.capSec) * longL
    + num(fxOf(CHAMBERS, 'deep_vault').offlineSec) * vaultL;
  let eff = Math.min(1, OFFLINE.baseEff + num(longFx.eff) * longL
    + (research.diapause_logic ? num(fxOf(RESEARCH, 'diapause_logic').offlineEff) : 0));
  const overrides = [
    [s.era && s.era.federation && s.era.federation.diapause_mastery, fxOf(FEDERATION, 'diapause_mastery')],
    [s.meta && s.meta.genome && s.meta.genome.dreaming_hive, fxOf(GENOME, 'dreaming_hive')],
  ];
  for (const [level, fx] of overrides) {
    if (!(level > 0)) continue;
    if (Number.isFinite(fx.capSec)) capSec = Math.max(capSec, fx.capSec);
    if (Number.isFinite(fx.eff)) eff = Math.max(eff, fx.eff);
  }
  return { capSec, eff: Math.min(1, Math.max(0, eff)) };
}

/**
 * Step sizes for an offline simulation: OFFLINE.earlyStep (10 s) during the first OFFLINE.earlyWindow (600 s), then
 * OFFLINE.lateStep (60 s). With more than OFFLINE.maxSteps (1,500) steps every step size is multiplied by
 * count / maxSteps. The last step is trimmed so the steps sum to `seconds`. 24 h → 1,490 steps.
 * @param {number} seconds
 * @returns {number[]}
 */
export function offlineSchedule(seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return [];
  const count = countSteps(seconds, 1);
  let factor = count > OFFLINE.maxSteps ? count / OFFLINE.maxSteps : 1;
  let steps = build(seconds, factor);
  while (steps.length > OFFLINE.maxSteps) {
    factor *= 1.001;
    steps = build(seconds, factor);
  }
  return steps;
}

/** Number of steps build(seconds, factor) would produce (closed form, so huge gaps never allocate). */
function countSteps(seconds, factor) {
  const early = OFFLINE.earlyStep * factor;
  const late = OFFLINE.lateStep * factor;
  const nEarly = Math.ceil(Math.min(seconds, OFFLINE.earlyWindow) / early - 1e-9);
  const tEarly = nEarly * early;
  if (seconds - tEarly <= 1e-9) return nEarly;
  return nEarly + Math.ceil((seconds - tEarly) / late - 1e-9);
}

/** Generate the schedule with step sizes × factor; the last step is trimmed (a sub-µs remainder merges into it). */
function build(seconds, factor) {
  const early = OFFLINE.earlyStep * factor;
  const late = OFFLINE.lateStep * factor;
  const out = [];
  let t = 0;
  while (seconds - t > 1e-9) {
    let size = t < OFFLINE.earlyWindow ? early : late;
    if (t + size >= seconds - 1e-9) size = seconds - t;
    out.push(size);
    t += size;
  }
  return out;
}

/** Absolute season index (completed seasons since year 0) from the persistent clock. */
function seasonIndex(s) {
  const se = s.meta && s.meta.season;
  if (!se || !(se.lengthSec > 0)) return 0;
  return num(se.year) * 4 + Math.floor(num(se.t) / se.lengthSec);
}

/** Snapshot of the counters a summary is built from. */
function snap(s) {
  const st = s.run.stats;
  return {
    fRun: num(s.run.fRun),
    wasted: num(st.foodWasted),
    hatched: num(st.hatched),
    cellsDug: num(st.cellsDug),
    chambersDone: num(st.chambersDone),
    sourcesDepleted: num(st.sourcesDepleted),
    season: seasonIndex(s),
    runIndex: s.run.index,
  };
}

/**
 * Empty offline summary.
 * @param {number} [eff=1]
 * @returns {import('./types.js').OfflineSummary}
 */
export function emptySummary(eff = 1) {
  return { seconds: 0, eff, foodGained: 0, foodWasted: 0, hatched: 0, cellsDug: 0, chambersDone: 0, seasons: 0,
    sourcesDepleted: 0, savedFinds: 0, diapause: 0, cells: [], chambers: [] };
}

/**
 * Simulate `seconds` offline with the real step (env.offline = true, env.eff = eff) on the offlineSchedule.
 * d.offlineLog collects dug cells / finished chambers (WP3 appends) and is reset to null afterwards.
 * eff defaults to offlineCapEff(s, d).eff when omitted.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @param {number} seconds
 * @param {{ eff?: number, stepFn?: typeof step }} [opts]
 * @returns {import('./types.js').OfflineSummary}
 */
export function simulateOffline(s, d, seconds, { eff, stepFn = step } = {}) {
  const e = Number.isFinite(eff) ? Math.min(1, Math.max(0, eff)) : offlineCapEff(s, d).eff;
  const sum = emptySummary(e);
  const schedule = offlineSchedule(seconds);
  if (schedule.length === 0) return sum;
  d.offlineLog = { cells: [], chambers: [] };
  const a = snap(s);
  for (const size of schedule) stepFn(s, d, size, [], { offline: true, eff: e });
  const b = snap(s);
  const log = d.offlineLog || { cells: [], chambers: [] };
  const sameRun = a.runIndex === b.runIndex;
  const diff = (k) => (sameRun ? Math.max(0, b[k] - a[k]) : 0);
  sum.seconds = seconds;
  sum.foodGained = diff('fRun');
  sum.foodWasted = diff('wasted');
  sum.hatched = diff('hatched');
  sum.cellsDug = diff('cellsDug');
  sum.chambersDone = diff('chambersDone');
  sum.sourcesDepleted = diff('sourcesDepleted');
  sum.seasons = Math.max(0, b.season - a.season);
  sum.cells = Array.isArray(log.cells) ? log.cells.slice() : [];
  sum.chambers = Array.isArray(log.chambers) ? log.chambers.slice() : [];
  d.offlineLog = null;
  return sum;
}

/**
 * Merge two offline summaries (sums; eff of the second when it covered any time, else the first's).
 * @param {import('./types.js').OfflineSummary} a
 * @param {import('./types.js').OfflineSummary} b
 * @returns {import('./types.js').OfflineSummary}
 */
export function mergeSummaries(a, b) {
  return {
    seconds: a.seconds + b.seconds,
    eff: b.seconds > 0 ? b.eff : a.eff,
    foodGained: a.foodGained + b.foodGained,
    foodWasted: a.foodWasted + b.foodWasted,
    hatched: a.hatched + b.hatched,
    cellsDug: a.cellsDug + b.cellsDug,
    chambersDone: a.chambersDone + b.chambersDone,
    seasons: a.seasons + b.seasons,
    sourcesDepleted: a.sourcesDepleted + b.sourcesDepleted,
    savedFinds: a.savedFinds + b.savedFinds,
    diapause: a.diapause + b.diapause,
    cells: a.cells.concat(b.cells),
    chambers: a.chambers.concat(b.chambers),
  };
}

/**
 * Advance only the persistent season clock (time beyond the offline cap still passes, DESIGN §18 C12).
 * Returns the number of season boundaries crossed.
 * @param {import('./types.js').State} s
 * @param {number} sec
 * @returns {number}
 */
export function skipSeasonTime(s, sec) {
  if (!(sec > 0)) return 0;
  const before = seasonIndex(s);
  seasons.skipTime(s, sec);
  return Math.max(0, seasonIndex(s) - before);
}

/**
 * Bank time beyond the offline cap into the diapause bank: bank += min(beyond × bankRate, bankMaxSec − bank).
 * @param {import('./types.js').State} s
 * @param {number} beyondSec
 * @returns {number} seconds added
 */
export function bankBeyondCap(s, beyondSec) {
  if (!(beyondSec > 0)) return 0;
  const dp = s.meta.diapause;
  const add = Math.max(0, Math.min(beyondSec * OFFLINE.bankRate, OFFLINE.bankMaxSec - num(dp.bank)));
  dp.bank = clampNum(num(dp.bank) + add);
  return add;
}

/**
 * Bank Saved Finds: savedFinds = min(findMax, savedFinds + floor(gap / findEverySec)).
 * @param {import('./types.js').State} s
 * @param {number} gapSec
 * @returns {number} finds added
 */
export function bankSavedFinds(s, gapSec) {
  if (!(gapSec > 0)) return 0;
  const cur = num(s.meta.savedFinds);
  const next = Math.min(OFFLINE.findMax, cur + Math.floor(gapSec / OFFLINE.findEverySec));
  const add = Math.max(0, next - cur);
  s.meta.savedFinds = cur + add;
  return add;
}
