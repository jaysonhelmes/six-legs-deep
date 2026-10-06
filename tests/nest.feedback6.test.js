// C173–C181 (player-approved nest changes, feedback pass 6): hidden water strikes instead of silently blocking (C173),
// blueprint chambers move off water (C174) and announce what they do (C175), blueprint Water Wells (C176), Root Aphid
// Pens and Nuptial Chambers (C177), roots through chambers (C178), the chitin chambers (C179), the blueprint editor and
// Q toggle (C180), and varied stones (C181).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL, GRID } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { ROOT_CULT, STONES, WATER } from '../src/data/soilFeatures.js';
import { GEOM } from '../src/data/strata.js';
import * as nest from '../src/systems/nest.js';
import { generateNest, stoneShape } from '../src/systems/nestgen.js';
import { idx, rectCells, footprint } from '../src/systems/nestgeom.js';
import { placeAnotherAction } from '../src/ui/panels/build.js';
import { createSandbox, checkSpot, placeIn, moveIn, deleteIn, paintTunnels, chamberAtDoc, docFrom } from '../src/ui/blueprintEditor.js';
import { waterStruckText, blueprintAdjustedText, blueprintLockHint, plannedWaitText, eventToast } from '../src/ui/text.js';
import { makeHolder } from '../src/core/rng.js';

const COLS = GRID.cols;

function setup() {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 1e9 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e9, soil: 1e9, chitin: 1e6, honeydew: 1e6, fungus: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

/** Validate + apply one nest command; returns { reason, events }. */
function run(s, d, cmd) {
  const h = nest.handlers[cmd.type];
  const env = fakeEnv();
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  return { reason: r, events: env.events || [] };
}

function settle(s, d, sec = 1) {
  const env = fakeEnv({ dt: sec });
  s.run.time += sec;
  d.stats.digW = 1e9;
  nest.derive(s, d);
  nest.tick(s, d, sec, env);
  nest.derive(s, d);
  return env.events || [];
}

function addChamber(s, type, x, y, w, h, extra = {}) {
  const n = s.run.nest;
  const ch = { uid: n.nextUid++, type, k: 0, x, y, w, h, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0, ...extra };
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

const vp = (s, d, type, x, y, o = {}) => nest.validatePlacement(s, d, type, x, y, o);

// ------------------------------------------------------------------------------------------------ C173 hidden water
test('C173: an unrevealed pocket does not block or show in the ghost; placing on it strikes water and refuses once', () => {
  const { s, d } = setup();
  addPocket(s, 27, 31, 2, 2, false);
  nest.derive(s, d);
  const g = vp(s, d, 'gallery', 26, 30, { anchor: 'tl' });
  assert.equal(g.reason, null, 'the ghost over a hidden pocket is valid (unknown soil)');
  assert.equal(g.obstacles, 0, 'hidden water is not counted');
  const r = run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'tl' });
  assert.equal(r.reason, null, 'the command validates');
  assert.equal(s.run.nest.chambers.filter((c) => c.type === 'gallery').length, 0, 'no chamber this time');
  assert.equal(s.run.nest.features.water[0].revealed, true, 'the pocket shows now');
  const ev = r.events.find((e) => e.type === 'waterStruck');
  assert.ok(ev && ev.chamberType === 'gallery' && ev.pocket === 0);
  assert.match(waterStruckText(ev).text, /You struck water!/);
  assert.match(eventToast(ev).text, /struck water/);
  // the pocket is known now: the spot is refused, a spot beside it works (the water sits in its reserved room)
  assert.equal(vp(s, d, 'gallery', 26, 30, { anchor: 'tl' }).reason, 'blocked:water');
  const ok = vp(s, d, 'gallery', 23, 30, { anchor: 'tl' });
  assert.equal(ok.reason, null);
  assert.equal(ok.obstacles, 4, 'revealed water inside the reserved room is counted');
});

