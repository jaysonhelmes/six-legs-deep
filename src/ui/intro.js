// Opening state for a brand-new colony (DESIGN §25.6 "show, never tell", "one glow at a time"; §23 row 0:00).
// Until the first gameplay panel reveals, the panel column shows a small welcome card instead of an arbitrary
// always-on tab (the Field Guide used to greet new players), and medium / narrow layouts, whose panels start
// closed, get a one-line coach over the map. Neither element pulses: the crumb on the canvas is the one glow.
// Owner: WP9. The step logic is pure (introStep / firstHatchEta) so Node tests can check it.

import { h, setText, show, setBar } from './dom.js';
import { fmtTime } from './format.js';
import { num, arr, obj } from './reveal.js';
import { broodAllocation } from '../systems/population.js';
import { BROOD } from '../data/economy.js';
import { CASTES } from '../data/castes.js';

/** Tabs that are always shown (they never count as "the first panel"). */
export const ALWAYS_TABS = Object.freeze(['guide', 'stats', 'settings']);

/** Clicks on the crumb that complete the first step (same threshold as onboarding hint_crumb). */
export const CRUMB_CLICKS = 3;

/**
 * Brood development time (seconds from egg to adult) for a caste right now, or -1 when brood is not developing.
 * Mirrors systems/population.js develop(): baseSec × mbt / max(1, nurseTerm) / bSpeed × caste broodFactor.
 * @param {Object} s
 * @param {Object} d
 * @param {string} [caste]
 * @returns {number}
 */
export function broodTime(s, d, caste = 'minor') {
  const st = obj(d && d.stats);
  let bSpeed = 1;
  try { bSpeed = num(broodAllocation(s, d).bSpeed, 1); } catch { bSpeed = 1; }
  if (!(bSpeed > 0)) return -1;
  const factor = CASTES && CASTES[caste] ? num(CASTES[caste].broodFactor, 1) : 1;
  return num(BROOD && BROOD.baseSec, 25) * num(st.mbt, 1) / Math.max(1, num(st.nurseTerm, 1)) / bSpeed * factor;
}

/**
 * Seconds until each brood cohort hatches, soonest first: [{ t, n, caste }]. Alates are not adults and are skipped.
 * @param {Object} s
 * @param {Object} d
 * @returns {Array<{ t: number, n: number, caste: string }>}
 */
