// Map panel: trails (workers, strength, yield, escorts, Mark/Rally), the selected source or hex (hand-forage, draw a
// trail, claim, flag, satellite), territory, rivals, the war panel with live odds and "what would raise it", war
// parties, battles and incoming raids. Also exports buildWarForm (used by the war-party chooser modal).
// Owner: WP9. Contract: ARCHITECTURE §14.5 (Map row), §13.7, §9 commands; DESIGN §8.10, §9.4–§9.10, §25.6 rule 8.

import { h, setText, setProp, show, toggleClass, syncList, setCost, clear } from '../dom.js';
import { fmt, fmtRate, fmtCount, fmtTime, fmtPct } from '../format.js';
import {
  nameOf, reasonText, WAR_TIPS, TACTIC_TIPS, PARTY_NAMES, BATTLE_NAMES, RAID_PHASES, RES_NAMES,
} from '../text.js';
import { isShown, hasResearch, fedLevel, num, arr, obj } from '../reveal.js';
import { previewTrail, bestOrigin, trailOverlap } from '../../systems/trails.js';
import { claimCost, canClaim, sourceAt } from '../../systems/surface.js';
import { previewAction, garrison as garrisonOf } from '../../systems/rivals.js';
import { ringOf } from '../../core/hex.js';
import { SOURCES } from '../../data/sources.js';
import { TERRAIN_ORDER, TRAIL, ABILITIES, SCOUT } from '../../data/surface.js';
import { ACTIONS } from '../../data/combat.js';
import { RESEARCH } from '../../data/research.js';
import { makeAct, sliderRow, progressBar, note, armedButton, subTabStrip } from './common.js';
import {
  oldRidgeImmunity, frontInfo, frontLabel, satellitesFree, satelliteHexes, satelliteHexWhy, satelliteRule, spanText,
} from '../rules.js';

const TERRAIN_FALLBACK = ['grass', 'sand', 'leaf_litter', 'garden_path', 'tree_root', 'stone', 'puddle', 'log'];

/** Source types that cannot be hand-foraged (DESIGN §8.10 / economy clickForage). */
export function isClickableSource(type) {
  const t = String(type || '');
  return !t.startsWith('prey_') && t !== 'termite_mound' && t !== 'lycaenid_caterpillar';
}

/** Primary resource carried by a trail job. */
function trailRes(job) {
  if (job === 'herder' || job === 'lycaenid') return 'honeydew';
  if (job === 'leafcutter') return 'leaves';
  return 'food';
}

/** Garrison {soldier, supermajor} from the query (falls back to d.combat.garrison). */
function getGarrison(s, d) {
  try {
    const g = garrisonOf(s, d);
    if (g && Number.isFinite(g.soldier)) return { soldier: Math.max(0, g.soldier), supermajor: Math.max(0, num(g.supermajor)) };
  } catch { /* fall through */ }
  const g = obj(d && d.combat && d.combat.garrison);
  return { soldier: Math.max(0, num(g.soldier)), supermajor: Math.max(0, num(g.supermajor)) };
}

/** Rival by uid. */
function rivalBy(s, uid) {
  return arr(s.run && s.run.rivals && s.run.rivals.list).find((r) => r && r.uid === uid) || null;
}

/** Source by uid. */
function sourceBy(s, uid) {
  return arr(s.run && s.run.surface && s.run.surface.sources).find((x) => x && x.uid === uid) || null;
}

/** Display max strength (TRAIL.sMax; persistent_trails raises it to its fx.sMax). */
function sMaxFor(s) {
  const base = num(TRAIL && TRAIL.sMax, 100);
  const pt = RESEARCH.persistent_trails;
  return hasResearch(s, 'persistent_trails') ? Math.max(base, num(pt && pt.fx ? pt.fx.sMax : NaN, base)) : base;
}

/** Ability tooltip copy built from data/surface.js ABILITIES (costs, durations, multipliers are never hardcoded). */
function abilityTip(id) {
  const a = (ABILITIES && ABILITIES[id]) || {};
  const cost = num(a.cost && a.cost.pheromone);
  if (id === 'mark') return 'Strength +' + fmtCount(num(a.add)) + ' now. ' + fmtCount(cost) + ' pheromone. Key M.';
  if (id === 'rally') return 'This trail ×' + num(a.mult) + ' for ' + fmtTime(num(a.sec)) + '. ' + fmtCount(cost) + ' pheromone. Key R.';
  if (id === 'frenzy') return 'Forage ×' + num(a.mult) + ' for ' + fmtTime(num(a.sec)) + '. Costs ' + fmtCount(cost) + ' pheromone.';
  return '';
}

/** Main entrance hex. */
/** C102: the entrance a trail to targetHex should start from (shortest route), falling back to the main one. */
function originFor(s, d, targetHex) {
  let o = -1;
  try { o = bestOrigin(s, d, targetHex); } catch { o = -1; }
  return o >= 0 ? o : mainHex(s);
}

function mainHex(s) {
  const e = arr(s.run && s.run.surface && s.run.surface.entrances).find((x) => x && x.kind === 'main');
  return e ? num(e.hex, 0) : 0;
}

/** Name of a party / battle target. */
function targetName(s, target) {
  const t = obj(target);
  if (t.type === 'rival') {
    const r = rivalBy(s, t.uid);
    return r ? nameOf('rival', r.type) + frontLabel(s, r) : 'Rival';
  }
  if (t.type === 'source') {
    const src = sourceBy(s, t.uid);
    return src ? nameOf('source', src.type) : 'Prey';
  }
  if (t.type === 'raid') return 'Raiders';
  if (t.type === 'battle') return 'Battle';
  return '—';
}

/**
 * Raw integers of 1,000 and more inside system hint text, formatted per DESIGN §26 ("About 18756 more soldiers" →
 * "About 18.7K more soldiers").
 * @param {string} text
 * @returns {string}
 */
export function formatHint(text) {
  return String(text || '').replace(/\b\d{4,}\b/g, (m) => fmtCount(Number(m)));
}

/** The Argentine Front rule in one line (DESIGN §9.3; window length from data). */
function frontRule(f) {
  return 'All ' + f.total + ' Front nests must fall within ' + spanText(f.windowSec) + ' of the first, or the fallen ones regrow at full strength.';
}

/**
 * War-panel notes for a rival target (F12, F13): the Old Ridge's territory gate with progress (assaults only), and the
 * Argentine Front's "all three within the window" rule with the countdown once a nest has fallen.
 * @param {Object} s
 * @param {Object} d
 * @param {Object|null} rival
 * @param {string|null} kind selected party kind
 * @returns {string[]}
 */
export function warNotes(s, d, rival, kind) {
  const out = [];
  if (!rival) return out;
  const imm = kind === 'assault' ? oldRidgeImmunity(s, d, rival) : null;
  if (imm) {
    out.push('Immune to assault until you own ' + imm.need + ' hexes: ' + imm.owned + '/' + imm.need + ' owned. Raids still work.');
  }
  const f = frontInfo(s, rival);
  if (f && !f.done) {
    out.push(frontRule(f));
    if (f.open) out.push(f.fallen + '/' + f.total + ' fallen: ' + fmtTime(Math.ceil(num(f.remaining))) + ' left.');
  }
  return out;
}

