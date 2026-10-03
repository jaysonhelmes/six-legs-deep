// Canvas layers: DPR handling (capped at 2), ResizeObserver-driven resize with cache invalidation, offscreen canvas
// helpers. Owner: WP8. Contract: ARCHITECTURE §13.2. All DOM access happens inside functions so Node can import this.
// Extension (WP8-internal): setCanvasFactory() lets headless tests inject a fake 2D canvas; Layer.version increments on
// every resize/DPR change so renderers know to drop size-dependent caches.

/** @type {null | ((w: number, h: number) => { canvas: any, ctx: any })} */
let factory = null;

/**
 * Inject a canvas factory (tests / headless tools). Pass null to restore the DOM default.
 * @param {null | ((w: number, h: number) => { canvas: any, ctx: any })} fn
 */
export function setCanvasFactory(fn) {
  factory = typeof fn === 'function' ? fn : null;
}

/**
 * Create an offscreen canvas of w × h device pixels. Uses document.createElement('canvas') (or OffscreenCanvas when
 * there is no document). Returns { canvas: null, ctx: null } when no canvas implementation exists.
 * @param {number} w
 * @param {number} h
 * @returns {{ canvas: any, ctx: CanvasRenderingContext2D|null }}
 */
export function createOffscreen(w, h) {
  const W = Math.max(1, Math.round(Number.isFinite(w) ? w : 1));
  const H = Math.max(1, Math.round(Number.isFinite(h) ? h : 1));
  if (factory) return factory(W, H);
  try {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      return { canvas, ctx: canvas.getContext('2d') };
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(W, H);
      return { canvas, ctx: canvas.getContext('2d') };
    }
  } catch {
    // fall through
  }
  return { canvas: null, ctx: null };
}

/**
 * Current device pixel ratio, capped.
 * @param {number} [maxDpr=2]
 * @returns {number}
 */
export function getDpr(maxDpr = 2) {
  let dpr = 1;
  try {
    if (typeof window !== 'undefined' && window && window.devicePixelRatio > 0) dpr = window.devicePixelRatio;
  } catch {
    dpr = 1;
  }
  return Math.max(1, Math.min(maxDpr, dpr));
}

/**
 * Wrap an on-page canvas as a drawing layer. All drawing uses CSS pixels (the context transform applies the DPR).
 * @param {HTMLCanvasElement} canvas
 * @param {{ maxDpr?: number, onResize?: null | ((layer: Layer) => void) }} [opts]
 * @returns {Layer}
 *
 * @typedef {{ canvas: any, ctx: CanvasRenderingContext2D|null, cssW: number, cssH: number, dpr: number,
 *             version: number, resize(): boolean, destroy(): void }} Layer
 */
