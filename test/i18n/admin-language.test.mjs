import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { markup, readableAttributes, textNodes, trackedTemplates, withImports } from './template-scan.mjs';

// Deliberately .mjs: it reads source files, and tsconfig.compilerOptions.types
// is pinned to the Cloudflare types. Same reason as test/storefront/boundary.test.mjs.
//
// ADR 0018 makes the Admin French, through the same typed catalog as the
// storefront. The compiler sees a key that does not exist; it cannot see a
// label that never became a key. A new Admin screen written the way the old
// ones were — "Save" between two tags — would ship a half-English Admin under
// a French `lang`, which is the one outcome ADR 0011 and ADR 0018 both refuse.
// A source scan is the cheap floor under that.

/**
 * The Admin's entry points, every route under src/pages/admin and its layout,
 * plus what they import. Storefront components never come in through this
 * walk: no Admin page imports one, and the theme boundary keeps it that way
 * from the other side.
 */
const templates = withImports(trackedTemplates(['src/pages/admin', 'src/layouts/AdminLayout.astro'])).map(
  (path) => ({ path, text: readFileSync(path, 'utf8') }),
);

/**
 * Words that mark a phrase as English and do not occur as French words.
 *
 * Function words catch sentences ("Paste the key from your dashboard"); the UI
 * verbs and nouns catch the one-word labels a button or a column carries. "on",
 * "or", "a", "total", "date", "stock", "pages", "options", "menu" and
 * "navigation" are left out because French uses them too.
 */
const ENGLISH = new RegExp(
  `\\b(${[
    'the', 'your', 'you', 'and', 'with', 'this', 'that', 'is', 'are', 'was', 'of', 'to', 'for',
    'not', 'from', 'will', 'can', 'has', 'have', 'been', 'it', 'its', 'into', 'when', 'yet',
    'Save', 'Cancel', 'Delete', 'Edit', 'Remove', 'Add', 'Search', 'Settings', 'Orders', 'Products',
    'Customers', 'Categories', 'Shipping', 'Dashboard', 'Upload', 'Name', 'Price', 'Status',
    'Password', 'Next', 'Previous', 'Prev', 'New', 'None', 'Draft', 'Published', 'Active',
    'Inactive', 'Refund', 'Paid', 'Pending', 'Enabled', 'Disabled', 'Required', 'Optional',
    'Loading', 'Saved', 'Update', 'Create', 'Clear', 'Apply', 'Close', 'Show', 'Hide', 'Back',
    'Log in', 'Log out', 'Sign in', 'View',
  ].join('|')})\\b`,
);

describe('the Admin speaks French (ADR 0018)', () => {
  it('finds the templates it is meant to be guarding', () => {
    // A move or a rename must fail loudly here rather than empty the scan.
    const paths = templates.map((t) => t.path);
    expect(paths).toContain('src/layouts/AdminLayout.astro');
    expect(paths).toContain('src/pages/admin/settings.astro');
    expect(paths).toContain('src/features/products/ProductForm.astro');
    expect(paths.length).toBeGreaterThan(25);
  });

  it('never declares an English document', () => {
    for (const { path, text } of templates) expect(text, path).not.toMatch(/\blang=["']en/);
  });

  it('writes no English label or sentence into a template', () => {
    const english = [];
    for (const { path, text } of templates) {
      const body = markup(text);
      for (const phrase of [...textNodes(body), ...readableAttributes(body)]) {
        if (ENGLISH.test(phrase)) english.push(`${path}: ${phrase}`);
      }
    }
    expect(english).toEqual([]);
  });
});
