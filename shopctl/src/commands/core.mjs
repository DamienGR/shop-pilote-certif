/**
 * `shopctl core status` and `shopctl core upgrade` — one shop, one core version.
 *
 * Plan §3.4 writes the upgrade as seven steps: fetch a tag, create a branch,
 * merge it, run the tests, deploy to staging, open a pull request, wait for a
 * human. This file does the first four and the sixth. It does NOT deploy, and
 * that omission is the exit criterion of the milestone rather than a gap: a
 * core version must be proposable to several shops without a manual copy of
 * files AND without an unapproved deployment. `shopctl deploy` stays a separate
 * command a human types, behind the GitHub Environment that already carries the
 * reviewers.
 *
 * Three refusals are worth naming, because each is a failure that would
 * otherwise be found much later:
 *
 *  - **a dirty tree.** A merge into one either stops halfway or folds the
 *    operator's unfinished work into a commit that claims to be a core version;
 *  - **a downgrade.** ADR 0003 makes a published tag immutable, so a bad
 *    version is corrected by a NEW version. Merging backwards would leave a
 *    shop whose history claims a version its files do not have;
 *  - **a rewritten migration.** ADR 0006 forbids editing a published migration,
 *    because a database that already ran it will not run it again. The upgrade
 *    path is where a shop would inherit one, so it is where the question gets
 *    asked — before the merge, not after the deploy.
 *
 * The version a shop is ON is read from its git history — the newest core tag
 * merged into HEAD — never from the manifest. The manifest is a claim; the
 * merge is the fact. Comparing the two IS `core status` (ADR 0003).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_MANIFEST } from '../../../scripts/manifest.mjs';
import { inputError, preconditionError, usageError, verificationError } from '../errors.mjs';
import { describeGateFailure, runShopGates } from '../gates.mjs';
import { withCoreVersion } from '../manifest-template.mjs';
import { assertForgeReady, openPullRequest, originUrl } from '../forge.mjs';
import { capture, run } from '../process.mjs';
import { resolveShop } from '../shop.mjs';
import {
  CORE_REMOTE,
  MIGRATION_NOTES_DIR,
  abortMerge,
  assertCleanTree,
  checkoutBranch,
  commitAll,
  coreDrift,
  coreRemoteUrl,
  currentBranch,
  fetchCoreTags,
  hasTag,
  isRepository,
  localCoreTags,
  mergeCoreTag,
  mergedCoreTags,
  migrationNotes,
  pendingMigrations,
  publishedCoreTags,
  requireCoreRemote,
  rewrittenMigrations,
  upgradeBranch,
  worktreeState,
} from '../upgrade.mjs';
import { compareVersions, isBreakingStep, isCoreTag, latestVersion, tagForVersion, versionFromTag } from '../version.mjs';

export const CORE_OPTIONS = {
  '--to': 'tag',
  '--branch': 'nom',
  '--base': 'branche',
  '--shop': 'slug',
};

export const CORE_FLAGS = ['--dry-run', '--no-verify', '--open-pr', '--offline', '--abort-on-conflict'];

export const coreUsage = `Usage: shopctl core <sous-commande> [options]

  shopctl core status                  Version déclarée, version fusionnée, dérive
  shopctl core upgrade --to <tag>      Fusionner une version du socle sur une branche

  --to <tag>            Version du socle visée (v1.1.0, ou 1.1.0).
  --branch <nom>        Branche de travail. Défaut : socle/<tag>.
  --base <branche>      Base de la pull request. Défaut : la branche courante, ou
                        main quand la reprise part déjà de la branche de montée.
  --open-pr             Pousser la branche et ouvrir la pull request (enveloppe gh).
  --dry-run             Dire ce que la mise à niveau ferait, ne rien fusionner.
  --no-verify           Ne pas exécuter les portes de la boutique après la fusion.
  --abort-on-conflict   Défaire la fusion en cas de conflit au lieu de la laisser.
  --offline             Ne pas interroger le dépôt du socle (status seulement).
  --shop <slug>         Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                Rapport lisible par une machine.

\`core status\` rapporte toujours en code 0, même sur une boutique en défaut :
lire une boutique en mauvais état est une lecture réussie, et le champ \`ok\` du
rapport porte le verdict. \`shopctl fleet verify\` est la commande qui en fait un
code de sortie.

Une mise à niveau ne déploie rien. Elle fusionne un tag immuable sur une branche
et, avec --open-pr, ouvre la pull request où un humain lit le diff, la CI et les
notes de migration avant que quoi que ce soit ne parte en production.
`;

/** The branch an upgrade proposes onto when the one it started from is the
 *  upgrade branch itself — a resumption. Named rather than inlined so `--base`
 *  has something to be the exception to. */
