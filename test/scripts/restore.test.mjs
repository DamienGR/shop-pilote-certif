import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { generatedColumns } from '../../shopctl/src/backup/schema.mjs';
import { digest, insertStatements, restoreScript } from '../../shopctl/src/backup/dump.mjs';
import { authenticatedHeader, objectContext } from '../../shopctl/src/backup/archive.mjs';
import { loadKey, open, seal } from '../../shopctl/src/backup/crypto.mjs';
import { HOSTILE, IMAGE_BYTES, IMAGE_KEY, names, seededShop, takeBackup } from '../helpers/backup-shop.mjs';
import { ACCOUNT } from '../helpers/provisioned-shop.mjs';

/** Everything the shop wrote, as the target database holds it now. */
function contents(target) {
  return {
    products: target.query('SELECT slug, name, description, price_cents, image_key FROM products ORDER BY id'),
    orders: target.query('SELECT provider_session_id, email, amount_total_cents, status, refunded_cents FROM orders ORDER BY id'),
    items: target.query('SELECT order_id, product_id, name, quantity FROM order_items ORDER BY id'),
    media: target.query('SELECT image_key, original_name FROM media ORDER BY id'),
    settings: target.query('SELECT key, value FROM settings ORDER BY key'),
    categories: target.query('SELECT slug, name FROM categories ORDER BY id'),
  };
}

/** Wipe what the shop wrote, leaving the schema and its own seeds in place. */
function emptyTheShop(target) {
  target.sql([
    'DELETE FROM order_items;',
    'DELETE FROM order_item_ids;',
    'DELETE FROM orders;',
    'DELETE FROM product_categories;',
    'DELETE FROM products;',
    'DELETE FROM categories;',
    'DELETE FROM media;',
    'DELETE FROM settings;',
  ]);
}

/**
 * Turn an archive into what v0.3.31 and earlier wrote: format 1, each object
 * sealed for the ARCHIVE rather than for its bucket and key. Every archive in a
 * backups bucket today is one of those, and must still come back.
 */
function asFormatOne(target, id) {
  const directory = join(target.root, 'backups', id);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const { key } = loadKey({ root: target.root, file: '.shopctl/backup.key' });
  const older = { ...manifest, format: 1, r2: { buckets: manifest.r2.buckets.map((bucket) => ({ ...bucket })) } };
  for (const bucket of older.r2.buckets) {
    bucket.inventory = bucket.inventory.map(({ pool, ...object }) => {
      if (!object.file) return object;
      const file = join(directory, object.file);
      const bytes = open({ ...object.cipher, ciphertext: readFileSync(file) }, key, objectContext(manifest, bucket.name, object.key));
      const sealed = seal(bytes, key, objectContext(older, bucket.name, object.key));
      writeFileSync(file, sealed.ciphertext);
      return { ...object, digest: digest(sealed.ciphertext), cipher: { iv: sealed.iv, tag: sealed.tag } };
    });
  }
  const body = open({ ...manifest.cipher, ciphertext: readFileSync(join(directory, 'data.bin')) }, key, authenticatedHeader(manifest));
  const sealed = seal(body, key, authenticatedHeader(older));
  writeFileSync(join(directory, 'data.bin'), sealed.ciphertext);
  older.cipher = { ...manifest.cipher, iv: sealed.iv, tag: sealed.tag };
  older.data = { ...manifest.data, bytes: sealed.ciphertext.length, digest: digest(sealed.ciphertext) };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(older, null, 2));
}

vi.setConfig({ testTimeout: 60_000 });

