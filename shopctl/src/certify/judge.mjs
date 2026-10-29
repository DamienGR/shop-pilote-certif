/**
 * The verdicts of `shopctl certify`, as pure functions of what was read.
 *
 * Every read — git, wrangler, gh, the shop's own pages, PageSpeed Insights —
 * happens in the command; every decision happens here, so that each threshold
 * and each refusal is a test rather than a hope (the rule `monitor` and the
 * smoke test already follow). A finding is `{ status, message, hint? }` with a
 * status of the reporter: ok, warn, fail, todo, skip.
 *
 * What is judged is what is PROPER TO ONE SHOP. What the core proves — the
 * payment flow, stock, isolation, the security and browser gates on the
 * pilot, the restore — was certified once, by the pilot's campaign, and is
 * re-proven at every version by `npm run verify` and the pilot's nightly run
 * (docs/certification/par-boutique.md). A shop inherits it while it carries a
 * published core version at least as recent as the certified floor, and
 * diverges from no core file it has not named.
 */
import { compareVersions } from '../version.mjs';
import { FLEET_FILE } from '../fleet.mjs';

/** The oldest core version a shop may be certified on: the pilot's campaign
 *  closed on it (2026-10-27). Raised only for a security fix. */
export const CERTIFIED_FLOOR = '0.3.28';

/**
 * Core files a shop may not diverge from and still inherit the certification:
 * payment, stock, authentication, secrets and the schema. A shop that edits
 * one has changed what the campaign proved, and goes back to it.
 */
export const SENSITIVE_CORE = [
  /^migrations\//,
  /^src\/middleware\.ts$/,
  /^src\/features\/(payments|orders|refunds|auth|secrets|digitalDelivery)\//,
  /^src\/features\/products\/stock\.ts$/,
  /^src\/pages\/api\/(checkout|webhook)(\.ts|\/)/,
];

/** Lighthouse mobile, as the campaign measured it (plan §8.6): ≥ 90 in
 *  performance, accessibility and SEO; LCP, CLS and INP recorded. */
export const LIGHTHOUSE_MIN = 0.9;
export const LIGHTHOUSE_CATEGORIES = { performance: 'performance', accessibility: 'accessibilité', seo: 'SEO' };

/** How old the nightly's production jobs may be. Two backups a day, one
 *  watch; GitHub has started a scheduled run five hours late (step 11). */
export const NIGHTLY_MAX_AGE_HOURS = 30;

/** The four pages of migration 0040, which every French shop publishes. */
export const LEGAL_PAGES = {
  'conditions-generales-de-vente': 'conditions générales de vente',
  'mentions-legales': 'mentions légales',
  'politique-de-confidentialite': 'politique de confidentialité',
  'droit-de-retractation': 'droit de rétractation',
};

/** Twin of INCOMPLETE_MARKER in src/features/pages/completeness.ts, which the
 *  build-less CLI cannot import; test/scripts/certify.test.mjs pins the two. */
export const INCOMPLETE_MARKER = '[À COMPLÉTER';

/** The draft banner migration 0040 opens each skeleton with, as rendered. */
export const DRAFT_BANNER = '<strong>Brouillon.</strong>';

const ok = (message, hint) => ({ status: 'ok', message, ...(hint ? { hint } : {}) });
const warn = (message, hint) => ({ status: 'warn', message, ...(hint ? { hint } : {}) });
const fail = (message, hint) => ({ status: 'fail', message, ...(hint ? { hint } : {}) });
const skip = (message, hint) => ({ status: 'skip', message, ...(hint ? { hint } : {}) });
const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;

/**
 * The core version and the shop's divergences from it.
 *
 * @param {ReturnType<import('../commands/core.mjs').coreState>} state
 * @param {{ declared: { divergences: number, reason: string }|null, floor?: string }} options
 */
