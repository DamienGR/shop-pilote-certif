import { readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { columnNames, referencingColumns } from '../../shopctl/src/backup/schema.mjs';
import {
  COLUMN_POLICY,
  EXTRA_LINKS,
  NOT_PERSONAL,
  unclassifiedColumns,
  unreachableTables,
} from '../../shopctl/src/privacy/map.mjs';
import {
  anonymizePlan,
  anonymizeScript,
  exportRows,
  isEmail,
  linkedPredicates,
  normalizeEmail,
  processorReferences,
  pseudonym,
  redactAddress,
  reviewables,
  rootPredicates,
  verifyAnonymization,
} from '../../shopctl/src/privacy/subject.mjs';
import { SEED, seededShop } from '../helpers/backup-shop.mjs';

const CORE = new URL('../../', import.meta.url).pathname;

vi.setConfig({ testTimeout: 120_000 });

/** The real schema, as SQLite itself describes it after the real migrations. */
function realSchema() {
  const db = new DatabaseSync(':memory:');
  const directory = join(CORE, 'migrations');
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(directory, file), 'utf8'));
  }
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const columns = {};
  const foreignKeys = {};
  const declared = {};
  for (const table of tables) {
    // `table_xinfo`, not `table_info`: the latter HIDES a virtual generated
    // column, and `orders.refunded_cents` has been one since migration 0025.
    // `SELECT *` returns it, so a reader of the schema that missed it would
    // miss a column every export carries.
    columns[table.name] = db.prepare(`PRAGMA table_xinfo("${table.name}")`).all().map((row) => row.name);
    foreignKeys[table.name] = db
      .prepare(`PRAGMA foreign_key_list("${table.name}")`)
      .all()
      .filter((row) => row.table === 'orders')
      .map((row) => row.from);
    declared[table.name] = table.sql ?? '';
  }
  db.close();
  return { columns, foreignKeys, declared };
}

/**
 * The address of a second buyer, seeded alongside the first.
 *
 * Isolation between two PEOPLE is the property no single-customer fixture can
 * state, and it is the one an erasure gets wrong in the way nobody notices: a
 * predicate that matches too widely erases somebody who never asked.
 */
const OTHER = 'voisine@example.fr';
const SUBJECT = 'Client@Example.FR';

/** A shop with two buyers, an order each, and everything that hangs off one. */
const PEOPLE = [
  ...SEED,
  `UPDATE orders SET email = '${SUBJECT}', ship_address = '{"name":"Jean Dupont","line1":"3 rue des Lilas","line2":null,"city":"Lyon","state":null,"postal":"69003","country":"FR"}', tracking_carrier = 'colissimo', tracking_number = '6A11122233344', label_url = 'https://labels.example/6A111.pdf', settlement_token = 'stl_secret', provider_payment_id = 'pi_1', vat_amount_cents = 817, vat_rate_bps = 2000 WHERE id = 1;`,
  `INSERT INTO order_guest_access (order_public_id, access_token) VALUES ('ord_0000000001', 'gat_secret_token');`,
  `INSERT INTO order_item_ids (public_id, order_public_id) VALUES ('oit_0000000001', 'ord_0000000001');`,
  `INSERT INTO order_notifications (order_id, kind, state, last_error) VALUES (1, 'confirmation', 'failed', 'Resend a refusé jean.dupont@example.fr');`,
  `INSERT INTO order_notifications (order_id, kind, state, attempts, last_error) VALUES (1, 'customer-receipt', 'pending', 2, 'Resend send failed (403)');`,
  `INSERT INTO order_notifications (order_id, kind, state, attempts, lease_expires_at) VALUES (1, 'order-shipped', 'processing', 1, datetime('now', '+5 minutes'));`,
  `INSERT INTO order_notifications (order_id, kind, state, attempts, sent_at) VALUES (1, 'owner-notification', 'sent', 1, datetime('now'));`,
  `INSERT INTO shipping_labels (order_id, status, shipment_id, provider, tracking_number, label_url, error, claim_token)
     VALUES (1, 'purchased', 'shp_1', 'sendcloud', '6A11122233344', 'https://labels.example/6A111.pdf', 'adresse refusée : 3 rue des Lilas', 'clm_1');`,
  `INSERT INTO refunds (public_id, order_id, kind, status, amount_cents, provider, reason, note, created_by, idempotency_key)
     VALUES ('ref_0000000001', 1, 'provider_api', 'succeeded', 1000, 'stripe', 'Colis endommagé', 'Rappelé Jean au 06…', 'admin@boutique.fr', 'idem_1');`,
  `INSERT INTO refund_sync_events (provider_event_id, provider, provider_payment_id, cumulative_refunded_cents, last_error)
     VALUES ('evt_1', 'stripe', 'pi_1', 1000, 'rapprochement impossible pour jean.dupont@example.fr');`,
  `INSERT INTO pending_payments (public_id, payment_hash, backend, bolt11, amount_sat, amount_total_cents, currency, email, items, ship_address, status)
     VALUES ('pnd_0000000001', 'hash1', 'lnbits', 'lnbc1', 1000, 4900, 'eur', '${SUBJECT}', '[]', '{"name":"Jean Dupont","city":"Lyon","country":"FR"}', 'pending');`,
  `INSERT INTO orders (provider_session_id, email, amount_total_cents, currency, status, public_id, ship_address)
     VALUES ('cs_test_2', '${OTHER}', 2500, 'eur', 'paid', 'ord_0000000002', '{"name":"Autre Cliente","city":"Nantes","country":"FR"}');`,
  `INSERT INTO order_guest_access (order_public_id, access_token) VALUES ('ord_0000000002', 'gat_other_token');`,
  `INSERT INTO order_notifications (order_id, kind, state) VALUES ((SELECT id FROM orders WHERE public_id = 'ord_0000000002'), 'customer-receipt', 'pending');`,
];

