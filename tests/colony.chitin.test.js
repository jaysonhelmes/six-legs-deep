// Player-request regression tests (ARCHITECTURE §18 C103–C105): passive chitin (moults on hatching, Midden recycling),
// the chitin reserve for soldier / supermajor eggs, chitin trail priority in the forager auto-fill, and the Colony
// panel's ×10 / Max (n) Adaptation cost computation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { recompute } from '../src/systems/stats.js';
import { tick as economyTick } from '../src/systems/economy.js';
import { tick as populationTick, handlers as popH, chitinNeed, chitinReserve } from '../src/systems/population.js';
import * as trails from '../src/systems/trails.js';
import * as surface from '../src/systems/surface.js';
import { cost as adaptCost } from '../src/systems/adaptations.js';
import { fillDefaults } from '../src/core/migrations.js';
import { canAfford } from '../src/core/wallet.js';
import { MOLT, SLIDERS } from '../src/data/economy.js';
import { CHAMBERS } from '../src/data/chambers.js';
import { SOURCES } from '../src/data/sources.js';
import { hexIndex } from '../src/core/hex.js';
import { adaptBulk, chitinStepIndex } from '../src/ui/panels/colony.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);

/** recompute + economy + population for one step (ledger reset first; optional food production). */
function colonyStep(s, d, dt, { food = 0, midden = null } = {}) {
  const env = fakeEnv({ dt });
  for (const r of Object.keys(d.ledger)) d.ledger[r] = {};
  if (food > 0) d.ledger.food = { trails: food };
  if (midden !== null) d.nest.agg.middenL = midden;
  recompute(s, d, env);
  economyTick(s, d, dt, env);
  populationTick(s, d, dt, env);
  s.run.time += dt;
  return env.events;
}

const laid = (ev, caste) => ev.filter((e) => e.type === 'eggLaid' && (!caste || e.caste === caste)).reduce((a, e) => a + e.n, 0);

/** 100 minors, huge housing / slots / berths and food, λ high, soldiers unlocked. */
function colony() {
  const s = newState(1);
  const d = makeDerived();
  const col = s.run.colony;
  col.naniticsLeft = 0;
  col.layAcc = 0;
  col.adults.minor = 100;
  col.jobs.forager = 100;
  s.run.res.food = 1e6;
  d.nest.agg.housingBase = 1e6;
  d.nest.agg.granaryCap = 1e7;
  d.nest.agg.berthsBase = 1000;
  d.nest.agg.warBerthsBase = 1000; // C136: supermajors live in War Hall berths
  d.nest.agg.broodGroups = [{ kind: 'royal', uid: 1, cap: 1e6, factor: 1, exposed: false, snap: false, inReach: false }];
  d.meta.prestige.lay = 40;
  s.run.unlocked.caste_soldier = true;
  recompute(s, d, fakeEnv());
  return { s, d };
}

// ---- 1a. moults ----------------------------------------------------------------------------------------------------

test('C103 moults: every hatched adult sheds MOLT.perHatch chitin once chitin matters (gate), none before', () => {
  for (const gated of [false, true]) {
    const { s, d } = colony();
    s.run.unlocked.caste_soldier = gated;
    s.run.colony.hungry = true;                         // no laying this step: only the hatch moves chitin
    s.run.colony.brood = [{ c: 'minor', n: 10, p: 0.9999, t: -5 }, { c: 'alate', n: 2, p: 0.9999, t: -5 }];
    s.run.res.chitin = 0;
    colonyStep(s, d, 1);
    assert.equal(s.run.colony.brood.length, 0, 'the cohorts hatched');
    close(s.run.res.chitin, gated ? 12 * MOLT.perHatch : 0, 1e-9, gated ? 'gated on' : 'gated off');
    if (gated) assert.ok(d.rates.chitin.molts > 0, 'the moult rate is shown in d.rates.chitin.molts');
  }
  // res_chitin alone also opens the gate
  const { s, d } = colony();
  s.run.unlocked.caste_soldier = false;
  s.run.unlocked.res_chitin = true;
  s.run.colony.hungry = true;
  s.run.colony.brood = [{ c: 'soldier', n: 4, p: 0.9999, t: -5 }];
  colonyStep(s, d, 1);
  close(s.run.res.chitin, 4 * MOLT.perHatch, 1e-9);
});

