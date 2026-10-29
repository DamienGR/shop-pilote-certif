/**
 * `shopctl backup` — take, list, verify and expire a shop's backups.
 *
 * ADR 0005 rules out the two obvious shortcuts, and everything in this file is
 * downstream of that. D1's Time Travel is a short-term safety net inside one
 * account, with no R2, no long-term retention and no way out to another
 * account. And `wrangler d1 export` cannot run at all on a database that has
 * FTS5 virtual tables, which this one does since migration 0003. So the backup
 * is APPLICATIVE — table by table, read through the same binding the shop uses,
 * written as ordinary files that can be copied anywhere.
 *
 * Four properties, and each is a test:
 *
 *  - **the table list is derived, never written down.** `sqlite_master` says
 *    what the database holds; a list in this file would stop being complete at
 *    the first migration nobody thought to update it for, and the table missing
 *    from the list is the table missing from the archive — silently, until a
 *    restore;
 *  - **an archive is verifiable without being restored.** The manifest carries
 *    the schema version, per-table row counts and checksums, and the R2
 *    inventory, in the clear. `backup verify` answers from them; with the key it
 *    also opens the body and re-derives every digest from the rows themselves;
 *  - **it is encrypted, and the manifest is authenticated with it.** A backup is
 *    every order and every address the shop has taken. The cleartext header is
 *    passed to AES-GCM as additional data, so an archive cannot be edited to
 *    claim another shop, another environment or another schema;
 *  - **retention is bounded and enforced.** `backup prune` applies BOTH bounds
 *    before it drops anything: a shop that stopped being backed up must not
 *    have its last archive expired by an age rule.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ShopctlError, inputError, preconditionError, usageError, verificationError } from '../errors.mjs';
import { requireEnvironment, resolveShop } from '../shop.mjs';
import { openEnvironment } from '../environment.mjs';
import { ENVIRONMENTS } from '../../../scripts/manifest.mjs';
import { corePackage } from '../paths.mjs';
import { resourceNames } from '../../../scripts/manifest.mjs';
import { canonical, digest, tableDigest } from '../backup/dump.mjs';
import { classifyTables, objectInventory, orderTables } from '../backup/schema.mjs';
import { countRows, getObject, putObject, readSchema, readTables } from '../backup/store.mjs';
import { lifecycleRules, listBuckets, expectedAccount, resolveAccount, whoami } from '../cloudflare.mjs';
import {
  ARCHIVE_FORMAT,
  DATA_FILE,
  MANIFEST_FILE,
  archivePrefix,
  assertBackupId,
  DEFAULT_KEEP,
  DEFAULT_KEEP_DAYS,
  DEFAULT_REPOSITORY,
  authenticatedHeader,
  backupId,
  listArchives,
  objectContext,
  objectFile,
  pooledElsewhere,
  readArchive,
  remoteObjectPath,
  removeArchive,
  planPrune,
  repositoryPath,
  storedObjects,
  verifyStructure,
  writeArchive,
} from '../backup/archive.mjs';
import { DEFAULT_KEY_FILE, keyId, keyMatches, loadKey, open, seal, writeKeyFile } from '../backup/crypto.mjs';
import { POOL_INDEX, nextIndex, openIndex, poolFile, poolKey, reusable, reuseWindow, sealIndex } from '../backup/pool.mjs';

export const BACKUP_OPTIONS = {
  '--env': 'environnement',
  '--shop': 'slug',
  '--account': 'id',
  '--out': 'répertoire',
  '--key-file': 'chemin',
  '--keep': 'nombre',
  '--keep-days': 'jours',
};

export const BACKUP_FLAGS = ['--dry-run', '--no-media', '--upload'];

export { DEFAULT_KEEP, DEFAULT_KEEP_DAYS };

export const backupUsage = `Usage: shopctl backup [sous-commande] [options]

  shopctl backup --env <staging|production>   Prendre une sauvegarde
  shopctl backup list                         Lister les sauvegardes du dépôt
  shopctl backup verify <id>                  Contrôler une sauvegarde
  shopctl backup pull <id> --env <env>        Rapatrier une sauvegarde du bucket -backups,
                                              ou compléter une copie locale de ses médias
  shopctl backup prune                        Appliquer la politique de conservation
  shopctl backup keygen                       Écrire une clé de chiffrement

  --env <staging|production>  Environnement à sauvegarder. Obligatoire pour une prise.
  --out <répertoire>          Dépôt des sauvegardes. Défaut : ${DEFAULT_REPOSITORY}/.
  --key-file <chemin>         Clé de chiffrement. Défaut : ${DEFAULT_KEY_FILE}, sinon SHOPCTL_BACKUP_KEY.
  --no-media                  Ne pas emporter les octets R2 ; l'inventaire seul.
  --upload                    Copier aussi la sauvegarde dans le bucket -backups
                              de l'environnement (privé, même juridiction). Un
                              média que le bucket a déjà n'est ni relu ni recopié.
  --keep <nombre>             Sauvegardes conservées par prune. Défaut : ${DEFAULT_KEEP}.
  --keep-days <jours>         Âge maximal conservé par prune. Défaut : ${DEFAULT_KEEP_DAYS}.
  --dry-run                   Tout préparer, ne rien écrire ni supprimer.
  --account <id>              Compte Cloudflare attendu, si le manifeste ne le déclare pas.
  --shop <slug>               Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                      Rapport lisible par une machine.

Une sauvegarde est chiffrée : elle porte les commandes, les adresses et les
e-mails des clients. La clé n'est jamais passée en argument — elle vient d'un
fichier ou de SHOPCTL_BACKUP_KEY — et \`backup keygen\` ne l'affiche pas.
`;

const SUBCOMMANDS = new Set(['create', 'list', 'verify', 'pull', 'prune', 'keygen']);

export function runBackup(args, reporter) {
  const [first, ...rest] = args.positionals;
  const sub = first === undefined ? 'create' : first;
  if (sub !== 'verify' && sub !== 'pull' && rest.length > 0) {
    throw usageError(`backup ${sub} ne prend pas d'argument positionnel ; reçu « ${rest.join('", "')} ».`, backupUsage.trim());
  }
  if (!SUBCOMMANDS.has(sub)) {
    throw usageError(`sous-commande de backup inconnue : « ${sub} ».`, backupUsage.trim());
  }
  if (sub === 'create') return createBackup(args, reporter);
  if (sub === 'list') return listBackups(args, reporter);
  if (sub === 'verify') return verifyBackup(args, reporter, rest[0]);
  if (sub === 'pull') return pullBackup(args, reporter, rest[0]);
  if (sub === 'prune') return pruneBackups(args, reporter);
  return keygen(args, reporter);
}

/**
 * The tree, the repository directory and the environment, resolved once.
 *
 * `--env` is mandatory for the commands that touch an account and optional for
 * the ones that only read the repository — but never unchecked: a listing
 * filtered by `--env stagng` would answer "no backups" and be believed.
 */
