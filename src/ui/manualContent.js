// In-game Manual content (C131): the entries of every Manual section, built from the live data tables and the
// systems' query functions so the numbers always match the game, and gated by what the player has unlocked or seen
// (reveal keys, research, sightings, Field Guide flags), so nothing unrevealed is ever named. Pure module: no DOM; the
// renderer is src/ui/manual.js. Owner: WP9. Contract: ARCHITECTURE §14.6 (Manual), §18 C131; DESIGN §25.3.
//
// Model: SECTIONS (index order) and ENTRY_DEFS. A def is { id, section, gate(s, d) → bool, sig?(s, d) → string,
// build(s, d) → Entry }. Entry = { id, title, kw?, blocks: Block[], links?: [{ entry, label }], tabs?: [{ tab, sub?,
// label }] }. Block = { p } | { note } | { h } | { list: Text[] } | { kv: [[label, Text]] } | { table: { head, rows } }
// | { box: { title, kv } }. Text = string | { live(s, d) → string } (live values are refreshed in place while the
// Manual is open; the structure is rebuilt only when manualSignature changes).

import { isShown, hasResearch, traitLevel, fedLevel, genomeLevel, num, arr, obj } from './reveal.js';
import { fmt, fmtCount, fmtRate, fmtMult, fmtPct, fmtTime, fmtCost, MAX_LABEL } from './format.js';
import {
  nameOf, RES_NAMES, JOB_TIPS, CHAMBER_TIPS, placementRuleLines, levelGainText, adjacencyLines, RESEARCH_TIPS, TRAIT_TIPS, FED_TIPS,
  GENOME_TIPS, HARDSHIP_TIPS, EDICT_TIPS, SPECIES_TIPS, SEASON_NAMES, EVENT_COPY, CHOICE_TIPS, CHOICE_LABELS, BOTTLENECK_NAMES,
  BOTTLENECK_TIPS, TAB_NAMES, SUBTAB_NAMES, ADAPT_TIPS,
} from './text.js';
import { chamberKey, maxInstances, queueLimit } from './panels/build.js';
import { SHORTCUTS } from './panels/settings.js';
import { FLIGHT_RESETS, FLIGHT_KEEPS } from './modals.js';
import { bottleneckText } from './hud.js';
import { placementCost, placementRows, levelGain, cheapestLevel, rootCap, rootCost } from '../systems/nest.js';
import { jobCap, idleMinors } from '../systems/jobs.js';
import { isAvailable as researchAvailable, isOwned as researchOwned, refinementCost } from '../systems/research.js';
import { cost as adaptCost, isAvailable as adaptAvailable } from '../systems/adaptations.js';
import { traitCost, fedCost, genomeCost } from '../systems/traits.js';
import { moundCost, claimCost } from '../systems/surface.js';
import { projectAlates, projectKinship, projectGenes } from '../systems/prestige.js';
import { effectMult } from '../core/effects.js';
import { CASTES } from '../data/castes.js';
import { JOB_ORDER, JOBS, LOOSE_FORAGE, THRESHOLDS, PRESETS } from '../data/jobs.js';
import { CHAMBER_ORDER, CHAMBERS, CHAMBER_RULES, ADJACENCY, ADJACENCY_ORDER } from '../data/chambers.js';
import { LAYER_ORDER, LAYERS, MICRO, DIG, GEOM } from '../data/strata.js';
import { EGG, LAY, BROOD, HUNGRY, PHEROMONE, CAPS, NUTRITION } from '../data/economy.js';
import { SEASON_ORDER, SEASON_MODS, YEAR, FROST } from '../data/seasons.js';
import { SOURCE_ORDER, SOURCES } from '../data/sources.js';
import { MAP, SCOUT, TRAIL, SLOTS, ABILITIES, TERRITORY, MOUND } from '../data/surface.js';
import { ACTIONS, REWARDS, TACTICAL, RAIDS } from '../data/combat.js';
import { RIVALS, TRAITS as RIVAL_TRAITS, BOSSES, ELDER, GROWTH } from '../data/rivals.js';
import { EVENT_ORDER, EVENTS } from '../data/events.js';
import { FIELD_GUIDE } from '../data/fieldGuide.js';
import { BRANCH_ORDER, RESEARCH, RESEARCH_ORDER, REFINEMENT, INNATE } from '../data/research.js';
import { ADAPTATION_ORDER, ADAPTATIONS } from '../data/adaptations.js';
import { FLIGHT, LINEAGE, SUPER, SPEC, PASSIVE, HARDSHIP, HARDSHIP_ORDER, EDICT_ORDER, ACH_META } from '../data/prestige.js';
import { TRAIT_ORDER, TRAITS } from '../data/bloodline.js';
import { FED_ORDER, FEDERATION } from '../data/federation.js';
import { GENOME_ORDER, GENOME, SPECIES_ORDER, SPECIES } from '../data/genome.js';
import { DRAINAGE, ROOTS, ROOT_CULT } from '../data/soilFeatures.js';
import { SOFTCAPS, CLICK_CAP } from '../data/balance.js';

/** Keys that open and close the Manual (app.js key handler; also listed under Controls and in Settings). */
export const MANUAL_KEYS = Object.freeze(['h', 'H', '?']);

/** Sections in index order. */
export const SECTIONS = Object.freeze([
  { id: 'start', title: 'Getting started' },
  { id: 'resources', title: 'Resources' },
  { id: 'ants', title: 'Ant types & jobs' },
  { id: 'chambers', title: 'Chambers & nest' },
  { id: 'surface', title: 'Surface' },
  { id: 'combat', title: 'Combat & rivals' },
  { id: 'seasons', title: 'Seasons & events' },
  { id: 'research', title: 'Research' },
  { id: 'prestige', title: 'Prestige' },
  { id: 'controls', title: 'Controls & hotkeys' },
].map(Object.freeze));

/** Muted line under a section that still has locked entries (never names them). */
export const MORE_NOTE = 'More entries unlock as your colony grows.';

// ---------------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------------

/** A live value: re-evaluated at 4 Hz while the Manual shows it. */
const live = (fn) => ({ live: fn });

/** Safe call. */
function q(fn, fallback = null) {
  try {
    const v = fn();
    return v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? fallback : v;
  } catch {
    return fallback;
  }
}

/** "40 food, 24 soil" ('MAX' for a null cost, 'free' for an empty one). */
export function costText(cost) {
  const parts = fmtCost(cost);
  if (parts.length === 1 && !parts[0].res) return MAX_LABEL;
  if (!parts.length) return 'free';
  return parts.map((p) => n0(cost[p.res]) + ' ' + (RES_NAMES[p.res] || p.res).toLowerCase()).join(', ');
}

/** "+15%" from 0.15 (no sign for 0). */
const pct = (x) => fmtPct(num(x));
/** "15%" unsigned. */
const upct = (x) => fmtPct(num(x), { signed: false });
/** Plain number text: integers as counts, else one-decimal / suffixed. */
const n0 = (x) => (Math.abs(num(x) - Math.round(num(x))) < 1e-9 ? fmtCount(num(x)) : fmt(num(x)));

/** Chamber type shown (its unlock key revealed; the Royal Chamber always). */
export function chamberShown(s, id) {
  const key = chamberKey(id);
  return key ? isShown(s, key) : true;
}

/** Caste shown (its unlock key revealed; queen and minor always). */
export function casteShown(s, id) {
  if (id === 'queen' || id === 'minor') return true;
  const c = CASTES[id];
  return !!(c && c.unlock && isShown(s, c.unlock));
}

/** Job shown (its unlock key revealed; forager always). */
export function jobShown(s, id) {
  const j = JOBS[id];
  return !!j && (!j.unlock || isShown(s, j.unlock));
}

/** Deepest row this colony ever reached (this run or any run). */
function deepestRow(s) {
  return Math.max(num(s && s.run && s.run.nest && s.run.nest.deepestRow), num(s && s.meta && s.meta.stats && s.meta.stats.deepestRow));
}

/** Soil layers the player has reached (their top row dug down to, any run). */
export function layersSeen(s) {
  const deep = deepestRow(s);
  return LAYER_ORDER.filter((id) => LAYERS[id] && LAYERS[id].y0 <= deep);
}

const layerSeen = (s, id) => layersSeen(s).includes(id);

/** Collect the values of `key` inside a Field Guide trigger tree. */
function triggerValues(t, key, out = []) {
  if (!t || typeof t !== 'object') return out;
  if (typeof t[key] === 'string') out.push(t[key]);
  for (const k of ['all', 'any']) for (const c of arr(t[k])) triggerValues(c, key, out);
  return out;
}

/** Ids of `key` ('rival' | 'source' | 'ev') named by Field Guide entries the player has unlocked. */
function fgSeen(s, key) {
  const fg = obj(s && s.meta && s.meta.fieldGuide);
  const out = new Set();
  for (const id of Object.keys(fg)) {
    const e = FIELD_GUIDE[id];
    if (e) for (const v of triggerValues(e.trigger, key)) out.add(v);
  }
  return out;
}

/**
 * Random events this colony has met (no per-event history is saved, so it is inferred): Field Guide entries tied to an
 * event, the lifetime event counters (rainstorms, mole tunnels, mold scraped, ladybugs), the first-run scripted fruit,
 * and whatever is active right now (card, effect, map object).
 * @param {Object} s
 * @returns {string[]} event ids in EVENT_ORDER
 */
export function eventsSeen(s) {
  const seen = fgSeen(s, 'ev');
  const c = obj(s && s.meta && s.meta.counters);
  if (num(c.rainstorms) > 0) seen.add('ev_rainstorm');
  if (num(c.moleTunnels) > 0) seen.add('ev_mole_tunnel');
  if (num(c.moldScraped) > 0) seen.add('ev_mold_bloom');
  if (num(c.ladybugs) > 0) seen.add('ev_ladybug_raid');
  const ev = obj(s && s.run && s.run.events);
  if (ev.scripted) seen.add('ev_fallen_fruit');
  if (ev.card && typeof ev.card.id === 'string') seen.add(ev.card.id);
  for (const a of arr(ev.active)) if (a && typeof a.id === 'string') seen.add(a.id);
  for (const e of arr(s && s.run && s.run.effects)) if (e && typeof e.id === 'string' && EVENTS[e.id]) seen.add(e.id);
  return EVENT_ORDER.filter((id) => seen.has(id));
}

/** Source types seen: on a revealed hex this run, or named by an unlocked Field Guide entry. */
export function sourcesSeen(s) {
  const seen = fgSeen(s, 'source');
  const sf = obj(s && s.run && s.run.surface);
  const rev = arr(sf.revealed);
  for (const src of arr(sf.sources)) if (src && SOURCES[src.type] && rev[src.hex] === 1) seen.add(src.type);
  return SOURCE_ORDER.filter((id) => seen.has(id));
}

/** Rival species sighted: this run (rival.sighted) or ever (Field Guide). Bosses excluded. */
export function rivalsSeen(s) {
  const seen = fgSeen(s, 'rival');
  let elder = false;
  for (const r of arr(s && s.run && s.run.rivals && s.run.rivals.list)) {
    if (!r || !r.sighted) continue;
    if (r.type === ELDER.id) elder = true;
    else seen.add(r.type);
  }
  const out = Object.keys(RIVALS).filter((id) => seen.has(id)).sort((a, b) => RIVALS[a].tier - RIVALS[b].tier);
  if (elder) out.push(ELDER.id);
  return out;
}

/** Bosses revealed: sighted this run, named by a visible Prestige checklist, or met as an event / Field Guide entry. */
export function bossesSeen(s) {
  const sighted = new Set(arr(s && s.run && s.run.rivals && s.run.rivals.list).filter((r) => r && r.sighted).map((r) => r.type));
  const fgR = fgSeen(s, 'rival');
  const out = [];
  if (sighted.has('old_ridge_supercolony') || isShown(s, 'tab_federation_teaser')) out.push('old_ridge_supercolony');
  if (sighted.has('great_rival') || fgR.has('great_rival') || isShown(s, 'tab_genome_teaser')) out.push('great_rival');
  if (eventsSeen(s).includes('ev_army_ant_column')) out.push('army_ant_column');
  return out;
}

/** √(ATK × HP). */
const unitPower = (atk, hp) => Math.sqrt(num(atk) * num(hp));

/** "Open the X tab" button spec, when that tab is visible. */
const tabBtn = (tab, sub = null) => ({ tab, sub, label: 'Open ' + (sub ? TAB_NAMES[tab] + ' → ' + (SUBTAB_NAMES[sub] || sub) : TAB_NAMES[tab]) + ' tab' });

/** Current amount of a resource (prestige currencies included). */
function resNow(s, r) {
  if (r === 'alates') return num(s.cycle && s.cycle.alates);
  if (r === 'kinship') return num(s.era && s.era.kinship);
  if (r === 'genes') return num(s.meta && s.meta.genes);
  return num(s.run && s.run.res && s.run.res[r]);
}

/** "123 / 400 (cap)" or "123". */
function amountText(s, d, r, capKey) {
  const v = resNow(s, r);
  const cap = capKey ? num(d && d.stats ? d.stats[capKey] : NaN, NaN) : NaN;
  return fmt(v) + (Number.isFinite(cap) && cap > 0 ? ' / ' + fmt(cap) : '');
}

/** Net rate text of a run resource. */
function rateText(d, r) {
  const v = num(d && d.rates && d.rates[r] ? d.rates[r].net : 0);
  return fmtRate(v);
}

/** Gated text parts → the visible ones. part = string | [text, gate(s) → bool]. */
function gated(s, parts) {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') out.push(p);
    else if (Array.isArray(p) && q(() => p[1](s), false)) out.push(p[0]);
  }
  return out;
}

/** Names of chambers and castes the player has not unlocked yet (never printed). */
export function hiddenNames(s) {
  const out = [];
  for (const id of CHAMBER_ORDER) if (!chamberShown(s, id)) out.push(CHAMBERS[id].name);
  for (const id of ['soldier', 'supermajor', 'replete', 'alate']) if (!casteShown(s, id)) out.push(CASTES[id].name);
  return out;
}

/** Copy from text.js, or '' when it names a chamber or caste that is not unlocked yet. */
function tip(s, table, id) {
  const text = table && typeof table[id] === 'string' ? table[id] : '';
  if (!text) return '';
  return hiddenNames(s).some((n) => text.includes(n)) ? '' : text;
}

/** Joined list or a fallback. */
const joinOr = (list, fb) => (list.length ? list.join(', ') + '.' : fb);

// ---------------------------------------------------------------------------------------------------------------
// 1. Getting started
// ---------------------------------------------------------------------------------------------------------------

const START_STEPS = [
  { key: null, text: 'Click the glowing crumb beside the entrance to bring in food. The queen turns food into eggs, and eggs hatch into workers.' },
  { key: 'panel_colony', text: 'Assign jobs in the Colony tab. Foragers carry food home; every job has its own entry under Ant types & jobs.' },
  { key: 'job_digger', text: 'Diggers carve the nest and produce soil, which pays for chamber levels.' },
  { key: 'panel_build', text: 'When the nest is full, place chambers from the Build tab and click one to grow it a level.' },
  { key: 'trail_slots', text: 'Drag a trail on the map from an entrance to a source. Longer and richer trails pay more; each source takes one trail.' },
  { key: 'panel_research', text: 'Scouts reveal the map. Every revealed hex gives insight, spent in the Research tab.' },
  { key: 'panel_rivals', text: 'Rival colonies share the map. Read their strength before you raid.' },
  { key: 'panel_prestige', text: 'The Prestige tab leads to the Nuptial Flight: a fresh start that earns alates and lasting upgrades.' },
];

