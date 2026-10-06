// C151 / C152 tests — caste TARGET COUNTS replace the caste-share sliders: the queen lays each caste until adults + brood
// reach its target (largest deficit first), then minors; Max = the caste's berth cap; "Keep berths filled" tracks the cap
// and switches on by itself at the first Barracks / War Hall (unless the player set that caste); the chitin reserve still
// holds; pre-C151 share saves convert; the Colony panel rows and the rail's Ants breakdown render (tests/fakedom.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument, FEvent } from './fakedom.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { recompute } from '../src/systems/stats.js';
import { tick as populationTick, handlers, casteStatus, casteGoal, convertLegacyCasteTargets, chitinNeed } from '../src/systems/population.js';
import { fillDefaults } from '../src/core/migrations.js';
import { createState } from '../src/core/state.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;
const colonyPanel = await import('../src/ui/panels/colony.js');
const hud = await import('../src/ui/hud.js');
after(() => {
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

/** Roomy colony: λ = 10 eggs/s, lots of food / chitin / honeydew, soldiers + repletes + supermajors unlocked. */
function world({ berths = 0, warBerths = 0, repleteBerths = 0 } = {}) {
  const s = newState(1);
  const d = makeDerived();
  s.run.res.food = 1e9;
  s.run.res.chitin = 1e6;
  s.run.res.honeydew = 1e6;
  s.run.res.fungus = 1e6;
  s.run.colony.naniticsLeft = 0;
  s.run.colony.layAcc = 0;
  d.nest.agg.housingBase = 1e6;
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 1e6, factor: 1, exposed: false, snap: false, inReach: false }];
  Object.assign(d.nest.agg, { berthsBase: berths, warBerthsBase: warBerths, repleteBerthsBase: repleteBerths });
  d.meta.prestige.lay = 40;
  d.stats.honeydewCap = 1e9;
  for (const k of ['caste_soldier', 'caste_supermajor', 'caste_replete']) s.run.unlocked[k] = true;
  return { s, d };
}
function popTick(s, d, dt = 0.1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  recompute(s, d, env);
  populationTick(s, d, dt, env);
  s.run.time += dt;
  return env.events;
}
function run(s, d, ticks) {
  for (let i = 0; i < ticks; i++) popTick(s, d, 0.1);
}
function cmd(s, d, type, args) {
  const c = { type, ...args };
  const r = handlers[type].validate(s, d, c);
  if (r) return r;
  handlers[type].apply(s, d, c, fakeEnv());
  return null;
}
const touchAll = (s) => { s.run.colony.casteTouched = { soldier: true, supermajor: true, replete: true }; };

test('C151: count targets — soldiers are laid until adults + brood reach the target, then only minors', () => {
  const { s, d } = world({ berths: 100 });
  s.run.colony.adults.soldier = 3;                       // adults count toward the target
  assert.equal(cmd(s, d, 'setCasteTargets', { soldier: 10 }), null);
  run(s, d, 30);                                         // 30 eggs
  const e = s.run.colony.eggs;
  assert.equal(e.soldier, 7, '10 − 3 adults');
  assert.equal(e.minor, 23);
  const st = casteStatus(s, d, 'soldier');
  assert.equal(st.have, 10);
  assert.equal(st.goal, 10);
  assert.equal(st.cap, 100);
  assert.equal(st.free, 90);
  // a lost soldier is replaced
  s.run.colony.adults.soldier = 2;
  run(s, d, 3);
  assert.equal(s.run.colony.eggs.soldier, 8);
  // lowering the target below what exists lays no more soldiers and kills nobody
  cmd(s, d, 'setCasteTargets', { soldier: 1 });
  run(s, d, 10);
  assert.equal(s.run.colony.eggs.soldier, 8);
  assert.equal(s.run.colony.adults.soldier, 2);
});

