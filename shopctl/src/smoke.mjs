/**
 * The smoke test a deployment has to pass before anyone is told it worked.
 *
 * Split in two on purpose. `SMOKE_CHECKS` and `evaluateSmoke()` are pure — they
 * take responses and return verdicts — and `runSmoke()` is the twenty lines that
 * fetch them. That is what lets the suite assert what each check DECIDES,
 * against every shape a broken deployment produces, without a network and
 * without a deployed shop. A smoke test that could only be exercised against a
 * real deployment would be verified by running it, which is not verification.
 *
 * What it asserts is deliberately small: that the deployment is the shop, that
 * it can read its database, and that its administration is not open. A deep
 * functional suite already exists (§8) and runs against staging; repeating it
 * here would make every deploy slow, and a slow post-deploy check is one that
 * gets a `--skip` in the first hurried release.
 *
 * Every check is NEGATIVE-SAFE: a request that fails to complete is a failure,
 * never a pass. The failure mode this exists to prevent is a promotion that
 * proceeded because the check could not reach the site.
 */

/**
 * @typedef {{ id: string, path: string, what: string, severity?: 'fail'|'warn', check: (response: SmokeResponse) => string|{ message: string, severity: 'warn' }|{ message: string, notServed: true }|null }} SmokeCheck
 * @typedef {{ ok: boolean, status: number|null, body: string, headers: Record<string,string>, error: string|null }} SmokeResponse
 */

/** How much of a body a check reads. The storefront's <head> and the first
 *  markup are all any of these needs, and a full page of a 100-product
 *  catalogue is a megabyte nobody looks at. */
export const BODY_LIMIT = 64 * 1024;

/**
 * A shop nobody has installed yet sends every storefront page to the wizard.
 *
 * That is the state of EVERY first deployment that no Access application
 * hides — a staging on workers.dev, and the first production of every shop,
 * deployed before the client can enter anything (ADR 0015). Read as a failure,
 * it turned each of them red after the upload; read as a pass, it would vouch
 * for a storefront nobody has seen. So it is a warning that names the state,
 * and the redirect is not nothing: the middleware sends it only after reading
 * the settings from D1 and finding the installation unfinished, so the
 * database answered.
 */
function awaitingSetup(response) {
  if (![301, 302, 303, 307, 308].includes(response.status)) return false;
  const location = response.headers?.location;
  if (!location) return false;
  try {
    return new URL(location, 'http://shop.invalid').pathname === '/admin/setup';
  } catch {
    return false;
  }
}

const SETUP_PENDING = {
  severity: 'warn',
  message: 'renvoie vers /admin/setup : la boutique n\'est pas encore installée (la base a répondu, l\'installation y est inachevée). Ce point se vérifiera au déploiement qui suivra l\'assistant.',
};

/**
 * Cloudflare's own answer on a name that leads to no Worker — not yet, or not
 * any more.
 *
 * Seen in real at step 7 of the certification (2026-10-20): the first
 * deployment of a shop on workers.dev was smoke-tested before every edge
 * served the new name, and Cloudflare itself answered `404` on `/`,
 * `/products` and `/admin`. Read as the shop's answers, they failed a healthy
 * deployment — code 6, "la liaison D1 est le premier suspect", a rollback to
 * run — and passed `/admin` for the wrong reason: a 404 from nobody is not an
 * administration that is closed. So no check judges this answer; each one
 * reports that nothing was asked.
 *
 * One answer, two forms, chosen by what the request accepts: `error code:
 * 1042` in plain text to a request that takes no compression (curl's
 * default), and an HTML page, "There is nothing here yet", without the code,
 * to one that does — which is what fetch sends, and so what this module gets.
 */
export function servedByCloudflare(response) {
  if (response.status !== 404) return false;
  const body = response.body.trim();
  return body === 'error code: 1042' || /<h1>\s*There is nothing here yet\s*<\/h1>/.test(body);
}

const NOT_SERVED = 'Cloudflare répond lui-même (« There is nothing here yet », error code: 1042) : aucun Worker n\'est servi sous ce nom. Juste après un premier déploiement, c\'est la propagation de workers.dev ; sinon, la route ne mène pas au Worker.';

/** How long `deploy` waits for Cloudflare to serve a new name, by default. The
 *  real one took under a minute; twice that before calling it a failure. */
export const SMOKE_WAIT_SECONDS = 120;

/** Between two runs of the whole smoke test while Cloudflare answers. */
export const SMOKE_INTERVAL_MS = 10_000;