test('C173: a reserved room, a tunnel or a level-up over a hidden pocket strikes it too', () => {
  const { s, d } = setup();
  addPocket(s, 31, 32, 2, 2, false); // inside the 8×4 room of a Gallery at (26, 30), outside its 3×2 L1 room
  nest.derive(s, d);
  const a = run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'tl' });
  assert.ok(a.events.some((e) => e.type === 'waterStruck'));
  assert.equal(s.run.nest.chambers.length, 1);
  const b = run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30, anchor: 'tl' });
  assert.equal(b.reason, null);
  assert.ok(s.run.nest.chambers.some((c) => c.type === 'gallery'), 'placed once the pocket is known');
  // a tunnel dragged from the main shaft into an unknown pocket
  const t = setup();
  addPocket(t.s, 22, 4, 2, 2, false);
  nest.derive(t.s, t.d);
  const cells = [idx(21, 5), idx(22, 5), idx(23, 5)];
  const r = run(t.s, t.d, { type: 'digTunnel', cells });
  assert.equal(r.reason, null);
  assert.ok(r.events.some((e) => e.type === 'waterStruck'));
  assert.equal(t.s.run.nest.queue.length, 0, 'nothing queued this time');
  assert.equal(run(t.s, t.d, { type: 'digTunnel', cells }).reason, 'blocked:water');
});

test('C173 / C174 / C175: a blueprint chamber that strikes hidden water moves next door instead of being dropped', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  addPocket(s, 22, 10, 2, 2, false);
  nest.derive(s, d);
  s.era.blueprints = [{ name: 'B', tunnels: [], chambers: [{ type: 'gallery', x: 21, y: 10, w: 3, h: 2, level: 1 }] }];
  s.era.activeBlueprint = 0;
  nest.applyBlueprint(s, d);
  assert.equal(s.run.nest.features.water[0].revealed, true, 'struck');
  const notes = s.run.nest.bpNotes;
  assert.ok(notes.some((n) => n.ev === 'waterStruck'));
  const adj = notes.find((n) => n.ev === 'blueprintAdjusted');
  assert.ok(adj, 'moved');
  assert.deepEqual(adj.from, { x: 21, y: 10 });
  assert.ok(Math.abs(adj.to.x - 21) + Math.abs(adj.to.y - 10) <= 6, 'nearby');
  assert.match(blueprintAdjustedText(adj).text, /Gallery moved/);
  assert.ok(!notes.some((n) => !n.ev), 'nothing dropped');
  const g = s.run.nest.chambers.find((c) => c.type === 'gallery');
  assert.ok(g && g.blueprint, 'queued at the new spot');
  assert.deepEqual([g.x, g.y], [adj.to.x, adj.to.y]);
  for (const c of rectCells(g.x, g.y, g.w, g.h)) assert.notEqual(s.run.nest.cells[c], CELL.WATER);
  const ev = settle(s, d);
  assert.ok(ev.some((e) => e.type === 'blueprintPlaced' && e.chamberType === 'gallery'));
  assert.ok(ev.some((e) => e.type === 'blueprintAdjusted'));
  assert.ok(!ev.some((e) => e.type === 'blueprintDropped'));
});

test('C174: a pending blueprint spot that water now covers is moved by the re-check, not dropped', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  s.run.nest.bpPending = [{ type: 'nursery', x: 28, y: 40 }];
  addPocket(s, 28, 40, 2, 2, true);
  nest.derive(s, d);
  const ev = settle(s, d, 1.1);
  assert.ok(!ev.some((e) => e.type === 'blueprintDropped'), 'not dropped');
  const adj = ev.find((e) => e.type === 'blueprintAdjusted');
  assert.ok(adj && adj.chamberType === 'nursery' && adj.reason === 'water');
  const spot = s.run.nest.bpPending.find((p) => p.type === 'nursery') || s.run.nest.chambers.find((c) => c.type === 'nursery');
  assert.ok(spot, 'still planned (or queued)');
  assert.notDeepEqual([spot.x, spot.y], [28, 40]);
});

