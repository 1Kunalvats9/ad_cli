// Opens the page in headless Chrome and records every file the browser loads.

import puppeteer from 'puppeteer';

const MAX_BYTES = 50 * 1024 * 1024;
// Network requests that are never part of the page's code base.
const IGNORED_TYPES = new Set(['document', 'websocket', 'eventsource', 'ping', 'preflight', 'cspviolationreport', 'signedexchange']);

export class CloneError extends Error {}

/** Resolve with `fallback` if `promise` takes longer than `ms` (pages can hang forever). */
function within(promise, ms, fallback = undefined) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

function friendlyError(err, url, timeoutSec) {
  const host = new URL(url).host;
  const msg = String(err && err.message);
  if (msg.includes('ERR_NAME_NOT_RESOLVED')) {
    return new CloneError(`Could not find "${host}". Check the spelling, or the domain's DNS may not be set up yet.`);
  }
  if (/ERR_CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT)|ERR_ADDRESS_UNREACHABLE/.test(msg)) {
    return new CloneError(`The server at ${host} is not responding.`);
  }
  if (msg.includes('ERR_INTERNET_DISCONNECTED')) return new CloneError('No internet connection.');
  if (msg.includes('ERR_CERT')) {
    return new CloneError(`${host} has an invalid HTTPS certificate. Re-run with --insecure if you trust it.`);
  }
  if (err && err.name === 'TimeoutError') {
    return new CloneError(`The page took longer than ${timeoutSec}s to load. Try a bigger --timeout.`);
  }
  if (/Could not find Chrome|Browser was not found|Failed to launch/i.test(msg)) {
    return new CloneError(`Could not start Chrome. Run "npx puppeteer browsers install chrome" and try again.\n    (${msg.split('\n')[0]})`);
  }
  return new CloneError(msg);
}

/** Scroll down the page step by step so lazy-loaded images and animations trigger. */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let travelled = 0;
      const step = Math.max(200, window.innerHeight * 0.75);
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        travelled += step;
        const bottom = document.documentElement.scrollHeight - window.innerHeight;
        if (travelled >= bottom || travelled > 40000) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Serialize the page as currently rendered, including styles that JS injected via the CSSOM. */
function snapshotDom() {
  for (const style of document.querySelectorAll('style')) {
    try {
      const rules = style.sheet && style.sheet.cssRules;
      if (!rules) continue;
      const parsed = new CSSStyleSheet();
      parsed.replaceSync(style.textContent || '');
      // CSS-in-JS libraries add rules with insertRule(), which never shows up in the HTML.
      if (parsed.cssRules.length !== rules.length) {
        style.textContent = Array.from(rules, (r) => r.cssText).join('\n');
      }
    } catch {
      /* cross-origin or unparsable sheet: leave it alone */
    }
  }
  for (const sheet of document.adoptedStyleSheets || []) {
    const style = document.createElement('style');
    style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
    document.head.appendChild(style);
  }
  const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '<!DOCTYPE html>';
  return `${doctype}\n${document.documentElement.outerHTML}`;
}

/**
 * Load `url` in headless Chrome.
 * Returns { html, rendered, finalUrl, resources, aliases }.
 */
export async function capture(url, { timeout = 45, width = 1440, scroll = true, insecure = false, staticMode = false } = {}, log) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      acceptInsecureCerts: insecure,
      protocolTimeout: 60000,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    throw friendlyError(err, url, timeout);
  }

  // Hard stop: if Chrome itself gets stuck, kill it rather than hang forever.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    browser.process()?.kill('SIGKILL');
  }, (timeout + 120) * 1000);

  try {
    const page = await browser.newPage();
    // Look like a normal Chrome so sites don't serve a "bot" version.
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    await page.setViewport({ width, height: 900 });

    const resources = [];
    const aliases = [];
    const reads = [];

    page.on('response', (res) => {
      const req = res.request();
      const status = res.status();
      if (req.method() !== 'GET' || status < 200 || status >= 300 || status === 206) return;
      if (IGNORED_TYPES.has(req.resourceType()) || !/^https?:/.test(res.url())) return;
      const length = Number(res.headers()['content-length'] || 0);
      if (length > MAX_BYTES) return;

      for (const earlier of req.redirectChain()) aliases.push([earlier.url(), res.url()]);
      // Streaming responses never finish, so give each body a time limit.
      reads.push(
        within(res.buffer(), 20000, null).then((body) => {
          if (body) resources.push({ url: res.url(), body, contentType: res.headers()['content-type'] || '' });
        }),
      );
    });

    log.step(`Opening ${url} in headless Chrome`);
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: timeout * 1000 });
    } catch (err) {
      throw friendlyError(err, url, timeout);
    }
    if (!response) throw new CloneError(`No response from ${url}.`);
    const status = response.status();
    if (status >= 400) {
      const hint = [401, 403, 429, 503].includes(status) ? ' The site is probably blocking automated browsers.' : '';
      throw new CloneError(`${url} returned HTTP ${status}.${hint}`);
    }

    const finalUrl = response.url();
    if (finalUrl !== url) log.info(`(redirected to ${finalUrl})`);
    const html = await within(response.text(), 15000, null);
    if (html == null) throw new CloneError(`Could not read the HTML of ${finalUrl}.`);

    await within(page.waitForNetworkIdle({ idleTime: 800 }), 10000);
    if (scroll) {
      log.info('Scrolling through the page to load lazy content...');
      await within(autoScroll(page), 30000);
      await within(page.waitForNetworkIdle({ idleTime: 800 }), 10000);
    }
    await within(page.evaluate(() => document.fonts && document.fonts.ready.then(() => true)), 5000);
    await new Promise((r) => setTimeout(r, 1000)); // let entrance animations settle

    const rendered = staticMode ? await within(page.evaluate(snapshotDom), 30000, null) : null;
    if (staticMode && !rendered) throw new CloneError('Could not take a snapshot of the rendered page.');
    await Promise.all(reads);

    return { html, rendered, finalUrl, resources, aliases };
  } catch (err) {
    if (timedOut) throw new CloneError(`Chrome stopped responding while loading ${url}. Try again, or use --no-scroll.`);
    throw err;
  } finally {
    clearTimeout(deadline);
    await within(browser.close(), 5000);
    browser.process()?.kill('SIGKILL');
  }
}
