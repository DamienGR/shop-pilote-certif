/**
 * The security gate, against a deployed shop (plan §8.4, certification étape 0).
 *
 * `test/integration/security.mjs` proves the admin door and the hardening on
 * the built Worker, in process, with Miniflare. What it cannot prove is that
 * the same holds on the platform — behind Cloudflare's edge, its URL
 * normalisation, its asset server, a custom domain. This is the subset of that
 * gate that needs nothing but HTTP, re-run against a real origin:
 *
 *   - the admin surface, derived from the route files, refused anonymously;
 *   - the setup wizard closed, a forged Access assertion ignored;
 *   - cross-origin and origin-less form posts refused;
 *   - path traversal answered with a refusal that leaks nothing;
 *   - the hardening headers on every class of response, static assets included;
 *   - a capability URL that does not exist answering 404 and keeping no-referrer;
 *   - an unhandled error answering a hardened, uncacheable 500;
 *   - the payment webhooks refusing an unsigned or forged event — sent WITHOUT
 *     the service token, because Stripe has none: behind a private preview the
 *     answer must still be the Worker's, through Access's bypass;
 *   - no page of the shop's own asking for a card: the purchase is paid on the
 *     provider's page, and no form field here is shaped to take a card.
 *
 * With `--limiteurs`, it also trips the three rate limiters once each — search
 * and checkout by a flood, the admin login by a patient guesser — and expects a
 * 429 that says when to come back. Opt-in and never in the nightly run: the
 * address that runs it waits a minute before it can check out again and a
 * quarter of an hour before it can log in, and on a real shop that is its owner.
 *
 * What stays local, and why: the log assertions (they read the Worker's stdout
 * — `npm run test:logs:remote` reads a `wrangler tail` instead), uploads and
 * sessions (they need an admin session, which this gate must never hold).
 *
 * Run: BASE_URL=https://… npm run test:security:remote [-- --limiteurs]
 * (plus CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET behind a private preview)
 *
 * It sends ONE request that makes the Worker throw on purpose (the 500 check),
 * so a run shows up as one error in `shopctl monitor` — never enough to judge.
 */
import { createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';
import { adminRoutes } from '../helpers/admin-routes.mjs';
import { LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_SECONDS } from '../../src/features/auth/loginThrottle.ts';
import { generateAccessToken } from '../../src/features/ids/token.ts';
import { fetchAs, isAccessChallenge, remoteTarget } from './target.mjs';

const { values: options } = parseArgs({ options: { limiteurs: { type: 'boolean', default: false } } });

const FORM = 'application/x-www-form-urlencoded';
const FLOOD_WIDTH = 50;
const FLOOD_FACTOR = 20;
const LEAK = /root:|"name": "minshop"|CREATE TABLE|sqlite|D1_ERROR|\bat .+\.(m?js|ts):\d+/i;

let target;
try {
  target = remoteTarget();
} catch (error) {
  console.error(`remote-security: ${error.message}`);
  process.exit(2);
}

const failures = [];
let passed = 0;
const section = (title) => console.log(`\n▸ ${title}`);
async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✓ ${name}`);
    if (typeof detail === 'string') console.log(`      ${detail}`);
  } catch (error) {
    failures.push({ name, reason: error.message });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const get = (path, init) => fetchAs(target, path, init);
const locationPath = (response) => {
  const location = response.headers.get('location');
  return location ? new URL(location, target.origin).pathname : null;
};

console.log(`Porte de sécurité distante — ${target.origin}${target.behindAccess ? ' (jeton de service Access)' : ''}`);

/* ------------------------------------------------------------------ reach */

const home = await get('/');
if (isAccessChallenge(home)) {
  console.error('\nCloudflare Access répond à la place du Worker : posez CF_ACCESS_CLIENT_ID et CF_ACCESS_CLIENT_SECRET.');
  process.exit(2);
}

// The Worker's own gate decides which refusals are correct. A password sends
// the anonymous visitor to the login page; Access mode answers 403.
const probe = await get('/admin');
const mode = probe.status === 403 ? 'access' : probe.status === 303 && locationPath(probe) === '/admin/login' ? 'password' : null;

/* ------------------------------------------------------- the admin surface */

section('La porte d\'administration');

await check(`l'admin refuse l'anonyme (mode ${mode ?? 'inconnu'})`, () => {
  expect(mode !== null, `GET /admin a répondu ${probe.status} ${probe.headers.get('location') ?? ''} : ni la page de connexion, ni un refus`);
});

const routes = adminRoutes();
await check(`${routes.length} routes d'administration dérivées des fichiers, refusées sur chaque verbe`, async () => {
  expect(routes.length >= 30, `seulement ${routes.length} routes dérivées : le chemin src/pages a-t-il changé ?`);
  const wrong = [];
  for (const { path, verbs } of routes) {
    for (const verb of verbs) {
      const init = verb === 'GET' ? {} : { method: verb, headers: { origin: target.origin, 'content-type': FORM }, body: '' };
      const response = await get(path, init);
      const status = response.status;
      const refused =
        status === 403 ||
        (path.startsWith('/api/') && status === 401) ||
        (path === '/admin/login' && status === 200) ||
        (!path.startsWith('/api/') && status === 303 && locationPath(response) === '/admin/login');
      if (!refused) wrong.push(`${verb} ${path} → ${status}`);
    }
  }
  expect(wrong.length === 0, wrong.join(', '));
});

