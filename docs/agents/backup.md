# Backup and restore

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on `shopctl backup` / `shopctl restore`.

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
  stored image (invariant 10 in AGENTS.md) and a deliverable is named by the product that
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
