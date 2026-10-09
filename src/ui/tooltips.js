// Hover tooltips for DOM elements ([data-tip] static copy, [data-tip-key] live content) and canvas targets
// (bridge.hover → showTarget), including the "sc" badge details (raw → effective). Copy ≤ 12 words plus numbers.
// Owner: WP9. Contract: ARCHITECTURE §14.6, §13.3 (Target kinds); DESIGN §25.6 rule 4.

import { h, setText, clear } from './dom.js';
import { fmt, fmtRate, fmtCount, fmtTime, fmtMult, fmtPct } from './format.js';
import {
  nameOf, RES_NAMES, RES_TIPS, CHAMBER_TIPS, SEASON_NAMES, SEASON_TIPS, BOTTLENECK_TIPS, unlockHint, unlockLabel, BATTLE_NAMES, PARTY_NAMES,
  reasonText, linkText, TERRAIN_BLOCK_TIPS, plannedWaitText, terrainTipLines,
  sourceTipLines, detourText, FIND_NAMES, FIND_TIPS, honeydewCapText, territoryBenefitLines, trailDistanceLines,
} from './text.js';
import { detourInfo } from '../systems/trails.js';
import { blightStatus, moleCacheReward } from '../systems/events.js';   // C245, C290
import { num, arr, obj } from './reveal.js';
import { ribbonInfo, activeThreats } from './hud.js';
import { getUI } from './uistate.js';
import { oldRidgeImmunity, frontInfo, frontLabel, satellitesFree, satelliteHexWhy, spanText } from './rules.js';
import { cellInfo, chamberLinks, pocketAction, plannedWait, reservedBy, upgradeAffordable, chamberFrost } from '../systems/nest.js';
import { groomText, frostTipLine, housePipLines, pupaTipLines, queenGlowLine, dugByText } from './panels/build.js';
import { ringOf } from '../core/hex.js';
import { TERRAIN_ORDER } from '../data/surface.js';
import { GRID } from '../data/balance.js';
import { SOURCES } from '../data/sources.js';
import { EVENTS } from '../data/events.js';
import { ACTIONS, TRUCE } from '../data/combat.js';
import { topFlowLines } from './resourceStats.js';
import { layBreakdown, layTipLines } from './layParts.js';

const TERRAIN_FALLBACK = ['grass', 'sand', 'leaf_litter', 'garden_path', 'tree_root', 'stone', 'puddle', 'log'];
const OBJECT_TIPS = {
  fruit: 'A fallen fruit: trail to it before it rots.', ladybug: 'Ladybug! Click to shoo it off the aphids.', footstep: 'A shoe shadow: click to scatter!',
  molehill: 'A molehill blocks this hex for a while. Trails detour round it.',
  // C185: clearing works any time while the pit is there (click or right-click), not only from the event card
  antlion: 'Antlion pit: click to send ' + num(EVENTS.ev_antlion_pit && EVENTS.ev_antlion_pit.num.soldiers, 3) + ' garrison soldiers, or reroute the trail.',
  lizard: 'Horned lizard: reroute or mob it.',
  termite_swarm: 'Termite swarm: Mass Recruit for a feast.', golden_aphid: 'Golden aphid! Click within 15 seconds.', rival_alate: 'Rival alate: click to catch it for food.',
  mold: 'Mold: click to scrape it off.', army_column: 'Army ant column crossing your land!', phengaris: 'A caterpillar that smells like brood.',
  myrmecophile: 'A rove beetle guest.', wandering_queen: 'A strange queen at the entrance.',
};

/**
 * Tooltip content for a live key (rail rows, badges, dial …).
 * @param {string} key e.g. 'res:food', 'sc:food', 'pop', 'scale', 'season', 'bottleneck', 'ribbon', 'nutrition'
 * @param {Object} s
 * @param {Object} d
 * @returns {{ title: string, lines: string[] } | null}
 */
