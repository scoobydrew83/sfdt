import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import { runAiPrompt, isAiAvailable } from './ai.js';

/**
 * Project documentation generator.
 *
 * Clean-room reimplementation of the "project to markdown" documentation pattern
 * popular in Salesforce DevOps tooling. Reads local source metadata (custom
 * objects + fields, Apex classes, Flows), renders MkDocs-compatible markdown,
 * and emits a Mermaid ER diagram. AI enrichment (a prose project overview) is
 * optional and reuses src/lib/ai.js; everything else works with no AI.
 *
 * The collect/render helpers are pure and string-based (XML parsed with focused
 * regexes, mirroring the approach in gui-server handlers) so they are easy to
 * unit-test without a live org or filesystem fixtures.
 */

// ---------------------------------------------------------------------------
// XML helpers (focused, not a full parser)
// ---------------------------------------------------------------------------

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].trim()) : null;
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse a *.field-meta.xml body into a field descriptor. */
export function parseField(xml, fallbackName) {
  return {
    name: tag(xml, 'fullName') ?? fallbackName,
    label: tag(xml, 'label') ?? fallbackName,
    type: tag(xml, 'type') ?? 'Unknown',
    required: tag(xml, 'required') === 'true',
    referenceTo: tag(xml, 'referenceTo'),
    description: tag(xml, 'description'),
  };
}

