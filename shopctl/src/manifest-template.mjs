/**
 * The manifest `shopctl new` writes, and the YAML it writes it as.
 *
 * Two properties matter more than the formatting.
 *
 * The values are validated BEFORE the file exists. `buildManifest()` returns a
 * plain object that goes through the same `validateManifest()` the CI gate runs,
 * so a shop is never created around a manifest that `config validate` will then
 * refuse — which would leave the operator with a directory, a git history, and
 * a red gate.
 *
 * And the file is read back. `renderManifest()` is checked against
 * `parseManifestYaml()` by the caller: a generator and a parser that disagree
 * about quoting would produce a shop whose display name silently lost a
 * character, and the manifest is the file nothing else can correct.
 *
 * Everything the pilot fixes by scope (locale, currency, market, jurisdiction,
 * checkout mode) is written as the single value its enumeration allows. Those
 * are not options: widening one is a schema version with migration notes
 * (ADR 0008), not a flag.
 */
import { RESOURCE_PREFIX } from '../../scripts/manifest-schema.mjs';

/**
 * A scalar as the manifest reader will read it back.
 *
 * Quoted only when a bare word would be read as something else — a number, a
 * boolean, a nested mapping, one of the words YAML 1.1 turns into a boolean.
 * Quoting everything would be simpler and would make the generated file read
 * like machine output; the merchant edits this file by hand, so it should look
 * like the fixtures they will be shown next to it.
 */
export function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  const bare =
    /^[A-Za-z0-9][A-Za-z0-9._@/+-]*(?: [A-Za-z0-9._@/+-]+)*$/.test(text) &&
    !/^(?:true|false|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|null|Null|NULL|~)$/.test(text) &&
    !/^-?\d+(?:\.\d+)?$/.test(text);
  return bare ? text : JSON.stringify(text);
}

/** The Worker name a slug implies. Derived, never asked for: every other
 *  resource name follows it (scripts/manifest.mjs). */
export const workerNameFor = (slug) => `${RESOURCE_PREFIX}-${slug}`;

/**
 * The manifest object for a new shop.
 *
 * @param {{ slug: string, displayName: string, domain: string, email: string, theme: string, coreVersion: string, accountId?: string|null }} values
 */
export function buildManifest({ slug, displayName, domain, email, theme, coreVersion, accountId = null }) {
  return {
    schemaVersion: 1,
    coreVersion,
    client: {
      slug,
      displayName,
      locale: 'fr-FR',
      timezone: 'Europe/Paris',
      currency: 'EUR',
    },
    commerce: {
      market: 'FR',
      pricesIncludeTax: true,
      checkoutMode: 'guest',
      defaultVatRate: 20,
      // Not a default so much as an admission: the accounting review of jalon 3
      // has not happened for this shop, and a strategy chosen by a generator is
      // exactly the kind of decision that is discovered at the first audit.
      invoiceStrategy: 'pending-validation',
    },
    features: {
      customerAccounts: false,
      semanticSearch: false,
      digitalProducts: false,
      promoCodes: true,
      shipping: true,
    },
    cloudflare: {
      jurisdiction: 'eu',
      workerName: workerNameFor(slug),
      productionDomain: domain,
      // Optional, and omitted rather than placeheld when unknown: a shop LEARNS
      // its account at provisioning, and an all-zero id would validate while
      // meaning nothing — which is exactly what `provision` refusing to guess
      // is there to prevent.
      ...(accountId ? { accountId } : {}),
    },
    email: {
      provider: 'resend',
      from: email,
    },
    theme: {
      id: theme,
    },
  };
}

/**
 * Comments carried into the generated file, by dotted path.
 *
 * They are the ones a merchant needs while editing and cannot recover from the
 * schema: which values are fixed by the certified scope rather than by taste,
 * and what a field commits the shop to. Placeholders have their own list below.
 */
