/**
 * `shopctl certify --env production` — is this shop certifiable?
 *
 * The short path of docs/certification/par-boutique.md, as one command. The
 * pilot's campaign (6 to 27 October 2026) certified the CORE: what it proved
 * holds for every shop that carries a published core version at least as
 * recent as the certified floor, and diverges from no core file it has not
 * named. What is left is proper to one shop — its configuration, its accounts,
 * its content and its production — and that is what this command reads and
 * judges, group by group, in one report:
 *
 *   Socle             the core version, and the shop's divergences from it
 *   Arbre             toolchain, manifest, ownership, no secret in the history
 *   Compte            `provision --dry-run`: every resource there, in its
 *                     jurisdiction, the private buckets private; the Worker's
 *                     internal secrets
 *   Base              the production settings, read masked
 *   Vitrine publique  smoke test, the legal pages, the remote security and
 *                     browser gates, Lighthouse through PageSpeed Insights
 *   Dépôt             through gh: environments, secrets by name, the last
 *                     production deployment, the nightly's production jobs
 *                     (which carry `monitor`'s verdict on errors and quotas)
 *   Attestations      client/certification/attestations.yaml, what only
 *                     people saw
 *
 * READ-ONLY on every account, by construction: `provision` runs as its dry run,
 * the database is read through `wrangler d1 execute` with a SELECT, the
 * repository through gh's read commands. Wrap, never reimplement: each check
 * is the gate, script or command that already exists. The one thing written
 * is the report, with `--write`, in the shop's own tree.
 *
 * A group that cannot be asked — gh absent, the account refused — is reported
 * as skipped with its reason and the next group runs: one report says
 * everything there is to fix. Certified means no failure, nothing left to
 * attest and nothing skipped; a warning is said and does not block. Not
 * certified is exit 6, like `monitor`: the work was done and the result
 * refused.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSecrets } from '../cloudflare.mjs';
import { ShopctlError, usageError, verificationError } from '../errors.mjs';
import { openEnvironment } from '../environment.mjs';
import {
  assertForgeReady,
  branchPolicies,
  environmentProtection,
  environmentSecrets,
  environments as environmentNames,
  originUrl,
  parseGithubRemote,
  repository,
  repositoryFile,
  repositorySecrets,
  repositoryVariable,
  runJobs,
  workflowRuns,
} from '../forge.mjs';
import { FLEET_FILE, FLEET_VARIABLE } from '../fleet.mjs';
import { runShopGates, describeGateFailure } from '../gates.mjs';
import { capture } from '../process.mjs';
import { Reporter } from '../report.mjs';
import { redact } from '../secrets.mjs';
import { requireEnvironment, resolveShop } from '../shop.mjs';
import { runSmoke } from '../smoke.mjs';
import { query } from '../backup/store.mjs';
import { coreState } from './core.mjs';
import { INTERNAL_SECRETS, runProvision } from './provision.mjs';
import { BACKUP_ENVIRONMENT } from './repo.mjs';
import { ATTESTATIONS_FILE, ATTESTATIONS_TEMPLATE, judgeAttestations } from '../certify/attestations.mjs';
import {
  CERTIFIED_FLOOR,
  judgeAccount,
  judgeCore,
  judgeForge,
  judgeLighthouse,
  judgeManifest,
  judgePages,
  judgeSettings,
  verdictOf,
} from '../certify/judge.mjs';
import { lighthousePages, pageSpeed, readPages, runBrowserGate, runSecurityGate } from '../certify/public.mjs';
import { resourceNames } from '../../../scripts/manifest.mjs';

export const CERTIFY_OPTIONS = { '--env': 'environnement', '--shop': 'slug', '--account': 'id', '--url': 'origine' };
export const CERTIFY_FLAGS = ['--write', '--rate-limits', '--skip-browser', '--skip-lighthouse'];

export const certifyUsage = `Usage: shopctl certify --env production [options]

Juge si la boutique est certifiable, en lecture seule : socle, arbre, compte
Cloudflare, base de production, vitrine publique, dépôt GitHub et attestations
de la recette (docs/certification/par-boutique.md).

  --env production      Obligatoire. Seule la production se certifie.
  --write               Écrit le rapport dans client/certification/<date>/
                        (certify.json, certify.md) et pose le modèle des
                        attestations s'il manque.
  --url <origine>       Origine publique à juger. Défaut : https:// suivi de
                        cloudflare.productionDomain.
  --rate-limits         Déclenche aussi les limiteurs (porte de sécurité
                        --limiteurs) : bloque l'adresse de l'opérateur un quart
                        d'heure sur l'administration.
  --skip-browser        Saute la porte navigateur distante (la boutique n'est
                        alors pas certifiée).
  --skip-lighthouse     Saute Lighthouse (idem).
  --account <id>        Compte Cloudflare attendu, si le manifeste ne le déclare pas.
  --shop <slug>         Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                Rapport lisible par une machine.

Lit le compte par wrangler, le dépôt par gh, et mesure quatre pages avec
l'API PageSpeed Insights de Google (l'URL publique de la boutique lui est
envoyée ; PAGESPEED_API_KEY est nécessaire en pratique, le quota anonyme
étant épuisé). Aucune donnée personnelle
dans le rapport : les secrets, le mot de passe et le destinataire des alertes
sont lus masqués, l'expéditeur réduit à son domaine.

Code 0 : certifiable. Code 6 : au moins un contrôle en échec, une
attestation à faire ou un contrôle sauté.
`;

/**
 * The production settings certify reads, masked IN the query: a secret, the
 * password hash and the alert recipient leave the database as `set` or empty,
 * the sender as its domain. Nothing personal crosses the wire, so nothing
 * personal can reach the report.
 */
