import { describe, expect, it } from 'vitest';
import { replay } from '../../../test/helpers/boxtal-corpus.mjs';
import type { PickupPoint, PickupPointProvider } from './provider.ts';
import { boxtalPickupPoints } from './boxtal/v3.ts';
import {
  RELAY_POINTS_SHOWN,
  parseRelayPoint,
  relayPointOf,
  relaySearchKey,
  searchRelayPoints,
  servedPoint,
  type PointCache,
  type RelaySearch,
} from './relay.ts';

const ORIGIN = 'https://boutique.example';
const keys = { accessKey: 'access', secretKey: 'secret' };

/** The Workers cache, as far as this module sees it: answers kept by key. */
function memoryCache(): PointCache & { keys: string[] } {
  const store = new Map<string, string>();
  return {
    get keys() {
      return [...store.keys()];
    },
    async match(key) {
      const body = store.get(key);
      return body === undefined ? undefined : new Response(body);
    },
    async put(key, response) {
      store.set(key, await response.text());
    },
  };
}

// The search recorded in Boxtal's sandbox for Colissimo around Rennes (`03`):
// five points, one of which takes up to 30 kg and the others 20 kg.
const rennes: RelaySearch = {
  offer: 'POFR-ColissimoPickupStation',
  country: 'FR',
  postalCode: '35000',
  city: 'Rennes',
  weightGrams: 800,
  sandbox: true,
};
const colissimo = () => boxtalPickupPoints({ keys, sandbox: true, fetch: replay('03-parcel-points-by-offer-colissimo').fetch });

