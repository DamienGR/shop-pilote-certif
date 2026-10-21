import { describe, expect, it, vi } from 'vitest';
import { submittedSecret } from './submitted';

const formWith = (entries: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return form;
};

const ADMIN_PASSWORD = 'correct horse battery staple';
const isAdminPassword = async (typed: string) => typed === ADMIN_PASSWORD;

describe('submittedSecret', () => {
  it('keeps the stored key when the field is blank, without hashing anything', async () => {
    const verify = vi.fn(isAdminPassword);
    const submitted = await submittedSecret(formWith({ 'secret:resend_api_key': '  ' }), 'resend_api_key', verify);
    expect(submitted).toEqual({ value: '', autofilled: false });
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns a typed provider key, trimmed', async () => {
    const submitted = await submittedSecret(
      formWith({ 'secret:resend_api_key': ' re_live_key ' }),
      'resend_api_key',
      isAdminPassword,
    );
    expect(submitted).toEqual({ value: 're_live_key', autofilled: false });
  });

  it('refuses the admin password a browser filled into the key field', async () => {
    const submitted = await submittedSecret(
      formWith({ 'secret:stripe_secret_key': ADMIN_PASSWORD }),
      'stripe_secret_key',
      isAdminPassword,
    );
    expect(submitted).toEqual({ value: '', autofilled: true });
  });

  it('compares the value as filled, before trimming, as the login does', async () => {
    const spaced = ` ${ADMIN_PASSWORD} `;
    const verify = vi.fn(async (typed: string) => typed === spaced);
    const submitted = await submittedSecret(formWith({ 'secret:turnstile_secret_key': spaced }), 'turnstile_secret_key', verify);
    expect(submitted).toEqual({ value: '', autofilled: true });
    expect(verify).toHaveBeenCalledWith(spaced);
  });

  it('reads only its own field', async () => {
    const submitted = await submittedSecret(
      formWith({ 'secret:resend_api_key': ADMIN_PASSWORD }),
      'turnstile_secret_key',
      isAdminPassword,
    );
    expect(submitted).toEqual({ value: '', autofilled: false });
  });
});
