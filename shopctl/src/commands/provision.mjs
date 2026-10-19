/**
 * `shopctl provision` — the Cloudflare resources one environment of one shop
 * runs on, created or confirmed.
 *
 * The command is a LOOP OVER STEPS, not a script. Each step answers one
 * question of the account, decides `create` or `keep`, and records what it
 * found. That shape is what buys the three properties plan §5.3 asks for and
 * that a linear script cannot have at once:
 *
 * - IDEMPOTENT: a second run finds everything and creates nothing. Not because
 *   it remembers running — because it asked.
 * - RESUMABLE: a run killed after the database and before the buckets resumes
 *   by asking the same questions and finding one more answer than last time.
 *   There is no state file to be stale, no `--resume`, and no way to be wrong
 *   about what exists.
 * - HONEST UNDER `--dry-run`: the preview walks the same steps against the same
 *   account and stops before every write. It is a preview of THIS program, not
 *   of a second one written to resemble it.
 *
 * What it will not do is decide anything the operator has not said. It refuses
 * to run without `--env`, refuses to run without a named account, and refuses
 * an account the manifest does not claim. Provisioning into the wrong account
 * is not a mistake that can be undone by deleting resources: the customer's
 * data has been created somewhere it should never have existed (ADR 0002).
 *
 * Account creation, R2 activation, user invitations and Stripe onboarding stay
 * human (plan §5.3). `shopctl doctor` lists them; this command detects the one
 * that is machine-detectable — R2 — and names the rest in its report rather
 * than pretending to have checked them.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addRetentionRule,
  applyMigrations,
  bucketExposure,
  createBucket,
  createDatabase,
  databaseInfo,
  hasRetentionRule,
  listBuckets,
  listDatabases,
  listSecrets,
  putSecret,
  verifyBucketJurisdiction,
  whoami,
  expectedAccount,
  resolveAccount,
  workerExists,
} from '../cloudflare.mjs';
import { ShopctlError, verificationError } from '../errors.mjs';
import { requireEnvironment, resolveShop } from '../shop.mjs';
import { renderWrangler, resourceNames, wranglerSubstitutions } from '../../../scripts/manifest.mjs';
import { DEFAULT_KEEP_DAYS } from '../backup/archive.mjs';

export const PROVISION_OPTIONS = { '--env': 'environnement', '--shop': 'slug', '--account': 'id' };

export const provisionUsage = `Usage: shopctl provision --env <staging|production> [options]

  --env <staging|production>  Environnement à provisionner. Obligatoire.
  --dry-run                   Interroger le compte et n'écrire nulle part.
  --account <id>              Compte Cloudflare attendu, si le manifeste ne le déclare pas.
  --shop <slug>               Manifeste à utiliser quand l'arbre en contient plusieurs.
  --json                      Rapport lisible par une machine.

Crée ou confirme, pour cette boutique et cet environnement :

  minshop-<slug>-<env>          le Worker (déployé par \`shopctl deploy\`)
  minshop-<slug>-<env>-db       la base D1, juridiction du manifeste
  minshop-<slug>-<env>-images   le bucket R2 des images produit
  minshop-<slug>-<env>-files    le bucket R2 privé des fichiers vendus

La commande est rejouable : elle relit le compte à chaque étape, ne recrée rien
et reprend une exécution interrompue sans option particulière.
`;

/**
 * The internal secrets a shop needs, and what each one protects.
 *
 * Generated here, never read back: `wrangler secret list` returns names, not
 * values, so a secret that already exists is KEPT rather than rotated. That is
 * not laziness. `SECRETS_KEK` encrypts the payment keys the merchant pasted in
 * Admin → Réglages; regenerating it on a second provisioning run would leave
 * every one of them undecryptable, and the shop would stop taking payments with
 * no error anyone could read.
 */
export const INTERNAL_SECRETS = [
  ['AUTH_SECRET', 'signe les sessions de l\'administration'],
  ['SECRETS_KEK', 'chiffre les clés de paiement saisies dans Admin → Réglages'],
];

