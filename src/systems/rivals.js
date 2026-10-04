// Rivals: lifecycle (spawn, growth, fire-ant creep, respawn, extra rivals as the map grows), bosses (Old Ridge,
// Argentine Front), war parties (raid / assault / hunt / termite, guards, reinforcements), bribes, tournaments,
// conquest and outposts, field triage, and the d.combat cache. Owner: WP5.
// Contract: ARCHITECTURE §8.4 (systems/rivals.js), §9 (launchParty … tournamentChoice), §10, §18 C17, C21, C27–C29,
// C42, C47; DESIGN §8.6, §8.8, §8.9, §9.2–§9.4, §9.7, §9.8.
//
// ARCH-R: bosses get an equivalent tier for rewards and the raid-target rule: the elder tier whose AP formula their AP
//   reaches (max(ELDER.fromTier, tierOffset + floor(log_apGrowth(AP / apBase)))). Boss conquests never change topTier and
//   queue no respawn; bosses do not grow.
// ARCH-R: Argentine Front nests that fall are "pending" (alive = false, fallenAt set) until all 3 have fallen within the
//   window; only then are their hexes conquered, outposts placed and spoils granted (kill chitin is battle loot and is
//   granted at each fall). Pending nests regrow (the same rivals restored) when the window closes. The window pauses
//   offline (pending fallenAt is shifted by offline dt).
// ARCH-R: extra rivals when the map radius grows spawn at tier max(topTier, highest alive ladder tier) + 1; pending
//   respawns count toward SPAWN.maxByRadius. No auto-fill at the base radius (mapgen's specs stand).
// ARCH-R: prey and the termite mound fight as one neutral unit with ATK = HP = their AP (Lanchester-equivalent).
// ARCH-R: acid_volley, venom and swarm apply in every battle against that rival (attacks and defence); propaganda only on
//   assaults (also its 5 % conversion). site_hostile_neighbours and edict_of_war conquest multipliers stack.
// ARCH-R: a truce also blocks player tournaments against that rival; bribing cancels that rival's raids still in warning.
// ARCH-R: tournaments live in war.battles as kind 'tournament' (tournamentChoice's uid is a battle uid); the ratio is
//   stored in `odds` once the 20 s display ends; undecided contests default to withdraw after ACTIONS.tournament.choiceSec.
//   They emit tournamentStart / tournamentEnd (not in §10).
// rivalSighted / conquest carry the rival type as `rivalType` (§10: payload keys are never named `type`).
// ARCH-R: Mobilize windows and the Alarm Rally cooldown are kept as core effects (ids 'mobilize:<battle uid>' and
//   'alarm_rally:cd'; stats 'mobilize' / 'cooldown', read by nobody else).
// C73: Mobilize drafts frac × idle minors plus frac × foragers; the foragers leave their job explicitly and the
//   battle records the draft in `mob` so combat.releaseMobilized can hand the survivors back.
// C77: conquered non-boss rivals are compacted at the end of every tick to FALLEN_KEEP (what the war panel, tooltips,
//   toasts, achievements and field guide read) and at most FALLEN_RIVALS.keep of them stay (oldest dropped). Bosses are
//   never compacted (Old Ridge is looked up by type; pending Front nests regrow from their full record).
// ARCH-R: guard and reinforcement parties merge into the battle they join (their survivors are back in the garrison when
//   it ends); attack-party survivors march home. Guards leave from main/nuptial entrances and outposts, plus satellites
//   with highway_network ("satellites share the garrison").

import { RIVALS, RIVAL_ORDER, ELDER, GROWTH, TRAITS, BOSSES, MAP_BOSS_ORDER, SPAWN, RIVAL_TRAIT_ORDER, FALLEN_RIVALS } from '../data/rivals.js';
import { ACTIONS, REWARDS, TACTICAL, BATTLE, ACH_FX, RAIDS } from '../data/combat.js';
import { RESEARCH } from '../data/research.js';
import { SOURCES } from '../data/sources.js';
import { TERRAIN, TERRITORY, MOUND } from '../data/surface.js';
import { CHAMBERS } from '../data/chambers.js';
import { SITES, EDICTS, HARDSHIPS } from '../data/prestige.js';
import { HEX, CLAMP_MAX, COST_MAX } from '../data/balance.js';
import { hexIndex, hexQR, ringOf, neighbors, hexDist, hexPath, lineHexes, countInRadius } from '../core/hex.js';
import { randInt, randRange, expSample, shuffle } from '../core/rng.js';
import { canAfford, spend, scaleCost } from '../core/wallet.js';
import { addEffect, hasEffect, effectMult } from '../core/effects.js';
import { clampNum, lvl } from '../core/math.js';
import * as combat from './combat.js';
import * as surface from './surface.js';
import * as population from './population.js';

const hasOwn = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const num = (x, dflt = 0) => (Number.isFinite(x) ? x : dflt);
const isHex = (h) => Number.isInteger(h) && h >= 0 && h < HEX.count;
const owned = (s, id) => !!(s.run.research && s.run.research[id]);
const ach = (s, id) => !!(s.meta.achievements && s.meta.achievements[id] !== undefined && s.meta.achievements[id] !== null);
const PARTY_KINDS = Object.freeze(['raid', 'assault', 'hunt', 'termite']);
const TOURNEY = 'tournament';
const STONE = TERRAIN.stone ? TERRAIN.stone.code : -1;
const PUDDLE = TERRAIN.puddle ? TERRAIN.puddle.code : -1;
const LOG = TERRAIN.log ? TERRAIN.log.code : -1;

// ------------------------------------------------------------------------------------------------------------------
// Lookups
// ------------------------------------------------------------------------------------------------------------------

/** @returns {boolean} true for a map boss (Old Ridge, Argentine Front) */
export function isBoss(rival) {
  return !!rival && MAP_BOSS_ORDER.includes(rival.type);
}

/** Rival by uid (alive or fallen), or null. */
function rivalByUid(s, uid) {
  if (!Number.isInteger(uid)) return null;
  for (const r of s.run.rivals.list) if (r.uid === uid) return r;
  return null;
}

/** Alive rival by uid, or null. */
function aliveRival(s, uid) {
  const r = rivalByUid(s, uid);
  return r && r.alive ? r : null;
}

/** Source by uid, or null. */
function sourceByUid(s, uid) {
  if (!Number.isInteger(uid)) return null;
  for (const src of s.run.surface.sources) if (src.uid === uid) return src;
  return null;
}

/** Battle by uid, or null. */
function battleByUid(s, uid) {
  if (!Number.isInteger(uid)) return null;
  for (const b of s.run.war.battles) if (b.uid === uid) return b;
  return null;
}

/** Party by uid, or null. */
function partyByUid(s, uid) {
  if (!Number.isInteger(uid)) return null;
  for (const p of s.run.war.parties) if (p.uid === uid) return p;
  return null;
}

/** Mean raid interval in minutes of a rival type. */
export function raidMinOf(rival) {
  if (!rival) return ELDER.raidMin;
  if (hasOwn(RIVALS, rival.type)) return RIVALS[rival.type].raidMin;
  if (hasOwn(BOSSES, rival.type) && Number.isFinite(BOSSES[rival.type].raidMin)) return BOSSES[rival.type].raidMin;
  return ELDER.raidMin;
}

/** Display name of a rival type (ladder, boss or elder colony). WP5 extra query for the UI. */
export function rivalName(type) {
  if (hasOwn(RIVALS, type)) return RIVALS[type].name;
  if (hasOwn(BOSSES, type)) return BOSSES[type].name;
  return ELDER.name;
}

/** Current map radius (clamped to the stored maximum). */
function mapRadius(s) {
  return Math.max(0, Math.min(HEX.maxRadius, Math.floor(num(s.run.surface.radius, HEX.maxRadius))));
}

/** True while rivals are dormant (winter). */
function isWinter(d) {
  const se = d && d.season;
  return !!se && (se.id === 'winter' || !!(se.mods && se.mods.rivalDormant));
}

/** Equivalent elder tier of a boss AP. */
function bossTier(ap) {
  const g = Math.log(Math.max(1, ap) / ELDER.apBase) / Math.log(ELDER.apGrowth);
  return Math.max(ELDER.fromTier, ELDER.tierOffset + Math.floor(Number.isFinite(g) ? g : 0));
}

/**
 * Stats of a rival of the given type/tier: { tier, base, atk, hp, radius, raidMin, traits }.
 * Elder traits are rolled from s (main RNG).
 */
function statsFor(s, type, tier) {
  if (hasOwn(RIVALS, type)) {
    const r = RIVALS[type];
    return { tier: r.tier, base: r.soldiers, atk: r.atk, hp: r.hp, radius: r.radius, traits: [...r.traits] };
  }
  if (type === 'old_ridge_supercolony') {
    const b = BOSSES.old_ridge_supercolony;
    const m = num(s.meta.counters.supercolonies);
    const ap = clampNum(b.apBase * (1 + m) ** b.apExp);
    return { tier: bossTier(ap), base: clampNum(ap / Math.sqrt(b.atk * b.hp)), atk: b.atk, hp: b.hp, radius: b.radius, traits: [] };
  }
  if (type === 'great_rival') {
    const b = BOSSES.great_rival;
    const sp = num(s.meta.counters.speciations);
    const ap = clampNum(b.apBase * b.apGrowth ** sp) / b.nests;
    return { tier: bossTier(ap), base: clampNum(ap / Math.sqrt(b.atk * b.hp)), atk: b.atk, hp: b.hp, radius: b.radius, traits: [] };
  }
  const k = Math.max(ELDER.fromTier, Math.floor(num(tier, ELDER.fromTier)));
  const g = k - ELDER.tierOffset;
  const ap = clampNum(ELDER.apBase * ELDER.apGrowth ** g);
  const atk = clampNum(ELDER.atkBase * ELDER.statGrowth ** g);
  const hp = clampNum(ELDER.hpBase * ELDER.statGrowth ** g);
  const count = randInt(s, ELDER.traitsMin, ELDER.traitsMax);
  const traits = shuffle(s, [...RIVAL_TRAIT_ORDER]).slice(0, count);
  traits.sort((a, b) => RIVAL_TRAIT_ORDER.indexOf(a) - RIVAL_TRAIT_ORDER.indexOf(b));
  return { tier: k, base: clampNum(ap / Math.sqrt(atk * hp)), atk, hp, radius: ELDER.radius, traits };
}

