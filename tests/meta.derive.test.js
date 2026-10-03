// WP7 unit tests: d.meta composition (ARCHITECTURE §8.6), effective hardship tiers, census, species/edict, and the
// prestige tick (projections, requirement flags, alates/min peak, ending).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { derive, tick, projectAlates, flightRequirements, superRequirements, specRequirements } from '../src/systems/prestige.js';
import { effectiveTier } from '../src/systems/hardships.js';
import { SPECIES } from '../src/data/genome.js';
import { SPEC } from '../src/data/prestige.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), msg + ': ' + a + ' vs ' + b);

test('neutral state gives neutral multipliers', () => {
  const s = newState(1);
  const d = makeDerived();
  derive(s, d);
  for (const [k, v] of Object.entries(d.meta.prestige)) assert.equal(v, 1, k);
  assert.equal(d.meta.colonyScale, 1);
  assert.equal(d.meta.lineage, 1);
  assert.equal(d.meta.achMult, 1);
  assert.equal(d.meta.census, 0);
  assert.equal(d.meta.species, 'garden_ant');
  assert.deepEqual(d.meta.sp, {});
  assert.equal(d.meta.edict, null);
  for (const v of Object.values(d.meta.hardship)) assert.equal(v, 0);
});

test('d.meta composition follows the pinned formulas', () => {
  const s = newState(1);
  const d = makeDerived();
  Object.assign(s.cycle.traits, { hardy_workers: 2, deep_diggers: 1, swarm_instinct: 1, sweet_inheritance: 1, fertile_queen: 1,
    wide_wings: 2, vast_galleries: 3 });
  s.cycle.alatesCycle = 30; // Λ = 2.5
  s.era.kinshipLife = 3;
  s.meta.genesLife = 4;
  Object.assign(s.meta.genome, { ancient_instinct: 1, haplodiploid_fecundity: 2, colossal_nests: 1, unicolonial_sprawl: 2 });
  s.era.federation.megacolony_galleries = 1;
  s.meta.achievements = { ach_a: 1, ach_b: 2, ach_c: 3, ach_wilsons_pride: 4, ach_swift_swarm: 5 };
  s.meta.signatureGenes = { sig_generalist: true, sig_polygyne: true, sig_fungal_farmers: true };
  s.cycle.hardshipTier.monomorphic = 2;
  s.era.hardshipBest.claustral_founding = 3; // effective 1.5 (50 % carry)
  s.cycle.edict = 'edict_of_war';
  s.era.species = 'fire_ant';
  derive(s, d);
  const m = d.meta;
  const K = 3;
  const G = 4;
  const ach = 1.01 ** 5;
  const sigAll = 1.1 * 1.03;
  const mono = 1.3 ** 2;
  const kO = (1 + K) ** 0.5;
  const gO = (1 + G) ** 0.25;
  close(m.prestige.food, 2.5 * 1.4 ** 2 * (1 + K) ** 1.25 * (1 + G) ** 1.5 * ach * mono * sigAll, 'food');
  close(m.prestige.dig, 1.4 * kO * gO * ach * mono * sigAll, 'dig');
  close(m.prestige.insight, 1.5 * 10 * kO * gO * ach * sigAll, 'insight');
  close(m.prestige.honeydew, 1.4 ** 2 * 2 * kO * gO * ach * mono * sigAll, 'honeydew');
  close(m.prestige.leaves, 1.4 ** 2 * kO * gO * ach * mono * sigAll, 'leaves');
  close(m.prestige.fungus, kO * gO * ach * sigAll * 2, 'fungus');
  close(m.prestige.chitin, kO * gO * ach * sigAll, 'chitin');
  close(m.prestige.lay, 2.5 ** 0.25 * 1.25 * 2 ** 2 * 1.3 ** 1.5 * 1.5, 'lay');
  close(m.prestige.ap, 1 + G, 'ap');
  close(m.prestige.alates, (1 + K) ** 0.25 * 1.15 ** 2 * 1.1, 'alates');
  close(m.colonyScale, 1.2 ** 3 * (1 + K) ** 0.2 * 2 * 10 * 2 ** 2, 'colonyScale');
  assert.equal(m.lineage, 2.5);
  assert.equal(m.K, K);
  assert.equal(m.G, G);
  assert.equal(m.achCount, 5);
  close(m.achMult, ach, 'achMult');
  assert.equal(m.hardship.monomorphic, 2);
  assert.equal(m.hardship.claustral_founding, 1.5);
  assert.equal(m.edict, 'edict_of_war');
  assert.equal(m.species, 'fire_ant');
  assert.deepEqual(m.sp, SPECIES.fire_ant.mods);
});

test('fossil_record raises the achievement bonus to ×1.02 each', () => {
  const s = newState(1);
  const d = makeDerived();
  s.meta.achievements = { a: 1, b: 1, c: 1 };
  s.meta.genome.fossil_record = 1;
  derive(s, d);
  close(d.meta.achMult, 1.02 ** 3, 'achMult');
});

