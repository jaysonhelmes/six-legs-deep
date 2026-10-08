// WP2 unit tests — systems/stats.js: E(N) table, egg costs and extras, caps, lay rate, forage / dig / channel stacks,
// territory bonus, winter R, upkeep (incl. winter reductions), nutrition, combat, pheromone, click value.
// Expectations for numbers owned by other packages are read from their data tables (neutral when absent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import { recompute, eggCost, winterR } from '../src/systems/stats.js';
import { addEffect } from '../src/core/effects.js';
import { RESEARCH, REFINEMENT } from '../src/data/research.js';
import { CHAMBERS } from '../src/data/chambers.js';
import { TRAITS } from '../src/data/bloodline.js';
import { FEDERATION } from '../src/data/federation.js';
import { GENOME, SIGNATURES } from '../src/data/genome.js';
import { EDICTS, HARDSHIPS } from '../src/data/prestige.js';
import { CASTES } from '../src/data/castes.js';
import { LAY } from '../src/data/economy.js';
import { ADAPTATIONS } from '../src/data/adaptations.js';

/** Relative closeness. */
function near(a, b, rel = 1e-9, msg = '') {
  assert.ok(Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(a), Math.abs(b)), `${msg} ${a} ≉ ${b}`);
}
/** table[id].fx[key] or the neutral value. */
const fxv = (table, id, key, dflt) => (table[id] && table[id].fx && typeof table[id].fx[key] === 'number' ? table[id].fx[key] : dflt);

function setup() {
  const s = newState(1);
  const d = makeDerived();
  return { s, d, env: fakeEnv() };
}

test('E(N) matches the DESIGN §5.2 table (E(200) = 111.8)', () => {
  const table = [[0, 10], [50, 28.3], [100, 52.0], [200, 111.8], [500, 365], [1000, 962], [5000, 10150], [10000, 28500], [1e6, 2.83e7], [1e9, 8.94e11]];
  for (const [N, E] of table) {
    const { s, d } = setup();
    s.run.colony.naniticsLeft = 0;
    s.run.colony.adults.minor = N;
    const c = eggCost(s, d, 'minor');
    assert.ok(Math.abs(c.food - E) / E < 0.005, `E(${N}) = ${c.food}, table ${E}`);
  }
  const { s, d } = setup();
  s.run.colony.naniticsLeft = 0;
  s.run.colony.adults.minor = 200;
  assert.equal(Math.round(eggCost(s, d, 'minor').food * 10) / 10, 111.8);
});

test('egg-cost N counts adults, reared alates and brood; nanitics halve the minor egg only', () => {
  const { s, d } = setup();
  s.run.colony.adults = { minor: 20, soldier: 10, supermajor: 5, replete: 5 };
  s.run.colony.alatesReared = 4;
  s.run.colony.brood = [{ c: 'minor', n: 6, p: 0, t: 0 }];
  const E = 10 * (1 + 0.02 * 50) ** 1.5;
  near(eggCost(s, d, 'minor').food, E * 0.5, 1e-12, 'nanitic minor');
  near(eggCost(s, d, 'soldier').food, E * 5, 1e-12, 'soldier');
  s.run.colony.naniticsLeft = 0;
  near(eggCost(s, d, 'minor').food, E, 1e-12, 'full minor');
});

test('caste extras: soldier chitin 1 + 0.02 × soldiers, supermajor 25 chitin + 5 fungus, replete 10 honeydew, alate 5 × 1.15^k honeydew', () => {
  const { s, d } = setup();
  s.run.colony.adults.soldier = 50;
  s.run.colony.eggs.alate = 3;
  assert.deepEqual(Object.keys(eggCost(s, d, 'minor')), ['food']);
  near(eggCost(s, d, 'soldier').chitin, 1 + 0.02 * 50);
  const sm = eggCost(s, d, 'supermajor');
  assert.equal(sm.chitin, 25);
  assert.equal(sm.fungus, 5);
  assert.equal(eggCost(s, d, 'replete').honeydew, 10);
  near(eggCost(s, d, 'alate').honeydew, 5 * 1.15 ** 3);
  assert.equal(eggCost(s, d, 'queen'), null);
  assert.equal(eggCost(s, d, 'bogus'), null);
  assert.equal(eggCost(s, d, '__proto__'), null);
});

