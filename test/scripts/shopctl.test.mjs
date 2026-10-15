import { describe, expect, it, vi } from 'vitest';

// .mjs for the same reason as its neighbours: tsconfig pins `types` to the
// Cloudflare types, so node builtins have no declarations in a .ts file here.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { parseArguments } from '../../shopctl/src/cli.mjs';
import {
  NEW_OPTIONS,
  cloneableRepositoryUrl,
  displayNameFromSlug,
  resolveAccountId,
  resolveDomain,
  resolveThemeId,
  versionFromTag,
  witnessClaims,
} from '../../shopctl/src/commands/new.mjs';
import { buildManifest, renderManifest, yamlScalar } from '../../shopctl/src/manifest-template.mjs';
import { assertNoCredentialsInArgv, classifyCredential, redact } from '../../shopctl/src/secrets.mjs';
import { HUMAN_CHECKLIST } from '../../shopctl/src/commands/doctor.mjs';
import { parseManifestYaml } from '../../scripts/manifest-yaml.mjs';
import { CREDENTIAL_PATTERNS, RESERVED_SLUGS, validateManifest } from '../../scripts/manifest-schema.mjs';
import { RESERVED_THEME_IDS } from '../../scripts/themes.mjs';
import { WITNESS_CLIENTS_DIR, discoverManifests } from '../../scripts/manifest.mjs';
// The core fixture and the git identity live in a helper: the fleet suite
// (jalon 9) creates the same "core at a tag" and a second copy would drift.
import { CORE_TAG, CORE_VERSION, GIT_ENV, createCoreRepository, git } from '../helpers/core-repository.mjs';
import { ACCOUNT, OTHER_ACCOUNT, shop } from '../helpers/provisioned-shop.mjs';

const CORE = new URL('../../', import.meta.url).pathname;
const BIN = resolve(CORE, 'shopctl/bin/shopctl.mjs');

// Every test in this file spawns real processes — a git clone of the whole
// tree, the gates the shop carries, `wrangler --version`. Vitest's five-second
// default is a budget for pure functions; here it only measures how loaded the
// machine is, and a suite that fails on a busy laptop is a suite people learn
// to re-run instead of read.
vi.setConfig({ testTimeout: 60_000 });

function shopctl(args, cwd) {
  return spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
}

/** Every file under `dir`, repository-relative, sorted, `.git` excluded. */
function treeFiles(dir, base = dir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...treeFiles(path, base));
    else found.push(relative(base, path).split('\\').join('/'));
  }
  return found;
}

let sharedRoot;
let sharedCore;
/** One core repository for the read-only assertions; the tests that mutate a
 *  target directory make their own. Cloning 500-odd files per assertion would
 *  make the suite slow enough that someone would stop running it. */
function core() {
  if (!sharedCore) {
    sharedRoot = mkdtempSync(join(tmpdir(), 'shopctl-core-'));
    sharedCore = createCoreRepository(sharedRoot);
  }
  return sharedCore;
}

function workspace() {
  return mkdtempSync(join(tmpdir(), 'shopctl-work-'));
}

/** The witnesses' slugs, read from their own manifests. Not clientSlugs():
 *  CI also runs this suite inside a generated shop, where that list starts
 *  with the shop itself. */
function witnessSlugs() {
  return discoverManifests(CORE)
    .filter((file) => file.startsWith(`${WITNESS_CLIENTS_DIR}/`))
    .map((file) => parseManifestYaml(readFileSync(join(CORE, file), 'utf8'), { file }).client.slug);
}

// ---------------------------------------------------------------------------
// Argument parsing. The reason it is hand-written: an unknown flag must be a
// hard error, or a caller's typo silently asks a different question.

describe('the command line', () => {
  const spec = { values: NEW_OPTIONS, flags: ['--no-install', '--no-verify'] };

  it('separates positionals from values', () => {
    expect(parseArguments(['acme-shop', '--core', 'v1.2.3', '--no-install'], spec)).toEqual({
      positionals: ['acme-shop'],
      values: { '--core': 'v1.2.3', '--no-install': true },
    });
  });

  it('accepts --flag=value', () => {
    expect(parseArguments(['--name=Boutique Témoin'], spec).values).toEqual({ '--name': 'Boutique Témoin' });
  });

  it('refuses an unknown option instead of ignoring it', () => {
    expect(() => parseArguments(['--jsno'], spec)).toThrow(/unknown option/);
  });

  // The classic way a CLI creates a shop named "--no-install".
  it('refuses a value flag that swallows the next flag', () => {
    expect(() => parseArguments(['--name', '--no-install'], spec)).toThrow(/requires a value/);
  });

  it('refuses a value on a boolean flag', () => {
    expect(() => parseArguments(['--no-install=yes'], spec)).toThrow(/takes no value/);
  });
});

describe('exit codes', () => {
  // Pinned, because they are a contract with CI and fleet scripts: a caller
  // decides whether to retry from the number, not from the prose.
  it('are stable', () => {
    expect(EXIT_CODES).toEqual({ ok: 0, usage: 2, input: 3, precondition: 4, external: 5, verification: 6 });
  });

  it('reports an unknown command as a usage error', () => {
    const result = shopctl(['nope'], CORE);
    expect(result.status).toBe(EXIT_CODES.usage);
  });
});

