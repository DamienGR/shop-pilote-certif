#!/usr/bin/env node
/**
 * Secret scan over the tracked tree.
 *
 * A store repository is cloned per client, handed to a merchant, and kept for
 * years; a credential committed once stays in the history of every clone made
 * afterwards, and rotating it means touching every store that carries it. The
 * cheapest place to stop that is the commit that introduces it.
 *
 * What this catches, deliberately in this order:
 *
 *  1. files that must never be tracked at all (.dev.vars, .env, private keys,
 *     per-instance provisioning artifacts) — the most common way a real
 *     credential lands in a repository is a whole file, not a line;
 *  2. provider credentials by their own recognisable shape (Stripe, Resend,
 *     GitHub, AWS, Anthropic, JWTs, PEM blocks);
 *  3. a secret-looking assignment: a name that means "credential" holding a
 *     long opaque value.
 *
 * What it deliberately does NOT do: generic entropy scoring. This tree is full
 * of legitimately high-entropy strings — lockfile integrity hashes, content
 * hashes in the storefront baselines, ciphertext fixtures in the crypto tests —
 * and a scanner that cries wolf on them gets muted, which is worse than not
 * having one. Length + shape rules keep every finding actionable.
 *
 * A false positive is silenced by putting `secret-scan:ignore` on the line (or
 * the line above it), which leaves a reviewable marker in the diff instead of a
 * silent exclusion list.
 *
 * `--artifacts` scans the BUILD OUTPUT as well, and the reason it is a separate
 * flag is that it needs a build. The tracked tree is not the only place a
 * credential can end up: Vite inlines `import.meta.env.*` at build time, so a
 * value that only ever lived in an untracked `.dev.vars` can be compiled into
 * the bundle — and half of that bundle is served to browsers. Nothing in the
 * repository would show it. So the artifacts are read the same way, plus one
 * check the tracked tree cannot have: the literal values in the local
 * `.dev.vars`, which are real credentials by definition, must appear nowhere
 * in `dist/`.
 *
 * `--history` scans every blob any ref still reaches — every branch, every tag,
 * and the pull request heads when they were fetched — because the tree is not
 * what a clone hands over. A credential committed, then deleted the next day,
 * is in the history of every clone made since; on a shop repository that is
 * public (the certification pilot's), it is published. The rules are the same;
 * only the reading changes. A shallow clone is refused rather than scanned: it
 * would pass on the history it does not have.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const IGNORE_MARKER = 'secret-scan:ignore';

// Files whose presence in the index is itself the finding.
const FORBIDDEN_PATHS = [
  { pattern: /(^|\/)\.dev\.vars$/, why: 'local Worker secrets' },
  { pattern: /(^|\/)\.dev\.vars\.(?!example$)/, why: 'local Worker secrets' },
  { pattern: /(^|\/)\.env(\..*)?$/, why: 'environment file' },
  { pattern: /(^|\/)\.instances\//, why: 'per-instance provisioning artifact' },
  { pattern: /(^|\/)mcp\/wrangler\.jsonc$/, why: 'per-instance MCP deploy config' },
  { pattern: /\.(pem|p12|pfx|key|keystore|jks)$/, why: 'private key material' },
  { pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, why: 'SSH private key' },
  { pattern: /(^|\/)\.npmrc$/, why: 'may carry a registry token', allow: [/^\.npmrc$/, /^mcp\/\.npmrc$/] },
];

// Binary and generated content: nothing here is hand-written, and scanning it
// only produces noise.
const SKIP_CONTENT = [
  /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|eot|pdf|zip|gz)$/,
  /(^|\/)package-lock\.json$/,
];

const RULES = [
  { name: 'Stripe secret key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'Stripe webhook secret', pattern: /\bwhsec_[A-Za-z0-9]{20,}/ },
  { name: 'Resend API key', pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenNode API key', pattern: /\bopennode_[A-Za-z0-9]{20,}/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  // The header and its value, as Lighthouse writes them into every report it
  // was handed --extra-headers for. A shell variable or `<masqué>` is not one.
  { name: 'Cloudflare Access service token', pattern: /cf-access-client-secret["']?\s*[:=]\s*["']?[A-Za-z0-9]{32,}/i },
  // Signed: HS256, the shortest real signature, is 43 characters. A test's
  // stand-in assertion signed "sig" is not a credential, and the one cfada29
  // committed stays in the history every shop carries from v0.3.4 on.
  { name: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{43,}/ },
  {
    name: 'Credential-shaped assignment',
    // NAME = "<24+ opaque chars>". Requires the value to look like a key, not a
    // sentence: no spaces, and a mix that rules out plain identifiers.
    pattern:
      /\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|APIKEY|KEK|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["'`]([A-Za-z0-9+/=_-]{24,})["'`]/,
    // A placeholder is not a credential, and neither is a test fixture spelled
    // out in words: these are the shapes the repository uses on purpose in
    // examples, templates and unit tests (`'a-high-entropy-key-…'`). A real key
    // is opaque — it does not read as three hyphenated English words.
    allowValue:
      /^(?:[Xx]+|0+|<.*>|__[A-Z_]+__|your[-_]|change[-_]?me|replace|example|placeholder|unused|[a-z]+(?:[-_][a-z]+){2,}$)/,
  },
];

const scanArtifacts = process.argv.includes('--artifacts');
const scanHistory = process.argv.includes('--history');

/** A bundle is one file where the sources were many, so it gets its own bound. */
const ARTIFACT_MAX_BYTES = 20_000_000;

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const findings = [];

