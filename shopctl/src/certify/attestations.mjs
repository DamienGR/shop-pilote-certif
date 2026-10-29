/**
 * What `shopctl certify` cannot see, attested by the people who saw it.
 *
 * A real purchase, refunded; the e-mails it sent, received; the pages looked at
 * on a phone; the acceptance report signed; the legal pages read again; the
 * accountant's answer on invoices. Each is one date and one reference in
 * `client/certification/attestations.yaml`, a file of the shop (client-owned)
 * versioned with the report that cites it.
 *
 * The schema is CLOSED, like the manifest's: a section or a field this file
 * does not know is refused rather than ignored, because a typo in a field name
 * would otherwise read as an attestation nobody made. It is read by the
 * manifest's own YAML reader, which refuses what a manifest refuses (no
 * sequences, no ambiguous words), so the two files of a shop that a human
 * edits by hand follow one set of rules.
 *
 * No personal data, by construction: the file is committed, and its values are
 * references (a Stripe payment id, a device, a mail client), never a name or an
 * address. An `@` anywhere is refused — the one shape every e-mail address has.
 *
 * Pure: the command reads the file and the clock, and hands both in.
 */
import { parseManifestYaml } from '../../../scripts/manifest-yaml.mjs';

export const ATTESTATIONS_FILE = 'client/certification/attestations.yaml';

/** A Stripe PaymentIntent id. Test and live ids share the shape; the live one
 *  is the merchant's own acceptance run (docs/operations/recette.md). */
const PAYMENT_ID = /^pi_[A-Za-z0-9]{8,}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The sections, in the order the recette produces them. A field is a kind
 * (`date`, `payment`, `text`, `count`) or the list of values it may take.
 */
export const SECTIONS = {
  purchase: {
    what: 'achat réel de la recette, remboursé',
    fields: { date: 'date', payment: 'payment', refunded: 'date' },
  },
  emails: {
    what: 'e-mails de la commande et du remboursement reçus',
    fields: { date: 'date', clients: 'text' },
  },
  phone: {
    what: 'parcours d\'achat regardé sur un téléphone',
    fields: { date: 'date', device: 'text' },
  },
  acceptance: {
    what: 'procès-verbal de recette signé',
    fields: { date: 'date', by: ['merchant', 'delegate'] },
  },
  legal: {
    what: 'pages légales relues',
    fields: { date: 'date', by: ['counsel', 'merchant'] },
  },
  accounting: {
    what: 'régime de facturation confirmé par l\'expert-comptable',
    fields: { date: 'date', strategy: ['stripe-receipt', 'invoice'] },
  },
};

/**
 * The one optional section: the shop's divergences from the core, named and
 * justified. Present only when the shop edits a core file; `certify` counts
 * the files itself and refuses a count that no longer matches, so a new
 * divergence is never covered by an old justification.
 */
export const CORE_SECTION = {
  what: 'divergences du socle déclarées',
  fields: { divergences: 'count', reason: 'text' },
};

export const ATTESTATIONS_TEMPLATE = `# Attestations de certification — ce que \`shopctl certify\` ne peut pas voir.
#
# Une date (AAAA-MM-JJ) et une référence par geste humain de la recette
# (docs/certification/par-boutique.md). Laissez "" tant que le geste n'est pas
# fait : certify le compte comme à faire, jamais comme acquis.
#
# Ce fichier est versionné : aucune adresse e-mail, aucun nom de client. Une
# valeur qui contient « @ » est refusée.

purchase:
  date: ""        # achat réel de la recette, carte du commerçant
  payment: ""     # identifiant Stripe du paiement, pi_…
  refunded: ""    # date du remboursement

emails:
  date: ""
  clients: ""     # messageries où les e-mails sont arrivés, ex. "Gmail, Outlook"

phone:
  date: ""
  device: ""      # ex. "iPhone 13, Safari"

acceptance:
  date: ""        # procès-verbal de recette signé
  by: ""          # merchant (le commerçant) ou delegate (son représentant)

legal:
  date: ""        # pages légales relues
  by: ""          # counsel (un juriste) ou merchant (le commerçant, sous sa responsabilité)

accounting:
  date: ""        # réponse de l'expert-comptable
  strategy: ""    # stripe-receipt ou invoice : la valeur de commerce.invoiceStrategy

# Seulement si la boutique modifie un fichier du socle (certify les compte) :
# core:
#   divergences: 1
#   reason: "pourquoi, et quand la modification rejoindra le socle"
`;

/**
 * Read the file's text into findings.
 *
 * @param {string|null} text the file, or null when it does not exist
 * @param {{ manifest: object, today: string }} context `today` as AAAA-MM-JJ
 * @returns {{ findings: Array<{ status: string, message: string, hint?: string }>, core: { divergences: number, reason: string }|null, values: object|null }}
 */
