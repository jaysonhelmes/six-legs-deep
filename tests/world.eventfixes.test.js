// Gameplay-rules regression tests — systems/events.js:
// F2: from Mound L5 a Footstep cannot hit the 7 hexes of the main entrance (DESIGN §8.7), not only the entrance hex.
// F8 (C74): a mold spot whose chamber was demolished disappears with its effect (and stops the outbreak); a spot on a
//   relocated chamber moves into the new footprint.
// Event gap rule (C75): in run 1 the next random event is due at most EVENT_GAP.firstRunMaxSec after the previous one;
//   later runs keep the plain exponential schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import * as events from '../src/systems/events.js';
import { EVENTS, EVENT_RULES, EVENT_GAP } from '../src/data/events.js';
import { MOUND } from '../src/data/surface.js';
import { GRID } from '../src/data/balance.js';
import { tickEffects, hasEffect } from '../src/core/effects.js';
import { neighbors, ringOf } from '../src/core/hex.js';
import { createGame } from '../src/core/game.js';

function derived(season = 'summer') {
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, broodSlots: 3 }, rates: { food: { gross: 10 }, insight: { gross: 2 }, chitin: { gross: 1 } } });
  d.season.id = season;
  return d;
}

function run(s, d, sec, dt = 0.1, onTick = null) {
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt });
    tickEffects(s, dt, env);
    events.tick(s, d, dt, env);
    s.run.time += dt;
    s.meta.simTime += dt;
    if (onTick) onTick(s, env);
  }
}

function busy(seed = 1) {
  const s = newState(seed);
  s.run.index = 1;
  s.run.time = 4000;
  s.run.colony.adults.minor = 2000;
  s.run.colony.jobs.forager = 500;
  s.run.events.nextIn = 1e12;
  return s;
}

// ---- F2 ----------------------------------------------------------------------------------------------------------

/** A footstep landing now on `hex`; returns the trail uids left afterwards. */
function stompAt(s, d, hex) {
  s.run.events.objects.push({ uid: 900, kind: 'footstep', hex, cell: -1, t: 0.05, data: { occ: 1 } });
  run(s, d, 0.1);
  return s.run.surface.trails.map((t) => t.uid);
}

function trailsThroughRing1(s) {
  const r1 = 1;                                         // a ring-1 hex next to the main entrance (hex 0)
  const out = neighbors(r1).find((h) => ringOf(h) === 2);
  assert.equal(ringOf(r1), 1);
  s.run.surface.trails.push({ uid: 101, src: -1, job: 'forager', path: [0, r1], S: 1, workers: 0 });
  s.run.surface.trails.push({ uid: 102, src: -1, job: 'forager', path: [0, r1, out], S: 1, workers: 0 });
  return { r1, out };
}

test('F2: from Mound L5 a footstep on a ring-1 hex no longer cuts trails that only use the 7 main-entrance hexes', () => {
  const s = busy(2);
  const d = derived();
  const { r1 } = trailsThroughRing1(s);
  s.run.surface.mound = MOUND.shieldLevel;
  const left = stompAt(s, d, r1);
  assert.ok(left.includes(101), 'trail 0 → ring 1 is shielded');
  assert.ok(!left.includes(102), 'a trail through a ring-2 hex of the footprint is still cut');
});

test('F2: below Mound L5 the same footstep cuts both trails', () => {
  const s = busy(2);
  const d = derived();
  const { r1 } = trailsThroughRing1(s);
  s.run.surface.mound = MOUND.shieldLevel - 1;
  const left = stompAt(s, d, r1);
  assert.ok(!left.includes(101) && !left.includes(102), 'both cut: ' + left);
});

test('F2: the shield also spares finite sources on the 7 main-entrance hexes', () => {
  const s = busy(3);
  const d = derived();
  s.run.surface.mound = MOUND.shieldLevel;
  const ring2 = neighbors(1).find((h) => ringOf(h) === 2);
  s.run.surface.sources.push({ uid: 501, type: 'dead_insect', hex: 1, stock: 10, max: 10, age: 0 });
  s.run.surface.sources.push({ uid: 502, type: 'dead_insect', hex: ring2, stock: 10, max: 10, age: 0 });
  stompAt(s, d, 1);
  const uids = s.run.surface.sources.map((x) => x.uid);
  assert.ok(uids.includes(501), 'ring-1 source shielded');
  assert.ok(!uids.includes(502), 'ring-2 source in the footprint removed');
});

// ---- F8 ----------------------------------------------------------------------------------------------------------

/** One live granary (the only mold target) and a mold bloom on it. */
function moldy(seed = 4) {
  const s = busy(seed);
  const d = derived();
  s.run.nest.chambers = [{ uid: 60, type: 'granary', x: 10, y: 6, w: 3, h: 2, level: 1, target: 1, status: 'active', k: 0 }];
  events.forceEvent(s, d, 'ev_mold_bloom', fakeEnv());
  const spots = s.run.events.objects.filter((o) => o.kind === 'mold');
  assert.ok(spots.length >= 1, 'precondition: mold spots');
  for (const o of spots) assert.ok(hasEffect(s, 'mold:' + o.uid));
  return { s, d, spots };
}

