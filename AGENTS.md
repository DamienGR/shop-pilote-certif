# AGENTS.md — working on minshop

A guide for contributors and automated tooling making changes to minshop: a
small, full-Cloudflare ecommerce store (Astro 7 SSR on Workers + D1 + R2 +
Stripe / Lightning). Read this before editing. It's the map, the rules, the
recipes, and the traps. Each subsystem has its own page under `docs/agents/`
(see "Subsystem pages" below): read the matching one before working there.

## The loop (run this constantly)

```sh
nvm use 22         # REQUIRED — the supported toolchain runs on Node 22 (≥ 22.12)
npm run verify     # complete storefront + D1 + MCP green/red gate
```

`npm run verify` is the single signal that a change is sound: toolchain check,
secret scan, formatting floor, manifest and file-ownership gates, unit tests
(tenant isolation included), Astro diagnostics, the production build, the
deploy dry run and its size budgets, the integration suites (the security gate
included), and the MCP typecheck/deployment dry run. If it's green, the change
holds together. Run it after every meaningful edit, not just at the end.

Its parts run alone as `npm run check:*` and `npm run test:*` — `package.json`
is the list. `npm run check:format` is a floor rather than a formatter (LF,
final newline, no trailing whitespace, no tab indentation), because a
reformatted core lands as a merge conflict in every shop.

These are NOT in `verify`:

- `npm run check:secrets:history` runs the secret rules over every blob any ref
  still reaches, and every forbidden path ever tracked: a key deleted from the
  tree is in every clone made since. It refuses a shallow clone.
- `npm run check:clean-clone` re-clones HEAD into a scratch directory and builds
  there, proving the commit stands without any working-tree state. CI runs it as
  its own job; run it locally before tagging a core version.
- `npm run test:browser` is Playwright against the built Worker, for everything
  a container render cannot see — `docs/agents/browser-gate.md`.
- `test/remote/` asks the same questions of a DEPLOYED shop, given as
  `BASE_URL` — `docs/agents/remote-gates.md`.

Other commands: `npm run dev` (astro dev), `npm run preview` (wrangler dev =
production mode, for testing middleware/auth), `npm run db:migrate` (local D1),
`npm test`.

### Inspecting local data: use Local Explorer, not the CLI

Any local dev server serves Cloudflare's Local Explorer: a UI at
`/cdn-cgi/explorer` and a REST API at `/cdn-cgi/explorer/api` (D1, KV, R2,
Durable Objects, Workflows; `GET` it for the OpenAPI spec). Prefer it over
`npx wrangler d1 execute --local` for reads and fixture setup — an HTTP call
instead of a process spawned each time. The D1 database id is the binding name:

```sh
curl -s localhost:4321/cdn-cgi/explorer/api/d1/database/DB/raw \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT status, COUNT(*) FROM orders GROUP BY status"}'
```

Local only and unauthenticated: never bind a dev server to a public interface.
Anything touching `--remote` still goes through wrangler. The API reports
itself as version `0.0.1`, so use it for working loops, not as the basis of a
test gate.

## Subsystem pages

| Before working on… | Read |
|---|---|
| `client/client.yaml`, resource names, `scripts/prepare-client.mjs` | `docs/agents/manifest.md` |
| `shopctl/` (provision, deploy, destroy, repo, core/fleet upgrades, monitor), publishing a core version | `docs/agents/shopctl.md` |
| `shopctl backup` / `restore` | `docs/agents/backup.md` |
| `shopctl privacy` (RGPD export and erasure) | `docs/agents/privacy.md` |
| `shopctl catalog` (CSV import) | `docs/agents/catalogue.md` |
| `test/browser/`, a theme's design signature | `docs/agents/browser-gate.md` |
| `test/integration/security.mjs`, headers, auth, what the Worker logs | `docs/agents/security-gate.md` |
| `test/remote/`, `.github/workflows/nightly.yml` | `docs/agents/remote-gates.md` |
| `test/scripts/tenant-isolation.test.mjs` | `docs/agents/tenant-isolation.md` |

