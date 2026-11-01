/**
 * The relay point a shopper picks at checkout (ADR 0020, ADR 0021; plan §13.3,
 * lot 4).
 *
 * The shop searches the points of the offer a relay rate names, around the
 * address the shopper typed, and lists them as a form: no map, no third-party
 * script, no JavaScript required (invariant 1). Boxtal cannot read a point back
 * by its code, so a posted code is believed only if the same search served it;
 * the order then keeps a COPY of the point, which a point closing later does
 * not change.
 *
 * Pure apart from the injected provider and cache, so the tests drive both.
 */

import type { LabelResult, PickupPoint, PickupPointProvider } from './provider.ts';

/** What a reservation, then its order, keeps of the point. */
export interface RelayPoint {
  /** The relay offer the label is bought with: it fixes the network. */
  offer: string;
  code: string;
  name: string;
  street: string;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2: the one field an erasure keeps (shopctl/src/privacy/map.mjs). */
  country: string;
}

export function relayPointOf(offer: string, point: PickupPoint): RelayPoint {
  return {
    offer,
    code: point.code,
    name: point.name,
    street: point.street,
    postalCode: point.postalCode,
    city: point.city,
    country: point.country,
  };
}

/** The stored snapshot, or null when there is none or it no longer reads. */
export function parseRelayPoint(raw: string | null | undefined): RelayPoint | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const fields = ['offer', 'code', 'name', 'street', 'postalCode', 'city', 'country'] as const;
  if (!fields.every((field) => typeof v[field] === 'string')) return null;
  return Object.fromEntries(fields.map((field) => [field, v[field]])) as unknown as RelayPoint;
}

/**
 * The point an order is collected at. Only a relay order has one, and an
 * erased order keeps the country alone, which reads as none.
 */
export function orderRelayPoint(order: {
  delivery_method?: string | null;
  relay_point?: string | null;
}): RelayPoint | null {
  return order.delivery_method === 'relay' ? parseRelayPoint(order.relay_point) : null;
}

/** The point as the shopper finds it: its name, its street, its town. */
export function relayPointLines(point: RelayPoint): string[] {
  return [point.name, point.street, `${point.postalCode} ${point.city}`];
}

/** Points that can take a parcel of this weight. A point that states no cap stays. */
export function pointsForWeight(points: readonly PickupPoint[], weightGrams: number): PickupPoint[] {
  return points.filter((point) => point.maxWeightGrams == null || point.maxWeightGrams >= weightGrams);
}

/** How many points the checkout lists, nearest first. */
export const RELAY_POINTS_SHOWN = 10;

/**
 * How long a search is reused. A point's list and hours move over days, not
 * minutes; the hour bounds what a shopper sees after one closes, and the label
 * purchase is where Boxtal judges the point again.
 */
export const RELAY_POINTS_TTL_SECONDS = 60 * 60;

/** The part of the Workers Cache API this module uses. */
export interface PointCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface RelaySearch {
  offer: string;
  country: string;
  postalCode: string;
  city: string;
  /** The packed parcel: points that cannot take it are left out. */
  weightGrams: number;
  /** Sandbox and live are two networks of points; their answers never mix. */
  sandbox: boolean;
}

/**
 * The cache key for one search. Under the shop's own origin, where the Cache
 * API stores it; the Worker answers every public request before the cache, so
 * nothing outside reads it. Postcode and city are normalised so the spacing a
 * shopper types does not split one search into two.
 */
export function relaySearchKey(origin: string, search: RelaySearch): string {
  const postal = search.postalCode.replace(/\s+/g, '').toUpperCase();
  const city = search.city.trim().replace(/\s+/g, ' ').toLowerCase();
  const path = [search.sandbox ? 'sandbox' : 'live', search.offer, search.country.toUpperCase(), postal]
    .map(encodeURIComponent)
    .join('/');
  return `${origin}/_relay-points/v1/${path}?city=${encodeURIComponent(city)}`;
}

/**
 * The points of one relay offer around an address, nearest first, that can
 * take the parcel.
 *
 * The cache keeps every point of the search and the weight is applied on the
 * way out: a basket's weight changes which points are shown, not the search
 * Boxtal answers. Only an answer is cached — a failure is asked again next
 * time, and a postcode with no point (an answer) is cached like any other.
 */
export async function searchRelayPoints(
  provider: PickupPointProvider,
  cache: PointCache | null,
  origin: string,
  search: RelaySearch,
): Promise<LabelResult<PickupPoint[]>> {
  const key = relaySearchKey(origin, search);
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) {
    const points = (await hit.json().catch(() => null)) as PickupPoint[] | null;
    if (Array.isArray(points)) return { ok: true, value: pointsForWeight(points, search.weightGrams) };
  }
  const result = await provider.search({
    offerCode: search.offer,
    country: search.country,
    postalCode: search.postalCode,
    city: search.city,
    // No cap: every point is cached, the weight applied below.
    weightGrams: 0,
  });
  if (!result.ok) return result;
  if (cache) {
    const response = new Response(JSON.stringify(result.value), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${RELAY_POINTS_TTL_SECONDS}`,
      },
    });
    // A cache that refuses is a slower checkout, not a broken one.
    await cache.put(key, response).catch(() => undefined);
  }
  return { ok: true, value: pointsForWeight(result.value, search.weightGrams) };
}

/** The point a posted code names, among those the shop served — never trusted otherwise. */
export function servedPoint(points: readonly PickupPoint[], code: string): PickupPoint | null {
  const wanted = code.trim();
  if (!wanted) return null;
  return points.slice(0, RELAY_POINTS_SHOWN).find((point) => point.code === wanted) ?? null;
}
