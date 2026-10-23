import { describe, expect, it } from 'vitest';

// Deliberately .mjs, not .ts, for the same reason as the other tests in this
// directory: tsconfig's `types` is pinned to the Cloudflare types, so node
// builtins have no declarations and a .ts file here fails `astro check`.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { parseManifestYaml } from '../../scripts/manifest-yaml.mjs';
import {
  CROSS_FIELD_RULES,
  MANIFEST_SPEC,
  RESERVED_SLUGS,
  SCHEMA_VERSION,
  checkCoreCompatibility,
  manifestFieldPaths,
  manifestJsonSchema,
  validateManifest,
} from '../../scripts/manifest-schema.mjs';
import {
  coreVersion,
  detectFleetCollisions,
  discoverManifests,
  environmentAccount,
  isShopRepository,
  loadManifest,
  renderWrangler,
  resourceNames,
  wranglerSubstitutions,
} from '../../scripts/manifest.mjs';
import { isValidThemeId } from '../../scripts/themes.mjs';

const root = new URL('../../', import.meta.url).pathname;
const fixture = (slug) => `test/fixtures/clients/${slug}/client.yaml`;
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** A valid manifest to mutate. Parsed from the shipped fixture rather than
 *  written inline: a test that invents its own valid shape stops noticing the
 *  day the fixture drifts away from the schema. */
const base = () => parseManifestYaml(read(fixture('pilot-fr')), { file: 'pilot-fr' });

const messages = (result) => result.errors.map((e) => `${e.path} ${e.message}`).join('\n');

describe('manifest YAML reader', () => {
  it('reads the manifest shape: nested sections, scalars, comments', () => {
    const parsed = base();
    expect(parsed.schemaVersion).toBe(1);
    // The core's own version, not a literal: the witness fixtures are bumped at
    // every release (scripts/release.mjs keeps the three places in step), and a
    // number written here would fail on the release rather than on the reader.
    expect(parsed.coreVersion).toBe(coreVersion());
    expect(parsed.client.slug).toBe('pilot-fr');
    expect(parsed.commerce.pricesIncludeTax).toBe(true);
    expect(parsed.commerce.defaultVatRate).toBe(20);
    // The trailing comment on the theme line is not part of the value.
    expect(parsed.theme.id).toBe('atelier');
  });

  it('keeps a # inside quotes and drops one that starts a comment', () => {
    const parsed = parseManifestYaml('a: "lot #3"  # a comment\nb: plain\n');
    expect(parsed).toEqual({ a: 'lot #3', b: 'plain' });
  });

  // The Norway problem: a full YAML 1.1 reader turns `NO` into false. Reading
  // it as the string would disagree with every editor plugin looking at the
  // same file, so neither reading is offered.
  it.each(['no', 'NO', 'yes', 'off', 'null', '~'])('refuses the ambiguous bare word %s', (word) => {
    expect(() => parseManifestYaml(`market: ${word}\n`)).toThrow(/different YAML readers resolve differently/);
  });

  it.each([
    ['a sequence', 'items:\n  - one\n', /sequence/],
    ['an anchor', 'a: &ref value\n', /anchor/],
    ['a flow mapping', 'a: { b: c }\n', /flow mapping/],
    ['a block scalar', 'a: |\n  text\n', /block scalar/],
    ['a document marker', '---\na: b\n', /document marker/],
    ['a tab', 'a:\n\tb: c\n', /tab/],
    ['an odd indent', 'a:\n   b: c\n', /indents 2 spaces per level/],
  ])('refuses %s', (_label, text, pattern) => {
    expect(() => parseManifestYaml(text)).toThrow(pattern);
  });

  // A repeated key is the one malformed input a permissive reader accepts
  // silently, and it discards the value the author most likely meant.
  it('refuses a repeated key and names both lines', () => {
    expect(() => parseManifestYaml('client:\n  slug: a\n  slug: b\n')).toThrow(/"client.slug" is set twice \(first at line 2\)/);
  });

  it('reports the line number of a syntax error', () => {
    expect(() => parseManifestYaml('a: 1\nb 2\n', { file: 'client.yaml' })).toThrow(/^client\.yaml:2:/);
  });
});

