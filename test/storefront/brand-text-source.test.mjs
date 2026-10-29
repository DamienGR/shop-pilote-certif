import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { classifyPath } from '../../scripts/path-ownership.mjs';
import { trackedTemplates, withImports } from '../i18n/template-scan.mjs';

// Deliberately .mjs: reads source files, like admin-isolation.test.mjs.
//
// `brand` is a fill and `accent` is text (src/themes/default/tokens.css). The
// core used to set text in `brand` — every content-page link, the current page,
// the active sort, a dozen hovers — so a theme that picked a vivid brand, a
// perfectly good button colour at 3:1 on its paper, failed WCAG AA on all of
// that text at once: a raspberry on a demo shop failed test/browser/a11y on the
// content page and the cart, and the whole theme had to darken its buttons.
//
// The Admin keeps its own fixed palette (src/styles/admin.css), and a shop's
// own theme is the merchant's (scripts/path-ownership.mjs): neither is held to
// this. The core components a shop's theme imports are.

const core = (path) => classifyPath(path)?.owner === 'core';

/** Every storefront route, its layout and every core theme, plus what they import. */
const templates = withImports(
  trackedTemplates(['src/pages', 'src/layouts/Layout.astro', 'src/themes']).filter(
    (path) => !path.startsWith('src/pages/admin/'),
  ),
).filter(core);

/** The storefront's stylesheets: the shared layers and the core themes' tokens. */
const stylesheets = execFileSync('git', ['ls-files', 'src/styles', 'src/themes'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((path) => path.endsWith('.css') && path !== 'src/styles/admin.css')
  .filter(core);

/** A Tailwind text utility in the brand colour, under any variant (`hover:`, `sm:`…). */
const TEXT_IN_BRAND = /(?<![\w-])(?:[\w-]+:)*text-brand(?:-hover)?(?![\w-])/g;
/** A CSS text colour in the brand token. `background-color` and `outline` are fills. */
const COLOR_IN_BRAND = /(?<![\w-])color:\s*var\(--color-brand(?:-hover)?\b/g;

function findings(paths, pattern) {
  const found = [];
  for (const path of paths) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const [match] of line.matchAll(pattern)) found.push(`${path}:${index + 1} ${match}`);
      });
  }
  return found;
}

describe('the storefront sets text in accent, never in brand', () => {
  it('finds the files it is meant to be guarding', () => {
    // A move or a rename must fail loudly here rather than empty the scan.
    expect(templates).toContain('src/layouts/Layout.astro');
    expect(templates).toContain('src/features/storefront/controls/CatalogSort.astro');
    expect(templates).toContain('src/themes/default/ProductDetail.astro');
    expect(templates.filter((path) => path.includes('admin'))).toEqual([]);
    expect(stylesheets).toContain('src/styles/base.css');
    expect(stylesheets).toContain('src/themes/default/tokens.css');
  });

  it('reads a variant and leaves a fill alone', () => {
    const line = 'class="bg-brand hover:bg-brand-hover hover:text-brand sm:group-hover:text-brand border-brand"';
    expect(line.match(TEXT_IN_BRAND)).toEqual(['hover:text-brand', 'sm:group-hover:text-brand']);
    const css = 'a { color: var(--color-brand); background-color: var(--color-brand); outline: 2px solid var(--color-brand); }';
    expect(css.match(COLOR_IN_BRAND)).toEqual(['color: var(--color-brand']);
  });

  it('uses no brand text utility in a core storefront template', () => {
    expect(findings(templates, TEXT_IN_BRAND)).toEqual([]);
  });

  it('gives no core stylesheet rule a brand text colour', () => {
    expect(findings(stylesheets, COLOR_IN_BRAND)).toEqual([]);
  });
});
