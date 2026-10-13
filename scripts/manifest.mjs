/**
 * Reading client manifests off disk, and the checks that need more than the
 * file itself: does the theme exist in this tree, and does the fleet agree that
 * every resource name belongs to exactly one shop.
 *
 * manifest-schema.mjs decides whether ONE manifest is well-formed.
 * This module decides whether it fits the tree and the fleet around it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseManifestYaml } from './manifest-yaml.mjs';
import { RESOURCE_PREFIX, validateManifest } from './manifest-schema.mjs';
import { THEMES_DIR } from './themes.mjs';

/** Where a real shop keeps its manifest. Absent in the core repository —
 *  which is precisely how the tooling tells a shop clone from the core. */
export const CLIENT_MANIFEST = 'client/client.yaml';

/** The witness shops (plan §2.3). They live under test/ because in the core
 *  repository they are fixtures, not deployments: nothing provisions them. */
export const WITNESS_CLIENTS_DIR = 'test/fixtures/clients';

/** True when this tree is a generated shop rather than the core itself. */
export function isShopRepository(root = process.cwd()) {
  return existsSync(resolve(root, CLIENT_MANIFEST));
}

/** The core's own version, from package.json — the value a manifest's
 *  `coreVersion` is checked against. */
export function coreVersion(root = process.cwd()) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return pkg.version;
}

/**
 * The deployed environments of a shop, in the order they are promoted.
 *
 * Two, and no third: staging is where a change is proven and production is
 * where it is sold from (plan §5.3). A `preview` or `qa` environment would cost
 * a second set of real Cloudflare resources per shop and would be certified by
 * nothing — the campaign of §8 runs against staging.
 */
export const ENVIRONMENTS = ['staging', 'production'];

/**
 * Every Cloudflare resource of a shop, derived from one name.
 *
 * Derivation, not configuration. Letting a manifest name its D1 database
 * independently of its Worker buys nothing and costs the property the operator
 * relies on: that `<workerName>*` is the complete footprint of one shop,
 * and that destroy-cf.sh removes all of it (scripts/destroy-cf.sh keys on the
 * same suffixes).
 *
 * `env` qualifies the STEM rather than adding a suffix of its own, which is
 * what plan §5.3 names: `minshop-<slug>-<env>` and then `-db`, `-images`,
 * `-files`. One shop is still one name family, `<workerName>*` is still its
 * whole footprint, and both environments are inside it.
 *
 * Omitting `env` gives the unqualified family, and that is not a third
 * environment: it is the one the witness builds, the browser gate and local
 * development render, none of which ever reach an account. A deployed resource
 * always carries its environment, so an operator reading an account listing can
 * never mistake staging data for production data.
 */
export function resourceNames(manifest, { env = null } = {}) {
  if (env !== null && !ENVIRONMENTS.includes(env)) {
    throw new Error(`unknown environment "${env}"; expected one of: ${ENVIRONMENTS.join(', ')}.`);
  }
  const worker = env ? `${manifest.cloudflare.workerName}-${env}` : manifest.cloudflare.workerName;
  return {
    worker,
    database: `${worker}-db`,
    images: `${worker}-images`,
    files: `${worker}-files`,
    // Where the CI's backups are kept: private, in the shop's own jurisdiction
    // and on the shop's own account (ADR 0002, ADR 0004). No Worker binding
    // names it — the storefront has no reason to read its own backups.
    backups: `${worker}-backups`,
    sessions: `${worker}-session`,
  };
}

/**
 * The account one environment lives on, and the manifest field that names it.
 *
 * Two fields rather than one per environment, because the ordinary shop has
 * ONE account: `accountId` is it, for both. ADR 0015 is the exception that
 * needed a second — staging on the agency's account, production on the
 * client's, both live from the day the client starts entering content until
 * the agency copy is torn down. A single field there makes every production
 * command a disagreement between the manifest and the account it is meant for.
 *
 * The field travels with the id so that a refusal names the line to edit.
 */
export function environmentAccount(manifest, env) {
  const production = env === 'production' ? (manifest.cloudflare.productionAccountId ?? null) : null;
  if (production) return { id: production, field: 'cloudflare.productionAccountId' };
  return { id: manifest.cloudflare.accountId ?? null, field: 'cloudflare.accountId' };
}

/** Every manifest in this tree: the shop's own, plus the witness fixtures. */
export function discoverManifests(root = process.cwd()) {
  const files = [];
  if (isShopRepository(root)) files.push(CLIENT_MANIFEST);

  const dir = resolve(root, WITNESS_CLIENTS_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const candidate = join(dir, name, 'client.yaml');
      if (statSync(join(dir, name)).isDirectory() && existsSync(candidate)) {
        files.push(relative(root, candidate).split('\\').join('/'));
      }
    }
  }
  return files;
}

/**
 * Read and fully check one manifest.
 *
 * Never throws for a bad file: a syntax error is an error entry like any
 * other, so `config validate` can report every manifest in one pass instead of
 * dying on the first one.
 *
 * @returns {{ file: string, manifest: object|null, errors: Array<{ path: string, message: string, rule?: string }> }}
 */