describe('manifest schema', () => {
  it('accepts both witness manifests as shipped', () => {
    for (const slug of ['pilot-fr', 'canary-minimal']) {
      const result = loadManifest(fixture(slug), { root });
      expect(messages(result.errors.length ? result : { errors: [] })).toBe('');
      expect(result.errors).toEqual([]);
    }
  });

  it('refuses an unknown field, wherever it sits', () => {
    const root = validateManifest({ ...base(), stripeKey: 'x' });
    expect(root.ok).toBe(false);
    expect(messages(root)).toMatch(/stripeKey is not a field of the manifest/);

    const nested = base();
    nested.client.lang = 'fr';
    expect(messages(validateManifest(nested))).toMatch(/client\.lang is not a field of client/);
  });

  it('refuses a missing field and says what it is for', () => {
    const m = base();
    delete m.cloudflare.jurisdiction;
    expect(messages(validateManifest(m))).toMatch(/cloudflare\.jurisdiction is required \(D1 and R2 jurisdiction/);
  });

  // Every one of these becomes a directory name, a resource name, and a URL
  // component. A slug that escaped the pattern would escape all three.
  it.each([
    ['a traversal', '../etc'],
    ['a slash', 'pilot/fr'],
    ['a leading dash', '-pilot'],
    ['a trailing dash', 'pilot-'],
    ['a double dash', 'pilot--fr'],
    ['uppercase', 'Pilot'],
    ['a space', 'pilot fr'],
    ['a dot', 'pilot.fr'],
    ['unicode', 'boutiqué'],
    ['too short', 'ab'],
  ])('refuses %s as a slug', (_label, slug) => {
    const m = base();
    m.client.slug = slug;
    m.cloudflare.workerName = `minshop-${slug}`;
    expect(validateManifest(m).ok).toBe(false);
  });

  it.each(RESERVED_SLUGS)('refuses the reserved slug %s', (slug) => {
    const m = base();
    m.client.slug = slug;
    m.cloudflare.workerName = `minshop-${slug}`;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === 'slug-not-reserved')).toBe(true);
  });

  it('requires the worker name to follow the slug', () => {
    const m = base();
    m.cloudflare.workerName = 'minshop-something-else';
    const result = validateManifest(m);
    expect(result.errors[0].rule).toBe('worker-name-follows-slug');
    expect(messages(result)).toMatch(/makes it "minshop-pilot-fr"/);
  });

  it.each([
    ['customer accounts under guest checkout', (m) => { m.features.customerAccounts = true; }, 'guest-checkout-has-no-accounts'],
    ['tax-exclusive prices on the French market', (m) => { m.commerce.pricesIncludeTax = false; }, 'french-prices-include-tax'],
    ['an out-of-scope feature', (m) => { m.features.semanticSearch = true; }, 'out-of-scope-features-off'],
    ['a platform subdomain in production', (m) => { m.cloudflare.productionDomain = 'pilot-fr.workers.dev'; }, 'production-domain-is-custom'],
  ])('refuses %s', (_label, mutate, rule) => {
    const m = base();
    mutate(m);
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.rule)).toContain(rule);
  });

  // Closing the schema stops an invented `stripeKey:`; this catches the other
  // shape, a credential pasted into a field that IS allowed.
  it.each([
    ['a Stripe key', 'sk_live_51HxxxxxxxxxxxxxxxxYY'], // secret-scan:ignore — a shape, not a key
    ['a webhook secret', 'whsec_abcdefghijklmnop'],
    ['a Resend key', 're_abcdefghijklmnopqrstu'],
  ])('refuses %s in an allowed field', (_label, secret) => {
    const m = base();
    m.client.displayName = `Boutique ${secret}`;
    const result = validateManifest(m);
    expect(result.errors.map((e) => e.rule)).toContain('no-credentials');
  });

  // The Worker refuses every assertion when only one of the two is set, so a
  // half-declared application would lock the staging admin rather than guard it.
  it.each([
    ['an Access team without its audience', (m) => { delete m.cloudflare.stagingAccessAud; }, 'cloudflare.stagingAccessAud'],
    ['an Access audience without its team', (m) => { delete m.cloudflare.stagingAccessTeam; }, 'cloudflare.stagingAccessTeam'],
  ])('refuses %s', (_label, mutate, path) => {
    const m = base();
    mutate(m);
    const result = validateManifest(m);
    expect(result.errors).toContainEqual(expect.objectContaining({ rule: 'staging-access-is-complete', path }));
  });

  it('refuses an Access application with no staging hostname to bind to', () => {
    const m = base();
    delete m.cloudflare.stagingDomain;
    expect(validateManifest(m).errors.map((e) => e.rule)).toContain('staging-access-needs-staging-domain');
  });

  // The team is one DNS label because the core writes the rest of the URL:
  // a value cannot send the JWT verifier to a key server of its choosing.
  it.each([
    ['a URL', 'https://evil.example.com'],
    ['a dotted name', 'evil.example'],
    ['uppercase', 'Pilote'],
  ])('refuses %s as an Access team', (_label, team) => {
    const m = base();
    m.cloudflare.stagingAccessTeam = team;
    expect(validateManifest(m).errors).toContainEqual(expect.objectContaining({ path: 'cloudflare.stagingAccessTeam' }));
  });

  // An AUD is 64 hex characters — the exact shape the credential rule refuses.
  // It is exempted by PATH: the same characters anywhere else are still a key.
  // Asked of the rule itself: no other field of a valid manifest can hold 64
  // characters of that shape, so the structural check would answer first.
  it('accepts an AUD in its own field and nowhere else', () => {
    expect(validateManifest(base()).ok).toBe(true);
    const rule = CROSS_FIELD_RULES.find((r) => r.id === 'no-credentials');
    const aud = base().cloudflare.stagingAccessAud;
    expect(rule.check({ cloudflare: { stagingAccessAud: aud } })).toBeNull();
    expect(rule.check({ cloudflare: { stagingDomain: aud } })).toMatchObject({ path: 'cloudflare.stagingDomain' });
  });

  it('reports structural errors before cross-field rules', () => {
    // A rule reading m.client.slug on a manifest with no client section would
    // report a second failure for the same cause.
    const result = validateManifest({ schemaVersion: 1 });
    expect(result.errors.every((e) => e.rule === undefined)).toBe(true);
  });
});