/**
 * "What would raise it" lines (DESIGN §25.6 rule 8) with numbers formatted. While the Old Ridge is immune the only
 * thing that helps is territory, so that replaces the soldier and research hints.
 * @param {Object} s
 * @param {Object} d
 * @param {Object|null} p rivals.previewAction result
 * @param {Object|null} rival
 * @param {string|null} kind
 * @returns {string[]}
 */
export function raiseLines(s, d, p, rival, kind) {
  const imm = kind === 'assault' ? oldRidgeImmunity(s, d, rival) : null;
  if (imm) return ['Own ' + fmtCount(imm.left) + ' more hex' + (imm.left === 1 ? '' : 'es') + ' (claim or conquer) to end the immunity'];
  return arr(p && p.raise).filter((r) => r && r.text).map((r) => formatHint(r.text));
}

/**
 * Rival row badge: text, style ('good' | 'warn' | 'danger') and a tooltip (Old Ridge immunity, the Front window,
 * truces).
 * @param {Object} s
 * @param {Object} d
 * @param {Object} r rival
 * @returns {{ text: string, cls: string, tip: string }}
 */
export function rivalStatus(s, d, r) {
  const f = frontInfo(s, r);
  if (r.alive === false) {
    if (f && f.open) {
      return { text: 'Fallen · regrows in ' + fmtTime(Math.ceil(num(f.remaining))), cls: 'warn', tip: frontRule(f) };
    }
    return { text: 'Conquered', cls: 'good', tip: '' };
  }
  if (num(r.truce) > 0) return { text: 'Truce ' + fmtTime(r.truce), cls: 'good', tip: '' };
  const imm = oldRidgeImmunity(s, d, r);
  if (imm) {
    return { text: 'Immune · ' + imm.owned + '/' + imm.need + ' hexes', cls: 'warn',
      tip: 'Cannot be assaulted until you own ' + imm.need + ' hexes. Raids still work.' };
  }
  if (f && f.open) return { text: 'Take within ' + fmtTime(Math.ceil(num(f.remaining))), cls: 'danger', tip: frontRule(f) };
  return { text: 'Hostile', cls: 'warn', tip: f ? frontRule(f) : '' };
}

// ---------------------------------------------------------------------------------------------------------------
// War form
// ---------------------------------------------------------------------------------------------------------------

/**
 * War-party form: target picker, action kind, army sliders, live odds (rivals.previewAction), "what would raise it",
 * Launch / Bribe / Tournament hex pick. Used in the Map panel's War view and in the war chooser modal.
 * @param {Object} ctx { game, bridge?, ui?, toast? }
 * @param {{ kind?: string|null, target?: { type: string, uid: number }|null, onLaunched?: Function|null }} [init]
 * @returns {{ el: HTMLElement, update(s: Object, d: Object): void, setTarget(target: Object, kind?: string): void, destroy(): void }}
 */
