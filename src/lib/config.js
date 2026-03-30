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
  const configDir = getConfigDir(startDir);

  const configPath = path.join(configDir, CONFIG_FILES.config);
  if (!await fs.pathExists(configPath)) {
    throw new Error(
      `Configuration file not found: ${configPath}\nRun 'sfdt init' first to create the .sfdt/ configuration directory.`
    );
  }

  const config = await fs.readJson(configPath);
  validateConfig(config);

  const merged = { ...config };

  for (const [key, filename] of Object.entries(CONFIG_FILES)) {
    if (key === 'config') continue;
    const filePath = path.join(configDir, filename);
    if (await fs.pathExists(filePath)) {
      merged[key] = await fs.readJson(filePath);
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
      const defaultPkg = sfdxProject.packageDirectories.find((d) => d.default) || sfdxProject.packageDirectories[0];
      merged.defaultSourcePath = defaultPkg.path + '/main/default';
    }
  }

  return merged;
}

/**
 * Validate that a config object has the required structure.
 * Throws with a descriptive message on failure.
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid configuration: config must be a non-null object.');
  }

  const missing = REQUIRED_CONFIG_KEYS.filter((key) => !(key in config));
  if (missing.length > 0) {
    throw new Error(
      `Invalid configuration: missing required keys: ${missing.join(', ')}.\n` +
      `Run 'sfdt init' to regenerate the configuration.`
    );
  }

  if (typeof config.features !== 'object' || config.features === null) {
    throw new Error('Invalid configuration: "features" must be an object.');
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
      throw new Error(
        `Found Salesforce DX project at ${current} but no .sfdt/ directory.\n` +
        `Run 'sfdt init' first to initialize configuration.`
      );
    }

    current = path.dirname(current);
  }

  throw new Error(
    `Could not find a Salesforce DX project with .sfdt/ configuration.\n` +
    `Run 'sfdt init' in your project root to get started.`
  );
}
