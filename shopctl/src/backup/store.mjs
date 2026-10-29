/**
 * The only file in the backup pipeline that reaches a database or a bucket.
 *
 * Everything above it — the table selection, the ordering, the statements, the
 * digests, the encryption, the retention — is pure, which is what lets
 * `backup --dry-run` be the same code path as a real backup rather than a
 * second implementation of it, and what lets the suite apply the REAL
 * statements to the REAL migrations.
 *
 * Wrangler is wrapped, never reimplemented (plan §5.1, ADR 0009): the binding,
 * the credentials and the jurisdiction all come from the shop's own
 * `wrangler.jsonc`, and a second client speaking to D1 directly would be a
 * second answer to "which database is this?" on the one path where being wrong
 * means writing a customer's orders into somebody else's shop.
 *
 * TWO THINGS ARE BATCHED AND ONE IS NOT. Table reads are grouped, because a
 * remote `wrangler d1 execute` costs about a second of process start-up before
 * it does anything and a schema has forty-odd tables. A LARGE table is paged
 * instead, because the alternative is a single response that has to fit in one
 * pipe and in one string — the read that works on a fixture and fails on a shop
 * that has been trading for a year.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrangler } from '../cloudflare.mjs';
import { externalError } from '../errors.mjs';

/** The D1 binding every shop declares. `wrangler d1 execute` takes a binding,
 *  so nothing here has to resolve a database name. */
export const D1_BINDING = 'DB';

/** How many SELECTs go into one wrangler process. */
export const READS_PER_CALL = 8;

/** Above this, a table is read a page at a time rather than in one answer. */
export const PAGE_SIZE = 5_000;

/** Room for one page of a wide table, and then some. The default 1 MiB is a
 *  silent truncation on any shop with real orders. */
const MAX_BUFFER = 512 * 1024 * 1024;

export const targetFlag = (remote) => (remote ? '--remote' : '--local');

