// Battle bubbles: two clusters of ≤ 40 sprites per side in proportion to the surviving counts; ants lunge, fallen
// sprites stay 5 s as corpses and then become chitin glints carried home. Also the gate fight drawn in the Below shaft.
// Owner: WP8. Contract: ARCHITECTURE §13.5 (render/battle.js), DESIGN §9.9, §9.10.

import { BATTLE } from '../data/combat.js';
import { BUDGET } from './sprites.js';
import { getAtlas } from './atlas.js';
import { rgba, rivalColor } from './palette.js';
import { hash01 } from './geom.js';

/** Battles drawn with full sprite clusters at once (the rest show a compact bubble), keeping the 600 hard cap. */
export const MAX_SPRITE_BATTLES = 2;
const CORPSE_SEC = (BATTLE && BATTLE.corpseSec) || 5;

/** Sprites shown for a side: real count up to 40, then proportional to survivors of the starting count. */
export function shownCount(now, start, cap = BUDGET.battleSide) {
  const n = Math.max(0, Number(now) || 0);
  const st = Math.max(n, Number(start) || 0);
  if (st <= cap) return Math.round(n);
  return Math.max(n > 0 ? 1 : 0, Math.round((cap * n) / st));
}

function sideTotal(side) {
  if (!side) return 0;
  if (Number.isFinite(side.n)) return side.n;
  return (side.militia || 0) + (side.soldier || 0) + (side.supermajor || 0);
}

function startTotal(b, key) {
  const st = b && b.start ? b.start[key] : null;
  if (Number.isFinite(st)) return st;
  if (st && typeof st === 'object') return sideTotal(st);
  return sideTotal(b ? b[key] : null);
}

/**
 * Create the battle-bubble view for the Above canvas.
 */
