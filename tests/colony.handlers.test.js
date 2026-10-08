// WP2 unit tests — ARCHITECTURE §15.3 #16 for every WP2 command: validate() never throws and rejects garbage with a
// reason code; apply() (only after validate() returned null) never throws, keeps the state finite / JSON-safe and
// mutates only the fields the command owns. Also a short random run of the WP2 systems from extreme states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, findBadValues, randomCommand, allUnlockKeys } from './helpers.js';
import { handlers as economyH, tick as economyTick } from '../src/systems/economy.js';
import { handlers as populationH, tick as populationTick } from '../src/systems/population.js';
import { handlers as jobsH, tick as jobsTick } from '../src/systems/jobs.js';
import { handlers as adaptationsH } from '../src/systems/adaptations.js';
import { tick as bottleneckTick } from '../src/systems/bottleneck.js';
import { recompute } from '../src/systems/stats.js';
import { makeHolder, rand, pick } from '../src/core/rng.js';

const ALL = { ...economyH, ...populationH, ...jobsH, ...adaptationsH };
const TYPES = Object.keys(ALL).sort();
const REASONS = new Set(['unknown', 'paused', 'locked', 'cantAfford', 'invalid', 'max', 'noSlot', 'blocked', 'cooldown', 'busy', 'hardship',
  'notFound', 'queueFull', 'clickCap', 'requirements']);

/** Fields each command may write (dotted path prefixes). */
const OWNED = {
  clickForage: ['run.res.food', 'run.fRun', 'meta.stats.foodEver', 'run.stats.foodWasted', 'run.clicks', 'meta.counters.clicks'],
  setCasteTargets: ['run.colony.casteGoals', 'run.colony.casteFill', 'run.colony.casteTouched', 'meta.automation.keep.casteGoals',
    'meta.automation.keep.casteFill', 'meta.automation.keep.casteTargets'],
  setCasteFill: ['run.colony.casteGoals', 'run.colony.casteFill', 'run.colony.casteTouched', 'meta.automation.keep.casteGoals',
    'meta.automation.keep.casteFill', 'meta.automation.keep.casteTargets'],
  setEggReserve: ['run.colony.eggReserve'],
  setChitinReserve: ['run.colony.chitinReserve'],
  setFungalBrood: ['run.colony.fungalBrood'],
  rearAlate: ['run.colony.rearRequested'],
  cancelRear: ['run.colony.rearRequested'],
  groomBrood: ['run.colony.brood', 'run.clicks', 'meta.counters.clicks'],
  clickQueen: ['run.clicks', 'meta.counters.clicks', 'meta.counters.queenClicks'],
  retireAdults: ['run.colony.adults', 'run.colony.jobs'],
  shiftJob: ['run.colony.jobs'],
  setJobs: ['run.colony.jobs'],
  setJobTargets: ['run.colony.jobTargets', 'meta.automation.keep.jobTargets'],
  setAutoJobs: ['run.colony.autoJobs'],
  setThresholdJobs: ['run.colony.thresholdJobs'],
  saveJobPreset: ['meta.automation.jobPresets'],
  applyJobPreset: ['run.colony.jobTargets', 'meta.automation.keep.jobTargets'],
  buyAdaptation: ['run.res', 'run.adaptations'],
};

/** Changed leaf paths between two JSON values. */
function diffPaths(a, b, path = '', out = []) {
  if (a === b) return out;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    out.push(path);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], path ? path + '.' + k : k, out);
  return out;
}

/** A state where most WP2 commands can pass validation. */
function richWorld() {
  const s = newState(3);
  const d = makeDerived();
  for (const k of allUnlockKeys()) s.run.unlocked[k] = true;
  for (const r of ['fungiculture', 'hive_mind', 'age_polyethism', 'response_thresholds', 'scent_marking']) s.run.research[r] = 1;
  for (const k of Object.keys(s.run.res)) s.run.res[k] = 1e6;
  s.run.colony.adults = { minor: 50, soldier: 20, supermajor: 5, replete: 5 };
  s.run.colony.jobs.forager = 40;
  s.run.colony.brood = [{ c: 'minor', n: 3, p: 0.4, t: 0 }];
  Object.assign(d.nest.agg, { housingBase: 200, berthsBase: 40, repleteBerthsBase: 20, alateCells: 10, gardenerSlots: 5,
    nuptial: { active: true, level: 1, shaftOpen: true } });
  d.nest.agg.broodGroups.push({ kind: 'nursery', uid: 2, cap: 3, factor: 1.15, exposed: false, snap: false, inReach: false });
  d.combat.garrison = { soldier: 20, supermajor: 5 };
  recompute(s, d, fakeEnv());
  return { s, d };
}

