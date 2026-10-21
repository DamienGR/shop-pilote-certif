import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The nightly workflow (plan §7.3), read as text: like deploy.yml, it is the
 * file nobody runs by hand, so the properties that make it safe are pinned
 * here rather than remembered.
 */
describe('the nightly workflow', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/nightly.yml', import.meta.url), 'utf8');
  const runs = [...workflow.matchAll(/run: \|\n((?:\s{10}.*\n)+)/g)].map((match) => match[1]);

  it('runs every night, and on demand', () => {
    expect(workflow).toMatch(/schedule:\n(?:\s+#.*\n)*\s+- cron: '[^']+'/);
    expect(workflow).toMatch(/workflow_dispatch:/);
  });

  // The night's questions are asked of staging. A production that answered
  // them would be a production that took a test session and a test e-mail.
  // Its two exceptions read: analytics, with a token that can do nothing else,
  // and its own database, for the backup. Both outside the `production`
  // environment, whose deploy token can write.
  it('reaches staging through its GitHub Environment, and production only to read its analytics and back it up', () => {
    expect(workflow).toMatch(/environment: staging/);
    expect(workflow).not.toMatch(/environment: production/);
    const production = [...workflow.matchAll(/^.*--env production.*$/gm)].map((match) => match[0].trim());
    expect(production).toEqual([
      'node shopctl/bin/shopctl.mjs backup --env production --upload --json | tee backup-production.json',
      'node shopctl/bin/shopctl.mjs monitor --env production --hours 24 --json | tee monitor-production.json',
    ]);
    const watch = workflow.slice(workflow.indexOf('production-watch:'));
    expect(watch).toMatch(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.MONITOR_CLOUDFLARE_API_TOKEN \}\}/);
    expect(watch).not.toMatch(/environment:/);
  });

  // ADR 0005's RPO once staging is gone (certification step 9). In the
  // environment `shopctl repo` limits to the default branch, never restored on
  // the runner, and kept in the bucket rather than as an artifact.
  it('backs production up every night from the backup environment, and verifies the archive without restoring it', () => {
    const job = workflow.slice(workflow.indexOf('production-backup:'), workflow.indexOf('production-watch:'));
    expect(job).toMatch(/environment: backup\n/);
    expect(job).toMatch(/shopctl\.mjs backup verify "\$ARCHIVE"/);
    expect(job).not.toMatch(/shopctl\.mjs restore/);
    expect(job).not.toMatch(/backups\//);
  });

  // Destroyed at the launch (ADR 0015), staging would turn the run red every
  // night. A repository variable retires it, and the run says so.
  it('retires the staging checks once staging is destroyed, and says so', () => {
    const staging = workflow.slice(workflow.indexOf('  staging:'), workflow.indexOf('production-backup:'));
    expect(staging).toMatch(/if: \$\{\{ needs\.detect\.outputs\.shop != '' && vars\.STAGING_RETIRED == '' \}\}/);
    const detect = workflow.slice(workflow.indexOf('  detect:'), workflow.indexOf('  staging:'));
    expect(detect).toMatch(/STAGING_RETIRED: \$\{\{ vars\.STAGING_RETIRED \}\}/);
    expect(detect).toMatch(/::notice::Staging détruit/);
  });

  it('runs the operator’s own commands rather than its own wrangler calls', () => {
    expect(workflow).toMatch(/shopctl\.mjs backup --env staging --upload/);
    expect(workflow).toMatch(/shopctl\.mjs restore --env staging --from "\$ARCHIVE" --local/);
    expect(workflow).toMatch(/shopctl\.mjs monitor --env staging/);
    expect(workflow).not.toMatch(/wrangler (deploy|d1|r2|secret)/);
  });

  it('reads each command’s exit status and not the pipe’s', () => {
    const piped = runs.filter((body) => body.includes('| tee'));
    expect(piped).toHaveLength(6);
    for (const body of piped) expect(body).toContain('set -euo pipefail');
  });

  // Secrets and variables reach a script through `env:`. Substituted into the
  // shell source, a value with a quote in it would run as a command — and a
  // secret would sit in the rendered script.
  it('never substitutes an expression into a shell script', () => {
    expect(runs.length).toBeGreaterThan(5);
    for (const body of runs) expect(body).not.toMatch(/\$\{\{/);
  });

  // The archive is the shop's whole database. It goes to the environment's own
  // bucket (decided 2026-10-06); an artifact would put it on GitHub.
  it('keeps the reports and never the archive', () => {
    const artifact = workflow.slice(workflow.indexOf('Keep the nightly reports'));
    expect(artifact).toMatch(/backup\.json/);
    expect(artifact).not.toMatch(/backups\//);
  });
});
