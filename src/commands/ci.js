import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { interpolate } from '../lib/prompts.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import {
  AUTH_METHODS,
  RUNNERS,
  DOCKER_RUNNER_PROVIDERS,
  DOCKER_IMAGE,
  NPX_CLI,
  ACTION_REF,
  ACTION_RUNNER_TYPES,
  authSecretsDoc,
  authSecretNames,
  injectBlock,
  loadPartial,
  commentBlock,
} from '../lib/ci-templates.js';
import { detectLwcTests } from '../lib/lwc-test.js';

// CI templates ship inside the package — resolve from the module location, never
// from the user's CWD (the package-internal path rule in CLAUDE.md).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CI_DIR = path.resolve(__dirname, '..', '..', 'scripts', 'ci');

const PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket'];
const TYPES = ['monitor', 'deploy', 'release', 'scratch'];

// Where the generated file lands by default. GitHub's workflows dir holds many
// files so we write there directly; the other providers use a single top-level
// CI file owned by the user, so we emit a standalone fragment under .sfdt/ci/
// for the user to merge/include rather than risk clobbering their pipeline.
function defaultOutPath(provider, type) {
  if (provider === 'github') return path.join('.github', 'workflows', `sfdt-${type}.yml`);
  return path.join('.sfdt', 'ci', `${provider}-${type}.yml`);
}

/**
 * Render a CI template and write (or print) it. Shared by `sfdt ci init` and the
 * `sfdt monitor schedule` alias.
 *
 * @returns {Promise<{ provider, type, auth, runner, outFile?, printed?, content }>}
 */
export async function generateCi(options) {
  const provider = String(options.provider || '').toLowerCase();
  const type = String(options.type || 'monitor').toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`--provider must be one of: ${PROVIDERS.join(', ')}`);
  }
  if (!TYPES.includes(type)) {
    throw new Error(`--type must be one of: ${TYPES.join(', ')}`);
  }

  // Project config enriches the defaults; tolerate its absence (pre-`sfdt init`).
  let config = null;
  try {
    config = await loadConfig();
  } catch {
    // No project config yet — flags and built-in defaults still apply.
  }

  // Org alias: explicit flag → config default → placeholder (with a warning).
  let org = options.org || config?.defaultOrg;
  const orgMissing = !org;
  if (orgMissing) org = 'YOUR_ORG_ALIAS';

  const auth = String(options.auth || config?.ci?.authMethod || 'sfdx-url').toLowerCase();
  if (!AUTH_METHODS.includes(auth)) {
    throw new Error(`--auth must be one of: ${AUTH_METHODS.join(', ')}`);
  }
  const runner = String(options.runner || config?.ci?.runner || 'npx').toLowerCase();
  if (!RUNNERS.includes(runner)) {
    throw new Error(`--runner must be one of: ${RUNNERS.join(', ')}`);
  }
  if (runner === 'docker' && !DOCKER_RUNNER_PROVIDERS.includes(provider)) {
    throw new Error(
      `--runner docker is only supported for: ${DOCKER_RUNNER_PROVIDERS.join(', ')} ` +
        '(github/azure hosted runners use setup-node + npx; the sfdt image is documented in the template header)'
    );
  }
  if (runner === 'action') {
    if (provider !== 'github') {
      throw new Error(`--runner action is only supported for github (the composite action ${ACTION_REF})`);
    }
    if (!ACTION_RUNNER_TYPES.includes(type)) {
      throw new Error(
        `--runner action supports types: ${ACTION_RUNNER_TYPES.join(', ')} ` +
          '(scratch pipelines drive raw sf commands with their own cleanup steps — use the default runner)'
      );
    }
  }

  // Action-runner workflows are a separate template variant: one `uses:` step
  // replaces the setup/install/auth steps.
  const templateFile = runner === 'action' ? `${provider}-${type}.action.yml` : `${provider}-${type}.yml`;
  const templatePath = path.join(CI_DIR, templateFile);
  if (!(await fs.pathExists(templatePath))) {
    throw new Error(`No CI template for ${provider}/${type} at ${templatePath}`);
  }

  // @sfdt/cli needs Node >= 22.15 (node:sqlite) — 22 is the floor, not a preference.
  const nodeVersion = options.node || '22';
  const branch = options.branch || config?.defaultBranch || 'main';
  const environment = options.environment || config?.ci?.environment || 'production';
  // Release deltas resolve the last tag at runtime; {{deltaBase}} is only the
  // no-tags-yet fallback there, so it defaults to the pre-merge commit.
  const deltaBase = options.deltaBase || (type === 'release' ? 'HEAD~1' : 'main');
  const scratchDef = options.definitionFile || config?.scratch?.definitionFile || 'config/project-scratch-def.json';

  let template = await fs.readFile(templatePath, 'utf-8');

  // Block placeholders first (indentation-aware), scalar placeholders second —
  // partials may themselves contain scalars like {{org}}.
  if (template.includes('{{authSteps}}')) {
    template = injectBlock(template, 'authSteps', await loadPartial(`${provider}-auth-${auth}`));
  }
  template = injectBlock(template, 'authSecretsDoc', authSecretsDoc(auth));
  if (template.includes('{{authInputs}}')) {
    // Action-runner templates pass secrets as `with:` inputs instead of steps.
    template = injectBlock(template, 'authInputs', await loadPartial(`action-auth-${auth}`));
  }
  if (template.includes('{{qualitySteps}}')) {
    template = injectBlock(template, 'qualitySteps', await loadPartial(`${provider}-quality`));
  }
  if (template.includes('{{cliSetup}}')) {
    // The sfdt image ships the Salesforce CLI — nothing to install per run.
    const setup = runner === 'docker' ? '' : '- npm install --global @salesforce/cli';
    template = injectBlock(template, 'cliSetup', setup);
  }
  if (template.includes('{{lwcTestSteps}}')) {
    let lwcSteps = await loadPartial(`${provider}-lwc-test`);
    const lwc = config
      ? await detectLwcTests(config._projectRoot, config.packageDirectories)
      : { detected: false };
    if (!lwc.detected) {
      lwcSteps = `# Uncomment when the project has LWC (Jest) unit tests:\n${commentBlock(lwcSteps)}`;
    }
    template = injectBlock(template, 'lwcTestSteps', lwcSteps);
  }

  const content = interpolate(template, {
    cron: options.cron || '0 6 * * *',
    org,
    nodeVersion,
    deltaBase,
    branch,
    environment,
    scratchDef,
    image: runner === 'docker' ? DOCKER_IMAGE : `node:${nodeVersion}`,
    cli: runner === 'docker' ? 'sfdt' : NPX_CLI,
    actionRef: ACTION_REF,
    authMethod: auth,
    // Scratch templates authenticate the Dev Hub, everything else a target org.
    setDefaultFlag: type === 'scratch' ? '--set-default-dev-hub' : '--set-default',
  });

  return { provider, type, auth, runner, content, orgMissing, org };
}

