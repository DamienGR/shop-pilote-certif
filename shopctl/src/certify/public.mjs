/**
 * What `shopctl certify` asks of the shop's public origin.
 *
 * Four kinds of question, all of them a visitor's: the pages a buyer and a
 * search engine are served, the two remote gates the campaign ran (security
 * and browser, wrapped as they are, never reimplemented), and Lighthouse
 * through Google's PageSpeed Insights API — the campaign's measure, without a
 * Chrome on the operator's machine and without a dependency.
 *
 * Nothing here writes. The security gate posts what a stranger may post — a
 * wrong password, forged webhooks — and the shop refuses each; its rate
 * limiters are tripped only on request (`--rate-limits`), because they lock
 * the operator's own address out of the admin for a quarter of an hour.
 *
 * The gates run ASYNCHRONOUSLY: a spawnSync would hold this process while a
 * child talks to an origin this process may be serving (the suite's own).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LEGAL_PAGES } from './judge.mjs';

/** PageSpeed Insights, overridable for a test or a proxy like the GraphQL
 *  endpoint `monitor` reads. */
export const PAGESPEED_API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** One GET, the body whole (a footer is at the end of a page), never followed. */
export async function fetchPage(url, { timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'shopctl-certify' } });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: null, body: '', error: String(error?.cause?.code ?? error?.name ?? error) };
  }
}

/** The home page and the four legal pages. */
export async function readPages(origin, options = {}) {
  const home = await fetchPage(new URL('/', origin).toString(), options);
  const pages = {};
  for (const slug of Object.keys(LEGAL_PAGES)) pages[slug] = await fetchPage(new URL(`/pages/${slug}`, origin).toString(), options);
  return { home, pages };
}

/**
 * The four pages Lighthouse measured during the campaign: the home page, a
 * category, a product, the cart. The category and the product are the first
 * the sitemap lists, so the choice is the merchant's catalogue, not a guess.
 */
