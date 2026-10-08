// Event log (ARCHITECTURE §18 C190; DESIGN §25.3): a scrollable record of notable happenings with their run time —
// event cards and how they ended (the choice and its outcome), raids and battles, conquests, blueprint placements /
// drops / adjustments and water strikes, achievements, unlocks, Field Guide entries, Flights, Supercolonies and
// Speciations. The shell (app.js) feeds bus events through logEntryFor() into a createEventLog() store; the log opens
// as a modal from the "Log" icon in the tab row, the Stats tab and the "Log" link on event-outcome toasts.
// The last LOG_MAX entries stay in memory; the last LOG_PERSIST are kept per browser in localStorage (LOG_KEY, tied to
// the colony by meta.createdAt, every access in try/catch), outside the save, so the save size budget is untouched.
// Owner: WP9. Top level is DOM-free apart from the modal builder (Node imports it).

import { h, clear, setText } from './dom.js';
import { fmt, fmtCount } from './format.js';
import { nameOf, humanize, CHOICE_LABELS, BATTLE_NAMES, EVENT_COPY, unlockLabel, blueprintNote, lootText } from './text.js';
import { EVENTS } from '../data/events.js';

/** Entries kept in memory. */
export const LOG_MAX = 200;
/** Entries kept in localStorage. */
export const LOG_PERSIST = 50;
/** localStorage key (a per-browser record, outside the save). */
export const LOG_KEY = 'sld.eventLog';
/** Modal tag. */
export const LOG_TAG = 'eventLog';

/** Categories in filter-chip order. */
export const LOG_CATS = Object.freeze(['events', 'war', 'nest', 'progress', 'prestige']);
export const LOG_CAT_NAMES = Object.freeze({ all: 'All', events: 'Events', war: 'Raids & battles', nest: 'Nest & blueprints',
  progress: 'Achievements & unlocks', prestige: 'Flights & prestige' });

/**
 * Run-time stamp: "4:05" under an hour, "1:14:05" beyond.
 * @param {number} sec
 * @returns {string}
 */
export function fmtStamp(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return hh > 0 ? hh + ':' + p2(mm) + ':' + p2(ss) : mm + ':' + p2(ss);
}

/** Readable choice / outcome word: the card button label, else the humanized id ("harvested" → "Harvested"). */
export function choiceText(choice) {
  if (typeof choice !== 'string' || !choice) return '';
  return CHOICE_LABELS[choice] || humanize(choice);
}

const sentence = (t) => {
  const x = String(t || '').trim();
  return x && !/[.!?…]$/.test(x) ? x + '.' : x;
};

/** Rival display name from a uid / type. */
function rivalOf(s, uid, type) {
  if (typeof type === 'string' && type) return nameOf('rival', type);
  const list = s && s.run && s.run.rivals && Array.isArray(s.run.rivals.list) ? s.run.rivals.list : [];
  const r = list.find((x) => x && x.uid === uid);
  return r ? nameOf('rival', r.type) : 'Rivals';
}

/**
 * Log entry for a bus event, or null when the event is not log-worthy. Pure.
 * eventResolved: the richer payload { eventId, choice, outcomeText } is used when present (id / choice otherwise).
 * blueprintPlaced / blueprintAdjusted / waterStruck: a payload `text` wins; otherwise a short generic line.
 * @param {Object} e bus event { type, ...payload }
 * @param {Object} [s] state (names)
 * @returns {{ cat: string, text: string, kind: string } | null}
 */
