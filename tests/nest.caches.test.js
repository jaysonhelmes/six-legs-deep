// Gameplay-rules regression test — F3: a seed cache is a one-shot "seconds of income" food reward, so it uses the
// one-shot overflow rule (DESIGN §3: up to 2 × the food cap), like conquest food, event food and golden windfalls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { FOOD_OVERFLOW } from '../src/data/balance.js';
import * as nest from '../src/systems/nest.js';
import { idx } from '../src/systems/nestgeom.js';

test('F3: a seed cache dug while food is at the cap overflows up to 2 × cap instead of being wasted', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 150, digW: 0 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  Object.assign(s.run.res, { food: 150, soil: 1e6 });
  nest.derive(s, d);
  s.run.nest.features.caches = [{ i: idx(24, 8), kind: 'seed_cache', found: false, hinted: false }];
  s.run.nest.rev++;
  d.rates.food.gross = 2;                                // 90 s × 2 = 180 food
  const cmd = { type: 'digTo', cell: idx(24, 8) };
  assert.equal(nest.handlers.digTo.validate(s, d, cmd), null);
  nest.handlers.digTo.apply(s, d, cmd, fakeEnv());
  s.run.res.food = 150;                                  // storage full when the cache is reached
  d.stats.digW = 1000;
  const env = fakeEnv({ dt: 1 });
  nest.derive(s, d);
  nest.tick(s, d, 1, env);
  const found = env.events.find((e) => e.type === 'cacheFound');
  assert.ok(found, 'cache dug');
  assert.equal(found.amount, 150, 'added up to the overflow limit (2 × 150 − 150)');
  assert.equal(s.run.res.food, 150 * FOOD_OVERFLOW);
  assert.equal(s.run.stats.foodWasted, 30, 'only the part above 2 × cap is wasted');
});
