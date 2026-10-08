// Blueprint editor (ARCHITECTURE §18 C180; Federation node `architects_table`): a modal sandbox of the nest grid where
// the player opens a saved blueprint, places / moves / deletes chambers (with their full-size reservations and starting
// corners) and paints tunnels, then saves it — the live colony is never touched. Validation reuses the nest rules
// (nest.validatePlacement) on a sandbox nest built from the blueprint alone: plain soil in every stratum (it cannot know
// a future run's stones, water or roots), every chamber unlocked, every layer open, no costs; rules that depend on a
// run's own features (touch a root, touch a water pocket) are waived, since the blueprint pass handles them each run
// (C176 Wells, C177 roots). The current run's soil can be shown faintly as a reference (toggle).
// Pure helpers (createSandbox, checkSpot, placeIn, moveIn, deleteIn, paintTunnels, chamberAtDoc, docFrom) are exported
// for tests; openBlueprintEditor mounts the modal. Owner: WP3 nest engineer. Contract: ARCHITECTURE §14.5, §18 C180.

import { h, setText, setProp, toggleClass } from './dom.js';
import { nameOf, reasonText } from './text.js';
import { arr, num, fedLevel } from './reveal.js';
import { GRID, CELL, validCols } from '../data/balance.js';
import { CHAMBERS, CHAMBER_ORDER } from '../data/chambers.js';
import { LAYERS, LAYER_ORDER } from '../data/strata.js';
import { UNLOCKS } from '../data/unlocks.js';
import { defaultNestCells, royalRes } from '../core/state.js';
import * as G from '../systems/nestgeom.js';
import { COLS, NCELLS as N } from '../systems/nestgeom.js';
import { validatePlacement, blueprintForCols, nestCols } from '../systems/nest.js';

// C215: COLS / N are nestgeom's live bindings: the editor works in the current run's nest width (openBlueprintEditor
// moves a layout saved at another width into it, nest.blueprintForCols, and saves it with that width).
const ROWS = GRID.rows;
/** Refusals the editor does not hold against a spot: they depend on a run (costs, queue, its water) or are solved by
 * the blueprint pass itself (access tunnels, C138). */
const WAIVED = new Set(['cantAfford', 'queueFull', 'blocked:route', 'locked']);
/** Chamber fill colours in the editor (r,g,b). */
const TYPE_COL = {
  royal_chamber: '244,206,120', gallery: '226,190,136', nursery: '246,226,200', granary: '230,200,120', scent_library: '190,214,255',
  midden: '170,150,110', barracks: '214,120,96', war_hall: '226,104,84', carapace_store: '214,160,110', carapace_workshop: '224,170,120',
  root_aphid_pen: '170,210,120', fungus_garden: '214,230,220', repletion_hall: '240,180,90', hibernaculum: '200,224,240',
  thermal_chimney: '230,150,100', gate: '200,190,170', water_well: '160,210,240', nuptial_chamber: '236,214,250', deep_vault: '250,200,110',
};
const LAYER_COL = { topsoil: '#5d3b24', loam: '#7b4f2d', clay: '#9b5b3b', gravel: '#8a7e6c', bedrock: '#4b4b54', aquifer: '#3e5662' };

/**
 * A blueprint as an editable document (deep copy): { name, chambers, tunnels, royal }.
 * @param {Object|null} bp
 * @returns {{ name: string, chambers: Array<Object>, tunnels: number[], royal: Object|null }}
 */
export function docFrom(bp) {
  const b = bp && typeof bp === 'object' ? bp : {};
  return {
    name: typeof b.name === 'string' ? b.name : 'Layout',
    chambers: arr(b.chambers).filter((c) => c && CHAMBERS[c.type]).map((c) => {
      const o = { type: c.type, x: c.x, y: c.y, w: c.w, h: c.h, level: num(c.level, 1) || 1 };
      if (c.res) o.res = { x: c.res.x, y: c.res.y, w: c.res.w, h: c.res.h };
      return o;
    }),
    tunnels: arr(b.tunnels).filter((i) => Number.isInteger(i) && i >= 0 && i < N),
    royal: b.royal && Number.isInteger(b.royal.x) ? { x: b.royal.x, y: b.royal.y, ...(b.royal.res ? { res: { ...b.royal.res } } : {}) } : null,
    ...(validCols(b.cols) && b.cols !== GRID.baseCols ? { cols: b.cols } : {}),
  };
}