test('trophic_eggs and the honeypot repleteCost multiply the egg food', () => {
  const { s, d } = setup();
  s.run.colony.naniticsLeft = 0;
  const base = eggCost(s, d, 'replete').food;
  s.run.research.trophic_eggs = 1;
  near(eggCost(s, d, 'replete').food, base * fxv(RESEARCH, 'trophic_eggs', 'eggCost', 1));
  d.meta.sp = { repleteCost: 0.25 };
  near(eggCost(s, d, 'replete').food, base * fxv(RESEARCH, 'trophic_eggs', 'eggCost', 1) * 0.25);
});

test('recompute: neutral derived gives the documented starting stats', () => {
  const { s, d, env } = setup();
  recompute(s, d, env);
  const st = d.stats;
  assert.equal(st.housing, 10);
  assert.equal(st.broodSlots, 3);
  assert.equal(st.foodCap, 150);
  assert.equal(st.honeydewCap, 65);
  assert.equal(st.pheromoneCap, 50);
  near(st.layRate, 0.25);
  assert.equal(st.eggCost.minor, 5);
  near(st.mbt, 0.8);
  near(st.nurseTerm, 1 + 1 / 3);
  assert.equal(st.upkeep, 0);
  assert.equal(st.forage.total, 1);
  assert.equal(st.clickValue, 1);
  near(st.pheromoneRegen, 0.5);
  assert.equal(st.digW, 0);
});

test('colony scale multiplies housing, brood slots, berths, replete berths, gardener slots and the chitin cap (not alate cells, not lay rate: C198)', () => {
  const { s, d, env } = setup();
  d.meta.colonyScale = 4;
  Object.assign(d.nest.agg, { housingBase: 30, berthsBase: 8, repleteBerthsBase: 5, gardenerSlots: 10, alateCells: 15,
    broodGroups: [{ kind: 'royal', uid: 1, cap: 3, factor: 1 }, { kind: 'nursery', uid: 2, cap: 6, factor: 1.15 }] });
  recompute(s, d, env);
  const st = d.stats;
  assert.equal(st.colonyScale, 4);
  assert.equal(st.housing, 120);
  assert.equal(st.broodSlots, 36);
  assert.equal(st.berths, 32);
  assert.equal(st.repleteBerths, 20);
  assert.equal(st.gardenerSlots, 40, 'gardener slots × colony_scale (DESIGN §6.2, balance pass)');
  assert.equal(st.alateCells, 15);
  near(st.layRate, 0.25, 1e-9, 'C198: colony scale no longer multiplies the lay rate');
  near(st.chitinCap, 500 * 4, 1e-9, 'C199: chitin cap × colony scale');
});

test('housing multipliers: gallery_arches and compact_galleries', () => {
  const { s, d, env } = setup();
  s.run.research.gallery_arches = 1;
  s.run.research.compact_galleries = 1;
  recompute(s, d, env);
  near(d.stats.housing, 10 * fxv(RESEARCH, 'gallery_arches', 'housing', 1) * fxv(RESEARCH, 'compact_galleries', 'housing', 1));
});

