#!/usr/bin/env node
/**
 * A wrangler that answers like the real one, against a Cloudflare account kept
 * in a JSON file.
 *
 * Why a double and not a mock: the properties jalon 6 has to prove are about
 * the CONVERSATION with the account — that a second run creates nothing, that
 * an interrupted run resumes, that a bucket ends up in the `eu` jurisdiction
 * and in no other, that a secret never appears in an argument vector. A mock of
 * `capture()` would assert that shopctl calls the functions shopctl calls. This
 * runs the real `npx --no-install wrangler …` path, the real argument
 * construction, and the real output parsers, and only the account is imaginary.
 *
 * It is deliberately literal about wrangler's SHAPES — `name:  <bucket>` lines
 * with no --json for `r2 bucket list`, a JSON array for `d1 list`, a non-zero
 * exit for `secret list` on a Worker that does not exist. Those shapes are what
 * shopctl parses, so a double that answered in a tidier format would let a
 * parser bug through.
 *
 * State lives at $WRANGLER_DOUBLE_STATE, a JSON document:
 *
 *   accounts        [{ id, name }]           what `whoami` reports
 *   authenticated   boolean                  false makes `whoami --json` exit 1
 *                                            (plain `whoami` still exits 0)
 *   d1              [{ name, uuid, jurisdiction }]
 *   r2              [{ name, jurisdiction, devUrl, domains }]
 *   workers         [{ name, secrets: [] }]
 *   reportsD1Jurisdiction  boolean           `d1 info` publishes the field or not
 *   failAt          "d1 create" | …          one command that dies, for the
 *                                            interrupted-run test
 *   calls           [{ argv, stdin }]        appended to on every invocation
 *
 * D1 IS REAL. `d1 migrations apply` and `d1 execute` run against a `node:sqlite`
 * database kept beside the state file, one per D1 name, and the migrations come
 * from the tree the command was run in. That is what makes the backup and
 * restore suites worth anything: the statements shopctl generates are applied to
 * the repository's own schema, with its own triggers and its own foreign keys,
 * and a dump that forgot a column fails here rather than in production. R2 is
 * real in the same sense — an object put is a file, and a get reads it back.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// node:sqlite is experimental on the certified Node line and says so on stderr.
// A parser reading wrangler's output has no business seeing that, and neither
// does an assertion about a failure's first line.
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

const STATE = process.env.WRANGLER_DOUBLE_STATE;
if (!STATE) {
  process.stderr.write('wrangler-double: WRANGLER_DOUBLE_STATE is not set\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(STATE, 'utf8'));

/** Read stdin fully, or '' when nothing is piped. `secret put` is the only
 *  command that needs it, and it is the reason the double records stdin at all:
 *  a test has to be able to prove the value arrived HERE and not in argv. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const flag = (...names) => {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('-')) return argv[index + 1];
    const inline = argv.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
  }
  return null;
};
const positionals = argv.filter((argument, index) => {
  if (argument.startsWith('-')) return false;
  const previous = argv[index - 1];
  return !(previous && previous.startsWith('-') && !previous.includes('='));
});

const command = positionals.slice(0, 3).join(' ');
const stdin = command.startsWith('secret put') ? readStdin() : '';

state.calls = state.calls ?? [];
state.calls.push({ argv, stdin });
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

function done(text = '', code = 0) {
  save();
  if (text) process.stdout.write(`${text}\n`);
  process.exit(code);
}
function fail(text, code = 1) {
  save();
  process.stderr.write(`${text}\n`);
  process.exit(code);
}

// One command can be made to die, so a test can kill a run halfway and re-run
// it. That is the only way to exercise resumption honestly: the second run has
// to find whatever the first one managed to create.
if (state.failAt && command.startsWith(state.failAt)) {
  fail(`wrangler-double: injected failure at "${state.failAt}"`);
}

const uuid = (name) => {
  // Deterministic and shaped like a real one, so a test can assert the id that
  // reaches wrangler.jsonc without the double inventing a new one per run.
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${hex}${hex.slice(0, 4)}`;
};

const jurisdictionOf = () => flag('-J', '--jurisdiction');

if (positionals[0] === 'whoami') {
  // Wrangler 4.149, verbatim: without --json, a missing session is a message
  // on stdout and exit 0; only --json turns it into a failure. Anything that
  // reads the exit status of the plain form believes nobody is logged out.
  if (state.authenticated === false && argv.includes('--json')) done(JSON.stringify({ loggedIn: false }), 1);
  if (state.authenticated === false) done('You are not authenticated. Please run `wrangler login`.');
  done(JSON.stringify({
    loggedIn: true,
    authType: 'OAuth Token',
    email: state.email ?? 'ops@example.com',
    accounts: state.accounts ?? [],
    tokenPermissions: null,
  }));
}

// Which account a command reaches, decided the way wrangler decides it:
// CLOUDFLARE_ACCOUNT_ID, else the session's only account, else the one cached
// the last time somebody picked one interactively in this tree. With none of
// those wrangler would ask — and a child whose stdin is not a terminal cannot
// be asked, so it refuses. That refusal is what a session invited onto a
// client's account (ADR 0015) meets on every call shopctl does not pin, and
// `account` on each recorded call is how the suite proves where a write went.
const reachesAccount =
  !argv.includes('--local') && !argv.includes('--version') && !(positionals[0] === 'deploy' && argv.includes('--dry-run'));
if (reachesAccount) {
  const accounts = state.accounts ?? [];
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || (accounts.length === 1 ? accounts[0].id : (state.cachedAccount ?? null));
  if (!account && accounts.length > 1) {
    fail(
      [
        'More than one account available but unable to select one in non-interactive mode.',
        'Please set the appropriate `account_id` in your Wrangler configuration file or assign it to the `CLOUDFLARE_ACCOUNT_ID` environment variable.',
        'Available accounts are (`<name>`: `<account_id>`):',
        ...accounts.map(({ id, name }) => `  \`${name}\`: \`${id}\``),
      ].join('\n'),
    );
  }
  state.calls[state.calls.length - 1].account = account;
}

if (command === 'd1 list') {
  done(JSON.stringify((state.d1 ?? []).map(({ name, uuid: id }) => ({ name, uuid: id }))));
}

if (command.startsWith('d1 create')) {
  const name = positionals[2];
  if ((state.d1 ?? []).some((entry) => entry.name === name)) fail('A database with that name already exists');
  const id = uuid(name);
  state.d1 = [...(state.d1 ?? []), { name, uuid: id, jurisdiction: jurisdictionOf() }];
  done(`✅ Successfully created DB '${name}'\n\ndatabase_id = "${id}"`);
}

if (command.startsWith('d1 info')) {
  const name = positionals[2];
  const entry = (state.d1 ?? []).find((candidate) => candidate.name === name);
  if (!entry) fail(`Couldn't find DB with name '${name}'`);
  const payload = { uuid: entry.uuid, name: entry.name, num_tables: 0, database_size: 0 };
  // Older D1 APIs do not publish the jurisdiction back. shopctl has to report
  // that as "unverified" rather than as a pass, and this switch is how the
  // suite proves it does.
  if (state.reportsD1Jurisdiction !== false) payload.jurisdiction = entry.jurisdiction;
  done(JSON.stringify(payload));
}

/** The tree's wrangler.jsonc, comments stripped exactly as a JSONC reader would. */
function configuration() {
  if (!existsSync('wrangler.jsonc')) fail('No wrangler configuration file found.');
  return readFileSync('wrangler.jsonc', 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Which database a binding names, the way the real wrangler resolves it. */
function databaseNameFor(binding) {
  const config = configuration();
  const entry = config.match(new RegExp(`\\{[^{}]*"binding"\\s*:\\s*"${binding}"[^{}]*\\}`, 's'));
  const name = entry?.[0].match(/"database_name"\s*:\s*"([^"]+)"/)?.[1];
  if (!name) fail(`Couldn't find a D1 binding named "${binding}" in wrangler.jsonc.`);
  return name;
}

/**
 * `--local` is the tree's own `.wrangler/state`, the way the real wrangler
 * keeps it: nothing to provision, nothing on the account, and nothing shared
 * with the remote database of the same name — which is the property a local
 * restore relies on and the suite checks.
 */
const LOCAL = argv.includes('--local');
const localState = (...parts) => join(process.cwd(), '.wrangler', 'state', ...parts);

/** Where one database's bytes live: beside the state, one file per D1 name. */
function databaseFile(name) {
  const file = `d1-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.sqlite`;
  if (LOCAL) {
    mkdirSync(localState(), { recursive: true });
    return localState(file);
  }
  return join(dirname(resolve(STATE)), file);
}

function openDatabase(binding) {
  // Like wrangler, a database's own name is accepted beside a binding, and on
  // the account it is looked up there when the configuration does not carry it.
  const onAccount = !LOCAL && (state.d1 ?? []).some((entry) => entry.name === binding);
  const name = onAccount ? binding : databaseNameFor(binding);
  if (!LOCAL && !(state.d1 ?? []).some((entry) => entry.name === name)) fail(`Couldn't find DB with name '${name}'`);
  return { name, db: new DatabaseSync(databaseFile(name)) };
}

/**
 * Split a script into statements.
 *
 * Quote-aware, because it has to be: the restore inlines every value, and a
 * product description with a semicolon in it is an ordinary Tuesday. A naive
 * splitter here would make the double STRICTER than the platform — the
 * catalogue import has been sending `wrangler d1 execute --file` inlined text
 * since jalon 4 — and the suite would fail on data that works in production.
 *
 * The one place it is deliberately as blunt as the platform is a trigger body,
 * which closes on `END;` and nothing else. That is wrangler's own remote rule,
 * and `migrations-remote-safe.test.mjs` holds the repository to it.
 */
function splitStatements(sql) {
  const statements = [];
  let buffer = '';
  // The statement's opening CODE, comments and blank lines removed. A migration
  // explains itself before it declares anything, and `CREATE TRIGGER` sits
  // under a paragraph of prose in this repository — matching the raw buffer
  // would miss every one of them and cut the trigger at its first inner `;`.
  let head = '';
  let index = 0;
  let inTrigger = false;

  const push = () => {
    if (buffer.trim()) statements.push(buffer.trim());
    buffer = '';
    head = '';
  };

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'") {
      buffer += character;
      index += 1;
      while (index < sql.length) {
        buffer += sql[index];
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            buffer += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        buffer += sql[index];
        index += 1;
      }
      continue;
    }

    if (character === ';') {
      buffer += character;
      index += 1;
      if (inTrigger) {
        if (/\bEND\s*;\s*$/i.test(buffer)) {
          push();
          inTrigger = false;
        }
        continue;
      }
      push();
      continue;
    }

    buffer += character;
    index += 1;
    // Tested only over the head of a statement, so this stays linear over a
    // restore file that can be megabytes of INSERTs.
    if (!inTrigger && head.length < 80) {
      head += character;
      if (/^\s*CREATE\s+(OR\s+REPLACE\s+)?(TEMP\w*\s+)?TRIGGER\b/i.test(head)) inTrigger = true;
    }
  }
  push();
  // The tail of a file is usually a comment with no statement under it. Tested
  // line by line rather than with a repeated group over the whole chunk: a
  // `(--[^\n]*\n?)+$` that fails backtracks through every way of splitting the
  // block, which is exponential in the number of lines and hangs on the first
  // migration that explains itself at length.
  return statements.filter((statement) => !statement.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('--')));
}

