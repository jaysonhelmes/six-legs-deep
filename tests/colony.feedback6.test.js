// Feedback pass 6 (economy): lay rate without colony scale + Royal / queen terms (ARCHITECTURE §18 C198), the chitin
// cap with overflow, decay and Carapace Workshop boost (C199), and the era-scope Archive insight sink (C200).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { createEra } from '../src/core/state.js';
import { recompute, royalLayMult, courtMult } from '../src/systems/stats.js';
import { tick as economyTick } from '../src/systems/economy.js';
import { tick as populationTick, handlers as popH, chitinReserve, chitinReserveMax, chitinNeed } from '../src/systems/population.js';
import { grant, incomeSeconds } from '../src/core/wallet.js';
import * as research from '../src/systems/research.js';
import { doFlight, doSupercolony, newGame } from '../src/systems/prestige.js';
import { LAY, CHITIN, SLIDERS } from '../src/data/economy.js';
import { ARCHIVE, RESEARCH, RESEARCH_ORDER, REFINEMENT } from '../src/data/research.js';
import { COST_MAX } from '../src/data/balance.js';

const near = (a, b, rel = 1e-9, msg = '') =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(a), Math.abs(b)), `${msg} ${a} ≉ ${b}`);

function setup() {
  const s = newState(1);
  const d = makeDerived();
  d.season.mods.lay = 1;
  return { s, d, env: fakeEnv() };
}

// ---- C198 lay rate -------------------------------------------------------------------------------------------------

test('C198: the lay rate ignores colony scale; housing and slots still scale', () => {
  const { s, d, env } = setup();
  d.nest.agg.royal = [7];
  d.nest.agg.housingBase = 20;
  recompute(s, d, env);
  const lay1 = d.stats.layRate;
  const house1 = d.stats.housing;
  d.meta.colonyScale = 1000;
  recompute(s, d, env);
  near(d.stats.layRate, lay1, 1e-12, 'λ unchanged by colony scale');
  near(d.stats.housing, house1 * 1000, 1e-12, 'housing × colony scale');
});

test('C198: Royal Chamber levels ×1.15 up to highFrom (L8), ×perRCHigh above; extra queens add and raise the court', () => {
  assert.equal(royalLayMult(0), 0);
  assert.equal(royalLayMult(1), 1);
  const H = LAY.highFrom;
  near(royalLayMult(H), LAY.perRC ** (H - 1));
  near(royalLayMult(H + 7), LAY.perRC ** (H - 1) * LAY.perRCHigh ** 7);
  assert.ok(H >= 5, 'run 1 (to the Flight level, L5) keeps ×1.15 per level');
  assert.ok(LAY.perRCHigh > LAY.perRC, 'late Royal levels grow faster than early ones');
  assert.equal(courtMult(1), 1);
  near(courtMult(3), 1 + 2 * LAY.courtPer);
  const { s, d, env } = setup();
  d.nest.agg.royal = [10];
  recompute(s, d, env);
  const one = d.stats.layRate;
  near(one, LAY.base * royalLayMult(10));
  d.nest.agg.royal = [10, 10, 10];          // Polygyny + Queens' Council
  recompute(s, d, env);
  near(d.stats.layRate, 3 * one * courtMult(3), 1e-9, 'three equal queens lay 3 × court as much as one');
  assert.ok(d.stats.layRate > 3 * one, 'an extra queen is worth more than her own eggs');
});

test('C198: d.stats.layParts lists every queen (add) and every non-neutral multiplier (mult); product = layRate', () => {
  const { s, d, env } = setup();
  d.nest.agg.royal = [6, 2];
  s.run.research.royal_pheromones = 1;
  s.run.refinements.brood = 2;
  s.era.archive = { brood: 10 };
  d.meta.prestige.lay = 3;
  recompute(s, d, env);
  const parts = d.stats.layParts;
  assert.ok(Array.isArray(parts));
  const adds = parts.filter((p) => 'add' in p);
  const mults = parts.filter((p) => 'mult' in p);
  assert.equal(adds.length, 2);
  for (const p of parts) {
    assert.equal(typeof p.label, 'string');
    assert.equal(p.value, 'add' in p ? p.add : p.mult);
  }
  for (const label of ["Queens' court (2 queens)", 'Royal Pheromones', 'Brood refinement', 'Brood Archive']) {
    assert.ok(mults.some((p) => p.label === label), label);
  }
  near(mults.find((p) => p.label === 'Brood Archive').mult, 1 + 10 * ARCHIVE.per);
  near(mults.find((p) => p.label === 'Brood refinement').mult, REFINEMENT.mult ** 2);
  const sum = adds.reduce((a, p) => a + p.add, 0);
  const prod = mults.reduce((a, p) => a * p.mult, 1);
  near(sum * prod, d.stats.layRate);
  s.run.colony.hungry = true;
  recompute(s, d, env);
  assert.equal(d.stats.layRate, 0);
  assert.ok(d.stats.layParts.some((p) => p.label === 'Hungry' && p.mult === 0));
});

// ---- C199 chitin cap ----------------------------------------------------------------------------------------------

