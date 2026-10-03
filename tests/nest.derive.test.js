// WP3 nest.derive tests: geometry caches gated on rev, haul h (DESIGN §7.8 example), raid reach 15, frost exposure and
// chamber eff (§17.3, ARCHITECTURE §8.2), every d.nest.agg field (§5), adjacency/hygiene, hints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived } from './helpers.js';
import { CELL } from '../src/data/balance.js';
import { addEffect } from '../src/core/effects.js';
import * as nest from '../src/systems/nest.js';
import { idx, rectCells } from '../src/systems/nestgeom.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

function setCells(s, list, code) {
  for (const c of list) s.run.nest.cells[c] = code;
  s.run.nest.rev++;
}

function addChamber(s, type, x, y, w, h, { level = 1, status = 'active' } = {}) {
  const n = s.run.nest;
  const ch = { uid: n.nextUid++, type, k: n.chambers.filter((c) => c.type === type).length, x, y, w, h, level, target: level,
    status, blueprint: false, bornAt: 0 };
  n.chambers.push(ch);
  if (status !== 'digging') setCells(s, rectCells(x, y, w, h), CELL.CHAMBER);
  else n.rev++;
  return ch;
}

function tunnel(s, x0, y0, x1, y1) {
  const list = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) list.push(idx(x, y));
  setCells(s, list, CELL.TUNNEL);
}

function info(d, uid) {
  return d.nest.chambers.find((c) => c.uid === uid);
}

test('skeleton derive reproduces the §5 neutral agg (housing 10, royal slots 3, haul 0.83)', () => {
  const s = newState();
  const d = makeDerived();
  nest.derive(s, d);
  const a = d.nest.agg;
  assert.equal(a.housingBase, 10);
  assert.deepEqual(a.broodGroups, [{ kind: 'royal', uid: 1, cap: 3, factor: 1, exposed: false, snap: false, inReach: false }]);
  assert.ok(near(a.haulH, 150 * 20 / 150 / 24));
  assert.equal(a.haulH.toFixed(2), '0.83');
  assert.deepEqual(a.royal, [1]);
  assert.equal(a.royalL, 1);
  assert.equal(a.chambersActive, 1);
  assert.equal(d.nest.rev, s.run.nest.rev);
  assert.equal(d.nest.dist[idx(20, 20)], 20);
  assert.equal(d.nest.entDist[idx(20, 0)], 0);
  assert.equal(d.nest.chamberAt[idx(18, 20)], 0);
  assert.equal(d.nest.open[idx(20, 10)], 1);
  assert.equal(d.nest.open[idx(5, 10)], 0);
  assert.deepEqual(d.nest.queueInfo, []);
  assert.equal(d.nest.digFace, -1);
  const c = d.nest.chambers[0];
  assert.equal(c.layer, 'loam');
  assert.equal(c.minEntPath, 20);
  assert.equal(c.cellsDug, 8);
  assert.equal(c.cellsTotal, 8);
});

test('haul example (DESIGN §7.8): a capacity-330 granary at path 8 gives h = 0.49', () => {
  const s = newState();
  s.run.research.ventilation_shafts = 1; // 300 × 1.10 = 330
  const d = makeDerived();
  const g = addChamber(s, 'granary', 21, 7, 2, 2); // cell (21,7) is next to shaft cell (20,7) at dist 7 → path 8
  nest.derive(s, d);
  assert.equal(info(d, g.uid).minDist, 8);
  assert.ok(near(d.nest.agg.granaryCap, 330));
  const h = (150 * 20 + 330 * 8) / 480 / 24;
  assert.ok(near(d.nest.agg.haulH, h));
  assert.equal(d.nest.agg.haulH.toFixed(2), '0.49');
});

