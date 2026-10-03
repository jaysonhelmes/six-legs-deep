// Player-facing copy: labels, reason messages, event/toast copy, tooltip copy (≤ 12 words each, DESIGN §25.6 rule 4),
// unlock condition hints and import errors. Owner: WP9. Contract: ARCHITECTURE §14 (text.js), §7.4 reason codes,
// §10 events. Pure module (no DOM). Display names come from the data tables' `name` fields when present; the
// fallbacks below keep the UI readable while a data table is still empty.

import { CHAMBERS } from '../data/chambers.js';
import { RESEARCH, BRANCHES } from '../data/research.js';
import { ADAPTATIONS } from '../data/adaptations.js';
import { JOBS } from '../data/jobs.js';
import { CASTES } from '../data/castes.js';
import { SOURCES } from '../data/sources.js';
import { RIVALS, BOSSES } from '../data/rivals.js';
import { EVENTS } from '../data/events.js';
import { ACHIEVEMENTS } from '../data/achievements.js';
import { FIELD_GUIDE } from '../data/fieldGuide.js';
import { TRAITS as BLOODLINE } from '../data/bloodline.js';
import { FEDERATION } from '../data/federation.js';
import { GENOME, SPECIES } from '../data/genome.js';
import { HARDSHIPS, SITES, BOONS, EDICTS, FLIGHT } from '../data/prestige.js';
import { UNLOCKS } from '../data/unlocks.js';
import { LAYERS, GEOM } from '../data/strata.js';
import { TERRAIN } from '../data/surface.js';
import { YEAR } from '../data/seasons.js';
import { fmt, fmtTime, fmtCount } from './format.js';

// ---------------------------------------------------------------------------------------------------------------
// Generic naming
// ---------------------------------------------------------------------------------------------------------------

const PREFIXES = ['ach_', 'fg_', 'ev_', 'site_', 'boon_', 'edict_of_', 'sig_', 'species_', 'bn_', 'adj_', 'hyg_', 'prox_'];

/**
 * Readable fallback name from a snake_case id: prefixes stripped, first letter capitalised, underscores → spaces.
 * @param {string} id
 * @returns {string}
 */
export function humanize(id) {
  if (typeof id !== 'string' || id.length === 0) return '';
  let t = id;
  for (const p of PREFIXES) {
    if (t.startsWith(p) && t.length > p.length) {
      t = t.slice(p.length);
      break;
    }
  }
  t = t.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Fallback display names (used only when the data table has no entry yet). */
const FALLBACK_NAMES = {
  chamber: { royal_chamber: 'Royal Chamber', gallery: 'Gallery', nursery: 'Nursery', granary: 'Granary', scent_library: 'Scent Library',
    midden: 'Midden', barracks: 'Barracks', root_aphid_pen: 'Root Aphid Pen', fungus_garden: 'Fungus Garden', repletion_hall: 'Repletion Hall',
    hibernaculum: 'Hibernaculum', thermal_chimney: 'Thermal Chimney', gate: 'Gate', water_well: 'Water Well', nuptial_chamber: 'Nuptial Chamber',
    deep_vault: 'Deep Vault' },
  job: { forager: 'Forager', digger: 'Digger', nurse: 'Nurse', scout: 'Scout', herder: 'Herder', leafcutter: 'Leafcutter', gardener: 'Gardener',
    idle: 'Idle' },
  caste: { queen: 'Queen', minor: 'Minor worker', soldier: 'Soldier', supermajor: 'Supermajor', replete: 'Replete', alate: 'Alate' },
  rival: { black_garden_ants: 'Black Garden Ants', pavement_ants: 'Pavement Ants', red_wood_ants: 'Red Wood Ants', carpenter_ants: 'Carpenter Ants',
    fire_ants: 'Fire Ants', slave_makers: 'Blood-red Slave-makers', elder_colony: 'Elder Colony', old_ridge_supercolony: 'The Old Ridge Supercolony',
    great_rival: 'The Argentine Front', army_ant_column: 'Army Ant Column' },
  source: { crumb_scatter: 'Crumb scatter', seed_patch: 'Seed patch', flower_patch: 'Flower patch', dead_insect: 'Dead insect', leaf_plant: 'Leaf plant',
    aphid_colony: 'Aphid colony', prey_caterpillar: 'Caterpillar', prey_cricket: 'Cricket', prey_beetle: 'Beetle', fallen_fruit: 'Fallen fruit',
    picnic_spill: 'Picnic spill', termite_mound: 'Termite mound', lycaenid_caterpillar: 'Lycaenid caterpillar', harvester_stash: 'Harvester stash',
    termite_swarm: 'Termite swarm' },
  layer: { topsoil: 'Topsoil', loam: 'Loam', clay: 'Clay', gravel: 'Gravel', bedrock: 'Bedrock', aquifer: 'Aquifer' },
  terrain: { grass: 'Grass', sand: 'Sand', leaf_litter: 'Leaf litter', garden_path: 'Garden path', tree_root: 'Tree root', stone: 'Stone',
    puddle: 'Puddle', log: 'Fallen log' },
  branch: { foraging: 'Foraging', excavation: 'Excavation', brood: 'Brood & Royalty', husbandry: 'Husbandry', warfare: 'Warfare',
    communication: 'Communication & Climate' },
  species: { garden_ant: 'Black Garden Ant', leafcutter: 'Leafcutter', honeypot: 'Honeypot', fire_ant: 'Fire Ant' },
};

const TABLES = {
  chamber: CHAMBERS, research: RESEARCH, adaptation: ADAPTATIONS, job: JOBS, caste: CASTES, source: SOURCES, rival: RIVALS, event: EVENTS,
  achievement: ACHIEVEMENTS, guide: FIELD_GUIDE, trait: BLOODLINE, federation: FEDERATION, genome: GENOME, species: SPECIES,
  hardship: HARDSHIPS, site: SITES, boon: BOONS, edict: EDICTS, layer: LAYERS, terrain: TERRAIN, branch: BRANCHES,
};

/**
 * Display name of a game id: the data table's `name` (or `title` for field-guide entries), else a fallback, else
 * a humanized id.
 * @param {string} kind 'chamber' | 'research' | 'adaptation' | 'job' | 'caste' | 'source' | 'rival' | 'event' | 'achievement' |
 *   'guide' | 'trait' | 'federation' | 'genome' | 'species' | 'hardship' | 'site' | 'boon' | 'edict' | 'layer' | 'terrain' |
 *   'branch' | 'res' | 'unlock'
 * @param {string} id
 * @returns {string}
 */
export function nameOf(kind, id) {
  if (id === null || id === undefined) return '';
  if (kind === 'res') return RES_NAMES[id] || humanize(id);
  if (kind === 'unlock') return unlockLabel(id);
  const table = TABLES[kind];
  const entry = table && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
  if (entry && typeof entry.name === 'string' && entry.name) return entry.name;
  if (entry && typeof entry.title === 'string' && entry.title) return entry.title;
  const fb = FALLBACK_NAMES[kind];
  if (fb && fb[id]) return fb[id];
  if (kind === 'research' && typeof id === 'string' && id.endsWith('_refinement')) return humanize(id.replace('_refinement', '')) + ' Refinement';
  return humanize(String(id));
}

// ---------------------------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------------------------

/** Resource display names. */
export const RES_NAMES = Object.freeze({
  food: 'Food', soil: 'Soil', insight: 'Insight', pheromone: 'Pheromone', chitin: 'Chitin', honeydew: 'Honeydew', leaves: 'Leaves',
  fungus: 'Fungus', alates: 'Alates', kinship: 'Kinship', genes: 'Genes',
});

/** Resource tooltips (≤ 12 words). */
export const RES_TIPS = Object.freeze({
  food: 'Brought home by foragers. Eggs, chambers and upkeep spend it.',
  soil: 'Dug out by diggers. Pays for chamber levels and the Mound.',
  insight: 'Earned by scouting and libraries. Spent on research.',
  pheromone: 'Regenerates over time. Fuels Mark, Rally, Frenzy and claims.',
  chitin: 'From insects, hunts and battles. Soldiers need it.',
  honeydew: 'Milked from aphids by herders. Feeds the queen and repletes.',
  leaves: 'Cut by leafcutters. Gardeners turn them into fungus.',
  fungus: 'Grown in gardens. Feeds the colony and supermajors.',
  alates: 'Winged princesses from Nuptial Flights. Buy Bloodline traits.',
  kinship: 'Earned by forming a Supercolony. Buys Federation nodes.',
  genes: 'Earned by Speciation. Buys Genome nodes.',
});

// ---------------------------------------------------------------------------------------------------------------
// Reason codes (ARCHITECTURE §7.4)
// ---------------------------------------------------------------------------------------------------------------

/** Player text for every ReasonCode. */
export const REASONS = Object.freeze({
  unknown: 'That action is not available yet.',
  paused: 'Choose a landing site first.',
  locked: 'Not unlocked yet.',
  cantAfford: 'Not enough resources.',
  invalid: 'That will not work here.',
  max: 'Already at maximum.',
  noSlot: 'No free slot.',
  blocked: 'Something is in the way.',
  cooldown: 'Still recharging.',
  busy: 'Busy right now.',
  hardship: 'Not allowed in this Hardship.',
  notFound: 'It is no longer there.',
  queueFull: 'The dig queue is full.',
  clickCap: 'Too fast! 15 clicks per second at most.',
  requirements: 'Requirements not met yet.',
});

/** Rule numbers quoted by the reason copy (from the data tables, never hardcoded). */
const OLD_RIDGE_HEXES = num0(BOSSES.old_ridge_supercolony && BOSSES.old_ridge_supercolony.immuneUntilOwned, 25);
const SAT_FX = (FEDERATION.satellite_nest && FEDERATION.satellite_nest.fx) || {};
const SAT_MIN_DIST = num0(SAT_FX.minDist, 3);
const SAT_COL_GAP = num0(SAT_FX.colGap, 4);
const ROYAL_LEVEL = num0(FLIGHT.royalLevel, 5);
const SHAFT_GAP = num0(GEOM.shaftGap, 3);
const nameOr = (table, id, fb) => (table[id] && table[id].name) || fb;

function num0(v, fb) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
}

