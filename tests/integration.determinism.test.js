// INTEGRATION TEST — ARCHITECTURE §15.3 #12 / DESIGN §27.2, §28.1 #12. Owner: WP1.
// Same seed + same command stream (keyed by tick index) → deep-equal state and identical event stream.
// Passes against the WP1 stubs (core alone is deterministic); it becomes meaningful once the systems land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { REGISTRY } from '../src/core/commands.js';
import { simulateOffline } from '../src/core/offline.js';
import { makeHolder, chance } from '../src/core/rng.js';
import { randomCommand } from './helpers.js';

const TYPES = Object.keys(REGISTRY).sort();

/** Scripted opening (hand-forage, jobs, a chamber) plus random commands from a fixed holder. */
function record(seed, ticks) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  const h = makeHolder(seed ^ 0x5bd1e995);
  const stream = {};
  const events = [];
  for (let i = 0; i < ticks; i++) {
    const cmds = [];
    if (i < 600 && i % 3 === 0) cmds.push({ type: 'clickForage', src: 1 });
    if (i === 300) cmds.push({ type: 'shiftJob', from: 'forager', to: 'digger', n: 2 });
    if (i === 700) cmds.push({ type: 'placeChamber', chamber: 'gallery', x: 21, y: 18 });
    if (i === 900) cmds.push({ type: 'setSetting', key: 'notation', value: 'engineering' });
    if (chance(h, 0.05)) cmds.push(randomCommand(h, g.s, TYPES, { pGarbage: 0.02 }));
    if (cmds.length) stream[i] = JSON.parse(JSON.stringify(cmds));
    g.queue.push(...cmds);
    for (const e of g.tickOnce()) events.push(e);
    if (i === 1500) simulateOffline(g.s, g.d, 900, { eff: 0.5 });
  }
  return { g, stream, events };
}

/** Replay a recorded stream on a fresh game with the same seed. */
function replay(seed, ticks, stream) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  const events = [];
  for (let i = 0; i < ticks; i++) {
    if (stream[i]) g.queue.push(...JSON.parse(JSON.stringify(stream[i])));
    for (const e of g.tickOnce()) events.push(e);
    if (i === 1500) simulateOffline(g.s, g.d, 900, { eff: 0.5 });
  }
  return { g, events };
}

test('same seed + same command stream → deep-equal state and events', () => {
  const TICKS = 3000;
  const a = record(20240601, TICKS);
  const b = replay(20240601, TICKS, a.stream);
  assert.deepStrictEqual(b.g.s, a.g.s);
  assert.equal(JSON.stringify(b.events), JSON.stringify(a.events));
  assert.ok(Object.keys(a.stream).length > 100);
});

test('a different seed gives a different state', () => {
  const a = replay(1, 50, {});
  const b = replay(2, 50, {});
  assert.notDeepStrictEqual(a.g.s, b.g.s);
});
