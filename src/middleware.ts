import { defineMiddleware } from 'astro:middleware';
import type { APIContext, MiddlewareNext } from 'astro';
import { env } from 'cloudflare:workers';
import { verifyAccessJwt } from './features/auth/access';
import { accessGateDecision } from './features/auth/accessGate';
import { verifySession } from './features/auth/session';
import { adminCredential } from './features/auth/admin';
import {
  getStoreSettings,
  parseStoreSettings,
  STORE_SETTINGS_SQL,
} from './features/settings/db';
import {
  MENU_ITEMS_SQL,
  EMPTY_MENUS,
  groupMenus,
  type MenuItemRow,
} from './features/navigation/db';
import {
  checkRateLimit,
  rateLimitBucket,
  rateLimitedResponse,
} from './features/auth/rateLimit';
import {
  responseCacheControl,
} from './features/cache/public';
import { addCacheTags, responseCacheTags } from './features/cache/tags';
import { normalizeSearchQuery } from './features/search/query';
import { isForbiddenFormOrigin } from './features/auth/formOrigin';
import { logSafe } from './features/observability/logSafe.ts';
import { t } from './features/i18n';
import {
  SECURITY_HEADERS,
  DEFAULT_REFERRER_POLICY,
} from './features/http/securityHeaders.ts';

/**
 * Admin auth gate. Protects BOTH the admin UI (`/admin/*`) and the admin API
 * (`/api/admin/*`) — the API is a separate path, so gating only `/admin` would
 * leave the mutation endpoints open.
 *
 * Precedence:
 *   1. Local dev (`astro dev`) → always allowed (no Access in front of localhost).
 *   2. Admin password set in D1 (via the setup wizard) → form login at
 *      `/admin/login` (password + optional Turnstile) that issues a signed session
 *      cookie; protected requests without a valid cookie are redirected to the
 *      login form (APIs get 401).
 *   3. Cloudflare Access assertion present → ALWAYS verify the JWT signature
 *      against the team JWKS (forge-proof, even against direct *.workers.dev
 *      hits). Access mode REQUIRES CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD; without
 *      both, an assertion is rejected (403) rather than trusted — a bare header is
 *      forgeable at the public origin, so trust-on-presence is a bypass.
 *   4. BOOTSTRAP (first run): no password yet and no Access → the setup wizard
 *      (`/admin/setup`) is OPEN so the operator can create the password; the rest
 *      of /admin bounces there. The wizard auto-logs-you-in on save, which trips
 *      step 2 and closes the window. Set the password promptly, or front /admin
 *      with Access, on a public deploy.
 *
 * Cloudflare Access is the recommended production protection (edge SSO/MFA); the
 * wizard-set password is the built-in alternative. See README → Admin auth. JWT
 * verification lives in features/auth/access.ts; session signing in
 * features/auth/session.ts.
 */