test('C151: Max sets the target to the caste cap (Colony panel button); the row shows "N / target (cap M)" and costs', () => {
  const { s, d } = world({ berths: 12, warBerths: 4, repleteBerths: 7 });
  recompute(s, d, fakeEnv());
  touchAll(s);
  const game = { s, d, actions: { do: (type, args) => { const r = cmd(s, d, type, args); return r ? { ok: false, reason: r } : { ok: true }; } } };
  const rejects = [];
  const root = doc.createElement('div');
  const p = colonyPanel.createPanel(root, { game, ui: { getUI: () => ({}) }, bridge: { reject: (r) => rejects.push(r) } });
  s.run.unlocked.panel_war = true;
  p.update(s, d);
  const row = (c) => root.querySelector('.caste-goal[data-caste="' + c + '"]');
  for (const c of ['soldier', 'supermajor', 'replete']) assert.ok(row(c), c + ' row');
  const btn = (c, text) => row(c).querySelectorAll('button').find((b) => b.textContent === text);
  btn('soldier', 'Max').click();
  btn('supermajor', 'Max').click();
  btn('replete', 'Max').click();
  assert.deepEqual(s.run.colony.casteGoals, { soldier: 12, supermajor: 4, replete: 7 });
  btn('soldier', '+').click();
  assert.equal(s.run.colony.casteGoals.soldier, 13, '+1 (targets above the cap are allowed; berths still limit eggs)');
  root.querySelector('.caste-step').querySelectorAll('button').find((b) => b.textContent === '×10').click();
  btn('soldier', '−').click();
  assert.equal(s.run.colony.casteGoals.soldier, 3);
  btn('soldier', '−').click();
  assert.equal(s.run.colony.casteGoals.soldier, 0, 'never below 0');
  const input = row('replete').querySelector('input.caste-goal-input');
  input.value = '5';
  input.dispatchEvent(new FEvent('change'));
  assert.equal(s.run.colony.casteGoals.replete, 5, 'typed number');
  s.run.colony.adults.supermajor = 1;
  p.update(s, d);
  assert.equal(row('supermajor').querySelector('.caste-goal-status').textContent, '1 / 4 (cap 4) · 3 berths free');
  assert.match(row('supermajor').querySelector('.caste-goal-cost').textContent, /Per egg/);
  assert.ok(row('supermajor').querySelectorAll('.cost-part').length >= 3, 'food + chitin + fungus');
  assert.deepEqual(rejects, []);
  // Keep berths filled from the panel
  const box = row('soldier').querySelector('input.check');
  box.checked = true;
  box.dispatchEvent(new FEvent('change'));
  assert.equal(s.run.colony.casteFill.soldier, true);
  p.update(s, d);
  assert.equal(row('soldier').querySelector('input.caste-goal-input').value, '12', 'the target shows the cap');
  p.destroy();
});

test('C151: "Keep berths filled" tracks the cap; switching it off keeps the cap as the typed target', () => {
  const { s, d } = world({ berths: 5 });
  touchAll(s);
  assert.equal(cmd(s, d, 'setCasteFill', { caste: 'soldier', on: true }), null);
  run(s, d, 20);
  assert.equal(s.run.colony.eggs.soldier, 5, 'fills the 5 berths');
  d.nest.agg.berthsBase = 8;                             // a Barracks level up
  run(s, d, 10);
  assert.equal(s.run.colony.eggs.soldier, 8, 'new berths are filled too');
  recompute(s, d, fakeEnv());
  assert.equal(casteGoal(s, d, 'soldier'), 8);
  assert.equal(cmd(s, d, 'setCasteFill', { caste: 'soldier', on: false }), null);
  assert.equal(s.run.colony.casteGoals.soldier, 8);
  assert.equal(s.run.colony.casteFill.soldier, false);
  d.nest.agg.berthsBase = 20;
  run(s, d, 10);
  assert.equal(s.run.colony.eggs.soldier, 8, 'off: no longer tracks the cap');
  // a typed target switches it off too
  cmd(s, d, 'setCasteFill', { caste: 'soldier', on: true });
  cmd(s, d, 'setCasteTargets', { soldier: 9 });
  assert.equal(s.run.colony.casteFill.soldier, false);
  // validation
  assert.equal(handlers.setCasteFill.validate(s, d, { type: 'setCasteFill', caste: 'minor', on: true }), 'invalid');
  assert.equal(handlers.setCasteFill.validate(s, d, { type: 'setCasteFill', caste: 'soldier', on: 1 }), 'invalid');
  s.run.hardship = 'pacifist';
  assert.equal(handlers.setCasteFill.validate(s, d, { type: 'setCasteFill', caste: 'soldier', on: true }), 'hardship');
  assert.equal(handlers.setCasteFill.validate(s, d, { type: 'setCasteFill', caste: 'soldier', on: false }), null);
  s.run.hardship = null;
  s.run.unlocked.caste_replete = false;
  assert.equal(handlers.setCasteFill.validate(s, d, { type: 'setCasteFill', caste: 'replete', on: true }), 'locked');
});