/** Player text for known "code:detail" reasons (every detail a system validator can return; ARCHITECTURE §7.4). */
export const REASON_DETAILS = Object.freeze({
  // nest: digging, placement, growth, backfill
  'blocked:stone': 'Blocked by stone. Acid Excavation digs it.',
  'blocked:water': 'Water pocket in the way.',
  'blocked:chamber': 'Another chamber is in the way.',
  'blocked:disconnect': 'That would cut a chamber off from every entrance.',
  'blocked:route': 'No tunnel route reaches that spot.',
  'blocked:depth': 'Too deep for now.',
  'blocked:shaft': 'A shaft is in the way.',
  'blocked:backfill': 'Those cells are being backfilled.',
  'blocked:queued': 'Already queued for digging.',
  'blocked:layer': 'That layer is closed: ' + nameOr(RESEARCH, 'acid_excavation', 'Acid Excavation') + ' opens bedrock, '
    + nameOr(FEDERATION, 'aquifer_access', 'Aquifer Access') + ' the aquifer.',
  'blocked:royalRoom': 'Would wall in the Royal Chamber — level it to L' + ROYAL_LEVEL + ' first, or relocate.',
  'invalid:row': 'Not allowed at this depth.',
  'invalid:bounds': 'That does not fit inside the nest.',
  'invalid:root': 'It must touch a root.',
  'invalid:row0': 'It must touch the surface (the top row).',
  'invalid:shaft': 'It must sit right beside a shaft.',
  'invalid:water': 'It must touch a revealed water pocket that no other Well uses.',
  'invalid:route': 'Draw the tunnel as one line from your tunnels to the chamber.',
  'invalid:shaftCol': 'Shafts must be at least ' + SHAFT_GAP + ' columns apart.',
  'invalid:path': 'Draw the tunnel as one connected line.',
  'invalid:start': 'Start the tunnel from an open tunnel.',
  'invalid:empty': 'Nothing to dig there: it is already open.',
  'invalid:cell': 'Only tunnel cells can be backfilled.',
  'invalid:pending': 'Already being backfilled.',
  'invalid:dir': 'It cannot grow that way.',
  'invalid:rule': 'Placement rule not met.',
  // surface: claims, flags, trails, aphids, satellites
  'blocked:rival': 'A rival colony holds that hex.',
  'blocked:unowned': 'Satellites go on your own territory.',
  'blocked:terrain': 'Impassable terrain: pick another hex.',
  'blocked:entrance': 'Too close to an entrance: satellites need ' + SAT_MIN_DIST + '+ hexes from every entrance.',
  'invalid:fog': 'Unexplored: scouts must reveal it first.',
  'invalid:hidden': 'Unexplored: scouts must reveal it first.',
  'invalid:owned': 'Already your territory.',
  'invalid:adjacent': 'Claim hexes next to your territory.',
  'invalid:revealed': 'Already explored.',
  'invalid:origin': 'Trails start at an entrance.',
  'invalid:target': 'Draw the trail onto a food source.',
  'invalid:waypoints': 'Too many waypoints.',
  'invalid:job': 'This trail carries no workers.',
  'invalid:count': 'Not that many available.',
  'invalid:col': 'Pick a column inside the nest.',
  // war
  'blocked:immune': 'Immune to assault until you own ' + OLD_RIDGE_HEXES + ' hexes.',
  'blocked:unsighted': 'Not scouted yet: your scouts must find it first.',
  'blocked:truce': 'You have a truce with this colony.',
  'invalid:hex': 'Pick a border hex of that rival, next to your land.',
  'invalid:nest': 'Your garrison defends the nest on its own.',
  'invalid:kind': 'Not possible in this situation.',
  'requirements:garrison': 'Not enough soldiers in the garrison.',
  'requirements:soldiers': 'Not enough soldiers at home for that.',
  'requirements:ap': 'Your garrison is not strong enough for that.',
  'requirements:idle': 'Not enough idle workers: free some from their jobs.',
  // colony, jobs, research, seasons, prestige
  'invalid:garrison': 'Not that many in the garrison (ants out on the map are busy).',
  'invalid:total': 'Not enough workers for those jobs.',
  'invalid:sum': 'The shares add up to more than 100%.',
  'invalid:length': 'Season length must be ' + (YEAR.chronoMin % 60 === 0 && YEAR.chronoMax % 60 === 0
    ? YEAR.chronoMin / 60 + '–' + YEAR.chronoMax / 60 + ' minutes.' : fmtTime(YEAR.chronoMin) + '–' + fmtTime(YEAR.chronoMax) + '.'),
  'invalid:season': 'Unknown season.',
  'invalid:choice': 'That choice is not available.',
  'invalid:index': 'That option is no longer there.',
  'invalid:boon': 'That boon is not on offer.',
  'invalid:edict': 'That edict is not available.',
  'invalid:species': 'That species is not available.',
  'invalid:id': 'That option is not available.',
  'invalid:slot': 'That slot is not available.',
  'locked:prereq': 'Research its prerequisites first.',
  'locked:research': 'Needs research first.',
  'noSlot:trail': 'No free trail slot. Research or Mound levels add more.',
  'noSlot:housing': 'Not enough housing. Build or level Galleries.',
  'noSlot:berth': 'No free berth. Build Barracks.',
  'noSlot:instance': 'Instance limit reached for that chamber.',
  'cantAfford:pheromone': 'Not enough pheromone.',
  'cantAfford:honeydew': 'Not enough honeydew.',
  // core
  'invalid:value': 'That value is not allowed.',
  'invalid:key': 'Unknown setting.',
  'invalid:exception': 'Something went wrong with that action.',
});

