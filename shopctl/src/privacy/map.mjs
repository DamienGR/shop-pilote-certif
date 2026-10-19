/**
 * What of a shop's data belongs to one buyer, and what happens to it.
 *
 * The backup derives its table list from `sqlite_master` and writes nothing
 * down, because a written list stops being complete at the first migration
 * nobody updated it for. That derivation is not available here: no schema says
 * which column holds a person. `orders.email` and `products.name` are both
 * `TEXT NOT NULL` and only one of them is somebody.
 *
 * So this file DECLARES, and the declaration is GATED. Every column whose name
 * looks like it could carry a person — the pattern below — must appear either
 * in `COLUMN_POLICY` with an action, or in `NOT_PERSONAL` with a reason. A
 * migration that adds `orders.phone` tomorrow fails `npm test` until somebody
 * decides which of the two it is. The heuristic cannot make the decision; what
 * it can do is refuse to let the decision go unmade, which is the property the
 * derivation was bought for in the first place.
 *
 * The other half — WHICH ROWS are this person's — is derived, and fully. A
 * table linked to a buyer is one that points at `orders`, and the foreign keys
 * say which those are. The three tables that key on `orders.public_id` instead
 * of its rowid, and the one that keys on the payment id, carry no foreign key
 * for a reader to follow, so they are declared in `EXTRA_LINKS` — and that list
 * is gated too: a table with an `order_id`, an `order_public_id` or a
 * `provider_payment_id` column and neither a foreign key nor an entry here
 * fails the same test.
 */

/**
 * The tables that name a person, and the column that does the naming.
 *
 * There is no customers table: checkout is guest-only (plan §2.1), so a buyer
 * IS an e-mail address and nothing else. `pending_payments` is in the list for
 * the reason it is easy to forget — a cart that never became an order still
 * holds the address it was going to be shipped to.
 */
export const SUBJECT_TABLES = { orders: 'email', pending_payments: 'email' };

/** The table whose rows the linked tables hang off. */
export const ORDER_TABLE = 'orders';

/**
 * What each command does to one column.
 *
 *  - `subject`   the e-mail itself. Replaced by a pseudonym drawn at random —
 *                see `pseudonym()` for why it is not a hash of the address;
 *  - `erase`     set to NULL. The value is the person's and nothing downstream
 *                needs it once they are gone;
 *  - `address`   a JSON address snapshot. Reduced to the fields an accountant
 *                needs, never dropped: the VAT rate on a paid order is
 *                justified by the country it shipped to;
 *  - `revoke`    a credential that opens the order. The ROW goes, not the
 *                value: a guest access token whose order has been anonymised
 *                is still a working key to that order's page. Never exported —
 *                an export travels by e-mail, and this one is a password;
 *  - `processor` an identifier at Stripe. Kept — it is what reconciles a
 *                refund with a bank line — and named in the report, because
 *                erasing it here would erase the only handle the merchant has
 *                to ask Stripe for the same erasure;
 *  - `review`    free text somebody typed. Exported, kept, and reported: a map
 *                can classify a column, it cannot read a sentence, and a
 *                command that silently emptied the justification of a refund
 *                would be destroying accounting records to protect privacy;
 *  - `internal`  not the buyer's, and not theirs to receive. An operator's name
 *                on a refund, a claim token behind a settlement. An export is a
 *                DISCLOSURE: handing somebody the identity of the employee who
 *                reviewed their refund answers a question they did not ask,
 *                about a person who did not ask either.
 *
 * @type {Record<string, Record<string, { action: string, why: string }>>}
 */
