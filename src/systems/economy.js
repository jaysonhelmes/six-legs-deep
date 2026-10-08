// Economy tick: passive ledger entries (Scent Library, Root Aphid Pens, Fungus Gardens), softcaps with pro-rata source
// shares, food with the cap / overflow / f_run rule, upkeep, clay spoilage, other resources and soil, pheromone regen,
// the Hungry state (and harsh_nature starvation), d.rates; the hand-forage click; the Winter Stores projection.
// Owner: WP2. Contract: ARCHITECTURE §8.1 (economy.js), §5 (d.ledger, d.rates), §7.3 (eff), DESIGN §3, §4, §5.7–§5.8,
// §6.2, §12, §18 C1.
// ARCH-R: d.rates[res].net is income minus sinks per second (production × eff − upkeep × eff − spoilage), not clipped by
// a full store; food.upkeep is the upkeep actually charged (× eff). Production into a capped store never reduces a stock
// that is already above its cap (the food overflow rule, applied to every capped resource).
// ARCH-R: "softcapHit the first time a stat caps (per run)" is tracked in memory per derived cache (not saved), so it can
// fire once more after a reload. run.stats.winterHungry is reset when a winter begins (seasonChanged → winter) and set
// while Hungry in winter, so it means "Hungry during the current or most recent winter".
// ARCH-R: a dt = 0 (derive-only) pass computes rates only (no stock changes, no Hungry transitions).
// ARCH-R: step 4 (food) is integrated exactly over the step instead of "add production clipped at the cap, then
// subtract the whole step's upkeep": the sequential form leaves food at cap − upkeep × dt, i.e. 30 food below the cap
// after every 60 s offline step (breaking the DESIGN §21.3 offline-vs-online 2 % invariant). Both agree as dt → 0 and
// whenever the cap does not bind; f_run still counts all production, wasted = production neither stored nor eaten.
// C70: env.foodSpill = the food produced AT the cap this step (part of wasted); population.tick may still buy eggs with
//   it (and takes it back out of foodWasted).
// C76: d.rates[res].avg (ledger resources) is an exponential moving average of gross with time constant INCOME_AVG.sec,
//   advanced by econDt; a derived cache without history starts it at the current gross. wallet.incomeSeconds uses it.
// C103: ledger chitin.midden = CHAMBERS.midden.fx.chitin × agg.middenL × stats.chitin (Midden recycling).
// C199: chitin is capped at d.stats.chitinCap like honeydew (income adds up to the cap, never lowering a stock above it);
//   the stock above the cap (one-shot overflow, a cap that shrank) decays at CHITIN.decayPerMin of the excess per minute,
//   integrated exactly over econDt (offline too: it is a resource, not an ant). d.rates.chitin.decay = that loss per
//   second, cap = the cap; net = income × eff − decay.

import { SOFTCAPS } from '../data/balance.js';
import { JOBS } from '../data/jobs.js';
import { HUNGRY, SPOILAGE, CLICK, INCOME_AVG, CHITIN } from '../data/economy.js';
import { CHAMBERS } from '../data/chambers.js';
import { scChain, clampNum, safeDiv } from '../core/math.js';
import { grant } from '../core/wallet.js';
import { clickAvailable, consumeClick, adultsTotal } from '../core/state.js';
import { killAdults } from './population.js';

const LEDGER_RES = ['food', 'insight', 'honeydew', 'fungus', 'chitin', 'leaves'];
const ADULT_CASTES = ['minor', 'soldier', 'supermajor', 'replete'];
const CAP_KEY = { honeydew: 'honeydewCap', fungus: 'fungusCap', leaves: 'leafCap', pheromone: 'pheromoneCap', chitin: 'chitinCap' };

