/**
 * `shopctl fleet` — the same questions as `core`, asked of every shop at once.
 *
 * The fleet is never upgraded in one block (ADR 0003): each shop takes a
 * version when its own pull request is reviewed and merged. So what these
 * commands produce is a REPORT and a set of proposals, never a deployment:
 *
 *   fleet status    where each shop stands: declared, merged, behind, drifted
 *   fleet verify    the same facts turned into an exit code, for CI
 *   fleet report    the version report of plan §5.7, as JSON or as a table
 *   fleet upgrade   one branch, one merge and one pull request per shop
 *   fleet init      the fleet repository's workflows (fleet-repository.mjs)
 *   fleet repo      the fleet repository on GitHub, and its credentials
 *   fleet usage     the shared account's month and its bill (fleet-usage.mjs)
 *
 * Two properties hold across the four, and both are about a fleet rather than a
 * shop.
 *
 * **One failing shop does not stop the others.** A missing checkout, a dirty
 * tree, a conflict — each is reported against its shop and the run continues.
 * A fleet command that died on the first problem would have to be re-run per
 * shop, which is what the operator was trying to avoid; and the shops it had
 * already touched would be invisible in the failure.
 *
 * **The core repository is asked once.** Its published tags are the same answer
 * for every shop, and asking per shop would multiply a network round trip by
 * the size of the fleet for no new information.
 *
 * The upgrade runs IN THIS PROCESS, with the CLI the operator invoked, against
 * each shop's tree. That is the one place this CLI does not use the shop's own
 * tooling, and the reason is mechanical: a shop still on the old version may
 * not have `core upgrade` at all — this milestone is where it appears. What
 * runs from the shop's own copy is what always did: the gates it passes after
 * the merge, which are the new core's.
 */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { CLIENT_MANIFEST, detectFleetCollisions, loadManifest } from '../../../scripts/manifest.mjs';
import { ShopctlError, usageError, verificationError } from '../errors.mjs';
import { loadFleet, selectShops } from '../fleet.mjs';
import { coreRemoteUrl, publishedCoreTags } from '../upgrade.mjs';
import { latestVersion, versionFromTag } from '../version.mjs';
import { coreState, stateFindings, upgradeShop } from './core.mjs';
import { initFleet, setupFleetRepository } from './fleet-repository.mjs';
import { FLEET_USAGE_OPTIONS, runFleetUsage } from './fleet-usage.mjs';

export const FLEET_OPTIONS = {
  '--to': 'tag',
  '--registry': 'chemin',
  '--only': 'slugs',
  '--branch': 'nom',
  '--base': 'branche',
  '--format': 'json|text',
  '--origin': 'url',
  '--owner': 'compte',
  '--reviewer': 'login',
  ...FLEET_USAGE_OPTIONS,
};

export const FLEET_FLAGS = ['--dry-run', '--no-verify', '--open-pr', '--offline', '--strict', '--abort-on-conflict', '--private', '--no-push'];