const inRect = (ch, cell) => {
  const x = cell % GRID.cols;
  const y = Math.floor(cell / GRID.cols);
  return x >= ch.x && x < ch.x + ch.w && y >= ch.y && y < ch.y + ch.h;
};

test('F8: demolishing a moldy chamber removes its spots and their effects; the outbreak ends', () => {
  const { s, d, spots } = moldy();
  s.run.nest.chambers = [];                            // demolished (nest.demolishChamber splices it out)
  run(s, d, EVENTS.ev_mold_bloom.num.spreadSec * 3);
  assert.equal(s.run.events.objects.filter((o) => o.kind === 'mold').length, 0, 'no orphan spot over the tunnel');
  for (const o of spots) assert.equal(hasEffect(s, 'mold:' + o.uid), false);
  assert.equal(s.run.events.active.some((a) => a.id === 'ev_mold_bloom'), false, 'the bloom stops spreading');
});

test('F8: relocating a moldy chamber moves its spots into the new footprint (still clickable, still harmful)', () => {
  const { s, d, spots } = moldy(5);
  const ch = s.run.nest.chambers[0];
  ch.x = 20;
  ch.y = 25;
  ch.status = 'relocating';
  run(s, d, 0.1);
  const now = s.run.events.objects.filter((o) => o.kind === 'mold');
  assert.equal(now.length, spots.length);
  for (const o of now) {
    assert.ok(inRect(ch, o.cell), 'spot ' + o.uid + ' at cell ' + o.cell + ' inside the new rectangle');
    assert.ok(hasEffect(s, 'mold:' + o.uid));
  }
  assert.equal(new Set(now.map((o) => o.cell)).size, new Set(spots.map((o) => o.cell)).size, 'distinct spots stay distinct');
});

test('F8 (integration): the real demolishChamber command leaves no orphan mold spot', () => {
  const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mid_capbound.txt');
  const g = createGame({ nowMs: 0, storage: null });
  g.importString(readFileSync(FIX, 'utf8'), 0);
  const s2 = g.s;
  const t2 = s2.run.nest.chambers.find((c) => c.type === 'granary' && c.status === 'active');
  assert.ok(t2, 'precondition: an active granary');
  // A mold spot on that granary, the way addMold makes one (spot object + scoped effect + spreading process).
  const cell = t2.y * GRID.cols + t2.x;
  s2.run.events.objects.push({ uid: 7777, kind: 'mold', hex: -1, cell, t: -1, data: { occ: 7776, chamber: t2.uid } });
  s2.run.effects.push({ id: 'mold:7777', stat: 'chamber', scope: t2.uid, mult: EVENTS.ev_mold_bloom.num.mult, t: -1 });
  s2.run.events.active.push({ uid: 7776, id: 'ev_mold_bloom', t: 60, data: { k: 'mold', occ: 7776 } });
  const res = g.actions.do('demolishChamber', { uid: t2.uid });
  assert.ok(res && res.ok, 'demolished: ' + JSON.stringify(res));
  g.runFor(1, { dt: 0.1 });
  assert.equal(g.s.run.events.objects.some((o) => o.uid === 7777), false, 'orphan spot removed');
  assert.equal(g.s.run.effects.some((e) => e.id === 'mold:7777'), false, 'its effect removed');
});

// ---- Event gap rule ----------------------------------------------------------------------------------------------

/** Every value the scheduler gives ev.nextIn (sampled when it jumps up) over `sec` seconds. */
function gaps(s, d, sec) {
  const out = [];
  let last = s.run.events.nextIn;
  run(s, d, sec, 0.1, (st) => {
    const v = st.run.events.nextIn;
    if (v > last + 1e-9) out.push(v);
    last = v;
  });
  return out;
}

test('event gap: run 1 never schedules the next event more than EVENT_GAP.firstRunMaxSec after the previous one', () => {
  assert.equal(EVENT_GAP.firstRunMaxSec, 150);
  const s = newState(11);
  const d = derived('spring');
  s.run.index = 0;
  s.run.colony.adults.minor = 300;
  s.run.colony.jobs.forager = 200;
  const g = gaps(s, d, EVENT_RULES.scriptedFruitAt + 3600);
  assert.ok(g.length >= 20, 'events kept coming (' + g.length + ')');
  assert.ok(g.every((x) => x <= EVENT_GAP.firstRunMaxSec + 1e-9), 'max gap ' + Math.max(...g));
});

test('event gap: later runs keep the plain exponential schedule (gaps above 150 s still happen)', () => {
  const s = busy(12);
  s.run.events.nextIn = 1;
  const d = derived('spring');
  const g = gaps(s, d, 3600 * 2);
  assert.ok(g.length >= 15);
  assert.ok(g.some((x) => x > EVENT_GAP.firstRunMaxSec), 'max gap ' + Math.max(...g));
});
