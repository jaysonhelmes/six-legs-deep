// Job pools of minor workers: manual moves, absolute assignment, ratio targets (age_polyethism auto mode), response
// thresholds (retarget toward the bottleneck), saved presets (hive_mind) and the per-tick consistency rule.
// Owner: WP2. Contract: ARCHITECTURE §8.1 (jobs.js), §9 (job commands), DESIGN §6.2–§6.3.
// ARCH-R: auto assignment runs while autoJobs OR thresholdJobs is on (threshold mode retargets, so it implies following
// the targets). Locked jobs' shares and shares above a cap go to foragers (C94). Threshold mode never edits the player's
// targets: it keeps a decaying per-job bias in run.colony.jobBias (optional field, C94) and follows targets + bias.
// ARCH-R: "herders up when honeydew is short for a pending purchase" is read as: the next alate egg while rearing, or the
// next level of an available honeydew-costing Adaptation, costs more honeydew than is stored (and fits under the cap).
// ARCH-R: shiftJob clamps n to what is available in `from` and to the room under `to`'s cap (rejecting only when that is 0).

import { JOB_ORDER, JOBS, THRESHOLDS, PRESETS } from '../data/jobs.js';
import { RESEARCH } from '../data/research.js';
import { ADAPTATION_ORDER } from '../data/adaptations.js';
import { clampNum, lvl } from '../core/math.js';
import { eggCost } from './stats.js';
import { cost as adaptationCost, isAvailable as adaptationAvailable } from './adaptations.js';

/** Numeric tolerance for float comparisons (not a balance number). */
const EPS = 1e-9;

