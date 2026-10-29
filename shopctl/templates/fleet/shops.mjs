// __GENERATED__
//
// What the fleet's workflows ask of fleet.json and of a shop's tree, in one
// place rather than inline in each job. No dependency: it runs before any
// `npm ci`, on whatever Node the runner has.
//
//   node .github/fleet/shops.mjs repository <slug>   repository=<owner/repo>
//   node .github/fleet/shops.mjs matrix              matrix=[{ slug, repository }]
//   node .github/fleet/shops.mjs core <dir>          refuses a shop below the floor
//
// Every line it prints to stdout is a `key=value` for $GITHUB_OUTPUT; anything
// else goes to stderr as a workflow command.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The oldest core that carries the owner marker of ADR 0019. */
const MINIMUM_CORE = '__MINIMUM_CORE__';

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function stop(message) {
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}

function registry() {
  let document;
  try {
    document = JSON.parse(readFileSync(new URL('../../fleet.json', import.meta.url), 'utf8'));
  } catch (error) {
    stop(`fleet.json illisible : ${error.message}`);
  }
  if (!Array.isArray(document?.shops)) stop('fleet.json ne déclare aucune boutique (shops).');
  return document.shops;
}

/** A shop the workflows can reach: a valid slug and a repository to check out. */
function reachable(entry) {
  return SLUG.test(String(entry?.slug ?? '')) && REPOSITORY.test(String(entry?.repository ?? ''));
}

const numbers = (version) => String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
function below(version, floor) {
  const [a, b] = [numbers(version), numbers(floor)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

const [command, argument] = process.argv.slice(2);

if (command === 'repository') {
  const shop = registry().find((entry) => entry?.slug === argument);
  if (!shop) stop(`« ${argument} » n'est pas une boutique de fleet.json.`);
  if (!reachable(shop)) stop(`« ${argument} » n'a pas de dépôt (repository: propriétaire/dépôt) dans fleet.json.`);
  process.stdout.write(`repository=${shop.repository}\n`);
} else if (command === 'matrix') {
  const shops = registry();
  for (const entry of shops.filter((candidate) => !reachable(candidate))) {
    process.stderr.write(`::warning::${String(entry?.slug ?? '(sans slug)')} : pas de dépôt dans fleet.json, ni sauvegardée ni surveillée par la flotte.\n`);
  }
  const matrix = shops.filter(reachable).map((entry) => ({ slug: entry.slug, repository: entry.repository }));
  process.stdout.write(`matrix=${JSON.stringify(matrix)}\n`);
} else if (command === 'core') {
  let version;
  try {
    version = JSON.parse(readFileSync(join(argument ?? '.', 'package.json'), 'utf8')).version;
  } catch (error) {
    stop(`version du socle illisible dans ${argument} : ${error.message}`);
  }
  if (below(version, MINIMUM_CORE)) {
    stop(`la boutique est sur le socle ${version} ; le compte mutualisé demande ${MINIMUM_CORE} au moins, qui marque chaque base à sa boutique (ADR 0019). Montez-la (shopctl core upgrade) avant de la déployer ou de la sauvegarder d'ici.`);
  }
  process.stdout.write(`core=${version}\n`);
} else {
  stop(`commande inconnue : ${command ?? '(aucune)'}. Attendu : repository, matrix ou core.`);
}