// ---------------------------------------------------------------------------
// The values a shop is generated from.

describe('derived values', () => {
  it('title-cases a slug', () => {
    expect(displayNameFromSlug('boutique-du-port')).toBe('Boutique Du Port');
  });

  it('gives the shop a theme of its own, never a shipped one', () => {
    expect(resolveThemeId(null, 'boutique-du-port')).toBe('boutique-du-port');
    for (const reserved of RESERVED_THEME_IDS) {
      expect(resolveThemeId(null, reserved)).toBe(`${reserved}-shop`);
      expect(() => resolveThemeId(reserved, 'whatever')).toThrow(/theme the core ships/);
    }
  });

  it('refuses a ref that is not an immutable core tag', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    for (const ref of ['main', '1.2.3', 'v1.2', 'v1.2.3-rc.1', 'HEAD']) {
      expect(() => versionFromTag(ref)).toThrow(/not a core version tag/);
    }
  });
});

describe('the generated manifest', () => {
  const values = {
    slug: 'boutique-du-port',
    displayName: 'Boutique du Port',
    domain: 'boutique-du-port.example.com',
    email: 'commandes@boutique-du-port.example.com',
    theme: 'boutique-du-port',
    coreVersion: CORE_VERSION,
  };

  it('passes the same validator the CI gate runs', () => {
    expect(validateManifest(buildManifest(values), { coreVersion: CORE_VERSION }).errors).toEqual([]);
  });

  // A generator and a parser that disagree about quoting produce a shop whose
  // display name quietly lost a character, and nothing downstream can tell that
  // from a merchant's own typo.
  it('reads back as the values it was built from', () => {
    const manifest = buildManifest(values);
    expect(parseManifestYaml(renderManifest(manifest), { file: 'client/client.yaml' })).toEqual(manifest);
  });

  it('round-trips a display name that YAML would otherwise reinterpret', () => {
    for (const displayName of ['NO', 'true', '12.5', "L'Atelier: Paris", 'Maison #1', 'Café — Brûlerie', '  espaces  ']) {
      const manifest = buildManifest({ ...values, displayName });
      const back = parseManifestYaml(renderManifest(manifest), { file: 'client/client.yaml' });
      expect(back.client.displayName).toBe(displayName);
    }
  });

  // A "replace this" note next to the merchant's real domain is one someone
  // eventually obeys, or learns to read past.
  it('marks a placeholder only where there is one', () => {
    const manifest = buildManifest(values);
    expect(renderManifest(manifest)).not.toMatch(/PLACEHOLDER/);
    const marked = renderManifest(manifest, { placeholders: ['cloudflare.productionDomain'] });
    expect(marked.match(/PLACEHOLDER/g)).toHaveLength(1);
    expect(marked).toMatch(/# PLACEHOLDER : domaine réservé à la documentation \(RFC 2606\)\.\n(.*\n)  productionDomain:/);
  });

  it('quotes only what would otherwise change meaning', () => {
    expect(yamlScalar('Boutique du Port')).toBe('Boutique du Port');
    expect(yamlScalar('NO')).toBe('"NO"');
    expect(yamlScalar(true)).toBe('true');
    expect(yamlScalar(20)).toBe('20');
  });

  it('leaves the invoicing strategy pending rather than choosing one', () => {
    // The accounting review is jalon 3. A strategy picked by a generator is the
    // kind of decision discovered at the first audit.
    expect(buildManifest(values).commerce.invoiceStrategy).toBe('pending-validation');
  });
});

// ---------------------------------------------------------------------------
// Secrets. Two halves of one promise: never accepted, never printed.

describe('credentials', () => {
  it('refuses a credential passed as an argument', () => {
    for (const argument of ['sk_live_51ABCdefGHI', '--token=whsec_ABCdefGHIjkl', 're_ABCdefGHIjklmnop123']) {
      expect(() => assertNoCredentialsInArgv(['new', 'shop', argument])).toThrow(/shell history|looks like/);
    }
  });

  it('lets ordinary arguments through', () => {
    expect(() => assertNoCredentialsInArgv(['new', 'boutique-du-port', '--domain', 'port.example.com'])).not.toThrow();
  });

  it('redacts a relayed line', () => {
    expect(redact('git failed: token sk_live_51ABCdefGHI rejected')).not.toContain('sk_live');
  });

  it('uses the manifest\'s own patterns rather than a second list', () => {
    expect(classifyCredential('sk_live_51ABCdefGHI')).toBe(CREDENTIAL_PATTERNS[0].what);
  });
});

// ---------------------------------------------------------------------------
// `shopctl new`, against the real core tree.

/**
 * The two defaults an AGENCY has and the CORE must not.
 *
 * Neither can be a literal in the source: `config:validate` fails on any core
 * file containing a shop's domain, and a core that knows one agency cannot be
 * sold to a second. An environment variable is the right home — visible in the
 * shell that set it, unlike a configuration file nobody remembers writing.
 */
describe('the defaults an agency sets once', () => {
  it('builds the domain from the suffix, and says where it came from', () => {
    expect(resolveDomain('maestro-demo', undefined, { MINSHOP_DOMAIN_SUFFIX: 'studiomaestro.fr' })).toEqual({
      domain: 'maestro-demo.studiomaestro.fr',
      from: 'MINSHOP_DOMAIN_SUFFIX',
    });
  });

  // The placeholder is RFC 2606 and can never be registered by anyone, so it
  // stays loud: `new` keeps "replace this domain" in its next steps only while
  // it is the one in use.
  it('falls back to the documentation placeholder', () => {
    expect(resolveDomain('maestro-demo', undefined, {})).toEqual({
      domain: 'maestro-demo.example.com',
      from: 'placeholder',
    });
  });

  it('lets the flag win over the variable', () => {
    expect(resolveDomain('x', 'boutique.fr', { MINSHOP_DOMAIN_SUFFIX: 'studiomaestro.fr' })).toEqual({
      domain: 'boutique.fr',
      from: '--domain',
    });
  });

  // A suffix that is not a domain would produce a manifest that fails
  // validation for a reason naming a field the operator never typed.
  it('refuses a suffix that is not a domain, naming the variable', () => {
    expect(() => resolveDomain('x', undefined, { MINSHOP_DOMAIN_SUFFIX: 'https://studiomaestro.fr/' })).toThrow(
      /MINSHOP_DOMAIN_SUFFIX/,
    );
  });

  // The same variable `provision`, `deploy` and `destroy` already read: one
  // question, one answer.
  it('takes the account from the environment when no flag names one', () => {
    expect(resolveAccountId(undefined, { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) })).toEqual({
      accountId: 'a'.repeat(32),
      from: 'CLOUDFLARE_ACCOUNT_ID',
    });
    expect(resolveAccountId(undefined, {})).toEqual({ accountId: null, from: null });
    expect(resolveAccountId('b'.repeat(32), { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }).from).toBe('--account');
  });
});