export function judgeAttestations(text, { manifest, today }) {
  if (text === null) {
    return {
      findings: [{
        status: 'todo',
        message: `${ATTESTATIONS_FILE} n'existe pas : aucune attestation de la recette.`,
        hint: '`shopctl certify --env production --write` en pose le modèle ; remplissez-le après la recette du commerçant.',
      }],
      core: null,
      values: null,
    };
  }

  let document;
  try {
    document = parseManifestYaml(text, { file: ATTESTATIONS_FILE });
  } catch (error) {
    return { findings: [{ status: 'fail', message: `${ATTESTATIONS_FILE} est illisible : ${error.message}` }], core: null, values: null };
  }

  const findings = [];
  // Before anything else, and over every value: a report and a file that are
  // committed must never carry an address, whichever field it was typed in.
  const addresses = Object.entries(document).flatMap(([section, fields]) =>
    typeof fields === 'object' && fields !== null
      ? Object.entries(fields).filter(([, value]) => String(value).includes('@')).map(([field]) => `${section}.${field}`)
      : String(fields).includes('@') ? [section] : [],
  );
  if (addresses.length > 0) {
    findings.push({
      status: 'fail',
      message: `${addresses.join(', ')} contien${addresses.length > 1 ? 'nent' : 't'} un « @ » : ce fichier est versionné et ne porte aucune adresse.`,
      hint: 'Une référence suffit : l\'identifiant Stripe, la messagerie, l\'appareil.',
    });
  }

  for (const key of Object.keys(document)) {
    if (!(key in SECTIONS) && key !== 'core') {
      findings.push({ status: 'fail', message: `section inconnue « ${key} » dans ${ATTESTATIONS_FILE}.`, hint: `Sections : ${[...Object.keys(SECTIONS), 'core'].join(', ')}.` });
    }
  }

  for (const [id, section] of Object.entries(SECTIONS)) {
    findings.push(...judgeSection(id, section, document[id], { manifest, today }));
  }

  let core = null;
  if (document.core !== undefined) {
    const coreFindings = judgeSection('core', CORE_SECTION, document.core, { manifest, today });
    const problems = coreFindings.filter((finding) => finding.status !== 'ok');
    // The section is not an attestation of its own: its only reader is the
    // core check, which reports it. Only what is wrong with it is said here.
    findings.push(...problems);
    if (problems.length === 0) core = { divergences: document.core.divergences, reason: document.core.reason };
  }

  return { findings, core, values: document };
}

function judgeSection(id, section, value, { manifest, today }) {
  if (value === undefined) {
    return [{ status: 'todo', message: `${section.what} : à attester (section ${id} absente).` }];
  }
  if (typeof value !== 'object' || value === null) {
    return [{ status: 'fail', message: `${id} n'est pas une section : ${Object.keys(section.fields).join(', ')} attendus.` }];
  }

  const problems = [];
  for (const field of Object.keys(value)) {
    if (!(field in section.fields)) problems.push(`champ inconnu « ${id}.${field} »`);
  }
  const empty = Object.keys(section.fields).filter((field) => value[field] === undefined || value[field] === '');
  if (problems.length === 0 && empty.length === Object.keys(section.fields).length) {
    return [{ status: 'todo', message: `${section.what} : à attester.` }];
  }

  for (const [field, kind] of Object.entries(section.fields)) {
    const raw = value[field];
    if (raw === undefined || raw === '') continue;
    const problem = checkField(kind, raw, { today });
    if (problem) problems.push(`${id}.${field} ${problem}`);
  }

  if (id === 'purchase' && isDate(value.date) && isDate(value.refunded) && value.refunded < value.date) {
    problems.push('purchase.refunded précède l\'achat');
  }
  if (id === 'accounting' && value.strategy && value.strategy !== manifest.commerce?.invoiceStrategy) {
    problems.push(`accounting.strategy « ${value.strategy} » n'est pas commerce.invoiceStrategy du manifeste (« ${manifest.commerce?.invoiceStrategy} »)`);
  }

  if (problems.length > 0) return [{ status: 'fail', message: `${section.what} : ${problems.join(' ; ')}.` }];
  if (empty.length > 0) return [{ status: 'todo', message: `${section.what} : ${empty.map((field) => `${id}.${field}`).join(', ')} à remplir.` }];
  return [{ status: 'ok', message: `${section.what} — ${describe(id, value)}` }];
}

function checkField(kind, raw, { today }) {
  if (Array.isArray(kind)) return kind.includes(raw) ? null : `vaut « ${raw} » ; valeurs : ${kind.join(', ')}`;
  if (kind === 'date') {
    if (!isDate(raw)) return `« ${raw} » n'est pas une date AAAA-MM-JJ`;
    return raw > today ? `est dans le futur (${raw})` : null;
  }
  if (kind === 'payment') return PAYMENT_ID.test(String(raw)) ? null : `« ${raw} » n'est pas un identifiant de paiement Stripe (pi_…)`;
  if (kind === 'count') return Number.isInteger(raw) && raw > 0 ? null : `doit être un nombre de fichiers, 1 ou plus`;
  if (kind === 'text') {
    if (typeof raw !== 'string') return 'doit être un texte entre guillemets';
    return raw.length > 200 ? 'dépasse 200 caractères : une référence, pas un récit' : null;
  }
  return null;
}

/** A real calendar day, not just the shape: 2026-02-30 is refused. */
function isDate(value) {
  const match = DATE.exec(String(value ?? ''));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function describe(id, value) {
  switch (id) {
    case 'purchase':
      return `${value.date}, ${value.payment}, remboursé le ${value.refunded}`;
    case 'emails':
      return `${value.date}, ${value.clients}`;
    case 'phone':
      return `${value.date}, ${value.device}`;
    case 'acceptance':
      return `${value.date}, par ${value.by === 'merchant' ? 'le commerçant' : 'son représentant'}`;
    case 'legal':
      return `${value.date}, par ${value.by === 'counsel' ? 'un juriste' : 'le commerçant'}`;
    case 'accounting':
      return `${value.date}, ${value.strategy}`;
    default:
      return value.date ?? '';
  }
}