await check('le magicien d\'installation est fermé', async () => {
  const response = await get('/admin/setup');
  expect(response.status !== 200, '/admin/setup répond 200 : la boutique est en mode amorçage, quiconque peut poser le mot de passe');
});

await check('une assertion Access forgée n\'ouvre rien', async () => {
  // Built rather than written out: the shape of a JWT, signed by nobody.
  const part = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const forged = `${part({ alg: 'RS256' })}.${part({ email: 'mallory@example.fr' })}.${part('signature')}`;
  const response = await get('/admin', { headers: { 'cf-access-jwt-assertion': forged } });
  expect(response.status === 403 || (response.status === 303 && locationPath(response) === '/admin/login'), `GET /admin avec un jeton forgé → ${response.status}`);
});

await check('une API d\'administration ne dit rien de ce qu\'elle protège', async () => {
  const response = await get('/api/admin/orders/ord_0000000000', {
    method: 'POST',
    headers: { origin: target.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'shipped' }),
  });
  expect(response.status === 401 || response.status === 403, `statut ${response.status}`);
  const body = await response.text();
  expect(!/ord_|stack/i.test(body) && !LEAK.test(body), 'le corps du refus parle de la commande ou de la pile');
});

/* ---------------------------------------------------------- form origin */

section('L\'origine des formulaires');

await check('un POST d\'une autre origine, ou sans origine, est refusé', async () => {
  const wrong = [];
  for (const path of ['/admin/login', '/account/login', '/api/cart', '/cart']) {
    for (const headers of [{ origin: 'https://evil.example', 'content-type': FORM }, { 'content-type': FORM }]) {
      const response = await get(path, { method: 'POST', headers, body: 'password=x' });
      if (response.status !== 403) wrong.push(`${path} ${headers.origin ? 'evil.example' : 'sans Origin'} → ${response.status}`);
    }
  }
  expect(wrong.length === 0, wrong.join(', '));
});

await check('un POST de même origine passe la garde d\'origine', async () => {
  const response = await get('/admin/login', { method: 'POST', headers: { origin: target.origin, 'content-type': FORM }, body: 'password=wrong-on-purpose' });
  expect(mode === 'access' || response.status !== 403, `la garde refuse aussi la boutique elle-même (${response.status})`);
  expect(response.status < 500, `statut ${response.status}`);
});

/* --------------------------------------------------------- path traversal */

section('Traversée de chemin');

