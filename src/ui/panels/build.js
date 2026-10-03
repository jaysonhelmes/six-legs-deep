// Build panel: chamber list (locked items greyed with their unlock condition), dig-queue chips (reorder, cancel,
// work, ETA), Help Dig, tools (backfill), the Mound, the inspect view of the selected chamber (level up with direction,
// relocate, demolish, modifiers) and blueprints. Owner: WP9. Contract: ARCHITECTURE §14.5 (Build row), §8.2, §13.7.
// Queries: nest.placementCost, nest.levelInfo, d.nest.queueInfo, surface.moundCost.

import { h, setText, setProp, show, toggleClass, syncList, setCost } from '../dom.js';
import { fmt, fmtCount, fmtTime, fmtMult, fmtRate } from '../format.js';
import { nameOf, CHAMBER_TIPS, DIG_KIND_NAMES, unlockHint, reasonText, placementRuleLines } from '../text.js';
import { isShown, hasResearch, traitLevel, fedLevel, num, arr, obj } from '../reveal.js';
import { placementCost, levelInfo, placementRows } from '../../systems/nest.js';
import { moundCost } from '../../systems/surface.js';
import { CHAMBER_ORDER, CHAMBERS } from '../../data/chambers.js';
import { DIG } from '../../data/strata.js';
import { MOUND } from '../../data/surface.js';
import { RESEARCH } from '../../data/research.js';
import { TRAITS } from '../../data/bloodline.js';
import { FEDERATION } from '../../data/federation.js';
import { FLIGHT } from '../../data/prestige.js';
import { makeAct, note, progressBar, armedButton, subTabStrip } from './common.js';

/** Chamber ids when data/chambers.js is still empty (DESIGN §7.6 order). */
export const CHAMBER_FALLBACK = Object.freeze(['royal_chamber', 'gallery', 'nursery', 'granary', 'scent_library', 'midden', 'barracks',
  'root_aphid_pen', 'fungus_garden', 'repletion_hall', 'hibernaculum', 'thermal_chimney', 'gate', 'water_well', 'nuptial_chamber', 'deep_vault']);
/** Default instance limits when data is missing (DESIGN §7.6). */
const MAX_INST_FALLBACK = Object.freeze({ royal_chamber: 1, gallery: 4, nursery: 3, granary: 3, scent_library: 2, midden: 2, barracks: 2,
  root_aphid_pen: 2, fungus_garden: 3, repletion_hall: 2, hibernaculum: 2, thermal_chimney: 1, gate: 1, water_well: 'perPocket',
  nuptial_chamber: 1, deep_vault: 1 });
const DIRS = ['left', 'right', 'up', 'down'];
const DIR_LABELS = { left: '← Left', right: 'Right →', up: '↑ Up', down: '↓ Down' };
const STATUS_NAMES = { digging: 'Digging', active: 'Active', growing: 'Enlarging', relocating: 'Relocating' };

/** Chamber ids in display order. */
function chamberIds() {
  return CHAMBER_ORDER.length ? CHAMBER_ORDER : CHAMBER_FALLBACK;
}

/**
 * Inspect-panel line under the level-up cost (C66): MAX, the Royal Chamber growth-room refusal ('blocked:royalRoom'
 * copy when that room is the only thing in the way), a plain "no room" block, directions withheld for the Royal
 * Chamber, or "finish digging".
 * @param {{ max?: boolean, blocked?: boolean, royalRoom?: boolean }} info nest.levelInfo
 * @param {{ status?: string }} ch
 * @returns {string}
 */
export function levelMessage(info, ch) {
  if (!info) return '';
  if (info.max) return 'Maximum level.';
  if (info.blocked && info.royalRoom) return reasonText('blocked:royalRoom', 'levelChamber');
  if (info.blocked) return 'No room to grow: relocate it or clear space around it.';
  if (ch && ch.status !== 'active') return 'Finish digging before the next level.';
  if (info.royalRoom) return 'Some directions are held back so the Royal Chamber keeps room to reach L' + num(FLIGHT && FLIGHT.royalLevel, 5) + '.';
  return '';
}

