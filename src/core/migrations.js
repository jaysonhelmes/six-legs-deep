// Save migrations (payload v → v + 1) and default filling for older or partial states.
// Owner: WP1. Contract: ARCHITECTURE §7.14 (DESIGN §22 migration chain).

import { SCHEMA_VERSION, createState } from './state.js';

/**
 * MIGRATIONS[v] = (payload) => payload of version v + 1. Payload = { v, savedAt, state }.
 * Empty at schema v1. Any shape change after v1 ships: bump SCHEMA_VERSION, add MIGRATIONS[v], add
 * tests/fixtures/save_v<v>.txt and a test.
 * @type {Object<number, (payload: Object) => Object>}
 */
export const MIGRATIONS = {};

/**
 * Run the migration chain up to SCHEMA_VERSION. Throws if a step is missing or returns a non-object.
 * @param {{ v: number, savedAt?: number, state: Object }} payload
 * @returns {{ v: number, savedAt?: number, state: Object }}
 */
export function migrate(payload) {
  if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.v)) throw new Error('migrate: bad payload');
  let p = payload;
  while (p.v < SCHEMA_VERSION) {
    const fn = MIGRATIONS[p.v];
    if (typeof fn !== 'function') throw new Error('migrate: no migration from v' + p.v);
    const from = p.v;
    const next = fn(p);
    if (!next || typeof next !== 'object') throw new Error('migrate: migration from v' + from + ' returned nothing');
    p = next;
    p.v = from + 1;
  }
  return p;
}

/** @returns {boolean} true for a plain (non-array) object */
function isPlain(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}

/** JSON deep copy. */
function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Recursively copy keys missing from `state` out of `defaults` (plain objects only; arrays and leaves are never
 * merged; a key present with any value, including null, is kept). Mutates and returns `state`.
 * @param {Object} state
 * @param {Object} [defaults=createState()]
 * @returns {Object}
 */
export function fillDefaults(state, defaults = createState()) {
  if (!isPlain(state) || !isPlain(defaults)) return state;
  for (const k of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(state, k) || state[k] === undefined) {
      state[k] = clone(defaults[k]);
    } else if (isPlain(state[k]) && isPlain(defaults[k])) {
      fillDefaults(state[k], defaults[k]);
    }
  }
  return state;
}
