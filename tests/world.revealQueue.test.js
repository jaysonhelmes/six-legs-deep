// Reveal queue across runs (bug-hunt F7): a queued reveal whose key is not unlocked in the current run never pops,
// is not shown on the ribbon, and does not delay the next run's real reveals. ARCHITECTURE §18 (see C-entry for F7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import * as unlocks from '../src/systems/unlocks.js';
import { handlers, newGame } from '../src/systems/prestige.js';
import { REVEAL } from '../src/data/unlocks.js';

/** A game whose run meets every flight requirement (same set-up as meta.flight.test.js). */
function flyReady(seed = 5) {
  const s = newState(seed);
  const d = makeDerived();
  newGame(s, d);
  s.run.fRun = 1e9;
  s.run.tPeak = 120;
  s.run.research.nuptial_preparation = 1;
  d.nest.agg.royalL = 5;
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  return { s, d };
}

/** unlocks.tick for `sec` seconds in 1 s steps; returns the unlock events with their sim time. */
function run(s, d, sec) {
  const out = [];
  for (let i = 0; i < sec; i++) {
    const env = fakeEnv({ dt: 1 });
    unlocks.tick(s, d, 1, env);
    for (const e of env.events) if (e.type === 'unlock') out.push({ key: e.key, at: s.meta.simTime });
    s.meta.simTime += 1;
    s.run.time += 1;
  }
  return out;
}

test('F7: a reveal still queued at the Flight does not pop in the next run (no stale "New: Nuptial Flight")', () => {
  const { s, d } = flyReady();
  s.meta.simTime = 5000;
  // The run-1 reveals a real player has already seen (the first-run timers are unlocked from the start of run 2).
  for (const k of ['golden_beetle', 'season_dial', 'events', 'tab_guide', 'tab_stats', 'tab_settings']) s.meta.seen[k] = true;
  // fly.ok has just become true: flight_button is unlocked and waiting in the 30 s queue.
  s.run.unlocked.flight_button = true;
  s.meta.reveal.queue = ['flight_button'];
  s.meta.reveal.lastAt = 4990;
  const env = fakeEnv();
  assert.equal(handlers.fly.validate(s, d, { type: 'fly' }), null);
  handlers.fly.apply(s, d, { type: 'fly' }, env);
  handlers.chooseLanding.apply(s, d, { type: 'chooseLanding', index: 0, boon: s.meta.pending.boons[0] }, env);
  assert.equal(s.run.unlocked.flight_button, undefined, 'the new run has not unlocked the Flight');
  assert.ok(!s.meta.reveal.queue.includes('flight_button'), 'the stale key is dropped at run start');
  const events = run(s, d, 90);
  assert.ok(!events.some((e) => e.key === 'flight_button'), 'no unlock event for a key the run has not unlocked');
  assert.equal(s.meta.seen.flight_button, undefined, 'never marked seen without a real reveal');
  // The real first-Flight reveal (Bloodline tab) is not pushed back by the stale entry.
  const bl = events.find((e) => e.key === 'tab_bloodline');
  assert.ok(bl, 'tab_bloodline revealed');
  assert.ok(bl.at - 5000 < REVEAL.gapSec, 'tab_bloodline pops on the first eligible tick, got ' + (bl.at - 5000));
  const nu = d.progress.nextUnlock;
  assert.ok(!nu || nu.key !== 'flight_button', 'the ribbon never points at the stale reveal');
});

test('F7: an old save whose queue holds a key that is not unlocked never pops it; a re-unlocked key reveals normally', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.simTime = 1000;
  s.meta.reveal.queue = ['flight_button'];
  s.meta.reveal.lastAt = 0;
  let events = run(s, d, 5);
  assert.ok(!events.some((e) => e.key === 'flight_button'));
  assert.ok(!s.meta.reveal.queue.includes('flight_button'));
  assert.ok(!d.progress.nextUnlock || d.progress.nextUnlock.key !== 'flight_button');
  // Once its condition holds in this run the key queues again and reveals.
  d.meta.proj.fly.ok = true;
  events = run(s, d, 40);
  assert.ok(events.some((e) => e.key === 'flight_button'));
  assert.equal(s.meta.seen.flight_button, true);
});
