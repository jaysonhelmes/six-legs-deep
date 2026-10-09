// Auto-update (ARCHITECTURE §18 C239): the live version parsed from the changelog text is CURRENT_VERSION (single
// source of truth); module specifiers and HTML assets are found; the import-graph walker (pure and async) handles
// relative paths, re-exports, dynamic imports, loader calls and cycles, and reaches every module of the real game
// from index.html; the boot decision never loops; the local-only test hook. Owner: WP9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CURRENT_VERSION } from '../src/data/changelog.js';
import * as up from '../src/ui/updater.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('C239: the changelog text parses to CURRENT_VERSION (the live-version source of truth)', () => {
  const text = readFileSync(resolve(ROOT, 'src/data/changelog.js'), 'utf8');
  assert.equal(up.parseChangelogVersion(text), CURRENT_VERSION);
  assert.ok(up.isValidVersion(CURRENT_VERSION));
});

test('C239: parseChangelogVersion takes the first entry after the CHANGELOG declaration only', () => {
  const t = "// header: { version: '9.9.9' } in a comment above\nexport const CHANGELOG = deepFreeze([\n  {\n    version: \"1.2.3\", date: 'x' },\n  { version: '1.2.2' },\n]);";
  assert.equal(up.parseChangelogVersion(t), '1.2.3');
  assert.equal(up.parseChangelogVersion("version: '1.0.0'"), null, 'no CHANGELOG declaration');
  assert.equal(up.parseChangelogVersion('export const CHANGELOG = [{ version: "beta" }]'), null);
  assert.equal(up.parseChangelogVersion('<html>404</html>'), null);
  assert.equal(up.parseChangelogVersion(null), null);
});

test('C239: version validation', () => {
  for (const v of ['0.12.1', '10.0.0']) assert.ok(up.isValidVersion(v), v);
  for (const v of ['', '0.12', 'v0.12.1', ' 0.1.0', null, undefined, 12]) assert.ok(!up.isValidVersion(v), String(v));
});

test('C239: moduleSpecifiers finds static, side-effect, re-export, dynamic and loader imports', () => {
  const src = [
    "import { a, b as c } from './a.js';",
    'import def, * as ns from "../core/b.js"',
    'import {',
    '  x,',
    '  y,',
    "} from './multi.js';",
    "import './side.js';",
    "export { z } from './re.js';",
    "export * from './star.js';",
    "const m = await import('./dyn.js');",
    "tryImport('./render/loader.js');",
    "const t = import(`./tmpl/${name}.js`);",
    "import fs from 'node:fs';",
    "const s = 'not an import ./nope.js';",
    "import { a as again } from './a.js';",
  ].join('\n');
  const got = up.moduleSpecifiers(src).sort();
  assert.deepEqual(got, ['../core/b.js', './a.js', './dyn.js', './multi.js', './re.js', './render/loader.js', './side.js', './star.js'].sort());
});

test('C239: htmlAssets lists module scripts and stylesheets (not icons or classic scripts)', () => {
  const html = '<link rel="icon" href="data:image/svg+xml,x"><link rel="stylesheet" href="styles/base.css">'
    + "<link href='styles/panels.css' rel='stylesheet'><script src=\"old.js\"></script>"
    + '<script type="module" src="src/boot.js"></script>';
  assert.deepEqual(up.htmlAssets(html), { scripts: ['src/boot.js'], styles: ['styles/base.css', 'styles/panels.css'] });
  const index = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  assert.deepEqual(up.htmlAssets(index).scripts, ['src/boot.js'], 'index.html boots through the update check');
});

const B = 'https://example.github.io/six-legs-deep/';

test('C239: collectGraph resolves relative paths, follows dynamic imports and survives cycles', () => {
  const sources = new Map([
    [B + 'src/main.js', "import { a } from './core/a.js';\nconst r = await import('./render/r.js');"],
    [B + 'src/core/a.js', "import { b } from './b.js';\nexport * from '../data/d.js';"],
    [B + 'src/core/b.js', "import { a } from './a.js';"],                        // cycle a ↔ b
    [B + 'src/data/d.js', 'export const D = 1;'],
    [B + 'src/render/r.js', "import { a } from '../core/a.js';\nimport('./missing.js');"],
  ]);
  const files = up.collectGraph([B + 'src/main.js'], sources);
  assert.deepEqual([...files].sort(), [
    'src/core/a.js', 'src/core/b.js', 'src/data/d.js', 'src/main.js', 'src/render/missing.js', 'src/render/r.js',
  ].map((p) => B + p).sort(), 'a missing file is listed but not followed');
  // plain-object sources work the same; a self-import terminates
  const one = up.collectGraph([B + 'x.js'], { [B + 'x.js']: "import './x.js';" });
  assert.deepEqual([...one], [B + 'x.js']);
});

