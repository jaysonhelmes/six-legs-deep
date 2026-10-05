// Patch notes (ARCHITECTURE §18 C150): the changelog table is well-formed and player-facing; CURRENT_VERSION is its
// first entry; the update pill shows only when a save existed and the last-seen version is older (or missing); a
// brand-new player gets the version recorded silently; the modal lists every version and marks the version seen.
// Uses the shared fake DOM (tests/fakedom.js). Owner: WP9.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument, FEvent } from './fakedom.js';
import { makeFakeStorage } from './helpers.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const { CHANGELOG, CURRENT_VERSION } = await import('../src/data/changelog.js');
const pn = await import('../src/ui/patchNotes.js');
const { createModalHost } = await import('../src/ui/modals.js');
const { mountUI } = await import('../src/ui/app.js');
const { createGame } = await import('../src/core/game.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');

before(() => { setRevealAll(false); setRevealProvider(null); });
after(() => {
  delete doc.defaultView.localStorage;
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const ALL = (fn) => CHANGELOG.flatMap((e) => fn(e));
const click = (el) => el.dispatchEvent(new FEvent('click', { bubbles: true }));
function findAll(node, pred, out = []) {
  if (!node) return out;
  if (node.nodeType === 1 && pred(node)) out.push(node);
  for (const c of node.childNodes || []) findAll(c, pred, out);
  return out;
}
const byClass = (node, cls) => findAll(node, (n) => n.classList && n.classList.contains(cls));

// ------------------------------------------------------------------------------------------------ data
test('C150: CHANGELOG versions are MAJOR.MINOR.PATCH, unique and strictly descending', () => {
  assert.ok(CHANGELOG.length >= 2);
  for (const e of CHANGELOG) assert.match(e.version, /^\d+\.\d+\.\d+$/, e.version);
  for (let i = 1; i < CHANGELOG.length; i++) {
    assert.ok(pn.compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version) > 0,
      CHANGELOG[i - 1].version + ' should be newer than ' + CHANGELOG[i].version);
  }
  assert.equal(CHANGELOG.at(-1).version, '0.1.0', 'the initial release closes the list');
});

test('C150: dates are real YYYY-MM-DD days and never increase down the list', () => {
  for (const e of CHANGELOG) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, e.version);
    const t = new Date(e.date + 'T00:00:00Z');
    assert.ok(Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === e.date, 'valid date ' + e.date);
  }
  for (let i = 1; i < CHANGELOG.length; i++) assert.ok(CHANGELOG[i - 1].date >= CHANGELOG[i].date, CHANGELOG[i].version);
});

test('C150: every entry has a title and non-empty notes (sections have headings and notes)', () => {
  for (const e of CHANGELOG) {
    assert.ok(typeof e.title === 'string' && e.title.trim(), e.version + ' title');
    assert.ok(e.notes || e.sections, e.version + ' has notes or sections');
    for (const sec of e.sections || []) {
      assert.ok(typeof sec.heading === 'string' && sec.heading.trim(), e.version + ' heading');
      assert.ok(Array.isArray(sec.notes) && sec.notes.length > 0, e.version + ' ' + sec.heading + ' notes');
    }
    if (e.notes) assert.ok(Array.isArray(e.notes) && e.notes.length > 0, e.version + ' notes');
    const n = pn.entryNotes(e);
    assert.ok(n.length >= 1 && n.length <= 25, e.version + ' has ' + n.length + ' notes');
    for (const t of n) assert.ok(typeof t === 'string' && t.trim().length > 5, e.version + ': "' + t + '"');
  }
});

