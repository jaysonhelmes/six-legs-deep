// Feedback pass 7, explanations and search (ARCHITECTURE §18 C207–C211): raid vs assault in the war-party form, the
// Map tab's trail / territory help and colour legend, "Scent Library" everywhere the chamber is named, research
// search across branches, Manual search ranking with highlighted terms, Flight Day / honeydew cap / Barracks / loot
// copy checked against the data and systems. Uses the shared fake DOM (tests/fakedom.js). Owner: WP9.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FDocument, FEvent } from './fakedom.js';
import { newState, makeDerived, fakeEnv, makeFakeStorage } from './helpers.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const T = await import('../src/ui/text.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
const { createGame } = await import('../src/core/game.js');
const researchPanel = await import('../src/ui/panels/research.js');
const mapPanel = await import('../src/ui/panels/map.js');
const content = await import('../src/ui/manualContent.js');
const { createManualView } = await import('../src/ui/manual.js');
const { logEntryFor } = await import('../src/ui/eventLog.js');
const rivals = await import('../src/systems/rivals.js');
const { ACTIONS, REWARDS, RAIDS } = await import('../src/data/combat.js');
const { TERRITORY, TRAIL } = await import('../src/data/surface.js');
const { CAPS } = await import('../src/data/economy.js');
const { EVENTS } = await import('../src/data/events.js');
const { CHAMBERS, ADJACENCY } = await import('../src/data/chambers.js');
const { GEOM } = await import('../src/data/strata.js');
const { SURFACE } = await import('../src/render/palette.js');
const { SHORT_NAMES } = await import('../src/render/nestArt.js');
const { hexIndex } = await import('../src/core/hex.js');

