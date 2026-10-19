/**
 * The CLI never receives, prints, or writes a secret.
 *
 * Two halves of one promise (plan §5.1, README "CLI prévue"). A credential
 * passed as an argument is already leaked before the process reads it — it is
 * in the operator's shell history, in the CI log of the job that ran the
 * command, and in the process table of a shared machine — so the CLI refuses
 * it outright rather than accepting it and being careful afterwards. And every
 * line the CLI emits passes through `redact()`, because the leak that actually
 * happens is the one nobody wrote on purpose: a wrapped command echoing its own
 * arguments back in an error message.
 *
 * The patterns are the manifest's, imported rather than copied. A second list
 * would drift, and it would drift on whichever side is reviewed less.
 */
import { CREDENTIAL_PATTERNS } from '../../scripts/manifest-schema.mjs';
import { inputError } from './errors.mjs';

export const REDACTED = '[redacted]';

/** What a value looks like, or null when it looks like nothing in particular. */
export function classifyCredential(value) {
  if (typeof value !== 'string') return null;
  for (const { pattern, what } of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) return what;
  }
  return null;
}

/**
 * Replace anything credential-shaped in a line about to be displayed.
 *
 * Anchored patterns (the bare hex blob) can only match a whole line, which is
 * the conservative reading: a long hex identifier quoted inside a sentence is
 * not evidence of a secret, and redacting it would hide the resource id an
 * operator is trying to read.
 */
export function redact(text) {
  let out = String(text);
  for (const { pattern } of CREDENTIAL_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), REDACTED);
  }
  return out;
}

/**
 * Refuse a command line carrying a credential.
 *
 * Thrown as an INPUT error, not a warning: by the time this runs the value is
 * already in the shell history, so the useful thing the CLI can do is stop and
 * say the credential must be rotated rather than quietly proceed.
 *
 * @param {string[]} argv the raw arguments, without the node/script entries
 */
export function assertNoCredentialsInArgv(argv) {
  for (const argument of argv) {
    // `--flag=value` hides the value from a naive scan of the whole token only
    // when the flag name itself matches first; split so the value is judged.
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument;
    const what = classifyCredential(value) ?? classifyCredential(argument);
    if (what) {
      throw inputError(
        `an argument looks like ${what}.`,
        'shopctl never takes a credential on the command line: it is already in your shell history and in the CI log of whatever ran it. Rotate that key, then set it in Admin → Réglages or the platform secret store.',
      );
    }
  }
}
