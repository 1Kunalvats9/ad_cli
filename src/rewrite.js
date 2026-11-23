// Finds and rewrites URLs inside HTML and CSS.

import * as cheerio from 'cheerio';

const SKIP = /^(data:|javascript:|mailto:|tel:|sms:|blob:|about:|#|\{\{|\$\{)/i;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(["'])([^"']+)\1/gi;

const RESOURCE_RELS = new Set([
  'stylesheet', 'icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed',
  'mask-icon', 'preload', 'modulepreload', 'prefetch',
]);

/** Make `raw` absolute against `base`. Returns null for data:, #anchors, mailto:, ... */
export function absolutize(raw, base) {
  const v = (raw || '').trim();
  if (!v || SKIP.test(v)) return null;
  try {
    const u = new URL(v, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------- CSS

/** Call fn(rawUrl) for every url(...) / @import in the CSS; non-null results replace it. */
function mapCss(css, fn) {
  css = css.replace(CSS_IMPORT_RE, (m, q, raw) => {
    const r = fn(raw);
    return r == null ? m : `@import ${q}${r}${q}`;
  });
  return css.replace(CSS_URL_RE, (m, a, b, d) => {
    const r = fn(a ?? b ?? d ?? '');
    return r == null ? m : `url("${r.replace(/"/g, '%22')}")`;
  });
}

export function cssRefs(css, base) {
  const out = [];
  mapCss(css, (raw) => {
    const abs = absolutize(raw, base);
    if (abs) out.push(abs);
    return null;
  });
  return out;
}

/** resolve(absUrl) returns the local path to use, or null to keep the live URL. */
export function rewriteCss(css, base, resolve) {
  return mapCss(css, (raw) => {
    const abs = absolutize(raw, base);
    return abs ? resolve(abs) ?? abs : null;
  });
}

// ----------------------------------------------------------------------------- srcset

function parseSrcset(value) {
  const out = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !/\s/.test(value[j])) j++;
    let url = value.slice(i, j);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      i = j;
    } else {
      let k = j;
      while (k < value.length && value[k] !== ',') k++;
      descriptor = value.slice(j, k).trim();
      i = k + 1;
    }
    out.push({ url, descriptor });
  }
  return out;
}

function rewriteSrcset(value, base, resolve) {
  return parseSrcset(value)
    .map(({ url, descriptor }) => {
      const abs = absolutize(url, base);
      const next = abs ? resolve(abs) ?? abs : url;
      return descriptor ? `${next} ${descriptor}` : next;
    })
    .join(', ');
}

// ----------------------------------------------------------------------------- HTML

/**
 * What does this attribute hold?
 *  'res'    a file the page needs: download it and point at the local copy
 *  'srcset' a list of image candidates
 *  'page'   a link to another page: make it absolute so it still works
 */
function attrType(tag, attr, attribs) {
  switch (attr) {
    case 'src':
      if (['script', 'img', 'source', 'video', 'audio', 'track', 'embed', 'input'].includes(tag)) return 'res';
      if (tag === 'iframe' || tag === 'frame') return 'page';
      return null;
    case 'data-src':
      return ['img', 'source', 'video'].includes(tag) ? 'res' : null;
    case 'srcset':
    case 'data-srcset':
      return tag === 'img' || tag === 'source' ? 'srcset' : null;
    case 'imagesrcset':
      return tag === 'link' ? 'srcset' : null;
    case 'poster':
      return tag === 'video' ? 'res' : null;
    case 'data':
      return tag === 'object' ? 'res' : null;
    case 'action':
      return tag === 'form' ? 'page' : null;
    case 'href':
    case 'xlink:href':
      if (tag === 'link') {
        const rels = (attribs.rel || '').toLowerCase().split(/\s+/);
        return rels.some((r) => RESOURCE_RELS.has(r)) ? 'res' : 'page';
      }
      if (tag === 'image' || tag === 'use') return 'res';
      if (tag === 'a' || tag === 'area') return 'page';
      return null;
    default:
      return null;
  }
}

/**
 * Step 1: parse the HTML and find every URL in it.
 * Returns { $, base, slots, refs } where refs are the files the page needs.
 */
export function parseHtml(html, pageUrl, { staticMode = false } = {}) {
  const $ = cheerio.load(html);

  let base = pageUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      /* ignore broken <base> */
    }
  }
  // <base> would break our relative paths, and a CSP meta tag can block local files.
  $('base').remove();
  $('meta[http-equiv]')
    .filter((_, el) => /content-security-policy/i.test($(el).attr('http-equiv') || ''))
    .remove();
  // Everything is saved as UTF-8.
  $('meta[charset]').attr('charset', 'utf-8');

  if (staticMode) {
    $('script')
      .filter((_, el) => !/json/i.test($(el).attr('type') || ''))
      .remove();
    $('link[rel~="modulepreload"], link[rel~="preload"][as="script"], link[rel~="prefetch"][as="script"]').remove();
  }

  const slots = [];
  const refs = new Set();

  $('*').each((_, el) => {
    const tag = (el.name || '').toLowerCase();
    for (const [attr, value] of Object.entries(el.attribs || {})) {
      if (attr === 'style') {
        if (/url\(/i.test(value)) {
          slots.push({ el, attr, type: 'css' });
          cssRefs(value, base).forEach((r) => refs.add(r));
        }
        continue;
      }
      const type = attrType(tag, attr, el.attribs);
      if (!type) continue;
      slots.push({ el, attr, type });
      if (type === 'res') {
        const abs = absolutize(value, base);
        if (abs) refs.add(abs);
      }
    }
    if (tag === 'style') {
      slots.push({ el, type: 'style' });
      cssRefs($(el).text(), base).forEach((r) => refs.add(r));
    }
  });

  return { $, base, slots, refs };
}

/** Step 2: rewrite every URL found in step 1. Returns the final HTML string. */
export function finishHtml({ $, base, slots }, resolve) {
  for (const slot of slots) {
    const $el = $(slot.el);

    if (slot.type === 'style') {
      $el.text(rewriteCss($el.text(), base, resolve));
      continue;
    }

    const value = $el.attr(slot.attr);
    if (value == null) continue;

    if (slot.type === 'css') {
      $el.attr(slot.attr, rewriteCss(value, base, resolve));
    } else if (slot.type === 'srcset') {
      $el.attr(slot.attr, rewriteSrcset(value, base, resolve));
    } else {
      const abs = absolutize(value, base);
      if (!abs) continue;
      const local = slot.type === 'res' ? resolve(abs) : null;
      $el.attr(slot.attr, local ?? abs);
      // CSS files are rewritten, so their integrity hash no longer matches.
      // (JS, images and fonts are saved byte-for-byte, so theirs still do.)
      if (local && slot.el.name === 'link' && /stylesheet|style/i.test(`${$el.attr('rel')} ${$el.attr('as')}`)) {
        $el.removeAttr('integrity');
      }
    }
  }
  return $.html();
}
