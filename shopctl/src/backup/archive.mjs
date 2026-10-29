/**
 * A backup on disk: what it looks like, and what can be said about it without
 * opening it.
 *
 * One backup is a DIRECTORY, not a single container file, and that shape is the
 * decision this module is built around:
 *
 *   <dépôt>/<id>/manifest.json          en clair, lisible sans la clé
 *   <dépôt>/<id>/data.bin               le dump D1, compressé puis chiffré
 *   <dépôt>/<id>/objects/<empreinte>.bin  un objet R2, chiffré (sauf --no-media)
 *
 * ADR 0005 asks for a backup that is verifiable WITHOUT being restored, and one
 * that stays readable independently of Cloudflare. Both fall out of that
 * layout. The manifest carries the schema version, the per-table row counts and
 * checksums, and the R2 inventory, so `backup list` and `backup verify` answer
 * from it — an agency with a hundred archives does not decrypt a hundred bodies
 * to find the one it wants. And a directory of ordinary files can be copied to
 * another account, another provider or a disk, which is what makes a client's
 * exit possible at all.
 *
 * What is NOT in the clear is every row of it. The manifest holds counts,
 * digests and object keys — object keys are content hashes (catalogue import)
 * or random (admin uploads), so none of it names a customer.
 *
 * The manifest is authenticated as GCM additional data (crypto.mjs), so the
 * cleartext half cannot be edited to make an archive claim another shop, another
 * environment or another schema. Two fields are produced BY sealing and are
 * therefore outside that cover — `cipher` itself, and `data.digest`. The digest
 * is a corruption check for a reader with no key, never an authentication: what
 * proves the body is a corruption check with a key is the tag.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, digest } from './dump.mjs';
import { inputError, verificationError } from '../errors.mjs';

/** The archive layout's own version. A reader that meets a higher one stops
 *  rather than guessing at a field it does not know.
 *
 *  2 (socle v0.3.32, ADR 0019): an object is sealed for its bucket and key, no
 *  longer for the archive, so that one sealed copy in the backups bucket's
 *  media pool can serve every archive that references it (`pool.mjs`); an
 *  inventory entry names that copy as `pool`. Format 1 archives still open. */
export const ARCHIVE_FORMAT = 2;

export const MANIFEST_FILE = 'manifest.json';
export const DATA_FILE = 'data.bin';
export const OBJECTS_DIR = 'objects';

/** Where backups go when the operator names no other place. Outside the tree's
 *  tracked files, and in .gitignore: an archive is the merchant's data and has
 *  no business in a repository. */
export const DEFAULT_REPOSITORY = 'backups';

/** Retention, when the operator names none. Both bounds apply, and an archive
 *  is dropped only when both agree (ADR 0005: bornée, jamais vide). The day
 *  bound is also the lifecycle rule `provision` puts on the backups bucket,
 *  where only an age can be expressed — see provision.mjs. */
export const DEFAULT_KEEP = 30;
export const DEFAULT_KEEP_DAYS = 90;

/** What every backup id of a shop's environment starts with — and so the
 *  prefix the backups bucket's retention rule expires, which leaves the media
 *  pool to its own rule (provision.mjs). */
export function archivePrefix(slug, env) {
  return `${slug}-${env}-`;
}

/** A backup's name: the shop, the environment, and the instant. Sorts
 *  chronologically as text, which is what makes `list` and `prune` free. */
export function backupId(slug, env, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${archivePrefix(slug, env)}${stamp}`;
}

/** An id a path can be built from. Ids are generated here, but one also arrives
 *  as `--from <id>` from a shell, and a restore that resolved `../../etc` would
 *  be reading whatever the operator was tricked into naming. */
export function assertBackupId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(id ?? '')) || String(id).includes('..')) {
    throw inputError(`« ${id} » n'est pas un identifiant de sauvegarde.`, 'Listez ceux qui existent avec `shopctl backup list`.');
  }
  return id;
}

/**
 * The part of a manifest the encryption authenticates.
 *
 * Everything except what sealing itself produced. Written as an explicit pick
 * rather than a delete-these-keys, so that a field added to the manifest later
 * is outside the cover until someone decides it belongs inside — the safe
 * direction to be wrong in.
 */
export function authenticatedHeader(manifest) {
  return canonical({
    format: manifest.format,
    id: manifest.id,
    shop: manifest.shop,
    env: manifest.env,
    createdAt: manifest.createdAt,
    coreVersion: manifest.coreVersion,
    account: manifest.account,
    schema: manifest.schema,
    tables: manifest.tables,
    r2: manifest.r2,
  });
}

