// Field Guide unlocks: each entry unlocks on first encounter (state + this tick's events), pays
// max(FG_REWARD.min, FG_REWARD.sec × gross insight/s) once and emits `fieldGuide {id}`.
// Owner: WP6. Contract: ARCHITECTURE §8.5 (fieldguide.js), DESIGN §20. Trigger language: see data/fieldGuide.js.
// ARCH-R: "first trail" means the first trail the player draws (trailCreated after run.time 0, or a second trail
//   existing), because the crumb trail exists — and is announced by trailCreated — from 0:00.
// ARCH-R: "rival sighted" uses rivalSighted events (their `rivalType`, C48, or the rival looked up by uid) or the rival
//   list's `sighted` flag; "first tournament" = a tournament won, a rival's tournament
//   cooldown running, or an 'escalate' battle.

import { FG_ORDER, FIELD_GUIDE, FG_REWARD } from '../data/fieldGuide.js';
import { adultsTotal } from '../core/state.js';
import { grant, incomeSeconds } from '../core/wallet.js';
import { lvl } from '../core/math.js';

/** Finite number or 0. */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** Read a dotted path from an object (undefined when missing). */
function getPath(obj, path) {
  if (typeof path !== 'string') return undefined;
  let o = obj;
  for (const k of path.split('.')) {
    if (o === null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
    o = o[k];
  }
  return o;
}

/** Source by uid. */
function findSrc(s, uid) {
  for (const x of s.run.surface.sources) if (x.uid === uid) return x;
  return null;
}

/** Effective workers of a trail. */
function workersOf(d, t) {
  const list = d && d.surface && Array.isArray(d.surface.trails) ? d.surface.trails : [];
  for (const e of list) if (e && e.uid === t.uid) return num(e.workers);
  return num(t.workers);
}

/** Named predicates of the trigger language. */
const CUSTOM = {
  aphidHerded(s, d) {
    for (const t of s.run.surface.trails) {
      if (t.job !== 'herder') continue;
      const src = findSrc(s, t.src);
      if (src && src.type === 'aphid_colony' && workersOf(d, t) > 0) return true;
    }
    return false;
  },
  secondTrail: (s) => s.run.surface.trails.length >= 2,
  // trailCreated also fires for the starting crumb trail at run start (run.time 0); only later ones are drawn.
  drawnTrail: (s, d, events) => num(s.run.time) > 0 && events.some((e) => e.type === 'trailCreated'),
  tournament(s, d, events) {
    if (num(s.meta.counters.tournamentsWon) >= 1) return true;
    if (s.run.rivals.list.some((r) => r && num(r.tourCd) > 0)) return true;
    return events.some((e) => e.type === 'battleStart' && e.kind === 'escalate');
  },
};

/**
 * Evaluate a Field Guide trigger.
 * @param {Object} s
 * @param {Object} d
 * @param {Object} c trigger
 * @param {Array<Object>} events this tick's events
 * @returns {boolean}
 */
function test(s, d, c, events) {
  if (!c || typeof c !== 'object') return false;
  if (Array.isArray(c.all)) return c.all.every((x) => test(s, d, x, events));
  if (Array.isArray(c.any)) return c.any.some((x) => test(s, d, x, events));
  if (c.path !== undefined) return num(getPath(s, c.path)) >= c.gte;
  if (c.adults !== undefined) return adultsTotal(s) >= c.adults;
  if (c.research !== undefined) return !!(s.run.research && s.run.research[c.research]);
  if (c.ach !== undefined) return Object.prototype.hasOwnProperty.call(s.meta.achievements, c.ach);
  if (c.counter !== undefined) return num(s.meta.counters[c.counter]) >= c.gte;
  if (c.caste !== undefined) {
    if (events.some((e) => e.type === 'hatched' && e.caste === c.caste && num(e.n) > 0)) return true;
    if (c.caste === 'alate') return num(s.run.colony.alatesReared) >= 1;
    return num(s.run.colony.adults[c.caste]) >= 1;
  }
  if (c.chamber !== undefined) return s.run.nest.chambers.some((x) => x.type === c.chamber && (x.status === 'active' || x.status === 'growing'));
  if (c.source !== undefined) {
    const rev = s.run.surface.revealed;
    return s.run.surface.sources.some((x) => x.type === c.source && rev[x.hex] === 1);
  }
  if (c.rival !== undefined) {
    const list = s.run.rivals.list;
    if (list.some((r) => r && r.type === c.rival && r.sighted)) return true;
    for (const e of events) {
      if (e.type !== 'rivalSighted') continue;
      const r = list.find((x) => x && x.uid === e.uid);
      if ((r && r.type === c.rival) || e.rivalType === c.rival) return true;
    }
    return false;
  }
  if (c.ev !== undefined) {
    if (events.some((e) => e.type === 'eventSpawned' && e.id === c.ev)) return true;
    const ev = s.run.events;
    return !!((ev.card && ev.card.id === c.ev) || ev.active.some((a) => a.id === c.ev && !(a.data && a.data.forecast)));
  }
  if (c.emitted !== undefined) return events.some((e) => e.type === c.emitted);
  if (c.mound !== undefined) return num(s.run.surface.mound) >= c.mound;
  if (c.season !== undefined) return !!(d && d.season && d.season.id === c.season);
  if (c.census !== undefined) return Math.max(num(d && d.meta ? d.meta.census : 0), adultsTotal(s)) >= c.census;
  if (c.custom !== undefined) {
    const fn = CUSTOM[c.custom];
    return !!(fn && fn(s, d, events));
  }
  if (c.genome !== undefined) return lvl(s.meta.genome, c.genome) >= 1;
  return false;
}

/**
 * Unlock every Field Guide entry whose trigger holds: meta.fieldGuide[id] = simTime, insight reward, emit fieldGuide.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const seen = s.meta.fieldGuide;
  const events = env && Array.isArray(env.events) ? env.events : [];
  for (const id of FG_ORDER) {
    if (Object.prototype.hasOwnProperty.call(seen, id)) continue;
    const def = FIELD_GUIDE[id];
    if (!test(s, d, def.trigger, events)) continue;
    seen[id] = num(s.meta.simTime);
    grant(s, d, 'insight', Math.max(FG_REWARD.min, incomeSeconds(d, 'insight', FG_REWARD.sec)));
    if (env && typeof env.emit === 'function') env.emit('fieldGuide', { id });
  }
}