export function loadManifest(file, { root = process.cwd(), core = coreVersion(root), checkTheme = true } = {}) {
  const path = resolve(root, file);
  let manifest;
  try {
    manifest = parseManifestYaml(readFileSync(path, 'utf8'), { file });
  } catch (error) {
    return { file, manifest: null, errors: [{ path: '(file)', message: error.message }] };
  }

  const { errors } = validateManifest(manifest, { coreVersion: core });
  if (errors.length === 0 && checkTheme) {
    const themeDir = resolve(root, THEMES_DIR, manifest.theme.id);
    if (!existsSync(themeDir)) {
      errors.push({
        path: 'theme.id',
        rule: 'theme-exists',
        message: `names "${manifest.theme.id}", which has no directory at ${THEMES_DIR}/${manifest.theme.id}. A shop whose theme is missing builds the wrong design or nothing at all.`,
      });
    }
  }

  // The parsed object is returned even when invalid: a report that can name
  // the shop is more useful than one that can only name the file.
  return { file, manifest, errors };
}

/**
 * Names two shops must never share.
 *
 * Isolation is a provisioning property (ADR 0001): nothing at runtime prevents
 * two manifests from pointing at the same D1 database, and if they ever did,
 * one shop's orders would land in another's. There is no query-level guard to
 * fall back on, so the guard has to be here, on the names, before provisioning
 * reads them.
 */
export function fleetIdentifiers(manifest) {
  const claims = [
    { kind: 'slug', env: null, value: manifest.client.slug },
    // Hostnames, both of them: a staging preview and another shop's production
    // domain colliding would put two shops on one name, and the one serving is
    // whichever deployed last.
    { kind: 'hostname', env: 'production', value: manifest.cloudflare.productionDomain },
    ...(manifest.cloudflare.stagingDomain
      ? [{ kind: 'hostname', env: 'staging', value: manifest.cloudflare.stagingDomain }]
      : []),
  ];
  // The deployed names too, and not as a formality: a suffix is a namespace
  // only if nothing else can land in it. A shop slugged `acme-staging` derives
  // `minshop-acme-staging-db`, which is exactly the staging database of the
  // shop slugged `acme` — two customers, one set of orders, and no runtime
  // separation to fall back on (ADR 0001). Claiming every environment's names
  // makes the collision a `config:validate` failure instead of a discovery.
  for (const env of [null, ...ENVIRONMENTS]) {
    const names = resourceNames(manifest, { env });
    claims.push(
      { kind: 'worker', env, value: names.worker },
      { kind: 'D1 database', env, value: names.database },
      { kind: 'images bucket', env, value: names.images },
      { kind: 'files bucket', env, value: names.files },
      { kind: 'backups bucket', env, value: names.backups },
      { kind: 'sessions KV', env, value: names.sessions },
    );
  }
  return claims;
}

/**
 * Identifiers claimed by more than one manifest.
 *
 * @param {Array<{ file: string, manifest: object }>} entries valid manifests only
 * @returns {Array<{ kind: string, value: string, files: string[] }>}
 */
export function detectFleetCollisions(entries) {
  const claims = new Map();
  for (const { file, manifest } of entries) {
    for (const { kind, value } of fleetIdentifiers(manifest)) {
      const key = `${kind}\u0000${value}`;
      if (!claims.has(key)) claims.set(key, { kind, value, files: [] });
      claims.get(key).files.push(file);
    }
  }
  return [...claims.values()].filter((claim) => claim.files.length > 1);
}

/** Slugs of every shop this tree describes, in manifest order. */
export function clientSlugs(cwd = process.cwd()) {
  return discoverManifests(cwd)
    .map((file) => loadManifest(file, { root: cwd }).manifest?.client?.slug)
    .filter(Boolean);
}

/** Substitute the template's `__…__` placeholders. Fails on a leftover: a
 *  placeholder the manifest cannot fill would otherwise reach Wrangler as a
 *  literal resource name. */
export function renderWrangler(template, substitutions) {
  let out = template;
  for (const [token, value] of Object.entries(substitutions)) out = out.split(token).join(value);
  const leftover = out.match(/__[A-Z_]+__/g);
  if (leftover) {
    throw new Error(`wrangler.template.jsonc has placeholders no manifest value fills: ${[...new Set(leftover)].join(', ')}`);
  }
  return out;
}

/** The `__…__` substitutions wrangler.template.jsonc expects for a shop.
 *  The database id is not a manifest value — provisioning learns it from
 *  Cloudflare — so callers pass the id they have, or the all-zero placeholder
 *  for a build that never talks to an account.
 *
 *  The jurisdiction is one of them because an R2 binding must repeat it: a
 *  bucket created in the `eu` jurisdiction is invisible to a binding that does
 *  not name it, and the Worker would boot with a bucket that answers 404 to
 *  everything rather than failing at deploy. ADR 0004 makes the jurisdiction a
 *  manifest value; this is where the runtime learns it. */
