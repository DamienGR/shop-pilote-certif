import { describe, expect, it } from 'vitest';
import {
  completeSender,
  newReference,
  parseBoxtalId,
  parseQuotedOffers,
  parseSender,
  quotedOffers,
  splitName,
} from './orderLabel.ts';

const SENDER = {
  company: 'Boutique Essai',
  firstName: 'Boutique',
  lastName: 'Essai',
  email: 'expediteur@example.com',
  phone: '+33 6 12 34 56 78',
  street: '10 rue de Rivoli',
  city: 'Paris',
  postalCode: '75004',
  country: 'fr',
};

describe('the offers the order page shows', () => {
  const retained = ['POFR-ColissimoAccess', 'MONR-DomicileFrance', 'UPSE-Express'];
  const priced = (offerCode: string, priceExclTaxCents: number) => ({
    offerCode,
    carrier: '',
    service: '',
    delivery: 'HOME' as const,
    collection: 'POST_OFFICE' as const,
    priceExclTaxCents,
    priceInclTaxCents: priceExclTaxCents,
    currency: 'EUR',
  });

  it('are every retained offer, unpriced and buyable, without a quote', () => {
    const shown = quotedOffers(retained, null);
    expect(shown.quoteError).toBeNull();
    expect(shown.offers.map((offer) => [offer.code, offer.priceExclTaxCents, offer.available])).toEqual([
      ['POFR-ColissimoAccess', null, true],
      ['MONR-DomicileFrance', null, true],
      ['UPSE-Express', null, true],
    ]);
  });

  it('stay buyable, unpriced, when the quote failed, with its reason', () => {
    const shown = quotedOffers(retained, { ok: false, error: 'Boxtal a refusé les clés.', uncertain: false });
    expect(shown.quoteError).toBe('Boxtal a refusé les clés.');
    expect(shown.offers.every((offer) => offer.available && offer.priceExclTaxCents === null)).toBe(true);
  });

  it('come cheapest first, the ones the quote did not price last and not buyable', () => {
    const shown = quotedOffers(retained, {
      ok: true,
      value: { offers: [priced('POFR-ColissimoAccess', 811), priced('MONR-DomicileFrance', 810)], unavailable: [] },
    });
    expect(shown.offers.map((offer) => [offer.code, offer.priceExclTaxCents, offer.available])).toEqual([
      ['MONR-DomicileFrance', 810, true],
      ['POFR-ColissimoAccess', 811, true],
      ['UPSE-Express', null, false],
    ]);
    // A code this version no longer lists drops out instead of reaching Boxtal.
    expect(quotedOffers(['MONR-Retired'], null).offers).toEqual([]);
    // A relay order's one offer is a relay offer: it is listed too.
    expect(quotedOffers(['MONR-CpourToi'], null).offers.map((offer) => offer.service)).toEqual(['C.pourToi®']);
  });

  it('read back from the row, or nothing', () => {
    const shown = quotedOffers(retained, null);
    expect(parseQuotedOffers(JSON.stringify(shown))).toEqual(shown);
    expect(parseQuotedOffers(null)).toBeNull();
    expect(parseQuotedOffers('{"offers":"none"}')).toBeNull();
    expect(parseQuotedOffers('not json')).toBeNull();
  });
});

describe('the sender', () => {
  it('prefills from a sender saved for Shippo, the fields Boxtal adds empty', () => {
    expect(
      parseSender('{"name":"Atelier","street1":"1 rue Haute","city":"Lyon","state":"","zip":"69001","country":"FR"}'),
    ).toEqual({
      company: 'Atelier',
      firstName: undefined,
      lastName: undefined,
      email: undefined,
      phone: undefined,
      street: '1 rue Haute',
      city: 'Lyon',
      postalCode: '69001',
      country: 'FR',
    });
    expect(parseSender('not json')).toEqual({});
    expect(parseSender(null)).toEqual(parseSender('{}'));
  });

  it('is complete only with every field, a country code, an e-mail and a phone', () => {
    expect(completeSender(SENDER)).toEqual({ ...SENDER, country: 'FR' });
    expect(completeSender({ ...SENDER, firstName: ' ' })).toBeNull();
    expect(completeSender({ ...SENDER, country: 'France' })).toBeNull();
    expect(completeSender({ ...SENDER, email: 'expediteur' })).toBeNull();
    expect(completeSender({ ...SENDER, phone: '06 12' })).toBeNull();
  });
});

describe('the recipient', () => {
  it('is prefilled from the delivery name, the last word as the family name', () => {
    expect(splitName('Jeanne Marie Essai')).toEqual({ firstName: 'Jeanne Marie', lastName: 'Essai' });
    expect(splitName('  Essai ')).toEqual({ firstName: '', lastName: 'Essai' });
    expect(splitName(null)).toEqual({ firstName: '', lastName: '' });
  });
});

describe('the attempt reference', () => {
  it('names the order, and differs from one attempt to the next', () => {
    const order = { id: 7, public_id: 'ord_abcdefghij' };
    expect(newReference(order)).toMatch(/^ord_abcdefghij-[0-9a-f]{8}$/);
    expect(newReference(order)).not.toBe(newReference(order));
    expect(newReference({ id: 7, public_id: null })).toMatch(/^commande-7-[0-9a-f]{8}$/);
  });
});

describe('a pasted Boxtal id', () => {
  it('is the id the dashboard shows, trimmed, or nothing', () => {
    expect(parseBoxtalId(' 2610301632POFR56E7FR ')).toBe('2610301632POFR56E7FR');
    expect(parseBoxtalId('2610301632POFR56E7FR/tracking')).toBeNull();
    expect(parseBoxtalId('../x')).toBeNull();
    expect(parseBoxtalId('court')).toBeNull();
  });
});
