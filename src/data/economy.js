// Colony economy constants: egg cost, lay rate, brood, upkeep, Hungry, nutrition, pheromone, caps, clicks, spoilage,
// bottleneck badge, slider limits and the achievement rewards WP2 implements.
// Owner: WP2. Contract: ARCHITECTURE §6.2 (numbers from DESIGN §5, §6.4, §10, §12, §19).
// ARCH-R: keys added beyond §6.2 (all numbers from DESIGN): BROOD.fungalTimeMult (Fungal Brood ×0.75, §5.3/§6.4),
// CLICK.avgSec (the 5 s window of d.rates.food.clicks, §8.1 economy step 10), SLIDERS (egg reserve, C151 caste target counts and the old caste slider
// limits 0.9, §5.1/§5.5), WINTER_R (honeypot "winter forage penalty halved" = R term 0.5, §6.7/§15.6) and ACH_FX (the
// achievement extra rewards that §12.5 assigns to WP2; ACHIEVEMENTS[].reward is display text only). The hoarder,
// clickstorm and survivor rewards keep their §6.2 homes (CAPS.hoarder, CLICK.clickstorm, UPKEEP.survivorAch).

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

/** Egg cost E(N) = base × (1 + k·N)^exp; nanitics: the first `nanitics` (`naniticsVigor` with nanitic_vigor) minors × naniticMult. */
export const EGG = deepFreeze({ base: 10, k: 0.02, exp: 1.5, nanitics: 5, naniticsVigor: 25, naniticMult: 0.5 });

/** Lay rate λ = (base + perRF·RF) × perRC^(RC − 1) × M_lay × colony_scale (DESIGN §5.1). */
export const LAY = deepFreeze({ base: 0.2, perRF: 0.05, perRC: 1.15 });

/** Brood development (DESIGN §5.3, §17.3, §6.4, C20). */
export const BROOD = deepFreeze({ baseSec: 25, royalSlots: 3, maxNursePerSlot: 4, stages: [0.25, 0.75], frostDeathPerSec: 0.005,
  fungalCostPerEgg: 0.5, groomPct: 0.01, fungalTimeMult: 0.75 });

/** Upkeep extras (per-caste upkeep lives in castes.js; winter research/chamber reductions in their fx). */
export const UPKEEP = deepFreeze({ survivorAch: 0.95 });

/** Hungry state (DESIGN §5.8, §3 harsh_nature). */
export const HUNGRY = deepFreeze({ outputMult: 0.75, endFrac: 0.05, harshDeathPerSec: 0.005 });

/** Nutrition (DESIGN §6.4): fungus per adult per second, default coefficient. */
export const NUTRITION = deepFreeze({ perAdult: 0.005, coef: 0.5 });

/** Pheromone regen and cap (DESIGN §12.9). */
export const PHEROMONE = deepFreeze({ regenBase: 0.5, regenPerSqrtAdult: 0.05, capBase: 50, capPerMound: 5 });

/** Caps (DESIGN §12.8). */
export const CAPS = deepFreeze({ royalFood: 150, autumn: 1.25, hoarder: 1.1, repleteAdj: 1.25, honeydewBase: 50, honeydewFrac: 0.1 });

/** Click value (DESIGN §10, §12.2) and the averaging window of d.rates.food.clicks. */
export const CLICK = deepFreeze({ fromLevel: 10, pBase: 0.01, pPer: 0.001, pMax: 0.05, clickstorm: 2, avgSec: 5 });

/** Clay granary spoilage: fraction of stored food per minute × clay share (DESIGN §7.6). */
export const SPOILAGE = deepFreeze({ clayPerMin: 0.005 });

/** Bottleneck badge: food ≥ capFrac × cap for more than capSec seconds → bn_food_cap (DESIGN §2.2). */
export const BOTTLENECK = deepFreeze({ capFrac: 0.99, capSec: 5 });

/**
 * Slider limits: egg reserve up to 90 % of the food cap (§5.1). casteSumMax: the old caste-share limit (≤ 90 %), kept only
 * to read pre-C151 saves. C151 caste target counts: integers 0..casteGoalMax; casteGoalSteps = the stepper's step sizes.
 */
export const SLIDERS = deepFreeze({ eggReserveMax: 0.9, casteSumMax: 0.9, casteGoalMax: 1e30, casteGoalSteps: [1, 10],
  // C104 chitin reserve (absolute chitin, player request): the slider walks this ladder; soldier / supermajor eggs only
  // spend chitin above the reserve. The last step is the command's upper bound.
  chitinReserveSteps: [0, 1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000,
    1500, 2000, 3000, 5000, 7500, 10000] });

/**
 * C103 passive chitin from moults (player request): every adult that hatches (any caste, alates included) leaves a
 * pupal case worth `perHatch` chitin, once chitin matters (`gate`: any of these unlock keys), so the first minutes of a
 * first run do not reveal a resource with no use yet. Flat (no channel multiplier). `avgSec`: time constant of the
 * displayed moult rate (d.rates.chitin.molts).
 */
export const MOLT = deepFreeze({ perHatch: 0.025, gate: ['caste_soldier', 'res_chitin'], avgSec: 60 });

/** Extra winter-forage R terms: honeypot species `winterForageHalf` (penalty halved) = 0.5 (DESIGN §15.6). */
export const WINTER_R = deepFreeze({ honeypotHalf: 0.5 });

/**
 * Achievement extra rewards implemented by WP2 stats (ARCHITECTURE §12.5), keyed by achievement id → { stat: mult }.
 * stat keys: lay, fungus, soil, dig, honeydew, ap, hp, insight.
 */
export const ACH_FX = deepFreeze({
  ach_thousand_strong: { lay: 1.02 },
  ach_ten_thousand: { lay: 1.02 },
  ach_myriad: { lay: 1.02 },
  ach_royal_ascent: { lay: 1.05 },
  ach_into_the_clay: { fungus: 1.1 },
  ach_gravel_pit: { soil: 1.05 },
  ach_bedrock_bound: { dig: 1.05 },
  ach_shepherd: { honeydew: 1.1 },
  ach_square_law: { ap: 1.05 },
  ach_total_war: { hp: 1.1 },
  ach_the_large_blue: { insight: 1.05 },
  ach_sociobiologist: { insight: 1.25 },
});

/**
 * Smoothed income for "seconds of income" one-shot rewards (DESIGN §3, ARCHITECTURE §18 C76): economy.tick keeps
 * d.rates[res].avg, an exponential moving average of the gross rate with time constant `sec` (≈ a 60 s average), and
 * wallet.incomeSeconds sizes rewards from it, so a momentary spike (harvester stash, Frenzy) does not multiply windfalls.
 */
export const INCOME_AVG = deepFreeze({ sec: 60 });