const DEFAULT_BASE = 'main';

const SUBCOMMANDS = new Set(['status', 'upgrade']);

export function runCore(args, reporter) {
  const [sub, ...rest] = args.positionals;
  if (!sub) throw usageError('shopctl core attend une sous-commande.', coreUsage.trim());
  if (!SUBCOMMANDS.has(sub)) throw usageError(`sous-commande de core inconnue : « ${sub} ».`, coreUsage.trim());
  if (rest.length > 0) {
    throw usageError(`core ${sub} ne prend pas d'argument positionnel ; reçu « ${rest.join('", "')} ».`, coreUsage.trim());
  }
  return sub === 'status' ? statusCommand(args, reporter) : upgradeCommand(args, reporter);
}

/**
 * Everything `core status` knows about one shop, as data.
 *
 * Exported because `fleet status` asks the same question of every shop it
 * registers, and a second reading of "which version is this shop on" is a
 * second answer waiting to disagree with this one.
 *
 * @param {{ root: string, manifest: object, file: string, errors?: Array<{ path: string, message: string, rule?: string }> }} shop
 *        `errors` travels with the manifest so a shop whose manifest no longer
 *        validates is still described, with the reason.
 * @param {{ offline?: boolean, published?: string[]|null }} [options]
 */
export function coreState(shop, { offline = false, published = null } = {}) {
  const { root, manifest, file } = shop;
  if (!isRepository(root)) {
    throw preconditionError(
      `${root} n'est pas un dépôt git.`,
      'Une boutique reçoit les versions du socle par git (ADR 0003) ; un répertoire copié à la main n\'a pas d\'historique à comparer.',
    );
  }

  const remote = coreRemoteUrl(root);
  const declared = String(manifest.coreVersion);
  const mergedTags = mergedCoreTags(root);
  const mergedTag = mergedTags.at(-1) ?? null;
  const merged = mergedTag ? versionFromTag(mergedTag) : null;
  const worktree = worktreeState(root);

  // Asked over the wire only when the caller wants it, and never fatal: a
  // laptop on a train must still be able to read what a shop is on. `published`
  // lets a fleet ask the core repository ONCE for all its shops.
  let available = published;
  if (available === null && !offline && remote) available = publishedCoreTags(remote, { cwd: root });
  const latest = available ? latestVersion(available) : null;

  const behind = available && merged ? available.filter((tag) => compareVersions(tag, merged) > 0) : [];

  // A manifest ahead of the history is either edited by hand or sitting in a
  // clone that never fetched the tag it names: an upgrade merged on the forge
  // and pulled from the shop's origin brings its commits, not the core's tags.
  // Only the second is fixed by fetching, and telling the operator to "correct"
  // the manifest instead would put the wrong version in it (certification,
  // step 10). Offline, a tag missing here is all there is to go on; online, the
  // core must also publish it.
  const local = localCoreTags(root);
  const declaredTag = tagForVersion(declared);
  const declaredUnfetched =
    isCoreTag(declaredTag) &&
    !local.includes(declaredTag) &&
    (merged === null || compareVersions(declared, merged) > 0) &&
    (available ? available.includes(declaredTag) : true);

  // Two kinds of difference, and conflating them would make the report useless.
  // A GENERATED file always differs — `wrangler.jsonc` is rendered from this
  // shop's manifest, so every shop in the fleet differs there from the day it
  // was created — and the upgrade re-renders it anyway. Drift is what the shop
  // CHANGED in files the core maintains: that is where a merge has to choose.
  const differences = mergedTag ? coreDrift(root, mergedTag) : [];
  const drift = differences.filter((entry) => entry.owner !== 'generated');
  const generated = differences.filter((entry) => entry.owner === 'generated');

  return {
    shop: { slug: manifest.client.slug, path: root, manifest: file },
    manifestErrors: (shop.errors ?? []).map((error) => ({ path: error.path, message: error.message, rule: error.rule ?? null })),
    core: {
      declared,
      merged,
      mergedTag,
      remote,
      latest: latest ? versionFromTag(latest) : null,
      behind: behind.map(versionFromTag),
      // The claim and the fact. Their disagreement is the drift ADR 0003 asks
      // `core status` to catch: a manifest edited by hand, or a merge that took
      // the core without the manifest bump that goes with it.
      declaresMerged: merged !== null && compareVersions(declared, merged) === 0,
      declaredUnfetched,
    },
    drift,
    generated,
    worktree: { branch: worktree.branch, clean: worktree.clean, dirty: worktree.dirty },
    tags: { local, published: available },
  };
}