/** L1 footprint of a doc chamber (the room the blueprint queues). */
function roomOf(c) {
  const fp = G.footprint(c.type, 1);
  return { x: c.x, y: c.y, w: fp.w, h: fp.h };
}

/** The Royal Chamber's L1 room in the doc (its saved corner, else the usual spot). */
function royalRoomOf(doc) {
  const def = CHAMBERS.royal_chamber;
  const r = GRID.royal;
  return doc.royal ? { x: doc.royal.x, y: doc.royal.y, w: def.w0, h: def.h0 } : { x: r.x, y: r.y, w: r.w, h: r.h };
}

/**
 * A sandbox state for validating spots of the blueprint `doc`: a fresh nest (plain soil, the main shaft, the blueprint's
 * Royal Chamber at its saved corner with its reservation, every other chamber at L1 with its saved reservation, the
 * tunnels dug), every chamber unlocked, bedrock and the aquifer open, no hardship, plenty of every resource, and root
 * lines down every column so the touch-a-root rule never refuses (each run grows its own, C177). `skip`: a doc chamber
 * index to leave out (the one being moved), or 'royal'. Research, traits and Federation nodes are the player's (they set
 * instance limits). Nothing of `s` is written.
 * @param {Object} s live state (read only)
 * @param {Object} doc
 * @param {{ skip?: number|string|null }} [opts]
 * @returns {{ s: Object, d: Object }}
 */
export function createSandbox(s, doc, { skip = null } = {}) {
  const cells = defaultNestCells(COLS);
  const r0 = GRID.royal;
  const chambers = [];
  let uid = 1;
  if (skip !== 'royal') {
    const rr = royalRoomOf(doc);
    if (rr.x !== r0.x || rr.y !== r0.y) {
      for (let y = r0.y; y < r0.y + r0.h; y++) for (let x = r0.x; x < r0.x + r0.w; x++) cells[y * COLS + x] = CELL.SOIL;
      for (let y = rr.y; y < rr.y + rr.h; y++) for (let x = rr.x; x < rr.x + rr.w; x++) if (G.inBounds(x, y)) cells[y * COLS + x] = CELL.CHAMBER;
    }
    const res = doc.royal && doc.royal.res ? { ...doc.royal.res } : royalRes(rr);
    chambers.push({ uid: uid++, type: 'royal_chamber', k: 0, x: rr.x, y: rr.y, w: rr.w, h: rr.h, level: 1, target: 1, status: 'active',
      blueprint: false, bornAt: 0, res });
  } else {
    for (let y = r0.y; y < r0.y + r0.h; y++) for (let x = r0.x; x < r0.x + r0.w; x++) cells[y * COLS + x] = CELL.SOIL;
    uid++;
  }
  const counts = {};
  doc.chambers.forEach((c, j) => {
    if (j === skip || !CHAMBERS[c.type]) return;
    const room = roomOf(c);
    const k = counts[c.type] || 0;
    counts[c.type] = k + 1;
    const ch = { uid: uid++, type: c.type, k, x: room.x, y: room.y, w: room.w, h: room.h, level: 1, target: 1, status: 'active', blueprint: true,
      bornAt: 0 };
    if (c.res) ch.res = { ...c.res };
    else if (G.footprint(c.type, 8).w > room.w || G.footprint(c.type, 8).h > room.h) ch.noRes = true;
    chambers.push(ch);
    for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) if (G.inBounds(x, y)) cells[y * COLS + x] = CELL.CHAMBER;
  });
  for (const i of doc.tunnels) if (cells[i] === CELL.SOIL) cells[i] = CELL.TUNNEL;
  const roots = [];
  for (let col = 0; col < COLS; col++) if (col !== GRID.mainCol) roots.push({ col, y0: 1, y1: ROWS - 1 });
  const unlocked = {};
  for (const u of UNLOCKS) unlocked[u.key] = true;
  const rich = 1e300;
  const sb = {
    meta: s.meta,
    cycle: s.cycle,
    era: { ...s.era, federation: { ...(s.era && s.era.federation), aquifer_access: Math.max(1, num(s.era && s.era.federation && s.era.federation.aquifer_access)) } },
    run: {
      time: 0, hardship: null, landingTags: [], boon: null, edict: null,
      research: { ...(s.run && s.run.research), acid_excavation: 1 },
      unlocked,
      res: { food: rich, soil: rich, insight: rich, pheromone: rich, chitin: rich, honeydew: rich, leaves: rich, fungus: rich },
      surface: { mound: num(s.run && s.run.surface && s.run.surface.mound) },
      colony: s.run && s.run.colony,
      nest: {
        rev: 1, cells, chambers, nextUid: uid, queue: [], features: { caches: [], water: [], roots }, backfill: [],
        shafts: [{ kind: 'main', col: GRID.mainCol, open: true, ref: -1 }], maint: 0, deepestRow: ROWS - 1, bpPending: [], bpTunnels: [], bpNotes: [],
      },
    },
  };
  const d = { nest: {}, stats: {}, season: {}, meta: {} };
  return { s: sb, d };
}

