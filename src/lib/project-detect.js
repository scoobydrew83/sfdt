import fs from 'fs-extra';
import path from 'path';
const SFDX_PROJECT_FILE = 'sfdx-project.json';
export function safeResolvePath(projectRoot, relativePath) {
  const absolute = path.resolve(projectRoot, relativePath);
  const resolvedRoot = path.resolve(projectRoot);
  if (!absolute.startsWith(resolvedRoot + path.sep) && absolute !== resolvedRoot) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return absolute;
}
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
      `Could not find ${SFDX_PROJECT_FILE} in any parent directory of ${startDir || process.cwd()}.`,
  );
}
export async function detectProject(startDir) {
  const projectRoot = getProjectRoot(startDir);
  const projectFilePath = path.join(projectRoot, SFDX_PROJECT_FILE);
  let projectJson;
  try {
    projectJson = await fs.readJson(projectFilePath);
  } catch (err) {
    throw new Error(`Failed to parse ${SFDX_PROJECT_FILE} at ${projectFilePath}: ${err.message}`);
  }
  const packageDirectories = projectJson.packageDirectories || [];
  if (packageDirectories.length === 0) {
    throw new Error(
      `No packageDirectories defined in ${projectFilePath}.\n` +
        'Your sfdx-project.json must have at least one packageDirectory entry.',
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
      name: dir.path.split('/').at(-1),
    })),
    defaultSourcePath,
    raw: projectJson,
  };
}