await check('huit formes de traversée refusées sans rien laisser voir', async () => {
  const wrong = [];
  for (const path of [
    '/images/../../etc/passwd',
    '/images/..%2f..%2fetc%2fpasswd',
    '/images/media/..%2f..%2f..%2fseed.sql',
    '/images/%2e%2e%2f%2e%2e%2fpackage.json',
    '/images/....//....//package.json',
    '/images/media/%00../../package.json',
    '/pages/../admin/settings',
    '/pages/..%2fadmin%2fsettings',
  ]) {
    const response = await get(path);
    const body = await response.text();
    if (![301, 302, 303, 400, 403, 404].includes(response.status)) wrong.push(`${path} → ${response.status}`);
    else if (response.status < 400 && new URL(response.headers.get('location') ?? '/', target.origin).origin !== target.origin) wrong.push(`${path} redirige hors de l'origine`);
    else if (LEAK.test(body)) wrong.push(`${path} laisse fuiter un contenu`);
  }
  expect(wrong.length === 0, wrong.join(', '));
});

/* ------------------------------------------------------- payment webhooks */

section('Les webhooks de paiement');

// What the provider would send, signed by nobody — or by a secret that is not
// the shop's. Neither may settle anything; both must be answered by the Worker
// itself ("Webhook verification failed"), or by its 404 for a rail the shop
// does not run. Anything else — a 2xx, a 5xx, Access's login — is the finding.
const WEBHOOK_EVENT = JSON.stringify({
  id: 'evt_porte_distante',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_porte_distante', object: 'checkout.session', payment_status: 'paid', amount_total: 1, currency: 'eur', metadata: {} } },
});
const forgedSignature = () => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', 'cle-qui-n-est-pas-celle-de-la-boutique').update(`${t}.${WEBHOOK_EVENT}`).digest('hex')}`;
};

await check('un événement non signé ou mal signé est refusé par le Worker, sans jeton Access', async () => {
  const wrong = [];
  for (const path of ['/api/webhook', '/api/webhook/stripe']) {
    for (const [label, headers] of [['sans signature', {}], ['signature forgée', { 'stripe-signature': forgedSignature() }]]) {
      const response = await get(path, { access: false, method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: WEBHOOK_EVENT });
      const body = await response.text();
      const worker =
        (response.status === 400 && body.startsWith('Webhook verification failed')) ||
        (response.status === 404 && body.startsWith('Unknown or unconfigured payment method'));
      if (isAccessChallenge(response)) wrong.push(`${path} ${label} → page de connexion d'Access : Stripe n'atteint pas la boutique`);
      else if (!worker) wrong.push(`${path} ${label} → ${response.status}`);
      else if (LEAK.test(body)) wrong.push(`${path} ${label} laisse fuiter un détail interne`);
    }
  }
  expect(wrong.length === 0, wrong.join(', '));
});

if (target.behindAccess) {
  await check('hors du webhook, la preview reste privée', async () => {
    const wrong = [];
    for (const path of ['/', '/admin', '/api/products?limit=1']) {
      const response = await get(path, { access: false });
      if (response.status === 200) wrong.push(`${path} → 200 sans jeton`);
    }
    expect(wrong.length === 0, `${wrong.join(', ')} : l'application Access ne couvre plus ce nom d'hôte`);
  });
}

/* ------------------------------------------------------------- card data */

section('Aucune donnée de carte');

