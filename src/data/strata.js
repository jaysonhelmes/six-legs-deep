// Nest strata data: layers, microclimate, dig constants and nest geometry constants (DESIGN §7.1–§7.3, §7.8, §17.2).
// Owner: WP3. Contract: ARCHITECTURE §6.3. Every tunable nest number used by systems/nest*.js lives here or in
// data/chambers.js / data/soilFeatures.js.

const freeze = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') freeze(o[k]);
  return Object.freeze(o);
};

/** Layer ids, top to bottom (iteration order). */
export const LAYER_ORDER = freeze(['topsoil', 'loam', 'clay', 'gravel', 'bedrock', 'aquifer']);

/**
 * Layers by id: inclusive row range, work per cell, dig requirement.
 * req: null | { research: id } | { federation: id }. workMasonry: clay work with clay_masonry.
 */
export const LAYERS = freeze({
  topsoil: { id: 'topsoil', name: 'Topsoil', y0: 0, y1: 9, work: 4, req: null },
  loam:    { id: 'loam', name: 'Loam', y0: 10, y1: 23, work: 6, req: null },
  clay:    { id: 'clay', name: 'Clay', y0: 24, y1: 39, work: 10, req: null, workMasonry: 7.2 },
  gravel:  { id: 'gravel', name: 'Gravel', y0: 40, y1: 57, work: 16, req: null },
  bedrock: { id: 'bedrock', name: 'Bedrock', y0: 58, y1: 73, work: 40, req: { research: 'acid_excavation' } },
  aquifer: { id: 'aquifer', name: 'Aquifer', y0: 74, y1: 79, work: 120, req: { federation: 'aquifer_access' } },
});

/**
 * Microclimate: additive nursery brood-speed terms by layer and season, and clay modifiers (DESIGN §17.2).
 * topsoil summer −0.15 is skipped with thermoregulation / thermal_brood_shuttling / site_sunny_slope;
 * site_sunny_slope also applies the spring term in autumn.
 */
export const MICRO = freeze({
  topsoil: { nursery: { spring: 0.15, summer: -0.15 } },
  gravel:  { nursery: { winter: 0.10 } },
  clay:    { garden: 1.5, granarySpoil: true },
});

/**
 * Dig constants (DESIGN §7.2–§7.5, §12.3, §13.6–§13.8, §19).
 * architectMult (ach_architect, relocation work ×0.75) is a WP3 extension of the §6.3 shape.
 */
export const DIG = freeze({
  chamberCellMult: 1.5, queueBase: 5, helpFlat: 5, helpFracW: 0.03, backfillSec: 10,
  relocateWorkFrac: 0.5, demolishRefund: 0.5, cancelRefund: 1.0, floodRows: [0, 5],
  richLoamMult: 0.8, shallowSoilRow: 23, shallowSoilRewardPerTier: 0.05, blueprintCellDiv: 3, blueprintPlaceMult: 0.5,
  goingUnderTunnelMult: 0.95,
  architectMult: 0.75,
});

/**
 * Nest geometry constants (DESIGN §7.7–§7.11, §9.10).
 * Extensions of the §6.3 shape: hintRadiusAch (+1 hint radius with ach_treasure_hunter), shaftGap (a Nuptial
 * Chamber's exit shaft is at least 3 columns from every existing shaft, ARCHITECTURE §8.2).
 */
export const GEOM = freeze({
  adjPathMax: 4, hygienePath: 6, barracksPath: 12, raidReach: 15, haulDiv: 24, satelliteHaul: 0.5,
  hintRadius: 4, footprintMaxL: 8, nuptialEntranceStep: 8,
  hintRadiusAch: 1, shaftGap: 3,
});

/**
 * Blueprint adjustments (ARCHITECTURE §18 C174–C177): a planned chamber whose saved spot holds water (or, for a
 * Nuptial Chamber, has no exit-shaft route) moves to the nearest valid spot within moveRadius cells (Manhattan); a
 * planned Water Well takes a pocket spot within wellReach cells before Deep Spring / Drainage step in; at most
 * notesMax blueprint notes and events wait for the next tick.
 */
export const BLUEPRINT = freeze({ moveRadius: 6, wellReach: 8, notesMax: 60 });

/** Placement advisor (nest.findPlacement): granaries and nurseries go deep from minute 15 (ARCHITECTURE §8.2). */
export const ADVISOR = freeze({ deepAfterSec: 900 });


/**
 * C214: automatic tunnel origins kept per run (s.run.nest.dugBy: [{ w, t, c }] — why, chamber type, cells) so the nest
 * view can say who dug a tunnel the player did not draw. Newest last; the oldest entries go first past either cap.
 */
export const AUTO_TUNNEL = freeze({ maxEntries: 24, maxCells: 480 });