describe('core compatibility', () => {
  it('accepts a manifest at the core version', () => {
    expect(checkCoreCompatibility('0.1.0', '0.1.0')).toBeNull();
  });

  it('accepts an older patch of the same pre-1.0 minor', () => {
    expect(checkCoreCompatibility('0.1.0', '0.1.4')).toBeNull();
  });

  // Before 1.0 a minor bump is the breaking one, which is the accurate reading
  // while the migration notes of plan §9 do not exist yet.
  it('refuses a different pre-1.0 minor', () => {
    expect(checkCoreCompatibility('0.1.0', '0.2.0').message).toMatch(/does not support/);
  });

  it('accepts any older minor once the core is stable', () => {
    expect(checkCoreCompatibility('1.0.0', '1.4.2')).toBeNull();
    expect(checkCoreCompatibility('1.0.0', '2.0.0').message).toMatch(/does not support/);
  });

  // Drift the other way: the manifest arrived without the code it describes.
  it('refuses a manifest ahead of its core', () => {
    expect(checkCoreCompatibility('0.2.0', '0.1.0').message).toMatch(/ahead of the code/);
  });

  it('holds the witness fixtures to the core version in package.json', () => {
    for (const slug of ['pilot-fr', 'canary-minimal']) {
      const m = parseManifestYaml(read(fixture(slug)), { file: slug });
      expect(checkCoreCompatibility(m.coreVersion, coreVersion(root))).toBeNull();
    }
  });
});

