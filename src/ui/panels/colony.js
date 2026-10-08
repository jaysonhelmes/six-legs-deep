// Colony panel: brood pipeline (eggs / larvae / pupae, lay rate, housing, egg reserve slider, Fungal Brood), caste
// target counts (C151: stepper, Max, "Keep berths filled", chitin reserve) and "Retire to workers", job chips with +/− (and drag between chips), automation modes, ratio targets (a target slider per chip; +/− and drags edit targets in auto mode, C94) and
// presets (Adaptations have their own tab since C143, panels/adaptations.js; alate rearing lives on the Prestige tab's Flight view, C116). Owner: WP9. Contract: ARCHITECTURE §14.5 (Colony row), §8.1, §9.
// Queries: population.broodSummary, jobs.idleMinors, jobs.jobCap, jobs.withTarget, jobs.effectiveTargets, stats.eggCost.
// Feedback pass 7: sections fold by their heading (C229), "Per click" job step shown on the +/− buttons (C230), the
// nurse cap row (C231) and caste / army upkeep lines (C233).

import { h, setText, setProp, show, toggleClass, syncList, setCost } from '../dom.js';
import { fmt, fmtRate, fmtCount, fmtPct } from '../format.js';
import { nameOf, JOB_TIPS, CASTE_TIPS } from '../text.js';
import { isShown, hasResearch, traitLevel, fedLevel, num, arr, obj } from '../reveal.js';
import { broodSummary, housingBrood, chitinReserve, casteStatus, chitinReserveMax } from '../../systems/population.js';
import { idleMinors, jobCap, withTarget, effectiveTargets } from '../../systems/jobs.js';
import { eggCost } from '../../systems/stats.js';
import { JOB_ORDER, JOBS, TARGET_UI } from '../../data/jobs.js';
import { CASTES } from '../../data/castes.js';
import { SLIDERS } from '../../data/economy.js';
import { makeAct, sliderRow, note, progressBar, collapsible } from './common.js';

/** Job ids when data/jobs.js is still empty. */
export const JOB_FALLBACK = Object.freeze(['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener']);
/** Job unlock keys when data/jobs.js is still empty (ARCHITECTURE §6.2). */
export const JOB_UNLOCK_FALLBACK = Object.freeze({ forager: null, digger: 'job_digger', nurse: 'panel_colony', scout: 'job_scout',
  herder: 'job_herder', leafcutter: 'job_leafcutter', gardener: 'job_gardener' });
/** C143: the Adaptation helpers moved to panels/adaptations.js; re-exported for older importers. */
export { ADAPT_FALLBACK, ADAPT_UNLOCK_FALLBACK, adaptBulk } from './adaptations.js';
/** Caste unlock keys (slider castes). */
const CASTE_KEYS = Object.freeze({ soldier: 'caste_soldier', supermajor: 'caste_supermajor', replete: 'caste_replete' });
const STEPS = [1, 10, 100, 'max'];

/**
 * C230: the job step that applies with `minors` minor workers: the chosen numeric step while the colony has at least
 * that many minors, else the largest step that fits (×1 at least); 'max' always applies.
 * @param {number|'max'} chosen
 * @param {number} minors
 * @returns {number|'max'}
 */
export function effectiveStep(chosen, minors) {
  if (chosen === 'max') return 'max';
  const room = Math.max(1, Math.floor(num(minors) + 1e-9));
  let best = 1;
  for (const v of STEPS) if (v !== 'max' && v <= room && v <= num(chosen, 1)) best = v;
  return best;
}

/**
 * C230: label of a job +/− button for a step: "+10", "−1", "+Max".
 * @param {'+'|'−'} sign
 * @param {number|'max'} step
 * @returns {string}
 */
export function stepLabel(sign, step) {
  return sign + (step === 'max' ? 'Max' : fmtCount(step));
}

/** C233: '0.25 food/s'. */
export function foodRate(v) {
  return fmtRate(v).replace(/\/s$/, '') + ' food/s';
}

/**
 * C233: food upkeep of one target caste: { each, total } food/s (DESIGN §5.7, before the winter reductions).
 * @param {string} c caste
 * @param {number} have adults of that caste
 * @returns {{ each: number, total: number }}
 */
export function casteUpkeep(c, have) {
  const each = num(CASTES[c] && CASTES[c].upkeep);
  return { each, total: each * Math.max(0, num(have)) };
}

/**
 * C233: the upkeep line of a caste target row: "Upkeep 0.25 food/s each · 3.0 food/s for 12".
 * @param {string} c
 * @param {number} have
 * @returns {string}
 */
export function casteUpkeepLine(c, have) {
  const u = casteUpkeep(c, have);
  const n = Math.floor(num(have) + 1e-9);
  return 'Upkeep ' + foodRate(u.each) + ' each · ' + foodRate(u.total) + ' for ' + fmtCount(n);
}

/**
 * C233: food/s the army (soldiers + supermajors) eats, and that share of all upkeep — the cost of keeping berths full.
 * @param {Object} adults run.colony.adults
 * @returns {{ total: number, share: number }}
 */
export function armyUpkeep(adults) {
  const a = obj(adults);
  const total = casteUpkeep('soldier', a.soldier).total + casteUpkeep('supermajor', a.supermajor).total;
  let all = 0;
  for (const c of ['minor', 'soldier', 'supermajor', 'replete']) all += casteUpkeep(c, a[c]).total;
  return { total, share: all > 0 ? total / all : 0 };
}

/**
 * C231: the nurse row's cap tooltip.
 * @param {number} cap jobs.jobCap(s, d, 'nurse')
 * @param {number} slots d.stats.broodSlots
 * @param {number} have nurses now
 * @returns {string}
 */