test('C150: note text is player-facing: no clarification numbers, file names or paths', () => {
  const texts = ALL((e) => [e.title, ...pn.entryNotes(e), ...(e.sections || []).map((s) => s.heading)]);
  for (const t of texts) {
    assert.doesNotMatch(t, /\bC\d{2,3}\b/, 'clarification number in "' + t + '"');
    assert.doesNotMatch(t, /\b[\w-]+\.(js|mjs|css|html|md|json|txt)\b/i, 'file name in "' + t + '"');
    assert.doesNotMatch(t, /\b(src|tests|tools|docs|styles)\//, 'path in "' + t + '"');
    assert.doesNotMatch(t, /\b(ARCH|DESIGN §|WP\d|uistate|localStorage|refactor)\b/, 'developer term in "' + t + '"');
  }
});

test('C150: CURRENT_VERSION is the first entry; the table is frozen', () => {
  assert.equal(CURRENT_VERSION, CHANGELOG[0].version);
  assert.ok(Object.isFrozen(CHANGELOG) && Object.isFrozen(CHANGELOG[0]));
  assert.throws(() => { CHANGELOG[0].notes ? CHANGELOG[0].notes.push('x') : CHANGELOG[0].sections.push({}); });
});

test('C150: version helpers', () => {
  assert.ok(pn.compareVersions('0.10.0', '0.9.0') > 0, 'numeric, not string, order');
  assert.ok(pn.compareVersions('0.9.0', '0.9.1') < 0);
  assert.equal(pn.compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(pn.compareVersions('junk', '0.1.0') < 0, 'unparsable sorts first');
  assert.equal(pn.versionLabel('0.9.0'), 'v0.9.0');
  assert.equal(pn.fmtNoteDate('2026-10-04'), '4 Oct 2026');
  assert.equal(pn.fmtNoteDate('nope'), '');
});

// ------------------------------------------------------------------------------------------------ update notice
test('C150: update pill only when a save existed and the last-seen version is older (or missing)', () => {
  const older = makeFakeStorage({ [pn.LAST_SEEN_KEY]: '0.1.0' });
  assert.deepEqual(pn.updateNotice({ storage: older, hadSave: true }), { show: true, lastSeen: '0.1.0' });
  assert.equal(older.getItem(pn.LAST_SEEN_KEY), '0.1.0', 'not marked seen until opened or dismissed');

  const same = makeFakeStorage({ [pn.LAST_SEEN_KEY]: CURRENT_VERSION });
  assert.equal(pn.updateNotice({ storage: same, hadSave: true }).show, false);
  const newer = makeFakeStorage({ [pn.LAST_SEEN_KEY]: '99.0.0' });
  assert.equal(pn.updateNotice({ storage: newer, hadSave: true }).show, false);

  // a player from before patch notes (save, no key) is told
  assert.equal(pn.updateNotice({ storage: makeFakeStorage(), hadSave: true }).show, true);

  // brand-new player: nothing shown, version recorded silently
  const fresh = makeFakeStorage();
  assert.equal(pn.updateNotice({ storage: fresh, hadSave: false }).show, false);
  assert.equal(fresh.getItem(pn.LAST_SEEN_KEY), CURRENT_VERSION);
  const freshOld = makeFakeStorage({ [pn.LAST_SEEN_KEY]: '0.1.0' });
  assert.equal(pn.updateNotice({ storage: freshOld, hadSave: false }).show, false, 'no save → no pill even with an old key');
  assert.equal(freshOld.getItem(pn.LAST_SEEN_KEY), CURRENT_VERSION);

  // blocked storage never throws
  const broken = makeFakeStorage({}, new Set(['get', 'set']));
  assert.doesNotThrow(() => pn.updateNotice({ storage: broken, hadSave: false }));
  assert.doesNotThrow(() => pn.updateNotice({ storage: null, hadSave: true }));
});

// ------------------------------------------------------------------------------------------------ modal
test('C150: the modal lists every version newest first; only the newest is open; opening marks it seen', () => {
  const root = doc.createElement('div');
  const modals = createModalHost(root);
  const storage = makeFakeStorage({ [pn.LAST_SEEN_KEY]: '0.1.0' });
  let seen = 0;
  const handle = pn.openPatchNotes({ modals, storage, onSeen: () => { seen++; } });
  assert.equal(modals.find(pn.PATCH_NOTES_TAG), handle);
  assert.equal(storage.getItem(pn.LAST_SEEN_KEY), CURRENT_VERSION);
  assert.equal(seen, 1);
  const entries = byClass(handle.node, 'pn-entry');
  assert.deepEqual(entries.map((e) => e.dataset.version), CHANGELOG.map((e) => e.version));
  assert.ok(entries[0].hasAttribute('open'));
  assert.ok(entries.slice(1).every((e) => !e.hasAttribute('open')), 'older versions collapsed');
  const text = handle.node.textContent;
  for (const e of CHANGELOG) {
    assert.ok(text.includes('v' + e.version) && text.includes(e.title), e.version);
    for (const n of pn.entryNotes(e)) assert.ok(text.includes(n), 'note shown: ' + n);
  }
  assert.equal(pn.openPatchNotes({ modals, storage }), handle, 'a second open returns the same modal');
  modals.closeAll();
});

test('C150: "since" opens every version newer than the last one seen', () => {
  const view = pn.patchNotesView({ since: CHANGELOG[2].version });
  const open = byClass(view, 'pn-entry').filter((e) => e.hasAttribute('open')).map((e) => e.dataset.version);
  assert.deepEqual(open, [CHANGELOG[0].version, CHANGELOG[1].version]);
  const all = byClass(pn.patchNotesView({ since: '0.0.1' }), 'pn-entry').filter((e) => e.hasAttribute('open'));
  assert.equal(all.length, 3, 'at most three versions start expanded');
});

// ------------------------------------------------------------------------------------------------ shell
function mount(storage, hadSave) {
  doc.defaultView.localStorage = storage;
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  uistate.setUI({ tab: 'colony', subTab: null, tool: null, selection: null });
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  game.newGame(1000);
  const ui = mountUI(root, game, { loadRender: false, ...(hadSave === undefined ? {} : { hadSave }) });
  const destroy = ui.destroy;
  ui.destroy = () => { destroy(); if (root.parentNode) root.parentNode.removeChild(root); };
  return { root, ui, game, pill: () => byClass(root, 'update-pill')[0] || null };
}

test('C150: the shell shows the pill after an update and hides it when opened (marks seen)', () => {
  const storage = makeFakeStorage({ [pn.LAST_SEEN_KEY]: '0.1.0' });
  const m = mount(storage, true);
  const pill = m.pill();
  assert.ok(pill, 'pill shown');
  assert.match(pill.textContent, new RegExp('Updated to v' + CURRENT_VERSION.replace(/\./g, '\\.') + ' — see what\'s new'));
  assert.equal(pill.parentNode.id, 'toasts');
  click(byClass(pill, 'update-pill-open')[0]);
  assert.equal(m.pill(), null, 'pill removed');
  assert.ok(m.ui.modals.find(pn.PATCH_NOTES_TAG), 'modal open');
  assert.equal(storage.getItem(pn.LAST_SEEN_KEY), CURRENT_VERSION);
  m.ui.destroy();
});

test('C150: dismissing the pill marks the version seen; no pill for a new player or an up-to-date one', () => {
  const storage = makeFakeStorage({ [pn.LAST_SEEN_KEY]: '0.1.0' });
  let m = mount(storage, true);
  click(byClass(m.pill(), 'toast-close')[0]);
  assert.equal(m.pill(), null);
  assert.equal(m.ui.modals.find(pn.PATCH_NOTES_TAG), null, 'dismiss does not open the notes');
  assert.equal(storage.getItem(pn.LAST_SEEN_KEY), CURRENT_VERSION);
  m.ui.destroy();
  m = mount(storage, true);
  assert.equal(m.pill(), null, 'already seen');
  m.ui.destroy();

  const fresh = makeFakeStorage();
  m = mount(fresh, false);
  assert.equal(m.pill(), null, 'brand-new player');
  assert.equal(fresh.getItem(pn.LAST_SEEN_KEY), CURRENT_VERSION, 'recorded silently');
  m.ui.destroy();

  const untouched = makeFakeStorage({ [pn.LAST_SEEN_KEY]: '0.1.0' });
  m = mount(untouched, undefined);
  assert.equal(m.pill(), null, 'no hadSave option → no check');
  assert.equal(untouched.getItem(pn.LAST_SEEN_KEY), '0.1.0');
  m.ui.destroy();
});

test('C150: the rail version label and the Settings button open the patch notes', () => {
  const m = mount(makeFakeStorage({ [pn.LAST_SEEN_KEY]: CURRENT_VERSION }), true);
  const label = byClass(m.root, 'rail-version')[0];
  assert.ok(label);
  assert.equal(label.textContent, 'v' + CURRENT_VERSION);
  click(label);
  assert.ok(m.ui.modals.find(pn.PATCH_NOTES_TAG));
  m.ui.modals.closeAll();
  m.ui.openTab('settings');
  m.ui.refresh();
  const panel = byClass(m.root, 'panel-settings')[0];
  assert.ok(panel, 'settings panel mounted');
  assert.ok(byClass(panel, 'version-label')[0].textContent.includes('v' + CURRENT_VERSION));
  const btn = findAll(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Patch notes')[0];
  assert.ok(btn);
  click(btn);
  assert.ok(m.ui.modals.find(pn.PATCH_NOTES_TAG));
  m.ui.destroy();
});