before(() => { setRevealAll(false); setRevealProvider(null); });
after(() => {
  setRevealAll(false);
  setRevealProvider(null);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const SAVE_LATE = fs.readFileSync(new URL('../test-saves/3-ready-to-merge.txt', import.meta.url), 'utf8').trim();
const NO_STORE = { innerWidth: 1440, localStorage: null };

function makeGame(save = null) {
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  if (save) {
    const r = game.importString(save, 1000);
    assert.ok(r.ok, 'save imports: ' + r.error);
  }
  return game;
}

/** Every string value reachable from a module's exports (functions called with no arguments where safe). */
function strings(v, out = [], depth = 0) {
  if (depth > 4 || v === null || v === undefined) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (typeof v === 'object') for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

/** "library" naming the chamber without "Scent" in front (Blueprint Library is a Federation node, not the chamber). */
const BARE_LIBRARY = /(?<!Scent )(?<!Blueprint )\b[Ll]ibrar(y|ies)\b/;

// ------------------------------------------------------------------------------------------------ C207 Scent Library
test('C207: the library chamber is always "Scent Library" in player text (text tables, adjacency, short names, Manual)', () => {
  const texts = strings(Object.fromEntries(Object.entries(T).filter(([, v]) => typeof v !== 'function')));
  texts.push(T.chamberAboutText('scent_library'), ...Object.values(ADJACENCY).map((a) => a.text), ...Object.values(SHORT_NAMES));
  for (const t of texts) assert.ok(!BARE_LIBRARY.test(t), 'bare "library": ' + t);
  assert.equal(ADJACENCY.adj_library_royal.text, 'Scent Library ×1.10');
  assert.match(T.RES_TIPS.insight, /Scent Libraries/);
  setRevealAll(true);
  try {
    const game = makeGame(SAVE_LATE);
    const view = createManualView({ game, win: NO_STORE });
    let text = '';
    for (const id of view.state().sections) { view.showSection(id); text += '\n' + view.el.textContent; }
    assert.ok(text.includes('Scent Library'), 'the Manual names it');
    const bad = text.split('\n').filter((l) => BARE_LIBRARY.test(l));
    assert.deepEqual(bad, [], 'no bare "library" in the Manual');
    view.destroy();
  } finally {
    setRevealAll(false);
  }
});

// ------------------------------------------------------------------------------------------------ C207 war actions
test('C207: raid vs assault copy matches data/combat.js and shows under the war-party action buttons', () => {
  assert.match(T.WAR_KIND_EXPLAIN.raid, new RegExp(Math.round(ACTIONS.raid.engage * 100) + '% of the nest'));
  assert.match(T.WAR_KIND_EXPLAIN.raid, /no home bonus/);
  assert.match(T.WAR_KIND_EXPLAIN.raid, /not conquered/);
  assert.match(T.WAR_KIND_EXPLAIN.raid, new RegExp(REWARDS.raidFoodSec + ' s'));
  assert.match(T.WAR_KIND_EXPLAIN.assault, new RegExp('×' + ACTIONS.assault.home));
  assert.match(T.WAR_KIND_EXPLAIN.assault, /every defender/);
  assert.match(T.WAR_KIND_EXPLAIN.assault, /territory/);
  for (const k of ['raid', 'assault']) assert.ok(T.wordCount(T.WAR_TIPS[k]) <= 12);

  const s = newState(5);
  s.run.unlocked.panel_war = true;
  s.run.colony.adults.soldier = 20;
  const d = makeDerived();
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(3, 0) });
  r.sighted = true;
  const game = { s, d, actions: { do: () => ({ ok: true, reason: null }) } };
  const form = mapPanel.buildWarForm({ game, ui: uistate }, { kind: 'raid', target: { type: 'rival', uid: r.uid } });
  form.update(s, d);
  const noteEl = form.el.querySelector('.war-kind-note');
  assert.ok(noteEl && !noteEl.hidden, 'note shown');
  assert.equal(noteEl.textContent, T.WAR_KIND_EXPLAIN.raid);
  form.el.querySelectorAll('button').find((b) => b.dataset.kind === 'assault').click();
  assert.equal(noteEl.textContent, T.WAR_KIND_EXPLAIN.assault);
  form.destroy();
});

// ------------------------------------------------------------------------------------------------ C207 loot
test('C207: a won raid carries its loot on battleEnd; the toast and the event log name it', () => {
  const s = newState(3);
  s.run.colony.adults.soldier = 30;
  s.run.unlocked.panel_war = true;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  d.season.id = 'winter';
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(3, 0) });
  r.sighted = true;
  const env0 = fakeEnv();
  const cmd = { type: 'launchParty', kind: 'raid', target: { type: 'rival', uid: r.uid }, soldier: 30, supermajor: 0 };
  assert.equal(rivals.handlers.launchParty.validate(s, d, cmd), null);
  rivals.handlers.launchParty.apply(s, d, cmd, env0);
  const events = [];
  for (let i = 0; i < 700; i++) {
    const env = fakeEnv({ dt: 0.1 });
    rivals.tick(s, d, 0.1, env);
    s.run.time += 0.1;
    events.push(...env.events);
  }
  const end = events.find((e) => e.type === 'battleEnd');
  assert.ok(end && end.win, 'raid won');
  assert.ok(end.loot && end.loot.food > 0 && end.loot.chitin > 0, 'loot on the event: ' + JSON.stringify(end.loot));
  const toast = T.eventToast(end, s);
  assert.match(toast.text, /^Raid won\. Loot carried home: \+[\d.,KM]+ food, \+[\d.,KM]+ chitin\.$/);
  const log = logEntryFor(end, s);
  assert.match(log.text, /Loot carried home/);
  assert.match(log.text, /ants lost\)/, 'losses counted from the lost object');
  assert.equal(T.lootText(null), '');
  assert.equal(T.lootText({ food: 0, chitin: 0 }), '');
});

// ------------------------------------------------------------------------------------------------ C208 trails
test('C208: trail help, legend colours and the trail distance lines follow the formulas', () => {
  const lines = T.trailHelpLines({ dNav: 4, sMax: 100 });
  const all = lines.join('\n');
  assert.match(all, /Distance efficiency = 1 ÷ \(1 \+ \(length − 1\) ÷ navigation\)/);
  assert.match(all, /navigation is 4 /);
  assert.match(all, new RegExp('halves every ' + TRAIL.tHalf + ' s'));
  assert.match(all, /pin/);
  assert.match(all, /chitin priority/);
  assert.ok(!/soldier/.test(T.trailHelpLines({ soldiers: false }).join(' ')), 'no soldier line before soldiers');
  assert.ok(!/Tandem Running/.test(T.trailHelpLines({ research: false }).join(' ')), 'no research names before Research');
  for (const x of T.TRAIL_LEGEND) assert.equal(x.color.toLowerCase(), String(SURFACE[x.swatch]).toLowerCase(), x.id + ' colour = palette');
  const dl = T.trailDistanceLines({ len: 6, S: 64, job: 'forager' }, { dEff: 6.8, rich: 2.75, eff: 0.37 });
  assert.equal(dl[0], '6 hexes (+0.8 haul to storage): richness ×2.75, distance efficiency ×0.37.');
  assert.match(dl[1], /yield ×1\.64/);
  assert.deepEqual(T.trailDistanceLines({ job: 'lycaenid' }, {}), []);
});

