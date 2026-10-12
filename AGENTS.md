# AGENTS.md — working on minshop

A guide for contributors and automated tooling making changes to minshop: a
small, full-Cloudflare ecommerce store (Astro 7 SSR on Workers + D1 + R2 +
Stripe / Lightning). Read this before editing. It's the map, the rules, the
recipes, and the traps.

## The loop (run this constantly)

```sh
nvm use 22         # REQUIRED — the supported toolchain runs on Node 22
npm run verify     # complete storefront + D1 + MCP green/red gate
```

`npm run verify` is the single signal that a change is sound: it runs the
toolchain check, unit tests, full Astro diagnostics, the production build, the
storefront deploy dry run and its size budgets, the clean-room D1 integration,
the MCP typecheck/deployment dry run, and the secret scan. If it's green, the
change holds together. Run it after every meaningful edit, not just at the end.

Its parts can be run alone: `npm run check:toolchain` (Node/npm line),
`npm run check:deploy` (Wrangler dry run + bundle budgets, needs a build),
`npm run check:secrets` (tracked-tree credential scan),
`npm run check:format` (the formatting floor: LF, final newline, no trailing
whitespace, no tab indentation — a floor rather than a formatter, because a
reformatted core lands as a merge conflict in every shop),
`npm run check:secrets:artifacts` (the same rules over `dist/`, plus the local
`.dev.vars` values, which Vite can freeze into the bundle — needs a build),
`npm run test:security` (the security gate below, needs a build),
`npm run config:validate` (client manifests, fleet identifiers, core
neutrality), `npm run check:paths` (file-ownership map + CODEOWNERS drift),
`npm run test:tenant-isolation` (two shops in one account — see below).
`npm run check:clean-clone`
is NOT in `verify` — it re-clones HEAD into a scratch directory and builds there,
proving the commit stands without any working-tree state. CI runs it as its own
job; run it locally before tagging a core version.

`npm run test:browser` is the other gate outside `verify` — Playwright against
the built Worker, for everything a container render cannot see (accessibility,
keyboard, zoom, no-JS, the compiled design). See "The browser gate" below.

`test/remote/` is the third family: the same questions asked of a DEPLOYED
shop, given as `BASE_URL`. See "The remote gates" below.

Other commands: `npm run dev` (astro dev), `npm run preview` (wrangler dev =
production mode, for testing middleware/auth), `npm run db:migrate` (local D1),
`npm test`.

### Inspecting local data: use Local Explorer, not the CLI

Any local dev server (`npm run dev`, `npm run preview`) serves Cloudflare's
Local Explorer — a UI at `/cdn-cgi/explorer` and a self-describing REST API at
`/cdn-cgi/explorer/api` covering D1, KV, R2, Durable Objects and Workflows.
It reads the same local state the app does, with no setup.

Prefer it over `npx wrangler d1 execute --local` for reads and fixture setup:
that spawns a process each time (~1.2s) where this is an HTTP call (~0.02s) —
roughly 70x, which is the difference between checking state freely and avoiding
it. `GET /cdn-cgi/explorer/api` returns the OpenAPI spec, so the endpoints are
discoverable rather than memorized. The D1 database id is the binding name:

```sh
curl -s localhost:4321/cdn-cgi/explorer/api/d1/database/DB/raw \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT status, COUNT(*) FROM orders GROUP BY status"}'
```

Local only, and unauthenticated on the dev origin — it is never exposed on a
deployed Worker, but do not bind a dev server to a public interface. Anything
touching `--remote` still goes through wrangler. The API reports itself as
version `0.0.1`, so use it for working loops, not as the basis of a test gate.

## Customizing a cloned shop

Use the narrowest customization surface that fits the change:

1. **Admin → Settings** for runtime settings: store identity, time zone,
   storefront toggles, payment rails, email, bot protection, and search. These
   values live in D1 and apply without a deploy.
2. **`src/store.config.ts`** for versioned, build-time settings: currency,
   shipping zones and rates, image dimensions, order numbering, and
   template-only features. Override only changed keys; never customize
   `src/config.ts` defaults directly.
3. **`src/themes/<theme>/tokens.css`** for brand colors, fonts, surfaces, and
   corner radii — each theme owns its `@theme` block. `src/styles/overrides.css` is a
   normally-empty override layer applied after the theme's tokens. Keep
   structural styles in `src/styles/base.css` and avoid restyling individual
   components when a shared token will do.
4. **`public/favicon.svg`** for the browser icon. Products, categories, images,
   and other catalog content belong in the admin, not source files.
5. **`wrangler.jsonc`** for optional infrastructure bindings such as image
   optimization, semantic search, and email delivery. Keep optional bindings
   disabled unless the corresponding feature is configured.

Provider credentials belong in Admin → Settings, where the secret vault stores
them encrypted. Deployment-only secrets belong in the platform secret store.
Never put real credentials, customer data, payment data, personal paths, or
local environment files in the repository.

