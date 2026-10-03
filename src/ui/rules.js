// Rule explanations for the UI: pure read-only helpers that turn a hidden game rule into numbers a panel, tooltip or
// chip can show (Old Ridge assault immunity, the Argentine Front 10-minute window, satellite placement). They read
// state, derived values and data tables only, and mirror the systems' own checks so the UI can explain a refusal
// before the player clicks. Owner: WP9. Contract: ARCHITECTURE §3 (UI reads state and data), DESIGN §9.3 bosses,
// §15.2 Satellite Nest, ARCHITECTURE §18 C8 / C42 / C55.

import { BOSSES } from '../data/rivals.js';
import { FEDERATION } from '../data/federation.js';
import { HEX } from '../data/balance.js';
import { hexDist } from '../core/hex.js';
import { num, arr, fedLevel } from './reveal.js';
import { fmtTime } from './format.js';

const OLD_RIDGE = 'old_ridge_supercolony';
const FRONT = 'great_rival';

/** Owned hexes the Old Ridge needs before it can be assaulted (DESIGN §9.3). */
export function oldRidgeNeed() {
  return num(BOSSES[OLD_RIDGE] && BOSSES[OLD_RIDGE].immuneUntilOwned, 25);
}

/**
 * Old Ridge assault immunity: null when the rival is not the Old Ridge or can be assaulted now, else the progress
 * towards the territory gate (same test as rivals.js: owned hexes below immuneUntilOwned).
 * @param {Object} s
 * @param {Object} d
 * @param {Object|null} rival
 * @returns {{ owned: number, need: number, left: number } | null}
 */
export function oldRidgeImmunity(s, d, rival) {
  if (!rival || rival.type !== OLD_RIDGE || rival.alive === false) return null;
  const need = oldRidgeNeed();
  const owned = Math.max(0, Math.floor(num(d && d.surface && d.surface.ownedCount)));
  return owned < need ? { owned, need, left: need - owned } : null;
}

/** A rule's time span in words: "10 minutes" for whole minutes, else fmtTime ("1m 30s"). */
export function spanText(sec) {
  const v = num(sec);
  return v > 0 && v % 60 === 0 ? v / 60 + ' minute' + (v === 60 ? '' : 's') : fmtTime(v);
}

/** Seconds every Argentine Front nest must fall within (DESIGN §9.3). */
export function frontWindowSec() {
  return num(BOSSES[FRONT] && BOSSES[FRONT].windowSec, 600);
}

/** The nests of one Front group, in spawn (uid) order. */
function frontMembers(s, group) {
  return arr(s && s.run && s.run.rivals && s.run.rivals.list)
    .filter((r) => r && r.type === FRONT && r.group === group)
    .sort((a, b) => num(a.uid) - num(b.uid));
}

/**
 * Argentine Front status of one nest: its number in the group (1..3), how many have fallen, and, while the window is
 * open (some but not all fallen), the seconds left before the fallen ones regrow (rivals.js frontWindow: the window
 * starts when the first nest falls and pauses offline). null for any other rival.
 * @param {Object} s
 * @param {Object|null} rival
 * @returns {{ index: number, total: number, fallen: number, open: boolean, done: boolean, remaining: number|null,
 *   windowSec: number } | null}
 */
export function frontInfo(s, rival) {
  if (!rival || rival.type !== FRONT || !rival.group) return null;
  const members = frontMembers(s, rival.group);
  const total = members.length;
  const fallenList = members.filter((r) => r.alive === false);
  const fallen = fallenList.length;
  const windowSec = frontWindowSec();
  const open = fallen > 0 && fallen < total;
  let remaining = null;
  if (open) {
    const first = Math.min(...fallenList.map((r) => num(r.fallenAt, num(s.run.time))));
    remaining = Math.max(0, first + windowSec - num(s.run.time));
  }
  return { index: members.indexOf(rival) + 1, total, fallen, open, done: total > 0 && fallen === total, remaining, windowSec };
}

/**
 * Open Front windows (one per group with some but not all nests fallen), soonest deadline first.
 * @param {Object} s
 * @returns {Array<{ group: number, fallen: number, total: number, remaining: number, target: Object|null }>}
 *   target = the standing nest nearest the main entrance (for "locate").
 */
