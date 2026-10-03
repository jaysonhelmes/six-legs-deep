// The 10 Adaptations: repeatable upgrades bought with food (and chitin / honeydew), with their effect numbers.
// Owner: WP2. Contract: ARCHITECTURE §6.2 (numbers from DESIGN §10). cost(L) = base × growth^L per resource.

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

/** Display and iteration order (also the autobuyer's tie-break order). */
export const ADAPTATION_ORDER = deepFreeze(['quick_dispatch', 'strong_mandibles', 'royal_feeding', 'digging_claws', 'potent_trails',
  'serrated_mandibles', 'thick_cuticle', 'sweet_tooth', 'queens_feast', 'long_legs']);

/**
 * Adaptations keyed by id. fx per level: click (+food per click), forageAdd (forage A_add), lay (royal_feeding: +eggs/s on
 * the base lay rate; queens_feast: lay ×), digAdd (dig A_add), forage (×), atk / hp (×), honeydew (×), dNav (+, WP4).
 */
export const ADAPTATIONS = deepFreeze({
  quick_dispatch: { id: 'quick_dispatch', name: 'Quick Dispatch', cost: { base: { food: 15 }, growth: 1.7 }, unlock: 'adapt_basic',
    fx: { click: 1 } },
  strong_mandibles: { id: 'strong_mandibles', name: 'Strong Mandibles', cost: { base: { food: 25 }, growth: 1.9 }, unlock: 'adapt_basic',
    fx: { forageAdd: 0.10 } },
  royal_feeding: { id: 'royal_feeding', name: 'Royal Feeding', cost: { base: { food: 40 }, growth: 1.75 }, unlock: 'adapt_basic',
    fx: { lay: 0.05 } },
  digging_claws: { id: 'digging_claws', name: 'Digging Claws', cost: { base: { food: 30 }, growth: 1.8 }, unlock: 'adapt_digging_claws',
    fx: { digAdd: 0.25 } },
  potent_trails: { id: 'potent_trails', name: 'Potent Trails', cost: { base: { food: 200 }, growth: 3.5 }, unlock: 'adapt_potent_trails',
    fx: { forage: 1.12 } },
  serrated_mandibles: { id: 'serrated_mandibles', name: 'Serrated Mandibles', cost: { base: { food: 100, chitin: 5 }, growth: 2.0 },
    unlock: 'adapt_military', fx: { atk: 1.10 } },
  thick_cuticle: { id: 'thick_cuticle', name: 'Thick Cuticle', cost: { base: { food: 100, chitin: 5 }, growth: 2.0 },
    unlock: 'adapt_military', fx: { hp: 1.10 } },
  sweet_tooth: { id: 'sweet_tooth', name: 'Sweet Tooth', cost: { base: { food: 500, honeydew: 10 }, growth: 1.9 },
    unlock: 'adapt_honeydew', fx: { honeydew: 1.15 } },
  queens_feast: { id: 'queens_feast', name: "Queen's Feast", cost: { base: { honeydew: 50 }, growth: 3.0 }, unlock: 'adapt_honeydew',
    fx: { lay: 1.25 } },
  long_legs: { id: 'long_legs', name: 'Long Legs', cost: { base: { food: 1000 }, growth: 3.0 }, unlock: 'adapt_long_legs',
    fx: { dNav: 0.25 } },
});

/** Hardship limits: monomorphic caps every Adaptation at this level (DESIGN §13.8). */
export const ADAPT = deepFreeze({ monomorphicCap: 10 });
