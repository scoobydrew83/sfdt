import path from 'path';
import fs from 'fs-extra';
import {
  analyzePackages,
  comparePackageSets,
  installedPackagesQuery,
  toInstalledRow,
  parseVersion,
} from '@sfdt/flow-core';
import { query } from './org-query.js';

/**
 * `sfdt packages` — installed package inventory, CLI side.
 *
 * The version model, the update adjudication and the drift comparator are all
 * `@sfdt/flow-core`'s. This file supplies the Tooling transport and owns
 * `.sfdt/packages.json`.
 *
 * ---------------------------------------------------------------------------
 * Why the annotations live in the repo
 * ---------------------------------------------------------------------------
 * Salesforce has no API for "is there a newer version of this managed package?"
 * (see the header of flow-core's packages.ts). The only durable answer is one a
 * human writes down — so where it gets written down decides whether the feature
 * is worth anything.
 *
 * `.sfdt/packages.json` is committed. That means the vendor URL, the version
 * someone checked, and who owns the relationship are code-reviewed, shared by
 * the whole team, and available to CI. A browser-local note is one person's, is
 * invisible to everyone else, and dies with the profile.
 *
 * It is deliberately NOT registered in `CONFIG_FILES` (`src/lib/config.js`).
 * This is data, not configuration: registering it would drag it into
 * config-schema validation and the template/schema/consumer lockstep of golden
 * principle #3, for a file that has none of those obligations.
 */

const NOTES_FILE = 'packages.json';
/** Bumped only if the on-disk shape changes incompatibly. */
export const NOTES_FORMAT_VERSION = 1;

/** Fields this version of sfdt understands. Anything else is preserved untouched. */
const KNOWN_NOTE_FIELDS = ['url', 'latestKnown', 'owner', 'notes', 'latestCheckedAt'];

/**
 * Property names that must never become a key in the notes store.
 *
 * The key is a package namespace supplied by the caller — a CLI argument, or
 * `args.namespace` on the `sfdt_packages_note` MCP tool, which an LLM may be
 * driving from org-derived text. It lands as a property name on the `packages`
 * object and is persisted to `.sfdt/packages.json`, a file that is COMMITTED and
 * therefore arrives with the repository rather than from the person running the
 * command — the same threat model `config-trust.js` states for config.
 *
 * A computed key in an object literal creates an own property rather than
 * reassigning the prototype, so this is not live prototype pollution today. It is
 * refused anyway, at both boundaries: a `constructor` key makes a plain-object
 * LOOKUP return a function rather than a note, and "not exploitable in the exact
 * shape we happen to write it today" is not a property worth depending on.
 *
 * Same set, and same reasoning, as the guard in `audit-logger.js`.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function notesPath(config) {
  const dir = config?._configDir ?? path.join(config?._projectRoot ?? process.cwd(), '.sfdt');
  return path.join(dir, NOTES_FILE);
}

/**
 * Read `.sfdt/packages.json`.
 *
 * A missing file is the normal case, not an error — most projects will never
 * have annotated a package. A malformed one IS an error, because silently
 * treating it as empty would drop annotations someone deliberately committed.
 *
 * @returns {Promise<{version: number, packages: Record<string, object>}>}
 */
export async function readPackageNotes(config) {
  const file = notesPath(config);
  if (!(await fs.pathExists(file))) return { version: NOTES_FORMAT_VERSION, packages: {} };
  let parsed;
  try {
    parsed = await fs.readJson(file);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.packages !== 'object' || parsed.packages === null) {
    throw new Error(`${file} is missing a "packages" object.`);
  }
  // Keys from the file are untrusted (see UNSAFE_KEYS): the file is committed, so
  // a poisoned key travels with a clone. Dropped rather than refused, because one
  // bad key should not make an otherwise readable store unusable.
  const unsafe = Object.keys(parsed.packages).filter((k) => UNSAFE_KEYS.has(k));
  if (unsafe.length > 0) {
    parsed.packages = Object.fromEntries(
      Object.entries(parsed.packages).filter(([k]) => !UNSAFE_KEYS.has(k)),
    );
  }
  if (parsed.version !== undefined && Number(parsed.version) > NOTES_FORMAT_VERSION) {
    // Refuse rather than guess: a newer sfdt may mean something different by
    // the same keys, and quietly rewriting the file would destroy that.
    throw new Error(
      `${file} is format version ${parsed.version}, but this sfdt understands ${NOTES_FORMAT_VERSION}. Upgrade sfdt.`,
    );
  }
  return { version: parsed.version ?? NOTES_FORMAT_VERSION, packages: parsed.packages };
}