export function logEntryFor(e, s = null) {
  if (!e || typeof e.type !== 'string') return null;
  const chamber = (t) => nameOf('chamber', t) || 'Chamber';
  switch (e.type) {
    case 'eventSpawned': {
      const id = e.eventId || e.id;
      const neg = EVENTS[id] && EVENTS[id].polarity === 'neg';
      const copy = EVENT_COPY[id];
      const name = nameOf('event', id);
      const text = copy ? (copy.toLowerCase().startsWith(name.toLowerCase()) ? copy : name + ': ' + copy) : name;
      return { cat: 'events', text: sentence(text), kind: neg ? 'bad' : 'event' };
    }
    case 'eventResolved': {
      const id = e.eventId || e.id;
      const name = nameOf('event', id);
      const ch = choiceText(e.choice);
      const out = typeof e.outcomeText === 'string' && e.outcomeText.trim() ? e.outcomeText.trim() : '';
      const text = name + (ch ? ': ' + ch : '') + (out ? ' — ' + out : '');
      const bad = e.choice === 'lost' || e.choice === 'failed' || e.choice === 'stomped' || e.choice === 'expired';
      return { cat: 'events', text: sentence(text), kind: bad ? 'bad' : 'good' };
    }
    case 'raidWarning': {
      const tgt = e.target && e.target.type === 'trail' ? 'a trail' : 'the nest';
      return { cat: 'war', text: rivalOf(s, e.rival, e.rivalType) + ' are coming to raid ' + tgt + '.', kind: 'bad' };
    }
    case 'raidResult':
      if (e.win) return { cat: 'war', text: 'Raid repelled' + (e.rival ? ' (' + rivalOf(s, e.rival) + ')' : '') + '.', kind: 'good' };
      return { cat: 'war', text: 'Raid lost: ' + fmt(Number(e.foodLost) || 0) + ' food, ' + fmtCount(Number(e.broodLost) || 0) + ' brood, '
        + fmtCount(Number(e.workersLost) || 0) + ' workers taken.', kind: 'bad' };
    case 'battleEnd': {
      const what = BATTLE_NAMES[e.kind] || 'Battle';
      // C207: e.lost is { soldier, supermajor, militia }; a won raid / hunt names its loot
      const L = e.lost && typeof e.lost === 'object' ? e.lost : null;
      const lost = L ? (Number(L.soldier) || 0) + (Number(L.supermajor) || 0) + (Number(L.militia) || 0) : Number(e.lost) || 0;
      const kills = Number(e.kills) || 0;
      const loot = e.win ? lootText(e.loot) : '';
      return { cat: 'war', text: what + (e.win ? ' won' : ' lost') + (kills > 0 || lost > 0 ? ' (' + fmtCount(kills) + ' foes down, ' + fmtCount(lost) + ' ants lost)' : '') + '.'
        + (loot ? ' ' + loot + '.' : ''), kind: e.win ? 'good' : 'bad' };
    }
    case 'conquest': {
      const loot = lootText(e.loot);
      return { cat: 'war', text: 'Conquered ' + rivalOf(s, e.uid, e.rivalType) + '!' + (loot ? ' ' + loot + '.' : ''), kind: 'good' };
    }
    case 'blueprintPlaced': {
      if (typeof e.text === 'string' && e.text) return { cat: 'nest', text: sentence(e.text), kind: 'info' };
      const n = Number(e.n ?? e.count ?? e.chambers);
      return { cat: 'nest', text: Number.isFinite(n) && n > 0
        ? 'Blueprint laid out: ' + fmtCount(n) + ' planned chamber' + (n === 1 ? '' : 's') + '.'
        : (e.chamberType ? 'Blueprint: ' + chamber(e.chamberType) + ' planned.' : 'Blueprint laid out.'), kind: 'info' };
    }
    case 'blueprintDropped': return { cat: 'nest', text: blueprintNote(e).text, kind: 'info' };
    case 'blueprintAdjusted': {
      if (typeof e.text === 'string' && e.text) return { cat: 'nest', text: sentence(e.text), kind: 'info' };
      return { cat: 'nest', text: 'Blueprint adjusted' + (e.chamberType ? ': ' + chamber(e.chamberType) + ' moved to fit this nest' : '') + '.', kind: 'info' };
    }
    case 'waterStruck': {
      if (typeof e.text === 'string' && e.text) return { cat: 'nest', text: sentence(e.text), kind: 'bad' };
      return { cat: 'nest', text: 'Diggers struck water' + (Number.isFinite(e.y) ? ' at row ' + e.y : '') + '.', kind: 'bad' };
    }
    case 'chamberActivated':
      return Number(e.level) > 1 ? null : { cat: 'nest', text: chamber(e.chamberType) + ' complete.', kind: 'good' };
    case 'cacheFound': return { cat: 'nest', text: 'Found a ' + humanize(e.kind).toLowerCase() + ': +' + fmt(Number(e.amount) || 0) + ' ' + nameOf('res', e.res).toLowerCase() + '.', kind: 'good' };
    // C214: a tunnel the player did not draw (a mole, a blueprint's tunnels or an access tunnel for a planned chamber)
    case 'tunnelAuto': return { cat: 'nest', text: tunnelAutoText(e), kind: 'info' };
    case 'entranceOpened': return { cat: 'nest', text: 'A new entrance opened to the surface.', kind: 'good' };
    case 'achievement': return { cat: 'progress', text: 'Achievement: ' + nameOf('achievement', e.id) + '.', kind: 'gold' };
    case 'unlock': return { cat: 'progress', text: 'Unlocked: ' + unlockLabel(e.key) + '.', kind: 'info' };
    case 'fieldGuide': return { cat: 'progress', text: 'Field Guide entry: ' + nameOf('guide', e.id) + '.', kind: 'info' };
    case 'researchBought': return { cat: 'progress', text: 'Researched ' + nameOf('research', e.id) + '.', kind: 'info' };
    case 'hardshipTier': return { cat: 'prestige', text: nameOf('hardship', e.id) + ': tier ' + e.tier + ' reached.', kind: 'gold' };
    case 'flightComplete': return { cat: 'prestige', text: 'Nuptial Flight: ' + fmtCount(Number(e.alates) || 0) + ' alates took wing.', kind: 'gold' };
    case 'supercolonyComplete': return { cat: 'prestige', text: 'Supercolony formed: +' + fmtCount(Number(e.kinship) || 0) + ' kinship.', kind: 'gold' };
    case 'speciationComplete': return { cat: 'prestige', text: 'Speciation: +' + fmtCount(Number(e.genes) || 0) + ' genes.', kind: 'gold' };
    case 'runStarted': return { cat: 'prestige', text: 'Run ' + fmtCount((Number(e.index) || 0) + 1) + ' begins.', kind: 'info' };
    default: return null;
  }
}

