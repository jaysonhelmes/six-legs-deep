// Research: purchases paid in insight, prerequisites, branch refinements, and the run-start Innate grant.
// Owner: WP5. Contract: ARCHITECTURE §8.4 (systems/research.js), §9 (buyResearch / buyRefinement); DESIGN §11.
// C200: the Archive — buyArchive { branch } buys one level of a branch's permanent track (s.era.archive[branch]; kept
//   through Flights and Supercolonies, reset at Speciation) for ARCHIVE.base × ARCHIVE.growth^L insight. Open once the
//   branch is complete in this run or the track already has a level; WP2 stats applies × (1 + ARCHIVE.per × L).

import { RESEARCH, RESEARCH_ORDER, BRANCHES, REFINEMENT, ARCHIVE } from '../data/research.js';
import { SPECIES } from '../data/genome.js';
import { geoCost, lvl } from '../core/math.js';
import { canAfford, spend } from '../core/wallet.js';

const hasOwn = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** @returns {boolean} true for a known research id */
function isNode(id) {
  return hasOwn(RESEARCH, id);
}

/** @returns {boolean} true for a known branch id */
function isBranch(id) {
  return hasOwn(BRANCHES, id);
}

/**
 * True if the node is owned this run.
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {boolean}
 */
export function isOwned(s, id) {
  return !!(s && s.run && s.run.research && isNode(id) && s.run.research[id]);
}

/**
 * True if every prerequisite is owned and the node itself is not owned yet.
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {boolean}
 */
export function isAvailable(s, id) {
  if (!isNode(id) || isOwned(s, id)) return false;
  for (const p of RESEARCH[id].prereq) if (!isOwned(s, p)) return false;
  return true;
}

/**
 * Cost of a node: { insight }. null for an unknown id.
 * @param {import('../core/types.js').State} s
 * @param {string} id
 * @returns {import('../core/types.js').Cost|null}
 */
export function cost(s, id) {
  if (!isNode(id)) return null;
  return { insight: RESEARCH[id].cost };
}

/**
 * True once every node of the branch is owned.
 * @param {import('../core/types.js').State} s
 * @param {string} branch
 * @returns {boolean}
 */
export function branchComplete(s, branch) {
  if (!isBranch(branch)) return false;
  let any = false;
  for (const id of RESEARCH_ORDER) {
    if (RESEARCH[id].branch !== branch) continue;
    any = true;
    if (!isOwned(s, id)) return false;
  }
  return any;
}

/**
 * Next refinement level of a branch: { insight: base × growth^L }; null until the branch is complete, and null (MAX)
 * once the cost passes COST_MAX.
 * @param {import('../core/types.js').State} s
 * @param {string} branch
 * @returns {import('../core/types.js').Cost|null}
 */
export function refinementCost(s, branch) {
  if (!branchComplete(s, branch)) return null;
  return geoCost({ insight: REFINEMENT.base }, REFINEMENT.growth, lvl(s.run.refinements, branch));
}

/**
 * C200: Archive level of a branch (era scope).
 * @param {import('../core/types.js').State} s
 * @param {string} branch
 * @returns {number}
 */
export function archiveLevel(s, branch) {
  return s && s.era && isBranch(branch) ? lvl(s.era.archive, branch) : 0;
}

/**
 * C200: true once the branch's Archive track is open: the branch is complete in this run, or the track has a level.
 * @param {import('../core/types.js').State} s
 * @param {string} branch
 * @returns {boolean}
 */
export function archiveOpen(s, branch) {
  return isBranch(branch) && (archiveLevel(s, branch) > 0 || branchComplete(s, branch));
}

/**
 * C200: next Archive level cost of a branch: { insight: base × growth^L }; null while the track is closed and null
 * (MAX) once the cost passes COST_MAX.
 * @param {import('../core/types.js').State} s
 * @param {string} branch
 * @returns {import('../core/types.js').Cost|null}
 */
export function archiveCost(s, branch) {
  if (!archiveOpen(s, branch)) return null;
  return geoCost({ insight: ARCHIVE.base }, ARCHIVE.growth, archiveLevel(s, branch));
}

/**
 * Run start (WP7 startRun): grant every Innate node (era.innate) and the species' innate list for free.
 * @param {import('../core/types.js').State} s
 * @returns {number} nodes newly granted
 */
export function grantInnate(s) {
  if (!s || !s.run || !s.era) return 0;
  const ids = [];
  const innate = s.era.innate || {};
  for (const id of RESEARCH_ORDER) if (innate[id]) ids.push(id);
  const sp = hasOwn(SPECIES, s.era.species) ? SPECIES[s.era.species] : null;
  const spInnate = sp && sp.mods && Array.isArray(sp.mods.innate) ? sp.mods.innate : [];
  for (const id of spInnate) if (isNode(id) && !ids.includes(id)) ids.push(id);
  let granted = 0;
  for (const id of ids) {
    if (!s.run.research[id]) {
      s.run.research[id] = 1;
      granted++;
    }
  }
  return granted;
}

/** @type {Record<string, import('../core/types.js').Handler>} */
export const handlers = {
  /** buyResearch { id } — prerequisites owned, not owned yet, insight affordable. */
  buyResearch: {
    validate(s, d, cmd) {
      if (!isNode(cmd.id)) return 'invalid';
      if (isOwned(s, cmd.id)) return 'max';
      for (const p of RESEARCH[cmd.id].prereq) if (!isOwned(s, p)) return 'locked:prereq';
      if (!canAfford(s, cost(s, cmd.id))) return 'cantAfford';
      return null;
    },
    apply(s, d, cmd, env) {
      if (!spend(s, cost(s, cmd.id))) return;
      s.run.research[cmd.id] = 1;
      env.emit('researchBought', { id: cmd.id });
    },
  },

  /** buyRefinement { branch } — branch complete, cost not MAX, affordable. */
  buyRefinement: {
    validate(s, d, cmd) {
      if (!isBranch(cmd.branch)) return 'invalid';
      if (!branchComplete(s, cmd.branch)) return 'locked';
      const c = refinementCost(s, cmd.branch);
      if (!c) return 'max';
      if (!canAfford(s, c)) return 'cantAfford';
      return null;
    },
    apply(s, d, cmd, env) {
      const c = refinementCost(s, cmd.branch);
      if (!c || !spend(s, c)) return;
      const level = lvl(s.run.refinements, cmd.branch) + 1;
      s.run.refinements[cmd.branch] = level;
      env.emit('refinementBought', { branch: cmd.branch, level });
    },
  },

  /** buyArchive { branch } — C200: track open (branch complete this run, or already levelled), cost not MAX, affordable. */
  buyArchive: {
    validate(s, d, cmd) {
      if (!isBranch(cmd.branch)) return 'invalid';
      if (!archiveOpen(s, cmd.branch)) return 'locked';
      const c = archiveCost(s, cmd.branch);
      if (!c) return 'max';
      if (!canAfford(s, c)) return 'cantAfford';
      return null;
    },
    apply(s, d, cmd, env) {
      const c = archiveCost(s, cmd.branch);
      if (!c || !spend(s, c)) return;
      if (!s.era.archive || typeof s.era.archive !== 'object') s.era.archive = {};
      const level = archiveLevel(s, cmd.branch) + 1;
      s.era.archive[cmd.branch] = level;
      env.emit('archiveBought', { branch: cmd.branch, level });
    },
  },
};
