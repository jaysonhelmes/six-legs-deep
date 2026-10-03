// Meta / prestige regression tests for bug-hunt findings F11 (alates spent in the landing chooser apply to the new
// run), F17 (Chronobiology's starting season applies at run start, never teleports the clock) and F18 (whole-number
// Bloodline / Federation / Genome costs). ARCHITECTURE §18 holds the matching clarifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { traitCost, fedCost, genomeCost, handlers as traitHandlers } from '../src/systems/traits.js';
import { handlers, newGame, doSupercolony } from '../src/systems/prestige.js';
import * as seasons from '../src/systems/seasons.js';
import { validateCommand } from '../src/core/commands.js';
import { TRAITS, TRAIT_ORDER } from '../src/data/bloodline.js';
import { FEDERATION, FED_ORDER } from '../src/data/federation.js';
import { GENOME, GENOME_ORDER } from '../src/data/genome.js';
import { FOUNDING_STORES } from '../src/data/prestige.js';

/** A game whose run meets every flight requirement. */
function flyReady(seed = 5) {
  const s = newState(seed);
  const d = makeDerived();
  newGame(s, d);
  s.run.fRun = 1e9;
  s.run.tPeak = 120;
  s.run.research.nuptial_preparation = 1;
  d.nest.agg.royalL = 5;
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  return { s, d };
}

const fly = (s, d) => handlers.fly.apply(s, d, { type: 'fly' }, fakeEnv());
const land = (s, d, extra = {}) => handlers.chooseLanding.apply(s, d, { type: 'chooseLanding', index: 0, boon: s.meta.pending.boons[0], ...extra }, fakeEnv());

// ------------------------------------------------------------------------------------------------ F18
test('F18: every Bloodline / Federation / Genome cost is a whole number at every level', () => {
  const s = newState(1);
  const tables = [[TRAITS, TRAIT_ORDER, s.cycle.traits, traitCost, 'alates'], [FEDERATION, FED_ORDER, s.era.federation, fedCost, 'kinship'],
    [GENOME, GENOME_ORDER, s.meta.genome, genomeCost, 'genes']];
  for (const [table, order, map, fn, res] of tables) {
    for (const id of order) {
      const n = table[id].max > 0 ? table[id].max : 40;
      for (let L = 0; L < n; L++) {
        map[id] = L;
        const c = fn(s, id);
        assert.ok(c && Number.isInteger(c[res]), id + ' L' + L + ' cost ' + (c && c[res]));
      }
      delete map[id];
    }
  }
});

test('F18: buying traits never leaves a fraction of an alate behind', () => {
  const s = newState(1);
  const d = makeDerived();
  s.cycle.alates = 105;
  for (const id of ['hardy_workers', 'hardy_workers', 'deep_diggers', 'fertile_queen', 'fertile_queen']) {
    assert.equal(traitHandlers.buyTrait.validate(s, d, { type: 'buyTrait', id }), null, id);
    traitHandlers.buyTrait.apply(s, d, { type: 'buyTrait', id });
    assert.ok(Number.isInteger(s.cycle.alates), 'alates ' + s.cycle.alates);
  }
});

// ------------------------------------------------------------------------------------------------ F11
test('F11: alates are spendable while the landing chooser is open, and run-start traits apply to that landing', () => {
  const { s, d } = flyReady();
  fly(s, d);
  assert.ok(s.meta.pending, 'landing chooser open');
  s.cycle.alates = 50;
  for (const id of ['founding_stores', 'nanitic_vigor', 'remembered_paths', 'automaton_instincts', 'seasonal_wisdom']) {
    assert.equal(validateCommand(s, d, { type: 'buyTrait', id }), null, id + ' buyable while paused');
    traitHandlers.buyTrait.apply(s, d, { type: 'buyTrait', id });
  }
  assert.equal(s.meta.pending.chooseSeason, true, 'Seasonal Wisdom bought in the chooser lets this landing pick a season');
  land(s, d, { season: 'summer' });
  assert.equal(s.run.res.food >= FOUNDING_STORES[1].food, true, 'Founding Stores food in the new run');
  assert.equal(s.run.colony.naniticsLeft, TRAITS.nanitic_vigor.fx.eggs, 'Nanitic Vigor in the new run');
  assert.ok(s.run.surface.trails.length > 1, 'Remembered Paths drew a trail besides the crumb trail');
  assert.equal(s.run.colony.autoJobs, true, 'Automaton Instincts automation in the new run');
  assert.equal(seasons.seasonAt(s.meta, s.meta.season.t).id, 'summer');
});

