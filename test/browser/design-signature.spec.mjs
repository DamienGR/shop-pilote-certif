import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.mjs';
import { SHOP_SIGNATURES_DIR, SIGNATURES_DIR, resolveTheme } from '../../scripts/themes.mjs';
import { REMOTE, settle } from './pages.mjs';

/**
 * Visual regression, as a signature of the COMPILED design rather than as a
 * pixel diff.
 *
 * The obvious implementation is `toHaveScreenshot`, and it was rejected on
 * purpose. A PNG baseline is only meaningful against the exact renderer that
 * recorded it: font hinting, subpixel positioning and GPU rasterisation all
 * differ between a laptop and a CI runner, so the baseline has to be recorded
 * inside a pinned container or the gate reports failures nobody caused. This
 * repository already spends a whole workflow measuring one flake
 * (.github/workflows/d1-flake-probe.yml); adding a second, self-inflicted one
 * to catch design drift is a bad trade.
 *
 * What actually regresses in a token-driven design is not pixels — it is a
 * token. Someone edits tokens.css and the header changes colour, or a Tailwind
 * class is dropped and a heading loses its face, or an `@source not` exclusion
 * silently removes the active theme's utilities and everything falls back to
 * browser defaults. Every one of those shows up in the COMPUTED style, which is
 * spec-defined and identical on every machine. So that is what is recorded.
 *
 * It also catches what a screenshot cannot: `check-built-css.mjs` proves the
 * theme's utilities are PRESENT in the bundle; this proves they are the ones
 * actually applied to the element.
 *
 * COLOURS ARE COMPARED AT DISPLAY PRECISION, and that correction cost a red CI
 * run. "Computed styles are spec-defined and identical on every machine" is true
 * of `rgb(...)`; it is NOT true of the wide-gamut forms. Tailwind compiles an
 * alpha modifier like `bg-paper/85` through `color-mix(in oklab, …)`, and the
 * computed value comes back as `oklab()` with implementation-defined float
 * precision — so the two themes whose header carries an alpha background
 * (`default`, `atelier`) recorded `oklab(0.96524 …)` here and read back
 * `oklab(0.965308 …)` on the runner, while `studio` and `market`, whose headers
 * are opaque, passed. A difference of 5e-5 in oklab lightness is roughly a
 * hundredth of an 8-bit step: no display can show it, so it is not a visual
 * regression. Every colour is therefore resolved through a 1×1 canvas to its
 * sRGB bytes before being recorded.
 *
 * Re-record after a deliberate design change:
 *   THEME=<id> UPDATE_SIGNATURE=1 npm run test:browser -- design-signature
 * and read the diff like source.
 */

const theme = resolveTheme().id;
// A shipped theme's signature is the core's, beside this spec. A shop's own
// theme records its signature under client/ — test/ is the core's, and the
// shop could not write there without a core change at every upgrade.
const ROOT = new URL('../../', import.meta.url);
const CORE_FILE = new URL(`${SIGNATURES_DIR}/${theme}.json`, ROOT);
const IN_SHOP = existsSync(new URL('client/client.yaml', ROOT));
const FILE = existsSync(CORE_FILE) || !IN_SHOP ? CORE_FILE : new URL(`${SHOP_SIGNATURES_DIR}/${theme}.json`, ROOT);
const DIR = new URL('./', FILE);

/**
 * What to look at, and where.
 *
 * Chosen so that each probe fails for one legible reason. The page's own ground
 * and text, the sticky chrome, the display face, one product caption, and the
 * primary purchase action — between them they cover every token in the required
 * `@theme` surface except the ones no element on these two pages uses.
 */
const PROBES = [
  { path: '/', name: 'page', selector: 'body' },
  { path: '/', name: 'en-tête', selector: 'header' },
  { path: '/', name: 'titre du catalogue', selector: 'main h1' },
  // The card heading is anatomy rather than a contract hook — there is no
  // `data-` marker for "the product's name in a card". It holds for the four
  // shipped designs, and a fifth that drops the list gets a failure naming this
  // probe, which is the right way to find out.
  { path: '/', name: 'nom de produit', selector: 'main ul li h2' },
  { path: '/', name: 'pied de page', selector: 'footer' },
  { path: '/products/sample-tee', name: 'nom du produit', selector: 'main h1' },
  // A real hook: [data-price-display] is part of the storefront contract, so
  // this probe cannot be broken by a redesign, only by a token change.
  { path: '/products/sample-tee', name: 'prix', selector: '[data-price-display]' },
  { path: '/products/sample-tee', name: 'action principale', selector: 'button[type="submit"]' },
  { path: '/pages/about', name: 'prose', selector: '.markdown-content p' },
  // The prose ramp itself: --prose-h1-size, its tracking, and the face.
  { path: '/pages/about', name: 'titre de prose', selector: '.markdown-content h1' },
  // The one place --color-accent lands on a real element.
  { path: '/pages/about', name: 'lien de prose', selector: '.markdown-content a' },
];

