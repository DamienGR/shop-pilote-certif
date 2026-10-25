/** Demo orders notify the store owner, but never contact the demo customer. */
export function shouldSendCustomerOrderEmail(
  paymentMethod: string | null | undefined,
): boolean {
  return paymentMethod !== 'demo';
}

/**
 * Who receives the owner's "new order" alert: Réglages first, then
 * `store.config.ts`. Empty means nobody, and the outbox skips the alert for
 * good — which is why the admin shell reads the same answer to warn about it.
 */
export function ownerAlertRecipient(
  settingsNotifyTo: string | null | undefined,
  configNotifyTo: string,
): string {
  return settingsNotifyTo || configNotifyTo;
}

/** Resolve and validate the address required to place a demo order. */
export function resolveRequiredOrderEmail(
  submittedEmail: string,
  existingEmail: string | null | undefined,
): string | null {
  const email = submittedEmail.trim() || existingEmail?.trim() || '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
