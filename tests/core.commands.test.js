// WP1 unit tests: core/commands.js (registry, duplicate detection, pause gate, core handlers) and core/actions.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDLER_MODULES, CORE_HANDLERS, PAUSE_OK, REGISTRY, buildRegistry, validateCommand, applyCommand,
} from '../src/core/commands.js';
import { createActions, PRESTIGE_TYPES } from '../src/core/actions.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const okHandler = (log) => ({ validate: () => null, apply: (s, d, cmd) => log.push(cmd.type) });

test('HANDLER_MODULES lists the 17 command-owning system modules; PAUSE_OK and PRESTIGE_TYPES per contract', () => {
  assert.equal(HANDLER_MODULES.length, 17);
  for (const m of HANDLER_MODULES) assert.equal(typeof m.handlers, 'object');
  assert.deepEqual([...PAUSE_OK].sort(), ['buyFederation', 'buyGenome', 'buyTrait', 'chooseLanding', 'equipCosmetic', 'setAutomation',
    'setHeirlooms', 'setSetting', 'uiFlag']);
  assert.deepEqual([...PRESTIGE_TYPES].sort(), ['fly', 'speciate', 'startHardship', 'supercolony']);
  assert.deepEqual(Object.keys(CORE_HANDLERS), ['setSetting', 'uiFlag', 'equipCosmetic']);
  for (const t of Object.keys(CORE_HANDLERS)) assert.equal(REGISTRY[t], CORE_HANDLERS[t]);
});

test('buildRegistry merges modules and detects duplicate types (also against core handlers)', () => {
  const log = [];
  const reg = buildRegistry([{ handlers: { a: okHandler(log) } }, { handlers: { b: okHandler(log) } }, {}, { handlers: null }]);
  assert.deepEqual(Object.keys(reg).sort(), ['a', 'b', 'equipCosmetic', 'setSetting', 'uiFlag']);
  assert.equal(Object.getPrototypeOf(reg), null);
  assert.throws(() => buildRegistry([{ handlers: { a: okHandler(log) } }, { handlers: { a: okHandler(log) } }]), /Duplicate command type "a"/);
  assert.throws(() => buildRegistry([{ handlers: { setSetting: okHandler(log) } }]), /Duplicate command type "setSetting"/);
  assert.throws(() => buildRegistry([{ handlers: { c: { validate: () => null } } }]), /no apply/);
  assert.doesNotThrow(() => buildRegistry());
});

test('validateCommand: unknown, invalid, paused (with PAUSE_OK exceptions), handler result, exceptions', () => {
  const s = newState();
  const d = makeDerived();
  const log = [];
  const reg = buildRegistry([{ handlers: {
    a: okHandler(log),
    chooseLanding: okHandler(log),
    picky: { validate: (st, dd, cmd) => (cmd.n > 3 ? 'max' : null), apply() {} },
    boom: { validate: () => { throw new Error('x'); }, apply() {} },
    noValidate: { apply() {} },
  } }]);
  assert.equal(validateCommand(s, d, { type: 'zzz' }, reg), 'unknown');
  assert.equal(validateCommand(s, d, { type: 'toString' }, reg), 'unknown');
  assert.equal(validateCommand(s, d, null, reg), 'invalid');
  assert.equal(validateCommand(s, d, { type: 5 }, reg), 'unknown');
  assert.equal(validateCommand(s, d, { type: 'a' }, reg), null);
  assert.equal(validateCommand(s, d, { type: 'picky', n: 5 }, reg), 'max');
  assert.equal(validateCommand(s, d, { type: 'boom' }, reg), 'invalid:exception');
  assert.equal(validateCommand(s, d, { type: 'noValidate' }, reg), null);
  s.meta.pending = { kind: 'landing', options: [], boons: [], chooseSeason: false, alates: 0, hardship: null };
  assert.equal(validateCommand(s, d, { type: 'a' }, reg), 'paused');
  assert.equal(validateCommand(s, d, { type: 'chooseLanding' }, reg), null);
  assert.equal(validateCommand(s, d, { type: 'setSetting', key: 'sound', value: true }, reg), null);
});

test('applyCommand: emits commandRejected on failure, applies on success, survives a throwing apply', () => {
  const s = newState();
  const d = makeDerived();
  const log = [];
  const reg = buildRegistry([{ handlers: { a: okHandler(log), bad: { validate: () => null, apply() { throw new Error('kaput'); } } } }]);
  const env = fakeEnv();
  assert.equal(applyCommand(s, d, { type: 'a' }, env, reg), true);
  assert.equal(applyCommand(s, d, { type: 'nope' }, env, reg), false);
  assert.equal(applyCommand(s, d, { type: 'bad' }, env, reg), false);
  assert.deepEqual(log, ['a']);
  assert.deepEqual(env.events[0], { type: 'commandRejected', cmd: { type: 'nope' }, reason: 'unknown' });
  assert.equal(env.events[1].reason, 'invalid:exception');
  assert.equal(env.events[1].detail, 'kaput');
});

