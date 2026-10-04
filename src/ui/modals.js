// Modal host and every modal dialog: prestige confirmations (Flight, Hardship, Supercolony + edict, Speciation +
// species), the landing chooser (mini-maps, boons, season), hard reset (type "abandon"), import confirmation, the
// ending, and the canvas choosers (golden pupa, satellite column, war party). Owner: WP9.
// Contract: ARCHITECTURE §14.2 (openChooser kinds), §14.6 (modals only for irreversible actions), DESIGN §13.6, §22.

import { h, setText, toggleClass, setCost } from './dom.js';
import { fmtCount } from './format.js';
import {
  nameOf, reasonText, importErrorText, SITE_TIPS, BOON_TIPS, EDICT_TIPS, SPECIES_TIPS, HARDSHIP_TIPS, SEASON_NAMES, PUPA_CHOICES, TRAIT_TIPS,
} from './text.js';
import { num, arr, obj, fedLevel } from './reveal.js';
import { landingPreview, projectAlates, projectKinship, projectGenes } from '../systems/prestige.js';
import { traitCost } from '../systems/traits.js';
import { TRAIT_ORDER, TRAITS } from '../data/bloodline.js';
import { hexToPixel, countInRadius } from '../core/hex.js';
import { MAP } from '../data/surface.js';
import { SEASON_ORDER } from '../data/seasons.js';
import { EDICTS, LANDING } from '../data/prestige.js';
import { SPECIES_ORDER, SPECIES } from '../data/genome.js';
import { FEDERATION } from '../data/federation.js';
import { GRID } from '../data/balance.js';
import { buildWarForm } from './panels/map.js';

/** The word the player must type to confirm a hard reset (DESIGN §22). */
export const ABANDON_WORD = 'abandon';

/**
 * True when the hard-reset confirmation text is exactly the confirm word (surrounding spaces ignored).
 * @param {string} text
 * @returns {boolean}
 */
export function isAbandonConfirmed(text) {
  return typeof text === 'string' && text.trim() === ABANDON_WORD;
}

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
/** Fallback terrain colours for the built-in mini-map (when render/minimap.js is unavailable). */
const MINI_TERRAIN = ['#6f9a4a', '#d8c27a', '#8a6a3a', '#b9a68a', '#5a4630', '#8e8e8a', '#5b84a8', '#6b4a2a'];

/**
 * Built-in landing mini-map: one dot per hex within `radius`, coloured by terrain code, sources as light rings.
 * Used when render/minimap.drawMiniMap is not available.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} terrain
 * @param {Array<{ hex: number }>} sources
 * @param {number} radius
 */
