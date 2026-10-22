import { describe, it, expect } from 'vitest';
import type { AstroCookies } from 'astro';
import { applySubmittedQuantities, cartCount, readCart } from './cart';

const P = 'prod_k7m2qx8vn6';
const V = 'var_n9fx2km7qc';

/** Minimal AstroCookies stand-in serving one raw `cart` cookie value. */
const cookiesWith = (value: unknown): AstroCookies =>
  ({
    get: (name: string) =>
      name === 'cart' ? { json: () => value } : undefined,
  }) as unknown as AstroCookies;

describe('cartCount', () => {
  it('sums line quantities', () => {
    expect(cartCount({ [P]: 2, [`${P}:${V}`]: 3 })).toBe(5);
  });

  it('is 0 for an empty cart', () => {
    expect(cartCount({})).toBe(0);
  });
});

describe('readCart (cookie v2)', () => {
  it('reads a v2 cookie of public-ID keys', () => {
    expect(readCart(cookiesWith({ v: 2, items: { [P]: 2, [`${P}:${V}`]: 1 } }))).toEqual({
      [P]: 2,
      [`${P}:${V}`]: 1,
    });
  });

  it('expires a pre-cutover cookie (bare map, no version marker)', () => {
    expect(readCart(cookiesWith({ '5': 2, '5:12#3,7': 1 }))).toEqual({});
  });

  it('expires any other cookie version', () => {
    expect(readCart(cookiesWith({ v: 1, items: { [P]: 2 } }))).toEqual({});
    expect(readCart(cookiesWith({ v: 3, items: { [P]: 2 } }))).toEqual({});
  });

  it('drops numeric legacy keys even inside a v2 envelope', () => {
    expect(readCart(cookiesWith({ v: 2, items: { '5': 2, [P]: 1 } }))).toEqual({ [P]: 1 });
  });

  it('drops malformed quantities and clamps oversized ones', () => {
    expect(
      readCart(cookiesWith({ v: 2, items: { [P]: 'x', [`${P}:${V}`]: 500 } })),
    ).toEqual({ [`${P}:${V}`]: 99 });
  });

  it('is empty for a missing or non-object cookie', () => {
    expect(readCart(cookiesWith(undefined))).toEqual({});
    expect(readCart(cookiesWith('nope'))).toEqual({});
  });
});

describe('applySubmittedQuantities', () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    return f;
  };

  it('sets the quantity typed into each line', () => {
    const cart = { [P]: 1, [`${P}:${V}`]: 1 };
    expect(applySubmittedQuantities(cart, form({ [`qty:${P}`]: '3', [`qty:${P}:${V}`]: '2' }))).toBe(true);
    expect(cart).toEqual({ [P]: 3, [`${P}:${V}`]: 2 });
  });

  it('removes a line set to zero or to something that is not a quantity', () => {
    const cart = { [P]: 2, [`${P}:${V}`]: 1 };
    applySubmittedQuantities(cart, form({ [`qty:${P}`]: '0', [`qty:${P}:${V}`]: 'x' }));
    expect(cart).toEqual({});
  });

  it('clamps an oversized quantity', () => {
    const cart = { [P]: 1 };
    applySubmittedQuantities(cart, form({ [`qty:${P}`]: '500' }));
    expect(cart).toEqual({ [P]: 99 });
  });

  it('never adds a line the cart does not hold', () => {
    // Adding goes through `add`, which checks the variant and extras against D1;
    // a quantity field must not be a second, unchecked way in.
    const cart = { [P]: 1 };
    expect(applySubmittedQuantities(cart, form({ [`qty:${P}:${V}`]: '4', 'qty:5': '2' }))).toBe(false);
    expect(cart).toEqual({ [P]: 1 });
  });

  it('reports no change when the form carries no quantity, or the same one', () => {
    const cart = { [P]: 2 };
    expect(applySubmittedQuantities(cart, form({ source: 'cart', method: 'demo' }))).toBe(false);
    expect(applySubmittedQuantities(cart, form({ [`qty:${P}`]: '2' }))).toBe(false);
    expect(cart).toEqual({ [P]: 2 });
  });
});
