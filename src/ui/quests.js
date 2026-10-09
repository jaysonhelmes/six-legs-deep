// Quest book data and evaluation (C283): 3–6 suggested next steps picked for where the colony is now (five stages:
// the founding, a growing nest, before the first Nuptial Flight, after it, the Supercolony era). Each quest says why
// it matters, lists steps that tick themselves from the live state, shows progress and its reward, and names the tab
// where it is done. When fewer than three quests of the stage are left, the achievements closest to done fill in.
// The tracked quest id is a per-browser convenience (localStorage, every access in try/catch). Pure: no DOM.
// Owner: WP9. Contract: ARCHITECTURE §14.5 (Achievements row), §18 C283.

import { num, obj, isShown } from './reveal.js';
import { fmt, fmtCount } from './format.js';
import { nameOf } from './text.js';
import { adultsTotal } from '../core/state.js';
import { progress as achProgress, nextGoals } from '../systems/achievements.js';
import { ACHIEVEMENTS } from '../data/achievements.js';
import { FLIGHT, SUPER, SPEC, HARDSHIP } from '../data/prestige.js';

/** Safe read. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Quest kinds and their labels. */
export const QUEST_KINDS = Object.freeze({ milestone: 'Milestone', achievement: 'Achievement', unlock: 'Unlock', prestige: 'Prestige' });

// ------------------------------------------------------------------------------------------------ state readers
const adults = (s) => q(() => adultsTotal(s), 0);
const job = (s, id) => num(obj(s.run.colony.jobs)[id]);
const owns = (s, id) => !!obj(s.run.research)[id];
const trait = (s, id) => num(obj(s.cycle && s.cycle.traits)[id]);
const earned = (s, id) => obj(s.meta.achievements)[id] !== undefined;
const counter = (s, k) => num(obj(s.meta.counters)[k]);
/** Chambers of a type (active only, or any status). */
function chambers(s, type, activeOnly = true) {
  const list = Array.isArray(s.run.nest && s.run.nest.chambers) ? s.run.nest.chambers : [];
  return list.filter((c) => c && c.type === type && (!activeOnly || c.status === 'active'));
}
const royalLevel = (s, d) => {
  const agg = d && d.nest && d.nest.agg;
  if (agg && Number.isFinite(agg.royalL) && agg.royalL > 0) return agg.royalL;
  const r = chambers(s, 'royal_chamber');
  return r.length ? Math.max(...r.map((c) => num(c.level))) : 0;
};
const proj = (d) => obj(d && d.meta && d.meta.proj);
const achProg = (s, d, id) => q(() => achProgress(s, d, id), null);

/** Step builder: text, done(s, d), optional note(s, d). */
const S = (text, done, note = null) => ({ text, done, note });
/** Progress builder: cur(s, d), target (number or fn), label. */
const P = (cur, target, label) => ({ cur, target, label });
/** Achievement-backed progress. */
const AP = (id, label) => P((s, d) => num(obj(achProg(s, d, id)).cur), (s, d) => num(obj(achProg(s, d, id)).target, 1), label);
/** Reward text of an achievement. */
const achReward = (id) => {
  const r = obj(ACHIEVEMENTS[id] && ACHIEVEMENTS[id].reward).text;
  return r ? 'Achievement: ' + r : 'Achievement: a little more production';
};

/** The five stages (chapters) in order. */
export const QUEST_STAGES = Object.freeze([
  { id: 'early', chapter: 'Chapter I', name: 'The Founding', blurb: 'A lone queen, a handful of workers and one tunnel. Every ant counts.' },
  { id: 'mid', chapter: 'Chapter II', name: 'The Growing Nest', blurb: 'The nest reaches into the clay. Neighbours have noticed you.' },
  { id: 'pre', chapter: 'Chapter III', name: 'Before the Flight', blurb: 'Winged princesses stir in the deep chambers. Time to prepare the swarm.' },
  { id: 'post', chapter: 'Chapter IV', name: 'The Second Generation', blurb: 'A new queen, an old memory. Each founding is faster than the last.' },
  { id: 'super', chapter: 'Chapter V', name: 'One Family', blurb: 'Your daughters’ nests reach across the meadow. Many colonies, one kin.' },
]);

/**
 * Stage of a colony: super once a Supercolony was formed or the Federation preview is open; post after the first
 * flight; pre once the Prestige tab's condition holds (food earned or Nuptial Preparation); early until Research
 * opens in the first run; mid otherwise.
 * @param {Object} s
 * @returns {string}
 */
