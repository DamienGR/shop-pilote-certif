import { beforeAll, describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { renderEnvironmentConfig } from '../../shopctl/src/commands/provision.mjs';
import { resolveShop } from '../../shopctl/src/shop.mjs';
import { ACCOUNT, names, shop } from '../helpers/provisioned-shop.mjs';

/**
 * The tenant-isolation gate (plan §8.3, and the last open line of §3.1).
 *
 * The architecture is multi-client in the control plane and mono-client at
 * runtime, and every other suite in this repository tests ONE shop. That is the
 * shape of the defect this gate exists for: a shop is correct on its own and
 * wrong beside another — a resource name that does not carry the slug, a
 * credential read from the environment instead of from the shop, a Wrangler
 * file rendered for one shop and left in place while a command writes for the
 * other. None of those fail a single-shop suite, and all of them are silent in
 * production until the second customer.
 *
 * So the world here is TWO shops in ONE Cloudflare account and ONE GitHub
 * account: the arrangement in which the mistake is possible. Two accounts, or
 * two temporary directories, would prove only that separate directories are
 * separate.
 *
 * The two shops are the witnesses of plan §2.3, read from their real manifests
 * rather than invented here — `pilot-fr` with a theme the core does not own, a
 * staging domain and an account id in its manifest; `canary-minimal` with a
 * core theme, no staging domain and no account id, so the account arrives by
 * flag. Their asymmetry is the point: a value that only one of them declares is
 * where a hard-coded assumption hides.
 *
 * What it can prove and what it cannot. Everything below runs the real
 * commands, the real renderers and the real SQL against the repository's own
 * migrations; the Cloudflare account and the forge are doubles. The lines of
 * §8.3 about DEPLOYED shops — two Workers answering on two origins with two
 * databases behind them — are re-run in the final campaign on real accounts.
 * This gate holds the properties that can be decided before then, at every
 * commit, which is the half that regresses.
 */

const CORE = new URL('../../', import.meta.url).pathname;
const ENVS = ['staging', 'production'];
const FAST = ['--skip-verify', '--skip-build', '--skip-smoke'];

// Two shops, four environments, two repositories and a catalogue import, all
// through spawned commands. The budget is the world, not any one assertion.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

/** A witness manifest, pointed at the imaginary account this suite owns. */
function witness(name) {
  return readFileSync(resolve(CORE, `test/fixtures/clients/${name}/client.yaml`), 'utf8').replace(
    /^(\s{2}accountId:).*$/m,
    `$1 ${ACCOUNT.id}`,
  );
}

/**
 * Render one shop's Wrangler configuration for one environment.
 *
 * The suite has to read a specific database, and the D1 binding is called `DB`
 * in every shop of the fleet — which is the whole reason cross-tenant writes
 * are possible at all. Rendering through the command's own renderer, from the
 * id the account assigned, is how a read here lands where the shop's own
 * commands would land.
 */
function render(target, env, state) {
  const { manifest } = resolveShop(target.root, null);
  const databaseId = state.d1.find((entry) => entry.name === names(target.slug, env).database)?.uuid;
  expect(databaseId, `${target.slug} ${env} was never provisioned`).toBeTruthy();
  renderEnvironmentConfig({ root: target.root, manifest, env, databaseId });
  return target;
}

/** What one environment's database holds, whatever shop is asking. */
const rows = (target, table) => target.query(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

/** One git answer, from inside a shop's own tree — where `insteadOf` points its
 *  GitHub remote at the local bare repository that stands in for the forge. */
function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

const world = {};

beforeAll(() => {
  // pilot-fr first: it owns the account file and the forge file the canary
  // then joins, which is what puts both shops in one account.
  const pilot = shop({ manifest: witness('pilot-fr'), migrations: true, built: true, forge: true });
  const canary = shop({
    manifest: witness('canary-minimal'),
    migrations: true,
    built: true,
    forge: true,
    account: pilot.statePath,
    forgeAccount: pilot.ghState,
  });

  // `canary-minimal` declares no accountId (its manifest says why), so the
  // account reaches it by flag. Both branches of ADR 0002 run here.
  const canaryAccount = ['--account', ACCOUNT.id];

  for (const env of ENVS) {
    const one = pilot.run(['provision', '--env', env]);
    expect(one.status, one.stderr).toBe(EXIT_CODES.ok);
    const two = canary.run(['provision', '--env', env, ...canaryAccount]);
    expect(two.status, two.stderr).toBe(EXIT_CODES.ok);
  }

  // One repository per shop, in one forge, each with its OWN Cloudflare token
  // per environment — four tokens, no two shops sharing one.
  const tokens = (slug) => ({
    CLOUDFLARE_API_TOKEN_STAGING: `cf-${slug}-staging`,
    CLOUDFLARE_API_TOKEN_PRODUCTION: `cf-${slug}-production`,
  });
  for (const target of [pilot, canary]) {
    // The canary's account id reaches `repo` from the environment, the way a
    // CI runner would hand it over; the pilot's comes from its manifest.
    const account = target === canary ? { CLOUDFLARE_ACCOUNT_ID: ACCOUNT.id } : {};
    const result = target.run(['repo'], { ...tokens(target.slug), ...account });
    expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
  }

  // Staging deployed on both: that is when the internal secrets are generated,
  // and generation is where two shops could come to share one.
  for (const target of [pilot, canary]) {
    const account = target === canary ? canaryAccount : [];
    const result = target.run(['deploy', '--env', 'staging', ...account, ...FAST]);
    expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
  }

  // A catalogue in ONE shop's staging, so every other database in the account
  // has something to not contain. The witness catalogue, through the real
  // import: twenty products, four categories, eight images into R2.
  cpSync(resolve(CORE, 'test/fixtures/clients/pilot-fr/catalogue'), join(pilot.root, 'catalogue'), { recursive: true });
  render(pilot, 'staging', pilot.read());
  const imported = pilot.run([
    'catalog',
    'import',
    'catalogue/catalog.csv',
    '--remote',
    '--env',
    'staging',
    '--create-categories',
  ]);
  expect(imported.status, imported.stderr).toBe(EXIT_CODES.ok);

  Object.assign(world, { pilot, canary, state: () => pilot.read(), forge: () => pilot.github() });
});

// ---------------------------------------------------------------------------
// Two repositories (§8.3)

describe('two repositories', () => {
  it('gives each shop its own, and neither knows the other exists', () => {
    const repos = Object.keys(world.forge().repos);
    expect(repos.sort()).toEqual([world.canary.nameWithOwner, world.pilot.nameWithOwner].sort());
    expect(new Set(repos).size).toBe(2);
  });

  // The tree is the repository, and the history is what an upgrade merges into
  // (plan §3.4). Two shops sharing one history would take each other's commits
  // — including each other's theme — on the next core version.
  it('pushes each history to its own remote and to no other', () => {
    const heads = [world.pilot, world.canary].map((target) => ({
      slug: target.slug,
      local: git(target.root, ['rev-parse', 'HEAD']),
      remote: git(target.root, ['ls-remote', target.originUrl, 'refs/heads/main']).split('\t')[0],
    }));
    for (const head of heads) expect(head.remote, `${head.slug} was never pushed`).toBe(head.local);
    expect(heads[0].local).not.toBe(heads[1].local);
    // And neither remote can answer for the other's commit.
    expect(git(world.pilot.root, ['branch', '--remotes', '--contains', heads[1].local], { allowFailure: true })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Two themes (§8.3)

describe('two themes', () => {
  it('lets each shop select its own, one of which the core does not own', () => {
    const theme = (target) => resolveShop(target.root, null).manifest.theme.id;
    expect(theme(world.pilot)).toBe('atelier');
    expect(theme(world.canary)).toBe('market');
    expect(theme(world.pilot)).not.toBe(theme(world.canary));
  });
});

// ---------------------------------------------------------------------------
// Two Workers, two databases, six buckets per pair of environments (§8.3)

describe('the resources of two shops in one account', () => {
  /** Every resource name the account holds, by kind. */
  const inventory = () => {
    const state = world.state();
    return {
      workers: state.workers.map(({ name }) => name),
      databases: state.d1.map(({ name }) => name),
      buckets: state.r2.map(({ name }) => name),
      ids: state.d1.map(({ uuid }) => uuid),
    };
  };

  it('names every one of them after its own shop and environment', () => {
    const expected = [world.pilot, world.canary].flatMap((target) => ENVS.map((env) => names(target.slug, env)));
    const { databases, buckets } = inventory();
    expect(databases.sort()).toEqual(expected.map(({ database }) => database).sort());
    expect(buckets.sort()).toEqual(expected.flatMap(({ images, files, backups }) => [images, files, backups]).sort());
  });

  // Six buckets per shop across the pair of environments — images, files and
  // backups, staging and production — and it is a count because the failure is
  // a MISSING one: a private-files bucket that a second shop reuses hands one
  // merchant's invoices to the other, and a shared backups bucket puts one
  // shop's whole database next to another's restore.
  it('gives each shop six buckets across the pair of environments', () => {
    const { buckets } = inventory();
    for (const target of [world.pilot, world.canary]) {
      expect(buckets.filter((name) => name.includes(target.slug))).toHaveLength(6);
    }
    expect(new Set(buckets).size).toBe(12);
  });

  // The one resource no manifest renders: wrangler provisions it at the first
  // deploy, from the SESSION binding of the built configuration, under the
  // Worker's name. Two shops deployed are two namespaces, and a teardown has
  // to find its own by that name alone.
  it('gives each deployed Worker its own sessions namespace', () => {
    const titles = world.state().kv.map(({ title }) => title);
    expect(titles.sort()).toEqual([names(world.pilot.slug, 'staging').sessions, names(world.canary.slug, 'staging').sessions].sort());
    expect(new Set(world.state().kv.map(({ id }) => id)).size).toBe(2);
  });

  it('never lets two shops share a database, an id or a Worker', () => {
    const { databases, ids, workers } = inventory();
    expect(new Set(databases).size).toBe(databases.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(workers).size).toBe(workers.length);
  });

  // The rendered configuration is what a deploy uploads. One name of the other
  // shop in it is a Worker bound to the wrong database, and it deploys green.
  it('renders a configuration that names one shop and only one', () => {
    const state = world.state();
    for (const [target, other] of [
      [world.pilot, world.canary],
      [world.canary, world.pilot],
    ]) {
      for (const env of ENVS) {
        render(target, env, state);
        const config = readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8');
        const own = names(target.slug, env);
        expect(config).toContain(`"name": "${own.worker}"`);
        expect(config).toContain(own.database);
        expect(config).toContain(own.images);
        expect(config).toContain(own.files);
        expect(config).not.toContain(other.slug);
        // Only the pilot puts an Access application in front of its preview,
        // and only its staging Worker may carry it: an audience rendered into
        // the other shop's Worker would refuse that shop's own admin.
        const { manifest } = resolveShop(target.root, null);
        const aud = env === 'staging' ? (manifest.cloudflare.stagingAccessAud ?? '') : '';
        expect(config).toContain(`"CF_ACCESS_AUD": "${aud}"`);
        if (target === world.pilot && env === 'staging') expect(aud).not.toBe('');
        // The other environment of the SAME shop is the likelier mistake, and
        // the one no slug check would catch.
        for (const { database } of ENVS.filter((candidate) => candidate !== env).map((candidate) => names(target.slug, candidate))) {
          expect(config).not.toContain(database);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// No shared secret (§8.3)

describe('no shared secret', () => {
  /** What was piped to `wrangler secret put`, by Worker and secret name. */
  const put = () =>
    world
      .state()
      .calls.filter(({ argv }) => argv[0] === 'secret' && argv[1] === 'put')
      .map(({ argv, stdin }) => ({ worker: argv[argv.indexOf('--name') + 1], name: argv[2], value: stdin }));

  it('generates a different internal secret for every shop', () => {
    const values = put().map(({ value }) => value);
    expect(values.length).toBeGreaterThanOrEqual(4);
    expect(new Set(values).size).toBe(values.length);
  });

  it('attaches each one to its own Worker and to no other', () => {
    for (const { worker } of put()) {
      expect([`minshop-${world.pilot.slug}-staging`, `minshop-${world.canary.slug}-staging`]).toContain(worker);
    }
    for (const { name, secrets } of world.state().workers) {
      expect(secrets.sort()).toEqual(['AUTH_SECRET', 'SECRETS_KEK']);
      expect(name).toMatch(/^minshop-(pilot-fr|canary-minimal)-staging$/);
    }
  });

  // The forge side of the same promise: a token placed for one shop's staging
  // is in that shop's staging environment and in no other of the four.
  it('scopes every Cloudflare token to one shop and one environment', () => {
    const repos = world.forge().repos;
    const placed = [];
    for (const target of [world.pilot, world.canary]) {
      for (const env of ENVS) {
        const secrets = repos[target.nameWithOwner].environments[env].secrets;
        expect(secrets.CLOUDFLARE_API_TOKEN).toBe(`cf-${target.slug}-${env}`);
        placed.push(secrets.CLOUDFLARE_API_TOKEN);
      }
    }
    expect(new Set(placed).size).toBe(4);
  });

  it('never lets a secret reach an argument vector', () => {
    const values = new Set([...put().map(({ value }) => value), ...['pilot-fr', 'canary-minimal'].flatMap((slug) => ENVS.map((env) => `cf-${slug}-${env}`))]);
    const argv = [...world.state().calls, ...world.forge().calls].map(({ argv: line }) => line.join(' '));
    for (const value of values) {
      if (!value) continue;
      expect(argv.some((line) => line.includes(value))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// No crossed data (§8.3)

describe('no crossed data', () => {
  it('leaves the catalogue in the one database that was imported into', () => {
    const state = world.state();
    expect(rows(render(world.pilot, 'staging', state), 'products')).toBe(20);
    expect(rows(render(world.pilot, 'production', state), 'products')).toBe(0);
    expect(rows(render(world.canary, 'staging', state), 'products')).toBe(0);
    expect(rows(render(world.canary, 'production', state), 'products')).toBe(0);
  });

  // Same question for the other half of a shop's data. An images bucket shared
  // between two shops shows one merchant's photography on the other's site.
  it('leaves the images in the one bucket they were uploaded to', () => {
    const state = world.state();
    const objects = (name) => state.r2.find((bucket) => bucket.name === name)?.objects ?? 0;
    expect(objects(names(world.pilot.slug, 'staging').images)).toBe(8);
    for (const bucket of state.r2.filter(({ name }) => name !== names(world.pilot.slug, 'staging').images)) {
      expect(objects(bucket.name)).toBe(0);
    }
  });

  // Isolation held by refusal rather than by observation. `DB` is the binding
  // name in every shop of the fleet, so the file left on disk decides which
  // database a write lands in — and the file left on disk is whatever the last
  // command rendered. The import refuses to be that command's victim.
  it('refuses to import into a tree rendered for another environment', () => {
    const target = world.pilot;
    render(target, 'production', world.state());
    const result = target.run(['catalog', 'import', 'catalogue/catalog.csv', '--remote', '--env', 'staging']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/ne nomme pas/);
    // The production database it was pointed at is still empty: the refusal
    // came before the first statement.
    expect(rows(render(target, 'production', world.state()), 'products')).toBe(0);
  });

  it('refuses to import into a tree rendered for another shop', () => {
    const state = world.state();
    const target = world.pilot;
    // The canary's configuration, in the pilot's tree: the exact artefact a
    // shared working directory or a copied file produces.
    const { manifest } = resolveShop(world.canary.root, null);
    renderEnvironmentConfig({
      root: target.root,
      manifest,
      env: 'staging',
      databaseId: state.d1.find(({ name }) => name === names(world.canary.slug, 'staging').database).uuid,
    });
    const result = target.run(['catalog', 'import', 'catalogue/catalog.csv', '--remote', '--env', 'staging']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/une autre boutique/);
    expect(rows(render(world.canary, 'staging', world.state()), 'products')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// One shop torn down beside the other (§8.3, certification step 7)

/**
 * `destroy` finds what it deletes by NAME on an account that holds the other
 * shop too. A prefix match, a name read from the environment, a namespace
 * looked up by binding rather than by title — each would take the neighbour's
 * resource with it, and each is invisible with one shop on the account.
 *
 * Last in the file on purpose: it changes the world the suites above read.
 */
describe('tearing one shop down', () => {
  it('removes the canary’s staging and nothing of the pilot’s', () => {
    const before = world.state();
    const canary = names(world.canary.slug, 'staging');
    const { report, status } = world.canary.json([
      'destroy',
      '--env',
      'staging',
      '--confirm',
      world.canary.slug,
      '--account',
      ACCOUNT.id,
    ]);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.removed).toEqual([canary.worker, canary.sessions, canary.images, canary.files, canary.backups, canary.database]);

    const after = world.state();
    const gone = new Set(report.removed);
    // Exactly the canary's staging left the account: every other worker,
    // namespace, bucket and database is still there, under the same id.
    expect(after.workers.map(({ name }) => name)).toEqual(before.workers.map(({ name }) => name).filter((name) => !gone.has(name)));
    expect(after.kv).toEqual(before.kv.filter(({ title }) => !gone.has(title)));
    expect(after.r2.map(({ name }) => name)).toEqual(before.r2.map(({ name }) => name).filter((name) => !gone.has(name)));
    expect(after.d1).toEqual(before.d1.filter(({ name }) => !gone.has(name)));
    expect(after.workers.map(({ name }) => name)).toEqual([names(world.pilot.slug, 'staging').worker]);
  });

  it('leaves the pilot’s catalogue and images where they were', () => {
    const state = world.state();
    expect(rows(render(world.pilot, 'staging', state), 'products')).toBe(20);
    expect(state.r2.find(({ name }) => name === names(world.pilot.slug, 'staging').images)?.objects).toBe(8);
  });
});
