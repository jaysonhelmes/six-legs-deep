// C107 "next level gives", C108 cheapest-level picker and chamber hotkeys (context-dependent R), C109 adjacency links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import * as nest from '../src/systems/nest.js';
import { recompute } from '../src/systems/stats.js';
import { idx } from '../src/systems/nestgeom.js';
import { levelGainText, adjacencyLines, linkText } from '../src/ui/text.js';
import { chamberHotkey, chamberHotkeyAction, cheapestLabel, growthText, groomText } from '../src/ui/panels/build.js';

function setup() {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 1e12, digW: 1e9 } });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.run.unlocked.royal_levelup = true;
  Object.assign(s.run.res, { food: 1e9, soil: 1e9, chitin: 1e6, honeydew: 1e6 });
  nest.derive(s, d);
  return { s, d };
}

function run(s, d, cmd) {
  const h = nest.handlers[cmd.type];
  const r = h.validate(s, d, cmd);
  if (r === null) h.apply(s, d, cmd, fakeEnv());
  return r;
}

function settle(s, d) {
  nest.derive(s, d);
  s.run.nest.digAllow = 1e12; // C252: dig everything queued this step (the dig cap has its own tests)
  nest.tick(s, d, 1, fakeEnv({ dt: 1 }));
  nest.derive(s, d);
  recompute(s, d, fakeEnv()); // d.stats as the real step has them (colony multipliers)
  d.stats.digW = 1e9;
}

function place(s, d, type, x, y) {
  assert.equal(run(s, d, { type: 'placeChamber', chamber: type, x, y }), null, type + ' placed');
  settle(s, d);
  return s.run.nest.chambers[s.run.nest.chambers.length - 1];
}

test('C107: levelGain matches what derive adds for a gallery (loam ×1.1) and a granary (clay ×1.25)', () => {
  const { s, d } = setup();
  run(s, d, { type: 'digTunnel', cells: [idx(21, 12), idx(22, 12), idx(23, 12)] });
  settle(s, d);
  const gal = place(s, d, 'gallery', 24, 12);
  const g = nest.levelGain(s, d, gal.uid);
  assert.equal(g.from, 1);
  assert.equal(g.to, 2);
  const h = g.lines.find((l) => l.stat === 'housing');
  assert.ok(Math.abs(h.from - 11 * 1.1) < 1e-9 && Math.abs(h.to - 22 * 1.1) < 1e-9, JSON.stringify(h));
  const before = d.nest.agg.housingBase;
  assert.equal(run(s, d, { type: 'levelChamber', uid: gal.uid }), null);
  settle(s, d);
  assert.equal(gal.level, 2);
  assert.ok(Math.abs(d.nest.agg.housingBase - before - (h.to - h.from)) < 1e-9, 'derive gained exactly the shown housing');
  assert.equal(levelGainText({ ...h, from: 33, to: 44 }), '+11 housing (33 → 44)');
  // Granary in clay: 400 × 1.25 = 500 → 400 × 1.65 × 1.25 = 825
  run(s, d, { type: 'digTunnel', cells: [idx(20, 22), idx(20, 23), idx(20, 24), idx(20, 25)] });
  settle(s, d);
  const gr = place(s, d, 'granary', 21, 24);
  const c = nest.levelGain(s, d, gr.uid).lines.find((l) => l.stat === 'granaryCap');
  assert.ok(Math.abs(c.from - 500) < 1e-9 && Math.abs(c.to - 825) < 1e-9, JSON.stringify(c));
  assert.equal(c.kind, 'num');
});