export function questStage(s) {
  if (!s || !s.run || !s.meta) return 'early';
  if (counter(s, 'supercolonies') > 0 || counter(s, 'alatesLife') >= num(SUPER.teaserAlates, 1000) || trait(s, 'budding') > 0) return 'super';
  if (counter(s, 'flights') > 0) return 'post';
  if (num(s.run.fRun) >= num(FLIGHT.tabFRun, 2e7) || owns(s, 'nuptial_preparation')) return 'pre';
  if (!isShown(s, 'panel_research')) return 'early';
  return 'mid';
}

/** The flight quest (shared by Before the Flight and The Second Generation). */
const flightQuest = (id) => ({
  id, kind: 'prestige', title: 'Prepare the Nuptial Flight', go: { tab: 'prestige', sub: 'flight', label: 'Prestige → Flight' },
  why: 'The Flight ends this run, but every alate it earns becomes permanent power: Bloodline traits and a lasting Lineage bonus.',
  steps: [
    S('Royal Chamber level ' + FLIGHT.royalLevel, (s, d) => !!obj(proj(d).fly).royal5 || royalLevel(s, d) >= FLIGHT.royalLevel,
      (s, d) => 'now level ' + fmtCount(royalLevel(s, d))),
    S('Nuptial Preparation researched', (s, d) => !!obj(proj(d).fly).prep || owns(s, 'nuptial_preparation'), () => 'Research → Brood and Royalty'),
    S('A Nuptial Chamber and its exit shaft', (s, d) => !!obj(proj(d).fly).chamber),
    S('Food earned this run ≥ ' + fmt(FLIGHT.fRunMin), (s) => num(s.run.fRun) >= FLIGHT.fRunMin, (s) => fmt(num(s.run.fRun)) + ' / ' + fmt(FLIGHT.fRunMin)),
  ],
  prog: P((s) => num(s.run.fRun), FLIGHT.fRunMin, 'food this run'),
  reward: (s, d) => {
    const a = num(proj(d).alates);
    return a > 0 ? 'About ' + fmtCount(a) + ' alates if you flew now, more near the peak' : 'Alates for permanent Bloodline traits';
  },
});

