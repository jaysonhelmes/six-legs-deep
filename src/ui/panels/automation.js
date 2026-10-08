// Automation boxes (C166): each automation switch sits where it acts and appears only when owned — Auto-Flight in the
// Prestige Flight view, Auto-Supercolony in the Supercolony view, the Adaptation autobuyer in the Adaptations tab, and the
// chamber-level / Mound autobuyers (+ the shared autobuyer priority and the C170 blueprint hint) in the Build tab.
// Owner: WP9 (prestige engineer). Contract: ARCHITECTURE §14.5, §8.6 (setAutomation), DESIGN §14.5, §15.5.

import { h, setText, setProp, show, clear } from '../dom.js';
import { fmt, fmtTime } from '../format.js';
import { autoFlightPeakText, AUTO_LANDING_TEXT, AUTO_SUPER_TEXT, blueprintSaveHint } from '../text.js';
import { fedLevel, genomeLevel, num, arr, obj } from '../reveal.js';
import { AUTO_FLIGHT } from '../../data/prestige.js';
import { makeAct } from './common.js';

/** Autobuyer categories (systems/automation.js CATEGORIES). */
export const AUTOBUY_CATS = Object.freeze(['adaptations', 'chambers', 'mound']);
/** Labels of the autobuyer categories. */
export const AUTOBUY_NAMES = Object.freeze({ adaptations: 'Adaptations', chambers: 'Chamber levels', mound: 'Mound levels' });

/**
 * Is one autobuyer category running (master switch on and the category on)?
 * @param {Object} s
 * @param {string} cat
 * @returns {boolean}
 */
export function autobuyOn(s, cat) {
  const a = obj(s && s.meta && s.meta.automation && s.meta.automation.autobuy);
  return a.on === true && a[cat] === true;
}

/**
 * The setAutomation patch for one category switch now that each category has its own switch in its own tab: switching
 * one ON while the master is off turns the master on with only that category; switching the last running one OFF also
 * turns the master off.
 * @param {Object} s
 * @param {string} cat
 * @param {boolean} on
 * @returns {{ autobuy: Object }}
 */
export function autobuyPatch(s, cat, on) {
  const a = obj(s && s.meta && s.meta.automation && s.meta.automation.autobuy);
  if (on) {
    if (a.on === true) return { autobuy: { [cat]: true } };
    const p = { on: true };
    for (const c of AUTOBUY_CATS) p[c] = c === cat;
    return { autobuy: p };
  }
  const others = AUTOBUY_CATS.some((c) => c !== cat && a[c] === true);
  return { autobuy: a.on === true && others ? { [cat]: false } : { [cat]: false, on: false } };
}

function toggle(label, onChange, tip = '') {
  const input = h('input', { type: 'checkbox', class: 'check' });
  input.addEventListener('change', (ev) => onChange(!!input.checked, ev, input));
  return { el: h('label', { class: 'toggle-row', dataset: tip ? { tip } : null }, input, h('span', { text: label })), input };
}
function selectRow(label, options, onChange) {
  const input = h('select', { class: 'select' }, options.map(([v, t]) => h('option', { value: v, text: t })));
  input.addEventListener('change', () => onChange(input.value));
  return { el: h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input), input };
}
function numberRow(label, min, max, onChange) {
  const input = h('input', { type: 'number', class: 'input input-small', min, max, step: 1 });
  input.addEventListener('change', () => onChange(Math.max(min, Math.min(max, Math.floor(Number(input.value) || 0)))));
  return { el: h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input), input };
}
/** Write a value into an input unless the player is typing in it. */
function syncInput(input, value) {
  if (input.ownerDocument && input.ownerDocument.activeElement === input) return;
  setProp(input, 'value', value);
}

/** One category switch (Adaptations tab / Build tab). */
function catToggle(game, act, cat, label, tip) {
  return toggle(label, (v, ev, input) => act('setAutomation', { patch: autobuyPatch(game.s, cat, v) }, ev, input), tip);
}

/**
 * Adaptations tab: the Adaptation autobuyer switch (Federation Autobuyers).
 * @param {{ game: Object, bridge: Object }} ctx
 * @returns {{ el: HTMLElement, update: (s: Object) => void }}
 */