Before handing off a customized shop, run `npm run verify` and review
`git diff --check` plus `git status --short`. Add a new numbered migration for
schema changes; never rewrite a migration that may already have run.

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
core file needs a `core-change` label or an `Approves-core-change:` trailer. In
this repository the gate reports but does not block — every change here is a
core change.

## The client manifest

`client/client.yaml` is a shop's non-sensitive source of truth: identity,
market, feature switches, Cloudflare names, theme. `scripts/manifest-schema.mjs`
is the authority on its shape; `schemas/client-1.schema.json` is generated from
it for editors. Never hand-edit the generated schema — run
`npm run config:validate -- --write`.

Every Cloudflare resource name is DERIVED from `cloudflare.workerName`
(`<name>-db`, `-images`, `-files`, `-backups`, `-session`), so one shop is one
name family and `shopctl destroy` removes all of it. `-backups` is the one no
Worker binds: it holds the CI's encrypted archives, private, in the shop's
jurisdiction (ADR 0005, note of 2026-10-06). Two manifests may never claim the same
identifier: nothing at runtime separates two shops' data (ADR 0001).

A DEPLOYED resource additionally carries its environment, which qualifies the
STEM: `minshop-<slug>-staging-db`, `minshop-<slug>-production-images` (ADR 0013).
The unqualified family is not a third environment — it is what witness builds,
the browser gate and local development render, none of which reach an account.
`config:validate` claims both environments' names, so a shop slugged
`x-staging` colliding with the staging family of `x` is a gate failure rather
than a discovery.

Every field a shop DECIDES is required. The six `optional` ones under
`cloudflare` are values a shop LEARNS: `accountId` exists only after
provisioning has run, `productionAccountId` only once the client's own account
does (ADR 0015), `imagesDomain` only if a domain was ever attached,
`stagingDomain` only for a private preview, and `stagingAccessTeam` /
`stagingAccessAud` only once an Access application stands in front of it. A new
optional field is a deliberate act; `test/scripts/manifest.test.mjs` pins the
list by name.

No credential ever goes in the manifest — the schema is closed and a
`no-credentials` rule scans the values that are allowed. An account id is not a
credential: it is the first path segment of every dashboard URL. Neither is an
Access AUD, though it has the shape of one (64 hex characters): it is the `aud`
claim of every token the application issues, and the rule exempts that one
field by PATH, never by shape.

`node scripts/prepare-client.mjs <slug>` renders `wrangler.jsonc` and the theme
selection for one shop; `--env <staging|production>` renders that environment's
names, `--list` names the shops in the tree, `--out` writes elsewhere. The witness shops live in `test/fixtures/clients/` and CI builds
both. The core must not name any of them: `config:validate` scans core-owned
files for a shop's slug, display name, worker name, domain or sender, because a
core that knows one customer is a condition the third one discovers in
production.

## The `shopctl` CLI

`shopctl/` is the agency tool: create a shop's repository from a core tag, then
operate it. It ships WITH the core and is versioned BY it, so the CLI that
creates a shop from `v1.2.0` is the one that tag carries (ADR 0009). No
dependencies, no build step — `shopctl new` has to run before a `node_modules`
exists anywhere.

```sh
npm run shopctl -- new <slug> --core v<x.y.z> --origin <url>
npm run shopctl -- doctor            # tools, tree, provisioning prerequisites
npm run shopctl -- config validate   # the manifest gate, through the CLI
npm run shopctl -- catalog validate ./imports/catalog.csv
npm run shopctl -- catalog import ./imports/catalog.csv --dry-run
npm run shopctl -- repo                 # dépôt GitHub, environnements, secrets
npm run shopctl -- new <slug> --account <id> --create-repo   # les trois d'un coup
npm run shopctl -- provision --env staging --dry-run
npm run shopctl -- provision --env staging
npm run shopctl -- deploy --env staging
npm run shopctl -- deploy --env production --yes
npm run shopctl -- destroy --env staging --confirm <slug>
npm run shopctl -- privacy export --env production --email <adresse>
npm run shopctl -- privacy anonymize --env production --email <adresse> --confirm <slug>
npm run shopctl -- monitor --env production   # taux d'erreur, quotas du plan gratuit
npm run shopctl -- core status          # quelle version cette boutique porte
npm run shopctl -- core upgrade --to v1.1.0 --open-pr
npm run shopctl -- fleet status         # depuis l'espace de travail de l'agence
npm run shopctl -- fleet upgrade --to v1.1.0 --open-pr
```

Four rules hold for every command, present and future:

- **wrap, never reimplement.** `config validate` calls
  `scripts/check-manifest.mjs`, `doctor` calls `scripts/check-toolchain.mjs`, and
  `new`'s minimal verification calls the scripts the SHOP carries, not the host
  core's. Two implementations of one gate eventually disagree, and the operator
  believes the CLI.
