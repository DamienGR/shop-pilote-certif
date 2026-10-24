import { describe, expect, it } from 'vitest';
import {
  environmentStripeMode,
  isWebhookSecret,
  stripeKeyMode,
  stripeKeyRefusal,
} from './stripeMode';

describe('the mode of a Stripe key', () => {
  it('reads secret and restricted keys, live and test', () => {
    expect(stripeKeyMode('sk_live_51abc')).toBe('live');
    expect(stripeKeyMode('rk_live_51abc')).toBe('live');
    expect(stripeKeyMode('sk_test_51abc')).toBe('test');
    expect(stripeKeyMode('rk_test_51abc')).toBe('test');
    expect(stripeKeyMode('  rk_live_51abc\n')).toBe('live');
  });

  it('knows nothing that is not a secret key', () => {
    for (const key of ['pk_live_51abc', 'pk_test_51abc', 'whsec_abc', 'sk_live_', 'live_51abc', '']) {
      expect(stripeKeyMode(key)).toBeNull();
    }
  });
});

describe('the mode an environment accepts', () => {
  it('is live in production, test in staging, either elsewhere', () => {
    expect(environmentStripeMode('production')).toBe('live');
    expect(environmentStripeMode('staging')).toBe('test');
    expect(environmentStripeMode('')).toBeNull();
    expect(environmentStripeMode(undefined)).toBeNull();
  });
});

describe('a key refused for its environment', () => {
  it('keeps test cards out of a production', () => {
    // The hazard the rehearsal of étape 10 showed: a test key in production
    // turns 4242 4242 4242 4242 into a paid order.
    expect(stripeKeyRefusal('sk_test_51abc', 'production')).toBe('live_key_required');
    expect(stripeKeyRefusal('rk_test_51abc', 'production')).toBe('live_key_required');
    expect(stripeKeyRefusal('rk_live_51abc', 'production')).toBeNull();
  });

  it('keeps real money out of a staging', () => {
    expect(stripeKeyRefusal('rk_live_51abc', 'staging')).toBe('test_key_required');
    expect(stripeKeyRefusal('rk_test_51abc', 'staging')).toBeNull();
  });

  it('takes either mode where no environment is rendered', () => {
    expect(stripeKeyRefusal('sk_live_51abc', '')).toBeNull();
    expect(stripeKeyRefusal('sk_test_51abc', undefined)).toBeNull();
  });

  it('refuses a publishable key everywhere', () => {
    for (const environment of ['production', 'staging', undefined]) {
      expect(stripeKeyRefusal('pk_live_51abc', environment)).toBe('not_a_secret_key');
    }
  });
});

describe('a webhook signing secret', () => {
  it('is the whsec_ value the endpoint reveals', () => {
    expect(isWebhookSecret('whsec_abc123')).toBe(true);
    expect(isWebhookSecret(' whsec_abc123 ')).toBe(true);
    expect(isWebhookSecret('sk_live_51abc')).toBe(false);
    expect(isWebhookSecret('whsec_')).toBe(false);
  });
});
