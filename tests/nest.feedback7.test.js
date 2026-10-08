// Feedback pass 7, nest and Build tab (ARCHITECTURE §18 C212–C219): the Royal Chamber row and named costs in the Build
// list (C212), Hide maxed / sorting / undiscovered chambers hidden (C212), frost exposure in cells (C213), who dug the
// tunnels the player did not draw (C214), wider nests at run start (C215), the house pip and the golden pupa / queen
// glow explained (C216, C217), blueprint moves only to diggable spots (C218) and chambers in the Colony History (C219).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, stepFor } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER, CHAMBER_CODES, HISTORY_CHAMBERS_MAX } from '../src/data/chambers.js';
import { AUTO_TUNNEL } from '../src/data/strata.js';
import * as nest from '../src/systems/nest.js';
import { generateNest } from '../src/systems/nestgen.js';
import { idx, rectCells, frostCells, exposedTo, syncCols, colsOfNest } from '../src/systems/nestgeom.js';
import { startRun, doFlight } from '../src/systems/prestige.js';
import { colForHex } from '../src/core/hex.js';
import { defaultNestCells } from '../src/core/state.js';
import { toExportString, fromExportString } from '../src/core/save.js';
import { setRevealProvider } from '../src/ui/reveal.js';
import { chamberListing, condKnown, cheapestButton, costShortText, frostTipLine, dugByText, housePipLines, pupaTipLines, loadHideMaxed,
  saveHideMaxed, HIDE_MAXED_KEY } from '../src/ui/panels/build.js';
import { tunnelAutoText, logEntryFor, LOG_EVENTS } from '../src/ui/eventLog.js';
import { decodeChambers, historyCards, drawSilhouette, chamberSummary, recordCols } from '../src/ui/history.js';
import { UNLOCKS } from '../src/data/unlocks.js';

function setup(seed = 1) {
  const s = newState(seed);
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 1e9 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e9, soil: 1e9, chitin: 1e6, honeydew: 1e6, fungus: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd) {
  const h = nest.handlers[cmd.type];
  const env = fakeEnv();
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  return { reason: r, events: env.events || [] };
}

function addChamber(s, type, x, y, w, h, extra = {}) {
  const n = s.run.nest;
  const ch = { uid: n.nextUid++, type, k: n.chambers.filter((c) => c.type === type).length, x, y, w, h, level: 1, target: 1, status: 'active',
    blueprint: false, bornAt: 0, ...extra };
  n.chambers.push(ch);
  for (const c of rectCells(x, y, w, h)) n.cells[c] = CELL.CHAMBER;
  n.rev++;
  return ch;
}

function addPocket(s, x, y, w, h, revealed = true) {
  for (const c of rectCells(x, y, w, h)) s.run.nest.cells[c] = CELL.WATER;
  s.run.nest.features.water.push({ x, y, w, h, revealed });
  s.run.nest.rev++;
}

/** Reveal = unlocked (a contract-faithful fake, so the Build list does not depend on the reveal queue). */
function withReveal(fn) {
  setRevealProvider((s, key) => !!(s && s.run && s.run.unlocked && s.run.unlocked[key]));
  try { return fn(); } finally { setRevealProvider(null); }
}

// ------------------------------------------------------------------------------------------------ C212 Build list
test('C212: the Royal Chamber levels from the Build list like any chamber: cost named with every resource', () => {
  const { s, d } = setup();
  const cb = cheapestButton(s, d, 'royal_chamber', { compact: true });
  assert.equal(cb.show, true);
  assert.equal(cb.uid, 1);
  assert.equal(cb.head, 'Lvl up', 'one Royal Chamber: level it up');
  assert.ok(cb.cost.food > 0 && cb.cost.soil > 0);
  assert.match(cb.label, /^Lvl up · .+ food · .+ soil$/);
  assert.equal(cb.ok, true);
  assert.equal(cb.up, true, 'its next level is affordable (the ▲ mark)');
  s.run.res.food = 0;
  const poor = cheapestButton(s, d, 'royal_chamber', { compact: true });
  assert.equal(poor.ok, false);
  assert.equal(poor.up, false);
  assert.equal(costShortText({ food: 47700, soil: 2100, chitin: 0 }), '47.7K food · 2.10K soil');
  assert.equal(costShortText(null), '');
});