test('raid reach: a granary or nursery with any cell within 15 path cells of an entrance', () => {
  const s = newState();
  const d = makeDerived();
  const g14 = addChamber(s, 'granary', 21, 14, 2, 2); // (21,14): entDist 15
  const n15 = addChamber(s, 'nursery', 17, 15, 3, 2); // (19,15): entDist 16
  nest.derive(s, d);
  assert.equal(info(d, g14.uid).minEntPath, 15);
  assert.equal(info(d, g14.uid).inReach, true);
  assert.equal(info(d, n15.uid).minEntPath, 16);
  assert.equal(info(d, n15.uid).inReach, false);
  const groups = d.nest.agg.broodGroups;
  assert.equal(groups.find((x) => x.uid === n15.uid).inReach, false);
  // reachStorageShare: the in-reach granary's share of 150 + granaryCap
  assert.ok(near(d.nest.agg.reachStorageShare, 300 / 450));
  assert.equal(d.nest.agg.nearestGranaryUid, g14.uid);
});

test('frost exposure by majority rule halves eff (not frost-immune chambers); snap rows flag but do not halve', () => {
  const s = newState();
  const d = makeDerived({ season: { id: 'winter', frostRow: 12 } });
  const gal = addChamber(s, 'gallery', 21, 10, 3, 2);  // rows 10–11 above 12 → exposed
  const gal2 = addChamber(s, 'gallery', 21, 11, 3, 2); // rows 11–12: 1 of 2 → not exposed
  const gate = addChamber(s, 'gate', 18, 2, 2, 2);     // frost-immune
  nest.derive(s, d);
  assert.equal(info(d, gal.uid).exposed, true);
  assert.equal(info(d, gal.uid).eff, 0.5);
  assert.equal(info(d, gal2.uid).exposed, false);
  assert.equal(info(d, gal2.uid).eff, 1);
  assert.equal(info(d, gate.uid).exposed, false);
  assert.equal(info(d, gate.uid).eff, 1);
  assert.equal(info(d, 1).exposed, false);
  // housing: 10 + 10 × 1.1 (loam) × 0.5 + 10 × 1.1 × 1
  assert.ok(near(d.nest.agg.housingBase, 10 + 11 * 0.5 + 11));
  // Frost snap: flags snap, eff unchanged
  d.season.frostRow = 0;
  d.season.snapRow = 4;
  const nur = addChamber(s, 'nursery', 21, 2, 3, 2);
  nest.derive(s, d);
  assert.equal(info(d, nur.uid).snap, true);
  assert.equal(info(d, nur.uid).exposed, false);
  assert.ok(info(d, nur.uid).eff > 0.9);
  assert.equal(d.nest.agg.broodGroups.find((x) => x.uid === nur.uid).snap, true);
});

test('eff: ventilation ×1.10, aquifer ×1.2, chamber / chamber_layer effects, hygiene ×0.8', () => {
  const s = newState();
  s.run.research.ventilation_shafts = 1;
  const d = makeDerived();
  const g = addChamber(s, 'gallery', 21, 5, 3, 2);
  const deep = addChamber(s, 'granary', 5, 75, 2, 2);
  addEffect(s, { id: 'mold:' + g.uid, stat: 'chamber', scope: g.uid, mult: 0.5, t: -1 });
  addEffect(s, { id: 'rain', stat: 'chamber_layer', scope: 'topsoil', mult: 0.5, t: 30 });
  nest.derive(s, d);
  assert.ok(near(info(d, g.uid).eff, 1.1 * 0.5 * 0.5));
  assert.equal(info(d, deep.uid).layer, 'aquifer');
  assert.ok(near(info(d, deep.uid).eff, 1.1 * 1.2));
  assert.ok(near(d.nest.agg.granaryCap, 300 * 1.75 * 1.1 * 1.2));
  // Hygiene: a contributing midden within 6 path cells of a nursery
  const s2 = newState();
  const d2 = makeDerived();
  const nur = addChamber(s2, 'nursery', 22, 20, 3, 2);
  tunnel(s2, 25, 21, 28, 21);
  const mid = addChamber(s2, 'midden', 29, 20, 2, 2);
  nest.derive(s2, d2);
  assert.equal(info(d2, nur.uid).hygiene, true);
  assert.ok(near(info(d2, nur.uid).eff, 0.8));
  assert.ok(near(d2.nest.agg.middenL, 1));
  // A digging midden causes no hygiene penalty
  mid.status = 'digging';
  s2.run.nest.rev++;
  nest.derive(s2, d2);
  assert.equal(info(d2, nur.uid).hygiene, false);
  assert.equal(d2.nest.agg.middenL, 0);
});