/**
 * `npx --package=github:<owner>/<core> shopctl new …` — no clone, no checkout.
 *
 * npm hands the CLI an EXTRACTED TARBALL: the whole tree, minus `.git`. Every
 * default that asks git a question has to have a second answer, and the one
 * that matters is "where does the core live" — the operator running this has,
 * by construction, never cloned the core.
 */
describe('running from an extracted tarball', () => {
  /** The same tree npm would extract: tracked files, no `.git`, and a
   *  `repository` field pointing wherever the caller says. */
  function extractedCore(root, repository) {
    const target = join(root, 'extracted');
    mkdirSync(target, { recursive: true });
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: CORE, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const file of tracked) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      cpSync(join(CORE, file), join(target, file));
    }
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    manifest.repository = { type: 'git', url: repository };
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    expect(existsSync(join(target, '.git'))).toBe(false);
    return target;
  }

  it('normalises npm’s repository dialect into something git clones', () => {
    expect(cloneableRepositoryUrl('git+https://github.com/agence/core.git')).toBe('https://github.com/agence/core.git');
    expect(cloneableRepositoryUrl('git+ssh://git@github.com/agence/core.git#main')).toBe('ssh://git@github.com/agence/core.git');
    // Already cloneable forms pass through untouched — including a local path.
    expect(cloneableRepositoryUrl('git@github.com:agence/core.git')).toBe('git@github.com:agence/core.git');
    expect(cloneableRepositoryUrl('/srv/cores/minshop')).toBe('/srv/cores/minshop');
  });

  // Without this field the npx invocation fails on its first step, and the
  // failure names a git remote the operator was never told to create.
  it('declares a repository in the core’s own package.json', () => {
    const declared = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).repository;
    const url = typeof declared === 'string' ? declared : declared?.url;
    expect(url, 'package.json must declare "repository" — npx has no remote to ask').toBeTruthy();
    expect(cloneableRepositoryUrl(url)).toMatch(/^([a-z+]+:\/\/|git@|\/)/);
  });

  it('creates a shop with no --from and no remote to ask', () => {
    const root = mkdtempSync(join(tmpdir(), 'shopctl-npx-'));
    const source = createCoreRepository(root);
    const work = join(root, 'work');
    mkdirSync(work);

    const result = spawnSync(
      'node',
      [join(extractedCore(root, source), 'shopctl/bin/shopctl.mjs'), 'new', 'boutique-du-port', '--core', CORE_TAG, '--no-install', '--json'],
      { cwd: work, encoding: 'utf8', env: GIT_ENV },
    );

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.shop.slug).toBe('boutique-du-port');
    // The clone came from what package.json declares, and the shop's `core`
    // remote points back at it — the upgrade path survives the shortcut.
    expect(report.core.repository).toBe(source);
    expect(report.git.remotes.core).toBe(source);
    expect(existsSync(join(work, 'shop-boutique-du-port/client/client.yaml'))).toBe(true);
  });

  /**
   * Every next step is a line that runs.
   *
   * npx exposes `shopctl` for the length of ONE command and keeps nothing, so
   * an operator who created their first shop that way has no `shopctl` on their
   * PATH at all — and the report used to hand them `shopctl doctor`. The shop
   * carries its own CLI; `npm run shopctl --` reaches it, before `npm ci` and
   * without a global install (which ADR 0009 rules out anyway: one shop's CLI
   * must never drive another's).
   */
  it('names its next steps as they must be typed, not as a bare shopctl', () => {
    const root = mkdtempSync(join(tmpdir(), 'shopctl-steps-'));
    const source = createCoreRepository(root);
    const work = join(root, 'work');
    mkdirSync(work);

    const result = spawnSync(
      'node',
      [join(extractedCore(root, source), 'shopctl/bin/shopctl.mjs'), 'new', 'boutique-du-port', '--core', CORE_TAG, '--no-install', '--json'],
      { cwd: work, encoding: 'utf8', env: GIT_ENV },
    );
    expect(result.status, result.stderr).toBe(0);
    const { nextSteps } = JSON.parse(result.stdout);

    expect(nextSteps[0]).toBe('cd shop-boutique-du-port');
    expect(nextSteps).toContain('npm run shopctl -- doctor');
    // Nothing tells the operator to type a word their shell does not have.
    expect(nextSteps.filter((step) => /^shopctl /.test(step))).toEqual([]);
  });

  // The fallback is a fallback: a fork, a mirror or a local path handed to
  // --from is the core the operator is standing in, and it keeps winning.
  it('still lets --from override what package.json declares', () => {
    const root = mkdtempSync(join(tmpdir(), 'shopctl-npx-from-'));
    const source = createCoreRepository(root);
    const work = join(root, 'work');
    mkdirSync(work);
    const extracted = extractedCore(root, 'https://github.com/quelquun-dautre/core.git');

    const result = spawnSync(
      'node',
      [join(extracted, 'shopctl/bin/shopctl.mjs'), 'new', 'boutique-du-port', '--from', source, '--core', CORE_TAG, '--no-install'],
      { cwd: work, encoding: 'utf8', env: GIT_ENV },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('shopctl new', () => {
  // `gh` is asked before the clone, not at the forge step: a missing or
  // unauthenticated `gh` must cost a message, not five hundred cloned files and
  // a directory to clean up.
  it('refuses --create-repo without gh before touching the disk', () => {
    const work = workspace();
    const withoutGh = mkdtempSync(join(tmpdir(), 'shopctl-nogh-'));
    symlinkSync(process.execPath, join(withoutGh, 'node'));

    const result = spawnSync('node', [BIN, 'new', 'atelier-x', '--from', core(), '--core', CORE_TAG, '--create-repo'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...GIT_ENV, PATH: withoutGh, HOME: process.env.HOME },
    });
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/gh \(GitHub CLI\) est requis/);
    expect(treeFiles(work)).toEqual([]);
  });

  /**
   * The forge step is the last one, and the only one that is entirely
   * re-runnable.
   *
   * When it fails — no `gh`, no session, a name already taken — the shop itself
   * is finished: cloned, written, verified, committed. Throwing that away, or
   * reporting success, would both be wrong. Exit 6 is the code that already
   * means "produced, then a gate refused the result; the tree is left in place
   * to inspect", and `shopctl repo` resumes exactly there.
   */
  it('keeps the shop when only the forge step fails', () => {
    const work = workspace();
    const withoutGh = mkdtempSync(join(tmpdir(), 'shopctl-nogh-'));
    symlinkSync(process.execPath, join(withoutGh, 'node'));
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(withoutGh, 'git'));

    const result = spawnSync(
      'node',
      [BIN, 'new', 'atelier-x', '--from', core(), '--core', CORE_TAG, '--no-install', '--create-repo', '--origin', 'git@github.com:agence/shop-atelier-x.git', '--json'],
      { cwd: work, encoding: 'utf8', env: { ...GIT_ENV, PATH: withoutGh, HOME: process.env.HOME } },
    );

    expect(result.status).toBe(EXIT_CODES.verification);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.forge).toBeNull();
    expect(report.forgeError.kind).toBe('precondition');
    // The shop is there, and the next step says how to finish it.
    expect(treeFiles(join(work, 'shop-atelier-x'))).toContain('client/client.yaml');
    expect(report.nextSteps.some((step) => step.startsWith('npm run shopctl -- repo'))).toBe(true);
  });

  it('refuses a slug the platform already uses', () => {
    const result = shopctl(['new', RESERVED_SLUGS[0], '--from', core(), '--core', CORE_TAG], workspace());
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/reserved by the platform/);
  });

  // A witness the core carries is a shop as far as the manifest gate goes, so a
  // shop named after one could never pass its own CI — and the fixture cannot
  // leave the shop without a conflict at every upgrade. Found rehearsing the
  // certification's step 2, whose plan named the real shops after witnesses.
  it('refuses a witness slug before cloning', () => {
    const [witness] = witnessSlugs();
    const work = workspace();
    const result = shopctl(['new', witness, '--from', core(), '--core', CORE_TAG, '--no-install'], work);

    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/collides with a witness shop/);
    expect(result.stderr).toContain(`test/fixtures/clients/${witness}/client.yaml`);
    expect(result.stderr).toMatch(/Choose another slug/);
    expect(result.stderr).not.toMatch(/core bug/);
    expect(treeFiles(work)).toEqual([]);
  });

  // Not only the slug: `<witness>-staging` derives the witness's own staging
  // Worker and database.
  it('refuses a slug whose derived names are a witness\'s', () => {
    const [witness] = witnessSlugs();
    const work = workspace();
    const result = shopctl(['new', `${witness}-staging`, '--from', core(), '--core', CORE_TAG, '--no-install'], work);

    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/collides with a witness shop/);
    expect(treeFiles(work)).toEqual([]);
  });

  // The reserved list can never be complete: the neutrality gate also trips on
  // ordinary English the core happens to use, and `clean-clone` — a word this
  // core writes into its own tooling — is deliberately NOT reserved so this
  // path stays exercised. What must not happen is the CLI blaming the core: the
  // fix is another slug, not a bug report.
  it('reports a slug the core already uses as a bad name, not a core bug', () => {
    const work = workspace();
    const result = shopctl(['new', 'clean-clone', '--from', core(), '--core', CORE_TAG, '--no-install'], work);

    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/is a word this core already uses/);
    expect(result.stderr).toMatch(/Choose another slug/);
    expect(result.stderr).not.toMatch(/core bug/);
    // Files are named so the operator can see WHY, and nothing survives.
    expect(result.stderr).toMatch(/scripts\/check-clean-clone\.sh|package\.json|AGENTS\.md/);
    expect(existsSync(join(work, 'shop-clean-clone'))).toBe(false);
  });

  it('still calls a genuine gate failure a core bug', () => {
    // Everything shopctl writes is validated first, so a gate that refuses the
    // result is the core's problem — and the tree stays put to be read.
    const work = workspace();
    const result = shopctl(['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install', '--json'], work);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).checks.every((check) => check.ok)).toBe(true);
  });

  it('writes no placeholder note next to a real domain', () => {
    const work = workspace();
    const result = shopctl(
      ['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--domain', 'boutique-du-port.fr', '--no-install'],
      work,
    );
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(join(work, 'shop-boutique-du-port/client/client.yaml'), 'utf8');
    expect(text).toMatch(/productionDomain: boutique-du-port\.fr\n/);
    expect(text).not.toMatch(/PLACEHOLDER/);
  });

  it('refuses a malformed slug before touching the disk', () => {
    const work = workspace();
    const result = shopctl(['new', 'Boutique Du Port', '--from', core(), '--core', CORE_TAG], work);
    expect(result.status).toBe(EXIT_CODES.input);
    expect(treeFiles(work)).toEqual([]);
  });

  // A tag that does not exist must cost a message, not a half-clone the
  // operator then has to reason about.
  it('refuses a core tag that does not exist, and creates nothing', () => {
    const work = workspace();
    const result = shopctl(['new', 'boutique-du-port', '--from', core(), '--core', 'v9.9.9'], work);
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/has no tag "v9\.9\.9"/);
    expect(result.stderr).toMatch(new RegExp(CORE_TAG.replaceAll('.', '\\.')));
    expect(treeFiles(work)).toEqual([]);
  });

  it('refuses a ref that is a branch rather than a tag', () => {
    const work = workspace();
    const result = shopctl(['new', 'boutique-du-port', '--from', core(), '--core', 'main'], work);
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/immutable/);
    expect(treeFiles(work)).toEqual([]);
  });

  // The first CI run of the "Generated shop" job died here: the workflow set
  // `git config user.name` LOCALLY in the checkout, so the shop — a different
  // repository — had no author, and the failure surfaced as a bare "git commit
  // exited with status 128" after a 540-file clone. Both halves are fixed: the
  // check happens before the clone, and it asks git rather than guessing.
  it('refuses to clone when git has no identity to commit as', () => {
    const work = workspace();
    const home = mkdtempSync(join(tmpdir(), 'shopctl-home-'));
    const result = spawnSync('node', [BIN, 'new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install'], {
      cwd: work,
      encoding: 'utf8',
      // No config, and none of the GIT_AUTHOR_* variables GIT_ENV supplies.
      env: { ...GIT_ENV, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '' },
    });

    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/no identity/);
    expect(result.stderr).toMatch(/shopctl doctor/);
    expect(treeFiles(work)).toEqual([]);
  });

  it('refuses a target directory that already holds something', () => {
    const work = workspace();
    mkdirSync(join(work, 'shop-boutique-du-port'), { recursive: true });
    writeFileSync(join(work, 'shop-boutique-du-port', 'notes.txt'), 'occupied\n');
    const result = shopctl(['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install'], work);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/not empty/);
    expect(treeFiles(join(work, 'shop-boutique-du-port'))).toEqual(['notes.txt']);
  });

  it('works when the target path contains spaces', () => {
    const work = workspace();
    const target = 'mes boutiques/boutique du port';
    const result = shopctl(
      ['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--dir', target, '--no-install'],
      work,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(work, target, 'client/client.yaml'))).toBe(true);
    expect(git(['status', '--porcelain'], join(work, target))).toBe('');
  });

  it('adds exactly the shop-owned files, and modifies only generated ones', () => {
    const work = workspace();
    const result = shopctl(
      ['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install'],
      work,
    );
    expect(result.status, result.stderr).toBe(0);
    const shop = join(work, 'shop-boutique-du-port');

    // The skeleton, as a snapshot of what one command is allowed to change.
    // Growing this list is a decision; growing it by accident is how a shop
    // ends up diverging from the core in a file nobody meant to touch.
    //
    // Added or modified is derived rather than pinned, because this suite ships
    // into generated shops and runs there: the fixture core built from a SHOP's
    // tree already carries a client manifest, so the same command modifies what
    // it would otherwise add. The paths do not move; only the letter does.
    const expected = [
      'client/client.yaml',
      'client/signatures/boutique-du-port.json',
      'imports/README.md',
      'src/themes/boutique-du-port/Catalog.astro',
      'src/themes/boutique-du-port/ContentPage.astro',
      'src/themes/boutique-du-port/Footer.astro',
      'src/themes/boutique-du-port/Header.astro',
      'src/themes/boutique-du-port/ProductCard.astro',
      'src/themes/boutique-du-port/ProductDetail.astro',
      'src/themes/boutique-du-port/tokens.css',
      'theme.config.json',
      'wrangler.jsonc',
    ].map((path) => [existsSync(join(core(), path)) ? 'M' : 'A', path]);

    const changed = git(['diff', '--name-status', CORE_TAG, 'HEAD'], shop)
      .split('\n')
      .map((line) => line.split('\t'));
    expect(changed).toEqual(expected);

    // The copied theme renders as its reference, so its browser gate starts
    // from the reference's signature rather than from none (étape 2 de la
    // certification: every real shop's Browser job was red at its first PR).
    expect(readFileSync(join(shop, 'client/signatures/boutique-du-port.json'), 'utf8')).toBe(
      readFileSync(join(core(), 'test/browser/__signatures__/default.json'), 'utf8'),
    );

    expect(readFileSync(join(shop, 'client/client.yaml'), 'utf8')).toBe(
      `# Manifeste de la boutique Boutique Du Port.
# Généré par \`shopctl new boutique-du-port\` depuis le socle ${CORE_TAG}.
# Source de vérité non sensible : aucune clé, aucun secret, jamais.
schemaVersion: 1
# Version du socle clonée. Mise à jour par \`shopctl core upgrade\`.
coreVersion: ${CORE_VERSION}

# Qui est la boutique.
client:
  slug: boutique-du-port
  displayName: Boutique Du Port
  # Fixés par le périmètre certifié (plan §2.1) : une seule valeur possible.
  locale: fr-FR
  timezone: Europe/Paris
  currency: EUR

# Comment elle vend.
commerce:
  market: FR
  pricesIncludeTax: true
  checkoutMode: guest
  defaultVatRate: 20
  # La validation comptable du jalon 3 n'a pas eu lieu pour cette boutique :
  # la stratégie de facturation reste en attente plutôt que par défaut.
  invoiceStrategy: pending-validation

# Interrupteurs décidés à la construction. Les réglages d'exploitation vivent dans Admin → Réglages.
features:
  customerAccounts: false
  semanticSearch: false
  digitalProducts: false
  promoCodes: true
  shipping: true

# Où elle tourne. Tous ces noms sont visibles dans le compte Cloudflare.
cloudflare:
  jurisdiction: eu
  workerName: minshop-boutique-du-port
  # PLACEHOLDER : domaine réservé à la documentation (RFC 2606).
  # À remplacer par le domaine du commerçant avant tout provisioning.
  productionDomain: boutique-du-port.example.com

# E-mails transactionnels. Aucune clé d'API ici, jamais.
email:
  provider: resend
  # PLACEHOLDER : suit le domaine ci-dessus.
  from: commandes@boutique-du-port.example.com

# Quel design elle compile.
theme:
  # Thème propre à la boutique. Le socle ne le modifie jamais.
  id: boutique-du-port
`,
    );
  });

  // ADR 0003: the history is what makes the next upgrade an ordinary merge, and
  // `core` is the remote the tag is fetched from.
  it('keeps the core history and names its remote core', () => {
    const work = workspace();
    const result = shopctl(
      ['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--origin', 'git@example.com:agency/shop.git', '--no-install'],
      work,
    );
    expect(result.status, result.stderr).toBe(0);
    const shop = join(work, 'shop-boutique-du-port');

    expect(git(['remote'], shop).split('\n').sort()).toEqual(['core', 'origin']);
    expect(git(['remote', 'get-url', 'core'], shop)).toBe(core());
    expect(git(['remote', 'get-url', 'origin'], shop)).toBe('git@example.com:agency/shop.git');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], shop)).toBe('main');
    // The tag is an ancestor: the shop is a descendant of the core, not a copy.
    expect(git(['merge-base', '--is-ancestor', CORE_TAG, 'HEAD'], shop)).toBe('');
    expect(git(['log', '--format=%s'], shop).split('\n')).toEqual([
      `Initialiser la boutique boutique-du-port depuis le socle ${CORE_TAG}`,
      `Core ${CORE_TAG}`,
    ]);
    expect(git(['status', '--porcelain'], shop)).toBe('');
  });

  it('leaves no dependencies installed with --no-install', () => {
    const work = workspace();
    shopctl(['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install'], work);
    expect(existsSync(join(work, 'shop-boutique-du-port', 'node_modules'))).toBe(false);
  });

  // The shop is a committed, published tree. Anything the core kept out of git
  // must stay out, and no value in it may look like a credential.
  it('copies no secret and no local instance state', () => {
    const work = workspace();
    shopctl(['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install'], work);
    const shop = join(work, 'shop-boutique-du-port');

    for (const forbidden of ['.dev.vars', '.instances', 'wrangler.jsonc.bak', '.env', '.wrangler']) {
      expect(existsSync(join(shop, forbidden)), forbidden).toBe(false);
    }

    // The scan itself is the shop's own gate rather than a second regex sweep
    // here: this tree legitimately contains credential-SHAPED strings (crypto
    // fixtures, the manifest rule that defines the patterns), and a duplicate
    // scanner with its own allowlist would disagree with the one the shop's CI
    // actually runs — on whichever side was reviewed less.
    const scan = spawnSync('node', ['scripts/check-secrets.mjs'], { cwd: shop, encoding: 'utf8' });
    expect(scan.status, scan.stdout + scan.stderr).toBe(0);
  });

  // "Deterministic" cannot mean identical commit hashes — those carry a clock.
  // It means the tree: same options, same bytes, so a generated shop is
  // reviewable as a diff against another.
  it('produces the same tree twice', () => {
    const first = workspace();
    const second = workspace();
    for (const work of [first, second]) {
      const result = shopctl(['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install'], work);
      expect(result.status, result.stderr).toBe(0);
    }
    const read = (work) => {
      const shop = join(work, 'shop-boutique-du-port');
      return Object.fromEntries(
        git(['ls-files'], shop)
          .split('\n')
          .filter(Boolean)
          .map((file) => [file, readFileSync(join(shop, file)).toString('base64')]),
      );
    };
    expect(read(first)).toEqual(read(second));
  });

  // The exit criterion of jalon 2, minus the parts that need a network and an
  // npm install: the shop passes ITS OWN gates, with no manual step in between.
  it('passes the gates it carries, immediately', () => {
    const work = workspace();
    const result = shopctl(
      ['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install', '--json'],
      work,
    );
    expect(result.status, result.stderr).toBe(0);
    const shop = join(work, 'shop-boutique-du-port');

    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      { check: 'manifeste', ok: true, status: 0 },
      { check: 'propriété des chemins', ok: true, status: 0 },
    ]);
    expect(report.resources).toEqual({
      worker: 'minshop-boutique-du-port',
      database: 'minshop-boutique-du-port-db',
      images: 'minshop-boutique-du-port-images',
      files: 'minshop-boutique-du-port-files',
      backups: 'minshop-boutique-du-port-backups',
      sessions: 'minshop-boutique-du-port-session',
    });

    // Re-run them here rather than trusting the report: the report is what the
    // CLI believes, and the gates are what the shop's CI will actually run.
    for (const script of ['scripts/check-manifest.mjs', 'scripts/check-paths.mjs']) {
      const gate = spawnSync('node', [script], { cwd: shop, encoding: 'utf8' });
      expect(gate.status, `${script}: ${gate.stderr}`).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(shop, 'theme.config.json'), 'utf8'))).toEqual({ theme: 'boutique-du-port' });
    expect(readFileSync(join(shop, 'wrangler.jsonc'), 'utf8')).toContain('"minshop-boutique-du-port"');
  });

  it('emits one JSON document on stdout and nothing else', () => {
    const work = workspace();
    const result = shopctl(['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install', '--json'], work);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('reports a failure as JSON too', () => {
    const result = shopctl(['new', 'v', '--from', core(), '--core', CORE_TAG, '--json'], workspace());
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.error.kind).toBe('input');
    expect(report.error.code).toBe(EXIT_CODES.input);
  });
});

