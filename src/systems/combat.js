// Combat: unit stats, Army Power (Lanchester square law), closed-form previews on a deterministic fortune grid,
// stepped 4 Hz battles (simultaneous damage, militia → soldiers → supermajors), battle end bookkeeping and rewards.
// Owner: WP5. Contract: ARCHITECTURE §8.4 (systems/combat.js); DESIGN §9.1, §9.5, §9.6, §9.8, §12.6.
//
// Model notes (pinned here so rivals.js / raids.js and the previews agree):
// - A battle's `foe` holds EFFECTIVE per-unit stats: every modifier that is relative between the two sides (rival AP
//   effects, swarm, home bonus, propaganda, and the equivalents of acid_volley / venom / phalanx escorts) is folded into
//   foe.atk / foe.hp when the battle starts. Under aimed-fire Lanchester attrition, "your AP × c" is exactly equivalent
//   to "foe ATK and HP × 1/c", and "your HP × c" to "foe ATK × 1/c", so previews and stepped fights stay consistent.
// - The player side is recomputed every step from unitStats (rally, phorid flies, gate) and armyAP's multipliers
//   (AP softcap, d.stats.ap, home bonus when the player defends), applied to both ATK and HP so AP scales exactly.
// - Fortune f multiplies a side's ATK and HP (so its AP scales by f).
// ARCH-R: Battle records carry three extra fields beyond ARCHITECTURE §4.1: `rival` (rival uid or 0), `esc` (escort
//   soldiers that entered a trail fight; losses hit them first) and `lost` ({ militia, soldier, supermajor } casualties so
//   far). They are needed for garrison accounting, auto-retreat with reinforcements, and end-of-battle bookkeeping.
// ARCH-R: battleEnd carries extra payload fields: hex, below, party, raid, rival, esc, survivors, foeLeft, retreat.
// ARCH-R: a battle in which neither side can deal damage stops after BATTLE.maxSec; the side with more remaining AP wins.
// C73 (Mobilize, DESIGN §9.8): a mobilized battle also carries `mob` = { n, forager } (minors drafted, of which from
//   foragers). releaseMobilized hands the surviving draft back when the 20 s window or the battle ends: the forager
//   share returns to jobs.forager (the rest were idle and are idle again); casualties come out of the draft.

import { BATTLE, ACTIONS, TACTICAL, ACH_FX } from '../data/combat.js';
import { TRAITS } from '../data/rivals.js';
import { RESEARCH } from '../data/research.js';
import { CASTES } from '../data/castes.js';
import { CHAMBERS } from '../data/chambers.js';
import { JOB_ORDER } from '../data/jobs.js';
import { SOFTCAPS } from '../data/balance.js';
import { scChain, clampNum } from '../core/math.js';
import { effectMult, removeEffect } from '../core/effects.js';
import { randRange } from '../core/rng.js';
import { grant, incomeSeconds } from '../core/wallet.js';
import * as population from './population.js';

/** Player unit groups, in the order enemy damage is applied (DESIGN §9.5). */
export const GROUPS = Object.freeze(['militia', 'soldier', 'supermajor']);
/** Battle kinds in which the rival (or a neutral) is the defender: the player gets no home bonus there. */
export const RIVAL_DEFENDS = new Set(['raid', 'assault', 'hunt', 'termite', 'escalate']);
/** Effect id prefix of a Mobilize window on a battle (effect id = prefix + battle uid). */
export const MOBILIZE_PREFIX = 'mobilize:';
/** Effect id of the global Alarm Rally cooldown. */
export const RALLY_CD_ID = 'alarm_rally:cd';

const hasOwn = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const num = (x, dflt = 0) => (Number.isFinite(x) ? x : dflt);
const owned = (s, id) => !!(s.run.research && s.run.research[id]);
const ach = (s, id) => !!(s.meta.achievements && s.meta.achievements[id] !== undefined && s.meta.achievements[id] !== null);

/**
 * Army in canonical form: { militia, soldier, supermajor }, every count finite and ≥ 0 (`minor` is read as militia).
 * @param {Object} a
 * @returns {import('../core/types.js').Army}
 */
export function normArmy(a) {
  const o = a && typeof a === 'object' ? a : {};
  return {
    militia: clampNum(num(o.militia, num(o.minor))),
    soldier: clampNum(num(o.soldier)),
    supermajor: clampNum(num(o.supermajor)),
  };
}