export async function lighthousePages(origin, options = {}) {
  const sitemap = await fetchPage(new URL('/sitemap.xml', origin).toString(), options);
  const locs = [...sitemap.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
  const first = (segment) => locs.find((loc) => {
    try {
      return new URL(loc).pathname.startsWith(`/${segment}/`);
    } catch {
      return false;
    }
  });
  const path = (loc) => (loc ? new URL(loc).pathname : null);
  return [
    { label: 'accueil', path: '/' },
    { label: 'une catégorie', path: path(first('categories')), missing: 'aucune catégorie dans sitemap.xml' },
    { label: 'une fiche produit', path: path(first('products')), missing: 'aucun produit dans sitemap.xml' },
    // Empty: PageSpeed Insights cannot fill a cart, and the campaign's filled
    // one measured the core, which the pilot keeps measuring.
    { label: 'le panier', path: '/cart' },
  ];
}

/**
 * One PageSpeed Insights run, mobile.
 *
 * The key, when there is one, comes from PAGESPEED_API_KEY and goes in the
 * query string, which is how the API takes it; nothing here prints a URL.
 * Anonymous calls share one quota, found spent on the first call from two
 * networks (2026-10-27), so the key is needed in practice. An exhausted quota
 * is an answer like any other: a skip with its reason, never a pass.
 *
 * @returns {Promise<{ document: object|null, error: string|null, hint?: string }>}
 */
export async function pageSpeed(url, { env = process.env, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const endpoint = new URL(env.PAGESPEED_API_URL || PAGESPEED_API);
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', 'mobile');
  for (const category of ['performance', 'accessibility', 'seo']) endpoint.searchParams.append('category', category);
  if (env.PAGESPEED_API_KEY) endpoint.searchParams.set('key', env.PAGESPEED_API_KEY);
  let response;
  try {
    response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { document: null, error: `PageSpeed Insights injoignable (${error?.cause?.code ?? error?.name ?? 'erreur réseau'})` };
  }
  if (response.status === 429) {
    return { document: null, error: 'PageSpeed Insights refuse : quota épuisé', hint: 'Posez PAGESPEED_API_KEY (une clé d\'API Google, gratuite) et relancez.' };
  }
  if (!response.ok) return { document: null, error: `PageSpeed Insights répond HTTP ${response.status}` };
  try {
    return { document: await response.json(), error: null };
  } catch {
    return { document: null, error: 'PageSpeed Insights a rendu une réponse illisible' };
  }
}

/** A child process, awaited. stdout and stderr captured, nothing inherited. */
export function spawnAsync(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * The environment a remote gate runs in: the shop's origin, and NOT a
 * service token left in the operator's shell from a preview. A production has
 * no Access in front of it, and a token sent to it would be a token sent for
 * nothing.
 */
export function gateEnvironment(origin, env = process.env) {
  const { CF_ACCESS_CLIENT_ID: _id, CF_ACCESS_CLIENT_SECRET: _secret, ...rest } = env;
  return { ...rest, BASE_URL: origin };
}

/** `test/remote/security.mjs`, as the shop carries it. */
export async function runSecurityGate(root, origin, { rateLimits = false, run = spawnAsync, env = process.env } = {}) {
  const script = join(root, 'test/remote/security.mjs');
  if (!existsSync(script)) return { status: 'skip', message: 'porte de sécurité distante : test/remote/security.mjs absent de cet arbre.' };
  const result = await run(process.execPath, ['--experimental-strip-types', script, ...(rateLimits ? ['--limiteurs'] : [])], { cwd: root, env: gateEnvironment(origin, env) });
  const output = `${result.stdout}\n${result.stderr}`;
  const summary = output.match(/(\d+) contrôle\(s\) passé\(s\), (\d+) en échec\./);
  const failures = output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('✗')).slice(0, 5);
  const limiters = rateLimits ? ', limiteurs compris' : ' (limiteurs : --rate-limits)';
  if (result.status === 0 && summary) {
    return { status: 'ok', message: `porte de sécurité distante : ${summary[1]} contrôles passés${limiters}` };
  }
  return {
    status: 'fail',
    message: `porte de sécurité distante : ${summary ? `${summary[2]} en échec` : `sortie ${result.status}`}.`,
    hint: failures.join('\n    ') || lastLines(output),
  };
}

/** `npm run test:browser:remote`: Playwright against the origin. A missing
 *  browser is a machine to set up, said as such, not a shop that failed. */
export async function runBrowserGate(root, origin, { run = spawnAsync, env = process.env } = {}) {
  if (!existsSync(join(root, 'node_modules/.bin/playwright'))) {
    return { status: 'skip', message: 'porte navigateur distante : Playwright n\'est pas installé dans cet arbre.', hint: 'npm ci, puis npx playwright install chromium.' };
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await run(npm, ['run', '--silent', 'test:browser:remote'], { cwd: root, env: gateEnvironment(origin, env) });
  const output = `${result.stdout}\n${result.stderr}`;
  if (/Executable doesn't exist|playwright install/i.test(output) && result.status !== 0) {
    return { status: 'skip', message: 'porte navigateur distante : Chromium n\'est pas installé pour Playwright.', hint: 'npx playwright install chromium, puis relancez.' };
  }
  const counts = Object.fromEntries([...output.matchAll(/(\d+) (passed|failed|skipped|flaky)\b/g)].map((match) => [match[2], Number(match[1])]));
  const said = ['passed', 'failed', 'flaky', 'skipped']
    .filter((key) => counts[key])
    .map((key) => `${counts[key]} ${{ passed: 'passé(s)', failed: 'en échec', flaky: 'instable(s)', skipped: 'sauté(s) avec leur raison' }[key]}`)
    .join(', ');
  if (result.status === 0) return { status: 'ok', message: `porte navigateur distante : ${said || 'verte'}` };
  const failed = failedTests(output);
  return {
    status: 'fail',
    message: `porte navigateur distante : ${said || `sortie ${result.status}`}.`,
    hint: failed.length
      ? [...failed, `Le détail : BASE_URL=${origin} npm run test:browser:remote`].join('\n    ')
      : lastLines(output),
  };
}

/** The failed tests as Playwright's closing summary lists them,
 *  `[project] › file:line:col › title ───`: the last lines of its output are
 *  the counts, which say how many failed but not which. */
function failedTests(output, count = 6) {
  const titles = [...output.matchAll(/^[ \t]*\[([\w-]+)\] › (\S+?):\d+:\d+ › (.+?)[ \t─]*$/gm)]
    .map(([, project, file, title]) => `[${project}] ${title} (${file})`);
  return [...new Set(titles)].slice(0, count);
}

function lastLines(text, count = 6) {
  return String(text).trim().split('\n').slice(-count).join('\n    ');
}
