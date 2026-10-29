/**
 * `shopctl deploy` — one command from a checked-out shop to a running one.
 *
 * The exit criterion of jalon 6 is that a shop created by the CLI can be
 * deployed to staging with ONE command, human authorisations aside. That is what
 * this is: the whole ordered sequence of plan §5.5, with nothing left for the
 * operator to remember and nothing that has to be typed twice.
 *
 * The order is the one the plan fixes, and each position in it is a decision:
 *
 *  1. the resources exist and are still correct — asked of the account, not
 *     assumed from a previous run;
 *  2. the environment's configuration is rendered from the manifest;
 *  3. the verification suite the shop carries;
 *  4. in production, an applicative backup and a Time Travel bookmark, both
 *     before any migration;
 *  5. the migrations;
 *  6. the build;
 *  7. the upload;
 *  8. the internal secrets that provisioning could not set before the Worker
 *     existed;
 *  9. the smoke test, against the domain the configuration routes, or the
 *     workers.dev URL wrangler says it deployed to.
 *
 * Migrations BEFORE the upload, not after, and that is the additive-migration
 * rule doing its work (ADR 0006): between the two there is a window in which
 * the old code runs against the new schema, so a migration that only adds is
 * safe there and a migration that removes is not safe anywhere. The bookmark is
 * taken before the migrations for the same reason — it is the only moment at
 * which it can still describe the state the deploy started from.
 *
 * The backup is not optional in production, and there is no flag to skip it:
 * plan §9 blocks a deployment whose preceding backup failed. The bookmark is a
 * five-minute net inside one account; the backup is what a restore into a new
 * environment starts from (ADR 0005), and a migration is precisely the step
 * after which the previous state stops being reachable any other way.
 *
 * The smoke test is the last step and it can FAIL THE COMMAND. A deploy that
 * reports success for a site nobody can reach is worse than one that reports
 * failure, because the second one is looked at.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyMigrations,
  bucketExposure,
  listBuckets,
  listDatabases,
  listSecrets,
  putSecret,
  expectedAccount,
  resolveAccount,
  whoami,
  wrangler,
} from '../cloudflare.mjs';
import { ShopctlError, preconditionError, usageError, verificationError } from '../errors.mjs';
import { run } from '../process.mjs';
import { requireEnvironment, resolveShop } from '../shop.mjs';
import { INTERNAL_SECRETS, generateSecret, renderEnvironmentConfig } from './provision.mjs';
import { captureBackup, openPool, uploadArchive } from './backup.mjs';
import { repositoryPath } from '../backup/archive.mjs';
import { keyId, loadKey } from '../backup/crypto.mjs';
import { SMOKE_WAIT_SECONDS, originFromDeployOutput, runSmoke } from '../smoke.mjs';
import { environmentHost, resourceNames } from '../../../scripts/manifest.mjs';
import { guardOwner } from '../owner.mjs';
import { cnameInstruction, fallbackOrigin, findCustomHostname, hostnameState, locateHostname } from '../saas.mjs';

export const DEPLOY_OPTIONS = {
  '--env': 'environnement',
  '--shop': 'slug',
  '--account': 'id',
  '--url': 'origine',
  '--smoke-wait': 'secondes',
  '--key-file': 'chemin',
  '--backup-dir': 'répertoire',
};

export const deployUsage = `Usage: shopctl deploy --env <staging|production> [options]

  --env <staging|production>  Environnement visé. Obligatoire.
  --yes                       Confirmation explicite. Obligatoire en production.
  --dry-run                   Tout contrôler, ne rien téléverser.
  --skip-verify               Ne pas relancer \`npm run verify\` (la CI l'a déjà fait).
  --skip-build                Réutiliser le build présent dans dist/.
  --skip-smoke                Ne pas interroger l'URL déployée. À n'utiliser que
                              lorsque le réseau du runner ne peut pas l'atteindre,
                              ou avant que le DNS du commerçant ne pointe sur la
                              zone SaaS (cloudflare.saasZone).
  --url <origine>             Origine à interroger, si wrangler n'en annonce pas.
  --smoke-wait <secondes>     Attente au plus, tant que Cloudflare répond à la place
                              du Worker (propagation d'un nouveau nom). Défaut : ${SMOKE_WAIT_SECONDS}.
  --key-file <chemin>         Clé de la sauvegarde prise avant une mise en production.
                              Défaut : .shopctl/backup.key, sinon SHOPCTL_BACKUP_KEY.
  --backup-dir <répertoire>   Où écrire cette sauvegarde. Défaut : backups/.
  --account <id>              Compte Cloudflare attendu, si le manifeste ne le déclare pas.
  --shop <slug>               Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                      Rapport lisible par une machine.

Les ressources doivent exister : \`shopctl provision --env <env>\` d'abord.
En production, une sauvegarde chiffrée est prise avant les migrations ; si elle
échoue, rien n'est déployé. Quand cloudflare.saasZone sert le domaine du
commerçant, son nom d'hôte personnalisé doit exister et être actif sur la zone
(CLOUDFLARE_API_TOKEN pour le vérifier).
`;

/**
 * The verification a deployment runs before it touches anything.
 *
 * The SHOP's script, not this CLI's idea of one. `npm run verify` is what
 * AGENTS.md calls the single signal that a change is sound, and it is versioned
 * with the shop: a shop on an older core is verified by the gates that core
 * shipped, which is the only reading that makes a deployment reproducible.
 */