// ---- 1b. Midden ----------------------------------------------------------------------------------------------------

test('C103 Midden: fx.chitin per effective level into the ledger (label midden), credited × eff, × the chitin channel', () => {
  const { s, d } = colony();
  s.run.colony.hungry = true;
  s.run.res.chitin = 0;
  colonyStep(s, d, 1, { midden: 2.5 });
  const want = CHAMBERS.midden.fx.chitin * 2.5 * d.stats.chitin;
  close(d.ledger.chitin.midden, want, 1e-12, 'ledger');
  close(d.rates.chitin.src.midden, want, 1e-12, 'rates src (resource tooltip)');
  close(s.run.res.chitin, want, 1e-9, 'one second of recycling');
  // offline efficiency scales it like every other ledger rate
  const env = fakeEnv({ dt: 10, offline: true, eff: 0.5 });
  for (const r of Object.keys(d.ledger)) d.ledger[r] = {};
  recompute(s, d, env);
  const before = s.run.res.chitin;
  economyTick(s, d, 10, env);
  const wantOff = CHAMBERS.midden.fx.chitin * 2.5 * d.stats.chitin;
  close(s.run.res.chitin - before, wantOff * 0.5 * 10, 1e-9, 'offline ×eff');
  // no Midden, no chitin
  for (const r of Object.keys(d.ledger)) d.ledger[r] = {};
  colonyStep(s, d, 1, { midden: 0 });
  assert.equal(d.ledger.chitin.midden, undefined);
});

// ---- 2. reserve ----------------------------------------------------------------------------------------------------

test('C104 reserve: soldier eggs spend only chitin above the reserve; at/below it minors are laid instead', () => {
  const { s, d } = colony();
  s.run.colony.casteTargets = { soldier: 0.5, supermajor: 0, replete: 0 };
  s.run.colony.chitinReserve = 20;
  s.run.res.chitin = 20;
  let soldiers = 0;
  let minors = 0;
  for (let i = 0; i < 20; i++) {
    const ev = colonyStep(s, d, 0.1);
    soldiers += laid(ev, 'soldier');
    minors += laid(ev, 'minor');
  }
  assert.equal(soldiers, 0, 'no soldier egg while chitin ≤ reserve');
  assert.ok(minors > 0, 'laying is never blocked (got ' + minors + ' minors)');
  close(s.run.res.chitin, 20, 1e-9, 'reserve untouched');
  // with chitin above the reserve soldiers are laid, never dipping below it
  s.run.res.chitin = 30;
  for (let i = 0; i < 40; i++) {
    soldiers += laid(colonyStep(s, d, 0.1), 'soldier');
    assert.ok(s.run.res.chitin >= 20 - 1e-9, 'chitin never below the reserve: ' + s.run.res.chitin);
  }
  assert.ok(soldiers > 0, 'soldiers laid from the chitin above the reserve');
});

test('C104 setChitinReserve validation, clamping, and the default for older saves', () => {
  const { s, d } = colony();
  const max = SLIDERS.chitinReserveSteps[SLIDERS.chitinReserveSteps.length - 1];
  const v = (amount) => popH.setChitinReserve.validate(s, d, { type: 'setChitinReserve', amount });
  for (const ok of [0, 1, 50, max]) assert.equal(v(ok), null);
  for (const bad of [-1, max + 1, NaN, Infinity, null, '5', undefined]) assert.equal(v(bad), 'invalid');
  popH.setChitinReserve.apply(s, d, { type: 'setChitinReserve', amount: 75 });
  assert.equal(s.run.colony.chitinReserve, 75);
  assert.equal(chitinReserve(s), 75);
  s.run.colony.chitinReserve = 1e9;                    // a corrupt value is clamped where it is read
  assert.equal(chitinReserve(s), max);
  const old = JSON.parse(JSON.stringify(s));
  delete old.run.colony.chitinReserve;
  fillDefaults(old);
  assert.equal(old.run.colony.chitinReserve, 0, 'fillDefaults adds the field to older saves');
  // ladder index used by the slider
  assert.equal(chitinStepIndex(0), 0);
  assert.equal(SLIDERS.chitinReserveSteps[chitinStepIndex(75)], 75);
  assert.equal(SLIDERS.chitinReserveSteps[chitinStepIndex(76)], 75, 'off-ladder amounts show the step below');
});

