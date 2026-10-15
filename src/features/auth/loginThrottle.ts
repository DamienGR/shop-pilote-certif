import type { D1Database } from '@cloudflare/workers-types';

/**
 * An exact count of admin login attempts, per client network, in D1.
 *
 * The edge limiter (rateLimit.ts) is Cloudflare's, counted per location and
 * cached per machine: permissive by design. Certification step 5 measured it on
 * a deployed shop — no 429 in three times its limit, 232 guesses in 70 s all
 * answered. It stops a flood; it does not stop a patient guesser, and a
 * production admin has no Access in front of its password.
 *
 * This counter is exact. The attempt is counted BEFORE the password is checked,
 * in one statement, so fifty parallel guesses get exactly `LOGIN_ATTEMPT_LIMIT`
 * answers and a slow PBKDF2 compare cannot open a window between the read and
 * the write. A successful login clears the client's row: what is counted is
 * failures, plus the attempt in flight.
 */
export const LOGIN_ATTEMPT_LIMIT = 5;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

/**
 * What a client is, for counting. An IPv4 address as is; an IPv6 address by
 * its /64, because one subscriber holds a whole /64 and walking it costs
 * nothing. An IPv4 address written in IPv6 form is read as the IPv4 it carries.
 */
export function clientNetwork(ip: string | null | undefined): string {
  const address = ip?.trim().toLowerCase() ?? '';
  if (!address) return 'unknown-client';
  if (!address.includes(':')) return address;
  const embedded = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) return embedded[1];
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * The row's key: a keyed hash of the client network, never the address itself.
 * The table holds no IP a backup or an export could carry; the key changes with
 * the secret, which only resets the counters.
 */
export async function loginThrottleKey(secret: string, ip: string | null | undefined): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`admin-login:${clientNetwork(ip)}`));
  return [...new Uint8Array(mac).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface LoginAttempt {
  /** Whether this attempt may be checked against the password. */
  allowed: boolean;
  /** Seconds until the client's window ends; meaningful when refused. */
  retryAfter: number;
}

/** The decision on a counted attempt, from what the upsert returned. */
export function judgeAttempt(attempts: number, windowStartedAt: number, now: number): LoginAttempt {
  return {
    allowed: attempts <= LOGIN_ATTEMPT_LIMIT,
    retryAfter: Math.max(1, windowStartedAt + LOGIN_WINDOW_SECONDS - now),
  };
}

/**
 * Count one attempt and say whether it may proceed. Rows whose window has
 * ended are dropped in the same batch, so the table holds the last quarter of
 * an hour and nothing older.
 */
export async function countLoginAttempt(db: D1Database, key: string, now: number): Promise<LoginAttempt> {
  const expired = now - LOGIN_WINDOW_SECONDS;
  const [, counted] = await db.batch<{ attempts: number; window_started_at: number }>([
    db.prepare('DELETE FROM admin_login_attempts WHERE window_started_at <= ?').bind(expired),
    // SET reads the row as it was before the update, so both CASEs see the
    // same window.
    db
      .prepare(
        `INSERT INTO admin_login_attempts (client_key, attempts, window_started_at) VALUES (?1, 1, ?2)
         ON CONFLICT (client_key) DO UPDATE SET
           attempts = CASE WHEN window_started_at <= ?3 THEN 1 ELSE attempts + 1 END,
           window_started_at = CASE WHEN window_started_at <= ?3 THEN ?2 ELSE window_started_at END
         RETURNING attempts, window_started_at`,
      )
      .bind(key, now, expired),
  ]);
  const row = counted.results[0];
  return judgeAttempt(row.attempts, row.window_started_at, now);
}

/** A successful login: the client starts again from nothing. */
export async function clearLoginAttempts(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM admin_login_attempts WHERE client_key = ?').bind(key).run();
}