function runScript(db, sql) {
  for (const statement of splitStatements(sql)) db.exec(statement);
}

if (command === 'd1 migrations apply' || command.startsWith('d1 migrations')) {
  state.migrationsApplied = (state.migrationsApplied ?? 0) + 1;
  const { db } = openDatabase(positionals[3] ?? 'DB');
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))');
  const applied = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name));
  const files = existsSync('migrations')
    ? readdirSync('migrations').filter((name) => name.endsWith('.sql')).sort()
    : [];
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    runScript(db, readFileSync(join('migrations', file), 'utf8'));
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
    count += 1;
  }
  db.close();
  done(`🌀 Executing on ${LOCAL ? 'local' : 'remote'} database: ${count} migrations to apply.`);
}

if (command.startsWith('d1 execute')) {
  const { db } = openDatabase(positionals[2] ?? 'DB');
  const sql = flag('--file') ? readFileSync(flag('--file'), 'utf8') : flag('--command');
  if (!sql) fail('Provide --command or --file.');
  const documents = [];
  try {
    for (const statement of splitStatements(sql)) {
      const prepared = db.prepare(statement);
      // node:sqlite refuses .all() on a statement that returns nothing, which is
      // exactly the split D1 reports as `results: []`.
      const results = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(statement) ? prepared.all() : (prepared.run(), []);
      documents.push({ results, success: true, meta: { changes: 0, duration: 0 } });
    }
  } catch (error) {
    db.close();
    fail(`✘ [ERROR] ${error.message}`);
  }
  db.close();
  if (argv.includes('--json')) done(JSON.stringify(documents));
  done('🌀 Executed successfully.');
}

