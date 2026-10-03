// DOM helpers: h() element builder, cached setters that only touch the DOM when a value changed (DESIGN §27.3
// "4 Hz, changed text nodes only"), keyed list reconciliation, event delegation, cost chips.
// Owner: WP9. Contract: ARCHITECTURE §2 (ui/dom.js). The module top level never touches `document`, so pure
// modules that import it still load in Node.

import { fmtCost, MAX_LABEL } from './format.js';
import { RES_NAMES } from './text.js';

/** The current document (looked up lazily so Node can import this module). */
export function doc() {
  return globalThis.document;
}

/**
 * Create an element. props: class, id, text, title, dataset {}, style {}, attrs {}, on { event: fn }, plus any of
 * type/value/checked/disabled/hidden/placeholder/htmlFor/tabIndex/min/max/step/name/role/aria-* (set as properties
 * or attributes). Children: nodes, strings (text nodes), arrays (flattened), null/false (skipped).
 * @param {string} tag
 * @param {Object} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const d = doc();
  const el = d.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === undefined || v === null || v === false && k !== 'checked' && k !== 'disabled' && k !== 'hidden') continue;
      switch (k) {
        case 'class': case 'className': el.className = v; break;
        case 'text': el.textContent = String(v); el.__t = String(v); break;
        case 'dataset': for (const dk of Object.keys(v)) el.dataset[dk] = String(v[dk]); break;
        case 'style': for (const sk of Object.keys(v)) el.style[sk] = v[sk]; break;
        case 'attrs': for (const ak of Object.keys(v)) if (v[ak] !== null && v[ak] !== undefined && v[ak] !== false) el.setAttribute(ak, String(v[ak])); break;
        case 'on': for (const ek of Object.keys(v)) el.addEventListener(ek, v[ek]); break;
        case 'value': case 'checked': case 'disabled': case 'hidden': case 'type': case 'placeholder': case 'htmlFor':
        case 'tabIndex': case 'min': case 'max': case 'step': case 'name': case 'id': case 'title': case 'draggable':
        case 'readOnly': case 'maxLength': case 'rows': case 'spellcheck': case 'autocomplete':
          el[k] = v; break;
        default: el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

/** Append children (strings become text nodes; arrays are flattened; null/false skipped). */
export function append(el, children) {
  const d = doc();
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === 'string' || typeof c === 'number') el.appendChild(d.createTextNode(String(c)));
    else el.appendChild(c);
  }
  return el;
}

/** Remove every child. */
export function clear(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  if (el.__keyed) el.__keyed.clear();
}

/** Set textContent only when it changed. */
export function setText(el, text) {
  if (!el) return;
  const t = text === null || text === undefined ? '' : String(text);
  if (el.__t !== t) {
    el.__t = t;
    el.textContent = t;
  }
}

/** Set (or remove, for null/false) an attribute only when it changed. */
export function setAttr(el, name, value) {
  if (!el) return;
  const cache = el.__a || (el.__a = {});
  const v = value === null || value === undefined || value === false ? null : String(value);
  if (cache[name] === v) return;
  cache[name] = v;
  if (v === null) el.removeAttribute(name);
  else el.setAttribute(name, v);
}

/** Toggle a class only when it changed. */
export function toggleClass(el, cls, on) {
  if (!el) return;
  const want = !!on;
  if (el.classList.contains(cls) !== want) el.classList.toggle(cls, want);
}

/** Show or hide (the `hidden` property) only when it changed. */
export function show(el, on) {
  if (!el) return;
  const hide = !on;
  if (el.hidden !== hide) el.hidden = hide;
}

/** Set a DOM property (value, checked, disabled …) only when it changed; never overwrite a focused input's value. */
export function setProp(el, prop, value) {
  if (!el) return;
  if (prop === 'value' && doc() && doc().activeElement === el) return;
  if (el[prop] !== value) el[prop] = value;
}

/** Set one inline style property only when it changed. */
export function setStyle(el, prop, value) {
  if (!el) return;
  const cache = el.__s || (el.__s = {});
  const v = String(value);
  if (cache[prop] === v) return;
  cache[prop] = v;
  el.style[prop] = v;
}

