// Shared building blocks for the panels: the action helper (dispatch + reject feedback), sub-tab strips, slider rows,
// locked placeholders and small list helpers. Owner: WP9 (ARCHITECTURE §14.5). DOM-free at module level.

import { h, setText, setProp, show, toggleClass, setBar } from '../dom.js';
import { reasonText } from '../text.js';

/**
 * Screen point for feedback: the pointer position of a mouse event, else the centre-top of an element.
 * @param {Event|null} ev
 * @param {HTMLElement|null} [el]
 * @returns {{ x: number, y: number }}
 */
export function pointOf(ev, el = null) {
  if (ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY) && (ev.clientX !== 0 || ev.clientY !== 0)) {
    return { x: ev.clientX, y: ev.clientY };
  }
  const t = el || (ev && ev.target) || null;
  if (t && typeof t.getBoundingClientRect === 'function') {
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  }
  return { x: 0, y: 0 };
}

/**
 * Action helper bound to a game and bridge: act(type, args, ev?, el?) dispatches through game.actions.do and, when
 * refused, calls bridge.reject(reason, x, y, type) (the type picks command-specific copy). Returns the ActionResult.
 * @param {Object} game
 * @param {Object|null} bridge
 */
export function makeAct(game, bridge) {
  return function act(type, args = {}, ev = null, el = null) {
    let res;
    try {
      res = game.actions.do(type, args);
    } catch (err) {
      console.error('[ui] action failed', type, err);
      res = { ok: false, reason: 'invalid:exception' };
    }
    if (!res || !res.ok) {
      const p = pointOf(ev, el);
      if (bridge && typeof bridge.reject === 'function') bridge.reject(res ? res.reason : 'invalid', p.x, p.y, type);
    }
    return res || { ok: false, reason: 'invalid' };
  };
}

/**
 * Segmented sub-tab strip. update(activeId, visible: { id: boolean }, greyed?: { id: boolean }).
 * @param {Array<string>} ids
 * @param {Object<string, string>} labels
 * @param {(id: string) => void} onPick
 */
export function subTabStrip(ids, labels, onPick) {
  const el = h('div', { class: 'subtabs', role: 'tablist' });
  const btns = {};
  for (const id of ids) {
    const b = h('button', {
      type: 'button', class: 'subtab', role: 'tab', dataset: { sub: id }, text: labels[id] || id,
      on: { click: () => onPick(id) },
    });
    btns[id] = b;
    el.appendChild(b);
  }
  return {
    el,
    update(active, visible = {}, greyed = {}) {
      let any = 0;
      for (const id of ids) {
        const vis = visible[id] !== false;
        show(btns[id], vis);
        if (vis) any++;
        toggleClass(btns[id], 'active', id === active);
        toggleClass(btns[id], 'greyed', !!greyed[id]);
        btns[id].setAttribute('aria-selected', id === active ? 'true' : 'false');
      }
      show(el, any > 1);
    },
  };
}

/**
 * Labelled range slider row with a value readout. set(value, { max, disabled, text }).
 * @param {string} label
 * @param {{ min?: number, max?: number, step?: number, tip?: string }} opts
 * @param {(value: number) => void} onChange called on 'change' (release) and, when live, on 'input'
 * @param {{ live?: boolean }} [mode]
 */
export function sliderRow(label, { min = 0, max = 100, step = 1, tip = null } = {}, onChange, { live = false } = {}) {
  const input = h('input', { type: 'range', class: 'range', min, max, step, value: min, attrs: { 'aria-label': label } });
  const out = h('output', { class: 'range-out' });
  const el = h('label', { class: 'range-row', dataset: tip ? { tip } : null },
    h('span', { class: 'range-label', text: label }), input, out);
  const fire = () => onChange(Number(input.value));
  input.addEventListener('change', fire);
  if (live) input.addEventListener('input', fire);
  input.addEventListener('input', () => { if (el.__fmt) setText(out, el.__fmt(Number(input.value))); });
  return {
    el, input, out,
    /** Update value/max/readout without fighting a drag in progress. */
    set(value, { max: mx = null, disabled = false, text = null, fmt = null } = {}) {
      if (mx !== null) setProp(input, 'max', String(mx));
      setProp(input, 'disabled', !!disabled);
      if (fmt) el.__fmt = fmt;
      const dragging = globalThis.document && globalThis.document.activeElement === input;
      if (!dragging) setProp(input, 'value', String(value));
      setText(out, text !== null ? text : el.__fmt ? el.__fmt(dragging ? Number(input.value) : value) : String(value));
    },
  };
}

/**
 * Locked placeholder line: "🔒 Name — condition".
 * @param {string} name
 * @param {string} hint
 */
export function lockedLine(name, hint) {
  return h('div', { class: 'locked-line' }, h('i', { class: 'ico ico-lock', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'locked-name', text: name }), h('span', { class: 'locked-hint', text: hint }));
}

/** Muted one-line note. */
export function note(text) {
  return h('p', { class: 'note', text });
}

/**
 * Progress bar element: { el, set(frac, label?) }.
 * @param {string} [cls]
 */
export function progressBar(cls = '') {
  const fill = h('span', { class: 'bar-fill' });
  const label = h('span', { class: 'bar-label' });
  const el = h('div', { class: 'bar ' + cls, role: 'progressbar', attrs: { 'aria-valuemin': '0', 'aria-valuemax': '100' } }, fill, label);
  return {
    el,
    set(frac, text = null) {
      setBar(fill, frac);
      el.setAttribute('aria-valuenow', String(Math.round((Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0) * 100)));
      if (text !== null) setText(label, text);
    },
  };
}

/** Player text for a reason (re-exported for panels); type = the refused command, for command-specific copy. */
export function why(reason, type = null) {
  return reasonText(reason, type);
}

/**
 * Two-step inline confirm for destructive non-modal actions (e.g. demolish, delete trail): the first click arms the
 * button ("Sure?") for 3 s, the second runs fn.
 * @param {string} label
 * @param {(ev: Event, el: HTMLElement) => void} fn
 * @param {string} [cls]
 */
export function armedButton(label, fn, cls = 'btn-small btn-danger-ghost') {
  let armedAt = 0;
  const b = h('button', { type: 'button', class: 'btn ' + cls, text: label });
  b.addEventListener('click', (ev) => {
    const now = Date.now();
    if (armedAt && now - armedAt < 3000) {
      armedAt = 0;
      setText(b, label);
      b.classList.remove('armed');
      fn(ev, b);
    } else {
      armedAt = now;
      setText(b, 'Sure?');
      b.classList.add('armed');
    }
  });
  b.__disarm = () => {
    if (armedAt && Date.now() - armedAt >= 3000) {
      armedAt = 0;
      setText(b, label);
      b.classList.remove('armed');
    }
  };
  return b;
}