const orderRow = (target, id) => target.query(`SELECT * FROM orders WHERE public_id = '${id}'`)[0];

describe('la carte des données personnelles', () => {
  /**
   * The gate the map exists for. A schema says which columns a table has and
   * never which of them is a person, so the classification is written down —
   * and this is what stops it going quietly stale: a migration that adds
   * `orders.phone` fails here until somebody decides which side it is on.
   */
  it('a une opinion sur chaque colonne suspecte des quarante-trois migrations', () => {
    expect(unclassifiedColumns(realSchema().columns)).toEqual([]);
  });

  /** The other half is derived, and this proves the derivation reaches
   *  everything: a table keyed on an order with no foreign key and no declared
   *  link would be neither exported nor anonymised. */
  it('atteint chaque table qui porte une clé de commande', () => {
    const { columns, foreignKeys } = realSchema();
    expect(unreachableTables(columns, foreignKeys)).toEqual([]);
  });

  /**
   * Both derivations read the CREATE TABLE text rather than asking SQLite, to
   * spare a process per table on a remote database. That trade is only sound
   * while the reader agrees with SQLite — including on the columns `ALTER TABLE
   * ADD COLUMN` appended long after the table was written.
   */
  it('lit les mêmes colonnes et les mêmes clés que SQLite', () => {
    const { columns, foreignKeys, declared } = realSchema();
    for (const [table, sql] of Object.entries(declared)) {
      if (table.startsWith('sqlite_') || /^products_fts/.test(table)) continue;
      expect(columnNames(sql), table).toEqual(columns[table]);
      expect(referencingColumns(sql, 'orders').sort(), table).toEqual([...foreignKeys[table]].sort());
    }
  });

  /** Every classification carries the sentence that justifies it: the reason is
   *  what the next migration's reviewer is being asked to extend. */
  it('justifie chaque décision', () => {
    for (const [table, columns] of Object.entries(COLUMN_POLICY)) {
      for (const [column, entry] of Object.entries(columns)) {
        expect(entry.why, `${table}.${column}`).toMatch(/\S/);
      }
    }
    for (const [key, why] of Object.entries(NOT_PERSONAL)) expect(why, key).toMatch(/\S/);
    for (const link of EXTRA_LINKS) expect(link.via, link.table).toMatch(/\S/);
  });
});

