import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listOrders, type Order } from '../../../features/orders/db';
import { parseOrderFilters, orderFilterClause } from '../../../features/orders/filter';
import { getConfig, toMajorUnits, currencyDecimals } from '../../../config';
import { orderReference } from '../../../features/orders/number';
import { orderRelayPoint, relayPointLines } from '../../../features/shipping/relay.ts';

export const prerender = false;

// Quote a CSV field only when it contains a comma, quote, or newline.
const esc = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Minor units → major-unit string, scaled by the order's own currency.
const money = (cents: number, currency: string): string =>
  toMajorUnits(cents, currency).toFixed(currencyDecimals(currency));

// The delivery mode, then for a relay order the point's code and its sign.
const deliveryCells = (o: Order): string[] => {
  const point = orderRelayPoint(o);
  return [o.delivery_method ?? '', point?.code ?? '', point ? relayPointLines(point).join(', ') : ''];
};

// GET /admin/orders/export.csv — download all orders as CSV.
export const GET: APIRoute = async ({ url }) => {
  // Parsed with the same helpers the list page uses, so "Export these" returns
  // exactly the rows the merchant was looking at.
  const filter = orderFilterClause(parseOrderFilters(url.searchParams));
  const orders = await listOrders(env.DB, 100_000, 'created_at DESC', 0, filter);
  const onCfg = getConfig().orderNumber;

  const header = [
    'Order', 'Date', 'Email', 'Status', 'Fulfillment',
    'Subtotal', 'Shipping', 'Discount', 'Tax', 'Total', 'Currency',
    // Both refund components, so a bookkeeper can tell money the provider sent
    // back from money the merchant returned by hand. Net is what actually
    // stayed, and is the figure the dashboard's revenue agrees with.
    'Provider refunded', 'Externally refunded', 'Total refunded', 'Net',
    'Refund state', 'Refund review',
    // The French accounting columns (ADR 0010). `VAT included` is a BREAKDOWN of
    // Total, not a component of it — unlike `Tax`, which is added on top by
    // Stripe Tax on a tax-exclusive store. Adding them here rather than in a
    // second, accounting-only export: two exports of the same rows diverge at
    // the first schema change, and the bookkeeper reads whichever is stale.
    'VAT rate', 'VAT included', 'Net of VAT',
    'Terms version', 'Terms accepted at',
    'Carrier', 'Tracking',
    // How the parcel travels, and for a relay order the point the buyer chose:
    // the code the carrier knows it by, then the name and address on its sign.
    'Delivery', 'Relay point code', 'Relay point',
  ];
  const rows = orders.map((o) => [
    orderReference(o.public_id, o.id, onCfg),
    o.created_at,
    o.email ?? '',
    o.status,
    o.fulfillment_status,
    // subtotal = total − shipping − tax + discount
    money(o.amount_total_cents - o.shipping_cents - o.tax_cents + o.discount_cents, o.currency),
    money(o.shipping_cents, o.currency),
    money(o.discount_cents, o.currency),
    money(o.tax_cents, o.currency),
    money(o.amount_total_cents, o.currency),
    o.currency.toUpperCase(),
    money(o.provider_refunded_cents, o.currency),
    money(o.external_refunded_cents, o.currency),
    money(o.refunded_cents, o.currency),
    money(o.amount_total_cents - o.refunded_cents, o.currency),
    o.refunded_cents === 0
      ? 'none'
      : o.refunded_cents >= o.amount_total_cents
        ? 'full'
        : 'partial',
    o.refund_review_reason && !o.refund_reviewed_at ? o.refund_review_reason : '',
    // Empty, not 0: an order placed before a rate was configured did not have a
    // zero rate, it has no recorded split at all.
    o.vat_rate_bps == null ? '' : `${o.vat_rate_bps / 100}`,
    o.vat_amount_cents == null ? '' : money(o.vat_amount_cents, o.currency),
    o.vat_amount_cents == null
      ? ''
      : money(o.amount_total_cents - o.vat_amount_cents, o.currency),
    o.terms_version ?? '',
    o.terms_accepted_at ?? '',
    o.tracking_carrier ?? '',
    o.tracking_number ?? '',
    ...deliveryCells(o),
  ]);

  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="orders.csv"',
    },
  });
};