/** Verdicts on one shop's state, in the order a reader should worry about them.
 *  Shared with `fleet verify`, which turns them into an exit code. */
export function stateFindings(state) {
  const findings = [];
  for (const error of state.manifestErrors ?? []) {
    findings.push({ status: 'fail', message: `manifeste : ${error.path} ${error.message}` });
  }
  if (!state.core.remote) {
    findings.push({ status: 'fail', message: `pas de remote « ${CORE_REMOTE} » : cette boutique ne peut recevoir aucune version du socle.` });
  }
  const fetchHint = state.core.declaredUnfetched
    ? `, mais ce clone n'a pas le tag v${state.core.declared} : récupérez les tags du socle (git fetch --tags ${CORE_REMOTE}) et relancez avant de toucher au manifeste`
    : '';
  if (state.core.merged === null) {
    findings.push({
      status: 'fail',
      message: `aucun tag du socle n'est fusionné dans HEAD : la version réellement embarquée est inconnue${fetchHint}.`,
    });
  } else if (!state.core.declaresMerged) {
    findings.push({
      status: 'fail',
      message: `le manifeste déclare ${state.core.declared} et l'historique porte ${state.core.mergedTag}${fetchHint}.`,
    });
  } else {
    findings.push({ status: 'ok', message: `socle ${state.core.mergedTag}, déclaré et fusionné.` });
  }
  if (state.drift.length > 0) {
    findings.push({
      status: 'warn',
      message: `${state.drift.length} fichier${state.drift.length > 1 ? 's' : ''} du cœur modifié${state.drift.length > 1 ? 's' : ''} depuis ${state.core.mergedTag} : ${state.drift.slice(0, 5).map((entry) => entry.path).join(', ')}${state.drift.length > 5 ? ', …' : ''}`,
    });
  }
  if (!state.worktree.clean) {
    findings.push({ status: 'warn', message: `arbre de travail modifié (${state.worktree.dirty.length} fichiers).` });
  }
  if (state.core.behind.length > 0) {
    findings.push({ status: 'todo', message: `${state.core.behind.length} version${state.core.behind.length > 1 ? 's' : ''} de retard : ${state.core.behind.join(', ')}.` });
  }
  return findings;
}

