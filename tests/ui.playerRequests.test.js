// Player-request UI changes (ARCHITECTURE §18 C114–C116): the Army Ant Column card's live odds line
// (events.armyColumnPreview), "Draw trail from nearest entrance" on Lycaenid caterpillars and fallen fruit (context
// menu, trails accept both), Alate rearing in the Prestige tab's Flight view, and the Research "Hide completed" toggle.
// Uses the shared fake DOM in tests/fakedom.js. Owner: WP9.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState, makeDerived, fakeEnv, makeFakeStorage } from './helpers.js';
import * as events from '../src/systems/events.js';
import * as surface from '../src/systems/surface.js';
import * as trails from '../src/systems/trails.js';
import * as combat from '../src/systems/combat.js';
import { BOSSES } from '../src/data/rivals.js';
import { hexIndex } from '../src/core/hex.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const { createEventCard, armyColumnText, oddsText } = await import('../src/ui/eventCard.js');
const { mountUI } = await import('../src/ui/app.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
const { createGame } = await import('../src/core/game.js');
const researchPanel = await import('../src/ui/panels/research.js');
const prestigePanel = await import('../src/ui/panels/prestige.js');
const colonyPanel = await import('../src/ui/panels/colony.js');
const { RESEARCH_ORDER, RESEARCH } = await import('../src/data/research.js');

before(() => { setRevealAll(true); });
after(() => {
  setRevealAll(false);
  setRevealProvider(null);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const button = (el, text) => el.querySelectorAll('button').find((b) => b.textContent.trim().startsWith(text)) || null;
const panelCtx = (s, d, calls = []) => ({
  game: { s, d, actions: { do: (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; } } },
  ui: uistate, bridge: { reject() {}, select() {}, openTab() {} },
});

// ------------------------------------------------------------------------------------------------ C114 army column
test('army column preview (C114): column AP from BOSSES, garrison AP and odds match combat.preview; RNG untouched', () => {
  const s = newState(4);
  const d = makeDerived({ stats: { ap: 1 } });
  d.combat.garrison = { soldier: 0, supermajor: 0 };
  const b = BOSSES.army_ant_column;
  let pv = events.armyColumnPreview(s, d);
  assert.ok(Math.abs(pv.foeAP - b.apBase) < 1e-6, 'run with no supercolonies: AP = apBase');
  assert.ok(Math.abs(pv.foe.n - b.apBase / Math.sqrt(b.atk * b.hp)) < 1e-6);
  assert.equal(pv.canFight, false);
  assert.equal(pv.win, 0);
  s.meta.counters.supercolonies = 1;
  assert.ok(Math.abs(events.armyColumnPreview(s, d).foeAP - b.apBase * Math.pow(2, b.apExp)) < 1e-6, 'scales with supercolonies');
  s.meta.counters.supercolonies = 0;
  const rng = JSON.stringify(s.rng);
  d.combat.garrison = { soldier: 120, supermajor: 3 };
  pv = events.armyColumnPreview(s, d);
  const you = { militia: 0, soldier: 120, supermajor: 3 };
  assert.equal(pv.soldier, 120);
  assert.equal(pv.supermajor, 3);
  assert.ok(Math.abs(pv.yourAP - combat.armyAP(s, d, you, { homeMult: 1 })) < 1e-9);
  const ref = combat.preview(s, d, you, pv.foe, { homeMult: 1, retreatAt: 1 });
  assert.equal(pv.win, ref.win);
  assert.equal(JSON.stringify(s.rng), rng, 'the preview never draws from s.rng');
  d.combat.garrison = { soldier: 1e6, supermajor: 1e4 };
  assert.ok(events.armyColumnPreview(s, d).win > pv.win, 'more defenders, better odds');
});

test('army column (C114): Fight starts the battle against exactly the previewed column', () => {
  const s = newState(5);
  const d = makeDerived({ stats: { foodCap: 1e12, ap: 1 }, rates: { food: { gross: 10 }, chitin: { gross: 1 } } });
  surface.derive(s, d);
  events.forceEvent(s, d, 'ev_army_ant_column', fakeEnv());
  const card = s.run.events.card;
  assert.equal(card.id, 'ev_army_ant_column');
  d.combat.garrison = { soldier: 50, supermajor: 2 };
  const pv = events.armyColumnPreview(s, d);
  events.handlers.eventChoice.apply(s, d, { type: 'eventChoice', uid: card.uid, choice: 'fight' }, fakeEnv());
  const battle = s.run.war.battles.at(-1);
  assert.ok(battle, 'a battle started');
  assert.ok(Math.abs(battle.foe.n - pv.foe.n) < 1e-6);
  assert.equal(battle.you.soldier, 50);
  assert.equal(battle.you.supermajor, 2);
});

test('army column text (C114): column, defenders, AP and estimated victory; none at home says so', () => {
  const line = armyColumnText({ foe: { n: 4300 }, foeAP: 43000, soldier: 120, supermajor: 3, yourAP: 18234, win: 0.234, lossesLo: 40, lossesHi: 110 });
  assert.match(line, /^Column: ~4\.30K army ants \(AP 43\.0K\)/);
  assert.match(line, /Your defenders: 120 soldiers, 3 supermajors \(AP 18\.2K\)/);
  assert.match(line, /Est\. victory 23%/);
  assert.match(line, /losses ~40–110/);
  assert.match(armyColumnText({ foe: { n: 4300 }, foeAP: 43000, soldier: 1, supermajor: 0, yourAP: 5, win: 0 }), /1 soldier \(AP/);
  assert.match(armyColumnText({ foe: { n: 4300 }, foeAP: 43000, soldier: 0, supermajor: 0, yourAP: 0, win: 0 }), /none at home/);
  assert.equal(armyColumnText(null), '');
  assert.equal(oddsText(0.004), '<1%');
  assert.equal(oddsText(0.996), '>99%');
  assert.equal(oddsText(1), '100%');
  assert.equal(oddsText(NaN), '0%');
});

test('event card (C114): the army column card shows the live odds line and refreshes it; other cards do not', () => {
  const s = newState(6);
  const d = makeDerived({ stats: { ap: 1 } });
  d.combat.garrison = { soldier: 10, supermajor: 0 };
  const host = doc.createElement('div');
  const card = createEventCard(host, { game: { s, d, actions: { do: () => ({ ok: true }) } }, bridge: null });
  s.run.events.card = { uid: 3, id: 'ev_army_ant_column', t: 25, choices: ['evacuate', 'fight'], data: { hex: 0 } };
  card.update(s);
  const intel = host.querySelector('.ec-intel');
  assert.equal(intel.hidden, false);
  assert.match(intel.textContent, /Your defenders: 10 soldiers/);
  assert.match(intel.textContent, /Est\. victory/);
  d.combat.garrison = { soldier: 500, supermajor: 0 };
  card.update(s);
  assert.match(intel.textContent, /10 soldiers/, 'throttled within the same half second');
  s.run.time += 0.6;
  card.update(s);
  assert.match(intel.textContent, /500 soldiers/, 'kept current while the card is open');
  s.run.events.card = { uid: 4, id: 'ev_wandering_queen', t: 25, choices: ['adopt', 'devour'], data: {} };
  card.update(s);
  assert.equal(host.querySelector('.ec-intel').hidden, true);
  card.destroy();
});

// ------------------------------------------------------------------------------------------------ C115 trails
function addSource(s, type, hex, data = {}) {
  const S = s.run.surface;
  const src = { uid: S.nextUid++, type, hex, stock: 500, max: 500, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data };
  S.sources.push(src);
  S.revealed[hex] = 1;
  return src;
}

test('trails (C115): drawTrail from bestOrigin reaches a Lycaenid caterpillar (job lycaenid) and a fallen fruit', () => {
  const s = newState(7);
  const d = makeDerived();
  surface.derive(s, d);
  const lyc = addSource(s, 'lycaenid_caterpillar', hexIndex(2, 0));
  const fruit = addSource(s, 'fallen_fruit', hexIndex(-2, 1));
  surface.derive(s, d);
  for (const src of [lyc, fruit]) {
    const origin = trails.bestOrigin(s, d, src.hex);
    assert.ok(origin >= 0, src.type + ' has an origin');
    const cmd = { type: 'drawTrail', origin, target: src.hex, src: src.uid };
    assert.equal(trails.handlers.drawTrail.validate(s, d, cmd), null, src.type);
    trails.handlers.drawTrail.apply(s, d, cmd, fakeEnv());
  }
  const jobs = s.run.surface.trails.slice(-2).map((t) => t.job);   // after the starting crumb trail
  assert.deepEqual(jobs, ['lycaenid', 'forager']);
});

test('context menu (C115): Lycaenid caterpillar and fallen fruit (source or its event object) offer a trail', () => {
  setRevealAll(true);
  uistate.resetUI();
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  const ui = mountUI(root, game, { loadRender: false });
  ui.frame(1000);
  const calls = [];
  game.actions.do = (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; };
  const lyc = addSource(game.s, 'lycaenid_caterpillar', hexIndex(2, 0));
  const fruit = addSource(game.s, 'fallen_fruit', hexIndex(-2, 1));
  game.s.run.events.objects.push({ uid: 41, kind: 'fruit', hex: fruit.hex, cell: -1, t: -1, data: { occ: 1, src: fruit.uid } });
  const menuFor = (target) => {
    ui.bridge.contextMenu(target, 50, 50);
    return root.querySelector('.ctx-menu');
  };
  let menu = menuFor({ view: 'surface', kind: 'source', id: lyc.uid, hex: lyc.hex });
  assert.ok(menu, 'a menu opens on the caterpillar');
  assert.equal(button(menu, 'Hand-forage'), null, 'caterpillars are not hand-foraged');
  assert.equal(button(menu, 'Hunt'), null);
  button(menu, 'Draw trail from nearest entrance').click();
  assert.equal(calls.at(-1).type, 'drawTrail');
  assert.equal(calls.at(-1).args.target, lyc.hex);
  assert.equal(calls.at(-1).args.src, lyc.uid);
  menu = menuFor({ view: 'surface', kind: 'eventObject', id: 41, hex: fruit.hex });
  assert.ok(menu, 'the fruit object opens the source menu');
  assert.ok(button(menu, 'Hand-forage'));
  button(menu, 'Draw trail from nearest entrance').click();
  assert.deepEqual({ type: calls.at(-1).type, target: calls.at(-1).args.target, src: calls.at(-1).args.src },
    { type: 'drawTrail', target: fruit.hex, src: fruit.uid });
  menu = menuFor({ view: 'surface', kind: 'source', id: fruit.uid, hex: fruit.hex });
  assert.ok(button(menu, 'Draw trail from nearest entrance'));
  game.s.run.events.objects.push({ uid: 42, kind: 'ladybug', hex: 3, cell: -1, t: 5, data: {} });
  // C249: other event objects have no actions of their own, only the options of the hex they sit on
  const lm = menuFor({ view: 'surface', kind: 'eventObject', id: 42, hex: 3 });
  assert.ok(lm !== null && button(lm, 'Claim hex') !== null, 'hex options under an object');
  assert.equal(button(lm, 'Draw trail'), null, 'no source actions for a ladybug');
  ui.destroy();
  root.remove();
});

// ------------------------------------------------------------------------------------------------ C116 alates
test('alate rearing (C116): lives in Prestige → Flight with the same controls; gone from the Colony tab', () => {
  const s = newState(8);
  const d = makeDerived({ stats: { alateCells: 4 } });
  s.run.colony.alatesReared = 2;
  s.run.colony.adults.minor = 50;
  const calls = [];
  const ctx = panelCtx(s, d, calls);
  uistate.resetUI();
  setRevealAll(false);
  setRevealProvider((st, key) => key !== 'alate_rearing');
  const host = doc.createElement('div');
  const p = prestigePanel.createPanel(host, ctx);
  p.update(s, d);
  const sec = host.querySelector('.sec-alates');
  assert.ok(sec, 'section exists in the Flight view');
  assert.equal(sec.hidden, true, 'hidden until alate_rearing reveals');
  setRevealProvider(() => true);
  p.update(s, d);
  assert.equal(sec.hidden, false);
  assert.match(sec.textContent, /Reared \/ cells2 \/ 4/);
  button(sec, 'Rear 5').click();
  assert.deepEqual(calls.at(-1), { type: 'rearAlate', args: { n: 5 } });
  const box = sec.querySelector('input');
  box.checked = true;
  box.listeners.change[0]({ type: 'change' });
  assert.deepEqual(calls.at(-1), { type: 'setAutomation', args: { patch: { autoRear: true } } });
  p.destroy();
  const ch = doc.createElement('div');
  const cp = colonyPanel.createPanel(ch, ctx);
  cp.update(s, d);
  assert.ok(!/Alate rearing/.test(ch.textContent), 'no Alate rearing section on the Colony tab');
  cp.destroy();
  setRevealProvider(null);
  setRevealAll(true);
});

// ------------------------------------------------------------------------------------------------ C116 research
test('research (C116): visibleNodes / hide-owned storage helpers are safe with missing or failing storage', () => {
  const owned = new Set(['a', 'c']);
  assert.deepEqual(researchPanel.visibleNodes(['a', 'b', 'c'], (id) => owned.has(id), false), { ids: ['a', 'b', 'c'], hidden: 0 });
  assert.deepEqual(researchPanel.visibleNodes(['a', 'b', 'c'], (id) => owned.has(id), true), { ids: ['b'], hidden: 2 });
  const store = makeFakeStorage();
  assert.equal(researchPanel.loadHideOwned(store), false);
  researchPanel.saveHideOwned(true, store);
  assert.equal(researchPanel.loadHideOwned(store), true);
  researchPanel.saveHideOwned(false, store);
  assert.equal(researchPanel.loadHideOwned(store), false);
  assert.equal(researchPanel.loadHideOwned(null), false);
  const broken = makeFakeStorage({}, new Set(['get', 'set']));
  assert.doesNotThrow(() => researchPanel.saveHideOwned(true, broken));
  assert.equal(researchPanel.loadHideOwned(broken), false);
});

test('research panel (C116): "Hide completed" hides owned nodes, notes the count, and is remembered', () => {
  if (!RESEARCH_ORDER.length) return;
  const store = makeFakeStorage();
  globalThis.window.localStorage = store;
  try {
    const s = newState(9);
    const d = makeDerived();
    const first = RESEARCH_ORDER.find((id) => !(RESEARCH[id].prereq || []).length);
    s.run.research[first] = 1;
    const host = doc.createElement('div');
    const p = researchPanel.createPanel(host, panelCtx(s, d));
    p.update(s, d);
    assert.ok(host.querySelector('.tech-node[data-id="' + first + '"]'), 'owned node shown by default');
    const box = host.querySelector('.hide-owned input');
    box.checked = true;
    box.listeners.change[0]({ type: 'change' });
    p.update(s, d);
    assert.equal(host.querySelector('.tech-node[data-id="' + first + '"]'), null, 'owned node hidden');
    const note = host.querySelectorAll('.tech-hidden-note').find((n) => !n.hidden);
    assert.ok(note && /1 completed hidden/.test(note.textContent));
    assert.match(host.querySelector('.hide-owned-count').textContent, /1 hidden/);
    assert.equal(store.getItem(researchPanel.HIDE_OWNED_KEY), '1');
    p.destroy();
    const host2 = doc.createElement('div');
    const p2 = researchPanel.createPanel(host2, panelCtx(s, d));
    p2.update(s, d);
    assert.equal(host2.querySelector('.hide-owned input').checked, true, 'remembered per browser');
    assert.equal(host2.querySelector('.tech-node[data-id="' + first + '"]'), null);
    p2.destroy();
  } finally {
    delete globalThis.window.localStorage;
  }
});

test('context menu: a destination that already has a trail offers "Remove trail to here" instead of drawing one', () => {
  setRevealAll(true);
  uistate.resetUI();
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.appendChild(root);
  const game = createGame({ nowMs: 1000, storage: makeFakeStorage(), stepFn: () => [] });
  const ui = mountUI(root, game, { loadRender: false });
  ui.frame(1000);
  const calls = [];
  game.actions.do = (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; };
  const seed = addSource(game.s, 'seed_patch', hexIndex(2, 0));
  game.s.run.surface.trails.push({ uid: 900, origin: 0, src: seed.uid, path: [0, seed.hex], len: 2, job: 'forager', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  ui.bridge.contextMenu({ view: 'surface', kind: 'source', id: seed.uid, hex: seed.hex }, 50, 50);
  const menu = root.querySelector('.ctx-menu');
  assert.ok(menu);
  assert.equal(button(menu, 'Draw trail from nearest entrance'), null, 'no second trail offered');
  button(menu, 'Remove trail to here').click();
  assert.deepEqual(calls.at(-1), { type: 'deleteTrail', args: { uid: 900 } });
  ui.destroy();
  root.remove();
});
