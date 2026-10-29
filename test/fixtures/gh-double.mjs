#!/usr/bin/env node
/**
 * A `gh` that answers like the real one, against a GitHub account kept in a
 * JSON file.
 *
 * Same reasoning as the wrangler double: what has to be proven is the
 * CONVERSATION with the forge — that a second run creates nothing, that a
 * repository is private unless asked otherwise, that a refused protection rule
 * is reported rather than swallowed, and above all that a token never appears
 * in an argument vector. A mock would assert that shopctl calls the functions
 * shopctl calls; this runs the real argument construction and the real output
 * parsers, and only the account is imaginary.
 *
 * Literal about `gh`'s shapes: a non-zero exit for `repo view` on a repository
 * that does not exist, `gh api` answering raw JSON, `gh secret set` reading its
 * value from standard input.
 *
 * State lives at $GH_DOUBLE_STATE:
 *
 *   authenticated   boolean                 false makes `gh auth status` exit 1
 *   login           string                  what `gh api user --jq .login` says
 *   config          { git_protocol }        what `gh config get` answers
 *   hosts           { host: { git_protocol } }  what `gh config get --host` answers
 *                                           first, as `gh auth login` writes it
 *   repos           { "owner/name": { visibility, environments, secrets, variables, files, pulls, runs } }
 *                   an environment: { secrets, reviewers, branchPolicy, branches }
 *                   `secrets` at the top: the repository's own, outside any environment
 *                   `variables`: { NAME: value }, the repository's Actions variables
 *                   `files`: { path: text }, the default branch's contents
 *                   a run: { databaseId, workflow, createdAt, status, conclusion, headSha, jobs }
 *                   a job: { name, status, conclusion, completedAt, steps: [{ name, conclusion }] }
 *   users           { login: id }
 *   refuseReviewers boolean                 the free-plan private-repo refusal
 *   calls           [{ argv, stdin }]       appended to on every invocation
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const STATE = process.env.GH_DOUBLE_STATE;
if (!STATE) {
  process.stderr.write('gh-double: GH_DOUBLE_STATE is not set\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(STATE, 'utf8'));
state.calls = state.calls ?? [];
state.repos = state.repos ?? {};

const flag = (name) => {
  const index = argv.indexOf(name);
  if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1];
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
};
const has = (name) => argv.includes(name);

/** `gh secret set` and `gh api --input -` are the only commands that read
 *  stdin, and recording it is how a test proves the value arrived THERE. */
const wantsStdin = (argv[0] === 'secret' && argv[1] === 'set') || argv.includes('-');
const stdin = wantsStdin ? readStdin() : '';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

state.calls.push({ argv, stdin });
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const done = (text = '') => {
  save();
  if (text) process.stdout.write(`${text}\n`);
  process.exit(0);
};
const fail = (text, code = 1) => {
  save();
  process.stderr.write(`${text}\n`);
  process.exit(code);
};

if (argv.includes('--version')) done('gh version 2.62.0 (double)');

if (argv[0] === 'config' && argv[1] === 'get') {
  const host = flag('--host') ?? flag('-h');
  const scoped = host ? (state.hosts ?? {})[host]?.[argv[2]] : undefined;
  done(String(scoped ?? (state.config ?? {})[argv[2]] ?? ''));
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  if (state.authenticated === false) fail('You are not logged into any GitHub hosts. To log in, run: gh auth login');
  done('github.com\n  ✓ Logged in to github.com account ops (keyring)');
}

if (argv[0] === 'repo' && argv[1] === 'view') {
  const name = argv[2];
  const repo = state.repos[name];
  if (!repo) fail(`could not resolve to a Repository with the name '${name}'`);
  done(JSON.stringify({
    nameWithOwner: name,
    visibility: (repo.visibility ?? 'private').toUpperCase(),
    defaultBranchRef: repo.defaultBranch ? { name: repo.defaultBranch } : null,
    isEmpty: (repo.branches ?? []).length === 0,
  }));
}

if (argv[0] === 'repo' && argv[1] === 'create') {
  const name = argv[2];
  if (state.repos[name]) fail(`Name already exists on this account`);
  state.repos[name] = {
    visibility: has('--public') ? 'public' : 'private',
    environments: {},
    branches: [],
    description: flag('--description'),
  };
  done(`✓ Created repository ${name} on github.com\n  https://github.com/${name}`);
}

