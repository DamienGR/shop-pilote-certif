#!/usr/bin/env node
/**
 * Cloudflare's GraphQL Analytics endpoint, answering from a JSON file.
 *
 * A separate process on purpose: the suites run shopctl with `spawnSync`, which
 * blocks the test's own event loop, so a server living in the test process
 * could never answer. This one prints its origin on the first line of stdout
 * and serves until it is killed.
 *
 * State lives at the path given as the only argument:
 *
 *   status     number                 HTTP status to answer with (default 200)
 *   worker     [group]                workersInvocationsAdaptive groups
 *   d1         [group]                d1AnalyticsAdaptiveGroups groups
 *   usage      { <dataset>: [group] } the account, as `fleet usage` asks for it
 *   errors     [{ message }]          a GraphQL-level refusal, sent with null data
 *   requests   [{ authorization, query, variables }]   appended on every call
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const STATE = process.argv[2];
if (!STATE) {
  process.stderr.write('graphql-double: state file argument is missing\n');
  process.exit(1);
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const state = JSON.parse(readFileSync(STATE, 'utf8'));
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // Recorded as received; the answer below is what the real API gives a
      // malformed body anyway.
    }
    state.requests = [...(state.requests ?? []), { path: request.url, authorization: request.headers.authorization ?? null, query: parsed.query ?? null, variables: parsed.variables ?? null }];
    writeFileSync(STATE, JSON.stringify(state, null, 2));

    // `fleet usage` asks for several datasets at once, D1 storage among them;
    // `monitor` for one each time.
    const account = parsed.query?.includes('d1StorageAdaptiveGroups')
      ? (state.usage ?? {})
      : parsed.query?.includes('workersInvocationsAdaptive')
        ? { workersInvocationsAdaptive: state.worker ?? [] }
        : { d1AnalyticsAdaptiveGroups: state.d1 ?? [] };
    const document = state.errors
      ? { data: null, errors: state.errors }
      : { data: { viewer: { accounts: [account] } }, errors: null };
    response.writeHead(state.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(document));
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
