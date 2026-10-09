// Pointer, wheel and keyboard input on the Below canvas → game.actions / uistate (hover, tool completion) / bridge
// (select, openTab, openChooser, hover, contextMenu, reject). Owner: WP8. Contract: ARCHITECTURE §13.7, §14.2, §14.4;
// DESIGN §7.12. Never writes game state directly: every intent goes through game.actions.do().

import { GRID, CELL } from '../data/balance.js';
import { COLS } from '../systems/nestgeom.js';
import * as nestSys from '../systems/nest.js';

// C215: COLS is nestgeom's live binding (the active nest width)
const ROWS = GRID.rows;
const DRAG_PX = 5;
const LONG_PRESS_MS = 550;

function getUI(ui) {
  try {
    if (ui && typeof ui.getUI === 'function') return ui.getUI() || {};
  } catch {
    return {};
  }
  return ui && typeof ui === 'object' ? ui : {};
}

function setUI(ui, patch) {
  try {
    if (ui && typeof ui.setUI === 'function') ui.setUI(patch);
  } catch {
    // UI store unavailable
  }
}

function call(bridge, name, ...args) {
  try {
    if (bridge && typeof bridge[name] === 'function') return bridge[name](...args);
  } catch (err) {
    if (typeof console !== 'undefined') console.warn(`[render] bridge.${name} failed`, err);
  }
  return undefined;
}

function targetKey(t) {
  return t ? `${t.kind}|${t.id ?? ''}|${t.i ?? ''}|${t.hex ?? ''}` : '';
}

/**
 * A 4-connected straight path of diggable-looking cells from an open cell toward `to` (fallback when routeTo is
 * unavailable). Stops before stone and water; skips cells that are already open.
 * @param {number[]} cells
 * @param {number} from
 * @param {number} to
 * @returns {number[]}
 */
export function straightTunnel(cells, from, to) {
  const out = [];
  if (!(from >= 0) || !(to >= 0)) return out;
  let x = from % COLS;
  let y = Math.floor(from / COLS);
  const tx = to % COLS;
  const ty = Math.floor(to / COLS);
  let guard = 0;
  while ((x !== tx || y !== ty) && guard++ < COLS + ROWS) {
    const dx = tx - x;
    const dy = ty - y;
    if (Math.abs(dx) >= Math.abs(dy)) x += Math.sign(dx);
    else y += Math.sign(dy);
    const i = y * COLS + x;
    const c = cells ? cells[i] : CELL.SOIL;
    if (c === CELL.STONE || c === CELL.WATER) break;
    if (c === CELL.TUNNEL || c === CELL.CHAMBER) continue;
    out.push(i);
  }
  return out;
}

/**
 * Attach Below-canvas input.
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('./nestRenderer.js').createNestRenderer>} renderer
 * @param {{ game: any, ui: any, bridge: any }} opts
 * @returns {() => void} detach
 */
