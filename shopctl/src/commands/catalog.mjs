/**
 * `shopctl catalog` — the merchant's CSV, and what it would do to the store.
 *
 * Three subcommands and one pipeline. `validate` stops after the file has been
 * read; `import --dry-run` goes on to compute the plan and prints it; `import`
 * hands the same plan to the applier. They are stages of one path rather than
 * three commands that resemble each other, because the value of a dry run is
 * that it exercises the code the real run uses — a preview computed separately
 * is a preview of a different program.
 *
 * `report` answers the question the other three raise: what is in the store
 * right now, and how much of it does this file claim.
 *
 * Nothing is written before everything has been judged (plan §5.4). A refusal
 * anywhere — an unreadable image, an unknown category, a sellable unit the file
 * would retire — aborts the whole run, and the store is exactly as it was. The
 * alternative, importing the rows that pass, produces a catalogue that is
 * neither the old one nor the file, and no one can say which products are in it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CsvError, parseCsvRecords } from '../catalog/csv.mjs';
import { buildCatalogue } from '../catalog/contract.mjs';
import { oversizedForDelivery, resolveCatalogueImages, DELIVERY_MAX_WIDTH } from '../catalog/media.mjs';
import { planImport } from '../catalog/plan.mjs';
import { applyStatements, assertWranglerNamesShop, imagesBucket, jurisdictionFlags, putObject, readCatalogue } from '../catalog/store.mjs';
import { expectedAccount, resolveAccount, whoami } from '../cloudflare.mjs';
import { inputError, usageError, verificationError } from '../errors.mjs';
import { ENVIRONMENTS } from '../../../scripts/manifest.mjs';
import { resolveShop } from '../shop.mjs';

export const CATALOG_OPTIONS = { '--shop': 'slug', '--env': 'environnement', '--account': 'id' };

export { resolveShop };

export const catalogUsage = `Usage: shopctl catalog <sous-commande> [options]

  validate <fichier.csv>    Lire et contrôler le fichier, sans toucher à la boutique
  import <fichier.csv>      Appliquer le catalogue à la boutique
  report                    État du catalogue de la boutique

Options:
  --dry-run                 Calculer et afficher le plan sans rien écrire (import)
  --remote                  Viser la base déployée. Par défaut : la base locale.
  --env <staging|production>  Environnement déployé visé. Obligatoire avec --remote.
  --account <id>            Compte Cloudflare attendu avec --remote, si le manifeste ne le déclare pas.
  --create-categories       Créer les catégories que le fichier nomme et que la boutique n'a pas
  --allow-slug-change       Autoriser le déplacement d'une URL de produit
  --allow-remove-variants   Autoriser la désactivation des unités vendues absentes du fichier
  --shop <slug>             Manifeste à utiliser quand l'arbre en contient plusieurs
  --json                    Rapport lisible par une machine

Le format des colonnes est décrit dans imports/README.md, et rappelé par
\`shopctl catalog validate\` dès qu'une colonne manque ou est inconnue.
`;

/**
 * Which deployed environment `--remote` means.
 *
 * There is no default, and that is the point: a shop has a staging database and
 * a production one (plan §5.3), they hold different catalogues, and an import
 * that guessed would be indistinguishable from one that was told. Omitting
 * `--env` therefore names the unqualified family — the local tree, which is
 * where a first import belongs — and asking for `--remote` without saying which
 * remote is a usage error rather than a coin flip.
 */
export function resolveEnvironment(value, remote) {
  if (value === undefined) {
    if (remote) {
      throw usageError(
        '--remote sans --env : quelle base déployée ?',
        `La boutique en a deux : ${ENVIRONMENTS.join(' et ')}. Ajoutez --env <${ENVIRONMENTS.join('|')}>.`,
      );
    }
    return null;
  }
  if (!ENVIRONMENTS.includes(value)) {
    throw usageError(`--env « ${value} » est inconnu.`, `Environnements : ${ENVIRONMENTS.join(', ')}.`);
  }
  if (!remote) {
    throw usageError(
      '--env sans --remote : la base locale n\'appartient à aucun environnement.',
      'Ajoutez --remote pour viser la base déployée, ou retirez --env.',
    );
  }
  return value;
}