/** @type {SmokeCheck[]} */
export const SMOKE_CHECKS = [
  {
    id: 'storefront',
    path: '/',
    what: 'la vitrine répond et se déclare française',
    check(response) {
      if (awaitingSetup(response)) return SETUP_PENDING;
      if (response.status !== 200) return `répond ${response.status ?? 'rien'} au lieu de 200`;
      // The locale attribute is the one thing on this page that proves the
      // FRENCH core is what got deployed. A 200 from a default Worker
      // placeholder, or from someone else's shop, looks identical without it.
      if (!/<html[^>]*\blang="fr"/.test(response.body)) return 'ne publie pas <html lang="fr"> : ce n\'est pas le storefront français';
      return null;
    },
  },
  {
    id: 'catalogue',
    path: '/products',
    what: 'le catalogue rend, donc la base D1 répond',
    check(response) {
      // The bound database is the thing this actually proves. A Worker deployed
      // against a database that does not exist — a missing binding, a
      // jurisdiction the binding does not name — still serves the home page and
      // fails here.
      if (awaitingSetup(response)) return SETUP_PENDING;
      if (response.status !== 200) return `répond ${response.status ?? 'rien'} au lieu de 200 : la liaison D1 est le premier suspect`;
      return null;
    },
  },
  {
    id: 'robots',
    path: '/robots.txt',
    what: 'les fichiers de service sont servis',
    check(response) {
      if (awaitingSetup(response)) return SETUP_PENDING;
      if (response.status !== 200) return `répond ${response.status ?? 'rien'} au lieu de 200`;
      // On a name that leads to no Worker, Cloudflare serves a robots.txt of
      // its own, in 200 — its content signals, nothing but comments. It passed
      // this check at step 7. The shop's carries the rule that keeps the
      // administration out of search engines.
      if (!/^Disallow: \/admin\s*$/m.test(response.body)) {
        return {
          notServed: true,
          message: 'répond 200 sans la règle « Disallow: /admin » : ce robots.txt n\'est pas celui de la boutique (Cloudflare sert le sien, fait de commentaires, sur un nom sans Worker)',
        };
      }
      return null;
    },
  },
  {
    id: 'admin-closed',
    path: '/admin',
    what: 'l\'administration n\'est pas ouverte',
    check(response) {
      // 200 is the failure. Anything else — a redirect to a login, a redirect to
      // the first-run wizard, a 401, a 403 from Cloudflare Access — means
      // something stands in front of it.
      if (response.status === 200) return 'répond 200 sans authentification : /admin est ouvert sur cette URL';
      return null;
    },
  },
  {
    id: 'admin-setup-open',
    path: '/admin/setup',
    // A WARNING, not a failure, and the distinction is the whole point. The
    // first-run wizard is SUPPOSED to be reachable on a shop that has no admin
    // password yet — that is how the password gets set — so failing here would
    // fail every first deployment and the check would be skipped within a week.
    // What it must not do is stay reachable, so the deploy says so out loud
    // every time until someone closes it.
    severity: 'warn',
    what: 'l\'assistant de première installation est refermé',
    check(response) {
      if (response.status === 200) {
        return 'répond 200 : n\'importe qui peut définir le mot de passe de l\'administration. Ouvrez /admin/setup maintenant, ou placez Cloudflare Access devant /admin.';
      }
      return null;
    },
  },
];

/**
 * The checks for an environment that is supposed to be CLOSED.
 *
 * A private preview inverts the storefront question: a 200 from an
 * unauthenticated request is the failure, not the pass. Everything else
 * follows — a gated origin cannot answer 200 on `/products` or `/robots.txt`
 * either, so those checks would fail for the right reason but with the wrong
 * message, and a message that misnames the cause is how an operator spends an
 * afternoon on the wrong thing.
 *
 * What this proves is narrow and worth stating: that the Access application is
 * actually in front of the hostname. It cannot prove the workers.dev URL is
 * shut — that origin has a different name, and if it is open it is open whether
 * or not this check passes. `provision` reads the rendered configuration for
 * that half.
 */
export const GATED_CHECKS = [
  {
    id: 'gated',
    path: '/',
    what: 'la preview est fermée aux requêtes non authentifiées',
    check(response) {
      // 401, 403 and any redirect are all "something stands in front of it".
      // 200 is the one answer that means nothing does.
      if (response.status === 200) {
        return 'répond 200 sans authentification : la preview est publique. Vérifiez que l\'application Access couvre ce nom d\'hôte, et que workers.dev est fermé.';
      }
      return null;
    },
  },
];

/**
 * Turn responses into verdicts.
 *
 * `notServed` says the verdict is about Cloudflare, not the shop: at least one
 * answer came from a name that leads to no Worker yet. It is what `runSmoke`
 * waits out, and never a pass.
 *
 * @param {Record<string, SmokeResponse>} responses by check id
 * @param {SmokeCheck[]} [checks]
 * @returns {{ ok: boolean, notServed: boolean, results: Array<{ id: string, path: string, what: string, severity: string, ok: boolean, status: number|null, message: string|null, notServed?: true }> }}
 */
