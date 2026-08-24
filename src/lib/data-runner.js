import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import { execa } from 'execa';
import { safeParse } from './org-query.js';

/**
 * Data set import/export runner.
 *
 * Clean-room reimplementation of sandbox/scratch data seeding using the native
 * Salesforce CLI data commands. A "data set" is a directory under
 * `config.data.dir` (default `.sfdt/data`), and comes in two shapes:
 *
 *  - TREE (`queries.json`, a list of SOQL statements) — `sf data export tree`
 *    produces a plan + record files, `sf data import tree` replays them, and
 *    delete bulk-removes the records. Good for a few hundred related records
 *    with relationships preserved; it is what `export`/`import`/`delete` use.
 *  - BULK (`bulk.json`, a list of CSV load operations) — `sf data import bulk`
 *    and `sf data upsert bulk` over Bulk API v2, which is the only path that
 *    scales past a few thousand rows and the only one that can upsert by
 *    external id. Used by `load`.
 *
 * The two are deliberately separate verbs rather than one polymorphic `import`:
 * a tree import needs a plan file produced by a prior export, a bulk load reads
 * a CSV that lives in the repo, and collapsing them makes every error message
 * ambiguous about which lifecycle the user is in.
 *
 * Arg-building, spec parsing and CSV header mapping are pure so they can be
 * unit-tested without a live org.
 */

/** Resolve the directory holding a named data set. */
export function dataSetDir(config, setName) {
  const root = config._projectRoot ?? process.cwd();
  const base = config.data?.dir ?? '.sfdt/data';
  const baseAbs = path.isAbsolute(base) ? base : path.join(root, base);
  return path.join(baseAbs, setName);
}

/** Read the SOQL queries for a data set from its queries.json. */
export async function readQueries(config, setName) {
  const file = path.join(dataSetDir(config, setName), 'queries.json');
  const data = await fs.readJson(file).catch(() => {
    throw new Error(`Data set "${setName}" not found — expected ${file} with a { "queries": [...] } array.`);
  });
  const queries = Array.isArray(data) ? data : data.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error(`Data set "${setName}" has no queries in queries.json.`);
  }
  return queries;
}

/** Extract the target sObject name from a SOQL FROM clause. */
export function extractSObject(soql) {
  const m = String(soql).match(/\bfrom\s+([A-Za-z0-9_]+)/i);
  return m ? m[1] : null;
}

/** Build argv for `sf data export tree` from a set of queries. */
export function buildExportArgs(queries, orgAlias, outputDir) {
  const args = ['data', 'export', 'tree', '--target-org', orgAlias, '--output-dir', outputDir, '--plan', '--json'];
  for (const q of queries) args.push('--query', q);
  return args;
}

/**
 * List available data set names under the data dir, tree and bulk alike.
 *
 * Both spec files are globbed because a bulk set is still a data set: listing
 * only `queries.json` would make `data list` report a set as absent right up
 * until `data load` runs it.
 */
export async function listDataSets(config) {
  const root = config._projectRoot ?? process.cwd();
  const base = config.data?.dir ?? '.sfdt/data';
  const baseAbs = path.isAbsolute(base) ? base : path.join(root, base);
  const files = await glob('*/{queries,bulk}.json', { cwd: baseAbs, absolute: false });
  return [...new Set(files.map((f) => path.dirname(f)))].sort();
}

/** Export a data set's records from an org into its data directory. */
export async function exportDataSet(config, setName, orgAlias) {
  const queries = await readQueries(config, setName);
  const outDir = path.join(dataSetDir(config, setName), 'data');
  await fs.ensureDir(outDir);
  const args = buildExportArgs(queries, orgAlias, outDir);
  let result;
  try {
    result = await execa('sf', args);
  } catch (err) {
    throw sfError(err);
  }
  const parsed = safeParse(result.stdout);
  const planFile = await resolvePlanFile(outDir);
  return {
    set: setName,
    org: orgAlias,
    outputDir: outDir,
    planFile,
    records: parsed?.result?.length ?? null,
  };
}

