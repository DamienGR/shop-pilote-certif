/**
 * `shopctl destroy` — remove one environment of one shop from Cloudflare.
 *
 * The command that closes the lifecycle: a shop is built and previewed on the
 * agency's account, and once it lives on the client's, what remains on the
 * agency's has to go. Leaving it is not neutral — it is a second copy of a
 * customer's shop, on an account that customer does not own, indefinitely
 * (ADR 0002).
 *
 * Everything about this file is shaped by the fact that it cannot be undone.
 *
 * IT ASKS FOR THE NAME. Not `--yes`, which is a reflex after the third time:
 * the operator types the shop's slug, and a slug that does not match the
 * manifest stops the run. `--yes` is required ON TOP in production, because
 * production is where a mistake is a shop that was serving customers a minute
 * ago (the posture ADR 0005 asks of a restore, applied to a teardown).
 *
 * IT READS FIRST AND REPORTS WHAT IT FOUND. A teardown that starts deleting
 * before saying what it is about to delete gives the operator nothing to stop.
 * `--dry-run` is the same walk with every write removed.
 *
 * IT DELETES THE DATABASE LAST, and only when everything else is gone. The
 * order is Worker (traffic stops), then the sessions namespace, then buckets,
 * then D1 — so a run that fails halfway leaves a database with no Worker,
 * which can still be read and exported, rather than buckets with no database,
 * which cannot be interpreted by anything.
 *
 * THE SESSIONS NAMESPACE IS THE SHOP'S TOO, though nothing in the tree names
 * it: the Astro adapter binds `SESSION` in the built configuration and
 * wrangler provisions it at the first deploy, as `<worker>-session`.
 * `wrangler delete` leaves it behind, so it is looked up by that name and
 * removed right after the Worker — it holds nothing a teardown means to keep,
 * and left in place it is one more thing of the shop's on an account the
 * client does not own.
 *
 * IT NEVER EMPTIES A BUCKET. R2 refuses to delete one that still holds objects,
 * and that refusal is relayed rather than worked around: a teardown that clears
 * a bucket on the operator's behalf is a teardown that deletes something nobody
 * meant to lose.
 *
 * The backups bucket is the last of the buckets, and the one most likely to be
 * refused: it holds the archives, which are the only way back from a teardown
 * that should not have happened. Emptying it is therefore the operator's own
 * act, after `backup pull` has copied out what they mean to keep — and until
 * they do, the database stays too.
 */
import {
  deleteBucket,
  deleteDatabase,
  deleteKvNamespace,
  deleteWorker,
  listBuckets,
  listDatabases,
  listKvNamespaces,
  expectedAccount,
  resolveAccount,
  whoami,
  workerExists,
} from '../cloudflare.mjs';
import { ShopctlError, inputError, preconditionError, verificationError } from '../errors.mjs';
import { requireEnvironment, resolveShop } from '../shop.mjs';
import { resourceNames } from '../../../scripts/manifest.mjs';

export const DESTROY_OPTIONS = { '--env': 'environnement', '--shop': 'slug', '--account': 'id', '--confirm': 'slug' };

export const destroyUsage = `Usage: shopctl destroy --env <staging|production> --confirm <slug> [options]

  --env <staging|production>  Environnement à supprimer. Obligatoire.
  --confirm <slug>            Le slug de la boutique, saisi. Obligatoire.
  --yes                       Confirmation supplémentaire. Obligatoire en production.
  --dry-run                   Lister ce qui serait supprimé, ne rien supprimer.
  --account <id>              Compte Cloudflare attendu, si le manifeste ne le déclare pas.
  --shop <slug>               Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                      Rapport lisible par une machine.

Supprime, dans cet ordre : le Worker, le namespace KV des sessions, les trois
buckets R2 (images, fichiers, sauvegardes), puis la base D1.
La base passe en dernier et seulement si le reste est parti — une exécution
interrompue laisse une base lisible plutôt que des buckets orphelins.

IRRÉVERSIBLE. Les commandes, les clients et les médias de cet environnement
disparaissent avec lui. Un bucket non vide n'est pas vidé pour vous : R2 refuse,
et le refus est relayé tel quel. Récupérez les archives à garder
(shopctl backup pull <id>) avant de vider le bucket des sauvegardes.
`;

