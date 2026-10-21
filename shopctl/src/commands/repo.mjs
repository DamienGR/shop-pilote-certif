/**
 * `shopctl repo` — the shop's GitHub repository, its environments, and the
 * credentials those environments scope.
 *
 * This is the half of "creating a shop" that used to be a dashboard visit.
 * `shopctl new` produces a tree and a first commit; everything between that
 * commit and a runnable `Deploy` workflow was, until now, six clicks and two
 * copy-pastes per customer — which is exactly the shape of work that is done
 * slightly differently every time and discovered wrong on the third shop.
 *
 * Four steps, each idempotent, each asking before writing:
 *
 *   1. the repository exists (created PRIVATE if not);
 *   2. the branch is on the remote;
 *   3. `staging` and `production` exist as GitHub Environments, and `backup`
 *      — the nightly backup of production — limited to the default branch;
 *   4. each carries CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and the
 *      backup key the CI encrypts its archives with (SHOPCTL_BACKUP_KEY).
 *
 * The tokens come from the ENVIRONMENT, never from an argument: `shopctl` has
 * refused credential-shaped arguments since jalon 2 (secrets.mjs), and a
 * command whose whole job is to place secrets is the last place to make an
 * exception. `CLOUDFLARE_API_TOKEN_STAGING` and `…_PRODUCTION` let one run
 * place two different tokens, which is the point of scoping them per
 * environment at all — a staging run that could read the production token
 * would make the separation decorative.
 *
 * What it deliberately does NOT do is push protection rules onto an account
 * that cannot have them. On a private repository, required reviewers exist
 * only under GitHub Enterprise; the command attempts them, reports plainly when
 * GitHub refuses, and still leaves the environment in place, because the
 * environment is what scopes the secrets — and that half works from GitHub Pro
 * up. GitHub Free has no environment secrets on a private repository.
 */
import { ENVIRONMENTS, environmentAccount } from '../../../scripts/manifest.mjs';
import { ShopctlError, inputError, preconditionError } from '../errors.mjs';
import { KEY_ENV, keyId, loadKey } from '../backup/crypto.mjs';
import { capture } from '../process.mjs';
import { resolveShop } from '../shop.mjs';
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
  repositoryNameFor,
  repositoryUrl,
  restrictEnvironment,
  setEnvironmentSecret,
  userId,
} from '../forge.mjs';

export const REPO_OPTIONS = { '--shop': 'slug', '--origin': 'url', '--owner': 'compte', '--branch': 'nom', '--reviewer': 'login' };

export const repoUsage = `Usage: shopctl repo [options]

  --origin <url>      Dépôt GitHub de la boutique. Par défaut, dérivé :
                      <owner>/shop-<slug>.
  --owner <compte>    Compte ou organisation GitHub (défaut : le compte
                      authentifié dans gh).
  --branch <nom>      Branche à pousser (défaut : la branche courante).
  --reviewer <login>  Relecteur obligatoire en production. Répétable via une liste
                      séparée par des virgules.
  --public            Créer le dépôt public. Par défaut : privé.
  --no-push           Ne pas pousser la branche.
  --dry-run           Interroger GitHub et n'écrire nulle part.
  --shop <slug>       Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json              Rapport lisible par une machine.

Crée ou confirme le dépôt, pousse la branche, crée les environnements
${ENVIRONMENTS.join(' et ')}, et y pose les secrets Cloudflare.

Les secrets viennent de l'environnement, jamais de la ligne de commande :

  CLOUDFLARE_API_TOKEN               utilisé pour les deux environnements
  CLOUDFLARE_API_TOKEN_STAGING       remplace le précédent pour staging
  CLOUDFLARE_API_TOKEN_PRODUCTION    remplace le précédent pour production
  CLOUDFLARE_API_TOKEN_BACKUP        jeton de la sauvegarde nocturne de la
                                     production (environnement backup) ; jamais
                                     remplacé par CLOUDFLARE_API_TOKEN

L'identifiant de compte, lui, vient du manifeste : cloudflare.accountId, et
cloudflare.productionAccountId quand la production vit sur un autre compte.
`;

/**
 * Which Cloudflare token belongs to which environment.
 *
 * A per-environment variable wins over the shared one, and the shared one is
 * accepted rather than refused: an agency starting out has one token, and
 * demanding two before anything can be set up would be a rule that teaches
 * people to put the production token in both. Which one was used is reported,
 * so "both environments share a token" is a fact on the record rather than an
 * assumption.
 */
