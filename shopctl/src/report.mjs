/**
 * What the CLI says, and where it says it.
 *
 * One rule decides the layout: in `--json` mode STDOUT carries exactly one
 * document and nothing else, so `shopctl new … --json | jq` works without the
 * caller filtering progress lines out of the stream. Progress therefore goes to
 * stderr in that mode. In human mode both go to stdout, because a terminal
 * interleaves them anyway and a redirected stdout should keep the report.
 *
 * Every line passes through redact(). Not because shopctl handles secrets — it
 * refuses them (secrets.mjs) — but because the lines it relays come from git,
 * npm and wrangler, and an error from one of those can quote an environment
 * value shopctl never saw.
 */
import { redact } from './secrets.mjs';

/** Status of one step or check, in the order a reader should worry about them. */
export const STATUS = {
  ok: { symbol: '✓', label: 'ok' },
  warn: { symbol: '!', label: 'warn' },
  fail: { symbol: '✗', label: 'fail' },
  todo: { symbol: '·', label: 'todo' },
  // Not run, with its reason. Never a pass: `certify` refuses a verdict on a
  // check it skipped, whatever the reason was.
  skip: { symbol: '-', label: 'skip' },
};

export class Reporter {
  /**
   * @param {{ json?: boolean, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [options]
   */
  constructor({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.json = json;
    this.out = stdout;
    this.err = stderr;
    /** @type {Array<{ status: string, message: string, hint: string|null }>} */
    this.entries = [];
    /** True once a machine-readable document has been written to stdout. The
     *  error handler consults it so a failing command never emits two. */
    this.emitted = false;
  }

  /** Where prose goes: stderr under --json, so stdout stays a single document. */
  get prose() {
    return this.json ? this.err : this.out;
  }

  /** A step about to run. Not recorded — only its outcome is. */
  step(message) {
    this.prose.write(`${redact(message)}\n`);
  }

  /** A recorded outcome. `status` is one of STATUS. */
  entry(status, message, hint = null) {
    const entry = { status, message: redact(message), hint: hint ? redact(hint) : null };
    this.entries.push(entry);
    const { symbol } = STATUS[status] ?? STATUS.ok;
    this.prose.write(`${symbol} ${entry.message}\n`);
    if (entry.hint) this.prose.write(`    ${entry.hint}\n`);
    return entry;
  }

  ok(message, hint) {
    return this.entry('ok', message, hint);
  }

  warn(message, hint) {
    return this.entry('warn', message, hint);
  }

  fail(message, hint) {
    return this.entry('fail', message, hint);
  }

  todo(message, hint) {
    return this.entry('todo', message, hint);
  }

  skip(message, hint) {
    return this.entry('skip', message, hint);
  }

  /** A blank line or a heading in human mode; nothing at all under --json,
   *  where the entries carry the structure. */
  section(title = '') {
    this.prose.write(title ? `\n${redact(title)}\n` : '\n');
  }

  /** The machine-readable result. Emitted only under --json, exactly once. */
  result(payload) {
    if (!this.json) return;
    this.out.write(`${JSON.stringify(payload, null, 2)}\n`);
    this.emitted = true;
  }

  /** Relay a document another gate already produced, unchanged. One schema for
   *  one answer beats re-wrapping the gate's own report in a second shape. */
  relay(document) {
    this.out.write(document);
    this.emitted = true;
  }
}
