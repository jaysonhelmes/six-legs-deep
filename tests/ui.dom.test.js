// UI integration-style unit tests on a minimal in-file fake DOM (no browser, no network, no timers): mountUI builds
// the documented skeleton, panels stay hidden until their keys reveal, every panel renders on skeleton and partial
// state, export → import round-trips through the Settings UI, hard reset requires typing "abandon", toasts are rate
// limited on screen, the event card and landing chooser dispatch their commands, keyboard shortcuts work.
// The game uses a no-op stepFn so these tests do not depend on other packages' systems. Owner: WP9.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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

// ------------------------------------------------------------------------------------------------ setup
const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const { mountUI } = await import('../src/ui/app.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
const { createGame } = await import('../src/core/game.js');
const { createState } = await import('../src/core/state.js');
const { createDerived } = await import('../src/core/derived.js');
const { makeFakeStorage } = await import('./helpers.js');
const panels = {
  colony: await import('../src/ui/panels/colony.js'),
  build: await import('../src/ui/panels/build.js'),
  map: await import('../src/ui/panels/map.js'),
  research: await import('../src/ui/panels/research.js'),
  prestige: await import('../src/ui/panels/prestige.js'),
  achievements: await import('../src/ui/panels/achievements.js'),
  guide: await import('../src/ui/panels/guide.js'),
  stats: await import('../src/ui/panels/stats.js'),
  settings: await import('../src/ui/panels/settings.js'),
};

const contractReveal = (s, key) => !!(s.run.unlocked[key] && s.meta.seen[key]);
const noStep = () => [];
let game;
let ui;
let root;
let now = 1000;
let errors = [];
const origError = console.error;

function freshApp() {
  if (ui) ui.destroy();
  if (root && root.parentNode) root.parentNode.removeChild(root);
  uistate.resetUI();
  root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: noStep });
  ui = mountUI(root, game, { loadRender: false });
  now = 1000;
  ui.frame(now);
}

/** Advance the UI clock and refresh. */
function tick(ms = 300) {
  now += ms;
  ui.frame(now);
}

/** Find a button inside el by its visible text. */
function button(el, text) {
  return el.querySelectorAll('button').find((b) => b.textContent.trim().startsWith(text)) || null;
}

const tabButton = (id) => root.querySelector('button[data-tab="' + id + '"]');

before(() => {
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };
});
after(() => {
  console.error = origError;
  if (ui) ui.destroy();
  setRevealProvider(null);
  setRevealAll(false);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});
beforeEach(() => {
  errors = [];
  setRevealAll(false);
  setRevealProvider(contractReveal);
  freshApp();
});

// ------------------------------------------------------------------------------------------------ tests
test('mountUI builds the documented skeleton on an empty #app and returns the contract API', () => {
  for (const id of ['rail', 'stage', 'hud-top', 'view-above', 'canvas-above', 'flow-strip', 'canvas-seam', 'view-below', 'canvas-below',
    'nest-strip', 'overlay-bar', 'view-tabs', 'panels', 'tabs', 'panel-body', 'event-card', 'toasts', 'tooltip', 'modal-root']) {
    assert.ok(doc.getElementById(id), 'missing #' + id);
  }
  assert.equal(ui.canvases.above.id, 'canvas-above');
  assert.equal(ui.canvases.below.id, 'canvas-below');
  assert.equal(ui.canvases.seam.id, 'canvas-seam');
  assert.equal(ui.canvases.nestStrip.id, 'nest-strip');
  for (const k of ['hover', 'select', 'openTab', 'openChooser', 'contextMenu', 'reject', 'toast']) assert.equal(typeof ui.bridge[k], 'function', k);
  assert.equal(typeof ui.frame, 'function');
  assert.equal(typeof ui.showWelcome, 'function');
  assert.equal(typeof ui.destroy, 'function');
  assert.equal(root.getAttribute('data-layout'), 'wide-tall');
  assert.equal(root.getAttribute('data-inset'), 'true', 'first load: Below is an inset');
  assert.deepEqual(errors, []);
});

test('panels are hidden until their keys reveal; the opening shows a welcome card, not an always-on tab', () => {
  for (const id of ['colony', 'build', 'map', 'research', 'prestige', 'achievements']) assert.equal(tabButton(id).hidden, true, id);
  for (const id of ['guide', 'stats', 'settings']) assert.equal(tabButton(id).hidden, false, id);
  assert.equal(root.getAttribute('data-intro'), 'true');
  const card = root.querySelector('.intro-host');
  assert.ok(card && !card.hidden, 'the welcome card holds the panel column');
  assert.match(card.textContent, /glowing crumb/);
  for (const id of ['guide', 'stats', 'settings']) assert.ok(!tabButton(id).classList.contains('active'), id + ' is not preselected');
  assert.equal(root.querySelector('.panel-host[data-tab="guide"]'), null, 'the Field Guide is not the first impression');
  assert.equal(root.querySelector('.panel-host[data-tab="colony"]'), null, 'hidden panels are not even built');
  tabButton('guide').click();
  assert.equal(uistate.getUI().tab, 'guide', 'always-on tabs still open on request');
  assert.ok(card.hidden, 'and replace the welcome card');
  uistate.setUI({ tab: 'colony' });
  game.s.run.unlocked.panel_colony = true;
  tick();
  assert.equal(tabButton('colony').hidden, true, 'unlocked but not yet revealed by the reveal queue');
  game.s.meta.seen.panel_colony = true;
  tick();
  assert.equal(tabButton('colony').hidden, false);
  ui.openTab('colony');
  assert.equal(uistate.getUI().tab, 'colony');
  assert.ok(root.querySelector('.panel-host[data-tab="colony"]'));
  ui.openTab('research');
  assert.equal(uistate.getUI().tab, 'colony', 'cannot open a tab that is not revealed');
  assert.deepEqual(errors, []);
});

