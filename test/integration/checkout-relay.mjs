/**
 * The relay point step of /checkout (ticket #123, plan §13.3, lot 4), on the
 * built Worker.
 *
 * What only the pipeline shows: that a relay rate reaches the rate step only
 * while Boxtal can search and buy, and only where its search finds a point;
 * that the point a shopper posts is believed only if the shop served it; that
 * the search is asked once per address and offer; and that the point rides the
 * reservation to the paid order, with `delivery_method` = `relay`. And that a
 * card payment to a zone with a relay rate takes the same steps, the address
 * typed once: Stripe's session charges the chosen rate and asks nothing again,
 * and its webhook settles an order that takes the address from the
 * reservation. The pieces are units of their own (features/shipping/relay.ts,
 * the calculator).
 *
 * Boxtal answers with the search recorded in its sandbox (test/fixtures/boxtal/
 * `02`: Mondial Relay around Paris 11e). The option is switched on by the
 * `RELAY_POINTS` var, as a local run sets it; a deployed shop sets
 * `features.relayPoints` in its store.config.ts instead.
 *
 * Run: node --experimental-strip-types test/integration/checkout-relay.mjs
 * (after a build — `npm run verify` builds first.)
 */
import assert from 'node:assert/strict';
import { startBuiltWorker } from '../helpers/built-worker.mjs';
import { recorded } from '../helpers/boxtal-corpus.mjs';
import { encryptSecret } from '../../src/features/secrets/crypto.ts';
import { hashPassword } from '../../src/features/auth/password.ts';
import { saveRuntimeShippingConfig } from '../../src/features/shipping/settings.ts';
import { t } from '../../src/features/i18n/index.ts';

const ORIGIN = 'https://store.test';
const SECRETS_KEK = 'checkout-relay-suite-key-encryption-key';
const WEBHOOK_SECRET = 'whsec_checkout_relay';
const AUTH_SECRET = 'checkout-relay-suite-auth-secret';
const PASSWORD = 'checkout-relay-suite-password';
const FORM = 'application/x-www-form-urlencoded';
const PRODUCT = 'prod_rxy0000001';
const ADDRESS = {
  email: 'acheteur@exemple.fr',
  name: 'Dominique Essai',
  line1: '12 rue Pache',
  city: 'Paris',
  postal: '75011',
  country: 'FR',
  // From the ranges ARCEP keeps for fiction: it reaches nobody.
  phone: '06 39 98 00 02',
};
const MONDIAL = recorded('02-parcel-points-by-offer-mondial-relay').response.body;
const MONDIAL_CODES = MONDIAL.content.map((entry) => entry.parcelPoint.code);

/** Searches Boxtal was asked, by offer. */
const searches = {};
let openNodeCharges = 0;
/** Every Checkout Session the Worker asked Stripe for, as posted. */
const stripeSessions = [];
/** A posted session's one rate field, `shipping_options[0][shipping_rate_data]…`. */
const rateField = (session, name) => session.get(`shipping_options[0][shipping_rate_data]${name}`);