function statusCommand(args, reporter) {
  // Tolerant on purpose: a manifest that no longer validates is exactly what
  // this command exists to report — most often a `coreVersion` claiming a
  // version the history does not carry, which the gate refuses and the operator
  // cannot see until something says so.
  const shop = resolveShop(process.cwd(), args.values['--shop'], { allowInvalid: true });
  const state = coreState(shop, { offline: args.values['--offline'] === true });

  reporter.section(`Boutique ${state.shop.slug} — ${state.shop.manifest}`);
  const findings = stateFindings(state);
  for (const finding of findings) reporter.entry(finding.status, finding.message);
  if (state.core.remote) reporter.step(`socle : ${state.core.remote}`);
  if (state.core.latest) reporter.step(`dernière version publiée : v${state.core.latest}`);
  if (state.core.behind.length > 0) {
    reporter.step(`Mise à niveau : npm run shopctl -- core upgrade --to v${state.core.behind.at(-1)}`);
  }

  // `ok` is the verdict on the shop, not on the command: reading a shop that is
  // in a bad state is a successful read. The exit code stays 0 for that reason,
  // and `shopctl fleet verify` is the command that turns these same findings
  // into one — a status command that failed would be unusable in the case it
  // exists for.
  reporter.result({ ok: !findings.some((finding) => finding.status === 'fail'), findings, ...state });
  return 0;
}

/** The version an upgrade targets, from `--to`. A missing one gets no
 *  suggestion: before the fetch, the clone's tags may be stale (certification,
 *  step 10). */
export function resolveTarget(value) {
  if (value === undefined) {
    throw usageError(
      '--to est obligatoire.',
      'Une mise à niveau nomme la version qu\'elle prend : --to v1.1.0. `shopctl core status` liste les versions publiées ; rien n\'est deviné ici.',
    );
  }
  const tag = tagForVersion(String(value));
  return { tag, version: versionFromTag(tag) };
}

function upgradeCommand(args, reporter) {
  // Tolerant for the same reason `status` is, plus one of its own: a shop in
  // the middle of an upgrade — the tag merged, the manifest not yet bumped —
  // has a manifest the gate legitimately refuses, and this command is what
  // fixes it. What no longer validates AFTER the bump is caught by the gates
  // this command runs itself, which is the check that matters.
  const shop = resolveShop(process.cwd(), args.values['--shop'], { allowInvalid: true });
  const result = upgradeShop({
    shop,
    reporter,
    to: args.values['--to'],
    branch: args.values['--branch'],
    base: args.values['--base'],
    dryRun: args.values['--dry-run'] === true,
    verify: args.values['--no-verify'] !== true,
    openPr: args.values['--open-pr'] === true,
    abortOnConflict: args.values['--abort-on-conflict'] === true,
  });
  reporter.result({ ok: true, ...result });
  return 0;
}

/**
 * Merge one core tag into one shop, on a branch.
 *
 * Exported and root-relative because `fleet upgrade` runs it over every shop of
 * a registry; the CLI entry point above is a thin wrapper that resolves the
 * shop from the working directory. Throws a ShopctlError on every refusal, so a
 * fleet run can catch one shop's failure and keep going.
 *
 * @param {{ shop: { root: string, manifest: object, file: string }, reporter: import('../report.mjs').Reporter,
 *          to?: string, branch?: string, base?: string, dryRun?: boolean, verify?: boolean,
 *          openPr?: boolean, abortOnConflict?: boolean }} options
 */
