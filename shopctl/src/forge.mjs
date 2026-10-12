/**
 * Everything the CLI asks GitHub, in one place — through `gh`.
 *
 * The same rule as Cloudflare: wrap the official tool, never reimplement it
 * (plan §5.1, ADR 0009). Here the rule is not a preference, it is forced, and
 * the forcing thing is worth writing down because it is not obvious.
 *
 * A GitHub environment secret is not sent in the clear. The caller fetches the
 * repository's public key and encrypts the value as a libsodium SEALED BOX:
 * ephemeral X25519 key exchange, Blake2b nonce derivation, XSalsa20-Poly1305
 * authenticated encryption. Node 22 ships X25519 and `blake2b512`, and does NOT
 * ship XSalsa20-Poly1305 — checked, not assumed. So a zero-dependency shopctl
 * cannot encrypt a secret for GitHub at all: it would take libsodium as a
 * dependency, which `shopctl new` cannot have (it runs before any node_modules
 * exists anywhere), or a hand-rolled Salsa20 in this repository, which is the
 * worst of the three options. `gh secret set` already does it correctly.
 *
 * READ BEFORE WRITE, as everywhere else in this CLI. Every function below that
 * creates something has a sibling that asks whether it already exists, so
 * `shopctl repo` can be run twice, or resumed after a failure, without a mode
 * of its own.
 *
 * Nothing here puts a secret in an argument vector. `setEnvironmentSecret`
 * passes the value on stdin, for the same reason `wrangler secret put` does:
 * an argument is in the process table and in the CI log before the process has
 * read it.
 */
import { capture, isAvailable } from './process.mjs';
import { externalError, inputError, preconditionError } from './errors.mjs';

/** Run one `gh` command. */
export function gh(args, { cwd, input, allowFailure = false, env = process.env } = {}) {
  return capture('gh', args, { cwd, input, allowFailure, env });
}

/**
 * Is `gh` installed and authenticated?
 *
 * Two separate answers, because they have two different remedies and an
 * operator who is told "GitHub is not available" has to guess which one.
 */
export function assertForgeReady({ cwd } = {}) {
  if (!isAvailable('gh', ['--version'])) {
    throw preconditionError(
      'gh (GitHub CLI) est requis et absent du PATH.',
      'Installez-le — https://cli.github.com — puis `gh auth login`. shopctl l\'enveloppe plutôt que de parler à l\'API : un secret d\'environnement GitHub doit être chiffré en sealed box libsodium, que Node ne sait pas produire sans dépendance.',
    );
  }
  const status = gh(['auth', 'status'], { cwd, allowFailure: true });
  if (status.status !== 0) {
    throw preconditionError(
      'gh n\'est pas authentifié auprès de GitHub.',
      'gh auth login — ou, en CI, posez GH_TOKEN. Le jeton doit porter le scope `repo` ; la création d\'environnements et de secrets en dépend.',
    );
  }
  return { ok: true };
}

/**
 * `owner/repo` out of a git remote URL.
 *
 * Both shapes an operator actually types — `git@github.com:owner/repo.git` and
 * `https://github.com/owner/repo` — and nothing else. A URL pointing at another
 * forge is refused by name rather than mangled into something plausible: the
 * repository this would then create would be on the wrong host, and it would be
 * created before anyone noticed.
 */
export function parseGithubRemote(url) {
  const text = String(url ?? '').trim();
  const ssh = text.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  const https = text.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  const match = ssh ?? https;
  if (!match) {
    throw inputError(
      `« ${text || '(vide)'} » n'est pas une URL de dépôt GitHub.`,
      'Attendu : git@github.com:proprietaire/depot.git ou https://github.com/proprietaire/depot. Les autres forges ne sont pas gérées ; shopctl ne créera pas un dépôt ailleurs que là où vous croyez.',
    );
  }
  const [, owner, repo] = match;
  return { owner, repo, nameWithOwner: `${owner}/${repo}` };
}

/**
 * The `origin` a shop tree already has, or null.
 *
 * `git config --get`, not `git remote get-url`: the latter applies the local
 * `url.<base>.insteadOf` rewrites, which are common in corporate setups and in
 * any tree that mirrors GitHub through a proxy. What identifies the repository
 * on GitHub is the CONFIGURED url; reading the rewritten one would have shopctl
 * create a repository named after whatever the rewrite points at.
 */
export function originUrl(cwd) {
  const result = capture('git', ['config', '--get', 'remote.origin.url'], { cwd, allowFailure: true });
  const url = result.status === 0 ? result.stdout.trim() : '';
  return url || null;
}

/**
 * The account a repository is created under when nothing names one.
 *
 * The authenticated user, from `gh` itself. An agency working under an
 * organisation passes `--owner`; the default is right for the common case and
 * is REPORTED before anything is created, because "which account did that land
 * in" is not a question anyone should have to answer by looking.
 */
