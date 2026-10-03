// Hardships: starting a constrained run (a Flight variant, C6), tier detection from f_run, reward bookkeeping
// (cycle best, era best carried at 50 % through Supercolonies). Owner: WP7. Contract: ARCHITECTURE §8.6 (DESIGN §13.8).
// ARCH-R: startHardship needs unlock 'tab_hardships'; the same condition (meta.counters.alatesLife ≥ 150, §11) is also
// accepted directly so a hardship can be started on the tick the threshold is crossed, before unlocks.tick runs.
// Tier detection also runs offline (f_run grows offline; nothing is harmed); the hardshipTier events of an offline run
// are dropped by core/game.js like every other offline event.

import { HARDSHIP, HARDSHIPS, HARDSHIP_ORDER } from '../data/prestige.js';
import { clampNum } from '../core/math.js';
import { doFlight, flightRequirements } from './prestige.js';

/** Finite non-negative number or 0. */
function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * f_run goal of hardship tier t: goalBase × goalGrowth^(t−1) (1e9, 1e11, 1e13, 1e15, 1e17).
 * @param {number} t tier 1..5
 * @returns {number}
 */
export function goal(t) {
  return HARDSHIP.goalBase * HARDSHIP.goalGrowth ** (t - 1);
}

/**
 * Effective reward tier: max(cycle best, carry × era best) — may be fractional (50 % carry through a Supercolony).
 * @param {import('../core/types.js').State} s
 * @param {string} id hardship id
 * @returns {number}
 */
export function effectiveTier(s, id) {
  const cyc = s && s.cycle && s.cycle.hardshipTier ? num(s.cycle.hardshipTier[id]) : 0;
  const best = s && s.era && s.era.hardshipBest ? num(s.era.hardshipBest[id]) : 0;
  return Math.max(cyc, HARDSHIP.carry * best);
}

/**
 * Tier detection for the active hardship run: tier t reached when fRun ≥ goal(t) → cycle.hardshipTier, era.hardshipBest;
 * emits hardshipTier { id, tier } for every newly reached tier.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 */
export function tick(s, d, dt, env) {
  const id = s.run.hardship;
  if (typeof id !== 'string' || !HARDSHIPS[id]) return;
  const fRun = num(s.run.fRun);
  const cur = Math.floor(num(s.cycle.hardshipTier[id]));
  let t = cur;
  while (t < HARDSHIP.tiers && fRun >= goal(t + 1)) t++;
  if (t <= cur) return;
  s.cycle.hardshipTier[id] = t;
  if (!(num(s.era.hardshipBest[id]) >= t)) s.era.hardshipBest[id] = clampNum(t);
  if (env && typeof env.emit === 'function') for (let k = cur + 1; k <= t; k++) env.emit('hardshipTier', { id, tier: k });
}

/** Commands owned by WP7 hardships (ARCHITECTURE §9). */
export const handlers = {
  /** startHardship { id }: a Flight whose next run carries the constraint (C6). */
  startHardship: {
    validate(s, d, cmd) {
      if (typeof cmd.id !== 'string' || !HARDSHIPS[cmd.id] || !HARDSHIP_ORDER.includes(cmd.id)) return 'invalid:id';
      if (!s.run.unlocked.tab_hardships && !(num(s.meta.counters.alatesLife) >= HARDSHIP.unlockAlates)) return 'locked';
      if (!flightRequirements(s, d).ok) return 'requirements';
      return null;
    },
    apply(s, d, cmd, env) {
      doFlight(s, d, env, { hardship: cmd.id });
    },
  },
};
