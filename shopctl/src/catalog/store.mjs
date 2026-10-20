/**
 * The store, as the importer sees it: one read, one write, one object put.
 *
 * The whole surface is three functions, and everything above this file is pure.
 * That is deliberate — it is what lets the plan be computed, reviewed and
 * printed by `--dry-run` without any way of reaching a database, and it is what
 * lets the test suite exercise the real statements against a real SQLite engine
 * instead of a mock that agrees with itself.
 *
 * Wrangler is wrapped, never reimplemented (plan §5.1, ADR 0009): the bindings,
 * the local state directory and the remote credentials all live in the shop's
 * own `wrangler.jsonc`, and a second way of reaching D1 would be a second set of
 * answers about which database is being written.
 *
 * ONE `--file` for the whole write, not a statement per call. A remote
 * `wrangler d1 execute` costs about a second of process start-up before it does
 * anything; a two-hundred-product import is two thousand statements, and paying
 * that per statement turns a thirty-second job into half an hour. The cost of
 * the file shape is that values are inlined rather than bound, which is why
 * sql.mjs exists and why its quoting is tested against hostile input.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resourceNames } from '../../../scripts/manifest.mjs';
import { wrangler } from '../cloudflare.mjs';
import { externalError, preconditionError } from '../errors.mjs';

/** The D1 binding the template declares. `wrangler d1 execute` accepts a binding
 *  name, so nothing has to resolve the database's own name to read or write. */
export const D1_BINDING = 'DB';

/**
 * The images bucket's NAME, which is what `wrangler r2 object` addresses — R2
 * has no binding-name form of the command.
 *
 * Derived from the manifest by `resourceNames()`, not read out of
 * `wrangler.jsonc`: that file is GENERATED from the manifest by
 * `prepare-client.mjs`, so the manifest is the source and parsing the render
 * would be reading the derivation back through a JSONC parser this CLI would
 * then have to carry. `config:validate` already refuses a manifest whose worker
 * name diverges from the convention, which is what makes the derivation safe.
 */
export function imagesBucket(manifest, { env = null } = {}) {
  return resourceNames(manifest, { env }).images;
}

/**
 * The jurisdiction flag every REMOTE R2 call needs.
 *
 * A bucket created with `--jurisdiction eu` (ADR 0004) is not in the account's
 * default namespace: `wrangler r2 object put` without `-J eu` reports the
 * bucket as missing. Local calls have no jurisdiction to speak of — miniflare
 * keys its buckets by name alone — so the flag is added only when the call
 * leaves the machine.
 */
export function jurisdictionFlags(manifest, remote) {
  return remote ? ['-J', manifest.cloudflare.jurisdiction] : [];
}

/**
 * Refuse to write into a tree whose Wrangler configuration describes a
 * DIFFERENT shop than the manifest being imported.
 *
 * The two are normally in step — `prepare-client.mjs` renders `wrangler.jsonc`
 * from the manifest — but two situations break that, and both write real data
 * into the wrong place. In the core, `--shop` picks a witness manifest while
 * `wrangler.jsonc` still names the core's own resources. In a shop repository,
 * a `wrangler.jsonc` rendered for another manifest is exactly the mistake
 * nothing else catches: the D1 binding is called `DB` in every shop, so the
 * write would succeed, silently, against someone else's database.
 *
 * A substring test on the rendered file, deliberately, rather than a JSONC
 * parser this CLI would then have to carry: what is being checked is that this
 * shop's name family appears in the configuration wrangler is about to read.
 *
 * The remedy depends on where the import goes. A DEPLOYED database is named
 * by its id, which only the account knows: `prepare-client.mjs --env` renders
 * the right names around a placeholder id, the name check then passes, and
 * wrangler fails on a database that does not exist. `provision` renders the
 * real id and creates nothing on a second run, so that is what a remote import
 * is told to run.
 *
 * @param {string} root the tree wrangler will run in
 * @param {string} bucket this shop's images bucket, from imagesBucket()
 * @param {{ remote?: boolean, env?: string|null }} [target] where the import writes
 */
export function assertWranglerNamesShop(root, bucket, { remote = false, env = null } = {}) {
  const render =
    remote && env
      ? `\`npm run shopctl -- provision --env ${env}\` : il la rend avec l'identifiant réel de la base, et ne crée rien sur un environnement déjà provisionné`
      : `\`node scripts/prepare-client.mjs <slug>${env ? ` --env ${env}` : ''}\``;
  const file = resolve(root, 'wrangler.jsonc');
  if (!existsSync(file)) {
    throw preconditionError(
      `${root} n'a pas de wrangler.jsonc ; wrangler ne saurait pas quelle base écrire.`,
      `Rendez la configuration de cette boutique : ${render}.`,
    );
  }
  if (!readFileSync(file, 'utf8').includes(bucket)) {
    throw preconditionError(
      `wrangler.jsonc ne nomme pas « ${bucket} » : il décrit une autre boutique que ce manifeste.`,
      `Rendez la configuration de cette boutique ET de cet environnement avant d'importer — ${render}. Sans ce contrôle, l'import écrirait dans la base d'une autre boutique, ou dans celle d'un autre environnement : la liaison D1 s'appelle « DB » partout.`,
    );
  }
}

