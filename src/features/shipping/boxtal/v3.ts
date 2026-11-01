/**
 * Boxtal API v3: relay-point search, shipments, documents and tracking
 * (ADR 0020, amended by ADR 0021). The price comes from the v1 quote
 * (./quote.ts); everything else lives here.
 *
 * Plain fetch + HTTP Basic (the v3 application's access and secret keys), no
 * SDK. The payload/parse helpers are pure and exported: their tests replay the
 * responses recorded in Boxtal's sandbox (test/fixtures/boxtal/), not the
 * OpenAPI file, which the recorded answers contradict in places.
 *
 * What the sandbox established, and this module relies on:
 * - no idempotency: posting the same shipment twice buys two (`16`). A lost
 *   answer to `purchase` is `uncertain`, never retried here;
 * - no read-back of a point by its code: `search` is the only way in;
 * - a cancel is refused once the carrier has the parcel (`25`);
 * - a document URL is signed for 31 days and re-signed on every read (`24`).
 */

import { t } from '../../i18n/index.ts';
import { toMajorUnits, toMinorUnits } from '../../../money.ts';
import type {
  LabelProvider,
  LabelResult,
  OpeningHours,
  PackageTracking,
  PickupPoint,
  PickupPointProvider,
  PickupPointQuery,
  Shipment,
  ShipmentDocument,
  ShipmentParty,
  ShipmentRequest,
  ShipmentStatus,
  TrackingEvent,
  Weekday,
} from '../provider.ts';
import { pointsForWeight } from '../relay.ts';

export const BOXTAL_V3_BASE = {
  sandbox: 'https://api.boxtal.build',
  live: 'https://api.boxtal.com',
} as const;

export interface BoxtalKeys {
  accessKey: string;
  secretKey: string;
}

export interface BoxtalOptions {
  keys: BoxtalKeys;
  /** Sandbox keys only open the sandbox, and live keys only production. */
  sandbox: boolean;
  /** Injected by tests; the Worker's own fetch otherwise. */
  fetch?: typeof fetch;
}

/** Package `externalId` for the n-th parcel of an attempt (one per attempt today). */
export function packageReference(reference: string, index = 0): string {
  return `${reference}-${index + 1}`;
}

// ── Payloads ─────────────────────────────────────────────────────────────────

interface BoxtalAddress {
  type: 'BUSINESS' | 'RESIDENTIAL';
  contact: { firstName: string; lastName: string; company?: string; email: string; phone: string };
  location: {
    number?: string;
    street: string;
    city: string;
    postalCode: string;
    countryIsoCode: string;
  };
  additionalInformation?: string;
}

function address(party: ShipmentParty): BoxtalAddress {
  return {
    type: party.kind === 'business' ? 'BUSINESS' : 'RESIDENTIAL',
    contact: {
      firstName: party.firstName,
      lastName: party.lastName,
      ...(party.company && { company: party.company }),
      email: party.email,
      phone: party.phone,
    },
    location: {
      ...(party.number && { number: party.number }),
      street: party.street,
      city: party.city,
      postalCode: party.postalCode,
      countryIsoCode: party.country.toUpperCase(),
    },
    ...(party.extra && { additionalInformation: party.extra }),
  };
}

/**
 * The create-shipment body. Pure, so tests pin the wire shape against the
 * bodies Boxtal accepted (`10`, `11`).
 *
 * `PDF_10x15` is asked for the thermal printers merchants use; the sandbox
 * answered with A4 anyway, which the campaign checks on a real account.
 */
export function buildShipmentPayload(request: ShipmentRequest): Record<string, unknown> {
  const { parcel } = request;
  return {
    shippingOfferCode: request.offerCode,
    labelType: 'PDF_10x15',
    shipment: {
      externalId: request.reference,
      packages: [
        {
          type: 'PARCEL',
          // Grams are the shop's unit; Boxtal weighs in kilograms.
          weight: parcel.weightGrams / 1000,
          // Whole centimetres in the spec; rounding up never under-declares.
          length: Math.ceil(parcel.lengthCm),
          width: Math.ceil(parcel.widthCm),
          height: Math.ceil(parcel.heightCm),
          value: {
            value: toMajorUnits(parcel.valueCents, parcel.currency),
            currency: parcel.currency.toUpperCase(),
          },
          content: { id: parcel.contentCode, description: parcel.contentDescription },
          externalId: packageReference(request.reference),
        },
      ],
      fromAddress: address(request.from),
      toAddress: address(request.to),
      ...(request.pickupPointCode && { pickupPointCode: request.pickupPointCode }),
      ...(request.dropoffPointCode && { dropoffPointCode: request.dropoffPointCode }),
    },
  };
}

