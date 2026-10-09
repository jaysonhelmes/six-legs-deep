// C106 (player report): a blueprint's chambers are placed after a Nuptial Flight even though nearly every chamber type
// is locked (or unaffordable) at run start. Locked / unaffordable spots stay pending in s.run.nest.bpPending and queue
// themselves at blueprint price as soon as they unlock and can be paid for; permanently invalid spots are dropped.
// Headless, through the real game object and the real run start (prestige.startRun), like tools/smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { createDerived } from '../src/core/derived.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { DIG } from '../src/data/strata.js';
import { CELL } from '../src/data/balance.js';
import * as nest from '../src/systems/nest.js';
import { startRun } from '../src/systems/prestige.js';
import { makeEnv } from '../src/core/step.js';

const T0 = 1_700_000_000_000;
const SEED = 4242;
const TYPES = ['gallery', 'nursery', 'granary', 'scent_library', 'midden'];

function cmd(s, d, c) {
  const h = nest.handlers[c.type];
  const r = h.validate(s, d, c);
  if (r === null) h.apply(s, d, c, makeEnv(0.1));
  return r;
}

/** Build a blueprint on the nest the next run (seed SEED) will have: every type placed by the advisor, dug, saved. */
function makeBlueprint(game) {
  const s = JSON.parse(JSON.stringify(game.s));
  const d = createDerived();
  startRun(s, d, { seed: SEED });
  for (const id of CHAMBER_ORDER) if (CHAMBERS[id].unlock) s.run.unlocked[CHAMBERS[id].unlock] = true;
  s.cycle.traits.ancestral_blueprint = 1;
  for (const type of TYPES) {
    Object.assign(s.run.res, { food: 1e9, soil: 1e9 });
    d.stats.foodCap = 1e12;
    nest.derive(s, d);
    const at = nest.findPlacement(s, d, type);
    assert.ok(at, 'advisor spot for ' + type);
    assert.equal(cmd(s, d, { type: 'placeChamber', chamber: type, x: at.x, y: at.y }), null, type);
    d.stats.digW = 1e9;
    s.run.nest.digAllow = 1e12; // C252: dig everything queued this step (the dig cap has its own tests)
    nest.tick(s, d, 1, makeEnv(1));
  }
  assert.equal(cmd(s, d, { type: 'saveBlueprint', slot: 0, name: 'Plan' }), null);
  return s.era.blueprints[0];
}

test('C106: a fresh run with an active blueprint places every blueprint chamber as it unlocks', () => {
  const game = createGame({ nowMs: T0, storage: null });
  game.newGame(T0, 7);
  const bp = makeBlueprint(game);
  assert.equal(bp.chambers.length, TYPES.length);
  const s = game.s;
  s.cycle.traits.ancestral_blueprint = 1;
  s.era.blueprints = [bp];
  s.era.activeBlueprint = 0;
  // The real run start (what a Nuptial Flight does): everything but the start chambers is locked.
  startRun(s, game.d, { seed: SEED });
  const placedTypes = () => s.run.nest.chambers.filter((c) => c.blueprint).map((c) => c.type);
  const pendingTypes = () => s.run.nest.bpPending.map((p) => p.type);
  const locked = TYPES.filter((t) => !s.run.unlocked[CHAMBERS[t].unlock]);
  assert.ok(locked.length >= 3, 'most chamber types are locked at run start');
  for (const t of locked) assert.ok(pendingTypes().includes(t), t + ' pending, not skipped');
  assert.deepEqual(nest.plannedChambers(s).map((p) => p.type).sort(), pendingTypes().sort());
  // Unlock one type at a time (what the unlock schedule does over a run), with food to pay the blueprint price.
  for (const t of locked) {
    s.run.unlocked[CHAMBERS[t].unlock] = true;
    for (let k = 0; k < 30 && !placedTypes().includes(t); k++) {
      s.run.res.food = Math.max(s.run.res.food, 1e7);
      game.tickOnce(0.1);
    }
    assert.ok(placedTypes().includes(t), t + ' placed once unlocked');
    assert.ok(!pendingTypes().includes(t), t + ' no longer pending');
    const ch = s.run.nest.chambers.find((c) => c.type === t && c.blueprint);
    const spec = bp.chambers.find((c) => c.type === t);
    assert.deepEqual([ch.x, ch.y], [spec.x, spec.y], t + ' at its blueprint spot');
  }
  assert.deepEqual(placedTypes().sort(), TYPES.slice().sort(), 'all blueprint chambers placed');
  assert.deepEqual(s.run.nest.bpPending, []);
  assert.deepEqual(s.run.nest.bpTunnels, []);
  assert.ok(s.run.nest.queue.some((j) => j.blueprint && j.kind === 'chamber'), 'queued as blueprint jobs (fast dig)');
});

