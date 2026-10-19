import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { applyMigrations } from '../helpers/d1-schema.mjs';
import { sweepAbandonedGuestAccess } from '../../src/features/orders/guestAccess.ts';
import { listOrderItems, listOrderItemsWithImages } from '../../src/features/orders/db.ts';
import { listAllProducts } from '../../src/features/products/db.ts';
import { parseCsvRecords } from '../../shopctl/src/catalog/csv.mjs';
import { buildCatalogue } from '../../shopctl/src/catalog/contract.mjs';
import { resolveCatalogueImages } from '../../shopctl/src/catalog/media.mjs';
import { planImport } from '../../shopctl/src/catalog/plan.mjs';

/**
 * What a call READS once a shop has a history behind it.
 *
 * D1 bills every row a query scans, not every row it returns, and on the Free
 * plan it refuses every query past five million a day — every page included,
 * since every page reads its settings. A missing index does not show in a test
 * that asserts results: the answer is right, only the scan is the whole table.
 * So this suite asserts the scan. `meta.rows_read` is the counter D1 bills, and
 * Miniflare reports the same one (both are SQLite under a Durable Object).
 *
 * The bounds are an order of magnitude under the cost they replace — that is
 * the regression they catch — not tuned to today's plan.
 */
const ORDERS = 2000;
const PRODUCTS = 100;
const VARIANTS = 1000;

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-20',
  d1Databases: ['DB'],
});

/** The same binding, counting what it reads. */
function metered(db) {
  let read = 0;
  const add = (result) => {
    read += result?.meta?.rows_read ?? 0;
    return result;
  };
  const statement = (inner) => ({
    inner,
    bind: (...args) => statement(inner.bind(...args)),
    all: async () => add(await inner.all()),
    run: async () => add(await inner.run()),
    raw: async (options) => inner.raw(options),
    first: async (column) => {
      const { results } = add(await inner.all());
      const row = results?.[0] ?? null;
      return row && column !== undefined ? row[column] : row;
    },
  });
  return {
    binding: {
      prepare: (sql) => statement(db.prepare(sql)),
      batch: async (statements) => (await db.batch(statements.map((s) => s.inner))).map(add),
    },
    take() {
      const n = read;
      read = 0;
      return n;
    },
  };
}

