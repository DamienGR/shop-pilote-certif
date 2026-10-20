/**
 * Everything the CLI asks Cloudflare, in one place.
 *
 * Wrangler is wrapped, never reimplemented (plan §5.1, ADR 0009). The reason is
 * not tidiness: the account, the credentials and the compliance region all come
 * from wrangler's own resolution — an environment token, an OAuth session, a
 * profile — and a second client speaking to the REST API directly would need
 * its own copy of that resolution and would eventually disagree with the tool
 * the operator ran by hand. So every call here is a `wrangler` invocation, and
 * the only thing this module adds is `--json` and a parser.
 *
 * READ BEFORE WRITE, everywhere. `provision` has to be idempotent and has to
 * resume after an interruption (plan §5.3), and the honest way to get both is
 * to derive the state from the ACCOUNT rather than from a local file: a file
 * says what a previous run believed, the account says what exists. That costs
 * one wrangler process per resource on the happy path and buys a command that
 * can be run twice, or killed and re-run, without a special mode.
 *
 * Nothing here logs a secret. `putSecret` passes the value on stdin — never as
 * an argument, which would put it in the process table and in the CI log of
 * whatever ran the command — and returns nothing that carries it.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { capture } from './process.mjs';
import { externalError, preconditionError } from './errors.mjs';
import { environmentAccount } from '../../scripts/manifest.mjs';

/**
 * The wrangler this shop carries — the binary itself when it is installed, and
 * `npx --no-install` otherwise.
 *
 * Always the SHOP's dependency, never a download: `--no-install` is what makes
 * the npx path refuse to fetch one, and a provision run that silently used a
 * different wrangler would create resources with whatever defaults that version
 * happens to carry.
 *
 * The direct path is not a micro-optimisation. npx costs roughly half a second
 * of resolution before wrangler starts, and this CLI calls wrangler once per
 * resource per step — a provisioning run is fifteen calls, a two-hundred-product
 * import is one per image. Paying the hop when the answer is a file sitting at a
 * known path is the difference between a command that feels instant and one an
 * operator learns to avoid.
 */
export function wranglerCommand(cwd = process.cwd()) {
  const local = resolve(cwd, 'node_modules/.bin/wrangler');
  return existsSync(local) ? { command: local, prefix: [] } : { command: 'npx', prefix: ['--no-install', 'wrangler'] };
}

/**
 * The account `resolveAccount()` settled on, handed to every wrangler started
 * after it.
 *
 * Resolving the account is not enough: wrangler picks its own. With
 * `CLOUDFLARE_ACCOUNT_ID` unset and a session that sees two accounts — which
 * is exactly what an agency user invited onto the client's account has
 * (ADR 0015) — a wrangler whose stdin is not a terminal refuses with "More than
 * one account available", and one that once ran interactively in this tree
 * uses the account it cached in `node_modules/.cache/wrangler` instead, whatever
 * this command just checked. The first stops the run; the second creates the
 * shop's resources on the other account while the report names the right one.
 * Pinning the variable on the child is the one setting wrangler ranks above
 * its cache and below nothing this CLI renders.
 */
let pinnedAccount = null;

export function wrangler(args, { cwd = process.cwd(), input, allowFailure = false, env = process.env, maxBuffer } = {}) {
  const { command, prefix } = wranglerCommand(cwd);
  const childEnv = pinnedAccount ? { ...env, CLOUDFLARE_ACCOUNT_ID: pinnedAccount } : env;
  return capture(command, [...prefix, ...args], { cwd, input, allowFailure, env: childEnv, maxBuffer });
}

/**
 * Wrangler colours its labelled output, and a captured stream keeps the escape
 * sequences whenever it decides a terminal is watching. Every parser below
 * reads a LABEL, so the sequences have to go first or `name:` never matches.
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Wrangler prints a banner before its document. Take the JSON, not the chrome —
 * the same rule as the catalogue's reader, for the same reason: a release that
 * adds or removes a line of preamble must not change what this parses.
 */
