// Job pools of minor workers: manual moves, absolute assignment, ratio targets (age_polyethism auto mode), response
// thresholds (retarget toward the bottleneck), saved presets (hive_mind) and the per-tick consistency rule.
// Owner: WP2. Contract: ARCHITECTURE §8.1 (jobs.js), §9 (job commands), DESIGN §6.2–§6.3.
// ARCH-R: auto assignment runs while autoJobs OR thresholdJobs is on (threshold mode retargets, so it implies following
// the targets). Locked/capped jobs' shares are redistributed to the other unlocked jobs in proportion to their targets.
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

/** age_polyethism owned, or innate via automaton_instincts / automated_brood (DESIGN §6.3, §14.5). */
function innateAutomation(s) {
  return lvl(s.cycle.traits, 'automaton_instincts') > 0 || lvl(s.era.federation, 'automated_brood') > 0;
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
  return !!s.run.unlocked.job_presets || autoAvailable(s);
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
 * [q] Most workers the job can hold: gardener → d.stats.gardenerSlots; herder → Σ caps of the aphid colonies on herder
 * trails (capPerLevel × level, ×herderCap with aphid_shepherding); other jobs Infinity; a locked or unknown job 0.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} job
 * @returns {number}
 */
export function jobCap(s, d, job) {
  if (!jobUnlocked(s, job)) return 0;
  if (job === 'gardener') return clampNum(num(d && d.stats ? d.stats.gardenerSlots : 0));
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

/**
 * Set jobs = targets × available minors (available = minors − militia), honouring caps and locked jobs. The pool is
 * min(1, Σ targets) × available; shares of capped/locked jobs go to the other unlocked jobs by their targets.
 */
function assignByTargets(s, d) {
  const col = s.run.colony;
  const tg = col.jobTargets || {};
  const avail = clampNum(num(col.adults.minor) - num(col.militia));
  let tSum = 0;
  for (const j of JOB_ORDER) tSum += clampNum(num(tg[j]), 0, 1);
  const pool = Math.min(1, tSum) * avail;
  const out = {};
  const capped = {};
  for (const j of JOB_ORDER) out[j] = 0;
  let fixed = 0;
  for (let iter = 0; iter <= JOB_ORDER.length; iter++) {
    const free = JOB_ORDER.filter((j) => !capped[j] && num(tg[j]) > 0 && jobUnlocked(s, j));
    const rem = pool - fixed;
    if (free.length === 0 || !(rem > 0)) break;
    let w = 0;
    for (const j of free) w += num(tg[j]);
    let newly = false;
    for (const j of free) {
      const cap = jobCap(s, d, j);
      if (rem * num(tg[j]) / w >= cap) {
        out[j] = cap;
        fixed += cap;
        capped[j] = true;
        newly = true;
      }
    }
    if (!newly) {
      for (const j of free) out[j] = rem * num(tg[j]) / w;
      break;
    }
  }
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

/** Raise one job target by up to THRESHOLDS.shiftStep (max shiftMax), taken from the unassigned share, then the others. */
function raiseTarget(tg, job) {
  const amt = Math.min(THRESHOLDS.shiftStep, Math.max(0, THRESHOLDS.shiftMax - num(tg[job])));
  if (!(amt > 0)) return;
  let total = 0;
  let others = 0;
  for (const j of JOB_ORDER) {
    total += num(tg[j]);
    if (j !== job) others += num(tg[j]);
  }
  const fromFree = Math.min(amt, Math.max(0, 1 - total));
  let take = amt - fromFree;
  let taken = 0;
  if (take > 0 && others > 0) {
    take = Math.min(take, others);
    const keep = 1 - take / others;
    for (const j of JOB_ORDER) if (j !== job) tg[j] = clampNum(num(tg[j]) * keep, 0, 1);
    taken = take;
  }
  tg[job] = clampNum(num(tg[job]) + fromFree + taken, 0, 1);
}

/** response_thresholds: shift targets toward the current bottleneck (nurses, diggers, herders). */
function shiftTargets(s, d) {
  const col = s.run.colony;
  const tg = col.jobTargets;
  if (!isMap(tg)) return;
  if (s.run.bottleneck.id === 'bn_brood_slots' && jobUnlocked(s, 'nurse')) raiseTarget(tg, 'nurse');
  if (jobUnlocked(s, 'digger') && digQueueSeconds(d) > THRESHOLDS.digQueueSec) raiseTarget(tg, 'digger');
  if (jobUnlocked(s, 'herder') && honeydewShort(s, d)) raiseTarget(tg, 'herder');
}

/**
 * Per tick: consistency (Σ jobs + militia ≤ minors). Every THRESHOLDS.rebalanceSec of run time while auto or threshold
 * mode is on: threshold retargeting (if available), then jobs = targets × available minors.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  enforce(s);
  if (!(dt > 0)) return;
  const col = s.run.colony;
  if (!col.autoJobs && !col.thresholdJobs) return;
  const R = THRESHOLDS.rebalanceSec;
  const t0 = num(s.run.time);
  if (Math.floor((t0 + dt) / R + EPS) === Math.floor(t0 / R + EPS)) return;
  if (col.thresholdJobs && thresholdAvailable(s)) shiftTargets(s, d);
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

  /** setAutoJobs { on }: ratio auto mode (needs age_polyethism, or automaton_instincts / automated_brood). */
  setAutoJobs: {
    validate(s, d, cmd) { return toggleValidate(cmd, autoAvailable(s)); },
    apply(s, d, cmd) { s.run.colony.autoJobs = cmd.on; },
  },

  /** setThresholdJobs { on }: response-threshold mode (needs response_thresholds, or the innate automation). */
  setThresholdJobs: {
    validate(s, d, cmd) { return toggleValidate(cmd, thresholdAvailable(s)); },
    apply(s, d, cmd) { s.run.colony.thresholdJobs = cmd.on; },
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
