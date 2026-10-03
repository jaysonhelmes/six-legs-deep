// WP7 unit tests: setAutomation (validation, deep merge), the 1 Hz cadence, autobuyer priority / gating, Auto-Flight,
// Auto-Supercolony (online only) and the Diapause toggle (ARCHITECTURE §8.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { handlers, autobuyPass, passCount, tick } from '../src/systems/automation.js';
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
  assert.equal(v({ autobuy: { priority: ['mound', 'mound', 'chambers'] } }), 'invalid:value');
  assert.equal(v({ autobuy: { priority: ['mound', 'chambers', 'adaptations'] } }), null);
  assert.equal(v({ autoGuard: true, autoRear: false }), null);
  assert.equal(v({ autobuy: { on: true } }), 'locked');
  assert.equal(v({ autoFlight: { on: true } }), 'locked');
  assert.equal(v({ autoSuper: { on: true } }), 'locked');
  assert.equal(v({ autobuy: { on: false } }), null, 'turning off is always allowed');
  s.cycle.traits.automaton_instincts = 1;
  assert.equal(v({ autobuy: { on: true } }), null);
  s.era.federation.auto_flight = 1;
  assert.equal(v({ autoFlight: { on: true, mode: 'alates', alates: 50 } }), null);
  s.meta.genome.deep_time_automation = 1;
  assert.equal(v({ autoSuper: { on: true, mode: 'hours', hours: 2 } }), null);
});

test('setAutomation deep-merges the patch and keeps the other fields', () => {
  const s = newState(1);
  const d = makeDerived();
  const prio = ['mound', 'adaptations', 'chambers'];
  handlers.setAutomation.apply(s, d, { type: 'setAutomation', patch: { autobuy: { priority: prio, mound: false }, autoRear: true,
    autoFlight: { mode: 'minutes', minutes: -0 } } });
  const a = s.meta.automation;
  assert.deepEqual(a.autobuy, { on: false, adaptations: true, chambers: true, mound: false, priority: prio });
  assert.notEqual(a.autobuy.priority, prio, 'arrays are copied');
  assert.equal(a.autoRear, true);
  assert.deepEqual(a.autoFlight, { on: false, mode: 'minutes', alates: 0, minutes: 0 });
  assert.ok(Object.is(a.autoFlight.minutes, 0), '-0 is stored as 0');
  assert.deepEqual(a.keep, { jobTargets: null, casteTargets: null });
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
  return { adaptations: mk('adaptations'), chambers: mk('chambers'), mound: mk('mound') };
}

test('autobuyer pass: priority order, one purchase per pass, gating by autobuyers / automaton_instincts', () => {
  const s = newState(1);
  const d = makeDerived();
  const env = fakeEnv();
  let log = [];
  s.era.federation.autobuyers = 1;
  assert.equal(autobuyPass(s, d, env, fakeSteps(log, ['chambers'])), false, 'master toggle off');
  assert.deepEqual(log, []);
  s.meta.automation.autobuy.on = true;
  s.meta.automation.autobuy.priority = ['mound', 'chambers', 'adaptations'];
  assert.equal(autobuyPass(s, d, env, fakeSteps(log, ['chambers', 'adaptations'])), true);
  assert.deepEqual(log, ['mound', 'chambers'], 'stops after the first purchase');
  log = [];
  s.meta.automation.autobuy.chambers = false;
  autobuyPass(s, d, env, fakeSteps(log, []));
  assert.deepEqual(log, ['mound', 'adaptations'], 'disabled categories are skipped');
  log = [];
  delete s.era.federation.autobuyers;
  s.cycle.traits.automaton_instincts = 1;
  s.meta.automation.autobuy.chambers = true;
  autobuyPass(s, d, env, fakeSteps(log, []));
  assert.deepEqual(log, ['adaptations'], 'automaton_instincts grants only the Adaptation autobuyer');
  log = [];
  s.meta.automation.autobuy.priority = 'garbage';
  s.era.federation.autobuyers = 1;
  autobuyPass(s, d, env, fakeSteps(log, []));
  assert.deepEqual(log, ['adaptations', 'chambers', 'mound'], 'an invalid priority falls back to the default order');
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

test('Auto-Flight: flies and lands (option 0, first boon) when the condition holds, online only', () => {
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

test('Auto-Flight modes: minutes and peak', () => {
  let x = flyReady();
  x.s.era.federation.auto_flight = 1;
  Object.assign(x.s.meta.automation.autoFlight, { on: true, mode: 'minutes', minutes: 30 });
  x.s.run.time = 1799.95; // the pass at this tick still sees run.time < 30:00
  tick(x.s, x.d, 0.1, fakeEnv());
  assert.equal(x.s.meta.counters.flights, 0);
  x.s.run.time = 1800.95;
  tick(x.s, x.d, 0.1, fakeEnv());
  assert.equal(x.s.meta.counters.flights, 1);
  x = flyReady();
  x.s.era.federation.auto_flight = 1;
  Object.assign(x.s.meta.automation.autoFlight, { on: true, mode: 'peak' });
  x.s.run.time = 599.95;
  x.s.run.prestige.peakRate = 1e9;
  tick(x.s, x.d, 0.1, fakeEnv());
  assert.equal(x.s.meta.counters.flights, 1, 'the rate fell below 97 % of the recorded peak');
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