/** Quests per stage. */
export const QUESTS = Object.freeze({
  early: [
    { id: 'e_workers', kind: 'milestone', title: 'Put the first workers to work', go: { tab: 'colony', label: 'Colony → Jobs' },
      why: 'Idle workers gather nothing. Foragers bring food home; diggers make room for more ants.',
      steps: [
        S('Hatch your first worker', (s) => num(s.run.stats && s.run.stats.hatched) >= 1),
        S('Reach 3 adults to unlock Diggers', (s) => adults(s) >= 3, (s) => fmtCount(adults(s)) + ' / 3'),
        S('Assign your first digger', (s) => job(s, 'digger') >= 1),
      ],
      reward: 'Diggers start the dig queue, and the Build tab opens when housing is full' },
    { id: 'e_gallery', kind: 'unlock', title: 'Dig your first Gallery', go: { tab: 'build', label: 'Build → Chambers' },
      why: 'Housing caps how many ants you can have. A Gallery adds room for more.',
      steps: [
        S('Fill your housing (the Build tab opens)', (s) => isShown(s, 'panel_build')),
        S('Place a Gallery in the Build tab', (s) => chambers(s, 'gallery', false).length > 0),
        S('Dig it out with your diggers', (s) => chambers(s, 'gallery').length > 0),
      ],
      reward: 'More housing; the first Adaptations follow' },
    { id: 'e_scouts', kind: 'unlock', title: 'Send out scouts', go: { tab: 'colony', label: 'Colony → Jobs' },
      why: 'Scouts reveal the land around the nest: new food sources, and the first revealed hex opens Research.',
      steps: [
        S('Reach 12 adults to unlock Scouts', (s) => adults(s) >= 12 || isShown(s, 'job_scout'), (s) => fmtCount(adults(s)) + ' / 12'),
        S('Assign a scout', (s) => job(s, 'scout') >= 1 || isShown(s, 'panel_research')),
        S('Reveal a new hex (Research opens)', (s) => isShown(s, 'panel_research')),
      ],
      prog: P((s) => adults(s), 12, 'adults'),
      reward: 'Opens Research' },
    { id: 'e_twenty', kind: 'milestone', title: 'Reach 20 adults', go: { tab: 'colony', label: 'Colony → Brood' },
      why: 'At 20 adults the Royal Chamber can be upgraded. Its lay rate drives everything else.',
      steps: [
        S('Place a Nursery for more brood slots', (s) => chambers(s, 'nursery', false).length > 0, () => 'unlocks at 8 adults'),
        S('Grow to 20 adults', (s) => adults(s) >= 20 || isShown(s, 'royal_levelup'), (s) => fmtCount(adults(s)) + ' / 20'),
      ],
      prog: P((s) => adults(s), 20, 'adults'),
      reward: 'Royal Chamber upgrades (a faster lay rate)' },
  ],
  mid: [
    { id: 'm_royal', kind: 'milestone', title: 'Raise the Royal Chamber', go: { tab: 'build', label: 'Build → Chambers' },
      why: 'Each Royal Chamber level lays faster and houses more ants. Level ' + FLIGHT.royalLevel + ' is also needed for the Nuptial Flight.',
      steps: [
        S('Unlock Royal Chamber upgrades (20 adults)', (s) => isShown(s, 'royal_levelup')),
        S('Royal Chamber level 3', (s, d) => royalLevel(s, d) >= 3),
        S('Royal Chamber level ' + FLIGHT.royalLevel, (s, d) => royalLevel(s, d) >= FLIGHT.royalLevel),
      ],
      prog: P((s, d) => royalLevel(s, d), FLIGHT.royalLevel, 'Royal Chamber level'),
      reward: 'A faster lay rate; the first Flight requirement' },
    { id: 'm_soldiers', kind: 'unlock', title: 'Raise your first soldiers', go: { tab: 'research', label: 'Research → Warfare' },
      why: 'Rival raids grow every season. Soldiers guard the brood, and war parties win new land.',
      steps: [
        S('Research Polymorphism (Warfare)', (s) => owns(s, 'polymorphism')),
        S('Dig a Barracks', (s) => chambers(s, 'barracks').length > 0),
        S('Raise a soldier (Colony → Castes)', (s) => num(s.run.colony.adults.soldier) >= 1),
      ],
      reward: 'Defence against raids, and war parties for new land' },
    { id: 'm_thousand', kind: 'achievement', ach: 'ach_thousand_strong', title: 'A Thousand Strong', go: { tab: 'build', label: 'Build → Chambers' },
      why: 'More adults means more of everything. Housing and brood slots are usually the limit: add Galleries and Nurseries.',
      steps: [
        S('Have 250 adults at once', (s) => adults(s) >= 250 || earned(s, 'ach_thousand_strong')),
        S('Have 500 adults at once', (s) => adults(s) >= 500 || earned(s, 'ach_thousand_strong')),
        S('Have 1,000 adults at once', (s) => earned(s, 'ach_thousand_strong')),
      ],
      prog: AP('ach_thousand_strong', 'adults'),
      reward: achReward('ach_thousand_strong') },
    { id: 'm_fungus', kind: 'milestone', title: 'Start a fungus garden', go: { tab: 'research', label: 'Research → Husbandry' },
      why: 'Fungus feeds Fungal Brood and opens a second economy that does not depend on foraging.',
      steps: [
        S('Research Aphid Husbandry', (s) => owns(s, 'aphid_husbandry')),
        S('Research Leafcutting', (s) => owns(s, 'leafcutting')),
        S('Research Fungiculture', (s) => owns(s, 'fungiculture')),
        S('Dig a Fungus Garden (row 24 or deeper)', (s) => chambers(s, 'fungus_garden').length > 0),
        S('Put gardeners to work', (s) => job(s, 'gardener') >= 1),
      ],
      reward: 'Fungus income and Fungal Brood' },
    { id: 'm_winter', kind: 'achievement', ach: 'ach_first_winter', title: 'Survive your first winter', go: { tab: 'build', label: 'Build → Granary' },
      why: 'Winter slows foraging. A full Granary carries the colony through to spring.',
      steps: [
        S('Dig a Granary for a bigger food store', (s) => chambers(s, 'granary').length > 0),
        S('Reach the spring of year 1', (s) => earned(s, 'ach_first_winter') || num(s.meta.season && s.meta.season.year) >= 1),
      ],
      reward: achReward('ach_first_winter') },
  ],
  pre: [
    flightQuest('p_flight'),
    { id: 'p_rear', kind: 'prestige', title: 'Rear alates before you fly', go: { tab: 'prestige', sub: 'flight', label: 'Prestige → Flight' },
      why: 'Each alate you rear yourself adds 2% to the flight (up to ' + FLIGHT.rearedMax + '). Queued alates cost nothing until they are laid.',
      steps: [
        S('Queue alates in Alate rearing', (s) => num(s.run.colony.rearRequested) > 0 || num(s.run.colony.alatesReared) > 0 || num(obj(s.run.colony.eggs).alate) > 0),
        S('Rear ' + FLIGHT.rearedMax + ' alates', (s) => num(s.run.colony.alatesReared) >= FLIGHT.rearedMax,
          (s) => fmtCount(num(s.run.colony.alatesReared)) + ' / ' + FLIGHT.rearedMax),
      ],
      prog: P((s) => num(s.run.colony.alatesReared), FLIGHT.rearedMax, 'reared'),
      reward: 'Up to +' + Math.round(FLIGHT.rearedMax * FLIGHT.rearedPer * 100) + '% flight alates' },
    { id: 'p_peak', kind: 'achievement', ach: 'ach_peak_timing', title: 'Peak Timing', go: { tab: 'prestige', sub: 'flight', label: 'Prestige → Flight' },
      why: 'Alates per minute rises, peaks, then falls. Flying near the peak gets the most for your time.',
      steps: [
        S('Meet every Flight requirement', (s, d) => !!obj(proj(d).fly).ok || earned(s, 'ach_peak_timing')),
        S('Fly within 60 s of the alates/min peak (the meter glows)', (s) => earned(s, 'ach_peak_timing')),
      ],
      reward: achReward('ach_peak_timing') },
    { id: 'p_flightday', kind: 'achievement', ach: 'ach_flying_ant_day', title: 'Flying Ant Day', go: { tab: 'prestige', sub: 'flight', label: 'Prestige → Flight' },
      why: 'On a Flight Day (a summer event) every colony swarms at once. Flying then earns more.',
      steps: [
        S('Wait for a Flight Day in summer', (s) => earned(s, 'ach_flying_ant_day')),
        S('Fly during it', (s) => earned(s, 'ach_flying_ant_day')),
      ],
      reward: achReward('ach_flying_ant_day') },
  ],
  post: [
    { id: 'q_traits', kind: 'prestige', title: 'Spend your alates on Bloodline traits', go: { tab: 'prestige', sub: 'bloodline', label: 'Prestige → Bloodline' },
      why: 'Unspent alates do nothing. Founding Stores and Nanitic Vigor make every new run start faster.',
      steps: [
        S('Buy Founding Stores', (s) => trait(s, 'founding_stores') > 0),
        S('Buy Nanitic Vigor', (s) => trait(s, 'nanitic_vigor') > 0),
        S('Buy Remembered Paths', (s) => trait(s, 'remembered_paths') > 0),
      ],
      reward: 'A faster start on every run' },
    flightQuest('q_flight'),
    { id: 'q_hardships', kind: 'unlock', title: 'Unlock Hardships', go: { tab: 'prestige', sub: 'hardships', label: 'Prestige → Hardships' },
      why: 'Hardships are runs with a handicap (Eternal Winter, Pacifist…). Each tier you clear gives a permanent bonus.',
      steps: [S('Earn ' + HARDSHIP.unlockAlates + ' alates in total', (s) => counter(s, 'alatesLife') >= HARDSHIP.unlockAlates,
        (s) => fmtCount(counter(s, 'alatesLife')) + ' / ' + HARDSHIP.unlockAlates)],
      prog: P((s) => counter(s, 'alatesLife'), HARDSHIP.unlockAlates, 'alates'),
      reward: 'Hardships: harder runs with permanent rewards' },
    { id: 'q_swift', kind: 'achievement', ach: 'ach_swift_swarm', title: 'Swift Swarm', go: { tab: 'build', label: 'Build → Blueprints' },
      why: 'A flight within 20 minutes of the run start shows the colony has mastered its own founding.',
      steps: [
        S('Own Founding Stores and Nanitic Vigor', (s) => trait(s, 'founding_stores') > 0 && trait(s, 'nanitic_vigor') > 0),
        S('Fly within 20 minutes of a run start', (s) => earned(s, 'ach_swift_swarm')),
      ],
      reward: achReward('ach_swift_swarm') },
  ],
  super: [
    { id: 's_super', kind: 'prestige', title: 'Form a Supercolony', go: { tab: 'prestige', sub: 'supercolony', label: 'Prestige → Supercolony' },
      why: 'A Supercolony resets the Flight layer for kinship, a permanent multiplier on food.',
      steps: [
        S('Own the Budding trait', (s, d) => !!obj(proj(d).superc).budding || trait(s, 'budding') > 0),
        S('Conquer the Old Ridge Supercolony this run', (s, d) => !!obj(proj(d).superc).oldRidge),
        S('Alates this cycle ≥ ' + fmtCount(SUPER.alatesMin), (s) => num(s.cycle && s.cycle.alatesCycle) >= SUPER.alatesMin,
          (s) => fmtCount(num(s.cycle && s.cycle.alatesCycle)) + ' / ' + fmtCount(SUPER.alatesMin)),
      ],
      prog: P((s) => num(s.cycle && s.cycle.alatesCycle), SUPER.alatesMin, 'alates this cycle'),
      reward: 'Kinship, which multiplies food on every run' },
    { id: 's_ridge', kind: 'achievement', ach: 'ach_old_ridge_falls', title: 'The Old Ridge Falls', go: { tab: 'map', sub: 'war', label: 'Map → War' },
      why: 'The Old Ridge Supercolony is the toughest rival nearby. Conquering it is one of the Supercolony requirements.',
      steps: [
        S('Have a war party ready (soldiers or supermajors)', (s) => num(s.run.colony.adults.soldier) + num(s.run.colony.adults.supermajor) > 0 || earned(s, 'ach_old_ridge_falls')),
        S('Conquer the Old Ridge', (s) => earned(s, 'ach_old_ridge_falls')),
      ],
      reward: achReward('ach_old_ridge_falls') },
    { id: 's_spec', kind: 'prestige', title: 'Toward Speciation', go: { tab: 'prestige', sub: 'speciation', label: 'Prestige → Speciation' },
      why: 'Speciation, the third prestige layer, turns kinship into genes, which change how your species plays.',
      steps: [
        S('Own Megacolony (Federation)', (s, d) => !!obj(proj(d).spec).megacolony),
        S('Defeat all three Argentine Front nests this run', (s, d) => !!obj(proj(d).spec).front),
        S('Kinship this era ≥ ' + fmtCount(SPEC.kinshipMin), (s) => num(s.era && s.era.kinshipLife) >= SPEC.kinshipMin,
          (s) => fmtCount(num(s.era && s.era.kinshipLife)) + ' / ' + fmtCount(SPEC.kinshipMin)),
      ],
      prog: P((s) => num(s.era && s.era.kinshipLife), SPEC.kinshipMin, 'kinship this era'),
      reward: 'Genes and the Genome tree' },
    { id: 's_family', kind: 'achievement', ach: 'ach_one_family', title: 'One Family', go: { tab: 'prestige', sub: 'supercolony', label: 'Prestige → Supercolony' },
      why: 'Your first Supercolony joins your daughter colonies into one family.',
      steps: [S('Form your first Supercolony', (s) => earned(s, 'ach_one_family') || counter(s, 'supercolonies') > 0)],
      reward: achReward('ach_one_family') },
  ],
});

