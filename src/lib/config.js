import fs from 'fs-extra';
import path from 'path';

const CONFIG_DIR_NAME = '.sfdt';
const SFDX_PROJECT_FILE = 'sfdx-project.json';

const CONFIG_FILES = {
  config: 'config.json',
  environments: 'environments.json',
  pullConfig: 'pull-config.json',
  testConfig: 'test-config.json',
};

const REQUIRED_CONFIG_KEYS = ['defaultOrg', 'features'];

/**
 * Error subclass for configuration problems.
 * Carries exitCode 2 so the CLI entry point can set the correct exit status.
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = 2;
  }
}

/**
 * Walk up from startDir to find the directory containing both
 * sfdx-project.json and .sfdt/
 */
export function getConfigDir(startDir) {
  const root = findProjectWithConfig(startDir || process.cwd());
  return path.join(root, CONFIG_DIR_NAME);
}

/**
 * Load and merge all .sfdt/ configuration files into a single object.
 */
export async function loadConfig(startDir) {
  let configDir;
  try {
    configDir = getConfigDir(startDir);
  } catch (err) {
    throw new ConfigError(err.message);
  }

  const configPath = path.join(configDir, CONFIG_FILES.config);
  if (!(await fs.pathExists(configPath))) {
    throw new ConfigError(
      `Configuration file not found: ${configPath}\nRun 'sfdt init' first to create the .sfdt/ configuration directory.`,
    );
  }

  let config;
  try {
    config = await fs.readJson(configPath);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse ${configPath}: ${err.message}\nEnsure the file contains valid JSON.`,
    );
  }

  validateConfig(config);

  const merged = { ...config };

  for (const [key, filename] of Object.entries(CONFIG_FILES)) {
    if (key === 'config') continue;
    const filePath = path.join(configDir, filename);
    if (await fs.pathExists(filePath)) {
      try {
        merged[key] = await fs.readJson(filePath);
      } catch (err) {
        throw new ConfigError(`Failed to parse ${filePath}: ${err.message}`);
      }
    }
  }

  merged._configDir = configDir;
  merged._projectRoot = path.dirname(configDir);

  // Enrich with sfdx-project.json values if not already set
  const sfdxPath = path.join(merged._projectRoot, SFDX_PROJECT_FILE);
  if (await fs.pathExists(sfdxPath)) {
    const sfdxProject = await fs.readJson(sfdxPath);
    if (!merged.sourceApiVersion && sfdxProject.sourceApiVersion) {
      merged.sourceApiVersion = sfdxProject.sourceApiVersion;
    }
    if (!merged.defaultSourcePath && sfdxProject.packageDirectories?.length) {
      const defaultPkg =
        sfdxProject.packageDirectories.find((d) => d.default) || sfdxProject.packageDirectories[0];
      merged.defaultSourcePath = defaultPkg.path + '/main/default';
    }
  }

  return merged;
}

/**
 * Validate that a config object has the required structure.
 * Throws ConfigError with a descriptive message on failure.
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new ConfigError('Invalid configuration: config must be a non-null object.');
  }

  const missing = REQUIRED_CONFIG_KEYS.filter((key) => !(key in config));
  if (missing.length > 0) {
    throw new ConfigError(
      `Invalid configuration: missing required keys: ${missing.join(', ')}.\n` +
        `Run 'sfdt init' to regenerate the configuration.`,
    );
  }

  if (typeof config.features !== 'object' || config.features === null) {
    throw new ConfigError(
      'Invalid configuration: "features" must be an object (e.g. { "ai": false }).',
    );
  }

  if (typeof config.defaultOrg !== 'string' || config.defaultOrg.trim() === '') {
    throw new ConfigError(
      'Invalid configuration: "defaultOrg" must be a non-empty string (e.g. "my-org-alias").\n' +
        `Got: ${JSON.stringify(config.defaultOrg)}`,
    );
  }

  const threshold = config.deployment?.coverageThreshold;
  if (threshold !== undefined) {
    const n = Number(threshold);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new ConfigError(
        `Invalid configuration: "deployment.coverageThreshold" must be a number between 0 and 100.\n` +
          `Got: ${JSON.stringify(threshold)}`,
      );
    }
  }

  if (config.environments?.orgs !== undefined && !Array.isArray(config.environments.orgs)) {
    throw new ConfigError(
      'Invalid configuration: "environments.orgs" must be an array of org objects.',
    );
  }

  if (config.logDir !== undefined && typeof config.logDir !== 'string') {
    throw new ConfigError('Invalid configuration: "logDir" must be a string path when provided.');
  }
}

/**
 * Walk up from startDir looking for a directory that contains
 * sfdx-project.json and .sfdt/. Returns the project root path.
 */
function findProjectWithConfig(startDir) {
  let current = path.resolve(startDir);
  const { root } = path.parse(current);

  while (current !== root) {
    const hasSfdxProject = fs.pathExistsSync(path.join(current, SFDX_PROJECT_FILE));
    const hasSfdtDir = fs.pathExistsSync(path.join(current, CONFIG_DIR_NAME));

    if (hasSfdxProject && hasSfdtDir) {
      return current;
    }

    if (hasSfdxProject && !hasSfdtDir) {
      throw new ConfigError(
        `Found Salesforce DX project at ${current} but no .sfdt/ directory.\n` +
          `Run 'sfdt init' first to initialize configuration.`,
      );
    }

    current = path.dirname(current);
  }

  throw new ConfigError(
    `Could not find a Salesforce DX project with .sfdt/ configuration.\n` +
      `Run 'sfdt init' in your project root to get started.`,
  );
}