test('C151: filling switches on by itself at the first Barracks / War Hall of a run, unless the player set that caste', () => {
  const { s, d } = world();
  run(s, d, 5);
  assert.deepEqual(s.run.colony.casteFill, { soldier: false, supermajor: false, replete: false }, 'no berths yet');
  d.nest.agg.berthsBase = 4;                             // first Barracks becomes active
  run(s, d, 10);
  assert.equal(s.run.colony.casteFill.soldier, true);
  assert.equal(s.run.colony.casteTouched.soldier, true);
  assert.equal(s.run.colony.eggs.soldier, 4);
  assert.equal(s.run.colony.casteFill.supermajor, false);
  // the player turns it off: it stays off
  cmd(s, d, 'setCasteFill', { caste: 'soldier', on: false });
  d.nest.agg.berthsBase = 10;
  run(s, d, 10);
  assert.equal(s.run.colony.casteFill.soldier, false);
  // supermajor: the player set a target before the War Hall → no auto switch
  cmd(s, d, 'setCasteTargets', { supermajor: 1 });
  d.nest.agg.warBerthsBase = 6;
  run(s, d, 10);
  assert.equal(s.run.colony.casteFill.supermajor, false);
  assert.equal(s.run.colony.eggs.supermajor, 1);
  // a fresh colony with a War Hall and no player choice: supermajors switch on; repletes never switch on by themselves
  const w = world({ warBerths: 3, repleteBerths: 3 });
  run(w.s, w.d, 10);
  assert.equal(w.s.run.colony.casteFill.supermajor, true);
  assert.equal(w.s.run.colony.casteFill.replete, false);
  assert.equal(w.s.run.colony.eggs.supermajor, 3);
  // locked caste / pacifist: no auto switch
  const x = world({ berths: 3 });
  x.s.run.hardship = 'pacifist';
  run(x.s, x.d, 5);
  assert.equal(x.s.run.colony.casteFill.soldier, false);
  assert.equal(x.s.run.colony.eggs.soldier, 0);
});

test('C151 + C104: with "Keep berths filled" soldier eggs still only spend chitin above the reserve; minors fill in', () => {
  const { s, d } = world({ berths: 50 });
  touchAll(s);
  cmd(s, d, 'setCasteFill', { caste: 'soldier', on: true });
  s.run.colony.chitinReserve = 20;
  s.run.res.chitin = 23;
  run(s, d, 30);
  assert.ok(s.run.res.chitin >= 20 - 1e-9, 'never below the reserve: ' + s.run.res.chitin);
  assert.ok(s.run.colony.eggs.soldier >= 1 && s.run.colony.eggs.soldier <= 3, 'only the chitin above the reserve: ' + s.run.colony.eggs.soldier);
  assert.ok(s.run.colony.eggs.minor > 20, 'laying never blocks');
  recompute(s, d, fakeEnv());
  assert.equal(chitinNeed(s, d).needed, true, 'chitin trails get priority while berths wait');
});