describe('the relay point snapshot', () => {
  const point: PickupPoint = {
    code: '41132',
    name: 'ART THE ZEN',
    street: '5 RUE PACHE',
    city: 'PARIS',
    postalCode: '75011',
    country: 'FR',
    latitude: 48.858547,
    longitude: 2.382114,
    distanceMeters: 182,
    hours: null,
    locker: false,
    maxWeightGrams: 30000,
  };

  it('keeps the offer and what shows the point, not how it was found', () => {
    const snapshot = relayPointOf('MONR-CpourToi', point);
    expect(snapshot).toEqual({
      offer: 'MONR-CpourToi',
      code: '41132',
      name: 'ART THE ZEN',
      street: '5 RUE PACHE',
      postalCode: '75011',
      city: 'PARIS',
      country: 'FR',
    });
    expect(parseRelayPoint(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('reads nothing from a missing, broken or incomplete snapshot', () => {
    expect(parseRelayPoint(null)).toBeNull();
    expect(parseRelayPoint('')).toBeNull();
    expect(parseRelayPoint('{')).toBeNull();
    expect(parseRelayPoint('"41132"')).toBeNull();
    const partial: Partial<ReturnType<typeof relayPointOf>> = relayPointOf('MONR-CpourToi', point);
    delete partial.city;
    expect(parseRelayPoint(JSON.stringify(partial))).toBeNull();
  });

  // What an erasure leaves of it (shopctl/src/privacy/map.mjs keeps `country`).
  it('names its country under the key the anonymisation keeps', () => {
    expect(relayPointOf('MONR-CpourToi', point)).toHaveProperty('country', 'FR');
  });
});

describe('the search key', () => {
  it('does not split one search over the spacing a shopper types', () => {
    expect(relaySearchKey(ORIGIN, { ...rennes, postalCode: ' 35 000', city: '  RENNES ' })).toBe(
      relaySearchKey(ORIGIN, rennes),
    );
  });

  it('keeps sandbox and live points apart, and one offer from another', () => {
    const key = relaySearchKey(ORIGIN, rennes);
    expect(relaySearchKey(ORIGIN, { ...rennes, sandbox: false })).not.toBe(key);
    expect(relaySearchKey(ORIGIN, { ...rennes, offer: 'MONR-CpourToi' })).not.toBe(key);
    expect(key.startsWith(`${ORIGIN}/_relay-points/`)).toBe(true);
  });

  it('ignores the weight, which filters the answer rather than the search', () => {
    expect(relaySearchKey(ORIGIN, { ...rennes, weightGrams: 25000 })).toBe(relaySearchKey(ORIGIN, rennes));
  });
});

describe('searching the points', () => {
  it('asks Boxtal once per address and offer, then answers from the cache', async () => {
    const cache = memoryCache();
    const points = colissimo();
    const first = await searchRelayPoints(points, cache, ORIGIN, rennes);
    expect(first.ok && first.value.map((point) => point.code)).toEqual(['663997', '359480', '487338', '663236', '364305']);
    // The corpus holds ONE answer: a second request to Boxtal would throw.
    const second = await searchRelayPoints(points, cache, ORIGIN, { ...rennes, postalCode: '35 000' });
    expect(second).toEqual(first);
    expect(cache.keys).toHaveLength(1);
  });

  it('applies the weight on the way out of the cache', async () => {
    const cache = memoryCache();
    const points = colissimo();
    await searchRelayPoints(points, cache, ORIGIN, rennes);
    const heavy = await searchRelayPoints(points, cache, ORIGIN, { ...rennes, weightGrams: 25000 });
    expect(heavy.ok && heavy.value.map((point) => point.name)).toEqual(['BUREAU DE POSTE RENNES REPUBLIQUE']);
  });

  it('asks again after a failure, which is never cached', async () => {
    const cache = memoryCache();
    let calls = 0;
    const failing: PickupPointProvider = {
      async search() {
        calls++;
        return { ok: false, error: 'Boxtal injoignable', uncertain: true };
      },
    };
    expect((await searchRelayPoints(failing, cache, ORIGIN, rennes)).ok).toBe(false);
    expect((await searchRelayPoints(failing, cache, ORIGIN, rennes)).ok).toBe(false);
    expect(calls).toBe(2);
    expect(cache.keys).toHaveLength(0);
  });

  it('caches a postcode with no point, which is an answer', async () => {
    const cache = memoryCache();
    const none = boxtalPickupPoints({ keys, sandbox: true, fetch: replay('05-parcel-points-bad-postcode').fetch });
    const search = { ...rennes, offer: 'MONR-CpourToi', postalCode: '00000', city: '' };
    expect(await searchRelayPoints(none, cache, ORIGIN, search)).toEqual({ ok: true, value: [] });
    expect(await searchRelayPoints(none, cache, ORIGIN, search)).toEqual({ ok: true, value: [] });
  });

  it('searches without a cache, and through one that refuses', async () => {
    expect((await searchRelayPoints(colissimo(), null, ORIGIN, rennes)).ok).toBe(true);
    const refusing: PointCache = {
      match: () => Promise.reject(new Error('cache down')),
      put: () => Promise.reject(new Error('cache down')),
    };
    expect((await searchRelayPoints(colissimo(), refusing, ORIGIN, rennes)).ok).toBe(true);
  });
});

describe('the point a shopper posts', () => {
  const at = (code: string): PickupPoint => ({
    code,
    name: `Point ${code}`,
    street: '1 rue Essai',
    city: 'Rennes',
    postalCode: '35000',
    country: 'FR',
    latitude: null,
    longitude: null,
    distanceMeters: null,
    hours: null,
    locker: false,
    maxWeightGrams: null,
  });
  const listed = Array.from({ length: RELAY_POINTS_SHOWN + 2 }, (_, i) => at(String(1000 + i)));

  it('is believed only among the points the shop listed', () => {
    expect(servedPoint(listed, '1000')?.code).toBe('1000');
    expect(servedPoint(listed, ' 1003 ')?.code).toBe('1003');
    expect(servedPoint(listed, '9999')).toBeNull();
    expect(servedPoint(listed, '')).toBeNull();
    // Found by the search, but past the list the page showed.
    expect(servedPoint(listed, String(1000 + RELAY_POINTS_SHOWN))).toBeNull();
  });
});