export function evaluateSmoke(responses, checks = SMOKE_CHECKS) {
  const results = checks.map((check) => {
    const severity = check.severity ?? 'fail';
    const base = { id: check.id, path: check.path, what: check.what, severity };
    const response = responses[check.id];
    if (!response) return { ...base, ok: false, status: null, message: 'aucune réponse recueillie' };
    if (!response.ok) {
      // A request that never completed. Never a pass: the whole point of the
      // check is to stand between a broken deployment and the announcement that
      // it worked, and "we could not ask" is not "it is fine". Unreachable is a
      // hard failure even for a check that only warns when it answers — a
      // warning-level check that cannot be run has told us nothing.
      return { ...base, severity: 'fail', ok: false, status: null, message: response.error ?? 'requête impossible' };
    }
    // Before any check reads it, and a failure even where the check only
    // warns: like an unreachable site, it is an answer nobody in the shop gave.
    if (servedByCloudflare(response)) {
      return { ...base, severity: 'fail', ok: false, status: response.status, message: NOT_SERVED, notServed: true };
    }
    const verdict = check.check(response);
    // A check may lower its own severity for one answer — the shop that is
    // not installed yet — and never raise it.
    const message = typeof verdict === 'string' || verdict === null ? verdict : verdict.message;
    const lowered = verdict !== null && typeof verdict === 'object' && verdict.severity === 'warn' ? { severity: 'warn' } : {};
    const notServed = verdict !== null && typeof verdict === 'object' && verdict.notServed === true ? { notServed: true } : {};
    return { ...base, ...lowered, ok: message === null, status: response.status, message, ...notServed };
  });
  return {
    ok: results.every((result) => result.ok || result.severity === 'warn'),
    notServed: results.some((result) => result.notServed === true),
    results,
  };
}

/**
 * Fetch one path, without following the redirect.
 *
 * `redirect: 'manual'` because a redirect is the ANSWER for `/admin`: following
 * it would report the login page's 200 and turn the check that matters into one
 * that always passes.
 */
export async function fetchSmoke(url, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'shopctl-smoke' } });
    const body = (await response.text()).slice(0, BODY_LIMIT);
    return { ok: true, status: response.status, body, headers: Object.fromEntries(response.headers), error: null };
  } catch (error) {
    return { ok: false, status: null, body: '', headers: {}, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every check against one origin.
 *
 * While Cloudflare answers for the name instead of the Worker, and `waitMs`
 * allows it, the whole test runs again: a name being propagated answers from
 * some edges and not others (step 7 saw both in one run), so a check that
 * passed on one attempt says nothing about the next. Only that answer is
 * waited out. A shop that answers and is broken fails on the first attempt,
 * and an unreachable origin is not retried either: a wait would only delay
 * the failure the operator has to see.
 *
 * @param {string} origin e.g. https://minshop-atelier-staging.example.workers.dev
 */
export async function runSmoke(origin, {
  gated = false,
  checks = gated ? GATED_CHECKS : SMOKE_CHECKS,
  waitMs = 0,
  intervalMs = SMOKE_INTERVAL_MS,
  onWait = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...options
} = {}) {
  const deadline = Date.now() + waitMs;
  for (let attempts = 1; ; attempts += 1) {
    const responses = {};
    for (const check of checks) {
      responses[check.id] = await fetchSmoke(new URL(check.path, origin).toString(), options);
    }
    const verdict = evaluateSmoke(responses, checks);
    if (!verdict.notServed || Date.now() + intervalMs > deadline) return { origin, gated, attempts, ...verdict };
    onWait({ attempts, intervalMs, remainingMs: deadline - Date.now() });
    await sleep(intervalMs);
  }
}

/**
 * The origin a deployment ended up on, from wrangler's own output.
 *
 * Read rather than derived for workers.dev: that URL depends on the account's
 * subdomain, which is not in the manifest. Guessing it would smoke-test a URL
 * that may belong to nothing, and report a green deploy for a site nobody can
 * reach. (`shopctl deploy` takes a custom domain from the manifest instead,
 * which rendered it; this reads one only as a fallback.)
 *
 * Only the two shapes wrangler gives a deployment target count. Any other
 * https URL in the output — a documentation link in a warning — is not where
 * the shop is, and smoke-testing developers.cloudflare.com would fail a gated
 * preview for being public.
 */
export function originFromDeployOutput(output) {
  const text = String(output);
  const workersDev = text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
  if (workersDev) return new URL(workersDev).origin;
  // Listed bare, without a scheme: "  shop.example.fr (custom domain)".
  const custom = text.match(/^\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+) \(custom domain\b/im)?.[1];
  return custom ? `https://${custom.toLowerCase()}` : null;
}
