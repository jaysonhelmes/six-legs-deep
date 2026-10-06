#!/usr/bin/env node
// Analytic prestige meta-model (DESIGN §16, §24.3; ARCHITECTURE §15.5): per-layer gain functions built from the SAME
// data tables and formulas as src/systems/prestige.js, the prestige_contractive check (double each layer's input at
// 3 points → gain ratio < 2) and a Twenty Quadrillion (census 2e16) time estimate. Owner: WP7.
// Usage: node tools/meta-model.mjs [--json]
//
// Every GAME number comes from src/data/*.js. MODEL below holds the model's own assumptions (within-run elasticities,
// run length, policies) — they are not game balance and are documented where they come from.

import { pathToFileURL } from 'node:url';
import { SOFTCAPS } from '../src/data/balance.js';
import { FLIGHT, LINEAGE, LINEAGE_LAY_EXP, SUPER, SPEC, PASSIVE, RESET } from '../src/data/prestige.js';
import { TRAITS } from '../src/data/bloodline.js';
import { FEDERATION, FED_ORDER } from '../src/data/federation.js';
import { GENOME, GENOME_ORDER } from '../src/data/genome.js';
import { BOSSES } from '../src/data/rivals.js';
import { scChain } from '../src/core/math.js';

/** Model assumptions (not game data). */
export const MODEL = Object.freeze({
  runMinutes: 25,          // typical run length once traits kick in (DESIGN §24.4: ~25 min runs from 2.5 h)
  fRunBase: 1.3,           // × FLIGHT.fRunMin: f_run of a no-prestige run when it flies (DESIGN §13.2, row 2)
  eFood: 0.94,             // f_run elasticity to the food multiplier (DESIGN §16.1, measured)
  eDig: 0.54,              // f_run elasticity to dig (DESIGN §16.1: ×10 dig → ×3.5 f_run)
  eLay: 0.25,              // assumed elasticity to lay rate (C198: lay now binds early in late runs; at 0.4 the check still passes, 6.2 weeks)
  eScale: 0.5,             // assumed elasticity to colony_scale (housing, slots, berths; not lay since C198)
  tPeak: 200, reared: 25, W: 1,   // run-1 medians of the alate formula (DESIGN §13.2)
  flightsPerCycle: 14,     // layer-2 probe: flights in a cycle (DESIGN §16.2 lists 14 cycle-1 flights)
  mergesPerEra: 20,        // layer-3 probe: merges in an era (Balance Verification: 19–21 merges in 60 h)
  mergeFrac: 0.3,          // merge when projected kinship ≥ 30 % of kinship_life (DESIGN §28.2 bot policy)
  specFrac: 0.3,           // speciate when projected genes ≥ 30 % of genes_life (assumed, by analogy)
  maxFlightsPerCycle: 400,
  adultsPerScale: 1e5,     // housing-limited adults of a mature run per unit of colony_scale (assumption)
  apPerScale: 3.5e4,       // player AP ≈ apPerScale × colony_scale × (1+K)^apK × (1+G): ~3e8 at K ≈ 220 (Balance Verification)
  apK: 0.5,
  satellites: 7,           // satellites once satellite_nest is maxed (federation max)
  maxWeeks: 52,
  scaleWeight: 0.25,       // Genome policy: colony_scale nodes (colossal_nests, unicolonial_sprawl) count at 25 % of their cost
                           // when choosing the next purchase — a player chasing the census and the Front saves for them (assumption)
});

/** Pacing target for the Twenty Quadrillion ending in weeks of efficient play (DESIGN §15.7, §28.2; not game data). */
export const ENDING_WEEKS = Object.freeze({ min: 6, max: 10 });

/** Repeatable traits that move the layer-1 loop, with the stat they multiply. */
const LOOP_TRAITS = Object.freeze(['hardy_workers', 'deep_diggers', 'fertile_queen', 'vast_galleries', 'wide_wings']);

/** Lineage Λ (DESIGN §13.3). */
export function lineageOf(a) {
  return a <= LINEAGE.knee ? 1 + LINEAGE.per * a : LINEAGE.high * Math.sqrt(a / LINEAGE.knee);
}