/**
 * The account a remote read or write goes to: the same answer, and the same
 * refusals, as `provision` and `deploy` give for this environment.
 *
 * `wrangler.jsonc` names the database but not the account, so without this
 * wrangler picks one itself — and with a session that sees the agency's
 * account and the client's (ADR 0015) it picks none, or the one it cached.
 * A local import reaches no account and asks nothing.
 */
function connectRemote({ shop, env, values, reporter }) {
  const account = resolveAccount(expectedAccount(shop.manifest, env, values), whoami({ cwd: shop.root }));
  reporter.step(`Compte Cloudflare : ${account.name} (${account.id})`);
  return account;
}

/** Read the file and turn it into a catalogue, or into the list of what is wrong. */
export function readCatalogueFile(path, { currency }) {
  if (!existsSync(path)) {
    throw inputError(`fichier introuvable : ${path}.`, 'Le chemin est relatif au répertoire courant.');
  }
  let parsed;
  try {
    parsed = parseCsvRecords(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof CsvError) {
      throw inputError(`${path}:${error.at.line} — ${error.message}`);
    }
    throw error;
  }

  const built = buildCatalogue(parsed, { currency });
  const resolved = resolveCatalogueImages(built.products, { root: dirname(resolve(path)) });
  const issues = [...built.issues, ...resolved.issues].sort((a, b) => a.line - b.line);
  return { delimiter: parsed.delimiter, products: resolved.products, issues };
}

function reportIssues(reporter, path, issues) {
  for (const issue of issues) {
    reporter.fail(`${path}:${issue.line} (${issue.column}) ${issue.message}`, issue.hint);
  }
}