## Customizing a cloned shop

Use the narrowest customization surface that fits the change:

1. **Admin → Settings** for runtime settings: store identity, time zone,
   storefront toggles, payment rails, email, bot protection, and search. These
   values live in D1 and apply without a deploy. Provider credentials belong
   here too, where the secret vault stores them encrypted.
2. **`src/store.config.ts`** for versioned, build-time settings: currency,
   shipping zones and rates, image dimensions, order numbering, and
   template-only features. Override only changed keys; never customize
   `src/config.ts` defaults directly.
3. **`src/themes/<theme>/tokens.css`** for brand colors, fonts, surfaces, and
   corner radii — each theme owns its `@theme` block. `src/styles/overrides.css`
   is a normally-empty layer applied after it. Structural styles stay in
   `src/styles/base.css`; prefer a shared token to restyling one component.
4. **`public/favicon.svg`** for the browser icon. Products, categories, images,
   and other catalog content belong in the admin, not source files.
5. Optional infrastructure bindings (image optimization, semantic search, email
   delivery) stay disabled unless the feature is configured. They come from
   `wrangler.template.jsonc`: `wrangler.jsonc` is rendered from it, and hand
   edits are lost at the next render.

Deployment-only secrets belong in the platform secret store. Never put real
credentials, customer data, payment data, personal paths, or local environment
files in the repository.

Before handing off a customized shop, run `npm run verify` and review
`git diff --check` plus `git status --short`.

## Who owns which file

A shop is a clone of a core tag that keeps receiving core updates by merge, so
every file belongs to exactly one of three owners. `scripts/path-ownership.mjs`
is the list; `npm run check:paths` fails on a path no rule covers, and
`.github/CODEOWNERS` is generated from it — edit the rules, not the file.

- **core** — the agency's. Payment, stock, auth, migrations, tooling. A shop may
  edit one, but never as an unremarked customization: each core edit is a
  divergence to re-resolve at the next upgrade.
- **client** — the merchant's. `client/`, `imports/`, `src/store.config.ts`,
  `src/styles/overrides.css`, `theme.config.json`, `public/`, and the shop's own
  theme under `src/themes/`. The core never edits these, which is what keeps an
  upgrade merge clean.
- **generated** — a tool's. `wrangler.jsonc`, `schemas/*.schema.json`,
  `.github/CODEOWNERS`. An unexpected diff means a generator ran.

In a shop repository (one with `client/client.yaml`), a pull request touching a
core file needs a `core-change` label or an `Approves-core-change:` trailer —
except where the file holds exactly the content of a core release merged in the
range (`shopctl core upgrade`), which is an upgrade, not a divergence. In
this repository the gate reports but does not block — every change here is a
core change.

## The client manifest

`client/client.yaml` is a shop's non-sensitive source of truth: identity,
market, feature switches, Cloudflare names, theme. `scripts/manifest-schema.mjs`
is the authority on its shape; never hand-edit the generated
`schemas/client-1.schema.json` — run `npm run config:validate -- --write`.

- Every Cloudflare resource name is DERIVED from `cloudflare.workerName`, and a
  deployed one is qualified by its environment (ADR 0013). Two manifests may
  never claim the same identifier: nothing at runtime separates two shops' data
  (ADR 0001).
- No credential ever goes in the manifest: the schema is closed and a
  `no-credentials` rule scans the values it allows.
- The core must not name any shop: `config:validate` scans core-owned files for
  a shop's slug, display name, worker name, domain or sender. The witness shops
  live in `test/fixtures/clients/`.

Optional fields, environment names and rendering: `docs/agents/manifest.md`.

## The `shopctl` CLI

`shopctl/` is the agency tool: create a shop's repository from a core tag, then
operate it. It ships WITH the core and is versioned BY it (ADR 0009). No
dependencies, no build step — `shopctl new` has to run before a `node_modules`
exists anywhere. `npm run shopctl -- --help` lists the commands;
`docs/agents/shopctl.md` is the detail.

