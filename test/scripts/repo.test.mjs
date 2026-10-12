import { describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { parseGithubRemote, repositoryNameFor, repositoryUrl } from '../../shopctl/src/forge.mjs';
import { setupRepository, tokenFor } from '../../shopctl/src/commands/repo.mjs';
import { Reporter } from '../../shopctl/src/report.mjs';
import { shop } from '../helpers/provisioned-shop.mjs';

vi.setConfig({ testTimeout: 60_000 });

const TOKENS = { CLOUDFLARE_API_TOKEN: 'cf-token-shared' };

function forgeShop(options = {}) {
  return shop({ forge: true, ...options });
}

/**
 * A PATH with node on it and nothing else.
 *
 * Built rather than emptied: the runner spawns `node`, so a PATH of
 * `/nonexistent` fails to start the process at all and the test would pass on
 * the wrong reason. What has to be absent is `gh`, and only `gh`.
 */
function pathWithoutGh() {
  const dir = mkdtempSync(join(tmpdir(), 'shopctl-nogh-'));
  symlinkSync(process.execPath, join(dir, 'node'));
  return dir;
}

// ---------------------------------------------------------------------------

describe('a GitHub remote', () => {
  it('reads both shapes an operator actually types', () => {
    expect(parseGithubRemote('git@github.com:agence/shop-x.git')).toEqual({
      owner: 'agence',
      repo: 'shop-x',
      nameWithOwner: 'agence/shop-x',
    });
    expect(parseGithubRemote('https://github.com/agence/shop-x')).toMatchObject({ nameWithOwner: 'agence/shop-x' });
  });

  // Refused by name rather than mangled into something plausible: the
  // repository this would then create would be on the wrong host, and it would
  // be created before anyone noticed.
  it('refuses a remote that is not GitHub', () => {
    expect(() => parseGithubRemote('git@gitlab.com:agence/shop-x.git')).toThrow(/pas une URL de dépôt GitHub/);
    expect(() => parseGithubRemote('')).toThrow(/pas une URL/);
  });
});

describe('the repository a slug implies', () => {
  // `shop-<slug>` next to `minshop-<slug>` on Cloudflare: one shop, two
  // services, one name to grep for.
  it('is shop-<slug>, in the scheme gh is configured for', () => {
    expect(repositoryNameFor('maestro-demo')).toBe('shop-maestro-demo');
    expect(repositoryUrl('agence', 'shop-x', 'ssh')).toBe('git@github.com:agence/shop-x.git');
    expect(repositoryUrl('agence', 'shop-x', 'https')).toBe('https://github.com/agence/shop-x.git');
    // HTTPS is the fallback because it is gh's own default and works with the
    // credential helper `gh auth login` installs.
    expect(repositoryUrl('agence', 'shop-x')).toMatch(/^https:/);
  });

  it('round-trips through the parser', () => {
    for (const protocol of ['ssh', 'https']) {
      expect(parseGithubRemote(repositoryUrl('agence', 'shop-x', protocol)).nameWithOwner).toBe('agence/shop-x');
    }
  });
});

describe('which token an environment gets', () => {
  it('prefers the environment-specific variable', () => {
    const source = { CLOUDFLARE_API_TOKEN: 'shared', CLOUDFLARE_API_TOKEN_PRODUCTION: 'prod' };
    expect(tokenFor('production', source)).toEqual({ value: 'prod', from: 'CLOUDFLARE_API_TOKEN_PRODUCTION' });
    expect(tokenFor('staging', source)).toEqual({ value: 'shared', from: 'CLOUDFLARE_API_TOKEN' });
  });

  // Accepted rather than refused: an agency starting out has one token, and
  // demanding two before anything can be set up is the rule that teaches people
  // to put the production token in both.
  it('falls back to the shared one, and says which it used', () => {
    expect(tokenFor('production', { CLOUDFLARE_API_TOKEN: 'shared' }).from).toBe('CLOUDFLARE_API_TOKEN');
    expect(tokenFor('production', {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('shopctl repo', () => {
  it('refuses a machine without gh', () => {
    // No forge fixture: `gh` is not on PATH, which is the state of a machine
    // that has never installed it.
    const target = shop();
    const result = target.run(['repo'], { PATH: pathWithoutGh() });
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/gh \(GitHub CLI\) est requis/);
  });

  it('refuses an unauthenticated gh before touching anything', () => {
    const target = forgeShop();
    target.github({ authenticated: false });
    const result = target.run(['repo'], TOKENS);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/n'est pas authentifié/);
    expect(Object.keys(target.github().repos)).toEqual([]);
  });

  describe('a first run', () => {
    it('creates the repository private, pushes, and sets up both environments', () => {
      const target = forgeShop();
      const { report, status } = target.json(['repo'], TOKENS);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.repository).toMatchObject({ nameWithOwner: target.nameWithOwner, created: true, visibility: 'private' });
      expect(report.branch).toEqual({ name: 'main', pushed: true });

      const github = target.github();
      expect(github.repos[target.nameWithOwner].visibility).toBe('private');
      expect(Object.keys(github.repos[target.nameWithOwner].environments)).toEqual(['staging', 'production']);
    });

    // The default that matters most. A repository that was public for an hour
    // has been cloned by whoever was watching the firehose.
    it('never creates a public repository unless asked', () => {
      const target = forgeShop();
      target.run(['repo'], TOKENS);
      const created = target.github().calls.find(({ argv }) => argv[0] === 'repo' && argv[1] === 'create');
      expect(created.argv).toContain('--private');
      expect(created.argv).not.toContain('--public');
    });

    it('places both Cloudflare secrets in each environment', () => {
      const target = forgeShop();
      const { report } = target.json(['repo'], TOKENS);
      const secrets = target.github().repos[target.nameWithOwner].environments;
      for (const env of ['staging', 'production']) {
        expect(Object.keys(secrets[env].secrets).sort()).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
        expect(secrets[env].secrets.CLOUDFLARE_API_TOKEN).toBe('cf-token-shared');
      }
      expect(report.secrets.map((entry) => entry.from)).toEqual(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN']);
    });

    it('scopes a per-environment token to its environment', () => {
      const target = forgeShop();
      target.run(['repo'], { CLOUDFLARE_API_TOKEN_STAGING: 'cf-staging', CLOUDFLARE_API_TOKEN_PRODUCTION: 'cf-production' });
      const environments = target.github().repos[target.nameWithOwner].environments;
      expect(environments.staging.secrets.CLOUDFLARE_API_TOKEN).toBe('cf-staging');
      expect(environments.production.secrets.CLOUDFLARE_API_TOKEN).toBe('cf-production');
    });

    // The rule this CLI has held since jalon 2, applied to the one command
    // whose whole job is to place secrets.
    it('never lets a token reach an argument vector or the terminal', () => {
      const target = forgeShop();
      const result = target.run(['repo'], TOKENS);
      const sets = target.github().calls.filter(({ argv }) => argv[0] === 'secret' && argv[1] === 'set');
      expect(sets).toHaveLength(4);
      for (const call of sets) expect(call.argv.join(' ')).not.toContain('cf-token-shared');
      expect(`${result.stdout}${result.stderr}`).not.toContain('cf-token-shared');
    });

    // The CI seals with the operator's key, so that the operator can open what
    // the CI took. Placed when absent and KEPT when present: archives are
    // encrypted with it, and a second laptop with another key must not switch
    // the CI over silently.
    it('places the operator\u2019s backup key once, and keeps it after that', () => {
      const target = forgeShop();
      expect(target.run(['backup', 'keygen']).status).toBe(EXIT_CODES.ok);
      const key = readFileSync(join(target.root, '.shopctl/backup.key'), 'utf8').trim();

      const first = target.json(['repo'], TOKENS);
      const environments = () => target.github().repos[target.nameWithOwner].environments;
      for (const env of ['staging', 'production']) expect(environments()[env].secrets.SHOPCTL_BACKUP_KEY).toBe(key);
      expect(first.report.secrets[0].set).toContain('SHOPCTL_BACKUP_KEY');
      expect(`${first.stdout}${first.stderr}`).not.toContain(key);
      const sets = target.github().calls.filter(({ argv }) => argv[0] === 'secret' && argv[1] === 'set');
      for (const call of sets) expect(call.argv.join(' ')).not.toContain(key);

      rmSync(join(target.root, '.shopctl/backup.key'));
      target.run(['backup', 'keygen']);
      const second = target.json(['repo'], TOKENS);
      expect(second.report.secrets[0].set).not.toContain('SHOPCTL_BACKUP_KEY');
      expect(environments().production.secrets.SHOPCTL_BACKUP_KEY).toBe(key);
    });

    it('says so when there is no backup key to place', () => {
      const target = forgeShop();
      const result = target.run(['repo'], TOKENS);
      expect(result.status).toBe(EXIT_CODES.ok);
      expect(result.stdout).toMatch(/aucune clé de sauvegarde à poser/);
    });

    it('takes the account id from the manifest', () => {
      const target = forgeShop();
      target.run(['repo'], TOKENS);
      const environments = target.github().repos[target.nameWithOwner].environments;
      expect(environments.staging.secrets.CLOUDFLARE_ACCOUNT_ID).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    });

    // ADR 0015: the Deploy workflow reads CLOUDFLARE_ACCOUNT_ID from the
    // environment it runs in, so a production on the client's account needs
    // that account in `production` — and the agency's still in `staging`.
    it('gives each environment the account the manifest names for it', () => {
      const target = forgeShop({ cloudflare: { productionAccountId: '0123456789abcdef0123456789abcdef' } });
      const result = target.run(['repo'], TOKENS);
      expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
      const environments = target.github().repos[target.nameWithOwner].environments;
      expect(environments.staging.secrets.CLOUDFLARE_ACCOUNT_ID).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
      expect(environments.production.secrets.CLOUDFLARE_ACCOUNT_ID).toBe('0123456789abcdef0123456789abcdef');
    });

    it('refuses to run when no account id can be found', () => {
      const target = forgeShop({ accountId: null });
      const result = target.run(['repo'], TOKENS);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/aucun identifiant de compte Cloudflare/);
    });
  });

  describe('when nothing names a repository', () => {
    // The convention is only reached when neither --origin nor an existing
    // remote says anything, and it is announced: a repository created somewhere
    // the operator did not name is exactly what is found a week later.
    it('derives <owner>/shop-<slug> from the authenticated account', () => {
      const target = forgeShop();
      // A tree with no remote at all, which is what `shopctl new` without
      // --origin leaves behind.
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: target.root });
      target.github({ login: 'studiomaestro' });

      const { report, status } = target.json(['repo', '--no-push'], TOKENS);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.repository).toMatchObject({ nameWithOwner: `studiomaestro/shop-${target.slug}`, derived: true });
      expect(Object.keys(target.github().repos)).toEqual([`studiomaestro/shop-${target.slug}`]);
    });

    it('takes --owner over the authenticated account', () => {
      const target = forgeShop();
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: target.root });
      target.github({ login: 'une-personne' });

      const { report } = target.json(['repo', '--owner', 'studiomaestro', '--no-push'], TOKENS);
      expect(report.repository.nameWithOwner).toBe(`studiomaestro/shop-${target.slug}`);
    });

    // Written into the tree, or `git push -u origin` has nowhere to go and
    // every later `git pull` in that clone fails for an unrelated-looking
    // reason.
    it('configures the derived URL as the tree’s origin', () => {
      const target = forgeShop();
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: target.root });
      target.github({ login: 'studiomaestro', config: { git_protocol: 'ssh' } });

      target.run(['repo', '--no-push'], TOKENS);
      const configured = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: target.root, encoding: 'utf8' });
      expect(configured.stdout.trim()).toBe(`git@github.com:studiomaestro/shop-${target.slug}.git`);
    });

    // Where `gh auth login` writes the choice: under the host, the global key
    // left at its `https` default. Read globally, the remote came out HTTPS on
    // an SSH-only machine and the first push asked for a password (étape 2 de
    // la certification, 2026-10-11).
    it('reads the protocol gh recorded for github.com over the global default', () => {
      const target = forgeShop();
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: target.root });
      target.github({
        login: 'studiomaestro',
        config: { git_protocol: 'https' },
        hosts: { 'github.com': { git_protocol: 'ssh' } },
      });

      target.run(['repo', '--no-push'], TOKENS);
      const configured = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: target.root, encoding: 'utf8' });
      expect(configured.stdout.trim()).toBe(`git@github.com:studiomaestro/shop-${target.slug}.git`);
    });

    // An existing remote always wins: the shop already says where it lives.
    it('never overrides a remote the tree already has', () => {
      const target = forgeShop();
      target.github({ login: 'quelquun-dautre' });
      const { report } = target.json(['repo', '--no-push'], TOKENS);
      expect(report.repository).toMatchObject({ nameWithOwner: target.nameWithOwner, derived: false });
    });
  });

  describe('a second run', () => {
    it('creates nothing and leaves the branch alone', () => {
      const target = forgeShop();
      expect(target.run(['repo'], TOKENS).status).toBe(EXIT_CODES.ok);

      const { report, status } = target.json(['repo'], TOKENS);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.repository.created).toBe(false);
      expect(report.branch.pushed).toBe(false);
      expect(report.environments.every((entry) => entry.action === 'keep')).toBe(true);
      expect(target.github().calls.filter(({ argv }) => argv[1] === 'create')).toHaveLength(1);
    });

    // The opposite of the Cloudflare rule, deliberately: GitHub never returns a
    // secret's value, so "already there" cannot be read as "already correct".
    it('rewrites the secrets rather than trusting the ones already there', () => {
      const target = forgeShop();
      target.run(['repo'], { CLOUDFLARE_API_TOKEN: 'old-token' });
      const { report } = target.json(['repo'], { CLOUDFLARE_API_TOKEN: 'rotated-token' });
      expect(report.secrets[0].replaced).toContain('CLOUDFLARE_API_TOKEN');
      expect(target.github().repos[target.nameWithOwner].environments.staging.secrets.CLOUDFLARE_API_TOKEN).toBe('rotated-token');
    });
  });

  describe('--dry-run', () => {
    it('asks GitHub and writes nothing', () => {
      const target = forgeShop();
      const { report, status } = target.json(['repo', '--dry-run'], TOKENS);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.dryRun).toBe(true);
      expect(target.github().repos).toEqual({});
      expect(target.github().calls.every(({ argv }) => !argv.includes('create') && !(argv[0] === 'secret' && argv[1] === 'set'))).toBe(true);
    });
  });

  describe('required reviewers', () => {
    it('sets them on production and never on staging', () => {
      const target = forgeShop();
      target.run(['repo', '--reviewer', 'damien'], TOKENS);
      const environments = target.github().repos[target.nameWithOwner].environments;
      expect(environments.production.reviewers).toBe(1);
      expect(environments.staging.reviewers).toBe(0);
    });

    // A private repository under GitHub Pro or Team: the environment is
    // accepted, the protection rule is not (required reviewers on a private
    // repository need Enterprise) — and the command must leave the environment
    // in place, because that is what scopes the secrets, while saying out loud
    // that the approval is not enforceable.
    it('keeps the environment when the plan refuses the protection rule, and says so', () => {
      const target = forgeShop();
      target.github({ refuseReviewers: true });
      const { report, status } = target.json(['repo', '--reviewer', 'damien'], TOKENS);

      expect(status).toBe(EXIT_CODES.ok);
      const production = report.environments.find((entry) => entry.env === 'production');
      expect(production.protected).toBe(false);
      expect(production.refusal).toMatch(/HTTP 422|Pro/);
      expect(Object.keys(target.github().repos[target.nameWithOwner].environments)).toContain('production');
      expect(target.github().repos[target.nameWithOwner].environments.production.secrets.CLOUDFLARE_API_TOKEN).toBe('cf-token-shared');
    });

    it('warns when production ends up with no reviewer at all', () => {
      const target = forgeShop();
      const result = target.run(['repo'], TOKENS);
      expect(result.stdout).toMatch(/production n'a aucun relecteur obligatoire/);
    });

    it('ignores a reviewer GitHub does not know, without failing the run', () => {
      const target = forgeShop();
      const result = target.run(['repo', '--reviewer', 'inconnu'], TOKENS);
      expect(result.status).toBe(EXIT_CODES.ok);
      expect(result.stdout).toMatch(/relecteur « inconnu » introuvable/);
    });
  });

  /**
   * `shopctl new --create-repo` runs this sequence inside its own command.
   *
   * Under `--json`, stdout carries exactly one document; a second one would
   * break every caller that pipes `shopctl new … --json` into a parser. So the
   * sequence RETURNS its report and emits it only when it is itself the
   * command — asserted here rather than left to a comment, because the failure
   * is invisible until someone parses the output.
   */
  it('returns its report without emitting one when it is not the command', () => {
    const target = forgeShop();
    const sink = { written: [], write(text) { this.written.push(text); } };
    const reporter = new Reporter({ json: true, stdout: sink, stderr: { write() {} } });

    // In-process, so the doubles have to be on THIS process's environment:
    // `capture()` spawns with process.env, which the spawned-runner tests
    // override per call.
    const previous = { PATH: process.env.PATH, GH_DOUBLE_STATE: process.env.GH_DOUBLE_STATE };
    process.env.PATH = `${target.binDir}:${previous.PATH}`;
    process.env.GH_DOUBLE_STATE = target.ghState;

    const report = setupRepository({
      shop: {
        root: target.root,
        manifest: JSON.parse(
          JSON.stringify({
            client: { slug: target.slug, displayName: 'Boutique de test' },
            cloudflare: { accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
          }),
        ),
        file: 'client/client.yaml',
      },
      reporter,
      emit: false,
      env: TOKENS,
    });

    process.env.PATH = previous.PATH;
    if (previous.GH_DOUBLE_STATE === undefined) delete process.env.GH_DOUBLE_STATE;
    else process.env.GH_DOUBLE_STATE = previous.GH_DOUBLE_STATE;

    expect(reporter.emitted).toBe(false);
    expect(sink.written).toEqual([]);
    expect(report).toMatchObject({ command: 'repo', repository: { created: true } });
  });

  // A missing token is a warning and a re-runnable state, not a failure: the
  // repository and the environments are worth having, and the command that
  // places the secrets is the same one you run again.
  it('reports an environment left without a token instead of failing', () => {
    const target = forgeShop();
    const { report, status } = target.json(['repo'], { CLOUDFLARE_API_TOKEN_STAGING: 'cf-staging' });
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.missingTokens).toEqual(['production']);
    expect(target.github().repos[target.nameWithOwner].environments.production.secrets).toEqual({});
  });
});
