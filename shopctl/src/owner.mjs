/**
 * Whose shop a database is.
 *
 * With one Cloudflare account per merchant (ADR 0002) a resource's name was
 * proof enough: nothing else on that account could be called
 * `minshop-<slug>-…`. On the shared account of ADR 0019 it is not. Two shops
 * that derive the same names — a slug reused, a manifest copied without its
 * `workerName` — find each other's resources, and `provision` adopts an
 * existing database by its name. The second shop would deploy onto the first
 * one's orders, and nothing at runtime would tell them apart (ADR 0001).
 *
 * So the database carries a MARKER: one row in `_minshop_owner`, written by
 * `provision`, naming the repository and the slug it was provisioned for.
 * Every command that resolves the database by its name reads it before doing
 * anything else, and refuses a database marked for another shop.
 *
 * The database rather than the buckets, because it is the resource every other
 * one hangs off: provisioning creates it first, destruction deletes it last,
 * and every command that writes or reads a shop's data goes through it. A
 * marker in a bucket would be one more wrangler call per bucket to prove what
 * the database already proves.
 *
 * The repository is the identity, the slug only its witness. Two shops can
 * share a slug — that is the very collision — but not a GitHub repository. It
 * is read from the tree's `origin` as configured, lowercased, because GitHub
 * names are case-insensitive and a clone typed by hand rarely matches the case
 * `actions/checkout` writes.
 */
import { ShopctlError, inputError, preconditionError } from './errors.mjs';
import { originUrl, parseGithubRemote } from './forge.mjs';
import { applyScript, query } from './backup/store.mjs';
import { literal } from './backup/dump.mjs';

/** Never backed up, never restored, never exported: `backup/schema.mjs` skips
 *  it, so an archive of one shop restored into another leaves the target's
 *  marker where it was. */
export const OWNER_TABLE = '_minshop_owner';

/**
 * The repository this tree is a clone of, as the marker records it.
 *
 * `owner/repo` lowercased for GitHub, the raw URL for any other remote, null
 * for a tree with no `origin` — a shop not pushed yet, or a test fixture.
 */
export function shopRepository(root) {
  const url = originUrl(root);
  if (!url) return null;
  try {
    return parseGithubRemote(url).nameWithOwner.toLowerCase();
  } catch (error) {
    if (!(error instanceof ShopctlError)) throw error;
    return url;
  }
}

/**
 * The marker, or null when the database has none.
 *
 * Two questions rather than one: a SELECT on a table that is not there is an
 * error, and an unmarked database is the ordinary state of every shop
 * provisioned before ADR 0019, not a failure.
 */
export function readOwner(database, { cwd }) {
  const [tables] = query([`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${OWNER_TABLE}';`], {
    cwd,
    remote: true,
    database,
    what: 'le marqueur de la boutique',
  });
  if (tables.length === 0) return null;
  const [rows] = query([`SELECT repository, slug, marked_at FROM ${OWNER_TABLE} WHERE id = 1;`], {
    cwd,
    remote: true,
    database,
    what: 'le marqueur de la boutique',
  });
  const row = rows[0];
  return row ? { repository: row.repository ?? null, slug: row.slug, markedAt: row.marked_at ?? null } : null;
}

/**
 * What a marker says about this tree's claim on the database.
 *
 * - `unmarked`: no marker. A database provisioned before ADR 0019, or one
 *   whose first provisioning stopped before the marker was written;
 * - `own`: same slug, and the same repository whenever both are known;
 * - `foreign`: another slug, or another repository;
 * - `unproven`: the marker names a repository and this tree has no `origin`
 *   to show it is that one. Refused like `foreign`: a tree that cannot say
 *   which shop it is cannot be allowed to act as one.
 *
 * A marker WITHOUT a repository — written from a tree that had no `origin`
 * yet — is judged on its slug alone, and `provision` completes it.
 */
