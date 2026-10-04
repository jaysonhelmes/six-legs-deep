// Field Guide panel: entries grouped by category, each with its 40–60 word biology note and "Learn more:" links (C148) once discovered.
// Owner: WP9. Contract: ARCHITECTURE §14.5 (Field Guide row: data only), §6.6; DESIGN §20.

import { h, setText, show, toggleClass, syncList, clear } from '../dom.js';
import { fmtCount } from '../format.js';
import { humanize } from '../text.js';
import { num, obj } from '../reveal.js';
import { FG_ORDER, FIELD_GUIDE } from '../../data/fieldGuide.js';
import { note } from './common.js';

const NEW_SEC = 120; // entries unlocked within this many sim seconds show a "new" badge

/**
 * Field Guide categories in first-appearance order.
 * @returns {string[]}
 */
/**
 * "Learn more:" row for an entry's further-reading links (C148); null when it has none.
 * @param {{ title: string, url: string }[]} sources
 * @returns {HTMLElement|null}
 */
export function sourceLinks(sources) {
  const list = (Array.isArray(sources) ? sources : []).filter((x) => x && typeof x.url === 'string' && /^https:\/\//.test(x.url));
  if (!list.length) return null;
  const row = h('p', { class: 'fg-sources' }, h('span', { class: 'fg-sources-label', text: 'Learn more:' }));
  list.forEach((x, i) => {
    if (i) row.appendChild(h('span', { class: 'fg-sources-sep', text: '·' }));
    row.appendChild(h('a', { class: 'fg-source', href: x.url, target: '_blank', rel: 'noopener noreferrer', text: x.title || x.url }));
  });
  return row;
}

export function guideCategories() {
  const out = [];
  for (const id of FG_ORDER) {
    const c = (FIELD_GUIDE[id] && FIELD_GUIDE[id].cat) || 'notes';
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Field Guide panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createPanel(root) {
  const el = h('div', { class: 'panel panel-guide' });
  root.appendChild(el);
  const countEl = h('span', { class: 'big-num' });
  const body = h('div', { class: 'guide-body' });
  const empty = note('The Field Guide fills in as your colony meets the world.');
  el.append(h('div', { class: 'row-between balance' }, h('span', null, countEl, ' entries discovered')), body, empty);
  const open = new Set();

  function createCat(cat) {
    const list = h('div', { class: 'list' });
    const sec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: humanize(cat) }), list);
    sec.__list = list;
    return sec;
  }

  function createEntry(id) {
    const title = h('span', { class: 'fg-title' });
    const badge = h('span', { class: 'badge badge-new', text: 'New' });
    const text = h('p', { class: 'fg-note' });
    const more = h('div', { class: 'fg-more', hidden: true });
    const head = h('button', { type: 'button', class: 'fg-head', attrs: { 'aria-expanded': 'false' } }, title, badge);
    const row = h('div', { class: 'fg-entry', dataset: { id } }, head, text, more);
    head.addEventListener('click', () => {
      if (row.classList.contains('locked')) return;
      if (open.has(id)) open.delete(id); else open.add(id);
      row.__sync();
    });
    row.__r = { title, badge, text, head, more, linked: false };
    return row;
  }

  function updateEntry(row, id, s) {
    const r = row.__r;
    const e = obj(FIELD_GUIDE[id]);
    const at = obj(s.meta.fieldGuide)[id];
    const found = at !== undefined;
    toggleClass(row, 'locked', !found);
    setText(r.title, found ? e.title || humanize(id) : 'Undiscovered entry');
    show(r.badge, found && num(s.meta.simTime) - num(at) < NEW_SEC);
    // Links exist in the DOM only for discovered entries (built once; removed if the entry is locked again, e.g. a reset).
    if (found && !r.linked) {
      const links = sourceLinks(e.sources);
      if (links) r.more.appendChild(links);
      r.linked = true;
    } else if (!found && r.linked) {
      clear(r.more);
      r.linked = false;
    }
    row.__sync = () => {
      const isOpen = found && open.has(id);
      show(r.text, isOpen);
      setText(r.text, isOpen ? e.note || '' : '');
      show(r.more, isOpen && r.more.firstChild !== null);
      r.head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };
    row.__sync();
  }

  return {
    update(s) {
      if (!s || !s.meta) return;
      const found = FG_ORDER.filter((id) => obj(s.meta.fieldGuide)[id] !== undefined).length;
      setText(countEl, fmtCount(found) + ' / ' + fmtCount(FG_ORDER.length));
      show(empty, FG_ORDER.length === 0);
      const cats = guideCategories();
      syncList(body, cats, (c) => c, createCat, (sec, c) => {
        const ids = FG_ORDER.filter((id) => ((FIELD_GUIDE[id] && FIELD_GUIDE[id].cat) || 'notes') === c);
        syncList(sec.__list, ids, (id) => id, createEntry, (row, id) => updateEntry(row, id, s));
      });
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
