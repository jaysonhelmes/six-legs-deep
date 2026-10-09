// Rate-limited toasts, bottom-left: at most 2 per 10 s; overflow queued (high priority) or dropped (low priority).
// Owner: WP9. Contract: ARCHITECTURE §14.6, DESIGN §25.2 / §25.6 rule 6. Time comes from the animation frame
// (nowMs), never from timers, so the limiter is a pure, testable object (createToastQueue).

import { h, clear } from './dom.js';

/** Rate-limit defaults (DESIGN §25.2: at most 2 toasts per 10 s). */
export const TOAST_LIMIT = Object.freeze({ max: 2, windowMs: 10000, maxQueue: 8, ttlMs: 5000, dedupeMs: 10000 });

/**
 * Pure rate limiter. push(toast, nowMs) → 'shown' | 'queued' | 'dropped'; pump(nowMs) → toasts that may show now.
 * A toast is { text, kind?, priority?: 'top'|'high'|'low' }. Identical text within dedupeMs of the last one is dropped.
 * @param {{ max?: number, windowMs?: number, maxQueue?: number, dedupeMs?: number }} [opts]
 */
export function createToastQueue({ max = TOAST_LIMIT.max, windowMs = TOAST_LIMIT.windowMs, maxQueue = TOAST_LIMIT.maxQueue,
  dedupeMs = TOAST_LIMIT.dedupeMs } = {}) {
  /** @type {number[]} times at which toasts were shown (sliding window) */
  const shownAt = [];
  /** @type {Array<Object>} queued high-priority toasts */
  const queue = [];
  /** @type {Map<string, number>} text → last time it was accepted */
  const lastText = new Map();

  function prune(now) {
    while (shownAt.length && now - shownAt[0] >= windowMs) shownAt.shift();
  }

  function isDuplicate(toast, now) {
    const t = lastText.get(toast.text);
    return t !== undefined && now - t < dedupeMs;
  }

  return {
    push(toast, now) {
      if (!toast || !toast.text) return 'dropped';
      if (isDuplicate(toast, now)) return 'dropped';
      prune(now);
      // 'top' (the catch-up summary after a hidden tab) shows at once, ahead of the burst of milestone toasts that the
      // catch-up published just before it; it still counts against the window.
      if (toast.priority === 'top' || (queue.length === 0 && shownAt.length < max)) {
        shownAt.push(now);
        lastText.set(toast.text, now);
        return 'shown';
      }
      if (toast.priority === 'high') {
        if (queue.length >= maxQueue) queue.shift(); // keep the newest high-priority news
        queue.push(toast);
        lastText.set(toast.text, now);
        return 'queued';
      }
      return 'dropped';
    },
    pump(now) {
      prune(now);
      const out = [];
      while (queue.length && shownAt.length < max) {
        shownAt.push(now);
        out.push(queue.shift());
      }
      return out;
    },
    /** Number of queued toasts. */
    pending() {
      return queue.length;
    },
    /** Number shown inside the current window. */
    recent(now) {
      prune(now);
      return shownAt.length;
    },
    clear() {
      shownAt.length = 0;
      queue.length = 0;
      lastText.clear();
    },
  };
}

/**
 * Toast stack bound to a container element. push(text, kind, opts) and frame(nowMs) (call every animation frame).
 * opts: { priority: 'high'|'low' (default 'low'), action: { label, fn } | null, ttlMs }.
 * @param {HTMLElement} el the #toasts container
 */
export function createToasts(el) {
  const limiter = createToastQueue();
  /** @type {Array<{ node: HTMLElement, until: number, leaving: number }>} */
  const live = [];
  let now = 0;

  if (el) {
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('role', 'status');
  }

  function render(toast) {
    if (!el) return;
    const node = h('div', { class: 'toast toast-' + (toast.kind || 'info') },
      h('span', { class: 'toast-text', text: toast.text }));
    if (toast.action && typeof toast.action.fn === 'function') {
      node.appendChild(h('button', {
        type: 'button', class: 'btn btn-small toast-act', text: toast.action.label || 'OK',
        on: { click: () => { try { toast.action.fn(); } finally { dismiss(entry); } } },
      }));
    }
    // C190: a quiet secondary link (e.g. "Log": open the event log at this entry)
    if (toast.link && typeof toast.link.fn === 'function') {
      node.appendChild(h('button', {
        type: 'button', class: 'toast-link', text: toast.link.label || 'More',
        on: { click: () => { try { toast.link.fn(); } finally { dismiss(entry); } } },
      }));
    }
    node.appendChild(h('button', {
      type: 'button', class: 'toast-close', attrs: { 'aria-label': 'Dismiss' }, text: '×',
      on: { click: () => dismiss(entry) },
    }));
    // The display clock starts at the next frame(): a toast pushed from inside game.advance (for example the catch-up
    // after a hidden tab) carries the previous frame's stale `now` and would otherwise expire on the very next frame.
    const entry = { node, until: -1, ttl: toast.ttlMs || TOAST_LIMIT.ttlMs, leaving: 0 };
    live.push(entry);
    el.appendChild(node);
    while (live.length > 4) remove(live[0]);
  }

  function dismiss(entry) {
    if (!entry || entry.leaving) return;
    entry.leaving = now + 250;
    entry.node.classList.add('leaving');
  }

  function remove(entry) {
    const i = live.indexOf(entry);
    if (i >= 0) live.splice(i, 1);
    if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
  }

  return {
    limiter,
    /**
     * Offer a toast; returns 'shown' | 'queued' | 'dropped'.
     * @param {string} text
     * @param {string} [kind]
     * @param {{ priority?: 'top'|'high'|'low', action?: { label: string, fn: Function }|null, link?: { label: string, fn: Function }|null,
     *   ttlMs?: number }} [opts]
     */
    push(text, kind = 'info', opts = {}) {
      const toast = { text: String(text || ''), kind, priority: opts.priority || 'low', action: opts.action || null, link: opts.link || null,
        ttlMs: opts.ttlMs };
      const res = limiter.push(toast, now);
      if (res === 'shown') render(toast);
      return res;
    },
    /** Advance time: show queued toasts, expire old ones. */
    frame(nowMs) {
      if (Number.isFinite(nowMs)) now = nowMs;
      for (const t of limiter.pump(now)) render(t);
      for (const entry of live.slice()) {
        if (entry.until < 0) entry.until = now + entry.ttl;
        if (entry.leaving) {
          if (now >= entry.leaving) remove(entry);
        } else if (now >= entry.until) {
          dismiss(entry);
        }
      }
    },
    /** Number of toasts on screen. */
    count() {
      return live.length;
    },
    clear() {
      limiter.clear();
      live.length = 0;
      clear(el);
    },
  };
}
