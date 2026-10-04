// The in-game Manual (C131): a large modal (full screen on phones) with a section index, a search box and entries
// built by src/ui/manualContent.js from the live data tables, showing only what the player has unlocked or seen.
// Live numbers update in place at the shell's 4 Hz refresh (modal spec.update → setText on registered spans); the
// DOM is rebuilt only when the content signature changes (a reveal, a new sighting, a purchase that changes structure)
// or the search / section changes. Entry points: the book button in the tab row and the H / ? keys (ui/app.js).
// Owner: WP9. Contract: ARCHITECTURE §14.6 (Manual), §18 C131; DESIGN §25.3. Top level is DOM-free (Node imports it).

import { h, clear, setText, toggleClass } from './dom.js';
import {
  SECTIONS, MORE_NOTE, manualIndex, manualSignature, buildEntry, textOf, entryText, matchesQuery,
} from './manualContent.js';

/** localStorage key of the last section viewed (a per-browser convenience; every access in try/catch). */
export const MANUAL_SECTION_KEY = 'sld.ui.manualSection';

/** Modal tag of the Manual. */
export const MANUAL_TAG = 'manual';

function loadSection(win) {
  try {
    const v = win && win.localStorage ? win.localStorage.getItem(MANUAL_SECTION_KEY) : null;
    return SECTIONS.some((x) => x.id === v) ? v : null;
  } catch {
    return null;
  }
}

function saveSection(win, id) {
  try { if (win && win.localStorage) win.localStorage.setItem(MANUAL_SECTION_KEY, id); } catch { /* storage blocked: this session only */ }
}

/**
 * The Manual view (index + search + content), independent of the modal so tests can mount it directly.
 * @param {{ game: Object, openTab?: (tab: string, sub?: string|null) => void, tabShown?: (tab: string) => boolean,
 *   close?: () => void, win?: Object, section?: string|null }} ctx
 * @returns {{ el: HTMLElement, search: HTMLInputElement, update(s: Object, d: Object, force?: boolean): void, showSection(id: string): void,
 *   showEntry(id: string): void, setQuery(q: string): void, state(): Object, destroy(): void }}
 */
