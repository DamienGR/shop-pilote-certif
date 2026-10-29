/**
 * Which tables a backup carries, in which order, and which objects they name.
 *
 * The list is DERIVED from `sqlite_master`, never written down here. A written
 * list stops being complete at the first migration nobody thought to add it to,
 * and the table that is missing from the list is the table that is missing from
 * the archive — silently, until a restore. The same reasoning the security
 * suite applies to admin routes, applied to a schema (plan §5.6, ADR 0005).
 *
 * Five families are left out, and each for its own reason:
 *
 *  - `sqlite_*` is SQLite's own bookkeeping. `sqlite_sequence` in particular is
 *    NOT restored and must not be: AUTOINCREMENT updates it as the explicit row
 *    ids go back in, so restoring it by hand would only be a chance to get it
 *    wrong;
 *  - `_cf_*` is the platform's;
 *  - `d1_migrations` is the SCHEMA, not the data. A restore applies the tree's
 *    migrations with wrangler, which writes that table itself; carrying rows
 *    for it would let an archive claim a schema the target does not have;
 *  - a virtual table and its shadow tables are an INDEX. `products_fts` is
 *    external-content over `products` and its triggers rebuild it as the rows
 *    go back in (migration 0003). Backing up the index would double the archive
 *    to store something the data already determines, and restoring it would
 *    fight the triggers for the right to write it;
 *  - `_minshop_owner` is the marker that says which shop the DATABASE belongs
 *    to (ADR 0019, `owner.mjs`), not data of that shop. Carried in an archive,
 *    it would follow one shop's data into another's database and stamp the
 *    target with the source's name.
 */
import { OWNER_TABLE } from '../owner.mjs';

/** D1's and SQLite's own tables, by exact name. */
export const INTERNAL_TABLES = new Set(['d1_migrations']);

/**
 * Split `sqlite_master` into what a backup takes and what it leaves.
 *
 * @param {Array<{ type: string, name: string, sql: string|null }>} master
 * @returns {{ tables: Array<{ name: string, sql: string }>, virtual: string[], skipped: Array<{ name: string, reason: string }> }}
 */
export function classifyTables(master) {
  const rows = master.filter((row) => row.type === 'table');
  const virtual = rows.filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? '')).map((row) => row.name);

  const tables = [];
  const skipped = [];
  for (const row of rows) {
    const { name } = row;
    if (name.startsWith('sqlite_')) skipped.push({ name, reason: 'sqlite' });
    else if (name.startsWith('_cf_')) skipped.push({ name, reason: 'cloudflare' });
    else if (INTERNAL_TABLES.has(name)) skipped.push({ name, reason: 'migrations' });
    else if (name === OWNER_TABLE) skipped.push({ name, reason: 'propriétaire' });
    else if (virtual.includes(name)) skipped.push({ name, reason: 'virtuelle' });
    else if (virtual.some((table) => name.startsWith(`${table}_`))) skipped.push({ name, reason: 'index' });
    else tables.push({ name, sql: row.sql ?? '' });
  }
  return { tables: tables.sort((a, b) => a.name.localeCompare(b.name)), virtual: virtual.sort(), skipped };
}

/**
 * The tables one table's rows point at.
 *
 * Read out of the CREATE TABLE text rather than asked with
 * `PRAGMA foreign_key_list`, which would be one wrangler process per table on a
 * path that already has the text in hand. The pattern matches the three spellings
 * SQLite accepts for the name — bare, "quoted", `backticked` — because a schema
 * written in any of them still has to restore.
 */
