import { describe, expect, it } from 'vitest';
import { recorded } from '../../../../test/helpers/boxtal-corpus.mjs';
import { CARRIERS } from '../../orders/tracking.ts';
import { BOXTAL_CONTENTS, boxtalContent, quoteContentCode } from './contents.ts';
import { BOXTAL_HOME_OFFERS, BOXTAL_RELAY_OFFERS, homeOffer, parseRetainedOffers, relayOffer } from './offers.ts';
import { parseQuoteOffers } from './quote.ts';

const quoted = parseQuoteOffers(recorded('31-cotation-all-carriers').response.body as string);

describe('the home offers a merchant can retain', () => {
  it('are the home offers the sandbox quote returned, under their v3 code', () => {
    // The one home offer left out is a return service: it ships to the merchant.
    const home = quoted.filter((offer) => offer.delivery === 'HOME' && !offer.offerCode.endsWith('Retour'));
    expect(BOXTAL_HOME_OFFERS.map((offer) => offer.code).sort()).toEqual(home.map((offer) => offer.offerCode).sort());
    for (const offer of BOXTAL_HOME_OFFERS) {
      const seen = home.find((entry) => entry.offerCode === offer.code);
      expect({ carrier: offer.carrier, service: offer.service, collection: offer.collection }).toEqual({
        carrier: seen?.carrier,
        service: seen?.service,
        collection: seen?.collection,
      });
    }
  });

  it('name a tracking carrier the order page knows', () => {
    const codes = CARRIERS.map((carrier) => carrier.code as string);
    for (const offer of BOXTAL_HOME_OFFERS) expect(codes).toContain(offer.carrierCode);
  });

  it('come back from their setting as known codes, in catalogue order, once each', () => {
    expect(parseRetainedOffers('["UPSE-Express","POFR-ColissimoAccess","POFR-ColissimoAccess"]')).toEqual([
      'POFR-ColissimoAccess',
      'UPSE-Express',
    ]);
    // A relay offer, a retired code and a mangled setting never reach Boxtal.
    expect(parseRetainedOffers('["MONR-CpourToi","UPSE-EconomyAccessPoint"]')).toEqual([]);
    expect(parseRetainedOffers('{"code":"POFR-ColissimoAccess"}')).toEqual([]);
    expect(parseRetainedOffers('not json')).toEqual([]);
    expect(parseRetainedOffers(null)).toEqual([]);
    expect(homeOffer('BMON-DomicileFrance')?.carrier).toBe('Boxtal Mondial Relay');
    expect(homeOffer('MONR-CpourToi')).toBeNull();
  });
});

describe('the relay offers a rate can name', () => {
  it('are the pickup-point offers the sandbox quote returned, under their v3 code', () => {
    const relay = quoted.filter((offer) => offer.delivery === 'PICKUP_POINT');
    expect(BOXTAL_RELAY_OFFERS.map((offer) => offer.code).sort()).toEqual(relay.map((offer) => offer.offerCode).sort());
    for (const offer of BOXTAL_RELAY_OFFERS) {
      const seen = relay.find((entry) => entry.offerCode === offer.code);
      expect({ carrier: offer.carrier, service: offer.service, collection: offer.collection }).toEqual({
        carrier: seen?.carrier,
        service: seen?.service,
        collection: seen?.collection,
      });
    }
  });

  it('name a tracking carrier the order page knows, and never a home offer', () => {
    const codes = CARRIERS.map((carrier) => carrier.code as string);
    for (const offer of BOXTAL_RELAY_OFFERS) {
      expect(codes).toContain(offer.carrierCode);
      expect(homeOffer(offer.code)).toBeNull();
    }
    expect(relayOffer('MONR-CpourToi')?.carrier).toBe('Mondial Relay');
    expect(relayOffer('MONR-DomicileFrance')).toBeNull();
  });
});

describe('the natures of contents', () => {
  it('are the ones Boxtal lists, labels made typographic', () => {
    const listed = (recorded('06-content-categories').response.body as { content: Array<{ id: string; label: string }> })
      .content;
    expect(BOXTAL_CONTENTS).toEqual(listed.map((entry) => ({ id: entry.id, label: entry.label.replace(/'/g, '’') })));
  });

  it('give the v1 quote its code without the prefix', () => {
    expect(quoteContentCode('content:v1:40110')).toBe('40110');
    expect(boxtalContent('content:v1:40110')?.label).toBe('Tissus, vêtements neufs');
    expect(boxtalContent('40110')).toBeNull();
  });
});
