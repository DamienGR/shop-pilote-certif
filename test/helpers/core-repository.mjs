/**
 * A core repository, tagged, built from the files THIS tree tracks.
 *
 * Copied from the index rather than mocked, because the properties under test
 * are about the real tree: that the shop `shopctl new` produces passes the real
 * gates, and that the shop `shopctl core upgrade` merges into keeps passing
 * them. A stand-in template would pass while the real one broke.
 *
 * Shared by the creation suite (jalon 2) and the fleet suite (jalon 9), which
 * both need "a core at a tag" and would otherwise keep two copies of the packing
 * subtlety documented below.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CORE = new URL('../../', import.meta.url).pathname;

/**
 * The version THIS tree declares, and the tag the fixture core is published
 * under.
 *
 * Derived, never written down. A literal `v0.1.0` here would have to be edited
 * at every release, and the suites that forgot would build a core whose tag and
 * whose package.json disagree — which is exactly the state the manifest gate
 * refuses, so they would fail on the fixture rather than on what they test.
 * That is not hypothetical: publishing v0.2.0 broke twenty tests this way.
 */
export const CORE_VERSION = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).version;
export const CORE_TAG = `v${CORE_VERSION}`;

/** The version a release after this one would take: the next minor, which is
 *  what `checkCoreCompatibility` reads as a breaking step before 1.0. */
export function nextMinor(version = CORE_VERSION) {
  const [major, minor] = String(version).split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}

/** Git needs an identity to commit, and a test must not depend on the one the
 *  developer happens to have configured. Nor on the operator's account: every
 *  certification sheet exports CLOUDFLARE_ACCOUNT_ID, `shopctl new` takes it as
 *  the shop's default account, and `shopctl deploy` — which runs this suite
 *  through `npm run verify` — failed on the manifest it then wrote. */
export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Minshop Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'Minshop Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_API_TOKEN: '',
};

export function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * @param {string} root directory to create the core in
 * @param {{ tag?: string, dir?: string }} [options]
 * @returns {string} path to the core repository
 */
export function createCoreRepository(root, { tag = CORE_TAG, dir = 'core' } = {}) {
  const core = join(root, dir);
  mkdirSync(core, { recursive: true });
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: CORE, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of tracked) {
    mkdirSync(dirname(join(core, file)), { recursive: true });
    cpSync(join(CORE, file), join(core, file));
  }
  git(['init', '--quiet', '--initial-branch=main'], core);
  git(['add', '-A'], core);
  git(['commit', '--quiet', '-m', `Core ${tag}`], core);
  git(['tag', tag], core);
  // Pack before anyone clones this, and leave no loose object behind.
  //
  // A local `git clone` does not negotiate a pack: it walks the source's
  // `objects/` directory and hardlinks or copies each file it finds. Against
  // ~700 loose objects that is ~700 chances for the file git just listed to be
  // gone by the time it opens it, and the failure is fatal rather than skipped:
  //   fatal: failed to copy file to '…/.git/objects/5f/4d7c…': No such file or
  //   directory
  // — which is the source vanishing, not the destination, because copy_file()
  // reports the destination path whichever end failed to open.
  //
  // It is rare and it is real: the same clone died on CI on this commit's base
  // (`Generated shop`, 2026-09-01) and on the pull request that followed, each
  // time on a different test in this file — whichever one happened to lose the
  // race. It has not reproduced on a developer machine; CI runs git 2.55.
  //
  // Packing first leaves NO loose object for anything to prune later: 752 of
  // them become one packfile and its index, five files in all, written before
  // the clone starts and never rewritten. There is no per-fanout directory left
  // for the clone to create either, and it copies five files instead of 752.
  git(['gc', '--quiet', '--prune=now'], core);
  return core;
}

/**
 * Publish the next core version, the way the release workflow does it.
 *
 * `scripts/check-release.mjs --set` writes the version everywhere it belongs — the
 * package manifest AND the witness fixtures the manifest gate validates against
 * it — because a version bumped in one place only turns every shop that merges
 * it red. That is not a test convenience: it is the whole reason the release
 * gate exists, and using the real script here keeps the suite honest about it.
 *
 * @param {string} core path to the core repository
 * @param {{ version: string, notes?: string, files?: Record<string, string>, message?: string }} options
 * @returns {string} the tag created
 */
export function publishVersion(core, { version, notes, files = {}, message } = {}) {
  spawnSync('node', [resolve(core, 'scripts/check-release.mjs'), '--set', version], { cwd: core, encoding: 'utf8', env: GIT_ENV });
  if (notes !== undefined) writeFileSync(join(core, 'docs/migrations', `v${version}.md`), notes);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(core, file)), { recursive: true });
    writeFileSync(join(core, file), content);
  }
  const tag = `v${version}`;
  git(['add', '-A'], core);
  git(['commit', '--quiet', '-m', message ?? `Core ${tag}`], core);
  git(['tag', tag], core);
  git(['gc', '--quiet', '--prune=now'], core);
  return tag;
}

/** One file of a tree, as text. */
export const readFile = (root, file) => readFileSync(join(root, file), 'utf8');

/** One built core per worker process, copied per test. */
let template = null;

/**
 * A core at the default tag, for a suite that needs one PER TEST.
 *
 * Building it costs about a second — six hundred files copied, committed and
 * packed — and copying the built one costs about thirty milliseconds. A suite
 * that mutates its core in every test (a second tag, a conflicting file) needs
 * a fresh one each time, and paying the second twenty times over is how a suite
 * gets slow enough that people stop running it.
 *
 * The copy includes `.git`, so the clone the shop makes from it is a real clone
 * of a real history, packed exactly as `createCoreRepository` left it.
 */
export function cloneCoreTemplate(root, { dir = 'core' } = {}) {
  if (!template) {
    template = createCoreRepository(mkdtempSync(join(tmpdir(), 'shopctl-core-template-')));
  }
  const core = join(root, dir);
  cpSync(template, core, { recursive: true });
  return core;
}