export function defaultOwner({ cwd } = {}) {
  const result = gh(['api', 'user', '--jq', '.login'], { cwd, allowFailure: true });
  const login = result.status === 0 ? result.stdout.trim() : '';
  if (!login) {
    throw preconditionError(
      'gh ne dit pas sous quel compte il est authentifié.',
      'Passez --owner <compte-ou-organisation>, ou vérifiez `gh auth status`.',
    );
  }
  return login;
}

/**
 * Which URL scheme to write into the remote.
 *
 * `gh`'s own configured protocol, not a preference of this CLI: an operator
 * authenticated over HTTPS and handed an `git@github.com:` remote discovers it
 * at the first push, which is after the repository has been created. HTTPS is
 * the fallback because it is `gh`'s own default and works with the credential
 * helper `gh auth login` installs.
 *
 * Asked for github.com, not globally: `gh auth login` records the protocol it
 * chose under the host, and the global key keeps its `https` default. `gh`
 * falls back to the global value itself when the host has none.
 */
export function gitProtocol({ cwd } = {}) {
  const result = gh(['config', 'get', 'git_protocol', '--host', 'github.com'], { cwd, allowFailure: true });
  return (result.status === 0 ? result.stdout.trim() : '') === 'ssh' ? 'ssh' : 'https';
}

