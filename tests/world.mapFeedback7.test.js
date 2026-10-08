// Feedback pass 7, map and combat (ARCHITECTURE §18 C220–C228, C236–C238): the Mound grows with the colony, event
// sources a trail must reach, permanent-only peak territory, rival land never covers entrances, Lycaenid escort cap,
// tournament prizes, truce timers, aphid moving, leafcutter gating, gain popups and enemy-power labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as surface from '../src/systems/surface.js';
import * as trails from '../src/systems/trails.js';
import * as rivals from '../src/systems/rivals.js';
import * as events from '../src/systems/events.js';
import * as jobs from '../src/systems/jobs.js';
import { MOUND, TERRAIN, TERRITORY } from '../src/data/surface.js';
import { ACTIONS } from '../src/data/combat.js';
import { hexIndex, ringOf, hexDist, neighbors, countInRadius, HEX_COUNT } from '../src/core/hex.js';
import { floatIconRes, RES_ICON_COLORS } from '../src/render/particles.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

function world(seed = 1) {
  const s = newState(seed);
  const d = makeDerived();
  surface.derive(s, d);
  return { s, d };
}

/** One surface tick of dt seconds (derive first, like step). */
function surfTick(s, d, dt = 1) {
  surface.derive(s, d);
  const env = fakeEnv({ dt });
  surface.tick(s, d, dt, env);
  return env.events;
}

// ------------------------------------------------------------------------------------------------------------- 1 Mound
test('C220: the Mound level follows the colony (peak adults, chamber levels, cells dug) with diminishing returns', () => {
  const { s, d } = world();
  s.run.stats.maxAdults = 2000;
  s.run.stats.cellsDug = 600;
  // locked: nothing grows yet (the Mound unlocks at 300 soil)
  assert.equal(surface.moundGrowth(s).level, 0);
  surfTick(s, d);
  assert.equal(s.run.surface.mound, 0, 'no growth before the unlock');
  s.run.unlocked.mound = true;
  const g = surface.moundGrowth(s);
  const want = MOUND.grow.adults.w * Math.log10(1 + 2000 / MOUND.grow.adults.div)
    + MOUND.grow.chambers.w * Math.log10(1 + g.inputs.chambers / MOUND.grow.chambers.div)
    + MOUND.grow.dug.w * Math.log10(1 + 600 / MOUND.grow.dug.div);
  assert.ok(Math.abs(g.value - want) < 1e-9, 'value = Σ w·log10(1 + x/div)');
  assert.equal(g.earned, Math.min(MOUND.freeMax, Math.floor(want)));
  const ev = surfTick(s, d);
  assert.equal(s.run.surface.mound, g.level);
  assert.equal(ev.filter((e) => e.type === 'moundLeveled').length, g.level, 'one moundLeveled per level');
  // diminishing returns: each further level needs more adults than the one before
  const adultsFor = (L) => {
    let lo = 0;
    let hi = 1e12;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const v = MOUND.grow.adults.w * Math.log10(1 + mid / MOUND.grow.adults.div);
      if (v >= L) hi = mid; else lo = mid;
    }
    return hi;
  };
  for (let L = 2; L < 12; L++) assert.ok(adultsFor(L + 1) - adultsFor(L) > adultsFor(L) - adultsFor(L - 1), 'diminishing at L' + L);
});

test('C220: levels above 5 need Mound Building; the stored level is a floor (old saves keep theirs); dt = 0 changes nothing', () => {
  const { s, d } = world();
  s.run.unlocked.mound = true;
  s.run.stats.maxAdults = 1e6;
  s.run.stats.cellsDug = 1e4;
  surfTick(s, d, 0);
  assert.equal(s.run.surface.mound, 0, 'a zero-time derive pass never changes the save');
  surfTick(s, d);
  assert.equal(s.run.surface.mound, MOUND.freeMax, 'capped without mound_building');
  assert.ok(surface.moundGrowth(s).capped);
  assert.equal(surface.moundGrowth(s).prog, 0);
  s.run.research.mound_building = 1;
  surfTick(s, d);
  assert.ok(s.run.surface.mound > MOUND.freeMax, 'grows past 5 with the research');
  // an old save bought L12 with soil while the colony is small: the level is kept
  const o = world();
  o.s.run.unlocked.mound = true;
  o.s.run.surface.mound = 12;
  o.s.run.stats.maxAdults = 50;
  surfTick(o.s, o.d);
  assert.equal(o.s.run.surface.mound, 12);
  assert.equal(surface.moundGrowth(o.s).level, 12);
});

