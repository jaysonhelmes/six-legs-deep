// Jobs of minor workers, loose foraging, job automation thresholds and saved job presets.
// Owner: WP2. Contract: ARCHITECTURE §6.2 (numbers from DESIGN §6.2, §6.3).
// ARCH-R: THRESHOLDS.shiftStep / shiftMax (how far response_thresholds moves a target per rebalance, and its ceiling) and
// PRESETS (3 saved presets, name length) are not numbered in DESIGN or the contract; they are added here as data.

/**
 * Deep-freeze a plain object/array tree (local helper; data modules import nothing from core).
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

/** Display and iteration order of the jobs. */
export const JOB_ORDER = deepFreeze(['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener']);

/**
 * Jobs keyed by id. unlock = unlock key (§11) or null. fx numbers are read by the consumers:
 * digger.exp (W = diggers^exp), nurse.maxPerSlot, scout.warnSec (WP5), herder.capPerLevel (per aphid-colony level),
 * gardener leavesIn / fungusOut (per gardener per second).
 */
export const JOBS = deepFreeze({
  forager: { id: 'forager', name: 'Forager', unlock: null },
  digger: { id: 'digger', name: 'Digger', unlock: 'job_digger', fx: { exp: 0.85 } },
  nurse: { id: 'nurse', name: 'Nurse', unlock: 'panel_colony', fx: { maxPerSlot: 4 } },
  scout: { id: 'scout', name: 'Scout', unlock: 'job_scout', fx: { warnSec: 3 } },
  herder: { id: 'herder', name: 'Herder', unlock: 'job_herder', fx: { capPerLevel: 8 } },
  leafcutter: { id: 'leafcutter', name: 'Leafcutter', unlock: 'job_leafcutter' },
  gardener: { id: 'gardener', name: 'Gardener', unlock: 'job_gardener', fx: { leavesIn: 0.3, fungusOut: 0.1 } },
});

/** Food/s per forager when no forager trail exists at all (DESIGN §6.2). */
export const LOOSE_FORAGE = 0.1;

/**
 * Automation: response_thresholds triggers (dig queue > digQueueSec of work), the auto-assign cadence (rebalanceSec),
 * the target share moved toward a bottleneck job per rebalance (shiftStep) and the most a shifted job may reach (shiftMax).
 */
export const THRESHOLDS = deepFreeze({ digQueueSec: 60, rebalanceSec: 5, shiftStep: 0.02, shiftMax: 0.5 });

/** Saved job presets (hive_mind): at most `max` slots (ARCHITECTURE §4 jobPresets), names up to `nameMax` characters. */
export const PRESETS = deepFreeze({ max: 3, nameMax: 40 });