// ------------------------------------------------------------------------------------------------ F17
test('F17: Chronobiology length changes keep the position in the year; a starting season never teleports the clock', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.genome.chronobiology = 1;
  const h = seasons.handlers.setChronobiology;
  s.meta.season.t = 1000;          // late autumn at 360 s seasons (autumn = [720, 1080))
  const env = fakeEnv();
  assert.equal(h.validate(s, d, { type: 'setChronobiology', lengthSec: 180, start: 'summer' }), null);
  h.apply(s, d, { type: 'setChronobiology', lengthSec: 180, start: 'summer' }, env);
  assert.equal(s.meta.season.lengthSec, 180);
  assert.ok(Math.abs(s.meta.season.t - 1000 / 2) < 1e-6, 'proportional position kept (still late autumn), got ' + s.meta.season.t);
  assert.equal(seasons.seasonAt(s.meta, s.meta.season.t).id, 'autumn');
  assert.ok(!env.events.some((e) => e.type === 'seasonChanged'), 'no season jump');
  assert.equal(s.meta.season.start, 'summer', 'the starting season is stored for the next run start');
  // Pressing Apply again every autumn never skips winter.
  s.meta.season.t = 3 * 180 - 1;   // last second of autumn
  h.apply(s, d, { type: 'setChronobiology', lengthSec: 180, start: 'spring' }, env);
  seasons.tick(s, d, 2, fakeEnv({ dt: 2 }));
  assert.equal(d.season.id, 'winter', 'winter still arrives');
  // A length-only Apply keeps the stored start; start: null clears it.
  h.apply(s, d, { type: 'setChronobiology', lengthSec: 240 }, env);
  assert.equal(s.meta.season.start, 'spring');
  h.apply(s, d, { type: 'setChronobiology', lengthSec: 240, start: null }, env);
  assert.equal(s.meta.season.start ?? null, null);
});

test('F17: the stored Chronobiology starting season applies at the next landing (a Seasonal Wisdom pick wins)', () => {
  const { s, d } = flyReady();
  s.meta.genome.chronobiology = 1;
  seasons.handlers.setChronobiology.apply(s, d, { type: 'setChronobiology', lengthSec: 360, start: 'summer' }, fakeEnv());
  s.meta.season.t = 1100;          // winter
  fly(s, d);
  land(s, d);
  assert.equal(seasons.seasonAt(s.meta, s.meta.season.t).id, 'summer', 'Chronobiology start season at the landing');
  // With Seasonal Wisdom the landing's own pick wins.
  s.cycle.traits.seasonal_wisdom = 1;
  s.run.fRun = 1e9;
  s.run.research.nuptial_preparation = 1;
  d.nest.agg.royalL = 5;
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  fly(s, d);
  land(s, d, { season: 'autumn' });
  assert.equal(seasons.seasonAt(s.meta, s.meta.season.t).id, 'autumn');
});

test('F17: the stored starting season also applies at a Supercolony (era / cycle start); without the gene it is ignored', () => {
  const { s, d } = flyReady();
  s.meta.genome.chronobiology = 1;
  s.meta.season.start = 'autumn';
  s.meta.season.t = 100;
  doSupercolony(s, d, fakeEnv(), { edict: null });
  assert.equal(seasons.seasonAt(s.meta, s.meta.season.t).id, 'autumn');
  delete s.meta.genome.chronobiology;
  s.meta.season.t = 100;
  doSupercolony(s, d, fakeEnv(), { edict: null });
  assert.equal(seasons.seasonAt(s.meta, s.meta.season.t).id, 'spring', 'no Chronobiology, no jump');
});
