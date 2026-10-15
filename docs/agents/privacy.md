# Erasing one buyer

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on `shopctl privacy`.

`shopctl privacy export | anonymize` answers the two rights the RGPD exercises
against the shop's own database (ADR 0017). One set of rules serves both,
because they ask the same question — *which rows are this person's?* — and two
answers would eventually disagree on the run where being wrong is a breach in
one direction and a destroyed accounting record in the other.

```
shopctl/src/privacy/   map      ← declared, and GATED
                       subject  ← pure: predicates, export document, statements
```

- **an erasure is an ANONYMISATION, never a delete.** A paid order is an
  accounting record French law keeps for ten years. Amounts, VAT, dates, status
  and the order's public id stay; the identity is rewritten. `orders.email`
  becomes a pseudonym, `ship_address` is reduced to its `country` (which is what
  justifies the VAT rate applied), and everything naming a parcel at a carrier
  goes to NULL. Exactly one row is deleted: `order_guest_access` — a token whose
  order was anonymised is still a working key to that order's page.
- **the pseudonym is drawn from the CSPRNG, one per ROW.** A hash of the address
  is not anonymous — the set of a shop's buyer addresses enumerates, so a
  merchant with a mailing list reads the anonymised orders straight back. One
  token per person would keep their orders grouped, and a group of orders is a
  profile. Nothing keeps the mapping; `--confirm <slug>` is required in EVERY
  environment (staging is usually a restored copy of production).
- **the column map is declared and gated; the row reach is derived.** No schema
  says which column is a person (`orders.email` and `products.name` are both
  TEXT), so `privacy/map.mjs` writes it down — and a name heuristic refuses any
  suspect column the map has no opinion about, so a new migration cannot slip
  one past. Which ROWS are theirs is pure derivation: foreign keys to `orders`,
  plus the four tables keyed on a public id, declared under their own gate.
- **the export is cleartext JSON, 0600, in `privacy/`** (gitignored). Article 20
  asks for a structured machine-readable format and the file is FOR the
  requester; encrypting it would only move the problem to sending the key. It
  withholds access tokens (an export travels by e-mail; that one is a password)
  and shop operators' identities, and it NAMES what it withheld.
- **free text and processor ids are kept and reported.** A refund's `note` and
  `reason` justify a ledger movement, and a map classifies a column but cannot
  read a sentence: they are counted and located by public id — never quoted into
  a report that ends up in a ticket. The Stripe ids stay because erasing them
  would remove the merchant's only handle for asking Stripe to erase the same
  person; the report lists them as a separate request.
- **the rewrite verifies itself.** The same predicates are re-evaluated after
  the write: the roots must find nothing, every rewritten column is re-read.
  That is what catches an order placed by the same person between the read and
  the write. Failure is exit 6 and the rows are left as the command left them.

Gotcha, and it cost an afternoon: **`sqlite_master`'s CREATE TABLE text is
documented SQL, so the reader has to be a scanner.** Both derivations read the
stored text rather than spending one wrangler process per table. A trailing
`-- comment` after a comma lands where the NEXT column starts (that hid
`checkout_reservations.expires_at`), and a comment with an apostrophe in it
opens a string literal that swallows the rest (`refunds`). Both were live in
`migrations/`. `columnDefinitions()` strips comments as it scans, and the suite
compares its answer against `PRAGMA table_xinfo` — `table_xinfo`, not
`table_info`, which HIDES a virtual generated column like
`orders.refunded_cents`.
