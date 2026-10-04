// Non-modal event card (top centre): title, copy, 30 s timer bar, choice buttons with the default marked "*" →
// actions.eventChoice. Owner: WP9. Contract: ARCHITECTURE §14.6, §4.1 EventCard, §9 eventChoice; DESIGN §18.1–§18.2.
// C114: the Army Ant Column card also shows the column, your garrison and the closed-form odds (events.armyColumnPreview),
// refreshed twice a second while it is open.

import { h, setText, toggleClass, setBar, clear } from './dom.js';
import { fmtTime, fmtCount, fmt } from './format.js';
import { nameOf, EVENT_COPY, CHOICE_LABELS, CHOICE_TIPS, humanize, reasonText } from './text.js';
import { num, arr, obj } from './reveal.js';
import { EVENTS, EVENT_RULES } from '../data/events.js';
import { pointOf } from './panels/common.js';
import { armyColumnPreview } from '../systems/events.js';

/** Event ids whose card carries a live battle-odds line (C114). */
const INTEL = Object.freeze({ ev_army_ant_column: armyColumnPreview });

/** Win chance as a short percentage: "<1%" / ">99%" at the extremes instead of a misleading 0 % / 100 %. */
export function oddsText(win) {
  const w = Math.max(0, Math.min(1, Number.isFinite(win) ? win : 0));
  if (w > 0 && w < 0.01) return '<1%';
  if (w < 1 && w > 0.99) return '>99%';
  return Math.round(w * 100) + '%';
}

/**
 * The Army Ant Column card's intel line from events.armyColumnPreview (C114):
 * "Column: ~4.30K army ants (AP 43.0K) · Your defenders: 120 soldiers, 3 supermajors · AP 18.2K · Est. victory 23%".
 * @param {ReturnType<typeof armyColumnPreview>|null} pv
 * @returns {string}
 */
export function armyColumnText(pv) {
  if (!pv) return '';
  const so = Math.floor(Number(pv.soldier) || 0);
  const su = Math.floor(Number(pv.supermajor) || 0);
  const column = 'Column: ~' + fmtCount(Number(pv.foe && pv.foe.n) || 0) + ' army ants (AP ' + fmt(Number(pv.foeAP) || 0) + ')';
  if (so + su <= 0) return column + ' · Your defenders: none at home, so you cannot fight.';
  const parts = [];
  if (so > 0) parts.push(fmtCount(so) + ' soldier' + (so === 1 ? '' : 's'));
  if (su > 0) parts.push(fmtCount(su) + ' supermajor' + (su === 1 ? '' : 's'));
  let line = column + ' · Your defenders: ' + parts.join(', ') + ' (AP ' + fmt(Number(pv.yourAP) || 0) + ') · Est. victory ' + oddsText(pv.win);
  const lo = Number(pv.lossesLo) || 0;
  const hi = Number(pv.lossesHi) || 0;
  if (hi > 0) line += ' · losses ~' + (Math.round(lo) === Math.round(hi) ? fmtCount(hi) : fmtCount(lo) + '–' + fmtCount(hi));
  return line;
}

/**
 * Default choice of an event card: the data `def` choice, else null.
 * @param {string} eventId
 * @returns {string|null}
 */
export function defaultChoice(eventId) {
  const ev = EVENTS[eventId];
  const def = arr(ev && ev.choices).find((c) => c && c.def);
  return def ? def.id : null;
}

/**
 * Event card controller on the #event-card element.
 * @param {HTMLElement} el
 * @param {{ game: Object, bridge: Object }} ctx
 */
export function createEventCard(el, { game, bridge }) {
  let shownUid = null;
  const title = h('h2', { class: 'ec-title' });
  const copy = h('p', { class: 'ec-copy' });
  const intel = h('p', { class: 'ec-intel', role: 'status' });
  let intelAt = -Infinity;
  const timerFill = h('span', { class: 'ec-timer-fill' });
  const timerText = h('span', { class: 'ec-timer-text' });
  const timer = h('div', { class: 'ec-timer', role: 'timer' }, timerFill, timerText);
  const choices = h('div', { class: 'ec-choices' });
  const msg = h('p', { class: 'ec-msg' });
  const card = h('div', { class: 'ec-card', role: 'dialog', 'aria-live': 'assertive', 'aria-label': 'Event' }, title, copy, intel, timer, choices, msg);
  if (el) {
    el.appendChild(card);
    el.hidden = true;
  }

  function build(c) {
    shownUid = c.uid;
    setText(title, nameOf('event', c.id));
    setText(copy, EVENT_COPY[c.id] || '');
    setText(msg, '');
    intel.hidden = !INTEL[c.id];
    setText(intel, '');
    intelAt = -Infinity;
    clear(choices);
    const def = defaultChoice(c.id);
    const list = arr(c.choices).length ? arr(c.choices) : arr(EVENTS[c.id] && EVENTS[c.id].choices).map((x) => x && x.id).filter(Boolean);
    for (const ch of list) {
      const isDef = ch === def;
      const tip = obj(CHOICE_TIPS[c.id])[ch] || '';
      const b = h('button', {
        type: 'button', class: 'btn ' + (isDef ? 'btn-default' : 'btn-primary'), dataset: { choice: ch, tip: tip || null },
        on: { click: (ev) => {
          const res = game.actions.do('eventChoice', { uid: c.uid, choice: ch });
          if (!res.ok) {
            setText(msg, reasonText(res.reason, 'eventChoice'));
            const p = pointOf(ev, b);
            if (bridge && bridge.reject) bridge.reject(res.reason, p.x, p.y, 'eventChoice');
          } else {
            setText(msg, '');
            toggleClass(card, 'resolving', true);
          }
        } },
      }, (CHOICE_LABELS[ch] || humanize(ch)) + (isDef ? ' *' : ''));
      if (tip) b.appendChild(h('span', { class: 'ec-choice-tip', text: tip }));
      choices.appendChild(b);
    }
    toggleClass(card, 'resolving', false);
    if (def) choices.appendChild(h('span', { class: 'ec-def-note', text: '* happens if you do not choose.' }));
  }

  return {
    update(s) {
      const c = s && s.run && s.run.events ? s.run.events.card : null;
      if (!c) {
        if (shownUid !== null) {
          shownUid = null;
          if (el) el.hidden = true;
        }
        return;
      }
      if (c.uid !== shownUid) build(c);
      if (el) el.hidden = false;
      const intelFn = INTEL[c.id];
      const tNow = Number(s.run.time) || 0;
      if (intelFn && (tNow - intelAt >= 0.5 || tNow < intelAt)) { // C114: live odds, at most twice per game second
        intelAt = tNow;
        let pv = null;
        try { pv = intelFn(s, game.d); } catch { pv = null; }
        setText(intel, armyColumnText(pv));
      }
      const total = num(EVENT_RULES && EVENT_RULES.cardSec, 30);
      const left = Math.max(0, num(c.t));
      setBar(timerFill, total > 0 ? left / total : 0);
      setText(timerText, fmtTime(left));
      toggleClass(timer, 'urgent', left <= 5);
    },
    /** True while a card is showing. */
    isOpen() {
      return shownUid !== null;
    },
    destroy() {
      if (card.parentNode) card.parentNode.removeChild(card);
    },
  };
}