/** Where one bucket's objects live. Keyed by the hex of the object key, so a
 *  key with slashes in it is still one file. */
function objectPath(bucket, key) {
  const file = `${Buffer.from(key, 'utf8').toString('hex')}.bin`;
  return LOCAL ? localState('r2', bucket, file) : join(dirname(resolve(STATE)), 'r2', bucket, file);
}

function bucketEntry(name) {
  const wanted = jurisdictionOf();
  return (state.r2 ?? []).find((candidate) => candidate.name === name && (candidate.jurisdiction ?? null) === (wanted ?? null));
}

if (command.startsWith('r2 object ') && ['get', 'put', 'delete'].includes(positionals[2])) {
  const [bucketName, ...rest] = String(positionals[3] ?? '').split('/');
  const key = rest.join('/');
  // A local bucket exists by being written to; its count is nobody's business.
  const bucket = LOCAL ? {} : bucketEntry(bucketName);
  if (!bucket) fail('The specified bucket does not exist.');
  const path = objectPath(bucketName, key);

  if (positionals[2] === 'put') {
    mkdirSync(dirname(path), { recursive: true });
    const existed = existsSync(path);
    writeFileSync(path, readFileSync(flag('--file')));
    if (!existed) bucket.objects = (bucket.objects ?? 0) + 1;
    done(`Creating object "${key}" in bucket "${bucketName}".\nUpload complete.`);
  }
  if (positionals[2] === 'delete') {
    if (existsSync(path)) {
      rmSync(path);
      bucket.objects = Math.max(0, (bucket.objects ?? 0) - 1);
    }
    done(`Deleting object "${key}" from bucket "${bucketName}".\nDelete complete.`);
  }
  if (!existsSync(path)) fail(`The specified key does not exist.`);
  writeFileSync(flag('--file'), readFileSync(path));
  done(`Downloading "${key}" from "${bucketName}".\nDownload complete.`);
}