/**
 * Can a chamber of `type` go at (x, y) in the blueprint (its L1 room top-left)? Nest rules on the sandbox, minus the
 * waived run-dependent refusals (and, for a Water Well, its pocket and per-pocket limit: Wells find this run's water
 * themselves, C176). { ok, tint, reason, rect, res, anchor, anchors }.
 * @param {Object} s
 * @param {Object} doc
 * @param {string} type
 * @param {number} x
 * @param {number} y
 * @param {{ anchor?: string|null, skip?: number|string|null }} [opts]
 */
export function checkSpot(s, doc, type, x, y, { anchor = null, skip = null } = {}) {
  const out = { ok: false, tint: 'red', reason: 'invalid', rect: null, res: null, anchor: null, anchors: [] };
  if (!CHAMBERS[type] || !Number.isInteger(x) || !Number.isInteger(y)) return out;
  // the original Royal Chamber (skip 'royal'): its own row rule and a free room, judged as a placement, limit waived
  const sb = createSandbox(s, doc, { skip });
  let r;
  try {
    r = validatePlacement(sb.s, sb.d, type, x, y, { anchor });
  } catch {
    return out;
  }
  let reason = r.reason;
  if (WAIVED.has(reason)) reason = null;
  if (type === 'water_well' && (reason === 'invalid:water' || reason === 'max')) reason = null;
  if (type === 'royal_chamber' && skip === 'royal' && reason === 'max') reason = null;
  out.reason = reason;
  out.ok = !reason;
  out.tint = reason ? 'red' : r.tint === 'amber' ? 'amber' : 'green';
  out.rect = r.rect;
  out.res = r.res ? { ...r.res } : null;
  out.anchor = r.anchor;
  out.anchors = arr(r.anchors);
  return out;
}

/** Index of the doc chamber whose L1 room covers (x, y), 'royal' for the Royal Chamber, or −1. */
export function chamberAtDoc(doc, x, y) {
  const rr = royalRoomOf(doc);
  if (x >= rr.x && x < rr.x + rr.w && y >= rr.y && y < rr.y + rr.h) return 'royal';
  for (let j = doc.chambers.length - 1; j >= 0; j--) {
    const r = roomOf(doc.chambers[j]);
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return j;
  }
  return -1;
}

/** A chamber entry for the doc from a successful check. */
function entry(type, x, y, chk) {
  const fp = G.footprint(type, 1);
  const o = { type, x, y, w: fp.w, h: fp.h, level: 1 };
  if (chk.res && (chk.res.w > fp.w || chk.res.h > fp.h)) o.res = { ...chk.res };
  return o;
}

/**
 * Place a chamber in the doc (a new doc) or refuse: { doc, reason }.
 * @returns {{ doc: Object|null, reason: string|null }}
 */
