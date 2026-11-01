/**
 * The Boxtal quote, from its v1 API (ADR 0021): v3 has none yet, and Boxtal
 * points to the v1 "in the meantime". Deprecated but maintained, XML, its own
 * host, and its own keys — those of a v1 application, never the v3 ones.
 *
 * Optional by design: no v1 keys, or a quote that fails, leaves the merchant
 * buying an unpriced label, and the price arrives with the v3 order. The day
 * Boxtal retires the v1 or quotes in v3, only this module changes.
 *
 * What the recorded answers (test/fixtures/boxtal/, `30` to `42`) established:
 * - a v3 offer code is `<operator>-<service>` from the quote, and the v3
 *   purchase charges the quote's tax-exclusive price to the cent;
 * - the v1 filter wants the two codes glued, `offers[0]=MONRCpourToi`, and
 *   IGNORES a code it does not know without an error, answering every carrier
 *   (`35`). So only requested offers are kept, whatever comes back;
 * - an impossible parcel is a 200 with no offer (`38`), not an error.
 *
 * No DOM in a Worker: the answer is read with a few anchored patterns over
 * Boxtal's flat XML, enough for the fields used here.
 */

import { t } from '../../i18n/index.ts';
import { toMinorUnits } from '../../../money.ts';
import type { LabelResult, OfferQuote, QuoteRequest, QuoteResult, ShippingQuoteProvider } from '../provider.ts';
import type { BoxtalKeys } from './v3.ts';

export const BOXTAL_V1_BASE = {
  sandbox: 'https://test.envoimoinscher.com/api/v1',
  live: 'https://www.envoimoinscher.com/api/v1',
} as const;

export interface BoxtalQuoteOptions {
  /** The keys of a v1 application. */
  keys: BoxtalKeys;
  sandbox: boolean;
  fetch?: typeof fetch;
}

/** `MONR-CpourToi` → `MONRCpourToi`, the v1 filter's spelling. */
export function v1FilterCode(offerCode: string): string {
  return offerCode.replace('-', '');
}

/** Kilograms as Boxtal reads them: up to three decimals, no exponent. */
function kilograms(grams: number): string {
  return String(Math.round(grams) / 1000);
}

const partyType = (kind: 'business' | 'residential') => (kind === 'business' ? 'entreprise' : 'particulier');

/** The `/cotation` path and query. Pure, so tests pin it against `32`. */
export function buildQuotePath(request: QuoteRequest): string {
  const params = new URLSearchParams();
  params.set('colis_1.poids', kilograms(request.parcel.weightGrams));
  params.set('colis_1.longueur', String(Math.ceil(request.parcel.lengthCm)));
  params.set('colis_1.largeur', String(Math.ceil(request.parcel.widthCm)));
  params.set('colis_1.hauteur', String(Math.ceil(request.parcel.heightCm)));
  params.set('code_contenu', request.contentCode);
  params.set('expediteur.pays', request.from.country.toUpperCase());
  params.set('expediteur.code_postal', request.from.postalCode);
  params.set('expediteur.ville', request.from.city);
  params.set('expediteur.type', partyType(request.from.kind));
  params.set('destinataire.pays', request.to.country.toUpperCase());
  params.set('destinataire.code_postal', request.to.postalCode);
  params.set('destinataire.ville', request.to.city);
  params.set('destinataire.type', partyType(request.to.kind));
  request.offerCodes.forEach((code, i) => params.set(`offers[${i}]`, v1FilterCode(code)));
  return `/cotation?${params}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text → string. Single pass: `&amp;apos;` stays `&apos;`, as Boxtal sent it. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The text of the first `<a><b>…</b></a>` path inside `xml`, or null. */
function text(xml: string, ...path: string[]): string | null {
  let scope = xml;
  for (const tag of path) {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(scope);
    if (!match) return null;
    scope = match[1];
  }
  return decode(scope);
}

/**
 * Offers of a quote answer, keyed by their v3 code. Every offer is returned;
 * `quoteResult` keeps the requested ones. Pure.
 */
export function parseQuoteOffers(xml: string): OfferQuote[] {
  const offers: OfferQuote[] = [];
  for (const match of xml.matchAll(/<offer>([\s\S]*?)<\/offer>/g)) {
    const offer = match[1];
    const operator = text(offer, 'operator', 'code');
    const service = text(offer, 'service', 'code');
    const currency = text(offer, 'price', 'currency');
    const exclusive = Number(text(offer, 'price', 'tax-exclusive'));
    const inclusive = Number(text(offer, 'price', 'tax-inclusive'));
    if (!operator || !service || !currency || !Number.isFinite(exclusive) || !Number.isFinite(inclusive)) {
      continue;
    }
    offers.push({
      offerCode: `${operator}-${service}`,
      carrier: text(offer, 'operator', 'label') ?? operator,
      service: text(offer, 'service', 'label') ?? service,
      priceExclTaxCents: toMinorUnits(exclusive, currency),
      priceInclTaxCents: toMinorUnits(inclusive, currency),
      currency: currency.toUpperCase(),
      collection: text(offer, 'collection', 'type', 'code'),
      delivery: text(offer, 'delivery', 'type', 'code'),
    });
  }
  return offers;
}

/** Keep what was asked for, cheapest first, and name what was not priced. Pure. */
export function quoteResult(offers: readonly OfferQuote[], requested: readonly string[]): QuoteResult {
  const wanted = new Set(requested);
  const priced = offers
    .filter((offer) => wanted.has(offer.offerCode))
    .sort((a, b) => a.priceExclTaxCents - b.priceExclTaxCents);
  const found = new Set(priced.map((offer) => offer.offerCode));
  return { offers: priced, unavailable: requested.filter((code) => !found.has(code)) };
}

/** The quote port, on Boxtal's v1 `/cotation`. */
export function boxtalQuote(options: BoxtalQuoteOptions): ShippingQuoteProvider {
  return {
    async quote(request: QuoteRequest): Promise<LabelResult<QuoteResult>> {
      // Unfiltered, the v1 answers every carrier in seconds; never ask for that.
      if (request.offerCodes.length === 0) return { ok: true, value: { offers: [], unavailable: [] } };
      const base = options.sandbox ? BOXTAL_V1_BASE.sandbox : BOXTAL_V1_BASE.live;
      const credentials = btoa(`${options.keys.accessKey}:${options.keys.secretKey}`);
      let res: Response;
      try {
        res = await (options.fetch ?? fetch)(`${base}${buildQuotePath(request)}`, {
          headers: { authorization: `Basic ${credentials}`, accept: 'application/xml' },
        });
      } catch {
        return { ok: false, error: t('admin.shipping.boxtal.quoteUnreachable') };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: t('admin.shipping.boxtal.quoteKeysRejected') };
      }
      let xml: string;
      try {
        xml = await res.text();
      } catch {
        return { ok: false, error: t('admin.shipping.boxtal.quoteAnswered', { statut: res.status }) };
      }
      if (!res.ok) {
        // `<error><code>bad_request</code>…`: the code, never Boxtal's prose.
        const code = text(xml, 'error', 'code');
        return {
          ok: false,
          error: code
            ? t('admin.shipping.boxtal.quoteRefused', { statut: res.status, code })
            : t('admin.shipping.boxtal.quoteAnswered', { statut: res.status }),
        };
      }
      if (!xml.includes('<cotation>')) {
        return { ok: false, error: t('admin.shipping.boxtal.quoteUnexpected') };
      }
      return { ok: true, value: quoteResult(parseQuoteOffers(xml), request.offerCodes) };
    },
  };
}
