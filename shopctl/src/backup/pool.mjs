/**
 * The media pool of a backups bucket: an R2 object is sealed and copied there
 * once, and every archive that references it names that copy (ADR 0019).
 *
 * Before it, every backup read every image and every deliverable out of the
 * shop's buckets and wrote each one again into `-backups`: two API calls per
 * object, twice a day, for an object that never changes. On the shared account
 * that is the whole fleet's 1 200 calls per five minutes, spent re-copying
 * bytes the bucket already has.
 *
 *   -backups/<id>/manifest.json       the archive, as before
 *   -backups/<id>/data.bin
 *   -backups/pool/<empreinte>.bin     one sealed object, named by its ciphertext
 *   -backups/pool/index.json          which key each copy holds, and since when
 *
 * Four decisions hold it together:
 *
 *  - **an object's seal is bound to its bucket and key, not to an archive**
 *    (`objectContext` in archive.mjs, format 2). An R2 key never changes
 *    content — media keys are random or a content hash, a deliverable sits
 *    under a fresh UUID — so one copy is right for every archive naming it;
 *  - **a pool file is never overwritten.** It is named by the digest of its
 *    ciphertext, which a fresh IV makes unique. Two runs that race, or an index
 *    lost half-way, cost a duplicate copy — never an archive whose object was
 *    replaced under it;
 *  - **the pool outlives the archives that reference it, by the bucket's own
 *    rules.** `provision` expires archives after 90 days by their prefix and
 *    the pool after 180. A copy is reused only while it will outlive an archive
 *    taken now: the window is DERIVED from the rules the bucket actually has
 *    (`reuseWindow`), so a bucket still on the old bucket-wide rule, or rules
 *    that could not be read, reuse nothing and every archive carries its own
 *    objects under its own prefix, as before. Nothing is ever deleted by this
 *    code: a media removed from the shop leaves the pool by age, and a
 *    destroyed shop's bucket empties itself;
 *  - **the index is sealed with the backup key.** What it says flows into
 *    manifests that are themselves authenticated, so an index edited in the
 *    bucket would produce archives that stop opening only at restore time.
 *    Sealed, an edit stops the index opening at once, and the run starts a
 *    fresh pool instead. A new key does the same: what the old one sealed
 *    stays readable by the archives that name it until it expires.
 *
 * Pure: the reads and writes are the caller's (backup.mjs), through store.mjs.
 */
import { DEFAULT_KEEP_DAYS } from './archive.mjs';
import { keyId, keyMatches, open, seal } from './crypto.mjs';

export const POOL_PREFIX = 'pool/';
export const POOL_INDEX = `${POOL_PREFIX}index.json`;

/** The pool's lifetime: twice the archives', so that a copy can be reused for
 *  about as long as an archive lives. */
export const POOL_KEEP_DAYS = 2 * DEFAULT_KEEP_DAYS;

/** Slack between "this copy outlives an archive taken now" and the rules: an
 *  upload's own duration, clocks, and R2 applying a rule some hours late. */
export const POOL_MARGIN_DAYS = 7;

/** The index's own layout version. */
export const INDEX_FORMAT = 1;

const DAY = 86_400_000;

/** A pool file's name, from the digest of the sealed bytes it holds. */
export function poolFile(ciphertextDigest) {
  return `${POOL_PREFIX}${ciphertextDigest.slice(0, 32)}.bin`;
}

/**
 * For how many days a pooled copy may be reused, given the bucket's rules.
 *
 * A copy stored at S lives until S + (pool lifetime); an archive taken now
 * lives until now + (archive lifetime). Reusing it is safe while
 * now − S < pool − archives − margin. A path no enabled rule expires lives
 * forever, which makes everything reusable if it is the pool — and nothing
 * if it is the archives, which would outlive any copy that can expire.
 *
 * @param {Array<{ enabled: boolean, prefix: string, days: number|null }>|null} rules
 */
export function reuseWindow(rules, archivePrefix) {
  if (!rules) return 0;
  const lifetime = (path) =>
    Math.min(Infinity, ...rules.filter((rule) => rule.enabled && rule.days != null && path.startsWith(rule.prefix)).map((rule) => rule.days));
  const pool = lifetime(`${POOL_PREFIX}x`);
  const archives = lifetime(`${archivePrefix}x`);
  if (pool === Infinity) return Infinity;
  return pool - archives - POOL_MARGIN_DAYS;
}

/** The GCM additional data of a bucket's index: an index cannot be moved to
 *  another shop's bucket and still open. */
const indexContext = (bucket) => `pool-index:${bucket}`;

/**
 * Open an index read from the bucket.
 *
 * Every way of not having one is said, and none of them is an error: the run
 * then re-reads its objects and writes a fresh index, which is what the first
 * run of a shop does anyway.
 *
 * @returns {{ state: 'ok'|'absent'|'other-key'|'unreadable', entries: Array<object> }}
 */
export function openIndex(bytes, key, bucket) {
  if (!bytes) return { state: 'absent', entries: [] };
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { state: 'unreadable', entries: [] };
  }
  if (document?.format !== INDEX_FORMAT || typeof document.sealed !== 'string') return { state: 'unreadable', entries: [] };
  if (!keyMatches(key, document.keyId)) return { state: 'other-key', entries: [] };
  try {
    const plain = open({ iv: document.iv, tag: document.tag, ciphertext: Buffer.from(document.sealed, 'base64') }, key, indexContext(bucket));
    const entries = JSON.parse(plain.toString('utf8'));
    return Array.isArray(entries) ? { state: 'ok', entries } : { state: 'unreadable', entries: [] };
  } catch {
    return { state: 'unreadable', entries: [] };
  }
}

export function sealIndex(entries, key, bucket) {
  const sealed = seal(Buffer.from(JSON.stringify(entries), 'utf8'), key, indexContext(bucket));
  return Buffer.from(
    `${JSON.stringify({ format: INDEX_FORMAT, keyId: keyId(key), iv: sealed.iv, tag: sealed.tag, sealed: sealed.ciphertext.toString('base64') }, null, 2)}\n`,
    'utf8',
  );
}

/** The entries still young enough to be reused, by source bucket and key. */
export function reusable(entries, windowDays, now = new Date()) {
  const usable = new Map();
  if (!(windowDays > 0)) return usable;
  for (const entry of entries) {
    const age = now.getTime() - Date.parse(entry.storedAt);
    if (Number.isFinite(age) && age >= 0 && age < windowDays * DAY) usable.set(poolKey(entry.source, entry.key), entry);
  }
  return usable;
}

export const poolKey = (source, key) => `${source}\n${key}`;

/**
 * The index after an upload: what is still reusable, with this run's copies
 * replacing older ones of the same key. `changed` says whether it is worth a
 * write — an unchanged shop's backup writes no index either.
 */
export function nextIndex({ previous, state, fresh, windowDays, now = new Date() }) {
  const kept = reusable(previous, windowDays, now);
  for (const entry of fresh) kept.set(poolKey(entry.source, entry.key), entry);
  const entries = [...kept.values()];
  const changed = fresh.length > 0 || entries.length !== previous.length || (state !== 'ok' && entries.length > 0);
  return { entries, changed };
}
