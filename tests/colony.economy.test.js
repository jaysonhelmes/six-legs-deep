// WP2 unit tests — systems/economy.js: food production / cap / overflow / f_run (C1), upkeep, efficiency, softcaps with
// pro-rata sources, passives, fungus gardens, soil, pheromone, spoilage, Hungry, harsh_nature, the click handler and the
// Winter Stores projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, findBadValues } from './helpers.js';
import { recompute } from '../src/systems/stats.js';
import { tick as economyTick, handlers, winterProjection } from '../src/systems/economy.js';
import { grant } from '../src/core/wallet.js';
import { CHAMBERS } from '../src/data/chambers.js';

const clickForage = handlers.clickForage;

function near(a, b, rel = 1e-9, msg = '') {
  assert.ok(Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(a), Math.abs(b)), `${msg} ${a} ≉ ${b}`);
}
const fxv = (table, id, key, dflt) => (table[id] && table[id].fx && typeof table[id].fx[key] === 'number' ? table[id].fx[key] : dflt);

function setup() {
  const s = newState(1);
  const d = makeDerived();
  return { s, d };
}
/** stats.recompute then economy.tick with a fresh env; returns the env. */
function run(s, d, dt = 0.1, opts = {}, ledger = null) {
  const env = fakeEnv({ dt, ...opts });
  recompute(s, d, env);
  for (const r of Object.keys(d.ledger)) d.ledger[r] = {};   // as step() resetLedger
  if (ledger) for (const r of Object.keys(ledger)) d.ledger[r] = { ...ledger[r] };
  economyTick(s, d, dt, env);
  s.run.time += dt;
  return env;
}

test('food: ledger production is added at efficiency × econDt; f_run and foodEver count it', () => {
  const { s, d } = setup();
  s.run.res.food = 0;
  run(s, d, 1, {}, { food: { 'food.trails': 8, 'food.loose': 2 } });
  near(s.run.res.food, 10);
  near(s.run.fRun, 10);
  near(s.meta.stats.foodEver, 10);
  assert.equal(d.rates.food.raw, 10);
  assert.equal(d.rates.food.gross, 10);
  assert.deepEqual(d.rates.food.src, { 'food.trails': 8, 'food.loose': 2 });
  run(s, d, 1, { eff: 0.5, econScale: 2 }, { food: { 'food.trails': 10 } });
  near(s.run.res.food, 10 + 10 * 0.5 * 2, 1e-12, 'eff × econDt');
  near(d.rates.food.gross, 10, 1e-12, 'gross is at efficiency 1');
  near(d.rates.food.net, 5, 1e-12, 'net includes efficiency');
});

test('cap rule: production fills to the cap (excess wasted); above the cap (overflow) production adds nothing, f_run still counts (C1)', () => {
  const { s, d } = setup();
  s.run.res.food = 145;
  run(s, d, 1, {}, { food: { 'food.trails': 20 } });
  assert.equal(s.run.res.food, 150);
  near(s.run.stats.foodWasted, 15);
  near(s.run.fRun, 20);
  grant(s, d, 'food', 200, { overflow: true });           // a windfall may push food to 2 × cap
  assert.equal(s.run.res.food, 300);
  const f0 = s.run.fRun;
  run(s, d, 1, {}, { food: { 'food.trails': 20 } });
  assert.equal(s.run.res.food, 300, 'production adds nothing while above the cap');
  near(s.run.fRun, f0 + 20, 1e-12, 'f_run counts production regardless of the cap');
  near(s.run.stats.foodWasted, 15 + 50 + 20);
});

test('upkeep is subtracted after production, scaled by efficiency, and food floors at 0', () => {
  const { s, d } = setup();
  s.run.colony.adults.soldier = 40;                      // 10 food/s
  s.run.res.food = 30;
  run(s, d, 1, {}, { food: { 'food.trails': 4 } });
  near(s.run.res.food, 24);
  near(d.rates.food.net, -6);
  near(d.rates.food.upkeep, 10);
  run(s, d, 1, { eff: 0.5 }, { food: { 'food.trails': 4 } });
  near(s.run.res.food, 24 + 2 - 5, 1e-12, 'upkeep × eff');
  run(s, d, 10, {}, { food: {} });
  assert.equal(s.run.res.food, 0);
});