export function frontWindows(s) {
  const out = [];
  const groups = new Set();
  for (const r of arr(s && s.run && s.run.rivals && s.run.rivals.list)) if (r && r.type === FRONT && r.group) groups.add(r.group);
  for (const g of groups) {
    const members = frontMembers(s, g);
    const info = frontInfo(s, members[0]);
    if (!info || !info.open) continue;
    const standing = members.filter((r) => r.alive !== false);
    standing.sort((a, b) => hexDist(0, num(a.hex)) - hexDist(0, num(b.hex)) || num(a.uid) - num(b.uid));
    out.push({ group: g, fallen: info.fallen, total: info.total, remaining: num(info.remaining), target: standing[0] || null });
  }
  out.sort((a, b) => a.remaining - b.remaining);
  return out;
}

/**
 * Display name suffix of a Front nest ("nest 2/3"), '' for other rivals (the three nests share one name).
 * @param {Object} s
 * @param {Object} rival
 * @returns {string}
 */
export function frontLabel(s, rival) {
  const f = frontInfo(s, rival);
  return f && f.total > 1 ? ' (nest ' + f.index + '/' + f.total + ')' : '';
}

/** Satellite Nest placement numbers (data/federation.js satellite_nest.fx). */
export function satelliteRule() {
  const fx = (FEDERATION.satellite_nest && FEDERATION.satellite_nest.fx) || {};
  return { minDist: num(fx.minDist, 3), colGap: num(fx.colGap, 4) };
}

/** Satellites the player may still place this run (Satellite Nest level − satellites placed). */
export function satellitesFree(s) {
  const lvl = fedLevel(s, 'satellite_nest');
  const placed = arr(s && s.run && s.run.surface && s.run.surface.entrances).filter((e) => e && e.kind === 'satellite').length;
  return Math.max(0, lvl - placed);
}

/** Distance from a hex to the nearest entrance of any kind (Infinity when there is none). */
export function nearestEntranceDist(s, hex) {
  let best = Infinity;
  for (const e of arr(s && s.run && s.run.surface && s.run.surface.entrances)) {
    if (!e || !Number.isInteger(e.hex) || e.hex < 0) continue;
    best = Math.min(best, hexDist(e.hex, hex));
  }
  return best;
}

/**
 * Hex part of the placeSatellite rule (prestige.js satelliteReason without the shaft column): the reason a satellite
 * cannot go on this hex, or null. Codes match the validator ('locked', 'max', 'invalid:hex', 'blocked:unowned',
 * 'blocked:terrain', 'blocked:entrance'), so text.js reasonText explains them.
 * @param {Object} s
 * @param {Object} d
 * @param {number} hex
 * @returns {string|null}
 */
export function satelliteHexReason(s, d, hex) {
  if (!s || !s.run) return 'invalid';
  if (fedLevel(s, 'satellite_nest') <= 0) return 'locked';
  if (satellitesFree(s) <= 0) return 'max';
  if (!Number.isInteger(hex) || hex < 0 || hex >= num(HEX && HEX.count, 817)) return 'invalid:hex';
  const owned = d && d.surface && d.surface.owned;
  if (!owned || !(owned[hex] > 0)) return 'blocked:unowned';
  const passable = d.surface.passable;
  if (passable && passable[hex] === 0) return 'blocked:terrain';
  if (nearestEntranceDist(s, hex) < satelliteRule().minDist) return 'blocked:entrance';
  return null;
}

/**
 * Every hex a satellite could go on right now (hex part of the rule), ascending.
 * @param {Object} s
 * @param {Object} d
 * @returns {number[]}
 */
export function satelliteHexes(s, d) {
  const out = [];
  const owned = d && d.surface && d.surface.owned;
  if (!owned || satellitesFree(s) <= 0) return out;
  const n = Math.min(num(HEX && HEX.count, 817), owned.length);
  for (let hex = 0; hex < n; hex++) if (owned[hex] > 0 && satelliteHexReason(s, d, hex) === null) out.push(hex);
  return out;
}

/**
 * One-line explanation of why a satellite cannot go on a hex, with the numbers ("2 hexes from an entrance; needs 3").
 * '' when it can.
 * @param {Object} s
 * @param {Object} d
 * @param {number} hex
 * @param {(reason: string) => string} reasonText text.js reasonText
 * @returns {string}
 */
export function satelliteHexWhy(s, d, hex, reasonText) {
  const r = satelliteHexReason(s, d, hex);
  if (!r) return '';
  if (r === 'blocked:entrance') {
    const dist = nearestEntranceDist(s, hex);
    const need = satelliteRule().minDist;
    return 'Too close to an entrance: ' + dist + ' hex' + (dist === 1 ? '' : 'es') + ' away, satellites need ' + need + '+.';
  }
  return reasonText(r, 'placeSatellite');
}
