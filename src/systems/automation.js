// Automation: 1 Hz autobuyers (Adaptations, chamber level-ups, Mound) in the player's priority order, Auto-Flight,
// Auto-Supercolony, the setAutomation patch handler and the Diapause toggle. Owner: WP7.
// Contract: ARCHITECTURE §8.6, §9 (DESIGN §14.5 autobuyers / auto_flight, §15.5 deep_time_automation, §21.5).
// ARCH-R: autobuyers also need meta.automation.autobuy.on (the player's master toggle), including the Adaptation
//   autobuyer granted by automaton_instincts. Turning a toggle ON for a feature that is not owned is refused 'locked'.
// ARCH-R: auto-flight 'peak' mode fires once the live alates/min falls below FLIGHT.peakGlow (97 %) of the recorded peak
//   (the same signal as the Alates/min meter's glow). Auto-Supercolony runs online only, like Auto-Flight.
// ARCH-R: Auto-Supercolony keeps "the cycle's current edict"; in the first cycle of an era that is null (no edict).
// The 1 Hz cadence counts integer run-second crossings (offline 60 s steps run up to AUTOMATION.maxPassesPerTick
// passes, so offline autobuying stays O(1) per call).

import { AUTOMATION, FLIGHT } from '../data/prestige.js';
import { CLAMP_MAX } from '../data/balance.js';
import * as adaptations from './adaptations.js';
import * as nest from './nest.js';
import * as surface from './surface.js';
import { doFlight, doSupercolony, startRun, flightRequirements, superRequirements, projectAlates, projectKinship } from './prestige.js';

/** Autobuyer categories (meta.automation.autobuy.priority is a permutation of these). */
const CATEGORIES = Object.freeze(['adaptations', 'chambers', 'mound']);
const FLIGHT_MODES = Object.freeze(['peak', 'alates', 'minutes']);
const SUPER_MODES = Object.freeze(['kinship', 'hours']);

/** Level of an id in a level map: a finite non-negative number, else 0. */
function lv(map, id) {
  const v = map ? map[id] : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** True for a plain (non-array) object. */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Finite number in [0, CLAMP_MAX]. */
function isAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= CLAMP_MAX;
}

/** A valid priority list: a permutation of CATEGORIES. */
function isPriority(v) {
  return Array.isArray(v) && v.length === CATEGORIES.length && CATEGORIES.every((c) => v.includes(c));
}

/** Default autobuyer step functions (cross-callable [x] exports of WP2 / WP3 / WP4). */
const DEFAULT_STEPS = Object.freeze({
  adaptations: (s, d, env) => adaptations.autobuyStep(s, d, env),
  chambers: (s, d, env) => nest.autoLevelStep(s, d, env),
  mound: (s, d, env) => surface.autoMoundStep(s, d, env),
});

/**
 * One autobuyer pass: tries the enabled categories in autobuy.priority order and stops after the first purchase.
 * Package-internal (exported for tests; `steps` replaces the cross-package step functions).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @param {{ adaptations: Function, chambers: Function, mound: Function }} [steps]
 * @returns {boolean} true if something was bought
 */
export function autobuyPass(s, d, env, steps = DEFAULT_STEPS) {
  const a = s.meta.automation.autobuy;
  if (!a || a.on !== true) return false;
  const fedOn = lv(s.era.federation, 'autobuyers') > 0;
  const adaptOn = fedOn || lv(s.cycle.traits, 'automaton_instincts') > 0;
  const order = isPriority(a.priority) ? a.priority : CATEGORIES;
  for (const cat of order) {
    if (a[cat] !== true) continue;
    if (cat === 'adaptations' ? !adaptOn : !fedOn) continue;
    if (steps[cat](s, d, env)) return true;
  }
  return false;
}

/** Auto-Flight condition (federation auto_flight, toggle on, flight requirements met, mode condition). */
function flightDue(s, d) {
  const af = s.meta.automation.autoFlight;
  if (!af || af.on !== true || !(lv(s.era.federation, 'auto_flight') > 0)) return false;
  if (!flightRequirements(s, d).ok) return false;
  const run = s.run;
  if (af.mode === 'alates') return projectAlates(s, d) >= af.alates;
  if (af.mode === 'minutes') return run.time >= af.minutes * 60;
  const peak = run.prestige.peakRate;
  const perMin = run.time > 0 ? projectAlates(s, d) / (run.time / 60) : 0;
  return peak > 0 && perMin < FLIGHT.peakGlow * peak;
}

/** Auto-Supercolony condition (genome deep_time_automation, toggle on, merge requirements met, mode condition). */
function superDue(s, d) {
  const as = s.meta.automation.autoSuper;
  if (!as || as.on !== true || !(lv(s.meta.genome, 'deep_time_automation') > 0)) return false;
  if (!superRequirements(s, d).ok) return false;
  if (as.mode === 'hours') return s.meta.simTime - s.cycle.startedAt >= as.hours * 3600;
  return projectKinship(s, d) >= as.kinship;
}