export function runCatalog(args, reporter) {
  const [subcommand, ...rest] = args.positionals;
  const json = args.values['--json'] === true;

  if (!subcommand) throw usageError('shopctl catalog needs a subcommand.', catalogUsage.trim());
  if (!['validate', 'import', 'report'].includes(subcommand)) {
    throw usageError(`unknown subcommand "catalog ${subcommand}".`, catalogUsage.trim());
  }

  const shop = resolveShop(process.cwd(), args.values['--shop']);
  const currency = shop.manifest.client.currency;
  const remote = args.values['--remote'] === true;
  const env = resolveEnvironment(args.values['--env'], remote);

  if (subcommand === 'report') {
    if (rest.length > 0) throw usageError(`catalog report takes no argument; got "${rest.join('", "')}".`);
    return runReport({ shop, remote, env, json, values: args.values }, reporter);
  }

  const [file, ...extra] = rest;
  if (!file) throw usageError(`catalog ${subcommand} needs the path to a CSV file.`, catalogUsage.trim());
  if (extra.length > 0) throw usageError(`catalog ${subcommand} takes one file; got "${rest.join('", "')}".`);

  const path = resolve(process.cwd(), file);
  const catalogue = readCatalogueFile(path, { currency });

  const units = catalogue.products.reduce((total, product) => total + Math.max(1, product.variants.length), 0);
  const images = new Set(catalogue.products.flatMap((product) => product.media.map((media) => media.key)));

  if (subcommand === 'validate') {
    if (json) {
      reporter.result({
        ok: catalogue.issues.length === 0,
        file,
        delimiter: catalogue.delimiter,
        products: catalogue.products.length,
        units,
        images: images.size,
        issues: catalogue.issues,
      });
    } else {
      reporter.section(`Catalogue ${file}`);
      reportIssues(reporter, file, catalogue.issues);
      if (catalogue.issues.length === 0) {
        reporter.ok(`${catalogue.products.length} produit(s), ${units} unité(s) vendue(s), ${images.size} image(s).`);
      }
    }
    if (catalogue.issues.length > 0) {
      throw verificationError(
        `${catalogue.issues.length} problème(s) dans ${file}.`,
        'Rien n\'a été lu de la boutique : le fichier est refusé avant qu\'elle ne soit interrogée.',
      );
    }
    return 0;
  }

  // ── import ────────────────────────────────────────────────────────────────
  if (catalogue.issues.length > 0) {
    if (json) reporter.result({ ok: false, file, stage: 'contract', issues: catalogue.issues });
    else {
      reporter.section(`Catalogue ${file}`);
      reportIssues(reporter, file, catalogue.issues);
    }
    throw verificationError(
      `${catalogue.issues.length} problème(s) dans ${file}. Rien n'a été écrit.`,
      'Corrigez le fichier, puis `shopctl catalog validate` avant de relancer l\'import.',
    );
  }

  const dryRun = args.values['--dry-run'] === true;
  const bucket = imagesBucket(shop.manifest, { env });
  // Checked BEFORE the read, not before the write: a read against the wrong
  // shop's database produces a plan that looks plausible and is about someone
  // else's catalogue.
  assertWranglerNamesShop(shop.root, bucket, { remote, env });
  if (remote) connectRemote({ shop, env, values: args.values, reporter });

  reporter.step(`Lecture du catalogue de la boutique (${remote ? 'distant' : 'local'})…`);
  const store = readCatalogue({ cwd: shop.root, remote });

  const plan = planImport(catalogue.products, store, {
    currency,
    createCategories: args.values['--create-categories'] === true,
    allowSlugChange: args.values['--allow-slug-change'] === true,
    allowRemoveVariants: args.values['--allow-remove-variants'] === true,
  });

  const oversized = catalogue.products.flatMap((product) =>
    product.media.filter(oversizedForDelivery).map((media) => media.path),
  );

  if (json) {
    reporter.result({
      ok: plan.refusals.length === 0,
      file,
      target: remote ? 'remote' : 'local',
      env,
      dryRun,
      applied: !dryRun && plan.refusals.length === 0,
      summary: plan.summary,
      changes: plan.changes,
      refusals: plan.refusals,
      warnings: plan.warnings,
      untouched: plan.untouched,
      statements: plan.statements.length,
    });
  } else {
    printPlan(reporter, plan, { file, dryRun, remote, oversized: [...new Set(oversized)] });
  }

  if (plan.refusals.length > 0) {
    throw verificationError(
      `${plan.refusals.length} refus : rien n'a été écrit dans la boutique.`,
      'Chaque refus nomme l\'option qui l\'autorise, ou la correction à faire dans l\'administration.',
    );
  }
  if (dryRun) return 0;

  for (const upload of plan.uploads) {
    reporter.step(`Envoi de ${upload.key} (${upload.path})…`);
    putObject(upload, { cwd: shop.root, bucket, remote, jurisdiction: jurisdictionFlags(shop.manifest, remote) });
  }
  applyStatements(plan.statements, { cwd: shop.root, remote });

  if (!json) reporter.ok(`Import appliqué : ${plan.statements.length} instruction(s), ${plan.uploads.length} image(s) envoyée(s).`);
  return 0;
}

/** How many individual changes the human report spells out before summarising.
 *  A first import of two hundred products would otherwise print a thousand
 *  lines nobody reads; --json always carries all of them. */
const CHANGE_LINES = 30;