export function judgeCore(state, { declared, floor = CERTIFIED_FLOOR }) {
  const findings = [];
  const { core } = state;
  if (!core.remote) findings.push(fail('pas de remote « core » : cette boutique ne reçoit pas les versions du socle.', 'git remote add core <dépôt du socle> (ADR 0003).'));
  if (core.merged === null) {
    findings.push(fail('aucun tag du socle n\'est fusionné dans HEAD : la version embarquée est inconnue.'));
    return findings;
  }
  if (!core.declaresMerged) {
    findings.push(fail(`le manifeste déclare ${core.declared} et l'historique porte ${core.mergedTag}.`, '`shopctl core status` dit lequel corriger.'));
  }
  if (compareVersions(core.merged, floor) < 0) {
    findings.push(fail(
      `${core.mergedTag} précède la dernière version certifiée (v${floor}).`,
      `Montez la boutique : npm run shopctl -- core upgrade --to v${core.latest ?? floor}.`,
    ));
  } else if (core.declaresMerged) {
    findings.push(ok(`socle ${core.mergedTag}, déclaré, fusionné et certifié (plancher v${floor}).`));
  }
  if (state.tags.published === null) {
    findings.push(skip('les tags publiés du socle n\'ont pas pu être lus : rien ne dit que cette version est publiée.', 'Vérifiez l\'accès au remote « core » et relancez.'));
  } else if (!state.tags.published.includes(core.mergedTag)) {
    findings.push(fail(`${core.mergedTag} n'est pas un tag publié du socle.`));
  } else if (core.behind.length > 0) {
    findings.push(warn(`${plural(core.behind.length, 'version')} de retard : ${core.behind.join(', ')}.`, 'Certifiable tel quel ; la prochaine mise à niveau se fait par `shopctl core upgrade`.'));
  }

  const drift = state.drift;
  if (drift.length === 0) {
    findings.push(ok(`aucun fichier du socle modifié depuis ${core.mergedTag}.`));
  } else {
    const sensitive = drift.filter((entry) => SENSITIVE_CORE.some((pattern) => pattern.test(entry.path)));
    const listed = (entries) => `${entries.slice(0, 5).map((entry) => entry.path).join(', ')}${entries.length > 5 ? ', …' : ''}`;
    if (sensitive.length > 0) {
      findings.push(fail(
        `${plural(sensitive.length, 'fichier')} de paiement, de stock, d'authentification ou de schéma modifié${sensitive.length > 1 ? 's' : ''} : ${listed(sensitive)}.`,
        'Ce que la campagne a prouvé ne vaut plus pour cette boutique : la modification rejoint le socle, ou se certifie à part (docs/certification/par-boutique.md).',
      ));
    } else if (declared && declared.divergences === drift.length) {
      findings.push(warn(`${plural(drift.length, 'fichier')} du socle modifié${drift.length > 1 ? 's' : ''}, déclaré${drift.length > 1 ? 's' : ''} : ${listed(drift)} — ${declared.reason}`));
    } else {
      findings.push(fail(
        `${plural(drift.length, 'fichier')} du socle modifié${drift.length > 1 ? 's' : ''} sans déclaration${declared ? ` (les attestations en déclarent ${declared.divergences})` : ''} : ${listed(drift)}.`,
        'Nommez-les dans la section core des attestations, avec leur raison, ou rendez-les au socle.',
      ));
    }
  }
  if (!state.worktree.clean) {
    findings.push(warn(`arbre de travail modifié (${plural(state.worktree.dirty.length, 'fichier')}) : le rapport juge ce qui est sur le disque, pas ce qui est versionné.`));
  }
  return findings;
}

/** A domain that names no shop: RFC 2606's, and the placeholder `shopctl new` writes. */
export function isPlaceholderDomain(host) {
  const name = String(host ?? '').toLowerCase();
  return !name || /(^|\.)example(\.[a-z]+)?$/.test(name) || /\.(test|invalid|localhost)$/.test(name);
}

/** What the manifest alone says. */
export function judgeManifest(manifest) {
  const findings = [];
  const domain = manifest.cloudflare?.productionDomain;
  if (isPlaceholderDomain(domain)) {
    findings.push(fail(`cloudflare.productionDomain est « ${domain ?? '(vide)'} », un domaine d'exemple.`, 'Le domaine du commerçant, avant le déploiement de production.'));
  } else {
    findings.push(ok(`domaine de production : ${domain}`));
  }
  const strategy = manifest.commerce?.invoiceStrategy;
  if (strategy === 'pending-validation') {
    findings.push(fail(
      'commerce.invoiceStrategy est encore pending-validation.',
      'stripe-receipt ou invoice, selon la réponse de l\'expert-comptable du commerçant (docs/operations/mise-en-ligne.md).',
    ));
  } else {
    findings.push(ok(`facturation : ${strategy}`));
  }
  return findings;
}

