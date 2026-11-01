import { t } from '../i18n/index.ts';

/** Supported carriers for fulfillment tracking. The French carriers lead: the
 *  store's default rates are named Colissimo, and a store that ships with them
 *  must not have to record its parcels as "Autre". */
export const CARRIERS = [
  { code: 'colissimo', name: 'Colissimo' },
  { code: 'chronopost', name: 'Chronopost' },
  { code: 'mondialrelay', name: 'Mondial Relay' },
  { code: 'dpd', name: 'DPD' },
  { code: 'gls', name: 'GLS' },
  { code: 'ups', name: 'UPS' },
  { code: 'dhl', name: 'DHL' },
  { code: 'fedex', name: 'FedEx' },
  { code: 'usps', name: 'USPS' },
  { code: 'other', name: t('admin.orders.carrier.other') },
] as const;

export function carrierName(code: string | null): string {
  return CARRIERS.find((c) => c.code === code)?.name ?? code ?? '—';
}

/** The carrier as the customer's email names it: a listed carrier's name, or
 *  null for "other" and unknown codes — the admin's catch-all "Autre" is not
 *  something to show a customer, and the number speaks for itself. */
export function shippedCarrierName(code: string | null): string | null {
  if (!code || code === 'other') return null;
  return CARRIERS.find((c) => c.code === code)?.name ?? null;
}

/** Public tracking URL for a carrier + number, or null when not linkable.
 *  Mondial Relay, DPD and GLS stay linkless until their tracking URL has been
 *  checked against a real parcel: a link that lands on an error page is worse
 *  than the bare number. */
export function trackingUrl(carrier: string | null, number: string | null): string | null {
  if (!carrier || !number) return null;
  const n = encodeURIComponent(number);
  switch (carrier) {
    case 'colissimo':
      return `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`;
    case 'chronopost':
      return `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${n}`;
    case 'usps':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
    case 'ups':
      return `https://www.ups.com/track?tracknum=${n}`;
    case 'fedex':
      return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
    case 'dhl':
      return `https://www.dhl.com/en/express/tracking.html?AWB=${n}`;
    default:
      return null; // 'other' / unknown — show the number without a link
  }
}

/**
 * The link for an order's tracking number: the carrier page the label provider
 * returned with the parcel (ADR 0021), else one built from a number typed by
 * hand. The stored URL is a provider's text and lands in an e-mail's href, so
 * only an https URL is a link, and it goes out as the URL parser serializes it
 * (quotes and angle brackets percent-encoded), never as received.
 */
export function orderTrackingUrl(order: {
  tracking_carrier: string | null;
  tracking_number: string | null;
  tracking_url?: string | null;
}): string | null {
  if (order.tracking_url && order.tracking_number) {
    try {
      const parsed = new URL(order.tracking_url);
      if (parsed.protocol === 'https:') return parsed.href;
    } catch {
      // Not a URL: fall back to the carrier's pattern.
    }
  }
  return trackingUrl(order.tracking_carrier, order.tracking_number);
}
