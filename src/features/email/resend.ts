import type { EmailProvider, EmailMessage } from './provider';

/**
 * Resend adapter — a plain HTTPS call to the Resend API, so it works on the
 * Workers free plan (no `send_email` binding / paid plan needed). Get a free API
 * key at resend.com and paste it in Admin → Réglages → E-mail (stored in the vault).
 */
export function createResendEmail(
  apiKey: string,
  from: { email: string; name: string },
): EmailProvider {
  const fromHeader = from.name ? `${from.name} <${from.email}>` : from.email;
  return {
    async send(msg: EmailMessage): Promise<void> {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          // Resend dedupes on this for 24h — an outbox retry of an
          // already-delivered send becomes a no-op instead of a duplicate.
          ...(msg.idempotencyKey ? { 'idempotency-key': msg.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: fromHeader,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      });
      if (!res.ok) {
        // The status, and only the status. Resend's error body is free text it
        // writes about the message it refused, and it names the recipient in it
        // ("… is not a valid email"). Every consumer of this error logs it, so
        // appending that body put a customer's address in the store's logs on
        // the ordinary path where an address is mistyped. The status is the
        // actionable half: 4xx is this message, 5xx is Resend, and the outbox
        // retries on both. features/observability/logSafe.ts is the second
        // layer for adapters that have not had this read done on them.
        throw new Error(`Resend send failed (${res.status})`);
      }
    },
  };
}
