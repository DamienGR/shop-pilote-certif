/**
 * Whether a page body still carries the skeleton's `[À COMPLÉTER]` markers.
 *
 * Migration 0040 seeds the four legal pages as drafts whose text is a
 * skeleton: every fact only the merchant can supply — a company name, a SIREN,
 * a mediator — is a `[À COMPLÉTER]` marker. Nothing stopped a production from
 * publishing them as they stood, and the pilot's did: its first real order
 * accepted terms of sale that named no seller (certification, étape 11,
 * 2026-10-25). A production now refuses to put such a page live. Staging still
 * may, because the certification publishes the skeletons there to exercise the
 * consent gate (étape 4) before anyone has written the text.
 *
 * Pure: the page save and the tests share it.
 */

/** The prefix every marker of migration 0040 starts with, `[À COMPLÉTER — …]` included. */
export const INCOMPLETE_MARKER = '[À COMPLÉTER';

/** True when the body still holds a marker. NFC first: a pasted "À" may arrive decomposed. */
export function isIncomplete(body: string): boolean {
  return body.normalize('NFC').includes(INCOMPLETE_MARKER);
}

/** Whether this environment refuses to put an incomplete page live. */
export function refusesIncompletePages(environment: string | undefined): boolean {
  return environment === 'production';
}