/** Minimum number of unfinished quests on a page list; achievements close to done fill the gap. */
export const QUEST_MIN_OPEN = 3;
/** At most this many quests in the book. */
export const QUEST_MAX = 6;

/**
 * Evaluate one quest definition against the state.
 * @param {Object} def
 * @param {Object} s
 * @param {Object} d
 * @returns {Object} { id, kind, kindLabel, title, why, go, steps: [{ text, done, note }], done, total, complete, frac, progText, reward }
 */
export function evalQuest(def, s, d) {
  const steps = def.steps.map((st) => ({ text: st.text, done: !!q(() => st.done(s, d), false), note: st.note ? String(q(() => st.note(s, d), '') || '') : '' }));
  const doneN = steps.filter((x) => x.done).length;
  const total = steps.length;
  const achDone = def.ach ? earned(s, def.ach) : false;
  const complete = achDone || (total > 0 && doneN === total);
  let pFrac = null;
  let progText = fmtCount(complete ? total : doneN) + ' / ' + fmtCount(total) + ' steps';
  if (def.prog) {
    const cur = num(q(() => def.prog.cur(s, d), 0));
    const target = num(typeof def.prog.target === 'function' ? q(() => def.prog.target(s, d), 1) : def.prog.target, 1);
    if (target > 0) {
      pFrac = Math.max(0, Math.min(1, cur / target));
      progText = fmt(Math.min(cur, target)) + ' / ' + fmt(target) + ' ' + def.prog.label + ' · ' + progText;
    }
  }
  let frac = complete ? 1 : total > 0 ? doneN / total : 0;
  if (!complete && pFrac !== null) frac = Math.max(frac, pFrac * 0.999);
  if (!complete) frac = Math.min(0.99, frac);
  const reward = typeof def.reward === 'function' ? String(q(() => def.reward(s, d), '') || '') : String(def.reward || '');
  return { id: def.id, kind: def.kind, kindLabel: QUEST_KINDS[def.kind] || '', title: def.title, why: def.why, go: def.go || null,
    steps: complete ? steps.map((x) => ({ ...x, done: true })) : steps, done: complete ? total : doneN, total, complete, frac, progText, reward };
}

