// Clickable bonuses outside the event schedule: the Golden Beetle, the Golden Pupa and Saved Finds gift boxes.
// Owner: WP6. Contract: ARCHITECTURE §8.5 (golden.js), §4 (s.run.golden), DESIGN §18.3, §18.5, §21.4.
// Beetles and pupae are frozen offline (nothing here counts down with env.offline). Gifts appear on the first online
// tick after Saved Finds were banked (the catch-up derive pass counts as online).
// ARCH-R: spawnBeetle has no env, so `beetleSpawned` is emitted by the next golden.tick that sees a fresh beetle
//   (t still at its full lifetime) — at most one tick late, also for beetles spawned by the amber bead (WP3).
// ARCH-R: gifts on the map are capped at OFFLINE.findMax; extra banked finds stay in meta.savedFinds until a slot frees.
//   A gift that rolls `golden_beetle` while a beetle is already out opens a positive event from the pool instead.

import { GOLDEN, SAVED_FINDS } from '../data/events.js';
import { OFFLINE } from '../data/balance.js';
import { randRange, chance, pick, weighted } from '../core/rng.js';
import { addEffect } from '../core/effects.js';
import { grant, incomeSeconds } from '../core/wallet.js';
import { clickAvailable, consumeClick } from '../core/state.js';
import { countInRadius } from '../core/hex.js';
import * as surface from './surface.js';
import * as events from './events.js';

/** Finite number or 0. */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** True if this achievement is earned. */
function earned(s, id) {
  return Object.prototype.hasOwnProperty.call(s.meta.achievements, id);
}

/** Beetle lifetime: 13 s; 20 s with ach_beetle_collector; +5 s with ach_picnic_crasher. */
export function beetleLife(s) {
  return (earned(s, 'ach_beetle_collector') ? GOLDEN.lifeAch : GOLDEN.life) + (earned(s, 'ach_picnic_crasher') ? GOLDEN.lifePicnicAch : 0);
}

/** Revealed passable hexes inside the current radius. */
function spawnHexes(s, d) {
  const R = Number.isFinite(s.run.surface.radius) ? Math.max(0, Math.min(16, Math.floor(s.run.surface.radius))) : 8;
  const n = countInRadius(R);
  const rev = s.run.surface.revealed;
  const out = [];
  for (let i = 0; i < n; i++) if (rev[i] === 1 && surface.isPassable(s, d, i)) out.push(i);
  return out;
}

/** Live nurseries (or the Royal Chamber when there is none) for the pupa. */
function pupaChamber(s) {
  const live = s.run.nest.chambers.filter((c) => c.status === 'active' || c.status === 'growing');
  const nurseries = live.filter((c) => c.type === 'nursery');
  if (nurseries.length) return pick(s, nurseries);
  const royal = live.find((c) => c.type === 'royal_chamber') || s.run.nest.chambers[0];
  return royal || null;
}

/** True if this is a claustral_founding hardship run (every golden click is refused, C32). */
function claustral(s) {
  return s.run.hardship === 'claustral_founding';
}

/** Roll entry by id. */
function rollDef(id) {
  return GOLDEN.rolls.find((r) => r.id === id);
}

/** Apply a roll's reward. */
function applyRoll(s, d, id, source) {
  const r = rollDef(id);
  if (!r) return;
  if (id === 'windfall') {
    grant(s, d, 'food', incomeSeconds(d, 'food', r.foodSec), { overflow: true });
  } else if (id === 'frenzy') {
    addEffect(s, { id: source + '_frenzy', stat: 'forage', mult: r.mult, t: r.sec });
  } else if (id === 'lay_burst') {
    addEffect(s, { id: source + '_lay', stat: 'lay', mult: r.mult, t: r.sec });
  } else if (id === 'discovery') {
    const oneShot = d && d.stats && d.stats.insight && Number.isFinite(d.stats.insight.oneShot) ? d.stats.insight.oneShot : 1;
    grant(s, d, 'insight', incomeSeconds(d, 'insight', r.insightSec) + r.insightFlat * oneShot);
  }
}

/**
 * [x] WP3 (amber bead) and internal: put a Golden Beetle on `hex` (−1 = a random revealed passable hex, s as RNG).
 * Replaces any beetle already out. beetleSpawned is emitted by the next golden.tick.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} [hex=-1]
 * @returns {void}
 */
export function spawnBeetle(s, d, hex = -1) {
  let h = Number.isInteger(hex) && hex >= 0 && hex < countInRadius(16) ? hex : -1;
  if (h < 0) {
    const c = pick(s, spawnHexes(s, d));
    h = c === null || c === undefined ? 0 : c;
  }
  s.run.golden.beetle = { hex: h, t: beetleLife(s) };
}

