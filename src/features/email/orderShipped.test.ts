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

  it('links the carrier page the label provider returned, which no pattern here can build', () => {
    // Mondial Relay's carries the sender's own code (`ens=`): ADR 0021.
    const page = 'https://www.mondialrelay.com/public/permanent/tracking.aspx?ens=BDTEST&exp=12345678';
    const msg = orderShippedEmail(
      order({ tracking_carrier: 'mondialrelay', tracking_number: '12345678', tracking_url: page }),
      'Boutique',
    );
    expect(msg.html).toContain(`href="${page}"`);
    // Only an https page is a link: anything else falls back to the pattern.
    const fallback = orderShippedEmail(order({ tracking_url: 'javascript:alert(1)' }), 'Boutique');
    expect(fallback.html).not.toContain('javascript:');
    expect(fallback.html).toContain('https://www.laposte.fr/outils/suivre-vos-envois?code=6A00000000000');
    // A provider's quote cannot close the attribute it lands in.
    const quoted = orderShippedEmail(order({ tracking_url: 'https://suivi.example/?n="><b>x</b>' }), 'Boutique');
    expect(quoted.html).toContain('href="https://suivi.example/?n=%22%3E%3Cb%3Ex%3C/b%3E"');
    expect(quoted.html).not.toContain('<b>x</b>');
  });

  it('shows the number without an English "Other" when the carrier is unlisted', () => {
    const msg = orderShippedEmail(order({ tracking_carrier: 'other' }), 'Boutique');
    expect(msg.text).toContain('6A00000000000');
    expect(msg.text).not.toContain('Transporteur');
    expect(msg.text).not.toContain('Other');
    expect(msg.html).not.toContain('Other');
  });

  it('names the relay point the parcel waits at', () => {
    const point = {
      offer: 'MONR-CpourToi',
      code: '41132',
      name: 'ART THE ZEN',
      street: '5 RUE PACHE',
      postalCode: '75011',
      city: 'PARIS',
      country: 'FR',
    };
    const email = orderShippedEmail(
      order({ delivery_method: 'relay', relay_point: JSON.stringify(point) }),
      'Minshop',
    );
    expect(email.text).toContain('À retirer au point relais\u202f:\nART THE ZEN\n5 RUE PACHE\n75011 PARIS');
    expect(email.html).toContain('ART THE ZEN<br>5 RUE PACHE<br>75011 PARIS');
    expect(orderShippedEmail(order(), 'Minshop').text).not.toContain('point relais');
  });
});
