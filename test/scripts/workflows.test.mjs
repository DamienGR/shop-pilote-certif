import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Properties every workflow shares, read as text like nightly.test.mjs reads
 * its one file: a workflow is the code nobody runs before it matters.
 */
const dir = new URL('../../.github/workflows/', import.meta.url);
const workflows = readdirSync(dir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => ({ file, text: readFileSync(new URL(file, dir), 'utf8') }));

/** The composite actions the workflows call: their steps run in the same jobs. */
const actionsDir = new URL('../../.github/actions/', import.meta.url);
const actions = readdirSync(actionsDir).map((name) => ({
  file: `actions/${name}/action.yml`,
  text: readFileSync(new URL(`${name}/action.yml`, actionsDir), 'utf8'),
}));

/** The fleet repository's workflows (ADR 0019), rendered by `shopctl fleet init`. */
const fleetDir = new URL('../../shopctl/templates/fleet/', import.meta.url);
const fleetTemplates = readdirSync(fleetDir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => ({ file: `fleet/${file}`, text: readFileSync(new URL(file, fleetDir), 'utf8') }));

/**
 * The plain one-line values YAML refuses: a `: ` or a ` #` inside a value that
 * is neither quoted nor a block scalar. GitHub then shows the workflow by its
 * path, with no job, and runs nothing — the Nightly of a pull request of the
 * shared account (lot 4) read that way for three commits while `verify`
 * stayed green, because nothing here parses YAML (and no parser is a
 * dependency). Lines inside a block scalar (`run: |`) are shell, not YAML.
 */
function unparsablePlainValues(text) {
  const found = [];
  let block = null;
  for (const [index, line] of text.split('\n').entries()) {
    const indent = line.length - line.trimStart().length;
    if (block !== null) {
      if (line.trim() === '' || indent > block) continue;
      block = null;
    }
    if (/^\s*#/.test(line)) continue;
    const pair = line.match(/^\s*(?:- )?[\w.-]+: (.*)$/);
    if (!pair) continue;
    const value = pair[1];
    if (/^[|>][-+]?\s*$/.test(value)) {
      block = indent;
      continue;
    }
    if (/^["'[{]/.test(value)) continue;
    if (/: /.test(value) || / #/.test(value) || /:$/.test(value)) found.push(`${index + 1}: ${line.trim()}`);
  }
  return found;
}

/**
 * The first major of each action that runs on Node 24. GitHub forces Node 20
 * actions onto 24 and warns on every run until they move (the nightly of
 * certification step 9 carried that warning for `upload-artifact@v4`). An
 * action missing here fails the test, so a new one is checked once.
 */
const NODE_24 = { checkout: 6, 'setup-node': 6, 'upload-artifact': 6 };

describe('the workflows', () => {
  it('finds the workflows it is meant to be reading', () => {
    expect(workflows.map((w) => w.file)).toEqual(expect.arrayContaining(['deploy.yml', 'nightly.yml', 'verify.yml']));
    expect(fleetTemplates.map((w) => w.file)).toEqual(expect.arrayContaining(['fleet/deploy.yml', 'fleet/nightly.yml']));
  });

  it('writes no one-line value YAML would read as a second mapping', () => {
    const files = [...workflows, ...actions, ...fleetTemplates];
    const found = files.flatMap(({ file, text }) => unparsablePlainValues(text).map((line) => `${file}:${line}`));
    expect(found).toEqual([]);
    // The check itself, on the line that broke the Nightly.
    expect(unparsablePlainValues('      - name: x\n        run: echo "::notice::a (b) : c"\n')).toHaveLength(1);
    expect(unparsablePlainValues('        run: |\n          echo "a : b"\n        if: ${{ a }}\n')).toEqual([]);
  });

  // GitHub evaluates a job's name only when the job runs. A skipped one shows
  // the expression itself, and a retired staging read
  // "Staging (${{ needs.detect.outputs.shop }})" in every nightly after it.
  it('names no job from another job’s outputs', () => {
    const names = workflows.flatMap(({ file, text }) =>
      [...text.matchAll(/^ {4}name: (.*)$/gm)].map((match) => `${file}: ${match[1]}`),
    );
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => name.includes('needs.'))).toEqual([]);
  });

  it('uses only actions that run on Node 24', () => {
    const used = workflows.flatMap(({ file, text }) =>
      [...text.matchAll(/uses: actions\/([\w-]+)@v(\d+)/g)].map(([, action, major]) => ({ file, action, major: Number(major) })),
    );
    expect(used.length).toBeGreaterThan(10);
    const behind = used.filter(({ action, major }) => !(major >= NODE_24[action]));
    expect(behind.map(({ file, action, major }) => `${file}: actions/${action}@v${major}`)).toEqual([]);
  });

  // `--with-deps` made Install Chromium an apt-get install from
  // azure.archive.ubuntu.com, which sometimes serves at 45 kB/s: ten minutes
  // instead of twenty seconds, on several Browser jobs of one run. The runner
  // image already has every library Chromium needs (verify.yml says why), so
  // apt runs only when a launch says one is missing.
  it('installs Chromium without apt, unless a launch says a library is missing', () => {
    const code = (text) => text.replace(/^\s*#.*\n/gm, '');
    expect(workflows.filter(({ text }) => code(text).includes('--with-deps')).map(({ file }) => file)).toEqual([]);

    const steps = workflows.flatMap(({ file, text }) =>
      [...code(text).matchAll(/- name: Install Chromium\n((?: {8}.*\n)+)/g)].map((match) => ({ file, step: match[1] })),
    );
    expect(steps.map(({ file }) => file).sort()).toEqual(['nightly.yml', 'verify.yml']);
    for (const { step } of steps) {
      expect(step).toMatch(/^ +npx playwright install chromium$/m);
      expect(step).toMatch(/chromium\.launch\(\)[\s\S]*\|\| \{[\s\S]*npx playwright install-deps chromium/);
    }
    // One step in two files: the nightly's copy is the one that would drift.
    expect(new Set(steps.map(({ step }) => step.slice(step.indexOf('run: |')))).size).toBe(1);
  });

  // `.nvmrc` names a major, and setup-node resolves a major to the newest
  // version cached on the runner image, which trails Node's releases by weeks.
  // Astro 7.4 requires 22.23.4, the security release of 2026-10-20; the image
  // still had 22.23.3, and engine-strict refused every install of that
  // Dependabot pull request. check-latest asks Node's own list instead.
  it('installs the newest Node of the .nvmrc line, not the one the image cached', () => {
    // One chunk per step: a step starts at a `- ` list item.
    const steps = [...workflows, ...actions].flatMap(({ file, text }) =>
      text
        .split(/^ *- /m)
        .filter((step) => step.includes('uses: actions/setup-node@') && step.includes('node-version-file: .nvmrc'))
        .map((step) => ({ file, step })),
    );
    expect(steps.map(({ file }) => file)).toContain('actions/run-verify/action.yml');
    expect(steps.length).toBeGreaterThan(10);
    expect(steps.filter(({ step }) => !/^ +check-latest: true$/m.test(step)).map(({ file }) => file)).toEqual([]);
  });
});
