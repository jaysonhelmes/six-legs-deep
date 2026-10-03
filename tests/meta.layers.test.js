// WP7 unit tests: Supercolony (kinship, heirlooms, edict, signature gene, what resets), Speciation (genes,
// genetic_memory, eusocial_leap, species), setHeirlooms and placeSatellite validation (DESIGN §14, §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv, snapshot } from './helpers.js';
import { handlers, doSupercolony, newGame } from '../src/systems/prestige.js';
import { SPEC } from '../src/data/prestige.js';
import { countInRadius } from '../src/core/hex.js';

/** A rival record as WP5 would leave it after a conquest. */
const fallen = (uid, type) => ({ uid, type, tier: 0, hex: 100 + uid, radius: 3, base: 0, n: 0, atk: 1, hp: 1, traits: [], alive: false,
  sighted: true, raidIn: 0, truce: 0, bribeCd: 0, tourCd: 0, creepIn: 0, group: type === 'great_rival' ? 1 : 0, fallenAt: 900, extra: [],
  lost: [], stolen: 0 });

/** A game whose run meets the Supercolony requirements (20,000 alates this cycle → 5 kinship). */
function mergeReady() {
  const s = newState(6);
  const d = makeDerived();
  newGame(s, d);
  s.cycle.traits = { budding: 1, hardy_workers: 3, fertile_queen: 2, vast_galleries: 1 };
  s.cycle.alates = 321;
  s.cycle.alatesCycle = 20000;
  s.cycle.hardshipTier = { pacifist: 4 };
  s.cycle.daughters = [{ seed: 1, alates: 10 }];
  s.era.hardshipBest = { pacifist: 4 };
  s.run.rivals.list.push(fallen(1, 'old_ridge_supercolony'));
  return { s, d };
}

test('supercolony validation codes', () => {
  const { s, d } = mergeReady();
  const v = (edict) => handlers.supercolony.validate(s, d, { type: 'supercolony', edict });
  assert.equal(v('edict_of_war'), null);
  assert.equal(v(null), 'invalid:edict');
  assert.equal(v('edict_of_naps'), 'invalid:edict');
  const ridge = s.run.rivals.list.find((r) => r.type === 'old_ridge_supercolony');
  ridge.alive = true;
  ridge.fallenAt = -1;
  assert.equal(v('edict_of_war'), 'requirements', 'Old Ridge not conquered');
  ridge.alive = false;
  ridge.fallenAt = 900;
  s.cycle.alatesCycle = 4999;
  assert.equal(v('edict_of_war'), 'requirements');
  s.cycle.alatesCycle = 20000;
  delete s.cycle.traits.budding;
  assert.equal(v('edict_of_war'), 'requirements');
});

test('supercolony: kinship, new cycle with heirlooms and edict, signature gene, strata, fresh run', () => {
  const { s, d } = mergeReady();
  s.era.federation.heirloom_bloodline = 1;
  s.era.heirlooms = ['hardy_workers', 'budding', 'polygyny']; // polygyny is not owned: not kept
  s.era.kinship = 2;
  s.era.kinshipLife = 2;
  const before = snapshot(s);
  const env = fakeEnv();
  handlers.supercolony.apply(s, d, { type: 'supercolony', edict: 'edict_of_war' }, env);
  assert.equal(s.era.kinship, 2 + 5);
  assert.equal(s.era.kinshipLife, 2 + 5);
  assert.equal(s.meta.counters.kinshipEver, 5);
  assert.equal(s.meta.counters.supercolonies, 1);
  assert.equal(s.meta.signatureGenes.sig_generalist, true);
  assert.deepEqual(s.cycle.traits, { hardy_workers: 3, budding: 1 }, 'heirlooms keep their levels');
  assert.equal(s.cycle.alates, 0);
  assert.equal(s.cycle.alatesCycle, 0);
  assert.deepEqual(s.cycle.hardshipTier, {});
  assert.deepEqual(s.cycle.daughters, []);
  assert.equal(s.cycle.edict, 'edict_of_war');
  assert.deepEqual(s.era.hardshipBest, { pacifist: 4 }, 'hardship rewards stay at 50 % through the era best');
  assert.equal(s.meta.strata.at(-1).kind, 'cycle');
  assert.equal(s.meta.stats.firstSuperAt, before.meta.simTime);
  assert.equal(s.run.index, 1);
  assert.equal(s.run.boon, null);
  assert.equal(s.meta.pending, null);
  assert.deepEqual(env.events.map((e) => e.type), ['runStarted', 'supercolonyComplete']);
  assert.equal(env.events[1].kinship, 5);
  assert.deepEqual(s.era.blueprints, before.era.blueprints);
  assert.deepEqual(s.era.federation, before.era.federation);
});