test('C212: Build list: placeable types first, then maxed (hidden on request), then locked types with a known unlock only', () => {
  withReveal(() => {
    const { s } = setup();
    for (const k of Object.keys(s.run.unlocked)) if (k.startsWith('chamber_')) delete s.run.unlocked[k];
    Object.assign(s.run.unlocked, { chamber_gallery: true, chamber_granary: true, chamber_gate: true, panel_research: true });
    s.run.research = {};
    addChamber(s, 'gate', 21, 2, 2, 2);
    let L = chamberListing(s);
    assert.ok(!L.ids.includes('royal_chamber'), 'the Royal Chamber has its own pinned row');
    assert.deepEqual(L.ids.slice(0, 2), ['gallery', 'granary'], 'placeable first, data order');
    assert.equal(L.states.gate, 'maxed');
    assert.ok(L.ids.indexOf('gate') > L.ids.indexOf('granary'));
    // Barracks needs Polymorphism: a tier-1 node (no prerequisites) is buyable now, so the Barracks shows, greyed
    const barracksU = UNLOCKS.find((u) => u.key === 'chamber_barracks');
    assert.equal(condKnown(s, barracksU.cond), true);
    assert.equal(L.states.barracks, 'locked');
    assert.ok(L.ids.indexOf('barracks') > L.ids.indexOf('gate'), 'locked after maxed');
    // milestone unlocks (8 adults, 30 adults) and research whose prerequisites are missing stay hidden
    assert.ok(!L.ids.includes('nursery') && !L.ids.includes('scent_library'));
    assert.ok(!L.ids.includes('deep_vault'), 'Acid Excavation is not buyable yet: no Deep Vault row');
    assert.ok(!L.ids.includes('war_hall'), 'Supermajors needs Polymorphism first');
    // without the Research tab nothing research-gated is "known"
    delete s.run.unlocked.panel_research;
    L = chamberListing(s);
    assert.ok(!L.ids.includes('barracks'));
    // Hide maxed
    s.run.unlocked.panel_research = true;
    L = chamberListing(s, { hideMaxed: true });
    assert.ok(!L.ids.includes('gate'));
    assert.equal(L.hidden, 1);
    // owning the research shows what it leads to
    s.run.research.polymorphism = 1;
    s.run.research.spermathecal_reserve = 1;
    L = chamberListing(s);
    assert.equal(L.states.war_hall, 'locked', 'Supermajors is buyable once its prerequisites are owned');
  });
});

test('C212: the Hide maxed choice is remembered per browser and survives blocked storage', () => {
  const store = new Map();
  const fake = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(loadHideMaxed(fake), false);
  saveHideMaxed(true, fake);
  assert.equal(store.get(HIDE_MAXED_KEY), '1');
  assert.equal(loadHideMaxed(fake), true);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadHideMaxed(broken), false);
  saveHideMaxed(true, broken);
});

// ------------------------------------------------------------------------------------------------ C213 frost
test('C213: frost exposure is the majority of cells above the frost line (exactly half is safe)', () => {
  assert.deepEqual(frostCells({ x: 0, y: 16, w: 2, h: 3 }, 18), { above: 4, total: 6, exposed: true, straddles: true });
  assert.deepEqual(frostCells({ x: 0, y: 17, w: 3, h: 2 }, 18), { above: 3, total: 6, exposed: false, straddles: true });
  assert.deepEqual(frostCells({ x: 0, y: 18, w: 3, h: 2 }, 18), { above: 0, total: 6, exposed: false, straddles: false });
  assert.deepEqual(frostCells({ x: 0, y: 10, w: 3, h: 2 }, 0), { above: 0, total: 6, exposed: false, straddles: false });
  for (const [y, h] of [[16, 3], [17, 2], [15, 2], [17, 3]]) assert.equal(frostCells({ y, h, w: 4 }, 18).exposed, exposedTo({ y, h }, 18));
});

test('C213: the placement ghost says how many cells sit above the frost line, exposed or safe', () => {
  const { s, d } = setup();
  const safe = nest.validatePlacement(s, d, 'gallery', 4, 17);
  const ms = safe.mods.find((m) => m.key === 'frostSafe');
  assert.ok(ms, JSON.stringify(safe.mods));
  assert.deepEqual([ms.above, ms.total, ms.row], [3, 6, 18]);
  assert.ok(!safe.mods.some((m) => m.key === 'frostExposed'));
  const exp = nest.validatePlacement(s, d, 'gallery', 4, 16);
  const me = exp.mods.find((m) => m.key === 'frostExposed');
  assert.ok(me && me.value === 0.5);
  assert.deepEqual([me.above, me.total], [6, 6]);
  // immune types say nothing
  assert.ok(!nest.validatePlacement(s, d, 'gate', 21, 2).mods.some((m) => m.key === 'frostExposed' || m.key === 'frostSafe'));
});