test('the resource rail shows only revealed resources', () => {
  const row = (r) => root.querySelector('.res-' + r);
  assert.equal(row('food').hidden, false);
  assert.equal(row('soil').hidden, true);
  assert.equal(row('insight').hidden, true);
  game.s.run.unlocked.job_digger = true;
  game.s.meta.seen.job_digger = true;
  game.s.run.res.soil = 12.5;
  tick();
  assert.equal(row('soil').hidden, false);
  assert.match(row('soil').textContent, /12\.5/);
  game.d.rates.food.net = -0.25;
  tick();
  assert.ok(row('food').querySelector('.res-rate').classList.contains('neg'), 'negative rates are red');
});

test('every panel and sub-tab renders on the skeleton state without errors (reveal-all preview)', () => {
  setRevealAll(true);
  tick();
  for (const id of uistate.TAB_IDS) {
    ui.openTab(id);
    tick();
    assert.equal(uistate.getUI().tab, id);
  }
  for (const sub of ['flight', 'bloodline', 'hardships', 'supercolony', 'federation', 'edicts', 'speciation', 'genome', 'species']) {
    ui.openTab('prestige', sub);
    tick();
  }
  ui.openTab('map', 'war');
  tick();
  ui.bridge.select({ view: 'nest', kind: 'chamber', id: 1 });
  ui.openTab('build', 'inspect');
  tick();
  ui.bridge.select({ view: 'surface', kind: 'source', id: 1 });
  ui.openTab('map', null);
  tick();
  ui.bridge.select({ view: 'surface', kind: 'hex', hex: 5 });
  tick();
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('panels are defensive against partial and hostile state', () => {
  setRevealAll(true);
  const ctx = { game: { s: createState(), d: createDerived(), actions: { do: () => ({ ok: true, reason: null }) }, storageOk: true,
    exportString: () => 'SLD1:x', importString: () => ({ ok: true }), save: () => ({ ok: true }) }, ui: uistate, bridge: { reject() {}, toast() {}, select() {}, openChooser() {} } };
  const states = [];
  const s1 = createState();
  s1.run.colony.brood = [{ c: 'minor', n: NaN, p: 0.5, t: 0 }, null];
  s1.run.surface.trails.push({ uid: 9, src: 999, path: [], len: 3, job: 'herder', workers: 2, escorts: 0, S: 40 });
  s1.run.war.raids.push({ uid: 1, rival: 77, target: { type: 'trail', uid: 9 }, raiders: 5, warn: 12, phase: 'warning', guard: 0 });
  s1.run.war.battles.push({ uid: 3, kind: 'border', you: {}, foe: {}, t: 2 });
  s1.run.war.parties.push({ uid: 4, kind: 'raid', target: { type: 'rival', uid: 77 }, soldier: 3, supermajor: 0, path: [0, 1, 2], pos: 1, state: 'out' });
  s1.run.nest.queue.push({ uid: 5, kind: 'chamber', chamber: 404, cells: [1, 2, 3], cur: 1, prog: 0, paidFood: 40, blueprint: false });
  s1.run.events.card = { uid: 2, id: 'ev_unknown_future', t: 10, choices: ['a'], data: {} };
  s1.meta.pending = { kind: 'landing', options: [], boons: [] };
  states.push([s1, createDerived()]);
  const d2 = createDerived();
  d2.stats = {};
  d2.rates = {};
  d2.meta = {};
  states.push([createState(), d2]);
  for (const [s, d] of states) {
    for (const [name, mod] of Object.entries(panels)) {
      const host = doc.createElement('div');
      const p = mod.createPanel(host, { ...ctx, game: { ...ctx.game, s, d } });
      assert.doesNotThrow(() => { p.update(s, d); p.update(s, d); }, name);
      p.destroy();
    }
  }
});

test('export → import round-trips through the Settings UI', () => {
  ui.openTab('settings');
  tick();
  const panel = root.querySelector('.panel-settings');
  assert.ok(panel);
  game.s.meta.settings.colonyName = 'Ridgeback';
  game.s.run.res.food = 123.5;
  const before = JSON.parse(JSON.stringify(game.s));
  button(panel, 'Export').click();
  const exportArea = panel.querySelector('textarea[aria-label="Export string"]');
  assert.match(exportArea.value, /^SLD1:/);
  // change the colony, then import the exported string back
  game.s.meta.settings.colonyName = 'Changed';
  game.s.run.res.food = 1;
  const importArea = panel.querySelector('textarea[aria-label="Import string"]');
  importArea.value = exportArea.value;
  button(panel, 'Import').click();
  const modal = root.querySelector('#modal-root .modal');
  assert.ok(modal, 'import asks for confirmation');
  assert.equal(game.s.meta.settings.colonyName, 'Changed', 'nothing happens before confirming');
  modal.querySelector('button[data-act="confirm"]').click();
  assert.equal(root.querySelector('#modal-root .modal'), null, 'the modal closes');
  const after = JSON.parse(JSON.stringify(game.s));
  assert.ok(after.meta.savedAt > 0, 'the imported colony is saved at once');
  delete before.meta.lastSeen;
  delete after.meta.lastSeen;
  delete before.meta.savedAt;
  delete after.meta.savedAt;
  assert.deepEqual(after, before);
  tick();
  assert.match(panel.textContent, /Colony imported\./);
  assert.doesNotMatch(panel.textContent, /Not saved yet/, 'the save indicator does not claim the import is unsaved');
});

test('a bad import string shows a readable error and leaves the colony untouched', () => {
  ui.openTab('settings');
  tick();
  const panel = root.querySelector('.panel-settings');
  game.s.meta.settings.colonyName = 'Keep';
  panel.querySelector('textarea[aria-label="Import string"]').value = 'SLD1:not-really';
  button(panel, 'Import').click();
  root.querySelector('#modal-root .modal button[data-act="confirm"]').click();
  assert.equal(game.s.meta.settings.colonyName, 'Keep');
  assert.match(panel.textContent, /damaged|not a Six Legs Deep save|could not/);
});

test('hard reset requires typing "abandon"', () => {
  let resets = 0;
  game.hardReset = () => { resets++; };
  ui.openTab('settings');
  tick();
  button(root.querySelector('.panel-settings'), 'Abandon colony').click();
  const modal = root.querySelector('#modal-root .modal');
  assert.ok(modal);
  const input = modal.querySelector('input');
  const confirm = modal.querySelector('button[data-act="confirm"]');
  assert.equal(confirm.disabled, true);
  confirm.click();
  assert.equal(resets, 0);
  input.value = 'abando';
  input.dispatchEvent(new FEvent('input'));
  assert.equal(confirm.disabled, true);
  input.value = 'Abandon';
  input.dispatchEvent(new FEvent('input'));
  assert.equal(confirm.disabled, true, 'case matters');
  input.value = 'abandon';
  input.dispatchEvent(new FEvent('input'));
  assert.equal(confirm.disabled, false);
  confirm.click();
  assert.equal(resets, 1);
  assert.equal(root.querySelector('#modal-root .modal'), null);
});

test('on-screen toasts are rate limited (≤ 2 per 10 s) and queued high-priority toasts follow', () => {
  const count = () => root.querySelectorAll('#toasts .toast').filter((t) => !t.classList.contains('leaving')).length;
  for (let i = 0; i < 5; i++) ui.toasts.push('High ' + i, 'info', { priority: 'high' });
  ui.toasts.push('Low', 'info', { priority: 'low' });
  tick(10);
  assert.equal(count(), 2);
  tick(6000); // first two expire (5 s) but the window is still full
  assert.equal(count(), 0);
  tick(4500); // 10.5 s after the first two: the next two queued appear
  assert.equal(count(), 2);
  assert.ok(root.querySelector('#toasts').textContent.includes('High 2'));
});

test('event card: choices with the default marked *, dispatches eventChoice, hides when resolved', () => {
  const calls = [];
  game.actions.do = (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; };
  game.s.run.events.card = { uid: 9, id: 'ev_wandering_queen', t: 20, choices: ['adopt', 'devour'], data: {} };
  tick();
  const el = root.querySelector('#event-card');
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /strange queen/i);
  const adopt = el.querySelector('button[data-choice="adopt"]');
  assert.ok(adopt);
  assert.ok(el.querySelector('button[data-choice="devour"]'));
  adopt.click();
  assert.deepEqual(calls.at(-1), { type: 'eventChoice', args: { uid: 9, choice: 'adopt' } });
  game.s.run.events.card = null;
  tick();
  assert.equal(el.hidden, true);
});

test('landing chooser opens while a flight is pending and dispatches chooseLanding', () => {
  const calls = [];
  game.actions.do = (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; };
  game.s.meta.pending = { kind: 'landing', options: [{ seed: 11, tags: ['site_rich_loam'] }, { seed: 12, tags: [] }, { seed: 13, tags: ['site_wet_hollow'] }],
    boons: ['boon_royal_vigor', 'boon_scouts_lead', 'boon_insight_cache'], chooseSeason: true, alates: 24, hardship: null };
  tick();
  const modal = root.querySelector('#modal-root .modal');
  assert.ok(modal, 'chooser open');
  assert.equal(modal.querySelector('.modal-x'), null, 'not dismissable');
  modal.querySelector('button[data-i="1"]').click();
  modal.querySelector('button[data-id="boon_scouts_lead"]').click();
  modal.querySelector('button[data-id="summer"]').click();
  modal.querySelector('button[data-act="confirm"]').click();
  assert.deepEqual(calls.at(-1), { type: 'chooseLanding', args: { index: 1, boon: 'boon_scouts_lead', season: 'summer' } });
  game.s.meta.pending = null;
  tick();
  assert.equal(root.querySelector('#modal-root .modal'), null);
});

test('keyboard: 1–9 open revealed tabs, Esc cancels the tool, Space hand-forages the selected source', () => {
  const calls = [];
  game.actions.do = (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; };
  const key = (k) => doc.body.dispatchEvent(new FEvent('keydown', { key: k }));
  key('8');
  assert.equal(uistate.getUI().tab, 'stats');
  key('1');
  assert.equal(uistate.getUI().tab, 'stats', 'colony is not revealed yet');
  uistate.setUI({ tool: { kind: 'claim' } });
  key('Escape');
  assert.equal(uistate.getUI().tool, null);
  ui.bridge.select({ view: 'surface', kind: 'source', id: 1 });
  key(' ');
  assert.deepEqual(calls.at(-1), { type: 'clickForage', args: { src: 1 } });
  key('Escape');
  assert.equal(uistate.getUI().selection, null);
});

test('bridge: reject shows a reason pop, contextMenu lists actions, openChooser opens the pupa chooser', () => {
  ui.bridge.reject('cantAfford', 100, 120);
  const pop = root.querySelector('.reject-pop');
  assert.ok(pop);
  assert.equal(pop.textContent, 'Not enough resources.');
  tick(2000);
  assert.equal(root.querySelector('.reject-pop'), null, 'the pop fades out');
  ui.bridge.contextMenu({ view: 'surface', kind: 'trail', id: 2 }, 50, 50);
  const menu = root.querySelector('.ctx-menu');
  assert.ok(menu);
  assert.ok(button(menu, 'Reroute'));
  assert.ok(button(menu, 'Delete trail'));
  doc.body.dispatchEvent(new FEvent('keydown', { key: 'Escape' }));
  assert.equal(root.querySelector('.ctx-menu'), null);
  ui.bridge.openChooser('pupa', {});
  assert.match(root.querySelector('#modal-root').textContent, /Forage Frenzy/);
});

test('storage failures show the persistent "Saving unavailable: use Export" banner', () => {
  const banner = root.querySelector('.storage-banner');
  assert.equal(banner.hidden, true);
  game.storageOk = false;
  game.bus.emit('storageError', { type: 'storageError', error: 'quota' });
  tick();
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Saving unavailable: use Export/);
});