export function upgradeShop({
  shop,
  reporter,
  to,
  branch: branchName,
  base: baseName,
  dryRun = false,
  verify = true,
  openPr = false,
  abortOnConflict = false,
}) {
  const { root, manifest } = shop;
  const slug = manifest.client.slug;

  // ------------------------------------------------------------- 1. le socle
  requireCoreRemote(root);
  // A forgotten `--to` is a usage error, and must not cost a fetch first.
  const target = resolveTarget(to);

  // The forge is asked BEFORE anything is merged, like `new` does: a missing or
  // unauthenticated `gh` must cost a message, not a merged branch nobody can
  // push.
  if (openPr) assertForgeReady({ cwd: root });

  // The tags BEFORE the state. The version a shop is on is the newest core tag
  // merged into HEAD, and a clone only knows the tags it has fetched: `git pull`
  // from the shop's own origin brings the merged upgrades, not the core's tags.
  // Read first, a clone last fetched at v0.3.5 announced « v0.3.5 → v0.3.22 »
  // for a shop on v0.3.20, with 283 « diverged » files and a migration its
  // database already had — and wrote all three into the pull request
  // (certification, step 10).
  fetchCoreTags(root);
  const state = coreState(shop, { offline: true });

  reporter.section(`Boutique ${slug} — socle ${state.core.mergedTag ?? 'inconnu'} → ${target.tag}`);
  if (!hasTag(root, target.tag)) {
    const known = localCoreTags(root);
    throw inputError(
      `le socle ne publie pas de tag « ${target.tag} ».`,
      known.length > 0
        ? `Versions connues de ce clone : ${known.join(', ')}.`
        : 'Ce dépôt ne publie aucun tag de version ; une boutique ne se met à niveau que vers un tag immuable (ADR 0003).',
    );
  }
  reporter.ok(`tag ${target.tag} récupéré depuis « ${CORE_REMOTE} »`);

  // ------------------------------------------------ 2. le sens de la marche
  //
  // The branch is decided here rather than further down, because whether this
  // run is a FRESH upgrade or the RESUMPTION of one is decided by which branch
  // is checked out.
  const branch = branchName ? String(branchName) : upgradeBranch(target.tag);
  const onUpgradeBranch = currentBranch(root) === branch;
  // The base of the pull request: the branch the operator started from. On a
  // resumption that branch is no longer checked out — the upgrade branch is —
  // so it falls back to `main` rather than proposing a branch onto itself.
  const base = baseName ? String(baseName) : (onUpgradeBranch ? DEFAULT_BASE : currentBranch(root) ?? DEFAULT_BASE);

  const alreadyMerged = state.core.merged !== null && compareVersions(target.version, state.core.merged) === 0;
  // Resumption, and it is the ordinary case rather than an exotic one: a
  // conflict is left in the tree, the operator resolves it and commits, and
  // re-runs the same command. The merge is then already in the history, and
  // everything AFTER it — the manifest bump, the generated files, the gates,
  // the pull request — has never run. Returning "already there" would leave the
  // shop merged, unbumped and unproposed, which is the worst of the three
  // states.
  const resuming = alreadyMerged && onUpgradeBranch;
  if (alreadyMerged && !resuming) {
    reporter.ok(`déjà sur ${target.tag} ; rien à fusionner.`);
    return { shop: state.shop, from: state.core.merged, to: target.version, changed: false, upToDate: true };
  }
  if (state.core.merged && compareVersions(target.version, state.core.merged) < 0) {
    throw inputError(
      `${target.tag} est antérieur au socle fusionné (${state.core.mergedTag}).`,
      'Un tag publié est immuable : une version fautive se corrige par une version suivante, jamais par un retour en arrière (ADR 0003). Pour revenir à une version applicative, faites un rollback du Worker déployé.',
    );
  }

  // ---------------------------------------------------- 3. ce que le pas fait
  // On a resumption the tag is already merged, so `mergedTag` IS the target and
  // the step's content has to be read from the version before it.
  const fromTag = resuming ? (state.tags.local.filter((tag) => compareVersions(tag, target.version) < 0).at(-1) ?? null) : state.core.mergedTag;
  const fromVersion = fromTag ? versionFromTag(fromTag) : null;
  const notes = migrationNotes(root, target.tag, { from: fromVersion });
  const migrations = fromTag ? pendingMigrations(root, fromTag, target.tag) : [];
  const rewritten = fromTag ? rewrittenMigrations(root, fromTag, target.tag) : [];
  if (rewritten.length > 0) {
    // ADR 0006: a published migration is never rewritten. A database that has
    // already run it will not run it again, so the shop that takes this step
    // ends up on a schema nobody can reproduce.
    throw verificationError(
      `${target.tag} réécrit ${rewritten.length} migration${rewritten.length > 1 ? 's' : ''} déjà publiée${rewritten.length > 1 ? 's' : ''}.`,
      `Interdit par l'ADR 0006 : une base qui les a déjà exécutées ne les rejouera pas. Fichiers : ${rewritten.join(', ')}. C'est un défaut du socle, pas de cette boutique.`,
      { rewritten },
    );
  }
  const breaking = isBreakingStep(fromVersion, target.version);
  if (migrations.length > 0) reporter.ok(`${migrations.length} migration${migrations.length > 1 ? 's' : ''} additive${migrations.length > 1 ? 's' : ''} : ${migrations.map((path) => path.replace('migrations/', '')).join(', ')}`);
  if (notes.length > 0) {
    reporter.ok(`notes de migration : ${notes.map((note) => `v${note.version}`).join(', ')}`);
  } else if (breaking) {
    reporter.warn(
      `${target.tag} est un pas cassant et ne porte aucune note de migration.`,
      `Le socle devrait publier ${MIGRATION_NOTES_DIR}/v${target.version}.md ; lisez le diff avant de fusionner.`,
    );
  }
  if (state.drift.length > 0) {
    reporter.warn(
      `${state.drift.length} fichier${state.drift.length > 1 ? 's' : ''} du cœur ${state.drift.length > 1 ? 'ont' : 'a'} divergé depuis ${fromTag}.`,
      `C'est là que la fusion peut entrer en conflit : ${state.drift.slice(0, 5).map((entry) => entry.path).join(', ')}${state.drift.length > 5 ? ', …' : ''}`,
    );
  }

  if (dryRun) {
    reporter.todo(`fusionnerait ${target.tag} sur la branche ${branch}, depuis ${base}`);
    return {
      shop: state.shop,
      from: fromVersion,
      to: target.version,
      changed: false,
      dryRun: true,
      branch,
      base,
      migrations,
      notes: notes.map(({ version, file }) => ({ version, file })),
      drift: state.drift,
    };
  }

  // -------------------------------------------------------- 4. la fusion
  assertCleanTree(root);
  if (resuming) {
    reporter.ok(`${target.tag} est déjà fusionné sur ${branch} ; reprise après la fusion`);
  } else {
    const created = checkoutBranch(root, branch);
    reporter.ok(`branche ${branch} ${created.created ? 'créée' : 'reprise'} depuis ${base}`);
  }

  const merge = resuming
    ? { ok: true, conflicts: [], output: '' }
    : mergeCoreTag(root, target.tag, { message: `Fusionner le socle ${target.tag}` });
  if (!merge.ok) {
    const aborted = abortOnConflict ? abortMerge(root) : false;
    throw verificationError(
      `la fusion de ${target.tag} entre en conflit sur ${merge.conflicts.length} fichier${merge.conflicts.length > 1 ? 's' : ''}.`,
      [
        merge.conflicts.map((entry) => `  ${entry.path} (${entry.owner})`).join('\n'),
        aborted
          ? `Fusion défaite ; la branche ${branch} est revenue à son état d'avant.`
          : `Résolvez dans ${root}, puis \`git commit\` et relancez la commande — elle reprend la branche ${branch}. \`git merge --abort\` défait tout.`,
      ].join('\n'),
      { branch, conflicts: merge.conflicts, aborted },
    );
  }
  if (!resuming) reporter.ok(`socle ${target.tag} fusionné`);

  // ------------------------------------- 5. le manifeste et les fichiers générés
  //
  // The manifest's `coreVersion` is a client field, so the merge never touches
  // it: the shop would claim its old version against its new core, which the
  // manifest gate refuses by design (checkCoreCompatibility). The generated
  // Wrangler configuration is re-rendered by the NEW core's generator, because
  // a template that gained a binding must reach the shop that just took it.
  const manifestPath = resolve(root, shop.file ?? CLIENT_MANIFEST);
  writeFileSync(manifestPath, withCoreVersion(readFileSync(manifestPath, 'utf8'), target.version));
  run('node', ['scripts/prepare-client.mjs', slug], { cwd: root, stdio: 'ignore' });
  const bump = commitAll(root, `Passer la boutique ${slug} au socle ${target.tag}`);
  reporter.ok(`manifeste à ${target.version}, configuration Wrangler rendue${bump.committed ? '' : ' (rien à valider)'}`);

  // ------------------------------------------------------- 6. les portes
  let checks = [];
  if (verify) {
    const gates = runShopGates(root);
    checks = gates.checks;
    for (const check of gates.checks) {
      if (check.ok) reporter.ok(check.check);
      else reporter.fail(`${check.check} — ${describeGateFailure(check.check === 'manifeste' ? gates.manifest : gates.paths)}`);
    }
    if (!gates.ok) {
      throw verificationError(
        `la boutique ne passe plus ses propres portes après la fusion de ${target.tag}.`,
        `La branche ${branch} est conservée dans ${root} pour être lue. Rien n'a été poussé ni déployé.`,
        { branch, checks },
      );
    }
  } else {
    reporter.warn('portes de la boutique ignorées (--no-verify)');
  }

  // ------------------------------------------------------ 7. la pull request
  let pullRequest = null;
  if (openPr) {
    const origin = originUrl(root);
    if (!origin) {
      throw preconditionError(
        'cette boutique n\'a pas de remote « origin » : il n\'y a nulle part où ouvrir une pull request.',
        'Lancez `npm run shopctl -- repo` pour créer le dépôt de la boutique, ou ajoutez le remote à la main.',
      );
    }
    capture('git', ['push', '-u', 'origin', branch], { cwd: root });
    pullRequest = openPullRequest(root, {
      branch,
      base,
      title: `Socle ${target.tag}`,
      body: pullRequestBody({ slug, from: fromVersion, target, migrations, notes, drift: state.drift }),
    });
    reporter.ok(`pull request ${pullRequest.created ? 'ouverte' : 'déjà ouverte'}${pullRequest.url ? ` : ${pullRequest.url}` : ''}`);
  }

  reporter.section('Ensuite');
  reporter.step(`  npm run verify                      # dans ${root}`);
  reporter.step('  npm run shopctl -- deploy --env staging');
  reporter.step('  npm run shopctl -- deploy --env production --yes   # après relecture humaine');

  return {
    shop: state.shop,
    from: fromVersion,
    to: target.version,
    changed: true,
    branch,
    base,
    migrations,
    notes: notes.map(({ version, file }) => ({ version, file })),
    drift: state.drift,
    checks,
    pullRequest,
  };
}