- **exit codes are the contract** (0 ok, 2 usage, 3 bad value, 4 missing
  prerequisite, 5 external command, 6 produced-then-refused). A code never
  changes meaning; a new failure mode takes a new code.
- **no secret on the command line.** A credential-shaped argument is refused —
  it is already in the shell history and the CI log — and every relayed line
  goes through `redact()` using the manifest's own patterns. Secrets the CLI
  generates go to wrangler on STDIN and are never returned, logged or written.
- **nothing that touches an account is defaulted.** `provision` and `deploy`
  refuse to run without `--env`; `deploy --env production` refuses without
  `--yes`; neither will guess the Cloudflare account (the manifest — `accountId`,
  or `productionAccountId` for `--env production` when it is declared —
  `--account`, or `CLOUDFLARE_ACCOUNT_ID`, and two that disagree stop the run).
  `environmentAccount()` in `scripts/manifest.mjs` is the one answer to "which
  account is this environment on"; `expectedAccount()` is how a command asks.
  `repo` creates a PRIVATE repository unless told otherwise, and never reopens
  or recloses an existing one.

`shopctl new` also runs from `npx --package=github:<owner>/<core>#<tag> shopctl
new <slug>`, which is how the first shop on a machine gets made. npm hands it an
extracted TARBALL — no `.git`, so no `origin` to ask — and the `--from` default
falls back to `repository` in the core's package.json. A cloned tree still wins:
a fork, a mirror or a path given to `--from` is the core the operator stands in.

`shopctl new` clones a TAG with its history, renames the core remote to `core`,
and DELETES NOTHING: a shop keeps receiving core tags by merge, so every file
removed at creation is a conflict to re-resolve at each upgrade that touches it.
(`create-minshop/` is the public upstream scaffolder and does the opposite; the
two share a verb, not a purpose.)

`provision` is idempotent and resumable with NO state file: every step asks the
account (`d1 list`, `r2 bucket list`, `secret list`) and then decides. A second
run creates nothing; a killed run resumes by asking the same questions. An
existing secret is KEPT, never rotated — `SECRETS_KEK` decrypts the payment keys
already in D1, and a new one would break payments with no error anyone can read.

A shop's LIFECYCLE has four steps, and the account boundary falls between the
second and the third (ADR 0015): build on the agency account, private preview
behind Access, **client enters content on the client's account**, go live and
tear the agency copy down. The boundary is there because Cloudflare transfers
nothing between accounts — putting it at go-live would make `backup`/`restore`
(jalon 9) a prerequisite of every launch. Declaring `cloudflare.stagingDomain`
renders the staging route AND closes workers.dev, because an Access app binds
to a hostname and its header is forgeable against a `*.workers.dev` origin;
leaving both open closes nothing. `deploy` then smoke-tests the inverse
property: an unauthenticated 200 fails the run. Behind that application every
request carries an assertion the Worker must verify, so `stagingAccessTeam` and
`stagingAccessAud` render `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` into the
staging Worker's `vars` — and only there: without them the gate refuses the
assertion and `/admin/setup` answers 403, which `deploy` warns about. Both
accounts are live between steps three and four, which is what
`productionAccountId` is for; `shopctl repo` gives each GitHub environment its
own `CLOUDFLARE_ACCOUNT_ID`.

`destroy` is irreversible and shaped by it: the shop's slug typed out (not
`--yes`, which becomes a reflex), `--yes` on top in production, read-before-
write, the database deleted LAST and only once everything else is gone, and a
non-empty bucket's refusal relayed rather than worked around.

`repo` wraps `gh`, and that is forced rather than preferred (ADR 0014): a GitHub
environment secret is a libsodium sealed box (X25519 + Blake2b +
XSalsa20-Poly1305) and Node 22 has no XSalsa20-Poly1305, so a dependency-free
CLI cannot encrypt one at all. It creates the repository — derived as `<owner>/shop-<slug>` when neither
`--origin` nor the tree's remote names one, and announced before it is created
— pushes, creates both environments and sets their Cloudflare secrets;
idempotently, asking GitHub first. Secrets are REWRITTEN rather than kept, the opposite of the Cloudflare
rule, because GitHub never returns a secret's value: "already there" cannot be
read as "already correct".

`deploy` follows plan §5.5 in order: resources, config, `npm run verify`,
bookmark (production), migrations, build, upload, deferred secrets, smoke test.
The smoke test can fail the command, and an unreachable site is a failure, never
a pass. `.github/workflows/deploy.yml` runs the same commands behind a GitHub
Environment so production waits for a reviewer.

`backup` and `restore` are the operations half of jalon 8 (plan §5.6, ADR 0005),
and the section below is the whole story.

