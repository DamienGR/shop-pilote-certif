/**
 * `shopctl fleet usage` — what the shared account has consumed, against what
 * its plan allows: on Workers Paid, the month against what the plan includes
 * and the bill that projects to; on Workers Free, the busiest UTC day against
 * the daily quotas (ADR 0019, plan §13.1 lot 7).
 *
 * `monitor` asks about ONE shop: its error rate, and on the free plan its daily
 * quotas. On the shared account no shop has a quota of its own — every volume
 * Workers Paid includes is the account's, shared by every Worker on it — and
 * what can go wrong is no longer a shop refused at midnight UTC but a bill
 * that drifts, or an account that reaches its ceiling of crons. Neither is
 * visible from inside one shop, and Cloudflare's notification catalogue has no
 * alert for either on this plan (README of docs/operations, 2026-10-06).
 *
 * So the question is asked of the whole account, once a night, by the fleet:
 *
 *  - every billed volume of the month so far — Workers requests and CPU, D1
 *    rows and storage, R2 operations and storage, KV operations — against
 *    what the plan includes, projected linearly to the end of the month;
 *  - the bill that projection gives, subscription included;
 *  - the Workers invoked this month, each shop's environment being one Worker
 *    with one cron: the ceiling of 250 crons bites first, and the plan aims at
 *    two hundred shops per account.
 *
 * It fails (code 6) when the projected bill passes `--budget`, or when the
 * account carries as many Workers as the plan aims at: the day to open the
 * next account, not the day the 251st cron is refused. A volume past what is
 * included is reported, never failed: it is billed, not blocked.
 *
 * `--plan free` is the account's first months, with one or two very small
 * shops (ADR 0019). There the quotas `monitor --plan free` judges per shop are
 * the ACCOUNT's: 100 000 requests and 5 million D1 rows read a day for every
 * shop together, and past them every page of every shop fails until midnight
 * UTC. One shop's figures against the whole quota would miss the sum, so this
 * judges the account's busiest day at the monitor's 70 %, the invocations
 * Cloudflare stopped, D1 storage, and the five crons of the plan — one per
 * environment, the ceiling the second shop's preview already nears. Each of
 * them is the day to go Paid, which lifts every limit within minutes.
 *
 * One GraphQL request, read-only, with the monitor's token (Account Analytics:
 * Read). No wrangler: it has nothing to ask about a tree, and runs from any
 * checkout that carries shopctl — the fleet's nightly uses the first shop's.
 *
 * Cloudflare for SaaS hostnames have no analytics dataset either: 100 are
 * included, then 0.10 $ each a month, and each shop in production has one. They
 * are ESTIMATED as one per production Worker invoked this month — a shop not
 * yet on the shared zone overstates the bill, the safe direction.
 *
 * What it does not measure: Workers Logs (no analytics dataset; 20 million
 * events a month are included, then billed from 2026-12-01). The first real
 * run says whether the datasets answer as the double supposes; the command
 * fails loudly when they do not.
 */
import { graphql } from '../analytics.mjs';
import { preconditionError, usageError, verificationError } from '../errors.mjs';
import { FREE_PLAN, STOPPED_STATUSES, THRESHOLDS } from './monitor.mjs';

/** Workers Paid, as published on developers.cloudflare.com (relevé du
 *  2026-10-28, ADR 0019). In dollars; a volume per month unless it says GB. */
export const PAID_PLAN = Object.freeze({
  subscription: 5,
  volumes: Object.freeze([
    { key: 'workers.requests', name: 'requêtes Workers', included: 10_000_000, per: 1_000_000, price: 0.3 },
    { key: 'workers.cpuMs', name: 'CPU Workers (ms)', included: 30_000_000, per: 1_000_000, price: 0.02 },
    { key: 'd1.rowsRead', name: 'lignes D1 lues', included: 25_000_000_000, per: 1_000_000, price: 0.001 },
    { key: 'd1.rowsWritten', name: 'lignes D1 écrites', included: 50_000_000, per: 1_000_000, price: 1 },
    { key: 'd1.storageGb', name: 'stockage D1 (Go)', included: 5, per: 1, price: 0.75, stock: true },
    { key: 'r2.classA', name: 'opérations R2 de classe A', included: 1_000_000, per: 1_000_000, price: 4.5 },
    { key: 'r2.classB', name: 'opérations R2 de classe B', included: 10_000_000, per: 1_000_000, price: 0.36 },
    { key: 'r2.storageGb', name: 'stockage R2 (Go)', included: 10, per: 1, price: 0.015, stock: true },
    { key: 'kv.reads', name: 'lectures KV', included: 10_000_000, per: 1_000_000, price: 0.5 },
    { key: 'kv.writes', name: 'écritures KV', included: 1_000_000, per: 1_000_000, price: 5 },
    { key: 'saas.hostnames', name: 'noms d\'hôte SaaS (estimés)', included: 100, per: 1, price: 0.1, stock: true },
  ]),
});

