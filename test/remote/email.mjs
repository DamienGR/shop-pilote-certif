/**
 * The shop can still send an e-mail (plan §7.3: "e-mail de test").
 *
 * The same button the merchant presses in Admin → Réglages → E-mail: the
 * SAVED configuration — provider, key from the vault, sender — sends one
 * message to an operator's address. A provider key revoked, a sending domain
 * whose DNS lost its records, a vault that no longer decrypts: each of those
 * is silent until the next order confirmation does not arrive, and each of
 * them fails this the next morning instead.
 *
 * It needs the admin, which is the point of the endpoint and the cost of the
 * check. Behind Access-mode admin, the service token is that identity; behind
 * a password, the staging admin password is, and nothing else is accepted.
 *
 * Turnstile on the login page is a human check, and this is not a human. With
 * Cloudflare's TEST keys — the ones a staging behind Access should carry — the
 * widget hands out a documented dummy token that only a test secret accepts,
 * and this sends it. With a real widget the check is SKIPPED, said in a
 * workflow warning, rather than failed every night for doing its job.
 *
 *   BASE_URL                  the shop (staging)
 *   NIGHTLY_EMAIL_TO          the operator address that receives the test
 *   MINSHOP_ADMIN_PASSWORD    the staging admin password (password mode only)
 *   CF_ACCESS_CLIENT_ID / _SECRET behind a private preview
 *
 * The recipient is masked in what this prints: a CI log is read by more
 * people than the inbox is.
 *
 * Run: npm run test:email:remote
 */
import { fetchAs, isAccessChallenge, remoteTarget } from './target.mjs';

const fail = (message, code = 1) => {
  console.error(`e-mail : ${message}`);
  process.exit(code);
};

let target;
try {
  target = remoteTarget();
} catch (error) {
  fail(error.message, 2);
}
const to = process.env.NIGHTLY_EMAIL_TO ?? '';
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) fail('NIGHTLY_EMAIL_TO doit être l\'adresse qui reçoit l\'e-mail de test.', 2);
const mask = (text) => String(text).replaceAll(to, '<destinataire>');

const FORM = 'application/x-www-form-urlencoded';

/** Cloudflare's test sitekeys (always pass, always fail, forced challenge),
 *  and the token they all hand out. A production secret rejects that token,
 *  so sending it opens nothing on a shop with a real widget. */
const TEST_SITEKEY = /^[123]x0{20}[A-F]{2}$/;
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** The Turnstile field the login form needs, or null when it has no widget. */
async function turnstileField() {
  const page = await fetchAs(target, '/admin/login');
  const siteKey = (await page.text()).match(/class="cf-turnstile"[^>]*data-sitekey="([^"]+)"/)?.[1] ?? null;
  if (!siteKey) return null;
  if (TEST_SITEKEY.test(siteKey)) return { 'cf-turnstile-response': DUMMY_TOKEN };
  console.log(
    '::warning::e-mail de test sauté : Turnstile garde la connexion de l\'admin avec un widget réel. Posez les clés de test de Cloudflare dans les réglages de staging (Admin → Réglages → Protection anti-robots) pour que ce contrôle tourne.',
  );
  process.exit(0);
}

async function sendTest(cookie = null) {
  const response = await fetchAs(target, '/api/admin/email/test', {
    method: 'POST',
    headers: {
      origin: target.origin,
      'content-type': FORM,
      'x-requested-with': 'fetch',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ test_to: to }).toString(),
  });
  if (isAccessChallenge(response)) fail('Cloudflare Access répond à la place du Worker : posez CF_ACCESS_CLIENT_ID et CF_ACCESS_CLIENT_SECRET.', 2);
  return response;
}

let response = await sendTest();
if (response.status === 401 || response.status === 403) {
  const password = process.env.MINSHOP_ADMIN_PASSWORD ?? '';
  if (!password) {
    fail(`l'admin a répondu ${response.status} : en mode mot de passe, posez MINSHOP_ADMIN_PASSWORD (secret de l'environnement staging).`, 2);
  }
  const turnstile = await turnstileField();
  const login = await fetchAs(target, '/admin/login', {
    method: 'POST',
    headers: { origin: target.origin, 'content-type': FORM },
    body: new URLSearchParams({ password, ...turnstile }).toString(),
  });
  const session = login.headers.getSetCookie().find((line) => line.startsWith('admin_session='));
  if (login.status !== 303 || !session) {
    fail(`la connexion à l'admin a répondu ${login.status} : mot de passe refusé, ou Turnstile actif sur la page de connexion.`);
  }
  response = await sendTest(session.split(';')[0]);
}

const body = await response.json().catch(() => null);
if (response.status !== 200 || !body) fail(`l'envoi de test a répondu ${response.status}.`);
if (!body.ok) fail(`le fournisseur a refusé : ${mask(body.message)}`);
console.log(`✓ ${mask(body.message)}`);
