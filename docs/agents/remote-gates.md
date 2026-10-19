# The remote gates

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on `test/remote/` or the nightly workflow.

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
  which a service token would open, fails it. It also posts unsigned and
  forged events to every webhook (Access lets them through on a bypass, the
  Worker must refuse them), and checks that no page asks for a card number.
  `-- --limiteurs` adds the rate limiters last, tripped to a 429 each. Search
  and checkout are held by Cloudflare's limiter, permissive by design (per
  location, cached per machine), so they are flooded fifty at a time up to
  twenty times their limit; the admin login is held by the shop's exact
  counter (`features/auth/loginThrottle.ts`), so it must refuse the sixth
  guess at the latest, with a Retry-After longer than the edge's minute. It
  costs the operator's own IP a minute of checkout and a quarter of an hour
  of admin login, so it is opt-in.
- `npm run test:logs:remote -- tail.json` — reads a `wrangler tail --format
  json` capture taken while someone buys on the shop, for e-mail addresses,
  guest tokens, credentials and the values in `PII_NEEDLES` (what the tester
  typed; a street address has no shape). Found in a log line, an exception or
  a URL, it fails; in a header or the `cf` metadata — the browser's and the
  edge's, Access's identity included — it is reported, not judged. The report
  names findings and never reproduces one, because it is a committed proof.
- `npm run test:cpu:remote -- tail.json` — reads the same kind of capture for
  the CPU and wall time of each event, grouped by the page file that answered
  it (derived from `src/pages`, so a URL — a guest token, an e-mail in an
  admin path — never reaches the report): first request, p50/p90/p99, max,
  and the count past the Free plan's 10 ms, reported and not judged. An
  invocation Cloudflare stopped (`exceededCpu`, error 1102) fails it. Cold
  and warm come from when the capture is taken — right after a deploy, or
  during the load test. A capture whose events carry no CPU time is exit 2,
  pointing at Workers Logs.
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