test('nursery brood groups: cap 3 × L, factor (1 + royal adjacency + microclimate) × eff; hib groups shelter 10 × L × eff', () => {
  const s = newState();
  const d = makeDerived({ season: { id: 'spring' } });
  const adjN = addChamber(s, 'nursery', 22, 20, 3, 2, { level: 2 });   // touches the Royal Chamber, loam
  const top = addChamber(s, 'nursery', 21, 3, 3, 2);                  // topsoil, spring +0.15
  const hib = addChamber(s, 'hibernaculum', 5, 31, 4, 2, { level: 3 });
  nest.derive(s, d);
  const g = (uid) => d.nest.agg.broodGroups.find((x) => x.uid === uid);
  assert.equal(g(adjN.uid).kind, 'nursery');
  assert.equal(g(adjN.uid).cap, 6);
  assert.ok(near(g(adjN.uid).factor, 1.15));
  assert.ok(near(g(top.uid).factor, 1.15));
  assert.equal(g(hib.uid).kind, 'hib');
  assert.equal(g(hib.uid).cap, 30);
  assert.equal(g(hib.uid).factor, 1);
  assert.equal(g(hib.uid).exposed, false);
  assert.equal(d.nest.agg.hibCap, 30);
  assert.equal(d.nest.agg.hibL, 3);
  assert.equal(d.nest.agg.adjNurseryRoyal, true);
  assert.equal(d.nest.agg.broodGroups[0].kind, 'royal');
  // Summer: topsoil −0.15 (overheat) unless thermoregulation / shuttling / sunny slope; sunny slope +0.15 in autumn
  d.season.id = 'summer';
  nest.derive(s, d);
  assert.ok(near(g(top.uid).factor, 0.85));
  s.run.research.thermoregulation = 1;
  nest.derive(s, d);
  assert.ok(near(g(top.uid).factor, 1));
  delete s.run.research.thermoregulation;
  s.run.landingTags = ['site_sunny_slope'];
  d.season.id = 'autumn';
  nest.derive(s, d);
  assert.ok(near(g(top.uid).factor, 1.15));
  // Gravel nursery +0.10 in winter
  const s2 = newState();
  const d2 = makeDerived({ season: { id: 'winter', frostRow: 0 } });
  const gr = addChamber(s2, 'nursery', 5, 45, 3, 2);
  nest.derive(s2, d2);
  assert.ok(near(d2.nest.agg.broodGroups.find((x) => x.uid === gr.uid).factor, 1.1));
});

test('digging / relocating chambers contribute nothing; growing ones at their current level', () => {
  const s = newState();
  const d = makeDerived();
  addChamber(s, 'gallery', 21, 10, 3, 2, { status: 'digging', level: 0 });
  const grow = addChamber(s, 'gallery', 25, 10, 4, 2, { status: 'growing', level: 2 });
  grow.target = 3;
  addChamber(s, 'barracks', 5, 30, 3, 2, { status: 'relocating', level: 2 });
  nest.derive(s, d);
  assert.ok(near(d.nest.agg.housingBase, 10 + 20 * 1.1));
  assert.equal(d.nest.agg.berthsBase, 0);
  assert.equal(d.nest.agg.chambersActive, 2);
});