function context(args, { needsEnv = true } = {}) {
  const shop = resolveShop(process.cwd(), args.values['--shop']);
  const env = needsEnv ? requireEnvironment(args.values['--env']) : (args.values['--env'] ?? null);
  if (env !== null && !ENVIRONMENTS.includes(env)) {
    throw usageError(`--env « ${env} » est inconnu.`, `Environnements : ${ENVIRONMENTS.join(', ')}.`);
  }
  return { ...shop, env, repository: repositoryPath(shop.root, args.values['--out']) };
}

// ── Taking one ──────────────────────────────────────────────────────────────

function createBackup(args, reporter) {
  const { manifest, root, env, repository } = context(args);
  const dryRun = args.values['--dry-run'] === true;
  const withMedia = args.values['--no-media'] !== true;

  // The key FIRST, before a single row is read. A run that reads the whole
  // database and then discovers it has nowhere safe to put it has already put
  // it somewhere: in this process's memory, and in whatever the operator does
  // next with a half-finished command.
  const { key, source } = loadKey({ root, file: args.values['--key-file'] });
  reporter.section('Clé');
  reporter.ok(`${source} — clé ${keyId(key)}`);

  const { account } = openEnvironment({
    values: args.values,
    manifest,
    root,
    env,
    reporter,
    missing: `Il n'y a rien à sauvegarder en ${env}.`,
  });

  // Asked before a row is read, for the same reason as the key: a nightly run
  // that reads the whole database and then has nowhere durable to put it has
  // only produced a file on a runner that is about to be thrown away.
  const upload = args.values['--upload'] === true;
  if (upload && !dryRun) requireBackupsBucket({ manifest, root, env });
  const pool = upload && !dryRun && withMedia ? openPool({ manifest, root, env, key, reporter }) : null;

  const taken = captureBackup({ manifest, root, env, account, key, repository, withMedia, dryRun, pool, reporter });

  if (dryRun) {
    if (upload) reporter.todo(`la sauvegarde serait copiée dans ${resourceNames(manifest, { env }).backups}`);
    reporter.result({
      command: 'backup',
      ok: true,
      dryRun: true,
      shop: manifest.client.slug,
      env,
      wouldWrite: taken.path,
      schema: taken.schema,
      tables: taken.tables.map(({ name, rows }) => ({ name, rows })),
      r2: taken.r2,
      skipped: taken.skipped,
    });
    if (!args.values['--json']) reporter.section(`Simulation. Relancez sans --dry-run pour écrire ${taken.path}.`);
    return 0;
  }

  const uploaded = upload ? uploadArchive({ manifest, root, env, path: taken.path, id: taken.id, key, pool, reporter }) : null;

  reporter.result({
    command: 'backup',
    ok: true,
    dryRun: false,
    shop: manifest.client.slug,
    env,
    id: taken.id,
    path: taken.path,
    schema: taken.schema.version,
    tables: taken.tables,
    r2: taken.r2,
    media: taken.media,
    bytes: taken.bytes,
    uploaded,
  });
  if (!args.values['--json']) {
    reporter.section(`Contrôlez-la : shopctl backup verify ${taken.id}`);
    reporter.step(`    Restaurez-la : shopctl restore --env staging --from ${taken.id}`);
  }
  return 0;
}

