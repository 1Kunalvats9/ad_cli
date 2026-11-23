// A small static server for previewing a clone.
//
// If the page asks for a file that wasn't cloned (e.g. something its JavaScript
// loads later), the server fetches it from the live website and passes it on,
// so the preview keeps working.

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { c } from './log.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const FORWARD_HEADERS = ['accept', 'accept-language', 'user-agent', 'range', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url'];
const DROP_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie',
  'content-security-policy', 'strict-transport-security', 'alt-svc',
]);

/** Fetch a missing file from the live site and pass it through (no redirect, so URLs stay local). */
async function proxy(req, res, origin) {
  const headers = {};
  for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  try {
    const upstream = await fetch(origin + req.url, { method: req.method, headers, signal: AbortSignal.timeout(30000) });
    const out = { 'Cache-Control': 'no-store' };
    upstream.headers.forEach((value, key) => {
      if (!DROP_HEADERS.has(key)) out[key] = value;
    });
    const body = req.method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, out);
    res.end(body);
    console.log(c.dim(`  ↳ live  ${upstream.status} ${req.url}`));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Could not fetch ${req.url} from ${origin}: ${err.message}`);
  }
}

async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function serve(dir, port = 8000) {
  const root = path.resolve(dir);
  if (!(await isFile(path.join(root, 'index.html')))) {
    throw new Error(`No index.html in ${root}`);
  }

  // Map "/path?query" of the original site -> local file (for URLs with query strings).
  let origin = null;
  let pagePath = '/'; // the cloned page is served at its original path
  const byPath = new Map();
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'webclone.json'), 'utf8'));
    origin = manifest.origin;
    pagePath = new URL(manifest.finalUrl).pathname;
    for (const [url, local] of Object.entries(manifest.files)) {
      const u = new URL(url);
      if (u.origin === origin) byPath.set(u.pathname + u.search, local);
    }
  } catch {
    /* not a webclone folder - serve it as plain static files */
  }

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(reqUrl.pathname);
    } catch {
      pathname = reqUrl.pathname;
    }

    // Page originally lived at e.g. /pricing: keep that URL so its router is happy.
    if (pagePath !== '/' && reqUrl.pathname === '/') {
      res.writeHead(302, { Location: pagePath });
      res.end();
      return;
    }

    const candidates = [];
    if (reqUrl.pathname === pagePath) candidates.push(path.join(root, 'index.html'));
    const mapped = byPath.get(reqUrl.pathname + reqUrl.search);
    if (mapped) candidates.push(path.join(root, mapped));
    const direct = path.join(root, pathname);
    candidates.push(direct, path.join(direct, 'index.html'));

    for (const file of candidates) {
      if (!file.startsWith(root)) continue; // no ../ escapes
      if (await isFile(file)) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        createReadStream(file).pipe(res);
        return;
      }
    }

    if (origin && (req.method === 'GET' || req.method === 'HEAD')) {
      await proxy(req, res, origin);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const listen = (p) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => resolve(p));
    });

  for (let p = port; p < port + 20; p++) {
    try {
      const used = await listen(p);
      console.log(`${c.bold('Preview running at')} ${c.cyan(`http://localhost:${used}${pagePath}`)}`);
      console.log(c.dim(`  Serving ${root}`));
      console.log(c.dim('  Press Ctrl+C to stop.'));
      return server;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`No free port between ${port} and ${port + 19}`);
}
