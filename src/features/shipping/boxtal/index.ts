import type { D1Database } from '@cloudflare/workers-types';
import { getSecret } from '../../secrets/store';
import { getSetting } from '../../settings/db';
import type { LabelProvider, PickupPointProvider, ShippingQuoteProvider } from '../provider.ts';
import { boxtalContent } from './contents.ts';
import { BOXTAL_RELAY_OFFERS, parseRetainedOffers } from './offers.ts';
import type { LabelContext } from './orderLabel.ts';
import { boxtalQuote } from './quote.ts';
import { boxtalLabels, boxtalPickupPoints } from './v3.ts';

export interface BoxtalProviders {
  points: PickupPointProvider;
  labels: LabelProvider;
  /** Null without the v1 application's keys: labels are then bought unpriced. */
  quote: ShippingQuoteProvider | null;
}

/**
 * Boxtal's adapters from the vault (ADR 0020, 0021). Two key pairs, never the
 * account's login: the v3 application's, required, and the v1 application's,
 * optional, for the quote alone. Null when the v3 pair is incomplete.
 *
 * `sandbox` is the caller's to give: Boxtal's sandbox keys only open its
 * sandbox, and live keys only production, so the two must agree.
 */
export async function getBoxtal(db: D1Database, sandbox: boolean): Promise<BoxtalProviders | null> {
  const [accessKey, secretKey, quoteAccessKey, quoteSecretKey] = await Promise.all([
    getSecret(db, 'boxtal_access_key'),
    getSecret(db, 'boxtal_secret_key'),
    getSecret(db, 'boxtal_quote_access_key'),
    getSecret(db, 'boxtal_quote_secret_key'),
  ]);
  if (!accessKey || !secretKey) return null;
  const options = { keys: { accessKey, secretKey }, sandbox };
  return {
    points: boxtalPickupPoints(options),
    labels: boxtalLabels(options),
    quote:
      quoteAccessKey && quoteSecretKey
        ? boxtalQuote({ keys: { accessKey: quoteAccessKey, secretKey: quoteSecretKey }, sandbox })
        : null,
  };
}

/** What checkout needs to offer relay rates (plan §13.3, lot 4). */
export interface RelayPointSearch {
  points: PickupPointProvider;
  /** The relay offers a rate may name, and so the ones checkout can search. */
  offers: string[];
  /** Sandbox and live points are cached apart (features/shipping/relay.ts). */
  sandbox: boolean;
}

/**
 * The point search, or null without the v3 keys. Reads only what the search
 * needs: checkout asks for it on every rate step, and the v1 keys of the
 * quote have nothing to do with a point.
 */
export async function getRelayPointSearch(db: D1Database): Promise<RelayPointSearch | null> {
  const [accessKey, secretKey, environment] = await Promise.all([
    getSecret(db, 'boxtal_access_key'),
    getSecret(db, 'boxtal_secret_key'),
    getSetting(db, 'boxtal_environment'),
  ]);
  if (!accessKey || !secretKey) return null;
  const sandbox = environment !== 'live';
  return {
    points: boxtalPickupPoints({ keys: { accessKey, secretKey }, sandbox }),
    offers: BOXTAL_RELAY_OFFERS.map((offer) => offer.code),
    sandbox,
  };
}

/** What Réglages keeps for Boxtal besides the keys. */
export interface BoxtalSettings {
  /** Sandbox unless the merchant switched to production. */
  sandbox: boolean;
  /** Retained home offers, known codes only. */
  offers: string[];
  /** The nature of contents every parcel declares; null until chosen. */
  contentId: string | null;
}

export async function getBoxtalSettings(db: D1Database): Promise<BoxtalSettings> {
  const [environment, offers, content] = await Promise.all([
    getSetting(db, 'boxtal_environment'),
    getSetting(db, 'boxtal_offers'),
    getSetting(db, 'boxtal_content'),
  ]);
  return {
    sandbox: environment !== 'live',
    offers: parseRetainedOffers(offers),
    contentId: boxtalContent(content)?.id ?? null,
  };
}

/**
 * Everything the order page's label steps need, or null without the v3 keys
 * (the shop then ships by hand, as before: ADR 0020).
 */
export async function getBoxtalLabelContext(
  db: D1Database,
  currency: string,
): Promise<{ settings: BoxtalSettings; ctx: LabelContext } | null> {
  const settings = await getBoxtalSettings(db);
  const boxtal = await getBoxtal(db, settings.sandbox);
  if (!boxtal) return null;
  return {
    settings,
    ctx: {
      db,
      labels: boxtal.labels,
      quote: boxtal.quote,
      offers: settings.offers,
      contentId: settings.contentId,
      currency,
    },
  };
}