// ------------------------------------------------------------------------------------------------ C209 territory
test('C209: territory benefits come from the data and leave out unrevealed systems', () => {
  const lines = T.territoryBenefitLines();
  assert.equal(lines.length, 5);
  assert.match(lines[0], new RegExp('\\+' + TERRITORY.yieldPerHex * 100 + '% forager output per owned hex \\(up to \\+' + TERRITORY.yieldMax * 100 + '% at 200 hexes\\)'));
  assert.match(lines[1], new RegExp('×' + TERRITORY.ownedSource));
  assert.match(lines[4], new RegExp(RAIDS.borderMult + '×'));
  assert.equal(T.territoryBenefitLines({ raids: false, flight: false, rivals: false }).length, 2);
});

// ------------------------------------------------------------------------------------------------ C210 / C211 copy
test('C210/C211: Flight Day, honeydew cap, Barracks, Digging Claws, Tandem Running and frost copy match the code', () => {
  const ev = EVENTS.ev_flight_day;
  assert.deepEqual(ev.seasons, ['summer']);
  const fd = T.flightDayText();
  assert.match(fd, /summer/);
  assert.match(fd, new RegExp('×' + ev.num.w));
  assert.match(fd, new RegExp(ev.num.sec / 60 + ' minutes'));
  assert.match(fd, /Nuptial Preparation/);
  const hc = T.honeydewCapText();
  assert.match(hc, new RegExp('Cap = ' + CAPS.honeydewBase + ' \\+ ' + CAPS.honeydewFrac * 100 + '% of your food cap'));
  assert.match(hc, /not kept in Granaries/);
  const about = T.chamberAboutText('barracks', { minEntPath: 7 });
  assert.match(about, new RegExp('Within ' + GEOM.barracksPath + ' path cells of an entrance'));
  assert.match(about, /home AP: Army Power when it defends the nest/);
  assert.match(about, /Path to the nearest entrance: 7 cells — within 12, bonus active\./);
  assert.match(T.chamberAboutText('barracks', { minEntPath: 20 }), /over 12, no entrance bonus/);
  assert.match(T.chamberAboutText('barracks', { minEntPath: -1 }), /No tunnel links it/);
  assert.match(T.chamberAboutText('gallery', { exposed: true }, { season: { frostRow: 9 } }), /more than half of its rows lie above the frost line \(row 9 now\)/);
  assert.equal(CHAMBERS.barracks.fx.homeAP, 1.1);
  assert.match(T.ADAPT_TIPS.digging_claws, /soil/);
  assert.match(T.RESEARCH_TIPS.tandem_running, /Long Legs \(Adaptations tab\): trails lose less to distance/);
  assert.match(T.RESEARCH_TIPS.thermal_brood_shuttling, /frost-safe nurseries first/);
  assert.match(T.BONUS_STACK_TIP, /add together/);
});

// ------------------------------------------------------------------------------------------------ C209 research search
test('C209: research search matches names and effects across branches, best name matches first', () => {
  assert.deepEqual(researchPanel.searchResearch(''), []);
  assert.deepEqual(researchPanel.searchResearch('long legs'), ['tandem_running']);
  assert.equal(researchPanel.searchResearch('trail')[0], 'trail_memory');
  const frost = researchPanel.searchResearch('frost');
  assert.ok(frost.includes('thermoregulation') && frost.includes('thermal_brood_shuttling'));
  assert.deepEqual(researchPanel.searchResearch('zzqx'), []);
  assert.equal(researchPanel.wordScore('scent library', 'library'), 3);
  assert.equal(researchPanel.wordScore('trails', 'trail'), 2);
  assert.equal(researchPanel.wordScore('ontrail', 'trail'), 1);

  globalThis.window.localStorage = makeFakeStorage();
  const s = newState(9);
  const d = makeDerived();
  const host = doc.createElement('div');
  const p = researchPanel.createPanel(host, { game: { s, d, actions: { do: () => ({ ok: true }) } }, ui: uistate, bridge: { reject() {}, select() {}, openTab() {} } });
  p.update(s, d);
  const box = host.querySelector('.research-search');
  assert.ok(box, 'search box');
  box.value = 'frost';
  box.dispatchEvent(new FEvent('input'));
  p.update(s, d);
  const ids = host.querySelectorAll('.tech-node').map((n) => n.dataset.id).filter(Boolean);
  assert.deepEqual(ids, frost, 'results from every branch, in rank order');
  const tag = host.querySelector('.tech-node[data-id="thermoregulation"] .tech-branch-tag');
  assert.ok(tag && !tag.hidden && tag.textContent.length > 0, 'branch tag on results');
  box.value = '';
  box.dispatchEvent(new FEvent('input'));
  p.update(s, d);
  assert.ok(host.querySelectorAll('.tech-node').length > ids.length, 'branch view back');
  p.destroy();
});