describe('trouver une personne', () => {
  /**
   * Case is the one normalisation applied, and it is not cosmetic: the local
   * part is case-sensitive per RFC 5321 and no French mail provider honours
   * that, so a shop holds `Jean.Dupont@…` and `jean.dupont@…` for one person.
   */
  it('compare les adresses sans tenir compte de la casse', () => {
    expect(normalizeEmail('  Jean.Dupont@Example.FR ')).toBe('jean.dupont@example.fr');
    expect(rootPredicates('Jean@Example.FR')[0].where).toContain("'jean@example.fr'");
  });

  /** A value that is not an address would find zero rows, and that zero would
   *  be read as "we hold nothing about this person". */
  it('refuse ce qui n’est pas une adresse', () => {
    expect(isEmail('jean@example.fr')).toBe(true);
    expect(isEmail('jean@localhost')).toBe(false);
    expect(isEmail("' OR 1=1 --")).toBe(false);
    expect(isEmail('')).toBe(false);
  });

  it('cherche dans les paniers abandonnés comme dans les commandes', () => {
    expect(rootPredicates('a@b.fr').map((entry) => entry.table)).toEqual(['orders', 'pending_payments']);
  });

  /** The reach is the foreign keys plus the four tables that key on a public
   *  identifier. A buyer with no order reaches nothing, which is not an error. */
  it('descend des commandes vers ce qui y pend', () => {
    const linked = linkedPredicates(
      [{ id: 7, public_id: 'ord_7', provider_payment_id: 'pi_7' }],
      { order_items: ['order_id'], refunds: ['order_id'], products: [] },
    );
    expect(linked.map((entry) => entry.table)).toEqual([
      'order_guest_access',
      'order_item_ids',
      'order_items',
      'order_reference_aliases',
      'refund_sync_events',
      'refunds',
    ]);
    expect(linked.find((entry) => entry.table === 'order_items').where).toBe('"order_id" IN (7)');
    expect(linked.find((entry) => entry.table === 'refund_sync_events').where).toBe('"provider_payment_id" IN (\'pi_7\')');
  });

  it('ne cherche pas une valeur que personne ne porte', () => {
    expect(linkedPredicates([{ id: 7, public_id: 'ord_7', provider_payment_id: null }], {}).map((entry) => entry.table))
      .not.toContain('refund_sync_events');
  });
});

describe('le pseudonyme', () => {
  /**
   * Not a hash of the address. The set of e-mail addresses a shop's buyers
   * could have is small enough to enumerate — a merchant with a mailing list
   * hashes every entry and reads the anonymised orders straight back — so a
   * digest would be a pseudonymisation wearing an erasure's name.
   */
  it('est tiré au hasard, jamais dérivé de l’adresse', () => {
    const first = pseudonym();
    const second = pseudonym();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^anonymise-[0-9a-f]{32}@exemple\.invalid$/);
  });

  /** `.invalid` is reserved by RFC 2606: a pseudonym can never collide with a
   *  real address, and a mail sent to one can never arrive. */
  it('ne peut pas être délivré', () => {
    expect(pseudonym().endsWith('@exemple.invalid')).toBe(true);
  });
});

describe('l’adresse réduite', () => {
  /** The country stays because the VAT rate on a paid order is justified by
   *  where it shipped to; a country alone identifies nobody in a shop that
   *  sells to a whole country. */
  it('ne garde que le pays', () => {
    expect(redactAddress('{"name":"Jean","line1":"3 rue des Lilas","city":"Lyon","postal":"69003","country":"FR"}'))
      .toBe('{"country":"FR"}');
  });

  it('laisse tomber un instantané illisible plutôt que de le deviner', () => {
    expect(redactAddress('{pas du json')).toBeNull();
    expect(redactAddress('[]')).toBeNull();
    expect(redactAddress(null)).toBeNull();
  });

  it('rend NULL une adresse dont il ne reste rien', () => {
    expect(redactAddress('{"name":"Jean","city":"Lyon"}')).toBeNull();
  });
});