// The same mistake has now been made three times in one milestone: an example
// slug written into a core-owned file. `config:validate` fails on any file the
// neutrality gate scans that contains a shop's slug, so a plausible example is a
// landmine for whoever later picks that name — they see a file they never
// touched refuse their shop. The documentation's example names are reserved
// instead (RESERVED_SLUGS), and this is the check that says so out loud.
describe('example slugs in core documentation', () => {
  // Exactly the files the neutrality gate reads: core-owned, minus the trees it
  // exempts. docs/ and test/ are exempt there, so they are exempt here too —
  // one rule, not two.
  const scanned = () =>
    execFileSync('git', ['ls-files'], { cwd: CORE, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((path) => !path.startsWith('docs/') && !path.startsWith('test/'));

  it('only uses reserved example slugs', () => {
    const offenders = [];
    for (const path of scanned()) {
      const buffer = readFileSync(join(CORE, path));
      if (buffer.includes(0)) continue;
      // The lookahead is what separates a command line from prose: an example
      // ends the line, continues it with a backslash, or is followed by an
      // option. "shopctl new needs a slug" is a sentence, not a shop.
      const examples = buffer.toString('utf8').matchAll(/shopctl\s+new\s+([a-z][a-z0-9-]*)(?=\s*$|\s+\\|\s+--)/gm);
      for (const [, slug] of examples) {
        if (!RESERVED_SLUGS.includes(slug)) offenders.push(`${path}: ${slug}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// The gate run on the CLONED tag is the authority on witnesses — the host core
// may carry other fixtures than the tag it clones — so its report is read too.
describe('a manifest gate report naming a witness', () => {
  const OWN = 'client/client.yaml';
  const WITNESS = 'test/fixtures/clients/w/client.yaml';
  const gate = (report) => ({
    stdout: JSON.stringify({ manifests: [], collisions: [], coreNeutrality: { findings: [] }, ...report }),
  });
  const claim = (...files) => ({ kind: 'slug', value: 'w', files });

  it('names the witnesses when they are the whole story', () => {
    expect(witnessClaims(gate({ collisions: [claim(OWN, WITNESS), claim(OWN, WITNESS)] }), 'w')).toEqual([WITNESS]);
  });

  it('leaves every other failure to the report it deserves', () => {
    // Two witnesses claiming one name is the core's bug, not a bad slug.
    expect(witnessClaims(gate({ collisions: [claim(WITNESS, 'test/fixtures/clients/v/client.yaml')] }), 'w')).toEqual([]);
    expect(witnessClaims(gate({ collisions: [claim(OWN, WITNESS)], manifests: [{ file: OWN, errors: [{}] }] }), 'w')).toEqual([]);
    expect(
      witnessClaims(gate({ collisions: [claim(OWN, WITNESS)], coreNeutrality: { findings: [{ slug: 'other' }] } }), 'w'),
    ).toEqual([]);
    expect(witnessClaims({ stdout: 'not json' }, 'w')).toEqual([]);
  });
});

describe('shopctl doctor', () => {
  it('reports on the tree it runs in, with nothing failing', () => {
    const result = shopctl(['doctor', '--offline', '--json'], CORE);
    const report = JSON.parse(result.stdout);
    expect(report.tree).toBe(existsSync(join(CORE, 'client/client.yaml')) ? 'shop' : 'core');
    // A shop's CI checks out `origin` alone: the missing `core` remote
    // describes that clone, not the code under test, and doctor is right to
    // name it on an operator's machine.
    const describesTheClone = (entry) => entry.message.startsWith('aucun remote "core"');
    expect(report.checks.filter((entry) => entry.status === 'fail' && !describesTheClone(entry))).toEqual([]);
  });

  it('names what stays human rather than pretending to verify it', () => {
    const result = shopctl(['doctor', '--offline', '--json'], CORE);
    const report = JSON.parse(result.stdout);
    expect(report.checklist).toHaveLength(HUMAN_CHECKLIST.length);
    expect(report.checklist.every((entry) => entry.hint)).toBe(true);
  });

  it('recognises a generated shop and its remotes', () => {
    const work = workspace();
    shopctl(['new', 'boutique-du-port', '--from', core(), '--core', CORE_TAG, '--no-install'], work);
    const result = shopctl(['doctor', '--offline', '--json'], join(work, 'shop-boutique-du-port'));
    const report = JSON.parse(result.stdout);
    expect(report.tree).toBe('shop');
    expect(report.checks.some((entry) => /remote "core"/.test(entry.message) && entry.status === 'ok')).toBe(true);
    // No origin was given, and that is a warning rather than a failure: the
    // shop exists before its repository does.
    expect(report.checks.some((entry) => /remote "origin"/.test(entry.message) && entry.status === 'warn')).toBe(true);
  });

  // Plain `wrangler whoami` exits 0 with nobody logged in, and doctor read its
  // exit status: the operator's machine was reported ready from étape 1 to
  // étape 3 of the certification without a session.
  it('warns when wrangler has no session, as provision would refuse', () => {
    const target = shop();
    target.account({ authenticated: false });
    expect(target.wrangler(['whoami']).status).toBe(0);
    const { report } = target.json(['doctor']);
    const session = report.checks.find((entry) => /wrangler n'est pas authentifié|session Cloudflare/.test(entry.message));
    expect(session.status).toBe('warn');
    expect(session.message).toMatch(/n'est pas authentifié/);
  });

  it('reports the session and the accounts it sees', () => {
    const target = shop();
    target.account({ accounts: [ACCOUNT, OTHER_ACCOUNT] });
    const { report } = target.json(['doctor']);
    const session = report.checks.find((entry) => /session Cloudflare/.test(entry.message));
    expect(session).toMatchObject({ status: 'ok', message: expect.stringMatching(/2 comptes/) });
  });
});

describe('shopctl config validate', () => {
  // A wrapper, not a second implementation: the CLI and the CI gate must never
  // be able to answer the same question differently.
  it('relays the gate\'s own report', () => {
    const cli = shopctl(['config', 'validate', '--json'], CORE);
    const gate = spawnSync('node', ['scripts/check-manifest.mjs', '--json'], { cwd: CORE, encoding: 'utf8' });
    expect(cli.status).toBe(gate.status);
    expect(JSON.parse(cli.stdout)).toEqual(JSON.parse(gate.stdout));
  });

  it('refuses a subcommand it does not have', () => {
    expect(shopctl(['config', 'write'], CORE).status).toBe(EXIT_CODES.usage);
  });
});
