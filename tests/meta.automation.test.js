// WP7 unit tests: setAutomation (validation, deep merge), the 1 Hz cadence, independent autobuyers / gating (C246), Auto-Flight,
// Auto-Supercolony (online only) and the Diapause toggle (ARCHITECTURE §8.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { handlers, autobuyPass, passCount, tick, normalizeAutobuy } from '../src/systems/automation.js';
import { newGame } from '../src/systems/prestige.js';

test('setAutomation validation codes', () => {
  const s = newState(1);
  const d = makeDerived();
  const v = (patch) => handlers.setAutomation.validate(s, d, { type: 'setAutomation', patch });
  assert.equal(v(null), 'invalid');
  assert.equal(v({}), 'invalid');
  assert.equal(v([]), 'invalid');
  assert.equal(v({ bogus: 1 }), 'invalid:key');
  assert.equal(v({ jobPresets: [] }), 'invalid:key', 'WP2 fields are not patchable here');
  assert.equal(v({ keep: {} }), 'invalid:key');
  assert.equal(v({ autoGuard: 1 }), 'invalid:value');
  assert.equal(v({ autoFlight: { mode: 'sometimes' } }), 'invalid:value');
  assert.equal(v({ autoFlight: { alates: -1 } }), 'invalid:value');
  assert.equal(v({ autoFlight: { minutes: NaN } }), 'invalid:value');
  assert.equal(v({ autoFlight: { wings: 2 } }), 'invalid:key');
  assert.equal(v({ autoSuper: 5 }), 'invalid');
  assert.equal(v({ autobuy: { priority: ['chambers', 'adaptations'] } }), 'invalid:key', 'C246: no priority list');
  assert.equal(v({ autobuy: { mound: true } }), 'invalid:key', 'C246: no Mound autobuyer');
  assert.equal(v({ autobuy: { on: true } }), 'invalid:key', 'C246: no master switch');
  assert.equal(v({ autobuy: { chambers: 1 } }), 'invalid:value');
  assert.equal(v({ autoGuard: true, autoRear: false }), null);
  assert.equal(v({ autobuy: { adaptations: true } }), 'locked');
  assert.equal(v({ autoFlight: { on: true } }), 'locked');
  assert.equal(v({ autoSuper: { on: true } }), 'locked');
  assert.equal(v({ autobuy: { chambers: false } }), null, 'turning off is always allowed');
  s.cycle.traits.automaton_instincts = 1;
  assert.equal(v({ autobuy: { chambers: true } }), 'locked', 'C166: Automaton Instincts no longer grants an autobuyer');
  s.era.federation.autobuyers = 1;
  assert.equal(v({ autobuy: { chambers: true } }), null);
  s.era.federation.auto_flight = 1;
  assert.equal(v({ autoFlight: { on: true, mode: 'alates', alates: 50 } }), null);
  s.meta.genome.deep_time_automation = 1;
  assert.equal(v({ autoSuper: { on: true, mode: 'hours', hours: 2 } }), null);
});

test('setAutomation deep-merges the patch and keeps the other fields', () => {
  const s = newState(1);
  const d = makeDerived();
  handlers.setAutomation.apply(s, d, { type: 'setAutomation', patch: { autobuy: { chambers: true }, autoRear: true,
    autoFlight: { mode: 'minutes', minutes: -0 } } });
  const a = s.meta.automation;
  assert.deepEqual(a.autobuy, { adaptations: false, chambers: true });
  assert.equal(a.autoRear, true);
  assert.deepEqual(a.autoFlight, { on: false, mode: 'minutes', alates: 0, minutes: 0 });
  assert.ok(Object.is(a.autoFlight.minutes, 0), '-0 is stored as 0');
  assert.deepEqual(a.keep, { jobTargets: null, casteTargets: null, casteGoals: null, casteFill: null });
});

test('passCount: one pass per integer run second crossed, bounded offline', () => {
  assert.equal(passCount(0, 0.1), 0);
  assert.equal(passCount(0.9000000000000001, 0.1), 1);
  assert.equal(passCount(1, 0.1), 0);
  assert.equal(passCount(0.95, 0), 0);
  assert.equal(passCount(10, 60), 60);
  assert.equal(passCount(0, 600), 60, 'capped at AUTOMATION.maxPassesPerTick');
  let n = 0;
  let t = 0;
  for (let i = 0; i < 100; i++) { n += passCount(t, 0.1); t += 0.1; }
  assert.equal(n, 10, '10 s of 0.1 s ticks → 10 passes');
});

/** Fake autobuyer steps that record calls; `succeed` lists the categories that buy something. */
function fakeSteps(log, succeed) {
  const mk = (cat) => () => { log.push(cat); return succeed.includes(cat); };
  return { adaptations: mk('adaptations'), chambers: mk('chambers') };
}

test('C246: autobuyer pass — each switched-on autobuyer runs on its own, gated by the Federation autobuyers node only', () => {
  const s = newState(1);
  const d = makeDerived();
  const env = fakeEnv();
  let log = [];
  s.era.federation.autobuyers = 1;
  assert.equal(autobuyPass(s, d, env, fakeSteps(log, ['chambers'])), false, 'both off by default');
  assert.deepEqual(log, []);
  s.meta.automation.autobuy.adaptations = true;
  s.meta.automation.autobuy.chambers = true;
  assert.equal(autobuyPass(s, d, env, fakeSteps(log, ['chambers', 'adaptations'])), true);
  assert.deepEqual(log, ['adaptations', 'chambers'], 'a purchase by one does not stop the other');
  log = [];
  assert.equal(autobuyPass(s, d, env, fakeSteps(log, ['chambers'])), true);
  assert.deepEqual(log, ['adaptations', 'chambers'], 'the chamber autobuyer runs even when the Adaptation one buys nothing');
  log = [];
  s.meta.automation.autobuy.adaptations = false;
  autobuyPass(s, d, env, fakeSteps(log, []));
  assert.deepEqual(log, ['chambers'], 'a switched-off autobuyer is skipped');
  log = [];
  delete s.era.federation.autobuyers;
  s.cycle.traits.automaton_instincts = 1;
  autobuyPass(s, d, env, fakeSteps(log, []));
  assert.deepEqual(log, [], 'C166: automaton_instincts grants no autobuyer');
});