export function nurseCapTip(cap, slots, have) {
  const per = num(JOBS.nurse && JOBS.nurse.fx && JOBS.nurse.fx.maxPerSlot, 4);
  return 'Up to ' + fmtCount(cap) + ' nurses help: ' + per + ' per brood slot (' + fmtCount(slots) + ' slots), and the queen counts as one. '
    + 'More nurses would not speed brood, so no more can be assigned. More brood slots (Nurseries) raise the cap.'
    + (num(have) > cap + 1e-9 ? ' ' + fmtCount(num(have) - cap) + ' extra nurses do nothing now: move them to another job.' : '');
}
/** Slider limit (DESIGN §5.1 egg reserve ≤ 90 % of the food cap). */
const RESERVE_MAX = num(SLIDERS && SLIDERS.eggReserveMax, 0.9);
/** C151 caste target counts: upper bound and the stepper's step sizes. */
const GOAL_MAX = num(SLIDERS && SLIDERS.casteGoalMax, 1e30);
const GOAL_STEPS = Array.isArray(SLIDERS && SLIDERS.casteGoalSteps) && SLIDERS.casteGoalSteps.length ? SLIDERS.casteGoalSteps : [1, 10];
/** Berth chamber per target caste (C151 "cap" wording). */
const CAP_NAME = Object.freeze({ soldier: 'Barracks', supermajor: 'War Hall', replete: 'Repletion Hall' });

/** C104 chitin reserve ladder (absolute chitin per slider step). */
const CHITIN_STEPS = Array.isArray(SLIDERS && SLIDERS.chitinReserveSteps) && SLIDERS.chitinReserveSteps.length ? SLIDERS.chitinReserveSteps : [0];

/**
 * C104: the ladder index shown for a stored chitin reserve (the largest step ≤ amount).
 * @param {number} amount
 * @returns {number}
 */
export function chitinStepIndex(amount) {
  let k = 0;
  for (let i = 0; i < CHITIN_STEPS.length; i++) if (CHITIN_STEPS[i] <= num(amount) + 1e-9) k = i;
  return k;
}

/** Ratio-target step of one +/− click or chip drag in auto mode (C94). */
const TARGET_STEP = num(TARGET_UI && TARGET_UI.step, 0.05);
/** How long (ms) a sent target map is used as the base for the next nudge, before the queued command has applied. */
const TARGET_PENDING_MS = 600;

/**
 * Job targets from the current job split (fractions of all assigned workers, Σ ≤ 1, rounded to 0.1 %), used when the
 * player turns Automatic jobs on so that nothing moves until a target is changed (C94). null when nobody has a job.
 * @param {Object<string, number>} jobs
 * @returns {Object<string, number>|null}
 */
export function targetsFromJobs(jobs) {
  const ids = jobIds();
  let total = 0;
  for (const j of ids) total += Math.max(0, num(obj(jobs)[j]));
  if (!(total > 0)) return null;
  const out = {};
  let sum = 0;
  for (const j of ids) {
    out[j] = Math.floor((Math.max(0, num(obj(jobs)[j])) / total) * 1000) / 1000;
    sum += out[j];
  }
  const big = ids.reduce((a, j) => (out[j] > out[a] ? j : a), ids[0]);
  out[big] = Math.round((out[big] + Math.max(0, 1 - sum)) * 1000) / 1000;
  return out;
}

/** Job ids in display order. */
export function jobIds() {
  return JOB_ORDER.length ? JOB_ORDER : JOB_FALLBACK;
}

/** Unlock key of a job. */
export function jobKey(id) {
  const j = JOBS[id];
  if (j && 'unlock' in j) return j.unlock;
  return JOB_UNLOCK_FALLBACK[id] ?? null;
}

/** Unlock key of a caste (data `unlock`, else the documented key). */
function casteKey(c) {
  const x = CASTES[c];
  if (x && x.unlock) return x.unlock;
  return CASTE_KEYS[c] || null;
}

/**
 * C143 berth lines of the Castes section. With the War Hall (d.stats.warBerths present, B's nest work) soldiers live in
 * Barracks berths and supermajors in War Hall berths; without that field the Barracks berths hold both. Each line only
 * shows once its caste / chamber is revealed or the capacity exists.
 * @param {Object} s
 * @param {Object} st d.stats
 * @param {Object} adults run.colony.adults
 * @returns {string[]}
 */
export function berthLines(s, st, adults) {
  const out = [];
  const a = obj(adults);
  const x = obj(st);
  const hasWar = typeof x.warBerths === 'number' && Number.isFinite(x.warBerths);
  if (isShown(s, 'chamber_barracks') || num(x.berths) > 0) {
    const used = hasWar ? num(a.soldier) : num(a.soldier) + num(a.supermajor);
    out.push('Barracks berths ' + fmtCount(used) + '/' + fmtCount(num(x.berths)) + (hasWar ? ' (soldiers)' : ' (soldiers and supermajors)'));
  }
  if (hasWar && (num(x.warBerths) > 0 || num(a.supermajor) > 0 || isShown(s, casteKey('supermajor')) || isShown(s, 'chamber_war_hall'))) {
    out.push('War Hall berths ' + fmtCount(num(a.supermajor)) + '/' + fmtCount(num(x.warBerths)) + ' (supermajors)');
  }
  if (isShown(s, 'caste_replete')) out.push('Replete berths ' + fmtCount(num(a.replete)) + '/' + fmtCount(num(x.repleteBerths)));
  return out;
}

/**
 * C151 status line of a caste target row: "12 / 20 (cap 30) · 18 berths free".
 * @param {{ have: number, goal: number, cap: number, free: number }} st casteStatus()
 * @returns {string}
 */
export function casteGoalLine(st) {
  const x = obj(st);
  const cap = Math.floor(num(x.cap) + 1e-9);
  const free = Math.floor(num(x.free) + 1e-9);
  return fmtCount(Math.floor(num(x.have) + 1e-9)) + ' / ' + fmtCount(Math.floor(num(x.goal) + 1e-9)) + ' (cap ' + fmtCount(cap) + ')'
    + ' · ' + fmtCount(free) + (free === 1 ? ' berth' : ' berths') + ' free';
}

/**
 * C151: why the queen is or is not laying a caste right now (short player text).
 * @param {Object} s
 * @param {string} c caste
 * @param {{ have: number, goal: number, free: number }} st casteStatus()
 * @param {Object|null} cost stats.eggCost(c)
 * @param {number} reserve chitin reserve
 * @returns {string}
 */