// ---------------------------------------------------------------------------
// 1. Files that must not be tracked.

for (const file of tracked) {
  for (const { pattern, why, allow } of FORBIDDEN_PATHS) {
    if (!pattern.test(file)) continue;
    if (allow?.some((exception) => exception.test(file))) continue;
    findings.push({ file, line: 0, rule: `tracked file (${why})`, excerpt: file });
  }
}

// ---------------------------------------------------------------------------
// 2 & 3. Content rules.

function redact(match) {
  // Show enough to locate the value, never enough to use it.
  return match.length <= 12 ? match : `${match.slice(0, 8)}…${match.slice(-4)}`;
}

/**
 * Apply the content rules to one file.
 *
 * `ignoreMarkers` is off for build output: a `secret-scan:ignore` comment there
 * is not a reviewed decision, it is whatever survived minification from a
 * source file that already had its own review. `maxBytes` is larger there for
 * the same reason — a bundle is one file where the sources were many, and the
 * server bundle here is already megabytes.
 */
function scanContent(file, { ignoreMarkers = true, maxBytes = 2_000_000 } = {}) {
  if (SKIP_CONTENT.some((pattern) => pattern.test(file))) return;

  const path = resolve(root, file);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return; // Tracked but absent from the working tree (e.g. a sparse checkout).
  }
  if (!stats.isFile() || stats.size > maxBytes) return;

  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  scanText(file, source, { ignoreMarkers });
}

/** The content rules over one text, wherever it was read from. */
function scanText(file, source, { ignoreMarkers = true } = {}) {
  if (source.includes('\0')) return; // Binary without a known extension.

  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (ignoreMarkers && line.includes(IGNORE_MARKER)) return;
    if (ignoreMarkers && index > 0 && lines[index - 1].includes(IGNORE_MARKER)) return;

    for (const { name, pattern, allowValue } of RULES) {
      const match = pattern.exec(line);
      if (!match) continue;
      if (allowValue && allowValue.test(match[1] ?? '')) continue;
      findings.push({ file, line: index + 1, rule: name, excerpt: redact(match[0]) });
    }
  });
}

for (const file of tracked) scanContent(file);

// ---------------------------------------------------------------------------
// 4. The build output (--artifacts).

