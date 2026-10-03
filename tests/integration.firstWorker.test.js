// INTEGRATION TEST — ARCHITECTURE §15.3 #4 / DESIGN §5.3, §28.1 #4. Owner: WP1.
// A new game (createGame + newGame, the full step with every system) hatches its first worker within 15–30 s with
// zero input. EXPECTED TO FAIL against the WP1 stubs (population/stats do nothing, so nothing ever hatches).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { adultsTotal } from '../src/core/state.js';

/** Seconds until the first 'hatched' event (or the first adult), or -1 within `limit` seconds. */
function firstHatch(seed, limit = 60) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  const startAdults = adultsTotal(g.s);
  let at = -1;
  const ticks = Math.round(limit / 0.1);
  for (let i = 0; i < ticks && at < 0; i++) {
    const ev = g.tickOnce();
    if (ev.some((e) => e.type === 'hatched') || adultsTotal(g.s) > startAdults) at = g.s.run.time;
  }
  return { at, startAdults };
}

for (const seed of [1, 2, 12345]) {
  test('first worker hatches at 15–30 s with zero input (seed ' + seed + ')', () => {
    const { at, startAdults } = firstHatch(seed);
    assert.equal(startAdults, 0, 'a new game starts with no adults');
    assert.ok(at >= 15 && at <= 30, 'first worker at ' + (at < 0 ? 'never (60 s)' : at.toFixed(1) + ' s'));
  });
}
