// Cosmetics (C149): every cosmetic an achievement grants (data/achievements.js `cosmetic`), with its equip slot and the
// render variant the views draw. Owner: WP9 (UI) / WP8 (render). Contract: ARCHITECTURE §18 C149, DESIGN §19, §25.8.
// The slot is the key the equipCosmetic command writes into meta.cosmetics.equipped; render/cosmetics.js maps each
// variant to what is drawn. Pure data, no imports.

/** Deep-freeze helper. */
const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/** Slot display order. */
export const COSMETIC_SLOT_ORDER = f(['crown', 'palette', 'mound', 'flag', 'trail', 'pet', 'cursor', 'title', 'frame']);

/** Slot labels (Settings → Cosmetics). */
export const COSMETIC_SLOT_NAMES = f({
  crown: 'Queen', palette: 'Palette', mound: 'Mound skin', flag: 'Flag', trail: 'Trail colour', pet: 'Pet', cursor: 'Cursor',
  title: 'Title', frame: 'Nest frame',
});

/**
 * COSMETICS[id] = { id, slot, name, desc, variant, ...extra }. Variants:
 * crown: 'crown' (gold crown on the queen) | 'golden_queen' (gold queen body + jewelled crown + glow);
 * palette: 'royal_amber' (deep amber interface + amber-tinted workers in both views);
 * mound: 'snowcap' (white snow cap on the surface mound); flag: 'white_flag' (white flag on the mound);
 * trail: 'gold' (gold pheromone lines) | 'picasso' (each trail its own bright colour);
 * pet: 'ladybug' (a ladybug wandering around the mound); cursor: 'winged' (winged cursor across the whole game window, C164);
 * title: 'underdog' (`title` after the colony name in the top bar); frame: 'amber' (amber frame around the nest view).
 */
export const COSMETICS = f({
  cos_crown: { id: 'cos_crown', slot: 'crown', name: 'Crown', desc: 'A gold crown on your queen.', variant: 'crown' },
  cos_golden_queen: { id: 'cos_golden_queen', slot: 'crown', name: 'Golden Queen', desc: 'Your queen shines gold, with a jewelled crown.', variant: 'golden_queen' },
  cos_royal_amber: { id: 'cos_royal_amber', slot: 'palette', name: 'Royal Amber', desc: 'Deep amber interface and amber-tinted workers.', variant: 'royal_amber',
    tint: '#d98a1c' },
  cos_snowcap_mound: { id: 'cos_snowcap_mound', slot: 'mound', name: 'Snow-cap Mound', desc: 'A white snow cap on your mound.', variant: 'snowcap' },
  cos_white_flag: { id: 'cos_white_flag', slot: 'flag', name: 'White Flag', desc: 'A white flag flies over your mound.', variant: 'white_flag' },
  cos_gold_trail: { id: 'cos_gold_trail', slot: 'trail', name: 'Gold Trails', desc: 'Your pheromone trails glow gold.', variant: 'gold', color: '#ffd23f' },
  cos_trail_colour: { id: 'cos_trail_colour', slot: 'trail', name: 'Picasso Trails', desc: 'Every trail gets its own bright colour.', variant: 'picasso',
    colors: ['#ff5d8f', '#4cc9f0', '#b5e550', '#c77dff', '#ff9e3d', '#3ddc97'] },
  cos_ladybug_pet: { id: 'cos_ladybug_pet', slot: 'pet', name: 'Ladybug Pet', desc: 'A ladybug wanders around your mound.', variant: 'ladybug' },
  cos_winged_cursor: { id: 'cos_winged_cursor', slot: 'cursor', name: 'Winged Cursor', desc: 'A winged pointer across the whole game.', variant: 'winged' },
  cos_title_underdog: { id: 'cos_title_underdog', slot: 'title', name: 'Underdog Title', desc: '"the Underdog" after your colony name.', variant: 'underdog',
    title: 'the Underdog' },
  cos_amber_frame: { id: 'cos_amber_frame', slot: 'frame', name: 'Amber Strata Frame', desc: 'An amber frame around the nest view.', variant: 'amber' },
});