export function attachNestInput(canvas, renderer, { game, ui, bridge } = {}) {
  if (!canvas || typeof canvas.addEventListener !== 'function' || !renderer) return () => {};
  const inp = renderer.input || {};
  let down = null;
  let hoverKey = '';
  let longTimer = null;
  const dragMemo = { key: '', res: null };
  /** active touch pointers (pinch zoom) */
  const touches = new Map();
  let pinch = null;

  function pan(dx, dy) {
    if (renderer.panBy) renderer.panBy(dx, dy);
    else if (renderer.scrollBy) renderer.scrollBy(dy);
  }

  try {
    if (canvas.style) canvas.style.touchAction = 'none';
    if (canvas.tabIndex < 0 || canvas.tabIndex === undefined) canvas.tabIndex = 0;
  } catch {
    // ignore
  }

  function local(e) {
    let r = null;
    try {
      r = canvas.getBoundingClientRect();
    } catch {
      r = null;
    }
    return { x: e.clientX - (r ? r.left : 0), y: e.clientY - (r ? r.top : 0) };
  }

  function act(type, args, cx, cy) {
    let res = { ok: false, reason: 'unknown' };
    try {
      if (game && game.actions && typeof game.actions.do === 'function') res = game.actions.do(type, args || {});
      else if (game && game.actions && typeof game.actions[type] === 'function') res = game.actions[type](args || {});
    } catch {
      res = { ok: false, reason: 'invalid' };
    }
    if (!res || !res.ok) call(bridge, 'reject', (res && res.reason) || 'invalid', cx, cy);
    return res || { ok: false, reason: 'invalid' };
  }

  function cellsArr() {
    return game && game.s && game.s.run && game.s.run.nest ? game.s.run.nest.cells || [] : [];
  }

  function isOpen(i) {
    const c = cellsArr()[i];
    return c === CELL.TUNNEL || c === CELL.CHAMBER;
  }

  function chamberByUid(uid) {
    const list = (game && game.s && game.s.run && game.s.run.nest && game.s.run.nest.chambers) || [];
    for (const c of list) if (c && c.uid === uid) return c;
    return null;
  }

  /** Growth direction from a point near/inside a chamber footprint (nearest edge). */
  function dirAt(uid, x, y) {
    const c = chamberByUid(uid);
    const v = renderer.getView ? renderer.getView() : null;
    if (!c || !v) return null;
    const cx = (x - v.ox) / v.cell;
    const cy = (y - v.oy) / v.cell;
    const dl = Math.abs(cx - c.x);
    const dr = Math.abs(cx - (c.x + c.w));
    const du = Math.abs(cy - c.y);
    const dd = Math.abs(cy - (c.y + c.h));
    const m = Math.min(dl, dr, du, dd);
    if (m > Math.max(c.w, c.h) + 2) return null;
    if (m === dl) return 'left';
    if (m === dr) return 'right';
    if (m === du) return 'up';
    return 'down';
  }

  function updateHover(e, p) {
    const ctl = renderer.controlAt ? renderer.controlAt(p.x, p.y) : null;
    inp.ctlHover = ctl;
    if (ctl) {
      inp.hoverCell = -1;
      if (hoverKey !== '') {
        hoverKey = '';
        setUI(ui, { hover: null });
      }
      call(bridge, 'hover', null, e.clientX, e.clientY);
      try {
        if (canvas.style) canvas.style.cursor = 'pointer';
      } catch {
        // ignore
      }
      return;
    }
    try {
      if (canvas.style && canvas.style.cursor === 'pointer') canvas.style.cursor = '';
    } catch {
      // ignore
    }
    const target = renderer.pick(p.x, p.y);
    const cell = renderer.cellAt(p.x, p.y);
    inp.hoverCell = cell ? cell.i : -1;
    const tool = getUI(ui).tool;
    inp.levelDir = tool && tool.kind === 'levelDir' ? dirAt(tool.uid, p.x, p.y) : null;
    if (tool && tool.kind === 'backfill' && !down) inp.backfill = cell ? backfillPreview({ x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y }) : null;
    else if (!down || down.mode !== 'backfill') inp.backfill = null;
    const key = targetKey(target);
    if (key !== hoverKey) {
      hoverKey = key;
      setUI(ui, { hover: target });
    }
    // While placing or relocating, the ghost draws its own label (layer, haul, frost); a cell tooltip on top would hide it.
    const ghostTool = tool && (tool.kind === 'placeChamber' || tool.kind === 'relocate' || tool.kind === 'movePocket' || tool.kind === 'growRoot');
    call(bridge, 'hover', ghostTool ? null : target, e.clientX, e.clientY);
  }

  /**
   * C137: flip which corner of its full-size reserved room the chamber being placed (or relocated) starts in: the next
   * distinct anchor after the current one (F key, right-click or long-press while placing). Returns true if flipped.
   */
  function flipAnchor() {
    const tool = getUI(ui).tool;
    if (!tool || (tool.kind !== 'placeChamber' && tool.kind !== 'relocate')) return false;
    const cell = inp.hoverCell >= 0 ? inp.hoverCell : 0;
    const g = renderer.ghostAt ? renderer.ghostAt(cell, tool) : null;
    const list = g && g.res && Array.isArray(g.res.anchors) ? g.res.anchors.map((a) => a.anchor) : [];
    if (!list.length) return false; // no reservation (it never grows): right-click cancels as before
    if (list.length < 2) return true; // a single possible corner: nothing to flip
    const cur = tool.anchor || (g.res && g.res.anchor) || list[0];
    const k = list.indexOf(cur);
    setUI(ui, { tool: { ...tool, anchor: list[(k + 1) % list.length] } });
    return true;
  }

  /**
   * C256: extend the dragged tunnel path (exactly the cells the pointer crossed, no auto-route) to cell `to`: a
   * straight 4-connected step line from the path's last cell; crossing back onto the path cuts it back to that cell
   * (dragging back undoes).
   */
  function extendPath(path, to) {
    if (!path.length || !(to >= 0)) return path;
    let cur = path[path.length - 1];
    if (cur === to) return path;
    const tx = to % COLS;
    const ty = Math.floor(to / COLS);
    let guard = 0;
    while (cur !== to && guard++ < COLS + ROWS) {
      let x = cur % COLS;
      let y = Math.floor(cur / COLS);
      const dx = tx - x;
      const dy = ty - y;
      if (Math.abs(dx) >= Math.abs(dy)) x += Math.sign(dx);
      else y += Math.sign(dy);
      cur = y * COLS + x;
      const k = path.indexOf(cur);
      if (k >= 0) path.length = k + 1;
      else path.push(cur);
    }
    return path;
  }

  /** C256: preview of the free-drawn path (nest.tunnelPath: cut at the first cell a tunnel cannot cross, with why). */
  function freePreview(path) {
    const s = game && game.s;
    const d = game && game.d;
    if (!s || !path || path.length < 2) return null;
    const key = `free|${path.join(',')}|${s.run.nest.rev}|${s.run.nest.queue.length}`;
    if (dragMemo.key === key) return dragMemo.res;
    let r = null;
    try {
      r = nestSys.tunnelPath(s, d, path);
    } catch {
      r = null;
    }
    const res = r
      ? { cells: r.soil.slice(), path: r.path.slice(), ok: r.ok, reason: r.reason, work: r.work || r.soil.length }
      : { cells: [], path: [], ok: false, reason: 'invalid', work: 0 };
    dragMemo.key = key;
    dragMemo.res = res;
    return res;
  }

  function clearPreviews() {
    inp.drag = null;
    inp.rect = null;
    inp.backfill = null;
  }

  /**
   * Backfill tool preview (C98): the tunnel cells of a painted rectangle split by nest.backfillPreview into fillable
   * (ok), refused (bad, with the reason) and already filling (pending). Memoized per rectangle and nest revision.
   */
  const bfMemo = { key: '', res: null };
  function backfillPreview(r) {
    const s = game && game.s;
    if (!s || !r) return null;
    const x0 = Math.max(0, Math.min(r.x0, r.x1));
    const x1 = Math.min(COLS - 1, Math.max(r.x0, r.x1));
    const y0 = Math.max(0, Math.min(r.y0, r.y1));
    const y1 = Math.min(ROWS - 1, Math.max(r.y0, r.y1));
    const key = `${x0}|${y0}|${x1}|${y1}|${s.run.nest.rev}|${(s.run.nest.backfill || []).length}`;
    if (bfMemo.key === key && bfMemo.res) return bfMemo.res;
    const list = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) list.push(y * COLS + x);
    let res = null;
    try {
      res = nestSys.backfillPreview(s, game.d, list);
    } catch {
      res = null;
    }
    if (!res) {
      const arr = cellsArr();
      res = { ok: list.filter((i) => arr[i] === CELL.TUNNEL), bad: [], pending: [] };
    }
    bfMemo.key = key;
    bfMemo.res = { x0, y0, x1, y1, ok: res.ok || [], bad: res.bad || [], pending: res.pending || [] };
    return bfMemo.res;
  }

  function onDown(e) {
    if (e.button === 2) return;
    const p = local(e);
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: p.x, y: p.y });
      if (touches.size === 2) {
        // second finger: pinch zoom + two-finger pan; drop any tunnel / long-press in progress
        if (longTimer) {
          clearTimeout(longTimer);
          longTimer = null;
        }
        down = null;
        clearPreviews();
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        return;
      }
      if (touches.size > 2) return;
    }
    const ctl = renderer.controlAt ? renderer.controlAt(p.x, p.y) : null;
    if (ctl) {
      down = { x: p.x, y: p.y, lastX: p.x, lastY: p.y, cx: e.clientX, cy: e.clientY, cell: null, target: null, mode: 'control', ctl, moved: false, id: e.pointerId };
      return;
    }
    const tool = getUI(ui).tool;
    const cell = renderer.cellAt(p.x, p.y);
    const target = renderer.pick(p.x, p.y);
    let mode = 'scroll';
    if (tool && tool.kind === 'backfill' && cell) mode = 'backfill';
    else if (!tool && cell && isOpen(cell.i) && target && (target.kind === 'cell' || target.kind === 'shaft' || target.kind === 'chamber' || target.kind === 'nursery')) mode = 'tunnelCandidate';
    down = { x: p.x, y: p.y, lastX: p.x, lastY: p.y, cx: e.clientX, cy: e.clientY, cell, target, mode, moved: false, id: e.pointerId };
    if (mode === 'backfill') {
      inp.rect = { x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y };
      inp.backfill = backfillPreview(inp.rect);
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (e.pointerType === 'touch' && typeof setTimeout === 'function') {
      longTimer = setTimeout(() => {
        longTimer = null;
        if (down && !down.moved) {
          const t = down.target;
          down = null;
          clearPreviews();
          if (flipAnchor()) return; // C137: long-press while placing flips the start corner
          if (getUI(ui).tool) setUI(ui, { tool: null });
          else call(bridge, 'contextMenu', t, e.clientX, e.clientY);
        }
      }, LONG_PRESS_MS);
    }
  }

  function onMove(e) {
    const p = local(e);
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: p.x, y: p.y });
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        pan(-(mx - pinch.mx), -(my - pinch.my));
        if (renderer.zoomAt) renderer.zoomAt(dist / pinch.d, mx, my);
        pinch = { d: dist, mx, my };
        return;
      }
    }
    if (!down || e.pointerType === 'mouse') updateHover(e, p);
    if (!down) return;
    if (down.mode === 'control') return;
    if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > DRAG_PX) {
      down.moved = true;
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = null;
      }
      if (down.mode === 'tunnelCandidate') {
        down.mode = 'tunnel';
        down.path = down.cell ? [down.cell.i] : []; // C256: the dragged cells, starting on the open cell
      }
    }
    if (!down.moved) return;
    if (down.mode === 'scroll') {
      pan(-(p.x - down.lastX), -(p.y - down.lastY));
      down.lastX = p.x;
      down.lastY = p.y;
    } else if (down.mode === 'tunnel') {
      const cell = renderer.cellAt(p.x, p.y);
      if (cell && down.path && down.path.length) {
        extendPath(down.path, cell.i);
        inp.drag = freePreview(down.path);
      } else inp.drag = null;
    } else if (down.mode === 'backfill') {
      const cell = renderer.cellAt(p.x, p.y);
      if (cell && inp.rect) {
        inp.rect.x1 = cell.x;
        inp.rect.y1 = cell.y;
        inp.backfill = backfillPreview(inp.rect);
      }
    }
  }

  function onUp(e) {
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
    }
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (pinch) {
        if (touches.size < 2) pinch = null;
        down = null;
        return;
      }
    }
    if (!down) return;
    const dn = down;
    down = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (dn.mode === 'control') {
      if (renderer.controlAt && renderer.pressControl && renderer.controlAt(local(e).x, local(e).y) === dn.ctl) renderer.pressControl(dn.ctl);
      return;
    }
    if (dn.mode === 'tunnel' && dn.moved) {
      const prev = inp.drag;
      inp.drag = null;
      // C256: digs exactly the dragged cells (up to the first one a tunnel cannot cross); when the drag was cut short,
      // the reason is shown (stone, water, a reserved room …) instead of silently routing around it
      if (prev && prev.ok && prev.cells.length) {
        act('digTunnel', { cells: prev.path.slice() }, e.clientX, e.clientY);
        if (prev.reason) call(bridge, 'reject', prev.reason, e.clientX, e.clientY);
      } else if (prev && prev.reason) call(bridge, 'reject', prev.reason, e.clientX, e.clientY);
      return;
    }
    if (dn.mode === 'backfill') {
      const r = inp.rect;
      inp.rect = null;
      inp.backfill = null;
      if (r) {
        // C98: only the fillable cells are sent (shaft cells, cells a chamber still needs and soil are skipped), and the
        // tool stays on for the next stroke (Esc, right-click or the Backfill button ends it).
        const pv = backfillPreview(r);
        const cells = pv ? pv.ok.slice() : [];
        if (cells.length) act('backfill', { cells }, e.clientX, e.clientY);
        else if (pv && pv.bad.length) call(bridge, 'reject', pv.bad[0].reason === 'blocked:shaft' ? 'blocked:shaft' : 'blocked:disconnect', e.clientX, e.clientY);
        else if (pv && pv.pending.length) call(bridge, 'reject', 'invalid:pending', e.clientX, e.clientY);
        else call(bridge, 'reject', 'invalid:cell', e.clientX, e.clientY);
      }
      return;
    }
    if (dn.moved) return;
    click(dn, e);
  }

  function click(dn, e) {
    const tool = getUI(ui).tool;
    const t = dn.target;
    const cx = e.clientX;
    const cy = e.clientY;
    if (tool) {
      if ((tool.kind === 'placeChamber' || tool.kind === 'relocate') && dn.cell) {
        const g = renderer.ghostAt ? renderer.ghostAt(dn.cell.i, tool) : null;
        if (!g) return;
        const route = g.res && Array.isArray(g.res.route) && g.res.route.length ? { route: g.res.route.slice() } : {};
        // C137: the corner shown by the ghost (F / right-click) is the one reserved
        const anc = g.res && g.res.anchor ? { anchor: g.res.anchor } : {};
        const res = tool.kind === 'placeChamber'
          ? act('placeChamber', { chamber: tool.chamber, x: g.x, y: g.y, ...route, ...anc }, cx, cy)
          : act('relocateChamber', { uid: tool.uid, x: g.x, y: g.y, ...route, ...anc }, cx, cy);
        if (res.ok) setUI(ui, { tool: null });
        return;
      }
      // C117 / C118: move a water pocket to the ghost spot; grow a cultivated root down the clicked column
      if ((tool.kind === 'movePocket' || tool.kind === 'growRoot') && dn.cell) {
        const g = renderer.ghostAt ? renderer.ghostAt(dn.cell.i, tool) : null;
        if (!g) return;
        const res = tool.kind === 'growRoot'
          ? act('growRoot', { col: g.col }, cx, cy)
          : act('relocatePocket', { pocket: tool.pocket, x: g.x, y: g.y }, cx, cy);
        if (res.ok) setUI(ui, { tool: null });
        return;
      }
      if (tool.kind === 'levelDir') {
        const dir = dirAt(tool.uid, dn.x, dn.y);
        if (!dir) {
          setUI(ui, { tool: null });
          return;
        }
        const res = act('levelChamber', { uid: tool.uid, dir }, cx, cy);
        if (res.ok) setUI(ui, { tool: null });
        return;
      }
      return;
    }
    if (!t) {
      call(bridge, 'select', null);
      return;
    }
    switch (t.kind) {
      case 'chamber':
        call(bridge, 'select', t);
        call(bridge, 'openTab', 'build', 'inspect');
        break;
      case 'nursery':
        call(bridge, 'select', t);
        act('groomBrood', { chamber: t.id }, cx, cy);
        call(bridge, 'openTab', 'build', 'inspect');
        break;
      case 'queen':
        act('clickQueen', {}, cx, cy);
        call(bridge, 'select', t);
        call(bridge, 'openTab', 'build', 'inspect');
        break;
      case 'digFace':
        act('helpDig', {}, cx, cy);
        break;
      case 'pupa':
        call(bridge, 'openChooser', 'pupa', {});
        break;
      // C216: the "house full" pip opens the Build tab (Galleries add housing)
      case 'housePip':
        call(bridge, 'openTab', 'build');
        break;
      case 'mold':
        act('scrapeMold', { uid: t.id }, cx, cy);
        break;
      // C290: the treasure mole's cache: collect it
      case 'moleCache':
        act('clickEventObject', { uid: t.id }, cx, cy);
        break;
      case 'flood':
        act('bailFlood', {}, cx, cy);
        break;
      // C245: a blighted Fungus Garden: each click scrapes the blight (the first one also picks "Clean" on the card)
      case 'blight':
        act('cleanBlight', {}, cx, cy);
        break;
      case 'cacheHint':
        act('digTo', { cell: t.i }, cx, cy);
        break;
      // C120 / C117: a planned blueprint chamber (cancel it) or a water pocket (drain / move it) opens the inspect view
      case 'planned':
      case 'pocket':
        call(bridge, 'select', t);
        call(bridge, 'openTab', 'build', 'inspect');
        break;
      default:
        call(bridge, 'select', t);
        break;
    }
  }

  function onCancel(e) {
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
    }
    if (e && e.pointerType === 'touch') touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    down = null;
    clearPreviews();
  }

  function onContext(e) {
    if (e.preventDefault) e.preventDefault();
    const p = local(e);
    // C257: right-click while relocating cancels the relocation (like Q puts the placing tool away; F still flips the
    // corner, and a touch long-press too). C137: right-click while placing flips the corner it starts in (Esc cancels).
    const cur = getUI(ui).tool;
    if (cur && cur.kind === 'relocate') {
      setUI(ui, { tool: null });
      clearPreviews();
      return;
    }
    if (flipAnchor()) return;
    if (getUI(ui).tool) {
      setUI(ui, { tool: null });
      clearPreviews();
      return;
    }
    call(bridge, 'contextMenu', renderer.pick(p.x, p.y), e.clientX, e.clientY);
  }

  /** Wheel scrolls; Ctrl/⌘ + wheel (and trackpad pinch) zooms at the cursor; Shift + wheel or a sideways swipe pans. */
  function onWheel(e) {
    if (e.preventDefault) e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = (e.deltaY || 0) * k;
    const dx = (e.deltaX || 0) * k;
    if ((e.ctrlKey || e.metaKey) && renderer.zoomAt) {
      const p = local(e);
      renderer.zoomAt(Math.exp(-clampNum(dy, -120, 120) * 0.0035), p.x, p.y);
      return;
    }
    if (e.shiftKey && !dx) {
      pan(dy, 0);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) pan(dx, 0);
    else if (renderer.scrollBy) renderer.scrollBy(dy);
  }

  function clampNum(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function onLeave(e) {
    inp.hoverCell = -1;
    inp.levelDir = null;
    inp.ctlHover = null;
    if (!down || down.mode !== 'backfill') inp.backfill = null;
    if (hoverKey !== '') {
      hoverKey = '';
      setUI(ui, { hover: null });
    }
    call(bridge, 'hover', null, e ? e.clientX : 0, e ? e.clientY : 0);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (getUI(ui).tool) setUI(ui, { tool: null });
      clearPreviews();
      down = null;
      return;
    }
    let focused = false;
    try {
      focused = typeof document !== 'undefined' && document.activeElement === canvas;
    } catch {
      focused = false;
    }
    // C137: F flips the start corner of the chamber being placed (any focus but a text field)
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      let typing = false;
      try {
        const a = typeof document !== 'undefined' ? document.activeElement : null;
        const tag = a && typeof a.tagName === 'string' ? a.tagName.toLowerCase() : '';
        typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (a && a.isContentEditable === true);
      } catch {
        typing = false;
      }
      if (!typing && flipAnchor()) {
        if (e.preventDefault) e.preventDefault();
        return;
      }
    }
    if (focused && (e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = getUI(ui).tool;
      setUI(ui, { tool: t && t.kind === 'backfill' ? null : { kind: 'backfill' } });
      clearPreviews();
      return;
    }
    if (!focused || !renderer.scrollBy) return;
    const v = renderer.getView ? renderer.getView() : { cell: 12, H: 300 };
    const step = { ArrowDown: v.cell * 2, ArrowUp: -v.cell * 2, PageDown: v.H * 0.8, PageUp: -v.H * 0.8 }[e.key];
    if (step) {
      if (e.preventDefault) e.preventDefault();
      renderer.scrollBy(step);
      return;
    }
    const side = { ArrowLeft: -v.cell * 2, ArrowRight: v.cell * 2 }[e.key];
    if (side) {
      if (e.preventDefault) e.preventDefault();
      pan(side, 0);
      return;
    }
    const ctl = { '+': 'in', '=': 'in', '-': 'out', _: 'out', Home: 'home', 0: 'home' }[e.key];
    if (ctl && renderer.pressControl) {
      if (e.preventDefault) e.preventDefault();
      renderer.pressControl(ctl);
    }
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const win = typeof window !== 'undefined' ? window : null;
  if (win && win.addEventListener) win.addEventListener('keydown', onKey);

  return function detach() {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('wheel', onWheel);
    if (win && win.removeEventListener) win.removeEventListener('keydown', onKey);
    if (longTimer) clearTimeout(longTimer);
    clearPreviews();
  };
}
