import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The shell gates that boot the built Worker, read as text: what they leave
 * behind only shows on the next run, as a port already taken.
 */
const scripts = ['storefront-baselines.sh', 'd1-integration.sh'].map((file) => ({
  file,
  text: readFileSync(new URL(`../integration/${file}`, import.meta.url), 'utf8'),
}));

describe('the integration scripts', () => {
  // `npx` does not pass a signal on. Killing it left `wrangler dev` and its
  // workerd running under init, holding the port: seven of them kept the
  // storefront baselines from binding 8792 while v0.3.18 was being prepared
  // (certification step 9). The server gets a process group of its own, and
  // the cleanup stops the whole group.
  it.each(scripts)('$file stops the whole server, not only npx', ({ text }) => {
    const start = text.indexOf('npx wrangler dev');
    expect(start).toBeGreaterThan(0);
    expect(text.lastIndexOf('set -m\n', start)).toBeGreaterThan(0);
    expect(text.indexOf('set +m\n', start)).toBeGreaterThan(start);
    expect(text).toMatch(/kill -- "-\$worker_pid"/);
    expect(text).not.toMatch(/kill "\$worker_pid"/);
  });

  // Under job control a background job keeps the terminal, and wrangler reads
  // its hotkeys from it: a background read stops the server (SIGTTIN) when the
  // script runs from a terminal.
  it.each(scripts)('$file gives the server no terminal to read', ({ text }) => {
    const command = text.slice(text.indexOf('npx wrangler dev'), text.indexOf('worker_pid="$!"'));
    expect(command).toMatch(/<\/dev\/null/);
  });
});
