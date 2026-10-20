import { describe, expect, it, vi } from 'vitest';

// .mjs for the same reason as its neighbours: tsconfig pins `types` to the
// Cloudflare types, so node builtins have no declarations in a .ts file here.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';

import { CsvError, parseCsv, parseCsvRecords, sniffDelimiter } from '../../shopctl/src/catalog/csv.mjs';
import { COLUMNS, buildCatalogue, parseCount, parsePrice, slugify, templateHeader } from '../../shopctl/src/catalog/contract.mjs';
import { MAX_BYTES, readCatalogImage, resolveCatalogueImages, sniffType } from '../../shopctl/src/catalog/media.mjs';
import { planImport } from '../../shopctl/src/catalog/plan.mjs';
import { integer, text } from '../../shopctl/src/catalog/sql.mjs';
import { assertWranglerNamesShop, extractJson, imagesBucket } from '../../shopctl/src/catalog/store.mjs';
import { importsReadme } from '../../shopctl/src/commands/new.mjs';
import { slugify as storeSlugify } from '../../src/features/products/slug.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const WITNESS = resolve(ROOT, 'test/fixtures/clients/pilot-fr/catalogue/catalog.csv');
const CANARY = resolve(ROOT, 'test/fixtures/clients/canary-minimal/catalogue/catalog.csv');
const RUNNER = resolve(ROOT, 'test/helpers/catalog-sqlite.mjs');

// Every SQLite scenario applies forty-two migrations before it does any work,
// and some of them import a hundred products. Vitest's five-second default is a
// budget for pure functions.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Run one scenario through the real migrations and the real statements.
 *
 * A child process because `node:sqlite` wants `--experimental-sqlite` on the
 * lower half of the certified Node line — see test/helpers/catalog-sqlite.mjs.
 */
