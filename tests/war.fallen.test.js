// Gameplay-rules regression tests — F26 (part, ARCHITECTURE §18 C77): conquered rivals no longer keep their full record
// in s.run.rivals.list for the rest of the run. A conquered non-boss rival is compacted to what the war panel, tooltips,
// toasts, achievements and the field guide read (uid, type, tier, hex, alive, sighted, fallenAt, n = 0), and at most
// FALLEN_RIVALS.keep of them are kept (oldest dropped). Bosses (Old Ridge, Argentine Front nests, which can be pending
// and regrow) are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rivals from '../src/systems/rivals.js';
import { FALLEN_RIVALS } from '../src/data/rivals.js';
import { hexIndex } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';

const KEEP = ['uid', 'type', 'tier', 'hex', 'alive', 'sighted', 'fallenAt', 'n'].sort();

function world({ soldier = 0, seed = 3 } = {}) {
  const s = newState(seed);
  s.run.colony.adults.soldier = soldier;
  s.run.unlocked.panel_war = true;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  return { s, d };
}

function run(s, d, sec, dt = 0.1) {
  const out = [];
  for (let i = 0; i < Math.round(sec / dt); i++) {
    const env = fakeEnv({ dt });
    rivals.tick(s, d, dt, env);
    s.run.time += dt;
    out.push(...env.events);
  }
  return out;
}

test('C77: a rival conquered by assault keeps a compact record that still answers the UI and achievement lookups', () => {
  const { s, d } = world({ soldier: 60 });
  const r = rivals.createRival(s, { type: 'black_garden_ants', hex: hexIndex(3, 0) });
  r.sighted = true;
  const full = JSON.stringify(r).length;
  const cmd = { type: 'launchParty', kind: 'assault', target: { type: 'rival', uid: r.uid }, soldier: 60, supermajor: 0 };
  assert.equal(rivals.handlers.launchParty.validate(s, d, cmd), null);
  rivals.handlers.launchParty.apply(s, d, cmd, fakeEnv());
  const ev = run(s, d, 90);
  assert.ok(ev.some((e) => e.type === 'conquest' && e.uid === r.uid && e.rivalType === 'black_garden_ants'));
  const rec = s.run.rivals.list.find((x) => x.uid === r.uid);
  assert.ok(rec, 'conquered rivals stay in the list (C55)');
  assert.deepEqual(Object.keys(rec).sort(), KEEP);
  assert.equal(rec.alive, false);
  assert.ok(rec.fallenAt > 0);
  assert.equal(rec.n, 0);
  assert.equal(rec.type, 'black_garden_ants');
  assert.equal(rec.tier, 1);
  assert.ok(JSON.stringify(rec).length < full * 0.55, 'record shrank from ' + full + ' to ' + JSON.stringify(rec).length + ' bytes');
  // The rest of the war code keeps working with the compact record in the list.
  run(s, d, 1300, 1);
  assert.ok(s.run.rivals.list.some((x) => x.alive && x.tier === 2), 'the respawn still arrives');
  assert.deepEqual(findBadValues(s), []);
});

test('C77: bosses are never compacted (Old Ridge stays whole; pending Front nests can regrow)', () => {
  const { s, d } = world();
  const or = rivals.createRival(s, { type: 'old_ridge_supercolony', hex: hexIndex(6, 0) });
  or.alive = false;
  or.n = 0;
  or.fallenAt = 5;
  const fronts = [hexIndex(0, 6), hexIndex(-6, 6), hexIndex(-6, 0)].map((hex) => rivals.createRival(s, { type: 'great_rival', hex, group: 99 }));
  fronts[0].alive = false;
  fronts[0].fallenAt = 0;
  const keys = (x) => Object.keys(x).length;
  const before = [keys(or), keys(fronts[0])];
  run(s, d, 1);
  assert.deepEqual([keys(or), keys(fronts[0])], before);
  assert.ok(Array.isArray(fronts[0].traits) && fronts[0].base > 0, 'a pending Front nest keeps what it needs to regrow');
});

test('C77: at most FALLEN_RIVALS.keep conquered non-boss rivals are kept; the oldest go first', () => {
  const { s, d } = world();
  const n = FALLEN_RIVALS.keep + 5;
  for (let i = 0; i < n; i++) {
    const r = rivals.createRival(s, { tier: 1 + (i % 3), hex: 40 + i });
    r.alive = false;
    r.n = 0;
    r.fallenAt = 100 + i;
  }
  const alive = rivals.createRival(s, { tier: 2, hex: 200 });
  run(s, d, 0.1);
  const fallen = s.run.rivals.list.filter((x) => !x.alive);
  assert.equal(fallen.length, FALLEN_RIVALS.keep);
  assert.equal(Math.min(...fallen.map((x) => x.fallenAt)), 100 + n - FALLEN_RIVALS.keep, 'oldest dropped');
  assert.ok(s.run.rivals.list.includes(alive), 'live rivals untouched');
  for (const x of fallen) assert.deepEqual(Object.keys(x).sort(), KEEP);
});