test('welcome-back modal opens for long offline catch-ups only', () => {
  game.bus.emit('offlineDone', { type: 'offlineDone', summary: { seconds: 90, eff: 1 } });
  assert.equal(root.querySelector('#modal-root .modal'), null);
  game.bus.emit('offlineDone', { type: 'offlineDone', summary: { seconds: 4000, eff: 0.5, foodGained: 500, foodWasted: 20, hatched: 3, cells: [], chambers: [] } });
  const modal = root.querySelector('#modal-root .modal');
  assert.ok(modal);
  assert.match(modal.textContent, /Welcome back/);
  assert.match(modal.textContent, /food lost to full granaries/);
});

test('unlock events toast and preselect a newly revealed panel', () => {
  game.s.run.unlocked.panel_colony = true;
  game.s.meta.seen.panel_colony = true;
  game.bus.emit('unlock', { type: 'unlock', key: 'panel_colony' });
  tick(20);
  assert.equal(uistate.getUI().tab, 'colony');
  assert.match(root.querySelector('#toasts').textContent, /New:/);
});

test('a later panel reveal never steals the open tab: the new tab slides in with a "new" dot instead', () => {
  for (const k of ['panel_colony', 'job_digger']) { game.s.run.unlocked[k] = true; game.s.meta.seen[k] = true; }
  tick();
  assert.equal(uistate.getUI().tab, 'colony');
  game.s.run.unlocked.panel_build = true;
  game.s.meta.seen.panel_build = true;
  game.bus.emit('unlock', { type: 'unlock', key: 'panel_build' });
  tick();
  assert.equal(uistate.getUI().tab, 'colony', 'still on the tab the player was using');
  assert.equal(tabButton('build').hidden, false);
  assert.ok(tabButton('build').classList.contains('fresh'), 'the new tab carries the cue');
  tabButton('build').click();
  tick();
  assert.ok(!tabButton('build').classList.contains('fresh'), 'cue cleared once opened');
  assert.deepEqual(errors, []);
});

