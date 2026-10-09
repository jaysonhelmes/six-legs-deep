// Feedback pass 7 — Colony / Prestige player requests (ARCHITECTURE §18 C229–C233): foldable Colony sections (C229),
// the job +/− step ("Per click 1 · 10 · 100 · Max", clamped to the workforce, back to 1 on a new run; C230), the nurse
// cap of 4 per brood slot with the queen counting as one (C231), cancelling the alate rearing queue and its price, plus
// the Flight Day line (C232), and the caste upkeep lines (C233). Uses the shared fake DOM in tests/fakedom.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument, FEvent } from './fakedom.js';
import { newState, makeDerived, fakeEnv, makeFakeStorage } from './helpers.js';
import { recompute, eggCost } from '../src/systems/stats.js';
import { handlers as popH, alateQueueCost } from '../src/systems/population.js';
import { handlers as jobsH, jobCap, nurseCap, tick as jobsTick } from '../src/systems/jobs.js';
import { CASTES } from '../src/data/castes.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;
const store = makeFakeStorage();
doc.defaultView.localStorage = store;

const common = await import('../src/ui/panels/common.js');
const colonyPanel = await import('../src/ui/panels/colony.js');
const prestigePanel = await import('../src/ui/panels/prestige.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
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

/** A colony with `minors` minor workers (all foragers), stats recomputed (3 brood slots). */
function world(minors = 50) {
  const s = newState(7);
  const d = makeDerived();
  for (const k of ['panel_colony', 'job_digger', 'job_scout', 'caste_soldier', 'caste_supermajor', 'caste_replete', 'panel_war', 'alate_rearing']) {
    s.run.unlocked[k] = true;
  }
  s.run.colony.adults.minor = minors;
  s.run.colony.jobs.forager = minors;
  d.nest.agg.housingBase = 1e6;
  recompute(s, d, fakeEnv());
  return { s, d };
}

/** Colony panel on a game whose commands run the real handlers. */
function mountColony(s, d) {
  const rejects = [];
  const calls = [];
  const game = { s, d, actions: { do: (type, args) => {
    calls.push({ type, args });
    const r = cmd(s, d, type, args);
    if (r) rejects.push(r);
    return r ? { ok: false, reason: r } : { ok: true };
  } } };
  const root = doc.createElement('div');
  const p = colonyPanel.createPanel(root, { game, ui: { getUI: () => ({}) }, bridge: { reject() {} } });
  p.update(s, d);
  return { root, p, rejects, calls, refresh: () => p.update(s, d) };
}
// C282: jobs are two-line rows (.job-row) with stacked +/− buttons (.jb-step.up / .jb-step.down)
const chip = (root, id) => root.querySelector('.job-row[data-job="' + id + '"]');

// ------------------------------------------------------------------------------------------------ C229
test('C229: readCollapsed / writeCollapsed survive missing, broken and failing storage', () => {
  assert.deepEqual(common.readCollapsed(null), {});
  assert.deepEqual(common.readCollapsed(makeFakeStorage({ [common.COLLAPSE_KEY]: 'not json' })), {});
  assert.deepEqual(common.readCollapsed(makeFakeStorage({ [common.COLLAPSE_KEY]: '[1,2]' })), {});
  const bad = makeFakeStorage({}, new Set(['get', 'set']));
  assert.doesNotThrow(() => common.writeCollapsed('x', true, bad));
  assert.deepEqual(common.readCollapsed(bad), {});
  const ok = makeFakeStorage();
  common.writeCollapsed('a', true, ok);
  common.writeCollapsed('b', true, ok);
  common.writeCollapsed('a', false, ok);
  assert.deepEqual(common.readCollapsed(ok), { b: true });
});

test('C229: Colony sections fold by their heading (click or Enter) and stay folded per browser', () => {
  store.map.clear();
  const { s, d } = world(20);
  const m = mountColony(s, d);
  const secs = ['sec-brood', 'sec-castes', 'sec-jobs'].map((c) => m.root.querySelector('.' + c));
  for (const sec of secs) {
    const t = sec.querySelector('.sec-title');
    assert.ok(t.classList.contains('sec-toggle'), sec.className + ' heading is a toggle');
    assert.equal(t.getAttribute('role'), 'button');
    assert.equal(t.getAttribute('aria-expanded'), 'true');
    assert.equal(sec.classList.contains('collapsed'), false);
  }
  const jobs = secs[2];
  const title = jobs.querySelector('.sec-title');
  title.click();
  assert.equal(jobs.classList.contains('collapsed'), true);
  assert.equal(title.getAttribute('aria-expanded'), 'false');
  assert.ok(jobs.classList.contains('fold'), 'C280: CSS chevron (the section is a fold)');
  assert.deepEqual(JSON.parse(store.getItem(common.COLLAPSE_KEY)), { 'colony:jobs': true });
  // a new panel (reload) starts folded
  const m2 = mountColony(s, d);
  assert.equal(m2.root.querySelector('.sec-jobs').classList.contains('collapsed'), true);
  assert.equal(m2.root.querySelector('.sec-brood').classList.contains('collapsed'), false);
  // Enter unfolds and forgets
  const t2 = m2.root.querySelector('.sec-jobs .sec-title');
  t2.dispatchEvent(new FEvent('keydown', { key: 'Enter' }));
  assert.equal(m2.root.querySelector('.sec-jobs').classList.contains('collapsed'), false);
  assert.deepEqual(JSON.parse(store.getItem(common.COLLAPSE_KEY)), {});
  // other keys do nothing
  t2.dispatchEvent(new FEvent('keydown', { key: 'a' }));
  assert.equal(m2.root.querySelector('.sec-jobs').classList.contains('collapsed'), false);
  store.map.clear();
});

// ------------------------------------------------------------------------------------------------ C230
test('C230: effectiveStep clamps to the workforce; stepLabel shows the step', () => {
  const { effectiveStep, stepLabel } = colonyPanel;
  assert.equal(effectiveStep(100, 5), 1);
  assert.equal(effectiveStep(100, 42), 10);
  assert.equal(effectiveStep(10, 12), 10);
  assert.equal(effectiveStep(100, 250), 100);
  assert.equal(effectiveStep(10, 0), 1);
  assert.equal(effectiveStep('max', 1), 'max');
  assert.equal(stepLabel('+', 10), '+10');
  assert.equal(stepLabel('−', 1), '−1');
  assert.equal(stepLabel('+', 'max'), '+Max');
});

test('C230: job +/− show the step, steps above the workforce are greyed, and a new run resets the step to 1', () => {
  const { s, d } = world(5);
  const m = mountColony(s, d);
  const seg = (v) => m.root.querySelector('.job-step .seg-btn[data-step="' + v + '"]');
  assert.ok(m.root.querySelector('.job-step-label'), '"Per click" label');
  assert.equal(seg('10').disabled, true, '10 > 5 workers: greyed');
  assert.equal(seg('100').disabled, true);
  assert.equal(seg('max').disabled, false);
  const dig = chip(m.root, 'digger');
  const minus = dig.querySelector('.jb-step.down');
  const plus = dig.querySelector('.jb-step.up');
  assert.equal(plus.textContent, '+1');
  assert.equal(minus.textContent, '−1');
  assert.equal(plus.title, 'Move 1 forager to Digger');
  // a bigger colony: 10 applies and the buttons say so
  s.run.colony.adults.minor = 50;
  s.run.colony.jobs.forager = 50;
  m.refresh();
  seg('10').click();
  m.refresh();
  assert.equal(seg('10').classList.contains('selected'), true);
  assert.equal(plus.textContent, '+10');
  plus.click();
  assert.equal(s.run.colony.jobs.digger, 10, 'moved 10 (from foragers: nobody idle)');
  assert.equal(s.run.colony.jobs.forager, 40);
  m.refresh();
  assert.equal(minus.title, 'Move 10 diggers to idle');
  // workforce drops below the step: 1 applies (the choice is kept for later)
  s.run.colony.adults.minor = 8;
  s.run.colony.jobs = { forager: 0, digger: 8, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  m.refresh();
  assert.equal(plus.textContent, '+1');
  assert.equal(seg('1').classList.contains('selected'), true);
  s.run.colony.adults.minor = 50;
  m.refresh();
  assert.equal(plus.textContent, '+10', 'the chosen step returns with the workforce');
  // a new run (Flight): back to 1
  s.meta.counters.runs = (s.meta.counters.runs || 0) + 1;
  m.refresh();
  assert.equal(plus.textContent, '+1');
  // Max
  seg('max').click();
  m.refresh();
  assert.equal(plus.textContent, '+Max');
  // auto mode: the buttons say ±5 %
  s.run.colony.autoJobs = true;
  m.refresh();
  assert.equal(plus.textContent, '+5%');
  assert.equal(m.root.querySelector('.job-step').hidden, true);
});

// ------------------------------------------------------------------------------------------------ C231
test('C231: nurse cap = ceil(4 × brood slots − 1) (the queen is a nurse); extra nurses would not change brood speed', () => {
  const { s, d } = world(100);
  assert.equal(d.stats.broodSlots, 3);
  assert.equal(jobCap(s, d, 'nurse'), 11);
  assert.equal(nurseCap(s, { stats: { broodSlots: 2.5 } }), 9);
  assert.equal(nurseCap(s, { stats: {} }), Infinity, 'no stat: uncapped');
  s.run.research.field_triage = 1;
  assert.equal(nurseCap(s, { stats: { broodSlots: 1 } }), 5, 'never below Field Triage\'s 5 nurses');
  delete s.run.research.field_triage;
  // brood speed: the cap is exactly where nurseTerm stops rising
  const term = (n) => { s.run.colony.jobs.nurse = n; s.run.colony.jobs.forager = 100 - n; recompute(s, d, fakeEnv()); return d.stats.nurseTerm; };
  const atCap = term(11);
  assert.ok(term(10) < atCap, 'the last capped nurse still helps');
  assert.equal(term(12), atCap, 'one more does nothing');
  assert.equal(term(40), atCap);
  s.run.colony.jobs = { forager: 100, digger: 0, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  recompute(s, d, fakeEnv());
  // manual moves stop at the cap
  assert.equal(cmd(s, d, 'shiftJob', { from: 'forager', to: 'nurse', n: 50 }), null);
  assert.equal(s.run.colony.jobs.nurse, 11);
  assert.equal(cmd(s, d, 'shiftJob', { from: 'forager', to: 'nurse', n: 1 }), 'max');
  assert.equal(cmd(s, d, 'setJobs', { jobs: { nurse: 12 } }), 'max');
  // auto mode: a 50 % nurse target stops at the cap, the rest is foraged
  s.run.research.age_polyethism = 1;
  s.run.colony.autoJobs = true;
  s.run.colony.jobTargets = { forager: 0.5, digger: 0, nurse: 0.5, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  s.run.time = 4.95;
  jobsTick(s, d, 0.1, fakeEnv());
  assert.equal(s.run.colony.jobs.nurse, 11);
  assert.ok(Math.abs(s.run.colony.jobs.forager - 89) < 1e-9, 'surplus foraged: ' + s.run.colony.jobs.forager);
});

test('C231: the nurse row shows "/ cap" with a tooltip; over-cap counts are flagged', () => {
  const { s, d } = world(100);
  const m = mountColony(s, d);
  const n = chip(m.root, 'nurse');
  const cap = n.querySelector('.job-cap');
  assert.equal(cap.textContent, '/ 11');
  assert.match(cap.title, /4 per brood slot \(3 slots\), and the queen counts as one/);
  assert.match(cap.title, /would not speed brood/);
  s.run.colony.jobs.nurse = 14;
  s.run.colony.jobs.forager = 86;
  m.refresh();
  assert.equal(cap.classList.contains('over'), true);
  assert.match(cap.title, /3 extra nurses do nothing/);
  const plus = n.querySelector('.jb-step.up');
  assert.match(plus.title, /Nurse cap reached/);
  plus.click();
  assert.deepEqual(m.rejects, ['max']);
});

// ------------------------------------------------------------------------------------------------ C232
test('C232: alateQueueCost prices the next n alates after the laid and the queued ones; cancelRear is free', () => {
  const { s, d } = world(50);
  const hd = CASTES.alate.extra.honeydew;
  s.run.colony.eggs.alate = 2;
  const per = eggCost(s, d, 'alate');
  let c1 = alateQueueCost(s, d, 1);
  assert.ok(Math.abs(c1.food - per.food) < 1e-9);
  assert.ok(Math.abs(c1.honeydew - hd.base * hd.growth ** 2) < 1e-9);
  const c5 = alateQueueCost(s, d, 5);
  let sum = 0;
  for (let k = 2; k < 7; k++) sum += hd.base * hd.growth ** k;
  assert.ok(Math.abs(c5.honeydew - sum) < 1e-9, 'rising honeydew per alate');
  assert.ok(Math.abs(c5.food - 5 * per.food) < 1e-9);
  s.run.colony.rearRequested = 3;
  c1 = alateQueueCost(s, d, 1);
  assert.ok(Math.abs(c1.honeydew - hd.base * hd.growth ** 5) < 1e-9, 'continues after the 3 queued');
  s.meta.automation.autoRear = true;
  assert.ok(Math.abs(alateQueueCost(s, d, 1).honeydew - hd.base * hd.growth ** 2) < 1e-9, 'auto-rear ignores the queue');
  s.meta.automation.autoRear = false;
  // cancel
  const res = JSON.stringify(s.run.res);
  assert.equal(cmd(s, d, 'cancelRear', { n: 0 }), 'invalid');
  assert.equal(cmd(s, d, 'cancelRear', { n: 1.5 }), 'invalid');
  assert.equal(cmd(s, d, 'cancelRear', { n: 2 }), null);
  assert.equal(s.run.colony.rearRequested, 1);
  assert.equal(cmd(s, d, 'cancelRear', {}), null);
  assert.equal(s.run.colony.rearRequested, 0);
  assert.equal(cmd(s, d, 'cancelRear', {}), 'invalid:empty');
  assert.equal(JSON.stringify(s.run.res), res, 'no refund needed: nothing was paid');
});

test('C232: Prestige → Flight shows the queue price, Cancel queued, and Flight Day explained on the weather row', () => {
  const { s, d } = world(50);
  d.stats.alateCells = 10;
  s.run.colony.rearRequested = 0;
  const calls = [];
  const ctx = { game: { s, d, actions: { do: (type, args) => { calls.push({ type, args }); return { ok: true }; } } },
    ui: uistate, bridge: { reject() {} } };
  uistate.resetUI();
  const host = doc.createElement('div');
  const p = prestigePanel.createPanel(host, ctx);
  p.update(s, d);
  const sec = host.querySelector('.sec-alates');
  const btn = (t) => sec.querySelectorAll('button').find((b) => b.textContent.startsWith(t));
  assert.equal(btn('Cancel queued').hidden, true, 'nothing queued: no Cancel');
  assert.match(btn('Rear 1').title, /Queue 1 alate: about .* food \+ .* honeydew/);
  assert.match(btn('Rear 5').title, /Nothing is paid now/);
  assert.match(sec.querySelector('.rear-queue-cost').textContent, /Queue 1: .*Queue 5: /);
  s.run.colony.rearRequested = 4;
  p.update(s, d);
  const cancel = btn('Cancel queued');
  assert.equal(cancel.hidden, false);
  assert.equal(cancel.textContent, 'Cancel queued (4)');
  cancel.click();
  assert.deepEqual(calls.at(-1), { type: 'cancelRear', args: {} });
  const weather = host.querySelector('.ff-row[data-id="weather"]');
  assert.ok(weather, 'weather factor row');
  const line = prestigePanel.flightDayLine();
  assert.match(line, /Flight Day/);
  assert.match(line, /summer/);
  assert.match(line, /×1\.5 alates for 3 min/);
  assert.equal(weather.querySelector('.ff-extra').textContent, line);
  assert.match(weather.dataset.tip, /Flight Day/, 'tooltip: the Manual Flight Day text');
  assert.equal(weather.dataset.tip, prestigePanel.flightDayTip());
  p.destroy();
});

// ------------------------------------------------------------------------------------------------ C233
test('C233: caste rows show their food upkeep; the army upkeep line shows the cost of full berths', () => {
  const { casteUpkeep, casteUpkeepLine, armyUpkeep } = colonyPanel;
  assert.deepEqual(casteUpkeep('soldier', 12), { each: CASTES.soldier.upkeep, total: 12 * CASTES.soldier.upkeep });
  assert.equal(casteUpkeepLine('supermajor', 3), 'Upkeep 1.0 food/s each · 3.0 food/s for 3');
  const a = armyUpkeep({ minor: 100, soldier: 20, supermajor: 0, replete: 0 });
  assert.ok(Math.abs(a.total - 20 * CASTES.soldier.upkeep) < 1e-9);
  assert.ok(Math.abs(a.share - a.total / (a.total + 100 * CASTES.minor.upkeep)) < 1e-9);
  assert.deepEqual(armyUpkeep({}), { total: 0, share: 0 });
  const { s, d } = world(100);
  s.run.colony.adults.soldier = 20;
  const m = mountColony(s, d);
  const row = m.root.querySelector('.caste-goal[data-caste="soldier"] .caste-goal-upkeep');
  assert.equal(row.textContent, casteUpkeepLine('soldier', 20));
  const army = m.root.querySelector('.army-upkeep');
  assert.equal(army.hidden, false);
  assert.match(army.textContent, /^Army upkeep 5\.0 food\/s \(\d+(\.\d)?% of all upkeep\)\. Targets below the cap save/);
});
