// WP7 unit tests: Bloodline / Federation / Genome costs and caps (DESIGN §13.7, §14.5, §15.5; ARCHITECTURE §15.3 #1)
// and the buyTrait / buyFederation / buyGenome handlers (validation codes, spending, species unlocks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived } from './helpers.js';
import { traitCost, fedCost, genomeCost, handlers } from '../src/systems/traits.js';
import { TRAITS, TRAIT_ORDER } from '../src/data/bloodline.js';
import { FEDERATION, FED_ORDER } from '../src/data/federation.js';
import { GENOME, GENOME_ORDER, SPECIES, SPECIES_ORDER, SIGNATURES } from '../src/data/genome.js';
import { HARDSHIPS, HARDSHIP_ORDER, SITES, SITE_ORDER, BOONS, BOON_ORDER, EDICTS, EDICT_ORDER } from '../src/data/prestige.js';

/** Costs of levels 0..n−1 with the level map set step by step. */
function costs(s, map, id, fn, res, n) {
  const out = [];
  for (let L = 0; L < n; L++) {
    map[id] = L;
    const c = fn(s, id);
    out.push(c ? c[res] : null);
  }
  delete map[id];
  return out;
}

test('DESIGN trait cost rows: founding_stores 1/3/9, hardy 5 × 3.5^L, wide wings 40 × 5^L, fixed one-offs', () => {
  const s = newState(1);
  const t = s.cycle.traits;
  assert.deepEqual(costs(s, t, 'founding_stores', traitCost, 'alates', 4), [1, 3, 9, null]);
  // F18 (ARCHITECTURE §18): fractional geometric costs round up to whole alates (5 × 3.5^L → 5, 18, 62).
  assert.deepEqual(costs(s, t, 'hardy_workers', traitCost, 'alates', 3), [5, 18, 62]);
  assert.deepEqual(costs(s, t, 'wide_wings', traitCost, 'alates', 3), [40, 200, 1000]);
  assert.deepEqual(costs(s, t, 'budding', traitCost, 'alates', 2), [500, null]);
  assert.deepEqual(costs(s, t, 'polygyny', traitCost, 'alates', 1), [250]);
  assert.equal(traitCost(s, 'nope'), null);
});

test('every node: strictly increasing costs up to its cap, then null (MAX)', () => {
  const s = newState(1);
  const tables = [[TRAITS, TRAIT_ORDER, s.cycle.traits, traitCost, 'alates'], [FEDERATION, FED_ORDER, s.era.federation, fedCost, 'kinship'],
    [GENOME, GENOME_ORDER, s.meta.genome, genomeCost, 'genes']];
  for (const [table, order, map, fn, res] of tables) {
    for (const id of order) {
      const node = table[id];
      const n = node.max > 0 ? node.max : 50;
      const cs = costs(s, map, id, fn, res, n);
      for (let i = 0; i < cs.length; i++) assert.ok(cs[i] > 0, id + ' L' + i);
      for (let i = 1; i < cs.length; i++) assert.ok(cs[i] > cs[i - 1], id + ' strictly increasing at L' + i);
      if (node.max > 0) {
        map[id] = node.max;
        assert.equal(fn(s, id), null, id + ' at max');
        delete map[id];
      }
    }
  }
});

test('federation costs: satellite list, megacolony galleries 4 × 2^L', () => {
  const s = newState(1);
  assert.deepEqual(costs(s, s.era.federation, 'satellite_nest', fedCost, 'kinship', 8), [2, 3, 5, 8, 13, 21, 34, null]);
  assert.deepEqual(costs(s, s.era.federation, 'megacolony_galleries', fedCost, 'kinship', 6), [4, 8, 16, 32, 64, null]);
  assert.deepEqual(costs(s, s.era.federation, 'megacolony', fedCost, 'kinship', 2), [50, null]);
});

test('unicolonial_sprawl is uncapped until the cost passes 1e280 (MAX)', () => {
  const s = newState(1);
  s.meta.genome.unicolonial_sprawl = 100;
  assert.deepEqual(genomeCost(s, 'unicolonial_sprawl'), { genes: Math.ceil(6 * 1.13 ** 100) }); // DESIGN §15.5: 6 × 1.13^L, rounded up (C83)
  s.meta.genome.unicolonial_sprawl = 5100; // 6 × 1.13^5100 ≈ 3e271
  assert.ok(genomeCost(s, 'unicolonial_sprawl').genes < 1e280);
  s.meta.genome.unicolonial_sprawl = 5400; // 6 × 1.13^5400 ≈ 3e287
  assert.equal(genomeCost(s, 'unicolonial_sprawl'), null);
});