export function fallbackMiniMap(canvas, terrain, sources, radius) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const hgt = canvas.height;
  const R = Math.max(1, radius | 0);
  const size = Math.min(w, hgt) / (Math.sqrt(3) * (2 * R + 1.2));
  ctx.clearRect(0, 0, w, hgt);
  const n = countInRadius(R);
  for (let i = 0; i < n; i++) {
    const [x, y] = hexToPixel(i, size);
    ctx.fillStyle = MINI_TERRAIN[(terrain && terrain[i]) | 0] || MINI_TERRAIN[0];
    ctx.beginPath();
    ctx.arc(w / 2 + x, hgt / 2 + y, size * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#fff4d6';
  ctx.lineWidth = Math.max(1, size * 0.4);
  for (const src of arr(sources)) {
    if (!src || !(src.hex < n)) continue;
    const [x, y] = hexToPixel(src.hex, size);
    ctx.beginPath();
    ctx.arc(w / 2 + x, hgt / 2 + y, size * 1.2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#2b1a0e';
  ctx.beginPath();
  ctx.arc(w / 2, hgt / 2, size * 1.3, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Modal host on #modal-root. Modals stack; Esc / backdrop close the top one when it is dismissable.
 * spec = { title, body: Node|Node[]|string, actions: [{ label, kind, onClick(handle) → false keeps it open, id }],
 *          dismissable = true, className, onClose(), update(s, d) (called at 4 Hz while open), tag }
 * @param {HTMLElement} root
 */
export function createModalHost(root) {
  /** @type {Array<Object>} */
  const stack = [];
  let seq = 0;

  function focusFirst(node) {
    if (!node || typeof node.querySelector !== 'function') return;
    const f = node.querySelector('[data-autofocus]') || node.querySelector('button.btn-primary') || node.querySelector('button');
    if (f && typeof f.focus === 'function') {
      try { f.focus(); } catch { /* focus is best effort */ }
    }
  }

  function open(spec) {
    const handle = { spec, node: null, closed: false, buttons: {} };
    const titleId = 'modal-title-' + (++seq);
    const body = h('div', { class: 'modal-body' });
    if (typeof spec.body === 'string') body.appendChild(h('p', { text: spec.body }));
    else if (Array.isArray(spec.body)) for (const n of spec.body) { if (n) body.appendChild(n); }
    else if (spec.body) body.appendChild(spec.body);
    const foot = h('div', { class: 'modal-actions' });
    for (const a of arr(spec.actions)) {
      const b = h('button', {
        type: 'button', class: 'btn ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'),
        text: a.label, disabled: !!a.disabled, dataset: { act: a.id || a.label },
        on: { click: () => {
          let keep = false;
          try { keep = a.onClick ? a.onClick(handle) === false : false; } catch (err) { console.error('[modal] action error', err); }
          if (!keep) close(handle);
        } },
      });
      if (a.id) handle.buttons[a.id] = b;
      foot.appendChild(b);
    }
    const dialog = h('div', {
      class: 'modal' + (spec.className ? ' ' + spec.className : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    },
    h('header', { class: 'modal-head' },
      h('h2', { id: titleId, class: 'modal-title', text: spec.title || '' }),
      spec.dismissable === false ? null : h('button', {
        type: 'button', class: 'modal-x', attrs: { 'aria-label': 'Close' }, text: '×', on: { click: () => close(handle) },
      })),
    body, foot);
    const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop && spec.dismissable !== false) close(handle);
    });
    handle.node = backdrop;
    handle.body = body;
    stack.push(handle);
    if (root) {
      root.appendChild(backdrop);
      root.classList.add('open');
    }
    focusFirst(dialog);
    return handle;
  }

  function close(handle = stack[stack.length - 1]) {
    if (!handle || handle.closed) return;
    handle.closed = true;
    const i = stack.indexOf(handle);
    if (i >= 0) stack.splice(i, 1);
    if (handle.node && handle.node.parentNode) handle.node.parentNode.removeChild(handle.node);
    if (root && stack.length === 0) root.classList.remove('open');
    if (typeof handle.spec.onClose === 'function') {
      try { handle.spec.onClose(); } catch (err) { console.error('[modal] onClose error', err); }
    }
  }

  return {
    open,
    close,
    /** Close every modal. */
    closeAll() {
      while (stack.length) close(stack[stack.length - 1]);
    },
    /** True if any modal is open. */
    isOpen() {
      return stack.length > 0;
    },
    /** The top handle or null. */
    top() {
      return stack.length ? stack[stack.length - 1] : null;
    },
    /** The open handle with this tag, or null. */
    find(tag) {
      return stack.find((m) => m.spec.tag === tag) || null;
    },
    /** Esc: close the top modal if dismissable; returns true when something closed. */
    escape() {
      const t = stack[stack.length - 1];
      if (t && t.spec.dismissable !== false) {
        close(t);
        return true;
      }
      return false;
    },
    /** Live refresh of open modals (4 Hz). */
    update(s, d) {
      for (const m of stack.slice()) {
        if (typeof m.spec.update === 'function') {
          try { m.spec.update(s, d, m); } catch (err) { console.error('[modal] update error', err); }
        }
      }
    },
    /**
     * Yes/no confirmation; resolves true on confirm.
     * @param {{ title: string, message: string|Node, confirmLabel?: string, danger?: boolean }} opts
     * @returns {Promise<boolean>}
     */
    confirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
      return new Promise((resolve) => {
        let done = false;
        open({
          title, body: typeof message === 'string' ? h('p', { text: message }) : message,
          actions: [
            { label: cancelLabel, kind: 'ghost', id: 'cancel', onClick: () => { done = true; resolve(false); } },
            { label: confirmLabel, kind: danger ? 'danger' : 'primary', id: 'confirm', onClick: () => { done = true; resolve(true); } },
          ],
          onClose: () => { if (!done) resolve(false); },
        });
      });
    },
  };
}

/** A list of "Resets / Keeps" lines. */
function resetList(resets, keeps) {
  return h('div', { class: 'reset-grid' },
    h('div', { class: 'reset-col' }, h('h4', { text: 'Resets' }), h('ul', null, resets.map((t) => h('li', { text: t })))),
    h('div', { class: 'reset-col keep' }, h('h4', { text: 'Keeps' }), h('ul', null, keeps.map((t) => h('li', { text: t })))));
}

/** Show an action result: toast the reason when refused. Returns ok. */
function report(ctx, res) {
  if (res && res.ok) return true;
  ctx.toast(reasonText(res && res.reason) || 'That did not work.', 'bad', { priority: 'high' });
  return false;
}

export const FLIGHT_RESETS = ['Run resources, ants and brood', 'Chambers, tunnels and the dig queue', 'Adaptations and non-Innate research',
  'Territory, the map and rivals'];
export const FLIGHT_KEEPS = ['Alates and lifetime counters', 'Bloodline traits and Innate research', 'Achievements, Field Guide and stats',
  'Blueprints, Diapause, the season clock and settings'];

/**
 * Nuptial Flight confirmation (prestige modal).
 * @param {Object} ctx { game, modals, toast }
 */
export function openFlightConfirm(ctx) {
  const { game, modals } = ctx;
  const projEl = h('strong', { class: 'big-num' });
  const body = [
    h('p', null, 'Your alates take wing and found a new colony. You will earn ', projEl, ' alates.'),
    resetList(FLIGHT_RESETS, FLIGHT_KEEPS),
  ];
  const update = (s, d) => {
    const p = num(d && d.meta && d.meta.proj ? d.meta.proj.alates : NaN, NaN);
    setText(projEl, fmtCount(Number.isFinite(p) ? p : safeCall(() => projectAlates(s, d), 0)));
  };
  update(game.s, game.d);
  return modals.open({
    title: 'Take the Nuptial Flight?', body, tag: 'flight', update,
    actions: [
      { label: 'Not yet', kind: 'ghost' },
      { label: 'Fly!', kind: 'primary', id: 'confirm', onClick: () => report(ctx, game.actions.do('fly', {})) },
    ],
  });
}

/**
 * Start-a-Hardship confirmation.
 * @param {Object} ctx
 * @param {string} id hardship id
 */
export function openHardshipConfirm(ctx, id) {
  const { game, modals } = ctx;
  const tip = HARDSHIP_TIPS[id] || { rule: '', reward: '' };
  return modals.open({
    title: 'Begin Hardship: ' + nameOf('hardship', id) + '?', tag: 'hardship',
    body: [
      h('p', { text: 'This works like a Nuptial Flight into a constrained run. You still earn alates now.' }),
      h('p', null, h('strong', { text: 'Constraint: ' }), tip.rule),
      h('p', null, h('strong', { text: 'Reward per tier: ' }), tip.reward),
      resetList(FLIGHT_RESETS, FLIGHT_KEEPS),
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Begin Hardship', kind: 'danger', id: 'confirm', onClick: () => report(ctx, game.actions.do('startHardship', { id })) },
    ],
  });
}

/** Ordered edict ids. */
function edictIds() {
  const ids = Object.keys(obj(EDICTS));
  return ids.length ? ids : ['edict_of_plenty', 'edict_of_war', 'edict_of_depth', 'edict_of_long_summer'];
}

/**
 * Supercolony confirmation with the Royal Edict pick.
 * @param {Object} ctx
 */
export function openSupercolonyDialog(ctx) {
  const { game, modals } = ctx;
  let edict = null;
  const kinEl = h('strong', { class: 'big-num' });
  const list = h('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Royal Edict' });
  let handle = null;
  const pick = (id) => {
    edict = id;
    for (const b of Array.from(list.children)) toggleClass(b, 'selected', b.dataset.id === id);
    if (handle && handle.buttons.confirm) handle.buttons.confirm.disabled = !edict;
  };
  for (const id of edictIds()) {
    list.appendChild(h('button', {
      type: 'button', class: 'choice', dataset: { id }, role: 'radio',
      on: { click: () => pick(id) },
    }, h('span', { class: 'choice-name', text: nameOf('edict', id) }), h('span', { class: 'choice-tip', text: EDICT_TIPS[id] || '' })));
  }
  const update = (s, d) => {
    const p = num(d && d.meta && d.meta.proj ? d.meta.proj.kinship : NaN, NaN);
    setText(kinEl, fmtCount(Number.isFinite(p) ? p : safeCall(() => projectKinship(s, d), 0)));
  };
  update(game.s, game.d);
  handle = modals.open({
    title: 'Form a Supercolony?', tag: 'supercolony', update,
    body: [
      h('p', null, 'Your daughter colonies fuse. You will earn ', kinEl, ' kinship.'),
      resetList(['Everything a Flight resets', 'Unspent alates and the Lineage bonus', 'Bloodline traits (except Heirlooms)', 'Hardship tiers (rewards kept at 50%)'],
        ['Kinship and Federation nodes', 'Innate research and achievements', 'Blueprints, Diapause, Strata and settings']),
      h('h4', { text: 'Choose a Royal Edict for this cycle' }), list,
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Merge', kind: 'danger', id: 'confirm', disabled: true, onClick: () => (edict ? report(ctx, game.actions.do('supercolony', { edict })) : false) },
    ],
  });
  return handle;
}

