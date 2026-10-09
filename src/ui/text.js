// Player-facing copy: labels, reason messages, event/toast copy, tooltip copy (≤ 12 words each, DESIGN §25.6 rule 4),
// unlock condition hints and import errors. Owner: WP9. Contract: ARCHITECTURE §14 (text.js), §7.4 reason codes,
// §10 events. Pure module (no DOM). Display names come from the data tables' `name` fields when present; the
// fallbacks below keep the UI readable while a data table is still empty.

import { CHAMBERS, ADJACENCY, ADJACENCY_ORDER, CHAMBER_RULES } from '../data/chambers.js';
import { RESEARCH, BRANCHES } from '../data/research.js';
import { ADAPTATIONS } from '../data/adaptations.js';
import { COSMETICS, COSMETIC_SLOT_NAMES } from '../data/cosmetics.js';
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
import { HARDSHIPS, SITES, BOONS, EDICTS, FLIGHT, AUTO_FLIGHT } from '../data/prestige.js';
import { UNLOCKS } from '../data/unlocks.js';
import { LAYERS, GEOM } from '../data/strata.js';
import { TERRAIN, TRAIL, TERRITORY } from '../data/surface.js';
import { ACTIONS, REWARDS, RAIDS } from '../data/combat.js';
import { CAPS } from '../data/economy.js';
import { YEAR, SEASON_MODS } from '../data/seasons.js';
import { DRAINAGE } from '../data/soilFeatures.js';
import { fmt, fmtTime, fmtCount, fmtRate, fmtPct, fmtMult } from './format.js';
import { ringOf } from '../core/hex.js';   // C184 source tooltips

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
    midden: 'Midden', barracks: 'Barracks', war_hall: 'War Hall', carapace_store: 'Carapace Store', carapace_workshop: 'Carapace Workshop', root_aphid_pen: 'Root Aphid Pen', fungus_garden: 'Fungus Garden', repletion_hall: 'Repletion Hall',
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
  insight: 'Earned by scouting and Scent Libraries. Spent on research.',
  pheromone: 'Regenerates over time. Fuels Mark, Rally, Frenzy and claims.',
  chitin: 'From insects, hunts, battles, moults and Middens. Soldiers need it. Capped.',
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

/**
 * Toast for a blueprintDropped event (C106; C119 notes): a dropped spot, the Royal Chamber moved to (or kept off) its
 * planned spot, a Water Well moved next to this run's water, or dropped because no pocket has room.
 * @param {{ chamberType?: string, reason?: string }} e
 * @returns {{ text: string, kind: string, priority: string }}
 */
export function blueprintNote(e) {
  const r = String((e && e.reason) || '');
  if (r === 'royal:moved') return { text: 'Blueprint: the Royal Chamber is dug at its planned spot.', kind: 'good', priority: 'low' };
  if (r.startsWith('royal:kept')) {
    const why = r.slice('royal:kept:'.length);
    const detail = why ? reasonText(why, 'placeChamber').replace(/\.$/, '') : '';
    return { text: 'Blueprint: the Royal Chamber stays at the usual spot' + (detail ? ' (planned spot: ' + detail.charAt(0).toLowerCase() + detail.slice(1) + ')' : '') + '.',
      kind: 'info', priority: 'high' };
  }
  if (r === 'well:moved') return { text: 'Blueprint: the Water Well goes next to this run\'s water pocket.', kind: 'info', priority: 'low' };
  if (r === 'well:none') return { text: 'Blueprint: no water pocket on this soil has room for the Water Well, so it is left out.', kind: 'info', priority: 'high' };
  // C158: Bloodline traits Deep Spring and Root Memory
  if (r === 'well:spring') return { text: 'Deep Spring: a spring wells up beside the Water Well\'s planned spot.', kind: 'good', priority: 'low' };
  if (r === 'root:memory') return { text: 'Root Memory: a root grows down to the planned ' + nameOf('chamber', e && e.chamberType) + '.', kind: 'good', priority: 'low' };
  // C177: a paid cultivated root for a planned Root Aphid Pen
  if (r === 'root:cultivated') return { text: 'Blueprint: a cultivated root grows down to the planned ' + nameOf('chamber', e && e.chamberType) + '.', kind: 'good', priority: 'low' };
  return { text: 'Blueprint: the ' + nameOf('chamber', e && e.chamberType) + ' spot can no longer be used.', kind: 'info', priority: 'low' };
}

/**
 * C173: toast for a waterStruck event: a placement (or a dig) hit a water pocket nobody had found. The pocket now shows
 * and the placement was not made.
 * @param {{ chamberType?: string }} e
 * @returns {{ text: string, kind: string, priority: string }}
 */
export function waterStruckText(e) {
  const t = e && typeof e.chamberType === 'string' ? e.chamberType : '';
  return { text: 'You struck water! A hidden water pocket is in the way' + (t ? ' of the ' + nameOf('chamber', t) : '')
    + '. It shows now: pick another spot.', kind: 'info', priority: 'high' };
}

/** C175: words for why a blueprint chamber moved (blueprintAdjusted reason). */
export const ADJUST_REASONS = Object.freeze({
  water: 'water was in its planned spot',
  'water:struck': 'it struck hidden water',
  'well:moved': 'it goes next to this run\'s water',
  'well:spring': 'Deep Spring welled up a spring for it',
  'water:moved': 'a water pocket is being moved next to it',
  'nuptial:moved': 'its planned spot had no route for an exit shaft',
  'root:memory': 'Root Memory grows a root to it',
  'root:cultivated': 'a cultivated root grows to it',
});

/**
 * C175: event-log line for a blueprintAdjusted event ("Blueprint: Gallery moved 2 cells (water was in its planned spot).").
 * @param {{ chamberType?: string, from?: { x: number, y: number }, to?: { x: number, y: number }, reason?: string }} e
 * @returns {{ text: string, kind: string, priority: string }}
 */
export function blueprintAdjustedText(e) {
  const name = nameOf('chamber', e && e.chamberType);
  const f = (e && e.from) || {};
  const t = (e && e.to) || {};
  const dist = Math.abs(num0(t.x, 0) - num0(f.x, 0)) + Math.abs(num0(t.y, 0) - num0(f.y, 0));
  const why = ADJUST_REASONS[e && e.reason] || 'its planned spot could not be used';
  const r = String((e && e.reason) || '');
  if (r === 'water:moved') return { text: 'Blueprint: a water pocket is moved next to the planned ' + name + '.', kind: 'info', priority: 'low' };
  if (r.startsWith('root:') || r === 'well:spring' || dist === 0) return { text: 'Blueprint: ' + name + ' — ' + why + '.', kind: 'info', priority: 'low' };
  return { text: 'Blueprint: ' + name + ' moved ' + fmtCount(dist) + ' cell' + (dist === 1 ? '' : 's') + ' (' + why + ').', kind: 'info', priority: 'low' };
}

