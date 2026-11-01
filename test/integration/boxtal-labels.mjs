import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { applyMigrations } from '../helpers/d1-schema.mjs';
import { recorded, replay } from '../helpers/boxtal-corpus.mjs';
import { boxtalLabels } from '../../src/features/shipping/boxtal/v3.ts';
import { boxtalQuote } from '../../src/features/shipping/boxtal/quote.ts';
import {
  buyLabel,
  labelDocumentUrl,
  parseQuotedOffers,
  prepareLabel,
  refreshLabelTracking,
  settleWithBoxtalId,
} from '../../src/features/shipping/boxtal/orderLabel.ts';
import { getLabelRecord, listLabelAttempts } from '../../src/features/shipping/labelStore.ts';
import { t } from '../../src/features/i18n/index.ts';

// A label bought from Boxtal for an order (ADR 0021; plan §13.3, lots 3 and 5),
// on the real schema, every migration applied, and the answers the sandbox
// actually gave (test/fixtures/boxtal/). The properties are the ones the ADR
// asks of this lot: a label buys without the optional v1 quote and with a
// failing one, an uncertain purchase is settled only by an id whose parcel
// carries the attempt's reference, and a purchase Boxtal has not confirmed
// yet stays bought until the number arrives. A relay order buys on the offer
// of the point its buyer chose, to that point, whatever offers are retained.
//
// The reference is pinned to the one the corpus carries (`essai-att-mvva9992`
// for `44`-`52`, `essai-dom-mvv4seit` for `10`-`14`, `essai-rel-mvv4seit` for
// the relay order `11`). No request leaves the
// process: a step that asks for an answer the test did not queue fails.

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-20',
  d1Databases: ['DB'],
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

const KEYS = { accessKey: 'v3-access', secretKey: 'v3-secret' };
const QUOTE_KEYS = { accessKey: 'v1-access', secretKey: 'v1-secret' };
const CONTENT = 'content:v1:40110';
const PENDING_ID = '2610301905POFR56EJFR';
const HOME_ID = '2610301632POFR56E7FR';
const RELAY_ID = '2610301632MONR56E8FR';
// The point the relay order `11` was bought to, as the checkout snapshots it.
const POINT = {
  offer: 'MONR-CpourToi',
  code: '41132',
  name: 'ART THE ZEN',
  street: '5 RUE PACHE',
  postalCode: '75011',
  city: 'PARIS',
  country: 'FR',
};

// The corpus's sender and recipient (fictional), so the quote and the purchase
// ask what the sandbox answered.
const SENDER = {
  company: 'Boutique Essai',
  firstName: 'Boutique',
  lastName: 'Essai',
  email: 'expediteur@example.com',
  phone: '+33612345678',
  street: '10 rue de Rivoli',
  city: 'Paris',
  postalCode: '75004',
  country: 'FR',
};
const PARCEL = { lengthCm: 30, widthCm: 20, heightCm: 10, weightGrams: 800 };
const RECIPIENT = { firstName: 'Jeanne', lastName: 'Essai', phone: '+33698765432' };

/**
 * The steps' context. `labels` and `quote` are the corpus answers queued for
 * v3 and v1; `quote: null` is a shop without the v1 keys.
 */
function context(db, { labels = [], quote = null, offers = ['POFR-ColissimoAccess'], reference = 'essai-att-mvva9992' } = {}) {
  const v3 = typeof labels === 'function' ? { fetch: labels, sent: [] } : replay(...labels);
  return {
    ctx: {
      db,
      labels: boxtalLabels({ keys: KEYS, sandbox: true, fetch: v3.fetch }),
      quote: quote ? boxtalQuote({ keys: QUOTE_KEYS, sandbox: true, fetch: replay(...quote).fetch }) : null,
      offers,
      contentId: CONTENT,
      currency: 'EUR',
      pause: async () => {},
      reference: () => reference,
    },
    sent: v3.sent,
  };
}

let orders = 0;
/**
 * A paid, unfulfilled delivery order whose goods are worth 42,40 € (the
 * corpus's declared value); with a point, a relay order.
 */
async function newOrder(db, point = null) {
  orders++;
  const publicId = `ord_bxtl${String(orders).padStart(6, '0')}`;
  const address = JSON.stringify({
    name: 'Jeanne Essai',
    line1: '5 rue Pache',
    line2: null,
    city: 'Paris',
    state: null,
    postal: '75011',
    country: 'FR',
  });
  await db
    .prepare(
      `INSERT INTO orders (public_id, email, amount_total_cents, shipping_cents, currency, status,
                           fulfillment_status, delivery_method, ship_address, relay_point)
       VALUES (?1, 'destinataire@example.com', 4930, 690, 'eur', 'paid', 'unfulfilled', ?3, ?2, ?4)`,
    )
    .bind(publicId, address, point ? 'relay' : 'shipping', point ? JSON.stringify(point) : null)
    .run();
  return db.prepare('SELECT * FROM orders WHERE public_id = ?1').bind(publicId).first();
}

