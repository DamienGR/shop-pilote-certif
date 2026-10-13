/**
 * Who owns which file (plan §3.3).
 *
 * A shop is a clone of a core tag that receives core updates by merge for the
 * life of the contract (ADR 0003). That only works if the boundary between what
 * the agency maintains and what the merchant customizes is written down
 * somewhere both a human and a merge can consult. Here.
 *
 *   core       the agency's. Payment, stock, auth, migrations, tooling.
 *              A shop may edit one — it is an ordinary file in its repository —
 *              but never as an unremarked "customization": every core edit is a
 *              divergence to re-resolve at the next upgrade.
 *   client     the merchant's. Manifest, theme, content, assets. The core never
 *              edits these, which is what keeps an upgrade merge conflict-free.
 *   generated  a tool's. Regenerated from a source of truth; an unexpected diff
 *              means the generator ran, not that someone decided something.
 *
 * FIRST rule wins, so the specific ones come first. There is no catch-all: a
 * new top-level directory is unclassified, which fails check-paths.mjs and
 * forces the decision to be made once, deliberately, instead of inherited from
 * whichever rule happened to be last.
 *
 * .github/CODEOWNERS is generated from this list — see renderCodeowners().
 */
import { RESERVED_THEME_IDS } from './themes.mjs';

/**
 * Reviewers for everything the agency owns.
 *
 * A generated shop replaces this with its own agency team; it is a constant
 * rather than a config file because a shop that could quietly empty it would
 * quietly remove the review requirement it exists to state.
 */
export const CORE_OWNERS = ['@DamienGR'];

export const OWNERS = ['core', 'client', 'generated'];

/**
 * @typedef {object} OwnershipRule
 * @property {string} pattern glob, `*` matching within a segment and `**` across
 * @property {'core'|'client'|'generated'} owner
 * @property {string} why what breaks if the file changes hands
 * @property {string|null} codeowners path form for .github/CODEOWNERS, or null
 */

/** @type {OwnershipRule[]} */
export const OWNERSHIP_RULES = [
  {
    pattern: '.github/CODEOWNERS',
    owner: 'generated',
    why: 'Rendered from this file by check-paths.mjs.',
    codeowners: '/.github/CODEOWNERS',
  },
  {
    pattern: 'schemas/*.schema.json',
    owner: 'generated',
    why: 'Rendered from scripts/manifest-schema.mjs; committed so editors can validate a manifest.',
    codeowners: '/schemas/',
  },
  {
    pattern: 'wrangler.jsonc',
    owner: 'generated',
    why: 'Rendered from wrangler.template.jsonc for one instance. Hand edits are lost at the next render.',
    codeowners: '/wrangler.jsonc',
  },

  {
    pattern: 'client/**',
    owner: 'client',
    why: 'The shop manifest and everything non-sensitive that belongs to the merchant.',
    codeowners: '/client/',
  },
  {
    pattern: 'theme.config.json',
    owner: 'client',
    why: 'Which design this shop compiles.',
    codeowners: '/theme.config.json',
  },
  {
    pattern: 'src/store.config.ts',
    owner: 'client',
    why: 'Build-time shop settings. Upstream never edits it, so an upgrade never conflicts here.',
    codeowners: '/src/store.config.ts',
  },
  {
    pattern: 'src/styles/overrides.css',
    owner: 'client',
    why: 'The post-theme override layer, normally empty upstream.',
    codeowners: '/src/styles/overrides.css',
  },
  {
    pattern: 'public/_headers',
    owner: 'core',
    why:
      'Response hardening for the assets Cloudflare serves ahead of the Worker. ' +
      'Sits under public/ because that is where the asset server reads it, but it ' +
      'is a security control, not a brand asset: src/features/http/securityHeaders.ts ' +
      'and test/scripts/security-headers.test.mjs hold it to the middleware\'s list.',
    codeowners: '/public/_headers',
  },
  {
    pattern: 'public/**',
    owner: 'client',
    why: 'Favicon and static brand assets.',
    codeowners: '/public/',
  },
  {
    pattern: 'imports/**',
    owner: 'client',
    why: 'Catalogue sources: the shop\'s CSV and the media it references. Created by `shopctl new`, never read at runtime.',
    codeowners: '/imports/',
  },
  // Ordering note: the reserved themes below are listed AFTER this rule in
  // CODEOWNERS (last match wins there) and BEFORE it here (first match wins),
  // which renderCodeowners() gets right by emitting the list in reverse.
  ...RESERVED_THEME_IDS.map((id) => ({
    pattern: `src/themes/${id}/**`,
    owner: 'core',
    why: `Shipped design "${id}". A shop customizes its own theme, never this one, or the next upgrade conflicts.`,
    codeowners: `/src/themes/${id}/`,
  })),
  {
    pattern: 'src/themes/*/**',
    owner: 'client',
    why: "The shop's own design.",
    codeowners: '/src/themes/*/',
  },

  {
    pattern: 'src/**',
    owner: 'core',
    why: 'The application: routes, features, middleware, configuration schema.',
    codeowners: '/src/',
  },
  { pattern: 'migrations/**', owner: 'core', why: 'Schema history. Never rewritten, never per-shop.', codeowners: '/migrations/' },
  { pattern: 'scripts/**', owner: 'core', why: 'Build, provisioning and gate tooling.', codeowners: '/scripts/' },
  { pattern: 'test/**', owner: 'core', why: 'The certification suite, including the witness fixtures.', codeowners: '/test/' },
  { pattern: 'mcp/**', owner: 'core', why: 'The MCP worker, a separate deployable of the core.', codeowners: '/mcp/' },
  { pattern: 'create-minshop/**', owner: 'core', why: 'The upstream scaffolder package.', codeowners: '/create-minshop/' },
  { pattern: 'shopctl/**', owner: 'core', why: 'The agency CLI. A shop keeps it: that is what operates the shop.', codeowners: '/shopctl/' },
  { pattern: 'docs/**', owner: 'core', why: 'Architecture decisions and the implementation plan.', codeowners: '/docs/' },
  { pattern: '.github/**', owner: 'core', why: 'CI, and therefore every gate a release passes.', codeowners: '/.github/' },
  {
    // Root files: package manifests, build configuration, licence, the read-me
    // family. Matching within the segment only, so nothing below a directory
    // reaches this rule.
    pattern: '*',
    owner: 'core',
    why: 'Toolchain, build configuration and project documentation at the root.',
    codeowners: null,
  },
];

