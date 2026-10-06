// Stats panel: run and lifetime statistics (largest battle, deepest tunnel, longest trail, fastest flight …) and the
// layers reached. Owner: WP9. Contract: ARCHITECTURE §14.5 (Stats row: state only); DESIGN §25.3, §25.8.
// ARCH-R: DESIGN §25.3 lists "per-layer timings", but the state schema (§4) records no per-layer timestamps; the panel
// shows which layers have been reached (from meta.stats.deepestRow) instead.

import { h, setText, clear, show, toggleClass } from '../dom.js';
import { fmt, fmtCount, fmtTime, fmtRate } from '../format.js';
import { nameOf, RES_NAMES } from '../text.js';
import { num, arr, obj, isShown } from '../reveal.js';
import { RAIL_RES } from '../hud.js';
import { activeTracker, STAT_RES, STATS_WINDOW_SEC } from '../resourceStats.js';
import { adultsTotal } from '../../core/state.js';
import { LAYER_ORDER, LAYERS } from '../../data/strata.js';
import { diapauseInfo } from '../hud.js';

const LAYER_FALLBACK = [['topsoil', 0], ['loam', 10], ['clay', 24], ['gravel', 40], ['bedrock', 58], ['aquifer', 74]];

/**
 * Layer of a nest row.
 * @param {number} row
 * @returns {string}
 */
export function layerOfRow(row) {
  const list = LAYER_ORDER.length ? LAYER_ORDER.map((id) => [id, num(LAYERS[id] && LAYERS[id].y0)]) : LAYER_FALLBACK;
  let cur = list[0][0];
  for (const [id, y0] of list) if (row >= y0) cur = id;
  return cur;
}

/** Wall-clock date text for a ms timestamp (UI only). */
function dateText(ms) {
  if (!(ms > 0)) return '—';
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return '—';
  }
}

/**
 * Rows: [label, (s) => text]. Grouped by section title.
 */
