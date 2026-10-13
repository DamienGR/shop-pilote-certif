import { describe, expect, it } from 'vitest';

// .mjs for the same reason as its neighbours: tsconfig pins `types` to the
// Cloudflare types, so node builtins have no declarations in a .ts file here.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CORE_OWNERS,
  OWNERSHIP_RULES,
  classifyPath,
  classifyPaths,
  coreChangeGate,
  matchGlob,
  renderCodeowners,
} from '../../scripts/path-ownership.mjs';
import { RESERVED_THEME_IDS } from '../../scripts/themes.mjs';

const root = new URL('../../', import.meta.url).pathname;
const tracked = () => execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

describe('glob matching', () => {
  it.each([
    ['src/**', 'src/features/cart/db.ts', true],
    ['src/**', 'src/config.ts', true],
    ['src/**', 'test/config.ts', false],
    ['src/themes/*/**', 'src/themes/acme/Header.astro', true],
    ['src/themes/*/**', 'src/themes/acme/parts/Nav.astro', true],
    // A single star stops at a slash, which is what keeps the root-file rule
    // from swallowing the whole tree.
    ['*', 'README.md', true],
    ['*', 'src/config.ts', false],
    ['schemas/*.schema.json', 'schemas/client-1.schema.json', true],
    ['schemas/*.schema.json', 'schemas/nested/client-1.schema.json', false],
    ['wrangler.jsonc', 'wrangler.jsonc', true],
    ['wrangler.jsonc', 'mcp/wrangler.jsonc', false],
  ])('%s vs %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  it('does not let a dot in a pattern match any character', () => {
    expect(matchGlob('theme.config.json', 'themeXconfig.json')).toBe(false);
  });
});

describe('the ownership map', () => {
  // The map is only useful if it is total. A path no rule covers would be
  // silently absent from the gate below.
  it('classifies every tracked file in this tree', () => {
    const { unclassified } = classifyPaths(tracked());
    expect(unclassified).toEqual([]);
  });

  it.each([
    ['src/features/orders/db.ts', 'core'],
    ['src/config.ts', 'core'],
    ['migrations/0040_x.sql', 'core'],
    ['scripts/deploy.mjs', 'core'],
    ['test/storefront/boundary.test.mjs', 'core'],
    ['.github/workflows/verify.yml', 'core'],
    ['package.json', 'core'],
    ['README.md', 'core'],
    ['client/client.yaml', 'client'],
    ['client/content/about.md', 'client'],
    ['src/store.config.ts', 'client'],
    ['src/styles/overrides.css', 'client'],
    ['theme.config.json', 'client'],
    ['public/favicon.svg', 'client'],
    ['wrangler.jsonc', 'generated'],
    ['schemas/client-1.schema.json', 'generated'],
    ['.github/CODEOWNERS', 'generated'],
  ])('gives %s to the %s', (path, owner) => {
    expect(classifyPath(path).owner).toBe(owner);
  });

  // The one place the first-match order carries meaning: a shipped theme is
  // the agency's, a shop's own theme is the merchant's, and both live under
  // the same directory.
  it.each(RESERVED_THEME_IDS)('keeps the shipped theme %s core', (id) => {
    expect(classifyPath(`src/themes/${id}/Header.astro`).owner).toBe('core');
  });

  it('gives a shop its own theme', () => {
    expect(classifyPath('src/themes/pilot-fr/Header.astro').owner).toBe('client');
    expect(classifyPath('src/themes/pilot-fr/tokens.css').owner).toBe('client');
  });

  it('leaves a new top-level directory unclassified rather than guessing', () => {
    expect(classifyPath('content/pages/about.md')).toBeNull();
  });

  it('explains every rule, since the explanation is what CODEOWNERS carries', () => {
    for (const rule of OWNERSHIP_RULES) {
      expect(rule.why, rule.pattern).toMatch(/\S/);
      expect(['core', 'client', 'generated']).toContain(rule.owner);
    }
  });
});