/** The remote URL for one repository, in the scheme `gh` is configured for. */
export function repositoryUrl(owner, repo, protocol = 'https') {
  return protocol === 'ssh' ? `git@github.com:${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
}

/** The repository name a slug implies. Derived, never asked for: `shop-<slug>`
 *  next to `minshop-<slug>` on Cloudflare is one shop, two services, one name
 *  to grep for. */
export const repositoryNameFor = (slug) => `shop-${slug}`;

/** What GitHub knows about this repository, or null when it does not exist. */
export function repository(nameWithOwner, { cwd } = {}) {
  const result = gh(['repo', 'view', nameWithOwner, '--json', 'nameWithOwner,visibility,defaultBranchRef,isEmpty'], {
    cwd,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.slice(result.stdout.search(/[[{]/)));
  } catch {
    return null;
  }
}

/**
 * Create the repository, empty.
 *
 * PRIVATE unless asked otherwise, and that default is the whole point: the
 * repository holds a customer's shop — its manifest, its catalogue, its
 * content. A public default would make the mistake silent and permanent, since
 * a repository that was public for an hour has been cloned by whoever was
 * watching the firehose.
 *
 * `--disable-issues` and `--disable-wiki` are not tidiness either: a shop
 * repository is an operational artefact, and an issue tracker nobody reads is
 * where a customer's bug report goes to be lost.
 */
export function createRepository(nameWithOwner, { cwd, visibility = 'private', description = null } = {}) {
  gh(
    [
      'repo',
      'create',
      nameWithOwner,
      `--${visibility}`,
      '--disable-issues',
      '--disable-wiki',
      ...(description ? ['--description', description] : []),
    ],
    { cwd },
  );
  return { nameWithOwner, visibility };
}

/** Environments the repository already has, by name. */
export function environments(nameWithOwner, { cwd } = {}) {
  const result = gh(['api', `repos/${nameWithOwner}/environments`], { cwd, allowFailure: true });
  if (result.status !== 0) return [];
  try {
    const document = JSON.parse(result.stdout.slice(result.stdout.search(/[[{]/)));
    return (document.environments ?? []).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Create or update one environment.
 *
 * `reviewers` is attempted, never assumed. On a private repository, required
 * reviewers exist only under GitHub Enterprise: under Pro or Team the API
 * refuses the reviewers and accepts the environment. (Under Free a private
 * repository has no environment secrets at all, which is why a shop's GitHub
 * account needs Pro at least — docs/certification/comptes-et-acces.md.) Both
 * outcomes are returned rather than one of them being an error: the
 * environment is what scopes the secrets and it is worth having either way; the
 * reviewers are what make the approval enforceable and the operator has to be
 * told, in those words, when they did not take.
 *
 * @param {Array<{ type: 'User'|'Team', id: number }>} reviewers
 */
export function putEnvironment(nameWithOwner, name, { cwd, reviewers = [] } = {}) {
  const body = reviewers.length > 0 ? { reviewers } : {};
  const result = gh(
    ['api', '--method', 'PUT', `repos/${nameWithOwner}/environments/${name}`, '--input', '-'],
    { cwd, input: JSON.stringify(body), allowFailure: reviewers.length > 0 },
  );

  if (result.status === 0) return { name, reviewers: reviewers.length, protected: reviewers.length > 0 };

  // The reviewers were refused. Fall back to the bare environment, which is
  // what carries the secrets, and say so — never silently.
  gh(['api', '--method', 'PUT', `repos/${nameWithOwner}/environments/${name}`, '--input', '-'], {
    cwd,
    input: JSON.stringify({}),
  });
  return {
    name,
    reviewers: 0,
    protected: false,
    refusal: firstLine(result.stderr) ?? 'GitHub a refusé les relecteurs obligatoires.',
  };
}

/** Secrets an environment already holds, by name. Never their values —
 *  GitHub does not return them, which is why an existing secret is overwritten
 *  rather than compared. */
export function environmentSecrets(nameWithOwner, name, { cwd } = {}) {
  const asJson = gh(['secret', 'list', '--env', name, '--repo', nameWithOwner, '--json', 'name'], {
    cwd,
    allowFailure: true,
  });
  if (asJson.status === 0) {
    try {
      const document = JSON.parse(asJson.stdout.slice(asJson.stdout.search(/[[{]/)));
      return (Array.isArray(document) ? document : []).map((entry) => entry.name).filter(Boolean);
    } catch {
      // Fall through to the tabular reading below.
    }
  }
  // Older `gh` has no --json on this command. Its plain output is one secret
  // per line, name first; reading the first column is what survives both.
  const plain = gh(['secret', 'list', '--env', name, '--repo', nameWithOwner], { cwd, allowFailure: true });
  if (plain.status !== 0) return [];
  return plain.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((entry) => /^[A-Z][A-Z0-9_]*$/.test(entry));
}

/**
 * Set one environment secret, over standard input.
 *
 * The value never becomes an argument. `gh` reads it from stdin when `--body`
 * is absent, which is the shape that keeps it out of the process table and out
 * of the CI log of whatever ran the command.
 */
export function setEnvironmentSecret(nameWithOwner, environment, name, value, { cwd } = {}) {
  gh(['secret', 'set', name, '--env', environment, '--repo', nameWithOwner], { cwd, input: `${value}` });
  return { name, environment };
}

/** The numeric id of a GitHub login, for the reviewers list. */
export function userId(login, { cwd } = {}) {
  const result = gh(['api', `users/${login}`, '--jq', '.id'], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  const id = Number(result.stdout.trim());
  return Number.isInteger(id) ? id : null;
}

/** Push the shop's branch to `origin`, once there is somewhere to push it. */
export function pushBranch(cwd, branch) {
  capture('git', ['push', '-u', 'origin', branch], { cwd });
  return { branch };
}

/** Has this branch already been pushed? Asked of the REMOTE, not of the local
 *  tracking ref, which a fresh clone can carry while the remote is empty. */
export function branchOnRemote(cwd, branch) {
  const result = capture('git', ['ls-remote', '--heads', 'origin', branch], { cwd, allowFailure: true });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function firstLine(text) {
  return (
    String(text)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/**
 * The pull request an upgrade opens, or null when there is none.
 *
 * Asked before one is created, like everything else here: a fleet upgrade that
 * is re-run — after a network failure, after a conflict was resolved by hand —
 * must report the pull request it already opened rather than fail on GitHub's
 * "a pull request already exists" or, worse, open a second one against the same
 * branch.
 */
export function pullRequestFor(cwd, branch) {
  const result = gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state', '--limit', '1'], {
    cwd,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  try {
    const document = JSON.parse(result.stdout.slice(result.stdout.search(/[[{]/)));
    const [first] = Array.isArray(document) ? document : [];
    return first ? { number: first.number, url: first.url, state: first.state } : null;
  } catch {
    return null;
  }
}

/**
 * Open the pull request that carries a core upgrade.
 *
 * NEVER merged, never auto-merged, and that is the exit criterion of jalon 9 in
 * one line: a core version can be proposed to a shop without a manual copy of
 * files and without an unapproved deployment. The pull request is where a human
 * reads the merge, the CI result and the migration notes before anything is
 * deployed; a `--merge` here would delete the only step that makes a fleet
 * upgrade safe.
 *
 * The body goes on STDIN. A migration note is prose, with quotes and newlines
 * in it, and an argument vector is the wrong place for either.
 */
export function openPullRequest(cwd, { branch, base, title, body }) {
  const existing = pullRequestFor(cwd, branch);
  if (existing) return { ...existing, created: false };
  const result = gh(
    ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body-file', '-'],
    { cwd, input: body, allowFailure: true },
  );
  if (result.status !== 0) {
    throw externalError(
      `GitHub a refusé d'ouvrir la pull request de ${branch}.`,
      firstLine(result.stderr) ?? firstLine(result.stdout) ?? null,
    );
  }
  const url = firstLine(result.stdout.split('\n').filter((line) => line.includes('http')).join('\n'));
  return { number: null, url, state: 'OPEN', created: true };
}
