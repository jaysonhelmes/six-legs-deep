// Adaptations panel (C143): the repeatable food upgrades, moved out of the Colony tab into their own tab (after Map,
// revealed with adapt_basic). Each row has Buy, ×10 with its total cost and Max (n) = every level affordable now (C105).
// Owner: WP9. Contract: ARCHITECTURE §14.5 (Adaptations row), §8.1. Queries: adaptations.cost / isAvailable.

import { h, setText, setProp, show, toggleClass, syncList, setCost } from '../dom.js';
import { fmtCount } from '../format.js';
import { nameOf, ADAPT_TIPS } from '../text.js';
import { isShown, num, obj } from '../reveal.js';
import { canAfford } from '../../core/wallet.js';
import { cost as adaptCost, isAvailable as adaptAvailable } from '../../systems/adaptations.js';
import { ADAPTATION_ORDER, ADAPTATIONS } from '../../data/adaptations.js';
import { makeAct, note } from './common.js';
import { adaptAutoBox } from './automation.js';

/** Adaptation ids when data/adaptations.js is still empty. */
export const ADAPT_FALLBACK = Object.freeze(['quick_dispatch', 'strong_mandibles', 'royal_feeding', 'digging_claws', 'potent_trails',
  'serrated_mandibles', 'thick_cuticle', 'sweet_tooth', 'queens_feast', 'long_legs']);
/** Adaptation unlock keys when data/adaptations.js is still empty (ARCHITECTURE §6.2). */
export const ADAPT_UNLOCK_FALLBACK = Object.freeze({ quick_dispatch: 'adapt_basic', strong_mandibles: 'adapt_basic', royal_feeding: 'adapt_basic',
  digging_claws: 'adapt_digging_claws', potent_trails: 'adapt_potent_trails', serrated_mandibles: 'adapt_military', thick_cuticle: 'adapt_military',
  sweet_tooth: 'adapt_honeydew', queens_feast: 'adapt_honeydew', long_legs: 'adapt_long_legs' });

/** Safe query call. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Adaptation ids in display order. */
export function adaptIds() {
  return ADAPTATION_ORDER.length ? ADAPTATION_ORDER : ADAPT_FALLBACK;
}

/** Unlock key of an Adaptation. */
export function adaptKey(id) {
  const a = ADAPTATIONS[id];
  if (a && a.unlock) return a.unlock;
  return ADAPT_UNLOCK_FALLBACK[id] || null;
}

/**
 * The Adaptations the panel lists: revealed ones, plus any with a level (e.g. carried by a save whose key is not
 * revealed yet).
 * @param {Object} s
 * @returns {string[]}
 */
export function shownAdaptations(s) {
  return adaptIds().filter((id) => isShown(s, adaptKey(id)) || num(obj(s && s.run && s.run.adaptations)[id]) > 0);
}

/**
 * C105 bulk Adaptation buying: the cost of the next 10 levels (null when past MAX / the cap) and whether it is
 * affordable now, and the most levels affordable now (n, with their total cost; n = 0 when not even one is).
 * @param {Object} s
 * @param {string} id
 * @param {(s: Object, id: string, n: number) => Object|null} [costFn] adaptations.cost
 * @returns {{ c10: Object|null, ok10: boolean, n: number, cMax: Object|null }}
 */
export function adaptBulk(s, id, costFn = adaptCost) {
  const c = (n) => q(() => costFn(s, id, n), null);
  const fits = (n) => {
    const x = c(n);
    return !!x && canAfford(s, x);
  };
  const c10 = c(10);
  let n = 0;
  if (fits(1)) {
    let lo = 1;
    let hi = 2;
    while (hi <= 4096 && fits(hi)) { lo = hi; hi *= 2; }
    while (hi - lo > 1) {                         // lo fits, hi does not (or is past the search bound)
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid;
    }
    n = lo;
  }
  return { c10, ok10: !!c10 && canAfford(s, c10), n, cMax: n > 0 ? c(n) : null };
}

