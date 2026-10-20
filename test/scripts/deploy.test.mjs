import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { smokeFailure } from '../../shopctl/src/commands/deploy.mjs';
import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { GATED_CHECKS, SMOKE_CHECKS, evaluateSmoke, originFromDeployOutput, runSmoke } from '../../shopctl/src/smoke.mjs';
import { names, shop } from '../helpers/provisioned-shop.mjs';

vi.setConfig({ testTimeout: 60_000 });

/** The robots.txt `src/pages/robots.txt.ts` serves. */
const SHOP_ROBOTS = 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: https://shop.example/sitemap.xml\n';

/**
 * What Cloudflare answered on a workers.dev name with no Worker behind it,
 * read at step 7 of the certification (2026-10-20): `404` on every path, and
 * its own robots.txt — content signals, comments only — in 200. The first
 * deployment's smoke test met it while the name propagated.
 *
 * The 404 in both its forms: plain text to curl's default request, the HTML
 * page (trimmed here) to a request that accepts compression, as fetch does.
 */
const CLOUDFLARE_404 = { ok: true, status: 404, body: 'error code: 1042', headers: { 'content-type': 'text/plain; charset=UTF-8', server: 'cloudflare' }, error: null };
const CLOUDFLARE_PAGE_BODY = [
  '<!DOCTYPE html>',
  '<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->',
  '<head><title>Page not found</title></head>',
  '<body><div id="cf-wrapper"><div id="cf-error-details">',
  '<h1>There is nothing here yet</h1>',
  '<p>If you expect something to be here, it may take some time. Please check back again later.</p>',
  '</div></div></body></html>',
].join('\n');
const CLOUDFLARE_404_PAGE = { ok: true, status: 404, body: CLOUDFLARE_PAGE_BODY, headers: { 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare' }, error: null };
const CLOUDFLARE_ROBOTS = {
  ok: true,
  status: 200,
  body: '# As a condition of accessing this website, you agree to abide by the following\n# content signals:\n\n# search:   building a search index and providing search results\n# ai-train: training or fine-tuning AI models.\n',
  headers: { 'content-type': 'text/plain; charset=utf-8', server: 'cloudflare' },
  error: null,
};

/**
 * A shop whose environment has already been provisioned.
 *
 * Through the real command rather than by writing the account file directly:
 * what `deploy` reads is what `provision` left, and a fixture that wrote that
 * state by hand would let the two drift apart silently.
 */
function provisioned(env = 'staging', { key = env === 'production', ...options } = {}) {
  const target = shop({ built: true, ...options });
  const result = target.run(['provision', '--env', env]);
  expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
  // A production deployment backs up first, and a backup needs its key. Written
  // the way an operator writes it, so the suite reads the same file they do.
  if (key) expect(target.run(['backup', 'keygen']).status).toBe(EXIT_CODES.ok);
  return target;
}

const FAST = ['--skip-verify', '--skip-build'];

// ---------------------------------------------------------------------------
// The smoke test, decided rather than performed. Every shape a broken
// deployment produces, with no network and no deployed shop.

describe('the smoke test', () => {
  const ok = {
    storefront: { ok: true, status: 200, body: '<!doctype html><html lang="fr" data-locale="fr-FR">', headers: {}, error: null },
    catalogue: { ok: true, status: 200, body: '<h1>Catalogue</h1>', headers: {}, error: null },
    robots: { ok: true, status: 200, body: SHOP_ROBOTS, headers: {}, error: null },
    'admin-closed': { ok: true, status: 303, body: '', headers: {}, error: null },
    'admin-setup-open': { ok: true, status: 303, body: '', headers: {}, error: null },
  };

  it('passes a deployment that serves the French storefront', () => {
    expect(evaluateSmoke(ok).ok).toBe(true);
  });

  // A default Worker placeholder, or another shop entirely, answers 200 on `/`
  // and looks identical without this.
  it('fails a 200 that is not the French storefront', () => {
    const verdict = evaluateSmoke({ ...ok, storefront: { ...ok.storefront, body: '<html lang="en"><body>Hello World' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.results.find((result) => result.id === 'storefront').message).toMatch(/lang="fr"/);
  });

  // A Worker bound to a database that does not exist — a missing binding, or a
  // jurisdiction the binding does not name — still serves the home page.
  it('fails when the catalogue cannot render', () => {
    const verdict = evaluateSmoke({ ...ok, catalogue: { ...ok.catalogue, status: 500 } });
    expect(verdict.ok).toBe(false);
    expect(verdict.results.find((result) => result.id === 'catalogue').message).toMatch(/D1/);
  });

  it('fails an administration that answers 200 unauthenticated', () => {
    const verdict = evaluateSmoke({ ...ok, 'admin-closed': { ...ok['admin-closed'], status: 200 } });
    expect(verdict.ok).toBe(false);
  });

  // The first-run wizard is SUPPOSED to be reachable on a shop with no admin
  // password yet. Failing here would fail every first deployment, and the check
  // would carry a --skip within a week — so it warns, every time, until someone
  // closes it.
  it('warns about an open first-run wizard without failing the deploy', () => {
    const verdict = evaluateSmoke({ ...ok, 'admin-setup-open': { ...ok['admin-setup-open'], status: 200 } });
    expect(verdict.ok).toBe(true);
    const result = verdict.results.find((check) => check.id === 'admin-setup-open');
    expect(result).toMatchObject({ ok: false, severity: 'warn' });
  });

  // Every first deployment no Access application hides — a staging on
  // workers.dev, the first production of every shop — answers this way until
  // someone runs the wizard. Failing it turned each of them red after the
  // upload (found rehearsing certification step 7); passing it silently would
  // vouch for a storefront nobody has seen.
  it('warns, rather than fails, a shop that is not installed yet', () => {
    const toSetup = { ok: true, status: 302, body: '', headers: { location: 'https://shop.example/admin/setup' }, error: null };
    const verdict = evaluateSmoke({
      ...ok,
      storefront: toSetup,
      catalogue: toSetup,
      robots: toSetup,
      'admin-setup-open': { ok: true, status: 200, body: '<html lang="fr">', headers: {}, error: null },
    });
    expect(verdict.ok).toBe(true);
    for (const id of ['storefront', 'catalogue', 'robots']) {
      const result = verdict.results.find((check) => check.id === id);
      expect(result).toMatchObject({ ok: false, severity: 'warn', status: 302 });
      expect(result.message).toMatch(/pas encore installée/);
    }
  });

  // Only the wizard. A redirect anywhere else is still a storefront that does
  // not answer, and a 302 with no destination proves nothing about the base.
  it('still fails a redirect that does not lead to the wizard', () => {
    for (const headers of [{ location: '/admin/login' }, { location: 'https://ailleurs.example/admin/setup-guide' }, {}]) {
      const verdict = evaluateSmoke({ ...ok, storefront: { ok: true, status: 302, body: '', headers, error: null } });
      expect(verdict.ok).toBe(false);
      expect(verdict.results.find((result) => result.id === 'storefront').severity).toBe('fail');
    }
  });

  // The failure this whole module exists to prevent: a deployment announced as
  // green because the check could not reach it.
  it('never reads an unreachable site as a pass', () => {
    const verdict = evaluateSmoke({ ...ok, storefront: { ok: false, status: null, body: '', headers: {}, error: 'ECONNREFUSED' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.results.find((result) => result.id === 'storefront').message).toBe('ECONNREFUSED');
  });

  it('fails a check whose response never arrived', () => {
    expect(evaluateSmoke({}).results.every((result) => !result.ok)).toBe(true);
  });

  // The real first deployment of step 7: a healthy upload failed in code 6,
  // blamed on D1, while two checks passed on answers nobody in the shop gave.
  it('reads Cloudflare’s own answers as a Worker not served yet, never as the shop’s', () => {
    for (const answer of [CLOUDFLARE_404, CLOUDFLARE_404_PAGE]) {
      const verdict = evaluateSmoke({
        storefront: answer,
        catalogue: answer,
        robots: CLOUDFLARE_ROBOTS,
        'admin-closed': answer,
        'admin-setup-open': answer,
      });
      expect(verdict).toMatchObject({ ok: false, notServed: true });
      for (const result of verdict.results) expect(result).toMatchObject({ ok: false, severity: 'fail', notServed: true });
      const catalogue = verdict.results.find((result) => result.id === 'catalogue');
      expect(catalogue.message).toMatch(/There is nothing here yet/);
      expect(catalogue.message).not.toMatch(/D1/);
    }
  });

  // A 404 from nobody is not an administration that is closed.
  it('no longer passes the administration check on Cloudflare’s 404', () => {
    for (const answer of [CLOUDFLARE_404, CLOUDFLARE_404_PAGE]) {
      const verdict = evaluateSmoke({ ...ok, 'admin-closed': answer });
      expect(verdict.ok).toBe(false);
      expect(verdict.results.find((result) => result.id === 'admin-closed')).toMatchObject({ ok: false, notServed: true });
    }
  });

  it('wants the shop’s own robots.txt, not any 200', () => {
    const verdict = evaluateSmoke({ ...ok, robots: CLOUDFLARE_ROBOTS });
    expect(verdict).toMatchObject({ ok: false, notServed: true });
    expect(verdict.results.find((result) => result.id === 'robots').message).toMatch(/Disallow: \/admin/);
  });

  // Only Cloudflare's own answer is waited out. A shop that answers and is
  // broken is the version's fault, and the verdict says so at once.
  it('does not mistake a broken shop for one not served yet', () => {
    const verdict = evaluateSmoke({ ...ok, catalogue: { ...ok.catalogue, status: 404, body: '<html lang="fr">Introuvable' } });
    expect(verdict).toMatchObject({ ok: false, notServed: false });
  });

  // Two failures, two remedies. Step 7 was told to roll back a version that
  // was fine, on a name Cloudflare did not serve yet.
  it('advises a rollback only for a shop that answered', () => {
    const notServed = smokeFailure({ smoke: { notServed: true }, origin: 'https://w.example.workers.dev', worker: 'w', env: 'staging', rollback: 'v1', waitSeconds: 120 });
    expect(notServed.message).toMatch(/Cloudflare ne sert toujours pas w .* après 120 s/);
    expect(notServed.hint).toMatch(/deploy --env staging --skip-verify --skip-build/);
    expect(notServed.hint).not.toMatch(/rollback/);

    const broken = smokeFailure({ smoke: { notServed: false }, origin: 'https://w.example.workers.dev', worker: 'w', env: 'staging', rollback: 'v1', waitSeconds: 120 });
    expect(broken.hint).toMatch(/wrangler rollback v1 --name w/);
  });

  it('reads the deployed origin out of wrangler’s own output', () => {
    const output = [
      'Total Upload: 512.00 KiB / gzip: 128.00 KiB',
      'Uploaded minshop-atelier-staging (2.11 sec)',
      'Deployed minshop-atelier-staging triggers (0.42 sec)',
      '  https://minshop-atelier-staging.agence.workers.dev',
      'Current Version ID: 00000000-0000-0000-0000-000000000002',
    ].join('\n');
    expect(originFromDeployOutput(output)).toBe('https://minshop-atelier-staging.agence.workers.dev');
  });

  it('returns no origin rather than a guess when wrangler announces none', () => {
    expect(originFromDeployOutput('Total Upload: 512.00 KiB\nUploaded worker')).toBeNull();
  });

  // What wrangler 4 prints once workers.dev is shut: the custom domain bare,
  // no scheme, and no workers.dev line at all (renderRoute in its
  // deploy-helpers). Read as the shop's origin, never the link in a warning.
  it('reads a custom domain, which wrangler lists without a scheme', () => {
    const output = [
      '▲ [WARNING] See https://developers.cloudflare.com/workers/configuration/routing/',
      'Uploaded minshop-atelier-staging (2.11 sec)',
      'Deployed minshop-atelier-staging triggers (0.42 sec)',
      '  preview.boutique.example.fr (custom domain)',
      '  schedule: */5 * * * *',
    ].join('\n');
    expect(originFromDeployOutput(output)).toBe('https://preview.boutique.example.fr');
    expect(originFromDeployOutput(output.split('\n').filter((line) => !line.includes('custom domain')).join('\n'))).toBeNull();
  });
});

/**
 * A private preview asks the opposite question of a public shop.
 *
 * The failure it exists to catch is the one that looks like success: a staging
 * URL the client was sent, that a search engine also found, serving a shop that
 * has not launched.
 */
describe('the smoke test on a gated preview', () => {
  const answer = (status) => ({ gated: { ok: true, status, body: '', headers: {}, error: null } });

  it('passes on anything that stands in front of the shop', () => {
    for (const status of [302, 401, 403]) {
      expect(evaluateSmoke(answer(status), GATED_CHECKS).ok).toBe(true);
    }
  });

  it('fails on the one answer that means nothing does', () => {
    const verdict = evaluateSmoke(answer(200), GATED_CHECKS);
    expect(verdict.ok).toBe(false);
    expect(verdict.results[0].message).toMatch(/publique/);
  });

  it('still refuses to read an unreachable origin as closed', () => {
    const verdict = evaluateSmoke({ gated: { ok: false, status: null, body: '', headers: {}, error: 'ETIMEDOUT' } }, GATED_CHECKS);
    expect(verdict.ok).toBe(false);
  });

  // A 404 is "not 200", and so it passed: but nothing stands in front of a
  // name Cloudflare does not route — there is nothing behind it either.
  it('does not read Cloudflare’s 404 as a closed preview', () => {
    for (const answer of [CLOUDFLARE_404, CLOUDFLARE_404_PAGE]) {
      expect(evaluateSmoke({ gated: answer }, GATED_CHECKS)).toMatchObject({ ok: false, notServed: true });
    }
  });
});

describe('the smoke test against a live origin', () => {
  let server;
  let origin;
  const routes = new Map();
  // How many more requests Cloudflare answers instead of the Worker, as on a
  // name still propagating; -1 for a name that never gets there.
  let unserved = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (unserved !== 0) {
        if (unserved > 0) unserved -= 1;
        // As Cloudflare does: the page to a request that accepts compression,
        // which fetch always sends, the plain-text code otherwise.
        return /gzip|br/.test(request.headers['accept-encoding'] ?? '')
          ? response.writeHead(404, { 'content-type': 'text/html; charset=UTF-8' }).end(CLOUDFLARE_PAGE_BODY)
          : response.writeHead(404, { 'content-type': 'text/plain; charset=UTF-8' }).end('error code: 1042');
      }
      const route = routes.get(new URL(request.url, 'http://x').pathname);
      if (!route) return response.writeHead(404).end('not found');
      response
        .writeHead(route.status, { 'content-type': 'text/html', ...(route.location ? { location: route.location } : {}) })
        .end(route.body ?? '');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('fetches every path and agrees with the pure evaluation', async () => {
    routes.set('/', { status: 200, body: '<!doctype html><html lang="fr">' });
    routes.set('/products', { status: 200, body: 'ok' });
    routes.set('/robots.txt', { status: 200, body: SHOP_ROBOTS });
    routes.set('/admin', { status: 303 });
    routes.set('/admin/setup', { status: 303 });

    const report = await runSmoke(origin);
    expect(report.ok).toBe(true);
    expect(report.attempts).toBe(1);
    expect(report.results.map((result) => result.path)).toEqual(SMOKE_CHECKS.map((check) => check.path));
  });

  // The first deployment of step 7, replayed: the whole test runs again while
  // Cloudflare answers, then judges the shop once it is served. Six requests
  // unserved, so the second run still meets one — a name propagating answers
  // from some edges and not others.
  it('waits while Cloudflare answers for a new name, then judges the shop', async () => {
    unserved = SMOKE_CHECKS.length + 1;
    const waits = [];
    const report = await runSmoke(origin, { waitMs: 5_000, intervalMs: 10, onWait: (wait) => waits.push(wait) });
    expect(report).toMatchObject({ ok: true, notServed: false, attempts: 3 });
    expect(waits.map((wait) => wait.attempts)).toEqual([1, 2]);
  });

  it('gives up after the wait, on a verdict that names Cloudflare', async () => {
    unserved = -1;
    try {
      const report = await runSmoke(origin, { waitMs: 50, intervalMs: 10 });
      expect(report).toMatchObject({ ok: false, notServed: true });
      expect(report.attempts).toBeGreaterThan(1);
      expect(report.results.every((result) => result.message?.includes('error code: 1042'))).toBe(true);
    } finally {
      unserved = 0;
    }
  });

  // Without a wait, as before: one run, whatever it meets.
  it('does not wait unless asked to', async () => {
    unserved = -1;
    try {
      const report = await runSmoke(origin, { onWait: () => { throw new Error('waited'); } });
      expect(report).toMatchObject({ ok: false, notServed: true, attempts: 1 });
    } finally {
      unserved = 0;
    }
  });

  // A broken shop answers; waiting would only delay what the operator has to see.
  it('does not wait on a shop that answers and is broken', async () => {
    routes.set('/products', { status: 500, body: 'erreur' });
    try {
      const report = await runSmoke(origin, { waitMs: 5_000, intervalMs: 10, onWait: () => { throw new Error('waited'); } });
      expect(report).toMatchObject({ ok: false, notServed: false, attempts: 1 });
    } finally {
      routes.set('/products', { status: 200, body: 'ok' });
    }
  });

  // `redirect: 'manual'`: following the redirect would report the login page's
  // 200 and turn the check that matters into one that always passes.
  it('does not follow the administration redirect', async () => {
    routes.set('/admin', { status: 302 });
    const report = await runSmoke(origin);
    expect(report.results.find((result) => result.id === 'admin-closed')).toMatchObject({ ok: true, status: 302 });
  });

  // The shape the built Worker gives a fresh database: every storefront path
  // redirects to the wizard, which answers 200. Read off the wire, location
  // header and all, the deployment is a warning and not a failure.
  it('passes, with warnings, a shop whose wizard has not run', async () => {
    for (const path of ['/', '/products', '/robots.txt']) routes.set(path, { status: 302, location: `${origin}/admin/setup` });
    routes.set('/admin', { status: 303, location: '/admin/setup' });
    routes.set('/admin/setup', { status: 200, body: '<!doctype html><html lang="fr">' });

    const report = await runSmoke(origin);
    expect(report.ok).toBe(true);
    expect(report.results.filter((result) => !result.ok).map((result) => result.id)).toEqual([
      'storefront',
      'catalogue',
      'robots',
      'admin-setup-open',
    ]);
  });

  it('runs the gated checks instead when the environment is private', async () => {
    routes.set('/', { status: 302 });
    const report = await runSmoke(origin, { gated: true });
    expect(report).toMatchObject({ gated: true, ok: true });
    expect(report.results.map((result) => result.id)).toEqual(['gated']);
  });

  it('fails a private environment that answers 200 to a stranger', async () => {
    routes.set('/', { status: 200, body: '<!doctype html><html lang="fr">' });
    expect((await runSmoke(origin, { gated: true })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('shopctl deploy', () => {
  it('refuses to run without --env', () => {
    const result = shop().run(['deploy']);
    expect(result.status).toBe(EXIT_CODES.usage);
    expect(result.stderr).toMatch(/--env est obligatoire/);
  });

  // Before anything slow: a typo should not cost a verification run.
  it('refuses a smoke wait that is not a number of seconds', () => {
    const target = provisioned();
    for (const value of ['abc', '-1', '1.5', '601']) {
      const result = target.run(['deploy', '--env', 'staging', ...FAST, '--smoke-wait', value]);
      expect(result.status, value).toBe(EXIT_CODES.usage);
      expect(result.stderr).toMatch(/--smoke-wait/);
    }
    expect(target.read().deploys ?? []).toEqual([]);
  });

  // Production is never a default and never an accident.
  it('refuses production without an explicit confirmation', () => {
    const target = provisioned('production');
    const result = target.run(['deploy', '--env', 'production', ...FAST]);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/confirmation explicite/);
    expect(target.read().deploys ?? []).toEqual([]);
  });

  // A deployment creates nothing: resource creation carries an irreversible
  // jurisdiction (ADR 0004) and has no place in a path replayed at every commit.
  it('refuses to deploy an environment that was never provisioned', () => {
    const target = shop({ built: true });
    const result = target.run(['deploy', '--env', 'staging', ...FAST]);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/shopctl provision --env staging/);
  });

  it('refuses when the private bucket has become public since provisioning', () => {
    const target = provisioned();
    const expected = names(target.slug, 'staging');
    const state = target.read();
    target.account({
      r2: state.r2.map((bucket) => (bucket.name === expected.files ? { ...bucket, devUrl: 'https://pub-abc.r2.dev' } : bucket)),
    });
    const result = target.run(['deploy', '--env', 'staging', ...FAST]);
    expect(result.status).toBe(EXIT_CODES.verification);
    expect(result.stderr).toMatch(/devenu public/);
    expect(target.read().deploys ?? []).toEqual([]);
  });

  it('refuses --skip-build when there is no build to reuse', () => {
    const target = provisioned('staging', { built: false });
    const result = target.run(['deploy', '--env', 'staging', '--skip-verify', '--skip-build']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/dist\/server/);
  });

  describe('--dry-run', () => {
    it('checks everything and uploads nothing', () => {
      const target = provisioned();
      const before = target.read();
      const { report, status } = target.json(['deploy', '--env', 'staging', '--dry-run', ...FAST]);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.dryRun).toBe(true);
      const after = target.read();
      expect(after.deploys ?? []).toEqual([]);
      expect(after.migrationsApplied).toBe(before.migrationsApplied);
    });

    it('needs no confirmation for production, because it changes nothing', () => {
      const target = provisioned('production');
      expect(target.run(['deploy', '--env', 'production', '--dry-run', ...FAST]).status).toBe(EXIT_CODES.ok);
    });
  });

  describe('a staging deployment', () => {
    // The custom domain and workers.dev are one decision, and production is the
    // only environment that gets it: a shop reachable on two origins is one the
    // merchant never advertised.
    it('renders production behind its own domain, and staging on workers.dev', () => {
      const target = provisioned('production');
      target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      const production = readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8');
      expect(production).toContain('"workers_dev": false');
      expect(production).toContain('"custom_domain":true');

      target.run(['provision', '--env', 'staging']);
      target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      const staging = readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8');
      expect(staging).toContain('"workers_dev": true');
      expect(staging).toContain('"routes": []');
    });

    // Behind Access every request carries an assertion, and a Worker with
    // nothing to verify it against refuses it — /admin/setup included. The
    // application rides on the staging Worker only.
    it('gives a private preview the Access application in front of it, and production none', () => {
      const aud = 'c'.repeat(64);
      const access = { stagingDomain: 'preview.boutique.example.fr', stagingAccessTeam: 'agence', stagingAccessAud: aud };
      const target = provisioned('staging', { cloudflare: access });
      const result = target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
      expect(result.stdout).not.toMatch(/stagingAccessTeam/);
      const staging = readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8');
      expect(staging).toContain('"CF_ACCESS_TEAM_DOMAIN": "https://agence.cloudflareaccess.com"');
      expect(staging).toContain(`"CF_ACCESS_AUD": "${aud}"`);

      expect(target.run(['provision', '--env', 'production']).status).toBe(EXIT_CODES.ok);
      expect(target.run(['backup', 'keygen']).status).toBe(EXIT_CODES.ok);
      expect(target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']).status).toBe(EXIT_CODES.ok);
      const production = readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8');
      expect(production).toContain('"CF_ACCESS_TEAM_DOMAIN": ""');
      expect(production).toContain('"CF_ACCESS_AUD": ""');
    });

    // Not a refusal — the preview is still private — but the first run of the
    // wizard will answer 403, and that is better read in the deploy report
    // than discovered on the client's screen.
    it('warns about a private preview that declares no Access application', () => {
      const target = provisioned('staging', { cloudflare: { stagingDomain: 'preview.boutique.example.fr' } });
      const result = target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
      expect(result.stdout + result.stderr).toMatch(/sans cloudflare\.stagingAccessTeam ni cloudflare\.stagingAccessAud/);
      expect(readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8')).toContain('"CF_ACCESS_AUD": ""');
    });

    // The Deploy workflow reads the origin out of this report, so stdout is the
    // report and nothing else — the suite and the build it runs included.
    it('keeps the verification and build output off a --json report', () => {
      const target = provisioned();
      const pkg = join(target.root, 'package.json');
      const scripts = { verify: 'node -e "console.log(\'sortie de verify\')"', build: 'node -e "console.log(\'sortie du build\')"' };
      writeFileSync(pkg, JSON.stringify({ ...JSON.parse(readFileSync(pkg, 'utf8')), scripts }, null, 2));
      const result = target.json(['deploy', '--env', 'staging', '--skip-smoke']);
      expect(result.status, result.stderr).toBe(EXIT_CODES.ok);
      expect(result.report.command).toBe('deploy');
      expect(result.stderr).toContain('sortie de verify');
      expect(result.stderr).toContain('sortie du build');
    });

    // The route this command rendered is the origin it tests: a preview behind
    // its hostname, a production behind its domain. Neither is in wrangler's
    // output with a scheme, and workers.dev is shut on both.
    it('smoke-tests a preview at its hostname and a production at its domain', () => {
      const target = provisioned('staging', { cloudflare: { stagingDomain: 'preview.boutique.example.fr' } });
      const staging = target.json(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      expect(staging.status, staging.stderr).toBe(EXIT_CODES.ok);
      expect(staging.report.origin).toBe('https://preview.boutique.example.fr');

      expect(target.run(['provision', '--env', 'production']).status).toBe(EXIT_CODES.ok);
      expect(target.run(['backup', 'keygen']).status).toBe(EXIT_CODES.ok);
      const production = target.json(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      expect(production.status, production.stderr).toBe(EXIT_CODES.ok);
      expect(production.report.origin).toBe('https://boutique.example.fr');
    });

    it('migrates, uploads the environment it was asked for, and reports the origin', () => {
      const target = provisioned();
      const expected = names(target.slug, 'staging');
      const before = target.read().migrationsApplied ?? 0;

      const { report, status } = target.json(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.origin).toBe(`https://${expected.worker}.example.workers.dev`);

      const after = target.read();
      expect(after.deploys).toEqual([expected.worker]);
      expect(after.migrationsApplied).toBe(before + 1);
      expect(readFileSync(join(target.root, 'wrangler.jsonc'), 'utf8')).toContain(`"name": "${expected.worker}"`);
    });

    // The loop provisioning could not close: before the first deploy the Worker
    // did not exist, so `secret put` had nothing to attach to.
    it('sets the internal secrets provisioning had to defer', () => {
      const target = provisioned();
      const expected = names(target.slug, 'staging');
      expect(target.json(['provision', '--env', 'staging']).report.secrets.pending).toEqual(['AUTH_SECRET', 'SECRETS_KEK']);

      const { report } = target.json(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      expect(report.secrets.created).toEqual(['AUTH_SECRET', 'SECRETS_KEK']);
      const worker = target.read().workers.find((candidate) => candidate.name === expected.worker);
      expect(worker.secrets).toEqual(['AUTH_SECRET', 'SECRETS_KEK']);
    });

    it('keeps the secrets a second deployment finds', () => {
      const target = provisioned();
      target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      const { report } = target.json(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      expect(report.secrets.created).toEqual([]);
      expect(report.secrets.present).toEqual(['AUTH_SECRET', 'SECRETS_KEK']);
    });

    it('never lets a secret reach an argument or the terminal', () => {
      const target = provisioned();
      const result = target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      const puts = target.read().calls.filter(({ argv }) => argv[0] === 'secret' && argv[1] === 'put');
      expect(puts).toHaveLength(2);
      for (const call of puts) {
        expect(call.argv.join(' ')).not.toContain(call.stdin.trim());
        expect(`${result.stdout}${result.stderr}`).not.toContain(call.stdin.trim());
      }
    });

    it('keeps staging and production on separate workers', () => {
      const target = provisioned();
      target.run(['provision', '--env', 'production']);
      target.run(['backup', 'keygen']);
      target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      expect(target.read().deploys).toEqual([names(target.slug, 'staging').worker, names(target.slug, 'production').worker]);
    });
  });

  describe('a production deployment', () => {
    // Not a backup — ADR 0005 keeps Time Travel as a short-term safety net —
    // but it is the only moment at which a bookmark can still describe the
    // state the deploy started from.
    it('takes a Time Travel bookmark before the migrations', () => {
      const target = provisioned('production');
      // Only this run's calls: provisioning already applied the migrations once,
      // and the ordering under test is the deployment's own.
      const before = target.read().calls.length;
      const { report } = target.json(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      expect(report.bookmark).toBe('00000098-0000000d-00004f8d-example');

      const calls = target.read().calls.slice(before).map(({ argv }) => argv.join(' '));
      const bookmarked = calls.findIndex((call) => call.includes('time-travel'));
      const migrated = calls.findIndex((call) => call.includes('d1 migrations apply'));
      expect(bookmarked).toBeGreaterThan(-1);
      expect(bookmarked).toBeLessThan(migrated);
    });

    it('takes no bookmark in staging', () => {
      const target = provisioned();
      const { report } = target.json(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      expect(report.bookmark).toBeNull();
      expect(report.backup).toBeNull();
    });

    // Plan §9: a deployment is blocked when the preceding backup fails. The
    // bookmark is a net inside one account; the backup is what a restore into a
    // new environment starts from, and the migration is the step after which
    // the previous state is reachable no other way.
    it('takes an encrypted backup before the migrations', () => {
      const target = provisioned('production', { migrations: true });
      const before = target.read().calls.length;
      const { report, status } = target.json(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.backup.id).toMatch(new RegExp(`^${target.slug}-production-`));
      expect(existsSync(join(report.backup.path, 'manifest.json'))).toBe(true);

      // The backup's reads come before the first migration, and the archive is
      // one `backup verify` accepts: the same implementation wrote it.
      const calls = target.read().calls.slice(before).map(({ argv }) => argv.join(' '));
      const read = calls.findIndex((call) => call.includes('d1 execute'));
      const migrated = calls.findIndex((call) => call.includes('d1 migrations apply'));
      expect(read).toBeGreaterThan(-1);
      expect(read).toBeLessThan(migrated);
      expect(target.run(['backup', 'verify', report.backup.id]).status).toBe(EXIT_CODES.ok);

      // And it outlives the runner: the archive is in the environment's own
      // private bucket before the first migration runs.
      const upload = calls.findIndex((call) => call.startsWith(`r2 object put ${names(target.slug, 'production').backups}/`));
      expect(report.backup.uploaded.bucket).toBe(names(target.slug, 'production').backups);
      expect(upload).toBeGreaterThan(read);
      expect(upload).toBeLessThan(migrated);
    });

    it('refuses production when the backups bucket is missing', () => {
      const target = provisioned('production');
      const bucket = names(target.slug, 'production').backups;
      target.account({ r2: target.read().r2.filter((entry) => entry.name !== bucket) });
      const result = target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toContain(bucket);
      expect(target.read().deploys ?? []).toEqual([]);
    });

    // Asked before the verification suite, not after it: a run that cannot
    // back up is not going to deploy, and should not spend three minutes first.
    it('refuses production when there is no backup key, before touching anything', () => {
      const target = provisioned('production', { key: false });
      const before = target.read();
      const result = target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/clé de sauvegarde/);
      const after = target.read();
      expect(after.deploys ?? []).toEqual([]);
      expect(after.migrationsApplied).toBe(before.migrationsApplied);
    });

    it('refuses a production dry run without a backup key too', () => {
      const target = provisioned('production', { key: false });
      expect(target.run(['deploy', '--env', 'production', '--dry-run', ...FAST]).status).toBe(EXIT_CODES.precondition);
    });

    it('stops before the first write when the backup fails', () => {
      const target = provisioned('production', { migrations: true });
      const before = target.read();
      target.account({ failAt: 'd1 execute' });
      const result = target.run(['deploy', '--env', 'production', '--yes', ...FAST, '--skip-smoke']);
      expect(result.status).not.toBe(EXIT_CODES.ok);
      const after = target.read();
      expect(after.deploys ?? []).toEqual([]);
      expect(after.migrationsApplied).toBe(before.migrationsApplied);
      expect(existsSync(join(target.root, 'backups'))).toBe(false);
    });
  });

  describe('when the smoke test fails', () => {
    // A deploy that reports success for a site nobody can reach is worse than
    // one that reports failure, because the second one gets looked at.
    it('fails the command and names the version to roll back to', () => {
      const target = provisioned();
      // The rollback target is the version serving BEFORE this deployment. The
      // first one uploads v1, then each deferred secret is a version of its
      // own: v3 is what served when the second deployment started.
      target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);

      const result = target.json(['deploy', '--env', 'staging', ...FAST, '--url', 'http://127.0.0.1:1']);
      expect(result.status).toBe(EXIT_CODES.verification);
      expect(result.report.ok).toBe(false);
      expect(result.report.smoke.results.every((check) => !check.ok)).toBe(true);
      expect(result.report.rollbackTo).toBe('v3');
      expect(result.stderr).toMatch(/wrangler rollback v3/);
    });

    // The certification's pilot: six deployments, six reports naming the same
    // second-oldest version, because `versions list` is oldest first and the
    // command read its second entry.
    it('names the version that served last, however many came before', () => {
      const target = provisioned();
      target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);
      target.run(['deploy', '--env', 'staging', ...FAST, '--skip-smoke']);

      const result = target.json(['deploy', '--env', 'staging', ...FAST, '--url', 'http://127.0.0.1:1']);
      expect(result.report.rollbackTo).toBe('v5');
      expect(target.read().workers.find((worker) => worker.name === result.report.resources.worker).active).toBe('v6');
    });

    it('says plainly that a first deployment has nothing behind it', () => {
      const target = provisioned();
      const result = target.json(['deploy', '--env', 'staging', ...FAST, '--url', 'http://127.0.0.1:1']);
      expect(result.report.rollbackTo).toBeNull();
      expect(result.stderr).toMatch(/premier déploiement/);
    });

    // Not a pass. A deployment nobody can address is not one anybody can use.
    it('refuses to call a deployment green when it has no URL to test', () => {
      const target = provisioned();
      target.account({ deployUrl: 'none' });
      const result = target.run(['deploy', '--env', 'staging', ...FAST]);
      expect(result.status).toBe(EXIT_CODES.verification);
      expect(result.stderr).toMatch(/aucune URL/);
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * The deployment workflow, pinned on the three properties that make it more
 * than a convenience.
 *
 * Read as TEXT rather than parsed: there is no YAML parser in this repository's
 * dependencies, and adding one to assert four substrings would be a dependency
 * to maintain for the rest of the pilot. What is asserted is what a silent edit
 * would take away.
 */
describe('the deployment workflow', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

  // The whole point of the file. Without it, `production` is a string in a
  // dispatch form and the approval is whoever clicked Run.
  it('binds the job to a GitHub Environment, so production can require a reviewer', () => {
    expect(workflow).toMatch(/environment:\n\s+name: \$\{\{ inputs\.environment \}\}/);
  });

  // A second implementation of plan §5.5 living in YAML is the one nobody runs
  // by hand and therefore nobody notices drifting.
  it('runs the operator’s own commands rather than its own wrangler calls', () => {
    expect(workflow).toMatch(/shopctl\.mjs provision/);
    expect(workflow).toMatch(/shopctl\.mjs "\$\{args\[@\]\}"/);
    expect(workflow).not.toMatch(/wrangler (deploy|d1|r2|secret)/);
  });

  // The reports travel through `tee`, so without pipefail the step would read
  // tee's exit status and a refused deployment would show a green check.
  it('reads the command’s exit status and not the pipe’s', () => {
    const runs = [...workflow.matchAll(/run: \|\n((?:\s{10}.*\n)+)/g)].map((match) => match[1]);
    const piped = runs.filter((candidate) => candidate.includes('| tee'));
    // Counted, not just iterated: a regex that matched nothing would make the
    // loop below pass while asserting nothing at all.
    expect(piped).toHaveLength(2);
    for (const body of piped) expect(body).toContain('set -euo pipefail');
  });

  // `${{ … }}` is substituted into the shell source before bash sees it, so a
  // dispatch input containing a quote would run as a command.
  it('passes dispatch inputs as environment variables, never into the shell source', () => {
    const runs = [...workflow.matchAll(/run: \|\n((?:\s{10}.*\n)+)/g)].map((match) => match[1]);
    expect(runs.length).toBeGreaterThan(0);
    for (const body of runs) expect(body).not.toMatch(/\$\{\{\s*inputs\./);
  });
});