/** Where one object's bytes are kept. Keyed by the hash of the object KEY, not
 *  by the key itself: an R2 key holds slashes and whatever the merchant's file
 *  was called, and neither belongs in a path this CLI builds. */
export function objectFile(key) {
  return `${OBJECTS_DIR}/${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}.bin`;
}

/**
 * What an object's seal is bound to: the GCM additional data.
 *
 * Format 1 bound it to the archive, so a copy could not be moved to another
 * one — and could not be SHARED with another one either. Format 2 binds it to
 * the bucket it was read from and its key: a copy still cannot pass for another
 * object or another shop's (the bucket's name carries the slug and the
 * environment), and an R2 key never changes content (random or content-hash
 * keys, deliverables under a fresh UUID), so the same sealed copy is the right
 * answer for every archive that names that key.
 */
export function objectContext(manifest, bucket, key) {
  return Number(manifest.format) >= 2 ? `object:${bucket}:${key}` : `${manifest.id}:${bucket}:${key}`;
}

/** Every object an archive carries the bytes of, with the bucket it was read
 *  from: what a restore writes back and what a pull fetches. */
export function storedObjects(manifest) {
  return (manifest.r2?.buckets ?? []).flatMap((bucket) =>
    bucket.inventory.filter((object) => object.file).map((object) => ({ ...object, source: bucket.name, binding: bucket.binding })),
  );
}

/** The objects whose bytes are not in this directory but in the backups
 *  bucket's media pool: an archive taken with `--upload` does not re-read what
 *  the pool already holds, and `backup pull` brings those back. */
export function pooledElsewhere(entry) {
  return storedObjects(entry.manifest).filter((object) => object.pool && !existsSync(join(entry.path, object.file)));
}

export function repositoryPath(root, out) {
  return resolve(root, out ?? DEFAULT_REPOSITORY);
}

/** Write one backup, manifest last.
 *
 *  The order is the whole crash story: a directory whose manifest is missing is
 *  visibly incomplete and `list` says so, where a manifest written first would
 *  describe a body that may never have arrived. */
export function writeArchive(directory, { manifest, ciphertext, objects = [] }) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, DATA_FILE), ciphertext);
  if (objects.length > 0) mkdirSync(join(directory, OBJECTS_DIR), { recursive: true });
  for (const object of objects) writeFileSync(join(directory, object.file), object.bytes);
  writeFileSync(join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

/**
 * Every backup the repository holds, newest last.
 *
 * A directory whose manifest is absent or unreadable is RETURNED, marked
 * `broken`, rather than skipped. An interrupted `backup` leaves exactly that,
 * and a listing that hid it would leave the operator with a directory taking up
 * space that nothing admits to.
 */
export function listArchives(directory) {
  if (!existsSync(directory)) return [];
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (!statSync(path).isDirectory()) continue;
    const file = join(path, MANIFEST_FILE);
    if (!existsSync(file)) {
      entries.push({ id: name, path, manifest: null, broken: 'manifeste absent' });
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (manifest.format > ARCHIVE_FORMAT) {
        entries.push({ id: name, path, manifest, broken: `format ${manifest.format}, cette CLI lit ${ARCHIVE_FORMAT}` });
        continue;
      }
      // A manifest that parses is not yet a manifest. Every reader below indexes
      // into these four, and a file edited by hand — or written by a version
      // that crashed halfway — would otherwise surface as a stack trace instead
      // of the one sentence the operator can act on.
      const missing = ['id', 'shop', 'env', 'createdAt', 'cipher', 'data', 'tables', 'r2'].filter((field) => manifest[field] == null);
      if (missing.length > 0) {
        entries.push({ id: name, path, manifest, broken: `manifeste incomplet : ${missing.join(', ')}` });
        continue;
      }
      entries.push({ id: name, path, manifest, broken: null });
    } catch (error) {
      entries.push({ id: name, path, manifest: null, broken: `manifeste illisible : ${error.message}` });
    }
  }
  return entries;
}

export function readArchive(directory, id) {
  assertBackupId(id);
  const found = listArchives(directory).find((entry) => entry.id === id);
  if (!found) {
    throw inputError(`aucune sauvegarde « ${id} » dans ${directory}.`, 'Listez celles qui existent avec `shopctl backup list`.');
  }
  if (found.broken) throw verificationError(`la sauvegarde « ${id} » est incomplète : ${found.broken}.`);
  return found;
}

