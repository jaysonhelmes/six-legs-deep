// WP1 unit tests: core/effects.js (add/replace rules, strict scope matching, expiry events) and core/bus.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEffect, removeEffect, removeEffectsWhere, tickEffects, effectMult, effectAdd, hasEffect, effectsFor } from '../src/core/effects.js';
import { createBus } from '../src/core/bus.js';
import { newState, fakeEnv } from './helpers.js';

test('addEffect fills defaults and stores plain JSON', () => {
  const s = newState();
  addEffect(s, { id: 'frenzy', stat: 'forage', mult: 2, t: 20 });
  assert.deepEqual(s.run.effects, [{ id: 'frenzy', stat: 'forage', mult: 2, add: 0, scope: null, t: 20 }]);
  addEffect(s, { id: 'perm', stat: 'no_raids' });
  assert.deepEqual(s.run.effects[1], { id: 'perm', stat: 'no_raids', mult: 1, add: 0, scope: null, t: -1 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.run.effects)), s.run.effects);
  addEffect(s, { stat: 'x' }); // no id → ignored
  assert.equal(s.run.effects.length, 2);
});

test('same id replaces in place with t = max(old, new) unless reset; permanent wins', () => {
  const s = newState();
  addEffect(s, { id: 'a', stat: 'forage', mult: 2, t: 30 });
  addEffect(s, { id: 'b', stat: 'lay', mult: 3, t: 5 });
  addEffect(s, { id: 'a', stat: 'forage', mult: 5, t: 10 });
  assert.equal(s.run.effects.length, 2);
  assert.equal(s.run.effects[0].id, 'a');
  assert.equal(s.run.effects[0].mult, 5);
  assert.equal(s.run.effects[0].t, 30);
  addEffect(s, { id: 'a', stat: 'forage', mult: 5, t: 10, reset: true });
  assert.equal(s.run.effects[0].t, 10);
  assert.equal('reset' in s.run.effects[0], false);
  addEffect(s, { id: 'a', stat: 'forage', mult: 5, t: -1 });
  assert.equal(s.run.effects[0].t, -1);
  addEffect(s, { id: 'a', stat: 'forage', mult: 5, t: 50 });
  assert.equal(s.run.effects[0].t, -1);
});

test('effectMult / effectAdd match stat and scope strictly', () => {
  const s = newState();
  addEffect(s, { id: 'f1', stat: 'forage', mult: 2, t: 10 });
  addEffect(s, { id: 'f2', stat: 'forage', mult: 1.25, t: 10 });
  addEffect(s, { id: 'rally:12', stat: 'forage_trail', scope: 12, mult: 2, t: 30 });
  addEffect(s, { id: 'seed_mast', stat: 'source_type', scope: 'seed_patch', mult: 3, t: 60 });
  addEffect(s, { id: 'myrm', stat: 'forage_add', add: 0.15, t: -1 });
  addEffect(s, { id: 'snap', stat: 'frost_snap', add: 4, t: 120 });
  assert.equal(effectMult(s, 'forage'), 2.5);
  assert.equal(effectMult(s, 'forage_trail'), 1); // global query excludes scoped effects
  assert.equal(effectMult(s, 'forage_trail', 12), 2);
  assert.equal(effectMult(s, 'forage_trail', '12'), 1); // strict
  assert.equal(effectMult(s, 'source_type', 'seed_patch'), 3);
  assert.equal(effectAdd(s, 'forage_add'), 0.15);
  assert.equal(effectAdd(s, 'frost_snap'), 4);
  assert.equal(effectMult(s, 'nothing'), 1);
  assert.equal(effectAdd(s, 'nothing'), 0);
  assert.equal(effectsFor(s, 'forage').length, 2);
  assert.equal(effectsFor(s, 'forage_trail').length, 1);
  assert.equal(hasEffect(s, 'rally:12'), true);
  assert.equal(hasEffect(s, 'rally:13'), false);
});

test('tickEffects counts down, removes at ≤ 0 with effectEnded, leaves permanent effects alone', () => {
  const s = newState();
  addEffect(s, { id: 'short', stat: 'lay', mult: 3, t: 0.25 });
  addEffect(s, { id: 'perm', stat: 'chamber', scope: 7, mult: 0.5, t: -1 });
  addEffect(s, { id: 'long', stat: 'insight', mult: 2, t: 10 });
  const env = fakeEnv();
  tickEffects(s, 0.1, env);
  tickEffects(s, 0.1, env);
  assert.equal(env.events.length, 0);
  assert.ok(Math.abs(s.run.effects[0].t - 0.05) < 1e-12);
  tickEffects(s, 0.1, env);
  assert.deepEqual(env.events, [{ type: 'effectEnded', id: 'short', stat: 'lay' }]);
  assert.deepEqual(s.run.effects.map((e) => e.id), ['perm', 'long']);
  tickEffects(s, 0, env); // dt 0 pass
  assert.equal(s.run.effects.length, 2);
  tickEffects(s, 60, env); // one large offline step
  assert.deepEqual(s.run.effects.map((e) => e.id), ['perm']);
  tickEffects(s, 0.1, null); // env optional
});

test('removeEffect / removeEffectsWhere', () => {
  const s = newState();
  addEffect(s, { id: 'mold:1', stat: 'chamber', scope: 1, mult: 0.5 });
  addEffect(s, { id: 'mold:2', stat: 'chamber', scope: 2, mult: 0.5 });
  addEffect(s, { id: 'x', stat: 'lay', mult: 2, t: 5 });
  assert.equal(removeEffect(s, 'x'), true);
  assert.equal(removeEffect(s, 'x'), false);
  assert.equal(removeEffectsWhere(s, (e) => e.id.startsWith('mold:')), 2);
  assert.equal(s.run.effects.length, 0);
});

test('bus: on/off/emit, wildcard after specific, off during emit, exceptions caught, clear', () => {
  const bus = createBus();
  const log = [];
  const offA = bus.on('hatched', (e) => log.push('a:' + e.n));
  bus.on('*', (e) => log.push('*:' + e.type));
  const b = (e) => { log.push('b:' + e.n); offA(); };
  bus.on('hatched', b);
  const origError = console.error;
  let errors = 0;
  console.error = () => { errors++; };
  try {
    bus.on('hatched', () => { throw new Error('boom'); });
    bus.emit('hatched', { type: 'hatched', n: 1 });
    bus.emit('hatched', { type: 'hatched', n: 2 });
  } finally {
    console.error = origError;
  }
  assert.deepEqual(log, ['a:1', 'b:1', '*:hatched', 'b:2', '*:hatched']);
  assert.equal(errors, 2);
  bus.off('hatched', b);
  bus.clear();
  bus.emit('hatched', { type: 'hatched', n: 3 });
  assert.equal(log.length, 5);
  assert.equal(typeof bus.on('x', null), 'function');
});
