#!/usr/bin/env node
/**
 * The file-ownership gate (plan §3.3).
 *
 * Two jobs, and they answer different questions.
 *
 * The MAP: every tracked file is classified core, client or generated. Run
 * everywhere, on every commit. It fails on a path no rule covers, which is what
 * keeps the boundary honest as the tree grows: a new top-level directory has to
 * be assigned once, deliberately, instead of drifting into whichever category
 * a catch-all would have given it.
 *
 * The GATE (--changed): a change presented as a customization must not touch a
 * core file without saying so. This only runs in a SHOP repository — a tree
 * with client/client.yaml — because in the core repository every pull request
 * touches the core, and a gate that fires on every change teaches people to
 * skip it. A shop that genuinely needs a core edit says so explicitly:
 *
 *   MINSHOP_CORE_CHANGE=approved   in CI, set from a reviewed label
 *   Approves-core-change: <why>    as a trailer on a commit in the range
 *
 * Both are deliberate acts that survive in the record, which is the whole
 * point: the edit is allowed, being unremarked is not. An approved core edit is
 * still a divergence to re-resolve at the next upgrade (ADR 0003).
 *
 * Usage:
 *   node scripts/check-paths.mjs [--json] [--write]
 *   node scripts/check-paths.mjs --changed [--base <ref>]
 *
 *   --write  regenerate .github/CODEOWNERS instead of failing on drift
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OWNERS, classifyPaths, coreChangeGate, renderCodeowners } from './path-ownership.mjs';
import { isShopRepository } from './manifest.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const write = args.includes('--write');
const changed = args.includes('--changed');
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';
const root = process.cwd();

export const CODEOWNERS_FILE = '.github/CODEOWNERS';

const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();

function checkCodeowners() {
  const path = resolve(root, CODEOWNERS_FILE);
  const expected = renderCodeowners();

  if (write) {
    writeFileSync(path, expected);
    return { ok: true, wrote: true };
  }
  if (!existsSync(path)) {
    return { ok: false, message: `${CODEOWNERS_FILE} is missing. Run \`npm run check:paths -- --write\`.` };
  }
  if (readFileSync(path, 'utf8') !== expected) {
    return {
      ok: false,
      message: `${CODEOWNERS_FILE} no longer matches scripts/path-ownership.mjs. It is only ever read by GitHub, on someone else's pull request, so drift here is invisible until a core change is approved by nobody. Run \`npm run check:paths -- --write\`.`,
    };
  }
  return { ok: true };
}

/** The commit this change forked from. Resolved once and reported clearly when
 *  the ref is absent: a shallow clone is the usual cause, and a stack trace
 *  from `git merge-base` names neither the ref nor the fix. */
function mergeBase() {
  try {
    return git('merge-base', 'HEAD', base);
  } catch {
    console.error(`✗ cannot compare against "${base}": no such ref in this clone.`);
    console.error('    Fetch it first (`git fetch origin <branch>`), or pass --base <ref>. In CI, check out with fetch-depth: 0.');
    process.exit(2);
  }
}

/** Changed paths between the merge base and the working tree, deletions
 *  included: a deleted core file is as much a core change as an edited one. */
function changedPaths(merge) {
  return git('diff', '--name-only', merge, '--')
    .split('\n')
    .filter(Boolean);
}

/** Blob ids of a commit's tree, by path. */
function treeBlobs(commit) {
  const blobs = new Map();
  for (const line of git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean)) {
    const [meta, path] = line.split('\t');
    blobs.set(path, meta.split(' ')[2]);
  }
  return blobs;
}

/**
 * The changed paths a core upgrade brought in as they are.
 *
 * `shopctl core upgrade` merges a core release, so every file the release
 * touched is in the diff. What makes such a file the core's rather than the
 * shop's is its content: exactly that of the core commit merged in — or absent
 * from both, when the release deleted it. A core commit is told from a shop's by
 * carrying no client manifest. Content, not provenance: an edit slipped into an
 * upgrade differs from the release and stays in the gate.
 */