export const SETTINGS_SQL = `SELECT key, CASE
  WHEN key LIKE 'enc:%' OR key IN ('admin_password_hash', 'email_notify_to')
    THEN CASE WHEN value IS NULL OR value = '' THEN '' ELSE 'set' END
  WHEN key = 'email_from'
    THEN CASE WHEN instr(value, '@') > 0 THEN 'domain:' || lower(substr(value, instr(value, '@') + 1)) ELSE 'malformed' END
  ELSE value END AS value
FROM settings
WHERE key LIKE 'enc:%' OR key IN ('setup_complete', 'admin_password_hash', 'payment_methods_disabled', 'cart_enabled', 'email_enabled', 'email_provider', 'email_from', 'email_notify_to', 'turnstile_enabled', 'turnstile_site_key')`;

/** The groups, in the order a reader should fix them. Each returns findings. */
export const GROUPS = [
  { id: 'core', title: 'Socle', run: coreGroup },
  { id: 'tree', title: 'Arbre', run: treeGroup },
  { id: 'account', title: 'Compte Cloudflare (lecture)', run: accountGroup },
  { id: 'database', title: 'Base de production (lecture masquée)', run: databaseGroup },
  { id: 'public', title: 'Vitrine publique', run: publicGroup },
  { id: 'forge', title: 'Dépôt GitHub', run: forgeGroup },
  { id: 'attestations', title: 'Attestations de la recette', run: (context) => context.attestations.findings },
];

/**
 * @param {{ positionals: string[], values: Record<string, string|boolean> }} args
 * @param {Reporter} reporter
 * @param {object} [deps] stand-ins for the reads, for the suite; each defaults
 *   to the real one
 */
