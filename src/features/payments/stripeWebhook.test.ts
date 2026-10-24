import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStripeProvider } from './stripe';

/**
 * The Stripe adapter at the trust boundary: what a signed event becomes.
 *
 * Everything downstream — the reservation released, the order written, the
 * refund total reconciled — is decided by the shape this function returns, and
 * that shape is derived from a payload the store does not control. Until now
 * nothing exercised it: `verifyWebhook` had no test, so neither the signature
 * check nor a single field of the normalization was pinned.
 *
 * The signature is genuine (HMAC-SHA256 over `<timestamp>.<payload>`, Stripe's
 * own scheme), so the refusal case refuses for the real reason rather than
 * because a stub said so. What is faked is only the payload, which is exactly
 * what Stripe's own CLI fixture does.
 */

const SECRET_KEY = 'sk_test_double';
const WEBHOOK_SECRET = 'whsec_double';

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function signed(payload: string, secret = WEBHOOK_SECRET): Promise<Headers> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  return new Headers({ 'stripe-signature': `t=${timestamp},v1=${hex(mac)}` });
}

let outbound: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  outbound = [];
  // Only ONE branch of the adapter calls Stripe back: resolving a shipping rate
  // referenced by id. Answering it here keeps the unit suite off the network and
  // lets the test assert that the call happened at all.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    outbound.push(url);
    if (url.includes('/v1/shipping_rates/shr_known')) {
      return new Response(
        JSON.stringify({
          id: 'shr_known',
          object: 'shipping_rate',
          display_name: 'Retrait en boutique',
          metadata: { delivery: 'pickup' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ error: { message: 'No such shipping rate' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Built inside each test: the adapter captures `globalThis.fetch` on construction. */
const provider = () => createStripeProvider(SECRET_KEY, WEBHOOK_SECRET);

async function verify(event: unknown, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  return provider().verifyWebhook(payload, await signed(payload, secret));
}

const session = (over: Record<string, unknown> = {}) => ({
  id: 'cs_test_1',
  object: 'checkout.session',
  payment_status: 'paid',
  payment_intent: 'pi_test_1',
  amount_total: 5990,
  currency: 'eur',
  customer_details: { email: 'cliente@exemple.fr' },
  metadata: { public_id: 'ord_abc', reservation_id: 'ord_abc' },
  total_details: { amount_shipping: 0, amount_discount: 0, amount_tax: 0 },
  ...over,
});

const event = (type: string, object: unknown, id = 'evt_1') => ({
  id,
  type,
  data: { object },
});

describe('signature', () => {
  it('refuses a payload signed with another secret', async () => {
    await expect(verify(event('checkout.session.completed', session()), 'whsec_other')).rejects.toThrow(
      /signature/i,
    );
  });

  it('refuses a payload that changed after it was signed', async () => {
    const payload = JSON.stringify(event('checkout.session.completed', session()));
    const headers = await signed(payload);
    const tampered = payload.replace('5990', '1');
    await expect(provider().verifyWebhook(tampered, headers)).rejects.toThrow(/signature/i);
  });

  it('refuses a request with no signature header at all', async () => {
    await expect(provider().verifyWebhook('{}', new Headers())).rejects.toThrow(
      /stripe-signature/i,
    );
  });
});

describe('a paid checkout', () => {
  it('carries the fields an order is written from', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({
          total_details: { amount_shipping: 690, amount_discount: 0, amount_tax: 0 },
          metadata: {
            public_id: 'ord_abc',
            reservation_id: 'ord_abc',
            shipping_weight_grams: '1250',
          },
          shipping_cost: {
            amount_total: 690,
            shipping_rate: {
              id: 'shr_inline',
              display_name: 'Colissimo domicile',
              metadata: { delivery: 'shipping' },
            },
          },
          collected_information: {
            shipping_details: {
              name: 'Camille Durand',
              address: {
                line1: '12 rue des Lilas',
                line2: null,
                city: 'Nantes',
                state: null,
                postal_code: '44000',
                country: 'FR',
              },
            },
          },
        }),
      ),
    );

    expect(result.order).toMatchObject({
      providerSessionId: 'cs_test_1',
      providerPaymentId: 'pi_test_1',
      publicId: 'ord_abc',
      reservationId: 'ord_abc',
      email: 'cliente@exemple.fr',
      amountTotalCents: 5990,
      shippingCents: 690,
      shippingLabel: 'Colissimo domicile',
      shippingWeightGrams: 1250,
      deliveryMethod: 'shipping',
      currency: 'eur',
    });
    expect(result.order?.shippingAddress).toMatchObject({ city: 'Nantes', country: 'FR' });
    // The rate was inline, so nothing had to be fetched back.
    expect(outbound).toEqual([]);
  });

  it('reads the address from the pre-collected_information shape too', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({
          shipping_details: {
            name: 'Camille Durand',
            address: { line1: '3 quai Ceineray', city: 'Nantes', postal_code: '44000', country: 'FR' },
          },
        }),
      ),
    );
    expect(result.order?.shippingAddress).toMatchObject({ city: 'Nantes', line2: null });
  });

  it('settles a promotion code that covered the whole basket', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({
          payment_status: 'no_payment_required',
          payment_intent: null,
          amount_total: 0,
          total_details: { amount_shipping: 0, amount_discount: 5990, amount_tax: 0 },
        }),
      ),
    );
    expect(result.order).toBeDefined();
    expect(result.order?.amountTotalCents).toBe(0);
    expect(result.order?.discountCents).toBe(5990);
    expect(result.order?.providerPaymentId).toBeNull();
  });

  it('records the discount a promotion actually granted', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({
          amount_total: 4990,
          total_details: { amount_shipping: 0, amount_discount: 1000, amount_tax: 0 },
        }),
      ),
    );
    expect(result.order?.discountCents).toBe(1000);
  });

  it('records no discount when the code was refused', async () => {
    // A promotion code Stripe rejected — expired, wrong currency, exhausted —
    // never reaches total_details. The session settles at full price.
    const result = await verify(event('checkout.session.completed', session()));
    expect(result.order?.discountCents).toBe(0);
    expect(result.order?.amountTotalCents).toBe(5990);
  });

  it('carries Stripe Tax as tax_cents, which a TTC store leaves at zero', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({ total_details: { amount_shipping: 0, amount_discount: 0, amount_tax: 998 } }),
      ),
    );
    expect(result.order?.taxCents).toBe(998);
    expect((await verify(event('checkout.session.completed', session()))).order?.taxCents).toBe(0);
  });

  it('resolves a rate referenced by id, and reads its mode as data', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({ shipping_cost: { amount_total: 0, shipping_rate: 'shr_known' } }),
      ),
    );
    expect(outbound.some((url) => url.includes('/v1/shipping_rates/shr_known'))).toBe(true);
    expect(result.order?.shippingLabel).toBe('Retrait en boutique');
    expect(result.order?.deliveryMethod).toBe('pickup');
  });

  it('does not guess the mode when the rate cannot be read', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({ shipping_cost: { amount_total: 0, shipping_rate: 'shr_missing' } }),
      ),
    );
    // 'unknown' blocks label purchase; null would have been read as a delivery
    // and the customer may have chosen pickup.
    expect(result.order?.deliveryMethod).toBe('unknown');
    expect(result.order).toBeDefined();
  });

  it('ignores a weight that is not a safe integer', async () => {
    const result = await verify(
      event(
        'checkout.session.completed',
        session({
          metadata: { reservation_id: 'ord_abc', shipping_weight_grams: 'lourd' },
        }),
      ),
    );
    expect(result.order?.shippingWeightGrams).toBeNull();
  });
});

