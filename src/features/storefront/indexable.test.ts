import { describe, expect, it } from 'vitest';
import { parseStoreSettings } from '../settings/db';
import { storefrontIndexable } from './indexable';

const STRIPE_KEYS = [
  { key: 'enc:stripe_secret_key', value: 'sealed' },
  { key: 'enc:stripe_webhook_secret', value: 'sealed' },
];
const settings = (rows: Array<{ key: string; value: string }> = []) => parseStoreSettings(rows);

describe('storefront indexing', () => {
  // A production straight out of `provision`: demo switched off, no rail yet,
  // its catalogue being entered in public (ADR 0015, amended 2026-10-27).
  it('keeps robots out of a shop that cannot take an order yet', () => {
    expect(storefrontIndexable(settings([{ key: 'payment_methods_disabled', value: 'demo' }]), true)).toBe(false);
    expect(storefrontIndexable(settings(), true)).toBe(false);
  });

  it('opens with the first real rail', () => {
    expect(storefrontIndexable(settings(STRIPE_KEYS), true)).toBe(true);
  });

  // Demo orders are unpaid; a shop that only takes those is not open.
  it('does not count the demo checkout, nor keys the vault cannot open', () => {
    expect(storefrontIndexable(settings([{ key: 'payment_provider', value: 'demo' }]), true)).toBe(false);
    expect(storefrontIndexable(settings(STRIPE_KEYS), false)).toBe(false);
  });

  it('stays closed while the merchant has switched the only rail off', () => {
    const off = settings([...STRIPE_KEYS, { key: 'payment_methods_disabled', value: 'stripe' }]);
    expect(storefrontIndexable(off, true)).toBe(false);
  });

  it('indexes a browse-only catalogue, which sells nothing by choice', () => {
    expect(storefrontIndexable(settings([{ key: 'cart_enabled', value: '0' }]), true)).toBe(true);
  });

  it('does not hide a shop because its settings could not be read', () => {
    expect(storefrontIndexable(undefined, true)).toBe(true);
    expect(storefrontIndexable(null, false)).toBe(true);
  });
});
