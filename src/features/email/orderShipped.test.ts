import { describe, it, expect } from 'vitest';
import { orderShippedEmail } from './orderConfirmation';
import type { Order } from '../orders/db';

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: 42,
    public_id: 'ord_hpxcw4mvpf',
    email: 'buyer@example.com',
    amount_total_cents: 4406,
    currency: 'eur',
    status: 'paid',
    fulfillment_status: 'fulfilled',
    tracking_carrier: 'colissimo',
    tracking_number: '6A00000000000',
    created_at: '2026-10-14',
    ...over,
  }) as Order;

describe('orderShippedEmail', () => {
  it('names Colissimo and links its tracking page', () => {
    const msg = orderShippedEmail(order(), 'Boutique');
    // \s: the French colon takes a no-break space before it.
    expect(msg.text).toMatch(/Transporteur\s:\sColissimo/);
    expect(msg.html).toContain('https://www.laposte.fr/outils/suivre-vos-envois?code=6A00000000000');
  });

  it('shows the number without an English "Other" when the carrier is unlisted', () => {
    const msg = orderShippedEmail(order({ tracking_carrier: 'other' }), 'Boutique');
    expect(msg.text).toContain('6A00000000000');
    expect(msg.text).not.toContain('Transporteur');
    expect(msg.text).not.toContain('Other');
    expect(msg.html).not.toContain('Other');
  });
});