test('HUD warning chip: active mold shows a chip; clicking it selects the moldy chamber', () => {
  game.s.run.unlocked.panel_build = true;
  game.s.meta.seen.panel_build = true;
  game.s.run.nest.chambers.push({ uid: 9, type: 'gallery', x: 4, y: 10, w: 4, h: 2, level: 1, status: 'active' });
  game.s.run.events.objects.push({ uid: 50, kind: 'mold', hex: -1, cell: 12 * 40 + 5, t: -1, data: { occ: 1, chamber: 9 } });
  tick();
  const chip = root.querySelector('.threats .threat-chip');
  assert.ok(chip, 'chip shown');
  assert.match(chip.textContent, /Mold ×1/);
  chip.click();
  assert.deepEqual(uistate.getUI().selection, { view: 'nest', kind: 'chamber', id: 9 });
  game.s.run.events.objects.length = 0;
  tick();
  assert.equal(root.querySelector('.threats .threat-chip'), null, 'gone once scraped');
  assert.deepEqual(errors, []);
});

/** Run fn with the fake window resized (layout breakpoints), then restore the default wide app. */
function withViewport(w, hgt, fn) {
  const view = doc.defaultView;
  view.innerWidth = w;
  view.innerHeight = hgt;
  try {
    freshApp();
    fn();
  } finally {
    view.innerWidth = 1440;
    view.innerHeight = 900;
    freshApp();
  }
}

test('narrow: an unlock preselects its panel without raising the sheet; opening a tab raises it', () => {
  withViewport(375, 812, () => {
    assert.equal(root.getAttribute('data-layout'), 'narrow');
    assert.equal(root.getAttribute('data-sheet'), 'peek');
    game.s.run.unlocked.panel_colony = true;
    game.s.meta.seen.panel_colony = true;
    game.bus.emit('unlock', { type: 'unlock', key: 'panel_colony' });
    tick();
    assert.equal(uistate.getUI().tab, 'colony', 'preselected');
    assert.equal(root.getAttribute('data-sheet'), 'peek', 'the canvas is not covered by the sheet');
    assert.ok(root.querySelector('.sheet-handle').classList.contains('fresh'), 'the sheet handle carries the new-panel cue');
    tabButton('stats').click();
    assert.equal(root.getAttribute('data-sheet'), 'half', 'a tab tap raises the sheet');
    tick();
    assert.ok(!root.querySelector('.sheet-handle').classList.contains('fresh'), 'cue cleared once seen');
    assert.deepEqual(errors, []);
  });
});