export async function runCertify(args, reporter, deps = {}) {
  if (args.positionals.length > 0) throw usageError(`certify ne prend pas d'argument positionnel ; reçu « ${args.positionals.join('", "')} ».`, certifyUsage.trim());
  const env = requireEnvironment(args.values['--env']);
  if (env !== 'production') throw usageError('certify juge la production, et elle seule.', 'Une boutique se certifie là où elle vend : --env production.');

  const shop = resolveShop(deps.cwd ?? process.cwd(), args.values['--shop']);
  const { manifest, root } = shop;
  const now = deps.now ?? new Date();
  const today = localDay(now, manifest.client?.timezone);
  const origin = originOf(args.values['--url'], manifest);

  const attestationsPath = join(root, ATTESTATIONS_FILE);
  const attestationsText = existsSync(attestationsPath) ? readFileSync(attestationsPath, 'utf8') : null;
  const attestations = judgeAttestations(attestationsText, { manifest, today });

  const context = {
    root,
    shop,
    manifest,
    values: args.values,
    origin,
    now,
    attestations,
    rateLimits: args.values['--rate-limits'] === true,
    skipBrowser: args.values['--skip-browser'] === true,
    skipLighthouse: args.values['--skip-lighthouse'] === true,
    deps,
  };

  reporter.step(`Certification de ${manifest.client.slug} — ${origin} — ${today}`);
  const groups = [];
  for (const group of deps.groups ?? GROUPS) {
    reporter.section(group.title);
    let findings;
    try {
      findings = await group.run(context);
    } catch (error) {
      if (!(error instanceof ShopctlError)) throw error;
      // A group that could not be asked is not a group that passed, nor one
      // that failed: it is said, with what to do, and the next group runs.
      findings = [{ status: error.kind === 'verification' || error.kind === 'input' ? 'fail' : 'skip', message: error.message, ...(error.hint ? { hint: error.hint } : {}) }];
    }
    const clean = findings.map(cleanFinding);
    for (const finding of clean) reporter.entry(finding.status, finding.message, finding.hint ?? null);
    groups.push({ id: group.id, title: group.title, findings: clean });
  }

  const verdict = verdictOf(groups);
  const document = {
    command: 'certify',
    ok: verdict.certified,
    certified: verdict.certified,
    shop: manifest.client.slug,
    env,
    origin,
    date: today,
    checkedAt: now.toISOString(),
    core: context.core ? { version: context.core.core.merged, tag: context.core.core.mergedTag, floor: CERTIFIED_FLOOR } : { version: null, tag: null, floor: CERTIFIED_FLOOR },
    counts: verdict.counts,
    groups,
    written: [],
  };

  if (args.values['--write'] === true) {
    const directory = join('client/certification', today);
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'certify.json'), `${JSON.stringify(document, null, 2)}\n`);
    writeFileSync(join(root, directory, 'certify.md'), renderMarkdown(document));
    document.written.push(`${directory}/certify.json`, `${directory}/certify.md`);
    if (attestationsText === null) {
      writeFileSync(attestationsPath, ATTESTATIONS_TEMPLATE);
      document.written.push(ATTESTATIONS_FILE);
    }
    reporter.section('Rapport');
    for (const path of document.written) reporter.ok(`${path} écrit`);
  }

  reporter.result(document);
  const { counts } = verdict;
  if (!verdict.certified) {
    throw verificationError(
      `${manifest.client.slug} n'est pas certifiable : ${counts.fail} en échec, ${counts.todo} à attester, ${counts.skip} sauté(s).`,
      'Chaque ligne ✗ (échec), · (à attester) et - (sauté) ci-dessus dit quoi faire ; relancez ensuite.',
    );
  }
  if (!reporter.json) {
    reporter.section(
      `${manifest.client.slug} est certifiable${counts.warn > 0 ? ` (${counts.warn} avertissement(s) à lire)` : ''}. ${
        args.values['--write'] === true ? `Versez client/certification/${today}/ et les attestations par une pull request de la boutique.` : 'Relancez avec --write pour écrire le rapport.'
      }`,
    );
  }
  return 0;
}

// ── groups ───────────────────────────────────────────────────────────────────

function coreGroup(context) {
  const state = (context.deps.coreState ?? coreState)(context.shop, { offline: false });
  context.core = state;
  return judgeCore(state, { declared: context.attestations.core });
}

