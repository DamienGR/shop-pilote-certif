/**
 * `shopctl certify` — the short certification of one shop.
 *
 * Every verdict is a pure function (shopctl/src/certify/judge.mjs) and is
 * tested as such. The reads are tested against what they read: the settings
 * query against the REAL migrations in the wrangler double's sqlite, because
 * its masking is the reason the report may be committed; the forge against
 * the gh double; the public pages and PageSpeed Insights against a server in
 * this process. The command itself is run with its groups stood in for, to
 * pin what it decides from them: the verdict, the exit code, the report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT_CODES, preconditionError } from '../../shopctl/src/errors.mjs';
import { Reporter } from '../../shopctl/src/report.mjs';
import { ATTESTATIONS_FILE, ATTESTATIONS_TEMPLATE, judgeAttestations } from '../../shopctl/src/certify/attestations.mjs';
import {
  CERTIFIED_FLOOR,
  DRAFT_BANNER,
  INCOMPLETE_MARKER,
  LEGAL_PAGES,
  NIGHTLY_MAX_AGE_HOURS,
  isPlaceholderDomain,
  judgeAccount,
  judgeCore,
  judgeForge,
  judgeLighthouse,
  judgeManifest,
  judgePages,
  judgeSettings,
  verdictOf,
} from '../../shopctl/src/certify/judge.mjs';
import { gateEnvironment, runBrowserGate, runSecurityGate } from '../../shopctl/src/certify/public.mjs';
import { GROUPS, SETTINGS_SQL, readForge, renderMarkdown, runCertify } from '../../shopctl/src/commands/certify.mjs';
import { OPERATOR_ENV } from '../helpers/operator-env.mjs';
import { names, shop } from '../helpers/provisioned-shop.mjs';

vi.setConfig({ testTimeout: 60_000 });

const CORE = new URL('../../', import.meta.url).pathname;
const statuses = (findings) => findings.map((finding) => finding.status);
const failing = (findings) => findings.filter((finding) => finding.status !== 'ok').map((finding) => finding.message);

// ── the core ────────────────────────────────────────────────────────────────

const state = (patch = {}) => ({
  core: {
    declared: '0.3.29',
    merged: '0.3.29',
    mergedTag: 'v0.3.29',
    remote: 'git@github.com:agence/minshop-platform.git',
    latest: '0.3.29',
    behind: [],
    declaresMerged: true,
    ...(patch.core ?? {}),
  },
  drift: patch.drift ?? [],
  worktree: { clean: true, dirty: [], ...(patch.worktree ?? {}) },
  tags: { published: ['v0.3.28', 'v0.3.29'], ...(patch.tags ?? {}) },
});

describe('the core a shop inherits its certification from', () => {
  it('accepts a published version at or above the certified floor, with no divergence', () => {
    expect(statuses(judgeCore(state(), { declared: null }))).toEqual(['ok', 'ok']);
  });

  it('refuses a version older than the floor, and names the upgrade', () => {
    const findings = judgeCore(state({ core: { declared: '0.3.27', merged: '0.3.27', mergedTag: 'v0.3.27' }, tags: { published: ['v0.3.27', 'v0.3.28'] } }), { declared: null });
    expect(findings[0]).toMatchObject({ status: 'fail', message: expect.stringContaining(`v${CERTIFIED_FLOOR}`) });
    expect(findings[0].hint).toMatch(/core upgrade/);
  });

  it('refuses a tag the core never published, and says when it could not ask', () => {
    expect(statuses(judgeCore(state({ tags: { published: ['v0.3.28'] } }), { declared: null }))).toContain('fail');
    expect(statuses(judgeCore(state({ tags: { published: null } }), { declared: null }))).toContain('skip');
  });

  it('warns about versions behind without refusing them', () => {
    const findings = judgeCore(state({ core: { behind: ['0.3.30'] }, tags: { published: ['v0.3.29', 'v0.3.30'] } }), { declared: null });
    expect(statuses(findings)).toEqual(['ok', 'warn', 'ok']);
  });

  // A core file the shop changed is a merge waiting for the next upgrade, and
  // a claim the campaign never tested: named and justified, it is said; not
  // named, it is refused; and a new one is never covered by an old count.
  it('accepts a divergence only as declared, and counts it', () => {
    const drift = [{ path: 'src/layouts/Layout.astro', owner: 'core' }];
    expect(statuses(judgeCore(state({ drift }), { declared: null })).at(-1)).toBe('fail');
    expect(judgeCore(state({ drift }), { declared: { divergences: 1, reason: 'bandeau du commerçant' } }).at(-1)).toMatchObject({ status: 'warn', message: expect.stringContaining('bandeau du commerçant') });
    const two = [...drift, { path: 'src/pages/index.astro', owner: 'core' }];
    expect(statuses(judgeCore(state({ drift: two }), { declared: { divergences: 1, reason: 'bandeau' } })).at(-1)).toBe('fail');
  });

  it('refuses a divergence in payment, stock, authentication or the schema, declared or not', () => {
    for (const path of ['src/features/payments/stripe.ts', 'migrations/0001_init.sql', 'src/features/products/stock.ts', 'src/middleware.ts', 'src/pages/api/webhook.ts']) {
      const findings = judgeCore(state({ drift: [{ path, owner: 'core' }] }), { declared: { divergences: 1, reason: 'raison' } });
      expect(findings.at(-1), path).toMatchObject({ status: 'fail', message: expect.stringContaining(path) });
    }
  });

  it('warns about a working tree that is not what is versioned', () => {
    expect(statuses(judgeCore(state({ worktree: { clean: false, dirty: ['a'] } }), { declared: null })).at(-1)).toBe('warn');
  });
});

describe('the manifest', () => {
  it('refuses a placeholder domain and an invoice strategy still pending', () => {
    expect(isPlaceholderDomain('pilote.example.com')).toBe(true);
    expect(isPlaceholderDomain('boutique.example.fr')).toBe(true);
    expect(isPlaceholderDomain('atelier-durand.fr')).toBe(false);
    const findings = judgeManifest({ cloudflare: { productionDomain: 'pilote.example.com' }, commerce: { invoiceStrategy: 'pending-validation' } });
    expect(statuses(findings)).toEqual(['fail', 'fail']);
    expect(statuses(judgeManifest({ cloudflare: { productionDomain: 'atelier-durand.fr' }, commerce: { invoiceStrategy: 'stripe-receipt' } }))).toEqual(['ok', 'ok']);
  });
});

// ── the account ─────────────────────────────────────────────────────────────

const provisioned = (patch = {}) => ({
  account: { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', name: 'Atelier' },
  jurisdiction: 'eu',
  resources: { worker: 'minshop-atelier-production' },
  steps: [
    { resource: 'base D1', name: 'db', action: 'keep' },
    { resource: 'bucket images', name: 'images', action: 'keep' },
  ],
  jurisdictionChecks: [{ resource: 'db', expected: 'eu', reported: 'eu', ok: true }],
  exposure: {
    files: { known: true, public: false, devUrl: null, domains: [] },
    images: { known: true, public: false, devUrl: null, domains: [] },
    backups: { known: true, public: false, devUrl: null, domains: [] },
  },
  retention: { days: 30, action: 'keep' },
  ...patch,
});

describe('the account', () => {
  const internal = ['AUTH_SECRET', 'SECRETS_KEK'];

  it('accepts a provisioned production', () => {
    expect(failing(judgeAccount(provisioned(), internal, internal))).toEqual([]);
  });

  it('refuses a resource still to create, a public private bucket, a Worker without its secrets', () => {
    expect(statuses(judgeAccount(provisioned({ steps: [{ resource: 'base D1', name: 'db', action: 'create' }] }), internal, internal))).toContain('fail');
    const exposed = provisioned({ exposure: { ...provisioned().exposure, files: { known: true, public: true, devUrl: 'https://pub-1.r2.dev', domains: [] } } });
    expect(failing(judgeAccount(exposed, internal, internal))).toEqual([expect.stringContaining('fichiers est public')]);
    expect(failing(judgeAccount(provisioned(), ['AUTH_SECRET'], internal))).toEqual([expect.stringContaining('SECRETS_KEK')]);
    expect(failing(judgeAccount(provisioned(), null, internal))).toEqual([expect.stringContaining('pas déployé')]);
  });
});

// ── the database ────────────────────────────────────────────────────────────

const configured = [
  { key: 'setup_complete', value: '1' },
  { key: 'admin_password_hash', value: 'set' },
  { key: 'enc:stripe_secret_key', value: 'set' },
  { key: 'enc:stripe_webhook_secret', value: 'set' },
  { key: 'enc:resend_api_key', value: 'set' },
  { key: 'enc:turnstile_secret_key', value: 'set' },
  { key: 'email_from', value: 'domain:atelier-durand.fr' },
  { key: 'email_notify_to', value: 'set' },
  { key: 'turnstile_enabled', value: '1' },
  { key: 'turnstile_site_key', value: '0x4AAAAAAAB1234567890abc' },
];
const without = (key) => configured.filter((row) => row.key !== key);
const withValue = (key, value) => [...without(key), { key, value }];

describe('the production settings', () => {
  it('accepts a shop that is installed, closed to strangers, takes payments and sends mail', () => {
    expect(failing(judgeSettings(configured, { storeConfig: null }))).toEqual([]);
  });

  it('refuses each missing piece by name', () => {
    expect(failing(judgeSettings(without('admin_password_hash'), { storeConfig: null }))).toEqual([expect.stringContaining('mot de passe')]);
    expect(failing(judgeSettings(without('enc:stripe_webhook_secret'), { storeConfig: null }))).toEqual([expect.stringContaining('stripe_webhook_secret')]);
    expect(failing(judgeSettings(withValue('payment_methods_disabled', 'stripe'), { storeConfig: null }))).toEqual([expect.stringContaining('coupé')]);
    expect(failing(judgeSettings(without('enc:turnstile_secret_key'), { storeConfig: null }))).toEqual([expect.stringContaining('clé secrète')]);
  });

  // Resend's test sender delivers to the Resend account's own address and
  // nowhere else: a shop on it sends no buyer a confirmation (step 3).
  it('refuses Resend’s test sender, whether by default or by setting', () => {
    expect(failing(judgeSettings(without('email_from'), { storeConfig: null }))).toEqual([expect.stringContaining('test de Resend')]);
    expect(failing(judgeSettings(withValue('email_from', 'domain:resend.dev'), { storeConfig: null }))).toEqual([expect.stringContaining('test de Resend')]);
    expect(failing(judgeSettings(without('email_from'), { storeConfig: "email: { from: 'Boutique <contact@atelier-durand.fr>' }" }))).toEqual([]);
  });

  it('takes the alert recipient from store.config.ts when the settings have none', () => {
    expect(statuses(judgeSettings(without('email_notify_to'), { storeConfig: null }))).toContain('fail');
    expect(failing(judgeSettings(without('email_notify_to'), { storeConfig: "email: { notifyTo: 'commandes@atelier-durand.fr' }" }))).toEqual([]);
  });

  it('refuses Turnstile’s test keys, which protect nothing', () => {
    expect(failing(judgeSettings(withValue('turnstile_site_key', '1x00000000000000000000AA'), { storeConfig: null }))).toEqual([expect.stringContaining('clé de test')]);
    expect(failing(judgeSettings(withValue('turnstile_enabled', '0'), { storeConfig: null }))).toEqual([expect.stringContaining('coupé')]);
  });

  // The masking is what lets the report be committed, so it is proven on the
  // REAL schema, every migration applied, with an address in each column a
  // merchant types one into.
  it('reads the settings masked, so that no address and no secret leaves the database', () => {
    const target = shop({ migrations: true, slug: 'atelier-certif' });
    expect(target.run(['provision', '--env', 'production']).status).toBe(EXIT_CODES.ok);
    target.sql([
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('setup_complete', '1');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', 'pbkdf2$600000$c2VsJ3MgZ3JhaW4$aGFzaA');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('enc:stripe_secret_key', 'v1.iv.ciphertext');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('enc:stripe_webhook_secret', 'v1.iv.ciphertext');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('enc:resend_api_key', 'v1.iv.ciphertext');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('enc:turnstile_secret_key', 'v1.iv.ciphertext');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('email_from', 'Atelier <Contact@Atelier-Durand.fr>');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('email_notify_to', 'jeanne.durand@example.fr');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('turnstile_enabled', '1');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('turnstile_site_key', '0x4AAAAAAAB1234567890abc');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('store_name', 'Atelier Durand');",
    ]);
    const rows = target.query(SETTINGS_SQL);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/@|ciphertext|pbkdf2/);
    expect(rows.map((row) => row.key)).not.toContain('store_name');
    expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toMatchObject({
      'enc:stripe_secret_key': 'set',
      admin_password_hash: 'set',
      email_notify_to: 'set',
      email_from: 'domain:atelier-durand.fr>',
    });
    expect(failing(judgeSettings(rows, { storeConfig: null }))).toEqual([]);
    expect(judgeSettings(rows, { storeConfig: null })).toContainEqual({ status: 'ok', message: 'expéditeur sur atelier-durand.fr' });
  });
});

// ── the public pages ────────────────────────────────────────────────────────

const footer = Object.keys(LEGAL_PAGES).map((slug) => `<a href="/pages/${slug}">${slug}</a>`).join('');
const home = (extra = '') => ({ status: 200, body: `<html lang="fr"><head>${extra}</head><body><footer>${footer}</footer></body></html>` });
const legal = (body = '<h1>Mentions</h1><p>Atelier Durand, SIREN 123 456 789.</p>') =>
  Object.fromEntries(Object.keys(LEGAL_PAGES).map((slug) => [slug, { status: 200, body }]));

describe('the public pages', () => {
  it('accepts an open storefront with its four legal pages complete and in the footer', () => {
    expect(failing(judgePages({ home: home(), pages: legal() }))).toEqual([]);
  });

  it('refuses a storefront still closed to search engines', () => {
    expect(failing(judgePages({ home: home('<meta name="robots" content="noindex" />'), pages: legal() }))).toEqual([expect.stringContaining('indexer')]);
  });

  it('refuses a legal page unpublished, unfinished, still a draft, or missing from the footer', () => {
    const pages = legal();
    pages['mentions-legales'] = { status: 404, body: '' };
    pages['conditions-generales-de-vente'] = { status: 200, body: '<p>Vendeur : [À COMPLÉTER — raison sociale]</p>' };
    pages['droit-de-retractation'] = { status: 200, body: `<blockquote><p>${DRAFT_BANNER} Ce texte est un squelette</p></blockquote>` };
    const bare = { status: 200, body: '<html lang="fr"><body><footer></footer></body></html>' };
    expect(failing(judgePages({ home: home(), pages }))).toHaveLength(3);
    expect(failing(judgePages({ home: bare, pages: legal() }))).toHaveLength(4);
  });

  // The CLI cannot import the storefront's TypeScript; the twins are pinned.
  it('reads the marker and the banner the core writes', () => {
    expect(readFileSync(join(CORE, 'src/features/pages/completeness.ts'), 'utf8')).toContain(`INCOMPLETE_MARKER = '${INCOMPLETE_MARKER}'`);
    const migration = readFileSync(join(CORE, 'migrations/0040_french_legal_pages.sql'), 'utf8');
    expect(migration).toContain('> **Brouillon.**');
    for (const slug of Object.keys(LEGAL_PAGES)) expect(migration).toContain(`'${slug}'`);
  });
});

const pageSpeedAnswer = (scores = { performance: 0.97, accessibility: 1, seo: 1 }) => ({
  lighthouseResult: {
    categories: Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, { score }])),
    audits: { 'largest-contentful-paint': { numericValue: 1234 }, 'cumulative-layout-shift': { numericValue: 0.01 } },
  },
  loadingExperience: { metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 88 } } },
});

describe('Lighthouse', () => {
  it('accepts ninety and above in performance, accessibility and SEO, and records LCP, CLS and INP', () => {
    expect(judgeLighthouse('accueil', pageSpeedAnswer())).toEqual({ status: 'ok', message: expect.stringMatching(/97 \/ 100 \/ 100.*LCP 1,2 s, CLS 0,01, INP 88 ms/) });
  });

  it('fails under ninety and skips a run Lighthouse could not finish', () => {
    expect(judgeLighthouse('accueil', pageSpeedAnswer({ performance: 0.72, accessibility: 1, seo: 1 }))).toMatchObject({ status: 'fail', hint: expect.stringContaining('performance') });
    expect(judgeLighthouse('accueil', { lighthouseResult: { runtimeError: { code: 'FAILED_DOCUMENT_REQUEST', message: 'x' } } })).toMatchObject({ status: 'skip' });
  });
});

// ── the remote gates ────────────────────────────────────────────────────────

describe('the remote gates', () => {
  const tree = () => {
    const target = shop({ slug: 'atelier-portes' });
    mkdirSync(join(target.root, 'test/remote'), { recursive: true });
    writeFileSync(join(target.root, 'test/remote/security.mjs'), '');
    return target.root;
  };

  it('runs the security gate on the origin, limiters only on request, and reads its verdict', async () => {
    const root = tree();
    const calls = [];
    const run = async (command, args, options) => {
      calls.push({ args, base: options.env.BASE_URL, access: options.env.CF_ACCESS_CLIENT_ID });
      return { status: 0, stdout: '  ✓ un\n\n41 contrôle(s) passé(s), 0 en échec.\n', stderr: '' };
    };
    const env = { CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 'secret' };
    expect(await runSecurityGate(root, 'https://atelier-durand.fr', { run, env })).toMatchObject({ status: 'ok', message: expect.stringContaining('41 contrôles') });
    await runSecurityGate(root, 'https://atelier-durand.fr', { run, env, rateLimits: true });
    expect(calls.map((call) => call.args.includes('--limiteurs'))).toEqual([false, true]);
    // A service token from a preview is not sent to a production.
    expect(calls.every((call) => call.base === 'https://atelier-durand.fr' && call.access === undefined)).toBe(true);
    expect(gateEnvironment('https://a.fr', env)).not.toHaveProperty('CF_ACCESS_CLIENT_SECRET');

    const red = async () => ({ status: 1, stdout: '  ✗ en-têtes sur /\n      csp\n\n40 contrôle(s) passé(s), 1 en échec.\n', stderr: '' });
    expect(await runSecurityGate(root, 'https://atelier-durand.fr', { run: red, env })).toMatchObject({ status: 'fail', hint: expect.stringContaining('en-têtes') });
  });

  it('says a machine without Playwright or Chromium is a machine to set up, never a pass', async () => {
    const root = tree();
    expect(await runBrowserGate(root, 'https://atelier-durand.fr', { run: async () => ({ status: 0, stdout: '', stderr: '' }) })).toMatchObject({ status: 'skip' });
    writeFileSync(join(root, 'node_modules/.bin/playwright'), '');
    const missing = async () => ({ status: 1, stdout: '', stderr: "browserType.launch: Executable doesn't exist at /x\nnpx playwright install" });
    expect(await runBrowserGate(root, 'https://atelier-durand.fr', { run: missing })).toMatchObject({ status: 'skip', hint: expect.stringContaining('playwright install') });
    const green = async () => ({ status: 0, stdout: '  52 passed (1.2m)\n  9 skipped\n', stderr: '' });
    expect(await runBrowserGate(root, 'https://atelier-durand.fr', { run: green })).toMatchObject({ status: 'ok', message: expect.stringContaining('52 passé(s)') });

    // Playwright's closing summary, as the pilot's production printed it: the
    // hint names the failed tests, not the counts the message already gives.
    const red = async () => ({
      status: 1,
      stdout: [
        '  1) [desktop] › test/browser/a11y.spec.mjs:52:1 › le panier garni n’a aucune violation WCAG A/AA ──',
        '',
        '    Error: expect(locator).toBeVisible() failed',
        '',
        '  2 failed',
        '    [desktop] › test/browser/a11y.spec.mjs:52:1 › le panier garni n’a aucune violation WCAG A/AA ───',
        '    [phone] › test/browser/a11y.spec.mjs:52:1 › le panier garni n’a aucune violation WCAG A/AA ─────',
        '  19 skipped',
        '  81 passed (3.5m)',
        '',
      ].join('\n'),
      stderr: '',
    });
    const failed = await runBrowserGate(root, 'https://atelier-durand.fr', { run: red });
    expect(failed).toMatchObject({ status: 'fail', message: 'porte navigateur distante : 81 passé(s), 2 en échec, 19 sauté(s) avec leur raison.' });
    expect(failed.hint.split('\n    ')).toEqual([
      '[desktop] le panier garni n’a aucune violation WCAG A/AA (test/browser/a11y.spec.mjs)',
      '[phone] le panier garni n’a aucune violation WCAG A/AA (test/browser/a11y.spec.mjs)',
      'Le détail : BASE_URL=https://atelier-durand.fr npm run test:browser:remote',
    ]);
  });
});

// ── the repository ──────────────────────────────────────────────────────────

const NOW = new Date('2026-11-03T06:00:00Z');
const job = (name, conclusion, completedAt, steps = []) => ({ name, status: 'completed', conclusion, completedAt, steps: steps.map(([stepName, stepConclusion]) => ({ name: stepName, conclusion: stepConclusion })) });

function forgeState(nameWithOwner, slug, patch = {}) {
  return {
    [nameWithOwner]: {
      visibility: 'public',
      defaultBranch: 'main',
      branches: ['main'],
      secrets: { MONITOR_CLOUDFLARE_API_TOKEN: 'x', MONITOR_CLOUDFLARE_ACCOUNT_ID: 'x' },
      environments: {
        production: { secrets: { CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: 'x', SHOPCTL_BACKUP_KEY: 'x' }, reviewers: 1, branchPolicy: null },
        backup: {
          secrets: { CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: 'x', SHOPCTL_BACKUP_KEY: 'x' },
          reviewers: 0,
          branchPolicy: { protected_branches: false, custom_branch_policies: true },
          branches: ['main'],
        },
      },
      runs: [
        { databaseId: 11, workflow: 'deploy.yml', createdAt: '2026-11-01T09:00:00Z', status: 'completed', conclusion: 'success', headSha: 'abc1234def', jobs: [job('Verify', 'success', '2026-11-01T09:10:00Z'), job(`Deploy ${slug} (production)`, 'success', '2026-11-01T09:20:00Z')] },
        { databaseId: 12, workflow: 'deploy.yml', createdAt: '2026-11-02T09:00:00Z', status: 'completed', conclusion: 'success', headSha: 'fff0000aaa', jobs: [job(`Deploy ${slug} (staging)`, 'success', '2026-11-02T09:20:00Z')] },
        { databaseId: 21, workflow: 'nightly.yml', createdAt: '2026-11-02T03:17:00Z', status: 'completed', conclusion: 'success', headSha: 'abc1234def', jobs: [
          job('Production backup', 'success', '2026-11-02T03:30:00Z', [['Back up production', 'success'], ['Verify the archive', 'success']]),
          job('Production error rate and quotas', 'success', '2026-11-02T03:25:00Z', [['Install dependencies', 'success'], ['Error rate and quotas', 'success']]),
        ] },
        // The midday run: backup only, the watch skipped on purpose.
        { databaseId: 22, workflow: 'nightly.yml', createdAt: '2026-11-02T15:17:00Z', status: 'completed', conclusion: 'success', headSha: 'abc1234def', jobs: [
          job('Production backup', 'success', '2026-11-02T15:30:00Z', [['Back up production', 'success'], ['Verify the archive', 'success']]),
          job('Production error rate and quotas', 'skipped', null),
        ] },
        { databaseId: 23, workflow: 'nightly.yml', createdAt: '2026-11-03T03:17:00Z', status: 'in_progress', conclusion: null, headSha: 'abc1234def', jobs: [] },
      ],
      ...patch,
    },
  };
}

describe('the repository', () => {
  const previous = { PATH: process.env.PATH, GH_DOUBLE_STATE: process.env.GH_DOUBLE_STATE };
  afterEach(() => {
    process.env.PATH = previous.PATH;
    if (previous.GH_DOUBLE_STATE === undefined) delete process.env.GH_DOUBLE_STATE;
    else process.env.GH_DOUBLE_STATE = previous.GH_DOUBLE_STATE;
  });

  // In-process, so the double goes on THIS process's PATH (repo.test.mjs).
  const read = (patch) => {
    const target = shop({ forge: true, slug: 'atelier-forge' });
    target.github({ repos: forgeState(target.nameWithOwner, target.slug, patch) });
    process.env.PATH = `${target.binDir}:${previous.PATH}`;
    process.env.GH_DOUBLE_STATE = target.ghState;
    return { target, read: readForge(target.nameWithOwner, { cwd: target.root, slug: target.slug }) };
  };

  it('reads the environments, the secrets by name and the latest production jobs through gh', () => {
    const { target, read: forge } = read();
    expect(forge.environments.production).toMatchObject({ reviewers: 1, customBranches: false });
    expect(forge.environments.backup).toMatchObject({ customBranches: true, branches: ['main'] });
    expect(forge.secrets.repository).toEqual(['MONITOR_CLOUDFLARE_API_TOKEN', 'MONITOR_CLOUDFLARE_ACCOUNT_ID']);
    // The production job, not the newer staging one; the nightly's latest
    // COMPLETED run, and past a job it skipped.
    expect(forge.deploy).toMatchObject({ conclusion: 'success', sha: 'abc1234def' });
    expect(forge.nightly.backup.at).toBe('2026-11-02T15:30:00Z');
    expect(forge.nightly.watch.at).toBe('2026-11-02T03:25:00Z');
    expect(failing(judgeForge(forge, { slug: target.slug, head: 'abc1234def', now: NOW }))).toEqual([]);
    // Read-only: nothing but reads went to gh.
    const calls = target.github().calls.map((call) => call.argv.slice(0, 2).join(' '));
    expect(calls.every((call) => /^(repo view|api repos|secret list|run list|run view)/.test(call))).toBe(true);
  });

  it('refuses a backup environment open to every branch, a missing secret, a red deploy', () => {
    const { target, read: forge } = read();
    const open = { ...forge, environments: { ...forge.environments, backup: { ...forge.environments.backup, customBranches: false, branches: [] } } };
    expect(failing(judgeForge(open, { slug: target.slug, head: null, now: NOW }))).toEqual([expect.stringContaining('toutes les branches')]);
    const unsealed = { ...forge, secrets: { ...forge.secrets, production: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] } };
    expect(failing(judgeForge(unsealed, { slug: target.slug, head: null, now: NOW }))).toEqual([expect.stringContaining('SHOPCTL_BACKUP_KEY')]);
    const red = { ...forge, deploy: { ...forge.deploy, conclusion: 'failure' } };
    expect(failing(judgeForge(red, { slug: target.slug, head: null, now: NOW }))).toEqual([expect.stringContaining('failure')]);
    const unreviewed = { ...forge, environments: { ...forge.environments, production: { ...forge.environments.production, reviewers: 0 } } };
    expect(statuses(judgeForge(unreviewed, { slug: target.slug, head: null, now: NOW }))[0]).toBe('warn');
  });

  // A nightly whose token is missing exits green with a warning (nightly.yml):
  // its job is green and its backup never ran. Only the step says so.
  it('refuses a nightly that is green without having backed up, and one that stopped running', () => {
    const { target, read: forge } = read();
    const tokenless = { ...forge, nightly: { ...forge.nightly, backup: { ...forge.nightly.backup, steps: [{ name: 'Verify the archive', conclusion: 'skipped' }] } } };
    expect(failing(judgeForge(tokenless, { slug: target.slug, head: null, now: NOW }))).toEqual([expect.stringContaining('Verify the archive')]);
    const later = new Date(NOW.getTime() + (NIGHTLY_MAX_AGE_HOURS + 1) * 3_600_000);
    expect(failing(judgeForge(forge, { slug: target.slug, head: null, now: later }))).toHaveLength(2);
  });

  it('warns when the tree judged is not the commit production runs', () => {
    const { target, read: forge } = read();
    expect(statuses(judgeForge(forge, { slug: target.slug, head: '9999999aaa', now: NOW }))).toContain('warn');
  });

  // The job and step names certify looks for are the workflows' own.
  it('looks for the jobs and steps the workflows actually name', () => {
    const nightly = readFileSync(join(CORE, '.github/workflows/nightly.yml'), 'utf8');
    const backup = nightly.slice(nightly.indexOf('  production-backup:'), nightly.indexOf('  production-watch:'));
    const watch = nightly.slice(nightly.indexOf('  production-watch:'));
    expect(backup).toMatch(/name: Production backup\n/);
    expect(backup).toMatch(/- name: Verify the archive\n/);
    expect(watch).toMatch(/name: Production error rate and quotas\n/);
    expect(watch).toMatch(/- name: Install dependencies\n\s+if: \$\{\{ env\.CLOUDFLARE_API_TOKEN != '' \}\}/);
    expect(readFileSync(join(CORE, '.github/workflows/deploy.yml'), 'utf8')).toMatch(/name: Deploy \$\{\{ inputs\.shop \}\} \(\$\{\{ inputs\.environment \}\}\)/);
  });

  // The fleet's workflows (ADR 0019) name the shop in each matrix job.
  it('looks for the jobs and steps the fleet\'s workflows actually name', () => {
    const nightly = readFileSync(join(CORE, 'shopctl/templates/fleet/nightly.yml'), 'utf8');
    const backup = nightly.slice(nightly.indexOf('  production-backup:'), nightly.indexOf('  production-watch:'));
    const watch = nightly.slice(nightly.indexOf('  production-watch:'));
    expect(backup).toMatch(/name: Production backup \(\$\{\{ matrix\.slug \}\}\)\n/);
    expect(backup).toMatch(/- name: Verify the archive\n/);
    expect(watch).toMatch(/name: Production error rate and quotas \(\$\{\{ matrix\.slug \}\}\)\n/);
    expect(watch).toMatch(/- name: Install dependencies\n/);
    expect(readFileSync(join(CORE, 'shopctl/templates/fleet/deploy.yml'), 'utf8')).toMatch(/name: Deploy \$\{\{ inputs\.shop \}\} \(\$\{\{ inputs\.environment \}\}\)/);
  });

  // On the shared account (ADR 0019) a shop's repository holds no Cloudflare
  // secret and a variable naming the fleet; everything else is read there.
  describe('a shop of the fleet', () => {
    const FLEET = 'agence/minshop-fleet';
    const readFleet = ({ shopPatch = {}, entry = undefined } = {}) => {
      const target = shop({ forge: true, slug: 'atelier-forge' });
      const fleet = forgeState(FLEET, target.slug)[FLEET];
      fleet.runs = fleet.runs.map((run) => ({
        ...run,
        jobs: run.jobs.map((candidate) => (candidate.name.startsWith('Production') ? { ...candidate, name: `${candidate.name} (${target.slug})` } : candidate)),
      }));
      const listed = entry === undefined ? { slug: target.slug, path: 'shop-atelier-forge', repository: target.nameWithOwner } : entry;
      fleet.files = { 'fleet.json': JSON.stringify({ schemaVersion: 1, shops: listed ? [listed] : [{ slug: 'autre', path: 'x' }] }) };
      target.github({
        repos: {
          [target.nameWithOwner]: { visibility: 'public', defaultBranch: 'main', branches: ['main'], variables: { MINSHOP_FLEET: FLEET }, secrets: {}, environments: {}, ...shopPatch },
          [FLEET]: fleet,
        },
      });
      process.env.PATH = `${target.binDir}:${previous.PATH}`;
      process.env.GH_DOUBLE_STATE = target.ghState;
      return { target, read: readForge(target.nameWithOwner, { cwd: target.root, slug: target.slug }) };
    };

    it('reads the fleet repository, this shop\'s jobs in it, and its line of fleet.json', () => {
      const { target, read: forge } = readFleet();
      expect(forge.fleet).toEqual({ repository: FLEET, shop: target.nameWithOwner, registry: 'read', entry: { slug: target.slug, repository: target.nameWithOwner }, leftovers: [] });
      expect(forge.environments.production).toMatchObject({ reviewers: 1 });
      expect(forge.nightly.backup.at).toBe('2026-11-02T15:30:00Z');
      expect(forge.nightly.watch.at).toBe('2026-11-02T03:25:00Z');
      // The fleet's run carries the fleet's commit: no warning against the shop's.
      const findings = judgeForge(forge, { slug: target.slug, head: '9999999aaa', now: NOW });
      expect(failing(findings)).toEqual([]);
      expect(findings.map((finding) => finding.message)).toEqual(expect.arrayContaining([
        `déployée par le dépôt de flotte ${FLEET}`,
        'aucun secret Cloudflare dans le dépôt de la boutique',
      ]));
    });

    it('refuses a Cloudflare secret left in the shop\'s repository, with the command that removes it', () => {
      const { target, read: forge } = readFleet({
        shopPatch: { secrets: { MONITOR_CLOUDFLARE_API_TOKEN: 'x' }, environments: { production: { secrets: { CLOUDFLARE_API_TOKEN: 'x' } } } },
      });
      expect(forge.fleet.leftovers).toEqual([{ env: null, name: 'MONITOR_CLOUDFLARE_API_TOKEN' }, { env: 'production', name: 'CLOUDFLARE_API_TOKEN' }]);
      const [finding] = judgeForge(forge, { slug: target.slug, head: null, now: NOW }).filter((entry) => entry.status === 'fail');
      expect(finding.message).toMatch(/porte encore MONITOR_CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_TOKEN \(production\)/);
      expect(finding.hint).toContain(`gh secret delete CLOUDFLARE_API_TOKEN --env production --repo ${target.nameWithOwner}`);
    });

    it('refuses a shop the fleet does not list, or lists with another repository', () => {
      const absent = readFleet({ entry: null });
      expect(failing(judgeForge(absent.read, { slug: absent.target.slug, head: null, now: NOW }))).toEqual([expect.stringContaining("n'est pas inscrite")]);
      const elsewhere = readFleet({ entry: { slug: 'atelier-forge', path: 'x', repository: 'agence/autre-depot' } });
      expect(failing(judgeForge(elsewhere.read, { slug: elsewhere.target.slug, head: null, now: NOW }))).toEqual([expect.stringContaining('avec le dépôt agence/autre-depot')]);
    });
  });
});

// ── the attestations ────────────────────────────────────────────────────────

const MANIFEST = { client: { slug: 'atelier' }, commerce: { invoiceStrategy: 'stripe-receipt' } };
const FILLED = `purchase:
  date: 2026-10-30
  payment: pi_3QabcdEFghIJkl
  refunded: 2026-10-31
emails:
  date: 2026-10-30
  clients: "Gmail, Outlook"
phone:
  date: 2026-10-30
  device: "iPhone 13, Safari"
acceptance:
  date: 2026-10-31
  by: merchant
legal:
  date: 2026-10-29
  by: counsel
accounting:
  date: 2026-10-28
  strategy: stripe-receipt
`;
const judge = (text, today = '2026-11-03') => judgeAttestations(text, { manifest: MANIFEST, today });

describe('the attestations', () => {
  it('counts the template as six things to attest, never as attested', () => {
    expect(statuses(judge(ATTESTATIONS_TEMPLATE).findings)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(statuses(judge(null).findings)).toEqual(['todo']);
  });

  it('accepts six dated references', () => {
    expect(failing(judge(FILLED).findings)).toEqual([]);
  });

  // The file is committed, in a repository that may be public.
  it('refuses an address in any field', () => {
    const findings = judge(FILLED.replace('"Gmail, Outlook"', '"jeanne@example.fr"')).findings;
    expect(findings[0]).toMatchObject({ status: 'fail', message: expect.stringContaining('emails.clients') });
  });

  it('refuses a date in the future, a refund before the purchase, a payment that is not one', () => {
    expect(failing(judge(FILLED.replace('date: 2026-10-31\n  by: merchant', 'date: 2026-11-04\n  by: merchant')).findings)).toEqual([expect.stringContaining('futur')]);
    expect(failing(judge(FILLED.replace('refunded: 2026-10-31', 'refunded: 2026-10-29')).findings)).toEqual([expect.stringContaining('précède')]);
    expect(failing(judge(FILLED.replace('pi_3QabcdEFghIJkl', 'ch_3Qabcd')).findings)).toEqual([expect.stringContaining('pi_')]);
    expect(failing(judge(FILLED.replace('date: 2026-10-28', 'date: 2026-02-30')).findings)).toEqual([expect.stringContaining('AAAA-MM-JJ')]);
  });

  it('refuses what the schema does not know, and a strategy the manifest does not declare', () => {
    expect(failing(judge(`${FILLED}extra:\n  date: 2026-10-30\n`).findings)).toEqual([expect.stringContaining('section inconnue')]);
    expect(failing(judge(FILLED.replace('  by: counsel', '  by: counsel\n  reviewer: "cabinet"')).findings)).toEqual([expect.stringContaining('champ inconnu')]);
    expect(failing(judge(FILLED.replace('strategy: stripe-receipt', 'strategy: invoice')).findings)).toEqual([expect.stringContaining('commerce.invoiceStrategy')]);
  });

  it('counts a half-filled section as still to do', () => {
    expect(judge(FILLED.replace('device: "iPhone 13, Safari"', 'device: ""')).findings.find((finding) => finding.status !== 'ok')).toMatchObject({ status: 'todo', message: expect.stringContaining('phone.device') });
  });

  it('hands the declared divergences to the core check', () => {
    expect(judge(`${FILLED}core:\n  divergences: 2\n  reason: "bandeau du commerçant, rendu au socle en v0.4"\n`).core).toEqual({ divergences: 2, reason: 'bandeau du commerçant, rendu au socle en v0.4' });
  });
});

// ── the command ─────────────────────────────────────────────────────────────

describe('shopctl certify', () => {
  const sink = () => ({ text: '', write(chunk) { this.text += chunk; return true; } });
  const run = async (groups, { values = {}, attestations = FILLED, now = NOW } = {}) => {
    const target = shop({ slug: 'atelier-cmd' });
    // The accountant has answered: the attestation and the manifest agree.
    const manifest = join(target.root, 'client/client.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('invoiceStrategy: pending-validation', 'invoiceStrategy: stripe-receipt'));
    if (attestations !== null) {
      mkdirSync(join(target.root, 'client/certification'), { recursive: true });
      writeFileSync(join(target.root, ATTESTATIONS_FILE), attestations);
    }
    const out = sink();
    const reporter = new Reporter({ json: true, stdout: out, stderr: sink() });
    const attestationsGroup = GROUPS.find((group) => group.id === 'attestations');
    let code;
    try {
      code = await runCertify({ positionals: [], values: { '--env': 'production', '--json': true, ...values } }, reporter, {
        cwd: target.root,
        now,
        groups: [...groups, attestationsGroup],
      });
    } catch (error) {
      code = error.code;
    }
    return { target, code, document: JSON.parse(out.text) };
  };
  const green = { id: 'a', title: 'A', run: () => [{ status: 'ok', message: 'vert' }] };

  it('refuses to run without --env, or on staging', async () => {
    await expect(runCertify({ positionals: [], values: {} }, new Reporter({ stdout: sink(), stderr: sink() }))).rejects.toMatchObject({ code: EXIT_CODES.usage });
    await expect(runCertify({ positionals: [], values: { '--env': 'staging' } }, new Reporter({ stdout: sink(), stderr: sink() }))).rejects.toMatchObject({ code: EXIT_CODES.usage });
  });

  it('certifies when every group is green and the six attestations are made', async () => {
    const { code, document } = await run([green]);
    expect(code).toBe(EXIT_CODES.ok);
    expect(document).toMatchObject({ command: 'certify', certified: true, shop: 'atelier-cmd', origin: 'https://boutique.example.fr', date: '2026-11-03' });
    expect(document.counts).toMatchObject({ ok: 7, fail: 0, todo: 0, skip: 0 });
  });

  // A warning is said and does not block; a failure, an attestation to make
  // or a check that did not run each refuse the verdict, with exit 6.
  it('refuses on a failure, an attestation still to make, or a skipped check — and still says everything', async () => {
    const warned = await run([{ id: 'w', title: 'W', run: () => [{ status: 'warn', message: 'à lire' }] }]);
    expect(warned.code).toBe(EXIT_CODES.ok);
    for (const status of ['fail', 'skip']) {
      const refused = await run([{ id: 'x', title: 'X', run: () => [{ status, message: 'non' }] }, green]);
      expect(refused.code, status).toBe(EXIT_CODES.verification);
      expect(refused.document.groups.map((group) => group.id)).toEqual(['x', 'a', 'attestations']);
    }
    expect((await run([green], { attestations: null })).code).toBe(EXIT_CODES.verification);
  });

  it('reports a group it could not ask as skipped, and runs the next one', async () => {
    const unreachable = { id: 'forge', title: 'Dépôt', run: () => { throw preconditionError('gh est absent du PATH.', 'Installez-le.'); } };
    const { code, document } = await run([unreachable, green]);
    expect(code).toBe(EXIT_CODES.verification);
    expect(document.groups[0].findings).toEqual([{ status: 'skip', message: 'gh est absent du PATH.', hint: 'Installez-le.' }]);
    expect(document.groups[1].findings[0].status).toBe('ok');
  });

  // An account Cloudflare names after its owner, a message quoting a value:
  // nothing in a committed report carries an address.
  it('writes the report, and the attestations template when there is none, with no address in either', async () => {
    const named = { id: 'account', title: 'Compte', run: () => [{ status: 'ok', message: "compte jeanne.durand@example.fr's Account (a1b2)" }] };
    const { target, document } = await run([named], { values: { '--write': true }, attestations: null });
    expect(document.written).toEqual(['client/certification/2026-11-03/certify.json', 'client/certification/2026-11-03/certify.md', ATTESTATIONS_FILE]);
    const json = readFileSync(join(target.root, 'client/certification/2026-11-03/certify.json'), 'utf8');
    const markdown = readFileSync(join(target.root, 'client/certification/2026-11-03/certify.md'), 'utf8');
    expect(json).not.toContain('jeanne');
    expect(markdown).not.toContain('jeanne');
    expect(markdown).toContain("<email>'s Account");
    expect(markdown).toMatch(/Verdict : \*\*non certifiable\*\*/);
    expect(readFileSync(join(target.root, ATTESTATIONS_FILE), 'utf8')).toBe(ATTESTATIONS_TEMPLATE);
  });

  it('dates the attestations in the shop’s own time zone', async () => {
    // 23:30 UTC on 2 November is already the 3rd in Paris: an attestation of
    // the 3rd is not in the future there.
    const late = new Date('2026-11-02T23:30:00Z');
    const { document } = await run([green], { now: late, attestations: FILLED.replace('date: 2026-10-31\n  by: merchant', 'date: 2026-11-03\n  by: merchant') });
    expect(document.date).toBe('2026-11-03');
    expect(document.certified).toBe(true);
  });

  it('renders every finding, with its hint, in the committed report', () => {
    const markdown = renderMarkdown({
      shop: 'atelier',
      date: '2026-11-03',
      checkedAt: NOW.toISOString(),
      origin: 'https://atelier-durand.fr',
      certified: false,
      core: { tag: 'v0.3.29', floor: CERTIFIED_FLOOR },
      counts: verdictOf([{ findings: [{ status: 'fail' }] }]).counts,
      groups: [{ title: 'Base', findings: [{ status: 'fail', message: 'Turnstile est coupé.', hint: 'Réglages →\n    Protection.' }] }],
    });
    expect(markdown).toContain('## Base\n\n- ✗ Turnstile est coupé.\n  Réglages → Protection.');
  });
});