const SECTIONS = [
  ['This run', [
    ['Run', (s) => '#' + fmtCount(num(s.run.index) + 1)],
    ['Run time', (s) => fmtTime(num(s.run.time))],
    ['Adults now / peak', (s) => fmtCount(safeAdults(s)) + ' / ' + fmtCount(num(s.run.stats.maxAdults))],
    ['Eggs laid', (s) => fmtCount(num(s.run.stats.eggs))],
    ['Ants hatched', (s) => fmtCount(num(s.run.stats.hatched))],
    ['Soldiers raised', (s) => fmtCount(num(s.run.stats.soldiersRaised))],
    ['Food earned', (s) => fmt(num(s.run.fRun))],
    ['Food lost to full storage', (s) => fmt(num(s.run.stats.foodWasted))],
    ['Cells dug', (s) => fmtCount(num(s.run.stats.cellsDug))],
    ['Chambers completed', (s) => fmtCount(num(s.run.stats.chambersDone))],
    ['Deepest row', (s) => fmtCount(num(s.run.nest.deepestRow)) + ' (' + nameOf('layer', layerOfRow(num(s.run.nest.deepestRow))) + ')'],
    ['Territory peak', (s) => fmtCount(num(s.run.tPeak)) + ' hexes'],
    ['Sources depleted', (s) => fmtCount(num(s.run.stats.sourcesDepleted))],
    ['Battles won / fought', (s) => fmtCount(num(s.run.stats.battlesWon)) + ' / ' + fmtCount(num(s.run.stats.battles))],
    ['Conquests', (s) => fmtCount(num(s.run.stats.conquests))],
    ['Enemies defeated', (s) => fmtCount(num(s.run.stats.kills))],
    ['Raids against you', (s) => fmtCount(num(s.run.stats.raidsIncoming))],
    ['Events seen', (s) => fmtCount(num(s.run.stats.eventsSeen))],
    ['Landing site', (s) => (arr(s.run.landingTags).length ? arr(s.run.landingTags).map((t) => nameOf('site', t)).join(', ') : '—')
      + (s.run.boon ? ' · ' + nameOf('boon', s.run.boon) : '')],
    ['Hardship', (s) => (s.run.hardship ? nameOf('hardship', s.run.hardship) : 'None')],
    ['Species', (s) => nameOf('species', s.era.species)],
  ]],
  // C112: what Diapause does, its bank, drain and how it is earned (toggled from the rail's Diapause row)
  ['Diapause', [
    ['Bank', (s, d) => { const x = diapauseInfo(s, d); return fmtTime(x.bank) + ' of ' + fmtTime(x.bankMax) + ' max'; }],
    ['Status', (s, d) => { const x = diapauseInfo(s, d); return x.running ? 'Running at ' + x.speed + '× · ends in ' + fmtTime(x.endsIn) : x.bank > 0 ? 'Paused (Spend from the resource rail)' : 'Empty'; }],
    ['Effect', (s, d) => { const x = diapauseInfo(s, d); return x.speed + '× economy: income and upkeep, source depletion, laying, brood growth, digging. Seasons, events, raids, rivals and battles stay real-time.'; }],
    ['Cost', (s, d) => { const x = diapauseInfo(s, d); return x.drain + ' s of bank per real second' + (x.mastery ? ' (Diapause Mastery)' : ' (3× with Diapause Mastery)'); }],
    ['Earned', (s, d) => { const x = diapauseInfo(s, d); return Math.round(x.bankRate * 100) + '% of offline time beyond the ' + fmtTime(x.capSec) + ' offline cap'; }],
  ]],
  ['Lifetime', [
    ['Time played', (s) => fmtTime(num(s.meta.simTime))],
    ['Colony founded', (s) => dateText(num(s.meta.createdAt))],
    ['Runs', (s) => fmtCount(num(s.meta.counters.runs))],
    ['Nuptial Flights', (s) => fmtCount(num(s.meta.counters.flights))],
    ['Supercolonies', (s) => fmtCount(num(s.meta.counters.supercolonies))],
    ['Speciations', (s) => fmtCount(num(s.meta.counters.speciations))],
    ['Alates earned', (s) => fmtCount(num(s.meta.counters.alatesLife))],
    ['Kinship earned', (s) => fmtCount(num(s.meta.counters.kinshipEver))],
    ['Genes earned', (s) => fmtCount(num(s.meta.genesLife))],
    ['Food ever', (s) => fmt(num(s.meta.stats.foodEver))],
    ['Clicks', (s) => fmtCount(num(s.meta.counters.clicks))],
    ['Queen visits', (s) => fmtCount(num(s.meta.counters.queenClicks))],
    ['Cells dug', (s) => fmtCount(num(s.meta.counters.cellsDug))],
    ['Caches found', (s) => fmtCount(num(s.meta.counters.caches))],
    ['Amber beads', (s) => fmtCount(num(s.meta.counters.amber))],
    ['Chambers relocated', (s) => fmtCount(num(s.meta.counters.relocations))],
    ['Deepest tunnel', (s) => 'Row ' + fmtCount(num(s.meta.stats.deepestRow)) + ' (' + nameOf('layer', layerOfRow(num(s.meta.stats.deepestRow))) + ')'],
    ['Longest trail', (s) => fmtCount(num(s.meta.stats.longestTrail)) + ' hexes'],
    ['Largest battle', (s) => fmtCount(num(s.meta.stats.largestBattle)) + ' ants'],
    ['Fastest flight', (s) => (num(s.meta.stats.fastestFlightSec) > 0 ? fmtTime(s.meta.stats.fastestFlightSec) : '—')],
    ['First flight', (s) => (num(s.meta.stats.firstFlightAt) > 0 ? 'after ' + fmtTime(s.meta.stats.firstFlightAt) : '—')],
    ['First Supercolony', (s) => (num(s.meta.stats.firstSuperAt) > 0 ? 'after ' + fmtTime(s.meta.stats.firstSuperAt) : '—')],
    ['First Speciation', (s) => (num(s.meta.stats.firstSpecAt) > 0 ? 'after ' + fmtTime(s.meta.stats.firstSpecAt) : '—')],
    ['Battles won', (s) => fmtCount(num(s.meta.counters.battlesWon))],
    ['Conquests', (s) => fmtCount(num(s.meta.counters.conquests))],
    ['Tournaments won', (s) => fmtCount(num(s.meta.counters.tournamentsWon))],
    ['Golden Beetles', (s) => fmtCount(num(s.meta.counters.beetles))],
    ['Mold scraped', (s) => fmtCount(num(s.meta.counters.moldScraped))],
    ['Ladybugs shooed', (s) => fmtCount(num(s.meta.counters.ladybugs))],
    ['Rainstorms', (s) => fmtCount(num(s.meta.counters.rainstorms))],
    ['Mole tunnels', (s) => fmtCount(num(s.meta.counters.moleTunnels))],
    ['Events', (s) => fmtCount(num(s.meta.counters.events))],
    ['Achievements', (s) => fmtCount(Object.keys(obj(s.meta.achievements)).length)],
    ['Field Guide entries', (s) => fmtCount(Object.keys(obj(s.meta.fieldGuide)).length)],
    ['Strata fossils', (s) => fmtCount(arr(s.meta.strata).length)],
    ['Number guards tripped', (s) => fmtCount(num(s.meta.stats.nanGuards))],
  ]],
];