/** 32 bytes from the platform CSPRNG, base64. Never logged, never written to
 *  disk, never passed as an argument (plan §5.3). */
export function generateSecret() {
  return randomBytes(32).toString('base64');
}

/**
 * Render this environment's Wrangler configuration next to the shop.
 *
 * Provisioning writes it rather than leaving it to `prepare-client.mjs`,
 * because provisioning is the only thing that knows the database id: it is
 * assigned by Cloudflare and appears in no committed file. Everything else in
 * the render comes from the manifest, through the same substitution the witness
 * builds use, so a provisioned configuration and a CI one cannot diverge.
 */
export function renderEnvironmentConfig({ root, manifest, env, databaseId, out = 'wrangler.jsonc' }) {
  const template = readFileSync(resolve(root, 'wrangler.template.jsonc'), 'utf8');
  const substitutions = wranglerSubstitutions(manifest, { databaseId, env });
  const rendered = renderWrangler(template, substitutions);
  writeFileSync(resolve(root, out), rendered);
  return { out, substitutions };
}

export function runProvision(args, reporter) {
  if (args.positionals.length > 0) {
    throw new ShopctlError(`provision ne prend pas d'argument positionnel ; reçu « ${args.positionals.join('", "')} ».`, {
      kind: 'usage',
      hint: provisionUsage.trim(),
    });
  }

  const env = requireEnvironment(args.values['--env']);
  const dryRun = args.values['--dry-run'] === true;
  const json = args.values['--json'] === true;
  const shop = resolveShop(process.cwd(), args.values['--shop']);
  const { manifest, root } = shop;
  const names = resourceNames(manifest, { env });
  const jurisdiction = manifest.cloudflare.jurisdiction;

  reporter.section(`Compte Cloudflare`);
  const identity = whoami({ cwd: root });
  const expected = expectedAccount(manifest, env, args.values);
  const account = resolveAccount(expected, identity);
  reporter.ok(`${account.name} (${account.id}) — attendu par ${account.sources.join(', ')}`);
  if (!expected.manifest) {
    // In production the line to add depends on whose account this is, which
    // the session cannot say: the agency's is `accountId`, the client's
    // (ADR 0015) is `productionAccountId`.
    const key = expected.field.replace(/^cloudflare\./, '');
    reporter.warn(
      `le manifeste ne déclare pas ${expected.field}.`,
      `Ajoutez « ${key}: ${account.id} » sous cloudflare: dans ${shop.file}${env === 'production' ? ', ou « productionAccountId: … » si la production vit sur le compte du client (ADR 0015)' : ''}. Tant qu'il est absent, le bon compte dépend de ce que l'opérateur tape.`,
    );
  }

  reporter.section(`Ressources de ${manifest.client.slug} en ${env}${dryRun ? ' (simulation)' : ''}`);

  /** @type {Array<{ resource: string, name: string, action: string, detail: string|null }>} */
  const steps = [];
  const record = (resource, name, action, detail = null) => {
    steps.push({ resource, name, action, detail });
    const message = `${resource} ${name} — ${action === 'create' ? (dryRun ? 'à créer' : 'créé') : 'déjà présent'}`;
    reporter.ok(detail ? `${message} (${detail})` : message);
    return action;
  };

  // R2 first, and before anything is created: activation is a human step
  // (plan §5.3) and discovering it after the database exists leaves a shop
  // half-provisioned for however long the dashboard visit takes.
  const bucketsInJurisdiction = listBuckets({ cwd: root, jurisdiction });

  // ── D1 ────────────────────────────────────────────────────────────────────
  const databases = listDatabases({ cwd: root });
  const existing = databases.find((entry) => entry.name === names.database);
  let databaseId = existing?.uuid ?? existing?.database_id ?? null;

  if (existing) {
    record('base D1', names.database, 'keep', databaseId);
  } else if (dryRun) {
    record('base D1', names.database, 'create', `juridiction ${jurisdiction}`);
    databaseId = null;
  } else {
    const created = createDatabase(names.database, { cwd: root, jurisdiction });
    databaseId = created.uuid;
    record('base D1', names.database, 'create', `juridiction ${jurisdiction}, ${databaseId}`);
  }

  // ── R2 ────────────────────────────────────────────────────────────────────
  const buckets = [['bucket images', names.images], ['bucket fichiers', names.files], ['bucket sauvegardes', names.backups]];
  for (const [label, name] of buckets) {
    if (bucketsInJurisdiction.includes(name)) record(label, name, 'keep', jurisdiction);
    else if (dryRun) record(label, name, 'create', `juridiction ${jurisdiction}`);
    else {
      createBucket(name, { cwd: root, jurisdiction });
      record(label, name, 'create', `juridiction ${jurisdiction}`);
    }
  }

  // ── Jurisdiction, read back from the account ──────────────────────────────
  //
  // ADR 0004 asks for the check right after creation, and for one reason: a
  // jurisdiction cannot be changed afterwards. A base created outside it can
  // only be re-created and re-seeded, so the moment to discover the mistake is
  // before any order lands in it.
  reporter.section('Juridiction');
  const checks = [];

  if (dryRun && !databaseId) {
    reporter.todo(`${names.database} — juridiction ${jurisdiction} demandée à la création (simulation : rien à relire).`);
  } else {
    const info = databaseInfo(names.database, { cwd: root });
    const reported = info?.jurisdiction ?? null;
    if (reported === jurisdiction) {
      checks.push({ resource: names.database, expected: jurisdiction, reported, ok: true });
      reporter.ok(`${names.database} — juridiction ${reported}`);
    } else if (reported) {
      checks.push({ resource: names.database, expected: jurisdiction, reported, ok: false });
      reporter.fail(
        `${names.database} annonce la juridiction « ${reported} », le manifeste demande « ${jurisdiction} ».`,
        'Une juridiction ne se change pas après coup (ADR 0004) : la base doit être recréée et les données rejouées.',
      );
    } else {
      // Said out loud rather than counted as a pass. The creation call carried
      // `--jurisdiction`, but an API that does not publish the field back gives
      // this command nothing to verify, and a check that reports "ok" on an
      // absence is worse than no check.
      checks.push({ resource: names.database, expected: jurisdiction, reported: null, ok: null });
      reporter.warn(
        `${names.database} — l'API D1 ne publie pas de juridiction sur cette version.`,
        `Créée avec --jurisdiction ${jurisdiction} ; à confirmer dans le tableau de bord avant la mise en production.`,
      );
    }
  }

  for (const [, name] of buckets) {
    if (dryRun && !bucketsInJurisdiction.includes(name)) {
      reporter.todo(`${name} — juridiction ${jurisdiction} demandée à la création (simulation : rien à relire).`);
      continue;
    }
    const verdict = verifyBucketJurisdiction(name, { cwd: root, jurisdiction });
    checks.push({ resource: name, expected: jurisdiction, reported: verdict.inside ? jurisdiction : null, ok: verdict.ok });
    if (verdict.ok) reporter.ok(`${name} — visible en juridiction ${jurisdiction}, absent de la juridiction par défaut`);
    else if (!verdict.inside) {
      reporter.fail(
        `${name} n'est pas visible en juridiction ${jurisdiction}.`,
        'Un bucket créé hors juridiction ne peut pas y être déplacé (ADR 0004) : renommez ou supprimez celui-ci, puis relancez.',
      );
    } else {
      reporter.fail(
        `${name} existe AUSSI dans la juridiction par défaut.`,
        'Deux buckets portent ce nom dans deux juridictions ; le binding en choisira un et personne ne saura lequel. Supprimez celui qui est hors juridiction.',
      );
    }
  }

  // ── The private bucket stays private ──────────────────────────────────────
  reporter.section('Exposition publique');
  let filesExposure = null;
  if (!dryRun || bucketsInJurisdiction.includes(names.files)) {
    filesExposure = bucketExposure(names.files, { cwd: root, jurisdiction });
    if (!filesExposure.known) {
      reporter.warn(`${names.files} — l'exposition publique n'a pas pu être lue.`, 'Vérifiez-la dans le tableau de bord avant la mise en production.');
    } else if (filesExposure.public) {
      reporter.fail(
        `${names.files} est accessible publiquement (${filesExposure.devUrl ?? filesExposure.domains.join(', ')}).`,
        'Ce bucket porte les fichiers vendus : une URL publique les distribue à qui la devine. Coupez l\'URL r2.dev et détachez le domaine.',
      );
    } else {
      reporter.ok(`${names.files} — privé : ni URL r2.dev, ni domaine attaché`);
    }
  } else {
    reporter.todo(`${names.files} — créé privé ; l'exposition sera relue au prochain passage.`);
  }

  // The backups bucket holds every order and every address the shop has taken,
  // encrypted — and still never public: a key leaks more easily than a bucket
  // that nobody can list.
  let backupsExposure = null;
  if (!dryRun || bucketsInJurisdiction.includes(names.backups)) {
    backupsExposure = bucketExposure(names.backups, { cwd: root, jurisdiction });
    if (!backupsExposure.known) {
      reporter.warn(`${names.backups} — l'exposition publique n'a pas pu être lue.`, 'Vérifiez-la dans le tableau de bord avant la mise en production.');
    } else if (backupsExposure.public) {
      reporter.fail(
        `${names.backups} est accessible publiquement (${backupsExposure.devUrl ?? backupsExposure.domains.join(', ')}).`,
        'Ce bucket porte les sauvegardes chiffrées de la boutique. Coupez l\'URL r2.dev et détachez le domaine.',
      );
    } else {
      reporter.ok(`${names.backups} — privé : ni URL r2.dev, ni domaine attaché`);
    }
  } else {
    reporter.todo(`${names.backups} — créé privé ; l'exposition sera relue au prochain passage.`);
  }

  let imagesExposure = null;
  if (!dryRun || bucketsInJurisdiction.includes(names.images)) {
    imagesExposure = bucketExposure(names.images, { cwd: root, jurisdiction });
    // The images bucket is the one that MAY be public: a custom domain in front
    // of it is how product images bypass the Worker (plan §6, jalon 6, « domaine
    // d'images »). It is reported, never required and never refused.
    if (imagesExposure.domains.length > 0) reporter.ok(`${names.images} — domaine d'images : ${imagesExposure.domains.join(', ')}`);
    else if (imagesExposure.devUrl) {
      reporter.warn(
        `${names.images} est servi par son URL r2.dev (${imagesExposure.devUrl}).`,
        'Elle convient à un essai mais n\'est pas un domaine de production : préférez un domaine personnalisé, et renseignez IMAGE_BASE_URL.',
      );
    } else reporter.ok(`${names.images} — images servies par le Worker (aucun domaine d'images)`);
  }

  // ── Retention of the backups ──────────────────────────────────────────────
  //
  // ADR 0005: a backup carries personal data, so its conservation is bounded.
  // A bucket can only express an age, not "keep the last N", and that is
  // acceptable here because the nightly run keeps adding recent archives; the
  // rule `backup prune` applies locally, both bounds at once, is unchanged.
  reporter.section('Conservation des sauvegardes');
  let retention = null;
  if (dryRun && !bucketsInJurisdiction.includes(names.backups)) {
    reporter.todo(`${names.backups} — les objets de plus de ${DEFAULT_KEEP_DAYS} jours seraient expirés`);
  } else {
    const present = hasRetentionRule(names.backups, { cwd: root, jurisdiction });
    if (present === true) {
      retention = { days: DEFAULT_KEEP_DAYS, action: 'keep' };
      reporter.ok(`${names.backups} — règle de conservation déjà posée`);
    } else if (present === null) {
      reporter.warn(`${names.backups} — les règles de cycle de vie n'ont pas pu être lues.`, `Vérifiez dans le tableau de bord qu'une règle expire les objets après ${DEFAULT_KEEP_DAYS} jours.`);
    } else if (dryRun) {
      reporter.todo(`${names.backups} — les objets de plus de ${DEFAULT_KEEP_DAYS} jours seraient expirés`);
    } else {
      addRetentionRule(names.backups, DEFAULT_KEEP_DAYS, { cwd: root, jurisdiction });
      retention = { days: DEFAULT_KEEP_DAYS, action: 'create' };
      reporter.ok(`${names.backups} — objets expirés après ${DEFAULT_KEEP_DAYS} jours`);
    }
  }

  const failures = reporter.entries.filter((entry) => entry.status === 'fail');

  // ── Configuration, migrations, secrets ────────────────────────────────────
  let config = null;
  let migrations = 'skipped';
  const secrets = { present: [], created: [], pending: [] };

  if (dryRun) {
    reporter.section('Simulation : rien n\'a été écrit');
    reporter.todo(`wrangler.jsonc serait rendu pour ${names.worker}`);
    reporter.todo('les migrations seraient appliquées à la base distante');
    reporter.todo(`les secrets internes manquants seraient posés : ${INTERNAL_SECRETS.map(([name]) => name).join(', ')}`);
  } else if (failures.length === 0) {
    reporter.section('Configuration et migrations');
    config = renderEnvironmentConfig({ root, manifest, env, databaseId });
    reporter.ok(`wrangler.jsonc rendu pour ${names.worker} (base ${databaseId})`);

    applyMigrations({ cwd: root, remote: true });
    migrations = 'applied';
    reporter.ok(`migrations appliquées à ${names.database}`);

    reporter.section('Secrets internes');
    const known = listSecrets(names.worker, { cwd: root });
    if (known === null) {
      // The Worker does not exist yet: `secret put` has nothing to attach to.
      // Reported as pending rather than failed, because the next command in the
      // sequence creates it and sets them — and a second `provision` run after
      // the first deploy fills them in too.
      for (const [name] of INTERNAL_SECRETS) secrets.pending.push(name);
      reporter.todo(
        `${names.worker} n'est pas encore déployé : ${secrets.pending.join(' et ')} seront posés au premier déploiement.`,
        `shopctl deploy --env ${env} les génère, puis \`shopctl provision\` les confirme.`,
      );
    } else {
      for (const [name, what] of INTERNAL_SECRETS) {
        if (known.includes(name)) {
          secrets.present.push(name);
          // Never rotated by a re-run. SECRETS_KEK decrypts the payment keys
          // already in D1; a new one would silently break every payment.
          reporter.ok(`${name} déjà posé — conservé (${what})`);
          continue;
        }
        putSecret(names.worker, name, generateSecret(), { cwd: root });
        secrets.created.push(name);
        reporter.ok(`${name} généré et transmis à wrangler par entrée standard (${what})`);
      }
    }
  }

  reporter.result({
    command: 'provision',
    ok: failures.length === 0,
    dryRun,
    shop: manifest.client.slug,
    env,
    account: { id: account.id, name: account.name },
    jurisdiction,
    resources: names,
    databaseId,
    steps,
    jurisdictionChecks: checks,
    exposure: { files: filesExposure, images: imagesExposure, backups: backupsExposure },
    retention,
    config: config?.out ?? null,
    migrations,
    secrets,
    workerDeployed: dryRun ? null : workerExists(names.worker, { cwd: root }),
  });

  if (failures.length > 0) {
    throw verificationError(
      `${failures.length} contrôle(s) en échec ; le provisioning s'arrête avant les migrations et les secrets.`,
      'Chaque ligne ✗ ci-dessus porte sa remédiation. Relancez `shopctl provision` une fois corrigée : rien de ce qui existe déjà ne sera recréé.',
    );
  }

  if (!json) {
    reporter.section(
      dryRun
        ? `Simulation terminée. Relancez sans --dry-run pour appliquer.`
        : `${env} provisionné pour ${manifest.client.slug}. Suite : npm run shopctl -- deploy --env ${env}.`,
    );
  }
  return 0;
}