/**
 * Glob match. `*` stops at a `/`; `**` crosses them. Small on purpose: the
 * patterns above are the only ones it ever sees, and a dependency here would
 * be a dependency of every CI gate.
 */
export function matchGlob(pattern, path) {
  const source = pattern
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(path);
}

/**
 * Classify one repository-relative path.
 * @returns {{ owner: string, rule: OwnershipRule }|null} null when no rule matches
 */
export function classifyPath(path, rules = OWNERSHIP_RULES) {
  for (const rule of rules) {
    if (matchGlob(rule.pattern, path)) return { owner: rule.owner, rule };
  }
  return null;
}

/**
 * Classify a whole list of paths.
 * @returns {{ owned: Record<string, string[]>, unclassified: string[] }}
 */
export function classifyPaths(paths, rules = OWNERSHIP_RULES) {
  const owned = Object.fromEntries(OWNERS.map((owner) => [owner, []]));
  const unclassified = [];
  for (const path of paths) {
    const hit = classifyPath(path, rules);
    if (hit) owned[hit.owner].push(path);
    else unclassified.push(path);
  }
  return { owned, unclassified };
}

/**
 * .github/CODEOWNERS, rendered from the rules above.
 *
 * Generated rather than maintained because the two would drift, and the drift
 * is invisible: CODEOWNERS is only consulted by GitHub, at review time, on
 * somebody else's pull request.
 *
 * CODEOWNERS is LAST-match-wins where the rules above are first-match-wins, so
 * the list is emitted in reverse. Client paths are emitted with no owner, which
 * is how CODEOWNERS says "no review required" — the merchant's own files are
 * not the agency's to approve.
 */
export function renderCodeowners(rules = OWNERSHIP_RULES, owners = CORE_OWNERS) {
  const suffix = owners.join(' ');
  const lines = [
    '# GENERATED by scripts/check-paths.mjs from scripts/path-ownership.mjs — do not edit.',
    '#',
    '# Core and generated paths need the agency; the merchant\'s own files do not',
    '# (a path with no owner requires no review). Last match wins, so the list runs',
    '# from general to specific — the reverse of the rule order in the source.',
    '',
    `* ${suffix}`,
    '',
  ];

  for (const rule of [...rules].reverse()) {
    if (!rule.codeowners) continue;
    const owner = rule.owner === 'client' ? '' : ` ${suffix}`;
    lines.push(`# ${rule.owner}: ${rule.why}`);
    lines.push(`${rule.codeowners}${owner}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The core-change gate, as a pure function.
 *
 * Split out for the same reason deploy-plan.mjs is: the rule it encodes is a
 * safety property, and safety properties need regression tests. A test cannot
 * usefully run `git diff` against a synthetic pull request, but it can pin what
 * the answer must be for a given set of changed paths — and this gate is one
 * that, in the core repository, never fires on its own.
 *
 * `isShop` is what decides whether the gate has teeth. In the core repository
 * every change is a core change; a gate that fires on all of them would only
 * teach people to wave it through.
 *
 * `carried` are the changed paths whose content is exactly a core release's,
 * merged in by `shopctl core upgrade`: an upgrade, not a divergence. They are
 * reported, never gated — without them every upgrade pull request needed an
 * approval, and an approval asked on every upgrade is one nobody reads.
 *
 * @param {{ paths: string[], isShop: boolean, approval: {by: string}|null, carried?: string[] }} input
 * @returns {{ ok: boolean, enforced: boolean, core: string[], carried: string[], changed: Array<{path: string, owner: string|null}> }}
 */
export function coreChangeGate({ paths, isShop, approval = null, carried = [] }) {
  const changed = paths.map((path) => ({ path, owner: classifyPath(path)?.owner ?? null }));
  const fromCore = new Set(carried);
  // An unclassified path counts as core: the fail-closed reading is the only
  // one that cannot be exploited by adding a file the rules do not cover.
  const notClient = changed.filter((entry) => entry.owner !== 'client').map((entry) => entry.path);
  const core = notClient.filter((path) => !fromCore.has(path));
  return {
    ok: !isShop || core.length === 0 || approval !== null,
    enforced: isShop,
    core,
    carried: notClient.filter((path) => fromCore.has(path)),
    changed,
  };
}
