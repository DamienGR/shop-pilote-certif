/**
 * What a shop's git repository knows about the core it rides.
 *
 * A shop is a clone of a core tag with its history, keeping the core as a
 * second remote (ADR 0003). That single decision is what makes every question
 * below answerable by git rather than by a state file nobody would keep in
 * step:
 *
 *  - **which version is this shop actually on?** The newest core tag MERGED
 *    into HEAD. Not what the manifest says — the manifest is a claim, the merge
 *    is the fact, and the whole point of `core status` is to notice when the two
 *    disagree (ADR 0003, "Vérification");
 *  - **what has this shop changed in the core?** The files that differ between
 *    that tag and HEAD, classified by the ownership map (plan §3.3). A shop's
 *    theme and manifest differ by design; a core file that differs is drift,
 *    and drift is what an upgrade will conflict on;
 *  - **what does the step ask the operator to do?** The migration notes the
 *    TARGET tag carries, read out of the tag itself rather than out of the
 *    working tree, which is still on the old version when the question is asked.
 *
 * Nothing here writes to a Cloudflare account or to GitHub. The most it does is
 * fetch, branch and merge — all of it local, all of it revertible with git.
 */
import { classifyPath } from '../../scripts/path-ownership.mjs';
import { externalError, preconditionError } from './errors.mjs';
import { capture } from './process.mjs';
import { compareVersions, isCoreTag, versionFromTag, versionsBetween } from './version.mjs';

/** The remote a shop keeps the core under. Named by `shopctl new`, which
 *  renames the clone's `origin` to this and points `origin` at the shop. */
export const CORE_REMOTE = 'core';

/** Where a core tag carries what an upgrade to it asks of a shop. */
export const MIGRATION_NOTES_DIR = 'docs/migrations';

/** The branch an upgrade works on. A version per branch: two upgrades in flight
 *  on one branch would make the second one's pull request carry the first. */
export const upgradeBranch = (tag) => `socle/${tag}`;

/** Run git in a tree, without throwing on a non-zero status. */
function git(cwd, args, { allowFailure = true, input } = {}) {
  return capture('git', args, { cwd, allowFailure, input });
}

/** Lines of a git command's output, empties dropped. */
const lines = (text) =>
  String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** Is this directory the root of a git repository? */
export function isRepository(cwd) {
  const result = git(cwd, ['rev-parse', '--git-dir']);
  return result.status === 0;
}

/**
 * The URL the core is fetched from, or null when the tree has no core remote.
 *
 * `git config --get`, like forge.mjs does for `origin`, and for the same
 * reason: `git remote get-url` applies `url.<base>.insteadOf`, so it answers
 * with the rewritten URL rather than the one the shop was configured with.
 */
export function coreRemoteUrl(cwd, remote = CORE_REMOTE) {
  const result = git(cwd, ['config', '--get', `remote.${remote}.url`]);
  const url = result.status === 0 ? result.stdout.trim() : '';
  return url || null;
}

/** The core remote, or the failure that says how to add one. */
export function requireCoreRemote(cwd, remote = CORE_REMOTE) {
  const url = coreRemoteUrl(cwd, remote);
  if (url) return url;
  throw preconditionError(
    `cette boutique n'a pas de remote « ${remote} ».`,
    `Une boutique reçoit les versions du socle par ce remote (ADR 0003) : \`git remote add ${remote} <url du socle>\`, puis relancez. \`shopctl new\` le configure à la création.`,
  );
}

