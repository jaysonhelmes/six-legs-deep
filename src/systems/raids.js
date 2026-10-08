// Rival raids on the player across both views: eligibility and timing, target choice (trail or nest), warning,
// guard dispatch, trail fights, the border → gate fight sequence, theft and brood loss. Owner: WP5.
// Contract: ARCHITECTURE §8.4 (systems/raids.js), §9 (dispatchGuard), §10 (raidWarning, raidResult), §18 C17;
// DESIGN §9.10, §8.6 (safe trails, border ×2), §21.4 (no raids offline).
//
// ARCH-R: a rival has at most one raid in progress; its raidIn only counts down while it is eligible and has none.
// ARCH-R: the trail target is the qualifying trail with the highest workers × (borderMult if it crosses a border hex),
//   i.e. "the trail with the most workers" with border trails weighted ×2 (deterministic; ties → earliest trail).
// ARCH-R: a trail raid whose target trail was deleted or became safe during the warning fizzles (raiders go home).
// ARCH-R: "30 s of that trail's income" is taken in the trail's primary resource (food for forager trails), capped at
//   the stored amount; raidResult.foodLost reports food only.
// ARCH-R: a nest fight with no garrison skips to the next stage; with no defenders at the gate the theft happens at once.
// ARCH-R: dispatchGuard is for trail raids only ('invalid:nest'): the whole garrison defends a nest raid automatically.
// ARCH-R: raidResult carries extra fields `target` and `rival`.
// C90: a raid whose rival fell during the warning is called off (win, nothing lost); one already fighting finishes,
//   and never reads fields a C77 compact record lacks (traits).

import { RAIDS, REWARDS } from '../data/combat.js';
import { TRAITS } from '../data/rivals.js';
import { RESEARCH } from '../data/research.js';
import { CHAMBERS } from '../data/chambers.js';
import { HEX } from '../data/balance.js';
import { hexDist } from '../core/hex.js';
import { chance, expSample } from '../core/rng.js';
import { spend } from '../core/wallet.js';
import { effectsFor } from '../core/effects.js';
import { adultsTotal } from '../core/state.js';
import { clampNum } from '../core/math.js';
import * as combat from './combat.js';
import * as rivals from './rivals.js';
import * as trails from './trails.js';
import * as population from './population.js';

const num = (x, dflt = 0) => (Number.isFinite(x) ? x : dflt);
const hasOwn = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const owned = (s, id) => !!(s.run.research && s.run.research[id]);
const FIGHT_PHASES = Object.freeze(['trail', 'border', 'gate']);
/** Primary resource of a trail job (raid income loss). */
const JOB_RES = Object.freeze({ forager: 'food', herder: 'honeydew', leafcutter: 'leaves' });

/** Rival by uid (alive or fallen), or null. */
function rivalByUid(s, uid) {
  for (const r of s.run.rivals.list) if (r.uid === uid) return r;
  return null;
}

/** Trail by uid, or null. */
function trailByUid(s, uid) {
  for (const t of s.run.surface.trails) if (t && t.uid === uid) return t;
  return null;
}

/** d.surface.trails entry of a trail (by uid), or null. */
function trailInfo(d, t) {
  const list = d && d.surface && Array.isArray(d.surface.trails) ? d.surface.trails : [];
  for (const x of list) if (x && x.uid === t.uid) return x;
  return null;
}

/** Effective workers on a trail (WP4 allocation, else the explicit count). */
function trailWorkers(d, t) {
  const info = trailInfo(d, t);
  return num(info ? info.workers : t.workers);
}

/** True if the trail lies entirely inside owned land (cannot be raided, DESIGN §8.6). */
export function isSafe(s, d, t) {
  const info = trailInfo(d, t);
  if (info && typeof info.safe === 'boolean') return info.safe;
  const own = d && d.surface && d.surface.owned;
  if (!own || !Array.isArray(t.path) || t.path.length === 0) return false;
  return t.path.every((h) => own[h] > 0);
}

/** The trail hex where raiders strike: the path hex nearest the rival nest (earliest on ties). */
function fightHex(t, r) {
  if (!t || !Array.isArray(t.path) || t.path.length === 0) return 0;
  if (!r) return t.path[t.path.length - 1];
  let best = t.path[0];
  let bestD = Infinity;
  for (const h of t.path) {
    const dd = hexDist(h, r.hex);
    if (dd < bestD) {
      bestD = dd;
      best = h;
    }
  }
  return best;
}

