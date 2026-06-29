import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { interpolate } from '../lib/prompts.js';
import { resolveExitCode } from '../lib/exit-codes.js';

// CI templates ship inside the package — resolve from the module location, never
// from the user's CWD (the package-internal path rule in CLAUDE.md).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CI_DIR = path.resolve(__dirname, '..', '..', 'scripts', 'ci');

const PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket'];
const TYPES = ['monitor', 'deploy'];

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
 * @returns {Promise<{ provider, type, outFile?, printed?, content }>}
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

  const templatePath = path.join(CI_DIR, `${provider}-${type}.yml`);
  if (!(await fs.pathExists(templatePath))) {
    throw new Error(`No CI template for ${provider}/${type} at ${templatePath}`);
  }

  // Org alias: explicit flag → config default → placeholder (with a warning).
  let org = options.org;
  if (!org) {
    try {
      const config = await loadConfig();
      org = config.defaultOrg;
    } catch {
      // No project config yet — fall through to placeholder.
    }
  }
  const orgMissing = !org;
  if (orgMissing) org = 'YOUR_ORG_ALIAS';

  const template = await fs.readFile(templatePath, 'utf-8');
  const content = interpolate(template, {
    cron: options.cron || '0 6 * * *',
    org,
    nodeVersion: options.node || '20',
    deltaBase: options.deltaBase || 'main',
  });

  return { provider, type, content, orgMissing, org };
}

async function runCiInit(options) {
  const jsonMode = !!options.json;
  try {
    const result = await generateCi(options);
    const { provider, type, content, orgMissing } = result;

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
      print.info('Add the required secrets (SFDX_AUTH_URL, webhook URLs) in your CI provider settings.');
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
  const ci = program.command('ci').description('Generate CI/CD pipeline templates (monitoring, smart deploy)');

  ci
    .command('init')
    .description('Generate a ready-to-use CI workflow for a provider')
    .requiredOption('--provider <name>', `CI provider: ${PROVIDERS.join(' | ')}`)
    .option('--type <type>', `Workflow type: ${TYPES.join(' | ')}`, 'monitor')
    .option('--cron <expr>', 'Cron schedule for monitoring workflows', '0 6 * * *')
    .option('--org <alias>', 'Target org alias (defaults to config.defaultOrg)')
    .option('--delta-base <ref>', 'Base git ref for smart-deploy delta', 'main')
    .option('--node <version>', 'Node.js version for the CI runner', '20')
    .option('--out <path>', 'Output file path (defaults to the provider convention)')
    .option('--print', 'Print to stdout instead of writing a file')
    .option('--force', 'Overwrite an existing file')
    .option('--json', 'Emit the result as JSON')
    .action((options) => runCiInit(options));

  return ci;
}

// Exposed so `sfdt monitor schedule` can delegate without duplicating logic.
export { runCiInit };
