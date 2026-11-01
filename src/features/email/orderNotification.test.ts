import { describe, expect, it } from 'vitest';
import type { Order } from '../orders/db';
import { orderConfirmationEmail, orderNotificationEmail } from './orderConfirmation';

const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: 105,
    public_id: 'ord_zdpyy315je',
    provider_session_id: 'demo_session',
    email: 'buyer@example.com',
    amount_total_cents: 100,
    shipping_cents: 0,
    shipping_label: null,
    shipping_weight_grams: null,
    discount_cents: 0,
    tax_cents: 0,
    currency: 'usd',
    status: 'paid',
    payment_method: 'demo',
    provider_payment_id: null,
    provider_refunded_cents: 0,
    external_refunded_cents: 0,
    refund_review_reason: null,
    refund_reviewed_at: null,
    refund_reviewed_by: null,
    refunded_cents: 0,
    fulfillment_status: 'unfulfilled',
    tracking_carrier: null,
    tracking_number: null,
    fulfilled_at: null,
    label_url: null,
    tracking_url: null,
    delivery_method: null,
    ship_address: null,
    relay_point: null,
    terms_version: null,
    terms_accepted_at: null,
    vat_rate_bps: null,
    vat_amount_cents: null,
    created_at: '2026-07-28 00:00:00',
    ...overrides,
  });

describe('orderNotificationEmail', () => {
  it('numbers the order as the customer, the admin and the export do', () => {
    const message = orderNotificationEmail(
      order(),
      [],
      'owner@example.com',
      'https://demo.minshop.dev',
      'Minshop',
    );

    // The row id read "n°1" beside the customer's "n°2vgje1r0cb" on the first
    // real order (certification, étape 10): one order, two numbers.
    expect(message.subject).toBe('Nouvelle commande Minshop n°zdpyy315je');
    for (const body of [message.text, message.html]) {
      expect(body.toLowerCase()).toContain('commande n°zdpyy315je');
      expect(body).not.toContain('n°105');
      expect(body).toContain('ord_zdpyy315je');
    }
    expect(message.html).toContain('/admin/orders/ord_zdpyy315je');

    const customer = orderConfirmationEmail(order(), [], 'https://demo.minshop.dev', 'Minshop');
    expect(customer.subject).toContain('n°zdpyy315je');
  });

  it('does not render null when a legacy order has no public ID', () => {
    const message = orderNotificationEmail(
      order({ public_id: null }),
      [],
      'owner@example.com',
      'https://demo.minshop.dev',
      'Minshop',
    );

    // A legacy order keeps the calculated number it was given: offset 1000.
    expect(message.subject).toBe('Nouvelle commande Minshop n°1104');
    expect(message.text).toContain('Identifiant public\u202f: \u2014');
    expect(message.html).not.toContain('null');
  });
});

describe('the plain-text part', () => {
  // A paid TTC order: 42,40 € of goods, 10 % off, 5,90 € shipping.
  const paid = order({
    currency: 'eur',
    amount_total_cents: 4406,
    shipping_cents: 590,
    discount_cents: 424,
    vat_rate_bps: 2000,
    vat_amount_cents: 734,
  });

  it('carries every total the HTML part shows, the VAT breakdown included', () => {
    const messages = [
      orderConfirmationEmail(paid, [], 'https://demo.minshop.dev', 'Minshop'),
      orderNotificationEmail(paid, [], 'owner@example.com', 'https://demo.minshop.dev', 'Minshop'),
    ];
    for (const message of messages) {
      const lines = message.text.split('\n');
      const at = (label: string) => lines.findIndex((line) => line.startsWith(label));
      expect(lines[at('Livraison')]).toMatch(/5,90/);
      expect(lines[at('Remise')]).toMatch(/: -4,24/);
      expect(lines[at('dont TVA (20')]).toMatch(/7,34/);
      // A breakdown of the total, so it follows it, as in the HTML.
      expect(at('dont TVA')).toBe(at('Total') + 1);
      expect(message.text).not.toContain('&minus;');
    }
  });
});

describe('the relay point', () => {
  // Fixture `02`'s nearest point, as the checkout snapshots it.
  const point = {
    offer: 'MONR-CpourToi',
    code: '41132',
    name: 'ART THE ZEN',
    street: '5 RUE PACHE',
    postalCode: '75011',
    city: 'PARIS',
    country: 'FR',
  };
  const relay = order({ delivery_method: 'relay', relay_point: JSON.stringify(point) });

  it('tells the shopper where to collect the parcel, and the merchant its code too', () => {
    const customer = orderConfirmationEmail(relay, [], 'https://demo.minshop.dev', 'Minshop');
    const owner = orderNotificationEmail(relay, [], 'owner@example.com', 'https://demo.minshop.dev', 'Minshop');
    for (const message of [customer, owner]) {
      for (const body of [message.text, message.html]) {
        expect(body).toContain('ART THE ZEN');
        expect(body).toContain('5 RUE PACHE');
        expect(body).toContain('75011 PARIS');
      }
    }
    expect(customer.text).toContain('Votre point relais\u202f:');
    expect(customer.text).not.toContain('41132');
    expect(owner.text).toContain('Code du point\u202f: 41132');
    expect(owner.html).toContain('Code du point\u202f: 41132');
  });

  it('says nothing of a point an erasure reduced to its country, or of a home order', () => {
    for (const quiet of [
      order({ delivery_method: 'relay', relay_point: JSON.stringify({ country: 'FR' }) }),
      order({ delivery_method: 'shipping', relay_point: JSON.stringify(point) }),
    ]) {
      const customer = orderConfirmationEmail(quiet, [], 'https://demo.minshop.dev', 'Minshop');
      const owner = orderNotificationEmail(quiet, [], 'owner@example.com', 'https://demo.minshop.dev', 'Minshop');
      for (const message of [customer, owner]) {
        expect(message.text).not.toContain('point relais');
        expect(message.html).not.toContain('point relais');
      }
    }
  });
});
