import { t, type MessageKey } from '../i18n/index.ts';

/**
 * Customer-facing names for the payment rails.
 *
 * One table, because /cart and /express both offer the same buttons and had
 * their own copy of it: a rail renamed in one place and not the other is a
 * difference a shopper reads as two different payment methods.
 *
 * Keyed by the rail identifiers `enabledMethods()` returns. An unknown key
 * falls back to the raw identifier rather than throwing — a rail added to the
 * factory before its strings exist must not take the cart down with it.
 */
export interface PaymentMethodCopy {
  label: string;
  hint: string;
  /** Shown on the "not configured yet" tile that links to /payment-setup. */
  setupHint: string;
}

const KEYS: Record<string, { label: MessageKey; hint: MessageKey; setup: MessageKey | null }> = {
  stripe: { label: 'payment.stripe.label', hint: 'payment.stripe.hint', setup: 'payment.stripe.setup' },
  lightning: {
    label: 'payment.lightning.label',
    hint: 'payment.lightning.hint',
    setup: 'payment.lightning.setup',
  },
  opennode: {
    label: 'payment.opennode.label',
    hint: 'payment.opennode.hint',
    setup: 'payment.opennode.setup',
  },
  // Demo is always available, so it never renders a setup tile.
  demo: { label: 'payment.demo.label', hint: 'payment.demo.hint', setup: null },
};

export function paymentMethodCopy(method: string): PaymentMethodCopy {
  const keys = KEYS[method];
  if (!keys) return { label: method, hint: '', setupHint: t('payment.setup.generic') };
  return {
    label: t(keys.label),
    hint: t(keys.hint),
    setupHint: keys.setup ? t(keys.setup) : '',
  };
}

/** The submit-button label on /checkout, per in-app rail. */
const RAIL_KEYS: Record<string, MessageKey> = {
  stripe: 'payment.rail.stripe',
  lightning: 'payment.rail.lightning',
  opennode: 'payment.rail.opennode',
  demo: 'payment.rail.demo',
};

export function paymentRailAction(rail: string): string {
  const key = RAIL_KEYS[rail];
  return key ? t(key) : rail;
}

/** How a settled order's method reads back on the confirmation page. */
const RECEIPT_KEYS: Record<string, MessageKey> = {
  stripe: 'payment.method.card',
  lightning: 'payment.method.lightning',
  opennode: 'payment.method.opennode',
  demo: 'payment.method.demo',
};

export function paymentMethodName(method: string): string {
  const key = RECEIPT_KEYS[method];
  return key ? t(key) : method;
}