describe('the restore script', () => {
  /**
   * Deletes run in reverse dependency order and inserts in dependency order, so
   * neither half ever asks a foreign key to point at a row that is not there
   * yet or has just gone.
   */
  it('empties children before parents and fills parents before children', () => {
    const statements = restoreScript({
      order: ['orders', 'order_items'],
      tables: {
        orders: { columns: ['id'], rows: [{ id: 1 }] },
        order_items: { columns: ['id', 'order_id'], rows: [{ id: 1, order_id: 1 }] },
      },
    });
    expect(statements[0]).toMatch(/DELETE FROM "order_items"/);
    expect(statements[1]).toMatch(/DELETE FROM "orders"/);
    expect(statements[2]).toMatch(/INSERT INTO "orders"/);
    expect(statements[3]).toMatch(/INSERT INTO "order_items"/);
  });

  /** `SELECT *` hands a generated column back like any other, and an INSERT that
   *  names one is refused outright. */
  it('never writes a column SQLite computes', () => {
    const [statement] = insertStatements({
      name: 'orders',
      columns: ['id', 'refunded_cents'],
      rows: [{ id: 1, refunded_cents: 500 }],
      skip: ['refunded_cents'],
    });
    expect(statement).toContain('"id"');
    expect(statement).not.toContain('refunded_cents');
  });

  // The expression itself has commas in it: `MIN(a, b + c)`. Splitting the
  // column list on all of them would read `b + c` as a column definition.
  it('finds a generated column declared with an expression that has commas', () => {
    const sql = 'CREATE TABLE orders (id INTEGER, a INTEGER, b INTEGER, r INTEGER GENERATED ALWAYS AS ( MIN(a, a + b) ) VIRTUAL)';
    expect([...generatedColumns(sql)]).toEqual(['r']);
  });

  it('is not fooled by a comma inside a default string', () => {
    const sql = "CREATE TABLE t (a TEXT DEFAULT 'x, y', b INTEGER GENERATED ALWAYS AS (1) VIRTUAL)";
    expect([...generatedColumns(sql)]).toEqual(['b']);
  });
});

