import type { APIRoute } from 'astro';
import { getEmailProvider } from '../../../../features/email';
import { getStoreSettings } from '../../../../features/settings/db';
import { env } from 'cloudflare:workers';
import { t } from '../../../../features/i18n';

export const prerender = false;

// POST /api/admin/email/test — send a one-off test email with the CURRENTLY SAVED
// email config (provider + key + from), so the owner can confirm delivery actually
// works (the only way past "binding present ≠ deliverable"). Returns JSON for the
// dashboard's inline button; falls back to a ?msg redirect without JS. The test
// email goes to the operator, not a customer, so it is written like the Admin.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const to = String(form.get('test_to') ?? '').trim();
  const wantsJson = request.headers.get('x-requested-with') === 'fetch';
  const done = (ok: boolean, message: string) =>
    wantsJson
      ? new Response(JSON.stringify({ ok, message }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      : redirect(`/admin/settings?msg=${encodeURIComponent(message)}#email`, 303);

  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return done(false, t('admin.settings.emailTest.invalidRecipient'));
  }
  const provider = await getEmailProvider();
  if (!provider) {
    return done(false, t('admin.settings.emailTest.notConfigured'));
  }
  const storeName =
    (await getStoreSettings(env.DB)).storeName ?? t('admin.settings.emailTest.defaultStore');
  const body = t('admin.settings.emailTest.body', { boutique: storeName });
  try {
    await provider.send({
      to,
      subject: t('admin.settings.emailTest.subject', { boutique: storeName }),
      html: `<p>${body} ✅</p>`,
      text: body,
    });
    return done(true, t('admin.settings.emailTest.sent', { email: to }));
  } catch (err) {
    // The provider's own message (e.g. "Resend send failed (403)") is relayed as
    // is: it is the adapter's error text, written in English like every log line.
    return done(
      false,
      t('admin.settings.emailTest.failed', {
        erreur: (err as Error).message || t('admin.settings.emailTest.unknownError'),
      }),
    );
  }
};
