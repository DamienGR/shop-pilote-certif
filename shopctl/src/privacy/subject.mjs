/**
 * One buyer's rows: how they are found, what an export says, what an
 * anonymisation writes.
 *
 * Everything here is pure, for the same reason the backup's half is: it lets
 * `--dry-run` be the SAME code path as the real run rather than a second
 * implementation that agrees with it on a good day, and it lets the suite apply
 * the real statements to the real forty-three migrations.
 *
 * Two ideas carry the file.
 *
 * **A predicate, not a list of ids.** Every table is reached by an expression —
 * `lower(email) = …` at the root, `order_id IN (…)` below it — and the SAME
 * expression selects for the export and updates for the anonymisation. A
 * command that read rows one way and wrote them another would have two answers
 * to "whose data is this", and the one that writes is the one that cannot be
 * taken back.
 *
 * **The rewrite is verified by re-asking the question.** After the script runs,
 * the root predicates are evaluated again and must return nothing. That catches
 * the case no amount of care inside this file can: an order placed by the same
 * person between the read and the write.
 */
import { randomBytes } from 'node:crypto';
import { identifier, literal } from '../backup/dump.mjs';
import {
  ADDRESS_KEPT,
  CLOSED_ON_ERASURE,
  COLUMN_POLICY,
  EXTRA_LINKS,
  ORDER_TABLE,
  REWRITTEN_ACTIONS,
  SUBJECT_TABLES,
  WITHHELD_ACTIONS,
} from './map.mjs';

/** The document format an export declares. Bumped when its shape changes. */
export const EXPORT_FORMAT = 'minshop.privacy.export/1';

/**
 * The address an anonymised order carries instead of a person's.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so a pseudonym can
 * never collide with a real address and a mail sent to one can never arrive.
 */
export const PSEUDONYM_DOMAIN = 'exemple.invalid';

/**
 * An address, normalised for comparison.
 *
 * Case only, and only on the whole string. The local part of an address is
 * case-SENSITIVE per RFC 5321 and every mail provider in France ignores that,
 * which is precisely why a shop holds `Jean.Dupont@…` and `jean.dupont@…` for
 * one person — and why an erasure that matched exactly would leave half of them
 * behind. Nothing else is normalised: stripping the `+tag` of a gmail address
 * would silently erase orders the requester never mentioned.
 */
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Shaped like an address, checked before it is put in a WHERE clause. */
export function isEmail(value) {
  const email = normalizeEmail(value);
  return email.length > 0 && email.length <= 320 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

/**
 * A pseudonym, drawn at random and never derived from the address.
 *
 * A hash of an e-mail is not anonymous. The set of addresses a shop's buyers
 * could have is small enough to enumerate — a merchant with a mailing list can
 * hash every entry and read the anonymised orders straight back — so a digest
 * would be a pseudonymisation dressed as an erasure. 128 bits from the system
 * CSPRNG, and nothing anywhere keeps the mapping: this is the one value in the
 * pipeline that is meant to be unrecoverable.
 *
 * One per ROW, not one per person: a single token across somebody's orders
 * keeps them grouped, and a group of orders is a profile even when nobody can
 * name it.
 */
export function pseudonym(bytes = randomBytes(16)) {
  return `anonymise-${Buffer.from(bytes).toString('hex')}@${PSEUDONYM_DOMAIN}`;
}

/**
 * What an anonymised address snapshot keeps.
 *
 * A snapshot that does not parse is dropped whole rather than repaired: it came
 * from a payment provider's payload and this command is not the place to guess
 * what a malformed one meant.
 */
export function redactAddress(value, keep = ADDRESS_KEPT) {
  if (value === null || value === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const kept = {};
  for (const field of keep) {
    if (parsed[field] !== null && parsed[field] !== undefined && parsed[field] !== '') kept[field] = parsed[field];
  }
  return Object.keys(kept).length === 0 ? null : JSON.stringify(kept);
}

/**
 * The tables a buyer is named in, and the expression that finds them.
 *
 * @param {string} email
 * @returns {Array<{ table: string, column: string, where: string }>}
 */
export function rootPredicates(email) {
  const value = literal(normalizeEmail(email));
  return Object.entries(SUBJECT_TABLES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, column]) => ({
      table,
      column,
      where: `${identifier(column)} IS NOT NULL AND lower(${identifier(column)}) = ${value}`,
    }));
}

