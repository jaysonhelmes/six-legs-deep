// Automation: 1 Hz autobuyers (Adaptations, chamber level-ups, Mound) in the player's priority order, Auto-Flight,
// Auto-Supercolony, the setAutomation patch handler and the Diapause toggle. Owner: WP7.
// Contract: ARCHITECTURE §8.6, §9 (DESIGN §14.5 autobuyers / auto_flight, §15.5 deep_time_automation, §21.5).
// ARCH-R: autobuyers also need meta.automation.autobuy.on (the player's master toggle). Every autobuyer, the Adaptation
//   one included, needs the Federation node autobuyers (C166: Automaton Instincts no longer grants it). Turning a toggle
//   ON for a feature that is not owned is refused 'locked'.
// C166: auto-flight 'peak' mode fires once the run is AUTO_FLIGHT.minSec old and the weather-free alates/min has stayed
//   below AUTO_FLIGHT.drop of this run's best weather-free rate for AUTO_FLIGHT.holdSec (run.prestige.belowAt, tracked by
//   prestige.tick). The landing is picked by pickLanding (AUTO_LANDING scores). Auto-Supercolony runs online only, like
//   Auto-Flight.
// ARCH-R: Auto-Supercolony keeps "the cycle's current edict"; in the first cycle of an era that is null (no edict).
// The 1 Hz cadence counts integer run-second crossings (offline 60 s steps run up to AUTOMATION.maxPassesPerTick
// passes, so offline autobuying stays O(1) per call).

import { AUTOMATION, AUTO_FLIGHT, AUTO_LANDING } from '../data/prestige.js';
import { CLAMP_MAX } from '../data/balance.js';
import * as adaptations from './adaptations.js';
import * as nest from './nest.js';
import * as surface from './surface.js';
import * as seasons from './seasons.js';
import { doFlight, doSupercolony, startRun, flightRequirements, superRequirements, projectAlates, projectKinship, landingCarry } from './prestige.js';

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
  if (!(lv(s.era.federation, 'autobuyers') > 0)) return false;
  const order = isPriority(a.priority) ? a.priority : CATEGORIES;
  for (const cat of order) {
    if (a[cat] !== true) continue;
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
  return peakPassed(s);
}

/**
 * C166 peak rule: run ≥ AUTO_FLIGHT.minSec and the weather-free rate below AUTO_FLIGHT.drop × its best for
 * AUTO_FLIGHT.holdSec in a row (run.prestige.belowAt, kept by prestige.tick).
 * @param {import('../core/types.js').State} s
 * @returns {boolean}
 */
export function peakPassed(s) {
  const run = s.run;
  const at = run.prestige ? run.prestige.belowAt : -1;
  return run.time >= AUTO_FLIGHT.minSec && Number.isFinite(at) && at >= 0 && run.time - at >= AUTO_FLIGHT.holdSec;
}

/** Score of one id in a points map (missing → 0). */
function pts(map, id) {
  const v = map ? map[id] : 0;
  return Number.isFinite(v) ? v : 0;
}

/**
 * C166 auto-flight landing pick: the option whose tags score highest and the boon that scores highest (AUTO_LANDING;
 * ties keep the first offered), and with Seasonal Wisdom the starting season AUTO_LANDING.season. Pure.
 * @param {import('../core/types.js').State} s
 * @param {Object} p meta.pending (kind 'landing')
 * @param {string|null} [season] the season the run will start in (default: Seasonal Wisdom's pick, else Chronobiology's)
 * @returns {{ index: number, boon: string|null, season: string|null }}
 */
export function pickLanding(s, p, season) {
  const L = AUTO_LANDING;
  const pickSeason = p && p.chooseSeason ? L.season : null;
  let sea = season;
  if (sea === undefined) sea = pickSeason || seasons.chronoStart(s) || null;
  const options = p && Array.isArray(p.options) ? p.options : [];
  let index = 0;
  let best = -Infinity;
  options.forEach((o, i) => {
    if (!o) return;
    let sc = 0;
    for (const t of Array.isArray(o.tags) ? o.tags : []) sc += pts(L.sites, t) + pts(L.seasonSites[sea], t);
    if (sc > best) { best = sc; index = i; }
  });
  const tr = s.cycle.traits;
  const boons = p && Array.isArray(p.boons) ? p.boons : [];
  let boon = boons.length ? boons[0] : null;
  let bestB = -Infinity;
  for (const b of boons) {
    let sc = pts(L.boons, b) + pts(L.seasonBoons[sea], b);
    if (b === 'boon_blueprint_rush' && Number.isInteger(s.era.activeBlueprint) && s.era.activeBlueprint >= 0) sc += L.blueprintRush;
    if (b === 'boon_peaceful_start' && p.hardship === 'pacifist') sc += L.pacifistPeace;
    if (b === 'boon_old_trails' && lv(tr, 'remembered_paths') > 0) sc += L.rememberedOldTrails;
    if (b === 'boon_scouts_lead' && lv(tr, 'keen_antennae') > 0) sc += L.keenScouts;
    if (sc > bestB) { bestB = sc; boon = b; }
  }
  return { index, boon, season: pickSeason };
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
 * Flight + chooseLanding(pickLanding) in one go (auto-flight).
 * @returns {number} alates awarded
 */
function autoFly(s, d, env) {
  const alates = doFlight(s, d, env);
  const p = s.meta.pending;
  if (!p || !Array.isArray(p.options) || !p.options.length) return alates;
  const clock = d && d.season && typeof d.season.id === 'string' ? d.season.id : null;
  const pick = pickLanding(s, p, (p.chooseSeason ? AUTO_LANDING.season : null) || seasons.chronoStart(s) || clock);
  const opt = p.options[pick.index] || p.options[0];
  s.meta.pending = null;
  startRun(s, d, { seed: opt.seed, tags: opt.tags, boon: pick.boon, hardship: p.hardship ?? null, startSeason: pick.season,
    carryAdults: landingCarry(s, p), env });
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
      if (p.autobuy && p.autobuy.on === true && !(lv(s.era.federation, 'autobuyers') > 0)) return 'locked';
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
