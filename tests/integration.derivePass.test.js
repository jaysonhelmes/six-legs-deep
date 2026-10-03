// INTEGRATION TEST — ARCHITECTURE §18 C51 (added at integration). A dt = 0 derive pass on a fresh d, which is what
// load, import and the catch-up rebuild do, must not change the simulation state; and importString must therefore
// give back the exported run unchanged. Before integration every reload reset the seed patches to their base stock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { step } from '../src/core/step.js';
import { createDerived } from '../src/core/derived.js';
import { snapshot } from './helpers.js';

/** Paths a derive pass may advance (C51): unlock/reveal bookkeeping and the scout target. */
const MAY_CHANGE = ['meta.tick', 'meta.seen', 'meta.reveal', 'run.unlocked', 'run.surface.scout.target'];

function diffs(a, b, path = '', out = []) {
  if (out.length >= 10 || MAY_CHANGE.some((p) => path === p || path.startsWith(p + '.'))) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], path ? path + '.' + k : k, out);
  } else if (a !== b) out.push(path + ': ' + JSON.stringify(a) + ' → ' + JSON.stringify(b));
  return out;
}

/** 10 simulated minutes of crumb clicks, two trails and a Gallery. */
function played(seed) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  const crumb = g.s.run.surface.sources.find((x) => x.type === 'crumb_scatter');
  for (let i = 0; i < 6000; i++) {
    if (i % 3 === 0) g.actions.do('clickForage', { src: crumb.uid });
    if (i === 50) {
      const seed1 = g.s.run.surface.sources.find((x) => x.type === 'seed_patch' && g.s.run.surface.revealed[x.hex]);
      if (seed1) g.actions.do('drawTrail', { origin: 0, target: seed1.hex });
    }
    if (i === 900) g.actions.do('placeChamber', { chamber: 'gallery', x: 21, y: 18 });
    g.tickOnce();
  }
  return g;
}

test('a dt = 0 derive pass on a fresh d changes no simulation state (C51)', () => {
  for (const seed of [1, 7]) {
    const g = played(seed);
    const before = snapshot(g.s);
    const copy = snapshot(g.s);
    step(copy, createDerived(), 0, [], {});
    assert.deepEqual(diffs(before, copy), [], 'seed ' + seed);
  }
});

test('importString returns the exported run unchanged (seed patches keep their dynamic stock)', () => {
  const g = played(1);
  const patch = g.s.run.surface.sources.find((x) => x.type === 'seed_patch');
  assert.ok(patch && patch.max > 300, 'the seed patch grew past its base stock (max ' + (patch && patch.max) + ')');
  const before = snapshot(g.s.run);
  const r = g.importString(g.exportString(600_000), 600_000);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(diffs({ run: before }, { run: g.s.run }), []);
});