/** Progress-bar fill: width as a percentage of frac (clamped 0..1). */
export function setBar(el, frac) {
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  setStyle(el, 'width', (Math.round(f * 1000) / 10) + '%');
}

/**
 * Keyed list reconciliation: one child element per item, created once (create(item, i)), updated every call
 * (update(el, item, i)), kept in item order, removed when its key disappears. The container must hold only these
 * children.
 * @param {HTMLElement} container
 * @param {Array} items
 * @param {(item: any, i: number) => (string|number)} keyFn
 * @param {(item: any, i: number) => HTMLElement} create
 * @param {(el: HTMLElement, item: any, i: number) => void} [update]
 */
export function syncList(container, items, keyFn, create, update = null) {
  if (!container) return;
  const map = container.__keyed || (container.__keyed = new Map());
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const k = keyFn(item, i);
    if (seen.has(k)) continue;
    seen.add(k);
    let el = map.get(k);
    if (!el) {
      el = create(item, i);
      el.__key = k;
      map.set(k, el);
    }
    if (update) update(el, item, i);
    const ref = prev ? prev.nextSibling : container.firstChild;
    if (ref !== el) container.insertBefore(el, ref);
    prev = el;
  }
  for (const [k, el] of Array.from(map.entries())) {
    if (!seen.has(k)) {
      if (el.parentNode === container) container.removeChild(el);
      map.delete(k);
    }
  }
}

/**
 * Event delegation: fn(event, matchedElement) for events inside root whose target (or an ancestor) matches the
 * selector. Returns an unsubscribe function.
 * @param {HTMLElement} root
 * @param {string} type
 * @param {string} selector
 * @param {(ev: Event, el: HTMLElement) => void} fn
 * @returns {() => void}
 */
export function delegate(root, type, selector, fn) {
  const handler = (ev) => {
    const t = ev.target;
    const el = t && typeof t.closest === 'function' ? t.closest(selector) : null;
    if (el && (el === root || root.contains(el))) fn(ev, el);
  };
  root.addEventListener(type, handler);
  return () => root.removeEventListener(type, handler);
}

/**
 * Render a cost as resource chips into el (rebuilt only when the cost text or affordability changed).
 * @param {HTMLElement} el
 * @param {Object|null} cost
 * @param {Object} s
 * @returns {boolean} true when the whole cost is affordable
 */
export function setCost(el, cost, s) {
  if (!el) return false;
  const parts = fmtCost(cost, s);
  const sig = parts.map((p) => (p.res || '') + ':' + p.text + ':' + (p.ok ? 1 : 0)).join('|');
  const allOk = parts.length > 0 ? parts.every((p) => p.ok) : cost !== null && cost !== undefined;
  if (el.__cost === sig) return allOk;
  el.__cost = sig;
  clear(el);
  if (parts.length === 0) {
    el.appendChild(h('span', { class: 'cost-part ok', text: 'Free' }));
    return allOk;
  }
  for (const p of parts) {
    // MAX (cost above the cap) is a finished state, not a shortfall: gold, not red.
    const state = !p.res && p.text === MAX_LABEL ? ' max' : p.ok ? ' ok' : ' short';
    const part = h('span', { class: 'cost-part' + state, title: p.res ? RES_NAMES[p.res] || p.res : null });
    if (p.res) part.appendChild(h('i', { class: 'ico ico-' + p.res, attrs: { 'aria-hidden': 'true' } }));
    part.appendChild(doc().createTextNode(p.text));
    el.appendChild(part);
  }
  return allOk;
}

/** Small icon element for a resource or symbol key. */
export function icon(key) {
  return h('i', { class: 'ico ico-' + key, attrs: { 'aria-hidden': 'true' } });
}

/**
 * Button helper: h('button', { type: 'button', class: 'btn …', dataset }, label).
 * @param {string} label
 * @param {Object} [props]
 */
export function button(label, props = {}) {
  const cls = 'btn' + (props.class ? ' ' + props.class : '');
  return h('button', { ...props, type: 'button', class: cls }, label);
}

/**
 * A titled section: <section class="sec"><h3>title</h3>…</section>.
 * @param {string} title
 * @param {...any} children
 */
export function section(title, ...children) {
  return h('section', { class: 'sec' }, title ? h('h3', { class: 'sec-title', text: title }) : null, ...children);
}