describe('fleet identifiers', () => {
  it('derives every resource name from the worker name', () => {
    expect(resourceNames(base())).toEqual({
      worker: 'minshop-pilot-fr',
      database: 'minshop-pilot-fr-db',
      images: 'minshop-pilot-fr-images',
      files: 'minshop-pilot-fr-files',
      backups: 'minshop-pilot-fr-backups',
      sessions: 'minshop-pilot-fr-session',
    });
  });

  it('renders the wrangler substitutions from the manifest alone', () => {
    expect(wranglerSubstitutions(base())).toEqual({
      __NAME__: 'minshop-pilot-fr',
      __DB_NAME__: 'minshop-pilot-fr-db',
      __DB_ID__: '00000000-0000-0000-0000-000000000000',
      __BUCKET__: 'minshop-pilot-fr-images',
      __FILES_BUCKET__: 'minshop-pilot-fr-files',
      __JURISDICTION__: 'eu',
      // No environment named, so: no custom domain, workers.dev on, images
      // through the Worker. That is the render a witness build and local
      // development get, and none of them reaches an account.
      __WORKERS_DEV__: 'true',
      __ROUTES__: '[]',
      __IMAGE_BASE_URL__: '',
      // pilot-fr declares an Access application, and it is still absent here:
      // only the staging render carries it.
      __ACCESS_TEAM_DOMAIN__: '',
      __ACCESS_AUD__: '',
      __STORE_NAME__: 'Boutique Pilote',
    });
  });

  // The setup wizard proposes STORE_NAME, and it read "Ma boutique" on the
  // first production of the certification (step 9): the template wrote the
  // core's placeholder, and the manifest's name never reached it.
  it('gives the store the name the manifest declares, as a JSON string', () => {
    const named = base();
    named.client.displayName = 'L’atelier "Côté \\ jardin"';
    const rendered = renderWrangler(read('wrangler.template.jsonc'), wranglerSubstitutions(named));
    const literal = rendered.match(/"STORE_NAME": ("(?:[^"\\]|\\.)*")/)?.[1];
    expect(literal && JSON.parse(literal)).toBe('L’atelier "Côté \\ jardin"');
  });

  // A display name is free text. One that happens to read like a placeholder
  // is still a value, not a token the template forgot to fill.
  it('renders a display name that looks like a placeholder', () => {
    const named = base();
    named.client.displayName = 'Boutique __NOM__';
    const rendered = renderWrangler(read('wrangler.template.jsonc'), wranglerSubstitutions(named));
    expect(rendered).toContain('"STORE_NAME": "Boutique __NOM__"');
  });

  /**
   * The custom domain is production's, and workers.dev goes off with it.
   *
   * Two doors into one shop is an origin the merchant never advertised: indexed
   * by search engines, outside whatever Access sits on the real hostname, and
   * serving the same database. Staging keeps workers.dev because that is how
   * staging is reached at all.
   */
  it('gives production its domain and closes workers.dev', () => {
    expect(wranglerSubstitutions(base(), { env: 'production' })).toMatchObject({
      __WORKERS_DEV__: 'false',
      __ROUTES__: JSON.stringify([{ pattern: 'pilote.example.fr', custom_domain: true }]),
    });
    const open = base();
    delete open.cloudflare.stagingDomain;
    expect(wranglerSubstitutions(open, { env: 'staging' })).toMatchObject({ __WORKERS_DEV__: 'true', __ROUTES__: '[]' });
  });

  // Empty is the ordinary case and never wrong: the storefront reads
  // `env.IMAGE_BASE_URL ?? ''` and serves images through the Worker, which is
  // slower and always correct.
  it('serves images from the Worker unless the manifest names a domain', () => {
    expect(wranglerSubstitutions(base(), { env: 'production' }).__IMAGE_BASE_URL__).toBe('');
    const withDomain = base();
    withDomain.cloudflare.imagesDomain = 'images.example.fr';
    expect(wranglerSubstitutions(withDomain, { env: 'production' }).__IMAGE_BASE_URL__).toBe('https://images.example.fr');
  });

  // The domain is attached to production's images bucket. Named in a staging
  // or a local render, it would serve production's objects there — and a
  // broken image for every one uploaded anywhere else.
  it('names the images domain in the production render only', () => {
    const withDomain = base();
    withDomain.cloudflare.imagesDomain = 'images.example.fr';
    expect(wranglerSubstitutions(withDomain, { env: 'staging' }).__IMAGE_BASE_URL__).toBe('');
    expect(wranglerSubstitutions(withDomain).__IMAGE_BASE_URL__).toBe('');
  });

  // Plan §5.3 names them `minshop-{slug}-{env}…`. The environment qualifies the
  // STEM, so one shop is still one name family and an account listing sorts a
  // shop's staging and production resources next to each other.
  it('qualifies every name with the environment', () => {
    expect(resourceNames(base(), { env: 'staging' })).toEqual({
      worker: 'minshop-pilot-fr-staging',
      database: 'minshop-pilot-fr-staging-db',
      images: 'minshop-pilot-fr-staging-images',
      files: 'minshop-pilot-fr-staging-files',
      backups: 'minshop-pilot-fr-staging-backups',
      sessions: 'minshop-pilot-fr-staging-session',
    });
  });

  it('refuses an environment the fleet does not have', () => {
    expect(() => resourceNames(base(), { env: 'preprod' })).toThrow(/unknown environment/);
  });

  // The R2 binding has to repeat the jurisdiction or the deployed Worker binds
  // a bucket that answers as if it were empty — a failure with no error.
  it('carries the jurisdiction into the environment\u2019s render', () => {
    expect(wranglerSubstitutions(base(), { env: 'production' })).toMatchObject({
      __NAME__: 'minshop-pilot-fr-production',
      __FILES_BUCKET__: 'minshop-pilot-fr-production-files',
      __JURISDICTION__: 'eu',
    });
  });

  it('sees no shared identifier among the shops of this tree', () => {
    const entries = discoverManifests(root).map((file) => loadManifest(file, { root }));
    expect(entries.flatMap((e) => e.errors)).toEqual([]);
    expect(detectFleetCollisions(entries)).toEqual([]);
  });

  // Nothing at runtime keeps two shops' data apart (ADR 0001). A duplicated
  // D1 name is one provisioning run away from one shop's orders landing in
  // another's, so the names are where it has to be caught.
  it('detects a duplicated resource across two manifests', () => {
    const a = { file: 'a.yaml', manifest: base() };
    const b = { file: 'b.yaml', manifest: base() };
    const collisions = detectFleetCollisions([a, b]);
    expect(collisions.map((c) => c.value)).toEqual([
      'pilot-fr',
      'pilote.example.fr',
      'preview-pilote.example.fr',
      'minshop-pilot-fr',
      'minshop-pilot-fr-db',
      'minshop-pilot-fr-images',
      'minshop-pilot-fr-files',
      'minshop-pilot-fr-backups',
      'minshop-pilot-fr-session',
      'minshop-pilot-fr-staging',
      'minshop-pilot-fr-staging-db',
      'minshop-pilot-fr-staging-images',
      'minshop-pilot-fr-staging-files',
      'minshop-pilot-fr-staging-backups',
      'minshop-pilot-fr-staging-session',
      'minshop-pilot-fr-production',
      'minshop-pilot-fr-production-db',
      'minshop-pilot-fr-production-images',
      'minshop-pilot-fr-production-files',
      'minshop-pilot-fr-production-backups',
      'minshop-pilot-fr-production-session',
    ]);
    expect(collisions[0].files).toEqual(['a.yaml', 'b.yaml']);
  });

  // A suffix is a namespace only if nothing else can land in it. `acme-staging`
  // derives exactly the staging family of `acme`, and nothing at runtime would
  // keep the two shops' orders apart (ADR 0001).
  it('detects a slug that collides with another shop\u2019s environment', () => {
    const a = { file: 'acme.yaml', manifest: base() };
    a.manifest.client.slug = 'ceramics';
    a.manifest.cloudflare.workerName = 'minshop-ceramics';
    const b = { file: 'staging.yaml', manifest: base() };
    b.manifest.client.slug = 'ceramics-staging';
    b.manifest.cloudflare.workerName = 'minshop-ceramics-staging';
    b.manifest.cloudflare.productionDomain = 'autre.example.fr';
    expect(detectFleetCollisions([a, b]).map((c) => c.value)).toContain('minshop-ceramics-staging-db');
  });

  it('detects a shared production domain between otherwise distinct shops', () => {
    const a = { file: 'a.yaml', manifest: base() };
    const b = { file: 'b.yaml', manifest: base() };
    b.manifest.client.slug = 'other-shop';
    b.manifest.cloudflare.workerName = 'minshop-other-shop';
    b.manifest.cloudflare.stagingDomain = 'preview-autre.example.fr';
    expect(detectFleetCollisions([a, b])).toEqual([
      { kind: 'hostname', value: 'pilote.example.fr', files: ['a.yaml', 'b.yaml'] },
    ]);
  });

  /**
   * A staging preview and another shop's production domain are the same kind of
   * claim, so they collide with each other.
   *
   * Whichever deployed last is serving the hostname, and the shop taking orders
   * on it is the one nobody chose. Keying both on `hostname` rather than on
   * "staging domain" and "production domain" is what makes that detectable.
   */
  it('detects a staging preview parked on another shop’s production domain', () => {
    const a = { file: 'a.yaml', manifest: base() };
    const b = { file: 'b.yaml', manifest: base() };
    b.manifest.client.slug = 'other-shop';
    b.manifest.cloudflare.workerName = 'minshop-other-shop';
    b.manifest.cloudflare.productionDomain = 'autre.example.fr';
    b.manifest.cloudflare.stagingDomain = 'pilote.example.fr';
    expect(detectFleetCollisions([a, b])).toEqual([
      { kind: 'hostname', value: 'pilote.example.fr', files: ['a.yaml', 'b.yaml'] },
    ]);
  });

  // Staging is gated only when it has a hostname AND workers.dev is shut: an
  // Access application binds to a hostname, and the header it injects is
  // forgeable against a *.workers.dev origin.
  it('closes workers.dev for a staging preview that has a hostname', () => {
    const gated = base();
    gated.cloudflare.stagingDomain = 'preview-pilote.example.fr';
    expect(wranglerSubstitutions(gated, { env: 'staging' })).toMatchObject({
      __WORKERS_DEV__: 'false',
      __ROUTES__: JSON.stringify([{ pattern: 'preview-pilote.example.fr', custom_domain: true }]),
    });
  });

  // Without one, workers.dev stays open because it is then the only way to
  // reach staging at all — and the report says the preview is not private.
  it('keeps workers.dev for a staging environment with no hostname', () => {
    const open = base();
    delete open.cloudflare.stagingDomain;
    expect(wranglerSubstitutions(open, { env: 'staging' })).toMatchObject({ __WORKERS_DEV__: 'true', __ROUTES__: '[]' });
  });

  // Behind Access every request carries an assertion, and a Worker with no
  // issuer and audience to verify it against refuses it — /admin/setup
  // included. The values ride on staging's render and nowhere else.
  it('gives the staging Worker the Access application in front of it', () => {
    expect(wranglerSubstitutions(base(), { env: 'staging' })).toMatchObject({
      __ACCESS_TEAM_DOMAIN__: 'https://pilote-agence.cloudflareaccess.com',
      __ACCESS_AUD__: '0'.repeat(60) + 'abcd',
    });
    expect(wranglerSubstitutions(base(), { env: 'production' })).toMatchObject({ __ACCESS_TEAM_DOMAIN__: '', __ACCESS_AUD__: '' });
  });

  // Empty is what the gate reads as "no Access", which is the only correct
  // answer for a staging nobody has put an application in front of.
  it('renders no Access for a staging that declares none', () => {
    const bare = base();
    delete bare.cloudflare.stagingAccessTeam;
    delete bare.cloudflare.stagingAccessAud;
    expect(wranglerSubstitutions(bare, { env: 'staging' })).toMatchObject({ __ACCESS_TEAM_DOMAIN__: '', __ACCESS_AUD__: '' });
  });

  it('fills every placeholder of the template it is rendered into', () => {
    const template = read('wrangler.template.jsonc');
    const placeholders = [...new Set(template.match(/__[A-Z_]+__/g))].sort();
    expect(Object.keys(wranglerSubstitutions(base(), { env: 'staging' })).sort()).toEqual(placeholders);
  });
});