test('C104 chitinNeed: wanted military egg unaffordable, or chitin below reserve + next egg; never when soldiers are impossible', () => {
  const { s, d } = colony();
  s.run.res.chitin = 0;
  assert.equal(chitinNeed(s, d).needed, false, 'no target and no reserve');
  s.run.colony.casteTargets = { soldier: 0.2, supermajor: 0, replete: 0 };
  let n = chitinNeed(s, d);
  assert.equal(n.needed, true);
  assert.equal(n.wanted, true);
  close(n.next, 1 + 0.02 * s.run.colony.adults.soldier, 1e-12, 'next soldier egg chitin');
  s.run.res.chitin = n.next + 0.5;
  assert.equal(chitinNeed(s, d).needed, false, 'affordable');
  s.run.colony.chitinReserve = 10;
  assert.equal(chitinNeed(s, d).needed, true, 'affordable only by dipping into the reserve');
  s.run.res.chitin = 12;
  assert.equal(chitinNeed(s, d).needed, false, 'reserve + next egg covered');
  s.run.colony.casteTargets = { soldier: 0, supermajor: 0, replete: 0 };
  s.run.res.chitin = 5;
  assert.equal(chitinNeed(s, d).needed, true, 'below the reserve with no target');
  s.run.hardship = 'pacifist';
  assert.equal(chitinNeed(s, d).needed, false, 'pacifist: no military eggs, no chitin demand');
});

// ---- 3. trail priority ---------------------------------------------------------------------------------------------

/** Skeleton surface: a near fallen fruit (rich food) and a far dead insect (food + chitin), 40 free foragers. */
function trailWorld() {
  const s = newState(1);
  const d = makeDerived();
  surface.derive(s, d);
  const S = s.run.surface;
  const add = (type, hex) => {
    const def = SOURCES[type];
    const src = { uid: S.nextUid++, type, hex, stock: def.stock ? 1e6 : -1, max: def.stock ? 1e6 : -1, level: 1, herdT: 0, age: 0,
      ttl: -1, cd: 0, data: {} };
    S.sources.push(src);
    S.revealed[hex] = 1;
    return src;
  };
  const seed = add('fallen_fruit', hexIndex(2, 0));
  const insect = add('dead_insect', hexIndex(6, 0));
  const mk = (src, len) => {
    const t = { uid: S.nextUid++, origin: 0, src: src.uid, path: [0], len, job: 'forager', workers: 0, escorts: 0, S: 50, born: 0, reroutes: [] };
    S.trails.push(t);
    return t;
  };
  const tSeed = mk(seed, 2);
  const tIns = mk(insect, 6);
  s.run.colony.adults.minor = 40;
  s.run.colony.jobs.forager = 40;
  s.run.unlocked.caste_soldier = true;
  return { s, d, tSeed, tIns };
}

function allocTick(s, d) {
  const env = fakeEnv({ dt: 0.1 });
  for (const k of Object.keys(d.ledger)) d.ledger[k] = {};
  surface.derive(s, d);
  trails.tick(s, d, 0.1, env);
  return Object.fromEntries(d.surface.trails.map((e) => [e.uid, e]));
}

