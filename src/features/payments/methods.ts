import type { StoreSettings } from '../settings/db';

/**
 * The payment rails and which of them a buyer can use, decided from the
 * settings alone.
 *
 * Pure, and kept apart from the provider factory in ./index for one reader:
 * the storefront shell asks on EVERY page whether the shop takes orders at all
 * (features/storefront/indexable.ts), and importing the factory would load
 * every vendor SDK it builds providers from on pages that never pay. `vault` is passed in rather than read here: whether this Worker
 * can decrypt its keys is a binding, and ./index fills it in for the routes.
 */

// 'demo' is a simulated checkout (records a real, demo-tagged order, charges
// nothing) offered while no real rail is live, so a fresh store can be exercised
// end to end. Once a real rail is live it is withdrawn, whatever the default
// method says: beside a real rail, any visitor could place unpaid orders that
// take stock. The real rails work only when configured.
export type PaymentMethod = 'stripe' | 'lightning' | 'opennode' | 'demo';
const ALL_METHODS: PaymentMethod[] = ['stripe', 'lightning', 'opennode'];
// The buttons presented at checkout. Each real rail works if configured, else its
// button leads to setup instructions; demo while it is available.
const OFFERED: PaymentMethod[] = ['stripe', 'lightning', 'demo'];

export function isPaymentMethod(value: string): value is PaymentMethod {
  return value === 'stripe' || value === 'lightning' || value === 'opennode' || value === 'demo';
}

/**
 * Whether a method can actually process a payment right now. Real rails need their
 * keys (and Lightning its node URL) — all configured in the admin dashboard and
 * read from the runtime settings overlay (`Astro.locals.settings` /
 * getStoreSettings). Sync (no decryption) so it's cheap per render — the actual key
 * is only decrypted in getPaymentProvider. Demo works while no real rail does.
 */
export function isMethodAvailable(
  method: PaymentMethod,
  settings: StoreSettings,
  vault: boolean,
): boolean {
  const has = (name: string) => vault && settings.configuredSecrets.includes(name);
  switch (method) {
    case 'stripe':
      return has('stripe_secret_key') && has('stripe_webhook_secret');
    case 'opennode':
      return has('opennode_api_key');
    case 'lightning':
      return settings.lightningBackend === 'lnbits'
        ? !!settings.lnbitsUrl && has('lnbits_api_key')
        : !!settings.phoenixdUrl && has('phoenixd_password');
    case 'demo':
      return !hasRealMethod(settings, vault);
  }
}

/** True when at least one REAL payment rail is configured (demo doesn't count). */
export function hasRealMethod(settings: StoreSettings, vault: boolean): boolean {
  return ALL_METHODS.some((m) => isMethodAvailable(m, settings, vault));
}

/** The store's default rail (Réglages → Paiements; default 'stripe'). */
export function defaultMethod(settings: StoreSettings): PaymentMethod {
  return settings.paymentProvider;
}

/**
 * Methods a buyer/agent can actually pay with right now — the configured real
 * rails plus demo while it is available, minus any the admin has disabled at
 * runtime. Used by the agent checkout + discovery, so callers are never handed a
 * method that isn't wired up (or has been switched off). May be EMPTY (admin
 * disabled everything) — callers hide checkout rather than falling back to a
 * method nobody enabled.
 */
export function enabledMethods(settings: StoreSettings, vault: boolean): PaymentMethod[] {
  const off = new Set(settings.disabledPaymentMethods);
  const def = defaultMethod(settings);
  const orderedReal =
    def === 'demo' ? ALL_METHODS : [def, ...ALL_METHODS.filter((m) => m !== def)];
  const real = orderedReal
    .filter((m): m is Exclude<PaymentMethod, 'demo'> => m !== 'demo')
    .filter((m) => isMethodAvailable(m, settings, vault))
    .filter((m) => !off.has(m));
  if (off.has('demo') || !isMethodAvailable('demo', settings, vault)) return real;
  return def === 'demo' ? ['demo', ...real] : [...real, 'demo'];
}

/**
 * Methods the checkout UI shows as buttons — Card, Lightning, Demo (plus any
 * other configured rail, e.g. OpenNode), minus any the admin disabled. Unlike
 * enabledMethods, this keeps UNconfigured-but-not-disabled real rails so they can
 * render a "set this up" link. May be EMPTY when the admin disables everything —
 * the cart/product pages then hide checkout entirely.
 */
export function offeredMethods(settings: StoreSettings, vault: boolean): PaymentMethod[] {
  const off = new Set(settings.disabledPaymentMethods);
  const extra = ALL_METHODS.filter(
    (m) => !OFFERED.includes(m) && isMethodAvailable(m, settings, vault),
  );
  return (['stripe', 'lightning', ...extra, 'demo'] as PaymentMethod[]).filter(
    (m) => !off.has(m) && (m !== 'demo' || isMethodAvailable('demo', settings, vault)),
  );
}
