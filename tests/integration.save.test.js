// INTEGRATION TEST — ARCHITECTURE §17 step 4 / §15.3 #8 (save round-trip after 10 simulated minutes). Owner: WP1.
// A game played for 10 minutes with bot-like input exports and imports to a deep-equal state, and a reloaded
// game continues to run. Passes against the WP1 stubs; it becomes meaningful once the systems land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { fromExportString } from '../src/core/save.js';
import { SAVE } from '../src/data/balance.js';
import { snapshot, makeFakeStorage, findBadValues } from './helpers.js';

test('export → import after 10 simulated minutes is deep-equal; the local save reloads', () => {
  const storage = makeFakeStorage();
  const g = createGame({ nowMs: 0, storage });
  g.newGame(0, 99);
  for (let i = 0; i < 6000; i++) {
    if (i < 3000 && i % 3 === 0) g.actions.do('clickForage', { src: 1 });
    if (i === 400) g.actions.do('shiftJob', { from: 'forager', to: 'digger', n: 1 });
    if (i === 900) g.actions.do('placeChamber', { chamber: 'gallery', x: 21, y: 18 });
    g.tickOnce();
  }
  assert.deepEqual(findBadValues(g.s), []);
  const str = g.exportString(600_000);
  assert.ok(str.length <= SAVE.targetBytes, 'save is ' + str.length + ' bytes (target ≤ 60 KB)');
  const r = fromExportString(str);
  assert.equal(r.ok, true, r.error);
  assert.deepStrictEqual(r.state, snapshot(g.s));

  assert.equal(g.save(600_000).ok, true);
  const g2 = createGame({ nowMs: 0, storage });
  const res = g2.loadOrNew(600_000 + 5_000);
  assert.equal(res.loaded, true);
  assert.equal(g2.s.run.seed, g.s.run.seed);
  assert.equal(g2.s.meta.createdAt, g.s.meta.createdAt);
  assert.ok(g2.s.meta.tick > g.s.meta.tick, 'the 5 s gap was credited as online ticks');
  g2.runFor(10);
  assert.deepEqual(findBadValues(g2.s), []);
});