export const COLUMN_POLICY = {
  orders: {
    email: { action: 'subject', why: "L'identité du client dans une boutique en commande invitée." },
    ship_address: { action: 'address', why: 'Nom, rue, ville et code postal du destinataire.' },
    tracking_number: { action: 'erase', why: "Désigne chez le transporteur un colis et l'adresse qui l'a reçu." },
    label_url: { action: 'erase', why: "L'étiquette porte l'adresse de livraison en toutes lettres." },
    provider_session_id: { action: 'processor', why: 'La session Stripe qui détient les mêmes données chez le sous-traitant.' },
    provider_payment_id: { action: 'processor', why: 'Le paiement Stripe : la ligne bancaire se rapproche par lui.' },
    refund_review_reason: { action: 'review', why: "Texte libre saisi par l'exploitant au moment d'un remboursement." },
    refund_reviewed_by: { action: 'internal', why: "L'identité d'un opérateur de la boutique, pas celle du client." },
    settlement_token: { action: 'internal', why: "Une revendication d'idempotence du règlement, jamais communiquée au client." },
  },
  pending_payments: {
    email: { action: 'subject', why: "L'adresse saisie à un paiement qui n'a jamais abouti." },
    ship_address: { action: 'address', why: "L'adresse d'un panier abandonné est une adresse quand même." },
  },
  order_guest_access: {
    access_token: { action: 'revoke', why: "Ouvre la page d'une commande sans authentification." },
  },
  order_notifications: {
    last_error: { action: 'erase', why: "Le refus d'un fournisseur d'e-mail cite le destinataire." },
  },
  refund_sync_events: {
    last_error: { action: 'erase', why: "Une erreur de rapprochement peut citer le payeur." },
    provider_payment_id: { action: 'processor', why: 'Le paiement Stripe auquel cet événement se rapporte.' },
  },
  refunds: {
    reason: { action: 'review', why: 'Motif saisi par un humain ; il justifie un mouvement comptable.' },
    note: { action: 'review', why: 'Commentaire interne ; il peut nommer le client comme il peut ne rien contenir.' },
    created_by: { action: 'internal', why: "L'identité d'un opérateur de la boutique." },
  },
  shipping_labels: {
    tracking_number: { action: 'erase', why: 'Même raison que sur la commande.' },
    label_url: { action: 'erase', why: "L'étiquette porte l'adresse." },
    error: { action: 'erase', why: "Le refus d'un transporteur recopie l'adresse qu'il a refusée." },
    claim_token: { action: 'internal', why: "Une revendication d'idempotence d'achat d'étiquette." },
  },
  shipping_label_attempts: {
    tracking_number: { action: 'erase', why: 'Même raison que sur la commande.' },
    label_url: { action: 'erase', why: "L'étiquette porte l'adresse." },
    error: { action: 'erase', why: "Le refus d'un transporteur recopie l'adresse qu'il a refusée." },
    claim_token: { action: 'internal', why: "Une revendication d'idempotence d'achat d'étiquette." },
  },
};

/**
 * Columns the pattern catches and that need no policy at all.
 *
 * Written out rather than filtered by a smarter pattern: the reason is the
 * point. "It is the catalogue" and "it is a claim token" are different
 * arguments, and a reviewer of the next migration needs to see which one they
 * are being asked to extend.
 *
 * @type {Record<string, string>}
 */
export const NOT_PERSONAL = {
  'admin_login_attempts.client_key':
    "Empreinte HMAC du réseau de qui essaie le mot de passe de l'administration, jamais l'adresse ; " +
    "effacée quinze minutes après, elle ne se rattache à aucun acheteur.",
  'categories.name': 'Catalogue.',
  'media.original_name': "Le nom du fichier que le marchand a téléversé, pas celui d'un client.",
  'menu_items.label': 'Navigation de la boutique.',
  'order_items.name': "Le libellé du produit, figé à la commande. Il décrit un article, pas un acheteur.",
  'order_items.file_name': 'Le fichier livrable du produit ; il est le même pour tous les acheteurs.',
  'orders.tracking_carrier': 'Le nom du transporteur.',
  'orders.shipping_label': "Le libellé du tarif d'expédition retenu (« Colissimo »), pas une étiquette.",
  'pages.body_markdown': 'Contenu éditorial du marchand.',
  'pending_payments.shipping_label': 'Même libellé de tarif que sur la commande.',
  'product_extras.label': 'Catalogue.',
  'product_variants.label': 'Catalogue.',
  'products.name': 'Catalogue.',
  'products.variant_label': 'Catalogue.',
  'products.file_name': 'Catalogue.',
  'sweep_cursors.name':
    "Le nom d'un balayage du socle (« guest-access-hide »). Le curseur porte au plus un identifiant " +
    "public de commande, que la commande anonymisée garde aussi : il ne nomme personne.",
};