/**
 * Speciation confirmation with the species pick.
 * @param {Object} ctx
 */
export function openSpeciationDialog(ctx) {
  const { game, modals } = ctx;
  const s = game.s;
  let species = null;
  const genesEl = h('strong', { class: 'big-num' });
  const list = h('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Species' });
  let handle = null;
  const ids = SPECIES_ORDER.length ? SPECIES_ORDER : Object.keys(SPECIES).length ? Object.keys(SPECIES) : ['garden_ant', 'leafcutter', 'honeypot', 'fire_ant'];
  const unlocked = obj(s.meta && s.meta.speciesUnlocked);
  for (const id of ids) {
    const ok = !!unlocked[id];
    list.appendChild(h('button', {
      type: 'button', class: 'choice' + (ok ? '' : ' locked'), dataset: { id }, role: 'radio', disabled: !ok,
      on: { click: () => {
        species = id;
        for (const b of Array.from(list.children)) toggleClass(b, 'selected', b.dataset.id === id);
        if (handle && handle.buttons.confirm) handle.buttons.confirm.disabled = false;
      } },
    }, h('span', { class: 'choice-name', text: nameOf('species', id) + (ok ? '' : ' (locked)') }),
    h('span', { class: 'choice-tip', text: SPECIES_TIPS[id] || '' })));
  }
  const update = (st, d) => {
    const p = num(d && d.meta && d.meta.proj ? d.meta.proj.genes : NaN, NaN);
    setText(genesEl, fmtCount(Number.isFinite(p) ? p : safeCall(() => projectGenes(st, d), 0)));
  };
  update(game.s, game.d);
  handle = modals.open({
    title: 'Speciate?', tag: 'speciation', update,
    body: [
      h('p', null, 'Your lineage becomes a new species. You will earn ', genesEl, ' genes.'),
      resetList(['Everything, including kinship and Federation', 'Hardship rewards', 'Innate research (unless Genetic Memory)'],
        ['Genes, Genome and species unlocks', 'Signature genes and achievements', 'Cosmetics, Strata, Diapause and settings']),
      h('h4', { text: 'Choose your species' }), list,
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Speciate', kind: 'danger', id: 'confirm', disabled: true, onClick: () => (species ? report(ctx, game.actions.do('speciate', { species })) : false) },
    ],
  });
  return handle;
}

