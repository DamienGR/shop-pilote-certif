/**
 * Which Stripe mode a shop may take payments in, and which mode a key is in.
 *
 * Stripe keeps live and test as two separate worlds behind one account: a test
 * key opens sessions that test cards pay, and the webhook that follows says
 * `paid` exactly as a live one does. A production holding a test key therefore
 * records an order for anyone who types 4242 4242 4242 4242, mails the
 * merchant "Nouvelle commande", and waits for the parcel to leave (certification,
 * étape 10, rehearsal of 2026-10-23). The environment is what tells the two
 * apart: `MINSHOP_ENV`, rendered from the manifest into the Worker's vars.
 *
 * Production takes live payments only, staging test payments only, and a render
 * that reaches no account (a witness build, local development) either.
 *
 * Pure: the settings page, the provider factory and the tests share it.
 */

export type StripeMode = 'live' | 'test';

/** The mode a secret or restricted key is in, or null when it is neither. */
export function stripeKeyMode(key: string): StripeMode | null {
  const match = /^(?:sk|rk)_(live|test)_\S+$/.exec(key.trim());
  return match ? (match[1] as StripeMode) : null;
}

/** The only mode an environment accepts, or null when it accepts both. */
export function environmentStripeMode(environment: string | undefined): StripeMode | null {
  if (environment === 'production') return 'live';
  if (environment === 'staging') return 'test';
  return null;
}

export type StripeKeyRefusal = 'not_a_secret_key' | 'live_key_required' | 'test_key_required';

/**
 * Why a key may not be stored for this environment, or null when it may. A
 * publishable key (`pk_…`) is the classic paste into the wrong field: the
 * session it opens fails at the first checkout, not at the save.
 */
export function stripeKeyRefusal(
  key: string,
  environment: string | undefined,
): StripeKeyRefusal | null {
  const mode = stripeKeyMode(key);
  if (!mode) return 'not_a_secret_key';
  const expected = environmentStripeMode(environment);
  if (expected && mode !== expected) {
    return expected === 'live' ? 'live_key_required' : 'test_key_required';
  }
  return null;
}

/** A webhook signing secret, as the endpoint page reveals it. */
export function isWebhookSecret(secret: string): boolean {
  return /^whsec_\S+$/.test(secret.trim());
}
