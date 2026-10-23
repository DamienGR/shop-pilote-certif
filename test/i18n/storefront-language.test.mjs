import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyPath } from '../../scripts/path-ownership.mjs';
import { markup, readableAttributes, textNodes, trackedTemplates, withImports } from './template-scan.mjs';

// Deliberately .mjs, like admin-language.test.mjs.
//
// The storefront is French (ADR 0008), and every string a customer reads is a
// key of the typed catalog. The compiler cannot see a string that never became
// a key: the catalog shipped "Shop" and "All products" as prop defaults, and the
// cart drawer "Your cart", on every shop, until a pilot's live home page showed
// them. The Admin scan looks for English words because its templates carry
// technical literals; the storefront carries almost none, so the rule here is
// stricter: a core storefront template writes no readable text of its own, in
// any language.
//
// A shop's own theme is the merchant's (scripts/path-ownership.mjs) and is not
// held to it; the core components it imports are.

/** Every storefront route, its layout and every theme, plus what they import. */
const templates = withImports(
  trackedTemplates(['src/pages', 'src/layouts/Layout.astro', 'src/themes']).filter(
    (path) => !path.startsWith('src/pages/admin/'),
  ),
)
  .filter((path) => classifyPath(path)?.owner === 'core')
  .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** An identifier shown as code (`demo`) is not prose, and an entity is not a word. */
function prose(text) {
  return markup(text)
    .replace(/<code\b[^>]*>[^<]*<\/code>/g, '<code></code>')
    .replace(/&#?\w+;/g, ' ');
}

/**
 * The string defaults of an `Astro.props` destructuring that a customer would
 * read. A class list is lower case; a capitalised word is text.
 */
function proseDefaults(text) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const found = [];
  for (const [, body] of frontmatter.matchAll(/const\s*\{([\s\S]*?)\}\s*(?::\s*\w+\s*)?=\s*Astro\.props/g)) {
    for (const [, name, , value] of body.matchAll(/(\w+)\s*=\s*(['"`])((?:(?!\2).)*)\2/g)) {
      if (/\p{Lu}\p{Ll}/u.test(value)) found.push(`${name} = ${value}`);
    }
  }
  return found;
}

describe('the storefront speaks only through the catalog (ADR 0008)', () => {
  it('finds the templates it is meant to be guarding', () => {
    // A move or a rename must fail loudly here rather than empty the scan.
    const paths = templates.map((t) => t.path);
    expect(paths).toContain('src/layouts/Layout.astro');
    expect(paths).toContain('src/features/products/ProductList.astro');
    expect(paths).toContain('src/features/storefront/controls/StoreNav.astro');
    expect(paths).toContain('src/themes/market/ProductDetail.astro');
    expect(paths.filter((path) => path.includes('admin'))).toEqual([]);
    expect(paths.length).toBeGreaterThan(40);
  });

  it('reads a prop default the way a template declares one', () => {
    const typed = "---\nconst { heading = 'All products', size = 'sm' }: Props = Astro.props;\n---\n";
    const nested = "---\nconst {\n  opts = {},\n  eyebrow = \"Shop\",\n} = Astro.props;\n---\n";
    expect(proseDefaults(typed)).toEqual(['heading = All products']);
    expect(proseDefaults(nested)).toEqual(['eyebrow = Shop']);
  });

  it('writes no readable text of its own into a core template', () => {
    const literal = [];
    for (const { path, text } of templates) {
      const body = prose(text);
      for (const phrase of [...textNodes(body), ...readableAttributes(body)]) literal.push(`${path}: ${phrase}`);
    }
    expect(literal).toEqual([]);
  });

  it('gives no prop a default a customer would read', () => {
    const literal = [];
    for (const { path, text } of templates) {
      for (const found of proseDefaults(text)) literal.push(`${path}: ${found}`);
    }
    expect(literal).toEqual([]);
  });
});
