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

  // ADR 0005's 24-hour RPO, held by two backups a day: GitHub started the
  // 03:17 run five hours late during the certification, and one run a day left
  // two archives more than 24 hours apart (step 11). The second schedule runs
  // the production backup and nothing else.
  it('backs production up a second time, twelve hours later, and only that', () => {
    const crons = [...workflow.matchAll(/^\s+- cron: '([^']+)'$/gm)].map((match) => match[1]);
    expect(crons).toEqual(['17 3 * * *', '17 15 * * *']);
    const section = workflow.slice(workflow.indexOf('\njobs:\n'));
    const jobs = [...section.matchAll(/^ {2}([a-z-]+):\n((?: {4}.*\n|\s*\n)+)/gm)].map(([, name, body]) => ({ name, body }));
    expect(jobs.map((job) => job.name)).toEqual(['suite', 'audit', 'detect', 'staging', 'production-backup', 'production-watch']);
    const backupOnly = "github.event.schedule != '17 15 * * *'";
    for (const job of jobs) {
      const runsAtMidday = ['detect', 'production-backup'].includes(job.name);
      const condition = job.body.match(/^ {4}if: (.*)$/m)?.[1] ?? '';
      expect(condition.includes(backupOnly), job.name).toBe(!runsAtMidday);
    }
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
  // night. A repository variable retires it, and the run says so. A shop built
  // straight on its production never had one (ADR 0015, amended 2026-10-27):
  // the staging half runs only for a staging the shop DECLARES.
  it('runs the staging checks only for a declared staging that is still there, and says why not', () => {
    const staging = workflow.slice(workflow.indexOf('\n  staging:\n'), workflow.indexOf('production-backup:'));
    expect(staging).toMatch(/if: \$\{\{ needs\.detect\.outputs\.staging == 'true' && /);
    const detect = workflow.slice(workflow.indexOf('  detect:'), workflow.indexOf('\n  staging:\n'));
    expect(detect).toMatch(/staging: \$\{\{ steps\.shop\.outputs\.staging \}\}/);
    expect(detect).toMatch(/STAGING_RETIRED: \$\{\{ vars\.STAGING_RETIRED \}\}/);
    expect(detect).toMatch(/STAGING_URL: \$\{\{ vars\.STAGING_URL \}\}/);
    expect(detect).toMatch(/manifest\.cloudflare\.stagingDomain/);
    expect(detect).toMatch(/::notice::Staging détruit/);
    expect(detect).toMatch(/::notice::Aucun staging déclaré/);
    // Retired wins over declared: the manifest of a launched shop still names
    // the preview's hostname.
    expect(detect.indexOf('STAGING_RETIRED" ]')).toBeLessThan(detect.indexOf('staging=true'));
  });

  // On the shared account (ADR 0019) the shop's repository holds no Cloudflare
  // token: the fleet's Nightly backs production up and watches it, and every
  // step here that needs a token stands aside, said once.
  it('leaves the account to the fleet when MINSHOP_FLEET names one', () => {
    for (const job of ['production-backup', 'production-watch']) {
      const body = workflow.slice(workflow.indexOf(`  ${job}:`));
      expect(body.match(/^ {4}if: (.*)$/m)[1], job).toContain("vars.MINSHOP_FLEET == ''");
    }
    const staging = workflow.slice(workflow.indexOf('\n  staging:\n'), workflow.indexOf('production-backup:'));
    const step = (name) => staging.slice(staging.indexOf(`- name: ${name}`)).split('\n      - name:')[0];
    expect(step('Back up staging')).toMatch(/if: \$\{\{ vars\.MINSHOP_FLEET == '' \}\}/);
    expect(step('Error rate and quotas')).toMatch(/vars\.MINSHOP_FLEET == ''/);
    // The restore follows the backup's outcome, skipped with it.
    expect(step('Restore it into a throwaway database')).toMatch(/steps\.backup\.outcome == 'success'/);
    expect(step('Leave the account to the fleet')).toMatch(/if: \$\{\{ vars\.MINSHOP_FLEET != '' \}\}/);
    // The remote gates need no Cloudflare token, and keep running.
    expect(step('Remote security gate')).not.toMatch(/MINSHOP_FLEET/);
  });

  it('runs the operator’s own commands rather than its own wrangler calls', () => {
    expect(workflow).toMatch(/shopctl\.mjs backup --env staging --upload/);
    // The pull before the restore: an uploaded archive leaves in the pool the
    // media it did not re-read, and the drill restores those too.
    expect(workflow).toMatch(/shopctl\.mjs backup pull "\$ARCHIVE" --env staging --json \| tee pull\.json\n\s+node shopctl\/bin\/shopctl\.mjs restore --env staging --from "\$ARCHIVE" --local/);
    expect(workflow).toMatch(/shopctl\.mjs monitor --env staging/);
    expect(workflow).not.toMatch(/wrangler (deploy|d1|r2|secret)/);
  });

  it('reads each command’s exit status and not the pipe’s', () => {
    const piped = runs.filter((body) => body.includes('| tee'));
    expect(piped).toHaveLength(6);
    expect(runs.filter((body) => (body.match(/\| tee/g) ?? []).length > 1)).toHaveLength(1);
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
