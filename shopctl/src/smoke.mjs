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
 * @typedef {{ id: string, path: string, what: string, severity?: 'fail'|'warn', check: (response: SmokeResponse) => string|null }} SmokeCheck
 * @typedef {{ ok: boolean, status: number|null, body: string, headers: Record<string,string>, error: string|null }} SmokeResponse
 */

/** How much of a body a check reads. The storefront's <head> and the first
 *  markup are all any of these needs, and a full page of a 100-product
 *  catalogue is a megabyte nobody looks at. */
export const BODY_LIMIT = 64 * 1024;

/** @type {SmokeCheck[]} */
export const SMOKE_CHECKS = [
  {
    id: 'storefront',
    path: '/',
    what: 'la vitrine répond et se déclare française',
    check(response) {
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
      if (response.status !== 200) return `répond ${response.status ?? 'rien'} au lieu de 200 : la liaison D1 est le premier suspect`;
      return null;
    },
  },
  {
    id: 'robots',
    path: '/robots.txt',
    what: 'les fichiers de service sont servis',
    check(response) {
      if (response.status !== 200) return `répond ${response.status ?? 'rien'} au lieu de 200`;
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
 * @param {Record<string, SmokeResponse>} responses by check id
 * @param {SmokeCheck[]} [checks]
 * @returns {{ ok: boolean, results: Array<{ id: string, path: string, what: string, severity: string, ok: boolean, status: number|null, message: string|null }> }}
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
    const message = check.check(response);
    return { ...base, ok: message === null, status: response.status, message };
  });
  return {
    ok: results.every((result) => result.ok || result.severity === 'warn'),
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
 * @param {string} origin e.g. https://minshop-atelier-staging.example.workers.dev
 */
export async function runSmoke(origin, { gated = false, checks = gated ? GATED_CHECKS : SMOKE_CHECKS, ...options } = {}) {
  const responses = {};
  for (const check of checks) {
    responses[check.id] = await fetchSmoke(new URL(check.path, origin).toString(), options);
  }
  return { origin, gated, ...evaluateSmoke(responses, checks) };
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
