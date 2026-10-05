// Patch notes (C150): the "What's new" modal (every version from data/changelog.js, newest first and open, older ones
// collapsed), the version label helpers, and the update pill shown once after an update ("Updated to v0.9.0 — see
// what's new"). The last version the player has seen lives in localStorage ('sld.lastSeenVersion', every access in
// try/catch), never in the save, so imports and resets do not touch it. A brand-new player (no save at boot) is not
// told about an update: the version is recorded silently. Entry points: the version label at the bottom of the rail
// (wide layouts), Settings → Save ("Patch notes"), and the pill. Owner: WP9.
// Contract: ARCHITECTURE §14.6 (Patch notes), §18 C150; DESIGN §25.3. Top level is DOM-free (Node imports it).

import { h } from './dom.js';
import { CHANGELOG, CURRENT_VERSION } from '../data/changelog.js';

/** localStorage key of the last version whose notes the player saw (or dismissed). */
export const LAST_SEEN_KEY = 'sld.lastSeenVersion';
/** Modal tag of the patch notes. */
export const PATCH_NOTES_TAG = 'patchNotes';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** At most this many versions start expanded (the newest plus unseen ones after a long absence). */
const MAX_OPEN = 3;
const VERSION_RE =/^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse 'MAJOR.MINOR.PATCH' → [a, b, c], or null.
 * @param {unknown} v
 * @returns {number[]|null}
 */
export function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION_RE.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Compare two versions: negative when a < b, 0 when equal, positive when a > b. An unparsable version sorts first.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** 'v0.9.0' */
export function versionLabel(v = CURRENT_VERSION) {
  return 'v' + v;
}

/**
 * 'YYYY-MM-DD' → '4 Oct 2026' (no time zone shift); anything else → ''.
 * @param {string} iso
 * @returns {string}
 */
export function fmtNoteDate(iso) {
  const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return '';
  const mo = Number(m[2]);
  return Number(m[3]) + ' ' + (MONTHS[mo - 1] || '') + ' ' + m[1];
}

/** The stored last-seen version, or null (missing, blocked storage). */
export function readLastSeen(storage) {
  try {
    const v = storage ? storage.getItem(LAST_SEEN_KEY) : null;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** Remember that the player has seen `version` (best effort). */
export function markSeen(storage, version = CURRENT_VERSION) {
  try { if (storage) storage.setItem(LAST_SEEN_KEY, version); } catch { /* storage blocked: the pill may show again next visit */ }
}

/**
 * Decide at boot whether to offer the update pill. Records the version silently for a brand-new player.
 * show = a save existed at boot and the last-seen version is missing (a player from before patch notes) or older.
 * @param {{ storage: Object|null, hadSave: boolean, current?: string }} o
 * @returns {{ show: boolean, lastSeen: string|null }}
 */
export function updateNotice({ storage, hadSave, current = CURRENT_VERSION }) {
  const lastSeen = readLastSeen(storage);
  if (!hadSave) {
    if (lastSeen === null || compareVersions(lastSeen, current) < 0) markSeen(storage, current);
    return { show: false, lastSeen };
  }
  return { show: lastSeen === null || compareVersions(lastSeen, current) < 0, lastSeen };
}

/** Every note of an entry (flat sections first-to-last, then loose notes). */
export function entryNotes(entry) {
  const out = [];
  for (const sec of Array.isArray(entry && entry.sections) ? entry.sections : []) out.push(...(Array.isArray(sec.notes) ? sec.notes : []));
  if (Array.isArray(entry && entry.notes)) out.push(...entry.notes);
  return out;
}

function noteList(notes) {
  return h('ul', { class: 'pn-list' }, notes.map((t) => h('li', { text: t })));
}

/**
 * One version as a collapsible block.
 * @param {Object} entry
 * @param {{ open?: boolean, current?: boolean }} [o]
 * @returns {HTMLElement}
 */
export function patchEntry(entry, { open = false, current = false } = {}) {
  const body = h('div', { class: 'pn-body' });
  if (Array.isArray(entry.notes) && entry.notes.length) body.appendChild(noteList(entry.notes));
  for (const sec of Array.isArray(entry.sections) ? entry.sections : []) {
    body.append(h('h4', { class: 'pn-heading', text: sec.heading }), noteList(sec.notes || []));
  }
  return h('details', { class: 'pn-entry' + (current ? ' pn-current' : ''), dataset: { version: entry.version }, attrs: { open: open ? '' : null } },
    h('summary', { class: 'pn-summary' },
      h('span', { class: 'pn-version', text: versionLabel(entry.version) }),
      h('span', { class: 'pn-title', text: entry.title }),
      h('span', { class: 'pn-date', text: fmtNoteDate(entry.date) })),
    body);
}

/**
 * The patch notes view: every version, newest first; the newest is open (and any newer than `since`, at most 3 open).
 * @param {{ changelog?: ReadonlyArray<Object>, since?: string|null }} [o]
 * @returns {HTMLElement}
 */
export function patchNotesView({ changelog = CHANGELOG, since = null } = {}) {
  return h('div', { class: 'patch-notes' },
    h('p', { class: 'note', text: 'What changed in each update, newest first. Click an older version to expand it.' }),
    changelog.map((e, i) => patchEntry(e, {
      open: i === 0 || (i < MAX_OPEN && since !== null && compareVersions(e.version, since) > 0), current: i === 0,
    })));
}

/**
 * Open the patch notes modal (or return the open one) and mark the current version seen.
 * @param {{ modals: Object, storage?: Object|null, onSeen?: Function, since?: string|null }} ctx
 * @returns {Object} modal handle
 */
export function openPatchNotes(ctx) {
  const { modals } = ctx;
  markSeen(ctx.storage || null);
  if (typeof ctx.onSeen === 'function') ctx.onSeen();
  const open = modals.find(PATCH_NOTES_TAG);
  if (open) return open;
  return modals.open({
    title: 'Patch notes', className: 'modal-patch', tag: PATCH_NOTES_TAG,
    body: [patchNotesView({ since: ctx.since || null })],
    actions: [{ label: 'Close', kind: 'primary', id: 'close' }],
  });
}

/**
 * The update pill: "Updated to v0.9.0 — see what's new" (opens the notes) and × (dismisses). Both call `onSeen`.
 * @param {{ version?: string, onOpen: Function, onDismiss: Function }} o
 * @returns {HTMLElement}
 */
export function createUpdatePill({ version = CURRENT_VERSION, onOpen, onDismiss }) {
  return h('div', { class: 'toast toast-gold update-pill', role: 'status' },
    h('button', { type: 'button', class: 'update-pill-open', text: 'Updated to ' + versionLabel(version) + ' — see what\'s new',
      on: { click: () => onOpen() } }),
    h('button', { type: 'button', class: 'toast-close', attrs: { 'aria-label': 'Dismiss' }, text: '×', on: { click: () => onDismiss() } }));
}
