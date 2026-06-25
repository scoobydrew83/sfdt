import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import { execa } from 'execa';

/**
 * Data set import/export runner.
 *
 * Clean-room reimplementation of sandbox/scratch data seeding using the native
 * Salesforce CLI tree commands (`sf data export tree` / `sf data import tree`).
 * A "data set" is a directory under `config.data.dir` (default `.sfdt/data`)
 * containing a `queries.json` of SOQL statements. Export produces a tree
 * plan + record files; import replays them; delete bulk-removes the records.
 *
 * Arg-building and parsing helpers are pure so they can be unit-tested without
 * a live org.
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

/** List available data set names under the data dir. */
export async function listDataSets(config) {
  const root = config._projectRoot ?? process.cwd();
  const base = config.data?.dir ?? '.sfdt/data';
  const baseAbs = path.isAbsolute(base) ? base : path.join(root, base);
  const files = await glob('*/queries.json', { cwd: baseAbs, absolute: false });
  return files.map((f) => path.dirname(f)).sort();
}

/** Export a data set's records from an org into its data directory. */
export async function exportDataSet(config, setName, orgAlias) {
  const queries = await readQueries(config, setName);
  const outDir = path.join(dataSetDir(config, setName), 'data');
  await fs.ensureDir(outDir);
  const args = buildExportArgs(queries, orgAlias, outDir);
  const result = await execa('sf', args);
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
  const result = await execa('sf', [
    'data', 'import', 'tree', '--target-org', orgAlias, '--plan', planFile, '--json',
  ]);
  const parsed = safeParse(result.stdout);
  return {
    set: setName,
    org: orgAlias,
    planFile,
    imported: parsed?.result?.length ?? null,
  };
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

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}