/**
 * An achievement goal as a quest (the fill-in when the stage's own quests are nearly all done).
 * @param {{ id: string }} g a nextGoals row
 */
function goalDef(g) {
  const a = obj(ACHIEVEMENTS[g.id]);
  return { id: 'goal:' + g.id, kind: 'achievement', ach: g.id, title: nameOf('achievement', g.id), go: { tab: 'achievements', label: 'Achievements' },
    why: 'An achievement within reach. Every achievement earned raises production a little.',
    steps: [S(String(a.desc || '').replace(/\.$/, ''), (s) => earned(s, g.id))],
    prog: AP(g.id, ''), reward: achReward(g.id) };
}

/**
 * The quest book for a state: the stage (chapter) and its evaluated quests.
 * @param {Object} s
 * @param {Object} d
 * @returns {{ stage: Object, quests: Object[] }}
 */
export function questBook(s, d) {
  const sid = questStage(s);
  const stage = QUEST_STAGES.find((x) => x.id === sid) || QUEST_STAGES[0];
  if (!s || !s.run) return { stage, quests: [] };
  const defs = (QUESTS[sid] || []).slice();
  let quests = defs.map((def) => evalQuest(def, s, d));
  let open = quests.filter((x) => !x.complete).length;
  if (open < QUEST_MIN_OPEN) {
    const have = new Set(defs.map((x) => x.ach).filter(Boolean));
    const goals = q(() => nextGoals(s, d, QUEST_MAX), []);
    for (const g of Array.isArray(goals) ? goals : []) {
      if (open >= QUEST_MIN_OPEN || quests.length >= QUEST_MAX + 2) break;
      if (!g || !g.id || have.has(g.id)) continue;
      quests.push(evalQuest(goalDef(g), s, d));
      open++;
    }
  }
  // finished quests move to the end once more than QUEST_MAX are listed
  if (quests.length > QUEST_MAX) quests = quests.filter((x) => !x.complete).concat(quests.filter((x) => x.complete)).slice(0, QUEST_MAX);
  return { stage, quests };
}

