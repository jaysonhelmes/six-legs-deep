// C129 / C130 (player requests): the impassable-terrain hex tooltip, Colony History run metadata on Strata records
// (Flight / Supercolony / Speciation), the gallery's card data and DOM (fake DOM), and the Prestige-tab button.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { doFlight, doSupercolony, handlers, newGame, strataSilhouette } from '../src/systems/prestige.js';
import { bitsEncode } from '../src/core/save.js';
import { GRID, CELL } from '../src/data/balance.js';
import { SPEC } from '../src/data/prestige.js';
import { fmtCount } from '../src/ui/format.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const history = await import('../src/ui/history.js');
const { hexTerrainLine } = await import('../src/ui/tooltips.js');
const uistate = await import('../src/ui/uistate.js');
const { setRevealAll } = await import('../src/ui/reveal.js');
const prestigePanel = await import('../src/ui/panels/prestige.js');

before(() => { setRevealAll(true); });
after(() => {
  setRevealAll(false);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const N = GRID.cols * GRID.rows;

// ------------------------------------------------------------------------------------------------ C129 tooltip
test('C129: stone hexes say they are impassable; puddles only while they block (spring)', () => {
  const d = { surface: { passable: [1, 0, 0, 1] } };
  assert.equal(hexTerrainLine('stone', 1, d), 'Stone — impassable. Trails route around it.');
  assert.equal(hexTerrainLine('stone', 0, null), 'Stone — impassable. Trails route around it.');
  assert.equal(hexTerrainLine('puddle', 2, d), 'Puddle — flooded in spring. Trails route around it.');
  assert.equal(hexTerrainLine('puddle', 3, d), 'Puddle', 'a dry puddle is just a puddle');
  assert.equal(hexTerrainLine('grass', 0, d), 'Grass');
});

// ------------------------------------------------------------------------------------------------ C130 metadata
test('C130: a Flight records run number, species, duration, peak adults, alates, date (and hardship when set)', () => {
  const s = newState(2);
  const d = makeDerived();
  s.run.index = 4;
  s.run.time = 3725.4;
  s.run.stats.maxAdults = 12345;
  s.run.fRun = 1e9;
  s.meta.lastSeen = 1759600000000;
  const alates = doFlight(s, d, fakeEnv());
  const r = s.meta.strata.at(-1);
  assert.equal(r.kind, 'run');
  assert.match(r.cells, /^bits:/);
  assert.equal(r.n, 5);
  assert.equal(r.sp, 'garden_ant');
  assert.equal(r.dur, 3725);
  assert.equal(r.peak, 12345);
  assert.ok(alates > 0);
  assert.equal(r.gain, Number(alates.toPrecision(4)));
  assert.equal(r.date, Math.round(1759600000000 / 60000));
  assert.equal(r.hs, undefined);
  assert.equal(s.cycle.daughters.at(-1).alates, alates, 'daughters still get the alates');
  // a Hardship run is named
  s.meta.pending = null;
  s.run.hardship = 'pacifist';
  s.run.fRun = 1e9;
  doFlight(s, d, fakeEnv());
  assert.equal(s.meta.strata.at(-1).hs, 'pacifist');
});

test('C130: a Supercolony records the kinship and a Speciation the genes (and the species that ended)', () => {
  const s = newState(6);
  const d = makeDerived();
  newGame(s, d);
  s.cycle.alatesCycle = 20000;
  s.cycle.traits = { budding: 1 };
  const kin = doSupercolony(s, d, fakeEnv(), { edict: null });
  const rc = s.meta.strata.at(-1);
  assert.equal(rc.kind, 'cycle');
  assert.equal(rc.gain, Number(kin.toPrecision(4)));
  assert.equal(rc.n, 1);

  const fallen = (uid) => ({ uid, type: 'great_rival', tier: 0, hex: 100 + uid, radius: 3, base: 0, n: 0, atk: 1, hp: 1, traits: [],
    alive: false, sighted: true, raidIn: 0, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: 1, fallenAt: 900, extra: [], lost: [], stolen: 0 });
  s.era.kinshipLife = SPEC.kinshipMin;
  s.cycle.alatesCycle = 1e6;
  for (let i = 0; i < 3; i++) s.run.rivals.list.push(fallen(10 + i));
  s.meta.speciesUnlocked.leafcutter = true;
  const env = fakeEnv();
  handlers.speciate.apply(s, d, { type: 'speciate', species: 'leafcutter' }, env);
  const re = s.meta.strata.at(-1);
  assert.equal(re.kind, 'era');
  assert.equal(re.sp, 'garden_ant', 'the species of the era that ended');
  assert.equal(re.n, 2);
  assert.equal(re.gain, env.events.find((e) => e.type === 'speciationComplete').genes);
});

// ------------------------------------------------------------------------------------------------ C130 gallery
test('C130: decodeSilhouette reads bits: and legacy rle: records; rows crop below the deepest open cell', () => {
  const cells = new Array(N).fill(CELL.SOIL);
  for (const i of [0, 41, 42, 20 * GRID.cols + 7]) cells[i] = CELL.TUNNEL;
  cells[5 * GRID.cols + 3] = CELL.CHAMBER;
  cells[6] = CELL.STONE;
  const mask = history.decodeSilhouette(strataSilhouette(cells), N);
  for (let i = 0; i < N; i++) assert.equal(mask[i], cells[i] === CELL.TUNNEL || cells[i] === CELL.CHAMBER ? 1 : 0, 'cell ' + i);
  assert.deepEqual(Array.from(history.decodeSilhouette(bitsEncode(mask), N)), Array.from(mask));
  const rle = history.decodeSilhouette('rle:0*2,1,2,3*3,0', 8);
  assert.deepEqual(Array.from(rle), [0, 0, 1, 1, 0, 0, 0, 0]);
  assert.equal(history.decodeSilhouette('junk', 4).reduce((a, b) => a + b, 0), 0);
  assert.equal(history.silhouetteRows(mask), 24, 'deepest row 20 + 4');
  assert.equal(history.silhouetteRows(new Uint8Array(N)), 18, 'never fewer than 18 rows');
});

test('C130: history cards are newest first, formatted, and old records show what they have', () => {
  const s = newState(3);
  s.meta.strata = [
    { kind: 'run', cells: 'rle:1*3', at: 600 },                                                       // pre-C130 record
    { kind: 'run', cells: 'bits:B', at: 4000, n: 2, sp: 'garden_ant', dur: 3725, peak: 12345, gain: 1520, date: 29326680 },
    { kind: 'cycle', cells: 'bits:', at: 9000, n: 3, sp: 'garden_ant', dur: 90061, peak: 2.5e6, gain: 7, hs: 'pacifist' },
    { kind: 'era', cells: 'bits:', at: 9999, n: 4, sp: 'leafcutter', dur: 10, peak: 1, gain: 20 },
    null,
  ];
  const cards = history.historyCards(s);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => c.title), ['Run 4', 'Run 3', 'Run 2', 'Past run']);
  assert.deepEqual(cards.map((c) => c.layer), ['Speciation', 'Supercolony', 'Nuptial Flight', 'Nuptial Flight']);
  const [era, cyc, run, old] = cards;
  assert.equal(era.gain, '+20 genes');
  assert.equal(era.species, 'Leafcutter');
  assert.equal(cyc.gain, '+7 kinship');
  assert.equal(cyc.duration, '1d 1h');
  assert.equal(cyc.hardship, 'Pacifist');
  assert.equal(run.duration, '1h 02m');
  assert.equal(run.peak, fmtCount(12345) + ' ants');
  assert.equal(run.gain, '+' + fmtCount(1520) + ' alates');
  assert.equal(run.when, history.fmtDate(29326680));
  assert.match(run.when, /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d$/);
  assert.equal(old.species, null);
  assert.equal(old.duration, null);
  assert.equal(old.gain, null);
  assert.equal(old.when, 'After 10m 00s of play');
  // card DOM: rows only for the fields present
  const el = history.historyCard(old);
  assert.equal(el.querySelectorAll('dt').length, 0);
  assert.match(el.textContent, /Past run/);
  const full = history.historyCard(run);
  assert.deepEqual(full.querySelectorAll('dt').map((x) => x.textContent), ['Species', 'Duration', 'Peak', 'Earned']);
  assert.ok(full.querySelector('canvas'));
  const gallery = history.historyGallery(s);
  assert.equal(gallery.querySelectorAll('.history-card').length, 4);
  assert.match(history.historyGallery(newState(1)).textContent, /No past runs yet/);
});

test('C130: Prestige → Flight shows the Colony History button once a run is recorded; it opens the dialog', () => {
  const s = newState(8);
  const d = makeDerived();
  const opened = [];
  const ctx = {
    game: { s, d, actions: { do: () => ({ ok: true, reason: null }) } },
    ui: uistate, bridge: { reject() {}, select() {}, openTab() {} },
    dialogs: { history: () => opened.push('history') },
  };
  uistate.resetUI();
  const host = doc.createElement('div');
  const p = prestigePanel.createPanel(host, ctx);
  p.update(s, d);
  const sec = host.querySelector('.sec-history');
  assert.ok(sec);
  assert.equal(sec.hidden, true, 'hidden with no past runs');
  s.meta.strata.push({ kind: 'run', cells: 'bits:', at: 5 }, { kind: 'run', cells: 'bits:', at: 9 });
  p.update(s, d);
  assert.equal(sec.hidden, false);
  assert.match(sec.textContent, /last 2 runs/);
  sec.querySelectorAll('button').find((b) => b.textContent === 'Open Colony History').click();
  assert.deepEqual(opened, ['history']);
});