/** @returns {number} total units of an army */
export function armyCount(a) {
  return a.militia + a.soldier + a.supermajor;
}

/** Foe in canonical form { n, atk, hp } (finite, ≥ 0). */
function normFoe(f) {
  const o = f && typeof f === 'object' ? f : {};
  return { n: clampNum(num(o.n)), atk: clampNum(num(o.atk)), hp: clampNum(num(o.hp)) };
}

/** AP of a foe group: n × √(atk × hp). */
export function foeAP(foe) {
  if (!foe) return 0;
  return clampNum(num(foe.n) * Math.sqrt(clampNum(num(foe.atk)) * clampNum(num(foe.hp))));
}

/** Gate HP factor in the gate fight: 1 + gate.fx.hp × gateL (× ach_phragmosis on the gate term). */
function gateHpMult(s, d) {
  const gfx = (hasOwn(CHAMBERS, 'gate') && CHAMBERS.gate.fx) || {};
  const gateL = num(d && d.nest && d.nest.agg && d.nest.agg.gateL);
  const phr = ach(s, 'ach_phragmosis') ? ACH_FX.ach_phragmosis.gate : 1;
  return 1 + num(gfx.hp) * gateL * phr;
}

/**
 * Per-unit ATK / HP of a player caste ('militia' and 'minor' are minor workers).
 * Soldiers and supermajors use d.stats.atk / hp and effect 'atk_player' (phorid flies); soldiers also species soldierAtk.
 * ctx.rally: +30 % ATK; ctx.venom: HP × 0.8; ctx.gate: HP × (1 + 0.25 × gateL [× 1.05 ach_phragmosis]).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {string} caste
 * @param {{ rally?: boolean, venom?: boolean, gate?: boolean }} [ctx]
 * @returns {{ atk: number, hp: number }}
 */
export function unitStats(s, d, caste, ctx = {}) {
  const c = caste === 'militia' ? 'minor' : caste;
  const base = hasOwn(CASTES, c) ? CASTES[c] : null;
  if (!base) return { atk: 0, hp: 0 };
  const military = c === 'soldier' || c === 'supermajor';
  const st = (d && d.stats) || {};
  const sp = (d && d.meta && d.meta.sp) || {};
  const cx = ctx || {};
  let atk = num(base.atk);
  let hp = num(base.hp);
  if (military) {
    atk *= num(st.atk, 1) * effectMult(s, 'atk_player');
    hp *= num(st.hp, 1);
  }
  if (c === 'soldier') atk *= num(sp.soldierAtk, 1);
  if (cx.rally) atk *= TACTICAL.alarm_rally.atk;
  if (cx.venom) hp *= TRAITS.venom.yourHP;
  if (cx.gate) hp *= gateHpMult(s, d);
  return { atk: clampNum(atk), hp: clampNum(hp) };
}

/** Raw (pre-softcap, pre-multiplier) AP: Σ n × √(atk × hp). */
function rawAP(s, d, army, ctx) {
  let raw = 0;
  for (const g of GROUPS) {
    const n = army[g];
    if (!(n > 0)) continue;
    const u = unitStats(s, d, g, ctx);
    raw += n * Math.sqrt(u.atk * u.hp);
  }
  return raw;
}

/** AP multiplier applied after the raw sum: d.stats.ap × homeMult × apMult. */
function apMultiplier(d, ctx) {
  const st = (d && d.stats) || {};
  return num(st.ap, 1) * num(ctx && ctx.homeMult, 1) * num(ctx && ctx.apMult, 1);
}

/**
 * Army Power of a player army { militia, soldier, supermajor }:
 * scChain(Σ n × √(atk × hp), SOFTCAPS.ap) × d.stats.ap × (ctx.homeMult ?? 1) × (ctx.apMult ?? 1).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {Object} army
 * @param {{ homeMult?: number, apMult?: number, rally?: boolean, venom?: boolean, gate?: boolean }} [ctx]
 * @returns {number}
 */
export function armyAP(s, d, army, ctx = {}) {
  const a = normArmy(army);
  const raw = rawAP(s, d, a, ctx || {});
  return clampNum(scChain(raw, SOFTCAPS.ap).value * apMultiplier(d, ctx || {}));
}