/**
 * Tables that hold a buyer's rows without a foreign key to follow.
 *
 * `via` names the column of `orders` whose value they carry. All four exist for
 * the same reason: they were written to survive the order row being read by a
 * public page, so they key on the public identifier rather than the rowid.
 */
export const EXTRA_LINKS = [
  { table: 'order_guest_access', column: 'order_public_id', via: 'public_id' },
  { table: 'order_item_ids', column: 'order_public_id', via: 'public_id' },
  { table: 'order_reference_aliases', column: 'order_public_id', via: 'public_id' },
  { table: 'refund_sync_events', column: 'provider_payment_id', via: 'provider_payment_id' },
];

/**
 * The fields of an address snapshot an anonymised order keeps.
 *
 * The country and nothing else. A paid order carries a VAT rate, and what
 * justifies that rate is where it shipped to; a country alone does not identify
 * anybody in a shop that sells to a whole country. Everything else in the
 * snapshot — name, street, city, postcode — is the person.
 */
export const ADDRESS_KEPT = ['country'];

/** Columns whose NAME could hold a person. Deliberately over-broad. */
export const SUSPECT_COLUMN =
  /(^|_)(email|mail|address|adresse|phone|tel|name|city|postal|zip|country|token|url|note|reason|error|ip|user|customer|client|tracking|session|label|body)(s)?($|_)/i;

/** Columns whose NAME says the row hangs off an order. */
export const LINK_COLUMN = /^(order_id|order_public_id|provider_payment_id)$/;

/** Tables no privacy question applies to, for the reasons the backup gives. */
const IGNORED_TABLE = (name) =>
  name.startsWith('sqlite_') || name.startsWith('_cf_') || name === 'd1_migrations' || /^products_fts/.test(name);

/**
 * Every suspect column the map has no opinion about.
 *
 * @param {Record<string, string[]>} schema table name → column names
 * @returns {string[]} `table.column`, sorted
 */
export function unclassifiedColumns(schema) {
  const missing = [];
  for (const [table, columns] of Object.entries(schema)) {
    if (IGNORED_TABLE(table)) continue;
    for (const column of columns) {
      if (!SUSPECT_COLUMN.test(column)) continue;
      if (COLUMN_POLICY[table]?.[column]) continue;
      if (NOT_PERSONAL[`${table}.${column}`]) continue;
      missing.push(`${table}.${column}`);
    }
  }
  return missing.sort();
}

/**
 * Every table that looks linked to an order and that nothing can reach.
 *
 * @param {Record<string, string[]>} schema table name → column names
 * @param {Record<string, string[]>} foreignKeys table name → columns pointing at `orders`
 */
export function unreachableTables(schema, foreignKeys) {
  const declared = new Set(EXTRA_LINKS.map((link) => link.table));
  const missing = [];
  for (const [table, columns] of Object.entries(schema)) {
    if (IGNORED_TABLE(table) || table === ORDER_TABLE || declared.has(table)) continue;
    if ((foreignKeys[table] ?? []).length > 0) continue;
    if (columns.some((column) => LINK_COLUMN.test(column))) missing.push(table);
  }
  return missing.sort();
}

/**
 * The map's opinion of one column, or null when it has none.
 *
 * @returns {{ action: string, why: string }|null}
 */
export function actionFor(table, column) {
  return COLUMN_POLICY[table]?.[column] ?? null;
}

/** Every table the map has an opinion about, sorted. */
export function mappedTables() {
  return Object.keys(COLUMN_POLICY).sort();
}

/**
 * Actions whose column is never written into an export.
 *
 * A `revoke` column is a credential and an `internal` one belongs to somebody
 * else; both would leave the shop in a file that then travels by e-mail to
 * whoever asked. What they do NOT do is disappear from the report: the export
 * says how many columns it withheld and under which rule, so a merchant
 * answering a regulator can show the omission was a decision.
 */
export const WITHHELD_ACTIONS = new Set(['internal', 'revoke']);

/** Actions the anonymisation writes over. The rest survive it, on purpose. */
export const REWRITTEN_ACTIONS = new Set(['subject', 'erase', 'address']);