export function tipForKey(key, s, d) {
  if (!key || !s || !s.run) return null;
  const [kind, arg] = String(key).split(':');
  const st = obj(d && d.stats);
  const rates = obj(d && d.rates);
  if (kind === 'res' && (arg === 'alates' || arg === 'kinship' || arg === 'genes')) {
    return { title: RES_NAMES[arg], lines: [RES_TIPS[arg] || ''] };
  }
  if (kind === 'res' || kind === 'sc') {
    const r = obj(rates[arg]);
    const lines = [];
    if (kind === 'res') lines.push(RES_TIPS[arg] || '');
    const capKey = { food: 'foodCap', honeydew: 'honeydewCap', pheromone: 'pheromoneCap', fungus: 'fungusCap', leaves: 'leafCap' }[arg];
    const have = num(s.run.res[arg]);
    lines.push('Stored ' + fmt(have) + (capKey && num(st[capKey]) > 0 ? ' / ' + fmt(num(st[capKey])) : ''));
    if (arg === 'food') {
      lines.push('Produced ' + fmtRate(num(r.gross)) + ' · upkeep ' + fmtRate(-num(r.upkeep || st.upkeep)));
      if (num(r.clicks) > 0) lines.push('Clicks ' + fmtRate(num(r.clicks)));
    } else if (kind === 'res') {
      lines.push('Net ' + fmtRate(num(r.net)));
      if (arg === 'chitin') { // C103: where chitin comes from (ledger sources + the moult average)
        const src = obj(r.src);
        const parts = [['trails', 'Trails'], ['midden', 'Midden']].filter(([k]) => num(src[k]) > 0).map(([k, l]) => l + ' ' + fmtRate(num(src[k])));
        if (num(r.molts) > 0.0005) parts.push('Moults ' + fmtRate(num(r.molts)));
        if (parts.length) lines.push(parts.join(' · '));
      }
    }
    if (r.sc || kind === 'sc') lines.push('Softcapped: raw ' + fmtRate(num(r.raw)) + ' → ' + fmtRate(num(r.gross)));
    if (arg === 'food' && capKey && have >= num(st[capKey]) * 0.99 && num(st[capKey]) > 0) lines.push('Storage full: production is wasted.');
    if (kind === 'res' && arg === 'honeydew') lines.push(honeydewCapText());   // C210
    if (kind === 'res') lines.push(...topFlowLines(s, d, arg, fmtRate));   // C191: top 3 sources and sinks, last 60 s
    return { title: (kind === 'sc' ? 'Softcap: ' : '') + (RES_NAMES[arg] || arg), lines: lines.filter(Boolean) };
  }
  if (kind === 'pop') {
    const a = obj(s.run.colony.adults);
    const lines = [fmtCount(num(a.minor)) + ' minors, ' + fmtCount(num(a.soldier)) + ' soldiers'];
    if (num(a.supermajor) > 0) lines.push(fmtCount(a.supermajor) + ' supermajors');
    if (num(a.replete) > 0) lines.push(fmtCount(a.replete) + ' repletes');
    lines.push('Housing ' + fmtCount(num(st.housing, 10)) + ' · brood slots ' + fmtCount(num(st.broodSlots, 3)));
    return { title: 'Your colony', lines };
  }
  // C192: every factor of the queen's lay rate (Colony brood section, rail Queens row)
  if (kind === 'lay') return { title: 'Lay rate ' + fmtRate(num(st.layRate)), lines: layTipLines(layBreakdown(s, d), { fmtRate, fmtMult }) };
  if (kind === 'scale') return { title: 'Colony Scale ' + fmtMult(num(d && d.meta && d.meta.colonyScale, 1)), lines: ['Multiplies housing, brood slots and berths together (not the lay rate).'] };
  if (kind === 'season') {
    const id = (d && d.season && d.season.id) || 'spring';
    return { title: (SEASON_NAMES[id] || id) + ', year ' + fmtCount(num(d && d.season && d.season.year)), lines: [SEASON_TIPS[id] || ''] };
  }
  if (kind === 'bottleneck') {
    const id = s.run.bottleneck && s.run.bottleneck.id;
    return id ? { title: 'What limits growth', lines: [BOTTLENECK_TIPS[id] || 'Relieve this to grow faster.'] }
      : { title: 'No bottleneck', lines: ['Nothing is holding growth back right now.'] };   // C194
  }
  if (kind === 'ribbon') {
    const nu = ribbonInfo(s, d);
    if (!nu) return null;
    const eta = num(nu.eta, -1);
    return { title: 'Next: ' + (nu.label || unlockLabel(nu.key)), lines: [unlockHint(nu.key), eta > 0 ? 'About ' + fmtTime(Math.ceil(eta)) + ' away' : ''].filter(Boolean) };
  }
  if (kind === 'nutrition') {
    const phi = Math.max(0, Math.min(1, num(s.run.colony.phi)));
    return { title: 'Nutrition ' + Math.round(phi * 100) + '%', lines: ['Fungus fed to the colony boosts all worker output.', 'Worker output ' + fmtMult(num(st.nutrition, 1))] };
  }
  if (kind === 'fungusWidget') return { title: 'Fungus gardens', lines: ['Gardeners turn leaves into fungus.'] };
  if (kind === 'threat') {
    const th = activeThreats(s).find((x) => x.id === arg);
    if (!th) return null;
    return { title: th.label, lines: [th.tip, num(th.t, -1) > 0 ? (th.tLabel || 'Ends in ') + fmtTime(Math.ceil(th.t)) + '.' : '',
      th.locate ? (arr(th.spots).length > 1 ? 'Click to find it; click again for the next.' : 'Click to find it.') : ''].filter(Boolean) };
  }
  return null;
}