export function extractJson(output, what) {
  const start = output.search(/[[{]/);
  if (start === -1) {
    throw externalError(`wrangler n'a pas répondu en JSON pour ${what}.`, output.trim().split('\n').slice(0, 4).join('\n'));
  }
  try {
    return JSON.parse(output.slice(start));
  } catch (error) {
    throw externalError(`la réponse de wrangler pour ${what} n'est pas du JSON exploitable : ${error.message}`);
  }
}

/** An e-mail address, as `logSafe()` recognises one in the Worker. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * An account's name, as every report and every line of this CLI shows it.
 *
 * Cloudflare names an account after its owner's address until somebody
 * renames it — "jeanne@example.fr's Account" — and that name used to travel
 * verbatim into the `--json` reports, the backup manifest, and the CI log of
 * every nightly run: a public log, on a pilot shop's public repository
 * (certification, étape 5). The id is what identifies the account; the name
 * is a label for a human, and it keeps its shape without the address.
 */
export function accountLabel(name) {
  return String(name ?? '').replace(EMAIL, '<email>');
}

/**
 * Who wrangler is, and which accounts it can write to.
 *
 * `--json` exits non-zero when unauthenticated, which is the distinction that
 * matters: "not logged in" is a precondition the operator fixes in a minute,
 * where a failed API call is a different conversation.
 *
 * The account names come back masked (`accountLabel`): nothing downstream
 * compares them, and everything downstream prints them.
 *
 * @returns {{ email: string|null, authType: string|null, accounts: Array<{ id: string, name: string }> }}
 */
export function whoami({ cwd } = {}) {
  const result = wrangler(['whoami', '--json'], { cwd, allowFailure: true });
  if (result.status !== 0) {
    throw preconditionError(
      'wrangler n\'est pas authentifié auprès de Cloudflare.',
      'npx wrangler login — ou, sous WSL2 avec un navigateur Windows, node scripts/wrangler-login-wsl.mjs. En CI, posez CLOUDFLARE_API_TOKEN et CLOUDFLARE_ACCOUNT_ID.',
    );
  }
  const document = extractJson(result.stdout, 'whoami');
  return {
    email: document.email ?? null,
    authType: document.authType ?? null,
    accounts: (document.accounts ?? []).map(({ id, name }) => ({ id, name: accountLabel(name) })),
  };
}

/**
 * What a command expects of the account, from the three places it can be
 * named: the manifest's field for this environment, `--account`, and
 * `CLOUDFLARE_ACCOUNT_ID`. One builder for every command that touches an
 * account, so that none of them reads `accountId` where production reads
 * `productionAccountId`.
 *
 * @param {object} manifest the shop's manifest
 * @param {string} environment staging or production
 * @param {Record<string, string|boolean>} values the command's parsed flags
 */
export function expectedAccount(manifest, environment, values = {}) {
  const { id, field } = environmentAccount(manifest, environment);
  return {
    manifest: id,
    field,
    environment,
    flag: values['--account'] ?? null,
    env: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
  };
}

/**
 * The account this run is allowed to touch, or a refusal.
 *
 * Three sources, in decreasing order of how deliberate they are: the shop's own
 * manifest, an explicit `--account`, and `CLOUDFLARE_ACCOUNT_ID`. When two of
 * them disagree the run STOPS — silently preferring one would provision a
 * customer's shop into whichever account the operator forgot about.
 *
 * When none of them names an account, the run also stops, even if the token
 * can only reach one. A single-account token today is a multi-account token
 * after the agency's next customer, and "it worked last time" is exactly how a
 * shop lands in the wrong place (ADR 0002).
 *
 * The manifest's answer depends on the environment (`environmentAccount()`):
 * production may live on another account than staging (ADR 0015), and the
 * refusal names the field that answered.
 *
 * The account it returns is also the one every later `wrangler()` of this
 * process talks to (see `pinnedAccount`): the check and the calls cannot
 * disagree.
 *
 * @param {{ manifest: string|null, field?: string, environment?: string|null, flag: string|null, env: string|null }} expected
 * @param {{ accounts: Array<{ id: string, name: string }> }} identity
 */
export function resolveAccount(expected, identity) {
  const field = expected.field ?? 'cloudflare.accountId';
  const named = [
    [`le manifeste (${field})`, expected.manifest],
    ['--account', expected.flag],
    ['CLOUDFLARE_ACCOUNT_ID', expected.env],
  ].filter(([, value]) => Boolean(value));

  const list = identity.accounts.map((account) => `${account.name} (${account.id})`).join(', ') || 'aucun';

  if (named.length === 0) {
    throw preconditionError(
      'aucun compte Cloudflare attendu n\'est déclaré.',
      `Le provisioning ne devine pas le compte : ajoutez ${field} au manifeste, ou passez --account <id>. Comptes accessibles avec cette session : ${list}.`,
    );
  }

  const distinct = [...new Set(named.map(([, value]) => value))];
  if (distinct.length > 1) {
    // The likeliest cause in production is not a typo: it is a production on
    // the client's account and a manifest that still names only the agency's.
    // Saying so is the difference between fixing the manifest and "fixing" the
    // session until it agrees with the wrong account.
    const split = expected.environment === 'production' && field === 'cloudflare.accountId'
      ? ' Si la production vit sur le compte du client (ADR 0015), déclarez-le dans cloudflare.productionAccountId.'
      : '';
    throw preconditionError(
      `deux sources désignent des comptes différents : ${named.map(([where, value]) => `${where} = ${value}`).join(', ')}.`,
      `Alignez-les avant de provisionner ; le manifeste fait foi une fois la boutique créée.${split}`,
    );
  }

  const [accountId] = distinct;
  const match = identity.accounts.find((account) => account.id === accountId);
  if (!match) {
    throw preconditionError(
      `la session Cloudflare n'a pas accès au compte attendu ${accountId}.`,
      `Comptes accessibles : ${list}. Reconnectez-vous sur le bon compte (ADR 0002 : le compte appartient à l'agence) plutôt que de changer le manifeste.`,
    );
  }
  pinnedAccount = match.id;
  return { id: match.id, name: match.name, sources: named.map(([where]) => where) };
}

/** Databases the account holds, by name. */
export function listDatabases({ cwd }) {
  const result = wrangler(['d1', 'list', '--json'], { cwd });
  const document = extractJson(result.stdout, 'd1 list');
  return Array.isArray(document) ? document : (document.result ?? []);
}

/** Create one D1 database in a jurisdiction. The jurisdiction cannot be changed
 *  afterwards (ADR 0004), which is why it is never defaulted here. */
export function createDatabase(name, { cwd, jurisdiction }) {
  const result = wrangler(['d1', 'create', name, '--jurisdiction', jurisdiction, '--update-config=false'], { cwd });
  const uuid = result.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
  if (!uuid) {
    throw externalError(
      `wrangler a créé « ${name} » sans annoncer d'identifiant lisible.`,
      'Le rendu de `wrangler d1 create` a changé ; relancez `shopctl provision`, qui relira la base dans le compte plutôt que de la recréer.',
    );
  }
  return { name, uuid };
}

/** What the account says about one database. Its shape follows the D1 API, so
 *  fields come and go with the platform rather than with this CLI. */
export function databaseInfo(name, { cwd }) {
  const result = wrangler(['d1', 'info', name, '--json'], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  return extractJson(result.stdout, `d1 info ${name}`);
}

/**
 * Buckets visible in one jurisdiction.
 *
 * The jurisdiction is a NAMESPACE, not an attribute: a bucket created with
 * `-J eu` does not appear in the default listing at all. That is what makes the
 * two-sided check in `verifyBucketJurisdiction` meaningful, and it is also the
 * trap this wrapper exists to keep the caller out of.
 */
export function listBuckets({ cwd, jurisdiction = null }) {
  const result = wrangler(['r2', 'bucket', 'list', ...(jurisdiction ? ['-J', jurisdiction] : [])], {
    cwd,
    allowFailure: true,
  });
  if (result.status !== 0) {
    if (/not enabled|sign up|subscription|10042|R2 is not/i.test(`${result.stdout}${result.stderr}`)) {
      throw preconditionError(
        'R2 n\'est pas activé sur ce compte Cloudflare.',
        'Activez R2 une première fois dans le tableau de bord (R2 → Overview) : la création d\'un bucket échoue tant que ce n\'est pas fait, et c\'est une action humaine (plan §5.3).',
      );
    }
    throw externalError('`wrangler r2 bucket list` a échoué.', result.stderr.trim().split('\n')[0] || null);
  }
  // `r2 bucket list` has no --json. Its listing is one `name: <bucket>` line
  // per bucket; matching the field rather than the layout is what survives a
  // release that changes the table around it.
  return [...stripAnsi(result.stdout).matchAll(/^\s*name:\s+(\S+)\s*$/gm)].map((match) => match[1]);
}

export function createBucket(name, { cwd, jurisdiction }) {
  wrangler(['r2', 'bucket', 'create', name, '-J', jurisdiction, '--update-config=false'], { cwd });
  return { name, jurisdiction };
}

/**
 * Prove a bucket is where the manifest says it is.
 *
 * Two-sided, and both sides are load-bearing. Present in `eu` says the
 * jurisdiction took; absent from the default namespace says nothing was created
 * outside it under the same name — which is the failure mode a retry after a
 * half-finished run produces, and the one that cannot be repaired in place
 * (ADR 0004).
 */
export function verifyBucketJurisdiction(name, { cwd, jurisdiction }) {
  const inside = listBuckets({ cwd, jurisdiction }).includes(name);
  const outside = listBuckets({ cwd }).includes(name);
  return { name, jurisdiction, inside, outside, ok: inside && !outside };
}

/**
 * Is this bucket reachable by anyone with the URL?
 *
 * Two ways it can be, and a bucket that must stay private (plan §6, jalon 6)
 * has to fail both: the r2.dev development URL, and any custom domain attached
 * to it. Asked of the ACCOUNT rather than assumed from the fact that nothing in
 * this repository enables them — the dashboard is one click away, and this is
 * the check that notices.
 */
export function bucketExposure(name, { cwd, jurisdiction }) {
  const dev = wrangler(['r2', 'bucket', 'dev-url', 'get', name, '-J', jurisdiction], { cwd, allowFailure: true });
  // Wrangler says "Public access is enabled at '<url>'" or that it is disabled.
  // The quoted URL is the only positive: absence of the phrase is read as
  // disabled, and a command that failed outright is reported as unknown rather
  // than as private, because "we could not ask" must never look like "it is
  // closed".
  const devText = stripAnsi(`${dev.stdout}\n${dev.stderr}`);
  const devUrl = dev.status === 0 ? (devText.match(/enabled at '([^']+)'/)?.[1] ?? null) : null;

  const domains = wrangler(['r2', 'bucket', 'domain', 'list', name, '-J', jurisdiction], { cwd, allowFailure: true });
  const domainNames = domains.status === 0
    ? [...stripAnsi(domains.stdout).matchAll(/^\s*domain:\s+(\S+)\s*$/gm)].map((match) => match[1])
    : [];

  return {
    devUrl,
    domains: domainNames,
    // A custom domain that is attached but disabled still counts: it is one
    // dashboard toggle from serving the merchant's paid downloads to anyone.
    public: Boolean(devUrl) || domainNames.length > 0,
    known: dev.status === 0 && domains.status === 0,
  };
}

/**
 * Which internal secrets the deployed Worker already has.
 *
 * `null` when the Worker does not exist yet — a distinction the caller needs,
 * because "no secrets" and "no Worker" call for different next steps and only
 * one of them is a problem.
 */
export function listSecrets(worker, { cwd }) {
  const result = wrangler(['secret', 'list', '--name', worker, '--format', 'json'], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  const document = extractJson(result.stdout, `secret list ${worker}`);
  return (Array.isArray(document) ? document : []).map((entry) => entry.name).filter(Boolean);
}

/**
 * Set one secret, over standard input.
 *
 * Never as an argument (plan §5.3): an argument is in the process table of a
 * shared machine and in the CI log of whatever ran the command, before the
 * process has read it. The value is not returned, not logged, and not written
 * to disk anywhere on this path.
 */
export function putSecret(worker, name, value, { cwd }) {
  wrangler(['secret', 'put', name, '--name', worker], { cwd, input: `${value}\n` });
  return { name };
}

/** Does a Worker of this name exist on the account? */
export function workerExists(worker, { cwd }) {
  const result = wrangler(['versions', 'list', '--name', worker, '--json'], { cwd, allowFailure: true });
  return result.status === 0;
}

/**
 * Delete one Worker, database or bucket.
 *
 * Each returns what happened rather than throwing on "already gone": a teardown
 * that has to be re-run because one resource was missing is a teardown people
 * stop finishing, and a half-torn-down environment is worse than either state.
 * A REAL failure — a non-empty bucket, a permission the token lacks — is
 * reported with wrangler's own refusal, because those two have different
 * remedies and the operator has to be able to tell them apart.
 */
function removal(result, name) {
  if (result.status === 0) return { name, removed: true, reason: null };
  const text = stripAnsi(`${result.stdout}\n${result.stderr}`);
  if (/not found|does not exist|Couldn't find|could not resolve|no such/i.test(text)) {
    return { name, removed: false, reason: 'absent' };
  }
  return { name, removed: false, reason: refusal(result) ?? 'échec' };
}

/**
 * Why wrangler refused, read from STDERR first. Stdout opens with what it was
 * about to do — "Deleting bucket <name> (eu)." — and a report that relays that
 * line says nothing about the refusal (étape 7 of the certification, both
 * buckets). The API's own sentence carries its code; the `[ERROR]` line around
 * it only says that a request failed.
 */
function refusal(result) {
  const stderr = stripAnsi(result.stderr ?? '');
  const coded = stderr.split('\n').map((line) => line.trim()).find((line) => /\[code: \d+\]/.test(line));
  return coded ?? firstLine(stderr) ?? firstLine(stripAnsi(result.stdout ?? ''));
}

export function deleteWorker(worker, { cwd }) {
  return removal(wrangler(['delete', '--name', worker], { cwd, allowFailure: true }), worker);
}

export function deleteDatabase(name, { cwd }) {
  return removal(wrangler(['d1', 'delete', name, '--skip-confirmation'], { cwd, allowFailure: true }), name);
}

/**
 * KV namespaces on the account, as `{ id, title }`.
 *
 * A shop owns exactly one, and never asked for it: the Astro adapter adds a
 * `SESSION` binding to the built configuration, and wrangler provisions it at
 * the first deploy as `<worker>-session`. Nothing renders it, so only the
 * account knows its id — and `wrangler delete` leaves it behind with the
 * Worker gone.
 */
export function listKvNamespaces({ cwd }) {
  const result = wrangler(['kv', 'namespace', 'list'], { cwd });
  const document = extractJson(result.stdout, 'kv namespace list');
  return Array.isArray(document) ? document : (document.result ?? []);
}

export function deleteKvNamespace(namespace, { cwd }) {
  return removal(
    wrangler(['kv', 'namespace', 'delete', '--namespace-id', namespace.id, '--skip-confirmation'], { cwd, allowFailure: true }),
    namespace.title,
  );
}

/** The lifecycle rule that bounds a backups bucket. Named, so a second
 *  provisioning finds it rather than adding a twin. */
export const RETENTION_RULE = 'shopctl-retention';

/**
 * Does this bucket already expire its objects under our rule?
 *
 * `null` when the account could not be asked: "unknown" is reported as such and
 * never read as "absent", which would add a rule on every run, or as "present",
 * which would leave a bucket that keeps customer data forever.
 */
export function hasRetentionRule(name, { cwd, jurisdiction }) {
  const result = wrangler(['r2', 'bucket', 'lifecycle', 'list', name, '-J', jurisdiction], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  return stripAnsi(`${result.stdout}\n${result.stderr}`).includes(RETENTION_RULE);
}

export function addRetentionRule(name, days, { cwd, jurisdiction }) {
  wrangler(
    ['r2', 'bucket', 'lifecycle', 'add', name, RETENTION_RULE, '--expire-days', String(days), '-J', jurisdiction, '--force'],
    { cwd },
  );
}

/** R2 refuses to delete a bucket that still holds objects. That refusal is
 *  relayed rather than worked around: emptying a bucket on the operator's
 *  behalf is how a teardown deletes something nobody meant to lose. */
export function deleteBucket(name, { cwd, jurisdiction }) {
  return removal(wrangler(['r2', 'bucket', 'delete', name, '-J', jurisdiction], { cwd, allowFailure: true }), name);
}

function firstLine(text) {
  return (
    String(text)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('⛅') && !/^─+$/.test(line)) ?? null
  );
}

/** Apply the migrations the tree carries to the bound database. */
export function applyMigrations({ cwd, remote = true, binding = 'DB' }) {
  wrangler(['d1', 'migrations', 'apply', binding, remote ? '--remote' : '--local'], { cwd });
}