`core` and `fleet` are the upgrade path (jalon 9, ADR 0016). A shop's version is
read from its GIT HISTORY — the newest `v<semver>` tag merged into HEAD — never
from `coreVersion`, which is a claim `core status` exists to check. An upgrade
fetches the tag, branches `socle/<tag>`, merges, bumps the manifest, re-renders
the generated files, runs the gates the shop now carries, and with `--open-pr`
opens the pull request. It never deploys and never merges a pull request:
production stays behind the GitHub Environment. It refuses a dirty tree, a
downgrade, and a version that rewrites a published migration (ADR 0006); a
conflict is named file by file WITH its ownership and left in the tree, because
resolving it is git work there. The fleet is DECLARED in `fleet.json` next to
the shops — never discovered by scanning, because the command writes — and one
failing shop does not stop the others.

Publishing a core version is a gate, not a convention: the version lives in
`package.json`, in the witness manifests AND in `docs/migrations/v<x>.md`, and
bumping one alone produces a shop that merges the tag and then fails its own
manifest gate. `npm run check:release` holds the three together on every commit;
`node scripts/check-release.mjs --set <version>` writes all three; the `Release`
workflow tags after the full suite and a clean-clone build. "Is this tag free?"
is asked of ORIGIN, not of the clone, and the answer says which: a checkout made
without tags answers "no such tag" for a tag the repository publishes, and a
gate built on that frees a version number that is taken.

Tests: `test/scripts/shopctl.test.mjs` (creation), `repo.test.mjs` (forge),
`fleet.test.mjs` (core upgrade, fleet, pull requests) and `release.test.mjs`
(the publication gate),
`provision.test.mjs`, `deploy.test.mjs` and `destroy.test.mjs` (account,
environment, deployment, teardown), `nightly.test.mjs` (the nightly workflow
as text), `monitor.test.mjs` (the supervision,
against `test/fixtures/graphql-double.mjs` in its own process), `backup.test.mjs` and `restore.test.mjs`
(the archive and the round trip), `privacy.test.mjs` (the map, the erasure and
the second buyer who must not be touched), run by `npm test` and `npm run verify`. The first builds a real core from this repository's index,
tags it, and runs the real binary against it. The last two install
`test/fixtures/wrangler-double.mjs` at `node_modules/.bin/wrangler` in a
throwaway shop, and `test/fixtures/gh-double.mjs` on the PATH where `gh` would
live, against a real git repository whose GitHub remote is rewritten to a local
bare one by `url.<path>.insteadOf`. The real argument construction, the real
output parsers and the real exit codes are exercised — only the accounts are
imaginary.

## Supervision and runbooks

`docs/operations/` is what an operator opens when something is wrong: one
runbook per incident, and the client exit procedure. A runbook names real
commands; when you change one of them (a flag, a table, a route), change the
runbook in the same commit.

`shopctl monitor --env <env>` is the supervision, and it is a command because
Cloudflare's notification catalogue has no alert for a Worker's error rate,
its CPU time or a D1 quota on the plans a shop runs on. It reads the GraphQL
Analytics API (`CLOUDFLARE_API_TOKEN`, Account Analytics: Read), fails at 1 %
errors or at 70 % of a Workers Free quota, and treats an unreachable or
refusing API as exit 5 — never as a quiet night. The endpoint follows
`CLOUDFLARE_API_BASE_URL`, the variable wrangler honours, which is how the
suite points it at its double.

## Backup and restore

`shopctl backup` / `shopctl restore` are the shop's way out of a bad day and out
of the agency: a restore into another Cloudflare account is what makes a client's
exit possible at all (ADR 0005). Two shortcuts are ruled out for good, and the
design is downstream of that. **D1 Time Travel** is a short-term net inside ONE
account — no R2, no long retention, no cross-account restore. And **`wrangler d1
export` fails outright** on a database carrying FTS5 virtual tables, which this
one has since migration 0003. So the backup is applicative, table by table.

```
shopctl/src/backup/   schema  dump  crypto  archive   ← pure
                      store                            ← the only file with wrangler in it
```

The split is the same one the catalogue import uses, for the same reason: it is
what lets `--dry-run` be the same code path as the real thing.

Six properties hold, and each one is a test:

- **the table list is DERIVED from `sqlite_master`.** A list written in a source
  file stops being complete at the first migration nobody updates it for, and
  the table missing from the list is the table missing from the archive —
  silently, until a restore. Left out: `sqlite_*`, `_cf_*`, `d1_migrations`
  (that is the schema, not the data), and the FTS5 index with its shadow tables,
  which migration 0003's triggers rebuild as the rows go back in.
- **an archive is a directory of ordinary files** — `manifest.json` in the clear,
  `data.bin` (gzip then AES-256-GCM), `objects/<hash>.bin` per R2 object. The
  manifest carries the schema version, per-table row counts and checksums, and
  the R2 inventory, so `backup list` and `backup verify` answer WITHOUT the key
  and without decrypting a hundred bodies to find one.
