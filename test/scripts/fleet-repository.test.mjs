import { describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { FLEET_MINIMUM_CORE, readRegistry } from '../../shopctl/src/fleet.mjs';
import { FLEET_FILES, fleetAccount, monitorTokenFor } from '../../shopctl/src/commands/fleet-repository.mjs';
import { GIT_ENV } from '../helpers/core-repository.mjs';
import { OPERATOR_ENV } from '../helpers/operator-env.mjs';
import { ACCOUNT, OTHER_ACCOUNT, shop } from '../helpers/provisioned-shop.mjs';

vi.setConfig({ testTimeout: 60_000 });

const CORE = new URL('../../', import.meta.url).pathname;
const BIN = resolve(CORE, 'shopctl/bin/shopctl.mjs');
const GH_DOUBLE = resolve(CORE, 'test/fixtures/gh-double.mjs');
const VERSION = JSON.parse(readFileSync(resolve(CORE, 'package.json'), 'utf8')).version;

const template = (name) => readFileSync(resolve(CORE, 'shopctl/templates/fleet', name), 'utf8');

/**
 * An agency's fleet repository: fleet.json, a git repository whose `origin`
 * is a genuine GitHub URL that git reaches as a local bare repository, and a
 * `gh` that answers from a file — the arrangement provisioned-shop.mjs builds
 * for one shop.
 */
function fleetWorkspace({ shops = [], git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shopctl-fleet-'));
  writeFileSync(join(root, 'fleet.json'), `${JSON.stringify({ schemaVersion: 1, shops }, null, 2)}\n`);
  const bin = join(root, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nimport('${GH_DOUBLE}');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const ghState = join(root, '.gh-state.json');
  writeFileSync(ghState, JSON.stringify({ authenticated: true, login: 'agence', repos: {}, users: { damien: 17449459 }, calls: [] }, null, 2));
  writeFileSync(join(root, '.gitignore'), '/.bin/\n/.gh-state.json\n');

  const nameWithOwner = 'agence/minshop-fleet';
  const originUrl = `git@github.com:${nameWithOwner}.git`;
  const sh = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  const run = (args, env = {}) => {
    const result = spawnSync('node', [BIN, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, ...OPERATOR_ENV, GH_DOUBLE_STATE: ghState, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    return result;
  };
  if (git) {
    const remote = mkdtempSync(join(tmpdir(), 'shopctl-fleet-remote-'));
    spawnSync('git', ['init', '--bare', '--quiet', remote]);
    sh(['init', '--quiet', '--initial-branch=main']);
    sh(['config', 'user.name', 'Minshop Tests']);
    sh(['config', 'user.email', 'tests@example.com']);
    sh(['config', `url.${remote}.insteadOf`, originUrl]);
    sh(['remote', 'add', 'origin', originUrl]);
  }
  return {
    root,
    nameWithOwner,
    run,
    json(args, env = {}) {
      const result = run([...args, '--json'], env);
      return { ...result, report: result.stdout.trim() ? JSON.parse(result.stdout) : null };
    },
    commit() {
      sh(['add', '-A']);
      sh(['commit', '--quiet', '-m', 'Flotte']);
    },
    github() {
      return JSON.parse(readFileSync(ghState, 'utf8'));
    },
    read(path) {
      return readFileSync(join(root, path), 'utf8');
    },
  };
}

// ---------------------------------------------------------------------------

describe('a registry entry\'s repository', () => {
  const registry = (shops) => {
    const root = mkdtempSync(join(tmpdir(), 'registry-'));
    const file = join(root, 'fleet.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, shops }));
    return file;
  };

  it('is optional, and read as given', () => {
    const fleet = readRegistry(registry([{ slug: 'a', path: 'x', repository: 'agence/shop-a' }, { slug: 'b', path: 'y' }]));
    expect(fleet.shops.map((shop) => shop.repository)).toEqual(['agence/shop-a', null]);
  });

  // It becomes a checkout target and a line of $GITHUB_OUTPUT.
  it('is owner/repo and nothing else', () => {
    expect(() => readRegistry(registry([{ slug: 'a', path: 'x', repository: 'https://github.com/agence/shop-a' }]))).toThrow(/propriétaire\/dépôt/);
    expect(() => readRegistry(registry([{ slug: 'a', path: 'x', repository: 'agence/shop-a\nrepository=autre/x' }]))).toThrow(/propriétaire\/dépôt/);
  });

  it('belongs to one shop', () => {
    expect(() => readRegistry(registry([{ slug: 'a', path: 'x', repository: 'agence/shop-a' }, { slug: 'b', path: 'y', repository: 'Agence/Shop-A' }]))).toThrow(/même dépôt/);
  });
});

// ---------------------------------------------------------------------------

describe('the fleet\'s workflows', () => {
  const deploy = template('deploy.yml');
  const nightly = template('nightly.yml');
  const runs = (text) => [...text.matchAll(/run: \|\n((?:\s{10}.*\n)+)/g)].map((match) => match[1]);

  // Each shop's own Deploy, from here: the same commands, with the shopctl of
  // the core the shop is on, and production behind the environment's reviewers.
  it('deploys with the shop\'s own shopctl, behind a GitHub Environment per target', () => {
    expect(deploy).toMatch(/workflow_dispatch:/);
    expect(deploy).not.toMatch(/\n {2}(push|schedule|pull_request):/);
    expect(deploy).toMatch(/environment:\n\s+name: \$\{\{ inputs\.environment \}\}/);
    expect(deploy).toMatch(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
    expect(deploy).toMatch(/node shopctl\/bin\/shopctl\.mjs provision --env "\$TARGET" --shop "\$SHOP"/);
    expect(deploy).toMatch(/args=\(deploy --env "\$TARGET" --shop "\$SHOP" --yes --json\)/);
    expect(deploy).not.toMatch(/wrangler (deploy|d1|r2|secret)/);
    expect(deploy).toMatch(/cancel-in-progress: false/);
  });

  // `--skip-verify` is only true of the tree the verify job checked out.
  it('deploys the commit it verified', () => {
    expect(deploy).toMatch(/sha: \$\{\{ steps\.sha\.outputs\.sha \}\}/);
    expect(deploy).toMatch(/ref: \$\{\{ needs\.verify\.outputs\.sha \|\| inputs\.ref \}\}/);
  });

  // A shop on a core without the owner marker would find another shop's
  // database by its name and never ask whose it is.
  it('refuses a shop below the core floor before installing anything', () => {
    for (const [text, job] of [[deploy, '  deploy:'], [nightly, '  production-backup:']]) {
      const body = text.slice(text.indexOf(job));
      expect(body.indexOf("Check the shop's core")).toBeGreaterThan(-1);
      expect(body.indexOf("Check the shop's core")).toBeLessThan(body.indexOf('npm ci'));
    }
  });

  it('backs every shop\'s production up twice a day, one at a time, from the backup environment', () => {
    const crons = [...nightly.matchAll(/^\s+- cron: '([^']+)'$/gm)].map((match) => match[1]);
    const shopNightly = readFileSync(resolve(CORE, '.github/workflows/nightly.yml'), 'utf8');
    expect(crons).toEqual([...shopNightly.matchAll(/^\s+- cron: '([^']+)'$/gm)].map((match) => match[1]));
    const backup = nightly.slice(nightly.indexOf('  production-backup:'), nightly.indexOf('  production-watch:'));
    expect(backup).toMatch(/environment: backup\n/);
    expect(backup).toMatch(/max-parallel: 1\n/);
    expect(backup).toMatch(/fail-fast: false\n/);
    expect(backup).toMatch(/shopctl\.mjs backup verify "\$ARCHIVE"/);
    expect(backup).not.toMatch(/shopctl\.mjs restore/);
    expect(backup).not.toMatch(/github\.event\.schedule/);
    const watch = nightly.slice(nightly.indexOf('  production-watch:'), nightly.indexOf('  account-usage:'));
    expect(watch).toMatch(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.MONITOR_CLOUDFLARE_API_TOKEN \}\}/);
    expect(watch).not.toMatch(/environment:/);
    expect(watch).toMatch(/PLAN: \$\{\{ vars\.MINSHOP_ACCOUNT_PLAN \|\| 'paid' \}\}/);
    expect(watch).toMatch(/--plan "\$PLAN"/);
    expect(watch).toMatch(/github\.event\.schedule != '17 15 \* \* \*'/);
  });

  // Lot 7 of plan §13.1: the account's month, once a night, with the read-only
  // token — never the backup environment's, never a matrix of shops. A budget
  // means nothing on the free plan, which has quotas instead of a bill.
  it('asks the shared account for its usage once a night, against its plan and budget', () => {
    const account = nightly.slice(nightly.indexOf('  account-usage:'));
    expect(account.length).toBeLessThan(nightly.length);
    expect(account).toMatch(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.MONITOR_CLOUDFLARE_API_TOKEN \}\}/);
    expect(account).toMatch(/BUDGET: \$\{\{ vars\.MINSHOP_MONTHLY_BUDGET \}\}/);
    expect(account).not.toMatch(/environment:|strategy:/);
    expect(account).toMatch(/github\.event\.schedule != '17 15 \* \* \*'/);
    expect(account).toMatch(/PLAN: \$\{\{ vars\.MINSHOP_ACCOUNT_PLAN \|\| 'paid' \}\}/);
    expect(account).toMatch(/args=\(fleet usage --plan "\$PLAN" --json\)/);
    expect(account).toMatch(/if \[ -n "\$BUDGET" \] && \[ "\$PLAN" = paid \]; then/);
    expect(account.indexOf("Check the shop's core")).toBeLessThan(account.indexOf('fleet usage'));
  });

  it('never substitutes an expression into a shell script, and reads the command\'s exit status', () => {
    for (const text of [deploy, nightly]) {
      const bodies = runs(text);
      expect(bodies.length).toBeGreaterThan(2);
      for (const body of bodies) expect(body).not.toMatch(/\$\{\{/);
      for (const body of bodies.filter((candidate) => candidate.includes('| tee'))) expect(body).toContain('set -euo pipefail');
    }
  });

  it('uses the actions every workflow of the core uses', () => {
    const used = (text) => [...new Set([...text.matchAll(/uses: (actions\/[\w-]+@v\d+)/g)].map((match) => match[1]))];
    const core = used(readFileSync(resolve(CORE, '.github/workflows/deploy.yml'), 'utf8'));
    for (const action of [...used(deploy), ...used(nightly)]) expect(core).toContain(action);
  });
});

// ---------------------------------------------------------------------------

describe('shopctl fleet init', () => {
  it('writes the workflows next to fleet.json, with the version and the floor', () => {
    const fleet = fleetWorkspace({ shops: [{ slug: 'boutique-a', path: 'shop-boutique-a', repository: 'agence/shop-boutique-a' }] });
    const { status, report } = fleet.json(['fleet', 'init']);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.files).toEqual(Object.keys(FLEET_FILES).map((path) => ({ path, action: 'create' })));
    expect(fleet.read('.github/workflows/deploy.yml')).toMatch(new RegExp(`^# Généré par \`shopctl fleet init\` depuis le socle v${VERSION.replaceAll('.', '\\.')}\\.`));
    expect(fleet.read('.github/fleet/shops.mjs')).toContain(`const MINIMUM_CORE = '${FLEET_MINIMUM_CORE}';`);
    expect(fleet.read('.github/fleet/shops.mjs')).not.toContain('__');
    // The shops are repositories of their own, inside the fleet's tree; the
    // backup key is read from it, and the fleet repository is public.
    expect(fleet.read('.gitignore')).toContain('/shop-boutique-a/\n');
    expect(fleet.read('.gitignore')).toContain('/.shopctl/\n');
  });

  it('keeps what is current, rewrites what was edited, and adds no line twice', () => {
    const fleet = fleetWorkspace({ shops: [{ slug: 'boutique-a', path: 'shop-boutique-a' }] });
    fleet.run(['fleet', 'init']);
    writeFileSync(join(fleet.root, '.github/workflows/nightly.yml'), 'édité à la main\n');
    const { report } = fleet.json(['fleet', 'init']);
    expect(report.files.map((file) => file.action)).toEqual(['keep', 'replace', 'keep']);
    expect(fleet.read('.github/workflows/nightly.yml')).toMatch(/^# Généré par `shopctl fleet init`/);
    expect(fleet.read('.gitignore').match(/\/shop-boutique-a\//g)).toHaveLength(1);
    expect(fleet.read('.gitignore').match(/\/\.shopctl\//g)).toHaveLength(1);
  });

  it('says which shops the fleet cannot reach, and writes nothing under --dry-run', () => {
    const fleet = fleetWorkspace({ shops: [{ slug: 'boutique-b', path: 'shop-boutique-b' }] });
    const result = fleet.run(['fleet', 'init', '--dry-run']);
    expect(result.status).toBe(EXIT_CODES.ok);
    expect(result.stdout).toMatch(/boutique-b — pas de dépôt : ni déployée ni sauvegardée par la flotte/);
    expect(() => fleet.read('.github/workflows/deploy.yml')).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('the fleet\'s helper script', () => {
  const helper = (shops, args, cwd) => {
    const fleet = fleetWorkspace({ shops, git: false });
    fleet.run(['fleet', 'init']);
    return spawnSync('node', [join(fleet.root, '.github/fleet/shops.mjs'), ...args], { cwd: cwd ?? fleet.root, encoding: 'utf8' });
  };

  it('lists the shops it can reach, and warns about the others', () => {
    const result = helper([{ slug: 'boutique-a', path: 'a', repository: 'agence/shop-a' }, { slug: 'boutique-b', path: 'b' }], ['matrix']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('matrix=[{"slug":"boutique-a","repository":"agence/shop-a"}]\n');
    expect(result.stderr).toMatch(/::warning::boutique-b : pas de dépôt/);
  });

  it('names one shop\'s repository, and refuses a shop it does not know', () => {
    const shops = [{ slug: 'boutique-a', path: 'a', repository: 'agence/shop-a' }];
    expect(helper(shops, ['repository', 'boutique-a']).stdout).toBe('repository=agence/shop-a\n');
    const unknown = helper(shops, ['repository', 'boutique-z']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/::error::« boutique-z » n'est pas une boutique de fleet\.json/);
  });

  it('refuses a shop below the core floor', () => {
    const tree = mkdtempSync(join(tmpdir(), 'shop-tree-'));
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ version: '0.3.31' }));
    const below = helper([{ slug: 'boutique-a', path: 'a' }], ['core', tree]);
    expect(below.status).toBe(1);
    expect(below.stderr).toMatch(new RegExp(`socle 0\\.3\\.31 ; le compte mutualisé demande ${FLEET_MINIMUM_CORE.replaceAll('.', '\\.')}`));
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ version: FLEET_MINIMUM_CORE }));
    expect(helper([{ slug: 'boutique-a', path: 'a' }], ['core', tree]).status).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('the fleet\'s account', () => {
  const managed = (accountId, slug) => {
    const target = shop({ accountId, slug });
    return { slug, path: target.root, repository: `agence/shop-${slug}`, isShop: true, root: target.root };
  };

  it('is the one every fleet-managed shop names', () => {
    expect(fleetAccount({ shops: [managed(ACCOUNT.id, 'boutique-a'), managed(ACCOUNT.id, 'boutique-b')] }, {})).toBe(ACCOUNT.id);
  });

  // A shop on its own account is in the registry for its upgrades, not
  // deployed by the fleet: without a repository, it is not asked.
  it('ignores a shop the fleet does not deploy, and refuses two accounts', () => {
    const own = { ...managed(OTHER_ACCOUNT.id, 'boutique-c'), repository: null };
    expect(fleetAccount({ shops: [managed(ACCOUNT.id, 'boutique-a'), own] }, {})).toBe(ACCOUNT.id);
    expect(() => fleetAccount({ shops: [managed(ACCOUNT.id, 'boutique-a'), managed(OTHER_ACCOUNT.id, 'boutique-c')] }, {})).toThrow(/un seul compte/);
    expect(() => fleetAccount({ shops: [managed(ACCOUNT.id, 'boutique-a')] }, { CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT.id })).toThrow(/un seul compte/);
  });

  it('comes from CLOUDFLARE_ACCOUNT_ID when no shop is here to say, and is never guessed', () => {
    expect(fleetAccount({ shops: [] }, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT.id })).toBe(ACCOUNT.id);
    expect(() => fleetAccount({ shops: [] }, {})).toThrow(/aucun compte Cloudflare/);
  });

  // The monitor token is a repository secret: every workflow reads it, on
  // every branch, with no approval.
  it('watches with a token that cannot deploy', () => {
    expect(monitorTokenFor({ CLOUDFLARE_API_TOKEN_MONITOR: 'lecture' })).toEqual({ value: 'lecture', from: 'CLOUDFLARE_API_TOKEN_MONITOR' });
    expect(() => monitorTokenFor({ CLOUDFLARE_API_TOKEN: 'deploie', CLOUDFLARE_API_TOKEN_MONITOR: 'deploie' })).toThrow(/CLOUDFLARE_API_TOKEN_MONITOR est le jeton de CLOUDFLARE_API_TOKEN/);
    expect(() => monitorTokenFor({ CLOUDFLARE_API_TOKEN_BACKUP: 'sauve', CLOUDFLARE_API_TOKEN_MONITOR: 'sauve' })).toThrow(/CLOUDFLARE_API_TOKEN_BACKUP/);
  });
});

// ---------------------------------------------------------------------------

describe('shopctl fleet repo', () => {
  const TOKENS = {
    CLOUDFLARE_API_TOKEN: 'cf-deploie',
    CLOUDFLARE_API_TOKEN_BACKUP: 'cf-sauve',
    CLOUDFLARE_API_TOKEN_MONITOR: 'cf-surveille',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT.id,
    SHOPCTL_BACKUP_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  const ready = () => {
    const fleet = fleetWorkspace({ shops: [{ slug: 'boutique-a', path: 'shop-boutique-a', repository: 'agence/shop-boutique-a' }] });
    fleet.run(['fleet', 'init']);
    fleet.commit();
    return fleet;
  };

  it('creates the fleet repository public, with three environments and the shared account\'s secrets', () => {
    const fleet = ready();
    const { status, report, stderr } = fleet.json(['fleet', 'repo', '--reviewer', 'damien'], TOKENS);
    expect(status, stderr).toBe(EXIT_CODES.ok);
    expect(report).toMatchObject({ repository: { nameWithOwner: fleet.nameWithOwner, created: true, visibility: 'public' }, account: ACCOUNT.id, missingTokens: [] });
    const repo = fleet.github().repos[fleet.nameWithOwner];
    expect(repo.visibility).toBe('public');
    expect(Object.keys(repo.environments)).toEqual(['staging', 'production', 'backup']);
    expect(repo.environments.production.reviewers).toBe(1);
    expect(repo.environments.backup).toMatchObject({ reviewers: 0, branches: ['main'], branchPolicy: { custom_branch_policies: true } });
    expect(repo.environments.production.secrets).toEqual({ CLOUDFLARE_API_TOKEN: 'cf-deploie', CLOUDFLARE_ACCOUNT_ID: ACCOUNT.id, SHOPCTL_BACKUP_KEY: TOKENS.SHOPCTL_BACKUP_KEY });
    expect(repo.environments.backup.secrets.CLOUDFLARE_API_TOKEN).toBe('cf-sauve');
    expect(repo.secrets).toEqual({ MONITOR_CLOUDFLARE_API_TOKEN: 'cf-surveille', MONITOR_CLOUDFLARE_ACCOUNT_ID: ACCOUNT.id });
  });

  it('never lets a token reach an argument vector or the terminal', () => {
    const fleet = ready();
    const result = fleet.run(['fleet', 'repo'], TOKENS);
    expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
    const argv = fleet.github().calls.flatMap((call) => call.argv).join(' ');
    for (const value of ['cf-deploie', 'cf-sauve', 'cf-surveille', TOKENS.SHOPCTL_BACKUP_KEY]) {
      expect(argv).not.toContain(value);
      expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }
  });

  it('refuses a deploying token as the backup or monitor token, before writing anything', () => {
    const fleet = ready();
    const result = fleet.run(['fleet', 'repo'], { ...TOKENS, CLOUDFLARE_API_TOKEN_MONITOR: 'cf-deploie' });
    expect(result.status).toBe(EXIT_CODES.input);
    expect(fleet.github().repos).toEqual({});
  });

  // `fleet repo` reads the key from the fleet's own .shopctl/, and pushes a
  // public repository: a key in its index is refused before anything is created.
  it('refuses a fleet whose index holds the backup key, staged or committed', () => {
    const fleet = fleetWorkspace({ shops: [{ slug: 'boutique-a', path: 'shop-boutique-a', repository: 'agence/shop-boutique-a' }] });
    fleet.run(['fleet', 'init']);
    mkdirSync(join(fleet.root, '.shopctl'));
    writeFileSync(join(fleet.root, '.shopctl/backup.key'), `${TOKENS.SHOPCTL_BACKUP_KEY}\n`);
    spawnSync('git', ['add', '-f', '.shopctl/backup.key'], { cwd: fleet.root });
    fleet.commit();
    const result = fleet.run(['fleet', 'repo'], TOKENS);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/\.shopctl\/backup\.key est suivi par git dans le dépôt de flotte/);
    expect(result.stderr).toMatch(/git rm -r --cached \.shopctl/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(TOKENS.SHOPCTL_BACKUP_KEY);
    expect(fleet.github().repos).toEqual({});
  });

  it('refuses a fleet that is not a git repository, or whose workflows were never written', () => {
    const bare = fleetWorkspace({ shops: [{ slug: 'boutique-a', path: 'a' }], git: false });
    const outside = bare.run(['fleet', 'repo'], TOKENS);
    expect(outside.status).toBe(EXIT_CODES.precondition);
    expect(outside.stderr).toMatch(/n'est pas un dépôt git/);
    const fleet = fleetWorkspace({ shops: [{ slug: 'boutique-a', path: 'a' }] });
    const result = fleet.run(['fleet', 'repo'], TOKENS);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/shopctl fleet init/);
  });
});
