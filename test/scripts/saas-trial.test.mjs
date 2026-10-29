import { afterEach, describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { OPERATOR_ENV } from '../helpers/operator-env.mjs';

/**
 * The real-account trial of ADR 0019, lot 3 (`scripts/saas-trial.mjs`),
 * rehearsed: the API double for the zone and its custom hostnames, a wrangler
 * that records what it would deploy, and a stand-in for Cloudflare's network
 * that routes each hostname by the routes deployed and runs the Worker that
 * was uploaded. What it cannot rehearse is the reason the trial exists — that
 * Cloudflare itself routes a custom hostname by a route on the SaaS zone — so
 * this keeps the script in working order for the day it runs, no more.
 */

vi.setConfig({ testTimeout: 60_000 });

const CORE = new URL('../../', import.meta.url).pathname;
const SCRIPT = resolve(CORE, 'scripts/saas-trial.mjs');
const DOUBLE = resolve(CORE, 'test/fixtures/cloudflare-api-double.mjs');
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ZONE = 'boutiques.agence.example';
const DOMAIN = 'commercant.example.fr';
const FALLBACK = `fallback.${ZONE}`;

// Records each call, and keeps the uploaded Worker beside its configuration.
const WRANGLER = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
const at = argv.indexOf('--config');
const config = at === -1 ? null : JSON.parse(readFileSync(argv[at + 1], 'utf8'));
const source = config ? readFileSync(join(dirname(argv[at + 1]), config.main), 'utf8') : null;
appendFileSync(process.env.SAAS_TRIAL_WRANGLER_LOG, JSON.stringify({ argv, config, source, account: process.env.CLOUDFLARE_ACCOUNT_ID }) + '\\n');
if (argv[0] === 'delete' && process.env.SAAS_TRIAL_WRANGLER_ABSENT) {
  console.error('✘ [ERROR] This Worker does not exist on your account. [code: 10007]');
  process.exit(1);
}
`;

const running = [];
afterEach(() => {
  for (const close of running.splice(0)) close();
});

async function trial({ api: patch = {}, swap = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saas-trial-'));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules/.bin/wrangler'), WRANGLER);
  chmodSync(join(root, 'node_modules/.bin/wrangler'), 0o755);
  const log = join(root, 'wrangler.log');
  writeFileSync(log, '');

  const state = join(root, 'cloudflare.json');
  writeFileSync(
    state,
    JSON.stringify({
      zones: [{ id: 'zone-saas', name: ZONE, account: ACCOUNT }],
      fallback: { 'zone-saas': { origin: FALLBACK, status: 'active' } },
      hostnames: [],
      ...patch,
    }),
  );
  const double = spawn('node', [DOUBLE, state], { stdio: ['ignore', 'pipe', 'inherit'] });
  running.push(() => double.kill());
  const [chunk] = await once(double.stdout, 'data');
  const api = chunk.toString().trim();

  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

  // Cloudflare's network: a hostname goes to the Worker whose route names it,
  // and anything no route names gets the error page an unreachable origin gets.
  const network = createServer(async (request, response) => {
    const [, hostname, ...rest] = new URL(request.url, 'http://network').pathname.split('/');
    const deployed = new Map();
    for (const call of calls()) {
      if (call.argv[0] === 'deploy') for (const route of call.config.routes) deployed.set(route.pattern, call);
    }
    let target = deployed.get(`${hostname}/*`);
    if (swap && target) target = [...deployed.values()].find((call) => call !== target);
    if (!target) {
      response.writeHead(hostname.endsWith('.workers.dev') ? 404 : 522).end('<html>error</html>');
      return;
    }
    const worker = await import(`data:text/javascript,${encodeURIComponent(target.source)}`);
    const answer = await worker.default.fetch(new Request(`https://${hostname}/${rest.join('/')}`));
    response.writeHead(answer.status, { 'content-type': 'application/json', 'cf-ray': 'essai-CDG' }).end(await answer.text());
  });
  network.listen(0, '127.0.0.1');
  await once(network, 'listening');
  running.push(() => network.close());

  const env = {
    ...process.env,
    ...OPERATOR_ENV,
    CLOUDFLARE_API_TOKEN: 'trial-token',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_BASE_URL: api,
    SAAS_TRIAL_ORIGIN: `http://127.0.0.1:${network.address().port}`,
    SAAS_TRIAL_WRANGLER_LOG: log,
  };
  const run = (args, extra = {}) =>
    new Promise((done) => {
      // Asynchronous, unlike the shopctl suites: the network above lives in
      // this process and must answer while the script waits on it.
      execFile('node', [SCRIPT, ...args], { cwd: root, env: { ...env, ...extra } }, (error, stdout, stderr) => {
        done({ status: error ? error.code : 0, stdout, stderr });
      });
    });
  const read = () => JSON.parse(readFileSync(state, 'utf8'));
  const activate = () => {
    const current = read();
    for (const record of current.hostnames) {
      record.status = 'active';
      record.ssl.status = 'active';
      record.created_at = new Date(Date.now() - 7 * 60_000).toISOString();
    }
    writeFileSync(state, JSON.stringify(current));
  };
  return { root, run, read, calls, activate };
}

const ARGS = ['--zone', ZONE, '--domain', DOMAIN];

describe('the trial script', () => {
  it('refuses a command line it cannot act on, before calling anyone', async () => {
    const { run, read } = await trial();
    expect((await run([])).status).toBe(EXIT_CODES.usage);
    expect((await run(['prepare', '--zone', ZONE])).status).toBe(EXIT_CODES.usage);
    // A hostname inside the zone would prove nothing about a merchant's domain.
    const inside = await run(['prepare', '--zone', ZONE, '--domain', `boutique.${ZONE}`]);
    expect(inside.status).toBe(EXIT_CODES.input);
    expect(inside.stderr).toMatch(/est dans la zone SaaS/);
    const blind = await run(['verify', ...ARGS], { CLOUDFLARE_API_TOKEN: '' });
    expect(blind.status).toBe(EXIT_CODES.precondition);
    expect(blind.stderr).toMatch(/read -rs CLOUDFLARE_API_TOKEN/);
    expect(read().requests ?? []).toEqual([]);
  });

  it('creates two hostnames and deploys two Workers routed the way a shop is', async () => {
    const { run, read, calls } = await trial();
    const first = await run(['prepare', ...ARGS]);
    expect(first.status, first.stderr).toBe(EXIT_CODES.ok);
    expect(first.stdout).toContain(`CNAME essai-a.${DOMAIN} → ${FALLBACK}`);
    expect(first.stdout).toContain(`CNAME essai-b.${DOMAIN} → ${FALLBACK}`);

    const created = read().requests.filter((request) => request.method === 'POST');
    expect(created.map((request) => request.body.hostname)).toEqual([`essai-a.${DOMAIN}`, `essai-b.${DOMAIN}`]);
    for (const request of created) expect(request.body.ssl).toEqual({ method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } });

    const template = readFileSync(resolve(CORE, 'wrangler.template.jsonc'), 'utf8');
    const date = template.match(/"compatibility_date":\s*"([^"]+)"/)[1];
    expect(calls().map((call) => call.config)).toEqual(
      ['a', 'b'].map((trialName) => ({
        name: `minshop-essai-${trialName}`,
        main: 'worker.js',
        compatibility_date: date,
        workers_dev: false,
        routes: [{ pattern: `essai-${trialName}.${DOMAIN}/*`, zone_name: ZONE }],
      })),
    );
    expect(calls().every((call) => call.account === ACCOUNT)).toBe(true);

    // Run again, it finds both hostnames rather than creating two more.
    expect((await run(['prepare', ...ARGS])).status).toBe(EXIT_CODES.ok);
    expect(read().hostnames).toHaveLength(2);
  });

  it('waits while the DNS is not in place, then finds each hostname served by its own Worker', async () => {
    const { run, activate } = await trial({ api: { subdomain: 'agence' } });
    expect((await run(['prepare', ...ARGS])).status).toBe(EXIT_CODES.ok);

    const pending = await run(['verify', ...ARGS]);
    expect(pending.status).toBe(EXIT_CODES.precondition);
    expect(pending.stderr).toMatch(/en attente : essai-a\..+, essai-b\./);

    activate();
    const green = await run(['verify', ...ARGS]);
    expect(green.status, green.stdout + green.stderr).toBe(EXIT_CODES.ok);
    expect(green.stdout).toContain(`essai-a.${DOMAIN} — HTTP 200 en HTTPS, servi par minshop-essai-a`);
    expect(green.stdout).toContain(`essai-b.${DOMAIN} — HTTP 200 en HTTPS, servi par minshop-essai-b`);
    expect(green.stdout).toContain(`${FALLBACK} — sans route, n'atteint aucun Worker (HTTP 522)`);
    expect(green.stdout).toContain('minshop-essai-a.agence.workers.dev — fermé (HTTP 404)');
    expect(green.stdout).toContain('Essai vert');
  });

  it('fails when a hostname reaches the other Worker', async () => {
    const { run, activate } = await trial({ swap: true });
    expect((await run(['prepare', ...ARGS])).status).toBe(EXIT_CODES.ok);
    activate();
    const red = await run(['verify', ...ARGS]);
    expect(red.status).toBe(EXIT_CODES.verification);
    expect(red.stdout).toMatch(/✗ essai-a\.\S+ — HTTP 200, attendu minshop-essai-a ; reçu .*minshop-essai-b/);
    expect(red.stdout).toContain('Essai rouge');
    // Without the subdomain it says what it did not check, and fails nothing for it.
    expect(red.stdout).toContain('workers.dev — non vérifié');
  });

  it('removes each Worker, then its hostname, and runs again on what is already gone', async () => {
    const { run, read, calls } = await trial();
    expect((await run(['prepare', ...ARGS])).status).toBe(EXIT_CODES.ok);
    const cleaned = await run(['clean', ...ARGS]);
    expect(cleaned.status, cleaned.stdout).toBe(EXIT_CODES.ok);
    expect(calls().filter((call) => call.argv[0] === 'delete').map((call) => call.argv)).toEqual([
      ['delete', '--name', 'minshop-essai-a'],
      ['delete', '--name', 'minshop-essai-b'],
    ]);
    expect(read().hostnames).toEqual([]);
    expect(cleaned.stdout).toContain(`Reste à la main : les CNAME essai-a et essai-b de la zone ${DOMAIN}`);

    const again = await run(['clean', ...ARGS], { SAAS_TRIAL_WRANGLER_ABSENT: '1' });
    expect(again.status).toBe(EXIT_CODES.ok);
    expect(again.stdout).toContain('minshop-essai-a — absent');
    expect(again.stdout).toContain(`essai-a.${DOMAIN} — nom d'hôte absent`);
  });

  it('leaves no Worker source behind', async () => {
    const { run, calls } = await trial();
    expect((await run(['prepare', ...ARGS])).status).toBe(EXIT_CODES.ok);
    for (const call of calls()) {
      const directory = call.argv[call.argv.indexOf('--config') + 1].replace(/\/wrangler\.json$/, '');
      expect(existsSync(directory)).toBe(false);
    }
  });
});
