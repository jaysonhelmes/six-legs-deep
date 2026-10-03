// Rival data: the six-tier ladder, procedural elder tiers, bosses, rival traits, growth and spawn rules.
// Owner: WP5. Contract: ARCHITECTURE §6.5 (DESIGN §9.2 ladder, §9.3 bosses, §8.6 territory radii, §8.9 spawning).

const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/** Ladder order (tier 1 → 6). */
export const RIVAL_ORDER = f(['black_garden_ants', 'pavement_ants', 'red_wood_ants', 'carpenter_ants', 'fire_ants', 'slave_makers']);

/**
 * The rival ladder (DESIGN §9.2). soldiers = base soldiers; atk/hp per unit; radius = territory radius (C47);
 * raidMin = mean raid interval in minutes; traits = rival trait ids (TRAITS below). log: the nest sits on a fallen log.
 */
export const RIVALS = f({
  black_garden_ants: { id: 'black_garden_ants', name: 'Black Garden Ants', sci: 'Lasius niger', tier: 1, soldiers: 15, atk: 3, hp: 15,
    radius: 2, raidMin: 8, traits: [] },
  pavement_ants: { id: 'pavement_ants', name: 'Pavement Ants', sci: 'Tetramorium', tier: 2, soldiers: 60, atk: 4, hp: 20,
    radius: 2, raidMin: 6, traits: ['swarm'] },
  red_wood_ants: { id: 'red_wood_ants', name: 'Red Wood Ants', sci: 'Formica rufa', tier: 3, soldiers: 200, atk: 6, hp: 30,
    radius: 3, raidMin: 5, traits: ['acid_volley'] },
  carpenter_ants: { id: 'carpenter_ants', name: 'Carpenter Ants', sci: 'Camponotus', tier: 4, soldiers: 400, atk: 10, hp: 60,
    radius: 2, raidMin: 12, traits: ['home_fortress'], log: true },
  fire_ants: { id: 'fire_ants', name: 'Fire Ants', sci: 'Solenopsis invicta', tier: 5, soldiers: 1000, atk: 8, hp: 25,
    radius: 3, raidMin: 4, traits: ['venom', 'border_creep'] },
  slave_makers: { id: 'slave_makers', name: 'Blood-red Slave-makers', sci: 'Formica sanguinea', tier: 6, soldiers: 600, atk: 12, hp: 50,
    radius: 2, raidMin: 7, traits: ['brood_raiders'] },
});

/**
 * Elder colonies, tiers k ≥ fromTier (DESIGN §9.2): AP = apBase × apGrowth^(k − 6); ATK = atkBase × statGrowth^(k − 6);
 * HP = hpBase × statGrowth^(k − 6); soldiers = AP ÷ √(ATK × HP); traitsMin–traitsMax random traits.
 * tierOffset = the 6 in "k − 6".
 */
export const ELDER = f({ id: 'elder_colony', name: 'Elder Colony', sci: 'procedural', fromTier: 7, tierOffset: 6,
  apBase: 15000, apGrowth: 4, atkBase: 12, hpBase: 60, statGrowth: 1.2, radius: 3, raidMin: 6, traitsMin: 1, traitsMax: 2 });

/** Rival growth (DESIGN §9.2): soldiers + perMin of base per minute (perMinSummer in summer), up to maxMult × base. */
export const GROWTH = f({ perMin: 0.01, perMinSummer: 0.03, maxMult: 3 });

/** Rival traits (DESIGN §9.2 / §9.6). */
export const TRAITS = f({
  swarm: { apMult: 1.2 },               // rival AP × 1.2 when their committed count exceeds yours
  acid_volley: { yourAP: 0.9 },         // your AP × 0.9 (cancelled by formic_acid)
  home_fortress: { home: 1.5 },         // home bonus 1.5 instead of the assault default
  venom: { yourHP: 0.8 },               // your HP × 0.8
  border_creep: {},                     // gains 1 unowned adjacent hex every TERRITORY.creepSec (data/surface.js)
  brood_raiders: { partyFrac: 0.4, returnMult: 3 },   // raids target the nest and steal brood; conquest returns 3 × stolen
});

/** Trait iteration order (elder colonies roll their random traits from this list). */
export const RIVAL_TRAIT_ORDER = f(['swarm', 'acid_volley', 'home_fortress', 'venom', 'border_creep', 'brood_raiders']);

/**
 * Bosses (DESIGN §9.3). AP formulas: Old Ridge apBase × (1 + m)^apExp; Front apBase × apGrowth^s in TOTAL, split over
 * `nests` nests; army column apBase × (1 + m)^apExp. m = meta.counters.supercolonies, s = meta.counters.speciations.
 * Boss soldier count = AP ÷ √(atk × hp) (C28). great_rival.minGap: preferred minimum hex distance between Front nests
 * (placement only; not in DESIGN).
 */
export const BOSSES = f({
  old_ridge_supercolony: { id: 'old_ridge_supercolony', name: 'The Old Ridge Supercolony', sci: 'Formica',
    apBase: 1e6, apExp: 1.5, atk: 12, hp: 60, radius: 3, immuneUntilOwned: 25, raidMin: 6, alatesCycle: 2500 },
  great_rival: { id: 'great_rival', name: 'The Argentine Front', sci: 'Linepithema humile',
    apBase: 1e8, apGrowth: 10, atk: 4, hp: 20, radius: 3, nests: 3, windowSec: 600, raidMin: 3, minGap: 6 },
  army_ant_column: { id: 'army_ant_column', name: 'Army Ant Column', sci: 'Eciton burchellii',
    apBase: 43000, apExp: 1.5, atk: 6, hp: 30, crossSec: 90, lootFoodSec: 1800, lootChitinSec: 600, lootChitinMin: 2000 },
});

/** Boss ids that live on the map as rivals (the army column is an event battle, never a Rival). */
export const MAP_BOSS_ORDER = f(['old_ridge_supercolony', 'great_rival']);

/**
 * Spawning (DESIGN §8.9): initial tier rings (used by mapgen), max concurrent rivals by map radius, respawn delay
 * [min, max] seconds after a conquest, and the outermost ring band (rings radius − outerBand + 1 .. radius).
 */
export const SPAWN = f({ tier1Ring: [4, 5], tier2Ring: [6, 7], maxByRadius: { 8: 2, 12: 3, 16: 4 }, respawnSec: [600, 1200], outerBand: 2 });

/**
 * Conquered rivals kept in s.run.rivals.list (ARCHITECTURE §18 C77, save size): conquered non-boss rivals are compacted
 * to a minimal record and at most `keep` of them stay (the oldest are dropped). Bosses are never compacted or dropped.
 */
export const FALLEN_RIVALS = f({ keep: 24 });