async function runCiInit(options) {
  const jsonMode = !!options.json;
  try {
    const result = await generateCi(options);
    const { provider, type, auth, content, orgMissing } = result;

    if (options.print) {
      if (!jsonMode) process.stdout.write(content + '\n');
      else process.stdout.write(JSON.stringify({ ok: true, provider, type, printed: true, content }, null, 2) + '\n');
      return;
    }

    const outFile = options.out || defaultOutPath(provider, type);
    if ((await fs.pathExists(outFile)) && !options.force) {
      throw new Error(`${outFile} already exists — pass --force to overwrite or --out to choose another path`);
    }
    await fs.ensureDir(path.dirname(outFile));
    await fs.writeFile(outFile, content, 'utf-8');

    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ok: true, provider, type, outFile }, null, 2) + '\n');
    } else {
      print.success(`Wrote ${provider} ${type} CI template to ${outFile}`);
      if (orgMissing) print.warning('No org alias resolved — edit the placeholder YOUR_ORG_ALIAS in the file.');
      if (provider !== 'github') {
        print.info(`Merge this into your ${provider} pipeline configuration (it is a standalone fragment).`);
      }
      print.info(`Add the required secrets (${authSecretNames(auth)}, webhook URLs) in your CI provider settings.`);
      if (type === 'scratch') print.info('The auth secret must belong to a Dev Hub user (scratch orgs are created from it).');
      if (type === 'release') {
        print.info('Create the approval environment in your CI provider first — the template header explains where.');
      }
    }
  } catch (err) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    } else {
      print.error(`ci init failed: ${err.message}`);
    }
    process.exitCode = resolveExitCode(err);
  }
}

export function registerCiCommand(program) {
  const ci = program.command('ci').description('Generate CI/CD pipeline templates (monitoring, smart deploy, release, scratch-org CI)');

  ci
    .command('init')
    .description('Generate a ready-to-use CI workflow for a provider')
    .requiredOption('--provider <name>', `CI provider: ${PROVIDERS.join(' | ')}`)
    .option('--type <type>', `Workflow type: ${TYPES.join(' | ')}`, 'monitor')
    .option('--auth <method>', `Org authentication: ${AUTH_METHODS.join(' | ')} (default: config ci.authMethod or sfdx-url)`)
    .option('--runner <name>', `CLI runner: ${RUNNERS.join(' | ')} (docker = official sfdt image, gitlab/bitbucket; action = the ${ACTION_REF} composite action, github)`)
    .option('--cron <expr>', 'Cron schedule for monitoring workflows', '0 6 * * *')
    .option('--org <alias>', 'Target org alias (Dev Hub alias for --type scratch; defaults to config.defaultOrg)')
    .option('--branch <name>', 'Protected branch that triggers a release workflow (defaults to config.defaultBranch or main)')
    .option('--environment <name>', 'Approval environment for a release workflow (default: config ci.environment or production)')
    .option('--delta-base <ref>', 'Base git ref for smart-deploy delta (release: fallback when no tag exists; default HEAD~1)')
    .option('--definition-file <path>', 'Scratch org definition file for --type scratch (defaults to config scratch.definitionFile)')
    .option('--node <version>', 'Node.js version for the CI runner (@sfdt/cli requires >= 22.15)', '22')
    .option('--out <path>', 'Output file path (defaults to the provider convention)')
    .option('--print', 'Print to stdout instead of writing a file')
    .option('--force', 'Overwrite an existing file')
    .option('--json', 'Emit the result as JSON')
    .action((options) => runCiInit(options));

  return ci;
}

// Exposed so `sfdt monitor schedule` can delegate without duplicating logic.
export { runCiInit };
