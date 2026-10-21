import { describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { MIN_PASSWORD_LENGTH, PASSWORD_SETTING } from '../../shopctl/src/commands/admin.mjs';
import { verifyPassword } from '../../src/features/auth/password.ts';
import { names, shop } from '../helpers/provisioned-shop.mjs';

// Each run spawns shopctl, wrangler several times, and a Node that hashes.
vi.setConfig({ testTimeout: 60_000 });

const CORE = new URL('../../', import.meta.url).pathname;
const PASSWORD = 'un mot de passe solide';

/**
 * A production provisioned on the imaginary account, with the real schema and
 * the Worker's own password module — the one `admin password` hashes with, as
 * a shop tree carries it.
 */
function provisioned() {
  const target = shop({ migrations: true });
  const module = 'src/features/auth/password.ts';
  mkdirSync(dirname(join(target.root, module)), { recursive: true });
  cpSync(join(CORE, module), join(target.root, module));
  const result = target.run(['provision', '--env', 'production']);
  expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
  return target;
}

const stored = (target) =>
  target.query(`SELECT value FROM settings WHERE key = '${PASSWORD_SETTING}'`).map((row) => row.value);

describe('shopctl admin password', () => {
  // The two minimums are one rule: a password set here that the wizard would
  // refuse is one the merchant cannot set again the same way.
  it('holds the wizard’s own minimum length', () => {
    const wizard = readFileSync(join(CORE, 'src/pages/admin/setup.astro'), 'utf8');
    expect(Number(wizard.match(/const MIN_PW = (\d+);/)?.[1])).toBe(MIN_PASSWORD_LENGTH);
  });

  it('writes a hash the Worker’s login accepts, and replaces it on a second run', async () => {
    const target = provisioned();
    const first = target.json(['admin', 'password', '--env', 'production'], {}, `${PASSWORD}\n`);
    expect(first.status, first.stderr).toBe(EXIT_CODES.ok);
    expect(first.report).toMatchObject({ command: 'admin password', env: 'production', action: 'set', setupComplete: false });
    expect(first.report.database).toBe(names(target.slug, 'production').database);

    const [hash] = stored(target);
    // The trailing newline of a file or an `echo` is not part of the password.
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}\n`, hash)).toBe(false);

    const second = target.json(['admin', 'password', '--env', 'production'], {}, 'un autre mot de passe');
    expect(second.report.action).toBe('replace');
    expect(stored(target)).toHaveLength(1);
    expect(await verifyPassword('un autre mot de passe', stored(target)[0])).toBe(true);
  });

  // shopctl refuses credentials on the command line; this is the command whose
  // whole input is one. Neither the password nor its hash reaches an argument
  // vector or the terminal — the hash is offline-guessable.
  it('never lets the password or its hash reach an argument or the output', () => {
    const target = provisioned();
    const result = target.run(['admin', 'password', '--env', 'production'], {}, PASSWORD);
    expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
    const [hash] = stored(target);
    for (const { argv } of target.read().calls) {
      expect(argv.join(' ')).not.toContain(PASSWORD);
      expect(argv.join(' ')).not.toContain(hash);
    }
    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
    expect(`${result.stdout}${result.stderr}`).not.toContain(hash);
  });

  it('says the wizard now opens only after a login, while the shop is not installed', () => {
    const target = provisioned();
    const result = target.run(['admin', 'password', '--env', 'production'], {}, PASSWORD);
    expect(result.stdout).toMatch(/ne s'ouvre plus qu'après connexion/);
  });

  it('refuses a password shorter than the wizard’s minimum, before touching the account', () => {
    const target = provisioned();
    const before = target.read().calls.length;
    const result = target.run(['admin', 'password', '--env', 'production'], {}, 'court');
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/il en faut 8 au moins/);
    expect(target.read().calls.length).toBe(before);
  });

  it('refuses an empty standard input rather than set an empty password', () => {
    const target = provisioned();
    const result = target.run(['admin', 'password', '--env', 'production'], {}, '');
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/Jamais en argument/);
    expect(stored(target)).toEqual([]);
  });

  it('writes nothing under --dry-run', () => {
    const target = provisioned();
    const { report, status } = target.json(['admin', 'password', '--env', 'production', '--dry-run'], {}, PASSWORD);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.dryRun).toBe(true);
    expect(stored(target)).toEqual([]);
  });

  it('refuses to run without --env, or without a subcommand it knows', () => {
    const target = provisioned();
    expect(target.run(['admin', 'password'], {}, PASSWORD).status).toBe(EXIT_CODES.usage);
    expect(target.run(['admin'], {}, PASSWORD).status).toBe(EXIT_CODES.usage);
    expect(target.run(['admin', 'reset', '--env', 'production'], {}, PASSWORD).status).toBe(EXIT_CODES.usage);
  });

  it('refuses an environment that was never provisioned', () => {
    const target = shop({ migrations: true });
    const result = target.run(['admin', 'password', '--env', 'staging'], {}, PASSWORD);
    expect(result.status).toBe(EXIT_CODES.precondition);
  });
});
