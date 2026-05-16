import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { readFileSync } from 'fs';
import path from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_DIR_NAME = '.sfdt';
const SFDX_PROJECT_FILE = 'sfdx-project.json';
const CONFIG_FILES = {
  config: 'config.json',
  environments: 'environments.json',
  pullConfig: 'pull-config.json',
  testConfig: 'test-config.json',
};
const _ajv = new Ajv({ allErrors: true, strict: false });
addFormats(_ajv);
const _configSchema = JSON.parse(
  readFileSync(path.join(__dirname, 'config-schema.json'), 'utf8'),
);
const _validate = _ajv.compile(_configSchema);
function formatAjvErrors(errors) {
  const requiredErrors = errors.filter((e) => e.keyword === 'required');
  if (requiredErrors.length > 0) {
    const missing = requiredErrors.map((e) => e.params.missingProperty).join(', ');
    return (
      `Invalid configuration: missing required keys: ${missing}.\n` +
      `Run 'sfdt init' to regenerate the configuration.`
    );
  }
  const e = errors[0];
  const rawPath = e.instancePath.replace(/^\
  const fieldPath = rawPath || '(root)';
  const more = errors.length > 1 ? ` (+ ${errors.length - 1} more errors)` : '';
  if (fieldPath === 'defaultOrg') {
    return (
      `Invalid configuration: "defaultOrg" must be a non-empty string (e.g. "my-org-alias")${more}.\n` +
      `Run 'sfdt init' to regenerate the configuration.`
    );
  }
  if (fieldPath.includes('coverageThreshold')) {
    return `Invalid configuration: "deployment.coverageThreshold" must be a number between 0 and 100${more}.`;
  }
  if (fieldPath === 'logDir') {
    return `Invalid configuration: "logDir" must be a string path when provided${more}.`;
  }
  if (fieldPath === 'environments.orgs') {
    return `Invalid configuration: "environments.orgs" must be an array of org objects${more}.`;
  }
  if (e.keyword === 'enum') {
    const allowed = e.params.allowedValues.join(', ');
    return (
      `Invalid configuration: "${fieldPath}" must be one of: ${allowed}${more}.\n` +
      `Run 'sfdt init' to regenerate the configuration.`
    );
  }
  if (e.keyword === 'type') {
    const article = ['a', 'e', 'i', 'o', 'u'].includes(e.params.type[0]) ? 'an' : 'a';
    return `Invalid configuration: "${fieldPath}" must be ${article} ${e.params.type}${more}.`;
  }
  if (e.keyword === 'minimum' || e.keyword === 'exclusiveMinimum') {
    return `Invalid configuration: "${fieldPath}" must be ≥ ${e.params.limit}${more}.`;
  }
  if (e.keyword === 'maximum' || e.keyword === 'exclusiveMaximum') {
    return `Invalid configuration: "${fieldPath}" must be ≤ ${e.params.limit}${more}.`;
  }
  if (e.keyword === 'minLength') {
    return (
      `Invalid configuration: "${fieldPath}" must be a non-empty string${more}.\n` +
      `Run 'sfdt init' to regenerate the configuration.`
    );
  }
  if (e.keyword === 'additionalProperties') {
    return `Invalid configuration: "${fieldPath}" contains unknown key "${e.params.additionalProperty}"${more}.`;
  }
  return `Invalid configuration: field "${fieldPath}" ${e.message}${more}.`;
}
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = 2;
  }
}
export function getConfigDir(startDir) {
  const root = findProjectWithConfig(startDir || process.cwd());
  return path.join(root, CONFIG_DIR_NAME);
}
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
  const sfdxPath = path.join(merged._projectRoot, SFDX_PROJECT_FILE);
  if (await fs.pathExists(sfdxPath)) {
    const sfdxProject = await fs.readJson(sfdxPath);
    if (!merged.sourceApiVersion && sfdxProject.sourceApiVersion) {
      merged.sourceApiVersion = sfdxProject.sourceApiVersion;
    }
    if (sfdxProject.packageDirectories?.length) {
      const dirs = sfdxProject.packageDirectories;
      if (!merged.defaultSourcePath) {
        const defaultPkg = dirs.find((d) => d.default) || dirs[0];
        merged.defaultSourcePath = defaultPkg.path + '/main/default';
      }
      merged.packageDirectories = dirs.map((d) => ({
        path: d.path,
        default: !!d.default,
        absolutePath: path.join(merged._projectRoot, d.path),
        name: d.name ?? d.path.split('/').at(-1),
      }));
    }
  }
  merged.manifestLayout = merged.manifestLayout || 'flat';
  merged.changelogDir = merged.changelogDir || 'changelogs';
  return merged;
}
export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new ConfigError('Invalid configuration: config must be a non-null object.');
  }
  const valid = _validate(config);
  if (!valid) {
    throw new ConfigError(formatAjvErrors(_validate.errors));
  }
}
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