if (command === 'r2 bucket list') {
  if (state.r2Enabled === false) fail('The R2 service is not enabled for this account. [code: 10042]');
  const wanted = jurisdictionOf();
  const buckets = (state.r2 ?? []).filter((bucket) => (bucket.jurisdiction ?? null) === (wanted ?? null));
  const body = buckets.map((bucket) => `name:           ${bucket.name}\ncreation_date:  2026-08-31`).join('\n\n');
  done(`Listing buckets...\n${body}`);
}

if (command.startsWith('r2 bucket create')) {
  const name = positionals[3];
  const wanted = jurisdictionOf();
  if ((state.r2 ?? []).some((bucket) => bucket.name === name && (bucket.jurisdiction ?? null) === (wanted ?? null))) {
    fail('A bucket with that name already exists');
  }
  state.r2 = [...(state.r2 ?? []), { name, jurisdiction: wanted, devUrl: null, domains: [] }];
  done(`Creating bucket '${name}'...\n✅ Created bucket '${name}' with default storage class of Standard.`);
}

if (command === 'r2 bucket dev-url' && positionals[3] === 'get') {
  const name = positionals[4];
  const wanted = jurisdictionOf();
  const bucket = (state.r2 ?? []).find((candidate) => candidate.name === name && (candidate.jurisdiction ?? null) === (wanted ?? null));
  if (!bucket) fail(`The specified bucket does not exist.`);
  done(bucket.devUrl ? `Public access is enabled at '${bucket.devUrl}'.` : 'Public access via the r2.dev URL is disabled.');
}