test('setSetting validates key and per-key value', () => {
  const s = newState();
  const d = makeDerived();
  const v = (key, value) => validateCommand(s, d, { type: 'setSetting', key, value });
  assert.equal(v('notation', 'engineering'), null);
  assert.equal(v('notation', 'roman'), 'invalid:value');
  assert.equal(v('autosaveSec', 30), null);
  assert.equal(v('autosaveSec', 0), null);
  assert.equal(v('autosaveSec', 45), 'invalid:value');
  assert.equal(v('reducedMotion', 'yes'), 'invalid:value');
  assert.equal(v('harshNature', true), null);
  assert.equal(v('retreatAt', 0.75), null);
  assert.equal(v('retreatAt', 1.5), 'invalid:value');
  assert.equal(v('retreatAt', NaN), 'invalid:value');
  assert.equal(v('colonyName', 'Formica Prime'), null);
  assert.equal(v('colonyName', 'x'.repeat(200)), 'invalid:value');
  assert.equal(v('queenName', 3), 'invalid:value');
  assert.equal(v('showScaleLabel', false), null);
  assert.equal(v('bogus', 1), 'invalid:key');
  assert.equal(v('__proto__', 1), 'invalid:key');
  assert.equal(v('toString', 1), 'invalid:key');
  const env = fakeEnv();
  applyCommand(s, d, { type: 'setSetting', key: 'notation', value: 'scientific' }, env);
  applyCommand(s, d, { type: 'setSetting', key: 'harshNature', value: true }, env);
  assert.equal(s.meta.settings.notation, 'scientific');
  assert.equal(s.meta.settings.harshNature, true);
  applyCommand(s, d, { type: 'setSetting', key: 'autosaveSec', value: -0 }, env);
  applyCommand(s, d, { type: 'setSetting', key: 'retreatAt', value: -0 }, env);
  assert.ok(Object.is(s.meta.settings.autosaveSec, 0) && Object.is(s.meta.settings.retreatAt, 0), '-0 is stored as 0');
  assert.equal(env.events.length, 0);
});

test('uiFlag writes meta.onboarding.done; "ending" sets meta.flags.endingSeen; bad keys rejected', () => {
  const s = newState();
  const d = makeDerived();
  const env = fakeEnv();
  assert.equal(applyCommand(s, d, { type: 'uiFlag', key: 'hint_trail' }, env), true);
  assert.equal(applyCommand(s, d, { type: 'uiFlag', key: 'ending', value: true }, env), true);
  assert.deepEqual(s.meta.onboarding.done, { hint_trail: true, ending: true });
  assert.equal(s.meta.flags.endingSeen, true);
  applyCommand(s, d, { type: 'uiFlag', key: 'hint_trail', value: false }, env);
  assert.deepEqual(s.meta.onboarding.done, { ending: true });
  for (const key of ['', '__proto__', 'constructor', 7, 'k'.repeat(65)]) {
    assert.equal(validateCommand(s, d, { type: 'uiFlag', key }), 'invalid:key', String(key));
  }
  assert.equal(validateCommand(s, d, { type: 'uiFlag', key: 'x', value: 'yes' }), 'invalid:value');
});

test('equipCosmetic needs an owned id (or null to unequip)', () => {
  const s = newState();
  const d = makeDerived();
  const env = fakeEnv();
  assert.equal(validateCommand(s, d, { type: 'equipCosmetic', slot: 'banner', id: 'cos_gold' }), 'locked');
  s.meta.cosmetics.owned.cos_gold = true;
  assert.equal(applyCommand(s, d, { type: 'equipCosmetic', slot: 'banner', id: 'cos_gold' }, env), true);
  assert.deepEqual(s.meta.cosmetics.equipped, { banner: 'cos_gold' });
  assert.equal(applyCommand(s, d, { type: 'equipCosmetic', slot: 'banner', id: null }, env), true);
  assert.deepEqual(s.meta.cosmetics.equipped, {});
  assert.equal(validateCommand(s, d, { type: 'equipCosmetic', slot: '', id: null }), 'invalid:slot');
  assert.equal(validateCommand(s, d, { type: 'equipCosmetic', slot: 'b', id: 5 }), 'invalid:id');
  assert.equal(validateCommand(s, d, { type: 'equipCosmetic', slot: 'b', id: 'toString' }), 'locked');
});

test('createActions: do() validates synchronously and enqueues; per-type functions; prestige hook first', () => {
  const log = [];
  const reg = buildRegistry([{ handlers: { a: okHandler(log), fly: okHandler(log) } }]);
  const game = { s: newState(), d: makeDerived(), queue: [], hooks: { beforePrestige: null } };
  const actions = createActions(game, reg);
  for (const t of Object.keys(reg)) assert.equal(typeof actions[t], 'function', t);
  assert.deepEqual(actions.do('zzz', {}), { ok: false, reason: 'unknown' });
  assert.deepEqual(actions.a({ n: 1 }), { ok: true, reason: null });
  assert.deepEqual(game.queue, [{ type: 'a', n: 1 }]);
  assert.deepEqual(actions.do('a', { type: 'evil' }), { ok: true, reason: null });
  assert.equal(game.queue[1].type, 'a');
  let saved = 0;
  game.hooks.beforePrestige = () => { saved++; };
  actions.a();
  assert.equal(saved, 0);
  actions.fly();
  assert.equal(saved, 1);
  game.hooks.beforePrestige = () => { throw new Error('disk full'); };
  assert.deepEqual(actions.fly({}), { ok: true, reason: null });
  game.s.meta.pending = { kind: 'landing' };
  assert.deepEqual(actions.a(), { ok: false, reason: 'paused' });
  assert.equal(log.length, 0); // nothing applied until a tick runs
  // the default registry exposes the core handlers
  const real = createActions({ s: newState(), d: makeDerived(), queue: [], hooks: {} });
  assert.equal(typeof real.setSetting, 'function');
  assert.deepEqual(real.setSetting({ key: 'sound', value: 'loud' }), { ok: false, reason: 'invalid:value' });
});