/** Default home bonus of a rival nest (assault): ACTIONS.assault.home, or TRAITS.home_fortress.home. */
export function baseHome(rival) {
  return rival && Array.isArray(rival.traits) && rival.traits.includes('home_fortress') ? TRAITS.home_fortress.home : ACTIONS.assault.home;
}

/**
 * AP of a rival force: n × √(atk × hp) × effectMult('ap_rival') × effectMult('ap_rival', uid) × swarm × home.
 * ctx: engage (share of rival.n engaged, default 1) or n (explicit count); yourCount (swarm applies when the committed
 * count exceeds it); defending (apply the home bonus); home (override of the bonus value).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Rival} rival
 * @param {{ engage?: number, n?: number, yourCount?: number, defending?: boolean, home?: number }} [ctx]
 * @returns {number}
 */
export function rivalAP(s, d, rival, ctx = {}) {
  if (!rival || typeof rival !== 'object') return 0;
  const cx = ctx || {};
  const n = Number.isFinite(cx.n) ? Math.max(0, cx.n) : num(rival.n) * num(cx.engage, 1);
  let ap = n * Math.sqrt(clampNum(num(rival.atk)) * clampNum(num(rival.hp)));
  ap *= effectMult(s, 'ap_rival') * effectMult(s, 'ap_rival', rival.uid);
  if (Array.isArray(rival.traits) && rival.traits.includes('swarm') && Number.isFinite(cx.yourCount) && n > cx.yourCount) {
    ap *= TRAITS.swarm.apMult;
  }
  if (cx.defending) ap *= num(cx.home, baseHome(rival));
  return clampNum(ap);
}

/** Survivor fraction of the winner in the closed form: √(1 − (apLose / apWin)²). */
export function survivorFraction(apWin, apLose) {
  if (!(apWin > 0)) return 0;
  const r = clampNum(apLose) / apWin;
  return r >= 1 ? 0 : Math.sqrt(1 - r * r);
}

/** Retreat cost as a share of survivors (TACTICAL.retreat.loss, or phalanx retreatLoss). */
export function retreatLoss(s) {
  return owned(s, 'phalanx') ? RESEARCH.phalanx.fx.retreatLoss : TACTICAL.retreat.loss;
}

/**
 * Loot amounts of a RewardSpec at current income rates: { food, chitin, insight, minors }.
 * foodSec/foodMin: max(foodMin, foodSec × gross food/s); likewise chitinSec/chitinMin; flat food/chitin add on top.
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').RewardSpec|null} reward
 */
export function lootFor(d, reward) {
  const r = reward && typeof reward === 'object' ? reward : {};
  const food = clampNum(num(r.food) + (num(r.foodSec) > 0 || num(r.foodMin) > 0 ? incomeSeconds(d, 'food', num(r.foodSec), num(r.foodMin)) : 0));
  const chitin = clampNum(num(r.chitin) + (num(r.chitinSec) > 0 || num(r.chitinMin) > 0
    ? incomeSeconds(d, 'chitin', num(r.chitinSec), num(r.chitinMin)) : 0));
  return { food, chitin, insight: clampNum(num(r.insight)), minors: clampNum(num(r.minors)) };
}

/**
 * Closed-form preview (DESIGN §9.5): the side with higher f × AP wins; the winner keeps s = √(1 − (AP_l/AP_w)²) of
 * every group; the engaged loser is destroyed. Win chance and loss percentiles over a deterministic 64 × 64 fortune grid.
 * Never touches s.rng. opts: homeMult / apMult / rally / gate / venom (player side, as armyAP), foeMult (× foe AP),
 * retreatAt (auto-retreat threshold; 1 = never), reward (RewardSpec for the loot estimate if won).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {Object} you army { militia, soldier, supermajor }
 * @param {import('../core/types.js').Foe} foe effective foe stats
 * @param {Object} [opts]
 * @returns {{ win: number, lossesLo: number, lossesHi: number, survivors: import('../core/types.js').Army,
 *   loot: { food: number, chitin: number, insight: number, minors: number } }}
 */
