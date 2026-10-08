// Particles: rain, snow, falling leaves, soil pellets landing on the mound, chitin glints, scent wisps, sparkles and
// floating "+food" numbers. One preallocated typed-array pool per view, hard cap 300; reduced with reducedMotion.
// Owner: WP8. Contract: ARCHITECTURE §13.5 (render/particles.js), DESIGN §25.5. Cosmetic Math.random only.

/** Hard particle cap per pool (DESIGN §25.5). */
export const MAX_PARTICLES = 300;

/** Particle kind codes. */
export const PK = Object.freeze({ rain: 1, snow: 2, leaf: 3, pellet: 4, glint: 5, scent: 6, spark: 7, dust: 8, ripple: 9, bubble: 10 });

const LEAF_COLORS = ['#c9782a', '#b5552a', '#d8a23a', '#8f6a2a', '#a4442a'];
const SPARK_COLORS = ['#fff6c2', '#ffd447', '#ffffff'];

/**
 * C223: resource icon colours for the floating gain numbers (the HUD's --c-* resource colours, dark theme); every
 * "+X food" / "+X chitin" … float draws the resource's icon before its text so the resource is obvious.
 */
export const RES_ICON_COLORS = Object.freeze({ food: '#e6b45c', soil: '#a87a4f', insight: '#9fbcf0', pheromone: '#db92d4',
  chitin: '#8c949c', honeydew: '#f2a63c', leaves: '#7cb852', fungus: '#e9e2d1', alates: '#f4d47f', kinship: '#f0a0b8', genes: '#a0e0c8' });

/** Resource words a float text may end with ("+12 food"), mapped to their icon id (plural/singular forms). */
const RES_WORDS = Object.freeze({ food: 'food', soil: 'soil', insight: 'insight', pheromone: 'pheromone', chitin: 'chitin',
  honeydew: 'honeydew', leaves: 'leaves', leaf: 'leaves', fungus: 'fungus', alates: 'alates', alate: 'alates', kinship: 'kinship',
  genes: 'genes' });

/**
 * C223 [pure]: the resource icon a float should carry: the explicit `res` when it is known, else the resource word a
 * gain text ends with ("+1.2K food" → 'food'); null when none.
 * @param {string} text
 * @param {string|null} [res]
 * @returns {string|null}
 */
export function floatIconRes(text, res = null) {
  if (typeof res === 'string' && RES_ICON_COLORS[res]) return res;
  const m = /^\+\S+\s+([a-z]+)\.?$/i.exec(String(text || '').trim());
  return m && RES_WORDS[m[1].toLowerCase()] ? RES_WORDS[m[1].toLowerCase()] : null;
}

/** C223: draw a resource icon (the HUD's shapes) of size z centred at (x, y). */
function drawResIcon(ctx, res, x, y, z) {
  const c = RES_ICON_COLORS[res] || '#ffffff';
  const r = z / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = c;
  ctx.strokeStyle = 'rgba(20,12,6,0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  switch (res) {
    case 'soil': ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7); break;
    case 'insight': ctx.moveTo(0, -r); ctx.lineTo(r * 0.8, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.8, 0); ctx.closePath(); break;
    case 'chitin':
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k;
        if (k) ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r * 0.9);
        else ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r * 0.9);
      }
      ctx.closePath();
      break;
    case 'honeydew': case 'pheromone':
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(r, r * 0.1, 0, r);
      ctx.quadraticCurveTo(-r, r * 0.1, 0, -r);
      break;
    case 'leaves':
      ctx.moveTo(-r, r * 0.6);
      ctx.quadraticCurveTo(-r * 0.6, -r, r, -r * 0.6);
      ctx.quadraticCurveTo(r * 0.6, r, -r, r * 0.6);
      break;
    case 'fungus':
      ctx.arc(0, 0, r * 0.9, Math.PI, 0);
      ctx.lineTo(r * 0.3, 0);
      ctx.lineTo(r * 0.3, r * 0.8);
      ctx.lineTo(-r * 0.3, r * 0.8);
      ctx.lineTo(-r * 0.3, 0);
      ctx.closePath();
      break;
    default: ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2); break;
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Weather kinds in spawn order. */
const WEATHER_KINDS = Object.freeze(['rain', 'snow', 'leaves']);
/** Weather particles per 100,000 CSS px² of view at intensity 1. */
export const WEATHER_DENSITY = Object.freeze({ rain: 60, snow: 22, leaves: 6 });

