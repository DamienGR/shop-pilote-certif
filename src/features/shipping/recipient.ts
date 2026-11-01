/**
 * The recipient's phone, asked with the delivery address (ticket #123, plan
 * §13.3, lot 4). Boxtal refuses a label without one: the carrier texts the
 * recipient when the parcel leaves, or reaches its pickup point. So a shop that
 * buys its labels there asks for it at checkout, and the order page prefills
 * it; a shop that ships by hand never collects a number it has no use for.
 *
 * Pure: the checkout page, the JSON checkout and the tests read the same rule.
 */

import { boxtalConfigured } from '../settings/availability.ts';

/** Whether checkout asks for the phone: whenever Boxtal can buy the label. */
export function asksRecipientPhone(configuredSecrets: readonly string[], vault: boolean): boolean {
  return boxtalConfigured(configuredSecrets, vault);
}

/** A phone a carrier can text: digits, with the usual separators and a leading +. */
export function plausiblePhone(raw: string): boolean {
  const value = raw.trim();
  return /^\+?[\d\s.()-]+$/.test(value) && value.replace(/\D/g, '').length >= 8;
}