/** `col IN (…)`, or null when there is nothing to look for. */
function inClause(column, values) {
  const distinct = [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
  if (distinct.length === 0) return null;
  return `${identifier(column)} IN (${distinct.map(literal).join(', ')})`;
}

/**
 * The tables that hang off this buyer's orders, and how each is reached.
 *
 * The foreign keys do most of it: a table that points at `orders` holds rows
 * about whoever placed them. `EXTRA_LINKS` covers the four that key on a public
 * identifier or on the payment id instead — and `unreachableTables()` is what
 * stops that list from going quietly stale.
 *
 * @param {object[]} orders the buyer's order rows, already read
 * @param {Record<string, string[]>} foreignKeys table → columns pointing at `orders`
 */
export function linkedPredicates(orders, foreignKeys) {
  const column = (name) => orders.map((row) => row[name]);
  const predicates = [];

  for (const [table, columns] of Object.entries(foreignKeys)) {
    if (table === ORDER_TABLE) continue;
    for (const key of columns) {
      const where = inClause(key, column('id'));
      if (where) predicates.push({ table, column: key, where });
    }
  }
  for (const link of EXTRA_LINKS) {
    const where = inClause(link.column, column(link.via));
    if (where) predicates.push({ table: link.table, column: link.column, where });
  }
  return predicates.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}

/** The SELECT one predicate turns into. */
export function selectFor({ table, where }) {
  return `SELECT * FROM ${identifier(table)} WHERE ${where};`;
}

/**
 * One table's rows, as they go into an export.
 *
 * Withheld columns are removed from every row and NAMED once, at the table
 * level: an export that quietly dropped a column would be indistinguishable
 * from an export of a shop that never had one, and the difference is exactly
 * what a merchant has to be able to explain.
 */
export function exportRows(table, rows) {
  const policy = COLUMN_POLICY[table] ?? {};
  const withheld = Object.entries(policy)
    .filter(([, entry]) => WITHHELD_ACTIONS.has(entry.action))
    .map(([column, entry]) => ({ column, why: entry.why }))
    .sort((a, b) => a.column.localeCompare(b.column));
  const drop = new Set(withheld.map((entry) => entry.column));
  const kept = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !drop.has(column))));
  return { rows: kept, withheld };
}

/**
 * The identifiers this buyer's data also exists under at a processor.
 *
 * Named rather than erased. Stripe holds the same order under its own id, and
 * a merchant answering an erasure request has to ask them too; a command that
 * deleted the reference would take away the only handle for doing so and would
 * call that privacy.
 */
export function processorReferences(records) {
  const references = [];
  for (const [table, rows] of Object.entries(records)) {
    for (const [column, entry] of Object.entries(COLUMN_POLICY[table] ?? {})) {
      if (entry.action !== 'processor') continue;
      const values = [...new Set(rows.map((row) => row[column]).filter((value) => typeof value === 'string' && value !== ''))];
      if (values.length > 0) references.push({ table, column, values: values.sort(), why: entry.why });
    }
  }
  return references.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}

/**
 * The free text an anonymisation leaves standing, and where a human will find it.
 *
 * Reported with the row's own public identifier rather than its contents: the
 * report is printed on a terminal and copied into tickets, and a "here is the
 * personal data we could not classify" line that quotes the personal data has
 * defeated itself.
 */
export function reviewables(records) {
  const flagged = [];
  for (const [table, rows] of Object.entries(records)) {
    for (const [column, entry] of Object.entries(COLUMN_POLICY[table] ?? {})) {
      if (entry.action !== 'review') continue;
      const rowsWithText = rows.filter((row) => typeof row[column] === 'string' && row[column].trim() !== '');
      if (rowsWithText.length === 0) continue;
      flagged.push({
        table,
        column,
        rows: rowsWithText.length,
        at: rowsWithText.map((row) => row.public_id ?? row.id ?? null).filter((value) => value !== null),
        why: entry.why,
      });
    }
  }
  return flagged.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}

/**
 * The statements that rewrite one buyer out of the database.
 *
 * UPDATEs before DELETEs, and one statement per table: a partial run then
 * leaves a table either done or untouched, never half-rewritten, which is the
 * state an operator can act on. Values are inlined by `literal()` — the same
 * quoting the backup and the catalogue use, deliberately the same rule rather
 * than a third opinion about it.
 *
 * @param {Array<{ table: string, where: string }>} predicates
 * @param {Record<string, object[]>} records the rows those predicates selected
 * @param {() => string} mint a pseudonym generator, injected so the suite can pin it
 */