test('C107: per-type lines — nursery slots, library insight, midden caps, royal lay, max level', () => {
  const { s, d } = setup();
  const nur = place(s, d, 'nursery', 22, 20);
  const n = nest.levelGain(s, d, nur.uid).lines;
  assert.deepEqual(n.map((l) => [l.stat, l.from, l.to]), [['broodSlots', 3, 6]]);
  assert.equal(levelGainText(n[0]), '+3 brood slots (3 → 6)');
  const royal = nest.levelGain(s, d, 1);
  assert.equal(royal.lines[0].stat, 'lay');
  assert.ok(Math.abs(royal.lines[0].from - 1) < 1e-9 && Math.abs(royal.lines[0].to - 1.15) < 1e-9);
  const mid = place(s, d, 'midden', 10, 20); // C137 / C155: x 13–21 is the queen's reserved room
  const ml = nest.levelGain(s, d, mid.uid).lines;
  const dis = ml.find((l) => l.stat === 'disease');
  assert.equal(dis.sign, -1);
  assert.equal(dis.cap, CHAMBERS.midden.fx.diseaseMax);
  assert.match(levelGainText(dis), /^Disease chance −10% → −20% \(max −80% combined\)$/);
  mid.level = CHAMBERS.midden.maxL;
  assert.equal(nest.levelGain(s, d, mid.uid).max, true);
  assert.equal(nest.levelGain(s, d, 9999), null);
});

test('C107: growthText names the side and the added cells', () => {
  const ch = { x: 10, y: 10, w: 3, h: 2 };
  assert.match(growthText(ch, { grows: true, rect: { x: 10, y: 10, w: 4, h: 2 }, dirs: { left: true, right: true } }), /^Grows one column to the right \(\+2 cells to dig; the buttons pick another side\)/);
  assert.match(growthText(ch, { grows: true, rect: { x: 10, y: 9, w: 3, h: 3 }, dirs: { up: true } }), /^Grows one row upward \(\+3 cells to dig\)/);
  assert.match(growthText(ch, { grows: false }), /stays the same/);
  assert.equal(growthText(ch, { max: true }), '');
});

test('C108: cheapestLevel picks the lowest next cost that can level; busy (and maxed) instances are skipped', () => {
  const { s, d } = setup();
  run(s, d, { type: 'digTunnel', cells: [idx(21, 12), idx(22, 12), idx(23, 12)] });
  settle(s, d);
  const a = place(s, d, 'gallery', 24, 12);
  const b = place(s, d, 'gallery', 24, 16); // C137: clear of a's reserved 8 × 4 room
  a.level = 6; // 10 × 1.3^6 ≈ 48.3 food
  b.level = 3; // 10 × 1.3^3 × 2 ≈ 43.9 food (k = 1)
  let c = nest.cheapestLevel(s, d, 'gallery');
  assert.equal(c.uid, b.uid, 'lowest next cost wins (level and instance index both count)');
  assert.equal(c.count, 2);
  assert.match(cheapestLabel('gallery', c), /^Level cheapest \(L3 Gallery, .+ food\)$/);
  b.status = 'growing';
  c = nest.cheapestLevel(s, d, 'gallery');
  assert.equal(c.uid, a.uid, 'a busy instance is skipped');
  b.status = 'active';
  a.level = 2000; // a MAX cost (past 1e280) is never picked
  assert.equal(nest.cheapestLevel(s, d, 'gallery').uid, b.uid);
  a.level = 6;
  // the command it feeds: levelChamber on the picked uid
  const act = chamberHotkeyAction(s, d, { kind: 'levelCheapest', uid: a.uid });
  assert.deepEqual(act, { cmd: { type: 'levelChamber', args: { uid: b.uid } } });
  assert.equal(nest.cheapestLevel(s, d, 'deep_vault'), null);
  assert.match(cheapestLabel('granary', { level: 2, cost: { food: 50 }, count: 1 }), /^Level up \(L2 → L3, 50(\.0)? food\)$/);
});