test('C106: pending spots wait for food at half price; a spot covered by another chamber is dropped with an event', () => {
  const game = createGame({ nowMs: T0, storage: null });
  game.newGame(T0, 7);
  const bp = makeBlueprint(game);
  const s = game.s;
  s.cycle.traits.ancestral_blueprint = 1;
  s.era.blueprints = [bp];
  s.era.activeBlueprint = 0;
  startRun(s, game.d, { seed: SEED });
  const spec = bp.chambers.find((c) => c.type === 'scent_library');
  assert.ok(s.run.nest.bpPending.some((p) => p.type === 'scent_library'));
  s.run.unlocked[CHAMBERS.scent_library.unlock] = true;
  const half = CHAMBERS.scent_library.place.food * DIG.blueprintPlaceMult;
  // Not enough food: stays pending.
  for (let k = 0; k < 25; k++) { s.run.res.food = half * 0.9; game.tickOnce(0.1); }
  assert.ok(s.run.nest.bpPending.some((p) => p.type === 'scent_library'), 'unaffordable: still pending');
  // Enough for the half price (not the full price): queued at half price.
  let before = 0;
  for (let k = 0; k < 60 && !s.run.nest.chambers.some((c) => c.type === 'scent_library'); k++) {
    s.run.res.food = half * 1.2;
    before = s.run.res.food;
    // C138: a spot the open nest does not reach yet first gets an access tunnel; dig it out at once here
    for (const j of s.run.nest.queue) if (j.bpAccess) { for (const c of j.cells) s.run.nest.cells[c] = CELL.TUNNEL; s.run.nest.rev++; }
    game.tickOnce(0.1);
  }
  const lib = s.run.nest.chambers.find((c) => c.type === 'scent_library');
  assert.ok(lib && lib.blueprint, 'queued once the half price is affordable');
  const job = s.run.nest.queue.find((j) => j.chamber === lib.uid);
  assert.equal(job.paidFood, half);
  assert.ok(before >= half);
  // A gallery spot: the player builds something else there first → dropped, blueprintDropped emitted.
  const gspec = bp.chambers.find((c) => c.type === 'gallery');
  const pend = s.run.nest.bpPending.find((p) => p.type === 'gallery');
  assert.ok(pend, 'gallery pending');
  const fp = { w: CHAMBERS.gallery.w0, h: CHAMBERS.gallery.h0 };
  const blocker = { uid: s.run.nest.nextUid++, type: 'granary', k: 9, x: gspec.x, y: gspec.y, w: 2, h: 2, level: 1, target: 1,
    status: 'active', blueprint: false, bornAt: 0 };
  s.run.nest.chambers.push(blocker);
  for (let i = 0; i < fp.w && i < 2; i++) for (let j = 0; j < 2; j++) s.run.nest.cells[(gspec.y + j) * 40 + gspec.x + i] = CELL.CHAMBER;
  s.run.nest.rev++;
  const seen = [];
  const off = game.bus.on('blueprintDropped', (e) => seen.push(e));
  for (let k = 0; k < 15; k++) game.tickOnce(0.1);
  if (typeof off === 'function') off();
  assert.ok(!s.run.nest.bpPending.some((p) => p.type === 'gallery'), 'covered spot dropped');
  assert.ok(seen.some((e) => e.chamberType === 'gallery' && e.reason === 'blocked:chamber'));
  void spec;
});
