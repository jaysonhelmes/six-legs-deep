// Achievements panel: the Quest book bookmark (C283, replacing Next Goals: the tracked quest and a button that opens
// the book over the stage), the full list by category with progress, and
// secret placeholders. C145: every goal and card names its requirement ("Wellspring — Dig down to row 74.") and a
// "Recently earned" list (the last 8 by earn time, meta.achievements[id] = simTime) heads the panel. Owner: WP9. Contract: ARCHITECTURE §14.5 (Achievements row), §8.5; DESIGN §19, §25.6 rule 9.
// Queries: achievements.progress; quests.questBook (which uses achievements.nextGoals for its fill-in quests).

import { h, setText, show, toggleClass, syncList } from '../dom.js';
import { fmt, fmtCount, fmtMult, fmtTime } from '../format.js';
import { nameOf } from '../text.js';
import { num, obj } from '../reveal.js';
import { progress as achProgress } from '../../systems/achievements.js';
import { questBook } from '../quests.js';
import { trackedQuest } from '../questbook.js';
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

/** Entries in the "Recently earned" list. */
export const RECENT_MAX = 8;

/**
 * Requirement text of an achievement (its data desc), or the secret placeholder while a secret one is unearned.
 * @param {string} id
 * @param {boolean} [earned]
 * @returns {string}
 */
export function achRequirement(id, earned = true) {
  if (isSecret(id) && !earned) return 'A secret achievement.';
  return obj(ACHIEVEMENTS[id]).desc || '';
}

/**
 * "Name — requirement" line used by Next Goals and the recent list.
 * @param {string} id
 * @returns {string}
 */
export function goalLabel(id) {
  const req = achRequirement(id, false).replace(/.$/, '');
  return nameOf('achievement', id) + (req ? ' — ' + req : '');
}

/**
 * The most recently earned achievements, newest first: [{ id, at, ago }] (at = meta.simTime when earned, ago = seconds
 * of play since). Ties keep display order.
 * @param {Object} s
 * @param {number} [max]
 * @returns {{ id: string, at: number, ago: number }[]}
 */
export function recentAchievements(s, max = RECENT_MAX) {
  const ach = obj(s && s.meta && s.meta.achievements);
  const now = num(s && s.meta && s.meta.simTime);
  const order = ACH_ORDER.length ? ACH_ORDER : Object.keys(ach);
  const list = Object.keys(ach).filter((id) => Number.isFinite(Number(ach[id])))
    .map((id) => ({ id, at: Number(ach[id]), i: order.indexOf(id) }));
  list.sort((a, b) => b.at - a.at || a.i - b.i);
  return list.slice(0, Math.max(0, max)).map((e) => ({ id: e.id, at: e.at, ago: Math.max(0, now - e.at) }));
}

/**
 * Relative time of play since an achievement was earned ("just now", "5 min ago", "2 h 10 min ago").
 * @param {number} ago seconds
 * @returns {string}
 */
export function agoText(ago) {
  const a = num(ago);
  if (a < 60) return 'just now';
  if (a < 3600) return Math.floor(a / 60) + ' min ago';
  if (a < 86400) return Math.floor(a / 3600) + ' h ' + Math.floor((a % 3600) / 60) + ' min ago';
  return fmtTime(a) + ' ago';
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
export function createPanel(root, { game, questBook: book = null }) {
  const el = h('div', { class: 'panel panel-achievements' });
  root.appendChild(el);
  let cat = 'all';
  let tick = 0;

  const countEl = h('span', { class: 'big-num' });
  const bonusEl = h('span', { class: 'muted' });
  const recentList = h('div', { class: 'list ach-recent' });
  const recentSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Recently earned' }), recentList);
  // C283: the Quest book bookmark replaces Next goals (the book itself opens over the map and nest)
  const qbMeta = h('span', { class: 'sec-meta' });
  const qbTitle = h('span', { class: 'row-title' });
  const qbBar = progressBar('bar-goal');
  const qbNote = h('p', { class: 'note' });
  const qbOpen = h('button', { type: 'button', class: 'btn btn-primary', text: 'Open the Quest book',
    on: { click: () => { if (book) book.open(); } } });
  qbOpen.disabled = !book;
  const qbSec = h('section', { class: 'sec sec-questbook' }, h('h3', { class: 'sec-title' }, 'Quest book ', qbMeta),
    h('div', { class: 'qb-bookmark' }, qbTitle, qbBar.el, qbNote, h('div', { class: 'btn-row' }, qbOpen)));
  const filterRow = h('div', { class: 'seg seg-small seg-scroll', role: 'radiogroup', 'aria-label': 'Category' });
  const mk = (id, label) => h('button', { type: 'button', class: 'seg-btn' + (id === cat ? ' selected' : ''), dataset: { c: id }, text: label,
    on: { click: () => { cat = id; tick = 0; for (const b of Array.from(filterRow.children)) toggleClass(b, 'selected', b.dataset.c === id); } } });
  filterRow.appendChild(mk('all', 'All'));
  for (const c of ACH_CATS) filterRow.appendChild(mk(c, CAT_NAMES[c]));
  const list = h('div', { class: 'list ach-list' });
  const empty = note('Achievement data not loaded yet.');
  el.append(h('div', { class: 'row-between balance' }, h('span', null, countEl, ' earned'), bonusEl), recentSec,
    qbSec,
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'All achievements' }), filterRow, list, empty));

  function createRecent() {
    const name = h('span', { class: 'ach-name' });
    const desc = h('span', { class: 'ach-desc' });
    const when = h('span', { class: 'muted ach-when' });
    const row = h('div', { class: 'ach-recent-row' }, h('span', { class: 'ach-mark', text: '★', attrs: { 'aria-hidden': 'true' } }),
      h('div', { class: 'ach-main' }, h('span', { class: 'row-between' }, name, when), desc));
    row.__r = { name, desc, when };
    return row;
  }

  function updateRecent(row, e) {
    const r = row.__r;
    setText(r.name, nameOf('achievement', e.id));
    setText(r.desc, achRequirement(e.id, true));
    setText(r.when, agoText(e.ago));
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
    setText(r.desc, achRequirement(id, earned));
    if (earned) r.desc.title = 'Earned ' + agoText(num(s.meta.simTime) - num(s.meta.achievements[id]));
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
      // C283: Quest book bookmark (the tracked quest, else the chapter's blurb)
      const bk = q(() => questBook(s, d), null);
      if (bk) {
        const tq = trackedQuest(bk);
        setText(qbMeta, (bk.stage.chapter || '') + ' · ' + (bk.stage.name || ''));
        const openN = bk.quests.filter((x) => !x.complete).length;
        setText(qbTitle, tq ? tq.title : fmtCount(openN) + ' quest' + (openN === 1 ? '' : 's') + ' for this stage');
        show(qbBar.el, !!tq);
        if (tq) qbBar.set(tq.frac, tq.progText);
        setText(qbNote, tq ? 'Tracked on the HUD. Open the book for its steps.' : bk.stage.blurb || '');
        if (qbSec.__fold) qbSec.__fold.setSummary(tq ? tq.title + ' · ' + Math.round(tq.frac * 100) + '%' : fmtCount(openN) + ' quests');
      }
      const recent = recentAchievements(s);
      show(recentSec, recent.length > 0);
      syncList(recentList, recent, (e) => e.id, createRecent, updateRecent);
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