export function references(sql) {
  const found = new Set();
  for (const match of String(sql).matchAll(/\bREFERENCES\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/gi)) {
    found.add(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return found;
}

/**
 * The order rows can be inserted in without a foreign key ever dangling.
 *
 * Kahn's algorithm with an alphabetical tie-break, so the order is a function of
 * the schema and not of the order `sqlite_master` happened to answer in — the
 * same determinism the digests need one level up.
 *
 * A CYCLE is reported rather than resolved. SQLite allows one, this schema has
 * none, and a restore that quietly picked a starting point would be a restore
 * that fails on some databases and not others.
 *
 * @param {Array<{ name: string, sql: string }>} tables
 * @returns {{ order: string[], cycle: string[] }}
 */
export function orderTables(tables) {
  const names = new Set(tables.map((table) => table.name));
  const dependencies = new Map(
    tables.map((table) => [
      table.name,
      // A self-reference (a category's parent) is not a dependency between two
      // tables and cannot be ordered around; the rows inside one INSERT are
      // written in the order the archive holds them.
      new Set([...references(table.sql)].filter((target) => names.has(target) && target !== table.name)),
    ]),
  );

  const order = [];
  const remaining = new Set(names);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => [...dependencies.get(name)].every((target) => !remaining.has(target)))
      .sort((a, b) => a.localeCompare(b));
    if (ready.length === 0) return { order: [...order, ...[...remaining].sort()], cycle: [...remaining].sort() };
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
    }
  }
  return { order, cycle: [] };
}

/**
 * Columns SQLite computes and refuses to be told.
 *
 * `orders.refunded_cents` is `GENERATED ALWAYS AS (…)` since migration 0025:
 * `SELECT *` hands it back like any other column, and an INSERT that carries it
 * is rejected outright. So a restore has to know which columns to leave out —
 * and it is worth being precise about what that means. The VALUE is still
 * captured, still checksummed and still compared after the restore: what the
 * comparison then proves is that the target's own expression produced the same
 * number, which is a stronger statement than storing it would have been.
 *
 * Read out of the CREATE TABLE text, which SQLite keeps up to date through
 * `ALTER TABLE ADD COLUMN` — that is how a column added by a later migration
 * than the one that made the table is still found here.
 */
export function generatedColumns(sql) {
  const generated = new Set();
  for (const { name, definition } of columnDefinitions(sql)) {
    if (/\bGENERATED\s+ALWAYS\s+AS\s*\(/i.test(definition) || /^\S+\s+AS\s*\(/i.test(definition)) generated.add(name);
  }
  return generated;
}

/** The name a CREATE TABLE clause opens with, in any of SQLite's spellings. */
const leadingName = (definition) => {
  const match = definition.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/);
  return match ? (match[1] ?? match[2] ?? match[3] ?? match[4]) : null;
};

/**
 * A CREATE TABLE's clauses, split on its TOP-LEVEL commas.
 *
 * A generated column's expression has commas of its own — `MIN(a, b + c)` —
 * and splitting on all of them would read `b + c` as a column definition. Table
 * constraints come back too, with a null name: `FOREIGN KEY (a, b) REFERENCES …`
 * is a clause a reader may want and never a column.
 *
 * COMMENTS ARE DROPPED AS THEY ARE SCANNED, and that is not a tidying step.
 * SQLite stores the CREATE TABLE text as it was typed, and this schema
 * documents itself inside its tables: `status TEXT DEFAULT 'active', -- active
 * | released` puts a trailing comment where the NEXT column's definition
 * begins, which reads as a clause with no name at all — the column disappears.
 * Worse, a comment with an apostrophe in it (`-- a total we didn't have`) opens
 * a string literal that swallows everything to the next quote. Both were live
 * in `migrations/`: this is why the reader is a scanner and not a `split(',')`.
 *
 * `ALTER TABLE ADD COLUMN` rewrites the stored text, so a column added by a
 * later migration than the one that made the table is in here as well — which
 * is what lets the whole schema be read without a single extra query.
 *
 * @returns {Array<{ name: string|null, definition: string }>}
 */
export function columnDefinitions(sql) {
  const text = String(sql);
  const open = text.indexOf('(');
  if (open === -1) return [];

  const parts = [];
  let buffer = '';
  let depth = 0;
  let quote = null;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      buffer += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index);
      if (end === -1) break;
      index = end;
      buffer += '\n';
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 1;
      buffer += ' ';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      buffer += character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    if (character === ',' && depth === 0) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += character;
  }
  parts.push(buffer);

  return parts
    .map((part) => part.trim())
    .filter((definition) => definition !== '')
    .map((definition) => ({
      name: /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(definition) ? null : leadingName(definition),
      definition,
    }));
}