export function adaptAutoBox({ game, bridge }) {
  const act = makeAct(game, bridge);
  const t = catToggle(game, act, 'adaptations', 'Adaptation autobuyer', 'Buys the cheapest affordable Adaptation level once a second.');
  const el = h('section', { class: 'sec auto-box auto-adapt' }, h('h3', { class: 'sec-title', text: 'Automation' }), t.el,
    h('p', { class: 'note', text: 'Buys the cheapest affordable Adaptation level once a second. The order against chamber and Mound autobuyers is set in the Build tab.' }));
  return {
    el,
    update(s) {
      const own = fedLevel(s, 'autobuyers') > 0;
      show(el, own);
      if (own) setProp(t.input, 'checked', autobuyOn(s, 'adaptations'));
    },
  };
}

/**
 * Build tab: chamber-level and Mound autobuyers, the shared priority, and the C170 blueprint hint.
 * @param {{ game: Object, bridge: Object }} ctx
 * @returns {{ el: HTMLElement, update: (s: Object) => void }}
 */
export function buildAutoBox({ game, bridge }) {
  const act = makeAct(game, bridge);
  const ch = catToggle(game, act, 'chambers', 'Auto-level chambers', 'Levels the cheapest chamber you can afford, once a second.');
  const md = catToggle(game, act, 'mound', 'Auto-level the Mound', 'Buys Mound levels when affordable, once a second.');
  const prioList = h('ol', { class: 'prio-list' });
  const prioBox = h('div', { class: 'auto-prio' }, h('p', { class: 'note', text: 'Autobuyer order (tried first to last, one purchase per second):' }), prioList);
  const bpHint = h('p', { class: 'note bp-hint' });
  const autoPart = h('div', null, ch.el, md.el, prioBox);
  const el = h('section', { class: 'sec auto-box auto-build' }, h('h3', { class: 'sec-title', text: 'Automation' }), autoPart, bpHint);
  const renderPrio = (s) => {
    // C220: the Mound grows on its own, so its autobuyer is hidden; it stays last in the saved order
    const full = arr(obj(s.meta && s.meta.automation && s.meta.automation.autobuy).priority);
    const prio = full.filter((c) => c !== 'mound');
    const tail = full.filter((c) => c === 'mound');
    const sig = prio.join(',');
    if (prioList.__sig === sig) return;
    prioList.__sig = sig;
    clear(prioList);
    prio.forEach((p, i) => {
      const move = (j) => { const n = prio.slice(); [n[i], n[j]] = [n[j], n[i]]; act('setAutomation', { patch: { autobuy: { priority: n.concat(tail) } } }); };
      prioList.appendChild(h('li', null, h('span', { text: AUTOBUY_NAMES[p] || p }),
        h('button', { type: 'button', class: 'btn btn-icon', text: '↑', disabled: i === 0, attrs: { 'aria-label': 'Earlier' }, on: { click: () => move(i - 1) } }),
        h('button', { type: 'button', class: 'btn btn-icon', text: '↓', disabled: i === prio.length - 1, attrs: { 'aria-label': 'Later' }, on: { click: () => move(i + 1) } })));
    });
  };
  return {
    el,
    update(s) {
      const own = fedLevel(s, 'autobuyers') > 0;
      // the blueprint-saving hint lives in the Build tab's Blueprints section (blueprintLockHint), not here
      show(el, own);
      show(autoPart, own);
      show(bpHint, false);
      if (!own) return;
      setProp(ch.input, 'checked', autobuyOn(s, 'chambers'));
      setProp(md.input, 'checked', autobuyOn(s, 'mound'));
      show(md.el, false);   // C220
      renderPrio(s);
    },
  };
}

/** C166: Auto-Flight trigger description by mode. */
export function autoFlightModeText(mode) {
  if (mode === 'alates') return 'Flies as soon as the projected alates reach the number below.';
  if (mode === 'minutes') return 'Flies once the run has lasted the minutes below.';
  return autoFlightPeakText();
}

/**
 * Prestige → Flight: the Auto-Flight settings (Federation Auto-Flight).
 * @param {{ game: Object, bridge: Object }} ctx
 * @returns {{ el: HTMLElement, update: (s: Object, d: Object) => void }}
 */
