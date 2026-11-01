/**
 * The shipping ports (ADR 0020, amended by ADR 0021): what the order page and
 * the checkout ask of a shipping provider, never how a provider answers.
 *
 * Three ports, because Boxtal splits them and a later provider may too:
 * - `PickupPointProvider` searches the relay points of ONE offer around an
 *   address. Nothing reads a point back by its code — Boxtal has no such call —
 *   so a point is trusted only if the shop served it (ADR 0021);
 * - `LabelProvider` buys a shipment, reads it back by the provider's id,
 *   cancels it, and returns its documents and tracking. It never quotes;
 * - `ShippingQuoteProvider` prices the merchant's chosen offers for a parcel.
 *   Optional: without it, a label is bought unpriced and the price arrives with
 *   the order.
 *
 * Pure types only, so adapters and their tests share them without touching the
 * network.
 */

/**
 * `uncertain` marks outcomes where the request MAY have succeeded (network
 * failure, 5xx, unreadable body): for a purchase that moves money, the caller
 * must park the attempt rather than retry. Definite refusals (4xx) are safe to
 * retry with corrections.
 */
export type LabelResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; uncertain?: boolean };

/** One end of a shipment, as a carrier needs it on the label. */
export interface ShipmentParty {
  kind: 'business' | 'residential';
  firstName: string;
  lastName: string;
  company?: string | null;
  email: string;
  phone: string;
  /** Street line as typed, house number included unless `number` is split out. */
  street: string;
  number?: string | null;
  /** Second address line (building, floor…), carried as extra information. */
  extra?: string | null;
  city: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/** One packed parcel. Carriers price on whole centimetres. */
export interface ShipmentParcel {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** Declared value of the contents, in minor units of `currency`. */
  valueCents: number;
  currency: string;
  /** The provider's nature-of-contents code (Boxtal: `content:v1:40110`). */
  contentCode: string;
  contentDescription: string;
}

export type Weekday =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

/** Opening slots per day; an empty list is a closed day. */
export type OpeningHours = Record<Weekday, Array<{ opens: string; closes: string }>>;

export interface PickupPoint {
  /** The code the offer is bought with (Boxtal v3: `41132`). */
  code: string;
  name: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  /** From the searched address, as the provider measured it. */
  distanceMeters: number | null;
  hours: OpeningHours | null;
  /** A locker rather than a counter: no staff, size limits of its own. */
  locker: boolean;
  /** Heaviest parcel the point takes, when the provider says; null = not said. */
  maxWeightGrams: number | null;
}

export interface PickupPointQuery {
  /** The offer the point will be bought with: it fixes the network. */
  offerCode: string;
  country: string;
  postalCode: string;
  city?: string | null;
  /** The packed parcel: points that cannot take it are left out. */
  weightGrams: number;
}

export interface PickupPointProvider {
  search(query: PickupPointQuery): Promise<LabelResult<PickupPoint[]>>;
}

export interface ShipmentRequest {
  offerCode: string;
  /**
   * The shop's reference for THIS attempt. Providers without idempotency keep
   * it on the shipment, which is how a pasted provider id is checked against
   * the attempt it claims to settle (ADR 0021).
   */
  reference: string;
  from: ShipmentParty;
  to: ShipmentParty;
  parcel: ShipmentParcel;
  /** Relay offers: where the buyer collects the parcel. */
  pickupPointCode?: string | null;
  /** Relay offers that start at a point: where the merchant drops it off. */
  dropoffPointCode?: string | null;
}

export type ShipmentStatus = 'PENDING' | 'REQUESTED' | 'CONFIRMED' | 'CANCELLED';

export interface Shipment {
  /** The provider's id: what the merchant sees in the provider's dashboard. */
  id: string;
  status: ShipmentStatus;
  /** What the provider charges, tax excluded, once it says. */
  priceExclTaxCents: number | null;
  currency: string | null;
  /** YYYY-MM-DD, indicative. */
  expectedTakingOverDate: string | null;
  estimatedDeliveryDate: string | null;
}

export interface ShipmentDocument {
  type: string;
  format: string;
  /** A signed URL that expires: read the document again, never store this. */
  url: string;
}

export type TrackingStatus =
  | 'ANNOUNCED'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'FAILED_ATTEMPT'
  | 'REACHED_DELIVERY_PICKUP_POINT'
  | 'DELIVERED'
  | 'RETURNED'
  | 'EXCEPTION';

export interface TrackingEvent {
  status: TrackingStatus | string;
  message: string;
  /** Provider wall-clock time, without a zone (Boxtal: Europe/Paris). */
  at: string;
  location: string | null;
  isFinal: boolean;
}

export interface PackageTracking {
  /** The shop's reference for the package, as sent with the shipment. */
  reference: string | null;
  trackingNumber: string;
  /** The carrier's own tracking page, as the provider built it. */
  trackingUrl: string | null;
  /** The latest state, as the provider reports it. */
  current: TrackingEvent;
  /** Newest first. */
  history: TrackingEvent[];
}

export interface LabelProvider {
  /** Buy a shipment. This MOVES MONEY on the merchant's account. */
  purchase(request: ShipmentRequest): Promise<LabelResult<Shipment>>;
  /** Read a shipment back by the provider's id; null = the provider has none. */
  get(id: string): Promise<LabelResult<Shipment | null>>;
  /** Cancel before the carrier takes the parcel; refused afterwards. */
  cancel(id: string): Promise<LabelResult<Shipment>>;
  documents(id: string): Promise<LabelResult<ShipmentDocument[]>>;
  tracking(id: string): Promise<LabelResult<PackageTracking[]>>;
}

export interface QuoteParty {
  kind: 'business' | 'residential';
  postalCode: string;
  city: string;
  country: string;
}

export interface QuoteRequest {
  /** Only these offers are priced; anything else in the answer is dropped. */
  offerCodes: string[];
  from: QuoteParty;
  to: QuoteParty;
  parcel: Pick<ShipmentParcel, 'weightGrams' | 'lengthCm' | 'widthCm' | 'heightCm'>;
  /** The nature-of-contents code, without the provider's prefix (`40110`). */
  contentCode: string;
}

export interface OfferQuote {
  offerCode: string;
  carrier: string;
  service: string;
  /** The price the purchase confirms. */
  priceExclTaxCents: number;
  /** Rounded by the provider on its own: never derive one from the other. */
  priceInclTaxCents: number;
  currency: string;
  /** How the merchant hands the parcel over (`DROPOFF_POINT`, `POST_OFFICE`, `COMPANY`). */
  collection: string | null;
  /** Where the buyer receives it (`HOME`, `PICKUP_POINT`). */
  delivery: string | null;
}

export interface QuoteResult {
  /** Requested offers the provider priced, cheapest first. */
  offers: OfferQuote[];
  /** Requested offers the provider did not price for this parcel. */
  unavailable: string[];
}

export interface ShippingQuoteProvider {
  quote(request: QuoteRequest): Promise<LabelResult<QuoteResult>>;
}