/** Unfloored alates from the raw product (softcapped). */
function alatesRaw(fRun, mult = 1, { tPeak = MODEL.tPeak, reared = MODEL.reared, W = MODEL.W } = {}) {
  const raw = FLIGHT.base * (Math.max(0, fRun) / FLIGHT.div) ** FLIGHT.exp * (1 + tPeak / FLIGHT.tPeakDiv)
    * (1 + FLIGHT.rearedPer * reared) * W * mult;
  return scChain(raw, SOFTCAPS.alates).value;
}

/** Floored alates of a flight (same formula as prestige.projectAlates). */
export function alatesFor(fRun, opts = {}) {
  return Math.floor(alatesRaw(fRun, opts.mult ?? 1, opts));
}

/** Unfloored kinship of a merge (DESIGN §14.2). */
function kinshipRaw(alatesCycle) {
  return scChain(SUPER.mult * (Math.max(0, alatesCycle) / SUPER.div) ** SUPER.exp, SOFTCAPS.kinship).value;
}

/** Floored kinship of a merge (same formula as prestige.projectKinship). */
export function kinshipFor(alatesCycle) {
  return Math.floor(kinshipRaw(alatesCycle));
}

/** Unfloored genes of a Speciation (DESIGN §15.2). */
function genesRaw(kinshipEra) {
  return scChain(SPEC.mult * (Math.max(0, kinshipEra) / SPEC.div) ** SPEC.exp, SOFTCAPS.genes).value;
}

/** Floored genes of a Speciation (same formula as prestige.projectGenes). */
export function genesFor(kinshipEra) {
  return Math.floor(genesRaw(kinshipEra));
}

/**
 * Continuous cheapest-first trait levels bought with a budget of alates (spending never lowers Λ, so the budget is the
 * whole alates_cycle): water-filling on the next-level cost c, L_i = log(c / base_i) / log(g_i), clamped to [0, max_i].
 * @param {number} budget
 * @returns {Object<string, number>} trait id → (fractional) level
 */
export function traitLevels(budget) {
  const spentAt = (logC) => {
    let total = 0;
    const lv = {};
    for (const id of LOOP_TRAITS) {
      const { base, growth } = TRAITS[id].cost;
      const L = Math.max(0, Math.min(TRAITS[id].max, (logC - Math.log(base)) / Math.log(growth)));
      lv[id] = L;
      total += base * (growth ** L - 1) / (growth - 1);
    }
    return { total, lv };
  };
  if (!(budget > 0)) return Object.fromEntries(LOOP_TRAITS.map((id) => [id, 0]));
  let lo = -10;
  let hi = 700;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (spentAt(mid).total > budget) hi = mid;
    else lo = mid;
  }
  return spentAt(lo).lv;
}

/**
 * Unfloored alates per flight for a cycle with `A` alates so far, kinship_life K and genes_life G (DESIGN §16).
 * f_run = base × food^eFood × dig^eDig × lay^eLay × scale^eScale with the d.meta composition of ARCHITECTURE §8.6.
 * `xs` is the colony_scale bought in the Federation / Genome shops (shopScale): it feeds f_run like every other
 * colony_scale factor, so the stability check sees the census engine's feedback (DESIGN §16 rule 5).
 */
export function flightAlates(A, K = 0, G = 0, xs = 1) {
  const t = traitLevels(A);
  const lam = lineageOf(A);
  const food = lam * TRAITS.hardy_workers.fx.mult ** t.hardy_workers * (1 + K) ** PASSIVE.kFood * (1 + G) ** PASSIVE.gFood;
  const dig = TRAITS.deep_diggers.fx.mult ** t.deep_diggers * (1 + K) ** PASSIVE.kOther * (1 + G) ** PASSIVE.gOther;
  const lay = lam ** LINEAGE_LAY_EXP * TRAITS.fertile_queen.fx.mult ** t.fertile_queen;
  const scale = TRAITS.vast_galleries.fx.mult ** t.vast_galleries * (1 + K) ** PASSIVE.kScale * xs;
  const fRun = MODEL.fRunBase * FLIGHT.fRunMin * food ** MODEL.eFood * dig ** MODEL.eDig * lay ** MODEL.eLay * scale ** MODEL.eScale;
  const mult = (1 + K) ** PASSIVE.kAlates * TRAITS.wide_wings.fx.mult ** t.wide_wings;
  return alatesRaw(fRun, mult);
}

/** alates_cycle after n flights of a cycle (A_{i+1} = A_i + a(A_i)). */
function cycleAlates(K, G, n, xs = 1) {
  let A = 0;
  for (let i = 0; i < n; i++) A += flightAlates(A, K, G, xs);
  return A;
}