/** Safe call with a fallback value. */
function safeCall(fn, fallback) {
  try {
    const v = fn();
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Landing chooser for s.meta.pending (kind 'landing'): 3 sites with mini-maps and tags, 3 boons, optional season.
 * Not dismissable: the run stays frozen until a site is chosen.
 * @param {Object} ctx { game, modals, toast, ext: { drawMiniMap } }
 */
export function openLandingChooser(ctx) {
  const { game, modals } = ctx;
  const p = obj(game.s.meta && game.s.meta.pending);
  const options = arr(p.options);
  const boons = arr(p.boons);
  let index = options.length ? 0 : -1;
  let boon = boons.length ? boons[0] : null;
  let season = p.chooseSeason && p.hardship !== 'eternal_winter' ? 'spring' : null;
  let handle = null;

  const re = FEDERATION.regional_expansion;
  const radius = fedLevel(game.s, 'regional_expansion') > 0 ? num(re && re.fx ? re.fx.radius : NaN, 16) : num(MAP.radiusBase, 8);
  const siteRow = h('div', { class: 'landing-sites' });
  options.forEach((opt, i) => {
    const canvas = h('canvas', { class: 'minimap', width: 180, height: 180, attrs: { 'aria-hidden': 'true' } });
    const tags = arr(opt && opt.tags);
    const card = h('button', {
      type: 'button', class: 'site-card' + (i === index ? ' selected' : ''), dataset: { i: String(i) }, role: 'radio',
      on: { click: () => { index = i; for (const c of Array.from(siteRow.children)) toggleClass(c, 'selected', c.dataset.i === String(i)); } },
    }, canvas, h('span', { class: 'site-name', text: 'Site ' + (i + 1) }),
    h('ul', { class: 'site-tags' }, tags.length ? tags.map((t) => h('li', null, h('strong', { text: nameOf('site', t) }), ' ', SITE_TIPS[t] || ''))
      : h('li', { text: 'An ordinary backyard.' })));
    siteRow.appendChild(card);
    try {
      const prev = landingPreview(num(opt && opt.seed, 1), tags);
      const draw = ctx.ext && typeof ctx.ext.drawMiniMap === 'function' ? ctx.ext.drawMiniMap : fallbackMiniMap;
      draw(canvas, prev && prev.terrain, prev && prev.sources, radius);
    } catch (err) {
      try { fallbackMiniMap(canvas, null, [], radius); } catch { /* preview is decorative */ }
    }
  });

  const boonRow = h('div', { class: 'choice-list boons', role: 'radiogroup', 'aria-label': 'Founding Boon' });
  for (const b of boons) {
    boonRow.appendChild(h('button', {
      type: 'button', class: 'choice' + (b === boon ? ' selected' : ''), dataset: { id: b }, role: 'radio',
      on: { click: () => { boon = b; for (const c of Array.from(boonRow.children)) toggleClass(c, 'selected', c.dataset.id === b); } },
    }, h('span', { class: 'choice-name', text: nameOf('boon', b) }), h('span', { class: 'choice-tip', text: BOON_TIPS[b] || '' })));
  }

  // Starting season (Seasonal Wisdom). Built on demand: buying the trait in the shop below flips
  // pending.chooseSeason while the chooser is open, and the row appears then (F11).
  let seasonRow = null;
  const seasonHost = h('div', { class: 'landing-season' });
  const buildSeasonRow = () => {
    if (seasonRow || p.hardship === 'eternal_winter') return;   // C147: always winter, nothing to choose
    season = season || 'spring';
    seasonRow = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Starting season' });
    const order = SEASON_ORDER.length ? SEASON_ORDER : SEASONS;
    for (const id of order) {
      seasonRow.appendChild(h('button', {
        type: 'button', class: 'seg-btn' + (id === season ? ' selected' : ''), dataset: { id }, text: SEASON_NAMES[id] || id,
        on: { click: () => { season = id; for (const c of Array.from(seasonRow.children)) toggleClass(c, 'selected', c.dataset.id === id); } },
      }));
    }
    seasonHost.append(h('h4', { text: 'Starting season' }), seasonRow);
  };
  if (p.chooseSeason) buildSeasonRow();

  // Bloodline shop (F11): the alates just earned can be spent before landing, so run-start traits (Founding Stores,
  // Nanitic Vigor, Remembered Paths, Keen Antennae, Automaton Instincts, Seasonal Wisdom…) apply to THIS landing.
  // buyTrait is allowed while the chooser is open (core/commands PAUSE_OK); startRun reads the traits at landing.
  const shop = landingShop(ctx, () => {
    if (obj(game.s.meta && game.s.meta.pending).chooseSeason) buildSeasonRow();
  });

  const head = h('p', { class: 'landing-head' }, fmtCount(num(p.alates)) + ' alates took wing. Where will the new queen land?');
  if (p.hardship) head.appendChild(h('span', { class: 'badge badge-warn', text: 'Hardship: ' + nameOf('hardship', p.hardship) }));

  handle = modals.open({
    title: 'Choose a landing site', className: 'modal-wide', tag: 'landing', dismissable: false,
    body: [head, siteRow, h('h4', { text: 'Founding Boon (pick 1 of ' + boons.length + ')' }), boonRow, seasonHost, shop.el],
    update: (s) => {
      shop.update(s);
      if (obj(s.meta && s.meta.pending).chooseSeason) buildSeasonRow();
    },
    actions: [{
      label: 'Found the colony', kind: 'primary', id: 'confirm',
      onClick: () => {
        const args = { index, boon };
        if (season) args.season = season;
        return report(ctx, game.actions.do('chooseLanding', args)) ? true : false;
      },
    }],
  });
  return handle;
}

/**
 * Bloodline shop inside the landing chooser (F11): balance, then one row per trait not yet at its cap (name, level,
 * cost, Buy). Buying dispatches buyTrait; a refusal is toasted. Returns { el, update(s) }.
 * @param {Object} ctx { game, toast }
 * @param {(id: string) => void} [onBought] called after every successful purchase
 */
export function landingShop(ctx, onBought = () => {}) {
  const { game } = ctx;
  const bal = h('strong', { class: 'big-num' });
  const list = h('div', { class: 'list buy-list landing-shop-list' });
  const rows = {};
  const ids = TRAIT_ORDER.length ? TRAIT_ORDER : Object.keys(TRAITS);
  const refresh = (s) => {
    if (!s || !s.cycle) return;
    setText(bal, fmtCount(num(s.cycle.alates)));
    for (const id of ids) {
      const L = num(obj(s.cycle.traits)[id]);
      let cost = null;
      try { cost = traitCost(s, id); } catch { cost = null; }
      let r = rows[id];
      if (!cost) {
        if (r) r.row.hidden = true;
        continue;
      }
      if (!r) {
        const lvl = h('span', { class: 'lvl' });
        const costEl = h('span', { class: 'cost' });
        const btn = h('button', { type: 'button', class: 'btn btn-small btn-buy', text: 'Buy', dataset: { trait: id },
          on: { click: () => {
            if (!report(ctx, game.actions.do('buyTrait', { id }))) return;
            refresh(game.s);
            onBought(id);
          } } });
        const row = h('div', { class: 'buy-row', dataset: { id, tip: TRAIT_TIPS[id] || '' } },
          h('div', { class: 'buy-main' }, h('span', { class: 'buy-name', text: nameOf('trait', id) }), lvl,
            h('span', { class: 'buy-desc', text: TRAIT_TIPS[id] || '' })),
          h('div', { class: 'buy-side' }, costEl, btn));
        r = rows[id] = { row, lvl, costEl, btn };
        list.appendChild(row);
      }
      r.row.hidden = false;
      const max = num(TRAITS[id] && TRAITS[id].max);
      setText(r.lvl, max > 0 ? 'L' + fmtCount(L) + ' / ' + fmtCount(max) : 'L' + fmtCount(L));
      toggleClass(r.row, 'cant', !setCost(r.costEl, cost, s));
    }
  };
  const el = h('section', { class: 'sec landing-shop' }, h('h4', { text: 'Spend alates before landing' }),
    h('p', { class: 'note' }, 'You have ', bal, ' alates. Bloodline traits bought now apply to this landing.'), list);
  refresh(game.s);
  return { el, update: refresh };
}

/** Number of landing options the data promises (for display). */
export const LANDING_OPTIONS = num(LANDING && LANDING.options, 3);

/**
 * Hard reset ("Abandon colony"): requires typing the confirm word.
 * @param {Object} ctx
 * @param {(nowMs: number) => void} [onDone]
 */
export function openHardReset(ctx, onDone = null) {
  const { game, modals } = ctx;
  let handle = null;
  const input = h('input', {
    type: 'text', class: 'input', placeholder: ABANDON_WORD, autocomplete: 'off', spellcheck: false,
    dataset: { autofocus: '1' }, attrs: { 'aria-label': 'Type ' + ABANDON_WORD + ' to confirm' },
  });
  input.addEventListener('input', () => {
    if (handle && handle.buttons.confirm) handle.buttons.confirm.disabled = !isAbandonConfirmed(input.value);
  });
  handle = modals.open({
    title: 'Abandon your colony?', tag: 'hardReset',
    body: [
      h('p', { text: 'This deletes your save and every backup. Nothing is kept: no alates, kinship, genes or achievements.' }),
      h('p', null, 'Type ', h('code', { text: ABANDON_WORD }), ' to confirm.'), input,
    ],
    actions: [
      { label: 'Keep my colony', kind: 'ghost' },
      { label: 'Abandon colony', kind: 'danger', id: 'confirm', disabled: true,
        onClick: () => {
          if (!isAbandonConfirmed(input.value)) return false;
          game.hardReset(Date.now());
          ctx.toast('A new queen begins again.', 'info', { priority: 'high' });
          if (onDone) onDone();
          return true;
        } },
    ],
  });
  handle.input = input;
  return handle;
}

/**
 * Import confirmation: replaces the current colony with the pasted save. onResult({ ok, error, message }).
 * @param {Object} ctx
 * @param {string} str
 * @param {(res: { ok: boolean, error: string|null, message: string }) => void} [onResult]
 */
export function openImportConfirm(ctx, str, onResult = null) {
  const { game, modals } = ctx;
  return modals.open({
    title: 'Import this save?', tag: 'import',
    body: [h('p', { text: 'Your current colony will be replaced. Export it first if you want to keep it.' }),
      h('p', { class: 'muted', text: 'No offline progress is credited for imported saves.' })],
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Replace my colony', kind: 'danger', id: 'confirm',
        onClick: () => {
          const res = game.importString(String(str || ''), Date.now());
          const message = res.ok ? 'Colony imported.' : importErrorText(res.error);
          ctx.toast(message, res.ok ? 'good' : 'bad', { priority: 'high' });
          if (onResult) onResult({ ok: res.ok, error: res.error || null, message });
          return true;
        } },
    ],
  });
}

