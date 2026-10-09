// Feedback pass 8, nest and Build tab (ARCHITECTURE §18 C251–C258): Hide maxed only when fully levelled, the fixed
// dig-queue box, the stone tooltip and the labelled Mound bar (C251), the dig / backfill speed cap and sequential
// backfill (C252), auto-backfill (C253), the relocation clearing phase (C254), pocket moves without a row limit (C255),
// free-drawn tunnels (C256), R / Q on the hovered chamber and R / right-click cancelling a relocation (C257), and
// blueprints applied only with their unlock, with a "Clear active blueprint" command (C258).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL, DIG_CAP } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { DIG } from '../src/data/strata.js';
import * as nest from '../src/systems/nest.js';
import { idx, rectCells } from '../src/systems/nestgeom.js';
import { startRun } from '../src/systems/prestige.js';
import { setRevealProvider } from '../src/ui/reveal.js';
import { chamberListing, chamberHotkey, chamberHotkeyAction, moundProgressText, relocationProgress } from '../src/ui/panels/build.js';
import { stoneTipLines, tipForTarget } from '../src/ui/tooltips.js';

function setup(seed = 1, digW = 0) {
  const s = newState(seed);
  const d = makeDerived({ stats: { foodCap: 1e12, digW } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e9, soil: 1e9, chitin: 1e6, honeydew: 1e6, fungus: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd, env = fakeEnv()) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  return r;
}

/** One nest step of dt seconds (derive then tick), capped as in the game. */
function stepNest(s, d, dt = 1) {
  const env = fakeEnv({ dt });
  nest.derive(s, d);
  nest.tick(s, d, dt, env);
  return env.events;
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

function withReveal(fn) {
  setRevealProvider((s, key) => !!(s && s.run && s.run.unlocked && s.run.unlocked[key]));
  try { return fn(); } finally { setRevealProvider(null); }
}

/** A straight tunnel east along row y from the main shaft (x 21 … x1), dug at once. */
function digRow(s, y, x1) {
  for (let x = 21; x <= x1; x++) s.run.nest.cells[idx(x, y)] = CELL.TUNNEL;
  s.run.nest.rev++;
}

// ------------------------------------------------------------------------------------------------ C251 Build tab
test('C251: Hide maxed hides a type only when none can be placed and every built one is at its max level', () => {
  withReveal(() => {
    const { s } = setup();
    // Granary: 3 built (its limit) but no max level: always listed
    for (let k = 0; k < 3; k++) addChamber(s, 'granary', 2 + k * 3, 30, 2, 2, { level: 40, target: 40 });
    // Thermal Chimney: 1 built (its limit), max level 6
    const tc = addChamber(s, 'thermal_chimney', 2, 0, 2, 4, { level: 5, target: 5 });
    assert.equal(nest.typeFullyLeveled(s, 'granary'), false, 'no max level: never fully levelled');
    assert.equal(nest.typeFullyLeveled(s, 'thermal_chimney'), false, 'L5 of 6');
    let L = chamberListing(s, { hideMaxed: true });
    assert.ok(L.ids.includes('granary') && L.ids.includes('thermal_chimney'));
    assert.equal(L.hidden, 0);
    tc.target = CHAMBERS.thermal_chimney.maxL; // levelling toward its max counts
    assert.equal(nest.typeFullyLeveled(s, 'thermal_chimney'), true);
    L = chamberListing(s, { hideMaxed: true });
    assert.ok(!L.ids.includes('thermal_chimney'), 'a maxed Thermal Chimney hides');
    assert.ok(L.ids.includes('granary'), 'a Granary that can still level stays');
    assert.equal(L.hidden, 1);
    assert.ok(chamberListing(s).ids.includes('thermal_chimney'), 'shown again with the toggle off');
    // a type below its instance limit is never hidden, whatever its levels
    assert.equal(nest.typeFullyLeveled(s, 'midden'), false, 'none built');
  });
});

test('C251: the dig queue sits in a fixed-height box that scrolls, so the chamber list below never moves', () => {
  const src = readFileSync(new URL('../src/ui/panels/build.js', import.meta.url), 'utf8');
  assert.match(src, /h\('div', \{ class: 'queue-box' \}, noDiggers, queueList, queueEmpty\)/, 'queue, empty note and warning inside the box');
  assert.match(src, /setProp\(helpBtn, 'disabled'/, 'Help dig is greyed, not removed');
  const css = readFileSync(new URL('../styles/panels.css', import.meta.url), 'utf8');
  const rule = css.match(/\.queue-box \{([^}]*)\}/);
  assert.ok(rule, '.queue-box rule');
  assert.match(rule[1], /(^|;)\s*height:\s*[\d.]+rem/, 'a fixed height (not min-height)');
  assert.match(rule[1], /overflow-y:\s*auto/);
});

test('C251: an underground stone says what it is, whether it can be dug or built on, and the research it needs', () => {
  const { s, d } = setup();
  const i = idx(5, 30);
  s.run.nest.cells[i] = CELL.STONE;
  s.run.nest.rev++;
  nest.derive(s, d);
  let info = nest.cellInfo(s, d, i);
  assert.equal(info.stone, true);
  assert.equal(info.stoneOk, false);
  let tip = tipForTarget({ view: 'nest', kind: 'cell', i }, s, d);
  assert.match(tip.title, /^Stone · /);
  assert.match(tip.lines.join(' '), /Cannot be dug or built on yet/);
  assert.match(tip.lines.join(' '), /Acid Excavation research/);
  s.run.research.acid_excavation = 1;
  info = nest.cellInfo(s, d, i);
  assert.equal(info.stoneOk, true);
  tip = tipForTarget({ view: 'nest', kind: 'cell', i }, s, d);
  assert.match(tip.lines[0], /Can be dug and built over now/);
  assert.match(tip.lines.join(' '), /Dig work/);
  assert.deepEqual(stoneTipLines({ stoneOk: false, reserved: 'gallery' }).length, 3, 'a stone inside a reserved room says so');
  // plain soil is not a stone
  assert.equal(nest.cellInfo(s, d, idx(6, 30)).stone, false);
});

test('C251: the Mound bar reads "Progress to Mound L5: 45%" and names what feeds it', () => {
  const g = { prog: 0.45, value: 4.45, inputs: { adults: 250, chambers: 12, dug: 300 }, parts: { adults: 2.2, chambers: 1.6, dug: 0.65 } };
  const t = moundProgressText(g, 4, false, 5);
  assert.equal(t.label, 'Progress to Mound L5: 45%');
  assert.match(t.note, /peak adults 250 \(\+2\.2\)/);
  assert.match(t.note, /chamber levels 12 \(\+1\.6\)/);
  assert.match(t.note, /cells dug 300 \(\+0\.7\)|cells dug 300 \(\+0\.6\)/);
  assert.match(t.note, /each whole point is a level/);
  const c = moundProgressText({ ...g, prog: 0 }, 5, true, 5);
  assert.equal(c.label, 'Progress to Mound L6: waiting for Mound Building');
  assert.match(c.note, /need Mound Building research/);
});

// ------------------------------------------------------------------------------------------------ C252 caps
test('C252: digging never beats DIG_CAP.digCellsPerSec, however strong the diggers', () => {
  const { s, d } = setup(1, 1e12);
  const cells = [];
  for (let x = 21; x <= 38; x++) cells.push(idx(x, 12));
  for (let x = 38; x >= 2; x--) cells.push(idx(x, 13));
  assert.equal(run(s, d, { type: 'digTunnel', cells }), null);
  const open = () => cells.filter((c) => s.run.nest.cells[c] === CELL.TUNNEL).length;
  for (let k = 0; k < 10; k++) stepNest(s, d, 0.1);
  assert.ok(open() <= DIG_CAP.digCellsPerSec + 1, 'about DIG_CAP.digCellsPerSec cells in a second, not ' + open());
  assert.ok(open() >= DIG_CAP.digCellsPerSec - 1, 'but the cap is reached');
  // a long tick is capped by its length (offline catch-up keeps the same rate)
  stepNest(s, d, 2);
  assert.ok(open() <= 3 * DIG_CAP.digCellsPerSec + 1);
  // a Help Dig click finishes at most helpCells cells
  const before = open();
  s.run.time = 100;
  run(s, d, { type: 'helpDig' });
  assert.ok(open() - before <= DIG_CAP.helpCells);
  // slow diggers are untouched by the cap: 12 work/s in loam (6 work per tunnel cell) digs 2 cells a second as before
  const b = setup(2, 12);
  assert.equal(run(b.s, b.d, { type: 'digTunnel', cells: [idx(21, 12), idx(22, 12), idx(23, 12)] }), null);
  for (let k = 0; k < 10; k++) stepNest(b.s, b.d, 0.1);
  assert.equal(b.s.run.nest.cells[idx(22, 12)], CELL.TUNNEL);
  assert.equal(b.s.run.nest.cells[idx(23, 12)], CELL.SOIL);
});

test('C252: backfill runs one cell after another, furthest from the entrance first, at most backfillCellsPerSec', () => {
  const { s, d } = setup();
  digRow(s, 12, 38);
  nest.derive(s, d);
  const list = [];
  for (let x = 22; x <= 38; x++) list.push(idx(x, 12));
  assert.equal(run(s, d, { type: 'backfill', cells: list }), null);
  const per = Math.max(DIG.backfillSec / list.length, 1 / DIG_CAP.backfillCellsPerSec);
  assert.ok(s.run.nest.backfill.every((b) => b.q === 1 && Math.abs(b.d - per) < 1e-9));
  assert.equal(s.run.nest.backfill[0].i, idx(38, 12), 'the far end is first');
  const ev = stepNest(s, d, per * 3 + 1e-6);
  const filled = list.filter((c) => s.run.nest.cells[c] === CELL.SOIL);
  assert.deepEqual(filled.sort((a, b) => a - b), [idx(36, 12), idx(37, 12), idx(38, 12)], 'three cells, from the far end');
  assert.deepEqual(ev.filter((e) => e.type === 'cellBackfilled').map((e) => e.i), [idx(38, 12), idx(37, 12), idx(36, 12)]);
  stepNest(s, d, DIG.backfillSec);
  assert.ok(list.every((c) => s.run.nest.cells[c] === CELL.SOIL), 'a batch still takes backfillSec in all');
  assert.equal(s.run.nest.backfill.length, 0);
  // a big batch: no faster than the cap
  const b = setup(3);
  for (let y = 12; y <= 15; y++) digRow(b.s, y, 38);
  for (let x = 22; x <= 38; x++) for (let y = 13; y <= 15; y++) b.s.run.nest.cells[idx(x, y)] = CELL.TUNNEL;
  nest.derive(b.s, b.d);
  const big = nest.unneededTunnels(b.s, b.d);
  assert.ok(big.length > 2 * DIG_CAP.backfillCellsPerSec);
  assert.equal(run(b.s, b.d, { type: 'backfillUnneeded' }), null);
  stepNest(b.s, b.d, 1);
  const done = big.filter((c) => b.s.run.nest.cells[c] === CELL.SOIL).length;
  assert.ok(done <= DIG_CAP.backfillCellsPerSec, done + ' in the first second');
  // an older save's parallel 10 s entries are shortened to the batch's per-cell time
  const o = setup(4);
  digRow(o.s, 12, 25);
  o.s.run.nest.backfill = [idx(25, 12), idx(24, 12)].map((i) => ({ i, t: 10 }));
  nest.derive(o.s, o.d);
  stepNest(o.s, o.d, 5.01);
  assert.equal(o.s.run.nest.cells[idx(25, 12)], CELL.SOIL);
  stepNest(o.s, o.d, 5);
  assert.equal(o.s.run.nest.cells[idx(24, 12)], CELL.SOIL);
});

// ------------------------------------------------------------------------------------------------ C253 auto-backfill
test('C253: auto-backfill (off by default) queues the unneeded tunnels every autoBackfillSec, never cutting anything off', () => {
  const { s, d } = setup();
  digRow(s, 12, 30);
  nest.derive(s, d);
  assert.notEqual(s.meta.autoBackfill, true, 'off by default');
  stepNest(s, d, DIG.autoBackfillSec + 1);
  assert.equal(s.run.nest.backfill.length, 0, 'off: nothing happens');
  assert.equal(run(s, d, { type: 'setAutoBackfill', on: 'yes' }), 'invalid');
  assert.equal(run(s, d, { type: 'setAutoBackfill', on: true }), null);
  assert.equal(s.meta.autoBackfill, true, 'kept in meta (across runs)');
  const ev = stepNest(s, d, 0.1);
  assert.ok(s.run.nest.backfill.length > 0, 'switching it on checks right away');
  assert.ok(ev.some((e) => e.type === 'autoBackfilled' && e.n === s.run.nest.backfill.length));
  stepNest(s, d, DIG.backfillSec + 1);
  for (let x = 21; x <= 30; x++) assert.equal(s.run.nest.cells[idx(x, 12)], CELL.SOIL);
  // the shaft and a chamber's connection stay open
  const b = setup(5);
  digRow(b.s, 12, 30);
  addChamber(b.s, 'gallery', 31, 12, 3, 2);
  run(b.s, b.d, { type: 'setAutoBackfill', on: true });
  stepNest(b.s, b.d, 0.1);
  stepNest(b.s, b.d, DIG.backfillSec + 1);
  for (let x = 21; x <= 30; x++) assert.equal(b.s.run.nest.cells[idx(x, 12)], CELL.TUNNEL, 'the gallery keeps its tunnel');
  for (let y = 0; y < 20; y++) assert.equal(b.s.run.nest.cells[idx(20, y)], CELL.TUNNEL, 'the shaft stays');
  run(b.s, b.d, { type: 'setAutoBackfill', on: false });
  assert.equal(b.s.meta.autoBackfill, false);
});

// ------------------------------------------------------------------------------------------------ C254 relocation
test('C254: a relocation is never instant: the old room is cleared over time and the chamber is inactive meanwhile', () => {
  const { s, d } = setup(1, 1e9);
  digRow(s, 12, 30);
  const g = addChamber(s, 'gallery', 31, 12, 3, 2);
  nest.derive(s, d);
  // the new spot overlaps the tunnel: almost nothing to dig, but the old room still takes its time
  assert.equal(run(s, d, { type: 'relocateChamber', uid: g.uid, x: 26, y: 12 }), null);
  assert.equal(g.status, 'relocating');
  const dur = DIG.relocateClearBase + DIG.relocateClearPerCell * 6;
  assert.equal(g.reloc.dur, dur);
  stepNest(s, d, 1);
  assert.equal(g.status, 'relocating', 'still clearing');
  nest.derive(s, d);
  assert.equal(d.nest.agg.housingBase, 10, 'its housing is gone while it moves (the Royal Chamber alone)');
  const rl = nest.relocationInfo(s, d, g.uid);
  const p = relocationProgress(rl);
  assert.match(p.text, /(Clearing the old room|Moving in): .* left|Old room still working/);
  assert.ok(p.frac > 0 && p.frac < 1);
  const ev = stepNest(s, d, dur);
  assert.equal(g.status, 'active');
  nest.derive(s, d);
  assert.ok(d.nest.agg.housingBase > 10, 'housing back');
  assert.ok(ev.some((e) => e.type === 'chamberActivated' && e.uid === g.uid));
  assert.equal(nest.handlers.demolishChamber.validate(s, d, { type: 'demolishChamber', uid: g.uid }), null, 'usable again');
});

// ------------------------------------------------------------------------------------------------ C256 free tunnels
test('C256: a dragged tunnel digs exactly its cells; it stops at the first cell a tunnel cannot cross, saying why', () => {
  const { s, d } = setup();
  const path = [idx(20, 12), idx(21, 12), idx(22, 12), idx(23, 12), idx(23, 13), idx(23, 14)];
  let r = nest.tunnelPath(s, d, path);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.deepEqual(r.path, path, 'no auto-route: the dragged cells');
  assert.deepEqual(r.soil, path.slice(1), 'the shaft cell is already open');
  assert.equal(run(s, d, { type: 'digTunnel', cells: r.path }), null);
  assert.deepEqual(s.run.nest.queue[0].cells, path.slice(1));
  // a stone in the way: cut there, with the reason
  s.run.nest.cells[idx(23, 13)] = CELL.STONE;
  s.run.nest.queue = [];
  s.run.nest.rev++;
  r = nest.tunnelPath(s, d, path);
  assert.deepEqual(r.path, path.slice(0, 4));
  assert.equal(r.reason, 'blocked:stone');
  assert.equal(r.ok, true, 'the part before the stone can still be dug');
  // a drag that starts away from the open nest is refused (tunnels must connect), not rerouted
  r = nest.tunnelPath(s, d, [idx(5, 30), idx(6, 30)]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid:start');
  // a broken path (not 4-connected) is cut at the gap
  r = nest.tunnelPath(s, d, [idx(20, 12), idx(21, 12), idx(23, 12)]);
  assert.deepEqual(r.path, [idx(20, 12), idx(21, 12)]);
  assert.equal(r.reason, 'invalid:path');
});

// ------------------------------------------------------------------------------------------------ C257 R / Q
test('C257: R relocates the chamber under the cursor first, else the selected one; R with the relocate tool on cancels', () => {
  const sel = { view: 'nest', kind: 'chamber', id: 7 };
  const hover = { view: 'nest', kind: 'nursery', id: 9 };
  assert.deepEqual(chamberHotkey('r', false, sel, { hover, tool: null }), { kind: 'relocate', uid: 9 }, 'the hovered chamber wins');
  assert.deepEqual(chamberHotkey('r', false, sel, { hover: null, tool: null }), { kind: 'relocate', uid: 7 }, 'else the selected one');
  assert.deepEqual(chamberHotkey('r', false, null, { hover, tool: null }), { kind: 'relocate', uid: 9 }, 'no selection needed');
  assert.deepEqual(chamberHotkey('r', false, sel, { hover: { view: 'map', kind: 'chamber', id: 3 } }), { kind: 'relocate', uid: 7 });
  const t = chamberHotkey('R', false, sel, { hover, tool: { kind: 'relocate', uid: 7 } });
  assert.equal(t.kind, 'cancelTool');
  const { s, d } = setup();
  assert.deepEqual(chamberHotkeyAction(s, d, t), { clear: true });
  assert.deepEqual(chamberHotkey('l', false, sel), { kind: 'levelCheapest', uid: 7 }, 'the other hotkeys are unchanged');
});

// ------------------------------------------------------------------------------------------------ C258 blueprints
test('C258: blueprints are kept but not applied at run start without an unlock; the active one can always be cleared', () => {
  const s = newState(11);
  const d = makeDerived();
  s.era.blueprints = [{ name: 'Plan', chambers: [{ type: 'gallery', x: 24, y: 12, w: 3, h: 2, level: 1 }], tunnels: [idx(21, 12), idx(22, 12), idx(23, 12)] }];
  s.era.activeBlueprint = 0;
  assert.equal(nest.blueprintsAllowed(s), false);
  startRun(s, d, { seed: 5, env: fakeEnv() });
  assert.equal(s.run.nest.queue.length, 0, 'nothing queued');
  assert.equal(s.run.nest.bpPending.length, 0, 'nothing planned');
  assert.equal(s.era.blueprints.length, 1, 'the layout is kept');
  assert.equal(nest.applyBlueprint(s, d, { now: true }), 0, 'applyBlueprint refuses too');
  assert.equal(run(s, d, { type: 'loadBlueprint', slot: 0 }), 'locked', 'Use is locked');
  // Clear active blueprint works with or without the unlock
  assert.equal(run(s, d, { type: 'clearBlueprint' }), null);
  assert.equal(s.era.activeBlueprint, -1);
  assert.equal(run(s, d, { type: 'clearBlueprint' }), 'notFound');
  assert.equal(s.era.blueprints.length, 1, 'still saved');
  // with Ancestral Blueprint it applies at run start again
  s.era.activeBlueprint = 0;
  s.cycle.traits.ancestral_blueprint = 1;
  startRun(s, d, { seed: 6, env: fakeEnv() });
  assert.ok(s.run.nest.queue.length > 0 || s.run.nest.bpPending.length > 0, 'applied');
});
