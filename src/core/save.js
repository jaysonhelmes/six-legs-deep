// Save codec: RLE packing of the big arrays, FNV-1a checksum, UTF-8 base64, the SLD1 export string (same format as the
// local save), and a try/catch storage wrapper. Owner: WP1. Contract: ARCHITECTURE §7.13 (DESIGN §22).

import { SAVE, GRID, HEX } from '../data/balance.js';
import { SCHEMA_VERSION } from './state.js';
import { migrate, fillDefaults } from './migrations.js';
import { guardAll } from './guard.js';

/** State paths stored run-length encoded. */
export const RLE_PATHS = ['run.nest.cells', 'run.surface.terrain', 'run.surface.revealed', 'run.surface.claimed', 'run.surface.conquered'];

const RLE_PREFIX = 'rle:';

/**
 * Run-length encode a number array: "rle:" + runs joined by ","; run = "v*n" (or "v" when n = 1).
 * [0,0,0,1] → "rle:0*3,1".
 * @param {number[]} arr
 * @returns {string}
 */
export function rleEncode(arr) {
  const parts = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    let n = 1;
    while (i + n < arr.length && arr[i + n] === v) n++;
    parts.push(n === 1 ? String(v) : v + '*' + n);
    i += n;
  }
  return RLE_PREFIX + parts.join(',');
}

/**
 * Decode an RLE string produced by rleEncode. Throws on malformed input.
 * @param {string} str
 * @returns {number[]}
 */
export function rleDecode(str) {
  if (typeof str !== 'string' || !str.startsWith(RLE_PREFIX)) throw new Error('rleDecode: bad prefix');
  const body = str.slice(RLE_PREFIX.length);
  const out = [];
  if (body.length === 0) return out;
  for (const part of body.split(',')) {
    const star = part.indexOf('*');
    const vs = star < 0 ? part : part.slice(0, star);
    const ns = star < 0 ? '1' : part.slice(star + 1);
    if (vs === '' || ns === '') throw new Error('rleDecode: bad run');
    const v = Number(vs);
    const n = Number(ns);
    if (!Number.isFinite(v) || !Number.isInteger(n) || n < 1) throw new Error('rleDecode: bad run');
    if (out.length + n > 1e7) throw new Error('rleDecode: too long');
    for (let k = 0; k < n; k++) out.push(v);
  }
  return out;
}

const BITS_PREFIX = 'bits:';
const BITS_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Pack a 0/1 mask (truthy = 1) into "bits:" + one base64url character per 6 cells (cell i → char ⌊i/6⌋, bit i mod 6),
 * trailing all-zero characters dropped. Used for Strata silhouettes (F26): a bounded ≤ ⌈n/6⌉ characters per record
 * whatever the nest looks like, where RLE of the full cell codes grew past 1 KB for a dug-out nest.
 * @param {ArrayLike<number|boolean>} mask
 * @returns {string}
 */
export function bitsEncode(mask) {
  const n = mask && Number.isFinite(mask.length) ? mask.length : 0;
  let out = '';
  for (let i = 0; i < n; i += 6) {
    let v = 0;
    for (let b = 0; b < 6 && i + b < n; b++) if (mask[i + b]) v |= 1 << b;
    out += BITS_ALPHA[v];
  }
  let end = out.length;
  while (end > 0 && out[end - 1] === 'A') end--;
  return BITS_PREFIX + out.slice(0, end);
}

/**
 * Decode a bitsEncode string to `length` numbers: `on` where the bit is set, else `off`. Unknown characters read as 0.
 * @param {string} str
 * @param {number} length
 * @param {number} [on=1]
 * @param {number} [off=0]
 * @returns {number[]}
 */
