/**
 * `shopctl new <slug>` — create the repository of one shop.
 *
 * The eleven steps of plan §5.2, in order, with the two that are easy to get
 * subtly wrong called out here because the cost only shows up months later.
 *
 * The core is cloned AT A TAG, WITH ITS HISTORY. Both halves are load-bearing
 * (ADR 0003): the history is what makes the next upgrade an ordinary `git
 * merge` instead of a re-generation, and the tag is what stops a shop from
 * riding an uncertified `main`. A ref that is not an immutable `v<semver>` tag
 * is refused before anything is written — including a branch name that would
 * otherwise clone perfectly and leave the shop tracking a moving target.
 *
 * The manifest is validated BEFORE the clone. Every value a shop chooses is
 * known from the command line, so an unusable one should cost the operator an
 * error message, not a directory, a git history and a red gate.
 *
 * Nothing is deleted from the clone. `create-minshop` strips its own package
 * and the upstream history because it produces a standalone storefront; a shop
 * produced here keeps receiving core tags by merge for the life of the
 * contract, and every file removed at creation is a conflict re-resolved at
 * every upgrade that touches it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { RESERVED_SLUGS, validateManifest } from '../../../scripts/manifest-schema.mjs';
import {
  CLIENT_MANIFEST,
  WITNESS_CLIENTS_DIR,
  detectFleetCollisions,
  discoverManifests,
  loadManifest,
  resourceNames,
} from '../../../scripts/manifest.mjs';
import { setupRepository } from './repo.mjs';
import { assertForgeReady, defaultOwner, gitProtocol, repositoryNameFor, repositoryUrl } from '../forge.mjs';
import { RESERVED_THEME_IDS, SHOP_SIGNATURES_DIR, SIGNATURES_DIR, THEMES_DIR, isValidThemeId, normalizeThemeId } from '../../../scripts/themes.mjs';
import { CORE_ROOT, corePackage } from '../paths.mjs';
import { EXIT_CODES, ShopctlError, inputError, preconditionError, usageError, verificationError } from '../errors.mjs';
import { capture, run } from '../process.mjs';
import { describeGateFailure, runShopGates } from '../gates.mjs';
import { buildManifest, renderManifest } from '../manifest-template.mjs';
import { COLUMNS } from '../catalog/contract.mjs';
import { DELIVERY_MAX_WIDTH } from '../catalog/media.mjs';
import { parseManifestYaml } from '../../../scripts/manifest-yaml.mjs';
import { CORE_TAG, versionFromTag } from '../version.mjs';

// Re-exported: the creation suite pins the tag reading here, where a shop is
// created from one. It is defined once, in version.mjs, next to the ordering
// the upgrade path needs.
export { versionFromTag };

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Documentation domain (RFC 2606) — a placeholder that is unmistakably one,
 *  and that still satisfies the manifest's "not a platform subdomain" rule. */
const PLACEHOLDER_DOMAIN_SUFFIX = 'example.com';

/**
 * Two defaults an AGENCY has and the CORE must not.
 *
 * `MINSHOP_DOMAIN_SUFFIX` turns `--domain` into `<slug>.<suffixe>`, which is
 * what a shop built on the agency's own domain wants during construction.
 * It cannot be a literal in this file: `config:validate` fails on any core file
 * containing a shop's domain, and a core that knows one agency is a core that
 * cannot be sold to a second (ADR 0008). An environment variable is the right
 * home — visible in the shell that set it, unlike a configuration file nobody
 * remembers writing.
 *
 * `CLOUDFLARE_ACCOUNT_ID` is the same variable `provision`, `deploy` and
 * `destroy` already read; reusing it rather than inventing a second one keeps
 * "which account" a single question with a single answer.
 *
 * Both are REPORTED wherever they are used. An account id written into a
 * committed manifest from an ambient variable is exactly the value an operator
 * should see arrive, not discover in a diff.
 */
const DOMAIN_SUFFIX_VARIABLE = 'MINSHOP_DOMAIN_SUFFIX';
const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The domain a slug implies, and where that answer came from. */
export function resolveDomain(slug, flag, env = process.env) {
  if (flag) return { domain: String(flag), from: '--domain' };
  const suffix = String(env[DOMAIN_SUFFIX_VARIABLE] ?? '').trim();
  if (!suffix) return { domain: `${slug}.${PLACEHOLDER_DOMAIN_SUFFIX}`, from: 'placeholder' };
  if (!DOMAIN_SHAPE.test(suffix)) {
    throw inputError(
      `${DOMAIN_SUFFIX_VARIABLE} = « ${suffix} » n'est pas un domaine.`,
      'Attendu : studiomaestro.fr, sans schéma ni barre oblique. Retirez la variable pour retomber sur le placeholder de documentation.',
    );
  }
  return { domain: `${slug}.${suffix}`, from: DOMAIN_SUFFIX_VARIABLE };
}

