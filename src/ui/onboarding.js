// Onboarding (DESIGN §25.6): one glow at a time (uistate.glow), the ghost-ant demo after 8 s of hesitation
// (uistate.ghostDemo, drawn by WP8), and the first-hour advisor pulse (nothing useful affordable within 120 s →
// pulse the limiting chamber or resource, via wallet.timeToAfford). Completed hints persist through actions.uiFlag.
// Owner: WP9. Contract: ARCHITECTURE §14.6 (Onboarding), §14.4.
//
// Glow keys (the shared vocabulary with WP8; ARCH-R: the contract only types glow as a string):
//   'tab:<tabId>', 'job:<jobId>', 'build:<chamberId>', 'adapt:<adaptationId>', 'research:<researchId>', 'res:<res>',
//   'badge' (bottleneck badge), 'canvas:crumb' (the crumb source), 'canvas:bestSource' (d.surface.bestSource),
//   'canvas:royal' (Royal Chamber), 'canvas:digFace'.
// ghostDemo: { kind: 'trail', from: originHex, to: sourceHex } | { kind: 'chamber', from: chamberType, to: cellIndex, label }.
// C203 / C204 (new-player pass): the chamber demo runs only while the Gallery is revealed, the nest is full and no Gallery
//   is placed, and carries a label (drawn by WP8) saying what it asks; the first reveal of a feature gets a one-line
//   callout (CALLOUTS, createCallout: one at a time, dismissible, persisted as meta.onboarding.done['tip:<key>']).

import { h, setText } from './dom.js';
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

/** C203: label of the Gallery placement demo (the Build tab glows at the same time). */
export const GALLERY_DEMO_LABEL = 'Nest full: pick Gallery in the Build tab, then click here';

/**
 * C204: one-line "what this is / what to do" for the first reveal of a feature (about 14 words at most, naming no
 * feature the player has not seen yet). Keys without an entry get no callout.
 */
export const CALLOUTS = Object.freeze({
  panel_colony: 'Colony tab: your ants and their jobs. Foragers fetch food on their own.',
  job_digger: 'Diggers carry soil up and dig new rooms. Give one ant the Digger job.',
  panel_build: 'Your nest is full, so the queen stops laying. Build a Gallery for room.',
  adapt_basic: 'Adaptations tab: permanent upgrades you buy with food.',
  chamber_granary: 'Granary: stores more food. Build it from the Build tab.',
  chamber_nursery: 'Nursery: more room for eggs. It works best beside the queen.',
  job_scout: 'Scouts explore the fog around the nest and find new food.',
  trail_slots: 'The crumb is crowded. Drag from the nest entrance to another food source.',
  panel_research: 'Scouting found insight. Spend it in the new Research tab.',
  panel_map: 'Map tab: your trails and land, in one list.',
  royal_levelup: 'The Royal Chamber can level up: the queen lays faster. Click her.',
  egg_reserve: 'Egg reserve (Colony tab): keep food back from the queen to save up.',
  chamber_scent_library: 'Scent Library: a chamber that slowly makes insight.',
  panel_achievements: 'Achievements tab: goals that give small permanent rewards.',
  golden_beetle: 'A golden beetle! Click it on the map before it leaves.',
  res_chitin: 'Chitin: shell from dead insects. Keep it; armour comes later.',
  chamber_midden: 'Midden: a waste dump. Keep it away from your brood.',
  season_dial: 'Seasons are coming. The dial shows the season and what it changes.',
  mound: 'Mound: spend spare soil to raise the hill over your nest (Build tab).',
  panel_rivals: 'Rival ants nearby. The Map tab shows who they are.',
  climate_overlay: 'Autumn: winter is coming. The climate overlay shows where frost will reach.',
  chamber_gate: 'Gate: a chamber that guards your entrance against raids.',
});
/** Callout lifetime (ms) before it fades on its own (it is then marked seen). */
export const CALLOUT_MS = 45000;

/** The uiFlag key that records a callout as seen. */
export const calloutFlag = (key) => 'tip:' + key;

/**
 * C204: the callout to show for a reveal, or null (no copy, already seen, or the key is not actually shown).
 * @param {Object} s
 * @param {string} key unlock key just revealed
 * @returns {{ key: string, text: string } | null}
 */
export function calloutFor(s, key) {
  const text = CALLOUTS[key];
  if (!text || !s || !s.meta) return null;
  if (obj(s.meta.onboarding && s.meta.onboarding.done)[calloutFlag(key)]) return null;
  if (!isShown(s, key)) return null;
  return { key, text };
}

