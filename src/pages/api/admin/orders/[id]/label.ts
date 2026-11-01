import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByPublicId } from '../../../../../features/orders/db';
import { getLabelRecord } from '../../../../../features/shipping/labelStore';
import { getBoxtalLabelContext } from '../../../../../features/shipping/boxtal/index.ts';
import { labelDocumentUrl } from '../../../../../features/shipping/boxtal/orderLabel.ts';
import { parseOrderOrLegacyPublicId } from '../../../../../features/ids/publicId';
import { t } from '../../../../../features/i18n';

export const prerender = false;

// GET /api/admin/orders/:id/label — this order's Boxtal label, read again on
// every download: Boxtal signs a new URL at each read, valid 31 days, and the
// shop stores none (ADR 0021). The browser is sent to it, so the PDF — the
// buyer's name, address and phone — never passes through the Worker or R2.
export const GET: APIRoute = async ({ params, redirect }) => {
  const publicId = parseOrderOrLegacyPublicId(params.id, 'order');
  const order = publicId ? await getOrderByPublicId(env.DB, publicId) : null;
  if (!order) return new Response(t('admin.orders.notFound'), { status: 404 });
  const fail = (msg: string) =>
    redirect(`/admin/orders/${publicId}?error=${encodeURIComponent(msg)}`, 303);

  const boxtal = await getBoxtalLabelContext(env.DB, order.currency);
  if (!boxtal) return fail(t('admin.orders.notice.boxtal.noKeys'));
  const url = await labelDocumentUrl(boxtal.ctx.labels, await getLabelRecord(env.DB, order.id));
  if (!url.ok) return fail(url.error);
  // The signed URL opens the label to whoever holds it: never cached, never
  // passed on as a referrer.
  return new Response(null, {
    status: 302,
    headers: { location: url.value, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
};
