// Soil features seeded per run: root lines, stones, caches, water pockets (DESIGN §7.9, §13.6 landing tags), plus
// the mole-tunnel shape used by nest.moleTunnel (DESIGN §18.2). Owner: WP3. Contract: ARCHITECTURE §6.3.

const freeze = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') freeze(o[k]);
  return Object.freeze(o);
};

/** Root lines: 6–10 vertical lines from row 1 down to a row in 6..25. */
export const ROOTS = freeze({ min: 6, max: 10, yMin: 6, yMax: 25 });

/**
 * Stones: 4–8 boulders, entirely within rows 8–55. C181: each boulder draws a shape by weight — a pebble (1×1), a bar
 * (2×1, either way up), a block (2×2), a slab (2×3, either way up), an L (3 or 4 cells, any turn), a blob (blobMin–blobMax
 * cells grown from one cell) or the classic size × size boulder — from its own seeded stream (nestgen). Gameplay is the
 * same for every shape (acid_excavation digs stone).
 */
export const STONES = freeze({
  min: 4, max: 8, size: 3, yMin: 8, yMax: 55, blobMin: 3, blobMax: 6,
  shapes: { pebble: 2, bar: 3, block: 2, slab: 2, ell: 3, blob: 4, boulder: 1 },
});

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
 * C290 treasure mole: the mole tunnel always ends at a free cache (an event object 'mole_cache' on the tunnel's last
 * cell) the player clicks to collect. Kind drawn by weight with the main RNG when the mole digs; the reward is
 * computed when collected: max(min, sec × smoothed gross income of res, capFrac × that resource's cap) — capFrac only
 * for capped resources (food, chitin), so the find stays worth a click as the colony grows. Seeds may overflow the
 * food cap (a one-shot reward, like a buried seed cache).
 */
export const MOLE_CACHE = freeze({
  kinds: {
    seed_cache:  { name: 'Seed cache', weight: 4, res: 'food', sec: 120, capFrac: 0.15, min: 60 },
    fossil:      { name: 'Fossil', weight: 3, res: 'insight', sec: 120, capFrac: 0, min: 40 },
    beetle_husk: { name: 'Beetle husk', weight: 3, res: 'chitin', sec: 90, capFrac: 0.15, min: 20 },
  },
  order: ['seed_cache', 'fossil', 'beetle_husk'],
});

/**
 * Generator constants (nestgen): placement tries per feature, the empty margin kept between boulders / water pockets
 * and the shaft, Royal Chambers and each other, and the tunnel gap between pre-dug Royal Chambers (fire ants).
 */
export const GEN = freeze({ attempts: 300, margin: 1, royalGap: 2 });

/**
 * Drainage abilities (DESIGN §7.9; research `drainage`, ARCHITECTURE §18 C117). A revealed water pocket can be
 * drained (each water cell costs drainWork × its layer's cell work in dig work and drainSoil soil, paid when queued;
 * the cells become diggable soil) or relocated to a same-size spot of plain soil anywhere in the nest (C255: no row limit; moveWork ×
 * layer work per water cell, no soil). A Water Well left touching no pocket is removed with its placement food refunded
 * in full. C157: a move may cover open tunnel cells that can be backfilled without cutting anything off; each is filled
 * as part of the move for fillWork × its tunnel work.
 */
export const DRAINAGE = freeze({ research: 'drainage', drainWork: 2, drainSoil: 120, moveWork: 1.5, fillWork: 1 });

/**
 * Cultivated roots (research `root_cultivation`, ARCHITECTURE §18 C118): a player-grown root line from row y0 down a
 * chosen column, rowsPerSec rows per second, to maxRow at most (it stops above a chamber, stone, water or shaft cell).
 * Cost cost × growth^n (n = cultivated roots this run). Cap: cap + 1 per moundPer Mound levels (at most +moundMax).
 */
export const ROOT_CULT = freeze({
  research: 'root_cultivation', cost: { honeydew: 120, food: 800 }, growth: 1.6, cap: 3, moundPer: 5, moundMax: 3,
  rowsPerSec: 2, y0: 1, maxRow: 30,
});

/**
 * C158 Bloodline trait `deep_spring` (DESIGN §13.7): a blueprint Water Well whose C119 search finds no revealed pocket
 * with a free Well spot within `reach` cells (Manhattan, from its saved corner) makes a small `size` × `size` spring
 * pocket touching its saved spot (plain soil only), so the Well can be built there.
 */
export const DEEP_SPRING = freeze({ trait: 'deep_spring', reach: 8, size: 2 });

/**
 * C158 Bloodline trait `root_memory` (DESIGN §13.7): a blueprint Root Aphid Pen with no root line to touch grows one
 * free cultivated root (no cost, outside the root cap) from row ROOT_CULT.y0 down a column over or beside its saved spot,
 * at ROOT_CULT.rowsPerSec, stopping where it touches the pen.
 */
export const ROOT_MEMORY = freeze({ trait: 'root_memory' });
