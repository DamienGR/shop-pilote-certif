#!/usr/bin/env node
/**
 * The real-account trial ADR 0019 asks for before any shop depends on it: two
 * custom hostnames of one Cloudflare for SaaS zone, each routed to its own
 * Worker, as two shops of the shared account will be.
 *
 * It goes through the code a shop goes through — `shopctl/src/saas.mjs` for the
 * custom hostnames (HTTP validation, TLS 1.2 at least) and the clone's wrangler
 * with the route `scripts/manifest.mjs` renders for a production served by the
 * zone (`<hostname>/*` on the zone, workers.dev closed) — and creates nothing
 * else: two Workers with no binding, cron or secret, and their two hostnames.
 * The doubles of a suite cannot answer what it asks: whether Cloudflare routes
 * a custom hostname by a route on the SaaS zone, and issues its certificate.
 *
 * From the core's root, on the shared account's deployment token exported
 * without echo (docs/certification/compte-mutualise-essai-saas.md):
 *
 *   node scripts/saas-trial.mjs prepare --zone <SaaS zone> --domain <merchant zone>
 *   node scripts/saas-trial.mjs verify  --zone <SaaS zone> --domain <merchant zone>
 *   node scripts/saas-trial.mjs clean   --zone <SaaS zone> --domain <merchant zone>
 *
 * Exit codes are shopctl's: 2 usage, 3 bad value, 4 missing prerequisite or
 * DNS still pending, 5 Cloudflare or wrangler failed, 6 a hostname reaches
 * something other than its own Worker.
 *
 * `SAAS_TRIAL_ORIGIN` replaces Cloudflare's network for the suite
 * (`test/scripts/saas-trial.test.mjs`): a hostname is read at
 * `<origin>/<hostname><path>` instead of `https://<hostname><path>`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteWorker, wrangler } from '../shopctl/src/cloudflare.mjs';
import { EXIT_CODES, inputError, preconditionError, usageError } from '../shopctl/src/errors.mjs';
import {
  apiToken,
  createCustomHostname,
  deleteCustomHostname,
  fallbackOrigin,
  findCustomHostname,
  findZone,
  hostnameState,
} from '../shopctl/src/saas.mjs';

const TRIALS = ['a', 'b'];
// wrangler.template.jsonc's: the trial runs on the runtime a shop runs on.
const COMPATIBILITY_DATE = '2026-07-20';
const DEFAULT_API = 'https://api.cloudflare.com/client/v4';
const USAGE = 'node scripts/saas-trial.mjs prepare|verify|clean --zone <zone SaaS> --domain <zone du commerçant>';
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const say = (text = '') => process.stdout.write(`${text}\n`);
const hostnameFor = (trial, domain) => `essai-${trial}.${domain}`;
const workerFor = (trial) => `minshop-essai-${trial}`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['prepare', 'verify', 'clean'].includes(command)) throw usageError(`commande inconnue : ${command ?? '(aucune)'}.`, USAGE);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag !== '--zone' && flag !== '--domain') throw usageError(`option inconnue : ${flag}.`, USAGE);
    if (!value || value.startsWith('--')) throw usageError(`${flag} attend une valeur.`, USAGE);
    options[flag.slice(2)] = value.toLowerCase();
  }
  for (const name of ['zone', 'domain']) {
    if (!options[name]) throw usageError(`--${name} manque.`, USAGE);
    if (!DOMAIN.test(options[name])) throw inputError(`${options[name]} n'est pas un nom de domaine.`);
  }
  // A hostname inside the zone is a custom domain of the account, not a
  // custom hostname: it would prove nothing about a merchant's domain.
  if (options.domain === options.zone || options.domain.endsWith(`.${options.zone}`)) {
    throw inputError(
      `${options.domain} est dans la zone SaaS ${options.zone}.`,
      'L\'essai porte sur un domaine hors de la zone, comme celui d\'un commerçant : miijot.fr, sur le compte B.',
    );
  }
  return { command, zone: options.zone, domain: options.domain };
}

function credentials() {
  const token = apiToken();
  if (!token) {
    throw preconditionError(
      'CLOUDFLARE_API_TOKEN est absent.',
      'read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN — le jeton de déploiement du compte mutualisé, collé sans écho.',
    );
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || null;
  if (!account) throw preconditionError('CLOUDFLARE_ACCOUNT_ID est absent.', 'export CLOUDFLARE_ACCOUNT_ID=<id du compte mutualisé>.');
  if (!/^[0-9a-f]{32}$/.test(account)) throw inputError(`CLOUDFLARE_ACCOUNT_ID (${account}) n'est pas un identifiant de compte.`);
  return { token, account };
}

/** The SaaS zone and its fallback origin, or the dashboard step that is missing. */
async function zoneAndFallback(name, { token, account }) {
  const zone = await findZone(name, account, { token });
  if (!zone) {
    throw preconditionError(
      `la zone ${name} n'est pas sur le compte ${account}, ou le jeton ne la voit pas.`,
      'Ajoutez-la au compte mutualisé (fiche, §1.2), et donnez au jeton « Zone : Read » sur elle.',
    );
  }
  if (zone.status && zone.status !== 'active') {
    throw preconditionError(
      `la zone ${name} est « ${zone.status} », pas encore active.`,
      'Ses serveurs de noms chez le registrar doivent être ceux que Cloudflare a donnés ; relancez une fois la zone active.',
    );
  }
  const fallback = await fallbackOrigin(zone.id, { token });
  if (!fallback) {
    throw preconditionError(
      `la zone ${name} n'a pas d'origine de repli.`,
      `SSL/TLS → Custom Hostnames : activer Cloudflare for SaaS, puis Fallback Origin = fallback.${name} (fiche, §1.3).`,
    );
  }
  say(`Compte ${account}, zone SaaS ${zone.name} (${zone.id}), origine de repli ${fallback.origin} : ${fallback.status ?? 'statut inconnu'}.`);
  return { zone, fallback };
}

