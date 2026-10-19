/**
 * `shopctl monitor` — the supervision decision of the certification plan.
 *
 * The thresholds are pure and tested as such; the command is run for real
 * against the wrangler double (account, database id) and a GraphQL double in
 * its own process (the analytics). What no double replaces is the first run
 * against Cloudflare's own schema, which is why a refusal from the API is an
 * exit 5 here rather than a quiet pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { FREE_PLAN, evaluateMonitor, summariseDatabase, summariseWorker } from '../../shopctl/src/commands/monitor.mjs';
import { ACCOUNT, names, shop } from '../helpers/provisioned-shop.mjs';

vi.setConfig({ testTimeout: 60_000 });

const DOUBLE = new URL('../fixtures/graphql-double.mjs', import.meta.url).pathname;

const quiet = { requests: 50_000, errors: 10, cpuP99Ms: 2 };
const idle = { rowsRead: 100_000, rowsWritten: 1_000 };
const failing = (checks) => checks.filter((check) => !check.ok).map((check) => check.name);

describe('the thresholds', () => {
  it('passes a healthy day on the free plan', () => {
    expect(failing(evaluateMonitor(quiet, idle, { plan: 'free', hours: 24 }))).toEqual([]);
  });

  it('fails past one per cent of errors', () => {
    expect(failing(evaluateMonitor({ ...quiet, errors: 600 }, idle, { plan: 'paid', hours: 24 }))).toEqual(['taux d\'erreur']);
  });

  // Three errors out of ten requests is a deploy someone is testing, not an
  // incident; judging it would teach people to ignore the alarm.
  it('reports a rate it does not judge below a hundred requests', () => {
    const [rate] = evaluateMonitor({ requests: 10, errors: 3, cpuP99Ms: 1 }, idle, { plan: 'paid', hours: 24 });
    expect(rate).toMatchObject({ ok: true, judged: false });
  });

  // The day to move to Workers Paid is the day 70 % is reached, not the day the
  // shop starts answering 1027.
  it('rings at seventy per cent of each free quota', () => {
    const busy = { requests: 0.75 * FREE_PLAN.requestsPerDay, errors: 0, cpuP99Ms: 2 };
    expect(failing(evaluateMonitor(busy, idle, { plan: 'free', hours: 24 }))).toEqual(['requêtes Workers (plan gratuit)']);
    expect(failing(evaluateMonitor(quiet, { rowsRead: 4_000_000, rowsWritten: 80_000 }, { plan: 'free', hours: 24 }))).toEqual([
      'lignes D1 lues (plan gratuit)',
      'lignes D1 écrites (plan gratuit)',
    ]);
  });

  // Cloudflare enforces 10 ms by isolate, tolerating an occasional overrun: a
  // small shop's p99 is its cold starts, over the limit by construction. What
  // the plan cannot absorb is an invocation it stopped (1102).
  it('reports the CPU p99 without judging it, and fails on an invocation Cloudflare stopped', () => {
    const coldStarts = evaluateMonitor({ ...quiet, cpuP99Ms: 36 }, idle, { plan: 'free', hours: 24 });
    expect(failing(coldStarts)).toEqual([]);
    expect(coldStarts.find((check) => check.name === 'CPU p99')).toMatchObject({ judged: false, value: 36 });
    expect(failing(evaluateMonitor({ ...quiet, exceededResources: 1 }, idle, { plan: 'free', hours: 24 }))).toEqual([
      'invocations arrêtées (plan gratuit)',
    ]);
  });

  it('scales a short window up to a day before comparing it with a daily quota', () => {
    const sixHours = { requests: 20_000, errors: 0, cpuP99Ms: 1 };
    expect(failing(evaluateMonitor(sixHours, idle, { plan: 'free', hours: 6 }))).toEqual(['requêtes Workers (plan gratuit)']);
  });

  it('leaves the free quotas alone on the paid plan', () => {
    const busy = { requests: 10 * FREE_PLAN.requestsPerDay, errors: 0, exceededResources: 3, cpuP99Ms: 40 };
    expect(failing(evaluateMonitor(busy, { rowsRead: 1e9, rowsWritten: 1e7 }, { plan: 'paid', hours: 24 }))).toEqual([]);
  });

  it('adds the status groups up and reads CPU time in microseconds', () => {
    expect(
      summariseWorker([
        { sum: { requests: 900, errors: 0 }, quantiles: { cpuTimeP99: 1500 }, dimensions: { status: 'success' } },
        { sum: { requests: 100, errors: 100 }, quantiles: { cpuTimeP99: 4200 }, dimensions: { status: 'scriptThrewException' } },
        { sum: { requests: 2, errors: 2 }, quantiles: { cpuTimeP99: 11000 }, dimensions: { status: 'exceededResources' } },
      ]),
    ).toEqual({ requests: 1002, errors: 102, exceededResources: 2, cpuP99Ms: 11 });
    expect(summariseWorker([])).toEqual({ requests: 0, errors: 0, exceededResources: 0, cpuP99Ms: null });
  });

  it('takes the busiest day of the window for D1', () => {
    expect(
      summariseDatabase([
        { sum: { rowsRead: 10, rowsWritten: 500 }, dimensions: { date: '2026-10-05' } },
        { sum: { rowsRead: 900, rowsWritten: 2 }, dimensions: { date: '2026-10-06' } },
      ]),
    ).toEqual({ rowsRead: 900, rowsWritten: 500 });
  });
});

describe('shopctl monitor', () => {
  const doubles = [];
  afterEach(() => {
    for (const child of doubles.splice(0)) child.kill();
  });

  /** A GraphQL double in its own process, answering from `state`. */
  async function analytics(state) {
    const file = join(mkdtempSync(join(tmpdir(), 'shopctl-graphql-')), 'state.json');
    writeFileSync(file, JSON.stringify(state));
    const child = spawn('node', [DOUBLE, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    doubles.push(child);
    const [chunk] = await once(child.stdout, 'data');
    return { origin: chunk.toString().trim(), read: () => JSON.parse(readFileSync(file, 'utf8')) };
  }

  function provisioned() {
    const target = shop();
    expect(target.run(['provision', '--env', 'staging']).status).toBe(EXIT_CODES.ok);
    return target;
  }

  const healthy = {
    worker: [{ sum: { requests: 5000, errors: 2, subrequests: 0 }, quantiles: { cpuTimeP99: 1800 }, dimensions: { status: 'success' } }],
    d1: [{ sum: { readQueries: 100, writeQueries: 3, rowsRead: 20_000, rowsWritten: 40 }, dimensions: { date: '2026-10-06' } }],
  };
  const env = (origin) => ({ CLOUDFLARE_API_TOKEN: 'analytics-read-token', CLOUDFLARE_API_BASE_URL: origin });

  it('asks about this environment’s Worker and database, and passes a healthy one', async () => {
    const target = provisioned();
    const api = await analytics(healthy);
    const { report, status, stderr } = target.json(['monitor', '--env', 'staging'], env(api.origin));

    expect(status, stderr).toBe(EXIT_CODES.ok);
    expect(report).toMatchObject({ ok: true, env: 'staging', plan: 'free', worker: { requests: 5000, errors: 2, cpuP99Ms: 1.8 } });
    const [worker, database] = api.read().requests;
    expect(worker.path).toBe('/graphql');
    expect(worker.authorization).toBe('Bearer analytics-read-token');
    expect(worker.variables).toMatchObject({ account: ACCOUNT.id, script: names(target.slug, 'staging').worker });
    expect(database.variables.database).toBe(target.read().d1[0].uuid);
  });

  it('fails the run when a threshold is crossed, and says what to do', async () => {
    const target = provisioned();
    const api = await analytics({ ...healthy, d1: [{ sum: { rowsRead: 4_500_000, rowsWritten: 10 }, dimensions: { date: '2026-10-06' } }] });
    const result = target.json(['monitor', '--env', 'staging'], env(api.origin));

    expect(result.status).toBe(EXIT_CODES.verification);
    expect(result.report.ok).toBe(false);
    expect(result.stderr).toMatch(/Workers Paid/);
  });

  // "Could not ask" must never render as "nothing to report".
  it('treats a refusal from the API as a failure, not a quiet night', async () => {
    const target = provisioned();
    const api = await analytics({ errors: [{ message: 'unknown field "rowsRead"' }] });
    const result = target.run(['monitor', '--env', 'staging'], env(api.origin));
    expect(result.status).toBe(EXIT_CODES.external);
    expect(result.stderr).toMatch(/unknown field/);
  });

  it('treats an unreachable endpoint the same way', () => {
    const target = provisioned();
    const result = target.run(['monitor', '--env', 'staging'], env('http://127.0.0.1:1'));
    expect(result.status).toBe(EXIT_CODES.external);
  });

  it('refuses to start without an API token', () => {
    const target = provisioned();
    const result = target.run(['monitor', '--env', 'staging']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/CLOUDFLARE_API_TOKEN/);
  });

  it('refuses an environment that was never provisioned', async () => {
    const target = shop();
    const api = await analytics(healthy);
    expect(target.run(['monitor', '--env', 'production'], env(api.origin)).status).toBe(EXIT_CODES.precondition);
  });

  it('refuses a plan it does not know', () => {
    expect(shop().run(['monitor', '--env', 'staging', '--plan', 'pro']).status).toBe(EXIT_CODES.usage);
  });
});
