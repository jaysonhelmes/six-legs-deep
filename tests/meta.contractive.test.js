// WP7: prestige_contractive (DESIGN §16.6, ARCHITECTURE §15.3 #13) through tools/meta-model.mjs, the §16.6 thresholds,
// a drift guard (the model's floored gains equal prestige.js projections for the same inputs), and the Twenty
// Quadrillion estimate (census 2e16 within the DESIGN §15.7 / §28.2 window of 6–10 weeks of efficient play).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived } from './helpers.js';
import { prestigeContractive, layerGain, thresholds, alatesFor, kinshipFor, genesFor, lineageOf, traitLevels, twentyQuadrillionWeeks,
  simulateMeta, MODEL, ENDING_WEEKS } from '../tools/meta-model.mjs';
import { projectAlates, projectKinship, projectGenes, lineage } from '../src/systems/prestige.js';
import { TRAITS } from '../src/data/bloodline.js';

test('prestige_contractive: doubling each layer input at 3 points gives a gain ratio < 2', () => {
  const r = prestigeContractive();
  assert.equal(r.layers.length, 3);
  for (const L of r.layers) {
    assert.equal(L.points.length, 3);
    for (const p of L.points) {
      assert.ok(Number.isFinite(p.gain) && p.gain > 0, 'layer ' + L.layer + ' gain at ' + p.input);
      assert.ok(p.ratio < 2, 'layer ' + L.layer + ' at ' + p.input + ': ratio ' + p.ratio);
      assert.ok(p.ratio > 1, 'more input never gives less');
    }
  }
  assert.equal(r.ok, true);
});

test('§16.6 thresholds: f_run 1e8 → 10 alates; 5,000 → 3 kinship; 1,000 (the Speciation gate) → 20 genes', () => {
  assert.deepEqual(thresholds(), { alates: 10, kinship: 3, genes: 20 });
});

test('drift guard: model formulas equal prestige.js projections', () => {
  const s = newState(1);
  const d = makeDerived();
  for (const fRun of [1e8, 3.7e9, 1e13, 1e20]) {
    s.run.fRun = fRun;
    s.run.tPeak = MODEL.tPeak;
    s.run.colony.alatesReared = MODEL.reared;
    assert.equal(alatesFor(fRun), projectAlates(s, d), 'alates at f_run ' + fRun);
  }
  for (const a of [5000, 123456, 1e9]) {
    s.cycle.alatesCycle = a;
    assert.equal(kinshipFor(a), projectKinship(s, d), 'kinship at ' + a);
  }
  for (const k of [200, 777, 1e7]) {
    s.era.kinshipLife = k;
    assert.equal(genesFor(k), projectGenes(s, d), 'genes at ' + k);
  }
  for (const a of [0, 30, 100, 1000, 1e5]) assert.equal(lineageOf(a), lineage(a));
});

test('continuous trait levels: within caps, spend about the budget, grow with it', () => {
  const small = traitLevels(100);
  const big = traitLevels(1e6);
  for (const [id, L] of Object.entries(big)) {
    assert.ok(L >= 0 && L <= TRAITS[id].max, id);
    assert.ok(L >= small[id], id + ' grows with the budget');
  }
  let spent = 0;
  for (const [id, L] of Object.entries(small)) {
    const { base, growth } = TRAITS[id].cost;
    spent += base * (growth ** L - 1) / (growth - 1);
  }
  assert.ok(Math.abs(spent - 100) < 1e-6 * 100, 'spent ' + spent);
  assert.deepEqual(Object.values(traitLevels(0)), [0, 0, 0, 0, 0]);
});

test('layerGain rejects unknown layers', () => {
  assert.throws(() => layerGain(4, 1));
});

test('meta simulation runs and produces a finite timeline', () => {
  const r = simulateMeta({ maxWeeks: 4 });
  assert.ok(r.firstSuperH > 0, 'a first Supercolony happens');
  assert.ok(r.merges > 0);
  assert.ok(Number.isFinite(r.peakCensus) && r.peakCensus > 0);
  assert.ok(r.hours > 0);
});

test('Twenty Quadrillion estimate is a positive number (or Infinity when unreachable)', () => {
  const w = twentyQuadrillionWeeks();
  assert.ok(w > 0, 'weeks ' + w);
});

test('census 2e16 within 6–10 weeks of efficient play (DESIGN §15.7, §28.2)', () => {
  const w = twentyQuadrillionWeeks();
  assert.deepEqual(ENDING_WEEKS, { min: 6, max: 10 });
  assert.ok(w >= ENDING_WEEKS.min && w <= ENDING_WEEKS.max, 'weeks ' + w);
});
