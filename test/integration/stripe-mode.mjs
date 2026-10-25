/**
 * The Stripe mode an environment takes, on the built Worker.
 *
 * Stripe's test mode answers like its live one: a test key opens a session, a
 * test card pays it, and the signed webhook says `paid`. The rehearsal of
 * certification step 10 pasted a test key into a production and got an order,
 * a "Nouvelle commande" e-mail and a held unit for card 4242 4242 4242 4242.
 * `MINSHOP_ENV`, rendered from the manifest, now tells the Worker which
 * environment it is (src/features/payments/stripeMode.ts), and this suite
 * holds the three places that read it to account through the real pipeline:
 * the settings save, the provider factory and the webhook.
 *
 * Run: node --experimental-strip-types test/integration/stripe-mode.mjs
 * (after a build — `npm run verify` builds first.)
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startBuiltWorker } from '../helpers/built-worker.mjs';
import { hashPassword } from '../../src/features/auth/password.ts';
import { encryptSecret } from '../../src/features/secrets/crypto.ts';

const AUTH_SECRET = 'stripe-mode-suite-auth-secret';
const SECRETS_KEK = 'stripe-mode-suite-key-encryption-key';
const PASSWORD = 'stripe mode suite password';
const ORIGIN = 'https://store.test';
const WHSEC = 'whsec_stripe_mode_suite';

async function shop(environment) {
  const worker = await startBuiltWorker({
    vars: { AUTH_SECRET, SECRETS_KEK, ...(environment === null ? {} : { MINSHOP_ENV: environment }) },
  });
  const setting = (key, value) =>
    worker.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
  await setting('admin_password_hash', await hashPassword(PASSWORD));
  await setting('setup_complete', '1');
  const login = await worker.fetch('/admin/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
  });
  assert.equal(login.status, 303, 'the suite could not log in');
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');

  /** Réglages → Paiements → Carte (Stripe) → Enregistrer, as the form posts it
   *  — or, `background`, as the page's script posts it when JavaScript runs. */
  async function saveStripe(fields, { background = false } = {}) {
    const response = await worker.fetch('/admin/settings', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
        ...(background ? { 'x-requested-with': 'fetch' } : {}),
      },
      body: new URLSearchParams({ _action: 'save_stripe', ...fields }).toString(),
    });
    return { status: response.status, refusal: response.headers.get('x-minshop-refusal'), html: await response.text() };
  }
  const stored = async () =>
    (await worker.db.prepare("SELECT key FROM settings WHERE key LIKE 'enc:stripe_%' ORDER BY key").all()).results.map((row) => row.key);
  const settingsPage = async () => (await worker.fetch('/admin/settings', { headers: { cookie } })).text();
  /** A Stripe event, signed as the endpoint signs it. */
  async function deliver(livemode) {
    const payload = JSON.stringify({
      id: `evt_${livemode ? 'live' : 'test'}`,
      object: 'event',
      livemode,
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_mode', object: 'checkout.session', metadata: {} } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', WHSEC).update(`${timestamp}.${payload}`).digest('hex');
    const response = await worker.fetch('/api/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` },
      body: payload,
    });
    return { status: response.status, body: await response.text() };
  }
  return { worker, setting, saveStripe, stored, settingsPage, deliver };
}

/* ------------------------------------------------------------ production */

