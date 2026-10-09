// C290 treasure mole: the Mole Tunnel event always leaves a clickable cache (seeds, fossil or beetle husk) at the end of
// its tunnel; the reward scales with the colony; the tunnel counts as unneeded for auto-backfill (except the cache cell
// while it waits); a cache whose cell is filled or built over is collected for the player; saves round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { CELL } from '../src/data/balance.js';
import { MOLE_CACHE } from '../src/data/soilFeatures.js';
import * as events from '../src/systems/events.js';
import * as nest from '../src/systems/nest.js';
import { toExportString, fromExportString } from '../src/core/save.js';
import { moleCacheTip } from '../src/ui/tooltips.js';
import { dugByText } from '../src/ui/panels/build.js';

function setup(seed = 1) {
  const s = newState(seed);
  s.run.time = 4000;
  s.run.events.nextIn = 1e12;
  const d = makeDerived({ stats: { foodCap: 2000, chitinCap: 600 }, rates: { food: { gross: 5 }, insight: { gross: 1 }, chitin: { gross: 0 } } });
  nest.derive(s, d);
  return { s, d };
}

const caches = (s) => s.run.events.objects.filter((o) => o && o.kind === 'mole_cache');

function fire(s, d) {
  const env = fakeEnv();
  assert.equal(events.forceEvent(s, d, 'ev_mole_tunnel', env), true);
  nest.derive(s, d);
  return env;
}

test('C290: every mole tunnel ends at a cache on its last (open) cell; kind drawn by weight, deterministic', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const { s, d } = setup(seed);
    s.rng = 1000 + seed;
    fire(s, d);
    const list = caches(s);
    assert.equal(list.length, 1, 'seed ' + seed);
    const o = list[0];
    assert.equal(s.run.nest.cells[o.cell], CELL.TUNNEL);
    assert.equal(o.hex, -1);
    assert.equal(o.t, -1, 'stays until collected');
    assert.ok(MOLE_CACHE.order.includes(o.data.cache));
    const mole = s.run.nest.dugBy.find((e) => e.w === 'mole');
    assert.equal(mole.c[mole.c.length - 1], o.cell, 'at the tunnel end');
    seen.add(o.data.cache);
  }
  assert.deepEqual([...seen].sort(), [...MOLE_CACHE.order].sort(), 'all three kinds occur');
  const a = setup(5);
  const b = setup(5);
  a.s.rng = b.s.rng = 77;
  fire(a.s, a.d);
  fire(b.s, b.d);
  assert.deepEqual(caches(a.s), caches(b.s));
});

test('C290: reward = max(min, sec × income, capFrac × cap) and it scales with progress', () => {
  const d = makeDerived({ stats: { foodCap: 2000, chitinCap: 600 }, rates: { food: { gross: 5 }, insight: { gross: 1 }, chitin: { gross: 0 } } });
  const k = MOLE_CACHE.kinds;
  assert.equal(events.moleCacheReward(d, 'seed_cache').amount, Math.max(k.seed_cache.min, 5 * k.seed_cache.sec, k.seed_cache.capFrac * 2000));
  assert.equal(events.moleCacheReward(d, 'fossil').amount, Math.max(k.fossil.min, 1 * k.fossil.sec));
  assert.equal(events.moleCacheReward(d, 'beetle_husk').amount, Math.max(k.beetle_husk.min, k.beetle_husk.capFrac * 600));
  const early = makeDerived({ stats: { foodCap: 0 } });
  for (const id of MOLE_CACHE.order) assert.equal(events.moleCacheReward(early, id).amount, k[id].min, id + ' floor');
  const late = makeDerived({ stats: { foodCap: 1e9, chitinCap: 1e6 }, rates: { food: { gross: 1e6 }, insight: { gross: 1e4 } } });
  for (const id of MOLE_CACHE.order) assert.ok(events.moleCacheReward(late, id).amount > 100 * events.moleCacheReward(d, id).amount, id + ' scales');
  assert.equal(events.moleCacheReward(d, 'nope'), null);
});

