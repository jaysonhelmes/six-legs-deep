// The in-game Manual (ARCHITECTURE §18 C131): opens from the book button and the H / ? keys; shows only revealed entries
// (fresh game vs the late test saves); its numbers come from the data tables; search filters; live values update in
// place without a rebuild; cross-links and tab buttons work; unrevealed chamber and caste names never reach the DOM.
// Uses the shared fake DOM (tests/fakedom.js) and real headless games. Owner: WP9.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FDocument, FEvent } from './fakedom.js';
import { makeFakeStorage } from './helpers.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const { mountUI } = await import('../src/ui/app.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
const { createGame } = await import('../src/core/game.js');
const { createManualView, openManual, toggleManual, MANUAL_TAG } = await import('../src/ui/manual.js');
const content = await import('../src/ui/manualContent.js');
const { createModalHost } = await import('../src/ui/modals.js');
const { CHAMBERS, CHAMBER_ORDER } = await import('../src/data/chambers.js');
const { CASTES } = await import('../src/data/castes.js');
const { LAYERS } = await import('../src/data/strata.js');
const { SHORTCUTS } = await import('../src/ui/panels/settings.js');

before(() => { setRevealAll(false); setRevealProvider(null); });
after(() => {
  setRevealAll(false);
  setRevealProvider(null);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const SAVE_LATE = fs.readFileSync(new URL('../test-saves/3-ready-to-merge.txt', import.meta.url), 'utf8').trim();
const SAVE_MID = fs.readFileSync(new URL('../test-saves/1-mid-game-40min.txt', import.meta.url), 'utf8').trim();

/** A headless game (no stepping), optionally loaded from a save string. */
function makeGame(save = null) {
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  if (save) {
    const r = game.importString(save, 1000);
    assert.ok(r.ok, 'save imports: ' + r.error);
  }
  return game;
}

/** Text of every section of a view, rendered one after the other. */
function allSectionsText(view) {
  let text = '';
  for (const id of view.state().sections) {
    view.showSection(id);
    text += '\n' + view.el.textContent;
  }
  return text;
}

const NO_STORE = { innerWidth: 1440, localStorage: null };

test('book button and H / ? open the Manual from a fresh game; H closes it; typing does not', () => {
  uistate.resetUI();
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  const game = makeGame();
  const ui = mountUI(root, game, { loadRender: false });
  ui.frame(1000);
  const btn = root.querySelector('.manual-btn');
  assert.ok(btn, 'the book button is in the tab row');
  assert.equal(btn.hidden, false, 'visible from the start');
  assert.equal(btn.getAttribute('aria-label'), 'Manual');
  btn.click();
  assert.ok(ui.modals.find(MANUAL_TAG), 'the button opens it');
  assert.ok(root.querySelector('.modal-manual .manual-index'), 'large modal with a section index');
  assert.ok(root.querySelector('.modal-manual .manual-search'), 'and a search box');
  const press = (key, target = doc.body) => {
    const ev = new FEvent('keydown', { key });
    ev.target = target;
    doc.dispatchEvent(ev);
  };
  // typing H in the search box does not close it
  press('h', root.querySelector('.manual-search'));
  assert.ok(ui.modals.find(MANUAL_TAG), 'H while typing is ignored');
  press('h');
  assert.equal(ui.modals.find(MANUAL_TAG), null, 'H closes it');
  press('?');
  assert.ok(ui.modals.find(MANUAL_TAG), '? opens it');
  press('Escape');
  assert.equal(ui.modals.find(MANUAL_TAG), null, 'Esc closes it');
  press('H');
  assert.ok(ui.modals.find(MANUAL_TAG));
  ui.frame(2000);   // the 4 Hz refresh drives modal.update without errors
  ui.destroy();
  root.remove();
});

test('fresh game: only the opening entries, no unrevealed chamber or caste names anywhere', () => {
  const game = makeGame();
  const view = createManualView({ game, win: NO_STORE });
  const ids = content.visibleEntryIds(game.s, game.d);
  assert.ok(ids.includes('start:loop') && ids.includes('res:food') && ids.includes('chamber:royal_chamber') && ids.includes('controls:keys'));
  assert.ok(!ids.some((id) => id.startsWith('prestige:') || id.startsWith('war:') || id.startsWith('rival:')), 'no prestige or combat entries yet');
  assert.deepEqual(view.state().sections.filter((x) => ['combat', 'prestige', 'research'].includes(x)), [], 'locked sections are not listed');
  const text = allSectionsText(view);
  for (const id of CHAMBER_ORDER) {
    if (content.chamberShown(game.s, id)) continue;
    assert.ok(!text.includes(CHAMBERS[id].name), 'unrevealed chamber named: ' + CHAMBERS[id].name);
  }
  for (const c of ['soldier', 'supermajor', 'replete', 'alate']) assert.ok(!text.includes(CASTES[c].name), 'unrevealed caste named: ' + CASTES[c].name);
  assert.ok(!text.includes('Nuptial Flight') && !text.includes('Supercolony'), 'no prestige layer names');
  assert.ok(text.includes(content.MORE_NOTE), 'locked sections say more will unlock');
  view.destroy();
});

test('late save (ready to merge): combat, research and prestige appear; layers seen only', () => {
  const game = makeGame(SAVE_LATE);
  const view = createManualView({ game, win: NO_STORE });
  const secs = view.state().sections;
  for (const id of ['resources', 'ants', 'chambers', 'surface', 'combat', 'seasons', 'research', 'prestige', 'controls']) assert.ok(secs.includes(id), id);
  const ids = content.visibleEntryIds(game.s, game.d);
  assert.ok(ids.includes('prestige:flight') && ids.includes('prestige:super') && ids.includes('caste:soldier'));
  view.showSection('chambers');
  const strata = view.el.querySelector('[data-entry="nest:strata"]').textContent;
  for (const id of content.layersSeen(game.s)) assert.ok(strata.includes(LAYERS[id].name), id);
  for (const id of Object.keys(LAYERS)) {
    if (!content.layersSeen(game.s).includes(id)) assert.ok(!strata.includes(LAYERS[id].name + ' ' + LAYERS[id].y0), 'unreached layer listed: ' + id);
  }
  view.destroy();
});

test('numbers match the data: Gallery housing per level, placement cost and level cost', () => {
  const game = makeGame(SAVE_LATE);
  const view = createManualView({ game, win: NO_STORE });
  view.showSection('chambers');
  const gal = view.el.querySelector('[data-entry="chamber:gallery"]');
  assert.ok(gal, 'the Gallery entry is shown');
  const t = gal.textContent;
  const fx = CHAMBERS.gallery.fx;
  assert.ok(t.includes('+' + fx.housing + ' housing per level'), 'housing per level from data');
  assert.ok(t.includes('above ' + fx.highL), 'high-level rule from data');
  assert.ok(t.includes(CHAMBERS.gallery.place.food + ' food'), 'placement food from data');
  assert.ok(t.includes('× ' + CHAMBERS.gallery.g + '^level'), 'level growth from data');
  assert.ok(t.includes(CHAMBERS.gallery.w0 + '×' + CHAMBERS.gallery.h0), 'footprint from data');
  // the live "next level" line is nest.levelGain, as the inspect panel shows it
  assert.match(t, /Your next level\s*L\d+ → L\d+: \+[\d.,KM]+ housing \(/);
  view.destroy();
});

test('search filters across sections; clearing it returns to the section', () => {
  const game = makeGame(SAVE_LATE);
  const view = createManualView({ game, win: NO_STORE });
  const total = content.visibleEntryIds(game.s, game.d).length;
  view.setQuery('granary');
  const hits = view.el.querySelectorAll('.manual-entry');
  assert.ok(hits.length > 0 && hits.length < total, 'some but not all entries: ' + hits.length);
  for (const a of hits) assert.match(a.textContent.toLowerCase(), /granary/);
  assert.ok(hits.some((a) => a.dataset.entry === 'chamber:granary'));
  view.setQuery('zzqx nothing');
  assert.ok(view.el.querySelector('.manual-empty'), 'no matches note');
  view.setQuery('');
  assert.ok(view.el.querySelector('.manual-sec.active'), 'back to a section');
  // the input event drives the same filter
  view.search.value = 'trail';
  view.search.dispatchEvent(new FEvent('input'));
  assert.equal(view.state().query, 'trail');
  view.destroy();
});

test('live values update in place; structure is rebuilt only on a signature change', () => {
  const game = makeGame(SAVE_MID);
  const view = createManualView({ game, win: NO_STORE });
  view.showSection('resources');
  const art = view.el.querySelector('[data-entry="res:food"]');
  const live = art.querySelector('.manual-live');
  game.s.run.res.food = 12345;
  view.update(game.s, game.d);
  assert.equal(view.el.querySelector('[data-entry="res:food"]'), art, 'same element: no rebuild');
  assert.match(live.textContent, /^12\.3K/, 'amount refreshed: ' + live.textContent);
  // a reveal changes the signature → rebuild
  const before = view.state().sig;
  game.s.run.unlocked.res_fungus = true;
  game.s.meta.seen.res_fungus = true;
  view.update(game.s, game.d);
  assert.notEqual(view.state().sig, before);
  assert.ok(content.visibleEntryIds(game.s, game.d).includes('res:fungus'));
  view.destroy();
});

test('cross-links jump to the entry; tab buttons close the Manual and open the tab', () => {
  const game = makeGame(SAVE_LATE);
  const modals = createModalHost(doc.createElement('div'));
  const opened = [];
  const handle = openManual({ game, modals, win: NO_STORE, openTab: (tab, sub) => opened.push([tab, sub]), tabShown: () => true }, { section: 'chambers' });
  const view = handle.view;
  assert.equal(view.state().section, 'chambers');
  const link = view.el.querySelector('[data-entry="chamber:gallery"] [data-goto]');
  assert.ok(link, 'the Gallery links to another entry');
  const target = link.dataset.goto;
  link.click();
  assert.notEqual(view.el.querySelector('[data-entry="' + target + '"]'), null, 'target rendered');
  assert.ok(view.el.querySelector('[data-entry="' + target + '"]').classList.contains('flash'));
  view.showSection('chambers');
  view.el.querySelector('[data-entry="chamber:gallery"] .manual-tab').click();
  assert.deepEqual(opened.at(-1), ['build', null]);
  assert.equal(modals.find(MANUAL_TAG), null, 'closed before opening the tab');
  // toggle: opens, then closes when it is the top dialog
  assert.equal(toggleManual({ game, modals, win: NO_STORE }), true);
  assert.equal(toggleManual({ game, modals, win: NO_STORE }), false);
  assert.equal(modals.isOpen(), false);
});

test('mid save: chambers that are not revealed yet are never named', () => {
  const game = makeGame(SAVE_MID);
  const view = createManualView({ game, win: NO_STORE });
  const text = allSectionsText(view);
  const hidden = CHAMBER_ORDER.filter((id) => !content.chamberShown(game.s, id));
  assert.ok(hidden.length > 0, 'the mid save still has locked chambers');
  for (const id of hidden) assert.ok(!text.includes(CHAMBERS[id].name), 'unrevealed chamber named: ' + CHAMBERS[id].name);
  for (const c of ['supermajor', 'replete', 'alate']) {
    if (!content.casteShown(game.s, c)) assert.ok(!text.includes(CASTES[c].name), 'unrevealed caste named: ' + CASTES[c].name);
  }
  view.destroy();
});

test('controls come from the Settings reference (single source) and list the Manual key', () => {
  const game = makeGame();
  const view = createManualView({ game, win: NO_STORE });
  view.showSection('controls');
  const t = view.el.textContent;
  for (const [k, what] of SHORTCUTS) assert.ok(t.includes(k) && t.includes(what), k);
  assert.ok(SHORTCUTS.some(([k]) => k.includes('H')), 'H listed in Settings too');
  view.destroy();
});