/**
 * Command-specific text for reasons whose meaning depends on the command (a bare 'blocked' means a walled-in route
 * for drawTrail but "cannot demolish the Royal Chamber" for demolishChamber). Looked up before REASON_DETAILS.
 */
export const REASON_BY_COMMAND = Object.freeze({
  levelChamber: { blocked: 'No room to grow: relocate it or clear space around it.', busy: 'Finish digging before the next level.' },
  demolishChamber: { blocked: 'The Royal Chamber cannot be demolished.', busy: 'Wait until it finishes digging.' },
  relocateChamber: { invalid: 'Pick a new spot for it.', busy: 'Wait until it finishes digging.' },
  cancelJob: { blocked: 'Relocations and shafts cannot be cancelled.' },
  launchParty: { invalid: 'Send at least one soldier or supermajor.' },
  reinforce: { invalid: 'No soldiers at home to send.' },
  tournament: { invalid: 'Send at least one ant.' },
  backfill: { blocked: 'That would cut a chamber off from every entrance.', invalid: 'Drag over tunnel cells to backfill them.' },
  digTo: { blocked: 'Only plain soil can be dug.', invalid: 'That spot is already open.' },
  shiftJob: { 'invalid:empty': 'No ants in that job to move.' },
  clickForage: { invalid: 'This source cannot be hand-foraged.' },
  claimHex: { busy: 'Already claiming a hex: wait, or cancel that claim.' },
  drawTrail: { blocked: 'No walkable route: stone or water is in the way.', invalid: 'Drag the trail onto a food source.' },
  rerouteTrail: { blocked: 'No walkable route through those waypoints.' },
  moveAphids: { blocked: 'Aphids already live there.', invalid: 'Pick another hex for the aphids.',
    'invalid:owned': 'Aphids can only move onto your territory.', 'invalid:target': 'Needs a flower patch or leaf plant on your land.' },
  buyMound: { requirements: 'Higher Mound levels need ' + nameOr(RESEARCH, 'mound_building', 'Mound Building') + ' research.' },
  rearAlate: { requirements: 'Needs an active Nuptial Chamber.' },
  dispatchGuard: { 'invalid:nest': 'Your garrison defends the nest on its own.' },
  fly: { requirements: 'Flight requirements not met yet: see the checklist.' },
  supercolony: { requirements: 'Supercolony requirements not met yet: see the checklist.' },
  speciate: { requirements: 'Speciation requirements not met yet: see the checklist.' },
  startHardship: { requirements: 'Flight requirements not met yet: see the checklist.' },
  placeSatellite: { max: 'Every satellite is placed: more Satellite Nest levels add more.', locked: 'Needs Satellite Nest first.',
    'blocked:shaft': 'Too close to another shaft: keep ' + SAT_COL_GAP + ' columns apart.' },
});

/**
 * Player text for a reason code (with an optional ":detail"). With the command type, command-specific copy wins.
 * @param {string|null} reason
 * @param {string|null} [type] the command type that was refused, when known
 * @returns {string}
 */
export function reasonText(reason, type = null) {
  if (!reason) return '';
  const r = String(reason);
  const byCmd = type && Object.prototype.hasOwnProperty.call(REASON_BY_COMMAND, type) ? REASON_BY_COMMAND[type] : null;
  if (byCmd && byCmd[r]) return byCmd[r];
  if (REASON_DETAILS[r]) return REASON_DETAILS[r];
  const base = r.split(':')[0];
  if (byCmd && byCmd[base]) return byCmd[base];
  return REASONS[base] || REASONS.invalid;
}

// ---------------------------------------------------------------------------------------------------------------
// Tabs, seasons, bottlenecks, overlays
// ---------------------------------------------------------------------------------------------------------------

/** Tab labels. */
export const TAB_NAMES = Object.freeze({
  colony: 'Colony', build: 'Build', map: 'Map', research: 'Research', prestige: 'Prestige', achievements: 'Achievements', guide: 'Field Guide',
  stats: 'Stats', settings: 'Settings',
});

/** Tab tooltips (≤ 12 words; the key number is appended by the shell). */
export const TAB_TIPS = Object.freeze({
  colony: 'Brood, jobs and Adaptations.', build: 'Chambers, the dig queue and the Mound.', map: 'Trails, territory and rivals.',
  research: 'Spend insight on new abilities.', prestige: 'Nuptial Flight and the layers beyond.', achievements: 'Goals, rewards and cosmetics.',
  guide: 'What your colony has learned about the world.', stats: 'Records for this run and all time.', settings: 'Save, export, display and names.',
});

/** Prestige sub-tab labels. */
export const SUBTAB_NAMES = Object.freeze({
  flight: 'Flight', bloodline: 'Bloodline', hardships: 'Hardships', supercolony: 'Supercolony', federation: 'Federation', edicts: 'Edicts',
  speciation: 'Speciation', genome: 'Genome', species: 'Species', inspect: 'Inspect', war: 'War',
});

