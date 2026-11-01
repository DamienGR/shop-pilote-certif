/**
 * Replays the Boxtal sandbox corpus (test/fixtures/boxtal/) through an injected
 * fetch, so the adapters are tested on what Boxtal actually answered rather
 * than on its OpenAPI file. No network: a test that forgets a response fails.
 *
 * JavaScript, like the other helpers that read files: the Worker's type
 * configuration has no Node types.
 */

import { readFileSync } from 'node:fs';

const DIR = new URL('../fixtures/boxtal/', import.meta.url);

/**
 * @typedef {{
 *   request: { method: string, path: string, body: unknown },
 *   response: { status: number, contentType: string | null, body: unknown, sameBodyAs?: string },
 * }} Recorded
 */

/**
 * One recorded exchange, by file name without `.json`.
 * @param {string} name
 * @returns {Recorded}
 */
export function recorded(name) {
  /** @type {Recorded} */
  const file = JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
  if (file.response.sameBodyAs) {
    const twin = recorded(file.response.sameBodyAs.replace(/\.json$/, ''));
    file.response.body = twin.response.body;
  }
  return file;
}

/** @typedef {{ method: string, url: string, headers: Headers, body: unknown }} SentRequest */

/**
 * A fetch that answers with the recorded responses, in order, and keeps what
 * it was sent. JSON bodies are re-serialized; XML bodies are sent as recorded.
 * @param {...string} names
 * @returns {{ fetch: typeof fetch, sent: SentRequest[] }}
 */
export function replay(...names) {
  const queue = names.map(recorded);
  /** @type {SentRequest[]} */
  const sent = [];
  /** @type {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} */
  const fake = async (input, init) => {
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${String(input)}`);
    sent.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const { status, contentType, body } = next.response;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: contentType ? { 'content-type': contentType } : {},
    });
  };
  return { fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fake)), sent };
}

/**
 * A fetch that answers one synthetic response, for what the corpus lacks.
 * @param {number} status
 * @param {string} body
 * @returns {typeof fetch}
 */
export function answer(status, body) {
  const fake = async () => new Response(body, { status });
  return /** @type {typeof fetch} */ (/** @type {unknown} */ (fake));
}
