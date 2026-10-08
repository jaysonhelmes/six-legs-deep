// Colony multiplier stacks → d.stats every tick: colony scale, housing / brood slots / berths, caps, lay rate, egg costs,
// brood-time terms, worker multipliers, forage / dig / honeydew / leaves / fungus / chitin / insight channels, upkeep,
// nutrition, combat multipliers, pheromone regen, click value and thermal_ceiling softcap multipliers.
// Owner: WP2. Contract: ARCHITECTURE §8.1 (pinned formulas), §5 (d.stats), §12 (which bonuses WP2 implements).
// Numbers owned by other packages are read from their data tables (fx); a missing entry is neutral (×1 / +0).
// ARCH-R: d.stats gains three extension fields beyond §5: digRaw (dig work/s before the softcap), upkeepWinter (upkeep
// with the winter reductions, for the Winter Stores gauge) and forageWinter (season_forage of the coming winter).
// ARCH-R: workerMult's nanitic term (m + 2·min(50, m)) / max(1, m) is 0 at m = 0 minors; it is taken as 1 there.

import { SOFTCAPS, COST_MAX } from '../data/balance.js';
import { CASTES, CASTE_ORDER } from '../data/castes.js';
import { JOBS } from '../data/jobs.js';
import { EGG, LAY, BROOD, UPKEEP, HUNGRY, NUTRITION, PHEROMONE, CAPS, CLICK, WINTER_R, ACH_FX, CHITIN } from '../data/economy.js';
import { ADAPTATIONS } from '../data/adaptations.js';
import { RESEARCH, REFINEMENT, ARCHIVE } from '../data/research.js';
import { CHAMBERS } from '../data/chambers.js';
import { MOUND, TERRITORY } from '../data/surface.js';
import { TRAITS } from '../data/bloodline.js';
import { FEDERATION } from '../data/federation.js';
import { GENOME, SIGNATURES } from '../data/genome.js';
import { HARDSHIPS, EDICTS, SITES } from '../data/prestige.js';
import { SEASON_MODS } from '../data/seasons.js';
import { scChain, clampNum, lvl, safeDiv } from '../core/math.js';
import { effectMult, effectAdd } from '../core/effects.js';
import { adultsTotal, popN } from '../core/state.js';

const ADULT_CASTES = ['minor', 'soldier', 'supermajor', 'replete'];

/** Finite number or the fallback. */
function num(v, dflt = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Own-property test that is safe for '__proto__' and friends. */
function own(obj, k) {
  return !!obj && typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
}

/** A numeric fx value of table[id].fx[key], or `dflt` (neutral) when the entry or key is absent. */
function fx(table, id, key, dflt) {
  const e = own(table, id) ? table[id] : null;
  const f = e && e.fx;
  return f ? num(f[key], dflt) : dflt;
}

/** base^exp, clamped to [0, CLAMP_MAX] (exp 0 → 1). */
function pw(base, exp) {
  if (!(exp > 0)) return 1;
  return clampNum(base ** exp);
}

/** True if the run owns this research node. */
function hasResearch(s, id) {
  return !!s.run.research[id];
}

/** True if the achievement has been earned (meta.achievements[id] = simTime earned, which may be 0). */
function hasAch(s, id) {
  return own(s.meta.achievements, id) && s.meta.achievements[id] !== null;
}

/** Product of the ACH_FX multipliers on `stat` over earned achievements. */
function achMult(s, stat) {
  let m = 1;
  for (const id of Object.keys(ACH_FX)) {
    const v = ACH_FX[id][stat];
    if (typeof v === 'number' && hasAch(s, id)) m *= v;
  }
  return m;
}

/** Refinement multiplier of a branch: REFINEMENT.mult^level. */
function refine(s, branch) {
  return pw(REFINEMENT.mult, lvl(s.run.refinements, branch));
}

/** Research multiplier fx(key) if owned, else 1. */
function resMult(s, id, key) {
  return hasResearch(s, id) ? fx(RESEARCH, id, key, 1) : 1;
}

/** Edict fx(key) for the cycle's edict, else 1. */
function edictMult(s, key) {
  const e = s.cycle.edict;
  return typeof e === 'string' ? fx(EDICTS, e, key, 1) : 1;
}

/** Species mods (d.meta.sp), always an object. */
function speciesMods(d) {
  return (d && d.meta && d.meta.sp && typeof d.meta.sp === 'object') ? d.meta.sp : {};
}

/** Number of satellite entrances. */
function satellites(s) {
  const ents = s.run.surface.entrances;
  let n = 0;
  if (Array.isArray(ents)) for (const e of ents) if (e && e.kind === 'satellite') n++;
  return n;
}

/** Per-run "softcap already reported" sets, keyed by d. @type {WeakMap<object, { key: string, seen: Object<string, boolean> }>} */
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
  if (env && typeof env.emit === 'function') env.emit('softcapHit', { stat });
}

