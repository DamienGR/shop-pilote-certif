/**
 * `shopctl doctor` — is this machine, and this tree, in a state that can create
 * and operate a shop?
 *
 * Three tiers, and keeping them apart is the whole value of the command.
 *
 * FAIL is something the operator cannot proceed without and can fix in a
 * minute: a Node outside the certified line, no git, no git identity to commit
 * with. WARN is a prerequisite of a LATER step — provisioning is jalon 6 — that
 * would be a lie to report as broken today. TODO is the checklist: account
 * ownership, R2 activation, Stripe onboarding. Those stay human in the first
 * version (plan §5.3), and a CLI that pretended to verify them would be worse
 * than one that names them.
 *
 * The checks that duplicate an existing gate WRAP it. Reimplementing the
 * toolchain range or the manifest rules here would give the fleet two answers
 * to one question, and it is the CLI the operator believes.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CORE_ROOT } from '../paths.mjs';
import { ShopctlError } from '../errors.mjs';
import { capture, isAvailable } from '../process.mjs';

export const doctorUsage = `Usage: shopctl doctor [--offline] [--json]

  --offline   N'interroge aucun service distant (saute \`wrangler whoami\`).
  --json      Rapport lisible par une machine.
`;

/**
 * What a human still has to do, in order, and why no CLI checks it.
 *
 * Account creation, user invitations and Stripe activation stay manual in the
 * first version (plan §5.3). They are listed rather than silently assumed
 * because every one of them is discovered at the worst possible moment — the
 * first provisioning run, against a real account.
 */
export const HUMAN_CHECKLIST = [
  ['compte Cloudflare de l\'agence pour la construction et la preview, compte du commerçant pour la saisie et la production (ADR 0002, ADR 0015)', 'Cloudflare ne transfère rien entre comptes : le compte du commerçant doit exister avant qu\'il saisisse quoi que ce soit.'],
  ['R2 activé sur chaque compte avant tout provisioning', 'La création d\'un bucket échoue tant que R2 n\'a pas été activé une première fois dans le tableau de bord.'],
  ['membres de l\'équipe invités sur chaque compte', 'Un compte à un seul accès est un point de défaillance unique.'],
  ['compte Stripe activé, en mode test puis en mode live', 'L\'activation Stripe demande des pièces justificatives et prend des jours ouvrés.'],
  ['nom d\'hôte de preview dans une zone du compte de l\'agence, derrière une application Access', 'cloudflare.stagingDomain ferme workers.dev ; sans application Access sur ce nom, la preview est publique. Son nom d\'équipe et son AUD vont dans cloudflare.stagingAccessTeam et cloudflare.stagingAccessAud.'],
  ['un widget Turnstile sur les noms d\'hôte de la boutique', 'Ses deux clés se saisissent dans Admin → Réglages → Protection.'],
  ['domaine de production dans une zone du compte du commerçant', 'Le domaine personnalisé d\'un Worker demande une zone active sur le compte qui porte ce Worker.'],
  ['domaine d\'expédition vérifié chez le fournisseur d\'e-mail', 'Sans SPF/DKIM alignés, les confirmations de commande partent en spam.'],
  ['GitHub Pro au minimum sur le compte qui porte le dépôt de la boutique, ou un dépôt public (`shopctl repo --public`)', 'Un dépôt privé n\'a pas de secrets d\'environnement sous GitHub Free ; les relecteurs obligatoires y demandent Enterprise. Un dépôt public a les deux sous tous les plans, et publie le socle avec son historique.'],
  ['un jeton API Cloudflare par environnement, limité à son compte et à sa zone', 'shopctl repo les pose (CLOUDFLARE_API_TOKEN_STAGING, CLOUDFLARE_API_TOKEN_PRODUCTION) ; un jeton commun donne au staging les droits de la production.'],
];

/** The tree doctor is describing. Neither shape is an error: the core is where
 *  shops are created, a shop is where they are operated. */