test('C220: the auto-claim territory widens as the Mound grows (radius +1 per 5 levels)', () => {
  const { s, d } = world();
  const before = d.surface.ownedCount;
  assert.equal(before, countInRadius(TERRITORY.autoBase));
  s.run.unlocked.mound = true;
  s.run.stats.maxAdults = 1e5;
  surfTick(s, d);
  surface.derive(s, d);
  assert.equal(s.run.surface.mound, 5);
  assert.equal(d.surface.ownedCount, countInRadius(TERRITORY.autoBase + 1));
});

// --------------------------------------------------------------------------------------------------- 2 fallen fruit
test('C221: a fallen fruit lands only on a revealed hex a trail can reach; with none, the event does not happen', () => {
  const { s, d } = world();
  // rings 0–2 revealed (start): the ring 3–6 band is all fog → falls back to a revealed reachable hex from ring 2
  assert.equal(events.forceEvent(s, d, 'ev_fallen_fruit', fakeEnv()), true);
  const fruit = s.run.surface.sources.find((x) => x.type === 'fallen_fruit');
  assert.ok(fruit, 'spawned');
  assert.equal(s.run.surface.revealed[fruit.hex], 1, 'on a revealed hex');
  assert.ok(ringOf(fruit.hex) >= 2);
  assert.ok(Number.isFinite(trails.reachDist(s, d)[fruit.hex]), 'a trail can reach it');
  assert.ok(s.run.events.objects.some((o) => o.kind === 'fruit' && o.hex === fruit.hex));
  // reveal the ring 3–6 band: the fruit now prefers it
  const b = world(2);
  for (let i = 0; i < countInRadius(6); i++) b.s.run.surface.revealed[i] = 1;
  surface.derive(b.s, b.d);
  for (let k = 0; k < 5; k++) events.forceEvent(b.s, b.d, 'ev_fallen_fruit', fakeEnv());
  for (const f of b.s.run.surface.sources.filter((x) => x.type === 'fallen_fruit')) assert.ok(ringOf(f.hex) >= 3 && ringOf(f.hex) <= 6, 'ring band');
  // walled in by stone: nothing reachable → no fruit, no event
  const c = world(3);
  for (const n of neighbors(0)) c.s.run.surface.terrain[n] = TERRAIN.stone.code;
  c.s.run.surface.sources = c.s.run.surface.sources.filter((x) => x.type !== 'crumb_scatter');
  c.s.run.surface.trails = [];
  surface.derive(c.s, c.d);
  const env = fakeEnv();
  assert.equal(events.forceEvent(c.s, c.d, 'ev_fallen_fruit', env), false);
  assert.ok(!c.s.run.surface.sources.some((x) => x.type === 'fallen_fruit'));
  assert.ok(!env.events.some((e) => e.type === 'eventSpawned'));
});

// ------------------------------------------------------------------------------------------------------ 5 t_peak
test('C222: hexes held only by a trail (Trunk Trails) do not raise peak territory; permanent land does', () => {
  const { s, d } = world();
  s.run.research.trunk_trails = 1;
  const far = hexIndex(4, 0);
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), far];
  s.run.surface.sources.push({ uid: 99, type: 'seed_patch', hex: far, stock: 300, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 98, origin: 0, src: 99, path, len: 4, job: 'forager', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  s.run.surface.rev += 1;
  surfTick(s, d);
  const held = [...d.surface.owned].filter((v) => v === surface.OWN_TRAIL).length;
  assert.equal(held, 3, 'three trail-held hexes past the auto radius');
  assert.equal(d.surface.ownedCount, countInRadius(1) + held);
  assert.equal(d.surface.permCount, countInRadius(1));
  assert.equal(s.run.tPeak, countInRadius(1), 't_peak counts permanent land only');
  // claiming a trail-held hex makes it permanent → it counts
  s.run.surface.claimed[hexIndex(2, 0)] = 1;
  s.run.surface.rev += 1;
  surfTick(s, d);
  assert.equal(s.run.tPeak, countInRadius(1) + 1);
});

// ------------------------------------------------------------------------------------------- 6 entrances vs rival land
test('C224: rival land never covers an entrance or its auto-claim radius (outposts included), whatever the Mound level', () => {
  const { s, d } = world();
  const out = hexIndex(5, 0);
  surface.addEntrance(s, d, 'outpost', out, -1, 7);
  const r = rivals.createRival(s, { type: 'red_wood_ants', hex: hexIndex(7, 0) });   // radius 3: its disc reaches the outpost
  const autoR = (m) => TERRITORY.autoBase + Math.floor(m / TERRITORY.autoPerMound);
  for (const m of [0, 5, 10]) {
    s.run.surface.mound = m;
    const land = rivals.rivalLand(s, r);
    for (const h of land) {
      if (h === r.hex) continue;   // the rival's own nest hex always stays its own
      for (const e of s.run.surface.entrances) assert.ok(hexDist(h, e.hex) > autoR(m), `mound ${m}: rival hex ${h} inside entrance ${e.hex}'s radius`);
    }
    assert.ok(land.includes(r.hex), 'the rival keeps its own nest hex');
    s.run.surface.rev += 1;
    surface.derive(s, d);
    assert.notEqual(d.surface.owned[out], 0, 'the outpost hex is yours');
    assert.equal(d.surface.rival[out], 0, 'never rival land');
    for (const n of neighbors(out)) assert.equal(d.surface.rival[n], 0, `mound ${m}: outpost neighbour ${n} is not rival land`);
  }
});

