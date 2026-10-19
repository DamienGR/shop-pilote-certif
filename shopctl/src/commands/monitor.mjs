/**
 * `shopctl monitor` — is this environment healthy, and is it about to hit a
 * limit of its Cloudflare plan?
 *
 * The supervision decision of the certification plan (étape 0), and the reason
 * it is a command rather than a list of dashboard toggles: Cloudflare's
 * notification catalogue has no alert for a Worker's error rate, its CPU time
 * or a D1 quota on the plans a shop runs on — the nearest ones ("Usage Based
 * Billing", "Origin Error Rate") are Pro-and-up or Enterprise. What every plan
 * does have is the GraphQL Analytics API, so the supervision asks it, and a
 * scheduled workflow runs the question every night. A threshold crossed fails
 * the run, and a failed run is a notification GitHub already knows how to send.
 *
 * Read-only, and it says so by construction: one POST to the analytics
 * endpoint, two wrangler reads to find the account and the database id.
 *
 * Two thresholds families:
 *
 *  - HEALTH, on every plan: the share of invocations that ended in error, over
 *    the window. Below a hundred requests the ratio is noise and is reported
 *    without being judged.
 *  - QUOTAS, on the Workers Free plan only: 100 000 requests a day, 5 million
 *    D1 rows read and 100 000 written a day. Past them the shop answers errors
 *    until midnight UTC, with nothing to do but wait — so the alarm rings at
 *    70 %, which is the day the merchant should move the account to Workers
 *    Paid, not the day the shop stops.
 *  - CPU, on the Workers Free plan only: 10 ms per request, a limit Cloudflare
 *    enforces by isolate and not by request — an isolate that runs over now
 *    and then is tolerated, one that does it regularly has its invocations
 *    stopped (error 1102, status `exceededResources`). So the judged signal is
 *    the count of invocations stopped, and the p99 is reported unjudged: a
 *    small shop's p99 is its cold starts, which run over by construction and
 *    were judged red every night of the certification's staging while no
 *    request was ever stopped (étape 6).
 *
 * "Could not ask" is never "nothing to report": an analytics error or an
 * unreachable endpoint is exit 5, not a green run.
 */
import { listDatabases, expectedAccount, resolveAccount, whoami } from '../cloudflare.mjs';
import { externalError, preconditionError, usageError, verificationError } from '../errors.mjs';
import { requireEnvironment, resolveShop } from '../shop.mjs';
import { resourceNames } from '../../../scripts/manifest.mjs';

export const MONITOR_OPTIONS = { '--env': 'environnement', '--shop': 'slug', '--account': 'id', '--plan': 'free|paid', '--hours': 'heures' };

/** The Workers Free plan's published limits (developers.cloudflare.com, 2026-10). */
export const FREE_PLAN = Object.freeze({
  requestsPerDay: 100_000,
  cpuMsPerRequest: 10,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
});

export const THRESHOLDS = Object.freeze({
  errorRate: 0.01,
  minRequestsForRate: 100,
  quotaShare: 0.7,
});

export const monitorUsage = `Usage: shopctl monitor --env <staging|production> [options]

  --env <staging|production>  Environnement surveillé. Obligatoire.
  --plan <free|paid>          Plan Workers du compte. Défaut : free — les quotas
                              du plan gratuit sont alors surveillés.
  --hours <n>                 Fenêtre d'observation. Défaut : 24.
  --account <id>              Compte Cloudflare attendu, si le manifeste ne le déclare pas.
  --shop <slug>               Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                      Rapport lisible par une machine.

Lit l'API GraphQL Analytics de Cloudflare avec CLOUDFLARE_API_TOKEN (droit
« Account Analytics : Read »). Échoue (code 6) quand un seuil est franchi :
taux d'erreur du Worker au-delà de 1 %, ou, au plan gratuit, 70 % d'un quota
quotidien atteint ou une invocation arrêtée par Cloudflare (erreur 1102) —
le moment de passer au plan Workers Paid. Le CPU p99 est relevé, pas jugé.
`;

const GRAPHQL_PATH = '/graphql';
const DEFAULT_API = 'https://api.cloudflare.com/client/v4';

const WORKER_QUERY = `query Worker($account: String!, $script: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP99 }
        dimensions { status }
      }
    }
  }
}`;

const D1_QUERY = `query Database($account: String!, $database: String!, $since: Date!, $until: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      d1AnalyticsAdaptiveGroups(limit: 100, filter: { databaseId: $database, date_geq: $since, date_leq: $until }) {
        sum { readQueries writeQueries rowsRead rowsWritten }
        dimensions { date }
      }
    }
  }
}`;

