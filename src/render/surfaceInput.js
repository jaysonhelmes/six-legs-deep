// Pointer, wheel, pinch and keyboard input on the Above canvas → game.actions / uistate (hover, tool completion) /
// bridge (select, openTab, openChooser, hover, contextMenu, reject). Pan by dragging empty ground, zoom by wheel or
// pinch, drag from a trail origin to draw a trail (onto a rival nest / prey / termite mound: the war chooser).
// Owner: WP8. Contract: ARCHITECTURE §13.7, §14.2, §14.4; DESIGN §8.10, §25.4. Never writes game state directly.

import { lineHexes } from '../core/hex.js';
import * as trailsSys from '../systems/trails.js';
import { WAR_SOURCES } from './surfaceRenderer.js';
import { reasonLabel } from './nestRenderer.js';

const DRAG_PX = 6;
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
  return t ? `${t.kind}|${t.id ?? ''}|${t.hex ?? ''}` : '';
}

/**
 * War-chooser spec for dropping a drag on a hex: rival nest → raid, prey → hunt, termite mound → termite; else null.
 * @param {any} s
 * @param {number} hex
 * @returns {{ kind: string, target: { type: string, uid: number } } | null}
 */
export function warSpecAt(s, hex) {
  if (!s || !(hex >= 0)) return null;
  for (const rv of (s.run && s.run.rivals && s.run.rivals.list) || []) {
    if (rv && rv.alive && rv.hex === hex && (rv.sighted || (s.run.surface.revealed && s.run.surface.revealed[hex]))) {
      return { kind: 'raid', target: { type: 'rival', uid: rv.uid } };
    }
  }
  for (const src of (s.run && s.run.surface && s.run.surface.sources) || []) {
    if (!src || src.hex !== hex || !WAR_SOURCES.has(src.type)) continue;
    if (!(s.run.surface.revealed && s.run.surface.revealed[hex])) continue;
    return { kind: src.type === 'termite_mound' ? 'termite' : 'hunt', target: { type: 'source', uid: src.uid } };
  }
  return null;
}

/**
 * Attach Above-canvas input.
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('./surfaceRenderer.js').createSurfaceRenderer>} renderer
 * @param {{ game: any, ui: any, bridge: any }} opts
 * @returns {() => void} detach
 */