try {
  const raw = await mf.getD1Database('DB');
  await applyMigrations(raw);
  const { binding: db, take } = metered(raw);

  // A month-old history: products, paid orders with one line each, their guest
  // credentials and settled reservations, and the variants an import matches on.
  const seed = [
    `INSERT INTO products (name, slug, price_cents, active)
       SELECT 'Produit ' || i, 'produit-' || i, 1000, 1 FROM n WHERE i <= ${PRODUCTS}`,
    `INSERT INTO orders (public_id, email, amount_total_cents, status, created_at)
       SELECT printf('ord_h%09d', i), 'c' || (i % 50) || '@exemple.fr', 1000, 'paid', datetime('now', '-30 days')
         FROM n WHERE i <= ${ORDERS}`,
    `INSERT INTO order_items (order_id, product_id, name, price_cents, quantity)
       SELECT i, (i % ${PRODUCTS}) + 1, 'Produit', 1000, 1 FROM n WHERE i <= ${ORDERS}`,
    `INSERT INTO order_guest_access (order_public_id, access_token, created_at)
       SELECT printf('ord_h%09d', i), printf('otk_h%09d', i), datetime('now', '-30 days') FROM n WHERE i <= ${ORDERS}`,
    `INSERT INTO checkout_reservations (public_id, items, payment_method, status, expires_at, terminal_at)
       SELECT printf('ord_h%09d', i), '[]', 'stripe', 'settled', datetime('now', '-30 days'), datetime('now', '-30 days')
         FROM n WHERE i <= ${ORDERS}`,
    `INSERT INTO product_variants (product_id, label, price_cents, stock, sku, position)
       SELECT (i % ${PRODUCTS}) + 1, 'T' || i, 1000, 5, 'HV-' || i, i FROM n WHERE i <= ${VARIANTS}`,
  ];
  for (const sql of seed) {
    await raw.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ORDERS}) ${sql}`).run();
  }
  // Two rows the sweep must still find among that history.
  await raw
    .prepare("INSERT INTO order_guest_access (order_public_id, access_token, created_at) VALUES ('ord_horphan', 'otk_horphan', datetime('now', '-20 days'))")
    .run();
  await raw
    .prepare("INSERT INTO order_guest_access (order_public_id, access_token, created_at) VALUES ('ord_hexpired', 'otk_hexpired', datetime('now', '-20 days'))")
    .run();
  await raw
    .prepare("INSERT INTO checkout_reservations (public_id, items, payment_method, status, expires_at, terminal_at) VALUES ('ord_hexpired', '[]', 'demo', 'expired', datetime('now', '-20 days'), datetime('now', '-20 days'))")
    .run();

  // ── The guest-access sweep: bounded per call, caught up, then nearly free ──
  let calls = 0;
  let worst = 0;
  for (; calls < 200; calls++) {
    await sweepAbandonedGuestAccess(db);
    const spent = take();
    worst = Math.max(worst, spent);
    const cursors = await raw.prepare('SELECT COUNT(*) AS n FROM sweep_cursors').first('n');
    const orphanGone = !(await raw.prepare("SELECT 1 FROM order_guest_access WHERE order_public_id = 'ord_horphan'").first());
    const hidden = await raw.prepare("SELECT hidden_at FROM order_guest_access WHERE order_public_id = 'ord_hexpired'").first('hidden_at');
    if (cursors === 2 && orphanGone && hidden) break;
  }
  assert.ok(calls < 200, 'the sweep reached both rows behind two thousand orders');
  assert.ok(worst < 600, `one sweep call reads at most a scan's worth (${worst} rows), not the history (${2 * ORDERS})`);
  for (let i = 0; i < 2 * Math.ceil(ORDERS / 50); i++) await sweepAbandonedGuestAccess(db);
  take();
  await sweepAbandonedGuestAccess(db);
  const idle = take();
  assert.ok(idle < 20, `once caught up, a sweep reads ${idle} rows`);
  console.log(`  ✓ sweep: ${worst} rows per call at most, ${idle} once caught up (was ${2 * ORDERS} every call)`);

  // ── One order's lines ──
  await listOrderItems(db, ORDERS / 2);
  const lines = take();
  await listOrderItemsWithImages(db, ORDERS / 2);
  const withImages = take();
  assert.ok(lines < 10 && withImages < 10, `one order's lines read ${lines} / ${withImages} rows, not every line sold`);
  console.log(`  ✓ order lines: ${lines} / ${withImages} rows (was ${ORDERS})`);

  // ── The admin product list and its "sold" column ──
  const page = await listAllProducts(db, 25, 0, 'created_at DESC');
  const listed = take();
  assert.equal(page.length, 25);
  assert.equal(page.reduce((n, p) => n + p.sold, 0), 25 * (ORDERS / PRODUCTS), 'sold counts are unchanged');
  assert.ok(listed < (PRODUCTS * ORDERS) / 10, `the admin list reads ${listed} rows, not products × lines`);
  console.log(`  ✓ admin product list: ${listed} rows (was ${PRODUCTS * ORDERS})`);

  // ── A catalogue import matching variants by SKU ──
  const csv = [
    'sku;product;name;slug;description;variant_group;variant;price;stock;weight_grams;requires_shipping;active;categories;images',
    'NV-S;NV;Produit importé;;Une description.;Taille;S;20,00;3;100;oui;oui;;',
    'NV-M;NV;;;;;M;20,00;3;100;;;;',
    'NV-L;NV;;;;;L;20,00;3;100;;;;',
  ].join('\n');
  const built = buildCatalogue(parseCsvRecords(`${csv}\n`), { currency: 'EUR' });
  assert.deepEqual(built.issues, []);
  const desired = resolveCatalogueImages(built.products, { root: process.cwd() }).products;
  const empty = { products: [], variants: [], categories: [], productCategories: [], productImages: [], media: [] };
  const plan = planImport(desired, empty, { currency: 'EUR' });
  assert.deepEqual(plan.refusals, []);
  await db.batch(plan.statements.map((sql) => db.prepare(sql)));
  const imported = take();
  assert.equal(await raw.prepare("SELECT COUNT(*) AS n FROM product_variants WHERE sku LIKE 'NV-%'").first('n'), 3);
  assert.ok(imported < VARIANTS, `importing three variants reads ${imported} rows, not every variant per variant`);
  console.log(`  ✓ import: ${imported} rows for three variants (was ${3 * VARIANTS} and more)`);

  console.log('history-reads integration: all assertions passed');
} finally {
  await mf.dispose();
}