test('softcaps apply to the aggregate and scale every source pro rata; softcapHit once per stat per run', () => {
  const { s, d } = setup();
  const env = run(s, d, 0.1, {}, { food: { 'food.trails': 3e24, 'food.loose': 1e24 }, insight: { x: 4e12 } });
  const g = 1e24 * (4e24 / 1e24) ** 0.5;
  near(d.rates.food.gross, g);
  near(d.rates.food.src['food.trails'], g * 0.75);
  near(d.rates.food.src['food.loose'], g * 0.25);
  assert.equal(d.rates.food.sc, true);
  near(d.rates.insight.gross, 1e12 * 2);
  const hits = env.events.filter((e) => e.type === 'softcapHit').map((e) => e.stat).sort();
  assert.deepEqual(hits, ['food', 'insight']);
  const env2 = run(s, d, 0.1, {}, { food: { 'food.trails': 4e24 } });
  assert.equal(env2.events.filter((e) => e.type === 'softcapHit').length, 0, 'not repeated in the same run');
  s.run.index = 1;
  const env3 = run(s, d, 0.1, {}, { food: { 'food.trails': 4e24 } });
  assert.equal(env3.events.filter((e) => e.type === 'softcapHit').length, 1, 'repeated in a new run');
  const { s: s2, d: d2 } = setup();
  run(s2, d2, 0.1, {}, { food: { 'food.trails': 1e24 } });
  assert.equal(d2.rates.food.sc, false, 'exactly at the threshold is not capped');
});

test('thermal_ceiling multiplies the first food softcap threshold', () => {
  const { s, d } = setup();
  s.meta.genome.thermal_ceiling = 1;
  run(s, d, 0.1, {}, { food: { a: 4e24 } });
  const m = d.stats.scMult.food;
  if (m > 1) assert.equal(d.rates.food.gross, 4e24);
  else near(d.rates.food.gross, 2e24);
});

test('passives: Scent Library insight, Root Aphid Pens (raw, winter × 0.5)', () => {
  const { s, d } = setup();
  d.nest.agg.libraryInsight = 0.2;
  d.nest.agg.rootPenL = 3;
  s.run.research.chemical_lexicon = 1;
  run(s, d, 1);
  near(d.ledger.insight.library, 0.2 * d.stats.insight.library);
  near(s.run.res.insight, 0.2 * d.stats.insight.library);
  const pen = fxv(CHAMBERS, 'root_aphid_pen', 'honeydew', 0) * 3;
  near(d.ledger.honeydew.pens, pen);
  d.season.id = 'winter';
  run(s, d, 1);
  near(d.ledger.honeydew.pens, pen * fxv(CHAMBERS, 'root_aphid_pen', 'winter', 1));
});

test('fungus gardens: active gardeners ≤ slots, 0.3 leaves → 0.1 fungus each, limited by the leaf supply', () => {
  const { s, d } = setup();
  s.run.colony.adults.minor = 20;
  s.run.colony.jobs.gardener = 10;
  Object.assign(d.nest.agg, { gardenerSlots: 5, leafCap: 1000, fungusCap: 2000, fungusMod: 1.5 });
  s.run.res.leaves = 100;
  run(s, d, 1);
  near(d.ledger.fungus.gardens, 5 * 0.1 * 1.5 * d.stats.fungus);
  near(s.run.res.leaves, 100 - 5 * 0.3);
  near(s.run.res.fungus, 5 * 0.1 * 1.5);
  s.run.res.leaves = 0.75;                                // half of one second's demand (1.5)
  run(s, d, 1);
  near(d.ledger.fungus.gardens, 5 * 0.1 * 1.5 * 0.5);
  near(s.run.res.leaves, 0);
  run(s, d, 1, {}, { leaves: { 'leaves.trails': 3 } });   // inflow covers the demand
  near(d.ledger.fungus.gardens, 5 * 0.1 * 1.5);
  near(s.run.res.leaves, 3 - 1.5);
  run(s, d, 1);
  near(d.ledger.fungus.gardens, 5 * 0.1 * 1.5, 1e-12, 'stock of 1.5 still covers one second');
});

test('soil = dig work × soilMult × eff × econDt, even with an empty dig queue', () => {
  const { s, d } = setup();
  s.run.colony.jobs.digger = 10;
  s.run.colony.adults.minor = 10;
  run(s, d, 2, { eff: 0.5 });
  near(s.run.res.soil, d.stats.digW * 2 * 0.5);
  near(d.rates.soil.gross, d.stats.digW);
});

test('other resources: honeydew / leaves / fungus clamp at their caps (never reducing a stock above it); insight / chitin unclamped', () => {
  const { s, d } = setup();
  run(s, d, 10, {}, { honeydew: { a: 10 }, chitin: { a: 2 }, insight: { a: 3 } });
  assert.equal(s.run.res.honeydew, d.stats.honeydewCap);
  assert.equal(s.run.res.chitin, 20);
  assert.equal(s.run.res.insight, 30);
  s.run.res.honeydew = 500;
  run(s, d, 1, {}, { honeydew: { a: 10 } });
  assert.equal(s.run.res.honeydew, 500);
  run(s, d, 1, {}, { fungus: { a: 10 } });
  assert.equal(s.run.res.fungus, 0, 'fungus cap is 0 without gardens');
});

