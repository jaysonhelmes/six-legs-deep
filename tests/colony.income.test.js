// Gameplay-rules regression tests — reward smoothing (ARCHITECTURE §18 C76; DESIGN §3 "seconds of income"): one-shot
// rewards are sized from a ~60 s moving average of gross income (d.rates[res].avg, kept by economy.tick), not the
// instantaneous rate, so a momentary spike (harvester stash, Frenzy) does not multiply windfalls. Minimums still apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { recompute } from '../src/systems/stats.js';
import { tick as economyTick } from '../src/systems/economy.js';
import { incomeSeconds } from '../src/core/wallet.js';
import { grantReward } from '../src/systems/combat.js';
import { INCOME_AVG } from '../src/data/economy.js';

const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.max(1e-9, Math.abs(b)), `${msg ?? ''} expected ≈${b}, got ${a}`);

/** economy.tick with a fixed food production of `food`/s for `sec` seconds. */
function econ(s, d, sec, food, dt = 0.1) {
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt });
    for (const r of Object.keys(d.ledger)) d.ledger[r] = {};
    d.ledger.food = { trails: food };
    recompute(s, d, env);
    economyTick(s, d, dt, env);
    s.run.time += dt;
  }
}

test('incomeSeconds: uses the smoothed rate when present, else gross; the minimum still applies', () => {
  const d = makeDerived({ rates: { food: { gross: 50, avg: 10 }, insight: { gross: 3 } } });
  assert.equal(incomeSeconds(d, 'food', 120), 1200, '120 s × avg 10');
  assert.equal(incomeSeconds(d, 'food', 120, 5000), 5000, 'stated minimum');
  assert.equal(incomeSeconds(d, 'insight', 30), 90, 'no average yet → gross');
  assert.equal(incomeSeconds(d, 'nothing', 30, 3), 3);
});

test('economy keeps d.rates.food.avg: it follows steady income and barely moves on a short spike', () => {
  const s = newState(1);
  const d = makeDerived();
  econ(s, d, 1, 100);
  near(d.rates.food.avg, d.rates.food.gross, 1e-9, 'a fresh cache starts at the current gross');
  econ(s, d, 600, 100);
  const steady = d.rates.food.gross;
  near(d.rates.food.avg, steady, 1e-6, 'steady state');
  econ(s, d, 3, 1000);                                   // a 3 s ×10 spike
  assert.ok(d.rates.food.gross > 9 * steady, 'instantaneous rate spiked');
  assert.ok(d.rates.food.avg < 1.5 * steady, 'average rose ' + (d.rates.food.avg / steady).toFixed(3) + '×');
  const fromAvg = incomeSeconds(d, 'food', 600);
  assert.ok(fromAvg < 600 * 1.5 * steady, 'a 600 s windfall during the spike stays near 600 s of normal income');
  // After the spike ends the average decays back with the INCOME_AVG.sec time constant.
  econ(s, d, INCOME_AVG.sec * 5, 100);
  near(d.rates.food.avg, steady, 0.02, 'back to steady');
});

test('the average is exact for any step length (one 60 s step = 600 ticks of 0.1 s)', () => {
  const a = { s: newState(1), d: makeDerived() };
  const b = { s: newState(1), d: makeDerived() };
  econ(a.s, a.d, 1, 10);
  econ(b.s, b.d, 1, 10);
  econ(a.s, a.d, 60, 500, 0.1);
  econ(b.s, b.d, 60, 500, 60);
  near(b.d.rates.food.avg, a.d.rates.food.avg, 1e-6);
});

test('conquest-style food rewards use the smoothed income (grantReward foodSec)', () => {
  const s = newState(1);
  const d = makeDerived();
  econ(s, d, 300, 100);
  const steady = d.rates.food.avg;
  econ(s, d, 2, 2000);                                   // momentary ×20 spike
  s.run.res.food = 0;
  d.stats.foodCap = 1e12;
  const out = grantReward(s, d, { foodSec: 120 }, null);
  assert.ok(out.food < 120 * steady * 2, 'reward ' + out.food.toFixed(0) + ' vs 120 s of normal income ' + (120 * steady).toFixed(0));
  assert.ok(out.food >= 120 * steady, 'never below the steady income');
});
