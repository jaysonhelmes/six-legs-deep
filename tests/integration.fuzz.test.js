// INTEGRATION TEST — ARCHITECTURE §15.3 #9 / DESIGN §28.1 #9, §18 C46. Owner: WP1.
// Random ticks (online, dt 0, offline 10/60 s, diapause speed) and random commands (incl. garbage arguments) from
// extreme states: the state never holds NaN/Infinity, |x| > 1e295, undefined, or non-JSON objects; the NaN guard never
// has to step in; no handler throws; the state stays JSON round-trippable. 1e5 ticks by default, 1e6 with FUZZ=full
// (FUZZ_TICKS=n overrides). Passes against the WP1 stubs; it becomes meaningful once the systems land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { createDerived } from '../src/core/derived.js';
import { step } from '../src/core/step.js';
import { REGISTRY } from '../src/core/commands.js';
import { makeHolder, rand, randInt, pick } from '../src/core/rng.js';
import { randomCommand, findBadValues, allUnlockKeys, LIVE_IDS } from './helpers.js';

const TOTAL = process.env.FUZZ === 'full' ? 1e6 : Number(process.env.FUZZ_TICKS) > 0 ? Number(process.env.FUZZ_TICKS) : 1e5;
const TYPES = Object.keys(REGISTRY).sort();

const BIG = 1e290;

/** Extreme starting states (mutations applied after newGame). */
const SCENARIOS = {
  fresh() {},
  rich(s) {
    for (const k of Object.keys(s.run.res)) s.run.res[k] = BIG;
    s.run.fRun = BIG;
    s.meta.stats.foodEver = BIG;
    s.cycle.alates = BIG; s.cycle.alatesCycle = 1e12;
    s.era.kinship = BIG; s.era.kinshipLife = 1e9;
    s.meta.genes = BIG; s.meta.genesLife = 1e8;
    s.run.colony.adults = { minor: 1e12, soldier: 1e9, supermajor: 1e6, replete: 1e6 };
    s.run.colony.jobs = { forager: 4e11, digger: 3e11, nurse: 1e11, scout: 1e11, herder: 0, leafcutter: 0, gardener: 0 };
    s.run.colony.alatesReared = 1e4;
    s.run.colony.brood = [{ c: 'minor', n: 1e10, p: 0.5, t: 0 }, { c: 'soldier', n: 1e7, p: 0.9, t: 0 }];
    for (const k of allUnlockKeys()) { s.run.unlocked[k] = true; s.meta.seen[k] = true; }
    for (const id of LIVE_IDS.research) s.run.research[id] = 1;
    for (const id of LIVE_IDS.adaptations) s.run.adaptations[id] = 40;
    for (const id of LIVE_IDS.traits) s.cycle.traits[id] = 3;
    for (const id of LIVE_IDS.federation) s.era.federation[id] = 2;
    for (const id of LIVE_IDS.genome) s.meta.genome[id] = 2;
    for (const id of LIVE_IDS.species) s.meta.speciesUnlocked[id] = true;
    s.run.surface.mound = 30;
    s.meta.counters.supercolonies = 50;
    s.meta.counters.speciations = 5;
    s.meta.diapause = { bank: 28800, active: true };
  },
  broke(s) {
    for (const k of Object.keys(s.run.res)) s.run.res[k] = 0;
    s.run.colony.adults = { minor: 3, soldier: 1e5, supermajor: 1e3, replete: 0 };
    s.run.colony.jobs.forager = 3;
    s.run.colony.hungry = true;
    s.run.colony.brood = [{ c: 'minor', n: 5, p: 0.2, t: 0 }];
    s.meta.settings.harshNature = true;
  },
  winter(s) {
    s.meta.season.year = 5;
    s.meta.season.t = 3 * s.meta.season.lengthSec + 10;
    s.run.hardship = 'eternal_winter';
    s.meta.settings.harshNature = true;
    s.run.colony.adults.minor = 50;
    s.run.colony.jobs.forager = 30;
    s.run.colony.jobs.digger = 20;
    s.run.colony.brood = [{ c: 'minor', n: 3, p: 0.6, t: 0 }];
    s.run.res.food = 100;
  },
  pending(s) {
    s.cycle.alates = 500;
    s.meta.pending = { kind: 'landing',
      options: [{ seed: 11, tags: ['site_rich_loam'] }, { seed: 12, tags: [] }, { seed: 13, tags: ['site_wet_hollow', 'site_stony_ground'] }],
      boons: ['boon_old_trails', 'boon_chitin_hoard', 'boon_long_spring'], chooseSeason: true, alates: 50, hardship: null };
  },
};