/**
 * Base egg food (no nanitic discount): E(N) × trophic_eggs × caste multiplier × species replete modifier.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} caste
 * @returns {number} food, or NaN for an unknown caste
 */
function eggFoodBase(s, d, caste) {
  if (!own(CASTES, caste) || !(CASTES[caste].eggMult > 0)) return NaN;
  const sp = speciesMods(d);
  const e = EGG.base * (1 + EGG.k * popN(s)) ** EGG.exp;
  let food = e * resMult(s, 'trophic_eggs', 'eggCost') * CASTES[caste].eggMult;
  if (caste === 'replete') food *= num(sp.repleteCost, 1);
  return food;
}

/**
 * Amount of one extra-cost component per the CASTES extra value forms, for the next egg of the caste.
 * @returns {number}
 */
function extraAmount(s, caste, form) {
  const col = s.run.colony;
  if (typeof form === 'number') return form;
  if (form && typeof form === 'object') {
    if (typeof form.perOwned === 'number') {
      const owned = caste === 'alate' ? col.alatesReared : num(col.adults[caste]);
      return num(form.base) + form.perOwned * owned;
    }
    if (typeof form.growth === 'number') return num(form.base) * form.growth ** num(col.eggs[caste]);
  }
  return 0;
}

/**
 * [q] Cost of the next egg of that caste: { food, …extras } (food includes the nanitic discount for minors).
 * null for an unknown caste or a cost above COST_MAX.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} caste
 * @returns {import('../core/types.js').Cost|null}
 */
export function eggCost(s, d, caste) {
  let food = eggFoodBase(s, d, caste);
  if (!Number.isFinite(food)) return null;
  if (caste === 'minor' && s.run.colony.naniticsLeft > 0) food *= EGG.naniticMult;
  const cost = { food };
  const extra = CASTES[caste].extra || {};
  for (const r of Object.keys(extra)) cost[r] = extraAmount(s, caste, extra[r]);
  for (const r of Object.keys(cost)) if (!(cost[r] >= 0) || !(cost[r] <= COST_MAX)) return null;
  return cost;
}

/**
 * [q] Combined relative reduction R = 1 − Π(1 − rᵢ) of the winter forage penalty (DESIGN §12.1).
 * Terms: Thermal Chimney, Mound, seasonal_clock, seasonal_wisdom, eternal_winter reward tier, honeypot species.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {number} 0..1
 */
export function winterR(s, d) {
  const agg = d && d.nest && d.nest.agg ? d.nest.agg : {};
  const terms = [];
  terms.push(Math.min(fx(CHAMBERS, 'thermal_chimney', 'max', 0), fx(CHAMBERS, 'thermal_chimney', 'winterForage', 0) * num(agg.chimneyL)));
  terms.push(Math.min(MOUND.winterMax, MOUND.winterForage * num(s.run.surface.mound)));
  if (hasResearch(s, 'seasonal_clock')) terms.push(fx(RESEARCH, 'seasonal_clock', 'winterR', 0));
  if (lvl(s.cycle.traits, 'seasonal_wisdom') > 0) terms.push(fx(TRAITS, 'seasonal_wisdom', 'winterR', 0));
  const tier = d && d.meta && d.meta.hardship ? num(d.meta.hardship.eternal_winter) : 0;
  if (tier > 0) terms.push(fx(HARDSHIPS, 'eternal_winter', 'winterR', 0) * tier);
  if (speciesMods(d).winterForageHalf) terms.push(WINTER_R.honeypotHalf);
  let keep = 1;
  for (const r of terms) keep *= 1 - clampNum(num(r), 0, 1);
  return clampNum(1 - keep, 0, 1);
}