test('medium: an unlock keeps the drawer closed and cues the Panels button; the button opens the drawer', () => {
  withViewport(1024, 768, () => {
    assert.equal(root.getAttribute('data-layout'), 'medium');
    assert.equal(root.getAttribute('data-drawer'), 'closed');
    game.s.run.unlocked.panel_colony = true;
    game.s.meta.seen.panel_colony = true;
    game.bus.emit('unlock', { type: 'unlock', key: 'panel_colony' });
    tick();
    const toggle = root.querySelector('.panels-toggle');
    assert.equal(uistate.getUI().tab, 'colony');
    assert.equal(root.getAttribute('data-drawer'), 'closed');
    assert.ok(toggle.classList.contains('fresh'));
    toggle.click();
    assert.equal(root.getAttribute('data-drawer'), 'open');
    tick();
    assert.ok(!toggle.classList.contains('fresh'));
    ui.bridge.openTab('settings');
    assert.equal(root.getAttribute('data-drawer'), 'open', 'explicit openTab keeps / opens the drawer');
    doc.dispatchEvent(new FEvent('keydown', { key: 'Escape' }));
    assert.equal(root.getAttribute('data-drawer'), 'closed', 'Esc closes the drawer');
    assert.deepEqual(errors, []);
  });
});

test('hard reset from a raised sheet starts the new colony with the sheet lowered', () => {
  withViewport(375, 812, () => {
    ui.openTab('settings');
    assert.equal(root.getAttribute('data-sheet'), 'half');
    ui.dialogs.hardReset();
    const input = root.querySelector('#modal-root input');
    input.value = 'abandon';
    input.dispatchEvent(new FEvent('input'));
    button(root.querySelector('#modal-root'), 'Abandon colony').click();
    tick();
    assert.equal(root.getAttribute('data-sheet'), 'peek');
    assert.deepEqual(errors, []);
  });
});

test('a toast pushed between frames after a long gap (hidden-tab catch-up) stays up for its full time', () => {
  const count = () => root.querySelectorAll('#toasts .toast').filter((t) => !t.classList.contains('leaving')).length;
  tick(20000);   // clear anything earlier
  tick(20000);
  // The catch-up runs inside game.advance, before ui.frame sees the new time: the toast is pushed with the stale clock.
  game.bus.emit('offlineDone', { type: 'offlineDone', summary: { seconds: 90, eff: 1, foodGained: 1234 } });
  tick(90000);   // the first frame after the gap
  assert.equal(count(), 1, 'still visible on the first frame after the gap');
  assert.match(root.querySelector('#toasts').textContent, /Caught up 1m 30s/);
  tick(3000);
  assert.equal(count(), 1, 'still visible 3 s later');
});

// ------------------------------------------------------------------------------------------------ meta / prestige fixes
test('F11: the landing chooser offers a Bloodline shop; Seasonal Wisdom bought there adds the season row', () => {
  const calls = [];
  game.actions.do = (type, args) => {
    calls.push({ type, args });
    if (type === 'buyTrait') {
      game.s.cycle.traits[args.id] = (game.s.cycle.traits[args.id] || 0) + 1;
      game.s.cycle.alates -= 20;
      if (args.id === 'seasonal_wisdom') game.s.meta.pending.chooseSeason = true;
    }
    return { ok: true, reason: null };
  };
  game.s.cycle.alates = 40;
  game.s.meta.pending = { kind: 'landing', options: [{ seed: 11, tags: [] }, { seed: 12, tags: [] }, { seed: 13, tags: [] }],
    boons: ['boon_royal_vigor', 'boon_scouts_lead', 'boon_insight_cache'], chooseSeason: false, alates: 24, hardship: null };
  tick();
  const modal = root.querySelector('#modal-root .modal');
  assert.ok(modal, 'chooser open');
  const shop = modal.querySelector('.landing-shop');
  assert.ok(shop, 'Bloodline shop inside the chooser');
  assert.match(shop.textContent, /40/, 'alates balance shown');
  assert.equal(modal.querySelector('button[data-id="summer"]'), null, 'no season row without Seasonal Wisdom');
  modal.querySelector('button[data-trait="seasonal_wisdom"]').click();
  assert.deepEqual(calls.at(-1), { type: 'buyTrait', args: { id: 'seasonal_wisdom' } });
  assert.ok(modal.querySelector('button[data-id="summer"]'), 'season row appears once Seasonal Wisdom is owned');
  tick();
  assert.match(shop.textContent, /20/, 'balance refreshed');
  modal.querySelector('button[data-id="winter"]').click();
  modal.querySelector('button[data-act="confirm"]').click();
  assert.deepEqual(calls.at(-1), { type: 'chooseLanding', args: { index: 0, boon: 'boon_royal_vigor', season: 'winter' } });
  game.s.meta.pending = null;
  tick();
  assert.deepEqual(errors, []);
});

test('F10: Automaton Instincts owners get the Adaptation autobuyer switch in the Bloodline sub-tab', () => {
  const calls = [];
  game.actions.do = (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; };
  setRevealAll(true);
  ui.openTab('prestige', 'bloodline');
  tick();
  const sec = root.querySelector('.panel-prestige .auto-trait');
  assert.ok(sec && sec.hidden, 'hidden without the trait');
  game.s.cycle.traits.automaton_instincts = 1;
  tick();
  assert.equal(sec.hidden, false, 'shown with Automaton Instincts, no Federation needed');
  const input = sec.querySelector('input');
  input.checked = true;
  input.dispatchEvent(new FEvent('change'));
  assert.deepEqual(calls.at(-1), { type: 'setAutomation', args: { patch: { autobuy: { on: true, adaptations: true } } } });
  assert.deepEqual(errors, []);
});

