import { describe, expect, it } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseCapture, readNeedles, scanCapture } from '../remote/logs.mjs';

const SCRIPT = resolve(import.meta.dirname, '../remote/logs.mjs');

// Assembled, so that this file is not itself a finding of the secret scan.
const STRIPE_KEY = ['sk', 'live', 'Zq8Lm3Rt7Vx2Nc5Bk9Wd4Hs6'].join('_');
const GUEST_TOKEN = 'otk_' + 'Ab3dEf5hIj7lMn9pQr1tUw';
const ACCESS_ASSERTION = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJvcGVyYXRvciJ9', 'c2ln'].join('.');

/** One event as `wrangler tail --format json` prints it. */
function fetchEvent({ url = 'https://shop.example/', logs = [], exceptions = [], headers = {}, cf = {} } = {}) {
  return {
    outcome: 'ok',
    scriptName: 'minshop-witness-staging',
    exceptions,
    logs: logs.map((message) => ({ message: [message], level: 'log', timestamp: 1 })),
    eventTimestamp: 1,
    event: { request: { url, method: 'GET', headers, cf }, response: { status: 200 } },
  };
}

/** wrangler's own layout: each event pretty-printed with four spaces. */
const capture = (events) => events.map((event) => JSON.stringify(event, null, 4)).join('\n') + '\n';

describe('the tail capture reader', () => {
  it('reads pretty-printed and one-line events, and counts what is neither', () => {
    const text = capture([fetchEvent(), fetchEvent()]) + JSON.stringify(fetchEvent()) + '\nConnected to minshop, waiting for logs...\n';
    const { events, ignored } = parseCapture(text);
    expect(events).toHaveLength(3);
    expect(ignored).toBe(1);
  });

  it('keeps needles of three characters or more, from `;` or new lines', () => {
    expect(readNeedles('Jeanne Testeuse; 12 rue des Lilas\nFR;35000')).toEqual(['Jeanne Testeuse', '12 rue des Lilas', '35000']);
    expect(readNeedles(undefined)).toEqual([]);
  });
});

describe('what the shop wrote', () => {
  it('fails on an address, a token, a key or a typed value in a log line or an exception', () => {
    const report = scanCapture(
      [
        fetchEvent({ logs: ['order mail failed for jeanne@example.fr'] }),
        fetchEvent({ logs: [`guest link ${GUEST_TOKEN}`] }),
        fetchEvent({ exceptions: [{ name: 'Error', message: `bad key ${STRIPE_KEY}` }] }),
        fetchEvent({ logs: ['shipping to 12 Rue des Lilas'] }),
      ],
      ['12 rue des Lilas'],
    );
    expect(report.application.map((entry) => entry.kind).sort()).toEqual(['donnée cherchée', 'e-mail', 'jeton invité', 'secret']);
    expect(report.url).toEqual([]);
  });

  // The report is a proof committed to a repository: it names a finding, it
  // never reproduces it.
  it('never reproduces what it found', () => {
    const report = scanCapture([fetchEvent({ logs: [`jeanne@example.fr ${GUEST_TOKEN} ${STRIPE_KEY} Jeanne Testeuse`] })], ['Jeanne Testeuse']);
    const text = JSON.stringify(report);
    for (const value of ['jeanne@example.fr', GUEST_TOKEN, STRIPE_KEY, 'Jeanne Testeuse']) expect(text).not.toContain(value);
    expect(text).toContain('j…@e….fr');
  });

  it('judges a guest token left in a URL apart from the application', () => {
    const report = scanCapture([fetchEvent({ url: `https://shop.example/order/${GUEST_TOKEN}` }), fetchEvent({ url: 'https://shop.example/order/REDACTED' })]);
    expect(report.application).toEqual([]);
    expect(report.url).toEqual([expect.objectContaining({ kind: 'jeton invité', where: 'event.request.url', count: 1, events: [0] })]);
  });

  // Behind a private preview, Access writes the operator's identity on every
  // request, and the visitor's postcode is Cloudflare's geolocation: reported,
  // never held against the shop.
  it('reports what the platform and the browser wrote without judging it', () => {
    const report = scanCapture(
      [
        fetchEvent({
          headers: { 'cf-access-authenticated-user-email': 'operator@example.fr', 'cf-access-jwt-assertion': ACCESS_ASSERTION },
          cf: { postalCode: '35000' },
        }),
      ],
      ['35000'],
    );
    expect(report.application).toEqual([]);
    expect(report.url).toEqual([]);
    expect(report.platform.map((entry) => `${entry.kind} ${entry.where}`).sort()).toEqual([
      'donnée cherchée event.request.cf.postalCode',
      'e-mail event.request.headers.cf-access-authenticated-user-email',
      'jeton signé event.request.headers.cf-access-jwt-assertion',
    ]);
  });

  it('says when wrangler sampled the capture', () => {
    expect(scanCapture([fetchEvent(), { event: { type: 'overload', message: 'Tail is currently in sampling mode' } }]).sampled).toBe(true);
    expect(scanCapture([fetchEvent()]).sampled).toBe(false);
  });
});

describe('the command', () => {
  const run = (text, env = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'minshop-logs-'));
    try {
      const file = join(dir, 'tail.json');
      if (text !== null) writeFileSync(file, text);
      return spawnSync('node', [SCRIPT, file, '--json'], { encoding: 'utf8', env: { ...process.env, PII_NEEDLES: '', ...env } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits 0 on a clean capture, 1 on a finding, 2 on nothing to read', () => {
    const clean = run(capture([fetchEvent({ logs: ['order paid'] })]));
    expect(clean.status, clean.stderr).toBe(0);
    // The file's name only: a path would put the operator's home in the proof.
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, file: 'tail.json', events: 1, application: [] });

    const dirty = run(capture([fetchEvent({ logs: ['Jeanne Testeuse paid'] })]), { PII_NEEDLES: 'Jeanne Testeuse' });
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).not.toContain('Jeanne Testeuse');

    expect(run('Connected to minshop, waiting for logs...\n').status).toBe(2);
    expect(run(null).status).toBe(2);
  });
});