function describeTree(cwd) {
  if (existsSync(resolve(cwd, 'client/client.yaml'))) return { kind: 'shop', root: cwd };
  if (existsSync(resolve(cwd, 'scripts/check-manifest.mjs'))) return { kind: 'core', root: cwd };
  return { kind: 'none', root: cwd };
}

export function runDoctor(args, reporter) {
  const offline = args.values['--offline'] === true;
  const cwd = process.cwd();
  const tree = describeTree(cwd);

  reporter.section('Outils');

  // The toolchain gate, not a second opinion on it. It lives in the core, and
  // in a shop it is the shop's own copy: a shop is certified on the Node line
  // ITS core version declares, not on the one this CLI happens to sit next to.
  const toolchainScript = existsSync(resolve(tree.root, 'scripts/check-toolchain.mjs'))
    ? resolve(tree.root, 'scripts/check-toolchain.mjs')
    : resolve(CORE_ROOT, 'scripts/check-toolchain.mjs');
  const toolchain = capture('node', [toolchainScript], { cwd: tree.root, allowFailure: true });
  if (toolchain.status === 0) reporter.ok(toolchain.stdout.trim().replace(/^✓ /, ''));
  else reporter.fail(toolchain.stderr.trim().replace(/^✗ /, '') || 'toolchain refusée', 'Voir .nvmrc et le champ "engines".');

  if (isAvailable('git')) {
    const version = capture('git', ['--version'], { allowFailure: true }).stdout.trim();
    reporter.ok(version.toLowerCase().startsWith('git') ? version : `git ${version}`);
  } else {
    reporter.fail('git est absent du PATH.', 'Une boutique est un dépôt Git cloné depuis un tag du socle (ADR 0003).');
  }

  // An identity is not cosmetic here: `shopctl new` commits the shop's first
  // state. `git var GIT_AUTHOR_IDENT` is git's own resolution — config,
  // GIT_AUTHOR_* environment variables, auto-detect — which is what makes this
  // report agree with what `git commit` will actually do. Reading `user.name`
  // instead would call a working CI runner broken, and a broken one working.
  const identity = capture('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: tmpdir(), allowFailure: true });
  if (identity.status === 0 && identity.stdout.trim()) {
    // "Name <email> 1712345678 +0200" — the timestamp is noise in a report.
    reporter.ok(`identité Git résolue (${identity.stdout.trim().replace(/>\s+\S+\s+\S+$/, '>')})`);
  } else {
    reporter.fail(
      'git n\'a aucune identité pour signer un commit.',
      'git config --global user.name "…" && git config --global user.email "…" — ou GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL en CI. Sans elle, le premier commit de la boutique échoue après le clone.',
    );
  }

  reporter.section('Arbre courant');
  if (tree.kind === 'shop') {
    reporter.ok(`boutique (client/client.yaml présent) dans ${tree.root}`);
    const remotes = capture('git', ['remote'], { cwd: tree.root, allowFailure: true }).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (remotes.includes('core')) reporter.ok('remote "core" configuré');
    else reporter.fail('aucun remote "core".', 'La mise à niveau récupère un tag du socle sur ce remote (ADR 0003) : git remote add core <url>.');
    if (remotes.includes('origin')) reporter.ok('remote "origin" configuré');
    else reporter.warn('aucun remote "origin".', 'Le dépôt de la boutique n\'est poussé nulle part : git remote add origin <url>.');

    const gate = resolve(tree.root, 'scripts/check-manifest.mjs');
    const manifest = capture('node', [gate], { cwd: tree.root, allowFailure: true });
    if (manifest.status === 0) reporter.ok('manifeste valide');
    else reporter.fail('le manifeste ne passe pas la validation.', 'Détail : shopctl config validate.');
  } else if (tree.kind === 'core') {
    reporter.ok(`socle (aucun client/client.yaml) dans ${tree.root}`);
    reporter.step('    C\'est ici que les boutiques sont créées : shopctl new <slug>.');
  } else {
    reporter.warn(
      `${tree.root} n'est ni une boutique ni un socle.`,
      'Les commandes d\'exploitation attendent la racine d\'un des deux.',
    );
  }

  reporter.section('Prérequis de la forge (jalon 6)');
  // WARN rather than FAIL, on the same reasoning as wrangler below: `gh` is a
  // prerequisite of `shopctl repo`, not of the tree in front of us. A shop that
  // already has its repository never needs it again.
  if (isAvailable('gh', ['--version'])) {
    const version = capture('gh', ['--version'], { allowFailure: true }).stdout.trim().split('\n')[0];
    reporter.ok(version || 'gh installé');
    if (offline) {
      reporter.warn('session GitHub non vérifiée (--offline).');
    } else if (capture('gh', ['auth', 'status'], { allowFailure: true }).status === 0) {
      reporter.ok('session GitHub active (gh auth status)');
    } else {
      reporter.warn('gh n\'est pas authentifié.', 'gh auth login — ou GH_TOKEN en CI. Sans lui, `shopctl repo` ne peut ni créer le dépôt ni poser les secrets d\'environnement.');
    }
  } else {
    reporter.warn(
      'gh (GitHub CLI) n\'est pas installé.',
      'https://cli.github.com — `shopctl repo` l\'enveloppe pour créer le dépôt, ses environnements et leurs secrets (ADR 0014). Le reste de la CLI n\'en a pas besoin.',
    );
  }

  reporter.section('Prérequis de provisioning (jalon 6)');
  const wranglerBin = resolve(tree.root, 'node_modules/.bin/wrangler');
  if (existsSync(wranglerBin)) {
    const version = capture(wranglerBin, ['--version'], { cwd: tree.root, allowFailure: true }).stdout.trim().split('\n').pop();
    reporter.ok(`wrangler installé (${version || 'version inconnue'})`);
    if (offline) {
      reporter.warn('compte Cloudflare non vérifié (--offline).');
    } else {
      const whoami = capture(wranglerBin, ['whoami'], { cwd: tree.root, allowFailure: true });
      if (whoami.status === 0) reporter.ok('session Cloudflare active (wrangler whoami)');
      else {
        reporter.warn(
          'wrangler n\'est pas authentifié.',
          'npx wrangler login — ou, sous WSL2 avec un navigateur Windows, node scripts/wrangler-login-wsl.mjs.',
        );
      }
    }
  } else {
    reporter.warn('wrangler n\'est pas installé dans cet arbre.', 'npm ci — le provisioning et le déploiement passent tous les deux par lui.');
  }

  reporter.section('À faire par un humain');
  for (const [item, why] of HUMAN_CHECKLIST) reporter.todo(item, why);

  const failures = reporter.entries.filter((entry) => entry.status === 'fail');
  const warnings = reporter.entries.filter((entry) => entry.status === 'warn');

  reporter.result({
    command: 'doctor',
    ok: failures.length === 0,
    tree: tree.kind,
    root: tree.root,
    offline,
    checks: reporter.entries.filter((entry) => entry.status !== 'todo'),
    checklist: reporter.entries.filter((entry) => entry.status === 'todo'),
    counts: { fail: failures.length, warn: warnings.length },
  });

  if (failures.length > 0) {
    throw new ShopctlError(
      `${failures.length} prérequis manquant${failures.length > 1 ? 's' : ''}.`,
      { kind: 'precondition', hint: 'Chaque ligne ✗ ci-dessus porte sa remédiation.' },
    );
  }
  reporter.section(
    warnings.length > 0
      ? `Prêt à créer une boutique. ${warnings.length} avertissement${warnings.length > 1 ? 's' : ''} à lever avant le provisioning.`
      : 'Prêt.',
  );
  return 0;
}