describe('the core-change gate', () => {
  const shop = (paths, approval = null) => coreChangeGate({ paths, isShop: true, approval });

  it('passes a change that stays inside the merchant\'s files', () => {
    const result = shop(['client/client.yaml', 'src/themes/pilot-fr/tokens.css', 'public/favicon.svg']);
    expect(result.ok).toBe(true);
    expect(result.core).toEqual([]);
  });

  it('refuses an unremarked core edit', () => {
    const result = shop(['src/themes/pilot-fr/tokens.css', 'src/features/payments/stripe.ts']);
    expect(result.ok).toBe(false);
    expect(result.core).toEqual(['src/features/payments/stripe.ts']);
  });

  // The edit is allowed — a shop owns its repository. Being unremarked is not:
  // an approved core edit is a divergence to re-resolve at the next upgrade.
  it('passes the same edit once it is approved', () => {
    expect(shop(['src/features/payments/stripe.ts'], { by: 'label' }).ok).toBe(true);
  });

  it('counts a generated file as core: a hand edit there is lost, not merged', () => {
    expect(shop(['wrangler.jsonc']).core).toEqual(['wrangler.jsonc']);
  });

  // Fail closed. Any other reading lets a change slip past by adding a file
  // the rules do not cover.
  it('counts an unclassified path as core', () => {
    expect(shop(['content/whatever.md']).core).toEqual(['content/whatever.md']);
  });

  it('counts a deleted core file, which arrives as an ordinary changed path', () => {
    expect(shop(['migrations/0007_tax.sql']).ok).toBe(false);
  });

  // An upgrade, not a divergence: without this every upgrade pull request
  // needed an approval, and one asked every time is one nobody reads.
  it('passes the core paths a merged core release carries, and reports them', () => {
    const result = coreChangeGate({
      paths: ['client/client.yaml', 'scripts/themes.mjs', 'src/features/payments/stripe.ts'],
      isShop: true,
      carried: ['scripts/themes.mjs', 'src/features/payments/stripe.ts'],
    });
    expect(result.ok).toBe(true);
    expect(result.core).toEqual([]);
    expect(result.carried).toEqual(['scripts/themes.mjs', 'src/features/payments/stripe.ts']);
  });

  it('still refuses a core edit that rides along with an upgrade', () => {
    const result = coreChangeGate({
      paths: ['scripts/themes.mjs', 'src/features/payments/stripe.ts'],
      isShop: true,
      carried: ['scripts/themes.mjs'],
    });
    expect(result.ok).toBe(false);
    expect(result.core).toEqual(['src/features/payments/stripe.ts']);
  });

  // In the core repository every pull request touches the core. A gate firing
  // on all of them would only teach people to wave it through.
  it('does not fire in the core repository', () => {
    const result = coreChangeGate({ paths: ['src/features/payments/stripe.ts'], isShop: false });
    expect(result.ok).toBe(true);
    expect(result.enforced).toBe(false);
    expect(result.core).toEqual(['src/features/payments/stripe.ts']);
  });
});