test('agg fields: granary layer modifiers and clay share, library insight, barracks, pens, gardens, repletion, wells', () => {
  const s = newState();
  const d = makeDerived();
  const clay = addChamber(s, 'granary', 5, 30, 2, 2, { level: 2 });  // 300 × 1.65 × 1.25
  const grav = addChamber(s, 'granary', 10, 45, 2, 2);               // 300 × 1.5
  nest.derive(s, d);
  const clayCap = 300 * 1.65 * 1.25;
  assert.ok(near(d.nest.agg.granaryCap, clayCap + 450));
  assert.ok(near(d.nest.agg.clayFoodShare, clayCap / (150 + clayCap + 450)));
  s.run.research.ventilation_shafts = 1;
  nest.derive(s, d);
  assert.equal(d.nest.agg.clayFoodShare, 0, 'ventilation stops clay spoilage');
  delete s.run.research.ventilation_shafts;
  void clay;
  void grav;

  const s2 = newState();
  const d2 = makeDerived();
  const lib = addChamber(s2, 'scent_library', 22, 20, 3, 2, { level: 2 }); // adjacent to royal, loam
  const lib2 = addChamber(s2, 'scent_library', 5, 45, 3, 2);              // gravel
  const bar = addChamber(s2, 'barracks', 21, 5, 3, 2, { level: 2 });      // next to the shaft: entDist 6
  const pen = addChamber(s2, 'root_aphid_pen', 25, 5, 3, 2, { level: 3 });
  const gar = addChamber(s2, 'fungus_garden', 5, 30, 3, 3, { level: 2 }); // clay
  const well = addChamber(s2, 'water_well', 8, 30, 2, 3);                 // touches the garden
  const rep = addChamber(s2, 'repletion_hall', 30, 50, 3, 2, { level: 2 });
  const chim = addChamber(s2, 'thermal_chimney', 30, 0, 2, 4, { level: 3 });
  const vault = addChamber(s2, 'deep_vault', 30, 60, 4, 3, { level: 2 });
  nest.derive(s2, d2);
  const a = d2.nest.agg;
  assert.ok(near(a.libraryInsight, 0.05 * 2 * 1.10 + 0.05 * 1 * 1.25));
  assert.ok(near(a.barracksL, 2));
  assert.ok(near(a.berthsBase, 16));
  assert.equal(a.barracksNear, true);
  assert.ok(near(a.rootPenL, 3));
  assert.equal(a.rootPenCount, 1);
  assert.equal(a.gardenL, 2);
  assert.equal(a.gardenerSlots, 10);
  assert.equal(a.leafCap, 1000);
  assert.equal(a.fungusCap, 2000);
  assert.ok(near(a.fungusMod, 1.5 * 1.3));
  assert.equal(a.wells, 1);
  assert.ok(near(a.repleteBerthsBase, 10));
  assert.ok(near(a.chimneyL, 3));
  assert.ok(near(a.deepVaultL, 2));
  assert.equal(a.chambersActive, 10);
  addChamber(s2, 'water_well', 12, 75, 2, 3);
  nest.derive(s2, d2);
  assert.equal(d2.nest.agg.wells, 3, 'a Water Well in the aquifer counts double');
  void lib; void lib2; void bar; void pen; void gar; void well; void rep; void chim; void vault;
});

test('nuptial chamber: active only with an open nuptial shaft; alate cells 10 + 5 × (L − 1), max 25 (50 royal_court)', () => {
  const s = newState();
  const d = makeDerived();
  const nup = addChamber(s, 'nuptial_chamber', 5, 30, 5, 3, { level: 4 });
  nest.derive(s, d);
  assert.deepEqual(d.nest.agg.nuptial, { active: false, level: 4, shaftOpen: false });
  assert.equal(d.nest.agg.alateCells, 0);
  s.run.nest.shafts.push({ kind: 'nuptial', col: 8, open: true, ref: -1 });
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.deepEqual(d.nest.agg.nuptial, { active: true, level: 4, shaftOpen: true });
  assert.equal(d.nest.agg.alateCells, 25);
  nup.level = 3;
  nest.derive(s, d);
  assert.equal(d.nest.agg.alateCells, 20);
  nup.level = 9;
  nest.derive(s, d);
  assert.equal(d.nest.agg.alateCells, 25);
  s.cycle.traits.royal_court = 1;
  nest.derive(s, d);
  assert.equal(d.nest.agg.alateCells, 50);
});

