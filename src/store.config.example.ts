import type { DeepPartial, SiteConfig } from './config';

/**
 * Copy this file to `store.config.ts` and edit it — that's the only config file
 * you touch. Its values are deep-merged on top of the defaults in `config.ts`,
 * so list ONLY what you change; anything omitted keeps its default. Arrays
 * (shipping rates, allowed countries) replace wholesale.
 *
 * Store identity, feature switches, integrations, and provider credentials are
 * configured at runtime in Admin → Réglages and do not belong in this file.
 */
export const storeOverrides: DeepPartial<SiteConfig> = {
  // currency: 'usd',                // ISO 4217, lowercase
  //
  // features: { accounts: false },  // magic-link customer login
  //
  // images: { maxWidth: 1000 },      // optimization on/off lives in Admin
  //
  // orderNumber: { offset: 1000, step: 1, randomStep: 0 },
  //
  // Terms of sale and VAT (ADR 0010). `termsVersion` is stamped on every order
  // that accepts them — BUMP IT whenever the wording changes in a way a
  // customer would have to re-accept; it is what a dispute reads to know which
  // text was agreed. The consent checkbox appears, and the server starts
  // refusing a checkout without it, when the page at `termsSlug` is published;
  // a new shop carries it as a draft until the merchant finishes writing it.
  // `vatRateBps` is BASIS POINTS (2000 = 20 %, 550 = 5,5 %) and describes the
  // tax already INSIDE a price, never a surcharge.
  //
  // legal: { termsVersion: '2', vatRateBps: 2000 },
  //
  // Shipping (zones, rates, weight bands, free-over thresholds) is managed in
  // Admin → Livraison. The block that used to live here is only the default for a
  // brand-new store; editing it after the first Admin save has no effect.
};
