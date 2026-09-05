import path from 'path';
import { assertApiName } from './safe-path.js';
import fs from 'fs-extra';
import { glob } from 'glob';
import {
  classifyOfflineSource,
  isSelfDefinition,
  fieldReferenceRegex,
  buildOfflineUsageVM,
} from '@sfdt/flow-core';

/**
 * `sfdt field usage <Object> --offline` — the repo scan.
 *
 * No org, so this runs on a pull request before the field is deployed anywhere.
 * That is the half a hosted console structurally cannot offer: it needs your
 * source tree, not your org.
 *
 * The adjudication — which metadata types count as USE versus mere existence,
 * and how a field name is matched — is `@sfdt/flow-core`'s
 * (`field-usage-offline.ts`). This file walks the disk and reads bytes.
 */

/** Files never worth scanning: build output, dependencies, VCS. */
const IGNORED = ['**/node_modules/**', '**/.git/**', '**/.sfdx/**', '**/dist/**'];

/**
 * Package directories from `sfdx-project.json`, mirroring `source-dependencies.js`.
 */
function packageBases(config) {
  const root = config._projectRoot ?? process.cwd();
  const dirs = config.packageDirectories?.length
    ? config.packageDirectories.map((d) => d.path)
    : [config.defaultSourcePath ?? 'force-app/main/default'];
  return dirs.map((d) => path.join(root, d));
}

/**
 * Read the object's field list straight from its metadata directory.
 *
 * Offline there is no describe, so the fields ARE the `.field-meta.xml` files.
 * That means the scan covers custom fields only — a standard field has no such
 * file in a repo unless it has been customised, which is stated as a note rather
 * than silently narrowing the answer.
 */
export async function fieldsForObject(config, object) {
  const fields = [];
  for (const base of packageBases(config)) {
    // The online sibling validates (field-impact-runner.js), this branch did not —
  // so `sfdt_field_usage`, a read-only MCP tool with no confirmExecution, could
  // walk `../../..` out of the project and return the schema of an unrelated
  // customer's repo, with a non-match returning [] as a directory-existence oracle.
  assertApiName(object, 'object');
  const dir = path.join(base, 'objects', object, 'fields');
    const files = await glob('*.field-meta.xml', { cwd: dir, absolute: true }).catch(() => []);
    for (const file of files) {
      const name = path.basename(file).replace(/\.field-meta\.xml$/i, '');
      const xml = await fs.readFile(file, 'utf8').catch(() => '');
      const label = /<label>([^<]*)<\/label>/i.exec(xml)?.[1] ?? null;
      const type = /<type>([^<]*)<\/type>/i.exec(xml)?.[1] ?? null;
      fields.push({ name, label, type });
    }
  }
  return fields;
}

/** Every scannable source file across all package directories, repo-relative. */
export async function enumerateScannableFiles(config) {
  const root = config._projectRoot ?? process.cwd();
  const out = [];
  for (const base of packageBases(config)) {
    const files = await glob('**/*', {
      cwd: base,
      absolute: true,
      nodir: true,
      ignore: IGNORED,
    }).catch(() => []);
    for (const abs of files) {
      const rel = path.relative(root, abs);
      const source = classifyOfflineSource(rel);
      if (source) out.push({ abs, rel, ...source });
    }
  }
  return out;
}

/**
 * Scan the repo for references to every field on one object.
 *
 * Each file is read ONCE and tested against every field, rather than re-reading
 * the tree per field. An object with 200 fields over a 5,000-file repo is 5,000
 * reads this way and 1,000,000 the other.
 *
 * @param {object} config - loaded sfdt config
 * @param {string} object - sObject API name
 * @returns {Promise<import('@sfdt/flow-core').FieldUsageVM>}
 */
export async function runOfflineFieldUsage(config, object) {
  const fields = await fieldsForObject(config, object);
  const notes = [];

  if (fields.length === 0) {
    notes.push(
      `No field metadata found for ${object} under the configured package directories. That is a ` +
        `fact about this repository — the object may not be tracked in source — not a finding ` +
        `about any field.`,
    );
    return buildOfflineUsageVM({ object, fields, hits: [], notes });
  }

  notes.push(
    `Offline mode reads ${object}'s field definitions from source, so it covers the ` +
      `${fields.length} field(s) tracked in this repository. Standard fields, and anything ` +
      `deployed to an org but not committed here, are not included at all.`,
  );

  const files = await enumerateScannableFiles(config);
  const patterns = fields.map((f) => ({ name: f.name, re: fieldReferenceRegex(f.name) }));
  const hits = [];

  for (const file of files) {
    const text = await fs.readFile(file.abs, 'utf8').catch(() => null);
    if (text === null) continue;
    for (const { name, re } of patterns) {
      // A field's own definition names it in `<fullName>`; counting that would
      // make every field reference itself.
      if (isSelfDefinition(file.rel, name)) continue;
      if (re.test(text)) {
        hits.push({ field: name, path: file.rel, type: file.type, kind: file.kind });
      }
    }
  }

  notes.push(`${files.length} source file(s) scanned across the configured package directories.`);
  return buildOfflineUsageVM({ object, fields, hits, notes });
}