export function wranglerSubstitutions(manifest, { databaseId = '00000000-0000-0000-0000-000000000000', env = null } = {}) {
  const names = resourceNames(manifest, { env });
  // A custom domain and closing workers.dev are one decision, not two: a shop
  // reachable on two origins is one the merchant never advertised, indexed by
  // search engines and outside whatever sits in front of the real one.
  //
  // Production always has one. Staging has one only when the manifest names it,
  // and then for the opposite reason — not to publish the shop but to HIDE it.
  // A Cloudflare Access application binds to a hostname; the header it injects
  // is forgeable against a `*.workers.dev` origin, so an Access app protecting
  // a custom hostname is simply bypassed by the workers.dev URL. A staging
  // environment a client previews before launch is therefore gated only if it
  // has a hostname AND workers.dev is shut. Without `stagingDomain`, staging
  // keeps workers.dev, because that is then the only way to reach it at all.
  const host = environmentHost(manifest, env);
  const routes = host ? [{ pattern: host, custom_domain: true }] : [];
  const imagesDomain = manifest.cloudflare.imagesDomain ?? null;
  // The Access application in front of the staging hostname. Behind it, every
  // request carries an assertion, and the Worker refuses one it has no issuer
  // and audience to verify (src/features/auth/accessGate.ts) — so a gated
  // staging without these two answers 403 on /admin/setup before any password
  // exists. Empty everywhere else, which the gate reads as "no Access": only
  // staging is ever previewed behind one (ADR 0015).
  const access = env === 'staging' && host ? manifest.cloudflare : {};
  return {
    __NAME__: names.worker,
    __DB_NAME__: names.database,
    __DB_ID__: databaseId,
    __BUCKET__: names.images,
    __FILES_BUCKET__: names.files,
    __JURISDICTION__: manifest.cloudflare.jurisdiction,
    __WORKERS_DEV__: host ? 'false' : 'true',
    __ROUTES__: JSON.stringify(routes),
    // Empty is the ordinary case and never wrong: the storefront reads
    // `env.IMAGE_BASE_URL ?? ''` and serves images through the Worker, which is
    // slower and always correct.
    __IMAGE_BASE_URL__: imagesDomain ? `https://${imagesDomain}` : '',
    // The team NAME is the manifest value and the URL is written here, so no
    // manifest can point the JWT verifier at a key server that is not
    // Cloudflare's.
    __ACCESS_TEAM_DOMAIN__: access.stagingAccessTeam ? `https://${access.stagingAccessTeam}.cloudflareaccess.com` : '',
    __ACCESS_AUD__: access.stagingAccessAud ?? '',
  };
}

/**
 * The custom domain one environment is served on, or null when it is reached
 * through workers.dev. One answer for the route `wranglerSubstitutions()`
 * renders and for the origin `shopctl deploy` smoke-tests: wrangler lists a
 * custom domain without a scheme and announces no workers.dev URL once that
 * door is shut, so the deployed origin cannot be read back from its output.
 */
export function environmentHost(manifest, env) {
  if (env === 'production') return manifest.cloudflare.productionDomain;
  if (env === 'staging') return manifest.cloudflare.stagingDomain ?? null;
  return null;
}

/** Resolve a shop by slug among the manifests of this tree. */
export function findManifestBySlug(slug, { root = process.cwd() } = {}) {
  for (const file of discoverManifests(root)) {
    const loaded = loadManifest(file, { root });
    if (loaded.manifest?.client?.slug === slug) return loaded;
  }
  return null;
}

/**
 * The values that identify one shop, and that a core file therefore must not
 * contain.
 *
 * Only values a shop is free to choose. `cloudflare.jurisdiction` or
 * `client.currency` would match half the tree and mean nothing: the core is
 * allowed — required, even — to know that EU exists.
 */
export function clientNeedles(manifest) {
  return [
    manifest.client.slug,
    manifest.client.displayName,
    manifest.cloudflare.workerName,
    manifest.cloudflare.productionDomain,
    manifest.email.from,
  ];
}

/**
 * Client values found in core files, as a pure function of the text.
 *
 * The exit criterion of jalon 1 is that two shops build from one core with no
 * client condition in it. Two shops building proves nothing on its own if the
 * core happens to name one of them: the build stays green and the condition
 * surfaces on the third shop, in production, months later.
 *
 * @param {Array<{ file: string, manifest: object }>} shops valid manifests
 * @param {Array<{ path: string, text: string }>} files core-owned files only
 * @returns {Array<{ path: string, slug: string, value: string }>}
 */
export function findClientLeaks(shops, files) {
  const needles = shops.flatMap(({ manifest }) =>
    clientNeedles(manifest).map((value) => ({ value, slug: manifest.client.slug })),
  );
  const findings = [];
  for (const { path, text } of files) {
    for (const needle of needles) {
      if (text.includes(needle.value)) findings.push({ path, slug: needle.slug, value: needle.value });
    }
  }
  return findings;
}

export { RESOURCE_PREFIX };
