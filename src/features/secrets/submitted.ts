import type { SecretName } from './store';

/**
 * What a settings form submits for one vault key: `''` keeps the stored key.
 *
 * A browser that remembers the admin login fills the saved password into a key
 * field (`type="password"`), and ignores `autocomplete="off"` there; a password
 * manager may ignore `new-password` too. Saved as is, the admin password
 * replaced the provider key without a word and went to the provider as its
 * bearer token: the staging test e-mail Resend refused at étape 9 (jalon 10).
 * `SecretField` asks the browser not to; this refuses the value when it does
 * anyway. One PBKDF2 per non-blank key, on a save only. The value is compared
 * as filled, before trimming, as the login compares it.
 */
export async function submittedSecret(
  form: FormData,
  name: SecretName,
  isAdminPassword: (typed: string) => Promise<boolean>,
): Promise<{ value: string; autofilled: boolean }> {
  const raw = String(form.get(`secret:${name}`) ?? '');
  const value = raw.trim();
  if (!value) return { value: '', autofilled: false };
  if (await isAdminPassword(raw)) return { value: '', autofilled: true };
  return { value, autofilled: false };
}
