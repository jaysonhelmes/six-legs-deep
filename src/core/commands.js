// Command registry: merges every system module's `handlers` with the core handlers (setSetting, uiFlag, equipCosmetic);
// validation (incl. the pause gate) and application. Owner: WP1. Contract: ARCHITECTURE §7.4, §9 (core rows).

import * as economy from '../systems/economy.js';
import * as population from '../systems/population.js';
import * as jobs from '../systems/jobs.js';
import * as adaptations from '../systems/adaptations.js';
import * as nest from '../systems/nest.js';
import * as surface from '../systems/surface.js';
import * as trails from '../systems/trails.js';
import * as rivals from '../systems/rivals.js';
import * as raids from '../systems/raids.js';
import * as research from '../systems/research.js';
import * as seasons from '../systems/seasons.js';
import * as events from '../systems/events.js';
import * as golden from '../systems/golden.js';
import * as prestige from '../systems/prestige.js';
import * as traits from '../systems/traits.js';
import * as hardships from '../systems/hardships.js';
import * as automation from '../systems/automation.js';

/** System modules whose `handlers` are merged into the registry, in this order. */
export const HANDLER_MODULES = [economy, population, jobs, adaptations, nest, surface, trails, rivals, raids, research,
  seasons, events, golden, prestige, traits, hardships, automation];

/** Commands that validate while s.meta.pending is set (landing chooser open). */
export const PAUSE_OK = new Set(['chooseLanding', 'setSetting', 'uiFlag', 'equipCosmetic', 'buyTrait', 'buyFederation',
  'buyGenome', 'setAutomation', 'setHeirlooms']);

// ---------------------------------------------------------------------------------------------------------------
// Core handlers
// ---------------------------------------------------------------------------------------------------------------

const NOTATIONS = ['suffix', 'scientific', 'engineering'];
const AUTOSAVE_SECS = [15, 30, 60, 0];
// ARCH-R: the contract does not limit name or flag-key lengths; these caps keep saves small and keys sane.
const NAME_MAX = 40;
const KEY_MAX = 64;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @returns {boolean} true for a safe, non-empty object key */
function safeKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= KEY_MAX && !BAD_KEYS.has(k);
}

/** Per-setting value validators (keys of meta.settings). */
const SETTING_OK = {
  notation: (v) => NOTATIONS.includes(v),
  autosaveSec: (v) => AUTOSAVE_SECS.includes(v),
  reducedMotion: (v) => typeof v === 'boolean',
  sound: (v) => typeof v === 'boolean',
  harshNature: (v) => typeof v === 'boolean',
  retreatAt: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
  colonyName: (v) => typeof v === 'string' && v.length <= NAME_MAX,
  queenName: (v) => typeof v === 'string' && v.length <= NAME_MAX,
  showScaleLabel: (v) => typeof v === 'boolean',
};

/** setSetting { key, value }: keys of meta.settings only; value validated per key. */
const setSetting = {
  validate(s, d, cmd) {
    const { key, value } = cmd;
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(SETTING_OK, key)) return 'invalid:key';
    if (!Object.prototype.hasOwnProperty.call(s.meta.settings, key)) return 'invalid:key';
    if (!SETTING_OK[key](value)) return 'invalid:value';
    return null;
  },
  apply(s, d, cmd) {
    const v = cmd.value;
    s.meta.settings[cmd.key] = v === 0 ? 0 : v; // -0 passes the checks (includes() is SameValueZero) but is not JSON-stable
  },
};

// ARCH-R: uiFlag value false clears the flag (done[key] is deleted) so the map keeps its "key -> true" shape;
// equipCosmetic id null deletes the slot. validate()/apply() exceptions are caught and reported as
// commandRejected { reason: 'invalid:exception', detail } so one bad handler cannot stop the game loop.
/** uiFlag { key, value = true }: meta.onboarding.done[key] (true sets, false clears); 'ending' sets meta.flags.endingSeen. */
const uiFlag = {
  validate(s, d, cmd) {
    if (!safeKey(cmd.key)) return 'invalid:key';
    if (cmd.value !== undefined && typeof cmd.value !== 'boolean') return 'invalid:value';
    return null;
  },
  apply(s, d, cmd) {
    const on = cmd.value !== false;
    if (cmd.key === 'ending') s.meta.flags.endingSeen = on;
    if (on) s.meta.onboarding.done[cmd.key] = true;
    else delete s.meta.onboarding.done[cmd.key];
  },
};

