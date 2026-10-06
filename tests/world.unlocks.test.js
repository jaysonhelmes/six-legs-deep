// WP6 unit tests: unlock evaluation, the reveal queue, persistence and the next-unlock ribbon (ARCHITECTURE §8.5, §11,
// DESIGN §23, §28.1 #14 "no two queued reveals within 30 s").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, DOC_UNLOCK_KEYS } from './helpers.js';
import * as unlocks from '../src/systems/unlocks.js';
import { UNLOCKS, REVEAL } from '../src/data/unlocks.js';
import { FLIGHT } from '../src/data/prestige.js';
import { RAIDS } from '../src/data/combat.js';
import { BROOD } from '../src/data/economy.js';

/** Development time of a new minor egg with no brood groups (bSpeed 1): the brood part of an { adults } ETA. */
const broodT = (d) => BROOD.baseSec * d.stats.mbt / Math.max(1, d.stats.nurseTerm);

/** §11 P / Q flags per key. */
const FLAGS = {
  panel_colony: 'yy', adapt_basic: 'yn', job_digger: 'yy', adapt_digging_claws: 'yn', panel_build: 'yy', chamber_gallery: 'yn',
  chamber_granary: 'yy', chamber_nursery: 'yy', job_scout: 'yy', trail_slots: 'yy', panel_research: 'yy', royal_levelup: 'yy',
  egg_reserve: 'yy', chamber_scent_library: 'yy', panel_achievements: 'yy', adapt_potent_trails: 'yy', golden_beetle: 'yy', res_chitin: 'yy',
  chamber_midden: 'yy', season_dial: 'yy', res_pheromone: 'nn', ability_mark: 'nn', hex_claim: 'nn', mound: 'yy', events: 'yy',
  panel_war: 'nn', caste_soldier: 'nn', chamber_barracks: 'nn', adapt_military: 'nn', panel_rivals: 'yy', job_presets: 'nn', job_herder: 'nn',
  res_honeydew: 'nn', chamber_root_aphid_pen: 'nn', adapt_honeydew: 'nn', climate_overlay: 'yy', panel_prestige: 'yy', ability_rally: 'nn',
  raid_warnings: 'yy', frost_line: 'yy', chamber_gate: 'yy', job_leafcutter: 'nn', chamber_hibernaculum: 'nn', chamber_nuptial_chamber: 'nn',
  alate_rearing: 'nn', fungus_widget: 'nn', chamber_fungus_garden: 'nn', job_gardener: 'nn', res_fungus: 'nn', chamber_thermal_chimney: 'nn',
  chamber_repletion_hall: 'nn', caste_replete: 'nn', chamber_deep_vault: 'nn', chamber_water_well: 'ny', caste_supermajor: 'nn', chamber_war_hall: 'nn', chamber_carapace_store: 'ny', chamber_carapace_workshop: 'nn',
  adapt_long_legs: 'nn', ability_frenzy: 'nn', panel_map: 'yy', flight_button: 'ny', tab_bloodline: 'yy', tab_hardships: 'yy',
  tab_federation_teaser: 'yy', tab_federation: 'yy', tab_edicts: 'yy', tab_genome_teaser: 'yy', tab_genome: 'yy', tab_guide: 'yn',
  tab_stats: 'yn', tab_settings: 'yn',
};

/** One unlocks tick (dt) with injected events; returns emitted unlock keys. */
function tick(s, d, dt = 1, events = []) {
  const env = fakeEnv({ dt });
  for (const e of events) env.events.push(e);
  unlocks.tick(s, d, dt, env);
  s.meta.simTime += dt;
  s.run.time += dt;
  return env.events.filter((e) => e.type === 'unlock').map((e) => ({ key: e.key, at: s.meta.simTime - dt }));
}

const def = (k) => UNLOCKS.find((u) => u.key === k);

test('data: every §11 key with its persist/queued flags, a label and a condition; no duplicates', () => {
  const keys = UNLOCKS.map((u) => u.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), [...DOC_UNLOCK_KEYS].sort());
  for (const u of UNLOCKS) {
    assert.ok(typeof u.label === 'string' && u.label.length > 0, u.key);
    assert.ok(u.cond && typeof u.cond === 'object', u.key);
    assert.equal((u.persist ? 'y' : 'n') + (u.queued ? 'y' : 'n'), FLAGS[u.key], u.key);
  }
  assert.equal(REVEAL.gapSec, 30);
});