test('F16 / F17: Genome hides Biomes; Chronobiology sends the starting season only when one is picked', () => {
  const calls = [];
  game.actions.do = (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; };
  setRevealAll(true);
  game.s.meta.genome.chronobiology = 1;
  ui.openTab('prestige', 'genome');
  tick();
  const panel = root.querySelector('.panel-prestige');
  assert.equal(panel.querySelector('.buy-row[data-id="biomes"]'), null, 'no unbuyable STRETCH row');
  assert.ok(panel.querySelector('.buy-row[data-id="chronobiology"]'));
  button(panel, 'Apply').click();
  assert.equal(calls.at(-1).type, 'setChronobiology');
  assert.equal(calls.at(-1).args.start, null, 'length-only by default');
  panel.querySelector('.seg-btn[data-id="winter"]').click();
  button(panel, 'Apply').click();
  assert.equal(calls.at(-1).args.start, 'winter');
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------------------------------------------------ UI clarity (F12/F13/F15)
test('bridge.locate centres and pings with the renderer hooks when present, else falls back to scrollToRow / centerOn', async () => {
  const { GRID } = await import('../src/data/balance.js');
  const cols = GRID.cols;
  const calls = [];
  ui.attachRenderers({
    nest: { centerOnCell: (i) => calls.push(['center', i]), ping: (i) => calls.push(['ping', i]), scrollToRow: (r) => calls.push(['scroll', r]) },
    surface: { centerOn: (hx) => calls.push(['centerOn', hx]), ping: (hx) => calls.push(['sping', hx]) },
  });
  ui.bridge.locate({ view: 'nest', cell: 12 * cols + 5, chamber: 0 });
  assert.deepEqual(calls, [['center', 12 * cols + 5], ['ping', 12 * cols + 5]]);
  calls.length = 0;
  ui.bridge.locate({ view: 'nest', row: 0 });
  assert.deepEqual(calls, [['center', Math.floor(cols / 2)], ['ping', Math.floor(cols / 2)]], 'a row-only spot centres on the row middle');
  calls.length = 0;
  ui.bridge.locate({ view: 'surface', hex: 14 });
  assert.deepEqual(calls, [['centerOn', 14], ['sping', 14]]);
  assert.deepEqual(uistate.getUI().selection, { view: 'surface', kind: 'hex', hex: 14 });
  // older renderers: no centerOnCell / ping
  calls.length = 0;
  ui.attachRenderers({ nest: { scrollToRow: (r) => calls.push(['scroll', r]), getView: () => ({ viewRows: 20 }) }, surface: { centerOn: (hx) => calls.push(['centerOn', hx]) } });
  ui.bridge.locate({ view: 'nest', cell: 12 * cols + 5 });
  ui.bridge.locate({ view: 'surface', hex: 3 });
  assert.deepEqual(calls, [['scroll', 2], ['centerOn', 3]]);
  ui.attachRenderers(null);
  assert.deepEqual(errors, []);
});

test('medium (1024×768): the open drawer docks beside the canvas, so locating a spot keeps it open', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../styles/panels.css', import.meta.url), 'utf8');
  const rule = css.match(/#app\[data-layout='medium'\]\[data-drawer='open'\]\s*\{([^}]*)\}/);
  assert.ok(rule && /grid-template-columns:[^;]*var\(--drawer-w\)/.test(rule[1]), 'a docked panels column when the drawer is open');
  assert.match(rule[1], /grid-template-areas:\s*'rail panels' 'stage panels'/);
  const panelsRules = [...css.matchAll(/#app\[data-layout='medium'\]\[data-drawer='open'\] #panels\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.ok(/position:\s*relative/.test(panelsRules) && /transform:\s*none/.test(panelsRules), 'the drawer is in the flow, not over the canvas');
  withViewport(1024, 768, () => {
    root.querySelector('.panels-toggle').click();
    assert.equal(root.getAttribute('data-drawer'), 'open');
    ui.bridge.locate({ view: 'surface', hex: 5 });
    assert.equal(root.getAttribute('data-drawer'), 'open', 'nothing to uncover: the canvas sits beside the drawer');
  });
  assert.deepEqual(errors, []);
});

test('F15: a hex that cannot take a satellite is refused with the precise reason before the column picker; the tool stays armed', async () => {
  const s = game.s;
  const d = game.d;
  s.era.federation.satellite_nest = 1;
  const lastPop = () => root.querySelectorAll('.reject-pop').at(-1);
  const modalText = () => root.querySelector('#modal-root').textContent;
  // not yours
  uistate.setUI({ tool: { kind: 'placeSatellite' } });
  ui.bridge.hover({ view: 'surface', kind: 'hex', hex: 1 }, 50, 60);
  ui.bridge.openChooser('satelliteColumn', { hex: 1 });
  uistate.setUI({ tool: null }); // surfaceInput clears the tool right after openChooser
  await Promise.resolve();
  assert.ok(!modalText().includes('Place a satellite nest'), 'no column picker');
  assert.match(lastPop().textContent, /your own territory/);
  assert.equal(uistate.getUI().tool && uistate.getUI().tool.kind, 'placeSatellite', 'the tool is re-armed for the next try');
  // yours but next to the entrance
  d.surface.owned[1] = 1;
  ui.bridge.openChooser('satelliteColumn', { hex: 1 });
  assert.match(lastPop().textContent, /Too close to an entrance: 1 hex away, satellites need 3\+/);
  // a valid hex opens the column picker
  const { hexDist } = await import('../src/core/hex.js');
  let far = -1;
  for (let hx = 1; hx < 400 && far < 0; hx++) if (hexDist(0, hx) === 4) far = hx;
  d.surface.owned[far] = 2;
  ui.bridge.openChooser('satelliteColumn', { hex: far });
  assert.ok(modalText().includes('Place a satellite nest'), 'column picker for a valid hex');
  // the canvas tool refuses with the bare code (render surfaceInput → bridge.reject): the pop still gives the distance
  uistate.setUI({ tool: { kind: 'placeSatellite' } });
  ui.bridge.hover({ view: 'surface', kind: 'hex', hex: 1 }, 50, 60);
  ui.bridge.reject('blocked:entrance', 50, 60);
  assert.match(lastPop().textContent, /1 hex away, satellites need 3\+/);
  assert.deepEqual(errors, []);
});

test('bridge.reject picks command-specific copy from the type, else from the active tool or the hovered view', async () => {
  const T = await import('../src/ui/text.js');
  const lastPop = () => root.querySelectorAll('.reject-pop').at(-1).textContent;
  ui.bridge.reject('blocked', 30, 40, 'cancelJob');
  assert.equal(lastPop(), T.REASON_BY_COMMAND.cancelJob.blocked);
  uistate.setUI({ tool: { kind: 'backfill' } });
  ui.bridge.reject('blocked', 30, 40);
  assert.equal(lastPop(), T.REASON_BY_COMMAND.backfill.blocked);
  uistate.setUI({ tool: null, hover: { view: 'surface', kind: 'hex', hex: 5 } });
  ui.bridge.reject('blocked', 30, 40);
  assert.equal(lastPop(), T.REASON_BY_COMMAND.drawTrail.blocked, 'a refused trail drag explains the route');
  uistate.setUI({ hover: { view: 'nest', kind: 'cell', i: 300 } });
  ui.bridge.reject('blocked', 30, 40);
  assert.equal(lastPop(), T.REASON_BY_COMMAND.digTo.blocked);
  ui.bridge.reject('blocked:stone', 30, 40);
  assert.equal(lastPop(), T.REASON_DETAILS['blocked:stone']);
  assert.deepEqual(errors, []);
});

test('F13: toasts state the Front rule with the deadline when the first nest falls, and say so when fallen nests regrow', () => {
  const s = game.s;
  const mk = (uid, hex) => ({ uid, type: 'great_rival', group: 11, alive: true, sighted: true, hex, n: 100, base: 100, tier: 11, fallenAt: -1,
    traits: [], truce: 0 });
  s.run.rivals.list = [mk(11, 40), mk(12, 60), mk(13, 80)];
  s.run.time = 1000;
  tick();
  assert.ok(!root.querySelector('#toasts').textContent.includes('Front'), 'no toast on the first look');
  s.run.rivals.list[0].alive = false;
  s.run.rivals.list[0].fallenAt = 1000;
  s.run.time = 1010;
  tick();
  tick(50);
  assert.match(root.querySelector('#toasts').textContent, /Front nest fallen! Take the other 2 within 9m 50s/);
  const chip = root.querySelector('.threat-chip[data-threat="front"]');
  assert.ok(chip, 'HUD countdown chip');
  assert.match(chip.textContent, /Front 1\/3 down/);
  tick(11000);
  s.run.rivals.list[0].alive = true;
  s.run.rivals.list[0].fallenAt = -1;
  tick();
  tick(50);
  assert.match(root.querySelector('#toasts').textContent, /regrew at full strength/);
  assert.equal(root.querySelector('.threat-chip[data-threat="front"]'), null);
  assert.deepEqual(errors, []);
});

test('F14: the Dispatch garrison button shows only for trail raids; a nest raid explains that the garrison defends it', () => {
  setRevealAll(true);
  const s = game.s;
  s.run.colony.adults.soldier = 12;
  game.d.combat.garrison = { soldier: 12, supermajor: 0 };
  s.run.war.raids.push({ uid: 41, rival: 0, target: { type: 'nest' }, raiders: 300, warn: 60, phase: 'warning', guard: 0 });
  s.run.war.raids.push({ uid: 42, rival: 0, target: { type: 'trail', uid: s.run.surface.trails[0] ? s.run.surface.trails[0].uid : 2 },
    raiders: 20, warn: 30, phase: 'warning', guard: 0 });
  ui.openTab('map', 'war');
  tick();
  const rows = root.querySelectorAll('.raid-row');
  assert.equal(rows.length, 2);
  const nestRow = rows.find((r) => r.textContent.includes('the nest'));
  const trailRow = rows.find((r) => r.textContent.includes('trail to'));
  assert.ok(nestRow && trailRow, 'both raid rows rendered');
  const nestBtn = button(nestRow, 'Dispatch garrison');
  assert.ok(!nestBtn || nestBtn.hidden, 'no button that always fails with invalid:nest');
  assert.match(nestRow.textContent, /garrison \(12\) defends the entrance automatically/);
  const trailBtn = button(trailRow, 'Dispatch garrison');
  assert.ok(trailBtn && !trailBtn.hidden, 'trail raids keep the button');
  assert.ok(!/defends the entrance/.test(trailRow.querySelector('.raid-note') ? (trailRow.querySelector('.raid-note').hidden ? '' : trailRow.querySelector('.raid-note').textContent) : ''));
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------------------------------------------------ C96 player reports
/** Reveal the Build panel so the opening inset (Below as a corner preview) is over and views apply. */
function pastInset() {
  game.s.run.unlocked.panel_build = true;
  game.s.meta.seen.panel_build = true;
  tick();
}
const viewBtn = (id) => root.querySelector('#view-tabs button[data-view="' + id + '"]');
const keyDown = (k, extra = {}) => { const ev = new FEvent('keydown', { key: k, ...extra }); doc.body.dispatchEvent(ev); return ev; };

test('C96: the view switcher is on every layout (Above / Below / Stacked / Side by side), V cycles it, Tab is left to the browser', () => {
  const store = makeFakeStorage();
  doc.defaultView.localStorage = store;
  try {
    freshApp();
    pastInset();
    assert.equal(root.getAttribute('data-layout'), 'wide-tall');
    assert.equal(root.getAttribute('data-view'), 'split', 'wide-tall stacks by default');
    for (const id of ['above', 'below', 'split', 'side']) assert.ok(viewBtn(id) && !viewBtn(id).hidden, id);
    assert.equal(viewBtn('split').textContent, 'Stacked');
    assert.equal(viewBtn('side').textContent, 'Side by side');
    viewBtn('side').click();
    assert.equal(root.getAttribute('data-view'), 'side');
    assert.equal(store.getItem('sld.ui.view'), 'side', 'remembered per browser');
    freshApp();
    pastInset();
    assert.equal(root.getAttribute('data-view'), 'side', 'restored on the next visit');
    // V cycles Above → Below → Stacked → Side by side
    keyDown('v');
    assert.equal(root.getAttribute('data-view'), 'above');
    keyDown('V');
    assert.equal(root.getAttribute('data-view'), 'below');
    const tab = keyDown('Tab');
    assert.equal(tab.defaultPrevented, false, 'Tab keeps moving focus');
    assert.equal(root.getAttribute('data-view'), 'below');
    // narrow: no room for side by side; a remembered "side" stacks
    store.setItem('sld.ui.view', 'side');
    withViewport(375, 812, () => {
      pastInset();
      assert.equal(root.getAttribute('data-layout'), 'narrow');
      assert.equal(viewBtn('side').hidden, true);
      assert.equal(root.getAttribute('data-view'), 'split');
      keyDown('v');
      assert.equal(root.getAttribute('data-view'), 'above', 'cycling skips side by side');
    });
  } finally {
    delete doc.defaultView.localStorage;
  }
  assert.deepEqual(errors, []);
});

test('C96: switching panel tab puts the claim tool down; arming a tool shows its canvas; hiding that canvas cancels it', () => {
  pastInset();
  uistate.setUI({ tool: { kind: 'claim' } });
  ui.openTab('stats');
  assert.equal(uistate.getUI().tool, null, 'a tab switch ends claiming');
  uistate.setUI({ tool: { kind: 'claim' } });
  ui.openTab('stats', null);
  assert.deepEqual(uistate.getUI().tool, { kind: 'claim' }, 'the same tab keeps the tool');
  keyDown('9');
  assert.equal(uistate.getUI().tool, null, 'number keys switch tabs too');
  // a surface tool armed while only Below shows brings Above in
  uistate.setUI({ view: 'below' });
  uistate.setUI({ tool: { kind: 'placeSatellite' } });
  assert.equal(uistate.getUI().view, 'above');
  // the player switches to Below: the surface tool is put down
  viewBtn('below').click();
  assert.equal(uistate.getUI().tool, null);
  uistate.setUI({ tool: { kind: 'placeChamber', chamber: 'gallery' } });
  assert.equal(uistate.getUI().view, 'below', 'nest tools stay with Below');
  viewBtn('split').click();
  assert.deepEqual(uistate.getUI().tool, { kind: 'placeChamber', chamber: 'gallery' }, 'still visible when stacked');
  keyDown('Escape');
  assert.equal(uistate.getUI().tool, null);
  assert.deepEqual(errors, []);
});

test('C72/C96: an incoming raid has its own chip with a countdown; the badge keeps the real bottleneck; a click shows the raiders', () => {
  pastInset();
  const s = game.s;
  s.run.rivals.list.push({ uid: 7, type: 'fire_ants', tier: 2, hex: 40, alive: true, sighted: true, n: 10, radius: 1, extra: [], lost: [] });
  s.run.war.raids.push({ uid: 3, rival: 7, target: { type: 'nest' }, raiders: 5, warn: 25, phase: 'warning', guard: 0 });
  s.run.bottleneck = { id: 'bn_housing', since: 0, capT: 0 };
  tick();
  const badge = root.querySelector('.bn-badge');
  assert.ok(badge && !badge.hidden);
  assert.match(badge.textContent, /Housing/, 'the bottleneck stays visible during a raid warning');
  const chip = root.querySelector('.raid-chip');
  assert.ok(chip && !chip.hidden, 'raid chip shown');
  assert.match(chip.textContent, /Raid/);
  assert.match(chip.textContent, /25s/);
  const calls = [];
  ui.attachRenderers({ surface: { centerOn: (hx) => calls.push(hx) } });
  chip.click();
  assert.deepEqual(calls, [40], 'brings the raiders\' nest into view');
  ui.attachRenderers(null);
  s.run.war.raids.length = 0;
  tick();
  assert.equal(root.querySelector('.raid-chip').hidden, true);
  assert.deepEqual(errors, []);
});
