#!/usr/bin/env node
/**
 * Toolchain gate: the pilot builds on ONE declared Node/npm line, everywhere.
 *
 * `engines` alone only bites at install time (with engine-strict), and .nvmrc
 * only bites for humans who run `nvm use`. Neither notices when a build, a CI
 * job or a fleet-wide upgrade script runs on a different runtime than the one
 * the store was certified on — which is exactly the drift a reproducible
 * baseline has to exclude. This asserts the whole set agrees AND that the
 * process running it is inside the range.
 *
 * Checked:
 *  1. every workspace declares the same engines range (root, mcp/);
 *  2. .nvmrc names a version that satisfies that range;
 *  3. the running node satisfies it;
 *  4. the running npm satisfies it.
 *
 * `create-minshop/` is deliberately excluded: it is a package PUBLISHED to end
 * users, so its own (wider) range is a compatibility promise to them, not the
 * agency's build toolchain.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const WORKSPACES = ['package.json', 'mcp/package.json'];

const failures = [];

// ---------------------------------------------------------------------------
// A range here is a conjunction of comparators, optionally OR-ed: exactly what
// `engines` needs and no more. Bringing in a semver dependency for four
// comparisons would put a package on the critical path of the gate that
// guards the packages.

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
  if (!match) throw new Error(`unsupported comparator: ${comparator}`);
  const [, operator = '='] = match;
  // A partial bound is the lowest version with that prefix: `<23` means
  // "anything below 23.0.0".
  const bound = [match[2], match[3] ?? '0', match[4] ?? '0'].map(Number);
  const order = compare(version, bound);
  switch (operator) {
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '<':
      return order < 0;
    default:
      return order === 0;
  }
}

function satisfies(version, range) {
  return range
    .split('||')
    .some((clause) =>
      clause
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((comparator) => satisfiesComparator(version, comparator)),
    );
}

// ---------------------------------------------------------------------------
// 1. One range, declared identically by every workspace on the build path.

const declarations = WORKSPACES.map((file) => {
  const pkg = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  return { file, engines: pkg.engines };
});

for (const { file, engines } of declarations) {
  if (!engines?.node || !engines?.npm) {
    failures.push(`${file}: missing an "engines" declaration for node and npm`);
  }
}

const [reference, ...others] = declarations;
for (const { file, engines } of others) {
  if (JSON.stringify(engines) !== JSON.stringify(reference.engines)) {
    failures.push(
      `${file}: engines ${JSON.stringify(engines)} differs from ${reference.file} ` +
        `${JSON.stringify(reference.engines)} — the build path must run one toolchain`,
    );
  }
}

const nodeRange = reference.engines?.node;
const npmRange = reference.engines?.npm;

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2..4. The declared version, and the one actually running.

// `.nvmrc` may name a major only (`22`); resolve it against the range's own
// lower bound so a bare major is checked as "the oldest accepted 22.x".
const nvmrc = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
const lowerBound = parseVersion(/(?:>=?)\s*v?(\d+\.\d+\.\d+)/.exec(nodeRange)?.[1] ?? '0.0.0');
const nvmrcVersion = parseVersion(nvmrc) ?? [Number(nvmrc), 0, 0];
const nvmrcResolved =
  nvmrcVersion[0] === lowerBound[0] && /^\d+$/.test(nvmrc) ? lowerBound : nvmrcVersion;

if (!Number.isFinite(nvmrcResolved[0]) || !satisfies(nvmrcResolved, nodeRange)) {
  failures.push(`.nvmrc names ${nvmrc}, outside the declared node range "${nodeRange}"`);
}

const running = parseVersion(process.version);
if (!satisfies(running, nodeRange)) {
  failures.push(
    // `nvm install`, not `nvm use`: with a major in .nvmrc, `use` settles for
    // the newest 22.x already installed, which is the one just refused.
    `running node ${process.version} is outside "${nodeRange}" — run \`nvm install\` (.nvmrc: ${nvmrc})`,
  );
}

let npmVersion = null;
try {
  npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  failures.push('npm is not on PATH — the declared toolchain includes npm');
}
if (npmVersion && !satisfies(parseVersion(npmVersion), npmRange)) {
  failures.push(`running npm ${npmVersion} is outside the declared range "${npmRange}"`);
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(
  `✓ toolchain: node ${process.version} and npm ${npmVersion} satisfy "${nodeRange}" / "${npmRange}" (.nvmrc ${nvmrc})`,
);
