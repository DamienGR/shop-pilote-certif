import { afterEach, describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { hostnameState } from '../../shopctl/src/saas.mjs';
import { judgeAccount } from '../../shopctl/src/certify/judge.mjs';
import { loadManifest, saasZoneFor, wranglerSubstitutions } from '../../scripts/manifest.mjs';
import { validateManifest } from '../../scripts/manifest-schema.mjs';
import { ACCOUNT, OTHER_ACCOUNT, shop } from '../helpers/provisioned-shop.mjs';

/**
 * The merchant's domain on the shared account (ADR 0019, lot 3).
 *
 * A Workers custom domain needs the domain's zone on the Worker's account; on
 * the shared account the merchant's zone stays with the merchant. So the
 * agency's SaaS zone serves the domain as a custom hostname, and a route on
 * that zone sends it to the shop's Worker. Wrangler covers the route; the
 * custom hostname goes through Cloudflare's API, answered here by a double.
 */

vi.setConfig({ testTimeout: 60_000 });

const CORE = new URL('../../', import.meta.url).pathname;
const DOUBLE = resolve(CORE, 'test/fixtures/cloudflare-api-double.mjs');
const ZONE = 'boutiques.agence.example';
const DOMAIN = 'boutique.example.fr';
const FAST = ['--skip-verify', '--skip-build'];

const witness = () => loadManifest('test/fixtures/clients/pilot-fr/client.yaml', { root: CORE }).manifest;
const withZone = (zone, domain) => {
  const manifest = structuredClone(witness());
  manifest.cloudflare.saasZone = zone;
  if (domain) manifest.cloudflare.productionDomain = domain;
  return manifest;
};

describe('the rendered route', () => {
  it('sends a merchant domain outside the zone to the Worker by a route on the zone', () => {
    const manifest = withZone(ZONE);
    const rendered = wranglerSubstitutions(manifest, { env: 'production' });
    expect(JSON.parse(rendered.__ROUTES__)).toEqual([{ pattern: `${manifest.cloudflare.productionDomain}/*`, zone_name: ZONE }]);
    expect(rendered.__WORKERS_DEV__).toBe('false');
  });

  // The zone is on the account: a hostname of its own is a custom domain.
  it('keeps a custom domain for a hostname inside the zone', () => {
    const manifest = withZone(ZONE, `pilote.${ZONE}`);
    expect(saasZoneFor(manifest, 'production')).toBeNull();
    expect(JSON.parse(wranglerSubstitutions(manifest, { env: 'production' }).__ROUTES__)).toEqual([
      { pattern: `pilote.${ZONE}`, custom_domain: true },
    ]);
  });

  // The preview's hostname is the agency's, behind its Access application.
  it('never routes staging through the zone', () => {
    const manifest = withZone(ZONE);
    expect(saasZoneFor(manifest, 'staging')).toBeNull();
    expect(JSON.parse(wranglerSubstitutions(manifest, { env: 'staging' }).__ROUTES__)).toEqual([
      { pattern: manifest.cloudflare.stagingDomain, custom_domain: true },
    ]);
  });

  it('is unchanged for a shop that declares no zone', () => {
    expect(JSON.parse(wranglerSubstitutions(witness(), { env: 'production' }).__ROUTES__)).toEqual([
      { pattern: witness().cloudflare.productionDomain, custom_domain: true },
    ]);
  });

  it('refuses a production domain equal to the zone', () => {
    const result = validateManifest(withZone(ZONE, ZONE));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.rule)).toContain('saas-zone-is-not-production');
  });
});