/**
 * Flight + chooseLanding(option 0, first boon) in one go (auto-flight).
 * @returns {number} alates awarded
 */
function autoFly(s, d, env) {
  const alates = doFlight(s, d, env);
  const p = s.meta.pending;
  if (!p || !Array.isArray(p.options) || !p.options[0]) return alates;
  const opt = p.options[0];
  s.meta.pending = null;
  startRun(s, d, { seed: opt.seed, tags: opt.tags, boon: Array.isArray(p.boons) && p.boons.length ? p.boons[0] : null,
    hardship: p.hardship ?? null, startSeason: null, carryAdults: p.carryAdults, env });
  return alates;
}

/**
 * Number of 1 Hz automation passes due in a tick from run time t0 to t0 + dt (integer AUTOMATION.passSec crossings,
 * capped at AUTOMATION.maxPassesPerTick). Package-internal (exported for tests).
 * @param {number} t0
 * @param {number} dt
 * @returns {number}
 */
export function passCount(t0, dt) {
  if (!(dt > 0) || !Number.isFinite(t0)) return 0;
  const per = AUTOMATION.passSec;
  const n = Math.floor((t0 + dt) / per + 1e-9) - Math.floor(t0 / per + 1e-9);
  return Math.max(0, Math.min(n, AUTOMATION.maxPassesPerTick));
}

/**
 * 1 Hz automation: autobuyer passes (one purchase each), then (online only) Auto-Supercolony or Auto-Flight.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 */
export function tick(s, d, dt, env) {
  const passes = passCount(s.run.time, dt);
  if (passes <= 0) return;
  for (let i = 0; i < passes; i++) if (!autobuyPass(s, d, env)) break;
  if (env && env.offline) return;
  if (superDue(s, d)) {
    doSupercolony(s, d, env, { edict: s.cycle.edict });
    return;
  }
  if (flightDue(s, d)) autoFly(s, d, env);
}

/** Validate one sub-patch against a schema of leaf validators; returns a reason or null. */
function checkSub(patch, schema) {
  if (!isObj(patch)) return 'invalid';
  for (const k of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(schema, k)) return 'invalid:key';
    if (!schema[k](patch[k])) return 'invalid:value';
  }
  return null;
}

const isBool = (v) => typeof v === 'boolean';
const SCHEMA = Object.freeze({
  autobuy: { on: isBool, adaptations: isBool, chambers: isBool, mound: isBool, priority: isPriority },
  autoFlight: { on: isBool, mode: (v) => FLIGHT_MODES.includes(v), alates: isAmount, minutes: isAmount },
  autoSuper: { on: isBool, mode: (v) => SUPER_MODES.includes(v), kinship: isAmount, hours: isAmount },
});
const FLAG_KEYS = Object.freeze(['autoGuard', 'autoRear']);

/** Commands owned by WP7 automation (ARCHITECTURE §9). */
export const handlers = {
  /** setAutomation { patch }: deep-merged into meta.automation (jobPresets / keep belong to WP2 and are refused). */
  setAutomation: {
    validate(s, d, cmd) {
      const p = cmd.patch;
      if (!isObj(p) || Object.keys(p).length === 0) return 'invalid';
      for (const k of Object.keys(p)) {
        if (FLAG_KEYS.includes(k)) {
          if (!isBool(p[k])) return 'invalid:value';
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(SCHEMA, k)) return 'invalid:key';
        const r = checkSub(p[k], SCHEMA[k]);
        if (r) return r;
      }
      if (p.autobuy && p.autobuy.on === true && !(lv(s.era.federation, 'autobuyers') > 0 || lv(s.cycle.traits, 'automaton_instincts') > 0)) {
        return 'locked';
      }
      if (p.autoFlight && p.autoFlight.on === true && !(lv(s.era.federation, 'auto_flight') > 0)) return 'locked';
      if (p.autoSuper && p.autoSuper.on === true && !(lv(s.meta.genome, 'deep_time_automation') > 0)) return 'locked';
      return null;
    },
    apply(s, d, cmd) {
      const auto = s.meta.automation;
      const p = cmd.patch;
      for (const k of Object.keys(p)) {
        if (FLAG_KEYS.includes(k)) {
          auto[k] = p[k];
          continue;
        }
        for (const f of Object.keys(p[k])) {
          const v = p[k][f];
          auto[k][f] = Array.isArray(v) ? v.slice() : typeof v === 'number' ? v + 0 : v; // + 0 turns -0 into 0
        }
      }
    },
  },

  /** spendDiapause { on }: start / stop spending the Diapause bank (core/game.js drains it while active). STRETCH. */
  spendDiapause: {
    validate(s, d, cmd) {
      if (typeof cmd.on !== 'boolean') return 'invalid';
      if (cmd.on && !(s.meta.diapause.bank > 0)) return 'cantAfford';
      return null;
    },
    apply(s, d, cmd) {
      s.meta.diapause.active = cmd.on;
    },
  },
};
