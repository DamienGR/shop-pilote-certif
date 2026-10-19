import { auth } from './auth.ts';
import { categories } from './categories.ts';
import { common } from './common.ts';
import { customers } from './customers.ts';
import { dashboard } from './dashboard.ts';
import { media } from './media.ts';
import { navigation } from './navigation.ts';
import { orders } from './orders.ts';
import { pages } from './pages.ts';
import { products } from './products.ts';
import { settings } from './settings.ts';
import { shell } from './shell.ts';
import { shipping } from './shipping.ts';

/**
 * Every string the Admin renders, in French (ADR 0018, which replaces 0011).
 *
 * One fragment per Admin section, so a screen's strings sit next to each other
 * and a change to Orders never conflicts with one to Settings. They are NOT a
 * second catalog: `messages.ts` spreads them into `fr`, so `t()` has one lookup,
 * `MessageKey` one source, and `messages.test.ts` holds Admin strings to the
 * same French typography as the storefront's.
 *
 * Every key starts with `admin.`, which no storefront key does: a spread
 * overwrites silently, and the prefix is what makes an overwrite impossible
 * (`messages.test.ts` checks both).
 */
export const ADMIN_FRAGMENTS = {
  common,
  shell,
  auth,
  dashboard,
  products,
  categories,
  media,
  orders,
  customers,
  pages,
  navigation,
  shipping,
  settings,
} as const;

export const frAdmin = {
  ...common,
  ...shell,
  ...auth,
  ...dashboard,
  ...products,
  ...categories,
  ...media,
  ...orders,
  ...customers,
  ...pages,
  ...navigation,
  ...shipping,
  ...settings,
};