export function bitsDecode(str, length, on = 1, off = 0) {
  const n = Number.isInteger(length) && length > 0 ? Math.min(length, 1e7) : 0;
  const out = new Array(n).fill(off);
  if (typeof str !== 'string' || !str.startsWith(BITS_PREFIX)) return out;
  const body = str.slice(BITS_PREFIX.length);
  for (let k = 0; k < body.length; k++) {
    const v = BITS_ALPHA.indexOf(body[k]);
    if (v <= 0) continue;
    for (let b = 0; b < 6; b++) {
      const i = k * 6 + b;
      if (i < n && (v >> b) & 1) out[i] = on;
    }
  }
  return out;
}

/** Get the parent object and final key of a dotted path, or null. */
function locate(obj, path) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!o || typeof o !== 'object') return null;
    o = o[keys[i]];
  }
  if (!o || typeof o !== 'object') return null;
  return [o, keys[keys.length - 1]];
}

/**
 * Deep copy of the state with RLE_PATHS packed into RLE strings.
 * @param {import('./types.js').State} s
 * @returns {Object}
 */
export function encodeState(s) {
  const out = JSON.parse(JSON.stringify(s));
  for (const p of RLE_PATHS) {
    const loc = locate(out, p);
    if (loc && Array.isArray(loc[0][loc[1]])) loc[0][loc[1]] = rleEncode(loc[0][loc[1]]);
  }
  return out;
}

/**
 * Inverse of encodeState: deep copy with RLE strings unpacked. Throws on malformed RLE.
 * @param {Object} obj
 * @returns {import('./types.js').State}
 */
export function decodeState(obj) {
  const out = JSON.parse(JSON.stringify(obj));
  for (const p of RLE_PATHS) {
    const loc = locate(out, p);
    if (loc && typeof loc[0][loc[1]] === 'string') loc[0][loc[1]] = rleDecode(loc[0][loc[1]]);
  }
  return out;
}

const TE = new TextEncoder();

/**
 * FNV-1a 32-bit over the UTF-8 bytes of str; 8 lowercase hex chars.
 * @param {string} str
 * @returns {string}
 */