/**
 * C214: event-log line for tunnelAuto { reason, chamberType, n }: "A mole dug 9 tunnel cells.", "Access tunnel (6 cells)
 * queued for the planned Granary.", "Blueprint tunnels queued (14 cells).".
 * @param {Object} e
 * @returns {string}
 */
export function tunnelAutoText(e) {
  const n = Number(e && (e.n !== undefined ? e.n : Array.isArray(e.cells) ? e.cells.length : 0)) || 0;
  const cells = fmtCount(n) + ' cell' + (n === 1 ? '' : 's');
  const ch = e && e.chamberType ? nameOf('chamber', e.chamberType) || '' : '';
  switch (e && e.reason) {
    case 'mole': return 'A mole dug a free tunnel (' + cells + ').';
    case 'access': return 'Access tunnel (' + cells + ') queued for the planned ' + (ch || 'chamber') + '.';
    case 'blueprint': return 'Blueprint tunnels queued (' + cells + ').';
    case 'route': return 'Tunnel (' + cells + ') routed to the new ' + (ch || 'chamber') + '.';
    case 'shaft': return (ch ? ch + ' exit shaft' : 'Entrance shaft') + ' queued (' + cells + ').';
    default: return 'Tunnel queued (' + cells + ').';
  }
}

/** Bus event types the shell feeds into the log. */
export const LOG_EVENTS = Object.freeze(['eventSpawned', 'eventResolved', 'raidWarning', 'raidResult', 'battleEnd', 'conquest',
  'blueprintPlaced', 'blueprintDropped', 'blueprintAdjusted', 'waterStruck', 'chamberActivated', 'cacheFound', 'entranceOpened', 'tunnelAuto',
  'achievement', 'unlock', 'fieldGuide', 'researchBought', 'hardshipTier', 'flightComplete', 'supercolonyComplete', 'speciationComplete',
  'runStarted']);

