/**
 * The merchant's domain as a Cloudflare for SaaS custom hostname (ADR 0019).
 *
 * On the shared account the merchant's DNS zone stays with the merchant, so a
 * Workers custom domain — which needs the zone on the Worker's account — is
 * out of reach. The agency's SaaS zone serves the domain instead: the merchant
 * adds a CNAME to the zone's fallback origin, Cloudflare validates the
 * hostname and issues its certificate over HTTP, and a route on that zone
 * (rendered by `wranglerSubstitutions()`) sends it to this shop's Worker.
 *
 * Wrangler has no command for custom hostnames, so this is the one place
 * besides `monitor` where shopctl speaks to the Cloudflare API itself — with
 * the token, `CLOUDFLARE_API_TOKEN`, never a session: `wrangler login`'s OAuth
 * grant is not something a CLI should go and read out of wrangler's files.
 * `CLOUDFLARE_API_BASE_URL` points it at a double in the suites, as monitor's.
 */
import { externalError, preconditionError } from './errors.mjs';
import { saasZoneFor } from '../../scripts/manifest.mjs';

const DEFAULT_API = 'https://api.cloudflare.com/client/v4';

/** The rights the token needs, said wherever it is missing or refused. */
export const SAAS_TOKEN_RIGHTS =
  'Le jeton CLOUDFLARE_API_TOKEN doit porter, sur la zone SaaS, « Zone : Read » et « SSL and Certificates : Edit ».';

export const apiToken = () => process.env.CLOUDFLARE_API_TOKEN || null;

/** One call, answered by its `result` or refused with Cloudflare's own codes. */
async function api(method, path, { token, body } = {}) {
  const base = (process.env.CLOUDFLARE_API_BASE_URL ?? DEFAULT_API).replace(/\/$/, '');
  const what = `${method} ${path.split('?')[0]}`;
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw externalError(`l'API de Cloudflare est injoignable (${what}).`, `${error?.cause?.code ?? error?.name ?? 'erreur réseau'}.`);
  }
  let document = null;
  try {
    document = await response.json();
  } catch {
    // Reported below with the status, which is the useful part.
  }
  // Cloudflare's text names fields and hostnames, never a customer; it is still
  // cut short, because a log line is written, never forwarded.
  const errors = (document?.errors ?? []).map((error) => `${error?.code ?? ''} ${String(error?.message ?? '').slice(0, 200)}`.trim());
  if (!response.ok || document?.success === false) {
    throw externalError(`l'API de Cloudflare a refusé ${what} (HTTP ${response.status}).`, errors.length > 0 ? `${errors.join(' ; ')}. ${SAAS_TOKEN_RIGHTS}` : SAAS_TOKEN_RIGHTS);
  }
  return document?.result ?? null;
}

/** The zone of this name on this account, or null. */
export async function findZone(name, accountId, { token }) {
  const zones = await api('GET', `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(accountId)}`, { token });
  return (zones ?? []).find((zone) => zone.name === name) ?? null;
}

/**
 * The zone's fallback origin — what every merchant's CNAME points at — or null
 * when none can be read. A zone set up for SaaS has exactly one; a zone that
 * has none answers with an error, which here means "not set up", not "retry".
 */
export async function fallbackOrigin(zoneId, { token }) {
  try {
    const result = await api('GET', `/zones/${zoneId}/custom_hostnames/fallback_origin`, { token });
    return result?.origin ? { origin: result.origin, status: result.status ?? null } : null;
  } catch (error) {
    if (error?.kind !== 'external') throw error;
    return null;
  }
}

export async function findCustomHostname(zoneId, hostname, { token }) {
  const records = await api('GET', `/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`, { token });
  return (records ?? []).find((record) => record.hostname === hostname) ?? null;
}

/**
 * HTTP validation, for both the hostname and its certificate: once the
 * merchant's CNAME is in place there is nothing else for them to add. TLS 1.2
 * at least, as the zone's own default would not be guaranteed to say.
 */
export async function createCustomHostname(zoneId, hostname, { token }) {
  return api('POST', `/zones/${zoneId}/custom_hostnames`, {
    token,
    body: { hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } },
  });
}

export async function deleteCustomHostname(zoneId, id, { token }) {
  return api('DELETE', `/zones/${zoneId}/custom_hostnames/${id}`, { token });
}

/** What a custom hostname record says, in the few words the commands use. */
export function hostnameState(record) {
  const status = record?.status ?? null;
  const ssl = record?.ssl?.status ?? null;
  const errors = [
    ...(record?.verification_errors ?? []),
    ...(record?.ssl?.validation_errors ?? []).map((error) => error?.message ?? String(error)),
  ].map((error) => String(error).slice(0, 200));
  return { id: record?.id ?? null, status, ssl, active: status === 'active' && ssl === 'active', errors };
}

/** The one DNS record the merchant adds, as it is typed in their DNS. */
export function cnameInstruction(hostname, fallback, zoneName) {
  return `Dans le DNS du commerçant (chez son registrar, ou en DNS seul si sa zone est chez Cloudflare) : CNAME ${hostname} → ${fallback?.origin ?? `l'origine de repli de ${zoneName}`}. La validation et le certificat suivent seuls (validation HTTP).`;
}

/**
 * Where this environment's custom hostname lives, with the token to ask about
 * it, or null when the environment is not served through a SaaS zone.
 *
 * `required` says what a missing token means: a refusal for a command that
 * must write or must know (provision, deploy, destroy), a line saying what was
 * not checked for one that only previews.
 */
export async function locateHostname({ manifest, env, account, reporter, required }) {
  const zoneName = saasZoneFor(manifest, env);
  if (!zoneName) return null;
  const hostname = manifest.cloudflare.productionDomain;
  reporter.section(`Nom d'hôte du commerçant — ${hostname} par la zone ${zoneName}`);
  const token = apiToken();
  if (!token) {
    const message = 'CLOUDFLARE_API_TOKEN est absent : le nom d\'hôte du commerçant passe par l\'API de Cloudflare, que wrangler ne couvre pas.';
    if (required) throw preconditionError(message, SAAS_TOKEN_RIGHTS);
    reporter.todo(`${hostname} — non vérifié. ${message}`, SAAS_TOKEN_RIGHTS);
    return { hostname, zoneName, token: null, zone: null };
  }
  const zone = await findZone(zoneName, account.id, { token });
  if (!zone) {
    throw preconditionError(
      `la zone ${zoneName} n'est pas sur le compte ${account.name} (${account.id}).`,
      'cloudflare.saasZone nomme la zone SaaS du compte mutualisé (ADR 0019) : ajoutez-la au compte et activez-y Cloudflare for SaaS, ou corrigez le manifeste.',
    );
  }
  return { hostname, zoneName, token, zone };
}