export function tokenFor(env, source = process.env) {
  const specific = source[`CLOUDFLARE_API_TOKEN_${env.toUpperCase()}`];
  if (specific) return { value: specific, from: `CLOUDFLARE_API_TOKEN_${env.toUpperCase()}` };
  if (source.CLOUDFLARE_API_TOKEN) return { value: source.CLOUDFLARE_API_TOKEN, from: 'CLOUDFLARE_API_TOKEN' };
  return null;
}

/**
 * The GitHub Environment the nightly backup of production runs in.
 *
 * Not `production`: its required reviewers would hold every night's run for an
 * approval, and its token can deploy. An environment of its own, without
 * reviewers, limited to the default branch so that no other branch's workflow
 * can read its secrets, with a token of its own — D1 read and R2 write on the
 * production account, nothing that deploys (ADR 0005, certification step 9).
 */
export const BACKUP_ENVIRONMENT = 'backup';

/**
 * The backup environment's token: its own variable or nothing.
 *
 * Never the shared CLOUDFLARE_API_TOKEN, and never production's: either would
 * put a token that deploys in an environment that asks nobody's approval —
 * production's reviewers, bypassed by a nightly job.
 */
export function backupTokenFor(source = process.env) {
  const value = source.CLOUDFLARE_API_TOKEN_BACKUP;
  if (!value) return null;
  const deploying = [tokenFor('production', source), tokenFor('staging', source)].filter(Boolean);
  const same = deploying.find((token) => token.value === value);
  if (same) {
    throw inputError(
      `CLOUDFLARE_API_TOKEN_BACKUP est le jeton de ${same.from}.`,
      "L'environnement backup ne demande l'approbation de personne : un jeton qui déploie y contournerait les relecteurs de production. Créez sur le compte de production un jeton à part — D1 en lecture, Workers R2 Storage en écriture, Account Settings et Memberships en lecture, User Details en lecture — et rien d'autre.",
    );
  }
  return { value, from: 'CLOUDFLARE_API_TOKEN_BACKUP' };
}

/** The branch a shop tree is on. */
function currentBranch(cwd) {
  return capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).stdout.trim();
}