/**
 * Share of stored food stolen by a successful nest raid (DESIGN §9.10):
 * max(gate.theftFloor, (share > 0 ? theft × share : theftFallback) × (1 − gate.theft × gateL)).
 * @param {number} share agg.reachStorageShare
 * @param {number} gateL agg.gateL
 * @returns {number}
 */
export function theftFraction(share, gateL) {
  const gfx = (hasOwn(CHAMBERS, 'gate') && CHAMBERS.gate.fx) || {};
  const base = num(share) > 0 ? RAIDS.theft * num(share) : RAIDS.theftFallback;
  return Math.min(1, Math.max(num(gfx.theftFloor), base * (1 - num(gfx.theft) * num(gateL))));
}

/**
 * Warning seconds: min(warnMax, warnBase + warnPerScout × scouts) + early_warning fx.warnSec.
 * @param {import('../core/types.js').State} s
 * @returns {number}
 */
export function warningSec(s) {
  const scouts = clampNum(num(s.run.colony.jobs.scout));
  let w = Math.min(RAIDS.warnMax, RAIDS.warnBase + RAIDS.warnPerScout * scouts);
  if (owned(s, 'early_warning')) w += RESEARCH.early_warning.fx.warnSec;
  return w;
}

/**
 * Global raid eligibility: ≥ minAdults adults, not winter, online, no 'no_raids' effect (rival checks are separate).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Env} env
 * @returns {boolean}
 */
export function raidsPossible(s, d, env) {
  if (env && env.offline) return false;
  if (adultsTotal(s) < RAIDS.minAdults) return false;
  const se = d && d.season;
  if (se && (se.id === 'winter' || (se.mods && se.mods.rivalDormant))) return false;
  return effectsFor(s, 'no_raids').length === 0;
}

/**
 * True if this rival may raid now (alive, no truce, nest seen or run time ≥ minRunSec).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Rival} r
 * @returns {boolean}
 */
export function rivalEligible(s, r) {
  return !!r && r.alive && !(num(r.truce) > 0) && (r.sighted || num(s.run.time) >= RAIDS.minRunSec);
}

/**
 * Mean seconds between raids of a rival now: raidMin × 60 / seasonFactor / aggression / species raidMult
 * (aggression = 1 − pacifistAggro × pacifist reward tier). Infinity when it cannot raid (winter).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').Rival} r
 * @returns {number}
 */
export function raidMean(s, d, r) {
  const id = d && d.season ? d.season.id : 'spring';
  const season = hasOwn(RAIDS.seasonFactor, id) ? RAIDS.seasonFactor[id] : 1;
  const tier = num(d && d.meta && d.meta.hardship && d.meta.hardship.pacifist);
  const aggression = 1 - RAIDS.pacifistAggro * tier;
  const mult = num(d && d.meta && d.meta.sp && d.meta.sp.raidMult, 1);
  const div = season * aggression * mult;
  if (!(div > 0)) return Infinity;
  return (rivals.raidMinOf(r) * 60) / div;
}

