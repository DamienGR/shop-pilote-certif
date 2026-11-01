import { describe, expect, it } from 'vitest';
import { answer, recorded, replay } from '../../../../test/helpers/boxtal-corpus.mjs';
import { t } from '../../i18n/index.ts';
import type { QuoteRequest } from '../provider.ts';
import { boxtalQuote, buildQuotePath, parseQuoteOffers, quoteResult, v1FilterCode } from './quote.ts';
import { boxtalLabels, parseShipment } from './v3.ts';

const keys = { accessKey: 'v1-access', secretKey: 'v1-secret' };

const request = (offerCodes: string[], overrides: Partial<QuoteRequest> = {}): QuoteRequest => ({
  offerCodes,
  from: { kind: 'business', postalCode: '75004', city: 'Paris', country: 'FR' },
  to: { kind: 'residential', postalCode: '75011', city: 'Paris', country: 'FR' },
  parcel: { weightGrams: 800, lengthCm: 30, widthCm: 20, heightCm: 10 },
  contentCode: '40110',
  ...overrides,
});

/** The v3 codes a recorded quote asked for: the v1 filter glues a 4-letter operator to its service. */
function askedCodes(name: string): string[] {
  const query = new URL(`https://x${recorded(name).request.path}`).searchParams;
  return [...query.entries()]
    .filter(([key]) => key.startsWith('offers['))
    .map(([, glued]) => `${glued.slice(0, 4)}-${glued.slice(4)}`);
}

const xml = (name: string) => recorded(name).response.body as string;

describe('the quote request', () => {
  it('is the query the sandbox answered', () => {
    for (const name of ['32-cotation-two-offers', '33-cotation-eight-offers']) {
      expect(buildQuotePath(request(askedCodes(name)))).toBe(recorded(name).request.path);
    }
    const heavy = request(askedCodes('38-cotation-too-heavy'), {
      to: { kind: 'residential', postalCode: '35000', city: 'Rennes', country: 'FR' },
      parcel: { weightGrams: 35000, lengthCm: 30, widthCm: 20, heightCm: 10 },
    });
    expect(buildQuotePath(heavy)).toBe(recorded('38-cotation-too-heavy').request.path);
  });

  it('glues the two codes for the v1 filter', () => {
    expect(v1FilterCode('MONR-CpourToi')).toBe('MONRCpourToi');
    expect(v1FilterCode('BMON-DomicileFrance')).toBe('BMONDomicileFrance');
  });
});

describe('the quote answer', () => {
  it('reads every offer under its v3 code', () => {
    const offers = parseQuoteOffers(xml('31-cotation-all-carriers'));
    expect(offers).toHaveLength(27);
    expect(new Set(offers.map((offer) => offer.offerCode)).size).toBe(27);
    // The same service name at two operators is two offers.
    expect(offers.find((offer) => offer.offerCode === 'MONR-DomicileFrance')?.priceExclTaxCents).toBe(810);
    expect(offers.find((offer) => offer.offerCode === 'BMON-DomicileFrance')?.priceExclTaxCents).toBe(623);
  });

  it('prices exactly what the v3 purchase then charges', () => {
    const offers = parseQuoteOffers(xml('31-cotation-all-carriers'));
    const price = (code: string) => offers.find((offer) => offer.offerCode === code)?.priceExclTaxCents;
    const charged = (name: string) =>
      parseShipment((recorded(name).response.body as { content: unknown }).content)?.priceExclTaxCents;

    expect(price('POFR-ColissimoAccess')).toBe(charged('10-order-home-colissimo'));
    expect(price('MONR-CpourToi')).toBe(charged('11-order-relay-mondial-relay-no-dropoff'));
    expect(price('BMON-DomicileFrance')).toBe(charged('40-order-home-bmon'));
  });

  it('keeps only the offers asked for, whatever comes back', () => {
    // `35`: a filter the v1 does not know is ignored, and every carrier answers.
    const result = quoteResult(parseQuoteOffers(xml('35-cotation-v3-code-ignored')), ['MONR-CpourToi']);
    expect(result.offers.map((offer) => offer.offerCode)).toEqual(['MONR-CpourToi']);
    expect(result.unavailable).toEqual([]);
  });
});