// Lifecycle rules: the real listing prints one `name:` line per rule, then
// its fields. The double keeps the rules on the bucket record so a second
// provisioning can find the one the first added.
if (command === 'r2 bucket lifecycle' && positionals[3] === 'list') {
  const bucket = bucketEntry(positionals[4]);
  if (!bucket) fail('The specified bucket does not exist.');
  const rules = bucket.lifecycle ?? [];
  if (rules.length === 0) done(`Listing lifecycle rules for bucket '${bucket.name}'...\nThere are no lifecycle rules for bucket '${bucket.name}'.`);
  done(
    `Listing lifecycle rules for bucket '${bucket.name}'...\n` +
      rules.map((rule) => `name:      ${rule.name}\nenabled:   Yes\nprefix:    (all prefixes)\naction:    Expire objects after ${rule.days} days`).join('\n\n'),
  );
}

if (command === 'r2 bucket lifecycle' && positionals[3] === 'add') {
  const bucket = bucketEntry(positionals[4]);
  if (!bucket) fail('The specified bucket does not exist.');
  const name = positionals[5];
  if ((bucket.lifecycle ?? []).some((rule) => rule.name === name)) fail(`A lifecycle rule named '${name}' already exists.`);
  bucket.lifecycle = [...(bucket.lifecycle ?? []), { name, days: Number(flag('--expire-days')) }];
  done(`✨ Added lifecycle rule '${name}' to bucket '${bucket.name}'.`);
}

if (command === 'r2 bucket domain' && positionals[3] === 'list') {
  const name = positionals[4];
  const wanted = jurisdictionOf();
  const bucket = (state.r2 ?? []).find((candidate) => candidate.name === name && (candidate.jurisdiction ?? null) === (wanted ?? null));
  if (!bucket) fail(`The specified bucket does not exist.`);
  const domains = bucket.domains ?? [];
  if (domains.length === 0) done(`Listing custom domains connected to bucket '${name}'...\nThere are no custom domains connected to this bucket.`);
  done(
    `Listing custom domains connected to bucket '${name}'...\n` +
      domains.map((domain) => `domain:          ${domain}\nenabled:         Yes`).join('\n\n'),
  );
}

if (command.startsWith('secret list')) {
  const name = flag('--name');
  const worker = (state.workers ?? []).find((candidate) => candidate.name === name);
  if (!worker) fail(`Could not find Worker "${name}".`);
  done(JSON.stringify((worker.secrets ?? []).map((secret) => ({ name: secret, type: 'secret_text' }))));
}

if (command.startsWith('secret put')) {
  const name = flag('--name');
  const secret = positionals[2];
  const worker = (state.workers ?? []).find((candidate) => candidate.name === name);
  if (!worker) fail(`Could not find Worker "${name}".`);
  if (!stdin.trim()) fail('No value was piped in for the secret.');
  worker.secrets = [...new Set([...(worker.secrets ?? []), secret])];
  done(`✨ Success! Uploaded secret ${secret}`);
}

if (positionals[0] === 'delete' && flag('--name')) {
  const name = flag('--name');
  const index = (state.workers ?? []).findIndex((candidate) => candidate.name === name);
  if (index === -1) fail(`Could not find Worker "${name}".`);
  state.workers.splice(index, 1);
  done(`? Are you sure you want to delete ${name}?\n🤖 Using fallback value in non-interactive context: yes\n✨ Successfully deleted ${name}`);
}