export function preview(s, d, you, foe, opts = {}) {
  const o = opts || {};
  const army = normArmy(you);
  const A = armyAP(s, d, army, { homeMult: o.homeMult, apMult: o.apMult, rally: !!o.rally, gate: !!o.gate, venom: !!o.venom });
  const F = foeAP(normFoe(foe)) * num(o.foeMult, 1);
  const retreatAt = Number.isFinite(o.retreatAt) ? Math.min(1, Math.max(0, o.retreatAt)) : 1;
  const retreatFrac = Math.min(1, retreatAt + (1 - retreatAt) * retreatLoss(s));
  const G = BATTLE.previewGrid;
  const [lo, hi] = BATTLE.fortune;
  const fr = new Float64Array(G);
  for (let i = 0; i < G; i++) fr[i] = lo + ((hi - lo) * (i + 0.5)) / G;
  const lossFrac = new Float64Array(G * G);
  let wins = 0;
  let sum = 0;
  for (let i = 0; i < G; i++) {
    const a = fr[i] * A;
    for (let j = 0; j < G; j++) {
      const b = fr[j] * F;
      let lf;
      if (a > b) {
        lf = 1 - survivorFraction(a, b);
        if (retreatAt < 1 && lf > 0 && lf >= retreatAt) lf = retreatFrac;
        else wins++;
      } else {
        lf = retreatAt < 1 ? retreatFrac : 1;
      }
      lossFrac[i * G + j] = lf;
      sum += lf;
    }
  }
  const total = armyCount(army);
  const meanLoss = sum / (G * G);
  lossFrac.sort();
  const pIdx = (p) => Math.min(G * G - 1, Math.max(0, Math.floor(p * (G * G - 1))));
  const [pLo, pHi] = BATTLE.lossPct;
  const keep = 1 - meanLoss;
  return {
    win: wins / (G * G),
    lossesLo: clampNum(lossFrac[pIdx(pLo)] * total),
    lossesHi: clampNum(lossFrac[pIdx(pHi)] * total),
    survivors: { militia: clampNum(army.militia * keep), soldier: clampNum(army.soldier * keep), supermajor: clampNum(army.supermajor * keep) },
    loot: lootFor(d, o.reward),
  };
}

/**
 * Recompute run.colony.militia = minors committed to battles and tournaments (alive + fallen-but-not-yet-removed).
 * @param {import('../core/types.js').State} s
 * @returns {number}
 */
export function recomputeMilitia(s) {
  let m = 0;
  for (const b of s.run.war.battles) m += num(b.you && b.you.militia) + num(b.lost && b.lost.militia);
  s.run.colony.militia = clampNum(m);
  return s.run.colony.militia;
}

/**
 * C73: end a battle's Mobilize draft. The surviving militia leave the fight; the share of them drafted from foragers
 * (mob.forager × survivors / mob.n) goes back to jobs.forager, limited to the minors that are now idle (auto jobs may
 * already have re-assigned them); the rest were idle and simply are again. Clears b.you.militia and b.mob; recounts the
 * militia. The dead stay in b.lost.militia until endBattle removes them.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Battle} b
 * @returns {number} foragers returned
 */
export function releaseMobilized(s, b) {
  if (!b || !b.you) return 0;
  const surv = clampNum(num(b.you.militia));
  const mob = b.mob && typeof b.mob === 'object' ? b.mob : null;
  b.you.militia = 0;
  if (mob) b.mob = null;
  recomputeMilitia(s);
  if (!mob || !(num(mob.n) > 0) || !(num(mob.forager) > 0) || !(surv > 0)) return 0;
  const col = s.run.colony;
  let jobs = 0;
  for (const j of JOB_ORDER) jobs += num(col.jobs[j]);
  const idle = Math.max(0, num(col.adults.minor) - jobs - num(col.militia));
  const back = Math.min(idle, num(mob.forager) * Math.min(1, surv / num(mob.n)));
  if (back > 0) col.jobs.forager = clampNum(num(col.jobs.forager) + back);
  return back;
}

/**
 * Start a battle. Rolls both fortunes from s.rng after computing `odds` (closed-form win chance before fortunes).
 * spec = BattleSpec { kind, hex, below = false, you, foe, homeMult = 1, party = 0, raid = 0, reward = null, tag = '' }
 * plus the WP5 extensions { rival = 0, esc = 0 }. `foe` must carry effective stats (see the header).
 * homeMult applies to the player side unless the kind is one where the rival defends (RIVAL_DEFENDS: display only).
 * Emits battleStart { uid, kind, hex, below }.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').BattleSpec} spec
 * @param {import('../core/types.js').Env|null} env
 * @returns {number} battle uid
 */