function scenario(input) {
  const result = spawnSync('node', ['--experimental-sqlite', '--no-warnings', RUNNER], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!result.stdout) throw new Error(`the SQLite runner produced nothing: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  if (output.error) throw new Error(`${output.error}\n${output.stack}`);
  return output;
}

/** A catalogue file, plus the images it points at, in a scratch directory. */
function catalogue(rows, { images = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'minshop-catalog-'));
  for (const [path, bytes] of Object.entries(images)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
  }
  const file = join(directory, 'catalog.csv');
  writeFileSync(file, typeof rows === 'string' ? rows : `${[templateHeader().trim(), ...rows].join('\n')}\n`, 'utf8');
  return { directory, file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** One complete row of the contract, so a test can vary the one cell it is about. */
function row(overrides = {}) {
  const cells = {
    sku: 'TOTE-01', product: '', name: 'Cabas', slug: '', description: '', variant_group: '', variant: '',
    price: '19,90', stock: '3', weight_grams: '240', requires_shipping: '', active: '', categories: '', images: '',
    ...overrides,
  };
  return COLUMNS.map((column) => {
    const value = cells[column.name] ?? '';
    return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(',');
}

/** Read a file through the contract, with images resolved against its directory. */
function read(file, { currency = 'EUR' } = {}) {
  const parsed = parseCsvRecords(readFileSync(file, 'utf8'));
  const built = buildCatalogue(parsed, { currency });
  const resolved = resolveCatalogueImages(built.products, { root: dirname(file) });
  return { products: resolved.products, issues: [...built.issues, ...resolved.issues] };
}

/** The messages of every issue, so an assertion can be about the finding rather
 *  than about its position in a list. */
const messages = (issues) => issues.map((issue) => issue.message).join('\n');

const EMPTY_STORE = { products: [], variants: [], categories: [], productCategories: [], productImages: [], media: [] };

/** A 2×2 PNG, the smallest thing the sniffer and the dimension reader both
 *  recognise. Built rather than committed: a test fixture that is a binary blob
 *  is a fixture nobody can review. */
function png(width = 2, height = 2) {
  const chunk = (type, data) => {
    const table = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('the CSV parser survives what spreadsheets emit', () => {
  it('keeps a quoted delimiter, newline and doubled quote inside one value', () => {
    const records = parseCsv('a,b\n"x,y","line1\nline2 ""quoted"""\n');
    expect(records[1].values).toEqual(['x,y', 'line1\nline2 "quoted"']);
  });

  it('strips the BOM Excel writes, so the first column still has its name', () => {
    const parsed = parseCsvRecords('﻿sku,price\nA,1\n');
    expect(parsed.columns[0]).toBe('sku');
  });

  it('reads CRLF without leaving a carriage return in the last value', () => {
    const parsed = parseCsvRecords('sku,price\r\nA,1\r\n');
    expect(parsed.rows[0].cells.price).toBe('1');
  });

  it('does not read a trailing newline as an empty row', () => {
    expect(parseCsvRecords('sku\nA\n').rows).toHaveLength(1);
  });

  it('takes the delimiter from the header, where the answer is unambiguous', () => {
    // The prices below are full of commas; only the header decides.
    expect(sniffDelimiter('sku;name;price\nA;Cabas;19,90\n')).toBe(';');
    expect(sniffDelimiter('sku,name,price\nA,Cabas,"19,90"\n')).toBe(',');
  });

  it('refuses a row whose width differs from the header, rather than shifting it', () => {
    // An unquoted French price is exactly how this happens in the field.
    expect(() => parseCsvRecords('sku,name,price\nA,Cabas,19,90\n')).toThrow(CsvError);
  });

  it('refuses a duplicate column instead of picking one', () => {
    expect(() => parseCsvRecords('sku,sku\nA,B\n')).toThrow(/deux fois/);
  });

  it('refuses an unterminated quote instead of guessing where it ended', () => {
    expect(() => parseCsvRecords('sku\n"A\n')).toThrow(/guillemet fermant/);
  });
});

describe('the contract refuses what the plan asks it to refuse', () => {
  it('SKU manquant', () => {
    const { file, cleanup } = catalogue([row({ sku: '' })]);
    expect(messages(read(file).issues)).toMatch(/ligne sans sku/);
    cleanup();
  });

  it('SKU dupliqué', () => {
    const { file, cleanup } = catalogue([row({ sku: 'A' }), row({ sku: 'A', name: 'Autre' })]);
    expect(messages(read(file).issues)).toMatch(/« A » est déjà utilisée ligne 2/);
    cleanup();
  });

  it('prix invalide', () => {
    expect(parsePrice('12,3456', 'EUR').error).toMatch(/4 décimales/);
    expect(parsePrice('19,90 €', 'EUR').error).toMatch(/n'est pas un prix/);
    expect(parsePrice('-5', 'EUR').error).toMatch(/n'est pas un prix/);
    expect(parsePrice('', 'EUR').error).toMatch(/vide/);
    // The two forms a French spreadsheet actually writes, and the thousands
    // separator fr-FR emits, all reach the same integer.
    expect(parsePrice('19,90', 'EUR').cents).toBe(1990);
    expect(parsePrice('19.90', 'EUR').cents).toBe(1990);
    expect(parsePrice('1 234,50', 'EUR').cents).toBe(123450);
    expect(parsePrice('1 234,50', 'EUR').cents).toBe(123450);
    expect(parsePrice('19', 'EUR').cents).toBe(1900);
  });

  it('stock non entier', () => {
    // "3.0" is what a column formatted as a decimal exports. Truncating it here
    // would make the same file mean different things in different tools.
    expect(parseCount('3.0', { field: 'stock' }).error).toMatch(/entier positif/);
    expect(parseCount('-1', { field: 'stock' }).error).toBeTruthy();
    expect(parseCount('0', { field: 'stock' }).value).toBe(0);
  });

  it('variante incohérente : deux lignes qui ne disent pas la même chose du produit', () => {
    const { file, cleanup } = catalogue([
      row({ sku: 'T-S', product: 'T', name: 'Tee', variant_group: 'Taille', variant: 'S' }),
      row({ sku: 'T-M', product: 'T', name: 'Tee-shirt', variant_group: 'Taille', variant: 'M' }),
    ]);
    expect(messages(read(file).issues)).toMatch(/deux valeurs pour « name »/);
    cleanup();
  });

  it('variante incohérente : un produit qui mélange une ligne avec variante et une sans', () => {
    const { file, cleanup } = catalogue([
      row({ sku: 'T-S', product: 'T', name: 'Tee', variant_group: 'Taille', variant: 'S' }),
      row({ sku: 'T-X', product: 'T', variant: '' }),
    ]);
    expect(messages(read(file).issues)).toMatch(/sans nommer de variante/);
    cleanup();
  });

  it('variante incohérente : une variante qui ne dit pas à quel produit elle appartient', () => {
    const { file, cleanup } = catalogue([row({ variant: 'M', variant_group: 'Taille' })]);
    expect(messages(read(file).issues)).toMatch(/ne dit pas à quel produit/);
    cleanup();
  });

  it('refuse deux produits qui veulent la même URL', () => {
    const { file, cleanup } = catalogue([row({ sku: 'A', name: 'Cabas' }), row({ sku: 'B', name: 'Cabas' })]);
    expect(messages(read(file).issues)).toMatch(/veulent l'URL « cabas »/);
    cleanup();
  });

  it('refuse une colonne inconnue avant de juger la moindre ligne', () => {
    const { file, cleanup } = catalogue(`sku,prix\nA,19\n`);
    const issues = read(file).issues;
    expect(messages(issues)).toMatch(/colonne inconnue « prix »/);
    // One header mistake, one finding — not one per row.
    expect(issues.filter((issue) => issue.message.includes('prix'))).toHaveLength(1);
    cleanup();
  });
});

describe('catégorie inconnue', () => {
  it('refuse une catégorie que la boutique ne connaît pas', () => {
    const { file, cleanup } = catalogue([row({ categories: 'inexistante' })]);
    const plan = planImport(read(file).products, EMPTY_STORE, { currency: 'EUR' });
    expect(plan.refusals[0].message).toMatch(/« inexistante » n'existe pas/);
    expect(plan.statements).toHaveLength(0);
    cleanup();
  });

  it('la crée quand on le demande explicitement', () => {
    const { file, cleanup } = catalogue([row({ categories: 'sacs-de-ville' })]);
    const plan = planImport(read(file).products, EMPTY_STORE, { currency: 'EUR', createCategories: true });
    expect(plan.refusals).toHaveLength(0);
    expect(plan.summary.categoriesCreated).toBe(1);
    cleanup();
  });
});

describe('les images sont jugées sur leurs octets', () => {
  it('image absente', () => {
    const { file, cleanup } = catalogue([row({ images: 'photos/absente.png' })]);
    expect(messages(read(file).issues)).toMatch(/image introuvable/);
    cleanup();
  });

  it('image trop lourde', () => {
    const heavy = Buffer.concat([png(), Buffer.alloc(MAX_BYTES + 1)]);
    const { file, cleanup } = catalogue([row({ images: 'photos/lourde.png' })], { images: { 'photos/lourde.png': heavy } });
    expect(messages(read(file).issues)).toMatch(/la limite est de 5 Mo/);
    cleanup();
  });

  it('faux type MIME : un fichier dont le nom ment sur son contenu', () => {
    const { file, cleanup } = catalogue([row({ images: 'photos/menteuse.jpg' })], { images: { 'photos/menteuse.jpg': png() } });
    expect(messages(read(file).issues)).toMatch(/s'annonce en \.jpg et contient du image\/png/);
    cleanup();
  });

  it('refuse un SVG, qui s\'exécuterait sur le domaine de la boutique', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { file, cleanup } = catalogue([row({ images: 'photos/x.svg' })], { images: { 'photos/x.svg': svg } });
    expect(sniffType(svg)).toBe(null);
    expect(messages(read(file).issues)).toMatch(/n'est pas une image JPEG, PNG, WebP ou GIF/);
    cleanup();
  });

  it('refuse un chemin qui sort du dossier du catalogue', () => {
    const { directory, cleanup } = catalogue([]);
    expect(readCatalogImage('../../etc/passwd', { root: directory })).toMatchObject({ ok: false, error: expect.stringMatching(/sort du dossier/) });
    expect(readCatalogImage('photos/../../secret.png', { root: directory })).toMatchObject({ ok: false });
    expect(readCatalogImage('/etc/passwd', { root: directory })).toMatchObject({ ok: false, error: expect.stringMatching(/chemin absolu/) });
    cleanup();
  });

  it('donne la même clé aux mêmes octets, et une autre à des octets différents', () => {
    const { directory, cleanup } = catalogue([], { images: { 'a.png': png(), 'b.png': png(), 'c.png': png(4, 4) } });
    const key = (name) => readCatalogImage(name, { root: directory }).media.key;
    expect(key('a.png')).toBe(key('b.png'));
    expect(key('a.png')).not.toBe(key('c.png'));
    // Twenty characters, because Cloudflare's observability pipeline redacts a
    // longer hex run out of the request URL — see mediaKeyFor() in
    // src/features/media/upload.ts.
    expect(key('a.png')).toMatch(/^media\/[0-9a-f]{20}\.png$/);
    cleanup();
  });

  it('lit les dimensions dans l\'en-tête', () => {
    const { directory, cleanup } = catalogue([], { images: { 'a.png': png(64, 32) } });
    expect(readCatalogImage('a.png', { root: directory }).media.dimensions).toEqual({ width: 64, height: 32 });
    cleanup();
  });
});

describe('Markdown hostile', () => {
  const HOSTILE = `'); DROP TABLE products;--<script>alert('xss')</script><img src=x onerror=alert(1)>`;

  it('la description survit telle quelle jusque dans la base, et la table aussi', () => {
    const { file, cleanup } = catalogue([row({ sku: 'HOSTILE', name: 'Produit', description: HOSTILE })]);
    const result = scenario({ csv: file, queries: { tables: "SELECT name FROM sqlite_master WHERE type='table' AND name='products'" } });
    expect(result.queries.tables).toHaveLength(1);
    expect(result.catalogue[0].description).toBe(HOSTILE);
    cleanup();
  });

  it('le quotage tient seul, sans compter sur la validation qui le précède', () => {
    expect(text("O'Brien")).toBe("'O''Brien'");
    expect(text("'; DROP TABLE t;--")).toBe("'''; DROP TABLE t;--'");
    // A NUL terminates a string in more parsers than it should, so it never
    // reaches one from here.
    expect(() => text('a\0b')).toThrow(/NUL/);
    expect(() => integer(1.5)).toThrow();
    expect(() => integer('3')).toThrow();
  });
});