/** equipCosmetic { slot, id }: id must be owned (meta.cosmetics.owned) or null (unequip). */
const equipCosmetic = {
  validate(s, d, cmd) {
    if (!safeKey(cmd.slot)) return 'invalid:slot';
    if (cmd.id === null) return null;
    if (!safeKey(cmd.id)) return 'invalid:id';
    if (s.meta.cosmetics.owned[cmd.id] !== true) return 'locked';
    return null;
  },
  apply(s, d, cmd) {
    if (cmd.id === null) delete s.meta.cosmetics.equipped[cmd.slot];
    else s.meta.cosmetics.equipped[cmd.slot] = cmd.id;
  },
};

/** Core command handlers owned by WP1. */
export const CORE_HANDLERS = { setSetting, uiFlag, equipCosmetic };

// ---------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------

/**
 * Merge CORE_HANDLERS and every module's `handlers` into one registry (null-prototype object).
 * Throws an Error naming the type on a duplicate command type or a handler without an apply function.
 * @param {Array<{ handlers?: Object<string, import('./types.js').Handler> }>} [modules=HANDLER_MODULES]
 * @returns {Record<string, import('./types.js').Handler>}
 */
export function buildRegistry(modules = HANDLER_MODULES) {
  /** @type {Record<string, import('./types.js').Handler>} */
  const reg = Object.create(null);
  const add = (type, h, from) => {
    if (type in reg) throw new Error('Duplicate command type "' + type + '" (' + from + ')');
    if (!h || typeof h.apply !== 'function') throw new Error('Command "' + type + '" has no apply() (' + from + ')');
    reg[type] = h;
  };
  for (const type of Object.keys(CORE_HANDLERS)) add(type, CORE_HANDLERS[type], 'core');
  modules.forEach((m, i) => {
    const hs = m && m.handlers;
    if (!hs) return;
    for (const type of Object.keys(hs)) add(type, hs[type], 'module #' + i);
  });
  return reg;
}

/** The registry built from HANDLER_MODULES at load time. */
export const REGISTRY = buildRegistry();

/**
 * Validate a command: 'invalid' for a malformed command, 'unknown' when no handler, 'paused' while s.meta.pending
 * (except PAUSE_OK types), else the handler's validate() result. A throwing validate() yields 'invalid:exception'.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @param {import('./types.js').Command} cmd
 * @param {Record<string, import('./types.js').Handler>} [reg=REGISTRY]
 * @returns {import('./types.js').ReasonCode|null}
 */
export function validateCommand(s, d, cmd, reg = REGISTRY) {
  if (!cmd || typeof cmd !== 'object') return 'invalid';
  if (typeof cmd.type !== 'string') return 'unknown';
  const h = reg[cmd.type];
  if (!h) return 'unknown';
  if (s.meta.pending && !PAUSE_OK.has(cmd.type)) return 'paused';
  if (typeof h.validate !== 'function') return null;
  try {
    const r = h.validate(s, d, cmd);
    return r === undefined ? null : r;
  } catch {
    return 'invalid:exception';
  }
}

/**
 * Validate then apply. On rejection emits commandRejected { cmd, reason } and returns false.
 * An exception thrown by apply() is caught (the game loop keeps running) and reported as
 * commandRejected { cmd, reason: 'invalid:exception', detail }.
 * @param {import('./types.js').State} s
 * @param {import('./types.js').Derived} d
 * @param {import('./types.js').Command} cmd
 * @param {import('./types.js').Env} env
 * @param {Record<string, import('./types.js').Handler>} [reg=REGISTRY]
 * @returns {boolean}
 */
export function applyCommand(s, d, cmd, env, reg = REGISTRY) {
  const reason = validateCommand(s, d, cmd, reg);
  if (reason) {
    env.emit('commandRejected', { cmd, reason });
    return false;
  }
  try {
    reg[cmd.type].apply(s, d, cmd, env);
  } catch (err) {
    env.emit('commandRejected', { cmd, reason: 'invalid:exception', detail: String((err && err.message) || err) });
    return false;
  }
  return true;
}
