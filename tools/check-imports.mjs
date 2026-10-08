#!/usr/bin/env node
// Static import check (integration step): walks the import graph from src/main.js (static imports, re-exports and
// dynamic import()s of literal paths, including the literal module paths main.js hands to its tryImport loader) and
// verifies that every imported file exists, every named import is exported by its module, and every `ns.member` used
// through `import * as ns` is exported. No module is executed, so browser-only code is checked too. Owner: integration.
// Usage: node tools/check-imports.mjs [entry ...]   (default entry: src/boot.js, which loads src/main.js; also used for tools/*.mjs)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = process.argv.slice(2).length ? process.argv.slice(2) : ['src/boot.js'];

/** Remove comments and the contents of template/regular strings that could hold fake `import` text. */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {   // keep template expressions verbatim
          let depth = 0;
          while (i < src.length) {
            out += src[i];
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) { i++; break; }
            i++;
          }
          continue;
        }
        out += src[i++];
      }
      out += src[i] || '';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse a `{ a, b as c, default as d }` clause into [{ imported, local }]. */
function parseNames(clause) {
  return clause.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
    return m ? { imported: m[1], local: m[2] || m[1] } : { imported: x, local: x, bad: true };
  });
}

const cache = new Map();

/** Parse one module: its imports, its own exports and its `export * from` sources. */
function parse(file) {
  if (cache.has(file)) return cache.get(file);
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const info = { file, imports: [], exports: new Set(), starFrom: [], namespaces: [] };
  const spec = String.raw`['"](\.{1,2}\/[^'"]+)['"]`;   // one capture group: the relative path
  let m;
  // import x, { a as b } from '…' / import * as ns from '…' / import '…'
  // (the clause never holds quotes or semicolons, so a match cannot run on into the next statement)
  const importRe = new RegExp(String.raw`(?:^|[;\n}])\s*import\s+([^;'"]*?)\s+from\s*` + spec + String.raw`|(?:^|[;\n}])\s*import\s*` + spec, 'g');
  while ((m = importRe.exec(src))) {
    if (m[1] !== undefined) {
      const clause = m[1].trim();
      const from = m[2];
      const named = [];
      let ns = null;
      let def = null;
      const braces = clause.match(/\{([\s\S]*)\}/);
      if (braces) named.push(...parseNames(braces[1]));
      const nsM = clause.match(/\*\s+as\s+([\w$]+)/);
      if (nsM) ns = nsM[1];
      const defM = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, ' ').trim();
      if (defM) def = defM;
      info.imports.push({ from, named, ns, def, kind: 'static' });
      if (ns) info.namespaces.push({ ns, from });
    } else {
      info.imports.push({ from: m[3], named: [], ns: null, def: null, kind: 'side-effect' });
    }
  }
  // export { a, b as c } from '…' / export * from '…' / export * as ns from '…'
  const reexRe = new RegExp(String.raw`export\s*(\*(?:\s+as\s+([\w$]+))?|\{([^}]*)\})\s*from\s*` + spec, 'g');
  while ((m = reexRe.exec(src))) {
    const from = m[4];
    if (m[1].startsWith('*')) {
      if (m[2]) info.exports.add(m[2]);
      else info.starFrom.push(from);
      info.imports.push({ from, named: [], ns: null, def: null, kind: 're-export' });
    } else {
      const names = parseNames(m[3]);
      for (const n of names) info.exports.add(n.local);
      info.imports.push({ from, named: names.map((n) => ({ imported: n.imported, local: n.imported })), ns: null, def: null, kind: 're-export' });
    }
  }
  // dynamic import('…') and literal module paths passed to a loader (main.js tryImport('./render/x.js'))
  const dynRe = new RegExp(String.raw`(?:import|tryImport)\s*\(\s*` + spec + String.raw`\s*\)`, 'g');
  while ((m = dynRe.exec(src))) info.imports.push({ from: m[1], named: [], ns: null, def: null, kind: 'dynamic' });
  // own exports
  for (const re of [/export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g, /export\s+class\s+([\w$]+)/g]) {
    while ((m = re.exec(src))) info.exports.add(m[1]);
  }
  const declRe = /export\s+(?:const|let|var)\s+([\s\S]*?)(?:=|;)/g;
  while ((m = declRe.exec(src))) {
    const head = m[1].trim();
    if (head.startsWith('{') || head.startsWith('[')) for (const id of head.match(/[\w$]+/g) || []) info.exports.add(id);
    else info.exports.add(head.split(/[\s,]/)[0]);
  }
  const listRe = /export\s*\{([^}]*)\}(?!\s*from)/g;
  while ((m = listRe.exec(src))) for (const n of parseNames(m[1])) info.exports.add(n.local);
  if (/export\s+default\b/.test(src)) info.exports.add('default');
  // Code with string contents blanked, for the `ns.member` scan (so '../systems/nest.js' is not read as nest.js).
  info.code = src.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
  cache.set(file, info);
  return info;
}