/**
 * Upkeep in food/s before offline efficiency (DESIGN §5.7, ARCHITECTURE §8.1). Never multiplied by production multipliers.
 * @param {boolean} winter apply the winter reductions and the repletes' cover
 * @returns {number}
 */
function upkeepOf(s, d, winter) {
  const col = s.run.colony;
  let u = 0;
  for (const c of ADULT_CASTES) u += CASTES[c].upkeep * num(col.adults[c]);
  u += CASTES.alate.upkeep * num(col.alatesReared);
  if (winter) {
    const agg = d.nest.agg;
    u *= resMult(s, 'overwintering', 'winterUpkeep') * resMult(s, 'diapause_logic', 'winterUpkeep');
    u *= 1 - Math.min(fx(CHAMBERS, 'hibernaculum', 'upkeepMax', 0), fx(CHAMBERS, 'hibernaculum', 'upkeep', 0) * num(agg.hibL));
    if (hasAch(s, 'ach_survivor')) u *= UPKEEP.survivorAch;
    const rf = CASTES.replete.fx;
    u -= Math.min(rf.winterCover * num(col.adults.replete), rf.winterCoverMax * u);
  }
  return clampNum(u);
}

/**
 * [q] C198: lay-rate factor of one Royal Chamber level: ×LAY.perRC per level up to LAY.highFrom (L8, the full-size room),
 * ×LAY.perRCHigh per level above it. 1 at L1, 0 for L < 1. Also used by the Royal Chamber level preview.
 * @param {number} level
 * @returns {number}
 */
export function royalLayMult(level) {
  const L = Math.floor(num(level));
  if (L < 1) return 0;
  return clampNum(LAY.perRC ** (Math.min(L, LAY.highFrom) - 1) * LAY.perRCHigh ** Math.max(0, L - LAY.highFrom));
}

/**
 * [q] C198: queens' court factor for `queens` laying queens: 1 + LAY.courtPer × (queens − 1) (1 for 0 or 1 queen).
 * @param {number} queens
 * @returns {number}
 */
export function courtMult(queens) {
  return 1 + LAY.courtPer * Math.max(0, Math.floor(num(queens)) - 1);
}

/** C200: Archive multiplier of a research branch: 1 + ARCHIVE.per × level (era.archive). */
export function archiveMult(s, branch) {
  return 1 + ARCHIVE.per * lvl(s && s.era ? s.era.archive : null, branch);
}

/**
 * Lay rate (DESIGN §5.1, §12.4; C198): λ = Σ_queens (base + perRF·RF) × royalLayMult(RC) × court × M_lay (no colony
 * scale). Fills st.layRate and st.layParts — the tooltip breakdown, in order: one { label, add, value } per laying queen
 * (eggs/s of that queen before multipliers), then { label, mult, value } per multiplier that is not ×1.
 */
