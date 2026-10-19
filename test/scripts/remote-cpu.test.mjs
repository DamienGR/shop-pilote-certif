import { describe, expect, it } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pageRoutes, routeOf, summariseCpu } from '../remote/cpu.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = resolve(ROOT, 'test/remote/cpu.mjs');
const ROUTES = pageRoutes(join(ROOT, 'src/pages'));
const GUEST_TOKEN = 'otk_' + 'Ab3dEf5hIj7lMn9pQr1tUw';

/** One event as `wrangler tail --format json` prints it, with its metrics. */
function fetchEvent({ url = 'https://shop.example/', method = 'GET', cpuTime = 4, wallTime = 30, outcome = 'ok', at = 1 } = {}) {
  return {
    outcome,
    scriptName: 'minshop-witness-staging',
    exceptions: [],
    logs: [],
    eventTimestamp: at,
    cpuTime,
    wallTime,
    event: { request: { url, method, headers: {}, cf: {} }, response: { status: 200 } },
  };
}

const capture = (events) => events.map((event) => JSON.stringify(event, null, 4)).join('\n') + '\n';

function run(text) {
  const dir = mkdtempSync(join(tmpdir(), 'cpu-'));
  try {
    writeFileSync(join(dir, 'tail.json'), text);
    return spawnSync(process.execPath, [SCRIPT, join(dir, 'tail.json')], { cwd: ROOT, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the CPU reader', () => {
  it('names a request by the page file that answers it, never by its URL', () => {
    const name = (url, method) => routeOf(fetchEvent({ url, method }), ROUTES);
    expect(name('https://shop.example/')).toBe('GET /');
    expect(name('https://shop.example/products/cabas-en-lin?variant=2')).toBe('GET /products/:slug');
    expect(name('https://shop.example/categories/maison')).toBe('GET /categories/:slug');
    expect(name('https://shop.example/images/media/abc.png')).toBe('GET /images/*');
    expect(name(`https://shop.example/order/${GUEST_TOKEN}`)).toBe('GET /order/:token');
    expect(name('https://shop.example/admin/customers/jeanne@example.fr')).toBe('GET /admin/customers/:email');
    expect(name('https://shop.example/sitemap.xml')).toBe('GET /sitemap.xml');
    expect(name('https://shop.example/api/cart', 'POST')).toBe('POST /api/cart');
    // A static file beats a parameter beside it, as Astro ranks them.
    expect(name('https://shop.example/admin/products/new')).toBe('GET /admin/products/new');
    expect(name('https://shop.example/wp-login.php')).toBe('GET (introuvable)');
    expect(routeOf({ event: { cron: '*/5 * * * *' } }, ROUTES)).toBe('cron */5 * * * *');
  });

  it('gives each route its percentiles, its first request, and its time over the free plan', () => {
    const events = [
      fetchEvent({ url: 'https://shop.example/products/a', cpuTime: 31, at: 1 }),
      ...Array.from({ length: 9 }, (_, i) => fetchEvent({ url: `https://shop.example/products/p${i}`, cpuTime: 5 + i, at: 2 + i })),
      fetchEvent({ url: 'https://shop.example/', cpuTime: 6, at: 3 }),
    ];
    const report = summariseCpu(events, ROUTES);
    expect(report.measured).toBe(11);
    const product = report.routes[0];
    expect(product.route).toBe('GET /products/:slug');
    expect(product.n).toBe(10);
    expect(product.firstCpuMs).toBe(31);
    expect(product.cpuMs).toEqual({ p50: 9, p90: 13, p99: 31, max: 31 });
    expect(product.overFreePlan).toBe(4);
    expect(report.stopped).toEqual([]);
  });

  it('fails on an invocation Cloudflare stopped, and reports time over 10 ms without judging it', () => {
    const slow = run(capture([fetchEvent({ cpuTime: 48 }), fetchEvent({ cpuTime: 12 })]));
    expect(slow.status).toBe(0);
    expect(slow.stdout).toContain('✓ aucune invocation arrêtée');

    const stopped = run(capture([fetchEvent({ url: `https://shop.example/order/${GUEST_TOKEN}`, outcome: 'exceededCpu', cpuTime: 52 })]));
    expect(stopped.status).toBe(1);
    expect(stopped.stdout).toContain('GET /order/:token — exceededCpu × 1');
    // The report is a committed proof: the token in the path is never in it.
    expect(stopped.stdout).not.toContain(GUEST_TOKEN);
  });

  it('says so when the capture carries no CPU time, and when there is nothing to read', () => {
    const event = fetchEvent();
    delete event.cpuTime;
    delete event.wallTime;
    const blind = run(capture([event]));
    expect(blind.status).toBe(2);
    expect(blind.stdout).toContain('aucun événement ne porte son temps CPU');

    const empty = run('Connected to minshop, waiting for logs...\n');
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('aucun événement');
  });
});