/**
 * C290: tooltip of a mole's cache (nest pick { kind: 'moleCache', id }): what it is and about how much it gives now.
 * @param {Object} s
 * @param {Object} d
 * @param {{ id?: number }} t
 * @returns {{ title: string, lines: string[] } | null}
 */
export function moleCacheTip(s, d, t) {
  const o = arr(s && s.run && s.run.events && s.run.events.objects).find((x) => x && x.uid === num(t && t.id, -1) && x.kind === 'mole_cache');
  if (!o) return null;
  const r = moleCacheReward(d, o.data && o.data.cache);
  if (!r) return null;
  const res = { food: 'food', insight: 'insight', chitin: 'chitin' }[r.res] || r.res;
  return { title: 'Mole\'s cache: ' + r.name, lines: ['A mole left it at the end of its tunnel.', 'Click to collect: about +' + fmt(r.amount) + ' ' + res + '.'] };
}

/** C182: tooltip line of a trail on a detour round a molehill / spring puddle, or paused with no way round. */
function trailDetourLines(s, tr) {
  let info = null;
  try { info = detourInfo(s, tr); } catch { info = null; }
  const t = detourText(info);
  return t ? [t.line] : [];
}

/** Find a chamber by uid. */
/**
 * C129: first line of a revealed hex's tooltip: the terrain name, or for impassable terrain (stone; a puddle while
 * d.surface.passable says it blocks, i.e. in spring) a line saying trails route around it.
 * @param {string} terrId
 * @param {number} hex
 * @param {Object} d
 * @returns {string}
 */
export function hexTerrainLine(terrId, hex, d) {
  const pass = d && d.surface && d.surface.passable;
  const blocked = terrId === 'stone' || (terrId === 'puddle' && !!pass && pass[hex] === 0);
  return blocked && TERRAIN_BLOCK_TIPS[terrId] ? TERRAIN_BLOCK_TIPS[terrId] : nameOf('terrain', terrId);
}

/**
 * C165: a revealed hex's terrain tooltip lines: what the ground does to trails ("Sand — slow ground: counts as 1.25
 * hexes for trails.") and any terrain note (leaf plants, aphids, footsteps, prey near a log). Impassable terrain keeps
 * the C129 line.
 * @param {string} terrId
 * @param {number} hex
 * @param {Object} d
 * @returns {string[]}
 */
export function hexTerrainLines(terrId, hex, d) {
  const pass = d && d.surface && d.surface.passable;
  const blocked = terrId === 'stone' || (terrId === 'puddle' && !!pass && pass[hex] === 0);
  return terrainTipLines(terrId, blocked);
}

/**
 * C251: tooltip lines of an underground stone (boulder) cell, like the water pocket's: whether it can be dug or built
 * on now and, if not, the research that allows it (Acid Excavation; then ×3 dig work).
 * @param {{ stoneOk?: boolean, work?: number, reserved?: string|null }} info nest.cellInfo
 * @returns {string[]}
 */
export function stoneTipLines(info) {
  const acid = nameOf('research', 'acid_excavation');
  const lines = info && info.stoneOk
    ? ['Can be dug and built over now (' + acid + '): ×3 dig work.', 'Dig work ' + fmt(num(info.work)) + ' per cell']
    : ['Cannot be dug or built on yet.', acid + ' research lets you dig through it.'];
  if (info && info.reserved) lines.push('Reserved: the ' + nameOf('chamber', info.reserved) + ' grows here once it is cleared.');
  return lines;
}