/**
 * C203: housing full (minors + brood at or above housing), the moment a Gallery is actually needed.
 * @param {Object} s
 * @param {Object} d
 * @returns {boolean}
 */
export function housingFull(s, d) {
  const hcap = num(d && d.stats && d.stats.housing);
  if (!(hcap > 0)) return false;
  const c = obj(s.run && s.run.colony);
  let brood = 0;
  for (const b of arr(c.brood)) if (b && b.c !== 'alate') brood += num(b.n);
  return num(obj(c.adults).minor) + brood >= hcap;
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
      // C203: the placement demo only while the Gallery is on offer and needed (housing full), with its label
      if (!has && isShown(s, 'chamber_gallery') && housingFull(s, d)) {
        const spot = q(() => findPlacement(s, d, 'gallery'), null);
        if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) {
          ghost = { kind: 'chamber', from: 'gallery', to: spot.y * num(GRID.cols, 40) + spot.x, label: GALLERY_DEMO_LABEL };
        }
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
  // C203: never pulse something the player has not been shown yet (the food counter is always there)
  const shown = (key, glow) => (isShown(s, key) ? glow : 'res:food');
  switch (id) {
    case 'bn_housing': return shown('chamber_gallery', 'build:gallery');
    case 'bn_brood_slots': return shown('chamber_nursery', 'build:nursery');
    case 'bn_food_cap': return shown('chamber_granary', 'build:granary');
    case 'bn_lay_rate': return shown('royal_levelup', 'canvas:royal');
    case 'bn_food': case 'hungry': return shown('panel_colony', 'job:forager');
    default: return 'res:food';
  }
}

/**
 * C204: the feature callout (one line under the HUD, one at a time). show(key) on an `unlock` event replaces the one
 * showing (which then counts as seen); "Got it" or CALLOUT_MS hides it and records it through actions.uiFlag.
 * @param {HTMLElement|null} host positioned parent (#stage)
 * @param {{ game: Object }} ctx
 * @returns {{ show(key: string): boolean, update(nowMs: number): void, current(): string|null, resume(): boolean, dismiss(): void, hide(): void, el: HTMLElement, destroy(): void }}
 */
export function createCallout(host, { game }) {
  const text = h('span', { class: 'callout-text' });
  const btn = h('button', { type: 'button', class: 'btn btn-small callout-ok', text: 'Got it' });
  const el = h('div', { class: 'callout', role: 'status', attrs: { 'aria-live': 'polite' } },
    h('span', { class: 'callout-dot', attrs: { 'aria-hidden': 'true' } }), text, btn);
  el.hidden = true;
  if (host) host.appendChild(el);
  let cur = null;
  let shownAt = 0;
  let now = 0;
  const marked = new Set();   // marked this session (the uiFlag command applies at the next tick)
  const mark = (key) => {
    marked.add(key);
    try { game.actions.do('uiFlag', { key: calloutFlag(key), value: true }); } catch { /* best effort */ }
  };
  const dismiss = () => {
    if (cur) mark(cur);
    cur = null;
    el.hidden = true;
  };
  btn.addEventListener('click', dismiss);
  return {
    el,
    show(key) {
      const c = marked.has(key) ? null : calloutFor(game.s, key);
      if (!c) return false;
      if (cur && cur !== key) mark(cur);
      cur = key;
      shownAt = -1;   // the clock starts at the next update (app time)
      setText(text, c.text);
      el.hidden = false;
      return true;
    },
    update(nowMs) {
      if (Number.isFinite(nowMs)) now = nowMs;
      if (cur && shownAt < 0) shownAt = now;
      if (cur && now - shownAt >= CALLOUT_MS) dismiss();
    },
    current: () => cur,
    /**
     * After a reload: show again the callout of the latest reveal if it came within the callout lifetime (sim time)
     * and was never acknowledged. meta.seen keeps insertion order, so its last keys are the latest reveals.
     */
    resume() {
      const s = game.s;
      if (cur || !s || !s.meta || !s.meta.reveal) return false;
      if (num(s.meta.simTime) - num(s.meta.reveal.lastAt) > CALLOUT_MS / 1000) return false;
      const keys = Object.keys(obj(s.meta.seen));
      for (let i = keys.length - 1; i >= 0; i--) if (CALLOUTS[keys[i]]) return this.show(keys[i]);
      return false;
    },
    dismiss,
    /** Hide without recording (a reset or an import: the callout belonged to the old colony). */
    hide() {
      cur = null;
      el.hidden = true;
    },
    destroy() {
      btn.removeEventListener('click', dismiss);
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
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

