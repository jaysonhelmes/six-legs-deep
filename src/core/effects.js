// Timed and persistent modifiers stored in s.run.effects (rally, frenzy, event buffs and debuffs, mold spots …).
// Owner: WP1. Contract: ARCHITECTURE §7.7 (stat keys table). Anyone writes s.run.effects only through this module.
// ARCH-R: §7.7 says a re-added id keeps t = max(old.t, new.t); with the -1 "until removed" sentinel a literal max
// would turn a permanent effect into a timed one, so -1 is treated as infinitely long (a permanent effect stays permanent).

/**
 * Add (or replace by id) an effect. Defaults: mult 1, add 0, scope null, t -1 (until removed).
 * Same id already present → replaced in place; the new t is max(old.t, new.t) (a permanent -1 wins), unless
 * eff.reset === true, in which case the new t is used as given.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').EffectInput} eff
 * @returns {void}
 */
export function addEffect(s, eff) {
  if (!eff || typeof eff.id !== 'string' || typeof eff.stat !== 'string') return;
  const list = s.run.effects;
  const t = Number.isFinite(eff.t) ? eff.t : -1;
  const e = {
    id: eff.id,
    stat: eff.stat,
    mult: Number.isFinite(eff.mult) ? eff.mult : 1,
    add: Number.isFinite(eff.add) ? eff.add : 0,
    scope: eff.scope === undefined ? null : eff.scope,
    t,
  };
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === e.id) {
      if (eff.reset !== true) {
        const old = list[i].t;
        e.t = old < 0 || t < 0 ? -1 : Math.max(old, t);
      }
      list[i] = e;
      return;
    }
  }
  list.push(e);
}

/**
 * Remove the effect with this id.
 * @param {import('./types.js').State} s
 * @param {string} id
 * @returns {boolean} true if one was removed
 */
export function removeEffect(s, id) {
  const list = s.run.effects;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Remove every effect matching the predicate.
 * @param {import('./types.js').State} s
 * @param {(e: import('./types.js').Effect) => boolean} pred
 * @returns {number} count removed
 */
export function removeEffectsWhere(s, pred) {
  const list = s.run.effects;
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (pred(list[i])) {
      list.splice(i, 1);
      n++;
    }
  }
  return n;
}

/**
 * Count down timed effects: t > 0 → t −= dt; an effect whose t reaches ≤ 0 (or was added with t = 0) is removed and
 * env.emit('effectEnded', { id, stat }). Effects with t < 0 (−1 = until removed) are untouched.
 * @param {import('./types.js').State} s
 * @param {number} dt
 * @param {import('./types.js').Env} env
 * @returns {void}
 */
export function tickEffects(s, dt, env) {
  const list = s.run.effects;
  const step = dt > 0 ? dt : 0;
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.t >= 0) {
      if (e.t > 0) e.t -= step;
      if (e.t <= 0) {
        if (env && typeof env.emit === 'function') env.emit('effectEnded', { id: e.id, stat: e.stat });
        continue;
      }
    }
    list[w++] = e;
  }
  list.length = w;
}

/**
 * Product of `mult` over effects with e.stat === stat && e.scope === scope (strict; a global query does not include
 * scoped effects).
 * @param {import('./types.js').State} s
 * @param {string} stat
 * @param {null|string|number} [scope=null]
 * @returns {number}
 */
export function effectMult(s, stat, scope = null) {
  const list = s.run.effects;
  let m = 1;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.stat === stat && e.scope === scope) m *= e.mult;
  }
  return m;
}

/**
 * Sum of `add` over effects with e.stat === stat && e.scope === scope (strict).
 * @param {import('./types.js').State} s
 * @param {string} stat
 * @param {null|string|number} [scope=null]
 * @returns {number}
 */
export function effectAdd(s, stat, scope = null) {
  const list = s.run.effects;
  let a = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.stat === stat && e.scope === scope) a += e.add;
  }
  return a;
}

/**
 * True if an effect with this id is present.
 * @param {import('./types.js').State} s
 * @param {string} id
 * @returns {boolean}
 */
export function hasEffect(s, id) {
  const list = s.run.effects;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return true;
  return false;
}

/**
 * Every effect on this stat, any scope.
 * @param {import('./types.js').State} s
 * @param {string} stat
 * @returns {import('./types.js').Effect[]}
 */
export function effectsFor(s, stat) {
  return s.run.effects.filter((e) => e.stat === stat);
}