/**
 * What can be checked with no key at all.
 *
 * The body is there, it is the length the manifest claims, and its bytes hash
 * to what the manifest recorded. That is corruption — a truncated copy, a bad
 * transfer, a disk that lied — and it is the failure that actually happens to
 * archives sitting on a shelf. It is NOT authenticity, and the report says so
 * rather than letting an operator read a green line as more than it is.
 */
export function verifyStructure(entry) {
  const checks = [];
  const { manifest, path } = entry;
  const data = join(path, DATA_FILE);

  if (!existsSync(data)) {
    checks.push({ name: 'corps', ok: false, detail: `${DATA_FILE} est absent` });
    return checks;
  }
  const bytes = readFileSync(data);
  checks.push({
    name: 'taille du corps',
    ok: bytes.length === manifest.data.bytes,
    detail: `${bytes.length} octet(s), le manifeste en annonce ${manifest.data.bytes}`,
  });
  const found = digest(bytes);
  checks.push({ name: 'empreinte du corps', ok: found === manifest.data.digest, detail: found === manifest.data.digest ? found : `${found} ≠ ${manifest.data.digest}` });

  let pooled = 0;
  for (const object of storedObjects(manifest)) {
    const file = join(path, object.file);
    if (!existsSync(file)) {
      // Left in the pool by an upload that did not re-read it: not corruption,
      // and not checked here either. The one check says which, and how many.
      if (object.pool) pooled += 1;
      else checks.push({ name: `objet ${object.key}`, ok: false, detail: 'absent de l\'archive' });
      continue;
    }
    const objectDigest = digest(readFileSync(file));
    checks.push({ name: `objet ${object.key}`, ok: objectDigest === object.digest, detail: objectDigest === object.digest ? 'intact' : 'empreinte différente' });
  }
  if (pooled > 0) {
    checks.push({
      name: 'objets du bucket de sauvegarde',
      ok: true,
      detail: `${pooled} objet(s) restés dans le pool du bucket -backups, non relus ici ; \`backup pull\` les rapatrie et les contrôle`,
    });
  }
  return checks;
}

/**
 * Which backups a retention policy keeps, and which it lets go.
 *
 * Two bounds, and BOTH have to agree before an archive is dropped: it is older
 * than the age limit AND there are enough newer ones to satisfy the count. A
 * shop that stopped being backed up for a month must not have its last archive
 * pruned by an age rule — the archive being old is the reason to keep it, not
 * the reason to delete it (ADR 0005: the conservation is bounded, the shop is
 * not left without one).
 *
 * A broken directory is prunable by age alone: it protects nothing.
 */
export function planPrune(entries, { keep = null, keepDays = null, now = new Date() } = {}) {
  const sound = entries.filter((entry) => !entry.broken);
  const newestFirst = [...sound].sort((a, b) => String(b.manifest.createdAt).localeCompare(String(a.manifest.createdAt)));
  const cutoff = keepDays === null ? null : now.getTime() - keepDays * 86_400_000;

  const remove = [];
  for (const [index, entry] of newestFirst.entries()) {
    const tooMany = keep !== null && index >= keep;
    const tooOld = cutoff !== null && Date.parse(entry.manifest.createdAt) < cutoff;
    if (keep !== null && keepDays !== null ? tooMany && tooOld : tooMany || tooOld) {
      remove.push({ id: entry.id, path: entry.path, reason: tooOld ? 'âge' : 'nombre' });
    }
  }
  for (const entry of entries.filter((candidate) => candidate.broken)) {
    remove.push({ id: entry.id, path: entry.path, reason: 'incomplète' });
  }
  return {
    remove,
    keepIds: entries.filter((entry) => !remove.some((dropped) => dropped.id === entry.id)).map((entry) => entry.id),
  };
}

/**
 * Where an object's sealed bytes live in the backups bucket: the pool for a
 * format 2 archive that was uploaded with it, under the archive's own prefix
 * otherwise (format 1, or a bucket whose rules do not let the pool outlive
 * the archives — `pool.mjs`).
 */
export function remoteObjectPath(id, object) {
  return object.pool ?? `${id}/${object.file}`;
}

export function removeArchive(path) {
  rmSync(path, { recursive: true, force: true });
}