/**
 * Validate one annotation before it is written.
 *
 * The load-bearing check is `latestKnown`: an unparseable string would be stored
 * happily and then compare against nothing forever, so the package would sit at
 * `unknown` while its owner believed it was being watched.
 */
export function validateNote(patch) {
  const errors = [];
  if (patch.latestKnown != null && patch.latestKnown !== '' && !parseVersion(patch.latestKnown)) {
    errors.push(
      `--latest "${patch.latestKnown}" is not a version number (expected e.g. 3.10.0 or 3.10.0.2).`,
    );
  }
  if (patch.url != null && patch.url !== '' && !/^https?:\/\//i.test(String(patch.url))) {
    errors.push(`--url "${patch.url}" must start with http:// or https://.`);
  }
  return errors;
}

/**
 * Merge one package's annotation into the file and write it back.
 *
 * Additive by design. Only the fields named in `patch` change; every other key
 * on that entry — including keys a NEWER sfdt wrote and this one does not know
 * about — survives untouched. An older CLI must not silently strip a colleague's
 * data just by editing a neighbouring field.
 *
 * Passing an explicit empty string clears a field; omitting it leaves it alone.
 *
 * @param {object} config
 * @param {string} key - namespace (or name, for an unmanaged package)
 * @param {object} patch
 * @param {string} [now] - ISO timestamp, injected so tests are deterministic.
 */
export async function writePackageNote(config, key, patch, { now } = {}) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('A package note needs a namespace (or package name) to file it under.');
  }
  if (UNSAFE_KEYS.has(key)) {
    throw new Error(`"${key}" cannot be used as a package key — it is a JavaScript property name, not a namespace.`);
  }

  const errors = validateNote(patch);
  if (errors.length > 0) throw new Error(errors.join(' '));

  const store = await readPackageNotes(config);
  // `hasOwn`, not a bare index: a bare lookup for an inherited name would return
  // something off Object.prototype instead of a note.
  const existing = Object.hasOwn(store.packages, key) ? { ...store.packages[key] } : {};

  for (const field of KNOWN_NOTE_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === '' || value === null) delete existing[field];
    else existing[field] = value;
  }
  // Stamp WHEN the version was recorded, because a two-year-old note is weak
  // evidence and the reader deserves to see that rather than a bare number.
  if ('latestKnown' in patch && patch.latestKnown) {
    existing.latestCheckedAt = now ?? new Date().toISOString().slice(0, 10);
  }

  const next = {
    version: NOTES_FORMAT_VERSION,
    packages: { ...store.packages, [key]: existing },
  };
  const file = notesPath(config);
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, next, { spaces: 2 });
  return { file, key, note: existing };
}

/** `PackageQueries` over `sf data query --use-tooling-api`. Refusals throw. */
export function toolingQueriesFor(orgAlias) {
  return {
    toolingQuery: async (soql) => ({ records: await query(orgAlias, soql, { tooling: true }) }),
  };
}

/**
 * List what is installed in one org, with annotations folded in.
 *
 * @returns {Promise<import('@sfdt/flow-core').PackageVM>}
 */
export async function listPackages(config, orgAlias) {
  const store = await readPackageNotes(config);
  return analyzePackages(toolingQueriesFor(orgAlias), { org: orgAlias, notes: store.packages });
}

/** Raw installed rows for one org — the input to a cross-org comparison. */
async function installedRows(orgAlias) {
  const records = await query(orgAlias, installedPackagesQuery(), { tooling: true });
  return records.map(toInstalledRow);
}

/**
 * Compare installed packages across two orgs.
 *
 * The two queries run concurrently, but a failure in EITHER rejects rather than
 * degrading: half a comparison is not a comparison, and reporting one org's
 * packages as "only in source" because the other query failed would be a
 * confidently wrong answer.
 *
 * @returns {Promise<import('@sfdt/flow-core').PackageDriftVM>}
 */
export async function comparePackages(sourceAlias, targetAlias) {
  const [sourceRows, targetRows] = await Promise.all([
    installedRows(sourceAlias),
    installedRows(targetAlias),
  ]);
  return comparePackageSets(
    { org: sourceAlias, rows: sourceRows },
    { org: targetAlias, rows: targetRows },
  );
}