- **the cleartext manifest is authenticated with the body.** It is the GCM
  additional data, so an archive cannot be re-labelled to claim another shop,
  another environment or another schema — it simply stops opening. `cipher` and
  `data.digest` are produced BY sealing and are therefore outside that cover;
  the digest is a corruption check for a keyless reader, never an authentication.
- **the R2 inventory comes from the ROWS, not from the bucket.** `media` owns a
  stored image (invariant 10) and a deliverable is named by the product that
  sells it; wrangler has no "list a bucket" command anyway. A key referenced with
  no `media` row behind it is reported as an orphan, never invented.
- **a restore proves itself.** It re-reads the database it just wrote and
  compares it table by table against the archive's digests. A difference fails
  the command and names the table. Generated columns (`orders.refunded_cents`,
  migration 0025) are captured and compared but never written — SQLite refuses an
  INSERT that names one — which makes the comparison a statement about the
  target's own expression.
- **retention is bounded and both bounds must agree.** `backup prune` drops an
  archive only when it is BOTH older than `--keep-days` and beyond `--keep`: a
  shop that stopped being backed up must not lose its last archive to an age rule.

`restore --local` writes into the tree's own `.wrangler/state` instead of an
environment: no account, no resource, the same comparison at the end. It is
how the nightly run proves the archive it just took still opens and still
restores, on a runner that is thrown away. It refuses a production archive —
that is buyers' personal data, and a laptop is not where the register says it
goes. The wrangler double keeps `--local` apart from the account the way
wrangler does (`.wrangler/state` in the tree), so the suite can tell the two
targets apart.

What CI takes does not stay on the runner. `backup --upload` copies the sealed
files into the environment's private `-backups` bucket (manifest last, so a
half-copied archive has no manifest), and `backup pull <id>` brings one back and
checks it as `verify` would. `deploy --env production` takes one, uploads it and
only then migrates (plan §9) — no flag skips that. The bucket's lifecycle rule is
`--keep-days`' 90, and it is an AGE rule only: R2 cannot count, so the "never
lose the last one" half of `prune` does not hold there. What holds it instead is
the nightly run failing loudly — a nightly that stopped is an incident, not a
quiet week. The CI's key is the operator's, placed by `shopctl repo` and KEPT
when already there: archives are encrypted with it.

Gotchas that cost an afternoon:

- **"empty" is not "zero rows".** Migration 0040 seeds the four French legal
  pages, so a database provisioned five minutes ago already has rows. The
  restore's emptiness guard ignores tables the migrations themselves write into,
  and that list is derived from `migrations/*.sql` (`seededTables`).
- **the key is never an argument.** `.shopctl/backup.key` (0600, gitignored) or
  `SHOPCTL_BACKUP_KEY`. `backup keygen` never prints it and never overwrites an
  existing one — that key is the only thing that opens the archives taken with it.
- **`capture()` takes a `maxBuffer`.** Node truncates a child's output at 1 MiB
  and reports it as ENOBUFS. The table reads are the one caller whose output is
  the merchant's whole database; they pass an explicit limit and page anything
  over 5 000 rows.

## Erasing one buyer

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

## The catalogue import

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

## The browser gate

`npm run test:browser` builds the Worker, boots it on a seeded, isolated D1, and
drives it with Playwright (`playwright.config.mjs`, specs in `test/browser/`).
It is NOT in `npm run verify`, deliberately: `verify` is what a shop runs on a
laptop and in the deploy path, and it must not need a 150 MB browser download to
answer. CI gives it its own job per theme.

It exists because the container contracts are structurally blind to a whole
class of defect. They render a component from props and assert on the markup —
no stylesheet is applied, no client script runs, nothing has a width. So the
storefront could (and did) ship a live-price script that rewrote `24,00 €` to
`€24.00`, a gallery whose thumbnails were anonymous "link"s, a scroll region no
keyboard could reach, and a header that pushed the cart off a phone screen — all
with every gate green.

What it asserts, and why each one is here rather than in vitest:

- **axe** (`a11y.spec.mjs`) — WCAG 2.1 A/AA on every storefront route, both
  sizes. Scoped to those four tags on purpose: axe's best-practice set contains
  judgement calls a design may disagree with, and a gate that fires on those
  gets exclusions added until it fires on nothing.
- **keyboard** (`keyboard.spec.mjs`) — Tab reaches the cart before the grid, and
  every focus stop is visible. Focus visibility is asserted as a DIFFERENCE
  between the focused and blurred computed styles, not as "has an outline":
  a theme that lights its search field's wrapper through `focus-within:` is
  perfectly good and would fail a property allowlist. Transitions are disabled
  for that measurement — otherwise a synchronous read after `blur()` returns the
  value the transition is leaving from.