/**
 * Read one environment and seal it into an archive — the part of a backup that
 * does not depend on who asked for it.
 *
 * `shopctl backup` calls it, and so does `shopctl deploy --env production`,
 * which takes one before its migrations (plan §9: a deployment is blocked when
 * the preceding backup fails). One implementation, so that the archive a deploy
 * leaves behind is exactly the archive `backup verify` and `restore` already
 * know how to read. Any failure throws, and the caller decides what that stops.
 *
 * The caller has already resolved the account and rendered the environment's
 * configuration (`openEnvironment`, or the deploy's own resource check): the
 * reads below go through the `DB` binding of the `wrangler.jsonc` in the tree.
 */
export function captureBackup({ manifest, root, env, account, key, repository, withMedia = true, dryRun = false, pool = null, reporter }) {
  const names = resourceNames(manifest, { env });
  const jurisdiction = ['-J', manifest.cloudflare.jurisdiction];

  // ── The schema, as the database describes it ──────────────────────────────
  reporter.section('Schéma');
  const { master, migrations } = readSchema({ cwd: root, remote: true });
  const { tables, virtual, skipped } = classifyTables(master);
  const { order, cycle } = orderTables(tables);
  if (cycle.length > 0) {
    throw verificationError(
      `le schéma contient un cycle de clés étrangères : ${cycle.join(', ')}.`,
      'Une restauration ne saurait pas dans quel ordre réinsérer ces tables. Cassez le cycle dans une migration avant de sauvegarder.',
    );
  }
  const applied = migrations.at(-1)?.name ?? null;
  reporter.ok(`${tables.length} table(s), schéma ${applied ?? 'inconnu'} (${migrations.length} migration(s) appliquée(s))`);
  if (virtual.length > 0) reporter.ok(`index non sauvegardés, reconstruits à la restauration : ${virtual.join(', ')}`);

  // ── The rows ──────────────────────────────────────────────────────────────
  reporter.section('Données');
  const rowidTables = tables.map((table) => ({ name: table.name, rowid: !/WITHOUT\s+ROWID/i.test(table.sql) }));
  const counts = countRows(order, { cwd: root, remote: true });
  const dump = readTables(rowidTables, { cwd: root, remote: true, counts });
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  reporter.ok(`${total} ligne(s) lues`);

  const tableEntries = order.map((name) => ({
    name,
    rows: dump[name].rows.length,
    columns: dump[name].columns,
    digest: tableDigest({ name, columns: dump[name].columns, rows: dump[name].rows }),
  }));

  // ── What the rows say lives in R2 ─────────────────────────────────────────
  reporter.section('Objets R2');
  const inventory = objectInventory(dump);
  reporter.ok(`${inventory.images.length} image(s), ${inventory.files.length} fichier(s) privé(s)`);
  if (inventory.orphans.length > 0) {
    reporter.warn(
      `${inventory.orphans.length} clé(s) référencées sans ligne media.`,
      'Ces images sont déjà cassées dans la boutique ; la sauvegarde les signale plutôt que de les inventer.',
    );
  }

  const id = backupId(manifest.client.slug, env, new Date());
  const directory = join(repository, id);

  if (dryRun) {
    return {
      dryRun: true,
      path: directory,
      schema: { version: applied, migrations: migrations.length },
      tables: tableEntries,
      r2: { images: inventory.images.length, files: inventory.files.length, media: withMedia },
      skipped,
    };
  }

  const buckets = [
    { binding: 'BUCKET', name: names.images, keys: inventory.images },
    { binding: 'FILES', name: names.files, keys: inventory.files },
  ];
  // What the backups bucket already holds, sealed under this key and young
  // enough to outlive this archive (backup/pool.mjs). Empty without --upload:
  // a local archive carries every object it names.
  const pooled = pool?.reuse ?? new Map();
  const pooling = Boolean(pool && pool.window > 0);
  let reused = 0;
  const objects = [];
  const bucketEntries = [];
  for (const bucket of buckets) {
    const entries = [];
    let missing = 0;
    for (const objectKey of bucket.keys) {
      if (!withMedia) {
        entries.push({ key: objectKey, file: null, bytes: null, digest: null, cipher: null });
        continue;
      }
      const file = objectFile(objectKey);
      const copy = pooled.get(poolKey(bucket.name, objectKey));
      if (copy) {
        reused += 1;
        entries.push({ key: objectKey, file, pool: copy.file, bytes: copy.bytes, digest: copy.digest, cipher: copy.cipher });
        continue;
      }
      const bytes = getObject(objectKey, { cwd: root, bucket: bucket.name, remote: true, jurisdiction });
      if (!bytes) {
        missing += 1;
        entries.push({ key: objectKey, file: null, bytes: null, digest: null, cipher: null, missing: true });
        continue;
      }
      const sealed = seal(bytes, key, objectContext({ format: ARCHIVE_FORMAT }, bucket.name, objectKey));
      const fingerprint = digest(sealed.ciphertext);
      entries.push({
        key: objectKey,
        file,
        pool: pooling ? poolFile(fingerprint) : null,
        bytes: bytes.length,
        digest: fingerprint,
        cipher: { iv: sealed.iv, tag: sealed.tag },
      });
      objects.push({ file, bytes: sealed.ciphertext });
    }
    if (missing > 0) {
      reporter.warn(
        `${missing} objet(s) de ${bucket.name} sont introuvables.`,
        'La base les référence, le bucket ne les a pas. La sauvegarde les nomme dans son manifeste ; une restauration les redemandera.',
      );
    }
    bucketEntries.push({ binding: bucket.binding, name: bucket.name, objects: entries.length, stored: withMedia, inventory: entries });
  }
  if (withMedia) reporter.ok(`${objects.length} objet(s) emportés${reused > 0 ? `, ${reused} déjà dans ${names.backups} (ni relus ni recopiés)` : ''}`);
  else reporter.warn('inventaire seul (--no-media).', 'Une restauration dans un compte vide n\'aura pas les images.');

  // ── Seal ──────────────────────────────────────────────────────────────────
  const plaintext = Buffer.from(canonical({ tables: dump }), 'utf8');
  const header = {
    format: ARCHIVE_FORMAT,
    id,
    shop: manifest.client.slug,
    env,
    createdAt: new Date().toISOString(),
    coreVersion: corePackage().version,
    account: { id: account.id, name: account.name },
    schema: { version: applied, migrations: migrations.map((entry) => entry.name), skipped },
    tables: tableEntries,
    r2: { buckets: bucketEntries },
  };
  const sealed = seal(plaintext, key, authenticatedHeader(header));
  const manifestDocument = {
    ...header,
    cipher: { algorithm: 'aes-256-gcm', iv: sealed.iv, tag: sealed.tag, keyId: keyId(key) },
    data: { file: DATA_FILE, bytes: sealed.ciphertext.length, digest: digest(sealed.ciphertext), plainBytes: plaintext.length },
    restore: {
      command: `shopctl restore --env staging --from ${id}`,
      requires: [
        `une clé de sauvegarde ${keyId(key)}`,
        `un arbre au socle ${corePackage().version} ou compatible`,
        `les ressources de l'environnement visé (shopctl provision --env <env>)`,
      ],
    },
  };

  mkdirSync(repository, { recursive: true });
  writeArchive(directory, { manifest: manifestDocument, ciphertext: sealed.ciphertext, objects });

  reporter.section('Sauvegarde');
  reporter.ok(`${id} — ${sealed.ciphertext.length} octet(s) chiffrés dans ${directory}`);
  return {
    dryRun: false,
    id,
    path: directory,
    schema: manifestDocument.schema,
    tables: tableEntries.map(({ name, rows, digest: fingerprint }) => ({ name, rows, digest: fingerprint })),
    r2: bucketEntries.map(({ name, objects: count, stored }) => ({ name, objects: count, stored })),
    media: { read: objects.length, reused },
    bytes: sealed.ciphertext.length,
  };
}