const orderRow = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first();
const shippedNotices = async (db, id) =>
  (
    await db
      .prepare("SELECT COUNT(*) AS n FROM order_notifications WHERE order_id = ?1 AND kind = 'order-shipped'")
      .bind(id)
      .first()
  ).n;
const expectFailure = (outcome, message) => {
  assert.equal(outcome.ok, false, `expected a refusal, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.error, message);
};

try {
  const db = await mf.getD1Database('DB');
  await applyMigrations(db);

  await check('without the v1 keys, offers buy unpriced and the label lands on the order', async () => {
    const order = await newOrder(db);
    const { ctx, sent } = context(db, { labels: ['44-order-home-pending', '49-tracking-confirmed'] });

    assert.deepEqual(await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL }), {
      ok: true,
      message: '',
      fulfilled: false,
    });
    const quoted = await getLabelRecord(db, order.id);
    assert.equal(quoted.vendor, 'boxtal');
    assert.equal(quoted.status, 'quoted');
    assert.equal(quoted.shipment_id, 'essai-att-mvva9992');
    // No price is shown before the purchase, and nothing reached Boxtal.
    assert.deepEqual(parseQuotedOffers(quoted.offers), {
      offers: [
        {
          code: 'POFR-ColissimoAccess',
          carrier: 'Colissimo',
          service: 'Colissimo Domicile - sans signature',
          priceExclTaxCents: null,
          currency: null,
          available: true,
        },
      ],
      quoteError: null,
    });
    assert.equal(sent.length, 0);
    // The buyer's contact never rests on the row: only the merchant's sender.
    assert.ok(!quoted.parcel.includes('Jeanne') && !quoted.parcel.includes('destinataire'));

    const bought = await buyLabel(ctx, order, { offerCode: 'POFR-ColissimoAccess', recipient: RECIPIENT });
    assert.equal(bought.ok, true, JSON.stringify(bought));
    assert.equal(bought.fulfilled, true);

    // What was asked of Boxtal is what its sandbox accepted (`44`).
    const asked = recorded('44-order-home-pending').request.body;
    assert.equal(sent[0].method, 'POST');
    assert.ok(sent[0].url.endsWith('/shipping/v3.1/shipping-order'));
    assert.equal(sent[0].body.shippingOfferCode, asked.shippingOfferCode);
    assert.equal(sent[0].body.shipment.externalId, asked.shipment.externalId);
    assert.deepEqual(sent[0].body.shipment.packages[0].value, asked.shipment.packages[0].value);
    assert.equal(sent[0].body.shipment.packages[0].externalId, asked.shipment.packages[0].externalId);
    assert.equal(sent[0].body.shipment.packages[0].content.id, CONTENT);
    assert.deepEqual(sent[0].body.shipment.toAddress.contact, asked.shipment.toAddress.contact);
    assert.ok(sent[1].url.endsWith(`/shipping-order/${PENDING_ID}/tracking`));
    assert.equal(sent.length, 2);

    const after = await orderRow(db, order.id);
    assert.equal(after.fulfillment_status, 'fulfilled');
    assert.equal(after.tracking_carrier, 'colissimo');
    assert.equal(after.tracking_number, 'CR261030000000000UYY');
    assert.equal(after.tracking_url, 'https://www.laposte.fr/outils/suivre-vos-envois?code=CR261030000000000UYY1');
    assert.equal(after.label_url, null, 'the label is read again on demand, never stored');
    assert.equal(await shippedNotices(db, order.id), 1);

    const label = await getLabelRecord(db, order.id);
    assert.equal(label.status, 'purchased');
    assert.equal(label.transaction_id, PENDING_ID);
    assert.equal(label.amount_cents, 811);
    assert.equal(label.tracking_number, 'CR261030000000000UYY');
    const [attempt] = await listLabelAttempts(db, order.id);
    assert.equal(attempt.outcome, 'purchased');
    assert.equal(attempt.vendor, 'boxtal');
    assert.equal(attempt.tracking_number, 'CR261030000000000UYY');
  });

  await check('a failing v1 quote leaves every offer buyable, unpriced', async () => {
    const order = await newOrder(db);
    const { ctx } = context(db, {
      quote: ['39-cotation-no-auth'],
      labels: ['10-order-home-colissimo', '14-tracking-home-t0'],
      reference: 'essai-dom-mvv4seit',
    });
    assert.equal((await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL })).ok, true);
    const quoted = parseQuotedOffers((await getLabelRecord(db, order.id)).offers);
    assert.ok(quoted.quoteError, 'the reason the quote failed is kept for the page');
    assert.deepEqual(
      quoted.offers.map((offer) => [offer.code, offer.priceExclTaxCents, offer.available]),
      [['POFR-ColissimoAccess', null, true]],
    );

    const bought = await buyLabel(ctx, order, { offerCode: 'POFR-ColissimoAccess', recipient: RECIPIENT });
    assert.equal(bought.ok && bought.fulfilled, true, JSON.stringify(bought));
    assert.equal((await orderRow(db, order.id)).tracking_number, 'CR261030000000000UYM');
  });

  await check('a priced quote shows prices, and an offer it did not price cannot be bought', async () => {
    const order = await newOrder(db);
    const retained = ['MONR-DomicileFrance', 'POFR-ColissimoAccess', 'POFR-ColissimoExpert', 'UPSE-Express'];
    const { ctx, sent } = context(db, { quote: ['33-cotation-eight-offers'], offers: retained, labels: ['43-order-home-no-phone'] });
    assert.equal((await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL })).ok, true);
    const quoted = parseQuotedOffers((await getLabelRecord(db, order.id)).offers);
    assert.equal(quoted.quoteError, null);
    assert.deepEqual(
      quoted.offers.map((offer) => [offer.code, offer.priceExclTaxCents, offer.available]),
      [
        ['MONR-DomicileFrance', 810, true],
        ['POFR-ColissimoAccess', 811, true],
        ['POFR-ColissimoExpert', 906, true],
        ['UPSE-Express', null, false],
      ],
    );

    const buy = (offerCode, recipient = RECIPIENT, offers = retained) =>
      buyLabel({ ...ctx, offers }, order, { offerCode, recipient });
    expectFailure(await buy('UPSE-Express'), t('admin.orders.notice.boxtal.offerNotOffered'));
    expectFailure(await buy(''), t('admin.orders.notice.boxtal.pickOffer'));
    expectFailure(await buy('MONR-CpourToi'), t('admin.orders.notice.boxtal.pickOffer'));
    // Retained when quoted, dropped in Réglages since: not bought.
    expectFailure(await buy('MONR-DomicileFrance', RECIPIENT, ['POFR-ColissimoAccess']), t('admin.orders.notice.boxtal.offerNotRetained'));
    // Boxtal requires the recipient's phone (`43`): asked before anything is sent.
    expectFailure(await buy('POFR-ColissimoAccess', { ...RECIPIENT, phone: '' }), t('admin.orders.notice.boxtal.recipientIncomplete'));
    expectFailure(await buy('POFR-ColissimoAccess', { ...RECIPIENT, phone: '12 34' }), t('admin.orders.notice.boxtal.recipientIncomplete'));
    expectFailure(await buy('POFR-ColissimoAccess', { ...RECIPIENT, firstName: ' ' }), t('admin.orders.notice.boxtal.recipientIncomplete'));
    assert.equal(sent.length, 0);
    assert.equal((await getLabelRecord(db, order.id)).status, 'quoted');

    // A refusal Boxtal judged (422) is definite: the attempt fails, nothing is parked.
    const refused = await buy('POFR-ColissimoAccess');
    assert.equal(refused.ok, false);
    const failed = await getLabelRecord(db, order.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /422/);
    assert.deepEqual((await listLabelAttempts(db, order.id)).map((attempt) => attempt.outcome), ['failed']);
    // …and the label can be prepared again.
    const again = context(db, { offers: retained });
    assert.equal((await prepareLabel(again.ctx, order, { from: SENDER, parcel: PARCEL })).ok, true);
  });

  await check('an uncertain purchase is settled only by an id whose parcel carries its reference', async () => {
    const order = await newOrder(db);
    const lost = context(db, {
      labels: async () => {
        throw new Error('connection reset');
      },
    });
    assert.equal((await prepareLabel(lost.ctx, order, { from: SENDER, parcel: PARCEL })).ok, true);
    const bought = await buyLabel(lost.ctx, order, { offerCode: 'POFR-ColissimoAccess', recipient: RECIPIENT });
    expectFailure(
      bought,
      t('admin.orders.notice.boxtal.uncertain', {
        erreur: t('admin.shipping.boxtal.unreachable'),
        reference: 'essai-att-mvva9992',
      }),
    );
    assert.equal((await getLabelRecord(db, order.id)).status, 'uncertain');
    // Nothing buys again, and nothing re-quotes over it.
    expectFailure(
      await buyLabel(lost.ctx, order, { offerCode: 'POFR-ColissimoAccess', recipient: RECIPIENT }),
      t('admin.orders.notice.labelNoQuote'),
    );
    expectFailure(await prepareLabel(lost.ctx, order, { from: SENDER, parcel: PARCEL }), t('admin.orders.notice.labelQuoteRefused'));

    const settle = (id, ...answers) => settleWithBoxtalId(context(db, { labels: answers }).ctx, order, id);
    expectFailure(await settle('pas un identifiant !'), t('admin.orders.notice.boxtal.badId'));
    expectFailure(
      await settle('2610300000XXXX0000FR', '18-get-order-unknown'),
      t('admin.orders.notice.boxtal.unknownShipment', { envoi: '2610300000XXXX0000FR' }),
    );
    expectFailure(
      await settle(PENDING_ID, '52-get-order-cancelled'),
      t('admin.orders.notice.boxtal.cancelledShipment', { envoi: PENDING_ID }),
    );
    expectFailure(
      await settle(PENDING_ID, '48-get-order-confirmed', '45-tracking-pending'),
      t('admin.orders.notice.boxtal.notConfirmed', { envoi: PENDING_ID }),
    );
    // Another attempt's parcel: a real, confirmed shipment, but not this one.
    expectFailure(
      await settle(HOME_ID, '12-get-order-home', '14-tracking-home-t0'),
      t('admin.orders.notice.boxtal.referenceMismatch', {
        envoi: HOME_ID,
        trouvee: 'essai-dom-mvv4seit-1',
        attendue: 'essai-att-mvva9992',
      }),
    );
    assert.equal((await getLabelRecord(db, order.id)).status, 'uncertain');
    assert.equal((await orderRow(db, order.id)).fulfillment_status, 'unfulfilled');

    const settled = await settle(PENDING_ID, '48-get-order-confirmed', '49-tracking-confirmed', '49-tracking-confirmed');
    assert.equal(settled.ok && settled.fulfilled, true, JSON.stringify(settled));
    const label = await getLabelRecord(db, order.id);
    assert.equal(label.status, 'purchased');
    assert.equal(label.transaction_id, PENDING_ID);
    assert.equal(label.amount_cents, 811);
    const after = await orderRow(db, order.id);
    assert.equal(after.fulfillment_status, 'fulfilled');
    assert.equal(after.tracking_number, 'CR261030000000000UYY');
    assert.equal(await shippedNotices(db, order.id), 1);
    expectFailure(await settle(PENDING_ID), t('admin.orders.notice.boxtal.nothingToSettle'));
  });

  await check('a purchase Boxtal has not confirmed stays bought until the number arrives', async () => {
    const order = await newOrder(db);
    const pending = ['45-tracking-pending', '45-tracking-pending', '45-tracking-pending', '45-tracking-pending'];
    const { ctx, sent } = context(db, { labels: ['44-order-home-pending', ...pending] });
    assert.equal((await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL })).ok, true);
    const bought = await buyLabel(ctx, order, { offerCode: 'POFR-ColissimoAccess', recipient: RECIPIENT });
    assert.equal(bought.ok, true, JSON.stringify(bought));
    assert.equal(bought.fulfilled, false);
    assert.equal(sent.length, 5, 'one purchase, then every tracking read');
    const awaiting = await getLabelRecord(db, order.id);
    assert.equal(awaiting.status, 'purchased');
    assert.equal(awaiting.transaction_id, PENDING_ID);
    assert.equal(awaiting.tracking_number, null);
    assert.equal((await orderRow(db, order.id)).fulfillment_status, 'unfulfilled');
    assert.equal(await shippedNotices(db, order.id), 0);
    // Bought is bought: the merchant cannot quote over it.
    expectFailure(await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL }), t('admin.orders.notice.labelQuoteRefused'));

    const refresh = (...answers) => refreshLabelTracking(context(db, { labels: answers }).ctx, order);
    expectFailure(await refresh('45-tracking-pending'), t('admin.orders.notice.boxtal.trackingNotYet'));
    const landed = await refresh('49-tracking-confirmed');
    assert.equal(landed.ok && landed.fulfilled, true, JSON.stringify(landed));
    assert.equal((await orderRow(db, order.id)).tracking_number, 'CR261030000000000UYY');
    assert.equal(await shippedNotices(db, order.id), 1);
    expectFailure(await refresh(), t('admin.orders.notice.boxtal.nothingToRefresh'));

    // The label document is read again on each download, signed afresh.
    const record = await getLabelRecord(db, order.id);
    const document = await labelDocumentUrl(context(db, { labels: ['50-documents-confirmed'] }).ctx.labels, record);
    assert.equal(document.ok, true);
    assert.ok(document.value.startsWith(`https://document.boxtal.build/shipping-label/${PENDING_ID}_bordereau_1.pdf?`));
    const early = await labelDocumentUrl(context(db, { labels: ['46-documents-pending'] }).ctx.labels, record);
    assert.equal(early.ok, false);
  });

  await check('a relay label buys on the point’s offer, to the point the buyer chose', async () => {
    const order = await newOrder(db, POINT);
    // A home offer retained in Réglages: a relay order does not choose among them.
    const { ctx, sent } = context(db, {
      quote: ['32-cotation-two-offers'],
      offers: ['POFR-ColissimoAccess'],
      labels: ['11-order-relay-mondial-relay-no-dropoff', '19-tracking-relay-t0'],
      reference: 'essai-rel-mvv4seit',
    });
    assert.equal((await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL })).ok, true);
    const quoted = parseQuotedOffers((await getLabelRecord(db, order.id)).offers);
    assert.deepEqual(
      quoted.offers.map((offer) => [offer.code, offer.carrier, offer.priceExclTaxCents, offer.available]),
      [['MONR-CpourToi', 'Mondial Relay', 419, true]],
    );
    expectFailure(
      await buyLabel(ctx, order, { offerCode: 'POFR-ColissimoAccess', recipient: RECIPIENT }),
      t('admin.orders.notice.boxtal.pickOffer'),
    );
    assert.equal(sent.length, 0);

    const bought = await buyLabel(ctx, order, { offerCode: 'MONR-CpourToi', recipient: RECIPIENT });
    assert.equal(bought.ok && bought.fulfilled, true, JSON.stringify(bought));
    // What the sandbox accepted (`11`): the point, read off the order.
    const asked = recorded('11-order-relay-mondial-relay-no-dropoff').request.body;
    assert.equal(sent[0].body.shippingOfferCode, 'MONR-CpourToi');
    assert.equal(sent[0].body.shipment.pickupPointCode, asked.shipment.pickupPointCode);
    assert.equal(sent[0].body.shipment.dropoffPointCode, undefined);
    assert.deepEqual(sent[0].body.shipment.toAddress.contact, asked.shipment.toAddress.contact);
    assert.ok(sent[1].url.endsWith(`/shipping-order/${RELAY_ID}/tracking`));

    const after = await orderRow(db, order.id);
    assert.equal(after.fulfillment_status, 'fulfilled');
    assert.equal(after.tracking_number, 'CR261030000000000UYN');
    assert.ok(after.tracking_url.startsWith('https://www.mondialrelay.com/'), after.tracking_url);
    assert.equal(await shippedNotices(db, order.id), 1);
    const label = await getLabelRecord(db, order.id);
    assert.equal(label.transaction_id, RELAY_ID);
    assert.equal(label.amount_cents, 419);
  });

  await check('a relay order whose point cannot be read buys nothing', async () => {
    const { ctx, sent } = context(db, { offers: ['POFR-ColissimoAccess'] });
    for (const point of [{ country: 'FR' }, { ...POINT, offer: 'MONR-Retired' }]) {
      const order = await newOrder(db, point);
      expectFailure(
        await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL }),
        t('admin.orders.notice.boxtal.noRelayPoint'),
      );
      assert.equal(await getLabelRecord(db, order.id), null);
    }
    assert.equal(sent.length, 0);
  });

  await check('a point Boxtal does not know is a definite refusal (`17`)', async () => {
    const order = await newOrder(db, { ...POINT, code: '00000' });
    const { ctx } = context(db, { labels: ['17-order-relay-unknown-point'], reference: 'essai-rel-mvv4seit-bad' });
    assert.equal((await prepareLabel(ctx, order, { from: SENDER, parcel: PARCEL })).ok, true);
    const refused = await buyLabel(ctx, order, { offerCode: 'MONR-CpourToi', recipient: RECIPIENT });
    // Named for the merchant, who has to pick another point with the buyer.
    expectFailure(refused, t('admin.shipping.boxtal.pickupPointRefused'));
    const failed = await getLabelRecord(db, order.id);
    assert.equal(failed.status, 'failed');
    assert.equal((await orderRow(db, order.id)).fulfillment_status, 'unfulfilled');
  });
} finally {
  await mf.dispose();
}

if (failures > 0) {
  console.error(`\nboxtal labels: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nboxtal labels D1 checks passed');