describe('un import réel, contre les migrations du dépôt', () => {
  it('construit le catalogue témoin, puis ne fait rien la seconde fois', () => {
    const result = scenario({ csv: WITNESS, options: { createCategories: true }, runs: 2 });

    expect(result.runs[0].summary).toMatchObject({ productsCreated: 20, variantsCreated: 9, categoriesCreated: 4, mediaUploaded: 8 });
    // Réimport sans doublon: the second plan has nothing in it at all. Not
    // "writes the same values again" — nothing to write.
    expect(result.runs[1].summary).toMatchObject({
      productsCreated: 0, productsUpdated: 0, productsUnchanged: 20, variantsCreated: 0, variantsUpdated: 0, mediaUploaded: 0,
    });
    expect(result.runs[1].statements).toBe(0);
    expect(result.runs[1].uploads).toHaveLength(0);

    expect(result.catalogue).toHaveLength(20);
    // Ten rows point at eight photos: the key is the hash of the bytes, so a
    // shared photo is one object and one media row.
    expect(result.state.media).toHaveLength(8);

    const tee = result.catalogue.find((product) => product.sku === 'TEE');
    expect(tee.variant_label).toBe('Taille');
    expect(tee.variants.map((variant) => [variant.sku, variant.stock])).toEqual([['TEE-S', 9], ['TEE-M', 3], ['TEE-L', 0], ['TEE-XL', 6]]);
    // With variants the product row is a "from" price and a total.
    expect(tee.price_cents).toBe(2990);
    expect(tee.stock).toBe(18);
    // The gallery's first image is the denormalized primary, as syncPrimaryImage does it.
    expect(tee.image_key).toBe(tee.images[0]);
    // A description holding a blank line survived the CSV, the contract and the SQL.
    expect(tee.description).toContain('\n\n');
  });

  it('couvre les trois états de stock et plusieurs catégories (plan §2.3)', () => {
    const { catalogue: shop } = scenario({ csv: WITNESS, options: { createCategories: true } });
    const units = shop.flatMap((product) => (product.variants.length > 0 ? product.variants : [product]));
    expect(units.some((unit) => unit.stock === 0)).toBe(true);
    expect(units.some((unit) => unit.stock > 0 && unit.stock <= 5)).toBe(true);
    expect(units.some((unit) => unit.stock > 5)).toBe(true);
    expect(new Set(shop.flatMap((product) => product.categories)).size).toBe(4);
    expect(shop.filter((product) => product.variant_label)).toHaveLength(3);
  });

  // The counter-witness of plan §2.3. The pilot's file fills all fourteen
  // columns, so an import that had quietly come to REQUIRE one of the ten
  // optional ones would still be green there and broken on the next merchant's
  // first file. This one fills the three the contract makes mandatory plus the
  // one its shop has an opinion about, and nothing else.
  it('importe la contre-épreuve : cinq produits, rien d\'autre (plan §2.3)', () => {
    const result = scenario({ csv: CANARY, options: {}, runs: 2 });

    expect(result.runs[0].summary).toMatchObject({
      productsCreated: 5, variantsCreated: 0, categoriesCreated: 0, mediaUploaded: 0,
    });
    // No --create-categories was passed, and none was needed: a file that names
    // no category must not need the flag that creates them.
    expect(result.runs[1].summary).toMatchObject({ productsCreated: 0, productsUnchanged: 5 });
    expect(result.runs[1].statements).toBe(0);

    expect(result.catalogue).toHaveLength(5);
    for (const product of result.catalogue) {
      expect(product.variants).toHaveLength(0);
      expect(product.categories).toEqual([]);
      expect(product.image_key).toBeNull();
      // The shop has no shipping feature, and its file says so on every row.
      expect(product.requires_shipping).toBe(0);
      // Absent is not zero (migration 0030): an unstated weight stays unknown.
      expect(product.weight_grams).toBeNull();
    }
    expect(result.state.media).toHaveLength(0);
    // The three stock states the storefront distinguishes, in five rows.
    const stocks = result.catalogue.map((product) => product.stock);
    expect(stocks.some((stock) => stock === 0)).toBe(true);
    expect(stocks.some((stock) => stock > 0 && stock <= 5)).toBe(true);
    expect(stocks.some((stock) => stock > 5)).toBe(true);
  });

  it('met à jour un produit sans toucher aux autres', () => {
    // The same catalogue, with one product's price and stock corrected. The
    // photos stay where they are, so the edited copy is written NEXT TO the
    // witness file rather than in a scratch directory of its own.
    const edited = join(dirname(WITNESS), 'catalog.edited.csv');
    writeFileSync(edited, readFileSync(WITNESS, 'utf8').replace('39,00;12;380', '41,50;9;380'));
    try {
      const result = scenario({
        imports: [
          { csv: WITNESS, options: { createCategories: true } },
          { csv: edited, options: { createCategories: true } },
        ],
      });

      expect(result.runs[1].summary).toMatchObject({ productsCreated: 0, productsUpdated: 1, productsUnchanged: 19 });
      const changed = result.catalogue.find((product) => product.sku === 'CAB-LIN');
      expect([changed.price_cents, changed.stock]).toEqual([4150, 9]);
      expect(result.catalogue).toHaveLength(20);
      // Nothing else moved: the store still holds one media row per photo.
      expect(result.state.media).toHaveLength(8);
    } finally {
      rmSync(edited, { force: true });
    }
  });

  it('reprend après une interruption et converge sur le même catalogue', () => {
    const complete = scenario({ csv: WITNESS, options: { createCategories: true } });
    // Cut the first run a third of the way through its statements: some rows are
    // written, the rest are not, and nothing recorded how far it got.
    const resumed = scenario({ csv: WITNESS, options: { createCategories: true }, runs: 2, interruptAfter: 40 });

    expect(resumed.runs[0].applied).toBe(40);
    expect(resumed.runs[0].statements).toBeGreaterThan(40);
    // The second run computes the remainder from the store itself, and lands on
    // exactly the catalogue an uninterrupted run produces.
    expect(resumed.catalogue.map((product) => [product.sku, product.price_cents, product.stock, product.images.length]))
      .toEqual(complete.catalogue.map((product) => [product.sku, product.price_cents, product.stock, product.images.length]));
    expect(resumed.state.media).toHaveLength(complete.state.media.length);
    expect(resumed.state.products).toHaveLength(20);
  });

  it('importe cent produits', () => {
    const rows = Array.from({ length: 100 }, (_, index) => {
      const n = String(index + 1).padStart(3, '0');
      return row({ sku: `BULK-${n}`, name: `Article ${n}`, price: `${10 + index},50`, stock: String(index % 7) });
    });
    const { file, cleanup } = catalogue(rows);
    const result = scenario({ csv: file, runs: 2 });
    expect(result.runs[0].summary.productsCreated).toBe(100);
    expect(result.runs[1].summary.productsUnchanged).toBe(100);
    expect(result.catalogue).toHaveLength(100);
    // Slugs derived from a hundred names stayed unique, so no product silently
    // took another's URL.
    expect(new Set(result.catalogue.map((product) => product.slug)).size).toBe(100);
    cleanup();
  });
});

