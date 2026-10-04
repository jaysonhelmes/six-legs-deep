// App shell: mountUI() builds/attaches the DOM skeleton, layouts and breakpoints, tabs and panels (reveal-on-unlock),
// the 4 Hz refresh, bus subscriptions, keyboard shortcuts and the bridge used by the canvas input controllers.
// Owner: WP9. Contract: ARCHITECTURE §14.1, §14.2, §14.4–§14.6; DESIGN §25.

import * as uistate from './uistate.js';
import { TAB_IDS, getUI, setUI, onUI, sameTarget, VIEWS, VIEW_ORDER, VIEW_LABELS, VIEW_KEY, viewsFor, defaultViewFor, effectiveView, viewShows,
  nextView, toolView } from './uistate.js';
import { h, show, toggleClass, clear } from './dom.js';
import { setNotation, fmt, fmtTime } from './format.js';
import {
  TAB_NAMES, TAB_TIPS, reasonText, eventToast, EVENT_COPY, nameOf, cosmeticVariant,
} from './text.js';
import { isShown, num, arr, obj, fedLevel } from './reveal.js';
import { createHud, activeThreats, EVENT_THREAT } from './hud.js';
import { createIntro, isIntro, ALWAYS_TABS as UTILITY_TABS } from './intro.js';
import { createTooltips } from './tooltips.js';
import { createToasts } from './toasts.js';
import {
  createModalHost, openFlightConfirm, openHardshipConfirm, openSupercolonyDialog, openSpeciationDialog, openLandingChooser,
  openHardReset, openImportConfirm, openEnding, openPupaChooser, openSatelliteColumn, openWarChooser, fallbackMiniMap,
} from './modals.js';
import { createEventCard } from './eventCard.js';
import { openColonyHistory } from './history.js';
import { openManual, toggleManual } from './manual.js';
import { MANUAL_KEYS } from './manualContent.js';
import { openWelcome } from './welcome.js';
import { createOnboarding } from './onboarding.js';
import { isClickableSource } from './panels/map.js';
import { satelliteHexWhy, frontWindows, frontWindowSec, spanText } from './rules.js';
import * as colonyPanel from './panels/colony.js';
import * as buildPanel from './panels/build.js';
import * as mapPanel from './panels/map.js';
import * as adaptationsPanel from './panels/adaptations.js';
import * as researchPanel from './panels/research.js';
import * as prestigePanel from './panels/prestige.js';
import * as achievementsPanel from './panels/achievements.js';
import * as guidePanel from './panels/guide.js';
import * as statsPanel from './panels/stats.js';
import * as settingsPanel from './panels/settings.js';
import { LOOP, GRID } from '../data/balance.js';
import { RESET } from '../data/prestige.js';
import { EVENTS } from '../data/events.js';
import { bestOrigin } from '../systems/trails.js';

/** Reveal key of every tab (ARCHITECTURE §14.5). */
export const TAB_KEYS = Object.freeze({
  colony: 'panel_colony', build: 'panel_build', map: 'panel_map', adaptations: 'adapt_basic', research: 'panel_research', prestige: 'panel_prestige',
  achievements: 'panel_achievements', guide: 'tab_guide', stats: 'tab_stats', settings: 'tab_settings',
});

/** Panel modules per tab. */
const PANELS = {
  colony: colonyPanel, build: buildPanel, map: mapPanel, adaptations: adaptationsPanel, research: researchPanel, prestige: prestigePanel,
  achievements: achievementsPanel, guide: guidePanel, stats: statsPanel, settings: settingsPanel,
};

/** Toast-worthy bus events (copy in text.js eventToast). */
const TOAST_EVENTS = ['achievement', 'fieldGuide', 'unlock', 'raidWarning', 'raidResult', 'conquest', 'battleEnd', 'hungryStart', 'hungryEnd',
  'winterSoon', 'seasonChanged', 'chamberActivated', 'cacheFound', 'softcapHit', 'beetleClaimed', 'beetleSpawned', 'pupaSpawned',
  'hardshipTier', 'entranceOpened', 'rivalSighted', 'adultsDied', 'broodDied', 'giftOpened', 'commandRejected', 'flightComplete',
  'supercolonyComplete', 'speciationComplete', 'blueprintDropped', 'trailRehomed'];
/**
 * Panel unlock keys and their tabs. A reveal never steals the open tab (the onboarding glow could otherwise point at
 * one tab while the shell had switched to another): the new tab slides in with a "new" dot. Only while the welcome
 * card holds the panel column (nothing to steal) is the first panel preselected (DESIGN §23).
 */
const PANEL_UNLOCKS ={ panel_colony: 'colony', panel_build: 'build', panel_map: 'map', adapt_basic: 'adaptations', panel_research: 'research', panel_prestige: 'prestige',
  panel_achievements: 'achievements' };
const REFRESH_MS = 250;
const SHEETS = ['peek', 'half', 'full'];

/**
 * Layout for a viewport (DESIGN §25.1): wide-tall (≥ 1280 × ≥ 820), wide-short (≥ 1280 wide), medium (768–1279), narrow (< 768).
 * @param {number} width
 * @param {number} height
 * @returns {'wide-tall'|'wide-short'|'medium'|'narrow'}
 */
export function layoutFor(width, height) {
  const w = Number.isFinite(width) ? width : 1280;
  const hgt = Number.isFinite(height) ? height : 900;
  if (w >= 1280) return hgt >= 820 ? 'wide-tall' : 'wide-short';
  if (w >= 768) return 'medium';
  return 'narrow';
}

/**
 * Tabs whose reveal key is revealed, in display order.
 * @param {Object} s
 * @returns {string[]}
 */
export function visibleTabs(s) {
  return TAB_IDS.filter((id) => isShown(s, TAB_KEYS[id]));
}

/** First-load inset mode: the Below view is a 30 % inset until panel_build is revealed (DESIGN §25.1). */
export function isInset(s) {
  return !isShown(s, 'panel_build');
}

/**
 * Mount the UI on the #app root.
 * @param {HTMLElement} root
 * @param {Object} game core/game.js Game
 * @param {{ loadRender?: boolean }} [opts] loadRender (default true): lazily load render/minimap.js and render/ceremony.js
 * @returns {{ canvases: Object, bridge: Object, frame(nowMs: number): void, showWelcome(summary: Object): void, destroy(): void,
 *            attachRenderers(r: Object): void, refresh(): void, openTab(id: string, sub?: string|null): void }}
 */