/** recompute + economy tick (ledger reset). */
function econStep(s, d, dt, ledger = {}) {
  const env = fakeEnv({ dt });
  for (const r of Object.keys(d.ledger)) d.ledger[r] = {};
  recompute(s, d, env);
  Object.assign(d.ledger.chitin, ledger);
  economyTick(s, d, dt, env);
  return env;
}

test('C199: chitin cap = (base + Carapace Stores) × colony scale; boost = 1 + Σ Workshop boost on st.chitin', () => {
  const { s, d, env } = setup();
  recompute(s, d, env);
  assert.equal(d.stats.chitinCap, CHITIN.capBase);
  assert.equal(d.stats.chitinBoost, 1);
  const base = d.stats.chitin;
  d.nest.agg.chitinCapBase = 1500;
  d.nest.agg.chitinBoost = 0.3;
  d.meta.colonyScale = 3;
  recompute(s, d, env);
  near(d.stats.chitinCap, (CHITIN.capBase + 1500) * 3);
  near(d.stats.chitinBoost, 1.3);
  near(d.stats.chitin, base * 1.3, 1e-12, 'trails and Middens read st.chitin');
});

test('C199: chitin income stops at the cap; the excess above it decays at decayPerMin per minute', () => {
  const { s, d } = setup();
  s.run.res.chitin = 490;
  econStep(s, d, 10, { trails: 5 });
  assert.equal(s.run.res.chitin, CHITIN.capBase, 'income fills to the cap and no further');
  // 1,500 above the cap decays exponentially; income adds nothing while above the cap
  s.run.res.chitin = CHITIN.capBase + 1500;
  econStep(s, d, 60, { trails: 5 });
  near(s.run.res.chitin, CHITIN.capBase + 1500 * Math.exp(-CHITIN.decayPerMin), 1e-9, 'one minute of decay');
  near(d.rates.chitin.decay, (s.run.res.chitin - CHITIN.capBase) * CHITIN.decayPerMin / 60, 1e-9);
  assert.equal(d.rates.chitin.cap, CHITIN.capBase);
  // the same over 600 one-second ticks (step-length independent)
  s.run.res.chitin = CHITIN.capBase + 1500;
  for (let i = 0; i < 60; i++) econStep(s, d, 1);
  near(s.run.res.chitin, CHITIN.capBase + 1500 * Math.exp(-CHITIN.decayPerMin), 1e-9, 'ticks agree with one step');
});

test('C199: one-shot chitin overflows to 2× cap, moults (overflow false) only to the cap; the boost applies once', () => {
  const { s, d, env } = setup();
  d.nest.agg.chitinBoost = 0.5;
  recompute(s, d, env);
  s.run.res.chitin = 0;
  const added = grant(s, d, 'chitin', 100);
  near(added, 150, 1e-12, 'hunts / battles / events × chitinBoost');
  s.run.res.chitin = 0;
  grant(s, d, 'chitin', 1e6);
  assert.equal(s.run.res.chitin, CHITIN.overflow * d.stats.chitinCap, 'one-shots overflow to 2 × cap');
  s.run.res.chitin = 0;
  grant(s, d, 'chitin', 1e6, { overflow: false });
  assert.equal(s.run.res.chitin, d.stats.chitinCap, 'moults fill to the cap only');
  s.run.res.chitin = 0;
  near(grant(s, d, 'chitin', 10, { boost: false }), 10, 1e-12, 'boost: false');
  // "seconds of income" is measured unboosted, so the grant's boost is applied exactly once
  d.rates.chitin.avg = 3;
  near(incomeSeconds(d, 'chitin', 10), 20);
});

test('C199: the chitin reserve never exceeds the cap (command and stored value)', () => {
  const { s, d, env } = setup();
  recompute(s, d, env);
  assert.equal(chitinReserveMax(d), Math.min(SLIDERS.chitinReserveSteps.at(-1), CHITIN.capBase));
  assert.equal(chitinReserveMax(null), SLIDERS.chitinReserveSteps.at(-1));
  popH.setChitinReserve.apply(s, d, { type: 'setChitinReserve', amount: 5000 }, env);
  assert.equal(s.run.colony.chitinReserve, CHITIN.capBase);
  s.run.colony.chitinReserve = 2000;              // e.g. a Carapace Store was demolished
  assert.equal(chitinReserve(s, d), CHITIN.capBase);
  populationTick(s, d, 0.1, fakeEnv());
  assert.equal(s.run.colony.chitinReserve, CHITIN.capBase, 'tick lowers a stored reserve above the cap');
  // chitin wanted only up to the cap (trails cannot fill past it)
  s.run.unlocked.caste_soldier = true;
  s.run.res.chitin = CHITIN.capBase;
  assert.equal(chitinNeed(s, d).needed, false);
});

// ---- C200 Archive ------------------------------------------------------------------------------------------------

/** Own every node of a branch. */
function completeBranch(s, branch) {
  for (const id of RESEARCH_ORDER) if (RESEARCH[id].branch === branch) s.run.research[id] = 1;
}

