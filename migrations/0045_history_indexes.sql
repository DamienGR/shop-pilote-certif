-- Migration 0045: reads that no longer grow with the order history.
--
-- D1 bills, and on the Free plan refuses past a daily quota, every row a query
-- SCANS, not every row it returns. Measured on the built Worker (2026-10-16,
-- jalon 10), four paths read the whole history on every call: the order
-- confirmation page, the receipt e-mails and the admin order detail read every
-- line ever sold to find one order's lines; the admin product list did that once
-- per product for its "sold" column; the guest-access sweep (every five minutes
-- and on every sale) read one row per order ever taken; and the catalogue import
-- read every variant once per variant it inserted. At three thousand orders the
-- sweep alone used a third of the Free plan's daily reads.
--
-- Plain indexes, never UNIQUE: product_variants.sku may already hold duplicates
-- in a shop's data (migration 0042 explains why it got no UNIQUE index), and an
-- index that refuses existing rows is a migration a fleet cannot take.
CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items (order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product
  ON order_items (product_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_sku
  ON product_variants (sku);

-- The guest-access sweep walks these two orders with a cursor instead of
-- re-reading them from the start (src/features/orders/guestAccess.ts).
CREATE INDEX IF NOT EXISTS idx_order_guest_access_created
  ON order_guest_access (created_at, order_public_id);

CREATE INDEX IF NOT EXISTS idx_checkout_reservations_terminal
  ON checkout_reservations (terminal_at, public_id);

-- Where each sweep stopped. One row per sweep, moved forward only.
CREATE TABLE IF NOT EXISTS sweep_cursors (
  name TEXT PRIMARY KEY,
  after_at TEXT NOT NULL,
  after_id TEXT NOT NULL
);
