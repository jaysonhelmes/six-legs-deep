// Interface pass 6 (ARCHITECTURE §18 C190–C197): event log (capture, filters, persistence, toast "Log" link), resource
// statistics (wallet flow log + tracker aggregation), queen lay-rate breakdown, bottleneck badge debounce, caste caps on
// the rail, run timer, the tab row's overflow state and the divider ratio between the two canvases.
// Uses the shared fake DOM in tests/fakedom.js. Owner: WP9.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument, FEvent } from './fakedom.js';
import { newState, makeDerived, makeFakeStorage } from './helpers.js';
import { spend, grant, refund, setFlowTag, getFlowTag, flowTotals, FLOW_LOG_SEC } from '../src/core/wallet.js';
import { step } from '../src/core/step.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const { mountUI, rowOverflow, clampSplit, loadSplitRatios, saveSplitRatios, splitTracks, SPLIT_KEY } = await import('../src/ui/app.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll } = await import('../src/ui/reveal.js');
const { createGame } = await import('../src/core/game.js');
const hud = await import('../src/ui/hud.js');
const { createEventLog, logEntryFor, fmtStamp, LOG_KEY, LOG_PERSIST, LOG_MAX } = await import('../src/ui/eventLog.js');
const rs = await import('../src/ui/resourceStats.js');
const { layBreakdown, layTipLines } = await import('../src/ui/layParts.js');
const { tipForKey } = await import('../src/ui/tooltips.js');
const { fmtRate, fmtMult } = await import('../src/ui/format.js');

