// Auto-update (C239): keeps a browser from running a stale or half-updated copy of the game after a deploy. GitHub
// Pages caches every file for 10 minutes and the game is ~125 ES modules cached one by one, so right after a deploy a
// browser can mix old and new modules. The live version is read from src/data/changelog.js fetched with
// cache:'no-store' (the changelog stays the single source of truth: no version file to keep in sync) and compared
// with CURRENT_VERSION of the copy the HTTP cache would load. On a mismatch: a full-screen "Updating to vX…" overlay,
// every game file (index.html, its stylesheets, and the whole import graph walked at runtime from its module scripts)
// is re-downloaded with cache:'reload' to refresh the HTTP cache, then the page reloads. A sessionStorage guard allows
// at most one forced update per target version per session (no reload loops). While playing, a quiet check every
// 10 minutes and when the tab is shown again offers an "Update available" pill. Saves (localStorage) are never
// touched. file:// and failed or slow (3 s) checks just continue. Test hook: ?forceUpdateCheck=<version>, honoured
// only on localhost / 127.x / *.localhost. Owner: WP9. Contract: ARCHITECTURE §14.7, §18 C239.
// Top level is DOM-free and imports nothing (Node tests import it; src/boot.js loads it before anything else).

/** sessionStorage key: the version this session last tried to force-update to (loop guard). */
export const UPDATE_GUARD_KEY = 'sld.updateAttempt';
/** sessionStorage key: set once this session has tried a refresh after the game modules failed to load. */
export const RECOVER_GUARD_KEY = 'sld.updateRecover';
/** Query parameter of the local test hook. */
export const FORCE_PARAM = 'forceUpdateCheck';
/** Live-version fetch timeout. */
export const CHECK_TIMEOUT_MS = 3000;
/** The whole refresh gives up waiting after this long and reloads anyway (the loop guard still holds). */
export const REFRESH_DEADLINE_MS = 8000;
/** In-game check period, and the minimum gap between checks triggered by the tab becoming visible. */
export const WATCH_PERIOD_MS = 10 * 60 * 1000;
export const WATCH_MIN_GAP_MS = 60 * 1000;

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** True for a 'MAJOR.MINOR.PATCH' string. */
export function isValidVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v);
}

/**
 * The newest version in the text of src/data/changelog.js: the first `version: '…'` after the CHANGELOG declaration
 * (entries are newest first, so this is what CURRENT_VERSION evaluates to). Null when not found.
 * @param {string} text
 * @returns {string|null}
 */