- **no JavaScript** (`cart.spec.mjs`) — invariant 1 as a test. The catalogue
  renders, images are visible (the fade enhancement must not hide them), and
  adding to the cart is a real POST form.
- **reflow** (`responsive.spec.mjs`) — zero horizontal overflow on every route at
  both viewports, at 200 % zoom, and with a long store name and a long product
  name injected. WCAG 1.4.10's own 320 px bar is measured but not gated; see
  the jalon-5 État in the plan for what fails it and why that is a design call.
- **states** (`states.spec.mjs`) — empty catalogue, sold out, low stock, and six
  hostile search queries. FTS5 `MATCH` throws on raw input, so the sanitizer is
  one refactor away from a 500 on an apostrophe.
- **design signature** (`design-signature.spec.mjs`) — visual regression as the
  COMPUTED style of ten probes, committed per theme under
  `test/browser/__signatures__/` for the shipped themes and under the shop's
  `client/signatures/` for its own theme (`shopctl new` seeds it from the
  reference theme's). Not `toHaveScreenshot`: a PNG baseline is only
  meaningful against the renderer that recorded it, so it needs a pinned
  container or it reports failures nobody caused — and this repository already
  spends a workflow measuring one flake. What actually regresses in a
  token-driven design is a token, and that is what this records. Colours are
  recorded as sRGB bytes, resolved through a 1×1 canvas: Tailwind compiles an
  alpha modifier (`bg-paper/85`) through `color-mix(in oklab, …)`, and the
  computed `oklab()` carries implementation-defined float precision that differs
  between Chromium builds. Re-record a deliberate change with
  `THEME=<id> UPDATE_SIGNATURE=1 npm run test:browser -- design-signature`.

Chromium comes from `npx playwright install chromium`. On a machine that already
has one and cannot download another, `test/browser/chromium.mjs` falls back to
whatever is under `PLAYWRIGHT_BROWSERS_PATH` and says so.

## The security gate

`npm run test:security` (inside `npm run verify`, via `test:integration`) runs
`test/integration/security.mjs` against the BUILT Worker on a database made from
the real migrations. Thirty-six checks: the admin door, Cloudflare Access,
Turnstile, form origin, sessions, brute force, unauthorized downloads,
uploads, path traversal, response headers, and what the Worker prints.

Three things about it are worth knowing before you touch it.

**It boots the Worker IN PROCESS, with Miniflare** (`test/helpers/built-worker.mjs`),
where the storefront-baselines and D1 gates open a `wrangler dev` session and
talk to it over a port. Two reasons, both load-bearing. The suite trips the rate
limiter on purpose, and the dev proxy loses connections under exactly that kind
of burst — the fault `run-d1-integration.sh` exists to re-run around. And it
needs two things a port cannot give: `handleRuntimeStdio`, so the log assertions
can read what the Worker printed, and `outboundService`, so a provider can be
made to answer with a customer's own address in its error body. Without the
second, the PII section would assert over an empty log.

**The admin routes are DERIVED, not listed.** The suite walks
`src/pages/admin` and `src/pages/api/admin`, turns the file paths into URLs and
reads the `export const GET|POST|…` lines for the verbs. Add an endpoint and it
is covered by the next run. Do not replace that with a list.

**The PII assertions have guards against passing vacuously.** They assert that a
delivery was actually attempted and that the failure was actually logged BEFORE
they assert that the customer is absent from the log. If you change the e-mail
configuration the section sets up, those guards are what will tell you.

Two rules the gate enforces that are easy to break by accident:

- `public/_headers` and `src/features/http/securityHeaders.ts` are one list in
  two places. Cloudflare's asset server answers `/favicon.svg`, `/placeholder.*`
  and `/_astro/*` ahead of the Worker, so the middleware never sees them. Add a
  header to one and `test/scripts/security-headers.test.mjs` will make you add
  it to the other.
- An error that reaches a log goes through `logSafe()`
  (`src/features/observability/logSafe.ts`) on any path that touches a customer.
  It masks e-mail addresses and guest access tokens. It is NOT a general PII
  detector — a street address has no shape — so free-form provider text is kept
  out of the message at the source instead (see `features/email/resend.ts`).

## The remote gates

`test/remote/` holds the scripts that talk to a shop that EXISTS — the staging
of the certification campaign, or a production after a deploy — rather than to
a Worker this repository boots. Everything comes from the environment, never
from an argument: `BASE_URL`, and behind a private preview
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (`test/remote/target.mjs`).

- `npm run test:security:remote` — the half of the security gate that needs
  nothing but HTTP: the admin routes (derived from the files, through the same
  `test/helpers/admin-routes.mjs` the local gate uses), the wizard, a forged
  Access assertion, form origin, path traversal, headers on every class of
  response including static assets, capability URLs, an unhandled error.
  Behind Access the service token rides on every request, so "anonymous" means
  anonymous to the Worker's own gate — and an admin guarded by Access alone,
  which a service token would open, fails it.
- `npm run test:browser:remote` — the browser gate against `BASE_URL`.
  `test/browser/remote-routes.mjs` finds the kinds of page the specs need in
  the merchant's catalogue (once per run, through `MINSHOP_REMOTE_FIXTURE`),
  and a kind it does not find is a skip with its reason, never another page.
  The service token goes ONLY to the shop's origin (`test/browser/fixtures.mjs`
  routes it), never through `extraHTTPHeaders`, which would hand it to every
  third party the page loads. Specs import `test`/`expect` from there.