// --------------------------------------------------------------------------------------------- 7 Lycaenid escorts
test('C236: a Lycaenid trail holds at most the 5 escorts it needs; other trails have no such cap', () => {
  const { s, d } = world();
  s.run.colony.adults.soldier = 20;
  d.combat.garrison = { soldier: 20, supermajor: 0 };
  const lyc = { uid: 80, origin: 0, src: 81, path: [0, 5], len: 1, job: 'lycaenid', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] };
  const fo = { ...lyc, uid: 82, src: 83, job: 'forager' };
  s.run.surface.trails.push(lyc, fo);
  assert.equal(trails.escortMax(lyc), 5);
  assert.equal(trails.escortMax(fo), Infinity);
  const v = (uid, n) => trails.handlers.assignEscorts.validate(s, d, { type: 'assignEscorts', uid, n });
  assert.equal(v(80, 5), null);
  assert.equal(v(80, 6), 'max');
  assert.equal(v(82, 6), null);
  // an old save with 8 on a Lycaenid trail: lowering is allowed, and the trail tick trims it to 5
  lyc.escorts = 8;
  assert.equal(v(80, 7), null, 'stepping down from an over-full trail is fine');
  assert.equal(v(80, 9), 'max');
});

// --------------------------------------------------------------------------------------------- 8 tournaments
test('C226: tournament previews state the outcome, the ratio needed and the prize; minors can reach the ratio', () => {
  const { s, d } = world();
  s.run.research.ritual_tournaments = 1;
  const r = rivals.createRival(s, { type: 'pavement_ants', hex: hexIndex(5, 0) });
  r.sighted = true;
  // 60 soldiers × 1.5 × 1.2 (tier 2) = 108 → 162 display wins; minors are 1 each
  const need = Math.ceil(ACTIONS.tournament.rivalPer * r.n * (1 + ACTIONS.tournament.tierStep) * ACTIONS.tournament.win);
  const pv = rivals.previewAction(s, d, 'tournament', r.uid, { minor: need });
  assert.equal(pv.outcome, 'win');
  assert.equal(pv.needDisplay, 0);
  assert.ok(pv.loot.insight >= ACTIONS.tournament.prize.insightMinPerTier * 2 && pv.loot.chitin >= ACTIONS.tournament.prize.chitinMinPerTier * 2);
  assert.equal(pv.raidDelay, ACTIONS.tournament.raidDelaySec);
  const low = rivals.previewAction(s, d, 'tournament', r.uid, { minor: Math.floor(need / 2) });
  assert.equal(low.outcome, 'contest');
  assert.ok(low.needDisplay > 0 && low.raise.some((x) => /minors/.test(x.text)));
  assert.equal(rivals.previewAction(s, d, 'tournament', r.uid, { minor: 5 }).outcome, 'withdraw');
  assert.equal(ACTIONS.tournament.cdSec, 90);
});

// ------------------------------------------------------------------------------------------------ 9 truce timers
test('C225: a bribed truce runs out after 5 minutes, also while the game is offline / the tab is hidden', () => {
  const { s, d } = world();
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(6, 0) });
  r.truce = ACTIONS.bribe.truceSec;
  r.bribeCd = ACTIONS.bribe.cdSec;
  rivals.tick(s, d, 100, fakeEnv({ dt: 100 }));
  assert.equal(r.truce, ACTIONS.bribe.truceSec - 100);
  rivals.tick(s, d, 250, fakeEnv({ dt: 250, offline: true }));
  assert.equal(r.truce, 0, 'over after 300 s in total, offline time included');
  assert.equal(r.bribeCd, ACTIONS.bribe.cdSec - 350);
  const n0 = r.n;
  rivals.tick(s, d, 60, fakeEnv({ dt: 60, offline: true }));
  assert.equal(r.n, n0, 'rival growth stays frozen offline');
});