test('C213: a chamber tooltip names its frost cells (now in winter, or for a hard winter)', () => {
  const { s, d } = setup();
  const g = addChamber(s, 'gallery', 4, 17, 3, 2);
  nest.derive(s, d);
  const fr = nest.chamberFrost(s, d, g.uid);
  assert.deepEqual([fr.hard.above, fr.hard.total, fr.hard.exposed, fr.hard.straddles], [3, 6, false, true]);
  assert.match(frostTipLine(fr), /^Safe from frost: most cells below the frost line \(3 of 6 above row 18\)\.$/);
  const g2 = addChamber(s, 'gallery', 10, 16, 3, 2);
  d.season.frostRow = 18;
  nest.derive(s, d);
  const f2 = nest.chamberFrost(s, d, g2.uid);
  assert.equal(f2.now.exposed, true);
  assert.match(frostTipLine(f2, true), /^Frost-exposed: 6 of 6 cells above the frost line \(row 18\): effect ×0\.5\.$/);
  assert.equal(frostTipLine(nest.chamberFrost(s, d, 1)), '', 'the Royal Chamber is immune');
});

// ------------------------------------------------------------------------------------------------ C214 tunnels
test('C214: a mole tunnel is tagged, announced in the event log and explained on hover', () => {
  const { s, d } = setup(3);
  const env = fakeEnv();
  const r = nest.moleTunnel(s, d, env);
  assert.ok(r.cells.length >= 6);
  const ev = (env.events || []).find((e) => e.type === 'tunnelAuto');
  assert.ok(ev && ev.reason === 'mole' && ev.n === r.cells.length);
  assert.ok(LOG_EVENTS.includes('tunnelAuto'));
  assert.match(logEntryFor({ type: 'tunnelAuto', ...ev }, s).text, /^A mole dug a free tunnel \(\d+ cells\)\.$/);
  const info = nest.cellInfo(s, d, r.cells[0]);
  assert.deepEqual(info.dugBy, { why: 'mole', type: null });
  assert.match(dugByText(info), /^Dug by: a mole \(Mole Tunnel event\)/);
  // plain soil says nothing
  assert.equal(dugByText(nest.cellInfo(s, d, idx(2, 70))), '');
});

test('C214: auto-routed tunnels to a placed chamber and blueprint access tunnels say who they are for', () => {
  const { s, d } = setup();
  const r = run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 4, y: 8 });
  assert.equal(r.reason, null);
  const job = s.run.nest.queue.find((j) => j.kind === 'chamber');
  const routeCell = job.cells.find((c) => !rectCells(4, 8, 3, 2).includes(c));
  assert.ok(routeCell >= 0, 'an auto-routed tunnel was needed');
  const info = nest.cellInfo(s, d, routeCell);
  assert.deepEqual(info.dugBy, { why: 'route', type: 'gallery' });
  assert.equal(dugByText(info), 'Dug by: auto-route to the Gallery (it did not touch an open cell).');
  // a blueprint chamber away from the nest gets a queued access tunnel, announced at the next tick
  const b = setup();
  b.s.cycle.traits.ancestral_blueprint = 1;
  b.s.era.blueprints = [{ name: 'B', tunnels: [], chambers: [{ type: 'granary', x: 6, y: 30, w: 2, h: 2, level: 1 }] }];
  b.s.era.activeBlueprint = 0;
  nest.applyBlueprint(b.s, b.d);
  const note = b.s.run.nest.bpNotes.find((n) => n.ev === 'tunnelAuto');
  assert.ok(note && note.reason === 'access' && note.chamberType === 'granary', JSON.stringify(b.s.run.nest.bpNotes));
  assert.equal(tunnelAutoText(note), 'Access tunnel (' + note.n + ' cells) queued for the planned Granary.');
  const acc = b.s.run.nest.queue.find((j) => j.bpAccess);
  assert.deepEqual(nest.cellInfo(b.s, b.d, acc.cells[0]).dugBy, { why: 'access', type: 'granary' });
});

