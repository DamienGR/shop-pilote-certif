# The client manifest

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on a client manifest or how a shop renders.

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