export function anonymizeScript(predicates, records, mint = pseudonym) {
  const updates = [];
  const deletes = [];

  for (const predicate of predicates) {
    const { table, where } = predicate;
    const policy = COLUMN_POLICY[table] ?? {};
    const rows = records[table] ?? [];
    if (rows.length === 0) continue;

    if (Object.values(policy).some((entry) => entry.action === 'revoke')) {
      deletes.push(`DELETE FROM ${identifier(table)} WHERE ${where};`);
      continue;
    }

    const columns = Object.entries(policy).filter(([, entry]) => REWRITTEN_ACTIONS.has(entry.action));
    if (columns.length === 0) continue;

    // A pseudonym is per ROW and an address redaction depends on the row's own
    // value, so a table with either is rewritten row by row. A table whose
    // rewrite is the same everywhere — a NULL — is one statement.
    const perRow = columns.some(([, entry]) => entry.action === 'subject' || entry.action === 'address');
    if (!perRow) {
      // Closed in the same statement as the erasure: a run interrupted between
      // two would leave a message queued for an address that no longer exists.
      // SQLite reads every CASE against the row as it was before the UPDATE.
      const closing = CLOSED_ON_ERASURE[table];
      const assignments = [
        ...columns.map(([column]) => `${identifier(column)} = NULL`),
        ...Object.entries(closing?.set ?? {}).map(
          ([column, value]) => `${identifier(column)} = CASE WHEN ${closing.open} THEN ${value} ELSE ${identifier(column)} END`,
        ),
      ];
      updates.push(`UPDATE ${identifier(table)} SET ${assignments.join(', ')} WHERE ${where};`);
      continue;
    }

    const key = rows[0].id !== undefined ? 'id' : Object.keys(rows[0])[0];
    for (const row of rows) {
      const assignments = columns.map(([column, entry]) => {
        if (entry.action === 'subject') return `${identifier(column)} = ${literal(mint())}`;
        if (entry.action === 'address') return `${identifier(column)} = ${literal(redactAddress(row[column]))}`;
        return `${identifier(column)} = NULL`;
      });
      updates.push(`UPDATE ${identifier(table)} SET ${assignments.join(', ')} WHERE ${identifier(key)} = ${literal(row[key])};`);
    }
  }
  return [...updates, ...deletes];
}

/**
 * What the anonymisation is about to do, table by table, before it does it.
 *
 * The same shape whether `--dry-run` was passed or not, because it is computed
 * from the same predicates and the same rows. A dry run that summarised the
 * work differently from the real one would be a rehearsal of a different play.
 */
export function anonymizePlan(predicates, records) {
  return predicates
    .filter((predicate) => (records[predicate.table] ?? []).length > 0)
    .map(({ table }) => {
      const policy = COLUMN_POLICY[table] ?? {};
      const revoked = Object.entries(policy).filter(([, entry]) => entry.action === 'revoke');
      return {
        table,
        rows: records[table].length,
        action: revoked.length > 0 ? 'supprimée' : 'réécrite',
        columns: revoked.length > 0
          ? revoked.map(([column]) => column)
          : [
              ...Object.entries(policy).filter(([, entry]) => REWRITTEN_ACTIONS.has(entry.action)).map(([column]) => column),
              ...Object.keys(CLOSED_ON_ERASURE[table]?.set ?? {}),
            ],
      };
    })
    .filter((entry) => entry.columns.length > 0);
}

/**
 * What the database must look like once the script has run.
 *
 * Re-read through the SAME predicates and checked column by column, because
 * "the statements were accepted" is not the claim being made. The claim is that
 * this person is no longer in there, and the only way to make it is to ask
 * again. `restore` ends the same way and for the same reason (ADR 0005: a
 * restore cannot be "almost" tested); an erasure cannot be either, and it is
 * the one operation in this CLI that nothing can undo.
 *
 * @param {Record<string, object[]>} records the rows the predicates return NOW
 * @returns {Array<{ table: string, column: string, rows: number, expected: string }>}
 */
export function verifyAnonymization(records) {
  const failures = [];
  for (const [table, rows] of Object.entries(records)) {
    const policy = COLUMN_POLICY[table] ?? {};
    if (Object.values(policy).some((entry) => entry.action === 'revoke')) {
      if (rows.length > 0) failures.push({ table, column: '*', rows: rows.length, expected: 'aucune ligne' });
      continue;
    }
    for (const [column, entry] of Object.entries(policy)) {
      if (!REWRITTEN_ACTIONS.has(entry.action)) continue;
      const offending = rows.filter((row) => {
        const value = row[column];
        if (value === null || value === undefined) return false;
        if (entry.action === 'erase') return true;
        if (entry.action === 'subject') return !String(value).endsWith(`@${PSEUDONYM_DOMAIN}`);
        return redactAddress(value) !== (typeof value === 'string' ? value : String(value));
      });
      if (offending.length > 0) {
        failures.push({
          table,
          column,
          rows: offending.length,
          expected: entry.action === 'erase' ? 'NULL' : entry.action === 'subject' ? `une adresse @${PSEUDONYM_DOMAIN}` : "l'adresse réduite",
        });
      }
    }
  }
  return failures.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}