describe('les instructions', () => {
  const records = {
    orders: [{ id: 1, email: 'a@b.fr', ship_address: '{"name":"Jean","country":"FR"}', tracking_number: 'X', label_url: 'u' }],
    order_guest_access: [{ order_public_id: 'ord_1', access_token: 't' }],
    order_notifications: [{ order_id: 1, kind: 'confirmation', last_error: 'a@b.fr refusé' }],
  };
  const predicates = [
    { table: 'orders', where: '"id" IN (1)' },
    { table: 'order_guest_access', where: '"order_public_id" IN (\'ord_1\')' },
    { table: 'order_notifications', where: '"order_id" IN (1)' },
  ];

  it('réécrit ligne par ligne ce qui dépend de la ligne, et en une fois ce qui n’en dépend pas', () => {
    const statements = anonymizeScript(predicates, records, () => 'p@exemple.invalid');
    expect(statements.some((statement) => statement.startsWith('UPDATE "orders" SET') && statement.includes('"id" = 1'))).toBe(true);
    expect(statements).toContain(
      'UPDATE "order_notifications" SET "last_error" = NULL, ' +
        '"state" = CASE WHEN state IN (\'pending\', \'processing\') THEN \'skipped\' ELSE "state" END, ' +
        '"lease_expires_at" = CASE WHEN state IN (\'pending\', \'processing\') THEN NULL ELSE "lease_expires_at" END ' +
        'WHERE "order_id" IN (1);',
    );
  });

  /** A token whose order has been anonymised is still a working key to that
   *  order's page: the ROW goes, not the value. */
  it('supprime les identifiants d’accès au lieu de les vider', () => {
    const statements = anonymizeScript(predicates, records, () => 'p@exemple.invalid');
    expect(statements).toContain('DELETE FROM "order_guest_access" WHERE "order_public_id" IN (\'ord_1\');');
  });

  /** Deletes last: a partial run leaves a table done or untouched, never a
   *  revoked token whose order still names its owner. */
  it('réécrit avant de supprimer', () => {
    const statements = anonymizeScript(predicates, records, () => 'p@exemple.invalid');
    expect(statements.findIndex((statement) => statement.startsWith('DELETE'))).toBe(statements.length - 1);
  });

  /** The same quoting the backup and the catalogue use — deliberately the same
   *  rule rather than a third opinion about it. */
  it('échappe ce qu’une adresse peut contenir', () => {
    const hostile = { orders: [{ id: 1, email: 'x', ship_address: '{"country":"O\'Brien; DROP"}', tracking_number: null, label_url: null }] };
    const [statement] = anonymizeScript([{ table: 'orders', where: '"id" IN (1)' }], hostile, () => 'p@exemple.invalid');
    expect(statement).toContain("'{\"country\":\"O''Brien; DROP\"}'");
  });

  it('ne dit rien d’une table dont aucune ligne n’est là', () => {
    expect(anonymizeScript(predicates, { orders: [] }, () => 'p@exemple.invalid')).toEqual([]);
    expect(anonymizePlan(predicates, { orders: [] })).toEqual([]);
  });
});

describe('ce qu’un export dit et ce qu’il retient', () => {
  /** An export is a DISCLOSURE. The identity of the employee who reviewed a
   *  refund answers a question the requester did not ask, about a person who
   *  did not ask either — and a settlement token is a live credential. */
  it('retient les jetons et les identités d’opérateurs, et les nomme', () => {
    const { rows, withheld } = exportRows('orders', [{ id: 1, email: 'a@b.fr', settlement_token: 'stl', refund_reviewed_by: 'admin' }]);
    expect(rows[0]).toEqual({ id: 1, email: 'a@b.fr' });
    expect(withheld.map((entry) => entry.column)).toEqual(['refund_reviewed_by', 'settlement_token']);
    expect(withheld[0].why).toMatch(/\S/);
  });

  /** Erasing the Stripe reference would take away the only handle the merchant
   *  has for asking Stripe to erase the same person. */
  it('nomme les références conservées chez un sous-traitant', () => {
    const references = processorReferences({ orders: [{ provider_payment_id: 'pi_1', provider_session_id: null }] });
    expect(references.map((entry) => entry.column)).toEqual(['provider_payment_id']);
    expect(references[0].values).toEqual(['pi_1']);
  });

  /** A "here is the personal data we could not classify" line that quotes the
   *  personal data has defeated itself. */
  it('signale les textes libres sans les recopier', () => {
    const flagged = reviewables({ refunds: [{ public_id: 'ref_1', note: 'Rappelé Jean au 06…', reason: null }] });
    expect(flagged).toEqual([
      { table: 'refunds', column: 'note', rows: 1, at: ['ref_1'], why: expect.stringMatching(/\S/) },
    ]);
    expect(JSON.stringify(flagged)).not.toContain('Rappelé');
  });
});

describe('la vérification d’après-coup', () => {
  it('accepte une ligne réécrite', () => {
    expect(verifyAnonymization({
      orders: [{ email: 'anonymise-ab@exemple.invalid', ship_address: '{"country":"FR"}', tracking_number: null, label_url: null }],
      order_guest_access: [],
    })).toEqual([]);
  });

  it('refuse une adresse qui a survécu', () => {
    const failures = verifyAnonymization({ orders: [{ email: 'jean@example.fr', tracking_number: null }] });
    expect(failures.map((entry) => entry.column)).toEqual(['email']);
  });

  it('refuse un jeton d’accès qui a survécu', () => {
    expect(verifyAnonymization({ order_guest_access: [{ order_public_id: 'ord_1' }] })[0])
      .toMatchObject({ table: 'order_guest_access', expected: 'aucune ligne' });
  });
});

