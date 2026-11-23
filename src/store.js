// Decides where each downloaded file lives on disk and writes it there.
//
// Files keep the same folder structure they have on the real website, so
// paths that JavaScript builds at runtime (e.g. "/_next/static/chunks/x.js")
// still work. Files from other domains go under "_external/<domain>/".

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPE_EXT = {
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/x-javascript': '.js',
  'text/html': '.html',
  'application/json': '.json',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff': '.woff',
  'application/font-woff2': '.woff2',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'application/wasm': '.wasm',
};

const EXT_KIND = {
  css: ['.css'],
  js: ['.js', '.mjs', '.cjs'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp'],
  font: ['.woff', '.woff2', '.ttf', '.otf', '.eot'],
  media: ['.mp4', '.webm', '.ogg', '.mp3', '.wav', '.m4a', '.mov', '.vtt'],
};

const RESERVED = ['index.html', 'webclone.json'];

export function mimeOf(contentType) {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

/** Classify a file as css / js / image / font / media / html / data / other. */
export function kindOf(contentType, url) {
  const t = mimeOf(contentType);
  if (t === 'text/css') return 'css';
  if (/javascript|ecmascript/.test(t)) return 'js';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('font/') || /font|woff|opentype|truetype/.test(t)) return 'font';
  if (t.startsWith('video/') || t.startsWith('audio/')) return 'media';
  if (t === 'text/html') return 'html';
  if (t.includes('json')) return 'data';
  const ext = path.posix.extname(new URL(url).pathname).toLowerCase();
  for (const [kind, exts] of Object.entries(EXT_KIND)) if (exts.includes(ext)) return kind;
  return 'other';
}

export function stripHash(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

const encodePath = (p) => p.split('/').map((seg) => (seg === '..' ? seg : encodeURIComponent(seg))).join('/');

function fragmentOf(url) {
  const i = url.indexOf('#');
  return i === -1 ? '' : url.slice(i);
}

const shortHash =(s) => createHash('sha1').update(s).digest('hex').slice(0, 8);

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function cleanSegment(s) {
  let out = s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').trim();
  if (/^\.*$/.test(out)) out = '_';
  if (out.length > 120) {
    const ext = path.posix.extname(out).slice(0, 10);
    out = out.slice(0, 100) + '-' + shortHash(out) + ext;
  }
  return out;
}

export class Store {
  constructor(outDir, pageUrl) {
    this.outDir = outDir;
    this.origin = new URL(pageUrl).origin;
    this.byUrl = new Map(); // url -> entry
    this.aliases = new Map(); // redirected url -> final url
    this.css = new Map(); // local path -> { text, url }  (written at the end)
    this.usedFiles = new Set(RESERVED); // lower-cased, macOS is case-insensitive
    this.usedDirs = new Set();
    this.pendingWrites = [];
    this.totalBytes = 0;
  }

  lookup(url) {
    const key = stripHash(url);
    return this.byUrl.get(key) || this.byUrl.get(this.aliases.get(key));
  }

  alias(from, to) {
    const a = stripHash(from);
    const b = stripHash(to);
    if (a !== b && !this.byUrl.has(a)) this.aliases.set(a, b);
  }

  /** Save a downloaded file. Returns its entry. */
  add(url, body, contentType) {
    const key = stripHash(url);
    const existing = this.lookup(key);
    if (existing) return existing;

    const kind = kindOf(contentType, key);
    const localPath = this.#allocate(key, contentType, kind);
    const entry = { url: key, path: localPath, kind, size: body.length };
    this.byUrl.set(key, entry);

    if (kind === 'css') {
      // CSS is rewritten (url(...) -> local paths) once everything is downloaded.
      this.css.set(localPath, { text: body.toString('utf8').replace(/^\uFEFF/, ''), url: key });
    } else {
      this.pendingWrites.push(this.write(localPath, body));
    }
    return entry;
  }

  /** Relative URL to put inside `fromPath` so it points at the local copy of `url` (or null). */
  urlFor(url, fromPath) {
    const entry = this.lookup(url);
    if (!entry) return null;
    const rel = path.posix.relative(path.posix.dirname(fromPath), entry.path);
    return encodePath(rel) + fragmentOf(url);
  }

  /**
   * Root-relative URL ("/a/b.js") for `url`, for pages viewed through `webclone serve`.
   * Same-origin files keep exactly their original path, because frameworks like
   * Next.js match <script src> values against the paths they expect.
   */
  rootUrlFor(url) {
    const entry = this.lookup(url);
    if (!entry) return null;
    const u = new URL(url);
    if (u.origin === this.origin) return u.pathname + u.search + u.hash;
    return '/' + encodePath(entry.path) + fragmentOf(url);
  }

  async write(localPath, data) {
    const full = path.join(this.outDir, ...localPath.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    this.totalBytes += Buffer.byteLength(data);
  }

  async flush() {
    await Promise.all(this.pendingWrites);
    this.pendingWrites = [];
  }

  counts() {
    const counts = {};
    for (const e of this.byUrl.values()) counts[e.kind] = (counts[e.kind] || 0) + 1;
    return counts;
  }

  manifest() {
    const files = {};
    for (const e of this.byUrl.values()) files[e.url] = e.path;
    return files;
  }

  #allocate(url, contentType, kind) {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).map((s) => cleanSegment(safeDecode(s)));
    if (u.pathname.endsWith('/') || segs.length === 0) segs.push('index');

    let file = segs.pop();
    const ext = path.posix.extname(file).toLowerCase();
    const wanted = TYPE_EXT[mimeOf(contentType)] || { css: '.css', js: '.js' }[kind] || '';
    if (!ext) file += wanted;
    else if ((kind === 'css' || kind === 'js') && !EXT_KIND[kind].includes(ext)) file += wanted;

    const prefix = u.origin === this.origin ? [] : ['_external', cleanSegment(u.host)];
    const dir = [...prefix, ...segs].join('/');
    let candidate = dir ? `${dir}/${file}` : file;

    if (!this.#isFree(candidate)) {
      // Same name already used (e.g. style.css?v=1 and style.css?v=2): add a short hash.
      const e = path.posix.extname(file);
      const named = `${file.slice(0, file.length - e.length)}.${shortHash(url)}${e}`;
      candidate = dir ? `${dir}/${named}` : named;
      if (!this.#isFree(candidate)) candidate = `_external/_conflicts/${shortHash(url)}-${named}`;
    }
    this.#reserve(candidate);
    return candidate;
  }

  #isFree(p) {
    const key = p.toLowerCase();
    if (this.usedFiles.has(key) || this.usedDirs.has(key)) return false;
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.usedFiles.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  }

  #reserve(p) {
    const parts = p.toLowerCase().split('/');
    this.usedFiles.add(parts.join('/'));
    for (let i = 1; i < parts.length; i++) this.usedDirs.add(parts.slice(0, i).join('/'));
  }
}