test('C214: the record of automatic tunnels stays bounded', () => {
  const { s, d } = setup();
  for (let k = 0; k < AUTO_TUNNEL.maxEntries + 10; k++) nest.moleTunnel(s, d, fakeEnv());
  const list = s.run.nest.dugBy;
  assert.ok(list.length <= AUTO_TUNNEL.maxEntries);
  assert.ok(list.reduce((n, e) => n + e.c.length, 0) <= AUTO_TUNNEL.maxCells);
  // queens' court passage of a polygyne start is tagged by the generator
  const g = generateNest(5, { royalCount: 2 });
  assert.equal(g.dugBy[0].w, 'court');
  assert.match(dugByText({ dugBy: { why: 'court', type: 'royal_chamber' } }), /queens' chambers/);
});

// ------------------------------------------------------------------------------------------------ C216 / C217
test('C216 / C217: the house pip, the golden pupa and the queen glow explain themselves', () => {
  const { s, d } = setup();
  s.run.colony.adults.minor = 10;
  d.stats.housing = 10;
  const hp = housePipLines(s, d);
  assert.match(hp[0], /^Housing full: 10 \/ 10/);
  assert.match(hp[1], /Galleries/);
  s.run.golden = { pupa: { chamber: 1, t: 12 } };
  const pl = pupaTipLines(s);
  assert.match(pl.join(' '), /golden pupa/i);
  assert.match(pl[1], /Gone in 12s/);
});

// ------------------------------------------------------------------------------------------------ C218 blueprint moves
test('C218: a blueprint chamber moved off water never lands where its room reaches a layer that cannot be dug yet', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  delete s.run.research.acid_excavation;
  // a granary saved at rows 56–57 growing down (its full-size room reaches row 59, Bedrock); water now covers the spot,
  // and stone fills the gravel above, so the only "free" spots nearby put its room into Bedrock
  addPocket(s, 10, 56, 2, 2, true);
  for (let y = 46; y <= 55; y++) for (let x = 2; x <= 17; x++) s.run.nest.cells[idx(x, y)] = CELL.STONE;
  s.run.nest.rev++;
  nest.derive(s, d);
  s.era.blueprints = [{ name: 'B', tunnels: [], chambers: [{ type: 'granary', x: 10, y: 56, w: 2, h: 2, level: 1,
    res: { x: 10, y: 56, w: 7, h: 4 } }] }];
  s.era.activeBlueprint = 0;
  nest.applyBlueprint(s, d);
  const moved = s.run.nest.bpNotes.filter((n) => n.ev === 'blueprintAdjusted');
  const g = s.run.nest.chambers.find((c) => c.type === 'granary');
  const p = s.run.nest.bpPending.find((x) => x.type === 'granary');
  assert.ok(!g, 'not placed');
  assert.ok(p, 'it waits as a planned chamber');
  assert.deepEqual([p.x, p.y], [10, 56], 'at its saved spot');
  assert.equal(moved.length, 0, 'no move into Bedrock (before C218 it went to (8, 56), its room down to row 59)');
  // with Acid Excavation Bedrock (and the stone) can be dug: now a nearby spot is fine
  const b = setup();
  b.s.cycle.traits.ancestral_blueprint = 1;
  b.s.run.research.acid_excavation = 1;
  addPocket(b.s, 10, 56, 2, 2, true);
  nest.derive(b.s, b.d);
  b.s.era.blueprints = s.era.blueprints;
  b.s.era.activeBlueprint = 0;
  nest.applyBlueprint(b.s, b.d);
  assert.ok(b.s.run.nest.bpNotes.some((n) => n.ev === 'blueprintAdjusted' && n.chamberType === 'granary'), 'moved next door');
});