export function runVerification(root, { stdio = 'inherit' } = {}) {
  run('npm', ['run', 'verify'], { cwd: root, stdio });
}

/**
 * A Time Travel bookmark for the database, before anything writes to it.
 *
 * Not a backup, and the report says so: ADR 0005 keeps Time Travel as a
 * short-term safety net and makes the application-level export the reference.
 * What it is good for is exactly this moment — the five minutes in which a
 * migration turns out to have been wrong — and it costs one API call.
 */
export function takeBookmark(database, { cwd }) {
  const result = wrangler(['d1', 'time-travel', 'info', database, '--json'], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  const start = result.stdout.search(/[[{]/);
  if (start === -1) return null;
  try {
    const document = JSON.parse(result.stdout.slice(start));
    return document.bookmark ?? document.result?.bookmark ?? null;
  } catch {
    return null;
  }
}

export async function runDeploy(args, reporter) {
  if (args.positionals.length > 0) {
    throw new ShopctlError(`deploy ne prend pas d'argument positionnel ; reçu « ${args.positionals.join('", "')} ».`, {
      kind: 'usage',
      hint: deployUsage.trim(),
    });
  }

  const env = requireEnvironment(args.values['--env']);
  const dryRun = args.values['--dry-run'] === true;
  const json = args.values['--json'] === true;
  const shop = resolveShop(process.cwd(), args.values['--shop']);
  const { manifest, root } = shop;
  const names = resourceNames(manifest, { env });
  const jurisdiction = manifest.cloudflare.jurisdiction;
  // Under --json, stdout is the one report (report.mjs) — and the Deploy
  // workflow parses it for the origin. The verification suite and the build
  // stream to the terminal, so they write to stderr there, as `shopctl new`'s
  // installs do.
  const childStdio = json ? ['inherit', 2, 'inherit'] : 'inherit';
  // Read before anything slow: a typo here should not cost a verification run.
  const smokeWait = Number(args.values['--smoke-wait'] ?? SMOKE_WAIT_SECONDS);
  if (!Number.isInteger(smokeWait) || smokeWait < 0 || smokeWait > 600) {
    throw usageError(`--smoke-wait « ${args.values['--smoke-wait']} » n'est pas un nombre de secondes entre 0 et 600.`);
  }

  // Production is never a default and never an accident. `--yes` is eight
  // characters and is the difference between deploying to staging and
  // deploying to the shop that takes money. The same posture ADR 0005 asks of
  // a restore, applied to the deployment that precedes it.
  if (env === 'production' && args.values['--yes'] !== true && !dryRun) {
    throw preconditionError(
      'un déploiement en production demande une confirmation explicite.',
      `Relancez avec --yes : shopctl deploy --env production --yes. La boutique ${manifest.client.slug} sert ${manifest.cloudflare.productionDomain}.`,
    );
  }

  reporter.section('Compte Cloudflare');
  const identity = whoami({ cwd: root });
  const account = resolveAccount(
    expectedAccount(manifest, env, args.values),
    identity,
  );
  reporter.ok(`${account.name} (${account.id})`);

  // The backup key, before anything slow. A production deployment that runs
  // the whole verification suite and only then discovers it cannot back up has
  // spent the operator's attention on a run that was never going to proceed.
  // Asked in a dry run too: "would this deployment be allowed?" includes it.
  let backupKey = null;
  if (env === 'production') {
    const loaded = loadKey({ root, file: args.values['--key-file'] });
    backupKey = loaded.key;
    reporter.ok(`clé de sauvegarde ${keyId(backupKey)} (${loaded.source})`);
  }

  // ── The resources this deployment needs ───────────────────────────────────
  reporter.section(`Ressources de ${manifest.client.slug} en ${env}`);
  const buckets = listBuckets({ cwd: root, jurisdiction });
  const database = listDatabases({ cwd: root }).find((entry) => entry.name === names.database);
  const missing = [
    database ? null : names.database,
    buckets.includes(names.images) ? null : names.images,
    buckets.includes(names.files) ? null : names.files,
    // Production backs up before it migrates, and the backup has to outlive the
    // machine that took it — a CI runner is gone ten minutes later.
    env === 'production' && !buckets.includes(names.backups) ? names.backups : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw preconditionError(
      `${missing.length} ressource(s) manquante(s) en ${env} : ${missing.join(', ')}.`,
      `Lancez \`shopctl provision --env ${env}\` d'abord. Un déploiement ne crée rien : la création des ressources porte une juridiction irréversible (ADR 0004) et n'a pas sa place dans un chemin qu'on rejoue à chaque commit.`,
    );
  }
  const databaseId = database.uuid ?? database.database_id;
  reporter.ok(`${names.database} (${databaseId}), ${names.images}, ${names.files} — juridiction ${jurisdiction}`);
  // Before the backup, the migrations and the upload: on a shared account
  // (ADR 0019) the database found by this name may be another shop's, and
  // everything below would write into it.
  guardOwner({ database: names.database, root, manifest, env, reporter });

  // Re-asked at every deploy, not only at provisioning. The bucket holds the
  // merchant's paid downloads and it is one dashboard click from being public;
  // the deploy path is the one thing that runs often enough to notice.
  const filesExposure = bucketExposure(names.files, { cwd: root, jurisdiction });
  if (filesExposure.public) {
    throw verificationError(
      `${names.files} est devenu public (${filesExposure.devUrl ?? filesExposure.domains.join(', ')}).`,
      'Ce bucket porte les fichiers vendus. Coupez l\'URL r2.dev et détachez le domaine avant de déployer.',
    );
  }
  // "We could not ask" is not "it is closed". Said out loud rather than counted
  // as a pass, because `public: false` is what an unanswered call also looks
  // like from here.
  if (!filesExposure.known) {
    reporter.warn(
      `${names.files} — l'exposition publique n'a pas pu être lue.`,
      'Le déploiement continue ; vérifiez-la dans le tableau de bord avant d\'annoncer la boutique.',
    );
  } else {
    reporter.ok(`${names.files} — toujours privé`);
  }

  // The images domain is rendered into production's configuration, and from
  // then on every product image is a link to it. Declared in the manifest but
  // not attached to the bucket, that is a catalogue of broken images on the
  // day the shop opens — refused here, before the backup and the migrations,
  // rather than discovered by the first visitor (certification step 9).
  const imagesDomain = env === 'production' ? (manifest.cloudflare.imagesDomain ?? null) : null;
  if (imagesDomain) {
    const imagesExposure = bucketExposure(names.images, { cwd: root, jurisdiction });
    if (!imagesExposure.known) {
      reporter.warn(
        `${names.images} — les domaines attachés n'ont pas pu être lus ; ${imagesDomain} n'est pas vérifié.`,
        `Le déploiement continue ; ouvrez une image produit sur https://${imagesDomain} avant d'annoncer la boutique.`,
      );
    } else if (!imagesExposure.domains.includes(imagesDomain)) {
      throw verificationError(
        `cloudflare.imagesDomain annonce ${imagesDomain}, qui n'est pas attaché à ${names.images}${imagesExposure.domains.length > 0 ? ` (attaché : ${imagesExposure.domains.join(', ')})` : ''}.`,
        `Chaque image du catalogue serait cassée. Attachez le domaine au bucket (tableau de bord → R2 → ${names.images} → Settings → Custom Domains), ou retirez cloudflare.imagesDomain du manifeste : les images passent alors par le Worker.`,
      );
    } else {
      reporter.ok(`${names.images} — domaine d'images ${imagesDomain} attaché`);
    }
  }

  // The route rendered below sends the merchant's domain to this Worker only
  // if the SaaS zone knows it as a custom hostname (ADR 0019). Asked before the
  // backup and the migrations, like the images domain: a deployment nobody can
  // reach is found out here, not by the smoke test after the upload.
  const hostnamePending = await checkHostname({ manifest, env, account, reporter, smokeElsewhere: args.values['--skip-smoke'] === true || args.values['--url'] !== undefined });

  // ── Configuration ─────────────────────────────────────────────────────────
  reporter.section('Configuration');
  renderEnvironmentConfig({ root, manifest, env, databaseId });
  reporter.ok(`wrangler.jsonc rendu pour ${names.worker}`);
  // A warning, not a refusal: the preview is still private, and an admin that
  // already has a password still opens. What breaks is the first run — behind
  // Access every request carries an assertion, the Worker has nothing to
  // verify it with, and /admin/setup answers 403 (src/features/auth/accessGate.ts).
  if (env === 'staging' && manifest.cloudflare.stagingDomain && !manifest.cloudflare.stagingAccessTeam) {
    reporter.warn(
      `${manifest.cloudflare.stagingDomain} est servi sans cloudflare.stagingAccessTeam ni cloudflare.stagingAccessAud.`,
      'Derrière l\'application Access, le Worker refuse une assertion qu\'il ne peut pas vérifier : /admin/setup répond 403 tant qu\'aucun mot de passe n\'existe. Déclarez le nom d\'équipe Zero Trust et l\'AUD de l\'application dans le manifeste, puis redéployez.',
    );
  }

  // ── Verification ──────────────────────────────────────────────────────────
  const skipVerify = args.values['--skip-verify'] === true;
  reporter.section('Vérification');
  if (skipVerify) {
    reporter.warn('`npm run verify` sauté (--skip-verify).', 'À réserver au cas où la même révision vient de le passer dans un job dédié.');
  } else if (dryRun) {
    reporter.todo('`npm run verify` serait exécuté.');
  } else {
    runVerification(root, { stdio: childStdio });
    reporter.ok('npm run verify');
  }

  // ── Backup, bookmark, then migrations ─────────────────────────────────────
  //
  // The backup reads through the `DB` binding of the configuration rendered
  // above, which is this environment's database and no other. Any failure
  // throws and the deployment stops here, before the first write.
  let backup = null;
  if (env === 'production') {
    reporter.section('Sauvegarde préalable');
    const repository = repositoryPath(root, args.values['--backup-dir']);
    if (dryRun) reporter.todo(`une sauvegarde chiffrée serait écrite dans ${repository} puis copiée dans ${names.backups}`);
    else {
      const pool = openPool({ manifest, root, env, key: backupKey, reporter });
      const taken = captureBackup({ manifest, root, env, account, key: backupKey, repository, pool, reporter });
      const uploaded = uploadArchive({ manifest, root, env, path: taken.path, id: taken.id, key: backupKey, pool, reporter });
      backup = { id: taken.id, path: taken.path, bytes: taken.bytes, schema: taken.schema.version, uploaded };
    }
  }

  reporter.section('Base de données');
  let bookmark = null;
  if (env === 'production' && !dryRun) {
    bookmark = takeBookmark(names.database, { cwd: root });
    if (bookmark) {
      reporter.ok(`bookmark Time Travel avant migration : ${bookmark}`);
      reporter.step('    Filet de sécurité court terme, pas une sauvegarde (ADR 0005).');
    } else {
      reporter.warn('aucun bookmark Time Travel n\'a pu être pris.', 'Le déploiement continue ; la restauration passerait par la sauvegarde applicative.');
    }
  }

  if (dryRun) reporter.todo(`les migrations seraient appliquées à ${names.database}`);
  else {
    applyMigrations({ cwd: root, remote: true });
    reporter.ok(`migrations appliquées à ${names.database}`);
  }

  // ── Build and upload ──────────────────────────────────────────────────────
  reporter.section('Build et déploiement');
  const skipBuild = args.values['--skip-build'] === true;
  if (dryRun) {
    reporter.todo(skipBuild ? 'dist/ serait réutilisé' : '`npm run build` serait exécuté');
    reporter.todo(`${names.worker} serait téléversé`);
    reporter.result({ command: 'deploy', ok: true, dryRun: true, shop: manifest.client.slug, env, account, resources: names, databaseId });
    reporter.section('Simulation terminée. Relancez sans --dry-run pour déployer.');
    return 0;
  }

  if (skipBuild) {
    if (!existsSync(resolve(root, 'dist/server'))) {
      throw preconditionError('--skip-build a été demandé mais dist/server n\'existe pas.', 'Lancez `npm run build`, ou retirez --skip-build.');
    }
    reporter.ok('build existant réutilisé (--skip-build)');
  } else {
    run('npm', ['run', 'build'], { cwd: root, stdio: childStdio });
    reporter.ok('npm run build');
  }

  // Read BEFORE the upload: the version serving now is the one to come back to
  // if this one fails. Asked after, it can only be guessed from a list.
  const rollback = activeVersion(names.worker, { cwd: root });
  const uploaded = wrangler(['deploy'], { cwd: root });
  // The custom domain first: it is the route this command just rendered, and
  // wrangler lists it bare — "preview.example.fr (custom domain)" — with no
  // workers.dev URL beside it once that door is shut. Read from the output,
  // the origin of a gated staging or of any production would be nothing at all.
  const host = environmentHost(manifest, env);
  const origin = args.values['--url'] ?? (host ? `https://${host}` : originFromDeployOutput(`${uploaded.stdout}\n${uploaded.stderr}`));
  reporter.ok(`${names.worker} déployé${origin ? ` — ${origin}` : ''}`);

  // ── The secrets provisioning could not set ────────────────────────────────
  //
  // This is where the first deployment closes the loop: before it, the Worker
  // did not exist and `secret put` had nothing to attach to. Existing secrets
  // are kept, never rotated — SECRETS_KEK decrypts the payment keys already in
  // D1 (see provision.mjs).
  reporter.section('Secrets internes');
  const secrets = { present: [], created: [] };
  const known = listSecrets(names.worker, { cwd: root }) ?? [];
  for (const [name, what] of INTERNAL_SECRETS) {
    if (known.includes(name)) {
      secrets.present.push(name);
      reporter.ok(`${name} déjà posé — conservé`);
      continue;
    }
    putSecret(names.worker, name, generateSecret(), { cwd: root });
    secrets.created.push(name);
    reporter.ok(`${name} généré et transmis par entrée standard (${what})`);
  }

  // ── Smoke test ────────────────────────────────────────────────────────────
  reporter.section('Test de fumée');
  let smoke = null;
  if (args.values['--skip-smoke'] === true) {
    reporter.warn('test de fumée sauté (--skip-smoke).');
  } else if (!origin) {
    // Not a pass. A deployment nobody can address is not one anybody can use,
    // and the operator has to be told which URL to give the command.
    throw verificationError(
      'wrangler n\'a annoncé aucune URL et --url n\'a pas été fourni : le test de fumée ne sait pas quoi interroger.',
      `Relancez avec --url https://… (le domaine de la boutique, ou l'URL workers.dev de ${names.worker}).`,
    );
  } else {
    // A staging environment with a hostname is a preview the client is meant to
    // see and nobody else; its smoke test asks the opposite question of a public
    // one. Read from the manifest rather than from a flag, so a deployment
    // cannot be told the shop is private when the configuration says otherwise.
    const gated = env === 'staging' && Boolean(manifest.cloudflare.stagingDomain);
    smoke = await runSmoke(origin, {
      gated,
      waitMs: smokeWait * 1000,
      onWait: ({ intervalMs, remainingMs }) => reporter.step(
        `    Cloudflare ne sert pas encore ${names.worker} sous ${origin} : nouvel essai dans ${intervalMs / 1000} s (encore ${Math.ceil(remainingMs / 1000)} s au plus).`,
      ),
    });
    if (gated) reporter.step(`    Preview privée attendue sur ${manifest.cloudflare.stagingDomain}.`);
    for (const result of smoke.results) {
      const line = `${result.path} — ${result.what}${result.status ? ` (${result.status})` : ''}`;
      if (result.ok) reporter.ok(line);
      else if (result.severity === 'warn') reporter.warn(line, result.message);
      else reporter.fail(line, result.message);
    }
  }

  reporter.result({
    command: 'deploy',
    ok: smoke ? smoke.ok : true,
    dryRun: false,
    shop: manifest.client.slug,
    env,
    account: { id: account.id, name: account.name },
    resources: names,
    databaseId,
    backup,
    bookmark,
    origin,
    secrets,
    smoke,
    rollbackTo: rollback,
  });

  if (smoke && !smoke.ok) {
    const { message, hint } = smokeFailure({ smoke, origin, worker: names.worker, env, rollback, waitSeconds: smokeWait });
    throw verificationError(message, hint);
  }

  // Before the switch, the domain still leads wherever it led — on a shop
  // moving accounts, to the copy this one replaces.
  if (!json) {
    reporter.section(
      hostnamePending
        ? `${manifest.client.slug} est déployé en ${env}, mais https://${host} ne mène à lui qu'une fois son nom d'hôte actif.`
        : `${manifest.client.slug} est en ligne en ${env}${origin ? ` sur ${origin}` : ''}.`,
    );
  }
  return 0;
}

/**
 * What a failed smoke test tells the operator to do.
 *
 * Two different failures, and the advice of one is wrong for the other. A shop
 * that answers and is broken is the code's fault: roll back. A name Cloudflare
 * still answers for is no fault of the version, and a rollback would change
 * nothing — the previous version is served under the same name, or not at
 * all. Step 7 got the first advice for the second failure.
 */
export function smokeFailure({ smoke, origin, worker, env, rollback, waitSeconds }) {
  if (smoke.notServed) {
    return {
      message: `Cloudflare ne sert toujours pas ${worker} sous ${origin}${waitSeconds > 0 ? ` après ${waitSeconds} s` : ''} : le test de fumée n'a pas pu interroger la boutique.`,
      hint: `Le téléversement a eu lieu. Un nouveau nom sur workers.dev peut mettre plus longtemps à être servi partout : relancez le test dans quelques minutes, npm run shopctl -- deploy --env ${env} --skip-verify --skip-build. Si Cloudflare répond encore, la route ou le domaine ne mène pas à ${worker}.`,
    };
  }
  return {
    message: `le test de fumée a échoué sur ${origin} : la version déployée ne sert pas la boutique.`,
    hint: rollback
      ? `Revenez à la version qui servait avant ce déploiement : npx wrangler rollback ${rollback} --name ${worker}. Les migrations, elles, ne se rejouent pas à l'envers (ADR 0006) — c'est le code qui recule.`
      : `Aucune version antérieure n'existe sur ${worker} : c'est le premier déploiement, il n'y a rien derrière quoi revenir.`,
  };
}

/**
 * The version to roll back to: the one serving before this deployment.
 *
 * Named in the failure message rather than rolled back automatically: an
 * automatic rollback on a failed smoke test would also fire on a check that
 * failed because the network could not reach the site, and would undo a
 * deployment that was fine. The operator gets the exact command, with the
 * version id already resolved, which is the part that is tedious to find under
 * pressure.
 *
 * Asked of the DEPLOYMENT, before the upload, and not read off `versions list`
 * afterwards. That list is oldest first (the ten most recent, sorted by
 * `created_on`), and it counts every `secret put` as a version: its second
 * entry, which this function used to return, was the pilot's first secret
 * version of step 3 in every report of the certification — a rollback to
 * v0.3.2 offered as "the previous version" through v0.3.9.
 */
export function activeVersion(worker, { cwd }) {
  const result = wrangler(['deployments', 'status', '--name', worker, '--json'], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  const start = result.stdout.search(/[[{]/);
  if (start === -1) return null;
  try {
    const deployment = JSON.parse(result.stdout.slice(start));
    const [serving] = [...(deployment.versions ?? [])].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0));
    return serving?.version_id ?? null;
  } catch {
    return null;
  }
}

/**
 * The merchant's domain, served through the SaaS zone: it has to exist there,
 * and be active, for the smoke test to reach the shop.
 *
 * Missing is a refusal: `provision` creates it, and a deploy creates nothing.
 * Pending — the merchant's CNAME not in yet — is a refusal too, unless the
 * smoke test was pointed elsewhere or skipped on purpose: the first deploy of
 * a shop whose domain switches over at launch is exactly that case, and it is
 * the operator's to say, not this command's to guess.
 *
 * @returns {Promise<boolean>} true when the hostname is still pending
 */
async function checkHostname({ manifest, env, account, reporter, smokeElsewhere }) {
  const located = await locateHostname({ manifest, env, account, reporter, required: true });
  if (!located) return false;
  const { hostname, zoneName, token, zone } = located;
  const record = await findCustomHostname(zone.id, hostname, { token });
  if (!record) {
    throw preconditionError(
      `${hostname} n'est pas un nom d'hôte personnalisé de ${zoneName}.`,
      `Lancez \`shopctl provision --env ${env}\` d'abord : il le crée, et dit quel CNAME le commerçant doit poser.`,
    );
  }
  const state = hostnameState(record);
  if (state.active) {
    reporter.ok(`${hostname} — actif sur ${zoneName}, certificat actif`);
    return false;
  }
  const instruction = cnameInstruction(hostname, await fallbackOrigin(zone.id, { token }), zoneName);
  const detail = `${hostname} n'est pas encore actif sur ${zoneName} (état ${state.status ?? 'inconnu'}, certificat ${state.ssl ?? 'inconnu'})`;
  if (smokeElsewhere) {
    reporter.warn(`${detail} : la boutique ne répondra sur son domaine qu'une fois le DNS posé.`, instruction);
    return true;
  }
  throw preconditionError(
    `${detail} : le test de fumée n'aurait rien à interroger.`,
    `${instruction} Pour déployer avant la bascule du domaine, relancez avec --skip-smoke (ou --url vers une autre origine).`,
  );
}
