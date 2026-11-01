/**
 * The recipient's phone at checkout (ticket #123, plan §13.3, lot 4), on the
 * built Worker.
 *
 * Boxtal refuses a label without the recipient's phone, so a shop that buys its
 * labels there asks for it with the address, and the order page prefills it.
 * The rule itself is a unit (features/shipping/recipient.ts); what only the
 * pipeline shows is that each way in carries the number to the order: the
 * in-app address form across its two steps (OpenNode, whose rate step the demo
 * rail skips), the demo rail through to the paid order, the JSON checkout's
 * `ship_to`, and Stripe's hosted page. And that a shop without Boxtal asks
 * nothing, and stores nothing.
 *
 * Run: node --experimental-strip-types test/integration/checkout-phone.mjs
 * (after a build — `npm run verify` builds first.)
 */
import assert from 'node:assert/strict';
import { startBuiltWorker } from '../helpers/built-worker.mjs';
import { encryptSecret } from '../../src/features/secrets/crypto.ts';
import { t } from '../../src/features/i18n/index.ts';

const ORIGIN = 'https://store.test';
const SECRETS_KEK = 'checkout-phone-suite-key-encryption-key';
const FORM = 'application/x-www-form-urlencoded';
const PRODUCT = 'prod_phn0000001';
// From the ranges ARCEP keeps for fiction: they reach nobody.
const PHONE = '06 39 98 00 01';
const ADDRESS = {
  email: 'acheteuse@exemple.fr',
  name: 'Camille Essai',
  line1: '3 quai Ceineray',
  city: 'Nantes',
  postal: '44000',
  country: 'FR',
};

/** Every Checkout Session the Worker asked Stripe for, as posted. */
const stripeSessions = [];
let openNodeCharges = 0;

