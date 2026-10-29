/**
 * `shopctl fleet init` and `shopctl fleet repo` — the fleet's own repository
 * (ADR 0019).
 *
 * On the shared Cloudflare account no token can be limited to one shop: D1
 * Read or Write is for every database of the account, and R2 can name buckets
 * only through the S3 API that wrangler does not speak. A token in a shop's
 * repository would therefore be a key to every shop's buyers, copied once per
 * shop. So the tokens live in ONE repository, the fleet's — the directory that
 * already holds `fleet.json` — and its workflows run for every shop of the
 * registry what each shop's own Deploy and Nightly ran for itself, with the
 * shopctl of the core each shop is on.
 *
 *   fleet init   writes the fleet's workflows next to fleet.json, from the
 *                templates this core ships; re-run, it rewrites them
 *   fleet repo   the fleet's GitHub repository, its environments, and the
 *                shared account's credentials those environments scope
 *
 * `shopctl repo --fleet <owner/repo>` is the shop's half: no environment and
 * no Cloudflare secret in the shop's repository, a variable naming the fleet.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { CLIENT_MANIFEST, ENVIRONMENTS, environmentAccount, loadManifest } from '../../../scripts/manifest.mjs';
import { ShopctlError, inputError, preconditionError } from '../errors.mjs';
import { FLEET_MINIMUM_CORE, findRegistry, readRegistry } from '../fleet.mjs';
import { DEFAULT_KEY_FILE, KEY_ENV, keyId, loadKey } from '../backup/crypto.mjs';
import { CORE_ROOT, corePackage } from '../paths.mjs';
import { capture } from '../process.mjs';
import {
  assertForgeReady,
  branchOnRemote,
  createRepository,
  defaultOwner,
  environmentSecrets,
  environments,
  gitProtocol,
  originUrl,
  parseGithubRemote,
  pushBranch,
  putEnvironment,
  repository,
  repositorySecrets,
  repositoryUrl,
  restrictEnvironment,
  setEnvironmentSecret,
  setRepositorySecret,
  userId,
} from '../forge.mjs';
import { BACKUP_ENVIRONMENT, backupTokenFor, tokenFor } from './repo.mjs';

/** The fleet's files, by their path in the fleet repository → their template. */
export const FLEET_FILES = {
  '.github/workflows/deploy.yml': 'deploy.yml',
  '.github/workflows/nightly.yml': 'nightly.yml',
  '.github/fleet/shops.mjs': 'shops.mjs',
};

const TEMPLATES = resolve(CORE_ROOT, 'shopctl/templates/fleet');

/** The repository a fleet is called when nothing names it. */
export const FLEET_REPOSITORY_NAME = 'minshop-fleet';

/** Where `loadKey` finds the backup key in the fleet's tree, as .gitignore says it. */
const KEY_DIRECTORY = `/${dirname(DEFAULT_KEY_FILE)}/`;

/** Where the fleet's monitor token comes from, and the shops' read token. */
const MONITOR_FROM = 'CLOUDFLARE_API_TOKEN_MONITOR'; // secret-scan:ignore — a variable's name
const SHOPS_READER = 'SHOPS_READ_TOKEN'; // secret-scan:ignore — a secret's name

/** One template, with the version that wrote it and the floor it enforces. */
export function renderFleetFile(template, { version = corePackage().version } = {}) {
  const text = readFileSync(resolve(TEMPLATES, template), 'utf8');
  return text
    .replace(
      '__GENERATED__',
      `Généré par \`shopctl fleet init\` depuis le socle v${version}. Relancez-le pour le mettre à jour : une modification à la main est perdue au passage suivant.`,
    )
    .split('__MINIMUM_CORE__')
    .join(FLEET_MINIMUM_CORE);
}

/** The registry a fleet command works on, and the directory that holds it. */
function fleetAt(args) {
  const file = findRegistry(process.cwd(), args.values['--registry']);
  return { file, root: dirname(file), fleet: readRegistry(file) };
}

// ── fleet init ───────────────────────────────────────────────────────────────

