import { describe, it, expect } from 'vitest';
import migration from '../../../migrations/0040_french_legal_pages.sql?raw';
import { INCOMPLETE_MARKER, isIncomplete, refusesIncompletePages } from './completeness';

// The skeletons as migration 0040 seeds them: the guard is only worth what it
// catches in the text a shop actually starts from.
// Title, slug, body: the first three values of each seeded page.
const SEEDED_PAGE = /INSERT OR IGNORE INTO pages \([^)]*\) VALUES \(\s*'([^']+)',\s*'([^']+)',\s*'((?:[^']|'')*)'/g;
const skeletons = [...migration.matchAll(SEEDED_PAGE)].map(([, title, slug, body]) => ({ title, slug, body: body.replaceAll("''", "'") }));

describe('isIncomplete', () => {
  it('reads the four legal skeletons of migration 0040', () => {
    expect(skeletons.map((page) => page.slug)).toEqual([
      'conditions-generales-de-vente',
      'mentions-legales',
      'politique-de-confidentialite',
      'droit-de-retractation',
    ]);
  });

  it.each(skeletons)('finds the markers in the $slug skeleton', ({ body }) => {
    expect(body).toContain(INCOMPLETE_MARKER);
    expect(isIncomplete(body)).toBe(true);
  });

  it('finds a marker that carries an instruction', () => {
    expect(isIncomplete('Version : [À COMPLÉTER — reprendre legal.termsVersion]')).toBe(true);
  });

  it('finds a marker whose À was pasted decomposed', () => {
    expect(isIncomplete('SIREN : [À COMPLÉTER]')).toBe(true);
  });

  it('passes a finished text', () => {
    expect(isIncomplete('Dénomination sociale : Atelier Exemple SAS')).toBe(false);
    expect(isIncomplete('')).toBe(false);
  });
});

describe('refusesIncompletePages', () => {
  it('refuses in production only', () => {
    expect(refusesIncompletePages('production')).toBe(true);
    // The certification publishes the skeletons on staging to test the consent gate.
    expect(refusesIncompletePages('staging')).toBe(false);
    // A render that reaches no account: a witness build, local development.
    expect(refusesIncompletePages('')).toBe(false);
    expect(refusesIncompletePages(undefined)).toBe(false);
  });
});
