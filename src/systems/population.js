// Queen and brood: laying (caste choice, slots / housing / berths / reserve / nanitics / extras / Fungal Brood), brood
// allocation across brood groups, development and hatching, frost freezing and deaths, alate rearing, golden ants,
// Nutrition ("larvae eat first"), the population cross-calls and the colony/brood commands.
// Owner: WP2. Contract: ARCHITECTURE §8.1 (population.js), §9, DESIGN §5, §6.1, §6.4, §13.5, §17.3.
// ARCH-R: development applies the frost penalty ONCE. §8.1 defines bSpeed = Σ(unfrozen brood × factor) / B (frozen brood
// already contributes 0, DESIGN §5.3/C4) and then also multiplies progress by (1 − frozenShare); doing both would freeze
// brood twice, so the extra (1 − frozenShare) factor is not applied.
// ARCH-R: a dt = 0 (derive-only) pass lays, develops and kills nothing (layAcc starts at 1, so it would otherwise lay the
// 0:00 egg during newGame's derive pass); the 0:00 egg is laid on the first real tick (run.time 0 → 0.1).
// ARCH-R: a cohort that has never developed and was laid in the current integer second (p = 0, t = floor(run.time))
// develops for HALF the step (its eggs were laid, on average, mid-step), so big offline steps are unbiased against 0.1 s
// ticks; the first worker (egg at 0:00, T = 15 s) therefore hatches on the tick ending ~15.1 s.
// ARCH-R: a lay batch may be split into sub-batches (at most one per caste) so that a large batch (offline steps, huge λ)
// keeps the caste-slider shares; the deficit uses the eggs this run INCLUDING the batch being laid.
// ARCH-R: with the species eggFungusFrac, the fungus share is paid in fungus only when enough fungus is stored;
// otherwise the egg is paid fully in food (a leafcutter colony without gardens must not stall).
// ARCH-R: groomBrood accepts any brood-group chamber (Royal Chamber, nursery or hibernaculum), not only nurseries.
// ARCH-R: retireAdults exceeding the garrison is 'invalid:garrison'; rearAlate without an active Nuptial Chamber is
// 'requirements'; soldiersRaised counts soldier AND supermajor eggs.
// C70: eggs may be paid with the food produced at the cap during this step (env.foodSpill from economy.tick), spent
//   before the store and taken back out of run.stats.foodWasted, so one long step lays what the same time in ticks lays.
// C71: a slider caste (or requested alate) whose single egg costs more food than laying can ever spend (cap above the
//   egg reserve, or this step's store + spill) is skipped like a caste with a full berth, so it never blocks minors.
// C103: each hatched adult sheds MOLT.perHatch chitin (once caste_soldier or res_chitin is unlocked); d.rates.chitin.molts.
// C104: soldier / supermajor eggs spend only chitin above run.colony.chitinReserve (skipped like a full berth at or
//   below it); chitinNeed [q] tells trails.allocate when chitin trails get the auto-fill first.

import { CASTE_ORDER, CASTES } from '../data/castes.js';
import { EGG, BROOD, NUTRITION, SLIDERS, MOLT } from '../data/economy.js';
import { GENOME } from '../data/genome.js';
import { JOB_ORDER, JOBS } from '../data/jobs.js';
import { clampNum, lvl } from '../core/math.js';
import { canAfford, spend, grant } from '../core/wallet.js';
import { adultsTotal, broodTotal, clickAvailable, consumeClick } from '../core/state.js';
import { eggCost } from './stats.js';
import { releaseMinors, jobCap } from './jobs.js';

/** Numeric tolerance for float comparisons (not a balance number). */
const EPS = 1e-9;
const ADULT_CASTES = ['minor', 'soldier', 'supermajor', 'replete'];
const SLIDER_CASTES = ['soldier', 'supermajor', 'replete'];

