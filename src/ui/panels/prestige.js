// Prestige panel: sub-tabs Flight (checklist, alate rearing (C116), projection, alates/min meter with peak glow, Auto-Flight
// (C166)) · Bloodline (+ heirlooms) · Hardships · Supercolony (+ kinship breakdown C169, Auto-Supercolony C166) ·
// Federation (+ satellites) · Edicts · Speciation · Genome (+ chronobiology) · Species, each revealed by its unlock key (teasers greyed); the Flight sub-tab ends with the Colony
// History button (C130: gallery of past runs, ui/history.js). Owner: WP9.
// Contract: ARCHITECTURE §14.5 (Prestige row), §8.6, §11; DESIGN §13–§15, §23.
// Queries: d.meta.proj, prestige.project*, traits.*Cost, hardships.goal / effectiveTier.

import { h, setText, setProp, show, toggleClass, syncList, setCost, clear } from '../dom.js';
import { fmt, fmtCount, fmtTime, fmtMult, fmtPct } from '../format.js';
import {
  nameOf, TRAIT_TIPS, FED_TIPS, GENOME_TIPS, HARDSHIP_TIPS, EDICT_TIPS, SPECIES_TIPS, SUBTAB_NAMES, SEASON_NAMES, unlockHint, oldRidgeHint,
  AUTO_POINTER_TEXT,
} from '../text.js';
import { isShown, traitLevel, fedLevel, genomeLevel, num, arr, obj } from '../reveal.js';
import { projectAlates, projectKinship, projectGenes, kinshipBreakdown } from '../../systems/prestige.js';
import { broodSummary } from '../../systems/population.js';
import { eggCost } from '../../systems/stats.js';
import { traitCost, fedCost, genomeCost } from '../../systems/traits.js';
import { goal as hardshipGoal, effectiveTier } from '../../systems/hardships.js';
import { TRAIT_ORDER, TRAITS } from '../../data/bloodline.js';
import { FED_ORDER, FEDERATION } from '../../data/federation.js';
import { GENOME_ORDER, GENOME, SPECIES_ORDER, SPECIES } from '../../data/genome.js';
import { FLIGHT, SUPER, SPEC, HARDSHIP, HARDSHIPS, EDICTS } from '../../data/prestige.js';
import { SOFTCAPS } from '../../data/balance.js';
import { YEAR } from '../../data/seasons.js';
import { makeAct, note, progressBar, subTabStrip, sliderRow } from './common.js';
import { historyCount } from '../history.js';
import { flightAutoBox, superAutoBox } from './automation.js';
import { flightFactorRows, flightTerms } from '../manualContent.js';