export function parseChangelogVersion(text) {
  if (typeof text !== 'string') return null;
  const at = text.search(/export\s+const\s+CHANGELOG\b/);
  if (at < 0) return null;
  const m = /\bversion\s*:\s*(['"`])(\d+\.\d+\.\d+)\1/.exec(text.slice(at));
  return m ? m[2] : null;
}

/**
 * Relative / absolute-path module specifiers in a module's source: static `import … from '…'`, side-effect
 * `import '…'`, `export … from '…'`, dynamic `import('…')` and literal paths handed to a loader such as the
 * tryImport helper in main.js. Comments are not stripped: a path mentioned in a comment only costs one extra fetch.
 * Bare specifiers (none in this game) and template-literal dynamic imports are ignored.
 * @param {string} src
 * @returns {string[]} unique specifiers in order of appearance
 */
export function moduleSpecifiers(src) {
  if (typeof src !== 'string') return [];
  const out = [];
  const add = (s) => { if (/^(?:\.{1,2}\/|\/(?!\/))/.test(s) && !out.includes(s)) out.push(s); };
  const res = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,        // import x from '…' / export { a } from '…'
    /\bimport\s*(['"])([^'"\n]+)\1/g,                                   // import '…'
    /\b[\w$]*[iI]mport\s*\(\s*(['"`])([^'"`\n$]+)\1\s*[,)]/g,           // import('…') / tryImport('…')
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(src))) add(m[2]);
  }
  return out;
}

/** Module scripts (src) and stylesheets (href) referenced by an HTML page, as written. */
export function htmlAssets(html) {
  const scripts = [];
  const styles = [];
  if (typeof html !== 'string') return { scripts, styles };
  const attr = (tag, name) => {
    const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3]) : null;
  };
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
    const src = attr(tag, 'src');
    if (src && /type\s*=\s*["']?module/i.test(tag)) scripts.push(src);
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, 'rel');
    const href = attr(tag, 'href');
    if (href && rel && /\bstylesheet\b/i.test(rel) && !/^data:/i.test(href)) styles.push(href);
  }
  return { scripts, styles };
}

/** Resolve a specifier against a base URL (no hash); null when it cannot be resolved. */
export function resolveSpecifier(spec, base) {
  try {
    const u = new URL(spec, base);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

const isScriptUrl = (u) => /\.m?js$/i.test(u.split('?')[0]);

/**
 * Every file reachable from `entries` through module specifiers (pure; the test-facing twin of crawlGraph).
 * `sources` maps absolute URL → source text; a reachable URL missing from it is still listed but not followed.
 * Cycles are fine (each URL is visited once).
 * @param {string[]} entries absolute URLs
 * @param {Map<string,string>|Object<string,string>} sources
 * @returns {Set<string>}
 */
export function collectGraph(entries, sources) {
  const get = sources instanceof Map ? (u) => sources.get(u) : (u) => sources[u];
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const url = stack.pop();
    if (seen.has(url)) continue;
    seen.add(url);
    const text = get(url);
    if (typeof text !== 'string' || !isScriptUrl(url)) continue;
    for (const spec of moduleSpecifiers(text)) {
      const r = resolveSpecifier(spec, url);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

/**
 * The runtime walker: fetches each file once (breadth-first, one level in parallel), follows the specifiers of
 * script files, and returns every URL it visited plus the ones that failed. `fetchText(url)` returns the text or null.
 * @param {string[]} entries absolute URLs
 * @param {(url: string) => Promise<string|null>|string|null} fetchText
 * @param {{ filter?: (url: string) => boolean }} [o] which resolved URLs to follow (e.g. same origin)
 * @returns {Promise<{ files: Set<string>, failed: string[] }>}
 */
export async function crawlGraph(entries, fetchText, { filter = () => true } = {}) {
  const files = new Set();
  const failed = [];
  let frontier = [];
  for (const e of entries) if (e && !files.has(e) && filter(e)) { files.add(e); frontier.push(e); }
  while (frontier.length) {
    const texts = await Promise.all(frontier.map((u) => Promise.resolve().then(() => fetchText(u)).catch(() => null)));
    const next = [];
    frontier.forEach((url, i) => {
      const text = texts[i];
      if (typeof text !== 'string') { failed.push(url); return; }
      if (!isScriptUrl(url)) return;
      for (const spec of moduleSpecifiers(text)) {
        const r = resolveSpecifier(spec, url);
        if (r && !files.has(r) && filter(r)) { files.add(r); next.push(r); }
      }
    });
    frontier = next;
  }
  return { files, failed };
}

/**
 * Boot decision (pure). 'update': force the refresh now; 'stale': still mismatched although this session already
 * tried to update to this version (continue, warn); 'continue': nothing to do (versions match, no or bad live
 * version, or no sessionStorage to guard a reload loop with).
 * @param {{ live: string|null, current: string|null, attempted: string|null, guardOk: boolean }} o
 * @returns {'update'|'stale'|'continue'}
 */
export function decideBootUpdate({ live, current, attempted, guardOk }) {
  if (!isValidVersion(live) || !isValidVersion(current) || live === current) return 'continue';
  if (attempted === live) return 'stale';
  return guardOk ? 'update' : 'continue';
}

/** In-game decision (pure): offer the pill when the live version is valid and differs from the running one. */
export function shouldOfferUpdate(live, current) {
  return isValidVersion(live) && isValidVersion(current) && live !== current;
}

/** True for a local development host (localhost, *.localhost, 127.x.x.x, ::1). */
export function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '[::1]' || h === '::1';
}

/** The ?forceUpdateCheck=<version> test hook, honoured only on a local host; else null. */
export function forcedVersion(search, hostname) {
  if (!isLocalHost(hostname)) return null;
  try {
    const v = new URLSearchParams(search || '').get(FORCE_PARAM);
    return isValidVersion(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- browser side (never runs at import time) ----

/** The changelog URL (the live-version source), resolved against this module. */
const changelogUrl = () => new URL('../data/changelog.js', import.meta.url).href;
/** The app root (the folder that holds index.html), resolved against this module (src/ui/ → ../../). */
const appRoot = () => new URL('../../', import.meta.url).href;

/** Updating only makes sense over http(s) with fetch available (file:// and odd embeds skip it). */
function canCheck() {
  try {
    return typeof fetch === 'function' && /^https?:$/.test(location.protocol);
  } catch {
    return false;
  }
}

function session() {
  try {
    const s = window.sessionStorage;
    const probe = '__sld_probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function readKey(s, key) {
  try { return s ? s.getItem(key) : null; } catch { return null; }
}

function writeKey(s, key, v) {
  try { if (s) s.setItem(key, v); } catch { /* best effort */ }
}

/**
 * The live version (changelog.js fetched with cache:'no-store'), or null on failure / timeout / file://.
 * The ?forceUpdateCheck hook (local hosts only) replaces the fetched value.
 * @returns {Promise<string|null>}
 */
export async function fetchLiveVersion({ timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  try {
    const forced = forcedVersion(location.search, location.hostname);
    if (forced) return forced;
  } catch { /* no location */ }
  if (!canCheck()) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { if (ctl) ctl.abort(); resolve(null); }, timeoutMs); });
    const req = fetch(changelogUrl(), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then((r) => (r.ok ? r.text() : null))
      .then(parseChangelogVersion)
      .catch(() => null);
    return await Promise.race([req, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Full-screen "Updating to vX…" overlay (inline styles: it may show before the game's CSS matters). */
function showUpdatingOverlay(version) {
  try {
    let el = document.getElementById('update-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'update-overlay';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;inset:0;z-index:3000;display:flex;flex-direction:column;align-items:center;'
      + 'justify-content:center;gap:10px;padding:16px;background:rgba(28,20,13,0.94);color:#f0e6d2;text-align:center;'
      + 'font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;';
    const h = document.createElement('div');
    h.style.cssText = 'font-size:20px;font-weight:700;color:#f0c66a;';
    h.textContent = version ? 'Updating to v' + version + '…' : 'Updating…';
    const p = document.createElement('div');
    p.style.cssText = 'font-size:14px;opacity:0.8;max-width:420px;';
    p.textContent = 'Fetching the new version of every file so nothing old and new gets mixed. Your colony is safe.';
    el.append(h, p);
    (document.body || document.documentElement).appendChild(el);
    return el;
  } catch {
    return null;
  }
}

/**
 * Re-download every game file with cache:'reload' (refreshing the HTTP cache), then reload the page. Bounded by
 * REFRESH_DEADLINE_MS. Never touches localStorage.
 * @param {string|null} version shown on the overlay
 * @returns {Promise<{ files: number, failed: number }>} resolves just before the reload
 */
export async function refreshAndReload(version) {
  showUpdatingOverlay(version);
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const origin = location.origin;
  const root = appRoot();
  const refetch = (url) => fetch(url, { cache: 'reload', credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : null));
  let stats = { files: 0, failed: 0 };
  const work = (async () => {
    const docUrl = resolveSpecifier(location.href, location.href);
    const indexUrl = resolveSpecifier('index.html', root);
    const [docHtml] = await Promise.all([refetch(docUrl).catch(() => null), docUrl !== indexUrl ? refetch(indexUrl).catch(() => null) : null]);
    const { scripts, styles } = htmlAssets(docHtml || '');
    const entries = [...scripts, ...styles].map((s) => resolveSpecifier(s, docUrl)).filter(Boolean);
    // Always include the boot entry and main.js, even if the page HTML could not be read.
    entries.push(new URL('../boot.js', import.meta.url).href, new URL('../main.js', import.meta.url).href);
    const res = await crawlGraph(entries, refetch, { filter: (u) => u.startsWith(origin + '/') });
    stats = { files: res.files.size + 1, failed: res.failed.length };
    if (res.failed.length) console.warn('[update] could not refresh', res.failed);
  })();
  await Promise.race([work.catch((err) => console.warn('[update] refresh failed', err)), new Promise((r) => setTimeout(r, REFRESH_DEADLINE_MS))]);
  const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0;
  console.info('[update] refreshed ' + stats.files + ' files in ' + ms + ' ms; reloading for v' + version);
  location.reload();
  return stats;
}

/**
 * Boot check (src/boot.js, before the game modules load). Resolves true when a forced update is under way (the page
 * is reloading: do not boot), false to continue booting.
 * @param {{ loadCurrent: () => Promise<string|null> }} o reads CURRENT_VERSION of the copy that would load
 * @returns {Promise<boolean>}
 */
export async function bootCheck({ loadCurrent }) {
  try {
    if (!canCheck()) return false;
    const [live, current] = await Promise.all([fetchLiveVersion(), loadCurrent().catch(() => null)]);
    const s = session();
    const attempted = readKey(s, UPDATE_GUARD_KEY);
    const action = decideBootUpdate({ live, current, attempted, guardOk: !!s });
    if (action === 'stale') {
      console.warn('[update] still on v' + current + ' after updating to v' + live + ' this session; continuing with the cached copy');
      return false;
    }
    if (action !== 'update') return false;
    writeKey(s, UPDATE_GUARD_KEY, live);
    console.info('[update] v' + current + ' cached, v' + live + ' live: refreshing');
    await refreshAndReload(live);
    return true;
  } catch (err) {
    console.warn('[update] boot check skipped', err);
    return false;
  }
}

/**
 * The game modules failed to load (a mixed old/new set throws a SyntaxError for a missing export). Try one refresh
 * per session. Resolves true when reloading.
 * @returns {Promise<boolean>}
 */
export async function recoverFromLoadFailure() {
  try {
    if (!canCheck()) return false;
    const s = session();
    if (!s || readKey(s, RECOVER_GUARD_KEY)) return false;
    writeKey(s, RECOVER_GUARD_KEY, '1');
    const live = await fetchLiveVersion();
    console.warn('[update] game modules failed to load; refreshing every file once');
    await refreshAndReload(live);
    return true;
  } catch {
    return false;
  }
}

/** The "Update available" pill (patch-notes pill styling). */
function createAvailablePill(version, onUpdate, onDismiss) {
  const pill = document.createElement('div');
  pill.className = 'toast toast-gold update-pill update-available';
  pill.setAttribute('role', 'status');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'update-pill-open';
  open.textContent = 'Update available: v' + version + ' — reload to update';
  open.addEventListener('click', () => { open.disabled = true; onUpdate(); });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => onDismiss());
  pill.append(open, close);
  return pill;
}

/**
 * While playing: check the live version every WATCH_PERIOD_MS and when the tab is shown again (at most once per
 * WATCH_MIN_GAP_MS); when it differs from `current`, show the "Update available" pill in #toasts. Its click calls
 * `beforeReload` (save the game), then refreshes and reloads. A dismissed version is not offered again this page.
 * @param {{ current: string, beforeReload?: () => void, container?: () => HTMLElement|null }} o
 * @returns {{ check: () => Promise<string|null>, stop: () => void }}
 */
export function startUpdateWatch({ current, beforeReload = () => {}, container = () => document.getElementById('toasts') }) {
  let lastAt = 0;
  let pill = null;
  let offered = null;
  let dismissed = null;
  async function check() {
    lastAt = Date.now();
    const live = await fetchLiveVersion();
    if (!shouldOfferUpdate(live, current) || live === offered || live === dismissed) return live;
    if (pill) pill.remove();
    offered = live;
    pill = createAvailablePill(live, () => {
      try { beforeReload(); } catch (err) { console.error('[update] save before reload failed', err); }
      writeKey(session(), UPDATE_GUARD_KEY, live);
      refreshAndReload(live);
    }, () => {
      dismissed = live;
      offered = null;
      if (pill) pill.remove();
      pill = null;
    });
    const host = container() || document.body;
    host.insertBefore(pill, host.firstChild);
    return live;
  }
  if (!canCheck() && !forcedVersion(location.search, location.hostname)) return { check: async () => null, stop() {} };
  const timer = setInterval(() => { check(); }, WATCH_PERIOD_MS);
  const onVis = () => { if (!document.hidden && Date.now() - lastAt >= WATCH_MIN_GAP_MS) check(); };
  document.addEventListener('visibilitychange', onVis);
  lastAt = Date.now(); // boot just checked
  return {
    check,
    stop() {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