/**
 * The account, from `provision --dry-run --json`: every resource there, in its
 * jurisdiction, the private buckets private; and the Worker's own secrets.
 *
 * @param {object} result provision's JSON document
 * @param {string[]|null} workerSecrets names, or null when the Worker does not exist
 * @param {string[]} required the internal secrets provisioning sets
 */
export function judgeAccount(result, workerSecrets, required) {
  const findings = [ok(`compte ${result.account.name} (${result.account.id})`)];
  const missing = (result.steps ?? []).filter((step) => step.action === 'create');
  if (missing.length > 0) {
    findings.push(fail(`${missing.map((step) => `${step.resource} ${step.name}`).join(', ')} absent${missing.length > 1 ? 's' : ''} du compte.`, 'La production n\'est pas provisionnée : `shopctl provision --env production`.'));
  } else {
    findings.push(ok(`base et buckets présents (${(result.steps ?? []).length} ressources)`));
  }
  // A dry run that found a FOREIGN marker refused before writing its document,
  // so what reaches here is own or unmarked (ADR 0019).
  if (result.owner?.verdict === 'own') {
    findings.push(ok(`base marquée pour cette boutique${result.owner.repository ? ` (${result.owner.repository})` : ''}`));
  } else if (result.owner?.verdict === 'unmarked' && missing.length === 0) {
    findings.push(warn('la base ne porte pas le marqueur de sa boutique (ADR 0019).', '`shopctl provision --env production` le pose.'));
  }
  for (const check of result.jurisdictionChecks ?? []) {
    if (check.ok === false) findings.push(fail(`${check.resource} hors de la juridiction ${check.expected}.`, 'Une juridiction ne se change pas (ADR 0004).'));
    else if (check.ok === null) findings.push(warn(`${check.resource} : juridiction non publiée par l'API, à confirmer dans le tableau de bord.`));
  }
  if ((result.jurisdictionChecks ?? []).length > 0 && (result.jurisdictionChecks ?? []).every((check) => check.ok === true)) {
    findings.push(ok(`juridiction ${result.jurisdiction} relue sur chaque ressource`));
  }
  for (const [label, exposure] of [['fichiers', result.exposure?.files], ['sauvegardes', result.exposure?.backups]]) {
    if (!exposure) continue;
    if (!exposure.known) findings.push(warn(`bucket des ${label} : exposition publique illisible, à vérifier dans le tableau de bord.`));
    else if (exposure.public) findings.push(fail(`le bucket des ${label} est public (${exposure.devUrl ?? exposure.domains.join(', ')}).`, 'Coupez l\'URL r2.dev et détachez le domaine.'));
    else findings.push(ok(`bucket des ${label} privé`));
  }
  // Served through the SaaS zone (ADR 0019): the domain reaches the shop only
  // once the merchant's CNAME is in and the certificate issued.
  if (result.hostname) {
    const { hostname } = result;
    if (hostname.action === null) findings.push(warn(`${hostname.hostname} : nom d'hôte non vérifié, CLOUDFLARE_API_TOKEN absent.`));
    else if (hostname.active) findings.push(ok(`${hostname.hostname} servi par la zone ${hostname.zone}, certificat actif`));
    else {
      findings.push(fail(
        `${hostname.hostname} n'est pas actif sur la zone ${hostname.zone} (état ${hostname.status ?? 'absent'}, certificat ${hostname.ssl ?? 'absent'}).`,
        `CNAME ${hostname.hostname} → ${hostname.cname ?? `l'origine de repli de ${hostname.zone}`} dans le DNS du commerçant, puis \`shopctl provision --env production\`.`,
      ));
    }
  }
  if (result.exposure?.images?.devUrl && (result.exposure.images.domains ?? []).length === 0) {
    findings.push(warn('les images sont servies par une URL r2.dev, qui n\'est pas un domaine de production.'));
  }
  if (result.retention?.action !== 'keep') {
    findings.push(warn(
      result.retention?.action === 'update'
        ? 'règle de conservation des sauvegardes antérieure à v0.3.32 : le pool de médias ne peut pas servir.'
        : 'règles de conservation des sauvegardes absentes ou illisibles.',
      '`shopctl provision --env production` les pose : archives à 90 jours par leur préfixe, pool de médias à 180.',
    ));
  }
  if (workerSecrets === null) {
    findings.push(fail(`le Worker ${result.resources?.worker ?? 'de production'} n'est pas déployé.`));
  } else {
    const absent = required.filter((name) => !workerSecrets.includes(name));
    if (absent.length > 0) findings.push(fail(`secrets internes absents du Worker : ${absent.join(', ')}.`, '`shopctl provision --env production` les pose sans toucher aux présents.'));
    else findings.push(ok(`secrets internes du Worker présents (${required.join(', ')})`));
  }
  return findings;
}