describe('shopctl restore', () => {
  it('refuses without --env', () => {
    const target = seededShop({ object: false, seed: [] });
    const result = target.run(['restore', '--from', 'quelque-chose']);
    expect(result.status).toBe(EXIT_CODES.usage);
  });

  it('refuses without --from', () => {
    const target = seededShop({ object: false, seed: [] });
    const result = target.run(['restore', '--env', 'staging']);
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/--from/);
  });

  it('refuses a backup that does not exist', () => {
    const target = seededShop({ object: false, seed: [] });
    const result = target.run(['restore', '--env', 'staging', '--from', 'atelier-test-staging-20200101T000000Z']);
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/aucune sauvegarde/);
  });

  /**
   * The one mistake this command cannot take back.
   *
   * The manifest names its shop in the clear AND under the encryption, so an
   * archive cannot be relabelled into another shop's slug either.
   */
  it('refuses an archive that belongs to another shop', () => {
    const source = seededShop({ slug: 'autre-boutique' });
    const id = takeBackup(source);
    const target = seededShop();
    emptyTheShop(target);

    const result = target.run(['restore', '--env', 'staging', '--from', id, '--out', join(source.root, 'backups')]);
    expect(result.status).toBe(EXIT_CODES.input);
    expect(result.stderr).toMatch(/n'est pas de « atelier-test »|pas de « atelier-test »/);
    expect(target.query('SELECT COUNT(*) AS n FROM products')[0].n).toBe(0);
  });

  it('refuses to open an archive with the wrong key, before touching the database', () => {
    const source = seededShop();
    const id = takeBackup(source);
    const target = seededShop({ seed: [] });
    const before = target.read().calls.length;

    const result = target.run(['restore', '--env', 'staging', '--from', id, '--out', join(source.root, 'backups')]);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/n'est pas celle de cette archive/);
    expect(target.read().calls.length).toBe(before);
  });

  /**
   * A backup is the merchant's data and a restore is what puts it back. That
   * round trip — every table, the hostile text, the order and its line, the
   * object bytes — is the whole point of jalon 8's exit criterion.
   */
  describe('a full round trip', () => {
    it('puts every row back exactly as it was', () => {
      const target = seededShop();
      const before = contents(target);
      const id = takeBackup(target);
      emptyTheShop(target);
      expect(contents(target).products).toEqual([]);

      const { report, status } = target.json(['restore', '--env', 'staging', '--from', id]);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.differences).toEqual([]);
      expect(contents(target)).toEqual(before);
      expect(contents(target).products[0].description).toBe(HOSTILE);
    });

    it('puts the R2 objects back too', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const bucket = names('atelier-test', 'staging').images;
      target.wrangler(['r2', 'object', 'delete', `${bucket}/${IMAGE_KEY}`, '--remote', '-J', 'eu']);
      emptyTheShop(target);

      expect(target.json(['restore', '--env', 'staging', '--from', id]).status).toBe(EXIT_CODES.ok);
      const file = join(target.root, 'recovered.bin');
      const got = target.wrangler(['r2', 'object', 'get', `${bucket}/${IMAGE_KEY}`, '--file', file, '--remote', '-J', 'eu']);
      expect(got.status).toBe(0);
      expect(readFileSync(file)).toEqual(IMAGE_BYTES);
    });

    it('still restores an archive sealed before v0.3.32, objects included', () => {
      const target = seededShop();
      const id = takeBackup(target);
      asFormatOne(target, id);
      expect(target.json(['backup', 'verify', id]).report.failures).toBe(0);
      const bucket = names('atelier-test', 'staging').images;
      target.wrangler(['r2', 'object', 'delete', `${bucket}/${IMAGE_KEY}`, '--remote', '-J', 'eu']);
      emptyTheShop(target);

      const restored = target.json(['restore', '--env', 'staging', '--from', id]);
      expect(restored.status, restored.stderr).toBe(EXIT_CODES.ok);
      const file = join(target.root, 'recovered.bin');
      target.wrangler(['r2', 'object', 'get', `${bucket}/${IMAGE_KEY}`, '--file', file, '--remote', '-J', 'eu']);
      expect(readFileSync(file)).toEqual(IMAGE_BYTES);
    });

    /**
     * The search index is NOT in the archive: migration 0003's triggers rebuild
     * it from `products` as the rows go back in. This is the assertion that
     * makes leaving it out safe rather than merely smaller.
     */
    it('leaves the shop searchable, from an index no archive carried', () => {
      const target = seededShop();
      const id = takeBackup(target);
      emptyTheShop(target);
      target.run(['restore', '--env', 'staging', '--from', id]);

      expect(target.query("SELECT rowid FROM products_fts WHERE products_fts MATCH 'Lampe'")).toHaveLength(1);
    });

    // Twice in a row must land on the same database, or a rehearsal costs an
    // operator their nerve the second time they need one.
    it('is idempotent', () => {
      const target = seededShop();
      const id = takeBackup(target);
      emptyTheShop(target);
      target.run(['restore', '--env', 'staging', '--from', id]);
      const once = contents(target);

      const { status } = target.json(['restore', '--env', 'staging', '--from', id, '--overwrite']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(contents(target)).toEqual(once);
    });

    it('changes nothing under --dry-run', () => {
      const target = seededShop();
      const id = takeBackup(target);
      emptyTheShop(target);

      const { report, status } = target.json(['restore', '--env', 'staging', '--from', id, '--dry-run']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.statements).toBeGreaterThan(0);
      expect(contents(target).products).toEqual([]);
    });
  });

  /**
   * "Empty" means the SHOP has not written anything, not that the file has no
   * rows: the migrations seed the four French legal pages, so a database
   * provisioned five minutes ago already has some.
   */
  describe('the emptiness guard', () => {
    it('lets a freshly migrated environment through without --overwrite', () => {
      const target = seededShop();
      const id = takeBackup(target);
      emptyTheShop(target);
      expect(target.query('SELECT COUNT(*) AS n FROM pages')[0].n).toBeGreaterThan(0);

      expect(target.run(['restore', '--env', 'staging', '--from', id]).status).toBe(EXIT_CODES.ok);
    });

    it('stops on a database the shop has written to', () => {
      const target = seededShop();
      const id = takeBackup(target);

      const result = target.run(['restore', '--env', 'staging', '--from', id]);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/n'est pas vide/);
      expect(result.stderr).toMatch(/--overwrite/);
    });

    it('proceeds when the operator says so', () => {
      const target = seededShop();
      const id = takeBackup(target);
      target.sql(["UPDATE products SET name = 'Renommée après la sauvegarde';"]);

      expect(target.json(['restore', '--env', 'staging', '--from', id, '--overwrite']).status).toBe(EXIT_CODES.ok);
      expect(target.query('SELECT name FROM products')[0].name).toBe('Lampe');
    });
  });

  /**
   * Production is never reached by omission: the dedicated option the plan asks
   * for (§5.6), and the shop's slug typed out — the pause `destroy` buys, for
   * the same reason.
   */
  describe('restoring into production', () => {
    function productionShop() {
      const target = seededShop();
      expect(target.run(['provision', '--env', 'production']).status).toBe(EXIT_CODES.ok);
      return target;
    }

    it('demands the dedicated option', () => {
      const target = productionShop();
      const id = takeBackup(target);
      const result = target.run(['restore', '--env', 'production', '--from', id]);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/option dédiée/);
    });

    it('demands the shop’s slug typed out on top', () => {
      const target = productionShop();
      const id = takeBackup(target);
      const result = target.run(['restore', '--env', 'production', '--from', id, '--allow-production']);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/slug de la boutique, saisi/);
    });

    it('refuses a slug that names another shop', () => {
      const target = productionShop();
      const id = takeBackup(target);
      const result = target.run(['restore', '--env', 'production', '--from', id, '--allow-production', '--confirm', 'pas-cette-boutique']);
      expect(result.status).toBe(EXIT_CODES.precondition);
    });

    it('restores into the environment it was told, and only that one', () => {
      const target = productionShop();
      const id = takeBackup(target);
      const staging = contents(target);
      emptyTheShop(target);

      const { status } = target.json(['restore', '--env', 'production', '--from', id, '--allow-production', '--confirm', 'atelier-test']);
      expect(status).toBe(EXIT_CODES.ok);

      // Rendering the configuration back to staging is what proves the write
      // went to the OTHER database: staging is still the empty one.
      target.run(['provision', '--env', 'staging']);
      expect(contents(target).products).toEqual([]);
      target.run(['provision', '--env', 'production']);
      expect(contents(target).products).toEqual(staging.products);
    });

    // Provisioning switches the demo checkout off in a production nobody has
    // installed (certification step 9). That row is the tooling's, like the
    // migrations' seeds: the target is still empty, and the archive's
    // settings replace it.
    it('reads a production provisioning just wrote into as empty, and replaces its row', () => {
      const target = productionShop();
      expect(target.query("SELECT value FROM settings WHERE key = 'payment_methods_disabled'")).toEqual([{ value: 'demo' }]);
      target.run(['provision', '--env', 'staging']);
      const id = takeBackup(target);
      target.run(['provision', '--env', 'production']);

      const { status } = target.json(['restore', '--env', 'production', '--from', id, '--allow-production', '--confirm', 'atelier-test']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(target.query("SELECT value FROM settings WHERE key = 'payment_methods_disabled'")).toEqual([]);
    });

    // Certification step 8, served after the restore: the vault came along, the
    // KEK did not, and Turnstile with an unreadable secret refuses every admin
    // login. The restore cannot open the keys either; it can say so, and name
    // the one command that gives the admin back.
    it('says which vault keys will not open, and how to get past Turnstile', () => {
      const target = seededShop();
      target.sql([
        "INSERT INTO settings (key, value) VALUES ('enc:stripe_secret_key', 'gcm$c2FsdA$aXY$Y2lwaGVy');",
        "INSERT INTO settings (key, value) VALUES ('enc:turnstile_secret_key', 'gcm$c2FsdA$aXY$Y2lwaGVy');",
        "INSERT INTO settings (key, value) VALUES ('turnstile_enabled', '1');",
      ]);
      const id = takeBackup(target);
      expect(target.run(['provision', '--env', 'production']).status).toBe(EXIT_CODES.ok);

      const result = target.json(['restore', '--env', 'production', '--from', id, '--allow-production', '--confirm', 'atelier-test']);
      expect(result.status).toBe(EXIT_CODES.ok);
      expect(result.report.vault).toEqual({ keys: ['stripe_secret_key', 'turnstile_secret_key'], turnstile: true, readable: false });
      expect(result.stderr).toMatch(/ne s'ouvrent pas ici : stripe_secret_key, turnstile_secret_key/);
      expect(result.stderr).toContain(
        `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT.id} npx wrangler d1 execute ${names('atelier-test', 'production').database} --remote --command "DELETE FROM settings WHERE key = 'turnstile_enabled'"`,
      );
    });

    it('stays quiet about the vault when the archive goes back where it came from', () => {
      const target = seededShop();
      target.sql(["INSERT INTO settings (key, value) VALUES ('enc:stripe_secret_key', 'gcm$c2FsdA$aXY$Y2lwaGVy');"]);
      const id = takeBackup(target);
      emptyTheShop(target);

      const result = target.json(['restore', '--env', 'staging', '--from', id]);
      expect(result.status).toBe(EXIT_CODES.ok);
      expect(result.report.vault).toEqual({ keys: ['stripe_secret_key'], turnstile: false, readable: null });
      expect(result.stderr).not.toMatch(/Coffre/);
    });

    // Certification step 8: a staging archive restored into a production. The
    // bytes belong in the production's bucket; the archive only says where they
    // were taken from, and on the client's account that bucket does not exist.
    it('puts the objects into the target environment\'s buckets, not the source\'s', () => {
      const target = productionShop();
      const id = takeBackup(target);
      const staging = names('atelier-test', 'staging').images;
      const production = names('atelier-test', 'production').images;
      target.wrangler(['r2', 'object', 'delete', `${staging}/${IMAGE_KEY}`, '--remote', '-J', 'eu']);

      const { status, report } = target.json(['restore', '--env', 'production', '--from', id, '--allow-production', '--confirm', 'atelier-test']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.objects).toBe(1);
      const file = join(target.root, 'in-production.bin');
      expect(target.wrangler(['r2', 'object', 'get', `${production}/${IMAGE_KEY}`, '--file', file, '--remote', '-J', 'eu']).status).toBe(0);
      expect(readFileSync(file)).toEqual(IMAGE_BYTES);
      expect(target.wrangler(['r2', 'object', 'get', `${staging}/${IMAGE_KEY}`, '--file', join(target.root, 'in-staging.bin'), '--remote', '-J', 'eu']).status).not.toBe(0);
    });
  });

  /**
   * The nightly proof (plan §7.3): last night's archive, restored on a runner
   * that is thrown away afterwards. No account, no second set of databases —
   * and the same table-by-table comparison as a real restore.
   */
  describe('into the tree\'s local D1', () => {
    const local = (target, sql) => {
      const result = target.wrangler(['d1', 'execute', 'DB', '--local', '--json', '--command', sql]);
      return JSON.parse(result.stdout)[0].results;
    };

    it('restores and proves it without asking the account anything', () => {
      const target = seededShop();
      const before = contents(target);
      const id = takeBackup(target);
      const calls = target.read().calls.length;

      const { report, status } = target.json(['restore', '--env', 'staging', '--from', id, '--local']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.local).toBe(true);
      expect(report.account).toBeNull();
      expect(report.differences).toEqual([]);

      const made = target.read().calls.slice(calls).map((call) => call.argv);
      expect(made.some((argv) => ['whoami', 'list'].some((word) => argv.includes(word)))).toBe(false);
      expect(made.filter((argv) => argv[0] === 'd1' || argv[0] === 'r2').every((argv) => argv.includes('--local'))).toBe(true);

      expect(local(target, 'SELECT slug, name, description, price_cents, image_key FROM products ORDER BY id')).toEqual(before.products);
      // The remote database is the one the archive came from, and untouched.
      expect(contents(target)).toEqual(before);
    });

    it('refuses a production archive: a runner is not where buyers\' data goes', () => {
      const target = seededShop({ env: 'production' });
      const { report } = target.json(['backup', '--env', 'production']);
      const result = target.run(['restore', '--env', 'staging', '--from', report.id, '--local']);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/archive de production ne se restaure pas en local/);
    });
  });

  describe('what a restore refuses to guess', () => {
    it('stops when the archive carries no object bytes, unless told to accept it', () => {
      const target = seededShop();
      const id = takeBackup(target, ['--no-media']);
      emptyTheShop(target);

      const refused = target.run(['restore', '--env', 'staging', '--from', id]);
      expect(refused.status).toBe(EXIT_CODES.precondition);
      expect(refused.stderr).toMatch(/les images seront cassées/);

      expect(target.run(['restore', '--env', 'staging', '--from', id, '--allow-missing-media']).status).toBe(EXIT_CODES.ok);
    });

    /**
     * An archive taken on a newer schema than the tree carries has rows with
     * columns the target's tables do not: the failure would otherwise land
     * halfway through the insert.
     */
    it('stops when the archive fills a table the target does not have', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const file = join(target.root, 'backups', id, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.tables.push({ name: 'table_dun_socle_plus_recent', rows: 2, columns: ['id'], digest: 'x' });
      writeFileSync(file, JSON.stringify(manifest, null, 2));
      emptyTheShop(target);

      const result = target.run(['restore', '--env', 'staging', '--from', id]);
      // The edited header no longer authenticates the body, which is the first
      // thing that notices — and the message says so rather than blaming the
      // schema for a manifest someone changed.
      expect(result.status).toBe(EXIT_CODES.verification);
      expect(result.stderr).toMatch(/ne s'ouvre pas/);
    });

    it('stops when the environment has not been provisioned', () => {
      const source = seededShop();
      const id = takeBackup(source);
      const result = source.run(['restore', '--env', 'production', '--from', id, '--allow-production', '--confirm', 'atelier-test']);
      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/ressource\(s\) manquante\(s\)/);
    });
  });
});