const worker = await startBuiltWorker({
  vars: { CANONICAL_ORIGIN: ORIGIN, SECRETS_KEK, AUTH_SECRET, RELAY_POINTS: 'on' },
  async outbound(request) {
    const url = new URL(request.url);
    if (url.hostname === 'api.boxtal.build' && url.pathname === '/shipping/v3.2/parcel-point-by-shipping-offer') {
      const offer = url.searchParams.get('shippingOfferCode');
      searches[offer] = (searches[offer] ?? 0) + 1;
      // Mondial Relay answers; Chronopost is down, as a provider sometimes is.
      if (offer === 'MONR-CpourToi') return Response.json(MONDIAL);
      return Response.json({ status: 500, errors: [] }, { status: 500 });
    }
    if (url.hostname === 'api.opennode.com' && url.pathname === '/v1/charges') {
      const id = `charge_relay_${++openNodeCharges}`;
      return Response.json({ data: { id, hosted_checkout_url: `https://checkout.opennode.com/${id}` } });
    }
    if (url.hostname === 'api.stripe.com' && url.pathname === '/v1/checkout/sessions') {
      stripeSessions.push(new URLSearchParams(await request.text()));
      const id = `cs_test_relay${stripeSessions.length}`;
      return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    // The rate a session made, read back at settlement: what the shop posted.
    const rate = url.hostname === 'api.stripe.com' && url.pathname.match(/^\/v1\/shipping_rates\/shr_relay(\d+)$/);
    if (rate) {
      const posted = stripeSessions[Number(rate[1]) - 1];
      return Response.json({
        id: `shr_relay${rate[1]}`,
        object: 'shipping_rate',
        display_name: rateField(posted, '[display_name]'),
        metadata: { delivery: rateField(posted, '[metadata][delivery]') },
      });
    }
    return new Response('unexpected outbound call', { status: 502 });
  },
});

/** Stripe's scheme: HMAC-SHA256 over `<timestamp>.<payload>`, hex, as v1. */
async function stripeSignature(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

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
       VALUES (?, 'Théière en fonte', 'theiere-en-fonte', '', 3900, 'eur', 50, 1)`,
    )
    .bind(PRODUCT)
    .run();
  const saved = await saveRuntimeShippingConfig(db, 0, {
    enabled: true,
    packageWeightGrams: 0,
    zones: [
      // First, so it is what a form without a country falls back to.
      {
        name: 'Belgique',
        countries: ['BE'],
        freeOverCents: null,
        rates: [{ label: 'Bpost à domicile', pricing: { type: 'flat', amountCents: 990 } }],
      },
      {
        name: 'France',
        countries: ['FR'],
        freeOverCents: null,
        rates: [
          { label: 'Colissimo à domicile', pricing: { type: 'flat', amountCents: 690 } },
          {
            label: 'Mondial Relay',
            pricing: { type: 'relay', offer: 'MONR-CpourToi', price: { type: 'flat', amountCents: 390 } },
          },
          {
            label: 'Chrono Relais',
            pricing: { type: 'relay', offer: 'CHRP-ChronoRelais', price: { type: 'flat', amountCents: 490 } },
          },
        ],
      },
    ],
  });
  assert.equal(saved.ok, true, 'the shipping document was refused');

  const post = (fields) =>
    fetch('/checkout', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams(fields).toString(),
    });
  const reservations = async () => (await db.prepare('SELECT COUNT(*) AS n FROM checkout_reservations').first()).n;
  const rateLabels = (html) => [...html.matchAll(/name="shipping_label" value="([^"]+)"/g)].map((m) => m[1]);
  const pointCodes = (html) => [...html.matchAll(/name="relay_point" value="([^"]+)"/g)].map((m) => m[1]);
  // OpenNode, a real rail: its rate step is not skipped as the demo's is.
  const openNode = { method: 'opennode', product_id: PRODUCT, ...ADDRESS };
  await secret('opennode_api_key', 'checkout-relay-suite-opennode');

  console.log('Sans les clés Boxtal');

  await check('no relay rate is offered, and Boxtal is never asked', async () => {
    const html = await (await post(openNode)).text();
    assert.deepEqual(rateLabels(html), ['Colissimo à domicile']);
    assert.deepEqual(searches, {});
  });

  // The v3 pair is what searches and buys; its values never leave the stub.
  await secret('boxtal_access_key', 'checkout-relay-suite-access');
  await secret('boxtal_secret_key', 'checkout-relay-suite-secret');

  console.log('Avec les clés Boxtal');

  await check('a relay rate is offered where its search finds a point, and only there', async () => {
    worker.clearLogs();
    const page = await post(openNode);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.deepEqual(rateLabels(html), ['Colissimo à domicile', 'Mondial Relay']);
    assert.ok(html.includes(t('checkout.relay.rateHint')), 'the relay rate does not say it is a relay');
    // Chronopost's search failed: its rate leaves the choice, the order goes on.
    assert.equal(searches['CHRP-ChronoRelais'], 1);
    assert.match(worker.logs(), /"event":"relay_points_unavailable","offer":"CHRP-ChronoRelais"/);
    assert.ok(!worker.logs().includes('75011'), 'the address reached the log');
  });

  await check('a relay rate leads to the points, and reserves nothing yet', async () => {
    const before = await reservations();
    const html = await (await post({ ...openNode, shipping_label: 'Mondial Relay' })).text();
    assert.deepEqual(pointCodes(html), MONDIAL_CODES);
    assert.ok(html.includes('ART THE ZEN'), 'the nearest point is not named');
    assert.ok(html.includes(t('checkout.relay.choose')));
    assert.match(html, /<input type="hidden" name="shipping_label" value="Mondial Relay"/);
    assert.equal(await reservations(), before, 'stock was held before a point was chosen');
  });

  await check('the search is asked once per address and offer', async () => {
    // Three rate steps so far, a spaced postcode now: one search all along.
    await post({ ...openNode, postal: '75 011' });
    assert.equal(searches['MONR-CpourToi'], 1);
  });

  await check('a point the shop did not serve is refused', async () => {
    const before = await reservations();
    const html = await (await post({ ...openNode, shipping_label: 'Mondial Relay', relay_point: '99999' })).text();
    assert.ok(html.includes(t('checkout.error.relayPointGone')), 'a forged point was not named as gone');
    assert.deepEqual(pointCodes(html), MONDIAL_CODES);
    assert.equal(await reservations(), before);
    assert.equal(openNodeCharges, 0);
  });

  await check('going back to the rates keeps the relay rate selected', async () => {
    const html = await (await post({ ...openNode, shipping_label: 'Mondial Relay', change_rate: '1' })).text();
    assert.deepEqual(rateLabels(html), ['Colissimo à domicile', 'Mondial Relay']);
    assert.match(html, /name="shipping_label" value="Mondial Relay" checked/);
    assert.deepEqual(pointCodes(html), []);
  });

  await check('the chosen point rides the reservation, and the rate says relay', async () => {
    const placed = await post({ ...openNode, shipping_label: 'Mondial Relay', relay_point: MONDIAL_CODES[0] });
    assert.equal(placed.status, 303, `the order was not placed: ${placed.status}`);
    assert.equal(openNodeCharges, 1);
    const pending = await db
      .prepare('SELECT reservation_id, delivery_method, shipping_cents, shipping_label FROM pending_payments ORDER BY rowid DESC LIMIT 1')
      .first();
    assert.equal(pending.delivery_method, 'relay');
    assert.equal(pending.shipping_cents, 390);
    assert.equal(pending.shipping_label, 'Mondial Relay');
    const reservation = await db
      .prepare('SELECT relay_point FROM checkout_reservations WHERE public_id = ?')
      .bind(pending.reservation_id)
      .first();
    assert.deepEqual(JSON.parse(reservation.relay_point), {
      offer: 'MONR-CpourToi',
      code: '41132',
      name: 'ART THE ZEN',
      street: '5 RUE PACHE',
      postalCode: '75011',
      city: 'PARIS',
      country: 'FR',
    });
  });

  await check('a home rate carries no point', async () => {
    const placed = await post({ ...openNode, shipping_label: 'Colissimo à domicile', relay_point: MONDIAL_CODES[0] });
    assert.equal(placed.status, 303);
    const pending = await db
      .prepare('SELECT reservation_id, delivery_method FROM pending_payments ORDER BY rowid DESC LIMIT 1')
      .first();
    assert.equal(pending.delivery_method, 'shipping');
    const reservation = await db
      .prepare('SELECT relay_point FROM checkout_reservations WHERE public_id = ?')
      .bind(pending.reservation_id)
      .first();
    assert.equal(reservation.relay_point, null);
  });

  await db.prepare("DELETE FROM settings WHERE key = 'enc:opennode_api_key'").run();
  /** The demo order's page, as its payment hands it back. */
  let demoOrderPage = null;

  await check('the paid order keeps the point, copied from the reservation', async () => {
    const demo = { method: 'demo', product_id: PRODUCT, ...ADDRESS };
    const placed = await post({ ...demo, shipping_label: 'Mondial Relay', relay_point: MONDIAL_CODES[1] });
    assert.equal(placed.status, 303, `the demo order was not placed: ${placed.status}`);
    const pay = await fetch(new URL(placed.headers.get('location')).pathname, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams({ outcome: 'approve' }).toString(),
    });
    assert.equal(pay.status, 303, `the demo payment did not settle: ${pay.status}`);
    demoOrderPage = new URL(pay.headers.get('location'), ORIGIN).pathname;
    const order = await db
      .prepare('SELECT delivery_method, relay_point, ship_address FROM orders ORDER BY id DESC LIMIT 1')
      .first();
    assert.equal(order.delivery_method, 'relay');
    assert.equal(JSON.parse(order.relay_point).code, MONDIAL_CODES[1]);
    // The buyer stays the label's recipient and contact.
    assert.equal(JSON.parse(order.ship_address).phone, ADDRESS.phone);
  });

  console.log('Par carte');

  await secret('stripe_secret_key', 'sk_test_checkout_relay');
  await secret('stripe_webhook_secret', WEBHOOK_SECRET);
  const card = { method: 'stripe', product_id: PRODUCT, ...ADDRESS };
  const toStripe = (fields) =>
    fetch('/api/checkout', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams({ method: 'stripe', product_id: PRODUCT, ...fields }).toString(),
    });

  await check('a card payment to a zone with a relay rate goes through /checkout first', async () => {
    const sent = await toStripe({ country: 'FR' });
    assert.equal(sent.status, 303);
    const location = new URL(sent.headers.get('location'), ORIGIN);
    assert.equal(location.pathname, '/checkout');
    assert.equal(location.searchParams.get('method'), 'stripe');
    assert.equal(location.searchParams.get('country'), 'FR');
    assert.equal(stripeSessions.length, 0, 'Stripe was asked before the shopper chose a rate');
    // The address form opens on the destination the cart was priced for.
    const html = await (await fetch(`${location.pathname}${location.search}`)).text();
    assert.match(html, /<option value="FR" selected/);
  });

  await check('a zone without a relay rate still goes straight to Stripe', async () => {
    const sent = await toStripe({ country: 'BE' });
    assert.equal(sent.status, 303);
    assert.match(sent.headers.get('location'), /^https:\/\/checkout\.stripe\.com\//);
    const session = stripeSessions.at(-1);
    assert.equal(session.get('shipping_address_collection[allowed_countries][0]'), 'BE');
    assert.equal(rateField(session, '[display_name]'), 'Bpost à domicile');
  });

  // The relay session, paid below: its number names its rate in the stub.
  let relaySession = 0;

  await check('Stripe charges the chosen relay rate, and asks for no address', async () => {
    assert.deepEqual(pointCodes(await (await post({ ...card, shipping_label: 'Mondial Relay' })).text()), MONDIAL_CODES);
    const placed = await post({ ...card, shipping_label: 'Mondial Relay', relay_point: MONDIAL_CODES[2] });
    assert.equal(placed.status, 303, `the card order was not handed to Stripe: ${placed.status}`);
    assert.match(placed.headers.get('location'), /^https:\/\/checkout\.stripe\.com\//);
    relaySession = stripeSessions.length;
    const session = stripeSessions[relaySession - 1];
    assert.equal(session.get('shipping_address_collection[allowed_countries][0]'), null);
    assert.equal(session.get('phone_number_collection[enabled]'), null);
    assert.equal(session.get('customer_email'), ADDRESS.email);
    assert.equal(rateField(session, '[display_name]'), 'Mondial Relay');
    assert.equal(rateField(session, '[fixed_amount][amount]'), '390');
    assert.equal(rateField(session, '[metadata][delivery]'), 'relay');
    assert.equal(session.get('shipping_options[1][shipping_rate_data][display_name]'), null, 'another rate was offered');
    // The address waits on the reservation, beside the point.
    const reservation = await db
      .prepare('SELECT ship_address, relay_point FROM checkout_reservations WHERE public_id = ?')
      .bind(session.get('metadata[reservation_id]'))
      .first();
    assert.equal(JSON.parse(reservation.ship_address).phone, ADDRESS.phone);
    assert.equal(JSON.parse(reservation.relay_point).code, MONDIAL_CODES[2]);
  });

  await check('the paid session settles an order with the address typed in the shop', async () => {
    const session = stripeSessions[relaySession - 1];
    const metadata = Object.fromEntries(
      [...session].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value]),
    );
    // What Stripe sends once its page asked no address: no shipping_details.
    const payload = JSON.stringify({
      id: 'evt_checkout_relay_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_relay${relaySession}`,
          object: 'checkout.session',
          currency: 'eur',
          payment_status: 'paid',
          payment_intent: 'pi_checkout_relay_1',
          amount_total: 3900 + 390,
          customer_details: { email: ADDRESS.email, phone: null },
          metadata,
          total_details: { amount_shipping: 390, amount_discount: 0, amount_tax: 0 },
          shipping_cost: { amount_total: 390, shipping_rate: `shr_relay${relaySession}` },
        },
      },
    });
    const delivered = await fetch('/api/webhook/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': await stripeSignature(payload) },
      body: payload,
    });
    assert.equal(delivered.status, 200, `the webhook was refused: ${delivered.status}`);
    const order = await db
      .prepare('SELECT delivery_method, shipping_label, shipping_cents, relay_point, ship_address FROM orders WHERE public_id = ?')
      .bind(metadata.public_id)
      .first();
    assert.ok(order, 'the paid session wrote no order');
    assert.equal(order.delivery_method, 'relay');
    assert.equal(order.shipping_label, 'Mondial Relay');
    assert.equal(order.shipping_cents, 390);
    assert.equal(JSON.parse(order.relay_point).code, MONDIAL_CODES[2]);
    const address = JSON.parse(order.ship_address);
    assert.equal(address.line1, ADDRESS.line1);
    assert.equal(address.phone, ADDRESS.phone);
    // The order holds it now; the reservation lets it go.
    const reservation = await db
      .prepare('SELECT status, ship_address FROM checkout_reservations WHERE public_id = ?')
      .bind(metadata.reservation_id)
      .first();
    assert.equal(reservation.status, 'settled');
    assert.equal(reservation.ship_address, null);
  });

  console.log('Après la commande');

  // Fixture `02`'s second point, where the demo order goes.
  const chosen = MONDIAL.content[1].parcelPoint;
  const demoOrder = await db
    .prepare("SELECT public_id FROM orders WHERE payment_method = 'demo' ORDER BY id DESC LIMIT 1")
    .first();

  await check('the buyer’s order page names the point to collect the parcel at', async () => {
    assert.ok(demoOrderPage?.startsWith('/order/'), `no order page: ${demoOrderPage}`);
    const html = await (await fetch(demoOrderPage)).text();
    assert.ok(html.includes(t('order.relayPoint')), 'the page does not speak of a relay point');
    assert.ok(html.includes(chosen.name), 'the point is not named');
    // The code is the carrier's business, not the buyer's.
    assert.ok(!html.includes(`>${chosen.code}<`));
  });

  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?)")
    .bind(await hashPassword(PASSWORD))
    .run();
  const login = await fetch('/admin/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': FORM },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
  });
  const admin = { headers: { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] } };

  await check('the order page in the admin shows the point and its code', async () => {
    assert.equal(login.status, 303, 'the admin login failed');
    const page = await fetch(`/admin/orders/${demoOrder.public_id}`, admin);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(chosen.name), 'the point is not named');
    assert.ok(html.includes(`Code ${chosen.code}, offre Mondial Relay`), 'the code is not given');
  });

  await check('the order export carries the delivery mode and the point', async () => {
    const csv = await (await fetch('/admin/orders/export.csv', admin)).text();
    const [header, ...rows] = csv.trim().split('\r\n');
    assert.ok(header.endsWith(',Delivery,Relay point code,Relay point'), header);
    const relayRows = rows.filter((row) => row.includes(`,relay,${chosen.code},`));
    assert.equal(relayRows.length, 1, 'the demo relay order is not exported with its point');
    assert.ok(relayRows[0].includes(chosen.name));
    // The card order too, at its own point.
    assert.equal(rows.filter((row) => row.includes(`,relay,${MONDIAL_CODES[2]},`)).length, 1);
  });
} finally {
  await worker.dispose();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nLe point relais choisi à la commande arrive jusqu’à la commande payée, par carte comme en bitcoin.');
