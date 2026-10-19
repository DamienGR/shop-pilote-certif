import { describe, expect, it } from 'vitest';

// Deliberately .mjs, for the same reason test/storefront/boundary.test.mjs is:
// this test spawns a process, and `tsconfig.compilerOptions.types` is pinned to
// the Cloudflare types, so node builtins have no declarations in a .ts test.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Typecheck one fixture in isolation.
 *
 * Explicit flags rather than `--project`: the fixtures live in a directory
 * `tsconfig.json` EXCLUDES (so `astro check` never reports the two that are
 * broken on purpose), and pointing tsc at the project config would exclude them
 * here too. The flags below are the parts of `astro/tsconfigs/strict` that this
 * graph — three dependency-free .ts modules — actually depends on.
 */
async function typecheck(file) {
  try {
    await run('npx', [
      'tsc',
      '--noEmit',
      '--strict',
      '--target', 'es2022',
      '--module', 'esnext',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
      // The repo imports with explicit .ts specifiers so the same modules load
      // under `node --experimental-strip-types` in the integration gate.
      '--allowImportingTsExtensions',
      // Named files on the command line make tsc refuse to run while a
      // tsconfig.json is in reach (TS5112) rather than silently half-applying it.
      '--ignoreConfig',
      file,
    ]);
    return { ok: true, output: '' };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

describe('the typed message catalog', () => {
  it('compiles a complete catalog', async () => {
    const result = await typecheck('test/i18n/violations/valid-catalog.ts');

    expect(result.output).toBe('');
    expect(result.ok).toBe(true);
  }, 60_000);

  it('rejects a catalog that is missing strings', async () => {
    const result = await typecheck('test/i18n/violations/missing-key.ts');

    expect(result.ok).toBe(false);
    // TS2739/TS2740: "is missing the following properties from type
    // 'LocaleCatalog'". A named catalog key proves it is reporting the real gap
    // and not just failing to resolve the import. tsc lists the first few and
    // counts the rest, and which few depends on its own ordering of the type
    // (the Admin fragments came first once they were spread in), so the
    // assertion is on the shape of a key rather than on one key.
    expect(result.output).toContain('missing-key.ts');
    expect(result.output).toMatch(/is missing the following properties from type 'LocaleCatalog': "[a-z]+\.[\w.]+"/);
  }, 60_000);

  it('rejects a call site that invents a key', async () => {
    const result = await typecheck('test/i18n/violations/unknown-key.ts');

    expect(result.ok).toBe(false);
    expect(result.output).toContain('unknown-key.ts');
    expect(result.output).toContain('shell.cart.lien');
  }, 60_000);
});