/**
 * C154: tooltip title for a cell of a chamber's reserved full-size room: "Reserved for Gallery (L3 → full size at L8)".
 * @param {Object} c the chamber
 * @param {{ level: number, fullL: number }|null} rb nest.reservedBy
 * @returns {string}
 */
export function reservedTitle(c, rb) {
  const L = Math.max(0, Math.floor(num(c && c.level)));
  const full = rb && num(rb.fullL) > 0 ? num(rb.fullL) : 0;
  return 'Reserved for ' + nameOf('chamber', c && c.type) + ' (L' + fmtCount(L) + (full ? ' → full size at L' + fmtCount(full) : '') + ')';
}

/** C154: the lines under reservedTitle: what the space is, a buried cache in it, and the click. */
function reservedLines(s, d, c, i) {
  const name = nameOf('chamber', c.type);
  const lines = ['Being readied: the ' + name + ' grows into this space. No new tunnels or other chambers here.'];
  let info = null;
  try { info = cellInfo(s, d, i); } catch { info = null; }
  if (info && info.cache) lines.push('Something is buried here: dug up when the ' + name + ' grows over it.');
  lines.push('Click to inspect the ' + name + '.');
  return lines;
}

function chamberBy(s, uid) {
  return arr(s.run.nest && s.run.nest.chambers).find((c) => c && c.uid === uid) || null;
}

/**
 * Tooltip content for a canvas Target (ARCHITECTURE §13.3).
 * @param {Object} t Target
 * @param {Object} s
 * @param {Object} d
 * @returns {{ title: string, lines: string[] } | null}
 */