describe('the account of an environment', () => {
  // The ordinary shop has one account, and both environments live on it.
  it('is accountId for both environments when nothing else is declared', () => {
    for (const env of ['staging', 'production']) {
      expect(environmentAccount(base(), env)).toEqual({ id: '0'.repeat(28) + 'abcd', field: 'cloudflare.accountId' });
    }
  });

  // ADR 0015: staging on the agency's account, production on the client's,
  // both live at once. The field comes back with the id so a refusal names
  // the line to edit.
  it('is productionAccountId for production when the manifest declares one', () => {
    const split = base();
    split.cloudflare.productionAccountId = 'b'.repeat(32);
    expect(environmentAccount(split, 'production')).toEqual({ id: 'b'.repeat(32), field: 'cloudflare.productionAccountId' });
    expect(environmentAccount(split, 'staging')).toEqual({ id: '0'.repeat(28) + 'abcd', field: 'cloudflare.accountId' });
  });

  it('is nothing at all when the manifest has not learned it yet', () => {
    const unknown = base();
    delete unknown.cloudflare.accountId;
    expect(environmentAccount(unknown, 'production')).toEqual({ id: null, field: 'cloudflare.accountId' });
  });
});

describe('the two witness shops differ', () => {
  const shops = ['pilot-fr', 'canary-minimal'].map((slug) => loadManifest(fixture(slug), { root }).manifest);

  // The exit criterion of jalon 1 is that two DIFFERENT shops build from one
  // core. Fixtures that agreed on everything would pass every check above
  // while proving nothing.
  it('compiles different designs', () => {
    expect(shops[0].theme.id).not.toBe(shops[1].theme.id);
  });

  it('disagrees on the features the core is supposed to switch', () => {
    expect(shops[0].features.promoCodes).not.toBe(shops[1].features.promoCodes);
    expect(shops[0].features.shipping).not.toBe(shops[1].features.shipping);
    expect(shops[0].commerce.invoiceStrategy).not.toBe(shops[1].commerce.invoiceStrategy);
  });

  it('names a documentation domain, never a real one', () => {
    // RFC 2606: example.fr / example.org can never be registered by anyone.
    for (const shop of shops) {
      expect(shop.cloudflare.productionDomain).toMatch(/\.example\.(fr|org|com|net)$/);
      expect(shop.email.from).toMatch(/@[a-z-]+\.example\.(fr|org|com|net)$/);
    }
  });
});