export function startBattle(s, d, spec, env) {
  const sp = spec && typeof spec === 'object' ? spec : {};
  const war = s.run.war;
  const kind = typeof sp.kind === 'string' && sp.kind ? sp.kind : 'army';
  const you = normArmy(sp.you);
  const foe = normFoe(sp.foe);
  const below = sp.below === true;
  const homeMult = Number.isFinite(sp.homeMult) && sp.homeMult > 0 ? sp.homeMult : 1;
  const hex = Number.isInteger(sp.hex) && sp.hex >= -1 ? sp.hex : -1;
  const rs = s.meta.settings.retreatAt;
  const retreatAt = Number.isFinite(rs) ? Math.min(1, Math.max(0, rs)) : 1;
  const odds = preview(s, d, you, foe, { homeMult: RIVAL_DEFENDS.has(kind) ? 1 : homeMult, gate: below, retreatAt }).win;
  const [lo, hi] = BATTLE.fortune;
  const f = { you: randRange(s, lo, hi), foe: randRange(s, lo, hi) };
  const uid = war.nextUid++;
  const b = {
    uid, kind, hex, below,
    party: Number.isInteger(sp.party) && sp.party > 0 ? sp.party : 0,
    raid: Number.isInteger(sp.raid) && sp.raid > 0 ? sp.raid : 0,
    you, foe,
    start: { you: armyCount(you), foe: foe.n },
    f, homeMult, acc: 0, t: 0, rally: 0, retreatAt,
    reward: sp.reward && typeof sp.reward === 'object' ? { ...sp.reward } : null,
    tag: typeof sp.tag === 'string' ? sp.tag : '',
    odds,
    rival: Number.isInteger(sp.rival) && sp.rival > 0 ? sp.rival : 0,
    esc: clampNum(num(sp.esc)),
    lost: { militia: 0, soldier: 0, supermajor: 0 },
  };
  war.battles.push(b);
  recomputeMilitia(s);
  if (env && typeof env.emit === 'function') env.emit('battleStart', { uid, kind, hex, below });
  return uid;
}

/**
 * Effective per-unit stats of the player side of a battle this step (unitStats × AP multipliers × fortune).
 * @returns {{ atk: Object<string, number>, hp: Object<string, number> }}
 */
function playerSide(s, d, b) {
  const ctx = { rally: b.rally > 0, gate: b.below };
  const homeMult = RIVAL_DEFENDS.has(b.kind) ? 1 : num(b.homeMult, 1);
  const atk = {};
  const hp = {};
  let raw = 0;
  for (const g of GROUPS) {
    const u = unitStats(s, d, g, ctx);
    atk[g] = u.atk;
    hp[g] = u.hp;
    if (b.you[g] > 0) raw += b.you[g] * Math.sqrt(u.atk * u.hp);
  }
  const eff = scChain(raw, SOFTCAPS.ap).value * apMultiplier(d, { homeMult });
  const m = (raw > 0 ? eff / raw : 1) * num(b.f && b.f.you, 1);
  for (const g of GROUPS) {
    atk[g] *= m;
    hp[g] *= m;
  }
  return { atk, hp };
}

/**
 * One simultaneous combat exchange (pure; mutates its arguments). Damage = Σ n × atk × coef, computed from counts at
 * the start of the exchange; the foe loses dmg / hp units; player damage is applied to groups in GROUPS order.
 * @param {import('../core/types.js').Army} you current counts (mutated)
 * @param {{ atk: Object<string, number>, hp: Object<string, number> }} side effective player stats per group
 * @param {{ n: number }} foe current foe count holder (mutated: n)
 * @param {number} foeAtk effective foe ATK per unit
 * @param {number} foeHp effective foe HP per unit
 * @param {import('../core/types.js').Army} lost casualty tally (mutated)
 * @param {number} [coef] damage coefficient per exchange (BATTLE.dmgCoef × BATTLE.step)
 * @returns {void}
 */
