// Soil features seeded per run: root lines, stones, caches, water pockets (DESIGN §7.9, §13.6 landing tags), plus
// the mole-tunnel shape used by nest.moleTunnel (DESIGN §18.2). Owner: WP3. Contract: ARCHITECTURE §6.3.

const freeze = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') freeze(o[k]);
  return Object.freeze(o);
};

/** Root lines: 6–10 vertical lines from row 1 down to a row in 6..25. */
export const ROOTS = freeze({ min: 6, max: 10, yMin: 6, yMax: 25 });

/** Stones: 4–8 boulders of 3×3 cells, entirely within rows 8–55. */
export const STONES = freeze({ min: 4, max: 8, size: 3, yMin: 8, yMax: 55 });

/**
 * Caches: 8–12 single cells in rows 5–60, kind drawn by weight; one amber bead per map in bedrock.
 * Reward = max(min, sec × current gross income of res) (DESIGN §7.9).
 */
export const CACHES = freeze({
  min: 8, max: 12, yMin: 5, yMax: 60,
  kinds: {
    seed_cache:  { weight: 4, res: 'food', sec: 90, min: 50 },
    beetle_husk: { weight: 3, res: 'chitin', sec: 60, min: 25 },
    fossil:      { weight: 3, res: 'insight', sec: 60, min: 50 },
  },
  amber: { count: 1, layer: 'bedrock' },
});

/** Water pockets: 2–3 rectangles of 2×2 to 3×3 cells, entirely within rows 40–70. */
export const WATER = freeze({ min: 2, max: 3, sizeMin: 2, sizeMax: 3, yMin: 40, yMax: 70 });

/** Landing-site modifiers that change nest generation (DESIGN §13.6). */
export const SITE_MODS = freeze({ site_stony_ground: { stones: 2, caches: 2 }, site_wet_hollow: { waterAdd: 2 } });

/**
 * Mole tunnel (ev_mole_tunnel, DESIGN §18.2): a diagonal staircase of 6–12 SOIL/TUNNEL cells within rows 1–60.
 * attempts = placement tries with the main RNG. WP3 extension of the §6.3 data (the event row's cell numbers).
 */
export const MOLE = freeze({ lenMin: 6, lenMax: 12, rowMin: 1, rowMax: 60, attempts: 60 });

/**
 * Generator constants (nestgen): placement tries per feature, the empty margin kept between boulders / water pockets
 * and the shaft, Royal Chambers and each other, and the tunnel gap between pre-dug Royal Chambers (fire ants).
 */
export const GEN = freeze({ attempts: 300, margin: 1, royalGap: 2 });
