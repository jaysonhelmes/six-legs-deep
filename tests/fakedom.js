// Shared minimal fake DOM for node:test UI suites (a copy of the one in ui.dom.test.js, exported so other suites can
// mount panels and the app shell without a browser). Not a test file itself.
// ------------------------------------------------------------------------------------------------ fake DOM
const kebab = (k) => String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

class FEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.defaultPrevented = false;
    this._stop = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
}

class FNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = {};
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sib = this.parentNode.childNodes;
    return sib[sib.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const sib = this.parentNode.childNodes;
    return sib[sib.indexOf(this) - 1] || null;
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  insertBefore(n, ref) {
    if (ref === null || ref === undefined) return this.appendChild(n);
    if (n === ref) return n;
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('insertBefore: reference is not a child');
    n.parentNode = this;
    this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x === this.ownerDocument; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { const l = this.listeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    for (let x = this; x; x = x.parentNode) {
      ev.currentTarget = x;
      for (const fn of (x.listeners[ev.type] || []).slice()) fn.call(x, ev);
      if (ev._stop || !ev.bubbles) break;
    }
    return !ev.defaultPrevented;
  }
}

class FText extends FNode {
  constructor(doc, t) { super(doc); this.nodeType = 3; this.data = String(t); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

function matchCompound(el, sel) {
  const m = sel.match(/^([a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
  if (!m) throw new Error('fake DOM: unsupported selector ' + sel);
  if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  if (m[2] && el.id !== m[2].slice(1)) return false;
  if (m[3]) for (const c of m[3].split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
  if (m[4]) {
    for (const a of m[4].match(/\[[^\]]+\]/g)) {
      const [k, v] = a.slice(1, -1).split('=');
      if (v === undefined) { if (!el.hasAttribute(k)) return false; } else if (el.getAttribute(k) !== v.replace(/^["']|["']$/g, '')) return false;
    }
  }
  return true;
}

/** Compound selectors joined by descendant combinators (whitespace). */
function matchComplex(el, sel) {
  const parts = sel.match(/(?:[^\s[]+|\[[^\]]*\])+/g);
  if (!parts || !matchCompound(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let x = el.parentNode; i >= 0 && x && x.nodeType === 1; x = x.parentNode) if (matchCompound(x, parts[i])) i--;
  return i < 0;
}

class FElement extends FNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    const style = {};
    style.setProperty = (k, v) => { style[k] = v; };
    this.style = style;
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.width = 300;
    this.height = 150;
    const self = this;
    this.dataset = new Proxy({}, {
      set(o, k, v) { self.setAttribute('data-' + kebab(k), String(v)); return true; },
      get(o, k) { const v = self.getAttribute('data-' + kebab(k)); return v === null ? undefined : v; },
      deleteProperty(o, k) { self.removeAttribute('data-' + kebab(k)); return true; },
    });
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { el.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { el.className = list().filter((x) => !c.includes(x)).join(' '); },
      contains: (c) => list().includes(c),
      toggle: (c, force) => {
        const has = list().includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) el.className = [...list(), c].join(' ');
        if (!want && has) el.className = list().filter((x) => x !== c).join(' ');
        return want;
      },
    };
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  matches(sel) { return sel.split(',').some((p) => matchComplex(this, p.trim())); }
  closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() { if (!this.disabled) this.dispatchEvent(new FEvent('click', { clientX: 10, clientY: 10 })); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  select() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  getContext() { return null; }
}

class FDocument extends FNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.documentElement = new FElement(this, 'html');
    this.appendChild(this.documentElement);
    this.body = new FElement(this, 'body');
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.defaultView = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  }
  createElement(t) { return new FElement(this, t); }
  createTextNode(t) { return new FText(this, t); }
  getElementById(id) { return this.documentElement.querySelector('#' + id); }
  execCommand() { return true; }
}

export { FEvent, FNode, FText, FElement, FDocument };
