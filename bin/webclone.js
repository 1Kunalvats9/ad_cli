#!/usr/bin/env node
// webclone - clone a web page into a local HTML / CSS / JavaScript code base.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CloneError } from '../src/capture.js';
import { clone } from '../src/clone.js';
import { c, createLogger, humanSize } from '../src/log.js';
import { serve } from '../src/serve.js';

const VERSION = '2.0.0';

const HELP = `
${c.bold('webclone')} - clone a web page into a local HTML / CSS / JavaScript code base

${c.bold('Usage')}
  webclone <url> [options]        clone a page
  webclone serve [folder]         preview a cloned page in your browser

${c.bold('Options')}
  -o, --output <dir>   output folder (default: ./cloned_sites/<domain>)
  --static             save the page exactly as rendered, without JavaScript
                       (best visual match for heavy JS sites; nothing is interactive)
  --serve              start the preview server right after cloning
  --port <n>           preview port (default: 8000)
  --width <px>         browser window width (default: 1440)
  --timeout <sec>      how long to wait for the page to load (default: 45)
  --no-scroll          don't scroll the page to trigger lazy-loaded content
  --insecure           ignore invalid HTTPS certificates
  -q, --quiet          only show errors and the summary
  -h, --help           show this help
  -v, --version        show the version

${c.bold('Examples')}
  webclone https://example.com
  webclone example.com -o my-site --serve
  webclone https://some-react-app.com --static
`;

const OPTIONS = {
  output: { type: 'string', short: 'o' },
  static: { type: 'boolean', default: false },
  serve: { type: 'boolean', default: false },
  port: { type: 'string', default: '8000' },
  width: { type: 'string', default: '1440' },
  timeout: { type: 'string', default: '45' },
  'no-scroll': { type: 'boolean', default: false },
  insecure: { type: 'boolean', default: false },
  quiet: { type: 'boolean', short: 'q', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

/** How to tell the user to run this tool again (linked command or node path). */
function selfCommand() {
  const script = process.argv[1] || '';
  if (path.basename(script) === 'webclone') return 'webclone';
  const rel = path.relative(process.cwd(), script);
  return `node ${rel && !rel.startsWith('..') ? rel : script}`;
}

function normaliseUrl(input) {
  let value = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  const u = new URL(value); // throws on garbage
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are supported');
  return u.href;
}

function defaultOutDir(url) {
  const host = new URL(url).host.replace(/[^a-z0-9._-]+/gi, '-');
  const base = path.join('cloned_sites', host);
  let dir = base;
  for (let n = 2; fs.existsSync(dir) && fs.readdirSync(dir).length > 0; n++) dir = `${base}-${n}`;
  return dir;
}

function toNumber(value, name, min) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name} must be a number of at least ${min}`);
  return n;
}

function printSummary(result, log) {
  const k = result.counts;
  const parts = [
    ['html', 'HTML'], ['css', 'CSS'], ['js', 'JS'], ['image', 'images'],
    ['font', 'fonts'], ['media', 'media'], ['data', 'data'], ['other', 'other'],
  ]
    .filter(([key]) => k[key])
    .map(([key, label]) => `${k[key]} ${label}`);

  log.plain();
  log.plain(`${c.green(c.bold('Done!'))} Cloned in ${result.seconds.toFixed(1)}s`);
  log.plain(`  Folder  : ${path.resolve(result.outDir)}`);
  log.plain(`  Files   : index.html + ${parts.join(' · ') || 'no other files'}  (${humanSize(result.totalBytes)})`);
  if (result.failed.length) {
    log.plain(`  Skipped : ${result.failed.length} file(s) could not be downloaded - they load from the live site`);
  }
}

async function runServe(args, log) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: OPTIONS.port, help: OPTIONS.help },
  });
  if (values.help) return log.plain(HELP);
  await serve(positionals[0] || '.', toNumber(values.port, 'port', 1));
}

async function main() {
  const argv = process.argv.slice(2);
  const log = createLogger({ quiet: argv.includes('-q') || argv.includes('--quiet') });

  try {
    if (argv[0] === 'serve') return await runServe(argv.slice(1), log);

    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    if (values.version) return log.plain(VERSION);
    if (values.help || positionals.length === 0) {
      log.plain(HELP);
      return;
    }
    if (positionals.length > 1) throw new Error(`expected one URL, got ${positionals.length}: ${positionals.join(' ')}`);

    const url = normaliseUrl(positionals[0]);
    const outDir = values.output || defaultOutDir(url);
    const result = await clone(
      url,
      outDir,
      {
        staticMode: values.static,
        scroll: !values['no-scroll'],
        timeout: toNumber(values.timeout, 'timeout', 1),
        width: toNumber(values.width, 'width', 320),
        insecure: values.insecure,
      },
      log,
    );
    printSummary(result, log);

    if (values.serve) {
      log.plain();
      await serve(outDir, toNumber(values.port, 'port', 1));
    } else {
      const hint = process.env.WEBCLONE_VIA_MAKE ? 'make serve' : `${selfCommand()} serve "${outDir}"`;
      log.plain(`  Preview : ${c.cyan(hint)}`);
    }
  } catch (err) {
    if (err instanceof CloneError) {
      log.fail(err.message);
    } else if (err.code && String(err.code).startsWith('ERR_PARSE_ARGS')) {
      log.fail(err.message);
      log.plain(`  Run "${selfCommand()} --help" for usage.`);
      process.exitCode = 2;
      return;
    } else if (err instanceof TypeError && /Invalid URL/.test(err.message)) {
      log.fail(`"${argv.find((a) => !a.startsWith('-'))}" is not a valid URL.`);
      process.exitCode = 2;
      return;
    } else {
      log.fail(err.message || String(err));
    }
    process.exitCode = 1;
  }
}

main();