/**
 * Judge what the analytics returned. Pure, so that every threshold is a test
 * rather than a hope.
 *
 * @param {{ requests: number, errors: number, cpuP99Ms: number|null }} worker
 * @param {{ rowsRead: number, rowsWritten: number }} d1 the busiest day of the window
 * @param {{ plan: 'free'|'paid', hours: number }} options
 */
export function evaluateMonitor(worker, d1, { plan, hours }) {
  const stopped = worker.exceededResources ?? 0;
  const checks = [];
  const rate = worker.requests > 0 ? worker.errors / worker.requests : 0;
  if (worker.requests < THRESHOLDS.minRequestsForRate) {
    checks.push({ name: 'taux d\'erreur', ok: true, judged: false, value: rate, detail: `${worker.requests} requête(s) en ${hours} h : trop peu pour juger un taux` });
  } else {
    checks.push({
      name: 'taux d\'erreur',
      ok: rate <= THRESHOLDS.errorRate,
      judged: true,
      value: rate,
      detail: `${worker.errors} erreur(s) sur ${worker.requests} requêtes (${percent(rate)}, seuil ${percent(THRESHOLDS.errorRate)})`,
    });
  }

  if (plan === 'free') {
    // A rolling window stands in for the UTC day the quota is counted on; the
    // nightly run looks at a full day either way.
    const perDay = (value) => (hours > 0 ? value * (24 / hours) : value);
    const quota = (name, used, limit) => {
      const share = limit > 0 ? used / limit : 0;
      checks.push({ name, ok: share < THRESHOLDS.quotaShare, judged: true, value: share, detail: `${Math.round(used)} sur ${limit} par jour (${percent(share)}, seuil ${percent(THRESHOLDS.quotaShare)})` });
    };
    quota('requêtes Workers (plan gratuit)', perDay(worker.requests), FREE_PLAN.requestsPerDay);
    quota('lignes D1 lues (plan gratuit)', d1.rowsRead, FREE_PLAN.d1RowsReadPerDay);
    quota('lignes D1 écrites (plan gratuit)', d1.rowsWritten, FREE_PLAN.d1RowsWrittenPerDay);
    checks.push({
      name: 'invocations arrêtées (plan gratuit)',
      ok: stopped === 0,
      judged: true,
      value: stopped,
      detail: `${stopped} invocation(s) arrêtée(s) par Cloudflare pour ressources dépassées (erreur 1102) en ${hours} h`,
    });
    if (worker.cpuP99Ms !== null) {
      checks.push({
        name: 'CPU p99',
        ok: true,
        judged: false,
        value: worker.cpuP99Ms,
        detail: `${worker.cpuP99Ms.toFixed(2)} ms par requête ; le plan gratuit en accorde ${FREE_PLAN.cpuMsPerRequest} et tolère un dépassement occasionnel par isolat — les invocations arrêtées sont le signal`,
      });
    }
  }
  return checks;
}

const percent = (share) => `${(share * 100).toFixed(share < 0.1 ? 2 : 0)} %`;

/**
 * The statuses of an invocation Cloudflare stopped for its limits. GraphQL
 * documents `exceededResources` (1102, 1027); `exceededCpu` and
 * `exceededMemory` are the names Logpush and tail events give the same thing,
 * accepted so the count never depends on which one an API answers with.
 */
const STOPPED_STATUSES = new Set(['exceededResources', 'exceededCpu', 'exceededMemory']);

/** Sum the per-status groups into one figure. CPU time comes in microseconds. */
export function summariseWorker(groups) {
  let requests = 0;
  let errors = 0;
  let exceededResources = 0;
  let cpu = null;
  for (const group of groups ?? []) {
    requests += group.sum?.requests ?? 0;
    errors += group.sum?.errors ?? 0;
    if (STOPPED_STATUSES.has(group.dimensions?.status)) exceededResources += group.sum?.requests ?? 0;
    const p99 = group.quantiles?.cpuTimeP99;
    if (typeof p99 === 'number') cpu = Math.max(cpu ?? 0, p99);
  }
  return { requests, errors, exceededResources, cpuP99Ms: cpu === null ? null : cpu / 1000 };
}

/** The busiest day of the window, which is the one a daily quota bites on. */
export function summariseDatabase(groups) {
  let rowsRead = 0;
  let rowsWritten = 0;
  for (const group of groups ?? []) {
    rowsRead = Math.max(rowsRead, group.sum?.rowsRead ?? 0);
    rowsWritten = Math.max(rowsWritten, group.sum?.rowsWritten ?? 0);
  }
  return { rowsRead, rowsWritten };
}