export function initFleet(args, reporter) {
  const dryRun = args.values['--dry-run'] === true;
  const { file, root, fleet } = fleetAt(args);
  const version = corePackage().version;

  reporter.section(`Dépôt de flotte — ${root}`);
  const files = [];
  for (const [path, template] of Object.entries(FLEET_FILES)) {
    const target = resolve(root, path);
    const wanted = renderFleetFile(template, { version });
    const present = existsSync(target) ? readFileSync(target, 'utf8') : null;
    const action = present === null ? 'create' : present === wanted ? 'keep' : 'replace';
    files.push({ path, action });
    if (action === 'keep') {
      reporter.ok(`${path} — à jour`);
      continue;
    }
    if (dryRun) {
      reporter.todo(`${path} — ${action === 'create' ? 'serait créé' : 'serait remplacé'}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, wanted);
    reporter.ok(`${path} — ${action === 'create' ? 'créé' : 'remplacé'} (socle v${version})`);
  }

  // The shops' checkouts sit next to fleet.json, inside the fleet's working
  // tree: each is a repository of its own, and `git add -A` in the fleet
  // would record it as an embedded repository nobody can clone. The backup
  // key is read from the fleet's own `.shopctl/` by `fleet repo`, and the
  // fleet repository is public: committed, it would open every archive.
  const ignore = resolve(root, '.gitignore');
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8').split('\n').map((line) => line.trim()) : [];
  const missing = [
    KEY_DIRECTORY,
    ...fleet.shops
      .map((shop) => relative(root, shop.root).split('\\').join('/'))
      .filter((path) => path && !path.startsWith('..') && !isAbsolute(path))
      .map((path) => `/${path}/`),
  ].filter((line) => !ignored.includes(line));
  if (missing.length > 0) {
    if (dryRun) {
      reporter.todo(`.gitignore — ${missing.join(', ')} seraient ignorés`);
    } else {
      const before = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
      writeFileSync(ignore, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
      reporter.ok(`.gitignore — ${missing.join(', ')} ignorés (la clé de sauvegarde ne se publie pas, les boutiques sont des dépôts à part)`);
    }
  }

  reporter.section('Boutiques');
  const shops = fleet.shops.map((shop) => ({ slug: shop.slug, repository: shop.repository }));
  for (const shop of shops) {
    if (shop.repository) reporter.ok(`${shop.slug} — ${shop.repository}`);
    else {
      reporter.todo(
        `${shop.slug} — pas de dépôt : ni déployée ni sauvegardée par la flotte.`,
        `Ajoutez "repository": "propriétaire/dépôt" à son entrée de ${relative(process.cwd(), file) || file}.`,
      );
    }
  }

  const report = { command: 'fleet init', ok: true, dryRun, registry: file, root, core: version, minimumCore: FLEET_MINIMUM_CORE, files, shops };
  reporter.result(report);
  if (!reporter.json) {
    reporter.section(dryRun ? 'Rien n\'a été écrit (--dry-run).' : 'Committez ces fichiers, puis `shopctl fleet repo` pose les secrets du compte mutualisé.');
  }
  return 0;
}

// ── fleet repo ───────────────────────────────────────────────────────────────

/**
 * The one account the fleet's secrets point at: every fleet-managed shop's
 * manifest names it, or CLOUDFLARE_ACCOUNT_ID does. Two that disagree stop the
 * run — a fleet repository whose account is a guess deploys somewhere.
 */
export function fleetAccount(fleet, env = process.env) {
  const named = new Map();
  for (const shop of fleet.shops.filter((entry) => entry.repository && entry.isShop)) {
    const { manifest } = loadManifest(CLIENT_MANIFEST, { root: shop.root, core: null, checkTheme: false });
    if (!manifest) continue;
    for (const name of ENVIRONMENTS) {
      const id = environmentAccount(manifest, name).id;
      if (!id) continue;
      if (!named.has(id)) named.set(id, []);
      named.get(id).push(`${shop.slug} (${name})`);
    }
  }
  const fromEnv = env.CLOUDFLARE_ACCOUNT_ID || null;
  if (fromEnv && !named.has(fromEnv) && named.size > 0) named.set(fromEnv, ['CLOUDFLARE_ACCOUNT_ID']);
  if (named.size > 1) {
    throw inputError(
      `les boutiques de la flotte ne nomment pas un seul compte : ${[...named].map(([id, by]) => `${id} par ${by.join(', ')}`).join(' ; ')}.`,
      'Le dépôt de flotte porte les jetons du compte mutualisé et de lui seul (ADR 0019) : une boutique sur un autre compte n\'a pas de "repository" dans fleet.json, ou son manifeste est à corriger.',
    );
  }
  const [id] = named.size === 1 ? [...named.keys()] : [fromEnv];
  if (!id) {
    throw preconditionError(
      'aucun compte Cloudflare à poser dans le dépôt de flotte.',
      'Aucune boutique de fleet.json avec un "repository" n\'est extraite ici pour le dire : exportez CLOUDFLARE_ACCOUNT_ID, l\'identifiant du compte mutualisé.',
    );
  }
  return id;
}

/**
 * The fleet's monitor token: its own variable, never a token that deploys —
 * the repository secret is readable by every workflow of the fleet, on every
 * branch, without an approval.
 */
export function monitorTokenFor(source = process.env) {
  const value = source[MONITOR_FROM];
  if (!value) return null;
  const writing = [tokenFor('production', source), tokenFor('staging', source), source.CLOUDFLARE_API_TOKEN_BACKUP ? { value: source.CLOUDFLARE_API_TOKEN_BACKUP, from: 'CLOUDFLARE_API_TOKEN_BACKUP' } : null].filter(Boolean);
  const same = writing.find((token) => token.value === value);
  if (same) {
    throw inputError(
      `${MONITOR_FROM} est le jeton de ${same.from}.`,
      'Le jeton de surveillance est un secret du dépôt, lisible sans approbation depuis n\'importe quelle branche : il ne lit que les métriques (Account Analytics, D1 et Account Settings en lecture, Memberships et User Details en lecture).',
    );
  }
  return { value, from: MONITOR_FROM };
}

export function setupFleetRepository(args, reporter, { env = process.env } = {}) {
  const dryRun = args.values['--dry-run'] === true;
  const { file, root, fleet } = fleetAt(args);
  if (!existsSync(resolve(root, '.git'))) {
    throw preconditionError(
      `${root} n'est pas un dépôt git.`,
      `Le dépôt de flotte est le répertoire de ${relative(process.cwd(), file) || file} : \`git init\`, \`shopctl fleet init\`, puis un premier commit.`,
    );
  }
  const missingFiles = Object.keys(FLEET_FILES).filter((path) => !existsSync(resolve(root, path)));
  if (missingFiles.length > 0) {
    throw preconditionError(`${missingFiles.join(', ')} absent${missingFiles.length > 1 ? 's' : ''} du dépôt de flotte.`, '`shopctl fleet init` les écrit ; committez-les, puis relancez.');
  }
  // Asked of the index, so a key only staged is caught too: the fleet
  // repository is public, and this command pushes it.
  const keyDirectory = dirname(DEFAULT_KEY_FILE);
  const trackedKeys = capture('git', ['ls-files', '--', keyDirectory], { cwd: root }).stdout.trim();
  if (trackedKeys) {
    throw preconditionError(
      `${trackedKeys.split('\n').join(', ')} est suivi par git dans le dépôt de flotte : la clé des archives de toutes les boutiques.`,
      `\`git rm -r --cached ${keyDirectory}\`, \`shopctl fleet init\` (qui l'ignore), un commit, puis relancez. Un commit qui la portait et qui a déjà été poussé l'a publiée.`,
    );
  }

  reporter.section('GitHub');
  assertForgeReady({ cwd: root });
  // Every credential is read and judged before anything is created.
  const backupToken = backupTokenFor(env);
  const monitorToken = monitorTokenFor(env);
  const account = fleetAccount(fleet, env);

  let url = args.values['--origin'] ?? originUrl(root);
  let derived = false;
  if (!url) {
    const owner = args.values['--owner'] ?? defaultOwner({ cwd: root });
    url = repositoryUrl(owner, FLEET_REPOSITORY_NAME, gitProtocol({ cwd: root }));
    derived = true;
  }
  const target = parseGithubRemote(url);
  if (derived) reporter.step(`Dépôt déduit : ${target.nameWithOwner} (ni --origin ni remote « origin »)`);
  // Public unless asked otherwise, the opposite of a shop's default and for
  // the reason ADR 0019 gives: under GitHub Free only a public repository has
  // environment secrets and required reviewers. It publishes fleet.json and
  // the workflows — slugs, repositories, domains — and no data, no secret.
  const visibility = args.values['--private'] === true ? 'private' : 'public';
  const head = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).stdout.trim();

  const existing = repository(target.nameWithOwner, { cwd: root });
  let created = false;
  if (existing) {
    reporter.ok(`${target.nameWithOwner} existe déjà (${existing.visibility?.toLowerCase() ?? 'visibilité inconnue'})`);
  } else if (dryRun) {
    reporter.todo(`${target.nameWithOwner} serait créé (${visibility})`);
  } else {
    createRepository(target.nameWithOwner, { cwd: root, visibility, description: 'Flotte Minshop — déploiements et nuits des boutiques du compte mutualisé' });
    created = true;
    reporter.ok(`${target.nameWithOwner} créé (${visibility})`);
  }
  if (derived && !dryRun && !originUrl(root)) {
    capture('git', ['remote', 'add', 'origin', url], { cwd: root });
    reporter.ok(`remote « origin » configuré sur ${url}`);
  }
  let pushed = false;
  if (args.values['--no-push'] === true) {
    reporter.warn(`branche ${head} non poussée (--no-push).`);
  } else if (dryRun) {
    reporter.todo(`${head} serait poussée sur origin`);
  } else if (!created && branchOnRemote(root, head)) {
    reporter.ok(`${head} est déjà sur origin`);
  } else {
    pushBranch(root, head);
    pushed = true;
    reporter.ok(`${head} poussée sur origin`);
  }

  // ── environments ──────────────────────────────────────────────────────────
  reporter.section('Environnements');
  const present = existing || created ? environments(target.nameWithOwner, { cwd: root }) : [];
  const reviewers = [];
  for (const login of String(args.values['--reviewer'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const id = dryRun ? null : userId(login, { cwd: root });
    if (id) reviewers.push({ type: 'User', id });
    else if (!dryRun) reporter.warn(`relecteur « ${login} » introuvable sur GitHub.`, 'Il est ignoré pour cette exécution.');
  }
  const backupBranch = existing?.defaultBranchRef?.name ?? head;
  const environmentReport = [];
  for (const name of [...ENVIRONMENTS, BACKUP_ENVIRONMENT]) {
    const action = present.includes(name) ? 'keep' : 'create';
    const wanted = name === 'production' ? reviewers : [];
    if (dryRun) {
      reporter.todo(`${name} — ${action === 'keep' ? 'déjà présent' : 'serait créé'}`);
      environmentReport.push({ env: name, action, protected: false, refusal: null });
      continue;
    }
    const backup = name === BACKUP_ENVIRONMENT;
    const outcome = putEnvironment(target.nameWithOwner, name, { cwd: root, reviewers: wanted, branchPolicy: backup });
    if (backup) restrictEnvironment(target.nameWithOwner, name, [backupBranch], { cwd: root });
    environmentReport.push({ env: name, action, protected: outcome.protected, refusal: outcome.refusal ?? null, ...(backup ? { branches: [backupBranch] } : {}) });
    reporter.ok(
      `${name} — ${action === 'keep' ? 'déjà présent' : 'créé'}${outcome.protected ? `, ${wanted.length} relecteur(s) obligatoire(s)` : ''}${backup ? `, limité à la branche ${backupBranch}` : ''}`,
    );
    if (outcome.refusal) {
      reporter.warn(`${name} : GitHub a refusé les relecteurs obligatoires.`, 'Sur un dépôt privé, ils demandent un plan payant : le dépôt de flotte est public par défaut pour cette raison.');
    } else if (name === 'production' && wanted.length === 0) {
      reporter.warn('production n\'a aucun relecteur obligatoire.', 'Passez --reviewer <login> : le déploiement de production de chaque boutique attendra une approbation humaine.');
    }
  }

  // ── secrets ───────────────────────────────────────────────────────────────
  reporter.section('Secrets');
  let backupKey = null;
  try {
    backupKey = loadKey({ root, env });
  } catch (error) {
    if (!(error instanceof ShopctlError)) throw error;
    reporter.warn(`aucune clé de sauvegarde à poser (${KEY_ENV}).`, 'Posez SHOPCTL_BACKUP_KEY, celle des boutiques, puis relancez : sans elle, la production ne se déploie pas et la nuit ne sauvegarde rien.');
  }
  const secretReport = [];
  const missingTokens = [];
  for (const name of [...ENVIRONMENTS, BACKUP_ENVIRONMENT]) {
    const token = name === BACKUP_ENVIRONMENT ? backupToken : tokenFor(name, env);
    if (!token) {
      missingTokens.push(name);
      reporter.warn(
        `${name} : aucun jeton Cloudflare.`,
        name === BACKUP_ENVIRONMENT
          ? 'Exportez CLOUDFLARE_API_TOKEN_BACKUP — D1 en lecture, Workers R2 Storage en écriture, Account Settings, Memberships et User Details en lecture — et relancez.'
          : `Exportez CLOUDFLARE_API_TOKEN_${name.toUpperCase()} (ou CLOUDFLARE_API_TOKEN) et relancez.`,
      );
      continue;
    }
    if (dryRun) {
      reporter.todo(`${name} — CLOUDFLARE_API_TOKEN (${token.from}) et CLOUDFLARE_ACCOUNT_ID (${account}) seraient posés`);
      secretReport.push({ env: name, set: [], from: token.from });
      continue;
    }
    const held = environmentSecrets(target.nameWithOwner, name, { cwd: root });
    setEnvironmentSecret(target.nameWithOwner, name, 'CLOUDFLARE_API_TOKEN', token.value, { cwd: root });
    setEnvironmentSecret(target.nameWithOwner, name, 'CLOUDFLARE_ACCOUNT_ID', account, { cwd: root });
    const set = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
    reporter.ok(`${name} — CLOUDFLARE_API_TOKEN (depuis ${token.from}) et CLOUDFLARE_ACCOUNT_ID (${account}) posés`);
    // Kept when present, as in a shop's repository: archives are sealed with it.
    if (backupKey && held.includes(KEY_ENV)) {
      reporter.ok(`${name} — ${KEY_ENV} déjà posé, conservé (clé locale ${keyId(backupKey.key)})`);
    } else if (backupKey) {
      setEnvironmentSecret(target.nameWithOwner, name, KEY_ENV, backupKey.key.toString('base64'), { cwd: root });
      set.push(KEY_ENV);
      reporter.ok(`${name} — ${KEY_ENV} posé (clé ${keyId(backupKey.key)}, depuis ${backupKey.source})`);
    }
    secretReport.push({ env: name, set, from: token.from });
  }

  const repositoryReport = [];
  if (!monitorToken) {
    reporter.warn(`aucun jeton de surveillance (${MONITOR_FROM}) : la production des boutiques n'est pas surveillée la nuit.`, 'Un jeton du compte mutualisé en lecture seule : Account Analytics, D1 et Account Settings, Memberships et User Details.');
  } else if (dryRun) {
    reporter.todo(`dépôt — MONITOR_CLOUDFLARE_API_TOKEN et MONITOR_CLOUDFLARE_ACCOUNT_ID seraient posés`);
  } else {
    setRepositorySecret(target.nameWithOwner, 'MONITOR_CLOUDFLARE_API_TOKEN', monitorToken.value, { cwd: root });
    setRepositorySecret(target.nameWithOwner, 'MONITOR_CLOUDFLARE_ACCOUNT_ID', account, { cwd: root });
    repositoryReport.push('MONITOR_CLOUDFLARE_API_TOKEN', 'MONITOR_CLOUDFLARE_ACCOUNT_ID');
    reporter.ok(`dépôt — MONITOR_CLOUDFLARE_API_TOKEN (depuis ${MONITOR_FROM}) et MONITOR_CLOUDFLARE_ACCOUNT_ID posés`);
  }
  // Only for private shops' repositories; a public one is read without it.
  if (env[SHOPS_READER]) {
    if (dryRun) reporter.todo(`dépôt — ${SHOPS_READER} serait posé`);
    else {
      setRepositorySecret(target.nameWithOwner, SHOPS_READER, env[SHOPS_READER], { cwd: root });
      repositoryReport.push(SHOPS_READER);
      reporter.ok(`dépôt — ${SHOPS_READER} posé (lecture des dépôts de boutique privés)`);
    }
  } else if (!dryRun && repositorySecrets(target.nameWithOwner, { cwd: root }).includes(SHOPS_READER)) {
    reporter.ok(`dépôt — ${SHOPS_READER} déjà posé, conservé`);
  }

  const report = {
    command: 'fleet repo',
    ok: true,
    dryRun,
    registry: file,
    repository: { ...target, url, created, derived, visibility },
    branch: { name: head, pushed },
    account,
    environments: environmentReport,
    secrets: secretReport,
    repositorySecrets: repositoryReport,
    missingTokens,
  };
  reporter.result(report);
  if (!reporter.json) {
    reporter.section(
      missingTokens.length > 0
        ? `Dépôt de flotte prêt. ${missingTokens.length} environnement(s) sans jeton : relancez \`shopctl fleet repo\` une fois les variables posées.`
        : `Dépôt de flotte prêt : https://github.com/${target.nameWithOwner}. Côté boutique : \`shopctl repo --fleet ${target.nameWithOwner}\`.`,
    );
  }
  return 0;
}
