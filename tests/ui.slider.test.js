// WP9 unit tests — ui/panels/common.js sliderRow (C94): the readout and thumb keep the player's choice while dragging
// and until the stored value catches up (no flicker between the chosen and the stored value), then follow the state.
// Minimal in-file fake DOM; the clock is injected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

class FEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this._text = '';
    this.value = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { for (const x of c) this.appendChild(x); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t) { for (const fn of this.listeners[t] || []) fn({ type: t, target: this }); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
}

let prevDoc;
let sliderRow;
let SLIDER_HOLD_MS;
const fakeDoc = {
  activeElement: null,
  createElement: (t) => new FEl(t),
  createTextNode: (s) => ({ textContent: String(s) }),
};

before(async () => {
  prevDoc = globalThis.document;
  globalThis.document = fakeDoc;
  ({ sliderRow, SLIDER_HOLD_MS } = await import('../src/ui/panels/common.js'));
});
after(() => { globalThis.document = prevDoc; });

/** A slider wired like the Colony panel's egg reserve: release → command queued; state applies on a later tick. */
function rig({ live = false } = {}) {
  let t = 0;
  const sent = [];
  const sl = sliderRow('Egg reserve', { min: 0, max: 90, step: 5 }, (v) => sent.push(v), { live, clock: () => t });
  const fmt = (v) => v + ' %';
  const refresh = (stored) => sl.set(stored, { text: fmt(stored), fmt });
  return { sl, sent, refresh, fmt, tick: (ms) => { t += ms; } };
}

test('C94 slider: dragging shows the dragged value at every 4 Hz refresh, not the stored one', () => {
  const { sl, refresh, tick } = rig();
  refresh(20);
  assert.equal(sl.out.textContent, '20 %');
  sl.input.dispatch('pointerdown');
  fakeDoc.activeElement = null;                           // Safari/Firefox on macOS do not focus a clicked range input
  for (const v of [25, 30, 35, 40]) {
    sl.input.value = String(v);
    sl.input.dispatch('input');
    assert.equal(sl.out.textContent, v + ' %');
    tick(250);
    refresh(20);                                          // the panel refresh still passes the stored 20
    assert.equal(sl.out.textContent, v + ' %', 'no flicker back to the stored value');
    assert.equal(sl.input.value, String(v), 'the thumb is not pulled back mid-drag');
  }
});

test('C94 slider: after release the choice stays until the queued command lands, then the state shows', () => {
  const { sl, sent, refresh, tick } = rig();
  refresh(20);
  sl.input.dispatch('pointerdown');
  sl.input.value = '45';
  sl.input.dispatch('input');
  sl.input.dispatch('pointerup');
  sl.input.dispatch('change');
  assert.deepEqual(sent, [45]);
  tick(100);
  refresh(20);                                            // the command has not applied yet (next tick)
  assert.equal(sl.out.textContent, '45 %');
  assert.equal(sl.input.value, '45');
  tick(100);
  refresh(45);                                            // applied
  assert.equal(sl.out.textContent, '45 %');
  refresh(50);                                            // later state changes show again (e.g. a preset)
  assert.equal(sl.out.textContent, '50 %');
  assert.equal(sl.input.value, '50');
});

test('C94 slider: a clamped result shows the stored value; a refused one reverts after the hold', () => {
  const { sl, refresh, tick } = rig();
  refresh(20);
  sl.input.value = '80';
  sl.input.dispatch('change');
  refresh(20);
  assert.equal(sl.out.textContent, '80 %');
  refresh(70);                                            // the command clamped it (e.g. caste sum ≤ 90 %)
  assert.equal(sl.out.textContent, '70 %');
  assert.equal(sl.input.value, '70');
  sl.input.value = '10';
  sl.input.dispatch('change');                            // refused: the state never moves
  tick(SLIDER_HOLD_MS - 10);
  refresh(70);
  assert.equal(sl.out.textContent, '10 %');
  tick(20);
  refresh(70);
  assert.equal(sl.out.textContent, '70 %');
  assert.equal(sl.input.value, '70');
});

test('C94 slider: a focused but idle slider still follows the state (keyboard focus left on it)', () => {
  const { sl, refresh } = rig();
  refresh(20);
  fakeDoc.activeElement = sl.input;
  refresh(35);
  assert.equal(sl.out.textContent, '35 %');
  assert.equal(sl.input.value, '35');
  fakeDoc.activeElement = null;
});

test('C94 slider: live sliders (Map panel) settle at once through their own refresh', () => {
  let stored = 0;
  let t = 0;
  let sl;
  const refresh = () => sl.set(stored, { max: 10, text: stored + ' / 10', fmt: (v) => v + ' / 10' });
  sl = sliderRow('Soldiers', { min: 0, max: 10, step: 1 }, (v) => { stored = v; refresh(); }, { live: true, clock: () => t });
  refresh();
  sl.input.dispatch('pointerdown');
  sl.input.value = '6';
  sl.input.dispatch('input');
  assert.equal(stored, 6);
  assert.equal(sl.out.textContent, '6 / 10');
  sl.input.dispatch('pointerup');
  sl.input.dispatch('change');
  stored = 3;                                             // the panel resets its local value
  refresh();
  assert.equal(sl.out.textContent, '3 / 10');
});
