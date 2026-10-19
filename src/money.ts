import { LOCALE } from './features/i18n/locale.ts';

/**
 * Pure currency-scaling math. Its only import is the locale constant, which is
 * itself a leaf with no imports — so this stays safe to use from unit-tested
 * code (e.g. parseProductForm) without pulling in the Cloudflare runtime.
 *
 * Money is stored as integer MINOR units (what Stripe uses): cents for USD/EUR,
 * whole yen for JPY, thousandths for BHD. The scale per currency comes from Intl's
 * ISO 4217 data, so nothing here hardcodes 100.
 *
 * NOTE: correct for display + storage across normal currencies, but a few
 * Stripe-specific quirks aren't captured — HUF/TWD/UGX charge as zero-decimal at
 * Stripe despite 2 ISO digits, and 3-decimal currencies must be rounded to
 * multiples of 10. Add an override map here if you ever sell in those.
 */

// One answer per currency for the isolate's life. Building an Intl.NumberFormat
// to read a constant cost a formatter per price shown — every card, every
// formatMoney() — and was the storefront's costliest line of its own after D1
// (certification, étape 6: about 0.4 ms of a warm catalogue render).
const decimalsByCurrency = new Map<string, number>();

/** Decimal places a currency uses (2 USD, 0 JPY, 3 BHD). */
export function currencyDecimals(currency: string): number {
  const code = currency.toUpperCase();
  let decimals = decimalsByCurrency.get(code);
  if (decimals === undefined) {
    decimals =
      new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    decimalsByCurrency.set(code, decimals);
  }
  return decimals;
}

/** Minor units per major unit (100 USD, 1 JPY, 1000 BHD). */
export function minorUnitsPerMajor(currency: string): number {
  return 10 ** currencyDecimals(currency);
}

/** Major-unit number → integer minor units (19.99 USD → 1999; 1000 JPY → 1000). */
export function toMinorUnits(major: number, currency: string): number {
  return Math.round(major * minorUnitsPerMajor(currency));
}

/** Integer minor units → major-unit number (1999 USD → 19.99; 1000 JPY → 1000). */
export function toMajorUnits(minor: number, currency: string): number {
  return minor / minorUnitsPerMajor(currency);
}

// `new Intl.NumberFormat` is expensive to construct, so cache one formatter per
// currency and reuse it (a product listing calls this once per item).
const priceFormatters = new Map<string, Intl.NumberFormat>();

/**
 * Format minor units for display, in an EXPLICIT currency.
 *
 * The currency is required on purpose. `config.formatPrice` defaults it to the
 * store's configured currency, which reads deployment vars — harmless in a
 * route, but it makes any caller binding-aware. Presentation builders take the
 * currency from their caller instead, so they stay pure and unit-testable.
 */
export function formatMoney(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  let formatter = priceFormatters.get(code);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: code });
    priceFormatters.set(code, formatter);
  }
  return formatter.format(toMajorUnits(cents, currency));
}