- `npm run test:load:remote` — twenty shoppers, fifteen minutes. Every shopper
  shares one IP, so search is paced at half its limiter and a 429 is counted
  apart; one 5xx fails the run. No checkout: that holds stock.
- `npm run test:last-unit:remote -- --product <slug>` — five checkouts on a
  stock checked to be 1 first (an order of a million units is refused with the
  real count and reserves nothing).
- `npm run test:stripe:remote` — a Stripe test session expired through
  Stripe's API, and the webhook must give the unit back. TEST keys only.
- `npm run test:email:remote` — the admin's test e-mail, through the login
  when the admin has a password; the recipient is masked in the output.

None of them has met a real Worker for the first time on the day it matters:
`test/integration/remote-gates.mjs` (in `npm run verify`) runs each one over a
real port against the BUILT Worker — the security gate red on a bootstrap
shop and green in both admin modes; the others on a configured shop, with
Stripe and Resend stood in for by this process. That runner spawns
ASYNCHRONOUSLY on purpose: the stand-ins answer from the parent, and a
`spawnSync` would deadlock the Worker on them.

`.github/workflows/nightly.yml` strings them together every night (plan
§7.3): everywhere, `npm run verify` on a clean D1 and `npm audit`; in a shop
repository, against staging, backup, `restore --local`, the remote gates,
`shopctl monitor`, Stripe and e-mail — and `shopctl monitor --env production`,
the one production read, with a repository-level analytics-read token
(`MONITOR_CLOUDFLARE_API_TOKEN`) rather than through the `production`
environment, whose reviewers would hold every night. A check whose credential
is absent is skipped with a warning, never passed silently.
`test/scripts/nightly.test.mjs` pins what makes it safe: staging only but for
that read, shopctl
rather than raw wrangler, `pipefail` under every `tee`, no expression
substituted into a script, and the archive never uploaded as an artifact.

## The tenant-isolation gate

`npm run test:tenant-isolation` (`test/scripts/tenant-isolation.test.mjs`, and
inside `vitest run`, so inside `npm run verify`) builds the two witness shops of
plan §2.3 **in one imaginary Cloudflare account and one imaginary forge**, then
asserts plan §8.3: two repositories, two themes, two Workers, two databases,
six buckets per pair of environments, no shared secret, no crossed data.

The arrangement is the point. Every other suite here tests ONE shop, and the
defect this gate exists for is a shop that is correct alone and wrong beside
another: a resource name that does not carry the slug, a credential read from
the environment instead of from the shop, a `wrangler.jsonc` rendered for one
shop and left on disk while a command writes for the other. None of those fail a
single-shop suite. Two accounts, or two temporary directories, would prove only
that two directories are separate — so `shop()` takes `account:` and
`forgeAccount:` (`test/helpers/provisioned-shop.mjs`) and both shops join one.

Two things follow from that when you edit it:

- **the witnesses are read from their real manifests**
  (`test/fixtures/clients/`), not invented in the test. Their asymmetry is what
  makes them worth having: one declares an account id, a staging domain and a
  theme the core does not own; the other declares none of the three, so its
  account arrives by flag. A value only one of them declares is where a
  hard-coded assumption hides.
- **the D1 binding is `DB` in every shop of the fleet**, which is exactly why
  cross-tenant writes are possible at all: the rendered `wrangler.jsonc` on disk
  is what decides which database a write lands in. The gate therefore also
  asserts a REFUSAL — `shopctl catalog import` stops when the tree's
  configuration names another shop or another environment — and not only the
  absence of rows afterwards.

The Cloudflare account and the forge are doubles. What runs for real is
everything else: the commands, the renderers, the forty-three migrations and the
witness catalogue. The §8.3 lines about DEPLOYED shops are re-run on real
accounts in the final campaign; this gate holds the half that regresses, at
every commit.

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
    i18n/      locale (leaf constants) · messages (fr catalog) · index (t/tn) · format
    legal/     terms (consent gate) · vat (TTC split)
    auth/      access (CF Access JWT) · session (admin login cookie) · turnstile · Turnstile.astro
    catalog/   serialize · http  (public API shapes for /api/products)
    cart/ categories/ customers/ media/ pages/
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
`LocaleCatalog` can't omit one. `test/i18n/` compiles two deliberately-broken
fixtures to prove it still fails. What the compiler can't see —
typographic apostrophes, the narrow no-break space (U+202F) before `? ! ; :`,
accents — `messages.test.ts` asserts.