test('supercolony without heirloom_bloodline keeps no traits; doSupercolony tolerates a null edict', () => {
  const { s, d } = mergeReady();
  s.era.heirlooms = ['hardy_workers'];
  const kin = doSupercolony(s, d, fakeEnv(), { edict: null });
  assert.equal(kin, 5);
  assert.deepEqual(s.cycle.traits, {});
  assert.equal(s.cycle.edict, null);
});

test('signature gene follows the current species', () => {
  const { s, d } = mergeReady();
  s.era.species = 'leafcutter';
  doSupercolony(s, d, fakeEnv(), { edict: 'edict_of_plenty' });
  assert.deepEqual(s.meta.signatureGenes, { sig_fungal_farmers: true });
});

/** A game whose run meets the Speciation requirements (kinship_life = SPEC.kinshipMin, 1,000 → 20 genes). */
function specReady() {
  const s = newState(8);
  const d = makeDerived();
  newGame(s, d);
  s.era.federation = { megacolony: 1, autobuyers: 1, satellite_nest: 3 };
  s.era.kinship = 55;
  s.era.kinshipLife = SPEC.kinshipMin; // 1,000 → 20 genes
  s.era.innate = { trail_memory: true };
  s.era.researchRuns = { trail_memory: 3, brood_care: 2 };
  s.era.heirlooms = ['budding'];
  s.era.blueprints = [{ name: 'B', chambers: [], tunnels: [] }];
  s.cycle.traits = { budding: 1 };
  s.cycle.alatesCycle = 1e6;
  for (let i = 0; i < 3; i++) s.run.rivals.list.push(fallen(10 + i, 'great_rival'));
  s.meta.speciesUnlocked.leafcutter = true;
  return { s, d };
}

test('speciate validation codes', () => {
  const { s, d } = specReady();
  const v = (species) => handlers.speciate.validate(s, d, { type: 'speciate', species });
  assert.equal(v('leafcutter'), null);
  assert.equal(v('garden_ant'), null);
  assert.equal(v('honeypot'), 'locked');
  assert.equal(v('army_ant'), 'invalid:species');
  assert.equal(v(7), 'invalid:species');
  const nests = s.run.rivals.list.filter((r) => r.type === 'great_rival');
  nests[1].alive = true;
  nests[1].fallenAt = -1;
  assert.equal(v('leafcutter'), 'requirements', 'one Front nest regrew');
  nests[1].alive = false;
  nests[1].fallenAt = 900;
  const i = s.run.rivals.list.indexOf(nests[2]);
  s.run.rivals.list.splice(i, 1);
  assert.equal(v('leafcutter'), 'requirements', 'all 3 nests are needed');
  s.run.rivals.list.push(nests[2]);
  s.era.kinshipLife = SPEC.kinshipMin - 1;
  assert.equal(v('leafcutter'), 'requirements');
});

test('speciation: genes, new era and cycle, innate research dropped without genetic_memory', () => {
  const { s, d } = specReady();
  const before = snapshot(s);
  const env = fakeEnv();
  handlers.speciate.apply(s, d, { type: 'speciate', species: 'leafcutter' }, env);
  assert.equal(s.meta.genes, 20);
  assert.equal(s.meta.genesLife, 20);
  assert.equal(s.meta.counters.speciations, 1);
  assert.equal(s.era.species, 'leafcutter');
  assert.equal(s.era.kinship, 0);
  assert.equal(s.era.kinshipLife, 0);
  assert.deepEqual(s.era.federation, {});
  assert.deepEqual(s.era.innate, {});
  assert.deepEqual(s.era.researchRuns, {});
  assert.deepEqual(s.era.heirlooms, []);
  assert.deepEqual(s.era.blueprints, []);
  assert.deepEqual(s.cycle.traits, {});
  assert.equal(s.cycle.alatesCycle, 0);
  assert.equal(s.meta.strata.at(-1).kind, 'era');
  assert.equal(s.meta.stats.firstSpecAt, before.meta.simTime);
  assert.deepEqual(env.events.map((e) => e.type), ['runStarted', 'speciationComplete']);
  assert.equal(env.events[1].genes, 20);
  assert.deepEqual(s.meta.genome, before.meta.genome, 'genome kept');
  assert.deepEqual(s.meta.signatureGenes, before.meta.signatureGenes, 'no signature gene at a speciation');
});