test('C200 Archive: closed until the branch is complete, cost base × growth^L, level persists in the era', () => {
  const s = newState(2);
  const d = makeDerived();
  const env = fakeEnv();
  const h = research.handlers.buyArchive;
  assert.equal(h.validate(s, d, { type: 'buyArchive', branch: 'nope' }), 'invalid');
  assert.equal(h.validate(s, d, { type: 'buyArchive', branch: 'foraging' }), 'locked');
  assert.equal(research.archiveCost(s, 'foraging'), null);
  completeBranch(s, 'foraging');
  assert.deepEqual(research.archiveCost(s, 'foraging'), { insight: ARCHIVE.base });
  assert.equal(h.validate(s, d, { type: 'buyArchive', branch: 'foraging' }), 'cantAfford');
  s.run.res.insight = ARCHIVE.base * (1 + ARCHIVE.growth) + 1;
  h.apply(s, d, { type: 'buyArchive', branch: 'foraging' }, env);
  h.apply(s, d, { type: 'buyArchive', branch: 'foraging' }, env);
  assert.equal(s.era.archive.foraging, 2);
  near(s.run.res.insight, 1);
  assert.deepEqual(env.events.map((e) => [e.type, e.level]), [['archiveBought', 1], ['archiveBought', 2]]);
  near(research.archiveCost(s, 'foraging').insight, ARCHIVE.base * ARCHIVE.growth ** 2);
  // once levelled, the track stays open in later runs even before the branch is complete again
  s.run.research = {};
  assert.equal(research.archiveOpen(s, 'foraging'), true);
  assert.equal(research.archiveOpen(s, 'warfare'), false);
  // the cost reports MAX past COST_MAX, so stored numbers stay far below 1e295
  s.era.archive.foraging = 2000;
  assert.equal(research.archiveCost(s, 'foraging'), null);
  assert.equal(h.validate(s, d, { type: 'buyArchive', branch: 'foraging' }), 'max');
  assert.ok(ARCHIVE.base * ARCHIVE.growth ** Math.ceil(Math.log(COST_MAX / ARCHIVE.base) / Math.log(ARCHIVE.growth)) > COST_MAX);
});

test('C200 Archive: × (1 + per·L) on each branch main output', () => {
  const s = newState(3);
  const d = makeDerived();
  const env = fakeEnv();
  s.run.colony.jobs.digger = 10;
  recompute(s, d, env);
  const before = { forage: d.stats.forage.mRun, dig: d.stats.digRaw, honeydew: d.stats.honeydew, fungus: d.stats.fungus,
    ap: d.stats.ap, insight: d.stats.insight.library };
  s.era.archive = { foraging: 10, excavation: 20, husbandry: 30, warfare: 40, communication: 50 };
  recompute(s, d, env);
  near(d.stats.forage.mRun, before.forage * 1.1);
  near(d.stats.digRaw, before.dig * 1.2);
  near(d.stats.honeydew, before.honeydew * 1.3);
  near(d.stats.fungus, before.fungus * 1.3);
  near(d.stats.ap, before.ap * 1.4);
  near(d.stats.insight.library, before.insight * 1.5);
});

test('C200 Archive survives a Flight and a Supercolony; a new era (Speciation) starts empty', () => {
  const s = newState(4);
  const d = makeDerived();
  newGame(s, d);
  s.era.archive = { brood: 3, warfare: 1 };
  s.run.refinements = { brood: 2 };
  doFlight(s, d, fakeEnv());
  assert.deepEqual(s.era.archive, { brood: 3, warfare: 1 }, 'kept through a Flight');
  assert.deepEqual(s.run.refinements, {}, 'refinements still reset');
  doSupercolony(s, d, fakeEnv(), { edict: null });
  assert.deepEqual(s.era.archive, { brood: 3, warfare: 1 }, 'kept through a Supercolony');
  assert.deepEqual(createEra().archive, {}, 'a new era has no Archive');
});

test('C200 Archive: the Research tab line names the current bonus, the step and the scope', async () => {
  const { archiveLine } = await import('../src/ui/panels/research.js');
  assert.equal(archiveLine(3, ARCHIVE.per, 'lay rate'), '+3% lay rate now · +1% per level · kept through Flights and Supercolonies');
});

test('C201: Carapace Workshops recycle chitin from fallen soldiers (killAdults), not from minors', async () => {
  const { newState, makeDerived } = await import('./helpers.js');
  const population = await import('../src/systems/population.js');
  const s = newState(3);
  const d = makeDerived();
  s.run.colony.adults.soldier = 10;
  s.run.colony.adults.minor = 10;
  s.run.res.chitin = 0;
  d.nest.agg.chitinRecycle = 0.5;
  d.stats.chitinCap = 1e6;
  population.killAdults(s, d, 'soldier', 4, 'battle');
  assert.ok(Math.abs(s.run.res.chitin - 2) < 1e-6, 'recycled 4 × 0.5 chitin, got ' + s.run.res.chitin);
  population.killAdults(s, d, 'minor', 4, 'battle');
  assert.ok(Math.abs(s.run.res.chitin - 2) < 1e-6, 'minors recycle nothing');
});
