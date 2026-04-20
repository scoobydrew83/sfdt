import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { print } from './output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scripts/ lives at the package root, two levels up from src/lib/
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');

/**
 * Build an object of SFDT_ environment variables from a config object.
 * Flattens nested config keys into SFDT_UPPER_SNAKE_CASE vars.
 */
export function buildScriptEnv(config) {
  const env = {};

  if (!config || typeof config !== 'object') return env;

  env.SFDT_PROJECT_ROOT = config._projectRoot || '';
  env.SFDT_CONFIG_DIR = config._configDir || '';
  env.SFDT_PROJECT_NAME = config.projectName || 'Salesforce Project';
  env.SFDT_DEFAULT_ORG = config.defaultOrg || '';
  env.SFDT_SOURCE_PATH = config.defaultSourcePath || 'force-app/main/default';
  env.SFDT_MANIFEST_DIR = config.manifestDir || 'manifest/release';
  env.SFDT_RELEASE_NOTES_DIR = config.releaseNotesDir || 'release-notes';
  env.SFDT_API_VERSION = config.sourceApiVersion || '';
  env.SFDT_COVERAGE_THRESHOLD = String(config.deployment?.coverageThreshold || 75);
  env.SFDT_LOG_DIR = config.logDir || '';
  env.SFDT_PREFLIGHT_ENFORCE_TESTS = config.deployment?.preflight?.enforceTests ? 'true' : '';
  env.SFDT_PREFLIGHT_ENFORCE_BRANCH = config.deployment?.preflight?.enforceBranchNaming ? 'true' : '';
  env.SFDT_PREFLIGHT_ENFORCE_CHANGELOG = config.deployment?.preflight?.enforceChangelog ? 'true' : '';

  // Flatten features
  if (config.features && typeof config.features === 'object') {
    for (const [key, value] of Object.entries(config.features)) {
      const envKey = `SFDT_FEATURE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
      env[envKey] = String(value);
    }
  }

  // Flatten environments
  if (config.environments && typeof config.environments === 'object') {
    if (config.environments.default) {
      env.SFDT_DEFAULT_ENV = config.environments.default;
    }
    if (Array.isArray(config.environments.orgs)) {
      env.SFDT_ENV_ORGS = config.environments.orgs.map((o) => o.alias || o.name || '').join(',');
    }
  }

  // Test config
  if (config.testConfig && typeof config.testConfig === 'object') {
    if (config.testConfig.coverageThreshold !== undefined) {
      env.SFDT_TEST_COVERAGE_THRESHOLD = String(config.testConfig.coverageThreshold);
    }
    if (config.testConfig.testLevel) {
      env.SFDT_TEST_LEVEL = config.testConfig.testLevel;
    }
    if (Array.isArray(config.testConfig.suites)) {
      env.SFDT_TEST_SUITES = config.testConfig.suites.join(',');
    }
    if (Array.isArray(config.testConfig.testClasses)) {
      env.SFDT_TEST_CLASSES = config.testConfig.testClasses.join(',');
    }
    if (Array.isArray(config.testConfig.apexClasses)) {
      env.SFDT_APEX_CLASSES = config.testConfig.apexClasses.join(',');
    }
  }

  // Pull config
  if (config.pullConfig && typeof config.pullConfig === 'object') {
    if (Array.isArray(config.pullConfig.metadataTypes)) {
      env.SFDT_PULL_METADATA_TYPES = config.pullConfig.metadataTypes.join(',');
    }
    if (config.pullConfig.targetDir) {
      env.SFDT_PULL_TARGET_DIR = config.pullConfig.targetDir;
    }
  }

  return env;
}

/**
 * Run a shell script from the sfdt package's scripts/ directory.
 *
 * @param {string} scriptPath - Relative path within scripts/ (e.g., 'deploy/push.sh')
 * @param {object} config - The merged sfdt config object
 * @param {object} [options] - Execution options
 * @param {string[]} [options.args] - Arguments to pass to the script
 * @param {string} [options.cwd] - Working directory (defaults to project root)
 * @param {object} [options.env] - Additional environment variables
 * @param {boolean} [options.interactive] - Use stdio inherit for TTY passthrough (default: true)
 * @param {boolean} [options.dryRun] - Print what would be executed without running (default: false)
 */
export async function runScript(scriptPath, config, options = {}) {
  const {
    args = [],
    cwd,
    env: extraEnv = {},
    interactive = true,
    captureStdout = false,
    dryRun = false,
  } = options;

  const fullPath = path.resolve(SCRIPTS_DIR, scriptPath);

  if (!dryRun && !(await fs.pathExists(fullPath))) {
    throw new Error(`Script not found: ${fullPath}`);
  }

  if (dryRun) {
    const workDir = cwd || config._projectRoot || process.cwd();
    const scriptEnv = buildScriptEnv(config);
    const mergedEnv = { ...scriptEnv, ...extraEnv };
    const sfdtVars = Object.entries(mergedEnv)
      .filter(([k, v]) => k.startsWith('SFDT_') && v)
      .sort(([a], [b]) => a.localeCompare(b));

    print.info(`[dry-run] Script : ${scriptPath}`);
    print.info(`[dry-run] Full path: ${fullPath}`);
    print.info(`[dry-run] Working dir: ${workDir}`);
    if (args.length) print.info(`[dry-run] Args: ${args.join(' ')}`);
    if (sfdtVars.length) {
      print.info('[dry-run] SFDT_ environment:');
      for (const [k, v] of sfdtVars) {
        print.step(`           ${k}=${v}`);
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  // Ensure the script is executable
  try {
    await fs.chmod(fullPath, 0o755);
  } catch (err) {
    throw new Error(`Failed to set executable permission on ${fullPath}: ${err.message}`);
  }

  const scriptEnv = buildScriptEnv(config);
  const mergedEnv = {
    ...process.env,
    ...scriptEnv,
    SFDT_NON_INTERACTIVE: !process.stdin.isTTY || options.interactive === false ? 'true' : 'false',
    ...extraEnv,
  };

  const execOptions = {
    cwd: cwd || config._projectRoot || process.cwd(),
    env: mergedEnv,
    reject: false,
  };

  if (captureStdout) {
    // Interactive stdin/stderr but capture stdout for return value
    execOptions.stdio = ['inherit', 'pipe', 'inherit'];
  } else if (interactive) {
    execOptions.stdio = 'inherit';
  }

  const result = await execa(fullPath, args, execOptions);

  if (result.exitCode !== 0) {
    const error = new Error(
      `Script "${scriptPath}" exited with code ${result.exitCode}` +
        (result.stderr ? `\n${result.stderr}` : ''),
    );
    error.exitCode = result.exitCode;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }

  return result;
}
