// World data (WP6): the year, season order, per-season modifiers and the frost line (DESIGN §17).
// Owner: WP6. Contract: ARCHITECTURE §6.6. Consumers read these tables; they never hardcode the numbers.

/** Deep-freeze helper (plain objects and arrays). */
const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/** Canonical season order (one year = 4 seasons). */
export const SEASON_ORDER = f(['spring', 'summer', 'autumn', 'winter']);

/** Season order of a cycle under `edict_of_long_summer` (no winter; the second summer replaces autumn's slot). */
export const LONG_SUMMER_ORDER = f(['spring', 'summer', 'summer', 'autumn']);

/**
 * Year constants. lengthSec = one season (s); chronoMin/chronoMax = season length bounds with `chronobiology`;
 * forecastSec = the season forecast lead (the `winterSoon` warning fires this many seconds before winter).
 */
export const YEAR = f({ lengthSec: 360, chronoMin: 180, chronoMax: 720, forecastSec: 60 });

/**
 * Per-season modifiers copied into d.season.mods every tick. Winter `forage` is the BASE factor (0.3, or `forageMild`
 * 0.6 in the mild year-0 winter) before the R reduction that WP2 applies (DESIGN §12.1).
 */
export const SEASON_MODS = f({
  spring: { forage: 1.0, lay: 1.25, broodTime: 0.8, dig: 1, insight: 1, foodCap: 1, rivalAggro: 1.25, rivalDormant: false, flightW: 1, puddlesBlock: true },
  summer: { forage: 1.3, lay: 1, broodTime: 1, dig: 1, insight: 1, foodCap: 1, rivalAggro: 1.5, rivalDormant: false, flightW: 1.25, puddlesBlock: false },
  autumn: { forage: 1.1, lay: 1, broodTime: 1, dig: 1, insight: 1, foodCap: 1.25, rivalAggro: 1, rivalDormant: false, flightW: 1, puddlesBlock: false },
  winter: { forage: 0.3, forageMild: 0.6, lay: 0.75, broodTime: 1.5, dig: 1.3, insight: 1.5, foodCap: 1, rivalAggro: 0, rivalDormant: true, flightW: 1, puddlesBlock: false },
});

/**
 * Frost line (DESIGN §17.3): F_max = maxRow (maxRowMild in the year-0 winter) minus thermoregulation and mound
 * reductions, never below minRow; it descends over descendSec and retreats over the last retreatSec of winter.
 * snapRows/snapSec: ev_frost_snap freezes rows y < snapRows for snapSec.
 */
export const FROST = f({ maxRow: 18, maxRowMild: 10, minRow: 4, descendSec: 90, retreatSec: 60, snapRows: 4, snapSec: 120 });