export function flightAutoBox({ game, bridge }) {
  const act = makeAct(game, bridge);
  const patch = (p) => act('setAutomation', { patch: { autoFlight: p } });
  const on = toggle('Auto-Flight on', (v) => patch({ on: v }));
  const mode = selectRow('Trigger', [['peak', 'Alates/min past its best'], ['alates', 'Alate count'], ['minutes', 'Run time']], (v) => patch({ mode: v }));
  const alates = numberRow('Alates', 0, 1e12, (v) => patch({ alates: v }));
  const minutes = numberRow('Minutes', 1, 1440, (v) => patch({ minutes: v }));
  const how = h('p', { class: 'note' });
  const status = h('p', { class: 'note auto-status' });
  const el = h('section', { class: 'sec auto-box auto-flight' }, h('h3', { class: 'sec-title', text: 'Auto-Flight' }), on.el, mode.el, alates.el, minutes.el,
    how, status, h('p', { class: 'note', text: AUTO_LANDING_TEXT }));
  return {
    el,
    update(s) {
      const own = fedLevel(s, 'auto_flight') > 0;
      show(el, own);
      if (!own) return;
      const f = obj(s.meta.automation && s.meta.automation.autoFlight);
      const m = f.mode || 'peak';
      setProp(on.input, 'checked', !!f.on);
      syncInput(mode.input, m);
      syncInput(alates.input, String(num(f.alates)));
      syncInput(minutes.input, String(num(f.minutes, 30)));
      show(alates.el, m === 'alates');
      show(minutes.el, m === 'minutes');
      setText(how, autoFlightModeText(m));
      const pr = obj(s.run && s.run.prestige);
      const t = num(s.run && s.run.time);
      let st = '';
      if (m === 'peak') {
        if (t < AUTO_FLIGHT.minSec) st = 'Waiting: the run is ' + fmtTime(t) + ' old (needs ' + Math.round(AUTO_FLIGHT.minSec / 60) + ' min).';
        else if (num(pr.belowAt, -1) >= 0 && Number.isFinite(pr.belowAt)) st = 'The rate has been below its best for ' + fmtTime(Math.max(0, t - pr.belowAt)) + '.';
        else st = 'The rate is still near its best (' + fmt(num(pr.calmPeak)) + ' alates/min without weather).';
      }
      show(status, !!st && !!f.on);
      setText(status, st);
    },
  };
}

/**
 * Prestige → Supercolony: the Auto-Supercolony settings (Genome Deep-Time Automation).
 * @param {{ game: Object, bridge: Object }} ctx
 * @returns {{ el: HTMLElement, update: (s: Object) => void }}
 */
export function superAutoBox({ game, bridge }) {
  const act = makeAct(game, bridge);
  const patch = (p) => act('setAutomation', { patch: { autoSuper: p } });
  const on = toggle('Auto-Supercolony on', (v) => patch({ on: v }));
  const mode = selectRow('Trigger', [['kinship', 'Kinship gain'], ['hours', 'Cycle time']], (v) => patch({ mode: v }));
  const kinship = numberRow('Kinship', 0, 1e12, (v) => patch({ kinship: v }));
  const hours = numberRow('Hours', 1, 1000, (v) => patch({ hours: v }));
  const el = h('section', { class: 'sec auto-box auto-super' }, h('h3', { class: 'sec-title', text: 'Auto-Supercolony' }), on.el, mode.el, kinship.el, hours.el,
    h('p', { class: 'note', text: AUTO_SUPER_TEXT }));
  return {
    el,
    update(s) {
      const own = genomeLevel(s, 'deep_time_automation') > 0;
      show(el, own);
      if (!own) return;
      const a = obj(s.meta.automation && s.meta.automation.autoSuper);
      setProp(on.input, 'checked', !!a.on);
      syncInput(mode.input, a.mode || 'kinship');
      syncInput(kinship.input, String(num(a.kinship)));
      syncInput(hours.input, String(num(a.hours, 6)));
      show(kinship.el, a.mode !== 'hours');
      show(hours.el, a.mode === 'hours');
    },
  };
}
