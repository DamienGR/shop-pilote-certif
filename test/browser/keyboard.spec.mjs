import { expect, test } from './fixtures.mjs';
import { settle } from './pages.mjs';

/**
 * The store, driven from the keyboard alone.
 *
 * axe cannot answer these. It reads a static tree, so it can tell you a control
 * has no name; it cannot tell you the Tab order never reaches the cart, or that
 * the focused element looks exactly like the unfocused one on this theme's
 * background. Both are failures a mouse never encounters and a keyboard user
 * hits on the first page.
 */

/** What a focus stop is, for the order assertion. `inMain` is the part that
 *  matters: a merchant may put a product link in the header nav, and that is
 *  not the catalogue grid. */
const STOP = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return {
    tag: el.tagName.toLowerCase(),
    href: el.getAttribute('href'),
    inMain: Boolean(el.closest('main')),
  };
})()`;

test('la tabulation atteint le panier avant la grille du catalogue', async ({ page }) => {
  await page.goto('/');
  await settle(page);

  // Bounded: an unbounded walk would hang rather than fail on a focus order
  // that loops. Twenty-five stops is well past the header on any theme.
  const stops = [];
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(STOP);
    if (stop) stops.push(stop);
  }

  const cartAt = stops.findIndex((s) => s.href === '/cart');
  expect(cartAt, 'le panier n’est pas atteint en 25 tabulations').toBeGreaterThanOrEqual(0);

  // A cart a shopper has to tab past forty products to reach is not reachable
  // in practice. The header's own links are fair game — the grid is not.
  const firstCardAt = stops.findIndex((s) => s.inMain && s.href?.startsWith('/products/'));
  if (firstCardAt !== -1) expect(cartAt).toBeLessThan(firstCardAt);
});

/**
 * WCAG 2.4.7 (Focus Visible, AA).
 *
 * Asserted as a DIFFERENCE rather than as a list of allowed properties, and
 * that is the whole design of this test. "Has an outline" would fail a theme
 * whose search field lights its wrapper through `focus-within:` — a perfectly
 * good indicator that simply is not on the focused element. So: fingerprint the
 * element and its parent focused, blur, fingerprint again, and require that
 * SOMETHING moved. What moved is the design's business.
 */
const FINGERPRINT = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const of = (node) => {
    if (!node) return '';
    const s = getComputedStyle(node);
    return [
      s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset,
      s.boxShadow, s.textDecorationLine, s.backgroundColor,
      s.borderColor, s.borderWidth, s.color, s.opacity,
    ].join('|');
  };
  return { self: of(el), parent: of(el.parentElement) };
})()`;

test('chaque élément qui prend le focus le montre', async ({ page }) => {
  await page.goto('/');
  await settle(page);

  // Transitions are turned OFF for this measurement, and that is a correctness
  // fix rather than a speed-up. The default theme's search field carries
  // `transition-all`, so a getComputedStyle taken in the same task as blur()
  // reads back the value the transition is leaving FROM — the focused one —
  // and the focused and blurred fingerprints come out identical for a field
  // that indicates focus perfectly well. What a person sees is the two end
  // states, so the two end states are what this compares.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });

  const invisible = [];
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab');
    const result = await page.evaluate(`(() => {
      const focused = ${FINGERPRINT};
      if (!focused) return null;
      const el = document.activeElement;
      const what = el.tagName.toLowerCase() +
        (el.getAttribute('href') ? '[href=' + el.getAttribute('href') + ']' : '') +
        (el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '');
      el.blur();
      const s = getComputedStyle(el);
      const p = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const blurred = [
        s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset,
        s.boxShadow, s.textDecorationLine, s.backgroundColor,
        s.borderColor, s.borderWidth, s.color, s.opacity,
      ].join('|');
      const blurredParent = p ? [
        p.outlineStyle, p.outlineWidth, p.outlineColor, p.outlineOffset,
        p.boxShadow, p.textDecorationLine, p.backgroundColor,
        p.borderColor, p.borderWidth, p.color, p.opacity,
      ].join('|') : '';
      el.focus();
      return { what, changed: focused.self !== blurred || focused.parent !== blurredParent };
    })()`);
    if (result && !result.changed) invisible.push(result.what);
  }

  expect(invisible, `rien ne change au focus : ${invisible.join(', ')}`).toEqual([]);
});

test('le menu replié s’ouvre au clavier et ses liens sont atteignables', async ({ page }) => {
  await page.goto('/');
  await settle(page);

  const disclosure = page.locator('[data-nav-disclosure]');
  const summary = disclosure.locator('summary');
  // No disclosure at all is a shop whose header menu is empty: StoreNav draws
  // nothing then, at any width. Said apart, because "not at this width" on
  // both projects read as a theme decision when it was a missing menu — the
  // certification's rehearsal skipped this test for that reason (étape 6).
  test.skip((await disclosure.count()) === 0, 'menu d’en-tête vide : aucun lien dans Admin → Navigation');
  // VISIBILITY, not presence. The disclosure exists in the markup at every
  // width — that is what makes it work with CSS off — but above its breakpoint
  // it is display:none, and focusing a hidden summary does nothing. Skipping on
  // `count()` here silently asserted nothing on the desktop project.
  test.skip(!(await summary.isVisible().catch(() => false)), 'pas de menu replié à cette largeur');

  await summary.focus();
  await page.keyboard.press('Enter');

  await expect(disclosure).toHaveJSProperty('open', true);
  // A native <details> carries the state itself, which is why the control is a
  // <summary> and not a scripted button: this works with scripts blocked too.
  await expect(disclosure.locator('a').first()).toBeVisible();
});