Four rules hold for every command, present and future:

- **wrap, never reimplement.** `config validate` calls
  `scripts/check-manifest.mjs`, `doctor` calls `scripts/check-toolchain.mjs`.
  Two implementations of one gate eventually disagree, and the operator
  believes the CLI.
- **exit codes are the contract** (0 ok, 2 usage, 3 bad value, 4 missing
  prerequisite, 5 external command, 6 produced-then-refused). A code never
  changes meaning; a new failure mode takes a new code.
- **no secret on the command line.** A credential-shaped argument is refused,
  every relayed line goes through `redact()`, and secrets the CLI generates go
  to wrangler on STDIN, never returned, logged or written.
- **nothing that touches an account is defaulted.** `provision` and `deploy`
  refuse to run without `--env`; `deploy --env production` refuses without
  `--yes`; the Cloudflare account is never guessed, and two sources that
  disagree stop the run. `environmentAccount()` in `scripts/manifest.mjs` is the
  one answer to "which account is this environment on".

`docs/operations/` holds one runbook per incident and the client exit
procedure. A runbook names real commands; when you change one of them (a flag,
a table, a route), change the runbook in the same commit.

## Architecture in one screen

**Feature folders (vertical slices).** Each owns its data access, types, and
components. Deleting a folder still builds.

```
src/
  config.ts              SCHEMA + DEFAULTS (upstream-owned). getConfig() = source of truth.
  store.config.ts        build-time shop overrides, deep-merged on top
  styles/overrides.css   post-theme override layer (normally empty; theme tokens live in themes/<theme>/tokens.css)
  middleware.ts          admin auth gate (fail-closed)
  env.d.ts               Cloudflare.Env binding/secret types
  layouts/               Layout.astro (storefront), AdminLayout.astro
  features/
    products/  db · form · image · ProductForm.astro · sort · search · stock · slug
    orders/    db · number · reservations (atomic checkout stock holds)
    payments/  provider (port) · stripe · opennode · lightning-provider · index (factory)
               lightning/  backend (port) · phoenixd · lnbits · index · rate · pending
    shipping/  calculator (zones + ShippingCalculator port)
    storage/   provider (port) · r2 · index (factory)
    email/     provider (port) · resend · cloudflare · index (factory) · orderConfirmation
    search/    provider (port) · fts · vector · index (factory) · query
    i18n/      locale (leaf constants) · messages (fr catalog) · index (t/tn) · format
    legal/     terms (consent gate) · vat (TTC split)
    auth/      access (CF Access JWT) · session (admin login cookie) · turnstile · Turnstile.astro
    settings/  db (runtime settings) · availability · home · timeZone
    secrets/   store (provider keys, encrypted in D1) · crypto
    http/      origin · securityHeaders (twin of public/_headers)
    observability/  logSafe
    catalog/   serialize · http  (public API shapes for /api/products)
    cache/ cart/ categories/ customers/ digitalDelivery/ ids/ media/ navigation/
    pages/ refunds/ seed/ storefront/
  pages/
    index, products/[slug], categories/[slug], pages/[slug], search, cart, checkout
    product/[slug], category/[slug] — 301s to the plural URLs; keep indefinitely
    pay/[publicId] (Lightning invoice page), order/[token] (confirmation)
    admin/ (CRUD UI, login, logout)
    api/ (cart, webhook, admin/*; checkout — form OR JSON {items} → checkout_url;
          products, products/[slug] — public machine-readable catalog)
    images/[...key] (serves R2), sitemap.xml, robots.txt
```

**Ports & adapters (the seams).** Routes depend on interfaces, never on a vendor.
To swap/add a provider, write one adapter file + wire the factory:

| Port | Where | Factory | Adapters |
|---|---|---|---|
| `PaymentProvider` | `payments/provider.ts` | `payments/index.ts` | stripe, opennode, lightning |
| `LightningBackend` | `payments/lightning/backend.ts` | `payments/lightning/index.ts` | phoenixd, lnbits |
| `ShippingCalculator` | `shipping/calculator.ts` | (config-rates) | carrier rates (future) |
| `StorageProvider` | `storage/provider.ts` | `storage/index.ts` | r2 |
| `EmailProvider` | `email/provider.ts` | `email/index.ts` | resend, cloudflare |
| `SearchProvider` | `search/provider.ts` | `search/index.ts` | fts, vector (Workers AI + Vectorize) |

**Bindings.** Access Cloudflare bindings via `import { env } from 'cloudflare:workers'`
(typed by `Cloudflare.Env` in `env.d.ts`). Never `Astro.locals.runtime.env`
(removed in Astro v6). D1 = `env.DB`, R2 = `env.BUCKET`.

## The French core

The storefront is French, and single-locale on purpose: `client.locale` in the
manifest is an enum with one value, and widening it is a schema-version decision
(ADR 0008). `src/features/i18n/` is where that lives.

```ts
import { t, tn } from '../features/i18n';
t('product.addToCart');                        // "Ajouter au panier"
t('order.total', { montant: formatPrice(x) }); // named {placeholders}, never positional
tn('cart.items.one', 'cart.items.other', n);   // fr puts 0 in the singular
```

`messages.ts` is the catalog AND the type: `MessageKey` is derived from it, so a
key that isn't there doesn't compile, and a second locale declared
`LocaleCatalog` can't omit one (`test/i18n/` compiles two broken fixtures to
prove it still fails). What the compiler can't see — typographic apostrophes, the narrow
no-break space (U+202F) before `? ! ; :`, accents — `messages.test.ts` asserts.
`locale.ts` is a LEAF with no imports, so pure code like `money.ts` can format
in `fr-FR`. Store-owned templates may import the catalog directly — it's the
fourth entry on the storefront boundary allowlist, beside models and controls.

The **admin is French too** (ADR 0018, which replaced ADR 0011's English
admin): `AdminLayout` declares the storefront's `lang`, and every Admin string is
a key in `src/features/i18n/admin/` — one fragment per section, every key
prefixed `admin.`, spread into `fr`. An Admin label is a `t()` call like any
other; `test/i18n/admin-language.test.mjs` fails on an English sentence written
into an Admin template. Identifiers stay English: CSV export columns, enum
values, field names, and log lines.

**Terms of sale.** `features/legal/terms.ts` holds ONE predicate: the checkout
checkbox renders and the server refuses exactly when the terms page is
published. The acceptance and the VAT rate ride on the reservation, and
`recordPaidOrder` copies both onto the order. Refusal happens BEFORE the stock
hold.

**VAT** (ADR 0010): prices are TTC, so `features/legal/vat.ts` splits tax OUT of
a total. `tax_cents` keeps its own meaning (tax added on top, Stripe Tax); a TTC
store leaves it 0 and reads `vat_amount_cents`. Rates are basis points — 5.5 %
and 2.1 % are ordinary French rates. The rounding is taken once, on the order
total, never per line.

## Invariants — do not break these

1. **Storefront is near-zero client JS.** Server-render everything; progressive
   enhancement only. A little JS is allowed where it earns it (cart drawer,
   /pay polling, Turnstile) — never required for the page to work.
2. **Orders are paid-only.** The `orders` table holds settled orders. In-flight
   Lightning invoices live in `pending_payments` until settled — never write an
   unpaid order.
3. **Config has two layers.** Operational settings live in the D1 settings table
   and are managed through the admin. Data-coupled defaults live in `config.ts`
   and are overridden by clones in `store.config.ts`. Read effective values
   through the existing settings/config helpers. Currency remains build-time
   and store-wide.
4. **Provider-agnostic core.** `checkout.ts` / `webhook.ts` / shipping never
   import a vendor SDK directly — only the ports. Vendor code stays in adapters.