test('queued reveals are spaced ≥ 30 s apart while gameplay unlocks happen at once', () => {
  const s = newState();
  const d = makeDerived();
  s.run.colony.adults.minor = 200;
  s.run.stats.hatched = 200;
  s.run.colony.jobs.digger = 5;
  const first = tick(s, d, 1);
  for (const k of ['panel_colony', 'job_digger', 'chamber_nursery', 'job_scout', 'royal_levelup', 'chamber_scent_library',
    'adapt_potent_trails', 'chamber_midden', 'adapt_basic', 'adapt_digging_claws']) {
    assert.equal(unlocks.isUnlocked(s, k), true, k + ' unlocked on the first tick');
  }
  assert.ok(first.some((x) => x.key === 'panel_colony'), 'the first queued reveal is immediate');
  const all = first.concat(...Array.from({ length: 400 }, () => tick(s, d, 1)));
  const queued = all.filter((x) => def(x.key).queued);
  assert.ok(queued.length >= 8, 'several queued reveals (' + queued.length + ')');
  for (let i = 1; i < queued.length; i++) assert.ok(queued[i].at - queued[i - 1].at >= REVEAL.gapSec - 1e-9, queued[i].key);
  // Every queued reveal is ≥ 30 s after any earlier reveal that set lastAt.
  assert.equal(new Set(all.map((x) => x.key)).size, all.length, 'each key revealed once');
  assert.equal(s.meta.reveal.queue.length, 0);
});

test('reveal spacing holds with dt = 0.1 and with large offline steps', () => {
  for (const dt of [0.1, 60]) {
    const s = newState();
    const d = makeDerived();
    s.run.colony.adults.minor = 500;
    s.run.stats.hatched = 1;
    const steps = Math.round(600 / dt);
    const all = [];
    for (let i = 0; i < steps; i++) all.push(...tick(s, d, dt));
    const queued = all.filter((x) => def(x.key).queued);
    for (let i = 1; i < queued.length; i++) assert.ok(queued[i].at - queued[i - 1].at >= REVEAL.gapSec - 1e-9);
  }
});

test('the same-tick non-queued reveal (adapt_basic) never delays its queued parent (panel_colony)', () => {
  const s = newState();
  const d = makeDerived();
  const t0 = tick(s, d, 0.1);
  assert.deepEqual(t0.map((x) => x.key).sort(), ['tab_guide', 'tab_settings', 'tab_stats'], 'always-on tabs at once');
  assert.equal(s.meta.reveal.lastAt, -1e9, 'always-on tabs do not start the reveal gap');
  for (let i = 0; i < 150; i++) tick(s, d, 0.1);
  s.run.stats.hatched = 1;
  const keys = tick(s, d, 0.1).map((x) => x.key);
  assert.deepEqual(keys, ['panel_colony', 'adapt_basic']);
  assert.equal(unlocks.isRevealed(s, 'panel_colony'), true);
});

test('purchase-triggered (non-queued) keys reveal immediately and restart the gap', () => {
  const s = newState();
  const d = makeDerived();
  tick(s, d, 1);
  s.run.research.scent_marking = 1;
  const keys = tick(s, d, 1).map((x) => x.key);
  // Owning research implies insight was found, so panel_research (queued) pops first, then the purchase reveals.
  assert.deepEqual(keys, ['panel_research', 'res_pheromone', 'ability_mark', 'hex_claim']);
  assert.equal(s.meta.reveal.lastAt, 1);
  s.run.colony.adults.minor = 3;
  assert.deepEqual(tick(s, d, 1), [], 'a queued key now waits for the gap');
  assert.equal(unlocks.isUnlocked(s, 'job_digger'), true);
  assert.equal(unlocks.isRevealed(s, 'job_digger'), false);
  for (let i = 0; i < 28; i++) tick(s, d, 1);   // simTime 3..30; the gap from lastAt = 1 ends at 31
  assert.deepEqual(tick(s, d, 1).map((x) => x.key), ['job_digger']);
  assert.equal(unlocks.isRevealed(s, 'job_digger'), true);
});