// ------------------------------------------------------------------------------------------------ C176 Water Wells
test('C176: a blueprint Well taking another spot announces it; with Drainage a far pocket is moved next to its saved spot', () => {
  const a = setup();
  a.s.cycle.traits.ancestral_blueprint = 1;
  addPocket(a.s, 14, 46, 2, 2);
  nest.derive(a.s, a.d);
  a.s.era.blueprints = [{ name: 'W', tunnels: [], chambers: [{ type: 'water_well', x: 10, y: 45, w: 2, h: 3, level: 1 }] }];
  a.s.era.activeBlueprint = 0;
  nest.applyBlueprint(a.s, a.d);
  assert.ok(a.s.run.nest.bpNotes.some((n) => n.ev === 'blueprintAdjusted' && n.reason === 'well:moved' && n.chamberType === 'water_well'));

  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  s.run.research.drainage = 1;
  addPocket(s, 32, 52, 2, 2);
  nest.derive(s, d);
  s.era.blueprints = [{ name: 'W', tunnels: [], chambers: [{ type: 'water_well', x: 10, y: 45, w: 2, h: 3, level: 1 }] }];
  s.era.activeBlueprint = 0;
  nest.applyBlueprint(s, d);
  const job = s.run.nest.queue.find((j) => j.kind === 'drain');
  assert.ok(job && job.to && job.bpWell === '10,45', 'a pocket move is queued for it');
  assert.ok(s.run.nest.bpNotes.some((n) => n.ev === 'blueprintAdjusted' && n.reason === 'water:moved'));
  assert.equal(nest.plannedWaits(s, d)[0].code, 'wait:waterMove');
  assert.match(plannedWaitText(nest.plannedWaits(s, d)[0]), /being moved/);
  let well = null;
  for (let k = 0; k < 12 && !well; k++) {
    settle(s, d, 1.1);
    well = s.run.nest.chambers.find((c) => c.type === 'water_well');
  }
  assert.ok(well, 'built once its water arrived');
  assert.deepEqual([well.x, well.y], [10, 45], 'at its saved spot');
});

// ------------------------------------------------------------------------------------------------ C177 pens, nuptial
test('C177: a blueprint Root Aphid Pen with no root grows a paid cultivated root to it (Root Cultivation), else says why', () => {
  const { s, d } = setup();
  s.cycle.traits.ancestral_blueprint = 1;
  s.run.research.root_cultivation = 1;
  s.era.blueprints = [{ name: 'P', tunnels: [], chambers: [{ type: 'root_aphid_pen', x: 4, y: 30, w: 3, h: 2, level: 1 }] }];
  s.era.activeBlueprint = 0;
  const hd0 = s.run.res.honeydew;
  nest.applyBlueprint(s, d);
  const root = s.run.nest.features.roots.find((r) => r.bp === '4,30');
  assert.ok(root && root.own && !root.free, 'a normal cultivated root');
  assert.equal(s.run.res.honeydew, hd0 - ROOT_CULT.cost.honeydew, 'paid at the normal price');
  assert.equal(nest.plannedWaits(s, d)[0].code, 'wait:rootGrow');
  for (let k = 0; k < 20 && root.y1 < root.to; k++) settle(s, d, 1);
  assert.equal(root.y1, root.to);
  settle(s, d, 1.1);
  const w = nest.plannedWaits(s, d)[0];
  assert.ok(!w || !w.code.startsWith('wait:root'), 'no longer waiting for a root');
  // the cultivated-root limit
  const c = setup();
  c.s.cycle.traits.ancestral_blueprint = 1;
  c.s.run.research.root_cultivation = 1;
  for (let k = 0; k < nest.rootCap(c.s); k++) c.s.run.nest.features.roots.push({ col: 30 + k, y0: 1, y1: 3, own: true, to: 3, prog: 0 });
  c.s.era.blueprints = [{ name: 'P', tunnels: [], chambers: [{ type: 'root_aphid_pen', x: 4, y: 30, w: 3, h: 2, level: 1 }] }];
  c.s.era.activeBlueprint = 0;
  nest.applyBlueprint(c.s, c.d);
  assert.equal(nest.plannedWaits(c.s, c.d)[0].code, 'wait:rootCap');
  assert.match(plannedWaitText(nest.plannedWaits(c.s, c.d)[0]), /limit/);
});