test('speciation honours genetic_memory and eusocial_leap', () => {
  const { s, d } = specReady();
  s.meta.genome = { genetic_memory: 1, eusocial_leap: 1 };
  handlers.speciate.apply(s, d, { type: 'speciate', species: 'garden_ant' }, fakeEnv());
  assert.deepEqual(s.era.innate, { trail_memory: true });
  assert.deepEqual(s.era.researchRuns, { trail_memory: 3, brood_care: 2 });
  assert.deepEqual(s.era.federation, { automated_brood: 1, blueprint_memory: 1, autobuyers: 1 });
});

test('setHeirlooms validation and apply', () => {
  const s = newState(1);
  const d = makeDerived();
  const v = (ids) => handlers.setHeirlooms.validate(s, d, { type: 'setHeirlooms', ids });
  s.cycle.traits = { hardy_workers: 2, budding: 1, vast_galleries: 3, polygyny: 1 };
  assert.equal(v(['budding']), 'locked', 'needs heirloom_bloodline');
  s.era.federation.heirloom_bloodline = 1;
  assert.equal(v(['budding', 'hardy_workers', 'vast_galleries']), null);
  assert.equal(v([]), null);
  assert.equal(v(['budding', 'hardy_workers', 'vast_galleries', 'polygyny']), 'max');
  assert.equal(v(['budding', 'budding']), 'invalid:id');
  assert.equal(v(['nope']), 'invalid:id');
  assert.equal(v([3]), 'invalid:id');
  assert.equal(v('budding'), 'invalid');
  assert.equal(v(['wide_wings']), 'locked', 'not owned');
  handlers.setHeirlooms.apply(s, d, { type: 'setHeirlooms', ids: ['budding', 'hardy_workers'] });
  assert.deepEqual(s.era.heirlooms, ['budding', 'hardy_workers']);
});

test('placeSatellite validation: level, owned hex, distance from entrances, column gap', () => {
  const s = newState(1);
  const d = makeDerived();
  const ring3 = countInRadius(2); // first hex of ring 3 (distance 3 from the main entrance at hex 0)
  const v = (hex, col) => handlers.placeSatellite.validate(s, d, { type: 'placeSatellite', hex, col });
  d.surface.owned[ring3] = 1;
  d.surface.owned[2] = 1;
  assert.equal(v(ring3, 30), 'locked');
  s.era.federation.satellite_nest = 1;
  assert.equal(v(ring3, 30), null);
  assert.equal(v(ring3 + 1, 30), 'blocked:unowned');
  assert.equal(v(2, 30), 'blocked:entrance', 'ring 1 is too close to the main entrance');
  assert.equal(v(ring3, 22), 'blocked:shaft', 'within 4 columns of the main shaft');
  assert.equal(v(ring3, 17), 'blocked:shaft');
  assert.equal(v(ring3, 16), null, 'exactly 4 columns away is allowed');
  assert.equal(v(ring3, 16.5), 'invalid:col');
  assert.equal(v(ring3, 40), 'invalid:col');
  assert.equal(v(-1, 30), 'invalid:hex');
  assert.equal(v(817, 30), 'invalid:hex');
  d.surface.passable[ring3] = 0;
  assert.equal(v(ring3, 30), 'blocked:terrain');
  d.surface.passable[ring3] = 1;
  s.run.nest.shafts.push({ kind: 'nuptial', col: 31, open: true, ref: -1 });
  assert.equal(v(ring3, 30), 'blocked:shaft', 'within 4 columns of the nuptial shaft');
  assert.equal(v(ring3, 36), null);
  s.run.surface.entrances.push({ kind: 'satellite', hex: 300, col: 5, ref: 0 });
  assert.equal(v(ring3, 36), 'max', 'one satellite per satellite_nest level');
});
