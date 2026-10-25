import { pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * The fixture store's admin login, for the specs that drive the admin.
 *
 * Shared by serve.mjs, which stores its hash, and the specs, which type it.
 * A fixture value on a throwaway database, never a deployed shop's: the specs
 * that use it skip against BASE_URL.
 */
export const ADMIN_PASSWORD = 'browser suite admin password';

/**
 * The stored form src/features/auth/password.ts verifies:
 * `pbkdf2$<iterations>$<saltB64>$<hashB64>`, PBKDF2-HMAC-SHA256. Derived here
 * with node:crypto because serve.mjs runs as plain Node, without type stripping.
 */
export function adminPasswordHash(password = ADMIN_PASSWORD) {
  const iterations = 100_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
