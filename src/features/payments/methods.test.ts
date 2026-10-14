import { describe, expect, it } from 'vitest';
import { parseStoreSettings } from '../settings/db';
import { enabledMethods, isMethodAvailable, isMethodEnabled } from './index';

const STRIPE_KEYS = [
  { key: 'enc:stripe_secret_key', value: 'sealed' },
  { key: 'enc:stripe_webhook_secret', value: 'sealed' },
];
const settings = (rows: Array<{ key: string; value: string }> = []) => parseStoreSettings(rows);

describe('payment methods', () => {
  it('offers demo while no real rail is live', () => {
    expect(enabledMethods(settings(), true)).toEqual(['demo']);
    // Keys the vault cannot open do not make a rail live.
    expect(enabledMethods(settings(STRIPE_KEYS), false)).toEqual(['demo']);
  });

  it('withdraws demo once a real rail is live', () => {
    // Found on a real store: demo sat beside Stripe, and any visitor could
    // place an unpaid order that took stock and sent the confirmation emails.
    const live = settings(STRIPE_KEYS);
    expect(enabledMethods(live, true)).toEqual(['stripe']);
    expect(isMethodAvailable('demo', live, true)).toBe(false);
    expect(isMethodEnabled('demo', live, true)).toBe(false);
  });

  it('withdraws demo even when it was the default method', () => {
    const chosen = settings([...STRIPE_KEYS, { key: 'payment_provider', value: 'demo' }]);
    expect(enabledMethods(chosen, true)).toEqual(['stripe']);
  });

  it('closes a rail the admin switched off, configured or not', () => {
    const stripeOff = settings([...STRIPE_KEYS, { key: 'payment_methods_disabled', value: 'stripe' }]);
    expect(isMethodAvailable('stripe', stripeOff, true)).toBe(true);
    expect(isMethodEnabled('stripe', stripeOff, true)).toBe(false);

    const demoOff = settings([{ key: 'payment_methods_disabled', value: 'demo' }]);
    expect(isMethodAvailable('demo', demoOff, true)).toBe(true);
    expect(isMethodEnabled('demo', demoOff, true)).toBe(false);
    expect(enabledMethods(demoOff, true)).toEqual([]);
  });
});
