/**
 * What a deployed shop's logs hold, read back (plan §8.4, certification étape 5).
 *
 * The local security gate asserts on what the built Worker prints, on the paths
 * the suite thought to take. It cannot see what the PLATFORM records around a
 * real purchase: the URL of every request, the exceptions, the cron's runs, and
 * a log line written on a path no test walks. `wrangler tail --format json`
 * captures all of it while someone buys, refunds and ships on the real shop;
 * this reads that capture and reports what it finds — without ever printing it,
 * because the report is a proof that goes into a repository:
 *
 *   - an e-mail address;
 *   - a guest access token in clear (`otk_…`): the platform redacts the ones in
 *     a URL by their shape (features/ids/token.ts), the application the ones it
 *     logs (logSafe);
 *   - a credential by its shape — the manifest's patterns, plus a signed token;
 *   - each value of PII_NEEDLES: what the tester typed at the checkout, because
 *     a street address has no shape to be found by.
 *
 * Where a finding sits decides what it is. In what the application wrote — its
 * log lines and its exceptions — or in a URL it built, it fails the run. In a
 * request's headers or its `cf` metadata it is reported and not judged: those
 * are written by the visitor's browser and by Cloudflare's edge — behind a
 * private preview, Access puts the operator's own identity on every request —
 * and the security report decides what each one is.
 *
 * Run: npx wrangler tail <worker> --format json > tail.json   (while testing)
 *      PII_NEEDLES='Jeanne Testeuse;12 rue des Lilas' npm run test:logs:remote -- tail.json [--json]
 * PII_NEEDLES comes from the environment, never from an argument: it is somebody's
 * address, and an argument stays in the shell history.
 *
 * Exit: 0 nothing in the application's part, 1 something, 2 nothing to read.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { CREDENTIAL_PATTERNS } from '../../scripts/manifest-schema.mjs';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ACCESS_TOKEN = /otk_[A-Za-z0-9_-]{21}[AQgw]/g;
const SIGNED_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;

/** What a capture holds: one JSON document per event, as wrangler prints them. */
export function parseCapture(text) {
  const events = [];
  let ignored = 0;
  let buffer = null;
  for (const line of text.split(/\r?\n/)) {
    if (buffer === null && line.startsWith('{') && line.trimEnd().endsWith('}')) {
      try {
        events.push(JSON.parse(line));
        continue;
      } catch {
        // Not one line after all: the start of a pretty-printed document.
      }
    }
    if (buffer === null && line === '{') buffer = [line];
    else if (buffer !== null) {
      buffer.push(line);
      if (line === '}') {
        try {
          events.push(JSON.parse(buffer.join('\n')));
        } catch {
          ignored += buffer.length;
        }
        buffer = null;
      }
    } else if (line.trim()) ignored++;
  }
  return { events, ignored: ignored + (buffer?.length ?? 0) };
}

/** Every string an event carries, with where it sits. */
function* leaves(value, path) {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [index, item] of value.entries()) yield* leaves(item, `${path}[${index}]`);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) yield* leaves(item, path ? `${path}.${key}` : key);
  else if (value !== null && value !== undefined) yield [path, String(value)];
}

/** The application's part, the URLs it built, or the platform's. */
function partOf(path) {
  if (/^(logs|exceptions)\b/.test(path)) return 'application';
  if (path === 'event.request.url') return 'url';
  return 'platform';
}

/** Enough to tell two findings apart, never enough to read one. */
function maskEmail(address) {
  const [local, domain] = address.split('@');
  const tld = domain.slice(domain.lastIndexOf('.'));
  return `${local[0]}…@${domain[0]}…${tld}`;
}

/** Collapse an index, a header or a log line's position into one place name. */
const place = (path) => path.replace(/\[\d+\]/g, '[]');