/** Every file under a directory, as paths relative to the repository root. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(root, full));
  }
  return out;
}

let artifacts = [];
if (scanArtifacts) {
  const dist = resolve(root, 'dist');
  if (!existsSync(dist)) {
    console.error(
      '✗ secret scan: --artifacts asked for the build output and dist/ is not there.\n' +
        '  Run `npm run build` first (`npm run verify` builds before it gets here).',
    );
    process.exit(1);
  }
  artifacts = walk(dist);
  for (const file of artifacts) scanContent(file, { ignoreMarkers: false, maxBytes: ARTIFACT_MAX_BYTES });

  // The one check only the artifacts can fail: a value that exists nowhere in
  // the repository, because it lives in the untracked local `.dev.vars`, and
  // was compiled into a bundle. Every value there is a real credential.
  const devVars = resolve(root, '.dev.vars');
  if (existsSync(devVars)) {
    const values = readFileSync(devVars, 'utf8')
      .split('\n')
      .map((line) => line.replace(/^\s*(?:export\s+)?[A-Za-z0-9_]+\s*=\s*/, '').trim())
      .map((value) => value.replace(/^["']|["']$/g, ''))
      .filter((value) => value.length >= 8 && !value.startsWith('#'));
    for (const file of artifacts) {
      const path = resolve(root, file);
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > ARTIFACT_MAX_BYTES) continue;
      let source;
      try {
        source = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const value of values) {
        if (!source.includes(value)) continue;
        findings.push({
          file,
          line: 0,
          rule: 'local .dev.vars value compiled into the build output',
          excerpt: redact(value),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. The history (--history).

// Text out for the listings; bytes out for anything fed on stdin, which is
// where the blobs come back and where an offset has to count bytes.
const git = (args, input) =>
  input === undefined
    ? execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30, encoding: 'utf8' })
    : execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30, input: Buffer.from(input) });

let history = null;
if (scanHistory) {
  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    console.error(
      '✗ secret scan: --history asked for the history and this clone is shallow.\n' +
        '  `git fetch --unshallow` first: a scan of the commits a clone does not have proves nothing.',
    );
    process.exit(1);
  }
  const refs = git(['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);
  const commits = Number(git(['rev-list', '--all', '--count']).trim());

  // Every path any commit ever added: the forbidden-file rules apply to the
  // past too, and a `.dev.vars` committed once is the finding even if its
  // content matches no rule.
  const everTracked = new Set(git(['log', '--all', '--format=', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean));
  const seen = new Set(findings.map(({ file, rule }) => `${rule}\0${file}`));
  for (const file of everTracked) {
    for (const { pattern, why, allow } of FORBIDDEN_PATHS) {
      if (!pattern.test(file) || allow?.some((exception) => exception.test(file))) continue;
      const rule = `once-tracked file (${why})`;
      if (seen.has(`tracked file (${why})\0${file}`)) continue;
      findings.push({ file: `${file} (history)`, line: 0, rule, excerpt: file });
    }
  }

  // Every blob a ref reaches, once, with the first path it was seen under. The
  // ones the index holds were read above from the working tree.
  const current = new Set(
    git(['ls-files', '-s']).split('\n').filter(Boolean).map((line) => line.split(/\s+/)[1]),
  );
  const objects = git(['rev-list', '--objects', '--all'])
    .split('\n')
    .filter((line) => line.includes(' '))
    .map((line) => ({ sha: line.slice(0, line.indexOf(' ')), path: line.slice(line.indexOf(' ') + 1) }));
  const kinds = git(['cat-file', '--batch-check=%(objecttype) %(objectsize)'], objects.map(({ sha }) => sha).join('\n') + '\n')
    .toString('utf8')
    .split('\n');
  const blobs = objects.filter(({ sha, path }, index) => {
    const [kind, size] = (kinds[index] ?? '').split(' ');
    return kind === 'blob' && !current.has(sha) && Number(size) <= 2_000_000 && !SKIP_CONTENT.some((pattern) => pattern.test(path));
  });

  // One `cat-file --batch` for all of them: "<sha> blob <size>\n<bytes>\n" each.
  const stream = blobs.length ? git(['cat-file', '--batch'], blobs.map(({ sha }) => sha).join('\n') + '\n') : Buffer.alloc(0);
  let offset = 0;
  for (const { sha, path } of blobs) {
    const headerEnd = stream.indexOf(0x0a, offset);
    const size = Number(stream.toString('utf8', offset, headerEnd).split(' ')[2]);
    scanText(`${path} (history, blob ${sha.slice(0, 10)})`, stream.toString('utf8', headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  history = { refs: refs.length, commits, blobs: blobs.length };
}

if (findings.length) {
  console.error(`✗ secret scan: ${findings.length} finding(s)\n`);
  for (const { file, line, rule, excerpt } of findings) {
    console.error(`  ${file}${line ? `:${line}` : ''}  ${rule}\n    ${excerpt}`);
  }
  console.error(
    '\nA real credential must be ROTATED, not just removed — it is already in the history.\n' +
      `A false positive is silenced with a \`${IGNORE_MARKER}\` comment on the line.` +
      (history ? '\nA finding in the history names its blob: `git log --all --find-object=<blob>` lists the commits that carry it.' : ''),
  );
  process.exit(1);
}

console.log(
  `✓ secret scan: ${tracked.length} tracked files` +
    (scanArtifacts ? ` + ${artifacts.length} build artifacts` : '') +
    (history ? ` + ${history.blobs} blobs of history (${history.commits} commits, ${history.refs} refs)` : '') +
    ', no credential found',
);