/**
 * Beetle timers and spawns (online, unlock `golden_beetle`), pupae from this tick's eggLaid events, gifts from banked
 * Saved Finds.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  if (!env || env.offline) return;
  const g = s.run.golden;
  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;

  // Golden Beetle.
  if (g.beetle) {
    if (g.beetle.t >= beetleLife(s) - 1e-9) env.emit('beetleSpawned', { hex: g.beetle.hex });
    if (step > 0) {
      g.beetle.t -= step;
      if (g.beetle.t <= 0) {
        g.beetle = null;
        g.beetleIn = randRange(s, GOLDEN.beetleMin, GOLDEN.beetleMax);
      }
    }
  } else if (step > 0 && s.run.unlocked.golden_beetle) {
    // Later runs get golden_beetle from 0:00 (persisted unlock, C25) while the schema starts beetleIn at 0: arm the
    // first beetle of such a run with a normal 5–10 min draw instead of spawning one at 0:00 (integration fix). Run 1
    // keeps the immediate first beetle when the key unlocks at 5:00 (DESIGN §24.1).
    if (s.run.index > 0 && num(g.beetleIn) <= 0 && num(s.run.time) < GOLDEN.beetleMin) {
      g.beetleIn = randRange(s, GOLDEN.beetleMin, GOLDEN.beetleMax);
    }
    g.beetleIn = num(g.beetleIn) - step;
    if (g.beetleIn <= 0) {
      spawnBeetle(s, d, -1);
      g.beetleIn = 0;
    }
  }

  // Golden Pupa: 1 % per egg laid (one roll per batch: p = 1 − (1 − 1 %)^n), at most one per pupaGapSec.
  if (g.pupa) {
    if (step > 0) {
      g.pupa.t -= step;
      if (g.pupa.t <= 0) g.pupa = null;
    }
  } else if (step > 0) {
    let eggs = 0;
    for (const e of env.events) if (e.type === 'eggLaid' && e.n > 0) eggs += e.n;
    if (eggs > 0 && num(s.run.time) - num(g.lastPupaAt) >= GOLDEN.pupaGapSec) {
      const p = 1 - Math.pow(1 - GOLDEN.pupaChance, eggs);
      if (chance(s, p)) {
        const ch = pupaChamber(s);
        if (ch) {
          g.pupa = { chamber: ch.uid, t: GOLDEN.pupaLife };
          g.lastPupaAt = num(s.run.time);
          env.emit('pupaSpawned', { chamber: ch.uid });
        }
      }
    }
  }

  // Saved Finds → gift boxes on random revealed hexes.
  if (num(s.meta.savedFinds) > 0 && g.gifts.length < OFFLINE.findMax) {
    const cands = spawnHexes(s, d).filter((h) => h !== 0 && !g.gifts.some((x) => x.hex === h));
    while (num(s.meta.savedFinds) > 0 && g.gifts.length < OFFLINE.findMax) {
      const h = pick(s, cands);
      const hex = h === null || h === undefined ? 0 : h;
      g.gifts.push({ hex });
      const k = cands.indexOf(hex);
      if (k >= 0) cands.splice(k, 1);
      s.meta.savedFinds = num(s.meta.savedFinds) - 1;
    }
  }
}

/** Player commands owned by golden.js (all clicks; refused under claustral_founding). */
export const handlers = {
  /** clickBeetle {} — catch the Golden Beetle and roll its reward. */
  clickBeetle: {
    validate(s) {
      if (claustral(s)) return 'hardship';
      if (!s.run.golden.beetle) return 'notFound';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!consumeClick(s)) return;
      const g = s.run.golden;
      g.beetle = null;
      g.beetleIn = randRange(s, GOLDEN.beetleMin, GOLDEN.beetleMax);
      const r = weighted(s, GOLDEN.rolls);
      const roll = r ? r.id : 'windfall';
      applyRoll(s, d, roll, 'golden');
      s.meta.counters.beetles = num(s.meta.counters.beetles) + 1;
      env.emit('beetleClaimed', { roll });
    },
  },

  /** clickPupa { choice: 'frenzy' | 'windfall' } — claim the Golden Pupa. */
  clickPupa: {
    validate(s, d, cmd) {
      if (claustral(s)) return 'hardship';
      if (cmd.choice !== 'frenzy' && cmd.choice !== 'windfall') return 'invalid:choice';
      if (!s.run.golden.pupa) return 'notFound';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd) {
      if (!consumeClick(s)) return;
      s.run.golden.pupa = null;
      applyRoll(s, d, cmd.choice, 'pupa');
    },
  },

  /** openGift { index } — open a Saved Finds gift: a random positive event from the pool, or a Golden Beetle. */
  openGift: {
    validate(s, d, cmd) {
      if (claustral(s)) return 'hardship';
      if (!Number.isInteger(cmd.index)) return 'invalid:index';
      if (cmd.index < 0 || cmd.index >= s.run.golden.gifts.length) return 'notFound';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!consumeClick(s)) return;
      const g = s.run.golden;
      const gift = g.gifts[cmd.index];
      if (!gift) return;
      g.gifts.splice(cmd.index, 1);
      let pool = SAVED_FINDS.pool;
      if (g.beetle) pool = pool.filter((id) => id !== 'golden_beetle');
      const id = pick(s, pool);
      if (id === 'golden_beetle') spawnBeetle(s, d, gift.hex);
      else if (id) events.forceEvent(s, d, id, env);
      env.emit('giftOpened', { id });
    },
  },
};
