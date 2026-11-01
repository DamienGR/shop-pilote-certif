import { describe, expect, it } from 'vitest';
import { answer, recorded, replay } from '../../../../test/helpers/boxtal-corpus.mjs';
import { t } from '../../i18n/index.ts';
import type { ShipmentParty, ShipmentRequest } from '../provider.ts';
import { pointsForWeight } from '../relay.ts';
import {
  boxtalLabels,
  boxtalPickupPoints,
  buildShipmentPayload,
  isLocker,
  parsePickupPoints,
  pointMaxWeightGrams,
  trackingMatchesReference,
  type BoxtalOptions,
} from './v3.ts';

const keys = { accessKey: 'access', secretKey: 'secret' };
const options = (fetch: typeof globalThis.fetch): BoxtalOptions => ({ keys, sandbox: true, fetch });

// The fictional parties of the corpus, as the shop would describe them.
const from: ShipmentParty = {
  kind: 'business',
  firstName: 'Boutique',
  lastName: 'Essai',
  company: 'Boutique Essai',
  email: 'expediteur@example.com',
  phone: '+33612345678',
  number: '10',
  street: 'rue de Rivoli',
  city: 'Paris',
  postalCode: '75004',
  country: 'FR',
};
const to: ShipmentParty = {
  kind: 'residential',
  firstName: 'Jeanne',
  lastName: 'Essai',
  email: 'destinataire@example.com',
  phone: '+33698765432',
  number: '5',
  street: 'rue Pache',
  city: 'Paris',
  postalCode: '75011',
  country: 'FR',
};
const parcel = {
  weightGrams: 800,
  lengthCm: 30,
  widthCm: 20,
  heightCm: 10,
  valueCents: 4240,
  currency: 'EUR',
  contentCode: 'content:v1:40110',
  contentDescription: 'Vêtements neufs',
};
const home: ShipmentRequest = { offerCode: 'POFR-ColissimoAccess', reference: 'essai-dom-mvv4seit', from, to, parcel };
const relay: ShipmentRequest = {
  offerCode: 'MONR-CpourToi',
  reference: 'essai-rel-mvv4seit',
  from,
  to,
  parcel,
  pickupPointCode: '41132',
};

describe('the shipment payload', () => {
  it('is the body Boxtal accepted, at home and in relay', () => {
    expect(buildShipmentPayload(home)).toEqual(recorded('10-order-home-colissimo').request.body);
    expect(buildShipmentPayload(relay)).toEqual(recorded('11-order-relay-mondial-relay-no-dropoff').request.body);
  });

  it('rounds dimensions up and keeps a second address line apart', () => {
    const body = buildShipmentPayload({
      ...home,
      parcel: { ...parcel, lengthCm: 29.2 },
      to: { ...to, number: null, street: '5 rue Pache', extra: 'Bâtiment B' },
    }) as { shipment: { packages: Array<{ length: number }>; toAddress: Record<string, unknown> } };
    expect(body.shipment.packages[0].length).toBe(30);
    expect(body.shipment.toAddress.location).toEqual({
      street: '5 rue Pache',
      city: 'Paris',
      postalCode: '75011',
      countryIsoCode: 'FR',
    });
    expect(body.shipment.toAddress.additionalInformation).toBe('Bâtiment B');
  });
});