/** The reads that make up the current catalogue, in a fixed order. */
const READS = [
  ['products', 'SELECT id, sku, slug, name, description, price_cents, currency, stock, active, variant_label, weight_grams, requires_shipping, image_key FROM products'],
  ['variants', 'SELECT id, product_id, sku, label, price_cents, stock, weight_grams, position, active, image_id FROM product_variants'],
  ['categories', 'SELECT id, slug, name FROM categories'],
  ['productCategories', 'SELECT product_id, category_id FROM product_categories'],
  ['productImages', 'SELECT id, product_id, image_key, position FROM product_images'],
  ['media', 'SELECT id, image_key FROM media'],
];

/**
 * Where the import writes.
 *
 * `--local` is the dev database `npm run dev` serves and the default, because an
 * operator's first import is always a rehearsal. `--remote` is the deployed one
 * and is never reached by omission.
 */
export function targetFlag(remote) {
  return remote ? '--remote' : '--local';
}

/**
 * wrangler prints its own preamble before the document. Take the JSON, not the
 * banner: matching on the first `[` or `{` is what survives a wrangler release
 * that adds or removes a line of chrome.
 */
export function extractJson(output) {
  const start = output.search(/[[{]/);
  if (start === -1) throw externalError('wrangler n\'a pas répondu en JSON.', output.trim().split('\n').slice(0, 4).join('\n'));
  try {
    return JSON.parse(output.slice(start));
  } catch (error) {
    throw externalError(`la réponse de wrangler n'est pas du JSON exploitable : ${error.message}`);
  }
}

/**
 * `wrangler d1 execute --json` answers with one entry per statement, in order.
 * Reading them positionally is what keeps the six queries to one process.
 */
export function readCatalogue({ cwd, remote = false }) {
  const sql = READS.map(([, query]) => `${query};`).join('\n');
  const result = wrangler(['d1', 'execute', D1_BINDING, targetFlag(remote), '--json', '--command', sql], { cwd });
  const documents = extractJson(result.stdout);
  if (!Array.isArray(documents) || documents.length !== READS.length) {
    throw externalError(
      `wrangler a renvoyé ${Array.isArray(documents) ? documents.length : 'un document non tabulaire'} pour ${READS.length} requêtes.`,
      'La forme de la sortie `d1 execute --json` a changé ; l\'import lit les résultats par position.',
    );
  }
  const store = {};
  for (const [index, [name]] of READS.entries()) {
    store[name] = documents[index]?.results ?? [];
  }
  return store;
}

/**
 * Apply the plan's statements as one file.
 *
 * The file is written to a temporary directory and removed afterwards, on the
 * failure path too: it holds the whole catalogue, which is not a secret but is
 * the merchant's, and leaving copies of it around a shared machine is the kind
 * of habit that eventually leaves something that is.
 */
export function applyStatements(statements, { cwd, remote = false }) {
  if (statements.length === 0) return { statements: 0 };
  const directory = mkdtempSync(join(tmpdir(), 'shopctl-catalog-'));
  const file = join(directory, 'import.sql');
  try {
    writeFileSync(file, `${statements.join('\n')}\n`, 'utf8');
    wrangler(['d1', 'execute', D1_BINDING, targetFlag(remote), '--file', file, '--yes'], { cwd });
    return { statements: statements.length };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Put one object in the images bucket.
 *
 * Written before the row that names it, matching `uploadMedia()`: an object with
 * no row is an orphan nobody sees, where a row with no object is a broken image
 * on every page that uses it. An interrupted import therefore costs at most a
 * few unreferenced objects.
 *
 * Nothing asks the bucket first. The plan already skips an image whose media ROW
 * exists, and the row is only ever written after the object, so the objects left
 * to send are the ones an interrupted run may have already sent — and re-sending
 * one is a no-op, since the key is the hash of the bytes going into it. A HEAD
 * per image would buy nothing and cost a wrangler process per image.
 */
export function putObject({ key, path, mime_type: mimeType }, { cwd, bucket, remote = false, jurisdiction = [] }) {
  wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', path, '--content-type', mimeType, targetFlag(remote), ...jurisdiction], { cwd });
}
