# The `shopctl` CLI

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on `shopctl/`.

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
npm run shopctl -- admin password --env production < fichier   # avant le 1er deploy
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
In PRODUCTION, and only while the shop has never been installed (no
`setup_complete`), it also switches the demo checkout off — the
`payment_methods_disabled` row the admin's Payments card writes. Demo is the
rail a shop falls back to while no real one is configured; behind staging's
Access that is how a fresh shop is tried, on a public production it is an order
form that takes no payment, from the first deploy until Stripe is configured.
Once installed, the setting is the merchant's and a re-run leaves it alone.

`admin password` writes the administration's password hash into an
environment's database: read from STDIN (typed twice without echo, or a file),
hashed by the shop's own `src/features/auth/password.ts` in a child Node with
type stripping, written through `applyScript` and read back. It exists for the
window the first-run wizard opens: until a password exists, `/admin/setup`
answers anyone (bootstrap), and on a production that is whoever reaches the
new domain first. Run after `provision`, before the first `deploy`, the wizard
then opens only after a login. It is also the lost-password reset, without the
public window `scripts/admin-reset.sh` opened
(`docs/operations/runbooks/mot-de-passe-admin.md`).

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
non-empty bucket's refusal relayed rather than worked around — with an
`r2 object delete` that says `--remote`, because wrangler 4 otherwise empties
its local simulator, and the dashboard's Empty Bucket for the keys nobody
printed (wrangler 4 lists no object: a nightly archive, an image uploaded
through the admin). Destroying staging tells the operator to set the repository
variable `STAGING_RETIRED`, which turns the Nightly's staging half off rather
than leaving it red every night. It also removes the sessions KV namespace, which nothing
in the tree names: the Astro adapter binds `SESSION` in the built
configuration and wrangler provisions it at the first deploy as
`<worker>-session`, so `destroy` looks it up on the account by that title.

`repo` wraps `gh`, and that is forced rather than preferred (ADR 0014): a GitHub
environment secret is a libsodium sealed box (X25519 + Blake2b +
XSalsa20-Poly1305) and Node 22 has no XSalsa20-Poly1305, so a dependency-free
CLI cannot encrypt one at all. It creates the repository — derived as `<owner>/shop-<slug>` when neither
`--origin` nor the tree's remote names one, and announced before it is created
— pushes, creates both environments and sets their Cloudflare secrets;
idempotently, asking GitHub first. Secrets are REWRITTEN rather than kept, the opposite of the Cloudflare
rule, because GitHub never returns a secret's value: "already there" cannot be
read as "already correct". A third environment, `backup`, carries the Nightly's
backup of production (ADR 0005's RPO once staging is gone): no reviewer,
limited to the default branch by a deployment branch policy, created even
before it has a token — GitHub creates a missing environment on first use,
open to every branch. Its token comes from `CLOUDFLARE_API_TOKEN_BACKUP` alone,
never the shared one, and a deploying token there is refused: an environment
that asks nobody's approval would bypass production's reviewers.

`deploy` follows plan §5.5 in order: resources, config, `npm run verify`,
bookmark (production), migrations, build, upload, deferred secrets, smoke test.
Only the production render names `cloudflare.imagesDomain` — the domain is
attached to production's images bucket, and a staging or local build that used
it would serve production's objects — so a production `deploy` refuses, before
the backup, a declared domain that is not attached to that bucket: every
product image would link to it.
The smoke test can fail the command, and an unreachable site is a failure, never
a pass. Cloudflare's own answer on a name that leads to no Worker yet — a
`404`, "There is nothing here yet" or `error code: 1042` depending on what the
request accepts, and a comment-only robots.txt — is never read as the shop's:
`deploy` reruns the whole test while it lasts, `--smoke-wait` seconds at most
(120), then fails without advising a rollback. The first deployment on
workers.dev met it in real at certification step 7.
The report's `rollbackTo` is the version serving BEFORE the upload, read from
`wrangler deployments status` while it is still the active one; inferred
afterwards from `versions list`, which is oldest first and capped at ten, it
named a version weeks old (certification step 8). `null` means there was none
to read: a first deployment, or an answer wrangler did not give.
`.github/workflows/deploy.yml` runs the same commands behind a GitHub
Environment so production waits for a reviewer.

`backup` and `restore` are the operations half of jalon 8 (plan §5.6, ADR 0005),
and [backup.md](backup.md) is the whole story.

`core` and `fleet` are the upgrade path (jalon 9, ADR 0016). A shop's version is
read from its GIT HISTORY — the newest `v<semver>` tag merged into HEAD — never
from `coreVersion`, which is a claim `core status` exists to check. A clone only
sees the tags it has fetched, and an upgrade merged on the forge then pulled
from the shop's origin brings none: `core status` names a declared tag the
clone lacks instead of blaming the manifest, and an upgrade fetches the core's
tags BEFORE it reads where the shop is. It then branches `socle/<tag>`,
merges, bumps the manifest, re-renders the generated files, runs the gates the
shop now carries, and with `--open-pr` opens the pull request. It never deploys
and never merges a pull request: production stays behind the GitHub
Environment. It refuses a dirty tree, a
downgrade, and a version that rewrites a published migration (ADR 0006); a
conflict is named file by file WITH its ownership and left in the tree, because
resolving it is git work there. Except on a GENERATED file: nobody chooses
between two outputs of a generator, so the new core's copy is taken and the
upgrade re-renders `wrangler.jsonc` right after — the shop's rendering differs
from the core's own copy from its first line, and conflicts with every version
that edits it. Re-run after a hand resolution, the command resumes on the
upgrade branch, and reads where the step started from the merge's first
parent, never from the newest local tag below the target. The fleet is DECLARED in `fleet.json` next to
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
`admin.test.mjs` (the password, never in an argument),
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
Analytics API (`CLOUDFLARE_API_TOKEN`; the same token reaches wrangler's
`whoami` and `d1 list`, so it needs Account Analytics, D1 and Account
Settings: Read, plus the user's Memberships and User Details: Read), fails at 1 %
errors, at 70 % of a Workers Free quota, or on one invocation Cloudflare
stopped for its limits (error 1102) — the CPU p99 is reported, not judged,
because a cold start runs past 10 ms by construction and the plan tolerates it
per isolate —, and treats an unreachable or
refusing API as exit 5 — never as a quiet night. The endpoint follows
`CLOUDFLARE_API_BASE_URL`, the variable wrangler honours, which is how the
suite points it at its double.