describe('the quote port', () => {
  it('asks the v1 sandbox with the v1 keys and prices the chosen offers', async () => {
    const { fetch, sent } = replay('32-cotation-two-offers');
    const result = await boxtalQuote({ keys, sandbox: true, fetch }).quote(
      request(['POFR-ColissimoAccess', 'MONR-CpourToi']),
    );

    expect(sent[0].url).toBe(`https://test.envoimoinscher.com/api/v1${recorded('32-cotation-two-offers').request.path}`);
    expect(sent[0].headers.get('authorization')).toBe(`Basic ${btoa('v1-access:v1-secret')}`);
    expect(result).toEqual({
      ok: true,
      value: {
        offers: [
          {
            offerCode: 'MONR-CpourToi',
            carrier: 'Mondial Relay',
            service: 'C.pourToi®',
            priceExclTaxCents: 419,
            priceInclTaxCents: 502,
            currency: 'EUR',
            collection: 'DROPOFF_POINT',
            delivery: 'PICKUP_POINT',
          },
          {
            offerCode: 'POFR-ColissimoAccess',
            carrier: 'Colissimo',
            service: 'Colissimo Domicile - sans signature',
            priceExclTaxCents: 811,
            priceInclTaxCents: 973,
            currency: 'EUR',
            collection: 'POST_OFFICE',
            delivery: 'HOME',
          },
        ],
        unavailable: [],
      },
    });
  });

  it('names a chosen offer the quote does not price', async () => {
    const codes = askedCodes('33-cotation-eight-offers');
    const result = await boxtalQuote({ keys, sandbox: true, fetch: replay('33-cotation-eight-offers').fetch }).quote(
      request(codes),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.offers).toHaveLength(7);
    expect(result.value.unavailable).toEqual(['UPSE-EconomyAccessPoint']);
  });

  it('answers an impossible parcel with no offer, not an error', async () => {
    const codes = askedCodes('38-cotation-too-heavy');
    const result = await boxtalQuote({ keys, sandbox: true, fetch: replay('38-cotation-too-heavy').fetch }).quote(
      request(codes, { parcel: { weightGrams: 35000, lengthCm: 30, widthCm: 20, heightCm: 10 } }),
    );
    expect(result).toEqual({ ok: true, value: { offers: [], unavailable: codes } });
  });

  it('reports refusals by their code, never Boxtal’s prose', async () => {
    const quote = (fetch: typeof globalThis.fetch) => boxtalQuote({ keys, sandbox: true, fetch }).quote(request(['MONR-CpourToi']));

    expect(await quote(replay('36-cotation-missing-content').fetch)).toEqual({
      ok: false,
      error: t('admin.shipping.boxtal.quoteRefused', { statut: 400, code: 'bad_request' }),
    });
    expect(await quote(replay('39-cotation-no-auth').fetch)).toEqual({
      ok: false,
      error: t('admin.shipping.boxtal.quoteKeysRejected'),
    });
    expect(await quote(answer(200, '<html>maintenance</html>'))).toEqual({
      ok: false,
      error: t('admin.shipping.boxtal.quoteUnexpected'),
    });
  });

  it('never asks for an unfiltered quote', async () => {
    const result = await boxtalQuote({ keys, sandbox: true, fetch: replay().fetch }).quote(request([]));
    expect(result).toEqual({ ok: true, value: { offers: [], unavailable: [] } });
  });

  it('uses the live v1 host with live keys', async () => {
    const { fetch, sent } = replay('32-cotation-two-offers');
    await boxtalQuote({ keys, sandbox: false, fetch }).quote(request(['MONR-CpourToi']));
    expect(sent[0].url.startsWith('https://www.envoimoinscher.com/api/v1/cotation?')).toBe(true);
  });
});

describe('an offer found by the quote alone', () => {
  it('is bought in v3 under the code the quote gave it, then cancelled', async () => {
    const order = recorded('40-order-home-bmon');
    expect((order.request.body as { shippingOfferCode: string }).shippingOfferCode).toBe('BMON-DomicileFrance');
    const shipment = parseShipment((order.response.body as { content: unknown }).content);
    expect(shipment).toMatchObject({ status: 'PENDING', priceExclTaxCents: 623 });

    const labels = boxtalLabels({ keys, sandbox: true, fetch: replay('41-cancel-bmon').fetch });
    expect(await labels.cancel(shipment!.id)).toMatchObject({ ok: true, value: { status: 'CANCELLED' } });
  });
});
