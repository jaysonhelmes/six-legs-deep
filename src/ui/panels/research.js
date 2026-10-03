// Research panel: tier grid by branch (columns = branches, rows = tiers), locked nodes greyed with their
// prerequisites, Innate helix badges with run counts, and branch refinements. Owner: WP9.
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
  let filter = 'all';

  const insightEl = h('span', { class: 'big-num' });
  const rateEl = h('span', { class: 'muted' });
  const filterRow = h('div', { class: 'seg seg-small seg-scroll', role: 'radiogroup', 'aria-label': 'Branch' });
  const mkFilter = (id, label) => h('button', { type: 'button', class: 'seg-btn' + (id === filter ? ' selected' : ''), dataset: { f: id }, text: label,
    on: { click: () => { filter = id; for (const b of Array.from(filterRow.children)) toggleClass(b, 'selected', b.dataset.f === id); lastLayout = ''; } } });
  filterRow.appendChild(mkFilter('all', 'All'));
  for (const b of branchIds()) filterRow.appendChild(mkFilter(b, nameOf('branch', b)));
  const grid = h('div', { class: 'tech-grid' });
  const gridWrap = h('div', { class: 'tech-scroll' }, grid);
  const empty = note('No research data loaded yet.');
  el.append(h('div', { class: 'row-between research-head' }, h('span', null, h('i', { class: 'ico ico-insight' }), ' ', insightEl, ' insight'), rateEl),
    filterRow, gridWrap, empty);

  const cols = {};
  let lastLayout = '';

  function buildColumns() {
    clear(grid);
    for (const k of Object.keys(cols)) delete cols[k];
    const branches = filter === 'all' ? branchIds() : [filter];
    toggleClass(grid, 'single', branches.length === 1);
    for (const b of branches) {
      const main = BRANCHES[b] && BRANCHES[b].main;
      const list = h('div', { class: 'tech-col-list' });
      const refine = h('div', { class: 'tech-node refine' });
      const refName = h('span', { class: 'tech-name' });
      const refCost = h('span', { class: 'cost' });
      refine.append(refName, h('span', { class: 'tech-desc', text: fmtMult(num(REFINEMENT && REFINEMENT.mult, 1.1)) + ' ' + (MAIN_LABELS[main] || 'branch output') + ' per level' }), refCost);
      refine.addEventListener('click', (ev) => act('buyRefinement', { branch: b }, ev, refine));
      const col = h('div', { class: 'tech-col' }, h('h4', { class: 'tech-col-head' }, nameOf('branch', b),
        h('span', { class: 'tech-col-main', text: MAIN_LABELS[main] || '' })), list, refine);
      cols[b] = { list, refine, refName, refCost };
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
      const layout = filter;
      if (layout !== lastLayout) {
        lastLayout = layout;
        buildColumns();
      }
      for (const b of Object.keys(cols)) {
        const c = cols[b];
        syncList(c.list, nodesOf(b), (id) => id, createNode, (node, id) => updateNode(node, id, s));
        const complete = q(() => branchComplete(s, b), false);
        show(c.refine, complete);
        if (complete) {
          const L = num(obj(s.run.refinements)[b]);
          setText(c.refName, nameOf('research', b + '_refinement') + ' L' + fmtCount(L));
          const ok = setCost(c.refCost, q(() => refinementCost(s, b), null), s);
          toggleClass(c.refine, 'cant', !ok);
        }
      }
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
