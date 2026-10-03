// Colony panel: brood pipeline (eggs / larvae / pupae, lay rate, housing, egg reserve slider, Fungal Brood), caste
// slider and "Retire to workers", job chips with +/− (and drag between chips), automation modes, ratio targets (a target slider per chip; +/− and drags edit targets in auto mode, C94) and
// presets, Adaptations, alate rearing. Owner: WP9. Contract: ARCHITECTURE §14.5 (Colony row), §8.1, §9.
// Queries: population.broodSummary, jobs.idleMinors, jobs.jobCap, jobs.withTarget, jobs.effectiveTargets, adaptations.cost / isAvailable, stats.eggCost.

import { h, setText, setProp, show, toggleClass, syncList, setCost } from '../dom.js';
import { fmt, fmtRate, fmtCount, fmtPct } from '../format.js';
import { nameOf, JOB_TIPS, CASTE_TIPS, ADAPT_TIPS } from '../text.js';
import { isShown, hasResearch, traitLevel, fedLevel, num, arr, obj } from '../reveal.js';
import { broodSummary, housingBrood } from '../../systems/population.js';
import { idleMinors, jobCap, withTarget, effectiveTargets } from '../../systems/jobs.js';
import { cost as adaptCost, isAvailable as adaptAvailable } from '../../systems/adaptations.js';
import { eggCost } from '../../systems/stats.js';
import { JOB_ORDER, JOBS, TARGET_UI } from '../../data/jobs.js';
import { ADAPTATION_ORDER, ADAPTATIONS } from '../../data/adaptations.js';
import { CASTES } from '../../data/castes.js';
import { SLIDERS } from '../../data/economy.js';
import { makeAct, sliderRow, note, progressBar } from './common.js';

/** Job ids when data/jobs.js is still empty. */
export const JOB_FALLBACK = Object.freeze(['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener']);
/** Job unlock keys when data/jobs.js is still empty (ARCHITECTURE §6.2). */
export const JOB_UNLOCK_FALLBACK = Object.freeze({ forager: null, digger: 'job_digger', nurse: 'panel_colony', scout: 'job_scout',
  herder: 'job_herder', leafcutter: 'job_leafcutter', gardener: 'job_gardener' });
/** Adaptation ids when data/adaptations.js is still empty. */
export const ADAPT_FALLBACK = Object.freeze(['quick_dispatch', 'strong_mandibles', 'royal_feeding', 'digging_claws', 'potent_trails',
  'serrated_mandibles', 'thick_cuticle', 'sweet_tooth', 'queens_feast', 'long_legs']);
/** Adaptation unlock keys when data/adaptations.js is still empty (ARCHITECTURE §6.2). */
export const ADAPT_UNLOCK_FALLBACK = Object.freeze({ quick_dispatch: 'adapt_basic', strong_mandibles: 'adapt_basic', royal_feeding: 'adapt_basic',
  digging_claws: 'adapt_digging_claws', potent_trails: 'adapt_potent_trails', serrated_mandibles: 'adapt_military', thick_cuticle: 'adapt_military',
  sweet_tooth: 'adapt_honeydew', queens_feast: 'adapt_honeydew', long_legs: 'adapt_long_legs' });
/** Caste unlock keys (slider castes). */
const CASTE_KEYS = Object.freeze({ soldier: 'caste_soldier', supermajor: 'caste_supermajor', replete: 'caste_replete' });
const STEPS = [1, 10, 100, 'max'];
/** Slider limits (DESIGN §5.1 egg reserve ≤ 90 % of the food cap, §5.5 caste targets sum ≤ 90 %). */
const RESERVE_MAX = num(SLIDERS && SLIDERS.eggReserveMax, 0.9);
const CASTE_SUM_MAX = num(SLIDERS && SLIDERS.casteSumMax, 0.9);

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

/** Adaptation ids in display order. */
function adaptIds() {
  return ADAPTATION_ORDER.length ? ADAPTATION_ORDER : ADAPT_FALLBACK;
}

/** Unlock key of an Adaptation. */
function adaptKey(id) {
  const a = ADAPTATIONS[id];
  if (a && a.unlock) return a.unlock;
  return ADAPT_UNLOCK_FALLBACK[id] || null;
}