export function tipForTarget(t, s, d) {
  if (!t || !s || !s.run) return null;
  const k = t.kind;
  if (t.view === 'nest') {
    if (k === 'chamber' || k === 'nursery' || k === 'queen') {
      const c = chamberBy(s, num(t.id));
      if (!c) return null;
      // C154: a cell of its reserved full-size room (the fresh-dug works around it)
      if (t.reserved) {
        let rb = null;
        try { rb = reservedBy(s, d, num(t.i, -1)); } catch { rb = null; }
        return { title: reservedTitle(c, rb), lines: reservedLines(s, d, c, num(t.i, -1)) };
      }
      const idx = arr(s.run.nest.chambers).indexOf(c);
      const dc = obj(arr(d && d.nest && d.nest.chambers)[idx]);
      const lines = [CHAMBER_TIPS[c.type] || ''];
      if (Number.isFinite(dc.eff) && Math.abs(dc.eff - 1) > 1e-9) lines.push('Effect ' + fmtMult(dc.eff));
      // C213: frost in cells (majority rule): exposed now, or what a hard winter would do to it
      let fr = null;
      try { fr = chamberFrost(s, d, c.uid); } catch { fr = null; }
      const fl = frostTipLine(fr, !!dc.exposed);
      if (fl) lines.push(fl);
      else if (dc.exposed) lines.push('Frost-exposed (over half its rows above the frost line): effect halved.');
      if (k === 'queen') lines.push('Lay rate ' + fmtRate(num(d && d.stats && d.stats.layRate)));
      if (k === 'queen') lines.push(queenGlowLine()); // C217
      // C109: adjacency links (the link badge on the chamber): bonus and partner
      let links = [];
      try { links = chamberLinks(s, d, c.uid); } catch { links = []; }
      for (const l of links) lines.push((l.good ? 'Link: ' : 'Penalty: ') + linkText(l));
      if (k === 'nursery') lines.push('Click to groom. ' + groomText(s, d, c.uid));
      // C137 / C154: it grows into the fresh-dug works around it
      if (c.res && (c.res.w > c.w || c.res.h > c.h)) lines.push('Grows into its reserved space (the fresh-dug works around it).');
      // C156: its next level can be bought right now (the ▲ badge)
      let up = false;
      try { up = upgradeAffordable(s, d, c.uid); } catch { up = false; }
      if (up) lines.push('Upgrade affordable');
      return { title: nameOf('chamber', c.type) + ' L' + fmtCount(num(c.level)), lines: lines.filter(Boolean) };
    }
    // C106: a pending blueprint chamber's planned outline
    if (k === 'planned') {
      // C126: with the reason it is still waiting
      let wait = null;
      try { wait = plannedWait(s, d, num(t.i, -1)); } catch { wait = null; }
      return { title: 'Planned: ' + nameOf('chamber', t.chamberType), lines: ['Planned (blueprint): queues when unlocked and affordable.',
        wait ? plannedWaitText(wait) : '', 'Click to inspect it or cancel this planned chamber.'].filter(Boolean) };
    }
    // C117: a revealed water pocket (drain / move with Drainage)
    if (k === 'pocket') {
      const p = arr(s.run.nest && s.run.nest.features && s.run.nest.features.water)[num(t.id, -1)];
      if (!p) return null;
      const owned = !!(s.run.research && s.run.research.drainage);
      let info = null;
      if (owned) { try { info = pocketAction(s, d, num(t.id, -1), null); } catch { info = null; } }
      const lines = ['Cannot be dug. A Water Well must touch one.'];
      if (info && info.wells) lines.push('A Water Well uses it.');
      if (info && info.busy) lines.push('Being drained or moved.');
      else lines.push(owned ? 'Click to drain it or move it.' : nameOf('research', 'drainage') + ' research lets you drain or move it.');
      return { title: 'Water pocket · ' + p.w + '×' + p.h, lines };
    }
    if (k === 'digFace') return { title: 'Dig face', lines: ['Click to help dig.', 'Dig rate ' + fmtRate(num(d && d.stats && d.stats.digW)).replace('/s', ' work/s')] };
    // C217: what the pulsing gold glow is, and how long it stays
    if (k === 'pupa') return { title: 'Golden pupa', lines: pupaTipLines(s) };
    // C216: the yellow house pip over the Royal Chamber (housing full)
    if (k === 'housePip') return { title: 'Housing full', lines: housePipLines(s, d) };
    if (k === 'mold') return { title: 'Mold', lines: ['Halves this chamber. Click to scrape it off.'] };
    // C290: the treasure mole's cache at the end of its tunnel
    if (k === 'moleCache') return moleCacheTip(s, d, t);
    // C245: a blighted Fungus Garden: every click scrapes the blight
    if (k === 'blight') {
      const bl = blightStatus(s);
      if (!bl) return { title: 'Fungus Garden', lines: ['Click to inspect.'] };
      return { title: 'Fungal blight', lines: bl.phase === 'card'
        ? ['Click to start cleaning: ' + fmtCount(bl.need) + ' clicks within ' + fmtTime(num(EVENTS.ev_fungal_blight.num.cleanSec)) + '.']
        : ['Click to scrape: ' + fmtCount(bl.left) + ' click' + (bl.left === 1 ? '' : 's') + ' left, ' + fmtTime(bl.t) + ' to go.'] };
    }
    if (k === 'flood') {
      const rs = EVENTS.ev_rainstorm;
      const bail = num(rs && rs.num ? rs.num.bailSec : NaN, 5);
      return { title: 'Flood water', lines: ['Click to bail out ' + fmtTime(bail) + ' of flooding.'] };
    }
    if (k === 'cacheHint') return { title: 'Discoloured soil', lines: ['Something is buried here. Click to dig to it.'] };
    if (k === 'shaft') return { title: 'Entrance shaft', lines: ['The seam between the nest and the surface.'] };
    if (k === 'cell') {
      let info = null;
      try { info = cellInfo(s, d, num(t.i)); } catch { info = null; }
      if (!info) return null;
      // C251: a boulder: what it is, whether it can be dug or built on now, else the research that allows it
      if (info.stone) {
        const row = Math.floor(num(t.i) / num(GRID && GRID.cols, 40));
        return { title: 'Stone · ' + nameOf('layer', info.layer) + ' · row ' + row, lines: stoneTipLines(info) };
      }
      const lines = [];
      if (num(info.work) > 0) lines.push('Dig work ' + fmt(num(info.work)) + ' per cell');
      if (info.root) lines.push(info.rootOwn ? 'Cultivated root: grown by your colony. Root Aphid Pens can touch it.' : 'A root grows down here.');
      if (info.water) lines.push('Water pocket: cannot be dug.');
      // C137: inside a chamber's reserved full-size room
      if (info.reserved) lines.push('Reserved: the ' + nameOf('chamber', info.reserved) + ' grows here. No new tunnels or chambers.');
      // C214: who dug a tunnel the player did not draw (a mole, an access tunnel, the blueprint, a shaft)
      const dug = dugByText(info);
      if (dug) lines.push(dug);
      return { title: nameOf('layer', info.layer) + ' · row ' + Math.floor(num(t.i) / num(GRID && GRID.cols, 40)), lines };
    }
    return null;
  }
  if (k === 'source') {
    const src = arr(s.run.surface && s.run.surface.sources).find((x) => x && x.uid === t.id);
    if (!src) return null;
    // C184: what it gives (resources, per-worker yields), stock and its unit, regrowth / lifetime, aphid level progress
    let lines = [];
    try { lines = sourceTipLines(s, d, src); } catch { lines = []; }
    const prey = String(src.type).startsWith('prey_') || src.type === 'termite_mound';
    lines.push(prey ? 'Click to plan a hunt.' : src.type === 'lycaenid_caterpillar' ? 'Escort it with ' + num(SOURCES.lycaenid_caterpillar && SOURCES.lycaenid_caterpillar.minEscorts, 5) + ' soldiers for honeydew.' : 'Click to hand-forage; drag a trail to it.');
    return { title: nameOf('source', src.type) + ' · ring ' + ringOf(num(src.hex)), lines };
  }
  if (k === 'trail') {
    const tr = arr(s.run.surface && s.run.surface.trails).find((x) => x && x.uid === t.id);
    if (!tr) return null;
    const src = arr(s.run.surface.sources).find((x) => x && x.uid === tr.src);
    const dt = arr(d && d.surface && d.surface.trails).find((x) => x && x.uid === tr.uid) || {};
    return { title: 'Trail to ' + (src ? nameOf('source', src.type).toLowerCase() : 'a source'),
      lines: [fmtCount(num(dt.workers, num(tr.workers))) + ' workers · strength ' + fmtCount(num(tr.S)), 'Yield ' + fmtRate(num(dt.out)),
        ...trailDistanceLines(tr, dt), ...trailDetourLines(s, tr)] };
  }
  if (k === 'rival') {
    const r = arr(s.run.rivals && s.run.rivals.list).find((x) => x && x.uid === t.id);
    if (!r) return null;
    const ap = num(d && d.combat && d.combat.rivalAP ? d.combat.rivalAP[r.uid] : NaN, NaN);
    // C228: the same 'Nest strength' (all defenders) as the Map tab's rival row; a raid faces 40% of it
    const lines = [fmtCount(num(r.n)) + ' soldiers' + (Number.isFinite(ap) ? ' · nest strength ' + fmt(ap) + ' (a raid faces ' + fmt(ap * num(ACTIONS.raid && ACTIONS.raid.engage, 0.4)) + ')' : '')];
    // F12: the Old Ridge's territory gate; F13: the Front's 10-minute window and its countdown
    const imm = oldRidgeImmunity(s, d, r);
    if (imm) lines.push('Cannot be assaulted until you own ' + imm.need + ' hexes (' + imm.owned + ' now).');
    const f = frontInfo(s, r);
    if (f && !f.done) {
      const left = f.open ? fmtTime(Math.ceil(num(f.remaining))) : '';
      if (r.alive === false && f.open) lines.push('Fallen: regrows in ' + left + ' unless all ' + f.total + ' fall.');
      else if (f.open) lines.push('Take it within ' + left + ' or the fallen nests regrow.');
      else lines.push('All ' + f.total + ' Front nests must fall within ' + spanText(f.windowSec) + ' of each other.');
    }
    if (r.alive !== false && num(r.truce) > 0) lines.push('Truce: ' + fmtTime(Math.ceil(num(r.truce))) + ' left' + (TRUCE.attackPolicy === 'block' ? '.' : ' — attacking breaks it.'));   // C247
    lines.push(r.alive === false ? 'Conquered.' : 'Click for the war panel.');
    return { title: nameOf('rival', r.type) + frontLabel(s, r) + ' · tier ' + fmtCount(num(r.tier)), lines };
  }
  if (k === 'party') {
    const p = arr(s.run.war && s.run.war.parties).find((x) => x && x.uid === t.id);
    return p ? { title: PARTY_NAMES[p.kind] || 'War party', lines: [fmtCount(num(p.soldier) + num(p.supermajor)) + ' ants · ' + (p.state || '')] } : null;
  }
  // C248: an incoming raid's warning arrow
  if (k === 'raid') {
    const rd = arr(s.run.war && s.run.war.raids).find((x) => x && x.uid === t.id);
    if (!rd) return null;
    return { title: 'Incoming raid · ' + fmtTime(Math.max(0, Math.ceil(num(rd.warn)))), lines: [fmtCount(num(rd.raiders)) + ' raiders.', 'Click to see your defence in Map → War.'] };
  }
  if (k === 'beetle') return { title: 'Golden Beetle', lines: ['Click it before it scuttles away!'] };
  if (k === 'gift') return { title: 'Saved Find', lines: ['A gift from your time away. Click to open.'] };
  if (k === 'entrance') return { title: 'Nest entrance', lines: ['Drag from here to draw a trail.'] };
  if (k === 'eventObject') {
    const o = arr(s.run.events && s.run.events.objects).find((x) => x && x.uid === t.id);
    if (o && FIND_NAMES[o.kind]) {   // C188 expedition finds
      return { title: FIND_NAMES[o.kind], lines: [FIND_TIPS[o.kind], num(o.t, -1) > 0 ? 'Gone in ' + fmtTime(Math.ceil(num(o.t))) + '.' : ''].filter(Boolean) };
    }
    return o ? { title: nameOf('event', 'ev_' + o.kind), lines: [OBJECT_TIPS[o.kind] || 'Click it.'] } : null;
  }
  if (k === 'hex') {
    const hex = num(t.hex, -1);
    if (hex < 0) return null;
    const surf = obj(s.run.surface);
    const revealed = arr(surf.revealed)[hex] === 1;
    const order = TERRAIN_ORDER.length ? TERRAIN_ORDER : TERRAIN_FALLBACK;
    const owned = d && d.surface && d.surface.owned ? d.surface.owned[hex] : 0;
    const terrId = order[num(arr(surf.terrain)[hex])] || 'grass';
    const lines = revealed ? hexTerrainLines(terrId, hex, d) : ['Unexplored: scouts will reveal it.'];
    const tool = getUI().tool;
    // C162: a trail-held hex (Trunk Trails, owned code 4) is temporary territory, lost with the trail
    if (owned === 4) lines.push('Held by trail — claim to keep.');
    else if (owned) lines.push('Your territory.');
    // C209: while claiming, what a claimed hex gives
    if (tool && tool.kind === 'claim' && revealed && owned !== 1 && owned !== 2 && owned !== 3) lines.push('Claiming it: ' + territoryBenefitLines().slice(0, 3).join(' '));
    // F15: while placing a satellite, say whether this hex qualifies (and why not) before the click
    if (tool && tool.kind === 'placeSatellite' && satellitesFree(s) > 0) {
      const why = satelliteHexWhy(s, d, hex, reasonText);
      lines.push(!why ? 'A satellite can go here.' : /satellite/i.test(why) ? why : 'Satellite: ' + why);
    }
    return { title: 'Hex · ring ' + ringOf(hex), lines };
  }
  if (k === 'battle') {
    const b = arr(s.run.war && s.run.war.battles).find((x) => x && x.uid === t.id);
    return b ? { title: BATTLE_NAMES[b.kind] || 'Battle', lines: ['Victory chance was ' + fmtPct(num(b.odds), { signed: false })] } : null;
  }
  return null;
}

