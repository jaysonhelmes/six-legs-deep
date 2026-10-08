// Bootstrap entry (index.html loads this, not main.js). C239: before any game module loads, compare the live version
// (src/data/changelog.js fetched with cache:'no-store') with the cached copy's CURRENT_VERSION; on a mismatch
// ui/updater.js refreshes every file and reloads, so a browser never runs a half-updated mix of modules. Then the game
// is loaded with a dynamic import of main.js; if that fails (a mixed set throws on a missing export), one refresh per
// session is tried before a readable error is shown. No static imports on purpose: a broken or stale updater module
// can never stop the game from loading. Owner: WP9. Contract: ARCHITECTURE §14.7, §18 C239.

/** Readable failure when main.js itself could not load (main.js's own bootFailure is not available then). */
function loadFailure(err) {
  console.error('[boot] Six Legs Deep failed to load', err);
  const app = document.getElementById('app') || document.body;
  const box = document.createElement('div');
  box.className = 'boot-error';
  box.setAttribute('role', 'alert');
  const h = document.createElement('h1');
  h.textContent = 'The colony could not start';
  const p = document.createElement('p');
  p.textContent = 'Something went wrong while loading. Your save is safe in this browser. Try reloading the page.';
  const pre = document.createElement('pre');
  pre.textContent = String((err && (err.stack || err.message)) || err);
  box.append(h, p, pre);
  app.appendChild(box);
}

async function start() {
  let updater = null;
  try {
    updater = await import('./ui/updater.js');
  } catch (err) {
    console.warn('[boot] update check unavailable', err);
  }
  if (updater) {
    const reloading = await updater.bootCheck({
      loadCurrent: () => import('./data/changelog.js').then((m) => m.CURRENT_VERSION),
    });
    if (reloading) return;
  }
  try {
    await import('./main.js');
  } catch (err) {
    if (updater && await updater.recoverFromLoadFailure()) return;
    loadFailure(err);
  }
}

start();