// ------------------------------------------------------------------------------------------------------------------
// Territory
// ------------------------------------------------------------------------------------------------------------------

/** Hexes within `radius` of `center` and inside the map radius `mapR`. */
function disc(center, radius, mapR) {
  const out = [];
  if (!isHex(center)) return out;
  const [q, r] = hexQR(center);
  const R = Math.max(0, Math.floor(num(radius)));
  const limit = countInRadius(mapR);
  for (let dq = -R; dq <= R; dq++) {
    const lo = Math.max(-R, -dq - R);
    const hi = Math.min(R, -dq + R);
    for (let dr = lo; dr <= hi; dr++) {
      const i = hexIndex(q + dq, r + dr);
      if (i >= 0 && i < limit) out.push(i);
    }
  }
  return out;
}

/**
 * Rival land = disc(hex, radius) ∪ extra − lost − player-held hexes (claimed / conquered, C95), inside the current map
 * radius; sorted ascending (C29, C47).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Rival} rival
 * @returns {number[]}
 */
export function rivalLand(s, rival) {
  if (!rival || typeof rival !== 'object' || !s || !s.run) return [];
  const mapR = mapRadius(s);
  const limit = countInRadius(mapR);
  const set = new Set(disc(rival.hex, rival.radius, mapR));
  if (Array.isArray(rival.extra)) for (const h of rival.extra) if (isHex(h) && h < limit) set.add(h);
  if (Array.isArray(rival.lost)) for (const h of rival.lost) set.delete(h);
  // C95: a hex the player holds (claimed or conquered) is never rival land, whatever the disc covers
  const S = s.run.surface;
  if (S && S.claimed && S.conquered) for (const h of Array.from(set)) if (S.claimed[h] || S.conquered[h]) set.delete(h);
  return Array.from(set).sort((a, b) => a - b);
}