// --------------------------------------------------------------------------------------------------- 11 aphids
test('C237: aphid colonies can be moved (Aphid Shepherding) onto an owned flower / leaf hex; the targets are listed', () => {
  const { s, d } = world();
  const aphid = surface.spawnSource(s, d, 'aphid_colony', hexIndex(3, 0));
  const flower = surface.spawnSource(s, d, 'flower_patch', hexIndex(-1, 1));
  surface.spawnSource(s, d, 'leaf_plant', hexIndex(5, -1));   // not owned
  assert.deepEqual(surface.aphidTargets(s, d, aphid), [], 'locked without the research');
  assert.equal(surface.canMoveAphids(s, d, aphid, hexIndex(-1, 1)), 'locked');
  s.run.research.aphid_shepherding = 1;
  assert.deepEqual(surface.aphidTargets(s, d, aphid), [hexIndex(-1, 1)]);
  assert.deepEqual(surface.aphidTargets(s, d, flower), [], 'only aphid colonies move');
  assert.equal(surface.canMoveAphids(s, d, aphid, hexIndex(5, -1)), 'invalid:owned');
  const env = fakeEnv();
  surface.handlers.moveAphids.apply(s, d, { type: 'moveAphids', src: aphid, hex: hexIndex(-1, 1) }, env);
  assert.equal(s.run.surface.sources.find((x) => x.uid === aphid).hex, hexIndex(-1, 1));
});

// ----------------------------------------------------------------------------------------------- 12 leafcutters
test('C238: leafcutters need leaf storage (a Fungus Garden): job cap 0, assignment refused, workers return to foraging', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.unlocked.job_leafcutter = true;
  s.run.colony.adults.minor = 20;
  s.run.colony.jobs.forager = 10;
  assert.equal(jobs.leavesUsable(d), false);
  assert.equal(jobs.jobCap(s, d, 'leafcutter'), 0);
  assert.equal(jobs.handlers.shiftJob.validate(s, d, { type: 'shiftJob', from: 'forager', to: 'leafcutter', n: 2 }), 'requirements:garden');
  assert.equal(jobs.handlers.setJobs.validate(s, d, { type: 'setJobs', jobs: { leafcutter: 2 } }), 'requirements:garden');
  // a save with leafcutters but no garden: they go back to foraging on the next real tick
  s.run.colony.jobs.leafcutter = 4;
  jobs.tick(s, d, 0, fakeEnv({ dt: 0 }));
  assert.equal(s.run.colony.jobs.leafcutter, 4, 'not on a zero-time pass');
  jobs.tick(s, d, 0.1, fakeEnv());
  assert.equal(s.run.colony.jobs.leafcutter, 0);
  assert.equal(s.run.colony.jobs.forager, 14);
  d.stats.leafCap = 500;
  assert.equal(jobs.leavesUsable(d), true);
  assert.equal(jobs.jobCap(s, d, 'leafcutter'), Infinity);
  assert.equal(jobs.handlers.shiftJob.validate(s, d, { type: 'shiftJob', from: 'forager', to: 'leafcutter', n: 2 }), null);
});

// ------------------------------------------------------------------------------------------- 3 popups, 10 loot
test('C223: rival alates show their food gain; every gain float carries its resource icon', () => {
  const { s, d } = world();
  d.rates.food = { gross: 10, net: 10, avg: 10 };
  d.stats.foodCap = 1e9;
  s.run.events.objects.push({ uid: 501, kind: 'rival_alate', hex: hexIndex(1, 0), cell: -1, t: 30, data: { occ: 500 } });
  const env = fakeEnv();
  const h = events.handlers.clickEventObject;
  assert.equal(h.validate(s, d, { type: 'clickEventObject', uid: 501 }), null);
  h.apply(s, d, { type: 'clickEventObject', uid: 501 }, env);
  const g = env.events.find((e) => e.type === 'objectGain');
  assert.ok(g && g.res === 'food' && g.amount > 0 && g.hex === hexIndex(1, 0));
  assert.equal(floatIconRes('+12 food'), 'food');
  assert.equal(floatIconRes('+1.2K chitin'), 'chitin');
  assert.equal(floatIconRes('+3 leaves'), 'leaves');
  assert.equal(floatIconRes('+5', 'honeydew'), 'honeydew');
  assert.equal(floatIconRes('windfall'), null);
  for (const r of ['food', 'chitin', 'insight', 'honeydew', 'soil', 'pheromone', 'leaves', 'fungus']) assert.ok(RES_ICON_COLORS[r], r);
});

// ------------------------------------------------------------------------------------------------- 4 enemy power
test('C228: rivalPower names the three figures: nest strength (all), what a raid faces (40 %), what an assault faces', () => {
  const { s, d } = world();
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(6, 0) });
  const pw = rivals.rivalPower(s, d, r);
  assert.ok(Math.abs(pw.raid - pw.nest * ACTIONS.raid.engage) < 1e-9);
  assert.ok(Math.abs(pw.assault - pw.nest * ACTIONS.assault.home) < 1e-9);
  const pv = rivals.previewAction(s, d, 'raid', r.uid, { soldier: 10 });
  assert.ok(Math.abs(pv.foeAP - pw.raid) < 1e-6, 'the War tab raid preview faces the raid figure');
  assert.ok(HEX_COUNT > 0);
});
