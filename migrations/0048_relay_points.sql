-- Migration 0048: the relay point a shopper picked at checkout (ADR 0020;
-- plan §13.3, lot 4).
--
-- `relay_point` is a JSON snapshot of the point as the shop served it: the
-- Boxtal offer that fixes its network, the point's code, name and address.
-- A copy rather than a reference, because Boxtal cannot read a point back by
-- its code (ADR 0021) and a point that closes later does not change what was
-- sold.
--
-- It rides on the reservation, as the terms acceptance and the VAT rate do:
-- the reservation is the one row every rail writes before the shopper leaves,
-- and `recordPaidOrder` copies it onto the order from there. The pending
-- payment needs no copy of its own: every rail that writes one settles
-- through the same reservation.
--
-- `delivery_method` takes a third value, `relay`, beside `shipping` and
-- `pickup`: the column is free text, so that needs no statement here.
--
-- `ship_address` on the reservation is for a card payment that went through
-- /checkout (Damien's decision, 2026-10-30): the shopper typed the address
-- and phone there once, so Stripe's page does not ask again, and its webhook
-- has no address to return. The reservation holds it only while a payment
-- can still arrive: settlement copies it onto the order and clears it; a
-- reservation released before Stripe had a session clears it at once; one
-- that expired or failed keeps it three days, past Stripe's webhook retries,
-- and the sweep that hides its guest link clears it.
ALTER TABLE checkout_reservations ADD COLUMN relay_point TEXT;
ALTER TABLE checkout_reservations ADD COLUMN ship_address TEXT;
ALTER TABLE orders ADD COLUMN relay_point TEXT;