/** One cron per Worker, a `*` /5 in every environment. Paid: a ceiling of 250,
 *  and the account is meant to stop at two hundred shops. Free: five, and the
 *  fifth environment leaves no room for another. */
export const ACCOUNT_LIMITS = Object.freeze({
  paid: Object.freeze({ crons: 250, target: 200 }),
  free: Object.freeze({ crons: 5, target: 5 }),
});

/** D1 on Workers Free: a size per database and a total per account. */
export const FREE_STORAGE = Object.freeze({ databaseBytes: 500_000_000, accountBytes: 5_000_000_000 });

/** R2's operation classes. Deletes and aborts are free; anything not named
 *  here is counted as class A, the dearer one, rather than dropped. */
const R2_CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration']);
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload', 'DeleteObjects']);

export const FLEET_USAGE_OPTIONS = { '--account': 'id', '--budget': 'dollars', '--plan': 'free|paid' };

const USAGE_QUERY = `query Usage($account: String!, $since: Time!, $until: Time!, $sinceDate: Date!, $untilDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since, datetime_leq: $until }) {
        sum { requests cpuTimeUs }
        dimensions { scriptName }
      }
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $sinceDate, date_leq: $untilDate }) {
        sum { rowsRead rowsWritten }
      }
      d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $sinceDate, date_leq: $untilDate }) {
        max { databaseSizeBytes }
        dimensions { databaseId }
      }
      r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since, datetime_leq: $until }) {
        sum { requests }
        dimensions { actionType }
      }
      r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since, datetime_leq: $until }) {
        max { payloadSize metadataSize }
        dimensions { bucketName }
      }
      kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $sinceDate, date_leq: $untilDate }) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

/** The free plan's quotas are per UTC day: each day's figures, account-wide. */
const FREE_QUERY = `query FreeUsage($account: String!, $since: Time!, $until: Time!, $sinceDate: Date!, $untilDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since, datetime_leq: $until }) {
        sum { requests }
        dimensions { date scriptName status }
      }
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $sinceDate, date_leq: $untilDate }) {
        sum { rowsRead rowsWritten }
        dimensions { date }
      }
      d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $sinceDate, date_leq: $untilDate }) {
        max { databaseSizeBytes }
        dimensions { databaseId }
      }
    }
  }
}`;

const GB = 1_000_000_000;
const MB = 1_000_000;

/** The month so far, in UTC: from its first instant to now, and how much of it
 *  that is — the ratio the projection divides by. */
export function monthWindow(now = new Date()) {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const elapsed = Math.max(now.getTime() - since.getTime(), 3_600_000);
  return { since, until: now, elapsedShare: Math.min(1, elapsed / (next.getTime() - since.getTime())) };
}

/** Yesterday and today in UTC: yesterday is the last whole day a quota was
 *  counted on, today the one that is still counting. */
export function dayWindow(now = new Date()) {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return { since, until: now };
}

/**
 * The account's days, for the free plan. Pure.
 *
 * Every figure is the busiest DAY's, since that is the one a daily quota
 * bites on; the Workers are those invoked in the window, each with its own
 * stopped invocations, so the report can name the shop that stopped.
 */
export function summariseFreeUsage(account) {
  const days = new Map();
  const day = (date) => {
    const entry = days.get(date) ?? { date, requests: 0, rowsRead: 0, rowsWritten: 0 };
    days.set(date, entry);
    return entry;
  };
  const scripts = new Map();
  for (const group of account?.workersInvocationsAdaptive ?? []) {
    const requests = group.sum?.requests ?? 0;
    day(group.dimensions?.date ?? '').requests += requests;
    const name = group.dimensions?.scriptName ?? '(inconnu)';
    const script = scripts.get(name) ?? { name, requests: 0, stopped: 0 };
    script.requests += requests;
    if (STOPPED_STATUSES.has(group.dimensions?.status)) script.stopped += requests;
    scripts.set(name, script);
  }
  for (const group of account?.d1AnalyticsAdaptiveGroups ?? []) {
    const entry = day(group.dimensions?.date ?? '');
    entry.rowsRead += group.sum?.rowsRead ?? 0;
    entry.rowsWritten += group.sum?.rowsWritten ?? 0;
  }
  const sizes = new Map();
  for (const group of account?.d1StorageAdaptiveGroups ?? []) {
    const id = group.dimensions?.databaseId ?? '';
    sizes.set(id, Math.max(sizes.get(id) ?? 0, group.max?.databaseSizeBytes ?? 0));
  }
  const peak = (field) => Math.max(0, ...[...days.values()].map((entry) => entry[field]));
  const workers = [...scripts.values()].sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
  return {
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    busiest: { requests: peak('requests'), rowsRead: peak('rowsRead'), rowsWritten: peak('rowsWritten') },
    stopped: workers.reduce((all, script) => all + script.stopped, 0),
    workers,
    d1: { largestBytes: Math.max(0, ...sizes.values()), totalBytes: [...sizes.values()].reduce((all, size) => all + size, 0) },
  };
}

/** Judge the account's day against the free plan. Pure, one check per quota. */
export function evaluateFreeUsage(usage) {
  const share = (used, limit) => (limit > 0 ? used / limit : 0);
  const quota = (name, used, limit, unit) => {
    const value = share(used, limit);
    return { name, ok: value < THRESHOLDS.quotaShare, judged: true, value, detail: `${quantity(used)} sur ${quantity(limit)} ${unit} (${percentage(value)}, seuil ${percentage(THRESHOLDS.quotaShare)})` };
  };
  return [
    quota('requêtes Workers du compte', usage.busiest.requests, FREE_PLAN.requestsPerDay, 'par jour'),
    quota('lignes D1 lues du compte', usage.busiest.rowsRead, FREE_PLAN.d1RowsReadPerDay, 'par jour'),
    quota('lignes D1 écrites du compte', usage.busiest.rowsWritten, FREE_PLAN.d1RowsWrittenPerDay, 'par jour'),
    {
      name: 'invocations arrêtées',
      ok: usage.stopped === 0,
      judged: true,
      value: usage.stopped,
      detail: `${usage.stopped} invocation(s) arrêtée(s) par Cloudflare pour ressources dépassées (erreur 1102), ${FREE_PLAN.cpuMsPerRequest} ms de CPU par requête au plan gratuit`,
    },
    quota('base D1 la plus grosse', usage.d1.largestBytes / MB, FREE_STORAGE.databaseBytes / MB, 'Mo'),
    quota('stockage D1 du compte', usage.d1.totalBytes / MB, FREE_STORAGE.accountBytes / MB, 'Mo'),
    workersCheck(usage.workers.length, ACCOUNT_LIMITS.free, 'depuis hier'),
  ];
}

/**
 * Fold the datasets into one figure per billed volume. Pure.
 *
 * Storage is a stock, not a flow: the largest size seen this month stands for
 * the month's average, which overstates it slightly — the safe direction for a
 * bill.
 */
export function summariseUsage(account) {
  const scripts = new Map();
  for (const group of account?.workersInvocationsAdaptive ?? []) {
    const name = group.dimensions?.scriptName ?? '(inconnu)';
    const entry = scripts.get(name) ?? { name, requests: 0, cpuMs: 0 };
    entry.requests += group.sum?.requests ?? 0;
    entry.cpuMs += (group.sum?.cpuTimeUs ?? 0) / 1000;
    scripts.set(name, entry);
  }
  const workers = [...scripts.values()].sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));

  const d1Sizes = new Map();
  for (const group of account?.d1StorageAdaptiveGroups ?? []) {
    const id = group.dimensions?.databaseId ?? '';
    d1Sizes.set(id, Math.max(d1Sizes.get(id) ?? 0, group.max?.databaseSizeBytes ?? 0));
  }
  const r2Sizes = new Map();
  for (const group of account?.r2StorageAdaptiveGroups ?? []) {
    const bucket = group.dimensions?.bucketName ?? '';
    r2Sizes.set(bucket, Math.max(r2Sizes.get(bucket) ?? 0, (group.max?.payloadSize ?? 0) + (group.max?.metadataSize ?? 0)));
  }
  let classA = 0;
  let classB = 0;
  for (const group of account?.r2OperationsAdaptiveGroups ?? []) {
    const action = group.dimensions?.actionType ?? '';
    const count = group.sum?.requests ?? 0;
    if (R2_FREE.has(action)) continue;
    if (R2_CLASS_B.has(action)) classB += count;
    else classA += count;
  }
  let kvReads = 0;
  let kvWrites = 0;
  for (const group of account?.kvOperationsAdaptiveGroups ?? []) {
    const count = group.sum?.requests ?? 0;
    if (group.dimensions?.actionType === 'read') kvReads += count;
    else kvWrites += count;
  }
  const sum = (groups, field) => (groups ?? []).reduce((total, group) => total + (group.sum?.[field] ?? 0), 0);
  const total = (sizes) => [...sizes.values()].reduce((all, size) => all + size, 0);

  return {
    workers: {
      requests: workers.reduce((all, script) => all + script.requests, 0),
      cpuMs: workers.reduce((all, script) => all + script.cpuMs, 0),
      scripts: workers,
    },
    d1: { rowsRead: sum(account?.d1AnalyticsAdaptiveGroups, 'rowsRead'), rowsWritten: sum(account?.d1AnalyticsAdaptiveGroups, 'rowsWritten'), storageGb: total(d1Sizes) / GB },
    r2: { classA, classB, storageGb: total(r2Sizes) / GB },
    kv: { reads: kvReads, writes: kvWrites },
    // A deployed Worker is `<workerName>-<env>` (scripts/manifest.mjs).
    saas: { hostnames: workers.filter((script) => script.name.endsWith('-production')).length },
  };
}

const pick = (usage, key) => key.split('.').reduce((node, part) => node?.[part], usage) ?? 0;

/**
 * The month's bill, projected. Pure, so each price is a test.
 *
 * A flow is projected linearly from the share of the month elapsed; a stock is
 * taken as it stands. Each volume is billed only past what the plan includes,
 * by started unit of nothing: Cloudflare bills fractions, and so does this.
 */
export function projectBill(usage, { elapsedShare, plan = PAID_PLAN }) {
  const lines = plan.volumes.map((volume) => {
    const used = pick(usage, volume.key);
    const projected = volume.stock ? used : used / elapsedShare;
    const over = Math.max(0, projected - volume.included);
    return {
      key: volume.key,
      name: volume.name,
      stock: volume.stock === true,
      used,
      projected,
      included: volume.included,
      share: volume.included > 0 ? projected / volume.included : 0,
      cost: (over / volume.per) * volume.price,
    };
  });
  const overage = lines.reduce((all, line) => all + line.cost, 0);
  return { lines, subscription: plan.subscription, total: plan.subscription + overage };
}

// French figures without Intl: the CLI's output must not depend on the ICU
// data the runner's Node was built with.
const dollars = (amount) => `${amount.toFixed(2).replace('.', ',')} $`;
const percentage = (share) => `${(share * 100).toFixed(share < 0.1 ? 2 : 0).replace('.', ',')} %`;
const quantity = (value) =>
  value >= 1000 ? String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(Math.round(value * 100) / 100).replace('.', ',');

export async function runFleetUsage(args, reporter) {
  const account = args.values['--account'] ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) throw usageError('fleet usage demande le compte mutualisé.', 'Passez --account <id>, ou posez CLOUDFLARE_ACCOUNT_ID.');
  if (!/^[0-9a-f]{32}$/.test(account)) throw usageError(`« ${account} » n'est pas un identifiant de compte Cloudflare.`);
  const plan = args.values['--plan'] || 'paid';
  if (plan !== 'free' && plan !== 'paid') throw usageError(`--plan « ${plan} » est inconnu.`, 'Valeurs : free, paid.');
  const budgetValue = args.values['--budget'];
  const budget = budgetValue === undefined || budgetValue === '' ? null : Number(budgetValue);
  if (budget !== null && !(Number.isFinite(budget) && budget > 0)) throw usageError(`--budget « ${budgetValue} » n'est pas un montant en dollars.`);
  if (budget !== null && plan === 'free') throw usageError('--budget ne s\'applique qu\'au plan payant : le plan gratuit n\'a pas de facture, il a des quotas.');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw preconditionError(
      'CLOUDFLARE_API_TOKEN est absent.',
      'Le jeton de surveillance du compte mutualisé suffit : « Account Analytics : Read ». En CI, MONITOR_CLOUDFLARE_API_TOKEN du dépôt de flotte.',
    );
  }
  return plan === 'free' ? freeUsage({ account, token }, reporter) : paidUsage({ account, token, budget }, reporter);
}