const SUBS = ['flight', 'bloodline', 'hardships', 'supercolony', 'federation', 'edicts', 'speciation', 'genome', 'species'];
/** Reveal key per sub-tab, and the teaser key that shows it greyed. */
export const SUB_KEYS = Object.freeze({
  flight: { key: 'panel_prestige' },
  bloodline: { key: 'tab_bloodline' },
  hardships: { key: 'tab_hardships' },
  supercolony: { key: 'tab_federation_teaser' },
  federation: { key: 'tab_federation', teaser: 'tab_federation_teaser' },
  edicts: { key: 'tab_edicts' },
  speciation: { key: 'tab_genome_teaser' },
  genome: { key: 'tab_genome', teaser: 'tab_genome_teaser' },
  species: { key: 'tab_genome', teaser: 'tab_genome_teaser' },
});
/** Genome nodes shown in the shop: STRETCH nodes (biomes) are not built and can never be bought, so they are hidden (F16). */
export const GENOME_BUYABLE = Object.freeze(GENOME_ORDER.filter((id) => !(GENOME[id] && GENOME[id].stretch)));
const HARDSHIP_FALLBACK = ['eternal_winter', 'claustral_founding', 'pacifist', 'barren_ground', 'shallow_soil', 'monomorphic'];
const SPECIES_FALLBACK = ['garden_ant', 'leafcutter', 'honeypot', 'fire_ant'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/**
 * C146 reared-alate rule in words (DESIGN §13.2: × (1 + 0.02 × reared), additive, capped at 25 or 50 with Royal Court).
 * @param {number} [max] the cap this run
 * @returns {string}
 */
export function rearedRuleText(max = num(FLIGHT.rearedMax, 25)) {
  const per = num(FLIGHT.rearedPer, 0.02);
  const pct = Math.round(per * 100);
  return 'Each reared alate gives +' + pct + '% more alates on your next flight (+' + pct + '% each, additive: ' + max + ' reared = +'
    + Math.round(per * max * 100) + '%).';
}

/** C169: what raises kinship, in words (shown under the kinship breakdown). */
export const KINSHIP_HOW = Object.freeze([
  'More alates this cycle: every Nuptial Flight banks its alates here, so bigger and more flights raise kinship.',
  "This run's alates count too: the merge counts them as if the colony had flown, so grow this run (food, territory, reared alates, summer weather) before merging.",
  'Anything that raises flight alates (Wide Wings, kinship already earned, achievements) raises kinship through them.',
]);

/**
 * C169 kinship breakdown rows (prestige.kinshipBreakdown → { id, label, how, value, mult }).
 * @param {{ banked: number, run: number, total: number, raw: number, softcapped: boolean, kinship: number, nextAt: number|null }} kb
 * @returns {{ id: string, label: string, how: string, value: string, mult: string }[]}
 */
export function kinshipRows(kb) {
  const cap = SOFTCAPS && SOFTCAPS.kinship && SOFTCAPS.kinship[0] ? SOFTCAPS.kinship[0][0] : 1e5;
  return [
    { id: 'banked', label: 'Alates this cycle', how: 'banked by the Nuptial Flights of this cycle', value: fmtCount(kb.banked) + ' alates', mult: '' },
    { id: 'run', label: "This run's alates", how: 'projected alates of this run, counted as if it flew', value: '+' + fmtCount(kb.run) + ' alates', mult: '' },
    { id: 'total', label: 'Alates counted', how: (num(SUPER.mult, 2)) + ' × (alates / ' + fmtCount(num(SUPER.div, 1000)) + ')^' + num(SUPER.exp, 0.35)
      + ': 10× the alates gives about ×' + fmt(10 ** num(SUPER.exp, 0.35)) + ' kinship', value: fmtCount(kb.total) + ' alates', mult: fmt(kb.raw) + ' kinship' },
    { id: 'softcap', label: 'Softcap', how: 'kinship above ' + fmtCount(cap) + ' per merge grows more slowly', value: kb.softcapped ? 'active' : 'not reached', mult: '' },
    { id: 'kinship', label: 'Kinship on merging', how: 'rounded down' + (kb.nextAt ? '; the next point at ' + fmtCount(kb.nextAt) + ' alates' : ''),
      value: '', mult: fmtCount(kb.kinship) + ' kinship' },
  ];
}

/** Safe query. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Visible / greyed state of every prestige sub-tab.
 * @param {Object} s
 * @returns {{ visible: Object<string, boolean>, greyed: Object<string, boolean> }}
 */
export function subTabState(s) {
  const visible = {};
  const greyed = {};
  for (const id of SUBS) {
    const k = SUB_KEYS[id];
    const full = isShown(s, k.key);
    const teaser = !full && k.teaser ? isShown(s, k.teaser) : false;
    visible[id] = full || teaser;
    greyed[id] = teaser;
  }
  return { visible, greyed };
}

/** Checklist widget: items [{ id, label }] → update(flags, labels?). */
function checklist(items) {
  const el = h('ul', { class: 'checklist' });
  const rows = {};
  for (const it of items) {
    const mark = h('span', { class: 'check-mark', attrs: { 'aria-hidden': 'true' } });
    const label = h('span', { text: it.label });
    const li = h('li', null, mark, label);
    rows[it.id] = { li, mark, label };
    el.appendChild(li);
  }
  return {
    el,
    update(flags, labels = {}) {
      for (const id of Object.keys(rows)) {
        const ok = !!(flags && flags[id]);
        toggleClass(rows[id].li, 'done', ok);
        setText(rows[id].mark, ok ? '✓' : '○');
        if (labels[id]) setText(rows[id].label, labels[id]);
      }
    },
  };
}

/**
 * Prestige panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object, dialogs?: Object }} ctx
 */
export function createPanel(root, { game, ui, bridge, dialogs = null }) {
  const act = makeAct(game, bridge);
  const el = h('div', { class: 'panel panel-prestige' });
  root.appendChild(el);
  const subs = subTabStrip(SUBS, SUBTAB_NAMES, (id) => ui.setUI({ subTab: id }));
  el.appendChild(subs.el);
  const views = {};
  for (const id of SUBS) {
    views[id] = h('div', { class: 'sub-view sub-' + id });
    el.appendChild(views[id]);
  }
  const teaserNote = {};
  for (const id of ['federation', 'genome', 'species']) {
    teaserNote[id] = h('div', { class: 'alert alert-teaser' });
    views[id].appendChild(teaserNote[id]);
  }
  const dlg = (name, ...args) => {
    if (dialogs && typeof dialogs[name] === 'function') return dialogs[name](...args);
    return null;
  };

  // ------------------------------------------------------------------ Flight
  const flyList = checklist([
    { id: 'royal5', label: 'Royal Chamber level ' + num(FLIGHT.royalLevel, 5) },
    { id: 'prep', label: 'Nuptial Preparation researched' },
    { id: 'chamber', label: 'Nuptial Chamber and its exit shaft' },
    { id: 'fRun', label: 'Food earned this run ≥ ' + fmt(num(FLIGHT.fRunMin, 1e8)) },
  ]);
  const projEl = h('span', { class: 'big-num' });
  const perMinEl = h('span', { class: 'muted' });
  const meter = progressBar('bar-alates');
  const peakNote = h('p', { class: 'peak-note' });
  const flyKv = h('dl', { class: 'kv' });
  const kvRear = h('dd');
  const kvWeather = h('dd');
  const kvLineage = h('dd');
  const kvAlates = h('dd');
  flyKv.append(h('dt', { text: 'Reared alates' }), kvRear, h('dt', { text: 'Flight weather' }), kvWeather,
    h('dt', { text: 'Lineage bonus' }), kvLineage, h('dt', { text: 'Alates owned' }), kvAlates);
  const flyBtn = h('button', { type: 'button', class: 'btn btn-primary btn-big', text: 'Take the Nuptial Flight',
    on: { click: () => dlg('flight') } });
  const flyHint = h('p', { class: 'note' });
  // Alate rearing (moved here from the Colony tab, C116; same controls, shown with the alate_rearing key)
  const alateCount = h('dd');
  const alateCost = h('span', { class: 'cost' });
  const rear1 = h('button', { type: 'button', class: 'btn btn-small', text: 'Rear 1', on: { click: (ev) => act('rearAlate', { n: 1 }, ev, rear1) } });
  const rear5 = h('button', { type: 'button', class: 'btn btn-small', text: 'Rear 5', on: { click: (ev) => act('rearAlate', { n: 5 }, ev, rear5) } });
  const autoRear = h('input', { type: 'checkbox', class: 'check' });
  autoRear.addEventListener('change', (ev) => act('setAutomation', { patch: { autoRear: !!autoRear.checked } }, ev, autoRear));
  const rearRule = h('p', { class: 'note rear-rule', text: rearedRuleText() });
  const alateSec = h('section', { class: 'sec sec-alates' }, h('h3', { class: 'sec-title', text: 'Alate rearing' }),
    rearRule,
    h('dl', { class: 'kv' }, h('dt', { text: 'Reared / cells' }), alateCount, h('dt', { text: 'Next alate egg' }), h('dd', null, alateCost)),
    h('div', { class: 'btn-row' }, rear1, rear5),
    h('label', { class: 'toggle-row', dataset: { tip: 'Rear alates whenever a cell is free.' } }, autoRear, h('span', { text: 'Auto-rear' })));
  views.flight.append(
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Nuptial Flight' }),
      h('p', { class: 'note', text: 'Rear winged princesses, then fly to refound stronger.' }), flyList.el),
    alateSec,
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Projection' }),
      h('div', { class: 'row-between' }, h('span', null, projEl, ' alates'), perMinEl), meter.el, peakNote, flyKv, flyBtn, flyHint));
  // C146 "What increases flight alates": every factor of the Flight formula with the current value
  const factorList = h('div', { class: 'flight-factors' });
  const factorSec = h('section', { class: 'sec sec-factors' }, h('h3', { class: 'sec-title', text: 'What increases flight alates' }),
    h('p', { class: 'note', text: 'Your flight multiplies these together. Current values:' }), factorList);
  views.flight.append(factorSec);
  // C166: Auto-Flight lives with the Flight it automates (shown once Federation Auto-Flight is owned)
  const afBox = flightAutoBox({ game, bridge });
  views.flight.append(afBox.el);
  // Colony History (C130): replaces the Strata fossils once drawn in the nest's bedrock
  const histNote = h('p', { class: 'note' });
  const histBtn = h('button', { type: 'button', class: 'btn', text: 'Open Colony History', on: { click: () => dlg('history') } });
  const histSec = h('section', { class: 'sec sec-history' }, h('h3', { class: 'sec-title', text: 'Colony History' }), histNote, histBtn);
  views.flight.append(histSec);

  // ------------------------------------------------------------------ Generic buy list (traits, federation, genome)
  function buyList(kind, ids, tips, costFn, cmd, levelFn, maxFn, lockFn = null) {
    const list = h('div', { class: 'list buy-list' });
    const create = (id) => {
      const lvl = h('span', { class: 'lvl' });
      const costEl = h('span', { class: 'cost' });
      const btn = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Buy',
        on: { click: (ev) => act(cmd, { id }, ev, btn) } });
      const row = h('div', { class: 'buy-row', dataset: { id, tip: tips[id] || '' } },
        h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf(kind, id) }), lvl, h('span', { class: 'buy-desc', text: tips[id] || '' })),
        h('div', { class: 'buy-side' }, costEl, btn));
      row.__r = { lvl, costEl, btn };
      return row;
    };
    const update = (s, greyed) => {
      syncList(list, ids(), (id) => id, create, (row, id) => {
        const r = row.__r;
        const L = levelFn(s, id);
        const max = maxFn(id);
        setText(r.lvl, max > 0 ? 'L' + fmtCount(L) + ' / ' + fmtCount(max) : 'L' + fmtCount(L));
        const c = q(() => costFn(s, id), null);
        const atMax = max > 0 && L >= max;
        const ok = setCost(r.costEl, atMax ? null : c, s);
        const locked = !atMax && !!lockFn && lockFn(s, id); // C172: a node that needs another node first
        toggleClass(row, 'cant', !ok || locked);
        toggleClass(row, 'owned', atMax);
        toggleClass(row, 'locked', locked);
        setProp(r.btn, 'disabled', !!greyed || atMax || c === null || locked);
        setText(r.btn, atMax ? 'Owned' : locked ? 'Locked' : 'Buy');
      });
    };
    return { list, update };
  }

  // ------------------------------------------------------------------ Bloodline
  const alatesBal = h('span', { class: 'big-num' });
  const alatesMeta = h('span', { class: 'muted' });
  const traitList = buyList('trait', () => TRAIT_ORDER, TRAIT_TIPS, traitCost, 'buyTrait', traitLevel, (id) => num(TRAITS[id] && TRAITS[id].max, 0));
  const heirBox = h('div', { class: 'heirlooms' });
  const heirSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Heirlooms' }),
    h('p', { class: 'note', text: 'Choose up to three traits to keep through Supercolonies.' }), heirBox);
  views.bloodline.append(
    h('div', { class: 'row-between balance' }, h('span', null, h('i', { class: 'ico ico-alates' }), ' ', alatesBal, ' alates'), alatesMeta),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Bloodline traits' }), traitList.list,
      TRAIT_ORDER.length ? null : note('Trait data not loaded yet.')), heirSec);

  // ------------------------------------------------------------------ Hardships
  const activeHard = h('div', { class: 'alert alert-tool' });
  const hardList = h('div', { class: 'list' });
  views.hardships.append(activeHard, h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Hardships' }),
    h('p', { class: 'note', text: 'A Flight into a constrained run. Tiers reward food earned in that run.' }), hardList));

  // ------------------------------------------------------------------ Supercolony
  const superList = checklist([
    { id: 'budding', label: 'Budding trait owned' },
    { id: 'alates', label: 'Alates this cycle ≥ ' + fmtCount(num(SUPER.alatesMin, 5000)) },
    { id: 'oldRidge', label: 'The Old Ridge Supercolony conquered this run' },
  ]);
  const kinProj = h('span', { class: 'big-num' });
  const daughtersEl = h('p', { class: 'note' });
  const mergeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-big', text: 'Form a Supercolony', on: { click: () => dlg('supercolony') } });
  const kinNote = h('p', { class: 'note' });
  views.supercolony.append(h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Supercolony' }),
    h('p', { class: 'note', text: 'Fuse your daughter colonies into one. Earn kinship.' }), superList.el,
    h('p', null, 'Projected: ', kinProj, ' kinship'), kinNote, daughtersEl, mergeBtn));
  // C169 "What increases kinship": the kinship formula's terms with the player's values (like the C146 alates box)
  const kinFactors = h('div', { class: 'flight-factors kin-factors' });
  const kinSec = h('section', { class: 'sec sec-factors' }, h('h3', { class: 'sec-title', text: 'What increases kinship' }),
    h('p', { class: 'note', text: 'kinship = ' + num(SUPER.mult, 2) + ' × (alates / ' + fmtCount(num(SUPER.div, 1000)) + ')^' + num(SUPER.exp, 0.35)
      + ', rounded down. Current values:' }), kinFactors,
    h('ul', { class: 'plain-list' }, KINSHIP_HOW.map((x) => h('li', { text: x }))));
  views.supercolony.append(kinSec);
  // C166: Auto-Supercolony lives with the Supercolony it automates (shown once Genome Deep-Time Automation is owned)
  const asBox = superAutoBox({ game, bridge });
  views.supercolony.append(asBox.el);

  // ------------------------------------------------------------------ Federation (+ automation, satellites)
  const kinBal = h('span', { class: 'big-num' });
  const fedList = buyList('federation', () => FED_ORDER, FED_TIPS, fedCost, 'buyFederation', fedLevel,
    (id) => { const f = FEDERATION[id]; return f ? num(f.max, f.cost && Array.isArray(f.cost.list) ? f.cost.list.length : 1) : 0; },
    (s, id) => { const f = FEDERATION[id]; return !!(f && typeof f.requires === 'string') && !(fedLevel(s, f.requires) > 0); });
  // C166: the automation switches moved to where they act (AUTO_POINTER_TEXT); this section keeps the satellites.
  const autoSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Satellites and automation' }));
  const autoPointer = h('p', { class: 'note auto-pointer', text: AUTO_POINTER_TEXT });
  const satBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Place a satellite on the map…',
    on: { click: () => { ui.setUI({ tool: { kind: 'placeSatellite' } }); const st = ui.getUI(); if (st.layout === 'medium' || st.layout === 'narrow') ui.setUI({ view: 'above' }); } } });
  const satNote = h('p', { class: 'note' });
  const satBox = h('div', { class: 'auto-box' }, h('h4', { class: 'sub-title', text: 'Satellites' }), satNote, satBtn);
  autoSec.append(autoPointer, satBox);
  views.federation.append(h('div', { class: 'row-between balance' }, h('span', null, h('i', { class: 'ico ico-kinship' }), ' ', kinBal, ' kinship')),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Federation' }), fedList.list, FED_ORDER.length ? null : note('Federation data not loaded yet.')),
    autoSec);

  // ------------------------------------------------------------------ Edicts
  const edictCur = h('div', { class: 'alert alert-tool' });
  const edictList = h('ul', { class: 'plain-list' });
  views.edicts.append(edictCur, h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Royal Edicts' }),
    h('p', { class: 'note', text: 'Chosen at each merge; active for the whole cycle.' }), edictList));
  for (const id of Object.keys(obj(EDICTS)).length ? Object.keys(EDICTS) : ['edict_of_plenty', 'edict_of_war', 'edict_of_depth', 'edict_of_long_summer']) {
    edictList.appendChild(h('li', { dataset: { id } }, h('strong', { text: nameOf('edict', id) }), ' — ', EDICT_TIPS[id] || ''));
  }

  // ------------------------------------------------------------------ Speciation
  const specList = checklist([
    { id: 'megacolony', label: 'Megacolony (Federation) owned' },
    { id: 'front', label: 'All three Argentine Front nests conquered this run' },
    { id: 'kinship', label: 'Kinship this era ≥ ' + fmtCount(num(SPEC.kinshipMin, 200)) },
  ]);
  const genesProj = h('span', { class: 'big-num' });
  const specBtn = h('button', { type: 'button', class: 'btn btn-primary btn-big', text: 'Speciate', on: { click: () => dlg('speciation') } });
  views.speciation.append(h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Speciation' }),
    h('p', { class: 'note', text: 'Your lineage becomes a new species. Earn genes.' }), specList.el, h('p', null, 'Projected: ', genesProj, ' genes'), specBtn));

  // ------------------------------------------------------------------ Genome (+ auto-supercolony, chronobiology)
  const genesBal = h('span', { class: 'big-num' });
  const genomeList = buyList('genome', () => GENOME_BUYABLE, GENOME_TIPS, genomeCost, 'buyGenome', genomeLevel, (id) => num(GENOME[id] && GENOME[id].max, 0));
  // F17: the season length applies at once (the position in the year is kept); the starting season is stored and
  // applies from the next landing or merge, so Apply can never skip a winter. 'none' = let the clock run on.
  let chronoStart = 'none';
  let chronoSynced = false; // slider and season start at the stored values once (panel build), then belong to the player
  const chronoLen = sliderRow('Season length', { min: num(YEAR.chronoMin, 180), max: num(YEAR.chronoMax, 720), step: 30 }, () => {});
  chronoLen.set(num(YEAR.lengthSec, 360), { fmt: (v) => fmtTime(v) });
  const chronoSeg = h('div', { class: 'seg seg-small', role: 'radiogroup', attrs: { 'aria-label': 'Starting season' } });
  const pickChrono = (id) => {
    chronoStart = id;
    for (const b of Array.from(chronoSeg.children)) toggleClass(b, 'selected', b.dataset.id === id);
  };
  for (const id of ['none', ...SEASONS]) {
    chronoSeg.appendChild(h('button', { type: 'button', class: 'seg-btn' + (id === chronoStart ? ' selected' : ''), dataset: { id },
      text: id === 'none' ? 'Any' : SEASON_NAMES[id], on: { click: () => pickChrono(id) } }));
  }
  const chronoNote = h('p', { class: 'note', text: 'Season length changes now. The starting season applies from your next landing.' });
  const chronoApply = h('button', { type: 'button', class: 'btn btn-small', text: 'Apply',
    on: { click: (ev) => act('setChronobiology', { lengthSec: Number(chronoLen.input.value), start: chronoStart === 'none' ? null : chronoStart }, ev, chronoApply) } });
  const chronoBox = h('div', { class: 'auto-box' }, h('h4', { class: 'sub-title', text: 'Chronobiology' }), chronoLen.el,
    h('span', { class: 'field-label', text: 'Starting season' }), chronoSeg, chronoNote, chronoApply);
  views.genome.append(h('div', { class: 'row-between balance' }, h('span', null, h('i', { class: 'ico ico-genes' }), ' ', genesBal, ' genes')),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Genome' }), genomeList.list, GENOME_ORDER.length ? null : note('Genome data not loaded yet.')),
    chronoBox);

  // ------------------------------------------------------------------ Species
  const speciesList = h('div', { class: 'list' });
  views.species.append(h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Species' }),
    h('p', { class: 'note', text: 'Chosen at each Speciation. Signature genes are permanent.' }), speciesList));

  // ------------------------------------------------------------------ small widgets
  function renderHeirlooms(s) {
    const owned = TRAIT_ORDER.filter((id) => traitLevel(s, id) > 0);
    const cur = arr(s.era && s.era.heirlooms);
    const sig = owned.join(',') + '|' + cur.join(',');
    if (heirBox.__sig === sig) return;
    heirBox.__sig = sig;
    clear(heirBox);
    if (!owned.length) {
      heirBox.appendChild(note('Buy Bloodline traits first.'));
      return;
    }
    for (const id of owned) {
      const input = h('input', { type: 'checkbox', class: 'check', checked: cur.includes(id) });
      input.addEventListener('change', (ev) => {
        const next = new Set(arr(game.s.era.heirlooms));
        if (input.checked) next.add(id); else next.delete(id);
        const ids = Array.from(next);
        const res = act('setHeirlooms', { ids }, ev, input);
        if (!res.ok) input.checked = !input.checked;
      });
      heirBox.appendChild(h('label', { class: 'toggle-row' }, input, h('span', { text: nameOf('trait', id) + ' L' + fmtCount(traitLevel(s, id)) })));
    }
  }

  function createHardRow(id) {
    const tier = h('span', { class: 'lvl' });
    const next = h('span', { class: 'buy-desc' });
    const tip = HARDSHIP_TIPS[id] || { rule: '', reward: '' };
    const btn = h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Begin…', on: { click: () => dlg('hardship', id) } });
    const row = h('div', { class: 'buy-row hardship-row', dataset: { id } },
      h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('hardship', id) }), tier,
        h('span', { class: 'buy-desc', text: tip.rule }), h('span', { class: 'buy-desc good', text: 'Reward: ' + tip.reward }), next),
      h('div', { class: 'buy-side' }, btn));
    row.__r = { tier, next, btn };
    return row;
  }

  function updateHardRow(row, id, s, d) {
    const r = row.__r;
    const t = num(obj(s.cycle && s.cycle.hardshipTier)[id]);
    const best = num(obj(s.era && s.era.hardshipBest)[id]);
    const eff = q(() => effectiveTier(s, id), Math.max(t, best * num(HARDSHIP.carry, 0.5)));
    const tiers = num(HARDSHIP.tiers, 5);
    setText(r.tier, 'Tier ' + fmtCount(t) + ' / ' + tiers + (eff > t ? ' (effective ' + fmt(eff) + ')' : ''));
    const g = t < tiers ? q(() => hardshipGoal(t + 1), num(HARDSHIP.goalBase, 1e9) * num(HARDSHIP.goalGrowth, 100) ** t) : null;
    setText(r.next, g ? 'Next tier: earn ' + fmt(g) + ' food in a Hardship run.' : 'All tiers complete.');
    const active = s.run.hardship === id;
    toggleClass(row, 'active', active);
    const ready = !!(d && d.meta && d.meta.proj && d.meta.proj.fly && d.meta.proj.fly.ok);
    setProp(r.btn, 'disabled', !ready);
    r.btn.title = ready ? '' : 'Needs every Nuptial Flight requirement.';
  }

  function createSpeciesRow(id) {
    const status = h('span', { class: 'badge' });
    const sig = h('span', { class: 'buy-desc' });
    const sci = SPECIES[id] && SPECIES[id].sci ? h('em', { class: 'buy-desc', text: SPECIES[id].sci }) : null;
    const row = h('div', { class: 'buy-row' }, h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('species', id) }), sci,
      h('span', { class: 'buy-desc', text: SPECIES_TIPS[id] || '' }), sig), h('div', { class: 'buy-side' }, status));
    row.__r = { status, sig };
    return row;
  }

  function updateSpeciesRow(row, id, s) {
    const r = row.__r;
    const unlocked = !!obj(s.meta.speciesUnlocked)[id];
    const current = s.era.species === id;
    setText(r.status, current ? 'Current' : unlocked ? 'Unlocked' : 'Locked');
    toggleClass(r.status, 'badge-good', current);
    toggleClass(row, 'locked', !unlocked);
    const sigId = SPECIES[id] && SPECIES[id].sig;
    const has = sigId ? !!obj(s.meta.signatureGenes)[sigId] : false;
    setText(r.sig, sigId ? 'Signature: ' + nameOf('genome', sigId) + (has ? ' (earned)' : '') : '');
  }

  // ------------------------------------------------------------------ update
  return {
    update(s, d) {
      if (!s || !s.run) return;
      const { visible, greyed } = subTabState(s);
      let sub = ui.getUI().subTab;
      if (!SUBS.includes(sub) || !visible[sub]) sub = 'flight';
      subs.update(sub, visible, greyed);
      for (const id of SUBS) show(views[id], id === sub);
      const proj = obj(d && d.meta && d.meta.proj);
      const meta = obj(d && d.meta);

      if (sub === 'flight') {
        const fly = obj(proj.fly);
        const royalL = num(d && d.nest && d.nest.agg && d.nest.agg.royalL, 1);
        flyList.update(fly, {
          royal5: 'Royal Chamber level ' + num(FLIGHT.royalLevel, 5) + ' (now L' + fmtCount(royalL) + ')',
          fRun: 'Food earned this run ≥ ' + fmt(num(FLIGHT.fRunMin, 1e8)) + ' (now ' + fmt(num(s.run.fRun)) + ')',
        });
        // alate rearing (C116)
        const rearing = isShown(s, 'alate_rearing');
        show(alateSec, rearing);
        if (rearing) {
          const c = obj(s.run.colony);
          const bs = q(() => broodSummary(s, d), null) || {};
          const alBrood = num(obj(bs.byCaste).alate);
          setText(alateCount, fmtCount(num(c.alatesReared)) + ' / ' + fmtCount(num(obj(d && d.stats).alateCells))
            + (alBrood > 0 ? ' (+' + fmtCount(alBrood) + ' growing)' : '')
            + (num(c.rearRequested) > 0 ? ' · ' + fmtCount(c.rearRequested) + ' queued' : ''));
          setCost(alateCost, q(() => eggCost(s, d, 'alate'), null), s);
          setProp(autoRear, 'checked', !!(s.meta.automation && s.meta.automation.autoRear));
        }
        const alates = num(proj.alates, q(() => projectAlates(s, d), 0));
        setText(projEl, fmtCount(alates));
        const perMin = num(proj.perMin);
        setText(perMinEl, '+' + fmt(perMin) + ' alates/min');
        const peak = num(s.run.prestige && s.run.prestige.peakRate);
        meter.set(peak > 0 ? perMin / peak : 0, peak > 0 ? 'Peak ' + fmt(peak) + '/min' : '');
        const pastPeak = peak > 0 && perMin < num(FLIGHT.peakGlow, 0.97) * peak && alates > 0;
        // "A good time to fly" only when the checklist is complete; before that the note is information only.
        const glow = pastPeak && !!fly.ok;
        toggleClass(meter.el, 'glow', glow);
        show(peakNote, pastPeak);
        if (pastPeak) {
          setText(peakNote, 'Peak reached ' + fmtTime(Math.max(0, num(s.run.time) - num(s.run.prestige.peakAt))) + ' ago'
            + (fly.ok ? ': a good time to fly.' : '.'));
        }
        const ft = q(() => flightTerms(s, d), null);
        const reared = ft ? ft.reared : num(s.run.colony && s.run.colony.alatesReared);
        setText(kvRear, fmtCount(reared) + ' (' + fmtPct(reared * num(FLIGHT.rearedPer, 0.02)) + ')');
        if (ft) setText(rearRule, rearedRuleText(ft.rearedMax));
        const w = ft ? ft.W : num(d && d.season && d.season.mods && d.season.mods.flightW, 1);
        setText(kvWeather, fmtMult(w) + (w > 1 ? ' (flight weather!)' : ''));
        const rows = q(() => flightFactorRows(s, d), []);
        syncList(factorList, rows, (r) => r.id, (r) => {
          const label = h('span', { class: 'ff-label' });
          const how = h('span', { class: 'ff-how' });
          const val = h('span', { class: 'ff-val' });
          const mult = h('span', { class: 'ff-mult' });
          const row = h('div', { class: 'ff-row', dataset: { id: r.id } }, h('div', { class: 'ff-main' }, label, how), h('div', { class: 'ff-side' }, val, mult));
          row.__r = { label, how, val, mult };
          return row;
        }, (row, r) => {
          setText(row.__r.label, r.label);
          setText(row.__r.how, r.how);
          setText(row.__r.val, r.value);
          setText(row.__r.mult, r.mult);
        });
        setText(kvLineage, fmtMult(num(meta.lineage, 1)) + ' food');
        setText(kvAlates, fmtCount(num(s.cycle.alates)));
        const shown = isShown(s, 'flight_button') || !!fly.ok;
        show(flyBtn, shown);
        setProp(flyBtn, 'disabled', !fly.ok);
        toggleClass(flyBtn, 'glow', !!fly.ok && glow);
        setText(flyHint, fly.ok ? '' : 'Complete the checklist to fly. Flights are never blocked by season.');
        afBox.update(s, d);
        const nHist = historyCount(s);
        show(histSec, nHist > 0);
        if (nHist > 0) setText(histNote, 'The nests of your last ' + fmtCount(nHist) + (nHist === 1 ? ' run' : ' runs') + ', kept as a gallery.');
      } else if (sub === 'bloodline') {
        setText(alatesBal, fmtCount(num(s.cycle.alates)));
        setText(alatesMeta, fmtCount(num(s.cycle.alatesCycle)) + ' this cycle · Lineage ' + fmtMult(num(meta.lineage, 1)));
        traitList.update(s, false);
        const heirOn = fedLevel(s, 'heirloom_bloodline') > 0;
        show(heirSec, heirOn);
        if (heirOn) renderHeirlooms(s);
      } else if (sub === 'hardships') {
        show(activeHard, !!s.run.hardship);
        if (s.run.hardship) setText(activeHard, 'Active Hardship: ' + nameOf('hardship', s.run.hardship) + ' · food this run ' + fmt(num(s.run.fRun)));
        const ids = Object.keys(obj(HARDSHIPS)).length ? Object.keys(HARDSHIPS) : HARDSHIP_FALLBACK;
        syncList(hardList, ids, (id) => id, createHardRow, (row, id) => updateHardRow(row, id, s, d));
      } else if (sub === 'supercolony') {
        const sc = obj(proj.superc);
        // F19: name the Old Ridge's appearance condition until it is on the map (Budding + alates this cycle).
        const ridgeUp = arr(s.run.rivals && s.run.rivals.list).some((r) => r && r.type === 'old_ridge_supercolony');
        superList.update(sc, {
          alates: 'Alates this cycle ≥ ' + fmtCount(num(SUPER.alatesMin, 5000)) + ' (now ' + fmtCount(num(s.cycle.alatesCycle)) + ')',
          oldRidge: 'The Old Ridge Supercolony conquered this run' + (sc.oldRidge || ridgeUp ? '' : ' (it appears ' + oldRidgeHint() + ')'),
        });
        setText(kinProj, fmtCount(num(proj.kinship, q(() => projectKinship(s, d), 0))));
        const kb = q(() => kinshipBreakdown(s, d), null);
        setText(kinNote, kb ? 'Counts ' + fmtCount(kb.banked) + ' alates from this cycle\'s flights + ' + fmtCount(kb.run)
          + " from this run (as if it flew)." + (kb.nextAt ? ' Next kinship at ' + fmtCount(kb.nextAt) + ' alates.' : '') : '');
        syncList(kinFactors, kb ? kinshipRows(kb) : [], (r) => r.id, (r) => {
          const label = h('span', { class: 'ff-label' });
          const how = h('span', { class: 'ff-how' });
          const val = h('span', { class: 'ff-val' });
          const mult = h('span', { class: 'ff-mult' });
          const row = h('div', { class: 'ff-row', dataset: { id: r.id } }, h('div', { class: 'ff-main' }, label, how), h('div', { class: 'ff-side' }, val, mult));
          row.__r = { label, how, val, mult };
          return row;
        }, (row, r) => {
          setText(row.__r.label, r.label);
          setText(row.__r.how, r.how);
          setText(row.__r.val, r.value);
          setText(row.__r.mult, r.mult);
        });
        asBox.update(s, d);
        setText(daughtersEl, fmtCount(arr(s.cycle.daughters).length) + ' daughter colonies founded this cycle.');
        setProp(mergeBtn, 'disabled', !sc.ok);
      } else if (sub === 'federation') {
        const g = greyed.federation;
        show(teaserNote.federation, g);
        if (g) setText(teaserNote.federation, 'Preview: ' + unlockHint('tab_federation'));
        setText(kinBal, fmtCount(num(s.era.kinship)));
        fedList.update(s, g);
        const anyAuto = ['automated_brood', 'autobuyers', 'auto_flight'].some((id) => fedLevel(s, id) > 0) || genomeLevel(s, 'deep_time_automation') > 0;
        show(autoPointer, anyAuto);
        const satL = fedLevel(s, 'satellite_nest');
        const satN = arr(s.run.surface && s.run.surface.entrances).filter((e) => e && e.kind === 'satellite').length;
        show(satBox, satL > 0 && !g);
        setText(satNote, fmtCount(satN) + ' of ' + fmtCount(satL) + ' satellites placed.');
        show(satBtn, satL > satN);
        show(autoSec, !g && (anyAuto || satL > 0));
      } else if (sub === 'edicts') {
        setText(edictCur, s.cycle.edict ? 'Active: ' + nameOf('edict', s.cycle.edict) + ' — ' + (EDICT_TIPS[s.cycle.edict] || '') : 'No edict active this cycle.');
        for (const li of Array.from(edictList.children)) toggleClass(li, 'active', li.dataset.id === s.cycle.edict);
      } else if (sub === 'speciation') {
        const sp = obj(proj.spec);
        specList.update(sp, { kinship: 'Kinship this era ≥ ' + fmtCount(num(SPEC.kinshipMin, 200)) + ' (now ' + fmtCount(num(s.era.kinshipLife)) + ')' });
        setText(genesProj, fmtCount(num(proj.genes, q(() => projectGenes(s, d), 0))));
        setProp(specBtn, 'disabled', !sp.ok);
      } else if (sub === 'genome') {
        const g = greyed.genome;
        show(teaserNote.genome, g);
        if (g) setText(teaserNote.genome, 'Preview: ' + unlockHint('tab_genome'));
        setText(genesBal, fmtCount(num(s.meta.genes)));
        genomeList.update(s, g);
        const chronoOn = genomeLevel(s, 'chronobiology') > 0 && !g;
        show(chronoBox, chronoOn);
        if (chronoOn && !chronoSynced) {
          chronoSynced = true;
          chronoLen.set(num(s.meta.season && s.meta.season.lengthSec, num(YEAR.lengthSec, 360)), { fmt: (v) => fmtTime(v) });
          const st = s.meta.season && s.meta.season.start;
          pickChrono(SEASONS.includes(st) ? st : 'none');
        }
      } else if (sub === 'species') {
        const g = greyed.species;
        show(teaserNote.species, g);
        if (g) setText(teaserNote.species, 'Preview: ' + unlockHint('tab_genome'));
        const ids = SPECIES_ORDER.length ? SPECIES_ORDER : SPECIES_FALLBACK;
        syncList(speciesList, ids, (id) => id, createSpeciesRow, (row, id) => updateSpeciesRow(row, id, s));
      }
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
