/**
 * A label bought from Boxtal for one order (ADR 0020, ADR 0021; plan §13.3,
 * lots 3 and 5): the steps the order page runs, on the label state machine of
 * `labelStore.ts`. A home order is bought on one of the retained offers; a
 * relay order on the offer of the point its buyer chose, to that point. The database and the providers come in as parameters, so the
 * integration suite drives these steps on a real D1 with the sandbox corpus.
 *
 * The steps, and what each one guards:
 * - `prepareLabel` keeps the sender and the parcel on the quoted row, with the
 *   retained offers and, when the optional v1 quote answers, their prices. The
 *   row also takes this attempt's reference, which Boxtal keeps on the parcel.
 * - `buyLabel` claims the row, then buys. Boxtal has no idempotency: a lost
 *   answer parks the attempt `uncertain`, and nothing buys again on its own.
 *   A purchase that answers is recorded at once, before its tracking number,
 *   which Boxtal only has once the order is CONFIRMED (corpus `45`, `49`).
 * - `readLabelTracking` lands the number, fulfils the order and queues the
 *   shipped e-mail, in one batch.
 * - `settleWithBoxtalId` takes the id the merchant pasted from Boxtal's
 *   dashboard, and records it only if its parcel carries this attempt's
 *   reference: Boxtal can neither list orders nor find one by reference.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { t } from '../../i18n/index.ts';
import {
  claimPurchase,
  getLabelRecord,
  isPurchaseStale,
  markLabelFailed,
  markLabelUncertain,
  recordLabelTracking,
  recordPurchasedAwaitingTracking,
  recordQuote,
  type LabelRecord,
} from '../labelStore.ts';
import type {
  LabelProvider,
  LabelResult,
  PackageTracking,
  QuoteResult,
  ShipmentParty,
  ShippingQuoteProvider,
} from '../provider.ts';
import { plausiblePhone } from '../recipient.ts';
import { orderRelayPoint, type RelayPoint } from '../relay.ts';
import { boxtalContent, quoteContentCode } from './contents.ts';
import { homeOffer, relayOffer } from './offers.ts';
import { trackingMatchesReference } from './v3.ts';

/** The sender on the label, as the label form keeps it in `ship_from`. */
export interface LabelSender {
  company: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/** The packed parcel, in centimetres and grams. */
export interface LabelParcel {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightGrams: number;
}

/** A retained offer as the order page shows it. */
export interface QuotedOffer {
  code: string;
  carrier: string;
  service: string;
  /** Tax excluded, from the v1 quote; null = bought unpriced. */
  priceExclTaxCents: number | null;
  currency: string | null;
  /** False when the quote ran and did not price it: « non proposée pour ce colis ». */
  available: boolean;
}

export interface QuotedOffers {
  offers: QuotedOffer[];
  /** Why the offers have no price when the quote failed; null otherwise. */
  quoteError: string | null;
}

/** Everything a step reads besides the order. */
export interface LabelContext {
  db: D1Database;
  labels: LabelProvider;
  /** The v1 quote; null without its keys. */
  quote: ShippingQuoteProvider | null;
  /** Retained offer codes (Réglages), in the catalogue's order. */
  offers: readonly string[];
  /** The nature of contents every parcel declares (`content:v1:…`). */
  contentId: string | null;
  /** The store currency: the declared value of the parcel is in it. */
  currency: string;
  /** Waits between tracking reads after a purchase; tests pass a no-op. */
  pause?: (ms: number) => Promise<void>;
  /** A fresh attempt reference; tests pin one that the corpus carries. */
  reference?: (order: LabelOrder) => string;
}

/** The order fields a label reads. */
export interface LabelOrder {
  id: number;
  public_id: string | null;
  email: string | null;
  ship_address: string | null;
  amount_total_cents: number;
  shipping_cents: number;
  delivery_method?: string | null;
  relay_point?: string | null;
}

/** What the merchant types on the buy step: Boxtal requires the recipient's phone. */
export interface LabelRecipient {
  firstName: string;
  lastName: string;
  phone: string;
}

export type LabelOutcome =
  | { ok: true; message: string; fulfilled: boolean }
  | { ok: false; error: string };

const fail = (error: string): LabelOutcome => ({ ok: false, error });

/**
 * Tracking reads after a purchase: Boxtal confirmed in 14 s and 20 s in the
 * sandbox (`12`, `48`). Past the last one the label stays bought, and the order
 * page offers to read the number again.
 */
export const TRACKING_WAITS_MS: readonly number[] = [4_000, 6_000, 8_000, 10_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * The sender from its setting. A sender saved for Shippo (`name`, `street1`,
 * `zip`) still prefills the form; the fields Boxtal adds start empty.
 */
export function parseSender(raw: string | null | undefined): Partial<LabelSender> {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object') return {};
  const text = (...keys: string[]) => {
    for (const key of keys) if (typeof value[key] === 'string') return value[key] as string;
    return undefined;
  };
  return {
    company: text('company', 'name'),
    firstName: text('firstName'),
    lastName: text('lastName'),
    email: text('email'),
    phone: text('phone'),
    street: text('street', 'street1'),
    city: text('city'),
    postalCode: text('postalCode', 'zip'),
    country: text('country'),
  };
}

/** A complete sender, trimmed, or null. */
export function completeSender(input: Partial<LabelSender>): LabelSender | null {
  const field = (value: string | undefined) => (value ?? '').trim();
  const sender: LabelSender = {
    company: field(input.company),
    firstName: field(input.firstName),
    lastName: field(input.lastName),
    email: field(input.email),
    phone: field(input.phone),
    street: field(input.street),
    city: field(input.city),
    postalCode: field(input.postalCode),
    country: field(input.country).toUpperCase(),
  };
  const filled = Object.values(sender).every((value) => value !== '');
  return filled && /^[A-Z]{2}$/.test(sender.country) && sender.email.includes('@') && plausiblePhone(sender.phone)
    ? sender
    : null;
}

/** Prefill for the recipient: the last word is the family name. */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { firstName: '', lastName: words[0] ?? '' };
  return { firstName: words.slice(0, -1).join(' '), lastName: words[words.length - 1] };
}

/**
 * This attempt's reference: the order's public id, for the merchant to find in
 * Boxtal's dashboard, and a random part, so that a parcel bought by an earlier
 * attempt can never settle this one.
 */
export function newReference(order: Pick<LabelOrder, 'id' | 'public_id'>): string {
  return `${order.public_id ?? `commande-${order.id}`}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * The retained offers with what the quote said of them: priced cheapest
 * first, then unpriced, then the ones it did not price. Without a quote, or
 * when it failed, every offer stays buyable, unpriced (ADR 0021).
 */
export function quotedOffers(
  retained: readonly string[],
  quote: LabelResult<QuoteResult> | null,
): QuotedOffers {
  const offers = retained.flatMap((code): QuotedOffer[] => {
    const offer = homeOffer(code) ?? relayOffer(code);
    if (!offer) return [];
    const unpriced = { code, carrier: offer.carrier, service: offer.service, priceExclTaxCents: null, currency: null };
    if (!quote?.ok) return [{ ...unpriced, available: true }];
    const priced = quote.value.offers.find((entry) => entry.offerCode === code);
    return [
      priced
        ? { ...unpriced, priceExclTaxCents: priced.priceExclTaxCents, currency: priced.currency, available: true }
        : { ...unpriced, available: false },
    ];
  });
  const rank = (offer: QuotedOffer) => (!offer.available ? 2 : offer.priceExclTaxCents == null ? 1 : 0);
  offers.sort((a, b) => rank(a) - rank(b) || (a.priceExclTaxCents ?? 0) - (b.priceExclTaxCents ?? 0));
  return { offers, quoteError: quote && !quote.ok ? quote.error : null };
}

export function parseQuotedOffers(raw: string | null): QuotedOffers | null {
  try {
    const value = JSON.parse(raw ?? 'null') as QuotedOffers | null;
    return value && Array.isArray(value.offers) ? value : null;
  } catch {
    return null;
  }
}

interface QuotedParcel {
  from: LabelSender;
  parcel: LabelParcel;
}

function parseQuotedParcel(raw: string | null): QuotedParcel | null {
  try {
    const value = JSON.parse(raw ?? 'null') as QuotedParcel | null;
    return value?.from && value.parcel ? value : null;
  } catch {
    return null;
  }
}

interface Destination {
  name: string;
  street: string;
  extra: string | null;
  city: string;
  postalCode: string;
  country: string;
}

/** The order's delivery address, or the reason it cannot go on a label. */
function destination(order: LabelOrder): Destination | string {
  if (!order.ship_address) return t('admin.orders.notice.labelNoAddress');
  let raw: Record<string, string | null>;
  try {
    raw = JSON.parse(order.ship_address) as Record<string, string | null>;
  } catch {
    return t('admin.orders.notice.labelAddressUnreadable');
  }
  if (!raw.name || !raw.line1 || !raw.city || !raw.postal || !raw.country) {
    return t('admin.orders.notice.labelAddressIncomplete');
  }
  return {
    name: raw.name,
    street: raw.line1,
    extra: raw.line2 || null,
    city: raw.city,
    postalCode: raw.postal,
    country: raw.country.toUpperCase(),
  };
}

interface LabelOffers {
  codes: readonly string[];
  /** The point a relay label goes to; null for a home label. */
  point: RelayPoint | null;
}

/**
 * The offers this order's label can be bought on: the retained home offers,
 * or, for a relay order, the one offer of the point its buyer chose. The
 * network came with the point, and Boxtal checks the point against the offer
 * when the label is bought (`17`).
 */
function labelOffers(ctx: LabelContext, order: LabelOrder): LabelOffers | string {
  if (order.delivery_method !== 'relay') {
    return ctx.offers.length > 0 ? { codes: ctx.offers, point: null } : t('admin.orders.notice.boxtal.noOffers');
  }
  const point = orderRelayPoint(order);
  if (!point || !relayOffer(point.offer)) return t('admin.orders.notice.boxtal.noRelayPoint');
  return { codes: [point.offer], point };
}

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * Keep the sender and the parcel on the order's quoted row, with the retained
 * offers and the prices the v1 quote gave them. Nothing is bought.
 */
export async function prepareLabel(
  ctx: LabelContext,
  order: LabelOrder,
  input: { from: Partial<LabelSender>; parcel: LabelParcel },
): Promise<LabelOutcome> {
  const offers = labelOffers(ctx, order);
  if (typeof offers === 'string') return fail(offers);
  if (!boxtalContent(ctx.contentId)) return fail(t('admin.orders.notice.boxtal.noContent'));
  const to = destination(order);
  if (typeof to === 'string') return fail(to);
  const from = completeSender(input.from);
  if (!from) return fail(t('admin.orders.notice.boxtal.senderIncomplete'));
  // A relay parcel travels to its point, wherever its buyer lives.
  const arrival = offers.point ?? to;
  // Domestic only: abroad, a label needs a customs declaration this flow does
  // not collect.
  if (from.country !== arrival.country) {
    return fail(t('admin.orders.notice.labelInternational', { pays: arrival.country }));
  }

  const quote = ctx.quote
    ? await ctx.quote.quote({
        offerCodes: [...offers.codes],
        from: { kind: 'business', postalCode: from.postalCode, city: from.city, country: from.country },
        to: { kind: 'residential', postalCode: arrival.postalCode, city: arrival.city, country: arrival.country },
        parcel: input.parcel,
        contentCode: quoteContentCode(ctx.contentId!),
      })
    : null;
  const reference = (ctx.reference ?? newReference)(order);
  const kept = await recordQuote(ctx.db, order.id, reference, {
    parcel: JSON.stringify({ from, parcel: input.parcel } satisfies QuotedParcel),
    offers: JSON.stringify(quotedOffers(offers.codes, quote)),
  });
  // Refused: a purchase is in flight or done, or the order is no longer to
  // label (unpaid, fulfilled, pickup). Nothing was bought either way.
  return kept ? { ok: true, message: '', fulfilled: false } : fail(t('admin.orders.notice.labelQuoteRefused'));
}

/**
 * Buy the label on one of the offers the quoted row shows. This MOVES MONEY on
 * the merchant's Boxtal account, which bills it afterwards (ADR 0021).
 */
export async function buyLabel(
  ctx: LabelContext,
  order: LabelOrder,
  input: { offerCode: string; recipient: LabelRecipient },
): Promise<LabelOutcome> {
  const record = await getLabelRecord(ctx.db, order.id);
  const quoted = record?.vendor === 'boxtal' && record.status === 'quoted' ? parseQuotedOffers(record.offers) : null;
  const details = record && quoted ? parseQuotedParcel(record.parcel) : null;
  if (!record || !quoted || !details) return fail(t('admin.orders.notice.labelNoQuote'));
  const offers = labelOffers(ctx, order);
  if (typeof offers === 'string') return fail(offers);
  if (!input.offerCode) return fail(t('admin.orders.notice.boxtal.pickOffer'));
  const offer = quoted.offers.find((entry) => entry.code === input.offerCode);
  if (!offer) return fail(t('admin.orders.notice.boxtal.pickOffer'));
  if (!offer.available) return fail(t('admin.orders.notice.boxtal.offerNotOffered'));
  if (!offers.codes.includes(offer.code)) return fail(t('admin.orders.notice.boxtal.offerNotRetained'));
  const content = boxtalContent(ctx.contentId);
  if (!content) return fail(t('admin.orders.notice.boxtal.noContent'));
  const to = destination(order);
  if (typeof to === 'string') return fail(to);
  if (!order.email) return fail(t('admin.orders.notice.boxtal.noEmail'));
  const recipient = {
    firstName: input.recipient.firstName.trim(),
    lastName: input.recipient.lastName.trim(),
    phone: input.recipient.phone.trim(),
  };
  if (!recipient.firstName || !recipient.lastName || !plausiblePhone(recipient.phone)) {
    return fail(t('admin.orders.notice.boxtal.recipientIncomplete'));
  }

  // Exactly one concurrent submit flips quoted → purchasing; the reference
  // bought under is the row's, never the browser's.
  const claim = await claimPurchase(ctx.db, order.id, offer.code);
  if (!claim) return fail(t('admin.orders.notice.labelNoQuote'));

  const sender: ShipmentParty = { kind: 'business', ...details.from };
  const bought = await ctx.labels.purchase({
    offerCode: offer.code,
    reference: claim.shipmentId,
    from: sender,
    to: {
      kind: 'residential',
      ...recipient,
      email: order.email,
      street: to.street,
      extra: to.extra,
      city: to.city,
      postalCode: to.postalCode,
      country: to.country,
    },
    parcel: {
      ...details.parcel,
      // The goods, tax included, shipping left out.
      valueCents: Math.max(0, order.amount_total_cents - order.shipping_cents),
      currency: ctx.currency,
      contentCode: content.id,
      contentDescription: content.label,
    },
    // Read off the order, never the form: the point is the one the buyer chose.
    ...(offers.point && { pickupPointCode: offers.point.code }),
  });
  if (!bought.ok) {
    if (bought.uncertain) {
      // The order MAY exist at Boxtal. Park it: buying again could pay twice.
      await markLabelUncertain(ctx.db, order.id, claim.claimToken, bought.error);
      return fail(t('admin.orders.notice.boxtal.uncertain', { erreur: bought.error, reference: claim.shipmentId }));
    }
    await markLabelFailed(ctx.db, order.id, claim.claimToken, bought.error);
    return fail(bought.error);
  }

  const shipment = bought.value;
  const recorded = await recordPurchasedAwaitingTracking(ctx.db, order.id, claim.claimToken, {
    transactionId: shipment.id,
    provider: offer.carrier,
    service: offer.service,
    amountCents: shipment.priceExclTaxCents,
  });
  // This attempt was discarded while Boxtal answered: its order exists only
  // there. Nothing here changed, by design; the charge needs human eyes.
  if (!recorded) return fail(t('admin.orders.notice.boxtal.superseded', { envoi: shipment.id }));

  return readLabelTracking(
    ctx,
    order,
    { ...record, rate_id: offer.code, transaction_id: shipment.id, provider: offer.carrier, service: offer.service },
    TRACKING_WAITS_MS,
  );
}

/** Land the tracking number of a label bought without one, waiting before each read. */
async function readLabelTracking(
  ctx: LabelContext,
  order: LabelOrder,
  record: Pick<LabelRecord, 'shipment_id' | 'rate_id' | 'transaction_id' | 'provider' | 'service'>,
  waits: readonly number[],
): Promise<LabelOutcome> {
  const id = record.transaction_id!;
  let parcels: PackageTracking[] = [];
  for (const wait of waits) {
    if (wait > 0) await (ctx.pause ?? sleep)(wait);
    const read = await ctx.labels.tracking(id);
    if (read.ok && read.value.length > 0) {
      parcels = read.value;
      break;
    }
  }
  const service = `${record.provider ?? ''} ${record.service ?? ''}`.trim();
  if (parcels.length === 0) {
    return {
      ok: true,
      message: t('admin.orders.notice.boxtal.awaitingTracking', {
        service,
        envoi: id,
        bouton: t('admin.orders.detail.label.readTracking'),
      }),
      fulfilled: false,
    };
  }
  // The parcel must be this attempt's: the same check a pasted id passes.
  if (!trackingMatchesReference(parcels, record.shipment_id)) {
    return fail(
      t('admin.orders.notice.boxtal.referenceMismatch', {
        envoi: id,
        trouvee: parcels[0].reference ?? '—',
        attendue: record.shipment_id,
      }),
    );
  }
  const parcel = parcels[0];
  const landed = await recordLabelTracking(ctx.db, order.id, id, {
    trackingNumber: parcel.trackingNumber,
    trackingUrl: parcel.trackingUrl,
    carrierCode: homeOffer(record.rate_id)?.carrierCode ?? 'other',
  });
  if (!landed.recorded) return fail(t('admin.orders.notice.labelChangedState'));
  if (!landed.orderFulfilled) {
    return fail(t('admin.orders.notice.boxtal.notFulfilled', { suivi: parcel.trackingNumber }));
  }
  return {
    ok: true,
    message: t('admin.orders.notice.boxtal.purchased', { service, suivi: parcel.trackingNumber }),
    fulfilled: true,
  };
}

/** Read the number again for a label bought without one. */
export async function refreshLabelTracking(ctx: LabelContext, order: LabelOrder): Promise<LabelOutcome> {
  const record = await getLabelRecord(ctx.db, order.id);
  if (
    !record ||
    record.vendor !== 'boxtal' ||
    record.status !== 'purchased' ||
    !record.transaction_id ||
    record.tracking_number
  ) {
    return fail(t('admin.orders.notice.boxtal.nothingToRefresh'));
  }
  const outcome = await readLabelTracking(ctx, order, record, [0]);
  return outcome.ok && !outcome.fulfilled ? fail(t('admin.orders.notice.boxtal.trackingNotYet')) : outcome;
}

/** A Boxtal order id as its dashboard shows it (`2610301632POFR56E7FR`). */
export function parseBoxtalId(raw: string): string | null {
  const id = raw.trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

/**
 * Settle an uncertain purchase with the id the merchant found in Boxtal's
 * dashboard. Recorded only if Boxtal knows the order, has not cancelled it,
 * and its parcel carries THIS attempt's reference (`packageExternalId`, read
 * from the tracking: the order itself does not return it).
 */
export async function settleWithBoxtalId(
  ctx: LabelContext,
  order: LabelOrder,
  pasted: string,
): Promise<LabelOutcome> {
  const record = await getLabelRecord(ctx.db, order.id);
  const settleable =
    record?.vendor === 'boxtal' &&
    !!record.claim_token &&
    !!record.rate_id &&
    (record.status === 'uncertain' || (record.status === 'purchasing' && isPurchaseStale(record)));
  if (!record || !settleable) return fail(t('admin.orders.notice.boxtal.nothingToSettle'));
  const id = parseBoxtalId(pasted);
  if (!id) return fail(t('admin.orders.notice.boxtal.badId'));

  const found = await ctx.labels.get(id);
  if (!found.ok) return fail(found.error);
  if (!found.value) return fail(t('admin.orders.notice.boxtal.unknownShipment', { envoi: id }));
  if (found.value.status === 'CANCELLED') {
    return fail(t('admin.orders.notice.boxtal.cancelledShipment', { envoi: id }));
  }
  const tracking = await ctx.labels.tracking(id);
  if (!tracking.ok) return fail(tracking.error);
  if (tracking.value.length === 0) return fail(t('admin.orders.notice.boxtal.notConfirmed', { envoi: id }));
  if (!trackingMatchesReference(tracking.value, record.shipment_id)) {
    return fail(
      t('admin.orders.notice.boxtal.referenceMismatch', {
        envoi: id,
        trouvee: tracking.value[0].reference ?? '—',
        attendue: record.shipment_id,
      }),
    );
  }

  const offer = homeOffer(record.rate_id);
  const settled = {
    transactionId: id,
    provider: offer?.carrier ?? record.rate_id!,
    service: offer?.service ?? '',
    amountCents: found.value.priceExclTaxCents,
  };
  if (!(await recordPurchasedAwaitingTracking(ctx.db, order.id, record.claim_token!, settled))) {
    return fail(t('admin.orders.notice.labelChangedState'));
  }
  return readLabelTracking(
    ctx,
    order,
    { ...record, transaction_id: id, provider: settled.provider, service: settled.service },
    [0],
  );
}

/**
 * The label's signed URL, read again on every download: Boxtal signs a new
 * one at each read, valid 31 days, and the shop never stores it (ADR 0021).
 */
export async function labelDocumentUrl(
  labels: LabelProvider,
  record: Pick<LabelRecord, 'vendor' | 'status' | 'transaction_id'> | null,
): Promise<LabelResult<string>> {
  if (record?.vendor !== 'boxtal' || record.status !== 'purchased' || !record.transaction_id) {
    return { ok: false, error: t('admin.orders.notice.boxtal.noDocument') };
  }
  const documents = await labels.documents(record.transaction_id);
  if (!documents.ok) return { ok: false, error: t('admin.orders.notice.boxtal.documentNotReady', { erreur: documents.error }) };
  const label = documents.value.find((document) => document.type === 'LABEL') ?? documents.value[0];
  let url: URL | null = null;
  try {
    url = label ? new URL(label.url) : null;
  } catch {
    url = null;
  }
  return url?.protocol === 'https:'
    ? { ok: true, value: url.href }
    : { ok: false, error: t('admin.orders.notice.boxtal.documentNotReady', { erreur: t('admin.shipping.boxtal.unexpected') }) };
}