test('C290: clicking the cache collects it (grant, toast, object gone); tooltip names it', () => {
  const { s, d } = setup(3);
  fire(s, d);
  const o = caches(s)[0];
  o.data.cache = 'seed_cache';
  const tip = moleCacheTip(s, d, { id: o.uid });
  assert.match(tip.title, /Seed cache/);
  assert.match(tip.lines.join(' '), /Click to collect: about \+\S+ food/);
  const before = s.run.res.food;
  const env = fakeEnv();
  const h = events.handlers.clickEventObject;
  assert.equal(h.validate(s, d, { type: 'clickEventObject', uid: o.uid }), null);
  h.apply(s, d, { type: 'clickEventObject', uid: o.uid }, env);
  assert.equal(caches(s).length, 0);
  assert.ok(s.run.res.food - before >= events.moleCacheReward(d, 'seed_cache').amount - 1e-9);
  const ev = env.events.find((e) => e.type === 'findClaimed');
  assert.ok(ev && ev.kind === 'mole_cache' && /^Mole's seed cache: \+\S+ food\.$/.test(ev.text), ev && ev.text);
  assert.equal(h.validate(s, d, { type: 'clickEventObject', uid: o.uid }), 'notFound');
});

test('C290: the mole tunnel is unneeded (auto-backfill clears it) except the waiting cache cell; filling the cell collects it', () => {
  const { s, d } = setup(4);
  fire(s, d);
  const o = caches(s)[0];
  const mole = s.run.nest.dugBy.find((e) => e.w === 'mole');
  const dug = mole.c.filter((c) => c !== o.cell);
  const list = nest.unneededTunnels(s, d);
  for (const c of dug) assert.ok(list.includes(c), 'mole cell ' + c + ' unneeded');
  assert.ok(!list.includes(o.cell), 'the cache cell waits for its click');
  assert.match(dugByText(nest.cellInfo(s, d, dug[0])), /auto-backfill/);
  // the cell is filled (manual backfill): the cache is collected for the player on the next events tick
  s.run.nest.cells[o.cell] = CELL.SOIL;
  s.run.nest.rev++;
  const env = fakeEnv();
  const before = s.run.res.insight + s.run.res.food + s.run.res.chitin;
  events.tick(s, d, 0.1, env);
  assert.equal(caches(s).length, 0);
  assert.ok(s.run.res.insight + s.run.res.food + s.run.res.chitin > before);
  assert.match(env.events.find((e) => e.type === 'findClaimed').text, /^Your ants turned up the mole's /);
  // once collected the end cell is no longer protected
  s.run.nest.cells[o.cell] = CELL.TUNNEL;
  s.run.nest.rev++;
  nest.derive(s, d);
  assert.ok(nest.unneededTunnels(s, d).includes(o.cell));
});

test('C290: saves round-trip a waiting cache; an old save with a mole event in progress loads and runs', () => {
  const { s, d } = setup(6);
  fire(s, d);
  const r = fromExportString(toExportString(s, 0));
  assert.ok(r.ok, r.error);
  assert.deepEqual(caches(r.state), caches(s));
  // old save: a molehill on the map and a mole tunnel, no cache (pre-C290)
  const old = setup(7);
  old.s.run.events.objects = old.s.run.events.objects.filter((o) => o.kind !== 'mole_cache');
  old.s.run.events.objects.push({ uid: 900, kind: 'molehill', hex: 3, cell: -1, t: 50, data: { occ: 1 } });
  old.s.run.nest.dugBy = [{ w: 'mole', c: [old.s.run.nest.cells.length - 1] }];
  const lo = fromExportString(toExportString(old.s, 0));
  assert.ok(lo.ok, lo.error);
  const d2 = makeDerived();
  nest.derive(lo.state, d2);
  for (let k = 0; k < 20; k++) events.tick(lo.state, d2, 0.1, fakeEnv());
  assert.equal(caches(lo.state).length, 0);
  assert.ok(lo.state.run.events.objects.some((o) => o.kind === 'molehill'));
  // a malformed cache (unknown kind / bad cell) is dropped without throwing
  lo.state.run.events.objects.push({ uid: 901, kind: 'mole_cache', hex: -1, cell: -5, t: -1, data: {} });
  events.tick(lo.state, d2, 0.1, fakeEnv());
  assert.equal(caches(lo.state).length, 0);
});