export function fightStep(you, side, foe, foeAtk, foeHp, lost, coef = BATTLE.dmgCoef * BATTLE.step) {
  let dmgYou = 0;
  for (const g of GROUPS) if (you[g] > 0) dmgYou += you[g] * side.atk[g];
  dmgYou *= coef;
  let rem = foe.n * foeAtk * coef;
  if (dmgYou > 0) foe.n = foeHp > 0 ? clampNum(foe.n - dmgYou / foeHp) : 0;
  for (const g of GROUPS) {
    if (!(rem > 0)) break;
    const n = you[g];
    if (!(n > 0)) continue;
    const h = side.hp[g];
    const kill = h > 0 ? Math.min(n, rem / h) : n;
    you[g] = clampNum(n - kill);
    lost[g] += kill;
    rem -= kill * (h > 0 ? h : 0);
  }
  const eps = BATTLE.endEps;
  for (const g of GROUPS) {
    if (you[g] > 0 && you[g] <= eps) {
      lost[g] += you[g];
      you[g] = 0;
    }
  }
  if (foe.n <= eps) foe.n = 0;
}

/** One 0.25 s exchange of a stored battle; returns 'win' | 'lose' | 'retreat' | null. */
function battleStep(s, d, b) {
  const side = playerSide(s, d, b);
  const ff = num(b.f && b.f.foe, 1);
  fightStep(b.you, side, b.foe, b.foe.atk * ff, b.foe.hp * ff, b.lost);
  const youN = armyCount(b.you);
  if (b.foe.n <= 0 && youN > 0) return 'win';
  if (youN <= 0) return 'lose';
  const lostN = b.lost.militia + b.lost.soldier + b.lost.supermajor;
  if (lostN > 0 && lostN / (youN + lostN) >= b.retreatAt) return 'retreat';
  return null;
}

/** Remaining effective AP of both sides (maxSec tiebreak). */
function remainingAP(s, d, b) {
  const side = playerSide(s, d, b);
  let you = 0;
  for (const g of GROUPS) if (b.you[g] > 0) you += b.you[g] * Math.sqrt(side.atk[g] * side.hp[g]);
  const ff = num(b.f && b.f.foe, 1);
  return { you, foe: b.foe.n * ff * Math.sqrt(b.foe.atk * b.foe.hp) };
}

/**
 * Advance every running battle (tournaments excluded) by dt on a 4 Hz accumulator; finished battles go through
 * endBattle. Frozen offline. Also releases Mobilize militia whose window ended this tick.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {Object[]} battleEnd payloads of the battles that ended
 */
export function stepBattles(s, d, dt, env) {
  const ended = [];
  if (!(dt > 0) || (env && env.offline)) return ended;
  const list = s.run.war.battles;
  if (env && Array.isArray(env.events)) {
    for (const e of env.events) {
      if (e.type !== 'effectEnded' || typeof e.id !== 'string' || !e.id.startsWith(MOBILIZE_PREFIX)) continue;
      const uid = Number(e.id.slice(MOBILIZE_PREFIX.length));
      const b = list.find((x) => x.uid === uid);
      if (b) releaseMobilized(s, b);
    }
  }
  const step = BATTLE.step;
  let i = 0;
  while (i < list.length) {
    const b = list[i];
    if (b.kind === 'tournament') {
      i++;
      continue;
    }
    b.t += dt;
    b.rally = clampNum(b.rally - dt);
    b.acc += dt;
    let outcome = null;
    if (armyCount(b.you) <= 0) outcome = 'lose';
    while (!outcome && b.acc >= step - 1e-9) {
      b.acc -= step;
      outcome = battleStep(s, d, b);
    }
    b.acc = clampNum(b.acc);
    if (!outcome && b.t >= BATTLE.maxSec) {
      const r = remainingAP(s, d, b);
      outcome = r.you > r.foe ? 'win' : 'lose';
    }
    if (outcome) {
      ended.push(endBattle(s, d, b, env, outcome));
      continue;
    }
    i++;
  }
  return ended;
}

/**
 * Finish a battle: optional retreat cost, removal, militia recount, casualties (population.killAdults, cause 'battle'),
 * field triage, counters, reward on a win, battleEnd. Exported for the retreat command and raid bookkeeping.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Battle} b
 * @param {import('../core/types.js').Env|null} env
 * @param {'win'|'lose'|'retreat'} outcome
 * @returns {Object} the battleEnd payload
 */