export function scanCapture(events, needles = []) {
  const findings = new Map();
  const counts = { application: 0, url: 0, platform: 0 };
  const outcomes = {};
  let sampled = false;
  const note = (part, kind, label, path, index) => {
    const key = `${part}\0${kind}\0${label}\0${place(path)}`;
    const entry = findings.get(key) ?? { part, kind, label, where: place(path), count: 0, events: [] };
    entry.count++;
    if (entry.events.length < 5 && !entry.events.includes(index)) entry.events.push(index);
    findings.set(key, entry);
  };

  events.forEach((event, index) => {
    if (event?.event?.type === 'overload') sampled = true;
    if (event?.outcome) outcomes[event.outcome] = (outcomes[event.outcome] ?? 0) + 1;
    counts.application += (event?.logs?.length ?? 0) + (event?.exceptions?.length ?? 0);
    if (event?.event?.request?.url) counts.url++;
    for (const [path, text] of leaves(event, '')) {
      const part = partOf(path);
      for (const address of text.match(EMAIL) ?? []) note(part, 'e-mail', maskEmail(address), path, index);
      if (ACCESS_TOKEN.test(text)) note(part, 'jeton invité', 'otk_…', path, index);
      ACCESS_TOKEN.lastIndex = 0;
      if (SIGNED_TOKEN.test(text)) note(part, 'jeton signé', 'eyJ….eyJ…', path, index);
      SIGNED_TOKEN.lastIndex = 0;
      for (const { pattern, what } of CREDENTIAL_PATTERNS) if (pattern.test(text)) note(part, 'secret', what, path, index);
      const lower = text.toLowerCase();
      needles.forEach((needle, n) => {
        if (lower.includes(needle.toLowerCase())) note(part, 'donnée cherchée', `n° ${n + 1}`, path, index);
      });
    }
  });

  const all = [...findings.values()];
  return {
    events: events.length,
    sampled,
    outcomes,
    counts,
    needles: needles.length,
    application: all.filter((entry) => entry.part === 'application'),
    url: all.filter((entry) => entry.part === 'url'),
    platform: all.filter((entry) => entry.part === 'platform'),
  };
}

/** PII_NEEDLES: separated by `;` or new lines; three characters at least. */
export function readNeedles(raw = '') {
  return raw.split(/[;\n]/).map((value) => value.trim()).filter((value) => value.length >= 3);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
  const file = positionals[0];
  if (!file) {
    console.error('logs : nommez la capture — npx wrangler tail <worker> --format json > tail.json, puis npm run test:logs:remote -- tail.json');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`logs : ${file} illisible (${error.code ?? error.message}).`);
    process.exit(2);
  }
  const { events, ignored } = parseCapture(text);
  if (events.length === 0) {
    console.error(`logs : aucun événement dans ${file}. La capture est vide, ou n'a pas été prise avec --format json.`);
    process.exit(2);
  }
  // The name, not the path: the report is committed, and a path names the operator's home.
  const report = { file: basename(file), ignoredLines: ignored, ...scanCapture(events, readNeedles(process.env.PII_NEEDLES)) };
  const failed = report.application.length + report.url.length > 0;

  if (options.json) {
    console.log(JSON.stringify({ ok: !failed, ...report }, null, 2));
  } else {
    const line = (entry) => `${entry.kind} (${entry.label}) dans ${entry.where} — ${entry.count} fois, événement(s) ${entry.events.join(', ')}`;
    console.log(`Relevé des journaux — ${file} : ${report.events} événement(s), ${ignored} ligne(s) hors événement`);
    console.log(`  issues : ${Object.entries(report.outcomes).map(([outcome, n]) => `${outcome} ${n}`).join(', ') || 'aucune'}`);
    if (report.sampled) console.log('  ⚠ wrangler a échantillonné la capture (overload) : des événements manquent.');
    if (report.needles === 0) console.log('  ⚠ PII_NEEDLES vide : seules les formes sont cherchées, et une adresse postale n\'en a pas.');
    console.log(`\n▸ Ce que la boutique a écrit — ${report.counts.application} ligne(s) de journal ou exception(s)`);
    for (const entry of report.application) console.log(`  ✗ ${line(entry)}`);
    if (report.application.length === 0) console.log(`  ✓ ni adresse, ni jeton, ni secret, ni aucune des ${report.needles} donnée(s) cherchée(s)`);
    console.log(`\n▸ Les URL — ${report.counts.url} requête(s)`);
    for (const entry of report.url) console.log(`  ✗ ${line(entry)}`);
    if (report.url.some((entry) => entry.kind === 'jeton invité')) {
      console.log('    la plateforme devait masquer ces jetons par leur forme (features/ids/token.ts) : elle ne l\'a pas fait.');
    }
    if (report.url.length === 0) console.log('  ✓ rien');
    console.log('\n▸ En-têtes et métadonnées de la plateforme — rapportés, non jugés');
    for (const entry of report.platform) console.log(`  · ${line(entry)}`);
    if (report.platform.length === 0) console.log('  rien');
    console.log(failed ? '\n✗ la boutique a écrit ce qu\'elle ne devait pas.' : '\n✓ rien dans ce que la boutique a écrit.');
  }
  process.exit(failed ? 1 : 0);
}
