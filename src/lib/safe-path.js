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
 * Assert a data-set name is a bare identifier safe to use as a path segment.
 * Returns the name so callers can inline it.
 */
export function assertSetName(setName) {
  if (typeof setName !== 'string' || !SET_RE.test(setName)) {
    throw new Error(`Invalid data set name: ${String(setName)}`);
  }
  return setName;
}