/** Uint8Array mask of hexes within `dist` of the rival's land (WP5 internal: raids.js). */
export function nearMask(s, rival, dist) {
  const mask = new Uint8Array(HEX.count);
  let frontier = rivalLand(s, rival);
  for (const h of frontier) mask[h] = 1;
  for (let k = 0; k < dist; k++) {
    const next = [];
    for (const h of frontier) {
      for (const n of neighbors(h)) {
        if (!mask[n]) {
          mask[n] = 1;
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return mask;
}

/** Owned-hex mask (d.surface.owned when available, else claimed ∪ conquered). */
function ownedMask(s, d) {
  if (d && d.surface && d.surface.owned && d.surface.owned.length === HEX.count) return d.surface.owned;
  const S = s.run.surface;
  const m = new Uint8Array(HEX.count);
  for (let i = 0; i < HEX.count; i++) if (S.claimed[i] || S.conquered[i]) m[i] = 1;
  return m;
}

/**
 * C95: hexes a new rival may never cover: derived owned land, claimed and conquered hexes, and every entrance's
 * auto-claim radius (the radius surface.rebuildTerritory uses), so a spawn never lands on or over land the player holds.
 */
function playerMask(s, d) {
  const S = s.run.surface;
  const m = new Uint8Array(HEX.count);
  const D = d && d.surface && d.surface.owned && d.surface.owned.length === HEX.count ? d.surface.owned : null;
  for (let i = 0; i < HEX.count; i++) if ((D && D[i]) || S.claimed[i] || S.conquered[i]) m[i] = 1;
  const autoR = TERRITORY.autoBase + Math.floor(Math.max(0, num(S.mound)) / TERRITORY.autoPerMound);
  const mapR = mapRadius(s);
  for (const e of S.entrances) if (e && isHex(e.hex)) for (const h of disc(e.hex, autoR, mapR)) m[h] = 1;
  return m;
}

/** Grow a hex mask by `steps` rings (every hex within `steps` of a marked hex). */
function dilate(mask, steps) {
  const out = Uint8Array.from(mask);
  let frontier = [];
  for (let i = 0; i < out.length; i++) if (out[i]) frontier.push(i);
  for (let k = 0; k < steps && frontier.length; k++) {
    const next = [];
    for (const h of frontier) {
      for (const n of neighbors(h)) {
        if (n >= 0 && n < out.length && !out[n]) {
          out[n] = 1;
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** True when a nest at `hex` with land radius `landR` would cover a player-held hex (C95). */
function overlapsPlayer(s, d, hex, landR) {
  if (!isHex(hex)) return false;
  const m = playerMask(s, d);
  return disc(hex, landR, mapRadius(s)).some((h) => m[h]);
}

/**
 * C95: per-run memo of spawn searches that found no hex (never saved), keyed by what could free a hex: the surface
 * revision (claims, conquests, creep, new rivals), the mound, the map radius and the rival list. A failed search is
 * not repeated every tick until one of them changes.
 */
const spawnFail = new WeakMap();
function spawnKey(s, extra = '') {
  const S = s.run.surface;
  return [S.rev, num(S.mound), mapRadius(s), s.run.rivals.list.length, extra].join('|');
}
function failedBefore(s, kind, key) {
  const m = spawnFail.get(s.run);
  return !!m && m[kind] === key;
}
function markFailed(s, kind, key) {
  let m = spawnFail.get(s.run);
  if (!m) spawnFail.set(s.run, (m = {}));
  m[kind] = key;
}

/**
 * Pick a hex for a new rival nest in rings [ringMin, ringMax] (clamped to the map), avoiding stone/puddles, sources,
 * entrances, other rivals' land (and their land radius) and hexes closer than `gap` to `avoid`. The new land (radius
 * `landR`) never covers a player-held hex (C95); only the rival-spacing rule is relaxed when nothing fits. Uses s as
 * the RNG holder (no draw when nothing fits). Returns −1 when no hex qualifies; callers then postpone the spawn.
 */
function chooseSpawnHex(s, d, { ringMin, ringMax, landR = 0, avoid = [], gap = 0, preferLog = false }) {
  const S = s.run.surface;
  const mapR = mapRadius(s);
  const hi = Math.min(mapR, Math.max(1, Math.floor(ringMax)));
  const lo = Math.max(1, Math.min(hi, Math.floor(ringMin)));
  const busy = new Set();
  for (const src of S.sources) busy.add(src.hex);
  for (const e of S.entrances) if (e) busy.add(e.hex);
  const alive = s.run.rivals.list.filter((r) => r.alive);
  for (const r of alive) busy.add(r.hex);
  const blocked = dilate(playerMask(s, d), Math.max(0, Math.floor(num(landR))));
  const strict = [];
  const loose = [];
  for (let i = countInRadius(lo - 1); i < countInRadius(hi); i++) {
    const code = S.terrain[i];
    if (code === STONE || code === PUDDLE || busy.has(i) || blocked[i]) continue;
    if (avoid.some((a) => hexDist(a, i) < gap)) continue;
    loose.push(i);
    if (alive.some((r) => hexDist(r.hex, i) <= num(r.radius) + landR)) continue;
    strict.push(i);
  }
  let pool = strict.length ? strict : loose;
  if (!pool.length) return -1;
  if (preferLog && LOG >= 0) {
    const logs = pool.filter((i) => S.terrain[i] === LOG);
    if (logs.length) pool = logs;
  }
  return pool[randInt(s, 0, pool.length - 1)];
}

// ------------------------------------------------------------------------------------------------------------------
// Creation and spawning
// ------------------------------------------------------------------------------------------------------------------

/**
 * Create a rival from { type, tier, hex } and add it to s.run.rivals.list (uid from rivals.nextUid). An unknown or
 * missing type is derived from the tier (ladder for tiers 1–6, elder colony beyond). A missing hex is chosen in the
 * outermost ring band. Calls surface.touch(s).
 * @param {import('../core/types.js').State} s
 * @param {{ type?: string, tier?: number, hex?: number, group?: number }} spec
 * @returns {import('../core/types.js').Rival}
 */
export function createRival(s, spec) {
  const sp = spec && typeof spec === 'object' ? spec : {};
  let type = typeof sp.type === 'string' ? sp.type : null;
  let tier = Number.isFinite(sp.tier) ? Math.max(1, Math.floor(sp.tier)) : 0;
  if (type && hasOwn(RIVALS, type)) {
    tier = RIVALS[type].tier;
  } else if (!(type && MAP_BOSS_ORDER.includes(type))) {
    if (type !== ELDER.id) {
      if (!tier) tier = 1;
      type = tier >= ELDER.fromTier ? ELDER.id : RIVAL_ORDER[Math.min(tier, RIVAL_ORDER.length) - 1];
    }
    if (type === ELDER.id) tier = Math.max(ELDER.fromTier, tier);
  }
  const st = statsFor(s, type, tier);
  let hex = sp.hex;
  if (!isHex(hex)) {
    const R = mapRadius(s);
    hex = chooseSpawnHex(s, null, { ringMin: R - SPAWN.outerBand + 1, ringMax: R, landR: st.radius, preferLog: hasOwn(RIVALS, type) && !!RIVALS[type].log });
    if (hex < 0) hex = countInRadius(Math.max(0, R - 1));
  }
  const R = s.run.rivals;
  const rival = {
    uid: R.nextUid++,
    type,
    tier: st.tier,
    hex,
    radius: st.radius,
    base: st.base,
    n: st.base,
    atk: st.atk,
    hp: st.hp,
    traits: st.traits,
    alive: true,
    sighted: false,
    raidIn: 0,
    truce: 0,
    bribeCd: 0,
    tourCd: 0,
    creepIn: st.traits.includes('border_creep') ? TERRITORY.creepSec : 0,
    group: Number.isInteger(sp.group) && sp.group > 0 ? sp.group : 0,
    fallenAt: -1,
    extra: [],
    lost: [],
    stolen: 0,
  };
  rival.raidIn = clampNum(expSample(s, raidMinOf(rival) * 60));
  R.list.push(rival);
  surface.touch(s);
  return rival;
}

/** Max concurrent ladder/elder rivals at a map radius (largest SPAWN.maxByRadius key ≤ radius). */
function maxRivals(radius) {
  const keys = Object.keys(SPAWN.maxByRadius).map(Number).sort((a, b) => a - b);
  let v = SPAWN.maxByRadius[keys[0]];
  for (const k of keys) if (radius >= k) v = SPAWN.maxByRadius[k];
  return v;
}

/** Spawn bosses whose conditions hold (each at most once per run, C42). */
function spawnBosses(s, d) {
  const list = s.run.rivals.list;
  const R = mapRadius(s);
  const or = BOSSES.old_ridge_supercolony;
  if (lvl(s.cycle.traits, 'budding') >= 1 && num(s.cycle.alatesCycle) >= or.alatesCycle && !list.some((r) => r.type === or.id)) {
    const key = spawnKey(s);
    const hex = failedBefore(s, 'or', key) ? -1 : chooseSpawnHex(s, d, { ringMin: R, ringMax: R, landR: or.radius });
    if (hex >= 0) createRival(s, { type: or.id, hex });
    else markFailed(s, 'or', key);
  }
  const gr = BOSSES.great_rival;
  const grKey = spawnKey(s);
  if (lvl(s.era.federation, 'megacolony') >= 1 && !list.some((r) => r.type === gr.id) && !failedBefore(s, 'gr', grKey)) {
    let hexes = [];
    for (const gap of [gr.minGap, 1]) {   // spread the nests apart; on a crowded map settle for distinct hexes
      hexes = [];
      for (let i = 0; i < gr.nests; i++) {
        const hex = chooseSpawnHex(s, d, { ringMin: R - SPAWN.outerBand + 1, ringMax: R, landR: gr.radius, avoid: hexes, gap });
        if (hex < 0) break;
        hexes.push(hex);
      }
      if (hexes.length === gr.nests) break;
    }
    if (hexes.length === gr.nests) {
      const group = s.run.rivals.nextUid;
      for (const hex of hexes) createRival(s, { type: gr.id, hex, group });
    } else {
      markFailed(s, 'gr', grKey);
    }
  }
}

/** Highest tier among alive ladder/elder rivals (0 if none). */
function maxAliveTier(s) {
  let t = 0;
  for (const r of s.run.rivals.list) if (r.alive && !isBoss(r)) t = Math.max(t, num(r.tier));
  return t;
}

/** Extra rivals once the map radius grows past the base radius (up to SPAWN.maxByRadius). */
function fillRivals(s, d) {
  const R = mapRadius(s);
  const baseR = Math.min(...Object.keys(SPAWN.maxByRadius).map(Number));
  if (R <= baseR) return;
  const want = maxRivals(R);
  const RV = s.run.rivals;
  let count = RV.respawn.length;
  for (const r of RV.list) if (r.alive && !isBoss(r)) count++;
  if (count >= want) return;
  // C95: when no hex fits (the player holds the outer band) wait until the land, the map or the rivals change
  const key = () => spawnKey(s, count + ':' + num(RV.topTier));
  if (failedBefore(s, 'fill', key())) return;
  while (count < want) {
    const tier = Math.max(num(RV.topTier), maxAliveTier(s)) + 1;
    const type = tier >= ELDER.fromTier ? ELDER.id : RIVAL_ORDER[tier - 1];
    const landR = hasOwn(RIVALS, type) ? RIVALS[type].radius : ELDER.radius;
    const hex = chooseSpawnHex(s, d, { ringMin: R - SPAWN.outerBand + 1, ringMax: R, landR,
      preferLog: hasOwn(RIVALS, type) && !!RIVALS[type].log });
    if (hex < 0) {
      markFailed(s, 'fill', key());
      break;
    }
    createRival(s, { tier, hex });
    count++;
  }
}

/**
 * Run start (WP7 startRun): create the mapgen rival specs, then any boss whose condition already holds.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {Array<{ type: string, tier: number, hex: number }>} specs
 * @returns {void}
 */
export function spawnInitial(s, d, specs) {
  if (Array.isArray(specs)) {
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object') continue;
      // C95: a spec whose land would cover player-held hexes moves to a free outer-band hex, else waits as a respawn
      const landR = hasOwn(RIVALS, spec.type) ? RIVALS[spec.type].radius : ELDER.radius;
      if (isHex(spec.hex) && overlapsPlayer(s, d, spec.hex, landR)) {
        const R = mapRadius(s);
        const hex = chooseSpawnHex(s, d, { ringMin: R - SPAWN.outerBand + 1, ringMax: R, landR });
        if (hex >= 0) createRival(s, { ...spec, hex });
        else s.run.rivals.respawn.push({ in: SPAWN.retrySec, tier: Math.max(1, Math.floor(num(spec.tier, 1))) });
        continue;
      }
      createRival(s, spec);
    }
  }
  spawnBosses(s, d);
  surface.touch(s);
}

// ------------------------------------------------------------------------------------------------------------------
// Garrison, home bonus, foe building
// ------------------------------------------------------------------------------------------------------------------

/**
 * Soldiers and supermajors not escorting, not in a party (marching) and not committed to a battle or tournament.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @returns {{ soldier: number, supermajor: number }}
 */
export function garrison(s, d) {
  const run = s.run;
  let so = num(run.colony.adults.soldier);
  let su = num(run.colony.adults.supermajor);
  for (const t of run.surface.trails) so -= num(t && t.escorts);
  for (const p of run.war.parties) {
    if (p.state === 'fighting') continue;
    so -= num(p.soldier);
    su -= num(p.supermajor);
  }
  for (const b of run.war.battles) {
    const lost = b.lost || {};
    // escorts in a trail fight are already counted through their trail (unless that trail was deleted meanwhile)
    let esc = num(b.esc);
    if (esc > 0) {
      const raid = run.war.raids.find((x) => x.uid === b.raid);
      const uid = raid && raid.target ? raid.target.uid : -1;
      if (!run.surface.trails.some((t) => t && t.uid === uid)) esc = 0;
    }
    so -= num(b.you.soldier) + num(lost.soldier) - esc;
    su -= num(b.you.supermajor) + num(lost.supermajor);
  }
  return { soldier: clampNum(so), supermajor: clampNum(su) };
}

/** Player home-defence AP multiplier: (1 + MOUND.homeAP × mound) × (barracks homeAP if a Barracks is near an entrance). */
export function homeMultOf(s, d) {
  const bfx = (hasOwn(CHAMBERS, 'barracks') && CHAMBERS.barracks.fx) || {};
  const near = !!(d && d.nest && d.nest.agg && d.nest.agg.barracksNear);
  return (1 + MOUND.homeAP * num(s.run.surface.mound)) * (near ? num(bfx.homeAP, 1) : 1);
}

/** Share of an army's raw AP coming from supermajors. */
function supermajorShare(s, d, army) {
  const a = combat.normArmy(army);
  const us = combat.unitStats(s, d, 'supermajor');
  const sm = a.supermajor * Math.sqrt(us.atk * us.hp);
  let all = sm;
  for (const g of ['militia', 'soldier']) {
    const u = combat.unitStats(s, d, g);
    all += a[g] * Math.sqrt(u.atk * u.hp);
  }
  return all > 0 ? sm / all : 0;
}

/**
 * Effective rival home bonus against an assaulting army: 1 + (bonus − 1) × (1 − supermajor AP share), the bonus portion
 * × siege_tactics fx.home (DESIGN §9.4).
 */
export function effectiveHome(s, d, rival, army) {
  let portion = (combat.baseHome(rival) - 1) * (1 - supermajorShare(s, d, army));
  if (owned(s, 'siege_tactics')) portion *= RESEARCH.siege_tactics.fx.home;
  return 1 + portion;
}

/**
 * Effective foe stats of n rival soldiers (see combat.js header): AP effects, swarm (n > yourCount), home bonus,
 * propaganda (assaults), and the equivalents of acid_volley (your AP), venom (your HP) and playerApMult (your AP).
 * @returns {{ n: number, atk: number, hp: number }}
 */
export function bakeFoe(s, d, rival, n, { home = 1, yourCount = 0, assault = false, playerApMult = 1 } = {}) {
  const traits = Array.isArray(rival.traits) ? rival.traits : [];
  let m = effectMult(s, 'ap_rival') * effectMult(s, 'ap_rival', rival.uid);
  if (traits.includes('swarm') && n > yourCount) m *= TRAITS.swarm.apMult;
  m *= num(home, 1);
  if (assault && owned(s, 'propaganda_pheromones')) m *= RESEARCH.propaganda_pheromones.fx.enemyAP;
  if (traits.includes('acid_volley') && !owned(s, 'formic_acid')) m /= TRAITS.acid_volley.yourAP;
  if (playerApMult > 0) m /= playerApMult;
  let atk = num(rival.atk) * m;
  const hp = num(rival.hp) * m;
  if (traits.includes('venom')) atk /= TRAITS.venom.yourHP;
  return { n: clampNum(n), atk: clampNum(atk), hp: clampNum(hp) };
}

/** Neutral defender (prey, termite mound) of the given AP: one unit with ATK = HP = AP. */
function neutralFoe(ap) {
  const a = clampNum(num(ap));
  return { n: a > 0 ? 1 : 0, atk: a, hp: a };
}

/** True if the source is huntable prey (has hunt.apPerRing). */
function isPrey(src) {
  const def = src && hasOwn(SOURCES, src.type) ? SOURCES[src.type] : null;
  return !!(def && def.hunt && Number.isFinite(def.hunt.apPerRing));
}

/** Season factor of a source type (1 under the 'neutral' srcId, C38/C45). */
function seasonFactor(d, type) {
  const id = d && d.season ? d.season.srcId : null;
  if (!id || id === 'neutral') return 1;
  const def = hasOwn(SOURCES, type) ? SOURCES[type] : null;
  return def && def.season && Number.isFinite(def.season[id]) ? def.season[id] : 1;
}

/** Hunt / termite reward spec: hunt.foodSec s of food + hunt.chitinPerRing × ring × chitinMult chitin, × season. */
function huntReward(d, src) {
  const def = hasOwn(SOURCES, src.type) ? SOURCES[src.type] : null;
  const h = (def && def.hunt) || {};
  const f = seasonFactor(d, src.type);
  const ring = ringOf(src.hex);
  return { foodSec: num(h.foodSec) * f, chitin: num(h.chitinPerRing) * ring * num(h.chitinMult, 1) * f };
}

/** AP of a prey or termite defender. */
function neutralAP(src) {
  if (src.type === 'termite_mound') return ACTIONS.termite.ap;
  const def = hasOwn(SOURCES, src.type) ? SOURCES[src.type] : null;
  return def && def.hunt ? num(def.hunt.apPerRing) * ringOf(src.hex) : 0;
}

/** Conquest reward multiplier: site_hostile_neighbours × edict_of_war. */
function conquestMult(s) {
  let m = 1;
  if (Array.isArray(s.run.landingTags) && s.run.landingTags.includes('site_hostile_neighbours')) m *= num(SITES.site_hostile_neighbours.fx.conquest, 1);
  if (s.cycle.edict === 'edict_of_war' && hasOwn(EDICTS, 'edict_of_war')) m *= num(EDICTS.edict_of_war.fx.conquest, 1);
  return m;
}

/** Old Ridge assault immunity (owned hexes below immuneUntilOwned). */
function immune(s, d, rival) {
  if (rival.type !== 'old_ridge_supercolony') return false;
  return num(d && d.surface && d.surface.ownedCount) < BOSSES.old_ridge_supercolony.immuneUntilOwned;
}

// ------------------------------------------------------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------------------------------------------------------

/** Nearest entrance hex to `target` among the allowed kinds (main hex 0 as fallback). */
function nearestEntrance(s, target, kinds = null) {
  let best = 0;
  let bestD = Infinity;
  for (const e of s.run.surface.entrances) {
    if (!e || !isHex(e.hex)) continue;
    if (kinds && !kinds.includes(e.kind)) continue;
    const dd = hexDist(e.hex, target);
    if (dd < bestD || (dd === bestD && e.hex < best)) {
      bestD = dd;
      best = e.hex;
    }
  }
  return best;
}

/** Entrance kinds guards leave from (satellites only with highway_network). */
function guardKinds(s) {
  return lvl(s.era.federation, 'highway_network') >= 1 ? ['main', 'nuptial', 'outpost', 'satellite'] : ['main', 'nuptial', 'outpost'];
}

/** Marching path from → to: A* over surface.moveCost (the target hex always enterable), straight line as fallback. */
export function marchPath(s, d, from, to) {
  if (!isHex(from) || !isHex(to)) return [isHex(from) ? from : 0];
  if (from === to) return [from];
  let r = null;
  try {
    r = hexPath(from, to, (i) => (i === to ? 1 : surface.moveCost(s, d, i)));
  } catch {
    r = null;
  }
  return r && Array.isArray(r.path) && r.path.length ? r.path : lineHexes(from, to);
}

/** Seconds to march a path. */
function marchSec(path) {
  return Math.max(0, path.length - 1) * BATTLE.marchSecPerHex;
}

/** Guard origin: nearest entrance among the kinds the garrison leaves from (WP5 internal: raids.js). */
export function guardOrigin(s, target) {
  return nearestEntrance(s, target, guardKinds(s));
}

/** New party record (uid from war.nextUid). WP5 internal (raids.js dispatches guards). */
export function makeParty(s, kind, target, soldier, supermajor, path) {
  const war = s.run.war;
  const p = { uid: war.nextUid++, kind, target, soldier: clampNum(soldier), supermajor: clampNum(supermajor), path, pos: 0, state: 'out' };
  war.parties.push(p);
  return p;
}

// ------------------------------------------------------------------------------------------------------------------
// Party validation and previews
// ------------------------------------------------------------------------------------------------------------------

/** Finite, non-negative count (or 0 when absent). null for garbage. */
function count(v) {
  if (v === undefined) return 0;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Target object { type, uid } with a known type, or null. */
function cleanTarget(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  if (!['rival', 'source', 'raid', 'battle'].includes(t.type) || !Number.isInteger(t.uid)) return null;
  return { type: t.type, uid: t.uid };
}

/** Reason a target is invalid for a party kind (null = fine), plus the resolved object. */
function checkTarget(s, d, kind, target) {
  const t = cleanTarget(target);
  if (!t) return { reason: 'invalid' };
  if (kind === 'raid' || kind === 'assault') {
    if (t.type !== 'rival') return { reason: 'invalid' };
    const r = aliveRival(s, t.uid);
    if (!r) return { reason: 'notFound' };
    const found = { rival: r, hex: r.hex };
    if (!r.sighted) return { reason: 'blocked:unsighted', ...found };
    if (kind === 'assault' && immune(s, d, r)) return { reason: 'blocked:immune', ...found };
    return { reason: null, ...found };
  }
  if (t.type !== 'source') return { reason: 'invalid' };
  const src = sourceByUid(s, t.uid);
  if (!src) return { reason: 'notFound' };
  if (kind === 'hunt' ? !isPrey(src) : src.type !== 'termite_mound') return { reason: 'invalid' };
  const found = { src, hex: src.hex };
  if (!s.run.surface.revealed[src.hex]) return { reason: 'blocked:unsighted', ...found };
  if (kind === 'termite' && num(src.cd) > 0) return { reason: 'cooldown', ...found };
  return { reason: null, ...found };
}

/** Shared launchParty / previewAction validation (garrison against live state). */
function partyReason(s, d, kind, target, soldier, supermajor) {
  if (!s.run.unlocked.panel_war) return 'locked';
  if (s.run.hardship === 'pacifist') return 'hardship';
  if (!PARTY_KINDS.includes(kind)) return 'invalid';
  const so = count(soldier);
  const su = count(supermajor);
  if (so === null || su === null || !(so + su > 0)) return 'invalid';
  const chk = checkTarget(s, d, kind, target);
  if (chk.reason) return chk.reason;
  const g = garrison(s, d);
  if (so > g.soldier + 1e-9 || su > g.supermajor + 1e-9) return 'requirements:garrison';
  return null;
}

/** "What would raise it" hints (DESIGN §25.6 rule 8). */
function raiseHints(s, d, kind, rival, youAP, foeAP, win) {
  const out = [];
  if (win >= BATTLE.hintBelow || !(foeAP > 0)) return out;
  const [lo, hi] = BATTLE.fortune;
  const per = combat.armyAP(s, d, { soldier: 1 });
  if (per > 0) {
    const extra = Math.ceil(Math.max(0, (foeAP * hi) / lo - youAP) / per);
    if (extra > 0) out.push({ key: 'soldiers', text: `About ${extra} more soldiers for a near-certain win` });
  }
  if (owned(s, 'supermajors')) {
    if (kind === 'assault') out.push({ key: 'supermajors', text: 'Supermajors shrug off part of the home bonus' });
  } else if (owned(s, 'polymorphism')) {
    out.push({ key: 'supermajors', text: 'Research Supermajors for heavy units' });
  }
  const traits = rival && Array.isArray(rival.traits) ? rival.traits : [];
  const wish = [];
  if (traits.includes('acid_volley')) wish.push('formic_acid');
  if (kind === 'assault') wish.push('siege_tactics', 'propaganda_pheromones');
  wish.push('formic_acid', 'war_chemistry');
  const next = wish.find((id) => hasOwn(RESEARCH, id) && !owned(s, id));
  if (next) out.push({ key: 'research', text: `Research ${RESEARCH[next].name}` });
  const ar = TACTICAL.alarm_rally;
  out.push({ key: 'rally', text: `Alarm Rally in battle: +${Math.round((ar.atk - 1) * 100)}% attack for ${ar.sec} s` });
  if (rival) out.push({ key: 'mating_flight', text: 'Strike during a rival mating flight (summer): their AP drops' });
  return out;
}

/**
 * Preview of a war action with live odds and loot (DESIGN §9.4, §9.5, §25.6 rule 8).
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {'raid'|'assault'|'hunt'|'termite'|'tournament'} kind
 * @param {number} targetUid rival uid (raid, assault, tournament) or source uid (hunt, termite)
 * @param {{ soldier?: number, supermajor?: number, minor?: number }} army
 * @returns {Object} Preview (ARCHITECTURE §8.4)
 */
export function previewAction(s, d, kind, targetUid, army) {
  const res = { ok: false, reason: null, win: 0, youAP: 0, foeAP: 0, lossesLo: 0, lossesHi: 0, survivors: { soldier: 0, supermajor: 0 },
    loot: { food: 0, chitin: 0, insight: 0, minors: 0 }, marchSec: 0, raise: [] };
  const a = army && typeof army === 'object' ? army : {};
  const so = clampNum(num(a.soldier));
  const su = clampNum(num(a.supermajor));
  const mi = clampNum(num(a.minor));
  if (kind === TOURNEY) return previewTournament(s, d, targetUid, { minor: mi, soldier: so, supermajor: su }, res);
  const target = { type: kind === 'raid' || kind === 'assault' ? 'rival' : 'source', uid: targetUid };
  res.reason = partyReason(s, d, kind, target, a.soldier, a.supermajor);
  res.ok = res.reason === null;
  const chk = PARTY_KINDS.includes(kind) ? checkTarget(s, d, kind, target) : { reason: 'invalid' };
  if (!chk.rival && !chk.src) return res;
  const you = { militia: 0, soldier: so, supermajor: su };
  let foe;
  let reward = null;
  let homeShown = 1;
  if (chk.rival) {
    const r = chk.rival;
    const engaged = r.n * ACTIONS[kind].engage;
    homeShown = kind === 'assault' ? effectiveHome(s, d, r, you) : ACTIONS[kind].home;
    foe = bakeFoe(s, d, r, engaged, { home: homeShown, yourCount: so + su, assault: kind === 'assault' });
    if (kind === 'raid') {
      reward = { foodSec: REWARDS.raidFoodSec * Math.sqrt(r.tier), foodMin: REWARDS.raidFoodMinPerTier * r.tier,
        chitin: REWARDS.chitinPerKillTier * r.tier * engaged };
    } else {
      const m = conquestMult(s);
      const oneShot = num(d && d.stats && d.stats.insight && d.stats.insight.oneShot, 1);
      reward = { foodSec: REWARDS.conquestFoodSec * Math.sqrt(r.tier) * m, chitin: REWARDS.chitinPerKillTier * r.tier * engaged * m,
        insight: REWARDS.conquestInsightPerTier * r.tier * oneShot * m,
        minors: REWARDS.capturedPerTier2 * r.tier * r.tier * m + (r.traits.includes('brood_raiders') ? TRAITS.brood_raiders.returnMult * num(r.stolen) : 0) };
    }
  } else {
    foe = neutralFoe(neutralAP(chk.src));
    reward = huntReward(d, chk.src);
  }
  const rs = s.meta.settings.retreatAt;
  const pv = combat.preview(s, d, you, foe, { reward, retreatAt: Number.isFinite(rs) ? rs : 1 });
  res.win = pv.win;
  res.youAP = combat.armyAP(s, d, you);
  res.foeAP = combat.foeAP(foe);
  res.lossesLo = pv.lossesLo;
  res.lossesHi = pv.lossesHi;
  res.survivors = { soldier: pv.survivors.soldier, supermajor: pv.survivors.supermajor };
  res.loot = pv.loot;
  const origin = nearestEntrance(s, chk.hex);
  res.marchSec = marchSec(marchPath(s, d, origin, chk.hex));
  res.raise = raiseHints(s, d, kind, chk.rival || null, res.youAP, res.foeAP, res.win);
  return res;
}

// ------------------------------------------------------------------------------------------------------------------
// Tournaments (STRETCH, DESIGN §9.7)
// ------------------------------------------------------------------------------------------------------------------

/** Your tournament display: Σ committed × size. */
function yourDisplay(a) {
  const z = ACTIONS.tournament.size;
  return num(a.militia, num(a.minor)) * z.minor + num(a.soldier) * z.soldier + num(a.supermajor) * z.supermajor;
}

/** Rival tournament display: rivalPer × soldiers × (1 + tierStep × (tier − 1)). */
function rivalDisplay(r) {
  const T = ACTIONS.tournament;
  return T.rivalPer * num(r.n) * (1 + T.tierStep * (num(r.tier, 1) - 1));
}

/** Win ratio: 1.5 (1.4 with ach_ritualist) − tourney step × pacifist reward tier. */
function tournamentWinRatio(s, d) {
  const base = ach(s, 'ach_ritualist') ? ACH_FX.ach_ritualist.win : ACTIONS.tournament.win;
  const tier = num(d && d.meta && d.meta.hardship && d.meta.hardship.pacifist);
  const step = hasOwn(HARDSHIPS, 'pacifist') && HARDSHIPS.pacifist.fx ? num(HARDSHIPS.pacifist.fx.tourney) : 0;
  return Math.max(1, base - step * tier);
}

/** Minors not working and not committed: adults.minor − Σ jobs − militia. */
function idleMinors(s) {
  const col = s.run.colony;
  let jobs = 0;
  for (const k of Object.keys(col.jobs)) jobs += num(col.jobs[k]);
  return clampNum(num(col.adults.minor) - jobs - num(col.militia));
}

/** Reason a tournament cannot start (null = fine). */
function tournamentReason(s, d, rivalUid, hex, minor, soldier, supermajor) {
  if (!owned(s, 'ritual_tournaments')) return 'locked';
  const r = aliveRival(s, rivalUid);
  if (!r) return 'notFound';
  if (!r.sighted) return 'blocked:unsighted';
  if (num(r.tourCd) > 0) return 'cooldown';
  if (num(r.truce) > 0) return 'blocked:truce';
  if (!isHex(hex) || hex === r.hex) return 'invalid:hex';
  if (!rivalLand(s, r).includes(hex)) return 'invalid:hex';
  const own = ownedMask(s, d);
  if (!neighbors(hex).some((n) => own[n])) return 'invalid:hex';
  const mi = count(minor);
  const so = count(soldier);
  const su = count(supermajor);
  if (mi === null || so === null || su === null || !(mi + so + su > 0)) return 'invalid';
  if (s.run.war.battles.some((b) => b.kind === TOURNEY && (b.rival === r.uid || b.hex === hex))) return 'busy';
  // C101: minors come from idle workers first, then from foragers (they return to foraging afterwards)
  if (mi > idleMinors(s) + num(s.run.colony.jobs.forager) + 1e-9) return 'requirements:idle';
  const g = garrison(s, d);
  if (so > g.soldier + 1e-9 || su > g.supermajor + 1e-9) return 'requirements:garrison';
  return null;
}

/** Tournament preview: win from the display ratio (linear between the withdraw and win ratios). */
function previewTournament(s, d, rivalUid, a, res) {
  const r = aliveRival(s, rivalUid);
  res.reason = r ? null : 'notFound';
  if (!r) return res;
  if (!owned(s, 'ritual_tournaments')) res.reason = 'locked';
  else if (num(r.tourCd) > 0) res.reason = 'cooldown';
  else if (num(r.truce) > 0) res.reason = 'blocked:truce';
  else if (!(a.minor + a.soldier + a.supermajor > 0)) res.reason = 'invalid';
  res.ok = res.reason === null;
  const mine = yourDisplay({ militia: a.minor, soldier: a.soldier, supermajor: a.supermajor });
  const theirs = rivalDisplay(r);
  const win = tournamentWinRatio(s, d);
  const loseAt = 1 / ACTIONS.tournament.win;
  const ratio = theirs > 0 ? mine / theirs : mine > 0 ? CLAMP_MAX : 0;
  res.youAP = mine;
  res.foeAP = theirs;
  res.win = ratio >= win ? 1 : ratio <= loseAt ? 0 : (ratio - loseAt) / (win - loseAt);
  res.survivors = { soldier: a.soldier, supermajor: a.supermajor };
  if (res.win < 1) {
    const need = Math.ceil(Math.max(0, theirs * win - mine) / ACTIONS.tournament.size.soldier);
    if (need > 0) res.raise.push({ key: 'soldiers', text: `About ${need} more soldiers to win outright` });
  }
  return res;
}

/** End a tournament record (withdraw or flip) and emit tournamentEnd. */
function endTournament(s, d, b, env, result) {
  const war = s.run.war;
  if (b.mob) combat.releaseMobilized(s, b); // C101: drafted foragers go back to foraging
  const idx = war.battles.indexOf(b);
  if (idx >= 0) war.battles.splice(idx, 1);
  combat.recomputeMilitia(s);
  if (result === 'win') {
    const r = rivalByUid(s, b.rival);
    surface.grantHex(s, d, b.hex);
    if (r) {
      if (!r.lost.includes(b.hex)) r.lost.push(b.hex);
      r.n = clampNum(r.n - r.n * ACTIONS.tournament.flipLoss);
    }
    s.meta.counters.tournamentsWon++;
    surface.touch(s);
  }
  if (env) env.emit('tournamentEnd', { uid: b.uid, rival: b.rival, hex: b.hex, result, ratio: b.odds });
}

/** Advance tournaments: resolve after the display, default to withdraw after the choice window. */
function tickTournaments(s, d, dt, env) {
  const T = ACTIONS.tournament;
  const list = s.run.war.battles;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (b.kind !== TOURNEY) continue;
    b.t += dt;
    const r = aliveRival(s, b.rival);
    if (!r) {
      endTournament(s, d, b, env, 'withdraw');
      continue;
    }
    if (!(b.odds > 0) && b.t >= T.sec) {
      const theirs = rivalDisplay(r);
      const mine = yourDisplay(b.you);
      const ratio = theirs > 0 ? mine / theirs : CLAMP_MAX;
      b.odds = clampNum(ratio);
      b.foe.n = clampNum(theirs);
      if (ratio >= tournamentWinRatio(s, d)) endTournament(s, d, b, env, 'win');
      else if (ratio <= 1 / T.win) endTournament(s, d, b, env, 'withdraw');
    } else if (b.odds > 0 && b.t >= T.sec + T.choiceSec) {
      endTournament(s, d, b, env, 'withdraw');
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Conquest
// ------------------------------------------------------------------------------------------------------------------

/** Hex for the harvester stash inside conquered land (not the nest hex, no source, passable terrain). */
function stashHex(s, land, nestHex) {
  const S = s.run.surface;
  const busy = new Set(S.sources.map((x) => x.hex));
  let pool = land.filter((h) => h !== nestHex && !busy.has(h) && S.terrain[h] !== STONE && S.terrain[h] !== PUDDLE);
  if (!pool.length) pool = land.filter((h) => !busy.has(h));
  if (!pool.length) return -1;
  return pool[randInt(s, 0, pool.length - 1)];
}

/** Conquest spoils and map changes for one fallen rival (hexes, outpost, stash, insight/food/minors, counters, event). */
function secure(s, d, r, env) {
  const land = rivalLand(s, r);
  surface.conquerHexes(s, d, land);
  surface.addEntrance(s, d, 'outpost', r.hex, -1, r.uid);
  const sh = stashHex(s, land, r.hex);
  if (sh >= 0) surface.spawnSource(s, d, 'harvester_stash', sh, { env });
  const m = conquestMult(s);
  const oneShot = num(d && d.stats && d.stats.insight && d.stats.insight.oneShot, 1);
  let minors = REWARDS.capturedPerTier2 * r.tier * r.tier * m;
  if (r.traits.includes('brood_raiders')) minors += TRAITS.brood_raiders.returnMult * num(r.stolen);
  combat.grantReward(s, d, { foodSec: REWARDS.conquestFoodSec * Math.sqrt(r.tier) * m,
    insight: REWARDS.conquestInsightPerTier * r.tier * oneShot * m, minors }, env);
  r.stolen = 0;
  const RV = s.run.rivals;
  if (!isBoss(r)) {
    RV.topTier = Math.max(num(RV.topTier), r.tier);
    RV.respawn.push({ in: randRange(s, SPAWN.respawnSec[0], SPAWN.respawnSec[1]), tier: RV.topTier + 1 });
  }
  s.meta.counters.conquests++;
  s.run.stats.conquests++;
  surface.touch(s);
  if (env) env.emit('conquest', { uid: r.uid, rivalType: r.type, tier: r.tier });
}

/** A rival nest falls to an assault (DESIGN §9.4): kill chitin now, spoils now or when the whole Front has fallen. */
function conquer(s, d, r, kills, env) {
  r.alive = false;
  r.n = 0;
  r.fallenAt = num(s.run.time);
  const m = conquestMult(s);
  combat.grantReward(s, d, { chitin: REWARDS.chitinPerKillTier * r.tier * kills * m }, env);
  if (r.type === 'great_rival' && r.group) {
    const group = s.run.rivals.list.filter((x) => x.type === r.type && x.group === r.group);
    surface.touch(s);
    if (group.every((x) => !x.alive)) for (const x of group) secure(s, d, x, env);
    return;
  }
  secure(s, d, r, env);
}

/** C77: the fields a conquered non-boss rival keeps. */
const FALLEN_KEEP = Object.freeze(['uid', 'type', 'tier', 'hex', 'alive', 'sighted', 'fallenAt', 'n']);

/**
 * C77: compact every conquered non-boss rival to FALLEN_KEEP (n = 0) and keep at most FALLEN_RIVALS.keep of them,
 * dropping the oldest (lowest fallenAt, then uid). In place: the list keeps its identity.
 */
function compactFallen(s) {
  const list = s.run.rivals.list;
  let fallen = 0;
  for (const r of list) {
    if (!r || r.alive || isBoss(r)) continue;
    fallen++;
    if (Object.keys(r).length === FALLEN_KEEP.length) continue;
    for (const k of Object.keys(r)) if (!FALLEN_KEEP.includes(k)) delete r[k];
    r.n = 0;
  }
  const keep = Math.max(0, Math.floor(num(FALLEN_RIVALS.keep)));
  if (fallen <= keep) return;
  const old = list.filter((r) => r && !r.alive && !isBoss(r))
    .sort((a, b) => num(a.fallenAt) - num(b.fallenAt) || num(a.uid) - num(b.uid))
    .slice(0, fallen - keep);
  const drop = new Set(old);
  for (let i = list.length - 1; i >= 0; i--) if (drop.has(list[i])) list.splice(i, 1);
}

/** Argentine Front window: pending fallen nests regrow after windowSec (online); the window pauses offline. */
function frontWindow(s, dt, online) {
  const gr = BOSSES.great_rival;
  const list = s.run.rivals.list;
  const groups = new Set();
  for (const r of list) if (r.type === gr.id && r.group) groups.add(r.group);
  for (const g of groups) {
    const members = list.filter((r) => r.type === gr.id && r.group === g);
    const fallen = members.filter((r) => !r.alive);
    if (fallen.length === 0 || fallen.length === members.length) continue;
    if (!online) {
      for (const r of fallen) r.fallenAt += dt;
      continue;
    }
    const first = Math.min(...fallen.map((r) => r.fallenAt));
    if (num(s.run.time) - first >= gr.windowSec) {
      for (const r of fallen) {
        r.alive = true;
        r.n = r.base;
        r.fallenAt = -1;
      }
      surface.touch(s);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Parties on the map
// ------------------------------------------------------------------------------------------------------------------

/** Join a running battle with a party's units; the party merges into the battle (and into its attack party). */
function joinBattle(s, b, p) {
  b.you.soldier = clampNum(b.you.soldier + p.soldier);
  b.you.supermajor = clampNum(b.you.supermajor + p.supermajor);
  const main = partyByUid(s, b.party);
  if (main && main !== p) {
    main.soldier = clampNum(main.soldier + p.soldier);
    main.supermajor = clampNum(main.supermajor + p.supermajor);
  }
  const war = s.run.war;
  war.parties.splice(war.parties.indexOf(p), 1);
}

/** A party reached the end of its path; returns true if it was removed from the list. */
function arrive(s, d, p, env) {
  const war = s.run.war;
  if (p.kind === 'reinforce') {
    const b = battleByUid(s, p.target.uid);
    if (!b || b.kind === TOURNEY) {
      p.state = 'home';
      return false;
    }
    joinBattle(s, b, p);
    return true;
  }
  if (p.kind === 'guard') {
    const raid = war.raids.find((x) => x.uid === p.target.uid);
    if (!raid || raid.phase === 'done') {
      p.state = 'home';
      return false;
    }
    const b = war.battles.find((x) => x.raid === raid.uid && x.kind === 'trail');
    if (b) {
      joinBattle(s, b, p);
      return true;
    }
    return false;
  }
  const army = { militia: 0, soldier: p.soldier, supermajor: p.supermajor };
  if (p.kind === 'raid' || p.kind === 'assault') {
    const r = aliveRival(s, p.target.uid);
    if (!r || (p.kind === 'assault' && immune(s, d, r))) {
      p.state = 'home';
      return false;
    }
    const engaged = r.n * ACTIONS[p.kind].engage;
    const home = p.kind === 'assault' ? effectiveHome(s, d, r, army) : ACTIONS[p.kind].home;
    const foe = bakeFoe(s, d, r, engaged, { home, yourCount: p.soldier + p.supermajor, assault: p.kind === 'assault' });
    combat.startBattle(s, d, { kind: p.kind, hex: r.hex, you: army, foe, homeMult: home, party: p.uid, rival: r.uid }, env);
    p.state = 'fighting';
    return false;
  }
  const src = sourceByUid(s, p.target.uid);
  const valid = src && (p.kind === 'hunt' ? isPrey(src) : src.type === 'termite_mound' && !(num(src.cd) > 0));
  if (!valid) {
    p.state = 'home';
    return false;
  }
  combat.startBattle(s, d, { kind: p.kind, hex: src.hex, you: army, foe: neutralFoe(neutralAP(src)), homeMult: 1, party: p.uid,
    reward: huntReward(d, src) }, env);
  p.state = 'fighting';
  return false;
}

/** March parties: out → arrival; home → back at pos 0 (units return to the garrison). Frozen offline. */
function moveParties(s, d, dt, env) {
  const list = s.run.war.parties;
  const step = dt / BATTLE.marchSecPerHex;
  let i = 0;
  while (i < list.length) {
    const p = list[i];
    const last = Math.max(0, p.path.length - 1);
    if (p.state === 'out') {
      if (p.pos < last) p.pos = Math.min(last, p.pos + step);
      if (p.pos >= last && arrive(s, d, p, env)) continue;
    } else if (p.state === 'home') {
      p.pos = clampNum(p.pos - step);
      if (p.pos <= 0) {
        list.splice(i, 1);
        continue;
      }
    }
    i++;
  }
}

/** Kind-specific consequences of finished battles (scans this tick's battleEnd events). */
function resolveEnded(s, d, env) {
  if (!env || !Array.isArray(env.events)) return;
  for (const e of env.events) {
    if (e.type !== 'battleEnd' || e.raid) continue;
    const party = partyByUid(s, e.party);
    const r = rivalByUid(s, e.rival);
    const kills = num(e.kills);
    if (e.kind === 'raid' && r) {
      r.n = clampNum(r.n - kills);
      if (e.win) {
        combat.grantReward(s, d, { foodSec: REWARDS.raidFoodSec * Math.sqrt(r.tier), foodMin: REWARDS.raidFoodMinPerTier * r.tier,
          chitin: REWARDS.chitinPerKillTier * r.tier * kills }, env);
      }
    } else if (e.kind === 'assault' && r) {
      if (owned(s, 'propaganda_pheromones')) {
        const conv = RESEARCH.propaganda_pheromones.fx.convert * kills;
        if (conv > 0) population.addAdults(s, d, 'minor', conv, { capped: true });
      }
      if (e.win && r.alive) conquer(s, d, r, kills, env);
      else r.n = clampNum(r.n - kills);
    } else if (e.kind === 'escalate' && r) {
      r.n = clampNum(r.n - kills);
    } else if ((e.kind === 'hunt' || e.kind === 'termite') && e.win && party) {
      const src = sourceByUid(s, party.target.uid);
      if (src && e.kind === 'hunt') {
        src.stock = 0;
        surface.removeSource(s, d, src.uid, 'hunted', env);
      } else if (src) {
        src.cd = ACTIONS.termite.cdSec;
      }
    }
    if (party) {
      party.soldier = clampNum(num(e.survivors && e.survivors.soldier));
      party.supermajor = clampNum(num(e.survivors && e.survivors.supermajor));
      if (party.soldier + party.supermajor > BATTLE.endEps) party.state = 'home';
      else s.run.war.parties.splice(s.run.war.parties.indexOf(party), 1);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Tick and derived cache
// ------------------------------------------------------------------------------------------------------------------

/** Fire-ant creep: add the nearest unowned, non-rival, passable hex adjacent to the rival's land to `extra`. */
function creep(s, d, r) {
  const land = rivalLand(s, r);
  const inLand = new Set(land);
  const limit = countInRadius(mapRadius(s));
  const own = playerMask(s, d);   // C95: creep never takes a player-held hex
  const others = new Set();
  for (const x of s.run.rivals.list) if (x.alive && x !== r) for (const h of rivalLand(s, x)) others.add(h);
  const entr = new Set(s.run.surface.entrances.map((e) => e && e.hex));
  let best = -1;
  let bestD = Infinity;
  for (const h of land) {
    for (const n of neighbors(h)) {
      if (n >= limit || inLand.has(n) || own[n] || others.has(n) || entr.has(n) || r.lost.includes(n)) continue;
      if (s.run.surface.terrain[n] === STONE) continue;
      const dd = hexDist(n, r.hex);
      if (dd < bestD || (dd === bestD && n < best)) {
        bestD = dd;
        best = n;
      }
    }
  }
  if (best >= 0) {
    r.extra.push(best);
    surface.touch(s);
  }
}

/** Danger overlay: border hexes, hexes of raidable trails near rival land, incoming raid fight hexes. */
function dangerHexes(s, d) {
  const mark = new Uint8Array(HEX.count);
  const border = d.surface && d.surface.border;
  if (border && border.length === HEX.count) for (let i = 0; i < HEX.count; i++) if (border[i]) mark[i] = 1;
  const trails = s.run.surface.trails;
  const dTrails = (d.surface && Array.isArray(d.surface.trails)) ? d.surface.trails : [];
  const own = ownedMask(s, d);
  const alive = s.run.rivals.list.filter((r) => r.alive);
  if (alive.length && trails.length) {
    const near = new Uint8Array(HEX.count);
    for (const r of alive) {
      const m = nearMask(s, r, RAIDS.trailRadius);
      for (let i = 0; i < HEX.count; i++) if (m[i]) near[i] = 1;
    }
    for (const t of trails) {
      if (!t || !Array.isArray(t.path)) continue;
      const dtr = dTrails.find((x) => x && x.uid === t.uid);
      const safe = dtr ? !!dtr.safe : t.path.every((h) => own[h]);
      if (safe) continue;
      for (const h of t.path) if (isHex(h) && near[h]) mark[h] = 1;
    }
  }
  for (const raid of s.run.war.raids) {
    if (raid.target && raid.target.type === 'nest') mark[0] = 1;
  }
  const out = [];
  for (let i = 0; i < HEX.count; i++) if (mark[i]) out.push(i);
  return out;
}

/**
 * Fill d.combat (garrison, AP, home bonus, escort AP, rival AP, danger hexes). The danger overlay is rebuilt only when
 * the surface revision, the alive rival count or the nest-raid flag changed (cache key in d.combat._dangerKey, never
 * saved), and not during offline simulation (it is presentation only).
 */
function fillDerived(s, d, online) {
  const C = d.combat;
  if (!C) return;
  const g = garrison(s, d);
  const homeMult = homeMultOf(s, d);
  C.garrison = g;
  C.homeMult = homeMult;
  C.garrisonAP = combat.armyAP(s, d, { militia: 0, soldier: g.soldier, supermajor: g.supermajor }, { homeMult });
  const esc = {};
  const phal = owned(s, 'phalanx') ? RESEARCH.phalanx.fx.escortAP : 1;
  for (const t of s.run.surface.trails) {
    if (t && num(t.escorts) > 0) esc[t.uid] = combat.armyAP(s, d, { soldier: t.escorts }) * phal;
  }
  C.escortAP = esc;
  const rap = {};
  for (const r of s.run.rivals.list) if (r.alive) rap[r.uid] = combat.rivalAP(s, d, r);
  C.rivalAP = rap;
  if (!online && Array.isArray(C.danger)) return;
  let alive = 0;
  for (const r of s.run.rivals.list) if (r.alive) alive++;
  const nestRaid = s.run.war.raids.some((x) => x.target && x.target.type === 'nest');
  const key = `${s.run.surface.rev}:${alive}:${nestRaid ? 1 : 0}:${s.run.surface.trails.length}:${num(d.surface && d.surface.rev)}`;
  if (C._dangerKey !== key || !Array.isArray(C.danger)) {
    C.danger = dangerHexes(s, d);
    C._dangerKey = key;
  }
}

/**
 * Per tick: bosses and extra rivals; sighting; growth, creep and timers (online, not in winter); respawns; source
 * cooldowns; the Front window; parties; tournaments; battles (combat.stepBattles); battle consequences; field triage
 * returns; militia recount; d.combat.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {number} dt
 * @param {import('../core/types.js').Env} env
 * @returns {void}
 */
export function tick(s, d, dt, env) {
  const run = s.run;
  if (!run || !run.rivals || !run.war) return;
  const online = !(env && env.offline);
  const live = online && dt > 0;
  spawnBosses(s, d);
  fillRivals(s, d);
  const winter = isWinter(d);
  for (const r of run.rivals.list) {
    if (!r.alive) continue;
    if (online && !r.sighted && run.surface.revealed[r.hex] === 1) {   // deferred to an online tick so the event is seen
      r.sighted = true;
      if (env) env.emit('rivalSighted', { uid: r.uid, rivalType: r.type });
    }
    if (!live) continue;
    r.truce = clampNum(r.truce - dt);
    r.bribeCd = clampNum(r.bribeCd - dt);
    r.tourCd = clampNum(r.tourCd - dt);
    if (winter) continue;
    if (!isBoss(r)) {
      const rate = d.season && d.season.id === 'summer' ? GROWTH.perMinSummer : GROWTH.perMin;
      const cap = r.base * GROWTH.maxMult;
      if (r.n < cap) r.n = Math.min(cap, r.n + (r.base * rate / 60) * dt);
    }
    if (r.traits.includes('border_creep')) {
      r.creepIn -= dt;
      if (r.creepIn <= 0) {
        r.creepIn = TERRITORY.creepSec;
        creep(s, d, r);
      }
    }
  }
  if (live) {
    const RV = run.rivals;
    for (let i = RV.respawn.length - 1; i >= 0; i--) {
      const e = RV.respawn[i];
      e.in = clampNum(e.in - dt);
      if (e.in > 0) continue;
      const R = mapRadius(s);
      const tier = Math.max(1, Math.floor(num(e.tier, 1)));
      const type = tier >= ELDER.fromTier ? ELDER.id : RIVAL_ORDER[tier - 1];
      const landR = hasOwn(RIVALS, type) ? RIVALS[type].radius : ELDER.radius;
      const hex = chooseSpawnHex(s, d, { ringMin: R - SPAWN.outerBand + 1, ringMax: R, landR, preferLog: hasOwn(RIVALS, type) && !!RIVALS[type].log });
      if (hex < 0) {
        e.in = SPAWN.retrySec;   // C95: no hex clear of the player's land yet: look again later
        continue;
      }
      RV.respawn.splice(i, 1);
      createRival(s, { tier, hex });
    }
    for (const src of run.surface.sources) if (num(src.cd) > 0) src.cd = clampNum(src.cd - dt);
    moveParties(s, d, dt, env);
    tickTournaments(s, d, dt, env);
  }
  frontWindow(s, dt, online);
  combat.stepBattles(s, d, dt, env);
  resolveEnded(s, d, env);
  if (dt > 0) {
    const tri = run.war.triage;
    for (let i = tri.length - 1; i >= 0; i--) {
      tri[i].t -= dt;
      if (tri[i].t > 0) continue;
      const e = tri.splice(i, 1)[0];
      if (e.soldier > 0) population.addAdults(s, d, 'soldier', e.soldier);
      if (e.supermajor > 0) population.addAdults(s, d, 'supermajor', e.supermajor);
    }
  }
  combat.recomputeMilitia(s);
  compactFallen(s);
  fillDerived(s, d, online);
}

/**
 * Army ant column and other event battles (WP6): start a battle from a BattleSpec.
 * @param {import('../core/types.js').State} s
 * @param {import('../core/types.js').Derived} d
 * @param {import('../core/types.js').BattleSpec} spec
 * @param {import('../core/types.js').Env} env
 * @returns {number} battle uid
 */
export function startEventBattle(s, d, spec, env) {
  return combat.startBattle(s, d, spec, env);
}

// ------------------------------------------------------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------------------------------------------------------

/** Battle by uid that is a real fight (not a tournament), or null. */
function fight(s, uid) {
  const b = battleByUid(s, uid);
  return b && b.kind !== TOURNEY ? b : null;
}

/** Alarm Rally cost (× ach_flawless). */
function rallyCost(s) {
  return scaleCost(TACTICAL.alarm_rally.cost, ach(s, 'ach_flawless') ? ACH_FX.ach_flawless.rallyCost : 1);
}

/** Minors that join a Mobilize: frac × (idle + foragers). */
function mobilizeCount(s) {
  return TACTICAL.mobilize.frac * (idleMinors(s) + num(s.run.colony.jobs.forager));
}

/** Kinds of fight Mobilize may join (your border or nest). */
const MOBILIZE_KINDS = Object.freeze(['border', 'gate', 'army']);

/** @type {Record<string, import('../core/types.js').Handler>} */
export const handlers = {
  /** launchParty { kind, target, soldier, supermajor } — kind raid/assault (rival) or hunt/termite (source). */
  launchParty: {
    validate(s, d, cmd) {
      return partyReason(s, d, cmd.kind, cmd.target, cmd.soldier, cmd.supermajor);
    },
    apply(s, d, cmd, env) {
      const chk = checkTarget(s, d, cmd.kind, cmd.target);
      const origin = nearestEntrance(s, chk.hex);
      makeParty(s, cmd.kind, cleanTarget(cmd.target), count(cmd.soldier), count(cmd.supermajor), marchPath(s, d, origin, chk.hex));
    },
  },

  /** recallParty { uid } — a marching party turns home. */
  recallParty: {
    validate(s, d, cmd) {
      const p = partyByUid(s, cmd.uid);
      if (!p) return 'notFound';
      if (p.state === 'fighting') return 'busy';
      if (p.state !== 'out') return 'invalid';
      return null;
    },
    apply(s, d, cmd) {
      partyByUid(s, cmd.uid).state = 'home';
    },
  },

  /** reinforce { battle, soldier, supermajor } — send garrison units; they join on arrival. */
  reinforce: {
    validate(s, d, cmd) {
      const b = fight(s, cmd.battle);
      if (!b) return 'notFound';
      const so = count(cmd.soldier);
      const su = count(cmd.supermajor);
      if (so === null || su === null || !(so + su > 0)) return 'invalid';
      const g = garrison(s, d);
      if (so > g.soldier + 1e-9 || su > g.supermajor + 1e-9) return 'requirements:garrison';
      return null;
    },
    apply(s, d, cmd) {
      const b = fight(s, cmd.battle);
      const to = b.below || !isHex(b.hex) ? 0 : b.hex;
      const origin = b.below || !isHex(b.hex) ? 0 : nearestEntrance(s, to);
      makeParty(s, 'reinforce', { type: 'battle', uid: b.uid }, count(cmd.soldier), count(cmd.supermajor), marchPath(s, d, origin, to));
    },
  },

  /** battleAction { battle, action } — 'alarm_rally', 'mobilize' (border/nest fights), 'retreat'. */
  battleAction: {
    validate(s, d, cmd) {
      const b = fight(s, cmd.battle);
      if (!b) return 'notFound';
      if (cmd.action === 'alarm_rally') {
        if (hasEffect(s, combat.RALLY_CD_ID)) return 'cooldown';
        if (!canAfford(s, rallyCost(s))) return 'cantAfford';
        return null;
      }
      if (cmd.action === 'mobilize') {
        if (!MOBILIZE_KINDS.includes(b.kind)) return 'invalid:kind';
        if (hasEffect(s, combat.MOBILIZE_PREFIX + b.uid)) return 'busy';
        if (!(mobilizeCount(s) > 0)) return 'requirements';
        if (!canAfford(s, TACTICAL.mobilize.cost)) return 'cantAfford';
        return null;
      }
      if (cmd.action === 'retreat') return null;
      return 'invalid';
    },
    apply(s, d, cmd, env) {
      const b = fight(s, cmd.battle);
      if (cmd.action === 'alarm_rally') {
        if (!spend(s, rallyCost(s))) return;
        b.rally = TACTICAL.alarm_rally.sec;
        addEffect(s, { id: combat.RALLY_CD_ID, stat: 'cooldown', t: TACTICAL.alarm_rally.cd, reset: true });
      } else if (cmd.action === 'mobilize') {
        // C73: frac of the idle minors and frac of the foragers (DESIGN §9.8); the foragers are taken out of their job
        // explicitly (never a proportional cut of every job) and recorded so the survivors return to foraging.
        const col = s.run.colony;
        const fromIdle = TACTICAL.mobilize.frac * idleMinors(s);
        const fromForager = TACTICAL.mobilize.frac * num(col.jobs.forager);
        if (!spend(s, TACTICAL.mobilize.cost)) return;
        col.jobs.forager = clampNum(num(col.jobs.forager) - fromForager);
        b.you.militia = clampNum(b.you.militia + fromIdle + fromForager);
        const mob = b.mob && typeof b.mob === 'object' ? b.mob : { n: 0, forager: 0 };
        b.mob = { n: clampNum(num(mob.n) + fromIdle + fromForager), forager: clampNum(num(mob.forager) + fromForager) };
        addEffect(s, { id: combat.MOBILIZE_PREFIX + b.uid, stat: 'mobilize', scope: b.uid, t: TACTICAL.mobilize.sec, reset: true });
        combat.recomputeMilitia(s);
      } else {
        combat.endBattle(s, d, b, env, 'retreat');
      }
    },
  },

  /** bribe { rival } — 2 × rival AP honeydew: truce 300 s, cooldown 600 s. */
  bribe: {
    validate(s, d, cmd) {
      const r = aliveRival(s, cmd.rival);
      if (!r) return 'notFound';
      if (!r.sighted) return 'blocked:unsighted';
      if (num(r.bribeCd) > 0) return 'cooldown';
      const c = bribeCost(s, d, r);
      if (!c) return 'max';
      if (!canAfford(s, c)) return 'cantAfford';
      return null;
    },
    apply(s, d, cmd, env) {
      const r = aliveRival(s, cmd.rival);
      if (!spend(s, bribeCost(s, d, r))) return;
      r.truce = ACTIONS.bribe.truceSec;
      r.bribeCd = ACTIONS.bribe.cdSec;
      const raids = s.run.war.raids;
      for (let i = raids.length - 1; i >= 0; i--) {
        const raid = raids[i];
        if (raid.rival !== r.uid || raid.phase !== 'warning') continue;
        raids.splice(i, 1);
        r.n = clampNum(r.n + raid.raiders);
        for (const p of s.run.war.parties) if (p.kind === 'guard' && p.target.uid === raid.uid) p.state = 'home';
        env.emit('raidResult', { uid: raid.uid, win: true, foodLost: 0, broodLost: 0, workersLost: 0, target: raid.target, rival: r.uid });
      }
    },
  },

  /** tournament { rival, hex, minor, soldier, supermajor } (STRETCH) — a 20 s display contest on a rival border hex. */
  tournament: {
    validate(s, d, cmd) {
      return tournamentReason(s, d, cmd.rival, cmd.hex, cmd.minor, cmd.soldier, cmd.supermajor);
    },
    apply(s, d, cmd, env) {
      const r = aliveRival(s, cmd.rival);
      const war = s.run.war;
      const you = { militia: count(cmd.minor), soldier: count(cmd.soldier), supermajor: count(cmd.supermajor) };
      const b = {
        uid: war.nextUid++, kind: TOURNEY, hex: cmd.hex, below: false, party: 0, raid: 0, you,
        foe: { n: 0, atk: 0, hp: 0 }, start: { you: combat.armyCount(you), foe: 0 }, f: { you: 1, foe: 1 }, homeMult: 1,
        acc: 0, t: 0, rally: 0, retreatAt: 1, reward: null, tag: TOURNEY, odds: 0, rival: r.uid, esc: 0,
        lost: { militia: 0, soldier: 0, supermajor: 0 },
      };
      // C101: draft from idle minors first, then foragers; recorded like a Mobilize draft so they go back to foraging
      const col = s.run.colony;
      const fromForager = Math.max(0, Math.min(num(col.jobs.forager), you.militia - idleMinors(s)));
      if (fromForager > 0) col.jobs.forager = clampNum(num(col.jobs.forager) - fromForager);
      if (you.militia > 0) b.mob = { n: you.militia, forager: fromForager };
      war.battles.push(b);
      r.tourCd = ACTIONS.tournament.cdSec;
      combat.recomputeMilitia(s);
      env.emit('tournamentStart', { uid: b.uid, rival: r.uid, hex: b.hex });
    },
  },

  /** tournamentChoice { uid, choice } — 'escalate' (raid-sized battle, 25 % of defenders, no home bonus) or 'withdraw'. */
  tournamentChoice: {
    validate(s, d, cmd) {
      const b = battleByUid(s, cmd.uid);
      if (!b || b.kind !== TOURNEY) return 'notFound';
      if (!(b.odds > 0)) return 'busy';
      if (cmd.choice !== 'escalate' && cmd.choice !== 'withdraw') return 'invalid';
      if (cmd.choice === 'escalate' && !aliveRival(s, b.rival)) return 'notFound';
      return null;
    },
    apply(s, d, cmd, env) {
      const b = battleByUid(s, cmd.uid);
      if (cmd.choice === 'withdraw') {
        endTournament(s, d, b, env, 'withdraw');
        return;
      }
      const r = aliveRival(s, b.rival);
      const war = s.run.war;
      war.battles.splice(war.battles.indexOf(b), 1);
      const you = { militia: b.you.militia, soldier: b.you.soldier, supermajor: b.you.supermajor };
      const foe = bakeFoe(s, d, r, r.n * ACTIONS.tournament.escalateEngage, { yourCount: combat.armyCount(you) });
      env.emit('tournamentEnd', { uid: b.uid, rival: r.uid, hex: b.hex, result: 'escalate', ratio: b.odds });
      const nuid = combat.startBattle(s, d, { kind: 'escalate', hex: b.hex, you, foe, homeMult: 1, rival: r.uid }, env);
      const nb = war.battles.find((x) => x.uid === nuid);
      if (nb && b.mob) nb.mob = b.mob; // the draft follows the escalated fight and returns when it ends (C101)
    },
  },
};

/** Bribe cost: { honeydew: apMult × rival AP } (null above COST_MAX). */
export function bribeCost(s, d, rival) {
  const h = ACTIONS.bribe.apMult * combat.rivalAP(s, d, rival);
  return h <= COST_MAX ? { honeydew: h } : null;
}
