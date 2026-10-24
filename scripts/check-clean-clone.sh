#!/usr/bin/env bash
set -euo pipefail

# Clean-room build: does this commit build for someone who has only what is
# COMMITTED?
#
# Every other gate runs in a working tree that has accumulated state — an old
# node_modules, a rendered wrangler.jsonc, generated theme artifacts, a stale
# dist/. Any of those can carry a build that would fail on a fresh clone, and a
# fresh clone is exactly what every client store starts as (plan §3.4: a store
# is created by cloning a tag of the core). A "works on my tree" baseline is not
# a baseline.
#
# So: clone the repository at HEAD into a scratch directory, install from the
# lockfiles, render the tracked Wrangler template with inert ids the way CI
# does, and build. Nothing from the working tree is reachable.
#
# Usage: npm run check:clean-clone [-- --keep]
#   --keep  leave the scratch clone in place for inspection

keep=0
[[ "${1:-}" == "--keep" ]] && keep=1

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/minshop-clean-clone.XXXXXX")"
cleanup() { [[ "$keep" == 1 ]] || rm -rf "$work"; }
trap cleanup EXIT INT TERM

commit="$(git -C "$root" rev-parse HEAD)"
echo "→ cloning $commit into $work"

# A local clone of the repository object store, checked out at HEAD. Uncommitted
# work in the source tree is invisible here — that is the entire point.
git clone --quiet --no-hardlinks --shared "$root" "$work/repo"
git -C "$work/repo" checkout --quiet --detach "$commit"

if [[ -n "$(git -C "$root" status --porcelain)" ]]; then
  echo "  note: the working tree has uncommitted changes; they are NOT part of this build"
fi

cd "$work/repo"

echo "→ npm ci (storefront)"
npm ci --no-audit --fund=false

echo "→ npm ci (mcp)"
npm ci --no-audit --fund=false --prefix mcp

# The real deploy config is per-instance. Render the tracked template with
# schema-valid, inert ids — the same substitution the CI workflow performs.
echo "→ rendering an isolated Wrangler configuration"
sed \
  -e 's/__NAME__/minshop-clean-clone/g' \
  -e 's/__JURISDICTION__/eu/g' \
  -e 's/__WORKERS_DEV__/true/g' \
  -e 's/__ROUTES__/[]/g' \
  -e 's/__IMAGE_BASE_URL__//g' \
  -e 's/__ACCESS_TEAM_DOMAIN__//g' \
  -e 's/__ACCESS_AUD__//g' \
  -e 's/__STORE_NAME__/Ma boutique/g' \
  -e 's/__ENVIRONMENT__//g' \
  -e 's/__DB_NAME__/minshop-clean-clone-db/g' \
  -e 's/__DB_ID__/00000000-0000-0000-0000-000000000000/g' \
  -e 's/__BUCKET__/minshop-clean-clone-images/g' \
  -e 's/__FILES_BUCKET__/minshop-clean-clone-files/g' \
  wrangler.template.jsonc > wrangler.jsonc

echo "→ toolchain"
node scripts/check-toolchain.mjs

echo "→ build"
npm run build

echo "→ deploy dry run and size budgets"
node scripts/check-deploy.mjs

echo "✓ clean clone of $commit installs, builds and is deployable"
[[ "$keep" == 1 ]] && echo "  clone kept at $work/repo"
exit 0
