import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

// CI partials ship inside the package — resolve from the module location, never
// from the user's CWD (the package-internal path rule in CLAUDE.md).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PARTIALS_DIR = path.resolve(__dirname, '..', '..', 'scripts', 'ci', 'partials');

export const AUTH_METHODS = ['sfdx-url', 'jwt'];
export const RUNNERS = ['npx', 'docker'];
// Providers whose jobs run in a user-chosen container image, where the official
// sfdt image (sf CLI + sfdt preinstalled) can replace the per-run npm installs.
export const DOCKER_RUNNER_PROVIDERS = ['gitlab', 'bitbucket'];
export const DOCKER_IMAGE = 'ghcr.io/scoobydrew83/sfdt:latest';
export const NPX_CLI = 'npx --yes @sfdt/cli@latest';

// Comment lines substituted into each template's "required secrets" header
// block via the {{authSecretsDoc}} placeholder. {{org}} is interpolated later.
const AUTH_SECRETS_DOC = {
  'sfdx-url': [
    '#   SFDX_AUTH_URL        sfdx auth URL for {{org}} (sf org auth show-sfdx-auth-url; on sf CLI < 2.136 use sf org display --verbose --json)',
  ].join('\n'),
  jwt: [
    '#   SFDX_CONSUMER_KEY    consumer key (client id) of the connected app used for the JWT flow',
    '#   SFDX_JWT_SECRET_KEY  contents of the JWT signing private key (server.key), not a file path',
    '#   SFDX_USERNAME        username to authenticate as',
    '#   SFDX_INSTANCE_URL    (optional) login URL; defaults to https://login.salesforce.com',
  ].join('\n'),
};

// Secret names echoed in the post-generation hint, per auth method.
const AUTH_SECRET_NAMES = {
  'sfdx-url': 'SFDX_AUTH_URL',
  jwt: 'SFDX_CONSUMER_KEY, SFDX_JWT_SECRET_KEY, SFDX_USERNAME',
};

export function authSecretsDoc(auth) {
  return AUTH_SECRETS_DOC[auth];
}

export function authSecretNames(auth) {
  return AUTH_SECRET_NAMES[auth];
}

/**
 * Substitute a block placeholder (a line containing only `{{name}}`) with a
 * multi-line block, re-indenting every block line to the placeholder's
 * indentation. An empty block removes the placeholder line entirely. Scalar
 * `{{word}}` placeholders inside the block survive for the later interpolate()
 * pass; a missing placeholder leaves the template untouched.
 */
export function injectBlock(template, name, block) {
  const lineRe = new RegExp(`^([ \\t]*)\\{\\{${name}\\}\\}[ \\t]*$`, 'm');
  const match = template.match(lineRe);
  if (!match) return template;
  if (!block || !block.trim()) {
    return template.replace(new RegExp(`^[ \\t]*\\{\\{${name}\\}\\}[ \\t]*\\n?`, 'm'), '');
  }
  const indent = match[1];
  const indented = block
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line.trim() ? indent + line : ''))
    .join('\n');
  // Replacement via function so `$`-sequences in the block (e.g. GitHub's
  // `${{ secrets.X }}`) are inserted literally, never parsed as backreferences.
  return template.replace(lineRe, () => indented);
}

/** Load a partial from scripts/ci/partials/<name>.yml, trailing whitespace trimmed. */
export async function loadPartial(name) {
  const file = path.join(PARTIALS_DIR, `${name}.yml`);
  if (!(await fs.pathExists(file))) {
    throw new Error(`No CI partial "${name}" at ${file}`);
  }
  return (await fs.readFile(file, 'utf-8')).replace(/\s+$/, '');
}

/** Comment out every line of a block (used to emit optional steps disabled). */
export function commentBlock(block) {
  return block
    .split('\n')
    .map((line) => (line.trim() ? `# ${line}` : '#'))
    .join('\n');
}
