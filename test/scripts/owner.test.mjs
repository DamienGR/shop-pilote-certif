import { describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { OWNER_TABLE, judgeOwner } from '../../shopctl/src/owner.mjs';
import { classifyTables } from '../../shopctl/src/backup/schema.mjs';
import { collisionFindings } from '../../shopctl/src/commands/fleet.mjs';
import { loadManifest } from '../../scripts/manifest.mjs';
import { names, shop } from '../helpers/provisioned-shop.mjs';

/**
 * The guard of the shared account (ADR 0019).
 *
 * On one account per merchant, a resource's name was proof of whose it was. On
 * the shared account it is not: two shops that derive the same names find each
 * other's database, and `provision` adopts a database by its name. Every test
 * here builds the collision on purpose — two trees, ONE imaginary account, the
 * same slug, two repositories — and asks each command that resolves the
 * database by name to refuse the one that is not its own.
 */

vi.setConfig({ testTimeout: 60_000 });

const CORE = new URL('../../', import.meta.url).pathname;
const FAST = ['--skip-verify', '--skip-build', '--skip-smoke'];

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** One shop provisioned in staging from its own repository. */
function provisioned(options = {}) {
  const target = shop({ built: true, forge: true, ...options });
  const result = target.run(['provision', '--env', 'staging']);
  expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
  return target;
}

/** A second tree in the FIRST one's account, same slug, another repository:
 *  the collision the shared account makes possible. */
function intruder(first) {
  const second = shop({ built: true, forge: true, slug: first.slug, account: first.statePath });
  git(second.root, ['remote', 'set-url', 'origin', `git@github.com:autre-agence/shop-${first.slug}.git`]);
  return second;
}

const marker = (target) => target.query(`SELECT repository, slug FROM ${OWNER_TABLE}`);

/** Every call the account received after `before`, as one string each. */
const callsSince = (target, before) => target.read().calls.slice(before).map(({ argv }) => argv.join(' '));

describe('judgeOwner', () => {
  const own = { repository: 'agence/shop-acme', slug: 'acme' };

  it('calls a database with no marker unmarked', () => {
    expect(judgeOwner(null, own)).toBe('unmarked');
  });

  it('recognises its own marker', () => {
    expect(judgeOwner({ repository: 'agence/shop-acme', slug: 'acme' }, own)).toBe('own');
  });

  // The collision itself: one slug, two repositories.
  it('calls another repository foreign, whatever the slug', () => {
    expect(judgeOwner({ repository: 'autre/shop-acme', slug: 'acme' }, own)).toBe('foreign');
  });

  // Two slugs deriving one name through `workerName`.
  it('calls another slug foreign, whatever the repository', () => {
    expect(judgeOwner({ repository: 'agence/shop-acme', slug: 'acme-bis' }, own)).toBe('foreign');
    expect(judgeOwner({ repository: null, slug: 'acme-bis' }, { repository: null, slug: 'acme' })).toBe('foreign');
  });

  // A tree that cannot say which repository it is cannot act as one.
  it('refuses to take a tree with no origin at its word', () => {
    expect(judgeOwner({ repository: 'agence/shop-acme', slug: 'acme' }, { repository: null, slug: 'acme' })).toBe('unproven');
  });

  it('judges a marker written before the repository existed on its slug', () => {
    expect(judgeOwner({ repository: null, slug: 'acme' }, own)).toBe('own');
  });
});

describe('the marker provision writes', () => {
  it('names the repository and the slug, lowercased like GitHub compares them', () => {
    const target = shop({ forge: true });
    git(target.root, ['remote', 'set-url', 'origin', `https://github.com/Agence/Shop-${target.slug}`]);
    const { report, status } = target.json(['provision', '--env', 'staging']);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.owner).toEqual({ repository: `agence/shop-${target.slug}`, verdict: 'unmarked', action: 'create' });
    expect(marker(target)).toEqual([{ repository: `agence/shop-${target.slug}`, slug: target.slug }]);
  });

  it('is kept by a second run, not rewritten', () => {
    const target = provisioned();
    const { report } = target.json(['provision', '--env', 'staging']);
    expect(report.owner).toMatchObject({ verdict: 'own', action: 'keep' });
    expect(marker(target)).toHaveLength(1);
  });

  it('is only announced by a dry run', () => {
    const target = shop({ forge: true });
    const { report, status } = target.json(['provision', '--env', 'staging', '--dry-run']);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.owner).toMatchObject({ verdict: 'unmarked', action: 'create' });
    expect(target.read().d1).toEqual([]);
  });

  // Every database provisioned before ADR 0019 lives on its merchant's own
  // account, where no other shop could have taken its name.
  it('claims a database provisioned before the marker existed', () => {
    const target = provisioned();
    target.sql(`DROP TABLE ${OWNER_TABLE};`);
    const deployed = target.run(['deploy', '--env', 'staging', ...FAST]);
    expect(deployed.status, deployed.stderr).toBe(EXIT_CODES.ok);
    expect(deployed.stdout).toMatch(/ne porte pas encore le marqueur/);

    const { report } = target.json(['provision', '--env', 'staging']);
    expect(report.owner).toMatchObject({ verdict: 'unmarked', action: 'create' });
    expect(marker(target)).toEqual([{ repository: target.nameWithOwner, slug: target.slug }]);
  });

  // `shopctl new` then `provision` before `repo` is a tree with no origin yet.
  it('is completed with the repository once the tree has one', () => {
    const target = shop();
    expect(target.run(['provision', '--env', 'staging']).status).toBe(EXIT_CODES.ok);
    expect(marker(target)).toEqual([{ repository: null, slug: target.slug }]);

    spawnSync('git', ['init', '--quiet', target.root]);
    git(target.root, ['remote', 'add', 'origin', 'git@github.com:agence/shop-atelier-test.git']);
    const { report } = target.json(['provision', '--env', 'staging']);
    expect(report.owner).toMatchObject({ verdict: 'own', action: 'update' });
    expect(marker(target)).toEqual([{ repository: 'agence/shop-atelier-test', slug: target.slug }]);
  });

  it('never travels in a backup', () => {
    const master = [
      { type: 'table', name: 'products', sql: 'CREATE TABLE products (id INTEGER PRIMARY KEY)' },
      { type: 'table', name: OWNER_TABLE, sql: `CREATE TABLE ${OWNER_TABLE} (id INTEGER PRIMARY KEY)` },
    ];
    const { tables, skipped } = classifyTables(master);
    expect(tables.map((table) => table.name)).toEqual(['products']);
    expect(skipped).toContainEqual({ name: OWNER_TABLE, reason: 'propriétaire' });
  });
});