describe('la commande, contre une vraie base', () => {
  /** Built once: `provision` applies the forty-three migrations and the seed
   *  goes in through the same wrangler the command will use. */
  const target = seededShop({ seed: PEOPLE, object: false });

  it('refuse une adresse mal formée avant de toucher au compte', () => {
    const { status, stderr } = target.run(['privacy', 'export', '--env', 'staging', '--email', 'pas-une-adresse']);
    expect(status).toBe(EXIT_CODES.input);
    expect(stderr).toContain("n'est pas une adresse e-mail");
  });

  it('répond « rien » pour une adresse inconnue, et le dit sans échouer', () => {
    const { report, status } = target.json(['privacy', 'export', '--env', 'staging', '--email', 'inconnu@example.fr']);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.found).toBe(false);
    expect(report.file).toBeNull();
  });

  it('exporte tout ce qui pend à la commande, sans les jetons', () => {
    const file = join(target.root, 'export.json');
    const { report, status } = target.json(['privacy', 'export', '--env', 'staging', '--email', 'client@example.fr', '--out', file]);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.found).toBe(true);

    const document = JSON.parse(readFileSync(file, 'utf8'));
    // The address was seeded in mixed case; the export finds it anyway.
    expect(document.subject).toBe('client@example.fr');
    expect(Object.keys(document.tables).sort()).toEqual([
      'order_guest_access',
      'order_item_ids',
      'order_items',
      'order_notifications',
      'orders',
      'pending_payments',
      'refund_sync_events',
      'refunds',
      'shipping_labels',
    ]);
    expect(document.tables.orders.rows[0].email).toBe('Client@Example.FR');
    expect(document.tables.orders.rows[0].ship_address).toContain('rue des Lilas');
    // The other buyer's order is not in it, and neither is any credential.
    const text = JSON.stringify(document);
    expect(text).not.toContain('voisine@example.fr');
    expect(text).not.toContain('stl_secret');
    expect(text).not.toContain('gat_secret_token');
    expect(text).not.toContain('admin@boutique.fr');
  });

  it('écrit un fichier que seul son propriétaire peut lire', () => {
    const file = join(target.root, 'export-mode.json');
    target.json(['privacy', 'export', '--env', 'staging', '--email', 'client@example.fr', '--out', file]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('nomme la référence Stripe qu’il conserve', () => {
    const file = join(target.root, 'export-stripe.json');
    const { report } = target.json(['privacy', 'export', '--env', 'staging', '--email', 'client@example.fr', '--out', file]);
    expect(report.processors.flatMap((entry) => entry.values)).toContain('pi_1');
  });

  /** Irreversible, in every environment: a staging database is usually a
   *  restored copy of the production one, holding the same person. */
  it('refuse d’anonymiser sans le slug saisi', () => {
    const { status, stderr } = target.run(['privacy', 'anonymize', '--env', 'staging', '--email', 'client@example.fr']);
    expect(status).toBe(EXIT_CODES.input);
    expect(stderr).toContain('--confirm atelier-test');
    expect(orderRow(target, 'ord_0000000001').email).toBe('Client@Example.FR');
  });

  it('dit ce qu’il ferait sans rien écrire', () => {
    const { report, status } = target.json([
      'privacy', 'anonymize', '--env', 'staging', '--email', 'client@example.fr', '--dry-run',
    ]);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.dryRun).toBe(true);
    expect(report.plan.find((entry) => entry.table === 'orders').columns).toEqual(['email', 'ship_address', 'tracking_number', 'label_url']);
    expect(report.plan.find((entry) => entry.table === 'order_guest_access').action).toBe('supprimée');
    expect(report.plan.find((entry) => entry.table === 'order_notifications').columns).toEqual(['last_error', 'state', 'lease_expires_at']);
    expect(orderRow(target, 'ord_0000000001').email).toBe('Client@Example.FR');
  });

  it('anonymise la personne et laisse la pièce comptable', () => {
    const before = orderRow(target, 'ord_0000000001');
    const { report, status } = target.json([
      'privacy', 'anonymize', '--env', 'staging', '--email', 'client@example.fr', '--confirm', 'atelier-test',
    ]);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.found).toBe(true);

    const after = orderRow(target, 'ord_0000000001');
    expect(after.email).toMatch(/@exemple\.invalid$/);
    expect(after.ship_address).toBe('{"country":"FR"}');
    expect(after.tracking_number).toBeNull();
    expect(after.label_url).toBeNull();

    // What the Code de commerce keeps for ten years, kept.
    expect(after.amount_total_cents).toBe(before.amount_total_cents);
    expect(after.vat_amount_cents).toBe(before.vat_amount_cents);
    expect(after.created_at).toBe(before.created_at);
    expect(after.public_id).toBe(before.public_id);
    expect(after.status).toBe(before.status);
    // And the pointer that lets the merchant ask Stripe for the same erasure.
    expect(after.provider_payment_id).toBe('pi_1');
  });

  it('révoque l’accès invité et efface ce que les journaux avaient recopié', () => {
    expect(target.query("SELECT * FROM order_guest_access WHERE order_public_id = 'ord_0000000001'")).toEqual([]);
    expect(target.query('SELECT last_error FROM order_notifications WHERE order_id = 1')[0].last_error).toBeNull();
    expect(target.query('SELECT last_error FROM refund_sync_events')[0].last_error).toBeNull();
    const label = target.query('SELECT * FROM shipping_labels WHERE order_id = 1')[0];
    expect(label.tracking_number).toBeNull();
    expect(label.label_url).toBeNull();
    expect(label.error).toBeNull();
    // The label row itself stays: it carries what the shop paid for postage.
    expect(label.status).toBe('purchased');
  });

  // Certification step 8: a receipt Resend had refused was still pending when
  // its buyer was erased, and the cron went on retrying it, to the pseudonym,
  // until its fifth attempt.
  it('clôt ce qui partirait encore vers la personne, et rien de ce qui est parti', () => {
    const rows = target.query('SELECT kind, state, lease_expires_at FROM order_notifications WHERE order_id = 1 ORDER BY kind');
    expect(rows).toEqual([
      { kind: 'confirmation', state: 'failed', lease_expires_at: null },
      { kind: 'customer-receipt', state: 'skipped', lease_expires_at: null },
      { kind: 'order-shipped', state: 'skipped', lease_expires_at: null },
      { kind: 'owner-notification', state: 'sent', lease_expires_at: null },
    ]);
    const other = target.query("SELECT state FROM order_notifications WHERE order_id = (SELECT id FROM orders WHERE public_id = 'ord_0000000002')");
    expect(other).toEqual([{ state: 'pending' }]);
  });

  it('emporte le panier abandonné de la même personne', () => {
    const pending = target.query("SELECT * FROM pending_payments WHERE public_id = 'pnd_0000000001'")[0];
    expect(pending.email).toMatch(/@exemple\.invalid$/);
    expect(pending.ship_address).toBe('{"country":"FR"}');
  });

  /** The defect a too-wide predicate produces, and the one nobody notices
   *  until a second person complains their order lost its address. */
  it('ne touche pas à la commande de quelqu’un d’autre', () => {
    const other = orderRow(target, 'ord_0000000002');
    expect(other.email).toBe(OTHER);
    expect(other.ship_address).toContain('Nantes');
    expect(target.query("SELECT * FROM order_guest_access WHERE order_public_id = 'ord_0000000002'")).toHaveLength(1);
  });

  /** Each row draws its own pseudonym: one token across somebody's orders keeps
   *  them grouped, and a group of orders is a profile even when nobody can name
   *  it. */
  it('tire un pseudonyme par ligne', () => {
    const order = orderRow(target, 'ord_0000000001').email;
    const pending = target.query("SELECT email FROM pending_payments WHERE public_id = 'pnd_0000000001'")[0].email;
    expect(order).not.toBe(pending);
  });

  it('laisse les textes libres et dit où ils sont', () => {
    const refund = target.query("SELECT * FROM refunds WHERE public_id = 'ref_0000000001'")[0];
    expect(refund.note).toBe('Rappelé Jean au 06…');
    const file = join(target.root, 'export-after.json');
    const { report } = target.json(['privacy', 'export', '--env', 'staging', '--email', 'client@example.fr', '--out', file]);
    expect(report.found).toBe(false);
  });

  /** Run twice, the second finds nothing: the address it looked for is gone. */
  it('est sans effet la seconde fois', () => {
    const { report, status } = target.json([
      'privacy', 'anonymize', '--env', 'staging', '--email', 'client@example.fr', '--confirm', 'atelier-test',
    ]);
    expect(status).toBe(EXIT_CODES.ok);
    expect(report.found).toBe(false);
  });
});