function layStack(s, d, st, pre, mods, A) {
  const run = s.run;
  const col = run.colony;
  const agg = d.nest.agg;
  const rf = run.hardship === 'claustral_founding' ? 0 : lvl(A, 'royal_feeding');
  const parts = [];
  const add = (label, value) => parts.push({ label, add: value, value });
  const mul = (label, value) => {
    if (value !== 1) parts.push({ label, mult: value, value });
    return value;
  };
  let lay = 0;
  let queens = 0;
  if (Array.isArray(agg.royal)) {
    for (const lv of agg.royal) {
      const L = num(lv);
      if (!(L > 0)) continue;
      const q = (LAY.base + LAY.perRF * rf) * royalLayMult(L);
      queens++;
      lay += q;
      add(queens === 1 ? 'Queen (Royal Chamber L' + L + ')' : 'Queen ' + queens + ' (Royal Chamber L' + L + ')', clampNum(q));
    }
  }
  let m = mul("Queens' court (" + queens + ' queens)', courtMult(queens));
  m *= mul('Royal Pheromones', resMult(s, 'royal_pheromones', 'lay'));
  m *= mul('Spermathecal Reserve', resMult(s, 'spermathecal_reserve', 'lay'));
  m *= mul("Queen's Feast", pw(fx(ADAPTATIONS, 'queens_feast', 'lay', 1), lvl(A, 'queens_feast')));
  m *= mul('Brood refinement', refine(s, 'brood'));
  m *= mul('Brood Archive', archiveMult(s, 'brood'));
  m *= mul('Prestige (Lineage, Fertile Queen, Genome)', num(pre.lay, 1));
  m *= mul('Season', num(mods.lay, 1));
  m *= mul('Events', effectMult(s, 'lay'));
  m *= mul('Achievements', achMult(s, 'lay'));
  if (col.hungry) m *= mul('Hungry', 0);
  st.layParts = parts;
  st.layRate = clampNum(lay * m);
}

