// Achievements panel: Next Goals (the 3 closest, with progress bars), the full list by category with progress, and
// secret placeholders. Owner: WP9. Contract: ARCHITECTURE §14.5 (Achievements row), §8.5; DESIGN §19, §25.6 rule 9.
// Queries: achievements.progress / nextGoals (falls back to d.progress.goals).

import { h, setText, show, toggleClass, syncList } from '../dom.js';
import { fmt, fmtCount, fmtMult } from '../format.js';
import { nameOf } from '../text.js';
import { num, arr, obj } from '../reveal.js';
import { progress as achProgress, nextGoals } from '../../systems/achievements.js';
import { ACH_ORDER, ACHIEVEMENTS } from '../../data/achievements.js';
import { note, progressBar } from './common.js';

/** Category order and labels (ARCHITECTURE §6.6). */
export const ACH_CATS = Object.freeze(['population', 'food', 'excavation', 'chambers', 'surface', 'combat', 'seasons', 'prestige', 'secret', 'guide']);
const CAT_NAMES = { population: 'Population', food: 'Food', excavation: 'Excavation', chambers: 'Chambers', surface: 'Surface', combat: 'Combat',
  seasons: 'Seasons', prestige: 'Prestige', secret: 'Secret', guide: 'Field Guide' };

/** Safe query. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Is this achievement hidden until earned? */
export function isSecret(id) {
  const a = ACHIEVEMENTS[id];
  return !!(a && (a.secret === true || a.cat === 'secret'));
}

/**
 * Achievements panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createPanel(root, { game }) {
  const el = h('div', { class: 'panel panel-achievements' });
  root.appendChild(el);
  let cat = 'all';
  let tick = 0;

  const countEl = h('span', { class: 'big-num' });
  const bonusEl = h('span', { class: 'muted' });
  const goalsList = h('div', { class: 'list goals' });
  const goalsEmpty = note('Keep playing to see your next goals.');
  const filterRow = h('div', { class: 'seg seg-small seg-scroll', role: 'radiogroup', 'aria-label': 'Category' });
  const mk = (id, label) => h('button', { type: 'button', class: 'seg-btn' + (id === cat ? ' selected' : ''), dataset: { c: id }, text: label,
    on: { click: () => { cat = id; tick = 0; for (const b of Array.from(filterRow.children)) toggleClass(b, 'selected', b.dataset.c === id); } } });
  filterRow.appendChild(mk('all', 'All'));
  for (const c of ACH_CATS) filterRow.appendChild(mk(c, CAT_NAMES[c]));
  const list = h('div', { class: 'list ach-list' });
  const empty = note('Achievement data not loaded yet.');
  el.append(h('div', { class: 'row-between balance' }, h('span', null, countEl, ' earned'), bonusEl),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Next goals' }), goalsList, goalsEmpty),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'All achievements' }), filterRow, list, empty));

  function createGoal(g) {
    const name = h('span', { class: 'row-title' });
    const bar = progressBar('bar-goal');
    const row = h('div', { class: 'goal-row' }, name, bar.el);
    row.__r = { name, bar };
    return row;
  }

  function updateGoal(row, g) {
    const r = row.__r;
    setText(r.name, nameOf('achievement', g.id));
    const target = num(g.target);
    const cur = num(g.cur);
    r.bar.set(target > 0 ? cur / target : 0, fmt(cur) + ' / ' + fmt(target));
  }

  function createAch(id) {
    const name = h('span', { class: 'ach-name' });
    const desc = h('span', { class: 'ach-desc' });
    const reward = h('span', { class: 'ach-reward' });
    const bar = progressBar('bar-thin');
    const mark = h('span', { class: 'ach-mark', attrs: { 'aria-hidden': 'true' } });
    const row = h('div', { class: 'ach-row', dataset: { id } }, mark, h('div', { class: 'ach-main' }, name, desc, reward, bar.el));
    row.__r = { name, desc, reward, bar, mark };
    return row;
  }

  function updateAch(row, id, s, d) {
    const r = row.__r;
    const a = obj(ACHIEVEMENTS[id]);
    const earned = obj(s.meta.achievements)[id] !== undefined;
    const secret = isSecret(id) && !earned;
    toggleClass(row, 'earned', earned);
    toggleClass(row, 'secret', secret);
    setText(r.mark, earned ? '★' : '☆');
    setText(r.name, secret ? '???' : nameOf('achievement', id));
    setText(r.desc, secret ? 'A secret achievement.' : a.desc || '');
    const rw = a.reward && a.reward.text ? a.reward.text : '';
    setText(r.reward, rw && !secret ? 'Reward: ' + rw : '');
    show(r.reward, !!rw && !secret);
    if (earned || secret) {
      show(r.bar.el, false);
      return;
    }
    const p = q(() => achProgress(s, d, id), null);
    const hasP = p && num(p.target) > 0;
    show(r.bar.el, !!hasP);
    if (hasP) r.bar.set(num(p.cur) / num(p.target), fmt(num(p.cur)) + ' / ' + fmt(num(p.target)));
  }

  return {
    update(s, d) {
      if (!s || !s.meta) return;
      const earned = Object.keys(obj(s.meta.achievements)).length;
      const total = ACH_ORDER.length;
      setText(countEl, fmtCount(earned) + (total ? ' / ' + fmtCount(total) : ''));
      setText(bonusEl, 'Production ' + fmtMult(num(d && d.meta && d.meta.achMult, 1)));
      let goals = q(() => nextGoals(s, d, 3), null);
      if (!Array.isArray(goals) || goals.length === 0) goals = arr(d && d.progress && d.progress.goals);
      goals = goals.filter((g) => g && g.id).slice(0, 3);
      syncList(goalsList, goals, (g) => g.id, createGoal, updateGoal);
      show(goalsEmpty, goals.length === 0);
      show(empty, total === 0);
      if (tick++ % 4 !== 0) return; // the full list refreshes at 1 Hz
      const ids = ACH_ORDER.filter((id) => cat === 'all' || obj(ACHIEVEMENTS[id]).cat === cat);
      syncList(list, ids, (id) => id, createAch, (row, id) => updateAch(row, id, s, d));
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
