// WP4 scouting (DESIGN §8.3): scout force scouts^0.6, hex cost table, insight per hex, target choice and flags,
// offline efficiency, revealHexes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as surface from '../src/systems/surface.js';
import * as trails from '../src/systems/trails.js';
import { SCOUT } from '../src/data/surface.js';
import { RESEARCH } from '../src/data/research.js';
import { ringOf, neighbors, countInRadius } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);

function world(over = {}) {
  const s = newState(1);
  const d = makeDerived(over);
  surface.derive(s, d);
  return { s, d };
}

function tickOnce(s, d, dt = 0.1, opts = {}) {
  const env = fakeEnv({ dt, ...opts });
  for (const k of Object.keys(d.ledger)) d.ledger[k] = {};
  surface.derive(s, d);
  trails.tick(s, d, dt, env);
  surface.tick(s, d, dt, env);
  return env.events;
}

const revealedCount = (s) => s.run.surface.revealed.reduce((a, b) => a + b, 0);

test('scout force is scouts^0.6 scout-seconds per second for the whole force', () => {
  const { s, d } = world();
  s.run.colony.jobs.scout = 32;
  surface.derive(s, d);
  close(d.surface.scoutRate, 8, 1e-9);
  s.run.colony.jobs.scout = 1;
  surface.derive(s, d);
  close(d.surface.scoutRate, 1, 1e-12);
  s.run.colony.jobs.scout = 0;
  surface.derive(s, d);
  assert.equal(d.surface.scoutRate, 0);
  s.run.colony.jobs.scout = 32;
  s.meta.achievements.ach_cartographer = 100;
  surface.derive(s, d);
  close(d.surface.scoutRate, 8 * SCOUT.cartographer, 1e-9);
});

test('antennation ×2 and keen_antennae ×2 scout speed (when their data exists)', { skip: !RESEARCH.antennation && 'needs WP5 research data' }, () => {
  const { s, d } = world();
  s.run.colony.jobs.scout = 32;
  s.run.research.antennation = 1;
  surface.derive(s, d);
  close(d.surface.scoutRate, 8 * RESEARCH.antennation.fx.scout, 1e-9);
});

test('hex cost table: 10 × ring^1.2 → 10 / 37 / 69 / 121 / 197 scout-seconds at rings 1 / 3 / 5 / 8 / 12', () => {
  const cost = (r) => Math.round(SCOUT.base * r ** SCOUT.exp);
  assert.deepEqual([1, 3, 5, 8, 12].map(cost), [10, 37, 69, 121, 197]);
});

test('scouting reveals the nearest frontier hex after exactly its cost, granting 0.5 × ring × scouting insight', () => {
  const { s, d } = world({ stats: { insight: { scouting: 2 } } });
  assert.equal(revealedCount(s), countInRadius(2));
  assert.equal(d.surface.frontier.length, 18);
  s.run.colony.jobs.scout = 1;                      // 1 scout-second per second
  const cost3 = SCOUT.base * 3 ** SCOUT.exp;        // 37.37 s
  const n = Math.floor(cost3 / 0.1);
  let ev = [];
  for (let i = 0; i < n - 1; i++) ev = ev.concat(tickOnce(s, d, 0.1));
  assert.equal(revealedCount(s), 19, 'not yet');
  assert.equal(s.run.surface.scout.target, d.surface.frontier[0], 'lowest ring, then lowest index');
  for (let i = 0; i < 3; i++) ev = ev.concat(tickOnce(s, d, 0.1));
  assert.equal(revealedCount(s), 20);
  const hexEv = ev.filter((e) => e.type === 'hexRevealed');
  assert.equal(hexEv.length, 1);
  assert.equal(ringOf(hexEv[0].hex), 3);
  close(s.run.res.insight, SCOUT.insightPerRing * 3 * 2, 1e-9);
});

test('a flagged hex gets 3× priority (ring / 3) and the flag clears on reveal; large dt reveals many hexes in one call', () => {
  const { s, d } = world();
  s.run.research.antennation = 1;
  // reveal one ring-3 hex so ring-4 hexes join the frontier
  const r3 = d.surface.frontier[5];
  surface.revealHexes(s, d, [r3], { insight: false });
  surface.derive(s, d);
  const r4 = d.surface.frontier.find((h) => ringOf(h) === 4);
  const env = fakeEnv();
  surface.handlers.flagHex.apply(s, d, { type: 'flagHex', hex: r4, on: true }, env);
  assert.deepEqual(s.run.surface.flagged, [r4]);
  s.run.colony.jobs.scout = 1;
  tickOnce(s, d, 0.1);
  assert.equal(s.run.surface.scout.target, r4, '4 / 3 beats ring 3');
  tickOnce(s, d, 100);
  assert.equal(s.run.surface.revealed[r4], 1);
  assert.deepEqual(s.run.surface.flagged, []);
  const before = revealedCount(s);
  tickOnce(s, d, 3600, { offline: true });
  assert.ok(revealedCount(s) > before + 10, 'O(reveals) catch-up in one call');
  assert.ok(revealedCount(s) <= countInRadius(s.run.surface.radius));
});

test('offline efficiency scales scouting speed', () => {
  const a = world();
  const b = world();
  for (const w of [a, b]) w.s.run.colony.jobs.scout = 1;
  tickOnce(a.s, a.d, 20, { offline: true, eff: 1 });
  tickOnce(b.s, b.d, 20, { offline: true, eff: 0.5 });
  close(a.s.run.surface.scout.prog, 20, 1e-9);
  close(b.s.run.surface.scout.prog, 10, 1e-9);
});

test('revealHexes reveals, grants insight unless told not to, bumps rev once, and queues hexRevealed', () => {
  const { s, d } = world();
  const rev = s.run.surface.rev;
  const targets = d.surface.frontier.slice(0, 3);
  assert.equal(surface.revealHexes(s, d, [...targets, 0, -5, 'x'], { insight: true }), 3);
  assert.equal(s.run.surface.rev, rev + 1);
  close(s.run.res.insight, 3 * SCOUT.insightPerRing * 3, 1e-9);
  assert.equal(surface.revealHexes(s, d, targets), 0);
  const env = fakeEnv();
  surface.tick(s, d, 0, env);
  assert.equal(env.events.filter((e) => e.type === 'hexRevealed').length, 3);
  surface.revealHexes(s, d, [d.surface.frontier[10]], { insight: false });
  close(s.run.res.insight, 3 * SCOUT.insightPerRing * 3, 1e-9);
  assert.equal(surface.revealHexes(s, d, null), 0);
  assert.ok(neighbors(0).every((h) => s.run.surface.revealed[h] === 1));
});