/** Season names. */
export const SEASON_NAMES = Object.freeze({ spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter', neutral: 'Autumn' });

/** One-line season effects (≤ 12 words). */
export const SEASON_TIPS = Object.freeze({
  spring: 'Lay ×1.25, brood faster. Puddles block hexes. Rainstorms.',
  summer: 'Forage ×1.3, flight weather. Rivals most aggressive.',
  autumn: 'Food cap ×1.25, seeds ×2. Stock up for winter.',
  winter: 'Forage low, dig ×1.3, insight ×1.5. No raids.',
});

/** Bottleneck badge labels (DESIGN §2.2). */
export const BOTTLENECK_NAMES = Object.freeze({
  bn_lay_rate: 'Lay rate', bn_brood_slots: 'Brood slots', bn_housing: 'Housing', bn_food_cap: 'Food cap', bn_food: 'Food',
  raid: 'Raid incoming', frost: 'Frost', hungry: 'Hungry',
});

/** What the bottleneck is doing (second half of the badge). */
export const BOTTLENECK_STATE = Object.freeze({
  bn_lay_rate: 'queen at full pace', bn_brood_slots: 'eggs blocked', bn_housing: 'eggs blocked', bn_food_cap: 'storage full',
  bn_food: 'eggs wait for food',
});

/** How to relieve each bottleneck (≤ 12 words). */
export const BOTTLENECK_TIPS = Object.freeze({
  bn_lay_rate: 'Level the Royal Chamber or buy Royal Feeding.',
  bn_brood_slots: 'Place or level Nurseries for more brood slots.',
  bn_housing: 'Place or level Galleries for more housing.',
  bn_food_cap: 'Level Granaries or raise repletes to store more food.',
  bn_food: 'More foragers, better trails, or Adaptations.',
  raid: 'Dispatch the garrison or escort the targeted trail.',
  frost: 'Nurseries below the frost line stay warm. Dig deeper.',
  hungry: 'Assign more foragers; laying stops while hungry.',
});

/** Overlay labels. */
export const OVERLAY_NAMES = Object.freeze({
  climate: 'Climate', raid_reach: 'Raid reach', haul: 'Haul', adjacency: 'Adjacency', territory: 'Territory', trail_strength: 'Trail strength',
  danger: 'Danger', richness: 'Richness',
});

/** Overlay tooltips (≤ 12 words). */
export const OVERLAY_TIPS = Object.freeze({
  climate: 'Season microclimate per layer and the projected frost line.',
  raid_reach: 'Red zone: storage and brood raiders can reach.',
  haul: 'Path distance to storage; shallow storage forages faster.',
  adjacency: 'Links between chambers and their bonuses or penalties.',
  territory: 'Owned hexes, borders and rival land.',
  trail_strength: 'Pheromone strength along every trail.',
  danger: 'Likely raid targets and predator hexes.',
  richness: 'Richness and capacity of each source.',
});

/** Overlays drawn in each view. */
export const OVERLAY_VIEW = Object.freeze({
  climate: 'below', raid_reach: 'below', haul: 'below', adjacency: 'below', territory: 'above', trail_strength: 'above', danger: 'above',
  richness: 'above',
});

// ---------------------------------------------------------------------------------------------------------------
// Tooltip copy per id (≤ 12 words)
// ---------------------------------------------------------------------------------------------------------------

/** Job tooltips. */
export const JOB_TIPS = Object.freeze({
  forager: 'Carries food home along trails.',
  digger: 'Digs tunnels and chambers; every unit of work yields soil.',
  nurse: 'Speeds brood development, up to four per brood slot.',
  scout: 'Explores the fog for insight; warns of raids.',
  herder: 'Milks aphid colonies for honeydew.',
  leafcutter: 'Cuts leaves for the fungus gardens.',
  gardener: 'Turns leaves into fungus in Fungus Gardens.',
  idle: 'Unassigned workers. They defend the nest as militia.',
});

/** Caste tooltips. */
export const CASTE_TIPS = Object.freeze({
  minor: 'Workers that take jobs. Housed in Galleries.',
  soldier: 'Garrison, escorts and war parties. Housed in Barracks.',
  supermajor: 'Giant defenders that shrug off home bonuses.',
  replete: 'Living honey pots: +2% food cap each.',
  alate: 'Winged princesses; each adds +2% flight alates.',
});

/** Chamber effect tooltips. */
export const CHAMBER_TIPS = Object.freeze({
  royal_chamber: 'Home of the queen. Levels raise lay rate ×1.15.',
  gallery: 'Room for 10 more ants per level.',
  nursery: '+3 brood slots. Next to the queen: brood +15%.',
  granary: 'Stores food. Shallow hauls faster; deep is safer.',
  scent_library: 'Produces insight. Deeper and royal-adjacent is better.',
  midden: 'Fewer diseases, +2% output. Keep away from nurseries.',
  barracks: '+8 berths for soldiers. Near an entrance: instant deploy.',
  root_aphid_pen: 'Passive honeydew. Must touch a root.',
  fungus_garden: 'Gardener slots and fungus storage. Best in clay.',
  repletion_hall: '+5 berths for repletes.',
  hibernaculum: 'Shelters brood from frost; cuts winter upkeep.',
  thermal_chimney: 'Softens the winter forage penalty. Touches the surface.',
  gate: 'Defenders fight harder at the shaft; less food stolen.',
  water_well: 'Drought immunity; boosts adjacent Fungus Gardens.',
  nuptial_chamber: 'Rears alates and opens a second entrance.',
  deep_vault: '+1 h offline cap and +5% flight alates per level.',
});

/** Adaptation effect tooltips. */
export const ADAPT_TIPS = Object.freeze({
  quick_dispatch: '+1 food per click.',
  strong_mandibles: 'Forager output +10% (additive).',
  royal_feeding: '+0.05 eggs per second base lay rate.',
  digging_claws: 'Dig +25% (additive).',
  potent_trails: 'Forager output ×1.12.',
  serrated_mandibles: 'Soldier and supermajor attack ×1.10.',
  thick_cuticle: 'Soldier and supermajor health ×1.10.',
  sweet_tooth: 'Honeydew ×1.15.',
  queens_feast: 'Lay rate ×1.25.',
  long_legs: 'Trails lose less to distance.',
});

/** Research effect tooltips. */
export const RESEARCH_TIPS = Object.freeze({
  trail_memory: 'Forager ×1.25 and +1 trail slot.',
  scent_marking: 'Unlocks pheromone, Mark, Mass Recruit and hex claims.',
  tandem_running: 'Trails reach further. Unlocks Long Legs.',
  recruitment_pheromones: 'Forager ×1.75. Unlocks Rally.',
  double_bridge: 'Trails find shortcuts and strengthen twice as fast.',
  persistent_trails: 'Trails fade half as fast; higher maximum strength.',
  sun_compass: 'Map radius 12 and +2 trail slots.',
  mass_recruitment: 'Longer reach, 60 s Rally and +2 trail slots.',
  frenzy_signal: 'Unlocks Frenzy.',
  trunk_trails: 'Long trails ×1.5 and count as territory.',
  odometer_navigation: 'Much longer reach; distant sources richer.',
  coordinated_digging: 'Dig ×1.5.',
  load_chains: 'Tunnels cost half the work; +2 queue slots.',
  clay_masonry: 'Clay is easier to dig.',
  mound_building: 'Mound levels 6 and above.',
  drainage: 'No floods; drought penalties halved.',
  ventilation_shafts: 'All chambers ×1.10; clay granaries stop spoiling.',
  thermoregulation: 'Frost line 5 rows shallower; no summer overheat.',
  gallery_arches: '+2 Galleries allowed; housing ×1.25.',
  acid_excavation: 'Dig bedrock and stones; dig ×2.',
  compact_galleries: 'Housing ×2.',
  brood_care: 'Brood develops 25% faster.',
  age_polyethism: 'Jobs assign themselves by preset ratios.',
  royal_pheromones: 'Lay rate ×1.5.',
  trophic_eggs: 'Eggs cost 30% less.',
  thermal_brood_shuttling: 'Brood moves to the warmest nurseries first.',
  nuptial_preparation: 'Nuptial Chamber and alate rearing. Required to fly.',
  response_thresholds: 'Automatic jobs follow the current bottleneck.',
  living_larders: 'Repletes and the Repletion Hall.',
  spermathecal_reserve: 'Lay rate ×2.',
  supermajors: 'Unlocks the supermajor caste.',
  aphid_husbandry: 'Herders, honeydew and Root Aphid Pens.',
  leafcutting: 'Unlocks the leafcutter job.',
  aphid_shepherding: 'Move aphid colonies; herder capacity ×2.',
  fungiculture: 'Fungus Gardens, gardeners, Nutrition and Fungal Brood.',
  lycaenid_clients: 'Lycaenid caterpillars appear for honeydew.',
  sugar_economy: 'Honeydew ×2.',
  weeder_ants: 'Blight far rarer; fungus ×1.5.',
  fungal_symbiosis: 'Nutrition bonus doubled.',
  polymorphism: 'Soldiers, Barracks and the caste slider.',
  formic_acid: 'Soldier attack ×1.3; cancels acid volleys.',
  ritual_tournaments: 'Win border hexes with displays, no deaths.',
  phalanx: 'Escorts ×1.5 power; retreats cost less.',
  field_triage: 'Some fallen soldiers return after battle.',
  propaganda_pheromones: 'Enemies weaker on assaults; some defect to you.',
  siege_tactics: 'Rival home bonus halved.',
  war_chemistry: 'All your army power ×2.',
  antennation: 'Scouts ×2 speed, more insight; flag hexes.',
  chemical_lexicon: 'Scent Library output ×1.5.',
  pheromone_glands: 'Pheromone cap +50 and regeneration ×1.5.',
  early_warning: 'Raid warnings 30 s longer; auto-guard toggle.',
  seasonal_clock: 'Season and weather forecast; milder winters.',
  overwintering: 'Hibernaculum; winter upkeep ×0.8.',
  weather_sense: 'Rain keeps trail strength; weather warnings.',
  collective_memory: 'Insight ×2; offline cap +2 h.',
  diapause_logic: 'Offline efficiency +25%; winter upkeep ×0.75.',
  hive_mind: 'Insight ×1.5, auto-Mark and saved job presets.',
});

/** Bloodline trait tooltips. */
export const TRAIT_TIPS = Object.freeze({
  founding_stores: 'Start every run with stored food and soil.',
  nanitic_vigor: 'First 25 eggs half price; first 50 workers ×3.',
  remembered_paths: 'Runs start with two trails at half strength.',
  ancestral_blueprint: 'Save a nest layout that auto-queues each run.',
  automaton_instincts: 'Automatic jobs, Adaptation autobuyer, +2 dig queue.',
  hardy_workers: 'Forage, herding and leafcutting ×1.4.',
  deep_diggers: 'Dig work ×1.4.',
  keen_antennae: 'Rings 0–4 revealed at start; scouts ×2.',
  fertile_queen: 'Lay rate ×1.25.',
  ancestral_memory: 'Research becomes Innate after 2 runs.',
  long_memory: '+2 h offline cap and +10% efficiency.',
  warrior_lineage: 'Soldier and supermajor attack and health ×1.25.',
  royal_court: '50 alate cells; Nuptial Chamber to level 9.',
  seasonal_wisdom: 'Choose the starting season; milder winters.',
  swarm_instinct: 'Insight ×1.5.',
  sweet_inheritance: 'A level-2 aphid colony nearby; honeydew ×2.',
  wide_wings: 'Flight alates ×1.15.',
  vast_galleries: 'Colony scale ×1.2.',
  brood_bank: 'Keep 10% of adults through a flight.',
  polygyny: 'Place a second Royal Chamber.',
  budding: 'Required for Supercolony. The Old Ridge appears ' + oldRidgeHint() + '.',
});

/**
 * When the Old Ridge Supercolony boss appears (systems/rivals.js spawnBosses: Budding owned AND alates this cycle ≥
 * BOSSES.old_ridge_supercolony.alatesCycle). Shared by the Budding tip and the Supercolony checklist (F19).
 * @returns {string} e.g. 'at 2.50K alates this cycle'
 */
export function oldRidgeHint() {
  const need = BOSSES && BOSSES.old_ridge_supercolony ? BOSSES.old_ridge_supercolony.alatesCycle : 2500;
  return 'at ' + fmtCount(need) + ' alates this cycle';
}

/** Federation tooltips. */
export const FED_TIPS = Object.freeze({
  automated_brood: 'Automatic jobs; last caste and job targets carry over.',
  blueprint_memory: 'Five blueprint slots; blueprint cells dig ×5.',
  autobuyers: 'Auto-buy Adaptations, chamber levels and Mound levels.',
  auto_flight: 'Fly automatically at your chosen trigger.',
  aquifer_access: 'Dig the aquifer, rows 74–79.',
  heirloom_bloodline: 'Keep three Bloodline traits through Supercolonies.',
  satellite_nest: 'A satellite entrance, trail slot and +25% food and dig.',
  regional_expansion: 'Map radius 16; up to four rivals.',
  megacolony_galleries: 'Colony scale ×2.',
  highway_network: 'Trails reach much further; satellites share the garrison.',
  diapause_mastery: 'Offline cap 24 h at full efficiency.',
  queens_council: 'Two more Royal Chambers.',
  megacolony: 'The Argentine Front appears. Required for Speciation.',
});

/** Genome tooltips. */
export const GENOME_TIPS = Object.freeze({
  genetic_memory: 'Innate research survives Speciation.',
  haplodiploid_fecundity: 'Lay rate ×2.',
  eusocial_leap: 'Each era starts with key Federation automation.',
  metapleural_glands: 'Immune to disease events.',
  venom_gland: 'Attack ×2.',
  species_leafcutter: 'Unlocks the Leafcutter species.',
  species_honeypot: 'Unlocks the Honeypot species.',
  species_fire_ant: 'Unlocks the Fire Ant species.',
  dreaming_hive: 'Offline cap 48 h at full efficiency.',
  golden_brood: '1% of hatches are golden workers ×10.',
  ancient_instinct: 'Insight ×10.',
  deep_time_automation: 'Supercolony automatically at your chosen trigger.',
  thermal_ceiling: 'Food and dig softcaps start far later.',
  chronobiology: 'Set season length and the starting season.',
  fossil_record: 'Each achievement gives ×1.02 instead of ×1.01.',
  colossal_nests: 'Colony scale ×10.',
  unicolonial_sprawl: 'Colony scale ×2. The long road to the end.',
  biomes: 'New landing sites: Forest Floor and Desert Dune.',
});

/** Hardship constraint and reward copy. */
export const HARDSHIP_TIPS = Object.freeze({
  eternal_winter: { rule: 'Always winter, hard frost, no mild year.', reward: 'Winter penalties −10% per tier.' },
  claustral_founding: { rule: 'No resource clicks and no Royal Feeding.', reward: 'Lay rate ×1.3 per tier.' },
  pacifist: { rule: 'No soldiers or supermajors.', reward: 'Rivals less aggressive; easier tournaments.' },
  barren_ground: { rule: 'All source yields halved.', reward: 'Distant sources richer per tier.' },
  shallow_soil: { rule: 'Nothing dug below row 23.', reward: 'All digging 5% easier per tier.' },
  monomorphic: { rule: 'Minors only; Adaptations capped at level 10.', reward: 'Worker output ×1.3 per tier.' },
});

/** Landing-site tag copy. */
export const SITE_TIPS = Object.freeze({
  site_rich_loam: 'Topsoil and loam dig 20% faster.',
  site_seed_meadow: '+2 seed patches; autumn seeds ×2.5.',
  site_aphid_dense: '+2 aphid colonies.',
  site_hostile_neighbours: 'Tougher rivals; conquest rewards ×1.5.',
  site_stony_ground: 'Twice the stones and twice the caches.',
  site_garden_path: 'More garden paths: fast trails, more footsteps.',
  site_wet_hollow: 'More water and puddles; fungus +20%.',
  site_sunny_slope: 'Warm topsoil nurseries in autumn; no overheat.',
});

/** Founding Boon copy. */
export const BOON_TIPS = Object.freeze({
  boon_next_to_aphids: 'An aphid colony two hexes away.',
  boon_rich_prey: 'Dead insects keep appearing nearby for 10 min.',
  boon_peaceful_start: 'No raids for the first 20 minutes.',
  boon_royal_vigor: 'Lay ×2 for the first 10 minutes.',
  boon_scouts_lead: 'Rings 0–3 revealed at start.',
  boon_old_trails: 'Your first two trails start at full strength.',
  boon_chitin_hoard: 'Start with a store of chitin.',
  boon_blueprint_rush: 'Blueprint digging ×2 for 10 minutes.',
  boon_long_spring: 'The first spring lasts 3 minutes longer.',
  boon_insight_cache: 'Start with a cache of insight.',
});

/** Royal Edict copy. */
export const EDICT_TIPS = Object.freeze({
  edict_of_plenty: 'Forage ×2; army power ×0.75.',
  edict_of_war: 'Army power ×2, conquest ×1.5; forage ×0.9.',
  edict_of_depth: 'Dig ×3; chamber costs halved.',
  edict_of_long_summer: 'No winter: spring, summer, summer, autumn.',
});

/** Species copy. */
export const SPECIES_TIPS = Object.freeze({
  garden_ant: 'Baseline colony. Signature: all production +10%.',
  leafcutter: 'Leaves ×2, food sources halved; fungus pays for eggs.',
  honeypot: 'Cheap, powerful repletes; milder winters; smaller food cap.',
  fire_ant: 'Two queens, venomous soldiers, rafts in rain.',
});

/** Unlock-condition hints shown on locked items (≤ 12 words). */
export const UNLOCK_HINTS = Object.freeze({
  panel_colony: 'Hatch your first worker.',
  adapt_basic: 'Hatch your first worker.',
  job_digger: 'Reach 3 adults.',
  adapt_digging_claws: 'Assign your first digger.',
  panel_build: 'Fill your housing for the first time.',
  chamber_gallery: 'Fill your housing for the first time.',
  chamber_granary: 'Earn 120 food or fill your food store.',
  chamber_nursery: 'Reach 8 adults.',
  job_scout: 'Reach 12 adults.',
  trail_slots: 'Saturate the crumb with foragers.',
  panel_research: 'Reveal your first hex.',
  royal_levelup: 'Reach 20 adults.',
  egg_reserve: 'Have eggs block a purchase.',
  chamber_scent_library: 'Reach 30 adults.',
  panel_achievements: 'Earn 3 achievements.',
  adapt_potent_trails: 'Reach 40 adults.',
  golden_beetle: 'Play 5 minutes of your first run.',
  res_chitin: 'Gain your first chitin.',
  chamber_midden: 'Reach 120 adults.',
  season_dial: 'Play 5:30 of your first run.',
  res_pheromone: 'Research Scent Marking.',
  ability_mark: 'Research Scent Marking.',
  hex_claim: 'Research Scent Marking.',
  mound: 'Hold 300 soil.',
  events: 'Keep playing your first run.',
  panel_war: 'Research Polymorphism.',
  caste_soldier: 'Research Polymorphism.',
  chamber_barracks: 'Research Polymorphism.',
  adapt_military: 'Research Polymorphism.',
  panel_rivals: 'Reveal a rival nest.',
  job_presets: 'Research Age Polyethism.',
  job_herder: 'Research Aphid Husbandry.',
  res_honeydew: 'Research Aphid Husbandry.',
  chamber_root_aphid_pen: 'Research Aphid Husbandry.',
  adapt_honeydew: 'Research Aphid Husbandry.',
  climate_overlay: 'Reach the first autumn.',
  panel_prestige: 'Earn 10M food in a run, or research Nuptial Preparation.',
  ability_rally: 'Research Recruitment Pheromones.',
  raid_warnings: 'A rival becomes able to raid you.',
  frost_line: 'Reach your first winter.',
  chamber_gate: 'Receive a raid warning, or play 25 minutes.',
  job_leafcutter: 'Research Leafcutting.',
  chamber_hibernaculum: 'Research Overwintering.',
  chamber_nuptial_chamber: 'Research Nuptial Preparation.',
  alate_rearing: 'Research Nuptial Preparation.',
  fungus_widget: 'Research Fungiculture.',
  chamber_fungus_garden: 'Research Fungiculture.',
  job_gardener: 'Research Fungiculture.',
  res_fungus: 'Research Fungiculture.',
  chamber_thermal_chimney: 'Research Ventilation Shafts.',
  chamber_repletion_hall: 'Research Living Larders.',
  caste_replete: 'Research Living Larders.',
  chamber_deep_vault: 'Research Acid Excavation.',
  chamber_water_well: 'Reveal a water pocket underground.',
  caste_supermajor: 'Research Supermajors.',
  adapt_long_legs: 'Research Tandem Running.',
  ability_frenzy: 'Research Frenzy Signal.',
  panel_map: 'Draw a second trail or claim a hex.',
  flight_button: 'Meet every Nuptial Flight requirement.',
  tab_bloodline: 'Complete your first Nuptial Flight.',
  tab_hardships: 'Earn 150 alates in total.',
  tab_federation_teaser: 'Earn 1,000 alates in total.',
  tab_federation: 'Form your first Supercolony.',
  tab_edicts: 'Form your first Supercolony.',
  tab_genome_teaser: 'Earn 20 kinship.',
  tab_genome: 'Complete your first Speciation.',
});

/** Label of an unlock key (the UNLOCKS def label, else a humanized key). */
export function unlockLabel(key) {
  if (Array.isArray(UNLOCKS)) {
    for (const def of UNLOCKS) if (def && def.key === key && typeof def.label === 'string' && def.label) return def.label;
  }
  const k = String(key || '');
  for (const p of ['panel_', 'chamber_', 'job_', 'adapt_', 'res_', 'caste_', 'tab_', 'ability_']) {
    if (k.startsWith(p)) return humanize(k.slice(p.length));
  }
  return humanize(k);
}

/** Condition hint for an unlock key. */
export function unlockHint(key) {
  return UNLOCK_HINTS[key] || 'Keep growing your colony.';
}

// ---------------------------------------------------------------------------------------------------------------
// Events (DESIGN §18.2): card copy, choices
// ---------------------------------------------------------------------------------------------------------------

/** Short event descriptions (card body / toast). */
export const EVENT_COPY = Object.freeze({
  ev_fallen_fruit: 'A fruit thuds onto the map. Trail to it before it rots!',
  ev_picnic_spill: 'A picnic blanket! Rich food, contested by rivals.',
  ev_termite_swarm: 'Winged termites swarm nearby. Mass Recruit for a feast.',
  ev_seed_mast_year: 'A seed mast year: seed patches ×3 this season.',
  ev_pheromone_bloom: 'The Scent Library glows: insight ×2 for 90 s.',
  ev_lost_scout_returns: 'A lost scout returns with maps and insight.',
  ev_queens_vigor: 'The queen glows with vigor: lay ×3 for 60 s.',
  ev_rival_mating_flight: 'Rival alates fill the sky: rivals weakened. Attack now!',
  ev_rival_queen_dies: 'A rival queen has died; that nest is weakened.',
  ev_flight_day: 'Warm still air: perfect flight weather for 3 min.',
  ev_golden_aphid: 'A golden aphid! Click it within 15 s.',
  ev_mole_tunnel: 'A mole tunnels through: free tunnels below.',
  ev_wandering_queen: 'A strange queen waits at the entrance.',
  ev_myrmecophile_guest: 'A rove beetle begs at the shaft.',
  ev_phengaris_caterpillar: 'A caterpillar that smells like your brood.',
  ev_rainstorm: 'A rainstorm rolls in. Seal the entrance?',
  ev_drought: 'Drought: plants wither, aphids sweeten.',
  ev_mold_bloom: 'Grey mold spreads in the chambers. Scrape it off!',
  ev_ophiocordyceps: 'A zombie fungus has infected a forager.',
  ev_ladybug_raid: 'Ladybugs swarm an aphid colony!',
  ev_antlion_pit: 'An antlion pit opens on a trail.',
  ev_horned_lizard: 'A horned lizard sits on a trail.',
  ev_footstep: 'A shoe shadow looms! Click it to scatter.',
  ev_brood_mites: 'Mites infest the brood: brood time ×1.5.',
  ev_phorid_flies: 'Phorid flies hunt soldiers and foragers.',
  ev_fungal_blight: 'Blight greys the fungus garden!',
  ev_army_ant_column: 'An army ant column is crossing your land!',
  ev_frost_snap: 'A frost snap creeps over the top rows.',
});

/** Choice button labels. */
export const CHOICE_LABELS = Object.freeze({
  adopt: 'Adopt', devour: 'Devour', accept: 'Accept', expel: 'Expel', reject: 'Reject', seal: 'Seal entrance', keep: 'Keep foraging',
  quarantine: 'Quarantine', ignore: 'Ignore', send: 'Send soldiers', wait: 'Wait', reroute: 'Reroute', mob: 'Mob it', evacuate: 'Evacuate trails',
  fight: 'Fight', clean: 'Clean it',
});

/** What each choice does, per event (≤ 12 words). */
export const CHOICE_TIPS = Object.freeze({
  ev_wandering_queen: { adopt: 'Lay ×2 for 10 min, but she may be a parasite.', devour: 'Gain food now.' },
  ev_myrmecophile_guest: { accept: '+15% food for 10 min; it may eat brood.', expel: 'Gain some chitin.' },
  ev_phengaris_caterpillar: { adopt: 'A gamble: insight if it survives, losses if not.', reject: 'Nothing happens.' },
  ev_rainstorm: { seal: 'No foraging for 60 s, no flood.', keep: 'Keep foraging; topsoil chambers may flood.' },
  ev_ophiocordyceps: { quarantine: 'Foragers −20% for 2 min; outbreak ends.', ignore: 'Infection spreads; infected ants die.' },
  ev_ladybug_raid: { send: 'Five garrison soldiers chase them off.', wait: 'That aphid colony yields half for 5 min.' },
  ev_antlion_pit: { send: 'Three garrison soldiers clear the pit.', wait: 'The trail keeps losing workers until rerouted.' },
  ev_horned_lizard: { reroute: 'Reroute the trail around it, free.', mob: 'Drive it off and gain food.', ignore: 'The trail loses workers.' },
  ev_fungal_blight: { quarantine: 'Lose 30% of your fungus.', clean: 'Click the garden 20 times within 15 s.' },
  ev_army_ant_column: { evacuate: 'No foraging for 60 s, lose 5% food.', fight: 'Battle the column for huge loot.' },
});

// ---------------------------------------------------------------------------------------------------------------
// Misc labels
// ---------------------------------------------------------------------------------------------------------------

/** Dig job kinds. */
export const DIG_KIND_NAMES = Object.freeze({ tunnel: 'Tunnel', chamber: 'Dig', grow: 'Enlarge', shaft: 'Shaft', relocate: 'Relocate' });
/** War party kinds. */
export const PARTY_NAMES = Object.freeze({ raid: 'Raid', assault: 'Assault', hunt: 'Hunt', termite: 'Termite raid', guard: 'Guard', reinforce: 'Reinforcements' });
/** Battle kinds. */
export const BATTLE_NAMES = Object.freeze({
  raid: 'Raid', assault: 'Assault', hunt: 'Hunt', termite: 'Termite raid', trail: 'Trail defence', border: 'Border fight', gate: 'Gate fight',
  army: 'Army ants', escalate: 'Escalated tournament',
});
/** Raid phases. */
export const RAID_PHASES = Object.freeze({ warning: 'Incoming', trail: 'Trail fight', border: 'Border fight', gate: 'Gate fight', done: 'Over' });
/** War action tooltips. */
export const WAR_TIPS = Object.freeze({
  raid: 'Hit 40% of defenders, no home bonus. Food and chitin.',
  assault: 'Fight every defender. Victory conquers the nest.',
  hunt: 'Hunt the prey for food and chitin.',
  termite: 'Raid the termite mound for a big payout.',
  tournament: 'A bloodless display contest for a border hex.',
  bribe: 'Pay honeydew for a 5-minute truce.',
});
/** Battle tactics tooltips. */
export const TACTIC_TIPS = Object.freeze({
  alarm_rally: '+30% attack for 8 s.',
  mobilize: 'Idle and forager minors join as militia for 20 s.',
  retreat: 'Pull back now; costs some survivors.',
  reinforce: 'Send more garrison units into the fight.',
});
/** Golden pupa choices. */
export const PUPA_CHOICES = Object.freeze({
  frenzy: { label: 'Forage Frenzy', tip: 'Forage ×5 for 60 seconds.' },
  windfall: { label: 'Windfall', tip: 'Ten minutes of food at once.' },
});
/** Golden beetle rolls. */
export const BEETLE_ROLLS = Object.freeze({
  windfall: 'Windfall: ten minutes of food!', frenzy: 'Forage Frenzy: forage ×5 for 60 s!', lay_burst: 'Lay Burst: lay ×3 for 30 s!',
  discovery: 'Discovery: a burst of insight!',
});

/** Import error messages (save codec error codes, ARCHITECTURE §7.13). */
export const IMPORT_ERRORS = Object.freeze({
  badPrefix: 'That is not a Six Legs Deep save. It should start with "SLD1:".',
  badBase64: 'The save text is damaged (it contains invalid characters).',
  badChecksum: 'The save text is damaged or incomplete (checksum mismatch).',
  badJson: 'The save text is damaged (unreadable data).',
  tooNew: 'This save comes from a newer version of the game.',
  migrationFailed: 'This save could not be upgraded to the current version.',
  invalidState: 'This save is missing parts of the colony.',
});

/** Player text for an import error code. */
export function importErrorText(code) {
  return IMPORT_ERRORS[code] || 'The save could not be read.';
}

/** Cosmetic slot from a cosmetic id (ARCH-R: slot names are not pinned by the contract). */
export function cosmeticSlot(id) {
  const k = String(id || '');
  if (k.includes('palette')) return 'palette';
  if (k.includes('mound')) return 'mound';
  if (k.includes('flag')) return 'flag';
  if (k.includes('trail')) return 'trail';
  if (k.includes('crown') || k.includes('queen')) return 'crown';
  if (k.includes('pet') || k.includes('ladybug')) return 'pet';
  if (k.includes('cursor') || k.includes('wing')) return 'cursor';
  return 'misc';
}

/** Cosmetic slot labels. */
export const COSMETIC_SLOTS = Object.freeze({
  palette: 'Palette', mound: 'Mound skin', flag: 'Flag', trail: 'Trail colour', crown: 'Crown', pet: 'Pet', cursor: 'Cursor', misc: 'Other',
});

// ---------------------------------------------------------------------------------------------------------------
// Event → toast copy (ARCHITECTURE §10)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Toast for a bus event, or null when the event should not toast. priority 'high' toasts queue under the rate
 * limit; 'low' ones are dropped.
 * @param {Object} e event { type, ...payload }
 * @param {Object} [s] current state (for names)
 * @returns {{ text: string, kind: string, priority: 'high'|'low' } | null}
 */
export function eventToast(e, s = null) {
  if (!e || typeof e.type !== 'string') return null;
  // Sub-types travel as chamberType / rivalType (ARCHITECTURE §10); without them the name is looked up by uid.
  const rivalName = (uid, type = null) => {
    if (typeof type === 'string') return nameOf('rival', type);
    const list = s && s.run && s.run.rivals && Array.isArray(s.run.rivals.list) ? s.run.rivals.list : [];
    const r = list.find((x) => x && x.uid === uid);
    return r ? nameOf('rival', r.type) : 'A rival';
  };
  const chamberName = (uid, type = null) => {
    if (typeof type === 'string') return nameOf('chamber', type);
    const list = s && s.run && s.run.nest && Array.isArray(s.run.nest.chambers) ? s.run.nest.chambers : [];
    const c = list.find((x) => x && x.uid === uid);
    return c ? nameOf('chamber', c.type) : 'Chamber';
  };
  switch (e.type) {
    case 'achievement': return { text: 'Achievement: ' + nameOf('achievement', e.id), kind: 'achievement', priority: 'high' };
    case 'fieldGuide': return { text: 'Field Guide: ' + nameOf('guide', e.id), kind: 'guide', priority: 'high' };
    case 'unlock': return { text: 'New: ' + unlockLabel(e.key), kind: 'unlock', priority: 'high' };
    case 'raidWarning': {
      const tgt = e.target && e.target.type === 'trail' ? 'a trail' : 'the nest';
      return { text: rivalName(e.rival) + ' raid ' + tgt + ' in ' + fmtTime(e.warn || 0) + '!', kind: 'danger', priority: 'high' };
    }
    case 'raidResult':
      if (e.win) return { text: 'Raid repelled!', kind: 'good', priority: 'high' };
      return {
        text: 'Raid lost: ' + fmt(e.foodLost || 0) + ' food, ' + fmtCount(e.broodLost || 0) + ' brood, ' + fmtCount(e.workersLost || 0) + ' workers.',
        kind: 'danger', priority: 'high',
      };
    case 'conquest': return { text: 'Conquered: ' + rivalName(e.uid, e.rivalType) + '!', kind: 'good', priority: 'high' };
    case 'battleEnd':
      return { text: (BATTLE_NAMES[e.kind] || 'Battle') + (e.win ? ' won.' : ' lost.'), kind: e.win ? 'good' : 'bad', priority: 'low' };
    case 'hungryStart': return { text: 'Hungry! Laying stopped. Assign more foragers.', kind: 'danger', priority: 'high' };
    case 'hungryEnd': return { text: 'The colony is fed again.', kind: 'good', priority: 'low' };
    case 'winterSoon': return { text: 'Winter in ' + fmtTime(Number(YEAR && YEAR.forecastSec) || 60) + ': shallow brood will freeze.', kind: 'info', priority: 'high' };
    case 'seasonChanged': return { text: (SEASON_NAMES[e.id] || humanize(e.id)) + ': ' + (SEASON_TIPS[e.id] || ''), kind: 'season', priority: 'low' };
    case 'chamberActivated': return { text: chamberName(e.uid, e.chamberType) + ' complete.', kind: 'good', priority: 'low' };
    case 'cacheFound': return { text: 'Found a ' + humanize(e.kind) + ': +' + fmt(e.amount || 0) + ' ' + (RES_NAMES[e.res] || '').toLowerCase() + '.', kind: 'good', priority: 'low' };
    case 'softcapHit': return { text: (RES_NAMES[e.stat] || humanize(e.stat)) + ' production is now softcapped.', kind: 'info', priority: 'low' };
    case 'beetleClaimed': return { text: BEETLE_ROLLS[e.roll] || 'Golden Beetle claimed!', kind: 'gold', priority: 'high' };
    case 'beetleSpawned': return { text: 'A Golden Beetle scuttles across the map!', kind: 'gold', priority: 'low' };
    case 'pupaSpawned': return { text: 'A golden pupa glows in the nest! Click it.', kind: 'gold', priority: 'low' };
    case 'hardshipTier': return { text: nameOf('hardship', e.id) + ': tier ' + e.tier + ' reached!', kind: 'achievement', priority: 'high' };
    case 'entranceOpened': return { text: 'A new entrance opens to the surface.', kind: 'good', priority: 'low' };
    case 'rivalSighted': return { text: rivalName(e.uid, e.rivalType) + ' spotted!', kind: 'danger', priority: 'low' };
    case 'adultsDied':
      if (e.cause === 'battle') return null;
      return { text: fmtCount(e.n || 0) + ' ' + (nameOf('caste', e.caste) || 'ants').toLowerCase() + ' lost (' + humanize(e.cause || '') + ').', kind: 'bad', priority: 'low' };
    case 'broodDied': return { text: fmtCount(e.n || 0) + ' brood lost (' + humanize(e.cause || '') + ').', kind: 'bad', priority: 'low' };
    case 'storageError': return { text: 'Saving unavailable: use Export.', kind: 'danger', priority: 'high' };
    case 'flightComplete': return { text: 'Nuptial Flight! ' + fmtCount(e.alates || 0) + ' alates take wing.', kind: 'gold', priority: 'high' };
    case 'supercolonyComplete': return { text: 'Supercolony formed: +' + fmtCount(e.kinship || 0) + ' kinship.', kind: 'gold', priority: 'high' };
    case 'speciationComplete': return { text: 'Speciation: +' + fmtCount(e.genes || 0) + ' genes.', kind: 'gold', priority: 'high' };
    case 'giftOpened': return { text: 'A Saved Find opens!', kind: 'gold', priority: 'low' };
    case 'commandRejected': return { text: reasonText(e.reason, e.cmd && e.cmd.type), kind: 'bad', priority: 'low' };
    default: return null;
  }
}

/** Number of words in a string (tooltip rule). */
export function wordCount(str) {
  return String(str).trim().split(/\s+/).filter(Boolean).length;
}