export function endBattle(s, d, b, env, outcome) {
  const war = s.run.war;
  const idx = war.battles.indexOf(b);
  if (idx >= 0) war.battles.splice(idx, 1);
  removeEffect(s, MOBILIZE_PREFIX + b.uid);
  if (outcome === 'retreat') {
    const cost = retreatLoss(s);
    for (const g of GROUPS) {
      const c = b.you[g] * cost;
      b.you[g] = clampNum(b.you[g] - c);
      b.lost[g] += c;
    }
  }
  const win = outcome === 'win';
  const kills = clampNum(b.start.foe - b.foe.n);
  // C73: survivors of a Mobilize draft go back (foragers to foraging) before the casualties are removed, so the dead
  // come out of the draft (killAdults takes idle minors first), never out of other jobs.
  const mobSurv = clampNum(num(b.you.militia));
  if (b.mob) releaseMobilized(s, b);
  recomputeMilitia(s);
  const emit = env && typeof env.emit === 'function' ? (t, p) => env.emit(t, p) : () => {};
  const killed = { soldier: 0, supermajor: 0, militia: 0 };
  if (b.lost.soldier > 0) killed.soldier = population.killAdults(s, d, 'soldier', b.lost.soldier, 'battle') || 0;
  if (b.lost.supermajor > 0) killed.supermajor = population.killAdults(s, d, 'supermajor', b.lost.supermajor, 'battle') || 0;
  if (b.lost.militia > 0) killed.militia = population.killAdults(s, d, 'minor', b.lost.militia, 'battle') || 0;
  if (killed.soldier > 0) emit('adultsDied', { caste: 'soldier', n: killed.soldier, cause: 'battle' });
  if (killed.supermajor > 0) emit('adultsDied', { caste: 'supermajor', n: killed.supermajor, cause: 'battle' });
  if (killed.militia > 0) emit('adultsDied', { caste: 'minor', n: killed.militia, cause: 'battle' });
  if (owned(s, 'field_triage')) {
    const fx = RESEARCH.field_triage.fx;
    if (num(s.run.colony.jobs.nurse) >= fx.nurses) {
      const so = killed.soldier * fx.frac;
      const su = killed.supermajor * fx.frac;
      if (so > 0 || su > 0) war.triage.push({ t: fx.sec, soldier: so, supermajor: su });
    }
  }
  const entered = mobSurv + b.you.soldier + b.you.supermajor + b.lost.militia + b.lost.soldier + b.lost.supermajor;
  const rs = s.run.stats;
  rs.battles++;
  if (win) {
    rs.battlesWon++;
    s.meta.counters.battlesWon++;
  }
  rs.kills = clampNum(rs.kills + kills);
  s.meta.stats.largestBattle = Math.max(s.meta.stats.largestBattle, clampNum(entered + b.start.foe));
  // C207: what was granted rides on battleEnd as `loot` (the toast and the event log name it)
  const loot = win && b.reward ? grantReward(s, d, b.reward, env) : null;
  const payload = {
    uid: b.uid, kind: b.kind, tag: b.tag, win,
    lost: { soldier: b.lost.soldier, supermajor: b.lost.supermajor, militia: b.lost.militia },
    kills, odds: b.odds, start: { you: b.start.you, foe: b.start.foe },
    hex: b.hex, below: b.below, party: b.party, raid: b.raid, rival: b.rival, esc: b.esc,
    survivors: { militia: mobSurv, soldier: b.you.soldier, supermajor: b.you.supermajor },
    foeLeft: b.foe.n, retreat: outcome === 'retreat', loot,
  };
  emit('battleEnd', payload);
  return payload;
}

/**
 * Grant a RewardSpec: food (one-shot, may overflow to 2 × cap), chitin, insight via wallet.grant; minors via
 * population.addAdults(…, { capped: true }) (overflow is lost).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').RewardSpec} reward
 * @param {import('../core/types.js').Env|null} env
 * @returns {{ food: number, chitin: number, insight: number, minors: number }} amounts actually added
 */
export function grantReward(s, d, reward, env) {
  const l = lootFor(d, reward);
  const out = { food: 0, chitin: 0, insight: 0, minors: 0 };
  if (l.food > 0) out.food = grant(s, d, 'food', l.food, { overflow: true });
  if (l.chitin > 0) out.chitin = grant(s, d, 'chitin', l.chitin);
  if (l.insight > 0) out.insight = grant(s, d, 'insight', l.insight);
  if (l.minors > 0) out.minors = population.addAdults(s, d, 'minor', l.minors, { capped: true }) || 0;
  return out;
}