test('onRunStart grants persist keys already seen; research keys follow research (C25); no second reveal', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.seen.job_digger = true;
  s.meta.seen.res_pheromone = true;
  s.meta.seen.chamber_water_well = true;
  unlocks.onRunStart(s, d);
  assert.equal(unlocks.isUnlocked(s, 'job_digger'), true);
  assert.equal(unlocks.isUnlocked(s, 'res_pheromone'), false);
  assert.equal(unlocks.isUnlocked(s, 'chamber_water_well'), false);
  s.run.research.scent_marking = 1;
  const keys = tick(s, d, 1).map((x) => x.key);
  assert.ok(!keys.includes('res_pheromone'), 'already seen: no reveal again');
  assert.equal(unlocks.isRevealed(s, 'res_pheromone'), true);
  assert.equal(unlocks.isRevealed(s, 'bogus_key'), false);
});

test('evalCond covers the §11 condition language', () => {
  const s = newState();
  const d = makeDerived({ stats: { foodCap: 300 } });
  const ev = (c) => unlocks.evalCond(s, d, c);
  s.run.colony.adults.minor = 5;
  assert.equal(ev({ adults: 5 }), true);
  assert.equal(ev({ adults: 6 }), false);
  assert.equal(ev({ research: 'polymorphism' }), false);
  s.run.research.polymorphism = 1;
  assert.equal(ev({ research: 'polymorphism' }), true);
  s.cycle.traits.budding = 1;
  s.era.federation.megacolony = 2;
  s.meta.genome.chronobiology = 1;
  assert.equal(ev({ trait: 'budding' }) && ev({ fed: 'megacolony' }) && ev({ genome: 'chronobiology' }), true);
  assert.equal(ev({ trait: 'polygyny' }), false);
  s.run.unlocked.panel_build = true;
  assert.equal(ev({ flag: 'panel_build' }), true);
  s.run.fRun = 150;
  assert.equal(ev({ path: 'run.fRun', gte: 120 }), true);
  assert.equal(ev({ path: 'run.events.scripted', eq: true }), false);
  assert.equal(ev({ path: 'run.nope.deeper', gte: 0 }), false);
  assert.equal(ev({ dpath: 'stats.foodCap', gte: 300 }), true);
  s.meta.counters.flights = 2;
  assert.equal(ev({ counter: 'flights', gte: 1 }), true);
  s.run.time = 299;
  assert.equal(ev({ runTime: 300, firstRun: true }), false);
  s.run.index = 1;
  assert.equal(ev({ runTime: 300, firstRun: true }), true, 'first-run timers hold from the start of later runs');
  assert.equal(ev({ runTime: 300 }), false);
  s.meta.achievements = { a: 0, b: 0, c: 1 };
  assert.equal(ev({ achievements: 3 }), true);
  assert.equal(ev({ all: [] }), true);
  assert.equal(ev({ any: [] }), false);
  assert.equal(ev({ all: [{ adults: 1 }, { adults: 99 }] }), false);
  assert.equal(ev({ any: [{ adults: 1 }, { adults: 99 }] }), true);
  assert.equal(ev({ custom: 'nope' }), false);
  assert.equal(ev(null), false);
  assert.equal(ev({ weird: 1 }), false);
});