/**
 * kinship_era after n merges of an era (each cycle has MODEL.flightsPerCycle flights). genes_life G is spent on the
 * Genome and the era's kinship on the Federation (both cheapest-first, Genome by MODEL.scaleWeight), and the colony_scale
 * they buy feeds every cycle.
 */
function eraKinship(G, n) {
  const gen = shopLevels(GENOME, GENOME_ORDER, G, genomeSkip, genomeWeight);
  let K = 0;
  for (let i = 0; i < n; i++) K += kinshipRaw(cycleAlates(K, G, MODEL.flightsPerCycle, shopScale(shopLevels(FEDERATION, FED_ORDER, K), gen)));
  return K;
}

/**
 * Gain of a prestige layer as a function of that layer's input (unfloored, for local-exponent checks):
 * layer 1: alates_cycle → alates per flight; layer 2: kinship_life → kinship per merge (kinship_life spent on the
 * Federation); layer 3: genes_life → genes per Speciation (genes_life spent on the Genome, see eraKinship).
 * @param {1|2|3} layer
 * @param {number} input
 * @returns {number}
 */
export function layerGain(layer, input) {
  if (layer === 1) return flightAlates(input, 0, 0);
  if (layer === 2) return kinshipRaw(cycleAlates(input, 0, MODEL.flightsPerCycle, shopScale(shopLevels(FEDERATION, FED_ORDER, input), {})));
  if (layer === 3) return genesRaw(eraKinship(input, MODEL.mergesPerEra));
  throw new Error('layer must be 1, 2 or 3');
}

/** Sample inputs per layer for the contractive check. */
export const SAMPLES = Object.freeze({ 1: [100, 1000, 10000], 2: [3, 30, 300], 3: [4, 30, 300] });

/**
 * prestige_contractive (DESIGN §16.6): doubling each layer's input at 3 sample points must give a gain ratio < 2.
 * @returns {{ ok: boolean, layers: Array<{ layer: number, points: Array<{ input: number, gain: number, gain2: number, ratio: number, exponent: number }> }> }}
 */
export function prestigeContractive() {
  const layers = [];
  let ok = true;
  for (const layer of [1, 2, 3]) {
    const points = SAMPLES[layer].map((x) => {
      const gain = layerGain(layer, x);
      const gain2 = layerGain(layer, 2 * x);
      const ratio = gain2 / gain;
      if (!(ratio < 2)) ok = false;
      return { input: x, gain, gain2, ratio, exponent: Math.log2(ratio) };
    });
    layers.push({ layer, points });
  }
  return { ok, layers };
}

/**
 * DESIGN §16.6 threshold assertions: f_run 1e8 (FLIGHT.div, the formula anchor) → 10 alates (no other factors),
 * SUPER.alatesMin (5,000) → 3 kinship, SPEC.kinshipMin (1,000) → 20 genes. The Flight gate FLIGHT.fRunMin (1.4e8) sits above the
 * anchor: see flightGateAlates().
 */
export function thresholds() {
  return {
    alates: alatesFor(FLIGHT.div, { tPeak: 0, reared: 0, W: 1 }),
    kinship: kinshipFor(SUPER.alatesMin),
    genes: genesFor(SPEC.kinshipMin),
  };
}

/** Minimum alates of a Flight at the gate f_run = FLIGHT.fRunMin, before other factors (DESIGN §13.1: 1.4e8 → 11). */
export function flightGateAlates() {
  return alatesFor(FLIGHT.fRunMin, { tPeak: 0, reared: 0, W: 1 });
}

/** Next level cost of a Federation / Genome node, rounded up to a whole number like traits.js (C83), or Infinity at max. */
function nextCost(node, L) {
  if (node.max > 0 && L >= node.max) return Infinity;
  if (Array.isArray(node.cost.list)) return L < node.cost.list.length ? Math.ceil(node.cost.list[L] - 1e-9) : Infinity;
  return Math.ceil(node.cost.base * node.cost.growth ** L - 1e-9);
}

/**
 * Spend a budget cheapest-first over a table (by cost × weight(id); stops and saves when that pick is unaffordable);
 * mutates `levels`, returns the unspent budget.
 */
