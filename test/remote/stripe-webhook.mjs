/**
 * Stripe, end to end, in test mode, every night (plan §7.3: "checkout Stripe
 * test, webhook Stripe").
 *
 * The leg a script can drive without a human is the one that matters most to
 * the stock: a checkout opens a hosted session and holds a unit; the session
 * is expired through Stripe's own API; Stripe delivers
 * `checkout.session.expired` to the shop's webhook; the shop verifies the
 * signature and gives the unit back. Every link of that chain is real — the
 * session, the delivery, the signing secret, the endpoint registered in the
 * Stripe dashboard — so a webhook that stopped arriving shows up the next
 * morning as a unit that never came back, rather than as stock quietly
 * draining away on a live shop.
 *
 * The paid leg (`checkout.session.completed`, the order, the confirmation
 * e-mail) is not here: Stripe's hosted page refuses to be driven by a script,
 * by design, so it stays a manual pass in the campaign (étape 3).
 *
 *   BASE_URL                  the shop (staging)
 *   STRIPE_TEST_SECRET_KEY    a TEST key — ideally restricted (rk_test_…) to
 *                             "Checkout Sessions: write". A live key is refused.
 *   CF_ACCESS_CLIENT_ID / _SECRET behind a private preview
 *
 * Run: npm run test:stripe:remote -- [--product <slug>] [--timeout 180] [--interval 6]
 */
import { parseArgs } from 'node:util';
import { fetchAs, isAccessChallenge, remoteTarget } from './target.mjs';

const { values: options } = parseArgs({
  options: {
    product: { type: 'string' },
    timeout: { type: 'string', default: '180' },
    interval: { type: 'string', default: '6' },
  },
});

const fail = (message, code = 1) => {
  console.error(`stripe : ${message}`);
  process.exit(code);
};

let target;
try {
  target = remoteTarget();
} catch (error) {
  fail(error.message, 2);
}
const key = process.env.STRIPE_TEST_SECRET_KEY ?? '';
if (!/^(sk|rk)_test_/.test(key)) {
  fail('STRIPE_TEST_SECRET_KEY doit être une clé de TEST (sk_test_… ou rk_test_…). Une clé live n\'a rien à faire dans un run nocturne.', 2);
}
// Overridable for the suite that holds this script to account; never needed
// against Stripe itself.
const STRIPE_API = (process.env.STRIPE_API_BASE_URL ?? 'https://api.stripe.com').replace(/\/$/, '');

/** One JSON checkout through the Stripe rail. */
async function checkout(slug, quantity) {
  const response = await fetchAs(target, '/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ slug, quantity }], method: 'stripe', accept_terms: true, ship_country: 'FR' }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * The stock as the checkout sees it, without holding any of it. Null when the
 * checkout limiter (20 a minute per address) says to wait — the poll below
 * stays under it, but a second run started straight after the first does not.
 */
async function stockOf(slug) {
  const { status, body } = await checkout(slug, 1_000_000);
  if (status === 409 && Number.isInteger(body.available)) return body.available;
  if (status === 429) return null;
  if (status === 400 && /Unsupported payment method/.test(body.error ?? '')) {
    fail('Stripe n\'est pas activé sur cette boutique (clé secrète et secret de webhook dans Admin → Réglages).');
  }
  fail(`la sonde de stock a reçu ${status} ${JSON.stringify(body)}`);
}

/* ------------------------------------------------------------- the product */

const home = await fetchAs(target, '/');
if (isAccessChallenge(home)) fail('Cloudflare Access répond à la place du Worker : posez CF_ACCESS_CLIENT_ID et CF_ACCESS_CLIENT_SECRET.', 2);

let slug = options.product;
if (!slug) {
  // Any simple product with stock to spare: the unit is held for seconds, and
  // only on staging. Never the last one — that is last-unit.mjs's scenario.
  const list = await (await fetchAs(target, '/api/products?limit=100')).json();
  slug = list.products.find((product) => product.in_stock && !product.variant_label)?.slug;
  if (!slug) fail('aucun produit simple en stock sur cette boutique : nommez-en un avec --product.');
}

const before = await stockOf(slug);
if (before === null) fail('le limiteur du checkout répond 429 : relancez dans une minute.');
if (before < 2) fail(`« ${slug} » n'a que ${before} unité(s) : il en faut au moins deux pour ne pas épuiser le produit pendant le test.`);
console.log(`Stripe (test) — ${target.origin} : « ${slug} », stock ${before}.`);

/* ------------------------------------------------- session, then expiry */

const opened = await checkout(slug, 1);
if (opened.status !== 200 || !opened.body.checkout_url) fail(`le checkout a répondu ${opened.status} ${JSON.stringify(opened.body)}`);
const session = opened.body.checkout_url.match(/cs_(test|live)_[A-Za-z0-9]+/)?.[0];
if (!session) fail(`aucune session Stripe dans l'URL de paiement (${new URL(opened.body.checkout_url).host}).`);
if (session.startsWith('cs_live_')) fail('la boutique a ouvert une session LIVE : son Stripe n\'est pas en mode test.');
console.log(`  ✓ session ouverte sur ${new URL(opened.body.checkout_url).host}`);

const held = await stockOf(slug);
if (held !== before - 1) fail(`le stock vaut ${held} après la réservation, ${before - 1} attendu.`);
console.log(`  ✓ une unité réservée (stock ${held})`);

const expired = await fetch(`${STRIPE_API}/v1/checkout/sessions/${session}/expire`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(20_000),
});
if (!expired.ok) {
  // Stripe's error names the parameter and the request, never the key.
  const body = await expired.json().catch(() => ({}));
  fail(`Stripe a refusé d'expirer la session (${expired.status}) : ${body.error?.message ?? 'sans détail'}.`);
}
console.log('  ✓ session expirée côté Stripe');

/* --------------------------------------------- the webhook gives it back */

const deadline = Date.now() + Number(options.timeout) * 1000;
const started = Date.now();
let now = held;
while (now !== before && Date.now() < deadline) {
  // Every six seconds by default: ten probes a minute, half the limiter.
  await new Promise((resolve) => setTimeout(resolve, Number(options.interval) * 1000));
  now = (await stockOf(slug)) ?? now;
}
if (now !== before) {
  fail(
    `le stock est resté à ${now} pendant ${options.timeout} s : Stripe n'a pas livré checkout.session.expired, ou la boutique l'a refusé. ` +
      'Voir docs/operations/runbooks/webhooks-stripe.md (journal de livraison de l\'endpoint dans le tableau de bord Stripe).',
  );
}
console.log(`  ✓ webhook reçu et vérifié, unité rendue en ${Math.round((Date.now() - started) / 1000)} s (stock ${now})`);