describe('.github/CODEOWNERS', () => {
  const committed = readFileSync(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8');

  it('is what the rules render', () => {
    expect(committed).toBe(renderCodeowners());
  });

  /**
   * Resolve a path the way GitHub does: last matching line wins, and a line
   * with no owners clears ownership. Reimplemented here rather than reused
   * from the renderer, so the test can disagree with it.
   */
  const owners = (path) => {
    let result = null;
    for (const line of committed.split('\n')) {
      const text = line.replace(/#.*$/, '').trim();
      if (!text) continue;
      const [pattern, ...names] = text.split(/\s+/);
      const glob = pattern.replace(/^\//, '').replace(/\/$/, '/**');
      if (matchGlob(glob === '*' ? '*' : glob, path)) result = names;
    }
    return result;
  };

  // The renderer reverses the rule list because CODEOWNERS is last-match-wins
  // where the map is first-match-wins. Getting that backwards would produce a
  // file that looks right and reviews the wrong half of the tree.
  it.each([
    ['src/features/payments/stripe.ts', 'core'],
    ['src/themes/default/Header.astro', 'core'],
    ['src/themes/studio/tokens.css', 'core'],
    ['src/themes/pilot-fr/tokens.css', 'client'],
    ['src/store.config.ts', 'client'],
    ['src/styles/overrides.css', 'client'],
    ['src/styles/base.css', 'core'],
    ['client/client.yaml', 'client'],
    ['public/favicon.svg', 'client'],
    ['theme.config.json', 'client'],
    ['wrangler.jsonc', 'generated'],
    ['.github/CODEOWNERS', 'generated'],
    ['.github/workflows/verify.yml', 'core'],
    ['migrations/0001_init.sql', 'core'],
    ['package.json', 'core'],
  ])('reviews %s the way the map owns it (%s)', (path, owner) => {
    const reviewers = owners(path);
    expect(reviewers, path).not.toBeNull();
    if (owner === 'client') expect(reviewers).toEqual([]);
    else expect(reviewers).toEqual(CORE_OWNERS);
  });

  it('names a reviewer for every core and generated file in the tree', () => {
    const { owned } = classifyPaths(tracked());
    for (const path of [...owned.core, ...owned.generated]) {
      expect(owners(path), path).toEqual(CORE_OWNERS);
    }
  });
});

describe('check:paths', () => {
  it('passes over this tree', () => {
    const out = execFileSync('node', ['scripts/check-paths.mjs', '--json'], { cwd: root, encoding: 'utf8' });
    const report = JSON.parse(out);
    expect(report.ok).toBe(true);
    // Core-owned, therefore shipped into every generated shop and run there.
    // The gate's reading of the tree must match the tree, not a constant.
    expect(report.repository).toBe(existsSync(join(root, 'client/client.yaml')) ? 'shop' : 'core');
    expect(report.unclassified).toEqual([]);
    expect(report.codeowners.ok).toBe(true);
  });

  // The real history of an upgrade: a shop on one core release merges the
  // next. Every upgrade pull request of every shop was red here until a
  // `core-change` label (étape 2 de la certification, v0.3.2).
  describe('on an upgrade pull request', () => {
    const run = (argv, cwd) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: 'pipe' });
    const put = (dir, path, text) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const commit = (dir, message) => {
      run(['add', '-A'], dir);
      run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message], dir);
    };
    const gate = (dir) => {
      const result = spawnSync('node', [join(root, 'scripts/check-paths.mjs'), '--changed', '--base', 'main', '--json'], {
        cwd: dir,
        encoding: 'utf8',
      });
      return JSON.parse(result.stdout).gate;
    };

    /** A shop on core "1", with core "2" merged on an upgrade branch. */
    const upgradedShop = () => {
      const dir = mkdtempSync(join(tmpdir(), 'paths-upgrade-'));
      run(['init', '-q', '-b', 'core'], dir);
      put(dir, 'scripts/tool.mjs', 'one\n');
      put(dir, 'src/features/payments/stripe.ts', 'one\n');
      commit(dir, 'core 1');
      run(['checkout', '-q', '-b', 'main'], dir);
      put(dir, 'client/client.yaml', 'slug: port\n');
      commit(dir, 'shop');
      run(['checkout', '-q', 'core'], dir);
      put(dir, 'scripts/tool.mjs', 'two\n');
      run(['rm', '-q', 'src/features/payments/stripe.ts'], dir);
      commit(dir, 'core 2');
      run(['checkout', '-q', '-b', 'upgrade', 'main'], dir);
      run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-edit', 'core'], dir);
      return dir;
    };

    it('passes the files the release brought, deletions included', () => {
      const result = gate(upgradedShop());
      expect(result.ok).toBe(true);
      expect(result.core).toEqual([]);
      expect(result.carried).toEqual(['scripts/tool.mjs', 'src/features/payments/stripe.ts']);
    });

    it('still refuses a core edit slipped into the upgrade', () => {
      const dir = upgradedShop();
      put(dir, 'scripts/tool.mjs', 'two, and mine\n');
      commit(dir, 'slipped in');
      const result = gate(dir);
      expect(result.ok).toBe(false);
      expect(result.core).toEqual(['scripts/tool.mjs']);
    });

    // A merge from another shop branch is no release: its side carries the
    // client manifest.
    it('does not take a merge of the shop’s own branch for a release', () => {
      const dir = upgradedShop();
      run(['checkout', '-q', '-b', 'side', 'main'], dir);
      put(dir, 'src/features/payments/stripe.ts', 'edited by the shop\n');
      commit(dir, 'shop edit');
      run(['checkout', '-q', '-b', 'merges-side', 'main'], dir);
      run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-ff', '--no-edit', 'side'], dir);
      expect(gate(dir).core).toEqual(['src/features/payments/stripe.ts']);
    });
  });
});
