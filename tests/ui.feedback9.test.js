// Feedback pass 9 — UI (ARCHITECTURE §18 C280–C283): foldable sections on every panel with Collapse all / Expand all
// (C280), job rows with a cap meter and Fill to cap (C282), and the Quest book that replaces Next goals (C283).
// Research branches as foldable sections (C281) are covered in ui.playerUi.test.js. Uses the shared fake DOM.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument, FEvent } from './fakedom.js';
import { newState, makeDerived, fakeEnv, makeFakeStorage } from './helpers.js';
import { recompute } from '../src/systems/stats.js';
import { handlers as popH } from '../src/systems/population.js';
import { handlers as jobsH } from '../src/systems/jobs.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;
const store = makeFakeStorage();
doc.defaultView.localStorage = store;

const common = await import('../src/ui/panels/common.js');
const colonyPanel = await import('../src/ui/panels/colony.js');
const achPanel = await import('../src/ui/panels/achievements.js');
const quests = await import('../src/ui/quests.js');
const qb = await import('../src/ui/questbook.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
const { h } = await import('../src/ui/dom.js');
setRevealAll(true);
after(() => {
  setRevealAll(false);
  setRevealProvider(null);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const ALL = { ...popH, ...jobsH };
function cmd(s, d, type, args = {}) {
  const c = { type, ...args };
  const r = ALL[type].validate(s, d, c);
  if (r) return r;
  ALL[type].apply(s, d, c, fakeEnv());
  return null;
}
function world(minors = 50) {
  const s = newState(7);
  const d = makeDerived();
  for (const k of ['panel_colony', 'job_digger', 'job_scout', 'panel_war']) s.run.unlocked[k] = true;
  s.run.colony.adults.minor = minors;
  s.run.colony.jobs.forager = minors;
  d.nest.agg.housingBase = 1e6;
  recompute(s, d, fakeEnv());
  return { s, d };
}
function mountColony(s, d) {
  const rejects = [];
  const game = { s, d, actions: { do: (type, args) => {
    const r = cmd(s, d, type, args);
    if (r) rejects.push(r);
    return r ? { ok: false, reason: r } : { ok: true };
  } } };
  const root = doc.createElement('div');
  const p = colonyPanel.createPanel(root, { game, ui: { getUI: () => ({}) }, bridge: { reject() {} } });
  p.update(s, d);
  return { root, p, rejects, refresh: () => p.update(s, d) };
}
const row = (root, id) => root.querySelector('.job-row[data-job="' + id + '"]');

// ------------------------------------------------------------------------------------------------ C280
test('C280: enhanceFolds makes every panel section foldable with stable ids; the tools bar counts shown sections', () => {
  store.map.clear();
  const host = h('div', { class: 'panel-host' });
  const panel = h('div', { class: 'panel' });
  host.appendChild(panel);
  const a = h('section', { class: 'sec' }, h('h3', { class: 'sec-title' }, 'Dig queue ', h('span', { class: 'sec-meta', text: '2 jobs' })), h('p', { text: 'a' }));
  const b = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Chambers' }), h('p', { text: 'b' }));
  const insTitle = h('h3', { class: 'sec-title', text: 'Nursery #4' });
  const c = h('section', { class: 'sec inspect' }, h('div', { class: 'row-between' }, insTitle, h('span', { text: 'badge' })), h('p', { text: 'c' }));
  const dup = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Chambers' }));
  const hiddenView = h('div', null, dup);
  hiddenView.hidden = true;
  panel.append(a, b, c, hiddenView);
  const folds = common.enhanceFolds(host, 'build', { store });
  assert.deepEqual(folds.map((f) => f.id), ['build:dig-queue', 'build:chambers', 'build:inspect', 'build:chambers-2']);
  assert.ok(c.querySelector('.row-between').classList.contains('fold-head'), 'a heading row stays visible when folded');
  assert.equal(insTitle.getAttribute('role'), 'button');
  // idempotent: a second pass adds nothing and keeps the ids
  assert.deepEqual(common.enhanceFolds(host, 'build', { store }).map((f) => f.id), folds.map((f) => f.id));
  const tools = common.foldTools();
  tools.sync(folds, host);
  assert.equal(tools.el.hidden, false);
  assert.match(tools.el.textContent, /3 of 3 sections open/, 'the hidden sub-view is not counted');
  const [collapseAll, expandAll] = tools.el.querySelectorAll('button');
  assert.equal(expandAll.disabled, true);
  collapseAll.click();
  assert.ok([a, b, c].every((x) => x.classList.contains('collapsed')));
  assert.equal(dup.classList.contains('collapsed'), false, 'only the shown view folds');
  assert.match(tools.el.textContent, /0 of 3 sections open/);
  assert.equal(collapseAll.disabled, true);
  assert.equal(JSON.parse(store.getItem(common.COLLAPSE_KEY))['build:chambers'], true);
  expandAll.click();
  assert.ok([a, b, c].every((x) => !x.classList.contains('collapsed')));
  // summaries and unfoldFor
  folds[0].setSummary('2 jobs · 41 s left');
  assert.equal(a.querySelector('.sec-title').dataset.foldSum, '2 jobs · 41 s left');
  folds[0].set(true);
  assert.equal(common.unfoldFor(a.querySelector('p')), true);
  assert.equal(a.classList.contains('collapsed'), false);
  // ↓ moves focus to the next shown heading
  const ta = a.querySelector('.sec-title');
  ta.dispatchEvent(new FEvent('keydown', { key: 'ArrowDown' }));
  assert.equal(doc.activeElement, b.querySelector('.sec-title'));
  b.querySelector('.sec-title').dispatchEvent(new FEvent('keydown', { key: 'End' }));
  assert.equal(doc.activeElement, insTitle, 'End: the last shown heading');
  store.map.clear();
});

test('C280: Colony folds show one-line summaries', () => {
  store.map.clear();
  const { s, d } = world(20);
  const m = mountColony(s, d);
  assert.match(m.root.querySelector('.sec-jobs .sec-title').dataset.foldSum, /^20 workers assigned · 0 idle$/);
  assert.match(m.root.querySelector('.sec-brood .sec-title').dataset.foldSum, /^\d+ \/ \d+ brood slots · lay /);
});

// ------------------------------------------------------------------------------------------------ C282
test('C282: job rows show count / cap, a meter and Fill to cap (manual: idle first, then foragers)', () => {
  const { s, d } = world(100);
  const m = mountColony(s, d);
  const n = row(m.root, 'nurse');
  assert.ok(n, 'nurse row');
  assert.equal(n.querySelector('.job-cap').textContent, '/ 11');
  assert.match(n.querySelector('.jb-sub').textContent, /^0 \/ 11 cap$/);
  const fill = n.querySelector('.btn-fill');
  assert.equal(fill.hidden, false, 'Fill to cap offered');
  assert.match(fill.title, /Move 11 workers here/);
  s.run.colony.jobs.forager = 95; // 5 idle
  m.refresh();
  fill.click();
  assert.equal(s.run.colony.jobs.nurse, 11, 'filled to the cap');
  assert.equal(s.run.colony.jobs.forager, 89, '5 idle first, then 6 foragers');
  m.refresh();
  assert.equal(fill.hidden, true, 'full: no Fill button');
  assert.ok(n.querySelector('.jb-meter').classList.contains('full'));
  // an uncapped job shows its share of workers
  const f = row(m.root, 'forager');
  assert.match(f.querySelector('.jb-sub').textContent, /of workers · no cap/);
  assert.equal(f.querySelector('.btn-fill').hidden, true);
  // stacked buttons: + above −
  const steps = n.querySelectorAll('.jb-steps button');
  assert.ok(steps[0].classList.contains('up') && steps[1].classList.contains('down'));
});

test('C282: auto mode warns when a target asks for more than the cap; Clamp to cap sets the cap share', () => {
  const { s, d } = world(100);
  s.run.research.age_polyethism = 1;
  s.run.colony.autoJobs = true;
  s.run.colony.jobTargets = { forager: 0.5, digger: 0, nurse: 0.3, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  const m = mountColony(s, d);
  const n = row(m.root, 'nurse');
  const info = colonyPanel.jobCapInfo(s, d, 'nurse', s.run.colony.jobTargets);
  assert.equal(info.cap, 11);
  assert.ok(Math.abs(info.want - 30) < 1e-9);
  assert.equal(info.over, true);
  const warn = n.querySelector('.cap-warn');
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /asks for 30, but the cap is 11\. 19 go to foragers instead/);
  assert.equal(n.querySelector('.jb-mark').hidden, false, 'target mark on the meter');
  warn.querySelector('button').click();
  assert.ok(Math.abs(s.run.colony.jobTargets.nurse - colonyPanel.capShare(11, 100)) < 1e-12);
  assert.equal(colonyPanel.capShare(11, 100), 0.11);
  m.refresh();
  assert.equal(warn.hidden, true, 'clamped: no warning');
  assert.equal(colonyPanel.jobCapInfo(s, d, 'nurse', s.run.colony.jobTargets).over, false);
  assert.equal(colonyPanel.capShare(5, 0), 0);
  assert.match(colonyPanel.capTipFor('herder', 16), /16 herders: 8 per aphid-colony level/);
});

// ------------------------------------------------------------------------------------------------ C283
test('C283: quest stages follow the colony; steps tick themselves; achievements fill in when quests run out', () => {
  const s = newState(3);
  const d = makeDerived();
  setRevealAll(false);
  setRevealProvider((st, key) => !!st.run.unlocked[key]);
  try {
    assert.equal(quests.questStage(s), 'early');
    let bk = quests.questBook(s, d);
    assert.equal(bk.stage.chapter, 'Chapter I');
    assert.ok(bk.quests.length >= 3 && bk.quests.length <= quests.QUEST_MAX);
    const first = bk.quests.find((x) => x.id === 'e_workers');
    assert.equal(first.complete, false);
    s.run.stats.hatched = 3;
    s.run.colony.adults.minor = 3;
    s.run.colony.jobs.digger = 1;
    bk = quests.questBook(s, d);
    const done = bk.quests.find((x) => x.id === 'e_workers');
    assert.equal(done.complete, true);
    assert.equal(done.frac, 1);
    s.run.unlocked.panel_research = true;
    assert.equal(quests.questStage(s), 'mid');
    s.run.fRun = 3e7;
    assert.equal(quests.questStage(s), 'pre');
    const flight = quests.questBook(s, d).quests.find((x) => x.id === 'p_flight');
    assert.match(flight.progText, /food this run · 0 \/ 4 steps/);
    assert.ok(flight.frac > 0.15 && flight.frac < 0.17, 'food progress counts');
    s.meta.counters.flights = 1;
    assert.equal(quests.questStage(s), 'post');
    s.meta.counters.supercolonies = 1;
    assert.equal(quests.questStage(s), 'super');
    // nearly every stage quest done → nearest achievements fill in (at least QUEST_MIN_OPEN unfinished)
    const st2 = newState(4);
    st2.run.stats.hatched = 50;
    st2.run.colony.adults.minor = 50;
    st2.run.colony.jobs = { forager: 40, digger: 5, nurse: 0, scout: 5, herder: 0, leafcutter: 0, gardener: 0 };
    for (const k of ['panel_build', 'job_scout', 'royal_levelup']) st2.run.unlocked[k] = true;
    st2.run.nest.chambers.push({ uid: 9, type: 'gallery', status: 'active', level: 1 }, { uid: 10, type: 'nursery', status: 'active', level: 1 });
    const b2 = quests.questBook(st2, makeDerived());
    assert.ok(b2.quests.filter((x) => !x.complete).length >= quests.QUEST_MIN_OPEN, 'fill-in quests');
    assert.ok(b2.quests.some((x) => x.id.startsWith('goal:')));
    assert.equal(quests.nextStep(first) && quests.nextStep(first).i, 0);
  } finally {
    setRevealProvider(null);
    setRevealAll(true);
  }
});

test('C283: tracking is remembered per browser; the book opens on the tracked quest, turns pages and closes', () => {
  store.map.clear();
  const s = newState(5);
  const d = makeDerived();
  const opened = [];
  const stage = h('main');
  // the fake window keeps no listeners: collect the book's keydown handler here
  const winL = [];
  const w = globalThis.window;
  const prevAdd = w.addEventListener;
  const prevRemove = w.removeEventListener;
  w.addEventListener = (type, fn) => { if (type === 'keydown') winL.push(fn); };
  w.removeEventListener = (type, fn) => { const i = winL.indexOf(fn); if (i >= 0) winL.splice(i, 1); };
  const key = (k) => { for (const fn of winL.slice()) fn(new FEvent('keydown', { key: k })); };
  const book = qb.createQuestBook(stage, { game: { s, d }, openTab: (t, sub) => opened.push([t, sub]) });
  const chip = qb.createQuestChip({ game: { s, d }, book });
  assert.equal(book.isOpen(), false);
  const bk = quests.questBook(s, d);
  const second = bk.quests[1];
  qb.toggleTrack(second.id);
  assert.equal(store.getItem(quests.TRACK_KEY), second.id);
  chip.update(s, d);
  assert.equal(chip.el.hidden, false, 'shown while a quest is tracked');
  assert.match(chip.el.textContent, new RegExp(second.title));
  chip.el.click();
  assert.equal(book.isOpen(), true);
  assert.equal(book.page(), 1, 'opened on the tracked quest');
  const scrim = stage.querySelector('.book-scrim');
  assert.equal(scrim.hidden, false);
  assert.match(scrim.querySelector('.page-right').textContent, new RegExp(second.title));
  assert.match(scrim.querySelector('.page-right').textContent, /Tracking on the HUD/);
  // ← / → turn pages (instant without layout); the TOC jumps
  key('ArrowRight');
  assert.equal(book.page(), 2);
  key('ArrowLeft');
  assert.equal(book.page(), 1);
  scrim.querySelector('.toc button[data-page="0"]').click();
  assert.equal(book.page(), 0);
  assert.equal(scrim.querySelector('.book-nav.prev').disabled, true);
  // Track from the page, then the go button opens its tab and closes the book
  const goBtn = scrim.querySelector('.page-right .iactions').querySelectorAll('button')[1];
  goBtn.click();
  assert.deepEqual(opened, [[bk.quests[0].go.tab, bk.quests[0].go.sub || null]]);
  assert.equal(book.isOpen(), false);
  book.open();
  key('Escape');
  assert.equal(book.isOpen(), false, 'Esc closes');
  // × on the chip stops tracking
  chip.el.querySelector('.quest-chip-x').click();
  assert.equal(store.getItem(quests.TRACK_KEY), null);
  book.destroy();
  assert.equal(winL.length, 0, 'destroy removes the key handler');
  w.addEventListener = prevAdd;
  w.removeEventListener = prevRemove;
  store.map.clear();
});

test('C283: the Achievements tab shows the Quest book bookmark instead of Next goals', () => {
  store.map.clear();
  const s = newState(8);
  const d = makeDerived();
  const calls = [];
  const host = doc.createElement('div');
  const p = achPanel.createPanel(host, { game: { s, d }, questBook: { open: () => calls.push('open') } });
  p.update(s, d);
  assert.equal(host.querySelectorAll('.goal-row').length, 0, 'no Next goals rows');
  assert.match(host.querySelector('.sec-questbook .sec-title').textContent, /^Quest book Chapter [IVX]+ · /);
  assert.match(host.querySelector('.qb-bookmark').textContent, /quests? for this stage/);
  host.querySelector('.qb-bookmark .btn-primary').click();
  assert.deepEqual(calls, ['open']);
  p.destroy();
});