describe('published JSON Schema', () => {
  it('is the file the spec generates', () => {
    // The drift check itself lives in check-manifest.mjs; this pins that the
    // committed file is what an editor would validate against today.
    const committed = JSON.parse(read(`schemas/client-${SCHEMA_VERSION}.schema.json`));
    expect(committed).toEqual(manifestJsonSchema());
  });

  // The closed mapping is the primary defence against a credential landing in a
  // committed file: an invented `stripeKey:` is refused by the shape, before the
  // value is ever judged.
  it('closes every mapping', () => {
    const check = (node) => {
      expect(node.additionalProperties).toBe(false);
      for (const child of Object.values(node.properties)) if (child.type === 'object') check(child);
    };
    check(manifestJsonSchema());
    expect(manifestJsonSchema().properties.client.properties.slug.pattern).toBeTruthy();
  });

  /**
   * Optional fields are pinned by name, not counted.
   *
   * Every field a shop must DECIDE is required, because a missing one is a
   * decision nobody made — that is what makes the manifest a source of truth
   * rather than a bag of hints. The exception is a value the shop LEARNS:
   * `accountId` exists only after provisioning has run, `imagesDomain` only if
   * a domain was ever attached, and requiring either would force a placeholder
   * that validates and means nothing.
   *
   * A new name in this list is therefore a deliberate act with a reason, and
   * this assertion is where the reason gets written down.
   */
  it('requires every field a shop has to decide', () => {
    const optional = [];
    const walk = (spec, prefix = []) => {
      for (const [key, field] of Object.entries(spec)) {
        if (field.kind === 'section') walk(field.fields, [...prefix, key]);
        else if (field.optional) optional.push([...prefix, key].join('.'));
      }
    };
    walk(MANIFEST_SPEC);
    // `productionAccountId` and the two Access values are learned too: the
    // client's account exists only once the client has created it (ADR 0015),
    // and an AUD only once an Access application has been put in front of the
    // preview.
    expect(optional).toEqual([
      'cloudflare.accountId',
      'cloudflare.productionAccountId',
      'cloudflare.imagesDomain',
      'cloudflare.stagingDomain',
      'cloudflare.stagingAccessTeam',
      'cloudflare.stagingAccessAud',
    ]);

    const schema = manifestJsonSchema();
    const check = (node, prefix = []) => {
      const expected = Object.keys(node.properties).filter((key) => !optional.includes([...prefix, key].join('.')));
      expect(node.required.sort()).toEqual(expected.sort());
      for (const [key, child] of Object.entries(node.properties)) if (child.type === 'object') check(child, [...prefix, key]);
    };
    check(schema);
  });

  // An optional field is optional, not ignored: a value that IS present still
  // has to be the right shape, or the manifest advertises an account nothing
  // can reach.
  it('still validates an optional field that is present', () => {
    const manifest = loadManifest(fixture('pilot-fr'), { root }).manifest;
    expect(validateManifest({ ...manifest, cloudflare: { ...manifest.cloudflare, accountId: 'nope' } }).errors).toContainEqual(
      expect.objectContaining({ path: 'cloudflare.accountId' }),
    );
    expect(validateManifest({ ...manifest, cloudflare: { ...manifest.cloudflare, accountId: 'a'.repeat(32) } }).ok).toBe(true);
  });

  it('lists the rules it cannot express, so a generic validator is not mistaken for the gate', () => {
    expect(manifestJsonSchema()['x-crossFieldRules'].map((r) => r.id)).toEqual(CROSS_FIELD_RULES.map((r) => r.id));
    expect(manifestJsonSchema().$comment).toMatch(/enforced by validateManifest/);
  });

  it('describes every field it publishes', () => {
    const schema = manifestJsonSchema();
    const described = (node, prefix = []) =>
      Object.entries(node.properties).flatMap(([key, child]) => {
        expect(child.description, [...prefix, key].join('.')).toBeTruthy();
        return child.type === 'object' ? described(child, [...prefix, key]) : [[...prefix, key].join('.')];
      });
    expect(described(schema)).toEqual(manifestFieldPaths());
  });
});