// ------------------------------------------------------------------------------------------------ C210 Manual ranking
test('C210: Manual search ranks title > heading > body and whole words first, and highlights the terms', () => {
  setRevealAll(true);
  try {
    const game = makeGame(SAVE_LATE);
    const s = game.s;
    const d = game.d;
    const entries = content.visibleEntryIds(s, d).map((id) => content.buildEntry(s, d, id)).filter(Boolean);
    const top = (qv) => content.rankEntries(entries, s, d, qv).map((x) => x.entry.id);
    assert.equal(top('granary')[0], 'chamber:granary');
    assert.equal(top('trails')[0], 'surface:trails');
    assert.equal(top('frost')[0], 'nest:frost');
    assert.equal(top('scent library')[0], 'chamber:scent_library');
    assert.equal(top('territory')[0], 'surface:territory');
    assert.equal(top('bonuses stack')[0], 'start:bonuses');
    assert.deepEqual(top('zzqx nothing'), []);
    // weights: a title hit outranks a body-only hit; whole word outranks a prefix
    const e1 = { id: 'x:a', title: 'Granary', blocks: [] };
    const e2 = { id: 'x:b', title: 'Other', blocks: [{ p: 'A granary.' }] };
    const e3 = { id: 'x:c', title: 'Granaryish', blocks: [] };
    assert.ok(content.scoreEntry(e1, s, d, 'granary') > content.scoreEntry(e3, s, d, 'granary'));
    assert.ok(content.scoreEntry(e3, s, d, 'granary') > content.scoreEntry(e2, s, d, 'granary'));
    assert.equal(content.scoreEntry(e2, s, d, 'granary food'), 0, 'every word must match');
    assert.ok(content.scoreEntry(e1, s, d, 'granary', { active: true }) > content.scoreEntry(e1, s, d, 'granary'));
    assert.deepEqual(content.highlightParts('Trails and trail', ['trail']).filter((x) => x.hit).map((x) => x.t), ['Trail', 'trail']);

    const view = createManualView({ game, win: NO_STORE });
    view.setQuery('granary');
    const arts = view.el.querySelectorAll('.manual-entry');
    assert.equal(arts[0].dataset.entry, 'chamber:granary', 'best match first');
    assert.ok(view.el.querySelectorAll('mark').length > 0, 'terms highlighted');
    assert.ok(arts[0].querySelector('.manual-hit-sec'), 'section label on each result');
    view.setQuery('');
    assert.equal(view.el.querySelectorAll('mark').length, 0, 'no marks outside search');
    view.destroy();
  } finally {
    setRevealAll(false);
  }
});

// ------------------------------------------------------------------------------------------------ C208 Map help
test('C208/C209: the Map tab shows trail help with the legend and the territory benefits', () => {
  setRevealAll(true);
  try {
    const game = makeGame(SAVE_LATE);
    const host = doc.createElement('div');
    const p = mapPanel.createPanel(host, { game, ui: uistate, bridge: { reject() {}, select() {}, openTab() {}, toast() {} } });
    uistate.resetUI();
    p.update(game.s, game.d);
    const help = host.querySelector('.trail-help');
    assert.ok(help, 'trail help box');
    assert.match(help.textContent, /Distance efficiency/);
    assert.equal(help.querySelectorAll('.legend-item').length, T.TRAIL_LEGEND.length);
    const terr = host.querySelector('.terr-help');
    assert.ok(terr && /forager output per owned hex/.test(terr.textContent));
    p.destroy();
  } finally {
    setRevealAll(false);
  }
});
