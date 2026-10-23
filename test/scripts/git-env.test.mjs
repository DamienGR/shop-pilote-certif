import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GIT_ENV } from '../helpers/core-repository.mjs';

describe('the git environment of the suites', () => {
  // Since git 2.47 a commit ends by starting `git maintenance run --auto
  // --detach`, which takes and drops a lock in `.git/objects` after the commit
  // has returned. A suite that copies a repository it just committed to
  // (`cloneCoreTemplate`) then loses that file mid-copy: ENOENT on
  // `core/.git/objects`, on the CI of the pilot's step-9 evidence. Older git
  // runs the same maintenance before returning, which is why no workstation
  // saw it; the trace shows it on both.
  it('commits without starting a maintenance run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'minshop-git-env-'));
    const git = (args, env = GIT_ENV) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    git(['init', '--quiet']);
    writeFileSync(join(repo, 'file'), 'content\n');
    git(['add', 'file']);

    const commit = git(['commit', '--quiet', '-m', 'commit'], { ...GIT_ENV, GIT_TRACE: '1' });

    expect(commit.status).toBe(0);
    expect(commit.stderr).toContain('built-in: git commit');
    expect(commit.stderr).not.toContain('maintenance run');
  });
});
