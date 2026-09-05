import path from 'path';

/**
 * Path-containment guards shared by every surface that turns caller-supplied
 * text into a filesystem path.
 *
 * The GUI routes have carried these checks since they were written; the MCP
 * handlers never did, which is how the two surfaces drifted apart on the same
 * parameters (sfdt-private#5, #6). Both now import from here so the next
 * surface inherits the guard instead of forgetting it.
 *
 * MCP arguments are chosen by a model, and this CLI's AI surfaces feed that
 * model untrusted org content (Apex compile errors, flow metadata, deploy
 * failure text). A path argument is therefore an untrusted input, not a
 * developer-supplied one, and `confirmExecution` does not change that — it
 * authorises the *operation*, while the model still supplies the argument.
 */

// Data-set names become a path segment under the data dir — keep them to a
// conservative identifier charset (no dots, slashes, or leading '-').
export const SET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Resolve `input` against `root` and assert the result stays inside it.
 *
 * Rejects non-strings, absolute paths and any `..` segment before resolving,
 * then re-checks the resolved path — `path.resolve` returns an absolute input
 * verbatim and collapses `../` silently, so the pre-checks alone are not a
 * containment proof.
 *
 * Throws rather than returning null: every caller treats a rejected path as a
 * hard error, and a thrown message keeps the reason attached to the value.
 *
 * ponytail: string-prefix containment, so a symlink inside the project can
 * still point outside it. Upgrade to fs.realpath comparison if untrusted
 * writers ever gain the ability to plant symlinks in the project tree.
 */
export function resolveInProject(root, input, label = 'path') {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid ${label}: expected a non-empty string`);
  }
  if (path.isAbsolute(input)) {
    throw new Error(`Invalid ${label}: absolute paths are not allowed`);
  }
  if (input.split(/[/\\]/).includes('..')) {
    throw new Error(`Invalid ${label}: '..' segments are not allowed`);
  }
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, input);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    throw new Error(`Invalid ${label}: resolves outside the project`);
  }
  return resolved;
}

/**
 * Salesforce API names — objects, fields, platform events. Same threat class as
 * SET_RE above: these are interpolated into REST paths and filesystem paths, and
 * on the MCP surface they are model-supplied.
 *
 * This lived privately in `field-impact-runner.js` while two other callers —
 * `events-runner.js` (a REST path) and `field-usage-offline.js` (a
 * `path.join`) — interpolated the same class of value with no check at all. One
 * exported guard, so a new caller reaches for it instead of re-deriving it.
 */
export const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Assert a Salesforce API name is a bare identifier. Returns it so callers can
 * inline the call at the interpolation site.
 *
 * @param {unknown} value
 * @param {string} what - what is being named, for the error text ('object', 'event', …)
 */
export function assertApiName(value, what = 'API name') {
  const str = String(value ?? '');
  if (!API_NAME_RE.test(str)) {
    // Wording kept from the original private copy in field-impact-runner.js —
    // this is a shared extraction, not a change to what users see.
    throw new Error(`"${str}" is not a valid ${what} API name.`);
  }
  return str;
}

/**
 * Assert a data-set name is a bare identifier safe to use as a path segment.
 * Returns the name so callers can inline it.
 */
export function assertSetName(setName) {
  if (typeof setName !== 'string' || !SET_RE.test(setName)) {
    throw new Error(`Invalid data set name: ${String(setName)}`);
  }
  return setName;
}

/**
 * The config keys whose value is turned into a filesystem path under the
 * project root, in dotted form.
 *
 * This is the *capability class*, not a list of keys someone noticed: a key
 * belongs here because its value reaches `path.join`/`path.resolve` and then a
 * read or a write. `config-trust.js` classifies against this set at load time so
 * a new path-shaped key is a one-line addition here rather than a silently
 * unguarded escape (sfdt-private#14, M1).
 *
 * `defaultSourcePath` is included even though `loadConfig` normally derives it
 * from `sfdx-project.json`: an explicit value in `.sfdt/config.json` wins, and
 * that file is the untrusted one.
 */
export const PROJECT_PATH_CONFIG_KEYS = Object.freeze([
  'logDir',
  'manifestDir',
  'releaseNotesDir',
  'changelogDir',
  'defaultSourcePath',
  'docs.outputDir',
  'monitoring.backupDir',
  'data.dir',
  'scratch.definitionFile',
  'deployment.smart.noOverwriteManifest',
]);

/**
 * True when `value` is a relative path that stays inside `root`.
 *
 * The predicate form of `resolveInProject`: same containment rule, but it
 * returns a boolean because its callers report on a whole config at once rather
 * than failing at the first bad key. Absolute values are refused outright — a
 * project-relative setting has no business naming `/Users/victim` even when the
 * resolve happens to land inside the root.
 *
 * Fails closed on anything that is not a non-empty string: the honest answer
 * for a value that cannot be shown to be inside the root is "no". Callers that
 * want to ignore an absent key check for it before asking.
 *
 * ponytail: string-prefix containment, inherited from `resolveInProject` — a
 * symlink inside the project can still point outside it (sfdt-private#15, L1).
 */
export function isPathWithinRoot(root, value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (path.isAbsolute(value)) return false;
  if (value.split(/[/\\]/).includes('..')) return false;
  const rootAbs = path.resolve(root ?? '.');
  const resolved = path.resolve(rootAbs, value);
  return resolved === rootAbs || resolved.startsWith(rootAbs + path.sep);
}