export function createBattleBubbles() {
  /** @type {Map<number, any>} */
  const views = new Map();
  let t = 0;

  function makeSide(n, seed) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(newSprite(i, seed));
    return out;
  }

  function newSprite(i, seed) {
    const r = Math.sqrt(i + 0.5) * 3.4;
    const a = i * 2.399963 + seed;
    return { bx: Math.cos(a) * r, by: Math.sin(a) * r * 0.8, ph: hash01(i, seed * 13) * 6.28, kind: i % 7 === 0 ? 'supermajor' : 'soldier' };
  }

  /**
   * Reconcile with the live battles.
   * @param {any} s
   * @param {{ glint?: (x:number,y:number,tx:number,ty:number)=>void }} [fx]
   * @param {(hex:number)=>{x:number,y:number}} [hexToScreen]
   */
  function sync(s, fx, hexToScreen) {
    const list = (s && s.run && s.run.war && s.run.war.battles) || [];
    const live = new Set();
    let spriteBattles = 0;
    // a gate fight in the Below shaft (≤ 24 sprites) takes one battle slot, so all views stay under the 600 hard cap
    const maxFull = MAX_SPRITE_BATTLES - (list.some((b) => b && b.below) ? 1 : 0);
    for (const b of list) {
      if (!b || b.below || !(b.hex >= 0)) continue;
      live.add(b.uid);
      let v = views.get(b.uid);
      const full = spriteBattles < maxFull;
      if (full) spriteBattles++;
      const youN = full ? shownCount(sideTotal(b.you), startTotal(b, 'you')) : 0;
      const foeN = full ? shownCount(sideTotal(b.foe), startTotal(b, 'foe')) : 0;
      if (!v) {
        v = { uid: b.uid, hex: b.hex, you: makeSide(youN, 1), foe: makeSide(foeN, 2), corpses: [], born: t, full, rival: b.raid || 0 };
        views.set(b.uid, v);
      }
      v.hex = b.hex;
      v.full = full;
      v.youCount = sideTotal(b.you);
      v.foeCount = sideTotal(b.foe);
      v.kind = b.kind;
      v.rally = b.rally > 0;
      trim(v, 'you', youN, hexToScreen);
      trim(v, 'foe', foeN, hexToScreen);
    }
    for (const [uid, v] of views) {
      if (live.has(uid)) continue;
      // battle over: survivors vanish, corpses keep fading and then glint home
      if (!v.ended) {
        v.ended = t;
        for (const sp of v.you.concat(v.foe)) v.corpses.push({ x: sp.bx, y: sp.by, at: t, kind: sp.kind, foe: false, gone: true });
        v.you = [];
        v.foe = [];
      }
      if (t - v.ended > CORPSE_SEC + 0.5) {
        if (fx && fx.glint && hexToScreen) {
          const p = hexToScreen(v.hex);
          const home = hexToScreen(0);
          for (let k = 0; k < Math.min(6, v.corpses.length); k++) fx.glint(p.x + v.corpses[k].x, p.y + v.corpses[k].y, home.x, home.y);
        }
        views.delete(uid);
      }
    }
  }

  function trim(v, key, n, hexToScreen) {
    const arr = v[key];
    while (arr.length > n) {
      const k = Math.floor(Math.random() * arr.length);
      const sp = arr.splice(k, 1)[0];
      v.corpses.push({ x: sp.bx + (key === 'you' ? -6 : 6), y: sp.by, at: t, kind: sp.kind, foe: key === 'foe' });
    }
    while (arr.length < n) arr.push(newSprite(arr.length, key === 'you' ? 1 : 2));
    void hexToScreen;
  }

  /**
   * Advance animation time; expire corpses into glints.
   * @param {number} dt
   * @param {{ glint?: Function }} [fx]
   * @param {(hex:number)=>{x:number,y:number}} [hexToScreen]
   */
  function update(dt, fx, hexToScreen) {
    t += dt;
    for (const v of views.values()) {
      for (let i = v.corpses.length - 1; i >= 0; i--) {
        const c = v.corpses[i];
        if (t - c.at > CORPSE_SEC) {
          if (!c.gone && fx && fx.glint && hexToScreen && v.corpses.length < 60) {
            const p = hexToScreen(v.hex);
            const home = hexToScreen(0);
            fx.glint(p.x + c.x, p.y + c.y, home.x, home.y);
          }
          v.corpses.splice(i, 1);
        }
      }
    }
  }

  /**
   * Draw every bubble. Returns the number of sprites drawn.
   * @param {CanvasRenderingContext2D} ctx
   * @param {(hex:number)=>{x:number,y:number}} hexToScreen
   * @param {number} unit CSS px of a minor ant cell
   * @param {(uid:number)=>string} foeColorOf rival colour for a battle uid
   * @param {(p:{x:number,y:number})=>boolean} visible
   * @returns {number}
   */
  function draw(ctx, hexToScreen, unit, foeColorOf, visible) {
    const atlas = getAtlas();
    let drawn = 0;
    for (const v of views.values()) {
      const p = hexToScreen(v.hex);
      if (!visible(p)) continue;
      const scale = unit / 10;
      const R = (14 + Math.sqrt(Math.max(v.you.length, v.foe.length, 1)) * 4) * scale;
      const foeCol = foeColorOf(v.uid) || '#b0402a';
      // bubble
      ctx.fillStyle = 'rgba(255,240,210,0.13)';
      ctx.strokeStyle = v.rally ? 'rgba(255,214,90,0.9)' : 'rgba(255,240,210,0.55)';
      ctx.lineWidth = v.rally ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, R * 1.6, R, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // corpses
      for (const c of v.corpses) {
        const a = Math.max(0, 1 - (t - c.at) / CORPSE_SEC);
        ctx.globalAlpha = 0.35 + 0.4 * a;
        ctx.fillStyle = c.foe ? rgba(foeCol, 0.8) : '#3b2416';
        ctx.beginPath();
        ctx.ellipse(p.x + c.x * scale, p.y + c.y * scale, 2.2 * scale, 1.2 * scale, 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (v.full) {
        const ox = R * 0.55;
        for (let i = 0; i < v.you.length; i++) {
          const sp = v.you[i];
          const lunge = Math.max(0, Math.sin(t * 7 + sp.ph)) * 4 * scale;
          atlas.drawAnt(ctx, sp.kind, 'none', 0, (Math.floor(t * 9 + i) & 1), p.x - ox + sp.bx * scale + lunge, p.y + sp.by * scale, unit);
          drawn++;
        }
        for (let i = 0; i < v.foe.length; i++) {
          const sp = v.foe[i];
          const lunge = Math.max(0, Math.sin(t * 7 + sp.ph + 1.5)) * 4 * scale;
          atlas.drawAnt(ctx, 'rival', 'none', Math.PI, (Math.floor(t * 9 + i) & 1), p.x + ox - sp.bx * scale - lunge, p.y + sp.by * scale, unit, foeCol);
          drawn++;
        }
        // dust of the melee
        ctx.fillStyle = 'rgba(210,190,150,0.35)';
        for (let k = 0; k < 5; k++) {
          const a = t * 3 + k * 1.3;
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(a) * R * 0.3, p.y + Math.sin(a * 1.7) * R * 0.25, 2.5 * scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!v.ended) {
        ctx.font = '700 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const text = `${Math.ceil(v.youCount || 0)} vs ${Math.ceil(v.foeCount || 0)}`;
        const tw = ctx.measureText(text).width + 10;
        ctx.fillStyle = 'rgba(20,12,6,0.78)';
        ctx.fillRect(p.x - tw / 2, p.y - R - 16, tw, 14);
        ctx.fillStyle = '#ffe6c0';
        ctx.fillText(text, p.x, p.y - R - 9);
      }
    }
    return drawn;
  }

  function clear() {
    views.clear();
  }

  return { sync, update, draw, clear, views };
}

/**
 * Draw the gate fight inside the Below view's main shaft: raiders (rival colour) coming down the shaft against the
 * defenders massed at the bottom.
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} battle
 * @param {{ x: number, top: number, bottom: number, unit: number, t: number, color: string, outline?: string }} o
 * @returns {number} sprites drawn
 */
export function drawGateFight(ctx, battle, o) {
  const atlas = getAtlas();
  const foeN = Math.min(12, shownCount(sideTotal(battle.foe), startTotal(battle, 'foe'), 12));
  const youN = Math.min(12, shownCount(sideTotal(battle.you), startTotal(battle, 'you'), 12));
  const span = Math.max(10, o.bottom - o.top);
  const front = o.top + span * 0.6;
  let n = 0;
  for (let i = 0; i < foeN; i++) {
    const y = front - i * o.unit * 0.55 - Math.max(0, Math.sin(o.t * 6 + i)) * 2;
    const x = o.x + ((i % 2) - 0.5) * o.unit * 0.3;
    atlas.drawAnt(ctx, 'rival', 'none', Math.PI / 2, (Math.floor(o.t * 8 + i) & 1), x, y, o.unit, o.color || rivalColor('', 1), o.outline || null);
    n++;
  }
  for (let i = 0; i < youN; i++) {
    const y = front + o.unit * 0.6 + i * o.unit * 0.5 + Math.max(0, Math.sin(o.t * 6 + i + 2)) * 2;
    const x = o.x + ((i % 2) - 0.5) * o.unit * 0.35;
    atlas.drawAnt(ctx, i % 5 === 4 ? 'supermajor' : 'soldier', 'none', -Math.PI / 2, (Math.floor(o.t * 8 + i) & 1), x, y, o.unit, null, o.outline || null);
    n++;
  }
  ctx.strokeStyle = 'rgba(255,90,60,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(o.x - o.unit, front + o.unit * 0.3);
  ctx.lineTo(o.x + o.unit, front + o.unit * 0.3);
  ctx.stroke();
  return n;
}
