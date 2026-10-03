// The step function: one fixed-order simulation tick (commands first, then every system), plus the tick environment.
// Owner: WP1. Contract: ARCHITECTURE §7.2 (order), §7.3 (env). The integrator may reorder only by changing the contract.

import { tickEffects } from './effects.js';
import { guardTick } from './guard.js';
import { applyCommand } from './commands.js';
import * as seasons from '../systems/seasons.js';
import * as prestige from '../systems/prestige.js';
import * as nest from '../systems/nest.js';
import * as surface from '../systems/surface.js';
import * as stats from '../systems/stats.js';
import * as trails from '../systems/trails.js';
import * as economy from '../systems/economy.js';
import * as population from '../systems/population.js';
import * as jobs from '../systems/jobs.js';
import * as rivals from '../systems/rivals.js';
import * as raids from '../systems/raids.js';
import * as eventsSys from '../systems/events.js';
import * as golden from '../systems/golden.js';
import * as hardships from '../systems/hardships.js';
import * as automation from '../systems/automation.js';
import * as bottleneck from '../systems/bottleneck.js';
import * as unlocks from '../systems/unlocks.js';
import * as fieldguide from '../systems/fieldguide.js';
import * as achievements from '../systems/achievements.js';

/**
 * Build the tick environment.
 * @param {number} dt real-time seconds this tick
 * @param {import('./types.js').StepOpts} [opts]
 * @returns {import('./types.js').Env}
 */
export function makeEnv(dt, opts = {}) {
  const offline = opts.offline === true;
  const eff = Number.isFinite(opts.eff) && opts.eff >= 0 ? opts.eff : 1;
  const econScale = Number.isFinite(opts.econScale) && opts.econScale > 0 ? opts.econScale : 1;
  /** @type {import('./types.js').GameEvent[]} */
  const events = [];
  return {
    dt,
    econDt: dt * econScale,
    offline,
    eff,
    events,
    emit(type, payload = {}) {
      const e = { type, ...payload };
      e.type = type;
      events.push(e);
    },
  };
}

/**
 * Reset the per-tick ledger: d.ledger.* = {}.
 * @param {import('./types.js').Derived} d
 * @returns {void}
 */
export function resetLedger(d) {
  const l = d.ledger;
  for (const k of Object.keys(l)) l[k] = {};
}

/**
 * Advance the simulation by dt seconds (dt may be 0: derive-only pass) after applying the commands in order.
 * While s.meta.pending is set (landing chooser) the run is frozen: only the season clock and meta time advance.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @param {number} dt
 * @param {import('./types.js').Command[]} [commands=[]]
 * @param {import('./types.js').StepOpts} [opts={}]
 * @returns {import('./types.js').GameEvent[]}
 */
export function step(s, d, dt, commands = [], opts = {}) {
  if (!(dt >= 0) || !Number.isFinite(dt)) dt = 0;
  const env = makeEnv(dt, opts);
  resetLedger(d);
  if (commands) for (const cmd of commands) applyCommand(s, d, cmd, env);
  if (s.meta.pending) {
    seasons.tick(s, d, dt, env);
    s.meta.tick++;
    s.meta.simTime += dt;
    return env.events;
  }
  // Offline, harmful event effects neither apply nor count down (events are frozen offline, nothing harmful happens
  // offline: DESIGN §3, §21.4; ARCHITECTURE §18 C68). They are back, timers unchanged, before the guard runs.
  const held = env.offline ? eventsSys.suspendOffline(s) : null;
  tickEffects(s, dt, env);
  seasons.tick(s, d, dt, env);
  prestige.derive(s, d);
  nest.derive(s, d);
  surface.derive(s, d);
  stats.recompute(s, d, env);
  trails.tick(s, d, dt, env);
  surface.tick(s, d, dt, env);
  nest.tick(s, d, dt, env);
  economy.tick(s, d, dt, env);
  population.tick(s, d, dt, env);
  jobs.tick(s, d, dt, env);
  rivals.tick(s, d, dt, env);
  raids.tick(s, d, dt, env);
  eventsSys.tick(s, d, dt, env);
  golden.tick(s, d, dt, env);
  hardships.tick(s, d, dt, env);
  automation.tick(s, d, dt, env);
  prestige.tick(s, d, dt, env);
  bottleneck.tick(s, d, dt, env);
  unlocks.tick(s, d, dt, env);
  fieldguide.tick(s, d, dt, env);
  achievements.tick(s, d, dt, env);
  if (held) eventsSys.resumeOffline(s, held);
  s.meta.tick++;
  s.meta.simTime += dt;
  s.run.time += dt;
  guardTick(s, env);
  return env.events;
}