// ── The remote copy ─────────────────────────────────────────────────────────

/**
 * What the backups bucket's media pool can lend the backup about to be taken
 * (backup/pool.mjs): two reads, the bucket's lifecycle rules and the index,
 * before a single object is.
 *
 * The rules decide for how long a pooled copy may be reused, so that it always
 * outlives the archive about to name it. A bucket still on the bucket-wide rule
 * of v0.3.31 and earlier, or one whose rules cannot be read, gets a window of
 * zero: every object is read and carried under the archive's own prefix, as it
 * always was — and the run says how to change that.
 */
export function openPool({ manifest, root, env, key, reporter }) {
  const names = resourceNames(manifest, { env });
  const jurisdiction = manifest.cloudflare.jurisdiction;
  reporter.section(`Médias déjà sauvegardés — ${names.backups}`);
  const rules = lifecycleRules(names.backups, { cwd: root, jurisdiction });
  const window = reuseWindow(rules, archivePrefix(manifest.client.slug, env));
  if (!(window > 0)) {
    reporter.warn(
      rules === null
        ? `les règles de conservation de ${names.backups} n'ont pas pu être lues : chaque objet est relu et recopié.`
        : `les règles de conservation de ${names.backups} ne laissent pas le pool survivre aux archives : chaque objet est relu et recopié.`,
      `\`shopctl provision --env ${env}\` pose les deux règles (archives à 90 jours par leur préfixe, pool à 180).`,
    );
    return { window: 0, reuse: new Map(), previous: [], state: 'absent' };
  }
  const index = openIndex(getObject(POOL_INDEX, { cwd: root, bucket: names.backups, remote: true, jurisdiction: ['-J', jurisdiction] }), key, names.backups);
  const reuse = reusable(index.entries, window);
  if (index.state === 'ok') reporter.ok(`${reuse.size} objet(s) réutilisables (copies de moins de ${window} jours)`);
  else if (index.state === 'absent') reporter.ok('pool vide : les objets sont lus et copiés une fois');
  else if (index.state === 'other-key') reporter.warn('l\'index du pool est scellé par une autre clé : un nouveau pool commence.', 'Les archives prises avec l\'ancienne clé gardent leurs copies jusqu\'à leur expiration.');
  else reporter.warn('l\'index du pool ne s\'ouvre pas : un nouveau pool commence.', 'Une édition ou une corruption de pool/index.json ; les archives existantes nomment leurs copies elles-mêmes.');
  return { window, reuse, previous: index.entries, state: index.state };
}