test('food cap: granaries, repletes (+2 % each, ×1.25 adjacency, species ×), autumn, ach_hoarder, species foodCap', () => {
  const { s, d, env } = setup();
  d.nest.agg.granaryCap = 350;
  s.run.colony.adults.replete = 10;
  recompute(s, d, env);
  near(d.stats.foodCap, 500 * 1.2);
  near(d.stats.honeydewCap, 50 + 0.1 * 600);
  d.nest.agg.adjGranaryRepletion = true;
  recompute(s, d, env);
  near(d.stats.foodCap, 500 * (1 + 0.02 * 10 * 1.25));
  d.season.mods.foodCap = 1.25;
  s.meta.achievements.ach_hoarder = 0;   // earned at simTime 0 still counts
  d.meta.sp = { foodCap: 0.5, repleteCap: 5 };
  recompute(s, d, env);
  near(d.stats.foodCap, 500 * (1 + 0.02 * 10 * 1.25 * 5) * 1.25 * 1.1 * 0.5);
});

test('pheromone cap and regen: 50 + 50·pheromone_glands + 5 × mound; (0.5 + 0.05√adults) × glands', () => {
  const { s, d, env } = setup();
  s.run.surface.mound = 4;
  s.run.colony.adults.minor = 100;
  recompute(s, d, env);
  assert.equal(d.stats.pheromoneCap, 70);
  near(d.stats.pheromoneRegen, 0.5 + 0.05 * 10);
  s.run.research.pheromone_glands = 1;
  recompute(s, d, env);
  assert.equal(d.stats.pheromoneCap, 70 + fxv(RESEARCH, 'pheromone_glands', 'cap', 0));
  near(d.stats.pheromoneRegen, (0.5 + 0.05 * 10) * fxv(RESEARCH, 'pheromone_glands', 'regen', 1));
});

test('lay rate: royal_feeding, Royal Chamber levels (×1.15 to highFrom, ×perRCHigh above), queens add + court, M_lay stack, hungry 0, claustral RF 0', () => {
  const { s, d, env } = setup();
  d.season.mods.lay = 1;
  s.run.adaptations.royal_feeding = 2;
  d.nest.agg.royal = [3];
  recompute(s, d, env);
  near(d.stats.layRate, (0.2 + 0.1) * 1.15 ** 2);
  d.nest.agg.royal = [3, 1];
  recompute(s, d, env);
  near(d.stats.layRate, (0.2 + 0.1) * (1.15 ** 2 + 1) * (1 + LAY.courtPer), 1e-9, 'two queens: terms add, × the court');
  d.nest.agg.royal = [LAY.highFrom + 4];
  recompute(s, d, env);
  near(d.stats.layRate, (0.2 + 0.1) * 1.15 ** (LAY.highFrom - 1) * LAY.perRCHigh ** 4, 1e-9, 'levels above highFrom grow ×perRCHigh');
  d.nest.agg.royal = [1];
  s.run.adaptations = { queens_feast: 2 };
  s.run.research.royal_pheromones = 1;
  s.run.research.spermathecal_reserve = 1;
  s.run.refinements.brood = 1;
  d.meta.prestige.lay = 3;
  addEffect(s, { id: 'ev_queens_vigor', stat: 'lay', mult: 3, t: 60 });
  s.meta.achievements.ach_thousand_strong = 10;
  s.meta.achievements.ach_royal_ascent = 20;
  recompute(s, d, env);
  const mLay = fxv(RESEARCH, 'royal_pheromones', 'lay', 1) * fxv(RESEARCH, 'spermathecal_reserve', 'lay', 1)
    * ADAPTATIONS.queens_feast.fx.lay ** 2 * 3 * 3
    * REFINEMENT.mult * 1.02 * 1.05;
  near(d.stats.layRate, 0.2 * mLay);
  s.run.colony.hungry = true;
  recompute(s, d, env);
  assert.equal(d.stats.layRate, 0, 'laying is 0 while Hungry');
  s.run.colony.hungry = false;
  s.run.adaptations = { royal_feeding: 5 };
  s.run.research = {};
  s.run.refinements = {};
  s.run.effects = [];
  s.meta.achievements = {};
  d.meta.prestige.lay = 1;
  s.run.hardship = 'claustral_founding';
  recompute(s, d, env);
  near(d.stats.layRate, 0.2, 1e-12, 'claustral_founding ignores Royal Feeding');
});

