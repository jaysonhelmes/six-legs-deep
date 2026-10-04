// Field Guide further reading (ARCHITECTURE §18 C148): every entry carries 1–2 https links on allowed reference domains,
// and the Field Guide panel renders them ("Learn more:", new tab, noopener) only for discovered entries.
// Uses the shared fake DOM in tests/fakedom.js. Owner: WP9.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState } from './helpers.js';
import { FG_ORDER, FIELD_GUIDE } from '../src/data/fieldGuide.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const guide = await import('../src/ui/panels/guide.js');

after(() => {
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

// Every host used must be listed here (reputable reference sites only; extend deliberately).
const ALLOWED_HOSTS = [
  'en.wikipedia.org', // Wikipedia
  'www.antwiki.org', // AntWiki
  'pmc.ncbi.nlm.nih.gov', // PubMed Central (open-access journal articles)
  'biocontrol.entomology.cornell.edu', // Cornell University
];
const allowed = (host) => ALLOWED_HOSTS.includes(host) || /\.edu$/.test(host);

test('data (C148): every entry has 1–2 sources with titles and https URLs on allowed domains', () => {
  for (const id of FG_ORDER) {
    const src = FIELD_GUIDE[id].sources;
    assert.ok(Array.isArray(src), id + ' has a sources array');
    assert.ok(src.length >= 1 && src.length <= 2, id + ' has ' + src.length + ' sources');
    const urls = new Set();
    for (const s of src) {
      assert.equal(typeof s.title, 'string', id);
      assert.ok(s.title.trim().length > 0, id + ' source has a title');
      const u = new URL(s.url);
      assert.equal(u.protocol, 'https:', id + ' ' + s.url);
      assert.ok(allowed(u.hostname), id + ': host not allowed: ' + u.hostname);
      assert.ok(!urls.has(s.url), id + ' repeats a source');
      urls.add(s.url);
    }
    assert.ok(Object.isFrozen(src), id + ' sources are frozen');
  }
});

/** Mount the panel with the given discovered ids. */
function mount(foundIds) {
  const s = newState(3);
  s.meta.fieldGuide = {};
  for (const id of foundIds) s.meta.fieldGuide[id] = 0;
  s.meta.simTime = 1000;
  const host = doc.createElement('div');
  const p = guide.createPanel(host);
  p.update(s);
  return { s, host, p };
}

const rowOf = (host, id) => host.querySelectorAll('.fg-entry').find((r) => r.dataset.id === id) || null;

test('panel (C148): links render only for discovered entries, open in a new tab, shown with the note', () => {
  const found = ['fg_founding_queen', 'fg_black_garden_ant'];
  const { host } = mount(found);
  for (const id of FG_ORDER) {
    const row = rowOf(host, id);
    assert.ok(row, id + ' row exists');
    const links = row.querySelectorAll('a');
    if (found.includes(id)) {
      assert.equal(links.length, FIELD_GUIDE[id].sources.length, id + ' link count');
      links.forEach((a, i) => {
        assert.equal(a.getAttribute('href'), FIELD_GUIDE[id].sources[i].url);
        assert.equal(a.getAttribute('target'), '_blank');
        assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
        assert.equal(a.textContent, FIELD_GUIDE[id].sources[i].title);
      });
      assert.ok(row.querySelector('.fg-sources').textContent.startsWith('Learn more:'));
    } else {
      assert.equal(links.length, 0, id + ' is locked: no links');
      assert.equal(row.querySelector('.fg-sources'), null);
    }
  }
  // Collapsed: hidden with the note; expanded: shown under the note.
  const row = rowOf(host, 'fg_founding_queen');
  const more = row.querySelector('.fg-more');
  assert.equal(more.hidden, true);
  row.querySelector('.fg-head').click();
  assert.equal(row.querySelector('.fg-note').hidden, false);
  assert.equal(more.hidden, false);
  // Clicking a locked entry never reveals links.
  const locked = rowOf(host, 'fg_amber');
  locked.querySelector('.fg-head').click();
  assert.equal(locked.querySelector('.fg-more').hidden, true);
  assert.equal(locked.querySelectorAll('a').length, 0);
});

test('panel (C148): links appear when an entry is discovered and go away if it is locked again', () => {
  const { s, host, p } = mount([]);
  assert.equal(host.querySelectorAll('a').length, 0);
  s.meta.fieldGuide.fg_trail_pheromone = 900;
  p.update(s);
  assert.equal(rowOf(host, 'fg_trail_pheromone').querySelectorAll('a').length, FIELD_GUIDE.fg_trail_pheromone.sources.length);
  p.update(s);
  assert.equal(rowOf(host, 'fg_trail_pheromone').querySelectorAll('a').length, FIELD_GUIDE.fg_trail_pheromone.sources.length, 'not duplicated');
  s.meta.fieldGuide = {};
  p.update(s);
  assert.equal(host.querySelectorAll('a').length, 0);
});

test('sourceLinks (C148): skips non-https URLs and returns null when nothing is left', () => {
  assert.equal(guide.sourceLinks([]), null);
  assert.equal(guide.sourceLinks([{ title: 'x', url: 'javascript:alert(1)' }]), null);
  const row = guide.sourceLinks([{ title: 'A', url: 'https://en.wikipedia.org/wiki/Ant' }, { title: 'B', url: 'http://example.com' }]);
  assert.equal(row.querySelectorAll('a').length, 1);
});