export const fleetUsage = `Usage: shopctl fleet <sous-commande> [options]

  shopctl fleet status                 Version, retard et dérive de chaque boutique
  shopctl fleet verify                 Les mêmes faits, en code de sortie
  shopctl fleet report --format json   Le rapport de versions de la flotte
  shopctl fleet upgrade --to <tag>     Une branche, une fusion, une pull request par boutique
  shopctl fleet init                   Écrire les workflows du dépôt de flotte (ADR 0019)
  shopctl fleet repo                   Créer le dépôt de flotte, ses environnements et
                                       les secrets du compte mutualisé
  shopctl fleet usage                  Consommation du compte mutualisé : facture
                                       projetée (Workers Paid) ou quotas du jour
                                       (Workers Free, --plan free)

  --registry <chemin>   Registre de flotte. Défaut : le fleet.json le plus proche.
  --only <slugs>        Se limiter à ces boutiques (séparées par des virgules).
  --to <tag>            Version du socle visée par upgrade.
  --branch <nom>        Branche de travail. Défaut : socle/<tag>.
  --base <branche>      Base des pull requests. Défaut : la branche courante de
                        chaque boutique.
  --open-pr             Pousser et ouvrir la pull request de chaque boutique.
  --dry-run             Dire ce que chaque boutique ferait, ne rien fusionner.
  --no-verify           Ne pas exécuter les portes des boutiques après la fusion.
  --abort-on-conflict   Défaire une fusion qui entre en conflit.
  --strict              verify : un avertissement devient un échec.
  --offline             Ne pas interroger le dépôt du socle.
  --format <json|text>  report : forme du rapport. Défaut : text.
  --origin <url>        repo : dépôt de flotte. Défaut : le remote « origin », ou
                        <owner>/minshop-fleet.
  --owner <compte>      repo : compte GitHub du dépôt déduit.
  --reviewer <login>    repo : relecteur obligatoire des déploiements de production.
  --private             repo : créer le dépôt privé. Défaut : public, seul à
                        porter secrets d'environnement et relecteurs en GitHub Free.
  --no-push             repo : ne pas pousser la branche.
  --account <id>        usage : le compte mutualisé. Défaut : CLOUDFLARE_ACCOUNT_ID.
  --plan <free|paid>    usage : plan Workers du compte. Défaut : paid.
  --budget <dollars>    usage : échouer (code 6) si la facture projetée le dépasse
                        (plan payant seulement).
  --json                Rapport lisible par une machine.

Sur le compte mutualisé (ADR 0019), les jetons Cloudflare vivent dans le dépôt de
flotte et nulle part ailleurs. fleet repo les lit dans l'environnement :

  CLOUDFLARE_API_TOKEN[_STAGING|_PRODUCTION]  déploiement
  CLOUDFLARE_API_TOKEN_BACKUP                 sauvegarde nocturne (lecture D1,
                                              écriture R2)
  CLOUDFLARE_API_TOKEN_MONITOR                surveillance (lecture seule)
  SHOPCTL_BACKUP_KEY                          clé des archives
  SHOPS_READ_TOKEN                            lecture des dépôts de boutique
                                              privés, facultatif

fleet usage lit CLOUDFLARE_API_TOKEN, un jeton « Account Analytics : Read » du
compte mutualisé. Il échoue aussi quand le compte porte deux cents Workers : le
jour d'ouvrir le suivant, avant le plafond de 250 crons. Au plan gratuit, il juge
le jour le plus chargé du compte contre ses quotas quotidiens, partagés par
toutes les boutiques, et les cinq crons du plan : le jour de passer en Paid.

Une mise à niveau de flotte ne déploie rien et ne fusionne aucune pull request.
Elle propose une version à plusieurs boutiques ; chacune la prend quand un humain
approuve la sienne.
`;

const SUBCOMMANDS = new Set(['status', 'verify', 'report', 'upgrade', 'init', 'repo', 'usage']);

export function runFleet(args, reporter) {
  const [sub, ...rest] = args.positionals;
  if (!sub) throw usageError('shopctl fleet attend une sous-commande.', fleetUsage.trim());
  if (!SUBCOMMANDS.has(sub)) throw usageError(`sous-commande de fleet inconnue : « ${sub} ».`, fleetUsage.trim());
  if (rest.length > 0) {
    throw usageError(`fleet ${sub} ne prend pas d'argument positionnel ; reçu « ${rest.join('", "')} ».`, fleetUsage.trim());
  }
  if (sub === 'upgrade') return upgradeFleet(args, reporter);
  if (sub === 'init') return initFleet(args, reporter);
  if (sub === 'repo') return setupFleetRepository(args, reporter);
  if (sub === 'usage') return runFleetUsage(args, reporter);
  return reportFleet(args, reporter, sub);
}

/**
 * Read every registered shop, without touching any of them.
 *
 * A shop that cannot be read is an ENTRY in the report — with the reason — and
 * not an exception: "the fleet has a shop nobody can read" is exactly the kind
 * of fact a fleet report exists to carry.
 */
