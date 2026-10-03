// UI unit tests — shared UI store (ARCHITECTURE §14.4), layout breakpoints (DESIGN §25.1), reveal-on-unlock tab
// visibility and the first-load inset rule. Owner: WP9.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getUI, setUI, onUI, resetUI, setOverlay, defaultUI, sameTarget, TAB_IDS, OVERLAY_IDS, SUB_TABS,
} from '../src/ui/uistate.js';
import { layoutFor, visibleTabs, isInset, TAB_KEYS } from '../src/ui/app.js';
import { isShown, setRevealAll, setRevealProvider, ALWAYS_KEYS } from '../src/ui/reveal.js';
import { createState } from '../src/core/state.js';

/** Contract-faithful reveal predicate (ARCHITECTURE §8.5 isRevealed): unlocked && seen. */
const contractReveal = (s, key) => !!(s.run.unlocked[key] && s.meta.seen[key]);

beforeEach(() => {
  resetUI();
  setRevealAll(false);
  setRevealProvider(contractReveal);
});
afterEach(() => {
  setRevealProvider(null);
  setRevealAll(false);
});

test('defaults match the documented UIState shape', () => {
  const ui = defaultUI();
  assert.deepEqual(Object.keys(ui).sort(), ['ghostDemo', 'glow', 'hover', 'layout', 'overlays', 'selection', 'subTab', 'tab', 'tool', 'view'].sort());
  assert.equal(ui.tool, null);
  assert.equal(ui.selection, null);
  assert.equal(ui.tab, 'colony');
  assert.equal(ui.view, 'split');
  assert.deepEqual(Object.keys(ui.overlays), OVERLAY_IDS.slice());
  assert.ok(Object.values(ui.overlays).every((v) => v === false));
  assert.deepEqual(TAB_IDS, ['colony', 'build', 'map', 'research', 'prestige', 'achievements', 'guide', 'stats', 'settings']);
  assert.deepEqual(SUB_TABS.prestige, ['flight', 'bloodline', 'hardships', 'supercolony', 'federation', 'edicts', 'speciation', 'genome', 'species']);
});

test('setUI shallow-merges and notifies only on real changes; onUI unsubscribes', () => {
  const seen = [];
  const off = onUI((st, changed) => seen.push(changed.slice()));
  setUI({ tab: 'build', subTab: 'inspect' });
  assert.equal(getUI().tab, 'build');
  assert.equal(getUI().subTab, 'inspect');
  assert.equal(getUI().view, 'split', 'other keys untouched');
  setUI({ tab: 'build' }); // no change
  const tool = { kind: 'placeChamber', chamber: 'gallery' };
  setUI({ tool });
  assert.equal(getUI().tool, tool);
  off();
  setUI({ tab: 'map' });
  assert.deepEqual(seen, [['tab', 'subTab'], ['tool']]);
  setUI(null);
  setUI(42);
});

test('setOverlay flips one overlay without mutating the previous object', () => {
  const before = getUI().overlays;
  setOverlay('climate');
  assert.equal(getUI().overlays.climate, true);
  assert.equal(before.climate, false, 'previous overlays object is not mutated');
  setOverlay('climate', true);
  setOverlay('climate', false);
  assert.equal(getUI().overlays.climate, false);
  setOverlay('nope', true);
  assert.equal(getUI().overlays.nope, undefined);
});

test('listener errors are contained', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const off1 = onUI(() => { throw new Error('boom'); });
    let ok = false;
    const off2 = onUI(() => { ok = true; });
    setUI({ glow: 'tab:colony' });
    assert.equal(ok, true);
    off1();
    off2();
  } finally {
    console.error = orig;
  }
});

test('sameTarget compares view, kind and id/i/hex', () => {
  assert.equal(sameTarget({ view: 'nest', kind: 'chamber', id: 1 }, { view: 'nest', kind: 'chamber', id: 1 }), true);
  assert.equal(sameTarget({ view: 'nest', kind: 'chamber', id: 1 }, { view: 'nest', kind: 'chamber', id: 2 }), false);
  assert.equal(sameTarget(null, null), true);
  assert.equal(sameTarget(null, { view: 'surface', kind: 'hex', hex: 3 }), false);
});

