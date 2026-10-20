/**
 * A shop with an imaginary Cloudflare account behind it.
 *
 * Shared by the provisioning and deployment suites because both ask the same
 * question — what does shopctl DO to an account — and a second copy of the
 * fixture would be a second account model to keep in step.
 *
 * The shop is built file by file rather than cloned from a core tag: the
 * commands under test read the manifest, the Wrangler template and the
 * migrations directory, and nothing else. Cloning five hundred files per
 * assertion would make the suites slow enough that someone would stop running
 * them, and the shape of a generated tree is already pinned by jalon 2's suite.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { stripAnsi } from '../../shopctl/src/cloudflare.mjs';

const CORE = new URL('../../', import.meta.url).pathname;
const BIN = resolve(CORE, 'shopctl/bin/shopctl.mjs');
const DOUBLE = resolve(CORE, 'test/fixtures/wrangler-double.mjs');
const GH_DOUBLE = resolve(CORE, 'test/fixtures/gh-double.mjs');

/** Git needs an identity to commit, and a test must not depend on the one the
 *  developer happens to have configured. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Minshop Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'Minshop Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

export const ACCOUNT = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', name: 'Agence' };
export const OTHER_ACCOUNT = { id: '0123456789abcdef0123456789abcdef', name: 'Compte perso' };

/**
 * A shop, small enough to build per test.
 *
 * Not a `shopctl new` clone: provisioning reads the manifest, the Wrangler
 * template and the migrations directory, and nothing else. Cloning five hundred
 * files per assertion would make the suite slow enough that someone would stop
 * running it — and what is under test is the conversation with the account, not
 * the shape of a generated tree, which jalon 2's suite already pins.
 *
 * @param options.manifest raw `client/client.yaml`, when the subject is a
 *   PARTICULAR shop rather than any shop — the witnesses of plan §2.3, whose
 *   slug, theme, domains and features are the point. Omitted, a generic one is
 *   generated from `slug` and `accountId`.
 * @param options.account the state file of an EXISTING imaginary Cloudflare
 *   account, so two shops can be built inside ONE account. That is the only
 *   arrangement in which isolation means anything: separate accounts would
 *   prove nothing that separate temporary directories did not already.
 * @param options.forgeAccount the same, for the imaginary GitHub `forge` opens.
 * @param options.cloudflare further fields of the generated manifest's
 *   `cloudflare` section, by name — a production on its own account, a staging
 *   preview — for the suites whose subject is one of them.
 */
