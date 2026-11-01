-- Migration 0047: shipping labels bought from Boxtal (ADR 0020, ADR 0021;
-- plan §13.3, lot 3).
--
-- The label state machine of 0034/0037/0038 does not change; what a Boxtal
-- attempt needs on top of it is additive:
--
-- - `vendor` says who sold the label. Every row written before this migration
--   was Shippo's, hence the default; Boxtal rows set it explicitly.
-- - Boxtal keeps nothing between the quote and the purchase (its quote is a
--   separate, stateless API), so the quoted row keeps what Shippo's shipment
--   object used to: `parcel` holds the sender and the parcel as the merchant
--   typed them, `offers` the offers shown with their prices. Neither holds the
--   buyer: the recipient is read from the order at purchase time.
-- - `orders.tracking_url` is the carrier page Boxtal returns for the parcel.
--   Mondial Relay's carries the sender's own code, which no URL pattern in the
--   shop can know, so the URL is kept rather than rebuilt (ADR 0021).
-- - the orders list flags an uncertain purchase the same day (ADR 0021), so it
--   looks the open ones up by status rather than reading every label ever
--   bought.
ALTER TABLE orders ADD COLUMN tracking_url TEXT;

ALTER TABLE shipping_labels ADD COLUMN vendor TEXT NOT NULL DEFAULT 'shippo';
ALTER TABLE shipping_labels ADD COLUMN parcel TEXT;
ALTER TABLE shipping_labels ADD COLUMN offers TEXT;

ALTER TABLE shipping_label_attempts ADD COLUMN vendor TEXT NOT NULL DEFAULT 'shippo';

CREATE INDEX IF NOT EXISTS idx_shipping_labels_status
  ON shipping_labels (status);