/** All names a module exports, following `export * from`. */
function allExports(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const info = parse(file);
  const out = new Set(info.exports);
  for (const f of info.starFrom) {
    const target = resolve(dirname(file), f);
    if (existsSync(target)) for (const n of allExports(target, seen)) if (n !== 'default') out.add(n);
  }
  return out;
}

const errors = [];
const visited = new Set();
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

function walk(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const info = parse(file);
  for (const imp of info.imports) {
    const target = resolve(dirname(file), imp.from);
    if (!imp.from.endsWith('.js') && !imp.from.endsWith('.mjs')) errors.push(rel(file) + ': import "' + imp.from + '" has no .js extension (ground rule 1)');
    if (!existsSync(target)) {
      errors.push(rel(file) + ': imports missing file "' + imp.from + '"');
      continue;
    }
    const exp = allExports(target);
    for (const n of imp.named) {
      if (n.bad) errors.push(rel(file) + ': cannot parse import name "' + n.imported + '" from ' + imp.from);
      else if (!exp.has(n.imported)) errors.push(rel(file) + ': "' + n.imported + '" is not exported by ' + rel(target));
    }
    if (imp.def && !exp.has('default')) errors.push(rel(file) + ': default import from ' + rel(target) + ' but it has no default export');
    walk(target);
  }
  // `ns.member` through `import * as ns`: every member must be exported (a local shadowing `ns` would be reported too).
  for (const { ns, from } of info.namespaces) {
    const target = resolve(dirname(file), from);
    if (!existsSync(target)) continue;
    const exp = allExports(target);
    const re = new RegExp(String.raw`(?<![\w$.])` + ns.replace(/\$/g, '\\$') + String.raw`\s*\.\s*([\w$]+)`, 'g');
    const missing = new Set();
    let m;
    while ((m = re.exec(info.code))) if (!exp.has(m[1])) missing.add(m[1]);
    for (const k of missing) errors.push(rel(file) + ': ' + ns + '.' + k + ' is not exported by ' + rel(target));
  }
}

for (const e of entries) {
  const f = resolve(ROOT, e);
  if (!existsSync(f)) errors.push('entry not found: ' + e);
  else walk(f);
}

console.log('Static import check: ' + visited.size + ' modules reachable from ' + entries.join(', '));
// Informational: src modules the entries never reach (dead files, or modules only tests and tools use).
const allSrc = [];
const listJs = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f);
    if (statSync(p).isDirectory()) listJs(p);
    else if (p.endsWith('.js')) allSrc.push(p);
  }
};
listJs(resolve(ROOT, 'src'));
const unreached = allSrc.filter((f) => !visited.has(f)).map(rel);
if (unreached.length) console.log('note: not reachable from the entries: ' + unreached.join(', '));
for (const e of errors) console.log('ERROR  ' + e);
console.log(errors.length ? errors.length + ' problem(s)' : 'all imports resolve and every imported name is exported');
process.exitCode = errors.length ? 1 : 0;