function carriedFromCore(merge, paths) {
  const cores = git('log', '--merges', '--format=%P', `${merge}..HEAD`)
    .split('\n')
    .filter(Boolean)
    .flatMap((parents) => parents.split(' ').slice(1))
    .map(treeBlobs)
    .filter((blobs) => !blobs.has('client/client.yaml'));
  if (cores.length === 0 || paths.length === 0) return [];

  const present = paths.filter((path) => existsSync(resolve(root, path)));
  const ids = present.length > 0
    ? execFileSync('git', ['hash-object', '--stdin-paths'], { cwd: root, encoding: 'utf8', input: present.join('\n') }).trim().split('\n')
    : [];
  const ours = new Map(present.map((path, index) => [path, ids[index]]));
  return paths.filter((path) => cores.some((blobs) => blobs.get(path) === ours.get(path)));
}

function approval(merge) {
  if (process.env.MINSHOP_CORE_CHANGE === 'approved') return { by: 'MINSHOP_CORE_CHANGE=approved' };
  const trailer = git('log', '--format=%(trailers:key=Approves-core-change,valueonly)', `${merge}..HEAD`)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return trailer ? { by: `Approves-core-change: ${trailer}` } : null;
}

const tracked = git('ls-files').split('\n').filter(Boolean);
const map = classifyPaths(tracked);
const codeowners = checkCodeowners();
const shop = isShopRepository(root);

let gate = null;
if (changed) {
  const merge = mergeBase();
  const approved = approval(merge);
  const paths = changedPaths(merge);
  const carried = shop ? carriedFromCore(merge, paths) : [];
  gate = { base, approved, ...coreChangeGate({ paths, isShop: shop, approval: approved, carried }) };
}

const ok = map.unclassified.length === 0 && codeowners.ok && (gate === null || gate.ok);

if (asJson) {
  console.log(JSON.stringify({ ok, repository: shop ? 'shop' : 'core', owners: map.owned, unclassified: map.unclassified, codeowners, gate }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (map.unclassified.length > 0) {
  console.error(`✗ ${map.unclassified.length} tracked path(s) belong to no ownership rule:`);
  for (const path of map.unclassified.slice(0, 20)) console.error(`    ${path}`);
  if (map.unclassified.length > 20) console.error(`    … and ${map.unclassified.length - 20} more`);
  console.error('    Add a rule to scripts/path-ownership.mjs. Core, client or generated is a decision, not a default.');
} else {
  console.log(`✓ ownership map: ${OWNERS.map((owner) => `${map.owned[owner].length} ${owner}`).join(', ')} — ${tracked.length} tracked files`);
}

if (codeowners.wrote) console.log(`✓ ${CODEOWNERS_FILE} regenerated`);
else if (!codeowners.ok) console.error(`✗ ${codeowners.message}`);
else console.log(`✓ ${CODEOWNERS_FILE} matches the ownership rules`);

if (gate) {
  if (!gate.enforced) {
    console.log(`• core-change gate: not enforced here (this is the core repository, not a shop) — ${gate.core.length} core path(s) in ${gate.changed.length} changed since ${base}`);
  } else if (gate.core.length === 0) {
    const fromCore = gate.carried.length > 0 ? `, ${gate.carried.length} core path(s) as a merged core release has them` : '';
    console.log(`✓ core-change gate: ${gate.changed.length} changed path(s) since ${base}, none edited by the shop${fromCore}`);
  } else if (gate.approved) {
    console.log(`✓ core-change gate: ${gate.core.length} core path(s) changed, approved by ${gate.approved.by}`);
  } else {
    console.error(`✗ core-change gate: ${gate.core.length} core-owned path(s) changed with no approval:`);
    for (const path of gate.core.slice(0, 20)) console.error(`    ${path}`);
    console.error('    A shop may edit a core file, but not silently: every core edit is a divergence to re-resolve at the next upgrade (ADR 0003).');
    console.error('    Approve it with the reviewed CI label (MINSHOP_CORE_CHANGE=approved) or an `Approves-core-change: <why>` commit trailer.');
  }
}

if (!ok) process.exit(1);