export function attachSurfaceInput(canvas, renderer, { game, ui, bridge } = {}) {
  if (!canvas || typeof canvas.addEventListener !== 'function' || !renderer) return () => {};
  const inp = renderer.input || {};
  const pointers = new Map();
  let down = null;
  let pinch = null;
  let hoverKey = '';
  let longTimer = null;
  const prevMemo = { key: '', res: null };

  try {
    if (canvas.style) canvas.style.touchAction = 'none';
    if (canvas.tabIndex < 0 || canvas.tabIndex === undefined) canvas.tabIndex = 0;
  } catch {
    // ignore
  }

  function S() {
    return game && game.s ? game.s : null;
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

  /** Trail origins: trails.trailOrigins when available, else every entrance hex. */
  function origins() {
    const s = S();
    if (!s) return [];
    let list = [];
    try {
      list = trailsSys.trailOrigins(s, game.d) || [];
    } catch {
      list = [];
    }
    if (!list.length) list = (s.run.surface.entrances || []).filter((e) => e && e.hex >= 0).map((e) => e.hex);
    return list;
  }

  function sourceAtHex(hex) {
    const s = S();
    for (const src of (s && s.run.surface.sources) || []) if (src && src.hex === hex) return src;
    return null;
  }

  function preview(origin, target, waypoints = []) {
    const s = S();
    if (!s) return null;
    const key = `${origin}|${target}|${waypoints.join(',')}|${s.run.surface.rev}`;
    if (prevMemo.key === key) return prevMemo.res;
    let res = null;
    try {
      res = trailsSys.previewTrail(s, game.d, origin, target, waypoints);
    } catch {
      res = null;
    }
    let path = res && Array.isArray(res.path) && res.path.length ? res.path.slice() : null;
    if (!path) {
      // display-only fallback through the waypoints
      path = [];
      const stops = [origin, ...waypoints, target];
      for (let k = 0; k + 1 < stops.length; k++) {
        const seg = lineHexes(stops[k], stops[k + 1]);
        for (const h of seg) if (path[path.length - 1] !== h) path.push(h);
      }
    }
    const src = sourceAtHex(target);
    const ok = !!(res && res.ok) && !!src;
    let label = '';
    if (ok) {
      const len = Number(res.len);
      const per = Number(res.perWorker);
      label = `d ${Number.isFinite(len) ? len.toFixed(1) : '?'}${Number.isFinite(per) ? ` · ${per.toFixed(2)}/ant` : ''}${Number.isFinite(res.cap) ? ` · cap ${Math.round(res.cap)}` : ''}`;
    } else if (!src) label = 'No source here';
    else label = reasonLabel((res && res.reason) || 'invalid');
    prevMemo.key = key;
    prevMemo.res = { path, ok, label, res };
    return prevMemo.res;
  }

  function updateHover(e, p) {
    const target = renderer.pick(p.x, p.y);
    inp.hoverHex = renderer.hexAt(p.x, p.y);
    const key = targetKey(target);
    if (key !== hoverKey) {
      hoverKey = key;
      setUI(ui, { hover: target });
    }
    call(bridge, 'hover', target, e.clientX, e.clientY);
  }

  function clearPreviews() {
    inp.trailDrag = null;
    inp.reroute = null;
    inp.warDrag = null;
  }

  function onDown(e) {
    const p = local(e);
    pointers.set(e.pointerId, p);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      down = null;
      clearPreviews();
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = null;
      }
      return;
    }
    if (e.button === 2) return;
    const tool = getUI(ui).tool;
    const target = renderer.pick(p.x, p.y);
    const hex = renderer.hexAt(p.x, p.y);
    let mode = 'pan';
    if (tool && tool.kind === 'reroute') mode = 'reroute';
    // C110: a press on a trail origin is always an origin candidate, whatever is picked on top of it (an event object
    // such as the myrmecophile guest / wandering queen / footstep / army column sitting on the entrance, a gift, the
    // beetle, a party marker…): a drag past DRAG_PX draws a trail; a release without a drag still runs click() on it.
    else if (!tool && hex >= 0 && origins().includes(hex)) mode = 'originCandidate';
    down = { x: p.x, y: p.y, lx: p.x, ly: p.y, target, hex, mode, moved: false, visited: [hex], id: e.pointerId };
    if (e.pointerType === 'touch' && typeof setTimeout === 'function') {
      longTimer = setTimeout(() => {
        longTimer = null;
        if (down && !down.moved) {
          const t = down.target;
          down = null;
          clearPreviews();
          if (getUI(ui).tool) setUI(ui, { tool: null });
          else call(bridge, 'contextMenu', t, e.clientX, e.clientY);
        }
      }, LONG_PRESS_MS);
    }
  }

  function onMove(e) {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (renderer.panBy) renderer.panBy(mx - pinch.mx, my - pinch.my);
      if (renderer.zoomAt) renderer.zoomAt(dist / pinch.dist, mx, my);
      pinch = { dist, mx, my };
      return;
    }
    if (!down || e.pointerType === 'mouse') updateHover(e, p);
    if (!down) return;
    if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > DRAG_PX) {
      down.moved = true;
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = null;
      }
      if (down.mode === 'originCandidate') down.mode = 'drag';
    }
    if (!down.moved) return;
    const s = S();
    if (down.mode === 'pan') {
      if (renderer.panBy) renderer.panBy(p.x - down.lx, p.y - down.ly);
    } else if (down.mode === 'drag') {
      const hex = renderer.hexAt(p.x, p.y);
      const war = warSpecAt(s, hex);
      if (war) {
        inp.trailDrag = null;
        inp.warDrag = { from: down.hex, to: hex, ok: true };
      } else if (hex >= 0 && hex !== down.hex) {
        inp.warDrag = null;
        const pr = preview(down.hex, hex);
        inp.trailDrag = pr ? { path: pr.path, ok: pr.ok, label: pr.label } : null;
      } else {
        inp.trailDrag = null;
        inp.warDrag = { from: down.hex, to: down.hex, toPt: { x: p.x, y: p.y }, ok: false };
      }
    } else if (down.mode === 'reroute') {
      const hex = renderer.hexAt(p.x, p.y);
      if (hex >= 0 && down.visited[down.visited.length - 1] !== hex) down.visited.push(hex);
      const tool = getUI(ui).tool;
      const tr = s && (s.run.surface.trails || []).find((t) => t && t.uid === tool.uid);
      if (tr) {
        const wps = waypointsFrom(down.visited);
        const src = (s.run.surface.sources || []).find((x) => x && x.uid === tr.src);
        const targetHex = src ? src.hex : tr.path[tr.path.length - 1];
        const pr = preview(tr.origin, targetHex, wps);
        inp.reroute = { uid: tr.uid, waypoints: wps, path: pr ? pr.path : [] };
      }
    }
    down.lx = p.x;
    down.ly = p.y;
  }

  function waypointsFrom(visited) {
    const v = visited.filter((h) => h >= 0);
    const out = [];
    for (let k = 2; k < v.length; k += 3) out.push(v[k]);
    if (v.length && out[out.length - 1] !== v[v.length - 1]) out.push(v[v.length - 1]);
    return out.slice(0, 8);
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
    }
    if (!down) return;
    const dn = down;
    down = null;
    const s = S();
    const p = local(e);
    if (dn.mode === 'drag' && dn.moved) {
      const hex = renderer.hexAt(p.x, p.y);
      const war = warSpecAt(s, hex);
      const td = inp.trailDrag;
      clearPreviews();
      if (war) {
        call(bridge, 'openChooser', 'war', { kind: war.kind, target: war.target });
        return;
      }
      if (hex >= 0 && hex !== dn.hex) {
        if (!sourceAtHex(hex)) {
          call(bridge, 'reject', 'invalid', e.clientX, e.clientY);
          return;
        }
        act('drawTrail', { origin: dn.hex, target: hex }, e.clientX, e.clientY);
      }
      void td;
      return;
    }
    if (dn.mode === 'reroute') {
      const rr = inp.reroute;
      clearPreviews();
      if (dn.moved && rr && rr.waypoints.length) {
        const res = act('rerouteTrail', { uid: rr.uid, waypoints: rr.waypoints.slice() }, e.clientX, e.clientY);
        if (res.ok) setUI(ui, { tool: null });
      }
      return;
    }
    if (dn.moved) return;
    click(dn, e);
  }

  function click(dn, e) {
    const s = S();
    const tool = getUI(ui).tool;
    const t = dn.target;
    const hex = dn.hex;
    const cx = e.clientX;
    const cy = e.clientY;
    if (tool) {
      if (hex < 0) return;
      switch (tool.kind) {
        case 'claim':
          act('claimHex', { hex }, cx, cy);
          return;
        case 'flag': {
          const flagged = (s && s.run.surface.flagged) || [];
          act('flagHex', { hex, on: !flagged.includes(hex) }, cx, cy);
          return;
        }
        case 'placeSatellite': {
          // F15: a hex the placeSatellite validator would refuse is refused here, with its reason, before the column
          // chooser opens; the tool stays active for another try
          const why = typeof renderer.satelliteAt === 'function' ? renderer.satelliteAt(hex) : null;
          if (why) {
            call(bridge, 'reject', why, cx, cy);
            return;
          }
          call(bridge, 'openChooser', 'satelliteColumn', { hex });
          setUI(ui, { tool: null });
          return;
        }
        case 'moveAphids': {
          const res = act('moveAphids', { src: tool.src, hex }, cx, cy);
          if (res.ok) setUI(ui, { tool: null });
          return;
        }
        case 'tournament': {
          // ARCH-R: the tool object may carry the chosen units (minor/soldier/supermajor); 0 when absent.
          const res = act('tournament', { rival: tool.rival, hex, minor: tool.minor || 0, soldier: tool.soldier || 0, supermajor: tool.supermajor || 0 }, cx, cy);
          if (res.ok) setUI(ui, { tool: null });
          return;
        }
        default:
          return;
      }
    }
    if (!t) {
      call(bridge, 'select', null);
      return;
    }
    switch (t.kind) {
      case 'beetle':
        act('clickBeetle', {}, cx, cy);
        break;
      case 'gift':
        act('openGift', { index: t.id }, cx, cy);
        break;
      case 'eventObject':
        act('clickEventObject', { uid: t.id }, cx, cy);
        break;
      case 'rival':
        call(bridge, 'select', t);
        call(bridge, 'openTab', 'map', 'war');
        break;
      case 'source': {
        const src = (s.run.surface.sources || []).find((x) => x && x.uid === t.id);
        if (src && WAR_SOURCES.has(src.type)) {
          call(bridge, 'select', t);
          call(bridge, 'openTab', 'map', 'war');
        } else if (src && src.type === 'lycaenid_caterpillar') {
          call(bridge, 'select', t);
        } else {
          act('clickForage', { src: t.id }, cx, cy);
          call(bridge, 'select', t);
        }
        break;
      }
      default:
        call(bridge, 'select', t);
        break;
    }
  }

  function onCancel(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
    }
    down = null;
    clearPreviews();
  }

  function onContext(e) {
    if (e.preventDefault) e.preventDefault();
    const p = local(e);
    if (getUI(ui).tool) {
      setUI(ui, { tool: null });
      clearPreviews();
      return;
    }
    call(bridge, 'contextMenu', renderer.pick(p.x, p.y), e.clientX, e.clientY);
  }

  function onWheel(e) {
    if (e.preventDefault) e.preventDefault();
    const p = local(e);
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (renderer.zoomAt) renderer.zoomAt(Math.exp(-e.deltaY * k * 0.0015), p.x, p.y);
  }

  function onLeave(e) {
    inp.hoverHex = -1;
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
    if (!focused) return;
    const pan = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
    if (pan && renderer.panBy) {
      if (e.preventDefault) e.preventDefault();
      renderer.panBy(pan[0], pan[1]);
    } else if ((e.key === '+' || e.key === '=') && renderer.zoomAt) {
      const c = renderer.getCamera ? renderer.getCamera() : { cx: 0, cy: 0 };
      renderer.zoomAt(1.15, c.cx, c.cy);
    } else if ((e.key === '-' || e.key === '_') && renderer.zoomAt) {
      const c = renderer.getCamera ? renderer.getCamera() : { cx: 0, cy: 0 };
      renderer.zoomAt(1 / 1.15, c.cx, c.cy);
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
