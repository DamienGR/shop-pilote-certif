import { expect, test } from './fixtures.mjs';
import { ROUTES, overflowOf, settle } from './pages.mjs';

/**
 * Nothing scrolls sideways — the "responsive" line of the jalon-5 deliverables.
 *
 * A horizontal scrollbar on a storefront is not a cosmetic fault. On a phone it
 * makes the page drift under the thumb while reading, and it usually means one
 * element is wider than the viewport and has quietly pushed a control off the
 * right edge, where nobody will find it. The measurement is exact, so the
 * assertion is exact: zero.
 *
 * Both projects run this, so every route is measured at a desktop viewport and
 * at a phone's.
 */
for (const { name, path } of ROUTES) {
  test(`${name} ne déborde pas horizontalement`, async ({ page }) => {
    await page.goto(path);
    await settle(page);

    expect(await overflowOf(page)).toBe(0);
  });
}

/**
 * Browser zoom, at the bar the plan sets: 200 %.
 *
 * Zoom does not scale the viewport — it shrinks the CSS-pixel width the page is
 * laid out in — so halving the width IS 200 % zoom, and it is far steadier than
 * driving Chromium's zoom over CDP.
 *
 * WCAG 1.4.10 (Reflow, AA) actually asks for 320 CSS px, which is 400 % on a
 * 1280 desktop and also an iPhone SE. That is deliberately NOT gated here, and
 * the reason is written down in the jalon-5 État: the `default` theme fails it
 * by 37 px — its header nav carries a disclosure, a search link and the cart
 * with nothing that can shrink — and choosing which of those gives way at
 * 320 px is a design decision for whoever owns that theme, not something to
 * settle inside a test. `atelier` passes 320 px today; a gate the shipped
 * default cannot meet would be turned off within a week.
 */
for (const [label, width] of [['200 %', 640]]) {
  test(`le catalogue reste lisible à ${label} de zoom`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await settle(page);

    expect(await overflowOf(page)).toBe(0);
    // Reflow, not just "no scrollbar": the products must still be there. A
    // template that hid the grid below a breakpoint would pass the first line.
    // Scoped to <main>: the header's merchant nav can legitimately link to a
    // product and legitimately collapse into the disclosure at this width.
    await expect(page.locator('main a[href^="/products/"]').first()).toBeVisible();
  });
}

/**
 * The header wordmark: the one link home that carries the store name as its
 * label, in every shipped theme. `header a[href="/"]` alone matched a merchant
 * menu link to the home page first — hidden at phone width, so on atelier the
 * long-name test below injected into an invisible link and measured nothing.
 */
const WORDMARK = 'header a[href="/"][aria-label]';

test('un nom de boutique très long ne fait pas déborder l’en-tête', async ({ page }) => {
  await page.goto('/');
  await settle(page);

  // The seeded shop is called "Ma boutique", which fits everywhere and proves
  // nothing. A real merchant is called "Atelier de céramique de Haute-Provence",
  // and the header wordmark is a flex item — flex items default to
  // min-width:auto, so one that cannot shrink pushes the cart off the right
  // edge at phone width. Injected rather than seeded: what is under test is the
  // theme's CSS, and the store name is a runtime setting, not a fixture shape.
  await page.evaluate((selector) => {
    const mark = document.querySelector(selector);
    const text = mark?.querySelector('span') ?? mark;
    if (text) text.textContent = 'Atelier de céramique de Haute-Provence';
  }, WORDMARK);

  expect(await overflowOf(page)).toBe(0);
});

test('un nom de boutique ordinaire tient en entier sur un téléphone', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 640, 'la question ne se pose qu’à la largeur d’un téléphone');
  // 360 px, not the project's 412: most Android phones lay out at 360 to 393,
  // and the pilot's production header cut its name at 360 and kept it at 384.
  await page.setViewportSize({ width: 360, height: page.viewportSize()?.height ?? 800 });
  await page.goto('/');
  await settle(page);

  // The test above only proves a long name does not push the cart off screen,
  // which `truncate` guarantees by cutting the name. A fifteen-letter name is
  // not long, and the first deployed shop's lost its tail on a phone behind
  // "Rechercher" and "Panier" written out in full (certification, étape 9):
  // below the search field's breakpoint the store controls are icons.
  const cut = await page.evaluate((selector) => {
    const mark = document.querySelector(selector);
    const text = mark?.querySelector('span') ?? mark;
    if (!mark || !text || mark.querySelector('img')) return null;
    text.textContent = 'Atelier Lumière';
    return mark.scrollWidth > mark.clientWidth;
  }, WORDMARK);
  test.skip(cut === null, 'l’en-tête montre un logo, pas le nom');
  expect(cut, 'le nom de la boutique est coupé dans l’en-tête').toBe(false);
});

test('le menu replié s’ouvre dans l’écran', async ({ page }) => {
  await page.goto('/');
  await settle(page);

  const disclosure = page.locator('[data-nav-disclosure]');
  const summary = disclosure.locator('summary');
  test.skip((await disclosure.count()) === 0, 'menu d’en-tête vide : aucun lien dans Admin → Navigation');
  test.skip(!(await summary.isVisible().catch(() => false)), 'pas de menu replié à cette largeur');

  await summary.click();
  const panel = disclosure.locator('summary + *');
  await expect(panel).toBeVisible();
  // An absolutely positioned panel that hangs past the LEFT edge adds no
  // scrollbar — negative overflow is unscrollable — so the overflow checks
  // above never saw atelier's, whose button sits at the left of the row while
  // the panel was anchored to its right edge (certification, étape 9).
  const box = await panel.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box, 'le menu ouvert n’a pas de boîte').not.toBeNull();
  expect(box.x, 'le menu ouvert dépasse à gauche').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'le menu ouvert dépasse à droite').toBeLessThanOrEqual(width);
});

test('un nom de produit très long ne fait pas déborder sa vignette', async ({ page }) => {
  await page.goto('/');
  await settle(page);

  // Injected rather than seeded: the fixture is shared with the HTML baselines,
  // and what is under test here is the theme's CSS — whether the caption row
  // survives a name that cannot fit beside a price — not the server's ability
  // to store a long string. The container contract covers that half.
  await page.evaluate(() => {
    const heading = document.querySelector('main h2');
    if (heading) {
      heading.textContent =
        'Torchon en lin lavé, tissé et ourlé à la main dans le Nord de la France, très grand format';
    }
  });

  expect(await overflowOf(page)).toBe(0);
});