function report(reporter, checks) {
  for (const check of checks) {
    if (!check.judged) reporter.todo(`${check.name} — ${check.detail}`);
    else if (check.ok) reporter.ok(`${check.name} — ${check.detail}`);
    else reporter.fail(`${check.name} — ${check.detail}`);
  }
}

function busiest(reporter, scripts, unit) {
  if (scripts.length === 0) return;
  reporter.section('Les plus actifs');
  for (const script of scripts.slice(0, 5)) reporter.step(`    ${script.name} — ${unit(script)}`);
}

/** One cron per environment: as many Workers as the plan aims at is the day
 *  to act, before the next environment is refused. */
function workersCheck(active, limits, period) {
  return {
    name: 'Workers du compte',
    ok: active < limits.target,
    judged: true,
    value: active,
    detail: `${active} Worker(s) invoqué(s) ${period}, un cron chacun : ${limits.target} visés par compte, ${limits.crons} au plus`,
  };
}

async function paidUsage({ account, token, budget }, reporter) {
  const window = monthWindow();
  reporter.section(`Compte ${account} — Workers Paid, du ${window.since.toISOString().slice(0, 10)} à maintenant (${Math.round(window.elapsedShare * 100)} % du mois)`);
  const data = await graphql(USAGE_QUERY, {
    account,
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    sinceDate: window.since.toISOString().slice(0, 10),
    untilDate: window.until.toISOString().slice(0, 10),
  }, token);
  const usage = summariseUsage(data.viewer?.accounts?.[0]);
  const bill = projectBill(usage, { elapsedShare: window.elapsedShare });

  for (const line of bill.lines) {
    const measured = line.stock ? `${quantity(line.used)} au plus haut ce mois` : `${quantity(line.used)} à ce jour, ${quantity(line.projected)} projetés`;
    const text = `${line.name} — ${measured}, sur ${quantity(line.included)} inclus${line.cost > 0 ? `, ${dollars(line.cost)} au-delà` : ''}`;
    if (line.share > 1) reporter.warn(text, 'Facturé, pas bloqué : la facture projetée le compte.');
    else reporter.ok(text);
  }

  reporter.section('Facture projetée');
  const overBudget = budget !== null && bill.total > budget;
  const checks = [
    {
      name: 'facture projetée',
      ok: !overBudget,
      judged: budget !== null,
      value: bill.total,
      detail: `${dollars(bill.total)} pour le mois, abonnement de ${dollars(bill.subscription)} compris${budget !== null ? ` (budget ${dollars(budget)})` : ''}`,
    },
    workersCheck(usage.workers.scripts.length, ACCOUNT_LIMITS.paid, 'ce mois'),
  ];
  report(reporter, checks);
  busiest(reporter, usage.workers.scripts, (script) => `${quantity(script.requests)} requête(s), ${quantity(script.cpuMs)} ms de CPU`);

  const failures = checks.filter((check) => !check.ok);
  reporter.result({
    command: 'fleet usage',
    ok: failures.length === 0,
    plan: 'paid',
    account,
    window: { since: window.since.toISOString(), until: window.until.toISOString(), elapsedShare: window.elapsedShare },
    usage,
    bill,
    budget,
    checks,
  });
  if (failures.length > 0) {
    throw verificationError(
      `${failures.map((check) => check.name).join(', ')} : seuil franchi sur le compte mutualisé.`,
      overBudget
        ? 'Lisez les plus actifs ci-dessus : la dérive a une boutique. Le budget se règle par --budget (variable MINSHOP_MONTHLY_BUDGET du dépôt de flotte).'
        : 'Le compte porte les boutiques qu\'il vise : la suivante s\'ouvre sur un second compte, sur le même modèle (ADR 0019).',
    );
  }
  return 0;
}

