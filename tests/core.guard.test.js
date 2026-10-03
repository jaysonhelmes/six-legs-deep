// WP1 unit tests: core/guard.js (hot-path revert and clamp, periodic full walk, guardAll).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardTick, guardAll } from '../src/core/guard.js';
import { CLAMP_MAX, GUARD } from '../src/data/balance.js';
import { newState, fakeEnv } from './helpers.js';

/** Run fn with console.error silenced; returns the number of calls. */
function quiet(fn) {
  const orig = console.error;
  let n = 0;
  console.error = () => { n++; };
  try { fn(); } finally { console.error = orig; }
  return n;
}

test('hot path: non-finite reverts to the last good value, reports nanGuard, counts nanGuards', () => {
  const s = newState();
  s.meta.tick = 1;
  s.run.res.food = 42;
  guardTick(s, fakeEnv());
  s.run.res.food = NaN;
  s.run.colony.adults.minor = Infinity;
  const env = fakeEnv();
  quiet(() => guardTick(s, env));
  assert.equal(s.run.res.food, 42);
  assert.equal(s.run.colony.adults.minor, 0);
  assert.equal(s.meta.stats.nanGuards, 2);
  assert.deepEqual(env.events.map((e) => e.path).sort(), ['run.colony.adults.minor', 'run.res.food']);
  assert.ok(env.events.every((e) => e.type === 'nanGuard'));
});

test('hot path clamps to [0, CLAMP_MAX] without reporting; -0 → 0', () => {
  const s = newState();
  s.meta.tick = 1;
  s.run.res.soil = -5;
  s.cycle.alates = 1e300;
  s.era.kinship = -0;
  s.meta.genesLife = 2e295;
  const env = fakeEnv();
  guardTick(s, env);
  assert.equal(s.run.res.soil, 0);
  assert.equal(s.cycle.alates, CLAMP_MAX);
  assert.ok(Object.is(s.era.kinship, 0));
  assert.equal(s.meta.genesLife, CLAMP_MAX);
  assert.equal(env.events.length, 0);
  assert.equal(s.meta.stats.nanGuards, 0);
});

test('every hot path from ARCHITECTURE §7.12 is guarded', () => {
  const s = newState();
  s.meta.tick = 1;
  const set = (v) => {
    for (const k of Object.keys(s.run.res)) s.run.res[k] = v;
    s.run.fRun = v;
    for (const k of Object.keys(s.run.colony.adults)) s.run.colony.adults[k] = v;
    s.cycle.alates = v; s.cycle.alatesCycle = v; s.era.kinship = v; s.era.kinshipLife = v; s.meta.genes = v; s.meta.genesLife = v;
  };
  set(NaN);
  const env = fakeEnv();
  quiet(() => guardTick(s, env));
  assert.equal(env.events.length, 8 + 1 + 4 + 6);
});

test('full walk every GUARD.fullEveryTicks ticks zeroes non-finite deep values; not on other ticks', () => {
  const s = newState();
  s.run.surface.sources[0].age = NaN;
  s.run.nest.cells[5] = Infinity;
  s.meta.tick = GUARD.fullEveryTicks + 1;
  guardTick(s, fakeEnv());
  assert.ok(Number.isNaN(s.run.surface.sources[0].age));
  s.meta.tick = GUARD.fullEveryTicks * 3;
  const env = fakeEnv();
  quiet(() => guardTick(s, env));
  assert.equal(s.run.surface.sources[0].age, 0);
  assert.equal(s.run.nest.cells[5], 0);
  assert.deepEqual(env.events.map((e) => e.path).sort(), ['run.nest.cells[5]', 'run.surface.sources[0].age']);
  assert.equal(s.meta.stats.nanGuards, 2);
});

test('full walk clamps magnitudes above CLAMP_MAX and keeps negative sentinels', () => {
  const s = newState();
  s.run.surface.sources[0].stock = 5e295;
  s.run.events.lastNegAt = -1e9;
  s.meta.tick = GUARD.fullEveryTicks;
  guardTick(s, fakeEnv());
  assert.equal(s.run.surface.sources[0].stock, CLAMP_MAX);
  assert.equal(s.run.events.lastNegAt, -1e9);
  assert.equal(s.run.nest.chambers.length, 1);
});

test('console.error is logged once per path per session', () => {
  const s = newState();
  s.meta.tick = 1;
  const calls = quiet(() => {
    for (let i = 0; i < 5; i++) {
      s.run.res.leaves = NaN;
      guardTick(s, fakeEnv());
    }
  });
  assert.ok(calls <= 1);
  assert.equal(s.meta.stats.nanGuards, 5);
});

test('guardAll: fixes non-finite numbers and non-number hot paths (NaN saved as null), returns the count', () => {
  const s = newState();
  s.run.res.food = null;
  s.run.colony.brood.push({ c: 'minor', n: NaN, p: 0, t: 0 });
  s.meta.season.t = Infinity;
  let fixes = 0;
  quiet(() => { fixes = guardAll(s); });
  assert.equal(fixes, 3);
  assert.equal(s.run.res.food, 0);
  assert.equal(s.run.colony.brood[0].n, 0);
  assert.equal(s.meta.season.t, 0);
  assert.equal(s.meta.stats.nanGuards, 3);
  assert.equal(guardAll(s), 0);
  assert.equal(guardAll(null), 0);
});
