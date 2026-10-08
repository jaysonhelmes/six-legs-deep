// WP2 unit tests — systems/jobs.js: idle minors, job caps, consistency, releaseMinors, the job commands, auto mode
// (ratio targets every 5 s, caps, locked jobs), response thresholds (C94 bias), withTarget and saved presets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { tick as jobsTick, handlers, idleMinors, jobCap, releaseMinors, withTarget, effectiveTargets, thresholdTriggers } from '../src/systems/jobs.js';
import { recompute } from '../src/systems/stats.js';
import { THRESHOLDS } from '../src/data/jobs.js';

function near(a, b, rel = 1e-9, msg = '') {
  assert.ok(Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(a), Math.abs(b)), `${msg} ${a} ≉ ${b}`);
}
function setup(minors = 10) {
  const s = newState(1);
  const d = makeDerived();
  s.run.colony.adults.minor = minors;
  s.run.colony.jobs.forager = minors;
  return { s, d };
}
const v = (s, d, type, cmd) => handlers[type].validate(s, d, { type, ...cmd });
const apply = (s, d, type, cmd) => handlers[type].apply(s, d, { type, ...cmd }, fakeEnv());
const unlockAll = (s) => {
  for (const k of ['job_digger', 'panel_colony', 'job_scout', 'job_herder', 'job_leafcutter', 'job_gardener']) s.run.unlocked[k] = true;
};
/** Advance jobs.tick for `seconds` in 0.1 s steps (run.time advanced here). */
function runJobs(s, d, seconds) {
  for (let i = 0; i < Math.round(seconds / 0.1); i++) {
    jobsTick(s, d, 0.1, fakeEnv());
    s.run.time += 0.1;
  }
}

test('idleMinors = minors − Σ jobs − militia (never below 0)', () => {
  const { s } = setup(10);
  s.run.colony.jobs.forager = 6;
  s.run.colony.militia = 1;
  assert.equal(idleMinors(s), 3);
  s.run.colony.militia = 8;
  assert.equal(idleMinors(s), 0);
});

