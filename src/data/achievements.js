// World data (WP6): the 81 achievements of DESIGN §19. Owner: WP6. Contract: ARCHITECTURE §6.6.
// ACHIEVEMENTS[id] = { id, name, cat, desc, secret, target, reward, cosmetic }: `target` is the threshold of numeric
// achievements and the Next Goals bar length (null = a one-off deed with no bar); `reward` is display data only — the
// bonus is implemented by the consumer listed in ARCHITECTURE §12.5; `cosmetic` ids are granted into
// meta.cosmetics.owned by systems/achievements.js. ACH_PARAMS holds the remaining check thresholds; ACH_REQ the id
// lists that "every …" conditions run over.

import { FG_ORDER } from './fieldGuide.js';

/** Deep-freeze helper (plain objects and arrays). */
const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/** Entry builder. */
const A = (id, name, cat, desc, target = null, reward = null, cosmetic = null) => ({
  id, name, cat, desc, secret: cat === 'secret', target, reward: reward ? { text: reward } : null, cosmetic,
});

/** Display / iteration order (DESIGN §19 order). */
export const ACH_ORDER = f([
  // Population
  'ach_first_brood', 'ach_hundred_mandibles', 'ach_thousand_strong', 'ach_ten_thousand', 'ach_myriad', 'ach_billion_backs',
  'ach_six_trillion_legs', 'ach_twenty_quadrillion',
  // Food
  'ach_first_crumb', 'ach_clickstorm', 'ach_hoarder', 'ach_feast', 'ach_ten_million', 'ach_billion_bites', 'ach_trillion_tonnes',
  'ach_diminishing_returns', 'ach_survivor',
  // Excavation
  'ach_going_under', 'ach_into_the_clay', 'ach_gravel_pit', 'ach_bedrock_bound', 'ach_wellspring', 'ach_master_digger',
  'ach_treasure_hunter', 'ach_amber_finder',
  // Chambers
  'ach_royal_neighbours', 'ach_ant_farm', 'ach_grand_gallery', 'ach_clean_house', 'ach_seed_bank', 'ach_living_larder',
  'ach_architect', 'ach_royal_ascent',
  // Surface
  'ach_pathfinder', 'ach_double_bridge', 'ach_highway', 'ach_cartographer', 'ach_land_grab', 'ach_shepherd', 'ach_peach_fuzz',
  'ach_picnic_crasher', 'ach_mutualist',
  // Combat
  'ach_border_dispute', 'ach_square_law', 'ach_flawless', 'ach_pavement_is_ours', 'ach_total_war', 'ach_david_and_goliath',
  'ach_ritualist', 'ach_phragmosis', 'ach_big_game', 'ach_old_ridge_falls', 'ach_front_broken',
  // Seasons and events
  'ach_first_winter', 'ach_seasoned', 'ach_golden_touch', 'ach_beetle_collector', 'ach_the_large_blue', 'ach_zombie_averted',
  'ach_rain_dancer', 'ach_mole_friend', 'ach_flying_ant_day',
  // Prestige
  'ach_first_flight', 'ach_swift_swarm', 'ach_gentle_giants', 'ach_peak_timing', 'ach_sky_full_of_wings', 'ach_thousand_queens',
  'ach_hardship_tier', 'ach_hardship_master', 'ach_one_family', 'ach_living_fossil', 'ach_sociobiologist',
  // Secret
  'ach_queens_favorite', 'ach_overthinker', 'ach_pheromone_picasso', 'ach_lady_luck', 'ach_pacifist_flight', 'ach_wilsons_pride',
  // Field Guide
  'ach_naturalist', 'ach_field_guide_complete',
]);