/**
 * Fill d.stats (ARCHITECTURE §5) from state and the upstream derived subtrees (d.meta, d.season, d.nest.agg,
 * d.surface.ownedCount, d.rates). Emits softcapHit {stat: 'dig'} the first time dig work softcaps in a run.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function recompute(s, d, env) {
  const run = s.run;
  const col = run.colony;
  const st = d.stats;
  const agg = d.nest.agg;
  const season = d.season;
  const mods = season.mods || {};
  const meta = d.meta;
  const pre = meta.prestige || {};
  const sp = speciesMods(d);
  const A = run.adaptations;
  const T = s.cycle.traits;
  const G = s.meta.genome;
  const winter = season.id === 'winter';
  const cs = num(meta.colonyScale, 1);
  const minors = num(col.adults.minor);
  const repletes = num(col.adults.replete);
  const hungry = col.hungry ? HUNGRY.outputMult : 1;

  for (const k of ['forage', 'insight', 'scMult']) if (!st[k] || typeof st[k] !== 'object') st[k] = {};

  // ---- population caps (DESIGN §5.4, §5.6)
  st.colonyScale = cs;
  const houseMult = resMult(s, 'gallery_arches', 'housing') * resMult(s, 'compact_galleries', 'housing');
  st.housing = clampNum(num(agg.housingBase) * houseMult * cs);
  let slots = 0;
  if (Array.isArray(agg.broodGroups)) for (const g of agg.broodGroups) if (g) slots += Math.max(0, num(g.cap));
  st.broodSlots = clampNum(slots * cs);
  st.berths = clampNum(num(agg.berthsBase) * cs); // C136: Barracks berths, soldiers only
  st.warBerths = clampNum(num(agg.warBerthsBase) * cs); // C136: War Hall berths, supermajors only
  st.repleteBerths = clampNum(num(agg.repleteBerthsBase) * cs);
  st.alateCells = clampNum(num(agg.alateCells));
  st.gardenerSlots = clampNum(num(agg.gardenerSlots) * cs);

  // ---- caps (DESIGN §12.8, §12.9)
  const rfx = CASTES.replete.fx;
  const replFactor = 1 + rfx.capBonus * repletes * (agg.adjGranaryRepletion ? CAPS.repleteAdj : 1) * num(sp.repleteCap, 1);
  st.foodCap = clampNum((CAPS.royalFood + num(agg.granaryCap)) * replFactor * num(mods.foodCap, 1)
    * (hasAch(s, 'ach_hoarder') ? CAPS.hoarder : 1) * num(sp.foodCap, 1));
  st.honeydewCap = clampNum(CAPS.honeydewBase + CAPS.honeydewFrac * st.foodCap);
  st.leafCap = clampNum(num(agg.leafCap));
  st.fungusCap = clampNum(num(agg.fungusCap));
  st.pheromoneCap = clampNum(PHEROMONE.capBase + (hasResearch(s, 'pheromone_glands') ? fx(RESEARCH, 'pheromone_glands', 'cap', 0) : 0)
    + PHEROMONE.capPerMound * num(run.surface.mound));

  // ---- lay rate (DESIGN §5.1, §12.4; C198: colony scale no longer multiplies it)
  layStack(s, d, st, pre, mods, A);

  // ---- egg costs (DESIGN §5.2)
  if (!st.eggCost || typeof st.eggCost !== 'object') st.eggCost = {};
  if (!st.eggExtra || typeof st.eggExtra !== 'object') st.eggExtra = {};
  for (const c of CASTE_ORDER) {
    const cost = eggCost(s, d, c);
    st.eggCost[c] = cost ? clampNum(cost.food) : COST_MAX;
    const ex = {};
    if (cost) for (const r of Object.keys(cost)) if (r !== 'food') ex[r] = clampNum(cost[r]);
    st.eggExtra[c] = ex;
  }

  // ---- brood time terms (DESIGN §5.3)
  st.mbt = clampNum(resMult(s, 'brood_care', 'broodTime') * num(mods.broodTime, 1)
    * (col.fungalBrood && run.res.fungus > 0 ? BROOD.fungalTimeMult : 1) * effectMult(s, 'brood_time'));
  st.nurseTerm = 1 + Math.min(BROOD.maxNursePerSlot, safeDiv(num(col.jobs.nurse) + 1, st.broodSlots, BROOD.maxNursePerSlot));

  // ---- worker multiplier: nanitic_vigor × golden ants × sig_social_stomach
  let nanitic = 1;
  if (lvl(T, 'nanitic_vigor') > 0 && minors > 0) {
    const mult = fx(TRAITS, 'nanitic_vigor', 'mult', 1);
    const workers = fx(TRAITS, 'nanitic_vigor', 'workers', 0);
    nanitic = (minors + (mult - 1) * Math.min(workers, minors)) / Math.max(1, minors);
  }
  const golden = 1 + (fx(GENOME, 'golden_brood', 'mult', 1) - 1) * num(col.golden) / Math.max(1, minors);
  let social = 1;
  const sig = own(SIGNATURES, 'sig_social_stomach') ? SIGNATURES.sig_social_stomach.fx : null;
  if (sig && s.meta.signatureGenes.sig_social_stomach && num(sig.per) > 0) {
    social = 1 + Math.min(num(sig.max), num(sig.pct) * Math.floor(repletes / sig.per));
  }
  st.workerMult = clampNum(nanitic * golden * social);

  // ---- shared additive terms
  const middenOut = Math.min(fx(CHAMBERS, 'midden', 'outputMax', 0), fx(CHAMBERS, 'midden', 'output', 0) * num(agg.middenL));
  const satAdd = fx(FEDERATION, 'satellite_nest', 'foodDig', 0) * satellites(s);
  const phiCoef = typeof sp.phiCoef === 'number' && Number.isFinite(sp.phiCoef) ? sp.phiCoef
    : (hasResearch(s, 'fungal_symbiosis') ? fx(RESEARCH, 'fungal_symbiosis', 'phiCoef', NUTRITION.coef) : NUTRITION.coef);
  st.phiCoef = clampNum(phiCoef);
  st.nutrition = hasResearch(s, 'fungiculture') ? clampNum(1 + st.phiCoef * clampNum(num(col.phi), 0, 1)) : 1;
  const nutrition = st.nutrition;

  // ---- season forage incl. the winter R reduction (DESIGN §12.1)
  const R = winterR(s, d);
  const baseForage = num(mods.forage, 1);
  st.seasonForage = clampNum(winter ? 1 - (1 - baseForage) * (1 - R) : baseForage);
  const wm = SEASON_MODS && SEASON_MODS.winter ? SEASON_MODS.winter : null;
  const mildNext = s.meta.season.year === 0 && run.hardship !== 'eternal_winter';
  const nextBase = winter ? baseForage : num(wm && (mildNext ? wm.forageMild : wm.forage), baseForage);
  st.forageWinter = clampNum(1 - (1 - nextBase) * (1 - R));

  // ---- forage (DESIGN §12.1; trunk_trails ×1.5 is per trail, WP4)
  const ownedCount = d.surface ? num(d.surface.ownedCount) : 0;
  const f = st.forage;
  f.aAdd = clampNum(1 + fx(ADAPTATIONS, 'strong_mandibles', 'forageAdd', 0) * lvl(A, 'strong_mandibles')
    + Math.min(TERRITORY.yieldMax, TERRITORY.yieldPerHex * ownedCount) + middenOut + satAdd + effectAdd(s, 'forage_add'));
  f.mRun = clampNum(resMult(s, 'trail_memory', 'forage') * resMult(s, 'recruitment_pheromones', 'forage')
    * pw(fx(ADAPTATIONS, 'potent_trails', 'forage', 1), lvl(A, 'potent_trails')) * nutrition * refine(s, 'foraging')
    * archiveMult(s, 'foraging') * edictMult(s, 'forage'));
  f.mTime = clampNum(st.seasonForage * effectMult(s, 'forage') * effectMult(s, 'surface_work') * hungry);
  f.mPrestige = clampNum(num(pre.food, 1));
  f.total = clampNum(f.aAdd * f.mRun * f.mTime * f.mPrestige * st.workerMult);

  // ---- dig (DESIGN §12.3)
  const thermal = pw(fx(GENOME, 'thermal_ceiling', 'mult', 1), lvl(G, 'thermal_ceiling'));
  st.scMult.food = thermal;
  st.scMult.dig = thermal;
  const diggers = num(col.jobs.digger);
  const aDig = 1 + fx(ADAPTATIONS, 'digging_claws', 'digAdd', 0) * lvl(A, 'digging_claws') + middenOut + satAdd;
  const mRunDig = resMult(s, 'coordinated_digging', 'dig') * resMult(s, 'acid_excavation', 'dig') * refine(s, 'excavation')
    * archiveMult(s, 'excavation') * nutrition * edictMult(s, 'dig') * achMult(s, 'dig');
  const mTimeDig = num(mods.dig, 1) * hungry;
  const digRaw = diggers > 0 ? clampNum(diggers ** JOBS.digger.fx.exp * aDig * mRunDig * mTimeDig * num(pre.dig, 1) * st.workerMult) : 0;
  const dig = scChain(digRaw, SOFTCAPS.dig, st.scMult.dig);
  st.digRaw = digRaw;
  st.digW = clampNum(dig.value);
  if (dig.capped) softcapOnce(s, d, env, 'dig');
  st.soilMult = achMult(s, 'soil');

  // ---- other channels (DESIGN §12.7)
  st.honeydew = clampNum(pw(fx(CHAMBERS, 'root_aphid_pen', 'herders', 1), num(agg.rootPenCount))
    * resMult(s, 'sugar_economy', 'honeydew') * pw(fx(ADAPTATIONS, 'sweet_tooth', 'honeydew', 1), lvl(A, 'sweet_tooth'))
    * refine(s, 'husbandry') * archiveMult(s, 'husbandry') * nutrition * num(pre.honeydew, 1) * effectMult(s, 'honeydew') * effectMult(s, 'surface_work')
    * hungry * st.workerMult * achMult(s, 'honeydew'));
  st.leaves = clampNum(nutrition * num(pre.leaves, 1) * effectMult(s, 'surface_work') * hungry * st.workerMult);
  const wet = Array.isArray(run.landingTags) && run.landingTags.includes('site_wet_hollow') ? fx(SITES, 'site_wet_hollow', 'fungus', 1) : 1;
  st.fungus = clampNum(resMult(s, 'weeder_ants', 'fungus') * refine(s, 'husbandry') * archiveMult(s, 'husbandry') * achMult(s, 'fungus') * wet
    * num(pre.fungus, 1) * hungry);
  // C199: Carapace Workshops boost every chitin source (trails and Middens through st.chitin; moults and one-shot
  // rewards in wallet.grant); Carapace Stores raise the cap, which grows with colony scale like the other stores.
  st.chitinBoost = clampNum(1 + Math.max(0, num(agg.chitinBoost)));
  st.chitin = clampNum(num(pre.chitin, 1) * hungry * st.chitinBoost);
  st.chitinCap = clampNum((CHITIN.capBase + Math.max(0, num(agg.chitinCapBase))) * cs);

  // ---- insight (DESIGN §12.5; ventilation is already inside the chamber eff)
  const common = resMult(s, 'collective_memory', 'insight') * resMult(s, 'hive_mind', 'insight') * refine(s, 'communication')
    * archiveMult(s, 'communication')
    * num(mods.insight, 1) * effectMult(s, 'insight') * num(pre.insight, 1) * achMult(s, 'insight') * hungry;
  st.insight.library = clampNum(common * resMult(s, 'chemical_lexicon', 'library'));
  st.insight.scouting = clampNum(common * resMult(s, 'antennation', 'insightHex'));
  st.insight.oneShot = clampNum(num(pre.insight, 1));

  // ---- upkeep (DESIGN §5.7)
  st.upkeep = upkeepOf(s, d, winter);
  st.upkeepWinter = upkeepOf(s, d, true);

  // ---- combat multipliers (DESIGN §12.6; species soldierAtk and events are applied by WP5 combat)
  const warrior = pw(fx(TRAITS, 'warrior_lineage', 'mult', 1), lvl(T, 'warrior_lineage'));
  st.atk = clampNum(pw(fx(ADAPTATIONS, 'serrated_mandibles', 'atk', 1), lvl(A, 'serrated_mandibles')) * resMult(s, 'formic_acid', 'atk')
    * (1 + Math.min(fx(CHAMBERS, 'barracks', 'atkMax', 0), fx(CHAMBERS, 'barracks', 'atk', 0) * num(agg.barracksL)))
    * warrior * (lvl(G, 'venom_gland') > 0 ? fx(GENOME, 'venom_gland', 'atk', 1) : 1));
  st.hp = clampNum(pw(fx(ADAPTATIONS, 'thick_cuticle', 'hp', 1), lvl(A, 'thick_cuticle')) * warrior * achMult(s, 'hp'));
  st.ap = clampNum(resMult(s, 'war_chemistry', 'ap') * refine(s, 'warfare') * archiveMult(s, 'warfare') * edictMult(s, 'ap') * num(pre.ap, 1) * achMult(s, 'ap'));

  // ---- pheromone (DESIGN §12.9)
  st.pheromoneRegen = clampNum((PHEROMONE.regenBase + PHEROMONE.regenPerSqrtAdult * Math.sqrt(adultsTotal(s)))
    * (hasResearch(s, 'pheromone_glands') ? fx(RESEARCH, 'pheromone_glands', 'regen', 1) : 1));

  // ---- click value (DESIGN §10, §12.2): uses last tick's gross food/s
  const qd = lvl(A, 'quick_dispatch');
  const p = qd < CLICK.fromLevel ? 0 : Math.min(CLICK.pMax, CLICK.pBase + CLICK.pPer * (qd - CLICK.fromLevel));
  const gross = d.rates && d.rates.food ? num(d.rates.food.gross) : 0;
  st.clickValue = clampNum((1 + fx(ADAPTATIONS, 'quick_dispatch', 'click', 0) * qd) * (hasAch(s, 'ach_clickstorm') ? CLICK.clickstorm : 1)
    + p * gross);
}