export function placeIn(s, doc, type, x, y, anchor = null) {
  const chk = checkSpot(s, doc, type, x, y, { anchor });
  if (!chk.ok) return { doc: null, reason: chk.reason };
  const next = docFrom(doc);
  next.chambers.push(entry(type, x, y, chk));
  next.tunnels = next.tunnels.filter((i) => !G.inRect(chk.rect, i));
  return { doc: next, reason: null };
}

/**
 * Move doc chamber `j` (or 'royal') so its L1 room starts at (x, y), keeping its corner unless `anchor` is given.
 * @returns {{ doc: Object|null, reason: string|null }}
 */
export function moveIn(s, doc, j, x, y, anchor = null) {
  if (j === 'royal') {
    const chk = checkSpot(s, doc, 'royal_chamber', x, y, { anchor: anchor || (doc.royal && doc.royal.res ? G.anchorOf(royalRoomOf(doc), doc.royal.res) : 'tr'), skip: 'royal' });
    if (!chk.ok) return { doc: null, reason: chk.reason };
    const next = docFrom(doc);
    next.royal = { x, y };
    if (chk.res) next.royal.res = { ...chk.res };
    next.tunnels = next.tunnels.filter((i) => !G.inRect(chk.rect, i));
    return { doc: next, reason: null };
  }
  const c = doc.chambers[j];
  if (!c) return { doc: null, reason: 'notFound' };
  const keep = c.res ? G.anchorOf(roomOf(c), c.res) : null;
  const chk = checkSpot(s, doc, c.type, x, y, { anchor: anchor || keep, skip: j });
  if (!chk.ok) return { doc: null, reason: chk.reason };
  const next = docFrom(doc);
  next.chambers[j] = { ...entry(c.type, x, y, chk), level: c.level || 1 };
  next.tunnels = next.tunnels.filter((i) => !G.inRect(chk.rect, i));
  return { doc: next, reason: null };
}

/** Delete doc chamber `j` (the Royal Chamber cannot be deleted). */
export function deleteIn(doc, j) {
  if (!Number.isInteger(j) || !doc.chambers[j]) return doc;
  const next = docFrom(doc);
  next.chambers.splice(j, 1);
  return next;
}

/**
 * Add (`on`) or remove tunnel cells. Added cells must be plain soil in the sandbox: not in a chamber room, a reserved
 * room or the main shaft. Returns a new doc.
 */
export function paintTunnels(s, doc, cells, on) {
  const next = docFrom(doc);
  const set = new Set(next.tunnels);
  if (!on) {
    for (const i of cells) set.delete(i);
  } else {
    const sb = createSandbox(s, doc);
    const geo = G.getGeom(sb.s, null);
    for (const i of cells) {
      if (!Number.isInteger(i) || i < 0 || i >= N) continue;
      if (geo.chamberAt[i] >= 0 || (geo._resv && geo._resv[i] >= 0) || geo._shaft[i]) continue;
      if (sb.s.run.nest.cells[i] !== CELL.SOIL && sb.s.run.nest.cells[i] !== CELL.TUNNEL) continue;
      set.add(i);
    }
  }
  next.tunnels = [...set].sort((a, b) => a - b);
  return next;
}

/** Layer id of a row. */
function layerAt(y) {
  for (const id of LAYER_ORDER) { const L = LAYERS[id]; if (y >= L.y0 && y <= L.y1) return id; }
  return LAYER_ORDER[LAYER_ORDER.length - 1];
}

/**
 * Open the blueprint editor for saved slot `slot` in the modal host.
 * @param {{ game: Object, modals: Object, toast?: Function }} ctx
 * @param {number} slot
 * @returns {Object|null} modal handle
 */