/**
 * Adaptations panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createPanel(root, { game, ui, bridge }) {
  const act = makeAct(game, bridge);
  const el = h('div', { class: 'panel panel-adaptations' });
  root.appendChild(el);
  const adaptList = h('div', { class: 'list adapt-list' });
  const empty = note('Adaptations appear once your first worker hatches.');
  const adaptSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Adaptations' }),
    h('p', { class: 'note', text: 'Repeatable upgrades. Each level costs more than the last; they reset with a Nuptial Flight.' }), adaptList);
  const autoBox = adaptAutoBox({ game, bridge }); // C166: the Adaptation autobuyer (Federation Autobuyers)
  el.append(empty, autoBox.el, adaptSec);

  function createAdaptRow(id) {
    const lvl = h('span', { class: 'lvl' });
    const costEl = h('span', { class: 'cost' });
    const buy = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Buy',
      on: { click: (ev) => act('buyAdaptation', { id, n: 1 }, ev, buy) } });
    const buy10 = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: '×10',
      on: { click: (ev) => act('buyAdaptation', { id, n: 10 }, ev, buy10) } });
    const cost10 = h('span', { class: 'cost cost-bulk' });
    const buyMax = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Max',
      on: { click: (ev) => {
        const n = adaptBulk(game.s, id).n;
        if (n > 0) act('buyAdaptation', { id, n }, ev, buyMax);
      } } });
    const bulkRow = h('span', { class: 'btn-row' }, cost10, buy10, buyMax);
    const lockHint = h('span', { class: 'locked-hint' });
    const row = h('div', { class: 'buy-row', dataset: { id } }, // the description is on the row: no duplicate tooltip
      h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('adaptation', id) }), lvl,
        h('span', { class: 'buy-desc', text: ADAPT_TIPS[id] || '' }), lockHint),
      h('div', { class: 'buy-side' }, costEl, h('span', { class: 'btn-row' }, buy), bulkRow));
    row.__r = { lvl, costEl, buy, buy10, lockHint, cost10, buyMax, bulkRow };
    return row;
  }

  function updateAdaptRow(row, id, s) {
    const r = row.__r;
    const L = num(obj(s.run.adaptations)[id]);
    setText(r.lvl, 'L' + fmtCount(L));
    const avail = q(() => adaptAvailable(s, id), false);
    const c = q(() => adaptCost(s, id, 1), null);
    const ok = setCost(r.costEl, c, s);
    toggleClass(row, 'cant', !ok && c !== null);
    toggleClass(row, 'maxed', c === null);
    toggleClass(row, 'blocked', !avail);
    setProp(r.buy, 'disabled', !avail || c === null);
    setText(r.buy, c === null ? 'Max' : 'Buy');
    setText(r.lockHint, avail ? '' : s.run.hardship === 'claustral_founding' && id === 'royal_feeding' ? 'Not allowed in this Hardship.' : '');
    // C105 bulk buying: ×10 with its total cost (green affordable, red not) and Max (n) = every level affordable now.
    const bulk = adaptBulk(s, id);
    const c10 = bulk.c10;
    const showBulk = avail && c !== null && (L > 0 || bulk.n >= 2);
    show(r.bulkRow, showBulk);
    show(r.buy10, c10 !== null);
    show(r.cost10, c10 !== null);
    if (showBulk && c10 !== null) {
      setCost(r.cost10, c10, s);
      const col = bulk.ok10 ? 'var(--good)' : 'var(--danger)';
      for (const part of Array.from(r.cost10.children)) part.style.color = col;
      r.cost10.title = (bulk.ok10 ? 'Affordable: ' : 'Not affordable yet: ') + 'total for 10 levels';
    }
    setProp(r.buy10, 'disabled', !bulk.ok10);
    r.buy10.title = c10 ? 'Buy 10 levels' : '';
    setText(r.buyMax, 'Max (' + fmtCount(bulk.n) + ')');
    setProp(r.buyMax, 'disabled', !(bulk.n > 0));
    r.buyMax.title = bulk.n > 0 ? 'Buy ' + fmtCount(bulk.n) + ' level' + (bulk.n === 1 ? '' : 's') + ': everything you can afford now' : 'Not even one level is affordable';
    toggleClass(row, 'glow', ui.getUI().glow === 'adapt:' + id);
  }

  return {
    update(s) {
      if (!s || !s.run) return;
      const aIds = shownAdaptations(s);
      show(adaptSec, aIds.length > 0);
      show(empty, aIds.length === 0);
      syncList(adaptList, aIds, (id) => id, createAdaptRow, (row, id) => updateAdaptRow(row, id, s));
      autoBox.update(s);
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
