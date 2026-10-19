import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { applyRefundEvent } from '../../../features/refunds/sync';
import { listUnmatchedRefundEvents, dismissRefundEvent } from '../../../features/refunds/db';
import { sendRefundNotice } from '../../../features/refunds/notify';
import { getOrder } from '../../../features/orders/db';
import { getPaymentProvider, type PaymentMethod } from '../../../features/payments';
import { t } from '../../../features/i18n';

export const prerender = false;

// POST /api/admin/refunds — reconciliation actions for refund events that
// arrived from a provider but could not be matched to an order.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const action = String(form.get('_action'));
  const back = redirect('/admin/orders', 303);
  const fail = (msg: string) => redirect(`/admin/orders?error=${encodeURIComponent(msg)}`, 303);

  // Retry correlation. Safe to run repeatedly: applyRefundEvent is idempotent
  // on the event id, so a retry that now matches applies once and a retry that
  // still doesn't simply stays queued.
  if (action === 'retry_refund_event') {
    const eventId = String(form.get('event_id') ?? '').trim();
    if (!eventId) return fail(t('admin.refunds.event.missing'));

    const events = await listUnmatchedRefundEvents(env.DB);
    const stored = events.find((e) => e.provider_event_id === eventId);
    if (!stored) return fail(t('admin.refunds.event.notWaiting'));

    // Retry runs the same correlation the webhook did, including the provider
    // session lookup — so a merchant clicking Retry after a transient provider
    // failure gets the automatic backfill rather than having to edit the database.
    let findSessionIdForPayment;
    try {
      const provider = await getPaymentProvider(stored.provider as PaymentMethod);
      findSessionIdForPayment = provider.findSessionIdForPayment?.bind(provider);
    } catch {
      // Rail no longer configured — correlate against what's already stored.
    }

    const outcome = await applyRefundEvent(
      env.DB,
      stored.provider,
      {
        eventId: stored.provider_event_id,
        providerPaymentId: stored.provider_payment_id ?? '',
        providerChargeId: stored.provider_charge_id,
        cumulativeRefundedCents: stored.cumulative_refunded_cents,
        currency: stored.currency,
      },
      { findSessionIdForPayment },
    );

    if (outcome.status === 'unmatched') {
      return fail(t('admin.refunds.event.stillUnmatched'));
    }
    // Admin URLs carry the order's public ID, never the row id the correlation
    // worked with internally — one read to translate at the boundary.
    const orderUrl = async (orderId: number) => {
      const order = await getOrder(env.DB, orderId);
      return order?.public_id ? `/admin/orders/${order.public_id}` : '/admin/orders';
    };
    if (outcome.status === 'review') {
      return redirect(await orderUrl(outcome.orderId), 303);
    }
    // A retry that finally applies the refund is the moment the money is first
    // recognised, so this is the path that owes the customer the notice — the
    // original webhook could not send one because it never matched an order.
    if (outcome.status === 'processed') {
      await sendRefundNotice(
        outcome.orderId,
        outcome.deltaCents,
        new URL(request.url).origin,
      );
    }
    return redirect(await orderUrl(outcome.orderId), 303);
  }

  // Close out an event a human has resolved. Retrying a conflicting event only
  // reproduces the conflict, so without this the queue never empties.
  if (action === 'dismiss_refund_event') {
    const eventId = String(form.get('event_id') ?? '').trim();
    if (!eventId) return fail(t('admin.refunds.event.missing'));
    const dismissed = await dismissRefundEvent(
      env.DB,
      eventId,
      String(form.get('_admin') ?? '') || null,
    );
    if (!dismissed) {
      // Two very different reasons for the same empty result: the event was
      // already handled, or it is an uncorrelated refund that must never be
      // dismissed. Saying "no longer waiting" for the second would be a lie —
      // it is still queued, and still needs to be matched to an order.
      const stillQueued = (await listUnmatchedRefundEvents(env.DB)).find(
        (e) => e.provider_event_id === eventId,
      );
      return fail(
        stillQueued
          ? t('admin.refunds.event.cannotDismiss', { bouton: t('admin.orders.list.refunds.retry') })
          : t('admin.refunds.event.notWaiting'),
      );
    }
    return back;
  }

  return back;
};