function buyCheapest(table, order, levels, budget, skip = () => false, weight = () => 1) {
  for (;;) {
    let best = null;
    let bestCost = Infinity;
    let bestW = Infinity;
    for (const id of order) {
      if (skip(table[id])) continue;
      const c = nextCost(table[id], levels[id] || 0);
      const w = c * weight(id);
      if (w < bestW) { bestW = w; bestCost = c; best = id; }
    }
    if (!best || !(bestCost <= budget)) return budget;
    budget -= bestCost;
    levels[best] = (levels[best] || 0) + 1;
  }
}

/** Genome policy: STRETCH nodes cannot be bought; colony_scale nodes count at MODEL.scaleWeight of their cost. */
const genomeSkip = (node) => !!node.stretch;
const genomeWeight = (id) => (id === 'colossal_nests' || id === 'unicolonial_sprawl' ? MODEL.scaleWeight : 1);

/** Shop levels bought cheapest-first with a whole budget (lifetime currency: spending never lowers the passive). */
function shopLevels(table, order, budget, skip, weight) {
  const levels = {};
  buyCheapest(table, order, levels, budget, skip, weight);
  return levels;
}

/** The part of colony_scale bought in the Federation and Genome shops (megacolony_galleries, colossal_nests, unicolonial_sprawl). */
function shopScale(fed, gen) {
  return FEDERATION.megacolony_galleries.fx.mult ** (fed.megacolony_galleries || 0)
    * GENOME.colossal_nests.fx.mult ** (gen.colossal_nests || 0) * GENOME.unicolonial_sprawl.fx.mult ** (gen.unicolonial_sprawl || 0);
}

/** colony_scale from the composition of ARCHITECTURE §8.6. */
function colonyScale(A, K, fed, gen) {
  const t = traitLevels(A);
  return TRAITS.vast_galleries.fx.mult ** t.vast_galleries * (1 + K) ** PASSIVE.kScale * shopScale(fed, gen);
}

/**
 * Coarse time-stepped meta simulation (one step per flight of MODEL.runMinutes): merge and speciation policies,
 * Federation bought cheapest-first, Genome cheapest-first with colony_scale nodes weighted by MODEL.scaleWeight, the shop
 * colony_scale feeding f_run, Argentine Front AP gate (apBase × apGrowth^s). Returns milestones and the census timeline end.
 * @param {{ maxWeeks?: number }} [opts]
 */
export function simulateMeta({ maxWeeks = MODEL.maxWeeks } = {}) {
  const maxH = maxWeeks * 168;
  const out = { firstSuperH: -1, firstSpecH: -1, kinshipAt15h: 0, kinshipAt30h: 0, merges: 0, speciations: 0, censusH: -1,
    peakCensus: 0, genesLife: 0, hours: 0, specH: [] };
  const front = BOSSES.great_rival;
  let t = 0;
  let G = 0;
  let genesBank = 0;
  const gen = {};
  let s = 0;
  while (t < maxH) {
    let K = 0;
    let kinBank = 0;
    const fed = {};
    for (;;) { // cycles of this era
      let A = 0;
      let flights = 0;
      for (;;) { // flights of this cycle
        A += flightAlates(A, K, G, shopScale(fed, gen));
        flights++;
        t += MODEL.runMinutes / 60;
        if (t >= 15 && out.kinshipAt15h === 0) out.kinshipAt15h = K;
        if (t >= 30 && out.kinshipAt30h === 0) out.kinshipAt30h = K;
        const sats = Math.min(MODEL.satellites, fed.satellite_nest || 0);
        const census = MODEL.adultsPerScale * colonyScale(A, K, fed, gen) * (1 + RESET.censusPerSatellite * sats);
        if (census > out.peakCensus) out.peakCensus = census;
        if (census >= RESET.endingCensus && out.censusH < 0) out.censusH = t;
        if (out.censusH >= 0 || t >= maxH) break;
        const kin = kinshipFor(A);
        if (A >= SUPER.alatesMin && kin >= MODEL.mergeFrac * K && kin > 0) break;
        if (flights >= MODEL.maxFlightsPerCycle) break;
      }
      if (out.censusH >= 0 || t >= maxH) break;
      const kin = kinshipFor(A);
      K += kin;
      kinBank = buyCheapest(FEDERATION, FED_ORDER, fed, kinBank + kin);
      out.merges++;
      if (out.firstSuperH < 0) out.firstSuperH = t;
      const ap = MODEL.apPerScale * colonyScale(A, K, fed, gen) * (1 + K) ** MODEL.apK * (1 + G);
      const frontOk = (fed.megacolony || 0) > 0 && ap >= front.apBase * front.apGrowth ** s;
      const g = genesFor(K);
      if (K >= SPEC.kinshipMin && frontOk && g >= MODEL.specFrac * G && g > 0) break;
    }
    if (out.censusH >= 0 || t >= maxH) break;
    const g = genesFor(K);
    G += g;
    s++;
    out.speciations++;
    out.specH.push(t);
    if (out.firstSpecH < 0) out.firstSpecH = t;
    genesBank = buyCheapest(GENOME, GENOME_ORDER, gen, genesBank + g, genomeSkip, genomeWeight);
  }
  out.genesLife = G;
  out.hours = t;
  return out;
}

