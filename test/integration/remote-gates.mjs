/**
 * The remote gates, held to account on the built Worker.
 *
 * `test/remote/` only ever runs against a deployed shop, which means the
 * first time those scripts meet a Worker is the certification campaign or
 * the first night of the nightly run — the worst moment to discover a check
 * that cannot pass, or one that cannot fail. So `npm run verify` runs each of
 * them here, over a real port, against the same build the in-process gates
 * test:
 *
 *   - security.mjs on a shop still in bootstrap, wizard open: it must go RED.
 *     A remote gate that passes on the one state where anyone can take the
 *     admin is asserting on nothing;
 *   - security.mjs once a password is set (green, password mode), again with
 *     `--limiteurs` (search and checkout answer 429 under a flood, the login
 *     on its exact counter), and on a shop whose admin is behind Access
 *     (green, Access mode);
 *   - on a configured shop — catalogue, e-mail, Stripe in test mode:
 *     last-unit.mjs (one session, four refusals, then a held unit refused
 *     before firing), load.mjs (no error), email.mjs (through the admin
 *     login, to the provider), and stripe-webhook.mjs (a session, its expiry,
 *     a signed `checkout.session.expired` and the unit given back).
 *
 * Stripe and Resend are stand-ins, and only they are: the Worker, its
 * checkout, its vault and its webhook verification are the build's own.
 *
 * Run: node --experimental-strip-types test/integration/remote-gates.mjs
 * (after a build — `npm run verify` builds first.)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { startBuiltWorker } from '../helpers/built-worker.mjs';
import { splitSql } from '../helpers/d1-schema.mjs';
import { LOGIN_ATTEMPT_LIMIT } from '../../src/features/auth/loginThrottle.ts';
import { hashPassword } from '../../src/features/auth/password.ts';
import { encryptSecret } from '../../src/features/secrets/crypto.ts';

const AUTH_SECRET = 'remote-gates-suite-auth-secret';
const SECRETS_KEK = 'remote-gates-suite-key-encryption-key';
const PASSWORD = 'remote gate password';
const WEBHOOK_SECRET = 'whsec_remote_gates_suite';
const RECIPIENT = 'nuit@exemple-pilote.fr';
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'; // secret-scan:ignore — Cloudflare's published always-pass test key

/**
 * One run of a remote script against `url`, captured. Asynchronous on
 * purpose: the stand-ins for Stripe and Resend answer from THIS process, and
 * a synchronous spawn would leave the Worker waiting on a process that is
 * itself waiting on the child.
 */
function run(script, url, args = [], extra = {}) {
  // The Access variables are cleared, not inherited: an operator's shell that
  // carries a real service token must not lend it to a run against localhost.
  const env = { ...process.env, BASE_URL: url, CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '', ...extra };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', `test/remote/${script}`, ...args], { env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ status, output }));
  });
}

const show = (result) => result.output.replace(/^/gm, '    ');

async function seed(db, file) {
  for (const statement of splitSql(readFileSync(file, 'utf8'))) await db.prepare(statement).run();
}

async function setting(db, key, value) {
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
}

/* ------------------------------------------------------ the admin door */

