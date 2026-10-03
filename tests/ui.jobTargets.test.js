// WP9 unit tests — Colony panel job targets (C94): with Automatic jobs on, every job chip shows a target slider and
// +/− nudge the job's ratio target (5 %) instead of moving workers; raising one past 100 % scales the others; turning
// auto on keeps the current split; the automation then converges the workers to the targets.
// Minimal in-file fake DOM; a real game (createGame, storage null).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

class FNode {
  constructor(tag) {
    this.tagName = tag ? tag.toUpperCase() : '#text';
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.hidden = false;
    this.value = '';
    this._text = '';
    this.className = '';
    const self = this;
    this.classList = {
      contains: (c) => self.className.split(/\s+/).includes(c),
      add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => { if (on ?? !self.classList.contains(c)) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sib = this.parentNode.childNodes;
    return sib[sib.indexOf(this) + 1] || null;
  }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    return n;
  }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? fakeDoc.createTextNode(n) : n); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, extra = {}) { for (const fn of this.listeners[t] || []) fn({ type: t, target: this, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {}, ...extra }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; }
}
const fakeDoc = {
  activeElement: null,
  createElement: (t) => new FNode(t),
  createTextNode: (s) => { const n = new FNode(null); n._text = String(s); return n; },
};

let prevDoc;
let createGame;
let createPanel;
let targetsFromJobs;
before(async () => {
  prevDoc = globalThis.document;
  globalThis.document = fakeDoc;
  ({ createGame } = await import('../src/core/game.js'));
  ({ createPanel, targetsFromJobs } = await import('../src/ui/panels/colony.js'));
});
after(() => { globalThis.document = prevDoc; });

function find(root, pred) {
  if (pred(root)) return root;
  for (const c of root.childNodes) {
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}

function mount() {
  const game = createGame({ nowMs: 1_700_000_000_000, storage: null });
  game.newGame(1_700_000_000_000);
  const s = game.s;
  s.run.research.age_polyethism = 1;
  for (const k of ['panel_colony', 'job_digger', 'job_scout', 'job_presets']) s.run.unlocked[k] = true;
  s.run.colony.adults.minor = 100;
  s.run.colony.jobs = { forager: 70, digger: 20, nurse: 10, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  const rejects = [];
  const root = new FNode('div');
  const panel = createPanel(root, { game, ui: { getUI: () => ({}) }, bridge: { reject: (r) => rejects.push(r) } });
  panel.update(s, game.d);
  const chip = (id) => find(root, (n) => n.dataset && n.dataset.job === id);
  const autoBox = find(root, (n) => n.tagName === 'LABEL' && n.textContent === 'Automatic jobs').childNodes[0];
  return { game, s, panel, root, chip, autoBox, rejects, refresh: () => panel.update(game.s, game.d) };
}

test('C94 targetsFromJobs: fractions of the assigned workers, Σ = 1, null with nobody assigned', () => {
  const t = targetsFromJobs({ forager: 7, digger: 2, nurse: 1, scout: 0, herder: 0, leafcutter: 0, gardener: 0 });
  assert.deepEqual([t.forager, t.digger, t.nurse, t.scout], [0.7, 0.2, 0.1, 0]);
  const u = targetsFromJobs({ forager: 1, digger: 1, nurse: 1 });
  assert.ok(Math.abs(Object.values(u).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(targetsFromJobs({ forager: 0 }), null);
});

test('C94 colony panel: target sliders appear only in auto mode; turning auto on keeps the current split', () => {
  const m = mount();
  assert.equal(m.chip('forager').__r.tSl.el.hidden, true, 'manual mode: no target slider');
  m.autoBox.checked = true;
  m.autoBox.dispatch('change');
  m.game.runFor(0.1);
  m.refresh();
  assert.equal(m.s.run.colony.autoJobs, true);
  assert.deepEqual(m.s.run.colony.jobTargets, { forager: 0.7, digger: 0.2, nurse: 0.1, scout: 0, herder: 0, leafcutter: 0, gardener: 0 });
  assert.equal(m.chip('forager').__r.tSl.el.hidden, false);
  assert.equal(m.chip('digger').__r.tSl.out.textContent, '20%');
  m.game.runFor(6);
  assert.deepEqual([m.s.run.colony.jobs.forager, m.s.run.colony.jobs.digger, m.s.run.colony.jobs.nurse].map(Math.round), [70, 20, 10], 'nobody moved');
});

test('C94 colony panel: +/− nudge the target by 5 % (rapid clicks add up), the workers follow at the next rebalance', () => {
  const m = mount();
  m.s.run.colony.autoJobs = true;
  m.s.run.colony.jobTargets = { forager: 0.7, digger: 0.2, nurse: 0.1, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  m.refresh();
  const dig = m.chip('digger').__r;
  dig.plus.dispatch('click');
  dig.plus.dispatch('click');                             // before the queued command has applied
  m.game.runFor(0.1);
  const t = m.s.run.colony.jobTargets;
  assert.ok(Math.abs(t.digger - 0.3) < 1e-9, 'two clicks = +10 %: ' + t.digger);
  assert.ok(Math.abs(t.forager - 0.7 * 0.7 / 0.8) < 1e-6, 'the others were scaled down: ' + t.forager);
  assert.ok(Math.abs(Object.values(t).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(m.s.run.colony.jobs.digger, 20, 'no worker moved by the click itself');
  m.game.runFor(5);
  assert.ok(Math.abs(m.s.run.colony.jobs.digger - 30) < 0.5, 'the rebalance follows: ' + m.s.run.colony.jobs.digger);
  const nurse = m.chip('nurse').__r;
  for (let i = 0; i < 4; i++) nurse.minus.dispatch('click');
  m.game.runFor(0.1);
  assert.equal(m.s.run.colony.jobTargets.nurse, 0, 'floored at 0');
  assert.deepEqual(m.rejects, []);
});

test('C94 colony panel: dragging the target slider sends a full target map; the readout does not flicker', () => {
  const m = mount();
  m.s.run.colony.autoJobs = true;
  m.s.run.colony.jobTargets = { forager: 0.7, digger: 0.2, nurse: 0.1, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  m.refresh();
  const sl = m.chip('nurse').__r.tSl;
  sl.input.dispatch('pointerdown');
  sl.input.value = '25';
  sl.input.dispatch('input');
  m.refresh();
  assert.equal(sl.out.textContent, '25%');
  sl.input.dispatch('pointerup');
  sl.input.dispatch('change');
  m.refresh();                                            // command still queued
  assert.equal(sl.out.textContent, '25%');
  m.game.runFor(0.1);
  m.refresh();
  assert.equal(sl.out.textContent, '25%');
  assert.equal(m.s.run.colony.jobTargets.nurse, 0.25);
  assert.ok(Object.values(m.s.run.colony.jobTargets).reduce((a, b) => a + b, 0) <= 1 + 1e-9);
});
