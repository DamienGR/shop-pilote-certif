import type { StoreSettings } from '../settings/db';
import { enabledMethods } from '../payments/methods';

/**
 * Whether search engines may index the storefront: once it can take an order.
 *
 * A production is public from its first deployment — its domain answers and its
 * certificate is published — while the merchant is still entering the
 * catalogue, and with no staging in front of it (ADR 0015, amended
 * 2026-10-27) that is where a shop is built. Indexed then, it would be found
 * half-written and remembered that way. So a shop whose cart is open and that
 * has no real rail asks robots to stay out; the first real rail opens it, and
 * the next crawl reads the page as it will be sold. A browse-only catalogue
 * (cart switched off) sells nothing by choice and is indexed as it is. No
 * settings at all — a page rendered without them — is indexed: a failed read
 * is not a reason to hide a shop.
 */
export function storefrontIndexable(settings: StoreSettings | null | undefined, vault: boolean): boolean {
  if (!settings) return true;
  if (!settings.cartEnabled) return true;
  return enabledMethods(settings, vault).some((m) => m !== 'demo');
}