test('custom predicates', () => {
  const s = newState();
  const d = makeDerived({ stats: { housing: 10, foodCap: 200 } });
  const c = (name) => unlocks.evalCond(s, d, { custom: name });
  s.run.colony.adults.minor = 8;
  s.run.colony.brood = [{ c: 'minor', n: 2, p: 0, t: 0 }];
  assert.equal(c('housingFull'), true);
  s.run.colony.brood = [];
  assert.equal(c('housingFull'), false);
  s.run.res.food = 199;
  assert.equal(c('foodCapReached'), true);
  s.run.res.food = 100;
  assert.equal(c('foodCapReached'), false);
  d.surface.trails = [{ uid: 2, sat: 1.2, workers: 12, cEff: 10 }];
  assert.equal(c('crumbSaturated'), true);
  d.surface.trails = [{ uid: 2, sat: 0.5, workers: 5, cEff: 10 }];
  assert.equal(c('crumbSaturated'), false);
  assert.equal(c('firstHexRevealed'), false);
  s.run.surface.revealed[30] = 1;
  assert.equal(c('firstHexRevealed'), true);
  s.run.surface.revealed[30] = 0;
  tick(s, d, 0.1, [{ type: 'hexRevealed', hex: 30 }]);
  assert.equal(c('firstHexRevealed'), true, 'remembered from the event');
  assert.equal(c('firstChitin'), false);
  d.rates.chitin.gross = 0.01;
  assert.equal(c('firstChitin'), true);
  assert.equal(c('firstDigger'), false);
  s.run.colony.jobs.digger = 1;
  assert.equal(c('firstDigger'), true);
  assert.equal(c('rivalRevealed'), false);
  s.run.rivals.list.push({ uid: 1, type: 'black_garden_ants', alive: true, sighted: false, truce: 0 });
  assert.equal(c('rivalRevealed'), false);
  s.run.colony.adults.minor = RAIDS.minAdults;
  s.run.time = RAIDS.minRunSec - 1;
  assert.equal(c('rivalEligible'), false);
  s.run.time = RAIDS.minRunSec;
  assert.equal(c('rivalEligible'), true);
  d.season.id = 'winter';
  assert.equal(c('rivalEligible'), false, 'not in winter');
  d.season.id = 'spring';
  s.run.rivals.list[0].truce = 10;
  assert.equal(c('rivalEligible'), false, 'not under truce');
  s.run.rivals.list[0].sighted = true;
  assert.equal(c('rivalRevealed'), true);
  assert.equal(c('firstRaidWarning'), false);
  s.run.stats.raidsIncoming = 1;
  assert.equal(c('firstRaidWarning'), true);
  d.season.index = 1;
  assert.equal(c('autumnYear0'), false);
  d.season.index = 2;
  assert.equal(c('autumnYear0'), true);
  assert.equal(c('firstWinter'), false);
  s.meta.season.year = 1;
  assert.equal(c('firstWinter'), true);
  assert.equal(c('prestigeTab'), false);
  s.run.fRun = FLIGHT.tabFRun;
  assert.equal(c('prestigeTab'), true);
  assert.equal(c('flightReady'), false);
  d.meta.proj.fly.ok = true;
  assert.equal(c('flightReady'), true);
  assert.equal(c('waterRevealed'), false);
  s.run.nest.features.water.push({ x: 1, y: 50, w: 2, h: 2, revealed: true });
  assert.equal(c('waterRevealed'), true);
  assert.equal(c('secondTrailOrClaim'), false);
  s.run.surface.claims = 1;
  assert.equal(c('secondTrailOrClaim'), true);
  assert.equal(c('eggsBlockPurchase'), false, 'no recent egg spending');
});

test('the events key unlocks with the scripted fruit or from run 1 on', () => {
  const s = newState();
  const d = makeDerived();
  tick(s, d, 1);
  assert.equal(unlocks.isUnlocked(s, 'events'), false);
  s.run.events.scripted = true;
  tick(s, d, 1);
  assert.equal(unlocks.isUnlocked(s, 'events'), true);
  const s2 = newState();
  s2.run.index = 1;
  tick(s2, makeDerived(), 1);
  assert.equal(unlocks.isUnlocked(s2, 'events'), true);
});

test('next-unlock ribbon: the reveal queue head first, else the measurable key closest to unlocking', () => {
  const s = newState();
  const d = makeDerived({ stats: { layRate: 0.5 } });
  // The Colony panel (first hatch) is measurable now too, so it is taken out of the way here.
  s.run.unlocked.panel_colony = true;
  s.meta.seen.panel_colony = true;
  s.run.colony.adults.minor = 2;
  tick(s, d, 1);
  let n = d.progress.nextUnlock;
  assert.equal(n.key, 'job_digger');
  assert.ok(Math.abs(n.frac - 2 / 3) < 1e-9);
  // ARCHITECTURE §18 (nextUnlock at the source): an egg laid now still needs its development time.
  assert.ok(Math.abs(n.eta - (2 + broodT(d))) < 1e-9, '1 adult at 0.5/s plus one brood time: ' + n.eta);
  s.run.colony.adults.minor = 3;
  s.run.stats.hatched = 3;
  tick(s, d, 1);   // panel_colony revealed, job_digger queued
  n = d.progress.nextUnlock;
  assert.equal(n.key, 'job_digger');
  assert.equal(n.frac, 1);
  assert.ok(n.eta > 0 && n.eta <= REVEAL.gapSec);
  assert.equal(typeof n.label, 'string');
});

