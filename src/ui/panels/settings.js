// Settings panel: notation, autosave interval, reduced motion, sound, harsh nature, retreat slider, colony and queen
// names, cosmetics, save now, export (copy + .txt download on click), import (paste → confirm modal), hard reset
// (type "abandon"), and Photo Mode (STRETCH: hides the UI, composes the canvases plus a stat card into a PNG,
// download on click). Owner: WP9. Contract: ARCHITECTURE §14.5 (Settings row), §9 setSetting / equipCosmetic;
// DESIGN §22, §25.8.

import { h, setText, setProp, show, clear, doc } from '../dom.js';
import { fmt, fmtCount, fmtTime, fmtPct, setNotation } from '../format.js';
import { cosmeticSlot, COSMETIC_SLOTS, humanize } from '../text.js';
import { num, obj } from '../reveal.js';
import { adultsTotal } from '../../core/state.js';
import { makeAct, sliderRow, note } from './common.js';

const NOTATIONS = [['suffix', 'Suffixes (1.23M)'], ['scientific', 'Scientific (1.23e6)'], ['engineering', 'Engineering (1.23e6)']];
const AUTOSAVE = [[15, 'Every 15 s'], [30, 'Every 30 s'], [60, 'Every minute'], [0, 'Off (still saves on hide)']];
const NAME_MAX = 40;
/**
 * Keyboard shortcuts (DESIGN §25.4, ARCHITECTURE §14.2) and the view camera controls (render/nestInput.js,
 * render/surfaceInput.js) for the Settings reference list. View keys act on the view you clicked last.
 */
export const SHORTCUTS = Object.freeze([['1–9', 'Open a tab'], ['Space', 'Hand-forage the selected source'], ['M', 'Mark the selected trail'],
  ['R', 'Rally the selected trail; relocate the selected chamber'],
  ['L / Shift + L', 'Level the selected chamber / the cheapest of its type'], ['G', 'Pick the growth side of the selected chamber'], ['V', 'Cycle views: Above, Below, Stacked, Side by side'], ['Esc', 'Cancel a tool, deselect, close panels'],
  ['Wheel', 'Map: zoom. Nest: scroll (Shift + wheel pans)'], ['Ctrl + wheel / pinch', 'Zoom the nest view'],
  ['+ / −', 'Zoom the clicked view in or out'], ['0 / Home', 'Nest view: frame the queen'],
  ['Crown button', 'Frame the queen (nest view, top-right, beside − and +)'], ['Arrows, PgUp / PgDn', 'Pan or scroll the clicked view'],
  ['Drag empty ground', 'Pan the map']].map(Object.freeze));

/**
 * Compose a Photo Mode PNG: the given canvases stacked, plus a stat card. Returns a data URL or null.
 * @param {Object} s state
 * @param {{ above?: HTMLCanvasElement|null, below?: HTMLCanvasElement|null }} canvases
 * @returns {string|null}
 */
export function composePhoto(s, { above = null, below = null } = {}) {
  const d = doc();
  if (!d) return null;
  const parts = [above, below].filter((c) => c && c.width > 0 && c.height > 0);
  const width = Math.max(640, ...parts.map((c) => c.width));
  const card = 110;
  const height = parts.reduce((a, c) => a + Math.round(c.height * (width / c.width)), 0) + card;
  const out = d.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext && out.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#1d140c';
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const c of parts) {
    const hgt = Math.round(c.height * (width / c.width));
    try { ctx.drawImage(c, 0, y, width, hgt); } catch { /* tainted or detached canvas: skip */ }
    y += hgt;
  }
  ctx.fillStyle = '#2b1d12';
  ctx.fillRect(0, y, width, card);
  ctx.fillStyle = '#f3e3c3';
  ctx.font = 'bold 28px Georgia, serif';
  const name = (s && s.meta && s.meta.settings && s.meta.settings.colonyName) || 'My colony';
  ctx.fillText(name, 24, y + 42);
  ctx.font = '18px system-ui, sans-serif';
  ctx.fillStyle = '#d9c39b';
  let adults = 0;
  try { adults = adultsTotal(s); } catch { adults = 0; }
  const line = fmtCount(adults) + ' ants · ' + fmt(num(s && s.run && s.run.fRun)) + ' food this run · run time ' + fmtTime(num(s && s.run && s.run.time))
    + ' · ' + fmtCount(Object.keys(obj(s && s.meta && s.meta.achievements)).length) + ' achievements';
  ctx.fillText(line, 24, y + 76);
  ctx.fillStyle = '#a08865';
  ctx.font = 'italic 14px Georgia, serif';
  ctx.fillText('Six Legs Deep', width - 130, y + card - 16);
  try {
    return out.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** Trigger a browser download of `href` as `filename` (must run inside a user click). */
export function downloadHref(href, filename) {
  const d = doc();
  if (!d || !href) return false;
  const a = d.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  d.body.appendChild(a);
  try {
    a.click();
  } finally {
    d.body.removeChild(a);
  }
  return true;
}

/** Download a text file (Blob + object URL), falling back to a data: URL. */
export function downloadText(text, filename) {
  try {
    if (typeof Blob === 'function' && globalThis.URL && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const ok = downloadHref(url, filename);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 1000);
      return ok;
    }
  } catch { /* fall back */ }
  return downloadHref('data:text/plain;charset=utf-8,' + encodeURIComponent(text), filename);
}