test('C177: a Nuptial Chamber with no straight exit shaft gets a routed one (own column, never the main shaft)', () => {
  const { s, d } = setup();
  s.run.unlocked.chamber_nuptial_chamber = true;
  const wall = [];
  for (let x = 0; x < COLS; x++) if (Math.abs(x - 20) >= 3) wall.push(idx(x, 10));
  for (const c of wall) s.run.nest.cells[c] = CELL.STONE;
  s.run.nest.rev++;
  nest.derive(s, d);
  const r = run(s, d, { type: 'placeChamber', chamber: 'nuptial_chamber', x: 18, y: 24 });
  assert.equal(r.reason, null);
  const sh = s.run.nest.shafts.find((x) => x.kind === 'nuptial');
  assert.ok(sh && Math.abs(sh.col - GRID.mainCol) >= GEOM.shaftGap);
  const job = s.run.nest.queue.find((j) => j.kind === 'shaft');
  assert.ok(job.cells.includes(idx(sh.col, 0)), 'reaches the surface');
  assert.ok(!job.cells.some((c) => c % COLS === GRID.mainCol), 'never dug in the main shaft column');
  for (let k = 0; k < 6; k++) settle(s, d, 1);
  assert.ok(s.run.nest.shafts.find((x) => x.kind === 'nuptial').open, 'opens');
});

// ------------------------------------------------------------------------------------------------ C178 roots
test('C178: roots grow down through chambers and count for the touch rule there', () => {
  const { s, d } = setup();
  addChamber(s, 'gallery', 4, 10, 3, 2);
  s.run.nest.features.roots.push({ col: 5, y0: 1, y1: 30 });
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.equal(nest.cellInfo(s, d, idx(5, 10)).root, true, 'root inside the gallery');
  assert.equal(vp(s, d, 'root_aphid_pen', 7, 12).reason, 'invalid:root');
  // a pen beside the gallery touches the root cells inside it
  assert.equal(vp(s, d, 'root_aphid_pen', 5, 12).reason === 'invalid:root', false);
  // natural roots: a requested root column over the Royal Chamber can now hang through it
  let through = false;
  for (let seed = 1; seed <= 40 && !through; seed++) {
    const n = generateNest(seed, { rootCols: [19] });
    const r = n.features.roots.find((x) => x.col === 19);
    if (r && r.y1 >= GRID.royal.y + GRID.royal.h) through = true;
  }
  assert.ok(through, 'some seed grows a root past the Royal Chamber');
});

// ------------------------------------------------------------------------------------------------ C179 chitin chambers
test('C179: Carapace Store and Workshop feed d.nest.agg.chitinCapBase / chitinBoost / chitinRecycle', () => {
  const { s, d } = setup();
  addChamber(s, 'carapace_store', 4, 12, 2, 2, { level: 1 });
  addChamber(s, 'carapace_store', 8, 12, 3, 2, { level: 2 });
  addChamber(s, 'carapace_workshop', 14, 12, 5, 2, { level: 3 });
  nest.derive(s, d);
  const a = d.nest.agg;
  const fx = CHAMBERS.carapace_store.fx;
  assert.ok(Math.abs(a.chitinCapBase - (fx.chitinCap + fx.chitinCap * fx.capGrowth)) < 1e-9);
  assert.ok(Math.abs(a.chitinBoost - 3 * CHAMBERS.carapace_workshop.fx.chitinBoost) < 1e-9);
  assert.ok(Math.abs(a.chitinRecycle - 3 * CHAMBERS.carapace_workshop.fx.recycle) < 1e-9);
  s.run.nest.chambers[s.run.nest.chambers.length - 1].level = 14;
  nest.derive(s, d);
  assert.equal(d.nest.agg.chitinBoost, CHAMBERS.carapace_workshop.fx.boostMax, 'capped');
  const g = nest.levelGain(s, d, s.run.nest.chambers[1].uid);
  assert.ok(g.lines.some((l) => l.stat === 'chitinCap' && l.to > l.from));
  // placeable with the usual rules (the Workshop pays chitin too)
  assert.equal(vp(s, d, 'carapace_workshop', 26, 14).reason, 'max', 'one Workshop');
  const f2 = setup();
  assert.equal(vp(f2.s, f2.d, 'carapace_workshop', 26, 14).reason, null);
  assert.deepEqual(CHAMBERS.carapace_workshop.place, { food: 3000, chitin: 30 });
});