/** Unlock key of a caste (data `unlock`, else the documented key). */
function casteKey(c) {
  const x = CASTES[c];
  if (x && x.unlock) return x.unlock;
  return CASTE_KEYS[c] || null;
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
  const layEl = h('dd');
  const eggCostEl = h('span', { class: 'cost' });
  const naniticEl = h('p', { class: 'note' });
  const reserve = sliderRow('Egg reserve', { min: 0, max: Math.round(RESERVE_MAX * 100), step: 5, tip: 'Keep food for purchases: the queen will not spend it.' },
    (v) => act('setEggReserve', { frac: Math.max(0, Math.min(RESERVE_MAX, v / 100)) }, null, reserve.input));
  const fungalBox = h('input', { type: 'checkbox', class: 'check' });
  fungalBox.addEventListener('change', (ev) => act('setFungalBrood', { on: !!fungalBox.checked }, ev, fungalBox));
  const fungalRow = h('label', { class: 'toggle-row', dataset: { tip: 'Brood ×0.75 time; costs fungus per egg.' } }, fungalBox, h('span', { text: 'Fungal Brood' }));
  const broodSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Brood' }), pipe, frozenBadge,
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
  const casteSliders = {};
  const casteSliderBox = h('div', { class: 'caste-sliders' });
  for (const c of ['soldier', 'supermajor', 'replete']) {
    const sl = sliderRow(nameOf('caste', c) + ' eggs', { min: 0, max: Math.round(CASTE_SUM_MAX * 100), step: 5, tip: CASTE_TIPS[c] }, (v) => setCaste(c, v));
    casteSliders[c] = sl;
    casteSliderBox.appendChild(sl.el);
  }
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
  const casteSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Castes' }), casteCounts, berthsEl,
    h('p', { class: 'note', text: 'Larval diet decides caste. The rest become minors.' }), casteSliderBox,
    retireTitle, retireBox);

  // --- jobs ---
  const idleEl = h('span', { class: 'sec-meta' });
  const stepRow = h('div', { class: 'seg seg-small', role: 'radiogroup', 'aria-label': 'Step' });
  for (const sv of STEPS) {
    stepRow.appendChild(h('button', { type: 'button', class: 'seg-btn' + (sv === 1 ? ' selected' : ''), dataset: { step: String(sv) },
      text: sv === 'max' ? 'Max' : '×' + sv,
      on: { click: () => { step = sv; for (const b of Array.from(stepRow.children)) toggleClass(b, 'selected', b.dataset.step === String(sv)); } } }));
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
  const jobsSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title' }, 'Jobs ', idleEl), stepRow, h('div', { class: 'toggles' }, autoRow, thrRow), jobList, targetNote, presetRow);

  // --- adaptations ---
  const adaptList = h('div', { class: 'list adapt-list' });
  const adaptSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Adaptations' }), adaptList);

  // --- alates ---
  const alateCount = h('dd');
  const alateCost = h('span', { class: 'cost' });
  const rear1 = h('button', { type: 'button', class: 'btn btn-small', text: 'Rear 1', on: { click: (ev) => act('rearAlate', { n: 1 }, ev, rear1) } });
  const rear5 = h('button', { type: 'button', class: 'btn btn-small', text: 'Rear 5', on: { click: (ev) => act('rearAlate', { n: 5 }, ev, rear5) } });
  const autoRear = h('input', { type: 'checkbox', class: 'check' });
  autoRear.addEventListener('change', (ev) => act('setAutomation', { patch: { autoRear: !!autoRear.checked } }, ev, autoRear));
  const alateSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Alate rearing' }),
    h('p', { class: 'note', text: 'Each reared alate adds +2% to your next Nuptial Flight.' }),
    h('dl', { class: 'kv' }, h('dt', { text: 'Reared / cells' }), alateCount, h('dt', { text: 'Next alate egg' }), h('dd', null, alateCost)),
    h('div', { class: 'btn-row' }, rear1, rear5),
    h('label', { class: 'toggle-row', dataset: { tip: 'Rear alates whenever a cell is free.' } }, autoRear, h('span', { text: 'Auto-rear' })));

  const empty = note('Your first worker is on the way. The queen tends her first egg.');
  el.append(empty, broodSec, casteSec, jobsSec, adaptSec, alateSec);

  function setCaste(c, pct) {
    const t = { ...obj(game.s.run.colony.casteTargets) };
    const others = Object.keys(CASTE_KEYS).filter((k) => k !== c).reduce((a, k) => a + num(t[k]), 0);
    t[c] = Math.max(0, Math.min(pct / 100, CASTE_SUM_MAX - others));
    for (const k of Object.keys(CASTE_KEYS)) t[k] = num(t[k]);
    act('setCasteTargets', { soldier: t.soldier, supermajor: t.supermajor, replete: t.replete }, null, casteSliders[c].input);
  }

  function amountFor(available) {
    if (step === 'max') return Math.max(0, Math.floor(available));
    return Math.max(0, Math.min(step, Math.floor(available)));
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
    const minus = h('button', { type: 'button', class: 'btn btn-icon', text: '−', attrs: { 'aria-label': 'Fewer ' + nameOf('job', id) + 's' },
      on: { click: (ev) => {
        if (autoMode()) { setTarget(id, num(baseTargets()[id]) - TARGET_STEP, ev, minus); return; }
        const cur = num(obj(game.s.run.colony.jobs)[id]);
        const k = amountFor(cur);
        if (k > 0) act('shiftJob', { from: id, to: 'idle', n: k }, ev, minus);
      } } });
    const plus = h('button', { type: 'button', class: 'btn btn-icon', text: '+', attrs: { 'aria-label': 'More ' + nameOf('job', id) + 's' },
      on: { click: (ev) => {
        if (autoMode()) { setTarget(id, num(baseTargets()[id]) + TARGET_STEP, ev, plus); return; }
        const s = game.s;
        const idle = q(() => idleMinors(s), 0);
        const jobs = obj(s.run.colony.jobs);
        const from = idle >= 1 || id === 'forager' ? 'idle' : 'forager';
        const avail = from === 'idle' ? idle : num(jobs.forager);
        const k = amountFor(avail);
        act('shiftJob', { from, to: id, n: Math.max(1, k) }, ev, plus);
      } } });
    const tSl = sliderRow('Target', { min: 0, max: 100, step: 1, tip: 'Share of workers this job should get. Raising it past a 100% total lowers the others.' },
      (v) => setTarget(id, v / 100, null, tSl.input));
    tSl.el.className += ' job-target-row';
    Object.assign(tSl.el.style, { gridColumn: '1 / -1', gridTemplateColumns: '3.4em minmax(0, 1fr) auto', margin: '4px 0 0', gap: '6px' });
    tSl.out.style.minWidth = '3.2em';
    const chip = h('div', { class: 'job-chip', dataset: { job: id, tip: JOB_TIPS[id] }, draggable: true },
      h('i', { class: 'ico ico-job-' + id, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'job-name', text: nameOf('job', id) }), n, cap, target, h('span', { class: 'job-btns' }, minus, plus), tSl.el);
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
    setText(r.cap, Number.isFinite(capV) ? '/ ' + fmtCount(capV) : '');
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
    const verb = auto ? ' target by ' + Math.round(TARGET_STEP * 100) + '%' : '';
    r.minus.title = auto ? 'Lower the ' + nameOf('job', id).toLowerCase() + verb : '';
    r.plus.title = auto ? 'Raise the ' + nameOf('job', id).toLowerCase() + verb : '';
    r.minus.setAttribute('aria-label', auto ? 'Lower ' + nameOf('job', id) + ' target' : 'Fewer ' + nameOf('job', id) + 's');
    r.plus.setAttribute('aria-label', auto ? 'Raise ' + nameOf('job', id) + ' target' : 'More ' + nameOf('job', id) + 's');
    toggleClass(chip, 'glow', ui.getUI().glow === 'job:' + id);
  }

  // --- adaptation rows ---
  function createAdaptRow(id) {
    const lvl = h('span', { class: 'lvl' });
    const costEl = h('span', { class: 'cost' });
    const buy = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Buy',
      on: { click: (ev) => act('buyAdaptation', { id, n: 1 }, ev, buy) } });
    const buy10 = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: '×10',
      on: { click: (ev) => act('buyAdaptation', { id, n: 10 }, ev, buy10) } });
    const lockHint = h('span', { class: 'locked-hint' });
    const row = h('div', { class: 'buy-row', dataset: { id } }, // the description is on the row: no duplicate tooltip
      h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('adaptation', id) }), lvl,
        h('span', { class: 'buy-desc', text: ADAPT_TIPS[id] || '' }), lockHint),
      h('div', { class: 'buy-side' }, costEl, h('span', { class: 'btn-row' }, buy, buy10)));
    row.__r = { lvl, costEl, buy, buy10, lockHint };
    return row;
  }

  function updateAdaptRow(row, id, s) {
    const r = row.__r;
    const L = num(obj(s.run.adaptations)[id]);
    setText(r.lvl, 'L' + fmtCount(L));
    const avail = q(() => adaptAvailable(s, id), false);
    const c = q(() => adaptCost(s, id, 1), null);
    const ok = setCost(r.costEl, c, s);
    toggleClass(row, 'cant', !ok && c !== null);
    toggleClass(row, 'maxed', c === null);
    toggleClass(row, 'blocked', !avail);
    setProp(r.buy, 'disabled', !avail || c === null);
    setText(r.buy, c === null ? 'Max' : 'Buy');
    setText(r.lockHint, avail ? '' : s.run.hardship === 'claustral_founding' && id === 'royal_feeding' ? 'Not allowed in this Hardship.' : '');
    const c10 = q(() => adaptCost(s, id, 10), null);
    show(r.buy10, avail && c10 !== null && L > 0);
    r.buy10.title = c10 ? 'Buy 10 levels' : '';
    toggleClass(row, 'glow', ui.getUI().glow === 'adapt:' + id);
  }

  return {
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
        const parts = [];
        if (isShown(s, 'chamber_barracks') || num(st.berths) > 0) parts.push('Berths ' + fmtCount(num(adults.soldier) + num(adults.supermajor)) + ' / ' + fmtCount(num(st.berths)));
        if (isShown(s, 'caste_replete')) parts.push('Replete berths ' + fmtCount(num(adults.replete)) + ' / ' + fmtCount(num(st.repleteBerths)));
        setText(berthsEl, parts.join(' · '));
        const t = obj(c.casteTargets);
        for (const k of Object.keys(casteSliders)) {
          const vis = isShown(s, casteKey(k));
          show(casteSliders[k].el, vis);
          const pacifistBlock = s.run.hardship === 'pacifist' && k !== 'replete';
          casteSliders[k].set(Math.round(num(t[k]) * 100), { disabled: s.run.hardship === 'monomorphic' || pacifistBlock,
            text: fmtPct(num(t[k]), { signed: false }), fmt: (v) => fmtPct(v / 100, { signed: false }) });
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
      syncList(jobList, ids, (id) => id, createJobChip, (chip, id) => updateJobChip(chip, id, s, d, eff));
      show(stepRow, !auto); // the ×1 / ×10 / Max steps move workers, which auto mode does not do
      let tSum = 0;
      for (const id of jobIds()) tSum += num(obj(c.jobTargets)[id]);
      show(targetNote, auto);
      if (auto) {
        const left = Math.max(0, 1 - tSum);
        setText(targetNote, 'Targets total ' + fmtPct(Math.min(1, tSum), { signed: false })
          + (left >= 0.005 ? ' · ' + fmtPct(left, { signed: false }) + ' of workers stay idle' : '')
          + '. Workers are reassigned every 5 s; a share a job cannot use goes to foragers.');
      }
      const autoAvail = isShown(s, 'job_presets') || hasResearch(s, 'age_polyethism') || traitLevel(s, 'automaton_instincts') > 0 || fedLevel(s, 'automated_brood') > 0;
      show(autoRow, autoAvail);
      setProp(autoBox, 'checked', !!c.autoJobs);
      const thrAvail = hasResearch(s, 'response_thresholds') || traitLevel(s, 'automaton_instincts') > 0 || fedLevel(s, 'automated_brood') > 0;
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

      // adaptations
      const aIds = adaptIds().filter((id) => isShown(s, adaptKey(id)) || num(obj(s.run.adaptations)[id]) > 0);
      show(adaptSec, aIds.length > 0);
      syncList(adaptList, aIds, (id) => id, createAdaptRow, (row, id) => updateAdaptRow(row, id, s));

      // alates
      const rearing = isShown(s, 'alate_rearing');
      show(alateSec, rearing);
      if (rearing) {
        const alBrood = num(obj(bs.byCaste).alate);
        setText(alateCount, fmtCount(num(c.alatesReared)) + ' / ' + fmtCount(num(st.alateCells)) + (alBrood > 0 ? ' (+' + fmtCount(alBrood) + ' growing)' : '')
          + (num(c.rearRequested) > 0 ? ' · ' + fmtCount(c.rearRequested) + ' queued' : ''));
        setCost(alateCost, q(() => eggCost(s, d, 'alate'), null), s);
        setProp(autoRear, 'checked', !!(s.meta.automation && s.meta.automation.autoRear));
      }
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

