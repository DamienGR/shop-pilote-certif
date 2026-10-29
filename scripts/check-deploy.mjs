#!/usr/bin/env node
/**
 * Deployability gate: does the built storefront actually ship, and is it still
 * the size it is supposed to be?
 *
 * `astro build` proves the code compiles; it says nothing about whether
 * Wrangler accepts the generated configuration — an unknown compatibility flag,
 * a malformed binding or a missing migration tag only surfaces at `wrangler
 * deploy`, i.e. in production, on a client's account. The dry run does the whole
 * deploy except the upload, so the failure lands in CI instead.
 *
 * The same run gives the size budget for free. Two properties are worth
 * defending on every commit:
 *
 *  1. the Worker bundle stays far below the platform's compressed-size limit,
 *     because crossing it turns an ordinary merge into an outage nobody can
 *     deploy their way out of;
 *  2. the storefront stays near-zero client JS (invariant 1). One accidental
 *     client-side framework import multiplies this figure; nothing else in the
 *     test suite would notice.
 *
 * Budgets are ceilings with headroom, not targets: they exist to catch a step
 * change, not to police kilobytes. Raise one deliberately, in its own commit,
 * with the reason.
 *
 * Usage: npm run check:deploy  (after a build; `npm run verify` chains both)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const generatedConfig = resolve(root, 'dist/server/wrangler.json');
const clientDir = resolve(root, 'dist/client');

const KIB = 1024;

// Measured at the jalon 0 baseline: 740 KiB gzipped Worker (sum of per-file
// gzip), 5.5 KiB client JS. Cloudflare's own ceiling is 3 MiB gzipped on the
// free plan, so the Worker budget leaves a year of ordinary growth while still
// failing on a step change.
const BUDGETS = {
  workerGzipKiB: 1024,
  clientJsKiB: 24,
};

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!existsSync(generatedConfig)) {
  fail(`missing ${generatedConfig} — run \`npm run build\` first`);
}

// ---------------------------------------------------------------------------
// The dry run. --outdir keeps the emitted bundle out of dist/ so a later
// `deploy --skip-build` cannot pick up files this check produced.

const outDir = mkdtempSync(join(tmpdir(), 'minshop-deploy-check-'));

try {
  execFileSync(
    'npx',
    ['wrangler', 'deploy', '--dry-run', '--config', generatedConfig, '--outdir', outDir],
    { cwd: root, stdio: 'inherit' },
  );
} catch {
  rmSync(outDir, { recursive: true, force: true });
  fail('`wrangler deploy --dry-run` rejected the built storefront (see output above)');
}

// ---------------------------------------------------------------------------
// Sizes, measured from the emitted bundle rather than parsed out of Wrangler's
// human-readable table: the numbers stay comparable across Wrangler versions.

function filesUnder(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, predicate));
    else if (predicate(entry.name)) out.push(path);
  }
  return out;
}

const isScript = (name) => name.endsWith('.js') || name.endsWith('.mjs');

const workerFiles = filesUnder(outDir, isScript);
const workerRaw = workerFiles.reduce((total, file) => total + statSync(file).size, 0);
// Sum of per-file gzip, which is what the platform bills and limits.
const workerGzip = workerFiles.reduce(
  (total, file) => total + gzipSync(readFileSync(file)).byteLength,
  0,
);

// The upload carries no local secrets file. The build leaves one next to the
// generated config, `dist/server/.dev.vars`, for `npm run preview`; the secret
// scan leaves that copy alone on the strength of this check — wrangler bundles
// modules, never the file. Asserted on the dry run's output, which is the upload.
const shippedDevVars = filesUnder(outDir, (name) => name.startsWith('.dev.vars'));

const clientJsFiles = existsSync(clientDir) ? filesUnder(clientDir, isScript) : [];
const clientJs = clientJsFiles.reduce((total, file) => total + statSync(file).size, 0);

rmSync(outDir, { recursive: true, force: true });

if (shippedDevVars.length > 0) {
  fail('the deploy would upload a local .dev.vars — its values are real credentials, never part of a Worker');
}

const measurements = [
  {
    label: 'Worker bundle (gzip)',
    kib: workerGzip / KIB,
    budget: BUDGETS.workerGzipKiB,
    detail: `${workerFiles.length} modules, ${(workerRaw / KIB).toFixed(1)} KiB uncompressed`,
  },
  {
    label: 'Client JavaScript',
    kib: clientJs / KIB,
    budget: BUDGETS.clientJsKiB,
    detail: `${clientJsFiles.length} file(s) under dist/client`,
  },
];

let over = false;
for (const { label, kib, budget, detail } of measurements) {
  const status = kib <= budget ? '✓' : '✗';
  if (kib > budget) over = true;
  console.log(`${status} ${label}: ${kib.toFixed(1)} KiB / ${budget} KiB budget — ${detail}`);
}

if (over) {
  fail(
    'bundle budget exceeded — find what grew before raising the budget, and raise it in its own commit',
  );
}

console.log('✓ storefront deploys (dry run) and stays within its size budgets');