// ------------------------------------------------------------------------------------------------ C180 Q and editor
test('C180: Q clears an active placement tool of the same type (or with no chamber under the cursor)', () => {
  const { s, d } = setup();
  const g = addChamber(s, 'gallery', 26, 12, 3, 2);
  nest.derive(s, d);
  const ref = { view: 'nest', kind: 'chamber', id: g.uid };
  assert.deepEqual(placeAnotherAction(s, d, ref, null), { tool: { kind: 'placeChamber', chamber: 'gallery' } });
  assert.deepEqual(placeAnotherAction(s, d, ref, { kind: 'placeChamber', chamber: 'gallery' }), { clear: true });
  assert.deepEqual(placeAnotherAction(s, d, null, { kind: 'placeChamber', chamber: 'nursery' }), { clear: true });
  assert.deepEqual(placeAnotherAction(s, d, ref, { kind: 'placeChamber', chamber: 'nursery' }), { tool: { kind: 'placeChamber', chamber: 'gallery' } });
});

test('C180: the blueprint editor works on a sandbox (the live nest never changes) and saves through editBlueprint', () => {
  const { s, d } = setup();
  s.era.federation.blueprint_memory = 1;
  s.era.blueprints = [{ name: 'Plan', tunnels: [idx(21, 5)], chambers: [{ type: 'gallery', x: 26, y: 12, w: 3, h: 2, level: 1, res: { x: 26, y: 12, w: 8, h: 4 } }] }];
  const before = JSON.stringify(s);
  let doc = docFrom(s.era.blueprints[0]);
  assert.equal(chamberAtDoc(doc, 27, 13), 0);
  assert.equal(chamberAtDoc(doc, GRID.royal.x, GRID.royal.y), 'royal');
  // the sandbox: the blueprint's chambers, its reservations and tunnels, plain soil
  const sb = createSandbox(s, doc);
  assert.notEqual(sb.s.run.nest, s.run.nest);
  assert.equal(sb.s.run.nest.cells[idx(27, 12)], CELL.CHAMBER);
  assert.equal(sb.s.run.nest.cells[idx(21, 5)], CELL.TUNNEL);
  // rules: inside another chamber's reservation is refused; a Well anywhere free is fine (it finds water each run)
  assert.equal(checkSpot(s, doc, 'nursery', 30, 13).ok, false);
  assert.equal(checkSpot(s, doc, 'water_well', 4, 50).ok, true);
  assert.equal(checkSpot(s, doc, 'root_aphid_pen', 4, 30).ok, true, 'roots are grown per run');
  assert.equal(checkSpot(s, doc, 'deep_vault', 4, 30).reason, 'invalid:row');
  let r = placeIn(s, doc, 'nursery', 10, 30, 'tl');
  assert.equal(r.reason, null);
  doc = r.doc;
  assert.equal(doc.chambers.length, 2);
  assert.deepEqual(doc.chambers[1].res, { x: 10, y: 30, w: footprint('nursery', 8).w, h: footprint('nursery', 8).h });
  r = moveIn(s, doc, 0, 26, 40);
  assert.equal(r.reason, null);
  doc = r.doc;
  assert.deepEqual([doc.chambers[0].x, doc.chambers[0].y], [26, 40]);
  assert.equal(moveIn(s, doc, 0, 10, 30).reason !== null, true, 'not onto the nursery');
  r = moveIn(s, doc, 'royal', 10, 60);
  assert.equal(r.reason, null);
  doc = r.doc;
  assert.deepEqual([doc.royal.x, doc.royal.y], [10, 60]);
  doc = paintTunnels(s, doc, [idx(5, 5), idx(6, 5), idx(27, 41)], true);
  assert.ok(doc.tunnels.includes(idx(5, 5)) && !doc.tunnels.includes(idx(27, 41)), 'not inside a chamber');
  doc = paintTunnels(s, doc, [idx(5, 5)], false);
  assert.ok(!doc.tunnels.includes(idx(5, 5)));
  doc = deleteIn(doc, 1);
  assert.equal(doc.chambers.length, 1);
  assert.equal(JSON.stringify(s), before, 'the live state is untouched by editing');
  // saving needs the Architect's Table
  assert.equal(run(s, d, { type: 'editBlueprint', slot: 0, blueprint: doc }).reason, 'locked');
  s.era.federation.architects_table = 1;
  assert.equal(run(s, d, { type: 'editBlueprint', slot: 0, blueprint: { chambers: [{ type: 'nope', x: 1, y: 1 }] } }).reason, 'invalid');
  assert.equal(run(s, d, { type: 'editBlueprint', slot: 3, blueprint: doc }).reason, 'notFound');
  assert.equal(run(s, d, { type: 'editBlueprint', slot: 0, blueprint: { ...doc, name: 'Edited' } }).reason, null);
  const saved = s.era.blueprints[0];
  assert.equal(saved.name, 'Edited');
  assert.deepEqual(saved.chambers.map((c) => [c.type, c.x, c.y]), [['gallery', 26, 40]]);
  assert.deepEqual(saved.royal, { x: 10, y: 60, res: doc.royal.res });
  assert.ok(saved.tunnels.includes(idx(6, 5)));
  assert.equal(s.run.nest.chambers.length, 1, 'still only the Royal Chamber in the colony');
});

