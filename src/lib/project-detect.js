import fs from 'fs-extra';
import path from 'path';

const SFDX_PROJECT_FILE = 'sfdx-project.json';

/**
 * Walk up from startDir to find sfdx-project.json and return the directory
 * containing it (the project root).
 */
export function getProjectRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  const { root } = path.parse(current);

  while (current !== root) {
    if (fs.pathExistsSync(path.join(current, SFDX_PROJECT_FILE))) {
      return current;
    }
    current = path.dirname(current);
  }

  throw new Error(
    'Not inside a Salesforce DX project.\n' +
    `Could not find ${SFDX_PROJECT_FILE} in any parent directory of ${startDir || process.cwd()}.`
  );
}

/**
 * Detect and parse the Salesforce DX project configuration.
 * Returns an object with project metadata and resolved paths.
 */
export async function detectProject(startDir) {
  const projectRoot = getProjectRoot(startDir);
  const projectFilePath = path.join(projectRoot, SFDX_PROJECT_FILE);

  let projectJson;
  try {
    projectJson = await fs.readJson(projectFilePath);
  } catch (err) {
    throw new Error(
      `Failed to parse ${SFDX_PROJECT_FILE} at ${projectFilePath}: ${err.message}`
    );
  }

  const packageDirectories = projectJson.packageDirectories || [];
  if (packageDirectories.length === 0) {
    throw new Error(
      `No packageDirectories defined in ${projectFilePath}.\n` +
      'Your sfdx-project.json must have at least one packageDirectory entry.'
    );
  }

  const defaultPackageDir = packageDirectories.find((d) => d.default) || packageDirectories[0];
  const defaultSourcePath = path.join(projectRoot, defaultPackageDir.path, 'main', 'default');

  return {
    projectRoot,
    projectFile: projectFilePath,
    name: projectJson.name || path.basename(projectRoot),
    sourceApiVersion: projectJson.sourceApiVersion || null,
    namespace: projectJson.namespace || null,
    packageDirectories: packageDirectories.map((dir) => ({
      path: dir.path,
      default: !!dir.default,
      absolutePath: path.join(projectRoot, dir.path),
    })),
    defaultSourcePath,
    raw: projectJson,
  };
}
