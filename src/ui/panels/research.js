// Research panel: tier grid by branch (columns = branches, rows = tiers), locked nodes greyed with their
// prerequisites, Innate helix badges with run counts, and branch refinements. "Hide completed" (C116) drops owned nodes
// from the grid (remembered per browser) and leaves a "N completed hidden" note per branch. C144: one branch at a
// time (no "All" view); the first visit opens the first branch with something available, later visits the branch last
// viewed (remembered per browser); each branch button counts its available nodes. Owner: WP9.
// Contract: ARCHITECTURE §14.5 (Research row), §8.4; DESIGN §11. Queries: research.isAvailable / isOwned / cost /
// refinementCost / branchComplete.

import { h, setText, show, toggleClass, syncList, setCost, clear } from '../dom.js';
import { fmt, fmtRate, fmtCount, fmtMult } from '../format.js';
import { nameOf, RESEARCH_TIPS } from '../text.js';
import { traitLevel, num, arr, obj } from '../reveal.js';
import { isAvailable, isOwned, cost as researchCost, refinementCost, branchComplete } from '../../systems/research.js';
import { BRANCH_ORDER, BRANCHES, RESEARCH_ORDER, RESEARCH, REFINEMENT, INNATE } from '../../data/research.js';
import { makeAct, note } from './common.js';

const BRANCH_FALLBACK = ['foraging', 'excavation', 'brood', 'husbandry', 'warfare', 'communication'];
const MAIN_LABELS = { forage: 'forager output', dig: 'dig work', lay: 'lay rate', 'honeydew+fungus': 'honeydew and fungus', ap: 'army power', insight: 'insight' };

/** Safe query. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Branch ids in display order. */
function branchIds() {
  return BRANCH_ORDER.length ? BRANCH_ORDER : BRANCH_FALLBACK;
}

/**
 * Research nodes of a branch, ordered by tier then RESEARCH_ORDER position.
 * @param {string} branch
 * @returns {string[]}
 */
export function nodesOf(branch) {
  const ids = RESEARCH_ORDER.filter((id) => RESEARCH[id] && RESEARCH[id].branch === branch);
  return ids.sort((a, b) => num(RESEARCH[a].tier) - num(RESEARCH[b].tier) || RESEARCH_ORDER.indexOf(a) - RESEARCH_ORDER.indexOf(b));
}

/** localStorage key of the "Hide completed" research toggle (a per-browser UI convenience, outside the save; C116). */
export const HIDE_OWNED_KEY = 'sld.research.hideOwned';

