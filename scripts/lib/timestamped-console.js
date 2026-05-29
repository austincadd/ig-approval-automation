const PATCH_FLAG = Symbol.for('ig-approval-automation.timestamped-console-installed');

function formatConsoleArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  return value;
}

function timestampPrefix() {
  return `[${new Date().toISOString()}]`;
}

export function installTimestampedConsole() {
  if (console[PATCH_FLAG]) return;

  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(timestampPrefix(), ...args.map(formatConsoleArg));
  }

  console[PATCH_FLAG] = true;
}