/** The branch checked out, or null on a detached HEAD. */
export function currentBranch(cwd) {
  const result = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * What the working tree carries that HEAD does not.
 *
 * Asked before every upgrade. A merge into a dirty tree either refuses halfway
 * or mixes the operator's unfinished work into a commit that claims to be a
 * core version — and the second one is the reason this is a hard precondition
 * rather than a warning.
 */
export function worktreeState(cwd) {
  const status = git(cwd, ['status', '--porcelain']);
  if (status.status !== 0) {
    throw externalError('git status a échoué dans cette boutique.', status.stderr.trim() || null);
  }
  const dirty = lines(status.stdout).map((line) => line.slice(3));
  return { clean: dirty.length === 0, dirty, branch: currentBranch(cwd) };
}

/** Refuse to touch a tree that has uncommitted work. */
export function assertCleanTree(cwd) {
  const state = worktreeState(cwd);
  if (state.clean) return state;
  throw preconditionError(
    `l'arbre de travail porte ${state.dirty.length} modification${state.dirty.length > 1 ? 's' : ''} non validée${state.dirty.length > 1 ? 's' : ''}.`,
    `Validez ou remisez avant de fusionner une version du socle : ${state.dirty.slice(0, 5).join(', ')}${state.dirty.length > 5 ? ', …' : ''}.`,
  );
}

/** Core version tags this clone already has, newest last. */
export function localCoreTags(cwd) {
  const result = git(cwd, ['tag', '--list']);
  if (result.status !== 0) return [];
  return lines(result.stdout).filter(isCoreTag).sort(compareVersions);
}

/**
 * Core version tags MERGED into HEAD, newest last.
 *
 * `git tag --merged HEAD` answers "which tags are ancestors of what is checked
 * out", which is exactly "which core versions has this shop taken". A tag the
 * clone has fetched but not merged is not one of them — that distinction is the
 * difference between a shop that received an upgrade and one that was merely
 * offered it.
 */
export function mergedCoreTags(cwd, ref = 'HEAD') {
  const result = git(cwd, ['tag', '--list', '--merged', ref]);
  if (result.status !== 0) return [];
  return lines(result.stdout).filter(isCoreTag).sort(compareVersions);
}

/**
 * The core tag a shop was on BEFORE the merge that brought `tag`, read from
 * that merge's first parent.
 *
 * Asked on a resumption, when `tag` is already merged into HEAD. "The newest
 * local tag below the target" is not the same question: a shop on v0.3.24
 * resuming its step to v0.3.26 in a clone that has fetched v0.3.25 would start
 * from v0.3.25, and its pull request would drop that version's notes and
 * migrations. Null when no merge on the first-parent line carries `tag`.
 */
export function previousCoreTag(cwd, tag) {
  const merges = git(cwd, ['rev-list', '--first-parent', '--merges', 'HEAD']);
  if (merges.status !== 0) return null;
  for (const commit of lines(merges.stdout)) {
    if (git(cwd, ['merge-base', '--is-ancestor', tag, `${commit}^2`]).status !== 0) continue;
    if (git(cwd, ['merge-base', '--is-ancestor', tag, `${commit}^1`]).status === 0) continue;
    return mergedCoreTags(cwd, `${commit}^1`).at(-1) ?? null;
  }
  return null;
}

/** The core version this shop is actually on, from its history. Null when no
 *  core tag is merged — a shop whose clone lost its tags, or a tree that is not
 *  a shop at all. */
export function mergedCoreVersion(cwd) {
  const tag = mergedCoreTags(cwd).at(-1);
  return tag ? versionFromTag(tag) : null;
}

/** Fetch the core's tags. Never fetches branches: a shop rides tags, and a
 *  fetched `core/main` is a moving target sitting in the shop's own clone. */
export function fetchCoreTags(cwd, { remote = CORE_REMOTE } = {}) {
  requireCoreRemote(cwd, remote);
  const result = git(cwd, ['fetch', '--tags', '--quiet', remote]);
  if (result.status !== 0) {
    throw externalError(
      `impossible de récupérer les tags du socle depuis « ${remote} ».`,
      result.stderr.trim().split('\n')[0] || 'Vérifiez l\'accès réseau et les identifiants du dépôt du socle.',
    );
  }
  return localCoreTags(cwd);
}

/**
 * Core versions a repository publishes, asked over the wire.
 *
 * `--refs` drops the `^{}` peeled entries an annotated tag adds; without it a
 * version would be listed twice and the report would say the fleet is two tags
 * behind when it is one.
 */
export function publishedCoreTags(repository, { cwd } = {}) {
  const result = capture('git', ['ls-remote', '--tags', '--refs', repository], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  return lines(result.stdout)
    .map((line) => line.split('refs/tags/')[1])
    .filter(Boolean)
    .filter(isCoreTag)
    .sort(compareVersions);
}

/** Does this clone have that tag? */
export function hasTag(cwd, tag) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0;
}

/**
 * Files that differ between a core tag and HEAD, classified by owner.
 *
 * `client` differences are the shop: its manifest, its theme, its content. They
 * are not drift and are not reported as such. `core` and `generated`
 * differences are: the shop has edited files the next core version will also
 * edit, and every one of them is a conflict waiting for the upgrade that
 * touches it (plan §3.3).
 *
 * A generated file counts. `wrangler.jsonc` is rendered from the manifest, so a
 * difference there means either the generator ran on a different manifest — no
 * news — or someone hand-edited it, which the next render silently discards.
 */
export function coreDrift(cwd, tag) {
  const result = git(cwd, ['diff', '--name-only', `${tag}`, 'HEAD']);
  if (result.status !== 0) {
    throw externalError(`git ne sait pas comparer ${tag} à HEAD dans cette boutique.`, result.stderr.trim() || null);
  }
  const drift = [];
  for (const path of lines(result.stdout)) {
    const hit = classifyPath(path);
    const owner = hit?.owner ?? 'unclassified';
    if (owner === 'client') continue;
    drift.push({ path, owner });
  }
  return drift.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The migration notes a range of versions carries, read out of the TARGET tag.
 *
 * Out of the tag and not the working tree, because the working tree is still on
 * the old version when an operator asks what the new one will require — and a
 * note that only appears after the merge is a note nobody read before deciding.
 *
 * @returns {Array<{ version: string, file: string, body: string }>} oldest first
 */
export function migrationNotes(cwd, tag, { from = null } = {}) {
  const listed = git(cwd, ['ls-tree', '-r', '--name-only', tag, `${MIGRATION_NOTES_DIR}/`]);
  if (listed.status !== 0) return [];
  const files = lines(listed.stdout).filter((path) => /\/v\d+\.\d+\.\d+\.md$/.test(path));
  const versions = versionsBetween(
    files.map((file) => file.replace(/^.*\/v/, '').replace(/\.md$/, '')),
    from,
    versionFromTag(tag),
  );
  return versions.map((version) => {
    const file = `${MIGRATION_NOTES_DIR}/v${version}.md`;
    const body = git(cwd, ['show', `${tag}:${file}`]);
    return { version, file, body: body.status === 0 ? body.stdout.trim() : '' };
  });
}

/** Create the upgrade branch, or check it out when a previous run left one. */
export function checkoutBranch(cwd, branch) {
  if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) {
    const result = git(cwd, ['checkout', '--quiet', branch]);
    if (result.status !== 0) {
      throw externalError(`impossible de basculer sur la branche ${branch}.`, result.stderr.trim() || null);
    }
    return { branch, created: false };
  }
  const result = git(cwd, ['checkout', '--quiet', '-b', branch]);
  if (result.status !== 0) {
    throw externalError(`impossible de créer la branche ${branch}.`, result.stderr.trim() || null);
  }
  return { branch, created: true };
}

/**
 * Merge a core tag into the current branch.
 *
 * `--no-ff`, always: a shop that happens to have no commits of its own would
 * otherwise fast-forward, and the upgrade would leave no commit saying which
 * version was taken and when. `--no-commit` is NOT used — the merge commit is
 * the record, and stopping short of it would leave every shop in the fleet
 * mid-merge.
 *
 * A conflict is a RESULT, not an exception: the tree is left exactly as git
 * left it, with the conflict markers in place, because resolving it is git work
 * in that tree and an automatic `--abort` would throw away the only copy of the
 * three-way state the operator needs. The caller decides what to say about it.
 *
 * A conflict on a GENERATED file is the exception, and is resolved here: nobody
 * chooses between two outputs of a generator. The new core's copy is taken, and
 * the upgrade re-renders `wrangler.jsonc` from the shop's manifest right after.
 * The shop's rendering conflicts with the core's own `wrangler.jsonc` at every
 * version that edits it, since the two differ from the first line: v0.3.26
 * stopped the pilot's upgrade there for a file the next step rewrote anyway
 * (certification, step 11).
 *
 * @returns {{ ok: boolean, conflicts: Array<{ path: string, owner: string }>, resolved: string[], output: string }}
 */
export function mergeCoreTag(cwd, tag, { message } = {}) {
  const result = git(cwd, ['merge', '--no-ff', '--no-edit', ...(message ? ['-m', message] : []), tag]);
  if (result.status === 0) return { ok: true, conflicts: [], resolved: [], output: result.stdout.trim() };

  const unmerged = git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  const found = lines(unmerged.stdout).map((path) => ({
    path,
    owner: classifyPath(path)?.owner ?? 'unclassified',
  }));
  if (found.length === 0) {
    // Not a conflict: the merge itself refused (unrelated histories, a tag that
    // is not an ancestor of anything, an index git could not lock). Relaying
    // git's own first line beats inventing a diagnosis.
    throw externalError(
      `la fusion de ${tag} a échoué sans conflit de fichier.`,
      lines(result.stderr).at(0) ?? lines(result.stdout).at(0) ?? null,
    );
  }

  const resolved = [];
  for (const entry of found) {
    if (entry.owner !== 'generated') continue;
    if (git(cwd, ['checkout', '--theirs', '--', entry.path]).status !== 0) continue;
    if (git(cwd, ['add', '--', entry.path]).status === 0) resolved.push(entry.path);
  }
  const conflicts = found.filter((entry) => !resolved.includes(entry.path));
  if (conflicts.length > 0) {
    return { ok: false, conflicts, resolved, output: `${result.stdout}${result.stderr}`.trim() };
  }
  // Every conflict was a generated file: the merge commit is the record, with
  // the message the merge was given.
  const commit = git(cwd, ['commit', '--quiet', '--no-edit']);
  if (commit.status !== 0) {
    throw externalError(`la fusion de ${tag} n'a pas pu être validée.`, lines(commit.stderr).at(0) ?? null);
  }
  return { ok: true, conflicts: [], resolved, output: `${result.stdout}${result.stderr}`.trim() };
}

/** Back out of a merge that conflicted, leaving the branch as it was. */
export function abortMerge(cwd) {
  return git(cwd, ['merge', '--abort']).status === 0;
}

/** Commit whatever is staged, or report that there was nothing to commit. */
export function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  const staged = git(cwd, ['diff', '--cached', '--name-only']);
  if (lines(staged.stdout).length === 0) return { committed: false, files: [] };
  const result = git(cwd, ['commit', '--quiet', '-m', message]);
  if (result.status !== 0) {
    throw externalError('git commit a échoué après la fusion.', lines(result.stderr).at(0) ?? null);
  }
  return { committed: true, files: lines(staged.stdout) };
}

/** Migrations a step adds, by name. Read from the diff rather than from the
 *  directory: what matters is what the shop does NOT have yet. */
export function pendingMigrations(cwd, fromTag, toTag) {
  const result = git(cwd, ['diff', '--name-only', '--diff-filter=A', fromTag, toTag, '--', 'migrations/']);
  if (result.status !== 0) return [];
  return lines(result.stdout);
}

/**
 * Migration files a step CHANGED or DELETED.
 *
 * ADR 0006 forbids both: a published migration is never rewritten, because a
 * database that already ran it will not run it again and the fleet diverges in
 * silence. The upgrade path is where a shop would find out, so it is where the
 * question is asked.
 */
export function rewrittenMigrations(cwd, fromTag, toTag) {
  const result = git(cwd, ['diff', '--name-only', '--diff-filter=MDR', fromTag, toTag, '--', 'migrations/']);
  if (result.status !== 0) return [];
  return lines(result.stdout);
}