test('territory bonus in forage A_add is min(1, 0.005 × ownedCount)', () => {
  const { s, d, env } = setup();
  for (const [owned, aAdd] of [[0, 1], [20, 1.1], [100, 1.5], [200, 2], [500, 2]]) {
    d.surface.ownedCount = owned;
    recompute(s, d, env);
    near(d.stats.forage.aAdd, aAdd, 1e-12, 'owned ' + owned);
  }
});

test('forage stack: A_add (mandibles, midden, satellites, events) × M_run × M_time × M_prestige × workerMult', () => {
  const { s, d, env } = setup();
  s.run.adaptations = { strong_mandibles: 3, potent_trails: 2 };
  s.run.research = { trail_memory: 1, recruitment_pheromones: 1 };
  s.run.refinements = { foraging: 2 };
  s.cycle.edict = 'edict_of_plenty';
  d.nest.agg.middenL = 3;
  s.run.surface.entrances.push({ kind: 'satellite', hex: 40, col: 5, ref: 0 });
  addEffect(s, { id: 'myrmecophile', stat: 'forage_add', add: 0.15, t: 600 });
  addEffect(s, { id: 'frenzy', stat: 'forage', mult: 2, t: 20 });
  d.season.mods.forage = 1.3;
  d.meta.prestige.food = 7;
  recompute(s, d, env);
  const f = d.stats.forage;
  const midden = Math.min(fxv(CHAMBERS, 'midden', 'outputMax', 0), fxv(CHAMBERS, 'midden', 'output', 0) * 3);
  near(f.aAdd, 1 + 0.3 + midden + fxv(FEDERATION, 'satellite_nest', 'foodDig', 0) + 0.15);
  near(f.mRun, fxv(RESEARCH, 'trail_memory', 'forage', 1) * fxv(RESEARCH, 'recruitment_pheromones', 'forage', 1) * 1.12 ** 2
    * REFINEMENT.mult ** 2 * fxv(EDICTS, 'edict_of_plenty', 'forage', 1));
  near(f.mTime, 1.3 * 2);
  near(f.mPrestige, 7);
  near(f.total, f.aAdd * f.mRun * f.mTime * f.mPrestige * d.stats.workerMult);
  s.cycle.edict = 'edict_of_war';
  recompute(s, d, env);
  near(d.stats.forage.mRun, fxv(RESEARCH, 'trail_memory', 'forage', 1) * fxv(RESEARCH, 'recruitment_pheromones', 'forage', 1) * 1.12 ** 2
    * REFINEMENT.mult ** 2 * fxv(EDICTS, 'edict_of_war', 'forage', 1));
});
test('Hungry ×0.75 applies to forage, dig, honeydew, leaves, fungus, chitin and insight (C5)', () => {
  const { s, d, env } = setup();
  s.run.colony.adults.minor = 10;
  s.run.colony.jobs.digger = 10;
  recompute(s, d, env);
  const a = JSON.parse(JSON.stringify(d.stats));
  s.run.colony.hungry = true;
  recompute(s, d, env);
  const b = d.stats;
  near(b.forage.total, a.forage.total * 0.75);
  near(b.digW, a.digW * 0.75);
  for (const k of ['honeydew', 'leaves', 'fungus', 'chitin']) near(b[k], a[k] * 0.75, 1e-12, k);
  near(b.insight.library, a.insight.library * 0.75);
  near(b.insight.scouting, a.insight.scouting * 0.75);
  assert.equal(b.insight.oneShot, a.insight.oneShot, 'one-shot insight is not an output rate');
});

