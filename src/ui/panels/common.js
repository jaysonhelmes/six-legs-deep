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

/** How long (ms) a slider keeps showing the player's choice while the state has not caught up (ARCHITECTURE C94). */
export const SLIDER_HOLD_MS = 2500;

/** Default clock for sliderRow (ms). */
function nowMs() {
  const p = globalThis.performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

/**
 * Labelled range slider row with a value readout. set(value, { max, disabled, text, fmt }) is called by the panel
 * refresh with the stored value.
 * Stable readout (C94): while the pointer is down on the slider, and after a change until the stored value catches up,
 * the thumb and the readout show the player's choice (formatted with `fmt`, else the number) instead of `text`.
 * The hold ends when the stored value equals the choice, moves to some other value (e.g. clamped), or SLIDER_HOLD_MS
 * after the change (a refused command): then the stored value shows again.
 * @param {string} label
 * @param {{ min?: number, max?: number, step?: number, tip?: string }} opts
 * @param {(value: number) => void} onChange called on 'change' (release) and, when live, on 'input'
 * @param {{ live?: boolean, clock?: () => number }} [mode] clock: ms time source (tests)
 */
export function sliderRow(label, { min = 0, max = 100, step = 1, tip = null } = {}, onChange, { live = false, clock = nowMs } = {}) {
  const input = h('input', { type: 'range', class: 'range', min, max, step, value: min, attrs: { 'aria-label': label } });
  const out = h('output', { class: 'range-out' });
  const el = h('label', { class: 'range-row', dataset: tip ? { tip } : null },
    h('span', { class: 'range-label', text: label }), input, out);
  const tol = Math.max(1e-9, Math.abs(Number(step) || 1) * 1e-6);
  const same = (a, b) => Math.abs(Number(a) - Number(b)) <= tol;
  let lastSet = null;     // last stored value given to set()
  let pending = null;     // { v, base, at }: the player's choice, the stored value when it was made, and when
  let dragging = false;
  const showOut = (v) => setText(out, el.__fmt ? el.__fmt(v) : String(v));
  const choose = () => {
    const v = Number(input.value);
    pending = { v, base: lastSet, at: clock() };
    showOut(v);
    return v;
  };
  input.addEventListener('pointerdown', () => { dragging = true; });
  for (const t of ['pointerup', 'pointercancel', 'blur']) input.addEventListener(t, () => { dragging = false; });
  input.addEventListener('input', () => {
    const v = choose();
    if (live) onChange(v);
  });
  input.addEventListener('change', () => {
    dragging = false;
    onChange(choose());
  });
  return {
    el, input, out,
    /** Update value/max/readout without fighting a drag in progress or a change the state has not applied yet. */
    set(value, { max: mx = null, disabled = false, text = null, fmt = null } = {}) {
      if (mx !== null) setProp(input, 'max', String(mx));
      setProp(input, 'disabled', !!disabled);
      if (fmt) el.__fmt = fmt;
      lastSet = value;
      if (pending) {
        const settled = same(value, pending.v);
        const movedElsewhere = pending.base !== null && !same(value, pending.base);
        if (settled || movedElsewhere || clock() - pending.at > SLIDER_HOLD_MS) pending = null;
      }
      if (dragging || pending) {
        showOut(Number(input.value));
        return;
      }
      const sv = String(value);
      if (input.value !== sv) input.value = sv;  // also while focused (setProp skips focused inputs)
      setText(out, text !== null ? text : el.__fmt ? el.__fmt(value) : sv);
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

/** C229: localStorage key of the folded panel sections ({ "colony:brood": true, … }; a per-browser convenience). */
export const COLLAPSE_KEY = 'sld.collapsed';

/** The browser's localStorage, or null when unavailable / blocked. */
function browserStore() {
  try {
    const w = typeof window !== 'undefined' ? window : globalThis;
    return w && w.localStorage ? w.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * C229: read the folded-section map (never throws; {} without storage or with a bad value).
 * @param {Storage|null} [store]
 * @returns {Object<string, boolean>}
 */
export function readCollapsed(store = browserStore()) {
  try {
    const raw = store ? store.getItem(COLLAPSE_KEY) : null;
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * C229: remember one section's folded state (never throws; storage blocked → this session only).
 * @param {string} id
 * @param {boolean} folded
 * @param {Storage|null} [store]
 */
export function writeCollapsed(id, folded, store = browserStore()) {
  try {
    if (!store) return;
    const m = readCollapsed(store);
    if (folded) m[id] = true; else delete m[id];
    store.setItem(COLLAPSE_KEY, JSON.stringify(m));
  } catch { /* storage blocked: this session only */ }
}

/**
 * C229: make a panel section foldable by its heading. Clicking the heading (or Enter / Space on it) toggles the class
 * `collapsed` on the section (CSS hides everything but the heading) and remembers it per browser under `id`.
 * The heading gets a chevron, role="button", tabindex 0 and aria-expanded. Clicks on buttons / inputs inside the
 * heading do not toggle. Returns { set(folded), folded() }.
 * @param {HTMLElement} sec
 * @param {HTMLElement} title the section's heading (a child of sec)
 * @param {string} id storage id, e.g. 'colony:brood'
 * @param {{ store?: Storage|null }} [opts]
 */
export function collapsible(sec, title, id, { store = browserStore() } = {}) {
  let folded = !!readCollapsed(store)[id];
  const chev = h('span', { class: 'sec-chev', attrs: { 'aria-hidden': 'true' } });
  title.insertBefore(chev, title.firstChild || null);
  title.classList.add('sec-toggle');
  title.setAttribute('role', 'button');
  title.setAttribute('tabindex', '0');
  const apply = () => {
    toggleClass(sec, 'collapsed', folded);
    title.setAttribute('aria-expanded', folded ? 'false' : 'true');
    setText(chev, folded ? '▸' : '▾');
  };
  const set = (v) => {
    folded = !!v;
    apply();
    writeCollapsed(id, folded, store);
  };
  const interactive = (t) => {
    for (let n = t; n && n !== title; n = n.parentNode) {
      const tag = n.tagName ? String(n.tagName).toUpperCase() : '';
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'A' || tag === 'LABEL') return true;
    }
    return false;
  };
  title.addEventListener('click', (ev) => {
    if (ev && interactive(ev.target)) return;
    set(!folded);
  });
  title.addEventListener('keydown', (ev) => {
    if (!ev || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    set(!folded);
  });
  apply();
  return { set, folded: () => folded };
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