export function judgeOwner(marker, { repository, slug }) {
  if (!marker) return 'unmarked';
  if (marker.slug !== slug) return 'foreign';
  if (!marker.repository) return 'own';
  if (!repository) return 'unproven';
  return marker.repository === repository ? 'own' : 'foreign';
}

/** Write (or rewrite) the one row. `id = 1` makes a second row impossible
 *  rather than unlikely. */
export function markOwner(database, { cwd, repository, slug, at = new Date().toISOString() }) {
  applyScript(
    [
      `CREATE TABLE IF NOT EXISTS ${OWNER_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), repository TEXT, slug TEXT NOT NULL, marked_at TEXT NOT NULL);`,
      `INSERT INTO ${OWNER_TABLE} (id, repository, slug, marked_at) VALUES (1, ${literal(repository)}, ${literal(slug)}, ${literal(at)}) ` +
        'ON CONFLICT(id) DO UPDATE SET repository = excluded.repository, slug = excluded.slug, marked_at = excluded.marked_at;',
    ],
    { cwd, remote: true, database },
  );
}

/** "acme (agence/shop-acme)", for a sentence that names both halves. */
export function describeOwner({ repository, slug }) {
  return repository ? `${slug} (${repository})` : slug;
}

/**
 * The refusal a foreign or unproven marker earns, worded for the command that
 * met it. `provision --claim <slug>` is the way out, and the only one: a
 * repository renamed or transferred is the honest case for it.
 */
export function ownerRefusal(verdict, { database, marker, repository, slug, env }) {
  const claim = `shopctl provision --env ${env} --claim ${slug}`;
  if (verdict === 'unproven') {
    return preconditionError(
      `${database} est marquée pour le dépôt ${marker.repository}, et cet arbre n'a pas de remote origin pour prouver qu'il est ce dépôt.`,
      `Travaillez depuis un clone du dépôt de la boutique. Si la base est bien la sienne, \`${claim}\` réécrit le marqueur.`,
    );
  }
  return preconditionError(
    `${database} appartient à une autre boutique : son marqueur nomme ${describeOwner(marker)}, cet arbre est ${describeOwner({ repository, slug })}.`,
    `Deux boutiques dérivent les mêmes noms de ressources sur ce compte (ADR 0019) : donnez à celle-ci un cloudflare.workerName à elle. Si la base est bien la sienne (dépôt renommé ou transféré), \`${claim}\` réécrit le marqueur.`,
  );
}

/**
 * The check every command but `provision` makes, right after finding the
 * database by its name and before reading or writing anything in it.
 *
 * An unmarked database is warned about, not refused: every shop provisioned
 * before ADR 0019 is one, and the remedy — a `provision` run — is cheap and
 * idempotent.
 *
 * @returns {{ repository: string|null, verdict: string, marker: object|null }}
 */
export function guardOwner({ database, root, manifest, env, reporter }) {
  const slug = manifest.client.slug;
  const repository = shopRepository(root);
  const marker = readOwner(database, { cwd: root });
  const verdict = judgeOwner(marker, { repository, slug });
  if (verdict === 'foreign' || verdict === 'unproven') {
    throw ownerRefusal(verdict, { database, marker, repository, slug, env });
  }
  if (verdict === 'unmarked') {
    reporter.warn(
      `${database} ne porte pas encore le marqueur de sa boutique.`,
      `\`shopctl provision --env ${env}\` le pose. Tant qu'il manque, rien ne distingue cette base de celle d'une autre boutique au même nom (ADR 0019).`,
    );
  } else {
    reporter.ok(`${database} — marquée pour ${describeOwner(marker)}`);
  }
  return { repository, verdict, marker };
}

/** `--claim` names the shop it claims for, typed, like `destroy --confirm`. */
export function readClaim(value, slug) {
  if (value === undefined) return false;
  if (value !== slug) {
    throw inputError(
      `--claim « ${value} » ne nomme pas cette boutique.`,
      `La boutique de cet arbre est « ${slug} ». Le marqueur n'a pas été touché.`,
    );
  }
  return true;
}