// ── Parsers ──────────────────────────────────────────────────────────────────

const WEEKDAYS: readonly Weekday[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

/**
 * A point's network list says what it takes. Colissimo caps by weight
 * (`POFR_UP_TO_20_KG_NETWORK`): a point takes up to its HIGHEST cap. A point
 * whose networks carry no cap says nothing, and Boxtal judges the parcel when
 * the label is bought.
 */
export function pointMaxWeightGrams(networks: readonly string[]): number | null {
  let max: number | null = null;
  for (const network of networks) {
    const match = /_UP_TO_(\d+)_KG_NETWORK$/.exec(network);
    if (match) max = Math.max(max ?? 0, Number(match[1]) * 1000);
  }
  return max;
}

/** Mondial Relay lists its lockers in the relay network: `…_LOCKERS_ONLY_NETWORK`. */
export function isLocker(networks: readonly string[]): boolean {
  return networks.some((network) => network.includes('_LOCKERS_ONLY_'));
}

interface BoxtalSlot {
  openingTime?: string;
  closingTime?: string;
}

function parseHours(raw: unknown): OpeningHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const days = raw as Partial<Record<Weekday, BoxtalSlot[] | null>>;
  const hours = {} as OpeningHours;
  for (const day of WEEKDAYS) {
    hours[day] = (days[day] ?? []).flatMap((slot) =>
      slot.openingTime && slot.closingTime ? [{ opens: slot.openingTime, closes: slot.closingTime }] : [],
    );
  }
  return hours;
}

interface BoxtalPointEntry {
  distanceFromSearchLocation?: number;
  parcelPoint?: {
    code?: string;
    name?: string;
    compatibleNetworks?: string[];
    location?: {
      street?: string;
      city?: string;
      postalCode?: string;
      countryIsoCode?: string;
      position?: { latitude?: number; longitude?: number };
    };
    openingDays?: unknown;
  };
}

/** Points of a search answer, nearest first as Boxtal sorts them. Pure. */
export function parsePickupPoints(content: unknown): PickupPoint[] {
  if (!Array.isArray(content)) return [];
  return (content as BoxtalPointEntry[]).flatMap((entry) => {
    const point = entry.parcelPoint;
    const location = point?.location;
    if (!point?.code || !point.name || !location?.street || !location.city || !location.postalCode) {
      return [];
    }
    const networks = point.compatibleNetworks ?? [];
    return [
      {
        code: point.code,
        name: point.name,
        street: location.street,
        city: location.city,
        postalCode: location.postalCode,
        country: (location.countryIsoCode ?? '').toUpperCase(),
        latitude: location.position?.latitude ?? null,
        longitude: location.position?.longitude ?? null,
        distanceMeters: entry.distanceFromSearchLocation ?? null,
        hours: parseHours(point.openingDays),
        locker: isLocker(networks),
        maxWeightGrams: pointMaxWeightGrams(networks),
      },
    ];
  });
}

const SHIPMENT_STATUSES: readonly ShipmentStatus[] = ['PENDING', 'REQUESTED', 'CONFIRMED', 'CANCELLED'];

interface BoxtalShipment {
  id?: string;
  status?: string;
  deliveryPriceExclTax?: { value?: number; currency?: string } | null;
  expectedTakingOverDate?: string | null;
  estimatedDeliveryDate?: string | null;
}

/** A shipment from an order, a read-back or a cancel answer; null if malformed. Pure. */
export function parseShipment(content: unknown): Shipment | null {
  const raw = content as BoxtalShipment | null;
  if (!raw?.id || !SHIPMENT_STATUSES.includes(raw.status as ShipmentStatus)) return null;
  const price = raw.deliveryPriceExclTax;
  const currency = price?.currency ? price.currency.toUpperCase() : null;
  return {
    id: raw.id,
    status: raw.status as ShipmentStatus,
    priceExclTaxCents:
      currency && typeof price?.value === 'number' ? toMinorUnits(price.value, currency) : null,
    currency,
    expectedTakingOverDate: raw.expectedTakingOverDate ?? null,
    estimatedDeliveryDate: raw.estimatedDeliveryDate ?? null,
  };
}