describe('les changements destructifs sont refusés, pas devinés', () => {
  const store = () => ({
    ...EMPTY_STORE,
    products: [{ id: 1, sku: 'TEE', slug: 'tee-shirt', name: 'Tee', description: null, price_cents: 2990, currency: 'eur', stock: 5, active: 1, variant_label: 'Taille', weight_grams: null, requires_shipping: 1, image_key: null }],
    variants: [
      { id: 10, product_id: 1, sku: 'TEE-S', label: 'S', price_cents: 2990, stock: 5, weight_grams: null, position: 0, active: 1, image_id: null },
      { id: 11, product_id: 1, sku: 'TEE-M', label: 'M', price_cents: 2990, stock: 5, weight_grams: null, position: 1, active: 1, image_id: null },
    ],
  });

  const variantRow = (sku, label) => row({ sku, product: 'TEE', name: 'Tee', slug: 'tee-shirt', variant_group: 'Taille', variant: label, price: '29,90', stock: '5', weight_grams: '' });

  it('refuse de retirer une unité vendue sans y être autorisé', () => {
    const { file, cleanup } = catalogue([variantRow('TEE-S', 'S')]);
    const products = read(file).products;
    const refused = planImport(products, store(), { currency: 'EUR' });
    expect(refused.refusals[0].message).toMatch(/retire 1 unité\(s\) vendue\(s\)/);
    expect(refused.statements).toHaveLength(0);

    const allowed = planImport(products, store(), { currency: 'EUR', allowRemoveVariants: true });
    expect(allowed.refusals).toHaveLength(0);
    expect(allowed.summary.variantsDeactivated).toBe(1);
    // Deactivated, never deleted: order_items.variant_id points at it.
    expect(allowed.statements.join('\n')).toMatch(/UPDATE product_variants SET active = 0 WHERE id = 11;/);
    expect(allowed.statements.join('\n')).not.toMatch(/DELETE FROM product_variants/);
    cleanup();
  });

  it('refuse de déplacer une URL publique sans y être autorisé', () => {
    const { file, cleanup } = catalogue([variantRow('TEE-S', 'S'), variantRow('TEE-M', 'M')].map((line) => line.replace('tee-shirt', 'tee-shirt-bio')));
    const products = read(file).products;
    expect(planImport(products, store(), { currency: 'EUR' }).refusals[0].message).toMatch(/déplacerait son URL/);
    expect(planImport(products, store(), { currency: 'EUR', allowSlugChange: true }).refusals).toHaveLength(0);
    cleanup();
  });

  it('ne touche pas aux produits que le fichier ne nomme pas', () => {
    const { file, cleanup } = catalogue([row({ sku: 'AUTRE', name: 'Autre chose' })]);
    const plan = planImport(read(file).products, store(), { currency: 'EUR' });
    expect(plan.untouched.map((product) => product.sku)).toEqual(['TEE']);
    expect(plan.statements.join('\n')).not.toMatch(/tee-shirt/);
    cleanup();
  });

  it('refuse une référence de variante qui appartient déjà à un autre produit', () => {
    const { file, cleanup } = catalogue([
      row({ sku: 'TEE-S', product: 'POLO', name: 'Polo', variant_group: 'Taille', variant: 'S' }),
    ]);
    const plan = planImport(read(file).products, store(), { currency: 'EUR' });
    expect(plan.refusals[0].message).toMatch(/appartient déjà à un autre produit/);
    cleanup();
  });

  it('adopte un produit créé sans référence, et refuse d\'en voler un qui en a une', () => {
    const orphan = { ...store(), products: [{ ...store().products[0], sku: null, variant_label: null }], variants: [] };
    const { file, cleanup } = catalogue([row({ sku: 'NOUVEAU', name: 'Tee', slug: 'tee-shirt' })]);
    const adopted = planImport(read(file).products, orphan, { currency: 'EUR' });
    expect(adopted.refusals).toHaveLength(0);
    expect(adopted.warnings[0]).toMatch(/la référence « NOUVEAU » lui est attribuée/);

    const owned = planImport(read(file).products, { ...store(), variants: [] }, { currency: 'EUR' });
    expect(owned.refusals[0].message).toMatch(/appartient déjà au produit « TEE »/);
    cleanup();
  });
});