export function openBlueprintEditor(ctx, slot) {
  const { game, modals } = ctx;
  const s0 = game && game.s;
  if (!s0 || !modals) return null;
  if (fedLevel(s0, 'architects_table') <= 0) return null;
  const saved = arr(s0.era && s0.era.blueprints)[slot];
  if (!saved) return null;
  G.syncCols(s0); // C215: the run's width; a layout saved at another width is moved into it (centred)
  let doc = docFrom(blueprintForCols(saved, nestCols(s0)));
  let dirty = false;
  const st = { tool: 'place', type: firstType(s0), anchor: null, hover: -1, pick: null, grab: { dx: 0, dy: 0 }, soil: true, painting: null, msg: '' };

  const nameIn = h('input', { type: 'text', class: 'input input-small', maxLength: 24, value: doc.name, attrs: { 'aria-label': 'Blueprint name' } });
  nameIn.addEventListener('input', () => { doc.name = nameIn.value; dirty = true; });
  const typeSel = h('select', { class: 'select bp-ed-type', attrs: { 'aria-label': 'Chamber to place' } },
    CHAMBER_ORDER.map((id) => h('option', { value: id, text: nameOf('chamber', id) })));
  typeSel.value = st.type;
  typeSel.addEventListener('change', () => { st.type = typeSel.value; st.tool = 'place'; st.anchor = null; sync(); });
  const tools = {};
  const toolRow = h('div', { class: 'btn-row bp-ed-tools' });
  for (const [id, label, tip] of [['place', 'Place', 'Click to place the chosen chamber (F: other corner).'], ['move', 'Move', 'Click a chamber, then click its new spot.'],
    ['delete', 'Delete', 'Click a chamber to remove it.'], ['tunnel', 'Tunnel', 'Drag to paint tunnels.'], ['erase', 'Erase', 'Drag to erase tunnels.']]) {
    const b = h('button', { type: 'button', class: 'btn btn-small', text: label, dataset: { tip, tool: id }, on: { click: () => { st.tool = id; st.pick = null; sync(); } } });
    tools[id] = b;
    toolRow.appendChild(b);
  }
  const flipBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Corner (F)', on: { click: () => flip() } });
  const soilChk = h('input', { type: 'checkbox', class: 'check', checked: true });
  soilChk.addEventListener('change', () => { st.soil = !!soilChk.checked; draw(); });
  const soilLbl = h('label', { class: 'toggle-row' }, soilChk, h('span', { text: 'Show this run\'s soil' }));
  const status = h('p', { class: 'note bp-ed-status', attrs: { 'aria-live': 'polite' } });
  const canvas = h('canvas', { class: 'bp-ed-canvas', attrs: { 'aria-label': 'Blueprint grid' } });
  const wrap = h('div', { class: 'bp-ed-wrap' }, canvas);
  wrap.style.cssText = 'overflow:auto;max-height:min(62vh,640px);border:1px solid var(--line-soft);border-radius:8px;background:#1c120a;touch-action:pan-y;';
  const head = h('div', { class: 'row-between bp-ed-head' }, nameIn, h('span', { class: 'btn-row' }, typeSel, flipBtn));
  const hint = h('p', { class: 'note', text: 'A sandbox: nothing changes in your colony. Every layer is plain soil here; stones, water and roots differ each run, and the blueprint works around them when it is applied.' });
  const body = h('div', { class: 'bp-ed' }, hint, head, toolRow, soilLbl, wrap, status);

  let cs = 12;
  const dpr = () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  function layout() {
    const avail = Math.max(240, Math.min(720, (wrap.clientWidth || 560) - 2));
    cs = Math.max(6, Math.min(18, Math.floor(avail / COLS)));
    const r = dpr();
    canvas.width = COLS * cs * r;
    canvas.height = ROWS * cs * r;
    canvas.style.width = COLS * cs + 'px';
    canvas.style.height = ROWS * cs + 'px';
  }

  function cellAt(ev) {
    const b = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - b.left) / cs);
    const y = Math.floor((ev.clientY - b.top) / cs);
    return x >= 0 && y >= 0 && x < COLS && y < ROWS ? y * COLS + x : -1;
  }

  function ghostFor(i) {
    if (i < 0) return null;
    const x = i % COLS;
    const y = Math.floor(i / COLS);
    if (st.tool === 'place') return { type: st.type, x, y, chk: checkSpot(game.s, doc, st.type, x, y, { anchor: st.anchor }) };
    if (st.tool === 'move' && st.pick !== null) {
      const type = st.pick === 'royal' ? 'royal_chamber' : doc.chambers[st.pick] && doc.chambers[st.pick].type;
      if (!type) return null;
      const gx = x - st.grab.dx;
      const gy = y - st.grab.dy;
      const c = st.pick === 'royal' ? null : doc.chambers[st.pick];
      const keep = c && c.res ? G.anchorOf(roomOf(c), c.res) : (st.pick === 'royal' && doc.royal && doc.royal.res ? G.anchorOf(royalRoomOf(doc), doc.royal.res) : null);
      return { type, x: gx, y: gy, chk: checkSpot(game.s, doc, type, gx, gy, { anchor: st.anchor || keep || (st.pick === 'royal' ? 'tr' : null), skip: st.pick }) };
    }
    return null;
  }

  function flip() {
    const g = ghostFor(st.hover >= 0 ? st.hover : 0);
    const list = g && g.chk ? g.chk.anchors.map((a) => a.anchor) : [];
    if (list.length < 2) return;
    const cur = st.anchor || (g.chk.anchor) || list[0];
    st.anchor = list[(list.indexOf(cur) + 1) % list.length];
    draw();
  }

  function draw() {
    const g = canvas.getContext && canvas.getContext('2d');
    if (!g) return;
    const r = dpr();
    g.setTransform(r, 0, 0, r, 0, 0);
    // strata
    for (let y = 0; y < ROWS; y++) {
      g.fillStyle = LAYER_COL[layerAt(y)] || '#5d3b24';
      g.fillRect(0, y * cs, COLS * cs, cs);
    }
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= COLS; x++) { g.moveTo(x * cs + 0.5, 0); g.lineTo(x * cs + 0.5, ROWS * cs); }
    for (let y = 0; y <= ROWS; y++) { g.moveTo(0, y * cs + 0.5); g.lineTo(COLS * cs, y * cs + 0.5); }
    g.stroke();
    // this run's soil, faint (stones, revealed water, roots): a reference only
    const live = game.s && game.s.run && game.s.run.nest;
    if (st.soil && live) {
      for (let i = 0; i < N; i++) {
        const c = live.cells[i];
        if (c === CELL.STONE) { g.fillStyle = 'rgba(160,160,170,0.45)'; g.fillRect((i % COLS) * cs + 1, Math.floor(i / COLS) * cs + 1, cs - 2, cs - 2); }
      }
      for (const w of arr(live.features && live.features.water)) {
        if (!w || !w.revealed) continue; // never a pocket the player has not found
        g.fillStyle = 'rgba(80,150,210,0.45)';
        g.fillRect(w.x * cs + 1, w.y * cs + 1, w.w * cs - 2, w.h * cs - 2);
      }
      g.strokeStyle = 'rgba(220,210,150,0.4)';
      g.lineWidth = Math.max(1, cs * 0.12);
      g.beginPath();
      for (const rt of arr(live.features && live.features.roots)) {
        if (!rt) continue;
        g.moveTo((rt.col + 0.5) * cs, rt.y0 * cs);
        g.lineTo((rt.col + 0.5) * cs, (rt.y1 + 1) * cs);
      }
      g.stroke();
    }
    // main shaft and tunnels
    g.fillStyle = 'rgba(30,18,10,0.9)';
    g.fillRect(GRID.mainCol * cs + cs * 0.2, 0, cs * 0.6, GRID.shaftRows * cs);
    g.fillStyle = 'rgba(28,16,8,0.85)';
    for (const i of doc.tunnels) g.fillRect((i % COLS) * cs + cs * 0.15, Math.floor(i / COLS) * cs + cs * 0.15, cs * 0.7, cs * 0.7);
    // chambers: reservation (dashed) and L1 room
    const drawRoom = (type, room, res, sel) => {
      const col = TYPE_COL[type] || '226,196,150';
      if (res) {
        g.fillStyle = 'rgba(' + col + ',0.12)';
        g.fillRect(res.x * cs, res.y * cs, res.w * cs, res.h * cs);
        g.strokeStyle = 'rgba(' + col + ',0.6)';
        g.setLineDash([4, 3]);
        g.lineWidth = 1;
        g.strokeRect(res.x * cs + 0.5, res.y * cs + 0.5, res.w * cs - 1, res.h * cs - 1);
        g.setLineDash([]);
      }
      g.fillStyle = 'rgba(' + col + ',0.75)';
      g.fillRect(room.x * cs + 1, room.y * cs + 1, room.w * cs - 2, room.h * cs - 2);
      g.strokeStyle = sel ? '#ffffff' : 'rgba(20,10,4,0.8)';
      g.lineWidth = sel ? 2 : 1;
      g.strokeRect(room.x * cs + 1, room.y * cs + 1, room.w * cs - 2, room.h * cs - 2);
      if (cs >= 9) {
        g.fillStyle = '#1a0f07';
        g.font = '600 ' + Math.max(8, Math.min(11, cs * 0.75)) + 'px system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText(nameOf('chamber', type).slice(0, Math.max(3, Math.floor(room.w * cs / 6))), room.x * cs + 3, (room.y + room.h / 2) * cs);
      }
    };
    const rr = royalRoomOf(doc);
    drawRoom('royal_chamber', rr, doc.royal && doc.royal.res ? doc.royal.res : royalRes(rr), st.pick === 'royal');
    doc.chambers.forEach((c, j) => drawRoom(c.type, roomOf(c), c.res || null, st.pick === j));
    // ghost
    const gh = ghostFor(st.hover);
    if (gh && gh.chk && gh.chk.rect) {
      const tint = gh.chk.tint === 'green' ? '120,220,120' : gh.chk.tint === 'amber' ? '240,200,90' : '240,90,80';
      const R = gh.chk.res || (gh.chk.anchors.find((a) => a.anchor === gh.chk.anchor) || {}).res;
      if (R) {
        g.strokeStyle = 'rgba(' + tint + ',0.9)';
        g.setLineDash([5, 3]);
        g.strokeRect(R.x * cs + 0.5, R.y * cs + 0.5, R.w * cs - 1, R.h * cs - 1);
        g.setLineDash([]);
      }
      const rc = gh.chk.rect;
      g.fillStyle = 'rgba(' + tint + ',0.45)';
      g.fillRect(rc.x * cs, rc.y * cs, rc.w * cs, rc.h * cs);
    } else if (st.hover >= 0 && (st.tool === 'tunnel' || st.tool === 'erase')) {
      g.strokeStyle = st.tool === 'tunnel' ? 'rgba(255,230,170,0.9)' : 'rgba(255,120,100,0.9)';
      g.strokeRect((st.hover % COLS) * cs + 0.5, Math.floor(st.hover / COLS) * cs + 0.5, cs - 1, cs - 1);
    }
    status.textContent = statusText(gh);
  }

  function statusText(gh) {
    const parts = [];
    if (st.hover >= 0) {
      const y = Math.floor(st.hover / COLS);
      parts.push('Row ' + y + ' · ' + (LAYERS[layerAt(y)] ? LAYERS[layerAt(y)].name : ''));
    }
    if (gh && gh.chk) parts.push(gh.chk.ok ? nameOf('chamber', gh.type) + ': fits here' + (gh.chk.res ? ' (full-size room reserved)' : '') : nameOf('chamber', gh.type) + ': ' + reasonText(gh.chk.reason, 'placeChamber'));
    else if (st.tool === 'move') parts.push(st.pick === null ? 'Click a chamber to move it.' : 'Click its new spot.');
    else if (st.tool === 'delete') parts.push('Click a chamber to remove it.');
    if (st.msg) parts.push(st.msg);
    parts.push(doc.chambers.length + ' chambers, ' + doc.tunnels.length + ' tunnel cells' + (dirty ? ' · unsaved' : ''));
    return parts.join(' — ');
  }

  function sync() {
    for (const id of Object.keys(tools)) toggleClass(tools[id], 'active', st.tool === id);
    setProp(flipBtn, 'disabled', !(st.tool === 'place' || (st.tool === 'move' && st.pick !== null)));
    draw();
  }

  function apply(res) {
    if (res && res.doc) { doc = res.doc; dirty = true; st.msg = ''; return true; }
    st.msg = res && res.reason ? reasonText(res.reason, 'placeChamber') : '';
    return false;
  }

  canvas.addEventListener('pointermove', (ev) => {
    st.hover = cellAt(ev);
    if (st.painting && st.hover >= 0) st.painting.add(st.hover);
    draw();
  });
  canvas.addEventListener('pointerleave', () => { st.hover = -1; draw(); });
  canvas.addEventListener('pointerdown', (ev) => {
    const i = cellAt(ev);
    if (i < 0) return;
    const x = i % COLS;
    const y = Math.floor(i / COLS);
    st.hover = i;
    if (st.tool === 'place') {
      apply(placeIn(game.s, doc, st.type, x, y, st.anchor));
    } else if (st.tool === 'move') {
      if (st.pick === null) {
        const j = chamberAtDoc(doc, x, y);
        if (j !== -1) {
          st.pick = j;
          const room = j === 'royal' ? royalRoomOf(doc) : roomOf(doc.chambers[j]);
          st.grab = { dx: x - room.x, dy: y - room.y };
          st.anchor = null;
        }
      } else if (apply(moveIn(game.s, doc, st.pick, x - st.grab.dx, y - st.grab.dy, st.anchor))) st.pick = null;
    } else if (st.tool === 'delete') {
      const j = chamberAtDoc(doc, x, y);
      if (Number.isInteger(j) && j >= 0) { doc = deleteIn(doc, j); dirty = true; st.msg = ''; } else if (j === 'royal') st.msg = 'The Royal Chamber stays: move it instead.';
    } else if (st.tool === 'tunnel' || st.tool === 'erase') {
      st.painting = new Set([i]);
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* best effort */ }
    }
    ev.preventDefault();
    sync();
  });
  const endPaint = () => {
    if (!st.painting) return;
    doc = paintTunnels(game.s, doc, [...st.painting], st.tool === 'tunnel');
    dirty = true;
    st.painting = null;
    draw();
  };
  canvas.addEventListener('pointerup', endPaint);
  canvas.addEventListener('pointercancel', endPaint);
  const docu = canvas.ownerDocument;
  const onKey = (ev) => {
    const tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (ev.key === 'f' || ev.key === 'F') { flip(); ev.preventDefault(); }
  };
  if (docu) docu.addEventListener('keydown', onKey);

  const handle = modals.open({
    title: 'Edit blueprint', className: 'modal-wide modal-bp-editor', tag: 'bpEditor', body: [body],
    actions: [
      { id: 'cancel', label: 'Close without saving' },
      { id: 'save', label: 'Save blueprint', kind: 'primary', onClick: () => {
        const r = game.actions.do('editBlueprint', { slot, blueprint: { ...doc, name: (nameIn.value || doc.name || 'Layout').slice(0, 24) } });
        if (!r || !r.ok) {
          st.msg = reasonText(r && r.reason, 'editBlueprint');
          draw();
          return false;
        }
        if (typeof ctx.toast === 'function') ctx.toast('Blueprint saved.', 'good');
        dirty = false;
        return true;
      } },
    ],
    onClose: () => { if (docu) docu.removeEventListener('keydown', onKey); },
  });
  layout();
  sync();
  // the modal gets its width once in the page: lay out again on the next frame
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { layout(); draw(); });
  handle.editor = { get doc() { return doc; }, get dirty() { return dirty; } };
  return handle;
}

/** First chamber type worth placing (unlocked in this run), else the Gallery. */
function firstType(s) {
  for (const id of CHAMBER_ORDER) {
    if (id === 'royal_chamber') continue;
    const u = CHAMBERS[id].unlock;
    if (!u || (s.run && s.run.unlocked && s.run.unlocked[u])) return id;
  }
  return 'gallery';
}