test('pheromone regenerates only with scent_marking, up to the cap', () => {
  const { s, d } = setup();
  run(s, d, 10);
  assert.equal(s.run.res.pheromone, 0);
  s.run.research.scent_marking = 1;
  run(s, d, 10);
  near(s.run.res.pheromone, 5);
  near(d.rates.pheromone.gross, 0.5);
  run(s, d, 1000);
  assert.equal(s.run.res.pheromone, d.stats.pheromoneCap);
});

test('clay spoilage: online only, food × clay share × 0.005 per minute', () => {
  const { s, d } = setup();
  d.nest.agg.granaryCap = 1000;
  d.nest.agg.clayFoodShare = 0.5;
  s.run.res.food = 600;
  run(s, d, 60);
  near(s.run.res.food, 600 - 600 * 0.5 * 0.005);
  s.run.res.food = 600;
  run(s, d, 60, { offline: true });
  assert.equal(s.run.res.food, 600);
});

test('Hungry: enters at food 0 with net < 0, output ×0.75 and no laying, ends above 5 % of the cap', () => {
  const { s, d } = setup();
  s.run.colony.adults.minor = 20;                         // 1 food/s upkeep
  s.run.colony.jobs.forager = 20;
  s.run.res.food = 0.5;
  let env = run(s, d, 1, {}, { food: { a: 0.2 } });
  assert.equal(s.run.colony.hungry, true);
  assert.ok(env.events.some((e) => e.type === 'hungryStart'));
  assert.equal(s.run.stats.hungryEver, true);
  recompute(s, d, fakeEnv());
  assert.equal(d.stats.layRate, 0);
  assert.equal(d.stats.forage.mTime, 0.75);
  s.run.res.food = 0.04 * 150;                            // 4 % of the cap: still Hungry
  env = run(s, d, 0.1, {}, { food: {} });
  assert.equal(s.run.colony.hungry, true);
  s.run.res.food = 20;                                    // > 5 % of 150
  env = run(s, d, 0.1, {}, { food: { a: 2 } });
  assert.equal(s.run.colony.hungry, false);
  assert.ok(env.events.some((e) => e.type === 'hungryEnd'));
});

test('Hungry is never entered with net ≥ 0 at food 0 (the 0:00 egg leaves food at 0)', () => {
  const { s, d } = setup();
  s.run.res.food = 0;
  run(s, d, 1);
  assert.equal(s.run.colony.hungry, false);
});

test('offline: Hungry is never set (and is cleared); harsh_nature never kills offline', () => {
  const { s, d } = setup();
  s.meta.settings.harshNature = true;
  s.run.colony.adults.soldier = 100;
  s.run.res.food = 0;
  run(s, d, 60, { offline: true });
  assert.equal(s.run.colony.hungry, false);
  assert.equal(s.run.colony.adults.soldier, 100);
  s.run.colony.hungry = true;
  const env = run(s, d, 60, { offline: true });
  assert.equal(s.run.colony.hungry, false);
  assert.ok(env.events.some((e) => e.type === 'hungryEnd'));
  assert.equal(s.run.colony.adults.soldier, 100);
});

test('starvation: no deaths with harsh_nature off; 0.5 %/s of adults with it on (online, Hungry)', () => {
  const { s, d } = setup();
  s.run.colony.adults = { minor: 100, soldier: 100, supermajor: 0, replete: 0 };
  s.run.colony.jobs.forager = 100;
  s.run.res.food = 0;
  let deaths = [];
  for (let i = 0; i < 100; i++) deaths.push(...run(s, d, 0.1).events.filter((e) => e.type === 'adultsDied'));
  assert.equal(s.run.colony.hungry, true);
  assert.deepEqual(deaths, []);
  assert.equal(s.run.colony.adults.minor, 100);
  s.meta.settings.harshNature = true;
  deaths = run(s, d, 1).events.filter((e) => e.type === 'adultsDied');
  near(s.run.colony.adults.minor, 99.5);
  near(s.run.colony.adults.soldier, 99.5);
  assert.deepEqual(deaths.map((e) => [e.caste, e.cause]), [['minor', 'starvation'], ['soldier', 'starvation']]);
  near(deaths[0].n, 0.5);
  assert.ok(s.run.colony.jobs.forager <= s.run.colony.adults.minor + 1e-9, 'jobs follow the dead minors');
});

test('winterHungry resets when a winter begins and is set while Hungry in winter', () => {
  const { s, d } = setup();
  s.run.stats.winterHungry = true;
  d.season.id = 'winter';
  const env = fakeEnv({ dt: 0.1 });
  env.emit('seasonChanged', { id: 'winter', year: 1 });
  recompute(s, d, env);
  economyTick(s, d, 0.1, env);
  assert.equal(s.run.stats.winterHungry, false);
  s.run.colony.adults.soldier = 10;
  s.run.res.food = 0;
  run(s, d, 0.1);
  assert.equal(s.run.colony.hungry, true);
  assert.equal(s.run.stats.winterHungry, true);
});