/** Finite number or the fallback. */
function num(v, dflt = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Own-property test that is safe for '__proto__' and friends. */
function own(obj, k) {
  return !!obj && typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
}

/** Military castes: soldiers (Barracks berths) and supermajors (War Hall berths, C136). */
function isMilitary(c) {
  return own(CASTES, c) && (CASTES[c].house === 'berths' || CASTES[c].house === 'warBerths');
}

/** Σ brood n of one caste. */
function broodOf(s, caste) {
  let n = 0;
  for (const c of s.run.colony.brood) if (c.c === caste) n += c.n;
  return n;
}

/**
 * [q] Brood that will live in housing when it hatches (minors). Soldier / supermajor / replete / alate brood occupies
 * its own berth or cell instead (C91), so a full Gallery never blocks soldiers while Barracks berths are free.
 */
export function housingBrood(s) {
  let n = 0;
  for (const c of s.run.colony.brood) if (own(CASTES, c.c) && CASTES[c.c].house === 'housing') n += c.n;
  return n;
}

/** Integer run second used to merge cohorts. */
function runSecond(s) {
  return Math.floor(num(s.run.time) + EPS);
}

/** True if the job's unlock key is set (or it has none). */
function jobUnlocked(s, job) {
  const u = JOBS[job].unlock;
  return u === null || u === undefined || !!s.run.unlocked[u];
}

/** Colony scale as filled into d.stats (fallback d.meta). */
function scaleOf(d) {
  if (d && d.stats && d.stats.colonyScale > 0) return d.stats.colonyScale;
  if (d && d.meta && d.meta.colonyScale > 0) return d.meta.colonyScale;
  return 1;
}

/** Free capacity (may be fractional) of the home a caste lives in. */
function freeRoom(s, d, caste) {
  const col = s.run.colony;
  const st = d.stats;
  const B = broodTotal(s);
  switch (CASTES[caste].house) {
    case 'housing': return num(st.housing) - num(col.adults.minor) - housingBrood(s);
    // C136: Barracks berths house soldiers only; supermajors live in War Hall berths. Supermajors over their capacity
    // (older saves: they used to share the Barracks) stay alive and only block new supermajor eggs (negative room).
    case 'berths': return num(st.berths) - num(col.adults.soldier) - broodOf(s, 'soldier');
    case 'warBerths': return num(st.warBerths) - num(col.adults.supermajor) - broodOf(s, 'supermajor');
    case 'repleteBerths': return num(st.repleteBerths) - num(col.adults.replete) - broodOf(s, 'replete');
    case 'alateCells': return num(st.alateCells) - num(col.alatesReared) - broodOf(s, 'alate');
    default: return 0;
  }
}

/** New minors: forager in manual mode, or by the job targets (auto / threshold mode), honouring caps and locks. */
function assignNewMinors(s, d, k) {
  const col = s.run.colony;
  if (!(col.autoJobs || col.thresholdJobs)) {
    col.jobs.forager = clampNum(num(col.jobs.forager) + k);
    return;
  }
  const tg = col.jobTargets || {};
  let w = 0;
  let tSum = 0;
  for (const j of JOB_ORDER) {
    const t = clampNum(num(tg[j]), 0, 1);
    tSum += t;
    if (t > 0 && jobUnlocked(s, j)) w += t;
  }
  if (!(w > 0)) return;                                   // nothing to follow: they stay idle until the next rebalance
  const pool = Math.min(1, tSum) * k;
  for (const j of JOB_ORDER) {
    const t = clampNum(num(tg[j]), 0, 1);
    if (!(t > 0) || !jobUnlocked(s, j)) continue;
    const room = Math.max(0, jobCap(s, d, j) - num(col.jobs[j]));
    col.jobs[j] = clampNum(num(col.jobs[j]) + Math.min(room, pool * t / w));
  }
}

/**
 * [x] WP5, WP6, WP7. Add n adults of a caste. Minors join `forager` (manual mode) or follow the targets (auto mode).
 * capped: clamp to the free housing (minors), Barracks berths (soldiers), War Hall berths (supermajors) or replete berths.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} caste 'minor' | 'soldier' | 'supermajor' | 'replete'
 * @param {number} n
 * @param {{ capped?: boolean }} [opts]
 * @returns {number} the number actually added
 */
export function addAdults(s, d, caste, n, { capped = false } = {}) {
  if (!ADULT_CASTES.includes(caste) || !(n > 0) || !Number.isFinite(n)) return 0;
  let k = n;
  if (capped) k = Math.min(k, Math.max(0, freeRoom(s, d, caste)));
  if (!(k > 0)) return 0;
  const col = s.run.colony;
  if (!Number.isFinite(col.adults[caste])) return 0;          // non-finite hot path: left for the guard (§7.12)
  col.adults[caste] = clampNum(col.adults[caste] + k);
  if (caste === 'minor') assignNewMinors(s, d, k);
  return k;
}

/**
 * [x] WP2, WP4, WP5, WP6. Remove up to n adults of a caste. Minors leave `job` first, then idle, then all jobs
 * proportionally (jobs.releaseMinors); golden workers shrink in proportion. Never call it offline (torpor floor).
 * Emits nothing; callers emit adultsDied {caste, n, cause}.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} caste
 * @param {number} n
 * @param {string} cause
 * @param {{ job?: string|null }} [opts]
 * @returns {number} the number removed
 */
export function killAdults(s, d, caste, n, cause, { job = null } = {}) {
  if (!ADULT_CASTES.includes(caste) || !(n > 0)) return 0;
  const col = s.run.colony;
  if (!Number.isFinite(col.adults[caste])) return 0;          // non-finite hot path: left for the guard (§7.12)
  const before = col.adults[caste];
  const k = Math.min(clampNum(n), before);
  if (!(k > 0)) return 0;
  col.adults[caste] = clampNum(before - k);
  if (caste === 'minor') {
    let rem = k;
    if (own(JOBS, job)) {
      const t = Math.min(rem, num(col.jobs[job]));
      col.jobs[job] = clampNum(num(col.jobs[job]) - t);
      rem -= t;
    }
    let jobs = 0;
    for (const j of JOB_ORDER) jobs += num(col.jobs[j]);
    const idleBefore = Math.max(0, before - (k - rem) - jobs - num(col.militia));
    rem -= Math.min(rem, idleBefore);
    releaseMinors(s, rem, null);
    col.golden = before > 0 ? clampNum(num(col.golden) * (col.adults.minor / before)) : 0;
  }
  return k;
}

/** Remove frac of every cohort; returns the count removed. */
function removeBrood(s, frac) {
  const f = clampNum(num(frac), 0, 1);
  if (!(f > 0)) return 0;
  const col = s.run.colony;
  let removed = 0;
  const keep = [];
  for (const c of col.brood) {
    const k = c.n * f;
    removed += k;
    const left = clampNum(c.n - k);
    if (left > 0) {
      c.n = left;
      keep.push(c);
    }
  }
  col.brood = keep;
  return removed;
}

/**
 * [x] WP5, WP6. Remove frac of every cohort. Callers emit broodDied {n, cause}.
 * @param {import('../core/types.js').State} s
 * @param {number} frac 0..1
 * @param {string} cause
 * @returns {number} the count removed
 */
export function killBrood(s, frac, cause) {
  return removeBrood(s, frac);
}

/**
 * [x] WP5 (slave-makers). Like killBrood (cause 'stolen'); returns the count.
 * @param {import('../core/types.js').State} s
 * @param {number} frac 0..1
 * @returns {number}
 */
export function stealBrood(s, frac) {
  return removeBrood(s, frac);
}

/**
 * [q] How the brood is spread over the brood groups (DESIGN §5.3, §17.3, C4).
 * Without thermal_brood_shuttling the brood is proportional to (scaled) cap; with it, unexposed groups fill first by
 * factor (descending), then exposed/snap groups. Frozen = brood in exposed or snap groups, minus free hibernaculum
 * capacity (which shelters frost-exposed brood first). bSpeed = Σ(unfrozen brood × factor) / B (slot-weighted when B = 0).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ groups: Array<{ uid: number, kind: string, brood: number, frozen: number }>, frozenShare: number,
 *   frostShare: number, bSpeed: number, reachShare: number }}
 */
export function broodAllocation(s, d) {
  const cs = scaleOf(d);
  const src = d && d.nest && d.nest.agg && Array.isArray(d.nest.agg.broodGroups) ? d.nest.agg.broodGroups : [];
  const B = broodTotal(s);
  const gs = src.filter(Boolean).map((g, i) => ({
    i, uid: g.uid, kind: g.kind, cap: Math.max(0, num(g.cap)) * cs, factor: num(g.factor, 1),
    exposed: !!g.exposed, snap: !!g.snap && !g.exposed, inReach: !!g.inReach, brood: 0,
  }));
  let capTot = 0;
  for (const g of gs) capTot += g.cap;
  if (B > 0 && gs.length > 0) {
    if (!(capTot > 0)) {
      for (const g of gs) g.brood = B / gs.length;
    } else if (!s.run.research.thermal_brood_shuttling) {
      for (const g of gs) g.brood = B * g.cap / capTot;
    } else {
      const byFactor = (a, b) => b.factor - a.factor || a.i - b.i;
      const order = [...gs.filter((g) => !g.exposed && !g.snap).sort(byFactor), ...gs.filter((g) => g.exposed || g.snap).sort(byFactor)];
      let rem = B;
      for (const g of order) {
        const take = Math.min(rem, g.cap);
        g.brood = take;
        rem -= take;
      }
      if (rem > 0) for (const g of gs) g.brood += rem * g.cap / capTot;
    }
  }
  let expRaw = 0;
  let snapRaw = 0;
  let warm = 0;
  let hibFree = 0;
  let hibW = 0;
  let hibFW = 0;
  let reach = 0;
  for (const g of gs) {
    if (g.exposed) expRaw += g.brood;
    else if (g.snap) snapRaw += g.brood;
    else warm += g.brood * g.factor;
    if (g.kind === 'hib') {
      const free = Math.max(0, g.cap - g.brood);
      hibFree += free;
      hibW += free;
      hibFW += free * g.factor;
    }
    if (g.inReach) reach += g.brood;
  }
  const hibFactor = hibW > 0 ? hibFW / hibW : 1;
  const shelterExp = Math.min(expRaw, hibFree);
  const shelterSnap = Math.min(snapRaw, hibFree - shelterExp);
  const frostFrozen = expRaw - shelterExp;
  const snapFrozen = snapRaw - shelterSnap;
  const frozen = frostFrozen + snapFrozen;
  let bSpeed;
  if (B > 0) bSpeed = (warm + (shelterExp + shelterSnap) * hibFactor) / B;
  else {
    let w = 0;
    for (const g of gs) if (!g.exposed && !g.snap) w += g.cap * g.factor;
    bSpeed = capTot > 0 ? w / capTot : 1;
  }
  const groups = gs.map((g) => {
    const raw = g.exposed ? expRaw : g.snap ? snapRaw : 0;
    const part = g.exposed ? frostFrozen : g.snap ? snapFrozen : 0;
    return { uid: g.uid, kind: g.kind, brood: g.brood, frozen: raw > 0 ? g.brood * part / raw : 0 };
  });
  return {
    groups,
    frozenShare: B > 0 ? clampNum(frozen / B, 0, 1) : 0,
    frostShare: B > 0 ? clampNum(frostFrozen / B, 0, 1) : 0,
    bSpeed: clampNum(bSpeed),
    reachShare: B > 0 ? clampNum(reach / B, 0, 1) : 0,
  };
}

/**
 * [q] Brood by stage (egg p < 0.25, larva < 0.75, pupa), frozen count, total and per-caste totals.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ egg: number, larva: number, pupa: number, frozen: number, total: number, byCaste: Object<string, number> }}
 */
export function broodSummary(s, d) {
  const out = { egg: 0, larva: 0, pupa: 0, frozen: 0, total: 0, byCaste: {} };
  for (const c of CASTE_ORDER) out.byCaste[c] = 0;
  const [larvaAt, pupaAt] = BROOD.stages;
  for (const c of s.run.colony.brood) {
    if (c.p < larvaAt) out.egg += c.n;
    else if (c.p < pupaAt) out.larva += c.n;
    else out.pupa += c.n;
    out.total += c.n;
    if (own(out.byCaste, c.c)) out.byCaste[c.c] += c.n;
  }
  out.frozen = out.total * broodAllocation(s, d).frozenShare;
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// Laying
// ------------------------------------------------------------------------------------------------------------------

/** Most eggs the food above the reserve buys (nanitic minors first at their reduced price). */
function eggsByFood(avail, full, nanPrice, nanLeft) {
  if (!(avail > 0) || !(full > 0)) return 0;
  if (nanLeft > 0 && nanPrice > 0) {
    const nanCost = nanLeft * nanPrice;
    if (avail < nanCost) return Math.floor(avail / nanPrice);
    return nanLeft + Math.floor((avail - nanCost) / full);
  }
  return Math.floor(avail / full);
}

/** Extra-cost form helpers: total of `form` for n eggs of the caste, and the most eggs `have` covers. */
function extraTotal(s, caste, form, n) {
  const col = s.run.colony;
  if (typeof form === 'number') return form * n;
  if (form && typeof form.perOwned === 'number') return (num(form.base) + form.perOwned * num(col.adults[caste])) * n;
  if (form && typeof form.growth === 'number') {
    const first = num(form.base) * form.growth ** num(col.eggs[caste]);
    return form.growth === 1 ? first * n : first * (form.growth ** n - 1) / (form.growth - 1);
  }
  return 0;
}
function extraMax(s, caste, form, have) {
  const col = s.run.colony;
  if (typeof form === 'number' || (form && typeof form.perOwned === 'number')) {
    const per = typeof form === 'number' ? form : num(form.base) + form.perOwned * num(col.adults[caste]);
    return per > 0 ? Math.floor(have / per) : Infinity;
  }
  if (form && typeof form.growth === 'number') {
    const first = num(form.base) * form.growth ** num(col.eggs[caste]);
    if (!(first > 0)) return Infinity;
    if (form.growth === 1) return Math.floor(have / first);
    return Math.floor(Math.log(1 + have * (form.growth - 1) / first) / Math.log(form.growth) + EPS);
  }
  return Infinity;
}

/** C104: the chitin reserve (absolute chitin held back from soldier / supermajor eggs), clamped to the slider range. */
export function chitinReserve(s) {
  const steps = SLIDERS.chitinReserveSteps;
  return clampNum(num(s.run.colony.chitinReserve), 0, steps[steps.length - 1]);
}

/** Stock of resource r an egg of the caste may spend: military castes only spend chitin above the reserve (C104). */
function spendable(s, caste, r) {
  const have = num(s.run.res[r]);
  return r === 'chitin' && isMilitary(caste) ? Math.max(0, have - chitinReserve(s)) : have;
}

/** Most eggs of the caste the extras (chitin, honeydew, fungus …) allow. */
function eggsByExtras(s, caste) {
  const extra = CASTES[caste].extra || {};
  let n = Infinity;
  for (const r of Object.keys(extra)) n = Math.min(n, extraMax(s, caste, extra[r], spendable(s, caste, r)));
  return n;
}

/**
 * [q] C104 chitin demand, read by trails.allocate (auto-fill puts free foragers on chitin trails first while needed)
 * and the UI. next = the chitin of the next egg of the cheapest military caste the caste slider wants (with a free
 * berth), else of the next soldier egg; needed = some military caste can be laid at all, a reserve is set or a military
 * egg is wanted, and chitin < reserve + next. Pure (state + d.stats).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ needed: boolean, reserve: number, next: number, wanted: boolean }}
 */
export function chitinNeed(s, d) {
  const reserve = chitinReserve(s);
  const col = s.run.colony;
  let next = Infinity;
  let fallback = Infinity;
  let allowed = false;
  for (const c of ['soldier', 'supermajor']) {
    if (!casteAllowed(s, c)) continue;
    allowed = true;
    const form = CASTES[c].extra ? CASTES[c].extra.chitin : undefined;
    const one = form === undefined ? 0 : extraTotal(s, c, form, 1);
    if (c === 'soldier') fallback = one;
    if (num(col.casteTargets[c]) > 0 && d && d.stats && freeRoom(s, d, c) > EPS) next = Math.min(next, one);
  }
  const wanted = Number.isFinite(next);
  if (!wanted) next = Number.isFinite(fallback) ? fallback : 0;
  const needed = allowed && (wanted || reserve > 0) && num(s.run.res.chitin) < reserve + next - EPS;
  return { needed, reserve, next, wanted };
}

/** Caste rules that forbid laying a caste regardless of targets (hardships, locks). */
function casteAllowed(s, caste) {
  const h = s.run.hardship;
  if (h === 'monomorphic') return false;
  if (h === 'pacifist' && isMilitary(caste)) return false;
  const u = CASTES[caste].unlock;
  return !u || !!s.run.unlocked[u];
}

/** Food produced at the cap earlier in this step and not yet spent (economy.tick → env.foodSpill, C70). */
function spillOf(env) {
  const v = env ? env.foodSpill : 0;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Food laying may spend right now: the store above the egg reserve plus this step's spill (C70). */
function eggFoodAvail(s, d, env) {
  return num(s.run.res.food) - clampNum(num(s.run.colony.eggReserve), 0, 1) * num(d.stats.foodCap) + spillOf(env);
}

/**
 * C71: true if ONE egg of the caste costs more food than laying can ever spend — more than the food cap above the egg
 * reserve and more than is spendable this step (store + spill). Such a caste is skipped like a caste with a full berth
 * (DESIGN §5.5), so an unaffordable soldier / supermajor / alate egg never blocks every other egg (DESIGN §5.1).
 */
function foodOutOfReach(s, d, caste, env) {
  const base = eggCost(s, d, caste);
  if (!base) return true;
  let food = num(base.food);
  const sp = d.meta && d.meta.sp ? d.meta.sp : {};
  const frac = clampNum(num(sp.eggFungusFrac), 0, 1);
  if (frac > 0 && s.run.research.fungiculture && num(s.run.res.fungus) >= food * frac) food -= food * frac;
  const capReach = num(d.stats.foodCap) * (1 - clampNum(num(s.run.colony.eggReserve), 0, 1));
  return food > Math.max(capReach, eggFoodAvail(s, d, env)) * (1 + 1e-12) + EPS;
}

/** Choose the caste of the next sub-batch: { caste, limit } (DESIGN §5.5, §13.5; ARCHITECTURE §8.1 laying rules). */
function chooseCaste(s, d, remaining, env) {
  const col = s.run.colony;
  // (1) alates: rearing requested or auto-rear, with a free alate cell and the honeydew for at least one
  const alateFree = freeRoom(s, d, 'alate');
  if ((col.rearRequested > 0 || s.meta.automation.autoRear) && alateFree > EPS && eggsByExtras(s, 'alate') >= 1
    && !foodOutOfReach(s, d, 'alate', env)) {
    let limit = alateFree;
    if (!s.meta.automation.autoRear) limit = Math.min(limit, col.rearRequested);
    return { caste: 'alate', limit };
  }
  // (2) the caste-slider caste with the largest deficit, if its berth is free, its extras are affordable and storage
  // can ever pay for its egg (C71)
  let eggsTotal = 0;
  for (const c of CASTE_ORDER) eggsTotal += num(col.eggs[c]);
  const projected = eggsTotal + remaining;
  let best = null;
  let bestDef = 0;
  for (const c of SLIDER_CASTES) {
    const t = num(col.casteTargets[c]);
    if (!(t > 0)) continue;
    const def = t * projected - num(col.eggs[c]);
    if (!(def > bestDef)) continue;
    if (!casteAllowed(s, c) || !(freeRoom(s, d, c) > EPS) || eggsByExtras(s, c) < 1) continue;
    if (foodOutOfReach(s, d, c, env)) continue;
    best = c;
    bestDef = def;
  }
  if (best) return { caste: best, limit: Math.max(1, Math.ceil(bestDef - EPS)) };
  // (3) minor
  return { caste: 'minor', limit: Infinity };
}

/** Lay up to `want` eggs of one caste; returns the number laid (may be fractional when a cap is fractional). */
function layBatch(s, d, caste, want, env) {
  const col = s.run.colony;
  const st = d.stats;
  const res = s.run.res;
  const B = broodTotal(s);
  let n = Math.min(want, num(st.broodSlots) - B, freeRoom(s, d, caste)); // each caste is capped by its own home (C91)
  const base = eggCost(s, d, caste);
  if (!base || !(n > EPS)) return 0;
  const sp = d.meta && d.meta.sp ? d.meta.sp : {};
  const nanLeft = caste === 'minor' ? Math.max(0, num(col.naniticsLeft)) : 0;
  const full = caste === 'minor' && nanLeft > 0 ? base.food / EGG.naniticMult : base.food;
  const nanPrice = full * EGG.naniticMult;
  const spill = spillOf(env);
  const avail = eggFoodAvail(s, d, env);
  const byFood = eggsByFood(avail, full, nanPrice, nanLeft);
  // C69 founding reserve: a queen with no adult and no brood left lays one minor egg from her own reserves when the
  // stored food cannot pay for it (it costs whatever food there is; an egg reserve that merely holds food back still
  // blocks, as the player chose it). Otherwise a colony that lost every ant with an empty larder could never recover
  // where clicking for food is refused (Claustral Founding).
  const founding = caste === 'minor' && byFood < 1 && n >= 1 - EPS && B < EPS && adultsTotal(s) < 1
    && eggsByFood(num(res.food), full, nanPrice, nanLeft) < 1;
  n = founding ? 1 : Math.min(n, byFood, eggsByExtras(s, caste));
  if (!(n > EPS)) return 0;

  for (let attempt = 0; attempt <= 1; attempt++) {
    const nan = Math.min(n, nanLeft);
    const cost = { food: nan * nanPrice + (n - nan) * full };
    if (founding) cost.food = Math.min(cost.food, Math.max(0, num(res.food)));
    const extra = CASTES[caste].extra || {};
    for (const r of Object.keys(extra)) cost[r] = (cost[r] || 0) + extraTotal(s, caste, extra[r], n);
    let fungalOn = !!col.fungalBrood;
    if (fungalOn) {
      const fb = BROOD.fungalCostPerEgg * CASTES[caste].broodFactor * n;
      if (num(res.fungus) - (cost.fungus || 0) >= fb) cost.fungus = (cost.fungus || 0) + fb;
      else fungalOn = false;                          // C19: the toggle switches itself off when fungus runs short
    }
    const frac = num(sp.eggFungusFrac);
    if (frac > 0 && s.run.research.fungiculture) {
      const share = cost.food * clampNum(frac, 0, 1);
      if (num(res.fungus) - (cost.fungus || 0) >= share) {
        cost.food -= share;
        cost.fungus = (cost.fungus || 0) + share;
      }
    }
    // C70: food produced at the cap this step pays first (it would otherwise be wasted); the store pays the rest.
    const fromSpill = Math.min(spill, cost.food);
    const pay = fromSpill > 0 ? { ...cost, food: Math.max(0, cost.food - fromSpill) } : cost;
    if (canAfford(s, pay) && spend(s, pay)) {
      if (fromSpill > 0) {
        env.foodSpill = clampNum(spill - fromSpill);
        s.run.stats.foodWasted = clampNum(num(s.run.stats.foodWasted) - fromSpill);
      }
      if (col.fungalBrood && !fungalOn) col.fungalBrood = false;
      const sec = runSecond(s);
      const cohort = col.brood.find((c) => c.c === caste && c.t === sec);
      if (cohort) cohort.n = clampNum(cohort.n + n);
      else col.brood.push({ c: caste, n, p: 0, t: sec });
      col.eggs[caste] = clampNum(num(col.eggs[caste]) + n);
      s.run.stats.eggs = clampNum(num(s.run.stats.eggs) + n);
      if (isMilitary(caste)) s.run.stats.soldiersRaised = clampNum(num(s.run.stats.soldiersRaised) + n);
      if (nan > 0) col.naniticsLeft = clampNum(nanLeft - nan);
      if (caste === 'alate') col.rearRequested = clampNum(num(col.rearRequested) - n);
      env.emit('eggLaid', { caste, n });
      return n;
    }
    n = Math.floor(n - 1);                            // float edge: retry once with one egg fewer
    if (!(n > EPS)) return 0;
  }
  return 0;
}

/** Laying step (DESIGN §5.1). Skips while Hungry or λ = 0; clamps layAcc ≤ max(1, λ) when blocked (C18). */
function layEggs(s, d, econDt, env) {
  const col = s.run.colony;
  const st = d.stats;
  if (col.hungry || !(st.layRate > 0)) return;
  col.layAcc = clampNum(num(col.layAcc) + st.layRate * econDt);
  const due = Math.floor(col.layAcc);
  if (due < 1) return;
  let laid = 0;
  let blocked = false;
  for (let iter = 0; iter <= CASTE_ORDER.length; iter++) {
    const remaining = due - laid;
    if (!(remaining > EPS)) break;
    const pick = chooseCaste(s, d, remaining, env);
    const want = Math.min(remaining, pick.limit);
    const n = layBatch(s, d, pick.caste, want, env);
    laid += n;
    if (n >= want - EPS) continue;
    // A non-minor caste stopped by its OWN berth / extras, or whose egg storage can never pay for (C71), falls back
    // (chooseCaste now skips it, DESIGN §5.5); food, slots and housing are shared by every caste, so those block the
    // whole batch.
    if (pick.caste !== 'minor' && (!(freeRoom(s, d, pick.caste) > EPS) || eggsByExtras(s, pick.caste) < 1
      || foodOutOfReach(s, d, pick.caste, env))) continue;
    blocked = true;
    break;
  }
  col.layAcc = clampNum(col.layAcc - laid);
  if (blocked || laid < due - EPS) col.layAcc = Math.min(col.layAcc, Math.max(1, st.layRate));
}

// ------------------------------------------------------------------------------------------------------------------
// Development, hatching, frost, nutrition
// ------------------------------------------------------------------------------------------------------------------

/** C103: true once moults yield chitin (any MOLT.gate unlock key set). */
function moltsOn(s) {
  for (const k of MOLT.gate) if (s.run.unlocked[k]) return true;
  return false;
}

/**
 * Advance every cohort and hatch the finished ones (DESIGN §5.3; alates → alatesReared; golden_brood). Each hatched
 * adult sheds a pupal case worth MOLT.perHatch chitin (C103). Returns the moult chitin granted.
 */
function develop(s, d, econDt, env) {
  const col = s.run.colony;
  const st = d.stats;
  if (col.brood.length === 0) return 0;
  const alloc = broodAllocation(s, d);
  if (alloc.bSpeed > 0) {
    const baseT = BROOD.baseSec * num(st.mbt, 1) / Math.max(1, num(st.nurseTerm, 1)) / alloc.bSpeed;
    const sec = runSecond(s);
    for (const c of col.brood) {
      const T = baseT * (own(CASTES, c.c) ? num(CASTES[c.c].broodFactor, 1) : 1);
      const fresh = c.p === 0 && c.t === sec;
      c.p = T > 0 ? clampNum(num(c.p) + (fresh ? econDt / 2 : econDt) / T) : 1;
    }
  }
  const hatched = {};
  const keep = [];
  for (const c of col.brood) {
    if (c.p >= 1) hatched[c.c] = (hatched[c.c] || 0) + c.n;
    else keep.push(c);
  }
  if (keep.length === col.brood.length) return 0;
  col.brood = keep;
  let molt = 0;
  for (const caste of CASTE_ORDER) {
    const n = hatched[caste];
    if (!(n > 0)) continue;
    if (caste === 'alate') col.alatesReared = clampNum(num(col.alatesReared) + n);
    else addAdults(s, d, caste, n);
    if (caste === 'minor' && lvl(s.meta.genome, 'golden_brood') > 0) {
      const ch = own(GENOME, 'golden_brood') && GENOME.golden_brood.fx ? num(GENOME.golden_brood.fx.chance) : 0;
      col.golden = Math.min(num(col.adults.minor), clampNum(num(col.golden) + n * ch));
    }
    s.run.stats.hatched = clampNum(num(s.run.stats.hatched) + n);
    env.emit('hatched', { caste, n });
    if (moltsOn(s)) molt += grant(s, d, 'chitin', n * MOLT.perHatch);
  }
  return molt;
}

/** C103: d.rates.chitin.molts = moult chitin per second, an EMA (time constant MOLT.avgSec) for the resource tooltip. */
function moltRate(d, amount, econDt) {
  const r = d.rates && d.rates.chitin;
  if (!r || !(econDt > 0)) return;
  const cur = num(r.molts);
  r.molts = clampNum(cur + (amount / econDt - cur) * (1 - Math.exp(-econDt / MOLT.avgSec)));
}

/** Frost deaths: online, winter, not mild, year ≥ 1 (DESIGN §17.3). Snap freezes never kill. */
function frost(s, d, dt, env) {
  const season = d.season;
  if (env.offline || season.id !== 'winter' || season.mild || !(num(season.year) >= 1)) return;
  if (s.run.colony.brood.length === 0) return;
  const frac = broodAllocation(s, d).frostShare * BROOD.frostDeathPerSec * dt;
  if (!(frac > 0)) return;
  const n = killBrood(s, frac, 'frost');
  if (n > 0) env.emit('broodDied', { n, cause: 'frost' });
}

/** Nutrition (DESIGN §6.4), drawn after laying paid every fungus egg cost ("larvae eat first"). */
function nutrition(s, econDt) {
  if (!s.run.research.fungiculture || !(econDt > 0)) return;
  const res = s.run.res;
  const demand = NUTRITION.perAdult * adultsTotal(s) * econDt;
  const supplied = Math.min(num(res.fungus), demand);
  if (Number.isFinite(res.fungus)) res.fungus = clampNum(res.fungus - supplied);
  s.run.colony.phi = demand > 0 ? clampNum(supplied / demand, 0, 1) : 0;
}

/**
 * Laying, development and hatching, frost deaths, then Nutrition. Integrates over env.econDt (frost over dt).
 * O(cohorts) work for any dt (offline steps lay one batch).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const step = dt > 0 ? dt : 0;
  const econDt = step > 0 ? (env && env.econDt > 0 ? env.econDt : step) : 0;
  if (!(step > 0)) return;
  layEggs(s, d, econDt, env);
  moltRate(d, develop(s, d, econDt, env), econDt);
  frost(s, d, dt, env);
  nutrition(s, econDt);
  const a = adultsTotal(s);
  if (a > num(s.run.stats.maxAdults)) s.run.stats.maxAdults = clampNum(a);
}

// ------------------------------------------------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------------------------------------------------

/** A finite number in [lo, hi]. */
function inRange(v, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/** Find a brood group (raw agg entry) by chamber uid. */
function broodGroup(d, uid) {
  const gs = d && d.nest && d.nest.agg && Array.isArray(d.nest.agg.broodGroups) ? d.nest.agg.broodGroups : [];
  return gs.find((g) => g && g.uid === uid && typeof uid === 'number') || null;
}

/** Colony / brood command handlers (ARCHITECTURE §9). */
export const handlers = {
  /** setCasteTargets { soldier, supermajor, replete }: fractions, Σ ≤ 0.9; an omitted key keeps its current value. */
  setCasteTargets: {
    validate(s, d, cmd) {
      let sum = 0;
      for (const c of SLIDER_CASTES) {
        const v = cmd[c] === undefined ? s.run.colony.casteTargets[c] : cmd[c];
        if (!inRange(v, 0, 1)) return 'invalid';
        if (v > 0) {
          if (s.run.hardship === 'monomorphic') return 'hardship';
          if (s.run.hardship === 'pacifist' && isMilitary(c)) return 'hardship';
          if (!s.run.unlocked[CASTES[c].unlock]) return 'locked';
        }
        sum += v;
      }
      if (sum > SLIDERS.casteSumMax + EPS) return 'invalid:sum';
      return null;
    },
    apply(s, d, cmd) {
      const col = s.run.colony;
      const next = {};
      for (const c of SLIDER_CASTES) next[c] = clampNum(cmd[c] === undefined ? num(col.casteTargets[c]) : cmd[c], 0, 1);
      col.casteTargets = next;
      s.meta.automation.keep.casteTargets = { ...next };
    },
  },

  /** setEggReserve { frac }: 0..0.9 of the food cap held back from eggs. */
  setEggReserve: {
    validate(s, d, cmd) {
      return inRange(cmd.frac, 0, SLIDERS.eggReserveMax) ? null : 'invalid';
    },
    apply(s, d, cmd) {
      s.run.colony.eggReserve = clampNum(cmd.frac, 0, SLIDERS.eggReserveMax);
    },
  },

  /** setChitinReserve { amount }: C104, chitin held back from soldier / supermajor eggs (0..last ladder step). */
  setChitinReserve: {
    validate(s, d, cmd) {
      const steps = SLIDERS.chitinReserveSteps;
      return inRange(cmd.amount, 0, steps[steps.length - 1]) ? null : 'invalid';
    },
    apply(s, d, cmd) {
      const steps = SLIDERS.chitinReserveSteps;
      s.run.colony.chitinReserve = clampNum(cmd.amount, 0, steps[steps.length - 1]);
    },
  },

  /** setFungalBrood { on }: needs fungiculture to switch on. */
  setFungalBrood: {
    validate(s, d, cmd) {
      if (typeof cmd.on !== 'boolean') return 'invalid';
      if (cmd.on && !s.run.research.fungiculture) return 'locked';
      return null;
    },
    apply(s, d, cmd) {
      s.run.colony.fungalBrood = cmd.on;
    },
  },

  /** rearAlate { n }: request n alate eggs (needs unlock alate_rearing and an active Nuptial Chamber). */
  rearAlate: {
    validate(s, d, cmd) {
      if (!Number.isInteger(cmd.n) || cmd.n < 1) return 'invalid';
      if (!s.run.unlocked.alate_rearing) return 'locked';
      const nup = d && d.nest && d.nest.agg ? d.nest.agg.nuptial : null;
      if (!nup || !nup.active) return 'requirements';
      return null;
    },
    apply(s, d, cmd) {
      s.run.colony.rearRequested = clampNum(num(s.run.colony.rearRequested) + cmd.n);
    },
  },

  /** groomBrood { chamber }: click; every cohort gains groomPct × that group's share of the brood capacity (C20). */
  groomBrood: {
    validate(s, d, cmd) {
      if (s.run.hardship === 'claustral_founding') return 'hardship';
      if (!broodGroup(d, cmd.chamber)) return 'notFound';
      if (!clickAvailable(s)) return 'clickCap';
      return null;
    },
    apply(s, d, cmd) {
      if (!consumeClick(s)) return;
      const g = broodGroup(d, cmd.chamber);
      let capTot = 0;
      for (const x of d.nest.agg.broodGroups) if (x) capTot += Math.max(0, num(x.cap));
      const add = capTot > 0 ? BROOD.groomPct * Math.max(0, num(g.cap)) / capTot : 0;
      if (!(add > 0)) return;
      for (const c of s.run.colony.brood) c.p = clampNum(num(c.p) + add);
    },
  },

  /** clickQueen {}: click; meta.counters.queenClicks++. Allowed under claustral_founding (C32). */
  clickQueen: {
    validate(s) {
      return clickAvailable(s) ? null : 'clickCap';
    },
    apply(s) {
      if (consumeClick(s)) s.meta.counters.queenClicks = clampNum(num(s.meta.counters.queenClicks) + 1);
    },
  },

  /** retireAdults { caste, n }: garrison soldiers/supermajors → minors (needs free housing; no refund). */
  retireAdults: {
    validate(s, d, cmd) {
      const { caste, n } = cmd;
      if (!isMilitary(caste)) return 'invalid';
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 'invalid';
      const gar = d && d.combat && d.combat.garrison ? num(d.combat.garrison[caste]) : 0;
      if (n > Math.min(gar, num(s.run.colony.adults[caste])) + EPS) return 'invalid:garrison';
      if (n > freeRoom(s, d, 'minor') + EPS) return 'noSlot:housing';
      return null;
    },
    apply(s, d, cmd, env) {
      const col = s.run.colony;
      const k = Math.min(cmd.n, num(col.adults[cmd.caste]));
      if (!(k > 0)) return;
      col.adults[cmd.caste] = clampNum(num(col.adults[cmd.caste]) - k);
      addAdults(s, d, 'minor', k);
      env.emit('adultsRetired', { caste: cmd.caste, n: k });
    },
  },
};