// The purchase is paid on the provider's page; no page of the shop's own may
// carry a field shaped to take a card. The pages a buyer crosses before that
// page: the catalogue, a product, the cart, and express checkout — both of
// which post to /api/checkout, which answers with the provider's URL.
const CARD_FIELD = /<input\b[^>]*(?:autocomplete\s*=\s*["']?cc-|name\s*=\s*["'][^"']*(?:card|cvc|cvv|cc-?num|cc-?exp|expiry)[^"']*["'])/i;

await check('aucun champ de carte sur les pages de la boutique, du catalogue au paiement', async () => {
  const list = await (await get('/api/products?limit=100')).json().catch(() => ({ products: [] }));
  const product = (list.products ?? []).find((entry) => entry.in_stock && !entry.variant_label);
  expect(product, 'aucun produit simple en stock : il n\'y a pas de checkout à examiner');
  // A cart is a cookie: putting a product in it holds no stock.
  const added = await get('/api/cart', {
    method: 'POST',
    headers: { origin: target.origin, 'content-type': FORM },
    body: new URLSearchParams({ _action: 'add', product_id: product.id, qty: '1' }).toString(),
  });
  const cookie = added.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  const wrong = [];
  for (const path of ['/', `/products/${product.slug}`, '/cart', `/express?product_id=${product.id}`, '/express']) {
    const response = await get(path, { headers: { cookie } });
    const html = await response.text();
    if (response.status !== 200) wrong.push(`${path} → ${response.status}`);
    else if (CARD_FIELD.test(html)) wrong.push(`${path} porte un champ de carte`);
  }
  expect(wrong.length === 0, wrong.join(', '));
});

/* ---------------------------------------------------------------- headers */

section('En-têtes de durcissement');

const hardened = (response, label, { cache = true } = {}) => {
  const missing = [];
  if (response.headers.get('x-content-type-options') !== 'nosniff') missing.push('nosniff');
  if (response.headers.get('x-frame-options') !== 'DENY') missing.push('x-frame-options');
  if (!/max-age=\d{7,}/.test(response.headers.get('strict-transport-security') ?? '')) missing.push('hsts');
  if (!/object-src 'none'.*base-uri 'self'.*frame-ancestors 'none'/.test(response.headers.get('content-security-policy') ?? '')) missing.push('csp');
  if (!response.headers.get('referrer-policy')) missing.push('referrer-policy');
  if (cache && !response.headers.get('cache-control')) missing.push('cache-control');
  return missing.length > 0 ? `${label} : ${missing.join(', ')}` : null;
};

await check('chaque classe de réponse du Worker porte le durcissement complet', async () => {
  const wrong = [];
  for (const [label, path] of [
    ['une page publique', '/'],
    ['une 404', '/not-a-route'],
    ['une redirection', '/admin'],
    ['un 401 d\'API admin', '/api/admin/products'],
    ['une API publique', '/api/products?limit=1'],
    ['le point de santé', '/api/health'],
    ['robots.txt', '/robots.txt'],
    ['le plan du site', '/sitemap.xml'],
  ]) {
    const problem = hardened(await get(path), label);
    if (problem) wrong.push(problem);
  }
  expect(wrong.length === 0, wrong.join(' ; '));
});

await check('les actifs statiques, servis avant le Worker, aussi', async () => {
  const problem = hardened(await get('/favicon.svg'), '/favicon.svg', { cache: false });
  expect(problem === null, problem);
});

/* ------------------------------------------------------- capability URLs */

section('URL à capacité');

// A well-formed token nobody was issued. The order page answers it the way it
// answers a buyer who lands before the webhook — a page that waits — so the
// property is not the status but that the URL never leaves in a referrer and
// never sits in a cache; the download beneath it is a plain 404.
await check('un jeton de commande inconnu n\'ouvre rien et ne fuit ni en référent ni en cache', async () => {
  const token = generateAccessToken();
  const order = await get(`/order/${token}`);
  expect([200, 404].includes(order.status), `/order/<jeton> → ${order.status}`);
  expect(order.headers.get('referrer-policy') === 'no-referrer', '/order/<jeton> sans no-referrer');
  expect(order.headers.get('cache-control') === 'private, no-store', `/order/<jeton> cache-control ${order.headers.get('cache-control')}`);
  const download = await get(`/order/${token}/download/itm_0000000000`);
  expect(download.status === 404, `/order/<jeton>/download → ${download.status}`);
  expect(download.headers.get('referrer-policy') === 'no-referrer', '/order/<jeton>/download sans no-referrer');
});

/* ---------------------------------------------------- an unhandled error */

section('Une erreur non rattrapée reste une réponse');

await check('un 500 est durci, non mis en cache, et ne montre pas sa pile', async () => {
  const response = await get('/api/cart', { method: 'POST', headers: { origin: target.origin, 'content-type': 'application/octet-stream' }, body: 'x' });
  expect(response.status === 500, `statut ${response.status}`);
  expect(response.headers.get('cache-control') === 'private, no-store', `cache-control ${response.headers.get('cache-control')}`);
  expect(response.headers.get('x-content-type-options') === 'nosniff', 'pas de nosniff');
  const body = await response.text();
  expect(!LEAK.test(body), 'le corps montre une pile ou un détail interne');
});

/* ---------------------------------------------------------- rate limiters */

if (options.limiteurs) {
  section('Les limiteurs de débit (--limiteurs)');

  // Last, so nothing above runs behind a tripped limiter.
  //
  // Search and checkout are held by Cloudflare's limiter, which counts per
  // location and caches per machine: permissive by design. Certification step
  // 5 measured it on a deployed shop — nothing refused at three times the
  // limit, the first 429 after about 450 searches sent fifty at a time, for a
  // limit of 60. What it guarantees is that a flood meets it, so that is what
  // is asked: fifty at a time, up to twenty times the limit.
  async function flood(limit, send) {
    for (let sent = 0; sent < limit * FLOOD_FACTOR; sent += FLOOD_WIDTH) {
      const burst = await Promise.all(Array.from({ length: FLOOD_WIDTH }, (_, index) => send(sent + index)));
      const refused = burst.find((response) => response.status === 429);
      if (refused) return { sent: sent + FLOOD_WIDTH, refused };
    }
    return null;
  }
  const flooded = (label, limit, outcome) => {
    expect(outcome, `aucun 429 en ${limit * FLOOD_FACTOR} requêtes : le limiteur ${label} n'est pas actif sur ce déploiement`);
    expect(outcome.refused.headers.get('retry-after'), `le 429 ${label} ne dit pas quand revenir`);
    return `premier refus dans les ${outcome.sent} premières requêtes`;
  };

  await check('la recherche répond 429 sous une inondation (limite de 60 par minute)', async () => {
    const run = Date.now().toString(36);
    return flooded('de recherche', 60, await flood(60, (index) => get(`/search?q=porte${run}${index}`)));
  });

  await check('le checkout répond 429 sous une inondation (limite de 20 par minute), sans rien réserver', async () => {
    // An empty order: refused by the route, counted by the limiter before it.
    return flooded('du checkout', 20, await flood(20, () => get('/api/checkout', { method: 'POST', headers: { origin: target.origin, 'content-type': 'application/json' }, body: '{}' })));
  });

  // The admin login is counted exactly, in the shop's own database
  // (features/auth/loginThrottle.ts), because a production admin has no Access
  // in front of its password. One at a time, as a patient guesser would: the
  // guess past the budget is refused — counting what this run already spent —
  // for the rest of a quarter of an hour, which the edge limiter's minute
  // cannot be mistaken for.
  if (mode === 'password') {
    await check(`la connexion répond 429 au plus tard à la ${LOGIN_ATTEMPT_LIMIT + 1}e tentative, pour un quart d'heure`, async () => {
      for (let attempt = 1; attempt <= LOGIN_ATTEMPT_LIMIT + 1; attempt++) {
        const response = await get('/admin/login', { method: 'POST', headers: { origin: target.origin, 'content-type': FORM }, body: 'password=porte-distante-limiteur' });
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'));
          expect(retryAfter > 60, `le 429 de la tentative ${attempt} est celui du limiteur de Cloudflare (Retry-After ${retryAfter}) : le compteur exact n'a pas répondu`);
          expect(retryAfter <= LOGIN_WINDOW_SECONDS, `Retry-After ${retryAfter} au-delà de la fenêtre`);
          expect(response.headers.get('set-cookie') === null, 'le refus pose un cookie');
          return;
        }
        expect(response.status === 200, `tentative ${attempt} : statut ${response.status}`);
      }
      throw new Error(`${LOGIN_ATTEMPT_LIMIT + 1} mauvais mots de passe sans 429 : le compteur exact n'est pas actif sur ce déploiement`);
    });
  } else {
    console.log('  · la connexion : pas de mot de passe à deviner sur cette administration, rien à compter');
  }
}

/* ----------------------------------------------------------------- verdict */

console.log(`\n${passed} contrôle(s) passé(s), ${failures.length} en échec.`);
process.exit(failures.length === 0 ? 0 : 1);
