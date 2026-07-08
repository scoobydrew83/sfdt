import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import {
  extractApexRefs, extractLwcApexRefs, extractFormulaRefs, extractFlowRefs,
  resolveQueryFor, referencesQuery,
} from '@sfdt/flow-core';
import { query } from './org-query.js';

// Minimal glob-by-type map (fresh copy of just what C1 needs; gui-server's TYPE_MAP untouched).
const TYPE_GLOBS = {
  apex: 'classes/*.cls',
  lwcJs: 'lwc/*/*.js',
  fields: 'objects/*/fields/*.field-meta.xml',
  flows: 'flows/*.flow-meta.xml',
};

function packageBases(config) {
  const root = config._projectRoot ?? process.cwd();
  const dirs = config.packageDirectories?.length
    ? config.packageDirectories.map((d) => d.path)
    : [config.defaultSourcePath ?? 'force-app/main/default'];
  return dirs.map((d) => path.join(root, d));
}

/** Enumerate local source files by kind across all package directories. */
export async function enumerateSourceFiles(config) {
  const bases = packageBases(config);
  const out = { apex: [], lwcJs: [], fields: [], flows: [] };
  for (const base of bases) {
    for (const [kind, pattern] of Object.entries(TYPE_GLOBS)) {
      // lwcJs must exclude *.js-meta.xml (glob '*.js' already does, but guard anyway)
      const files = await glob(pattern, { cwd: base, absolute: true });
      out[kind].push(...files.filter((f) => kind !== 'lwcJs' || f.endsWith('.js')));
    }
  }
  return out;
}

const read = (f) => fs.readFile(f, 'utf8').catch(() => '');
const baseName = (f, suffix) => path.basename(f).replace(suffix, '');

/** Parse the local source for one component and return its inferred refs. */
export async function gapsForComponent(config, { name, type }) {
  const files = await enumerateSourceFiles(config);
  const refs = [];

  if (type === 'ApexClass' || type === 'ApexTrigger') {
    const f = files.apex.find((x) => baseName(x, /\.cls$/) === name);
    if (f) refs.push(...extractApexRefs(await read(f)));
  }
  if (type === 'LightningComponentBundle') {
    // the bundle's main JS file lives in lwc/<name>/<name>.js
    const f = files.lwcJs.find((x) => path.basename(path.dirname(x)) === name);
    if (f) refs.push(...extractLwcApexRefs(await read(f)));
  }
  if (type === 'CustomField') {
    const f = files.fields.find((x) => baseName(x, /\.field-meta\.xml$/) === name);
    if (f) refs.push(...extractFormulaRefs(await read(f)));
  }
  if (type === 'Flow') {
    const f = files.flows.find((x) => baseName(x, /\.flow-meta\.xml$/) === name);
    if (f) refs.push(...extractFlowRefs(await read(f)));
  }

  // dedupe across extractors (same (kind,toType,toName))
  const seen = new Set();
  const deduped = [];
  for (const r of refs) {
    const k = `${r.kind}|${r.toType}|${r.toName}`;
    if (!seen.has(k)) { seen.add(k); deduped.push(r); }
  }
  return { from: { name, type }, refs: deduped };
}

/** Tag each inferred ref confirmed/missing against the org's Tooling references. */
export async function diffAgainstOrg(orgAlias, name, type, refs) {
  let toolingNames = null;
  try {
    const idRows = await query(orgAlias, resolveQueryFor(type, name), { tooling: true });
    if (idRows.length) {
      const rows = await query(orgAlias, referencesQuery(idRows[0].Id), { tooling: true });
      toolingNames = new Set(rows.map((r) => r.RefMetadataComponentName));
    }
  } catch {
    toolingNames = null; // org failure -> degrade to 'inferred' below
  }
  return refs.map((ref) => ({
    from: { name, type },
    ref,
    status: toolingNames == null ? 'inferred' : (toolingNames.has(ref.toName) ? 'confirmed' : 'missing'),
  }));
}

/** Top-level: parse local source, optionally diff against an org. */
export async function runGapReport(config, { name, type, org }) {
  const { from, refs } = await gapsForComponent(config, { name, type });
  if (!org) {
    return { from, gaps: refs.map((ref) => ({ from, ref, status: 'inferred' })) };
  }
  const gaps = await diffAgainstOrg(org, name, type, refs);
  return { from, org, gaps };
}
