// The two-view seam: an animated shaft connector drawn on the flow-strip canvas, and the sprite hand-off hub between
// the Below and Above renderers (a sprite reaching a shaft top despawns and one emerges on the matching entrance hex
// in the same frame, and vice versa). Owner: WP8. Contract: ARCHITECTURE §13.3 (createSeam), §13.4 (seam), DESIGN §7.11.
// The hub is keyed by the game object, so renderers created without a seam reference still hand sprites over.

import { createLayer, pageHidden, nowMs, reducedMotion } from './canvas.js';
import { CARRY, CARRY_CODES, rgba } from './palette.js';

/** Hand-off tokens expire after this many seconds when the other view never picks them up. */
const TOKEN_TTL = 4;
/** Max queued tokens per direction. */
const QUEUE_MAX = 32;
/** Seconds a hand-off dot takes to cross the seam strip. */
const CROSS_SEC = 0.9;

const HUBS = new WeakMap();

/**
 * The hand-off hub of a game (created on first use).
 * Directions: 'up' = Below → Above (toSurface), 'down' = Above → Below (toNest).
 * @param {object} game
 */
export function seamHub(game) {
  const key = game && typeof game === 'object' ? game : seamHub;
  let hub = HUBS.get(key);
  if (hub) return hub;
  hub = {
    up: [],
    down: [],
    /** recent hand-offs for the seam animation: { dir, carry, at } */
    recent: [],
    /** client-space x of the main entrance on the Above canvas / the main shaft on the Below canvas (null = unknown) */
    surfaceX: null,
    nestX: null,
    /** raid warning flag published by the renderers (red shaft) */
    raid: false,
    /**
     * Queue a hand-off.
     * @param {'up'|'down'} dir
     * @param {number|string} carry CARRY code or key
     * @param {number} [col=-1] shaft column (−1 = main)
     */
    send(dir, carry, col = -1) {
      const q = dir === 'up' ? hub.up : hub.down;
      const now = nowMs() / 1000;
      const c = typeof carry === 'number' ? carry : Math.max(0, CARRY_CODES.indexOf(carry || 'none'));
      if (q.length >= QUEUE_MAX) q.shift();
      q.push({ carry: c, col, t: now });
      if (hub.recent.length >= 40) hub.recent.shift();
      hub.recent.push({ dir, carry: c, at: now });
    },
    /**
     * Take the oldest live token for a direction (optionally for one shaft column), or null.
     * @param {'up'|'down'} dir
     * @param {number|null} [col=null]
     * @returns {{ carry: number, col: number, t: number } | null}
     */
    take(dir, col = null) {
      const q = dir === 'up' ? hub.up : hub.down;
      const now = nowMs() / 1000;
      while (q.length && now - q[0].t > TOKEN_TTL) q.shift();
      for (let i = 0; i < q.length; i++) {
        if (col === null || q[i].col === col || (col === -1 && q[i].col < 0)) return q.splice(i, 1)[0];
      }
      return null;
    },
    /** Number of live tokens waiting in a direction. */
    pending(dir) {
      const q = dir === 'up' ? hub.up : hub.down;
      const now = nowMs() / 1000;
      while (q.length && now - q[0].t > TOKEN_TTL) q.shift();
      return q.length;
    },
    /** Drop everything (run reset). */
    clear() {
      hub.up.length = 0;
      hub.down.length = 0;
      hub.recent.length = 0;
    },
  };
  HUBS.set(key, hub);
  return hub;
}

/**
 * Create the seam connector on the flow-strip canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {{ game: object }} opts
 * @returns {{ render(frameDt: number): void, toSurface(n: number, carry?: any): void, toNest(n: number, carry?: any): void, destroy(): void }}
 */