before(() => { setRevealAll(true); });
after(() => {
  setRevealAll(false);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

function mount({ storage = null } = {}) {
  uistate.resetUI();
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  const win = doc.defaultView;
  const prev = win.localStorage;
  win.localStorage = storage || undefined;
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  const ui = mountUI(root, game, { loadRender: false });
  ui.frame(1000);
  const done = () => { ui.destroy(); if (root.parentNode) root.parentNode.removeChild(root); win.localStorage = prev; };
  return { root, game, ui, done };
}

// ------------------------------------------------------------------------------------------------ event log (C190)
test('C190 event log: entries for events (choice + outcome), raids, blueprints, water, milestones; filters; folding', () => {
  const s = newState(1);
  const resolved = logEntryFor({ type: 'eventResolved', eventId: 'ev_wandering_queen', choice: 'adopt', outcomeText: 'She lays for the colony.' }, s);
  assert.equal(resolved.cat, 'events');
  assert.match(resolved.text, /Adopt — She lays for the colony\./);
  assert.match(logEntryFor({ type: 'eventResolved', id: 'ev_fallen_fruit', choice: 'harvested' }, s).text, /Harvested/);
  assert.equal(logEntryFor({ type: 'raidResult', win: false, foodLost: 12, broodLost: 1, workersLost: 2 }, s).cat, 'war');
  assert.equal(logEntryFor({ type: 'blueprintPlaced', n: 4 }, s).text, 'Blueprint laid out: 4 planned chambers.');
  assert.equal(logEntryFor({ type: 'blueprintAdjusted', text: 'The Granary moved one cell left' }, s).text, 'The Granary moved one cell left.');
  assert.equal(logEntryFor({ type: 'waterStruck', y: 30 }, s).cat, 'nest');
  assert.equal(logEntryFor({ type: 'achievement', id: 'ach_first_steps' }, s).cat, 'progress');
  assert.equal(logEntryFor({ type: 'flightComplete', alates: 12 }, s).cat, 'prestige');
  assert.equal(logEntryFor({ type: 'hexRevealed', hex: 3 }, s), null, 'not log-worthy');
  assert.equal(logEntryFor({ type: 'chamberActivated', level: 2, chamberType: 'gallery' }, s), null, 'level-ups stay out of the log');

  const log = createEventLog();
  log.add({ t: 10, run: 0, ...resolved });
  log.add({ t: 20, run: 0, cat: 'war', text: 'Raid repelled.', kind: 'good' });
  log.add({ t: 20.5, run: 0, cat: 'war', text: 'Raid repelled.', kind: 'good' });   // folded into ×2
  assert.equal(log.size(), 2);
  assert.equal(log.entries()[0].text, 'Raid repelled.', 'newest first');
  assert.equal(log.entries()[0].n, 2);
  assert.deepEqual(log.entries('events').map((e) => e.cat), ['events']);
  assert.equal(log.counts().war, 1);
  assert.equal(log.add({ t: 1, cat: 'nope', text: 'x' }), null, 'unknown category refused');
  for (let i = 0; i < LOG_MAX + 30; i++) log.add({ t: 100 + i * 2, run: 0, cat: 'progress', text: 'Unlocked ' + i + '.', kind: 'info' });
  assert.equal(log.size(), LOG_MAX, 'keeps the newest LOG_MAX in memory');
  assert.equal(fmtStamp(65), '1:05');
  assert.equal(fmtStamp(4445), '1:14:05');
});

test('C190 event log: the newest LOG_PERSIST entries persist per colony in localStorage; another colony starts empty', () => {
  const storage = makeFakeStorage();
  const log = createEventLog({ storage });
  for (let i = 0; i < 80; i++) log.add({ t: i * 3, run: 1, cat: 'events', text: 'Event ' + i + '.', kind: 'event' });
  assert.ok(log.isDirty());
  assert.equal(log.persist(777), true);
  assert.equal(log.isDirty(), false);
  const stored = JSON.parse(storage.getItem(LOG_KEY));
  assert.equal(stored.colony, 777);
  assert.equal(stored.entries.length, LOG_PERSIST);
  assert.ok(storage.getItem(LOG_KEY).length < 6000, 'small');
  const again = createEventLog({ storage });
  assert.equal(again.load(777), LOG_PERSIST);
  assert.equal(again.entries()[0].text, 'Event 79.');
  assert.equal(createEventLog({ storage }).load(778), 0, 'a different colony does not inherit the log');
  const broken = createEventLog({ storage: makeFakeStorage({}, new Set(['get', 'set'])) });
  broken.add({ t: 1, cat: 'war', text: 'x', kind: 'bad' });
  assert.equal(broken.persist(1), false, 'blocked storage is harmless');
  assert.equal(broken.load(1), 0);
});

test('C190 shell: bus events land in the log; an event outcome toasts with a "Log" link that opens the log at the entry', () => {
  const { root, game, ui, done } = mount();
  game.s.run.time = 75;
  game.bus.emit('raidResult', { type: 'raidResult', uid: 1, win: true });
  game.bus.emit('eventResolved', { type: 'eventResolved', uid: 3, eventId: 'ev_wandering_queen', id: 'ev_wandering_queen', choice: 'adopt',
    outcomeText: 'A second queen lays beside yours.' });
  game.bus.emit('blueprintPlaced', { type: 'blueprintPlaced', n: 3 });
  const list = ui.eventLog.entries();
  assert.deepEqual(list.map((e) => e.cat), ['nest', 'events', 'war']);
  assert.equal(list[1].t, 75, 'stamped with the run time');
  ui.frame(1100);
  const toast = root.querySelectorAll('.toast').find((x) => /second queen/.test(x.textContent));
  assert.ok(toast, 'outcome toast');
  const link = toast.querySelector('.toast-link');
  assert.ok(link && link.textContent === 'Log');
  link.click();
  const modal = root.querySelector('.modal-log');
  assert.ok(modal, 'log modal open');
  assert.ok(modal.querySelector('.log-chip.active[data-cat="events"]'), 'filtered to events');
  assert.ok(modal.querySelector('.log-row.highlight'), 'the entry is highlighted');
  assert.equal(modal.querySelectorAll('.log-row').length, 1);
  modal.querySelector('.log-chip[data-cat="all"]').click();
  assert.equal(modal.querySelectorAll('.log-row').length, 3);
  // the Log icon in the tab row opens it too
  ui.modals.closeAll();
  root.querySelector('.log-btn').click();
  assert.ok(root.querySelector('.modal-log'));
  ui.modals.closeAll();
  done();
});

// ------------------------------------------------------------------------------------------------ resource stats (C191)
test('C191 wallet flow log: spends and grants are recorded per flow tag in one-second buckets; refunds count as income', () => {
  const s = newState(2);
  const d = makeDerived();
  d.stats.foodCap = 1e6;
  s.run.res.food = 1000;
  s.run.time = 10.2;
  assert.equal(setFlowTag('cmd:buyAdaptation'), null);
  assert.equal(getFlowTag(), 'cmd:buyAdaptation');
  assert.ok(spend(s, { food: 100 }));
  setFlowTag('population');
  s.run.time = 11.5;
  spend(s, { food: 30 });
  setFlowTag('events');
  grant(s, d, 'food', 50);
  setFlowTag(null);
  refund(s, d, { food: 20 });
  spend(s, { food: 5 });                 // untagged → 'other'
  const ft = flowTotals(s, 60);
  assert.deepEqual(ft.spend.food, { 'cmd:buyAdaptation': 100, population: 30, other: 5 });
  assert.deepEqual(ft.grant.food, { events: 50, refund: 20 });
  assert.ok(Math.abs(ft.sec - 11.5) < 1e-9);
  // old buckets fall out of the window
  s.run.time = 11.5 + FLOW_LOG_SEC + 5;
  assert.deepEqual(flowTotals(s, 60).spend, {});
  // a new run object starts empty
  const s2 = newState(3);
  assert.deepEqual(flowTotals(s2).spend, {});
});

test('C191 step tags: a command\'s spend or grant carries cmd:<type>, the tag is cleared after the step', () => {
  const s = newState(4);
  const d = makeDerived();
  step(s, d, 0);
  const src = s.run.surface.sources.find((x) => x && s.run.surface.revealed[x.hex] === 1);
  assert.ok(src, 'a revealed starting source');
  step(s, d, 0.1, [{ type: 'clickForage', src: src.uid }]);
  const ft = flowTotals(s);
  assert.ok(ft.grant.food && ft.grant.food['cmd:clickForage'] > 0, 'click income tagged');
  assert.equal(getFlowTag(), null);
});

test('C191 tracker: continuous income by label (trails split by source type), upkeep, one-shots by category, top-3 tooltip lines', () => {
  const s = newState(5);
  const d = makeDerived();
  const uid = s.run.surface.sources[0].uid;
  s.run.surface.trails = [{ uid: 9, src: uid, job: 'forager' }];
  s.run.surface.sources[0].type = 'seed_patch';
  d.surface.trails = [{ uid: 9, res: 'food', out: 4 }];
  d.rates.food = { raw: 5, gross: 5, net: 3, upkeep: 2, clicks: 0, sc: false, src: { trails: 4, loose: 1 } };
  d.stats.foodCap = 1e6;
  s.run.res.food = 100;
  const tr = rs.createResourceTracker();
  for (let i = 0; i <= 40; i++) {
    s.run.time = i * 0.5;
    if (i === 10) { setFlowTag('population'); spend(s, { food: 10 }); setFlowTag('cmd:clickForage'); grant(s, d, 'food', 4); setFlowTag(null); }
    s.run.res.food += 3 * 0.5;
    tr.sample(s, d);
  }
  const b = tr.breakdown(s, d, 'food');
  const get = (list, key) => (list.find((x) => x.key === key) || {}).rate || 0;
  assert.ok(Math.abs(get(b.inflow, 'trail:seed_patch') - 4) < 1e-6, 'trail income by source type');
  assert.ok(Math.abs(get(b.inflow, 'src:loose') - 1) < 1e-6);
  assert.ok(Math.abs(get(b.outflow, 'upkeep') - 2) < 1e-6);
  assert.ok(get(b.outflow, 'eggs') > 0, 'egg spending from the flow log');
  assert.ok(get(b.inflow, 'clicks') > 0, 'clicks from the flow log');
  assert.equal(b.inflow[0].label, rs.flowName('trail:seed_patch'), 'biggest first');
  assert.equal(rs.spendCategory('cmd:levelChamber'), 'chambers');
  assert.equal(rs.spendCategory('cmd:buyResearch'), 'research');
  assert.equal(rs.grantCategory('rivals'), 'loot');
  rs.setActiveTracker(tr);
  const lines = rs.topFlowLines(s, d, 'food', fmtRate);
  assert.match(lines[0], /^In: /);
  assert.match(lines[1], /^Out: /);
  const tip = tipForKey('res:food', s, d);
  assert.ok(tip.lines.some((l) => l.startsWith('In: ')), 'resource tooltip shows the top sources');
  rs.setActiveTracker(null);
  // a new run starts a fresh window
  const s2 = newState(6);
  tr.sample(s2, d);
  assert.equal(tr.size(), 1);
});

test('C191 Stats tab: per-resource table with bars, resource chips, Event log button', () => {
  const { root, game, ui, done } = mount();
  game.d.rates.food = { raw: 2, gross: 2, net: 1, upkeep: 1, clicks: 0, sc: false, src: { loose: 2 } };
  for (let i = 0; i < 12; i++) { game.s.run.time = i; ui.frame(1000 + 300 * (i + 1)); }
  ui.openTab('stats');
  ui.refresh();
  const sec = root.querySelector('.res-flows');
  assert.ok(sec, 'flows section');
  assert.match(sec.querySelector('.flow-in').textContent, /Loose foraging/);
  assert.match(sec.querySelector('.flow-out').textContent, /Upkeep/);
  assert.ok(sec.querySelector('.flow-bar-fill'));
  assert.ok(sec.querySelector('.flow-chip[data-res="soil"]'));
  const btn = root.querySelectorAll('button').find((b) => b.textContent === 'Open event log');
  btn.click();
  assert.ok(root.querySelector('.modal-log'));
  ui.modals.closeAll();
  done();
});

// ------------------------------------------------------------------------------------------------ lay rate (C192)
test('C192 lay-rate tooltip: uses d.stats.layParts (queens + multipliers) and falls back to a UI mirror that ends on the real rate', () => {
  const s = newState(7);
  const d = makeDerived();
  d.stats.layRate = 0.6;
  d.stats.layParts = [{ label: 'Queen (Royal Chamber L3)', add: 0.3, value: 0.3 }, { label: 'Royal Pheromones', mult: 2, value: 2 }];
  const b = layBreakdown(s, d);
  assert.equal(b.source, 'stats');
  const lines = layTipLines(b, { fmtRate, fmtMult });
  assert.ok(lines.some((l) => /Queen \(Royal Chamber L3\)/.test(l)));
  assert.ok(lines.some((l) => /Royal Pheromones ×2/.test(l)));
  assert.match(lines[lines.length - 1], /^= /);
  // fallback (no layParts): the product closes on layRate through "Other effects" when needed
  delete d.stats.layParts;
  d.nest.agg.royal = [1];
  d.stats.layRate = 0.5;
  const f = layBreakdown(s, d);
  assert.equal(f.source, 'ui');
  let prod = 0;
  for (const p of f.parts) if (p.kind === 'base') prod += p.value;
  for (const p of f.parts) if (p.kind === 'mult') prod *= p.value;
  assert.ok(Math.abs(prod - 0.5) < 1e-6, 'parts multiply to the real lay rate');
  const tip = tipForKey('lay', s, d);
  assert.match(tip.title, /Lay rate/);
});

// ------------------------------------------------------------------------------------------------ ant caps (C193)
test('C193 ant breakdown: each caste shows its cap (housing, berths, War Hall berths, replete berths, alate cells)', () => {
  const s = newState(8);
  const d = makeDerived();
  Object.assign(s.run.colony.adults, { minor: 1200, soldier: 143, supermajor: 5, replete: 7 });
  s.run.colony.alatesReared = 3;
  Object.assign(d.stats, { housing: 1500, berths: 176, warBerths: 8, repleteBerths: 10, alateCells: 15 });
  const parts = hud.antBreakdown(s, d);
  const by = Object.fromEntries(parts.map((p) => [p.id, p]));
  assert.deepEqual([by.minor.cap, by.minor.unit], [1500, 'housing']);
  assert.deepEqual([by.soldier.cap, by.soldier.unit], [176, 'berths']);
  assert.deepEqual([by.supermajor.cap, by.supermajor.unit], [8, 'War Hall berths']);
  assert.deepEqual([by.replete.cap, by.replete.unit], [10, 'replete berths']);
  assert.deepEqual([by.alate.cap, by.alate.unit], [15, 'cells']);
  assert.equal(by.queen.cap, null);
  delete d.stats.warBerths;
  assert.equal(hud.antBreakdown(s, d).find((p) => p.id === 'supermajor').unit, 'berths', 'no War Hall field: shares the Barracks berths');
  const { root, game, ui, done } = mount();
  Object.assign(game.s.run.colony.adults, { minor: 1200, soldier: 143 });
  Object.assign(game.d.stats, { housing: 1500, berths: 176 });
  ui.refresh();
  assert.match(root.querySelector('.pop-minor .res-val').textContent, /1\.20K \/ 1\.50K housing/);
  assert.match(root.querySelector('.pop-soldier .res-val').textContent, /143 \/ 176 berths/);
  done();
});

// ------------------------------------------------------------------------------------------------ bottleneck badge (C194)
test('C194 bottleneck debounce: 3 s before switching, timer kept through transient flips, urgent and first limits at once', () => {
  const db = hud.createBottleneckDebounce(3);
  assert.deepEqual(db.update('bn_housing', 10, 4), { id: 'bn_housing', since: 4 }, 'first value adopted');
  assert.equal(db.update('bn_food', 11, 11).id, 'bn_housing', 'a new limit waits');
  assert.deepEqual(db.update('bn_housing', 12, 12), { id: 'bn_housing', since: 4 }, 'a transient flip keeps the original timer');
  db.update('bn_food', 13, 13);
  assert.equal(db.update('bn_food', 15.9, 13).id, 'bn_housing');
  assert.deepEqual(db.update('bn_food', 16, 13), { id: 'bn_food', since: 13 }, 'switches after 3 s, timed from its own start');
  assert.equal(db.update('hungry', 16.5, 16.5).id, 'hungry', 'urgent limits show at once');
  db.update(null, 17, 17);
  assert.equal(db.update(null, 20.5, 17).id, null, 'no bottleneck after the debounce');
  assert.equal(db.update('bn_lay_rate', 21, 21).id, 'bn_lay_rate', 'a limit replacing "No bottleneck" shows at once');
  assert.equal(db.update('bn_food', 5, 5).id, 'bn_food', 'run time going back (new run / load) starts over');
  assert.deepEqual(hud.bottleneckParts(null, 0), { label: 'No bottleneck', time: '' });
  assert.deepEqual(hud.bottleneckParts('bn_housing', 34), { label: 'Bottleneck: Housing · eggs blocked', time: '34s' });
});

test('C194 badge: "No bottleneck" state, the timer in its own slot, debounced in the shell', () => {
  const { root, game, ui, done } = mount();
  game.s.run.time = 50;
  game.s.run.bottleneck = { id: null, since: 0 };
  ui.refresh();
  const badge = root.querySelector('.bn-badge');
  assert.ok(badge && !badge.hidden);
  assert.equal(badge.querySelector('.bn-name').textContent, 'No bottleneck');
  assert.ok(badge.classList.contains('bn-none'));
  game.s.run.bottleneck = { id: 'bn_housing', since: 40 };
  ui.refresh();
  assert.match(badge.querySelector('.bn-name').textContent, /Housing/);
  assert.equal(badge.querySelector('.bn-time').textContent, '10s');
  game.s.run.time = 51;
  game.s.run.bottleneck = { id: 'bn_food', since: 51 };
  ui.refresh();
  assert.match(badge.querySelector('.bn-name').textContent, /Housing/, 'still Housing during the debounce');
  done();
});

// ------------------------------------------------------------------------------------------------ run timer (C196)
test('C196 run timer beside "Year · run"', () => {
  const s = newState(9);
  s.run.time = 4440;
  assert.equal(hud.runTimeText(s), '1h 14m');
  s.run.time = 754;
  assert.equal(hud.runTimeText(s), '12m');
  s.meta.pending = { kind: 'landing' };
  assert.equal(hud.runTimeText(s), '', 'nothing while landing');
  const { root, game, ui, done } = mount();
  game.s.run.time = 4440;
  ui.refresh();
  assert.equal(root.querySelector('.brand-time').textContent, '1h 14m');
  done();
});

// ------------------------------------------------------------------------------------------------ tab row (C197)
test('C197 tab row: overflow classes (fade edges) when the row scrolls; icon buttons carry names and aria-labels', () => {
  assert.deepEqual(rowOverflow({ scrollLeft: 0, scrollWidth: 900, clientWidth: 375 }), { scrolls: true, left: false, right: true });
  assert.deepEqual(rowOverflow({ scrollLeft: 525, scrollWidth: 900, clientWidth: 375 }), { scrolls: true, left: true, right: false });
  assert.deepEqual(rowOverflow({ scrollLeft: 0, scrollWidth: 300, clientWidth: 375 }), { scrolls: false, left: false, right: false });
  const { root, ui, done } = mount();
  const tabs = root.querySelector('#tabs');
  tabs.scrollWidth = 900;
  tabs.clientWidth = 375;
  tabs.scrollLeft = 100;
  ui.refresh();
  assert.ok(tabs.classList.contains('scrolls'));
  assert.ok(tabs.classList.contains('fade-left') && tabs.classList.contains('fade-right'));
  tabs.scrollWidth = 300;
  ui.refresh();
  assert.ok(!tabs.classList.contains('scrolls') && !tabs.classList.contains('fade-right'));
  for (const b of root.querySelectorAll('.tab.util')) {
    assert.ok(b.getAttribute('aria-label'), 'icon button has an aria-label');
    assert.ok(b.querySelector('.tab-label') && b.querySelector('.tab-label').textContent, 'and a visible name for hover / focus');
    assert.ok(b.dataset.tip, 'and a tooltip');
  }
  done();
});

// ------------------------------------------------------------------------------------------------ divider (C197)
test('C197 divider: ratio clamped to min sizes, persisted per browser (try/catch), applied as grid tracks, reset clears', () => {
  assert.equal(clampSplit(0.95, 1000), 0.85);
  assert.equal(clampSplit(0.05, 400), 0.3, '120 px minimum of 400 px');
  assert.equal(clampSplit(NaN, 0), 0.5);
  assert.deepEqual(splitTracks(0.6), { above: 'minmax(0, 600fr)', below: 'minmax(0, 400fr)' });
  const storage = makeFakeStorage();
  assert.equal(saveSplitRatios(storage, { split: 0.62, side: 0.4 }), true);
  assert.deepEqual(loadSplitRatios(storage), { split: 0.62, side: 0.4 });
  assert.deepEqual(loadSplitRatios(makeFakeStorage({ [SPLIT_KEY]: '{bad' })), {});
  assert.deepEqual(loadSplitRatios(makeFakeStorage({}, new Set(['get']))), {});
  assert.equal(saveSplitRatios(makeFakeStorage({}, new Set(['set'])), { split: 0.5 }), false);
  saveSplitRatios(storage, {});
  assert.equal(storage.getItem(SPLIT_KEY), null, 'nothing custom: key removed');
  // the shell applies a stored ratio in the stacked view and a double-click resets it
  const st2 = makeFakeStorage({ [SPLIT_KEY]: JSON.stringify({ split: 0.7 }) });
  const { root, ui, done } = mount({ storage: st2 });
  uistate.setUI({ view: 'split' });
  ui.refresh();
  assert.equal(root.style['--above-track'], 'minmax(0, 700fr)');
  assert.equal(root.style['--below-track'], 'minmax(0, 300fr)');
  const strip = root.querySelector('#flow-strip');
  assert.equal(strip.getAttribute('role'), 'separator');
  strip.dispatchEvent(new FEvent('dblclick'));
  assert.equal(st2.getItem(SPLIT_KEY), null, 'double-click returns to the default split and forgets it');
  assert.equal(root.getAttribute('data-resized'), 'false');
  done();
});