function treeGroup(context) {
  const { root, deps } = context;
  const run = deps.capture ?? capture;
  const findings = [];
  const toolchain = run('node', ['scripts/check-toolchain.mjs'], { cwd: root, allowFailure: true });
  findings.push(toolchain.status === 0
    ? { status: 'ok', message: 'outillage conforme (doctor)' }
    : { status: 'fail', message: 'outillage non conforme.', hint: firstLines(toolchain) });
  const gates = (deps.shopGates ?? runShopGates)(root);
  for (const gate of gates.checks) {
    const raw = gate.check === 'manifeste' ? gates.manifest : gates.paths;
    findings.push(gate.ok
      ? { status: 'ok', message: `${gate.check} valide` }
      : { status: 'fail', message: `${gate.check} refusé.`, hint: describeGateFailure(raw) });
  }
  const secrets = run('node', ['scripts/check-secrets.mjs', '--history'], { cwd: root, allowFailure: true });
  findings.push(secrets.status === 0
    ? { status: 'ok', message: 'aucun secret dans tout l\'historique du dépôt' }
    : { status: 'fail', message: 'le scan de l\'historique trouve un secret, ou ne peut pas lire l\'historique.', hint: firstLines(secrets) });
  findings.push(...judgeManifest(context.manifest));
  return findings;
}