export function shop({
  accountId = ACCOUNT.id,
  cloudflare = {},
  slug = 'atelier-test',
  built = false,
  forge = false,
  migrations = false,
  manifest: manifestYaml = null,
  account: sharedState = null,
  forgeAccount: sharedForge = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shopctl-provision-'));
  const core = JSON.parse(readFileSync(resolve(CORE, 'package.json'), 'utf8'));
  if (manifestYaml) slug = manifestYaml.match(/^\s{2}slug:\s*(\S+)/m)?.[1] ?? slug;
  // A build reads the selected theme's directory; a provisioned shop never
  // builds, but `config:validate` and the theme resolver both want it there.
  const themeId = (manifestYaml ?? '').match(/^\s{2}id:\s*([A-Za-z0-9_-]+)/m)?.[1] ?? 'atelier';

  mkdirSync(join(root, 'client'), { recursive: true });
  mkdirSync(join(root, 'migrations'), { recursive: true });
  mkdirSync(join(root, `src/themes/${themeId}`), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  // `--skip-build` refuses to run without one, which is the point of the flag:
  // reusing a build that is not there would upload the previous shop's bundle.
  if (built) mkdirSync(join(root, 'dist/server'), { recursive: true });

  // The REAL migrations, for the suites whose subject is the schema itself:
  // the backup derives its table list from `sqlite_master`, so a hand-written
  // subset would be a second schema to keep in step — the drift ADR 0005 and
  // the settlement suite both refuse.
  if (migrations) cpSync(resolve(CORE, 'migrations'), join(root, 'migrations'), { recursive: true });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shop', version: core.version, private: true }, null, 2));
  cpSync(resolve(CORE, 'wrangler.template.jsonc'), join(root, 'wrangler.template.jsonc'));
  writeFileSync(
    join(root, 'client/client.yaml'),
    manifestYaml ??
    [
      'schemaVersion: 1',
      `coreVersion: ${core.version}`,
      'client:',
      `  slug: ${slug}`,
      '  displayName: Boutique de test',
      '  locale: fr-FR',
      '  timezone: Europe/Paris',
      '  currency: EUR',
      'commerce:',
      '  market: FR',
      '  pricesIncludeTax: true',
      '  checkoutMode: guest',
      '  defaultVatRate: 20',
      '  invoiceStrategy: pending-validation',
      'features:',
      '  customerAccounts: false',
      '  semanticSearch: false',
      '  digitalProducts: false',
      '  promoCodes: true',
      '  shipping: true',
      'cloudflare:',
      '  jurisdiction: eu',
      `  workerName: minshop-${slug}`,
      '  productionDomain: boutique.example.fr',
      ...(accountId ? [`  accountId: ${accountId}`] : []),
      ...Object.entries(cloudflare).map(([key, value]) => `  ${key}: ${value}`),
      'email:',
      '  provider: resend',
      '  from: contact@boutique.example.fr',
      'theme:',
      '  id: atelier',
      '',
    ].join('\n'),
  );

  // `npx --no-install wrangler` resolves the shop's own binary, so the double
  // is installed exactly where the real one would be. Nothing in shopctl knows
  // it is talking to a stand-in.
  const shim = join(root, 'node_modules/.bin/wrangler');
  writeFileSync(shim, `#!/usr/bin/env node\nimport('${DOUBLE}');\n`);
  chmodSync(shim, 0o755);

  // One state file is one Cloudflare account. Sharing it is how two shops come
  // to live in the same one; a fresh one is the ordinary case.
  const statePath = sharedState ?? join(root, 'cf-state.json');
  if (!sharedState) {
    writeFileSync(
      statePath,
      JSON.stringify({ authenticated: true, accounts: [ACCOUNT], d1: [], r2: [], workers: [], calls: [] }, null, 2),
    );
  }

  /**
   * The forge side: a real git repository, a real remote, and a `gh` that
   * answers from a file.
   *
   * The remote is a LOCAL bare repository that git reaches through
   * `url.<path>.insteadOf`, so the URL shopctl parses and hands to `gh` is a
   * genuine `git@github.com:…` one while `git push` and `git ls-remote` never
   * leave the machine. That keeps the real git path under test — the URL
   * parsing, the push, the "is the branch already on the remote" question —
   * rather than stubbing the one command whose behaviour matters.
   */
  // One state file is one GitHub account, for the same reason as the account
  // above: two shops in one forge is the arrangement that can be wrong.
  const ghState = sharedForge ?? join(root, 'gh-state.json');
  const bin = join(root, '.bin');
  let remote = null;
  const nameWithOwner = `agence/shop-${slug}`;
  const originUrl = `git@github.com:${nameWithOwner}.git`;
  if (forge) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nimport('${GH_DOUBLE}');\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    remote = mkdtempSync(join(tmpdir(), 'shopctl-remote-'));
    const git = (args, cwd = root) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'user.name', 'Minshop Tests']);
    git(['config', 'user.email', 'tests@example.com']);
    git(['config', `url.${remote}.insteadOf`, originUrl]);
    git(['remote', 'add', 'origin', originUrl]);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'Initialiser la boutique']);
    spawnSync('git', ['init', '--bare', '--quiet', remote], { encoding: 'utf8' });

    if (!sharedForge) {
      writeFileSync(ghState, JSON.stringify({ authenticated: true, repos: {}, users: { damien: 17449459 }, calls: [] }, null, 2));
    }
  }

  return {
    root,
    slug,
    statePath,
    ghState,
    /** Where the `gh` double lives. A test that calls into shopctl IN-PROCESS
     *  has to put it on this process's own PATH; the spawned runs get it from
     *  `run()`. */
    binDir: bin,
    nameWithOwner,
    originUrl,
    remote,
    account(patch) {
      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), ...patch }, null, 2));
    },
    read() {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    },
    /**
     * Talk to the imaginary account's D1 directly, through the double's own
     * code path rather than around it.
     *
     * A test that seeded rows with its own `node:sqlite` handle would be
     * writing to a second opinion of where the database is; this runs the same
     * binary shopctl runs, so the rows land wherever shopctl will look for
     * them. `wrangler.jsonc` has to be rendered first — `provision` does that.
     */
    wrangler(args) {
      const result = spawnSync(shim, args, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, WRANGLER_DOUBLE_STATE: statePath },
      });
      return { ...result, stdout: stripAnsi(result.stdout ?? ''), stderr: stripAnsi(result.stderr ?? '') };
    },
    /** Apply the tree's migrations to the environment's database. */
    migrate() {
      return this.wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
    },
    /** Run SQL against the environment's database, as a file, like shopctl does. */
    sql(statements) {
      const file = join(root, 'seed.sql');
      writeFileSync(file, Array.isArray(statements) ? `${statements.join('\n')}\n` : statements);
      try {
        const result = this.wrangler(['d1', 'execute', 'DB', '--remote', '--file', file, '--yes']);
        if (result.status !== 0) throw new Error(`seed failed: ${result.stderr || result.stdout}`);
        return result;
      } finally {
        rmSync(file, { force: true });
      }
    },
    /** One query's rows, as the double's D1 answers them. */
    query(sql) {
      const result = this.wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', sql]);
      if (result.status !== 0) throw new Error(`query failed: ${result.stderr || result.stdout}`);
      const start = result.stdout.search(/[[{]/);
      return JSON.parse(result.stdout.slice(start))[0].results;
    },
    /** What the imaginary GitHub holds. */
    github(patch) {
      const current = JSON.parse(readFileSync(ghState, 'utf8'));
      if (!patch) return current;
      writeFileSync(ghState, JSON.stringify({ ...current, ...patch }, null, 2));
      return current;
    },
    run(args, env = {}) {
      const result = spawnSync('node', [BIN, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...GIT_ENV,
          WRANGLER_DOUBLE_STATE: statePath,
          GH_DOUBLE_STATE: ghState,
          CLOUDFLARE_ACCOUNT_ID: '',
          CLOUDFLARE_API_TOKEN: '',
          ...(forge ? { PATH: `${bin}:${process.env.PATH}` } : {}),
          ...env,
        },
      });
      return { ...result, stdout: stripAnsi(result.stdout ?? ''), stderr: stripAnsi(result.stderr ?? '') };
    },
    json(args, env = {}) {
      const result = this.run([...args, '--json'], env);
      return { ...result, report: result.stdout.trim() ? JSON.parse(result.stdout) : null };
    },
  };
}

export const names = (slug, env) => ({
  worker: `minshop-${slug}-${env}`,
  database: `minshop-${slug}-${env}-db`,
  images: `minshop-${slug}-${env}-images`,
  files: `minshop-${slug}-${env}-files`,
  backups: `minshop-${slug}-${env}-backups`,
  // Never rendered by the shop: wrangler provisions it at the first deploy,
  // from the SESSION binding the Astro adapter adds to the built configuration.
  sessions: `minshop-${slug}-${env}-session`,
});