test('C108 / C142: hotkeys — L (cheapest) / Shift+L (this one) / G / R with a nest chamber selected; R on a trail is not a chamber key', () => {
  const sel = { view: 'nest', kind: 'chamber', id: 7 };
  assert.deepEqual(chamberHotkey('l', false, sel), { kind: 'levelCheapest', uid: 7 }, 'C142: L levels the cheapest of the type');
  assert.deepEqual(chamberHotkey('L', true, sel), { kind: 'level', uid: 7 }, 'C142: Shift+L levels the selected chamber');
  assert.deepEqual(chamberHotkey('g', false, sel), { kind: 'levelDir', uid: 7 });
  assert.deepEqual(chamberHotkey('R', false, { view: 'nest', kind: 'nursery', id: 3 }), { kind: 'relocate', uid: 3 });
  assert.equal(chamberHotkey('r', false, { view: 'surface', kind: 'trail', id: 5 }), null, 'R with a trail selected stays Rally');
  assert.equal(chamberHotkey('l', false, null), null);
  assert.equal(chamberHotkey('x', false, sel), null);
  const { s, d } = setup();
  assert.deepEqual(chamberHotkeyAction(s, d, { kind: 'relocate', uid: 1 }), { tool: { kind: 'relocate', uid: 1 } });
  assert.deepEqual(chamberHotkeyAction(s, d, { kind: 'level', uid: 1 }), { cmd: { type: 'levelChamber', args: { uid: 1 } } });
  // C137: the Royal Chamber grows into its reserved room: no side to pick; a legacy one (no reservation) still can
  const g = chamberHotkeyAction(s, d, { kind: 'levelDir', uid: 1 });
  assert.match(g.reject, /reserved space/);
  const r1 = s.run.nest.chambers.find((c) => c.uid === 1);
  delete r1.res;
  r1.noRes = true;
  s.run.nest.rev++;
  assert.deepEqual(chamberHotkeyAction(s, d, { kind: 'levelDir', uid: 1 }), { tool: { kind: 'levelDir', uid: 1 } }, 'legacy: G picks its side');
});

test('C108: app.js routes R to Rally for a selected trail before the chamber hotkeys', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const rally = src.indexOf("runAct('rally'");
  const hk = src.indexOf('buildPanel.chamberHotkey(');
  assert.ok(rally > 0 && hk > rally, 'trail Rally is checked first');
});

test('C109: chamberLinks / ghost links / adjacency copy come from the data rules', () => {
  const { s, d } = setup();
  const nur = place(s, d, 'nursery', 22, 20);
  const links = nest.chamberLinks(s, d, nur.uid);
  assert.deepEqual(links.map((l) => [l.rule, l.partner, l.receiver, l.good]), [['adj_nursery_royal', 'royal_chamber', 'self', true]]);
  assert.equal(linkText(links[0]), '+15% brood speed (next to Royal Chamber)');
  assert.ok(nest.chamberLinks(s, d, 1).some((l) => l.rule === 'adj_nursery_royal' && l.receiver === 'partner'));
  // A Midden ghost next to the nursery: the nursery would take the hygiene hit.
  const v = nest.validatePlacement(s, d, 'midden', 25, 20);
  assert.ok(v.links.some((l) => l.rule === 'hyg_midden' && l.uid === nur.uid && !l.good), JSON.stringify(v.links));
  // Relocating the nursery far away loses the Royal link.
  const far = nest.validatePlacement(s, d, 'nursery', 30, 40, { relocateUid: nur.uid });
  assert.ok(far.lost.some((l) => l.rule === 'adj_nursery_royal'), JSON.stringify(far.lost));
  assert.deepEqual(adjacencyLines('fungus_garden'), ['Garden +30% next to a Water Well.', 'Hygiene −20% within 6 path cells of a Midden.']);
  assert.ok(adjacencyLines('royal_chamber').some((t) => /Nursery/.test(t)));
  assert.deepEqual(adjacencyLines('gallery'), []);
});

test('C20: groomText states the real rule (share of brood slots, all brood) and the Claustral Founding block', () => {
  const s = newState();
  const d = makeDerived();
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 3 }, { kind: 'nursery', uid: 5, cap: 9 }];
  assert.match(groomText(s, d, 5), /^Each click adds \+0\.75% development to all brood in the colony \(1% × this nursery's 75% share/);
  s.run.hardship = 'claustral_founding';
  assert.match(groomText(s, d, 5), /Claustral Founding/);
});