/** wrangler prints a banner before its document; take the JSON, not the chrome. */
export function extractJson(output, what) {
  const start = output.search(/[[{]/);
  if (start === -1) {
    throw externalError(`wrangler n'a pas répondu en JSON pour ${what}.`, output.trim().split('\n').slice(0, 4).join('\n'));
  }
  try {
    return JSON.parse(output.slice(start));
  } catch (error) {
    throw externalError(`la réponse de wrangler pour ${what} n'est pas du JSON exploitable : ${error.message}`);
  }
}

/**
 * Run N statements in one process and return their result sets, positionally.
 *
 * Exported for the one caller outside this file that asks the database a
 * question of its own shape: `privacy` selects one buyer's rows by a predicate
 * rather than whole tables. It goes through here so there is one place that
 * knows how to start wrangler, how big an answer may be, and how to find the
 * JSON inside the banner.
 */
export function query(statements, { cwd, remote, what, database = D1_BINDING }) {
  const result = wrangler(
    ['d1', 'execute', database, targetFlag(remote), '--json', '--command', statements.join('\n')],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  const documents = extractJson(result.stdout, what);
  if (!Array.isArray(documents) || documents.length !== statements.length) {
    throw externalError(
      `wrangler a renvoyé ${Array.isArray(documents) ? documents.length : 'un document non tabulaire'} résultat(s) pour ${statements.length} requête(s) (${what}).`,
      'La forme de la sortie `d1 execute --json` a changé ; la sauvegarde lit les résultats par position.',
    );
  }
  return documents.map((document) => document?.results ?? []);
}

/** The schema as the database itself describes it, plus the migrations it says
 *  it has applied. Nothing is read from `migrations/` here: what a backup has
 *  to record is what the DATABASE ran, not what the checkout carries. */
export function readSchema({ cwd, remote }) {
  const [master] = query(["SELECT type, name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name;"], {
    cwd,
    remote,
    what: 'sqlite_master',
  });
  const hasMigrations = master.some((row) => row.name === 'd1_migrations');
  const migrations = hasMigrations
    ? query(['SELECT id, name, applied_at FROM d1_migrations ORDER BY id;'], { cwd, remote, what: 'd1_migrations' })[0]
    : [];
  return { master, migrations };
}

/** How many rows each table holds. One process for the lot, and the number the
 *  pager needs before it can page. */
export function countRows(names, { cwd, remote }) {
  const counts = {};
  for (let index = 0; index < names.length; index += READS_PER_CALL) {
    const chunk = names.slice(index, index + READS_PER_CALL);
    const results = query(chunk.map((name) => `SELECT COUNT(*) AS n FROM "${name}";`), { cwd, remote, what: 'COUNT(*)' });
    for (const [position, name] of chunk.entries()) counts[name] = Number(results[position]?.[0]?.n ?? 0);
  }
  return counts;
}

/** The union of the keys the rows carry. An empty table names no columns, and
 *  needs none: there is nothing to insert back. */
function columnsOf(rows) {
  const columns = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return columns;
}

/**
 * Every row of every table named, read in as few processes as the sizes allow.
 *
 * @param {Array<{ name: string, rowid: boolean }>} tables
 */
export function readTables(tables, { cwd, remote, counts }) {
  const dump = {};
  const small = tables.filter((table) => (counts[table.name] ?? 0) <= PAGE_SIZE);
  const large = tables.filter((table) => (counts[table.name] ?? 0) > PAGE_SIZE);

  for (let index = 0; index < small.length; index += READS_PER_CALL) {
    const chunk = small.slice(index, index + READS_PER_CALL);
    const results = query(chunk.map((table) => `SELECT * FROM "${table.name}";`), { cwd, remote, what: 'lecture des tables' });
    for (const [position, table] of chunk.entries()) {
      const rows = results[position];
      dump[table.name] = { columns: columnsOf(rows), rows };
    }
  }

  for (const table of large) {
    // A WITHOUT ROWID table has no stable cursor to page on, so it is read in
    // one answer and the size limit is accepted rather than worked around with
    // an ordering that is not unique — a page boundary that repeats or skips a
    // row is worse than a large response.
    if (!table.rowid) {
      const [rows] = query([`SELECT * FROM "${table.name}";`], { cwd, remote, what: table.name });
      dump[table.name] = { columns: columnsOf(rows), rows };
      continue;
    }
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const [page] = query([`SELECT * FROM "${table.name}" ORDER BY rowid LIMIT ${PAGE_SIZE} OFFSET ${offset};`], {
        cwd,
        remote,
        what: `${table.name} (page ${offset / PAGE_SIZE + 1})`,
      });
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    dump[table.name] = { columns: columnsOf(rows), rows };
  }
  return dump;
}

/**
 * Apply a script as ONE file.
 *
 * Written to a temporary directory and removed afterwards, on the failure path
 * too: it holds every order and every address the shop has, in the clear, and
 * leaving copies of that around a shared machine is the habit that eventually
 * leaves something worse.
 */
export function applyScript(statements, { cwd, remote, database = D1_BINDING }) {
  if (statements.length === 0) return { statements: 0 };
  const directory = mkdtempSync(join(tmpdir(), 'shopctl-restore-'));
  const file = join(directory, 'restore.sql');
  try {
    writeFileSync(file, `${statements.join('\n')}\n`, 'utf8');
    wrangler(['d1', 'execute', database, targetFlag(remote), '--file', file, '--yes'], { cwd, maxBuffer: MAX_BUFFER });
    return { statements: statements.length };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * One R2 object's bytes, or null when the bucket does not have it.
 *
 * A missing object is a REPORT, not a failure: a shop that lost an image months
 * ago must still be able to take a backup of everything it still has, and the
 * manifest is the right place for the operator to learn what is gone.
 */
export function getObject(key, { cwd, bucket, remote, jurisdiction = [] }) {
  const directory = mkdtempSync(join(tmpdir(), 'shopctl-object-'));
  const file = join(directory, 'object');
  try {
    const result = wrangler(
      ['r2', 'object', 'get', `${bucket}/${key}`, '--file', file, targetFlag(remote), ...jurisdiction],
      { cwd, allowFailure: true, maxBuffer: MAX_BUFFER },
    );
    if (result.status !== 0) return null;
    return readFileSync(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function putObject(key, bytes, { cwd, bucket, remote, jurisdiction = [], contentType = null }) {
  const directory = mkdtempSync(join(tmpdir(), 'shopctl-object-'));
  const file = join(directory, 'object');
  try {
    writeFileSync(file, bytes);
    wrangler(
      [
        'r2', 'object', 'put', `${bucket}/${key}`,
        '--file', file,
        ...(contentType ? ['--content-type', contentType] : []),
        targetFlag(remote),
        ...jurisdiction,
      ],
      { cwd, maxBuffer: MAX_BUFFER },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