/** The properties a design is made of. Deliberately not "every computed
 *  property": layout offsets move with content, and a signature that changes
 *  when a fixture gains a product is a signature nobody trusts. */
const PROPERTIES = [
  'backgroundColor',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textTransform',
  'borderTopColor',
  'borderBottomColor',
  'borderBottomWidth',
  'borderRadius',
  'boxShadow',
];

async function probe(page, selector) {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) return null;
  return el.evaluate((node, properties) => {
    // A 1×1 canvas is the browser's own colour converter, which is what makes
    // this exact rather than a rounding rule with a boundary to fall off.
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // A colour no design uses, so "the assignment was rejected" is
    // distinguishable from "the colour really is the sentinel".
    const SENTINEL = 'rgba(1, 2, 3, 0.004)';

    /** One colour → its sRGB bytes, or null if this browser cannot parse it. */
    const toBytes = (value) => {
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = value;
      if (ctx.fillStyle === SENTINEL) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    };

    // Only the wide-gamut forms need this; `rgb()` is already integers. Scanned
    // with brace matching rather than a regex because these functions nest —
    // `color-mix(in oklab, oklch(…), …)` is one value, not two.
    const FUNCTIONS = ['oklab(', 'oklch(', 'lab(', 'lch(', 'color-mix(', 'color('];
    const normalise = (value) => {
      let out = '';
      let i = 0;
      while (i < value.length) {
        let hit = null;
        for (const name of FUNCTIONS) {
          const at = value.indexOf(name, i);
          if (at !== -1 && (hit === null || at < hit.at)) hit = { name, at };
        }
        if (!hit) return out + value.slice(i);
        out += value.slice(i, hit.at);
        let depth = 0;
        let j = hit.at + hit.name.length - 1;
        for (; j < value.length; j += 1) {
          if (value[j] === '(') depth += 1;
          else if (value[j] === ')' && --depth === 0) {
            j += 1;
            break;
          }
        }
        const raw = value.slice(hit.at, j);
        out += toBytes(raw) ?? raw;
        i = j;
      }
      return out;
    };

    const s = getComputedStyle(node);
    return Object.fromEntries(properties.map((p) => [p, normalise(s[p])]));
  }, PROPERTIES);
}

// Desktop only. The signature is about the design's values, and recording a
// second set at a phone viewport would double the file to re-assert the same
// tokens with two font sizes.
test.describe('signature du design', () => {
  test(`le thème « ${theme} » compile le design attendu`, async ({ page }) => {
    // One viewport, checked from inside the test: a describe-level modifier
    // gets the fixtures, not the project.
    test.skip(test.info().project.name !== 'desktop', 'signature prise sur desktop');
    // The probes aim at the fixture's pages and the signature records the
    // fixture's rendering of them; a merchant's catalogue answers neither.
    test.skip(REMOTE, 'signature prise sur le jeu d’essai, pas sur une boutique déployée');

    const captured = {};
    let current = null;
    for (const { path, name, selector } of PROBES) {
      if (current !== path) {
        await page.goto(path);
        await settle(page);
        current = path;
      }
      const style = await probe(page, selector);
      expect(style, `aucun élément pour « ${name} » (${selector}) sur ${path}`).not.toBeNull();
      captured[`${path} · ${name}`] = style;
    }

    if (process.env.UPDATE_SIGNATURE) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, `${JSON.stringify(captured, null, 2)}\n`);
      test.info().annotations.push({ type: 'signature', description: `écrite : ${FILE.pathname}` });
      return;
    }

    expect(
      existsSync(FILE),
      `aucune signature pour le thème « ${theme} ». Enregistrez-la :\n` +
        `  THEME=${theme} UPDATE_SIGNATURE=1 npm run test:browser -- design-signature`,
    ).toBe(true);

    expect(captured).toEqual(JSON.parse(readFileSync(FILE, 'utf8')));
  });
});
