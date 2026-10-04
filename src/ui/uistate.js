// Shared, non-persisted UI store: tool, selection, hover, overlays, layout, view, active tab, onboarding glow.
// Owner: WP9. Contract: ARCHITECTURE §14.4. WP8 writes selection (via the bridge), hover and tool completion;
// WP9 writes everything else. Pure module (no DOM), so Node tests can import it.

/** Tab ids in display order (keyboard 1–9 follows this order). */
export const TAB_IDS = Object.freeze(['colony', 'build', 'map', 'research', 'prestige', 'achievements', 'guide', 'stats', 'settings']);

/** Sub-tab ids per tab (ARCHITECTURE §14.4). */
export const SUB_TABS = Object.freeze({
  build: Object.freeze(['inspect']),
  map: Object.freeze(['war']),
  prestige: Object.freeze(['flight', 'bloodline', 'hardships', 'supercolony', 'federation', 'edicts', 'speciation', 'genome', 'species']),
});

/** Overlay ids (DESIGN §25.7). */
export const OVERLAY_IDS = Object.freeze(['climate', 'raid_reach', 'haul', 'adjacency', 'territory', 'trail_strength', 'danger', 'richness']);

/** Layout ids (DESIGN §25.1). */
export const LAYOUTS = Object.freeze(['wide-tall', 'wide-short', 'medium', 'narrow']);

/**
 * View ids (every layout, C96): 'split' = Above stacked over Below, 'side' = side by side (Below | seam | Above),
 * 'above' / 'below' = one canvas. Display and V-key cycling order is VIEW_ORDER.
 */
export const VIEWS = Object.freeze(['split', 'side', 'above', 'below']);
export const VIEW_ORDER = Object.freeze(['above', 'below', 'split', 'side']);
export const VIEW_LABELS = Object.freeze({ above: 'Above', below: 'Below', split: 'Stacked', side: 'Side by side' });
/** localStorage key of the player's chosen view (a per-browser UI convenience, outside the save). */
export const VIEW_KEY = 'sld.ui.view';

/**
 * Views a layout offers: side by side needs at least the medium width (≥ 768 px).
 * @param {string} layout
 * @returns {string[]}
 */
export function viewsFor(layout) {
  return layout === 'narrow' ? VIEW_ORDER.filter((v) => v !== 'side') : [...VIEW_ORDER];
}

/**
 * The view a layout starts in when the player has not picked one: wide-tall and medium stack, wide-short sits side by
 * side (DESIGN §25.1), narrow shows Above.
 * @param {string} layout
 * @returns {string}
 */
export function defaultViewFor(layout) {
  if (layout === 'wide-short') return 'side';
  if (layout === 'narrow') return 'above';
  return 'split';
}

/**
 * The view actually laid out: an unknown view stacks, and side by side stacks on narrow screens.
 * @param {string} view
 * @param {string} layout
 * @returns {'split'|'side'|'above'|'below'}
 */
export function effectiveView(view, layout) {
  const v = VIEWS.includes(view) ? view : 'split';
  return v === 'side' && !viewsFor(layout).includes('side') ? 'split' : v;
}

/**
 * Which canvases a view shows.
 * @param {string} view
 * @param {string} layout
 * @returns {{ above: boolean, below: boolean }}
 */
export function viewShows(view, layout) {
  const v = effectiveView(view, layout);
  return { above: v !== 'below', below: v !== 'above' };
}

/**
 * The next view for the V key (cycles through the layout's views).
 * @param {string} view
 * @param {string} layout
 * @returns {string}
 */
export function nextView(view, layout) {
  const list = viewsFor(layout);
  const i = list.indexOf(effectiveView(view, layout));
  return list[(i + 1) % list.length];
}

/** Canvas each tool works on (ARCHITECTURE §14.4 tool kinds). */
export const TOOL_VIEW = Object.freeze({
  placeChamber: 'nest', relocate: 'nest', backfill: 'nest', levelDir: 'nest', growRoot: 'nest', movePocket: 'nest',
  claim: 'surface', flag: 'surface', reroute: 'surface', placeSatellite: 'surface', moveAphids: 'surface', tournament: 'surface',
});

/**
 * 'nest' | 'surface' for a tool, or null (no tool / unknown kind).
 * @param {Object|null} tool
 * @returns {'nest'|'surface'|null}
 */
export function toolView(tool) {
  return tool && typeof tool.kind === 'string' && Object.prototype.hasOwnProperty.call(TOOL_VIEW, tool.kind) ? TOOL_VIEW[tool.kind] : null;
}

/**
 * A fresh UIState with the documented defaults.
 * @returns {Object}
 */
export function defaultUI() {
  const overlays = {};
  for (const id of OVERLAY_IDS) overlays[id] = false;
  return {
    tool: null,
    selection: null,
    hover: null,
    overlays,
    layout: 'wide-tall',
    view: 'split',
    tab: 'colony',
    subTab: null,
    ghostDemo: null,
    glow: null,
  };
}

let state = defaultUI();
/** @type {Set<Function>} */
const listeners = new Set();

/**
 * The current UI state (the live object; treat it as read-only and change it through setUI).
 * @returns {Object}
 */
export function getUI() {
  return state;
}

/**
 * Shallow-merge `patch` into the UI state and notify listeners with (state, changedKeys) when anything changed.
 * Keys whose value is identical (===) are not counted as changes. `overlays` is replaced, not merged; use
 * setOverlay() to flip one overlay.
 * @param {Object} patch
 */
export function setUI(patch) {
  if (!patch || typeof patch !== 'object') return;
  const changed = [];
  const next = { ...state };
  for (const k of Object.keys(patch)) {
    if (next[k] !== patch[k]) {
      next[k] = patch[k];
      changed.push(k);
    }
  }
  if (changed.length === 0) return;
  state = next;
  for (const fn of Array.from(listeners)) {
    try {
      fn(state, changed);
    } catch (err) {
      console.error('[uistate] listener error', err);
    }
  }
}

/**
 * Turn one overlay on or off (or toggle it when `on` is omitted).
 * @param {string} id
 * @param {boolean} [on]
 */
export function setOverlay(id, on) {
  if (!OVERLAY_IDS.includes(id)) return;
  const cur = !!state.overlays[id];
  const val = on === undefined ? !cur : !!on;
  if (val === cur) return;
  setUI({ overlays: { ...state.overlays, [id]: val } });
}

/**
 * Subscribe to UI changes. fn(state, changedKeys).
 * @param {Function} fn
 * @returns {() => void} unsubscribe
 */
export function onUI(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Reset to the defaults (new game, tests). Listeners stay subscribed and are notified of every changed key.
 */
export function resetUI() {
  setUI(defaultUI());
}

/**
 * Two targets refer to the same thing (view, kind, id/i/hex).
 * @param {Object|null} a
 * @param {Object|null} b
 * @returns {boolean}
 */
export function sameTarget(a, b) {
  if (!a || !b) return a === b;
  return a.view === b.view && a.kind === b.kind && a.id === b.id && a.i === b.i && a.hex === b.hex;
}