export function createManualView(ctx) {
  const { game } = ctx;
  const win = ctx.win || (globalThis.window || null);
  let section = ctx.section || loadSection(win) || 'start';
  let query = '';
  let sig = null;
  let index = [];
  let visible = new Set();
  /** @type {Map<string, Object>} entries built for the current signature */
  let cache = new Map();
  /** @type {Array<{ el: HTMLElement, t: Object }>} live spans in the rendered content */
  let lives = [];
  let pendingEntry = null;

  const search = h('input', {
    type: 'search', class: 'input manual-search', placeholder: 'Search the Manual', autocomplete: 'off', spellcheck: false,
    attrs: { 'aria-label': 'Search the Manual' },
  });
  if (!win || !(win.innerWidth < 768)) search.setAttribute('data-autofocus', '');
  const nav = h('nav', { class: 'manual-index', attrs: { 'aria-label': 'Manual sections' } });
  const side = h('aside', { class: 'manual-side' }, search, nav);
  const main = h('div', { class: 'manual-main', attrs: { tabindex: '-1' } });
  const el = h('div', { class: 'manual' }, side, main);

  const s0 = () => game.s;
  const d0 = () => game.d;

  function entry(id) {
    if (!cache.has(id)) cache.set(id, buildEntry(s0(), d0(), id));
    return cache.get(id);
  }

  /** A Text node (live values become registered spans). */
  function textNode(t) {
    if (t && typeof t === 'object' && typeof t.live === 'function') {
      const span = h('span', { class: 'manual-live' });
      setText(span, textOf(t, s0(), d0()));
      lives.push({ el: span, t });
      return span;
    }
    return textOf(t, s0(), d0());
  }

  function kvList(rows, keys = false) {
    const dl = h('dl', { class: 'kv manual-kv' + (keys ? ' kv-keys' : '') });
    for (const row of rows) {
      if (!row) continue;
      const [k, v] = row;
      dl.append(h('dt', null, keys ? h('kbd', { class: 'kbd', text: k }) : k), h('dd', null, textNode(v)));
    }
    return dl;
  }

  function block(b) {
    if (!b) return null;
    if (b.p !== undefined) return b.p === '' ? null : h('p', { class: 'manual-p' }, textNode(b.p));
    if (b.note !== undefined) return h('p', { class: 'note manual-note', text: b.note });
    if (b.h !== undefined) return h('h4', { class: 'manual-h', text: b.h });
    if (b.list) return b.list.length ? h('ul', { class: 'manual-list' }, b.list.map((t) => h('li', null, textNode(t)))) : null;
    if (b.kv) return kvList(b.kv, !!b.keys);
    if (b.table) {
      const head = h('thead', null, h('tr', null, b.table.head.map((c) => h('th', { attrs: { scope: 'col' }, text: c }))));
      const cell = (c, i) => (i === 0 ? h('th', { attrs: { scope: 'row' } }, textNode(c)) : h('td', null, textNode(c)));
      const body = h('tbody', null, b.table.rows.map((r) => h('tr', null, r.map(cell))));
      return h('div', { class: 'manual-table-wrap' }, h('table', { class: 'manual-table' }, head, body));
    }
    if (b.box) return h('section', { class: 'manual-box' }, h('h4', { class: 'manual-box-title', text: b.box.title }), kvList(b.box.kv));
    return null;
  }

  function article(e) {
    const links = (e.links || []).filter((l) => l && visible.has(l.entry) && l.entry !== e.id);
    const tabs = (e.tabs || []).filter((t) => t && (typeof ctx.tabShown !== 'function' || ctx.tabShown(t.tab)));
    return h('article', { class: 'manual-entry', dataset: { entry: e.id } },
      h('h3', { class: 'manual-entry-title', text: e.title }),
      (e.blocks || []).map(block),
      links.length || tabs.length ? h('div', { class: 'manual-links' },
        links.length ? h('span', { class: 'manual-see', text: 'See also:' }) : null,
        links.map((l) => h('button', { type: 'button', class: 'manual-link', dataset: { goto: l.entry }, text: l.label })),
        tabs.map((t) => h('button', { type: 'button', class: 'btn btn-small manual-tab', dataset: { tab: t.tab, sub: t.sub || '' }, text: t.label }))) : null);
  }

  function renderIndex() {
    clear(nav);
    for (const sec of index) {
      const b = h('button', { type: 'button', class: 'manual-sec', dataset: { section: sec.id }, text: sec.title });
      nav.appendChild(b);
    }
    syncIndex();
  }

  function syncIndex() {
    for (const b of nav.children) {
      const on = !query && b.dataset.section === section;
      toggleClass(b, 'active', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  }

  function renderContent() {
    const keepScroll = main.scrollTop || 0;
    clear(main);
    lives = [];
    if (query) {
      let n = 0;
      for (const sec of index) {
        const hits = sec.entries.map(entry).filter((e) => e && matchesQuery(entryText(e, s0(), d0()), query));
        if (!hits.length) continue;
        n += hits.length;
        main.appendChild(h('h2', { class: 'manual-sec-title', text: sec.title }));
        for (const e of hits) main.appendChild(article(e));
      }
      if (!n) main.appendChild(h('p', { class: 'note manual-empty', text: 'Nothing in the Manual matches “' + query + '” yet.' }));
    } else {
      const sec = index.find((x) => x.id === section) || index[0];
      if (sec) {
        section = sec.id;
        main.appendChild(h('h2', { class: 'manual-sec-title', text: sec.title }));
        for (const id of sec.entries) {
          const e = entry(id);
          if (e) main.appendChild(article(e));
        }
        if (sec.more) main.appendChild(h('p', { class: 'note manual-more', text: MORE_NOTE }));
      }
    }
    syncIndex();
    if (pendingEntry) {
      const target = main.querySelector('[data-entry="' + pendingEntry + '"]');
      pendingEntry = null;
      if (target) {
        target.classList.add('flash');
        if (typeof target.scrollIntoView === 'function') { try { target.scrollIntoView({ block: 'start' }); } catch { /* best effort */ } }
      }
    } else {
      main.scrollTop = keepScroll;
    }
  }

  function update(s = s0(), d = d0(), force = false) {
    if (!s || !s.run) return;
    const next = manualSignature(s, d);
    if (force || next !== sig) {
      sig = next;
      cache = new Map();
      index = manualIndex(s, d);
      visible = new Set(index.flatMap((x) => x.entries));
      renderIndex();
      renderContent();
      return;
    }
    for (const L of lives) setText(L.el, textOf(L.t, s, d));
  }

  function showSection(id) {
    if (!index.some((x) => x.id === id)) return;
    section = id;
    saveSection(win, id);
    if (query) { query = ''; search.value = ''; }
    main.scrollTop = 0;
    renderContent();
  }

  function showEntry(id) {
    const sec = index.find((x) => x.entries.includes(id));
    if (!sec) return;
    pendingEntry = id;
    section = sec.id;
    saveSection(win, sec.id);
    if (query) { query = ''; search.value = ''; }
    renderContent();
  }

  function setQuery(text) {
    const qv = String(text || '').trim();
    if (qv === query) return;
    query = qv;
    if (search.value !== text && typeof text === 'string') search.value = text;
    main.scrollTop = 0;
    renderContent();
  }

  const onClick = (ev) => {
    const t = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('button') : null;
    if (!t || !el.contains(t)) return;
    if (t.dataset.section) showSection(t.dataset.section);
    else if (t.dataset.goto) showEntry(t.dataset.goto);
    else if (t.dataset.tab) {
      const tab = t.dataset.tab;
      const sub = t.dataset.sub || null;
      if (typeof ctx.close === 'function') ctx.close();
      if (typeof ctx.openTab === 'function') ctx.openTab(tab, sub);
    }
  };
  const onInput = () => setQuery(search.value);
  el.addEventListener('click', onClick);
  search.addEventListener('input', onInput);

  update(s0(), d0(), true);

  return {
    el, search, update, showSection, showEntry, setQuery,
    /** Current view state (tests). */
    state: () => ({ section, query, sig, sections: index.map((x) => x.id), lives: lives.length }),
    destroy() {
      el.removeEventListener('click', onClick);
      search.removeEventListener('input', onInput);
      lives = [];
      cache = new Map();
    },
  };
}

/**
 * Open the Manual in a modal (or return the one already open).
 * @param {{ game: Object, modals: Object, openTab?: Function, tabShown?: Function }} ctx
 * @param {{ section?: string, entry?: string }} [opts]
 * @returns {Object} modal handle (handle.view = the Manual view)
 */
export function openManual(ctx, opts = {}) {
  const { modals } = ctx;
  const open = modals.find(MANUAL_TAG);
  if (open) {
    if (opts.entry && open.view) open.view.showEntry(opts.entry);
    else if (opts.section && open.view) open.view.showSection(opts.section);
    return open;
  }
  let handle = null;
  const view = createManualView({ ...ctx, section: opts.section || null, close: () => { if (handle) modals.close(handle); } });
  handle = modals.open({
    title: 'Manual', className: 'modal-wide modal-manual', tag: MANUAL_TAG, body: [view.el], actions: [],
    update: (s, d) => view.update(s, d),
    onClose: () => view.destroy(),
  });
  handle.view = view;
  if (opts.entry) view.showEntry(opts.entry);
  return handle;
}

/**
 * Open the Manual, or close it when it is the open (top) dialog. Another modal on top: nothing happens.
 * @param {Object} ctx as openManual
 * @returns {boolean} true when the Manual is open afterwards
 */
export function toggleManual(ctx) {
  const { modals } = ctx;
  const open = modals.find(MANUAL_TAG);
  if (open) {
    if (modals.top() === open) { modals.close(open); return false; }
    return true;
  }
  if (modals.isOpen()) return false;
  openManual(ctx);
  return true;
}