if (command.startsWith('d1 delete')) {
  const name = positionals[2];
  const index = (state.d1 ?? []).findIndex((entry) => entry.name === name);
  if (index === -1) fail(`Couldn't find DB with name '${name}'`);
  state.d1.splice(index, 1);
  // The bytes go with the record. Leaving the file would make a database
  // deleted and re-created under the same name come back with its old rows —
  // which is exactly the thing a teardown is meant to make impossible.
  rmSync(databaseFile(name), { force: true });
  done(`✅ Deleted '${name}' successfully.`);
}

if (command.startsWith('r2 bucket delete')) {
  const name = positionals[3];
  const wanted = jurisdictionOf();
  const index = (state.r2 ?? []).findIndex((bucket) => bucket.name === name && (bucket.jurisdiction ?? null) === (wanted ?? null));
  if (index === -1) fail('The specified bucket does not exist.');
  // R2 refuses a bucket that still holds objects. The double refuses it too,
  // because that refusal is the one branch of the teardown that has a remedy
  // the operator has to be told about.
  if ((state.r2[index].objects ?? 0) > 0) fail('The bucket you tried to delete is not empty. [code: 10014]');
  state.r2.splice(index, 1);
  done(`Deleted bucket '${name}'.`);
}

if (command.startsWith('versions list')) {
  const name = flag('--name');
  const worker = (state.workers ?? []).find((candidate) => candidate.name === name);
  if (!worker) fail(`Could not find Worker "${name}".`);
  // Newest first, like the real one. `shopctl deploy` names the SECOND entry as
  // the rollback target, so a Worker with a single version must report exactly
  // one — that is the "nothing to roll back to" case of a first deployment.
  done(JSON.stringify(worker.versions ?? [{ id: 'v1', number: 1 }]));
}

if (positionals[0] === 'deploy') {
  // The name comes from the rendered configuration, exactly as the real
  // wrangler reads it: that is what makes "deploy uploaded the environment the
  // command was asked for" a property the suite can assert.
  // Comments stripped first, exactly as a JSONC reader would: the template's
  // header explains the optional `send_email` binding with a `"name": "EMAIL"`
  // example, and a naive match reads THAT as the Worker's name.
  const config = readFileSync('wrangler.jsonc', 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const name = config.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? 'worker';
  let worker = (state.workers ?? []).find((candidate) => candidate.name === name);
  if (!worker) {
    worker = { name, secrets: [], versions: [] };
    state.workers = [...(state.workers ?? []), worker];
  }
  worker.versions = [{ id: `v${(worker.versions?.length ?? 0) + 1}`, number: (worker.versions?.length ?? 0) + 1 }, ...(worker.versions ?? [])];
  state.deploys = [...(state.deploys ?? []), name];
  // The targets, listed as wrangler lists them: the workers.dev URL only while
  // that door is open, and a custom domain BARE, with no scheme. A double that
  // printed a workers.dev URL with that door shut is how `deploy` came to read
  // its origin from a line the real output never carries.
  const domains = [...config.matchAll(/\{"pattern":"([^"]+)","custom_domain":true\}/g)].map((match) => match[1]);
  const targets = [
    ...(/"workers_dev"\s*:\s*false/.test(config) ? [] : [state.deployUrl ?? `https://${name}.example.workers.dev`]),
    ...domains.map((domain) => `${domain} (custom domain)`),
    'schedule: */5 * * * *',
  ];
  // A documentation link first, the way wrangler's warnings carry them: an
  // https URL in the output that is not where the shop is.
  done(
    `▲ [WARNING] See https://developers.cloudflare.com/workers/configuration/routing/\n` +
      `Total Upload: 512.00 KiB / gzip: 128.00 KiB\nUploaded ${name} (2.11 sec)\nDeployed ${name} triggers (0.42 sec)\n` +
      targets.map((target) => `  ${target}`).join('\n') +
      `\nCurrent Version ID: 00000000-0000-0000-0000-000000000002`,
  );
}

if (command.startsWith('d1 time-travel')) {
  done(JSON.stringify({ bookmark: state.bookmark ?? '00000098-0000000d-00004f8d-example' }));
}

if (argv.includes('--version')) done('⛅️ wrangler 4.127.1 (double)');

fail(`wrangler-double: unhandled command "${argv.join(' ')}"`, 2);
