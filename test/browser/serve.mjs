#!/usr/bin/env node
/**
 * The store the browser suite drives: the BUILT Worker, on a seeded, isolated D1.
 *
 * Built and not `astro dev`, deliberately. Half of what this suite exists to
 * check only exists after a build — the client scripts are bundled and
 * minified there, and the stylesheet is the one Tailwind actually compiled for
 * the selected theme. A dev server would have let the `en-US` price bug through
 * a second time, in a different disguise.
 *
 * Isolated and not `.wrangler/state`, for the same reason
 * test/integration/storefront-baselines.sh is: a suite that reads whatever a
 * developer last put in their local database asserts nothing. The state
 * directory is a fresh temp dir per run, seeded from the SAME two fixtures the
 * baselines gate uses, so a state visible here is a state visible there.
 *
 * Playwright owns readiness and teardown (`webServer` in playwright.config.mjs),
 * which is why there is no polling loop here — the one place this file differs
 * from the bash boot beside it, and the reason it is not shared with it.
 *
 * Usage: node test/browser/serve.mjs <port>
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminPasswordHash } from './admin.mjs';

const port = process.argv[2] ?? '8788';

if (!existsSync('dist/server/wrangler.json')) {
  console.error(
    'browser suite: no build to serve. Run `npm run build` first — or use ' +
      '`npm run test:browser`, which builds for you.',
  );
  process.exit(1);
}

const state = mkdtempSync(join(tmpdir(), 'minshop-browser-'));
const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', './seed.sql']);
wrangler([
  'd1', 'execute', 'DB', '--local', '--persist-to', state,
  '--file', './test/fixtures/storefront-states.sql',
]);
// An admin password, for the specs that save in Admin → Réglages. Here and not
// in the shared fixtures: the baselines gate has no admin to log into.
wrangler([
  'd1', 'execute', 'DB', '--local', '--persist-to', state,
  '--command', `INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', '${adminPasswordHash()}')`,
]);

// The gallery rows point at object keys. Without the objects the product page
// renders broken images, and "does this image actually load" is one of the
// things the suite asks.
const bucket = bucketName();
for (const key of ['media/tee-front.jpg', 'media/tee-back.jpg']) {
  wrangler([
    'r2', 'object', 'put', `${bucket}/${key}`, '--local', '--persist-to', state,
    '--file', 'public/placeholder.png', '--content-type', 'image/png',
  ]);
}

const child = spawn(
  'npx',
  [
    'wrangler', 'dev',
    '--config', 'dist/server/wrangler.json',
    '--persist-to', state,
    '--var', 'CANONICAL_ORIGIN:https://canonical.example',
    '--var', 'AUTH_SECRET:browser-suite-auth-secret',
    // Without a vault, Réglages shows no key field to save.
    '--var', 'SECRETS_KEK:browser-suite-key-encryption-key',
    '--ip', '127.0.0.1',
    '--port', port,
  ],
  { stdio: 'inherit' },
);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));

/** The R2 bucket this build is bound to, read from the rendered config rather
 *  than from wrangler.jsonc: the build is what the suite serves, and a shop's
 *  rendered config names its own buckets. */
function bucketName() {
  const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
  const found = config.r2_buckets?.find((b) => b.binding === 'BUCKET');
  if (!found) throw new Error('the built Worker has no BUCKET binding');
  return found.bucket_name;
}