/**
 * Ending ("Twenty Quadrillion"); acknowledging sets meta.flags.endingSeen through uiFlag.
 * @param {Object} ctx
 */
export function openEnding(ctx) {
  const { game, modals } = ctx;
  const s = game.s;
  const name = (s.meta && s.meta.settings && s.meta.settings.colonyName) || 'Your colony';
  return modals.open({
    title: 'Twenty Quadrillion', className: 'modal-ending', tag: 'ending', dismissable: false,
    body: [
      h('p', { class: 'ending-lede', text: name + ' now numbers as many ants as live on the whole Earth.' }),
      h('p', { text: 'From one sealed queen beneath a garden path to a living layer across the world. The colony goes on.' }),
      h('div', { class: 'credits' },
        h('h4', { text: 'Six Legs Deep' }),
        h('p', { text: 'Design, code and art: the Six Legs Deep team.' }),
        h('p', { text: 'Inspired by the real lives of ants and the people who study them.' })),
    ],
    actions: [{ label: 'Keep playing', kind: 'primary', id: 'confirm', onClick: () => { game.actions.do('uiFlag', { key: 'ending', value: true }); return true; } }],
  });
}

/**
 * Golden pupa chooser → actions.clickPupa({ choice }).
 * @param {Object} ctx
 */