export function casteGoalReason(s, c, st, cost, reserve) {
  const x = obj(st);
  if (s.run.hardship === 'monomorphic' || (s.run.hardship === 'pacifist' && c !== 'replete')) return 'Not in this Hardship.';
  if (!(num(x.goal) - num(x.have) > 1e-9)) return num(x.goal) > 0 ? 'Target reached: the queen lays workers.' : '';
  if (!(num(x.free) > 1e-9)) return 'No free ' + CAP_NAME[c] + ' berth: build or enlarge one.';
  const k = obj(cost);
  const held = c === 'replete' ? 0 : num(reserve);
  if (num(k.chitin) > 0 && num(s.run.res.chitin) - held < num(k.chitin)) {
    return held > 0 ? 'Waiting for chitin above the reserve (' + fmtCount(held) + ').' : 'Waiting for chitin.';
  }
  for (const r of ['fungus', 'honeydew']) if (num(k[r]) > 0 && num(s.run.res[r]) < num(k[r])) return 'Waiting for ' + r + '.';
  return 'Laying ' + nameOf('caste', c).toLowerCase() + 's before workers.';
}

/** Safe query call. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Colony panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 */
export function createPanel(root, { game, ui, bridge }) {
  const act = makeAct(game, bridge);
  const el = h('div', { class: 'panel panel-colony' });
  root.appendChild(el);
  let step = 1;
  /** Last target map sent ({ map, at }): the base for the next nudge until the queued command has applied. */
  let pendingTargets = null;

  // --- brood pipeline ---
  const eggN = h('span', { class: 'pipe-num' });
  const larvaN = h('span', { class: 'pipe-num' });
  const pupaN = h('span', { class: 'pipe-num' });
  const frozenBadge = h('span', { class: 'badge badge-frost' });
  const pipe = h('div', { class: 'pipeline' },
    h('div', { class: 'pipe-cell', dataset: { tip: 'Eggs: freshly laid, a quarter of development.' } }, h('i', { class: 'ico ico-egg' }), eggN, h('span', { class: 'pipe-label', text: 'Eggs' })),
    h('span', { class: 'pipe-arrow', text: '›', attrs: { 'aria-hidden': 'true' } }),
    h('div', { class: 'pipe-cell', dataset: { tip: 'Larvae: growing, fed by nurses.' } }, h('i', { class: 'ico ico-larva' }), larvaN, h('span', { class: 'pipe-label', text: 'Larvae' })),
    h('span', { class: 'pipe-arrow', text: '›', attrs: { 'aria-hidden': 'true' } }),
    h('div', { class: 'pipe-cell', dataset: { tip: 'Pupae: almost ready to hatch.' } }, h('i', { class: 'ico ico-pupa' }), pupaN, h('span', { class: 'pipe-label', text: 'Pupae' })));
  const slotBar = progressBar('bar-brood');
  const houseBar = progressBar('bar-house');
  const layEl = h('dd', { dataset: { tipKey: 'lay' } });   // C192: hover for every factor of the lay rate
  const eggCostEl = h('span', { class: 'cost' });
  const naniticEl = h('p', { class: 'note' });
  const reserve = sliderRow('Egg reserve', { min: 0, max: Math.round(RESERVE_MAX * 100), step: 5, tip: 'Keep food for purchases: the queen will not spend it.' },
    (v) => act('setEggReserve', { frac: Math.max(0, Math.min(RESERVE_MAX, v / 100)) }, null, reserve.input));
  const fungalBox = h('input', { type: 'checkbox', class: 'check' });
  fungalBox.addEventListener('change', (ev) => act('setFungalBrood', { on: !!fungalBox.checked }, ev, fungalBox));
  const fungalRow = h('label', { class: 'toggle-row', dataset: { tip: 'Brood ×0.75 time; costs fungus per egg.' } }, fungalBox, h('span', { text: 'Fungal Brood' }));
  const broodTitle = h('h3', { class: 'sec-title', text: 'Brood' });
  const broodSec = h('section', { class: 'sec sec-brood' }, broodTitle, pipe, frozenBadge,
    slotBar.el, houseBar.el,
    h('dl', { class: 'kv' }, h('dt', { text: 'Lay rate' }), layEl, h('dt', { text: 'Next egg' }), h('dd', null, eggCostEl)),
    naniticEl, reserve.el, fungalRow);

  // --- castes ---
  const casteCounts = h('div', { class: 'caste-counts' });
  const casteEls = {};
  for (const c of ['minor', 'soldier', 'supermajor', 'replete']) {
    const n = h('span', { class: 'num' });
    const chip = h('span', { class: 'caste-chip', dataset: { tip: CASTE_TIPS[c] } }, h('i', { class: 'ico ico-' + c }), n, ' ' + nameOf('caste', c));
    casteEls[c] = { chip, n };
    casteCounts.appendChild(chip);
  }
  const berthsEl = h('p', { class: 'note' });
  // C151 caste target counts: per caste a stepper (−/+ by the ×1 / ×10 step, typed number), Max (= its berth cap) and
  // "Keep berths filled" (the target follows the cap).
  let goalStep = GOAL_STEPS[0];
  /** Last target sent per caste ({ v, at }): the base for the next +/− until the queued command has applied. */
  const pendingGoal = {};
  const goalStepRow = h('div', { class: 'seg seg-small caste-step', role: 'radiogroup', 'aria-label': 'Target step' });
  for (const sv of GOAL_STEPS) {
    goalStepRow.appendChild(h('button', { type: 'button', class: 'seg-btn' + (sv === goalStep ? ' selected' : ''), dataset: { step: String(sv) },
      text: '×' + sv, attrs: { 'aria-label': 'Change targets by ' + sv },
      on: { click: () => { goalStep = sv; for (const b of Array.from(goalStepRow.children)) toggleClass(b, 'selected', b.dataset.step === String(sv)); } } }));
  }
  const casteGoalRows = {};
  const casteSliderBox = h('div', { class: 'caste-targets' }, goalStepRow);
  for (const c of ['soldier', 'supermajor', 'replete']) {
    const row = createGoalRow(c);
    casteGoalRows[c] = row;
    casteSliderBox.appendChild(row.el);
  }
  // C104 chitin reserve: soldier / supermajor eggs only spend chitin above it (Adaptations and the Gate ignore it).
  const chitinRes = sliderRow('Chitin reserve', { min: 0, max: CHITIN_STEPS.length - 1, step: 1,
    tip: 'Soldier and supermajor eggs only spend chitin above this; minors are laid instead. Adaptations and the Gate ignore it.' },
  (v) => act('setChitinReserve', { amount: CHITIN_STEPS[Math.max(0, Math.min(CHITIN_STEPS.length - 1, Math.round(v)))] }, null, chitinRes.input));
  casteSliderBox.appendChild(chitinRes.el);
  const retireBox = h('div', { class: 'retire' });
  const retireRows = {};
  for (const c of ['soldier', 'supermajor']) {
    const cnt = h('span', { class: 'muted' });
    const mk = (label, nFn) => {
      const b = h('button', { type: 'button', class: 'btn btn-small', text: label,
        on: { click: (ev) => act('retireAdults', { caste: c, n: nFn() }, ev, b) } });
      return b;
    };
    const garrisonN = () => Math.floor(num(obj(game.d.combat && game.d.combat.garrison)[c]));
    const row = h('div', { class: 'row-between', dataset: { tip: 'Turn garrison ' + c + 's into workers. Needs housing; no refund.' } },
      h('span', null, 'Retire ' + nameOf('caste', c).toLowerCase() + 's ', cnt),
      h('span', { class: 'btn-row' }, mk('1', () => 1), mk('10', () => Math.min(10, Math.max(1, garrisonN()))), mk('All', () => Math.max(1, garrisonN()))));
    retireRows[c] = { row, cnt };
    retireBox.appendChild(row);
  }
  const retireTitle = h('h4', { class: 'sub-title', text: 'Retire to workers' });
  // C233: what the army eats, so a target below the cap has a visible payoff (less food upkeep, chitin kept)
  const armyUpkeepEl = h('p', { class: 'note army-upkeep',
    dataset: { tip: 'Every soldier and supermajor eats food every second (soldier ' + fmtRate(casteUpkeep('soldier', 1).each) + ', supermajor '
      + fmtRate(casteUpkeep('supermajor', 1).each) + ', a worker ' + fmtRate(casteUpkeep('minor', 1).each) + '), and each egg costs chitin. '
      + 'A target below the cap keeps that food and chitin for the economy; Keep berths filled trades them for defence.' } });
  const casteTitle = h('h3', { class: 'sec-title', text: 'Castes' });
  const casteSec = h('section', { class: 'sec sec-castes' }, casteTitle, casteCounts, berthsEl, armyUpkeepEl,
    h('p', { class: 'note', text: 'Larval diet decides caste. The queen raises each caste up to its target, then lays workers.' }), casteSliderBox,
    retireTitle, retireBox);

  // --- jobs ---
  const idleEl = h('span', { class: 'sec-meta' });
  // C230: "Per click 1 · 10 · 100 · Max" — the +/− buttons show the step ("+10"); a step larger than the workforce
  // falls back to the largest that fits (effectiveStep), and a new run (Flight) starts at 1 again.
  const stepRow = h('div', { class: 'seg seg-small', role: 'radiogroup', attrs: { 'aria-label': 'Workers moved per click' } });
  for (const sv of STEPS) {
    stepRow.appendChild(h('button', { type: 'button', class: 'seg-btn' + (sv === 1 ? ' selected' : ''), dataset: { step: String(sv) },
      text: sv === 'max' ? 'Max' : String(sv),
      attrs: { 'aria-label': sv === 'max' ? 'Move every available worker per click' : 'Move ' + sv + ' per click' },
      on: { click: () => { step = sv; markStep(); } } }));
  }
  const stepWrap = h('div', { class: 'job-step',
    dataset: { tip: 'How many workers one click on + or − moves. Max moves every idle worker (or every worker of that job). '
      + 'Steps bigger than your workforce are greyed out; a new run starts at 1.' } },
  h('span', { class: 'job-step-label', text: 'Per click' }), stepRow);
  let lastRun = null;
  /** The step that applies now (C230). */
  const curStep = () => effectiveStep(step, num(obj(game.s && game.s.run && game.s.run.colony && game.s.run.colony.adults).minor));
  function markStep() {
    const eff = String(curStep());
    for (const b of Array.from(stepRow.childNodes)) toggleClass(b, 'selected', b.dataset.step === eff);
  }
  const autoBox = h('input', { type: 'checkbox', class: 'check' });
  autoBox.addEventListener('change', (ev) => {
    const on = !!autoBox.checked;
    if (on && !game.s.run.colony.thresholdJobs) { // keep the current split: nothing moves until a target is changed
      const t = targetsFromJobs(game.s.run.colony.jobs);
      if (t) sendTargets(t, ev, autoBox);
    }
    act('setAutoJobs', { on }, ev, autoBox);
  });
  const autoRow = h('label', { class: 'toggle-row', dataset: { tip: 'Jobs follow the target ratios automatically: set a target on each job (+/− change it by 5%). Turning this on keeps your current split.' } }, autoBox, h('span', { text: 'Automatic jobs' }));
  const thrBox = h('input', { type: 'checkbox', class: 'check' });
  thrBox.addEventListener('change', (ev) => act('setThresholdJobs', { on: !!thrBox.checked }, ev, thrBox));
  const thrRow = h('label', { class: 'toggle-row', dataset: { tip: 'Workers shift toward the current bottleneck (nurses for full brood slots, diggers for a long dig queue, herders when honeydew is short) and drift back to your targets once it clears.' } }, thrBox, h('span', { text: 'Respond to bottlenecks' }));
  const jobList = h('div', { class: 'job-list' });
  const targetNote = h('p', { class: 'note' });
  const presetRow = h('div', { class: 'btn-row presets' });
  const presetBtns = [];
  for (let slot = 0; slot < 3; slot++) {
    const save = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Save ' + (slot + 1),
      on: { click: (ev) => act('saveJobPreset', { slot, name: 'Preset ' + (slot + 1) }, ev, save) } });
    const apply = h('button', { type: 'button', class: 'btn btn-small', text: 'Use ' + (slot + 1),
      on: { click: (ev) => { if (act('applyJobPreset', { slot }, ev, apply).ok) pendingTargets = null; } } });
    presetBtns.push({ save, apply });
    presetRow.append(h('span', { class: 'preset' }, apply, save));
  }
  const jobsTitle = h('h3', { class: 'sec-title' }, 'Jobs ', idleEl);
  const jobsSec = h('section', { class: 'sec sec-jobs' }, jobsTitle, stepWrap, h('div', { class: 'toggles' }, autoRow, thrRow), jobList, targetNote, presetRow);

  const empty = note('Your first worker is on the way. The queen tends her first egg.');
  el.append(empty, broodSec, casteSec, jobsSec);   // Adaptations: own tab (C143); alate rearing: Prestige → Flight (C116)
  // C229: each section folds by its heading, remembered per browser
  const folds = { brood: collapsible(broodSec, broodTitle, 'colony:brood'), castes: collapsible(casteSec, casteTitle, 'colony:castes'),
    jobs: collapsible(jobsSec, jobsTitle, 'colony:jobs') };

  /** C151: casteStatus of the live game (null if not available). */
  function goalStatus(c) {
    return q(() => casteStatus(game.s, game.d, c), null);
  }

  /** C151: the target count to build the next +/− on (the last value sent while its command is still queued). */
  function baseGoal(c) {
    const p = pendingGoal[c];
    if (p && Date.now() - p.at < TARGET_PENDING_MS) return p.v;
    delete pendingGoal[c];
    return Math.floor(num(obj(goalStatus(c)).goal) + 1e-9);
  }

  /** C151: send one caste's target count (whole ants, 0..GOAL_MAX). */
  function setGoal(c, v, ev = null, src = null) {
    const n = Math.max(0, Math.min(GOAL_MAX, Math.floor(num(v))));
    const res = act('setCasteTargets', { [c]: n }, ev, src);
    if (res.ok) pendingGoal[c] = { v: n, at: Date.now() };
    return res;
  }

  /** C151 caste target row: name + "have / target (cap)", stepper, Max, Keep berths filled, per-egg cost and status. */
  function createGoalRow(c) {
    const lc = nameOf('caste', c).toLowerCase();
    const status = h('span', { class: 'caste-goal-status muted' });
    const input = h('input', { type: 'number', class: 'input input-small caste-goal-input', min: 0, step: 1,
      attrs: { 'aria-label': nameOf('caste', c) + ' target', inputmode: 'numeric' } });
    input.style.width = '6.5em';
    input.addEventListener('change', (ev) => {
      const v = Number(input.value);
      if (input.value !== '' && Number.isFinite(v)) setGoal(c, v, ev, input);
    });
    const minus = h('button', { type: 'button', class: 'btn btn-icon', text: '−', attrs: { 'aria-label': 'Lower the ' + lc + ' target' },
      on: { click: (ev) => setGoal(c, baseGoal(c) - goalStep, ev, minus) } });
    const plus = h('button', { type: 'button', class: 'btn btn-icon', text: '+', attrs: { 'aria-label': 'Raise the ' + lc + ' target' },
      on: { click: (ev) => setGoal(c, baseGoal(c) + goalStep, ev, plus) } });
    const max = h('button', { type: 'button', class: 'btn btn-small', text: 'Max',
      attrs: { 'aria-label': 'Set the ' + lc + ' target to the ' + CAP_NAME[c] + ' berths' },
      dataset: { tip: 'Set the target to the ' + CAP_NAME[c] + ' berths you have now.' },
      on: { click: (ev) => setGoal(c, Math.floor(num(obj(goalStatus(c)).cap) + 1e-9), ev, max) } });
    const fillBox = h('input', { type: 'checkbox', class: 'check' });
    fillBox.addEventListener('change', (ev) => {
      if (act('setCasteFill', { caste: c, on: !!fillBox.checked }, ev, fillBox).ok) delete pendingGoal[c];
    });
    const fillRow = h('label', { class: 'toggle-row caste-fill',
      dataset: { tip: 'The target follows your ' + CAP_NAME[c] + ' berths, including new ones. The chitin reserve still applies.' } },
    fillBox, h('span', { text: 'Keep berths filled' }));
    const cost = h('span', { class: 'cost' });
    const reason = h('span', { class: 'muted caste-goal-reason' });
    const el = h('div', { class: 'caste-goal', dataset: { caste: c, tip: CASTE_TIPS[c] } },
      h('div', { class: 'row-between' }, h('span', { class: 'caste-goal-name' }, h('i', { class: 'ico ico-' + c, attrs: { 'aria-hidden': 'true' } }),
        ' ' + nameOf('caste', c) + ' target'), status),
      h('div', { class: 'btn-row caste-goal-ctrl' }, minus, input, plus, max, fillRow),
      h('p', { class: 'note caste-goal-cost' }, 'Per egg ', cost, ' ', reason));
    // C233: the food this caste eats every second, so a lower target has a visible payoff
    const upkeep = h('p', { class: 'note caste-goal-upkeep',
      dataset: { tip: 'Food eaten every second by each ' + lc + ' and by all of them (less in winter with Overwintering, Hibernacula and repletes). '
        + 'A lower target means less upkeep' + (c === 'replete' ? '.' : ' and more chitin left for Adaptations and the Gate.') } });
    el.appendChild(upkeep);
    el.style.margin = '6px 0';
    return { el, status, input, minus, plus, max, fillBox, fillRow, cost, reason, upkeep };
  }

  /** C151: refresh one caste target row. */
  function updateGoalRow(r, c, s, d, reserve) {
    const st = q(() => casteStatus(s, d, c), null) || { have: 0, goal: 0, cap: 0, free: 0, fill: false };
    const blocked = s.run.hardship === 'monomorphic' || (s.run.hardship === 'pacifist' && c !== 'replete');
    setText(r.status, casteGoalLine(st));
    const goal = Math.floor(num(st.goal) + 1e-9);
    const p = pendingGoal[c];
    if (p && (p.v === goal || Date.now() - p.at >= TARGET_PENDING_MS)) delete pendingGoal[c];
    setProp(r.input, 'value', String(pendingGoal[c] ? pendingGoal[c].v : goal));
    for (const b of [r.minus, r.plus, r.max, r.input, r.fillBox]) setProp(b, 'disabled', blocked);
    setProp(r.fillBox, 'checked', !!st.fill);
    toggleClass(r.el, 'filling', !!st.fill);
    const cost = q(() => eggCost(s, d, c), null);
    setCost(r.cost, cost, s);
    setText(r.reason, casteGoalReason(s, c, st, cost, reserve));
    setText(r.upkeep, casteUpkeepLine(c, num(obj(s.run.colony.adults)[c])));
  }

  function amountFor(available) {
    const st = curStep();
    if (st === 'max') return Math.max(0, Math.floor(available));
    return Math.max(0, Math.min(st, Math.floor(available)));
  }

  /** C230: where a + click takes workers from, and how many it moves (clamped to the room under the job's cap). */
  function plusMove(id, s, d) {
    const idle = q(() => idleMinors(s), 0);
    const jobs = obj(s.run.colony.jobs);
    const from = idle >= 1 || id === 'forager' ? 'idle' : 'forager';
    const avail = from === 'idle' ? idle : num(jobs.forager);
    const room = Math.max(0, Math.floor(q(() => jobCap(s, d, id), Infinity) - num(jobs[id]) + 1e-9));
    return { from, k: Math.min(amountFor(avail), room), room };
  }

  // --- ratio targets (auto mode, C94) ---
  /** Jobs follow the targets (auto or threshold mode): +/− and drags edit targets instead of moving workers. */
  function autoMode() {
    const c = obj(game.s.run.colony);
    return !!(c.autoJobs || c.thresholdJobs);
  }

  /** The targets to build the next change on: the last map sent while its command is still queued, else the state. */
  function baseTargets() {
    if (pendingTargets && Date.now() - pendingTargets.at < TARGET_PENDING_MS) return pendingTargets.map;
    pendingTargets = null;
    return obj(game.s.run.colony.jobTargets);
  }

  function sendTargets(map, ev = null, src = null) {
    const res = act('setJobTargets', { targets: map }, ev, src);
    pendingTargets = res.ok ? { map, at: Date.now() } : null;
    return res;
  }

  /** Set one job's target (0..1); the others scale down when the total would pass 100 %. */
  function setTarget(id, frac, ev = null, src = null) {
    const base = baseTargets();
    const v = Math.max(0, Math.min(1, frac));
    if (Math.abs(num(base[id]) - v) < 1e-9) return;
    sendTargets(withTarget(base, id, v), ev, src);
  }

  /** Move up to one step of target from one job to another (chip drag in auto mode). */
  function moveTarget(from, to, ev, src) {
    const base = baseTargets();
    const amt = Math.min(TARGET_STEP, num(base[from]));
    if (!(amt > 0)) return;
    const next = withTarget(base, from, num(base[from]) - amt);
    sendTargets(withTarget(next, to, num(next[to]) + amt), ev, src);
  }

  // --- job chips ---
  function createJobChip(id) {
    const n = h('span', { class: 'job-num' });
    const cap = h('span', { class: 'job-cap' });
    const target = h('span', { class: 'job-target' });
    const minus = h('button', { type: 'button', class: 'btn btn-icon btn-step', text: '−', attrs: { 'aria-label': 'Fewer ' + nameOf('job', id) + 's' },
      on: { click: (ev) => {
        if (autoMode()) { setTarget(id, num(baseTargets()[id]) - TARGET_STEP, ev, minus); return; }
        const cur = num(obj(game.s.run.colony.jobs)[id]);
        const k = amountFor(cur);
        if (k > 0) act('shiftJob', { from: id, to: 'idle', n: k }, ev, minus);
      } } });
    const plus = h('button', { type: 'button', class: 'btn btn-icon btn-step', text: '+', attrs: { 'aria-label': 'More ' + nameOf('job', id) + 's' },
      on: { click: (ev) => {
        if (autoMode()) { setTarget(id, num(baseTargets()[id]) + TARGET_STEP, ev, plus); return; }
        const m = plusMove(id, game.s, game.d);
        // a full job (room 0) still sends 1 so the refusal ("max") explains it
        act('shiftJob', { from: m.from, to: id, n: Math.max(1, m.k) }, ev, plus);
      } } });
    const tSl = sliderRow('Target', { min: 0, max: 100, step: 1, tip: 'Share of workers this job should get. Raising it past a 100% total lowers the others.' },
      (v) => setTarget(id, v / 100, null, tSl.input));
    tSl.el.className += ' job-target-row';
    Object.assign(tSl.el.style, { gridColumn: '1 / -1', gridTemplateColumns: '3.4em minmax(0, 1fr) auto', margin: '4px 0 0', gap: '6px' });
    tSl.out.style.minWidth = '3.2em';
    const chip = h('div', { class: 'job-chip', dataset: { job: id, tip: JOB_TIPS[id] }, draggable: true },
      h('i', { class: 'ico ico-job-' + id, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'job-name', text: nameOf('job', id) }),
      // C195: count, cap and the bottleneck bias share one row, so the bias % sits right after the count (it used to land
      // under the +/− buttons in narrow cells)
      h('span', { class: 'job-count' }, n, cap, target), h('span', { class: 'job-btns' }, minus, plus), tSl.el);
    // Sliding the target thumb must not start a chip drag (a draggable ancestor swallows range drags in some browsers).
    tSl.input.addEventListener('pointerdown', () => { chip.draggable = false; });
    for (const t of ['pointerup', 'pointercancel', 'change', 'blur']) tSl.input.addEventListener(t, () => { chip.draggable = true; });
    chip.addEventListener('dragstart', (ev) => {
      if (ev.target === tSl.input) { ev.preventDefault(); return; }
      if (ev.dataTransfer) {
        ev.dataTransfer.setData('text/plain', 'job:' + id);
        ev.dataTransfer.effectAllowed = 'move';
      }
    });
    chip.addEventListener('dragover', (ev) => { ev.preventDefault(); chip.classList.add('drop'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop'));
    chip.addEventListener('drop', (ev) => {
      ev.preventDefault();
      chip.classList.remove('drop');
      const data = ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '';
      if (!data.startsWith('job:')) return;
      const from = data.slice(4);
      if (from === id) return;
      if (autoMode()) {
        if (from !== 'idle') moveTarget(from, id, ev, chip);
        return;
      }
      const avail = from === 'idle' ? q(() => idleMinors(game.s), 0) : num(obj(game.s.run.colony.jobs)[from]);
      const k = amountFor(avail);
      if (k > 0) act('shiftJob', { from, to: id, n: k }, ev, chip);
    });
    chip.__r = { n, cap, target, minus, plus, tSl };
    return chip;
  }

  function updateJobChip(chip, id, s, d, eff) {
    const r = chip.__r;
    const c = obj(s.run.colony);
    setText(r.n, fmtCount(num(obj(c.jobs)[id])));
    const capV = q(() => jobCap(s, d, id), Infinity);
    const have = num(obj(c.jobs)[id]);
    setText(r.cap, Number.isFinite(capV) ? '/ ' + fmtCount(capV) : '');
    toggleClass(r.cap, 'over', Number.isFinite(capV) && have > capV + 1e-9);
    // C231: the nurse cap explains itself (4 per brood slot, the queen counting as one)
    const capTip = id === 'nurse' && Number.isFinite(capV) ? nurseCapTip(capV, num(d && d.stats && d.stats.broodSlots, 3), have) : '';
    if (r.cap.title !== capTip) r.cap.title = capTip;
    const auto = !!(c.autoJobs || c.thresholdJobs);
    const tgt = num(obj(c.jobTargets)[id]);
    show(r.tSl.el, auto);
    // The bottleneck bias (Respond to bottlenecks) on top of the player's target.
    const extra = auto && eff ? num(eff[id]) - tgt : 0;
    setText(r.target, Math.abs(extra) >= 0.005 ? fmtPct(extra) : '');
    r.target.title = Math.abs(extra) >= 0.005 ? 'Respond to bottlenecks: ' + fmtPct(num(eff[id]), { signed: false }) + ' right now' : '';
    if (auto) {
      const pct = (v) => fmtPct(v / 100, { signed: false });
      r.tSl.set(Math.round(tgt * 100), { text: fmtPct(tgt, { signed: false }), fmt: pct });
    }
    const stepPct = Math.round(TARGET_STEP * 100);
    const verb = ' target by ' + stepPct + '%';
    const jn = nameOf('job', id).toLowerCase();
    let minusTip;
    let plusTip;
    if (auto) {
      setText(r.minus, '−' + stepPct + '%');
      setText(r.plus, '+' + stepPct + '%');
      minusTip = 'Lower the ' + jn + verb;
      plusTip = 'Raise the ' + jn + verb;
    } else {
      // C230: the buttons show the step; the tooltip says exactly what one click moves now
      const st = curStep();
      setText(r.minus, stepLabel('−', st));
      setText(r.plus, stepLabel('+', st));
      const km = amountFor(have);
      minusTip = km > 0 ? 'Move ' + fmtCount(km) + ' ' + jn + (km === 1 ? '' : 's') + ' to idle' : 'No ' + jn + 's to move';
      const m = plusMove(id, s, d);
      const src = (m.from === 'idle' ? 'idle worker' : 'forager') + (m.k === 1 ? '' : 's');
      if (m.room <= 0) plusTip = id === 'nurse' ? 'Nurse cap reached: more nurses would not speed brood.' : 'This job is full.';
      else plusTip = m.k > 0 ? 'Move ' + fmtCount(m.k) + ' ' + src + ' to ' + nameOf('job', id) : 'No ' + (m.from === 'idle' ? 'idle workers' : 'foragers') + ' to move';
    }
    if (r.minus.title !== minusTip) r.minus.title = minusTip;
    if (r.plus.title !== plusTip) r.plus.title = plusTip;
    r.minus.setAttribute('aria-label', auto ? 'Lower ' + nameOf('job', id) + ' target' : 'Fewer ' + nameOf('job', id) + 's');
    r.plus.setAttribute('aria-label', auto ? 'Raise ' + nameOf('job', id) + ' target' : 'More ' + nameOf('job', id) + 's');
    toggleClass(chip, 'glow', ui.getUI().glow === 'job:' + id);
  }

  return {
    folds,
    update(s, d) {
      if (!s || !s.run) return;
      const c = obj(s.run.colony);
      const adults = obj(c.adults);
      const st = obj(d && d.stats);
      const total = num(adults.minor) + num(adults.soldier) + num(adults.supermajor) + num(adults.replete);
      show(empty, total < 1 && arr(c.brood).length === 0);

      // brood
      const bs = q(() => broodSummary(s, d), null) || {};
      let egg = num(bs.egg);
      let larva = num(bs.larva);
      let pupa = num(bs.pupa);
      if (!bs.total && arr(c.brood).length) { // derive from cohorts if the query is not available yet
        egg = 0; larva = 0; pupa = 0;
        for (const co of arr(c.brood)) {
          if (!co) continue;
          if (num(co.p) < 0.25) egg += num(co.n); else if (num(co.p) < 0.75) larva += num(co.n); else pupa += num(co.n);
        }
      }
      setText(eggN, fmtCount(egg));
      setText(larvaN, fmtCount(larva));
      setText(pupaN, fmtCount(pupa));
      show(frozenBadge, num(bs.frozen) > 0);
      setText(frozenBadge, fmtCount(num(bs.frozen)) + ' frozen');
      const brood = egg + larva + pupa;
      const slots = num(st.broodSlots, 3);
      slotBar.set(slots > 0 ? brood / slots : 0, 'Brood ' + fmtCount(brood) + ' / ' + fmtCount(slots) + ' slots');
      const housing = num(st.housing, 10);
      const used = num(adults.minor) + num(q(() => housingBrood(s), brood));
      houseBar.set(housing > 0 ? used / housing : 0, 'Housing ' + fmtCount(used) + ' / ' + fmtCount(housing));
      toggleClass(houseBar.el, 'full', used >= housing);
      setText(layEl, fmtRate(num(st.layRate)) + (c.hungry ? ' (hungry)' : ''));
      setCost(eggCostEl, q(() => eggCost(s, d, 'minor'), null), s);
      const nan = num(c.naniticsLeft);
      show(naniticEl, nan > 0);
      setText(naniticEl, fmtCount(nan) + ' half-price nanitic egg' + (nan === 1 ? '' : 's') + ' left.');
      show(reserve.el, isShown(s, 'egg_reserve'));
      const fr = num(c.eggReserve);
      reserve.set(Math.round(fr * 100), { text: fmtPct(fr, { signed: false }) + ' · ' + fmt(fr * num(st.foodCap, 150)) + ' food',
        fmt: (v) => fmtPct(v / 100, { signed: false }) + ' · ' + fmt((v / 100) * num(st.foodCap, 150)) + ' food' });
      show(fungalRow, hasResearch(s, 'fungiculture') || isShown(s, 'fungus_widget'));
      setProp(fungalBox, 'checked', !!c.fungalBrood);
      show(broodSec, total >= 1 || arr(c.brood).length > 0 || isShown(s, 'panel_colony'));

      // castes
      const anyCaste = isShown(s, 'panel_war') || ['soldier', 'supermajor', 'replete'].some((k) => isShown(s, casteKey(k)));
      show(casteSec, anyCaste);
      if (anyCaste) {
        for (const k of Object.keys(casteEls)) {
          setText(casteEls[k].n, fmtCount(num(adults[k])));
          show(casteEls[k].chip, k === 'minor' || num(adults[k]) > 0 || isShown(s, casteKey(k)));
        }
        setText(berthsEl, berthLines(s, st, adults).join(' · '));
        const army = armyUpkeep(adults);
        const armyVis = num(adults.soldier) + num(adults.supermajor) > 0 || isShown(s, casteKey('soldier'));
        show(armyUpkeepEl, armyVis);
        if (armyVis) {
          setText(armyUpkeepEl, 'Army upkeep ' + foodRate(army.total) + ' (' + fmtPct(army.share, { signed: false }) + ' of all upkeep). '
            + 'Targets below the cap save this food and the chitin for their eggs.');
        }
        const resv = q(() => chitinReserve(s), num(c.chitinReserve));
        let anyGoal = false;
        for (const k of Object.keys(casteGoalRows)) {
          const vis = isShown(s, casteKey(k));
          show(casteGoalRows[k].el, vis);
          anyGoal = anyGoal || vis;
          if (vis) updateGoalRow(casteGoalRows[k], k, s, d, resv);
        }
        show(goalStepRow, anyGoal);
        // C104 chitin reserve
        const milVis = isShown(s, casteKey('soldier')) || isShown(s, casteKey('supermajor'));
        show(chitinRes.el, milVis);
        if (milVis) {
          const amt = q(() => chitinReserve(s), num(c.chitinReserve));
          const label = (v) => fmtCount(CHITIN_STEPS[Math.max(0, Math.min(CHITIN_STEPS.length - 1, Math.round(v)))]) + ' chitin';
          const maxIdx = chitinStepIndex(q(() => chitinReserveMax(d), CHITIN_STEPS[CHITIN_STEPS.length - 1]));
          chitinRes.set(chitinStepIndex(amt), { max: maxIdx, disabled: s.run.hardship === 'monomorphic' || s.run.hardship === 'pacifist',
            text: fmtCount(amt) + ' chitin', fmt: label });
        }
        const g = obj(d && d.combat && d.combat.garrison);
        let anyRetire = false;
        for (const k of Object.keys(retireRows)) {
          const has = num(adults[k]) > 0;
          anyRetire = anyRetire || has;
          show(retireRows[k].row, has);
          setText(retireRows[k].cnt, '(' + fmtCount(num(g[k])) + ' in garrison)');
        }
        show(retireTitle, isShown(s, 'panel_war') && anyRetire);
        show(retireBox, isShown(s, 'panel_war') && anyRetire);
      }

      // jobs
      const idle = q(() => idleMinors(s), Math.max(0, num(adults.minor) - Object.values(obj(c.jobs)).reduce((a, v) => a + num(v), 0) - num(c.militia)));
      setText(idleEl, fmtCount(idle) + ' idle' + (num(c.militia) > 0 ? ' · ' + fmtCount(c.militia) + ' militia' : ''));
      show(jobsSec, num(adults.minor) > 0 || isShown(s, 'panel_colony'));
      const ids = jobIds().filter((id) => isShown(s, jobKey(id)) || num(obj(c.jobs)[id]) > 0);
      const auto = !!(c.autoJobs || c.thresholdJobs);
      const eff = auto ? q(() => effectiveTargets(s), null) : null;
      show(stepWrap, !auto); // the 1 / 10 / 100 / Max steps move workers, which auto mode does not do
      // C230: a new run (Flight, Hardship, landing) starts at a step of 1; steps above the workforce are greyed out
      const runNo = num(s.meta && s.meta.counters && s.meta.counters.runs);
      if (lastRun !== null && runNo !== lastRun) step = 1;
      lastRun = runNo;
      const minorsNow = Math.max(1, Math.floor(num(adults.minor) + 1e-9));
      for (const b of Array.from(stepRow.childNodes)) setProp(b, 'disabled', b.dataset.step !== 'max' && Number(b.dataset.step) > minorsNow && b.dataset.step !== '1');
      markStep();
      syncList(jobList, ids, (id) => id, createJobChip, (chip, id) => updateJobChip(chip, id, s, d, eff));
      let tSum = 0;
      for (const id of jobIds()) tSum += num(obj(c.jobTargets)[id]);
      show(targetNote, auto);
      if (auto) {
        const left = Math.max(0, 1 - tSum);
        setText(targetNote, 'Targets total ' + fmtPct(Math.min(1, tSum), { signed: false })
          + (left >= 0.005 ? ' · ' + fmtPct(left, { signed: false }) + ' of workers stay idle' : '')
          + '. Workers are reassigned every 5 s; a share a job cannot use goes to foragers.');
      }
      const autoAvail = isShown(s, 'job_presets') || hasResearch(s, 'age_polyethism') || fedLevel(s, 'automated_brood') > 0; // C166: not Automaton Instincts
      show(autoRow, autoAvail);
      setProp(autoBox, 'checked', !!c.autoJobs);
      const thrAvail = hasResearch(s, 'response_thresholds') || fedLevel(s, 'automated_brood') > 0;
      show(thrRow, thrAvail);
      setProp(thrBox, 'checked', !!c.thresholdJobs);
      show(presetRow, hasResearch(s, 'hive_mind'));
      if (hasResearch(s, 'hive_mind')) {
        const presets = arr(s.meta.automation && s.meta.automation.jobPresets);
        presetBtns.forEach((b, slot) => {
          const p = presets[slot];
          const t = p && obj(p.targets);
          setProp(b.apply, 'disabled', !p);
          b.apply.title = t ? jobIds().filter((j) => num(t[j]) > 0).map((j) => nameOf('job', j) + ' ' + fmtPct(num(t[j]), { signed: false })).join(', ') : 'Empty: save your current targets first';
          setProp(b.save, 'disabled', slot > presets.length);
          b.save.title = 'Save the current targets in slot ' + (slot + 1);
        });
      }

    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