/** adultsTotal with a defensive fallback. */
function safeAdults(s) {
  try {
    return adultsTotal(s);
  } catch {
    return 0;
  }
}

/**
 * Stats panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createPanel(root, ctx = {}) {
  const el = h('div', { class: 'panel panel-stats' });
  root.appendChild(el);
  // C191: per-resource income and spending over the last 60 s (one resource at a time, picked by chip)
  let flowRes = 'food';
  const flowChips = h('div', { class: 'flow-chips', role: 'group', attrs: { 'aria-label': 'Resource' } });
  const chipEls = {};
  for (const res of STAT_RES) {
    const b = h('button', { type: 'button', class: 'chip flow-chip', dataset: { res }, attrs: { 'aria-pressed': 'false' },
      on: { click: () => { flowRes = res; last = null; if (ctx.game) update(ctx.game.s, ctx.game.d); } } },
    h('i', { class: 'ico ico-' + res, attrs: { 'aria-hidden': 'true' } }), h('span', { text: RES_NAMES[res] || res }));
    chipEls[res] = b;
    flowChips.appendChild(b);
  }
  const flowSum = h('p', { class: 'flow-sum' });
  const inList = h('ol', { class: 'flow-list flow-in' });
  const outList = h('ol', { class: 'flow-list flow-out' });
  const flowNote = h('p', { class: 'note flow-note' });
  el.appendChild(h('section', { class: 'sec res-flows' }, h('h3', { class: 'sec-title', text: 'Resources · last ' + STATS_WINDOW_SEC + ' s' }), flowChips, flowSum,
    h('div', { class: 'flow-cols' },
      h('div', { class: 'flow-col' }, h('h4', { class: 'flow-h', text: 'Where it came from' }), inList),
      h('div', { class: 'flow-col' }, h('h4', { class: 'flow-h', text: 'What used it' }), outList)),
    flowNote));
  // C190: the event log
  el.appendChild(h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Event log' }),
    h('p', { class: 'note', text: 'Events and their outcomes, raids, blueprints, milestones and prestige, with their run time.' }),
    h('button', { type: 'button', class: 'btn btn-small', text: 'Open event log', on: { click: () => { if (ctx.dialogs && ctx.dialogs.eventLog) ctx.dialogs.eventLog(); } } })));
  let last = null;
  function flowRows(list, items, max, sign) {
    clear(list);
    if (!items.length) { list.appendChild(h('li', { class: 'flow-row flow-none', text: 'Nothing' })); return; }
    for (const x of items) {
      const bar = h('span', { class: 'flow-bar-fill' });
      bar.style.width = Math.max(2, Math.round((x.rate / max) * 100)) + '%';
      list.appendChild(h('li', { class: 'flow-row' }, h('span', { class: 'flow-label', text: x.label }),
        h('span', { class: 'flow-val', text: sign + fmtRate(x.rate) }), h('span', { class: 'flow-bar' }, bar)));
    }
  }
  function updateFlows(s, d) {
    const vis = (res) => {
      if (res === 'leaves') return isShown(s, 'fungus_widget');
      const def = RAIL_RES.find((x) => x.res === res);
      return def ? isShown(s, def.key) : false;
    };
    for (const res of STAT_RES) show(chipEls[res], vis(res));
    if (!vis(flowRes)) flowRes = 'food';
    for (const res of STAT_RES) {
      toggleClass(chipEls[res], 'active', res === flowRes);
      chipEls[res].setAttribute('aria-pressed', res === flowRes ? 'true' : 'false');
    }
    const tr = activeTracker();
    if (!tr) { setText(flowSum, 'Statistics start when the game is running.'); return; }
    const b = tr.breakdown(s, d, flowRes);
    const max = Math.max(1e-9, ...b.inflow.map((x) => x.rate), ...b.outflow.map((x) => x.rate));
    const sig = flowRes + '|' + b.inflow.map((x) => x.key + fmtRate(x.rate)).join(',') + '|' + b.outflow.map((x) => x.key + fmtRate(x.rate)).join(',');
    setText(flowSum, 'In ' + fmtRate(b.totalIn) + ' · out ' + fmtRate(b.totalOut) + ' · net ' + (b.net >= 0 ? '+' : '') + fmtRate(b.net));
    toggleClass(flowSum, 'neg', b.net < -1e-9);
    setText(flowNote, 'Averaged over the last ' + fmtTime(Math.round(Math.min(STATS_WINDOW_SEC, b.sec))) + ' of this run. One-off amounts (clicks, events, purchases) are spread over the window.');
    if (sig === last) return;
    last = sig;
    flowRows(inList, b.inflow, max, '+');
    flowRows(outList, b.outflow, max, '−');
  }
  const cells = [];
  for (const [title, rows] of SECTIONS) {
    const dl = h('dl', { class: 'kv kv-stats' });
    for (const [label, fn] of rows) {
      const dd = h('dd');
      dl.append(h('dt', { text: label }), dd);
      cells.push([dd, fn]);
    }
    el.appendChild(h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: title }), dl));
  }
  const layerList = h('ul', { class: 'layer-list' });
  el.appendChild(h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Layers reached' }), layerList));
  const layerItems = [];
  const layers = LAYER_ORDER.length ? LAYER_ORDER.map((id) => [id, num(LAYERS[id] && LAYERS[id].y0)]) : LAYER_FALLBACK;
  for (const [id, y0] of layers) {
    const li = h('li', { dataset: { id } }, h('span', { class: 'layer-swatch layer-' + id }), h('span', { text: nameOf('layer', id) + ' (row ' + y0 + ')' }));
    layerItems.push([li, y0]);
    layerList.appendChild(li);
  }

  function update(s, d) {
    if (!s || !s.run || !s.meta) return;
    try { updateFlows(s, d); } catch (err) { setText(flowSum, '—'); }
    for (const [dd, fn] of cells) {
      let t;
      try { t = fn(s, d); } catch { t = '—'; }
      setText(dd, t);
    }
    const deepest = num(s.meta.stats && s.meta.stats.deepestRow);
    for (const [li, y0] of layerItems) {
      const reached = deepest >= y0;
      if (li.classList.contains('reached') !== reached) li.classList.toggle('reached', reached);
    }
  }

  return {
    update,
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