export function runDestroy(args, reporter) {
  if (args.positionals.length > 0) {
    throw new ShopctlError(`destroy ne prend pas d'argument positionnel ; reçu « ${args.positionals.join('", "')} ».`, {
      kind: 'usage',
      hint: destroyUsage.trim(),
    });
  }

  const env = requireEnvironment(args.values['--env']);
  const dryRun = args.values['--dry-run'] === true;
  const json = args.values['--json'] === true;
  const shop = resolveShop(process.cwd(), args.values['--shop']);
  const { manifest, root } = shop;
  const names = resourceNames(manifest, { env });
  const jurisdiction = manifest.cloudflare.jurisdiction;

  // The typed name, before anything is read and long before anything is
  // written. `--yes` alone would be a reflex within a week; a slug has to be
  // looked up, and looking it up is the pause this command is buying.
  const confirmation = args.values['--confirm'];
  if (!dryRun) {
    if (confirmation === undefined) {
      throw preconditionError(
        `une suppression demande le slug de la boutique, saisi.`,
        `Relancez avec --confirm ${manifest.client.slug}. Cet environnement porte des commandes, des clients et des médias ; ils partent avec lui.`,
      );
    }
    if (confirmation !== manifest.client.slug) {
      throw inputError(
        `--confirm « ${confirmation} » ne nomme pas cette boutique.`,
        `La boutique de cet arbre est « ${manifest.client.slug} ». Rien n'a été supprimé.`,
      );
    }
    if (env === 'production' && args.values['--yes'] !== true) {
      throw preconditionError(
        'supprimer une PRODUCTION demande une confirmation supplémentaire.',
        `Relancez avec --yes. ${manifest.client.slug} sert ${manifest.cloudflare.productionDomain} ; après cette commande, plus rien ne le sert.`,
      );
    }
  }

  reporter.section('Compte Cloudflare');
  const account = resolveAccount(
    expectedAccount(manifest, env, args.values),
    whoami({ cwd: root }),
  );
  reporter.ok(`${account.name} (${account.id})`);

  // ── What is actually there ────────────────────────────────────────────────
  reporter.section(`À supprimer — ${manifest.client.slug} en ${env}${dryRun ? ' (simulation)' : ''}`);
  const buckets = listBuckets({ cwd: root, jurisdiction });
  const database = listDatabases({ cwd: root }).find((entry) => entry.name === names.database);
  const worker = workerExists(names.worker, { cwd: root });
  const sessions = listKvNamespaces({ cwd: root }).find((entry) => entry.title === names.sessions) ?? null;

  const present = [
    { kind: 'Worker', name: names.worker, exists: worker },
    { kind: 'namespace KV des sessions', name: names.sessions, exists: Boolean(sessions) },
    { kind: 'bucket images', name: names.images, exists: buckets.includes(names.images) },
    { kind: 'bucket fichiers', name: names.files, exists: buckets.includes(names.files) },
    { kind: 'bucket sauvegardes', name: names.backups, exists: buckets.includes(names.backups) },
    { kind: 'base D1', name: names.database, exists: Boolean(database) },
  ];
  for (const entry of present) {
    if (entry.exists) reporter.warn(`${entry.kind} ${entry.name}`);
    else reporter.ok(`${entry.kind} ${entry.name} — déjà absent`);
  }

  if (present.every((entry) => !entry.exists)) {
    reporter.result({ command: 'destroy', ok: true, dryRun, shop: manifest.client.slug, env, account: { id: account.id, name: account.name }, removed: [], remaining: [] });
    if (!json) reporter.section(`Rien à supprimer : ${env} n'existe pas sur ce compte.`);
    return 0;
  }

  if (dryRun) {
    reporter.result({
      command: 'destroy',
      ok: true,
      dryRun: true,
      shop: manifest.client.slug,
      env,
      account: { id: account.id, name: account.name },
      wouldRemove: present.filter((entry) => entry.exists).map((entry) => entry.name),
    });
    if (!json) {
      reporter.section(
        `Simulation. Pour supprimer : npm run shopctl -- destroy --env ${env} --confirm ${manifest.client.slug}${env === 'production' ? ' --yes' : ''}`,
      );
    }
    return 0;
  }

  // ── Worker, then buckets, then the database ───────────────────────────────
  reporter.section('Suppression');
  const removed = [];
  const failures = [];
  const record = (outcome, kind) => {
    if (outcome.removed) {
      removed.push(outcome.name);
      reporter.ok(`${kind} ${outcome.name} supprimé`);
    } else if (outcome.reason === 'absent') {
      reporter.ok(`${kind} ${outcome.name} — déjà absent`);
    } else {
      failures.push({ name: outcome.name, reason: outcome.reason });
      reporter.fail(`${kind} ${outcome.name} n'a pas pu être supprimé.`, outcome.reason);
    }
    return outcome;
  };

  if (worker) record(deleteWorker(names.worker, { cwd: root }), 'Worker');
  if (sessions) record(deleteKvNamespace(sessions, { cwd: root }), 'namespace KV des sessions');

  for (const [kind, name] of [
    ['bucket images', names.images],
    ['bucket fichiers', names.files],
    ['bucket sauvegardes', names.backups],
  ]) {
    if (!buckets.includes(name)) continue;
    const outcome = record(deleteBucket(name, { cwd: root, jurisdiction }), kind);
    if (!outcome.removed && outcome.reason !== 'absent') {
      reporter.step('    R2 refuse un bucket non vide, et rien ne le vide à votre place.');
      if (name === names.backups) {
        reporter.step(`    Ce sont les archives de ${env} : récupérez celles à garder avant de vider (shopctl backup pull <id> --env ${env}).`);
      }
      // `--remote` is not optional: wrangler 4 runs `r2 object` against the
      // local simulator by default, where the delete succeeds on nothing and
      // the next run is refused by the same bucket.
      reporter.step(`    npx wrangler r2 object delete ${name}/<clé> --remote -J ${jurisdiction}  — ou videz-le dans le tableau de bord.`);
    }
  }

  // The database only once nothing else is left. A run that stopped here leaves
  // something an operator can still read and export; the reverse leaves buckets
  // nothing can interpret.
  if (failures.length > 0) {
    reporter.section('La base D1 est conservée');
    reporter.step(`    ${names.database} n'a pas été touchée : ${failures.length} suppression(s) ont échoué avant elle.`);
    reporter.step('    Corrigez ce qui est nommé ci-dessus puis relancez — la commande reprend là où elle s\'est arrêtée.');
  } else if (database) {
    record(deleteDatabase(names.database, { cwd: root }), 'base D1');
  }

  const remaining = present
    .filter((entry) => entry.exists && !removed.includes(entry.name))
    .map((entry) => entry.name);

  reporter.result({
    command: 'destroy',
    ok: failures.length === 0,
    dryRun: false,
    shop: manifest.client.slug,
    env,
    account: { id: account.id, name: account.name },
    removed,
    remaining,
    failures,
  });

  if (failures.length > 0) {
    throw verificationError(
      `${failures.length} ressource(s) n'ont pas pu être supprimées ; ${names.database} est intacte.`,
      'Relancez la commande une fois le blocage levé : ce qui est déjà parti ne sera pas redemandé.',
    );
  }

  if (!json) {
    reporter.section(
      `${env} supprimé pour ${manifest.client.slug}. Le dépôt Git et son historique ne sont pas touchés.`,
    );
  }
  return 0;
}