export function mountUI(root, game, opts = {}) {
  const docu = (root && root.ownerDocument) || globalThis.document;
  const win = (docu && docu.defaultView) || globalThis.window || null;
  const offs = [];
  let now = 0;
  let lastRefresh = -Infinity;
  let tickCount = 0;
  let renderers = null;
  let sheet = 'peek';
  let drawerOpen = false;
  let unseenPanel = false; // a panel was preselected by an unlock while the sheet/drawer was closed
  let landingReady = true;
  let landingDeadline = 0;
  let endingShown = false;
  let pendingFocus = null;
  let lastPointer = null; // last canvas pointer position (bridge.hover), for refusals raised without one
  let audio = null;
  const panelErr = new Set();

  // ------------------------------------------------------------------ skeleton (index.html provides it; built if missing)
  const byId = (id) => (root.querySelector ? root.querySelector('#' + id) : null) || (docu.getElementById ? docu.getElementById(id) : null);
  const ensure = (id, tag, parent, cls = null) => {
    let el = byId(id);
    if (!el) {
      el = docu.createElement(tag);
      el.id = id;
      if (cls) el.className = cls;
      parent.appendChild(el);
    }
    return el;
  };
  const rail = ensure('rail', 'aside', root);
  const stage = ensure('stage', 'main', root);
  const hudTop = ensure('hud-top', 'header', stage);
  const viewAbove = ensure('view-above', 'section', stage);
  const canvasAbove = ensure('canvas-above', 'canvas', viewAbove);
  const flowStrip = ensure('flow-strip', 'div', stage);
  const canvasSeam = ensure('canvas-seam', 'canvas', flowStrip);
  const viewBelow = ensure('view-below', 'section', stage);
  const canvasBelow = ensure('canvas-below', 'canvas', viewBelow);
  const nestStrip = ensure('nest-strip', 'canvas', viewBelow);
  const overlayBar = ensure('overlay-bar', 'nav', stage);
  const viewTabs = ensure('view-tabs', 'nav', stage);
  const panels = ensure('panels', 'aside', root);
  const tabsEl = ensure('tabs', 'nav', panels);
  const panelBody = ensure('panel-body', 'div', panels);
  const eventCardEl = ensure('event-card', 'div', root);
  const toastsEl = ensure('toasts', 'div', root);
  const tooltipEl = ensure('tooltip', 'div', root);
  const modalRoot = ensure('modal-root', 'div', root);
  const canvases = { above: canvasAbove, below: canvasBelow, seam: canvasSeam, nestStrip };
  canvasAbove.setAttribute('aria-label', 'Surface map');
  canvasBelow.setAttribute('aria-label', 'Nest cross-section');

  // ------------------------------------------------------------------ services
  const toasts = createToasts(toastsEl);
  const modals = createModalHost(modalRoot);
  const toast = (text, kind = 'info', o = {}) => toasts.push(text, kind, o);
  const ext = { drawMiniMap: fallbackMiniMap, playCeremony: () => Promise.resolve() };
  if (opts.loadRender !== false) {
    import('../render/minimap.js').then((m) => { if (m && typeof m.drawMiniMap === 'function') ext.drawMiniMap = m.drawMiniMap; }).catch(() => {});
    import('../render/ceremony.js').then((m) => { if (m && typeof m.playCeremony === 'function') ext.playCeremony = m.playCeremony; }).catch(() => {});
  }
  /** Ceremony targets (§13.3 playCeremony takes the renderers; the canvases are the fallback before attachRenderers). */
  const ceremonyTargets = () => ({
    nest: (renderers && renderers.nest) || canvases.below,
    surface: (renderers && renderers.surface) || canvases.above,
  });
  const mctx = { game, modals, toast, ext, canvases, ceremonyTargets, ui: uistate };
  const dialogs = {
    flight: () => openFlightConfirm(mctx),
    hardship: (id) => openHardshipConfirm(mctx, id),
    supercolony: () => openSupercolonyDialog(mctx),
    speciation: () => openSpeciationDialog(mctx),
    hardReset: () => openHardReset(mctx, () => afterReset()),
    importSave: (str, cb) => openImportConfirm(mctx, str, cb),
    history: () => openColonyHistory(mctx),   // C130: Colony History gallery (Prestige tab)
    manual: (o) => openManual(manualCtx, o),  // C131: the Manual (book button, H / ?)
  };
  /** Manual context (C131): tab buttons inside entries open a revealed tab. */
  const manualCtx = { ...mctx, openTab: (id, sub) => openTab(id, sub), tabShown: (id) => tabVisible(id) };

  // ------------------------------------------------------------------ bridge
  const bridge = {
    hover(target, clientX, clientY) {
      if (Number.isFinite(clientX) && Number.isFinite(clientY) && (clientX > 0 || clientY > 0)) lastPointer = { x: clientX, y: clientY };
      if (!sameTarget(getUI().hover, target || null)) setUI({ hover: target || null });
      tooltips.showTarget(target || null, clientX, clientY);
    },
    select(target) {
      setUI({ selection: target || null });
      if (!target) return;
      if (target.view === 'surface' && target.kind === 'rival') pendingFocus = { type: 'rival', uid: target.id };
      if (target.view === 'surface' && target.kind === 'source') {
        const src = arr(game.s.run.surface && game.s.run.surface.sources).find((x) => x && x.uid === target.id);
        if (src && !isClickableSource(src.type)) pendingFocus = { type: 'source', uid: src.uid };
      }
      if (target.view === 'surface' && target.kind === 'trail' && isShown(game.s, TAB_KEYS.map)) openTab('map', null);
    },
    openTab(tabId, sub = null) {
      openTab(tabId, sub);
    },
    openChooser(kind, data = {}) {
      if (kind === 'pupa') openPupaChooser(mctx);
      else if (kind === 'satelliteColumn') openSatellite(data);
      else if (kind === 'war') openWarChooser(mctx, data);
    },
    contextMenu(target, x, y) {
      openMenu(target, x, y);
    },
    /** type (optional, UI extension): the refused command, for command-specific copy; inferred from the tool otherwise. */
    reject(reason, x, y, type = null) {
      const t = type || inferType();
      // a satellite hex refused by the canvas tool: say how far the nearest entrance is (rules.satelliteHexWhy)
      const hv = getUI().hover;
      const satWhy = t === 'placeSatellite' && hv && hv.view === 'surface' && num(hv.hex, -1) >= 0 && /^blocked:(entrance|unowned|terrain)$/.test(String(reason))
        ? satelliteHexWhy(game.s, game.d, num(hv.hex), reasonText) : '';
      popReject(satWhy || reasonText(reason, t), x, y);
    },
    toast(text, kind = 'info') {
      toasts.push(text, kind, { priority: kind === 'danger' ? 'high' : 'low' });
    },
    /**
     * UI extension (WP9): bring a spot into view, e.g. from a HUD warning chip. loc = { view: 'nest', cell?, row?,
     * chamber? } | { view: 'surface', hex }. Lowers the sheet / closes the drawer so the canvas is visible, switches
     * the medium/narrow view, scrolls (nestRenderer.scrollToRow) or centres (surfaceRenderer.centerOn) and selects.
     */
    locate(loc) {
      locate(loc);
    },
  };

  const tooltips = createTooltips(tooltipEl, root, { game });
  const hud = createHud({ rail, hudTop, flowStrip, overlayBar }, { game, ui: uistate, bridge });
  const eventCard = createEventCard(eventCardEl, { game, bridge });
  const onboarding = createOnboarding({ game, ui: uistate, root });

  // ------------------------------------------------------------------ banner, view tabs, panel chrome
  const banner = h('div', { class: 'storage-banner', role: 'alert' }, h('span', { text: 'Saving unavailable: use Export (Settings) to keep your colony.' }),
    h('button', { type: 'button', class: 'btn btn-small', text: 'Export…', on: { click: () => openTab('settings') } }));
  banner.hidden = true;
  root.appendChild(banner);

  // View switcher (every layout, C96): Above / Below / Stacked / Side by side; the choice is kept per browser.
  const viewBtns = {};
  viewTabs.setAttribute('role', 'group');
  for (const id of VIEW_ORDER) {
    const b = h('button', { type: 'button', class: 'view-tab', dataset: { view: id, tip: VIEW_LABELS[id] + ' view. Key V cycles the views.' },
      text: VIEW_LABELS[id], attrs: { 'aria-pressed': 'false', 'aria-keyshortcuts': 'V' },
      on: { click: () => chooseView(id) } });
    viewBtns[id] = b;
    viewTabs.appendChild(b);
  }
  // Flip: swap which side Above and Below sit on in the two-canvas views (remembered per browser).
  const FLIP_KEY = 'sld.ui.viewFlip';
  let flipped = false;
  try { flipped = !!(win && win.localStorage && win.localStorage.getItem(FLIP_KEY) === '1'); } catch { /* storage blocked */ }
  const flipBtn = h('button', { type: 'button', class: 'view-tab view-flip', dataset: { tip: 'Swap the sides of the map and the nest.' },
    text: '⇄', attrs: { 'aria-label': 'Swap map and nest sides', 'aria-pressed': 'false' },
    on: { click: () => {
      flipped = !flipped;
      try { if (win && win.localStorage) win.localStorage.setItem(FLIP_KEY, flipped ? '1' : '0'); } catch { /* this session only */ }
      syncViews();
    } } });
  viewTabs.appendChild(flipBtn);
  /** The view the player picked last in this browser, or null. */
  function storedView() {
    try {
      const v = win && win.localStorage ? win.localStorage.getItem(VIEW_KEY) : null;
      return VIEWS.includes(v) ? v : null;
    } catch {
      return null;
    }
  }
  /** Player choice: switch and remember it (programmatic switches, e.g. locate, are not remembered). */
  function chooseView(id) {
    if (!VIEWS.includes(id)) return;
    setUI({ view: id });
    try { if (win && win.localStorage) win.localStorage.setItem(VIEW_KEY, id); } catch { /* storage blocked: this session only */ }
  }
  let viewLayout = null; // the layout the current view was chosen for

  const sheetBtn = h('button', { type: 'button', class: 'sheet-handle', attrs: { 'aria-label': 'Resize panel' },
    on: { click: () => setSheet(SHEETS[(SHEETS.indexOf(sheet) + 1) % SHEETS.length]) } }, h('span', { class: 'grip' }));
  const drawerClose = h('button', { type: 'button', class: 'drawer-close', text: '×', attrs: { 'aria-label': 'Close panels' },
    on: { click: () => setDrawer(false) } });
  panels.insertBefore(sheetBtn, tabsEl);
  panels.insertBefore(drawerClose, tabsEl);
  const panelsToggle = h('button', { type: 'button', class: 'btn btn-small panels-toggle', text: 'Panels', on: { click: () => {
    const st = getUI();
    if (st.layout === 'narrow') setSheet(sheet === 'peek' ? 'half' : 'peek');
    else setDrawer(!drawerOpen);
  } } });
  hud.actions.appendChild(panelsToggle);

  const tabBtns = {};
  // Tabs the player has opened, kept per browser (a UI convenience, not game state) so that a tab revealed during an
  // offline catch-up or before a reload still carries its "new" dot. freshTabs = revealed gameplay tabs never opened.
  const VISITED_KEY = 'sld.ui.visitedTabs';
  let visitedSeeded = false; // false: nothing stored yet (first visit with this browser, or an older build)
  const visited = loadVisited();
  const freshTabs = new Set();
  function loadVisited() {
    try {
      const raw = win && win.localStorage ? win.localStorage.getItem(VISITED_KEY) : null;
      visitedSeeded = raw !== null && raw !== undefined;
      const list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list.filter((x) => TAB_IDS.includes(x)) : []);
    } catch {
      return new Set();
    }
  }
  /** Treat every tab revealed right now as already known (an existing colony is not new to its player). */
  function seedVisited() {
    for (const id of visibleTabs(game.s)) visited.add(id);
    visitedSeeded = true;
    saveVisited();
  }
  function markVisited(id) {
    if (visited.has(id)) return;
    visited.add(id);
    saveVisited();
  }
  function saveVisited() {
    try { if (win && win.localStorage) win.localStorage.setItem(VISITED_KEY, JSON.stringify([...visited])); } catch { /* storage blocked: memory only */ }
  }
  TAB_IDS.forEach((id, i) => {
    // number keys 1–9 follow TAB_IDS; a tab past the ninth (Settings since C143) has no key
    const key = i < 9 ? String(i + 1) : null;
    const b = h('button', { type: 'button', class: 'tab', role: 'tab', dataset: { tab: id, tip: (TAB_TIPS[id] || TAB_NAMES[id]) + (key ? ' Key ' + key + '.' : '') },
      attrs: key ? { 'aria-selected': 'false', 'aria-keyshortcuts': key } : { 'aria-selected': 'false' },
      on: { click: () => openTab(id) } },
    h('span', { class: 'tab-num', text: key || '', attrs: { 'aria-hidden': 'true' } }),
    // the always-on utility tabs (Field Guide, Stats, Settings) show as icons at the end of the row on wide layouts
    UTILITY_TABS.includes(id) ? h('span', { class: 'tab-ico', attrs: { 'aria-hidden': 'true' } }) : null,
    h('span', { class: 'tab-label', text: TAB_NAMES[id] }));
    if (UTILITY_TABS.includes(id)) {
      b.classList.add('util');
      b.setAttribute('aria-label', TAB_NAMES[id]);
    }
    b.hidden = true;
    tabBtns[id] = b;
    tabsEl.appendChild(b);
  });
  // C131: the Manual (book icon) beside the utility tabs, visible from the start; not a tab (it opens a modal)
  const manualBtn = h('button', { type: 'button', class: 'tab util manual-btn', dataset: { manual: '1', tip: 'Manual: chambers, ants, resources and prestige. Key H.' },
    attrs: { 'aria-label': 'Manual', 'aria-keyshortcuts': 'H' }, on: { click: () => toggleManual(manualCtx) } },
  h('span', { class: 'tab-ico', attrs: { 'aria-hidden': 'true' } }));
  tabsEl.appendChild(manualBtn);
  tabsEl.setAttribute('role', 'tablist');
  const panelHosts = {};
  const panelInst = {};
  // Opening state: a welcome card holds the panel column until the first gameplay panel reveals (src/ui/intro.js).
  const introHost = h('div', { class: 'panel-host intro-host' });
  panelBody.appendChild(introHost);
  const intro = createIntro(introHost, viewAbove, { game });
  let welcomeShown = false;

  function setSheet(v) {
    sheet = v;
    root.setAttribute('data-sheet', v);
    if (v !== 'peek') unseenPanel = false;
  }
  function setDrawer(on) {
    drawerOpen = !!on;
    root.setAttribute('data-drawer', drawerOpen ? 'open' : 'closed');
    if (drawerOpen) unseenPanel = false;
  }
  setSheet('peek');
  setDrawer(false);

  function tabVisible(id) {
    return isShown(game.s, TAB_KEYS[id]);
  }

  /**
   * Select a tab (and sub-tab). expand (default true) also opens the bottom sheet (narrow) or the drawer (medium);
   * the automatic preselect on an unlock passes false so the canvas is never covered while the player is busy on it
   * (the Panels toggle / sheet handle then carry a "new" cue until the panels are opened).
   * @param {string} tabId
   * @param {string|null} [sub]
   * @param {{ expand?: boolean }} [o]
   */
  function openTab(tabId, sub = null, { expand = true } = {}) {
    if (!TAB_IDS.includes(tabId)) return;
    if (!tabVisible(tabId)) return;
    // switching to another panel tab puts down the active canvas tool (claim, satellite, chamber placement…), C96
    const switching = getUI().tab !== tabId;
    setUI(switching && getUI().tool ? { tab: tabId, subTab: sub, tool: null } : { tab: tabId, subTab: sub });
    markVisited(tabId);
    freshTabs.delete(tabId);
    const st = getUI();
    if (expand) {
      if (st.layout === 'narrow' && sheet === 'peek') setSheet('half');
      if (st.layout === 'medium') setDrawer(true);
    } else if ((st.layout === 'narrow' && sheet === 'peek') || (st.layout === 'medium' && !drawerOpen)) {
      unseenPanel = true;
    }
    refresh(true);
  }

  function ensurePanel(id) {
    if (panelInst[id]) return panelInst[id];
    const host = h('div', { class: 'panel-host', dataset: { tab: id }, role: 'tabpanel' });
    panelBody.appendChild(host);
    panelHosts[id] = host;
    try {
      panelInst[id] = PANELS[id].createPanel(host, { game, ui: uistate, bridge, dialogs, appRoot: root });
    } catch (err) {
      console.error('[ui] panel failed to build:', id, err);
      host.appendChild(h('p', { class: 'note warn', text: 'This panel could not be shown.' }));
      panelInst[id] = { update() {}, destroy() {} };
    }
    return panelInst[id];
  }

  // ------------------------------------------------------------------ layout
  function applyLayout() {
    const w = win ? win.innerWidth : 1280;
    const hh = win ? win.innerHeight : 900;
    const layout = layoutFor(w, hh);
    root.setAttribute('data-layout', layout);
    if (getUI().layout !== layout || viewLayout !== layout) {
      // a new layout opens in the player's remembered view, else in the layout's own default (C96)
      const patch = { layout };
      if (viewLayout !== layout) patch.view = storedView() || defaultViewFor(layout);
      viewLayout = layout;
      setUI(patch);
    }
    syncViews();
  }

  function syncViews() {
    const st = getUI();
    const inset = isInset(game.s);
    const view = effectiveView(st.view, st.layout);
    root.setAttribute('data-inset', inset ? 'true' : 'false');
    root.setAttribute('data-view', view);
    root.setAttribute('data-flip', flipped ? 'true' : 'false');
    flipBtn.hidden = !(view === 'split' || view === 'side');
    flipBtn.textContent = view === 'side' ? '⇄' : '⇅';
    toggleClass(flipBtn, 'active', flipped);
    flipBtn.setAttribute('aria-pressed', flipped ? 'true' : 'false');
    const offered = viewsFor(st.layout);
    for (const id of Object.keys(viewBtns)) {
      viewBtns[id].hidden = !offered.includes(id);
      toggleClass(viewBtns[id], 'active', view === id);
      viewBtns[id].setAttribute('aria-pressed', view === id ? 'true' : 'false');
    }
    const shows = viewShows(view, st.layout);
    const aboveVis = shows.above || inset;
    const belowVis = shows.below || inset;
    if (renderers) {
      const r = renderers;
      if (r.__inset !== inset && r.nest && typeof r.nest.setInset === 'function') { r.__inset = inset; safe(() => r.nest.setInset(inset)); }
      if (r.__above !== aboveVis && r.surface && typeof r.surface.setVisible === 'function') { r.__above = aboveVis; safe(() => r.surface.setVisible(aboveVis)); }
      if (r.__below !== belowVis && r.nest && typeof r.nest.setVisible === 'function') { r.__below = belowVis; safe(() => r.nest.setVisible(belowVis)); }
    }
  }

  function safe(fn) {
    try { fn(); } catch (err) { console.error('[ui]', err); }
  }

  if (win && win.addEventListener) {
    const onResize = () => applyLayout();
    win.addEventListener('resize', onResize);
    offs.push(() => win.removeEventListener('resize', onResize));
  }
  offs.push(onUI((st, changed) => {
    if (changed.includes('view') || changed.includes('layout')) syncViews();
    // tool lifecycle (C96): arming a tool brings its canvas into view; hiding a tool's canvas puts the tool down
    const tv = toolView(st.tool);
    if (tv && !isInset(game.s)) {
      const shows = viewShows(st.view, st.layout);
      const visible = tv === 'nest' ? shows.below : shows.above;
      if (!visible) {
        if (changed.includes('tool')) setUI({ view: tv === 'nest' ? 'below' : 'above' });
        else if (changed.includes('view') || changed.includes('layout')) setUI({ tool: null });
      }
    }
    if (changed.includes('tab') || changed.includes('subTab') || changed.includes('selection') || changed.includes('tool') || changed.includes('glow')) refresh(true);
  }));

  // ------------------------------------------------------------------ context menu
  let menu = null;
  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }
  function menuItems(t) {
    const s = game.s;
    const A = (type, args, label) => ({ label, run: (ev) => runAct(type, args, ev) });
    const items = [];
    if (!t) return items;
    if (t.kind === 'chamber' || t.kind === 'nursery' || t.kind === 'queen') { // nursery/queen picks carry the chamber uid
      items.push({ label: 'Inspect / level up', run: () => { bridge.select(t); openTab('build', 'inspect'); } });
      items.push({ label: 'Relocate', run: () => setUI({ tool: { kind: 'relocate', uid: t.id } }) });
      if (t.id !== 1) items.push({ label: 'Demolish…', run: () => { bridge.select(t); openTab('build', 'inspect'); } });
    } else if (t.kind === 'trail') {
      if (isShown(s, 'ability_mark')) items.push(A('mark', { uid: t.id }, 'Mark'));
      if (isShown(s, 'ability_rally')) items.push(A('rally', { uid: t.id }, 'Rally'));
      items.push({ label: 'Reroute', run: () => setUI({ tool: { kind: 'reroute', uid: t.id } }) });
      items.push(A('deleteTrail', { uid: t.id }, 'Delete trail'));
    } else if (t.kind === 'rival') {
      items.push({ label: 'Raid…', run: () => bridge.openChooser('war', { kind: 'raid', target: { type: 'rival', uid: t.id } }) });
      items.push({ label: 'Assault…', run: () => bridge.openChooser('war', { kind: 'assault', target: { type: 'rival', uid: t.id } }) });
      items.push(A('bribe', { rival: t.id }, 'Bribe'));
      if (getUI().tool === null) items.push({ label: 'Tournament…', run: () => setUI({ tool: { kind: 'tournament', rival: t.id } }) });
    } else if (t.kind === 'source' || t.kind === 'eventObject') {
      // C115: a fallen fruit's event object sits on its source, so right-clicking the fruit offers the source's actions
      let src = null;
      if (t.kind === 'eventObject') {
        const o = arr(s.run.events && s.run.events.objects).find((x) => x && x.uid === t.id);
        const su = o && o.kind === 'fruit' && o.data ? o.data.src : undefined;
        src = Number.isInteger(su) ? arr(s.run.surface.sources).find((x) => x && x.uid === su) || null : null;
      } else {
        src = arr(s.run.surface.sources).find((x) => x && x.uid === t.id) || null;
      }
      if (src && isClickableSource(src.type)) items.push(A('clickForage', { src: src.uid }, 'Hand-forage'));
      // trails reach every forageable source, Lycaenid caterpillars too (escorted honeydew trails, job 'lycaenid')
      if (src && (isClickableSource(src.type) || src.type === 'lycaenid_caterpillar')) {
        const main = arr(s.run.surface.entrances).find((e) => e && e.kind === 'main');
        let origin = -1;
        try { origin = bestOrigin(s, game.d, src.hex); } catch { origin = -1; } // C102: nearest/best entrance
        if (origin < 0) origin = main ? main.hex : 0;
        items.push(A('drawTrail', { origin, target: src.hex, src: src.uid }, 'Draw trail from nearest entrance'));
      }
      if (src && !isClickableSource(src.type) && src.type !== 'lycaenid_caterpillar') {
        items.push({ label: src.type === 'termite_mound' ? 'Raid mound…' : 'Hunt…',
          run: () => bridge.openChooser('war', { kind: src.type === 'termite_mound' ? 'termite' : 'hunt', target: { type: 'source', uid: src.uid } }) });
      }
    } else if (t.kind === 'hex') {
      if (isShown(s, 'hex_claim')) items.push(A('claimHex', { hex: t.hex }, 'Claim hex'));
      if (s.run.research && s.run.research.antennation) {
        const on = !arr(s.run.surface.flagged).includes(t.hex);
        items.push(A('flagHex', { hex: t.hex, on }, on ? 'Flag for scouts' : 'Unflag'));
      }
      if (fedLevel(s, 'satellite_nest') > 0) items.push({ label: 'Place satellite…', run: () => bridge.openChooser('satelliteColumn', { hex: t.hex }) });
    } else if (t.kind === 'party') {
      items.push(A('recallParty', { uid: t.id }, 'Recall'));
      const b = arr(s.run.war && s.run.war.battles).find((x) => x && x.party === t.id);
      if (b) {
        const g = obj(game.d.combat && game.d.combat.garrison);
        items.push(A('reinforce', { battle: b.uid, soldier: Math.floor(num(g.soldier)), supermajor: Math.floor(num(g.supermajor)) }, 'Reinforce'));
      }
    }
    return items;
  }
  function runAct(type, args, ev) {
    const res = game.actions.do(type, args);
    if (!res.ok) popReject(reasonText(res.reason, type), ev && ev.clientX, ev && ev.clientY);
    return res;
  }
  function openMenu(target, x, y) {
    closeMenu();
    const items = menuItems(target);
    if (!items.length) return;
    menu = h('div', { class: 'ctx-menu', role: 'menu' });
    for (const it of items) {
      menu.appendChild(h('button', { type: 'button', class: 'ctx-item', role: 'menuitem', text: it.label,
        on: { click: (ev) => { closeMenu(); it.run(ev); } } }));
    }
    const vw = win ? win.innerWidth : 1280;
    const vh = win ? win.innerHeight : 900;
    menu.style.left = Math.max(8, Math.min(num(x), vw - 200)) + 'px';
    menu.style.top = Math.max(8, Math.min(num(y), vh - 40 * items.length - 16)) + 'px';
    root.appendChild(menu);
  }
  const onDocDown = (ev) => {
    if (menu && !(ev.target && menu.contains(ev.target))) closeMenu();
  };
  if (docu && docu.addEventListener) {
    docu.addEventListener('pointerdown', onDocDown);
    offs.push(() => docu.removeEventListener('pointerdown', onDocDown));
  }

  // ------------------------------------------------------------------ reject feedback
  const pops = [];
  function popReject(text, x, y) {
    if (!text) return;
    const vw = win ? win.innerWidth : 1280;
    const vh = win ? win.innerHeight : 900;
    const px = Number.isFinite(x) && x > 0 ? x : vw / 2;
    const py = Number.isFinite(y) && y > 0 ? y : vh / 2;
    const el = h('div', { class: 'reject-pop', role: 'status', text });
    el.style.left = Math.round(Math.max(8, Math.min(px, vw - 8))) + 'px';
    el.style.top = Math.round(Math.max(8, py - 28)) + 'px';
    root.appendChild(el);
    pops.push({ el, until: now + 1600 });
    while (pops.length > 3) {
      const p = pops.shift();
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
  }

  // ------------------------------------------------------------------ refusal context
  /** Command type behind a refusal raised by the canvas input (it passes none): the active tool, else the view. */
  const TOOL_COMMANDS = { placeChamber: 'placeChamber', relocate: 'relocateChamber', backfill: 'backfill', levelDir: 'levelChamber',
    claim: 'claimHex', flag: 'flagHex', reroute: 'rerouteTrail', placeSatellite: 'placeSatellite', moveAphids: 'moveAphids', tournament: 'tournament' };
  function inferType() {
    const st = getUI();
    if (st.tool && TOOL_COMMANDS[st.tool.kind]) return TOOL_COMMANDS[st.tool.kind];
    const hv = st.hover;
    if (hv && hv.view === 'nest' && (!hv.kind || hv.kind === 'cell')) return 'digTo';
    if (hv && hv.view === 'surface' && (!hv.kind || hv.kind === 'hex' || hv.kind === 'source' || hv.kind === 'entrance')) return 'drawTrail';
    return null;
  }

  /**
   * Satellite column chooser, after checking the hex (F15): a hex that can never take a satellite (not yours, too close
   * to an entrance, impassable) is refused right away with the precise reason instead of opening the column picker,
   * and the placement tool stays armed so the next click can try another hex.
   */
  function openSatellite(data) {
    const hex = num(data && data.hex, -1);
    const why = satelliteHexWhy(game.s, game.d, hex, reasonText);
    if (!why) {
      openSatelliteColumn(mctx, data);
      return;
    }
    const p = lastPointer || {};
    popReject(why, p.x, p.y);
    if (getUI().tool && getUI().tool.kind === 'placeSatellite') {
      // surfaceInput clears the tool right after openChooser returns; re-arm it once that has happened
      Promise.resolve().then(() => { if (!getUI().tool) setUI({ tool: { kind: 'placeSatellite' } }); });
    }
  }

  // ------------------------------------------------------------------ locate (warning chips, toast "Show" buttons)
  /** Nest cell to bring into view for a locate spec: the cell, else the chamber's centre, else the row's middle. */
  function nestCellOf(loc) {
    const cols = num(GRID && GRID.cols, 40);
    if (num(loc.cell, -1) >= 0) return num(loc.cell);
    if (num(loc.chamber) > 0) {
      const ch = arr(game.s.run.nest && game.s.run.nest.chambers).find((c) => c && c.uid === num(loc.chamber));
      if (ch) return (num(ch.y) + Math.floor(num(ch.h, 1) / 2)) * cols + num(ch.x) + Math.floor(num(ch.w, 1) / 2);
    }
    return Math.max(0, num(loc.row, 0)) * cols + Math.floor(cols / 2);
  }

  function locate(loc) {
    if (!loc || typeof loc !== 'object') return;
    const st = getUI();
    // the medium drawer docks beside the canvas (styles/panels.css), so it no longer has to close
    if (st.layout === 'narrow' && sheet !== 'peek') setSheet('peek');
    const shows = viewShows(st.view, st.layout);
    if (loc.view === 'nest') {
      if (!shows.below) setUI({ view: 'below' });
      const cols = num(GRID && GRID.cols, 40);
      const cell = nestCellOf(loc);
      const r = renderers && renderers.nest;
      if (r && typeof r.centerOnCell === 'function') {
        safe(() => r.centerOnCell(cell));
      } else if (r && typeof r.scrollToRow === 'function') {
        const row = num(loc.cell, -1) >= 0 || num(loc.chamber) > 0 ? Math.floor(cell / cols) : num(loc.row, 0);
        safe(() => {
          let rows = 20;
          if (typeof r.getView === 'function') rows = num(r.getView().viewRows, 20);
          r.scrollToRow(Math.max(-2, Math.round(row - rows / 2)));
        });
      }
      if (r && typeof r.ping === 'function') safe(() => r.ping(cell));
      if (num(loc.chamber) > 0) setUI({ selection: { view: 'nest', kind: 'chamber', id: num(loc.chamber) } });
    } else if (loc.view === 'surface' && num(loc.hex, -1) >= 0) {
      if (!shows.above) setUI({ view: 'above' });
      const r = renderers && renderers.surface;
      if (r && typeof r.centerOn === 'function') safe(() => r.centerOn(num(loc.hex)));
      if (r && typeof r.ping === 'function') safe(() => r.ping(num(loc.hex)));
      setUI({ selection: { view: 'surface', kind: 'hex', hex: num(loc.hex) } });
    }
  }

  // ------------------------------------------------------------------ Argentine Front window (F13)
  // rivals.js emits nothing when the first Front nest falls or when fallen nests regrow, so the shell watches the
  // windows: a toast states the rule with the deadline when one opens, and another says so when the nests regrow.
  let frontSeen = null; // Map group → fallen count at the last refresh; null until the first look (no toast on load)
  function watchFront(s) {
    const now0 = new Map();
    for (const w of frontWindows(s)) now0.set(w.group, w);
    const groups = new Set(arr(s.run.rivals && s.run.rivals.list).filter((r) => r && r.type === 'great_rival' && r.group).map((r) => r.group));
    const fallenOf = (g) => arr(s.run.rivals.list).filter((r) => r && r.type === 'great_rival' && r.group === g && r.alive === false).length;
    const next = new Map();
    for (const g of groups) next.set(g, fallenOf(g));
    if (frontSeen) {
      for (const [g, n] of next) {
        const was = frontSeen.has(g) ? frontSeen.get(g) : 0;
        const w = now0.get(g);
        if (w && was === 0 && n > 0) {
          toasts.push('Front nest fallen! Take the other ' + (w.total - w.fallen) + ' within ' + fmtTime(Math.ceil(w.remaining))
            + ' or it regrows.', 'gold', { priority: 'high', ttlMs: 9000,
            action: w.target ? { label: 'Show', fn: () => locate({ view: 'surface', hex: num(w.target.hex) }) } : null });
        } else if (!w && was > 0 && n === 0) {
          toasts.push('The fallen Argentine Front nests regrew at full strength. All ' + groupSize(s, g) + ' must fall within '
            + spanText(frontWindowSec()) + ' of each other.', 'bad', { priority: 'high', ttlMs: 9000 });
        }
      }
    }
    frontSeen = next;
  }
  function groupSize(s, g) {
    return arr(s.run.rivals.list).filter((r) => r && r.type === 'great_rival' && r.group === g).length;
  }

  // ------------------------------------------------------------------ sound
  function chime() {
    if (!game.s.meta.settings.sound || !win) return;
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      audio = audio || new AC();
      const t0 = audio.currentTime;
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t0);
      o.frequency.exponentialRampToValueAtTime(1320, t0 + 0.18);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
      o.connect(g);
      g.connect(audio.destination);
      o.start(t0);
      o.stop(t0 + 0.75);
    } catch { /* audio is optional */ }
  }

  // ------------------------------------------------------------------ bus subscriptions
  const bus = game.bus;
  const sub = (type, fn) => offs.push(bus.on(type, (e) => { try { fn(e || {}); } catch (err) { console.error('[ui] handler error', type, err); } }));
  for (const type of TOAST_EVENTS) {
    sub(type, (e) => {
      const t = eventToast(e, game.s);
      if (t) toasts.push(t.text, t.kind, { priority: t.priority });
    });
  }
  sub('unlock', (e) => {
    chime();
    const tab = PANEL_UNLOCKS[e.key];
    if (!tab) return;
    freshTabs.add(tab);
    const st = getUI();
    // Preselect only when the welcome card holds the column (the open tab was not one the player could be using).
    const others = visibleTabs(game.s).filter((id) => id !== tab);
    if (!modals.isOpen() && !others.includes(st.tab)) {
      openTab(tab, null, { expand: false });
    } else if ((st.layout === 'narrow' && sheet === 'peek') || (st.layout === 'medium' && !drawerOpen)) {
      unseenPanel = true;
    }
  });
  sub('eventSpawned', (e) => {
    eventCard.update(game.s);
    const card = game.s.run.events && game.s.run.events.card;
    if (!card || card.uid !== e.uid) {
      const copy = EVENT_COPY[e.id];
      // Threats that need a click (mold, flood…) queue instead of being dropped by the rate limit, with a "Show" button
      // when there is a spot to bring into view.
      const neg = EVENTS[e.id] && EVENTS[e.id].polarity === 'neg';
      const threatId = EVENT_THREAT[e.id];
      const findIt = () => {
        const th = activeThreats(game.s).find((x) => x.id === threatId);
        if (th && th.locate) locate(th.locate);
      };
      const canShow = neg && threatId && activeThreats(game.s).some((x) => x.id === threatId && x.locate);
      const evName = nameOf('event', e.id);
      const evText = copy && copy.toLowerCase().startsWith(evName.toLowerCase()) ? copy : evName + ': ' + copy;   // no "Drought: Drought: …"
      if (copy) toasts.push(evText, neg ? 'bad' : 'event',
        { priority: neg ? 'high' : 'low', action: canShow ? { label: 'Show', fn: findIt } : null, ttlMs: neg ? 8000 : undefined });
    }
    if (e.id === 'ev_flight_day' && game.d.meta && game.d.meta.proj && game.d.meta.proj.fly && game.d.meta.proj.fly.ok) {
      toasts.push('Flight weather! Fly now?', 'gold', { priority: 'high', action: { label: 'Fly…', fn: () => dialogs.flight() } });
    }
  });
  sub('flightComplete', (e) => startCeremony('flight', { alates: e.alates }));
  sub('supercolonyComplete', (e) => startCeremony('supercolony', { kinship: e.kinship }));
  sub('speciationComplete', (e) => startCeremony('speciation', { genes: e.genes }));
  sub('ending', () => {
    if (endingShown) return;
    endingShown = true;
    const p = safePlay('ending', {});
    Promise.resolve(p).finally(() => openEnding(mctx));
  });
  sub('welcome', (e) => showWelcome(e.summary));
  sub('offlineDone', (e) => {
    const sm = e.summary || {};
    if (num(sm.seconds) >= num(LOOP.welcomeMinSec, 300)) showWelcome(sm);
    else if (num(sm.seconds) > 0) {
      const gained = num(sm.foodGained) > 0 ? ': +' + fmt(sm.foodGained) + ' food' : '';
      toasts.push('Caught up ' + fmtTime(num(sm.seconds)) + ' while you were away' + gained + '.', 'good', { priority: 'top' });
    }
  });
  sub('storageError', () => { banner.hidden = false; });
  sub('saved', () => { banner.hidden = game.storageOk; });
  // An imported colony is written to storage at once: the save indicator then reads "Saved just now" instead of
  // "Not saved yet" (exports carry savedAt 0), and a reload before the next autosave cannot bring the old colony back.
  sub('imported', () => { game.save(Date.now()); seedVisited(); });
  for (const type of ['reset', 'imported', 'runStarted']) {
    sub(type, () => {
      frontSeen = null;
      closeMenu();
      setUI({ tool: null, selection: null, hover: null, ghostDemo: null });
      if (type === 'reset') { visited.clear(); saveVisited(); }   // a brand-new colony: every tab is new again
      tooltips.hide();
      if (type !== 'runStarted') {
        endingShown = false;
        const lm = modals.find('landing');
        if (lm && !game.s.meta.pending) modals.close(lm);
      }
      refresh(true);
    });
  }

  function safePlay(kind, summary) {
    try {
      return ext.playCeremony(kind, { ...ceremonyTargets(), summary });
    } catch (err) {
      console.error('[ui] ceremony failed', err);
      return Promise.resolve();
    }
  }

  function startCeremony(kind, summary) {
    landingReady = false;
    landingDeadline = now + 8000;
    const p = safePlay(kind, summary);
    Promise.resolve(p).catch(() => {}).finally(() => { landingReady = true; });
  }

  function afterReset() {
    setUI({ tab: 'colony', subTab: null });
    visited.clear();
    saveVisited();
    freshTabs.clear();
    unseenPanel = false;
    setSheet('peek'); // a brand-new colony starts with the canvas in full view
    setDrawer(false);
  }

  // ------------------------------------------------------------------ keyboard
  const onKey = (ev) => {
    if (!ev || ev.defaultPrevented) return;
    const tgt = ev.target || {};
    const tag = typeof tgt.tagName === 'string' ? tgt.tagName.toLowerCase() : '';
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || tgt.isContentEditable === true;
    if (ev.key === 'Escape') {
      if (menu) { closeMenu(); return; }
      if (modals.escape()) return;
      if (panelInst.settings && typeof panelInst.settings.escape === 'function' && panelInst.settings.escape()) return;
      if (getUI().tool) { setUI({ tool: null }); return; }
      if (getUI().selection) { setUI({ selection: null }); return; }
      // then close the drawer / lower the sheet so the canvas is back in full view
      const lay = getUI().layout;
      if (lay === 'medium' && drawerOpen) { setDrawer(false); refresh(true); return; }
      if (lay === 'narrow' && sheet !== 'peek') { setSheet('peek'); refresh(true); return; }
      return;
    }
    // C131: H or ? opens / closes the Manual (not while typing, nor over another dialog)
    if (!typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey && MANUAL_KEYS.includes(ev.key)) {
      if (!modals.isOpen() || modals.top() === modals.find('manual')) {
        toggleManual(manualCtx);
        ev.preventDefault();
      }
      return;
    }
    if (typing || modals.isOpen() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^[1-9]$/.test(ev.key)) {
      const id = TAB_IDS[Number(ev.key) - 1];
      if (id && tabVisible(id)) {
        openTab(id);
        ev.preventDefault();
      }
      return;
    }
    const sel = getUI().selection;
    const onButton = tag === 'button' || tag === 'a';
    if ((ev.key === ' ' || ev.code === 'Space') && !onButton) {
      if (sel && sel.kind === 'source') {
        runAct('clickForage', { src: sel.id }, null);
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === 'm' || ev.key === 'M') {
      if (sel && sel.kind === 'trail') runAct('mark', { uid: sel.id }, null);
      return;
    }
    // R is context-dependent: Rally for a selected trail, Relocate for a selected chamber (C108).
    if ((ev.key === 'r' || ev.key === 'R') && sel && sel.kind === 'trail') {
      runAct('rally', { uid: sel.id }, null);
      return;
    }
    // C142: Q on a chamber (hovered in the nest, else selected) picks its type in the Build tool to place another.
    if ((ev.key === 'q' || ev.key === 'Q') && !ev.shiftKey) {
      const hv = getUI().hover;
      const ref = hv && hv.view === 'nest' && (hv.kind === 'chamber' || hv.kind === 'nursery' || hv.kind === 'queen') ? hv : sel;
      const a = buildPanel.placeAnotherAction(game.s, game.d, ref);
      if (a && a.tool) {
        setUI({ tool: a.tool });
        const lay = getUI().layout;
        if ((lay === 'medium' || lay === 'narrow') && getUI().view === 'above') chooseView('below');
      } else if (a && a.reject) popReject(a.reject);
      if (a) ev.preventDefault();
      return;
    }
    // C108 / C142: chamber hotkeys with a nest chamber selected: L level the cheapest of the type, Shift+L level it,
    // G growth side (chambers without a reservation), R relocate.
    const hk = buildPanel.chamberHotkey(ev.key, ev.shiftKey, sel);
    if (hk) {
      const a = buildPanel.chamberHotkeyAction(game.s, game.d, hk);
      if (a && a.cmd) runAct(a.cmd.type, a.cmd.args, null);
      else if (a && a.tool) setUI({ tool: a.tool });
      else if (a && a.reject) popReject(a.reject);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'r' || ev.key === 'R') return;
    // V cycles Above → Below → Stacked → Side by side (C96). Tab stays the browser's focus key: browsers and
    // keyboard users rely on it, and it never reached the game reliably.
    if ((ev.key === 'v' || ev.key === 'V') && !ev.shiftKey) {
      const st = getUI();
      if (!isInset(game.s)) chooseView(nextView(st.view, st.layout));
      ev.preventDefault();
    }
  };
  if (docu && docu.addEventListener) {
    docu.addEventListener('keydown', onKey);
    offs.push(() => docu.removeEventListener('keydown', onKey));
  }

  // ------------------------------------------------------------------ refresh (4 Hz)
  let refreshing = false;
  let again = false;
  function refresh(force = false) {
    if (!force && now - lastRefresh < REFRESH_MS) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      for (let i = 0; i < 3; i++) {
        again = false;
        doRefresh();
        if (!again) break;
      }
    } finally {
      refreshing = false;
    }
  }

  function doRefresh() {
    lastRefresh = now;
    tickCount++;
    const s = game.s;
    const d = game.d;
    if (!s || !s.meta || !s.run) return;
    const st0 = s.meta.settings || {};
    setNotation(st0.notation);
    root.setAttribute('data-reduced-motion', st0.reducedMotion ? 'true' : 'false');
    // C149 cosmetics the page itself shows: palette (CSS tokens), winged cursor over the canvases, amber nest frame
    for (const [slot, attr] of [['palette', 'data-palette'], ['cursor', 'data-cursor'], ['frame', 'data-frame']]) {
      const v = cosmeticVariant(s, slot);
      if (v) { if (root.getAttribute(attr) !== v) root.setAttribute(attr, v); } else if (root.getAttribute(attr) !== null) root.removeAttribute(attr);
    }

    // tabs: an open tab that is not revealed falls back to the first revealed gameplay tab; while there is none (the
    // opening), the welcome card holds the column instead of an always-on tab such as the Field Guide.
    const vis = visibleTabs(s);
    const introNow = isIntro(vis);
    let st = getUI();
    if (!vis.includes(st.tab) && !introNow) {
      setUI({ tab: vis.find((id) => !isIntro([id])) || vis[0], subTab: null });
      st = getUI();
    }
    welcomeShown = !vis.includes(st.tab);
    root.setAttribute('data-intro', introNow ? 'true' : 'false');
    if (!visitedSeeded) seedVisited();
    if (!welcomeShown) markVisited(st.tab);
    freshTabs.clear();
    for (const id of vis) if (!UTILITY_TABS.includes(id) && !visited.has(id)) freshTabs.add(id);
    for (const id of TAB_IDS) {
      const b = tabBtns[id];
      const on = vis.includes(id);
      if (b.hidden === on) {
        b.hidden = !on;
        if (on && tickCount > 1) b.classList.add('reveal');
      }
      toggleClass(b, 'active', st.tab === id);
      b.setAttribute('aria-selected', st.tab === id ? 'true' : 'false');
      toggleClass(b, 'fresh', freshTabs.has(id) && st.tab !== id);
      toggleClass(b, 'glow', st.glow === 'tab:' + id);
    }
    // closed sheet / drawer: cue new panels and onboarding glows that point inside the panels (DESIGN §25.6 rule 1)
    const closed = (st.layout === 'medium' && !drawerOpen) || (st.layout === 'narrow' && sheet === 'peek');
    const glowInside = typeof st.glow === 'string' && /^(job|build|adapt|research):/.test(st.glow);
    const glowTab = typeof st.glow === 'string' && st.glow.startsWith('tab:');
    const cue = closed && (unseenPanel || freshTabs.size > 0);
    toggleClass(panelsToggle, 'fresh', cue);
    toggleClass(panelsToggle, 'glow', closed && st.layout === 'medium' && (glowInside || glowTab));
    toggleClass(sheetBtn, 'glow', closed && st.layout === 'narrow' && glowInside);
    toggleClass(sheetBtn, 'fresh', cue && st.layout === 'narrow');

    // panels: only the active one is built/updated
    for (const id of Object.keys(panelHosts)) show(panelHosts[id], id === st.tab);
    show(introHost, welcomeShown);
    try {
      intro.update(s, d, { intro: introNow, card: welcomeShown, layout: st.layout });
    } catch (err) { if (!panelErr.has('intro')) { panelErr.add('intro'); console.error('[ui] intro failed', err); } }
    if (st.tab && vis.includes(st.tab)) {
      const inst = ensurePanel(st.tab);
      show(panelHosts[st.tab], true);
      if (pendingFocus && st.tab === 'map' && typeof inst.focusTarget === 'function') {
        inst.focusTarget(pendingFocus);
        pendingFocus = null;
      }
      try {
        inst.update(s, d);
      } catch (err) {
        if (!panelErr.has(st.tab)) {
          panelErr.add(st.tab);
          console.error('[ui] panel update failed:', st.tab, err);
        }
      }
    }
    show(panels, vis.length > 0);

    try { watchFront(s); } catch (err) { if (!panelErr.has('front')) { panelErr.add('front'); console.error('[ui] front watch failed', err); } }
    // HUD and friends
    try { hud.update(s, d); } catch (err) { if (!panelErr.has('hud')) { panelErr.add('hud'); console.error('[ui] hud failed', err); } }
    tooltips.refresh();
    eventCard.update(s);
    modals.update(s, d);
    syncViews();
    banner.hidden = !!game.storageOk;

    // landing chooser while a flight is pending
    const pending = s.meta.pending;
    const lm = modals.find('landing');
    if (pending && pending.kind === 'landing') {
      if (!lm && (landingReady || now >= landingDeadline)) openLandingChooser(mctx);
    } else if (lm) {
      modals.close(lm);
    }
    // ending (also after a reload before it was acknowledged)
    const census = num(d && d.meta && d.meta.census);
    if (!endingShown && !s.meta.flags.endingSeen && census >= num(RESET && RESET.endingCensus, 2e16)) {
      endingShown = true;
      openEnding(mctx);
    }
    if (tickCount % 4 === 0) {
      try { onboarding.update(s, d, now); } catch (err) { if (!panelErr.has('onb')) { panelErr.add('onb'); console.error('[ui] onboarding failed', err); } }
    }
  }

  function showWelcome(summary) {
    if (!summary) return;
    const open = modals.find('welcome');
    if (open && open.summary === summary) return;
    if (open) modals.close(open);
    const handle = openWelcome(mctx, summary);
    if (handle) handle.summary = summary;
  }

  applyLayout();
  refresh(true);

  return {
    canvases,
    bridge,
    /**
     * Per-animation-frame entry (nowMs from requestAnimationFrame). Toasts and pops animate every frame; HUD and the
     * visible panel refresh at 4 Hz.
     * @param {number} nowMs
     */
    frame(nowMs) {
      if (Number.isFinite(nowMs)) now = nowMs;
      toasts.frame(now);
      for (const p of pops.slice()) {
        if (now >= p.until) {
          const i = pops.indexOf(p);
          if (i >= 0) pops.splice(i, 1);
          if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
        }
      }
      refresh(false);
    },
    showWelcome,
    /** main.js hands over the renderers so the shell can drive setInset / setVisible. */
    attachRenderers(r) {
      renderers = r ? { ...r } : null;
      syncViews();
    },
    /** Force a refresh now (tests, after imports). */
    refresh() {
      refresh(true);
    },
    openTab,
    /** Services, exposed for main.js and tests. */
    toasts,
    modals,
    dialogs,
    destroy() {
      closeMenu();
      for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
      for (const id of Object.keys(panelInst)) { try { panelInst[id].destroy(); } catch { /* ignore */ } }
      modals.closeAll();
      tooltips.destroy();
      eventCard.destroy();
      onboarding.destroy();
      intro.destroy();
      hud.destroy();
      toasts.clear();
      clear(tabsEl);
      clear(panelBody);
      clear(viewTabs);
      if (banner.parentNode) banner.parentNode.removeChild(banner);
      for (const p of pops) if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
      if (sheetBtn.parentNode) sheetBtn.parentNode.removeChild(sheetBtn);
      if (drawerClose.parentNode) drawerClose.parentNode.removeChild(drawerClose);
    },
  };
}
