import { expect, test } from './fixtures.mjs';
import { FIXTURE, REMOTE, settle } from './pages.mjs';

/**
 * Adding to the cart, with scripts and without — invariant 1 as a test rather
 * than as a comment.
 *
 * "Progressive enhancement" is the kind of claim that stays true in the README
 * long after it stopped being true in the code, because the enhanced path is
 * the only one anybody exercises. These two tests are the same purchase,
 * twice, and the no-JavaScript one is the one that matters: it is what a
 * shopper gets on a flaky connection, behind a corporate proxy that strips
 * scripts, or on the render a crawler sees.
 */

test('avec JavaScript, l’ajout ouvre le tiroir sans quitter la page', async ({ page }) => {
  test.skip(!FIXTURE.simple, 'aucun produit simple en stock dans ce catalogue');
  await page.goto(`/products/${FIXTURE.simple.slug}`);
  await settle(page);

  const url = page.url();
  await page.getByRole('button', { name: /panier/i }).first().click();

  const drawer = page.locator('[data-cart-drawer]');
  await expect(drawer).not.toHaveClass(/invisible/);
  // Not navigating IS the enhancement. If the drawer opened and the page also
  // moved, the script is decorating a full page load rather than replacing it.
  expect(page.url()).toBe(url);
  await expect(page.locator('[data-cart-count-label]')).toContainText('1');
});

/**
 * The quantity a shopper types goes with the button they press next.
 *
 * Both cart surfaces had an "update" button per line and a checkout control
 * that re-read the cookie, so typing 2 and going straight to payment bought 1
 * (certification, étape 9). Locally only: against a deployed shop the payment
 * step would open a real provider session and hold stock.
 */
test('avec JavaScript, la quantité saisie dans le tiroir part avec la commande', async ({ page }) => {
  test.skip(!FIXTURE.simple || REMOTE, 'catalogue local avec un produit simple en stock');
  await page.goto(`/products/${FIXTURE.simple.slug}`);
  await settle(page);
  await page.getByRole('button', { name: /panier/i }).first().click();

  const drawer = page.locator('[data-cart-drawer]');
  await expect(drawer).not.toHaveClass(/invisible/);
  await drawer.locator('input[type="number"]').first().fill('2');
  await Promise.all([
    page.waitForURL('**/express'),
    drawer.getByRole('button', { name: /commander/i }).click(),
  ]);

  await page.goto('/cart');
  await expect(page.locator('main input[type="number"]').first()).toHaveValue('2');
});

test.describe('sans JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('le catalogue et la navigation restent entiers', async ({ page }) => {
    await page.goto('/');
    await settle(page);

    await expect(page.locator('main a[href^="/products/"]').first()).toBeVisible();
    // The images must be VISIBLE, not merely present: the fade enhancement
    // hides them at opacity 0 until a script adds a class, so a fade applied
    // from CSS alone would leave a scriptless visitor on a blank grid.
    await expect(page.locator('main img').first()).toBeVisible();
    const opacity = await page
      .locator('main img')
      .first()
      .evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeGreaterThan(0);
  });

  test('l’ajout au panier reste un vrai formulaire', async ({ page }) => {
    test.skip(!FIXTURE.simple, 'aucun produit simple en stock dans ce catalogue');
    await page.goto(`/products/${FIXTURE.simple.slug}`);
    // Settle BEFORE aiming at the button. Without it the hero image lands late
    // on a slow link, the form shifts under the pointer, and Playwright — quite
    // correctly — refuses to click a moving control.
    await settle(page);

    const form = page.locator('form[action="/api/cart"]');
    await expect(form).toHaveAttribute('method', /post/i);

    // The click navigates, so the wait is armed before it rather than after:
    // a submit that resolves faster than the next statement would otherwise
    // race the assertion.
    await Promise.all([
      page.waitForURL('**/cart'),
      form.getByRole('button', { name: /panier/i }).first().click(),
    ]);
    await expect(page.locator('body')).toContainText(FIXTURE.simple.name);
  });

  test('la quantité saisie sur le panier part avec le paiement', async ({ page }) => {
    test.skip(!FIXTURE.simple || REMOTE, 'catalogue local avec un produit simple en stock');
    await page.goto(`/products/${FIXTURE.simple.slug}`);
    await settle(page);
    await Promise.all([
      page.waitForURL('**/cart'),
      page.locator('form[action="/api/cart"]').getByRole('button', { name: /panier/i }).first().click(),
    ]);

    const pay = page.locator('form[action="/api/checkout"] button[name="method"]').first();
    test.skip((await pay.count()) === 0, 'aucun moyen de paiement offert par ce catalogue');
    const terms = page.locator('input[name="accept_terms"]');
    if (await terms.count()) await terms.check();
    // Typed, never "updated": the shopper goes straight to payment.
    await page.locator('main input[type="number"]').first().fill('2');
    await Promise.all([page.waitForURL((u) => u.pathname !== '/cart'), pay.click()]);

    await page.goto('/cart');
    await expect(page.locator('main input[type="number"]').first()).toHaveValue('2');
  });

  // Both forms of the hero: a gallery, and a single image — the form most
  // products of a real catalogue take, which a gallery-only locator missed
  // against the first deployed shop (certification, étape 3).
  for (const [kind, why] of [
    ['gallery', 'aucun produit en stock dans ce catalogue'],
    ['simple', 'aucun produit simple dans ce catalogue'],
  ]) {
    test(`la fiche produit montre son image principale (${kind})`, async ({ page }) => {
      test.skip(!FIXTURE[kind], why);
      await page.goto(`/products/${FIXTURE[kind].slug}`);
      await settle(page);

      const hero = page.locator('[data-product-hero] img').first();
      await expect(hero).toBeVisible();
      expect(
        await hero.evaluate((el) => el.complete && el.naturalWidth > 0),
        'l’image principale ne s’est pas chargée',
      ).toBe(true);
    });
  }
});
