/**
 * Jalon 8 — the admin door, and what leaves the Worker.
 *
 * Everything asserted here is a property of the deployed pipeline rather than
 * of a function, so everything here talks to the BUILT Worker
 * (test/helpers/built-worker.mjs). The unit suites beside the code already
 * prove the pieces: accessGate.test.ts knows when Access must fail closed,
 * session.test.ts an expired token from a forged one, formOrigin.test.ts a
 * cross-site post, sniff.test.ts an SVG wearing a PNG's name. What none of them
 * can answer is whether the middleware actually asks them, on the routes that
 * exist, in the order that matters — which is the only order an attacker cares
 * about.
 *
 * Two of the sections could not be written against a port at all, and are the
 * reason this gate runs in-process. The log assertions read what the Worker
 * printed; the provider failures that produce those lines are arranged by
 * standing in for the provider. Both are Miniflare options, and neither
 * survives a dev proxy in between.
 *
 * Run: node --experimental-strip-types test/integration/security.mjs
 * (after `npm run build` — `npm run verify` and `npm run test:d1` both build.)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminRoutes } from '../helpers/admin-routes.mjs';
import { startBuiltWorker } from '../helpers/built-worker.mjs';
import { LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_SECONDS } from '../../src/features/auth/loginThrottle.ts';
import { hashPassword } from '../../src/features/auth/password.ts';
import { signSession } from '../../src/features/auth/session.ts';
import { generateAccessToken } from '../../src/features/ids/token.ts';
import { generatePublicId } from '../../src/features/ids/publicId.ts';
import { encryptSecret } from '../../src/features/secrets/crypto.ts';
import { REAL_IMAGES, PNG_1X1, SVG_WITH_SCRIPT, HTML_PAGE } from '../helpers/image-bytes.mjs';

const ORIGIN = 'https://store.test';
const PASSWORD = 'correct horse battery staple';
const AUTH_SECRET = 'security-suite-auth-secret';
// Any string works as a KEK (it is SHA-256'd into the AES key), so this one is
// written as words: a base64 blob here would read as a real credential to the
// secret scanner, and to anyone reviewing the diff.
const SECRETS_KEK = 'security-suite-key-encryption-key';
const FORM = 'application/x-www-form-urlencoded';
/** A second store on the same Worker — see the Turnstile section. */
const TURNSTILE_ORIGIN = 'https://turnstile.test';

/**
 * The customer this suite invents, and then goes looking for in the logs.
 * Distinctive on purpose: a hit is a leak, never a coincidence.
 */
const CUSTOMER = {
  email: 'claire.dubois-7f3a@exemple-pilote.fr',
  name: 'Claire Dubois',
  street: '14 rue des Tanneurs-Verts',
  city: 'Nantes',
  postalCode: '44000',
};

/** Every provider call the Worker made, so the log section cannot pass vacuously. */
const outboundCalls = [];

/** What the Turnstile stub answers next. Flipped by the section that uses it. */
let turnstileVerdict = false;

let checks = 0;
const section = (title) => console.log(`\n▸ ${title}`);
const ok = (message) => {
  checks++;
  console.log(`  ✓ ${message}`);
};

/* --------------------------------------------------------------- fixtures */

/** A settled order with a digital item, addressed only by its access token. */
async function seedDigitalOrder(db, { refunded = 0 } = {}) {
  const orderPublicId = generatePublicId('order');
  const itemPublicId = generatePublicId('orderItem');
  const token = generateAccessToken();
  // ship_address is the JSON snapshot the checkout stores (migration 0012) —
  // the same shape a real order carries, so the log assertions later have a
  // real address to go looking for.
  await db
    .prepare(
      `INSERT INTO orders (public_id, email, amount_total_cents, currency, status,
                           provider_refunded_cents, ship_address)
       VALUES (?, ?, 5000, 'eur', 'paid', ?, ?)`,
    )
    .bind(
      orderPublicId,
      CUSTOMER.email,
      refunded,
      JSON.stringify({
        name: CUSTOMER.name,
        line1: CUSTOMER.street,
        city: CUSTOMER.city,
        postal_code: CUSTOMER.postalCode,
        country: 'FR',
      }),
    )
    .run();
  const { id } = await db
    .prepare('SELECT id FROM orders WHERE public_id = ?')
    .bind(orderPublicId)
    .first();
  await db
    .prepare(
      `INSERT INTO order_items (order_id, name, price_cents, quantity, public_id,
                                file_key, file_name, file_mime)
       VALUES (?, 'Guide du pilote', 5000, 1, ?, 'files/guide.pdf', 'guide.pdf', 'application/pdf')`,
    )
    .bind(id, itemPublicId)
    .run();
  await db
    .prepare(
      'INSERT INTO order_guest_access (order_public_id, access_token) VALUES (?, ?)',
    )
    .bind(orderPublicId, token)
    .run();
  return { orderPublicId, itemPublicId, token, id };
}