export function surveyFleet(cwd, { registry, only, offline = false } = {}) {
  const fleet = loadFleet(cwd, registry);
  const selected = selectShops(fleet, only);

  // Asked once, for the whole fleet. `core.repository` when the registry names
  // one; otherwise the core remote of the first readable shop, which is the
  // same repository seen from the other end.
  let published = null;
  if (!offline) {
    const fallback = selected
      .map((entry) => (entry.isShop ? coreRemoteOf(entry.root) : null))
      .find(Boolean);
    const repository = fleet.core.repository ?? fallback;
    if (repository) published = publishedCoreTags(repository, { cwd: fleet.root });
  }

  // Every manifest that could be read, for the one question no shop can
  // answer about itself: does another one claim the same names?
  const claims = [];
  const shops = selected.map((entry) => {
    const at = relative(cwd, entry.root) || '.';
    if (!entry.exists) {
      return { ...entry, at, ok: false, findings: [{ status: 'fail', message: `répertoire absent : ${entry.root}` }] };
    }
    if (!entry.isShop) {
      return {
        ...entry,
        at,
        ok: false,
        findings: [{ status: 'fail', message: `${at} n'est pas une boutique (pas de ${CLIENT_MANIFEST}).` }],
      };
    }
    const loaded = loadManifest(CLIENT_MANIFEST, { root: entry.root });
    // A manifest that does not PARSE leaves nothing to describe. One that
    // parses and fails validation is described anyway, with its errors as
    // findings: the commonest case is a shop mid-upgrade — the tag merged, the
    // bump not yet made — and a fleet that dropped it from the report would
    // hide the shop that most needs finishing.
    if (!loaded.manifest) {
      return {
        ...entry,
        at,
        ok: false,
        findings: [{ status: 'fail', message: `manifeste illisible : ${loaded.errors[0]?.message ?? 'erreur de syntaxe'}` }],
      };
    }
    // The registry says which shop a directory holds; the manifest says which
    // shop it IS. When they disagree the registry is pointing at the wrong
    // tree, and every later command would operate on the wrong shop.
    if (loaded.manifest.client.slug !== entry.slug) {
      return {
        ...entry,
        at,
        ok: false,
        findings: [
          {
            status: 'fail',
            message: `le registre annonce « ${entry.slug} » et ${at} contient « ${loaded.manifest.client.slug} ».`,
          },
        ],
      };
    }

    // Valid manifests only, as `detectFleetCollisions` asks: one mid-upgrade
    // may lack a field the names are derived from.
    if ((loaded.errors ?? []).length === 0) claims.push({ file: entry.slug, manifest: loaded.manifest });
    try {
      const state = coreState(
        { root: entry.root, manifest: loaded.manifest, file: loaded.file, errors: loaded.errors },
        { offline: true, published },
      );
      const findings = stateFindings(state);
      return { ...entry, at, ok: !findings.some((finding) => finding.status === 'fail'), findings, state };
    } catch (error) {
      if (!(error instanceof ShopctlError)) throw error;
      return { ...entry, at, ok: false, findings: [{ status: 'fail', message: error.message }] };
    }
  });

  for (const finding of collisionFindings(claims)) {
    const shop = shops.find((candidate) => candidate.slug === finding.slug);
    shop.findings.push({ status: 'fail', message: finding.message });
    shop.ok = false;
  }

  const versions = shops.map((shop) => shop.state?.core.merged).filter(Boolean);
  return {
    registry: fleet.file,
    core: {
      repository: fleet.core.repository,
      published: published ? published.map(versionFromTag) : null,
      latest: published ? versionFromTag(latestVersion(published) ?? 'v0.0.0') : null,
    },
    shops,
    // The version report of plan §5.7 in one line: how many shops on each
    // version, which is the number that says whether a fleet is a fleet or a
    // pile of one-offs.
    spread: [...new Set(versions)].sort().map((version) => ({
      version,
      shops: shops.filter((shop) => shop.state?.core.merged === version).map((shop) => shop.slug),
    })),
  };
}

/**
 * Two shops of the fleet that claim one name, as one finding per shop and per
 * neighbour.
 *
 * `config:validate` asks this of the manifests ONE tree carries; the fleet is
 * the only place that sees every shop's. On one shared account (ADR 0019) a
 * worker or database name claimed twice is one set of orders for two shops,
 * and a hostname claimed twice is served by whichever deployed last. The
 * registry already refuses two entries with one slug (`fleet.mjs`); what it
 * cannot see is two slugs deriving the same resources through `workerName`.
 *
 * @param {Array<{ file: string, manifest: object }>} claims `file` is the slug
 * @returns {Array<{ slug: string, message: string }>}
 */
export function collisionFindings(claims) {
  const shared = new Map();
  for (const collision of detectFleetCollisions(claims)) {
    for (const slug of collision.files) {
      for (const other of collision.files.filter((candidate) => candidate !== slug)) {
        const key = `${slug}\u0000${other}`;
        if (!shared.has(key)) shared.set(key, { slug, other, values: [] });
        const values = shared.get(key).values;
        if (!values.includes(collision.value)) values.push(collision.value);
      }
    }
  }
  return [...shared.values()].map(({ slug, other, values }) => ({
    slug,
    message:
      `« ${other} » revendique les mêmes identifiants : ${values.slice(0, 3).join(', ')}` +
      `${values.length > 3 ? ` et ${values.length - 3} autre(s)` : ''}. ` +
      'Sur un compte mutualisé, les deux boutiques se partageraient ces ressources (ADR 0019) : donnez à l\'une un cloudflare.workerName ou un domaine à elle.',
  }));
}

/** The `core` remote of a shop tree, asked of git rather than of the manifest.
 *  Null for anything that is not a readable clone — the caller only wants a URL
 *  to list tags from, and any shop of the fleet answers with the same one. */
function coreRemoteOf(root) {
  if (!existsSync(resolve(root, '.git'))) return null;
  try {
    return coreRemoteUrl(root);
  } catch {
    return null;
  }
}