/** Documents of a shipment; an entry without a URL is dropped. Pure. */
export function parseDocuments(content: unknown): ShipmentDocument[] {
  if (!Array.isArray(content)) return [];
  return (content as Array<{ type?: string; format?: string; url?: string }>).flatMap((doc) =>
    doc.url ? [{ type: doc.type ?? 'LABEL', format: doc.format ?? '', url: doc.url }] : [],
  );
}

interface BoxtalTrackingEvent {
  trackingDateTime?: string;
  status?: string;
  message?: string;
  location?: string | null;
  isFinal?: boolean;
}

interface BoxtalPackageTracking extends BoxtalTrackingEvent {
  packageExternalId?: string | null;
  trackingNumber?: string;
  packageTrackingUrl?: string | null;
  history?: BoxtalTrackingEvent[];
}

function trackingEvent(raw: BoxtalTrackingEvent): TrackingEvent {
  return {
    status: raw.status ?? '',
    message: raw.message ?? '',
    at: raw.trackingDateTime ?? '',
    location: raw.location ?? null,
    isFinal: raw.isFinal === true,
  };
}

/**
 * Tracking per package. The head fields are the current state: the history is
 * newest first, but two events can share a second in any order (`22`), so the
 * rank of a status is never used to sort them. Pure.
 */
export function parseTracking(content: unknown): PackageTracking[] {
  if (!Array.isArray(content)) return [];
  return (content as BoxtalPackageTracking[]).flatMap((pkg) => {
    if (!pkg.trackingNumber || !pkg.status) return [];
    const history = (pkg.history ?? []).map(trackingEvent);
    const head = trackingEvent(pkg);
    // The head carries no location; the matching history entry does.
    const same = history.find((event) => event.at === head.at && event.status === head.status);
    return [
      {
        reference: pkg.packageExternalId ?? null,
        trackingNumber: pkg.trackingNumber,
        trackingUrl: pkg.packageTrackingUrl ?? null,
        current: { ...head, location: same?.location ?? null },
        history,
      },
    ];
  });
}

/**
 * Whether a shipment's tracking proves it belongs to this attempt: its package
 * carries the reference the shop sent. The only check a pasted Boxtal id gets
 * before it settles an uncertain purchase (ADR 0021).
 */
export function trackingMatchesReference(tracking: readonly PackageTracking[], reference: string): boolean {
  return tracking.length > 0 && tracking.every((pkg) => pkg.reference === packageReference(reference));
}

// ── Errors ───────────────────────────────────────────────────────────────────

interface BoxtalErrorBody {
  errors?: Array<{ code?: string; parameters?: Array<{ code?: string; field?: string }> }>;
}

/** Every error and parameter code of an error answer, for matching and display. Pure. */
export function errorCodes(body: unknown): string[] {
  const errors = (body as BoxtalErrorBody | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((error) => [
    ...(error.code ? [error.code] : []),
    ...(error.parameters ?? []).flatMap((p) => (p.code ? [p.code] : [])),
  ]);
}

// ── Client ───────────────────────────────────────────────────────────────────

type Call =
  | { ok: true; status: number; content: unknown }
  | { ok: false; status: number | null; error: string; uncertain: boolean; codes: string[] };

// Every error here reaches the operator: the order route shows it and keeps it
// in `shipping_labels.error`, an Admin note, so it is French. Boxtal's own
// messages are never copied in, only its error codes.
async function call(
  options: BoxtalOptions,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Call> {
  const base = options.sandbox ? BOXTAL_V3_BASE.sandbox : BOXTAL_V3_BASE.live;
  const credentials = btoa(`${options.keys.accessKey}:${options.keys.secretKey}`);
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers: {
        authorization: `Basic ${credentials}`,
        accept: 'application/json',
        ...(body != null && { 'content-type': 'application/json' }),
      },
      ...(body != null && { body: JSON.stringify(body) }),
    });
  } catch {
    // The request may or may not have arrived — ambiguous by definition.
    return { ok: false, status: null, error: t('admin.shipping.boxtal.unreachable'), uncertain: true, codes: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, error: t('admin.shipping.boxtal.keysRejected'), uncertain: false, codes: [] };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      status: res.status,
      error: t('admin.shipping.boxtal.unreadable', { statut: res.status }),
      uncertain: res.ok || res.status >= 500,
      codes: [],
    };
  }
  if (!res.ok) {
    const codes = errorCodes(json);
    return {
      ok: false,
      status: res.status,
      error: codes.length
        ? t('admin.shipping.boxtal.answeredCodes', { statut: res.status, codes: codes.join(', ') })
        : t('admin.shipping.boxtal.answered', { statut: res.status }),
      // 4xx = judged and refused; 5xx = who knows what committed first.
      uncertain: res.status >= 500,
      codes,
    };
  }
  return { ok: true, status: res.status, content: (json as { content?: unknown }).content };
}

