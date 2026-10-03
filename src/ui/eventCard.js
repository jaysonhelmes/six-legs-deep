// Non-modal event card (top centre): title, copy, 30 s timer bar, choice buttons with the default marked "*" →
// actions.eventChoice. Owner: WP9. Contract: ARCHITECTURE §14.6, §4.1 EventCard, §9 eventChoice; DESIGN §18.1–§18.2.

import { h, setText, toggleClass, setBar, clear } from './dom.js';
import { fmtTime } from './format.js';
import { nameOf, EVENT_COPY, CHOICE_LABELS, CHOICE_TIPS, humanize, reasonText } from './text.js';
import { num, arr, obj } from './reveal.js';
import { EVENTS, EVENT_RULES } from '../data/events.js';
import { pointOf } from './panels/common.js';

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
  const timerFill = h('span', { class: 'ec-timer-fill' });
  const timerText = h('span', { class: 'ec-timer-text' });
  const timer = h('div', { class: 'ec-timer', role: 'timer' }, timerFill, timerText);
  const choices = h('div', { class: 'ec-choices' });
  const msg = h('p', { class: 'ec-msg' });
  const card = h('div', { class: 'ec-card', role: 'dialog', 'aria-live': 'assertive', 'aria-label': 'Event' }, title, copy, timer, choices, msg);
  if (el) {
    el.appendChild(card);
    el.hidden = true;
  }

  function build(c) {
    shownUid = c.uid;
    setText(title, nameOf('event', c.id));
    setText(copy, EVENT_COPY[c.id] || '');
    setText(msg, '');
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

