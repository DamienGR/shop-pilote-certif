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
});
