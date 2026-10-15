-- Migration 0044: an exact count of admin login attempts.
--
-- The edge rate limiter is permissive by design (counted per location, cached
-- per machine) and let a patient guesser through on a deployed shop
-- (certification, step 5). src/features/auth/loginThrottle.ts counts here
-- instead: one row per client network, keyed by an HMAC of it, never the
-- address. A row lives for one window and is dropped with the next attempt
-- after it.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  client_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_window
  ON admin_login_attempts (window_started_at);
