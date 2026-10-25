import { describe, expect, it } from 'vitest';
import { ownerAlertRecipient, resolveRequiredOrderEmail, shouldSendCustomerOrderEmail } from './orderPolicy';

describe('shouldSendCustomerOrderEmail', () => {
  it('suppresses customer email for demo orders', () => {
    expect(shouldSendCustomerOrderEmail('demo')).toBe(false);
  });

  it.each(['stripe', 'lightning', 'opennode', null, undefined])(
    'allows customer email for %s orders',
    (paymentMethod) => {
      expect(shouldSendCustomerOrderEmail(paymentMethod)).toBe(true);
    },
  );
});

describe('ownerAlertRecipient', () => {
  it('prefers the address saved in Réglages', () => {
    expect(ownerAlertRecipient('owner@example.com', 'config@example.com')).toBe('owner@example.com');
  });

  it('falls back to store.config.ts', () => {
    expect(ownerAlertRecipient(undefined, 'config@example.com')).toBe('config@example.com');
    expect(ownerAlertRecipient('', 'config@example.com')).toBe('config@example.com');
  });

  it('is empty when neither names anyone, as in a production nobody filled in', () => {
    expect(ownerAlertRecipient(null, '')).toBe('');
  });
});

describe('resolveRequiredOrderEmail', () => {
  it('uses a valid submitted address', () => {
    expect(resolveRequiredOrderEmail(' buyer@example.com ', 'old@example.com')).toBe(
      'buyer@example.com',
    );
  });

  it('falls back to a valid address already stored with the checkout', () => {
    expect(resolveRequiredOrderEmail('', 'saved@example.com')).toBe('saved@example.com');
  });

  it.each([
    ['', null],
    ['not-an-email', null],
    ['buyer@example', null],
  ])('rejects a missing or invalid address', (submitted, existing) => {
    expect(resolveRequiredOrderEmail(submitted, existing)).toBeNull();
  });
});