const NOTES = {
  coreVersion: ['Version du socle clonée. Mise à jour par `shopctl core upgrade`.'],
  'client.locale': ['Fixés par le périmètre certifié (plan §2.1) : une seule valeur possible.'],
  'commerce.invoiceStrategy': [
    'La validation comptable du jalon 3 n\'a pas eu lieu pour cette boutique :',
    'la stratégie de facturation reste en attente plutôt que par défaut.',
  ],
  'cloudflare.accountId': [
    'Compte Cloudflare de cette boutique. `shopctl provision` refuse tout autre',
    'compte : provisionner ailleurs ne se défait pas (ADR 0002).',
  ],
  'theme.id': ['Thème propre à la boutique. Le socle ne le modifie jamais.'],
};

/**
 * Comments for the values that are placeholders, written only when they ARE.
 *
 * A "replace this" note next to the merchant's real domain is a note someone
 * eventually obeys, or learns to read past — and then reads past the one that
 * mattered.
 */
const PLACEHOLDER_NOTES = {
  'cloudflare.productionDomain': [
    'PLACEHOLDER : domaine réservé à la documentation (RFC 2606).',
    'À remplacer par le domaine du commerçant avant tout provisioning.',
  ],
  'email.from': ['PLACEHOLDER : suit le domaine ci-dessus.'],
};

/** Section-level headings, in the order buildManifest() emits them. */
const SECTION_NOTES = {
  client: 'Qui est la boutique.',
  commerce: 'Comment elle vend.',
  features: 'Interrupteurs décidés à la construction. Les réglages d\'exploitation vivent dans Admin → Réglages.',
  cloudflare: 'Où elle tourne. Tous ces noms sont visibles dans le compte Cloudflare.',
  email: 'E-mails transactionnels. Aucune clé d\'API ici, jamais.',
  theme: 'Quel design elle compile.',
};

/**
 * Render the manifest as the file the shop commits.
 *
 * Deterministic by construction: field order comes from the object, every value
 * from `values`, and nothing from the clock or the environment. Two runs with
 * the same options produce the same bytes, which is what makes the generated
 * shop reviewable as a diff.
 */
export function renderManifest(manifest, { header, placeholders = [] } = {}) {
  const notesFor = (path) => [
    ...(NOTES[path] ?? []),
    ...(placeholders.includes(path) ? (PLACEHOLDER_NOTES[path] ?? []) : []),
  ];
  const lines = [];
  if (header) for (const line of header) lines.push(`# ${line}`);

  for (const [key, value] of Object.entries(manifest)) {
    const isSection = value !== null && typeof value === 'object';
    if (isSection) {
      lines.push('');
      if (SECTION_NOTES[key]) lines.push(`# ${SECTION_NOTES[key]}`);
      lines.push(`${key}:`);
      for (const [field, fieldValue] of Object.entries(value)) {
        for (const note of notesFor(`${key}.${field}`)) lines.push(`  # ${note}`);
        lines.push(`  ${field}: ${yamlScalar(fieldValue)}`);
      }
      continue;
    }
    for (const note of notesFor(key)) lines.push(`# ${note}`);
    lines.push(`${key}: ${yamlScalar(value)}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The same manifest, declaring another core version.
 *
 * A LINE REWRITE rather than a re-render, and the difference matters after an
 * upgrade: re-rendering would return the file this CLI would have written,
 * dropping whatever comment the merchant added next to their own domain and
 * reordering anything they moved. The only field an upgrade changes is
 * `coreVersion`, so the only line it touches is that one.
 *
 * Refuses a file with no `coreVersion` line rather than adding one: a manifest
 * without it is not a manifest this core reads, and appending a field to a file
 * nobody has validated is how a shop ends up claiming a version it never took.
 *
 * @param {string} text current client.yaml
 * @param {string} version the version now merged, e.g. "1.1.0"
 */
export function withCoreVersion(text, version) {
  const line = /^coreVersion:[ \t]*.*$/m;
  if (!line.test(text)) {
    throw new Error('client.yaml has no coreVersion line to update.');
  }
  return text.replace(line, `coreVersion: ${yamlScalar(String(version))}`);
}