/** The browser's localStorage, or null when unavailable / blocked. */
function browserStore() {
  try {
    return typeof window !== 'undefined' && window && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Remembered "Hide completed" choice (false when storage is missing, blocked or holds anything else).
 * @param {{ getItem: Function }|null} [store]
 * @returns {boolean}
 */
export function loadHideOwned(store = browserStore()) {
  try {
    return !!store && store.getItem(HIDE_OWNED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Remember the "Hide completed" choice; storage failures keep it for this session only.
 * @param {boolean} on
 * @param {{ setItem: Function }|null} [store]
 */
export function saveHideOwned(on, store = browserStore()) {
  try {
    if (store) store.setItem(HIDE_OWNED_KEY, on ? '1' : '0');
  } catch { /* storage blocked: this session only */ }
}

/**
 * The nodes of a branch to show, and how many owned ones were left out.
 * @param {string[]} ids nodesOf(branch)
 * @param {(id: string) => boolean} ownedFn
 * @param {boolean} hideOwned
 * @returns {{ ids: string[], hidden: number }}
 */
export function visibleNodes(ids, ownedFn, hideOwned) {
  if (!hideOwned) return { ids, hidden: 0 };
  const out = ids.filter((id) => !ownedFn(id));
  return { ids: out, hidden: ids.length - out.length };
}

/** localStorage key of the last research branch viewed (per-browser UI convenience, C144). */
export const BRANCH_KEY = 'sld.research.branch';

/**
 * Remembered branch id, or null (nothing stored, storage blocked, or not a branch).
 * @param {{ getItem: Function }|null} [store]
 * @returns {string|null}
 */
export function loadBranch(store = browserStore()) {
  try {
    const v = store ? store.getItem(BRANCH_KEY) : null;
    return typeof v === 'string' && branchIds().includes(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Remember the branch viewed; storage failures keep it for this session only.
 * @param {string} id
 * @param {{ setItem: Function }|null} [store]
 */
export function saveBranch(id, store = browserStore()) {
  try {
    if (store && branchIds().includes(id)) store.setItem(BRANCH_KEY, id);
  } catch { /* storage blocked: this session only */ }
}

/** Branch ids the filter row offers (one view per branch; there is no "All" view, C144). */
export function branchFilters() {
  return branchIds().slice();
}

/**
 * Branch to open: the remembered one when valid, else the first branch with an available (buyable now or later
 * affordable) node, else the first branch.
 * @param {Object} s
 * @param {string|null} remembered
 * @param {(s: Object, id: string) => boolean} [availFn] research.isAvailable
 * @returns {string}
 */
export function defaultBranch(s, remembered, availFn = isAvailable) {
  const ids = branchIds();
  if (remembered && ids.includes(remembered)) return remembered;
  for (const b of ids) if (nodesOf(b).some((id) => q(() => availFn(s, id), false))) return b;
  return ids[0];
}

/** Runs needed for a node to become Innate (3, or 2 with ancestral_memory). */
function innateRuns(s) {
  const base = num(INNATE && INNATE.runs, 3);
  const anc = num(INNATE && INNATE.runsAncestral, 2);
  return traitLevel(s, 'ancestral_memory') > 0 ? anc : base;
}

/**
 * Research panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createPanel(root, { game, ui, bridge }) {
  const act = makeAct(game, bridge);
  const el = h('div', { class: 'panel panel-research' });
  root.appendChild(el);
  let filter = null;           // resolved on the first update (defaultBranch)
  let hideOwned = loadHideOwned();
  let lastGlow = null;

  const insightEl = h('span', { class: 'big-num' });
  const rateEl = h('span', { class: 'muted' });
  const filterRow = h('div', { class: 'seg seg-small seg-scroll', role: 'radiogroup', 'aria-label': 'Branch' });
  const filterCount = {};
  const selectBranch = (id, remember) => {
    filter = id;
    for (const b of Array.from(filterRow.children)) toggleClass(b, 'selected', b.dataset.f === id);
    if (remember) saveBranch(id);
  };
  const mkFilter = (id, label) => {
    filterCount[id] = h('span', { class: 'seg-count' });
    return h('button', { type: 'button', class: 'seg-btn', dataset: { f: id }, on: { click: () => selectBranch(id, true) } }, label, filterCount[id]);
  };
  for (const b of branchFilters()) filterRow.appendChild(mkFilter(b, nameOf('branch', b)));
  const hideBox = h('input', { type: 'checkbox', class: 'check' });
  hideBox.checked = hideOwned;
  hideBox.addEventListener('change', () => { hideOwned = !!hideBox.checked; saveHideOwned(hideOwned); });
  const hiddenTotal = h('span', { class: 'muted hide-owned-count' });
  const hideRow = h('label', { class: 'toggle-row hide-owned', dataset: { tip: 'Hide research you already own. Locked nodes still name the prerequisites they are missing.' } },
    hideBox, h('span', { text: 'Hide completed' }), hiddenTotal);
  const grid = h('div', { class: 'tech-grid' });
  const gridWrap = h('div', { class: 'tech-scroll' }, grid);
  const empty = note('No research data loaded yet.');
  el.append(h('div', { class: 'row-between research-head' }, h('span', null, h('i', { class: 'ico ico-insight' }), ' ', insightEl, ' insight'), rateEl),
    filterRow, hideRow, gridWrap, empty);

  const cols = {};
  let lastLayout = '';

  function buildColumns() {
    clear(grid);
    for (const k of Object.keys(cols)) delete cols[k];
    const branches = [filter];
    toggleClass(grid, 'single', true);
    for (const b of branches) {
      const main = BRANCHES[b] && BRANCHES[b].main;
      const list = h('div', { class: 'tech-col-list' });
      const hiddenNote = h('p', { class: 'tech-hidden-note' });
      const refine = h('div', { class: 'tech-node refine' });
      const refName = h('span', { class: 'tech-name' });
      const refCost = h('span', { class: 'cost' });
      refine.append(refName, h('span', { class: 'tech-desc', text: fmtMult(num(REFINEMENT && REFINEMENT.mult, 1.1)) + ' ' + (MAIN_LABELS[main] || 'branch output') + ' per level' }), refCost);
      refine.addEventListener('click', (ev) => act('buyRefinement', { branch: b }, ev, refine));
      const col = h('div', { class: 'tech-col' }, h('h4', { class: 'tech-col-head' }, nameOf('branch', b),
        h('span', { class: 'tech-col-main', text: MAIN_LABELS[main] || '' })), hiddenNote, list, refine);
      cols[b] = { list, refine, refName, refCost, hiddenNote };
      grid.appendChild(col);
    }
  }

  function createNode(id) {
    const name = h('span', { class: 'tech-name', text: nameOf('research', id) });
    const desc = h('span', { class: 'tech-desc', text: RESEARCH_TIPS[id] || '' });
    const costEl = h('span', { class: 'cost' });
    const helix = h('span', { class: 'helix', attrs: { 'aria-label': 'Innate' }, title: 'Innate: granted free every run' });
    const runs = h('span', { class: 'runs' });
    const pre = h('span', { class: 'tech-pre' });
    const node = h('button', { type: 'button', class: 'tech-node', dataset: { id, tip: RESEARCH_TIPS[id] || '' } }, h('span', { class: 'tech-top' }, name, helix), desc, pre,
      h('span', { class: 'tech-foot' }, costEl, runs));
    node.addEventListener('click', (ev) => {
      if (q(() => isOwned(game.s, id), false)) return;
      act('buyResearch', { id }, ev, node);
    });
    node.__r = { costEl, helix, runs, pre };
    return node;
  }

  function updateNode(node, id, s) {
    const r = node.__r;
    const owned = q(() => isOwned(s, id), !!obj(s.run.research)[id]);
    const avail = !owned && q(() => isAvailable(s, id), false);
    const innate = !!obj(s.era && s.era.innate)[id];
    toggleClass(node, 'owned', owned);
    toggleClass(node, 'available', avail);
    toggleClass(node, 'locked', !owned && !avail);
    show(r.helix, innate);
    if (owned) {
      if (r.mode !== 'owned') {
        r.mode = 'owned';
        clear(r.costEl);
        r.costEl.__cost = null;
        r.costEl.__t = undefined;
        setText(r.costEl, 'Owned');
      }
    } else {
      if (r.mode === 'owned') {
        clear(r.costEl);
        r.costEl.__t = undefined;
      }
      r.mode = 'cost';
      const ok = setCost(r.costEl, q(() => researchCost(s, id), null), s);
      toggleClass(node, 'cant', avail && !ok);
    }
    const need = innateRuns(s);
    const n = num(obj(s.era && s.era.researchRuns)[id]);
    show(r.runs, !innate && n > 0);
    setText(r.runs, n > 0 ? fmtCount(n) + '/' + need + ' runs' : '');
    const prereq = arr(RESEARCH[id] && RESEARCH[id].prereq).filter((p) => !q(() => isOwned(s, p), false));
    setText(r.pre, !owned && !avail && prereq.length ? 'Needs ' + prereq.map((p) => nameOf('research', p)).join(', ') : '');
    node.setAttribute('aria-disabled', owned || !avail ? 'true' : 'false');
    toggleClass(node, 'glow', ui.getUI().glow === 'research:' + id);
  }

  return {
    update(s, d) {
      if (!s || !s.run) return;
      setText(insightEl, fmt(num(s.run.res.insight)));
      setText(rateEl, fmtRate(num(d && d.rates && d.rates.insight && d.rates.insight.net)));
      const hasData = RESEARCH_ORDER.length > 0;
      show(empty, !hasData);
      show(gridWrap, hasData);
      if (!hasData) return;
      if (!filter) selectBranch(defaultBranch(s, loadBranch()), false);
      // an onboarding glow on a node of another branch opens that branch (once per glow)
      const glow = ui.getUI().glow;
      if (glow !== lastGlow) {
        lastGlow = glow;
        const gid = typeof glow === 'string' && glow.startsWith('research:') ? glow.slice(9) : null;
        const gb = gid && RESEARCH[gid] ? RESEARCH[gid].branch : null;
        if (gb && gb !== filter && branchIds().includes(gb)) selectBranch(gb, false);
      }
      for (const b of branchIds()) {
        const n = nodesOf(b).filter((id) => q(() => isAvailable(s, id), false)).length;
        setText(filterCount[b], n > 0 ? ' ' + fmtCount(n) : '');
        filterCount[b].title = n > 0 ? fmtCount(n) + ' available' : '';
      }
      const layout = filter;
      if (layout !== lastLayout) {
        lastLayout = layout;
        buildColumns();
      }
      let hiddenSum = 0;
      for (const b of Object.keys(cols)) {
        const c = cols[b];
        const vis = visibleNodes(nodesOf(b), (id) => q(() => isOwned(s, id), !!obj(s.run.research)[id]), hideOwned);
        hiddenSum += vis.hidden;
        show(c.hiddenNote, vis.hidden > 0);
        setText(c.hiddenNote, vis.hidden > 0 ? fmtCount(vis.hidden) + ' completed hidden' : '');
        syncList(c.list, vis.ids, (id) => id, createNode, (node, id) => updateNode(node, id, s));
        const complete = q(() => branchComplete(s, b), false);
        show(c.refine, complete);
        if (complete) {
          const L = num(obj(s.run.refinements)[b]);
          setText(c.refName, nameOf('research', b + '_refinement') + ' L' + fmtCount(L));
          const ok = setCost(c.refCost, q(() => refinementCost(s, b), null), s);
          toggleClass(c.refine, 'cant', !ok);
        }
      }
      if (hideBox.checked !== hideOwned) hideBox.checked = hideOwned;
      setText(hiddenTotal, hideOwned && hiddenSum > 0 ? '(' + fmtCount(hiddenSum) + ' hidden)' : '');
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
