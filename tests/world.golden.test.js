// WP6 unit tests: Golden Beetle, Golden Pupa, Saved Finds gifts (ARCHITECTURE §8.5 golden.js, DESIGN §18.3, §18.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, snapshot } from './helpers.js';
import * as golden from '../src/systems/golden.js';
import { GOLDEN, SAVED_FINDS } from '../src/data/events.js';
import { OFFLINE } from '../src/data/balance.js';
import { tickEffects, effectMult } from '../src/core/effects.js';

function derived() {
  return makeDerived({ stats: { foodCap: 1e12, insight: { library: 1, scouting: 1, oneShot: 2 } }, rates: { food: { gross: 10 }, insight: { gross: 3 } } });
}

/** Tick golden for `sec`; extra events can be injected per tick. Returns emitted events with run.time. */
function run(s, d, sec, dt = 0.1, { offline = false, inject = null } = {}) {
  const out = [];
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt, offline });
    if (inject) for (const e of inject(i)) env.events.push(e);
    tickEffects(s, dt, env);
    golden.tick(s, d, dt, env);
    for (const e of env.events) if (!inject || e.type !== 'eggLaid') out.push({ ...e, at: s.run.time });
    s.run.time += dt;
    s.meta.simTime += dt;
  }
  return out;
}

const free = (s) => { s.run.clicks = { sec: -1, n: 0 }; };

test('data: Golden Beetle rolls 45/25/15/15 and the Saved Finds pool', () => {
  assert.deepEqual(GOLDEN.rolls.map((r) => [r.id, r.w]), [['windfall', 45], ['frenzy', 25], ['lay_burst', 15], ['discovery', 15]]);
  assert.deepEqual([...SAVED_FINDS.pool], ['ev_fallen_fruit', 'ev_pheromone_bloom', 'ev_queens_vigor', 'ev_lost_scout_returns', 'golden_beetle']);
});

test('beetles appear only once unlock golden_beetle is set, live 13 s, then return every U(300, 600) s', () => {
  const s = newState();
  const d = derived();
  run(s, d, 400, 1);
  assert.equal(s.run.golden.beetle, null, 'locked: no beetle');
  s.run.unlocked.golden_beetle = true;
  const ev = run(s, d, 0.2, 0.1);
  assert.ok(s.run.golden.beetle, 'spawns at once (beetleIn starts at 0)');
  assert.ok(ev.some((e) => e.type === 'beetleSpawned'));
  assert.equal(s.run.golden.beetle.t <= GOLDEN.life, true);
  const rev = s.run.surface.revealed;
  assert.equal(rev[s.run.golden.beetle.hex], 1, 'on a revealed hex');
  run(s, d, GOLDEN.life, 0.1);
  assert.equal(s.run.golden.beetle, null, 'escaped after 13 s');
  const wait = s.run.golden.beetleIn;
  assert.ok(wait >= GOLDEN.beetleMin && wait <= GOLDEN.beetleMax, 'next in ' + wait);
  run(s, d, wait - 1, 1);
  assert.equal(s.run.golden.beetle, null);
  run(s, d, 2, 1);
  assert.ok(s.run.golden.beetle);
});

test('beetle lifetime: 20 s with ach_beetle_collector, +5 s with ach_picnic_crasher', () => {
  const s = newState();
  assert.equal(golden.beetleLife(s), 13);
  s.meta.achievements.ach_beetle_collector = 0;
  assert.equal(golden.beetleLife(s), 20);
  s.meta.achievements.ach_picnic_crasher = 5;
  assert.equal(golden.beetleLife(s), 25);
  golden.spawnBeetle(s, derived(), 4);
  assert.deepEqual(s.run.golden.beetle, { hex: 4, t: 25 });
});

test('beetles, pupae and gifts are frozen offline', () => {
  const s = newState();
  const d = derived();
  s.run.unlocked.golden_beetle = true;
  s.meta.savedFinds = 2;
  golden.spawnBeetle(s, d, 3);
  const before = snapshot(s);
  run(s, d, 600, 60, { offline: true, inject: () => [{ type: 'eggLaid', caste: 'minor', n: 1e6 }] });
  assert.deepEqual(s.run.golden, before.run.golden);
  assert.equal(s.meta.savedFinds, 2);
});