/** Finite number or the fallback. */
function num(v, dflt = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Own-property test that is safe for '__proto__' and friends. */
function own(obj, k) {
  return !!obj && typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
}

/** A numeric fx value of table[id].fx[key], or `dflt` (neutral) when absent. */
function fx(table, id, key, dflt) {
  const e = own(table, id) ? table[id] : null;
  return e && e.fx ? num(e.fx[key], dflt) : dflt;
}

/** C199: the chitin cap (no cap known → unlimited). */
function chitinCapOf(st) {
  const c = st ? st.chitinCap : undefined;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : Infinity;
}

/** Σ of the finite values of a ledger bucket. */
function sumBucket(b) {
  let t = 0;
  if (b && typeof b === 'object') for (const k of Object.keys(b)) t += num(b[k]);
  return t;
}

/**
 * Write a hot-path value (ARCHITECTURE §7.12): a stock that is already non-finite is left untouched so the guard reverts
 * it to its last good value and reports it; otherwise the new value is clamped to [0, CLAMP_MAX].
 */
function hot(cur, next) {
  return typeof cur === 'number' && Number.isFinite(cur) ? clampNum(next) : cur;
}

/** Set a ledger rate only when it is positive (step() resets the ledger every tick, so absent = 0). */
function setLedger(bucket, label, v) {
  const x = clampNum(v);
  if (x > 0) bucket[label] = x;
  else delete bucket[label];
}

/** Add `delta` to a capped stock: up to the cap, never reducing a stock already above it. */
function addCapped(cur, delta, cap) {
  if (!(delta > 0)) return clampNum(cur);
  if (cur >= cap) return clampNum(cur);
  return clampNum(Math.min(cap, cur + delta));
}

// ---- in-memory, per-d helpers (never saved) ------------------------------------------------------------------------

/** Click food window entries per derived cache: [{ t, amount }]. @type {WeakMap<object, Array<{t:number, amount:number}>>} */
const clickWin = new WeakMap();
/** Per-run softcap reports per derived cache. @type {WeakMap<object, { key: string, seen: Object<string, boolean> }>} */
const softcapSeen = new WeakMap();

/** Emit softcapHit {stat} the first time `stat` caps in the current run. */
function softcapOnce(s, d, env, stat) {
  const key = s.run.index + ':' + s.run.seed;
  let rec = softcapSeen.get(d);
  if (!rec || rec.key !== key) {
    rec = { key, seen: {} };
    softcapSeen.set(d, rec);
  }
  if (rec.seen[stat]) return;
  rec.seen[stat] = true;
  env.emit('softcapHit', { stat });
}

/** Average click food per second over the last CLICK.avgSec seconds of run time. */
function clickAverage(s, d) {
  const win = clickWin.get(d);
  if (!win || win.length === 0) return 0;
  const from = num(s.run.time) - CLICK.avgSec;
  let w = 0;
  let total = 0;
  for (const e of win) {
    if (e.t > from && e.t <= num(s.run.time)) {
      win[w++] = e;
      total += e.amount;
    }
  }
  win.length = w;
  return clampNum(total / CLICK.avgSec);
}

/**
 * Food over one step, exact for any step length (so 60 s offline steps match 0.1 s ticks): production P/s and upkeep
 * U/s act together. Above the cap production adds nothing and food falls at U until it reaches the cap (DESIGN §3
 * overflow); at or below the cap food moves at P − U, never above the cap (the excess is wasted) nor below 0.
 * Wasted = production that was neither stored nor eaten by upkeep. Spill = the part of it produced while food sat AT the
 * cap (not above it): the queen may still turn it into eggs this step (C70), since in continuous time an egg bought at
 * the cap makes room that production refills at once.
 * @returns {{ value: number, wasted: number, spill: number }}
 */
function integrateFood(food0, cap, P, U, T) {
  let food = food0;
  let wasted = 0;
  let spill = 0;
  let rest = T;
  if (food > cap) {
    const tau = U > 0 ? Math.min(T, (food - cap) / U) : T;
    food -= U * tau;
    wasted += P * tau;
    rest = T - tau;
  }
  if (rest > 0) {
    const net = P - U;
    if (net >= 0) {
      const grow = Math.max(0, Math.min(cap - food, net * rest));
      food += grow;
      spill = Math.max(0, net * rest - grow);
      wasted += spill;
    } else {
      food = Math.max(0, food + net * rest);
    }
  }
  return { value: clampNum(food), wasted: clampNum(wasted), spill: clampNum(spill) };
}

/**
 * C76: advance the smoothed gross income (DESIGN §3 "seconds of income" one-shot rewards) by dt seconds: an EMA with
 * time constant INCOME_AVG.sec (exact for any step length); no history yet → the current gross.
 */
function smoothIncome(rate, g, dt) {
  if (!rate) return;
  if (!(typeof rate.avg === 'number' && Number.isFinite(rate.avg))) rate.avg = g;
  else if (dt > 0) rate.avg = clampNum(rate.avg + (g - rate.avg) * (1 - Math.exp(-dt / INCOME_AVG.sec)));
}

/** Write the rate fields of one resource into d.rates (keeping the object identity). */
function setRate(d, res, fields) {
  if (!d.rates[res] || typeof d.rates[res] !== 'object') d.rates[res] = { raw: 0, gross: 0, net: 0, sc: false, src: {} };
  Object.assign(d.rates[res], fields);
}

/**
 * Economy tick (ARCHITECTURE §8.1 steps 1–10). Production and upkeep integrate over env.econDt × env.eff;
 * spoilage and starvation over dt (online only).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const run = s.run;
  const res = run.res;
  const col = run.colony;
  const st = d.stats;
  const agg = d.nest.agg;
  const step = dt > 0 ? dt : 0;
  const econDt = step > 0 ? (env && env.econDt > 0 ? env.econDt : step) : 0;
  const eff = env && env.eff >= 0 && Number.isFinite(env.eff) ? env.eff : 1;
  const offline = !!(env && env.offline);
  const winter = d.season.id === 'winter';
  const L = d.ledger;
  for (const r of LEDGER_RES) if (!L[r] || typeof L[r] !== 'object') L[r] = {};

  // 1. passives into the ledger (raw rates)
  setLedger(L.insight, 'library', num(agg.libraryInsight) * num(st.insight.library, 1));
  setLedger(L.honeydew, 'pens', fx(CHAMBERS, 'root_aphid_pen', 'honeydew', 0) * num(agg.rootPenL)
    * (winter ? fx(CHAMBERS, 'root_aphid_pen', 'winter', 1) : 1));
  // C103: Middens recycle chitin from refuse: fx.chitin /s per effective level (agg.middenL already carries the chamber
  // eff: frost, completion), × the chitin channel (prestige, Hungry).
  setLedger(L.chitin, 'midden', fx(CHAMBERS, 'midden', 'chitin', 0) * num(agg.middenL) * num(st.chitin, 1));

  // 2. fungus gardens: gardeners turn leaves into fungus
  const active = Math.max(0, Math.min(num(col.jobs.gardener), num(st.gardenerSlots)));
  const leafRate = sumBucket(L.leaves);
  const demand = JOBS.gardener.fx.leavesIn * active;
  let ratio = 1;
  if (demand > 0) {
    if (econDt > 0) ratio = Math.min(1, (num(res.leaves) + leafRate * eff * econDt) / (demand * econDt));
    else ratio = num(res.leaves) > 0 ? 1 : Math.min(1, safeDiv(leafRate * eff, demand, 0));
  }
  setLedger(L.fungus, 'gardens', active * JOBS.gardener.fx.fungusOut * ratio * num(agg.fungusMod, 1) * num(st.fungus, 1));
  const leavesUsedRate = demand * ratio;

  // 3. softcaps on the aggregate, sources scaled pro rata
  const gross = {};
  for (const r of LEDGER_RES) {
    const raw = sumBucket(L[r]);
    const chain = SOFTCAPS[r] || null;
    const out = chain ? scChain(raw, chain, r === 'food' ? num(st.scMult.food, 1) : 1) : { value: raw, capped: false };
    const g = clampNum(out.value);
    const f = raw > 0 ? g / raw : 0;
    const src = {};
    for (const k of Object.keys(L[r])) src[k] = clampNum(num(L[r][k]) * f);
    gross[r] = g;
    if (out.capped && env) softcapOnce(s, d, env, r);
    setRate(d, r, { raw: clampNum(raw), gross: g, sc: out.capped, src });
    smoothIncome(d.rates[r], g, econDt);
  }

  // 4. food: production up to the cap (nothing while above it), f_run counts everything (C1), minus upkeep
  const upkeepRate = num(st.upkeep) * eff;
  let spoilRate = 0;
  if (econDt > 0) {
    const cap = num(st.foodCap);
    const P = gross.food * eff;
    const delta = P * econDt;
    const out = integrateFood(num(res.food), cap, P, upkeepRate, econDt);
    if (delta > 0) {
      run.fRun = hot(run.fRun, run.fRun + delta);
      s.meta.stats.foodEver = clampNum(num(s.meta.stats.foodEver) + delta);
    }
    if (out.wasted > 0) run.stats.foodWasted = clampNum(num(run.stats.foodWasted) + out.wasted);
    // C70: food produced at the cap this step, still spendable on this step's eggs (population.tick runs next).
    if (env) env.foodSpill = out.spill;
    let food = out.value;
    // 5. clay spoilage (online only, real time)
    if (!offline) {
      spoilRate = food * num(agg.clayFoodShare) * SPOILAGE.clayPerMin / 60;
      food -= spoilRate * step;
    }
    res.food = hot(res.food, food);

    // 6. other resources and soil
    res.insight = hot(res.insight, res.insight + gross.insight * eff * econDt);
    const chitinCap = chitinCapOf(st);
    let chitin = addCapped(num(res.chitin), gross.chitin * eff * econDt, chitinCap);
    if (chitin > chitinCap) chitin = chitinCap + (chitin - chitinCap) * Math.exp(-CHITIN.decayPerMin / 60 * econDt);
    res.chitin = hot(res.chitin, chitin);
    res.honeydew = hot(res.honeydew, addCapped(res.honeydew, gross.honeydew * eff * econDt, num(st[CAP_KEY.honeydew])));
    res.fungus = hot(res.fungus, addCapped(res.fungus, gross.fungus * eff * econDt, num(st[CAP_KEY.fungus])));
    const used = leavesUsedRate * econDt * eff;
    const inflow = gross.leaves * eff * econDt;
    const fromStock = Math.min(num(res.leaves), used);
    const fromInflow = Math.min(inflow, used - fromStock);
    res.leaves = hot(res.leaves, addCapped(num(res.leaves) - fromStock, inflow - fromInflow, num(st[CAP_KEY.leaves])));
    res.soil = hot(res.soil, res.soil + num(st.digW) * num(st.soilMult, 1) * eff * econDt);
  } else if (!offline) {
    spoilRate = num(res.food) * num(agg.clayFoodShare) * SPOILAGE.clayPerMin / 60;
  }

  // 7. pheromone (once scent_marking is owned)
  const phero = run.research.scent_marking ? num(st.pheromoneRegen) : 0;
  if (econDt > 0 && phero > 0) res.pheromone = hot(res.pheromone, addCapped(res.pheromone, phero * eff * econDt, num(st[CAP_KEY.pheromone])));

  // 9. Hungry (online only; never set offline), harsh_nature starvation
  const netFood = (gross.food - num(st.upkeep)) * eff - spoilRate;
  if (step > 0 && env) {
    for (const e of env.events) if (e && e.type === 'seasonChanged' && e.id === 'winter') run.stats.winterHungry = false;
    if (offline) {
      if (col.hungry) {
        col.hungry = false;
        env.emit('hungryEnd');
      }
    } else if (!col.hungry && num(res.food) <= 0 && netFood < 0) {
      col.hungry = true;
      run.stats.hungryEver = true;
      env.emit('hungryStart');
    } else if (col.hungry && (num(res.food) > HUNGRY.endFrac * num(st.foodCap) || adultsTotal(s) < 1)) {
      // C69: a queen alone has no upkeep to starve on; ending Hungry lets her lay the founding egg (population.js).
      col.hungry = false;
      env.emit('hungryEnd');
    }
    if (col.hungry && winter) run.stats.winterHungry = true;
    if (col.hungry && !offline && s.meta.settings.harshNature) {
      for (const c of ADULT_CASTES) {
        const n = num(col.adults[c]) * HUNGRY.harshDeathPerSec * step;
        if (!(n > 0)) continue;
        const k = killAdults(s, d, c, n, 'starvation');
        if (k > 0) env.emit('adultsDied', { caste: c, n: k, cause: 'starvation' });
      }
    }
  }

  // 10. d.rates (gross = after softcap at efficiency 1; net = income − sinks incl. efficiency)
  setRate(d, 'food', { net: netFood, upkeep: clampNum(upkeepRate), clicks: clickAverage(s, d) });
  setRate(d, 'insight', { net: clampNum(gross.insight * eff) });
  const chitinCap = chitinCapOf(st);
  const chitinDecay = Math.max(0, num(res.chitin) - chitinCap) * CHITIN.decayPerMin / 60;
  setRate(d, 'chitin', { net: gross.chitin * eff - chitinDecay, decay: clampNum(chitinDecay), cap: clampNum(chitinCap) });
  setRate(d, 'honeydew', { net: clampNum(gross.honeydew * eff) });
  setRate(d, 'fungus', { net: clampNum(gross.fungus * eff) });
  setRate(d, 'leaves', { net: (gross.leaves - leavesUsedRate) * eff });
  const soil = clampNum(num(st.digW) * num(st.soilMult, 1));
  setRate(d, 'soil', { raw: clampNum(num(st.digRaw, num(st.digW)) * num(st.soilMult, 1)), gross: soil, net: clampNum(soil * eff),
    sc: num(st.digRaw) > num(st.digW), src: { dig: soil } });
  setRate(d, 'pheromone', { raw: phero, gross: phero, net: clampNum(phero * eff), sc: false, src: phero > 0 ? { regen: phero } : {} });
}

/**
 * [q] Winter Stores gauge (DESIGN §17.4): stored food, projected winter net food/s (current gross scaled from the current
 * season forage factor to the coming winter's, minus winter upkeep), clay spoilage per minute, and the winter seconds
 * the projection covers (what is left of this winter, else one season length).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ stored: number, netPerSec: number, spoilPerMin: number, winterSec: number }}
 */
export function winterProjection(s, d) {
  const st = d.stats;
  const stored = num(s.run.res.food);
  const gross = d.rates && d.rates.food ? num(d.rates.food.gross) : 0;
  const scale = safeDiv(num(st.forageWinter, 1), num(st.seasonForage, 1), 1);
  const netPerSec = gross * scale - num(st.upkeepWinter, num(st.upkeep));
  const spoilPerMin = clampNum(stored * num(d.nest.agg.clayFoodShare) * SPOILAGE.clayPerMin);
  const winterSec = d.season.id === 'winter' ? clampNum(num(d.season.toNext)) : clampNum(num(s.meta.season.lengthSec));
  return { stored, netPerSec, spoilPerMin, winterSec };
}

/** Sources that cannot be hand-foraged (ARCHITECTURE §8.1): prey, the termite mound and the lycaenid caterpillar. */
function clickable(type) {
  return typeof type === 'string' && !type.startsWith('prey_') && type !== 'termite_mound' && type !== 'lycaenid_caterpillar';
}

/** Find a source by uid. */
function findSource(s, uid) {
  if (typeof uid !== 'number') return null;
  return s.run.surface.sources.find((x) => x && x.uid === uid) || null;
}

/** Economy command handlers (ARCHITECTURE §9). */
export const handlers = {
  /** clickForage { src }: click; hand-forage a revealed source for d.stats.clickValue food (counts toward f_run). */
  clickForage: {
    validate(s, d, cmd) {
      const src = findSource(s, cmd.src);
      if (!src) return 'notFound';
      if (!clickable(src.type)) return 'invalid';
      if (s.run.surface.revealed[src.hex] !== 1) return 'invalid:hidden';
      if (s.run.hardship === 'claustral_founding') return 'hardship';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!consumeClick(s)) return;
      const amount = clampNum(num(d.stats.clickValue));
      grant(s, d, 'food', amount);
      let win = clickWin.get(d);
      if (!win) {
        win = [];
        clickWin.set(d, win);
      }
      win.push({ t: num(s.run.time), amount });
      env.emit('clicked', { src: cmd.src, amount });
    },
  },
};