5. **Admin is fail-closed.** In production, if nothing is configured the admin is
   blocked. Don't add an open admin path. Don't make `/admin` a "secret" path
   (security-through-obscurity) — the auth gate is the protection.
6. **Migrations are additive.** Numbered files in `migrations/`, `CREATE TABLE IF
   NOT EXISTS` / `ALTER TABLE ADD COLUMN`. Never edit an applied migration; never
   `DROP` destructively.
7. **Money is integer minor units** (cents) end to end; format only at the edge
   via `formatPrice()`. Use `toMajorUnits()` / `minorUnitsPerMajor()` for
   currency math (handles JPY/BHD, not just 2-decimal). Never build a
   `Intl.NumberFormat` / `Intl.DateTimeFormat` at a call site — `formatPrice()`,
   `formatDate()` and `features/i18n/format.ts` are the only places that name a
   locale, which is why the admin reads `1 234,56 €` while staying in English.
8. **Tests stay pure.** A `*.test.ts` must NOT import `cloudflare:workers` (vitest
   can't load it). Keep DB/env logic out of unit-tested modules — pass `db` and
   secrets as params (see `lightning/rate.ts`, `auth/session.ts`).
9. **Public routes are plural for browsable collections** — `/products/<slug>`,
   `/categories/<slug>` — matching the admin (`/admin/products`), the JSON API
   (`/api/products/<slug>`), and the feature directories. Token-addressed single
   resources stay singular: `/order/<token>`, `/pay/<publicId>`. Retiring a
   public URL means leaving a 301 stub behind permanently; these paths appear in
   sitemaps, `llms.txt`, and search indexes on stores you don't control.
10. **Media is the only owner of stored files.** Products, pages, and the logo
    record USAGE by `image_key`; removing an image from any of them deletes the
    association only. Only `/api/admin/media/:id` deletes an R2 object, and it
    refuses while anything still references the row. Deletion and every
    association write are guarded in a single SQL statement so the two cannot
    race; never re-introduce a check-then-write.
11. **Page bodies are Markdown with `html: false`.** Raw HTML is escaped, not
    parsed, so a page body can never inject script — including from a
    compromised admin session. The storefront and the admin preview call the
    SAME server-side `renderMarkdown()`; do not add a client-side parser.
12. **A log line is written, never forwarded.** Structured events with fields
    you chose; an error from a provider goes through `logSafe()`
    (`features/observability/logSafe.ts`), which masks e-mail addresses and
    guest access tokens but is NOT a general PII detector. A provider's error
    body is text it wrote about a customer — Resend's names the recipient — so
    never interpolate one into a message, and never `console.error('…', err)`
    on a path that touches an order, an address or an account. Logs outlive
    the order.
13. **A stored file is what its bytes say it is.** `File.type` comes from
    whoever posted the multipart body. Every upload path validates through
    `validateUpload()`, which reads the header (`features/media/sniff.ts`);
    `validateUploadMetadata()` alone is the cheap pre-check, not the rule.
14. **Some things look wrong on purpose.** Do not "fix" them:
    - the security gate DERIVES the admin routes from `src/pages/admin` and
      `src/pages/api/admin` — never replace that with a list;
    - `slugify()` and the image-header dimension reader exist twice (the Worker
      bundle and the build-less CLI), pinned against a shared corpus in
      `test/scripts/catalog.test.mjs`;
    - an RGPD erasure is an ANONYMISATION, never a delete: a paid order is an
      accounting record kept for ten years (`docs/agents/privacy.md`);
    - `provision` KEEPS an existing secret, never rotates it — a new
      `SECRETS_KEK` would break payments with no readable error.

## Recipes — how to add X

- **A product field:** new migration (`ALTER TABLE products ADD COLUMN …`) →
  update `Product`/`AdminProduct` + queries in `features/products/db.ts` → add to
  `ProductForm.astro` + `parseProductForm` in `features/products/form.ts`. If the
  catalogue CSV should carry it too, add a `COLUMNS` entry in
  `shopctl/src/catalog/contract.mjs` and the field to `PRODUCT_FIELDS` in
  `catalog/plan.mjs` — the generated `imports/README.md` and its gate derive from
  that list.
- **A content page:** nothing to add — merchants create them at `/admin/pages`.
  Published pages appear at `/pages/<slug>`, in the sitemap and `llms.txt`
  automatically. The footer is a menu (migration 0028): a page reaches it only
  through Admin → Navigation, the four legal pages of migration 0040 included.
- **A page layout preset:** add ONE entry to `PAGE_LAYOUTS` in
  `features/pages/layouts.ts`. The editor dropdown, validation, the storefront,
  and the admin preview all derive from it, and `measure`/`titleAlign` are
  emitted as CSS custom properties, so no stylesheet edit is needed. A preset
  that needs more than those two axes can also target
  `[data-page-layout="<key>"]` in `global.css`. Unknown/removed presets fall
  back to `standard` at render time, so old rows never break.
- **A customer-facing string:** add a key to `src/features/i18n/messages.ts` and
  call `t('…')`. Never a literal in a template — the storefront is French, and a
  literal is the one thing the catalog's type can't catch. Client scripts take
  the string through `define:vars`, never by importing `t` (that would ship the
  whole catalog to the browser).
- **A config setting:** build-time → add to the `SiteConfig` interface AND
  `defaultConfig()` in `config.ts`; read via `getConfig()`; document the override
  in `store.config.example.ts` (per-env overrides can read an env var, see
  `TIME_ZONE`). Runtime (dashboard) → add a `SettingKey` + `StoreSettings` field in
  `features/settings/db.ts` and a form in `/admin/settings`.
- **A payment provider:** implement `PaymentProvider` in a new
  `features/payments/<name>.ts`; add a case to `getPaymentProvider()` in
  `payments/index.ts`; add its key as a `SecretName` in `features/secrets/store.ts`
  (stored encrypted in D1 via the admin vault — provider keys are NOT env vars) and
  a `SecretField` in the settings Payments card.
- **A Lightning backend:** implement `LightningBackend` in
  `features/payments/lightning/<name>.ts`; add a case to `getLightningBackend()`.
- **A shipping zone/rate:** edit `shipping.zones` in `config.ts` default (or
  `store.config.ts`). Pure logic lives in `shipping/calculator.ts` — unit-test it.
- **A migration:** `npx wrangler d1 migrations create minshop-db <name>` → edit →
  `npm run db:migrate` (local). A deployed environment is migrated by
  `shopctl deploy`, which backs production up first — never migrate it by hand.
- **An admin page:** `src/pages/admin/<x>.astro` using `AdminLayout` (add a nav
  entry there). Mutations go through `/api/admin/*` (covered by the auth gate).
  Its strings are `t('admin.<x>.…')` keys in `src/features/i18n/admin/<x>.ts`
  (a new fragment is added to `admin/index.ts`), never literals.
- **A storefront feature behind a flag:** `config.features.<x>` toggle; gate the
  nav link in `Layout.astro` and the route.
- **Customer auth:** `features/auth/customer.ts` is the magic-link adapter (no
  passwords) — reuses `token.ts` (signed HMAC) + the `EmailProvider`. Pages live
  under `pages/account/`. Swap to OAuth by replacing that module. Orders are keyed
  by email, so "my orders" = `listOrdersByEmail` (no per-user join needed).
- **A search backend:** implement `SearchProvider` in `features/search/<name>.ts`;
  add a branch to `getSearchProvider()`. Semantic (`vector`) keeps the index in
  sync via `indexProduct`/`unindexProduct` called from the admin product routes.
- **An integration test for code that reads `env`:** a module importing
  `cloudflare:workers` can't be loaded by a plain Node script. Run the script as
  `node --experimental-strip-types --import ./test/helpers/register-workers-loader.mjs …`
  and call `setWorkersEnv({ DB })` (from `test/helpers/workers-env.mjs`) BEFORE
  the dynamic `import()` of the module under test — the loader resolves
  `cloudflare:workers` to that object, so the code under test is unchanged.
  `applyMigrations(db)` from `test/helpers/d1-schema.mjs` gives the suite the
  real schema, every migration applied, instead of a hand-written subset that
  drifts. `test/integration/settlement.mjs` is the worked example.

## Gotchas — preflight checklist

- **Bare `<` / `<=` in an Astro `{expression}`** parses as a tag open → a
  misleading "Unable to assign attributes when using <> Fragment shorthand"
  error. Fix: flip operands (`0 >= x`), use `!==`, or compute the boolean in
  frontmatter. (`>` is fine; only `<` bites.)
- **No `main`/`assets` in `wrangler.jsonc`** — the adapter supplies the worker
  entry; setting `main` breaks a clean build.
- **CSRF on POST:** Astro rejects cross-origin form POSTs (403). Browsers send
  `Origin` automatically; `curl` needs `-H "Origin: http://localhost:4321"` +
  `-H "Content-Type: application/x-www-form-urlencoded"`.
- **Admin auth only enforces in production mode.** `astro dev` bypasses the gate
  (so you can't lock yourself out). Test login/middleware with `npm run preview`
  (wrangler dev). On a fresh store the password is set via the `/admin/setup`
  wizard (hashed in D1) — there is no `ADMIN_PASSWORD` env var; until one is set,
  `/admin/setup` is open (bootstrap), then the gate locks.
- **Lightning settlement = re-poll the node.** The webhook is an untrusted nudge;
  authority is `backend.getIncoming()`. Don't trust a webhook to mark paid.
- **Webhooks need `constructEventAsync`** (Stripe) — the sync verifier uses Node
  crypto, absent on Workers. Web Crypto everywhere (see `auth/access.ts`).
- **FTS5 `MATCH` throws on raw input** — sanitize to alphanumeric prefix tokens
  (`features/products/search.ts`).
- **D1 bills the rows a query SCANS, not the rows it returns.** A query on a
  table that grows with the order history (`orders`, `order_items`,
  `order_guest_access`, `checkout_reservations`) needs an index on what it
  filters by, or it reads the whole history on every call — and past five
  million rows a day the Free plan fails every query, every page included,
  until midnight UTC. `test/integration/history-reads.mjs` asserts
  `meta.rows_read` on those paths; a new one belongs there.
- **`wrangler d1 export` fails on FTS5 virtual tables**, which this database has
  since migration 0003. A backup goes through `shopctl backup`
  (`docs/agents/backup.md`), never through a dropped index.
- **Static assets never reach the middleware.** Cloudflare's asset server answers
  `/favicon.svg`, `/placeholder.*` and `/_astro/*` before the Worker runs, so a
  header added in `src/middleware.ts` does not apply to them. `public/_headers`
  and `src/features/http/securityHeaders.ts` are one list in two places;
  `test/scripts/security-headers.test.mjs` keeps the two in step.
- **The `mcp/` Worker has its OWN `package.json` + `node_modules`.** Never add
  `agents` / `@modelcontextprotocol/sdk` to the ROOT package.json — the Agents SDK
  pulls in workerd/miniflare deps that silently break the storefront's Astro build
  ("require_dist is not a function" in the CF Vite plugin). Install MCP deps in
  `mcp/` only. Build it independently with `npm run mcp:check` (`npm run verify`
  also includes it).

## Conventions

- Comments explain *why*, match surrounding density.
- Colocate tests: `foo.ts` + `foo.test.ts`. Test pure logic; integration (D1/R2)
  lives in `test/integration/`, against real migrations and the built Worker.
- Don't install npm packages without asking. Don't run deploy/publish commands
  unless explicitly told.
- After non-trivial UI changes, screenshot to verify, or run
  `npm run test:browser`. Screenshots stay outside the repository and are
  deleted after.
