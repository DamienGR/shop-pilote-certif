import { expect, test } from './fixtures.mjs';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURE, ROUTES, settle } from './pages.mjs';

/**
 * axe, on every storefront route, at both sizes.
 *
 * Scoped to WCAG 2.1 A and AA. Not "every rule axe ships": the best-practice
 * set contains judgement calls a design is allowed to disagree with, and a gate
 * that fires on those teaches people to add exclusions until it fires on
 * nothing. These four tags are the ones a French shop is actually held to.
 *
 * The failure message lists the rule, its impact and the offending selector,
 * because "axe found 3 violations" is not something anybody can act on.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const describe = (violations) =>
  violations
    .map(
      (v) =>
        `  ${v.id} (${v.impact}) — ${v.help}\n` +
        v.nodes.map((n) => `      ${n.target.join(' ')}`).join('\n'),
    )
    .join('\n');

for (const { name, path } of ROUTES) {
  test(`${name} n'a aucune violation WCAG A/AA`, async ({ page }) => {
    const response = await page.goto(path);
    // A 404 route is SUPPOSED to answer 404; everything else must be 200, and a
    // 500 that renders an error page would otherwise pass every axe check on it.
    expect(response?.status()).toBe(path === '/no-such-page' ? 404 : 200);
    await settle(page);

    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();

    expect(violations.length, `${name} :\n${describe(violations)}`).toBe(0);
  });
}

/**
 * The two pages whose payment choices only exist once something is bought.
 *
 * The route list visits the cart empty, so the one brand-filled control that
 * carries secondary text — each payment method's hint, at 70 % of the label
 * colour — was never in front of axe, and it failed AA on atelier and studio
 * (Lighthouse found it rehearsing the certification, étape 6). The express
 * page draws the same choices.
 */
const PAYMENT_CONTROLS = 'button[name="method"], a[href^="/payment-setup"]';

test('le panier garni n’a aucune violation WCAG A/AA', async ({ page }) => {
  test.skip(!FIXTURE.simple, 'aucun produit simple en stock dans ce catalogue');
  await page.goto(`/products/${FIXTURE.simple.slug}`);
  await settle(page);
  await page.getByRole('button', { name: 'Ajouter au panier' }).first().click();
  await expect(page.locator('[data-cart-count-label]')).toContainText('1');

  await page.goto('/cart');
  await settle(page);
  await expect(page.locator(PAYMENT_CONTROLS).first()).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.length, `panier garni :\n${describe(violations)}`).toBe(0);
});

test('l’achat express n’a aucune violation WCAG A/AA', async ({ page }) => {
  test.skip(!FIXTURE.simple, 'aucun produit simple en stock dans ce catalogue');
  await page.goto(`/products/${FIXTURE.simple.slug}`);
  await settle(page);
  const buyNow = page.getByRole('button', { name: 'Acheter maintenant' }).first();
  test.skip(!(await buyNow.isVisible().catch(() => false)), 'achat express désactivé dans cette boutique');
  await buyNow.click();
  await page.waitForURL(/\/express/);
  await settle(page);
  await expect(page.locator(PAYMENT_CONTROLS).first()).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.length, `achat express :\n${describe(violations)}`).toBe(0);
});