/** Finite number or the fallback. */
function num(v, dflt = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Own-property test that is safe for '__proto__' and friends. */
function own(obj, k) {
  return !!obj && typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
}

/** True for a plain (non-array) object. */
function isMap(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** True for a known job id. */
function isJob(j) {
  return own(JOBS, j);
}

/** True if the job's unlock key is set (or it has none). */
function jobUnlocked(s, job) {
  if (!isJob(job)) return false;
  const u = JOBS[job].unlock;
  return u === null || u === undefined || !!s.run.unlocked[u];
}

/** Innate job automation: the Federation node automated_brood (DESIGN §6.3, §14.5; C166: no longer automaton_instincts). */
function innateAutomation(s) {
  return lvl(s.era.federation, 'automated_brood') > 0;
}

/** Ratio auto mode available. */
function autoAvailable(s) {
  return !!s.run.research.age_polyethism || innateAutomation(s);
}

/** Response-threshold mode available. */
function thresholdAvailable(s) {
  return !!s.run.research.response_thresholds || innateAutomation(s);
}

/** Job ratio presets available (unlock key job_presets, or the auto-mode prerequisites it stands for). */
function presetsAvailable(s) {
  return !!s.run.unlocked.job_presets || autoAvailable(s) || lvl(s.cycle.traits, 'automaton_instincts') > 0;
}

/** Saved presets need hive_mind. */
function hiveMind(s) {
  return !!s.run.research.hive_mind;
}

/** Σ jobs. */
function jobSum(col) {
  let t = 0;
  for (const j of JOB_ORDER) t += num(col.jobs[j]);
  return t;
}

/** A sanitised copy of a job → fraction map (every job key, finite 0..1). */
function cleanTargets(src) {
  const out = {};
  for (const j of JOB_ORDER) out[j] = isMap(src) ? clampNum(num(src[j]), 0, 1) : 0;
  return out;
}

/**
 * [q] Minors not in any job and not in the militia: adults.minor − Σ jobs − militia (never below 0).
 * @param {import('../core/types.js').State} s
 * @returns {number}
 */
export function idleMinors(s) {
  const col = s.run.colony;
  return clampNum(num(col.adults.minor) - jobSum(col) - num(col.militia));
}

/**
 * [q] C231: most nurses that still speed brood up. Brood time divides by 1 + min(maxPerSlot, (nurses + 1) / slots)
 * (stats.nurseTerm; the queen is the "+ 1"), so past maxPerSlot × slots − 1 nurses an extra nurse changes nothing:
 * ceil(maxPerSlot × slots − 1), never below Field Triage's nurse threshold once it is researched (its only other use).
 * Infinity when d has no brood-slot stat.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number}
 */
export function nurseCap(s, d) {
  const slots = d && d.stats ? num(d.stats.broodSlots, NaN) : NaN;
  if (!Number.isFinite(slots)) return Infinity;
  let cap = Math.max(0, Math.ceil(JOBS.nurse.fx.maxPerSlot * Math.max(0, slots) - 1 - 1e-6));
  if (s && s.run && s.run.research && s.run.research.field_triage && own(RESEARCH, 'field_triage') && RESEARCH.field_triage.fx) {
    cap = Math.max(cap, num(RESEARCH.field_triage.fx.nurses));
  }
  return cap;
}

/**
 * [q] Most workers the job can hold: gardener → d.stats.gardenerSlots; nurse → nurseCap (C231: 4 per brood slot, the
 * queen counting as one); herder → Σ caps of the aphid colonies on herder
 * trails (capPerLevel × level, ×herderCap with aphid_shepherding); other jobs Infinity; a locked or unknown job 0.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} job
 * @returns {number}
 */
export function jobCap(s, d, job) {
  if (!jobUnlocked(s, job)) return 0;
  if (job === 'leafcutter' && !leavesUsable(d)) return 0;   // C238: no leaf storage yet → no leafcutters
  if (job === 'gardener') return clampNum(num(d && d.stats ? d.stats.gardenerSlots : 0));
  if (job === 'nurse') return nurseCap(s, d);
  if (job === 'herder') {
    const sh = s.run.research.aphid_shepherding && own(RESEARCH, 'aphid_shepherding') && RESEARCH.aphid_shepherding.fx
      ? num(RESEARCH.aphid_shepherding.fx.herderCap, 1) : 1;
    const per = JOBS.herder.fx.capPerLevel;
    const srcs = s.run.surface.sources;
    let cap = 0;
    for (const t of s.run.surface.trails) {
      if (!t || t.job !== 'herder') continue;
      const src = srcs.find((x) => x && x.uid === t.src);
      if (src) cap += per * Math.max(1, num(src.level, 1)) * sh;
    }
    return clampNum(cap);
  }
  return Infinity;
}

/**
 * [q] C238: leaves have a use once a Fungus Garden stores them (d.stats.leafCap > 0). Before that, leafcutting is
 * researched but every leaf carried home would be thrown away, so the leafcutter job holds no one (jobCap 0; assigning
 * one is refused with 'requirements:garden'), and leafcutters already at work return to foraging.
 * @param {import('../core/types.js').Derived} d
 * @returns {boolean}
 */
export function leavesUsable(d) {
  return num(d && d.stats ? d.stats.leafCap : 0) > 0;
}

/** C238: leafcutters with nowhere to put their leaves (no Fungus Garden) go back to foraging. */
function releaseLeafcutters(s, d) {
  const col = s.run.colony;
  const n = num(col.jobs.leafcutter);
  if (!(n > 0) || leavesUsable(d)) return;
  col.jobs.leafcutter = 0;
  col.jobs.forager = clampNum(num(col.jobs.forager) + n);
}

/**
 * [x] population.killAdults only. Take n workers out of the jobs (from `job` first, then all jobs proportionally), then
 * enforce Σ jobs + militia ≤ minors by a proportional scale-down. Trail workers are re-clamped by WP4 next tick.
 * @param {import('../core/types.js').State} s
 * @param {number} n
 * @param {string|null} [job=null]
 * @returns {void}
 */
export function releaseMinors(s, n, job = null) {
  const col = s.run.colony;
  let rem = clampNum(num(n));
  if (rem > 0 && isJob(job)) {
    const take = Math.min(rem, num(col.jobs[job]));
    col.jobs[job] = clampNum(num(col.jobs[job]) - take);
    rem -= take;
  }
  if (rem > 0) {
    const total = jobSum(col);
    if (total > 0) {
      const keep = 1 - Math.min(1, rem / total);
      for (const j of JOB_ORDER) col.jobs[j] = clampNum(num(col.jobs[j]) * keep);
    }
  }
  enforce(s);
}

/** Consistency: every job finite ≥ 0 and Σ jobs + militia ≤ minors (proportional scale-down). */
function enforce(s) {
  const col = s.run.colony;
  for (const j of JOB_ORDER) col.jobs[j] = clampNum(num(col.jobs[j]));
  const room = clampNum(num(col.adults.minor) - num(col.militia));
  const total = jobSum(col);
  if (total > room + EPS * Math.max(1, room)) {
    const f = total > 0 ? room / total : 0;
    for (const j of JOB_ORDER) col.jobs[j] = clampNum(col.jobs[j] * f);
  }
}

/** Jobs the response-threshold bias can raise (C94), in the order their bias is applied. */
const BIAS_JOBS = Object.freeze(['nurse', 'digger', 'herder']);

/**
 * [q] Pure: a copy of `targets` (every job key, 0..1) with `job` set to `value`. When that pushes Σ above 1, the other
 * jobs are scaled down proportionally so Σ = 1 (C94: the Colony panel's target sliders and +/− nudges).
 * @param {Object<string, number>} targets
 * @param {string} job
 * @param {number} value
 * @returns {Object<string, number>}
 */
export function withTarget(targets, job, value) {
  const out = cleanTargets(targets);
  if (!isJob(job)) return out;
  const v = clampNum(num(value), 0, 1);
  out[job] = v;
  let others = 0;
  for (const j of JOB_ORDER) if (j !== job) others += out[j];
  if (v + others > 1 + EPS && others > 0) {
    const keep = Math.max(0, 1 - v) / others;
    for (const j of JOB_ORDER) if (j !== job) out[j] = clampNum(out[j] * keep, 0, 1);
  }
  // Round away float dust so Σ ≤ 1 survives setJobTargets' validation (Σ ≤ 1 + 1e-9).
  for (const j of JOB_ORDER) out[j] = Math.round(out[j] * 1e9) / 1e9;
  let sum = 0;
  for (const j of JOB_ORDER) sum += out[j];
  if (sum > 1) {
    const big = JOB_ORDER.filter((j) => j !== job).sort((a, b) => out[b] - out[a])[0];
    if (big) out[big] = clampNum(out[big] - (sum - 1), 0, 1);
  }
  return out;
}

/**
 * [q] The targets the automation follows: the player's targets (run.colony.jobTargets) plus, in threshold mode, the
 * bottleneck bias (run.colony.jobBias, C94). A biased job is raised by its bias (to at most THRESHOLDS.shiftMax, or the
 * player's own target if higher), taken from the unassigned share first, then from the unbiased jobs proportionally.
 * @param {import('../core/types.js').State} s
 * @returns {Object<string, number>}
 */
export function effectiveTargets(s) {
  const col = s.run.colony;
  const out = cleanTargets(col.jobTargets);
  const bias = col.thresholdJobs && thresholdAvailable(s) && isMap(col.jobBias) ? col.jobBias : null;
  if (!bias) return out;
  const biased = (j) => num(bias[j]) > EPS;
  for (const job of BIAS_JOBS) {
    const b = clampNum(num(bias[job]), 0, 1);
    const amt = Math.min(b, Math.max(0, THRESHOLDS.shiftMax - out[job]));
    if (!(amt > EPS)) continue;
    let total = 0;
    let others = 0;
    for (const j of JOB_ORDER) {
      total += out[j];
      if (j !== job && !biased(j)) others += out[j];
    }
    const fromFree = Math.min(amt, Math.max(0, 1 - total));
    const take = Math.min(amt - fromFree, others);
    if (take > 0) {
      const keep = 1 - take / others;
      for (const j of JOB_ORDER) if (j !== job && !biased(j)) out[j] = clampNum(out[j] * keep, 0, 1);
    }
    out[job] = clampNum(out[job] + fromFree + Math.max(0, take), 0, 1);
  }
  return out;
}

/** Nurses at which brood speed stops rising: JOBS.nurse.fx.maxPerSlot per brood slot, the queen included (Infinity without the stat). */
function usefulNurses(d) {
  const slots = d && d.stats ? num(d.stats.broodSlots, NaN) : NaN;
  return Number.isFinite(slots) ? JOBS.nurse.fx.maxPerSlot * Math.max(0, slots) : Infinity;
}

/**
 * Set jobs = effective targets × available minors (available = minors − militia). The pool is min(1, Σ targets) ×
 * available; a job's share above its cap (herder, gardener) and the share of a locked job go to foragers (C94), so
 * they are worked instead of left idle. Nurses never pass the useful maximum (jobCap → nurseCap, C231).
 */
function assignByTargets(s, d) {
  const col = s.run.colony;
  const tg = effectiveTargets(s);
  const avail = clampNum(num(col.adults.minor) - num(col.militia));
  let tSum = 0;
  for (const j of JOB_ORDER) tSum += tg[j];
  const scale = tSum > 1 ? 1 / tSum : 1;
  let surplus = 0;
  const out = {};
  for (const j of JOB_ORDER) {
    const want = avail * tg[j] * scale;
    if (j === 'forager') { out[j] = want; continue; }
    const cap = jobUnlocked(s, j) ? jobCap(s, d, j) : 0;   // C231: the nurse cap (useful maximum) bounds targets and bias alike
    out[j] = Math.min(want, cap);
    surplus += want - out[j];
  }
  out.forager += surplus;
  for (const j of JOB_ORDER) col.jobs[j] = clampNum(out[j]);
}

/** Seconds of work in the dig queue at the current dig rate (Infinity with work but no diggers). */
function digQueueSeconds(d) {
  const q = d && d.nest && Array.isArray(d.nest.queueInfo) ? d.nest.queueInfo : [];
  let work = 0;
  for (const e of q) if (e) work += Math.max(0, num(e.work));
  if (!(work > 0)) return 0;
  const w = d.stats ? num(d.stats.digW) : 0;
  return w > 0 ? work / w : Infinity;
}

/** Honeydew short for a pending purchase (see the ARCH-R in the header). */
function honeydewShort(s, d) {
  const col = s.run.colony;
  const have = num(s.run.res.honeydew);
  const cap = d && d.stats ? num(d.stats.honeydewCap, Infinity) : Infinity;
  const short = (need) => need > have && need <= cap;
  if (col.rearRequested > 0 || s.meta.automation.autoRear) {
    const c = eggCost(s, d, 'alate');
    if (c && short(num(c.honeydew))) return true;
  }
  for (const id of ADAPTATION_ORDER) {
    if (!adaptationAvailable(s, id)) continue;
    const c = adaptationCost(s, id, 1);
    if (c && num(c.honeydew) > 0 && short(c.honeydew)) return true;
  }
  return false;
}

/**
 * [q] Response-threshold signal per bias job (C94): 1 = raise (the bottleneck binds and more workers help), 0 = hold
 * (it binds but more workers would not help, or it is easing), −1 = relax. nurse: bn_brood_slots binds (raise while
 * nurses < 4 per brood slot). digger: dig queue > THRESHOLDS.digQueueSec of work at the current rate (hold above half
 * of that). herder: honeydew short for a pending purchase (raise while a herder trail has room). Locked jobs relax.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ nurse: number, digger: number, herder: number }}
 */
export function thresholdTriggers(s, d) {
  const col = s.run.colony;
  let nurse = -1;
  if (jobUnlocked(s, 'nurse') && s.run.bottleneck.id === 'bn_brood_slots') nurse = num(col.jobs.nurse) < usefulNurses(d) - 1 ? 1 : 0;
  let digger = -1;
  if (jobUnlocked(s, 'digger')) {
    const q = digQueueSeconds(d);
    digger = q > THRESHOLDS.digQueueSec ? 1 : q > THRESHOLDS.digQueueSec / 2 ? 0 : -1;
  }
  let herder = -1;
  if (jobUnlocked(s, 'herder') && honeydewShort(s, d)) herder = jobCap(s, d, 'herder') - num(col.jobs.herder) > 0.5 ? 1 : 0;
  return { nurse, digger, herder };
}

/** response_thresholds: move each bias by `n` rebalance steps (up shiftStep on 1, down decayStep on −1, kept on 0). */
function updateBias(s, d, n) {
  const col = s.run.colony;
  const trig = thresholdTriggers(s, d);
  const prev = isMap(col.jobBias) ? col.jobBias : {};
  const next = {};
  let any = false;
  for (const j of BIAS_JOBS) {
    const b = clampNum(num(prev[j]), 0, THRESHOLDS.biasMax);
    let v = b;
    if (trig[j] > 0) v = Math.min(THRESHOLDS.biasMax, b + n * THRESHOLDS.shiftStep);
    else if (trig[j] < 0) v = Math.max(0, b - n * THRESHOLDS.decayStep);
    next[j] = Math.round(v * 1e9) / 1e9;
    if (next[j] > 0) any = true;
  }
  if (any) col.jobBias = next;
  else delete col.jobBias;
}

/**
 * Per tick: consistency (Σ jobs + militia ≤ minors). Every THRESHOLDS.rebalanceSec of run time while auto or threshold
 * mode is on: the threshold bias moves (if available; one step per rebalance boundary crossed), then jobs = effective
 * targets × available minors. Existing workers are reassigned at once, so the counts match the targets after ≤ 5 s.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  enforce(s);
  if (!(dt > 0)) return;
  releaseLeafcutters(s, d);   // C238 (real ticks only: a zero-time derive pass may not have the nest's leaf cap yet)
  const col = s.run.colony;
  if (!col.thresholdJobs && col.jobBias !== undefined) delete col.jobBias;
  if (!col.autoJobs && !col.thresholdJobs) return;
  const R = THRESHOLDS.rebalanceSec;
  const t0 = num(s.run.time);
  const n = Math.floor((t0 + dt) / R + EPS) - Math.floor(t0 / R + EPS);
  if (n <= 0) return;
  if (col.thresholdJobs && thresholdAvailable(s)) updateBias(s, d, n);
  assignByTargets(s, d);
  enforce(s);
}

/** Validate a boolean { on } toggle that needs `available` to switch on. */
function toggleValidate(cmd, available) {
  if (typeof cmd.on !== 'boolean') return 'invalid';
  if (cmd.on && !available) return 'locked';
  return null;
}

/** Validate a preset slot index for saving (0..max−1 and no gap in the array). */
function saveSlotOk(s, slot) {
  const list = s.meta.automation.jobPresets;
  return Number.isInteger(slot) && slot >= 0 && slot < PRESETS.max && slot <= (Array.isArray(list) ? list.length : 0);
}

/** Job command handlers (ARCHITECTURE §9). */
export const handlers = {
  /** shiftJob { from, to, n }: move up to n minors between jobs or 'idle'. */
  shiftJob: {
    validate(s, d, cmd) {
      const { from, to, n } = cmd;
      const ok = (j) => j === 'idle' || isJob(j);
      if (!ok(from) || !ok(to) || from === to) return 'invalid';
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 'invalid';
      if (to !== 'idle' && !jobUnlocked(s, to)) return 'locked';
      if (to === 'leafcutter' && !leavesUsable(d)) return 'requirements:garden';   // C238
      const avail = from === 'idle' ? idleMinors(s) : num(s.run.colony.jobs[from]);
      if (!(avail > EPS)) return 'invalid:empty';
      if (to !== 'idle' && !(jobCap(s, d, to) - num(s.run.colony.jobs[to]) > EPS)) return 'max';
      return null;
    },
    apply(s, d, cmd) {
      const col = s.run.colony;
      const { from, to } = cmd;
      const avail = from === 'idle' ? idleMinors(s) : num(col.jobs[from]);
      const room = to === 'idle' ? Infinity : jobCap(s, d, to) - num(col.jobs[to]);
      const k = Math.max(0, Math.min(cmd.n, avail, room));
      if (!(k > 0)) return;
      if (from !== 'idle') col.jobs[from] = clampNum(num(col.jobs[from]) - k);
      if (to !== 'idle') col.jobs[to] = clampNum(num(col.jobs[to]) + k);
      enforce(s);
    },
  },

  /** setJobs { jobs }: absolute counts for the given jobs (≤ caps, Σ ≤ minors − militia). */
  setJobs: {
    validate(s, d, cmd) {
      const m = cmd.jobs;
      if (!isMap(m)) return 'invalid';
      for (const k of Object.keys(m)) if (!isJob(k)) return 'invalid';
      const col = s.run.colony;
      let total = 0;
      for (const j of JOB_ORDER) {
        if (own(m, j)) {
          const v = m[j];
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 'invalid';
          if (v > 0 && !jobUnlocked(s, j)) return 'locked';
          if (v > 0 && j === 'leafcutter' && !leavesUsable(d)) return 'requirements:garden';   // C238
          if (v > jobCap(s, d, j) + EPS) return 'max';
          total += v;
        } else total += num(col.jobs[j]);
      }
      if (total > num(col.adults.minor) - num(col.militia) + EPS) return 'invalid:total';
      return null;
    },
    apply(s, d, cmd) {
      const col = s.run.colony;
      for (const j of JOB_ORDER) if (own(cmd.jobs, j)) col.jobs[j] = clampNum(cmd.jobs[j]);
      enforce(s);
    },
  },

  /** setJobTargets { targets }: ratio targets (0..1 each, Σ ≤ 1); copied into meta.automation.keep.jobTargets. */
  setJobTargets: {
    validate(s, d, cmd) {
      if (!presetsAvailable(s)) return 'locked';
      const m = cmd.targets;
      if (!isMap(m)) return 'invalid';
      for (const k of Object.keys(m)) if (!isJob(k)) return 'invalid';
      let total = 0;
      for (const j of JOB_ORDER) {
        const v = own(m, j) ? m[j] : num(s.run.colony.jobTargets[j]);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return 'invalid';
        total += v;
      }
      if (total > 1 + EPS) return 'invalid:sum';
      return null;
    },
    apply(s, d, cmd) {
      const col = s.run.colony;
      const next = cleanTargets(col.jobTargets);
      for (const j of JOB_ORDER) if (own(cmd.targets, j)) next[j] = clampNum(cmd.targets[j], 0, 1);
      col.jobTargets = next;
      s.meta.automation.keep.jobTargets = { ...next };
    },
  },

  /** setAutoJobs { on }: ratio auto mode (needs age_polyethism, or automated_brood). */
  setAutoJobs: {
    validate(s, d, cmd) { return toggleValidate(cmd, autoAvailable(s)); },
    apply(s, d, cmd) { s.run.colony.autoJobs = cmd.on; },
  },

  /** setThresholdJobs { on }: response-threshold mode (needs response_thresholds, or the innate automation). */
  setThresholdJobs: {
    validate(s, d, cmd) { return toggleValidate(cmd, thresholdAvailable(s)); },
    apply(s, d, cmd) {
      s.run.colony.thresholdJobs = cmd.on;
      if (!cmd.on) delete s.run.colony.jobBias;
    },
  },

  /** saveJobPreset { slot, name? }: store the current targets (needs hive_mind; up to PRESETS.max slots). */
  saveJobPreset: {
    validate(s, d, cmd) {
      if (!hiveMind(s)) return 'locked';
      if (!saveSlotOk(s, cmd.slot)) return 'invalid';
      if (cmd.name !== undefined && cmd.name !== null && (typeof cmd.name !== 'string' || cmd.name.length > PRESETS.nameMax)) return 'invalid';
      return null;
    },
    apply(s, d, cmd) {
      const auto = s.meta.automation;
      if (!Array.isArray(auto.jobPresets)) auto.jobPresets = [];
      const preset = { name: typeof cmd.name === 'string' ? cmd.name : '', targets: cleanTargets(s.run.colony.jobTargets) };
      if (cmd.slot < auto.jobPresets.length) auto.jobPresets[cmd.slot] = preset;
      else auto.jobPresets.push(preset);
    },
  },

  /** applyJobPreset { slot }: load a saved preset into the targets (and meta.automation.keep.jobTargets). */
  applyJobPreset: {
    validate(s, d, cmd) {
      if (!hiveMind(s)) return 'locked';
      const list = s.meta.automation.jobPresets;
      if (!Number.isInteger(cmd.slot) || !Array.isArray(list) || cmd.slot < 0 || cmd.slot >= list.length) return 'notFound';
      if (!isMap(list[cmd.slot])) return 'notFound';
      return null;
    },
    apply(s, d, cmd) {
      const next = cleanTargets(s.meta.automation.jobPresets[cmd.slot].targets);
      s.run.colony.jobTargets = next;
      s.meta.automation.keep.jobTargets = { ...next };
    },
  },
};
