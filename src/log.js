// Tiny coloured logger. Colours are only used when writing to a terminal.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

export function createLogger({ quiet = false } = {}) {
  return {
    step: (msg) => console.log(c.bold(msg)),
    info: (msg) => !quiet && console.log(`  ${msg}`),
    ok: (msg) => !quiet && console.log(`  ${c.green('✓')} ${msg}`),
    warn: (msg) => console.log(`  ${c.yellow('!')} ${msg}`),
    fail: (msg) => console.error(`  ${c.red('✗')} ${msg}`),
    plain: (msg = '') => console.log(msg),
  };
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