/**
 * Copy an archive, as written, into the environment's backups bucket.
 *
 * Where a backup taken by CI survives the runner that took it (decided
 * 2026-10-06: a private bucket per shop and environment, in the shop's
 * jurisdiction — ADR 0004, ADR 0019). The files are the archive's own bytes,
 * already encrypted: nothing is re-sealed on the way, so what `pull` brings
 * back is byte for byte what `verify` checked here.
 *
 * The order is the crash story. The objects the pool did not have go first,
 * each under a name nothing else will ever use; then the body; then the index,
 * which only names copies that are already there; the manifest LAST, so that a
 * copy interrupted half-way has no manifest, which every reader already treats
 * as an incomplete archive. An interruption costs, at worst, pool copies no
 * index names — they expire with the pool.
 *
 * Refused when the bucket does not exist rather than created: creating a bucket
 * fixes its jurisdiction for good, which is provisioning's decision and nobody
 * else's.
 */
export function uploadArchive({ manifest, root, env, path, id, key = null, pool = null, reporter }) {
  const names = resourceNames(manifest, { env });
  const jurisdiction = ['-J', manifest.cloudflare.jurisdiction];
  requireBackupsBucket({ manifest, root, env, id });
  const archive = JSON.parse(readFileSync(join(path, MANIFEST_FILE), 'utf8'));
  const put = (remotePath, bytes) => putObject(remotePath, bytes, { cwd: root, bucket: names.backups, remote: true, jurisdiction });

  // Only what this run read: a reused copy is not in the directory, and is
  // already in the bucket.
  const carried = storedObjects(archive).filter((object) => existsSync(join(path, object.file)));
  for (const object of carried) put(remoteObjectPath(id, object), readFileSync(join(path, object.file)));
  put(`${id}/${DATA_FILE}`, readFileSync(join(path, DATA_FILE)));

  const pooledHere = carried.filter((object) => object.pool);
  let index = false;
  if (pool && key && pool.window > 0) {
    const fresh = pooledHere.map(({ source, key: objectKey, pool: file, bytes, digest: fingerprint, cipher }) => ({
      source,
      key: objectKey,
      file,
      bytes,
      digest: fingerprint,
      cipher,
      storedAt: archive.createdAt,
    }));
    const next = nextIndex({ previous: pool.previous, state: pool.state, fresh, windowDays: pool.window });
    if (next.changed) {
      put(POOL_INDEX, sealIndex(next.entries, key, names.backups));
      index = true;
    }
  }
  put(`${id}/${MANIFEST_FILE}`, readFileSync(join(path, MANIFEST_FILE)));

  const reused = storedObjects(archive).filter((object) => object.pool).length - pooledHere.length;
  reporter.ok(
    `${id} copiée dans ${names.backups} : ${carried.length} objet(s) écrit(s)${reused > 0 ? `, ${reused} déjà dans le pool` : ''}`,
  );
  return {
    bucket: names.backups,
    prefix: `${id}/`,
    files: 2,
    objects: { written: carried.length, pooled: pooledHere.length, reused },
    index,
  };
}

function requireBackupsBucket({ manifest, root, env, id = null }) {
  const names = resourceNames(manifest, { env });
  const jurisdiction = manifest.cloudflare.jurisdiction;
  if (listBuckets({ cwd: root, jurisdiction }).includes(names.backups)) return;
  throw preconditionError(
    id ? `${names.backups} n'existe pas : la sauvegarde ${id} reste locale.` : `${names.backups} n'existe pas.`,
    `\`shopctl provision --env ${env}\` crée ce bucket, privé et en juridiction ${jurisdiction}. Relancez ensuite la commande.`,
  );
}