export function openPupaChooser(ctx) {
  const { game, modals } = ctx;
  const pick = (choice) => report(ctx, game.actions.do('clickPupa', { choice }));
  return modals.open({
    title: 'A golden pupa!', tag: 'pupa',
    body: [h('div', { class: 'choice-list' }, ['frenzy', 'windfall'].map((c) => h('button', {
      type: 'button', class: 'choice', dataset: { id: c },
      on: { click: () => { pick(c); modals.close(); } },
    }, h('span', { class: 'choice-name', text: PUPA_CHOICES[c].label }), h('span', { class: 'choice-tip', text: PUPA_CHOICES[c].tip }))))],
    actions: [{ label: 'Leave it', kind: 'ghost' }],
  });
}

/**
 * Satellite shaft column chooser → actions.placeSatellite({ hex, col }).
 * @param {Object} ctx
 * @param {{ hex: number }} data
 */
export function openSatelliteColumn(ctx, data) {
  const { game, modals } = ctx;
  const hex = num(data && data.hex, -1);
  // Same rule as the placeSatellite validator: every shaft and entrance column at least fx.colGap away, 0 ≤ col < GRID.cols.
  const sn = FEDERATION.satellite_nest;
  const gap = num(sn && sn.fx ? sn.fx.colGap : NaN, 4);
  const cols = num(GRID && GRID.cols, 40);
  const run = game.s.run || {};
  const taken = arr(run.nest && run.nest.shafts).map((x) => num(x && x.col, -99))
    .concat(arr(run.surface && run.surface.entrances).map((e) => num(e && e.col, -99)))
    .filter((c) => c >= 0);
  const free = (c) => taken.every((sc) => Math.abs(sc - c) >= gap);
  let col = 0;
  for (let c = 0; c < cols; c++) {
    if (free(c)) { col = c; break; }
  }
  const out = h('output', { class: 'big-num', text: String(col) });
  const note = h('p', { class: 'muted' });
  const range = h('input', { type: 'range', min: 0, max: cols - 1, step: 1, value: col, class: 'range', attrs: { 'aria-label': 'Shaft column' } });
  const refresh = () => {
    setText(out, String(col));
    const near = !free(col);
    setText(note, near ? 'Too close to another shaft (needs ' + gap + ' columns).' : 'The shaft is dug from the surface as a queued job.');
    toggleClass(note, 'warn', near);
  };
  range.addEventListener('input', () => { col = Number(range.value) | 0; refresh(); });
  refresh();
  return modals.open({
    title: 'Place a satellite nest', tag: 'satellite',
    body: [h('p', { text: 'Choose the column for its shaft in the nest view.' }), h('div', { class: 'range-row' }, range, out), note],
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Place satellite', kind: 'primary', id: 'confirm', onClick: () => report(ctx, game.actions.do('placeSatellite', { hex, col })) },
    ],
  });
}

/**
 * War-party chooser (drag from an entrance onto a rival, prey or termite mound) → actions.launchParty.
 * @param {Object} ctx
 * @param {{ kind: string, target: { type: string, uid: number } }} data
 */
export function openWarChooser(ctx, data) {
  const { modals } = ctx;
  const form = buildWarForm(ctx, { kind: data && data.kind, target: data && data.target, onLaunched: () => modals.close(handle) });
  const handle = modals.open({
    title: 'Send a war party', tag: 'war', className: 'modal-war', body: form.el,
    update: (s, d) => form.update(s, d),
    onClose: () => form.destroy(),
    actions: [{ label: 'Close', kind: 'ghost' }],
  });
  form.update(ctx.game.s, ctx.game.d);
  return handle;
}