describe('a delayed payment', () => {
  it('is not an order while the funds have not cleared', async () => {
    const result = await verify(
      event('checkout.session.completed', session({ payment_status: 'unpaid' })),
    );
    expect(result.order).toBeUndefined();
    expect(result.pendingReservationId).toBe('ord_abc');
  });

  it('becomes an order on the later success event', async () => {
    const result = await verify(
      event('checkout.session.async_payment_succeeded', session(), 'evt_async'),
    );
    expect(result.order?.providerSessionId).toBe('cs_test_1');
  });

  it('releases the hold as a failure when the debit is refused', async () => {
    const result = await verify(
      event('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' })),
    );
    expect(result.releaseReservationId).toBe('ord_abc');
    expect(result.releaseReason).toBe('failed');
    expect(result.order).toBeUndefined();
  });
});

describe('an abandoned session', () => {
  it('releases the hold as an expiry, not a refusal', async () => {
    const result = await verify(event('checkout.session.expired', session()));
    expect(result.releaseReservationId).toBe('ord_abc');
    // The distinction reaches the reservation row: an abandoned basket and a
    // declined card release the same stock but are not the same event.
    expect(result.releaseReason).toBe('expired');
  });

  it('says nothing to release when the session carried no reservation', async () => {
    const result = await verify(event('checkout.session.expired', session({ metadata: {} })));
    expect(result.releaseReservationId).toBeUndefined();
  });
});