export function createSeam(canvas, { game } = {}) {
  const layer = createLayer(canvas, { maxDpr: 2 });
  const hub = seamHub(game);
  let rect = null;
  let rectAt = -1e9;
  let t = 0;
  let destroyed = false;

  function clientLeft() {
    const now = nowMs();
    if (now - rectAt > 1000 || !rect) {
      rectAt = now;
      try {
        rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
      } catch {
        rect = null;
      }
    }
    return rect ? rect.left : 0;
  }

  function render(frameDt) {
    if (destroyed || pageHidden()) return;
    const ctx = layer.ctx;
    if (!ctx) return;
    const dt = Math.min(0.1, Math.max(0, Number.isFinite(frameDt) ? frameDt : 0));
    t += dt;
    if (layer.cssW <= 1 || layer.cssH <= 1) layer.resize();
    const W = layer.cssW;
    const H = layer.cssH;
    ctx.setTransform(layer.dpr, 0, 0, layer.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (W < 2 || H < 2) return;
    const s = game && game.s;
    const left = clientLeft();
    const xTop = hub.surfaceX !== null ? hub.surfaceX - left : W / 2;
    const xBot = hub.nestX !== null ? hub.nestX - left : W / 2;
    const xt = Math.max(6, Math.min(W - 6, xTop));
    const xb = Math.max(6, Math.min(W - 6, xBot));

    // soil band: grass edge at the top fading into topsoil
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#4f7f34');
    g.addColorStop(0.18, '#5d3b24');
    g.addColorStop(1, '#3e2716');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = (t * 6) % 9; x < W; x += 9) ctx.fillRect(x, H * 0.35 + ((x * 7) % 5), 1.5, 1.5);

    // the shaft: a curved tunnel from the surface entrance to the nest shaft
    const raid = !!hub.raid || !!(s && s.run && s.run.war && (s.run.war.raids || []).some((r) => r && r.phase === 'warning'));
    const flash = raid ? 0.5 + 0.5 * Math.sin(t * 8) : 0;
    ctx.lineCap = 'round';
    ctx.strokeStyle = raid ? rgba('#ff3b30', 0.35 + 0.5 * flash) : '#1e120a';
    ctx.lineWidth = Math.max(5, Math.min(12, H * 0.45));
    ctx.beginPath();
    ctx.moveTo(xt, -2);
    ctx.bezierCurveTo(xt, H * 0.55, xb, H * 0.45, xb, H + 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,220,170,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // hand-off dots crossing the seam
    const now = nowMs() / 1000;
    const reduced = reducedMotion(s);
    for (const r of hub.recent) {
      const u = (now - r.at) / CROSS_SEC;
      if (u < 0 || u > 1) continue;
      const k = r.dir === 'up' ? 1 - u : u;
      const p = bez(xt, xb, H, k);
      const col = CARRY[CARRY_CODES[r.carry]] || null;
      ctx.fillStyle = '#2b1a0f';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      if (col) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x + 1.5, p.y + (r.dir === 'up' ? -1.8 : 1.8), 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (!reduced) {
      // ambient trickle so the connector reads as alive even between hand-offs
      const jobs = s && s.run && s.run.colony && s.run.colony.jobs;
      const traffic = jobs ? Math.min(6, Math.floor(Math.log10(1 + (jobs.forager || 0) + (jobs.digger || 0)) * 2)) : 0;
      for (let k = 0; k < traffic; k++) {
        const u = ((t * 0.35 + k / traffic) % 1 + 1) % 1;
        const p = bez(xt, xb, H, k % 2 ? u : 1 - u);
        ctx.fillStyle = 'rgba(43,26,15,0.8)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function bez(xt, xb, H, k) {
    // cubic bezier (xt,-2) (xt,0.55H) (xb,0.45H) (xb,H+2)
    const u = 1 - k;
    const x = u * u * u * xt + 3 * u * u * k * xt + 3 * u * k * k * xb + k * k * k * xb;
    const y = u * u * u * -2 + 3 * u * u * k * (H * 0.55) + 3 * u * k * k * (H * 0.45) + k * k * k * (H + 2);
    return { x, y };
  }

  function toSurface(n, carry = 'none') {
    const m = Math.max(0, Math.min(QUEUE_MAX, Math.floor(Number.isFinite(n) ? n : 1)));
    for (let i = 0; i < m; i++) hub.send('up', carry, -1);
  }

  function toNest(n, carry = 'none') {
    const m = Math.max(0, Math.min(QUEUE_MAX, Math.floor(Number.isFinite(n) ? n : 1)));
    for (let i = 0; i < m; i++) hub.send('down', carry, -1);
  }

  function destroy() {
    destroyed = true;
    layer.destroy();
  }

  return { render, toSurface, toNest, destroy };
}