export function createLayer(canvas, { maxDpr = 2, onResize = null } = {}) {
  let ctx = null;
  try {
    ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  } catch {
    ctx = null;
  }
  /** @type {Layer} */
  const layer = {
    canvas,
    ctx,
    cssW: 0,
    cssH: 0,
    dpr: 1,
    version: 0,
    resize,
    destroy,
  };
  let ro = null;
  let mq = null;
  let destroyed = false;

  function measure() {
    let w = 0;
    let h = 0;
    let laidOut = false;
    try {
      if (canvas && typeof canvas.getBoundingClientRect === 'function') {
        const r = canvas.getBoundingClientRect();
        w = r.width;
        h = r.height;
        laidOut = true;
      }
      if (!(w > 0) && canvas) w = canvas.clientWidth || 0;
      if (!(h > 0) && canvas) h = canvas.clientHeight || 0;
      if ((!(w > 0) || !(h > 0)) && canvas && canvas.parentElement) {
        const p = canvas.parentElement.getBoundingClientRect ? canvas.parentElement.getBoundingClientRect() : null;
        if (p) {
          if (!(w > 0)) w = p.width;
          if (!(h > 0)) h = p.height;
        }
      }
    } catch {
      // headless: fall back to the backing store size
    }
    // A hidden canvas (display: none on medium/narrow layouts) measures 0 × 0: keep the last real size. The backing
    // store fallback below is in device pixels, so using it here doubled the canvas (and the camera's idea of the
    // view) on every resize while hidden at DPR 2.
    if (laidOut && (!(w > 0) || !(h > 0)) && layer.cssW > 0 && layer.cssH > 0) return [layer.cssW, layer.cssH];
    if (!(w > 0)) w = (canvas && canvas.width) || 300;
    if (!(h > 0)) h = (canvas && canvas.height) || 150;
    return [w, h];
  }

  /**
   * Re-measure; resizes the backing store when the CSS size or the DPR changed.
   * @returns {boolean} true when anything changed (caches must be invalidated)
   */
  function resize() {
    if (destroyed) return false;
    const [w, h] = measure();
    const dpr = getDpr(maxDpr);
    const changed = Math.abs(w - layer.cssW) > 0.5 || Math.abs(h - layer.cssH) > 0.5 || dpr !== layer.dpr;
    if (!changed && layer.version > 0) return false;
    layer.cssW = w;
    layer.cssH = h;
    layer.dpr = dpr;
    try {
      if (canvas) {
        const bw = Math.max(1, Math.round(w * dpr));
        const bh = Math.max(1, Math.round(h * dpr));
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
      }
      if (ctx && typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch {
      // ignore sizing failures (detached canvas)
    }
    layer.version++;
    watchDpr();
    if (typeof onResize === 'function') {
      try {
        onResize(layer);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[render] onResize failed', err);
      }
    }
    return true;
  }

  function onMq() {
    resize();
  }

  function watchDpr() {
    try {
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
      mq = null;
      if (typeof window !== 'undefined' && window.matchMedia) {
        mq = window.matchMedia(`(resolution: ${layer.dpr}dppx)`);
        if (mq && mq.addEventListener) mq.addEventListener('change', onMq);
      }
    } catch {
      mq = null;
    }
  }

  function onWinResize() {
    resize();
  }

  try {
    if (typeof ResizeObserver !== 'undefined' && canvas && canvas.parentElement) {
      ro = new ResizeObserver(() => resize());
      ro.observe(canvas.parentElement);
    }
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', onWinResize);
  } catch {
    ro = null;
  }

  function destroy() {
    destroyed = true;
    try {
      if (ro) ro.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', onWinResize);
    } catch {
      // ignore
    }
    ro = null;
    mq = null;
  }

  resize();
  return layer;
}

/**
 * Clear a layer to transparent (or fill it) in CSS pixel space.
 * @param {Layer} layer
 * @param {string|null} [fill=null]
 */
export function clearLayer(layer, fill = null) {
  const ctx = layer && layer.ctx;
  if (!ctx) return;
  ctx.setTransform(layer.dpr, 0, 0, layer.dpr, 0, 0);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, layer.cssW, layer.cssH);
  } else {
    ctx.clearRect(0, 0, layer.cssW, layer.cssH);
  }
}

/**
 * True when the page is hidden (document.hidden); false in headless environments.
 * @returns {boolean}
 */
export function pageHidden() {
  try {
    return typeof document !== 'undefined' && !!document && document.hidden === true;
  } catch {
    return false;
  }
}

/**
 * High-resolution time in ms (performance.now, falling back to Date.now). Render-layer only.
 * @returns {number}
 */
export function nowMs() {
  try {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
  } catch {
    // fall through
  }
  return Date.now();
}

/**
 * Reduced-motion preference: the game setting, or the OS media query.
 * @param {any} s game state (read only)
 * @returns {boolean}
 */
export function reducedMotion(s) {
  try {
    if (s && s.meta && s.meta.settings && s.meta.settings.reducedMotion) return true;
    if (typeof window !== 'undefined' && window.matchMedia) return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
  return false;
}
