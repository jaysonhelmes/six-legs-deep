// Onboarding (DESIGN §25.6): one glow at a time (uistate.glow), the ghost-ant demo after 8 s of hesitation
// (uistate.ghostDemo, drawn by WP8), and the first-hour advisor pulse (nothing useful affordable within 120 s →
// pulse the limiting chamber or resource, via wallet.timeToAfford). Completed hints persist through actions.uiFlag.
// Owner: WP9. Contract: ARCHITECTURE §14.6 (Onboarding), §14.4.
//
// Glow keys (the shared vocabulary with WP8; ARCH-R: the contract only types glow as a string):
//   'tab:<tabId>', 'job:<jobId>', 'build:<chamberId>', 'adapt:<adaptationId>', 'research:<researchId>', 'res:<res>',
//   'badge' (bottleneck badge), 'canvas:crumb' (the crumb source), 'canvas:bestSource' (d.surface.bestSource),
//   'canvas:royal' (Royal Chamber), 'canvas:digFace'.
// ghostDemo: { kind: 'trail', from: originHex, to: sourceHex } | { kind: 'chamber', from: chamberType, to: cellIndex }.

import { isShown, num, arr, obj } from './reveal.js';
import { timeToAfford } from '../core/wallet.js';
import { cost as adaptCost, isAvailable as adaptAvailable } from '../systems/adaptations.js';
import { placementCost, findPlacement } from '../systems/nest.js';
import { isAvailable as researchAvailable, cost as researchCost } from '../systems/research.js';
import { ADAPTATION_ORDER } from '../data/adaptations.js';
import { CHAMBER_ORDER } from '../data/chambers.js';
import { RESEARCH_ORDER } from '../data/research.js';
import { GRID } from '../data/balance.js';

/** Hesitation before the ghost-ant demo (DESIGN §25.6 rule 2). */
export const GHOST_DELAY_MS = 8000;
/** Advisor pulse horizon and window (DESIGN §25.6 rule 7). */
export const ADVISOR = Object.freeze({ horizonSec: 120, firstHourSec: 3600 });

const ADAPT_FALLBACK = ['quick_dispatch', 'strong_mandibles', 'royal_feeding'];
const CHAMBER_FALLBACK = ['gallery', 'nursery', 'granary', 'scent_library', 'midden'];

/** Safe query. */
function q(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Count of chambers of a type. */
function chamberCount(s, type) {
  return arr(s.run.nest && s.run.nest.chambers).filter((c) => c && c.type === type).length;
}

/** Source hex of d.surface.bestSource, or -1. */
function bestSourceHex(s, d) {
  const uid = num(d && d.surface && d.surface.bestSource);
  if (!uid) return -1;
  const src = arr(s.run.surface && s.run.surface.sources).find((x) => x && x.uid === uid);
  return src ? num(src.hex, -1) : -1;
}

/** Cheapest available research id, or null. */
function cheapestResearch(s) {
  let best = null;
  let bestCost = Infinity;
  for (const id of RESEARCH_ORDER) {
    if (!q(() => researchAvailable(s, id), false)) continue;
    const c = num(q(() => researchCost(s, id), {}).insight, Infinity);
    if (c < bestCost) { bestCost = c; best = id; }
  }
  return best ? { id: best, cost: bestCost } : null;
}

/**
 * The next onboarding hint, or null. Pure: reads state only.
 * @param {Object} s
 * @param {Object} d
 * @param {{ tab?: string }} [ctx] the current UI tab (to glow the tab first, then the item)
 * @returns {{ id: string, glow: string|null, ghost: Object|null, done: boolean } | null}
 */
export function nextHint(s, d, { tab = null } = {}) {
  if (!s || !s.run || !s.meta) return null;
  const done = obj(s.meta.onboarding && s.meta.onboarding.done);
  const c = obj(s.run.colony);
  const jobs = obj(c.jobs);
  const hints = [
    () => {
      if (done.hint_crumb || num(s.run.index) > 0) return null;
      const finished = num(s.meta.counters && s.meta.counters.clicks) >= 3;
      return { id: 'hint_crumb', glow: 'canvas:crumb', ghost: null, done: finished };
    },
    () => {
      if (done.hint_colony_tab || !isShown(s, 'panel_colony')) return null;
      return { id: 'hint_colony_tab', glow: 'tab:colony', ghost: null, done: tab === 'colony' };
    },
    () => {
      if (done.hint_digger || !isShown(s, 'job_digger')) return null;
      return { id: 'hint_digger', glow: tab === 'colony' ? 'job:digger' : 'tab:colony', ghost: null, done: num(jobs.digger) >= 1 };
    },
    () => {
      if (done.hint_gallery || !isShown(s, 'panel_build')) return null;
      const has = chamberCount(s, 'gallery') > 0;
      let ghost = null;
      if (!has) {
        const spot = q(() => findPlacement(s, d, 'gallery'), null);
        if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) ghost = { kind: 'chamber', from: 'gallery', to: spot.y * num(GRID.cols, 40) + spot.x };
      }
      return { id: 'hint_gallery', glow: tab === 'build' ? 'build:gallery' : 'tab:build', ghost, done: has };
    },
    () => {
      if (done.hint_trail || !isShown(s, 'trail_slots')) return null;
      const n = arr(s.run.surface && s.run.surface.trails).length;
      const to = bestSourceHex(s, d);
      const main = arr(s.run.surface && s.run.surface.entrances).find((e) => e && e.kind === 'main');
      return { id: 'hint_trail', glow: 'canvas:bestSource', ghost: to >= 0 ? { kind: 'trail', from: main ? num(main.hex) : 0, to } : null, done: n >= 2 };
    },
    () => {
      if (done.hint_research || !isShown(s, 'panel_research')) return null;
      const owned = Object.keys(obj(s.run.research)).length > 0;
      const cheap = cheapestResearch(s);
      if (!owned && (!cheap || num(s.run.res.insight) < cheap.cost)) return null; // wait until something is affordable
      return { id: 'hint_research', glow: tab === 'research' ? (cheap ? 'research:' + cheap.id : null) : 'tab:research', ghost: null, done: owned };
    },
    () => {
      if (done.hint_adapt || !isShown(s, 'adapt_basic')) return null;
      const bought = Object.values(obj(s.run.adaptations)).some((v) => num(v) > 0);
      const ids = ADAPTATION_ORDER.length ? ADAPTATION_ORDER : ADAPT_FALLBACK;
      const affordable = ids.find((id) => q(() => adaptAvailable(s, id), false) && q(() => timeToAfford(s, d, adaptCost(s, id, 1)), -1) === 0);
      if (!bought && !affordable) return null;
      return { id: 'hint_adapt', glow: tab === 'adaptations' ? (affordable ? 'adapt:' + affordable : null) : 'tab:adaptations', ghost: null, done: bought };   // C143: own tab
    },
  ];
  for (const fn of hints) {
    const hnt = q(fn, null);
    if (hnt) return hnt;
  }
  return null;
}

