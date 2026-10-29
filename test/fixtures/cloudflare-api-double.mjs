#!/usr/bin/env node
/**
 * The part of Cloudflare's REST API that wrangler does not cover and shopctl
 * calls itself: zones, and Cloudflare for SaaS custom hostnames (ADR 0019) —
 * plus the account's workers.dev subdomain, which `scripts/saas-trial.mjs`
 * reads to prove workers.dev closed.
 *
 * A separate process for the reason `graphql-double.mjs` gives: the suites run
 * shopctl with `spawnSync`, which blocks the test's own event loop. It prints
 * its origin on the first line of stdout and serves until it is killed.
 *
 * State lives at the path given as the only argument:
 *
 *   zones      [{ id, name, account }]                         zones by account
 *   fallback   { <zoneId>: { origin, status } }               fallback origins
 *   hostnames  [{ id, zone, hostname, status, ssl: { status } }]
 *   subdomain  string    the account's workers.dev subdomain; absent, it is
 *                        refused as an account that never opened Workers is
 *   activate   boolean   a created hostname is active at once (the merchant's
 *                        CNAME already in place), rather than pending
 *   refuse     number    answer every call with this HTTP status and an error
 *   requests   [{ method, path, authorization, body }]   appended on every call
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const STATE = process.argv[2];
if (!STATE) {
  process.stderr.write('cloudflare-api-double: state file argument is missing\n');
  process.exit(1);
}

const ok = (result) => [200, { success: true, errors: [], messages: [], result }];
const error = (status, code, message) => [status, { success: false, errors: [{ code, message }], messages: [], result: null }];

function answer(state, method, url, body) {
  if (state.refuse) return error(state.refuse, 10000, 'Authentication error');
  const path = url.pathname;

  if (method === 'GET' && path === '/zones') {
    const name = url.searchParams.get('name');
    const account = url.searchParams.get('account.id');
    return ok((state.zones ?? []).filter((zone) => zone.name === name && (!account || zone.account === account)));
  }

  if (method === 'GET' && /^\/accounts\/[^/]+\/workers\/subdomain$/.test(path)) {
    return state.subdomain ? ok({ subdomain: state.subdomain }) : error(404, 10007, 'This account does not have a workers.dev subdomain');
  }

  const zoneMatch = path.match(/^\/zones\/([^/]+)\/custom_hostnames(?:\/(.+))?$/);
  if (!zoneMatch) return error(404, 7003, 'Could not route to the requested URL');
  const [, zoneId, rest] = zoneMatch;
  if (!(state.zones ?? []).some((zone) => zone.id === zoneId)) return error(404, 1001, 'Invalid zone identifier');

  if (rest === 'fallback_origin') {
    const fallback = state.fallback?.[zoneId];
    return fallback ? ok(fallback) : error(404, 1551, 'No fallback origin is set');
  }

  state.hostnames ??= [];
  if (method === 'GET' && !rest) {
    const name = url.searchParams.get('hostname');
    return ok(state.hostnames.filter((record) => record.zone === zoneId && (!name || record.hostname === name)));
  }
  if (method === 'POST' && !rest) {
    if (state.hostnames.some((record) => record.zone === zoneId && record.hostname === body?.hostname)) {
      return error(409, 1406, 'Duplicate custom hostname found.');
    }
    const active = state.activate === true;
    const record = {
      id: `ch-${state.hostnames.length + 1}`,
      zone: zoneId,
      hostname: body?.hostname,
      status: active ? 'active' : 'pending',
      ssl: { status: active ? 'active' : 'pending_validation', method: body?.ssl?.method, type: body?.ssl?.type, settings: body?.ssl?.settings },
      ownership_verification: { type: 'txt', name: `_cf-custom-hostname.${body?.hostname}`, value: 'double-0000' },
    };
    state.hostnames.push(record);
    return ok(record);
  }
  if (method === 'DELETE' && rest) {
    const index = state.hostnames.findIndex((record) => record.zone === zoneId && record.id === rest);
    if (index === -1) return error(404, 1436, 'The custom hostname was not found.');
    state.hostnames.splice(index, 1);
    return ok({ id: rest });
  }
  return error(405, 10405, 'Method not allowed');
}

const server = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    const state = JSON.parse(readFileSync(STATE, 'utf8'));
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // Recorded as received.
    }
    const url = new URL(request.url, 'http://double');
    state.requests = [...(state.requests ?? []), { method: request.method, path: request.url, authorization: request.headers.authorization ?? null, body }];
    const [status, document] = answer(state, request.method, url, body);
    writeFileSync(STATE, JSON.stringify(state, null, 2));
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(document));
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