async function accountGroup(context) {
  const { root, manifest, values, deps } = context;
  const silent = silentReporter();
  const pass = Object.fromEntries(['--account', '--shop'].filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
  try {
    await (deps.provision ?? runProvision)({ positionals: [], values: { '--env': 'production', '--dry-run': true, '--json': true, ...pass } }, silent.reporter);
  } catch (error) {
    // A refused dry run still wrote its document first; one that stopped
    // before (an account that does not match) has only its error to give.
    if (!(error instanceof ShopctlError) || !silent.document()) throw error;
  }
  const result = silent.document();
  const worker = resourceNames(manifest, { env: 'production' }).worker;
  const secrets = (deps.listSecrets ?? listSecrets)(worker, { cwd: root });
  return judgeAccount(result, secrets, INTERNAL_SECRETS.map(([name]) => name));
}

function databaseGroup(context) {
  const { root, manifest, values, deps } = context;
  (deps.openEnvironment ?? openEnvironment)({
    values,
    manifest,
    root,
    env: 'production',
    reporter: silentReporter().reporter,
    missing: 'La production n\'est pas provisionnée.',
  });
  const [rows] = (deps.query ?? query)([SETTINGS_SQL], { cwd: root, remote: true, what: 'réglages de la production' });
  const storeConfigPath = join(root, 'src/store.config.ts');
  const storeConfig = existsSync(storeConfigPath) ? readFileSync(storeConfigPath, 'utf8') : null;
  return judgeSettings(rows, { storeConfig });
}

async function publicGroup(context) {
  const { root, origin, deps } = context;
  const fetchImpl = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const findings = [];

  const smoke = await (deps.smoke ?? runSmoke)(origin, { fetchImpl });
  const failed = smoke.results.filter((result) => !result.ok);
  if (failed.length === 0) findings.push({ status: 'ok', message: `test de fumée : ${smoke.results.length} contrôles verts` });
  for (const result of failed) {
    findings.push({ status: result.severity === 'warn' ? 'warn' : 'fail', message: `test de fumée, ${result.what} : ${result.message}` });
  }

  findings.push(...judgePages(await readPages(origin, { fetchImpl })));
  findings.push(await runSecurityGate(root, origin, { rateLimits: context.rateLimits, run: deps.spawn, env }));
  findings.push(context.skipBrowser
    ? { status: 'skip', message: 'porte navigateur distante : sautée à la demande (--skip-browser).' }
    : await runBrowserGate(root, origin, { run: deps.spawn, env }));

  if (context.skipLighthouse) {
    findings.push({ status: 'skip', message: 'Lighthouse : sauté à la demande (--skip-lighthouse).' });
    return findings;
  }
  // One unanswered page is an API that will not answer the next three either:
  // they are skipped with the same reason rather than waited on in turn.
  let unavailable = null;
  for (const page of await lighthousePages(origin, { fetchImpl })) {
    if (!page.path) {
      findings.push({ status: 'skip', message: `Lighthouse, ${page.label} : ${page.missing}.` });
      continue;
    }
    const answer = unavailable ?? (await pageSpeed(new URL(page.path, origin).toString(), { env, fetchImpl }));
    if (!answer.document) {
      unavailable = answer;
      findings.push({ status: 'skip', message: `Lighthouse, ${page.label} : ${answer.error}.`, ...(answer.hint ? { hint: answer.hint } : {}) });
      continue;
    }
    findings.push(judgeLighthouse(page.label, answer.document));
  }
  return findings;
}

function forgeGroup(context) {
  const { root, manifest, now, deps } = context;
  const slug = manifest.client.slug;
  if (!deps.forge) assertForgeReady({ cwd: root });
  const url = originUrl(root);
  if (!url) return [{ status: 'fail', message: 'pas de remote « origin » : la boutique n\'a pas de dépôt GitHub.', hint: '`shopctl repo` le crée.' }];
  const { nameWithOwner } = parseGithubRemote(url);
  const read = (deps.forge ?? readForge)(nameWithOwner, { cwd: root, slug });
  const head = capture('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true }).stdout.trim() || null;
  return [{ status: 'ok', message: `dépôt ${nameWithOwner}` }, ...judgeForge(read, { slug, head, now })];
}

/** Secrets a shop's repository must not hold once a fleet deploys it. */
const FLEET_LEFTOVERS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'MONITOR_CLOUDFLARE_API_TOKEN', 'MONITOR_CLOUDFLARE_ACCOUNT_ID'];

/**
 * Everything the forge group judges, read through gh.
 *
 * A shop on the shared account (ADR 0019) is judged where its credentials and
 * runs are: the fleet repository its MINSHOP_FLEET variable names — its
 * environments, its secrets, this shop's line of its fleet.json and this
 * shop's jobs in its Deploy and Nightly — plus the one thing its own
 * repository must show, which is no Cloudflare secret at all.
 */
export function readForge(nameWithOwner, { cwd, slug }) {
  const fleet = repositoryVariable(nameWithOwner, FLEET_VARIABLE, { cwd });
  if (!fleet) return readRepository(nameWithOwner, { cwd, slug });

  const leftovers = repositorySecrets(nameWithOwner, { cwd })
    .filter((name) => FLEET_LEFTOVERS.includes(name))
    .map((name) => ({ env: null, name }));
  for (const env of environmentNames(nameWithOwner, { cwd })) {
    for (const name of environmentSecrets(nameWithOwner, env, { cwd }).filter((secret) => FLEET_LEFTOVERS.includes(secret))) leftovers.push({ env, name });
  }
  let entry = null;
  let registry = 'absent';
  const text = repositoryFile(fleet, FLEET_FILE, { cwd });
  if (text !== null) {
    try {
      const shops = JSON.parse(text)?.shops;
      entry = (Array.isArray(shops) ? shops : []).find((candidate) => candidate?.slug === slug) ?? null;
      registry = 'read';
    } catch {
      registry = 'unreadable';
    }
  }
  return {
    ...readRepository(fleet, { cwd, slug, suffix: ` (${slug})` }),
    fleet: { repository: fleet, shop: nameWithOwner, registry, entry: entry ? { slug: entry.slug, repository: entry.repository ?? null } : null, leftovers },
  };
}

/**
 * One repository's environments, secrets and runs. Workflow runs are listed
 * once per workflow and a run's jobs read once, whichever question asks for
 * them. `suffix` names the shop in a fleet's matrix jobs.
 */
function readRepository(nameWithOwner, { cwd, slug, suffix = '' }) {
  const info = repository(nameWithOwner, { cwd });
  if (!info) {
    throw new ShopctlError(`gh ne trouve pas le dépôt ${nameWithOwner}.`, { kind: 'precondition', hint: 'Vérifiez `gh auth status` et les droits du compte sur ce dépôt.' });
  }
  const defaultBranch = info.defaultBranchRef?.name ?? 'main';
  const environments = {};
  const secrets = { repository: repositorySecrets(nameWithOwner, { cwd }) };
  for (const name of ['production', BACKUP_ENVIRONMENT]) {
    const protection = environmentProtection(nameWithOwner, name, { cwd });
    environments[name] = protection
      ? { ...protection, branches: protection.customBranches ? branchPolicies(nameWithOwner, name, { cwd }) : [] }
      : null;
    secrets[name] = protection ? environmentSecrets(nameWithOwner, name, { cwd }) : [];
  }

  const runs = new Map();
  const jobs = new Map();
  const latestJob = (workflow, name) => {
    if (!runs.has(workflow)) runs.set(workflow, workflowRuns(nameWithOwner, workflow, { cwd, limit: 20 }) ?? []);
    let viewed = 0;
    for (const run of runs.get(workflow)) {
      if (run.status !== 'completed') continue;
      // Ten runs back at most: a job not seen by then is not running.
      if (viewed >= 10) break;
      if (!jobs.has(run.databaseId)) {
        jobs.set(run.databaseId, runJobs(nameWithOwner, run.databaseId, { cwd }) ?? []);
        viewed += 1;
      }
      // A job its run skipped is not a verdict: the midday nightly skips the
      // watch on purpose, and a staging deployment names no production job.
      const job = jobs.get(run.databaseId).find((entry) => entry.name === name && entry.conclusion && entry.conclusion !== 'skipped');
      if (job) {
        return {
          status: job.status,
          conclusion: job.conclusion,
          at: job.completedAt ?? run.createdAt,
          sha: run.headSha ?? '',
          steps: (job.steps ?? []).map((step) => ({ name: step.name, conclusion: step.conclusion })),
        };
      }
    }
    return null;
  };

  return {
    defaultBranch,
    environments,
    secrets,
    deploy: latestJob('deploy.yml', `Deploy ${slug} (production)`),
    nightly: {
      backup: latestJob('nightly.yml', `Production backup${suffix}`),
      watch: latestJob('nightly.yml', `Production error rate and quotas${suffix}`),
    },
  };
}

// ── report ───────────────────────────────────────────────────────────────────

const SYMBOLS = { ok: '✓', warn: '!', fail: '✗', todo: '·', skip: '-' };

/** The committed report. Same findings as the JSON, for a human reading a pull request. */
export function renderMarkdown(document) {
  const { counts } = document;
  const lines = [
    `# Certification de ${document.shop} — ${document.date}`,
    '',
    `- Origine : ${document.origin}`,
    `- Socle : ${document.core.tag ?? 'inconnu'} (plancher v${document.core.floor})`,
    `- Verdict : **${document.certified ? 'certifiable' : 'non certifiable'}** — ${counts.ok} vert(s), ${counts.warn} avertissement(s), ${counts.fail} en échec, ${counts.todo} à attester, ${counts.skip} sauté(s)`,
    '',
  ];
  for (const group of document.groups) {
    lines.push(`## ${group.title}`, '');
    for (const finding of group.findings) {
      lines.push(`- ${SYMBOLS[finding.status] ?? '?'} ${finding.message}`);
      if (finding.hint) lines.push(`  ${finding.hint.replace(/\n\s*/g, ' ')}`);
    }
    lines.push('');
  }
  lines.push(
    `Produit par \`shopctl certify --env production\` le ${document.checkedAt}. Lecture seule ; aucune donnée personnelle :`,
    'secrets, mot de passe et destinataire des alertes lus masqués, expéditeur réduit à son domaine.',
    '',
  );
  return lines.join('\n');
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A line for a committed report: credentials redacted, and an address — a
 *  Cloudflare account is named after its owner's until renamed — masked. */
function cleanFinding(finding) {
  const scrub = (text) => redact(String(text)).replace(/[^\s<>"'(),;:@]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>');
  return { status: finding.status, message: scrub(finding.message), ...(finding.hint ? { hint: scrub(finding.hint) } : {}) };
}

/** A reporter whose output nobody sees, and the JSON document it was given. */
function silentReporter() {
  let text = '';
  const sink = { write: () => true };
  const out = {
    write: (chunk) => {
      text += chunk;
      return true;
    },
  };
  return {
    reporter: new Reporter({ json: true, stdout: out, stderr: sink }),
    document: () => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    },
  };
}

/** The day in the shop's own time zone: an attestation dated this morning in
 *  Paris is not in the future at 00:30 UTC. */
function localDay(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function originOf(url, manifest) {
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw usageError(`--url « ${url} » n'est pas une URL.`);
    }
    return parsed.origin;
  }
  return `https://${manifest.cloudflare.productionDomain}`;
}

function firstLines(result, count = 4) {
  return String(result.stderr || result.stdout || '').trim().split('\n').slice(0, count).join('\n    ') || null;
}