describe('two shops of one name on one account', () => {
  it('refuses to provision onto the other one’s database, before any write', () => {
    const first = provisioned();
    const second = intruder(first);
    const before = second.read().calls.length;

    const result = second.run(['provision', '--env', 'staging']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/appartient à une autre boutique/);
    expect(result.stderr).toMatch(new RegExp(`agence/shop-${first.slug}`));

    const calls = callsSince(second, before);
    expect(calls.some((call) => / create |--file|secret put|migrations apply/.test(` ${call} `))).toBe(false);
    expect(existsSync(join(second.root, 'wrangler.jsonc'))).toBe(false);
    expect(marker(first)).toEqual([{ repository: first.nameWithOwner, slug: first.slug }]);
  });

  it('refuses to deploy, back up or destroy it', () => {
    const first = provisioned();
    const second = intruder(first);
    expect(second.run(['backup', 'keygen']).status).toBe(EXIT_CODES.ok);
    const before = first.read();

    for (const args of [
      ['deploy', '--env', 'staging', ...FAST],
      ['backup', '--env', 'staging'],
      ['destroy', '--env', 'staging', '--confirm', first.slug],
    ]) {
      const result = second.run(args);
      expect(result.status, args.join(' ')).toBe(EXIT_CODES.precondition);
      expect(result.stderr, args.join(' ')).toMatch(/appartient à une autre boutique/);
    }

    const after = first.read();
    expect(after.d1).toEqual(before.d1);
    expect(after.r2).toEqual(before.r2);
    expect(after.deploys ?? []).toEqual(before.deploys ?? []);
    expect(after.migrationsApplied).toBe(before.migrationsApplied);
  });

  // A repository renamed or transferred is the honest case: the marker is
  // stale and the data is this shop's. The slug is typed, like destroy's.
  it('takes the database over only with --claim and the slug typed', () => {
    const first = provisioned();
    const second = intruder(first);

    const typo = second.run(['provision', '--env', 'staging', '--claim', 'une-autre']);
    expect(typo.status).toBe(EXIT_CODES.input);

    const { report, status } = second.json(['provision', '--env', 'staging', '--claim', first.slug]);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.owner).toMatchObject({ verdict: 'foreign', action: 'claim' });
    expect(marker(second)).toEqual([{ repository: `autre-agence/shop-${first.slug}`, slug: first.slug }]);

    // And from then on it is the FIRST tree that is refused.
    const refused = first.run(['deploy', '--env', 'staging', ...FAST]);
    expect(refused.status).toBe(EXIT_CODES.precondition);
  });

  it('refuses a tree that cannot say which repository it is', () => {
    const target = provisioned();
    git(target.root, ['remote', 'remove', 'origin']);
    const result = target.run(['deploy', '--env', 'staging', ...FAST]);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/pas de remote origin/);
  });

  it('leaves a shop of another name alone', () => {
    const first = provisioned();
    const neighbour = shop({ built: true, forge: true, slug: 'voisine-test', account: first.statePath });
    const result = neighbour.run(['provision', '--env', 'staging']);
    expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
    expect(marker(neighbour)).toEqual([{ repository: neighbour.nameWithOwner, slug: 'voisine-test' }]);
    expect(marker(first)).toEqual([{ repository: first.nameWithOwner, slug: first.slug }]);
    expect(first.read().d1.map(({ name }) => name).sort()).toEqual(
      [names(first.slug, 'staging').database, names('voisine-test', 'staging').database].sort(),
    );
  });
});