/**
 * Final QA: a food cost above the food store can never be paid by waiting (a new player sat at a full 450 store
 * looking at a red 625 Gallery). Names the store size and how to raise it; '' when the store can hold the cost.
 * @param {Object|null} cost
 * @param {Object} d
 * @returns {string}
 */
export function overCapHint(cost, d) {
  const need = num(cost && cost.food);
  const cap = num(d && d.stats && d.stats.foodCap);
  if (!(need > 0) || !(cap > 0) || need <= cap) return '';
  return 'Needs ' + fmt(need) + ' food but your store holds ' + fmt(cap) + ': level or place a Granary.';
}

/** Unlock key of a chamber type (data `unlock`, else 'chamber_<id>'; the Royal Chamber has none). */
export function chamberKey(id) {
  const c = CHAMBERS[id];
  if (c && 'unlock' in c) return c.unlock;
  return id === 'royal_chamber' ? null : 'chamber_' + id;
}

/**
 * Instance limit of a chamber type for the current state (maxInst + satisfied instBonus; water wells: revealed
 * pockets).
 * @param {Object} s
 * @param {string} id
 * @returns {number}
 */
export function maxInstances(s, id) {
  const c = CHAMBERS[id];
  const base = c && c.maxInst !== undefined ? c.maxInst : MAX_INST_FALLBACK[id];
  if (base === 'perPocket') return arr(s.run && s.run.nest && s.run.nest.features && s.run.nest.features.water).filter((w) => w && w.revealed).length;
  let n = num(base, 1);
  for (const b of arr(c && c.instBonus)) {
    if (!b) continue;
    if (b.research && hasResearch(s, b.research)) n += num(b.add);
    else if (b.trait && traitLevel(s, b.trait) > 0) n += num(b.add);
    else if (b.federation && fedLevel(s, b.federation) > 0) n += num(b.add);
  }
  if (!c && id === 'royal_chamber') n += (traitLevel(s, 'polygyny') > 0 ? 1 : 0) + (fedLevel(s, 'queens_council') > 0 ? 2 : 0);
  if (!c && id === 'gallery' && hasResearch(s, 'gallery_arches')) n += 2;
  return n;
}

/** fx number of a data entry (table[id].fx[key]) or a fallback while that table is incomplete. */
function fxOf(table, id, key, fallback) {
  const e = table && table[id];
  return num(e && e.fx ? e.fx[key] : NaN, fallback);
}

/** Dig-queue capacity (DESIGN §7.2: 5, +2 load_chains, +2 automaton_instincts; numbers from the data tables). */
export function queueLimit(s) {
  return num(DIG && DIG.queueBase, 5) + (hasResearch(s, 'load_chains') ? fxOf(RESEARCH, 'load_chains', 'queue', 2) : 0)
    + (traitLevel(s, 'automaton_instincts') > 0 ? fxOf(TRAITS, 'automaton_instincts', 'queue', 2) : 0);
}

/**
 * Placement requirements of a chamber type as one line (C99): '' when it can go anywhere below the surface.
 * @param {Object} s
 * @param {Object} d
 * @param {string} id
 * @returns {string}
 */
export function chamberRuleText(s, d, id) {
  const rows = q(() => placementRows(s, d, id), null);
  return placementRuleLines(id, rows).join(' ');
}