test('winter forage: 1 − (1 − base) × (1 − R); R combines chimney, mound, seasonal_clock, seasonal_wisdom, eternal_winter, honeypot', () => {
  const { s, d, env } = setup();
  d.season.id = 'winter';
  d.season.mods.forage = 0.3;
  recompute(s, d, env);
  near(d.stats.seasonForage, 0.3);
  s.run.surface.mound = 5;                         // r = 0.15
  recompute(s, d, env);
  near(winterR(s, d), 0.15);
  near(d.stats.seasonForage, 1 - 0.7 * 0.85);
  s.run.surface.mound = 50;                        // capped at 0.3
  d.nest.agg.chimneyL = 2;
  s.run.research.seasonal_clock = 1;
  s.cycle.traits.seasonal_wisdom = 1;
  d.meta.hardship.eternal_winter = 2.5;
  d.meta.sp = { winterForageHalf: true };
  const chim = Math.min(fxv(CHAMBERS, 'thermal_chimney', 'max', 0), fxv(CHAMBERS, 'thermal_chimney', 'winterForage', 0) * 2);
  const rs = [chim, 0.3, fxv(RESEARCH, 'seasonal_clock', 'winterR', 0), fxv(TRAITS, 'seasonal_wisdom', 'winterR', 0),
    fxv(HARDSHIPS, 'eternal_winter', 'winterR', 0) * 2.5, 0.5];
  const R = 1 - rs.reduce((k, r) => k * (1 - r), 1);
  near(winterR(s, d), R);
  recompute(s, d, env);
  near(d.stats.seasonForage, 1 - 0.7 * (1 - R));
  d.season.id = 'summer';
  d.season.mods.forage = 1.3;
  recompute(s, d, env);
  near(d.stats.seasonForage, 1.3, 1e-12, 'R only affects winter');
});

test('dig: diggers^0.85 × A_add × M_run × M_time × prestige; softcap at 1e20 (×thermal_ceiling) reports softcapHit once per run', () => {
  const { s, d, env } = setup();
  s.run.colony.jobs.digger = 16;
  s.run.adaptations.digging_claws = 2;
  s.run.research.coordinated_digging = 1;
  d.season.mods.dig = 1.3;
  d.meta.prestige.dig = 2;
  s.meta.achievements.ach_gravel_pit = 1;
  recompute(s, d, env);
  near(d.stats.digW, 16 ** 0.85 * 1.5 * fxv(RESEARCH, 'coordinated_digging', 'dig', 1) * 1.3 * 2);
  near(d.stats.soilMult, 1.05);
  s.cycle.edict = 'edict_of_depth';
  recompute(s, d, env);
  near(d.stats.digW, 16 ** 0.85 * 1.5 * fxv(RESEARCH, 'coordinated_digging', 'dig', 1) * 1.3 * 2 * fxv(EDICTS, 'edict_of_depth', 'dig', 1));
  s.cycle.edict = null;
  s.run.colony.jobs.digger = 1e30;
  const e1 = fakeEnv();
  recompute(s, d, e1);
  const raw = d.stats.digRaw;
  near(d.stats.digW, 1e20 * (raw / 1e20) ** 0.5);
  assert.ok(d.stats.digW < raw);
  assert.equal(e1.events.filter((e) => e.type === 'softcapHit' && e.stat === 'dig').length, 1);
  const e2 = fakeEnv();
  recompute(s, d, e2);
  assert.equal(e2.events.length, 0, 'reported once per run');
  s.run.index = 1;
  const e3 = fakeEnv();
  recompute(s, d, e3);
  assert.equal(e3.events.length, 1, 'reported again in a new run');
  s.meta.genome.thermal_ceiling = 1;
  recompute(s, d, fakeEnv());
  assert.equal(d.stats.scMult.dig, fxv(GENOME, 'thermal_ceiling', 'mult', 1));
  assert.equal(d.stats.scMult.food, fxv(GENOME, 'thermal_ceiling', 'mult', 1));
});