test('royal levels, royalL, gate, adjGranaryRepletion', () => {
  const s = newState();
  const d = makeDerived();
  s.run.nest.chambers[0].level = 5;
  const r2 = addChamber(s, 'royal_chamber', 12, 20, 4, 2, { level: 2 });
  const gate = addChamber(s, 'gate', 21, 0, 2, 2, { level: 4 });
  const gran = addChamber(s, 'granary', 5, 40, 2, 2);
  addChamber(s, 'repletion_hall', 7, 40, 3, 2);
  nest.derive(s, d);
  assert.deepEqual(d.nest.agg.royal, [5, 2]);
  assert.equal(d.nest.agg.royalL, 5);
  assert.ok(near(d.nest.agg.gateL, 4));
  assert.equal(d.nest.agg.adjGranaryRepletion, true);
  r2.status = 'relocating';
  nest.derive(s, d);
  assert.deepEqual(d.nest.agg.royal, [5]);
  void gate; void gran;
});

test('gallery housing above L30 adds 10 + (L − 30) per level; ach_seed_bank granary ×1.1', () => {
  const s = newState();
  const d = makeDerived();
  addChamber(s, 'gallery', 5, 30, 10, 4, { level: 32 }); // clay: no loam bonus
  nest.derive(s, d);
  assert.ok(near(d.nest.agg.housingBase, 10 + 320 + 1 + 2));
  s.meta.achievements.ach_seed_bank = 0;
  addChamber(s, 'granary', 20, 45, 2, 2);
  nest.derive(s, d);
  assert.ok(near(d.nest.agg.granaryCap, 450 * 1.1));
});

test('geometry is rebuilt only when rev changes; d.nest.chambers stays parallel to the state chambers', () => {
  const s = newState();
  const d = makeDerived();
  nest.derive(s, d);
  const dist = d.nest.dist;
  nest.derive(s, d);
  assert.equal(d.nest.dist, dist, 'same rev → no rebuild');
  tunnel(s, 21, 5, 23, 5);
  nest.derive(s, d);
  assert.notEqual(d.nest.dist, dist);
  assert.equal(d.nest.dist[idx(23, 5)], 8);
  addChamber(s, 'gallery', 24, 4, 3, 2);
  nest.derive(s, d);
  assert.equal(d.nest.chambers.length, s.run.nest.chambers.length);
  assert.deepEqual(d.nest.chambers.map((c) => c.uid), s.run.nest.chambers.map((c) => c.uid));
});

test('hints: unfound caches within Chebyshev 4 (5 with ach_treasure_hunter) of an open cell, or hinted', () => {
  const s = newState();
  const d = makeDerived();
  s.run.nest.features.caches = [
    { i: idx(24, 5), kind: 'seed_cache', found: false, hinted: false },  // 4 from the shaft
    { i: idx(25, 5), kind: 'fossil', found: false, hinted: false },      // 5
    { i: idx(5, 50), kind: 'beetle_husk', found: false, hinted: true },
    { i: idx(23, 6), kind: 'seed_cache', found: true, hinted: false },
  ];
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.deepEqual(d.nest.hints.sort((a, b) => a - b), [idx(24, 5), idx(5, 50)].sort((a, b) => a - b));
  s.meta.achievements.ach_treasure_hunter = 1;
  nest.derive(s, d);
  assert.ok(d.nest.hints.includes(idx(25, 5)));
});