/** Player text for known "code:detail" reasons (every detail a system validator can return; ARCHITECTURE §7.4). */
export const REASON_DETAILS = Object.freeze({
  // nest: digging, placement, growth, backfill
  'blocked:stone': 'Blocked by stone. Acid Excavation digs it.',
  'blocked:water': 'Water pocket in the way.',
  'water:struck': 'You struck a hidden water pocket there.',
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
  // C137: full-size reservations (C154: drawn as fresh-dug works around each chamber)
  'blocked:reserved': 'Reserved: another chamber will grow into this space.',
  'resv:chamber': 'Its full-size room would overlap another chamber. Press F to try another corner.',
  'resv:reserved': 'Its full-size room would overlap another chamber\'s reserved space. Press F to try another corner.',
  'resv:bounds': 'Its full-size room does not fit inside the nest here. Press F to try another corner.',
  'resv:row': 'Its full-size room would break its depth rule. Press F to try another corner.',
  'resv:hardship': 'Its full-size room would go deeper than this Hardship allows.',
  'resv:shaft': 'Its full-size room would cover a shaft entrance. Press F to try another corner.',
  'invalid:anchor': 'Pick one of the four corners.',
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
  // C117: moving a water pocket
  'blocked:open': 'Water can only move into plain soil or tunnels that can be filled in.',
  'blocked:cache': 'Something is buried there: dig it up first.',
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
  duplicate: 'A trail already goes there. Add workers to it instead.',
  'invalid:waypoints': 'Too many waypoints.',
  'invalid:job': 'This trail carries no workers.',
  'invalid:count': 'Not that many available.',
  'invalid:col': 'Pick a column inside the nest.',
  // war
  'blocked:immune': 'Immune to assault until you own ' + OLD_RIDGE_HEXES + ' hexes.',
  'blocked:unsighted': 'Not scouted yet: your scouts must find it first.',
  'blocked:truce': 'You have a truce with this colony: wait until it ends.',
  'confirm:truce': 'You have a truce with this colony: attacking breaks it (confirm first).',   // C247
  'invalid:hex': 'Pick a border hex of that rival, next to your land.',
  'invalid:nest': 'Your garrison defends the nest on its own.',
  'invalid:kind': 'Not possible in this situation.',
  'requirements:garrison': 'Not enough soldiers in the garrison.',
  'requirements:soldiers': 'Not enough soldiers at home for that.',
  'requirements:ap': 'Your garrison is not strong enough for that.',
  'requirements:idle': 'Not enough workers: tournaments use idle workers first, then foragers.',
  // colony, jobs, research, seasons, prestige
  'invalid:garrison': 'Not that many in the garrison (ants out on the map are busy).',
  'invalid:total': 'Not enough workers for those jobs.',
  'requirements:garden': 'Leafcutters need a Fungus Garden first: without one the leaves they bring home are wasted.',   // C238
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
  'noSlot:berth': 'No free berth. Barracks house soldiers, War Halls supermajors.',
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
  cancelJob: { blocked: 'Relocations, shafts and pocket moves cannot be cancelled.' },
  // C117–C121
  cancelPlanned: { notFound: 'That planned chamber is gone.', invalid: 'Pick a planned chamber.' },
  backfillUnneeded: { 'invalid:empty': 'No unneeded tunnels: every tunnel keeps something connected.' },
  // C253 / C258
  clearBlueprint: { notFound: 'No blueprint is active.' },
  drainPocket: { locked: 'Needs ' + nameOr(RESEARCH, 'drainage', 'Drainage') + ' research.', busy: 'Already being drained or moved.',
    notFound: 'Pick a revealed water pocket.', 'blocked:route': 'No tunnel route reaches that pocket.' },
  relocatePocket: { locked: 'Needs ' + nameOr(RESEARCH, 'drainage', 'Drainage') + ' research.', busy: 'Already being drained or moved.',
    notFound: 'Pick a revealed water pocket.', 'invalid:row': 'A pocket cannot sit in the top row.', // C255: no distance limit
    'blocked:royalRoom': 'That would wall in the Royal Chamber.' },
  growRoot: { locked: 'Needs ' + nameOr(RESEARCH, 'root_cultivation', 'Root Cultivation') + ' research.',
    max: 'Root limit reached: higher Mound levels allow more.', 'invalid:root': 'A root already grows in that column.',
    'blocked:shaft': 'A shaft runs down that column.', blocked: 'Something blocks the top of that column.' },
  launchParty: { invalid: 'Send at least one soldier or supermajor.' },
  massRecruit: { requirements: 'Draw a trail to it first.', cantAfford: 'Not enough pheromone.', invalid: 'Only for a termite swarm or picnic spill.' },   // C250
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
  rearAlate: { requirements: 'Needs an active Nuptial Chamber.' },
  dispatchGuard: { 'invalid:nest': 'Your garrison defends the nest on its own.' },
  // C185
  clearAntlion: { 'requirements:soldiers': 'Clearing the pit needs ' + ((EVENTS.ev_antlion_pit && EVENTS.ev_antlion_pit.num.soldiers) || 3)
    + ' soldiers at home (garrison).', notFound: 'The antlion pit is gone.' },
  assignEscorts: { 'invalid:count': 'No soldiers at home to send as escorts.',
    max: 'A Lycaenid trail needs exactly 5 escorts: more add nothing.' },   // C236
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

/**
 * C126: "Waiting: …" copy per waiting code of a pending blueprint chamber (nest.plannedWaits) that needs no numbers.
 * Codes not listed fall back to REASON_DETAILS / REASONS ("Waiting: " + that text, first letter lowered).
 */
export const WAIT_TEXT = Object.freeze({
  'blocked:stone': 'stone in the way — needs ' + nameOr(RESEARCH, 'acid_excavation', 'Acid Excavation'),
  'blocked:royalRoom': 'would wall in the Royal Chamber (level it to L' + ROYAL_LEVEL + ' first)',
  'blocked:queued': 'cells still being dug',
  'blocked:backfill': 'cells still being backfilled',
  'blocked:layer': 'that layer is still closed (' + nameOr(RESEARCH, 'acid_excavation', 'Acid Excavation') + ' opens bedrock, '
    + nameOr(FEDERATION, 'aquifer_access', 'Aquifer Access') + ' the aquifer)',
  'blocked:shaft': 'a shaft entrance is in the way (the top two rows of a shaft stay open)',
  'blocked:water': 'a water pocket is in the way',
  'blocked:chamber': 'another chamber is in the way',
  'blocked:route': 'no tunnel route reaches it yet',
  'invalid:water': 'needs a revealed water pocket that no other Well uses',
  'wait:water': 'a revealed water pocket with room (dig near water to reveal one)',
  'wait:path': 'no access tunnel can reach it yet (stone, water or a reserved space in the way)',
  'wait:access': 'digging access tunnel',
  // C158: Bloodline traits; C177: a root for a planned Root Aphid Pen
  'wait:root': 'Root Memory is growing a root down to it',
  'wait:rootGrow': 'a cultivated root is growing down to it',
  'wait:rootResearch': 'no root to touch — research ' + nameOr(RESEARCH, 'root_cultivation', 'Root Cultivation') + ' to grow one to it',
  'wait:rootCap': 'no root to touch, and the cultivated-root limit is reached',
  'wait:rootCost': 'no root to touch — saving up to grow one (Build → Cultivated roots)',
  'wait:rootPath': 'no root to touch, and stone, water or a shaft blocks every column a root could grow down',
  // C173 / C176: water
  'water:struck': 'struck a hidden water pocket — finding a new spot',
  'wait:waterMove': 'a water pocket is being moved next to it',
  'wait:spring': 'Deep Spring wells up a spring at its spot on the next check',
  'blocked:reserved': 'another chamber will grow into that space',
  'wait:next': 'queues on the next check',
  hardship: 'not allowed in this Hardship',
  queueFull: 'the dig queue is full',
});

/**
 * C126: player text for why a pending blueprint chamber still waits ("Waiting: 2.1K food (blueprint half price)").
 * @param {{ type: string, code: string, detail?: Object|null }|null} w an entry of nest.plannedWaits
 * @returns {string}
 */
export function plannedWaitText(w) {
  if (!w || !w.code) return '';
  const lc = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);
  const strip = (t) => String(t || '').replace(/[.]+$/, '');
  const det = w.detail || {};
  const name = nameOf('chamber', w.type);
  let body;
  if (w.code === 'locked') body = 'locked — unlocks: ' + lc(strip(unlockHint(det.key || 'chamber_' + w.type)));
  else if (w.code === 'max') body = name + ' limit reached (' + fmtCount(num0(det.n, 0)) + '/' + fmtCount(num0(det.max, 0)) + ')';
  else if (w.code === 'cantAfford') {
    const cost = det.cost && typeof det.cost === 'object' ? det.cost : {};
    const parts = Object.keys(cost).filter((r) => num0(cost[r], 0) > 0).map((r) => fmt(cost[r]) + ' ' + nameOf('res', r).toLowerCase());
    body = (parts.length ? parts.join(' + ') : 'resources') + ' (blueprint half price)';
  } else if (w.code === 'blocked:shaft' && CHAMBERS[w.type] && CHAMBERS[w.type].rule === 'nuptialShaft') {
    body = 'no free column for its own exit shaft yet';
  } else if (WAIT_TEXT[w.code]) body = WAIT_TEXT[w.code];
  else body = lc(strip(reasonText(w.code)));
  return 'Waiting: ' + body;
}

// ---------------------------------------------------------------------------------------------------------------
// Tabs, seasons, bottlenecks, overlays
// ---------------------------------------------------------------------------------------------------------------

/** Tab labels. */
export const TAB_NAMES = Object.freeze({
  colony: 'Colony', build: 'Build', map: 'Map', adaptations: 'Adaptations', research: 'Research', prestige: 'Prestige', achievements: 'Achievements',
  guide: 'Field Guide', stats: 'Stats', settings: 'Settings',
});

/** Tab tooltips (≤ 12 words; the key number is appended by the shell). */
export const TAB_TIPS = Object.freeze({
  colony: 'Brood, castes and jobs.', build: 'Chambers, the dig queue and the Mound.', map: 'Trails, territory and rivals.',
  adaptations: 'Repeatable upgrades bought with food.',
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
  supermajor: 'Giant defenders that shrug off home bonuses. Housed in War Halls.',
  replete: 'Living honey pots: +2% food cap each.',
  alate: 'Winged princesses; each adds +2% flight alates.',
});

/** Chamber effect tooltips. */
export const CHAMBER_TIPS = Object.freeze({
  royal_chamber: 'Home of the queen. Levels raise lay rate ×1.15.',
  gallery: 'Room for ' + num0(CHAMBERS.gallery && CHAMBERS.gallery.fx && CHAMBERS.gallery.fx.housing, 10) + ' more ants per level.',
  nursery: '+3 brood slots. Next to the queen: brood +15%.',
  granary: 'Stores food. Shallow hauls faster; deep is safer.',
  scent_library: 'Produces insight. Deeper and royal-adjacent is better.',
  midden: 'Fewer diseases, +2% output. Keep away from nurseries.',
  barracks: 'Soldier berths; ≤12 cells from an entrance: instant deploy, +10% home AP.',
  war_hall: '+4 supermajor berths per level. Deep: row 30 or lower.',
  carapace_store: 'Stores more chitin: raises the chitin cap.',
  carapace_workshop: 'More chitin from every source; recycles fallen soldiers.',
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

/** C141: what each chamber does, in one or two sentences, for the top of the inspect panel (numbers from the data). */
const FXN = (id, k, fb) => num0(CHAMBERS[id] && CHAMBERS[id].fx && CHAMBERS[id].fx[k], fb);
export const CHAMBER_ABOUT = Object.freeze({
  royal_chamber: 'The queen lives and lays here. Each level raises her lay rate; level ' + ROYAL_LEVEL + ' is needed for the Nuptial Flight.',
  gallery: 'Housing for your workers: each level makes room for ' + FXN('gallery', 'housing', 11) + ' more ants. Galleries in loam hold 10% more.',
  nursery: 'Brood slots where eggs develop: +' + FXN('nursery', 'slots', 3) + ' per level. Next to the Royal Chamber its brood grows 15% faster.',
  granary: 'Raises your food store. Shallow granaries shorten the haul; deep ones hold more and are safer from raids.',
  scent_library: 'Produces insight for research. It works better deep (gravel or lower) and next to the Royal Chamber.',
  midden: 'The colony\'s refuse heap: fewer diseases, a little more output and some chitin. Keep it away from nurseries and gardens.',
  barracks: 'Berths for soldiers: +' + FXN('barracks', 'berths', 8) + ' per level, and soldier attack +' + Math.round(FXN('barracks', 'atk', 0.05) * 100)
    + '% per level (up to +' + Math.round(FXN('barracks', 'atkMax', 0.5) * 100) + '%). Within ' + num0(GEOM && GEOM.barracksPath, 12)
    + ' path cells of an entrance (the walk through your tunnels from the Barracks to the nearest entrance shaft) the garrison deploys at once and gets +'
    + Math.round((FXN('barracks', 'homeAP', 1.1) - 1) * 100) + '% home AP: Army Power when it defends the nest against raids.',
  war_hall: 'Berths for supermajors: +' + FXN('war_hall', 'berths', 4) + ' per level. Every supermajor egg needs a free War Hall berth; it is dug deep.',
  carapace_store: 'Stacks of shed plates and husks: raises how much chitin the colony can hold (+' + FXN('carapace_store', 'chitinCap', 300)
    + ' at level 1, growing ×' + FXN('carapace_store', 'capGrowth', 1.6) + ' a level).',
  carapace_workshop: 'Workers shape chitin with their mandibles: +' + Math.round(FXN('carapace_workshop', 'chitinBoost', 0.1) * 100)
    + '% chitin from every source per level (up to +' + Math.round(FXN('carapace_workshop', 'boostMax', 1) * 100)
    + '%), and some chitin back from every soldier that falls.',
  root_aphid_pen: 'Root aphids give honeydew without herders and boost your herders. It must touch a root.',
  fungus_garden: 'Holds leaves and fungus and gives gardener slots. Clay suits it best, and a Water Well next to it helps.',
  repletion_hall: 'Berths for repletes, the living honey pots that raise your food cap.',
  hibernaculum: 'Shelters brood from frost and cuts winter upkeep.',
  thermal_chimney: 'Warm air from below softens the winter forage penalty. It must touch the surface.',
  gate: 'Guards an entrance: defenders fight harder there and raiders steal less food.',
  water_well: 'Taps a water pocket: drought immunity, and nearby Fungus Gardens grow faster.',
  nuptial_chamber: 'Rears the alates for the Nuptial Flight and opens a second entrance to the surface.',
  deep_vault: 'A safe store deep in bedrock: longer offline time and more alates per Flight.',
});

/** Special placement rules (DESIGN §7.6 "Placement rule" column; data `rule`), as player text (C99). */
export const PLACEMENT_RULE_TEXT = Object.freeze({
  touchRoot: 'Must touch a root.',
  touchRow0: 'Must touch the surface (row 0).',
  shaftTop: 'Must sit beside an entrance shaft.',
  touchWater: 'Must touch a revealed water pocket.',
  nuptialShaft: 'Needs its own exit shaft to the surface (queued with it).',
});

/** Name of the layer holding a row (data/strata.js), '' when unknown. */
function layerNameAt(row) {
  for (const L of Object.values(LAYERS)) if (L && row >= L.y0 && row <= L.y1) return L.name || L.id;
  return '';
}

/**
 * Placement requirements of a chamber type for the Build panel (C99): the depth rule ("Depth 24 or deeper (clay)",
 * "Rows 0–6 only") and the special rule. Row 1 (just under the surface) and the bottom row are not rules worth
 * naming. `rows` = nest.placementRows (effective rows); defaults to the data table.
 * @param {string} id chamber type
 * @param {{ min: number, max: number }|null} [rows]
 * @returns {string[]} lines ([] = no special requirement)
 */
export function placementRuleLines(id, rows = null) {
  const def = CHAMBERS[id];
  if (!def) return [];
  const min = rows && Number.isFinite(rows.min) ? rows.min : num0(def.rowMin, 0);
  const max = rows && Number.isFinite(rows.max) ? rows.max : num0(def.rowMax, 79);
  const bottom = LAYERS.aquifer ? LAYERS.aquifer.y1 : 79;
  const out = [];
  if (max < bottom) out.push('Rows ' + min + '–' + max + ' only.');
  else if (min > 1) out.push('Depth ' + min + ' or deeper' + (layerNameAt(min) ? ' (' + layerNameAt(min).toLowerCase() + ')' : '') + '.');
  if (def.rule && PLACEMENT_RULE_TEXT[def.rule]) out.push(PLACEMENT_RULE_TEXT[def.rule]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Chamber level-up gains and adjacency (C107, C109)
// ---------------------------------------------------------------------------------------------------------------

/** Stat labels for nest.levelGain lines. */
export const GAIN_LABELS = Object.freeze({
  housing: 'housing', broodSlots: 'brood slots', granaryCap: 'Granary capacity', insight: 'insight', disease: 'Disease chance',
  output: 'All output', berths: 'soldier berths', warBerths: 'supermajor berths', atk: 'Soldier ATK', honeydew: 'honeydew', gardeners: 'gardener slots',
  leafCap: 'Leaf cap', fungusCap: 'Fungus cap', repleteBerths: 'replete berths', shelter: 'brood sheltered from frost',
  upkeep: 'Winter upkeep', winterForage: 'Winter forage penalty', gateHp: 'Defender HP at the gate', theft: 'Food stolen by raids',
  alateCells: 'alate cells', offline: 'offline cap', alates: 'Flight alates', lay: 'Lay rate',
  chitinCap: 'Chitin storage', chitinBoost: 'Chitin from all sources', chitinRecycle: 'Chitin per fallen soldier',
});

/** Whole numbers as counts ("33"), fractions with one decimal ("12.1"). */
function gainAmount(x) {
  return Math.abs(x - Math.round(x)) < 1e-6 ? fmtCount(Math.round(x)) : fmt(x);
}

/**
 * One nest.levelGain line as player text: "+11 housing (33 → 44)", "Granary capacity 660 → 1.08K",
 * "+0.05 insight/s (0.10/s → 0.15/s)", "Disease chance −10% → −20% (max −80% combined)", "Lay rate ×1.32 → ×1.52".
 * @param {{ stat: string, from: number, to: number, kind: string, sign?: number, cap?: number }} line
 * @returns {string}
 */
export function levelGainText(line) {
  if (!line) return '';
  const lab = GAIN_LABELS[line.stat] || humanize(line.stat);
  const a = num0(line.from, 0);
  const b = num0(line.to, 0);
  const sg = line.sign < 0 ? -1 : 1;
  switch (line.kind) {
    case 'count': return '+' + gainAmount(b - a) + ' ' + lab + ' (' + gainAmount(a) + ' → ' + gainAmount(b) + ')';
    case 'num': return lab + ' ' + fmt(a) + ' → ' + fmt(b);
    case 'rate': return '+' + fmtRate(b - a).replace('/s', '') + ' ' + lab + '/s (' + fmtRate(a) + ' → ' + fmtRate(b) + ')';
    case 'pct': return lab + ' ' + fmtPct(sg * a) + ' → ' + fmtPct(sg * b)
      + (num0(line.cap, 0) > 0 ? ' (max ' + fmtPct(sg * line.cap) + ' combined)' : '');
    case 'mult': return lab + ' ' + fmtMult(a) + ' → ' + fmtMult(b);
    case 'time': return '+' + fmtTime(b - a) + ' ' + lab + ' (' + fmtTime(a) + ' → ' + fmtTime(b) + ')';
    case 'flag': return line.stat === 'flight' ? 'Reaches L' + num0(FLIGHT && FLIGHT.royalLevel, 5) + ', the level the Nuptial Flight needs.' : lab;
    default: return lab;
  }
}

/** "next to" (within the adjacency path) or "within N path cells of". */
function nearWords(r) {
  return num0(r.path, 4) <= num0(GEOM && GEOM.adjPathMax, 4) ? 'next to' : 'within ' + r.path + ' path cells of';
}

/** "a Royal Chamber", "a Nursery or a Fungus Garden", "an entrance". */
function aNames(ids) {
  return ids.map((id) => (id === 'entrance' ? 'an entrance' : 'a ' + nameOf('chamber', id))).join(' or ');
}

/**
 * Adjacency rules a chamber type takes part in (DESIGN §7.7, from data ADJACENCY): what it gets and from which
 * chamber types, or what it gives. Nursery: "+15% brood speed next to a Royal Chamber.", "Hygiene −20% within 6 path
 * cells of a Midden."; Royal Chamber: "Next to a Nursery: +15% brood speed for it.".
 * @param {string} type
 * @returns {string[]}
 */
export function adjacencyLines(type) {
  const out = [];
  for (const id of ADJACENCY_ORDER) {
    const r = ADJACENCY[id];
    if (!r) continue;
    const bs = Array.isArray(r.b) ? r.b : [r.b];
    if (r.a === type) {
      if (id === 'hyg_midden') out.push(r.text + ' for ' + aNames(bs) + ' ' + nearWords(r) + ' it.');
      else out.push(r.text + ' ' + nearWords(r) + ' ' + aNames(bs) + '.');
    } else if (bs.includes(type)) {
      if (id === 'hyg_midden' || id === 'adj_granary_repletion') out.push(r.text + ' ' + nearWords(r) + ' ' + aNames([r.a]) + '.');
      else {
        const w = nearWords(r);
        out.push(w.charAt(0).toUpperCase() + w.slice(1) + ' ' + aNames([r.a]) + ': ' + r.text + ' for it.');
      }
    }
  }
  return out;
}

/**
 * A live or previewed adjacency link (nest.chamberLinks, validatePlacement links / lost) as text: receiver 'self' →
 * "+15% brood speed (next to Royal Chamber)"; 'partner' → "Nursery: +15% brood speed".
 * @param {{ rule: string, partner: string, text: string, receiver: string }} link
 * @returns {string}
 */
export function linkText(link) {
  if (!link) return '';
  const r = ADJACENCY[link.rule] || { path: 4 };
  const name = link.partner === 'entrance' ? 'an entrance' : nameOf('chamber', link.partner);
  if (link.receiver === 'partner') return name + ': ' + link.text;
  return link.text + ' (' + nearWords(r) + ' ' + name + ')';
}

/** Adaptation effect tooltips. */
export const ADAPT_TIPS = Object.freeze({
  quick_dispatch: '+1 food per click.',
  strong_mandibles: 'Forager output +10% a level; adds with other +% forage bonuses.',
  royal_feeding: '+0.05 eggs per second base lay rate.',
  digging_claws: 'Dig work +25% a level: faster digging and more soil. Additive.',
  potent_trails: 'Forager output ×1.12 per level (multiplies everything).',
  serrated_mandibles: 'Soldier and supermajor attack ×1.10.',
  thick_cuticle: 'Soldier and supermajor health ×1.10.',
  sweet_tooth: 'Honeydew ×1.15.',
  queens_feast: 'Lay rate ×1.1.',
  long_legs: 'Trails lose less to distance: navigation +0.25 a level.',
});

/** C200: Archive copy (Research tab, one permanent track per branch). */
export const ARCHIVE_TEXT = Object.freeze({
  name: 'Archive',
  keep: 'kept through Flights and Supercolonies',
  tip: 'A permanent record of this branch. Each level adds +1% to the main output of the branch for the rest of this era. It is kept through Nuptial Flights and Supercolonies and resets at Speciation.',
});

/** Research effect tooltips. */
export const RESEARCH_TIPS = Object.freeze({
  trail_memory: 'Forager ×1.25 and +1 trail slot.',
  scent_marking: 'Unlocks pheromone, Mark, Mass Recruit and hex claims.',
  tandem_running: 'Navigation +1. Unlocks Long Legs (Adaptations tab): trails lose less to distance.',
  recruitment_pheromones: 'Forager ×1.75. Unlocks Rally.',
  double_bridge: 'Trails find shortcuts and strengthen twice as fast.',
  persistent_trails: 'Trails fade half as fast; higher maximum strength.',
  sun_compass: 'Map radius 12 and +2 trail slots.',
  mass_recruitment: 'Longer reach, 60 s Rally and +2 trail slots.',
  frenzy_signal: 'Unlocks Frenzy.',
  trunk_trails: 'Long trails ×1.5; trail hexes are territory; shared stretches up to +' + Math.round(100 * ((RESEARCH.trunk_trails && RESEARCH.trunk_trails.fx.overlap) || 0)) + '%.',
  odometer_navigation: 'Much longer reach; distant sources richer.',
  coordinated_digging: 'Dig ×1.5.',
  load_chains: 'Tunnels cost half the work; +2 queue slots.',
  clay_masonry: 'Clay is easier to dig.',
  mound_building: 'Mound levels 6 and above.',
  drainage: 'No floods; drought penalties halved. Drain or move water pockets.',
  ventilation_shafts: 'All chambers ×1.10; clay granaries stop spoiling.',
  thermoregulation: 'Frost line 5 rows shallower; no summer overheat.',
  gallery_arches: '+2 Galleries allowed; housing ×1.25.',
  acid_excavation: 'Dig bedrock and stones; dig ×2.',
  compact_galleries: 'Housing ×2.',
  brood_care: 'Brood develops 25% faster.',
  age_polyethism: 'Jobs assign themselves by preset ratios.',
  royal_pheromones: 'Lay rate ×1.5.',
  trophic_eggs: 'Eggs cost 30% less.',
  thermal_brood_shuttling: 'Brood fills frost-safe nurseries first; no topsoil overheat; frost snaps spare brood.',
  nuptial_preparation: 'Nuptial Chamber and alate rearing. Required to fly.',
  response_thresholds: 'Automatic jobs follow the current bottleneck.',
  living_larders: 'Repletes and the Repletion Hall.',
  spermathecal_reserve: 'Lay rate ×2.',
  supermajors: 'Unlocks the supermajor caste.',
  aphid_husbandry: 'Herders, honeydew and Root Aphid Pens.',
  leafcutting: 'Unlocks the leafcutter job.',
  aphid_shepherding: 'Herder cap ×2. Move aphid colonies to owned flower or leaf hexes.',
  fungiculture: 'Fungus Gardens, gardeners, Nutrition and Fungal Brood.',
  lycaenid_clients: 'Lycaenid caterpillars appear for honeydew.',
  root_cultivation: 'Grow your own roots down into the nest for Root Aphid Pens.',
  sugar_economy: 'Honeydew ×2.',
  weeder_ants: 'Blight far rarer; fungus ×1.5.',
  fungal_symbiosis: 'Nutrition bonus doubled.',
  polymorphism: 'Soldiers, Barracks and caste targets.',
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
  automaton_instincts: '+2 dig queue; your job targets carry into every run.',
  hardy_workers: 'Forage, herding and leafcutting ×1.4.',
  deep_diggers: 'Dig work ×1.4.',
  keen_antennae: 'Rings 0–4 revealed at start; scouts ×2.',
  fertile_queen: 'Lay rate ×1.25.',
  ancestral_memory: 'Research becomes Innate after 2 runs.',
  long_memory: '+2 h offline cap and +10% efficiency.',
  warrior_lineage: 'Soldier and supermajor attack and health ×1.25.',
  root_memory: 'A free root grows to each rootless blueprint Root Aphid Pen.',
  royal_court: '50 alate cells; Nuptial Chamber to level 9.',
  deep_spring: 'A spring wells up for blueprint Water Wells with no water nearby.',
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
  automated_brood: 'Automatic jobs every run; caste and job targets carry over.',
  blueprint_memory: 'Five blueprint slots; blueprint cells dig ×5.',
  architects_table: 'Edit saved blueprint layouts by hand. Needs Blueprint Library.',
  autobuyers: 'Auto-buy Adaptations and chamber levels, each on its own switch.',
  auto_flight: 'Fly automatically at your chosen trigger.',
  aquifer_access: 'Dig the aquifer, rows 74–79.',
  heirloom_bloodline: 'Keep three Bloodline traits through Supercolonies.',
  satellite_nest: 'A satellite entrance, trail slot and +25% food and dig.',
  regional_expansion: 'Map radius 16; up to four rivals.',
  megacolony_galleries: 'Colony scale ×2.',
  highway_network: 'Trails reach much further; satellites share the garrison.',
  diapause_mastery: 'Offline cap 24 h at full efficiency; Diapause runs 3×.',
  queens_council: 'Two more Royal Chambers.',
  megacolony: 'The Argentine Front appears. Required for Speciation.',
});

/** Genome tooltips. */
export const GENOME_TIPS = Object.freeze({
  genetic_memory: "This cycle's Innate research survives Speciation.",
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
  chamber_war_hall: 'Research Supermajors.',
  chamber_carapace_store: 'Collect your first chitin, or research Polymorphism.',
  chamber_carapace_workshop: 'Build a Barracks, or research Phalanx.',
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
  ev_flight_day: 'Warm, still air (a "flying ant day"): Nuptial Flights get ×1.5 alates for 3 min.',
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
  ev_fungal_blight: 'Blight greys the fungus garden! Click it (Below) to clean it.',
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
  ev_antlion_pit: { send: 'Three garrison soldiers clear the pit.', wait: 'Losses go on until you reroute or click the pit.' },
  ev_horned_lizard: { reroute: 'Reroute the trail around it, free.', mob: 'Drive it off and gain food.', ignore: 'The trail loses workers.' },
  ev_fungal_blight: { quarantine: 'Lose 30% of your fungus.', clean: 'Click the Fungus Garden (Below) 20 times in 15 s.' },
  ev_army_ant_column: { evacuate: 'No foraging for 60 s, lose 5% food.', fight: 'Battle the column for huge loot.' },
});

// ---------------------------------------------------------------------------------------------------------------
// Misc labels
// ---------------------------------------------------------------------------------------------------------------

/** Dig job kinds. */
export const DIG_KIND_NAMES = Object.freeze({ tunnel: 'Tunnel', chamber: 'Dig', grow: 'Enlarge', shaft: 'Shaft', relocate: 'Relocate', drain: 'Drain' });
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
  raid: 'Hit-and-run: ' + Math.round(num0(ACTIONS.raid && ACTIONS.raid.engage, 0.4) * 100) + '% of defenders, no home bonus. Food and chitin, no conquest.',
  assault: 'All defenders, home bonus ×' + num0(ACTIONS.assault && ACTIONS.assault.home, 1.25) + '. Victory conquers the nest and its land.',
  hunt: 'Hunt the prey for food and chitin.',
  termite: 'Raid the termite mound for a big payout.',
  tournament: 'A bloodless display contest for a border hex.',
  bribe: 'Pay honeydew for a 5-minute truce.',
});

/**
 * C207: what each war action is, in full, shown under the action buttons of the war-party form (Map → War and the
 * right-click war chooser). Numbers from data/combat.js ACTIONS / REWARDS (raid = engage 0.4, home 1; assault = engage
 * 1, home 1.25 or a fortress's 1.5, reduced by your supermajors' share of AP, rivals.effectiveHome).
 */
export const WAR_KIND_EXPLAIN = Object.freeze({
  raid: 'Raid — a hit-and-run for loot. Your party fights only ' + Math.round(num0(ACTIONS.raid && ACTIONS.raid.engage, 0.4) * 100)
    + '% of the nest\'s soldiers, with no home bonus for them. Win: food (' + num0(REWARDS.raidFoodSec, 30) + ' s of your food income × √tier) and '
    + 'chitin for every enemy killed. The nest is not conquered: it keeps its land and its other soldiers, and can raid you back.',
  assault: 'Assault — a full attack to conquer the nest. You fight every defender, and they fight at home: their Army Power ×'
    + num0(ACTIONS.assault && ACTIONS.assault.home, 1.25) + ' (supermajors cancel part of this home bonus). Win: the nest falls, all its land becomes your '
    + 'territory with an outpost entrance, and you take food (' + num0(REWARDS.conquestFoodSec, 120) + ' s of income × √tier), chitin, insight and captured workers.',
  hunt: 'Hunt — kill the prey for food and chitin. The prey is gone afterwards.',
  termite: 'Termite raid — break into the mound for a big payout of food and chitin. The mound recovers and can be raided again later.',
  tournament: 'Tournament — a bloodless display contest. Choose a border hex on the map; the bigger display wins the hex.',
});

/**
 * C207: the loot a won battle carried home ({ food, chitin, insight, minors } from combat.grantReward), as one line:
 * "Loot carried home: +120 food, +8 chitin". '' when nothing was granted.
 * @param {Object|null} loot
 * @returns {string}
 */
export function lootText(loot) {
  if (!loot || typeof loot !== 'object') return '';
  const parts = [];
  for (const [k, name] of [['food', 'food'], ['chitin', 'chitin'], ['insight', 'insight'], ['minors', 'captured workers']]) {
    const v = num0(loot[k], 0);
    if (v >= 0.5) parts.push('+' + (k === 'minors' ? fmtCount(Math.floor(v)) : fmt(v)) + ' ' + name);
  }
  return parts.length ? 'Loot carried home: ' + parts.join(', ') : '';
}

/** Plain number for rules text: up to two decimals, no padding ("3", "0.25", "1.5"). */
export function plainNum(x) {
  const v = Math.round(num0(x, 0) * 100) / 100;
  return Math.abs(v) >= 1000 ? fmt(v) : String(v);
}

/**
 * C208: the Map tab's "How trails work" help (also the Manual's Trails entry). Numbers from data/surface.js TRAIL;
 * `dNav` = the colony's current navigation (surface.dNavFor), `sMax` = its strength cap (trails sMaxFor). Lines that
 * would name unrevealed things can be toned down: o.research (name Tandem Running / Long Legs), o.jobs (name herders and
 * leafcutters), o.soldiers (the chitin-priority line); each defaults to true.
 * @param {{ dNav?: number, sMax?: number, research?: boolean, jobs?: boolean, soldiers?: boolean }} [o]
 * @returns {string[]}
 */
export function trailHelpLines(o = {}) {
  const fmt = plainNum;
  const dNav = num0(o.dNav, num0(TRAIL.dNavBase, 3));
  const sMax = num0(o.sMax, num0(TRAIL.sMax, 100));
  const slope = Math.round(num0(TRAIL.slope, 0.35) * 100);
  return [
    'A trail sends foragers' + (o.jobs === false ? '' : ' (or herders, leafcutters)') + ' from an entrance to one source and back. Its row shows the workers on it and what it brings home per second.',
    'Distance: every hex past the first makes a source ' + slope + '% richer, but each worker also walks longer, so it makes fewer round trips. '
      + 'Distance efficiency = 1 ÷ (1 + (length − 1) ÷ navigation). Your navigation is ' + fmt(dNav) + ' (' + fmt(TRAIL.dNavBase) + ' at first; '
      + (o.research === false ? 'upgrades' : 'Tandem Running, Long Legs and later research') + ' raise it). At low navigation a 9-hex trail pays about what a 1-hex trail pays per worker; higher navigation makes long trails pay more.',
    'Travel time: the trail\'s length counts its ground (sand and other slow ground count as longer, garden paths as shorter) plus the haul down to food storage for trails '
      + 'from the main entrance, so deep storage makes every main-entrance trail count as longer.',
    'Strength (the pheromone bar): walking workers lay scent. Strength heads toward ' + fmt(TRAIL.sScale) + ' × workers ÷ (workers + ' + fmt(TRAIL.sEqK)
      + ' × length): more workers make a stronger trail, and a long trail needs more workers for the same strength. Yield is ×(1 + strength ÷ ' + fmt(TRAIL.sScale)
      + '): close to ×2 on a busy trail' + (sMax > num0(TRAIL.sScale, 100) ? ', up to ×' + fmt(1 + sMax / num0(TRAIL.sScale, 100)) + ' when Mark tops it up to the cap (' + fmt(sMax) + ')' : ' (the cap is ' + fmt(sMax) + '; Mark adds strength up to it)') + '. A trail with no workers fades: strength halves every ' + fmt(TRAIL.tHalf) + ' s.',
    'Capacity: each source can use only so many workers (more as the colony grows); past that, extra workers add less and less.',
    'Who goes where: workers you pin on a trail with − / + stay there. The rest are shared out a small batch at a time, each batch to the trail where it adds the most yield '
      + 'right now, trails still under their capacity first.' + (o.soldiers === false ? '' : ' While chitin is short for soldier eggs, chitin trails are filled first ("chitin priority").'),
    'Why far trails can yield less: with low navigation the walk eats the extra richness, and the same workers keep a long trail weaker than a short one.',
  ];
}

/**
 * C208: a trail's distance terms (d.surface.trails entry: rich, eff, dEff) and its strength's yield factor, e.g.
 * "6 hexes (+0.8 haul to storage): richness ×2.75, distance efficiency ×0.37", "Strength 64: yield ×1.64".
 * @param {Object} tr trail
 * @param {Object} dt d.surface.trails entry
 * @returns {string[]}
 */
export function trailDistanceLines(tr, dt) {
  const out = [];
  if (!tr || tr.job === 'lycaenid') return out;
  const len = num0(tr.len, 0);
  const dEff = num0(dt && dt.dEff, len);
  const r2 = (x) => String(Math.round(x * 100) / 100);
  if (dt && Number.isFinite(dt.rich) && Number.isFinite(dt.eff)) {
    out.push(r2(len) + ' hex' + (len === 1 ? '' : 'es') + (dEff - len > 0.05 ? ' (+' + r2(dEff - len) + ' haul to storage)' : '')
      + ': richness ×' + r2(dt.rich) + ', distance efficiency ×' + r2(dt.eff) + '.');
  }
  out.push('Strength ' + fmtCount(num0(tr.S, 0)) + ': yield ×' + r2(1 + num0(tr.S, 0) / num0(TRAIL.sScale, 100)) + '. More workers make it stronger; unused it fades.');
  return out;
}


/**
 * C208: trail colours on the Above map (render/surfaceRenderer.js trailColor; cosmetics recolour forager trails only).
 * `swatch` names the palette key in render/palette.js SURFACE; `color` mirrors it (UI modules do not import render; a test
 * keeps them equal).
 */
export const TRAIL_LEGEND = Object.freeze([
  Object.freeze({ id: 'forager', swatch: 'trail', color: '#f3d9a4', label: 'Foragers', text: 'Pale gold: foragers bringing food (and chitin from dead insects). Trail-colour cosmetics recolour only these.' }),
  Object.freeze({ id: 'herder', swatch: 'trailHerder', color: '#f0a830', label: 'Herders', text: 'Amber: herders milking aphids for honeydew.' }),
  Object.freeze({ id: 'leafcutter', swatch: 'trailLeaf', color: '#7fd36a', label: 'Leafcutters', text: 'Green: leafcutters cutting leaves for the fungus.' }),
  Object.freeze({ id: 'lycaenid', swatch: 'trailLycaenid', color: '#a99cf0', label: 'Lycaenid', text: 'Lavender, dashed: soldiers escorting a lycaenid caterpillar for honeydew.' }),
]);
/** C208: what the shape of a trail line means. */
export const TRAIL_LINE_NOTE = 'Thicker line = more workers; brighter = stronger scent; dotted = paused (no way round a blocked hex); running light dashes = Rally.';

/**
 * C209: what owning land does (claim UI, hex tooltips while claiming, Manual). Numbers from data/surface.js TERRITORY,
 * data/prestige.js FLIGHT.tPeakDiv and data/combat.js RAIDS.borderMult. Territory adds to forager output only
 * (stats.js forage aAdd), in the same "+%" group as Strong Mandibles. Lines naming unrevealed systems can be left out:
 * o.raids (raid warnings), o.flight (the Prestige tab), o.rivals (rival nests); each defaults to true.
 * @param {{ raids?: boolean, flight?: boolean, rivals?: boolean }} [o]
 * @returns {string[]}
 */
export function territoryBenefitLines(o = {}) {
  const per = num0(TERRITORY.yieldPerHex, 0.005);
  const max = num0(TERRITORY.yieldMax, 1);
  return [
    '+' + plainNum(per * 100) + '% forager output per owned hex (up to +' + Math.round(max * 100) + '% at ' + fmtCount(Math.round(max / per)) + ' hexes), added to Strong Mandibles\' +%.',
    'Sources on your land yield ×' + num0(TERRITORY.ownedSource, 1.25) + '.',
    o.raids === false ? '' : 'Trails that stay entirely inside your land cannot be raided.',
    o.flight === false ? '' : 'Your peak territory this run raises the next Nuptial Flight: +' + plainNum(100 / num0(FLIGHT && FLIGHT.tPeakDiv, 400)) + '% alates per hex.',
    o.rivals === false ? '' : 'Border hexes (your hexes touching rival land): a trail crossing one is ' + num0(RAIDS.borderMult, 2) + '× as likely to be picked for a trail raid.',
  ].filter(Boolean);
}

/** C210: "+X%" vs "×Y" (Manual, upgrade-row tooltips). */
export const BONUS_STACK_TIP = '“+X%” bonuses add together within their group before multiplying; “×Y” multiplies the whole total.';

/**
 * C210: Flight Day (data/events.js ev_flight_day: summer only, needs Nuptial Preparation, a flight-weather effect of
 * ×num.w for num.sec; Flight weather W = the better of the season's flightW and this effect, prestige.js).
 */
export function flightDayText() {
  const ev = EVENTS.ev_flight_day || { num: {} };
  const w = num0(ev.num && ev.num.w, 1.5);
  const sec = num0(ev.num && ev.num.sec, 180);
  const summer = num0(SEASON_MODS.summer && SEASON_MODS.summer.flightW, 1.25);
  const span = sec % 60 === 0 ? (sec / 60) + ' minute' + (sec === 60 ? '' : 's') : fmtTime(sec);
  return 'Flight Day (the real "flying ant day"): a rare random summer event once you have Nuptial Preparation. For ' + span
    + ' the air is warm and still, and a Nuptial Flight gets ×' + w + ' alates instead of summer\'s ×' + summer + '. If you can fly then, a toast offers it.';
}

/** C210: the honeydew cap rule (stats.js: CAPS.honeydewBase + CAPS.honeydewFrac × food cap). */
export function honeydewCapText() {
  return 'Cap = ' + num0(CAPS.honeydewBase, 50) + ' + ' + Math.round(num0(CAPS.honeydewFrac, 0.1) * 100)
    + '% of your food cap. Honeydew is not kept in Granaries, but every Granary (anything that raises the food cap) raises its cap too.';
}

/** C211: when a chamber counts as frost-exposed (nestgeom.exposedTo: more than half its rows above the frost line). */
export function frostExposedText(frostRow = 0) {
  return 'Frost-exposed: more than half of its rows lie above the frost line' + (num0(frostRow, 0) > 0 ? ' (row ' + fmtCount(Math.ceil(frostRow)) + ' now)' : '')
    + ', so it works at ×' + num0(CHAMBER_RULES.frostMult, 0.5) + ' while the frost lasts, and brood in it freezes.';
}

/**
 * C211: the inspect panel's "about" text with the live facts behind it: a Barracks' walking distance to the nearest
 * entrance (d.nest.chambers[i].minEntPath, read-only) and a frost-exposed chamber's rule.
 * @param {string} type
 * @param {Object} [dc] d.nest.chambers entry
 * @param {Object} [d]
 * @returns {string}
 */
export function chamberAboutText(type, dc = null, d = null) {
  const base = CHAMBER_ABOUT[type] || CHAMBER_TIPS[type] || '';
  const extra = [];
  if (type === 'barracks' && dc) {
    const p = num0(dc.minEntPath, -1);
    const lim = num0(GEOM && GEOM.barracksPath, 12);
    if (p < 0) extra.push('No tunnel links it to an entrance yet: no entrance bonus.');
    else extra.push('Path to the nearest entrance: ' + fmtCount(p) + ' cell' + (p === 1 ? '' : 's') + (p <= lim ? ' — within ' + lim + ', bonus active.' : ' — over ' + lim + ', no entrance bonus.'));
  }
  if (dc && dc.exposed) extra.push(frostExposedText(d && d.season ? d.season.frostRow : 0));
  return [base].concat(extra).filter(Boolean).join(' ');
}
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

/**
 * Cosmetic slot from a cosmetic id: the data/cosmetics.js slot (C149), else a guess from the id (ARCH-R: slot names are
 * not pinned by the contract).
 */
export function cosmeticSlot(id) {
  const k = String(id || '');
  if (Object.prototype.hasOwnProperty.call(COSMETICS, k)) return COSMETICS[k].slot;
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
export const COSMETIC_SLOTS = Object.freeze({ ...COSMETIC_SLOT_NAMES, misc: 'Other' });

/** Display name of a cosmetic (data name, else humanized id). */
export function cosmeticName(id) {
  const k = String(id || '');
  return Object.prototype.hasOwnProperty.call(COSMETICS, k) ? COSMETICS[k].name : humanize(k.replace(/^cos(metic)?_/, ''));
}

/**
 * The equipped cosmetic id of a slot (C149), or null: equipped[slot] when it holds an owned cosmetic of that slot, else
 * any equipped owned cosmetic whose slot matches (older saves kept some under 'misc').
 * @param {Object} s
 * @param {string} slot
 * @returns {string|null}
 */
export function equippedCosmeticId(s, slot) {
  const c = s && s.meta && s.meta.cosmetics;
  const eq = c && c.equipped && typeof c.equipped === 'object' ? c.equipped : null;
  if (!eq) return null;
  const owned = c.owned && typeof c.owned === 'object' ? c.owned : null;
  const ok = (id) => typeof id === 'string' && cosmeticSlot(id) === slot && (!owned || owned[id] === true);
  if (ok(eq[slot])) return eq[slot];
  for (const k of Object.keys(eq)) if (ok(eq[k])) return eq[k];
  return null;
}

/**
 * Colony name with the equipped title cosmetic (C149): "Redhill the Underdog"; without a title the colony name, or
 * `fallback` when the colony is unnamed and has no title.
 * @param {Object} s
 * @param {string} [fallback]
 * @returns {string}
 */
export function colonyTitle(s, fallback = 'Six Legs Deep') {
  const name = (s && s.meta && s.meta.settings && s.meta.settings.colonyName) || '';
  const id = equippedCosmeticId(s, 'title');
  const title = id && COSMETICS[id] ? COSMETICS[id].title : '';
  if (title) return (name || 'Your colony') + ' ' + title;
  return name || fallback;
}

/**
 * C241: how a cosmetic is unlocked — the achievement whose `cosmetic` grants it. A secret achievement the player has not
 * earned keeps its name and requirement hidden (as in the Achievements tab).
 * @param {string} id cosmetic id
 * @param {Object} [s] state (meta.achievements decides "earned")
 * @returns {{ achId: string|null, name: string, req: string, secret: boolean, earned: boolean, text: string }}
 */
export function cosmeticUnlock(id, s) {
  let achId = null;
  for (const k of Object.keys(ACHIEVEMENTS)) if (ACHIEVEMENTS[k] && ACHIEVEMENTS[k].cosmetic === id) { achId = k; break; }
  if (!achId) return { achId: null, name: '', req: '', secret: false, earned: false, text: 'Unlock source unknown.' };
  const a = ACHIEVEMENTS[achId];
  const ach = s && s.meta && s.meta.achievements && typeof s.meta.achievements === 'object' ? s.meta.achievements : {};
  const earned = ach[achId] !== undefined && ach[achId] !== null;
  const secret = !!(a.secret || a.cat === 'secret') && !earned;
  const name = secret ? '???' : a.name;
  const req = secret ? 'A secret achievement.' : String(a.desc || '');
  const text = secret ? 'Unlocked by a secret achievement.' : 'Unlocked by the achievement ' + a.name + ': ' + req;
  return { achId, name, req, secret, earned, text };
}

/**
 * C244: click commands a player spams on a map / nest object. Two clicks inside one tick are both queued; the second is
 * re-validated when it applies and finds the object already taken ('notFound'). That is not a failure the player
 * caused, so its commandRejected stays silent (no toast, no buzz).
 */
export const STALE_CLICK_TYPES = Object.freeze(new Set(['clickEventObject', 'clearAntlion', 'scrapeMold', 'bailFlood', 'cleanBlight',
  'clickBeetle', 'clickPupa', 'openGift']));

/** C244 [pure]: true for an apply-time rejection of an already-collected clicked object (silent). */
export function staleClickReject(e) {
  return !!(e && e.reason === 'notFound' && e.cmd && STALE_CLICK_TYPES.has(e.cmd.type));
}

/** Render variant of the equipped cosmetic of a slot ('' when none). */
export function cosmeticVariant(s, slot) {
  const id = equippedCosmeticId(s, slot);
  return id && COSMETICS[id] ? COSMETICS[id].variant : '';
}

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
      if (e.calledOff === 'fallen') return { text: 'Raid called off — their nest has fallen.', kind: 'good', priority: 'high' };   // C186
      if (e.calledOff === 'truce') return { text: 'Raid called off — the truce holds.', kind: 'good', priority: 'high' };
      if (e.win) {
        const loot = lootText(e.loot);   // C227: chitin from the raiders killed
        return { text: 'Raid repelled!' + (loot ? ' ' + loot + '.' : ''), kind: 'good', priority: 'high' };
      }
      return {
        text: 'Raid lost: ' + fmt(e.foodLost || 0) + ' food, ' + fmtCount(e.broodLost || 0) + ' brood, ' + fmtCount(e.workersLost || 0) + ' workers.',
        kind: 'danger', priority: 'high',
      };
    case 'tournamentEnd': {
      // C226: a won tournament flips the hex and pays a prize; withdraw/escalate are quieter
      if (e.result === 'win') {
        const pz = e.prize || {};
        const bits = [];
        if (pz.insight > 0) bits.push('+' + fmt(pz.insight) + ' insight');
        if (pz.chitin > 0) bits.push('+' + fmt(pz.chitin) + ' chitin');
        if (pz.raidDelay > 0) bits.push('their next raid delayed ' + Math.round(pz.raidDelay / 60) + ' min');
        return { text: 'Tournament won: the hex is yours' + (bits.length ? ' (' + bits.join(', ') + ')' : '') + '.', kind: 'good', priority: 'high' };
      }
      if (e.result === 'withdraw') return { text: 'Tournament: your ants withdrew without a fight.', kind: 'info', priority: 'low' };
      return null;
    }
    case 'conquest': {
      const loot = lootText(e.loot);   // C207: the spoils (rivals.secure)
      return { text: 'Conquered: ' + rivalName(e.uid, e.rivalType) + '!' + (loot ? ' ' + loot + '.' : ''), kind: 'good', priority: 'high' };
    }
    case 'battleEnd': {
      // C207: what a won raid / hunt carried home (the glints drifting to your nest after a battle)
      const loot = e.win ? lootText(e.loot) : '';
      return { text: (BATTLE_NAMES[e.kind] || 'Battle') + (e.win ? ' won.' : ' lost.') + (loot ? ' ' + loot + '.' : ''), kind: e.win ? 'good' : 'bad', priority: loot ? 'high' : 'low' };
    }
    case 'hungryStart': return { text: 'Hungry! Laying stopped. Assign more foragers.', kind: 'danger', priority: 'high' };
    case 'hungryEnd': return { text: 'The colony is fed again.', kind: 'good', priority: 'low' };
    case 'winterSoon': return { text: 'Winter in ' + fmtTime(Number(YEAR && YEAR.forecastSec) || 60) + ': shallow brood will freeze.', kind: 'info', priority: 'high' };
    case 'seasonChanged': return { text: (SEASON_NAMES[e.id] || humanize(e.id)) + ': ' + (SEASON_TIPS[e.id] || ''), kind: 'season', priority: 'low' };
    case 'blueprintDropped': return blueprintNote(e);
    case 'blueprintAdjusted': return blueprintAdjustedText(e);
    case 'blueprintPlaced': return { text: 'Blueprint: ' + nameOf('chamber', e.chamberType) + ' queued.', kind: 'info', priority: 'low' };
    case 'waterStruck': return waterStruckText(e);
    case 'chamberActivated': return { text: chamberName(e.uid, e.chamberType) + ' complete.', kind: 'good', priority: 'low' };
    case 'cacheFound': return { text: 'Found a ' + humanize(e.kind) + ': +' + fmt(e.amount || 0) + ' ' + (RES_NAMES[e.res] || '').toLowerCase() + '.', kind: 'good', priority: 'low' };
    case 'softcapHit': return { text: (RES_NAMES[e.stat] || humanize(e.stat)) + ' production is now softcapped.', kind: 'info', priority: 'low' };
    case 'beetleClaimed': return { text: BEETLE_ROLLS[e.roll] || 'Golden Beetle claimed!', kind: 'gold', priority: 'high' };
    case 'beetleSpawned': return { text: 'A Golden Beetle scuttles across the map!', kind: 'gold', priority: 'low' };
    case 'pupaSpawned': return { text: 'A golden pupa glows in the nest! Click it.', kind: 'gold', priority: 'low' };
    case 'hardshipTier': return { text: nameOf('hardship', e.id) + ': tier ' + e.tier + ' reached!', kind: 'achievement', priority: 'high' };
    case 'entranceOpened': return { text: 'A new entrance opens to the surface.', kind: 'good', priority: 'low' };
    case 'trailRehomed': return e.ok
      ? { text: 'A forked trail now starts at the nearest entrance (trails no longer fork).', kind: 'info', priority: 'low' }
      : { text: 'A forked trail could not reach any entrance and was removed.', kind: 'bad', priority: 'high' };
    case 'rivalSighted': return { text: rivalName(e.uid, e.rivalType) + ' spotted!', kind: 'danger', priority: 'low' };
    case 'truceBroken': return { text: 'Truce broken: ' + rivalName(e.rival) + ' will raid again sooner.', kind: 'bad', priority: 'high' };   // C247
    case 'adultsDied':
      if (e.cause === 'battle') return null;
      return { text: fmtCount(e.n || 0) + ' ' + (nameOf('caste', e.caste) || 'ants').toLowerCase() + ' lost (' + humanize(e.cause || '') + ').', kind: 'bad', priority: 'low' };
    case 'broodDied': return { text: fmtCount(e.n || 0) + ' brood lost (' + humanize(e.cause || '') + ').', kind: 'bad', priority: 'low' };
    case 'storageError': return { text: 'Saving unavailable: use Export.', kind: 'danger', priority: 'high' };
    case 'flightComplete': return { text: 'Nuptial Flight! ' + fmtCount(e.alates || 0) + ' alates take wing.', kind: 'gold', priority: 'high' };
    case 'supercolonyComplete': return { text: 'Supercolony formed: +' + fmtCount(e.kinship || 0) + ' kinship.', kind: 'gold', priority: 'high' };
    case 'speciationComplete': return { text: 'Speciation: +' + fmtCount(e.genes || 0) + ' genes.', kind: 'gold', priority: 'high' };
    case 'giftOpened': return { text: 'A Saved Find opens!', kind: 'gold', priority: 'low' };
    // C188: scout expeditions
    case 'expeditionFind': return { text: 'Scouts found a ' + (FIND_NAMES[e.kind] || nameOf('source', e.kind)).toLowerCase() + ' at the map edge!', kind: 'gold', priority: 'high' };
    case 'findClaimed': return { text: e.text || 'Find claimed.', kind: 'good', priority: 'high' };
    // C182: a trail that cannot get round a temporary obstacle
    case 'trailDetour': return e.mode === 'paused' ? { text: 'A trail is blocked with no way round: paused until it clears.', kind: 'bad', priority: 'low' } : null;
    case 'commandRejected': return staleClickReject(e) ? null : { text: reasonText(e.reason, e.cmd && e.cmd.type), kind: 'bad', priority: 'low' };
    default: return null;
  }
}

/** Number of words in a string (tooltip rule). */
export function wordCount(str) {
  return String(str).trim().split(/\s+/).filter(Boolean).length;
}

/** C129: hex tooltip for impassable terrain (stone always; a puddle while it blocks in spring). */
export const TERRAIN_BLOCK_TIPS = Object.freeze({
  stone: 'Stone — impassable. Trails route around it.',
  puddle: 'Puddle — flooded in spring. Trails route around it.',
});

/** C165: what each terrain does besides its trail cost (hex tooltip second line, Manual terrain table). */
export const TERRAIN_NOTES = Object.freeze({
  grass: '',
  sand: '',
  leaf_litter: 'Leaf plants grow here.',
  garden_path: 'Shoe footsteps land here.',
  tree_root: 'Aphid colonies live here.',
  stone: 'Impassable: trails route around it.',
  puddle: 'Floods in spring: trails must go around it then.',
  log: 'Prey is twice as likely to appear within ' + ((TERRAIN.log && TERRAIN.log.fx && TERRAIN.log.fx.preyRadius) || 2) + ' hexes.',
});

/**
 * C165: trail cost of a terrain in words ("counts as 1.25 hexes for trails"), or null when impassable.
 * @param {string} id terrain id
 * @param {boolean} [blocked] the hex is impassable right now (a spring puddle)
 * @returns {string|null}
 */
export function terrainCostText(id, blocked = false) {
  const def = TERRAIN[id];
  const mv = def ? def.move : 1;
  if (blocked || mv == null) return null;
  return 'counts as ' + fmtMoveCost(mv) + (mv === 1 ? ' hex' : ' hexes') + ' for trails';
}

function fmtMoveCost(mv) {
  return String(Math.round(mv * 100) / 100);
}

/**
 * C165: hex tooltip lines for a terrain: "Sand — slow ground: counts as 1.25 hexes for trails." plus its note.
 * Impassable terrain keeps its C129 line (TERRAIN_BLOCK_TIPS).
 * @param {string} id terrain id
 * @param {boolean} [blocked] the hex is impassable right now
 * @returns {string[]}
 */
export function terrainTipLines(id, blocked = false) {
  const def = TERRAIN[id];
  const name = (def && def.name) || nameOf('terrain', id);
  const cost = terrainCostText(id, blocked);
  if (!cost) return [TERRAIN_BLOCK_TIPS[id] || name + ' — impassable.'];
  const mv = def ? def.move : 1;
  const kind = mv < 1 ? 'fast ground' : mv > 1 ? 'slow ground' : 'open ground';
  const lines = [name + ' — ' + kind + ': ' + cost + '.'];
  const note = id === 'stone' ? '' : TERRAIN_NOTES[id];
  if (note) lines.push(note);
  return lines;
}

/** C130: Colony History (Prestige tab): the layer that ended each recorded run, and its currency. */
export const HISTORY_LAYERS = Object.freeze({ run: 'Nuptial Flight', cycle: 'Supercolony', era: 'Speciation' });
export const HISTORY_GAINS = Object.freeze({ run: 'alates', cycle: 'kinship', era: 'genes' });

// ---------------------------------------------------------------------------------------------------------------
// C166–C172: automation, landing and blueprint-unlock copy (prestige engineer)
// ---------------------------------------------------------------------------------------------------------------

/** C166: what the Auto-Flight 'peak' trigger does, with the data numbers. */
export function autoFlightPeakText() {
  const pct = Math.round((1 - AUTO_FLIGHT.drop) * 100);
  return 'Flies once your alates per minute has been at least ' + pct + "% below this run's best for " + AUTO_FLIGHT.holdSec + ' s'
    + ' (after ' + Math.round(AUTO_FLIGHT.minSec / 60) + ' min). While the rate keeps rising it waits. Seasons do not count: the rate is measured without flight weather.';
}

/** C166: how Auto-Flight lands. */
export const AUTO_LANDING_TEXT = 'Lands at once: it picks the site and boon that help early growth most (lay rate, nearby food, insight), '
  + 'skipping ones you already have covered, and starts in spring if you own Seasonal Wisdom.';

/** C166: Auto-Supercolony in words. */
export const AUTO_SUPER_TEXT = "Merges automatically once the trigger is met and every requirement is done, keeping this cycle's Royal Edict.";

/** C166: where the automation toggles live (the old Federation Automation box). */
export const AUTO_POINTER_TEXT = 'Automation switches sit where they act: Auto-Flight in Flight, Auto-Supercolony in Supercolony, '
  + 'the Adaptation autobuyer in Adaptations, the chamber autobuyer in Build.';

/** C171: landing-chooser notes for traits that do not apply to the landing itself. */
export const LANDING_SHOP_NOTES = Object.freeze({
  wide_wings: 'Applies to your next flight, not this landing.',
  brood_bank: 'Applies to this landing: keeps part of the colony that just flew.',
});

/**
 * C170: Build-tab hint when saved blueprints exist but new ones cannot be saved (Ancestral Blueprint resets at a
 * Supercolony unless kept as an Heirloom; Blueprint Library is the lasting unlock). '' when saving works or nothing is saved.
 * @param {Object} s state
 * @returns {string}
 */
export function blueprintSaveHint(s) {
  const lvl = (m, id) => (m && Number.isFinite(m[id]) && m[id] > 0 ? m[id] : 0);
  const canSave = lvl(s && s.cycle && s.cycle.traits, 'ancestral_blueprint') > 0 || lvl(s && s.era && s.era.federation, 'blueprint_memory') > 0;
  const saved = Array.isArray(s && s.era && s.era.blueprints) ? s.era.blueprints.filter(Boolean).length : 0;
  if (canSave || saved === 0) return '';
  return 'Your saved layouts are kept, but saving new ones needs ' + nameOf('trait', 'ancestral_blueprint') + ' (Bloodline; it resets at a Supercolony unless kept as an Heirloom) or '
    + nameOf('federation', 'blueprint_memory') + ' (Federation).';
}

/**
 * C180 (task: Build tab Blueprints section): the hint when saved layouts exist but nothing lets the player save new
 * ones (no Ancestral Blueprint, no Blueprint Library). '' otherwise.
 * @param {Object} s state
 * @returns {string}
 */
export function blueprintLockHint(s) {
  const lvl = (m, id) => (m && Number.isFinite(m[id]) && m[id] > 0 ? m[id] : 0);
  const canSave = lvl(s && s.cycle && s.cycle.traits, 'ancestral_blueprint') > 0 || lvl(s && s.era && s.era.federation, 'blueprint_memory') > 0;
  const saved = Array.isArray(s && s.era && s.era.blueprints) ? s.era.blueprints.filter(Boolean).length : 0;
  if (canSave || saved === 0) return '';
  return 'Blueprint saving needs ' + nameOf('trait', 'ancestral_blueprint') + ' (Bloodline) or ' + nameOf('federation', 'blueprint_memory')
    + ' (Federation). Your saved layouts are kept, but none is applied after a flight until then.'; // C258
}

/** C180: the Blueprints section line while the Architect's Table (Federation) is not owned. */
export const BLUEPRINT_EDIT_LOCKED = 'Edit saved layouts by hand with ' + nameOf('federation', 'architects_table') + ' (Federation).';

/** C170: Manual lines on what unlocks blueprint saving. */
export const BLUEPRINT_UNLOCK_LINES = Object.freeze([
  'Saving a layout needs ' + nameOf('trait', 'ancestral_blueprint') + ' (Bloodline, 1 slot) or ' + nameOf('federation', 'blueprint_memory') + ' (Federation, 5 slots).',
  'Bloodline traits reset at every Supercolony unless you keep them as Heirlooms, so ' + nameOf('trait', 'ancestral_blueprint') + ' must be bought again (or kept) each cycle; '
    + nameOf('federation', 'blueprint_memory') + ' lasts the whole era.',
  'Saved layouts themselves are never lost to a Flight or a Supercolony; without either unlock they wait until you can save and switch layouts again.',
]);

// ---------------------------------------------------------------------------------------------------------------
// C182–C189 (map and combat pass): detours, source tooltips, trail slots, raid alert, expeditions
// ---------------------------------------------------------------------------------------------------------------

/** C184: who works a trail of each job, for "per forager" lines. */
const JOB_WORKER = Object.freeze({ forager: 'forager', herder: 'herder', leafcutter: 'leafcutter' });

/** C184: a per-worker yield number (0.6, 0.01, 0.005). */
function yNum(v) {
  const x = Number(v) || 0;
  return String(Math.round(x * 1e4) / 1e4);
}

/**
 * C184: "Food 0.6 + Chitin 0.01 per forager" — what a source gives each worker per second (base, before bonuses), or
 * '' for a source that is not a worker trail target.
 * @param {string} type source id
 * @returns {string}
 */
export function sourceGivesText(type) {
  const def = SOURCES[type];
  if (!def || !def.job || !JOB_WORKER[def.job]) return '';
  const parts = Object.keys(def.y || {}).filter((k) => def.y[k] > 0).map((k) => (RES_NAMES[k] || humanize(k)) + ' ' + yNum(def.y[k]));
  return parts.length ? parts.join(' + ') + ' per ' + JOB_WORKER[def.job] : '';
}

/**
 * C184: tooltip / Selected-box lines for a source: what it gives (resources and per-worker yields), how much is left
 * and in which unit, regrowth or lifetime, this season's factor, and for aphid colonies the level and the progress to
 * the next one (+1 per levelSec while ≥ herdFrac herded, up to maxLevel). Prey and the termite mound: the hunt.
 * @param {Object} s state
 * @param {Object} d derived
 * @param {Object} src source record
 * @returns {string[]}
 */
export function sourceTipLines(s, d, src) {
  const def = src ? SOURCES[src.type] : null;
  if (!def) return [];
  const lines = [];
  const ring = ringOf(Number(src.hex) || 0);
  const primary = Object.keys(def.y || {})[0] || 'food';
  const unit = (RES_NAMES[primary] || humanize(primary)).toLowerCase();
  if (def.job === 'lycaenid') {
    const minEsc = Number(def.minEscorts) || 0;
    lines.push('Honeydew ' + yNum(def.y.honeydew * (def.perRing ? ring : 1)) + '/s (' + yNum(def.y.honeydew) + ' × ring ' + ring + ') while '
      + minEsc + ' escort soldiers guard its trail.');
    lines.push('Its trail carries no workers but uses a trail slot.');
  } else if (def.job) {
    lines.push(sourceGivesText(src.type) + ' (each second, before bonuses).');
    const cap = def.capPerLevel ? def.capPerLevel * Math.max(1, Number(src.level) || 1) : def.cap;
    if (cap > 0) lines.push('Capacity ' + fmtCount(cap) + ' ' + (JOB_WORKER[def.job] || 'worker') + 's at full pay; more still help, less each.');
  } else if (def.hunt && def.hunt.apPerRing) {
    const chitin = def.hunt.chitinPerRing * ring * (def.hunt.chitinMult || 1);
    lines.push('Hunt it: power ' + fmt(def.hunt.apPerRing * ring) + ' to beat. Reward ' + fmtTime(def.hunt.foodSec) + ' of food + '
      + fmt(chitin) + ' chitin.');
  } else if (def.hunt) {
    lines.push('Raid it for ' + fmtTime(def.hunt.foodSec) + ' of food + ' + fmt(def.hunt.chitinPerRing * ring) + ' chitin per raid.');
  }
  if (def.stock) {
    const stock = Math.max(0, Number(src.stock) || 0);
    const max = Math.max(0, Number(src.max) || 0);
    if (src.data && src.data.unsized) lines.push('Stock: sized when it is first seen.');
    else {
      lines.push('Stock ' + fmt(stock) + ' / ' + fmt(max) + ' ' + unit + (def.stock.regrow > 0
        ? ': regrows ' + yNum(def.stock.regrow * 100) + '% of max per second.' : ': gone when empty.'));
    }
  } else if (def.job) {
    lines.push('Never runs out.');
  }
  const rot = def.fx && def.fx.rotAfter > 0 ? def.fx.rotAfter : 0;
  if (rot > 0) {
    const age = Number(src.age) || 0;
    lines.push(age < rot ? 'Starts rotting in ' + fmtTime(Math.ceil(rot - age)) + '.' : 'Rotting: ' + yNum(def.fx.rotPerSec * 100) + '% of max lost per second.');
  }
  if (Number(src.ttl) >= 0) lines.push('Gone in ' + fmtTime(Math.ceil(Number(src.ttl))) + '.');
  const sid = d && d.season ? d.season.srcId || d.season.id : null;
  const f = sid && sid !== 'neutral' && def.season && Number.isFinite(def.season[sid]) ? def.season[sid] : 1;
  if (def.job && f !== 1) lines.push(f === 0 ? 'Dormant this season (×0).' : 'This season ×' + yNum(f) + '.');
  if (def.capPerLevel && def.fx && def.fx.levelSec > 0) {
    const L = Math.max(1, Number(src.level) || 1);
    const maxL = def.fx.maxLevel || 1;
    if (L >= maxL) lines.push('Level ' + L + ' / ' + maxL + ' (max).');
    else {
      const need = (def.fx.herdFrac || 1) * def.capPerLevel * L;
      let herders = 0;
      const dts = d && d.surface && Array.isArray(d.surface.trails) ? d.surface.trails : [];
      for (const t of (s && s.run && s.run.surface && s.run.surface.trails) || []) {
        if (!t || t.src !== src.uid) continue;
        const e = dts.find((x) => x && x.uid === t.uid);
        herders += Number(e ? e.workers : t.workers) || 0;
      }
      const prog = Math.min(1, Math.max(0, (Number(src.herdT) || 0) / def.fx.levelSec));
      lines.push('Level ' + L + ' / ' + maxL + ': ' + Math.floor(prog * 100) + '% to level ' + (L + 1) + '.');
      const per = def.fx.levelSec % 60 === 0 ? def.fx.levelSec / 60 + ' min' : fmtTime(def.fx.levelSec);
      lines.push('+1 level per ' + per + ' while ≥ ' + fmtCount(Math.ceil(need)) + ' herders work it (now '
        + fmtCount(herders) + ').');
    }
  }
  if (src.data && src.data.find) lines.push('Found by your scouts beyond the border.');
  return lines;
}

/**
 * C182: a trail's detour state in words: { short: row badge, line: explanation } or null when on its own route.
 * @param {{ mode: string, why: string }|null} info trails.detourInfo
 * @returns {{ short: string, line: string } | null}
 */
export function detourText(info) {
  if (!info) return null;
  const what = info.why === 'molehill' ? 'a molehill' : 'a flooded puddle';
  if (info.mode === 'paused') {
    return { short: 'Paused', line: 'Paused: ' + what + ' blocks the way and there is no way round. It reopens when that clears.' };
  }
  return { short: 'Detour', line: 'Detour round ' + what + ': free and temporary; the trail returns to its route when it clears.' };
}

/**
 * C184: "Trails 7 / 11" — trail slots used / available.
 * @param {number} used
 * @param {number} slots
 * @returns {string}
 */
export function trailSlotsText(used, slots) {
  return 'Trails ' + fmtCount(Math.max(0, Number(used) || 0)) + ' / ' + fmtCount(Math.max(0, Number(slots) || 0));
}

/** C188: names and tooltips of the scout expedition finds that are map objects. */
export const FIND_NAMES = Object.freeze({ fossil_cache: 'Fossil cache', lost_queen: 'Lost queen' });
export const FIND_TIPS = Object.freeze({
  fossil_cache: 'Found by your scouts. Click to dig it up for insight.',
  lost_queen: 'A lost queen found by your scouts. Click to take her in.',
});

/**
 * C187: the raid alert of the Map tab: what the colony can do about the incoming raid right now.
 * @param {{ trailRaid: boolean, garrison: number, guardSent: boolean, polymorphism: boolean, escorts: number }} o
 * @returns {{ text: string, action: 'dispatch'|'view'|null }}
 */
export function raidAlertCopy(o) {
  const g = Math.max(0, Math.floor(Number(o.garrison) || 0));
  const raise = o.polymorphism ? 'raise soldiers (soldier eggs, Colony tab)' : 'research ' + nameOf('research', 'polymorphism') + ' to raise soldiers';
  if (o.trailRaid) {
    if (o.guardSent) return { text: 'The garrison is on its way to the trail.', action: 'view' };
    if (g > 0) return { text: 'Send the garrison (' + fmtCount(g) + ') to defend the trail.', action: 'dispatch' };
    if (o.escorts > 0) {
      return { text: 'No soldiers at home: the trail’s ' + fmtCount(o.escorts) + ' escorts fight alone. For more, ' + raise + '.', action: null };
    }
    return { text: 'No soldiers at home — ' + raise + '. Escorts on a trail defend it from raids.', action: null };
  }
  if (g > 0) return { text: 'Your garrison (' + fmtCount(g) + ') defends the entrance automatically.', action: 'view' };
  return { text: 'No soldiers at home — ' + raise + '; the garrison defends the entrance automatically.', action: null };
}

/** C234: Settings → Sound copy (labels and ≤ 12-word tooltips). */
export const SOUND_COPY = Object.freeze({
  title: 'Sound',
  master: 'Sound effects',
  masterTip: 'Short synthesised sounds. Saved for this browser only.',
  volume: 'Volume',
  volumeTip: 'How loud the sound effects play.',
  actions: 'Actions',
  actionsTip: 'Clicks, purchases, building, digging, trails and refusals.',
  alerts: 'Alerts',
  alertsTip: 'Events, raids, battles, achievements, reveals and ceremonies.',
  ambience: 'Ambience',
  ambienceTip: 'Season changes and finished chambers.',
  test: 'Test',
  testTip: 'Play a sample chime.',
  note: 'Sounds start after your first click or key press, and pause while the tab is hidden.',
  unavailable: 'Sound is not available in this browser.',
});