test('C246 migration: a pre-C246 autobuy map keeps the player choice and loses the master switch, priority and Mound', () => {
  const off = { on: false, adaptations: true, chambers: true, mound: true, priority: ['mound', 'chambers', 'adaptations'] };
  assert.deepEqual(normalizeAutobuy(off), { adaptations: false, chambers: false }, 'master off: both off');
  const on = { on: true, adaptations: true, chambers: false, mound: true, priority: ['adaptations', 'chambers', 'mound'] };
  assert.deepEqual(normalizeAutobuy(on), { adaptations: true, chambers: false }, 'master on: each keeps its switch');
  assert.deepEqual(normalizeAutobuy({ adaptations: true }), { adaptations: true, chambers: false }, 'idempotent, fills a missing switch');
  assert.equal(normalizeAutobuy(null), null);
  const s = newState(1);
  const d = makeDerived();
  s.era.federation.autobuyers = 1;
  s.meta.automation.autobuy = { on: true, adaptations: true, chambers: true, mound: true, priority: ['mound', 'chambers', 'adaptations'] };
  const log = [];
  autobuyPass(s, d, fakeEnv(), fakeSteps(log, []));
  assert.deepEqual(log, ['adaptations', 'chambers']);
  assert.deepEqual(s.meta.automation.autobuy, { adaptations: true, chambers: true });
});

/** A game after newGame whose run meets every flight requirement. */
function flyReady() {
  const s = newState(12);
  const d = makeDerived();
  newGame(s, d);
  s.run.fRun = 1e9;
  s.run.research.nuptial_preparation = 1;
  d.nest.agg.royalL = 5;
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  return { s, d };
}

test('Auto-Flight: flies and lands (scored landing pick) when the condition holds, online only', () => {
  const { s, d } = flyReady();
  s.era.federation.auto_flight = 1;
  Object.assign(s.meta.automation.autoFlight, { on: true, mode: 'alates', alates: 50 });
  s.run.time = 599.95;
  tick(s, d, 0.1, fakeEnv());
  assert.equal(s.meta.counters.flights, 0, 'projection below the target');
  Object.assign(s.meta.automation.autoFlight, { alates: 10 });
  tick(s, d, 0.1, fakeEnv({ offline: true, dt: 0.1 }));
  assert.equal(s.meta.counters.flights, 0, 'frozen offline');
  s.run.time = 600.95;
  const env = fakeEnv();
  tick(s, d, 0.1, env);
  assert.equal(s.meta.counters.flights, 1);
  assert.equal(s.meta.pending, null, 'the landing is chosen automatically');
  assert.equal(s.run.index, 1);
  assert.ok(s.run.boon !== null);
  assert.deepEqual(env.events.map((e) => e.type), ['flightComplete', 'runStarted']);
});

test('Auto-Flight modes: minutes (the peak mode has its own C166 tests in meta.feedback6)', () => {
  let x = flyReady();
  x.s.era.federation.auto_flight = 1;
  Object.assign(x.s.meta.automation.autoFlight, { on: true, mode: 'minutes', minutes: 30 });
  x.s.run.time = 1799.95; // the pass at this tick still sees run.time < 30:00
  tick(x.s, x.d, 0.1, fakeEnv());
  assert.equal(x.s.meta.counters.flights, 0);
  x.s.run.time = 1800.95;
  tick(x.s, x.d, 0.1, fakeEnv());
  assert.equal(x.s.meta.counters.flights, 1);
});

test('Auto-Supercolony keeps the current edict', () => {
  const s = newState(3);
  const d = makeDerived();
  newGame(s, d);
  s.meta.genome.deep_time_automation = 1;
  Object.assign(s.meta.automation.autoSuper, { on: true, mode: 'kinship', kinship: 3 });
  s.cycle.traits.budding = 1;
  s.cycle.alatesCycle = 5000;
  s.cycle.edict = 'edict_of_depth';
  s.run.rivals.list.push({ uid: 99, type: 'old_ridge_supercolony', alive: false, fallenAt: 10 });
  s.run.time = 99.95;
  const env = fakeEnv();
  tick(s, d, 0.1, env);
  assert.equal(s.meta.counters.supercolonies, 1);
  assert.equal(s.era.kinshipLife, 3);
  assert.equal(s.cycle.edict, 'edict_of_depth');
  assert.ok(env.events.some((e) => e.type === 'supercolonyComplete'));
});

test('spendDiapause toggles meta.diapause.active (needs a bank to start)', () => {
  const s = newState(1);
  const d = makeDerived();
  const v = (on) => handlers.spendDiapause.validate(s, d, { type: 'spendDiapause', on });
  assert.equal(v(true), 'cantAfford');
  assert.equal(v(false), null);
  assert.equal(v('yes'), 'invalid');
  s.meta.diapause.bank = 600;
  assert.equal(v(true), null);
  handlers.spendDiapause.apply(s, d, { type: 'spendDiapause', on: true });
  assert.equal(s.meta.diapause.active, true);
  handlers.spendDiapause.apply(s, d, { type: 'spendDiapause', on: false });
  assert.equal(s.meta.diapause.active, false);
});
