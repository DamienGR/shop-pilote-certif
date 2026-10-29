/**
 * Cloudflare's GraphQL Analytics API, read-only.
 *
 * Two commands ask it: `monitor` about one shop, `fleet usage` about the whole
 * shared account (ADR 0019). One function, so that both fail the same way and
 * both follow CLOUDFLARE_API_BASE_URL into the double.
 */
import { externalError } from './errors.mjs';

const GRAPHQL_PATH = '/graphql';
const DEFAULT_API = 'https://api.cloudflare.com/client/v4';

/**
 * One GraphQL request. The endpoint follows CLOUDFLARE_API_BASE_URL, the
 * variable wrangler itself honours, so a test (or a proxy) can stand in for
 * Cloudflare without a flag that production would also have to carry.
 */
export async function graphql(query, variables, token) {
  const base = (process.env.CLOUDFLARE_API_BASE_URL || DEFAULT_API).replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${base}${GRAPHQL_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw externalError('l\'API Analytics de Cloudflare est injoignable.', `Rien n'a été jugé : ${error?.cause?.code ?? error?.name ?? 'erreur réseau'}.`);
  }
  let document = null;
  try {
    document = await response.json();
  } catch {
    // Reported below with the status, which is the useful part.
  }
  // The errors' text is Cloudflare's and names fields, never a customer; it is
  // still cut short, because a log line is written, never forwarded.
  const errors = (document?.errors ?? []).map((error) => String(error?.message ?? '').slice(0, 200));
  if (!response.ok || errors.length > 0 || !document?.data) {
    throw externalError(
      `l'API Analytics a refusé la requête (HTTP ${response.status}).`,
      errors.length > 0 ? errors.join(' ; ') : 'Vérifiez que le jeton porte le droit « Account Analytics : Read ».',
    );
  }
  return document.data;
}