/** Safe query. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Build panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createPanel(root, { game, ui, bridge }) {
  const act = makeAct(game, bridge);
  const el = h('div', { class: 'panel panel-build' });
  root.appendChild(el);

  const subs = subTabStrip(['main', 'inspect'], { main: 'Chambers', inspect: 'Inspect' }, (id) => ui.setUI({ subTab: id === 'main' ? null : id }));
  const mainView = h('div');
  const inspectView = h('div');
  el.append(subs.el, mainView, inspectView);

  // --- tool banner ---
  const toolBanner = h('div', { class: 'alert alert-tool' });
  const toolText = h('span');
  toolBanner.append(toolText, h('button', { type: 'button', class: 'btn btn-small', text: 'Cancel (Esc)', on: { click: () => ui.setUI({ tool: null }) } }));

  // --- dig queue ---
  const queueMeta = h('span', { class: 'sec-meta' });
  const digRate = h('span', { class: 'muted' });
  const helpBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Help dig', dataset: { tip: 'Add a burst of work to the first job.' },
    on: { click: (ev) => act('helpDig', {}, ev, helpBtn) } });
  const backfillBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Backfill…', dataset: { tip: 'Fill tunnels back in, free: drag a box over them (key B).' },
    on: { click: () => { const t = ui.getUI().tool; ui.setUI({ tool: t && t.kind === 'backfill' ? null : { kind: 'backfill' } }); switchToNest(); } } });
  const queueList = h('div', { class: 'queue' });
  const queueEmpty = note('Nothing queued. Diggers do maintenance and still yield soil.');
  // Queued work with no dig rate never finishes: say why and where to fix it (a new player can place a Gallery before
  // assigning any Digger).
  const noDiggers = h('div', { class: 'alert alert-warn' },
    h('span', { text: 'No diggers: this work will not progress.' }),
    h('button', { type: 'button', class: 'btn btn-small', text: 'Assign diggers', on: { click: () => bridge.openTab('colony') } }));
  const queueSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title' }, 'Dig queue ', queueMeta),
    h('div', { class: 'row-between' }, digRate, h('span', { class: 'btn-row' }, helpBtn, backfillBtn)), noDiggers, queueList, queueEmpty);

  // --- chambers ---
  const royalRow = h('div', { class: 'buy-row royal-row' });
  const royalLvl = h('span', { class: 'lvl' });
  royalRow.append(h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('chamber', 'royal_chamber') }), royalLvl,
    h('span', { class: 'buy-desc', text: CHAMBER_TIPS.royal_chamber })),
  h('div', { class: 'buy-side' }, h('button', { type: 'button', class: 'btn btn-small', text: 'Inspect',
    on: { click: () => { bridge.select({ view: 'nest', kind: 'chamber', id: 1 }); ui.setUI({ subTab: 'inspect' }); } } })));
  const chamberList = h('div', { class: 'list chamber-list' });
  const chamberSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Chambers' }), royalRow, chamberList);

  // --- mound ---
  const moundLvl = h('span', { class: 'lvl' });
  const moundCostEl = h('span', { class: 'cost' });
  const moundBtn = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Raise',
    on: { click: (ev) => act('buyMound', {}, ev, moundBtn) } });
  const moundNote = h('p', { class: 'note' });
  const moundSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Mound' }),
    h('div', { class: 'buy-row', dataset: { tip: 'Better defence, wider auto-claim, softer winters.' } },
      h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: 'Mound' }), moundLvl,
        h('span', { class: 'buy-desc', text: 'Soil heaped at the entrance: defence, territory, warmth.' })),
      h('div', { class: 'buy-side' }, moundCostEl, moundBtn)), moundNote);

  // --- blueprints ---
  const bpList = h('div', { class: 'list' });
  const bpSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Blueprints' }),
    h('p', { class: 'note', text: 'Saved layouts auto-queue after each flight and dig faster.' }), bpList);

  // camera help for the nest view (render/nestInput.js; the full list is in Settings → Keyboard and view controls)
  const viewHelp = note('Nest view: wheel scrolls, Ctrl + wheel or pinch zooms, the crown button (top-right) frames the queen.');
  viewHelp.classList.add('view-help');
  mainView.append(toolBanner, queueSec, chamberSec, moundSec, bpSec, viewHelp);

  // --- inspect ---
  const inspTitle = h('h3', { class: 'sec-title' });
  const inspStatus = h('span', { class: 'badge' });
  const inspProgress = progressBar('bar-dig');
  const inspKv = h('dl', { class: 'kv' });
  const kv = {};
  for (const [k, label] of [['layer', 'Layer'], ['eff', 'Effect'], ['adj', 'Adjacent'], ['mods', 'Modifiers']]) {
    kv[k] = { dt: h('dt', { text: label }), dd: h('dd') };
    inspKv.append(kv[k].dt, kv[k].dd);
  }
  const lvlCost = h('span', { class: 'cost' });
  const lvlWork = h('span', { class: 'muted' });
  const lvlMsg = h('p', { class: 'note' });
  const dirRow = h('div', { class: 'btn-row dir-row' });
  const dirBtns = {};
  for (const dir of DIRS) {
    const b = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: DIR_LABELS[dir], dataset: { dir },
      on: { click: (ev) => { const uid = selectedUid(); if (uid) act('levelChamber', { uid, dir }, ev, b); } } });
    dirBtns[dir] = b;
    dirRow.appendChild(b);
  }
  const levelBtn = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Level up',
    on: { click: (ev) => { const uid = selectedUid(); if (uid) act('levelChamber', { uid }, ev, levelBtn); } } });
  const pickDirBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Pick edge on map…',
    on: { click: () => { const uid = selectedUid(); if (uid) { ui.setUI({ tool: { kind: 'levelDir', uid } }); switchToNest(); } } } });
  const relocateBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Relocate…',
    on: { click: () => { const uid = selectedUid(); if (uid) { ui.setUI({ tool: { kind: 'relocate', uid } }); switchToNest(); } } } });
  const groomBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Groom brood', dataset: { tip: 'Brood here develops a little faster.' },
    on: { click: (ev) => { const uid = selectedUid(); if (uid) act('groomBrood', { chamber: uid }, ev, groomBtn); } } });
  const demolishBtn = armedButton('Demolish', (ev, b) => { const uid = selectedUid(); if (uid) { const r = act('demolishChamber', { uid }, ev, b); if (r.ok) bridge.select(null); } });
  const inspEmpty = note('Click a chamber in the nest to inspect it.');
  const inspSec = h('section', { class: 'sec inspect' }, h('div', { class: 'row-between' }, inspTitle, inspStatus), inspProgress.el, inspKv,
    h('h4', { class: 'sub-title', text: 'Next level' }), h('div', { class: 'row-between' }, lvlCost, lvlWork), lvlMsg, dirRow,
    h('div', { class: 'btn-row' }, levelBtn, pickDirBtn, groomBtn, relocateBtn, demolishBtn));
  inspectView.append(inspEmpty, inspSec);

  function switchToNest() {
    const st = ui.getUI();
    if (st.layout === 'medium' || st.layout === 'narrow') ui.setUI({ view: 'below' });
  }

  function selectedUid() {
    const sel = ui.getUI().selection;
    // A Nursery's brood pile and the queen pick as their own kinds, but their id is the chamber uid.
    return sel && (sel.kind === 'chamber' || sel.kind === 'nursery' || sel.kind === 'queen') ? num(sel.id, 0) : 0;
  }

  // --- chamber rows ---
  function createChamberRow(id) {
    const inst = h('span', { class: 'lvl' });
    const costEl = h('span', { class: 'cost' });
    const lockHint = h('span', { class: 'locked-hint' });
    // C99: placement requirements (depth rule, must touch X, own exit shaft) shown before the player tries to place it.
    const req = h('span', { class: 'buy-desc buy-req' });
    const place = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Place',
      on: { click: () => {
        const t = ui.getUI().tool;
        if (t && t.kind === 'placeChamber' && t.chamber === id) ui.setUI({ tool: null });
        else { ui.setUI({ tool: { kind: 'placeChamber', chamber: id } }); switchToNest(); }
      } } });
    const row = h('div', { class: 'buy-row chamber-row', dataset: { id } }, // the description is on the row: no duplicate tooltip
      h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('chamber', id) }), inst,
        h('span', { class: 'buy-desc', text: CHAMBER_TIPS[id] || '' }), req, lockHint),
      h('div', { class: 'buy-side' }, costEl, place));
    row.__r = { inst, costEl, lockHint, place, req };
    return row;
  }

  function updateChamberRow(row, id, s, d) {
    const r = row.__r;
    const key = chamberKey(id);
    const unlocked = isShown(s, key);
    toggleClass(row, 'locked', !unlocked);
    show(r.place, unlocked);
    show(r.costEl, unlocked);
    const have = arr(s.run.nest.chambers).filter((c) => c && c.type === id).length;
    const max = maxInstances(s, id);
    setText(r.inst, fmtCount(have) + ' / ' + fmtCount(max));
    const rules = chamberRuleText(s, d, id);
    setText(r.req, rules ? 'Placement: ' + rules : '');
    show(r.req, !!rules);
    const c = unlocked ? q(() => placementCost(s, id), null) : null;
    const capMsg = unlocked && have < max ? overCapHint(c, d) : '';
    setText(r.lockHint, unlocked ? capMsg : unlockHint(key));
    toggleClass(r.lockHint, 'warn', !!capMsg);
    if (unlocked) {
      const ok = setCost(r.costEl, have >= max ? null : c, s);
      toggleClass(row, 'cant', !ok && have < max);
      toggleClass(row, 'maxed', have >= max);
      setProp(r.place, 'disabled', have >= max);
      const t = ui.getUI().tool;
      const active = !!(t && t.kind === 'placeChamber' && t.chamber === id);
      toggleClass(row, 'active', active);
      setText(r.place, active ? 'Cancel' : have >= max ? 'Max' : 'Place');
    }
    toggleClass(row, 'glow', ui.getUI().glow === 'build:' + id);
  }

  // --- queue chips ---
  function jobLabel(s, job) {
    const ch = job.chamber ? arr(s.run.nest.chambers).find((c) => c && c.uid === job.chamber) : null;
    const base = DIG_KIND_NAMES[job.kind] || 'Dig';
    if (job.kind === 'tunnel') return 'Tunnel · ' + fmtCount(arr(job.cells).length) + ' cells';
    if (job.kind === 'shaft') return 'Shaft to the surface';
    return base + ' ' + (ch ? nameOf('chamber', ch.type) : '');
  }

  function createQueueChip(job) {
    const uid = job.uid;
    const label = h('span', { class: 'q-label' });
    const meta = h('span', { class: 'q-meta' });
    const bar = progressBar('bar-thin');
    const up = h('button', { type: 'button', class: 'btn btn-icon', text: '↑', attrs: { 'aria-label': 'Move up' },
      on: { click: (ev) => { const i = queueIndex(uid); if (i > 0) act('reorderQueue', { uid, to: i - 1 }, ev, up); } } });
    const down = h('button', { type: 'button', class: 'btn btn-icon', text: '↓', attrs: { 'aria-label': 'Move down' },
      on: { click: (ev) => { const i = queueIndex(uid); act('reorderQueue', { uid, to: i + 1 }, ev, down); } } });
    const cancel = h('button', { type: 'button', class: 'btn btn-icon btn-danger-ghost', text: '×', attrs: { 'aria-label': 'Cancel job' },
      dataset: { tip: 'Cancel: placement food refunded; dug cells stay dug.' },
      on: { click: (ev) => act('cancelJob', { uid }, ev, cancel) } });
    const chip = h('div', { class: 'q-chip', draggable: true, dataset: { uid: String(uid) } },
      h('div', { class: 'q-main' }, label, meta), bar.el, h('div', { class: 'q-btns' }, up, down, cancel));
    chip.addEventListener('dragstart', (ev) => { if (ev.dataTransfer) { ev.dataTransfer.setData('text/plain', 'q:' + uid); ev.dataTransfer.effectAllowed = 'move'; } });
    chip.addEventListener('dragover', (ev) => { ev.preventDefault(); chip.classList.add('drop'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop'));
    chip.addEventListener('drop', (ev) => {
      ev.preventDefault();
      chip.classList.remove('drop');
      const data = ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '';
      if (!data.startsWith('q:')) return;
      const from = Number(data.slice(2));
      if (from === uid) return;
      act('reorderQueue', { uid: from, to: queueIndex(uid) }, ev, chip);
    });
    chip.__r = { label, meta, bar, up, down };
    return chip;
  }

  function queueIndex(uid) {
    return arr(game.s.run.nest.queue).findIndex((j) => j && j.uid === uid);
  }

  function updateQueueChip(chip, job, i, s, info) {
    const r = chip.__r;
    setText(r.label, jobLabel(s, job));
    const qi = info.get(job.uid);
    const cells = arr(job.cells).length;
    r.bar.set(cells > 0 ? num(job.cur) / cells : 0);
    setText(r.meta, (qi ? fmt(num(qi.work)) + ' work · ' + (num(qi.eta, -1) >= 0 ? fmtTime(qi.eta) : '—') : fmtCount(num(job.cur)) + ' / ' + fmtCount(cells) + ' cells'));
    setProp(r.up, 'disabled', i === 0);
    setProp(r.down, 'disabled', i === arr(s.run.nest.queue).length - 1);
    toggleClass(chip, 'first', i === 0);
  }

  // --- blueprints ---
  function bpSlots(s) {
    return fedLevel(s, 'blueprint_memory') > 0 ? fxOf(FEDERATION, 'blueprint_memory', 'slots', 5) : 1;
  }

  function createBpRow(slot) {
    const name = h('span', { class: 'row-title' });
    const meta = h('span', { class: 'row-meta' });
    const input = h('input', { type: 'text', class: 'input input-small', placeholder: 'Layout ' + (slot + 1), maxLength: 24, attrs: { 'aria-label': 'Blueprint name' } });
    const save = h('button', { type: 'button', class: 'btn btn-small', text: 'Save current',
      on: { click: (ev) => act('saveBlueprint', { slot, name: (input.value || 'Layout ' + (slot + 1)).slice(0, 24) }, ev, save) } });
    const load = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Use',
      on: { click: (ev) => act('loadBlueprint', { slot }, ev, load) } });
    const del = armedButton('Delete', (ev, b) => act('deleteBlueprint', { slot }, ev, b));
    const row = h('div', { class: 'bp-row card' }, h('div', { class: 'row-head' }, name, meta), h('div', { class: 'btn-row' }, input, save, load, del));
    row.__r = { name, meta, load, del };
    return row;
  }

  function updateBpRow(row, slot, s) {
    const r = row.__r;
    const bp = arr(s.era && s.era.blueprints)[slot] || null;
    setText(r.name, bp ? bp.name || 'Layout ' + (slot + 1) : 'Empty slot ' + (slot + 1));
    setText(r.meta, bp ? fmtCount(arr(bp.chambers).length) + ' chambers' + (num(s.era.activeBlueprint, -1) === slot ? ' · active' : '') : '');
    show(r.load, !!bp);
    show(r.del, !!bp);
    toggleClass(row, 'active', !!bp && num(s.era.activeBlueprint, -1) === slot);
  }

  // --- inspect ---
  function updateInspect(s, d) {
    const uid = selectedUid();
    const chambers = arr(s.run.nest.chambers);
    const idx = chambers.findIndex((c) => c && c.uid === uid);
    const ch = idx >= 0 ? chambers[idx] : null;
    show(inspEmpty, !ch);
    show(inspSec, !!ch);
    if (!ch) return;
    const dc = obj(arr(d && d.nest && d.nest.chambers)[idx]);
    setText(inspTitle, nameOf('chamber', ch.type) + ' · L' + fmtCount(num(ch.level)) + (num(ch.target) > num(ch.level) ? ' → L' + fmtCount(ch.target) : ''));
    setText(inspStatus, STATUS_NAMES[ch.status] || ch.status || '');
    toggleClass(inspStatus, 'badge-good', ch.status === 'active');
    toggleClass(inspStatus, 'badge-warn', ch.status !== 'active');
    const digging = ch.status !== 'active';
    show(inspProgress.el, digging && num(dc.cellsTotal) > 0);
    if (digging) inspProgress.set(num(dc.cellsTotal) > 0 ? num(dc.cellsDug) / num(dc.cellsTotal) : 0, fmtCount(num(dc.cellsDug)) + ' / ' + fmtCount(num(dc.cellsTotal)) + ' cells');
    setText(kv.layer.dd, dc.layer ? nameOf('layer', dc.layer) : '—');
    setText(kv.eff.dd, Number.isFinite(dc.eff) ? fmtMult(dc.eff) : '—');
    const adj = arr(dc.adj).map((u) => chambers.find((c) => c && c.uid === u)).filter(Boolean).map((c) => nameOf('chamber', c.type));
    setText(kv.adj.dd, adj.length ? adj.join(', ') : 'None');
    const mods = [];
    if (dc.exposed) mods.push('frost-exposed (×0.5)');
    if (dc.snap) mods.push('frost snap');
    if (dc.hygiene) mods.push('midden nearby (−20%)');
    if (dc.inReach) mods.push('within raid reach');
    // Event effects on this chamber (Mold Bloom spots halve it until scraped) — otherwise a ×0.13 Effect has no reason.
    const molds = arr(s.run.effects).filter((e) => e && e.stat === 'chamber' && e.scope === ch.uid && String(e.id).startsWith('mold:'));
    if (molds.length) mods.push(fmtCount(molds.length) + ' mold spot' + (molds.length === 1 ? '' : 's') + ' (×0.5 each: click to scrape)');
    setText(kv.mods.dd, mods.length ? mods.join(', ') : 'None');
    toggleClass(kv.mods.dd, 'warn', mods.length > 0);
    const info = q(() => levelInfo(s, d, uid), null);
    const isNursery = ch.type === 'nursery';
    show(groomBtn, isNursery && ch.status === 'active');
    show(demolishBtn, uid !== 1);
    if (demolishBtn.__disarm) demolishBtn.__disarm();
    const royalLocked = ch.type === 'royal_chamber' && !isShown(s, 'royal_levelup');
    if (!info || royalLocked) {
      setCost(lvlCost, null, s);
      setText(lvlWork, '');
      setText(lvlMsg, royalLocked ? unlockHint('royal_levelup') : '');
      show(dirRow, false);
      show(levelBtn, false);
      show(pickDirBtn, false);
      return;
    }
    const ok = setCost(lvlCost, info.max ? null : info.cost, s);
    setText(lvlWork, num(info.work) > 0 ? fmt(num(info.work)) + ' work' : '');
    const capMsg = info.max ? '' : overCapHint(info.cost, d);
    setText(lvlMsg, levelMessage(info, ch) || capMsg);
    toggleClass(lvlMsg, 'warn', !info.max && !!(info.blocked || info.royalRoom || capMsg));
    const growable = !!info.grows && !info.max;
    const dirs = obj(info.dirs);
    show(dirRow, growable);
    for (const dir of DIRS) {
      show(dirBtns[dir], !!dirs[dir]);
      toggleClass(dirBtns[dir], 'cant', !ok);
    }
    show(levelBtn, !growable && !info.max);
    toggleClass(levelBtn, 'cant', !ok);
    show(pickDirBtn, growable);
  }

  return {
    update(s, d) {
      if (!s || !s.run || !s.run.nest) return;
      const sub = ui.getUI().subTab === 'inspect' ? 'inspect' : 'main';
      subs.update(sub, { main: true, inspect: true });
      show(mainView, sub === 'main');
      show(inspectView, sub === 'inspect');
      if (sub === 'inspect') {
        updateInspect(s, d);
        return;
      }
      const tool = ui.getUI().tool;
      const nestTool = tool && ['placeChamber', 'relocate', 'backfill', 'levelDir'].includes(tool.kind);
      show(toolBanner, !!nestTool);
      if (nestTool) {
        setText(toolText, tool.kind === 'placeChamber' ? 'Placing ' + nameOf('chamber', tool.chamber) + ': click in the nest.'
          : tool.kind === 'relocate' ? 'Relocating: click a new spot in the nest.'
            : tool.kind === 'backfill' ? 'Backfill: click or drag a box over tunnels. Red cells stay open (a chamber needs them). B or Esc ends.'
              : 'Click the edge to grow toward: the new row or column is shown.');
        if (tool.kind === 'placeChamber') {
          const rules = chamberRuleText(s, d, tool.chamber);
          if (rules) setText(toolText, 'Placing ' + nameOf('chamber', tool.chamber) + ': ' + rules + ' Click in the nest.');
        }
      }
      // queue
      const queue = arr(s.run.nest.queue).filter(Boolean);
      const info = new Map();
      for (const qi of arr(d && d.nest && d.nest.queueInfo)) if (qi) info.set(qi.uid, qi);
      setText(queueMeta, fmtCount(queue.length) + ' / ' + fmtCount(queueLimit(s)));
      setText(digRate, 'Dig rate ' + fmtRate(num(d && d.stats && d.stats.digW)).replace('/s', ' work/s'));
      syncList(queueList, queue, (j) => j.uid, createQueueChip, (chip, j, i) => updateQueueChip(chip, j, i, s, info));
      show(queueEmpty, queue.length === 0);
      show(noDiggers, queue.length > 0 && !(num(d && d.stats && d.stats.digW) > 0));
      show(helpBtn, queue.length > 0);
      toggleClass(backfillBtn, 'active', !!(tool && tool.kind === 'backfill'));
      // chambers
      const royal = arr(s.run.nest.chambers).find((c) => c && c.uid === 1);
      show(royalRow, isShown(s, 'royal_levelup') && !!royal);
      if (royal) setText(royalLvl, 'L' + fmtCount(num(royal.level)));
      const ids = chamberIds().filter((id) => id !== 'royal_chamber' || maxInstances(s, id) > 1);
      // Every chamber is listed; locked ones are greyed with their unlock condition (DESIGN §25.3).
      syncList(chamberList, ids, (id) => id, createChamberRow, (row, id) => updateChamberRow(row, id, s, d));
      // mound
      const mUnlocked = isShown(s, 'mound');
      show(moundSec, mUnlocked);
      if (mUnlocked) {
        const L = num(s.run.surface && s.run.surface.mound);
        setText(moundLvl, 'L' + fmtCount(L));
        const c = q(() => moundCost(s), null);
        const ok = setCost(moundCostEl, c, s);
        toggleClass(moundBtn, 'cant', !ok);
        const free = num(MOUND && MOUND.freeMax, 5);
        setText(moundNote, L >= free && !hasResearch(s, 'mound_building') ? 'Levels above ' + free + ' need Mound Building research.' : '');
      }
      // blueprints
      const bpOn = traitLevel(s, 'ancestral_blueprint') > 0 || fedLevel(s, 'blueprint_memory') > 0;
      show(bpSec, bpOn);
      if (bpOn) {
        const slots = Array.from({ length: bpSlots(s) }, (_, i) => i);
        syncList(bpList, slots, (i) => i, createBpRow, (row, i) => updateBpRow(row, i, s));
      }
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