describe('the fleet', () => {
  const witness = (name) => loadManifest(`test/fixtures/clients/${name}/client.yaml`, { root: CORE }).manifest;

  it('finds nothing to say about two shops with names of their own', () => {
    expect(collisionFindings([
      { file: 'pilot-fr', manifest: witness('pilot-fr') },
      { file: 'canary-minimal', manifest: witness('canary-minimal') },
    ])).toEqual([]);
  });

  // Two slugs, one workerName: every derived resource is shared. The registry
  // refuses two entries with one slug; only the manifests show this.
  it('names both shops when two slugs derive the same resources', () => {
    const pilot = witness('pilot-fr');
    const copy = structuredClone(witness('canary-minimal'));
    copy.cloudflare.workerName = pilot.cloudflare.workerName;
    const findings = collisionFindings([
      { file: 'pilot-fr', manifest: pilot },
      { file: 'canary-minimal', manifest: copy },
    ]);
    expect(findings.map((finding) => finding.slug).sort()).toEqual(['canary-minimal', 'pilot-fr']);
    for (const finding of findings) {
      expect(finding.message).toMatch(/revendique les mêmes identifiants/);
      expect(finding.message).toMatch(/ADR 0019/);
    }
  });

  it('names a production domain claimed twice', () => {
    const pilot = witness('pilot-fr');
    const copy = structuredClone(witness('canary-minimal'));
    copy.cloudflare.productionDomain = pilot.cloudflare.productionDomain;
    const [finding] = collisionFindings([
      { file: 'pilot-fr', manifest: pilot },
      { file: 'canary-minimal', manifest: copy },
    ]);
    expect(finding.message).toContain(pilot.cloudflare.productionDomain);
  });
});