// ------------------------------------------------------------------------------------------------ C215 wider nests
test('C215: a run starts wider with Satellite Nest levels: centred shaft, Royal Chamber and entrance; capped at 64', () => {
  const s = newState(9);
  const d = makeDerived();
  assert.equal(nest.runStartCols(s), 40);
  s.era.federation.satellite_nest = 1;
  assert.equal(nest.runStartCols(s), 48);
  s.era.federation.satellite_nest = 7;
  assert.equal(nest.runStartCols(s), 64);
  s.era.federation.satellite_nest = 2;
  startRun(s, d, { seed: 77, env: fakeEnv() });
  const n = s.run.nest;
  assert.equal(n.cols, 56);
  assert.equal(n.cells.length, 56 * GRID.rows);
  assert.equal(nest.nestCols(s), 56);
  assert.equal(GRID.cols, 56, 'the active width follows the run');
  assert.equal(n.shafts[0].col, 28);
  const royal = n.chambers.find((c) => c.uid === 1);
  assert.deepEqual([royal.x, royal.y], [26, 20]);
  for (let y = 0; y < GRID.shaftRows; y++) assert.equal(n.cells[y * 56 + 28], CELL.TUNNEL);
  assert.equal(s.run.surface.entrances.find((e) => e.kind === 'main').col, 28);
  for (const r of n.features.roots) assert.ok(r.col >= 1 && r.col <= 54);
  // the game plays in it: place a chamber in the new columns, dig, save and load
  Object.assign(s.run.res, { food: 1e9, soil: 1e9 });
  s.run.unlocked.chamber_gallery = true;
  s.run.colony.adults.minor = 50;
  s.run.colony.jobs.digger = 40;
  nest.derive(s, d);
  assert.equal(nest.validatePlacement(s, d, 'gallery', 50, 3).ok, true, 'a spot only a wide nest has');
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 50, y: 3 }).reason, null);
  stepFor(s, d, 3);
  const str = toExportString(s, 1);
  const back = fromExportString(str);
  assert.equal(back.ok, true, back.error);
  assert.equal(back.state.run.nest.cols, 56);
  assert.equal(back.state.run.nest.cells.length, 56 * GRID.rows);
  // a broken width is refused
  const bad = JSON.parse(JSON.stringify(s));
  bad.run.nest.cols = 50;
  assert.equal(fromExportString(toExportString(bad, 1)).ok, false);
  // a fresh 40-wide state afterwards works as before (the active width follows the state being worked on)
  const t = setup();
  assert.equal(GRID.cols, 40);
  assert.equal(nest.validatePlacement(t.s, t.d, 'gallery', 4, 8).ok, true);
  assert.equal(syncCols(s), 56);
  assert.equal(syncCols(t.s), 40);
});

test('C215: old saves and normal runs stay 40 wide; root columns map in the base frame', () => {
  const s = newState(4);
  assert.equal(colsOfNest(s.run.nest), 40);
  assert.equal(s.run.nest.cols, undefined);
  assert.equal(defaultNestCells().length, 40 * GRID.rows);
  assert.equal(defaultNestCells(48)[GRID.shaftRows - 1 + 0 * 48] === undefined, false);
  assert.equal(colForHex(0), 20);
  const g = generateNest(11, { cols: 48, rootCols: [20, 30] });
  assert.equal(g.cols, 48);
  assert.ok(g.features.roots.some((r) => r.col === 26 || r.col === 25 || r.col === 27), 'root col 20 shifted by 4 (or next to the shaft)');
  assert.ok(g.features.roots.some((r) => r.col === 34), 'root col 30 shifted by 4');
  const g40 = generateNest(11, { rootCols: [20, 30] });
  assert.equal(g40.cols, undefined);
  assert.equal(g40.cells.length, 40 * GRID.rows);
});

test('C215: a blueprint moves between nest widths centred on the main shaft; wide layouts keep their width', () => {
  const bp = { name: 'L', chambers: [{ type: 'gallery', x: 2, y: 10, w: 3, h: 2, level: 2, res: { x: 2, y: 10, w: 8, h: 4 } },
    { type: 'granary', x: 30, y: 30, w: 2, h: 2, level: 1 }], tunnels: [10 * 40 + 1, 5 * 40 + 39], royal: { x: 18, y: 20 } };
  const wide = nest.blueprintForCols(bp, 48);
  assert.equal(wide.cols, 48);
  assert.deepEqual(wide.chambers.map((c) => c.x), [6, 34]);
  assert.equal(wide.chambers[0].res.x, 6);
  assert.deepEqual(wide.tunnels, [10 * 48 + 5, 5 * 48 + 43]);
  assert.equal(wide.royal.x, 22);
  assert.equal(nest.blueprintForCols(bp, 40), bp, 'same width: unchanged');
  // back down: what no longer fits is left out
  const wb = { name: 'W', cols: 56, chambers: [{ type: 'gallery', x: 1, y: 5, w: 3, h: 2, level: 1 }, { type: 'gallery', x: 20, y: 5, w: 3, h: 2, level: 1 }],
    tunnels: [5 * 56 + 2, 5 * 56 + 30] };
  const narrow = nest.blueprintForCols(wb, 40);
  assert.equal(narrow.cols, undefined);
  assert.deepEqual(narrow.chambers.map((c) => c.x), [12]);
  assert.deepEqual(narrow.tunnels, [5 * 40 + 22]);
  // the editor's save check works in the layout's own width
  assert.ok(nest.sanitizeBlueprint(wb));
  assert.equal(nest.sanitizeBlueprint(wb).cols, 56);
  assert.equal(nest.sanitizeBlueprint({ ...wb, cols: 41 }), null);
  assert.equal(nest.sanitizeBlueprint({ ...wb, cols: 40, chambers: [{ type: 'gallery', x: 39, y: 5, w: 3, h: 2, level: 1 }] }), null, 'past a 40-wide grid');
});