export function hatchSchedule(s, d) {
  const out = [];
  const cache = {};
  for (const c of arr(s && s.run && s.run.colony && s.run.colony.brood)) {
    if (!c || c.c === 'alate' || !(num(c.n) > 0)) continue;
    const caste = c.c || 'minor';
    if (!(caste in cache)) cache[caste] = broodTime(s, d, caste);
    const T = cache[caste];
    if (!(T > 0)) continue;
    out.push({ t: Math.max(0, (1 - Math.max(0, Math.min(1, num(c.p)))) * T), n: num(c.n), caste });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Seconds until the first worker hatches (-1 when there is no brood or it is not developing) and the progress of the
 * most developed cohort (0..1).
 * @param {Object} s
 * @param {Object} d
 * @returns {{ eta: number, frac: number }}
 */
export function firstHatchEta(s, d) {
  let frac = 0;
  for (const c of arr(s && s.run && s.run.colony && s.run.colony.brood)) {
    if (c && c.c !== 'alate') frac = Math.max(frac, Math.max(0, Math.min(1, num(c.p))));
  }
  const sched = hatchSchedule(s, d);
  return { eta: sched.length ? sched[0].t : -1, frac };
}

/**
 * Seconds until the colony has `n` adults: brood already in the pipeline hatches first, then eggs at the lay rate
 * (each needing a full development time). -1 when it cannot be estimated (no brood and no laying).
 * @param {Object} s
 * @param {Object} d
 * @param {number} n
 * @returns {number}
 */
export function adultsEta(s, d, n) {
  const a = obj(s && s.run && s.run.colony && s.run.colony.adults);
  const have = num(a.minor) + num(a.soldier) + num(a.supermajor) + num(a.replete);
  let need = num(n) - have;
  if (need <= 0) return 0;
  let last = 0;
  for (const c of hatchSchedule(s, d)) {
    need -= c.n;
    last = c.t;
    if (need <= 0) return c.t;
  }
  const lay = num(d && d.stats && d.stats.layRate);
  const T = broodTime(s, d, 'minor');
  if (!(lay > 0) || !(T > 0)) return -1;
  return Math.max(last, need / lay + T);
}

/**
 * Has the player finished the opening (some gameplay panel is revealed)?
 * @param {string[]} visibleTabIds tabs currently shown
 * @returns {boolean} true while only the always-on tabs exist
 */
export function isIntro(visibleTabIds) {
  return !arr(visibleTabIds).some((id) => !ALWAYS_TABS.includes(id));
}

/**
 * The current opening step. Pure.
 * @param {Object} s
 * @param {Object} d
 * @param {{ touch?: boolean }} [o]
 * @returns {{ id: 'crumb'|'hatch', text: string, eta: number, frac: number }}
 */
export function introStep(s, d, { touch = false } = {}) {
  const clicks = num(s && s.meta && s.meta.counters && s.meta.counters.clicks);
  const done = !!obj(s && s.meta && s.meta.onboarding && s.meta.onboarding.done).hint_crumb;
  const hatch = firstHatchEta(s, d);
  if (!done && clicks < CRUMB_CLICKS) {
    return { id: 'crumb', text: (touch ? 'Tap' : 'Click') + ' the glowing crumb to gather food.', eta: hatch.eta, frac: hatch.frac };
  }
  return { id: 'hatch', text: 'Food becomes eggs. Your first worker is on the way.', eta: hatch.eta, frac: hatch.frac };
}

/** Coarse pointer (phones, tablets)? */
function isTouch() {
  try {
    const w = globalThis.window;
    return !!(w && typeof w.matchMedia === 'function' && w.matchMedia('(pointer: coarse)').matches);
  } catch {
    return false;
  }
}

/**
 * Welcome card (panel column) and map coach (medium / narrow).
 * @param {HTMLElement} cardHost host inside #panel-body
 * @param {HTMLElement|null} coachHost element over the Above canvas (#view-above)
 * @param {{ game: Object }} ctx
 * @returns {{ update(s: Object, d: Object, o: { intro: boolean, card: boolean, layout: string }): void, destroy(): void }}
 */
export function createIntro(cardHost, coachHost, { game }) {
  const stepText = h('span', { class: 'intro-text' });
  const etaText = h('span', { class: 'intro-eta' });
  const fill = h('span', { class: 'bar-fill' });
  const bar = h('div', { class: 'bar bar-thin intro-bar', role: 'progressbar', attrs: { 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'First worker' } }, fill);
  const hatchRow = h('div', { class: 'intro-hatch' }, h('div', { class: 'intro-hatch-head' }, h('span', { text: 'First worker' }), etaText), bar);
  const card = h('div', { class: 'intro-card', role: 'region', attrs: { 'aria-label': 'Welcome' } },
    h('div', { class: 'intro-mark', attrs: { 'aria-hidden': 'true' } }),
    h('h2', { class: 'intro-title', text: 'Six Legs Deep' }),
    h('p', { class: 'intro-lede', text: 'One sealed queen, a single crumb, and all the dark below.' }),
    h('p', { class: 'intro-step' }, h('span', { class: 'intro-arrow', attrs: { 'aria-hidden': 'true' } }), stepText),
    hatchRow);
  if (cardHost) cardHost.appendChild(card);
  const coachText = h('span');
  const coach = h('div', { class: 'coach', role: 'status' }, h('span', { class: 'coach-dot', attrs: { 'aria-hidden': 'true' } }), coachText);
  coach.hidden = true;
  if (coachHost) coachHost.appendChild(coach);

  return {
    update(s, d, { intro = false, card: showCard = false, layout = 'wide-tall' } = {}) {
      if (!s || !s.meta || !s.run) return;
      const narrowish = layout === 'medium' || layout === 'narrow';
      const step = introStep(s, d, { touch: isTouch() });
      if (showCard) {
        setText(stepText, step.text);
        card.classList.toggle('step-crumb', step.id === 'crumb');
        show(hatchRow, step.eta >= 0 || step.frac > 0);
        setText(etaText, step.eta >= 0 ? fmtTime(Math.ceil(step.eta)) : '');
        setBar(fill, step.frac);
        bar.setAttribute('aria-valuenow', String(Math.round(step.frac * 100)));
      }
      const coachOn = intro && narrowish && step.id === 'crumb' && !game.s.meta.pending;
      show(coach, coachOn);
      if (coachOn) setText(coachText, step.text);
    },
    destroy() {
      if (card.parentNode) card.parentNode.removeChild(card);
      if (coach.parentNode) coach.parentNode.removeChild(coach);
    },
  };
}