test('census = adults × (1 + 0.25 × satellites)', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.colony.adults = { minor: 900, soldier: 50, supermajor: 10, replete: 40 };
  s.run.colony.alatesReared = 999; // alates are not adults
  s.run.surface.entrances.push({ kind: 'satellite', hex: 40, col: 4, ref: 0 }, { kind: 'satellite', hex: 50, col: 36, ref: 1 },
    { kind: 'outpost', hex: 60, col: -1, ref: 3 });
  derive(s, d);
  assert.equal(d.meta.census, 1000 * 1.5);
});

test('effectiveTier = max(cycle tier, 50 % of the era best)', () => {
  const s = newState(1);
  assert.equal(effectiveTier(s, 'pacifist'), 0);
  s.era.hardshipBest.pacifist = 4;
  assert.equal(effectiveTier(s, 'pacifist'), 2);
  s.cycle.hardshipTier.pacifist = 3;
  assert.equal(effectiveTier(s, 'pacifist'), 3);
  s.cycle.hardshipTier.pacifist = 1;
  assert.equal(effectiveTier(s, 'pacifist'), 2);
});

test('derive keeps multipliers finite for extreme lifetime counters', () => {
  const s = newState(1);
  const d = makeDerived();
  s.era.kinshipLife = 1e295;
  s.meta.genesLife = 1e295;
  s.cycle.alatesCycle = 1e295;
  derive(s, d);
  for (const [k, v] of Object.entries(d.meta.prestige)) assert.ok(Number.isFinite(v) && v > 0, k + ' = ' + v);
  assert.ok(Number.isFinite(d.meta.colonyScale));
});

/** A state that meets every flight requirement. */
function flyReady() {
  const s = newState(3);
  const d = makeDerived();
  s.run.fRun = 1e9;
  s.run.research.nuptial_preparation = 1;
  d.nest.agg.royalL = 5;
  d.nest.agg.nuptial = { active: true, level: 1, shaftOpen: true };
  return { s, d };
}

test('flight requirement flags', () => {
  const { s, d } = flyReady();
  assert.deepEqual(flightRequirements(s, d), { ok: true, royal5: true, prep: true, chamber: true, fRun: true });
  d.nest.agg.royalL = 4;
  assert.equal(flightRequirements(s, d).royal5, false);
  assert.equal(flightRequirements(s, d).ok, false);
  d.nest.agg.royalL = 5;
  s.run.fRun = 9.9e7;
  assert.equal(flightRequirements(s, d).fRun, false);
  s.run.fRun = 1e8;
  d.nest.agg.nuptial.active = false;
  assert.equal(flightRequirements(s, d).chamber, false);
});

test('supercolony and speciation requirement flags read the boss rivals', () => {
  const s = newState(1);
  const d = makeDerived();
  assert.equal(superRequirements(s, d).ok, false);
  s.cycle.traits.budding = 1;
  s.cycle.alatesCycle = 5000;
  s.run.rivals.list.push({ uid: 1, type: 'old_ridge_supercolony', alive: true, fallenAt: -1 });
  assert.deepEqual(superRequirements(s, d), { ok: false, budding: true, alates: true, oldRidge: false });
  s.run.rivals.list[0].alive = false;
  s.run.rivals.list[0].fallenAt = 1200;
  assert.equal(superRequirements(s, d).ok, true);

  s.era.federation.megacolony = 1;
  s.era.kinshipLife = SPEC.kinshipMin; // the Speciation gate (1,000)
  for (let i = 0; i < 3; i++) s.run.rivals.list.push({ uid: 10 + i, type: 'great_rival', alive: false, fallenAt: 500 });
  assert.equal(specRequirements(s, d).ok, true);
  s.run.rivals.list[2].alive = true; // a regrown nest
  s.run.rivals.list[2].fallenAt = -1;
  assert.deepEqual(specRequirements(s, d), { ok: false, megacolony: true, front: false, kinship: true });
});

test('tick fills projections and flags, tracks the alates/min peak', () => {
  const { s, d } = flyReady();
  const env = fakeEnv();
  s.run.time = 600;
  derive(s, d);
  tick(s, d, 0.1, env);
  const p = d.meta.proj;
  assert.equal(p.alates, projectAlates(s, d));
  assert.ok(Math.abs(p.perMin - p.alates / 10) < 1e-9);
  assert.equal(p.fly.ok, true);
  assert.equal(s.run.prestige.peakRate, p.perMin);
  assert.equal(s.run.prestige.peakAt, 600);
  s.run.time = 1200; // same projection over twice the time: rate halves, the peak stays
  tick(s, d, 0.1, env);
  assert.equal(s.run.prestige.peakAt, 600);
  assert.ok(d.meta.proj.perMin < s.run.prestige.peakRate);
});

test('ending: emitted once when census reaches 2e16, not offline, not after it was acknowledged', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.colony.adults.minor = 2e16;
  derive(s, d);
  const off = fakeEnv({ offline: true });
  tick(s, d, 60, off);
  assert.equal(off.events.filter((e) => e.type === 'ending').length, 0);
  const env = fakeEnv();
  tick(s, d, 0.1, env);
  tick(s, d, 0.1, env);
  assert.equal(env.events.filter((e) => e.type === 'ending').length, 1);
  const d2 = makeDerived();
  s.meta.flags.endingSeen = true;
  derive(s, d2);
  const env2 = fakeEnv();
  tick(s, d2, 0.1, env2);
  assert.equal(env2.events.filter((e) => e.type === 'ending').length, 0);
});