// ------------------------------------------------------------------------------------------------ C219 history
test('C219: a run end stores its chambers compactly; the gallery decodes and draws them (old records still work)', () => {
  const s = newState(2);
  const d = makeDerived();
  addChamber(s, 'gallery', 4, 8, 6, 3, { level: 4 });
  addChamber(s, 'granary', 24, 30, 2, 2, { level: 1 });
  addChamber(s, 'nursery', 30, 26, 3, 2, { level: 0, status: 'digging' });
  s.run.fRun = 1e8;
  doFlight(s, d, fakeEnv());
  const rec = s.meta.strata[s.meta.strata.length - 1];
  assert.equal(typeof rec.ch, 'string');
  assert.equal(rec.cols, undefined, '40 wide: no field');
  const ch = decodeChambers(rec.ch);
  assert.equal(ch.length, 3, 'level-0 chambers are left out');
  assert.deepEqual(ch.find((c) => c.type === 'gallery'), { type: 'gallery', x: 4, y: 8, w: 6, h: 3, level: 4 });
  assert.deepEqual(ch.find((c) => c.type === 'granary'), { type: 'granary', x: 24, y: 30, w: 2, h: 2, level: 1 });
  assert.equal(ch[0].type, 'gallery', 'largest first');
  assert.ok(rec.ch.length <= 3 * 14);
  // cards carry them; old records have none
  s.meta.strata.unshift({ kind: 'run', cells: 'bits:', at: 5 });
  const cards = historyCards(s);
  assert.equal(cards[0].chambers.length, 3);
  assert.equal(cards[cards.length - 1].chambers.length, 0);
  assert.equal(chamberSummary(cards[0].chambers), '3 chambers · Royal L1');
  // drawing: rooms are filled in their colour
  const fills = [];
  const g = new Proxy({}, { get: (t, k) => (k === 'fillRect' ? (...a) => fills.push([t.fillStyle, ...a]) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { width: 0, height: 0, getContext: () => g };
  assert.equal(drawSilhouette(canvas, rec.cells, { chambers: ch, cols: 40 }), true);
  assert.ok(fills.some((f) => f[0] === '#d9b27c'), 'gallery colour');
  assert.equal(canvas.width, 40 * 4);
  // malformed entries are skipped
  assert.deepEqual(decodeChambers('zz.1.1,b1.2,b1.2.3.4.5.6'), []);
  assert.deepEqual(decodeChambers(5), []);
  assert.equal(recordCols({ cols: 56 }), 56);
  assert.equal(recordCols({}), 40);
  // the record never grows past the cap, whatever the nest
  const big = Array.from({ length: 60 }, (_, k) => ({ uid: k + 2, type: CHAMBER_ORDER[k % CHAMBER_ORDER.length], x: k % 30, y: 10 + (k % 40), w: 3, h: 2, level: 9 }));
  const packed = nest.strataChambers(big);
  assert.ok(packed.split(',').length <= HISTORY_CHAMBERS_MAX);
  assert.ok(packed.length <= HISTORY_CHAMBERS_MAX * 14);
  for (const t of CHAMBER_ORDER) assert.ok(CHAMBER_CODES[t], 'every chamber type has a code: ' + t);
  assert.equal(new Set(Object.values(CHAMBER_CODES)).size, Object.keys(CHAMBER_CODES).length, 'codes are unique');
});