/**
 * Bring an archive back from the backups bucket into the local repository, or
 * complete a local copy with the objects it left in the pool.
 *
 * By identifier, because wrangler cannot list a bucket's objects: the id is in
 * the deploy report, the nightly run's log, and the name of every file the
 * bucket holds. The manifest comes first and names the rest — the body under
 * the archive's prefix, each object where the manifest says it is, the pool
 * included. The copy is then checked exactly as `backup verify` checks a local
 * one, before anything says it arrived.
 *
 * A local copy is never overwritten: an archive taken here with `--upload`
 * lacks only the objects the pool already had, and those are all a pull
 * fetches. That is what the nightly run does before its restore drill.
 */
function pullBackup(args, reporter, id) {
  if (!id) throw usageError('backup pull demande un identifiant.', 'Il figure dans le rapport du déploiement ou du run nocturne qui l\'a prise.');
  assertBackupId(id);
  const { manifest, root, env, repository } = context(args);
  const names = resourceNames(manifest, { env });
  const jurisdiction = ['-J', manifest.cloudflare.jurisdiction];
  const directory = join(repository, id);
  const local = existsSync(join(directory, MANIFEST_FILE)) ? readArchive(repository, id) : null;
  if (local && (local.manifest.shop !== manifest.client.slug || local.manifest.env !== env)) {
    throw verificationError(
      `la copie locale de ${id} décrit ${local.manifest.shop}/${local.manifest.env}, pas ${manifest.client.slug}/${env}.`,
      'Rien n\'a été écrit. Une archive se complète depuis le bucket de l\'environnement qui l\'a prise.',
    );
  }
  const missing = local ? pooledElsewhere(local) : null;

  if (local && missing.length === 0) {
    reporter.section(`Sauvegarde ${id}`);
    reporter.ok(`déjà complète dans ${repository} : rien à rapatrier`);
  } else {
    // The account, but not the database: a pull is what an operator runs when
    // the database is the thing that went wrong. The bucket's name alone does
    // not say whose it is — a shop's staging can exist on two accounts under
    // the same name (ADR 0015).
    reporter.section('Compte Cloudflare');
    const account = resolveAccount(
      expectedAccount(manifest, env, args.values),
      whoami({ cwd: root }),
    );
    reporter.ok(`${account.name} (${account.id})`);

    reporter.section(`Rapatriement de ${id} depuis ${names.backups}`);
    const fetch = (remotePath, isManifest = false) => {
      const bytes = getObject(remotePath, { cwd: root, bucket: names.backups, remote: true, jurisdiction });
      if (!bytes) {
        throw inputError(
          `${remotePath} est introuvable dans ${names.backups}.`,
          isManifest
            ? 'Vérifiez l\'identifiant et l\'environnement : une archive sans manifeste n\'a jamais fini d\'être copiée, ou a expiré.'
            : 'L\'archive distante est incomplète ; elle ne peut pas servir.',
        );
      }
      return bytes;
    };
    const write = (file, bytes) => {
      const target = join(directory, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    };

    if (local) {
      for (const object of missing) write(object.file, fetch(object.pool));
      reporter.ok(`${missing.length} objet(s) rapatrié(s) du pool`);
    } else {
      const manifestBytes = fetch(`${id}/${MANIFEST_FILE}`, true);
      const archive = JSON.parse(manifestBytes.toString('utf8'));
      if (archive.id !== id || archive.shop !== manifest.client.slug || archive.env !== env) {
        throw verificationError(
          `le manifeste distant décrit ${archive.shop}/${archive.env}/${archive.id}, pas ${manifest.client.slug}/${env}/${id}.`,
          'Rien n\'a été écrit. Une archive se relit dans l\'arbre de la boutique qui l\'a prise.',
        );
      }
      write(DATA_FILE, fetch(`${id}/${DATA_FILE}`));
      const objects = storedObjects(archive);
      for (const object of objects) write(object.file, fetch(remoteObjectPath(id, object)));
      // Written last, as `writeArchive` does: until it is there, the directory
      // is an incomplete archive to every reader.
      writeFileSync(join(directory, MANIFEST_FILE), manifestBytes);
      reporter.ok(`${id} et ${objects.length} objet(s) rapatriés`);
    }
  }

  const checks = verifyStructure(readArchive(repository, id));
  for (const check of checks) (check.ok ? reporter.ok : reporter.fail).call(reporter, `${check.name} — ${check.detail}`);
  const failures = checks.filter((check) => !check.ok);
  reporter.result({
    command: 'backup pull',
    ok: failures.length === 0,
    id,
    path: directory,
    bucket: names.backups,
    fetched: local ? missing.length : null,
    checks,
  });
  if (failures.length > 0) {
    throw verificationError(`${failures.length} contrôle(s) ont échoué sur la copie de ${id}.`, 'La copie locale est gardée pour examen ; ne la restaurez pas.');
  }
  if (!args.values['--json']) reporter.section(`Restaurez-la : shopctl restore --env ${env} --from ${id}`);
  return 0;
}

// ── Listing ─────────────────────────────────────────────────────────────────

function listBackups(args, reporter) {
  const { repository, env } = context(args, { needsEnv: false });
  const entries = listArchives(repository).filter((entry) => !env || entry.manifest?.env === env);

  reporter.section(`Sauvegardes — ${repository}`);
  if (entries.length === 0) reporter.todo('aucune.');
  for (const entry of entries) {
    if (entry.broken) reporter.fail(`${entry.id} — ${entry.broken}`);
    else {
      const { manifest } = entry;
      const rows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
      const stored = manifest.r2.buckets.filter((bucket) => bucket.stored).length;
      const elsewhere = pooledElsewhere(entry).length;
      reporter.ok(
        `${entry.id} — ${manifest.env}, ${rows} ligne(s), schéma ${manifest.schema.version ?? 'inconnu'}, clé ${manifest.cipher.keyId}${stored === 0 ? ', sans objets R2' : ''}${elsewhere > 0 ? `, ${elsewhere} objet(s) laissés dans le pool (backup pull)` : ''}`,
      );
    }
  }
  reporter.result({
    command: 'backup list',
    ok: true,
    repository,
    backups: entries.map((entry) => ({
      id: entry.id,
      broken: entry.broken,
      env: entry.manifest?.env ?? null,
      createdAt: entry.manifest?.createdAt ?? null,
      schema: entry.manifest?.schema?.version ?? null,
      keyId: entry.manifest?.cipher?.keyId ?? null,
      rows: entry.manifest ? entry.manifest.tables.reduce((sum, table) => sum + table.rows, 0) : null,
      media: entry.manifest ? entry.manifest.r2.buckets.some((bucket) => bucket.stored) : null,
      pooled: entry.broken ? null : pooledElsewhere(entry).length,
    })),
  });
  return 0;
}

// ── Verifying ───────────────────────────────────────────────────────────────

/**
 * Two levels, and the report never lets one pass for the other.
 *
 * WITHOUT the key: the body is present, the right length, and hashes to what
 * the manifest recorded. That is corruption — a truncated copy, a bad transfer
 * — and it is what actually happens to archives on a shelf.
 *
 * WITH the key: the body opens, which proves the cleartext header was not
 * edited (it is the GCM additional data), and every per-table digest is
 * re-derived FROM THE ROWS rather than re-read from the manifest. A manifest
 * checking itself would pass on an archive whose body is another shop's.
 */
export function verifyBackup(args, reporter, id) {
  if (!id) throw usageError('backup verify demande un identifiant.', 'shopctl backup list donne ceux qui existent.');
  const { root, repository } = context(args, { needsEnv: false });
  const entry = readArchive(repository, id);
  const { manifest } = entry;

  reporter.section(`Sauvegarde ${id}`);
  reporter.ok(`${manifest.shop} — ${manifest.env}, ${manifest.createdAt}, socle ${manifest.coreVersion}`);

  const checks = verifyStructure(entry).map((check) => ({ ...check, level: 'structure' }));
  for (const check of checks) (check.ok ? reporter.ok : reporter.fail).call(reporter, `${check.name} — ${check.detail}`);

  // An explicit --key-file is an assertion: a path that is not there is the
  // operator's mistake, not a reason to quietly fall back to half a check.
  // Without one, "no key here" is an ordinary situation — an archive is often
  // verified on a machine that is not the one holding the vault.
  let key = null;
  if (args.values['--key-file']) {
    key = loadKey({ root, file: args.values['--key-file'] }).key;
  } else {
    try {
      key = loadKey({ root }).key;
    } catch {
      key = null;
    }
  }

  // A key that is absent and a key that belongs to another archive are the same
  // situation — the body stays closed — and neither is evidence that the archive
  // is bad. They are said loudly and they leave the exit code at ok: what
  // `verify` reports is WHICH level it reached, and an operator holding the
  // wrong key learns which one they need. Corruption is the failure.
  let opened = false;
  if (!key) {
    reporter.warn(
      'aucune clé disponible : le contenu n\'a pas été ouvert.',
      `Seule l'intégrité des octets est prouvée ici. Posez SHOPCTL_BACKUP_KEY ou --key-file pour contrôler les lignes elles-mêmes (clé attendue : ${manifest.cipher.keyId}).`,
    );
  } else if (!keyMatches(key, manifest.cipher.keyId)) {
    reporter.warn(
      `la clé disponible (${keyId(key)}) n'est pas celle de cette archive (${manifest.cipher.keyId}) : le contenu n'a pas été ouvert.`,
      'Une archive ne se relit qu\'avec la clé qui l\'a fermée. Les octets, eux, sont intacts.',
    );
  } else if (checks.every((check) => check.ok)) {
    opened = true;
    checks.push(...openAndCheck(entry, key).map((check) => ({ ...check, level: 'contenu' })));
    for (const check of checks.filter((candidate) => candidate.level === 'contenu')) {
      (check.ok ? reporter.ok : reporter.fail).call(reporter, `${check.name} — ${check.detail}`);
    }
  } else {
    reporter.warn('le corps n\'a pas été ouvert : son empreinte ne correspond pas.', 'Corrigez la copie avant d\'aller plus loin.');
  }

  const failures = checks.filter((check) => !check.ok);
  reporter.result({ command: 'backup verify', ok: failures.length === 0, id, path: entry.path, opened, checks, failures: failures.length });
  if (failures.length > 0) {
    throw verificationError(
      `${failures.length} contrôle(s) ont échoué sur ${id}.`,
      'Cette archive ne peut pas servir de sauvegarde de référence. Reprenez-en une, et gardez celle-ci le temps de comprendre.',
    );
  }
  reporter.section(opened ? 'Archive complète et cohérente.' : 'Octets intacts ; contenu non contrôlé.');
  return 0;
}

/** Open the body and re-derive everything the manifest claims about it. */
export function openAndCheck(entry, key) {
  const { manifest, path } = entry;
  const ciphertext = readFileSync(join(path, manifest.data.file ?? DATA_FILE));
  let payload;
  try {
    payload = JSON.parse(open({ iv: manifest.cipher.iv, tag: manifest.cipher.tag, ciphertext }, key, authenticatedHeader(manifest)).toString('utf8'));
  } catch {
    return [{ name: 'ouverture', ok: false, detail: 'le corps ne s\'ouvre pas avec cette clé et ce manifeste' }];
  }

  const checks = [{ name: 'ouverture', ok: true, detail: 'authentifiée par le manifeste en clair' }];
  const dump = payload.tables ?? {};
  for (const table of manifest.tables) {
    const held = dump[table.name];
    if (!held) {
      checks.push({ name: `table ${table.name}`, ok: false, detail: 'absente du corps' });
      continue;
    }
    const found = tableDigest({ name: table.name, columns: held.columns, rows: held.rows });
    checks.push({
      name: `table ${table.name}`,
      ok: found === table.digest && held.rows.length === table.rows,
      detail: found === table.digest && held.rows.length === table.rows ? `${held.rows.length} ligne(s)` : `${held.rows.length} ligne(s), empreinte ${found === table.digest ? 'identique' : 'différente'}`,
    });
  }
  const extra = Object.keys(dump).filter((name) => !manifest.tables.some((table) => table.name === name));
  if (extra.length > 0) checks.push({ name: 'tables', ok: false, detail: `le corps porte ${extra.join(', ')} que le manifeste ne déclare pas` });
  return checks;
}

// ── Retention ───────────────────────────────────────────────────────────────

function positiveInteger(value, name) {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ShopctlError(`${name} attend un entier positif ; reçu « ${value} ».`, { kind: 'input' });
  }
  return parsed;
}