let s = await shop('production');
try {
  // As `provision` leaves a production nobody has installed: the demo switched
  // off, so with no key the shop takes no order at all. Step 10's banner said
  // the demo took them.
  await s.setting('payment_methods_disabled', 'demo');
  let shell = await s.settingsPage();
  assert.match(shell, /La boutique ne prend aucune commande/);
  assert.doesNotMatch(shell, /Aucun moyen de paiement réel n’est configuré/);
  console.log('✓ production: with the demo off and no key, the admin says the shop takes no order');

  const testKey = await s.saveStripe({ 'secret:stripe_secret_key': 'rk_test_suite', 'secret:stripe_webhook_secret': WHSEC });
  assert.equal(testKey.status, 200, 'a refused key re-renders the page with its reason');
  assert.match(testKey.html, /Clé de test refusée/);
  assert.deepEqual(await s.stored(), [], 'a refused key must store nothing, the webhook secret beside it included');
  console.log('✓ production: a test key is refused at the save, and nothing is stored');

  // With JavaScript the page saves in the background, and a refusal is only
  // shown if it is marked as one: step 10's merchant read « Échec de
  // l'enregistrement — réessayez » for this exact key (test/browser/admin-settings.spec.mjs).
  const inBackground = await s.saveStripe(
    { 'secret:stripe_secret_key': 'rk_test_suite', 'secret:stripe_webhook_secret': WHSEC },
    { background: true },
  );
  assert.equal(inBackground.status, 400);
  assert.equal(inBackground.refusal, '1', 'a background refusal must be marked as one, or the page hides its reason');
  assert.match(inBackground.html, /^Clé de test refusée : cette boutique est la production/);
  assert.deepEqual(await s.stored(), []);
  console.log('✓ production: in the background, the refusal comes back marked, with its reason as the body');

  const publishable = await s.saveStripe({ 'secret:stripe_secret_key': 'pk_live_suite', 'secret:stripe_webhook_secret': WHSEC });
  assert.match(publishable.html, /Ce n’est pas une clé secrète Stripe/);
  const swapped = await s.saveStripe({ 'secret:stripe_secret_key': 'rk_live_suite', 'secret:stripe_webhook_secret': 'rk_live_suite' });
  assert.match(swapped.html, /Ce n’est pas un secret de signature/);
  assert.deepEqual(await s.stored(), []);
  console.log('✓ production: a publishable key, or the key pasted into the webhook field, is refused too');

  const live = await s.saveStripe({ 'secret:stripe_secret_key': 'rk_live_suite', 'secret:stripe_webhook_secret': WHSEC });
  assert.equal(live.status, 303);
  assert.deepEqual(await s.stored(), ['enc:stripe_secret_key', 'enc:stripe_webhook_secret']);
  const page = await s.settingsPage();
  assert.match(page, /data-stripe-mode="live"/);
  assert.match(page, /mode live/);
  assert.ok(!page.includes('rk_live_suite'), 'the settings page must never show the key');
  console.log('✓ production: a live key is stored, and the card says "mode live" without showing it');

  // Open for real orders, with nobody to tell: step 10's order went unannounced.
  assert.doesNotMatch(page, /La boutique ne prend aucune commande/);
  assert.match(page, /Les nouvelles commandes ne préviennent personne/);
  await s.setting('email_notify_to', 'owner@store.test');
  shell = await s.settingsPage();
  assert.doesNotMatch(shell, /Les nouvelles commandes ne préviennent personne/);
  console.log('✓ production: open with no alert recipient, the admin says so until one is set');

  const testEvent = await s.deliver(false);
  assert.equal(testEvent.status, 400, `a test-mode event reached a production: ${testEvent.status} ${testEvent.body}`);
  assert.match(testEvent.body, /Test-mode event refused/);
  const liveEvent = await s.deliver(true);
  assert.equal(liveEvent.status, 200, `a live event was refused: ${liveEvent.status} ${liveEvent.body}`);
  console.log('✓ production: a signed test-mode event is refused, a live one is taken');

  // A key stored before the save refused it: out of service, and said so.
  await s.setting('enc:stripe_secret_key', await encryptSecret(SECRETS_KEK, 'sk_test_before_the_upgrade'));
  assert.match(await s.settingsPage(), /la clé enregistrée est une clé de test, que la production refuse/);
  const legacy = await s.deliver(true);
  assert.equal(legacy.status, 400, 'a production holding a test key must not build a Stripe provider');
  assert.match(legacy.body, /live keys only in production/);
  console.log('✓ production: a test key stored before the upgrade fails closed, and the card says why');

  const cleared = await s.saveStripe({ 'clear:stripe_secret_key': '1', 'clear:stripe_webhook_secret': '1' }, { background: true });
  assert.equal(cleared.status, 204);
  assert.equal(cleared.refusal, null, 'a save that went through is not a refusal');
  assert.deepEqual(await s.stored(), []);
  assert.match(await s.settingsPage(), /La boutique ne prend aucune commande/);
  console.log('✓ production: the keys are removed with "Supprimer", the end of step 10, and the shop says it is closed');
} finally {
  await s.worker.dispose();
}

/* --------------------------------------------------------------- staging */

s = await shop('staging');
try {
  const liveKey = await s.saveStripe({ 'secret:stripe_secret_key': 'sk_live_suite', 'secret:stripe_webhook_secret': WHSEC });
  assert.match(liveKey.html, /Clé live refusée/);
  assert.deepEqual(await s.stored(), []);
  assert.equal((await s.saveStripe({ 'secret:stripe_secret_key': 'rk_test_suite', 'secret:stripe_webhook_secret': WHSEC })).status, 303);
  assert.match(await s.settingsPage(), /data-stripe-mode="test"/);
  assert.equal((await s.deliver(true)).status, 400, 'a live event reached a staging');
  assert.equal((await s.deliver(false)).status, 200);
  console.log('✓ staging: a live key and a live event are refused, test ones taken');
} finally {
  await s.worker.dispose();
}

/* ------------------------------------------- a render that reaches no account */

s = await shop(null);
try {
  assert.equal((await s.saveStripe({ 'secret:stripe_secret_key': 'sk_live_suite', 'secret:stripe_webhook_secret': WHSEC })).status, 303);
  assert.equal((await s.deliver(false)).status, 200);
  assert.equal((await s.deliver(true)).status, 200);
  assert.equal((await s.saveStripe({ 'secret:stripe_secret_key': 'sk_test_suite' })).status, 303);
  console.log('✓ no environment (witness, local): either mode, as before');
} finally {
  await s.worker.dispose();
}
