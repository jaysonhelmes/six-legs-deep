// Player-reported nest fixes (ARCHITECTURE §18 C97–C99): one-direction growth per level-up (and the exact cells a
// direction adds), the painted Backfill preview, placement-rule copy and the numbered depth refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL } from '../src/data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import * as nest from '../src/systems/nest.js';
import { idx, rectCells, footprint } from '../src/systems/nestgeom.js';
import { placementRuleLines, CHAMBER_TIPS } from '../src/ui/text.js';
import { ghostRefusal } from '../src/render/nestRenderer.js';

function setup({ digW = 0 } = {}) {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e9, soil: 1e9, chitin: 1e6, honeydew: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd, env = fakeEnv()) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, env);
  return r;
}

function stepNest(s, d, dt = 1) {
  const env = fakeEnv({ dt });
  nest.derive(s, d);
  nest.tick(s, d, dt, env);
  return env.events;
}

/** Bounding rectangle of a cell list. */
function bbox(list) {
  const xs = list.map((c) => c % 40);
  const ys = list.map((c) => Math.floor(c / 40));
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

test('C97: a Gallery levelled L1 → L8 with no direction adds exactly one row or one column each time', () => {
  const { s, d } = setup({ digW: 1e6 });
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30 }), null);
  stepNest(s, d, 5);
  const ch = s.run.nest.chambers.find((c) => c.type === 'gallery');
  assert.equal(ch.status, 'active');
  for (let L = 1; L < 8; L++) {
    const before = { x: ch.x, y: ch.y, w: ch.w, h: ch.h };
    assert.equal(run(s, d, { type: 'levelChamber', uid: ch.uid }), null, 'level ' + L);
    const job = s.run.nest.queue.at(-1);
    assert.equal(job.kind, 'grow');
    const dw = ch.w - before.w;
    const dh = ch.h - before.h;
    assert.equal(dw + dh, 1, `L${L}→L${L + 1}: one row or column (dw ${dw}, dh ${dh})`);
    // The new cells form one straight strip on one side, never an L-shape around a corner.
    const b = bbox(job.cells);
    if (dw) assert.equal(b.x0, b.x1, 'one column');
    else assert.equal(b.y0, b.y1, 'one row');
    assert.equal(job.cells.length, dw ? ch.h : ch.w);
    assert.deepEqual(job.from, before, 'the job remembers the footprint it grew from');
    stepNest(s, d, 5);
    assert.equal(ch.level, L + 1);
    assert.deepEqual({ w: ch.w, h: ch.h }, footprint('gallery', L + 1));
  }
});

test('C97: levelInfo.dirRects shows the exact rectangle of each offered direction; cancelling a growth restores it', () => {
  const { s, d } = setup({ digW: 1e6 });
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 30 }), null);
  stepNest(s, d, 5);
  const ch = s.run.nest.chambers.find((c) => c.type === 'gallery');
  const info = nest.levelInfo(s, d, ch.uid);
  assert.equal(info.dirs.up, false);
  assert.equal(info.dirRects.up, null);
  assert.deepEqual(info.dirRects.left, { x: 25, y: 30, w: 4, h: 2 });
  assert.deepEqual(info.dirRects.right, { x: 26, y: 30, w: 4, h: 2 });
  d.stats.digW = 0;
  assert.equal(run(s, d, { type: 'levelChamber', uid: ch.uid, dir: 'left' }), null);
  assert.deepEqual([ch.x, ch.w], [25, 4]);
  const job = s.run.nest.queue.at(-1);
  assert.equal(run(s, d, { type: 'cancelJob', uid: job.uid }), null);
  assert.deepEqual([ch.x, ch.y, ch.w, ch.h, ch.status], [26, 30, 3, 2, 'active']);
  assert.equal(s.run.nest.cells[idx(25, 30)], CELL.SOIL, 'the undug growth column stays soil');
});

test('C98: backfillPreview keeps the cells a chamber needs, flags shafts, skips soil, lists pending cells', () => {
  const { s, d } = setup({ digW: 1000 });
  // Tunnel from the shaft east along row 10 to a gallery at x 25, plus a dead-end stub up from (22,10).
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(21, 10), idx(22, 10), idx(23, 10), idx(24, 10)] }), null);
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(22, 9), idx(22, 8)] }), null);
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 25, y: 10 }), null);
  stepNest(s, d, 1);
  // A rough box over everything from the shaft to the gallery (soil, shaft, corridor, stub, chamber cells).
  const box = [];
  for (let y = 7; y <= 11; y++) for (let x = 20; x <= 26; x++) box.push(idx(x, y));
  const pv = nest.backfillPreview(s, d, box);
  assert.deepEqual(new Set(pv.ok), new Set([idx(22, 8), idx(22, 9)]), 'the dead-end stub can go');
  const bad = new Map(pv.bad.map((b) => [b.i, b.reason]));
  for (const x of [21, 22, 23, 24]) assert.equal(bad.get(idx(x, 10)), 'blocked:disconnect', 'corridor cell ' + x);
  for (let y = 7; y <= 11; y++) assert.equal(bad.get(idx(20, y)), 'blocked:shaft');
  assert.equal(pv.pending.length, 0);
  // The ok list is a valid backfill command as it is (the tool sends exactly that).
  assert.equal(run(s, d, { type: 'backfill', cells: pv.ok }), null);
  const pv2 = nest.backfillPreview(s, d, box);
  assert.deepEqual(new Set(pv2.pending), new Set([idx(22, 8), idx(22, 9)]));
  assert.equal(pv2.ok.length, 0);
  // Garbage in: ignored, never throws.
  assert.deepEqual(nest.backfillPreview(s, d, [-1, 1e9, 'x', null]), { ok: [], bad: [], pending: [] });
  assert.deepEqual(nest.backfillPreview(s, d, null), { ok: [], bad: [], pending: [] });
});

