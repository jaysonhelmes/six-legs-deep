// WP1 unit tests: core/step.js (time bookkeeping, ledger reset, command order, pause freeze, env) and helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, makeEnv, resetLedger } from '../src/core/step.js';
import { addEffect } from '../src/core/effects.js';
import { newState, makeDerived, fakeEnv, stepFor, snapshot } from './helpers.js';

test('makeEnv: econDt = dt × econScale, defaults, emit keeps the type authoritative', () => {
  const env = makeEnv(0.1, { econScale: 3, eff: 0.5, offline: true });
  assert.ok(Math.abs(env.econDt - 0.3) < 1e-12);
  assert.equal(env.dt, 0.1);
  assert.equal(env.eff, 0.5);
  assert.equal(env.offline, true);
  env.emit('hatched', { caste: 'minor', n: 2, type: 'forged' });
  const { emit } = env; // destructured emit still works
  emit('winterSoon');
  assert.deepEqual(env.events, [{ type: 'hatched', caste: 'minor', n: 2 }, { type: 'winterSoon' }]);
  const def = makeEnv(0.1);
  assert.deepEqual([def.offline, def.eff, def.econDt], [false, 1, 0.1]);
  assert.equal(makeEnv(1, { eff: NaN, econScale: -2 }).econDt, 1);
  assert.equal(fakeEnv({ offline: true }).offline, true);
});

test('step advances meta.tick, meta.simTime and run.time; dt 0 is a derive-only pass', () => {
  const s = newState();
  const d = makeDerived();
  step(s, d, 0.1);
  step(s, d, 0.1);
  assert.equal(s.meta.tick, 2);
  assert.ok(Math.abs(s.meta.simTime - 0.2) < 1e-12);
  assert.ok(Math.abs(s.run.time - 0.2) < 1e-12);
  step(s, d, 0, [], {});
  assert.equal(s.meta.tick, 3);
  assert.ok(Math.abs(s.run.time - 0.2) < 1e-12);
  step(s, d, NaN);
  step(s, d, -5);
  assert.ok(Math.abs(s.run.time - 0.2) < 1e-12);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('step resets the ledger every tick', () => {
  const s = newState();
  const d = makeDerived();
  d.ledger.food.trails = 5;
  d.ledger.insight.library = 1;
  step(s, d, 0.1);
  assert.deepEqual(d.ledger, { food: {}, honeydew: {}, leaves: {}, chitin: {}, insight: {}, fungus: {} });
  d.ledger.extra = { x: 1 };
  resetLedger(d);
  assert.deepEqual(d.ledger.extra, {});
});

test('commands apply first, in order, before effects tick; rejections become events', () => {
  const s = newState();
  const d = makeDerived();
  const ev = step(s, d, 0.1, [
    { type: 'setSetting', key: 'notation', value: 'engineering' },
    { type: 'setSetting', key: 'notation', value: 'scientific' },
    { type: 'noSuchCommand' },
  ]);
  assert.equal(s.meta.settings.notation, 'scientific');
  assert.deepEqual(ev.filter((e) => e.type === 'commandRejected').map((e) => e.reason), ['unknown']);
});

test('effects tick inside step and emit effectEnded', () => {
  const s = newState();
  const d = makeDerived();
  addEffect(s, { id: 'buff', stat: 'lay', mult: 2, t: 0.15 });
  assert.equal(step(s, d, 0.1).filter((e) => e.type === 'effectEnded').length, 0);
  assert.deepEqual(step(s, d, 0.1).filter((e) => e.type === 'effectEnded'), [{ type: 'effectEnded', id: 'buff', stat: 'lay' }]);
});

test('while meta.pending is set the run is frozen: run.time, effects and run state do not change', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.pending = { kind: 'landing', options: [], boons: [], chooseSeason: false, alates: 3, hardship: null };
  addEffect(s, { id: 'buff', stat: 'lay', mult: 2, t: 5 });
  const runBefore = JSON.stringify(s.run);
  const ev = step(s, d, 0.1, [{ type: 'setSetting', key: 'sound', value: true }, { type: 'fly' }]);
  assert.equal(JSON.stringify(s.run), runBefore);
  assert.equal(s.meta.tick, 1);
  assert.ok(Math.abs(s.meta.simTime - 0.1) < 1e-12);
  assert.equal(s.meta.settings.sound, true); // PAUSE_OK command applied
  // 'fly' is rejected: 'paused' once WP7 registers it ('unknown' against the stub); the exact pause gate is covered in core.commands
  assert.ok(['paused', 'unknown'].includes(ev.filter((e) => e.type === 'commandRejected')[0].reason));
});

test('guard runs at the end of step (non-finite hot path repaired)', () => {
  const s = newState();
  const d = makeDerived();
  s.run.res.chitin = NaN;
  const orig = console.error;
  console.error = () => {};
  let ev;
  try { ev = step(s, d, 0.1); } finally { console.error = orig; }
  assert.equal(s.run.res.chitin, 0);
  assert.deepEqual(ev.filter((e) => e.type === 'nanGuard').map((e) => e.path), ['run.res.chitin']);
});

test('helpers: stepFor runs the real step with commands keyed by tick index; snapshot is a JSON copy', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 999 } });
  assert.equal(d.stats.foodCap, 999);
  assert.equal(d.stats.honeydewCap, 65);
  const ev = stepFor(s, d, 1, { commands: { 3: { type: 'setSetting', key: 'sound', value: true }, 5: [{ type: 'bogus' }] } });
  assert.equal(s.meta.tick, 10);
  assert.equal(s.meta.settings.sound, true);
  assert.equal(ev.filter((e) => e.type === 'commandRejected').length, 1);
  const snap = snapshot(s);
  assert.deepStrictEqual(snap, s);
  assert.notEqual(snap, s);
});
