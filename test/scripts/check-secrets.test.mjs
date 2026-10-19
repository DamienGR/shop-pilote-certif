import { describe, expect, it } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-secrets.mjs');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Minshop Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'Minshop Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

// Assembled, so that this file is not itself the finding.
const KEY = ['sk', 'live', 'Zq8Lm3Rt7Vx2Nc5Bk9Wd4Hs6'].join('_');

/** A repository whose scanner is this one: the script reads the tree it sits in. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'minshop-secrets-'));
  mkdirSync(join(root, 'scripts'));
  cpSync(SCRIPT, join(root, 'scripts/check-secrets.mjs'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'scanner');
  const scan = (...flags) => spawnSync('node', ['scripts/check-secrets.mjs', ...flags], { cwd: root, encoding: 'utf8' });
  return { root, git, scan, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe('check-secrets --history', () => {
  // The case the flag exists for: a key committed, then deleted. The tree is
  // clean; every clone made since still carries it.
  it('finds a key the tree no longer has, and names its blob', () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.root, 'config.js'), `export const stripe = '${KEY}';\n`);
      repo.git('add', 'config.js');
      repo.git('commit', '-qm', 'leak');
      repo.git('rm', '-q', 'config.js');
      repo.git('commit', '-qm', 'clean');

      expect(repo.scan().status).toBe(0);
      const history = repo.scan('--history');
      expect(history.status).toBe(1);
      expect(history.stderr).toMatch(/config\.js \(history, blob [0-9a-f]{10}\):1 {2}Stripe secret key/);
      expect(history.stderr).not.toContain(KEY);
    } finally {
      repo.dispose();
    }
  });

  it('holds a file that must never be tracked to the same rule in the past', () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.root, '.dev.vars'), 'AUTH_SECRET=short\n');
      repo.git('add', '-f', '.dev.vars');
      repo.git('commit', '-qm', 'oops');
      repo.git('rm', '-q', '--cached', '.dev.vars');
      repo.git('commit', '-qm', 'untrack');

      const history = repo.scan('--history');
      expect(history.status).toBe(1);
      expect(history.stderr).toContain('.dev.vars (history)  once-tracked file (local Worker secrets)');
    } finally {
      repo.dispose();
    }
  });

  // The certification of v0.3.4 found its own history red on a test's Access
  // assertion signed "sig": no algorithm signs in three bytes.
  it('finds a signed token, not a stand-in one', () => {
    const repo = repository();
    const token = (signature) => ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJvcGVyYXRvciJ9', signature].join('.');
    try {
      writeFileSync(join(repo.root, 'fixture.js'), `export const assertion = '${token('c2ln')}';\n`);
      repo.git('add', 'fixture.js');
      repo.git('commit', '-qm', 'stand-in');
      expect(repo.scan('--history').status).toBe(0);

      writeFileSync(join(repo.root, 'fixture.js'), `export const assertion = '${token('Q'.repeat(43))}';\n`);
      repo.git('commit', '-qam', 'signed');
      repo.git('rm', '-q', 'fixture.js');
      repo.git('commit', '-qm', 'gone');
      const history = repo.scan('--history');
      expect(history.status).toBe(1);
      expect(history.stderr).toMatch(/fixture\.js \(history, blob [0-9a-f]{10}\):1 {2}JSON Web Token/);
    } finally {
      repo.dispose();
    }
  });

  it('passes a history with nothing in it, and says how much it read', () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.root, 'notes.md'), 'nothing to see\n');
      repo.git('add', 'notes.md');
      repo.git('commit', '-qm', 'notes');
      repo.git('rm', '-q', 'notes.md');
      repo.git('commit', '-qm', 'gone');

      const history = repo.scan('--history');
      expect(history.status, history.stderr).toBe(0);
      expect(history.stdout).toMatch(/\+ 1 blobs of history \(3 commits, 1 refs\)/);
    } finally {
      repo.dispose();
    }
  });

  // A shallow clone has no past to read: scanning it would pass on exactly the
  // commits it does not hold.
  it('refuses a shallow clone rather than passing on it', () => {
    const repo = repository();
    const clone = mkdtempSync(join(tmpdir(), 'minshop-secrets-shallow-'));
    try {
      repo.git('commit', '-q', '--allow-empty', '-m', 'second');
      const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${repo.root}`, clone], { encoding: 'utf8' });
      expect(cloned.status, cloned.stderr).toBe(0);
      const scan = spawnSync('node', ['scripts/check-secrets.mjs', '--history'], { cwd: clone, encoding: 'utf8' });
      expect(scan.status).toBe(1);
      expect(scan.stderr).toMatch(/shallow/);
    } finally {
      repo.dispose();
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe('check-secrets', () => {
  // Lighthouse copies --extra-headers into every report it writes, JSON and
  // HTML: the certification's étape 6 found the preview's service token in all
  // eight of its reports, about to be committed as evidence to a public repo.
  it('finds an Access service token in a Lighthouse report, not its masked form', () => {
    const repo = repository();
    const report = (secret) =>
      `{\n  "configSettings": {\n    "extraHeaders": {\n      "cf-access-client-id": "${'0'.repeat(32)}.access",\n      "cf-access-client-secret": "${secret}"\n    }\n  }\n}\n`;
    try {
      writeFileSync(join(repo.root, 'lighthouse.report.json'), report('<masqué>'));
      repo.git('add', 'lighthouse.report.json');
      repo.git('commit', '-qm', 'masked');
      expect(repo.scan().status).toBe(0);

      writeFileSync(join(repo.root, 'lighthouse.report.json'), report('3f9a'.repeat(16)));
      const scan = repo.scan();
      expect(scan.status).toBe(1);
      expect(scan.stderr).toMatch(/lighthouse\.report\.json:5 {2}Cloudflare Access service token/);
    } finally {
      repo.dispose();
    }
  });
});
