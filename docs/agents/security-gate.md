# The security gate

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on the security gate, response headers, logs or the admin door.

`npm run test:security` (inside `npm run verify`, via `test:integration`) runs
`test/integration/security.mjs` against the BUILT Worker on a database made from
the real migrations. Its checks cover the admin door, Cloudflare Access,
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

**Two limiters, two jobs.** Cloudflare's rate limiting binding
(`features/auth/rateLimit.ts`) holds search, checkout and the login routes
against a flood; it counts per location and caches per machine, and on a
deployed shop it let a patient guesser through (certification, step 5). The
admin password is therefore counted exactly in D1 as well
(`features/auth/loginThrottle.ts`, migration 0044): five attempts per client
network per quarter of an hour, counted BEFORE the password is checked, in one
statement. The brute-force section proves it with a parallel burst, each
client given its own `cf-connecting-ip` so the edge limiter never answers
first — every 429 there carries the counter's Retry-After, never the edge's 60.

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