/**
 * A multipart body carrying one file, byte for byte, with a declared type.
 *
 * Encoded here rather than handed to the fetch as a FormData: the boundary
 * lives in the Content-Type header, and only the runtime that serializes the
 * body knows it. Serializing through a Request and reading both back keeps the
 * two halves together.
 */
async function multipart(files) {
  const form = new FormData();
  for (const { bytes, type, name = 'upload.bin', field = 'files' } of files) {
    form.append(field, new File([bytes], name, { type }));
  }
  const encoded = new Request('https://encode.invalid/', { method: 'POST', body: form });
  return {
    contentType: encoded.headers.get('content-type'),
    body: await encoded.arrayBuffer(),
  };
}

/* ------------------------------------------------------------------- main */

const worker = await startBuiltWorker({
  vars: {
    AUTH_SECRET,
    // A store on its own domain, so the cookie's Secure attribute is decided by
    // the request rather than by the harness.
    CANONICAL_ORIGIN: ORIGIN,
    // The vault's key-encryption key. Without it the vault is dormant, no
    // e-mail provider resolves, and the log section below would prove nothing.
    SECRETS_KEK,
  },
  /**
   * Every host the Worker calls. Resend answers the way a provider answers when
   * an address is refused: by quoting the address back, alongside the order's
   * guest link. That body is the shape the log assertions exist to keep out of
   * the logs, and no unit test can produce it — the adapter has to be the one
   * that receives it.
   */
  outbound: async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'challenges.cloudflare.com') {
      outboundCalls.push(url.href);
      return new Response(JSON.stringify({ success: turnstileVerdict }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.hostname === 'api.resend.com') {
      outboundCalls.push(url.href);
      return new Response(
        JSON.stringify({
          statusCode: 422,
          name: 'validation_error',
          message:
            `Invalid \`to\` field: ${CUSTOMER.email} is not a valid recipient ` +
            `(order link https://store.test/order/${'otk_' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7A'}, ` +
            `ship to ${CUSTOMER.name}, ${CUSTOMER.street}, ${CUSTOMER.postalCode} ${CUSTOMER.city})`,
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('unexpected outbound call', { status: 502 });
  },
});

try {
  const { db, fetch } = worker;

  /* ==================================================== 1. the admin door */

  section('La porte d\'administration — anonyme');

  // Before a password exists the store is in bootstrap: the wizard is open so
  // the operator can close it. Everything else under /admin still bounces.
  {
    const setup = await fetch('/admin/setup');
    assert.equal(setup.status, 200, 'the setup wizard is reachable during bootstrap');
    const admin = await fetch('/admin');
    assert.equal(admin.status, 303);
    assert.equal(new URL(admin.headers.get('location'), ORIGIN).pathname, '/admin/setup');
    const api = await fetch('/api/admin/products');
    assert.equal(api.status, 401, 'the admin API is closed even during bootstrap');
    ok('bootstrap opens the wizard and nothing else');
  }

  // Close it, the way the wizard does.
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?)")
    .bind(await hashPassword(PASSWORD))
    .run();
  await db.prepare("INSERT INTO settings (key, value) VALUES ('setup_complete', '1')").run();

  {
    const routes = adminRoutes();
    assert.ok(routes.length >= 30, `derived ${routes.length} admin routes`);
    const open = [];
    for (const route of routes) {
      for (const verb of route.verbs) {
        const response = await fetch(route.path, {
          method: verb,
          headers: verb === 'GET' ? {} : { origin: ORIGIN, 'content-type': FORM },
          ...(verb === 'GET' ? {} : { body: '' }),
        });
        // /admin/login is the one page that must answer anonymously — it is
        // where the answer to every other redirect points.
        const expected =
          route.path === '/admin/login'
            ? [200, 403]
            : route.path.startsWith('/api/')
              ? [401]
              : [303];
        if (!expected.includes(response.status)) {
          open.push(`${verb} ${route.path} → ${response.status} (${route.file})`);
        }
        if (response.status === 303) {
          const to = new URL(response.headers.get('location'), ORIGIN).pathname;
          if (to !== '/admin/login') open.push(`${verb} ${route.path} → redirects to ${to}`);
        }
      }
    }
    assert.deepEqual(open, [], 'every admin route refuses an anonymous caller');
    ok(`${routes.length} admin routes, every one closed to an anonymous caller`);
  }

  {
    // The wizard closes behind the password: a second visitor cannot re-run it
    // and set a password of their own.
    const setup = await fetch('/admin/setup');
    assert.equal(setup.status, 303);
    assert.equal(new URL(setup.headers.get('location'), ORIGIN).pathname, '/admin/login');
    ok('the setup wizard closes once a password exists');
  }

  {
    // A bare Access assertion is forgeable against the public origin. With no
    // Access configuration to verify it against, presenting one must gain
    // nothing — not even a different answer.
    const forged = await fetch('/admin', {
      // secret-scan:ignore — a forged assertion has to be JWT-shaped to be forged.
      headers: { 'cf-access-jwt-assertion': 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jbyJ9.x' },
    });
    assert.equal(forged.status, 303);
    assert.equal(new URL(forged.headers.get('location'), ORIGIN).pathname, '/admin/login');
    ok('a forged Access assertion does not bypass the password gate');
  }

  {
    // The admin API never says more to an anonymous caller than that it is shut.
    const response = await fetch('/api/admin/orders/ord_0000000000', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ fulfillment_status: 'fulfilled' }),
    });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.ok(!/ord_|sqlite|D1_ERROR|stack/i.test(body), `401 body leaked: ${body}`);
    ok('an anonymous admin API call is refused without describing the store');
  }

  /* ======================================================== 2. CSRF */

  section('Origine des formulaires (CSRF)');
  {
    const targets = ['/admin/login', '/account/login', '/api/cart', '/cart'];
    for (const path of targets) {
      const foreign = await fetch(path, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': FORM },
        body: 'password=x',
      });
      assert.equal(foreign.status, 403, `${path} accepted a cross-site form post`);
      const absent = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: 'password=x',
      });
      assert.equal(absent.status, 403, `${path} accepted a form post with no Origin`);
    }
    ok(`${targets.length} form endpoints refuse a cross-site post and a post with no Origin`);

    // The rule is about form-shaped posts specifically: those are what a page on
    // another origin can send without a preflight. A same-origin post is not
    // touched by it.
    const same = await fetch('/admin/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: 'password=wrong',
    });
    assert.equal(same.status, 200, 'a same-origin login post reaches the form');
    ok('a same-origin form post is not refused by the origin gate');
  }

  /* =============================================== 3. sessions */

  section('Sessions — expiration, falsification, rotation');
  {
    const login = await fetch('/admin/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
    });
    assert.equal(login.status, 303);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/, 'the session cookie is HttpOnly');
    assert.match(setCookie, /SameSite=Lax/, 'the session cookie is SameSite=Lax');
    assert.match(setCookie, /Secure/, 'the session cookie is Secure over https');
    assert.match(setCookie, /Path=\//);
    const cookie = setCookie.split(';')[0];
    ok('a correct password issues an HttpOnly, SameSite, Secure session');

    const authed = await fetch('/admin', { headers: { cookie } });
    assert.equal(authed.status, 200, 'the session opens the admin');
    ok('the session opens the admin');

    const hash = (await db
      .prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'")
      .first()).value;
    const now = Date.now() / 1000;

    const cases = [
      ['an expired session', await signSession(AUTH_SECRET, hash, -60, now)],
      ['a session signed with another key', await signSession('another-secret', hash, 3600, now)],
      ['a session bound to another credential', await signSession(AUTH_SECRET, 'other', 3600, now)],
      ['a session with a tampered expiry', (await signSession(AUTH_SECRET, hash, 60, now)).replace(
        /^v1\.(\d+)\./,
        (_, exp) => `v1.${Number(exp) + 86400}.`,
      )],
      ['a truncated session', (await signSession(AUTH_SECRET, hash, 3600, now)).slice(0, -4)],
      ['no session at all', ''],
    ];
    for (const [name, token] of cases) {
      const response = await fetch('/admin', { headers: { cookie: `admin_session=${token}` } });
      assert.equal(response.status, 303, `${name} was accepted`);
      assert.equal(
        new URL(response.headers.get('location'), ORIGIN).pathname,
        '/admin/login',
        `${name} was accepted`,
      );
      const api = await fetch('/api/admin/media', { headers: { cookie: `admin_session=${token}` } });
      assert.equal(api.status, 401, `${name} was accepted by the API`);
    }
    ok(`${cases.length} invalid sessions refused by both the admin and its API`);

    // Rotating the password must end every session already issued — that is
    // what makes "change the password" a usable answer to a stolen laptop.
    await db
      .prepare("UPDATE settings SET value = ? WHERE key = 'admin_password_hash'")
      .bind(await hashPassword('a different password'))
      .run();
    const afterRotation = await fetch('/admin', { headers: { cookie } });
    assert.equal(afterRotation.status, 303, 'a session survived a password rotation');
    await db
      .prepare("UPDATE settings SET value = ? WHERE key = 'admin_password_hash'")
      .bind(hash)
      .run();
    ok('rotating the password invalidates the sessions issued before it');
  }

  /* =========================================== 4. Turnstile */

  section('Turnstile — le défi anti-robot du formulaire');
  {
    // A second hostname, and that is itself an assertion: the limiter key is
    // scoped per store (host + route + client), so a Turnstile login here
    // cannot spend the budget the brute-force section below measures. Two
    // stores in one Cloudflare account share the namespace ids and must not
    // share the counter.
    const at = (path, init) => fetch(`${TURNSTILE_ORIGIN}${path}`, init);
    const login = (password, token) =>
      at('/admin/login', {
        method: 'POST',
        headers: { origin: TURNSTILE_ORIGIN, 'content-type': FORM },
        body: new URLSearchParams({
          password,
          ...(token === undefined ? {} : { 'cf-turnstile-response': token }),
        }).toString(),
      });

    // Off: the store works without it, which is what a fresh clone needs.
    assert.equal((await login(PASSWORD)).status, 303, 'login is broken with Turnstile off');

    // On, with its secret in the vault.
    await db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('turnstile_enabled', '1')")
      .run();
    await db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enc:turnstile_secret_key', ?)")
      .bind(await encryptSecret(SECRETS_KEK, 'turnstile-suite-secret'))
      .run();

    turnstileVerdict = false;
    const noToken = await login(PASSWORD);
    assert.equal(noToken.status, 200, 'the right password logged in with no challenge answered');
    assert.equal(noToken.headers.get('set-cookie'), null, 'a session was issued without the challenge');
    const refused = await login(PASSWORD, 'a-token-siteverify-rejects');
    assert.equal(refused.headers.get('set-cookie'), null, 'a rejected challenge issued a session');
    ok('with Turnstile on, the right password alone opens nothing');

    turnstileVerdict = true;
    const accepted = await login(PASSWORD, 'a-token-siteverify-accepts');
    assert.equal(accepted.status, 303, 'a passed challenge did not log in');
    assert.match(accepted.headers.get('set-cookie'), /admin_session=/);
    ok('a passed challenge and the right password log in');

    // The one that matters most: a challenge that is ON and cannot be verified
    // must refuse, never wave through. Take the secret away and answer.
    await db.prepare("DELETE FROM settings WHERE key = 'enc:turnstile_secret_key'").run();
    const misconfigured = await login(PASSWORD, 'a-token-siteverify-accepts');
    assert.equal(
      misconfigured.headers.get('set-cookie'),
      null,
      'Turnstile without its secret waved the login through',
    );
    ok('Turnstile without its secret fails closed rather than open');

    await db.prepare("DELETE FROM settings WHERE key = 'turnstile_enabled'").run();
    // And the budget on the real store is untouched by everything above.
    const elsewhere = await fetch('/admin/login');
    assert.equal(elsewhere.status, 200, 'the other store was throttled by this one');
    ok('the limiter is scoped per store: one store cannot spend another\'s budget');
  }

  /* =============================================== 4. brute force */

  section('Force brute');
  {
    // The exact counter (features/auth/loginThrottle.ts) on the real
    // migrations. Each client below is its own address, so the edge limiter —
    // ten a minute per address, and permissive on the platform — never answers
    // first: every 429 here is the counter's, which says so with a Retry-After
    // longer than the edge limiter's minute. Deliberately last among the login
    // assertions: a refused client stays refused for the rest of its window.
    const guess = (ip, password) =>
      fetch('/admin/login', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': FORM, 'cf-connecting-ip': ip },
        body: new URLSearchParams({ password }).toString(),
      });
    const counted = (response, what) => {
      assert.equal(response.status, 429, what);
      const retryAfter = Number(response.headers.get('retry-after'));
      assert.ok(retryAfter > 60 && retryAfter <= LOGIN_WINDOW_SECONDS, `${what}: Retry-After ${retryAfter}`);
      // The route says `no-store`; the cache allowlist tightens it to
      // `private, no-store` on the way out. Either way it is never shared.
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('set-cookie'), null, `${what}: a session was issued`);
      return retryAfter;
    };

    // Exact under concurrency: the attempt is counted before the slow password
    // compare, in one statement, so a burst cannot slip between read and write.
    const burst = await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT + 2 }, (_, index) => guess('198.51.100.20', `guess-${index}`)),
    );
    const answered = burst.filter((response) => response.status === 200).length;
    const refused = burst.filter((response) => response.status === 429);
    assert.equal(answered, LOGIN_ATTEMPT_LIMIT, `${answered} of ${burst.length} parallel guesses were answered`);
    assert.equal(refused.length, 2);
    const retryAfter = counted(refused[0], 'a guess past the budget');
    ok(`${burst.length} parallel guesses: exactly ${LOGIN_ATTEMPT_LIMIT} answered, the rest refused for ${retryAfter} s`);

    // And the refusal is not a wrong-password message in disguise: the CORRECT
    // password is refused too, so a counter that fired cannot be walked past by
    // the guess that happens to be right.
    counted(await guess('198.51.100.20', PASSWORD), 'the right password, past the budget');
    ok('a throttled login refuses even the right password, and issues no session');

    // An IPv6 subscriber holds a /64: walking it buys no new budget.
    for (let index = 0; index < LOGIN_ATTEMPT_LIMIT; index++) {
      assert.equal((await guess(`2001:db8:5:6::${index + 1}`, `guess-${index}`)).status, 200);
    }
    counted(await guess('2001:db8:5:6:ffff::1', 'guess-next'), 'another address of the same /64');
    assert.equal((await guess('198.51.100.21', 'guess-elsewhere')).status, 200, 'a third client was refused');
    ok('the budget is per client network: a /64 shares one, another client keeps its own');

    // A successful login starts the client again from nothing.
    for (let index = 0; index < LOGIN_ATTEMPT_LIMIT - 1; index++) {
      assert.equal((await guess('198.51.100.22', `guess-${index}`)).status, 200);
    }
    assert.equal((await guess('198.51.100.22', PASSWORD)).status, 303, 'the last attempt of the budget did not log in');
    assert.equal((await guess('198.51.100.22', 'guess-after')).status, 200, 'a login did not clear the failures before it');
    ok('a successful login clears the failures that came before it');

    // The window ends, and takes its rows with it.
    await db.prepare('UPDATE admin_login_attempts SET window_started_at = window_started_at - ?').bind(LOGIN_WINDOW_SECONDS).run();
    assert.equal((await guess('198.51.100.20', 'guess-later')).status, 200, 'a client stayed refused past its window');
    const stale = await db
      .prepare('SELECT COUNT(*) AS n FROM admin_login_attempts WHERE window_started_at <= ?')
      .bind(Math.floor(Date.now() / 1000) - LOGIN_WINDOW_SECONDS)
      .first();
    assert.equal(stale.n, 0, 'rows older than their window were kept');
    const keys = await db.prepare('SELECT client_key FROM admin_login_attempts').all();
    assert.ok(keys.results.every(({ client_key }) => /^[0-9a-f]{32}$/.test(client_key)), 'a row is keyed by something else than a hash');
    ok('after its window a client is answered again, and the table keeps no older row and no address');
  }

  /* ================================== 5. unauthorized download */

  section('Téléchargement non autorisé');
  {
    const files = await worker.bucket('FILES');
    await files.put('files/guide.pdf', 'PDF-BYTES');
    const order = await seedDigitalOrder(db);
    const other = await seedDigitalOrder(db);

    const granted = await fetch(`/order/${order.token}/download/${order.itemPublicId}`);
    assert.equal(granted.status, 200, 'the order token does not reach its own file');
    assert.equal(granted.headers.get('x-content-type-options'), 'nosniff');
    assert.match(granted.headers.get('content-disposition'), /^attachment;/);
    assert.equal(granted.headers.get('cache-control'), 'private, no-store');
    assert.equal(granted.headers.get('referrer-policy'), 'no-referrer');
    ok('the order token downloads its own file, as an attachment, never cached');

    const refusals = [
      ['an unknown token', `/order/${generateAccessToken()}/download/${order.itemPublicId}`],
      ['a malformed token', `/order/not-a-token/download/${order.itemPublicId}`],
      ['the bare order id', `/order/${order.orderPublicId}/download/${order.itemPublicId}`],
      ["another order's item", `/order/${order.token}/download/${other.itemPublicId}`],
      ['an unknown item', `/order/${order.token}/download/${generatePublicId('orderItem')}`],
      ['an item id of the wrong kind', `/order/${order.token}/download/${order.orderPublicId}`],
    ];
    for (const [name, path] of refusals) {
      const response = await fetch(path);
      assert.equal(response.status, 404, `${name} was served a file`);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
    ok(`${refusals.length} unauthorized download attempts answered 404, indistinguishably`);

    // A refunded order keeps its page and loses its deliverables.
    const refundedOrder = await seedDigitalOrder(db, { refunded: 5000 });
    const refused = await fetch(
      `/order/${refundedOrder.token}/download/${refundedOrder.itemPublicId}`,
    );
    assert.equal(refused.status, 403, 'a fully refunded order still delivered its file');
    ok('a fully refunded order no longer delivers its file');

    // The token IS the credential, so it must not be reachable from the order's
    // own public id — which appears on receipts and in the admin.
    const byPublicId = await fetch(`/order/${order.orderPublicId}`);
    assert.equal(byPublicId.status, 404, 'the bare order id opened the order page');
    ok('the bare order id opens nothing; only the token does');
  }

  /* ===================================== 6. uploads: SVG and fake MIME */

  section('Téléversement — SVG et faux type MIME');
  {
    const login = await fetch('/admin/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
    });
    // The auth limiter is spent by the brute-force section, so sign the session
    // rather than asking for one: the subject here is the upload rule.
    const hash = (await db
      .prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'")
      .first()).value;
    const cookie =
      login.status === 303
        ? login.headers.get('set-cookie').split(';')[0]
        : `admin_session=${await signSession(AUTH_SECRET, hash, 3600, Date.now() / 1000)}`;
    assert.equal(
      (await fetch('/api/admin/media', { headers: { cookie } })).status,
      200,
      'the suite could not authenticate to test the upload rules',
    );

    const post = async (files) => {
      const { contentType, body } = await multipart(files);
      return fetch('/api/admin/media', {
        method: 'POST',
        headers: {
          cookie,
          origin: ORIGIN,
          accept: 'application/json',
          'content-type': contentType,
        },
        body,
      });
    };

    const before = (await (await fetch('/api/admin/media', { headers: { cookie } })).json()).total;

    const refusals = [
      ['an SVG that says it is an SVG', SVG_WITH_SCRIPT, 'image/svg+xml', 'logo.svg'],
      ['an SVG that says it is a PNG', SVG_WITH_SCRIPT, 'image/png', 'logo.png'],
      ['an SVG that says it is a JPEG', SVG_WITH_SCRIPT, 'image/jpeg', 'logo.jpg'],
      ['an HTML page that says it is a GIF', HTML_PAGE, 'image/gif', 'page.gif'],
      ['a PNG that says it is a WebP', PNG_1X1, 'image/webp', 'photo.webp'],
    ];
    for (const [name, bytes, type, filename] of refusals) {
      const response = await post([{ bytes, type, name: filename }]);
      assert.equal(response.status, 400, `${name} was accepted`);
      const body = await response.json();
      assert.match(body.error, /JPEG|PNG|WebP|GIF/, `${name} got an unhelpful refusal`);
    }
    ok(`${refusals.length} mislabelled uploads refused, on their bytes rather than their name`);

    for (const [type, bytes] of Object.entries(REAL_IMAGES)) {
      const response = await post([{ bytes, type, name: `real.${type.split('/')[1]}` }]);
      assert.equal(response.status, 200, `a real ${type} was refused`);
    }
    ok('all four genuine formats are still accepted');

    const after = (await (await fetch('/api/admin/media', { headers: { cookie } })).json()).total;
    assert.equal(after - before, 4, 'a refused upload still reached the library');
    ok('a refused upload leaves nothing behind in the library');

    // Astro answers HEAD with the GET handler, and the Cache API stores GET
    // only: the certification's step 5 found every HEAD on an image throwing
    // in waitUntil — an exception in the real runtime's tail, under a 200.
    // Miniflare does not surface a rejected waitUntil, so this holds the
    // answer, not the exception.
    const [{ imageKey }] = (await (await fetch('/api/admin/media', { headers: { cookie } })).json()).media;
    const head = await fetch(`/images/${imageKey}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type') ?? '', /^image\//);
    ok('a stored image answers HEAD like GET');

    // A batch is validated before anything is stored, so one bad file in a
    // multi-select cannot leave half of it uploaded.
    const mixed = await post([
      { bytes: PNG_1X1, type: 'image/png', name: 'good.png' },
      { bytes: SVG_WITH_SCRIPT, type: 'image/png', name: 'bad.png' },
    ]);
    assert.equal(mixed.status, 400);
    const afterMixed = (await (await fetch('/api/admin/media', { headers: { cookie } })).json())
      .total;
    assert.equal(afterMixed, after, 'a batch with one bad file stored the good ones');
    ok('a batch containing one mislabelled file stores none of it');
  }

  /* ================================================ 7. path traversal */

  section('Traversée de chemin');
  {
    const attempts = [
      '/images/../../etc/passwd',
      '/images/..%2f..%2fetc%2fpasswd',
      '/images/media/..%2f..%2f..%2fseed.sql',
      '/images/%2e%2e%2f%2e%2e%2fpackage.json',
      '/images/....//....//package.json',
      '/images/media/%00../../package.json',
      '/pages/../admin/settings',
      '/pages/..%2fadmin%2fsettings',
    ];
    for (const path of attempts) {
      const response = await fetch(path);
      assert.ok(
        [301, 302, 303, 400, 404].includes(response.status),
        `${path} answered ${response.status}`,
      );
      if (response.status < 300) continue;
      if (response.status >= 300 && response.status < 400) {
        const to = new URL(response.headers.get('location'), ORIGIN);
        assert.equal(to.origin, ORIGIN, `${path} redirected off-origin to ${to}`);
        continue;
      }
      const body = await response.text();
      assert.ok(
        !/root:|"name": "minshop"|CREATE TABLE/i.test(body),
        `${path} answered with file contents`,
      );
    }
    ok(`${attempts.length} traversal attempts served no file outside the object store`);
  }

  /* ============================================ 8. security headers */

  section('En-têtes de sécurité');
  {
    // Every class of response the WORKER produces. Static assets are absent on
    // purpose: Cloudflare's asset server answers /favicon.svg and /_astro/*
    // ahead of the Worker, so the middleware never sees them. They are hardened
    // by public/_headers, and the built copy of that file is checked below.
    const classes = [
      ['a public page', '/', {}],
      ['a 404', '/not-a-route', {}],
      ['a redirect', '/admin', {}],
      ['an admin API 401', '/api/admin/products', {}],
      ['a public API', '/api/products?limit=1', {}],
      ['the health endpoint', '/api/health', {}],
      ['a robots file', '/robots.txt', {}],
      ['the sitemap', '/sitemap.xml', {}],
    ];
    for (const [name, path, init] of classes) {
      const response = await fetch(path, init);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', name);
      assert.equal(response.headers.get('x-frame-options'), 'DENY', name);
      assert.match(
        response.headers.get('strict-transport-security') ?? '',
        /max-age=\d{7,}/,
        name,
      );
      assert.match(
        response.headers.get('content-security-policy') ?? '',
        /object-src 'none'.*base-uri 'self'.*frame-ancestors 'none'/,
        name,
      );
      assert.ok(response.headers.get('referrer-policy'), `${name} carries no referrer policy`);
      assert.ok(response.headers.get('cache-control'), `${name} left without a cache directive`);
    }
    ok(`${classes.length} response classes carry the full set of hardening headers`);

    // The store-wide referrer floor must never overwrite a route that asked for
    // more. The order page carries a bearer token in its own URL.
    const order = await seedDigitalOrder(db);
    const page = await fetch(`/order/${order.token}`);
    assert.equal(page.status, 200);
    assert.equal(
      page.headers.get('referrer-policy'),
      'no-referrer',
      'the store-wide default overwrote a capability URL page',
    );
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    ok('a capability URL keeps no-referrer; the default never downgrades it');

    // The static half, in the artifact that actually ships. The unit gate
    // beside src/features/http/securityHeaders.ts checks the source file
    // against the middleware's list; this checks that the build carried it
    // through, next to the adapter's own generated rule.
    const built = readFileSync('dist/client/_headers', 'utf8');
    for (const header of [
      'X-Content-Type-Options: nosniff',
      'X-Frame-Options: DENY',
      'Strict-Transport-Security:',
      "Content-Security-Policy: object-src 'none'",
      'Referrer-Policy:',
    ]) {
      assert.ok(built.includes(header), `the built asset config lost ${header}`);
    }
    assert.match(built, /^\/\*$/m, 'the built asset config has no store-wide rule');
    ok('the built asset config hardens what the Worker never sees');
  }

  /* =============================== 9. an unhandled error is still a response */

  section('Une erreur non rattrapée reste une réponse');
  {
    // Not a simulated failure: a POST whose Content-Type is neither of the two
    // shapes `request.formData()` can parse makes it reject, on a route that
    // does not catch. Anyone can send it, unauthenticated, and before this the
    // answer was Astro's own bare 500 — no cache directive on a platform that
    // heuristically stores headerless responses, and none of the hardening
    // every other response carries.
    const response = await fetch('/api/cart', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/octet-stream' },
      body: 'not a form',
    });

    assert.equal(response.status, 500);
    assert.equal(
      response.headers.get('cache-control'),
      'private, no-store',
      'a 500 left without a cache directive',
    );
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const body = await response.text();
    assert.ok(
      !/D1_ERROR|SQLITE|at \w+ \(|\.mjs:\d+/i.test(body),
      `the 500 body described the failure: ${body.slice(0, 200)}`,
    );
    assert.match(
      worker.logs(),
      /"event":"unhandled_error","path":"\/api\/cart"/,
      'the failure was swallowed instead of logged',
    );
    ok('an unhandled error answers 500 — uncacheable, hardened, silent, and logged');
  }

  /* ================================ 10. no address, no e-mail in the logs */

  section('Absence d\'adresse et d\'e-mail dans les logs');
  {
    worker.clearLogs();
    outboundCalls.length = 0;

    // Configure e-mail the way an operator does: the provider key encrypted in
    // the vault, the sender in settings. Without this the provider resolves to
    // null, every notification is marked `skipped`, and the assertions below
    // would pass by never having attempted anything.
    await db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enc:resend_api_key', ?)")
      .bind(await encryptSecret(SECRETS_KEK, 're_security_suite_key'))
      .run();
    for (const [key, value] of [
      ['email_enabled', '1'],
      ['email_provider', 'resend'],
      ['email_from', 'boutique@exemple-pilote.fr'],
      // The cron has no request to take an origin from, so the sweep reads the
      // one live traffic recorded.
      ['store_url', ORIGIN],
    ]) {
      await db
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind(key, value)
        .run();
    }

    const order = await seedDigitalOrder(db);
    const adminCookie = `admin_session=${await signSession(
      AUTH_SECRET,
      (await db
        .prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'")
        .first()).value,
      3600,
      Date.now() / 1000,
    )}`;

    // Everything a shopper touches that carries their identity.
    await fetch('/account/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams({ email: CUSTOMER.email }).toString(),
    });
    await fetch(`/order/${order.token}`);
    await fetch(`/order/${order.token}/status`);
    await fetch('/api/checkout', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ slug: 'nothing-here', quantity: 1 }],
        email: CUSTOMER.email,
        ship_to: {
          name: CUSTOMER.name,
          line1: CUSTOMER.street,
          city: CUSTOMER.city,
          postal_code: CUSTOMER.postalCode,
          country: 'FR',
        },
      }),
    });
    // And the operator action that sends to that address: marking the order
    // shipped queues the notice and attempts it now, so the provider's answer —
    // the customer, quoted back — reaches a log line on this very request.
    const shipped = await fetch(`/api/admin/orders/${order.orderPublicId}`, {
      method: 'POST',
      headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': FORM },
      body: new URLSearchParams({
        _action: 'fulfill',
        carrier: 'Colissimo',
        tracking_number: '6A11111111111',
      }).toString(),
    });
    assert.equal(shipped.status, 303, 'the order could not be marked shipped');

    if (outboundCalls.length === 0) console.error('DEBUG LOGS:\n' + worker.logs().slice(0, 4000));
    assert.ok(
      outboundCalls.length > 0,
      'no delivery was attempted — this section would have proved nothing',
    );
    const logs = worker.logs();
    assert.match(
      logs,
      /Order notification order-shipped/,
      'the failed delivery was never logged — this section would have proved nothing',
    );
    ok(`${outboundCalls.length} delivery attempt(s) failed with the customer in the provider's answer`);

    const leaks = [
      ['the e-mail address', CUSTOMER.email],
      ['the street', CUSTOMER.street],
      ['the recipient name', CUSTOMER.name],
      ['the postal code with the city', `${CUSTOMER.postalCode} ${CUSTOMER.city}`],
      ['a guest access token', order.token],
    ].filter(([, value]) => logs.includes(value));
    assert.deepEqual(
      leaks.map(([name]) => name),
      [],
      `personal data reached the logs:\n${logs.slice(0, 3000)}`,
    );
    ok('nothing a customer told the store appears in what the Worker printed');

    // And the redaction is not silence: the operator still learns what failed,
    // on which order, and how.
    assert.match(logs, /Resend send failed \(422\)/, 'the log no longer names the failure');
    assert.match(logs, /ord_[0-9a-z]+/, 'the log no longer names the order');
    ok('what remains still names the failure and the order, never the customer');

    // The store's own secrets are held to the same rule. They are bound to this
    // Worker and reached on the paths just exercised — the session signer, the
    // vault key that decrypted the provider key, and the provider key itself.
    const secrets = [
      ['AUTH_SECRET', AUTH_SECRET],
      ['SECRETS_KEK', SECRETS_KEK],
      ['the provider key from the vault', 're_security_suite_key'],
    ].filter(([, value]) => logs.includes(value));
    assert.deepEqual(
      secrets.map(([name]) => name),
      [],
      'a credential reached the logs',
    );
    ok('no credential the Worker holds appears in what it printed');

    // The same rule for what is persisted: the retry row an operator opens in
    // the admin carries the diagnosis, not the address.
    const stored = await db
      .prepare("SELECT last_error FROM order_notifications WHERE order_id = ? AND kind = 'order-shipped'")
      .bind(order.id)
      .first();
    assert.ok(stored?.last_error, 'the failure was not recorded for retry');
    for (const value of [CUSTOMER.email, CUSTOMER.street, CUSTOMER.name]) {
      assert.ok(!String(stored.last_error).includes(value), 'personal data was stored on the retry row');
    }
    ok('the stored retry error carries the diagnosis, not the customer');
  }

  /* ================================== 11. Cloudflare Access, fail-closed */

  section('Cloudflare Access — fermeture par défaut');
  {
    // Access is a DEPLOYMENT configuration, not a runtime setting, so it needs
    // its own Worker: a store fronted by Access instead of a password. Both
    // shapes are checked, because the dangerous one is the half-configured
    // deployment — an assertion this Worker cannot verify must be worth less
    // than no assertion at all, never more.
    const configurations = [
      [
        'both variables set',
        {
          CF_ACCESS_TEAM_DOMAIN: 'https://pilote.cloudflareaccess.com',
          CF_ACCESS_AUD: 'a'.repeat(64),
        },
      ],
      ['only the team domain', { CF_ACCESS_TEAM_DOMAIN: 'https://pilote.cloudflareaccess.com' }],
      ['only the audience', { CF_ACCESS_AUD: 'a'.repeat(64) }],
    ];

    for (const [name, vars] of configurations) {
      const fronted = await startBuiltWorker({
        vars: { AUTH_SECRET, ...vars },
        // The team's JWKS endpoint is unreachable from here, which is the
        // situation the gate has to survive: no keys means no verification
        // means no entry.
        outbound: async () => new Response('unreachable', { status: 502 }),
      });
      try {
        await fronted.db
          .prepare("INSERT INTO settings (key, value) VALUES ('setup_complete', '1')")
          .run();
        // No admin password: this store is protected by the edge, and the
        // bootstrap wizard must NOT be the way in.
        for (const [what, headers] of [
          ['no assertion', {}],
          [
            'an assertion this Worker cannot verify',
            // secret-scan:ignore — a forged assertion has to be JWT-shaped to be forged.
            { 'cf-access-jwt-assertion': 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jbyJ9.sig' },
          ],
        ]) {
          for (const path of ['/admin', '/admin/setup', '/api/admin/products']) {
            const response = await fronted.fetch(path, { headers });
            assert.equal(response.status, 403, `${name}, ${what}: ${path} answered ${response.status}`);
          }
        }
      } finally {
        await fronted.dispose();
      }
    }
    ok('under Access, three configurations x two callers x three routes: 403 every time');
  }

  console.log(`\n✔ security gate: ${checks} checks passed`);
} finally {
  await worker.dispose();
}