test('C104 chitin priority: while chitin is needed, free foragers fill chitin trails up to cEff before food trails', () => {
  const base = trailWorld();
  const off = allocTick(base.s, base.d);
  assert.equal(base.d.surface.chitinPriority, false);
  assert.equal(off[base.tIns.uid].priority, false);

  const w = trailWorld();
  w.s.run.colony.chitinReserve = 10;                    // chitin 0 < reserve: needed
  const on = allocTick(w.s, w.d);
  assert.equal(w.d.surface.chitinPriority, true);
  assert.equal(on[w.tIns.uid].priority, true, 'the dead insect trail is flagged for the Map panel');
  assert.equal(on[w.tSeed.uid].priority, false, 'food-only trails are not');
  const cEff = on[w.tIns.uid].cEff;
  close(on[w.tIns.uid].workers, Math.min(40, cEff), 1e-6, 'chitin trail filled to its saturation first');
  assert.ok(on[w.tIns.uid].workers > off[base.tIns.uid].workers, `more foragers on chitin (${on[w.tIns.uid].workers} vs ${off[base.tIns.uid].workers})`);
  close(on[w.tIns.uid].workers + on[w.tSeed.uid].workers, 40, 1e-6, 'every free forager still allocated');

  // determinism: the same state allocates identically
  const again = trailWorld();
  again.s.run.colony.chitinReserve = 10;
  const on2 = allocTick(again.s, again.d);
  assert.equal(on2[again.tIns.uid].workers, on[w.tIns.uid].workers);

  // explicit assignments are untouched by the priority
  const ex = trailWorld();
  ex.s.run.colony.chitinReserve = 10;
  ex.tSeed.workers = 30;
  const exOn = allocTick(ex.s, ex.d);
  close(exOn[ex.tSeed.uid].workers, 30, 1e-9, 'explicit workers kept');
  close(exOn[ex.tIns.uid].workers, Math.min(10, exOn[ex.tIns.uid].cEff), 1e-6);
});

// ---- 4. bulk Adaptation buying -------------------------------------------------------------------------------------

test('C105 ×10 cost and Max (n): total of the next 10 levels, affordability, and the most levels affordable now', () => {
  const s = newState(1);
  s.run.adaptations.quick_dispatch = 3;
  const c10 = adaptCost(s, 'quick_dispatch', 10);
  s.run.res.food = c10.food - 1;
  let b = adaptBulk(s, 'quick_dispatch');
  assert.deepEqual(b.c10, c10);
  assert.equal(b.ok10, false, 'one food short of ×10');
  assert.equal(b.n, 9);
  assert.ok(canAfford(s, b.cMax) && !canAfford(s, adaptCost(s, 'quick_dispatch', 10)));
  s.run.res.food = c10.food;
  b = adaptBulk(s, 'quick_dispatch');
  assert.equal(b.ok10, true);
  assert.equal(b.n, 10);
  s.run.res.food = 1e30;
  b = adaptBulk(s, 'quick_dispatch');
  assert.ok(b.n > 10 && canAfford(s, adaptCost(s, 'quick_dispatch', b.n)) && !canAfford(s, adaptCost(s, 'quick_dispatch', b.n + 1)),
    'Max is exactly the largest affordable n (' + b.n + ')');
  // two-resource costs: chitin limits Serrated Mandibles
  s.run.res.chitin = 5 + 10;                           // L0 → 5 chitin, L1 → 10: two levels
  b = adaptBulk(s, 'serrated_mandibles');
  assert.equal(b.n, 2);
  assert.equal(b.ok10, false);
  s.run.res.food = 0;
  assert.equal(adaptBulk(s, 'quick_dispatch').n, 0, 'nothing affordable: Max (0)');
  // monomorphic cap: cost() is null past L10, so Max stops at the cap
  s.run.res.food = 1e30;
  s.run.hardship = 'monomorphic';
  s.run.adaptations.quick_dispatch = 7;
  b = adaptBulk(s, 'quick_dispatch');
  assert.equal(b.n, 3);
  assert.equal(b.c10, null);
});