export function buildWarForm(ctx, { kind = null, target = null, onLaunched = null } = {}) {
  const { game } = ctx;
  const rejectAct = makeAct(game, ctx.bridge || null);
  const act = (type, args, ev, el) => {
    if (ctx.bridge) return rejectAct(type, args, ev, el);
    const res = game.actions.do(type, args);
    if (!res.ok && ctx.toast) ctx.toast(reasonText(res.reason, type), 'bad', { priority: 'high' });
    return res;
  };
  const st = { kind, target: target ? { type: target.type, uid: target.uid } : null, soldier: 0, supermajor: 0, minor: 0, touched: false };

  const select = h('select', { class: 'select', attrs: { 'aria-label': 'Target' } });
  select.addEventListener('change', () => {
    const [type, uid] = String(select.value).split(':');
    st.target = type ? { type, uid: Number(uid) } : null;
    st.kind = null;
    st.touched = false;
    refresh();
  });
  const kindRow = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Action' });
  const kindBtns = {};
  for (const k of ['raid', 'assault', 'hunt', 'termite', 'tournament']) {
    const b = h('button', { type: 'button', class: 'seg-btn', dataset: { kind: k, tip: WAR_TIPS[k] }, text: k === 'termite' ? 'Raid mound' : k.charAt(0).toUpperCase() + k.slice(1),
      on: { click: () => { st.kind = k; refresh(); } } });
    kindBtns[k] = b;
    kindRow.appendChild(b);
  }
  const sSol = sliderRow('Soldiers', { min: 0, max: 0, step: 1 }, (v) => { st.soldier = v; st.touched = true; refresh(); }, { live: true });
  const sSup = sliderRow('Supermajors', { min: 0, max: 0, step: 1 }, (v) => { st.supermajor = v; st.touched = true; refresh(); }, { live: true });
  const sMin = sliderRow('Minors', { min: 0, max: 0, step: 1 }, (v) => { st.minor = v; st.touched = true; refresh(); }, { live: true });
  const allBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Send everything',
    on: { click: () => { st.touched = false; st.soldier = Infinity; st.supermajor = Infinity; refresh(); } } });

  const winEl = h('div', { class: 'odds-win' });
  const lossEl = h('div', { class: 'odds-line' });
  const lootEl = h('div', { class: 'odds-line' });
  const marchEl = h('div', { class: 'odds-line muted' });
  const raiseEl = h('ul', { class: 'raise-list' });
  const reasonEl = h('p', { class: 'odds-reason' });
  const notesEl = h('ul', { class: 'war-notes' });
  const launch = h('button', { type: 'button', class: 'btn btn-primary', text: 'Launch',
    on: { click: (ev) => doLaunch(ev, launch) } });
  const bribe = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { tip: WAR_TIPS.bribe },
    on: { click: (ev) => { if (st.target && st.target.type === 'rival') { const r = act('bribe', { rival: st.target.uid }, ev, bribe); if (r.ok) toastOk('Truce bought.'); } } } });
  const emptyNote = note('No targets yet. Scout to find rival nests and prey.');

  const el = h('div', { class: 'war-form' },
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Target' }), select),
    kindRow, notesEl, sSol.el, sSup.el, sMin.el, h('div', { class: 'row-end' }, allBtn),
    h('div', { class: 'odds' }, winEl, lossEl, lootEl, marchEl, reasonEl, raiseEl),
    h('div', { class: 'btn-row' }, launch, bribe), emptyNote);

  function toastOk(text) {
    if (ctx.toast) ctx.toast(text, 'good', { priority: 'low' });
    else if (ctx.bridge && ctx.bridge.toast) ctx.bridge.toast(text, 'good');
  }

  function validKinds(s) {
    if (!st.target) return [];
    if (st.target.type === 'rival') {
      const k = ['raid', 'assault'];
      if (hasResearch(s, 'ritual_tournaments')) k.push('tournament');
      return k;
    }
    const src = sourceBy(s, st.target.uid);
    if (!src) return [];
    if (String(src.type).startsWith('prey_')) return ['hunt'];
    if (src.type === 'termite_mound') return ['termite'];
    return [];
  }

  function targets(s) {
    const out = [];
    for (const r of arr(s.run && s.run.rivals && s.run.rivals.list)) {
      if (!r || !r.alive || !r.sighted) continue;
      const f = frontInfo(s, r);
      const nest = f && f.total > 1 ? 'nest ' + f.index + '/' + f.total + ', ' : '';
      out.push({ value: 'rival:' + r.uid, label: nameOf('rival', r.type) + ' (' + nest + 'tier ' + num(r.tier) + ')' });
    }
    const rev = arr(s.run && s.run.surface && s.run.surface.revealed);
    for (const src of arr(s.run && s.run.surface && s.run.surface.sources)) {
      if (!src) continue;
      const prey = String(src.type).startsWith('prey_');
      if (!prey && src.type !== 'termite_mound') continue;
      if (rev.length && !rev[src.hex]) continue;
      out.push({ value: 'source:' + src.uid, label: (prey ? 'Hunt: ' : 'Raid: ') + nameOf('source', src.type) + ' (ring ' + ringOf(num(src.hex)) + ')' });
    }
    return out;
  }

  let lastSig = '';
  let s0 = game.s;
  let d0 = game.d;

  function doLaunch(ev, btn) {
    const s = game.s;
    if (!st.target || !st.kind) return;
    if (st.kind === 'tournament') {
      if (ctx.ui && typeof ctx.ui.setUI === 'function') {
        ctx.ui.setUI({ tool: { kind: 'tournament', rival: st.target.uid, minor: st.minor, soldier: st.soldier, supermajor: st.supermajor } });
      }
      toastOk('Choose a border hex on the map for the tournament.');
      if (onLaunched) onLaunched();
      return;
    }
    const g = getGarrison(s, game.d);
    const soldier = Math.min(st.soldier, Math.floor(g.soldier));
    const supermajor = Math.min(st.supermajor, Math.floor(g.supermajor));
    const res = act('launchParty', { kind: st.kind, target: { type: st.target.type, uid: st.target.uid }, soldier, supermajor }, ev, btn);
    if (res.ok) {
      toastOk((PARTY_NAMES[st.kind] || 'War party') + ' sent: ' + fmtCount(soldier + supermajor) + ' ants.');
      st.touched = false;
      if (onLaunched) onLaunched();
    }
  }

  function refresh() {
    update(s0, d0);
  }

  function update(s, d) {
    s0 = s;
    d0 = d;
    if (!s || !s.run) return;
    const list = targets(s);
    const sig = list.map((o) => o.value + '=' + o.label).join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      clear(select);
      for (const o of list) select.appendChild(h('option', { value: o.value, text: o.label }));
    }
    show(emptyNote, list.length === 0);
    if (st.target && !list.some((o) => o.value === st.target.type + ':' + st.target.uid)) st.target = null;
    if (!st.target && list.length) {
      const [type, uid] = list[0].value.split(':');
      st.target = { type, uid: Number(uid) };
    }
    setProp(select, 'value', st.target ? st.target.type + ':' + st.target.uid : '');
    const kinds = validKinds(s);
    if (!kinds.includes(st.kind)) st.kind = kinds[0] || null;
    for (const k of Object.keys(kindBtns)) {
      show(kindBtns[k], kinds.includes(k));
      toggleClass(kindBtns[k], 'selected', st.kind === k);
    }
    const g = getGarrison(s, d);
    const maxSol = Math.floor(g.soldier);
    const maxSup = Math.floor(g.supermajor);
    if (!st.touched) {
      st.soldier = maxSol;
      st.supermajor = maxSup;
    }
    st.soldier = Math.max(0, Math.min(st.soldier, maxSol));
    st.supermajor = Math.max(0, Math.min(st.supermajor, maxSup));
    const isTour = st.kind === 'tournament';
    const idle = Math.max(0, Math.floor(num(s.run.colony && s.run.colony.adults && s.run.colony.adults.minor) - sumJobs(s)));
    const minorPool = idle + Math.floor(num(s.run.colony && s.run.colony.jobs && s.run.colony.jobs.forager)); // C101: idle, then foragers
    st.minor = Math.max(0, Math.min(st.minor, minorPool));
    sSol.set(st.soldier, { max: maxSol, text: fmtCount(st.soldier) + ' / ' + fmtCount(maxSol), fmt: (v) => fmtCount(v) + ' / ' + fmtCount(maxSol) });
    sSup.set(st.supermajor, { max: maxSup, text: fmtCount(st.supermajor) + ' / ' + fmtCount(maxSup), fmt: (v) => fmtCount(v) + ' / ' + fmtCount(maxSup) });
    sMin.set(st.minor, { max: minorPool, text: fmtCount(st.minor) + ' / ' + fmtCount(minorPool), fmt: (v) => fmtCount(v) + ' / ' + fmtCount(minorPool) });
    show(sSup.el, maxSup > 0 || isShown(s, 'caste_supermajor'));
    show(sMin.el, isTour);
    const hasTarget = !!(st.target && st.kind);
    show(launch, hasTarget);
    setText(launch, isTour ? 'Choose border hex' : 'Launch ' + (PARTY_NAMES[st.kind] || '').toLowerCase());
    const rival = st.target && st.target.type === 'rival' ? rivalBy(s, st.target.uid) : null;
    show(bribe, !!rival);
    if (rival) {
      const ap = num(d && d.combat && d.combat.rivalAP ? d.combat.rivalAP[rival.uid] : NaN, NaN);
      setText(bribe, Number.isFinite(ap) ? 'Bribe (' + fmt(num(ACTIONS && ACTIONS.bribe && ACTIONS.bribe.apMult, 2) * ap) + ' honeydew)' : 'Bribe');
    }
    const notes = hasTarget ? warNotes(s, d, rival, st.kind) : [];
    const nsig = notes.join('|');
    if (notesEl.__sig !== nsig) {
      notesEl.__sig = nsig;
      clear(notesEl);
      for (const n of notes) notesEl.appendChild(h('li', { text: n }));
    }
    show(notesEl, notes.length > 0);
    if (!hasTarget) {
      setText(winEl, '');
      setText(lossEl, '');
      setText(lootEl, '');
      setText(marchEl, '');
      setText(reasonEl, '');
      clear(raiseEl);
      return;
    }
    const army = { soldier: st.soldier, supermajor: st.supermajor };
    if (isTour) army.minor = st.minor;
    let p = null;
    try {
      p = previewAction(s, d, st.kind, st.target.uid, army);
    } catch (err) {
      p = null;
    }
    renderPreview(p, s, d, rival);
  }

  function renderPreview(p, s = s0, d = d0, rival = null) {
    if (!p) {
      setText(winEl, 'Odds unavailable');
      setText(lossEl, '');
      setText(lootEl, '');
      setText(marchEl, '');
      setText(reasonEl, '');
      clear(raiseEl);
      return;
    }
    const win = num(p.win);
    setText(winEl, (st.kind === 'tournament' ? 'Display ratio ' : 'Victory ') + fmtPct(win, { signed: false }));
    toggleClass(winEl, 'good', win >= 0.75);
    toggleClass(winEl, 'bad', win < 0.4);
    const lo = num(p.lossesLo);
    const hi = num(p.lossesHi);
    setText(lossEl, 'Expected losses ' + (Math.round(lo) === Math.round(hi) ? fmtCount(lo) : fmtCount(lo) + '–' + fmtCount(hi)) + ' ants'
      + ' · power ' + fmt(num(p.youAP)) + ' vs ' + fmt(num(p.foeAP)));
    const loot = obj(p.loot);
    const parts = [];
    for (const k of ['food', 'chitin', 'insight']) if (num(loot[k]) > 0) parts.push(fmt(loot[k]) + ' ' + (RES_NAMES[k] || k).toLowerCase());
    if (num(loot.minors) > 0) parts.push(fmtCount(loot.minors) + ' captured workers');
    setText(lootEl, parts.length ? 'Loot ≈ ' + parts.join(', ') : '');
    setText(marchEl, num(p.marchSec) > 0 ? 'March ' + fmtTime(p.marchSec) : '');
    // the immunity is spelled out (with progress) in the notes above the sliders
    setText(reasonEl, p.ok === false && p.reason && p.reason !== 'blocked:immune' ? reasonText(p.reason, st.kind === 'tournament' ? 'tournament' : 'launchParty') : '');
    const raise = raiseLines(s, d, p, rival, st.kind);
    const sig = raise.join('|');
    if (raiseEl.__sig !== sig) {
      raiseEl.__sig = sig;
      clear(raiseEl);
      if (raise.length) raiseEl.appendChild(h('li', { class: 'raise-head', text: 'What would raise it:' }));
      for (const r of raise) raiseEl.appendChild(h('li', { text: r }));
    }
  }

  return {
    el,
    update,
    setTarget(t, k = null) {
      st.target = t ? { type: t.type, uid: t.uid } : null;
      st.kind = k;
      st.touched = false;
      refresh();
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

/** Σ jobs + militia (minors not idle). */
function sumJobs(s) {
  const c = obj(s.run && s.run.colony);
  let n = num(c.militia);
  for (const v of Object.values(obj(c.jobs))) n += num(v);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------------------------

/**
 * Map panel.
 * @param {HTMLElement} root
 * @param {{ game: Object, ui: Object, bridge: Object }} ctx
 * @returns {{ update(s: Object, d: Object): void, destroy(): void }}
 */
export function createPanel(root, { game, ui, bridge }) {
  const act = makeAct(game, bridge);
  const el = h('div', { class: 'panel panel-map' });
  root.appendChild(el);

  const subs = subTabStrip(['main', 'war'], { main: 'Trails & land', war: 'War' }, (id) => ui.setUI({ subTab: id === 'main' ? null : id }));
  const mainView = h('div', { class: 'view-main' });
  const warView = h('div', { class: 'view-war' });
  el.append(subs.el, mainView, warView);

  // --- raid alert (main view) ---
  const raidAlert = h('div', { class: 'alert alert-danger' });
  const raidAlertText = h('span');
  raidAlert.append(raidAlertText, h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Defend',
    on: { click: () => ui.setUI({ subTab: 'war' }) } }));

  // --- trails ---
  const slotsEl = h('span', { class: 'sec-meta' });
  const pherEl = h('span', { class: 'sec-meta' });
  const frenzyBtn = h('button', { type: 'button', class: 'btn btn-small', dataset: { tip: abilityTip('frenzy') },
    on: { click: (ev) => act('frenzy', {}, ev, frenzyBtn) } });
  const trailList = h('div', { class: 'list trail-list' });
  const noTrails = note('Drag from the entrance to a source on the map to draw a trail.');
  const trailsSec = h('section', { class: 'sec' },
    h('h3', { class: 'sec-title' }, 'Trails ', slotsEl), h('div', { class: 'row-between' }, pherEl, frenzyBtn), trailList, noTrails);

  // --- selection ---
  const selBox = h('div', { class: 'sel-box' });
  const selSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Selected' }), selBox);
  let selKey = null; // null: nothing built yet, so the first update shows the "click a source" note
  let selRefs = null;

  // --- territory ---
  const terrOwned = h('span');
  const terrPeak = h('span');
  const claimCostEl = h('span', { class: 'cost' });
  const claimDt = h('dt', { text: 'Next claim' });
  const claimDd = h('dd', null, claimCostEl);
  const channelEl = h('div', { class: 'channel' });
  const channelText = h('span');
  const cancelChannelBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Cancel claim',
    on: { click: (ev) => act('cancelChannel', {}, ev, cancelChannelBtn) } });
  channelEl.append(channelText, cancelChannelBtn);
  const claimToolBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Claim hexes…', dataset: { tip: 'Click owned-adjacent hexes on the map to claim them.' },
    on: { click: () => toggleTool('claim') } });
  const flagToolBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Flag for scouts…', dataset: { tip: 'Flagged hexes are scouted ' + num(SCOUT && SCOUT.flagPriority, 3) + '× sooner.' },
    on: { click: () => toggleTool('flag') } });
  const satMin = satelliteRule().minDist;
  const satToolBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Place satellite…',
    dataset: { tip: 'Pick an owned hex at least ' + satMin + ' hexes from every entrance.' },
    on: { click: () => toggleTool('placeSatellite') } });
  // F15: the satellite rule and how many hexes qualify, before the player clicks
  const satHint = h('p', { class: 'note sat-hint' });
  const terrSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Territory' }),
    h('dl', { class: 'kv' }, h('dt', { text: 'Hexes owned' }), h('dd', null, terrOwned), h('dt', { text: 'Peak this run' }), h('dd', null, terrPeak),
      claimDt, claimDd),
    channelEl, h('div', { class: 'btn-row' }, claimToolBtn, flagToolBtn, satToolBtn), satHint);

  // --- rivals ---
  const rivalList = h('div', { class: 'list rival-list' });
  const noRivals = note('No rival nests found yet.');
  const rivalSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Rivals' }), rivalList, noRivals);

  mainView.append(raidAlert, trailsSec, selSec, terrSec, rivalSec);

  // --- war view ---
  const form = buildWarForm({ game, bridge, ui }, {});
  const warFormSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'War party' }), form.el);
  const raidList = h('div', { class: 'list' });
  const autoGuard = h('input', { type: 'checkbox', class: 'check' });
  autoGuard.addEventListener('change', (ev) => act('setAutomation', { patch: { autoGuard: !!autoGuard.checked } }, ev, autoGuard));
  const autoGuardRow = h('label', { class: 'toggle-row', dataset: { tip: 'Send the garrison to every raid automatically.' } }, autoGuard, h('span', { text: 'Auto-guard' }));
  const raidSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Incoming raids' }), autoGuardRow, raidList);
  const battleList = h('div', { class: 'list' });
  const battleSec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Battles' }), battleList);
  const partyList = h('div', { class: 'list' });
  const partySec = h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'War parties' }), partyList);
  warView.append(raidSec, battleSec, warFormSec, partySec);

  function toggleTool(kind) {
    const cur = ui.getUI().tool;
    ui.setUI({ tool: cur && cur.kind === kind ? null : { kind } });
  }

  // --- trail rows ---
  function createTrailRow(t) {
    const uid = t.uid;
    const name = h('span', { class: 'row-title' });
    const meta = h('span', { class: 'row-meta' });
    const yieldEl = h('span', { class: 'row-yield' });
    const sBar = progressBar('bar-strength');
    const wCount = h('span', { class: 'num' });
    const eCount = h('span', { class: 'num' });
    const step = (ev) => (ev && ev.shiftKey ? 10 : 1) * (ev && (ev.ctrlKey || ev.altKey) ? 10 : 1);
    const cur = () => (findTrail(game.s, uid) || {});
    const wMinus = h('button', { type: 'button', class: 'btn btn-icon', text: '−', attrs: { 'aria-label': 'Fewer workers' }, dataset: { tip: 'Fewer workers (Shift ×10)' },
      on: { click: (ev) => act('assignWorkers', { uid, n: Math.max(0, num(cur().workers) - step(ev)) }, ev, wMinus) } });
    const wPlus = h('button', { type: 'button', class: 'btn btn-icon', text: '+', attrs: { 'aria-label': 'More workers' }, dataset: { tip: 'More workers (Shift ×10)' },
      on: { click: (ev) => act('assignWorkers', { uid, n: num(cur().workers) + step(ev) }, ev, wPlus) } });
    const eMinus = h('button', { type: 'button', class: 'btn btn-icon', text: '−', attrs: { 'aria-label': 'Fewer escorts' },
      on: { click: (ev) => act('assignEscorts', { uid, n: Math.max(0, num(cur().escorts) - step(ev)) }, ev, eMinus) } });
    const ePlus = h('button', { type: 'button', class: 'btn btn-icon', text: '+', attrs: { 'aria-label': 'More escorts' },
      on: { click: (ev) => act('assignEscorts', { uid, n: num(cur().escorts) + step(ev) }, ev, ePlus) } });
    const workers = h('div', { class: 'stepper', dataset: { tip: 'Workers assigned to this trail (auto-fill adds more).' } },
      h('span', { class: 'stepper-label', text: 'Workers' }), wMinus, wCount, wPlus);
    const escorts = h('div', { class: 'stepper', dataset: { tip: 'Soldiers guarding this trail from raids.' } },
      h('span', { class: 'stepper-label', text: 'Escorts' }), eMinus, eCount, ePlus);
    const markBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Mark', dataset: { tip: abilityTip('mark') },
      on: { click: (ev) => act('mark', { uid }, ev, markBtn) } });
    const rallyBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Rally', dataset: { tip: abilityTip('rally') },
      on: { click: (ev) => act('rally', { uid }, ev, rallyBtn) } });
    const rerouteBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Reroute', dataset: { tip: 'Drag waypoints on the map. Free.' },
      on: { click: () => ui.setUI({ tool: { kind: 'reroute', uid }, selection: { view: 'surface', kind: 'trail', id: uid } }) } });
    const delBtn = armedButton('Delete', (ev, b) => act('deleteTrail', { uid }, ev, b));
    const row = h('div', { class: 'trail-row card', dataset: { uid: String(uid) } },
      h('div', { class: 'row-head' }, name, meta, yieldEl), sBar.el,
      h('div', { class: 'row-controls' }, workers, escorts),
      h('div', { class: 'btn-row' }, markBtn, rallyBtn, rerouteBtn, delBtn));
    row.addEventListener('click', (ev) => {
      if (ev.target && typeof ev.target.closest === 'function' && ev.target.closest('button')) return;
      bridge.select({ view: 'surface', kind: 'trail', id: uid });
    });
    row.__r = { name, meta, yieldEl, sBar, wCount, eCount, escorts, markBtn, rallyBtn, delBtn, wMinus, wPlus };
    return row;
  }

  function findTrail(s, uid) {
    return arr(s.run && s.run.surface && s.run.surface.trails).find((t) => t && t.uid === uid) || null;
  }

  function updateTrailRow(row, t, s, d, dmap) {
    const r = row.__r;
    const src = sourceBy(s, t.src);
    const dt = dmap.get(t.uid) || {};
    setText(r.name, src ? nameOf('source', src.type) : 'Trail');
    // C132: Trunk Trails pays shared stretches (hexes another trail also covers)
    let ov = null;
    if (hasResearch(s, 'trunk_trails') && t.job !== 'lycaenid') {
      try { ov = trailOverlap(s, d, t); } catch { ov = null; }
      if (ov && !(ov.shared > 0)) ov = null;
    }
    setText(r.meta, fmtCount(num(t.len)) + ' hex' + (num(t.len) === 1 ? '' : 'es') + (ov ? ' · shared ' + Math.round(100 * ov.frac) + '% ×' + ov.mult.toFixed(2) : '')
      + (dt.priority ? ' · chitin priority' : ''));
    r.meta.title = [ov ? 'Trunk Trails: ' + ov.shared + ' of its ' + ov.total + ' hexes are shared with another trail, so it yields ×' + ov.mult.toFixed(2) + '.' : '',
      dt.priority ? 'Chitin is short for soldier eggs: free foragers fill this trail first.' : ''].filter(Boolean).join(' ');
    const res = trailRes(t.job);
    const out = num(dt.out);
    setText(r.yieldEl, '+' + fmtRate(out).replace('/s', ' ' + (RES_NAMES[res] || res).toLowerCase() + '/s'));
    const sMax = sMaxFor(s);
    r.sBar.set(num(t.S) / sMax, 'Strength ' + fmtCount(num(t.S)) + ' / ' + fmtCount(sMax));
    const eff = num(dt.workers, num(t.workers));
    setText(r.wCount, fmtCount(eff) + (num(t.workers) > 0 && Math.round(num(t.workers)) !== Math.round(eff) ? ' (' + fmtCount(t.workers) + ')' : ''));
    const lyc = t.job === 'lycaenid';
    show(r.wMinus.parentNode, !lyc);
    const lycMin = num(SOURCES.lycaenid_caterpillar && SOURCES.lycaenid_caterpillar.minEscorts, 5);
    setText(r.eCount, fmtCount(num(t.escorts)) + (lyc ? ' / ' + fmtCount(lycMin) : ''));
    show(r.escorts, lyc || isShown(s, 'panel_war') || num(s.run.colony.adults.soldier) > 0);
    show(r.markBtn, isShown(s, 'ability_mark'));
    show(r.rallyBtn, isShown(s, 'ability_rally'));
    const cd = obj(s.run.surface && s.run.surface.cd);
    setText(r.markBtn, num(cd.mark) > 0 ? 'Mark ' + Math.ceil(cd.mark) + 's' : 'Mark');
    setText(r.rallyBtn, num(cd.rally) > 0 ? 'Rally ' + fmtTime(cd.rally) : 'Rally');
    const sel = ui.getUI().selection;
    toggleClass(row, 'selected', !!(sel && sel.kind === 'trail' && sel.id === t.uid));
    if (r.delBtn.__disarm) r.delBtn.__disarm();
  }

  // --- selection ---
  function selectionKey(sel) {
    if (!sel || sel.view !== 'surface') return '';
    if (sel.kind === 'source') return 'source:' + sel.id;
    if (sel.kind === 'hex' || sel.kind === 'entrance') return 'hex:' + sel.hex;
    return '';
  }

  function buildSelection(s, sel) {
    clear(selBox);
    selRefs = null;
    if (!sel) {
      selBox.appendChild(note('Click a source or hex on the map to see it here.'));
      return;
    }
    if (sel.kind === 'source') {
      const uid = sel.id;
      const title = h('div', { class: 'row-title' });
      const info = h('dl', { class: 'kv' });
      const stockDd = h('dd');
      const levelDd = h('dd');
      const ttlDd = h('dd');
      const ringDd = h('dd');
      info.append(h('dt', { text: 'Ring' }), ringDd, h('dt', { text: 'Stock' }), stockDd, h('dt', { text: 'Level' }), levelDd, h('dt', { text: 'Time left' }), ttlDd);
      const forage = h('button', { type: 'button', class: 'btn', text: 'Hand-forage', dataset: { tip: 'Send a runner: food per click. Key Space.' },
        on: { click: (ev) => act('clickForage', { src: uid }, ev, forage) } });
      const draw = h('button', { type: 'button', class: 'btn btn-primary', text: 'Draw trail from nearest entrance',
        on: { click: (ev) => {
          const src = sourceBy(game.s, uid);
          if (!src) return;
          const r = act('drawTrail', { origin: originFor(game.s, game.d, src.hex), target: src.hex }, ev, draw);
          if (r.ok) bridge.toast('Trail drawn.', 'good');
        } } });
      const attack = h('button', { type: 'button', class: 'btn btn-danger', text: 'Hunt…',
        on: { click: () => { const src = sourceBy(game.s, uid); if (src) { form.setTarget({ type: 'source', uid }); ui.setUI({ subTab: 'war' }); } } } });
      const preview = h('p', { class: 'muted' });
      selBox.append(title, info, preview, h('div', { class: 'btn-row' }, forage, draw, attack));
      selRefs = { kind: 'source', uid, title, stockDd, levelDd, ttlDd, ringDd, forage, draw, attack, preview };
      return;
    }
    const hex = sel.hex;
    const title = h('div', { class: 'row-title' });
    const terrDd = h('dd');
    const ownDd = h('dd');
    const costEl = h('span', { class: 'cost' });
    const claimBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'Claim',
      on: { click: (ev) => act('claimHex', { hex }, ev, claimBtn) } });
    const flagBtn = h('button', { type: 'button', class: 'btn' ,
      on: { click: (ev) => { const fl = arr(game.s.run.surface.flagged).includes(hex); act('flagHex', { hex, on: !fl }, ev, flagBtn); } } });
    const satBtn = h('button', { type: 'button', class: 'btn', text: 'Place satellite here',
      on: { click: () => bridge.openChooser('satelliteColumn', { hex }) } });
    const claimWhy = h('p', { class: 'muted' });
    const satWhy = h('p', { class: 'muted sat-why' });
    const costDt = h('dt', { text: 'Claim cost' });
    const costDd = h('dd', null, costEl);
    selBox.append(title, h('dl', { class: 'kv' }, h('dt', { text: 'Terrain' }), terrDd, h('dt', { text: 'Owner' }), ownDd,
      costDt, costDd), claimWhy, satWhy, h('div', { class: 'btn-row' }, claimBtn, flagBtn, satBtn));
    selRefs = { kind: 'hex', hex, title, terrDd, ownDd, costEl, costDt, costDd, claimBtn, flagBtn, satBtn, claimWhy, satWhy };
  }

  function updateSelection(s, d) {
    const sel = ui.getUI().selection;
    const key = selectionKey(sel);
    if (key !== selKey) {
      selKey = key;
      buildSelection(s, key ? sel : null);
    }
    if (!selRefs) return;
    if (selRefs.kind === 'source') {
      const src = sourceBy(s, selRefs.uid);
      if (!src) {
        setText(selRefs.title, 'Gone');
        show(selRefs.forage, false);
        show(selRefs.draw, false);
        show(selRefs.attack, false);
        return;
      }
      setText(selRefs.title, nameOf('source', src.type));
      setText(selRefs.ringDd, String(ringOf(num(src.hex))));
      setText(selRefs.stockDd, num(src.stock, -1) < 0 ? 'Endless' : fmt(num(src.stock)) + ' / ' + fmt(num(src.max)));
      setText(selRefs.levelDd, src.type === 'aphid_colony' ? 'Level ' + num(src.level, 1) : '—');
      setText(selRefs.ttlDd, num(src.ttl, -1) < 0 ? '—' : fmtTime(num(src.ttl)));
      const clickable = isClickableSource(src.type);
      show(selRefs.forage, clickable);
      const combat = String(src.type).startsWith('prey_') || src.type === 'termite_mound';
      show(selRefs.attack, combat && isShown(s, 'panel_war'));
      setText(selRefs.attack, src.type === 'termite_mound' ? 'Raid mound…' : 'Hunt…');
      const hasTrail = arr(s.run.surface.trails).some((t) => t && t.src === src.uid);
      show(selRefs.draw, !combat && !hasTrail);
      if (!combat && !hasTrail) {
        let p = null;
        try { p = previewTrail(s, d, originFor(s, d, src.hex), src.hex, []); } catch { p = null; }
        setText(selRefs.preview, p && p.ok ? 'Trail: ' + fmtCount(num(p.len)) + ' hexes · ' + fmtRate(num(p.perWorker)) + ' per worker · capacity ' + fmtCount(num(p.cap))
          : p && p.reason ? reasonText(p.reason, 'drawTrail') : '');
      } else {
        setText(selRefs.preview, hasTrail ? 'A trail already serves this source.' : '');
      }
    } else {
      const hex = selRefs.hex;
      const surf = obj(s.run.surface);
      const revealed = arr(surf.revealed)[hex] === 1;
      setText(selRefs.title, 'Hex ' + hex + ' · ring ' + ringOf(hex));
      const code = num(arr(surf.terrain)[hex]);
      const order = TERRAIN_ORDER.length ? TERRAIN_ORDER : TERRAIN_FALLBACK;
      setText(selRefs.terrDd, revealed ? nameOf('terrain', order[code] || 'grass') : 'Unexplored');
      const owned = d && d.surface && d.surface.owned ? d.surface.owned[hex] : 0;
      const rv = d && d.surface && d.surface.rival ? d.surface.rival[hex] : 0;
      const rr = rv ? rivalBy(s, rv) : null;
      setText(selRefs.ownDd, owned ? ['', 'Yours (auto)', 'Yours (claimed)', 'Yours (conquered)', 'Yours (trunk trail)'][owned] || 'Yours'
        : rr ? nameOf('rival', rr.type) : 'Unclaimed');
      let reason = null;
      try { reason = canClaim(s, d, hex); } catch { reason = 'invalid'; }
      const claimShown = isShown(s, 'hex_claim') && !owned;
      show(selRefs.claimBtn, claimShown);
      show(selRefs.costDt, claimShown);
      show(selRefs.costDd, claimShown);
      if (claimShown) setCost(selRefs.costEl, safeCost(() => claimCost(s)), s);
      setText(selRefs.claimWhy, claimShown && reason && reason !== 'cantAfford' ? reasonText(reason, 'claimHex') : '');
      const canFlag = hasResearch(s, 'antennation') && !revealed;
      show(selRefs.flagBtn, canFlag);
      setText(selRefs.flagBtn, arr(surf.flagged).includes(hex) ? 'Unflag' : 'Flag for scouts');
      const satFree = satellitesFree(s) > 0;
      const satTool = !!(ui.getUI().tool && ui.getUI().tool.kind === 'placeSatellite');
      const satNo = satFree && (owned > 0 || satTool) ? satelliteHexWhy(s, d, hex, reasonText) : '';
      show(selRefs.satBtn, satFree && owned > 0 && !satNo);
      setText(selRefs.satWhy, !satNo ? '' : /satellite/i.test(satNo) ? satNo : 'Satellite: ' + satNo);
      show(selRefs.satWhy, !!satNo);
    }
  }

  function safeCost(fn) {
    try { return fn(); } catch { return null; }
  }

  function satelliteFree(s) {
    return satellitesFree(s) > 0;
  }

  // --- rival rows ---
  function createRivalRow(r) {
    const uid = r.uid;
    const name = h('span', { class: 'row-title' });
    const meta = h('span', { class: 'row-meta' });
    const ap = h('span', { class: 'row-yield' });
    const status = h('span', { class: 'badge' });
    const warBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'War…',
      on: { click: () => { form.setTarget({ type: 'rival', uid }); ui.setUI({ subTab: 'war' }); bridge.select({ view: 'surface', kind: 'rival', id: uid }); } } });
    const why = h('p', { class: 'row-note muted' });
    const row = h('div', { class: 'rival-row card' }, h('div', { class: 'row-head' }, name, meta, ap), h('div', { class: 'row-between' }, status, warBtn), why);
    row.__r = { name, meta, ap, status, warBtn, why };
    return row;
  }

  function updateRivalRow(row, r, s, d) {
    const x = row.__r;
    setText(x.name, nameOf('rival', r.type) + frontLabel(s, r));
    setText(x.meta, 'Tier ' + num(r.tier) + ' · ' + fmtCount(num(r.n)) + ' soldiers');
    const ap = num(d && d.combat && d.combat.rivalAP ? d.combat.rivalAP[r.uid] : NaN, NaN);
    setText(x.ap, Number.isFinite(ap) ? 'Power ' + fmt(ap) : '');
    // F12 / F13: immunity progress, the Front window countdown and its rule, instead of a bare "Hostile"
    const st = rivalStatus(s, d, r);
    setText(x.status, st.text);
    toggleClass(x.status, 'badge-good', st.cls === 'good');
    toggleClass(x.status, 'badge-warn', st.cls === 'warn');
    toggleClass(x.status, 'badge-danger', st.cls === 'danger');
    const tipNow = st.tip || '';
    setText(x.why, tipNow);
    show(x.why, !!tipNow);
    show(x.warBtn, !!r.alive && (isShown(s, 'panel_war') || hasResearch(s, 'ritual_tournaments')));
  }

  // --- campaign rows ---
  function createRaidRow(raid) {
    const uid = raid.uid;
    const title = h('span', { class: 'row-title' });
    const meta = h('span', { class: 'row-meta' });
    const btn = h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Dispatch garrison',
      on: { click: (ev) => act('dispatchGuard', { raid: uid }, ev, btn) } });
    const note = h('span', { class: 'row-meta raid-note' });
    const row = h('div', { class: 'raid-row card danger' }, h('div', { class: 'row-head' }, title, meta), btn, note);
    row.__r = { title, meta, btn, note };
    return row;
  }

  // F14: dispatchGuard only sends the garrison to a TRAIL raid in its warning or trail phase; a raid on the nest is met
  // by the whole garrison automatically (raids.js 'invalid:nest'), so it gets a note instead of a button that fails.
  function updateRaidRow(row, raid, s, d) {
    const x = row.__r;
    const r = rivalBy(s, raid.rival);
    const tgt = obj(raid.target);
    let tname = 'the nest';
    if (tgt.type === 'trail') {
      const t = findTrail(s, tgt.uid);
      const src = t ? sourceBy(s, t.src) : null;
      tname = 'trail to ' + (src ? nameOf('source', src.type).toLowerCase() : 'a source');
    }
    setText(x.title, (r ? nameOf('rival', r.type) : 'Raiders') + ' → ' + tname);
    setText(x.meta, (RAID_PHASES[raid.phase] || raid.phase) + (raid.phase === 'warning' ? ' · ' + fmtTime(num(raid.warn)) : '') + ' · ' + fmtCount(num(raid.raiders)) + ' raiders');
    const trailRaid = tgt.type === 'trail' && (raid.phase === 'warning' || raid.phase === 'trail');
    show(x.btn, trailRaid);
    setProp(x.btn, 'disabled', !!raid.guard);
    setText(x.btn, raid.guard ? 'Garrison sent' : 'Dispatch garrison');
    const nestRaid = tgt.type !== 'trail' && (raid.phase === 'warning' || raid.phase === 'border' || raid.phase === 'gate');
    if (x.note) {
      show(x.note, nestRaid);
      if (nestRaid) {
        const g = getGarrison(s, d);
        const n = g.soldier + g.supermajor;
        setText(x.note, n >= 1 ? 'Your garrison (' + fmtCount(n) + ') defends the entrance automatically.'
          : 'No soldiers at home: raise soldiers to defend the entrance.');
      }
    }
  }

  function createBattleRow(b) {
    const uid = b.uid;
    const title = h('span', { class: 'row-title' });
    const meta = h('span', { class: 'row-meta' });
    const mk = (action, label) => {
      const btn = h('button', { type: 'button', class: 'btn btn-small', text: label, dataset: { tip: TACTIC_TIPS[action] },
        on: { click: (ev) => act('battleAction', { battle: uid, action }, ev, btn) } });
      return btn;
    };
    const rally = mk('alarm_rally', 'Alarm rally');
    const mob = mk('mobilize', 'Mobilize');
    const retreat = mk('retreat', 'Retreat');
    const reinf = h('button', { type: 'button', class: 'btn btn-small', text: 'Reinforce', dataset: { tip: TACTIC_TIPS.reinforce },
      on: { click: (ev) => { const g = getGarrison(game.s, game.d); act('reinforce', { battle: uid, soldier: Math.floor(g.soldier), supermajor: Math.floor(g.supermajor) }, ev, reinf); } } });
    const row = h('div', { class: 'battle-row card' }, h('div', { class: 'row-head' }, title, meta), h('div', { class: 'btn-row' }, rally, mob, reinf, retreat));
    row.__r = { title, meta, rally, mob, retreat, reinf };
    return row;
  }

  function updateBattleRow(row, b, s) {
    const x = row.__r;
    const you = obj(b.you);
    const foe = obj(b.foe);
    setText(x.title, (BATTLE_NAMES[b.kind] || 'Battle') + (b.below ? ' (gate)' : ''));
    const yours = num(you.militia) + num(you.soldier) + num(you.supermajor);
    setText(x.meta, fmtCount(yours) + ' vs ' + fmtCount(num(foe.n)) + ' · ' + fmtTime(num(b.t)) + (num(b.rally) > 0 ? ' · rallied' : ''));
    show(x.rally, isShown(s, 'res_pheromone'));
    show(x.mob, (b.kind === 'border' || b.kind === 'gate') && isShown(s, 'res_pheromone'));
  }

  function createPartyRow(p) {
    const uid = p.uid;
    const title = h('span', { class: 'row-title' });
    const meta = h('span', { class: 'row-meta' });
    const recall = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Recall',
      on: { click: (ev) => act('recallParty', { uid }, ev, recall) } });
    const row = h('div', { class: 'party-row card' }, h('div', { class: 'row-head' }, title, meta), recall);
    row.__r = { title, meta, recall };
    return row;
  }

  function updatePartyRow(row, p, s) {
    const x = row.__r;
    setText(x.title, (PARTY_NAMES[p.kind] || 'Party') + ' → ' + targetName(s, p.target));
    const n = num(p.soldier) + num(p.supermajor);
    const prog = arr(p.path).length > 1 ? Math.min(1, num(p.pos) / (arr(p.path).length - 1)) : 0;
    setText(x.meta, fmtCount(n) + ' ants · ' + ({ out: 'marching', fighting: 'fighting', home: 'returning' }[p.state] || p.state || '') + (p.state === 'out' ? ' ' + fmtPct(prog, { signed: false }) : ''));
    show(x.recall, p.state === 'out');
  }

  return {
    update(s, d) {
      if (!s || !s.run) return;
      const sub = ui.getUI().subTab === 'war' ? 'war' : 'main';
      const warVisible = isShown(s, ['panel_war', 'panel_rivals']);
      subs.update(warVisible ? sub : 'main', { main: true, war: warVisible });
      const view = warVisible ? sub : 'main';
      show(mainView, view === 'main');
      show(warView, view === 'war');

      const raids = arr(s.run.war && s.run.war.raids).filter((r) => r && r.phase !== 'done');
      const warn = raids.find((r) => r.phase === 'warning');
      show(raidAlert, !!warn && view === 'main');
      if (warn) setText(raidAlertText, 'Raid incoming in ' + fmtTime(num(warn.warn)) + '!');

      if (view === 'main') {
        const surf = obj(s.run.surface);
        setText(slotsEl, fmtCount(num(d.surface && d.surface.slotsUsed)) + ' / ' + fmtCount(num(d.surface && d.surface.slots, 3)) + ' slots');
        show(pherEl, isShown(s, 'res_pheromone'));
        setText(pherEl, 'Pheromone ' + fmt(num(s.run.res.pheromone)));
        show(frenzyBtn, isShown(s, 'ability_frenzy'));
        const fcd = num(obj(surf.cd).frenzy);
        setText(frenzyBtn, fcd > 0 ? 'Frenzy ' + fmtTime(fcd) : 'Frenzy');
        const trails = arr(surf.trails).filter(Boolean);
        const dmap = new Map();
        for (const t of arr(d.surface && d.surface.trails)) if (t) dmap.set(t.uid, t);
        syncList(trailList, trails, (t) => t.uid, createTrailRow, (row, t) => updateTrailRow(row, t, s, d, dmap));
        show(noTrails, trails.length <= 1);
        updateSelection(s, d);
        setText(terrOwned, fmtCount(num(d.surface && d.surface.ownedCount)));
        setText(terrPeak, fmtCount(num(s.run.tPeak)));
        show(claimDt, isShown(s, 'hex_claim'));
        show(claimDd, isShown(s, 'hex_claim'));
        if (isShown(s, 'hex_claim')) setCost(claimCostEl, safeCost(() => claimCost(s)), s);
        const ch = surf.channel;
        show(channelEl, !!ch);
        if (ch) setText(channelText, 'Claiming hex ' + num(ch.hex) + ': ' + fmt(num(ch.paid)) + ' / ' + fmt(num(ch.cost)) + ' pheromone');
        const tool = ui.getUI().tool;
        show(claimToolBtn, isShown(s, 'hex_claim'));
        toggleClass(claimToolBtn, 'active', !!(tool && tool.kind === 'claim'));
        show(flagToolBtn, hasResearch(s, 'antennation'));
        toggleClass(flagToolBtn, 'active', !!(tool && tool.kind === 'flag'));
        show(satToolBtn, satelliteFree(s));
        toggleClass(satToolBtn, 'active', !!(tool && tool.kind === 'placeSatellite'));
        const satOn = satelliteFree(s);
        show(satHint, satOn);
        if (satOn) {
          const n = satelliteHexes(s, d).length;
          const rule = 'an owned hex at least ' + satMin + ' hexes from every entrance';
          setText(satHint, n === 0
            ? 'Satellite: needs ' + rule + '. None yet: claim or conquer land further out.'
            : (tool && tool.kind === 'placeSatellite' ? 'Click ' : 'Satellite: needs ') + rule + ' (' + fmtCount(n) + ' qualify).');
          toggleClass(satHint, 'warn', n === 0);
        }
        show(rivalSec, isShown(s, 'panel_rivals'));
        const rivals = arr(s.run.rivals && s.run.rivals.list).filter((r) => r && r.sighted);
        syncList(rivalList, rivals, (r) => r.uid, createRivalRow, (row, r) => updateRivalRow(row, r, s, d));
        show(noRivals, rivals.length === 0);
      } else {
        form.update(s, d);
        show(warFormSec, isShown(s, 'panel_war') || hasResearch(s, 'ritual_tournaments') || isShown(s, 'panel_rivals'));
        show(autoGuardRow, hasResearch(s, 'early_warning'));
        setProp(autoGuard, 'checked', !!(s.meta.automation && s.meta.automation.autoGuard));
        syncList(raidList, raids, (r) => r.uid, createRaidRow, (row, r) => updateRaidRow(row, r, s, d));
        show(raidSec, raids.length > 0 || hasResearch(s, 'early_warning'));
        const battles = arr(s.run.war && s.run.war.battles).filter(Boolean);
        syncList(battleList, battles, (b) => b.uid, createBattleRow, (row, b) => updateBattleRow(row, b, s));
        show(battleSec, battles.length > 0);
        const parties = arr(s.run.war && s.run.war.parties).filter(Boolean);
        syncList(partyList, parties, (p) => p.uid, createPartyRow, (row, p) => updatePartyRow(row, p, s));
        show(partySec, parties.length > 0);
      }
    },
    /** Focus the war form on a target (bridge.openTab('map', 'war') from a rival click). */
    focusTarget(target, kind = null) {
      form.setTarget(target, kind);
    },
    destroy() {
      form.destroy();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

/** Exposed for tests: source lookup by hex through the surface query. */
export function sourceAtHex(s, hex) {
  try { return sourceAt(s, hex); } catch { return null; }
}
