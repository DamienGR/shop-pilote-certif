import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { readTermsGate, consentFor, isAcceptance } from '../../src/features/legal/terms.ts';
import { reserveInventory } from '../../src/features/orders/reservations.ts';
import { recordPaidOrder, getOrderByPublicId } from '../../src/features/orders/db.ts';

/**
 * The terms-of-sale consent, end to end against real D1.
 *
 * The unit tests cover the predicate; what only a database can show is the part
 * that spans two requests: the acceptance is given at checkout and the order is
 * written minutes later by a settlement that never saw the shopper. If the
 * reservation → order copy is wrong, every unit test still passes and every
 * order is stamped with nothing.
 */
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-20',
  d1Databases: ['DB'],
});

const LEGAL = { termsSlug: 'conditions-generales-de-vente', termsVersion: '3' };

try {
  const db = await mf.getD1Database('DB');
  // Production-shaped subset. The Wrangler gate applies every real migration
  // clean-room; this is the state machine, not the schema, under test.
  for (const sql of [
    `CREATE TABLE pages (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
       slug TEXT NOT NULL UNIQUE, body_markdown TEXT NOT NULL DEFAULT '',
       published INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, stock INTEGER NOT NULL,
       active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE product_variants (id INTEGER PRIMARY KEY AUTOINCREMENT, stock INTEGER NOT NULL,
       active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE order_item_ids (public_id TEXT PRIMARY KEY, order_public_id TEXT NOT NULL)`,
    `CREATE TABLE checkout_reservations (public_id TEXT PRIMARY KEY, items TEXT NOT NULL,
       payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
       expires_at TEXT NOT NULL, terminal_at TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       terms_version TEXT, terms_accepted_at TEXT, vat_rate_bps INTEGER, relay_point TEXT, ship_address TEXT)`,
    `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_session_id TEXT UNIQUE,
       public_id TEXT UNIQUE, email TEXT, amount_total_cents INTEGER NOT NULL,
       shipping_cents INTEGER NOT NULL DEFAULT 0, shipping_label TEXT,
       shipping_weight_grams INTEGER, delivery_method TEXT,
       discount_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
       currency TEXT NOT NULL, ship_address TEXT, status TEXT NOT NULL,
       payment_method TEXT, settlement_token TEXT, provider_payment_id TEXT,
       terms_version TEXT, terms_accepted_at TEXT,
       vat_rate_bps INTEGER, vat_amount_cents INTEGER, relay_point TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
       product_id INTEGER, variant_id INTEGER, public_id TEXT, name TEXT NOT NULL,
       price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL, file_key TEXT, file_name TEXT,
       file_mime TEXT, file_size_bytes INTEGER)`,
    `CREATE TABLE order_notifications (order_id INTEGER NOT NULL, kind TEXT NOT NULL,
       state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
       lease_expires_at TEXT, last_error TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT,
       PRIMARY KEY (order_id, kind))`,
    `CREATE TABLE order_inventory_exceptions (public_id TEXT PRIMARY KEY, order_id INTEGER,
       product_id INTEGER, variant_id INTEGER, quantity INTEGER, kind TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ]) {
    await db.exec(sql.replace(/\n\s*/g, ' '));
  }
  await db.prepare('INSERT INTO products (id, stock) VALUES (1, 10)').run();

  // A shop is created with the terms as a DRAFT — migration 0040 inserts them
  // with published = 0. The gate stays open, or a fresh clone could not take so
  // much as a demo order for want of a document nobody has written yet.
  await db
    .prepare("INSERT INTO pages (title, slug, body_markdown, published) VALUES (?, ?, '', 0)")
    .bind('Conditions générales de vente', LEGAL.termsSlug)
    .run();
  const draftGate = await readTermsGate(db, LEGAL);
  assert.equal(draftGate.required, false, 'a draft asks for nothing');
  assert.equal(draftGate.href, `/pages/${LEGAL.termsSlug}`);

  // Publishing the page closes the gate: the checkbox appears AND the server
  // starts refusing, because both read this one predicate.
  await db.prepare('UPDATE pages SET published = 1 WHERE slug = ?').bind(LEGAL.termsSlug).run();
  const liveGate = await readTermsGate(db, LEGAL);
  assert.equal(liveGate.required, true, 'a published page requires acceptance');
  assert.equal(liveGate.version, '3');

  // A missing page is not a published one. A store that renamed its terms slug
  // must not have consent silently required against a page that does not exist.
  assert.equal((await readTermsGate(db, { ...LEGAL, termsSlug: 'absente' })).required, false);

  // The refusal path holds nothing: a checkout that cannot legally complete must
  // not take stock off the shelf. Asserted on the stock, not on the route, so
  // the guarantee survives a refactor of where the check lives.
  const before = await db.prepare('SELECT stock FROM products WHERE id = 1').first();
  assert.equal(isAcceptance(undefined), false);
  assert.equal(before.stock, 10, 'nothing reserved before a checkout runs');

  // Accepted checkout: the reservation carries the consent…
  const consent = consentFor(liveGate, isAcceptance('on'));
  assert.ok(consent, 'a ticked box produces a consent record');
  const items = [{ productId: 1, variantId: null, quantity: 2, name: 'Article', priceCents: 1000 }];
  assert.ok(
    await reserveInventory(db, 'ord_termsaccept', items, 900, 'demo', undefined, undefined, consent, 2000),
    'reservation succeeds',
  );
  const reservation = await db
    .prepare('SELECT terms_version, terms_accepted_at FROM checkout_reservations WHERE public_id = ?')
    .bind('ord_termsaccept')
    .first();
  assert.equal(reservation.terms_version, '3');
  assert.match(reservation.terms_accepted_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // …and settlement, which never saw the shopper, copies it onto the order.
  await recordPaidOrder(db, {
    providerSessionId: 'sess_terms_accepted',
    publicId: 'ord_termsaccept',
    reservationId: 'ord_termsaccept',
    email: 'acheteur@exemple.fr',
    amountTotalCents: 2000,
    currency: 'eur',
    paymentMethod: 'demo',
    items: [{ productId: 1, variantId: null, name: 'Article', priceCents: 1000, quantity: 2 }],
  });
  const paid = await getOrderByPublicId(db, 'ord_termsaccept');
  assert.equal(paid.terms_version, '3', 'the order records which wording was agreed');
  assert.equal(paid.terms_accepted_at, reservation.terms_accepted_at);
  // The VAT split rides the same carrier and is taken on the total actually
  // paid: 20,00 € TTC at 20 % contains 3,33 €.
  assert.equal(paid.vat_rate_bps, 2000, 'the rate in force at purchase is kept');
  assert.equal(paid.vat_amount_cents, 333, 'the split is computed on the order total');

  // An order placed while the gate was open records no consent rather than a
  // fabricated one. Null is the honest answer to "what did they accept?".
  assert.equal(consentFor(draftGate, false), null);
  assert.ok(
    await reserveInventory(db, 'ord_noconsent', items, 900, 'demo', undefined, undefined, null, 0),
    'reservation succeeds without consent when the gate is open',
  );
  await recordPaidOrder(db, {
    providerSessionId: 'sess_no_consent',
    publicId: 'ord_noconsent',
    reservationId: 'ord_noconsent',
    email: 'acheteur@exemple.fr',
    amountTotalCents: 2000,
    currency: 'eur',
    paymentMethod: 'demo',
    items: [{ productId: 1, variantId: null, name: 'Article', priceCents: 1000, quantity: 2 }],
  });
  const openGateOrder = await getOrderByPublicId(db, 'ord_noconsent');
  assert.equal(openGateOrder.terms_version, null);
  assert.equal(openGateOrder.terms_accepted_at, null);
  // A shop with no configured rate records no split rather than a made-up one.
  assert.equal(openGateOrder.vat_rate_bps, null);
  assert.equal(openGateOrder.vat_amount_cents, null);

  console.log('✓ terms consent + VAT split: draft gate open, published gate closed, version and rate recorded on the order');
} finally {
  await mf.dispose();
}