describe('a custom hostname', () => {
  it('is active only when the hostname and its certificate both are', () => {
    expect(hostnameState({ id: 'x', status: 'active', ssl: { status: 'active' } }).active).toBe(true);
    expect(hostnameState({ id: 'x', status: 'active', ssl: { status: 'pending_validation' } }).active).toBe(false);
    expect(hostnameState({ id: 'x', status: 'pending', ssl: { status: 'active' } }).active).toBe(false);
  });

  it('fails the certification while it is not active', () => {
    const base = { account: ACCOUNT, steps: [], jurisdictionChecks: [], retention: { action: 'keep' } };
    const pending = judgeAccount({ ...base, hostname: { hostname: DOMAIN, zone: ZONE, action: 'keep', status: 'pending', ssl: 'pending_validation', active: false, cname: `repli.${ZONE}` } }, [], []);
    expect(pending.find((finding) => finding.message.includes(DOMAIN))).toMatchObject({ status: 'fail' });
    const active = judgeAccount({ ...base, hostname: { hostname: DOMAIN, zone: ZONE, action: 'keep', status: 'active', ssl: 'active', active: true, cname: null } }, [], []);
    expect(active.find((finding) => finding.message.includes(DOMAIN))).toMatchObject({ status: 'ok' });
  });
});