test('clickBeetle: validation codes and a claimed reward', () => {
  const s = newState();
  const d = derived();
  const h = golden.handlers.clickBeetle;
  assert.equal(h.validate(s, d, {}), 'notFound');
  golden.spawnBeetle(s, d, 3);
  s.run.hardship = 'claustral_founding';
  assert.equal(h.validate(s, d, {}), 'hardship');
  s.run.hardship = null;
  s.run.clicks = { sec: 0, n: 15 };
  assert.equal(h.validate(s, d, {}), 'clickCap');
  free(s);
  assert.equal(h.validate(s, d, {}), null);
  const env = fakeEnv();
  h.apply(s, d, {}, env);
  assert.equal(s.run.golden.beetle, null);
  assert.equal(s.meta.counters.beetles, 1);
  assert.equal(s.meta.counters.clicks, 1);
  const claim = env.events.find((e) => e.type === 'beetleClaimed');
  assert.ok(GOLDEN.rolls.some((r) => r.id === claim.roll));
  assert.ok(s.run.golden.beetleIn >= GOLDEN.beetleMin && s.run.golden.beetleIn <= GOLDEN.beetleMax);
});

test('beetle rolls follow the weights and pay the documented rewards', () => {
  const tally = {};
  for (let seed = 1; seed <= 2000; seed++) {
    const s = newState(seed);
    const d = derived();
    golden.spawnBeetle(s, d, 3);
    const food0 = s.run.res.food;
    const ins0 = s.run.res.insight;
    const env = fakeEnv();
    golden.handlers.clickBeetle.apply(s, d, {}, env);
    const roll = env.events.find((e) => e.type === 'beetleClaimed').roll;
    tally[roll] = (tally[roll] || 0) + 1;
    if (roll === 'windfall') assert.ok(Math.abs(s.run.res.food - food0 - 600 * 10) < 1e-6);
    if (roll === 'frenzy') assert.equal(effectMult(s, 'forage'), 5);
    if (roll === 'lay_burst') assert.equal(effectMult(s, 'lay'), 3);
    if (roll === 'discovery') assert.ok(Math.abs(s.run.res.insight - ins0 - (60 * 3 + 20 * 2)) < 1e-9);
  }
  const p = (id) => tally[id] / 2000;
  assert.ok(Math.abs(p('windfall') - 0.45) < 0.04, JSON.stringify(tally));
  assert.ok(Math.abs(p('frenzy') - 0.25) < 0.04);
  assert.ok(Math.abs(p('lay_burst') - 0.15) < 0.03);
  assert.ok(Math.abs(p('discovery') - 0.15) < 0.03);
});

test('windfall may overflow food to 2× cap', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 100 }, rates: { food: { gross: 10 } } });
  s.run.res.food = 100;
  golden.spawnBeetle(s, d, 3);
  for (let seed = 1; seed < 50; seed++) {
    s.rng = seed;
    const before = s.run.res.food;
    golden.spawnBeetle(s, d, 3);
    const env = fakeEnv();
    free(s);
    golden.handlers.clickBeetle.apply(s, d, {}, env);
    if (env.events.find((e) => e.type === 'beetleClaimed').roll === 'windfall') {
      assert.equal(s.run.res.food, Math.min(200, before + 6000));
      return;
    }
  }
  assert.fail('no windfall rolled');
});

test('golden pupae: ~1 % per egg laid, at most one per 180 s, 15 s lifetime, in a nursery or the Royal Chamber', () => {
  const s = newState(3);
  const d = derived();
  const ev = run(s, d, 3600, 1, { inject: () => [{ type: 'eggLaid', caste: 'minor', n: 5 }] });
  const spawns = ev.filter((e) => e.type === 'pupaSpawned');
  assert.ok(spawns.length >= 5, 'pupae appear (' + spawns.length + ')');
  for (let i = 1; i < spawns.length; i++) assert.ok(spawns[i].at - spawns[i - 1].at >= GOLDEN.pupaGapSec - 1e-9);
  assert.equal(spawns[0].chamber, 1, 'Royal Chamber when there is no nursery');
  // No eggs → no pupae; quietWorld's lastPupaAt blocks them too.
  const s2 = newState(3);
  s2.run.golden.lastPupaAt = 1e12;
  const ev2 = run(s2, d, 3600, 1, { inject: () => [{ type: 'eggLaid', caste: 'minor', n: 5 }] });
  assert.equal(ev2.filter((e) => e.type === 'pupaSpawned').length, 0);
  // Lifetime
  const s3 = newState(3);
  s3.run.golden.pupa = { chamber: 1, t: GOLDEN.pupaLife };
  run(s3, d, GOLDEN.pupaLife + 0.1, 0.1);
  assert.equal(s3.run.golden.pupa, null);
});