/** Copy text to the clipboard (async API, else a selected textarea + execCommand). */
export function copyText(text, fallbackEl = null) {
  const nav = globalThis.navigator;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    return nav.clipboard.writeText(text).then(() => true, () => legacyCopy(fallbackEl));
  }
  return Promise.resolve(legacyCopy(fallbackEl));
}

function legacyCopy(el) {
  const d = doc();
  if (!el || !d || typeof d.execCommand !== 'function') return false;
  try {
    el.focus();
    el.select();
    return !!d.execCommand('copy');
  } catch {
    return false;
  }
}

/**
 * Settings panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object, dialogs?: Object, appRoot?: HTMLElement }} ctx
 */
export function createPanel(root, { game, ui, bridge, dialogs = null, appRoot = null }) {
  const act = makeAct(game, bridge);
  const el = h('div', { class: 'panel panel-settings' });
  root.appendChild(el);
  const toast = (t, k = 'info') => { if (bridge && bridge.toast) bridge.toast(t, k); };
  const set = (key, value, ev, node) => act('setSetting', { key, value }, ev, node);

  // --- display & game ---
  const notation = h('select', { class: 'select', attrs: { 'aria-label': 'Number format' } }, NOTATIONS.map(([v, t]) => h('option', { value: v, text: t })));
  notation.addEventListener('change', (ev) => { const r = set('notation', notation.value, ev, notation); if (r.ok) setNotation(notation.value); });
  const autosave = h('select', { class: 'select', attrs: { 'aria-label': 'Autosave' } }, AUTOSAVE.map(([v, t]) => h('option', { value: String(v), text: t })));
  autosave.addEventListener('change', (ev) => set('autosaveSec', Number(autosave.value), ev, autosave));
  const toggles = {};
  const mkToggle = (key, label, tip) => {
    const input = h('input', { type: 'checkbox', class: 'check' });
    input.addEventListener('change', (ev) => set(key, !!input.checked, ev, input));
    toggles[key] = input;
    return h('label', { class: 'toggle-row', dataset: tip ? { tip } : null }, input, h('span', { text: label }));
  };
  const retreat = sliderRow('Auto-retreat at losses', { min: 0, max: 100, step: 5, tip: 'Battles retreat once this share of your army has fallen.' },
    (v) => set('retreatAt', Math.max(0, Math.min(1, v / 100)), null, retreat.input));
  const harshWarn = note('Harsh nature: starving colonies lose 0.5% of adults per second. Purely optional.');

  // --- names ---
  const colonyName = h('input', { type: 'text', class: 'input', maxLength: NAME_MAX, placeholder: 'Name your colony', attrs: { 'aria-label': 'Colony name' } });
  const queenName = h('input', { type: 'text', class: 'input', maxLength: NAME_MAX, placeholder: 'Name your queen', attrs: { 'aria-label': 'Queen name' } });
  colonyName.addEventListener('change', (ev) => set('colonyName', colonyName.value.slice(0, NAME_MAX), ev, colonyName));
  queenName.addEventListener('change', (ev) => set('queenName', queenName.value.slice(0, NAME_MAX), ev, queenName));

  // --- cosmetics ---
  const cosBox = h('div', { class: 'cosmetics' });

  // --- save / export / import ---
  const saveState = h('p', { class: 'note' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Save now',
    on: { click: () => { const r = game.save(Date.now()); toast(r.ok ? 'Saved.' : 'Saving unavailable: use Export.', r.ok ? 'good' : 'danger'); } } });
  const exportArea = h('textarea', { class: 'textarea mono', rows: 3, readOnly: true, spellcheck: false, placeholder: 'Press Export to create a save string.',
    attrs: { 'aria-label': 'Export string' } });
  const exportBtn = h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'Export',
    on: { click: () => { exportArea.value = game.exportString(Date.now()); setText(exportInfo, fmtCount(exportArea.value.length) + ' characters'); } } });
  const copyBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Copy',
    on: { click: () => {
      if (!exportArea.value) exportArea.value = game.exportString(Date.now());
      copyText(exportArea.value, exportArea).then((ok) => toast(ok ? 'Save copied to the clipboard.' : 'Copy failed: select the text and copy it.', ok ? 'good' : 'bad'));
    } } });
  const dlBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Download .txt',
    on: { click: () => {
      if (!exportArea.value) exportArea.value = game.exportString(Date.now());
      const name = 'six-legs-deep-' + (game.s.meta.settings.colonyName || 'colony').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.txt';
      downloadText(exportArea.value, name);
    } } });
  const exportInfo = h('span', { class: 'muted' });
  const importArea = h('textarea', { class: 'textarea mono', rows: 3, spellcheck: false, placeholder: 'Paste a save string starting with SLD1:',
    attrs: { 'aria-label': 'Import string' } });
  const importMsg = h('p', { class: 'note' });
  const importBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Import…',
    on: { click: () => {
      const str = importArea.value.trim();
      if (!str) { setText(importMsg, 'Paste a save string first.'); return; }
      setText(importMsg, '');
      if (dialogs && typeof dialogs.importSave === 'function') {
        dialogs.importSave(str, (res) => {
          setText(importMsg, res.message);
          importMsg.classList.toggle('warn', !res.ok);
          if (res.ok) importArea.value = '';
        });
      }
    } } });

  // --- danger & photo ---
  const resetBtn = h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Abandon colony…',
    on: { click: () => { if (dialogs && typeof dialogs.hardReset === 'function') dialogs.hardReset(); } } });
  const photoBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Photo mode', dataset: { tip: 'Hide the interface and save a picture of your colony.' },
    on: { click: () => enterPhoto() } });

  el.append(
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Display' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Number format' }), notation),
      mkToggle('reducedMotion', 'Reduced motion', 'Fewer particles and animations.'),
      mkToggle('sound', 'Sound', 'Soft chimes for reveals.'),
      mkToggle('showScaleLabel', 'Show "1 ● = K ants" labels', 'How many ants each dot stands for.')),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Gameplay' }), retreat.el,
      mkToggle('harshNature', 'Harsh nature', 'Starvation can kill adults. Optional.'), harshWarn),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Names' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Colony' }), colonyName),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Queen' }), queenName)),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Cosmetics' }), cosBox),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Save' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Autosave' }), autosave), saveState, saveBtn),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Export' }),
      h('p', { class: 'note', text: 'Keep a copy of your colony, or move it to another browser.' }), exportArea,
      h('div', { class: 'btn-row' }, exportBtn, copyBtn, dlBtn, exportInfo)),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Import' }), importArea, h('div', { class: 'btn-row' }, importBtn), importMsg),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Photo' }), photoBtn),
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Keyboard and view controls' }),
      h('dl', { class: 'kv kv-keys' }, SHORTCUTS.map(([k, what]) => [h('dt', null, h('kbd', { class: 'kbd', text: k })), h('dd', { text: what })]))),
    h('section', { class: 'sec sec-danger' }, h('h3', { class: 'sec-title', text: 'Danger zone' }),
      h('p', { class: 'note', text: 'Delete everything and start a brand-new colony.' }), resetBtn));

  function renderCosmetics(s) {
    const owned = Object.keys(obj(s.meta.cosmetics && s.meta.cosmetics.owned)).filter((k) => s.meta.cosmetics.owned[k]);
    const equipped = obj(s.meta.cosmetics && s.meta.cosmetics.equipped);
    const sig = owned.join(',') + '|' + JSON.stringify(equipped);
    if (cosBox.__sig === sig) return;
    cosBox.__sig = sig;
    clear(cosBox);
    if (!owned.length) {
      cosBox.appendChild(note('Earn achievements to unlock palettes, mound skins, flags and more.'));
      return;
    }
    const bySlot = {};
    for (const id of owned) (bySlot[cosmeticSlot(id)] ||= []).push(id);
    for (const slot of Object.keys(bySlot)) {
      const sel = h('select', { class: 'select', attrs: { 'aria-label': COSMETIC_SLOTS[slot] || slot } },
        h('option', { value: '', text: 'Default' }), bySlot[slot].map((id) => h('option', { value: id, text: humanize(id.replace(/^cos(metic)?_/, '')) })));
      sel.value = equipped[slot] || '';
      sel.addEventListener('change', (ev) => act('equipCosmetic', { slot, id: sel.value || null }, ev, sel));
      cosBox.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: COSMETIC_SLOTS[slot] || slot }), sel));
    }
  }

  // --- photo mode ---
  let photoBar = null;
  function enterPhoto() {
    const app = appRoot || (doc() && doc().getElementById('app'));
    if (!app) return;
    app.setAttribute('data-photo', 'true');
    const d = doc();
    const pick = h('select', { class: 'select' }, h('option', { value: 'both', text: 'Both views' }), h('option', { value: 'above', text: 'Above' }),
      h('option', { value: 'below', text: 'Below' }));
    const saveImg = h('button', { type: 'button', class: 'btn btn-primary', text: 'Save PNG',
      on: { click: () => {
        const above = d.getElementById('canvas-above');
        const below = d.getElementById('canvas-below');
        const url = composePhoto(game.s, { above: pick.value === 'below' ? null : above, below: pick.value === 'above' ? null : below });
        if (url) downloadHref(url, 'six-legs-deep-photo.png');
        else toast('Photo unavailable in this browser.', 'bad');
      } } });
    const exit = h('button', { type: 'button', class: 'btn', text: 'Exit photo mode', on: { click: () => exitPhoto() } });
    photoBar = h('div', { class: 'photo-bar' }, pick, saveImg, exit);
    app.appendChild(photoBar);
  }
  function exitPhoto() {
    const app = appRoot || (doc() && doc().getElementById('app'));
    if (app) app.removeAttribute('data-photo');
    if (photoBar && photoBar.parentNode) photoBar.parentNode.removeChild(photoBar);
    photoBar = null;
  }

  return {
    update(s) {
      if (!s || !s.meta || !s.meta.settings) return;
      const st = s.meta.settings;
      setProp(notation, 'value', st.notation);
      setProp(autosave, 'value', String(st.autosaveSec));
      for (const k of Object.keys(toggles)) setProp(toggles[k], 'checked', !!st[k]);
      retreat.set(Math.round(num(st.retreatAt, 0.6) * 100), { text: fmtPct(num(st.retreatAt, 0.6), { signed: false }),
        fmt: (v) => fmtPct(v / 100, { signed: false }) });
      show(harshWarn, !!st.harshNature);
      setProp(colonyName, 'value', st.colonyName || '');
      setProp(queenName, 'value', st.queenName || '');
      renderCosmetics(s);
      const saved = num(s.meta.savedAt);
      const ago = Math.max(0, (Date.now() - saved) / 1000);
      setText(saveState, !game.storageOk ? 'Saving unavailable in this browser: use Export.'
        : saved > 0 ? (ago < 5 ? 'Saved just now.' : 'Last saved ' + fmtTime(ago) + ' ago.') : 'Not saved yet.');
      saveState.classList.toggle('warn', !game.storageOk);
    },
    /** Leave photo mode (Esc). Returns true when it was active. */
    escape() {
      if (!photoBar) return false;
      exitPhoto();
      return true;
    },
    destroy() {
      exitPhoto();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