describe('shopctl and the SaaS zone', () => {
  const doubles = [];
  afterEach(() => {
    for (const child of doubles.splice(0)) child.kill();
  });

  /** The API double in its own process, the SaaS zone on the shop's account. */
  async function cloudflare(patch = {}) {
    const file = join(mkdtempSync(join(tmpdir(), 'shopctl-saas-')), 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        zones: [{ id: 'zone-saas', name: ZONE, account: ACCOUNT.id }],
        fallback: { 'zone-saas': { origin: `repli.${ZONE}`, status: 'active' } },
        hostnames: [],
        ...patch,
      }),
    );
    const child = spawn('node', [DOUBLE, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    doubles.push(child);
    const [chunk] = await once(child.stdout, 'data');
    const origin = chunk.toString().trim();
    return {
      env: { CLOUDFLARE_API_TOKEN: 'saas-token', CLOUDFLARE_API_BASE_URL: origin },
      read: () => JSON.parse(readFileSync(file, 'utf8')),
      write: (state) => writeFileSync(file, JSON.stringify(state)),
    };
  }

  const saasShop = (options = {}) => shop({ built: true, migrations: true, cloudflare: { saasZone: ZONE }, ...options });

  it('creates the merchant’s hostname at provisioning, and says which CNAME to add', async () => {
    const api = await cloudflare();
    const target = saasShop();
    const { report, status, stderr } = target.json(['provision', '--env', 'production'], api.env);
    expect(status, stderr).toBe(EXIT_CODES.ok);
    expect(report.hostname).toMatchObject({ hostname: DOMAIN, zone: ZONE, action: 'create', status: 'pending', active: false, cname: `repli.${ZONE}` });
    expect(stderr).toContain(`CNAME ${DOMAIN} → repli.${ZONE}`);

    const [created] = api.read().hostnames;
    expect(created).toMatchObject({ zone: 'zone-saas', hostname: DOMAIN });
    expect(created.ssl).toMatchObject({ method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } });
    expect(api.read().requests.every((request) => request.authorization === 'Bearer saas-token')).toBe(true);

    // And the rendered configuration routes the domain on the zone.
    expect(readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8')).toContain(`"zone_name":"${ZONE}"`);
  });

  it('finds it again rather than creating a second one', async () => {
    const api = await cloudflare();
    const target = saasShop();
    expect(target.run(['provision', '--env', 'production'], api.env).status).toBe(EXIT_CODES.ok);
    const { report } = target.json(['provision', '--env', 'production'], api.env);
    expect(report.hostname).toMatchObject({ action: 'keep' });
    expect(api.read().hostnames).toHaveLength(1);
    expect(api.read().requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('only announces it in a dry run, and only reads without a token', async () => {
    const api = await cloudflare();
    const target = saasShop();
    const { report, status } = target.json(['provision', '--env', 'production', '--dry-run'], api.env);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.hostname).toMatchObject({ action: 'create', status: null });
    expect(api.read().hostnames).toEqual([]);

    const blind = target.json(['provision', '--env', 'production', '--dry-run']);
    expect(blind.status).toBe(EXIT_CODES.ok);
    expect(blind.report.hostname).toMatchObject({ action: null });
  });

  it('refuses to provision production without the token, before creating anything', () => {
    const target = saasShop();
    const result = target.run(['provision', '--env', 'production']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/CLOUDFLARE_API_TOKEN est absent/);
    expect(result.stderr).toMatch(/SSL and Certificates : Edit/);
  });

  it('refuses a zone the account does not hold', async () => {
    const api = await cloudflare({ zones: [{ id: 'zone-saas', name: ZONE, account: OTHER_ACCOUNT.id }] });
    const result = saasShop().run(['provision', '--env', 'production'], api.env);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(new RegExp(`la zone ${ZONE.replaceAll('.', '\\.')} n'est pas sur le compte`));
  });

  it('leaves staging alone', async () => {
    const api = await cloudflare();
    const { report, status } = saasShop().json(['provision', '--env', 'staging'], api.env);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.hostname).toBeNull();
    expect(api.read().requests ?? []).toEqual([]);
  });

  describe('deploy', () => {
    async function provisioned() {
      const api = await cloudflare();
      const target = saasShop();
      expect(target.run(['provision', '--env', 'production'], api.env).status).toBe(EXIT_CODES.ok);
      expect(target.run(['backup', 'keygen']).status).toBe(EXIT_CODES.ok);
      return { api, target };
    }

    // Found out before the backup and the migrations, not by the smoke test.
    it('refuses while the merchant’s CNAME is not in, before any write', async () => {
      const { api, target } = await provisioned();
      const before = target.read();
      const result = target.run(['deploy', '--env', 'production', '--yes', ...FAST], api.env);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/n'est pas encore actif/);
      expect(result.stderr).toContain(`CNAME ${DOMAIN} → repli.${ZONE}`);
      expect(result.stderr).toMatch(/--skip-smoke/);
      expect(target.read().deploys ?? []).toEqual(before.deploys ?? []);
      expect(target.read().migrationsApplied).toBe(before.migrationsApplied);
    });

    it('deploys before the switch when the smoke test is skipped on purpose', async () => {
      const { api, target } = await provisioned();
      const result = target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke'], api.env);
      expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
      expect(result.stdout).toMatch(/ne répondra sur son domaine qu'une fois le DNS posé/);
      // Not "en ligne": the domain still leads wherever it led before.
      expect(result.stdout).toContain(`est déployé en production, mais https://${DOMAIN} ne mène à lui qu'une fois son nom d'hôte actif.`);
      expect(result.stdout).not.toMatch(/est en ligne/);
    });

    it('goes ahead once the hostname is active', async () => {
      const { api, target } = await provisioned();
      const state = api.read();
      state.hostnames = state.hostnames.map((record) => ({ ...record, status: 'active', ssl: { ...record.ssl, status: 'active' } }));
      api.write(state);
      const result = target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke'], api.env);
      expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
      expect(result.stdout).toMatch(new RegExp(`${DOMAIN.replaceAll('.', '\\.')} — actif sur`));
      expect(result.stdout).toContain(`est en ligne en production sur https://${DOMAIN}.`);
    });

    it('refuses a hostname provisioning never created', async () => {
      const { api, target } = await provisioned();
      api.write({ ...api.read(), hostnames: [] });
      const result = target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke'], api.env);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/shopctl provision --env production/);
    });
  });

  describe('destroy', () => {
    it('removes the merchant’s hostname with the rest of production', async () => {
      const api = await cloudflare();
      const target = saasShop();
      expect(target.run(['provision', '--env', 'production'], api.env).status).toBe(EXIT_CODES.ok);
      const result = target.run(['destroy', '--env', 'production', '--confirm', target.slug, '--yes'], api.env);
      expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
      expect(api.read().hostnames).toEqual([]);
      expect(api.read().requests.some((request) => request.method === 'DELETE')).toBe(true);
      expect(target.read().d1).toEqual([]);
    });

    // A hostname left behind is one the agency keeps answering for.
    it('deletes nothing without the token', async () => {
      const api = await cloudflare();
      const target = saasShop();
      expect(target.run(['provision', '--env', 'production'], api.env).status).toBe(EXIT_CODES.ok);
      const before = target.read();
      const result = target.run(['destroy', '--env', 'production', '--confirm', target.slug, '--yes']);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(target.read().d1).toEqual(before.d1);
      expect(target.read().r2).toEqual(before.r2);
      expect(api.read().hostnames).toHaveLength(1);
    });
  });
});
