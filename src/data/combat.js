// Combat data: battle model, war actions, tactical actions, raid rules, rewards, achievement combat bonuses.
// Owner: WP5. Contract: ARCHITECTURE §6.5 (DESIGN §9.1, §9.4–§9.8, §9.10, §8.4 prey/termite, §19 combat rewards).

const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/**
 * Battle model (DESIGN §9.5). Every `step` seconds each side deals Σ n × ATK × dmgCoef × step; fortunes ~ U(fortune);
 * previews use a previewGrid × previewGrid fortune grid; parties march marchSecPerHex per hex.
 * endEps: a side with ≤ endEps units has been wiped out (counts are fractional).
 * maxSec: safety stop for a battle in which nobody can deal damage (decided by remaining AP).
 * lossPct: the [lo, hi] percentiles of the preview's loss distribution reported as lossesLo / lossesHi.
 * hintBelow: previews below this win chance list "what would raise it" hints (DESIGN §25.6 rule 8).
 */
export const BATTLE = f({ dmgCoef: 0.2, step: 0.25, fortune: [0.9, 1.1], previewGrid: 64, corpseSec: 5, marchSecPerHex: 2,
  endEps: 1e-6, maxSec: 900, lossPct: [0.1, 0.9], hintBelow: 0.9 });

/**
 * C247: attacking (raid / assault) a rival you hold a truce with. attackPolicy 'break' (default): allowed after the player
 * confirms (launchParty { breakTruce: true }); it ends the truce (the bribe is lost) and the rival's raid clock is
 * multiplied by breakRaidMult (its next raid comes sooner). 'block': refused 'blocked:truce' until the truce expires.
 * Tournaments stay blocked during a truce either way.
 */
export const TRUCE = f({ attackPolicy: 'break', breakRaidMult: 0.5 });

/**
 * War actions (DESIGN §9.4, §8.4, §9.7).
 * raid/assault/hunt: share of defenders engaged and the defender's default home bonus.
 * termite: neutral defender AP and cooldown (its reward is SOURCES.termite_mound.hunt, data/sources.js).
 * bribe: honeydew = apMult × rival AP; truce and cooldown seconds.
 * tournament (STRETCH): display contest seconds, per-rival cooldown, win ratio, display sizes, rival display
 *   = rivalPer × soldiers × (1 + tierStep × (tier − 1)); escalation engages escalateEngage of defenders (no home bonus);
 *   a won hex costs the rival flipLoss of its soldiers; lose = withdraw ratio (1 / win); choiceSec = time to choose
 *   escalate/withdraw before the default (withdraw).
 *   C226 (player feedback "tournaments are useless"): rivalPer 3 → 1.5 (a rival shows half as many ants, so minors can
 *   reach the ratio), cdSec 180 → 90, and a win also pays `prize` — insight = max(insightMinPerTier × tier,
 *   insightSec × √tier s of insight income), chitin = max(chitinMinPerTier × tier, chitinSec × √tier s of chitin
 *   income) — and delays that rival's next raid by raidDelaySec (its raid clock; raids already under way are untouched).
 */
export const ACTIONS = f({
  raid: { engage: 0.4, home: 1 },
  assault: { engage: 1, home: 1.25 },
  hunt: { engage: 1, home: 1 },
  termite: { ap: 28300, cdSec: 300 },
  bribe: { apMult: 2, truceSec: 300, cdSec: 600 },
  tournament: { sec: 20, cdSec: 90, win: 1.5, size: { minor: 1, soldier: 3, supermajor: 10 }, rivalPer: 1.5, tierStep: 0.2,
    escalateEngage: 0.25, flipLoss: 0.02, choiceSec: 30,
    prize: { insightSec: 30, insightMinPerTier: 10, chitinSec: 20, chitinMinPerTier: 3 }, raidDelaySec: 180 },
});

/**
 * Battle rewards (DESIGN §9.4). Raid food = raidFoodSec × √tier s of food income (min raidFoodMinPerTier × tier);
 * chitin = chitinPerKillTier × tier per enemy killed; conquest insight = conquestInsightPerTier × tier × M_insight;
 * conquest food = conquestFoodSec × √tier s; captured minors = capturedPerTier2 × tier².
 */
export const REWARDS = f({ raidFoodSec: 30, raidFoodMinPerTier: 50, chitinPerKillTier: 0.5, conquestInsightPerTier: 25, conquestFoodSec: 120,
  capturedPerTier2: 5 });

/** Tactical battle actions (DESIGN §9.8). */
export const TACTICAL = f({
  alarm_rally: { cost: { pheromone: 25 }, cd: 30, atk: 1.3, sec: 8 },
  mobilize: { cost: { pheromone: 40 }, frac: 0.25, sec: 20 },
  retreat: { loss: 0.3 },
});

/**
 * Rival raids on the player (DESIGN §9.10). warn = min(warnMax, warnBase + warnPerScout × scouts) (+ early_warning);
 * trail raids hit trails passing within trailRadius of rival land (border trails ×borderMult); a lost trail fight costs
 * min(workers, trailKillMult × raiders) foragers, trailIncomeSec of that trail's income and trailS strength;
 * a lost nest defence steals food × max(floor, theft × reach share (theftFallback if 0) × (1 − gate reduction)) and kills
 * broodKill × reach share of the brood. seasonFactor divides the mean interval; pacifistAggro = aggression lost per
 * pacifist reward tier.
 */
export const RAIDS = f({ minAdults: 50, minRunSec: 900, partyFrac: 0.3, warnBase: 15, warnPerScout: 3, warnMax: 60, nestRoll: 0.25, nestTierMin: 4,
  trailRadius: 2, borderMult: 2, trailIncomeSec: 30, trailS: 30, trailKillMult: 2, theft: 0.10, theftFallback: 0.03, broodKill: 0.20,
  seasonFactor: { spring: 1.25, summer: 1.5, autumn: 1, winter: 0 }, pacifistAggro: 0.08 });

/**
 * Achievement bonuses implemented by WP5 (ARCHITECTURE §12.5; DESIGN §19).
 * ach_flawless: Alarm Rally cost ×0.8; ach_ritualist: tournament win ratio 1.4; ach_phragmosis: Gate HP term ×1.05.
 */
export const ACH_FX = f({
  ach_flawless: { rallyCost: 0.8 },
  ach_ritualist: { win: 1.4 },
  ach_phragmosis: { gate: 1.05 },
});