/**
 * Target weather population per kind for a view (pure; scaled down together to fit `room`).
 * @param {{ rain?: number, snow?: number, leaves?: number }} mixIn intensities 0..1
 * @param {{ w: number, h: number }} bounds
 * @param {boolean} reduced
 * @param {number} room
 * @returns {{ rain: number, snow: number, leaves: number }}
 */
export function weatherTargets(mixIn, bounds, reduced, room) {
  const area = Math.max(0.4, ((bounds && bounds.w) * (bounds && bounds.h)) / 100000 || 0);
  const out = { rain: 0, snow: 0, leaves: 0 };
  let sum = 0;
  for (const k of WEATHER_KINDS) {
    const v = Number(mixIn && mixIn[k]);
    const it = v > 0 ? Math.min(1, v) : 0;
    out[k] = WEATHER_DENSITY[k] * it * area * (reduced ? 0.25 : 1);
    sum += out[k];
  }
  const scale = sum > room && sum > 0 ? Math.max(0, room) / sum : 1;
  for (const k of WEATHER_KINDS) out[k] = Math.round(out[k] * scale);
  return out;
}

/**
 * Create a particle pool.
 * @param {number} [max=MAX_PARTICLES]
 */
export function createParticles(max = MAX_PARTICLES) {
  const cap = Math.min(MAX_PARTICLES, Math.max(1, Math.floor(max)));
  const p = {
    cap,
    n: 0,
    kind: new Uint8Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    vx: new Float32Array(cap),
    vy: new Float32Array(cap),
    life: new Float32Array(cap),
    max: new Float32Array(cap),
    size: new Float32Array(cap),
    rot: new Float32Array(cap),
    tx: new Float32Array(cap), // target (pellets) / sway seed
    ty: new Float32Array(cap),
    col: new Array(cap).fill('#ffffff'),
    /** Floating texts (≤ 24), drawn above particles. */
    floats: [],
    weatherAcc: 0,
  };

  /**
   * Spawn one particle; returns its index or −1 when full.
   * @param {number} kind PK code
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   * @param {number} life seconds
   * @param {{ size?: number, color?: string, tx?: number, ty?: number, rot?: number }} [o]
   * @returns {number}
   */
  function spawn(kind, x, y, vx, vy, life, o = {}) {
    if (p.n >= cap) return -1;
    const i = p.n++;
    p.kind[i] = kind;
    p.x[i] = x;
    p.y[i] = y;
    p.vx[i] = vx;
    p.vy[i] = vy;
    p.life[i] = life;
    p.max[i] = life;
    p.size[i] = o.size || 2;
    p.rot[i] = o.rot || 0;
    p.tx[i] = o.tx ?? 0;
    p.ty[i] = o.ty ?? 0;
    p.col[i] = o.color || '#ffffff';
    return i;
  }

  function kill(i) {
    const last = p.n - 1;
    if (i !== last) {
      p.kind[i] = p.kind[last]; p.x[i] = p.x[last]; p.y[i] = p.y[last]; p.vx[i] = p.vx[last]; p.vy[i] = p.vy[last];
      p.life[i] = p.life[last]; p.max[i] = p.max[last]; p.size[i] = p.size[last]; p.rot[i] = p.rot[last];
      p.tx[i] = p.tx[last]; p.ty[i] = p.ty[last]; p.col[i] = p.col[last];
    }
    p.n = last;
  }

  /**
   * Advance every particle. Weather particles that leave `bounds` die.
   * @param {number} dt
   * @param {{ x: number, y: number, w: number, h: number }} bounds
   */
  function update(dt, bounds) {
    for (let i = p.n - 1; i >= 0; i--) {
      p.life[i] -= dt;
      if (p.life[i] <= 0) {
        kill(i);
        continue;
      }
      const k = p.kind[i];
      if (k === PK.pellet) {
        // ballistic arc toward (tx, ty): parameter u = 1 − life/max
        const u = 1 - p.life[i] / p.max[i];
        const sx = p.vx[i];
        const sy = p.vy[i];
        p.x[i] = sx + (p.tx[i] - sx) * u;
        p.y[i] = sy + (p.ty[i] - sy) * u - Math.sin(u * Math.PI) * p.size[i] * 6;
        continue;
      }
      if (k === PK.leaf) {
        p.rot[i] += dt * 2.2;
        p.x[i] += (p.vx[i] + Math.sin(p.rot[i] + p.tx[i]) * 18) * dt;
        p.y[i] += p.vy[i] * dt;
      } else if (k === PK.snow) {
        p.x[i] += (p.vx[i] + Math.sin(p.life[i] * 2 + p.tx[i]) * 8) * dt;
        p.y[i] += p.vy[i] * dt;
      } else if (k === PK.ripple) {
        p.size[i] += p.vx[i] * dt;
      } else {
        p.x[i] += p.vx[i] * dt;
        p.y[i] += p.vy[i] * dt;
        if (k === PK.spark || k === PK.dust) p.vy[i] += 30 * dt;
      }
      if ((k === PK.rain || k === PK.snow || k === PK.leaf) && bounds) {
        if (p.y[i] > bounds.y + bounds.h + 10 || p.x[i] < bounds.x - 40 || p.x[i] > bounds.x + bounds.w + 40) kill(i);
      }
    }
    for (let i = p.floats.length - 1; i >= 0; i--) {
      const f = p.floats[i];
      f.life -= dt;
      f.y -= 18 * dt;
      if (f.life <= 0) p.floats.splice(i, 1);
    }
  }

  /**
   * One weather particle of `kind` over `bounds`: at the top edge (steady state) or anywhere in the view
   * (`spread`: pre-warming, so a fresh view does not start empty and fill as one band from the top).
   * @returns {number} index or −1
   */
  function spawnWeather(kind, bounds, spread, k) {
    const x = bounds.x + Math.random() * (bounds.w + 60) - 30;
    if (kind === 'rain') {
      const vy = 420 + Math.random() * 120;
      const y = spread ? bounds.y + Math.random() * bounds.h : bounds.y - 10 - Math.random() * 20;
      return spawn(PK.rain, x, y, -40, vy, (bounds.y + bounds.h + 20 - y) / vy + 0.2, { size: 8 + Math.random() * 6 });
    }
    if (kind === 'snow') {
      const vy = 22 + Math.random() * 26;
      const y = spread ? bounds.y + Math.random() * bounds.h : bounds.y - 4 - Math.random() * 16;
      return spawn(PK.snow, x, y, -6 + Math.random() * 12, vy, (bounds.y + bounds.h + 20 - y) / vy + 4,
        { size: 1 + Math.random() * 1.8, tx: Math.random() * 6 });
    }
    const vy = 26 + Math.random() * 20;
    const y = spread ? bounds.y + Math.random() * bounds.h : bounds.y - 6 - Math.random() * 16;
    return spawn(PK.leaf, x, y, -10 + Math.random() * 20, vy, (bounds.y + bounds.h + 20 - y) / vy + 4,
      { size: 3 + Math.random() * 2.5, tx: Math.random() * 6, rot: Math.random() * 6, color: LEAF_COLORS[k % LEAF_COLORS.length] });
  }

  /**
   * Weather (C123): keep a target population of each kind over `bounds` (screen space), proportional to its intensity
   * (0..1) and the view area. A particle that falls out is replaced at the top edge, so intensities that ramp up or down
   * across a season transition fade the weather in and out instead of popping. `fill` (load, import, the view shown
   * again, a resize) tops every kind up at once, spread over the whole view.
   * @param {{ rain?: number, snow?: number, leaves?: number }} mixIn
   * @param {{ x: number, y: number, w: number, h: number }} bounds
   * @param {number} dt
   * @param {boolean} reduced
   * @param {boolean} [fill=false]
   */
  function weatherMix(mixIn, bounds, dt, reduced, fill = false) {
    if (!bounds || !(bounds.w > 0) || !(bounds.h > 0)) return;
    const targets = weatherTargets(mixIn || {}, bounds, reduced, Math.floor(cap * 0.66));
    let nR = 0;
    let nS = 0;
    let nL = 0;
    for (let i = 0; i < p.n; i++) {
      const k = p.kind[i];
      if (k === PK.rain) nR++;
      else if (k === PK.snow) nS++;
      else if (k === PK.leaf) nL++;
    }
    const have = { rain: nR, snow: nS, leaves: nL };
    let room = Math.floor(cap * 0.66) - p.n;
    let k = 0;
    for (const kind of WEATHER_KINDS) {
      let need = targets[kind] - have[kind];
      if (need <= 0) continue;
      // steady state: replace at most what a fully saturated stream would emit this frame (no bursts at the top)
      if (!fill) need = Math.min(need, Math.max(1, Math.ceil(targets[kind] * dt * (kind === 'rain' ? 2 : 0.25))));
      need = Math.min(need, room);
      for (let j = 0; j < need; j++) if (spawnWeather(kind, bounds, fill, k++) >= 0) room--;
    }
  }

  /**
   * Compatibility: one weather kind at `intensity` (other kinds fade out as they fall).
   * @param {'rain'|'snow'|'leaves'|null} kind
   * @param {number} intensity
   * @param {{ x: number, y: number, w: number, h: number }} bounds
   * @param {number} dt
   * @param {boolean} reduced
   */
  function weather(kind, intensity, bounds, dt, reduced) {
    if (!kind || !(intensity > 0)) return;
    weatherMix({ [kind]: intensity }, bounds, dt, reduced);
  }

  /** Live weather counts by kind. */
  function weatherCounts() {
    const out = { rain: 0, snow: 0, leaves: 0 };
    for (let i = 0; i < p.n; i++) {
      const k = p.kind[i];
      if (k === PK.rain) out.rain++;
      else if (k === PK.snow) out.snow++;
      else if (k === PK.leaf) out.leaves++;
    }
    return out;
  }

  /** Soil pellet arcing from (x0, y0) to (x1, y1). */
  function pellet(x0, y0, x1, y1, size = 1.6) {
    const i = spawn(PK.pellet, x0, y0, x0, y0, 0.7 + Math.random() * 0.3, { tx: x1, ty: y1, size, color: '#7a5232' });
    if (i >= 0) {
      p.vx[i] = x0;
      p.vy[i] = y0;
    }
  }

  /** A burst of sparkles. */
  function sparkle(x, y, n = 8, spread = 30) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = spread * (0.4 + Math.random() * 0.8);
      spawn(PK.spark, x, y, Math.cos(a) * v, Math.sin(a) * v - spread * 0.5, 0.6 + Math.random() * 0.4,
        { size: 1 + Math.random() * 1.5, color: SPARK_COLORS[k % SPARK_COLORS.length] });
    }
  }

  /** Soil dust puff (digging). */
  function dust(x, y, n = 4, color = '#8a6440') {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      spawn(PK.dust, x, y, Math.cos(a) * 18, Math.sin(a) * 18 - 10, 0.4 + Math.random() * 0.3, { size: 1 + Math.random(), color });
    }
  }

  /** A chitin glint that drifts toward (tx, ty). */
  function glint(x, y, tx, ty) {
    const dx = tx - x;
    const dy = ty - y;
    const L = Math.hypot(dx, dy) || 1;
    spawn(PK.glint, x, y, (dx / L) * 25, (dy / L) * 25, Math.min(6, L / 25), { size: 1.6, color: '#bfe3ff' });
  }

  /** Expanding ring (conquest, chamber activation). */
  function ripple(x, y, color = '#ffe08a', speed = 60, life = 1.2) {
    spawn(PK.ripple, x, y, speed, 0, life, { size: 4, color });
  }

  /** A scent wisp drifting from (x, y) with velocity (vx, vy). */
  function scent(x, y, vx, vy) {
    spawn(PK.scent, x, y, vx, vy, 2.2, { size: 2.2, color: '#fff2c8' });
  }

  /**
   * Floating text (e.g. "+1.2 food").
   * @param {number} x
   * @param {number} y
   * @param {string} text
   * @param {string} [color]
   * @param {string|null} [res] C223: resource icon to draw before the text (else read from a "+X food" text)
   */
  function float(x, y, text, color = '#fff3c4', res = null) {
    if (p.floats.length >= 24) p.floats.shift();
    p.floats.push({ x, y, text, color, life: 1.1, res: floatIconRes(text, res) });
  }

  /**
   * Draw every particle (screen space).
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (p.n > 0) {
      // rain streaks batched in one path
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < p.n; i++) {
        if (p.kind[i] !== PK.rain) continue;
        any = true;
        ctx.moveTo(p.x[i], p.y[i]);
        ctx.lineTo(p.x[i] + p.vx[i] * 0.02, p.y[i] - p.size[i]);
      }
      if (any) {
        ctx.strokeStyle = 'rgba(200,225,255,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      any = false;
      ctx.beginPath();
      for (let i = 0; i < p.n; i++) {
        if (p.kind[i] !== PK.snow) continue;
        any = true;
        ctx.moveTo(p.x[i] + p.size[i], p.y[i]);
        ctx.arc(p.x[i], p.y[i], p.size[i], 0, Math.PI * 2);
      }
      if (any) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fill();
      }
      for (let i = 0; i < p.n; i++) {
        const k = p.kind[i];
        if (k === PK.rain || k === PK.snow) continue;
        const a = Math.max(0, Math.min(1, p.life[i] / Math.max(0.001, p.max[i])));
        if (k === PK.leaf) {
          ctx.save();
          ctx.translate(p.x[i], p.y[i]);
          ctx.rotate(p.rot[i]);
          ctx.scale(1, 0.4 + 0.6 * Math.abs(Math.cos(p.rot[i] * 1.3)));
          ctx.fillStyle = p.col[i];
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size[i], p.size[i] * 0.55, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (k === PK.ripple) {
          ctx.strokeStyle = p.col[i];
          ctx.globalAlpha = a;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x[i], p.y[i], p.size[i], 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = k === PK.pellet ? 1 : a;
          ctx.fillStyle = p.col[i];
          ctx.beginPath();
          ctx.arc(p.x[i], p.y[i], p.size[i], 0, Math.PI * 2);
          ctx.fill();
          if (k === PK.glint || k === PK.spark) {
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillRect(p.x[i] - 0.5, p.y[i] - p.size[i] * 1.6, 1, p.size[i] * 3.2);
            ctx.fillRect(p.x[i] - p.size[i] * 1.6, p.y[i] - 0.5, p.size[i] * 3.2, 1);
          }
          ctx.globalAlpha = 1;
        }
      }
    }
    if (p.floats.length) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const f of p.floats) {
        ctx.globalAlpha = Math.max(0, Math.min(1, f.life / 0.4));
        let tx = f.x;
        if (f.res) {
          // C223: icon + text centred together
          const w = typeof ctx.measureText === 'function' ? Number(ctx.measureText(f.text).width) || 0 : 0;
          const iz = 10;
          tx = f.x + (iz + 3) / 2;
          drawResIcon(ctx, f.res, tx - w / 2 - 3 - iz / 2, f.y, iz);
        }
        ctx.fillStyle = 'rgba(20,12,6,0.7)';
        ctx.fillText(f.text, tx + 1, f.y + 1);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, tx, f.y);
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Remove everything. */
  function clear() {
    p.n = 0;
    p.floats.length = 0;
    p.weatherAcc = 0;
  }

  Object.assign(p, { spawn, update, weather, weatherMix, weatherCounts, pellet, sparkle, dust, glint, ripple, scent, float, draw, clear });
  /** Live particle count. */
  Object.defineProperty(p, 'count', { get: () => p.n, enumerable: true });
  return p;
}
