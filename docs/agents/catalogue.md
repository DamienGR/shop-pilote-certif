# The catalogue import

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on `shopctl catalog`.

`shopctl catalog` turns a merchant's CSV into the store's rows. `shopctl/src/catalog/`
is the pipeline, and the split is the point: **csv → contract → media → plan**
are pure, **store** is the only file that reaches wrangler. That is what lets
`--dry-run` be the same code path as the real import rather than a second
implementation of it, and what lets `npm run test:catalog` apply the REAL
statements to the REAL migrations through `node:sqlite`
(`test/helpers/catalog-sqlite.mjs`, a child process because that module wants
`--experimental-sqlite` on the lower half of the Node line).

Four properties hold, and each one is a test:

- **identity is the SKU.** `products.sku` (migration 0042, partial UNIQUE index)
  for a product, `product_variants.sku` for a variant. A variant product's rows
  share a parent reference in the `product` column; that reference is the
  product row's own SKU.
- **idempotent and resumable without bookkeeping.** Re-running a file produces a
  plan with NOTHING in it. There is no journal: an interrupted run leaves state
  the next run reads, and the plan computed from it is exactly the remainder.
  Image keys are `media/<20 hex of sha256>.<ext>` — content-addressed, so a
  shared photo is one object and a re-run uploads nothing. (The admin's own
  uploads stay randomly keyed; see `mediaKeyFor()` for the 20-character budget.)
- **nothing is written until everything is judged**, and **nothing is deleted**.
  A variant leaving the catalogue is deactivated (`order_items.variant_id`
  points at it); products absent from the file are untouched. Losses ask:
  `--allow-slug-change`, `--allow-remove-variants`, `--create-categories`.
- **the SQL file is the security surface.** One `wrangler d1 execute --file` per
  import means inlined values, so `catalog/sql.mjs` does the quoting and the
  gate writes `'); DROP TABLE products;--` into a store and reads it back.

Two pure rules exist twice on purpose — `slugify()` and the image-header
dimension reader — because one copy lives in the Worker bundle and the other in
a CLI with no build step. Both pairs are pinned against a shared corpus in
`test/scripts/catalog.test.mjs`; keep them that way rather than "fixing" the
duplication.