function pruneBackups(args, reporter) {
  const { repository, env } = context(args, { needsEnv: false });
  const dryRun = args.values['--dry-run'] === true;
  const keep = positiveInteger(args.values['--keep'], '--keep') ?? DEFAULT_KEEP;
  const keepDays = positiveInteger(args.values['--keep-days'], '--keep-days') ?? DEFAULT_KEEP_DAYS;

  const entries = listArchives(repository).filter((entry) => !env || entry.broken || entry.manifest?.env === env);
  const plan = planPrune(entries, { keep, keepDays });

  reporter.section(`Conservation — ${keep} sauvegarde(s), ${keepDays} jour(s)`);
  if (plan.remove.length === 0) reporter.ok(`${entries.length} sauvegarde(s), rien à supprimer.`);
  for (const dropped of plan.remove) {
    reporter[dryRun ? 'todo' : 'warn'](`${dropped.id} — ${dropped.reason}`);
    if (!dryRun) removeArchive(dropped.path);
  }

  reporter.result({
    command: 'backup prune',
    ok: true,
    dryRun,
    repository,
    policy: { keep, keepDays },
    removed: dryRun ? [] : plan.remove.map((dropped) => dropped.id),
    wouldRemove: dryRun ? plan.remove.map((dropped) => dropped.id) : [],
    kept: plan.keepIds,
  });
  return 0;
}

// ── The key ─────────────────────────────────────────────────────────────────

function keygen(args, reporter) {
  const { root } = context(args, { needsEnv: false });
  const file = args.values['--key-file'] ?? DEFAULT_KEY_FILE;
  const written = writeKeyFile(root, file);

  reporter.section('Clé de sauvegarde');
  reporter.ok(`${written.file} — clé ${written.keyId}, lisible par vous seul (0600)`);
  reporter.step('    Elle n\'est pas affichée, et elle n\'est pas dans le dépôt Git.');
  reporter.step('    Sans elle, aucune archive prise avec elle ne se relit. Copiez-la dans votre coffre AVANT la première sauvegarde.');
  reporter.result({ command: 'backup keygen', ok: true, file: written.file, keyId: written.keyId });
  return 0;
}

/** The restore command resolves the same tree, environment and repository. */
export { context as backupContext };
