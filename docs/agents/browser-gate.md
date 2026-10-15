# The browser gate

Detail page of [AGENTS.md](../../AGENTS.md), which holds the loop, the
invariants and the rules that apply everywhere. Read this before working on `test/browser/` or a theme's design.

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
- **no JavaScript** (`cart.spec.mjs`) — AGENTS.md invariant 1 as a test. The catalogue
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