test('layout breakpoints (DESIGN §25.1)', () => {
  assert.equal(layoutFor(1440, 900), 'wide-tall');
  assert.equal(layoutFor(1280, 820), 'wide-tall');
  assert.equal(layoutFor(1280, 819), 'wide-short');
  assert.equal(layoutFor(1279, 900), 'medium');
  assert.equal(layoutFor(768, 1024), 'medium');
  assert.equal(layoutFor(767, 1024), 'narrow');
  assert.equal(layoutFor(375, 812), 'narrow');
  assert.equal(layoutFor(NaN, NaN), 'wide-tall');
});

test('panels are hidden until their keys reveal; guide, stats and settings are always available', () => {
  const s = createState();
  assert.deepEqual(visibleTabs(s), ['guide', 'stats', 'settings']);
  for (const k of ALWAYS_KEYS) assert.equal(isShown(s, k), true);
  // unlocked but not yet revealed through the reveal queue: still hidden
  s.run.unlocked.panel_colony = true;
  assert.deepEqual(visibleTabs(s), ['guide', 'stats', 'settings']);
  s.meta.seen.panel_colony = true;
  assert.deepEqual(visibleTabs(s), ['colony', 'guide', 'stats', 'settings']);
  for (const id of TAB_IDS) {
    s.run.unlocked[TAB_KEYS[id]] = true;
    s.meta.seen[TAB_KEYS[id]] = true;
  }
  assert.deepEqual(visibleTabs(s), TAB_IDS.slice());
});

test('reveal helpers: null key always shown, arrays mean any-of, reveal-all preview', () => {
  const s = createState();
  assert.equal(isShown(s, null), true);
  assert.equal(isShown(s, 'panel_map'), false);
  s.run.unlocked.hex_claim = true;
  s.meta.seen.hex_claim = true;
  assert.equal(isShown(s, ['panel_rivals', 'hex_claim']), true);
  assert.equal(isShown(s, ['panel_rivals', 'panel_map']), false);
  setRevealAll(true);
  assert.equal(isShown(s, 'panel_map'), true);
  setRevealAll(false);
  assert.equal(isShown(null, 'panel_map'), false);
});

test('first load: Below is an inset until panel_build is revealed', () => {
  const s = createState();
  assert.equal(isInset(s), true);
  s.run.unlocked.panel_build = true;
  s.meta.seen.panel_build = true;
  assert.equal(isInset(s), false);
});

test('C96: view helpers — four views on wide/medium, no side by side on narrow, defaults per layout, V-cycle order, tool canvases', async () => {
  const u = await import('../src/ui/uistate.js');
  assert.deepEqual(u.viewsFor('wide-tall'), ['above', 'below', 'split', 'side']);
  assert.deepEqual(u.viewsFor('medium'), ['above', 'below', 'split', 'side']);
  assert.deepEqual(u.viewsFor('narrow'), ['above', 'below', 'split']);
  assert.equal(u.defaultViewFor('wide-tall'), 'split');
  assert.equal(u.defaultViewFor('wide-short'), 'side');
  assert.equal(u.defaultViewFor('narrow'), 'above');
  assert.equal(u.effectiveView('side', 'narrow'), 'split');
  assert.equal(u.effectiveView('bogus', 'wide-tall'), 'split');
  assert.deepEqual(u.viewShows('above', 'medium'), { above: true, below: false });
  assert.deepEqual(u.viewShows('side', 'wide-tall'), { above: true, below: true });
  assert.equal(u.nextView('split', 'wide-tall'), 'side');
  assert.equal(u.nextView('side', 'wide-tall'), 'above');
  assert.equal(u.nextView('split', 'narrow'), 'above');
  assert.equal(u.toolView({ kind: 'claim' }), 'surface');
  assert.equal(u.toolView({ kind: 'placeChamber', chamber: 'gallery' }), 'nest');
  assert.equal(u.toolView(null), null);
});