/** Parse a *.cls-meta.xml body for the API version. */
export function parseApexMeta(xml) {
  return { apiVersion: tag(xml, 'apiVersion') };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Walk the project's source path and collect documentable metadata.
 * @returns {Promise<{objects: Array, apex: Array, flows: Array, sourcePath: string}>}
 */
export async function collectProjectMetadata(config) {
  const root = config._projectRoot ?? process.cwd();
  const sourcePath = config.defaultSourcePath ?? 'force-app/main/default';
  const base = path.join(root, sourcePath);

  const objects = await collectObjects(base);
  const apex = await collectApex(base);
  const flows = await collectFlows(base);
  return { objects, apex, flows, sourcePath };
}

async function collectObjects(base) {
  const fieldFiles = await glob('objects/*/fields/*.field-meta.xml', { cwd: base, absolute: true });
  const byObject = new Map();
  for (const file of fieldFiles) {
    const objName = path.basename(path.dirname(path.dirname(file)));
    const fieldName = path.basename(file).replace(/\.field-meta\.xml$/, '');
    const xml = await fs.readFile(file, 'utf8').catch(() => '');
    if (!byObject.has(objName)) byObject.set(objName, { name: objName, fields: [] });
    byObject.get(objName).fields.push(parseField(xml, fieldName));
  }
  // Also pick up objects that have a .object-meta.xml but no custom fields.
  const objMeta = await glob('objects/*/*.object-meta.xml', { cwd: base, absolute: true });
  for (const file of objMeta) {
    const objName = path.basename(path.dirname(file));
    const xml = await fs.readFile(file, 'utf8').catch(() => '');
    if (!byObject.has(objName)) byObject.set(objName, { name: objName, fields: [] });
    byObject.get(objName).label = tag(xml, 'label') ?? objName;
    byObject.get(objName).description = tag(xml, 'description');
  }
  return [...byObject.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function collectApex(base) {
  const files = await glob('classes/*.cls', { cwd: base, absolute: true });
  const out = [];
  for (const file of files) {
    const name = path.basename(file).replace(/\.cls$/, '');
    const body = await fs.readFile(file, 'utf8').catch(() => '');
    const metaXml = await fs.readFile(`${file}-meta.xml`, 'utf8').catch(() => '');
    out.push({
      name,
      apiVersion: parseApexMeta(metaXml).apiVersion,
      isTest: /@isTest/i.test(body),
      methods: extractApexMethods(body),
      doc: extractLeadingComment(body),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectFlows(base) {
  const files = await glob('flows/*.flow-meta.xml', { cwd: base, absolute: true });
  const out = [];
  for (const file of files) {
    const name = path.basename(file).replace(/\.flow-meta\.xml$/, '');
    const xml = await fs.readFile(file, 'utf8').catch(() => '');
    out.push({
      name,
      label: tag(xml, 'label') ?? name,
      status: tag(xml, 'status'),
      processType: tag(xml, 'processType'),
      description: tag(xml, 'description'),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Extract method signatures from Apex source (best-effort, for an index). */
export function extractApexMethods(body) {
  const re = /(public|private|protected|global)\s+(?:static\s+)?(?:override\s+)?[\w<>,.\[\] ]+?\s+(\w+)\s*\(/g;
  const names = new Set();
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!/^(if|for|while|catch|switch)$/i.test(m[2])) names.add(m[2]);
  }
  return [...names];
}

function extractLeadingComment(body) {
  const m = body.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!m) return null;
  return m[1].replace(/^\s*\*\s?/gm, '').trim() || null;
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

export function renderObjectMarkdown(obj) {
  const lines = [`# ${obj.label ?? obj.name}`, ''];
  if (obj.description) lines.push(obj.description, '');
  lines.push(`**API name:** \`${obj.name}\``, '');
  if (obj.fields.length) {
    lines.push('## Fields', '', '| Field | Label | Type | Required | References |', '| --- | --- | --- | --- | --- |');
    for (const f of obj.fields) {
      lines.push(`| \`${f.name}\` | ${f.label ?? ''} | ${f.type} | ${f.required ? '✓' : ''} | ${f.referenceTo ?? ''} |`);
    }
    lines.push('');
  } else {
    lines.push('_No custom fields._', '');
  }
  return lines.join('\n');
}

export function renderApexMarkdown(cls) {
  const lines = [`# ${cls.name}${cls.isTest ? ' _(test)_' : ''}`, ''];
  if (cls.doc) lines.push(cls.doc, '');
  if (cls.apiVersion) lines.push(`**API version:** ${cls.apiVersion}`, '');
  if (cls.methods.length) {
    lines.push('## Methods', '');
    for (const m of cls.methods) lines.push(`- \`${m}()\``);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderFlowMarkdown(flow) {
  const lines = [`# ${flow.label}`, ''];
  if (flow.description) lines.push(flow.description, '');
  lines.push(`**API name:** \`${flow.name}\``);
  if (flow.status) lines.push(`**Status:** ${flow.status}`);
  if (flow.processType) lines.push(`**Type:** ${flow.processType}`);
  return lines.join('\n');
}

/**
 * Build a Mermaid ER diagram from collected objects and their lookup/MD fields.
 */
export function buildErdMermaid(objects) {
  const lines = ['```mermaid', 'erDiagram'];
  for (const obj of objects) {
    const rels = obj.fields.filter((f) => f.referenceTo);
    for (const f of rels) {
      lines.push(`  ${sanitizeId(obj.name)} }o--|| ${sanitizeId(f.referenceTo)} : "${f.name}"`);
    }
  }
  // Entity attribute blocks (custom fields) for objects.
  for (const obj of objects) {
    if (!obj.fields.length) continue;
    lines.push(`  ${sanitizeId(obj.name)} {`);
    for (const f of obj.fields.slice(0, 30)) {
      lines.push(`    ${sanitizeType(f.type)} ${sanitizeId(f.name)}`);
    }
    lines.push('  }');
  }
  lines.push('```');
  return lines.join('\n');
}

function sanitizeId(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}
function sanitizeType(s) {
  return String(s).replace(/[^A-Za-z0-9]/g, '') || 'Field';
}

export function renderIndex(meta, overview) {
  const lines = ['# Project Documentation', ''];
  if (overview) lines.push(overview, '');
  lines.push(
    '## Contents',
    '',
    `- **${meta.objects.length}** objects`,
    `- **${meta.apex.length}** Apex classes`,
    `- **${meta.flows.length}** flows`,
    '',
    '## Data Model',
    '',
    buildErdMermaid(meta.objects),
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Generate documentation for a project and write it to the output directory.
 *
 * @param {object} config
 * @param {object} [options]
 * @param {boolean} [options.ai] - enrich the index with an AI overview.
 * @returns {Promise<{outputDir, files, counts, aiUsed}>}
 */
export async function generateDocs(config, { ai = false } = {}) {
  const root = config._projectRoot ?? process.cwd();
  const outDir = path.isAbsolute(config.docs?.outputDir ?? 'docs')
    ? config.docs.outputDir
    : path.join(root, config.docs?.outputDir ?? 'docs');

  const meta = await collectProjectMetadata(config);

  let overview = null;
  let aiUsed = false;
  const wantAi = ai && (config.docs?.ai ?? true);
  if (wantAi && (await isAiAvailable(config))) {
    overview = await buildAiOverview(meta, config);
    aiUsed = !!overview;
  }

  const files = [];
  const write = async (rel, content) => {
    const dest = path.join(outDir, rel);
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, content.endsWith('\n') ? content : `${content}\n`);
    files.push(rel);
  };

  await write('index.md', renderIndex(meta, overview));
  for (const obj of meta.objects) await write(path.join('objects', `${obj.name}.md`), renderObjectMarkdown(obj));
  for (const cls of meta.apex) await write(path.join('apex', `${cls.name}.md`), renderApexMarkdown(cls));
  for (const flow of meta.flows) await write(path.join('flows', `${flow.name}.md`), renderFlowMarkdown(flow));
  await write('mkdocs.yml', renderMkDocsConfig(config, meta));

  return {
    outputDir: outDir,
    files,
    counts: { objects: meta.objects.length, apex: meta.apex.length, flows: meta.flows.length },
    aiUsed,
  };
}

async function buildAiOverview(meta, config) {
  const prompt =
    `Write a concise (2-3 paragraph) plain-English overview of this Salesforce project for a documentation site. ` +
    `Do not invent details. Objects: ${meta.objects.map((o) => o.name).join(', ') || 'none'}. ` +
    `Apex classes: ${meta.apex.map((a) => a.name).join(', ') || 'none'}. ` +
    `Flows: ${meta.flows.map((f) => f.label).join(', ') || 'none'}.`;
  try {
    const text = await runAiPrompt(prompt, { config, aiEnabled: true });
    return typeof text === 'string' ? text.trim() : null;
  } catch {
    return null;
  }
}

export function renderMkDocsConfig(config, meta) {
  const name = config.projectName || 'Salesforce Project';
  const nav = [
    'nav:',
    '  - Home: index.md',
    ...(meta.objects.length ? ['  - Objects:', ...meta.objects.map((o) => `      - ${o.name}: objects/${o.name}.md`)] : []),
    ...(meta.apex.length ? ['  - Apex:', ...meta.apex.map((a) => `      - ${a.name}: apex/${a.name}.md`)] : []),
    ...(meta.flows.length ? ['  - Flows:', ...meta.flows.map((f) => `      - ${f.name}: flows/${f.name}.md`)] : []),
  ];
  return [`site_name: ${name} Documentation`, 'theme:', '  name: material', ...nav, ''].join('\n');
}