let worker = await startBuiltWorker({ vars: { AUTH_SECRET } });
try {
  const url = String(await worker.mf.ready);

  const bootstrap = await run('security.mjs', url);
  assert.equal(bootstrap.status, 1, `bootstrap shop: the remote gate should fail, it exited ${bootstrap.status}\n${show(bootstrap)}`);
  assert.match(bootstrap.output, /✗ le magicien d'installation est fermé/, show(bootstrap));
  console.log('✓ remote security: red on a shop whose setup wizard is open');

  await setting(worker.db, 'admin_password_hash', await hashPassword(PASSWORD));
  await setting(worker.db, 'setup_complete', '1');
  // A catalogue, so the card check has a cart and a checkout to read.
  await seed(worker.db, 'seed.sql');

  const password = await run('security.mjs', url);
  assert.equal(password.status, 0, `password shop: the remote gate failed\n${show(password)}`);
  assert.match(password.output, /mode password/, show(password));
  assert.match(password.output, /✓ un événement non signé ou mal signé est refusé par le Worker/, show(password));
  assert.match(password.output, /✓ aucun champ de carte/, show(password));
  assert.doesNotMatch(password.output, /limiteurs/, show(password));
  console.log('✓ remote security: green on a password-guarded shop');

  const limiters = await run('security.mjs', url, ['--limiteurs']);
  assert.equal(limiters.status, 0, `password shop, --limiteurs: the remote gate failed\n${show(limiters)}`);
  for (const limiter of ['la recherche', 'le checkout', 'la connexion']) {
    assert.match(limiters.output, new RegExp(`✓ ${limiter} répond 429`), show(limiters));
  }
  // The login check counts from what the run before it spent: one wrong
  // password, so the exact counter must answer at the budget, not after it.
  assert.equal(
    await worker.db.prepare('SELECT MAX(attempts) AS n FROM admin_login_attempts').first('n'),
    LOGIN_ATTEMPT_LIMIT + 1,
    show(limiters),
  );
  console.log('✓ remote security: --limiteurs floods search and checkout to a 429, and the login meets its exact counter');
} finally {
  await worker.dispose();
}

// No outbound service, so the Access certificates cannot be fetched and every
// assertion is refused: exactly what an anonymous request meets in production.
worker = await startBuiltWorker({
  vars: { AUTH_SECRET, CF_ACCESS_TEAM_DOMAIN: 'https://remote-gate.cloudflareaccess.com', CF_ACCESS_AUD: 'remote-gate-aud' },
});
try {
  await setting(worker.db, 'setup_complete', '1');
  await seed(worker.db, 'seed.sql');
  const access = await run('security.mjs', String(await worker.mf.ready));
  assert.equal(access.status, 0, `Access shop: the remote gate failed\n${show(access)}`);
  assert.match(access.output, /mode access/, show(access));
  console.log('✓ remote security: green on an Access-guarded shop');
} finally {
  await worker.dispose();
}

/* ------------------------------------------------- a configured shop */

/** Sessions the Stripe stand-in opened, by id, with the hold they carry. */
const sessions = new Map();
const emails = [];
let workerUrl = null;

/**
 * Stripe's API, for the one call the script makes: expire a session. Like
 * Stripe, it then DELIVERS the event — signed with the endpoint's secret,
 * the way `constructEventAsync` checks it — to the shop's webhook.
 */
const stripeApi = createServer((request, response) => {
  const id = request.url.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/)?.[1];
  if (request.method !== 'POST' || !id || !sessions.has(id) || request.headers.authorization !== 'Bearer rk_test_remote_gates') {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"No such checkout.session"}}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, object: 'checkout.session', status: 'expired' }));
  const payload = JSON.stringify({
    id: 'evt_remote_gates',
    object: 'event',
    type: 'checkout.session.expired',
    data: { object: { id, object: 'checkout.session', metadata: { reservation_id: sessions.get(id) } } },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  fetch(new URL('/api/webhook/stripe', workerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` },
    body: payload,
  }).catch(() => {});
});
await new Promise((resolve) => stripeApi.listen(0, '127.0.0.1', resolve));

worker = await startBuiltWorker({
  vars: { AUTH_SECRET, SECRETS_KEK },
  async outbound(request) {
    const url = new URL(request.url);
    if (url.hostname === 'api.stripe.com' && url.pathname === '/v1/checkout/sessions') {
      const form = new URLSearchParams(await request.text());
      const id = `cs_test_remote${sessions.size}`;
      sessions.set(id, form.get('metadata[reservation_id]'));
      return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}#fid` });
    }
    if (url.hostname === 'api.resend.com') {
      emails.push(await request.json());
      return Response.json({ id: 'remote-gates-email' });
    }
    // Turnstile's siteverify as documented for its test keys: the always-pass
    // secret accepts the dummy token and nothing else.
    if (url.hostname === 'challenges.cloudflare.com' && url.pathname === '/turnstile/v0/siteverify') {
      const form = new URLSearchParams(await request.text());
      const success = form.get('secret') === TURNSTILE_TEST_SECRET && form.get('response') === 'XXXX.DUMMY.TOKEN.XXXX';
      return Response.json({ success });
    }
    return new Response('unexpected outbound call', { status: 502 });
  },
});
try {
  workerUrl = String(await worker.mf.ready);
  const db = worker.db;
  await setting(db, 'admin_password_hash', await hashPassword(PASSWORD));
  await setting(db, 'setup_complete', '1');
  await seed(db, 'seed.sql');
  await seed(db, 'test/fixtures/storefront-states.sql');
  await setting(db, 'enc:resend_api_key', await encryptSecret(SECRETS_KEK, 're_remote_gates_key'));
  await setting(db, 'email_enabled', '1');
  await setting(db, 'email_provider', 'resend');
  await setting(db, 'email_from', 'boutique@exemple-pilote.fr');
  await setting(db, 'enc:stripe_secret_key', await encryptSecret(SECRETS_KEK, 'sk_test_remote_gates'));
  await setting(db, 'enc:stripe_webhook_secret', await encryptSecret(SECRETS_KEK, WEBHOOK_SECRET));
  await db.prepare("UPDATE products SET stock = 1 WHERE slug = 'pagination-item-5'").run();

  const lastUnit = await run('last-unit.mjs', workerUrl, ['--product', 'pagination-item-5']);
  assert.equal(lastUnit.status, 0, `last unit: the scenario failed\n${show(lastUnit)}`);
  assert.match(lastUnit.output, /une seule session, quatre refus/, show(lastUnit));
  const again = await run('last-unit.mjs', workerUrl, ['--product', 'pagination-item-5']);
  assert.equal(again.status, 4, `last unit, second run: should refuse a held unit, exited ${again.status}\n${show(again)}`);
  console.log('✓ last unit: one session out of five, and a held unit refused before firing');

  const load = await run('load.mjs', workerUrl, ['--users', '3', '--minutes', '0.1']);
  assert.equal(load.status, 0, `load: the scenario failed\n${show(load)}`);
  assert.match(load.output, / 0 erreur\(s\)/, show(load));
  console.log('✓ load: three shoppers for six seconds, no error');

  const noPassword = await run('email.mjs', workerUrl, [], { NIGHTLY_EMAIL_TO: RECIPIENT });
  assert.equal(noPassword.status, 2, `e-mail without the admin password: should stop, exited ${noPassword.status}\n${show(noPassword)}`);
  const email = await run('email.mjs', workerUrl, [], { NIGHTLY_EMAIL_TO: RECIPIENT, MINSHOP_ADMIN_PASSWORD: PASSWORD });
  assert.equal(email.status, 0, `e-mail: the check failed\n${show(email)}`);
  assert.equal(emails.length, 1, 'e-mail: the provider was never called');
  assert.deepEqual([emails[0].to].flat(), [RECIPIENT]);
  assert.ok(!email.output.includes(RECIPIENT), `e-mail: the recipient reached the log\n${show(email)}`);
  console.log('✓ e-mail: through the admin login to the provider, recipient kept out of the log');

  // Turnstile on the login, as a staging carries it: Cloudflare's test keys
  // let the check through with their dummy token; a real widget is a human
  // check, and the script says it skipped rather than failing every night.
  await setting(db, 'turnstile_enabled', '1');
  await setting(db, 'turnstile_site_key', '1x00000000000000000000AA');
  await setting(db, 'enc:turnstile_secret_key', await encryptSecret(SECRETS_KEK, TURNSTILE_TEST_SECRET));
  const testKeys = await run('email.mjs', workerUrl, [], { NIGHTLY_EMAIL_TO: RECIPIENT, MINSHOP_ADMIN_PASSWORD: PASSWORD });
  assert.equal(testKeys.status, 0, `e-mail behind Turnstile test keys: the check failed\n${show(testKeys)}`);
  assert.equal(emails.length, 2, 'e-mail behind Turnstile test keys: the provider was never called');
  await setting(db, 'turnstile_site_key', '0x4AAAAAAAremoteGatesReal');
  const realWidget = await run('email.mjs', workerUrl, [], { NIGHTLY_EMAIL_TO: RECIPIENT, MINSHOP_ADMIN_PASSWORD: PASSWORD });
  assert.equal(realWidget.status, 0, `e-mail behind a real Turnstile widget: should skip, exited ${realWidget.status}\n${show(realWidget)}`);
  assert.match(realWidget.output, /::warning::e-mail de test sauté/, show(realWidget));
  assert.equal(emails.length, 2, 'e-mail behind a real Turnstile widget: nothing should have been sent');
  await setting(db, 'turnstile_enabled', '0');
  console.log('✓ e-mail: through Turnstile test keys, and a named skip behind a real widget');

  const stripe = await run('stripe-webhook.mjs', workerUrl, ['--product', 'sample-mug', '--interval', '0.5', '--timeout', '20'], {
    STRIPE_TEST_SECRET_KEY: 'rk_test_remote_gates',
    STRIPE_API_BASE_URL: `http://127.0.0.1:${stripeApi.address().port}`,
  });
  assert.equal(stripe.status, 0, `stripe: the round trip failed\n${show(stripe)}`);
  assert.match(stripe.output, /webhook reçu et vérifié, unité rendue/, show(stripe));
  const live = await run('stripe-webhook.mjs', workerUrl, [], { STRIPE_TEST_SECRET_KEY: 'sk_live_jamais' });
  assert.equal(live.status, 2, `stripe: a live key should be refused, exited ${live.status}\n${show(live)}`);
  console.log('✓ stripe: session, expiry, signed webhook, unit given back — and a live key refused');
} finally {
  await worker.dispose();
  stripeApi.close();
}
