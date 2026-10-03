// Zero-dependency static file server for local play: serves the project root, '/' → index.html.
// Owner: WP1. Contract: ARCHITECTURE §15.1. Usage: node tools/serve.mjs [--port 8080] [--root <dir>]   (or PORT=8080)
// --root is a test aid (default: the project root).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(argValue(process.argv.slice(2), 'root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Value of --name <v> or --name=<v>, or null. */
function argValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' + name && argv[i + 1] !== undefined) return argv[i + 1];
    if (a.startsWith('--' + name + '=')) return a.slice(name.length + 3);
  }
  return null;
}

/** Port from --port, then PORT, default 8080. */
function parsePort(argv, env) {
  const v = argValue(argv, 'port') ?? env.PORT ?? '8080';
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : 8080;
}

/** Send a short plain-text response. */
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** Resolve a request URL to a file path inside ROOT, or null if it escapes the root. */
function resolvePath(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const file = path.resolve(ROOT, '.' + pathname);
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }
  const file = resolvePath(req.url || '/');
  if (!file) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    let target = file;
    if (!err && st.isDirectory()) target = path.join(file, 'index.html');
    fs.readFile(target, (err2, data) => {
      if (err2) {
        sendText(res, 404, 'Not found');
        return;
      }
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
});

const port = parsePort(process.argv.slice(2), process.env);
server.listen(port, () => {
  console.log(`Six Legs Deep → http://localhost:${server.address().port}`);
});