export async function runMonitor(args, reporter) {
  if (args.positionals.length > 0) throw usageError(`monitor ne prend pas d'argument positionnel ; reçu « ${args.positionals.join('", "')} ».`, monitorUsage.trim());
  const env = requireEnvironment(args.values['--env']);
  const plan = args.values['--plan'] ?? 'free';
  if (plan !== 'free' && plan !== 'paid') throw usageError(`--plan « ${plan} » est inconnu.`, 'Valeurs : free, paid.');
  const hours = Number(args.values['--hours'] ?? 24);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw usageError(`--hours « ${args.values['--hours']} » n'est pas un nombre d'heures entre 1 et 168.`);

  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw preconditionError(
      'CLOUDFLARE_API_TOKEN est absent.',
      'L\'API GraphQL demande un jeton (droit « Account Analytics : Read ») ; une session `wrangler login` ne le fournit pas. En CI, c\'est le secret d\'environnement que `shopctl repo` pose.',
    );
  }

  const { manifest, root } = resolveShop(process.cwd(), args.values['--shop']);
  const names = resourceNames(manifest, { env });
  reporter.section('Compte Cloudflare');
  const account = resolveAccount(
    expectedAccount(manifest, env, args.values),
    whoami({ cwd: root }),
  );
  reporter.ok(`${account.name} (${account.id})`);
  const database = listDatabases({ cwd: root }).find((entry) => entry.name === names.database);
  if (!database) throw preconditionError(`${names.database} n'existe pas sur ce compte.`, `Il n'y a rien à surveiller en ${env}.`);
  const databaseId = database.uuid ?? database.database_id;

  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600 * 1000);
  reporter.section(`Analytique de ${names.worker} — ${hours} dernières heures (plan ${plan === 'free' ? 'gratuit' : 'payant'})`);

  const ask = (query, variables) => graphql(query, variables, token);
  const workerData = await ask(WORKER_QUERY, { account: account.id, script: names.worker, since: since.toISOString(), until: until.toISOString() });
  const d1Data = await ask(D1_QUERY, { account: account.id, database: databaseId, since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) });
  const worker = summariseWorker(workerData.viewer?.accounts?.[0]?.workersInvocationsAdaptive);
  const d1 = summariseDatabase(d1Data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups);

  const checks = evaluateMonitor(worker, d1, { plan, hours });
  for (const check of checks) {
    if (!check.judged) reporter.todo(`${check.name} — ${check.detail}`);
    else if (check.ok) reporter.ok(`${check.name} — ${check.detail}`);
    else reporter.fail(`${check.name} — ${check.detail}`);
  }
  const failures = checks.filter((check) => !check.ok);
  reporter.result({
    command: 'monitor',
    ok: failures.length === 0,
    shop: manifest.client.slug,
    env,
    plan,
    window: { since: since.toISOString(), until: until.toISOString(), hours },
    worker,
    d1: { databaseId, ...d1 },
    checks,
  });

  if (failures.length > 0) {
    const quota = failures.some((check) => check.name.includes('plan gratuit'));
    throw verificationError(
      `${failures.length} seuil(s) franchi(s) en ${env} : ${failures.map((check) => check.name).join(', ')}.`,
      quota
        ? 'Une limite du plan gratuit approche ou mord : le commerçant passe le compte au plan Workers Paid (docs/operations/runbooks/worker-en-erreur.md, section 4).'
        : 'Voir docs/operations/runbooks/worker-en-erreur.md.',
    );
  }
  return 0;
}

/**
 * One GraphQL request. The endpoint follows CLOUDFLARE_API_BASE_URL, the
 * variable wrangler itself honours, so a test (or a proxy) can stand in for
 * Cloudflare without a flag that production would also have to carry.
 */
async function graphql(query, variables, token) {
  const base = (process.env.CLOUDFLARE_API_BASE_URL ?? DEFAULT_API).replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${base}${GRAPHQL_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw externalError('l\'API Analytics de Cloudflare est injoignable.', `Rien n'a été jugé : ${error?.cause?.code ?? error?.name ?? 'erreur réseau'}.`);
  }
  let document = null;
  try {
    document = await response.json();
  } catch {
    // Reported below with the status, which is the useful part.
  }
  // The errors' text is Cloudflare's and names fields, never a customer; it is
  // still cut short, because a log line is written, never forwarded.
  const errors = (document?.errors ?? []).map((error) => String(error?.message ?? '').slice(0, 200));
  if (!response.ok || errors.length > 0 || !document?.data) {
    throw externalError(
      `l'API Analytics a refusé la requête (HTTP ${response.status}).`,
      errors.length > 0 ? errors.join(' ; ') : 'Vérifiez que le jeton porte le droit « Account Analytics : Read ».',
    );
  }
  return document.data;
}