test('honeydew / leaves / fungus / chitin channels', () => {
  const { s, d, env } = setup();
  d.nest.agg.rootPenCount = 2;
  s.run.research = { sugar_economy: 1, weeder_ants: 1 };
  s.run.adaptations.sweet_tooth = 2;
  s.run.refinements.husbandry = 1;
  s.meta.achievements.ach_shepherd = 1;
  s.meta.achievements.ach_into_the_clay = 1;
  s.run.landingTags = ['site_wet_hollow'];
  addEffect(s, { id: 'golden_aphid', stat: 'honeydew', mult: 7, t: 60 });
  Object.assign(d.meta.prestige, { honeydew: 2, leaves: 3, fungus: 4, chitin: 5 });
  recompute(s, d, env);
  near(d.stats.honeydew, fxv(CHAMBERS, 'root_aphid_pen', 'herders', 1) ** 2 * fxv(RESEARCH, 'sugar_economy', 'honeydew', 1) * 1.15 ** 2
    * REFINEMENT.mult * 2 * 7 * 1.1);
  near(d.stats.leaves, 3);
  near(d.stats.fungus, fxv(RESEARCH, 'weeder_ants', 'fungus', 1) * REFINEMENT.mult * 1.1 * 1.2 * 4);
  near(d.stats.chitin, 5);
  addEffect(s, { id: 'seal', stat: 'surface_work', mult: 0, t: 60 });
  recompute(s, d, env);
  assert.equal(d.stats.honeydew, 0);
  assert.equal(d.stats.leaves, 0);
  assert.equal(d.stats.forage.total, 0);
});

test('insight: common stack, library × chemical_lexicon, scouting × antennation, oneShot = prestige insight', () => {
  const { s, d, env } = setup();
  s.run.research = { collective_memory: 1, hive_mind: 1, chemical_lexicon: 1, antennation: 1 };
  d.season.mods.insight = 1.5;
  d.meta.prestige.insight = 4;
  s.meta.achievements.ach_sociobiologist = 1;
  recompute(s, d, env);
  const common = fxv(RESEARCH, 'collective_memory', 'insight', 1) * fxv(RESEARCH, 'hive_mind', 'insight', 1) * 1.5 * 4 * 1.25;
  near(d.stats.insight.library, common * fxv(RESEARCH, 'chemical_lexicon', 'library', 1));
  near(d.stats.insight.scouting, common * fxv(RESEARCH, 'antennation', 'insightHex', 1));
  assert.equal(d.stats.insight.oneShot, 4);
});

test('upkeep: per caste + 0.5 per reared alate; never multiplied by production multipliers', () => {
  const { s, d, env } = setup();
  s.run.colony.adults = { minor: 10, soldier: 2, supermajor: 1, replete: 10 };
  s.run.colony.alatesReared = 2;
  d.meta.prestige.food = 100;
  s.run.research.trail_memory = 1;
  recompute(s, d, env);
  near(d.stats.upkeep, 10 * 0.05 + 2 * 0.25 + 1 * 1 + 10 * 0.02 + 2 * 0.5);
});

test('winter upkeep reductions: overwintering, diapause_logic, Hibernaculum (max −50 %), ach_survivor, repletes cover ≤ 50 %', () => {
  const { s, d, env } = setup();
  s.run.colony.adults = { minor: 100, soldier: 0, supermajor: 0, replete: 4 };
  const base = 100 * 0.05 + 4 * 0.02;
  d.season.id = 'winter';
  recompute(s, d, env);
  near(d.stats.upkeep, base - 4 * 0.05, 1e-12, 'repletes cover 0.05 each in winter');
  s.run.research = { overwintering: 1, diapause_logic: 1 };
  d.nest.agg.hibL = 7;
  s.meta.achievements.ach_survivor = 1;
  recompute(s, d, env);
  let u = base * fxv(RESEARCH, 'overwintering', 'winterUpkeep', 1) * fxv(RESEARCH, 'diapause_logic', 'winterUpkeep', 1)
    * (1 - Math.min(fxv(CHAMBERS, 'hibernaculum', 'upkeepMax', 0), fxv(CHAMBERS, 'hibernaculum', 'upkeep', 0) * 7)) * 0.95;
  u -= Math.min(4 * 0.05, 0.5 * u);
  near(d.stats.upkeep, u);
  near(d.stats.upkeepWinter, u);
  s.run.colony.adults.replete = 1000;
  recompute(s, d, env);
  const pre = (100 * 0.05 + 1000 * 0.02) * fxv(RESEARCH, 'overwintering', 'winterUpkeep', 1) * fxv(RESEARCH, 'diapause_logic', 'winterUpkeep', 1)
    * (1 - Math.min(fxv(CHAMBERS, 'hibernaculum', 'upkeepMax', 0), fxv(CHAMBERS, 'hibernaculum', 'upkeep', 0) * 7)) * 0.95;
  near(d.stats.upkeep, pre * 0.5, 1e-12, 'repletes cover at most 50 %');
  d.season.id = 'summer';
  recompute(s, d, env);
  near(d.stats.upkeep, 100 * 0.05 + 1000 * 0.02, 1e-12, 'no reductions outside winter');
});

