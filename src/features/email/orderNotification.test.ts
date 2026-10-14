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
    delivery_method: null,
    ship_address: null,
    terms_version: null,
    terms_accepted_at: null,
    vat_rate_bps: null,
    vat_amount_cents: null,
    created_at: '2026-07-28 00:00:00',
    ...overrides,
  });

describe('orderNotificationEmail', () => {
  it('shows the sequential order number and public ID in the owner subject and message', () => {
    const message = orderNotificationEmail(
      order(),
      [],
      'owner@example.com',
      'https://demo.minshop.dev',
      'Minshop',
    );

    // ASCII hyphen: keeps the header out of RFC 2047 encoded-words in raw logs.
    expect(message.subject).toBe('Nouvelle commande Minshop n°105 - ord_zdpyy315je');
    for (const body of [message.text, message.html]) {
      expect(body.toLowerCase()).toContain('commande n°105');
      expect(body).toContain('ord_zdpyy315je');
    }
    expect(message.html).toContain('/admin/orders/ord_zdpyy315je');
  });

  it('does not render null when a legacy order has no public ID', () => {
    const message = orderNotificationEmail(
      order({ public_id: null }),
      [],
      'owner@example.com',
      'https://demo.minshop.dev',
      'Minshop',
    );

    expect(message.subject).toBe('Nouvelle commande Minshop n°105');
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