describe('the label port', () => {
  it('buys on the sandbox host with the v3 keys, and reads the price back', async () => {
    const { fetch, sent } = replay('10-order-home-colissimo');
    const result = await boxtalLabels(options(fetch)).purchase(home);

    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe('https://api.boxtal.build/shipping/v3.1/shipping-order');
    expect(sent[0].headers.get('authorization')).toBe(`Basic ${btoa('access:secret')}`);
    expect(sent[0].body).toEqual(recorded('10-order-home-colissimo').request.body);
    expect(result).toEqual({
      ok: true,
      value: {
        id: '2610301632POFR56E7FR',
        status: 'PENDING',
        priceExclTaxCents: 811,
        currency: 'EUR',
        expectedTakingOverDate: '2026-10-31',
        estimatedDeliveryDate: '2026-11-03',
      },
    });
  });

  it('uses the live host with live keys', async () => {
    const { fetch, sent } = replay('12-get-order-home');
    await boxtalLabels({ keys, sandbox: false, fetch }).get('2610301632POFR56E7FR');
    expect(sent[0].url).toBe('https://api.boxtal.com/shipping/v3.1/shipping-order/2610301632POFR56E7FR');
  });

  it('names a refused relay point, and charges nothing for it', async () => {
    const { fetch } = replay('17-order-relay-unknown-point');
    const result = await boxtalLabels(options(fetch)).purchase({ ...relay, pickupPointCode: '00000' });
    expect(result).toEqual({ ok: false, error: t('admin.shipping.boxtal.pickupPointRefused'), uncertain: false });
  });

  it('parks every answer that may have bought a label as uncertain', async () => {
    const thrown = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    const labels = (fetch: typeof globalThis.fetch) => boxtalLabels(options(fetch));

    expect(await labels(thrown).purchase(home)).toMatchObject({ ok: false, uncertain: true });
    expect(await labels(answer(502, 'Bad gateway')).purchase(home)).toMatchObject({ ok: false, uncertain: true });
    expect(await labels(answer(200, 'not json')).purchase(home)).toMatchObject({ ok: false, uncertain: true });
    expect(await labels(answer(200, '{"content":{}}')).purchase(home)).toMatchObject({ ok: false, uncertain: true });
    expect(await labels(answer(401, '')).purchase(home)).toEqual({
      ok: false,
      error: t('admin.shipping.boxtal.keysRejected'),
      uncertain: false,
    });
  });

  it('reads a shipment back, and takes an unknown id as an answer', async () => {
    const found = await boxtalLabels(options(replay('12-get-order-home').fetch)).get('2610301632POFR56E7FR');
    expect(found).toMatchObject({ ok: true, value: { id: '2610301632POFR56E7FR', status: 'CONFIRMED' } });

    const unknown = await boxtalLabels(options(replay('18-get-order-unknown').fetch)).get('2610300000XXXX0000FR');
    expect(unknown).toEqual({ ok: true, value: null });
  });

  it('cancels before the carrier has the parcel, and says why it cannot after', async () => {
    const cancelled = await boxtalLabels(options(replay('20-cancel-duplicate').fetch)).cancel('2610301632POFR56E9FR');
    expect(cancelled).toMatchObject({ ok: true, value: { status: 'CANCELLED' } });

    const shipped = await boxtalLabels(options(replay('25-cancel-home-shipped').fetch)).cancel('2610301632POFR56E7FR');
    expect(shipped).toEqual({ ok: false, error: t('admin.shipping.boxtal.notCancellable'), uncertain: false });
  });

  it('returns the label as a signed URL, signed anew on each read', async () => {
    const { fetch, sent } = replay('13-documents-home-t0', '24-documents-home-t1');
    const labels = boxtalLabels(options(fetch));
    const first = await labels.documents('2610301632POFR56E7FR');
    const second = await labels.documents('2610301632POFR56E7FR');

    expect(sent[0].url).toBe('https://api.boxtal.build/shipping/v3.1/shipping-order/2610301632POFR56E7FR/shipping-document');
    expect(first).toMatchObject({ ok: true, value: [{ type: 'LABEL', format: 'PDF_A4' }] });
    const url = (r: typeof first) => (r.ok ? r.value[0].url : '');
    expect(url(first)).toMatch(/^https:\/\/document\.boxtal\.build\/shipping-label\//);
    expect(url(second)).not.toBe(url(first));
  });

  it('reads tracking with the carrier’s own URL, newest event first', async () => {
    const result = await boxtalLabels(options(replay('22-tracking-home-t2').fetch)).tracking('2610301632POFR56E7FR');
    if (!result.ok) throw new Error(result.error);
    const [pkg] = result.value;

    expect(pkg.reference).toBe('essai-dom-mvv4seit-1');
    expect(pkg.trackingNumber).toBe('CR261030000000000UYM');
    expect(pkg.trackingUrl).toBe('https://www.laposte.fr/outils/suivre-vos-envois?code=CR261030000000000UYM1');
    expect(pkg.current).toMatchObject({ status: 'SHIPPED', at: '2026-10-30 17:00:04', isFinal: false });
    expect(pkg.history.map((event) => event.status)).toEqual([
      'SHIPPED',
      'IN_TRANSIT',
      'ANNOUNCED',
      'ANNOUNCED',
      'ANNOUNCED',
    ]);
    expect(pkg.history[1].location).toBe('Centre Courrier 34');
  });

  it('keeps the Mondial Relay tracking URL Boxtal built, sender code included', async () => {
    const result = await boxtalLabels(options(replay('19-tracking-relay-t0').fetch)).tracking('2610301632MONR56E8FR');
    expect(result).toMatchObject({
      ok: true,
      value: [{ trackingUrl: expect.stringMatching(/^https:\/\/www\.mondialrelay\.com\/.*[?&]ens=/) }],
    });
  });
});

describe('a pasted Boxtal id', () => {
  const tracking = async (name: string) => {
    const result = await boxtalLabels(options(replay(name).fetch)).tracking('id');
    return result.ok ? result.value : [];
  };

  it('settles only the attempt whose reference its package carries', async () => {
    const homeTracking = await tracking('14-tracking-home-t0');
    expect(trackingMatchesReference(homeTracking, 'essai-dom-mvv4seit')).toBe(true);
    expect(trackingMatchesReference(homeTracking, 'essai-rel-mvv4seit')).toBe(false);
    expect(trackingMatchesReference(homeTracking, 'essai-dom')).toBe(false);
    expect(trackingMatchesReference([], 'essai-dom-mvv4seit')).toBe(false);
  });
});

describe('the relay-point port', () => {
  it('searches by offer exactly as the sandbox was asked', async () => {
    const { fetch, sent } = replay('02-parcel-points-by-offer-mondial-relay');
    const result = await boxtalPickupPoints(options(fetch)).search({
      offerCode: 'MONR-CpourToi',
      country: 'fr',
      postalCode: '75011',
      city: 'Paris',
      weightGrams: 800,
    });

    expect(sent[0].url).toBe(`https://api.boxtal.build${recorded('02-parcel-points-by-offer-mondial-relay').request.path}`);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.map((point) => point.code)).toEqual(['41132', '26237', '35382', '35614', '20499']);
    expect(result.value[0]).toEqual({
      code: '41132',
      name: 'ART THE ZEN',
      street: '5 RUE PACHE',
      city: 'PARIS',
      postalCode: '75011',
      country: 'FR',
      latitude: 48.858547,
      longitude: 2.382114,
      distanceMeters: 182,
      hours: {
        MONDAY: [],
        TUESDAY: [{ opens: '11:00', closes: '19:00' }],
        WEDNESDAY: [{ opens: '11:00', closes: '19:00' }],
        THURSDAY: [{ opens: '11:00', closes: '20:00' }],
        FRIDAY: [{ opens: '11:00', closes: '19:00' }],
        SATURDAY: [{ opens: '11:00', closes: '18:00' }],
        SUNDAY: [],
      },
      locker: false,
      maxWeightGrams: 30000,
    });
    expect(result.value[2]).toMatchObject({ name: 'LOCKER LAV EXPRESS POPINCOURT', locker: true, maxWeightGrams: null });
  });

  it('takes an unknown postcode as no point, not as a failure', async () => {
    const result = await boxtalPickupPoints(options(replay('05-parcel-points-bad-postcode').fetch)).search({
      offerCode: 'MONR-CpourToi',
      country: 'FR',
      postalCode: '00000',
      weightGrams: 800,
    });
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('names an offer code Boxtal does not know', async () => {
    const result = await boxtalPickupPoints(options(replay('42-parcel-points-offer-code-without-hyphen').fetch)).search({
      offerCode: 'MONRCpourToi',
      country: 'FR',
      postalCode: '75011',
      weightGrams: 800,
    });
    expect(result).toEqual({
      ok: false,
      error: t('admin.shipping.boxtal.unknownOffer', { offre: 'MONRCpourToi' }),
      uncertain: false,
    });
  });

  it('leaves out the points that cannot take the parcel', () => {
    const body = recorded('03-parcel-points-by-offer-colissimo').response.body as { content: unknown };
    const points = parsePickupPoints(body.content);
    expect(points.map((point) => point.maxWeightGrams)).toEqual([20000, 30000, 20000, 20000, 20000]);
    expect(pointsForWeight(points, 20000)).toHaveLength(5);
    expect(pointsForWeight(points, 25000).map((point) => point.name)).toEqual(['BUREAU DE POSTE RENNES REPUBLIQUE']);
  });

  it('reads caps and lockers from the network names', () => {
    expect(pointMaxWeightGrams(['POFR_NETWORK', 'POFR_UP_TO_10_KG_NETWORK', 'POFR_UP_TO_16_KG_NETWORK'])).toBe(16000);
    expect(pointMaxWeightGrams(['MONR_NETWORK', 'MONR_LOCKERS_ONLY_NETWORK'])).toBeNull();
    expect(isLocker(['MONR_NETWORK', 'MONR_LOCKERS_ONLY_NETWORK'])).toBe(true);
    expect(isLocker(['MONR_NETWORK', 'MONR_LOCKERS_EXCLUDED_UP_TO_30_KG_NETWORK'])).toBe(false);
  });
});