function failure(result: Extract<Call, { ok: false }>, error = result.error): LabelResult<never> {
  return { ok: false, error, uncertain: result.uncertain };
}

const orderPath = (id: string) => `/shipping/v3.1/shipping-order/${encodeURIComponent(id)}`;

/** The relay-point port, on Boxtal's search by offer. */
export function boxtalPickupPoints(options: BoxtalOptions): PickupPointProvider {
  return {
    async search(query: PickupPointQuery) {
      const params = new URLSearchParams({
        countryIsoCode: query.country.toUpperCase(),
        postalCode: query.postalCode,
        ...(query.city && { city: query.city }),
        shippingOfferCode: query.offerCode,
        operationType: 'ARRIVAL',
      });
      const result = await call(options, 'GET', `/shipping/v3.2/parcel-point-by-shipping-offer?${params}`);
      if (!result.ok) {
        return result.codes.includes('ValidationException.ValidShippingOfferCode')
          ? failure(result, t('admin.shipping.boxtal.unknownOffer', { offre: query.offerCode }))
          : failure(result);
      }
      // An unknown postcode is a 200 with no point (`05`): "none here", not a failure.
      return { ok: true, value: pointsForWeight(parsePickupPoints(result.content), query.weightGrams) };
    },
  };
}

/** The label port, on Boxtal's shipping orders. */
export function boxtalLabels(options: BoxtalOptions): LabelProvider {
  const shipmentOf = (result: Extract<Call, { ok: true }>): LabelResult<Shipment> => {
    const shipment = parseShipment(result.content);
    return shipment
      ? { ok: true, value: shipment }
      : { ok: false, error: t('admin.shipping.boxtal.unexpected'), uncertain: true };
  };

  return {
    async purchase(request: ShipmentRequest) {
      const result = await call(options, 'POST', '/shipping/v3.1/shipping-order', buildShipmentPayload(request));
      if (!result.ok) {
        if (result.codes.includes('ValidationException.PickupPointCode')) {
          return failure(result, t('admin.shipping.boxtal.pickupPointRefused'));
        }
        if (result.codes.includes('ValidationException.ValidShippingOfferCode')) {
          return failure(result, t('admin.shipping.boxtal.unknownOffer', { offre: request.offerCode }));
        }
        return failure(result);
      }
      // A 200 that does not read as a shipment may still have bought one.
      return shipmentOf(result);
    },

    async get(id: string) {
      const result = await call(options, 'GET', orderPath(id));
      if (!result.ok) {
        // A definite "no such shipment" is an answer, not a failure (`18`).
        return result.codes.includes('ShippingOrderNotFoundException')
          ? { ok: true, value: null }
          : failure(result);
      }
      const shipment = parseShipment(result.content);
      return shipment ? { ok: true, value: shipment } : { ok: false, error: t('admin.shipping.boxtal.unexpected') };
    },

    async cancel(id: string) {
      const result = await call(options, 'DELETE', orderPath(id));
      if (!result.ok) {
        if (result.codes.includes('ShippingOrderNotFoundException')) {
          return failure(result, t('admin.shipping.boxtal.orderNotFound'));
        }
        // The only refusal recorded: the carrier already has the parcel (`25`).
        if (result.status === 422 && result.codes.includes('InvalidRequestException')) {
          return failure(result, t('admin.shipping.boxtal.notCancellable'));
        }
        return failure(result);
      }
      return shipmentOf(result);
    },

    async documents(id: string) {
      const result = await call(options, 'GET', `${orderPath(id)}/shipping-document`);
      if (!result.ok) return failure(result);
      return { ok: true, value: parseDocuments(result.content) };
    },

    async tracking(id: string) {
      const result = await call(options, 'GET', `${orderPath(id)}/tracking`);
      if (!result.ok) return failure(result);
      return { ok: true, value: parseTracking(result.content) };
    },
  };
}