export function fnv1a(str) {
  const bytes = TE.encode(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/**
 * UTF-8 → base64 (own implementation via TextEncoder; no btoa/Buffer).
 * @param {string} str
 * @returns {string}
 */
export function utf8ToBase64(str) {
  const b = TE.encode(str);
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = b[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/**
 * base64 → UTF-8 string. Throws on invalid base64 or invalid UTF-8.
 * @param {string} b64
 * @returns {string}
 */
export function base64ToUtf8(b64) {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0) throw new Error('base64: bad length');
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  const n = b64.length;
  const bytes = new Uint8Array((n / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const last = i + 4 === n;
    const c = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const code = b64.charCodeAt(i + k);
      if (last && code === 61 /* '=' */ && k >= 4 - pad) { c[k] = 0; continue; }
      const v = code < 128 ? B64_INV[code] : -1;
      if (v < 0) throw new Error('base64: bad character');
      c[k] = v;
    }
    const triple = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    if (o < bytes.length) bytes[o++] = (triple >> 16) & 255;
    if (o < bytes.length) bytes[o++] = (triple >> 8) & 255;
    if (o < bytes.length) bytes[o++] = triple & 255;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Export string (also the local save): SAVE.prefix + base64(json) + ':' + fnv1a(json),
 * json = JSON.stringify({ v, savedAt, state: encodeState(s) }).
 * @param {import('./types.js').State} s
 * @param {number} nowMs
 * @returns {string}
 */
export function toExportString(s, nowMs) {
  const json = JSON.stringify({ v: s.v, savedAt: Number.isFinite(nowMs) ? nowMs : 0, state: encodeState(s) });
  return SAVE.prefix + utf8ToBase64(json) + ':' + fnv1a(json);
}

/** Structural sanity of a decoded state (after fillDefaults). */
function validState(st) {
  if (!st || typeof st !== 'object' || Array.isArray(st)) return false;
  for (const k of ['meta', 'era', 'cycle', 'run']) if (!st[k] || typeof st[k] !== 'object' || Array.isArray(st[k])) return false;
  const run = st.run;
  if (!run.nest || !Array.isArray(run.nest.cells) || run.nest.cells.length !== GRID.cols * GRID.rows) return false;
  if (!run.surface) return false;
  for (const k of ['terrain', 'revealed', 'claimed', 'conquered']) {
    if (!Array.isArray(run.surface[k]) || run.surface[k].length !== HEX.count) return false;
  }
  return true;
}

/**
 * Parse and validate an export string: prefix → split on the LAST ':' → base64 → checksum → JSON.parse →
 * v ≤ SCHEMA_VERSION → migrate → decodeState → fillDefaults → guardAll.
 * Whitespace inside the string (pasted line breaks) is ignored.
 * @param {string} str
 * @returns {{ ok: true, state: import('./types.js').State, savedAt: number } |
 *           { ok: false, error: 'badPrefix'|'badBase64'|'badChecksum'|'badJson'|'tooNew'|'migrationFailed'|'invalidState' }}
 */
export function fromExportString(str) {
  if (typeof str !== 'string') return { ok: false, error: 'badPrefix' };
  const clean = str.replace(/\s+/g, '');
  if (!clean.startsWith(SAVE.prefix)) return { ok: false, error: 'badPrefix' };
  const body = clean.slice(SAVE.prefix.length);
  const cut = body.lastIndexOf(':');
  if (cut < 0) return { ok: false, error: 'badChecksum' };
  const b64 = body.slice(0, cut);
  const sum = body.slice(cut + 1).toLowerCase();
  let json;
  try {
    json = base64ToUtf8(b64);
  } catch {
    return { ok: false, error: 'badBase64' };
  }
  if (fnv1a(json) !== sum) return { ok: false, error: 'badChecksum' };
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return { ok: false, error: 'badJson' };
  }
  if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.v) || !payload.state || typeof payload.state !== 'object') {
    return { ok: false, error: 'invalidState' };
  }
  if (payload.v > SCHEMA_VERSION) return { ok: false, error: 'tooNew' };
  try {
    payload = migrate(payload);
  } catch {
    return { ok: false, error: 'migrationFailed' };
  }
  let state;
  try {
    state = decodeState(payload.state);
    fillDefaults(state);
    if (!validState(state)) return { ok: false, error: 'invalidState' };
    state.v = SCHEMA_VERSION;
    guardAll(state);
  } catch {
    return { ok: false, error: 'invalidState' };
  }
  return { ok: true, state, savedAt: Number.isFinite(payload.savedAt) ? payload.savedAt : 0 };
}

/**
 * Wrap a Storage-like object; every call is in try/catch. With storage = null: get → null, set/remove → false.
 * `lastError` holds the message of the most recent failure (null after a successful call).
 * @param {import('./types.js').StorageLike|null} storage
 * @returns {import('./types.js').StorageWrap}
 */
export function storageWrap(storage) {
  const w = {
    lastError: null,
    get(key) {
      if (!storage) { w.lastError = 'noStorage'; return null; }
      try {
        const v = storage.getItem(key);
        w.lastError = null;
        return typeof v === 'string' ? v : null;
      } catch (e) {
        w.lastError = String((e && e.message) || e);
        return null;
      }
    },
    set(key, val) {
      if (!storage) { w.lastError = 'noStorage'; return false; }
      try {
        storage.setItem(key, val);
        w.lastError = null;
        return true;
      } catch (e) {
        w.lastError = String((e && e.message) || e);
        console.error('[save] storage write failed', e);
        return false;
      }
    },
    remove(key) {
      if (!storage) { w.lastError = 'noStorage'; return false; }
      try {
        storage.removeItem(key);
        w.lastError = null;
        return true;
      } catch (e) {
        w.lastError = String((e && e.message) || e);
        return false;
      }
    },
  };
  return w;
}