test('ticks are JSON-safe and robust to an empty derived cache', () => {
  const s = newState();
  const d = makeDerived();
  for (let i = 0; i < 100; i++) tick(s, d, 0.1, [{ type: 'eggLaid', caste: 'minor', n: 1 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.ok(Number.isFinite(d.progress._unl.eggFood));
});

test('a flag child (adapt_basic) is unlocked with its parent but revealed only once the parent is revealed', () => {
  const s = newState();
  const d = makeDerived();
  tick(s, d, 1);
  s.run.research.scent_marking = 1;   // a purchase reveal restarts the gap at simTime 1 …
  s.run.surface.revealed[30] = 1;      // … and panel_research is queued
  tick(s, d, 1);
  s.run.stats.hatched = 1;             // panel_colony (queued) + adapt_basic (non-queued) at simTime 2
  const keys = tick(s, d, 1).map((x) => x.key);
  assert.equal(unlocks.isUnlocked(s, 'adapt_basic'), true);
  assert.ok(!keys.includes('adapt_basic'), 'not announced before the Colony panel');
  assert.equal(Object.prototype.hasOwnProperty.call(s.meta.seen, 'adapt_basic'), false);
  const later = [];
  for (let i = 0; i < 90; i++) later.push(...tick(s, d, 1));
  const at = (k) => later.find((x) => x.key === k).at;
  assert.equal(at('adapt_basic'), at('panel_colony'), 'revealed in the same tick as its parent');
});

test('next-unlock ribbon: an { adults } ETA is unknown (−1, shown as %) while housing blocks laying or the colony is Hungry (C57)', () => {
  const s = newState();
  const d = makeDerived({ stats: { layRate: 0.5, housing: 10 } });
  // Everything nearer is already seen, and the timed keys (run-time conditions) are out of the way.
  for (const k of ['panel_colony', 'job_digger', 'panel_build', 'chamber_granary', 'chamber_nursery', 'golden_beetle', 'season_dial', 'chamber_gate']) { s.run.unlocked[k] = true; s.meta.seen[k] = true; }
  s.run.colony.adults.minor = 10;   // housing full: no egg can be laid
  tick(s, d, 1);
  let n = d.progress.nextUnlock;
  assert.equal(n.key, 'job_scout');
  assert.equal(n.eta, -1, 'no ETA while housing is full');
  d.stats.housing = 30;
  tick(s, d, 1);
  n = d.progress.nextUnlock;
  assert.ok(Math.abs(n.eta - (4 + broodT(d))) < 1e-9, '2 adults at 0.5/s plus one brood time once housing frees: ' + n.eta);
  s.run.colony.hungry = true;
  tick(s, d, 1);
  assert.equal(d.progress.nextUnlock.eta, -1, 'no ETA while Hungry');
});

test('the reveal queue runs in schedule order: a core key that unlocks behind a backlog goes first (C63)', () => {
  const s = newState();
  const d = makeDerived();
  s.run.stats.hatched = 1;
  tick(s, d, 1);                       // panel_colony revealed: the next reveal waits for the 30 s gap
  s.run.res.soil = 1e9;
  tick(s, d, 1);                       // mound queued first …
  s.run.colony.adults.minor = 12;
  tick(s, d, 1);                       // … then Diggers, Nursery and Scouts, which the schedule puts earlier
  const q = s.meta.reveal.queue.slice();
  const at = (k) => UNLOCKS.findIndex((u) => u.key === k);
  for (const k of ['mound', 'job_digger', 'chamber_nursery', 'job_scout']) assert.ok(q.includes(k), k + ' queued: ' + q);
  for (let i = 1; i < q.length; i++) assert.ok(at(q[i - 1]) < at(q[i]), 'queue in schedule order: ' + q.join(', '));
  const order = [];
  for (let i = 0; i < 200; i++) order.push(...tick(s, d, 1).map((x) => x.key));
  assert.ok(order.indexOf('job_scout') < order.indexOf('mound'), order.join(', '));
});

test('egg_reserve waits for the Build panel; panel_map waits for trail slots (C63)', () => {
  const s = newState();
  const d = makeDerived();
  s.run.surface.trails.push({ uid: 99, origin: 0, src: 1, path: [0, 1], len: 1, job: 'forager', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  while (s.run.surface.trails.length < 2) s.run.surface.trails.push({ ...s.run.surface.trails[0], uid: 100 + s.run.surface.trails.length });
  tick(s, d, 1);
  assert.equal(unlocks.isUnlocked(s, 'panel_map'), false, 'a second trail before trail slots does not unlock the Map');
  s.run.unlocked.trail_slots = true;
  tick(s, d, 1);
  assert.equal(unlocks.isUnlocked(s, 'panel_map'), true);
  assert.deepEqual(def('egg_reserve').cond, { all: [{ custom: 'eggsBlockPurchase' }, { flag: 'panel_build' }] });
});