test('nutrition: 1 + phiCoef × φ once fungiculture is owned; fungal_symbiosis and species phiCoef', () => {
  const { s, d, env } = setup();
  s.run.colony.phi = 0.6;
  recompute(s, d, env);
  assert.equal(d.stats.nutrition, 1, 'no nutrition before fungiculture');
  s.run.research.fungiculture = 1;
  recompute(s, d, env);
  near(d.stats.nutrition, 1 + 0.5 * 0.6);
  s.run.research.fungal_symbiosis = 1;
  recompute(s, d, env);
  near(d.stats.nutrition, 1 + fxv(RESEARCH, 'fungal_symbiosis', 'phiCoef', 0.5) * 0.6);
  d.meta.sp = { phiCoef: 2 };
  recompute(s, d, env);
  near(d.stats.nutrition, 1 + 2 * 0.6);
  s.run.colony.jobs.digger = 10;
  recompute(s, d, env);
  near(d.stats.forage.mRun, 2.2, 1e-12, 'nutrition is in forage M_run');
});

test('combat multipliers: ATK (serrated, formic, barracks ≤ +50 %, warrior, venom), HP (cuticle, warrior, total_war), AP', () => {
  const { s, d, env } = setup();
  s.run.adaptations = { serrated_mandibles: 2, thick_cuticle: 3 };
  s.run.research = { formic_acid: 1, war_chemistry: 1 };
  s.cycle.traits.warrior_lineage = 2;
  s.meta.genome.venom_gland = 1;
  d.nest.agg.barracksL = 30;
  s.meta.achievements.ach_total_war = 1;
  s.meta.achievements.ach_square_law = 1;
  s.cycle.edict = 'edict_of_war';
  s.run.refinements.warfare = 2;
  d.meta.prestige.ap = 3;
  recompute(s, d, env);
  const w = fxv(TRAITS, 'warrior_lineage', 'mult', 1) ** 2;
  near(d.stats.atk, 1.1 ** 2 * fxv(RESEARCH, 'formic_acid', 'atk', 1)
    * (1 + Math.min(fxv(CHAMBERS, 'barracks', 'atkMax', 0), fxv(CHAMBERS, 'barracks', 'atk', 0) * 30)) * w * fxv(GENOME, 'venom_gland', 'atk', 1));
  near(d.stats.hp, 1.1 ** 3 * w * 1.1);
  near(d.stats.ap, fxv(RESEARCH, 'war_chemistry', 'ap', 1) * REFINEMENT.mult ** 2 * fxv(EDICTS, 'edict_of_war', 'ap', 1) * 3 * 1.05);
});

test('click value: (1 + quick_dispatch) × clickstorm + p × gross food/s (p from L10: min(5 %, 1 % + 0.1 % × (L − 10)))', () => {
  const { s, d, env } = setup();
  d.rates.food.gross = 1000;
  s.run.adaptations.quick_dispatch = 9;
  recompute(s, d, env);
  assert.equal(d.stats.clickValue, 10);
  s.run.adaptations.quick_dispatch = 12;
  recompute(s, d, env);
  near(d.stats.clickValue, 13 + 0.012 * 1000);
  s.run.adaptations.quick_dispatch = 100;
  s.meta.achievements.ach_clickstorm = 1;
  recompute(s, d, env);
  near(d.stats.clickValue, 101 * 2 + 0.05 * 1000);
});