/** The Cloudflare account a new shop declares, and where that came from. */
export function resolveAccountId(flag, env = process.env) {
  if (flag) return { accountId: String(flag), from: '--account' };
  const ambient = String(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  return ambient ? { accountId: ambient, from: 'CLOUDFLARE_ACCOUNT_ID' } : { accountId: null, from: null };
}

export const NEW_OPTIONS = {
  '--core': 'tag',
  '--from': 'value',
  '--origin': 'value',
  '--name': 'value',
  '--domain': 'value',
  '--email': 'value',
  '--theme': 'value',
  '--from-theme': 'value',
  '--branch': 'value',
  '--dir': 'value',
  '--account': 'value',
  '--reviewer': 'value',
  '--owner': 'value',
};

export const newUsage = `Usage: shopctl new <slug> [options]

  --core <tag>        Tag du socle à cloner (défaut : v<version du socle courant>)
  --from <url|chemin> Dépôt du socle (défaut : le remote "origin" de ce dépôt)
  --origin <url>      Remote "origin" du futur dépôt (défaut avec --create-repo :
                      <owner>/shop-<slug>)
  --name <nom>        Nom affiché (défaut : dérivé du slug)
  --domain <domaine>  Domaine de production (défaut : <slug>.${PLACEHOLDER_DOMAIN_SUFFIX},
                      ou <slug>.$${DOMAIN_SUFFIX_VARIABLE} si la variable est posée)
  --email <adresse>   Expéditeur des e-mails (défaut : commandes@<domaine>)
  --theme <id>        Thème de la boutique (défaut : dérivé du slug)
  --from-theme <id>   Thème de référence copié (défaut : default)
  --branch <nom>      Branche de travail créée sur le tag (défaut : main)
  --dir <chemin>      Répertoire cible (défaut : shop-<slug>)
  --account <id>      Compte Cloudflare de la boutique, écrit dans le manifeste
                      (défaut : $CLOUDFLARE_ACCOUNT_ID)
  --create-repo       Créer le dépôt GitHub, ses environnements et leurs secrets
                      (enveloppe la CLI gh)
  --owner <compte>    Compte ou organisation GitHub du dépôt déduit
  --reviewer <login>  Relecteur obligatoire en production, avec --create-repo
  --no-install        Ne pas installer les dépendances
  --no-verify         Ne pas exécuter la vérification minimale
  --json              Rapport de création lisible par une machine

Ce que le périmètre certifié fixe — locale, devise, marché, juridiction, mode de
checkout — n'a pas d'option : élargir une de ces énumérations est une décision de
version de schéma (ADR 0008), pas un drapeau.
`;

/**
 * Title-case a slug: every hyphen-separated word capitalized, joined by spaces.
 *
 * No worked example here, and that is not squeamishness: `config:validate`
 * fails on a CORE file that contains any shop's slug or display name, so an
 * example slug written into this file is a landmine for whoever later picks
 * that name. Only a starting point anyway — the operator passes --name for
 * anything with real typography.
 */
export function displayNameFromSlug(slug) {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The theme id this shop's own design will live under.
 *
 * A shop never edits a shipped theme: that separation is what keeps a core
 * upgrade from colliding with the merchant's design work, and it only holds if
 * the shop gets its own directory from the first commit.
 */
export function resolveThemeId(requested, slug) {
  if (requested != null) {
    const id = String(requested).trim();
    if (!isValidThemeId(id)) {
      throw inputError(
        `"${id}" is not a usable theme id.`,
        'Lowercase letters, digits and single hyphens, at most 40 characters.',
      );
    }
    if (RESERVED_THEME_IDS.includes(id)) {
      throw inputError(
        `"${id}" is a theme the core ships.`,
        `A shop owns its design; taking a shipped id would put the merchant's work where the next core release expects its own. Reserved: ${RESERVED_THEME_IDS.join(', ')}.`,
      );
    }
    return id;
  }
  const derived = normalizeThemeId(slug);
  if (!derived) throw inputError(`no theme id can be derived from "${slug}".`, 'Pass --theme <id>.');
  // A slug that collides with a shipped design gets a suffix rather than an
  // error: the operator did not choose the collision, and the shop still needs
  // a directory of its own.
  return RESERVED_THEME_IDS.includes(derived) ? `${derived}-shop` : derived;
}

/**
 * Refuse to clone when git has no author to commit as.
 *
 * `git var GIT_AUTHOR_IDENT` rather than reading `user.name`: it is git's OWN
 * resolution — config, GIT_AUTHOR_* environment variables, and the auto-detect
 * it may refuse — so this cannot disagree with the `git commit` further down.
 * A reimplementation of those rules would eventually pass where the commit
 * fails, which is how the first CI run of this job died 540 files into a clone.
 *
 * Asked from a directory OUTSIDE any repository, because the shop about to be
 * created is a fresh clone with no local config: a `user.email` set locally in
 * whatever tree the operator happens to stand in would be a false pass.
 */
function assertGitIdentity() {
  const result = capture('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: tmpdir(), allowFailure: true });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  throw preconditionError(
    'git has no identity to author the shop\'s first commit with.',
    'git config --global user.name "…" && git config --global user.email "…" — or set GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL in CI. `shopctl doctor` reports this as a blocking prerequisite.',
  );
}

/** Refuse a target that already holds anything. An existing EMPTY directory is
 *  fine — that is what `mkdir shop-x && cd ..` leaves, and git clones into it. */
function assertUsableTarget(target) {
  if (!existsSync(target)) return;
  const entries = readdirSync(target);
  if (entries.length > 0) {
    throw preconditionError(
      `${target} already exists and is not empty (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}).`,
      'Choose another --dir, or remove the directory. shopctl never writes into a tree it did not create.',
    );
  }
}

/**
 * Strip npm's `git+` prefix and its `#ref` suffix from a repository URL.
 *
 * `repository.url` is written in npm's dialect — `git+https://…git` — and
 * `git clone` does not accept it. Normalising here rather than writing a bare
 * URL in package.json keeps the field valid for npm, which is the tool that
 * actually reads it.
 */
export function cloneableRepositoryUrl(url) {
  return String(url)
    .replace(/^git\+/, '')
    .replace(/#.*$/, '');
}

/**
 * Where the core lives, for the clone.
 *
 * The `origin` remote of the checkout shopctl is running from, when there is
 * one. There is not always: `npx --package=github:owner/core shopctl new …`
 * extracts a TARBALL, which has no remote to ask — and that invocation is the
 * one an operator uses on a machine that has never cloned anything, which is
 * exactly when this answer matters most.
 *
 * `repository` in package.json is the same answer written down, in npm's own
 * field for the question. It is a fallback rather than the primary source
 * because a fork, a mirror or a local path passed as `--from` must keep
 * winning: the core a shop is cloned from is the core the operator is standing
 * in, not the one the package was published from.
 */
function defaultCoreRepository() {
  const result = capture('git', ['remote', 'get-url', 'origin'], { cwd: CORE_ROOT, allowFailure: true });
  const url = result.stdout.trim();
  if (result.status === 0 && url) return url;

  const declared = corePackage().repository;
  const fallback = typeof declared === 'string' ? declared : (declared?.url ?? '');
  if (fallback) return cloneableRepositoryUrl(fallback);

  throw preconditionError(
    'this checkout has no "origin" remote and its package.json declares no repository, so shopctl cannot tell where the core lives.',
    'Pass --from <url|path> with the core repository.',
  );
}

/**
 * The repository a slug implies, when `--origin` says nothing.
 *
 * `gh` is asked HERE — before the clone — rather than at the forge step: a
 * missing or unauthenticated `gh` must cost a message, not five hundred cloned
 * files and a directory to clean up.
 */
function deriveOriginUrl(slug, owner) {
  assertForgeReady();
  return repositoryUrl(owner ?? defaultOwner(), repositoryNameFor(slug), gitProtocol());
}

/** Does this ref exist as a TAG in that repository? Asked over the wire before
 *  anything is created, so a typo costs a message and not a half-clone. */
function assertTagExists(repository, tag) {
  const listed = capture('git', ['ls-remote', '--tags', '--refs', repository], { allowFailure: true });
  if (listed.status !== 0) {
    throw preconditionError(
      `cannot read the tags of ${repository}.`,
      'Check the URL and that this machine can reach it (SSH agent, credentials, VPN).',
    );
  }
  const tags = listed.stdout
    .split('\n')
    .map((line) => line.split('refs/tags/')[1]?.trim())
    .filter(Boolean);
  if (tags.includes(tag)) return tags;
  const known = tags.filter((name) => CORE_TAG.test(name)).sort();
  throw inputError(
    `${repository} has no tag "${tag}".`,
    known.length > 0
      ? `Published core versions: ${known.join(', ')}.`
      : 'That repository publishes no core version tag yet; a shop can only be created from one (ADR 0003).',
  );
}

/**
 * @param {{ positionals: string[], values: Record<string, string|boolean> }} args
 * @param {import('../report.mjs').Reporter} reporter
 */
export function runNew(args, reporter) {
  const [slug, ...extra] = args.positionals;
  if (!slug) throw usageError('shopctl new needs a slug.', newUsage.trim());
  if (extra.length > 0) throw usageError(`shopctl new takes one slug; got "${[slug, ...extra].join('", "')}".`);

  // ---------------------------------------------------------------- 1. values
  if (!SLUG.test(slug) || slug.length < 3 || slug.length > 32) {
    throw inputError(
      `"${slug}" is not a usable shop slug.`,
      'Lowercase letters, digits and single hyphens, 3 to 32 characters. It becomes part of every Cloudflare resource name.',
    );
  }
  if (RESERVED_SLUGS.includes(slug)) {
    throw inputError(
      `"${slug}" is reserved by the platform.`,
      `It is already a route prefix, a resource family or an environment word; a shop with that name would read as one. Reserved: ${RESERVED_SLUGS.join(', ')}.`,
    );
  }

  const displayName = String(args.values['--name'] ?? displayNameFromSlug(slug));
  const { domain, from: domainFrom } = resolveDomain(slug, args.values['--domain']);
  const email = String(args.values['--email'] ?? `commandes@${domain}`);
  const theme = resolveThemeId(args.values['--theme'], slug);
  const referenceTheme = String(args.values['--from-theme'] ?? 'default');
  const branch = String(args.values['--branch'] ?? 'main');
  const repository = String(args.values['--from'] ?? defaultCoreRepository());
  // Resolved BEFORE the clone, so the remote is configured once, at the point
  // the clone already does it. Deriving it later would leave a shop whose
  // `origin` was added by a different step than every other shop's.
  const createRepo = args.values['--create-repo'] === true;
  const originUrl = args.values['--origin']
    ? String(args.values['--origin'])
    : createRepo
      ? deriveOriginUrl(slug, args.values['--owner'] ? String(args.values['--owner']) : null)
      : null;
  const install = args.values['--no-install'] !== true;
  const verify = args.values['--no-verify'] !== true;

  const tag = String(args.values['--core'] ?? `v${corePackage().version}`);
  const coreVersion = versionFromTag(tag);


  if (theme === referenceTheme) {
    throw inputError(
      `--theme and --from-theme are both "${theme}".`,
      'The shop copies a reference design into a directory of its own; copying it onto itself would leave nothing to customize.',
    );
  }

  // The manifest is decided and checked here, before a single byte is written.
  const { accountId, from: accountFrom } = resolveAccountId(args.values['--account']);
  const manifest = buildManifest({ slug, displayName, domain, email, theme, coreVersion, accountId });
  const { errors } = validateManifest(manifest, { coreVersion });
  if (errors.length > 0) {
    throw inputError(
      `these options do not make a valid manifest:\n${errors.map((error) => `    ${error.path} ${error.message}`).join('\n')}`,
      'Nothing was created.',
    );
  }
  // Asked of the witnesses THIS core carries, before the clone. The gate run
  // after it asks the cloned tag's, which is the authority; this only makes the
  // common case — host and tag carrying the same fixtures — fail before a byte
  // is written.
  const witnesses = witnessCollisions(manifest, CORE_ROOT);
  if (witnesses.length > 0) throw takenByWitness(slug, witnesses, 'Nothing was created.');

  const cwd = process.cwd();
  // Under --json, stdout belongs to the report and nothing else, so a child's
  // stdout (npm's install log, above all) is pointed at our stderr rather than
  // interleaved into a document a caller is about to parse.
  const childStdio = reporter.json ? ['inherit', 2, 'inherit'] : 'inherit';
  const target = resolve(cwd, String(args.values['--dir'] ?? `shop-${slug}`));
  if (target === cwd) throw preconditionError('--dir is the current directory.', 'shopctl new creates a new repository; give it a directory of its own.');
  assertUsableTarget(target);
  // Whether the clone is ours to remove. An operator who pre-made an empty
  // directory keeps it; only a tree shopctl created is a tree shopctl deletes.
  const createdTarget = !existsSync(target);

  // ------------------------------------------------------- 2..5. the git side
  // Both preconditions before the clone: 540 files are a long way to travel to
  // discover that git cannot sign the commit at the end of it.
  assertGitIdentity();
  reporter.step(`Socle ${repository} @ ${tag}`);
  assertTagExists(repository, tag);
  reporter.ok(`tag ${tag} trouvé (socle ${coreVersion})`);

  reporter.step(`Clonage dans ${relative(cwd, target) || target} …`);
  run('git', ['clone', '--branch', tag, repository, target], { cwd, stdio: childStdio });
  // The clone leaves HEAD detached on the tag. A shop works on a branch; the
  // tag stays exactly where it was, which is what the next upgrade merges into.
  run('git', ['checkout', '-b', branch], { cwd: target, stdio: childStdio });
  run('git', ['remote', 'rename', 'origin', 'core'], { cwd: target, stdio: childStdio });
  if (originUrl) run('git', ['remote', 'add', 'origin', originUrl], { cwd: target, stdio: childStdio });
  reporter.ok(`historique cloné sur la branche ${branch}, remote core${originUrl ? ' et origin' : ''} configuré${originUrl ? 's' : ''}`);

  // -------------------------------------------------------- 6..8. shop files
  const referenceDir = resolve(target, THEMES_DIR, referenceTheme);
  if (!existsSync(referenceDir)) {
    throw inputError(
      `the core at ${tag} has no theme "${referenceTheme}".`,
      `Available: ${readdirSync(resolve(target, THEMES_DIR)).filter((name) => !name.startsWith('.')).join(', ')}. The shop was left in ${target} for inspection.`,
    );
  }
  const themeDir = resolve(target, THEMES_DIR, theme);
  if (existsSync(themeDir)) {
    throw inputError(
      `the core at ${tag} already carries a theme named "${theme}".`,
      `Pass --theme <id>. The shop was left in ${target} for inspection.`,
    );
  }
  cpSync(referenceDir, themeDir, { recursive: true });
  // The copy renders exactly as its reference, so the reference's design
  // signature is the copy's, and the shop's browser gate is green at its first
  // commit. It goes under client/: test/ is the core's, and a shop recording
  // its own signature there would be a core change at every upgrade.
  const referenceSignature = resolve(target, SIGNATURES_DIR, `${referenceTheme}.json`);
  if (existsSync(referenceSignature)) {
    mkdirSync(resolve(target, SHOP_SIGNATURES_DIR), { recursive: true });
    cpSync(referenceSignature, resolve(target, SHOP_SIGNATURES_DIR, `${theme}.json`));
  }

  const manifestText = renderManifest(manifest, {
    header: [
      `Manifeste de la boutique ${displayName}.`,
      `Généré par \`shopctl new ${slug}\` depuis le socle ${tag}.`,
      'Source de vérité non sensible : aucune clé, aucun secret, jamais.',
    ],
    // The sender follows the domain unless it was given, so it is a
    // placeholder exactly when it was derived from one.
    placeholders:
      domainFrom === 'placeholder'
        ? ['cloudflare.productionDomain', ...(args.values['--email'] === undefined ? ['email.from'] : [])]
        : [],
  });
  // Read back what was rendered. A generator and a parser that disagree about
  // quoting would produce a shop whose display name quietly lost a character,
  // and nothing downstream can tell that from a merchant's own typo.
  const reparsed = parseManifestYaml(manifestText, { file: 'client/client.yaml' });
  if (JSON.stringify(reparsed) !== JSON.stringify(manifest)) {
    throw verificationError(
      'the generated manifest does not read back as the values it was built from.',
      'This is a bug in shopctl, not in the options given. Report the slug and display name used.',
    );
  }

  mkdirSync(resolve(target, 'client'), { recursive: true });
  writeFileSync(resolve(target, 'client/client.yaml'), manifestText);
  writeFileSync(resolve(target, 'theme.config.json'), `${JSON.stringify({ theme }, null, 2)}\n`);
  mkdirSync(resolve(target, 'imports'), { recursive: true });
  writeFileSync(resolve(target, 'imports/README.md'), importsReadme(slug));
  reporter.ok(`manifeste client/client.yaml, thème src/themes/${theme}/ (copié de ${referenceTheme}), imports/`);

  // The build inputs come from the manifest, never from a hand-edited file:
  // rendering them here is what makes the shop buildable at its first commit.
  run('node', ['scripts/prepare-client.mjs', slug], { cwd: target, stdio: 'ignore' });
  reporter.ok('wrangler.jsonc rendu depuis le manifeste');

  // Staged before verification, because the gates read the INDEX (`git
  // ls-files`): an untracked manifest is invisible to exactly the checks that
  // exist to look at it.
  run('git', ['add', '-A'], { cwd: target, stdio: 'ignore' });

  // ------------------------------------------------------ 10. minimal verify
  const checks = [];
  if (verify) {
    reporter.section('Vérification minimale');
    // --json on the manifest gate, because its report is structured and this
    // command needs to tell two very different failures apart (see below).
    const gates = runShopGates(target);
    const manifestGate = gates.manifest;
    checks.push(...gates.checks);
    if (manifestGate.status === 0) reporter.ok('manifeste');
    else reporter.fail(`manifeste — ${describeGateFailure(manifestGate)}`);
    if (gates.paths.status === 0) reporter.ok('propriété des chemins');
    else reporter.fail(`propriété des chemins — ${describeGateFailure(gates.paths)}`);

    if (checks.some((check) => !check.ok)) {
      // A neutrality finding on THIS shop's own slug is not a core bug, it is a
      // bad name: the core legitimately contains the word, and no shop may be
      // called after something the core already says. Saying "this is a core
      // bug" there would send the operator to file a ticket when the fix is to
      // pick another slug. RESERVED_SLUGS catches the known ones before the
      // clone; it can never catch them all, because the gate also trips on
      // ordinary English the core happens to use.
      const manifestOnly = checks.every((check) => check.ok || check.check === 'manifeste');
      const claimed = witnessClaims(manifestGate, slug);
      if (claimed.length > 0 && manifestOnly) {
        if (createdTarget) rmSync(target, { recursive: true, force: true });
        throw takenByWitness(slug, claimed, 'Nothing was kept.');
      }
      const collisions = ownSlugCollisions(manifestGate, slug);
      if (collisions.length > 0 && manifestOnly) {
        if (createdTarget) rmSync(target, { recursive: true, force: true });
        throw inputError(
          `"${slug}" is a word this core already uses, in ${collisions.length} of its own file${collisions.length > 1 ? 's' : ''}.`,
          [
            'The core-neutrality gate refuses a core file that names a shop, so this shop could never pass its own CI.',
            `Files: ${collisions.slice(0, 5).join(', ')}${collisions.length > 5 ? ', …' : ''}`,
            'Choose another slug. Nothing was kept.',
          ].join('\n'),
        );
      }
      throw verificationError(
        'the generated shop does not pass its own gates.',
        `Left in ${target} so the failure can be read. This is a core bug, not a bad option: every value shopctl wrote was validated first.`,
        { checks },
      );
    }
  } else {
    reporter.warn('vérification minimale ignorée (--no-verify)');
  }

  // ----------------------------------------------------------- 9. the commit
  run(
    'git',
    ['commit', '--quiet', '-m', `Initialiser la boutique ${slug} depuis le socle ${tag}`],
    { cwd: target, stdio: 'ignore' },
  );
  reporter.ok(`premier commit sur ${branch}`);

  let installed = false;
  if (install) {
    reporter.section('Installation des dépendances');
    run('npm', ['ci'], { cwd: target, stdio: childStdio });
    run('npm', ['ci', '--prefix', 'mcp'], { cwd: target, stdio: childStdio });
    installed = true;
  }

  // ------------------------------------------------------ 10. the forge side
  //
  // Opt-in, and last. Everything above this line is local and reversible — a
  // failure costs `rm -rf` and nothing else. Creating the repository is the
  // first step that leaves something behind on a service, so it happens once
  // the tree is built, verified and committed, and only when asked.
  let forge = null;
  let forgeError = null;
  if (createRepo) {
    try {
      forge = setupRepository({
        shop: { root: target, manifest, file: CLIENT_MANIFEST },
        reporter,
        origin: originUrl,
        branch,
        reviewers: String(args.values['--reviewer'] ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        json: reporter.json,
        // `new` emits its own document; a second one on the same stdout would
        // break every caller that pipes it into a parser.
        emit: false,
      });
    } catch (error) {
      // The shop itself is complete: cloned, written, verified, committed. Only
      // the forge step failed, and it is the one step that is entirely
      // re-runnable — `shopctl repo` picks up exactly here. So the tree is kept
      // and named, the failure is reported in full, and the exit code is 6:
      // "produced, then a gate refused the result; the tree is left to inspect".
      if (!(error instanceof ShopctlError)) throw error;
      forgeError = { kind: error.kind, message: error.message, hint: error.hint };
      reporter.fail(error.message, error.hint);
      reporter.warn(
        `la boutique est complète dans ${relative(cwd, target) || target} ; seule la création du dépôt a échoué.`,
        'Corrigez ce que la ligne ✗ ci-dessus nomme, puis relancez `npm run shopctl -- repo` depuis la boutique : rien n\'est à refaire.',
      );
    }
  }

  // --------------------------------------------------------- 11. what's next
  //
  // Every step is printed AS IT MUST BE TYPED, from inside the shop.
  //
  // `shopctl doctor` would be a lie: nothing put `shopctl` on the operator's
  // PATH. `npx` least of all — it exposes the bin for the length of one command
  // and keeps nothing — which is exactly the path someone creating their first
  // shop took, and exactly when a wrong next step costs the most.
  //
  // `npm run shopctl --` is also the only form that stays correct with a second
  // shop on the same machine: a shop is operated by the CLI ITS OWN tag carries
  // (ADR 0009), and a global install would have one shop's CLI drive another's.
  const names = resourceNames(manifest);
  const enter = relative(cwd, target);
  const nextSteps = [
    ...(enter ? [`cd ${enter}`] : []),
    ...(installed ? [] : ['npm ci', 'npm ci --prefix mcp']),
    'npm run shopctl -- doctor',
    ...(domainFrom === 'placeholder' ? [`remplacer le domaine placeholder ${domain} dans client/client.yaml`] : []),
    ...(accountId ? [] : ['ajouter cloudflare.accountId au manifeste (ou relancer avec --account)']),
    ...(forgeError !== null
      ? ['npm run shopctl -- repo   # reprend la création du dépôt là où elle a échoué']
      : forge !== null
      ? []
      : originUrl
        ? [`npm run shopctl -- repo   # crée le dépôt, les environnements et leurs secrets`, `git push -u origin ${branch}`]
        : ['git remote add origin <url> && npm run shopctl -- repo']),
    'npm run verify',
    'npm run shopctl -- provision --env staging',
    'npm run shopctl -- deploy --env staging',
  ];

  reporter.section(`Boutique ${displayName} prête dans ${relative(cwd, target) || target}`);
  reporter.step(`  slug     ${slug}`);
  reporter.step(`  thème    ${theme}`);
  reporter.step(`  socle    ${tag}`);
  reporter.step(`  domaine  ${domain}${domainFrom === '--domain' ? '' : `  (${domainFrom === 'placeholder' ? 'placeholder de documentation' : `depuis ${domainFrom}`})`}`);
  reporter.step(`  compte   ${accountId ?? '(non déclaré)'}${accountFrom && accountFrom !== '--account' ? `  (depuis ${accountFrom})` : ''}`);
  reporter.step(`  Worker   ${names.worker}  (+ ${names.database}, ${names.images}, ${names.files}, ${names.backups}, ${names.sessions})`);
  reporter.section('Prochaines actions');
  for (const step of nextSteps) reporter.step(`  ${step}`);

  reporter.result({
    command: 'new',
    ok: forgeError === null,
    target,
    shop: { slug, displayName, domain, email, theme, referenceTheme, accountId },
    // Where each defaulted value came from. An account id written into a
    // committed manifest from an ambient variable is a fact worth recording.
    defaults: { domain: domainFrom, account: accountFrom },
    core: { repository, tag, version: coreVersion },
    git: { branch, remotes: { core: repository, origin: originUrl } },
    forge,
    forgeError,
    resources: names,
    installed,
    checks,
    nextSteps,
  });
  // 6, not 0: the shop was produced and one gate refused its result. The tree
  // is left in place, and `shopctl repo` resumes exactly where this stopped.
  return forgeError === null ? EXIT_CODES.ok : EXIT_CODES.verification;
}

/**
 * Core files the gate says name THIS shop, from its own JSON report.
 *
 * Reading the gate's report rather than re-running its logic: the CLI and the
 * CI must not be able to reach different conclusions about the same tree, and
 * `check-manifest.mjs --json` already publishes the findings with the slug each
 * one names.
 */
function ownSlugCollisions(gate, slug) {
  let report;
  try {
    report = JSON.parse(gate.stdout);
  } catch {
    return [];
  }
  const findings = report?.coreNeutrality?.findings ?? [];
  if (findings.length === 0) return [];
  // Only when the neutrality findings are the WHOLE story, and all of them name
  // this shop. A manifest that is also invalid for another reason is a
  // different failure and keeps the report it deserves.
  const manifestErrors = (report?.manifests ?? []).some((entry) => entry.errors?.length > 0);
  if (manifestErrors || (report?.collisions ?? []).length > 0) return [];
  if (!findings.every((finding) => finding.slug === slug)) return [];
  return [...new Set(findings.map((finding) => finding.path))];
}

const isWitnessFile = (file) => file.startsWith(`${WITNESS_CLIENTS_DIR}/`);

/**
 * The witness manifests a would-be shop collides with, in the core at `root`.
 *
 * A witness is a shop as far as the manifest gate is concerned: it claims its
 * slug and every name derived from it, in every environment. A shop that takes
 * one of those names fails its own CI for as long as the fixture exists, and
 * the fixture is core — removing it from the shop is a conflict at every
 * upgrade. Not RESERVED_SLUGS: the schema refuses a reserved slug, and the
 * witnesses are validated by that same schema.
 */
export function witnessCollisions(manifest, root) {
  const witnesses = discoverManifests(root)
    .filter(isWitnessFile)
    .map((file) => loadManifest(file, { root, checkTheme: false }))
    .filter((entry) => entry.errors.length === 0);
  return [
    ...new Set(
      detectFleetCollisions([{ file: CLIENT_MANIFEST, manifest }, ...witnesses])
        .filter((claim) => claim.files.includes(CLIENT_MANIFEST))
        .flatMap((claim) => claim.files.filter(isWitnessFile)),
    ),
  ];
}

/**
 * The same question read from the manifest gate's report on the cloned shop.
 *
 * Only when witnesses are the whole story: every collision is between this
 * shop's manifest and a witness, no manifest is invalid, and any neutrality
 * finding names this shop. Anything else keeps the report it deserves.
 */
export function witnessClaims(gate, slug) {
  let report;
  try {
    report = JSON.parse(gate.stdout);
  } catch {
    return [];
  }
  const collisions = report?.collisions ?? [];
  if (collisions.length === 0) return [];
  if ((report?.manifests ?? []).some((entry) => entry.errors?.length > 0)) return [];
  if (!(report?.coreNeutrality?.findings ?? []).every((finding) => finding.slug === slug)) return [];
  const betweenShopAndWitness = ({ files }) =>
    files.includes(CLIENT_MANIFEST) && files.every((file) => file === CLIENT_MANIFEST || isWitnessFile(file));
  if (!collisions.every(betweenShopAndWitness)) return [];
  return [...new Set(collisions.flatMap(({ files }) => files.filter(isWitnessFile)))];
}

function takenByWitness(slug, files, outcome) {
  return inputError(
    `"${slug}" collides with a witness shop this core carries (${files.join(', ')}).`,
    [
      'A witness claims its slug and every resource name derived from it, and the manifest gate refuses two shops claiming one name, so this shop could never pass its own CI.',
      `Choose another slug. ${outcome}`,
    ].join('\n'),
  );
}

/** The README `shopctl new` drops in a shop's imports/ directory.
 *  Exported so a gate can check it still names every column of the contract:
 *  a column the merchant's documentation does not mention is a column filled by
 *  guesswork. */
export function importsReadme(slug) {
  // A `|` inside a cell ends the cell, and the separator this contract uses for
  // multi-value columns is exactly that character.
  const cell = (value) => value.replaceAll('|', '\\|');
  const columns = COLUMNS.map((column) =>
    `| \`${column.name}\` | ${column.scope === 'product' ? 'produit' : 'unité'} | ${cell(column.description)} |`).join('\n');
  return `# Imports de ${slug}

Les sources du catalogue de cette boutique : le CSV produit et les médias qu'il
référence. Rien ici n'est lu à l'exécution — l'import écrit dans D1 et R2, et
c'est la boutique déployée qui sert le résultat.

    shopctl catalog validate ./imports/catalog.csv
    shopctl catalog import ./imports/catalog.csv --dry-run
    shopctl catalog import ./imports/catalog.csv

## Une ligne, une unité vendue

Un produit simple tient sur une ligne : sa référence est dans \`sku\`, la colonne
\`variant\` reste vide. Un produit à variantes occupe une ligne par variante :
chacune a sa propre référence dans \`sku\`, toutes portent la référence du produit
parent dans \`product\`, et les colonnes de portée « produit » ne se renseignent
qu'une fois — les répéter à l'identique est toléré, les contredire est refusé.

| Colonne | Portée | Rôle |
| --- | --- | --- |
${columns}

Le séparateur est déduit de la ligne d'en-tête : un tableur français exporte en
\`;\`, ce qui évite d'avoir à guillemeter chaque prix.

## Ce que l'import garantit

- **rien n'est écrit tant que tout n'est pas jugé.** Une image illisible ou une
  catégorie inconnue arrête la totalité de l'import ;
- **idempotent par référence.** Relancer le même fichier ne produit aucune
  écriture, et une exécution interrompue reprend là où elle en était : l'import
  recalcule ce qui reste depuis l'état de la boutique ;
- **rien n'est supprimé.** Une variante qui quitte le fichier est désactivée, pas
  effacée — une commande passée la référence. Les produits absents du fichier ne
  sont pas touchés ;
- **les pertes se demandent.** Déplacer une URL (\`--allow-slug-change\`), retirer
  une unité vendue (\`--allow-remove-variants\`) et créer une catégorie
  (\`--create-categories\`) ont chacune leur option.

## Les images

Les chemins sont relatifs à ce dossier et ne peuvent pas en sortir. Le type est
lu dans les octets, pas dans l'extension : un fichier dont le nom ment sur son
contenu est refusé, et le SVG n'est jamais accepté. La clé de stockage est
dérivée du contenu, donc deux produits qui partagent une photo partagent un seul
objet, et un réimport n'en renvoie aucun.

La boutique sert ses images redimensionnées à la demande, en quatre largeurs :
une source plus grande que ${DELIVERY_MAX_WIDTH} px est signalée mais acceptée telle quelle.
`;
}