/** Locate the *-plan.json produced by `sf data export tree --plan`. */
export async function resolvePlanFile(outDir) {
  const plans = await glob('*-plan.json', { cwd: outDir, absolute: true });
  return plans[0] ?? null;
}

/** Import a previously-exported data set into an org. */
export async function importDataSet(config, setName, orgAlias) {
  const outDir = path.join(dataSetDir(config, setName), 'data');
  const planFile = await resolvePlanFile(outDir);
  if (!planFile) {
    throw new Error(`No plan file found for data set "${setName}" — run \`sfdt data export ${setName}\` first.`);
  }
  let result;
  try {
    result = await execa('sf', [
      'data', 'import', 'tree', '--target-org', orgAlias, '--plan', planFile, '--json',
    ]);
  } catch (err) {
    throw sfError(err);
  }
  const parsed = safeParse(result.stdout);
  return {
    set: setName,
    org: orgAlias,
    planFile,
    imported: parsed?.result?.length ?? null,
  };
}

/**
 * Rethrow an sf/execa failure with the CLI's structured JSON error message
 * (from stdout or stderr) instead of the opaque "Command failed…" string.
 */
function sfError(err) {
  const msg = safeParse(err?.stdout)?.message ?? safeParse(err?.stderr)?.message;
  if (msg) {
    const e = new Error(msg);
    e.stderr = err?.stderr;
    return e;
  }
  return err;
}