test('C239: crawlGraph fetches each file once, applies the filter, and reports failures', async () => {
  const sources = {
    [B + 'src/main.js']: "import './a.js';\nimport 'https://cdn.example.com/x.js';\nimport('./b.js');",
    [B + 'src/a.js']: "import './b.js';\nimport './main.js';",
    [B + 'src/b.js']: "import './a.js';\nimport './gone.js';",
    [B + 'styles/base.css']: 'body {}',
  };
  const calls = [];
  const fetchText = async (u) => { calls.push(u); return sources[u] ?? null; };
  const res = await up.crawlGraph([B + 'src/main.js', B + 'styles/base.css'], fetchText, { filter: (u) => u.startsWith(B) });
  assert.deepEqual([...res.files].sort(), ['src/a.js', 'src/b.js', 'src/gone.js', 'src/main.js', 'styles/base.css'].map((p) => B + p).sort());
  assert.deepEqual(res.failed, [B + 'src/gone.js']);
  assert.equal(calls.length, new Set(calls).size, 'no file fetched twice');
  assert.ok(!calls.some((u) => u.includes('cdn.example.com')), 'other origins are not fetched');
});

test('C239: the walker reaches every module of the real game from index.html (same set as the browser loads)', async () => {
  const base = pathToFileURL(ROOT + '/').href;
  const read = (u) => { try { return readFileSync(fileURLToPath(u), 'utf8'); } catch { return null; } };
  const { scripts, styles } = up.htmlAssets(read(base + 'index.html'));
  const res = await up.crawlGraph([...scripts, ...styles].map((s) => new URL(s, base).href), read);
  assert.deepEqual(res.failed, [], 'every discovered path exists');
  const found = new Set([...res.files].map((u) => relative(ROOT, fileURLToPath(u)).replace(/\\/g, '/')));
  for (const f of ['src/boot.js', 'src/main.js', 'src/ui/updater.js', 'src/data/changelog.js', 'src/render/nestRenderer.js',
    'src/render/surfaceRenderer.js', 'src/render/seam.js', 'styles/base.css', 'styles/panels.css']) assert.ok(found.has(f), f);
  // every runtime module under src/ is reached (types.js holds JSDoc typedefs only and is never imported)
  const all = [];
  const list = (d) => { for (const n of readdirSync(d)) { const p = resolve(d, n); if (statSync(p).isDirectory()) list(p); else if (p.endsWith('.js')) all.push(relative(ROOT, p).replace(/\\/g, '/')); } };
  list(resolve(ROOT, 'src'));
  const missed = all.filter((f) => !found.has(f) && f !== 'src/core/types.js');
  assert.deepEqual(missed, [], 'modules the refresh would not re-download');
});

test('C239: boot decision: update once per target version, never loop', () => {
  const d = (o) => up.decideBootUpdate({ live: '0.13.0', current: '0.12.1', attempted: null, guardOk: true, ...o });
  assert.equal(d({}), 'update', 'mismatch → refresh');
  assert.equal(d({ live: '0.12.1' }), 'continue', 'match');
  assert.equal(d({ attempted: '0.13.0' }), 'stale', 'already tried this version this session → continue, warn');
  assert.equal(d({ attempted: '0.12.9' }), 'update', 'an attempt at an older target does not block a newer one');
  assert.equal(d({ guardOk: false }), 'continue', 'no sessionStorage → no forced reload (cannot guard a loop)');
  assert.equal(d({ live: null }), 'continue', 'offline / timeout');
  assert.equal(d({ live: 'garbage' }), 'continue');
  assert.equal(d({ current: null }), 'continue');
  assert.equal(d({ live: '0.12.0' }), 'update', 'a rollback on the server also refreshes');
  // simulate the session: boot 1 updates and stores the guard; boot 2 still mismatched → stale, not another reload
  const store = new Map();
  const boot = () => {
    const a = up.decideBootUpdate({ live: '0.13.0', current: '0.12.1', attempted: store.get(up.UPDATE_GUARD_KEY) ?? null, guardOk: true });
    if (a === 'update') store.set(up.UPDATE_GUARD_KEY, '0.13.0');
    return a;
  };
  assert.deepEqual([boot(), boot(), boot()], ['update', 'stale', 'stale']);
});

test('C239: in-game offer and the local-only test hook', () => {
  assert.ok(up.shouldOfferUpdate('0.13.0', '0.12.1'));
  assert.ok(!up.shouldOfferUpdate('0.12.1', '0.12.1'));
  assert.ok(!up.shouldOfferUpdate(null, '0.12.1'));
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.0.0.131', '[::1]']) assert.ok(up.isLocalHost(h), h);
  for (const h of ['jaysonhelmes.github.io', 'example.netlify.app', '10.0.0.1', '127.example.com', '']) assert.ok(!up.isLocalHost(h), h);
  assert.equal(up.forcedVersion('?forceUpdateCheck=0.99.0', '127.0.0.1'), '0.99.0');
  assert.equal(up.forcedVersion('?forceUpdateCheck=0.99.0', 'jaysonhelmes.github.io'), null, 'ignored when deployed');
  assert.equal(up.forcedVersion('?forceUpdateCheck=junk', 'localhost'), null);
  assert.equal(up.forcedVersion('', 'localhost'), null);
});