if (argv[0] === 'api') {
  const method = flag('--method') ?? 'GET';
  const path = argv.find((argument, index) => !argument.startsWith('-') && index > 0 && argv[index - 1] !== '--method');

  if (path === 'user') done(state.login ?? 'ops');

  const users = path?.match(/^users\/(.+)$/);
  if (users) {
    const id = (state.users ?? {})[users[1]];
    if (!id) fail('gh: Not Found (HTTP 404)');
    done(String(id));
  }

  const environmentList = path?.match(/^repos\/([^/]+\/[^/]+)\/environments$/);
  if (environmentList && method === 'GET') {
    const repo = state.repos[environmentList[1]];
    if (!repo) fail('gh: Not Found (HTTP 404)');
    const names = Object.keys(repo.environments ?? {});
    done(JSON.stringify({ total_count: names.length, environments: names.map((name) => ({ name })) }));
  }

  // Deployment branch policies: listed, and added one branch at a time. The
  // real API refuses a branch on an environment whose policy is not custom.
  const branchPolicies = path?.match(/^repos\/([^/]+\/[^/]+)\/environments\/([^/]+)\/deployment-branch-policies$/);
  if (branchPolicies) {
    const [, name, environment] = branchPolicies;
    const target = state.repos[name]?.environments?.[environment];
    if (!target) fail('gh: Not Found (HTTP 404)');
    target.branches = target.branches ?? [];
    if (method === 'GET') {
      done(JSON.stringify({ total_count: target.branches.length, branch_policies: target.branches.map((branch) => ({ name: branch, type: 'branch' })) }));
    }
    if (method === 'POST') {
      if (!target.branchPolicy?.custom_branch_policies) fail('gh: Not Found (HTTP 404)');
      const body = JSON.parse(stdin);
      if (target.branches.includes(body.name)) fail('gh: Validation Failed (HTTP 422)\nalready_exists');
      target.branches.push(body.name);
      done(JSON.stringify({ name: body.name, type: body.type }));
    }
  }

  // One environment, read: the shape GitHub gives it, protection rules and
  // branch policy included, from what the PUT above stored.
  const environmentGet = path?.match(/^repos\/([^/]+\/[^/]+)\/environments\/([^/]+)$/);
  if (environmentGet && method === 'GET') {
    const [, name, environment] = environmentGet;
    const target = state.repos[name]?.environments?.[environment];
    if (!target) fail('gh: Not Found (HTTP 404)');
    const reviewers = Array.from({ length: target.reviewers ?? 0 }, (_, index) => ({ type: 'User', reviewer: { id: index + 1 } }));
    done(JSON.stringify({
      name: environment,
      protection_rules: [
        ...(reviewers.length > 0 ? [{ type: 'required_reviewers', reviewers }] : []),
        ...(target.branchPolicy ? [{ type: 'branch_policy' }] : []),
      ],
      deployment_branch_policy: target.branchPolicy ?? null,
    }));
  }

  const environmentPut = path?.match(/^repos\/([^/]+\/[^/]+)\/environments\/(.+)$/);
  if (environmentPut && method === 'PUT') {
    const [, name, environment] = environmentPut;
    const repo = state.repos[name];
    if (!repo) fail('gh: Not Found (HTTP 404)');
    const body = stdin.trim() ? JSON.parse(stdin) : {};
    // The private-repository refusal under GitHub Pro or Team, which is the
    // case this whole fallback path exists for: the environment is accepted,
    // the protection rule is not (required reviewers on a private repository
    // need GitHub Enterprise).
    if (state.refuseReviewers && (body.reviewers ?? []).length > 0) {
      fail('gh: Validation Failed (HTTP 422)\nRequired reviewers are not available for private repositories on this plan.', 1);
    }
    repo.environments = repo.environments ?? {};
    repo.environments[environment] = {
      ...(repo.environments[environment] ?? { secrets: {} }),
      reviewers: (body.reviewers ?? []).length,
      // The cautious reading of the API: a PUT that names no policy leaves
      // every branch allowed, so the code under test must name it each time.
      branchPolicy: body.deployment_branch_policy ?? null,
    };
    repo.environments[environment].secrets = repo.environments[environment].secrets ?? {};
    done(JSON.stringify({ name: environment }));
  }

  // A repository variable, read as the API gives it.
  const variable = path?.match(/^repos\/([^/]+\/[^/]+)\/actions\/variables\/([^/]+)$/);
  if (variable && method === 'GET') {
    const [, name, key] = variable;
    const value = state.repos[name]?.variables?.[key];
    if (value === undefined) fail('gh: Not Found (HTTP 404)');
    done(JSON.stringify({ name: key, value }));
  }

  // A file of the default branch, base64 as the contents API sends it.
  const contents = path?.match(/^repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
  if (contents && method === 'GET') {
    const [, name, file] = contents;
    const text = state.repos[name]?.files?.[file];
    if (text === undefined) fail('gh: Not Found (HTTP 404)');
    done(JSON.stringify({ path: file, encoding: 'base64', content: Buffer.from(text).toString('base64') }));
  }

  fail(`gh-double: unhandled api call "${argv.join(' ')}"`, 2);
}

if (argv[0] === 'secret' && argv[1] === 'list') {
  const repo = state.repos[flag('--repo')];
  const environment = flag('--env');
  if (!repo) fail('gh: Not Found (HTTP 404)');
  // Without --env, the repository's own secrets, as the real gh lists them.
  const secrets = environment ? repo.environments?.[environment]?.secrets ?? {} : repo.secrets ?? {};
  if (has('--json')) done(JSON.stringify(Object.keys(secrets).map((name) => ({ name }))));
  done(Object.keys(secrets).map((name) => `${name}\t2026-08-31`).join('\n'));
}

if (argv[0] === 'secret' && argv[1] === 'set') {
  const name = argv[2];
  const repo = state.repos[flag('--repo')];
  const environment = flag('--env');
  if (!repo) fail('gh: Not Found (HTTP 404)');
  if (!stdin.trim()) fail('gh: a value is required');
  // Without --env, a secret of the repository itself.
  if (!environment) {
    repo.secrets = repo.secrets ?? {};
    repo.secrets[name] = stdin.trim();
    done(`✓ Set Actions secret ${name} for ${flag('--repo')}`);
  }
  if (!repo.environments?.[environment]) fail(`gh: environment ${environment} not found (HTTP 404)`);
  // Stored so a test can assert WHAT was placed; the real gh encrypts it as a
  // libsodium sealed box, which is precisely the step shopctl cannot do itself
  // and the reason this command is wrapped rather than reimplemented.
  repo.environments[environment].secrets[name] = stdin.trim();
  done(`✓ Set Actions secret ${name} for ${flag('--repo')}`);
}

if (argv[0] === 'variable' && argv[1] === 'set') {
  const name = argv[2];
  const repo = state.repos[flag('--repo')];
  if (!repo) fail('gh: Not Found (HTTP 404)');
  const body = flag('--body');
  if (body === null) fail('gh: a value is required');
  repo.variables = repo.variables ?? {};
  repo.variables[name] = body;
  done(`✓ Created variable ${name} for ${flag('--repo')}`);
}

/**
 * Workflow runs, and the jobs of one: what `certify` reads of the Deploy and
 * Nightly workflows. Listed newest first by the caller, so they are stored
 * here in any order — the real list's order is not a promise either.
 */
if (argv[0] === 'run' && argv[1] === 'list') {
  const repo = state.repos[flag('--repo')];
  if (!repo) fail('gh: Not Found (HTTP 404)');
  const workflow = flag('--workflow');
  const limit = Number(flag('--limit') ?? 20);
  const runs = (repo.runs ?? []).filter((run) => !workflow || run.workflow === workflow).slice(0, limit);
  done(JSON.stringify(runs.map(({ jobs: _jobs, workflow: _workflow, ...run }) => run)));
}

if (argv[0] === 'run' && argv[1] === 'view') {
  const repo = state.repos[flag('--repo')];
  if (!repo) fail('gh: Not Found (HTTP 404)');
  const run = (repo.runs ?? []).find((entry) => String(entry.databaseId) === argv[2]);
  if (!run) fail(`could not find any workflow run with ID ${argv[2]}`);
  done(JSON.stringify({ jobs: run.jobs ?? [] }));
}

/**
 * Pull requests.
 *
 * The repository is resolved the way the real `gh` resolves it — from the
 * checkout's own `origin` — rather than from a flag shopctl does not pass. That
 * keeps the property under test real: an upgrade opens the pull request of the
 * shop it is standing in, and a shop with no origin gets an error rather than
 * somebody else's repository.
 */
function currentRepo() {
  const named = flag('--repo');
  if (named) return named;
  const url = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

if (argv[0] === 'pr' && (argv[1] === 'list' || argv[1] === 'create')) {
  const name = currentRepo();
  const repo = name ? state.repos[name] : null;
  if (!repo) fail('gh: no git remote found for the current directory');
  repo.pulls = repo.pulls ?? [];

  if (argv[1] === 'list') {
    const head = flag('--head');
    const found = repo.pulls.filter((pull) => !head || pull.head === head);
    if (has('--json')) done(JSON.stringify(found.map(({ number, url, state: pullState }) => ({ number, url, state: pullState }))));
    done(found.map((pull) => `${pull.number}\t${pull.title}\t${pull.head}`).join('\n'));
  }

  const head = flag('--head');
  // The real gh refuses a second pull request for one branch, and shopctl is
  // written to ask before it creates. Refusing here is what proves it does.
  if (repo.pulls.some((pull) => pull.head === head && pull.state === 'OPEN')) {
    fail(`a pull request for branch "${head}" into branch "${flag('--base')}" already exists`);
  }
  const number = repo.pulls.length + 1;
  const pull = {
    number,
    url: `https://github.com/${name}/pull/${number}`,
    state: 'OPEN',
    head,
    base: flag('--base'),
    title: flag('--title'),
    // `--body-file -` reads stdin: a migration note is prose with quotes and
    // newlines in it, and recording it here is how a test proves it arrived.
    body: stdin,
  };
  repo.pulls.push(pull);
  done(pull.url);
}

fail(`gh-double: unhandled command "${argv.join(' ')}"`, 2);