test('C151 migration: pre-C151 share targets convert to counts on the first step; fillDefaults adds the new maps', () => {
  const { s, d } = world({ berths: 40, repleteBerths: 10 });
  delete s.run.colony.casteGoals;
  delete s.run.colony.casteFill;
  delete s.run.colony.casteTouched;
  s.run.colony.casteTargets = { soldier: 0.15, supermajor: 0, replete: 0.3 };
  s.run.colony.adults.replete = 5;
  fillDefaults(s);                                        // load path
  assert.deepEqual(s.run.colony.casteGoals, { soldier: 0, supermajor: 0, replete: 0 });
  recompute(s, d, fakeEnv());
  assert.equal(convertLegacyCasteTargets(s, d), true);
  assert.equal(s.run.colony.casteTargets, undefined, 'old map removed');
  assert.deepEqual(s.run.colony.casteGoals, { soldier: 6, supermajor: 0, replete: 5 }, 'round(share × cap), never below what exists');
  assert.deepEqual(s.run.colony.casteTouched, { soldier: true, supermajor: false, replete: true });
  assert.deepEqual(s.run.colony.casteFill, { soldier: false, supermajor: false, replete: false });
  assert.equal(convertLegacyCasteTargets(s, d), false, 'once');
  // through tick(): an old save with a Barracks already built and a 0 share does not suddenly fill it
  const w = world({ berths: 10 });
  delete w.s.run.colony.casteGoals;
  w.s.run.colony.casteTargets = { soldier: 0, supermajor: 0, replete: 0 };
  fillDefaults(w.s);
  run(w.s, w.d, 10);
  assert.equal(w.s.run.colony.casteTargets, undefined);
  assert.equal(w.s.run.colony.casteFill.soldier, false);
  assert.equal(w.s.run.colony.eggs.soldier, 0);
  // the default state has the C151 maps and no share map
  const fresh = createState({ seed: 2 });
  assert.equal(fresh.run.colony.casteTargets, undefined);
  assert.deepEqual(fresh.run.colony.casteFill, { soldier: false, supermajor: false, replete: false });
});

test('C152: the rail Ants row breaks the colony down by caste (only unlocked / non-zero castes) and folds', () => {
  const s = newState(1);
  const d = makeDerived();
  assert.deepEqual(hud.antBreakdown(s, d), [], 'workers + one queen only: no breakdown');
  s.run.colony.adults.minor = 40;
  s.run.colony.adults.soldier = 6;
  s.run.unlocked.caste_soldier = true;
  s.run.colony.alatesReared = 2;
  d.nest.agg.royal = [3, 1];
  const parts = hud.antBreakdown(s, d);
  assert.deepEqual(parts.map((p) => [p.id, p.n]), [['minor', 40], ['soldier', 6], ['alate', 2], ['queen', 2]]);
  assert.deepEqual(parts.map((p) => p.label), ['Workers', 'Soldiers', 'Alates (reared)', 'Queens']);
  // DOM
  const rail = doc.createElement('div');
  const game = { s, d, actions: { do: () => ({ ok: true }) } };
  const h = hud.createHud({ rail, hudTop: doc.createElement('div'), flowStrip: doc.createElement('div'), overlayBar: doc.createElement('div') },
    { game, ui: { getUI: () => ({ overlays: {} }), set() {} }, bridge: { reject() {}, openTab() {} } });
  h.update(s, d);
  const list = rail.querySelector('.pop-castes');
  assert.ok(list && !list.hidden, 'breakdown shown');
  const visible = list.querySelectorAll('.res-sub').filter((r) => !r.hidden);
  assert.deepEqual(visible.map((r) => r.querySelector('.res-name').textContent), ['Workers', 'Soldiers', 'Alates (reared)', 'Queens']);
  assert.equal(list.querySelector('.pop-soldier .pop-n').textContent, '6');
  assert.match(list.querySelector('.pop-soldier .pop-cap').textContent, /\/ 0 berths/, 'C193: the caste cap follows the count');
  const row = rail.querySelector('.res-pop');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  row.click();
  assert.ok(list.hidden, 'folded');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  row.click();
  assert.ok(!list.hidden, 'unfolded');
  h.destroy();
});
