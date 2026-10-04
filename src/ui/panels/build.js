// Build panel: chamber list (locked items greyed with their unlock condition), dig-queue chips (reorder, cancel,
// work, ETA), Help Dig, tools (backfill), the Mound, the inspect view of the selected chamber (level up with direction,
// relocate, demolish, modifiers) and blueprints. Owner: WP9. Contract: ARCHITECTURE §14.5 (Build row), §8.2, §13.7.
// Queries: nest.placementCost, nest.levelInfo, d.nest.queueInfo, surface.moundCost.

import { h, setText, setProp, show, toggleClass, syncList, setCost } from '../dom.js';
import { fmt, fmtCount, fmtTime, fmtMult, fmtRate } from '../format.js';
import { nameOf, CHAMBER_TIPS, CHAMBER_ABOUT, DIG_KIND_NAMES, unlockHint, reasonText, placementRuleLines, levelGainText, adjacencyLines, linkText,
  plannedWaitText } from '../text.js';
import { isShown, hasResearch, traitLevel, fedLevel, num, arr, obj } from '../reveal.js';
import { placementCost, levelInfo, placementRows, levelGain, cheapestLevel, chamberLinks, unneededTunnels, pocketAction, pocketAt,
  rootCap, rootCost, plannedWaits, plannedWait } from '../../systems/nest.js';
import { DRAINAGE, ROOT_CULT } from '../../data/soilFeatures.js';
import { moundCost } from '../../systems/surface.js';
import { CHAMBER_ORDER, CHAMBERS } from '../../data/chambers.js';
import { DIG } from '../../data/strata.js';
import { MOUND } from '../../data/surface.js';
import { RESEARCH } from '../../data/research.js';
import { TRAITS } from '../../data/bloodline.js';
import { FEDERATION } from '../../data/federation.js';
import { FLIGHT } from '../../data/prestige.js';
import { BROOD } from '../../data/economy.js';
import { CLICK_CAP, GRID } from '../../data/balance.js';
import { makeAct, note, progressBar, armedButton, subTabStrip } from './common.js';

const GRID_COLS = (GRID && GRID.cols) || 40;

/** Chamber ids when data/chambers.js is still empty (DESIGN §7.6 order). */
export const CHAMBER_FALLBACK = Object.freeze(['royal_chamber', 'gallery', 'nursery', 'granary', 'scent_library', 'midden', 'barracks',
  'war_hall', 'root_aphid_pen', 'fungus_garden', 'repletion_hall', 'hibernaculum', 'thermal_chimney', 'gate', 'water_well', 'nuptial_chamber', 'deep_vault']);
/** Default instance limits when data is missing (DESIGN §7.6). */
const MAX_INST_FALLBACK = Object.freeze({ royal_chamber: 1, gallery: 4, nursery: 3, granary: 3, scent_library: 2, midden: 2, barracks: 2,
  war_hall: 2, root_aphid_pen: 2, fungus_garden: 3, repletion_hall: 2, hibernaculum: 2, thermal_chimney: 1, gate: 1, water_well: 'perPocket',
  nuptial_chamber: 1, deep_vault: 1 });
const DIRS = ['left', 'right', 'up', 'down'];
const DIR_LABELS = { left: '← Left', right: 'Right →', up: '↑ Up', down: '↓ Down' };
const STATUS_NAMES = { digging: 'Digging', active: 'Active', growing: 'Enlarging', relocating: 'Relocating' };

/** C137: does this chamber type reserve a full-size room (it grows)? */
function resGrows(type) {
  const c = CHAMBERS[type];
  return !!(c && c.grows);
}

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
  // C137: growth into the reserved room waits for whatever sits in the next row or column
  if (info.blocked && info.reserved) return reservedBlockText(info.blockWhy);
  if (info.blocked) return 'No room to grow: relocate it or clear space around it.';
  if (ch && ch.status !== 'active') return 'Finish digging before the next level.';
  if (info.royalRoom) return 'Some directions are held back so the Royal Chamber keeps room to reach L' + num(FLIGHT && FLIGHT.royalLevel, 5) + '.';
  return '';
}

/**
 * C137: why growth into a chamber's reserved room waits (the next row or column holds stone, water, a closed layer,
 * cells still queued or being backfilled).
 * @param {string|null} why levelInfo.blockWhy
 * @returns {string}
 */
