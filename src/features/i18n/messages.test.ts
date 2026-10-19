import { describe, expect, it } from 'vitest';
import { fr } from './messages';
import { ADMIN_FRAGMENTS } from './admin';
import { t, tn, type MessageKey } from './index';

const entries = Object.entries(fr) as [MessageKey, string][];

/**
 * What a compiler cannot check about a catalog.
 *
 * The types in `index.ts` already make a missing or invented key a build error
 * (see test/i18n/catalog-typing.test.mjs). What they cannot see is whether the
 * VALUES are French: a key typed as `string` accepts "Add to cart" and a
 * straight apostrophe just as readily as the right answer.
 */
describe('the French catalog', () => {
  it('has no empty or untrimmed value', () => {
    for (const [key, value] of entries) {
      expect(value, key).not.toBe('');
      // Leading and trailing spaces are meaningful in a few keys (' — épuisé',
      // 'à partir de '), so only tabs and newlines are rejected outright.
      expect(value, key).not.toMatch(/[\t\n]/);
    }
  });

  it('uses the typographic apostrophe, never the straight quote', () => {
    for (const [key, value] of entries) {
      expect(value, key).not.toContain("'");
    }
  });

  it('uses a narrow no-break space before ? ! ; and :', () => {
    // A plain space there is a line break waiting to happen on a narrow screen:
    // "Un problème\n?" is the classic French-typography bug on mobile.
    for (const [key, value] of entries) {
      expect(value, key).not.toMatch(/(?<![ ])[ ]([?!;:])/);
    }
  });

  it('carries the accents rather than stripping them', () => {
    // Round-trips through the same UTF-8 the Worker serves. A catalog that lost
    // its accents in a build step reads as broken French, not as a subtle bug.
    const accented = entries.filter(([, value]) => /[àâçéèêëîïôùûüœÀÉÈÊÎÔÛ]/.test(value));

    expect(accented.length).toBeGreaterThan(5);
    for (const [key, value] of accented) {
      const roundTripped = new TextDecoder().decode(new TextEncoder().encode(value));
      expect(roundTripped, key).toBe(value);
    }
  });

  it('closes every placeholder it opens', () => {
    for (const [key, value] of entries) {
      const opens = (value.match(/\{/g) ?? []).length;
      const closes = (value.match(/\}/g) ?? []).length;

      expect(opens, key).toBe(closes);
      expect(value, key).not.toMatch(/\{\s*\}/);
    }
  });
});

describe('the Admin fragments', () => {
  const fragments = Object.entries(ADMIN_FRAGMENTS) as [string, Record<string, string>][];

  it('prefix every key with admin.', () => {
    // The prefix is what keeps the spread in `messages.ts` from silently
    // replacing a storefront string with an Admin one of the same key.
    for (const [name, fragment] of fragments) {
      for (const key of Object.keys(fragment)) expect(key, name).toMatch(/^admin\.[a-z]/);
    }
  });

  it('never define the same key twice, and lose none in the spread', () => {
    const seen = new Map<string, string>();
    for (const [name, fragment] of fragments) {
      for (const key of Object.keys(fragment)) {
        expect(seen.get(key), `${key} is in both ${seen.get(key)} and ${name}`).toBeUndefined();
        seen.set(key, name);
      }
    }
    const inCatalog = Object.keys(fr).filter((key) => key.startsWith('admin.'));
    expect(inCatalog.length).toBe(seen.size);
  });
});

describe('t()', () => {
  it('returns the string for a key', () => {
    expect(t('product.addToCart')).toBe('Ajouter au panier');
  });

  it('substitutes named placeholders', () => {
    expect(t('shell.meta.description', { boutique: 'Chez Camille' })).toBe(
      'Découvrez la boutique Chez Camille.',
    );
  });

  it('leaves an unsupplied placeholder visible', () => {
    // Blanking it would read as a sentence the translator meant to end there.
    expect(t('shell.meta.description', {})).toContain('{boutique}');
  });

  it('keeps a value containing braces from being re-scanned', () => {
    // A store name is merchant input. Substitution is a single pass, so a name
    // that happens to contain `{boutique}` cannot expand a second time.
    const once = t('shell.meta.description', { boutique: '{boutique}' });

    expect(once).toBe('Découvrez la boutique {boutique}.');
  });
});

describe('tn()', () => {
  it('takes the singular for zero, as French does', () => {
    // Not `count === 1`: fr puts 0 in the CLDR `one` category ("0 article"),
    // which is exactly where an English-shaped rule gets it wrong.
    expect(tn('cart.items.one', 'cart.items.other', 0)).toBe('0 article');
    expect(tn('cart.items.one', 'cart.items.other', 1)).toBe('1 article');
  });

  it('takes the plural from two up', () => {
    expect(tn('cart.items.one', 'cart.items.other', 2)).toBe('2 articles');
  });
});