test('C180: the Blueprints lock hint when layouts are saved but nothing can save new ones', () => {
  const { s } = setup();
  assert.equal(blueprintLockHint(s), '');
  s.era.blueprints = [{ name: 'Old', tunnels: [], chambers: [] }];
  assert.equal(blueprintLockHint(s), 'Blueprint saving needs Ancestral Blueprint (Bloodline) or Blueprint Library (Federation). Your saved layouts are kept.');
  s.cycle.traits.ancestral_blueprint = 1;
  assert.equal(blueprintLockHint(s), '');
});

// ------------------------------------------------------------------------------------------------ C181 stones
test('C181: stones come in varied shapes, deterministic per seed, never in the Royal growth zone', () => {
  const a = generateNest(4242);
  const b = generateNest(4242);
  assert.deepEqual(a.cells, b.cells, 'deterministic');
  const sizes = new Set();
  let irregular = 0;
  const r0 = GRID.royal;
  const fp = footprint('royal_chamber', GEOM.footprintMaxL);
  const sx = fp.w - r0.w;
  for (let seed = 1; seed <= 40; seed++) {
    const n = generateNest(seed * 101);
    const seen = new Uint8Array(n.cells.length);
    for (let i = 0; i < n.cells.length; i++) {
      if (n.cells[i] !== CELL.STONE || seen[i]) continue;
      const g = [];
      const st = [i];
      seen[i] = 1;
      while (st.length) {
        const c = st.pop();
        g.push(c);
        for (const k of [c - 1, c + 1, c - COLS, c + COLS, c - COLS - 1, c - COLS + 1, c + COLS - 1, c + COLS + 1]) {
          if (k < 0 || k >= n.cells.length || seen[k] || n.cells[k] !== CELL.STONE) continue;
          if (Math.abs((k % COLS) - (c % COLS)) > 1) continue;
          seen[k] = 1;
          st.push(k);
        }
      }
      sizes.add(g.length);
      const xs = g.map((c) => c % COLS);
      const ys = g.map((c) => Math.floor(c / COLS));
      const area = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
      if (area !== g.length) irregular++;
    }
    // the Royal growth zone (C66 / C155) holds no stone and no water
    for (let y = r0.y; y < r0.y + Math.max(fp.h, r0.h); y++) {
      for (let x = Math.max(0, r0.x - sx); x < Math.min(COLS, r0.x + r0.w + sx); x++) {
        assert.ok(n.cells[idx(x, y)] !== CELL.STONE && n.cells[idx(x, y)] !== CELL.WATER, 'seed ' + seed);
      }
    }
  }
  assert.ok(sizes.has(1) && sizes.has(2), 'pebbles and bars');
  assert.ok([...sizes].some((n) => n >= 5), 'big lumps');
  assert.ok(irregular > 0, 'L-shapes and blobs');
  // the shape helper alone: offsets start at 0, 0 and stay connected
  const hs = makeHolder(7);
  for (let k = 0; k < 50; k++) {
    const sh = stoneShape(hs, Object.keys(STONES.shapes).map((id) => ({ id, w: STONES.shapes[id] })));
    assert.equal(Math.min(...sh.map((p) => p[0])), 0);
    assert.equal(Math.min(...sh.map((p) => p[1])), 0);
    assert.ok(sh.length >= 1 && sh.length <= Math.max(STONES.blobMax, STONES.size * STONES.size));
  }
  assert.ok(WATER.min >= 2);
});
