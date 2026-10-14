import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Deliberately .mjs, and source-level, for the reasons shell-source.test.mjs
// gives: /express reads request context and runtime bindings, so AstroContainer
// cannot render it.
//
// Found on a real store: /express drew one form per payment method, each with
// its own terms checkbox, so two methods showed the checkbox twice. The cart
// draws one form, one checkbox, and one submit button per method; /express must
// keep that shape.
const count = (text, needle) => text.split(needle).length - 1;

describe('the express checkout', () => {
  const express = readFileSync('src/pages/express.astro', 'utf8');

  it('asks for the terms once, whatever the number of methods', () => {
    expect(count(express, 'name="accept_terms"')).toBe(1);
    expect(express.indexOf('name="accept_terms"')).toBeLessThan(express.indexOf('methodRows.map'));
  });

  it('posts every method through one form, the method carried by its button', () => {
    expect(count(express, '<form')).toBe(1);
    expect(express).toMatch(/<button[^>]*name="method"[^>]*value=\{m\}/);
  });
});
