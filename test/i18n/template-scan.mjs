import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';

// Shared by the two language scans, admin-language and storefront-language.
// Deliberately .mjs for the same reason as they are: it reads source files.

/** Every tracked `.astro` file under the given paths. */
export function trackedTemplates(paths) {
  return execFileSync('git', ['ls-files', ...paths], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((path) => path.endsWith('.astro'));
}

/**
 * The roots plus every `.astro` component they import, transitively.
 *
 * Derived rather than listed, so a component moved into a feature folder is
 * still scanned.
 */
export function withImports(roots) {
  const seen = new Set();
  const queue = [...roots];
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

/** Markup only: no frontmatter, no comments, no scripts or styles. */
export function markup(text) {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');
}

/**
 * Text between two tags, when it holds no expression. The `>` of an arrow
 * function and the JavaScript between two elements of a `.map()` are not text.
 */
export function textNodes(source) {
  return [...source.matchAll(/(?<!=)>([^<>{}]+)</g)]
    .map(([, text]) => text.replace(/\s+/g, ' ').trim())
    .filter((text) => /[A-Za-z]{2}/.test(text))
    .filter((text) => !/===|!==|&&|\|\||=>|\?\s*\($|^\)\s*:/.test(text));
}

/** Static values of the attributes a person reads or a screen reader speaks. */
export function readableAttributes(source) {
  return [...source.matchAll(/\s(?:placeholder|title|aria-label|alt|label|hint)="([^"{}]+)"/g)].map(
    ([, value]) => value,
  );
}
