// Derived cache skeleton with neutral defaults (never saved; rebuilt from state by the systems every tick).
// Owner: WP1. Contract: ARCHITECTURE §5 (each subtree has one writer; these are only the starting values).

import { GRID, HEX } from '../data/balance.js';

/**
 * Create the derived cache `d` with the neutral defaults of ARCHITECTURE §5.
 * @returns {import('./types.js').Derived}
 */
export function createDerived() {
  const cells = GRID.cols * GRID.rows;
  const hexes = HEX.count;
  return {
    ledger: { food: {}, honeydew: {}, leaves: {}, chitin: {}, insight: {}, fungus: {} },

    season: {
      id: 'spring', index: 0, year: 0, tIn: 0, toNext: 360, len: 360,
      mild: false,
      frostRow: 0,
      frostMax: 0,
      snapRow: 0,
      forecast: { next: 'summer', inSec: 360, weather: null },
      mods: { forage: 1, lay: 1.25, broodTime: 0.8, dig: 1, insight: 1, foodCap: 1, rivalAggro: 1.25, rivalDormant: false,
        flightW: 1, puddlesBlock: true },
      srcId: 'spring',
    },

    meta: {
      colonyScale: 1, lineage: 1, K: 0, G: 0, achCount: 0, achMult: 1, census: 0,
      prestige: { food: 1, dig: 1, insight: 1, honeydew: 1, leaves: 1, fungus: 1, chitin: 1, lay: 1, ap: 1, alates: 1 },
      hardship: { eternal_winter: 0, claustral_founding: 0, pacifist: 0, barren_ground: 0, shallow_soil: 0, monomorphic: 0 },
      species: 'garden_ant', sp: {},
      edict: null,
      proj: {
        alates: 0, perMin: 0, kinship: 0, genes: 0,
        fly: { ok: false, royal5: false, prep: false, chamber: false, fRun: false },
        superc: { ok: false, budding: false, alates: false, oldRidge: false },
        spec: { ok: false, megacolony: false, front: false, kinship: false },
      },
    },

    nest: {
      rev: 0,
      chamberAt: new Int16Array(cells).fill(-1),
      open: new Uint8Array(cells),
      dist: new Int16Array(cells).fill(-1),
      entDist: new Int16Array(cells).fill(-1),
      chambers: [],
      agg: {
        housingBase: 10,
        broodGroups: [{ kind: 'royal', uid: 1, cap: 3, factor: 1, exposed: false, snap: false, inReach: false }],
        berthsBase: 0, repleteBerthsBase: 0,
        alateCells: 0,
        granaryCap: 0,
        clayFoodShare: 0,
        reachStorageShare: 0,
        nearestGranaryUid: 0,
        haulH: 0.83,
        libraryInsight: 0,
        middenL: 0,
        barracksL: 0, barracksNear: false,
        rootPenL: 0, rootPenCount: 0,
        gardenL: 0, gardenerSlots: 0, leafCap: 0, fungusCap: 0, fungusMod: 1,
        hibCap: 0, hibL: 0,
        chimneyL: 0, gateL: 0, deepVaultL: 0,
        royal: [1],
        royalL: 1,
        nuptial: { active: false, level: 0, shaftOpen: false },
        wells: 0, chambersActive: 1,
        adjGranaryRepletion: false, adjNurseryRoyal: false,
      },
      digFace: -1,
      queueInfo: [],
      hints: [],
    },

    surface: {
      rev: 0,
      owned: new Uint8Array(hexes),
      ownedCount: 0,
      border: new Uint8Array(hexes),
      rival: new Int16Array(hexes),
      passable: new Uint8Array(hexes).fill(1),
      slots: 3, slotsUsed: 1,
      dNav: 3, slope: 0.35,
      trails: [],
      loose: 0,
      frontier: [],
      scoutRate: 0,
      claimCost: 10,
      bestSource: 0,
    },

    stats: {
      colonyScale: 1,
      housing: 10, broodSlots: 3, berths: 0, repleteBerths: 0, alateCells: 0, gardenerSlots: 0,
      foodCap: 150, honeydewCap: 65, leafCap: 0, fungusCap: 0, pheromoneCap: 50,
      layRate: 0.25,
      eggCost: { minor: 10, soldier: 50, supermajor: 500, replete: 200, alate: 200 },
      eggExtra: { minor: {}, soldier: { chitin: 1 }, supermajor: { chitin: 25, fungus: 5 }, replete: { honeydew: 10 }, alate: { honeydew: 5 } },
      mbt: 0.8,
      nurseTerm: 1.33,
      digW: 0,
      soilMult: 1,
      clickValue: 1,
      workerMult: 1,
      forage: { aAdd: 1, mRun: 1, mTime: 1, mPrestige: 1, total: 1 },
      seasonForage: 1,
      honeydew: 1, leaves: 1, fungus: 1, chitin: 1,
      insight: { library: 1, scouting: 1, oneShot: 1 },
      upkeep: 0,
      phiCoef: 0.5, nutrition: 1,
      atk: 1, hp: 1, ap: 1,
      pheromoneRegen: 0.5,
      scMult: { food: 1, dig: 1 },
    },

    rates: {
      food: { raw: 0, gross: 0, net: 0, upkeep: 0, clicks: 0, sc: false, src: {} },
      soil: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
      insight: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
      pheromone: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
      chitin: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
      honeydew: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
      leaves: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
      fungus: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
    },

    combat: {
      garrison: { soldier: 0, supermajor: 0 },
      garrisonAP: 0, homeMult: 1,
      escortAP: {},
      rivalAP: {},
      danger: [],
    },

    progress: { nextUnlock: null, goals: [], _timers: {} },

    offlineLog: null,
  };
}