/**
 * Tooltip controller on the #tooltip element.
 * @param {HTMLElement} tipEl
 * @param {HTMLElement} root element whose descendants carry data-tip / data-tip-key
 * @param {{ game: Object }} ctx
 */
export function createTooltips(tipEl, root, { game }) {
  let current = null; // { source: 'dom'|'target', el?, key?, text?, target?, x, y }
  const title = h('div', { class: 'tip-title' });
  const body = h('div', { class: 'tip-body' });
  if (tipEl) {
    tipEl.setAttribute('role', 'tooltip');
    tipEl.append(title, body);
    tipEl.hidden = true;
  }

  function render() {
    if (!tipEl || !current) return;
    let content = null;
    if (current.source === 'target') content = tipForTarget(current.target, game.s, game.d);
    else if (current.key) content = tipForKey(current.key, game.s, game.d);
    else if (current.text) content = { title: '', lines: [current.text] };
    if (!content || (!content.title && !content.lines.length)) {
      hide();
      return;
    }
    setText(title, content.title || '');
    title.hidden = !content.title;
    const sig = content.lines.join('\n');
    if (body.__sig !== sig) {
      body.__sig = sig;
      clear(body);
      for (const l of content.lines) body.appendChild(h('div', { class: 'tip-line', text: l }));
    }
    tipEl.hidden = false;
    place();
  }

  function place() {
    if (!tipEl || !current) return;
    const win = globalThis.window || {};
    const vw = num(win.innerWidth, 1280);
    const vh = num(win.innerHeight, 800);
    let x = current.x;
    let y = current.y;
    if (current.source === 'dom' && current.el && typeof current.el.getBoundingClientRect === 'function') {
      const r = current.el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.bottom + 8;
    } else {
      y += 18;
    }
    const w = num(tipEl.offsetWidth, 220) || 220;
    const hgt = num(tipEl.offsetHeight, 60) || 60;
    let left = Math.round(x - w / 2);
    let top = Math.round(y);
    if (left + w > vw - 8) left = vw - 8 - w;
    if (left < 8) left = 8;
    if (top + hgt > vh - 8) top = Math.max(8, Math.round((current.source === 'dom' && current.el ? current.el.getBoundingClientRect().top : y - 18) - hgt - 8));
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }

  function hide() {
    current = null;
    if (tipEl) tipEl.hidden = true;
  }

  // DOM tooltips wait a moment on a cold start, so sweeping the pointer across the tabs or a panel does not flash
  // tooltips over what the player is about to click; once one is showing, moving to the next shows it at once.
  const DELAY_MS = 350;
  let pendingTimer = null;
  let pendingEl = null;
  function cancelPending() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingEl = null;
  }

  function onOver(ev) {
    const t = ev.target;
    const el = t && typeof t.closest === 'function' ? t.closest('[data-tip],[data-tip-key]') : null;
    if (!el || !root.contains(el)) return;
    const key = el.getAttribute('data-tip-key');
    const text = el.getAttribute('data-tip');
    if (!key && !text) return;
    if (current && current.source === 'dom' && current.el === el) return;
    if (pendingEl === el) return;
    // focus tooltips are for keyboard users; a mouse click also focuses the button, which should not re-show it
    if (ev.type === 'focusin') {
      try { if (typeof el.matches === 'function' && !el.matches(':focus-visible')) return; } catch { /* old browser: show */ }
    }
    const warm = !!(current && current.source === 'dom') || ev.type === 'focusin';
    cancelPending();
    const next = { source: 'dom', el, key, text, x: 0, y: 0 };
    if (warm || typeof setTimeout !== 'function') {
      current = next;
      render();
      return;
    }
    pendingEl = el;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      pendingEl = null;
      if (el.isConnected === false) return;
      current = next;
      render();
    }, DELAY_MS);
  }

  function onOut(ev) {
    const to = ev.relatedTarget;
    if (pendingEl && !(to && typeof pendingEl.contains === 'function' && pendingEl.contains(to))) cancelPending();
    if (!current || current.source !== 'dom') return;
    if (to && current.el && typeof current.el.contains === 'function' && current.el.contains(to)) return;
    hide();
  }

  // a click answers the question: the tooltip of the pressed element steps aside (it returns on the next hover)
  function onDown() {
    cancelPending();
    if (current && current.source === 'dom') hide();
  }

  if (root) {
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('focusin', onOver);
    root.addEventListener('focusout', onOut);
    root.addEventListener('pointerdown', onDown);
  }

  return {
    /** Canvas target tooltip at client coordinates (null hides). */
    showTarget(target, x, y) {
      if (!target) {
        if (current && current.source === 'target') hide();
        return;
      }
      current = { source: 'target', target, x: num(x), y: num(y) };
      render();
    },
    /** Re-render live content (4 Hz). */
    refresh() {
      if (current) {
        if (current.source === 'dom' && current.el && !current.el.isConnected && current.el.isConnected !== undefined) {
          hide();
          return;
        }
        render();
      }
    },
    hide,
    isVisible() {
      return !!current;
    },
    destroy() {
      cancelPending();
      hide();
      if (root) {
        root.removeEventListener('pointerover', onOver);
        root.removeEventListener('pointerout', onOut);
        root.removeEventListener('focusin', onOver);
        root.removeEventListener('focusout', onOut);
        root.removeEventListener('pointerdown', onDown);
      }
    },
  };
}