/**
 * Next unfinished step of a quest: { i, text } or null.
 * @param {Object} quest evaluated
 */
export function nextStep(quest) {
  const steps = quest && Array.isArray(quest.steps) ? quest.steps : [];
  for (let i = 0; i < steps.length; i++) if (!steps[i].done) return { i, text: steps[i].text };
  return null;
}

// ------------------------------------------------------------------------------------------------ tracked quest
/** localStorage key of the tracked quest id (per-browser convenience). */
export const TRACK_KEY = 'sld.quest.tracked';

/** The browser's localStorage, or null. */
function browserStore() {
  try {
    const w = typeof window !== 'undefined' ? window : globalThis;
    return w && w.localStorage ? w.localStorage : null;
  } catch {
    return null;
  }
}

let memTracked = null;

/**
 * Tracked quest id (null: none). Falls back to this session's value when storage is blocked.
 * @param {Storage|null} [store]
 * @returns {string|null}
 */
export function loadTracked(store = browserStore()) {
  try {
    if (!store) return memTracked;
    const v = store.getItem(TRACK_KEY);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return memTracked;
  }
}

/**
 * Remember the tracked quest (null clears it).
 * @param {string|null} id
 * @param {Storage|null} [store]
 */
export function saveTracked(id, store = browserStore()) {
  memTracked = id || null;
  try {
    if (!store) return;
    if (id) store.setItem(TRACK_KEY, String(id)); else store.removeItem(TRACK_KEY);
  } catch { /* storage blocked: this session only */ }
}