`locale.ts` is a LEAF with no imports, which is what lets `money.ts` (documented
as import-free so pure code can use it) format in `fr-FR`. Store-owned templates
may import the catalog directly — it's the fourth entry on the storefront
boundary allowlist, beside models and controls.

The **admin stays in English** (ADR 0011) and `AdminLayout` keeps `lang="en"` on
purpose; money and dates still format in the store's locale everywhere.

**Terms of sale.** `features/legal/terms.ts` holds ONE predicate: the checkout
checkbox renders and the server refuses exactly when the terms page is
published. A shop is created with its four legal pages as drafts (migration
0040), so the gate is open until the merchant finishes writing them. The
acceptance and the VAT rate ride on the reservation — the only row spanning the
checkout request and the settlement webhook — and `recordPaidOrder` copies both
onto the order. Refusal happens BEFORE the stock hold.

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
    you chose; an error from a provider goes through `logSafe()`. A provider's
    error body is text it wrote about a customer — Resend's names the
    recipient — so never interpolate one into a message, and never
    `console.error('…', err)` on a path that touches an order, an address or an
    account. Logs outlive the order.
13. **A stored file is what its bytes say it is.** `File.type` comes from
    whoever posted the multipart body. Every upload path validates through
    `validateUpload()`, which reads the header (`features/media/sniff.ts`);
    `validateUploadMetadata()` alone is the cheap pre-check, not the rule.

## Recipes — how to add X

- **A product field:** new migration (`ALTER TABLE products ADD COLUMN …`) →
  update `Product`/`AdminProduct` + queries in `features/products/db.ts` → add to
  `ProductForm.astro` + `parseProductForm` in `features/products/form.ts`. If the
  catalogue CSV should carry it too, add a `COLUMNS` entry in
  `shopctl/src/catalog/contract.mjs` and the field to `PRODUCT_FIELDS` in
  `catalog/plan.mjs` — the generated `imports/README.md` and its gate derive from
  that list.
- **A content page:** nothing to add — merchants create them at `/admin/pages`.
  Published pages appear at `/pages/<slug>`, in the footer, sitemap, and
  `llms.txt` automatically.
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
  `npm run db:migrate` (local) → `npm run db:migrate:remote` (prod, before deploy).
- **An admin page:** `src/pages/admin/<x>.astro` using `AdminLayout` (add a nav
  entry there). Mutations go through `/api/admin/*` (covered by the auth gate).
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
  `cloudflare:workers` can't be loaded by a plain Node script, which is why the
  settlement path went untested for so long. Run the script as
  `node --experimental-strip-types --import ./test/helpers/register-workers-loader.mjs …`
  and call `setWorkersEnv({ DB })` (from `test/helpers/workers-env.mjs`) BEFORE
  the dynamic `import()` of the module under test — the loader resolves
  `cloudflare:workers` to that object, so the code under test is unchanged.
  `applyMigrations(db)` from `test/helpers/d1-schema.mjs` gives the suite the
  real 43-migration schema instead of a hand-written subset that drifts.
  `test/integration/settlement.mjs` is the worked example.

## Gotchas — preflight checklist

These cost afternoons. Most are in the README "Gotchas" section too.

- **Node ≥ 22.12** (`nvm use 22`). Use Node 22 (the tested/supported release line).
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
- **`wrangler d1 export` fails with FTS5 virtual tables** — drop `products_fts`,
  export, recreate (re-run migration `0003`).
- **Static assets never reach the middleware.** Cloudflare's asset server answers
  `/favicon.svg`, `/placeholder.*` and `/_astro/*` before the Worker runs, so a
  header added in `src/middleware.ts` does not apply to them. `public/_headers`
  is the other half; `test/scripts/security-headers.test.mjs` keeps the two in
  step.
- **The `mcp/` Worker has its OWN `package.json` + `node_modules`.** Never add
  `agents` / `@modelcontextprotocol/sdk` to the ROOT package.json — the Agents SDK
  pulls in workerd/miniflare deps that silently break the storefront's Astro build
  ("require_dist is not a function" in the CF Vite plugin). Install MCP deps in
  `mcp/` only. Build it independently with `npm run mcp:check` (`npm run verify`
  also includes it).

## Conventions

- Comments explain *why*, match surrounding density. No attribution in commits.
- Colocate tests: `foo.ts` + `foo.test.ts`. Test pure logic; integration (D1/R2)
  is verified against `wrangler dev`.
- Don't install npm packages without asking. Don't run deploy/publish commands
  unless explicitly told.
- After non-trivial UI changes, screenshot to verify (see README → Frontend
  Testing). Screenshots to `/tmp`, deleted after.