export function reservedBlockText(why) {
  const what = {
    'blocked:stone': 'stone (Acid Excavation digs it)',
    'blocked:water': 'a water pocket (drain or move it)',
    'blocked:layer': 'a closed layer',
    'blocked:queued': 'cells still queued for digging',
    'blocked:backfill': 'cells being backfilled',
    'blocked:shaft': 'a shaft entrance',
    hardship: 'the Hardship depth limit',
  }[why];
  return 'Growth waits: its reserved space holds ' + (what || 'something in the way') + ' where the next level goes.';
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

/**
 * Growth line of the inspect panel's "Next level" (C107): which side the footprint grows and how many cells are added,
 * from nest.levelInfo (auto direction rect; the direction buttons pick another side).
 * @param {{ x: number, y: number, w: number, h: number }} ch
 * @param {Object|null} info nest.levelInfo
 * @returns {string}
 */
export function growthText(ch, info) {
  if (!ch || !info || info.max) return '';
  if (!info.grows) return 'The footprint stays the same: the new level works at once.';
  if (info.reserved && info.rect) {
    // C137: the next row or column inside its reserved full-size room (a fixed order, no side to pick)
    const r = info.rect;
    const side = r.x < ch.x ? 'left' : r.x + r.w > ch.x + ch.w ? 'right' : r.y < ch.y ? 'up' : 'down';
    const what = r.w > ch.w ? 'one column' : 'one row';
    const cells = r.w * r.h - ch.w * ch.h;
    return 'Grows ' + what + ' ' + (side === 'up' || side === 'down' ? side + 'ward' : 'to the ' + side) + ' into its reserved space (+'
      + fmtCount(cells) + ' cells to dig). The level counts once they are dug.';
  }
  if (info.blocked || !info.rect) return 'Needs one more row or column, but every side is blocked.';
  const r = info.rect;
  const side = r.x < ch.x ? 'left' : r.x + r.w > ch.x + ch.w ? 'right' : r.y < ch.y ? 'up' : 'down';
  const what = r.w > ch.w ? 'one column' : 'one row';
  const cells = r.w * r.h - ch.w * ch.h;
  const dirs = obj(info.dirs);
  const n = ['left', 'right', 'up', 'down'].filter((k) => dirs[k]).length;
  return 'Grows ' + what + ' ' + (side === 'up' || side === 'down' ? side + 'ward' : 'to the ' + side) + ' (+' + fmtCount(cells) + ' cells to dig'
    + (n > 1 ? '; the buttons pick another side' : '') + '). The level counts once they are dug.';
}

/**
 * Groom Brood explanation (C20, DESIGN §7.12; population.js groomBrood): one click adds groomPct × this chamber's
 * share of all brood slots to the development of every brood cohort in the colony (shared click cap; not in the
 * Claustral Founding hardship).
 * @param {Object} s
 * @param {Object} d
 * @param {number} uid nursery (or other brood chamber) uid
 * @returns {string}
 */
export function groomText(s, d, uid) {
  const pct = num(BROOD && BROOD.groomPct, 0.01);
  let tot = 0;
  let mine = 0;
  for (const g of arr(d && d.nest && d.nest.agg && d.nest.agg.broodGroups)) {
    if (!g) continue;
    tot += Math.max(0, num(g.cap));
    if (g.uid === uid) mine += Math.max(0, num(g.cap));
  }
  const share = tot > 0 ? mine / tot : 0;
  const per = pct * share;
  if (s && s.run && s.run.hardship === 'claustral_founding') return 'Groom Brood is not allowed in the Claustral Founding hardship.';
  return 'Each click adds +' + (Math.round(per * 1e4) / 100) + '% development to all brood in the colony (' + Math.round(pct * 100)
    + '% × this nursery\'s ' + Math.round(share * 100) + '% share of brood slots). Up to ' + CLICK_CAP + ' clicks/s, shared with other clicks.';
}

/**
 * Label of the "level the cheapest" button (C108): "Level cheapest (L3 Gallery, 1.20K food)" for several instances,
 * "Level up (L2, 50 food)" for one.
 * @param {string} id chamber type
 * @param {{ level: number, cost: Object, count: number }|null} c nest.cheapestLevel
 * @returns {string}
 */
export function cheapestLabel(id, c) {
  if (!c) return '';
  const food = num(c.cost && c.cost.food);
  const price = food > 0 ? fmt(food) + ' food' : num(c.cost && c.cost.soil) > 0 ? fmt(num(c.cost.soil)) + ' soil' : '';
  if (num(c.count) > 1) return 'Level cheapest (L' + fmtCount(num(c.level)) + ' ' + nameOf('chamber', id) + (price ? ', ' + price : '') + ')';
  return 'Level up (L' + fmtCount(num(c.level)) + ' → L' + fmtCount(num(c.level) + 1) + (price ? ', ' + price : '') + ')';
}

/**
 * "Level cheapest" button state (C108; C122). In the inspect panel (compact = false) it shows whenever there are several
 * instances and one can level — also when the selected chamber is itself the cheapest (then it levels that one); in
 * the Build list (compact) it shows whenever one can level, with a short label ("Lvl cheapest · 1.20K") and the full
 * detail in the tooltip. ok = the cost can be paid now (green buy style; quiet otherwise).
 * @param {Object} s
 * @param {Object} d
 * @param {string} type chamber type
 * @param {{ selectedUid?: number, compact?: boolean }} [opts]
 * @returns {{ show: boolean, uid: number, label: string, tip: string, ok: boolean, self: boolean }}
 */
export function cheapestButton(s, d, type, { selectedUid = 0, compact = false } = {}) {
  const c = q(() => cheapestLevel(s, d, type), null);
  if (!c) return { show: false, uid: 0, label: '', tip: '', ok: false, self: false };
  const many = num(c.count) > 1;
  const self = !!selectedUid && c.uid === selectedUid;
  const food = num(c.cost && c.cost.food);
  const short = food > 0 ? fmt(food) : num(c.cost && c.cost.soil) > 0 ? fmt(num(c.cost.soil)) + ' soil' : '';
  const g = q(() => levelGain(s, d, c.uid), null);
  const lines = g && !g.max ? g.lines.map(levelGainText).filter(Boolean) : [];
  const head = many ? (self ? 'This one is the cheapest to level. ' : 'Levels the cheapest ' + nameOf('chamber', type) + ': ') : '';
  // C142: L levels the cheapest of the type, Shift+L the selected one
  const tip = head + 'L' + fmtCount(num(c.level)) + ' → L' + fmtCount(num(c.level) + 1) + ': ' + (lines.join('; ') || 'next level')
    + '. Cost ' + costText(c.cost) + '.' + (many ? ' Key: L with a ' + nameOf('chamber', type) + ' selected.' : ' Key: L with it selected.');
  const label = compact ? (many ? 'Lvl cheapest' : 'Lvl up') + (short ? ' · ' + short : '') : 'Level cheapest (L)';
  return { show: compact ? true : many, uid: c.uid, label, tip, ok: q(() => canPay(s, c.cost), true), self };
}

/**
 * Chamber hotkeys (C108; DESIGN §25.4; C142 swap): with a chamber selected in the nest, L levels the cheapest chamber of
 * its type, Shift+L levels the selected one, G picks the growth side (levelDir tool; legacy chambers without a
 * reservation only, C137), R relocates it. R stays Rally when a trail is selected (the caller checks the trail first).
 * null = not a chamber hotkey.
 * @param {string} key KeyboardEvent.key
 * @param {boolean} shift
 * @param {Object|null} sel uistate selection
 * @returns {null | { kind: 'level'|'levelCheapest'|'levelDir'|'relocate', uid: number }}
 */
export function chamberHotkey(key, shift, sel) {
  if (!sel || sel.view !== 'nest' || !(sel.kind === 'chamber' || sel.kind === 'nursery' || sel.kind === 'queen')) return null;
  const uid = num(sel.id, 0);
  if (!(uid > 0)) return null;
  const k = String(key || '').toLowerCase();
  if (k === 'l') return { kind: shift ? 'level' : 'levelCheapest', uid };
  if (k === 'g' && !shift) return { kind: 'levelDir', uid };
  if (k === 'r' && !shift) return { kind: 'relocate', uid };
  return null;
}

/**
 * What a chamber hotkey does now (C108): a levelChamber command (L; Shift+L on the cheapest instance of the type, via
 * nest.cheapestLevel), a nest tool (G: levelDir when the chamber grows; R: relocate), or a refusal text.
 * @param {Object} s
 * @param {Object} d
 * @param {{ kind: string, uid: number }} hk chamberHotkey result
 * @returns {null | { cmd?: { type: string, args: Object }, tool?: Object, reject?: string }}
 */
export function chamberHotkeyAction(s, d, hk) {
  if (!hk || !s || !s.run) return null;
  const ch = arr(s.run.nest && s.run.nest.chambers).find((c) => c && c.uid === hk.uid);
  if (!ch) return null;
  if (hk.kind === 'level') return { cmd: { type: 'levelChamber', args: { uid: ch.uid } } };
  if (hk.kind === 'levelCheapest') {
    const c = q(() => cheapestLevel(s, d, ch.type), null);
    return c ? { cmd: { type: 'levelChamber', args: { uid: c.uid } } } : { reject: 'No ' + nameOf('chamber', ch.type) + ' can level right now.' };
  }
  if (hk.kind === 'levelDir') {
    const info = q(() => levelInfo(s, d, ch.uid), null);
    if (!info || info.max) return { reject: 'Maximum level.' };
    if (info.reserved) return { reject: 'It grows into its reserved space: no side to pick. Shift+L levels it.' };
    if (!info.grows) return { reject: 'Its footprint does not grow: press Shift+L to level it.' };
    return { tool: { kind: 'levelDir', uid: ch.uid } };
  }
  if (hk.kind === 'relocate') return { tool: { kind: 'relocate', uid: ch.uid } };
  return null;
}

/**
 * C142 (Q key): the chamber under the cursor (or the selected one) picks its type in the Build tool, to place another.
 * Refused with a reason when that type is locked or at its instance limit. null = not a chamber reference.
 * @param {Object} s
 * @param {Object} d
 * @param {Object|null} ref uistate hover or selection ({ view: 'nest', kind: 'chamber'|'nursery'|'queen', id: uid })
 * @returns {null | { tool?: { kind: 'placeChamber', chamber: string }, reject?: string }}
 */
export function placeAnotherAction(s, d, ref) {
  if (!ref || ref.view !== 'nest' || !(ref.kind === 'chamber' || ref.kind === 'nursery' || ref.kind === 'queen') || !s || !s.run) return null;
  const uid = num(ref.id, 0);
  const ch = arr(s.run.nest && s.run.nest.chambers).find((c) => c && c.uid === uid);
  if (!ch) return null;
  const name = nameOf('chamber', ch.type);
  const key = chamberKey(ch.type);
  if (key && !(s.run.unlocked && s.run.unlocked[key])) return { reject: name + ' is not unlocked yet: ' + unlockHint(key) };
  const have = arr(s.run.nest.chambers).filter((c) => c && c.type === ch.type).length;
  const max = maxInstances(s, ch.type);
  if (have >= max) return { reject: name + ' limit reached (' + fmtCount(have) + '/' + fmtCount(max) + ').' };
  void d;
  return { tool: { kind: 'placeChamber', chamber: ch.type } };
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

/** Can the state pay this cost now? */
function canPay(s, cost) {
  if (!cost) return false;
  for (const r of Object.keys(cost)) if (num(s.run.res[r]) + 1e-9 < num(cost[r])) return false;
  return true;
}

/** "1.20K food, 300 soil". */
function costText(cost) {
  return Object.keys(obj(cost)).filter((r) => num(cost[r]) > 0).map((r) => fmt(num(cost[r])) + ' ' + r).join(', ') || 'free';
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
  const backfillBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Backfill… (B)', dataset: { tip: 'Fill tunnels back in, free: drag a box over them (key B).' },
    on: { click: () => { const t = ui.getUI().tool; ui.setUI({ tool: t && t.kind === 'backfill' ? null : { kind: 'backfill' } }); switchToNest(); } } });
  // C121: one click backfills every tunnel nothing needs; the first click asks with the count, the second confirms.
  let unneededArmed = 0;
  const unneededBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost btn-unneeded', text: 'Backfill unneeded…',
    dataset: { tip: 'Fill in every tunnel no chamber, dig job, shaft, entrance or planned chamber needs. Free, 10 s.' },
    on: { click: (ev) => {
      const now = Date.now();
      if (unneededArmed && now - unneededArmed < 6000) {
        unneededArmed = 0;
        unneededBtn.classList.remove('armed');
        setText(unneededBtn, 'Backfill unneeded…');
        act('backfillUnneeded', {}, ev, unneededBtn);
        return;
      }
      const n = q(() => unneededTunnels(game.s, game.d).length, 0);
      if (!n) { act('backfillUnneeded', {}, ev, unneededBtn); return; }
      unneededArmed = now;
      unneededBtn.classList.add('armed');
      setText(unneededBtn, 'Backfill ' + fmtCount(n) + ' unneeded tunnel cell' + (n === 1 ? '' : 's') + '? Click again');
    } } });
  const queueList = h('div', { class: 'queue' });
  const queueEmpty = note('Nothing queued. Diggers do maintenance and still yield soil.');
  // Queued work with no dig rate never finishes: say why and where to fix it (a new player can place a Gallery before
  // assigning any Digger).
  const noDiggers = h('div', { class: 'alert alert-warn' },
    h('span', { text: 'No diggers: this work will not progress.' }),
    h('button', { type: 'button', class: 'btn btn-small', text: 'Assign diggers', on: { click: () => bridge.openTab('colony') } }));
  const queueSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title' }, 'Dig queue ', queueMeta),
    h('div', { class: 'row-between' }, digRate, h('span', { class: 'btn-row' }, helpBtn, backfillBtn, unneededBtn)), noDiggers, queueList, queueEmpty);

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

  // --- cultivated roots (C118) ---
  const rootMeta = h('span', { class: 'lvl' });
  const rootCostEl = h('span', { class: 'cost' });
  const rootBtn = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Grow a root…',
    on: { click: () => { const t = ui.getUI().tool; ui.setUI({ tool: t && t.kind === 'growRoot' ? null : { kind: 'growRoot' } }); switchToNest(); } } });
  const rootNote = h('p', { class: 'note' });
  const rootSec = h('section', { class: 'sec root-sec' }, h('h3', { class: 'sec-title', text: 'Cultivated roots' }),
    h('div', { class: 'buy-row' },
      h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: 'Root line' }), rootMeta,
        h('span', { class: 'buy-desc', text: 'Pick a column: a root grows down from the surface, ' + fmtCount(num(ROOT_CULT && ROOT_CULT.rowsPerSec, 2))
          + ' rows a second, to row ' + fmtCount(num(ROOT_CULT && ROOT_CULT.maxRow, 30)) + ' at most. Root Aphid Pens can touch it.' })),
      h('div', { class: 'buy-side' }, rootCostEl, rootBtn)), rootNote);

  // --- blueprints ---
  const bpList = h('div', { class: 'list' });
  // C120: chambers of the active blueprint still waiting (planned outlines), each cancellable, or all at once.
  const plannedList = h('div', { class: 'planned-list' });
  const plannedAll = armedButton('Cancel all planned', (ev, b) => act('cancelPlanned', { all: true }, ev, b));
  const plannedBox = h('div', { class: 'planned-box' }, h('div', { class: 'row-between' }, h('span', { class: 'sub-title', text: 'Planned (waiting)' }), plannedAll),
    plannedList);
  const bpSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Blueprints' }),
    h('p', { class: 'note', text: 'Saved layouts auto-queue after each flight and dig faster. Use applies one now as well.' }), plannedBox, bpList);

  // camera help for the nest view (render/nestInput.js; the full list is in Settings → Keyboard and view controls)
  const viewHelp = note('Nest view: wheel scrolls, Ctrl + wheel or pinch zooms, the crown button (top-right) frames the queen.');
  viewHelp.classList.add('view-help');
  mainView.append(toolBanner, queueSec, chamberSec, moundSec, rootSec, bpSec, viewHelp);

  // --- inspect ---
  const inspTitle = h('h3', { class: 'sec-title' });
  const inspStatus = h('span', { class: 'badge' });
  const inspProgress = progressBar('bar-dig');
  const inspKv = h('dl', { class: 'kv' });
  const kv = {};
  for (const [k, label] of [['layer', 'Layer'], ['adj', 'Links'], ['mods', 'Modifiers']]) {
    kv[k] = { dt: h('dt', { text: label }), dd: h('dd') };
    inspKv.append(kv[k].dt, kv[k].dd);
  }
  // C109: the adjacency rules of this chamber type
  const adjRules = h('p', { class: 'note adj-rules' });
  // C107: what the next level gives, and how the footprint grows
  const gainList = h('ul', { class: 'gain-list' });
  const growNote = h('p', { class: 'note' });
  // C20 / §7.12: what one Groom Brood click does here
  const groomNote = h('p', { class: 'note groom-note' });
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
  // C122: the chamber hotkeys (C108) are named on the buttons.
  const levelBtn = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Level up (Shift+L)',
    on: { click: (ev) => { const uid = selectedUid(); if (uid) act('levelChamber', { uid }, ev, levelBtn); } } });
  const pickDirBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Grow direction… (G)',
    dataset: { tip: 'Pick the side to grow on the map: click the edge (key G).' },
    on: { click: () => { const uid = selectedUid(); if (uid) { ui.setUI({ tool: { kind: 'levelDir', uid } }); switchToNest(); } } } });
  const relocateBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Relocate… (R)',
    on: { click: () => { const uid = selectedUid(); if (uid) { ui.setUI({ tool: { kind: 'relocate', uid } }); switchToNest(); } } } });
  const groomBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Groom brood', dataset: { tip: 'Each click adds development to all brood.' },
    on: { click: (ev) => { const uid = selectedUid(); if (uid) act('groomBrood', { chamber: uid }, ev, groomBtn); } } });
  const cheapInspBtn = h('button', { type: 'button', class: 'btn btn-small btn-buy btn-cheapest-insp',
    on: { click: (ev) => { const ch = selectedChamber(); const c = ch ? q(() => cheapestLevel(game.s, game.d, ch.type), null) : null; if (c) act('levelChamber', { uid: c.uid }, ev, cheapInspBtn); } } });
  const demolishBtn = armedButton('Demolish', (ev, b) => { const uid = selectedUid(); if (uid) { const r = act('demolishChamber', { uid }, ev, b); if (r.ok) bridge.select(null); } });
  const inspEmpty = note('Click a chamber in the nest to inspect it.');
  // C141: what this chamber does, at the top
  const inspAbout = h('p', { class: 'note insp-about' });
  const inspSec = h('section', { class: 'sec inspect' }, h('div', { class: 'row-between' }, inspTitle, inspStatus), inspAbout, inspProgress.el, inspKv,
    adjRules, groomNote, h('h4', { class: 'sub-title', text: 'Next level' }), gainList, h('div', { class: 'row-between' }, lvlCost, lvlWork), growNote, lvlMsg, dirRow,
    h('div', { class: 'btn-row' }, levelBtn, pickDirBtn, groomBtn, relocateBtn, cheapInspBtn, demolishBtn));
  // C117 / C120: inspect a water pocket or a planned blueprint chamber
  const featTitle = h('h3', { class: 'sec-title' });
  const featBadge = h('span', { class: 'badge' });
  const featText = h('p', { class: 'note' });
  const featCost = h('span', { class: 'cost' });
  const featWork = h('span', { class: 'muted' });
  const featMsg = h('p', { class: 'note' });
  // C126: why a planned blueprint chamber is still waiting
  const featWait = h('p', { class: 'note planned-wait' });
  const drainBtn = armedButton('Drain pocket', (ev, b) => { const k = selectedPocket(); if (k >= 0) act('drainPocket', { pocket: k }, ev, b); }, 'btn-small btn-buy');
  const moveBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Move pocket…',
    on: { click: () => { const k = selectedPocket(); if (k >= 0) { ui.setUI({ tool: { kind: 'movePocket', pocket: k } }); switchToNest(); } } } });
  const cancelPlannedBtn = h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', text: 'Cancel planned chamber',
    on: { click: (ev) => { const sel = ui.getUI().selection; if (sel && sel.kind === 'planned') { const r = act('cancelPlanned', { cell: num(sel.i, -1) }, ev, cancelPlannedBtn); if (r.ok) bridge.select(null); } } } });
  const featSec = h('section', { class: 'sec inspect inspect-feature' }, h('div', { class: 'row-between' }, featTitle, featBadge), featText, featWait,
    h('div', { class: 'row-between' }, featCost, featWork), featMsg, h('div', { class: 'btn-row' }, drainBtn, moveBtn, cancelPlannedBtn));
  inspectView.append(inspEmpty, inspSec, featSec);

  /** Selected water pocket index (C117), or −1. */
  function selectedPocket() {
    const sel = ui.getUI().selection;
    // by the clicked cell: pocket indices shift when one is drained
    return sel && sel.view === 'nest' && sel.kind === 'pocket' ? q(() => pocketAt(game.s, num(sel.i, -1)), -1) : -1;
  }

  function switchToNest() {
    const st = ui.getUI();
    if (st.layout === 'medium' || st.layout === 'narrow') ui.setUI({ view: 'below' });
  }

  function selectedChamber() {
    const uid = selectedUid();
    return uid ? arr(game.s && game.s.run && game.s.run.nest && game.s.run.nest.chambers).find((c) => c && c.uid === uid) || null : null;
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
    // C109: the adjacency bonus this type has and which chamber types give it (data ADJACENCY).
    const adjLines = adjacencyLines(id);
    const adjEl = h('span', { class: 'buy-desc buy-adj', text: adjLines.length ? 'Adjacency: ' + adjLines.join(' ') : '' });
    if (!adjLines.length) adjEl.hidden = true;
    // C108: level the instance with the lowest next cost (tooltip: what that level gives).
    const cheap = h('button', { type: 'button', class: 'btn btn-small btn-buy btn-cheapest',
      on: { click: (ev) => { const c = q(() => cheapestLevel(game.s, game.d, id), null); if (c) act('levelChamber', { uid: c.uid }, ev, cheap); } } });
    const place = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Place',
      on: { click: () => {
        const t = ui.getUI().tool;
        if (t && t.kind === 'placeChamber' && t.chamber === id) ui.setUI({ tool: null });
        else { ui.setUI({ tool: { kind: 'placeChamber', chamber: id } }); switchToNest(); }
      } } });
    const row = h('div', { class: 'buy-row chamber-row', dataset: { id } }, // the description is on the row: no duplicate tooltip
      h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('chamber', id) }), inst,
        h('span', { class: 'buy-desc', text: CHAMBER_TIPS[id] || '' }), adjEl, req, lockHint),
      h('div', { class: 'buy-side' }, costEl, place, cheap));
    row.__r = { inst, costEl, lockHint, place, req, cheap };
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
    // C108: level the cheapest instance of this type (Shift+L in the nest).
    // C122: compact ("Lvl cheapest · 1.20K"), green when affordable, quiet when not; the detail is in the tooltip.
    const cb = unlocked && have > 0 ? cheapestButton(s, d, id, { compact: true }) : null;
    show(r.cheap, !!cb && cb.show && isShown(s, id === 'royal_chamber' ? 'royal_levelup' : key));
    if (cb && cb.show) {
      setText(r.cheap, cb.label);
      toggleClass(r.cheap, 'cant', !cb.ok);
      r.cheap.dataset.tip = cb.tip;
      r.cheap.setAttribute('aria-label', (num(have) > 1 ? 'Level cheapest. ' : 'Level up. ') + cb.tip);
    }
    toggleClass(row, 'glow', ui.getUI().glow === 'build:' + id);
  }

  // --- queue chips ---
  function jobLabel(s, job) {
    const ch = job.chamber ? arr(s.run.nest.chambers).find((c) => c && c.uid === job.chamber) : null;
    const base = DIG_KIND_NAMES[job.kind] || 'Dig';
    if (job.kind === 'tunnel') return 'Tunnel · ' + fmtCount(arr(job.cells).length) + ' cells';
    if (job.kind === 'shaft') return 'Shaft to the surface';
    if (job.kind === 'drain') return job.to ? 'Move water pocket' : 'Drain water pocket';
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
    // C139: Use applies the layout now as well (queues what it can; the rest waits as planned chambers) and after every flight
    const load = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Use',
      dataset: { tip: 'Apply now: queue what fits, plan the rest. Also after every flight.' },
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
  /** C117 / C120: the inspect view of a water pocket or a planned blueprint chamber; false when neither is selected. */
  function updateFeature(s, d) {
    const sel = ui.getUI().selection;
    const kind = sel && sel.view === 'nest' ? sel.kind : null;
    if (kind === 'planned') {
      const cell = num(sel.i, -1);
      const sp = arr(s.run.nest.bpPending).find((p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.y * GRID_COLS + p.x === cell);
      if (!sp) return false;
      setText(featTitle, 'Planned: ' + nameOf('chamber', sp.type));
      setText(featBadge, 'Blueprint');
      const key = chamberKey(sp.type);
      const open = !key || !!(s.run.unlocked && s.run.unlocked[key]);
      setText(featText, 'Part of your active blueprint. It queues itself at half price once it is unlocked and you can pay for it.'
        + (open ? '' : ' Still locked: ' + unlockHint(key)));
      const c = q(() => placementCost(s, sp.type), null);
      const half = c && c.food !== undefined ? { ...c, food: c.food * num(DIG && DIG.blueprintPlaceMult, 0.5) } : c;
      setCost(featCost, half, s);
      setText(featWork, '');
      const wait = q(() => plannedWait(s, d, cell), null);
      setText(featWait, wait ? plannedWaitText(wait) : '');
      show(featWait, !!wait);
      setText(featMsg, 'Cancelling removes it from this run\'s plan (the saved blueprint stays). Its waiting tunnels go with it.');
      toggleClass(featMsg, 'warn', false);
      show(drainBtn, false);
      show(moveBtn, false);
      show(cancelPlannedBtn, true);
      return true;
    }
    if (kind === 'pocket') {
      show(featWait, false);
      const k = selectedPocket();
      const p = arr(s.run.nest.features && s.run.nest.features.water)[k];
      if (!p || !p.revealed) return false;
      setText(featTitle, 'Water pocket · ' + p.w + '×' + p.h);
      setText(featBadge, 'Rows ' + p.y + '–' + (p.y + p.h - 1));
      const info = q(() => pocketAction(s, d, k, null), null);
      const owned = hasResearch(s, DRAINAGE ? DRAINAGE.research : 'drainage');
      setText(featText, 'Cannot be dug. A Water Well must touch one.' + (info && info.wells ? ' A Water Well uses this pocket.' : '')
        + (owned ? ' Drain it (the cells become soil) or move it up to ' + num(DRAINAGE && DRAINAGE.moveRows, 12) + ' rows into plain soil.'
          : ' ' + nameOf('research', 'drainage') + ' research lets you drain or move it.'));
      show(drainBtn, owned);
      show(moveBtn, owned);
      show(cancelPlannedBtn, false);
      if (drainBtn.__disarm) drainBtn.__disarm();
      if (!owned || !info) {
        setCost(featCost, null, s);
        setText(featWork, '');
        setText(featMsg, '');
        return true;
      }
      setCost(featCost, info.cost, s);
      setText(featWork, num(info.work) > 0 ? fmt(num(info.work)) + ' dig work to drain' : '');
      const msg = info.busy ? 'Already being drained or moved: see the dig queue.'
        : info.reason && info.reason !== 'cantAfford' ? reasonText(info.reason, 'drainPocket')
          : info.wells ? 'Draining (or moving) it removes its Water Well, with the placement food refunded in full.' : '';
      setText(featMsg, msg);
      toggleClass(featMsg, 'warn', !!msg);
      toggleClass(drainBtn, 'cant', !info.ok);
      setProp(moveBtn, 'disabled', !!info.busy);
      return true;
    }
    return false;
  }

  function updateInspect(s, d) {
    const uid = selectedUid();
    const chambers = arr(s.run.nest.chambers);
    const idx = chambers.findIndex((c) => c && c.uid === uid);
    const ch = idx >= 0 ? chambers[idx] : null;
    const feat = !ch && updateFeature(s, d);
    show(featSec, feat);
    show(inspEmpty, !ch && !feat);
    show(inspSec, !!ch);
    if (!ch) return;
    const dc = obj(arr(d && d.nest && d.nest.chambers)[idx]);
    setText(inspTitle, nameOf('chamber', ch.type) + ' · L' + fmtCount(num(ch.level)) + (num(ch.target) > num(ch.level) ? ' → L' + fmtCount(ch.target) : ''));
    setText(inspStatus, STATUS_NAMES[ch.status] || ch.status || '');
    setText(inspAbout, CHAMBER_ABOUT[ch.type] || CHAMBER_TIPS[ch.type] || '');
    toggleClass(inspStatus, 'badge-good', ch.status === 'active');
    toggleClass(inspStatus, 'badge-warn', ch.status !== 'active');
    const digging = ch.status !== 'active';
    show(inspProgress.el, digging && num(dc.cellsTotal) > 0);
    if (digging) inspProgress.set(num(dc.cellsTotal) > 0 ? num(dc.cellsDug) / num(dc.cellsTotal) : 0, fmtCount(num(dc.cellsDug)) + ' / ' + fmtCount(num(dc.cellsTotal)) + ' cells');
    setText(kv.layer.dd, dc.layer ? nameOf('layer', dc.layer) : '—');
    // C109: live adjacency links (bonus and partner), then the rules of this type
    const links = q(() => chamberLinks(s, d, uid), []);
    setText(kv.adj.dd, links.length ? links.map(linkText).join('; ') : 'None');
    toggleClass(kv.adj.dd, 'warn', links.some((l) => !l.good && l.receiver === 'self'));
    const rules = adjacencyLines(ch.type);
    setText(adjRules, rules.length ? 'Adjacency: ' + rules.join(' ') : '');
    show(adjRules, rules.length > 0);
    const mods = [];
    // C107: the combined effect multiplier only when something changes it (the reasons follow)
    if (Number.isFinite(dc.eff) && Math.abs(dc.eff - 1) > 1e-9) mods.push('effect ' + fmtMult(dc.eff));
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
    const gText = isNursery ? groomText(s, d, uid) : '';
    setText(groomNote, gText);
    show(groomNote, !!gText);
    if (gText) groomBtn.dataset.tip = gText;
    // C108 / C122: level the cheapest of this type (several instances), also when that is the selected one
    const cb = cheapestButton(s, d, ch.type, { selectedUid: uid });
    show(cheapInspBtn, cb.show);
    if (cb.show) { setText(cheapInspBtn, cb.label); toggleClass(cheapInspBtn, 'cant', !cb.ok); cheapInspBtn.dataset.tip = cb.tip; }
    // C107: what the next level gives
    const gain = q(() => levelGain(s, d, uid), null);
    const gl = gain && !gain.max ? gain.lines.map(levelGainText).filter(Boolean) : [];
    syncList(gainList, gl.map((t, i) => ({ t, i })), (x) => x.i, () => h('li'), (li, x) => setText(li, x.t));
    show(gainList, gl.length > 0);
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
      show(growNote, false);
      show(gainList, !royalLocked && gl.length > 0);
      return;
    }
    setText(growNote, growthText(ch, info));
    show(growNote, !info.max);
    const ok = setCost(lvlCost, info.max ? null : info.cost, s);
    setText(lvlWork, num(info.work) > 0 ? fmt(num(info.work)) + ' dig work' : '');
    const capMsg = info.max ? '' : overCapHint(info.cost, d);
    setText(lvlMsg, levelMessage(info, ch) || capMsg);
    toggleClass(lvlMsg, 'warn', !info.max && !!(info.blocked || info.royalRoom || capMsg));
    // C137: a chamber with a reservation grows in a fixed order: no side buttons, just Level up
    const growable = !!info.grows && !info.max && !info.reserved;
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
      const nestTool = tool && ['placeChamber', 'relocate', 'backfill', 'levelDir', 'growRoot', 'movePocket'].includes(tool.kind);
      show(toolBanner, !!nestTool);
      if (nestTool) {
        setText(toolText, tool.kind === 'placeChamber' ? 'Placing ' + nameOf('chamber', tool.chamber) + ': click in the nest.'
          : tool.kind === 'relocate' ? 'Relocating: click a new spot in the nest.'
            : tool.kind === 'backfill' ? 'Backfill: click or drag a box over tunnels. Red cells stay open (a chamber needs them). B or Esc ends.'
              : tool.kind === 'growRoot' ? 'Grow a root: click a column in the nest. The preview shows how deep it reaches.'
                : tool.kind === 'movePocket' ? 'Move the water pocket: click a spot of plain soil within ' + num(DRAINAGE && DRAINAGE.moveRows, 12) + ' rows.'
              : 'Click the edge to grow toward: the new row or column is shown.');
        if (tool.kind === 'placeChamber') {
          const rules = chamberRuleText(s, d, tool.chamber);
          if (rules) setText(toolText, 'Placing ' + nameOf('chamber', tool.chamber) + ': ' + rules + ' Click in the nest.');
        }
        // C137: the faint outline is the full-size room it reserves; F (or right-click) picks the corner it starts in
        if ((tool.kind === 'placeChamber' && resGrows(tool.chamber)) || tool.kind === 'relocate') {
          setText(toolText, toolText.textContent + ' The outline is its full-size room: F or right-click picks the corner it starts in.');
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
      if (unneededArmed && Date.now() - unneededArmed >= 6000) {
        unneededArmed = 0;
        unneededBtn.classList.remove('armed');
        setText(unneededBtn, 'Backfill unneeded…');
      }
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
      // cultivated roots (C118)
      const rootsOn = hasResearch(s, ROOT_CULT ? ROOT_CULT.research : 'root_cultivation');
      show(rootSec, rootsOn);
      if (rootsOn) {
        const own = arr(s.run.nest.features && s.run.nest.features.roots).filter((r) => r && r.own).length;
        const cap = q(() => rootCap(s), 3);
        setText(rootMeta, fmtCount(own) + ' / ' + fmtCount(cap));
        const full = own >= cap;
        const ok = setCost(rootCostEl, full ? null : q(() => rootCost(s), null), s);
        toggleClass(rootBtn, 'cant', !ok && !full);
        setProp(rootBtn, 'disabled', full);
        toggleClass(rootBtn, 'active', !!(tool && tool.kind === 'growRoot'));
        setText(rootBtn, tool && tool.kind === 'growRoot' ? 'Cancel' : full ? 'Max' : 'Grow a root…');
        setText(rootNote, full ? 'Root limit reached: +1 every ' + fmtCount(num(ROOT_CULT && ROOT_CULT.moundPer, 5)) + ' Mound levels (up to +'
          + fmtCount(num(ROOT_CULT && ROOT_CULT.moundMax, 3)) + ').' : '');
      }
      // blueprints
      const bpOn = traitLevel(s, 'ancestral_blueprint') > 0 || fedLevel(s, 'blueprint_memory') > 0;
      const pend = arr(s.run.nest.bpPending).filter(Boolean);
      show(bpSec, bpOn || pend.length > 0);
      show(plannedBox, pend.length > 0);
      if (pend.length) {
        if (plannedAll.__disarm) plannedAll.__disarm();
        const waits = q(() => plannedWaits(s, d), []) || [];
        syncList(plannedList, pend, (p) => p.type + '|' + p.x + '|' + p.y + '|' + (p.float ? 'f' : ''), (p0) => {
          const label = h('span', { class: 'planned-label' });
          const why = h('span', { class: 'planned-wait' });
          const cell = p0.y * GRID_COLS + p0.x;
          const btn = h('button', { type: 'button', class: 'btn btn-icon btn-danger-ghost', text: '×', attrs: { 'aria-label': 'Cancel planned chamber' },
            dataset: { tip: 'Cancel this planned chamber (this run only).' },
            on: { click: (ev) => act('cancelPlanned', { cell }, ev, btn) } });
          const row = h('div', { class: 'planned-row' }, h('div', { class: 'planned-main' }, label, why), btn);
          row.__r = { label, why };
          return row;
        }, (row, p) => {
          setText(row.__r.label, nameOf('chamber', p.type) + (p.float ? '' : ' · row ' + p.y));
          // C126: the reason it is still waiting
          const w = waits.find((x) => x.type === p.type && x.x === p.x && x.y === p.y);
          setText(row.__r.why, w ? plannedWaitText(w) : (p.float ? 'Waiting: a revealed water pocket with room' : ''));
        });
      }
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

