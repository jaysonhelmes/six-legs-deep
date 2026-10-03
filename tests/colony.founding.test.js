// WP2 regression tests (ARCHITECTURE §18 C69): a colony that lost every ant with an empty larder can always recover.
// The queen alone (no adult, no brood) lays one minor egg from her own reserves when the food cannot pay for it, and a
// lone queen is never Hungry. Before C69 such a colony stalled forever in a Claustral Founding run (clicking for food
// is refused there), with no way to reach the Flight that ends the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { adultsTotal, broodTotal } from '../src/core/state.js';
import { quietWorld } from './helpers.js';

/** A run whose every ant just died, with no food and (optionally) the Hungry flag still set. */
function wiped({ hardship = null, hungry = false, seed = 11 } = {}) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  quietWorld(g.s);
  g.s.run.hardship = hardship;
  g.runFor(200);
  const c = g.s.run.colony;
  for (const k of Object.keys(c.adults)) c.adults[k] = 0;
  for (const k of Object.keys(c.jobs)) c.jobs[k] = 0;
  c.brood = [];
  c.hungry = hungry;
  g.s.run.res.food = 0;
  return g;
}

for (const hardship of [null, 'claustral_founding']) {
  for (const hungry of [false, true]) {
    test(`a wiped-out colony recovers without clicks (${hardship || 'normal run'}${hungry ? ', Hungry' : ''})`, () => {
      const g = wiped({ hardship, hungry });
      g.runFor(5);
      assert.equal(g.s.run.colony.hungry, false, 'a lone queen is not Hungry');
      assert.ok(broodTotal(g.s) >= 1, 'the founding egg is laid');
      assert.equal(g.s.run.res.food, 0, 'it cost the food there was (none)');
      g.runFor(300);
      assert.ok(adultsTotal(g.s) >= 5, 'the colony grew back: ' + adultsTotal(g.s));
      assert.ok(g.s.run.res.food > 0);
    });
  }
}

test('the founding egg is only a safety net: with brood or adults present an unaffordable egg is not laid', () => {
  const g = wiped();
  g.s.run.colony.adults.soldier = 1;   // an adult left (it can be retired to a worker, C37)
  const eggs = g.s.run.stats.eggs;
  g.runFor(5);
  assert.equal(g.s.run.stats.eggs, eggs);
  assert.equal(broodTotal(g.s), 0);
});
