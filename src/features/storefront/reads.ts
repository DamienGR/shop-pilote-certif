import type { D1Database, D1Result } from '@cloudflare/workers-types';
import {
  ancestorsStatement,
  categoriesForProductStatement,
  countProductsInCategoryStatement,
  listCategoriesStatement,
  productsInCategoryStatement,
  relatedProductsStatement,
  type Category,
} from '../categories/db';
import {
  countProductsStatement,
  listProductImagesStatement,
  listProductsStatement,
  type Product,
  type ProductImageRow,
} from '../products/db';
import {
  listExtrasStatement,
  listVariantsStatement,
  type ProductExtra,
  type ProductVariant,
} from '../products/variants';

/**
 * The storefront's page reads, one `db.batch()` each.
 *
 * CPU, not latency, is why. On the Workers Free plan a request has 10 ms of
 * CPU, and every D1 call spends some of it in the isolate — the statement
 * serialised, the binding's fetch, its trace span, the rows parsed back. The
 * certification measured it (étape 6, the built Worker under V8's profiler):
 * a product page made seven D1 calls, and those calls were about 60 % of its
 * warm CPU; sent as one batch, the page fell from 13 to 8 ms. A batch is one
 * call whatever it holds, and its statements run in order in one transaction —
 * harmless for reads.
 *
 * What a batch cannot do is feed one statement's answer to the next. So the
 * row a page is ABOUT (the product, the category) stays its own read, and a
 * listing fetches the page that was ASKED for: when `?page=` is past the end,
 * the loader clamps and reads the last page again — the one case that costs
 * a second call.
 */

const rows = <T>(result: D1Result | undefined): T[] => (result?.results ?? []) as T[];
const count = (result: D1Result | undefined): number =>
  ((result?.results?.[0] as { n?: number } | undefined)?.n ?? 0);

export interface ProductPageRows {
  categories: Category[];
  variants: ProductVariant[];
  extras: ProductExtra[];
  images: ProductImageRow[];
  /** Active products sharing a category, newest first, up to `relatedLimit`. */
  related: Product[];
}

/** Everything a product page reads once its product is known. */
export async function readProductPageRows(
  db: D1Database,
  productId: number,
  relatedLimit: number,
): Promise<ProductPageRows> {
  const [categories, variants, extras, images, related] = await db.batch([
    categoriesForProductStatement(db, productId),
    listVariantsStatement(db, productId),
    listExtrasStatement(db, productId),
    listProductImagesStatement(db, productId),
    relatedProductsStatement(db, productId, relatedLimit),
  ]);
  return {
    categories: rows<Category>(categories),
    variants: rows<ProductVariant>(variants),
    extras: rows<ProductExtra>(extras),
    images: rows<ProductImageRow>(images),
    related: rows<Product>(related),
  };
}

export interface ListingQuery {
  pageSize: number;
  offset: number;
  /** A clause from features/products/sort.ts — never request input. */
  order: string;
}

/** The catalogue: its size, the category list, and one page of products. */
export async function readCatalogRows(
  db: D1Database,
  { pageSize, offset, order }: ListingQuery,
): Promise<{ total: number; categories: Category[]; products: Product[] }> {
  const [total, categories, products] = await db.batch([
    countProductsStatement(db),
    listCategoriesStatement(db),
    listProductsStatement(db, pageSize, offset, order),
  ]);
  return { total: count(total), categories: rows<Category>(categories), products: rows<Product>(products) };
}

/** A category page: its trail, the category list, its size, one page of products. */
export async function readCategoryRows(
  db: D1Database,
  categoryId: number,
  { pageSize, offset, order }: ListingQuery,
): Promise<{ trail: Category[]; categories: Category[]; total: number; products: Product[] }> {
  const [trail, categories, total, products] = await db.batch([
    ancestorsStatement(db, categoryId),
    listCategoriesStatement(db),
    countProductsInCategoryStatement(db, categoryId),
    productsInCategoryStatement(db, categoryId, pageSize, offset, order),
  ]);
  return {
    trail: rows<Category>(trail),
    categories: rows<Category>(categories),
    total: count(total),
    products: rows<Product>(products),
  };
}
