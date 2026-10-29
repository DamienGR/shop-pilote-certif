import type { D1Database } from '@cloudflare/workers-types';
import { getConfig } from '../../config';
import { getSetting } from './db';

/**
 * The store's name as a customer reads it: the one set in Admin → Réglages,
 * else the build-time `STORE_NAME` (rendered from the manifest's displayName).
 *
 * A storefront document has it already, in `Astro.locals.settings`. This is for
 * the paths the middleware's overlay does not reach — an API route, a provider
 * adapter, a notification sent behind a response — which read the build-time
 * value alone and so showed « Ma boutique » on a shop named in /admin/setup.
 */
export async function readStoreName(db: D1Database): Promise<string> {
  return (await getSetting(db, 'store_name')) || getConfig().storeName;
}