/**
 * What the pull request says.
 *
 * Everything a reviewer needs to decide WITHOUT opening the diff first: which
 * version, which migrations arrive, what the notes ask, and which core files
 * this shop had already diverged on. The last one is the interesting column: it
 * is the list of places where the merge made a choice.
 */
export function pullRequestBody({ slug, from, target, migrations, notes, drift }) {
  const lines = [
    `Mise à niveau du socle de **${slug}** : ${from ? `v${from}` : 'version inconnue'} → **${target.tag}**.`,
    '',
    'Ouverte par `shopctl core upgrade`. Rien n\'a été déployé : la mise en production reste un `shopctl deploy --env production --yes` derrière l\'approbation du GitHub Environment.',
    '',
  ];
  if (migrations.length > 0) {
    lines.push(`## Migrations (${migrations.length})`, '');
    for (const path of migrations) lines.push(`- \`${path}\``);
    lines.push('', 'Additives et rétrocompatibles (ADR 0006) : l\'ancien Worker reste fonctionnel sur le nouveau schéma, donc un rollback applicatif reste possible.', '');
  }
  if (notes.length > 0) {
    lines.push('## Notes de migration', '');
    for (const note of notes) lines.push(`### v${note.version}`, '', note.body, '');
  }
  if (drift.length > 0) {
    lines.push(`## Fichiers du cœur déjà modifiés par cette boutique (${drift.length})`, '');
    for (const entry of drift.slice(0, 20)) lines.push(`- \`${entry.path}\` (${entry.owner})`);
    if (drift.length > 20) lines.push(`- … et ${drift.length - 20} autres`);
    lines.push('', 'C\'est là que la fusion a dû choisir. À relire en premier.', '');
  }
  lines.push('## Avant de fusionner', '', '- [ ] `npm run verify` vert', '- [ ] `shopctl deploy --env staging` puis smoke test', '- [ ] notes de migration appliquées', '');
  return lines.join('\n');
}