test('C98: a loop of tunnels can be thinned: the preview keeps one connection and fills the rest', () => {
  const { s, d } = setup({ digW: 1000 });
  // Two parallel routes from the shaft to a gallery at x 26, rows 10 and 12 (joined by column 25).
  const route = (y) => [21, 22, 23, 24, 25].map((x) => idx(x, y));
  assert.equal(run(s, d, { type: 'digTunnel', cells: route(10) }), null);
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'digTunnel', cells: route(12) }), null);
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'digTunnel', cells: [idx(25, 11)] }), null);
  stepNest(s, d, 1);
  assert.equal(run(s, d, { type: 'placeChamber', chamber: 'gallery', x: 26, y: 10 }), null);
  stepNest(s, d, 2);
  assert.equal(s.run.nest.chambers.find((c) => c.type === 'gallery').status, 'active');
  // Painting the whole lower route fills it: the upper one still connects the gallery.
  const pv = nest.backfillPreview(s, d, route(12));
  assert.deepEqual(new Set(pv.ok), new Set(route(12)));
  assert.equal(pv.bad.length, 0);
  // Painting both routes keeps one connection open and flags it.
  const both = nest.backfillPreview(s, d, [...route(10), ...route(12), idx(25, 11)]);
  assert.ok(both.ok.length > 0 && both.bad.length > 0);
  assert.ok(both.bad.every((b) => b.reason === 'blocked:disconnect'));
  assert.equal(run(s, d, { type: 'backfill', cells: both.ok }), null, 'what the preview keeps is accepted');
});

test('C99: placement rules are spelled out for every chamber with one (Nuptial Chamber: depth 24 + own shaft)', () => {
  assert.deepEqual(placementRuleLines('nuptial_chamber'), ['Depth 24 or deeper (clay).', 'Needs its own exit shaft to the surface (queued with it).']);
  assert.deepEqual(placementRuleLines('fungus_garden'), ['Depth 24 or deeper (clay).']);
  assert.deepEqual(placementRuleLines('hibernaculum'), ['Depth 30 or deeper (clay).']);
  assert.deepEqual(placementRuleLines('deep_vault'), ['Depth 58 or deeper (bedrock).']);
  assert.deepEqual(placementRuleLines('gate'), ['Rows 0–6 only.', 'Must sit beside an entrance shaft.']);
  assert.deepEqual(placementRuleLines('thermal_chimney'), ['Must touch the surface (row 0).']);
  assert.deepEqual(placementRuleLines('root_aphid_pen'), ['Must touch a root.']);
  assert.deepEqual(placementRuleLines('water_well'), ['Must touch a revealed water pocket.']);
  assert.deepEqual(placementRuleLines('gallery'), []);
  assert.deepEqual(placementRuleLines('nope'), []);
  // Effective rows win (a species can move the Fungus Garden up).
  assert.deepEqual(placementRuleLines('fungus_garden', { min: 10, max: 79 }), ['Depth 10 or deeper (loam).']);
  // Every chamber with a data rule or a depth limit gets a line.
  for (const id of CHAMBER_ORDER) {
    const def = CHAMBERS[id];
    if (id === 'royal_chamber') continue;
    if (def.rule || def.rowMin > 1 || def.rowMax < 79) assert.ok(placementRuleLines(id).length > 0, id);
  }
  assert.ok(CHAMBER_TIPS.gallery.includes(String(CHAMBERS.gallery.fx.housing)), 'gallery tip quotes the data housing');
});

test('C99: the ghost refusal names the depth rule with numbers', () => {
  const { s, d } = setup();
  const v = nest.validatePlacement(s, d, 'nuptial_chamber', 2, 17);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'invalid:row');
  assert.deepEqual(v.rows, { min: 24, max: 79 });
  assert.deepEqual(nest.placementRows(s, d, 'nuptial_chamber'), { min: 24, max: 79 });
  assert.equal(ghostRefusal(v), 'Must be at depth 24 or deeper (you are at 17)');
  const g = nest.validatePlacement(s, d, 'gate', 21, 9);
  assert.equal(g.reason, 'invalid:row');
  assert.equal(ghostRefusal(g), 'Must stay within rows 0–6 (you reach 10)');
  assert.equal(ghostRefusal({ reason: 'invalid:root' }), 'Must touch a root');
  assert.equal(ghostRefusal({ reason: 'cantAfford' }), "Can't afford");
  assert.equal(ghostRefusal(null), '');
});
