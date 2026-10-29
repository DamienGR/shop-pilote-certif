import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// .mjs like its neighbours: tsconfig pins `types` to the Cloudflare types, so
// node builtins have no declarations in a .ts file here.
import { EXIT_CODES } from '../../shopctl/src/errors.mjs';
import { canonical } from '../../shopctl/src/backup/dump.mjs';
import { classifyTables, objectInventory, orderTables, references, seededTables } from '../../shopctl/src/backup/schema.mjs';
import { planPrune } from '../../shopctl/src/backup/archive.mjs';
import { nextIndex, reusable, reuseWindow } from '../../shopctl/src/backup/pool.mjs';
import { parseLifecycleRules } from '../../shopctl/src/cloudflare.mjs';
import { HOSTILE, IMAGE_KEY, names, seededShop, takeBackup } from '../helpers/backup-shop.mjs';

const CORE = new URL('../../', import.meta.url).pathname;

const archive = (target, id) => JSON.parse(readFileSync(join(target.root, 'backups', id, 'manifest.json'), 'utf8'));

vi.setConfig({ testTimeout: 60_000 });

describe('the backup pipeline', () => {
  /**
   * The list of tables is DERIVED. A written list stops being complete at the
   * first migration nobody thought to update it for, and the table missing from
   * the list is the table missing from the archive — silently, until a restore.
   */
  describe('table selection', () => {
    it('takes ordinary tables and leaves the platform’s own', () => {
      const { tables, skipped } = classifyTables([
        { type: 'table', name: 'orders', sql: 'CREATE TABLE orders (id INTEGER)' },
        { type: 'table', name: 'sqlite_sequence', sql: null },
        { type: 'table', name: '_cf_KV', sql: 'CREATE TABLE _cf_KV (k)' },
        { type: 'table', name: 'd1_migrations', sql: 'CREATE TABLE d1_migrations (id)' },
        { type: 'index', name: 'idx_orders', sql: 'CREATE INDEX idx_orders ON orders(id)' },
      ]);
      expect(tables.map((table) => table.name)).toEqual(['orders']);
      expect(skipped.map((entry) => entry.reason).sort()).toEqual(['cloudflare', 'migrations', 'sqlite']);
    });

    /**
     * An FTS5 index is not data: migration 0003's triggers rebuild it from
     * `products` as the rows go back in. Carrying it would double the archive to
     * store something the data determines, and restoring it would fight the
     * triggers for the right to write it.
     */
    it('leaves a virtual table and every shadow table behind it', () => {
      const { virtual, skipped } = classifyTables([
        { type: 'table', name: 'products_fts', sql: "CREATE VIRTUAL TABLE products_fts USING fts5(name, content='products')" },
        { type: 'table', name: 'products_fts_data', sql: 'CREATE TABLE products_fts_data(id, block)' },
        { type: 'table', name: 'products_fts_docsize', sql: 'CREATE TABLE products_fts_docsize(id, sz)' },
        { type: 'table', name: 'products', sql: 'CREATE TABLE products (id INTEGER)' },
      ]);
      expect(virtual).toEqual(['products_fts']);
      expect(skipped.map((entry) => entry.name)).toEqual(['products_fts', 'products_fts_data', 'products_fts_docsize']);
    });

    // Read off the real schema rather than a fixture of it: the point of the
    // derivation is that it keeps up with the migrations directory.
    it('reads every spelling of REFERENCES the schema uses', () => {
      expect([...references('CREATE TABLE t (a REFERENCES orders(id), b REFERENCES "products" (id), c REFERENCES `media`(id))')].sort())
        .toEqual(['media', 'orders', 'products']);
    });
  });

  /**
   * Rows go back in an order no foreign key ever dangles in. Deferring the
   * constraint would paper over an ordering mistake; ordering the statements
   * means the mistake cannot be made.
   */
  describe('insert order', () => {
    it('puts a table after everything it points at', () => {
      const { order, cycle } = orderTables([
        { name: 'order_items', sql: 'CREATE TABLE order_items (o REFERENCES orders(id), p REFERENCES products(id))' },
        { name: 'orders', sql: 'CREATE TABLE orders (id)' },
        { name: 'products', sql: 'CREATE TABLE products (m REFERENCES media(id))' },
        { name: 'media', sql: 'CREATE TABLE media (id)' },
      ]);
      expect(cycle).toEqual([]);
      expect(order.indexOf('media')).toBeLessThan(order.indexOf('products'));
      expect(order.indexOf('products')).toBeLessThan(order.indexOf('order_items'));
      expect(order.indexOf('orders')).toBeLessThan(order.indexOf('order_items'));
    });

    // A category's parent is one row pointing at another row of the same table.
    // There is no order between two tables to find, and treating it as one would
    // report a cycle on a schema that has none.
    it('ignores a self-reference', () => {
      expect(orderTables([{ name: 'categories', sql: 'CREATE TABLE categories (parent REFERENCES categories(id))' }]).cycle).toEqual([]);
    });

    // SQLite allows a cycle, this schema has none, and a restore that quietly
    // picked a starting point would fail on some databases and not others.
    it('reports a cycle rather than guessing at it', () => {
      const { cycle } = orderTables([
        { name: 'a', sql: 'CREATE TABLE a (x REFERENCES b(id))' },
        { name: 'b', sql: 'CREATE TABLE b (x REFERENCES a(id))' },
      ]);
      expect(cycle).toEqual(['a', 'b']);
    });

    it('orders the repository’s own schema without a cycle', () => {
      const sql = readdirSync(join(CORE, 'migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => readFileSync(join(CORE, 'migrations', name), 'utf8'))
        .join('\n');
      const tables = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([A-Za-z_][A-Za-z0-9_]*)\s*\(([^;]*)\)\s*;/g)]
        .map((match) => ({ name: match[1], sql: match[0] }));
      expect(tables.length).toBeGreaterThan(15);
      expect(orderTables(tables).cycle).toEqual([]);
    });
  });

  /**
   * A freshly migrated database is NOT empty — 0040 writes the four French legal
   * pages — so the restore's emptiness guard has to know which tables the schema
   * fills. Derived from the migrations, so a seed added tomorrow is covered.
   */
  it('knows which tables the migrations themselves fill', () => {
    const texts = readdirSync(join(CORE, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(CORE, 'migrations', name), 'utf8'));
    expect(seededTables(texts)).toContain('pages');
    expect(seededTables(texts)).not.toContain('orders');
  });

  /** The inventory comes from the ROWS: `media` owns a stored image (invariant
   *  10), and a private deliverable is named by the product that sells it. */
  describe('the R2 inventory', () => {
    const dump = {
      media: { columns: ['image_key'], rows: [{ image_key: 'media/a.jpg' }, { image_key: 'media/b.jpg' }] },
      products: { columns: ['image_key', 'file_key'], rows: [{ image_key: 'media/a.jpg', file_key: 'files/manual.pdf' }] },
      product_images: { columns: ['image_key'], rows: [{ image_key: 'media/orpheline.jpg' }] },
      order_items: { columns: ['file_key'], rows: [{ file_key: 'files/manual.pdf' }] },
      page_media: { columns: ['page_id', 'media_id'], rows: [{ page_id: 1, media_id: 1 }] },
    };

    it('names every image the media table owns, once', () => {
      expect(objectInventory(dump).images).toEqual(['media/a.jpg', 'media/b.jpg']);
      expect(objectInventory(dump).files).toEqual(['files/manual.pdf']);
    });

    // Reported rather than repaired: a key with no media row behind it is an
    // image the merchant already sees broken, and a backup is a good moment to
    // learn about it.
    it('reports a key nothing owns rather than inventing a row for it', () => {
      expect(objectInventory(dump).orphans).toEqual(['media/orpheline.jpg']);
    });
  });

  /** Two dumps of unchanged rows must produce the same bytes, or verification
   *  cries wolf and people stop running it. */
  describe('the digest', () => {
    it('does not depend on the order the driver hands keys back in', () => {
      expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    });

    it('does depend on the values', () => {
      expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
    });
  });

  /**
   * Retention is bounded, and both bounds have to agree. A shop that stopped
   * being backed up for a month must not have its last archive expired by an
   * age rule: the archive being old is the reason to keep it.
   */
  describe('retention', () => {
    const at = (iso) => ({ id: iso, path: `/tmp/${iso}`, broken: null, manifest: { createdAt: iso } });
    const now = new Date('2026-09-02T00:00:00.000Z');
    const entries = ['2026-01-01T00:00:00.000Z', '2026-08-25T00:00:00.000Z', '2026-09-01T00:00:00.000Z'].map(at);

    it('drops only what BOTH bounds condemn', () => {
      expect(planPrune(entries, { keep: 2, keepDays: 30, now }).remove.map((entry) => entry.id)).toEqual(['2026-01-01T00:00:00.000Z']);
    });

    it('keeps the last one however old it is', () => {
      const stale = [at('2020-01-01T00:00:00.000Z')];
      expect(planPrune(stale, { keep: 30, keepDays: 30, now }).remove).toEqual([]);
    });

    // An interrupted `backup` leaves a directory with no manifest. It protects
    // nothing and is the one thing a prune can drop on its own.
    it('drops an incomplete directory', () => {
      const plan = planPrune([...entries, { id: 'interrompue', path: '/tmp/x', broken: 'manifeste absent', manifest: null }], { keep: 30, keepDays: 365, now });
      expect(plan.remove.map((entry) => entry.reason)).toEqual(['incomplète']);
    });
  });

  /**
   * A pooled copy may be reused only while it outlives an archive taken now,
   * and that is read off the rules the bucket HAS, never assumed (ADR 0019).
   */
  describe('the media pool', () => {
    const rule = (prefix, days, enabled = true) => ({ name: 'r', enabled, prefix, days });
    const prefix = 'atelier-test-production-';

    it('reuses a copy for 83 days under the rules provision writes', () => {
      expect(reuseWindow([rule(prefix, 90), rule('pool/', 180)], prefix)).toBe(83);
    });

    it('reuses nothing under the bucket-wide rule of v0.3.31, or rules it cannot read', () => {
      expect(reuseWindow([rule('', 90)], prefix)).toBeLessThanOrEqual(0);
      expect(reuseWindow(null, prefix)).toBe(0);
    });

    it('reuses nothing when the archives never expire and the pool does', () => {
      expect(reuseWindow([rule('pool/', 180)], prefix)).toBe(-Infinity);
      expect(reuseWindow([rule(prefix, 90, false), rule('pool/', 180)], prefix)).toBe(-Infinity);
    });

    it('reuses forever a pool nothing expires', () => {
      expect(reuseWindow([rule(prefix, 90)], prefix)).toBe(Infinity);
    });

    it('drops from the index what has aged out of the window', () => {
      const now = new Date('2026-10-28T00:00:00.000Z');
      const entry = (key, storedAt) => ({ source: 'images', key, file: `pool/${key}.bin`, storedAt });
      const previous = [entry('vieux', '2026-07-01T00:00:00.000Z'), entry('jeune', '2026-10-01T00:00:00.000Z')];
      expect([...reusable(previous, 83, now).keys()]).toEqual(['images\njeune']);
      const next = nextIndex({ previous, state: 'ok', fresh: [entry('vieux', now.toISOString())], windowDays: 83, now });
      expect(next.entries.map((candidate) => [candidate.key, candidate.storedAt])).toEqual([
        ['jeune', '2026-10-01T00:00:00.000Z'],
        ['vieux', now.toISOString()],
      ]);
      expect(nextIndex({ previous: [previous[1]], state: 'ok', fresh: [], windowDays: 83, now }).changed).toBe(false);
    });

    it('reads wrangler’s listing, which has no --json', () => {
      const listing = [
        "Listing lifecycle rules for bucket 'minshop-atelier-test-production-backups'...",
        'name:     shopctl-retention',
        'enabled:  Yes',
        `prefix:   ${prefix}`,
        'action:   Expire objects after 90 days',
        '',
        'name:     shopctl-pool',
        'enabled:  No',
        'prefix:   (all prefixes)',
        'action:   Expire objects after 180 days, Abort incomplete multipart uploads after 7 days',
      ].join('\n');
      expect(parseLifecycleRules(listing)).toEqual([
        { name: 'shopctl-retention', enabled: true, prefix, days: 90 },
        { name: 'shopctl-pool', enabled: false, prefix: '', days: 180 },
      ]);
    });
  });
});

