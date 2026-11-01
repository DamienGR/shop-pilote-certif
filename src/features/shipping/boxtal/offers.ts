/**
 * The Boxtal offers a merchant can retain for home delivery (ADR 0021), and
 * those a relay rate can name (ADR 0020): the offers the v1 quote returned in
 * the sandbox (corpus `31`), under their v3 code `<operator>-<service>`.
 * `offers.test.ts` keeps both lists equal to that corpus, so an offer appears
 * here only once Boxtal has been seen to sell it.
 *
 * Copied rather than fetched: the settings page lists them without calling
 * Boxtal, and a label bought without the optional quote still knows the carrier
 * it bought from.
 */

/** How the merchant hands the parcel over, as the quote names it. */
export type BoxtalCollection = 'POST_OFFICE' | 'DROPOFF_POINT' | 'COMPANY';

export interface BoxtalOffer {
  /** The v3 shipping offer code. */
  code: string;
  /** Boxtal's carrier and service labels, as its quote returns them. */
  carrier: string;
  service: string;
  /** The order's tracking carrier (`CARRIERS` in features/orders/tracking.ts). */
  carrierCode: string;
  collection: BoxtalCollection;
}

export const BOXTAL_HOME_OFFERS: readonly BoxtalOffer[] = [
  { code: 'POFR-ColissimoAccess', carrier: 'Colissimo', service: 'Colissimo Domicile - sans signature', carrierCode: 'colissimo', collection: 'POST_OFFICE' },
  { code: 'POFR-ColissimoExpert', carrier: 'Colissimo', service: 'Colissimo Domicile - avec signature', carrierCode: 'colissimo', collection: 'POST_OFFICE' },
  { code: 'MONR-DomicileFrance', carrier: 'Mondial Relay', service: 'Domicile France', carrierCode: 'mondialrelay', collection: 'DROPOFF_POINT' },
  { code: 'BMON-DomicileFrance', carrier: 'Boxtal Mondial Relay', service: 'Domicile France', carrierCode: 'mondialrelay', collection: 'COMPANY' },
  { code: 'CHRP-Chrono10', carrier: 'Chronopost', service: 'Chrono 10', carrierCode: 'chronopost', collection: 'POST_OFFICE' },
  { code: 'CHRP-Chrono13', carrier: 'Chronopost', service: 'Chrono13', carrierCode: 'chronopost', collection: 'POST_OFFICE' },
  { code: 'CHRP-Chrono18', carrier: 'Chronopost', service: 'Chrono18', carrierCode: 'chronopost', collection: 'POST_OFFICE' },
  { code: 'CHRP-Chrono18Pickup', carrier: 'Chronopost', service: 'Chrono18 collecte', carrierCode: 'chronopost', collection: 'COMPANY' },
  { code: 'COPR-CoprRelaisDomicileNat', carrier: 'Colis Privé', service: 'Colis Privé Domicile', carrierCode: 'other', collection: 'DROPOFF_POINT' },
  { code: 'COPR-CoprRelaisSignatureNat', carrier: 'Colis Privé', service: 'Colis Privé Signature', carrierCode: 'other', collection: 'DROPOFF_POINT' },
  { code: 'DHLE-DomesticExpress', carrier: 'DHL Express', service: 'Domestic Express', carrierCode: 'dhl', collection: 'COMPANY' },
  { code: 'FEDX-DomesticExpress', carrier: 'FedEx', service: 'FedEx Priority Overnight', carrierCode: 'fedex', collection: 'COMPANY' },
  { code: 'SODX-ExpressStandard', carrier: 'Sodexi', service: 'Express Standard', carrierCode: 'other', collection: 'COMPANY' },
  { code: 'TNTE-ExpressNational18H', carrier: 'TNT Express', service: '18:00 Express', carrierCode: 'other', collection: 'COMPANY' },
  { code: 'UPSE-Standard', carrier: 'UPS', service: 'UPS Standard', carrierCode: 'ups', collection: 'COMPANY' },
  { code: 'UPSE-ExpressSaver', carrier: 'UPS', service: 'UPS Express Saver', carrierCode: 'ups', collection: 'COMPANY' },
  { code: 'UPSE-Express', carrier: 'UPS', service: 'UPS Express', carrierCode: 'ups', collection: 'COMPANY' },
];

/**
 * Delivered to a relay point or a locker. The offer fixes the network: a relay
 * rate names one, and the checkout searches that offer's points.
 */
export const BOXTAL_RELAY_OFFERS: readonly BoxtalOffer[] = [
  { code: 'MONR-CpourToi', carrier: 'Mondial Relay', service: 'C.pourToi®', carrierCode: 'mondialrelay', collection: 'DROPOFF_POINT' },
  { code: 'POFR-ColissimoPickupStation', carrier: 'Colissimo', service: 'Colissimo France Pickup', carrierCode: 'colissimo', collection: 'POST_OFFICE' },
  { code: 'CHRP-ChronoRelais', carrier: 'Chronopost', service: 'Chrono Relais', carrierCode: 'chronopost', collection: 'POST_OFFICE' },
  { code: 'CHRP-ChronoRelaisPickup', carrier: 'Chronopost', service: 'Chrono Relais collecte', carrierCode: 'chronopost', collection: 'COMPANY' },
  { code: 'CHRP-Chrono2ShopDirect', carrier: 'Chronopost', service: '2Shop Direct', carrierCode: 'chronopost', collection: 'DROPOFF_POINT' },
  { code: 'CHRP-ChronoShoptoShop', carrier: 'Chronopost', service: 'Shop2Shop by Chronopost', carrierCode: 'chronopost', collection: 'DROPOFF_POINT' },
  { code: 'SOGP-RelaisColis', carrier: 'Relais Colis', service: 'Relais Colis®', carrierCode: 'other', collection: 'DROPOFF_POINT' },
  { code: 'COPR-CoprRelaisRelaisNat', carrier: 'Colis Privé', service: 'Colis Privé Relais', carrierCode: 'other', collection: 'DROPOFF_POINT' },
  { code: 'UPSE-StandardAP', carrier: 'UPS', service: 'UPS Standard Access Point', carrierCode: 'ups', collection: 'COMPANY' },
];

export function relayOffer(code: string | null | undefined): BoxtalOffer | null {
  return BOXTAL_RELAY_OFFERS.find((offer) => offer.code === code) ?? null;
}

export function homeOffer(code: string | null | undefined): BoxtalOffer | null {
  return BOXTAL_HOME_OFFERS.find((offer) => offer.code === code) ?? null;
}

/**
 * The retained offers from their setting: known codes only, in the catalogue's
 * order, each once. A code this version no longer lists drops out instead of
 * reaching Boxtal.
 */
export function parseRetainedOffers(raw: string | null | undefined): string[] {
  let codes: unknown;
  try {
    codes = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(codes)) return [];
  return BOXTAL_HOME_OFFERS.filter((offer) => codes.includes(offer.code)).map((offer) => offer.code);
}