/** The human report. Under --json the same numbers travel in `summary`. */
function printPlan(reporter, plan, { file, dryRun, remote, oversized }) {
  reporter.section(`${dryRun ? 'Simulation' : 'Import'} de ${file} vers la base ${remote ? 'distante' : 'locale'}`);

  for (const refusal of plan.refusals) reporter.fail(refusal.message, refusal.hint);
  for (const warning of plan.warnings) reporter.warn(warning);
  for (const path of oversized) {
    reporter.warn(
      `« ${path} » dépasse ${DELIVERY_MAX_WIDTH} px de large.`,
      'Stockée telle quelle : la boutique sert déjà ses images redimensionnées à la demande. Une source plus petite économise le stockage, pas la bande passante.',
    );
  }

  // Which products change, not only how many. A dry run whose whole answer is
  // "17 updated" cannot be reviewed: the operator's question is always whether
  // the seventeen are the ones they edited.
  if (plan.changes.length > 0) {
    reporter.section('Changements');
    for (const change of plan.changes.slice(0, CHANGE_LINES)) {
      reporter.ok(`${change.kind} ${change.subject}${change.detail ? ` — ${change.detail}` : ''}`);
    }
    if (plan.changes.length > CHANGE_LINES) {
      reporter.todo(`… et ${plan.changes.length - CHANGE_LINES} autre(s)`, 'La liste complète est dans la sortie --json.');
    }
  }

  const { summary } = plan;
  reporter.section('Plan');
  const line = (label, value) => (value > 0 ? reporter.ok(`${label} : ${value}`) : reporter.todo(`${label} : 0`));
  line('produits créés', summary.productsCreated);
  line('produits mis à jour', summary.productsUpdated);
  line('produits inchangés', summary.productsUnchanged);
  line('variantes créées', summary.variantsCreated);
  line('variantes mises à jour', summary.variantsUpdated);
  line('variantes désactivées', summary.variantsDeactivated);
  line('catégories créées', summary.categoriesCreated);
  line('images envoyées', summary.mediaUploaded);
  line('images déjà présentes', summary.mediaReused);

  if (plan.untouched.length > 0) {
    reporter.section('Hors fichier');
    reporter.todo(
      `${plan.untouched.length} produit(s) de la boutique ne sont pas dans ce fichier et ne sont pas touchés.`,
      plan.untouched.slice(0, 5).map((product) => product.slug).join(', ') + (plan.untouched.length > 5 ? ', …' : ''),
    );
  }
}

function runReport({ shop, remote, env, json, values }, reporter) {
  assertWranglerNamesShop(shop.root, imagesBucket(shop.manifest, { env }), { remote, env });
  if (remote) connectRemote({ shop, env, values, reporter });
  const store = readCatalogue({ cwd: shop.root, remote });
  const withSku = store.products.filter((product) => product.sku);
  const activeVariants = store.variants.filter((variant) => variant.active === 1);
  const payload = {
    shop: shop.manifest.client.slug,
    target: remote ? 'remote' : 'local',
    env,
    products: store.products.length,
    productsActive: store.products.filter((product) => product.active === 1).length,
    productsWithSku: withSku.length,
    variants: activeVariants.length,
    categories: store.categories.length,
    media: store.media.length,
  };

  if (json) {
    reporter.result({ ok: true, ...payload });
    return 0;
  }

  reporter.section(`Catalogue de ${payload.shop} (${payload.target})`);
  reporter.ok(`${payload.products} produit(s), dont ${payload.productsActive} actif(s)`);
  // A product without a reference cannot be matched by a CSV: it is the
  // difference between a catalogue an import can maintain and one it can only
  // add to, so it is the number worth showing next to the total.
  const missing = payload.products - payload.productsWithSku;
  if (missing > 0) {
    reporter.warn(
      `${missing} produit(s) sans référence`,
      'Un import ne peut les retrouver que par leur URL. Renseignez leur SKU dans l\'administration pour qu\'ils soient maintenus par le fichier.',
    );
  } else {
    reporter.ok('tous les produits portent une référence');
  }
  reporter.ok(`${payload.variants} variante(s) active(s)`);
  reporter.ok(`${payload.categories} catégorie(s)`);
  reporter.ok(`${payload.media} média(s)`);
  return 0;
}