describe('theme id agreement', () => {
  // The manifest's theme.id becomes a directory name under src/themes/, so the
  // pattern published in the schema and the one themes.mjs enforces have to be
  // the same rule. Two readers of one identifier eventually disagree.
  it.each([
    ['pilot-fr', true],
    ['default', true],
    ['a', true],
    ['My-Theme', false],
    ['-lead', false],
    ['trail-', false],
    ['two--dashes', false],
    ['dot.theme', false],
    ['', false],
  ])('agrees with themes.mjs on %s', (id, expected) => {
    const pattern = new RegExp(manifestJsonSchema().properties.theme.properties.id.pattern);
    expect(pattern.test(id) && id.length <= 40).toBe(expected);
    expect(isValidThemeId(id)).toBe(expected);
  });

  // Only the tree knows what is on disk, so this one is caught by loadManifest
  // rather than by the schema: the manifest below is perfectly well-formed.
  it('refuses a theme with no directory in this tree', () => {
    const text = read(fixture('pilot-fr')).replace(/id: atelier.*/, 'id: no-such-theme');
    expect(validateManifest(parseManifestYaml(text)).ok).toBe(true);

    const file = join(mkdtempSync(join(tmpdir(), 'minshop-manifest-')), 'client.yaml');
    writeFileSync(file, text);
    // Absolute file, this tree's root: the theme is looked up in src/themes/ here.
    const { errors } = loadManifest(file, { root, core: coreVersion(root) });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('theme-exists');
    expect(errors[0].message).toMatch(/no directory at src\/themes\/no-such-theme/);
  });
});