const worker = await startBuiltWorker({
  vars: { CANONICAL_ORIGIN: ORIGIN, SECRETS_KEK },
  async outbound(request) {
    const url = new URL(request.url);
    if (url.hostname === 'api.stripe.com' && url.pathname === '/v1/checkout/sessions') {
      stripeSessions.push(new URLSearchParams(await request.text()));
      const id = `cs_test_phone${stripeSessions.length}`;
      return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    if (url.hostname === 'api.opennode.com' && url.pathname === '/v1/charges') {
      const id = `charge_phone_${++openNodeCharges}`;
      return Response.json({ data: { id, hosted_checkout_url: `https://checkout.opennode.com/${id}` } });
    }
    return new Response('unexpected outbound call', { status: 502 });
  },
});

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

try {
  const { db, fetch } = worker;
  const setting = (key, value) =>
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
  const secret = async (name, value) => setting(`enc:${name}`, await encryptSecret(SECRETS_KEK, value));
  await setting('setup_complete', '1');
  await db
    .prepare(
      `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
       VALUES (?, 'Bol en grès', 'bol-en-gres', '', 2400, 'eur', 50, 1)`,
    )
    .bind(PRODUCT)
    .run();

  const post = (path, fields) =>
    fetch(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams(fields).toString(),
    });
  const postJson = (body) =>
    fetch('/api/checkout', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** The address the newest pending checkout keeps for its order. */
  const lastPendingAddress = async () => {
    const row = await db.prepare('SELECT ship_address FROM pending_payments ORDER BY rowid DESC LIMIT 1').first();
    return row?.ship_address ? JSON.parse(row.ship_address) : null;
  };
  // Demo picks the first rate by itself: one post places the order.
  const demoForm = { method: 'demo', product_id: PRODUCT, ...ADDRESS };

  console.log('Sans Boxtal');

  await check('the address form asks no phone, and the order stores none', async () => {
    // An incomplete address renders the form again, with what it asks.
    const page = await post('/checkout', { ...demoForm, city: '' });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(t('checkout.error.city')), 'the form was not rendered again');
    assert.ok(!html.includes('name="phone"'), 'the form asked a phone the shop has no use for');
    const placed = await post('/checkout', { ...demoForm, phone: PHONE });
    assert.equal(placed.status, 303, `the order was not placed: ${placed.status}`);
    const stored = await lastPendingAddress();
    assert.equal(stored?.city, 'Nantes');
    assert.ok(!('phone' in stored), 'a posted phone was kept although the shop never asked for it');
  });

  await check('the JSON checkout takes a ship_to without a phone', async () => {
    const response = await postJson({ items: [{ slug: 'bol-en-gres', quantity: 1 }], method: 'demo', ship_to: ADDRESS });
    assert.equal(response.status, 200, await response.clone().text());
  });

  // The v3 pair is what buys a label; its values are never read on this path.
  await secret('boxtal_access_key', 'checkout-phone-suite-access');
  await secret('boxtal_secret_key', 'checkout-phone-suite-secret');

  console.log('Avec les clés Boxtal');

  await check('the address form asks the phone, and refuses an address without one', async () => {
    const page = await post('/checkout', demoForm);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<input[^>]*type="tel"[^>]*name="phone"[^>]*required/);
    assert.ok(html.includes(t('checkout.error.phone')), 'the missing phone was not named');
    assert.ok(!html.includes('name="shipping_label"'), 'the rates were offered without a phone');
    const short = await (await post('/checkout', { ...demoForm, phone: '12 34' })).text();
    assert.ok(short.includes(t('checkout.error.phone')), 'a number too short to text was taken');
  });

  await check('the phone rides the rate step to the pending checkout', async () => {
    // A real rail closes the demo one: OpenNode for this check only.
    await secret('opennode_api_key', 'checkout-phone-suite-opennode');
    try {
      const openNodeForm = { ...demoForm, method: 'opennode', phone: PHONE };
      const page = await post('/checkout', openNodeForm);
      assert.equal(page.status, 200, `the address step answered ${page.status}`);
      const html = await page.text();
      assert.match(html, new RegExp(`<input type="hidden" name="phone" value="${PHONE}"`));
      assert.ok(html.includes(t('checkout.phoneOnFile', { numero: PHONE })), 'the recap does not show the phone');
      const label = /name="shipping_label" value="([^"]+)"/.exec(html)?.[1];
      assert.ok(label, 'no shipping option was offered');
      const placed = await post('/checkout', { ...openNodeForm, shipping_label: label });
      assert.equal(placed.status, 303, `the order was not placed: ${placed.status}`);
      assert.equal(openNodeCharges, 1, 'OpenNode was never asked for the charge');
      assert.equal((await lastPendingAddress())?.phone, PHONE);
    } finally {
      await db.prepare("DELETE FROM settings WHERE key = 'enc:opennode_api_key'").run();
    }
  });

  await check('the demo rail carries the phone to the paid order', async () => {
    const placed = await post('/checkout', { ...demoForm, phone: PHONE });
    assert.equal(placed.status, 303, `the order was not placed: ${placed.status}`);
    assert.equal((await lastPendingAddress())?.phone, PHONE);

    // Approved on the demo pay page, the order keeps the same snapshot.
    const pay = await post(new URL(placed.headers.get('location')).pathname, { outcome: 'approve' });
    assert.equal(pay.status, 303, `the demo payment did not settle: ${pay.status}`);
    const order = await db.prepare('SELECT ship_address FROM orders ORDER BY id DESC LIMIT 1').first();
    assert.equal(JSON.parse(order.ship_address).phone, PHONE);
  });

  await check('the demo rail fills a fictional phone with its sample address', async () => {
    const placed = await fetch(`/checkout?method=demo&product_id=${PRODUCT}`);
    assert.equal(placed.status, 303, `the demo checkout did not submit itself: ${placed.status}`);
    assert.equal((await lastPendingAddress())?.phone, '06 39 98 00 00');
  });

  await check('the JSON checkout asks ship_to for the phone, and keeps it', async () => {
    const items = [{ slug: 'bol-en-gres', quantity: 1 }];
    const without = await postJson({ items, method: 'demo', ship_to: ADDRESS });
    assert.equal(without.status, 400);
    assert.match((await without.json()).error, /phone/);
    const short = await postJson({ items, method: 'demo', ship_to: { ...ADDRESS, phone: '12' } });
    assert.equal(short.status, 400);
    const placed = await postJson({ items, method: 'demo', ship_to: { ...ADDRESS, phone: PHONE } });
    assert.equal(placed.status, 200, await placed.clone().text());
    assert.equal((await lastPendingAddress())?.phone, PHONE);
  });

  await check('Stripe’s hosted page is told to collect the phone with the address', async () => {
    await secret('stripe_secret_key', 'sk_test_checkout_phone');
    await secret('stripe_webhook_secret', 'whsec_checkout_phone');
    const form = await post('/api/checkout', { method: 'stripe', product_id: PRODUCT, country: 'FR' });
    assert.equal(form.status, 303, `the card checkout did not start: ${form.status}`);
    const json = await postJson({ items: [{ slug: 'bol-en-gres', quantity: 1 }], method: 'stripe' });
    assert.equal(json.status, 200, await json.clone().text());
    assert.equal(stripeSessions.length, 2, 'Stripe was not asked for both sessions');
    for (const session of stripeSessions) {
      assert.equal(session.get('phone_number_collection[enabled]'), 'true');
      assert.equal(session.get('shipping_address_collection[allowed_countries][0]'), 'FR');
    }

    // Without the Boxtal keys, the same sessions ask for no phone.
    await db.prepare("DELETE FROM settings WHERE key IN ('enc:boxtal_access_key', 'enc:boxtal_secret_key')").run();
    await post('/api/checkout', { method: 'stripe', product_id: PRODUCT, country: 'FR' });
    assert.equal(stripeSessions.length, 3);
    assert.equal(stripeSessions[2].get('phone_number_collection[enabled]'), null);
  });
} finally {
  await worker.dispose();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nLe téléphone du destinataire suit chaque chemin de la commande.');
