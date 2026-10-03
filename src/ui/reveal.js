// Reveal-on-unlock helper for every UI element (ARCHITECTURE §14.5 "every element declares its unlock key; it is
// shown when unlocks.isRevealed(s, key)") plus small ownership lookups the panels share. Owner: WP9. Pure module.
// tab_guide / tab_stats / tab_settings are always shown (ARCHITECTURE §11 "always"), so the player can always reach
// Export, Import and Hard reset even if the unlock system misbehaves.

import { isRevealed, isUnlocked } from '../systems/unlocks.js';
import { isOwned } from '../systems/research.js';

/** Keys that are always revealed. */
export const ALWAYS_KEYS = Object.freeze(new Set(['tab_guide', 'tab_stats', 'tab_settings']));

let revealAll = false;
/** @type {((s: Object, key: string) => boolean) | null} */
let provider = null;

/**
 * Debug/preview switch (main.js sets it for `?reveal=all`): every element is shown.
 * @param {boolean} on
 */
export function setRevealAll(on) {
  revealAll = !!on;
}

/**
 * Replace the reveal predicate (tests inject a contract-faithful fake so they do not depend on WP6's implementation).
 * null restores unlocks.isRevealed.
 * @param {((s: Object, key: string) => boolean) | null} fn
 */
export function setRevealProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

/** @returns {boolean} whether the reveal-all preview switch is on */
export function getRevealAll() {
  return revealAll;
}

/**
 * True when the element gated by `key` should be shown. key null/'' = always; an array means "any of".
 * @param {Object} s state
 * @param {string|string[]|null} key
 * @returns {boolean}
 */
export function isShown(s, key) {
  if (key === null || key === undefined || key === '') return true;
  if (Array.isArray(key)) {
    for (const k of key) if (isShown(s, k)) return true;
    return key.length === 0;
  }
  if (revealAll || ALWAYS_KEYS.has(key)) return true;
  if (!s || !s.run) return false;
  try {
    return !!(provider ? provider(s, key) : isRevealed(s, key));
  } catch {
    return !!(s.run.unlocked && s.run.unlocked[key]);
  }
}

/**
 * Gameplay availability (unlocked, regardless of the reveal animation queue).
 * @param {Object} s
 * @param {string|null} key
 * @returns {boolean}
 */
export function isAvailableKey(s, key) {
  if (!key) return true;
  if (revealAll) return true;
  if (!s || !s.run) return false;
  try {
    return !!isUnlocked(s, key);
  } catch {
    return !!(s.run.unlocked && s.run.unlocked[key]);
  }
}

/** Research owned this run. */
export function hasResearch(s, id) {
  if (!s || !s.run) return false;
  try {
    return !!isOwned(s, id);
  } catch {
    return !!(s.run.research && s.run.research[id]);
  }
}

/** Bloodline trait level. */
export function traitLevel(s, id) {
  const v = s && s.cycle && s.cycle.traits ? s.cycle.traits[id] : 0;
  return Number.isFinite(v) ? v : 0;
}

/** Federation node level. */
export function fedLevel(s, id) {
  const v = s && s.era && s.era.federation ? s.era.federation[id] : 0;
  return Number.isFinite(v) ? v : 0;
}

/** Genome node level. */
export function genomeLevel(s, id) {
  const v = s && s.meta && s.meta.genome ? s.meta.genome[id] : 0;
  return Number.isFinite(v) ? v : 0;
}

/** Finite number or a fallback (defensive reads of partial state). */
export function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Array or []. */
export function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** Plain object or {}. */
export function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