// Reason one of RESERVED_SLUGS: the storefront's own URL space. Derived from
// src/pages/ rather than maintained by hand, because a hand-kept copy of a
// directory listing is a copy that falls behind the day a route is added — and
// the shop that took the freed name would only find out in production.
describe('reserved slugs', () => {
  const routePrefixes = () =>
    readdirSync(new URL('../../src/pages/', import.meta.url), { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !entry.name.includes('.test.'))
      // `cart.astro`, `llms.txt.ts` and `sitemap.xml.ts` all serve a path named
      // by the part before the first dot; a directory names itself.
      .map((entry) => entry.name.split('.')[0])
      // `404` is not a slug shape, so no shop can collide with it.
      .filter((name) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name));

  it('covers every public route prefix', () => {
    const unreserved = routePrefixes().filter((name) => !RESERVED_SLUGS.includes(name));
    expect(unreserved).toEqual([]);
  });

  it('is sorted, so a reader can find a name in it', () => {
    expect(RESERVED_SLUGS).toEqual([...RESERVED_SLUGS].sort());
  });
});

describe('config:validate', () => {
  // This suite is core-owned, so it is SHIPPED into every generated shop and
  // runs there unchanged (`shopctl new` … `npm run verify`). A shop's tree
  // describes one manifest more than the core's — its own — so the property is
  // that the witnesses are still there and still pass, never that they are the
  // only shops in the tree. A test that pinned the count would fail in every
  // shop the platform ever creates, and the failure would look like the shop's
  // fault.
  it('passes over this tree and reports the witness shops', () => {
    const out = execFileSync('node', ['scripts/check-manifest.mjs', '--json'], { cwd: root, encoding: 'utf8' });
    const report = JSON.parse(out);
    expect(report.ok).toBe(true);
    expect(report.repository).toBe(isShopRepository(root) ? 'shop' : 'core');
    expect(report.manifests.map((m) => m.slug)).toEqual(expect.arrayContaining(['canary-minimal', 'pilot-fr']));
    expect(report.collisions).toEqual([]);
  });
});
