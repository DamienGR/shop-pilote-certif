import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';

// Deliberately .mjs: it reads source files, and tsconfig.compilerOptions.types
// is pinned to the Cloudflare types. Same reason as test/storefront/boundary.test.mjs.
//
// ADR 0018 makes the Admin French, through the same typed catalog as the
// storefront. The compiler sees a key that does not exist; it cannot see a
// label that never became a key. A new Admin screen written the way the old
// ones were — "Save" between two tags — would ship a half-English Admin under
// a French `lang`, which is the one outcome ADR 0011 and ADR 0018 both refuse.
// A source scan is the cheap floor under that.

/** The Admin's entry points: every route under src/pages/admin, and its layout. */
const ROOTS = execFileSync('git', ['ls-files', 'src/pages/admin', 'src/layouts/AdminLayout.astro'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((path) => path.endsWith('.astro'));

/**
 * The roots plus every `.astro` component they import, transitively.
 *
 * Derived rather than listed, so a form moved into a feature folder is still
 * scanned. Storefront components never come in through this walk: no Admin page
 * imports one, and the theme boundary keeps it that way from the other side.
 */
function adminTemplates() {
  const seen = new Set();
  const queue = [...ROOTS];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    for (const [, spec] of text.matchAll(/^import\s+[^'"]*['"](\.{1,2}\/[^'"]+\.astro)['"]/gm)) {
      const target = normalize(join(dirname(path), spec));
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].sort();
}

const templates = adminTemplates().map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** Markup only: no frontmatter, no comments, no scripts or styles. */
function markup(text) {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');
}

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

/**
 * Text between two tags, when it holds no expression. The `>` of an arrow
 * function and the JavaScript between two elements of a `.map()` are not text.
 */
function textNodes(source) {
  return [...source.matchAll(/(?<!=)>([^<>{}]+)</g)]
    .map(([, text]) => text.replace(/\s+/g, ' ').trim())
    .filter((text) => /[A-Za-z]{2}/.test(text))
    .filter((text) => !/===|!==|&&|\|\||=>|\?\s*\($|^\)\s*:/.test(text));
}

/** Static values of the attributes a person reads or a screen reader speaks. */
function readableAttributes(source) {
  return [...source.matchAll(/\s(?:placeholder|title|aria-label|alt|label|hint)="([^"{}]+)"/g)].map(
    ([, value]) => value,
  );
}

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
