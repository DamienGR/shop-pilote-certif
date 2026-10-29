import { env } from 'cloudflare:workers';
import type { PaymentProvider } from './provider';
import type { StoreSettings } from '../settings/db';
import { getStoreSettings } from '../settings/db';
import { createStripeProvider } from './stripe';
import { environmentStripeMode, stripeKeyMode } from './stripeMode';
import { createLightningProvider } from './lightning-provider';
import { getLightningBackend } from './lightning';
import { createOpenNodeProvider } from './opennode';
import { createDemoProvider } from './demo';
import { getSecret, vaultReady } from '../secrets/store';
import {
  enabledMethods as methodsEnabled,
  hasRealMethod as realMethodConfigured,
  isMethodAvailable as methodAvailable,
  offeredMethods as methodsOffered,
  type PaymentMethod,
} from './methods';

export type { PaymentProvider } from './provider';
export {
  STRIPE_CHECKOUT_TTL_SECONDS,
  OPENNODE_CHECKOUT_TTL_SECONDS,
  RESERVATION_EXPIRY_GRACE_SECONDS,
} from './provider';
export { DEMO_CHECKOUT_TTL_SECONDS } from './demo';

// The rails, and which of them a buyer can use, live in ./methods: pure, so
// the storefront shell can ask whether the shop takes orders without loading
// every vendor SDK this factory imports. Re-exported here with the vault read
// filled in, which is how every route has always called them.
export type { PaymentMethod } from './methods';
export { isPaymentMethod, defaultMethod } from './methods';

/** See ./methods. `vault` defaults to whether this Worker can decrypt its keys. */
export function isMethodAvailable(method: PaymentMethod, settings: StoreSettings, vault = vaultReady()): boolean {
  return methodAvailable(method, settings, vault);
}

/** True when at least one REAL payment rail is configured (demo doesn't count). */
export function hasRealMethod(settings: StoreSettings, vault = vaultReady()): boolean {
  return realMethodConfigured(settings, vault);
}

/** See ./methods: what a buyer can pay with right now. May be EMPTY. */
export function enabledMethods(settings: StoreSettings, vault = vaultReady()): PaymentMethod[] {
  return methodsEnabled(settings, vault);
}

/** See ./methods: configured AND not switched off. */
export function isMethodEnabled(method: PaymentMethod, settings: StoreSettings, vault = vaultReady()): boolean {
  return methodsEnabled(settings, vault).includes(method);
}

/** See ./methods: the checkout buttons, set-up links included. */
export function offeredMethods(settings: StoreSettings, vault = vaultReady()): PaymentMethod[] {
  return methodsOffered(settings, vault);
}

/**
 * Build a concrete payment provider. `method` selects the rail; omitted → the
 * store default. Keys/URLs are resolved from the admin config (D1 settings + the
 * encrypted vault). Real methods fail closed when their secrets cannot be
 * decrypted; only an explicit `demo` selection constructs the simulator. The
 * checkout + webhook + refund routes are the only callers.
 */
export async function getPaymentProvider(method?: PaymentMethod): Promise<PaymentProvider> {
  const settings = await getStoreSettings(env.DB);
  const m = method ?? settings.paymentProvider;
  if (m === 'demo') return createDemoProvider(env.DB);
  switch (m) {
    case 'lightning':
      // Self-hosted Lightning (phoenixd / LNbits) behind a self-rendered pay page.
      return createLightningProvider(env.DB, await getLightningBackend());
    case 'opennode': {
      const key = await getSecret(env.DB, 'opennode_api_key');
      if (!key) throw new Error('OpenNode is not configured.');
      return createOpenNodeProvider(env.DB, key, settings.opennodeApiUrl ?? undefined);
    }
    case 'stripe':
    default: {
      const secretKey = await getSecret(env.DB, 'stripe_secret_key');
      const webhookSecret = await getSecret(env.DB, 'stripe_webhook_secret');
      if (!secretKey || !webhookSecret) throw new Error('Stripe is not fully configured.');
      // Settings refuse a key from the other mode; one stored before they did
      // fails closed here, because a test key in production sells to test cards.
      const mode = environmentStripeMode(env.MINSHOP_ENV);
      if (mode && stripeKeyMode(secretKey) !== mode) {
        throw new Error(`Stripe takes ${mode} keys only in ${env.MINSHOP_ENV}.`);
      }
      return createStripeProvider(secretKey, webhookSecret, {
        livemode: mode ? mode === 'live' : undefined,
      });
    }
  }
}