const workerSource = (worker) => `export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.json(
      { essai: ${JSON.stringify(worker)}, host: url.host, chemin: url.pathname },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
};
`;

function deploy(trial, hostname, zoneName) {
  const worker = workerFor(trial);
  const directory = mkdtempSync(join(tmpdir(), `${worker}-`));
  try {
    writeFileSync(join(directory, 'worker.js'), workerSource(worker));
    const config = {
      name: worker,
      main: 'worker.js',
      compatibility_date: COMPATIBILITY_DATE,
      // What wranglerSubstitutions() renders for a production served by the zone.
      workers_dev: false,
      routes: [{ pattern: `${hostname}/*`, zone_name: zoneName }],
    };
    writeFileSync(join(directory, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`);
    wrangler(['deploy', '--config', join(directory, 'wrangler.json')]);
    say(`  ✓ ${worker} — déployé, route ${hostname}/* sur ${zoneName}, workers.dev fermé`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function prepare({ zone: zoneName, domain }, credentialsInUse) {
  const { zone, fallback } = await zoneAndFallback(zoneName, credentialsInUse);
  if (fallback.status !== 'active') say('  ! l\'origine de repli n\'est pas encore active : les noms d\'hôte l\'attendront.');
  for (const trial of TRIALS) {
    const hostname = hostnameFor(trial, domain);
    const existing = await findCustomHostname(zone.id, hostname, credentialsInUse);
    if (existing) {
      say(`  ✓ ${hostname} — nom d'hôte déjà créé (${existing.id})`);
    } else {
      const created = await createCustomHostname(zone.id, hostname, credentialsInUse);
      say(`  ✓ ${hostname} — nom d'hôte créé (${created?.id ?? '?'}), validation HTTP`);
    }
    deploy(trial, hostname, zone.name);
  }
  say();
  say(`À poser dans la zone ${domain} (compte B), en DNS seul — nuage gris — si ce n'est pas déjà fait :`);
  for (const trial of TRIALS) say(`  CNAME ${hostnameFor(trial, domain)} → ${fallback.origin}`);
  say(`Puis : node scripts/saas-trial.mjs verify --zone ${zoneName} --domain ${domain}, à relancer tant qu'il dit « en attente ».`);
  return EXIT_CODES.ok;
}

function age(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** One request as a visitor makes it, the certificate checked by Node. */
async function visit(hostname, path) {
  const origin = process.env.SAAS_TRIAL_ORIGIN;
  const url = origin ? `${origin.replace(/\/$/, '')}/${hostname}${path}` : `https://${hostname}${path}`;
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A Cloudflare error page: its status is all that matters.
    }
    return { status: response.status, body, ray: response.headers.get('cf-ray') };
  } catch (error) {
    const cause = error?.cause;
    return { error: `${cause?.code ?? error?.name ?? 'erreur réseau'}${cause?.message ? ` — ${cause.message}` : ''}` };
  }
}

/** The account's workers.dev subdomain, or null when it cannot be read. */
async function workersSubdomain({ token, account }) {
  const base = (process.env.CLOUDFLARE_API_BASE_URL || DEFAULT_API).replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/accounts/${account}/workers/subdomain`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const document = await response.json();
    return response.ok && document?.success !== false ? (document?.result?.subdomain ?? null) : null;
  } catch {
    return null;
  }
}

async function verify({ zone: zoneName, domain }, credentialsInUse) {
  const { zone, fallback } = await zoneAndFallback(zoneName, credentialsInUse);
  if (fallback.status !== 'active') {
    throw preconditionError(`l'origine de repli ${fallback.origin} est « ${fallback.status} », pas encore active.`, 'Relancez dans quelques minutes.');
  }
  const pending = [];
  for (const trial of TRIALS) {
    const hostname = hostnameFor(trial, domain);
    const record = await findCustomHostname(zone.id, hostname, credentialsInUse);
    if (!record) throw preconditionError(`${hostname} n'est pas un nom d'hôte de ${zone.name}.`, 'Lancez d\'abord node scripts/saas-trial.mjs prepare.');
    const state = hostnameState(record);
    const created = record.created_at ? `créé il y a ${age(Date.now() - Date.parse(record.created_at))}` : 'âge inconnu';
    say(`  ${state.active ? '✓' : '…'} ${hostname} — nom d'hôte ${state.status ?? '?'}, certificat ${state.ssl ?? '?'} (${created})`);
    for (const error of state.errors) say(`      ${error}`);
    if (!state.active) pending.push(hostname);
  }
  if (pending.length > 0) {
    throw preconditionError(
      `en attente : ${pending.join(', ')}.`,
      `Chacun attend son CNAME vers ${fallback.origin}, en DNS seul ; relancez dans quelques minutes. Au-delà de trente, les erreurs ci-dessus disent pourquoi.`,
    );
  }

  let code = EXIT_CODES.ok;
  const fail = (kind, text) => {
    say(`  ✗ ${text}`);
    code = Math.max(code, EXIT_CODES[kind]);
  };

  for (const trial of TRIALS) {
    const hostname = hostnameFor(trial, domain);
    const expected = workerFor(trial);
    const path = `/essai/${trial}/${Date.now()}`;
    const answer = await visit(hostname, path);
    if (answer.error) {
      fail('external', `${hostname} — injoignable : ${answer.error}`);
    } else if (answer.status === 200 && answer.body?.essai === expected && answer.body?.host === hostname && answer.body?.chemin === path) {
      say(`  ✓ ${hostname} — HTTP 200 en HTTPS, servi par ${expected}, chemin transmis${answer.ray ? ` (cf-ray ${answer.ray})` : ''}`);
    } else {
      fail('verification', `${hostname} — HTTP ${answer.status}, attendu ${expected} ; reçu ${answer.body ? JSON.stringify(answer.body) : 'une page qui n\'est pas celle d\'un Worker d\'essai'}`);
    }
  }

  // A hostname of the zone with no route must reach no shop at all.
  const unrouted = await visit(fallback.origin, '/');
  if (unrouted.body?.essai) fail('verification', `${fallback.origin} — un nom sans route atteint ${unrouted.body.essai}`);
  else say(`  ✓ ${fallback.origin} — sans route, n'atteint aucun Worker (${unrouted.error ?? `HTTP ${unrouted.status}`})`);

  const subdomain = await workersSubdomain(credentialsInUse);
  if (!subdomain) {
    say('  · workers.dev — non vérifié : le sous-domaine du compte ne se lit pas (Workers & Pages jamais ouvert ?).');
  } else {
    for (const trial of TRIALS) {
      const hostname = `${workerFor(trial)}.${subdomain}.workers.dev`;
      const answer = await visit(hostname, '/');
      if (answer.body?.essai) fail('verification', `${hostname} — workers.dev ouvert : ${answer.body.essai} y répond`);
      else say(`  ✓ ${hostname} — fermé (${answer.error ?? `HTTP ${answer.status}`})`);
    }
  }

  say();
  say(
    code === EXIT_CODES.ok
      ? `Essai vert (${new Date().toISOString()}) : chaque nom d'hôte mène à son Worker, en HTTPS, et rien d'autre n'y mène.`
      : `Essai rouge (${new Date().toISOString()}) : voir les lignes ✗ ci-dessus. Ne pas nettoyer avant d'avoir transmis cette sortie.`,
  );
  return code;
}

async function clean({ zone: zoneName, domain }, credentialsInUse) {
  const zone = await findZone(zoneName, credentialsInUse.account, credentialsInUse);
  let left = 0;
  // The Worker first, then its hostname: shopctl destroy's order.
  for (const trial of TRIALS) {
    const worker = workerFor(trial);
    const removal = deleteWorker(worker, { cwd: process.cwd() });
    if (removal.removed) say(`  ✓ ${worker} — supprimé`);
    else if (removal.reason === 'absent') say(`  ✓ ${worker} — absent`);
    else {
      left += 1;
      say(`  ✗ ${worker} — wrangler delete a échoué : ${removal.reason}`);
    }
    const hostname = hostnameFor(trial, domain);
    if (!zone) {
      say(`  · ${hostname} — la zone ${zoneName} ne se lit pas : nom d'hôte non vérifié.`);
      continue;
    }
    const record = await findCustomHostname(zone.id, hostname, credentialsInUse);
    if (!record) {
      say(`  ✓ ${hostname} — nom d'hôte absent`);
      continue;
    }
    await deleteCustomHostname(zone.id, record.id, credentialsInUse);
    say(`  ✓ ${hostname} — nom d'hôte supprimé`);
  }
  say();
  say(`Reste à la main : les CNAME essai-a et essai-b de la zone ${domain}, sur B.`);
  return left > 0 ? EXIT_CODES.external : EXIT_CODES.ok;
}

try {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = await { prepare, verify, clean }[options.command](options, credentials());
} catch (error) {
  process.stderr.write(`\nÉchec : ${error?.message ?? error}\n${error?.hint ? `→ ${error.hint}\n` : ''}`);
  process.exitCode = Number.isInteger(error?.code) ? error.code : 1;
}