async function freeUsage({ account, token }, reporter) {
  const window = dayWindow();
  reporter.section(`Compte ${account} — Workers Free, quotas du compte, jour UTC le plus chargé depuis le ${window.since.toISOString().slice(0, 10)}`);
  const data = await graphql(FREE_QUERY, {
    account,
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    sinceDate: window.since.toISOString().slice(0, 10),
    untilDate: window.until.toISOString().slice(0, 10),
  }, token);
  const usage = summariseFreeUsage(data.viewer?.accounts?.[0]);
  const checks = evaluateFreeUsage(usage);
  report(reporter, checks);
  busiest(reporter, usage.workers, (script) => `${quantity(script.requests)} requête(s)${script.stopped > 0 ? `, ${script.stopped} arrêtée(s)` : ''}`);

  const failures = checks.filter((check) => !check.ok);
  reporter.result({
    command: 'fleet usage',
    ok: failures.length === 0,
    plan: 'free',
    account,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    usage,
    checks,
  });
  if (failures.length > 0) {
    throw verificationError(
      `${failures.map((check) => check.name).join(', ')} : seuil franchi sur le compte mutualisé.`,
      'Les quotas du plan gratuit sont ceux du compte : toutes ses boutiques tombent ensemble. Passer le compte en Workers Paid lève ces limites en quelques minutes, sans redéployer ; puis --plan paid et la variable MINSHOP_ACCOUNT_PLAN du dépôt de flotte (ADR 0019).',
    );
  }
  return 0;
}
