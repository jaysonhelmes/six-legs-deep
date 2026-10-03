// Binding-constraint badge: run.bottleneck = { id, since, capT } with the pinned priority order.
// Owner: WP2. Contract: ARCHITECTURE §8.1 (bottleneck.js), DESIGN §2.2, §17.3.
// ARCH-R: "food free" / bn_food compare the food above the egg reserve (food − eggReserve × foodCap) with the next minor
// egg's cost, matching the laying rule; a dt = 0 (derive-only) pass changes nothing.

import { BOTTLENECK } from '../data/economy.js';
import { clampNum } from '../core/math.js';
import { broodTotal } from '../core/state.js';
import { broodAllocation } from './population.js';

/** Finite number or the fallback. */
function num(v, dflt = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Priority (C72): 'raid' (a raid in warning) > 'frost' (brood frozen, online) > 'hungry' > bn_housing > bn_brood_slots >
 * bn_food_cap (food ≥ 99 % of the cap for more than 5 s, tracked in capT) > bn_lay_rate (food, slot and housing free but
 * layAcc < 1) > bn_food (food < egg cost) > null. Housing and slots come before the food cap because they block eggs
 * outright, and food then piles up at the cap only as a consequence (DESIGN §2.2 "Housing · eggs blocked").
 * `since` = run.time of the last change; emits bottleneckChanged {id}.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  if (!(dt > 0)) return;
  const run = s.run;
  const col = run.colony;
  const st = d.stats;
  const bn = run.bottleneck;
  const food = num(run.res.food);

  if (food >= BOTTLENECK.capFrac * num(st.foodCap)) bn.capT = clampNum(num(bn.capT) + dt);
  else bn.capT = 0;

  let id = null;
  const raids = run.war && Array.isArray(run.war.raids) ? run.war.raids : [];
  if (raids.some((r) => r && r.phase === 'warning')) id = 'raid';
  else if (!(env && env.offline) && col.brood.length > 0 && broodAllocation(s, d).frozenShare > 0) id = 'frost';
  else if (col.hungry) id = 'hungry';
  else {
    const B = broodTotal(s);
    const foodFree = food - num(col.eggReserve) * num(st.foodCap) >= num(st.eggCost && st.eggCost.minor);
    if (num(col.adults.minor) + B >= num(st.housing)) id = 'bn_housing';
    else if (B >= num(st.broodSlots)) id = 'bn_brood_slots';
    else if (bn.capT > BOTTLENECK.capSec) id = 'bn_food_cap';
    else if (foodFree && num(col.layAcc) < 1) id = 'bn_lay_rate';
    else if (!foodFree) id = 'bn_food';
  }
  if (id !== bn.id) {
    bn.id = id;
    bn.since = clampNum(num(run.time));
    if (env && typeof env.emit === 'function') env.emit('bottleneckChanged', { id });
  }
}