/** Bulk-delete the records targeted by a data set's queries. */
export async function deleteDataSet(config, setName, orgAlias) {
  const queries = await readQueries(config, setName);
  const results = [];
  // Run a delete for EVERY query — a data set may have multiple queries for the
  // same sObject (different WHERE filters). Deduping by sObject would silently
  // leave the records matched by all but the first such query behind.
  for (const query of queries) {
    const sobject = extractSObject(query);
    if (!sobject) {
      // Record as skipped rather than silently dropping — the user already
      // confirmed deletion and would otherwise have no way to know a query was
      // not run.
      results.push({ sobject: null, status: 'skipped', query: oneLine(query) });
      continue;
    }
    try {
      await execa('sf', ['data', 'delete', 'bulk', '--sobject', sobject, '--query', query, '--target-org', orgAlias, '--json']);
      results.push({ sobject, status: 'ok' });
    } catch (err) {
      // Prefer sf's structured error (stdout/stderr) over the opaque execa
      // message, matching org-query/monitor-runner.
      const sfMsg = safeParse(err?.stdout)?.message ?? safeParse(err?.stderr)?.message;
      results.push({ sobject, status: 'error', error: oneLine(sfMsg ?? err.message) });
    }
  }
  return { set: setName, org: orgAlias, sobjects: results };
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Bulk API v2 loading
//
// `sf data import tree` tops out in the low thousands of records and cannot
// upsert, so a data set that needs either uses a `bulk.json` spec instead:
//
//   { "operations": [
//       { "sobject": "Account", "file": "accounts.csv", "operation": "insert" },
//       { "sobject": "Contact", "file": "contacts.csv", "operation": "upsert",
//         "externalId": "External_Id__c",
//         "fieldMap": { "Company Name": "Name", "email": "Email" } }
//   ] }
//
// `fieldMap` exists because `sf data import bulk` has no mapping flag — it
// matches CSV column headers to field API names verbatim. Rather than make the
// user hand-edit exported CSVs, a declared map rewrites the header row (only
// the header) into a sibling file under `.mapped/`, which is what gets loaded.
// ---------------------------------------------------------------------------

/** Load operations we support. `delete` stays on `data delete`, which owns the confirmation gate. */
export const BULK_OPERATIONS = ['insert', 'upsert'];

/** Default minutes to wait for a bulk job before reporting it as still running. */
export const BULK_DEFAULT_WAIT_MINUTES = 10;

/**
 * Split a CSV header line into column names (RFC 4180: comma-separated, optional
 * double quotes, `""` escapes a quote). Header row only — record rows are never
 * parsed, because nothing here needs to look at the data.
 */
export function parseCsvHeader(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch !== '"') { cur += ch; continue; }
      if (line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

/** Re-emit column names as a CSV header line, quoting only where required. */
export function formatCsvHeader(cols) {
  return cols
    .map((c) => (/[",\r\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c))
    .join(',');
}

/**
 * Rewrite a CSV header line through a field map.
 *
 * Reports `unmatched` — map keys that matched no column — because a typo'd
 * mapping key is otherwise invisible: the load succeeds, the column keeps its
 * original name, and the field silently doesn't populate. That is exactly the
 * class of quiet data-loading failure this project refuses to ship.
 */
export function mapCsvHeader(line, fieldMap = {}) {
  const cols = parseCsvHeader(line);
  const seen = new Set();
  const mapped = cols.map((c) => {
    if (Object.hasOwn(fieldMap, c)) { seen.add(c); return fieldMap[c]; }
    return c;
  });
  const unmatched = Object.keys(fieldMap).filter((k) => !seen.has(k));
  return { line: formatCsvHeader(mapped), columns: mapped, renamed: seen.size, unmatched };
}

/**
 * Copy a CSV, rewriting only its header row through `fieldMap`.
 *
 * Streamed rather than read whole: Bulk API v2 exists precisely for files too
 * big to want in memory, and `fs.readFile` on a multi-hundred-MB CSV would
 * either balloon RSS or hit V8's max string length. Only the first line is ever
 * buffered.
 */
export function writeMappedCsv(srcPath, destPath, fieldMap) {
  return new Promise((resolve, reject) => {
    const src = fs.createReadStream(srcPath, { encoding: 'utf8' });
    const out = fs.createWriteStream(destPath);
    let pending = '';
    let header = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      src.destroy();
      out.destroy();
      reject(err);
    };

    src.on('data', (chunk) => {
      if (header) {
        if (!out.write(chunk)) src.pause();
        return;
      }
      pending += chunk;
      const nl = pending.indexOf('\n');
      if (nl === -1) {
        // A CSV header this long is not a header. Bail rather than buffer a
        // whole headerless file into memory.
        if (pending.length > 1_000_000) {
          fail(new Error(`${srcPath}: no header row found in the first 1 MB — is this a CSV?`));
        }
        return;
      }
      let line = pending.slice(0, nl);
      const rest = pending.slice(nl); // keeps the newline
      const carriage = line.endsWith('\r');
      if (carriage) line = line.slice(0, -1);
      header = mapCsvHeader(line, fieldMap);
      pending = '';
      if (!out.write(header.line + (carriage ? '\r' : '') + rest)) src.pause();
    });

    out.on('drain', () => src.resume());
    src.on('error', fail);
    out.on('error', fail);

    src.on('end', () => {
      // A file with no trailing newline at all is a header-only CSV: still valid
      // input (zero records), and the header must still be mapped.
      if (!header && pending.length > 0) {
        header = mapCsvHeader(pending, fieldMap);
        out.write(header.line);
      }
      out.end();
    });

    out.on('close', () => {
      if (settled) return;
      settled = true;
      resolve(header ?? { line: '', columns: [], renamed: 0, unmatched: Object.keys(fieldMap ?? {}) });
    });
  });
}

/**
 * Validate one bulk operation and resolve its CSV path inside the data set.
 *
 * The path check is a containment check, not a substring one: `file` comes from
 * a repo-committed JSON file, but a data set is exactly the kind of thing that
 * gets copied between projects, so `../../.ssh/id_rsa` must not resolve.
 */
export function resolveBulkOperation(op, setDir, setName, index) {
  const where = `bulk.json operation ${index} of data set "${setName}"`;
  const sobject = op?.sobject;
  if (typeof sobject !== 'string' || !/^[A-Za-z0-9_]+$/.test(sobject)) {
    throw new Error(`${where}: "sobject" must be an object API name.`);
  }
  const operation = op?.operation ?? 'insert';
  if (!BULK_OPERATIONS.includes(operation)) {
    throw new Error(
      `${where}: "operation" must be one of ${BULK_OPERATIONS.join(', ')} (got "${operation}"). ` +
      'Deletes go through `sfdt data delete`, which owns the confirmation gate.',
    );
  }
  if (operation === 'upsert' && (typeof op?.externalId !== 'string' || !op.externalId)) {
    throw new Error(`${where}: an upsert needs "externalId" — the field Salesforce matches on.`);
  }
  if (typeof op?.file !== 'string' || !op.file) {
    throw new Error(`${where}: "file" must name a CSV relative to the data set directory.`);
  }
  const filePath = path.resolve(setDir, op.file);
  const rel = path.relative(setDir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${where}: "file" must stay inside the data set directory (got "${op.file}").`);
  }
  const fieldMap = op?.fieldMap ?? {};
  if (typeof fieldMap !== 'object' || Array.isArray(fieldMap)) {
    throw new Error(`${where}: "fieldMap" must be an object of { csvColumn: FieldApiName }.`);
  }
  return { sobject, operation, externalId: op?.externalId ?? null, file: op.file, filePath, fieldMap };
}

/**
 * Read a data set's spec, discriminating tree-style from bulk-style.
 *
 * A set carrying both files is an error rather than a precedence rule: silently
 * picking one would make `sfdt data load` and `sfdt data import` operate on
 * different definitions of the same set name.
 */
export async function readDataSetSpec(config, setName) {
  const setDir = dataSetDir(config, setName);
  const bulkFile = path.join(setDir, 'bulk.json');
  const treeFile = path.join(setDir, 'queries.json');
  const [hasBulk, hasTree] = await Promise.all([fs.pathExists(bulkFile), fs.pathExists(treeFile)]);

  if (hasBulk && hasTree) {
    throw new Error(
      `Data set "${setName}" has both bulk.json and queries.json — keep one per set so ` +
      '`data load` and `data import` cannot disagree about what the set contains.',
    );
  }
  if (hasBulk) {
    const data = await fs.readJson(bulkFile).catch((err) => {
      throw new Error(`Data set "${setName}": ${bulkFile} is not valid JSON — ${err.message}`);
    });
    const ops = Array.isArray(data) ? data : data?.operations;
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new Error(`Data set "${setName}" has no operations in bulk.json.`);
    }
    return { kind: 'bulk', setDir, operations: ops.map((op, i) => resolveBulkOperation(op, setDir, setName, i)) };
  }
  if (hasTree) {
    return { kind: 'tree', setDir, queries: await readQueries(config, setName) };
  }
  throw new Error(
    `Data set "${setName}" not found — expected ${treeFile} (tree) or ${bulkFile} (bulk).`,
  );
}

/** Build argv for `sf data import bulk` (insert). */
export function buildImportBulkArgs(op, orgAlias, filePath, options = {}) {
  const args = [
    'data', 'import', 'bulk',
    '--file', filePath,
    '--sobject', op.sobject,
    '--target-org', orgAlias,
    '--json',
  ];
  if (options.async) args.push('--async');
  else args.push('--wait', String(options.waitMinutes ?? BULK_DEFAULT_WAIT_MINUTES));
  if (options.lineEnding) args.push('--line-ending', options.lineEnding);
  return args;
}

/** Build argv for `sf data upsert bulk` (match on an external id). */
export function buildUpsertBulkArgs(op, orgAlias, filePath, options = {}) {
  const args = [
    'data', 'upsert', 'bulk',
    '--file', filePath,
    '--sobject', op.sobject,
    '--external-id', op.externalId,
    '--target-org', orgAlias,
    '--json',
  ];
  if (options.async) args.push('--async');
  else args.push('--wait', String(options.waitMinutes ?? BULK_DEFAULT_WAIT_MINUTES));
  if (options.lineEnding) args.push('--line-ending', options.lineEnding);
  return args;
}

/** Pull the row counts out of an `sf data import|upsert bulk --json` envelope. */
export function summariseBulkResult(parsed) {
  const r = parsed?.result ?? {};
  const num = (v) => (typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    jobId: r.jobId ?? r.id ?? null,
    processed: num(r.numberRecordsProcessed ?? r.recordsProcessed),
    failed: num(r.numberRecordsFailed ?? r.recordsFailed),
  };
}

/**
 * Run every operation in a bulk data set.
 *
 * Operations run in declaration order and NOT concurrently: a bulk spec's order
 * is usually a dependency order (parents before children), and Bulk API v2 jobs
 * are already parallel server-side, so racing them here would buy nothing and
 * break the one ordering guarantee the format offers.
 *
 * A failing operation is recorded and the run continues, matching deleteDataSet
 * — the caller decides what a partial load means. `failed > 0` on a job that
 * otherwise succeeded is reported as 'error' too: Salesforce exits 0 for a job
 * that processed rows and rejected some of them, and calling that "ok" is how a
 * half-loaded data set gets mistaken for a clean one.
 */
export async function bulkLoadDataSet(config, setName, orgAlias, options = {}) {
  const spec = await readDataSetSpec(config, setName);
  if (spec.kind !== 'bulk') {
    throw new Error(
      `Data set "${setName}" is a tree data set (queries.json) — use \`sfdt data import ${setName}\`. ` +
      '`data load` reads bulk.json.',
    );
  }

  const waitMinutes = options.waitMinutes ?? config.data?.bulk?.waitMinutes ?? BULK_DEFAULT_WAIT_MINUTES;
  const lineEnding = options.lineEnding ?? config.data?.bulk?.lineEnding ?? null;
  const runOpts = { waitMinutes, lineEnding, async: !!options.async };

  const operations = [];
  for (const op of spec.operations) {
    const entry = { sobject: op.sobject, operation: op.operation, file: op.file, status: 'ok' };
    try {
      if (!(await fs.pathExists(op.filePath))) {
        throw new Error(`CSV not found: ${op.filePath}`);
      }

      let loadPath = op.filePath;
      if (Object.keys(op.fieldMap).length > 0) {
        const mappedDir = path.join(spec.setDir, '.mapped');
        await fs.ensureDir(mappedDir);
        loadPath = path.join(mappedDir, path.basename(op.file));
        const header = await writeMappedCsv(op.filePath, loadPath, op.fieldMap);
        entry.mappedFile = loadPath;
        entry.renamedColumns = header.renamed;
        if (header.unmatched.length > 0) {
          // Surfaced, never swallowed — see mapCsvHeader.
          entry.unmatchedFieldMapKeys = header.unmatched;
        }
      }

      const args = op.operation === 'upsert'
        ? buildUpsertBulkArgs(op, orgAlias, loadPath, runOpts)
        : buildImportBulkArgs(op, orgAlias, loadPath, runOpts);

      const result = await execa('sf', args);
      const summary = summariseBulkResult(safeParse(result.stdout));
      Object.assign(entry, summary);
      if (summary.failed > 0) {
        entry.status = 'error';
        entry.error = `${summary.failed} record(s) rejected by Salesforce — retrieve the job's failed-results file with \`sf data bulk results --job-id ${summary.jobId ?? '<id>'}\`.`;
      }
    } catch (err) {
      const sfMsg = safeParse(err?.stdout)?.message ?? safeParse(err?.stderr)?.message;
      entry.status = 'error';
      entry.error = oneLine(sfMsg ?? err.message);
    }
    operations.push(entry);
  }

  return { set: setName, org: orgAlias, kind: 'bulk', waitMinutes, operations };
}