function isProtected(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

async function gate(context: APIContext, next: MiddlewareNext): Promise<Response> {
  // Runtime settings overlay (store name etc.) — only for HTML page requests, so
  // the storefront/admin can reflect wizard-set values without a redeploy. APIs and
  // static assets skip it (one indexed D1 read per page, not per asset/API call).
  const path = context.url.pathname;
  const isDocument =
    !path.startsWith('/api/') &&
    !path.startsWith('/_') &&
    !path.startsWith('/partials/');
  if (isDocument) {
    // Storefront documents also need the header/footer menus. Both reads go in
    // ONE batch so /cart, /checkout, /account, /order, and /pay — which are never
    // edge-cached — don't pay a second D1 round trip.
    const wantsMenus = !path.startsWith('/admin');
    try {
      if (wantsMenus) {
        const [settings, menus] = await env.DB.batch<Record<string, string>>([
          env.DB.prepare(STORE_SETTINGS_SQL),
          env.DB.prepare(MENU_ITEMS_SQL),
        ]);
        context.locals.settings = parseStoreSettings(
          (settings.results ?? []) as Array<{ key: string; value: string }>,
        );
        context.locals.menus = groupMenus(
          (menus.results ?? []) as unknown as MenuItemRow[],
          context.locals.settings.homePage,
        );
      } else {
        context.locals.settings = await getStoreSettings(env.DB);
      }
    } catch {
      // A batch is all-or-nothing, so a missing `menu_items` table (pre-migration)
      // would take settings down with it — and losing settings silently
      // disables the first-run setup funnel below. Retry settings alone.
      // Empty menus render a bare header and a copyright-only footer: degraded
      // but navigable. Losing settings is not.
      try {
        context.locals.settings = await getStoreSettings(env.DB);
        context.locals.menus = EMPTY_MENUS;
      } catch {
        // Settings table missing too → fall back to build-time defaults.
      }
    }
  }

  // First-run funnel: until the setup wizard is finished, send the STOREFRONT to it
  // too — the admin already redirects /admin → /admin/setup the same way. Skips
  // /admin (its own gate), /api, and assets to avoid loops; only fires once settings
  // loaded and setup_complete isn't set.
  if (
    isDocument &&
    !path.startsWith('/admin') &&
    context.locals.settings &&
    !context.locals.settings.setupComplete
  ) {
    return context.redirect('/admin/setup', 302);
  }

  // Throttle anonymous, resource-spending mutations and cache-missing searches.
  // Webhooks are excluded: providers retry them and signatures are verified.
  const bucket = rateLimitBucket(
    context.request.method,
    path,
    normalizeSearchQuery(context.url.searchParams.get('q') ?? '') !== '',
  );
  if (bucket) {
    const limiter =
      bucket === 'auth'
        ? env.AUTH_RATE_LIMITER
        : bucket === 'checkout'
          ? env.CHECKOUT_RATE_LIMITER
          : env.SEARCH_RATE_LIMITER;
    try {
      if (!(await checkRateLimit(limiter, context.request, path))) {
        console.warn(JSON.stringify({ event: 'rate_limited', bucket, path }));
        return rateLimitedResponse(path);
      }
    } catch (error) {
      // A limiter outage must not make checkout or login unavailable. Binding
      // failures remain visible in Workers Logs for operational follow-up.
      console.error(
        JSON.stringify({
          event: 'rate_limit_error',
          bucket,
          path,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  if (!isProtected(context.url.pathname)) return next();

  // 1. Localhost dev has no Access edge — don't lock yourself out.
  if (import.meta.env.DEV) return next();

  // 2. Steady state: an admin password is set (via the setup wizard) → require a
  //    valid signed session. Checked before the Access header so it can't be
  //    bypassed by forging it.
  const cred = await adminCredential(env.DB);
  if (cred.enabled) {
    // The login page itself must be reachable unauthenticated (to log in).
    if (path === '/admin/login') return next();
    const session = context.cookies.get('admin_session')?.value ?? null;
    // Sign/verify with AUTH_SECRET (high-entropy key); the credential is the bound tag.
    const signingKey = env.AUTH_SECRET || cred.tagSource;
    if (await verifySession(session, signingKey, cred.tagSource, Date.now() / 1000)) return next();
    // Not authenticated: humans go to the login form, API callers get 401.
    if (path.startsWith('/api/')) {
      return new Response(t('admin.shell.gate.authRequired'), { status: 401 });
    }
    return context.redirect('/admin/login', 303);
  }

  // 3. Cloudflare Access. The edge injects a signed JWT into the origin request.
  //    We ALWAYS verify its signature (against the team JWKS) — the header is
  //    otherwise trivially forgeable against the public *.workers.dev origin,
  //    which bypasses the edge Access app bound to your custom hostname. So
  //    Access mode REQUIRES CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD; without both we
  //    fail closed rather than trust an unverifiable header.
  const access = accessGateDecision(
    context.request.headers.get('Cf-Access-Jwt-Assertion'),
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD,
  );
  if (access.action === 'deny') {
    return new Response(access.message, { status: 403 });
  }
  if (access.action === 'verify') {
    let identity = null;
    try {
      identity = await verifyAccessJwt(access.token, {
        teamDomain: access.teamDomain,
        aud: access.aud,
      });
    } catch {
      identity = null; // JWKS unreachable etc. → fail closed
    }
    if (identity) {
      context.locals.adminEmail = identity.email;
      return next();
    }
    return new Response(t('admin.shell.gate.invalidAccessToken'), { status: 403 });
  }

  // 4. Bootstrap (first run): no admin password and no Access configuration. The
  //    setup wizard is open so the operator can create the password — which trips
  //    step 2 and locks the door. Everything else under /admin bounces to setup;
  //    admin APIs get 401. (Set the password promptly, or front /admin with
  //    Cloudflare Access, to close this window. See README → Admin auth.)
  if (path === '/admin/setup') return next();
  if (path.startsWith('/api/')) {
    return new Response(t('admin.shell.gate.notSetUp'), { status: 401 });
  }
  return context.redirect('/admin/setup', 303);
}

async function route(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const path = context.url.pathname;
  const productError = path.startsWith('/products/') && context.url.searchParams.has('error');

  let response = isForbiddenFormOrigin(context.request, context.url)
    ? new Response(`Cross-site ${context.request.method} form submissions are forbidden`, {
        status: 403,
      })
    : await gate(context, next);

  // Workers Caching heuristically stores headerless responses, so make every
  // response explicit: only allowlisted public successes/301s are shared.
  const cacheControl = responseCacheControl(
    path,
    response.status,
    response.headers.get('cache-control'),
    productError,
  );
  if (response.headers.get('cache-control') !== cacheControl) {
    try {
      response.headers.set('cache-control', cacheControl);
    } catch {
      // Redirect responses can have immutable headers.
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      response.headers.set('cache-control', cacheControl);
    }
  }

  const cacheTags = responseCacheTags(path, response.status);
  if (cacheTags.length > 0) {
    try {
      addCacheTags(response.headers, cacheTags);
    } catch {
      // A route-specific response can have immutable headers even when its
      // Cache-Control already matched. Rebuild before adding purge metadata.
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      addCacheTags(response.headers, cacheTags);
    }
  }

  return response;
}

/** Add the security headers, rebuilding when the response's headers are immutable
 *  (e.g. a Response.redirect to a payment provider, or a Cache API hit). */
function withSecurityHeaders(res: Response): Response {
  const apply = (target: Response): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) target.headers.set(k, v);
    if (!target.headers.has('referrer-policy')) {
      target.headers.set('referrer-policy', DEFAULT_REFERRER_POLICY);
    }
  };
  try {
    apply(res);
    return res;
  } catch {
    const rebuilt = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    });
    apply(rebuilt);
    return rebuilt;
  }
}

/**
 * The response an unhandled error becomes.
 *
 * Everything above — the cache-control allowlist, the purge tags, the security
 * headers — describes responses this middleware RETURNS. A throw returns
 * nothing: Astro catches it further out and answers with a bare 500 that has
 * been through none of it. That is the one response class that left without
 * `no-store`, on a platform whose cache heuristically stores a headerless
 * response, and without the headers every other response carries.
 *
 * So the throw is caught here, at the same place the rest of the contract is
 * applied. The body says nothing about the failure: what an operator needs is
 * in the log line, and what a stack trace would give an attacker is a map of
 * the code. `logSafe` because an error raised while handling a customer's order
 * can carry the customer in it.
 */
function serverError(path: string, error: unknown): Response {
  console.error(JSON.stringify({ event: 'unhandled_error', path, message: logSafe(error) }));
  const api = path.startsWith('/api/');
  return new Response(api ? JSON.stringify({ error: 'Internal error.' }) : 'Internal error.', {
    status: 500,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  let response: Response;
  try {
    response = await route(context, next);
  } catch (error) {
    // Not under `astro dev`: there, the throw belongs to Astro's error overlay,
    // which is how the failure gets read at all. Swallowing it into a silent
    // "Internal error." would trade a debuggable stack for a gate that already
    // runs against the built Worker.
    if (import.meta.env.DEV) throw error;
    response = serverError(context.url.pathname, error);
  }
  return withSecurityHeaders(response);
});