// ── the account and the database, against the wrangler double ──────────────

describe('the account and database groups', () => {
  // In-process: `provision` resolves the shop from the working directory, and
  // wrangler reads its double's state from this process's environment.
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  afterEach(() => {
    process.chdir(saved.cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
  });

  it('judges a provisioned production through provision\u2019s dry run and a masked read, and writes nothing to the account', async () => {
    const target = shop({ migrations: true, slug: 'atelier-compte' });
    expect(target.run(['provision', '--env', 'production']).status).toBe(EXIT_CODES.ok);
    target.account({ workers: [{ name: names('atelier-compte', 'production').worker, secrets: ['AUTH_SECRET', 'SECRETS_KEK'], versions: [] }] });
    target.sql([
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('setup_complete', '1');",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', 'pbkdf2$1$c2Vs$aGFzaA');",
    ]);
    const before = target.read().calls.length;

    Object.assign(process.env, OPERATOR_ENV, { WRANGLER_DOUBLE_STATE: target.statePath });
    process.chdir(target.root);
    const out = { text: '', write(chunk) { this.text += chunk; return true; } };
    await runCertify(
      { positionals: [], values: { '--env': 'production', '--json': true } },
      new Reporter({ json: true, stdout: out, stderr: { write: () => true } }),
      { now: NOW, groups: GROUPS.filter((group) => group.id === 'account' || group.id === 'database') },
    ).catch((error) => expect(error.code).toBe(EXIT_CODES.verification));

    const [account, database] = JSON.parse(out.text).groups;
    expect(account.findings.filter((finding) => finding.status === 'fail')).toEqual([]);
    expect(account.findings).toContainEqual({ status: 'ok', message: 'secrets internes du Worker présents (AUTH_SECRET, SECRETS_KEK)' });
    // Installed and locked; nothing else configured, each said by name.
    expect(database.findings.slice(0, 2).map((finding) => finding.status)).toEqual(['ok', 'ok']);
    expect(database.findings.filter((finding) => finding.status === 'fail').map((finding) => finding.message).join(' ')).toMatch(/Stripe.*resend\.dev.*alertes.*Turnstile/);
    // Reads only: no create, put, delete or migration since provisioning.
    const commands = target.read().calls.slice(before).map((call) => call.argv.slice(0, 2).join(' '));
    expect(commands.filter((command) => /create|put|delete|migrations apply|execute.*--file/.test(command))).toEqual([]);
  });
});

// ── the public group, end to end against a shop in this process ─────────────

describe('the public group', () => {
  let server;
  afterEach(async () => {
    if (server) {
      server.close();
      await once(server, 'close');
      server = null;
    }
  });

  it('reads the pages, runs the gates and measures four pages through PageSpeed Insights', async () => {
    const measured = [];
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname === '/psi') {
        measured.push(new URL(url.searchParams.get('url')).pathname);
        expect(url.searchParams.get('strategy')).toBe('mobile');
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify(pageSpeedAnswer()));
      }
      if (url.pathname === '/sitemap.xml') {
        return response.end(`<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/products/bague</loc></url><url><loc>${origin}/categories/bijoux</loc></url></urlset>`);
      }
      if (url.pathname === '/') return response.end(home().body);
      if (url.pathname.startsWith('/pages/')) return response.end(legal()['mentions-legales'].body);
      response.statusCode = 404;
      response.end('');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;

    const target = shop({ slug: 'atelier-vitrine' });
    mkdirSync(join(target.root, 'test/remote'), { recursive: true });
    writeFileSync(join(target.root, 'test/remote/security.mjs'), '');
    const out = { text: '', write(chunk) { this.text += chunk; return true; } };
    const gates = [];
    let code;
    try {
      code = await runCertify(
        { positionals: [], values: { '--env': 'production', '--json': true, '--url': origin } },
        new Reporter({ json: true, stdout: out, stderr: { write: () => true } }),
        {
          cwd: target.root,
          now: NOW,
          groups: [GROUPS.find((group) => group.id === 'public')],
          env: { PAGESPEED_API_URL: `${origin}/psi` },
          smoke: async () => ({ results: [{ ok: true }, { ok: true }] }),
          spawn: async (command, args, options) => {
            gates.push(options.env.BASE_URL);
            return { status: 0, stdout: '12 contrôle(s) passé(s), 0 en échec.\n', stderr: '' };
          },
        },
      );
    } catch (error) {
      code = error.code;
    }
    const findings = JSON.parse(out.text).groups[0].findings;
    expect(gates).toEqual([origin]);
    expect(measured).toEqual(['/', '/categories/bijoux', '/products/bague', '/cart']);
    // Playwright is not installed in this tree: the one line that is not
    // green, and it is a skip, so the shop is not certified on it.
    expect(findings.filter((finding) => finding.status !== 'ok')).toEqual([expect.objectContaining({ status: 'skip', message: expect.stringContaining('Playwright') })]);
    expect(findings.filter((finding) => finding.message.startsWith('Lighthouse'))).toHaveLength(4);
    expect(code).toBe(EXIT_CODES.verification);
    expect(existsSync(join(target.root, 'client/certification'))).toBe(false);
  });
});
