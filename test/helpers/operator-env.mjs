/**
 * Every variable through which an operator's shell steers shopctl, emptied.
 *
 * The suites spawn shopctl with the environment they run in, and they run in
 * the operator's: `shopctl deploy` runs them through `npm run verify`, from a
 * shell that a certification sheet or a runbook has just filled. The account
 * id, then the backup key (certification step 8), reached the commands under
 * test that way and turned a passing suite red; the others are read the same
 * way. An empty value is how shopctl reads "not set" for each of them.
 */
export const OPERATOR_ENV = {
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_API_TOKEN: '',
  CLOUDFLARE_API_TOKEN_STAGING: '',
  CLOUDFLARE_API_TOKEN_PRODUCTION: '',
  CLOUDFLARE_API_TOKEN_BACKUP: '',
  CLOUDFLARE_API_TOKEN_MONITOR: '',
  SHOPS_READ_TOKEN: '',
  CLOUDFLARE_API_BASE_URL: '',
  MINSHOP_DOMAIN_SUFFIX: '',
  SHOPCTL_BACKUP_KEY: '',
  PAGESPEED_API_URL: '',
  PAGESPEED_API_KEY: '',
};
