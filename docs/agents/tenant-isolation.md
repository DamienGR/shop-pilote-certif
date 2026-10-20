# The tenant-isolation gate

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on the tenant-isolation gate or resource naming.

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
- **a teardown finds its resources by name on a shared account.** The gate
  ends by destroying the canary's staging and checking that exactly its six
  resources left — Worker, sessions namespace, three buckets, database — and
  that the pilot's catalogue and images did not move. It runs last because it
  changes the world every other test reads.

The Cloudflare account and the forge are doubles. What runs for real is
everything else: the commands, the renderers, every migration and the
witness catalogue. The §8.3 lines about DEPLOYED shops are re-run on real
accounts in the final campaign; this gate holds the half that regresses, at
every commit.