/**
 * First-hour advisor pulse: when nothing useful is affordable within 120 s, the glow key of the limiting chamber or
 * resource; otherwise null. Pure.
 * @param {Object} s
 * @param {Object} d
 * @returns {string|null}
 */
export function advisorPulse(s, d) {
  if (!s || !s.meta || num(s.meta.simTime) >= ADVISOR.firstHourSec) return null;
  const costs = [];
  for (const id of (ADAPTATION_ORDER.length ? ADAPTATION_ORDER : ADAPT_FALLBACK)) {
    if (q(() => adaptAvailable(s, id), false)) costs.push(q(() => adaptCost(s, id, 1), null));
  }
  for (const id of (CHAMBER_ORDER.length ? CHAMBER_ORDER : CHAMBER_FALLBACK)) {
    if (id !== 'royal_chamber' && isShown(s, 'chamber_' + id)) costs.push(q(() => placementCost(s, id), null));
  }
  const cheap = cheapestResearch(s);
  if (cheap) costs.push({ insight: cheap.cost });
  if (costs.filter(Boolean).length === 0) return null;
  for (const c of costs) {
    if (!c) continue;
    const t = q(() => timeToAfford(s, d, c), -1);
    if (t >= 0 && t <= ADVISOR.horizonSec) return null;
  }
  const id = s.run.bottleneck && s.run.bottleneck.id;
  switch (id) {
    case 'bn_housing': return 'build:gallery';
    case 'bn_brood_slots': return 'build:nursery';
    case 'bn_food_cap': return 'build:granary';
    case 'bn_lay_rate': return 'canvas:royal';
    case 'bn_food': case 'hungry': return 'job:forager';
    default: return 'res:food';
  }
}

/**
 * Onboarding controller.
 * @param {{ game: Object, ui: Object, root: HTMLElement|null }} ctx
 */
export function createOnboarding({ game, ui, root }) {
  let lastInput = 0;
  let now = 0;
  let currentId = null;
  const sent = new Set();
  const onInput = () => {
    lastInput = now;
    if (ui.getUI().ghostDemo) ui.setUI({ ghostDemo: null });
  };
  if (root) {
    root.addEventListener('pointerdown', onInput);
    root.addEventListener('keydown', onInput);
  }

  return {
    /**
     * Re-evaluate (call at ~1 Hz).
     * @param {Object} s
     * @param {Object} d
     * @param {number} nowMs
     */
    update(s, d, nowMs) {
      if (Number.isFinite(nowMs)) now = nowMs;
      if (!lastInput) lastInput = now;
      if (!s || !s.meta || s.meta.pending) return;
      const st = ui.getUI();
      const hint = nextHint(s, d, { tab: st.tab });
      if (hint && hint.done) {
        if (!sent.has(hint.id)) {
          sent.add(hint.id);
          game.actions.do('uiFlag', { key: hint.id, value: true });
        }
      }
      const active = hint && !hint.done ? hint : null;
      if ((active ? active.id : null) !== currentId) {
        currentId = active ? active.id : null;
        lastInput = now;
        if (st.ghostDemo) ui.setUI({ ghostDemo: null });
      }
      let glow = active ? active.glow : null;
      if (!glow) glow = advisorPulse(s, d);
      if (st.glow !== glow) ui.setUI({ glow });
      if (active && active.ghost && now - lastInput >= GHOST_DELAY_MS) {
        const g = st.ghostDemo;
        if (!g || g.kind !== active.ghost.kind || g.to !== active.ghost.to) ui.setUI({ ghostDemo: active.ghost });
      }
    },
    /** Record player input (resets the hesitation timer). */
    noteInput: onInput,
    destroy() {
      if (root) {
        root.removeEventListener('pointerdown', onInput);
        root.removeEventListener('keydown', onInput);
      }
    },
  };
}