test('every WP2 command: validate never throws and returns null or a ReasonCode; apply never throws and writes only owned fields', () => {
  const h = makeHolder(424242);
  const problems = [];
  let applied = 0;
  for (let round = 0; round < 25; round++) {
    const { s, d } = richWorld();
    for (let i = 0; i < 100; i++) {
      const cmd = randomCommand(h, s, TYPES, { pGarbage: rand(h) < 0.5 ? 0.4 : 0 });
      if (rand(h) < 0.05) cmd.type = pick(h, TYPES);
      let reason;
      try {
        reason = ALL[cmd.type].validate(s, d, cmd);
      } catch (e) {
        problems.push(cmd.type + ' validate threw ' + e.message + ' on ' + JSON.stringify(cmd));
        continue;
      }
      if (reason !== null) {
        if (typeof reason !== 'string' || !REASONS.has(reason.split(':')[0])) problems.push(cmd.type + ' bad reason ' + String(reason));
        continue;
      }
      const before = JSON.parse(JSON.stringify(s));
      const env = fakeEnv();
      try {
        ALL[cmd.type].apply(s, d, cmd, env);
        applied++;
      } catch (e) {
        problems.push(cmd.type + ' apply threw ' + e.message + ' on ' + JSON.stringify(cmd));
        continue;
      }
      const bad = findBadValues(s, 3);
      if (bad.length) problems.push(cmd.type + ' left ' + bad.join(', '));
      const after = JSON.parse(JSON.stringify(s));
      for (const p of diffPaths(before, after)) {
        if (!OWNED[cmd.type].some((o) => p === o || p.startsWith(o + '.'))) problems.push(cmd.type + ' wrote ' + p);
      }
      if (JSON.stringify(after) !== JSON.stringify(s) || diffPaths(after, s).length) problems.push(cmd.type + ' state not JSON-stable');
      if (round % 10 === 0) recompute(s, d, fakeEnv());
    }
  }
  assert.deepEqual(problems.slice(0, 10), []);
  assert.ok(applied > 300, 'enough commands were applied (' + applied + ')');
});

test('random WP2 ticks (online, offline 60 s, dt 0, diapause) from extreme states keep the state finite and JSON-safe', () => {
  const h = makeHolder(99);
  const scenarios = [
    () => richWorld(),
    () => {
      const w = richWorld();
      for (const k of Object.keys(w.s.run.res)) w.s.run.res[k] = 1e290;
      w.s.run.colony.adults = { minor: 1e12, soldier: 1e9, supermajor: 1e6, replete: 1e6 };
      w.s.run.colony.jobs = { forager: 4e11, digger: 3e11, nurse: 1e11, scout: 1e11, herder: 0, leafcutter: 0, gardener: 1e9 };
      w.d.meta.colonyScale = 1e12;
      w.d.meta.prestige.lay = 1e6;
      return w;
    },
    () => {
      const w = richWorld();
      for (const k of Object.keys(w.s.run.res)) w.s.run.res[k] = 0;
      w.s.meta.settings.harshNature = true;
      Object.assign(w.d.season, { id: 'winter', year: 3, mild: false });
      w.d.nest.agg.broodGroups[1].exposed = true;
      return w;
    },
  ];
  const problems = [];
  for (const make of scenarios) {
    const { s, d } = make();
    for (let i = 0; i < 1500; i++) {
      const r = rand(h);
      const dt = r < 0.03 ? 0 : r < 0.08 ? 60 : 0.1;
      const env = fakeEnv({ dt, offline: dt === 60, eff: dt === 60 ? 0.5 : 1, econScale: r > 0.95 ? 3 : 1 });
      if (rand(h) < 0.2) {
        const cmd = randomCommand(h, s, TYPES, { pGarbage: 0.1 });
        if (ALL[cmd.type].validate(s, d, cmd) === null) ALL[cmd.type].apply(s, d, cmd, env);
      }
      for (const k of Object.keys(d.ledger)) d.ledger[k] = {};
      d.ledger.food.trails = rand(h) * 10 * Math.max(1, s.run.colony.jobs.forager);
      d.ledger.leaves.trails = rand(h) * 3;
      recompute(s, d, env);
      economyTick(s, d, dt, env);
      populationTick(s, d, dt, env);
      jobsTick(s, d, dt, env);
      bottleneckTick(s, d, dt, env);
      s.run.time += dt;
      if (env.offline && env.events.some((e) => e.type === 'adultsDied' || e.type === 'broodDied')) problems.push('death offline');
      if (i % 50 === 0) {
        const bad = findBadValues(s, 3);
        if (bad.length) { problems.push('tick ' + i + ': ' + bad.join(', ')); break; }
      }
    }
  }
  assert.deepEqual(problems, []);
});