describe('les règles partagées avec le cœur ne dérivent pas', () => {
  // Two copies of one pure rule exist on purpose (a Worker bundle and a
  // build-free CLI). Pinning them against a shared corpus is what turns a
  // divergence into a failing gate instead of two URLs for one name.
  const CORPUS = [
    'Cabas en lin lavé', "L'Atelier d'à côté", 'Mug — grès émaillé', 'Crème n°5', 'Ça va ?', 'ÉCHARPE',
    'a'.repeat(120), '---', '   ', 'Größe M', '100 % coton', 'Été/Hiver', 'œuf & cie', 'Ⅳ chiffres romains',
  ];

  it('slugify est le même des deux côtés', () => {
    for (const input of CORPUS) expect([input, slugify(input)]).toEqual([input, storeSlugify(input)]);
  });
});

describe('l\'import refuse d\'écrire dans une autre boutique', () => {
  const manifest = { cloudflare: { workerName: 'minshop-atelier' } };

  it('dérive le nom du bucket du manifeste, pas du fichier rendu', () => {
    expect(imagesBucket(manifest)).toBe('minshop-atelier-images');
  });

  it('refuse un wrangler.jsonc qui décrit une autre boutique', () => {
    // The D1 binding is called `DB` in every shop, so this write would succeed
    // — against someone else's database. Nothing else in the stack catches it.
    const { directory, cleanup } = catalogue([]);
    writeFileSync(join(directory, 'wrangler.jsonc'), '{ "name": "minshop-autre", "r2_buckets": [{ "bucket_name": "minshop-autre-images" }] }');
    expect(() => assertWranglerNamesShop(directory, imagesBucket(manifest))).toThrow(/ne nomme pas « minshop-atelier-images »/);

    writeFileSync(join(directory, 'wrangler.jsonc'), '{ "r2_buckets": [{ "bucket_name": "minshop-atelier-images" }] }');
    expect(() => assertWranglerNamesShop(directory, imagesBucket(manifest))).not.toThrow();
    cleanup();
  });

  // Le remède d'un import distant est `provision`, pas `prepare-client` : ce
  // dernier rend les bons noms autour d'un identifiant de base factice, le
  // contrôle passe, et wrangler échoue sur une base qui n'existe pas
  // (répétition de l'étape 7 de la certification).
  it('envoie un import distant vers provision, qui rend l\'identifiant réel', () => {
    const { directory, cleanup } = catalogue([]);
    writeFileSync(join(directory, 'wrangler.jsonc'), '{ "name": "minshop-autre-staging" }');
    const remote = () => assertWranglerNamesShop(directory, 'minshop-atelier-staging-images', { remote: true, env: 'staging' });
    expect(remote).toThrow(expect.objectContaining({ hint: expect.stringMatching(/shopctl -- provision --env staging/) }));
    expect(remote).toThrow(expect.objectContaining({ hint: expect.not.stringMatching(/prepare-client/) }));
    const local = () => assertWranglerNamesShop(directory, 'minshop-atelier-images');
    expect(local).toThrow(expect.objectContaining({ hint: expect.stringMatching(/prepare-client\.mjs <slug>`/) }));
    cleanup();
  });

  it('refuse un arbre sans wrangler.jsonc du tout', () => {
    const { directory, cleanup } = catalogue([]);
    expect(() => assertWranglerNamesShop(directory, 'minshop-atelier-images')).toThrow(/pas de wrangler\.jsonc/);
    cleanup();
  });
});

describe('le contrat est documenté là où le commerçant le remplit', () => {
  it('le README posé par `shopctl new` nomme chaque colonne', () => {
    const readme = importsReadme('atelier-du-nord');
    // A column the merchant's own documentation never mentions is a column
    // filled by guesswork, and the guess is discovered at the import.
    for (const column of COLUMNS) expect(readme).toContain(`\`${column.name}\``);
    // The table stays a table: `|` is this contract's list separator AND the
    // cell separator, so the descriptions that contain one must escape it.
    const rows = readme.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows).toHaveLength(COLUMNS.length);
    for (const line of rows) expect(line.split(/(?<!\\)\|/)).toHaveLength(5);
  });
});

describe('le rapport de wrangler est lu, pas deviné', () => {
  it('prend le document JSON même précédé d\'une bannière', () => {
    expect(extractJson('\n ⛅️ wrangler 4.0.0\n---\n[{"results":[{"n":1}]}]\n')).toEqual([{ results: [{ n: 1 }] }]);
  });

  it('refuse une sortie qui ne contient aucun document', () => {
    expect(() => extractJson('Error: no such database')).toThrow(/JSON/);
  });
});