describe('a refund made at the provider', () => {
  const charge = (over: Record<string, unknown> = {}) => ({
    id: 'ch_1',
    object: 'charge',
    payment_intent: 'pi_test_1',
    amount_refunded: 1500,
    currency: 'eur',
    ...over,
  });

  it('reports the provider’s cumulative total, not a delta', async () => {
    const result = await verify(event('charge.refunded', charge(), 'evt_refund'));
    expect(result.refundSync).toEqual({
      eventId: 'evt_refund',
      providerPaymentId: 'pi_test_1',
      providerChargeId: 'ch_1',
      cumulativeRefundedCents: 1500,
      currency: 'eur',
    });
  });

  it('reads an expanded payment intent as well as an id', async () => {
    const result = await verify(
      event('charge.refunded', charge({ payment_intent: { id: 'pi_expanded' } })),
    );
    expect(result.refundSync?.providerPaymentId).toBe('pi_expanded');
  });

  it('reports nothing to sync when the charge names no payment', async () => {
    const result = await verify(event('charge.refunded', charge({ payment_intent: null })));
    expect(result.refundSync).toBeUndefined();
  });
});

describe('any other event', () => {
  it('verifies and reports its type without acting', async () => {
    const result = await verify(event('payment_intent.created', { id: 'pi_x' }));
    expect(result).toEqual({ type: 'payment_intent.created' });
  });
});

describe('the mode a shop takes payments in', () => {
  // MINSHOP_ENV makes a production take live payments only (./stripeMode.ts).
  // A test endpoint pointed at it signs its events like any other, so the
  // signature alone would let a test card write an order.
  const only = (livemode: boolean) => createStripeProvider(SECRET_KEY, WEBHOOK_SECRET, { livemode });
  async function verifyAs(livemode: boolean, payload: unknown) {
    const body = JSON.stringify(payload);
    return only(livemode).verifyWebhook(body, await signed(body));
  }

  it('settles a live payment in a live-only shop', async () => {
    const result = await verifyAs(true, { ...event('checkout.session.completed', session()), livemode: true });
    expect(result.order?.providerSessionId).toBe('cs_test_1');
  });

  it('refuses a test payment in a live-only shop, before reading it', async () => {
    await expect(
      verifyAs(true, { ...event('checkout.session.completed', session()), livemode: false }),
    ).rejects.toThrow(/test-mode event refused/i);
    await expect(
      verifyAs(true, { ...event('checkout.session.expired', session()), livemode: false }),
    ).rejects.toThrow(/test-mode event refused/i);
  });

  it('refuses a live event in a test-only shop', async () => {
    await expect(
      verifyAs(false, { ...event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 1 }), livemode: true }),
    ).rejects.toThrow(/live-mode event refused/i);
  });

  it('acts on either mode when the shop names none', async () => {
    for (const livemode of [true, false]) {
      const result = await verify({ ...event('checkout.session.expired', session()), livemode });
      expect(result.releaseReservationId).toBe('ord_abc');
    }
  });
});