/** Turnstile's documented test site keys: always pass, always block, or always
 *  challenge — never a protection. */
const TURNSTILE_TEST_KEY = /^[123]x0{20,}[A-Z]{2}$/;

/**
 * The production database's settings, masked before they left it: a secret,
 * the password hash and the alert recipient come back as `set` or empty, the
 * sender as its domain only (`domain:<host>`).
 *
 * @param {Array<{ key: string, value: string }>} rows
 * @param {{ storeConfig: string|null }} options the text of src/store.config.ts,
 *   for the build-time sender and recipient a shop may set there instead
 */
export function judgeSettings(rows, { storeConfig }) {
  const settings = new Map(rows.map((row) => [row.key, row.value ?? '']));
  const set = (key) => settings.get(key) === 'set';
  const findings = [];

  findings.push(settings.get('setup_complete') === '1'
    ? ok('assistant d\'installation terminé')
    : fail('l\'assistant d\'installation n\'est pas terminé.', 'Ouvrez /admin/setup sur la production.'));
  findings.push(set('admin_password_hash')
    ? ok('mot de passe d\'administration posé')
    : fail('aucun mot de passe d\'administration : l\'assistant est ouvert à qui le trouve.', '`shopctl admin password --env production` le pose sans assistant ouvert.'));

  const disabled = new Set((settings.get('payment_methods_disabled') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
  const stripe = set('enc:stripe_secret_key') && set('enc:stripe_webhook_secret');
  if (!stripe) {
    const absent = ['enc:stripe_secret_key', 'enc:stripe_webhook_secret'].filter((key) => !set(key)).map((key) => key.slice(4));
    findings.push(fail(`Stripe n'est pas configuré : ${absent.join(' et ')} absent${absent.length > 1 ? 's' : ''} du coffre.`, 'Réglages → Paiements, clés live du commerçant et secret du webhook.'));
  } else if (disabled.has('stripe')) {
    findings.push(fail('Stripe est configuré mais coupé dans Réglages → Paiements.'));
  } else {
    findings.push(ok('Stripe configuré : clé secrète et secret de webhook dans le coffre ; la démonstration est retirée'));
  }
  if (settings.get('cart_enabled') === '0') {
    findings.push(warn('le panier est coupé : la boutique est un catalogue et ne prend aucune commande.'));
  }

  if (settings.get('email_enabled') === '0') {
    findings.push(fail('les e-mails sont coupés : aucun acheteur ne reçoit sa confirmation.', 'Réglages → E-mail.'));
  } else if (settings.get('email_provider') === 'cloudflare') {
    findings.push(ok('e-mails par Cloudflare Email Service'));
  } else {
    findings.push(set('enc:resend_api_key')
      ? ok('clé Resend dans le coffre')
      : fail('les e-mails passent par Resend et sa clé est absente du coffre.', 'Réglages → E-mail.'));
  }

  const sender = senderDomain(settings.get('email_from'), storeConfig);
  if (!sender || sender === 'resend.dev') {
    findings.push(fail(
      // Named without its address: a committed report masks every address.
      `l'expéditeur est ${sender ? 'l\'adresse de test de Resend, sur resend.dev' : 'illisible'} : rien ne part vers un acheteur.`,
      'Réglages → E-mail, une adresse d\'un domaine vérifié chez Resend.',
    ));
  } else {
    findings.push(ok(`expéditeur sur ${sender}`));
  }

  const recipient = set('email_notify_to') || /\bnotifyTo\s*:\s*(['"`])[^'"`\s]+\1/.test(storeConfig ?? '');
  findings.push(recipient
    ? ok('destinataire des alertes de commande renseigné')
    : fail('personne n\'est prévenu d\'une commande : aucun destinataire des alertes.', 'Réglages → E-mail, « prévenir à chaque commande ».'));

  if (settings.get('turnstile_enabled') !== '1') {
    findings.push(fail('Turnstile est coupé : les formulaires publics ne sont pas protégés des robots.', 'Réglages → Protection anti-robots.'));
  } else if (TURNSTILE_TEST_KEY.test(settings.get('turnstile_site_key') ?? '')) {
    findings.push(fail('Turnstile tourne avec une clé de test, qui ne protège rien.', 'Un widget du compte Cloudflare du commerçant, pour le domaine de production.'));
  } else if (!set('enc:turnstile_secret_key')) {
    findings.push(fail('Turnstile est actif sans sa clé secrète : chaque formulaire protégé est refusé.'));
  } else {
    findings.push(ok('Turnstile actif, clé du site et clé secrète posées'));
  }
  return findings;
}

/** The sender's domain: the runtime setting, else store.config.ts, else the
 *  core default, which is Resend's test sender. */
function senderDomain(setting, storeConfig) {
  if (setting) {
    if (!setting.startsWith('domain:')) return null;
    return setting.slice('domain:'.length).replace(/[>\s].*$/, '').toLowerCase() || null;
  }
  const built = String(storeConfig ?? '').match(/\bfrom\s*:\s*(['"`])[^'"`@]*@([^'"`>\s]+)/);
  return built ? built[2].toLowerCase() : 'resend.dev';
}

/**
 * The home page and the legal pages, as a buyer and a search engine get them.
 *
 * @param {{ home: { status: number|null, body: string }, pages: Record<string, { status: number|null, body: string }> }} answers
 */
export function judgePages({ home, pages }) {
  const findings = [];
  if (home.status !== 200) {
    findings.push(fail(`l'accueil répond ${home.status ?? 'rien'}.`));
  } else if (/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(home.body)) {
    findings.push(fail('la vitrine demande encore aux moteurs de ne pas l\'indexer : aucun moyen de paiement réel n\'y est ouvert.', 'Stripe live dans Réglages → Paiements ouvre la boutique (ADR 0015).'));
  } else {
    findings.push(ok('vitrine ouverte aux moteurs de recherche'));
  }
  for (const [slug, name] of Object.entries(LEGAL_PAGES)) {
    const page = pages[slug] ?? { status: null, body: '' };
    const linked = new RegExp(`href=["'](?:https?://[^"'/]+)?/pages/${slug}/?["']`).test(home.body);
    if (page.status !== 200) {
      findings.push(fail(`${name} : /pages/${slug} répond ${page.status ?? 'rien'} — page non publiée.`, 'Admin → Pages, puis Admin → Navigation pour le pied de page.'));
    } else if (page.body.normalize('NFC').includes(INCOMPLETE_MARKER)) {
      findings.push(fail(`${name} : la page porte encore un ${INCOMPLETE_MARKER}].`));
    } else if (page.body.includes(DRAFT_BANNER)) {
      findings.push(fail(`${name} : la page porte encore le bandeau « Brouillon ».`));
    } else if (!linked) {
      findings.push(fail(`${name} : publiée, mais absente du pied de page de l'accueil.`, 'Admin → Navigation, menu du pied de page.'));
    } else {
      findings.push(ok(`${name} publiée, complète, au pied de page`));
    }
  }
  return findings;
}

/**
 * One page's PageSpeed Insights answer.
 *
 * @param {string} label e.g. « accueil »
 * @param {object} document the API's JSON
 */
export function judgeLighthouse(label, document) {
  const result = document?.lighthouseResult;
  if (!result) return skip(`Lighthouse, ${label} : PageSpeed Insights n'a pas rendu de rapport.`);
  if (result.runtimeError?.code) return skip(`Lighthouse, ${label} : ${result.runtimeError.code}.`, String(result.runtimeError.message ?? '').slice(0, 200));
  const scores = Object.fromEntries(Object.keys(LIGHTHOUSE_CATEGORIES).map((id) => [id, result.categories?.[id]?.score ?? null]));
  const shown = Object.values(scores).map((score) => (score === null ? '?' : Math.round(score * 100))).join(' / ');
  const lcp = result.audits?.['largest-contentful-paint']?.numericValue;
  const cls = result.audits?.['cumulative-layout-shift']?.numericValue;
  const inp = document.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile;
  const measures = [
    typeof lcp === 'number' ? `LCP ${(lcp / 1000).toFixed(1).replace('.', ',')} s` : null,
    typeof cls === 'number' ? `CLS ${cls.toFixed(2).replace('.', ',')}` : null,
    typeof inp === 'number' ? `INP ${inp} ms (terrain)` : 'INP sans données de terrain',
  ].filter(Boolean).join(', ');
  const below = Object.entries(scores).filter(([, score]) => score === null || score < LIGHTHOUSE_MIN).map(([id]) => LIGHTHOUSE_CATEGORIES[id]);
  const message = `Lighthouse mobile, ${label} — ${shown} (performance / accessibilité / SEO) ; ${measures}`;
  return below.length > 0
    ? fail(`${message}`, `${below.join(', ')} sous ${Math.round(LIGHTHOUSE_MIN * 100)} : le rapport de PageSpeed Insights dit quels audits.`)
    : ok(message);
}

/**
 * The repository: its two environments, its secrets by name, the last
 * production deployment and the nightly's production jobs.
 *
 * @param {object} read what gh answered (see `readForge` in commands/certify.mjs)
 * @param {{ slug: string, head: string|null, now: Date }} context
 */
export function judgeForge(read, { slug, head, now }) {
  const findings = [];
  const environmentSecrets = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SHOPCTL_BACKUP_KEY'];
  // On the shared account (ADR 0019) everything below is read from the fleet
  // repository, and the commands that set it up are the fleet's.
  const fleet = read.fleet ?? null;
  const setup = fleet ? 'shopctl fleet repo' : 'shopctl repo';
  if (fleet) {
    findings.push(ok(`déployée par le dépôt de flotte ${fleet.repository}`));
    const listed = fleet.entry?.repository;
    if (fleet.registry !== 'read') {
      findings.push(fail(`${FLEET_FILE} de ${fleet.repository} ${fleet.registry === 'absent' ? 'introuvable' : 'illisible'} : la flotte ne sait pas déployer ${slug}.`, '`shopctl fleet init`, puis committez et poussez le dépôt de flotte.'));
    } else if (!fleet.entry) {
      findings.push(fail(`${slug} n'est pas inscrite dans le ${FLEET_FILE} de ${fleet.repository}.`, `Ajoutez { "slug": "${slug}", "path": "…", "repository": "${fleet.shop}" }, committez et poussez.`));
    } else if (!listed || listed.toLowerCase() !== fleet.shop.toLowerCase()) {
      findings.push(fail(`le ${FLEET_FILE} de ${fleet.repository} inscrit ${slug} ${listed ? `avec le dépôt ${listed}` : 'sans dépôt'}, pas ${fleet.shop}.`, `"repository": "${fleet.shop}".`));
    } else {
      findings.push(ok(`inscrite dans le ${FLEET_FILE} de ${fleet.repository}`));
    }
    findings.push(fleet.leftovers.length > 0
      ? fail(
        `le dépôt de la boutique porte encore ${fleet.leftovers.map((entry) => `${entry.name}${entry.env ? ` (${entry.env})` : ''}`).join(', ')} : un jeton du compte mutualisé ouvre toutes les boutiques.`,
        fleet.leftovers.map((entry) => `gh secret delete ${entry.name}${entry.env ? ` --env ${entry.env}` : ''} --repo ${fleet.shop}`).join(' ; '),
      )
      : ok('aucun secret Cloudflare dans le dépôt de la boutique'));
  }

  const production = read.environments.production;
  if (!production) {
    findings.push(fail('pas d\'environnement production sur le dépôt.', `\`${setup}\` le crée, avec ses secrets.`));
  } else {
    findings.push(production.reviewers > 0
      ? ok(`environnement production : ${plural(production.reviewers, 'relecteur')} obligatoire${production.reviewers > 1 ? 's' : ''}`)
      : warn('environnement production sans relecteur obligatoire : un déploiement de production part sans approbation.', `\`${setup} --reviewer <login>\`.`));
  }
  const backup = read.environments.backup;
  if (!backup) {
    findings.push(fail('pas d\'environnement backup : la production n\'est pas sauvegardée chaque nuit.', `\`${setup}\` avec CLOUDFLARE_API_TOKEN_BACKUP.`));
  } else if (!backup.customBranches || backup.branches.length !== 1 || backup.branches[0] !== read.defaultBranch) {
    findings.push(fail(`l'environnement backup n'est pas limité à ${read.defaultBranch} (${backup.customBranches ? backup.branches.join(', ') || 'aucune branche' : 'toutes les branches'}).`, `Ses secrets lisent la production : \`${setup}\` le restreint.`));
  } else {
    findings.push(ok(`environnement backup limité à ${read.defaultBranch}`));
  }
  for (const name of ['production', 'backup']) {
    if (!read.environments[name]) continue;
    const absent = environmentSecrets.filter((secret) => !(read.secrets[name] ?? []).includes(secret));
    findings.push(absent.length > 0
      ? fail(`${name} : ${absent.join(', ')} absent${absent.length > 1 ? 's' : ''}.`, `\`${setup}\` les pose.`)
      : ok(`${name} : ${environmentSecrets.join(', ')} posés`));
  }
  const monitor = ['MONITOR_CLOUDFLARE_API_TOKEN', 'MONITOR_CLOUDFLARE_ACCOUNT_ID'].filter((secret) => !read.secrets.repository.includes(secret));
  findings.push(monitor.length > 0
    ? fail(`secrets du dépôt absents : ${monitor.join(', ')} — la production n'est pas surveillée.`, 'Un jeton « Account Analytics : Read » du compte de production (docs/operations/mise-en-ligne.md).')
    : ok('secrets de surveillance du dépôt posés'));

  const deploy = read.deploy;
  if (!deploy) {
    findings.push(fail(`aucun job « Deploy ${slug} (production) » dans les derniers runs du workflow Deploy.`));
  } else if (deploy.conclusion !== 'success') {
    findings.push(fail(`dernier déploiement de production : ${deploy.conclusion ?? deploy.status} (${day(deploy.at)}).`));
  } else {
    findings.push(ok(`dernier déploiement de production vert (${day(deploy.at)}, ${deploy.sha.slice(0, 7)})`));
    // A fleet's run carries the FLEET repository's commit, not the shop's.
    if (head && !fleet && deploy.sha !== head) {
      findings.push(warn(`la production porte ${deploy.sha.slice(0, 7)} et cet arbre ${head.slice(0, 7)} : le rapport juge un arbre qui n'est pas déployé.`));
    }
  }

  const nightly = (job, step, what) => {
    if (!job) return fail(`aucun job « ${what} » dans les derniers runs du Nightly.`);
    const hours = (now.getTime() - new Date(job.at).getTime()) / 3_600_000;
    const ran = job.steps.find((entry) => entry.name === step);
    if (job.conclusion !== 'success') return fail(`${what} : ${job.conclusion ?? job.status} (${day(job.at)}).`);
    if (ran?.conclusion !== 'success') return fail(`${what} : vert, mais l'étape « ${step} » n'a pas tourné — un secret manque à la nuit.`);
    if (hours > NIGHTLY_MAX_AGE_HOURS) return fail(`${what} : dernier passage vert il y a ${Math.round(hours)} h.`, `Moins de ${NIGHTLY_MAX_AGE_HOURS} h attendues : le Nightly tourne-t-il encore ?`);
    return ok(`${what} vert il y a ${Math.round(hours)} h`);
  };
  findings.push(nightly(read.nightly.backup, 'Verify the archive', 'Production backup'));
  findings.push(nightly(read.nightly.watch, 'Install dependencies', 'Production error rate and quotas'));
  return findings;
}

const day = (at) => String(at ?? '').slice(0, 10) || 'date inconnue';

/**
 * The verdict over every group: certified only when nothing failed, nothing
 * is left to attest and nothing was skipped. A warning is said, not blocking.
 */
export function verdictOf(groups) {
  const counts = { ok: 0, warn: 0, fail: 0, todo: 0, skip: 0 };
  for (const group of groups) for (const finding of group.findings) counts[finding.status] = (counts[finding.status] ?? 0) + 1;
  return { certified: counts.fail === 0 && counts.todo === 0 && counts.skip === 0, counts };
}