test('clickPupa: frenzy (forage ×5 for 60 s) or windfall (10 min of food); validation codes', () => {
  const s = newState();
  const d = derived();
  const h = golden.handlers.clickPupa;
  assert.equal(h.validate(s, d, { choice: 'frenzy' }), 'notFound');
  s.run.golden.pupa = { chamber: 1, t: 10 };
  assert.match(h.validate(s, d, { choice: 'nap' }), /^invalid/);
  assert.match(h.validate(s, d, { choice: null }), /^invalid/);
  s.run.hardship = 'claustral_founding';
  assert.equal(h.validate(s, d, { choice: 'frenzy' }), 'hardship');
  s.run.hardship = null;
  assert.equal(h.validate(s, d, { choice: 'frenzy' }), null);
  h.apply(s, d, { choice: 'frenzy' }, fakeEnv());
  assert.equal(s.run.golden.pupa, null);
  assert.equal(effectMult(s, 'forage'), 5);
  assert.equal(s.run.effects.find((e) => e.stat === 'forage').t, 60);
  s.run.golden.pupa = { chamber: 1, t: 10 };
  free(s);
  const f0 = s.run.res.food;
  h.apply(s, d, { choice: 'windfall' }, fakeEnv());
  assert.ok(Math.abs(s.run.res.food - f0 - 6000) < 1e-6);
});

test('Saved Finds become gift boxes on revealed hexes (max 3 on the map); opening one fires a pool event or a beetle', () => {
  const s = newState(4);
  const d = derived();
  s.meta.savedFinds = 5;
  run(s, d, 0.1, 0.1);
  assert.equal(s.run.golden.gifts.length, OFFLINE.findMax);
  assert.equal(s.meta.savedFinds, 2, 'the rest wait for a free slot');
  const hexes = s.run.golden.gifts.map((g) => g.hex);
  assert.equal(new Set(hexes).size, hexes.length, 'distinct hexes');
  for (const h of hexes) assert.equal(s.run.surface.revealed[h], 1);
  const h = golden.handlers.openGift;
  assert.match(h.validate(s, d, { index: 1.5 }), /^invalid/);
  assert.match(h.validate(s, d, { index: 'x' }), /^invalid/);
  assert.equal(h.validate(s, d, { index: 3 }), 'notFound');
  assert.equal(h.validate(s, d, { index: -1 }), 'notFound');
  s.run.hardship = 'claustral_founding';
  assert.equal(h.validate(s, d, { index: 0 }), 'hardship');
  s.run.hardship = null;
  const seen = new Set();
  for (let k = 0; k < 3; k++) {
    free(s);
    assert.equal(h.validate(s, d, { index: 0 }), null);
    const env = fakeEnv();
    h.apply(s, d, { index: 0 }, env);
    const opened = env.events.find((e) => e.type === 'giftOpened');
    assert.ok(SAVED_FINDS.pool.includes(opened.id));
    seen.add(opened.id);
    if (opened.id === 'golden_beetle') assert.ok(s.run.golden.beetle);
    else assert.ok(env.events.some((e) => e.type === 'eventSpawned' && e.id === opened.id) || opened.id === 'ev_fallen_fruit');
  }
  assert.equal(s.run.golden.gifts.length, 0);
  run(s, d, 0.1, 0.1);
  assert.equal(s.run.golden.gifts.length, 2, 'the waiting finds appear');
  assert.equal(s.meta.savedFinds, 0);
});

test('the amber bead cross-call spawns a beetle on the given hex; beetleSpawned follows on the next tick', () => {
  const s = newState();
  const d = derived();
  golden.spawnBeetle(s, d, 5);
  assert.equal(s.run.golden.beetle.hex, 5);
  const ev = run(s, d, 0.1, 0.1);
  assert.equal(ev.filter((e) => e.type === 'beetleSpawned').length, 1);
  const ev2 = run(s, d, 1, 0.1);
  assert.equal(ev2.filter((e) => e.type === 'beetleSpawned').length, 0, 'emitted once');
  golden.spawnBeetle(s, d, 9999);
  assert.ok(s.run.golden.beetle.hex >= 0 && s.run.golden.beetle.hex < 817);
});

test('later runs (golden_beetle granted at 0:00): the first beetle waits U(300, 600) s instead of spawning at once (C61)', () => {
  const s = newState();
  const d = derived();
  s.run.index = 2;
  s.run.unlocked.golden_beetle = true;
  run(s, d, 1, 0.1);
  assert.equal(s.run.golden.beetle, null, 'no beetle at 0:00 of a later run');
  const wait = s.run.golden.beetleIn;
  assert.ok(wait >= GOLDEN.beetleMin - 1 && wait <= GOLDEN.beetleMax, 'armed: next in ' + wait);
  run(s, d, wait + 1, 1);
  assert.ok(s.run.golden.beetle, 'the armed beetle arrives');
});