test('jobCap: locked 0, gardener = d.stats.gardenerSlots, herder = Σ 8 × level per herder trail (×2 shepherding), others Infinity', () => {
  const { s, d } = setup();
  assert.equal(jobCap(s, d, 'digger'), 0, 'locked');
  assert.equal(jobCap(s, d, 'forager'), Infinity);
  assert.equal(jobCap(s, d, 'bogus'), 0);
  assert.equal(jobCap(s, d, '__proto__'), 0);
  unlockAll(s);
  d.stats.gardenerSlots = 15;
  assert.equal(jobCap(s, d, 'gardener'), 15);
  assert.equal(jobCap(s, d, 'herder'), 0, 'no herder trail');
  s.run.surface.sources.push({ uid: 5, type: 'aphid_colony', hex: 4, stock: -1, max: -1, level: 2, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 6, origin: 0, src: 5, path: [0, 4], len: 1, job: 'herder', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  assert.equal(jobCap(s, d, 'herder'), 16);
  s.run.research.aphid_shepherding = 1;
  assert.equal(jobCap(s, d, 'herder'), 32);
});

test('consistency: Σ jobs + militia > minors scales jobs down proportionally each tick', () => {
  const { s, d } = setup(10);
  s.run.colony.jobs = { forager: 8, digger: 4, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  s.run.colony.militia = 2;
  jobsTick(s, d, 0.1, fakeEnv());
  near(s.run.colony.jobs.forager + s.run.colony.jobs.digger, 8);
  near(s.run.colony.jobs.forager / s.run.colony.jobs.digger, 2);
});

test('releaseMinors takes from `job` first, then proportionally, and keeps Σ jobs + militia ≤ minors', () => {
  const { s } = setup(10);
  s.run.colony.jobs = { forager: 6, digger: 4, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  releaseMinors(s, 2, 'digger');
  assert.deepEqual([s.run.colony.jobs.forager, s.run.colony.jobs.digger], [6, 2]);
  releaseMinors(s, 4);
  near(s.run.colony.jobs.forager, 3);
  near(s.run.colony.jobs.digger, 1);
  s.run.colony.adults.minor = 2;
  releaseMinors(s, 0);
  near(s.run.colony.jobs.forager + s.run.colony.jobs.digger, 2);
});

test('shiftJob: locked target, empty source, cap, clamping to what is available', () => {
  const { s, d } = setup(10);
  assert.equal(v(s, d, 'shiftJob', { from: 'forager', to: 'digger', n: 2 }), 'locked');
  unlockAll(s);
  assert.equal(v(s, d, 'shiftJob', { from: 'forager', to: 'digger', n: 2 }), null);
  apply(s, d, 'shiftJob', { from: 'forager', to: 'digger', n: 2 });
  assert.deepEqual([s.run.colony.jobs.forager, s.run.colony.jobs.digger], [8, 2]);
  apply(s, d, 'shiftJob', { from: 'digger', to: 'idle', n: 50 });
  assert.equal(s.run.colony.jobs.digger, 0, 'clamped to the 2 available');
  assert.equal(idleMinors(s), 2);
  assert.equal(v(s, d, 'shiftJob', { from: 'digger', to: 'scout', n: 1 }), 'invalid:empty');
  apply(s, d, 'shiftJob', { from: 'idle', to: 'scout', n: 5 });
  assert.equal(s.run.colony.jobs.scout, 2);
  d.stats.gardenerSlots = 1;
  apply(s, d, 'shiftJob', { from: 'forager', to: 'gardener', n: 3 });
  assert.equal(s.run.colony.jobs.gardener, 1, 'cap');
  assert.equal(v(s, d, 'shiftJob', { from: 'forager', to: 'gardener', n: 1 }), 'max');
  for (const bad of [{ from: 'forager', to: 'forager', n: 1 }, { from: 'x', to: 'forager', n: 1 }, { from: 'forager', to: 'digger', n: 0 },
    { from: 'forager', to: 'digger', n: NaN }, { from: 'forager', to: 'digger', n: '1' }, { from: null, to: undefined, n: 1 },
    { from: '__proto__', to: 'digger', n: 1 }]) {
    assert.equal(v(s, d, 'shiftJob', bad), 'invalid', JSON.stringify(bad));
  }
});

test('setJobs: absolute counts within minors − militia, caps and locks', () => {
  const { s, d } = setup(10);
  assert.equal(v(s, d, 'setJobs', { jobs: { digger: 1 } }), 'locked');
  unlockAll(s);
  assert.equal(v(s, d, 'setJobs', { jobs: { forager: 5, digger: 5 } }), null);
  assert.equal(v(s, d, 'setJobs', { jobs: { digger: 5 } }), 'invalid:total', 'forager stays 10');
  d.stats.gardenerSlots = 2;
  assert.equal(v(s, d, 'setJobs', { jobs: { forager: 0, gardener: 3 } }), 'max');
  for (const bad of [null, [], 5, { forager: -1 }, { forager: NaN }, { bogus: 1 }, { __proto__: { forager: 1 } }]) {
    assert.ok(['invalid', null].includes(v(s, d, 'setJobs', { jobs: bad })), JSON.stringify(bad));
  }
  assert.equal(v(s, d, 'setJobs', { jobs: { bogus: 1 } }), 'invalid');
  apply(s, d, 'setJobs', { jobs: { forager: 4, digger: 3, nurse: 3 } });
  assert.deepEqual([s.run.colony.jobs.forager, s.run.colony.jobs.digger, s.run.colony.jobs.nurse], [4, 3, 3]);
});

test('setJobTargets needs job presets; Σ ≤ 1; copies into meta.automation.keep.jobTargets', () => {
  const { s, d } = setup(10);
  const targets = { forager: 0.5, digger: 0.3, nurse: 0.2 };
  assert.equal(v(s, d, 'setJobTargets', { targets }), 'locked');
  s.run.unlocked.job_presets = true;
  assert.equal(v(s, d, 'setJobTargets', { targets }), 'invalid:sum', 'scout keeps its 0.1');
  assert.equal(v(s, d, 'setJobTargets', { targets: { ...targets, scout: 0 } }), null);
  for (const bad of [null, { forager: 2 }, { forager: -0.1 }, { forager: 'x' }, { nope: 0.1 }]) {
    assert.equal(v(s, d, 'setJobTargets', { targets: bad }), 'invalid', JSON.stringify(bad));
  }
  apply(s, d, 'setJobTargets', { targets: { ...targets, scout: 0 } });
  assert.deepEqual(s.run.colony.jobTargets, { forager: 0.5, digger: 0.3, nurse: 0.2, scout: 0, herder: 0, leafcutter: 0, gardener: 0 });
  assert.deepEqual(s.meta.automation.keep.jobTargets, s.run.colony.jobTargets);
  assert.notEqual(s.meta.automation.keep.jobTargets, s.run.colony.jobTargets, 'a copy');
  const { s: s2, d: d2 } = setup(1);
  s2.cycle.traits.automaton_instincts = 1;
  assert.equal(v(s2, d2, 'setJobTargets', { targets: { scout: 0 } }), null, 'innate automation gives presets');
});

test('setAutoJobs / setThresholdJobs need age_polyethism / response_thresholds (or innate automation)', () => {
  const { s, d } = setup(10);
  assert.equal(v(s, d, 'setAutoJobs', { on: true }), 'locked');
  assert.equal(v(s, d, 'setAutoJobs', { on: false }), null);
  assert.equal(v(s, d, 'setAutoJobs', { on: 'yes' }), 'invalid');
  assert.equal(v(s, d, 'setThresholdJobs', { on: true }), 'locked');
  s.run.research.age_polyethism = 1;
  assert.equal(v(s, d, 'setAutoJobs', { on: true }), null);
  assert.equal(v(s, d, 'setThresholdJobs', { on: true }), 'locked');
  s.era.federation.automated_brood = 1;
  assert.equal(v(s, d, 'setThresholdJobs', { on: true }), null);
  apply(s, d, 'setAutoJobs', { on: true });
  apply(s, d, 'setThresholdJobs', { on: true });
  assert.equal(s.run.colony.autoJobs, true);
  assert.equal(s.run.colony.thresholdJobs, true);
});

test('auto mode: every 5 s jobs = targets × available minors; locked / capped shares go to foragers (C94)', () => {
  const { s, d } = setup(20);
  s.run.colony.militia = 4;
  s.run.colony.autoJobs = true;
  s.run.colony.jobTargets = { forager: 0.5, digger: 0.25, nurse: 0.25, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  s.run.unlocked.job_digger = true;                       // nurse still locked
  runJobs(s, d, 4.8);
  assert.equal(s.run.colony.jobs.forager, 16, 'no rebalance before 5 s (the consistency rule only trims to 16)');
  runJobs(s, d, 0.4);
  near(s.run.colony.jobs.forager, 16 * 0.75, 1e-9, 'the locked nurse share is foraged');
  near(s.run.colony.jobs.digger, 16 * 0.25);
  assert.equal(s.run.colony.jobs.nurse, 0);
  s.run.unlocked.panel_colony = true;
  s.run.unlocked.job_gardener = true;
  s.run.colony.jobTargets = { forager: 0.4, digger: 0.1, nurse: 0.1, scout: 0, herder: 0, leafcutter: 0, gardener: 0.4 };
  d.stats.gardenerSlots = 2;
  runJobs(s, d, 5);
  assert.equal(s.run.colony.jobs.gardener, 2, 'capped at the slots');
  near(s.run.colony.jobs.digger, 1.6);
  near(s.run.colony.jobs.nurse, 1.6);
  near(s.run.colony.jobs.forager, 16 * 0.4 + (6.4 - 2), 1e-9, 'the surplus over the gardener cap is foraged, not idle');
  assert.ok(idleMinors(s) < 1e-9);
  s.run.colony.jobTargets = { forager: 0.5, digger: 0, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  runJobs(s, d, 5);
  near(s.run.colony.jobs.forager, 8, 1e-9, 'targets summing to 0.5 leave half idle');
});

test('C94: auto mode converges existing workers to the targets (not only newborns) and undoes manual moves', () => {
  const { s, d } = setup(200);
  unlockAll(s);
  d.stats.broodSlots = 20;                                // C231: room for 40 useful nurses (cap 4 × 20 − 1)
  s.run.colony.autoJobs = true;
  s.run.colony.jobTargets = { forager: 0.3, digger: 0.4, nurse: 0.2, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 };
  runJobs(s, d, 5.1);
  const want = { forager: 60, digger: 80, nurse: 40, scout: 20 };
  for (const [j, n] of Object.entries(want)) near(s.run.colony.jobs[j], n, 1e-9, j);
  apply(s, d, 'shiftJob', { from: 'digger', to: 'forager', n: 30 });
  assert.equal(s.run.colony.jobs.digger, 50);
  runJobs(s, d, 5);
  near(s.run.colony.jobs.digger, 80, 1e-9, 'the next rebalance restores the target split');
});

test('C94: withTarget sets one target and scales the others down proportionally when Σ would pass 1', () => {
  const base = { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 };
  const a = withTarget(base, 'digger', 0.25);
  near(a.digger, 0.25);
  near(a.forager, 0.6 * 0.75 / 0.8);
  near(a.nurse, 0.1 * 0.75 / 0.8);
  const sum = (m) => Object.values(m).reduce((x, y) => x + y, 0);
  assert.ok(sum(a) <= 1 + 1e-12);
  near(sum(a), 1);
  const b = withTarget({ forager: 0.3, digger: 0.1, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 }, 'nurse', 0.2);
  assert.deepEqual([b.forager, b.digger, b.nurse], [0.3, 0.1, 0.2], 'room under 100 %: the others stay');
  const c = withTarget(base, 'forager', 1.4);
  assert.equal(c.forager, 1);
  assert.equal(sum(c), 1);
  assert.equal(withTarget(base, 'nurse', -1).nurse, 0);
  assert.deepEqual(withTarget(base, 'bogus', 1), base);
  assert.notEqual(withTarget(base, 'nurse', 0.1), base, 'a copy');
  // Every result passes setJobTargets' validation (Σ ≤ 1 + 1e-9), even after many nudges.
  const { s, d } = setup(10);
  s.run.unlocked.job_presets = true;
  let t = { ...base };
  for (let i = 0; i < 200; i++) {
    const j = ['forager', 'digger', 'nurse', 'scout'][i % 4];
    t = withTarget(t, j, t[j] + (i % 3 === 0 ? -0.05 : 0.05));
    assert.equal(v(s, d, 'setJobTargets', { targets: t }), null, JSON.stringify(t));
  }
});

test('C94 response thresholds: nurses up on bn_brood_slots (up to 4 per slot), back down when it clears; targets untouched', () => {
  const { s, d } = setup(100);
  unlockAll(s);
  s.run.research.response_thresholds = 1;
  s.run.colony.thresholdJobs = true;
  const targets = { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 };
  s.run.colony.jobTargets = { ...targets };
  d.stats.broodSlots = 10;                                // up to 40 nurses help
  s.run.bottleneck.id = 'bn_brood_slots';
  runJobs(s, d, 5.1);
  near(s.run.colony.jobBias.nurse, THRESHOLDS.shiftStep);
  near(effectiveTargets(s).nurse, 0.1 + THRESHOLDS.shiftStep);
  near(Object.values(effectiveTargets(s)).reduce((a, b) => a + b, 0), 1);
  near(s.run.colony.jobs.nurse, 100 * (0.1 + THRESHOLDS.shiftStep), 1e-9, 'the bias is assigned at once');
  assert.deepEqual(s.run.colony.jobTargets, targets, "the player's targets are never edited");
  runJobs(s, d, 60);
  assert.ok(s.run.colony.jobs.nurse <= 40 + 1e-9, 'never past 4 per brood slot: ' + s.run.colony.jobs.nurse);
  assert.ok(s.run.colony.jobs.nurse >= 39, 'raised to the useful maximum: ' + s.run.colony.jobs.nurse);
  near(s.run.colony.jobs.forager + s.run.colony.jobs.digger + s.run.colony.jobs.nurse + s.run.colony.jobs.scout, 100, 1e-9, 'nobody idle');
  s.run.bottleneck.id = 'bn_housing';
  runJobs(s, d, 5);
  assert.ok(s.run.colony.jobs.nurse < 40 && s.run.colony.jobs.nurse > 10, 'relaxes gradually');
  runJobs(s, d, 120);
  assert.equal(s.run.colony.jobBias, undefined, 'the bias is gone once it has decayed');
  near(s.run.colony.jobs.nurse, 10, 1e-9, 'back to the target');
  // Threshold mode off drops the bias at once.
  s.run.bottleneck.id = 'bn_brood_slots';
  runJobs(s, d, 10);
  assert.ok(s.run.colony.jobBias);
  apply(s, d, 'setThresholdJobs', { on: false });
  assert.equal(s.run.colony.jobBias, undefined);
});

test('C94 response thresholds: diggers up while the dig queue holds > 60 s of work, held above 30 s, relaxed below', () => {
  const { s, d } = setup(100);
  unlockAll(s);
  s.run.research.response_thresholds = 1;
  s.run.colony.thresholdJobs = true;
  s.run.colony.jobTargets = { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 };
  d.stats.digW = 1;
  d.nest.queueInfo = [{ uid: 3, work: 100, eta: 100 }];
  assert.equal(thresholdTriggers(s, d).digger, 1);
  runJobs(s, d, 10.1);
  near(s.run.colony.jobBias.digger, 2 * THRESHOLDS.shiftStep);
  near(s.run.colony.jobs.digger, 100 * (0.2 + 2 * THRESHOLDS.shiftStep), 1e-9, 'threshold mode also assigns');
  d.nest.queueInfo = [{ uid: 3, work: 45, eta: 45 }];
  assert.equal(thresholdTriggers(s, d).digger, 0);
  runJobs(s, d, 5);
  near(s.run.colony.jobBias.digger, 2 * THRESHOLDS.shiftStep, 1e-12, 'held');
  d.nest.queueInfo = [];
  runJobs(s, d, 5);
  near(s.run.colony.jobBias.digger, 2 * THRESHOLDS.shiftStep - THRESHOLDS.decayStep, 1e-12, 'relaxing');
  runJobs(s, d, 60);
  near(s.run.colony.jobs.digger, 20, 1e-9, 'back to the target');
  // The bias never takes a biased job past shiftMax.
  d.nest.queueInfo = [{ uid: 3, work: 1e6, eta: 1e6 }];
  s.run.colony.jobTargets = { forager: 0.1, digger: 0.45, nurse: 0.25, scout: 0.2, herder: 0, leafcutter: 0, gardener: 0 };
  runJobs(s, d, 100);
  near(effectiveTargets(s).digger, THRESHOLDS.shiftMax);
});

test('C94 response thresholds: herders up when honeydew is short and a herder trail has room; surplus over the cap foraged', () => {
  const { s, d } = setup(100);
  unlockAll(s);
  s.run.unlocked.adapt_honeydew = true;
  s.run.research.response_thresholds = 1;
  s.run.colony.thresholdJobs = true;
  recompute(s, d, fakeEnv());
  s.run.res.honeydew = 10;                                // Queen's Feast costs 50
  assert.equal(thresholdTriggers(s, d).herder, 0, 'short, but no herder trail: hold (nothing to raise)');
  runJobs(s, d, 5.2);
  assert.equal(s.run.colony.jobBias, undefined);
  s.run.surface.sources.push({ uid: 5, type: 'aphid_colony', hex: 4, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  s.run.surface.trails.push({ uid: 6, origin: 0, src: 5, path: [0, 4], len: 1, job: 'herder', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  assert.equal(thresholdTriggers(s, d).herder, 1);
  runJobs(s, d, 5);
  near(s.run.colony.jobBias.herder, THRESHOLDS.shiftStep);
  near(s.run.colony.jobs.herder, 5);
  runJobs(s, d, 10);
  assert.equal(s.run.colony.jobs.herder, 8, 'capped at the trail');
  assert.equal(thresholdTriggers(s, d).herder, 0, 'full: hold');
  assert.ok(idleMinors(s) < 1e-9, 'the share above the cap is foraged');
  s.run.res.honeydew = 1000;
  runJobs(s, d, 100);
  assert.equal(s.run.colony.jobs.herder, 0, 'back down once honeydew is no longer short');
  assert.equal(s.run.colony.jobBias, undefined);
});

test('C94: threshold bias is not saved in the targets, presets save/apply the player targets', () => {
  const { s, d } = setup(50);
  unlockAll(s);
  s.run.research.response_thresholds = 1;
  s.run.research.hive_mind = 1;
  s.run.colony.thresholdJobs = true;
  s.run.bottleneck.id = 'bn_brood_slots';
  d.stats.broodSlots = 100;
  runJobs(s, d, 20);
  assert.ok(s.run.colony.jobBias.nurse > 0);
  apply(s, d, 'saveJobPreset', { slot: 0, name: 'Base' });
  assert.deepEqual(s.meta.automation.jobPresets[0].targets, { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 });
  s.run.colony.jobTargets = withTarget(s.run.colony.jobTargets, 'scout', 0.5);
  apply(s, d, 'applyJobPreset', { slot: 0 });
  near(s.run.colony.jobTargets.scout, 0.1);
});

test('saved presets (hive_mind): save into slots 0..2 without gaps, apply restores targets', () => {
  const { s, d } = setup(10);
  assert.equal(v(s, d, 'saveJobPreset', { slot: 0, name: 'Dig' }), 'locked');
  s.run.research.hive_mind = 1;
  assert.equal(v(s, d, 'saveJobPreset', { slot: 1 }), 'invalid', 'no gap');
  assert.equal(v(s, d, 'saveJobPreset', { slot: 0, name: 'x'.repeat(41) }), 'invalid');
  for (const bad of [-1, 3, 0.5, '0', null]) assert.equal(v(s, d, 'saveJobPreset', { slot: bad }), 'invalid');
  apply(s, d, 'saveJobPreset', { slot: 0, name: 'Default' });
  s.run.colony.jobTargets = { forager: 1, digger: 0, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
  apply(s, d, 'saveJobPreset', { slot: 1 });
  assert.equal(s.meta.automation.jobPresets.length, 2);
  assert.equal(s.meta.automation.jobPresets[1].name, '');
  assert.equal(v(s, d, 'applyJobPreset', { slot: 2 }), 'notFound');
  assert.equal(v(s, d, 'applyJobPreset', { slot: 'a' }), 'notFound');
  apply(s, d, 'applyJobPreset', { slot: 0 });
  assert.deepEqual(s.run.colony.jobTargets, { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 });
  assert.deepEqual(s.meta.automation.keep.jobTargets, s.run.colony.jobTargets);
  apply(s, d, 'saveJobPreset', { slot: 0, name: 'Over' });
  assert.equal(s.meta.automation.jobPresets[0].name, 'Over');
  assert.equal(s.meta.automation.jobPresets.length, 2);
});
