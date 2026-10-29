/**
 * `shopctl restore` — put a shop's data back, into an environment that is ready
 * for it.
 *
 * The exit criterion of jalon 8 is that a shop can be restored into a NEW
 * environment in under an hour from a documented backup. That is the shape of
 * this command: it does the whole sequence, it proves what it did, and the
 * proof is the point — ADR 0005 says a restore cannot be "almost" tested, so
 * this one re-reads the database it just wrote and compares it, table by table,
 * against the digests the archive carried. A restore that reports success
 * without that comparison is a restore nobody has actually verified.
 *
 * Three postures, all of them about not writing over something:
 *
 *  - **staging is the default target and an EMPTY database is the default
 *    precondition.** A restore into a database that already has rows needs
 *    `--overwrite`, said out loud, because the rows it replaces are as real as
 *    the ones it restores;
 *  - **production is never reached by omission.** It costs the dedicated option
 *    the plan asks for (`--allow-production`) AND the shop's slug typed out —
 *    the same pause `destroy` buys, for the same reason: `--yes` becomes a
 *    reflex and a slug has to be looked up;
 *  - **the schema is checked before anything is written.** An archive taken on a
 *    newer schema than the tree carries is refused: its rows have columns the
 *    target's tables do not, and the failure would land halfway through the
 *    insert.
 *
 * `--local` restores into the tree's own `.wrangler/state` instead — no
 * account, no resource, and the same comparison at the end. It is what the
 * nightly run uses to prove last night's archive still opens and still
 * restores (plan §7.3) on a runner that is thrown away afterwards, without a
 * second set of databases on the account to keep. A PRODUCTION archive is
 * refused there: it carries the buyers' personal data, and a laptop is not a
 * place the RGPD register says it goes.
 *
 * MIGRATIONS FIRST, then data. The archive holds rows, never DDL — which is
 * what makes it restorable into another account whose database was created five
 * minutes ago, and what makes the additive-migration rule (ADR 0006) the thing
 * that keeps an old archive readable by a newer tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyMigrations, listBuckets, listDatabases, expectedAccount, resolveAccount, whoami } from '../cloudflare.mjs';
import { ShopctlError, inputError, preconditionError, verificationError } from '../errors.mjs';
import { requireEnvironment } from '../shop.mjs';
import { PROVISIONED_SETTINGS, renderEnvironmentConfig } from './provision.mjs';
import { resourceNames } from '../../../scripts/manifest.mjs';
import { restoreScript, tableDigest } from '../backup/dump.mjs';
import { classifyTables, generatedColumns, orderTables, seededTables } from '../backup/schema.mjs';
import { applyScript, countRows, putObject, query, readSchema, readTables } from '../backup/store.mjs';
import { DATA_FILE, authenticatedHeader, objectContext, readArchive } from '../backup/archive.mjs';
import { keyId, keyMatches, loadKey, open } from '../backup/crypto.mjs';
import { backupContext } from './backup.mjs';
import { guardOwner } from '../owner.mjs';

const LOCAL_DATABASE_ID = '00000000-0000-4000-8000-00000000c0de';

export const RESTORE_OPTIONS = {
  '--env': 'environnement',
  '--from': 'identifiant',
  '--shop': 'slug',
  '--account': 'id',
  '--out': 'répertoire',
  '--key-file': 'chemin',
  '--confirm': 'slug',
};

export const RESTORE_FLAGS = ['--dry-run', '--overwrite', '--allow-production', '--allow-missing-media', '--local'];

export const restoreUsage = `Usage: shopctl restore --env <staging|production> --from <id> [options]

  --env <staging|production>  Environnement visé. Obligatoire.
  --from <id>                 Sauvegarde à restaurer. Obligatoire.
  --overwrite                 Écraser des données existantes dans la cible.
  --allow-production          Autoriser la production comme cible. Obligatoire pour elle.
  --confirm <slug>            Le slug de la boutique, saisi. Obligatoire en production.
  --allow-missing-media       Continuer si l'archive ne porte pas les octets R2.
  --dry-run                   Tout contrôler et comparer, ne rien écrire.
  --local                     Restaurer dans la D1 locale de l'arbre (.wrangler/state),
                              sans compte : la preuve qu'une archive se rouvre. Refusé
                              pour une archive de production.
  --out <répertoire>          Dépôt des sauvegardes. Défaut : backups/.
  --key-file <chemin>         Clé de chiffrement. Défaut : .shopctl/backup.key, sinon SHOPCTL_BACKUP_KEY.
  --account <id>              Compte Cloudflare attendu, si le manifeste ne le déclare pas.
  --shop <slug>               Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                      Rapport lisible par une machine.

Par défaut, la cible doit être VIDE : une restauration remplace les lignes qui
sont là. Les ressources doivent exister — \`shopctl provision --env <env>\` d'abord.
La restauration se termine par une comparaison ligne à ligne avec le manifeste
de l'archive ; une différence fait échouer la commande.
`;

export function runRestore(args, reporter) {
  if (args.positionals.length > 0) {
    throw new ShopctlError(`restore ne prend pas d'argument positionnel ; reçu « ${args.positionals.join('", "')} ».`, {
      kind: 'usage',
      hint: restoreUsage.trim(),
    });
  }

  const env = requireEnvironment(args.values['--env']);
  const dryRun = args.values['--dry-run'] === true;
  const local = args.values['--local'] === true;
  const remote = !local;
  const { manifest, root, repository } = backupContext(args);
  const names = resourceNames(manifest, { env });
  const jurisdiction = ['-J', manifest.cloudflare.jurisdiction];

  const from = args.values['--from'];
  if (!from) throw inputError('restore demande --from <id>.', 'shopctl backup list donne les sauvegardes disponibles.');

  // Production, before anything is read. The two gates the plan asks for
  // (§5.6): a dedicated option, and a confirmation the operator types.
  if (env === 'production' && !dryRun && remote) {
    if (args.values['--allow-production'] !== true) {
      throw preconditionError(
        'restaurer une PRODUCTION demande une option dédiée.',
        `Relancez avec --allow-production --confirm ${manifest.client.slug}. Le défaut de cette commande est staging, et ce n'est pas un oubli (ADR 0005).`,
      );
    }
    if (args.values['--confirm'] !== manifest.client.slug) {
      throw preconditionError(
        'restaurer une PRODUCTION demande le slug de la boutique, saisi.',
        `Relancez avec --confirm ${manifest.client.slug}. Les lignes que cette commande remplace sont les commandes en cours de ${manifest.cloudflare.productionDomain}.`,
      );
    }
  }

  // ── The archive ───────────────────────────────────────────────────────────
  const entry = readArchive(repository, from);
  const archive = entry.manifest;
  reporter.section(`Sauvegarde ${archive.id}`);
  reporter.ok(`${archive.shop} — ${archive.env}, ${archive.createdAt}, socle ${archive.coreVersion}`);

  if (archive.shop !== manifest.client.slug) {
    throw inputError(
      `cette sauvegarde est celle de « ${archive.shop} », pas de « ${manifest.client.slug} ».`,
      'Restaurer la boutique d\'un client dans celle d\'un autre est la seule erreur de cette commande qui ne se rattrape pas. Rien n\'a été écrit.',
    );
  }

  if (local && (archive.env === 'production' || env === 'production')) {
    throw preconditionError(
      'une archive de production ne se restaure pas en local.',
      'Elle porte les données personnelles des acheteurs, et un poste n\'est pas un lieu de traitement déclaré. Restaurez-la dans un environnement du compte, ou prenez une sauvegarde de staging.',
    );
  }

  const { key, source } = loadKey({ root, file: args.values['--key-file'] });
  if (!keyMatches(key, archive.cipher.keyId)) {
    throw preconditionError(
      `la clé disponible (${keyId(key)}) n'est pas celle de cette archive (${archive.cipher.keyId}).`,
      `${source} porte une autre clé. Une archive ne se relit qu'avec celle qui l'a fermée.`,
    );
  }
  const ciphertext = readFileSync(join(entry.path, archive.data.file ?? DATA_FILE));
  let payload;
  try {
    payload = JSON.parse(open({ iv: archive.cipher.iv, tag: archive.cipher.tag, ciphertext }, key, authenticatedHeader(archive)).toString('utf8'));
  } catch {
    throw verificationError(
      'le corps de l\'archive ne s\'ouvre pas.',
      'La clé est la bonne : c\'est donc que le corps ou le manifeste en clair a été modifié depuis la sauvegarde. `shopctl backup verify` dit lequel.',
    );
  }
  const dump = payload.tables ?? {};
  reporter.ok(`corps ouvert — ${archive.tables.length} table(s), ${archive.tables.reduce((sum, table) => sum + table.rows, 0)} ligne(s)`);

  // ── Account and resources ─────────────────────────────────────────────────
  let account = null;
  if (local) {
    reporter.section('Cible locale');
    // The database id is a placeholder: a local D1 is keyed by it, and none of
    // the account's ids belongs in a configuration that never reaches it.
    renderEnvironmentConfig({ root, manifest, env, databaseId: LOCAL_DATABASE_ID });
    reporter.ok(`${names.database} dans .wrangler/state — aucun compte interrogé`);
  } else {
    reporter.section('Compte Cloudflare');
    account = resolveAccount(
      expectedAccount(manifest, env, args.values),
      whoami({ cwd: root }),
    );
    reporter.ok(`${account.name} (${account.id})`);
    if (account.id !== archive.account?.id) {
      // Not a refusal: restoring into ANOTHER account is the point of an
      // application-level backup (ADR 0005 — a clean exit for the client). It is
      // said out loud because it is also what a mistake looks like.
      reporter.warn(
        `l'archive vient du compte ${archive.account?.name ?? 'inconnu'} (${archive.account?.id ?? '—'}).`,
        'Restauration inter-comptes : c\'est ce que permet une sauvegarde applicative, et c\'est aussi à quoi ressemble une erreur de compte.',
      );
    }

    const database = listDatabases({ cwd: root }).find((candidate) => candidate.name === names.database);
    const buckets = listBuckets({ cwd: root, jurisdiction: manifest.cloudflare.jurisdiction });
    const missing = [
      database ? null : names.database,
      buckets.includes(names.images) ? null : names.images,
      buckets.includes(names.files) ? null : names.files,
    ].filter(Boolean);
    if (missing.length > 0) {
      throw preconditionError(
        `${missing.length} ressource(s) manquante(s) en ${env} : ${missing.join(', ')}.`,
        `Lancez \`shopctl provision --env ${env}\` d'abord : une restauration remplit des ressources, elle n'en crée pas.`,
      );
    }
    const databaseId = database.uuid ?? database.database_id;
    // A restore with --overwrite replaces what is there: on a shared account
    // (ADR 0019) the database of this name has to be proven this shop's first.
    guardOwner({ database: names.database, root, manifest, env, reporter });
    renderEnvironmentConfig({ root, manifest, env, databaseId });
    reporter.ok(`${names.database} (${databaseId}) — wrangler.jsonc rendu`);
  }

  // ── Schema ────────────────────────────────────────────────────────────────
  reporter.section('Schéma');
  if (!dryRun) {
    applyMigrations({ cwd: root, remote });
    reporter.ok(`migrations de l'arbre appliquées à ${names.database}`);
  } else {
    reporter.todo(`les migrations seraient appliquées à ${names.database}`);
  }

  const { master, migrations } = readSchema({ cwd: root, remote });
  const { tables } = classifyTables(master);
  const present = new Set(tables.map((table) => table.name));
  const absent = archive.tables.filter((table) => table.rows > 0 && !present.has(table.name)).map((table) => table.name);
  if (absent.length > 0) {
    throw verificationError(
      `la cible n'a pas ${absent.length} table(s) que l'archive remplit : ${absent.join(', ')}.`,
      `L'archive a été prise sur le schéma ${archive.schema.version ?? 'inconnu'} et cet arbre s'arrête à ${migrations.at(-1)?.name ?? 'aucune migration'}. Restaurez depuis un arbre au moins aussi récent que l'archive (ADR 0006 : les migrations sont additives, l'inverse ne l'est pas).`,
    );
  }
  reporter.ok(`schéma cible ${migrations.at(-1)?.name ?? 'inconnu'} — les ${archive.tables.length} table(s) de l'archive existent`);

  // ── Is the target empty? ──────────────────────────────────────────────────
  //
  // "Empty" means the shop has not put anything there yet, NOT that the file
  // has no rows: the migrations seed the French legal pages, so a database that
  // was provisioned five minutes ago already has four. Those tables are read out
  // of the migrations rather than listed here (schema.mjs), so the day a
  // migration seeds another one, this keeps working.
  const migrationsDirectory = resolve(root, 'migrations');
  const seeded = existsSync(migrationsDirectory)
    ? seededTables(readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort().map((name) => readFileSync(join(migrationsDirectory, name), 'utf8')))
    : new Set();
  const targetOrder = orderTables(tables).order;
  const counts = countRows(targetOrder, { cwd: root, remote });
  // `provision` writes rows of its own into a production nobody has installed
  // yet — the demo checkout, switched off. Like the migrations' seeds they are
  // the tooling's, not the shop's: a production provisioned five minutes ago
  // is an empty one, which is what the restore drill and the corrupted-base
  // runbook restore into. The restore replaces them with the archive's.
  if (counts.settings > 0) {
    const [[row]] = query(
      [`SELECT COUNT(*) AS n FROM settings WHERE key NOT IN (${PROVISIONED_SETTINGS.map((key) => `'${key}'`).join(', ')})`],
      { cwd: root, remote, what: 'les réglages de la cible' },
    );
    counts.settings = Number(row?.n ?? 0);
  }
  const occupied = Object.entries(counts).filter(([name, count]) => count > 0 && !seeded.has(name));
  if (occupied.length > 0 && args.values['--overwrite'] !== true) {
    throw preconditionError(
      `${names.database} n'est pas vide : ${occupied.map(([name, count]) => `${name} (${count})`).join(', ')}.`,
      `Une restauration remplace ce qui est là. Relancez avec --overwrite si c'est voulu — et prenez \`shopctl backup --env ${env}\` d'abord si ces lignes comptent.`,
    );
  }
  reporter.ok(occupied.length === 0 ? 'cible vierge — aucune ligne que la boutique aurait écrite' : `cible non vierge, ${occupied.length} table(s) seront remplacées (--overwrite)`);

  // ── The statements ────────────────────────────────────────────────────────
  const targetSql = new Map(tables.map((table) => [table.name, table.sql]));
  const order = orderTables(archive.tables.map((table) => ({ name: table.name, sql: targetSql.get(table.name) ?? '' }))).order;
  // Computed by the TARGET's schema, not the archive's: what a restore may not
  // write is what this database refuses to be told, whatever the source said.
  const generated = Object.fromEntries(order.map((name) => [name, [...generatedColumns(targetSql.get(name) ?? '')]]));
  const statements = restoreScript({ order, tables: dump, generated });

  // The archive names the buckets of the environment it was TAKEN in; the
  // bytes go back by binding, into the target's own. Written to the source's
  // names, a staging archive restored into a production lands in staging's
  // bucket on the same account, and fails on another account, where that
  // bucket does not exist — the restore of certification step 8, onto B.
  const targetBuckets = { BUCKET: names.images, FILES: names.files };
  const storedMedia = (archive.r2?.buckets ?? []).flatMap((bucket) =>
    bucket.inventory.filter((object) => object.file).map((object) => ({
      ...object,
      source: bucket.name,
      bucket: targetBuckets[bucket.binding] ?? null,
      binding: bucket.binding,
    })),
  );
  const unbound = [...new Set(storedMedia.filter((object) => !object.bucket).map((object) => object.binding))];
  if (unbound.length > 0) {
    throw preconditionError(
      `l'archive porte des objets d'un binding que cet arbre ne connaît pas : ${unbound.join(', ')}.`,
      'Restaurez depuis un arbre au moins aussi récent que l\'archive. Aucune donnée n\'a été écrite.',
    );
  }
  const uncarried = (archive.r2?.buckets ?? []).flatMap((bucket) => bucket.inventory.filter((object) => !object.file).map((object) => object.key));

  // Every byte this restore will write is on disk before the first row is: an
  // archive taken with --upload leaves in the backups bucket's pool the objects
  // the pool already had, and a restore that found that out after the rows
  // were in would leave a database whose images point at nothing.
  const notOnDisk = storedMedia.filter((object) => !existsSync(join(entry.path, object.file)));
  if (notOnDisk.length > 0) {
    const inPool = notOnDisk.every((object) => object.pool);
    throw (inPool ? preconditionError : verificationError)(
      inPool
        ? `${notOnDisk.length} objet(s) de ${archive.id} sont restés dans le pool du bucket de sauvegarde.`
        : `${notOnDisk.length} objet(s) de ${archive.id} manquent à l'archive : ${notOnDisk.slice(0, 3).map((object) => object.key).join(', ')}${notOnDisk.length > 3 ? '…' : ''}.`,
      inPool
        ? `Rapatriez-les : shopctl backup pull ${archive.id} --env ${archive.env}. Rien n'a été écrit.`
        : 'Cette copie est incomplète ; rapatriez-la de nouveau avec shopctl backup pull. Rien n\'a été écrit.',
    );
  }

  if (dryRun) {
    reporter.section('Simulation');
    reporter.todo(`${statements.length} instruction(s) seraient appliquées à ${names.database}`);
    reporter.todo(`${storedMedia.length} objet(s) seraient reversés dans R2`);
    reporter.result({
      command: 'restore',
      ok: true,
      dryRun: true,
      shop: manifest.client.slug,
      env,
      from: archive.id,
      statements: statements.length,
      objects: storedMedia.length,
      uncarried: uncarried.length,
    });
    return 0;
  }

  if (uncarried.length > 0 && args.values['--allow-missing-media'] !== true) {
    throw preconditionError(
      `l'archive ne porte pas ${uncarried.length} objet(s) que ses lignes référencent.`,
      'Elle a été prise avec --no-media, ou le bucket ne les avait plus. Les lignes se restaurent quand même, mais les images seront cassées : relancez avec --allow-missing-media si c\'est accepté, ou reprenez une sauvegarde complète.',
    );
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  reporter.section('Restauration');
  applyScript(statements, { cwd: root, remote });
  reporter.ok(`${statements.length} instruction(s) appliquées`);

  for (const object of storedMedia) {
    // Sealed under the SOURCE bucket's name: it is what the backup authenticated.
    const bytes = open({ iv: object.cipher.iv, tag: object.cipher.tag, ciphertext: readFileSync(join(entry.path, object.file)) }, key, objectContext(archive, object.source, object.key));
    // A local bucket has no jurisdiction; wrangler would refuse the flag there.
    putObject(object.key, bytes, { cwd: root, bucket: object.bucket, remote, jurisdiction: remote ? jurisdiction : [] });
  }
  if (storedMedia.length > 0) reporter.ok(`${storedMedia.length} objet(s) reversés dans ${[...new Set(storedMedia.map((object) => object.bucket))].join(', ')}`);
  if (uncarried.length > 0) reporter.warn(`${uncarried.length} objet(s) manquent toujours.`, 'Les pages qui les affichent resteront cassées ; l\'inventaire du manifeste les nomme.');

  // ── The comparison, which is the point ────────────────────────────────────
  reporter.section('Comparaison');
  const restored = archive.tables.map((table) => ({
    name: table.name,
    rowid: !/WITHOUT\s+ROWID/i.test(targetSql.get(table.name) ?? ''),
  }));
  const after = readTables(restored, {
    cwd: root,
    remote,
    counts: countRows(restored.map((table) => table.name), { cwd: root, remote }),
  });
  const differences = [];
  for (const table of archive.tables) {
    const held = after[table.name] ?? { columns: [], rows: [] };
    const found = tableDigest({ name: table.name, columns: table.columns, rows: held.rows });
    if (found !== table.digest || held.rows.length !== table.rows) {
      differences.push({ table: table.name, expected: { rows: table.rows, digest: table.digest }, found: { rows: held.rows.length, digest: found } });
    }
  }

  // The vault does not travel. Provider keys are sealed in `settings` under the
  // SECRETS_KEK of the Worker that wrote them, and that secret never leaves
  // its Worker: restored anywhere else, every key is stored and unreadable.
  // Turnstile is the one that locks the door — enabled with a secret the
  // Worker cannot open, the admin login fails closed (the security gate wants
  // exactly that), and the admin is where the keys are re-entered.
  // Back where it was taken, the keys open only if that Worker still holds the
  // KEK — not after a destroy then provision — so that case is reported as
  // unknown rather than readable.
  const vault = vaultState(dump.settings?.rows ?? []);
  const elsewhere = local || account?.id !== archive.account?.id || env !== archive.env;

  reporter.result({
    command: 'restore',
    ok: differences.length === 0,
    dryRun: false,
    shop: manifest.client.slug,
    env,
    from: archive.id,
    local,
    account: account ? { id: account.id, name: account.name } : null,
    statements: statements.length,
    objects: storedMedia.length,
    uncarried,
    tables: archive.tables.map((table) => ({ name: table.name, rows: table.rows })),
    differences,
    vault: { keys: vault.keys, turnstile: vault.turnstile, readable: vault.keys.length > 0 && elsewhere ? false : null },
  });

  if (differences.length > 0) {
    for (const difference of differences) {
      reporter.fail(`${difference.table} — ${difference.found.rows} ligne(s) restaurées pour ${difference.expected.rows} attendues`);
    }
    throw verificationError(
      `${differences.length} table(s) ne correspondent pas à l'archive après restauration.`,
      'La base a été écrite : ne la mettez pas en service. Les tables nommées ci-dessus diffèrent de ce que la sauvegarde portait.',
    );
  }

  reporter.ok(`${archive.tables.length} table(s) identiques à l'archive, empreinte pour empreinte`);

  // Said for an environment someone will serve. A local restore is the
  // nightly's proof on a runner thrown away after it; the report carries the
  // vault there too, without telling a runner to re-enter keys.
  if (vault.keys.length > 0 && elsewhere && remote) {
    reporter.section('Coffre');
    reporter.warn(
      `${vault.keys.length} clé(s) du coffre ne s'ouvrent pas ici : ${vault.keys.join(', ')}.`,
      `Elles sont chiffrées avec la SECRETS_KEK du Worker de ${archive.env}${archive.account?.name ? ` sur ${archive.account.name}` : ''}, qui ne quitte jamais son Worker. Ressaisissez-les dans Admin → Réglages : d'ici là, la boutique les croit posées, et ce qui en dépend (paiement, e-mails, anti-robots) répond en erreur.`,
    );
    if (vault.turnstile) {
      reporter.warn(
        'Turnstile est activé avec une clé secrète illisible : la connexion à l\'administration sera refusée.',
        `Désactivez-le avant de vous connecter : CLOUDFLARE_ACCOUNT_ID=${account.id} npx wrangler d1 execute ${names.database} --remote --command "DELETE FROM settings WHERE key = 'turnstile_enabled'". Ressaisissez ensuite ses clés dans Admin → Réglages → Protection anti-robots, et réactivez-le.`,
      );
    }
  }
  if (!args.values['--json']) {
    if (local) {
      reporter.section(`${manifest.client.slug} restauré en local depuis ${archive.id}.`);
      reporter.step('    La base vit dans .wrangler/state : `npm run preview` la sert.');
    } else {
      reporter.section(`${manifest.client.slug} restauré en ${env} depuis ${archive.id}.`);
      reporter.step(`    Déployez le Worker si l'environnement est neuf : shopctl deploy --env ${env}`);
    }
  }
  return 0;
}

/**
 * The provider keys a restored `settings` table carries, read off its rows
 * without opening them — the same reading as the Worker's `configuredSecrets`:
 * an `enc:<name>` row with a value is a key the shop believes it has.
 */
export function vaultState(rows) {
  const keys = rows
    .filter((row) => typeof row.key === 'string' && row.key.startsWith('enc:') && row.value)
    .map((row) => row.key.slice('enc:'.length))
    .sort();
  const turnstile = rows.some((row) => row.key === 'turnstile_enabled' && row.value === '1') && keys.includes('turnstile_secret_key');
  return { keys, turnstile };
}
