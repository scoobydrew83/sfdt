import path from 'path';
import fs from 'fs-extra';
import { constants as fsConstants } from 'node:fs';

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
 * Lexical containment only: `path.resolve` does not resolve symlinks, so this alone does
 * not prove the path stays inside the project on disk. That is fine for a WRITE target,
 * which may not exist yet — but a read must additionally go through `readFileInProject`
 * below. The `ponytail:` note that used to sit here deferred the symlink upgrade until
 * "untrusted writers gain the ability to plant symlinks in the project tree"; a cloned
 * repository is that writer, so the upgrade came due. (sfdt-private#23)
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
 * Read a file that must genuinely live inside `root` on disk.
 *
 * `resolveInProject` proves containment lexically, which a symlink defeats: `path.resolve`
 * does not follow links and `fs.readFile` does, so an in-project `logs/deploy.log` pointing
 * at `~/.sfdx/<user>.json` or `~/.aws/credentials` passed the check and read the target.
 * This was closed once on the manifest-viewer route and left on the five sibling routes that
 * share the primitive, so it lives here now — the guard belongs where all callers pass
 * through, not at whichever route someone remembers.
 *
 * Two layers, because neither is sufficient alone:
 *  - `O_NOFOLLOW` makes the kernel refuse a symlinked LEAF at open time, so the check and
 *    the read are one operation and a TOCTOU race has nowhere to live.
 *  - realpath containment catches a symlinked PARENT directory, which resolves normally and
 *    O_NOFOLLOW would happily open through.
 *
 * @param {string} root       Directory the file must resolve inside.
 * @param {string} input      Caller-supplied relative path.
 * @param {object} [options]
 * @param {string} [options.encoding='utf8']
 * @param {string} [options.label='path']
 * @returns {Promise<string|Buffer>}
 */
export async function readFileInProject(root, input, options = {}) {
  const { label = 'path' } = options;
  return readFileContained(root, resolveInProject(root, input, label), options);
}

/**
 * Write a file that must genuinely live inside `root` on disk.
 *
 * The counterpart to `readFileContained`, and needed for the same reason. Lexical containment
 * is enough to stop `../` traversal in a write target, which is why it was left at that — but
 * it does nothing about a symlink, and a committed `changelogs/pkg.md -> ~/.zshrc` arrives
 * with the clone. `O_NOFOLLOW` makes the kernel refuse a symlinked leaf at open time; the
 * parent directory is realpath-checked because the leaf may not exist yet, so it cannot be
 * resolved on its own.
 *
 * @param {string} root      Directory the file must stay inside.
 * @param {string} absPath   Already-resolved absolute path.
 * @param {string} data      Contents to write.
 * @param {object} [options] `encoding` (default 'utf8'), `label` (default 'path').
 */
export async function writeFileContained(root, absPath, data, options = {}) {
  const { encoding = 'utf8', label = 'path' } = options;
  const resolved = path.resolve(absPath);

  if (!lexicallyInside(root, resolved)) {
    throw new Error(`Invalid ${label}: resolves outside the project`);
  }

  // The PARENT, not the leaf: the file may not exist yet, so it has no realpath of its own.
  const realParent = await realpathOrSelf(path.dirname(resolved));
  await assertInsideRoot(root, realParent, label);

  try {
    await fs.writeFile(path.join(realParent, path.basename(resolved)), data, {
      encoding,
      flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    });
  } catch (err) {
    if (err?.code === 'ELOOP') {
      throw new Error(`Invalid ${label}: symlinks are not allowed`);
    }
    throw err;
  }
}

/**
 * Resolve a caller-supplied relative path that will be read by SOMETHING ELSE — an external
 * process, not this one.
 *
 * `readFileInProject` can use `O_NOFOLLOW` because it does the opening. When the path is
 * handed to `sf` (or any child process), that process opens it and follows links, so the only
 * guard available here is to prove physical containment before handing it over. Lexical
 * containment is not enough and never was: a committed `scripts/x.apex -> ~/.sfdx/<user>.json`
 * passes `resolveInProject` intact, and `sf apex run --file` then uploads that file's contents
 * to the org as anonymous Apex — where the compile error echoes them straight back to the
 * model that chose the path.
 *
 * There is an unavoidable TOCTOU gap between this check and the child process's open. It is
 * still worth checking: the attack this closes is a symlink COMMITTED in a repo, which is
 * present before the call and does not need to race it.
 *
 * @returns {Promise<string>} the resolved path, once proven to be physically inside `root`.
 */
export async function resolveForExternalRead(root, input, label = 'path') {
  const resolved = resolveInProject(root, input, label);
  const real = await fs.realpath(resolved).catch(() => null);
  if (!real) {
    throw Object.assign(new Error(`Invalid ${label}: file not found`), { code: 'ENOENT' });
  }
  await assertInsideRoot(root, real, label);
  return resolved;
}

/**
 * `fs.realpath`, falling back to the input when it cannot be resolved (the path does not
 * exist yet, or is a dangling link).
 *
 * Every containment check in this file compares PHYSICAL paths, because the lexical ones lie:
 * `path.resolve` does not follow symlinks, but every filesystem call that comes after it does.
 * The fallback is safe for containment specifically because a path that cannot be realpathed
 * also cannot be opened — the operation the check guards fails on its own.
 */
export async function realpathOrSelf(p) {
  return fs.realpath(p).catch(() => p);
}

/**
 * Assert that an already-resolved PHYSICAL path lies inside `root`, comparing realpath to
 * realpath. Returns the realpathed root so callers can build on it.
 *
 * Factored out rather than written twice. The bug this release exists to fix survived because
 * the same guard was applied at one call site and not extracted to where its siblings route;
 * leaving the physical-containment comparison duplicated between the read and write helpers
 * would be that identical risk one level down — a future edit only has to miss one copy.
 *
 * Resolving only ONE side breaks wherever the root itself sits under a link: macOS puts temp
 * dirs at /var/folders/… which is a symlink to /private/var/folders/…, and legitimate files
 * would be refused.
 */
async function assertInsideRoot(root, physical, label) {
  for (const r of toRoots(root)) {
    const realRoot = await realpathOrSelf(path.resolve(r));
    if (physical === realRoot || physical.startsWith(realRoot + path.sep)) return realRoot;
  }
  throw new Error(`Invalid ${label}: resolves outside the project`);
}

/** `root` may be a single directory or several — a file legitimately reachable under any. */
const toRoots = (root) => (Array.isArray(root) ? root : [root]);

/** Lexical containment against any of the roots. Cheap pre-check; never a proof on its own. */
function lexicallyInside(root, resolved) {
  return toRoots(root).some((r) => {
    const abs = path.resolve(r);
    return resolved === abs || resolved.startsWith(abs + path.sep);
  });
}

/**
 * Same guarantee as `readFileInProject`, for callers that already hold a resolved absolute
 * path (a glob hit, or a route that built and prefix-checked it itself).
 *
 * @param {string} root      Directory the file must stay inside.
 * @param {string} absPath   Already-resolved absolute path.
 * @param {object} [options] `encoding` (default 'utf8'), `label` (default 'path').
 * @returns {Promise<string|Buffer>}
 */
export async function readFileContained(root, absPath, options = {}) {
  const { encoding = 'utf8', label = 'path' } = options;
  const resolved = path.resolve(absPath);

  if (!lexicallyInside(root, resolved)) {
    throw new Error(`Invalid ${label}: resolves outside the project`);
  }

  const realPath = await fs.realpath(resolved).catch(() => null);
  if (!realPath) {
    // Distinguish "not there" from "escapes the project". Both are refusals, but a caller
    // mapping one to a 404 and the other to a 403 needs to tell them apart, and an operator
    // reading the log should not see a containment error for a plain missing file.
    throw Object.assign(new Error(`Invalid ${label}: file not found`), { code: 'ENOENT' });
  }
  await assertInsideRoot(root, realPath, label);

  try {
    return await fs.readFile(resolved, {
      encoding,
      flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    });
  } catch (err) {
    // ELOOP is O_NOFOLLOW refusing a symlink — a refusal, not a missing file. Callers map
    // "not found" to 404 and this must not land there.
    if (err?.code === 'ELOOP') {
      throw new Error(`Invalid ${label}: symlinks are not allowed`);
    }
    throw err;
  }
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