/** First path where a value differs from its JSON image (-0, undefined, NaN …), or null. */
function jsonDiff(a, b, path) {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return path + ' = ' + (Object.is(a, -0) ? '-0' : String(a)) + ' (JSON: ' + String(b) + ')';
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const r = jsonDiff(a[k], b[k], path + '.' + k);
    if (r) return r;
  }
  return null;
}

/** Run one scenario; returns problem lists. */
function runScenario(name, ticks, seed) {
  const problems = [];
  const nanGuards = new Set();
  const exceptions = new Set();
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  SCENARIOS[name](g.s);
  step(g.s, g.d, 0, [], {});
  const h = makeHolder((seed * 2654435761) >>> 0);
  for (let i = 0; i < ticks; i++) {
    const cmds = [];
    if (rand(h) < 0.3) {
      const n = randInt(h, 1, 3);
      for (let k = 0; k < n; k++) cmds.push(randomCommand(h, g.s, TYPES, { pGarbage: 0.05 }));
    }
    let dt = 0.1;
    let opts = { offline: false, eff: 1, econScale: 1 };
    const r = rand(h);
    if (r < 0.02) dt = 0;
    else if (r < 0.05) { dt = pick(h, [10, 60]); opts = { offline: true, eff: pick(h, [0.25, 0.5, 1]), econScale: 1 }; }
    else if (r < 0.08) opts = { offline: false, eff: 1, econScale: pick(h, [2, 3]) };
    let ev;
    try {
      ev = step(g.s, g.d, dt, cmds, opts);
    } catch (e) {
      problems.push(name + ' tick ' + i + ': step threw: ' + String(e && e.stack).split('\n').slice(0, 4).join(' | ')
        + ' | commands ' + JSON.stringify(cmds));
      break;
    }
    for (const e of ev) {
      if (e.type === 'nanGuard') nanGuards.add(e.path);
      else if (e.type === 'commandRejected' && String(e.reason).startsWith('invalid:exception')) {
        exceptions.add(e.cmd.type + (e.detail ? ' (apply): ' + e.detail : ' (validate)'));
      }
    }
    if (i % 100 === 99 || i === ticks - 1) {
      const bad = findBadValues(g.s, 5);
      if (bad.length) {
        problems.push(name + ' tick ' + i + ': ' + bad.join('; '));
        break;
      }
    }
    if (i % 5000 === 4999) {
      const diff = jsonDiff(g.s, JSON.parse(JSON.stringify(g.s)), 's');
      if (diff) {
        problems.push(name + ' tick ' + i + ': state is not JSON round-trippable (ground rule 4): ' + diff);
        break;
      }
    }
    if (i % 7919 === 7918) { // occasionally rebuild d from s, as after a load
      g.d = createDerived();
      step(g.s, g.d, 0, [], {});
    }
  }
  return { problems, nanGuards: [...nanGuards], exceptions: [...exceptions] };
}

const names = Object.keys(SCENARIOS);
const per = Math.ceil(TOTAL / names.length);
names.forEach((name, idx) => {
  test('fuzz "' + name + '": ' + per + ' random ticks + commands keep the state finite, clamped and plain', () => {
    const orig = console.error;
    console.error = () => {};
    let res;
    try {
      res = runScenario(name, per, 1000 + idx);
    } finally {
      console.error = orig;
    }
    assert.deepEqual(res.problems, []);
    assert.deepEqual(res.nanGuards, [], 'the NaN guard had to repair these paths');
    assert.deepEqual(res.exceptions, [], 'these handlers threw instead of rejecting bad input');
  });
});
