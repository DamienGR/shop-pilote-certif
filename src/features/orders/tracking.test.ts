import { describe, expect, it } from 'vitest';
import { CARRIERS, carrierName, shippedCarrierName, trackingUrl } from './tracking';

// Found on a real store: the carrier list held USPS, UPS, FedEx and DHL, when
// the store's own default rates are named Colissimo. The parcel went out as
// "Other", and the customer's email read "Transporteur : Other", without a link.
describe('carriers', () => {
  it('offers the French carriers first', () => {
    expect(CARRIERS.slice(0, 5).map((c) => c.code)).toEqual([
      'colissimo',
      'chronopost',
      'mondialrelay',
      'dpd',
      'gls',
    ]);
    expect(CARRIERS.at(-1)?.code).toBe('other');
  });

  it('links a Colissimo or Chronopost number to its tracking page', () => {
    expect(trackingUrl('colissimo', '6A00000000000')).toBe(
      'https://www.laposte.fr/outils/suivre-vos-envois?code=6A00000000000',
    );
    expect(trackingUrl('chronopost', 'XY 123')).toBe(
      'https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=XY%20123',
    );
    expect(trackingUrl('other', '6A00000000000')).toBeNull();
  });

  it('names a known carrier, and leaves "other" unnamed for the customer', () => {
    expect(carrierName('colissimo')).toBe('Colissimo');
    expect(carrierName('other')).toBe('Autre');
    expect(shippedCarrierName('colissimo')).toBe('Colissimo');
    expect(shippedCarrierName('other')).toBeNull();
    expect(shippedCarrierName(null)).toBeNull();
  });
});