test('a dt = 0 derive pass changes no stock and no Hungry state', () => {
  const { s, d } = setup();
  s.run.colony.adults.soldier = 10;
  s.run.res.food = 0;
  const before = JSON.stringify(s);
  run(s, d, 0, {}, { food: { a: 5 } });
  s.run.time -= 0;
  assert.equal(JSON.stringify(s), before);
  assert.equal(d.rates.food.gross, 5, 'rates are still computed');
});

test('clickForage: +clickValue food (counts toward f_run), clicked event, click counted; d.rates.food.clicks is a 5 s average', () => {
  const { s, d } = setup();
  recompute(s, d, fakeEnv());
  const env = fakeEnv();
  assert.equal(clickForage.validate(s, d, { type: 'clickForage', src: 1 }), null);
  clickForage.apply(s, d, { type: 'clickForage', src: 1 }, env);
  assert.equal(s.run.res.food, 6);
  assert.equal(s.run.fRun, 1);
  assert.equal(s.meta.counters.clicks, 1);
  assert.deepEqual(env.events, [{ type: 'clicked', src: 1, amount: 1 }]);
  for (let i = 0; i < 4; i++) clickForage.apply(s, d, { type: 'clickForage', src: 1 }, fakeEnv());
  economyTick(s, d, 0.1, fakeEnv());
  near(d.rates.food.clicks, 5 / 5);
  s.run.time = 6;
  economyTick(s, d, 0.1, fakeEnv());
  assert.equal(d.rates.food.clicks, 0);
});

test('clickForage validation codes', () => {
  const { s, d } = setup();
  recompute(s, d, fakeEnv());
  const v = (cmd) => clickForage.validate(s, d, { type: 'clickForage', ...cmd });
  for (const bad of [99, null, undefined, NaN, '1', {}, [], -1]) assert.equal(v({ src: bad }), 'notFound', String(bad));
  s.run.surface.sources.push({ uid: 7, type: 'prey_cricket', hex: 4, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.sources.push({ uid: 8, type: 'termite_mound', hex: 5, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.sources.push({ uid: 9, type: 'lycaenid_caterpillar', hex: 6, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.sources.push({ uid: 10, type: 'seed_patch', hex: 100, stock: 300, max: 300, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  assert.equal(v({ src: 7 }), 'invalid');
  assert.equal(v({ src: 8 }), 'invalid');
  assert.equal(v({ src: 9 }), 'invalid');
  assert.equal(v({ src: 10 }), 'invalid:hidden');
  s.run.hardship = 'claustral_founding';
  assert.equal(v({ src: 1 }), 'hardship');
  s.run.hardship = null;
  for (let i = 0; i < 15; i++) {
    assert.equal(v({ src: 1 }), null);
    clickForage.apply(s, d, { type: 'clickForage', src: 1 }, fakeEnv());
  }
  assert.equal(v({ src: 1 }), 'clickCap', '16th click in the same second');
  s.run.time = 1;
  assert.equal(v({ src: 1 }), null, 'next second');
});

test('winterProjection: stored food, winter net from the coming winter forage factor and winter upkeep, spoilage per minute', () => {
  const { s, d } = setup();
  s.run.colony.adults.minor = 40;
  s.run.res.food = 120;
  d.nest.agg.granaryCap = 1000;
  d.nest.agg.clayFoodShare = 0.25;
  d.season.id = 'autumn';
  d.season.mods.forage = 1.1;
  run(s, d, 0.1, {}, { food: { a: 11 } });
  const p = winterProjection(s, d);
  assert.equal(p.stored, s.run.res.food);
  near(p.netPerSec, 11 * (d.stats.forageWinter / 1.1) - d.stats.upkeepWinter);
  near(p.spoilPerMin, s.run.res.food * 0.25 * 0.005);
  assert.equal(p.winterSec, s.meta.season.lengthSec);
  assert.ok(d.stats.forageWinter > 0.59 && d.stats.forageWinter < 0.61, 'year 0: the coming winter is mild (0.6)');
});

test('economy keeps the state finite and JSON-safe with extreme inputs', () => {
  const { s, d } = setup();
  for (const k of Object.keys(s.run.res)) s.run.res[k] = 1e290;
  s.run.colony.adults = { minor: 1e290, soldier: 1e290, supermajor: 0, replete: 0 };
  s.run.colony.jobs.digger = 1e290;
  s.run.colony.jobs.gardener = 1e290;
  d.nest.agg.gardenerSlots = 1e290;
  for (let i = 0; i < 5; i++) run(s, d, 60, {}, { food: { a: 1e300 }, honeydew: { a: 1e300 }, leaves: { a: 1e300 } });
  assert.deepEqual(findBadValues(s), []);
});