/** The achievements. */
export const ACHIEVEMENTS = f({
  // ----- Population -----
  ach_first_brood: A('ach_first_brood', 'First Brood', 'population', 'Hatch your first worker.', 1),
  ach_hundred_mandibles: A('ach_hundred_mandibles', 'Hundred Mandibles', 'population', 'Have 100 adults at once.', 100),
  ach_thousand_strong: A('ach_thousand_strong', 'A Thousand Strong', 'population', 'Have 1,000 adults at once.', 1000, 'Lay +2%'),
  ach_ten_thousand: A('ach_ten_thousand', 'Ten Thousand Strong', 'population', 'Have 10,000 adults at once.', 1e4, 'Lay +2%'),
  ach_myriad: A('ach_myriad', 'Myriad', 'population', 'Reach a census of 1e6.', 1e6, 'Lay +2%'),
  ach_billion_backs: A('ach_billion_backs', 'A Billion Backs', 'population', 'Reach a census of 1e9.', 1e9),
  ach_six_trillion_legs: A('ach_six_trillion_legs', 'Six Trillion Legs', 'population', 'Reach a census of 1e12.', 1e12),
  ach_twenty_quadrillion: A('ach_twenty_quadrillion', 'Twenty Quadrillion', 'population', 'Reach a census of 2e16, every ant on Earth.', 2e16,
    'Ending sequence, credits and the golden queen', 'cos_golden_queen'),

  // ----- Food -----
  ach_first_crumb: A('ach_first_crumb', 'First Crumb', 'food', 'Hand-forage a source.'),
  ach_clickstorm: A('ach_clickstorm', 'Clickstorm', 'food', 'Click 10,000 times in total.', 1e4, 'Click base ×2'),
  ach_hoarder: A('ach_hoarder', 'Hoarder', 'food', 'Keep food at its cap for 10 minutes straight.', 600, 'Food cap +10%'),
  ach_feast: A('ach_feast', 'Feast', 'food', 'Gather 1e6 food in one run.', 1e6),
  ach_ten_million: A('ach_ten_million', 'Ten Million Crumbs', 'food', 'Gather 1e7 food in one run.', 1e7),
  ach_billion_bites: A('ach_billion_bites', 'Billion Bites', 'food', 'Gather 1e9 food in one run.', 1e9),
  ach_trillion_tonnes: A('ach_trillion_tonnes', 'Trillion Tonnes', 'food', 'Gather 1e12 food in one run.', 1e12),
  ach_diminishing_returns: A('ach_diminishing_returns', 'Diminishing Returns', 'food', 'Push any output into a softcap.'),
  ach_survivor: A('ach_survivor', 'Survivor', 'food', 'Get through a whole winter without going Hungry.', null, 'Winter upkeep −5%'),

  // ----- Excavation -----
  ach_going_under: A('ach_going_under', 'Going Under', 'excavation', 'Dig a cell in row 10.', null, 'Tunnel work −5%'),
  ach_into_the_clay: A('ach_into_the_clay', 'Into the Clay', 'excavation', 'Dig down to row 24.', 24, 'Fungus +10%'),
  ach_gravel_pit: A('ach_gravel_pit', 'Gravel Pit', 'excavation', 'Dig down to row 40.', 40, 'Soil +5%'),
  ach_bedrock_bound: A('ach_bedrock_bound', 'Bedrock Bound', 'excavation', 'Dig down to row 58.', 58, 'Dig +5%'),
  ach_wellspring: A('ach_wellspring', 'Wellspring', 'excavation', 'Dig down to row 74.', 74),
  ach_master_digger: A('ach_master_digger', 'Master Digger', 'excavation', 'Dig 1,000 cells in total.', 1000),
  ach_treasure_hunter: A('ach_treasure_hunter', 'Treasure Hunter', 'excavation', 'Collect 10 caches.', 10, 'Cache hint radius +1'),
  ach_amber_finder: A('ach_amber_finder', 'Amber Finder', 'excavation', 'Collect an amber bead.', 1),

  // ----- Chambers -----
  ach_royal_neighbours: A('ach_royal_neighbours', 'Royal Neighbours', 'chambers', 'Build a Nursery next to the Royal Chamber.'),
  ach_ant_farm: A('ach_ant_farm', 'Ant Farm', 'chambers', 'Have 10 chambers active at once.', 10),
  ach_grand_gallery: A('ach_grand_gallery', 'Grand Gallery', 'chambers', 'Grow a Gallery to its level 8 footprint.', 8),
  ach_clean_house: A('ach_clean_house', 'Clean House', 'chambers', 'Scrape 10 mold spots.', 10, 'Mold chance −10%'),
  ach_seed_bank: A('ach_seed_bank', 'Seed Bank', 'chambers', 'Fill food to its cap while a gravel Granary is active.', null, 'Granary capacity +10%'),
  ach_living_larder: A('ach_living_larder', 'Living Larder', 'chambers', 'Raise 50 repletes.', 50, 'Royal amber palette', 'cos_royal_amber'),
  ach_architect: A('ach_architect', 'Architect', 'chambers', 'Relocate 5 chambers.', 5, 'Relocation cost −25%'),
  ach_royal_ascent: A('ach_royal_ascent', 'Royal Ascent', 'chambers', 'Raise the Royal Chamber to level 10.', 10, 'Lay +5%'),

  // ----- Surface -----
  ach_pathfinder: A('ach_pathfinder', 'Pathfinder', 'surface', 'Run a trail at least 4 hexes long.', 4),
  ach_double_bridge: A('ach_double_bridge', 'Double Bridge', 'surface', 'Redraw a trail at least 30% shorter.', null, 'Strength rise +10%'),
  ach_highway: A('ach_highway', 'Highway', 'surface', 'Hold a trail at full strength for 5 minutes.', 300, 'S_max +5'),
  ach_cartographer: A('ach_cartographer', 'Cartographer', 'surface', 'Reveal the whole map.', null, 'Scouts +50%'),
  ach_land_grab: A('ach_land_grab', 'Land Grab', 'surface', 'Own 50 hexes.', 50, 'Claim cost −10%'),
  ach_shepherd: A('ach_shepherd', 'Shepherd', 'surface', 'Herd 3 aphid colonies at once.', 3, 'Honeydew +10%'),
  ach_peach_fuzz: A('ach_peach_fuzz', 'Peach Fuzz', 'surface', 'Fully harvest a fallen fruit.'),
  ach_picnic_crasher: A('ach_picnic_crasher', 'Picnic Crasher', 'surface', 'Harvest every crumb of a picnic.', null, 'Golden Beetle +5 s'),
  ach_mutualist: A('ach_mutualist', 'Mutualist', 'surface', 'Milk a Lycaenid caterpillar for 5 minutes.', 300),

  // ----- Combat -----
  ach_border_dispute: A('ach_border_dispute', 'Border Dispute', 'combat', 'Win a battle.', 1),
  ach_square_law: A('ach_square_law', 'Square Law', 'combat', 'Win a battle while outnumbered.', null, 'AP +5%'),
  ach_flawless: A('ach_flawless', 'Flawless', 'combat', 'Win a nest assault losing under 5% of your army.', null, 'Alarm Rally cost −20%'),
  ach_pavement_is_ours: A('ach_pavement_is_ours', 'The Pavement Is Ours', 'combat', 'Conquer the Pavement Ants.'),
  ach_total_war: A('ach_total_war', 'Total War', 'combat', 'Make 5 conquests in one run.', 5, 'Soldier HP +10%'),
  ach_david_and_goliath: A('ach_david_and_goliath', 'David and Goliath', 'combat', 'Win a battle at under 40% predicted odds.', null,
    'Underdog title', 'cos_title_underdog'),
  ach_ritualist: A('ach_ritualist', 'Ritualist', 'combat', 'Win 10 tournaments.', 10, 'Tournament threshold 1.5 → 1.4'),
  ach_phragmosis: A('ach_phragmosis', 'Phragmosis', 'combat', 'Repel a nest raid with no brood lost.', null, 'Gate +5%'),
  ach_big_game: A('ach_big_game', 'Big Game', 'combat', 'Hunt a beetle.'),
  ach_old_ridge_falls: A('ach_old_ridge_falls', 'The Old Ridge Falls', 'combat', 'Conquer the Old Ridge supercolony.'),
  ach_front_broken: A('ach_front_broken', 'The Front Is Broken', 'combat', 'Defeat all three nests of the Argentine Front.'),

  // ----- Seasons and events -----
  ach_first_winter: A('ach_first_winter', 'First Winter', 'seasons', 'Reach the spring of year 1.', 1, 'Snow-cap mound skin', 'cos_snowcap_mound'),
  ach_seasoned: A('ach_seasoned', 'Seasoned', 'seasons', 'Let 10 years pass.', 10),
  ach_golden_touch: A('ach_golden_touch', 'Golden Touch', 'seasons', 'Catch a Golden Beetle.', 1),
  ach_beetle_collector: A('ach_beetle_collector', 'Beetle Collector', 'seasons', 'Catch 50 Golden Beetles.', 50, 'Beetles last 20 s'),
  ach_the_large_blue: A('ach_the_large_blue', 'The Large Blue', 'seasons', 'Raise a Phengaris caterpillar to a butterfly.', null, 'Insight +5%'),
  ach_zombie_averted: A('ach_zombie_averted', 'Zombie Apocalypse Averted', 'seasons', 'End an Ophiocordyceps outbreak with under 1% losses.'),
  ach_rain_dancer: A('ach_rain_dancer', 'Rain Dancer', 'seasons', 'Weather 10 rainstorms.', 10),
  ach_mole_friend: A('ach_mole_friend', 'Mole Friend', 'seasons', 'Receive 5 mole tunnels.', 5),
  ach_flying_ant_day: A('ach_flying_ant_day', 'Flying Ant Day', 'seasons', 'Fly during a Flight Day.', null, 'Alates +5%'),

  // ----- Prestige -----
  ach_first_flight: A('ach_first_flight', 'First Flight', 'prestige', 'Complete a Nuptial Flight.', 1),
  ach_swift_swarm: A('ach_swift_swarm', 'Swift Swarm', 'prestige', 'Fly within 20 minutes of a run start.', null, 'Alates +10%'),
  ach_gentle_giants: A('ach_gentle_giants', 'Gentle Giants', 'prestige', 'Fly without raising a soldier that run.', null, 'Alates +5%'),
  ach_peak_timing: A('ach_peak_timing', 'Peak Timing', 'prestige', 'Fly within 60 s of the alates/min peak.'),
  ach_sky_full_of_wings: A('ach_sky_full_of_wings', 'Sky Full of Wings', 'prestige', 'Earn 100 alates in one flight.', null, 'Winged cursor',
    'cos_winged_cursor'),
  ach_thousand_queens: A('ach_thousand_queens', 'A Thousand Queens', 'prestige', 'Earn 1,000 alates in total.', 1000),
  ach_hardship_tier: A('ach_hardship_tier', 'Hardened', 'prestige', 'Complete any Hardship tier.', 1),
  ach_hardship_master: A('ach_hardship_master', 'Unbreakable', 'prestige', 'Complete all 6 Hardships at tier 5.', 30),
  ach_one_family: A('ach_one_family', 'One Family', 'prestige', 'Form your first Supercolony.', 1, 'Gold trail colour', 'cos_gold_trail'),
  ach_living_fossil: A('ach_living_fossil', 'Living Fossil', 'prestige', 'Complete your first Speciation.', 1, 'Amber Strata frame', 'cos_amber_frame'),
  ach_sociobiologist: A('ach_sociobiologist', 'Sociobiologist', 'prestige', 'Own every research node in one run.', null, 'Insight ×1.25'),

  // ----- Secret (hidden until earned) -----
  ach_queens_favorite: A('ach_queens_favorite', "Queen's Favourite", 'secret', 'Click the queen 500 times.', 500, 'Crown', 'cos_crown'),
  ach_overthinker: A('ach_overthinker', 'Overthinker', 'secret', 'Reroute one trail 20 times in one minute.'),
  ach_pheromone_picasso: A('ach_pheromone_picasso', 'Pheromone Picasso', 'secret', 'Run a trail at least 30 hexes long.', 30, 'Trail colour',
    'cos_trail_colour'),
  ach_lady_luck: A('ach_lady_luck', 'Lady Luck', 'secret', 'Click 50 ladybugs.', 50, 'Ladybug pet', 'cos_ladybug_pet'),
  ach_pacifist_flight: A('ach_pacifist_flight', 'Pacifist Flight', 'secret', 'Fly without a single battle that run.', null, 'White-flag mound',
    'cos_white_flag'),
  ach_wilsons_pride: A('ach_wilsons_pride', "Wilson's Pride", 'secret', 'Have every caste and every job active at once.', null, '+3% all production'),

  // ----- Field Guide -----
  ach_naturalist: A('ach_naturalist', 'Naturalist', 'guide', 'Unlock 25 Field Guide entries.', 25),
  ach_field_guide_complete: A('ach_field_guide_complete', 'Myrmecologist', 'guide', 'Unlock every Field Guide entry.', FG_ORDER.length),
});

/**
 * Check thresholds that are not a progress-bar target.
 * swiftSec: run time of a "swift" flight; peakSec: distance to the alates/min peak; flightAlates: alates in one flight;
 * flawlessLoss: max loss share of a flawless assault; underdogOdds: predicted odds below which a win is an upset;
 * shorterFrac: required length reduction of a redrawn trail; atMaxFrac: share of S_max that counts as "at S_max";
 * hardshipTier: the tier every Hardship needs for ach_hardship_master; goingUnderRow: the row of ach_going_under.
 */
export const ACH_PARAMS = f({ swiftSec: 1200, peakSec: 60, flightAlates: 100, flawlessLoss: 0.05, underdogOdds: 0.4, shorterFrac: 0.3,
  atMaxFrac: 0.99, hardshipTier: 5, goingUnderRow: 10 });

/** Id lists the "every …" conditions run over (kept here so a not-yet-loaded table can never make them vacuous). */
export const ACH_REQ = f({
  castes: ['minor', 'soldier', 'supermajor', 'replete', 'alate'],
  jobs: ['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener'],
  hardships: ['eternal_winter', 'claustral_founding', 'pacifist', 'barren_ground', 'shallow_soil', 'monomorphic'],
});
