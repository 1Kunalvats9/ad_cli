// Ties everything together: capture -> save files -> rewrite HTML/CSS.

import fs from 'node:fs/promises';
import path from 'node:path';
import { capture } from './capture.js';
import { cssRefs, finishHtml, parseHtml, rewriteCss } from './rewrite.js';
import { kindOf, Store } from './store.js';

const MAX_BYTES = 50 * 1024 * 1024;
const FONT_URL = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;

async function download(url, referer, timeoutSec) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      Accept: '*/*',
      Referer: referer,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('larger than 50 MB');
  return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

async function runPool(items, size, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Clone `url` into `outDir`.
 * options: { staticMode, scroll, timeout, width, insecure }
 */
export async function clone(url, outDir, options, log) {
  const started = Date.now();
  const { html, rendered, finalUrl, resources, aliases } = await capture(url, options, log);

  const store = new Store(outDir, finalUrl);
  await fs.mkdir(outDir, { recursive: true });
  let captured = 0;
  for (const r of resources) {
    // A static snapshot has no <script> tags, so its JS files would be dead weight.
    if (options.staticMode && kindOf(r.contentType, r.url) === 'js') continue;
    store.add(r.url, r.body, r.contentType);
    captured++;
  }
  for (const [from, to] of aliases) store.alias(from, to);
  log.ok(`Captured ${captured} file${captured === 1 ? '' : 's'} loaded by the browser`);

  const doc = parseHtml(options.staticMode ? rendered : html, finalUrl, { staticMode: options.staticMode });

  // Some files are referenced but weren't loaded during capture (hover images,
  // other font weights, @imports...). Download those directly.
  const failed = [];
  const tried = new Set();
  for (let round = 0; round < 4; round++) {
    const wanted = new Set(doc.refs);
    for (const { text, url: cssUrl } of store.css.values()) cssRefs(text, cssUrl).forEach((r) => wanted.add(r));
    // Fonts the browser never requested are unused subsets/weights - leave them on the live site.
    const todo = [...wanted].filter((u) => !store.lookup(u) && !tried.has(u) && !FONT_URL.test(u));
    if (!todo.length) break;

    if (round === 0) log.step(`Downloading ${todo.length} more file${todo.length === 1 ? '' : 's'} referenced by the HTML/CSS`);
    await runPool(todo, 6, async (u) => {
      tried.add(u);
      try {
        const { body, contentType } = await download(u, finalUrl, options.timeout);
        const entry = store.add(u, body, contentType);
        log.ok(entry.path);
      } catch (err) {
        failed.push({ url: u, reason: err.message });
        log.warn(`${u} (${err.message}) - will load from the live site`);
      }
    });
  }

  log.step('Writing files');
  // CSS: point every url(...) at the local copies.
  for (const [localPath, { text, url: cssUrl }] of store.css) {
    await store.write(localPath, rewriteCss(text, cssUrl, (abs) => store.urlFor(abs, localPath)));
  }
  // Static pages use relative paths (they open fine by double-clicking index.html).
  // Live pages keep root-relative paths so the site's JavaScript finds what it expects;
  // they are meant to be viewed with `webclone serve`.
  const resolveInHtml = options.staticMode
    ? (abs) => store.urlFor(abs, 'index.html')
    : (abs) => store.rootUrlFor(abs);
  await store.write('index.html', finishHtml(doc, resolveInHtml));
  await store.flush();

  const manifest = {
    source: url,
    finalUrl,
    origin: new URL(finalUrl).origin,
    mode: options.staticMode ? 'static' : 'live',
    clonedAt: new Date().toISOString(),
    files: store.manifest(),
  };
  await fs.writeFile(path.join(outDir, 'webclone.json'), JSON.stringify(manifest, null, 2));

  return {
    outDir,
    counts: store.counts(),
    totalBytes: store.totalBytes,
    failed,
    seconds: (Date.now() - started) / 1000,
  };
}