export function runRepo(args, reporter) {
  if (args.positionals.length > 0) {
    throw new ShopctlError(`repo ne prend pas d'argument positionnel ; reçu « ${args.positionals.join('", "')} ».`, {
      kind: 'usage',
      hint: repoUsage.trim(),
    });
  }
  const dryRun = args.values['--dry-run'] === true;
  const json = args.values['--json'] === true;
  const shop = resolveShop(process.cwd(), args.values['--shop']);
  setupRepository({
    shop,
    reporter,
    dryRun,
    json,
    origin: args.values['--origin'] ?? null,
    owner: args.values['--owner'] ?? null,
    branch: args.values['--branch'] ?? null,
    reviewers: String(args.values['--reviewer'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    visibility: args.values['--public'] === true ? 'public' : 'private',
    push: args.values['--no-push'] !== true,
  });
  return 0;
}

/**
 * The whole sequence, callable from `shopctl new` as well as from `shopctl repo`.
 *
 * One implementation and two entry points, rather than a second copy inside
 * `new`: a creation path that set up the repository slightly differently from
 * the command that repairs it is the drift this CLI refuses everywhere else.
 *
 * Returns the report and emits it only when it IS the command. Called from
 * `new`, `emit` is false and the payload is embedded in that command's own
 * document — under `--json`, stdout carries exactly one document, and two would
 * make `shopctl new … --json | jq` fail on the second.
 *
 * @returns {object} the report, whether or not it was emitted
 */
export function setupRepository({
  shop,
  reporter,
  dryRun = false,
  json = false,
  origin = null,
  owner = null,
  branch = null,
  reviewers = [],
  visibility = 'private',
  push = true,
  env = process.env,
  emit = true,
}) {
  const { manifest, root } = shop;

  reporter.section('GitHub');
  assertForgeReady({ cwd: root });
  // Refused before anything is written, like every other bad input.
  const backupToken = backupTokenFor(env);

  // Three sources, in decreasing order of how explicit they are: the flag, the
  // remote the tree already has, and the convention. The convention is only
  // reached when nothing else says anything — and it is announced, because a
  // repository created somewhere the operator did not name is exactly the kind
  // of thing found a week later.
  let url = origin ?? originUrl(root);
  let derived = false;
  if (!url) {
    const account = owner ?? defaultOwner({ cwd: root });
    url = repositoryUrl(account, repositoryNameFor(manifest.client.slug), gitProtocol({ cwd: root }));
    derived = true;
  }
  const target = parseGithubRemote(url);
  if (derived) reporter.step(`Dépôt déduit : ${target.nameWithOwner} (ni --origin ni remote « origin »)`);
  const head = branch ?? currentBranch(root);

  // ── 1. the repository ─────────────────────────────────────────────────────
  const existing = repository(target.nameWithOwner, { cwd: root });
  let created = false;
  if (existing) {
    reporter.ok(`${target.nameWithOwner} existe déjà (${existing.visibility?.toLowerCase() ?? 'visibilité inconnue'})`);
    // Named, not corrected. Flipping a repository to private does not un-clone
    // it, and changing a customer's repository visibility from a provisioning
    // command is not this command's decision to make.
    if (existing.visibility && existing.visibility.toLowerCase() === 'public' && visibility === 'private') {
      reporter.warn(
        `${target.nameWithOwner} est PUBLIC alors que le dépôt d'une boutique est privé par défaut.`,
        'Il porte le manifeste, le catalogue et les contenus d\'un client. Le repasser en privé ne défait pas les clones déjà faits : vérifiez d\'abord que c\'était voulu.',
      );
    }
  } else if (dryRun) {
    reporter.todo(`${target.nameWithOwner} serait créé (${visibility})`);
  } else {
    createRepository(target.nameWithOwner, {
      cwd: root,
      visibility,
      description: `Boutique Minshop — ${manifest.client.displayName}`,
    });
    created = true;
    reporter.ok(`${target.nameWithOwner} créé (${visibility})`);
  }

  // ── 2. the branch ─────────────────────────────────────────────────────────
  //
  // A derived URL is written into the tree before the push: `git push -u origin`
  // needs a remote named `origin`, and leaving the shop without one would make
  // every later `git pull` in that clone fail for a reason nobody would connect
  // to this command.
  if (derived && !dryRun && !originUrl(root)) {
    capture('git', ['remote', 'add', 'origin', url], { cwd: root });
    reporter.ok(`remote « origin » configuré sur ${url}`);
  }
  let pushed = false;
  if (!push) {
    reporter.warn(`branche ${head} non poussée (--no-push).`);
  } else if (dryRun) {
    reporter.todo(`${head} serait poussée sur origin`);
  } else if (!created && branchOnRemote(root, head)) {
    // Already there. Not force-pushed, not fast-forwarded, not touched: what
    // the remote branch contains is the shop's history and this command has no
    // business rewriting it.
    reporter.ok(`${head} est déjà sur origin`);
  } else {
    pushBranch(root, head);
    pushed = true;
    reporter.ok(`${head} poussée sur origin`);
  }

  // ── 3. the environments ───────────────────────────────────────────────────
  reporter.section('Environnements');
  // A repository that does not exist yet has no environments to list, and
  // asking would be one failed call per run of `--dry-run` on a new shop.
  const existingEnvironments = existing || created ? environments(target.nameWithOwner, { cwd: root }) : [];
  const reviewerIds = [];
  if (reviewers.length > 0 && !dryRun) {
    for (const login of reviewers) {
      const id = userId(login, { cwd: root });
      if (id) reviewerIds.push({ type: 'User', id });
      else reporter.warn(`relecteur « ${login} » introuvable sur GitHub.`, 'Vérifiez l\'identifiant ; il est ignoré pour cette exécution.');
    }
  }

  /** @type {Array<{ env: string, action: string, protected: boolean, refusal: string|null }>} */
  const environmentReport = [];
  for (const name of ENVIRONMENTS) {
    // Reviewers on production only. A staging deployment that needed a
    // signature would be batched, and a staging environment deployed in
    // batches stops resembling production (ADR 0013).
    const wanted = name === 'production' ? reviewerIds : [];
    if (dryRun) {
      environmentReport.push({ env: name, action: existingEnvironments.includes(name) ? 'keep' : 'create', protected: false, refusal: null });
      reporter.todo(`${name} — ${existingEnvironments.includes(name) ? 'déjà présent' : 'serait créé'}`);
      continue;
    }
    const outcome = putEnvironment(target.nameWithOwner, name, { cwd: root, reviewers: wanted });
    environmentReport.push({
      env: name,
      action: existingEnvironments.includes(name) ? 'keep' : 'create',
      protected: outcome.protected,
      refusal: outcome.refusal ?? null,
    });
    reporter.ok(`${name} — ${existingEnvironments.includes(name) ? 'déjà présent' : 'créé'}${outcome.protected ? `, ${wanted.length} relecteur(s) obligatoire(s)` : ''}`);
    if (outcome.refusal) {
      reporter.warn(
        `${name} : GitHub a refusé les relecteurs obligatoires.`,
        'Sur un dépôt privé, les relecteurs obligatoires demandent GitHub Enterprise ; Pro et Team ne les offrent que sur un dépôt public. L\'environnement existe et porte ses secrets ; l\'approbation, elle, n\'est pas opposable tant que le plan ne la permet pas. `shopctl deploy --env production` exige toujours --yes.',
      );
    } else if (name === 'production' && wanted.length === 0 && !dryRun) {
      reporter.warn(
        'production n\'a aucun relecteur obligatoire.',
        'Passez --reviewer <login> pour que le déploiement attende une approbation humaine (plan §7.4).',
      );
    }
  }

  // The nightly backup of production. Created even without its token, so
  // that the environment a workflow names always exists WITH its branch
  // policy: GitHub creates a missing environment on first use, open to every
  // branch, and secrets added to it later would be readable from any of them.
  const backupBranch = existing?.defaultBranchRef?.name ?? head;
  const backupAction = existingEnvironments.includes(BACKUP_ENVIRONMENT) ? 'keep' : 'create';
  if (dryRun) {
    reporter.todo(`${BACKUP_ENVIRONMENT} — ${backupAction === 'keep' ? 'déjà présent' : 'serait créé'}, limité à la branche ${backupBranch}`);
  } else {
    putEnvironment(target.nameWithOwner, BACKUP_ENVIRONMENT, { cwd: root, branchPolicy: true });
    restrictEnvironment(target.nameWithOwner, BACKUP_ENVIRONMENT, [backupBranch], { cwd: root });
    reporter.ok(
      `${BACKUP_ENVIRONMENT} — ${backupAction === 'keep' ? 'déjà présent' : 'créé'}, limité à la branche ${backupBranch}, sans relecteur (sauvegarde nocturne de la production)`,
    );
  }
  environmentReport.push({ env: BACKUP_ENVIRONMENT, action: backupAction, protected: false, refusal: null, branches: [backupBranch] });

  // ── 4. the secrets ────────────────────────────────────────────────────────
  reporter.section('Secrets d\'environnement');
  // One account per environment, because ADR 0015 puts them on two: the
  // Deploy workflow reads CLOUDFLARE_ACCOUNT_ID from the environment it runs
  // in, and a production pointed at the agency's account would be refused by
  // every command it runs — or, worse, accepted by an agency token.
  const accounts = Object.fromEntries(
    ENVIRONMENTS.map((name) => [name, environmentAccount(manifest, name).id ?? env.CLOUDFLARE_ACCOUNT_ID ?? null]),
  );
  const unknown = ENVIRONMENTS.filter((name) => !accounts[name]);
  if (unknown.length > 0) {
    throw preconditionError(
      `aucun identifiant de compte Cloudflare à poser dans ${unknown.length === ENVIRONMENTS.length ? 'les environnements' : unknown.join(', ')}.`,
      'Ajoutez cloudflare.accountId au manifeste de la boutique (et cloudflare.productionAccountId si la production vit sur le compte du client, ADR 0015), ou exportez CLOUDFLARE_ACCOUNT_ID. Sans lui, le workflow Deploy ne saurait pas quel compte viser.',
    );
  }

  // The operator's own key, so that what the CI seals the operator can open:
  // `backup pull` then `restore` on a laptop is the way back from a bad night.
  // Its absence is said, not fatal — the repository is still worth creating.
  let backupKey = null;
  try {
    backupKey = loadKey({ root, env });
  } catch (error) {
    if (!(error instanceof ShopctlError)) throw error;
    reporter.warn(
      `aucune clé de sauvegarde à poser (${KEY_ENV}).`,
      'Créez-la avec `shopctl backup keygen` puis relancez `shopctl repo` : sans elle, le déploiement de production et le run nocturne refusent de démarrer.',
    );
  }

  // The backup environment reads production, on production's account.
  accounts[BACKUP_ENVIRONMENT] = accounts.production;

  const secretReport = [];
  const missingTokens = [];
  for (const name of [...ENVIRONMENTS, BACKUP_ENVIRONMENT]) {
    const token = name === BACKUP_ENVIRONMENT ? backupToken : tokenFor(name, env);
    if (!token && name === BACKUP_ENVIRONMENT) {
      // Not a warning: before the launch there is no production to back up.
      reporter.todo(
        `${BACKUP_ENVIRONMENT} : aucun jeton (CLOUDFLARE_API_TOKEN_BACKUP) — la production ne sera pas sauvegardée chaque nuit.`,
        'À poser avant la mise en ligne : un jeton du compte de production, D1 en lecture, Workers R2 Storage en écriture, Account Settings, Memberships et User Details en lecture. Relancez alors `shopctl repo`.',
      );
      continue;
    }
    if (!token) {
      missingTokens.push(name);
      reporter.warn(
        `${name} : aucun jeton Cloudflare dans l'environnement.`,
        `Exportez CLOUDFLARE_API_TOKEN_${name.toUpperCase()} (ou CLOUDFLARE_API_TOKEN pour les deux) et relancez : la commande est rejouable, elle ne recréera rien.`,
      );
      continue;
    }
    const present = dryRun ? [] : environmentSecrets(target.nameWithOwner, name, { cwd: root });
    if (dryRun) {
      reporter.todo(`${name} — CLOUDFLARE_API_TOKEN (${token.from}) et CLOUDFLARE_ACCOUNT_ID (${accounts[name]}) seraient posés`);
      secretReport.push({ env: name, set: [], from: token.from });
      continue;
    }
    // Overwritten rather than skipped when present, and that is the opposite of
    // the Cloudflare rule for a reason: GitHub never returns a secret's value,
    // so "already there" cannot be read as "already correct" — it could be last
    // month's rotated token. Nothing downstream is encrypted with it, so
    // rewriting costs nothing, where keeping a stale one costs a red pipeline
    // nobody can diagnose from the outside.
    setEnvironmentSecret(target.nameWithOwner, name, 'CLOUDFLARE_API_TOKEN', token.value, { cwd: root });
    setEnvironmentSecret(target.nameWithOwner, name, 'CLOUDFLARE_ACCOUNT_ID', accounts[name], { cwd: root });
    const set = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
    reporter.ok(
      `${name} — CLOUDFLARE_API_TOKEN (depuis ${token.from}) et CLOUDFLARE_ACCOUNT_ID (${accounts[name]}) posés${present.length > 0 ? ' (remplacés)' : ''}`,
    );

    // The one secret KEPT when present, and for the reason the tokens are not:
    // archives are encrypted with it. A second operator whose laptop holds a
    // different key would otherwise switch the CI to a key the first one cannot
    // open, with nothing anywhere saying so. Replacing it is a deliberate act —
    // delete it in GitHub, then re-run.
    if (backupKey && present.includes(KEY_ENV)) {
      reporter.ok(`${name} — ${KEY_ENV} déjà posé, conservé (clé locale ${keyId(backupKey.key)} ; GitHub ne relit pas une valeur)`);
    } else if (backupKey) {
      setEnvironmentSecret(target.nameWithOwner, name, KEY_ENV, backupKey.key.toString('base64'), { cwd: root });
      set.push(KEY_ENV);
      reporter.ok(`${name} — ${KEY_ENV} posé (clé ${keyId(backupKey.key)}, depuis ${backupKey.source})`);
    }
    secretReport.push({ env: name, set, from: token.from, replaced: present.filter((secret) => set.includes(secret)) });
  }

  const report = {
    command: 'repo',
    ok: true,
    dryRun,
    shop: manifest.client.slug,
    repository: { ...target, url, created, derived, visibility },
    branch: { name: head, pushed },
    environments: environmentReport,
    secrets: secretReport,
    missingTokens,
  };
  if (emit) reporter.result(report);

  if (!json) {
    reporter.section(
      missingTokens.length > 0
        ? `Dépôt prêt. ${missingTokens.length} environnement(s) sans jeton : relancez \`shopctl repo\` une fois les variables posées.`
        : `Dépôt prêt : https://github.com/${target.nameWithOwner}`,
    );
  }
  return report;
}
