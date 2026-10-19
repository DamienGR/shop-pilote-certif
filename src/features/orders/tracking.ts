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