const DEF_START = [
  {
    id: 'start:loop', section: 'start', gate: () => true,
    sig: (s) => START_STEPS.map((st) => (st.key && !isShown(s, st.key) ? 0 : 1)).join(''),
    build: (s) => {
      const steps = START_STEPS.filter((st) => !st.key || isShown(s, st.key)).map((st) => st.text);
      const blocks = [
        { p: 'Six Legs Deep is a colony that grows itself: food becomes eggs, eggs become ants, and ants bring in more food. '
          + 'Your job is to remove whatever is holding that loop back.' },
        { h: 'What to do now' },
        { list: steps },
      ];
      if (isShown(s, 'panel_build')) {
        blocks.push({ h: 'What is holding you back' });
        blocks.push({ kv: [['Bottleneck', live((s2, d2) => bottleneckText(s2, d2) || 'Nothing is binding right now.')],
          ['How to fix it', live((s2) => BOTTLENECK_TIPS[obj(s2.run.bottleneck).id] || '—')]] });
        blocks.push({ note: 'The badge at the top names the limit that binds first. Fixing one limit makes another bind: that is the rhythm of the game.' });
      }
      blocks.push({ note: 'Press H or ? to open or close this Manual anywhere.' });
      const links = [{ entry: 'res:food', label: 'Food' }, { entry: 'caste:queen', label: 'The queen and brood' }];
      if (isShown(s, 'panel_build')) links.push({ entry: 'chamber:gallery', label: nameOf('chamber', 'gallery') });
      return { title: 'The core loop', kw: 'how to play tutorial loop bottleneck', blocks, links, tabs: isShown(s, 'panel_colony') ? [tabBtn('colony')] : [] };
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// 2. Resources
// ---------------------------------------------------------------------------------------------------------------

/** Resource defs: gate key, cap stat key, producers / sinks as gated parts, extra rule lines. */
const RESOURCES = [
  { res: 'food', key: null, cap: 'foodCap',
    from: ['Foragers on trails', 'clicks on sources', ['loot from raids', (s) => isShown(s, 'panel_war')], ['events', (s) => isShown(s, 'events')],
      ['seed caches in the soil', (s) => num(s.meta.counters.caches) > 0]],
    to: ['Eggs (the queen spends it on her own)', 'ant upkeep', ['chambers', (s) => isShown(s, 'panel_build')], ['Adaptations', (s) => isShown(s, 'adapt_basic')]],
    rules: (s) => gated(s, [
      'Cap: ' + n0(CHAMBERS.royal_chamber.fx.storage) + ' in the Royal Chamber' + (chamberShown(s, 'granary') ? ', plus every Granary.' : '.'),
      ['Autumn raises the cap ×' + CAPS.autumn + '.', (s2) => isShown(s2, 'season_dial')],
      ['Each replete adds ' + pct(CASTES.replete.fx.capBonus) + ' to the cap.', (s2) => casteShown(s2, 'replete')],
      'One-shot rewards can push food above the cap; production adds nothing until it falls back under.',
      'Food at 0 with a falling rate makes the colony Hungry: laying stops and output drops to ×' + HUNGRY.outputMult + '. Nobody starves.',
    ]),
    tab: 'colony', links: [['caste:queen', 'The queen and brood'], ['job:forager', 'Forager'], ['chamber:granary', 'Granary']] },
  { res: 'soil', key: 'job_digger', cap: null,
    from: ['Diggers: one soil per unit of dig work, even when the dig queue is empty'],
    to: [['chamber levels', (s) => isShown(s, 'panel_build')], ['the Mound', (s) => isShown(s, 'mound')], ['draining water pockets', (s) => hasResearch(s, 'drainage')]],
    rules: () => ['No cap.'], tab: 'build', links: [['job:digger', 'Digger'], ['nest:digging', 'Digging']] },
  { res: 'insight', key: 'panel_research', cap: null,
    from: ['Scouts revealing hexes', ['the Scent Library', (s) => chamberShown(s, 'scent_library')], 'Field Guide entries',
      ['fossil caches', (s) => num(s.meta.counters.caches) > 0], ['conquests', (s) => isShown(s, 'panel_war')]],
    to: ['Research'], rules: () => ['No cap.'], tab: 'research', links: [['job:scout', 'Scout'], ['surface:scouting', 'Scouting']] },
  { res: 'pheromone', key: 'res_pheromone', cap: 'pheromoneCap',
    from: ['Regenerates on its own: ' + PHEROMONE.regenBase + ' + ' + PHEROMONE.regenPerSqrtAdult + ' × √adults per second'],
    to: [['Mark', (s) => isShown(s, 'ability_mark')], ['Rally', (s) => isShown(s, 'ability_rally')], ['Frenzy', (s) => isShown(s, 'ability_frenzy')],
      ['hex claims', (s) => isShown(s, 'hex_claim')], ['battle tactics', (s) => isShown(s, 'panel_war')]],
    rules: (s) => gated(s, ['Cap: ' + PHEROMONE.capBase + ' + ' + PHEROMONE.capPerMound + ' per Mound level.',
      ['Pheromone Glands: +' + n0(RESEARCH.pheromone_glands.fx.cap) + ' cap, regeneration ×' + RESEARCH.pheromone_glands.fx.regen + '.',
        (s2) => hasResearch(s2, 'pheromone_glands')]]),
    tab: 'map', links: [['surface:abilities', 'Pheromone abilities']] },
  { res: 'chitin', key: 'res_chitin', cap: null,
    from: ['Dead insects on trails', ['prey hunts and battles', (s) => isShown(s, 'panel_war')], ['beetle-husk caches', (s) => num(s.meta.counters.caches) > 0],
      ['moults of newly hatched ants', (s) => isShown(s, 'caste_soldier')], ['Middens', (s) => chamberShown(s, 'midden')]],
    to: [['soldier eggs', (s) => casteShown(s, 'soldier')], ['supermajor eggs', (s) => casteShown(s, 'supermajor')],
      ['military Adaptations', (s) => isShown(s, 'adapt_military')], ['the Gate', (s) => chamberShown(s, 'gate')]],
    rules: (s) => gated(s, ['No cap.', ['The chitin reserve slider keeps an amount back from soldier eggs.', (s2) => casteShown(s2, 'soldier')]]),
    tab: 'colony', links: [['source:dead_insect', nameOf('source', 'dead_insect')]] },
  { res: 'honeydew', key: 'res_honeydew', cap: 'honeydewCap',
    from: ['Herders milking aphid colonies', ['Root Aphid Pens', (s) => chamberShown(s, 'root_aphid_pen')], 'a trace from flower patches',
      ['Lycaenid caterpillars', (s) => hasResearch(s, 'lycaenid_clients')]],
    to: [["Queen's Feast and Sweet Tooth", (s) => isShown(s, 'adapt_honeydew')], ['replete eggs', (s) => casteShown(s, 'replete')],
      ['alate rearing', (s) => isShown(s, 'alate_rearing')], ['bribes', (s) => isShown(s, 'panel_rivals')]],
    rules: () => ['Cap: ' + CAPS.honeydewBase + ' + ' + pct(CAPS.honeydewFrac).replace('+', '') + ' of the food cap.'],
    tab: 'colony', links: [['job:herder', 'Herder']] },
  { res: 'leaves', key: 'res_fungus', cap: 'leafCap',
    from: ['Leafcutters on leaf-plant trails'], to: ['Gardeners, who turn them into fungus'],
    rules: () => ['Cap: ' + n0(CHAMBERS.fungus_garden.fx.leafCap) + ' per Fungus Garden level.', 'Shown in the fungus widget, not on the rail.'],
    tab: 'colony', links: [['job:leafcutter', 'Leafcutter'], ['chamber:fungus_garden', nameOf('chamber', 'fungus_garden')]] },
  { res: 'fungus', key: 'res_fungus', cap: 'fungusCap',
    from: ['Gardeners in Fungus Gardens'],
    to: ['Nutrition: every adult eats ' + NUTRITION.perAdult + ' fungus/s, and a fed colony works ×(1 + ' + NUTRITION.coef + ' × fed share)',
      ['supermajor eggs', (s) => casteShown(s, 'supermajor')], 'Fungal Brood (faster brood)'],
    rules: () => ['Cap: ' + n0(CHAMBERS.fungus_garden.fx.fungusCap) + ' per Fungus Garden level.', 'Larvae eat first: egg costs are paid before Nutrition.'],
    tab: 'colony', links: [['job:gardener', 'Gardener'], ['chamber:fungus_garden', nameOf('chamber', 'fungus_garden')]] },
  { res: 'alates', key: 'panel_prestige', cap: null, prestige: true,
    from: ['Nuptial Flights'], to: [['Bloodline traits', (s) => isShown(s, 'tab_bloodline')]],
    rules: () => ['Kept through Flights. Spending never lowers Lineage, which counts every alate earned this cycle.'],
    tab: 'prestige', links: [['prestige:flight', 'Nuptial Flight']] },
  { res: 'kinship', key: 'tab_federation', cap: null, prestige: true,
    from: ['Forming a Supercolony'], to: ['Federation nodes'],
    rules: () => ['Kept through Flights and Supercolonies. Its lifetime total powers a passive bonus.'],
    tab: 'prestige', links: [['prestige:super', 'Supercolony']] },
  { res: 'genes', key: 'tab_genome', cap: null, prestige: true,
    from: ['Speciation'], to: ['Genome nodes'], rules: () => ['Never reset.'],
    tab: 'prestige', links: [['prestige:spec', 'Speciation']] },
];

const DEF_RESOURCES = RESOURCES.map((R) => ({
  id: 'res:' + R.res, section: 'resources',
  gate: (s) => !R.key || isShown(s, R.key),
  sig: (s) => gated(s, R.from).length + ':' + gated(s, R.to).length + ':' + R.rules(s).length,
  build: (s) => {
    const kv = [['You have', live((s2, d2) => amountText(s2, d2, R.res, R.cap))]];
    if (!R.prestige) kv.push(['Net rate', live((s2, d2) => rateText(d2, R.res))]);
    const links = R.links.map(([entry, label]) => ({ entry, label }));
    return {
      title: RES_NAMES[R.res], kw: 'resource ' + R.res,
      blocks: [
        { kv },
        { h: 'Produced by' }, { p: joinOr(gated(s, R.from), 'More sources appear as your colony grows.') },
        { h: 'Spent on' }, { p: joinOr(gated(s, R.to), 'Its uses appear as your colony grows.') },
        { h: 'Rules' }, { list: R.rules(s) },
      ],
      links, tabs: [tabBtn(R.tab)],
    };
  },
}));

// ---------------------------------------------------------------------------------------------------------------
// 3. Ant types, jobs and automation
// ---------------------------------------------------------------------------------------------------------------

/** Where each caste lives: [chamber id, label]. */
const HOUSE = {
  housing: ['gallery', 'housing (the Royal Chamber and Galleries)'],
  berths: ['barracks', 'Barracks berths'],
  warBerths: ['war_hall', 'War Hall berths'],
  repleteBerths: ['repletion_hall', 'Repletion Hall berths'],
  alateCells: ['nuptial_chamber', 'alate cells in the Nuptial Chamber'],
};

/** "×5 the egg cost + 1 chitin (+0.02 per soldier)". */
function extraText(extra) {
  const out = [];
  for (const r of Object.keys(obj(extra))) {
    const v = extra[r];
    const name = (RES_NAMES[r] || r).toLowerCase();
    if (typeof v === 'number') out.push(n0(v) + ' ' + name);
    else if (v && Number.isFinite(v.perOwned)) out.push(n0(v.base) + ' ' + name + ' (+' + v.perOwned + ' per one you own)');
    else if (v && Number.isFinite(v.growth)) out.push(n0(v.base) + ' ' + name + ' (×' + v.growth + ' per one laid this run)');
  }
  return out.join(' + ');
}

const CASTE_HOW = {
  minor: 'Every egg is a minor worker unless the caste sliders ask for something else.',
  soldier: 'Set a soldier share on the caste slider (Colony tab). The queen lays one when a berth is free and chitin is there.',
  supermajor: 'Set a supermajor share on the caste slider. Each needs a free War Hall berth, chitin and fungus.',
  replete: 'Set a replete share on the caste slider. Repletes hang from the ceiling and do not work.',
  alate: 'Rear them in Prestige → Flight (Rear 1 / Rear 5, or Auto-rear). Each one boosts your next Flight.',
};

const CASTE_TABS = { minor: tabBtn('colony'), soldier: tabBtn('colony'), supermajor: tabBtn('colony'), replete: tabBtn('colony'), alate: tabBtn('prestige', 'flight') };

/** Adults of a caste right now. */
function adultsOf(s, c) {
  if (c === 'alate') return num(s.run.colony.alatesReared);
  if (c === 'queen') return Math.max(1, arr(s.run.nest.chambers).filter((ch) => ch && ch.type === 'royal_chamber' && ch.status === 'active').length);
  return num(s.run.colony.adults[c]);
}

const DEF_QUEEN = {
  id: 'caste:queen', section: 'ants', gate: () => true,
  sig: (s) => [isShown(s, 'panel_colony'), isShown(s, 'season_dial'), casteShown(s, 'soldier')].map(Number).join(''),
  build: (s) => ({
    title: 'The queen and brood', kw: 'queen lay rate egg cost brood nurse hungry housing slots',
    blocks: [
      { p: 'The queen lays eggs whenever food covers the egg cost, a brood slot is free and housing has room. Eggs develop into adults '
        + 'in the brood slots. She counts as one nurse, never eats, and never leaves the Royal Chamber.' },
      { kv: [
        ['Lay rate', live((s2, d2) => fmtRate(num(d2.stats.layRate)) + ' eggs')],
        ['Next egg costs', live((s2, d2) => fmt(num(d2.stats.eggCost && d2.stats.eggCost.minor)) + ' food')],
        ['Brood', live((s2, d2) => fmtCount(arr(s2.run.colony.brood).reduce((a, c) => a + num(c && c.n), 0)) + ' / ' + fmtCount(num(d2.stats.broodSlots)) + ' slots')],
        ['Housing', live((s2, d2) => fmtCount(num(s2.run.colony.adults.minor)) + ' minors / ' + fmtCount(num(d2.stats.housing)))],
      ] },
      { h: 'Rules' },
      { list: gated(s, [
        'Base lay rate ' + LAY.base + ' eggs/s, ×' + LAY.perRC + ' for every Royal Chamber level above 1.',
        'Egg cost ' + EGG.base + ' × (1 + ' + EGG.k + ' × N)^' + EGG.exp + ' food, where N counts every adult and every egg, larva and pupa.',
        'The first ' + EGG.nanitics + ' eggs of a run cost half (nanitics).',
        'Brood takes ' + BROOD.baseSec + ' s to develop' + (isShown(s, 'panel_colony') ? ', shortened by nurses: up to ' + BROOD.maxNursePerSlot + ' nurses per brood slot help.' : '.'),
        ['Spring lays ×' + SEASON_MODS.spring.lay + ' and raises brood faster; winter slows both.', (s2) => isShown(s2, 'season_dial')],
        ['Soldier and other caste eggs cost more and wait for their own berth.', (s2) => casteShown(s2, 'soldier')],
        'Out of food: the colony turns Hungry, laying stops until food is back above ' + upct(HUNGRY.endFrac) + ' of the cap.',
      ]) },
    ],
    links: [{ entry: 'chamber:royal_chamber', label: nameOf('chamber', 'royal_chamber') }, { entry: 'job:nurse', label: 'Nurse' }],
    tabs: isShown(s, 'panel_colony') ? [tabBtn('colony')] : [],
  }),
};

const DEF_CASTES = ['minor', 'soldier', 'supermajor', 'replete', 'alate'].map((c) => ({
  id: 'caste:' + c, section: 'ants', gate: (s) => casteShown(s, c),
  sig: (s) => (HOUSE[CASTES[c].house] ? Number(chamberShown(s, HOUSE[CASTES[c].house][0])) : 0) + ':' + Number(isShown(s, 'panel_war')),
  build: (s) => {
    const def = CASTES[c];
    const kv = [['You have', live((s2) => fmtCount(adultsOf(s2, c)))]];
    kv.push(['Egg cost', c === 'minor' ? 'the base egg cost (it rises as the colony grows)'
      : '×' + def.eggMult + ' the base egg cost' + (extraText(def.extra) ? ' + ' + extraText(def.extra) : '')]);
    kv.push(['Next egg', live((s2, d2) => {
      const f = num(d2.stats.eggCost && d2.stats.eggCost[c]);
      const ex = obj(d2.stats.eggExtra && d2.stats.eggExtra[c]);
      return [fmt(f) + ' food', ...Object.keys(ex).filter((r) => num(ex[r]) > 0).map((r) => fmt(num(ex[r])) + ' ' + (RES_NAMES[r] || r).toLowerCase())].join(' + ');
    })]);
    kv.push(['Upkeep', fmtRate(def.upkeep) + ' food each']);
    if (Number.isFinite(def.atk)) kv.push(['ATK / HP', n0(def.atk) + ' / ' + n0(def.hp) + ' (power √(ATK×HP) = ' + fmt(unitPower(def.atk, def.hp)) + ')']);
    kv.push(['Brood time', '×' + def.broodFactor + ' the base']);
    const house = HOUSE[def.house];
    if (house) kv.push(['Lives in', house[1]]);
    const blocks = [{ kv }];
    const notes = [CASTE_HOW[c]];
    if (c === 'minor') notes.push('Takes jobs. Idle minors defend the nest as militia (ATK ' + def.atk + ', HP ' + def.hp + ').');
    if (c === 'replete') notes.push('Each adds ' + pct(def.fx.capBonus) + ' food cap; in winter each covers ' + def.fx.winterCover + ' food/s of upkeep (up to '
      + upct(def.fx.winterCoverMax) + ').');
    if (c === 'alate') notes.push('Each reared alate adds ' + pct(FLIGHT.rearedPer) + ' to the next Flight (up to ' + FLIGHT.rearedMax + ' count).');
    if (c === 'soldier' || c === 'supermajor') notes.push('Soldiers guard the nest, escort trails and march in war parties. Retire to workers turns spare ones back into minors.');
    if (c === 'supermajor') notes.push('Rival home bonuses partly fail against supermajors.');
    blocks.push({ list: notes });
    const links = [];
    if (house && chamberShown(s, house[0])) links.push({ entry: 'chamber:' + house[0], label: nameOf('chamber', house[0]) });
    for (const r of Object.keys(obj(def.extra))) links.push({ entry: 'res:' + r, label: RES_NAMES[r] });
    if ((c === 'soldier' || c === 'supermajor') && isShown(s, 'panel_war')) links.push({ entry: 'war:ap', label: 'Army Power' });
    return { title: def.name, kw: 'caste ant ' + c, blocks, links, tabs: [CASTE_TABS[c]] };
  },
}));

/** Static output line per job, from data. */
function jobOutput(s, j) {
  switch (j) {
    case 'forager': return 'Food along trails (see Trails). With no forager trail at all, each forages loose for ' + LOOSE_FORAGE + ' food/s.';
    case 'digger': return 'Dig work = diggers^' + JOBS.digger.fx.exp + ', and one soil per unit of work. Work goes to the first job in the dig queue.';
    case 'nurse': return 'Speeds brood. Useful up to ' + JOBS.nurse.fx.maxPerSlot + ' nurses per brood slot (the queen counts as one).';
    case 'scout': return 'Explores the fog: the scout force makes scouts^' + SCOUT.forceExp + ' scout-seconds per second. Each revealed hex pays insight.'
      + (isShown(s, 'raid_warnings') ? ' Each scout adds ' + JOBS.scout.fx.warnSec + ' s of raid warning.' : '');
    case 'herder': return 'Milks an aphid colony for ' + SOURCES.aphid_colony.y.honeydew + ' honeydew/s each, up to ' + JOBS.herder.fx.capPerLevel
      + ' herders per colony level. Uses a trail slot.';
    case 'leafcutter': return 'Cuts ' + SOURCES.leaf_plant.y.leaves + ' leaves/s each on leaf-plant trails. Nothing in winter.';
    case 'gardener': return 'Turns ' + JOBS.gardener.fx.leavesIn + ' leaves/s into ' + JOBS.gardener.fx.fungusOut + ' fungus/s each. Slots come from Fungus Gardens.';
    default: return '';
  }
}

const JOB_LINKS = {
  forager: [['res:food', 'Food'], ['surface:trails', 'Trails']], digger: [['res:soil', 'Soil'], ['nest:digging', 'Digging']],
  nurse: [['caste:queen', 'The queen and brood']], scout: [['surface:scouting', 'Scouting'], ['res:insight', 'Insight']],
  herder: [['res:honeydew', 'Honeydew'], ['source:aphid_colony', nameOf('source', 'aphid_colony')]],
  leafcutter: [['res:leaves', 'Leaves']], gardener: [['res:fungus', 'Fungus'], ['chamber:fungus_garden', nameOf('chamber', 'fungus_garden')]],
};

const DEF_JOBS = JOB_ORDER.map((j) => ({
  id: 'job:' + j, section: 'ants', gate: (s) => jobShown(s, j),
  sig: (s) => Number(isShown(s, 'raid_warnings')),
  build: (s) => ({
    title: JOBS[j].name, kw: 'job worker ' + j,
    blocks: [
      { kv: [
        ['Assigned', live((s2) => fmtCount(num(s2.run.colony.jobs[j])))],
        ['Limit', live((s2, d2) => { const c = q(() => jobCap(s2, d2, j), Infinity); return Number.isFinite(c) ? fmtCount(c) : 'none'; })],
        ['Idle minors', live((s2) => fmtCount(q(() => idleMinors(s2), 0)))],
      ] },
      { p: tip(s, JOB_TIPS, j) },
      { p: jobOutput(s, j) },
    ],
    links: (JOB_LINKS[j] || []).map(([entry, label]) => ({ entry, label })),
    tabs: isShown(s, 'panel_colony') ? [tabBtn('colony')] : [],
  }),
}));

const DEF_AUTOMATION = {
  id: 'ants:automation', section: 'ants',
  gate: (s) => isShown(s, 'job_presets') || hasResearch(s, 'response_thresholds') || traitLevel(s, 'automaton_instincts') > 0 || fedLevel(s, 'autobuyers') > 0,
  sig: (s) => [isShown(s, 'job_presets'), hasResearch(s, 'response_thresholds'), hasResearch(s, 'hive_mind'), traitLevel(s, 'automaton_instincts') > 0,
    fedLevel(s, 'autobuyers') > 0].map(Number).join(''),
  build: (s) => {
    const list = [];
    if (isShown(s, 'job_presets')) list.push('Auto jobs: every job gets a target share. New adults follow the targets and every ' + THRESHOLDS.rebalanceSec
      + ' s workers are rebalanced to them. In auto mode +/− moves a target by ' + upct(0.05) + '.');
    if (hasResearch(s, 'response_thresholds')) list.push('Respond to bottlenecks: while a job is the bottleneck (brood, a dig queue over ' + THRESHOLDS.digQueueSec
      + ' s of work, honeydew for a purchase) it gets +' + upct(THRESHOLDS.shiftStep) + ' of the workforce per rebalance, up to +' + upct(THRESHOLDS.biasMax)
      + ' and never past ' + upct(THRESHOLDS.shiftMax) + ' of workers. Your targets stay as you set them.');
    if (hasResearch(s, 'hive_mind')) list.push('Job presets: save up to ' + PRESETS.max + ' named job splits and switch with one click.');
    if (traitLevel(s, 'automaton_instincts') > 0) list.push('Automaton Instincts: automatic jobs every run, the Adaptation autobuyer and +' + TRAITS.automaton_instincts.fx.queue + ' dig queue.');
    if (fedLevel(s, 'autobuyers') > 0) list.push('Autobuyers: Adaptations, chamber levels and Mound levels bought for you, in the order you set.');
    return {
      title: 'Automation', kw: 'auto jobs targets thresholds presets autobuy',
      blocks: [{ kv: [['Auto jobs', live((s2) => (s2.run.colony.autoJobs ? 'on' : 'off'))], ['Respond to bottlenecks', live((s2) => (s2.run.colony.thresholdJobs ? 'on' : 'off'))]] },
        { list }],
      tabs: [tabBtn('colony')],
    };
  },
};

const DEF_ADAPT = {
  id: 'ants:adaptations', section: 'ants', gate: (s) => isShown(s, 'adapt_basic'),
  sig: (s) => ADAPTATION_ORDER.filter((id) => q(() => adaptAvailable(s, id), false)).join(','),
  build: (s) => {
    const ids = ADAPTATION_ORDER.filter((id) => q(() => adaptAvailable(s, id), false));
    return {
      title: 'Adaptations', kw: 'adaptation upgrade food repeatable',
      blocks: [
        { p: 'Repeatable upgrades bought with food (some also need chitin or honeydew). Each level costs more than the last. They reset with a Flight.' },
        { table: { head: ['Adaptation', 'Effect', 'Level', 'Next'], rows: ids.map((id) => [nameOf('adaptation', id), tip(s, ADAPT_TIPS, id),
          live((s2) => fmtCount(num(s2.run.adaptations[id]))), live((s2) => costText(q(() => adaptCost(s2, id), null))) ]) } },
        { note: 'Buy them in the Adaptations tab (key 4): Buy, ×10 or Max (everything you can afford now).' },
      ],
      tabs: [tabBtn('adaptations')],
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// 4. Chambers and the nest
// ---------------------------------------------------------------------------------------------------------------

/** Effect-per-level lines of a chamber type from its fx (gated mentions only). */
function chamberEffect(s, id) {
  const def = CHAMBERS[id];
  const fx = def.fx;
  const out = [];
  switch (id) {
    case 'royal_chamber':
      out.push('Lay rate ×' + fx.lay + ' per level above 1.');
      out.push('Level 1 gives ' + fx.housing + ' housing, ' + fx.storage + ' food storage and ' + fx.slots + ' brood slots.');
      if (isShown(s, 'panel_prestige')) out.push('Level ' + FLIGHT.royalLevel + ' is required for the Nuptial Flight.');
      if (!isShown(s, 'royal_levelup')) out.push('Level-ups open once the colony is a little bigger.');
      break;
    case 'gallery':
      out.push('+' + fx.housing + ' housing per level. Each level above ' + fx.highL + ' adds ' + fx.housing + ' + (level − ' + fx.highL + ').');
      out.push('In loam: housing ×' + fx.loam + '.');
      break;
    case 'nursery':
      out.push('+' + fx.slots + ' brood slots per level.');
      if (layerSeen(s, 'topsoil')) out.push('In topsoil: brood ' + pct(MICRO.topsoil.nursery.spring) + ' in spring, ' + pct(MICRO.topsoil.nursery.summer) + ' in summer.');
      if (layerSeen(s, 'gravel')) out.push('In gravel: brood ' + pct(MICRO.gravel.nursery.winter) + ' in winter.');
      break;
    case 'granary': {
      out.push('Holds ' + n0(fx.cap) + ' food at level 1, ×' + fx.capGrowth + ' per further level.');
      const lm = Object.keys(fx.layer).filter((l) => layerSeen(s, l)).map((l) => nameOf('layer', l) + ' ×' + fx.layer[l]);
      if (lm.length) out.push('Capacity by layer: ' + lm.join(', ') + '.');
      if (layerSeen(s, 'clay')) out.push('In clay it spoils ' + upct(fx.claySpoil) + ' of the food it holds per minute' + (hasResearch(s, 'ventilation_shafts') ? ' (stopped by your Ventilation Shafts).' : '.'));
      out.push('Shallow storage shortens every trail from the main entrance; deep storage is out of raid reach.');
      break;
    }
    case 'scent_library':
      out.push('+' + fx.insight + ' insight/s per level.');
      if (layerSeen(s, def.deepFrom)) out.push(nameOf('layer', def.deepFrom) + ' or deeper: ×' + fx.deep + '.');
      break;
    case 'midden':
      out.push('Disease-event chance ' + pct(-fx.disease) + ' per level (at most ' + pct(-fx.diseaseMax) + ' combined).');
      out.push('All output ' + pct(fx.output) + ' per level (at most ' + pct(fx.outputMax) + ' combined).');
      if (isShown(s, 'res_chitin')) out.push('Recycles ' + fx.chitin + ' chitin/s per level.');
      break;
    case 'barracks':
      out.push('+' + fx.berths + ' berths per level for soldiers' + (casteShown(s, 'supermajor') ? ' (supermajors live in the War Hall)' : '') + '.');
      out.push('Their ATK ' + pct(fx.atk) + ' per level (at most ' + pct(fx.atkMax) + ' combined).');
      break;
    case 'war_hall':
      out.push('+' + fx.berths + ' supermajor berths per level. A supermajor egg needs a free War Hall berth.');
      break;
    case 'root_aphid_pen':
      out.push('+' + fx.honeydew + ' honeydew/s per level, ×' + fx.winter + ' in winter.');
      out.push('Herders ' + pct(fx.herders - 1) + ' for each pen.');
      break;
    case 'fungus_garden':
      out.push('+' + fx.gardeners + ' gardener slots, +' + n0(fx.leafCap) + ' leaf cap and +' + n0(fx.fungusCap) + ' fungus cap per level.');
      if (layerSeen(s, 'clay')) out.push('In clay: ×' + fx.clay + '.');
      break;
    case 'repletion_hall':
      out.push('+' + fx.berths + ' replete berths per level.');
      break;
    case 'hibernaculum':
      out.push('Shelters ' + fx.shelter + ' brood per level from frost.');
      out.push('Winter upkeep ' + pct(-fx.upkeep) + ' per level (at most ' + pct(-fx.upkeepMax) + ').');
      break;
    case 'thermal_chimney':
      out.push('Winter forage penalty ' + pct(-fx.winterForage) + ' per level (at most ' + pct(-fx.max) + ').');
      break;
    case 'gate':
      out.push('Defender HP in the gate fight ' + pct(fx.hp) + ' per level.');
      out.push('Food stolen by raids ' + pct(-fx.theft) + ' per level (never below ' + upct(fx.theftFloor) + ').');
      break;
    case 'water_well':
      out.push('Protects the colony from drought.');
      if (layerSeen(s, 'aquifer')) out.push('In the aquifer it counts twice.');
      break;
    case 'nuptial_chamber':
      out.push(fx.cellsBase + ' alate cells at level 1, +' + fx.cellsPer + ' per level, at most ' + (traitLevel(s, 'royal_court') > 0 ? fx.cellsMaxCourt : fx.cellsMax) + '.');
      out.push('Its own exit shaft opens a second entrance on the map.');
      break;
    case 'deep_vault':
      out.push('+' + fmtTime(fx.offlineSec) + ' offline cap and ' + pct(fx.alates) + ' flight alates per level.');
      break;
    default: break;
  }
  if (def.frostImmune) out.push('Immune to frost.');
  return out;
}

/** Adjacency lines of a type, without rules whose partner chamber is not revealed. */
function shownAdjacency(s, id) {
  const rules = ADJACENCY_ORDER.filter((rid) => {
    const r = ADJACENCY[rid];
    const bs = Array.isArray(r.b) ? r.b : [r.b];
    return r && (r.a === id || bs.includes(id));
  });
  const lines = q(() => adjacencyLines(id), []);
  const out = [];
  rules.forEach((rid, i) => {
    const r = ADJACENCY[rid];
    const bs = Array.isArray(r.b) ? r.b : [r.b];
    const partners = (r.a === id ? bs : [r.a]).filter((p) => p !== 'entrance');
    if (rid === 'hyg_midden' && r.a !== id) { if (chamberShown(s, 'midden') && lines[i]) out.push(lines[i]); return; }
    if (rid === 'hyg_midden') {
      const vis = bs.filter((p) => chamberShown(s, p));
      if (vis.length) out.push(r.text + ' for a ' + vis.map((p) => nameOf('chamber', p)).join(' or a ') + ' within ' + r.path + ' path cells of it.');
      return;
    }
    if (partners.every((p) => chamberShown(s, p)) && lines[i]) out.push(lines[i]);
  });
  return out;
}

/** "L1 ×2, L3 (digging)". */
function ownedText(s, id) {
  const list = arr(s.run.nest.chambers).filter((c) => c && c.type === id);
  if (!list.length) return 'None yet.';
  return list.map((c) => 'L' + fmtCount(num(c.level)) + (c.status && c.status !== 'active' ? ' (' + c.status + ')' : '')).join(', ');
}

/** Next level of the cheapest instance as text (nest.levelGain, as the inspect panel shows it). */
function nextLevelText(s, d, id) {
  const ch = q(() => cheapestLevel(s, d, id), null);
  if (!ch) {
    const any = arr(s.run.nest.chambers).some((c) => c && c.type === id);
    return any ? 'No level-up available right now.' : 'Build one first.';
  }
  const g = q(() => levelGain(s, d, ch.uid), null);
  const lines = g && !g.max ? arr(g.lines).map(levelGainText).filter(Boolean) : [];
  return 'L' + fmtCount(num(ch.level)) + ' → L' + fmtCount(num(ch.level) + 1) + ': ' + (lines.length ? lines.join('; ') : 'next level') + ' — ' + costText(ch.cost);
}

const CHAMBER_LINKS = {
  royal_chamber: [['caste:queen', 'The queen and brood']], gallery: [['caste:minor', nameOf('caste', 'minor')]], nursery: [['caste:queen', 'The queen and brood']],
  granary: [['res:food', 'Food']], scent_library: [['res:insight', 'Insight']], midden: [['res:chitin', 'Chitin']], barracks: [['caste:soldier', nameOf('caste', 'soldier')]],
  war_hall: [['caste:supermajor', nameOf('caste', 'supermajor')]],
  root_aphid_pen: [['res:honeydew', 'Honeydew'], ['nest:features', 'Soil features']], fungus_garden: [['res:fungus', 'Fungus'], ['job:gardener', 'Gardener']],
  repletion_hall: [['caste:replete', nameOf('caste', 'replete')]], hibernaculum: [['nest:frost', 'Frost']], thermal_chimney: [['nest:frost', 'Frost']],
  gate: [['war:raids', 'Raids on your nest']], water_well: [['nest:features', 'Soil features']], nuptial_chamber: [['caste:alate', nameOf('caste', 'alate')], ['prestige:flight', 'Nuptial Flight']],
  deep_vault: [['prestige:flight', 'Nuptial Flight']],
};

const DEF_CHAMBERS = CHAMBER_ORDER.map((id) => ({
  id: 'chamber:' + id, section: 'chambers', gate: (s) => chamberShown(s, id),
  sig: (s, d) => [layersSeen(s).length, maxInstances(s, id), shownAdjacency(s, id).length, chamberEffect(s, id).length, placementRuleLines(id, q(() => placementRows(s, d, id), null)).join('|')].join(':'),
  build: (s, d) => {
    const def = CHAMBERS[id];
    const rules = placementRuleLines(id, q(() => placementRows(s, d, id), null));
    const maxI = maxInstances(s, id);
    const levelCost = { food: def.f0, soil: def.s0 };
    const lvExtra = def.levelExtra ? ' + ' + extraText(def.levelExtra) : '';
    const maxL = def.maxL > 0 ? (def.maxLBonus && traitLevel(s, def.maxLBonus.trait) > 0 ? def.maxLBonus.maxL : def.maxL) : 0;
    const kv = [
      ['You have', live((s2) => ownedText(s2, id))],
      ['Limit', def.maxInst === 'perPocket' ? 'one per revealed water pocket (now ' + fmtCount(maxI) + ')' : fmtCount(maxI) + (maxI === 1 ? ' chamber' : ' chambers')],
      ['Footprint', def.w0 + '×' + def.h0 + ' cells at L1; ' + (def.grows ? 'grows one row or column per level up to L' + GEOM.footprintMaxL
        + ' into the full-size space it reserves when placed (F picks the corner it starts in)' : 'does not grow')],
    ];
    if (id !== 'royal_chamber' || maxI > 1) {
      kv.push(['Place cost', costText(def.place) + (maxI > 1 ? ' (food ×' + def.placeGrowth + ' for each one you already have)' : '')]);
      kv.push(['Next one costs', live((s2) => {
        const have = arr(s2.run.nest.chambers).filter((c) => c && c.type === id).length;
        return have >= maxInstances(s2, id) ? 'limit reached' : costText(q(() => placementCost(s2, id), null));
      })]);
    }
    if (def.f0 > 0 || def.s0 > 0) {
      kv.push(['Level-up cost', costText(levelCost) + lvExtra + ' × ' + def.g + '^level' + (maxI > 1 ? ', ×' + CHAMBER_RULES.instanceLevelGrowth + ' per instance' : '')]);
      kv.push(['Max level', maxL > 0 ? 'L' + maxL : 'none']);
      kv.push(['Your next level', live((s2, d2) => nextLevelText(s2, d2, id))]);
    }
    const adj = shownAdjacency(s, id);
    const blocks = [{ p: tip(s, CHAMBER_TIPS, id) }, { kv }, { h: 'Effect per level' }, { list: chamberEffect(s, id) }, { h: 'Placement' },
      { list: rules.length ? rules : ['Anywhere below the surface that connects to an open cell.'] }];
    if (adj.length) blocks.push({ h: 'Adjacency' }, { list: adj });
    const links = (CHAMBER_LINKS[id] || []).map(([entry, label]) => ({ entry, label }));
    return { title: def.name, kw: 'chamber build ' + id.replace(/_/g, ' '), blocks, links, tabs: [tabBtn('build')] };
  },
}));

/** Strata table rows for the layers seen. */
function strataRows(s) {
  const out = [];
  for (const id of layersSeen(s)) {
    const L = LAYERS[id];
    let work = String(L.work);
    if (id === 'clay' && hasResearch(s, 'clay_masonry')) work = L.workMasonry + ' (Clay Masonry)';
    const notes = [];
    if (L.req && L.req.research) notes.push((hasResearch(s, L.req.research) ? 'Opened by ' : 'Needs ') + nameOf('research', L.req.research));
    if (L.req && L.req.federation) notes.push((fedLevel(s, L.req.federation) > 0 ? 'Opened by ' : 'Needs ') + nameOf('federation', L.req.federation));
    if (id === 'topsoil') {
      if (eventsSeen(s).includes('ev_rainstorm')) notes.push('Rows ' + DIG.floodRows[0] + '–' + DIG.floodRows[1] + ' flood in rainstorms');
      notes.push('first to freeze');
    }
    if (id === 'loam' && chamberShown(s, 'gallery')) notes.push('Galleries ×' + CHAMBERS.gallery.fx.loam + ' housing');
    if (id === 'clay') {
      if (chamberShown(s, 'fungus_garden')) notes.push('Fungus Gardens ×' + MICRO.clay.garden);
      if (chamberShown(s, 'granary')) notes.push('Granaries ×' + CHAMBERS.granary.fx.layer.clay + ' but spoil');
    }
    if (['gravel', 'bedrock', 'aquifer'].includes(id) && chamberShown(s, 'granary')) notes.push('Granaries ×' + CHAMBERS.granary.fx.layer[id]);
    if (id === 'gravel' && chamberShown(s, 'scent_library')) notes.push('Scent Library ×' + CHAMBERS.scent_library.fx.deep);
    if (id === 'aquifer') notes.push('chamber effects ×' + CHAMBER_RULES.aquiferMult);
    out.push([nameOf('layer', id), L.y0 + '–' + L.y1, work, notes.join('; ') || '—']);
  }
  return out;
}

const DEF_NEST = [
  {
    id: 'nest:strata', section: 'chambers', gate: (s) => isShown(s, 'panel_build') || isShown(s, 'job_digger'),
    sig: (s) => layersSeen(s).length + ':' + strataRows(s).map((r) => r[3]).join('|'),
    build: (s) => ({
      title: 'Soil layers', kw: 'strata layer depth rows topsoil work',
      blocks: [
        { p: 'The nest is a cross-section ' + 40 + ' columns wide. Each soil layer costs more dig work per cell and changes what chambers do there. '
          + 'A chamber belongs to the layer that holds most of its cells.' },
        { table: { head: ['Layer', 'Rows', 'Work / cell', 'Notes'], rows: strataRows(s) } },
        layersSeen(s).length < LAYER_ORDER.length ? { note: 'Deeper soil waits below. Dig down to read about it.' } : null,
        { kv: [['Deepest row reached', live((s2) => fmtCount(deepestRow(s2)))]] },
      ].filter(Boolean),
      links: [{ entry: 'nest:digging', label: 'Digging' }], tabs: isShown(s, 'panel_build') ? [tabBtn('build')] : [],
    }),
  },
  {
    id: 'nest:digging', section: 'chambers', gate: (s) => isShown(s, 'job_digger') || isShown(s, 'panel_build'),
    sig: (s) => [isShown(s, 'panel_build'), hasResearch(s, 'load_chains')].map(Number).join(''),
    build: (s) => ({
      title: 'Digging, tunnels and backfill', kw: 'dig queue tunnel backfill relocate demolish help dig work',
      blocks: [
        { kv: [['Dig work', live((s2, d2) => fmtRate(num(d2.stats.digW)))], ['Dig queue', live((s2) => fmtCount(arr(s2.run.nest.queue).length) + ' / ' + fmtCount(queueLimit(s2)) + ' jobs')]] },
        { list: gated(s, [
          'Dig work per second = diggers^' + JOBS.digger.fx.exp + ' × your multipliers. All of it goes to the first job in the queue.',
          'Chamber cells cost ×' + DIG.chamberCellMult + ' the tunnel work of their layer.',
          'Clicking the active dig face helps: +' + DIG.helpFlat + ' work + ' + upct(DIG.helpFracW) + ' of your dig rate per click (at most ' + CLICK_CAP + ' clicks a second).',
          'Drag from any open cell across soil to dig a tunnel. A chamber placed away from open cells routes its own tunnel.',
          ['Load Chains halve tunnel work.', (s2) => hasResearch(s2, 'load_chains')],
          ['Backfill (B over the nest) refills tunnel cells for free over ' + DIG.backfillSec + ' s, never cutting a chamber off. “Backfill unneeded” clears every spare tunnel.', (s2) => isShown(s2, 'panel_build')],
          ['Relocating a chamber costs ' + upct(DIG.relocateWorkFrac) + ' of the new footprint’s dig work and keeps its level. Demolishing refunds ' + upct(DIG.demolishRefund)
            + ' of its placement food; cancelling a queued job refunds ' + upct(DIG.cancelRefund) + '.', (s2) => isShown(s2, 'panel_build')],
        ]) },
      ],
      links: [{ entry: 'job:digger', label: 'Digger' }, { entry: 'nest:strata', label: 'Soil layers' }], tabs: isShown(s, 'panel_build') ? [tabBtn('build')] : [],
    }),
  },
  {
    id: 'nest:frost', section: 'chambers', gate: (s) => isShown(s, 'frost_line') || isShown(s, 'climate_overlay'),
    sig: (s) => [hasResearch(s, 'thermoregulation'), chamberShown(s, 'hibernaculum'), CHAMBER_ORDER.filter((c) => CHAMBERS[c].frostImmune && chamberShown(s, c)).length].map(Number).join(''),
    build: (s) => ({
      title: 'Frost', kw: 'frost winter freeze cold line exposed',
      blocks: [
        { kv: [['Frost line now', live((s2, d2) => (num(d2.season.frostRow) > 0 ? 'row ' + fmtCount(num(d2.season.frostRow)) : 'none'))],
          ['This winter reaches', live((s2, d2) => (num(d2.season.frostMax) > 0 ? 'row ' + fmtCount(num(d2.season.frostMax)) : '—'))]] },
        { list: gated(s, [
          'In winter the frost line sinks over ' + FROST.descendSec + ' s, holds, and retreats over the last ' + FROST.retreatSec + ' s.',
          'It reaches row ' + FROST.maxRow + ' (row ' + FROST.maxRowMild + ' in the first, mild winter); each ' + MOUND.frostPerLevels + ' Mound levels lift it a row (up to '
            + MOUND.frostMax + '), never above row ' + FROST.minRow + '.',
          ['Thermoregulation lifts it ' + RESEARCH.thermoregulation.fx.frost + ' rows.', (s2) => hasResearch(s2, 'thermoregulation')],
          'A chamber is exposed while more than half its cells are above the line: its effect drops to ×' + CHAMBER_RULES.frostMult + ' and brood in it freezes.',
          'After the first winter, frozen brood dies slowly while you are online. Offline, frost only freezes.',
          'Immune: ' + CHAMBER_ORDER.filter((c) => CHAMBERS[c].frostImmune && chamberShown(s, c)).map((c) => nameOf('chamber', c)).join(', ') + '.',
          ['The Hibernaculum shelters brood from frost.', (s2) => chamberShown(s2, 'hibernaculum')],
        ]) },
      ],
      links: [{ entry: 'season:clock', label: 'Seasons' }], tabs: [tabBtn('build')],
    }),
  },
  {
    id: 'nest:features', section: 'chambers',
    gate: (s) => num(s.meta.counters.caches) > 0 || chamberShown(s, 'root_aphid_pen') || chamberShown(s, 'water_well') || hasResearch(s, 'root_cultivation'),
    sig: (s) => [num(s.meta.counters.caches) > 0, chamberShown(s, 'root_aphid_pen'), chamberShown(s, 'water_well'), hasResearch(s, 'drainage'), hasResearch(s, 'root_cultivation'),
      hasResearch(s, 'acid_excavation')].map(Number).join(''),
    build: (s) => {
      const list = gated(s, [
        ['Caches: discoloured soil near your tunnels hides seeds, beetle husks or fossils. Click a hint to tunnel to it; it pays out when dug.', (s2) => num(s2.meta.counters.caches) > 0],
        'Stones are boulders that cannot be dug' + (hasResearch(s, 'acid_excavation') ? ' — except with Acid Excavation, at ×' + RESEARCH.acid_excavation.fx.stone + ' work.' : '.'),
        ['Roots hang ' + ROOTS.yMin + '–' + ROOTS.yMax + ' rows deep from plants near the entrance. A Root Aphid Pen must touch one.', (s2) => chamberShown(s2, 'root_aphid_pen')],
        ['Water pockets cannot be dug; a Water Well must touch one. They show up when a tunnel comes close.', (s2) => chamberShown(s2, 'water_well')],
        ['Drainage: drain a revealed pocket (×' + DRAINAGE.drainWork + ' layer work and ' + DRAINAGE.drainSoil + ' soil per water cell) or move it up to ' + DRAINAGE.moveRows
          + ' rows (×' + DRAINAGE.moveWork + ' layer work per cell).', (s2) => hasResearch(s2, 'drainage')],
        ['Cultivated roots: grow a root down a column you choose. Cost ×' + ROOT_CULT.growth + ' for each one this run.', (s2) => hasResearch(s2, 'root_cultivation')],
      ]);
      const kv = [];
      if (hasResearch(s, 'root_cultivation')) {
        kv.push(['Cultivated roots', live((s2) => fmtCount(arr(s2.run.nest.features.roots).filter((r) => r && r.own).length) + ' / ' + fmtCount(q(() => rootCap(s2), 0)))]);
        kv.push(['Next root', live((s2) => costText(q(() => rootCost(s2), null)))]);
      }
      return { title: 'Soil features', kw: 'cache root stone water pocket drain', blocks: [kv.length ? { kv } : null, { list }].filter(Boolean), tabs: [tabBtn('build')] };
    },
  },
  {
    id: 'nest:blueprints', section: 'chambers',
    gate: (s) => traitLevel(s, 'ancestral_blueprint') > 0 || fedLevel(s, 'blueprint_memory') > 0 || arr(s.era.blueprints).length > 0,
    sig: (s) => [fedLevel(s, 'blueprint_memory') > 0].map(Number).join(''),
    build: (s) => ({
      title: 'Blueprints', kw: 'blueprint layout save plan',
      blocks: [
        { kv: [['Saved', live((s2) => fmtCount(arr(s2.era.blueprints).length) + ' / ' + (fedLevel(s2, 'blueprint_memory') > 0 ? FEDERATION.blueprint_memory.fx.slots : 1))],
          ['Planned this run', live((s2) => fmtCount(arr(s2.run.nest.bpPending).length))]] },
        { list: [
          'Save your nest layout in the Build tab. At the start of every run the active blueprint queues its chambers and tunnels.',
          'Blueprint cells dig ×' + (fedLevel(s, 'blueprint_memory') > 0 ? FEDERATION.blueprint_memory.fx.cellDiv : TRAITS.ancestral_blueprint.fx.cellDiv)
            + ' faster and planned chambers are placed at ' + upct(TRAITS.ancestral_blueprint.fx.placeMult) + ' cost.',
          'A planned chamber waits while it is locked, at its limit or cannot fit; the Build tab says why. You can cancel planned chambers for this run.',
        ] },
      ],
      tabs: [tabBtn('build')],
    }),
  },
];

// ---------------------------------------------------------------------------------------------------------------
// 5. Surface
// ---------------------------------------------------------------------------------------------------------------

const SEASON_SHORT = { spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter' };

/** Lines describing one source type, from data. */
function sourceLines(s, id) {
  const S = SOURCES[id];
  const out = [];
  const y = Object.keys(obj(S.y));
  if (y.length) out.push('Yield per worker: ' + y.map((r) => S.y[r] + ' ' + (RES_NAMES[r] || r).toLowerCase() + '/s').join(' + ') + (S.perRing ? ' × its ring' : '') + '.');
  if (S.cap > 0) out.push('Capacity ' + S.cap + (S.capPerLevel ? ' per colony level (levels up to ' + S.fx.maxLevel + ')' : '') + ' workers before extra ones help less.');
  if (S.stock) out.push('Finite: holds max(' + n0(S.stock.base) + ', ' + S.stock.sec + ' s of your food income)' + (S.stock.regrow > 0 ? ' and regrows ' + upct(S.stock.regrow) + ' of that per second.' : '.'));
  else if (S.job) out.push('Never runs out.');
  const seas = SEASON_ORDER.filter((k) => num(S.season[k], 1) !== 1);
  if (seas.length && isShown(s, 'season_dial')) out.push('Seasons: ' + seas.map((k) => SEASON_SHORT[k] + ' ×' + S.season[k]).join(', ') + '.');
  if (S.spawn && Number.isFinite(S.spawn.ttl)) out.push('Disappears after ' + fmtTime(S.spawn.ttl) + ' or when emptied.');
  if (S.fx && S.fx.rotAfter) out.push('Rots after ' + fmtTime(S.fx.rotAfter) + ', losing ' + upct(S.fx.rotPerSec) + ' of its stock per second.');
  if (S.fx && S.fx.contest && casteShown(s, 'soldier')) out.push('Contested: yield ×' + S.fx.contest + ' unless escorted (1 soldier per ' + TRAIL.escortPer + ' foragers).');
  if (S.fx && S.fx.levelSec) out.push('Gains a level every ' + fmtTime(S.fx.levelSec) + ' while at least ' + upct(S.fx.herdFrac) + ' herded.');
  if (S.minEscorts) out.push('Pays only while at least ' + S.minEscorts + ' escort soldiers guard its trail; the trail carries no workers.');
  if (S.hunt) {
    if (S.hunt.apPerRing) out.push('Hunted, not foraged: a war party needs AP ' + S.hunt.apPerRing + ' × its ring. Reward: ' + S.hunt.foodSec + ' s of food + ' + S.hunt.chitinPerRing * S.hunt.chitinMult + ' chitin × ring.');
    else out.push('Raided, not foraged (defender AP ' + n0(ACTIONS.termite.ap) + ', cooldown ' + fmtTime(ACTIONS.termite.cdSec) + '). Reward: ' + S.hunt.foodSec + ' s of food + ' + S.hunt.chitinPerRing + ' chitin × ring.');
  }
  if (id === 'crumb_scatter') out.push('Click it to hand-forage.');
  return out;
}

const DEF_SOURCES = SOURCE_ORDER.map((id) => ({
  id: 'source:' + id, section: 'surface', gate: (s) => sourcesSeen(s).includes(id),
  sig: (s) => [isShown(s, 'season_dial'), casteShown(s, 'soldier')].map(Number).join(''),
  build: (s) => ({
    title: nameOf('source', id), kw: 'source map ' + id.replace(/_/g, ' '),
    blocks: [
      { kv: [['On the map now', live((s2) => fmtCount(arr(s2.run.surface.sources).filter((x) => x && x.type === id && s2.run.surface.revealed[x.hex] === 1).length))]] },
      { list: sourceLines(s, id) },
    ],
    links: Object.keys(obj(SOURCES[id].y)).map((r) => ({ entry: 'res:' + r, label: RES_NAMES[r] })).concat(SOURCES[id].job ? [{ entry: 'surface:trails', label: 'Trails' }] : []),
    tabs: isShown(s, 'panel_map') ? [tabBtn('map')] : [],
  }),
}));

const DEF_SURFACE = [
  {
    id: 'surface:scouting', section: 'surface', gate: (s) => isShown(s, 'job_scout') || isShown(s, 'panel_research'),
    sig: (s) => [hasResearch(s, 'antennation'), traitLevel(s, 'keen_antennae') > 0].map(Number).join(''),
    build: (s) => ({
      title: 'The map and scouting', kw: 'fog scout reveal hex ring flag insight',
      blocks: [
        { kv: [['Hexes revealed', live((s2) => fmtCount(arr(s2.run.surface.revealed).reduce((a, v) => a + (v === 1 ? 1 : 0), 0)))],
          ['Scouting speed', live((s2, d2) => fmt(num(d2.surface.scoutRate)) + ' scout-seconds/s')]] },
        { list: gated(s, [
          'Rings 0–' + MAP.revealStart + ' around the entrance start revealed. The map is ' + MAP.radiusBase + ' rings wide at first.',
          'Revealing a hex at ring r costs ' + SCOUT.base + ' × r^' + SCOUT.exp + ' scout-seconds; scouts take the nearest fog first.',
          'Click a fogged hex to flag it: scouts give it ×' + SCOUT.flagPriority + ' priority.',
          'Each revealed hex pays ' + SCOUT.insightPerRing + ' × its ring in insight.',
          ['Antennation: scouts ×' + RESEARCH.antennation.fx.scout + ', hex insight ×' + RESEARCH.antennation.fx.insightHex + '.', (s2) => hasResearch(s2, 'antennation')],
        ]) },
      ],
      links: [{ entry: 'job:scout', label: 'Scout' }, { entry: 'res:insight', label: 'Insight' }], tabs: isShown(s, 'panel_map') ? [tabBtn('map')] : [],
    }),
  },
  {
    id: 'surface:trails', section: 'surface', gate: () => true,
    sig: (s) => [isShown(s, 'trail_slots'), isShown(s, 'mound'), hasResearch(s, 'trunk_trails'), casteShown(s, 'soldier')].map(Number).join(''),
    build: (s) => ({
      title: 'Trails', kw: 'trail forage slot strength saturation route entrance distance',
      blocks: [
        { kv: [['Trail slots', live((s2, d2) => fmtCount(num(d2.surface.slotsUsed)) + ' / ' + fmtCount(num(d2.surface.slots)) + ' used')],
          ['Food from trails', live((s2, d2) => fmtRate(num(d2.ledger && d2.ledger.food ? d2.ledger.food['food.trails'] : 0)))]] },
        { list: gated(s, [
          'Drag from an entrance to a source to draw a trail; it routes itself around stone. Right-click a source for “Draw trail from nearest entrance”.',
          'One trail per destination: to put more ants on a source, add workers to its trail.',
          'Unassigned foragers fill the best trail that is not yet saturated.',
          'Richness: a trail of length d pays ×(1 + ' + TRAIL.slope + ' × (d − 1)), but every hex also costs travel time (navigation ' + TRAIL.dNavBase + ' at first).',
          'Saturation: past a source’s capacity (which grows with colony size) extra workers add less and less.',
          'Strength: traffic lays pheromone. More ants make a stronger trail (up to ' + TRAIL.sMax + '), and strength adds up to ×' + (1 + TRAIL.sMax / TRAIL.sScale) + ' yield. Unused, it halves every ' + TRAIL.tHalf + ' s.',
          'Shallow food storage shortens every trail from the main entrance.',
          'Slots: ' + SLOTS.base + ' to begin with, more from research' + (isShown(s, 'mound') ? ', Mound levels ' + SLOTS.moundLevels.join(', ') : '') + ' and extra entrances.',
          'Every trail starts at an entrance: the main one, or an outpost, satellite or nuptial exit once you have them.',
          ['Trunk Trails: where trails share hexes, each earns up to +' + Math.round(100 * (RESEARCH.trunk_trails ? RESEARCH.trunk_trails.fx.overlap || 0 : 0)) + '% (by the share of its hexes that another trail also uses).', (s2) => hasResearch(s2, 'trunk_trails')],
          ['Rival land on a trail costs ' + upct(TRAIL.rivalHexPenalty) + ' yield per hex unless escorted (1 soldier per ' + TRAIL.escortPer + ' workers).', (s2) => isShown(s2, 'panel_rivals') && casteShown(s2, 'soldier')],
        ]) },
      ],
      links: [{ entry: 'job:forager', label: 'Forager' }].concat(isShown(s, 'res_pheromone') ? [{ entry: 'surface:abilities', label: 'Pheromone abilities' }] : []),
      tabs: isShown(s, 'panel_map') ? [tabBtn('map')] : [],
    }),
  },
  {
    id: 'surface:territory', section: 'surface', gate: (s) => isShown(s, 'hex_claim') || isShown(s, 'panel_rivals'),
    sig: (s) => [isShown(s, 'hex_claim'), isShown(s, 'mound'), isShown(s, 'panel_war'), hasResearch(s, 'trunk_trails')].map(Number).join(''),
    build: (s) => ({
      title: 'Territory and claims', kw: 'territory hex claim owned border conquest',
      blocks: [
        { kv: [['Owned hexes', live((s2, d2) => fmtCount(num(d2.surface.ownedCount)))], ['Peak this run', live((s2) => fmtCount(num(s2.run.tPeak)))],
          isShown(s, 'hex_claim') ? ['Next claim', live((s2) => costText(q(() => claimCost(s2), null)))] : null].filter(Boolean) },
        { list: gated(s, [
          'You own the hexes within ' + TERRITORY.autoBase + ' of every entrance' + (isShown(s, 'mound') ? ' (+1 for every ' + TERRITORY.autoPerMound + ' Mound levels)' : '') + '.',
          ['Claim a revealed hex next to your land for ' + TERRITORY.claimBase + ' × ' + TERRITORY.claimGrowth + '^claims pheromone. A claim over your cap becomes a channel that fills as pheromone regrows.',
            (s2) => isShown(s2, 'hex_claim')],
          ['Conquering a rival gives you all of its land.', (s2) => isShown(s2, 'panel_war')],
          ['Trunk Trails: every hex of your trails is yours, from any entrance.', (s2) => hasResearch(s2, 'trunk_trails')],
          'Every owned hex adds ' + pct(TERRITORY.yieldPerHex) + ' to surface yields (at most ' + pct(TERRITORY.yieldMax) + '). Sources on owned hexes yield ×' + TERRITORY.ownedSource + '.',
          ['Trails entirely inside your land cannot be raided.', (s2) => isShown(s2, 'raid_warnings')],
          ['Your peak territory this run raises the alates of the next Flight.', (s2) => isShown(s2, 'panel_prestige')],
        ]) },
      ],
      links: isShown(s, 'res_pheromone') ? [{ entry: 'res:pheromone', label: 'Pheromone' }] : [], tabs: isShown(s, 'panel_map') ? [tabBtn('map')] : [],
    }),
  },
  {
    id: 'surface:abilities', section: 'surface', gate: (s) => isShown(s, 'res_pheromone'),
    sig: (s) => Object.keys(ABILITIES).filter((k) => isShown(s, ABILITIES[k].unlock)).join(','),
    build: (s) => {
      const rows = [];
      for (const k of Object.keys(ABILITIES)) {
        const A = ABILITIES[k];
        if (!isShown(s, A.unlock)) continue;
        let eff = '';
        if (k === 'mark') eff = '+' + A.add + ' strength on one trail (key M)';
        else if (k === 'rally') eff = 'one trail ×' + A.mult + ' for ' + (hasResearch(s, 'mass_recruitment') ? RESEARCH.mass_recruitment.fx.rallySec : A.sec) + ' s (key R)';
        else if (k === 'frenzy') eff = 'every trail ×' + A.mult + ' for ' + A.sec + ' s';
        else if (k === 'mass_recruit') eff = 'sends ' + upct(A.frac) + ' of idle and loose foragers to a swarm or picnic';
        rows.push([A.name, eff, costText(A.cost), A.cd ? fmtTime(A.cd) : '—']);
      }
      return { title: 'Pheromone abilities', kw: 'mark rally frenzy mass recruit pheromone ability',
        blocks: [{ kv: [['Pheromone', live((s2, d2) => amountText(s2, d2, 'pheromone', 'pheromoneCap'))]] },
          { table: { head: ['Ability', 'Effect', 'Cost', 'Cooldown'], rows } }],
        links: [{ entry: 'res:pheromone', label: 'Pheromone' }], tabs: isShown(s, 'panel_map') ? [tabBtn('map')] : [] };
    },
  },
  {
    id: 'surface:mound', section: 'surface', gate: (s) => isShown(s, 'mound'),
    sig: (s) => [hasResearch(s, 'mound_building'), isShown(s, 'panel_rivals'), isShown(s, 'events')].map(Number).join(''),
    build: (s) => ({
      title: 'The Mound', kw: 'mound soil level home',
      blocks: [
        { kv: [['Level', live((s2) => fmtCount(num(s2.run.surface.mound)))], ['Next level', live((s2) => costText(q(() => moundCost(s2), null)))]] },
        { list: gated(s, [
          'Costs ' + MOUND.base + ' × ' + MOUND.growth + '^(level − 1) soil.' + (hasResearch(s, 'mound_building') ? '' : ' Levels past ' + MOUND.freeMax + ' need Mound Building.'),
          ['Home defence ' + pct(MOUND.homeAP) + ' AP per level.', (s2) => isShown(s2, 'panel_rivals')],
          'Winter forage penalty ' + pct(-MOUND.winterForage) + ' per level (at most ' + pct(-MOUND.winterMax) + ').',
          'Every ' + MOUND.frostPerLevels + ' levels lift the frost line a row.',
          'Levels ' + SLOTS.moundLevels.join(', ') + ' each give a trail slot; every ' + TERRITORY.autoPerMound + ' levels widen your home territory.',
          ['From level ' + MOUND.shieldLevel + ' footsteps cannot hit the hexes around the entrance.', (s2) => eventsSeen(s2).includes('ev_footstep')],
        ]) },
      ],
      links: [{ entry: 'res:soil', label: 'Soil' }], tabs: [tabBtn('build')],
    }),
  },
];

// ---------------------------------------------------------------------------------------------------------------
// 6. Combat and rivals
// ---------------------------------------------------------------------------------------------------------------

const RIVAL_TRAIT_TEXT = {
  swarm: (t) => 'Swarm: their AP ×' + t.apMult + ' when they commit more ants than you.',
  acid_volley: (t) => 'Acid volley: your AP ×' + t.yourAP + ' before the battle (Formic Acid cancels it).',
  home_fortress: (t) => 'Home fortress: home bonus ×' + t.home + ' when you assault them.',
  venom: (t) => 'Venom: your HP ×' + t.yourHP + '.',
  border_creep: () => 'Border creep: takes an unowned neighbouring hex every ' + fmtTime(TERRITORY.creepSec) + ' (not in winter).',
  brood_raiders: (t) => 'Brood raiders: their raids hit your nest and steal brood; conquering them returns ×' + t.returnMult + ' the captured workers.',
};

const warGate = (s) => isShown(s, 'panel_war') || isShown(s, 'panel_rivals') || isShown(s, 'raid_warnings');

const DEF_COMBAT = [
  {
    id: 'war:ap', section: 'combat', gate: warGate,
    sig: (s) => ['soldier', 'supermajor'].map((c) => Number(casteShown(s, c))).join('') + Number(chamberShown(s, 'barracks')) + Number(isShown(s, 'mound')),
    build: (s) => {
      const rows = ['minor', 'soldier', 'supermajor'].filter((c) => casteShown(s, c)).map((c) => [c === 'minor' ? 'Militia (idle minor)' : CASTES[c].name,
        n0(CASTES[c].atk), n0(CASTES[c].hp), fmt(unitPower(CASTES[c].atk, CASTES[c].hp))]);
      return {
        title: 'Army Power', kw: 'army power ap lanchester square law battle',
        blocks: [
          { p: 'Army Power (AP) = Σ count × √(ATK × HP) × modifiers. Because strength grows with the square of numbers, a split army is weaker than one big army: concentrate your forces.' },
          { table: { head: ['Unit', 'ATK', 'HP', '√(ATK×HP)'], rows } },
          { kv: [['Garrison AP', live((s2, d2) => fmt(num(d2.combat.garrisonAP)))], ['Home bonus', live((s2, d2) => fmtMult(num(d2.combat.homeMult, 1)))]] },
          { list: gated(s, [
            'Each side rolls a fortune of ×' + 0.9 + '–×' + 1.1 + ' at the start of a battle; the preview shows your odds.',
            'The winner keeps √(1 − (loser AP / winner AP)²) of its army.',
            ['Defending at home: AP ' + pct(MOUND.homeAP) + ' per Mound level.', (s2) => isShown(s2, 'mound')],
            ['Barracks within ' + GEOM.barracksPath + ' path cells of an entrance: instant deploy and ' + pct(CHAMBERS.barracks.fx.homeAP - 1) + ' home AP.', (s2) => chamberShown(s2, 'barracks')],
          ]) },
        ],
        links: ['soldier', 'supermajor'].filter((c) => casteShown(s, c)).map((c) => ({ entry: 'caste:' + c, label: CASTES[c].name })),
        tabs: isShown(s, 'panel_map') ? [tabBtn('map', 'war')] : [],
      };
    },
  },
  {
    id: 'war:actions', section: 'combat', gate: (s) => isShown(s, 'panel_war'),
    sig: (s) => [isShown(s, 'res_honeydew'), isShown(s, 'res_pheromone'), hasResearch(s, 'field_triage'), hasResearch(s, 'siege_tactics'), hasResearch(s, 'phalanx')].map(Number).join(''),
    build: (s) => ({
      title: 'War parties and battles', kw: 'raid assault hunt conquest war party bribe retreat tactics',
      blocks: [
        { list: gated(s, [
          'Raid: fights ' + upct(ACTIONS.raid.engage) + ' of the defenders with no home bonus. Win food (' + REWARDS.raidFoodSec + ' s × √tier of income) and chitin.',
          'Assault: fights every defender with home bonus ×' + ACTIONS.assault.home + '. Winning conquers the nest: its land, insight, food, captured workers, an outpost and a harvester stash.',
          'Hunt: send a party at prey on the map for food and chitin.',
          'Parties march a hex every ' + 2 + ' s. Drag from an entrance onto a target, or use the war panel.',
          ['Bribe: pay ' + ACTIONS.bribe.apMult + ' × their AP in honeydew for a ' + fmtTime(ACTIONS.bribe.truceSec) + ' truce.', (s2) => isShown(s2, 'res_honeydew')],
          ['Alarm Rally (' + costText(TACTICAL.alarm_rally.cost) + '): ATK ×' + TACTICAL.alarm_rally.atk + ' for ' + TACTICAL.alarm_rally.sec + ' s. Mobilize (' + costText(TACTICAL.mobilize.cost)
            + '): ' + upct(TACTICAL.mobilize.frac) + ' of idle and forager minors join a home fight.', (s2) => isShown(s2, 'res_pheromone')],
          'Retreat (also automatic at your Settings threshold) costs ' + upct(TACTICAL.retreat.loss) + ' of the survivors.',
          ['Siege Tactics halve the rival home bonus.', (s2) => hasResearch(s2, 'siege_tactics')],
          ['Field Triage: some fallen soldiers return after a battle if enough nurses work.', (s2) => hasResearch(s2, 'field_triage')],
        ]) },
      ],
      links: [{ entry: 'war:ap', label: 'Army Power' }], tabs: isShown(s, 'panel_map') ? [tabBtn('map', 'war')] : [],
    }),
  },
  {
    id: 'war:tournaments', section: 'combat', gate: (s) => hasResearch(s, 'ritual_tournaments'),
    build: (s) => {
      const T = ACTIONS.tournament;
      return {
        title: 'Ritual Tournaments', kw: 'tournament display border hex peaceful',
        blocks: [{ list: [
          'Challenge a rival on a border hex. Your display = committed ants × size (minor ' + T.size.minor + ', soldier ' + T.size.soldier + ', supermajor ' + T.size.supermajor + ').',
          'Their display = ' + T.rivalPer + ' × soldiers × (1 + ' + T.tierStep + ' × (tier − 1)).',
          'At ×' + T.win + ' or more the hex flips to you with no losses; at ×1/' + T.win + ' or less you withdraw. In between, escalate to a small battle or withdraw.',
          'One tournament per rival every ' + fmtTime(T.cdSec) + '; the display lasts ' + T.sec + ' s.',
        ] }],
        tabs: [tabBtn('map', 'war')],
      };
    },
  },
  {
    id: 'war:raids', section: 'combat', gate: (s) => isShown(s, 'raid_warnings'),
    sig: (s) => [chamberShown(s, 'gate'), isShown(s, 'season_dial'), hasResearch(s, 'early_warning')].map(Number).join(''),
    build: (s) => ({
      title: 'Raids on your colony', kw: 'raid defend garrison theft warning gate',
      blocks: [
        { kv: [['Incoming raids this run', live((s2) => fmtCount(num(s2.run.stats.raidsIncoming)))]] },
        { list: gated(s, [
          'Rivals raid once their nest is revealed or after ' + fmtTime(RAIDS.minRunSec) + ' of the run, from ' + RAIDS.minAdults + ' adults on.',
          'A warning comes ' + RAIDS.warnBase + ' s ahead (+' + RAIDS.warnPerScout + ' s per scout, at most ' + RAIDS.warnMax + ' s).',
          'Trail raids hit a trail near their land; dispatch the garrison or escort the trail. Border trails are hit ×' + RAIDS.borderMult + ' as often.',
          'Nest raids fight your garrison at the entrance; a lost defence steals ' + upct(RAIDS.theft) + ' of the food in reach and harms brood.',
          ['No raids in winter; summer raids are the most common.', (s2) => isShown(s2, 'season_dial')],
          ['The Gate makes the entrance fight easier and cuts theft.', (s2) => chamberShown(s2, 'gate')],
        ]) },
      ],
      links: chamberShown(s, 'gate') ? [{ entry: 'chamber:gate', label: nameOf('chamber', 'gate') }] : [], tabs: isShown(s, 'panel_map') ? [tabBtn('map', 'war')] : [],
    }),
  },
];

const DEF_RIVALS = Object.keys(RIVALS).concat([ELDER.id]).map((id) => ({
  id: 'rival:' + id, section: 'combat', gate: (s) => rivalsSeen(s).includes(id),
  build: (s) => {
    if (id === ELDER.id) {
      return { title: ELDER.name, kw: 'rival elder colony', blocks: [{ list: [
        'Procedural colonies that appear at tier ' + ELDER.fromTier + ' and above, each ×' + ELDER.apGrowth + ' stronger than the last.',
        'Base AP ' + n0(ELDER.apBase) + ' at tier ' + ELDER.fromTier + '. Each carries ' + ELDER.traitsMin + '–' + ELDER.traitsMax + ' random traits.',
      ] }], tabs: isShown(s, 'panel_map') ? [tabBtn('map', 'war')] : [] };
    }
    const R = RIVALS[id];
    const kv = [['Species', R.sci], ['Tier', String(R.tier)], ['Soldiers', fmtCount(R.soldiers) + ' at first (grow up to ×' + GROWTH.maxMult + ')'], ['ATK / HP', R.atk + ' / ' + R.hp],
      ['Base AP', fmt(R.soldiers * unitPower(R.atk, R.hp))], ['Territory radius', String(R.radius)], ['Raids', 'about every ' + R.raidMin + ' min']];
    const traits = R.traits.map((t) => (RIVAL_TRAIT_TEXT[t] ? RIVAL_TRAIT_TEXT[t](RIVAL_TRAITS[t] || {}) : t));
    return { title: R.name, kw: 'rival species ' + R.sci, blocks: [{ kv }, traits.length ? { list: traits } : { note: 'No special traits.' },
      { note: 'Rivals grow ' + upct(GROWTH.perMin) + ' a minute (' + upct(GROWTH.perMinSummer) + ' in summer) and sleep through winter.' }],
      links: [{ entry: 'war:ap', label: 'Army Power' }], tabs: isShown(s, 'panel_map') ? [tabBtn('map', 'war')] : [] };
  },
}));

const DEF_BOSSES = Object.keys(BOSSES).map((id) => ({
  id: 'boss:' + id, section: 'combat', gate: (s) => bossesSeen(s).includes(id),
  build: (s) => {
    const B = BOSSES[id];
    const list = [];
    if (id === 'old_ridge_supercolony') {
      list.push('Appears once Budding is owned and you have ' + fmtCount(B.alatesCycle) + ' alates this cycle.');
      list.push('AP ' + n0(B.apBase) + ' × (1 + Supercolonies so far)^' + B.apExp + '. Immune to assault until you own ' + B.immuneUntilOwned + ' hexes.');
      list.push('Conquering it this run is required for a Supercolony.');
    } else if (id === 'great_rival') {
      list.push('Appears once the Megacolony node is owned. ' + B.nests + ' nests share AP ' + n0(B.apBase) + ' × ' + B.apGrowth + '^(Speciations so far).');
      list.push('All ' + B.nests + ' nests must fall within ' + fmtTime(B.windowSec) + ' of the first, or the fallen ones regrow.');
      list.push('Breaking it this run is required for Speciation.');
    } else {
      list.push('An event: the column crosses the map in ' + B.crossSec + ' s. AP ' + n0(B.apBase) + ' × (1 + Supercolonies so far)^' + B.apExp + '.');
      list.push('Evacuate to lose a little food, or fight it for ' + fmtTime(B.lootFoodSec) + ' of food and a pile of chitin.');
    }
    list.push('Raids about every ' + (B.raidMin || '—') + ' min.');
    return { title: B.name, kw: 'boss ' + B.sci, blocks: [{ kv: [['Species', B.sci], ['ATK / HP', B.atk + ' / ' + B.hp]] }, { list: id === 'army_ant_column' ? list.slice(0, 2) : list }],
      tabs: isShown(s, 'panel_prestige') ? [tabBtn('prestige')] : [] };
  },
}));

// ---------------------------------------------------------------------------------------------------------------
// 7. Seasons and events
// ---------------------------------------------------------------------------------------------------------------

const DEF_SEASONS = [
  {
    id: 'season:clock', section: 'seasons', gate: (s) => isShown(s, 'season_dial'),
    sig: (s) => [isShown(s, 'panel_rivals'), isShown(s, 'panel_prestige'), isShown(s, 'panel_research')].map(Number).join(''),
    build: (s) => {
      const rows = [];
      const add = (label, key, gate = true, fmtFn = (v) => '×' + v) => { if (gate) rows.push([label, ...SEASON_ORDER.map((k) => fmtFn(SEASON_MODS[k][key]))]); };
      add('Forage', 'forage');
      add('Lay rate', 'lay');
      add('Brood time', 'broodTime');
      add('Dig', 'dig');
      add('Insight', 'insight', isShown(s, 'panel_research'));
      add('Food cap', 'foodCap');
      add('Rival aggression', 'rivalAggro', isShown(s, 'panel_rivals'), (v) => (v > 0 ? '×' + v : 'asleep'));
      add('Flight weather', 'flightW', isShown(s, 'panel_prestige'));
      return {
        title: 'Seasons', kw: 'season spring summer autumn winter year clock',
        blocks: [
          { kv: [['Now', live((s2, d2) => (SEASON_NAMES[d2.season.id] || '—') + ', ' + fmtTime(num(d2.season.toNext)) + ' left')], ['Year', live((s2, d2) => fmtCount(num(d2.season.year) + 1))]] },
          { p: live((s2) => 'Each season lasts ' + fmtTime(num(s2.meta.season && s2.meta.season.lengthSec, YEAR.lengthSec)) + ', four to a year: spring, summer, autumn, winter. The clock keeps running offline and through every prestige.') },
          { table: { head: ['Effect', ...SEASON_ORDER.map((k) => SEASON_NAMES[k])], rows } },
          { note: 'The first winter is mild: forage ×' + SEASON_MODS.winter.forageMild + ' instead of ×' + SEASON_MODS.winter.forage + ', and the frost stays shallow.' },
        ],
        links: isShown(s, 'frost_line') || isShown(s, 'climate_overlay') ? [{ entry: 'nest:frost', label: 'Frost' }] : [],
      };
    },
  },
  {
    id: 'season:events', section: 'seasons', gate: (s) => isShown(s, 'events') || eventsSeen(s).length > 0,
    sig: (s) => eventsSeen(s).join(','),
    build: (s) => {
      const ids = eventsSeen(s);
      const rows = ids.map((id) => {
        const E = EVENTS[id];
        const ch = E.choices ? E.choices.map((c) => (CHOICE_LABELS[c.id] || c.id) + (c.def ? ' (default)' : '') + ': ' + tip(s, CHOICE_TIPS[id] || {}, c.id)).join(' · ') : '';
        const when = E.seasons ? E.seasons.map((k) => SEASON_SHORT[k]).join(', ') : 'any season';
        return [E.name, tip(s, EVENT_COPY, id) + (ch ? ' ' + ch : ''), when];
      });
      return {
        title: 'Events you have met', kw: 'event random weather disease card',
        blocks: [
          { kv: [['Events this run', live((s2) => fmtCount(num(s2.run.stats.eventsSeen)))], ['All time', live((s2) => fmtCount(num(s2.meta.counters.events)))]] },
          { p: 'Random events arrive every few minutes. Cards wait ' + 30 + ' s for a choice and pick the marked default if you do nothing. Red chips at the top show harmful effects; click one to find it.' },
          rows.length ? { table: { head: ['Event', 'What happens', 'When'], rows } } : { note: 'None recorded yet.' },
          { note: 'Other events will be described here once your colony meets them.' },
        ],
      };
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// 8. Research
// ---------------------------------------------------------------------------------------------------------------

const DEF_RESEARCH = [
  {
    id: 'research:overview', section: 'research', gate: (s) => isShown(s, 'panel_research'),
    build: (s) => ({
      title: 'How research works', kw: 'research insight innate refinement',
      blocks: [{ list: [
        'Spend insight on nodes in six branches. A node opens once its prerequisites are owned.',
        'Research resets with a Flight, but a node owned at the end of ' + INNATE.runs + ' runs becomes Innate: free at the start of every later run.',
        'Finishing a whole branch opens Refinements: ×' + REFINEMENT.mult + ' to that branch’s main output per level, from ' + n0(REFINEMENT.base) + ' insight.',
      ] }, { kv: [['Insight', live((s2) => fmt(num(s2.run.res.insight)))], ['Rate', live((s2, d2) => fmtRate(num(d2.rates.insight && d2.rates.insight.net)))]] }],
      tabs: [tabBtn('research')],
    }),
  },
  ...BRANCH_ORDER.map((b) => ({
    id: 'research:' + b, section: 'research', gate: (s) => isShown(s, 'panel_research'),
    sig: (s) => RESEARCH_ORDER.filter((id) => RESEARCH[id].branch === b).map((id) => (researchOwned(s, id) ? 2 : researchAvailable(s, id) ? 1 : 0)).join(''),
    build: (s) => {
      const ids = RESEARCH_ORDER.filter((id) => RESEARCH[id].branch === b);
      const owned = ids.filter((id) => researchOwned(s, id));
      const avail = ids.filter((id) => !researchOwned(s, id) && researchAvailable(s, id));
      const locked = ids.length - owned.length - avail.length;
      const innate = obj(s.era && s.era.innate);
      const blocks = [{ kv: [['Owned', fmtCount(owned.length) + ' / ' + fmtCount(ids.length)]] }];
      if (owned.length) blocks.push({ h: 'Owned' }, { list: owned.map((id) => nameOf('research', id) + (innate[id] ? ' (Innate)' : '') + (tip(s, RESEARCH_TIPS, id) ? ': ' + tip(s, RESEARCH_TIPS, id) : '')) });
      if (avail.length) blocks.push({ h: 'Available now' }, { list: avail.map((id) => nameOf('research', id) + ' — ' + n0(RESEARCH[id].cost) + ' insight' + (tip(s, RESEARCH_TIPS, id) ? ': ' + tip(s, RESEARCH_TIPS, id) : '')) });
      if (locked > 0) blocks.push({ note: fmtCount(locked) + ' more ' + (locked === 1 ? 'node waits' : 'nodes wait') + ' deeper in this branch.' });
      if (!locked && !avail.length) blocks.push({ kv: [['Refinement', live((s2) => 'L' + fmtCount(num(s2.run.refinements[b])) + ', next ' + costText(q(() => refinementCost(s2, b), null)))]] });
      return { title: nameOf('branch', b), kw: 'research branch ' + b, blocks, tabs: [tabBtn('research')] };
    },
  })),
];

// ---------------------------------------------------------------------------------------------------------------
// 9. Prestige
// ---------------------------------------------------------------------------------------------------------------

/** Projected-alates breakdown with the player's values (prestige.projectAlates terms). */
export function flightTerms(s, d) {
  const fRun = num(s.run.fRun);
  const court = traitLevel(s, 'royal_court') > 0;
  const rearedMax = court ? FLIGHT.rearedMaxCourt : FLIGHT.rearedMax;
  const reared = Math.min(num(s.run.colony.alatesReared), rearedMax);
  const food = FLIGHT.base * Math.sqrt(Math.max(0, fRun) / FLIGHT.div);
  const terr = 1 + num(s.run.tPeak) / FLIGHT.tPeakDiv;
  const rear = 1 + FLIGHT.rearedPer * reared;
  const seasonW = num(d && d.season && d.season.mods ? d.season.mods.flightW : 1, 1);
  const W = Math.max(seasonW, q(() => effectMult(s, 'flight_w'), 1));
  const mult = num(d && d.meta && d.meta.prestige ? d.meta.prestige.alates : 1, 1);
  const vaultL = num(d && d.nest && d.nest.agg ? d.nest.agg.deepVaultL : 0);
  const vault = 1 + num(CHAMBERS.deep_vault.fx.alates) * vaultL;
  const raw = food * terr * rear * W * mult * vault;
  const proj = num(d && d.meta && d.meta.proj ? d.meta.proj.alates : NaN, NaN);
  // C146: the lasting multiplier split into its parts (prestige.alatesMult): Wide Wings, kinship, achievement bonuses
  const wideL = traitLevel(s, 'wide_wings');
  const wide = num(TRAITS.wide_wings && TRAITS.wide_wings.fx && TRAITS.wide_wings.fx.mult, 1.15) ** wideL;
  const K = num(s.era && s.era.kinshipLife);
  const kin = (1 + K) ** num(PASSIVE.kAlates, 0.25);
  let ach = 1;
  const achIds = [];
  for (const id of Object.keys(ACH_META)) {
    if (!ACH_META[id].alates) continue;
    achIds.push(id);
    if (obj(s.meta && s.meta.achievements)[id] !== undefined) ach *= ACH_META[id].alates;
  }
  return { fRun, food, terr, rear, reared, rearedMax, W, mult, vault, vaultL, raw, softcapped: raw > SOFTCAPS.alates[0][0],
    tPeak: num(s.run.tPeak), seasonW, eventW: q(() => effectMult(s, 'flight_w'), 1), wideL, wide, K, kin, ach, achIds,
    projected: Number.isFinite(proj) ? proj : q(() => projectAlates(s, d), 0) };
}

/**
 * C146 "What increases flight alates": one row per factor of the Flight formula with the player's current value and
 * multiplier. Rows that would name unrevealed content (Wide Wings before the Bloodline, kinship before the
 * Supercolony teaser, the Deep Vault before it is shown, achievements before the tab) are left out. Shared by the
 * Prestige tab (Flight view) and the Manual.
 * @param {Object} s
 * @param {Object} d
 * @returns {{ id: string, label: string, how: string, value: string, mult: string }[]}
 */
export function flightFactorRows(s, d) {
  const t = flightTerms(s, d);
  const pctPer = Math.round(FLIGHT.rearedPer * 100);
  const terrPer = Math.round((100 / FLIGHT.tPeakDiv) * 100) / 100;
  const summerW = num(SEASON_MODS.summer && SEASON_MODS.summer.flightW, 1.25);
  const dayW = num(EVENTS.ev_flight_day && EVENTS.ev_flight_day.num && EVENTS.ev_flight_day.num.w, 1.5);
  const rows = [
    { id: 'food', label: 'Food gathered this run', how: 'square root: 4× the food gives 2× the alates',
      value: fmt(t.fRun) + ' food', mult: fmt(t.food) + ' base alates' },
    { id: 'territory', label: 'Peak territory', how: '+' + terrPer + '% per hex at its peak this run',
      value: fmtCount(t.tPeak) + ' hexes', mult: fmtMult(t.terr) },
    { id: 'reared', label: 'Reared alates', how: '+' + pctPer + '% each, additive (' + t.rearedMax + ' reared = +' + Math.round(FLIGHT.rearedPer * t.rearedMax * 100) + '%)',
      value: fmtCount(t.reared) + ' / ' + fmtCount(t.rearedMax), mult: fmtMult(t.rear) },
    { id: 'weather', label: 'Flight weather', how: 'summer ×' + summerW + ', Flight Day ×' + dayW + ' (the better one counts)',
      value: t.eventW > 1 ? 'Flight Day' : t.seasonW > 1 ? 'Summer' : 'Calm', mult: fmtMult(t.W) },
  ];
  if (isShown(s, 'tab_bloodline')) {
    rows.push({ id: 'wide_wings', label: nameOf('trait', 'wide_wings'), how: 'Bloodline trait: ×' + num(TRAITS.wide_wings.fx.mult, 1.15) + ' per level',
      value: 'L' + fmtCount(t.wideL), mult: fmtMult(t.wide) });
  }
  if (isShown(s, 'tab_federation_teaser') || t.K > 0) {
    rows.push({ id: 'kinship', label: 'Kinship', how: '(1 + kinship earned this era)^' + PASSIVE.kAlates, value: fmtCount(t.K) + ' kinship', mult: fmtMult(t.kin) });
  }
  if (chamberShown(s, 'deep_vault')) {
    rows.push({ id: 'deep_vault', label: nameOf('chamber', 'deep_vault'), how: '+' + Math.round(num(CHAMBERS.deep_vault.fx.alates) * 100) + '% per level',
      value: 'L' + fmtCount(t.vaultL), mult: fmtMult(t.vault) });
  }
  if (isShown(s, 'panel_achievements')) {
    const parts = t.achIds.map((id) => nameOf('achievement', id) + ' +' + Math.round((ACH_META[id].alates - 1) * 100) + '%');
    const got = t.achIds.filter((id) => obj(s.meta.achievements)[id] !== undefined).length;
    rows.push({ id: 'achievements', label: 'Achievements', how: parts.join(', '), value: fmtCount(got) + ' / ' + fmtCount(t.achIds.length) + ' earned', mult: fmtMult(t.ach) });
  }
  return rows;
}

const DEF_PRESTIGE = [
  {
    id: 'prestige:flight', section: 'prestige', gate: (s) => isShown(s, 'panel_prestige'),
    sig: (s) => [chamberShown(s, 'deep_vault'), isShown(s, 'tab_bloodline'), traitLevel(s, 'royal_court') > 0, traitLevel(s, 'brood_bank') > 0,
      isShown(s, 'tab_federation_teaser'), isShown(s, 'panel_achievements')].map(Number).join(''),
    build: (s) => {
      const T = (fn) => live((s2, d2) => fn(flightTerms(s2, d2)));
      // C146: the same factor rows as the Prestige tab's "What increases flight alates" box
      const box = flightFactorRows(s, null).map((r) => [r.label + ' (' + r.how + ')',
        live((s2, d2) => { const x = flightFactorRows(s2, d2).find((y) => y.id === r.id); return x ? x.value + ' → ' + x.mult : ''; })]);
      box.push(['Projected alates', T((t) => fmtCount(t.projected) + (t.softcapped ? ' (past the softcap)' : ''))]);
      return {
        title: 'Nuptial Flight', kw: 'flight prestige alates reset nuptial requirements',
        blocks: [
          { p: 'Your winged princesses leave to found a new colony. You start over on a new map and keep the alates they earn, which buy lasting Bloodline traits.' },
          { h: 'Requirements' },
          { kv: [
            ['Royal Chamber level ' + FLIGHT.royalLevel, live((s2, d2) => (d2.meta.proj.fly.royal5 ? '✓' : '○'))],
            [nameOf('research', 'nuptial_preparation') + ' researched', live((s2, d2) => (d2.meta.proj.fly.prep ? '✓' : '○'))],
            ['A Nuptial Chamber with its exit shaft', live((s2, d2) => (d2.meta.proj.fly.chamber ? '✓' : '○'))],
            ['Food earned this run ≥ ' + fmt(FLIGHT.fRunMin), live((s2, d2) => (d2.meta.proj.fly.fRun ? '✓' : '○'))],
          ] },
          { h: 'Alates formula' },
          { p: 'alates = ' + FLIGHT.base + ' × √(food this run / ' + fmt(FLIGHT.div) + ') × (1 + peak territory / ' + FLIGHT.tPeakDiv + ') × (1 + ' + FLIGHT.rearedPer
            + ' × reared alates) × weather × lasting multipliers' + (chamberShown(s, 'deep_vault') ? ' × Deep Vault' : '') + ', rounded down. Summer gives better flight weather.' },
          { box: { title: 'Your current values', kv: box } },
          { h: 'Resets and keeps' },
          { kv: [['Resets', FLIGHT_RESETS.join('; ') + '.'], ['Keeps', FLIGHT_KEEPS.join('; ') + '.']] },
          traitLevel(s, 'brood_bank') > 0 ? { note: 'Brood Bank keeps a share of your adults through the Flight.' } : null,
        ].filter(Boolean),
        links: [{ entry: 'chamber:royal_chamber', label: nameOf('chamber', 'royal_chamber') }].concat(chamberShown(s, 'nuptial_chamber') ? [{ entry: 'chamber:nuptial_chamber', label: nameOf('chamber', 'nuptial_chamber') }] : [])
          .concat(isShown(s, 'tab_bloodline') ? [{ entry: 'prestige:bloodline', label: 'Bloodline' }] : []),
        tabs: [tabBtn('prestige', 'flight')],
      };
    },
  },
  {
    id: 'prestige:bloodline', section: 'prestige', gate: (s) => isShown(s, 'tab_bloodline'),
    build: (s) => ({
      title: 'Bloodline and Lineage', kw: 'bloodline trait alates lineage passive',
      blocks: [
        { p: 'Spend alates on Bloodline traits; they last through every Flight. Lineage is a free passive from all alates earned this cycle: food ×Λ and lay rate ×Λ^0.25.' },
        { kv: [['Alates', live((s2) => fmtCount(num(s2.cycle.alates)))], ['Earned this cycle', live((s2) => fmtCount(num(s2.cycle.alatesCycle)))], ['Lineage Λ', live((s2, d2) => fmtMult(num(d2.meta.lineage, 1)))]] },
        { note: 'Λ = 1 + ' + LINEAGE.per + ' × alates up to ' + LINEAGE.knee + ', then ' + LINEAGE.high + ' × √(alates / ' + LINEAGE.knee + ').' },
        { table: { head: ['Trait', 'Effect', 'Level', 'Next'], rows: TRAIT_ORDER.map((id) => [nameOf('trait', id), tip(s, TRAIT_TIPS, id),
          live((s2) => fmtCount(traitLevel(s2, id)) + ' / ' + TRAITS[id].max), live((s2) => (traitLevel(s2, id) >= TRAITS[id].max ? MAX_LABEL : costText(q(() => traitCost(s2, id), null))))]) } },
      ],
      tabs: [tabBtn('prestige', 'bloodline')],
    }),
  },
  {
    id: 'prestige:hardships', section: 'prestige', gate: (s) => isShown(s, 'tab_hardships'),
    build: (s) => ({
      title: 'Hardships', kw: 'hardship challenge tier',
      blocks: [
        { p: 'Fly into a run under a handicap. Reaching the goal food in that run earns a tier with a lasting reward (up to ' + HARDSHIP.tiers + ' tiers; the goal grows ×' + n0(HARDSHIP.goalGrowth)
          + ' per tier). Supercolonies keep ' + upct(HARDSHIP.carry) + ' of the rewards.' },
        { table: { head: ['Hardship', 'What it does', 'Best tier'], rows: HARDSHIP_ORDER.map((id) => [nameOf('hardship', id), tip(s, HARDSHIP_TIPS, id),
          live((s2, d2) => fmt(num(d2.meta.hardship && d2.meta.hardship[id])))]) } },
      ],
      tabs: [tabBtn('prestige', 'hardships')],
    }),
  },
  {
    id: 'prestige:super', section: 'prestige', gate: (s) => isShown(s, 'tab_federation_teaser'),
    sig: (s) => [isShown(s, 'tab_federation')].map(Number).join(''),
    build: (s) => ({
      title: 'Supercolony', kw: 'supercolony kinship merge prestige layer',
      blocks: [
        { p: 'Merge your daughter colonies into a Supercolony: a deeper reset that pays kinship.' },
        { h: 'Requirements' },
        { kv: [
          ['The Budding trait', live((s2, d2) => (d2.meta.proj.superc.budding ? '✓' : '○'))],
          ['Alates this cycle ≥ ' + fmtCount(SUPER.alatesMin), live((s2, d2) => (d2.meta.proj.superc.alates ? '✓' : '○'))],
          ['Conquer ' + nameOf('rival', 'old_ridge_supercolony') + ' this run', live((s2, d2) => (d2.meta.proj.superc.oldRidge ? '✓' : '○'))],
        ] },
        { p: 'kinship = ' + SUPER.mult + ' × (alates this cycle / ' + n0(SUPER.div) + ')^' + SUPER.exp + ', rounded down.' },
        { box: { title: 'Your current values', kv: [['Alates this cycle', live((s2) => fmtCount(num(s2.cycle.alatesCycle)))],
          ['Projected kinship', live((s2, d2) => fmtCount(num(d2.meta.proj.kinship, q(() => projectKinship(s2, d2), 0))))]] } },
        { h: 'Passive from lifetime kinship K' },
        { list: ['Food ×(1 + K)^' + PASSIVE.kFood + '.', 'Dig, insight, honeydew, fungus and chitin ×(1 + K)^' + PASSIVE.kOther + '.', 'Flight alates ×(1 + K)^' + PASSIVE.kAlates + '.',
          'Colony scale ×(1 + K)^' + PASSIVE.kScale + '.'] },
        { h: 'Resets and keeps' },
        { kv: [['Resets', 'Everything a Flight resets; alates and alates this cycle (so Lineage); Bloodline traits except Heirlooms; Hardship tiers (rewards stay at ' + upct(HARDSHIP.carry) + ').'],
          ['Keeps', 'Kinship, Federation nodes, Innate research, achievements, Field Guide, stats, blueprints and settings.']] },
      ],
      tabs: [tabBtn('prestige', 'supercolony')],
    }),
  },
  {
    id: 'prestige:federation', section: 'prestige', gate: (s) => isShown(s, 'tab_federation'),
    build: (s) => ({
      title: 'Federation', kw: 'federation kinship node automation satellite',
      blocks: [
        { kv: [['Kinship', live((s2) => fmtCount(num(s2.era.kinship)))], ['Lifetime this era', live((s2) => fmtCount(num(s2.era.kinshipLife)))]] },
        { table: { head: ['Node', 'Effect', 'Level', 'Next'], rows: FED_ORDER.map((id) => [nameOf('federation', id), tip(s, FED_TIPS, id),
          live((s2) => fmtCount(fedLevel(s2, id)) + ' / ' + FEDERATION[id].max), live((s2) => (fedLevel(s2, id) >= FEDERATION[id].max ? MAX_LABEL : costText(q(() => fedCost(s2, id), null))))]) } },
      ],
      tabs: [tabBtn('prestige', 'federation')],
    }),
  },
  {
    id: 'prestige:edicts', section: 'prestige', gate: (s) => isShown(s, 'tab_edicts'),
    build: (s) => ({
      title: 'Royal Edicts', kw: 'edict supercolony cycle',
      blocks: [
        { p: 'Each Supercolony lets you decree one Edict that shapes the whole next cycle.' },
        { kv: [['Active edict', live((s2) => (s2.cycle.edict ? nameOf('edict', s2.cycle.edict) : 'none'))]] },
        { table: { head: ['Edict', 'Effect'], rows: EDICT_ORDER.map((id) => [nameOf('edict', id), tip(s, EDICT_TIPS, id)]) } },
      ],
      tabs: [tabBtn('prestige', 'edicts')],
    }),
  },
  {
    id: 'prestige:spec', section: 'prestige', gate: (s) => isShown(s, 'tab_genome_teaser'),
    build: (s) => ({
      title: 'Speciation', kw: 'speciation genes prestige layer era',
      blocks: [
        { p: 'Your lineage becomes a new species: the deepest reset, paid in genes, which are never lost.' },
        { h: 'Requirements' },
        { kv: [
          ['The Megacolony node', live((s2, d2) => (d2.meta.proj.spec.megacolony ? '✓' : '○'))],
          ['Break ' + nameOf('rival', 'great_rival') + ' this run', live((s2, d2) => (d2.meta.proj.spec.front ? '✓' : '○'))],
          ['Kinship this era ≥ ' + fmtCount(SPEC.kinshipMin), live((s2, d2) => (d2.meta.proj.spec.kinship ? '✓' : '○'))],
        ] },
        { p: 'genes = ' + SPEC.mult + ' × kinship this era / ' + SPEC.div + ', rounded down.' },
        { box: { title: 'Your current values', kv: [['Kinship this era', live((s2) => fmtCount(num(s2.era.kinshipLife)))],
          ['Projected genes', live((s2, d2) => fmtCount(num(d2.meta.proj.genes, q(() => projectGenes(s2, d2), 0))))]] } },
        { h: 'Passive from lifetime genes G' },
        { list: ['Food ×(1 + G)^' + PASSIVE.gFood + '.', 'Dig, insight, honeydew, fungus and chitin ×(1 + G)^' + PASSIVE.gOther + '.', 'Army Power ×(1 + G)^' + PASSIVE.gAP + '.'] },
        { kv: [['Resets', 'Everything, including kinship, Federation nodes, Hardship rewards and Innate research.'],
          ['Keeps', 'Genes, Genome nodes, species, achievements, Field Guide, stats and settings.']] },
      ],
      tabs: [tabBtn('prestige', 'speciation')],
    }),
  },
  {
    id: 'prestige:genome', section: 'prestige', gate: (s) => isShown(s, 'tab_genome'),
    sig: (s) => SPECIES_ORDER.filter((id) => obj(s.meta.speciesUnlocked)[id]).join(','),
    build: (s) => {
      const unlocked = SPECIES_ORDER.filter((id) => obj(s.meta.speciesUnlocked)[id]);
      const hidden = SPECIES_ORDER.length - unlocked.length;
      return {
        title: 'Genome and species', kw: 'genome genes species node',
        blocks: [
          { kv: [['Genes', live((s2) => fmtCount(num(s2.meta.genes)))], ['Species now', live((s2) => nameOf('species', s2.era.species))]] },
          { table: { head: ['Node', 'Effect', 'Level', 'Next'], rows: GENOME_ORDER.filter((id) => !GENOME[id].stretch).map((id) => [nameOf('genome', id), tip(s, GENOME_TIPS, id),
            live((s2) => fmtCount(genomeLevel(s2, id)) + (GENOME[id].max ? ' / ' + GENOME[id].max : '')),
            live((s2) => (GENOME[id].max && genomeLevel(s2, id) >= GENOME[id].max ? MAX_LABEL : costText(q(() => genomeCost(s2, id), null))))]) } },
          { h: 'Species you can choose' },
          { list: unlocked.map((id) => SPECIES[id].name + ' (' + SPECIES[id].sci + '): ' + tip(s, SPECIES_TIPS, id)) },
          hidden > 0 ? { note: fmtCount(hidden) + ' more ' + (hidden === 1 ? 'species waits' : 'species wait') + ' in the Genome.' } : null,
        ].filter(Boolean),
        tabs: [tabBtn('prestige', 'genome')],
      };
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// 10. Controls
// ---------------------------------------------------------------------------------------------------------------

const DEF_CONTROLS = [
  {
    id: 'controls:keys', section: 'controls', gate: () => true,
    build: (s) => ({
      title: 'Keyboard and view controls', kw: 'keys hotkeys shortcuts keyboard mouse controls',
      blocks: [
        { kv: SHORTCUTS.map(([k, what]) => [k, what]), keys: true },
        { note: 'View keys act on the view you clicked last. Keys are ignored while you type in a field. The same list is in Settings.' },
      ],
      tabs: [tabBtn('settings')],
    }),
  },
  {
    id: 'controls:mouse', section: 'controls', gate: () => true,
    sig: (s) => [isShown(s, 'panel_build'), isShown(s, 'panel_war')].map(Number).join(''),
    build: (s) => ({
      title: 'Mouse and touch', kw: 'click drag right click long press context menu',
      blocks: [{ list: gated(s, [
        'Click a source to hand-forage it (up to ' + CLICK_CAP + ' clicks a second count). Click a trail, hex or rival to select it.',
        'Drag from an entrance to a source to draw a trail; drag empty ground to pan the map.',
        ['Below: drag from an open cell across soil to dig a tunnel; click a chamber to inspect and level it.', (s2) => isShown(s2, 'panel_build')],
        ['Drag from an entrance onto a rival nest or prey to send a war party.', (s2) => isShown(s2, 'panel_war')],
        'Right-click or long-press anything for its actions (it also cancels an active tool).',
      ]) }],
    }),
  },
];

// ---------------------------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------------------------

/** Every entry definition, in section and display order. */
export const ENTRY_DEFS = Object.freeze([
  ...DEF_START, ...DEF_RESOURCES, DEF_QUEEN, ...DEF_CASTES, ...DEF_JOBS, DEF_AUTOMATION, DEF_ADAPT, ...DEF_CHAMBERS, ...DEF_NEST, ...DEF_SURFACE.slice(0, 1),
  ...DEF_SOURCES, ...DEF_SURFACE.slice(1), ...DEF_COMBAT, ...DEF_RIVALS, ...DEF_BOSSES, ...DEF_SEASONS, ...DEF_RESEARCH, ...DEF_PRESTIGE, ...DEF_CONTROLS,
].sort((a, b) => SECTIONS.findIndex((x) => x.id === a.section) - SECTIONS.findIndex((x) => x.id === b.section)));

const DEF_BY_ID = new Map(ENTRY_DEFS.map((e) => [e.id, e]));

/** The definition of an entry id, or null. */
export function entryDef(id) {
  return DEF_BY_ID.get(id) || null;
}

/** Visible entry ids (gates passed), in order. */
export function visibleEntryIds(s, d) {
  if (!s || !s.run || !s.meta) return [];
  return ENTRY_DEFS.filter((e) => q(() => e.gate(s, d), false)).map((e) => e.id);
}

/**
 * Structure signature: visible ids plus each entry's sig. The Manual rebuilds its DOM only when this changes.
 * @param {Object} s
 * @param {Object} d
 * @returns {string}
 */
export function manualSignature(s, d) {
  const parts = [];
  for (const id of visibleEntryIds(s, d)) {
    const e = DEF_BY_ID.get(id);
    parts.push(id + (e.sig ? '=' + q(() => e.sig(s, d), '') : ''));
  }
  return parts.join(';');
}

/**
 * Build one entry (null when it is not visible or fails).
 * @param {Object} s
 * @param {Object} d
 * @param {string} id
 * @returns {Object|null}
 */
export function buildEntry(s, d, id) {
  const def = DEF_BY_ID.get(id);
  if (!def || !q(() => def.gate(s, d), false)) return null;
  const e = q(() => def.build(s, d), null);
  if (!e) return null;
  return { id, section: def.section, links: [], tabs: [], kw: '', ...e };
}

/**
 * Sections with their visible entry ids, and whether locked entries remain (for the muted "more" line).
 * @param {Object} s
 * @param {Object} d
 * @returns {Array<{ id: string, title: string, entries: string[], more: boolean }>}
 */
export function manualIndex(s, d) {
  const vis = new Set(visibleEntryIds(s, d));
  return SECTIONS.map((sec) => {
    const all = ENTRY_DEFS.filter((e) => e.section === sec.id);
    const entries = all.filter((e) => vis.has(e.id)).map((e) => e.id);
    return { id: sec.id, title: sec.title, entries, more: entries.length < all.length };
  }).filter((sec) => sec.entries.length > 0);
}

/** Evaluate a Text (string or live) now. */
export function textOf(t, s, d) {
  if (t === null || t === undefined) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return String(t);
  if (t && typeof t.live === 'function') {
    return String(q(() => t.live(s, d), '—'));
  }
  return '';
}

/** Plain text of an entry (title, keywords, every block) for search. */
export function entryText(entry, s, d) {
  if (!entry) return '';
  const out = [entry.title, entry.kw || ''];
  for (const b of arr(entry.blocks)) {
    if (!b) continue;
    if (b.p) out.push(textOf(b.p, s, d));
    if (b.note) out.push(b.note);
    if (b.h) out.push(b.h);
    for (const t of arr(b.list)) out.push(textOf(t, s, d));
    for (const [k, v] of arr(b.kv)) out.push(k, textOf(v, s, d));
    if (b.table) { out.push(...arr(b.table.head)); for (const r of arr(b.table.rows)) for (const c of r) out.push(textOf(c, s, d)); }
    if (b.box) { out.push(b.box.title); for (const [k, v] of arr(b.box.kv)) out.push(k, textOf(v, s, d)); }
  }
  return out.join(' ');
}

/**
 * True when every word of the query appears in the text (case-insensitive).
 * @param {string} text
 * @param {string} query
 * @returns {boolean}
 */
export function matchesQuery(text, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const t = String(text || '').toLowerCase();
  return words.every((w) => t.includes(w));
}