describe('shopctl backup', () => {
  it('refuses to take one without --env', () => {
    const target = seededShop({ object: false, seed: [] });
    const result = target.run(['backup']);
    expect(result.status).toBe(EXIT_CODES.usage);
    expect(result.stderr).toMatch(/--env est obligatoire/);
  });

  /**
   * The key comes FIRST, before a row is read. A run that reads the whole
   * database and then discovers it has nowhere safe to put it has already put it
   * somewhere: in this process's memory, and in whatever the operator does next.
   */
  it('refuses to read anything without a key', () => {
    const target = seededShop();
    const before = target.read().calls.length;
    const result = target.run(['backup', '--env', 'staging', '--key-file', 'absente.key']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(result.stderr).toMatch(/absente\.key n'existe pas/);
    expect(target.read().calls.length).toBe(before);
  });

  it('writes a key nobody else can read, and never prints it', () => {
    const target = seededShop({ object: false, seed: [] });
    const result = target.run(['backup', 'keygen', '--key-file', '.shopctl/second.key']);
    expect(result.status).toBe(EXIT_CODES.ok);
    const key = readFileSync(join(target.root, '.shopctl/second.key'), 'utf8').trim();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(result.stdout).not.toContain(key);
  });

  // The key that is there is the only thing that opens the archives taken with
  // it; "regenerate" would destroy them silently.
  it('never overwrites an existing key', () => {
    const target = seededShop({ object: false, seed: [] });
    const before = readFileSync(join(target.root, '.shopctl/backup.key'), 'utf8');
    const result = target.run(['backup', 'keygen']);
    expect(result.status).toBe(EXIT_CODES.precondition);
    expect(readFileSync(join(target.root, '.shopctl/backup.key'), 'utf8')).toBe(before);
  });

  describe('an archive', () => {
    it('records every table of the real schema, and no index', () => {
      const target = seededShop();
      const manifest = archive(target, takeBackup(target));

      expect(manifest.tables.map((table) => table.name)).toContain('orders');
      expect(manifest.tables.map((table) => table.name)).toContain('settings');
      expect(manifest.tables.map((table) => table.name)).not.toContain('products_fts');
      expect(manifest.tables.map((table) => table.name)).not.toContain('d1_migrations');
      expect(manifest.schema.version).toMatch(/^\d{4}_/);
      expect(manifest.schema.migrations.length).toBeGreaterThan(40);
    });

    /** A backup is every order and every address the shop has taken. It is the
     *  one copy that leaves the account, and it has to be worth nothing to
     *  whoever finds it. */
    it('leaves no customer data in cleartext anywhere in the directory', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const directory = join(target.root, 'backups', id);
      const files = readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath ?? entry.path, entry.name)));

      for (const bytes of files) {
        expect(bytes.includes(Buffer.from('client@example.fr'))).toBe(false);
        expect(bytes.includes(Buffer.from('Atelier témoin'))).toBe(false);
      }
    });

    // The counts, the schema version and the inventory are in the clear so a
    // listing does not have to decrypt a hundred archives to find one — which is
    // exactly what makes them worth altering, and why they are the GCM
    // additional data.
    it('cannot be re-labelled: an edited header stops opening', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const file = join(target.root, 'backups', id, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.env = 'production';
      writeFileSync(file, JSON.stringify(manifest, null, 2));

      const result = target.run(['backup', 'verify', id]);
      expect(result.status).toBe(EXIT_CODES.verification);
      expect(result.stdout).toMatch(/le corps ne s'ouvre pas/);
    });

    it('carries the object bytes its rows reference', () => {
      const target = seededShop();
      const manifest = archive(target, takeBackup(target));
      const images = manifest.r2.buckets.find((bucket) => bucket.binding === 'BUCKET');

      expect(images.inventory.map((object) => object.key)).toEqual([IMAGE_KEY]);
      expect(images.stored).toBe(true);
      expect(existsSync(join(target.root, 'backups', manifest.id, images.inventory[0].file))).toBe(true);
    });

    it('takes the inventory alone when asked, and says what that costs', () => {
      const target = seededShop();
      const result = target.run(['backup', '--env', 'staging', '--no-media']);
      expect(result.status).toBe(EXIT_CODES.ok);
      expect(result.stdout).toMatch(/n'aura pas les images/);

      const [id] = readdirSync(join(target.root, 'backups'));
      const manifest = archive(target, id);
      expect(manifest.r2.buckets.every((bucket) => bucket.stored === false)).toBe(true);
      expect(manifest.r2.buckets[0].inventory[0].key).toBe(IMAGE_KEY);
    });

    it('writes nothing under --dry-run', () => {
      const target = seededShop();
      const { report, status } = target.json(['backup', '--env', 'staging', '--dry-run']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.dryRun).toBe(true);
      expect(existsSync(join(target.root, 'backups'))).toBe(false);
    });

    // The hostile description is the one a naive SQL writer breaks on, and it
    // has to survive being read, canonicalised, compressed, encrypted and
    // digested.
    it('holds the merchant’s text exactly, apostrophes and semicolons included', () => {
      const target = seededShop();
      const manifest = archive(target, takeBackup(target));
      const products = manifest.tables.find((table) => table.name === 'products');
      expect(products.rows).toBe(1);
      expect(target.query('SELECT description FROM products')[0].description).toBe(HOSTILE);
    });
  });

  describe('list', () => {
    it('names each archive with what a reader needs before opening it', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const { report, status } = target.json(['backup', 'list']);

      expect(status).toBe(EXIT_CODES.ok);
      expect(report.backups).toHaveLength(1);
      expect(report.backups[0]).toMatchObject({ id, env: 'staging', broken: null, media: true });
      expect(report.backups[0].rows).toBeGreaterThan(0);
    });

    // An interrupted `backup` leaves exactly this. A listing that hid it would
    // leave the operator with a directory taking up space that nothing admits to.
    it('shows an incomplete directory rather than hiding it', () => {
      const target = seededShop();
      takeBackup(target);
      mkdirSync(join(target.root, 'backups', 'atelier-test-staging-20200101T000000Z'), { recursive: true });

      const { report } = target.json(['backup', 'list']);
      expect(report.backups.some((entry) => entry.broken)).toBe(true);
    });
  });

  describe('verify', () => {
    it('passes a sound archive and says what it opened', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const { report, status } = target.json(['backup', 'verify', id]);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.checks.some((check) => check.level === 'contenu' && check.name === 'ouverture')).toBe(true);
      expect(report.failures).toBe(0);
    });

    it('catches a truncated body without needing the key', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const body = join(target.root, 'backups', id, 'data.bin');
      writeFileSync(body, readFileSync(body).subarray(0, 40));

      const result = target.json(['backup', 'verify', id], { SHOPCTL_BACKUP_KEY: '' });
      expect(result.status).toBe(EXIT_CODES.verification);
      expect(result.report.checks.filter((check) => !check.ok).map((check) => check.name)).toContain('taille du corps');
    });

    /**
     * A key that is absent and a key that belongs to another archive are the
     * same situation: the body stays closed, and neither is evidence the
     * archive is bad. Both are said loudly and both leave the exit code at ok —
     * but "we could not open it" must never render as a clean pass, which is
     * what `opened` in the report is for.
     */
    it('says the content was not checked when the key is not this archive’s', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const other = seededShop({ object: false, seed: [] });
      const result = other.json(['backup', 'verify', id, '--out', join(target.root, 'backups')]);

      expect(result.status).toBe(EXIT_CODES.ok);
      expect(result.report.opened).toBe(false);
      expect(result.stderr).toMatch(/n'est pas celle de cette archive/);
    });

    it('refuses an identifier that is not one', () => {
      const target = seededShop({ object: false, seed: [] });
      const result = target.run(['backup', 'verify', '../../etc/passwd']);
      expect(result.status).toBe(EXIT_CODES.input);
    });
  });

  /**
   * The copy that outlives the machine. A CI runner is gone ten minutes after
   * the backup it took, so the nightly run and the pre-deploy backup put the
   * archive in the environment's own private bucket — and `pull` is the way
   * back from it, checked exactly as a local archive is.
   */
  describe('the backups bucket', () => {
    const remote = (target, bucket) => target.read().r2.find((entry) => entry.name === bucket);
    const putsInto = (target, bucket, since) =>
      target.read().calls.slice(since)
        .map(({ argv }) => argv.join(' '))
        .filter((call) => call.startsWith(`r2 object put ${bucket}/`));

    it('receives the archive as it was sealed, manifest last', () => {
      const target = seededShop();
      const expected = names(target.slug, 'staging');
      const before = target.read().calls.length;
      const { report, status } = target.json(['backup', '--env', 'staging', '--upload']);

      expect(status).toBe(EXIT_CODES.ok);
      expect(report.uploaded).toEqual({
        bucket: expected.backups,
        prefix: `${report.id}/`,
        files: 2,
        objects: { written: 1, pooled: 1, reused: 0 },
        index: true,
      });
      // The object into the pool, the body, the index, the manifest.
      expect(remote(target, expected.backups).objects).toBe(4);
      const puts = putsInto(target, expected.backups, before);
      expect(puts).toHaveLength(4);
      expect(puts[0]).toMatch(new RegExp(`^r2 object put ${expected.backups}/pool/[0-9a-f]{32}\\.bin `));
      expect(puts.at(-2)).toContain(`${expected.backups}/pool/index.json`);
      expect(puts.at(-1)).toContain(`${report.id}/manifest.json`);
      expect(puts.every((call) => call.includes('-J eu'))).toBe(true);
    });

    /**
     * ADR 0019: on the shared account a backup is two API calls per object,
     * twice a day, for objects that never change. The pool takes each one
     * once; a second backup of an unchanged shop reads none from the shop's
     * buckets and writes none into its backups bucket.
     */
    it('reads and writes no media the second time an unchanged shop is backed up', () => {
      const target = seededShop();
      const expected = names(target.slug, 'staging');
      const first = target.json(['backup', '--env', 'staging', '--upload']).report;
      const before = target.read().calls.length;
      const { report, status } = target.json(['backup', '--env', 'staging', '--upload']);

      expect(status).toBe(EXIT_CODES.ok);
      expect(report.id).not.toBe(first.id);
      expect(report.media).toEqual({ read: 0, reused: 1 });
      expect(report.uploaded).toMatchObject({ objects: { written: 0, pooled: 0, reused: 1 }, index: false });
      const calls = target.read().calls.slice(before).map(({ argv }) => argv.join(' '));
      expect(calls.filter((call) => call.startsWith(`r2 object get ${expected.images}/`))).toEqual([]);
      expect(putsInto(target, expected.backups, before).map((call) => call.split(' ')[3])).toEqual([
        `${expected.backups}/${report.id}/data.bin`,
        `${expected.backups}/${report.id}/manifest.json`,
      ]);

      // Both archives name the same sealed copy.
      const images = (id) => archive(target, id).r2.buckets.find((bucket) => bucket.binding === 'BUCKET').inventory[0];
      expect(images(report.id).pool).toBe(images(first.id).pool);
      expect(images(report.id).cipher).toEqual(images(first.id).cipher);
    });

    // A copy is reused only while it outlives an archive taken now. On a bucket
    // still under the single bucket-wide rule, the pool would expire with the
    // archive that wrote it and before the ones reusing it: nothing is reused,
    // and every archive carries its objects under its own prefix, as before.
    it('reuses nothing on a bucket whose rules would let the pool expire first', () => {
      const target = seededShop();
      const expected = names(target.slug, 'staging');
      target.account({
        r2: target.read().r2.map((bucket) => (bucket.name === expected.backups ? { ...bucket, lifecycle: [{ name: 'shopctl-retention', days: 90 }] } : bucket)),
      });
      target.json(['backup', '--env', 'staging', '--upload']);
      const before = target.read().calls.length;
      const { report, stderr } = target.json(['backup', '--env', 'staging', '--upload']);

      expect(report.media).toEqual({ read: 1, reused: 0 });
      expect(stderr).toMatch(/shopctl provision --env staging/);
      const puts = putsInto(target, expected.backups, before).map((call) => call.split(' ')[3]);
      expect(puts).toHaveLength(3);
      expect(puts.every((path) => path.startsWith(`${expected.backups}/${report.id}/`))).toBe(true);
      expect(archive(target, report.id).r2.buckets[0].inventory[0].pool).toBeNull();

      // And it comes back from there, as every archive before v0.3.32 does.
      rmSync(join(target.root, 'backups'), { recursive: true });
      const pulled = target.json(['backup', 'pull', report.id, '--env', 'staging']);
      expect(pulled.status, pulled.stderr).toBe(EXIT_CODES.ok);
      expect(target.json(['backup', 'verify', report.id]).report.failures).toBe(0);
    });

    // The index flows into manifests that are themselves authenticated: an
    // edited one would make archives that stop opening only at restore time.
    // Sealed with the backup key, an edit stops the INDEX opening, at once.
    it('starts a fresh pool rather than trusting an index that does not open', () => {
      const target = seededShop();
      const expected = names(target.slug, 'staging');
      target.json(['backup', '--env', 'staging', '--upload']);
      const indexFile = join(dirname(target.statePath), 'r2', expected.backups, `${Buffer.from('pool/index.json', 'utf8').toString('hex')}.bin`);
      const index = JSON.parse(readFileSync(indexFile, 'utf8'));
      writeFileSync(indexFile, JSON.stringify({ ...index, tag: Buffer.alloc(16).toString('base64') }));

      const { report, stderr } = target.json(['backup', '--env', 'staging', '--upload']);
      expect(stderr).toMatch(/l'index du pool ne s'ouvre pas/);
      expect(report.media).toEqual({ read: 1, reused: 0 });
      expect(report.uploaded.index).toBe(true);
      expect(target.json(['backup', '--env', 'staging', '--upload']).report.media).toEqual({ read: 0, reused: 1 });
    });

    it('refuses before reading a row when the bucket is not there', () => {
      const target = seededShop();
      const expected = names(target.slug, 'staging');
      target.account({ r2: target.read().r2.filter((bucket) => bucket.name !== expected.backups) });
      const result = target.run(['backup', '--env', 'staging', '--upload']);

      expect(result.status).toBe(EXIT_CODES.precondition);
      expect(result.stderr).toMatch(/-backups n'existe pas/);
      expect(existsSync(join(target.root, 'backups'))).toBe(false);
    });

    it('gives an archive back that verifies and restores', () => {
      const target = seededShop();
      const { report } = target.json(['backup', '--env', 'staging', '--upload']);
      rmSync(join(target.root, 'backups'), { recursive: true });

      const pulled = target.json(['backup', 'pull', report.id, '--env', 'staging']);
      expect(pulled.status, pulled.stderr).toBe(EXIT_CODES.ok);
      expect(pulled.report.checks.every((check) => check.ok)).toBe(true);
      expect(target.json(['backup', 'verify', report.id]).report.failures).toBe(0);
      expect(target.run(['restore', '--env', 'staging', '--from', report.id, '--overwrite', '--dry-run']).status).toBe(EXIT_CODES.ok);
    });

    /**
     * An archive taken with --upload carries only what the pool did not have.
     * It says so, `verify` says which level it reached, a restore refuses
     * before writing a row, and `pull` completes it — the nightly drill's path.
     */
    it('leaves pooled objects in the bucket until a pull completes the copy', () => {
      const target = seededShop();
      const expected = names(target.slug, 'staging');
      target.json(['backup', '--env', 'staging', '--upload']);
      const { report } = target.json(['backup', '--env', 'staging', '--upload']);
      const object = archive(target, report.id).r2.buckets[0].inventory[0];
      expect(existsSync(join(target.root, 'backups', report.id, object.file))).toBe(false);

      expect(target.json(['backup', 'list']).report.backups.find((entry) => entry.id === report.id).pooled).toBe(1);
      const verified = target.json(['backup', 'verify', report.id]);
      expect(verified.status).toBe(EXIT_CODES.ok);
      expect(verified.report.checks.find((check) => check.name === 'objets du bucket de sauvegarde').detail).toMatch(/^1 objet/);

      const refused = target.run(['restore', '--env', 'staging', '--from', report.id, '--overwrite']);
      expect(refused.status).toBe(EXIT_CODES.precondition);
      expect(refused.stderr).toMatch(new RegExp(`backup pull ${report.id} --env staging`));

      const before = target.read().calls.length;
      const pulled = target.json(['backup', 'pull', report.id, '--env', 'staging']);
      expect(pulled.status, pulled.stderr).toBe(EXIT_CODES.ok);
      expect(pulled.report.fetched).toBe(1);
      const gets = target.read().calls.slice(before).map(({ argv }) => argv.join(' ')).filter((call) => call.startsWith('r2 object get'));
      expect(gets).toEqual([expect.stringContaining(`${expected.backups}/${object.pool}`)]);
      expect(target.json(['backup', 'verify', report.id]).report.checks.some((check) => check.name === 'objets du bucket de sauvegarde')).toBe(false);

      const restored = target.json(['restore', '--env', 'staging', '--from', report.id, '--overwrite']);
      expect(restored.status, restored.stderr).toBe(EXIT_CODES.ok);
    });

    it('says which archive is missing rather than writing half of one', () => {
      const target = seededShop({ object: false, seed: [] });
      const result = target.run(['backup', 'pull', 'atelier-test-staging-20200101T000000Z', '--env', 'staging']);
      expect(result.status).toBe(EXIT_CODES.input);
      expect(result.stderr).toMatch(/manifest\.json est introuvable/);
      expect(existsSync(join(target.root, 'backups', 'atelier-test-staging-20200101T000000Z'))).toBe(false);
    });

    it('completes a local copy without touching what it already has', () => {
      const target = seededShop();
      const { report } = target.json(['backup', '--env', 'staging', '--upload']);
      const body = join(target.root, 'backups', report.id, 'data.bin');
      const before = readFileSync(body);
      const calls = target.read().calls.length;
      const result = target.json(['backup', 'pull', report.id, '--env', 'staging']);
      expect(result.status).toBe(EXIT_CODES.ok);
      expect(result.report.fetched).toBe(0);
      expect(target.read().calls.length).toBe(calls);
      expect(readFileSync(body)).toEqual(before);
    });
  });

  describe('prune', () => {
    it('applies the policy and reports what it kept', () => {
      const target = seededShop();
      takeBackup(target);
      const { report, status } = target.json(['backup', 'prune', '--keep', '1', '--keep-days', '0']);
      expect(status).toBe(EXIT_CODES.ok);
      expect(report.removed).toEqual([]);
      expect(report.kept).toHaveLength(1);
    });

    it('removes nothing under --dry-run', () => {
      const target = seededShop();
      const id = takeBackup(target);
      const { report } = target.json(['backup', 'prune', '--keep', '0', '--keep-days', '0', '--dry-run']);
      expect(report.wouldRemove).toEqual([id]);
      expect(existsSync(join(target.root, 'backups', id))).toBe(true);
    });

    it('refuses a bound that is not a number', () => {
      const target = seededShop({ object: false, seed: [] });
      expect(target.run(['backup', 'prune', '--keep', 'beaucoup']).status).toBe(EXIT_CODES.input);
    });
  });
});