/** A stored entry is well formed. */
function validEntry(x) {
  return !!x && typeof x === 'object' && typeof x.text === 'string' && x.text.length > 0 && x.text.length <= 400
    && LOG_CATS.includes(x.cat) && Number.isFinite(x.t);
}

/**
 * The log store. add() keeps the newest `max`; persist(colony) writes the newest `persistMax` (with the colony id) to
 * storage; load(colony) reads them back when they belong to the same colony.
 * @param {{ storage?: Storage|null, max?: number, persistMax?: number }} [o]
 */
export function createEventLog({ storage = null, max = LOG_MAX, persistMax = LOG_PERSIST } = {}) {
  /** @type {Array<{ id: number, t: number, run: number, cat: string, text: string, kind: string }>} */
  let list = [];
  let seq = 0;
  let dirty = false;
  const subs = new Set();
  const notify = () => { for (const fn of Array.from(subs)) { try { fn(); } catch { /* listener */ } } };

  return {
    /**
     * Add an entry { t, run, cat, text, kind }; returns it (with its id) or null when malformed.
     * Repeats of the same text within 1 s of run time are folded into one ("×2").
     */
    add(entry) {
      if (!validEntry(entry)) return null;
      const last = list[list.length - 1];
      if (last && last.text === entry.text && last.run === (entry.run | 0) && Math.abs(last.t - entry.t) < 1) {
        last.n = (last.n || 1) + 1;
        dirty = true;
        notify();
        return last;
      }
      const e = { id: ++seq, t: entry.t, run: Number.isFinite(entry.run) ? entry.run | 0 : 0, cat: entry.cat, text: entry.text,
        kind: typeof entry.kind === 'string' ? entry.kind : 'info' };
      list.push(e);
      if (list.length > max) list = list.slice(list.length - max);
      dirty = true;
      notify();
      return e;
    },
    /**
     * Entries, newest first, optionally of one category ('all' or null = every category).
     * @param {string|null} [cat]
     */
    entries(cat = null) {
      const out = cat && cat !== 'all' ? list.filter((e) => e.cat === cat) : list.slice();
      return out.reverse();
    },
    /** Count per category (and 'all'). */
    counts() {
      const c = { all: list.length };
      for (const k of LOG_CATS) c[k] = 0;
      for (const e of list) c[e.cat]++;
      return c;
    },
    size() {
      return list.length;
    },
    clear() {
      list = [];
      dirty = true;
      notify();
    },
    /** True when entries changed since the last persist(). */
    isDirty() {
      return dirty;
    },
    /** Write the newest persistMax entries for this colony (best effort). */
    persist(colony) {
      dirty = false;
      if (!storage) return false;
      try {
        const keep = list.slice(-persistMax).map(({ t, run, cat, text, kind, n }) => (n > 1 ? { t, run, cat, text, kind, n } : { t, run, cat, text, kind }));
        storage.setItem(LOG_KEY, JSON.stringify({ v: 1, colony: Number(colony) || 0, entries: keep }));
        return true;
      } catch {
        return false;
      }
    },
    /** Replace the log with the stored entries of this colony (others are ignored). Returns the number loaded. */
    load(colony) {
      list = [];
      if (!storage) return 0;
      try {
        const raw = storage.getItem(LOG_KEY);
        const data = raw ? JSON.parse(raw) : null;
        if (!data || data.v !== 1 || Number(data.colony) !== (Number(colony) || 0) || !Array.isArray(data.entries)) return 0;
        for (const x of data.entries.slice(-persistMax)) {
          if (!validEntry(x)) continue;
          list.push({ id: ++seq, t: x.t, run: Number.isFinite(x.run) ? x.run | 0 : 0, cat: x.cat, text: x.text,
            kind: typeof x.kind === 'string' ? x.kind : 'info', ...(x.n > 1 ? { n: x.n | 0 } : {}) });
        }
      } catch {
        list = [];
      }
      dirty = false;
      notify();
      return list.length;
    },
    /** Subscribe to changes (the open modal re-renders). */
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/**
 * Open (or focus) the Event log modal.
 * @param {{ modals: Object, log: ReturnType<typeof createEventLog>, game: Object }} ctx
 * @param {{ cat?: string, highlight?: number }} [o] start on a category; highlight an entry id
 * @returns {Object} the modal handle
 */
export function openEventLog(ctx, { cat = 'all', highlight = 0 } = {}) {
  const { modals, log } = ctx;
  const open = modals.find(LOG_TAG);
  if (open) {
    if (open.setView) open.setView(cat, highlight);
    return open;
  }
  let filter = LOG_CATS.includes(cat) ? cat : 'all';
  let mark = highlight;
  const chips = h('div', { class: 'log-chips', role: 'group', attrs: { 'aria-label': 'Filter the log' } });
  const chipEls = {};
  for (const id of ['all', ...LOG_CATS]) {
    const b = h('button', { type: 'button', class: 'chip log-chip', dataset: { cat: id }, attrs: { 'aria-pressed': 'false' },
      on: { click: () => { filter = id; mark = 0; render(); } } },
    h('span', { class: 'log-chip-name', text: LOG_CAT_NAMES[id] }), h('span', { class: 'log-chip-n' }));
    chipEls[id] = b;
    chips.appendChild(b);
  }
  const listEl = h('ol', { class: 'log-list', attrs: { 'aria-live': 'polite' } });
  const empty = h('p', { class: 'note log-empty', text: 'Nothing here yet. Notable happenings are listed as they occur.' });
  const note = h('p', { class: 'note log-foot', text: 'Times are run time. The last ' + LOG_PERSIST + ' entries are kept in this browser.' });

  function render() {
    const counts = log.counts();
    for (const id of Object.keys(chipEls)) {
      const on = id === filter;
      chipEls[id].classList.toggle('active', on);
      chipEls[id].setAttribute('aria-pressed', on ? 'true' : 'false');
      setText(chipEls[id].querySelector('.log-chip-n'), String(counts[id] || 0));
    }
    const rows = log.entries(filter);
    clear(listEl);
    empty.hidden = rows.length > 0;
    const runs = new Set(rows.map((e) => e.run)).size;
    let lastRun = null;
    for (const e of rows) {
      if (runs > 1 && e.run !== lastRun) listEl.appendChild(h('li', { class: 'log-run-sep', text: 'Run ' + (e.run + 1) }));
      lastRun = e.run;
      const li = h('li', { class: 'log-row log-' + e.kind + (e.id === mark ? ' highlight' : ''), dataset: { cat: e.cat, id: String(e.id) } },
        h('span', { class: 'log-time', text: fmtStamp(e.t), attrs: { title: 'Run ' + (e.run + 1) + ', ' + fmtStamp(e.t) + ' in' } }),
        h('span', { class: 'log-cat log-cat-' + e.cat, text: LOG_CAT_NAMES[e.cat], attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'log-text', text: e.text + (e.n > 1 ? ' ×' + e.n : '') }));
      listEl.appendChild(li);
    }
  }

  const handle = modals.open({
    title: 'Event log', className: 'modal-log', tag: LOG_TAG,
    body: [chips, empty, listEl, note],
    actions: [{ label: 'Close', kind: 'primary', id: 'close' }],
    onClose: () => { off(); },
  });
  const off = log.onChange(() => render());
  handle.setView = (c, hl) => {
    filter = LOG_CATS.includes(c) ? c : 'all';
    mark = hl || 0;
    render();
  };
  render();
  return handle;
}
