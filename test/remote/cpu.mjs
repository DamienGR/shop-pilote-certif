/**
 * Where a deployed shop spends its CPU, read back from a tail capture
 * (plan §8.6, certification étape 6).
 *
 * On the Workers Free plan a request has 10 ms of CPU. Cloudflare tolerates an
 * occasional overrun per isolate — a cold start, which evaluates the code it
 * loads, regularly passes 10 ms — and stops the invocation when the overruns
 * stop being occasional: error 1102 for the visitor, `exceededCpu` in the
 * event. `shopctl monitor` judges the stopped invocations of the whole Worker;
 * this says WHICH route spends what, from the CPU and wall time each event of
 * `wrangler tail --format json` carries.
 *
 *   - A stopped invocation (exceededCpu, exceededMemory, exceededResources)
 *     fails the run: a visitor got an error page.
 *   - Time over 10 ms is counted and not judged: the plan allows it, and the
 *     line is where the operator decides between the paid plan and the cache.
 *   - Cold and warm are told apart by WHEN the capture is taken, not by the
 *     event, which does not say: the first request a route serves after a
 *     deploy or an idle spell loads that route's code (the `1re` column);
 *     a capture taken during the load test gives the warm percentiles.
 *   - The route is the page FILE that answers it (`/products/:slug`), derived
 *     from src/pages the way the security gate derives the admin. The report is
 *     a committed proof, so a URL is never reproduced: a path holds a guest
 *     token or a customer's e-mail (`/admin/customers/:email`), and one that no
 *     file answers is counted as unknown, never named.
 *
 * Run: npx wrangler tail <worker> --format json > tail.json   (while browsing, loading)
 *      npm run test:cpu:remote -- tail.json [--json]
 *
 * Exit: 0 nothing stopped, 1 an invocation stopped, 2 nothing to read — no
 * event, or no event that carries its CPU time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCapture } from './logs.mjs';

/** The Free plan's CPU per request, in milliseconds. */
export const FREE_PLAN_CPU_MS = 10;
const STOPPED = new Set(['exceededCpu', 'exceededMemory', 'exceededResources']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Every route src/pages answers, as a pattern and a matcher. Static before
 * dynamic, and a rest parameter last, as Astro ranks them.
 */
export function pageRoutes(root = 'src/pages') {
  const routes = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (!/\.(astro|ts)$/.test(rel) || /\.test\.ts$/.test(rel) || /(^|\/)_/.test(rel)) continue;
    const segments = rel.replace(/\.(astro|ts)$/, '').split('/');
    if (segments.at(-1) === 'index') segments.pop();
    const pattern = '/' + segments.map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '*').replace(/^\[(.+)\]$/, ':$1')).join('/');
    const source = segments
      .map((s) => (/^\[\.\.\./.test(s) ? '/.+' : /^\[/.test(s) ? '/[^/]+' : '/' + s.replace(/[.*+?^${}()|\\]/g, '\\$&')))
      .join('');
    const rank = segments.reduce((sum, s) => sum + (/^\[\.\.\./.test(s) ? 100 : /^\[/.test(s) ? 1 : 0), 0);
    routes.push({ pattern, rank, test: new RegExp(`^${source || '/'}/?$`) });
  }
  return routes.sort((a, b) => a.rank - b.rank || b.pattern.length - a.pattern.length);
}

/** What answered an event, as a name that holds no visitor's data. */
export function routeOf(event, routes) {
  const info = event?.event;
  if (info?.cron !== undefined) return `cron ${info.cron}`;
  if (!info?.request?.url) return info?.queue ? `file ${info.queue}` : '(autre)';
  let path;
  try {
    path = new URL(info.request.url).pathname;
  } catch {
    return '(URL illisible)';
  }
  const method = info.request.method ?? 'GET';
  const route = routes.find((candidate) => candidate.test.test(path));
  return `${method} ${route ? route.pattern : '(introuvable)'}`;
}

/** Nearest rank: the value at or under which `p` of the sample sits. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (ms) => (ms === null ? null : Math.round(ms * 10) / 10);

export function summariseCpu(events, routes) {
  const byRoute = new Map();
  const outcomes = {};
  let measured = 0;
  let sampled = false;
  for (const event of events) {
    if (event?.event?.type === 'overload') {
      sampled = true;
      continue;
    }
    const outcome = event?.outcome ?? 'inconnue';
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    const name = routeOf(event, routes);
    const entry = byRoute.get(name) ?? { route: name, n: 0, cpu: [], wall: [], first: null, stopped: {} };
    entry.n++;
    if (typeof event.cpuTime === 'number') {
      measured++;
      entry.cpu.push(event.cpuTime);
      if (typeof event.wallTime === 'number') entry.wall.push(event.wallTime);
      const at = event.eventTimestamp ?? Infinity;
      if (entry.first === null || at < entry.first.at) entry.first = { at, cpu: event.cpuTime };
    }
    if (STOPPED.has(outcome)) entry.stopped[outcome] = (entry.stopped[outcome] ?? 0) + 1;
    byRoute.set(name, entry);
  }

  const report = [...byRoute.values()].map(({ route, n, cpu, wall, first, stopped }) => {
    cpu.sort((a, b) => a - b);
    wall.sort((a, b) => a - b);
    return {
      route,
      n,
      measured: cpu.length,
      firstCpuMs: round(first?.cpu ?? null),
      cpuMs: { p50: round(percentile(cpu, 50)), p90: round(percentile(cpu, 90)), p99: round(percentile(cpu, 99)), max: round(cpu.at(-1) ?? null) },
      wallMs: { p50: round(percentile(wall, 50)), p99: round(percentile(wall, 99)) },
      overFreePlan: cpu.filter((ms) => ms > FREE_PLAN_CPU_MS).length,
      stopped,
    };
  });
  report.sort((a, b) => (b.cpuMs.p99 ?? -1) - (a.cpuMs.p99 ?? -1) || b.n - a.n);
  const stopped = report.flatMap(({ route, stopped }) => Object.entries(stopped).map(([outcome, count]) => ({ route, outcome, count })));
  return { events: events.length, measured, sampled, outcomes, routes: report, stopped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
  const file = positionals[0];
  if (!file) {
    console.error('cpu : nommez la capture — npx wrangler tail <worker> --format json > tail.json, puis npm run test:cpu:remote -- tail.json');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`cpu : ${file} illisible (${error.code ?? error.message}).`);
    process.exit(2);
  }
  const { events, ignored } = parseCapture(text);
  if (events.length === 0) {
    console.error(`cpu : aucun événement dans ${file}. La capture est vide, ou n'a pas été prise avec --format json.`);
    process.exit(2);
  }
  // The name, not the path: the report is committed, and a path names the operator's home.
  const report = { file: basename(file), ignoredLines: ignored, ...summariseCpu(events, pageRoutes()) };
  const failed = report.stopped.length > 0;
  const blind = report.measured === 0;

  if (options.json) {
    console.log(JSON.stringify({ ok: !failed && !blind, ...report }, null, 2));
  } else {
    const ms = (value) => (value === null ? '—' : String(value)).padStart(6);
    console.log(`Relevé CPU — ${report.file} : ${report.events} événement(s), ${report.measured} avec leur temps CPU`);
    console.log(`  issues : ${Object.entries(report.outcomes).map(([outcome, n]) => `${outcome} ${n}`).join(', ')}`);
    if (report.sampled) console.log('  ⚠ wrangler a échantillonné la capture (overload) : des événements manquent.');
    console.log(`\n${'route'.padEnd(40)} ${'n'.padStart(5)}  CPU ms 1re    p50    p90    p99    max  >${FREE_PLAN_CPU_MS} ms   mur ms p50    p99`);
    for (const row of report.routes) {
      console.log(
        `${row.route.padEnd(40)} ${String(row.n).padStart(5)}      ${ms(row.firstCpuMs)} ${ms(row.cpuMs.p50)} ${ms(row.cpuMs.p90)} ${ms(row.cpuMs.p99)} ${ms(row.cpuMs.max)} ${String(row.overFreePlan).padStart(6)}          ${ms(row.wallMs.p50)} ${ms(row.wallMs.p99)}`,
      );
    }
    console.log('\n▸ 1re : la première requête de la route dans la capture. Prise juste après un déploiement ou un temps mort,');
    console.log('  c\'est son coût à froid (le code de la route chargé) ; pendant la charge, les percentiles sont le chaud.');
    console.log(`▸ Au-delà de ${FREE_PLAN_CPU_MS} ms — relevé, non jugé : le plan gratuit tolère un dépassement occasionnel par isolat (un démarrage à froid en est un).`);
    console.log('▸ Invocations arrêtées par Cloudflare (erreur 1102 pour le visiteur)');
    for (const { route, outcome, count } of report.stopped) console.log(`  ✗ ${route} — ${outcome} × ${count}`);
    if (!failed) console.log('  ✓ aucune');
    if (blind) {
      console.log('\n⚠ aucun événement ne porte son temps CPU : ce flux ne le donne pas. Workers Logs (Observabilité de la boutique,');
      console.log('  dans le tableau de bord) donne le CPU de chaque invocation ; le monitor en donne le p99 du Worker entier.');
    }
    console.log(failed ? '\n✗ Cloudflare a arrêté des invocations.' : blind ? '\n· rien à juger sur le CPU.' : '\n✓ aucune invocation arrêtée.');
  }
  process.exit(failed ? 1 : blind ? 2 : 0);
}
