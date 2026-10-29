/**
 * Which account a command is talking to, which database that environment has,
 * and a `wrangler.jsonc` that points at it.
 *
 * Three steps that always go together and must never be taken apart. The last
 * one is why: `wrangler d1 execute DB` resolves the binding through the config
 * file in the tree, so a configuration left over from the OTHER environment
 * sends the command to the other environment's database under this one's name.
 * Reading the wrong one is a leak; writing the wrong one is a shop's orders in
 * somebody else's database.
 *
 * One answer to "which database is this?", shared, rather than one per command
 * that eventually disagrees with the others.
 */
import { listDatabases, expectedAccount, resolveAccount, whoami } from './cloudflare.mjs';
import { preconditionError } from './errors.mjs';
import { resourceNames } from '../../scripts/manifest.mjs';
import { renderEnvironmentConfig } from './commands/provision.mjs';
import { guardOwner } from './owner.mjs';

/**
 * @param {object} options
 * @param {Record<string, string|boolean>} options.values the command's parsed flags
 * @param {object} options.manifest the shop's manifest
 * @param {string} options.root the shop's tree
 * @param {string} options.env the environment named on the command line
 * @param {import('./report.mjs').Reporter} options.reporter
 * @param {string} options.missing what the operator is told is not there, when the
 *   database is not there — a command's own sentence, because "there is nothing
 *   to back up" and "there is nobody to export" are different problems.
 * @returns {{ account: object, names: object, databaseId: string }}
 */
export function openEnvironment({ values, manifest, root, env, reporter, missing }) {
  reporter.section('Compte Cloudflare');
  const account = resolveAccount(
    expectedAccount(manifest, env, values),
    whoami({ cwd: root }),
  );
  reporter.ok(`${account.name} (${account.id})`);

  const names = resourceNames(manifest, { env });
  const database = listDatabases({ cwd: root }).find((entry) => entry.name === names.database);
  if (!database) {
    throw preconditionError(
      `${names.database} n'existe pas sur ce compte.`,
      `${missing} \`shopctl provision --env ${env}\` crée les ressources.`,
    );
  }
  const databaseId = database.uuid ?? database.database_id;
  // Before the configuration points `DB` at it: on a shared account (ADR 0019)
  // a database found by its name has to be proven this shop's.
  guardOwner({ database: names.database, root, manifest, env, reporter });

  renderEnvironmentConfig({ root, manifest, env, databaseId });
  reporter.ok(`wrangler.jsonc rendu pour ${names.worker}`);
  return { account, names, databaseId };
}