/**
 * Weeks of efficient play until census ≥ 2e16 under MODEL, or Infinity if not reached within MODEL.maxWeeks.
 * @returns {number}
 */
export function twentyQuadrillionWeeks() {
  const r = simulateMeta();
  return r.censusH >= 0 ? r.censusH / 168 : Infinity;
}

/** Full report object (CLI). */
export function report() {
  const contractive = prestigeContractive();
  const meta = simulateMeta();
  const weeks = meta.censusH >= 0 ? meta.censusH / 168 : Infinity;
  return { thresholds: thresholds(), flightGateAlates: flightGateAlates(), contractive, meta, twentyQuadrillionWeeks: weeks,
    censusOnTarget: weeks >= ENDING_WEEKS.min && weeks <= ENDING_WEEKS.max };
}

/** 1.5e8 → '1.5e8' (CLI labels follow the data). */
const sci = (x) => Number(x).toExponential().replace(/\.?0*e\+?/, 'e');

/** CLI entry. */
function main(argv) {
  const r = report();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, (k, v) => (v === Infinity ? 'Infinity' : v), 2));
    return r.contractive.ok ? 0 : 1;
  }
  const f = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 1e4 ? x.toExponential(2) : x.toFixed(2)) : String(x));
  console.log('Six Legs Deep meta-model (tools/meta-model.mjs)');
  console.log('Thresholds: f_run ' + sci(FLIGHT.div) + ' → ' + r.thresholds.alates + ' alates; ' + SUPER.alatesMin.toLocaleString('en-US') + ' → ' + r.thresholds.kinship
    + ' kinship; ' + SPEC.kinshipMin + ' → ' + r.thresholds.genes + ' genes; Flight gate f_run ' + sci(FLIGHT.fRunMin) + ' → ' + r.flightGateAlates + ' alates');
  console.log('prestige_contractive: ' + (r.contractive.ok ? 'PASS' : 'FAIL'));
  for (const L of r.contractive.layers) {
    for (const p of L.points) {
      console.log('  layer ' + L.layer + '  input ' + f(p.input).padStart(10) + '  gain ' + f(p.gain).padStart(10) + '  ×2 → '
        + f(p.gain2).padStart(10) + '  ratio ' + p.ratio.toFixed(3) + '  exponent ' + p.exponent.toFixed(3));
    }
  }
  const m = r.meta;
  console.log('Meta simulation (' + MODEL.runMinutes + '-min runs): first Supercolony ' + f(m.firstSuperH) + ' h, kinship_life '
    + f(m.kinshipAt15h) + ' at 15 h / ' + f(m.kinshipAt30h) + ' at 30 h, first Speciation ' + f(m.firstSpecH) + ' h, '
    + m.merges + ' merges, ' + m.speciations + ' speciations, genes_life ' + f(m.genesLife) + ', peak census ' + f(m.peakCensus));
  console.log('Twenty Quadrillion (census 2e16): ' + (Number.isFinite(r.twentyQuadrillionWeeks) ? f(r.twentyQuadrillionWeeks) + ' weeks'
    : 'not reached within ' + MODEL.maxWeeks + ' weeks') + ' → ' + (r.censusOnTarget ? 'PASS' : 'FAIL') + ' (target ' + ENDING_WEEKS.min + '–'
    + ENDING_WEEKS.max + ' weeks)');
  console.log('Speciations at (weeks): ' + m.specH.map((h) => (h / 168).toFixed(2)).join(', '));
  return r.contractive.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
