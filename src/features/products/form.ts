import type { ProductFields } from './db';
import { toMinorUnits } from '../../money';
import { toGrams, type WeightUnit } from '../shipping/weight';
import { t } from '../i18n';

export interface ProductFormOptions {
  /** Admin's display unit. Storage is always grams. */
  unit?: WeightUnit;
  /**
   * True when at least one enabled zone prices by weight with no flat fallback —
   * i.e. when a missing weight would make this product unsellable. The merchant is
   * told at the field rather than discovering it as lost checkouts.
   */
  requireWeight?: boolean;
}

/**
 * Parse + validate the scalar product form fields. Prices arrive in major units
 * (e.g. dollars) and are stored as integer minor units, scaled by the product's
 * currency (×100 for USD, ×1 for JPY). Weight arrives in the store's display unit
 * and is stored as integer grams. The image upload is handled by the endpoint, not
 * here. Returns either the clean fields or a user-facing error.
 */
export function parseProductForm(
  form: FormData,
  options: ProductFormOptions = {},
): { data: ProductFields } | { error: string } {
  const { unit = 'g', requireWeight = false } = options;

  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: t('admin.products.error.nameRequired') };

  // Free text on purpose. The merchant's own reference is whatever their
  // supplier prints on the box, and the invariant that matters — one product per
  // reference — is the partial UNIQUE index from migration 0042, not a character
  // class. The CSV import is stricter because a spreadsheet mangles what a form
  // field does not; `shopctl catalog validate` reports the gap rather than
  // letting the two rules drift silently.
  const sku = String(form.get('sku') ?? '').trim() || null;

  const price = Number(String(form.get('price') ?? '').trim());
  if (!Number.isFinite(price) || price < 0) {
    return { error: t('admin.products.error.price') };
  }

  const stock = Number(String(form.get('stock') ?? '0').trim());
  if (!Number.isInteger(stock) || stock < 0) {
    return { error: t('admin.products.error.stock') };
  }

  const currency = String(form.get('currency') ?? 'usd').trim().toLowerCase() || 'usd';
  // Scale by the chosen currency's minor units (so 1000 JPY stores as 1000, not 100000).
  const price_cents = toMinorUnits(price, currency);
  const description = String(form.get('description') ?? '').trim() || null;
  // Unchecked checkboxes submit nothing, so absence means inactive.
  const active = form.get('active') != null ? 1 : 0;
  const requires_shipping = form.get('requires_shipping') != null ? 1 : 0;

  const parsedWeight = toGrams(String(form.get('weight') ?? ''), unit);
  let weight_grams: number | null = null;
  if (parsedWeight.status === 'ok') {
    weight_grams = parsedWeight.grams;
  } else if (parsedWeight.status === 'error') {
    return { error: weightFieldError(parsedWeight.reason, unit) };
  } else if (requireWeight && requires_shipping === 1 && active === 1) {
    return { error: t('admin.products.error.weightRequired') };
  }

  return {
    data: { name, sku, description, price_cents, currency, stock, active, weight_grams, requires_shipping },
  };
}

function weightFieldError(
  reason: 'not_number' | 'negative' | 'precision' | 'over_limit',
  unit: WeightUnit,
): string {
  switch (reason) {
    case 'negative':
      return t('admin.products.error.weightNegative');
    case 'precision':
      return t('admin.products.error.weightPrecision', { unite: unit });
    case 'over_limit':
      return t('admin.products.error.weightOverLimit');
    default:
      return t('admin.products.error.weightNotNumber');
  }
}