/** Every column a table declares, in declaration order. */
export function columnNames(sql) {
  return columnDefinitions(sql).map((entry) => entry.name).filter((name) => name !== null);
}

/**
 * The columns of one table that point at another.
 *
 * Both spellings SQLite accepts: on the column — `order_id INTEGER REFERENCES
 * orders(id)` — and as a table constraint — `FOREIGN KEY (order_id) REFERENCES
 * orders(id)`. A composite constraint contributes every column it names.
 */
export function referencingColumns(sql, target) {
  const points = (definition) =>
    [...references(definition)].includes(target);
  const found = [];
  for (const { name, definition } of columnDefinitions(sql)) {
    if (!points(definition)) continue;
    if (name !== null) {
      found.push(name);
      continue;
    }
    const columns = definition.match(/^FOREIGN\s+KEY\s*\(([^)]*)\)/i);
    if (columns) {
      for (const column of columns[1].split(',')) {
        const cleaned = leadingName(column.trim());
        if (cleaned) found.push(cleaned);
      }
    }
  }
  return [...new Set(found)];
}

/**
 * Tables the SCHEMA fills, as opposed to tables the shop fills.
 *
 * A freshly migrated database is not empty: migration 0040 writes the four
 * French legal pages, and a shop's first environment therefore has rows in it
 * before anyone has logged into the admin. A restore that demanded a literally
 * empty target would demand `--overwrite` on every first restore — and a flag
 * that is always required is a flag nobody reads.
 *
 * So the emptiness test ignores the tables the migrations themselves write
 * into, and the list is DERIVED from the migration files rather than written
 * here: a migration that seeds a new table tomorrow is covered without anyone
 * remembering this exists. The limit is named rather than hidden — a merchant
 * who edited their legal pages and nothing else will not trigger the guard.
 * Every table that carries a customer, an order, a product or a payment does.
 *
 * @param {string[]} texts the contents of the tree's migration files
 */
export function seededTables(texts) {
  const seeded = new Set();
  for (const text of texts) {
    for (const match of String(text).matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi)) {
      seeded.add(match[1] ?? match[2] ?? match[3]);
    }
  }
  return seeded;
}

/**
 * Which R2 objects this data says exist, per bucket.
 *
 * Derived from the DATA, which is the only derivation that holds: `media` is
 * the sole owner of a stored image (invariant 10), and a private deliverable is
 * named by the product it belongs to and by the order line that bought it.
 * Wrangler has no "list a bucket" command, so an inventory read from the bucket
 * is not available to a dependency-free CLI at all — and would answer a
 * different question anyway. What a restore has to reproduce is the set of
 * objects the ROWS need; an object in the bucket that nothing references is
 * not part of the shop.
 *
 * `orphans` is the other direction, and it is reported rather than repaired: a
 * key a product carries with no `media` row behind it is a broken image the
 * merchant will see, and a backup is a good moment to learn about it.
 */
export function objectInventory(tables) {
  const rows = (name) => tables[name]?.rows ?? [];
  const keys = (name, column) => rows(name).map((row) => row[column]).filter((value) => typeof value === 'string' && value !== '');

  const images = new Set(keys('media', 'image_key'));
  // The two tables that denormalise a key rather than joining `media` by id.
  // A page or a menu item points at a media ROW, so neither can name a key
  // `media` does not have — asking them would add a join with no answer in it.
  const referenced = new Set([...keys('products', 'image_key'), ...keys('product_images', 'image_key')]);
  const files = new Set([...keys('products', 'file_key'), ...keys('order_items', 'file_key')]);

  return {
    images: [...images].sort(),
    files: [...files].sort(),
    orphans: [...referenced].filter((key) => !images.has(key)).sort(),
  };
}