/** Qualifying trail target (not safe, has workers, passes within trailRadius of the rival's land), or null. */
function pickTrail(s, d, r) {
  const near = rivals.nearMask(s, r, RAIDS.trailRadius);
  const border = d && d.surface && d.surface.border && d.surface.border.length === HEX.count ? d.surface.border : null;
  let best = null;
  let bestScore = 0;
  for (const t of s.run.surface.trails) {
    if (!t || !Array.isArray(t.path) || t.path.length === 0) continue;
    if (isSafe(s, d, t)) continue;
    const w = trailWorkers(d, t);
    if (!(w > 0)) continue;
    if (!t.path.some((h) => near[h])) continue;
    const score = w * (border && t.path.some((h) => border[h]) ? RAIDS.borderMult : 1);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/** Send the whole garrison to a trail raid's fight hex (instant with a Barracks near an entrance). */
function dispatch(s, d, raid) {
  const g = rivals.garrison(s, d);
  if (!(g.soldier + g.supermajor > 0)) return;
  const t = trailByUid(s, raid.target.uid);
  const to = fightHex(t, rivalByUid(s, raid.rival));
  const path = rivals.marchPath(s, d, rivals.guardOrigin(s, to), to);
  const p = rivals.makeParty(s, 'guard', { type: 'raid', uid: raid.uid }, g.soldier, g.supermajor, path);
  if (d && d.nest && d.nest.agg && d.nest.agg.barracksNear) p.pos = Math.max(0, path.length - 1);
  raid.guard = clampNum(g.soldier + g.supermajor);
}

/**
 * Close a raid: raiders return to their rival, waiting guards go home, raidResult. C227: raidResult always carries
 * `loot` { food, chitin } — what the defence brought home (the chitin of the raiders your defenders killed), 0 when
 * nothing was won.
 */
function finish(s, raid, env, { win, foodLost = 0, broodLost = 0, workersLost = 0, loot = null }) {
  raid.phase = 'done';
  const r = rivalByUid(s, raid.rival);
  if (r && r.alive) r.n = clampNum(r.n + raid.raiders);
  for (const p of s.run.war.parties) if (p.kind === 'guard' && p.target.uid === raid.uid && p.state === 'out') p.state = 'home';
  const l = { food: num(loot && loot.food), chitin: num(loot && loot.chitin) };
  env.emit('raidResult', { uid: raid.uid, win, foodLost, broodLost, workersLost, target: { ...raid.target }, rival: raid.rival, loot: l });
}

/**
 * C227: chitin for the raiders killed in a won defence fight (REWARDS.chitinPerKillTier × tier per kill, like a raid's
 * kill chitin) — the corpses' chitin glints carry it home. Returns the amounts granted.
 */
function defenceLoot(s, d, raid, e, env) {
  const r = rivalByUid(s, raid.rival);
  const tier = Math.max(1, num(r && r.tier, 1));
  const kills = Math.max(0, num(e && e.kills));
  if (!(kills > 0)) return { food: 0, chitin: 0 };
  const got = combat.grantReward(s, d, { chitin: REWARDS.chitinPerKillTier * tier * kills }, env);
  return { food: 0, chitin: num(got && got.chitin) };
}

/** Lost or undefended trail: workers killed, strength lost, 30 s of the trail's income taken (DESIGN §9.10). */
function trailLoss(s, d, raid, t, env, escortsLost) {
  const info = trailInfo(d, t);
  const workers = trailWorkers(d, t);
  const workersLost = Math.min(workers, RAIDS.trailKillMult * raid.raiders);
  const res = hasOwn(JOB_RES, t.job) ? JOB_RES[t.job] : 'food';
  const income = num(info ? info.out : 0) * RAIDS.trailIncomeSec;
  const amount = Math.min(num(s.run.res[res]), income);
  if (amount > 0) spend(s, { [res]: amount });
  trails.hitTrail(s, d, t.uid, { workersLost, sLoss: RAIDS.trailS, escortsLost }); // WP4 emits adultsDied for the kills
  finish(s, raid, env, { win: false, foodLost: res === 'food' ? amount : 0, workersLost });
}

/** Lost nest defence: food theft and brood loss (slave-makers steal the brood). */
function theft(s, d, raid, r, env) {
  const agg = (d && d.nest && d.nest.agg) || {};
  const foodLost = num(s.run.res.food) * theftFraction(agg.reachStorageShare, agg.gateL);
  if (foodLost > 0) spend(s, { food: foodLost });
  const reach = num(population.broodAllocation(s, d).reachShare);
  const frac = RAIDS.broodKill * reach;
  let broodLost = 0;
  if (frac > 0) {
    if (r && Array.isArray(r.traits) && r.traits.includes('brood_raiders')) { // C77 compact records have no traits
      broodLost = num(population.stealBrood(s, frac));
      r.stolen = clampNum(num(r.stolen) + broodLost);
      if (broodLost > 0) env.emit('broodDied', { n: broodLost, cause: 'stolen' });
    } else {
      broodLost = num(population.killBrood(s, frac, 'raid'));
      if (broodLost > 0) env.emit('broodDied', { n: broodLost, cause: 'raid' });
    }
  }
  finish(s, raid, env, { win: false, foodLost, broodLost });
}

/** Start the border (hex 0) or gate (below) fight against the garrison; skip ahead when nobody defends. */
function nestFight(s, d, raid, r, kind, env) {
  const g = rivals.garrison(s, d);
  if (!(g.soldier + g.supermajor > 0)) {
    if (kind === 'border') nestFight(s, d, raid, r, 'gate', env);
    else theft(s, d, raid, r, env);
    return;
  }
  const foe = rivals.bakeFoe(s, d, r, raid.raiders, { yourCount: g.soldier + g.supermajor });
  combat.startBattle(s, d, { kind, hex: 0, below: kind === 'gate', you: { militia: 0, soldier: g.soldier, supermajor: g.supermajor }, foe,
    homeMult: rivals.homeMultOf(s, d), raid: raid.uid, rival: r.uid }, env);
  raid.phase = kind;
}

/** Warning over: start the trail fight (escorts + arrived guards) or the nest sequence. */
function beginFight(s, d, raid, env) {
  const r = rivalByUid(s, raid.rival);
  if (!r || !r.alive) { // C90: the rival fell during the warning — the raid is called off
    finish(s, raid, env, { win: true });
    return;
  }
  if (raid.target.type !== 'trail') {
    nestFight(s, d, raid, r, 'border', env);
    return;
  }
  const t = trailByUid(s, raid.target.uid);
  if (!t || isSafe(s, d, t)) {
    finish(s, raid, env, { win: true });
    return;
  }
  const war = s.run.war;
  let busy = 0; // escorts of this trail already fighting another raid on it
  for (const b of war.battles) {
    if (b.kind !== 'trail' || b.raid === raid.uid) continue;
    const other = war.raids.find((x) => x.uid === b.raid);
    if (other && other.target && other.target.uid === t.uid) busy += Math.max(0, num(b.esc) - num(b.lost && b.lost.soldier));
  }
  const esc = Math.max(0, Math.min(clampNum(num(t.escorts)) - busy, clampNum(num(s.run.colony.adults.soldier))));
  let gSo = 0;
  let gSu = 0;
  for (let i = war.parties.length - 1; i >= 0; i--) {
    const p = war.parties[i];
    if (p.kind !== 'guard' || p.target.uid !== raid.uid || p.state !== 'out' || p.pos < p.path.length - 1) continue;
    gSo += p.soldier;
    gSu += p.supermajor;
    war.parties.splice(i, 1);
  }
  if (!(esc + gSo + gSu > 0)) {
    trailLoss(s, d, raid, t, env, 0);
    return;
  }
  const us = combat.unitStats(s, d, 'soldier');
  const um = combat.unitStats(s, d, 'supermajor');
  const escRaw = esc * Math.sqrt(us.atk * us.hp);
  const guardRaw = gSo * Math.sqrt(us.atk * us.hp) + gSu * Math.sqrt(um.atk * um.hp);
  const phal = owned(s, 'phalanx') ? RESEARCH.phalanx.fx.escortAP : 1;
  const apMult = escRaw + guardRaw > 0 ? (phal * escRaw + guardRaw) / (escRaw + guardRaw) : 1;
  const foe = rivals.bakeFoe(s, d, r, raid.raiders, { yourCount: esc + gSo + gSu, playerApMult: apMult });
  combat.startBattle(s, d, { kind: 'trail', hex: fightHex(t, r), you: { militia: 0, soldier: esc + gSo, supermajor: gSu }, foe, homeMult: 1,
    raid: raid.uid, rival: r.uid, esc }, env);
  raid.phase = 'trail';
}

/** A raid fight ended (battleEnd payload): next stage or result. */
function afterFight(s, d, raid, e, env) {
  raid.raiders = clampNum(num(e.foeLeft));
  const r = rivalByUid(s, raid.rival);
  const lost = e.lost || {};
  if (raid.phase === 'trail') {
    const t = trailByUid(s, raid.target.uid);
    const escortsLost = Math.min(num(e.esc), num(lost.soldier));
    if (e.win) {
      if (t && escortsLost > 0) trails.hitTrail(s, d, t.uid, { escortsLost });
      finish(s, raid, env, { win: true, loot: defenceLoot(s, d, raid, e, env) });
    } else if (t) {
      trailLoss(s, d, raid, t, env, escortsLost);
    } else {
      finish(s, raid, env, { win: false });
    }
  } else if (raid.phase === 'border') {
    if (e.win) finish(s, raid, env, { win: true, loot: defenceLoot(s, d, raid, e, env) });
    else nestFight(s, d, raid, r, 'gate', env);
  } else if (raid.phase === 'gate') {
    if (e.win) finish(s, raid, env, { win: true, loot: defenceLoot(s, d, raid, e, env) });
    else theft(s, d, raid, r, env);
  }
}

/** Launch a raid from rival r (C17: raiders leave the rival now; survivors return). */
function launchRaid(s, d, r, env) {
  const broodRaider = r.traits.includes('brood_raiders');
  const raiders = r.n * (broodRaider ? TRAITS.brood_raiders.partyFrac : RAIDS.partyFrac);
  if (raiders < 1) return null;
  r.n = clampNum(r.n - raiders);
  let target = null;
  if (!(r.tier >= RAIDS.nestTierMin || broodRaider || chance(s, RAIDS.nestRoll))) {
    const t = pickTrail(s, d, r);
    if (t) target = { type: 'trail', uid: t.uid };
  }
  if (!target) target = { type: 'nest' };
  const war = s.run.war;
  const warn = warningSec(s);
  const raid = { uid: war.nextUid++, rival: r.uid, target, raiders, warn, phase: 'warning', guard: 0 };
  war.raids.push(raid);
  s.run.stats.raidsIncoming++;
  env.emit('raidWarning', { uid: raid.uid, rival: r.uid, target: { ...target }, warn });
  if (s.meta.automation.autoGuard && owned(s, 'early_warning') && target.type === 'trail') dispatch(s, d, raid);
  return raid;
}

/**
 * Per tick (online only; everything is frozen offline): finished raid fights, warnings, new raids.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const run = s.run;
  if (!run || !run.war || !env || env.offline || !(dt > 0)) return;
  const war = run.war;
  for (const e of env.events) {
    if (e.type !== 'battleEnd' || !e.raid) continue;
    const raid = war.raids.find((x) => x.uid === e.raid);
    if (raid && FIGHT_PHASES.includes(raid.phase)) afterFight(s, d, raid, e, env);
  }
  for (const raid of [...war.raids]) {
    if (raid.phase === 'warning') {
      raid.warn = clampNum(raid.warn - dt);
      if (raid.warn <= 0) beginFight(s, d, raid, env);
    } else if (FIGHT_PHASES.includes(raid.phase) && !war.battles.some((b) => b.raid === raid.uid)) {
      finish(s, raid, env, { win: true });
    }
  }
  if (war.raids.some((x) => x.phase === 'done')) war.raids = war.raids.filter((x) => x.phase !== 'done');
  if (!raidsPossible(s, d, env)) return;
  if (!(Number.isFinite(raidMean(s, d, null)))) return;
  for (const r of [...run.rivals.list]) {
    if (!rivalEligible(s, r)) continue;
    if (war.raids.some((x) => x.rival === r.uid)) continue;
    r.raidIn = num(r.raidIn) - dt;
    if (r.raidIn > 0) continue;
    const mean = raidMean(s, d, r);
    r.raidIn = Number.isFinite(mean) ? clampNum(expSample(s, mean)) : 0;
    launchRaid(s, d, r, env);
  }
}

/** @type {Record<string, import('../core/types.js').Handler>} */
export const handlers = {
  /** dispatchGuard { raid } — send the garrison to a trail raid (arrives instantly with a Barracks near an entrance). */
  dispatchGuard: {
    validate(s, d, cmd) {
      const raid = s.run.war.raids.find((x) => x.uid === cmd.raid);
      if (!raid || !Number.isInteger(cmd.raid)) return 'notFound';
      if (raid.phase !== 'warning' && raid.phase !== 'trail') return 'invalid';
      if (!raid.target || raid.target.type !== 'trail') return 'invalid:nest';
      if (num(raid.guard) > 0) return 'busy';
      if (!trailByUid(s, raid.target.uid)) return 'invalid';
      const g = rivals.garrison(s, d);
      if (!(g.soldier + g.supermajor > 0)) return 'requirements:garrison';
      return null;
    },
    apply(s, d, cmd) {
      const raid = s.run.war.raids.find((x) => x.uid === cmd.raid);
      dispatch(s, d, raid);
    },
  },
};