test('worker multiplier: nanitic_vigor (first 50 workers ×3), golden ants (×10 each), sig_social_stomach (+1 % per 5 repletes, ≤ 50 %)', () => {
  const { s, d, env } = setup();
  s.run.colony.adults.minor = 100;
  s.cycle.traits.nanitic_vigor = 1;
  recompute(s, d, env);
  const mult = fxv(TRAITS, 'nanitic_vigor', 'mult', 1);
  const workers = fxv(TRAITS, 'nanitic_vigor', 'workers', 0);
  near(d.stats.workerMult, (100 + (mult - 1) * Math.min(workers, 100)) / 100);
  s.cycle.traits = {};
  s.run.colony.golden = 2;
  recompute(s, d, env);
  near(d.stats.workerMult, 1 + (fxv(GENOME, 'golden_brood', 'mult', 1) - 1) * 2 / 100);
  s.run.colony.golden = 0;
  s.run.colony.adults.replete = 52;
  s.meta.signatureGenes.sig_social_stomach = true;
  recompute(s, d, env);
  const sig = SIGNATURES.sig_social_stomach.fx;
  near(d.stats.workerMult, 1 + Math.min(sig.max, sig.pct * Math.floor(52 / sig.per)));
  s.run.colony.adults.minor = 0;
  s.cycle.traits.nanitic_vigor = 1;
  s.meta.signatureGenes = {};
  recompute(s, d, env);
  assert.equal(d.stats.workerMult, 1, 'no minors: neutral (ARCH-R)');
});

test('mbt and nurse term: brood_care, season, Fungal Brood (only with fungus), brood_time effects; nurses ≤ 4 per slot', () => {
  const { s, d, env } = setup();
  s.run.research.brood_care = 1;
  s.run.colony.fungalBrood = true;
  recompute(s, d, env);
  near(d.stats.mbt, fxv(RESEARCH, 'brood_care', 'broodTime', 1) * 0.8, 1e-12, 'no fungus: no Fungal Brood speed-up');
  s.run.res.fungus = 1;
  addEffect(s, { id: 'mites', stat: 'brood_time', mult: 1.5, t: 120 });
  recompute(s, d, env);
  near(d.stats.mbt, fxv(RESEARCH, 'brood_care', 'broodTime', 1) * 0.8 * 0.75 * 1.5);
  s.run.colony.jobs.nurse = 2;
  recompute(s, d, env);
  near(d.stats.nurseTerm, 2);
  s.run.colony.jobs.nurse = 1000;
  recompute(s, d, env);
  near(d.stats.nurseTerm, 5);
});

test('recompute never writes NaN / Infinity into d.stats for extreme state', () => {
  const { s, d, env } = setup();
  s.run.colony.adults = { minor: 1e290, soldier: 1e290, supermajor: 1e290, replete: 1e290 };
  s.run.colony.jobs.digger = 1e290;
  for (const id of Object.keys(CASTES)) s.run.colony.eggs[id] = 1e6;
  s.run.adaptations = { potent_trails: 1e4, queens_feast: 1e4, sweet_tooth: 1e4, serrated_mandibles: 1e4, quick_dispatch: 1e9 };
  d.meta.colonyScale = 1e200;
  d.rates.food.gross = 1e295;
  recompute(s, d, env);
  const bad = [];
  const walk = (v, p) => {
    if (typeof v === 'number') { if (!Number.isFinite(v) && !(p.startsWith('stats.eggCost'))) bad.push(p + '=' + v); }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], p + '.' + k);
  };
  walk(d.stats, 'stats');
  assert.deepEqual(bad, []);
});