test('buyTrait validation codes and apply', () => {
  const s = newState(1);
  const d = makeDerived();
  const v = (id) => handlers.buyTrait.validate(s, d, { type: 'buyTrait', id });
  assert.equal(v('hardy_workers'), 'cantAfford');
  assert.equal(v('nope'), 'invalid:id');
  assert.equal(v('__proto__'), 'invalid:id');
  assert.equal(v(undefined), 'invalid:id');
  s.cycle.alates = 30;
  assert.equal(v('hardy_workers'), null);
  handlers.buyTrait.apply(s, d, { type: 'buyTrait', id: 'hardy_workers' });
  assert.equal(s.cycle.alates, 25);
  assert.equal(s.cycle.traits.hardy_workers, 1);
  assert.equal(s.cycle.alatesCycle, 0, 'spending never reduces alates_cycle');
  handlers.buyTrait.apply(s, d, { type: 'buyTrait', id: 'hardy_workers' });
  assert.equal(s.cycle.alates, 7, '25 − 18 (F18: whole-alate costs)');
  s.cycle.traits.budding = 1;
  s.cycle.alates = 1e6;
  assert.equal(v('budding'), 'max');
});

test('buying seasonal_wisdom while the landing chooser is open enables the season choice', () => {
  const s = newState(1);
  s.cycle.alates = 20;
  s.meta.pending = { kind: 'landing', options: [{ seed: 1, tags: [] }], boons: [], chooseSeason: false, alates: 0, hardship: null, carryAdults: 0 };
  handlers.buyTrait.apply(s, makeDerived(), { type: 'buyTrait', id: 'seasonal_wisdom' });
  assert.equal(s.meta.pending.chooseSeason, true);
});

test('buyFederation and buyGenome: currencies, species unlock, STRETCH refused', () => {
  const s = newState(1);
  const d = makeDerived();
  assert.equal(handlers.buyFederation.validate(s, d, { type: 'buyFederation', id: 'satellite_nest' }), 'cantAfford');
  s.era.kinship = 5;
  handlers.buyFederation.apply(s, d, { type: 'buyFederation', id: 'satellite_nest' });
  handlers.buyFederation.apply(s, d, { type: 'buyFederation', id: 'satellite_nest' });
  assert.equal(s.era.federation.satellite_nest, 2);
  assert.equal(s.era.kinship, 0);
  assert.equal(handlers.buyGenome.validate(s, d, { type: 'buyGenome', id: 'species_honeypot' }), 'cantAfford');
  s.meta.genes = 100;
  assert.equal(handlers.buyGenome.validate(s, d, { type: 'buyGenome', id: 'biomes' }), 'locked');
  assert.equal(handlers.buyGenome.validate(s, d, { type: 'buyGenome', id: 'species_honeypot' }), null);
  handlers.buyGenome.apply(s, d, { type: 'buyGenome', id: 'species_honeypot' });
  assert.equal(s.meta.genome.species_honeypot, 1);
  assert.equal(s.meta.speciesUnlocked.honeypot, true);
  assert.equal(s.meta.genes, 97);
  assert.equal(handlers.buyGenome.validate(s, d, { type: 'buyGenome', id: 'species_honeypot' }), 'max');
  assert.equal(s.meta.genesLife, 0, 'spending never reduces genes_life');
});

test('data tables: ORDER arrays match tables, ids repeat, prefixes, species genes and signatures resolve', () => {
  const pairs = [[TRAIT_ORDER, TRAITS], [FED_ORDER, FEDERATION], [GENOME_ORDER, GENOME], [SPECIES_ORDER, SPECIES],
    [HARDSHIP_ORDER, HARDSHIPS], [SITE_ORDER, SITES], [BOON_ORDER, BOONS], [EDICT_ORDER, EDICTS]];
  for (const [order, table] of pairs) {
    assert.deepEqual([...order].sort(), Object.keys(table).sort());
    for (const id of order) {
      assert.equal(table[id].id, id);
      assert.equal(typeof table[id].name, 'string');
      if (table !== SPECIES) assert.ok(table[id].fx && typeof table[id].fx === 'object', id + ' has fx');
      else assert.ok(table[id].mods && typeof table[id].mods === 'object', id + ' has mods');
    }
  }
  assert.equal(TRAIT_ORDER.length, 21);
  assert.equal(FED_ORDER.length, 13);
  assert.equal(GENOME_ORDER.length, 18);
  for (const sp of Object.values(SPECIES)) {
    assert.ok(SIGNATURES[sp.sig], sp.id + ' signature');
    if (sp.gene) assert.equal(GENOME[sp.gene].fx.species, sp.id);
  }
  for (const id of Object.keys(SITES)) assert.match(id, /^site_/);
  for (const id of Object.keys(BOONS)) assert.match(id, /^boon_/);
  for (const id of Object.keys(EDICTS)) assert.match(id, /^edict_/);
  assert.ok(Object.isFrozen(TRAITS.hardy_workers.fx) && Object.isFrozen(SPECIES.honeypot.mods.innate), 'deep-frozen');
});