function reportFleet(args, reporter, sub) {
  const format = args.values['--format'] ? String(args.values['--format']) : 'text';
  if (!['text', 'json'].includes(format)) {
    throw usageError(`--format « ${format} » est inconnu.`, 'Formats : text, json.');
  }
  const json = args.values['--json'] === true || format === 'json';
  // `--format json` means the same thing `--json` means — one document on
  // stdout, progress on stderr — so it flips the reporter rather than printing
  // a document into the middle of a table. Plan §5.7 spells the fleet report
  // with `--format`, and an operator who typed it should not also have to know
  // about the global flag.
  reporter.json = json;
  const survey = surveyFleet(process.cwd(), {
    registry: args.values['--registry'],
    only: args.values['--only'],
    offline: args.values['--offline'] === true,
  });

  reporter.section(`Flotte — ${survey.shops.length} boutique${survey.shops.length > 1 ? 's' : ''} (${survey.registry})`);
  for (const shop of survey.shops) {
    reporter.section(`${shop.slug} — ${shop.at}`);
    for (const finding of shop.findings) reporter.entry(finding.status, finding.message);
  }
  if (survey.core.latest) {
    reporter.section(`Socle publié : v${survey.core.latest}`);
    for (const group of survey.spread) reporter.step(`  v${group.version} : ${group.shops.join(', ')}`);
  }

  const failures = survey.shops.filter((shop) => !shop.ok);
  const warnings = survey.shops.filter((shop) => shop.findings.some((finding) => finding.status === 'warn'));
  const strict = args.values['--strict'] === true;
  const ok = failures.length === 0 && (!strict || warnings.length === 0);

  if (json) reporter.result({ ok, ...survey });

  if (sub === 'verify' && !ok) {
    throw verificationError(
      `${failures.length > 0 ? `${failures.length} boutique${failures.length > 1 ? 's' : ''} en défaut` : `${warnings.length} boutique${warnings.length > 1 ? 's' : ''} avec avertissement`} dans ${survey.registry}.`,
      [...failures, ...(strict ? warnings : [])]
        .map((shop) => `  ${shop.slug} : ${shop.findings.find((finding) => finding.status !== 'ok')?.message ?? ''}`)
        .join('\n'),
      { shops: survey.shops.map(({ slug, ok: shopOk, findings }) => ({ slug, ok: shopOk, findings })) },
    );
  }
  return 0;
}

function upgradeFleet(args, reporter) {
  const survey = surveyFleet(process.cwd(), {
    registry: args.values['--registry'],
    only: args.values['--only'],
    offline: true,
  });

  const results = [];
  for (const shop of survey.shops) {
    if (!shop.state) {
      reporter.section(`${shop.slug} — ${shop.at}`);
      for (const finding of shop.findings) reporter.entry(finding.status, finding.message);
      results.push({ slug: shop.slug, ok: false, error: shop.findings[0]?.message ?? 'boutique illisible' });
      continue;
    }
    try {
      const outcome = upgradeShop({
        shop: { root: shop.root, manifest: manifestOf(shop), file: CLIENT_MANIFEST },
        reporter,
        to: args.values['--to'],
        branch: args.values['--branch'],
        base: args.values['--base'],
        dryRun: args.values['--dry-run'] === true,
        verify: args.values['--no-verify'] !== true,
        openPr: args.values['--open-pr'] === true,
        abortOnConflict: args.values['--abort-on-conflict'] === true,
      });
      results.push({ slug: shop.slug, ok: true, ...outcome });
    } catch (error) {
      if (!(error instanceof ShopctlError)) throw error;
      // Reported against ITS shop, and the run continues. A fleet command that
      // stopped here would leave the operator re-running it shop by shop, which
      // is what they were trying to avoid.
      reporter.fail(`${shop.slug} — ${error.message}`, error.hint);
      results.push({ slug: shop.slug, ok: false, kind: error.kind, error: error.message, details: error.details ?? null });
    }
  }

  const failed = results.filter((result) => !result.ok);
  const changed = results.filter((result) => result.ok && result.changed);
  reporter.section(
    `${changed.length} boutique${changed.length > 1 ? 's' : ''} mise${changed.length > 1 ? 's' : ''} à niveau, ` +
      `${results.length - changed.length - failed.length} déjà à jour, ${failed.length} en échec`,
  );

  reporter.result({ ok: failed.length === 0, registry: survey.registry, results });
  if (failed.length > 0) {
    throw verificationError(
      `${failed.length} boutique${failed.length > 1 ? 's' : ''} sur ${results.length} n'${failed.length > 1 ? 'ont' : 'a'} pas pris la version.`,
      failed.map((result) => `  ${result.slug} : ${result.error}`).join('\n'),
      { results },
    );
  }
  return 0;
}

/** The manifest a surveyed shop carries. Re-read rather than kept from the
 *  survey so an upgrade always merges against the file as it is now. */
function manifestOf(shop) {
  const loaded = loadManifest(CLIENT_MANIFEST, { root: shop.root });
  if (!loaded.manifest) throw verificationError(`le manifeste de ${shop.slug} n'est plus lisible.`);
  return loaded.manifest;
}

