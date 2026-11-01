import { describe, expect, it } from 'vitest';
import { asksRecipientPhone, plausiblePhone } from './recipient.ts';

describe('the recipient phone', () => {
  it('is asked only once Boxtal can buy labels', () => {
    const both = ['stripe_secret_key', 'boxtal_access_key', 'boxtal_secret_key'];
    expect(asksRecipientPhone(both, true)).toBe(true);
    // A vault this Worker cannot open buys nothing, so it asks nothing.
    expect(asksRecipientPhone(both, false)).toBe(false);
    expect(asksRecipientPhone(['boxtal_access_key'], true)).toBe(false);
    // The optional v1 quote keys alone buy no label.
    expect(asksRecipientPhone(['boxtal_quote_access_key', 'boxtal_quote_secret_key'], true)).toBe(false);
    expect(asksRecipientPhone([], true)).toBe(false);
  });

  it('is a number a carrier can text', () => {
    expect(plausiblePhone('+33 6 98 76 54 32')).toBe(true);
    expect(plausiblePhone('06.98.76.54.32')).toBe(true);
    expect(plausiblePhone('(0)6-98-76-54-32')).toBe(true);
    expect(plausiblePhone('')).toBe(false);
    expect(plausiblePhone('12 34')).toBe(false);
    expect(plausiblePhone('06 98 76 54 32 poste 2')).toBe(false);
  });
});
