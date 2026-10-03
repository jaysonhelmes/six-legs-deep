// Synchronous publish/subscribe event bus with a '*' wildcard; step events and game.js lifecycle events go through it.
// Owner: WP1. Contract: ARCHITECTURE §7.6.
// ARCH-R: §1 rule 3 allows console.error only in guard.js/save.js, but §7.6 requires handler exceptions to be
// console.error'd here; §7.6 is the more specific rule, so the bus logs caught handler exceptions.

/**
 * Create an event bus.
 * on(type, fn) → off; type '*' receives every event as fn(payload). Handlers run synchronously, in subscription order
 * (type-specific handlers first, then '*'); exceptions are caught and logged.
 * @returns {{ on(type: string, fn: Function): () => void, off(type: string, fn: Function): void,
 *            emit(type: string, payload?: Object): void, clear(): void }}
 */
export function createBus() {
  /** @type {Map<string, Function[]>} */
  const subs = new Map();

  function on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    const list = subs.get(type);
    if (list) list.push(fn);
    else subs.set(type, [fn]);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const list = subs.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) subs.delete(type);
  }

  function run(list, payload) {
    if (!list) return;
    for (const fn of list.slice()) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[bus] handler error', err);
      }
    }
  }

  function emit(type, payload = {}) {
    run(subs.get(type), payload);
    if (type !== '*') run(subs.get('*'), payload);
  }

  function clear() {
    subs.clear();
  }

  return { on, off, emit, clear };
}
