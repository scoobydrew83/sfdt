import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import { runAiPrompt, isAiAvailable, aiUnavailableMessage } from './ai.js';
import { getPrompt, interpolate } from './prompts.js';

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

/** Parse a *.js-meta.xml body into an LWC descriptor. */
export function parseLwcMeta(xml) {
  const targets = [...xml.matchAll(/<target>([\s\S]*?)<\/target>/g)].map((m) => decode(m[1].trim()));
  return {
    masterLabel: tag(xml, 'masterLabel'),
    description: tag(xml, 'description'),
    apiVersion: tag(xml, 'apiVersion'),
    isExposed: tag(xml, 'isExposed') === 'true',
    targets,
  };
}

/** Extract @api public property/method names from an LWC JS module (best-effort). */
export function extractLwcApi(js) {
  const re = /@api\s+(?:get\s+|set\s+)?(\w+)/g;
  const names = new Set();
  let m;
  while ((m = re.exec(js)) !== null) names.add(m[1]);
  return [...names];
}

/** Extract imported Apex methods (import x from '@salesforce/apex/Class.method') from an LWC JS module. */
export function extractLwcApexImports(js) {
  const re = /@salesforce\/apex\/([\w.]+)/g;
  const names = new Set();
  let m;
  while ((m = re.exec(js)) !== null) names.add(m[1]);
  return [...names];
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
  const lwc = await collectLwc(base);
  return { objects, apex, flows, lwc, sourcePath };
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

  const processFile = async (file) => {
    const name = path.basename(file).replace(/\.cls$/, '');
    const [body, metaXml] = await Promise.all([
      fs.readFile(file, 'utf8').catch(() => ''),
      fs.readFile(`${file}-meta.xml`, 'utf8').catch(() => ''),
    ]);

    return {
      name,
      apiVersion: parseApexMeta(metaXml).apiVersion,
      isTest: /@isTest/i.test(body),
      methods: extractApexMethods(body),
      doc: extractLeadingComment(body),
    };
  };

  const out = await Promise.all(files.map(processFile));
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

async function collectLwc(base) {
  const metaFiles = await glob('lwc/*/*.js-meta.xml', { cwd: base, absolute: true });
  const out = [];
  for (const file of metaFiles) {
    const dir = path.dirname(file);
    const name = path.basename(file).replace(/\.js-meta\.xml$/, '');
    const metaXml = await fs.readFile(file, 'utf8').catch(() => '');
    const js = await fs.readFile(path.join(dir, `${name}.js`), 'utf8').catch(() => '');
    const meta = parseLwcMeta(metaXml);
    out.push({
      name,
      label: meta.masterLabel ?? name,
      description: meta.description,
      apiVersion: meta.apiVersion,
      isExposed: meta.isExposed,
      targets: meta.targets,
      apiProps: extractLwcApi(js),
      apexImports: extractLwcApexImports(js),
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

export function renderLwcMarkdown(cmp) {
  const lines = [`# ${cmp.label}`, ''];
  if (cmp.description) lines.push(cmp.description, '');
  lines.push(`**API name:** \`${cmp.name}\``);
  if (cmp.apiVersion) lines.push(`**API version:** ${cmp.apiVersion}`);
  lines.push(`**Exposed:** ${cmp.isExposed ? 'yes' : 'no'}`);
  if (cmp.targets?.length) lines.push(`**Targets:** ${cmp.targets.join(', ')}`);
  lines.push('');
  if (cmp.apiProps?.length) {
    lines.push('## Public (@api) properties', '');
    for (const p of cmp.apiProps) lines.push(`- \`${p}\``);
    lines.push('');
  }
  if (cmp.apexImports?.length) {
    lines.push('## Apex methods used', '');
    for (const a of cmp.apexImports) lines.push(`- \`${a}\``);
    lines.push('');
  }
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
    `- **${meta.lwc?.length ?? 0}** Lightning web components`,
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
 * @param {string[]|null} [options.roles] - when set, also generate per-component
 *   role guides (AI) for these roles; null/empty skips role guides.
 * @param {(msg: string) => void} [options.onProgress] - optional progress callback.
 * @returns {Promise<{outputDir, files, counts, aiUsed, guides}>}
 */
export async function generateDocs(config, { ai = false, roles = null, onProgress } = {}) {
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
  for (const cmp of meta.lwc) await write(path.join('lwc', `${cmp.name}.md`), renderLwcMarkdown(cmp));

  // Optional per-component, per-role AI guides.
  let guides = null;
  const wantRoles = Array.isArray(roles) && roles.length > 0;
  if (wantRoles) {
    if (!(config.features?.ai && (await isAiAvailable(config)))) {
      throw new Error(aiUnavailableMessage(config));
    }
    guides = await generateRoleGuides(meta, config, { roles, write, root, onProgress });
  }

  await write('mkdocs.yml', renderMkDocsConfig(config, meta));

  return {
    outputDir: outDir,
    files,
    counts: { objects: meta.objects.length, apex: meta.apex.length, flows: meta.flows.length, lwc: meta.lwc.length },
    aiUsed,
    guides,
  };
}

// ---------------------------------------------------------------------------
// Multi-role AI guides
// ---------------------------------------------------------------------------

/** Built-in role focus + relevance constraints, injected as {{roleInstructions}}. */
export const ROLE_GUIDES = {
  developer: {
    label: 'Developer',
    instructions:
      '- Cover code structure, public APIs, and integration patterns.\n' +
      '- Include governor-limit analysis (SOQL/DML/callouts/heap) whenever Apex logic is present.\n' +
      '- Note test-coverage and CI/CD considerations. Do NOT include end-user click-path UX steps.',
  },
  admin: {
    label: 'Admin',
    instructions:
      '- Cover permissions, metadata configuration, deployment order, and change management.\n' +
      '- Call out sandbox-refresh and environment-reset dependencies when custom settings/metadata are involved.\n' +
      '- Document validations (required fields, value limits, uniqueness). Do NOT include Apex implementation internals.',
  },
  user: {
    label: 'User',
    instructions:
      '- Write step-by-step UI guidance and real-world usage scenarios.\n' +
      '- Include troubleshooting paths ("if Save fails…", "Reset before Save") and visible validation-state indicators.\n' +
      '- Do NOT include Apex, SOQL, package.xml, or other developer internals.',
  },
  devops: {
    label: 'DevOps',
    instructions:
      '- Cover GitHub Actions workflow triggers, validation steps, and package.xml dependencies.\n' +
      '- Include version-control branching implications and rollback procedures.\n' +
      '- Use generic CI patterns; do not invent repo-specific workflow names.',
  },
};

/** A component type's plural folder name under docs/guides/. */
const GUIDE_FOLDER = { lwc: 'lwc', apex: 'apex', object: 'objects', flow: 'flows' };

/**
 * Serialize a collected component into a compact, factual source block for the AI.
 * The AI also has Read/Grep on the project to open the referenced files for depth.
 */
export function buildComponentSource(type, comp, sourcePath) {
  const lines = [];
  if (type === 'lwc') {
    lines.push(`LWC bundle: ${comp.name} (label: ${comp.label})`);
    if (comp.description) lines.push(`Description: ${comp.description}`);
    if (comp.apiVersion) lines.push(`API version: ${comp.apiVersion}`);
    lines.push(`Exposed: ${comp.isExposed ? 'yes' : 'no'}`);
    if (comp.targets?.length) lines.push(`Targets: ${comp.targets.join(', ')}`);
    if (comp.apiProps?.length) lines.push(`@api properties: ${comp.apiProps.join(', ')}`);
    if (comp.apexImports?.length) lines.push(`Apex methods imported: ${comp.apexImports.join(', ')}`);
    lines.push(`Files to read for full detail: ${sourcePath}/lwc/${comp.name}/ (${comp.name}.js, ${comp.name}.html, ${comp.name}.js-meta.xml)`);
  } else if (type === 'apex') {
    lines.push(`Apex class: ${comp.name}${comp.isTest ? ' (test class)' : ''}`);
    if (comp.doc) lines.push(`Class doc: ${comp.doc}`);
    if (comp.apiVersion) lines.push(`API version: ${comp.apiVersion}`);
    if (comp.methods?.length) lines.push(`Methods: ${comp.methods.map((m) => `${m}()`).join(', ')}`);
    lines.push(`File to read for full detail: ${sourcePath}/classes/${comp.name}.cls`);
  } else if (type === 'object') {
    lines.push(`Custom object: ${comp.name} (label: ${comp.label ?? comp.name})`);
    if (comp.description) lines.push(`Description: ${comp.description}`);
    if (comp.fields?.length) {
      lines.push('Fields:');
      for (const f of comp.fields) {
        lines.push(`  - ${f.name} (${f.type})${f.required ? ' required' : ''}${f.referenceTo ? ` -> ${f.referenceTo}` : ''}`);
      }
    }
    lines.push(`Files to read for full detail: ${sourcePath}/objects/${comp.name}/`);
  } else if (type === 'flow') {
    lines.push(`Flow: ${comp.label} (API name: ${comp.name})`);
    if (comp.processType) lines.push(`Type: ${comp.processType}`);
    if (comp.status) lines.push(`Status: ${comp.status}`);
    if (comp.description) lines.push(`Description: ${comp.description}`);
    lines.push(`File to read for full detail: ${sourcePath}/flows/${comp.name}.flow-meta.xml`);
  }
  return lines.join('\n');
}

/** Resolve a requested role list into known role keys (dedup, lowercase, validated). */
export function resolveRoles(requested) {
  const known = Object.keys(ROLE_GUIDES);
  const out = [];
  for (const r of requested) {
    const key = String(r).trim().toLowerCase();
    if (known.includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Generate per-component, per-role AI guides and write them under docs/guides/.
 * @returns {Promise<{roles, written, skipped, files}>}
 */
async function generateRoleGuides(meta, config, { roles, write, root, onProgress }) {
  const resolved = resolveRoles(roles);
  const components = [
    ...meta.lwc.map((c) => ({ type: 'lwc', comp: c })),
    ...meta.apex.map((c) => ({ type: 'apex', comp: c })),
    ...meta.objects.map((c) => ({ type: 'object', comp: c })),
    ...meta.flows.map((c) => ({ type: 'flow', comp: c })),
  ];

  // One unit of work per (component, role).
  const jobs = [];
  for (const { type, comp } of components) {
    for (const role of resolved) jobs.push({ type, comp, role });
  }

  // Announce the total upfront — each job is a 30–60s AI call, so without this
  // the first progress line only appears after the first job completes, leaving
  // the user with no sense of scale (e.g. 75 components × 4 roles = 300 calls).
  onProgress?.(
    `Generating ${jobs.length} role guide${jobs.length === 1 ? '' : 's'} ` +
      `(${components.length} component${components.length === 1 ? '' : 's'} × ${resolved.length} role${resolved.length === 1 ? '' : 's'})…`,
  );

  const template = await getPrompt('doc-role-guide', config._configDir);
  const guideFiles = [];
  let written = 0;
  const skipped = [];
  let done = 0;

  const runJob = async ({ type, comp, role }) => {
    const meta2 = ROLE_GUIDES[role];
    const prompt = interpolate(template, {
      role: meta2.label,
      componentType: type,
      componentName: comp.name,
      roleInstructions: meta2.instructions,
      source: buildComponentSource(type, comp, meta.sourcePath),
    });
    let body = null;
    try {
      const res = await runAiPrompt(prompt, {
        config,
        allowedTools: ['Read', 'Grep', 'Glob'],
        cwd: root,
        aiEnabled: true,
        interactive: false,
      });
      body = typeof res?.stdout === 'string' ? res.stdout.trim() || null : null;
    } catch {
      body = null;
    }
    done += 1;
    onProgress?.(`Guides ${done}/${jobs.length}: ${type}/${comp.name} (${role})`);
    if (!body) {
      skipped.push({ type, component: comp.name, role });
      return;
    }
    const rel = path.join('guides', GUIDE_FOLDER[type], comp.name, `${role}.md`);
    await write(rel, body);
    guideFiles.push(rel);
    written += 1;
  };

  // Small concurrency pool to keep AI load bounded.
  const CONCURRENCY = 3;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      await runJob(job);
    }
  });
  await Promise.all(workers);

  return { roles: resolved, written, skipped, files: guideFiles };
}

async function buildAiOverview(meta, config) {
  const prompt =
    `Write a concise (2-3 paragraph) plain-English overview of this Salesforce project for a documentation site. ` +
    `Do not invent details. Objects: ${meta.objects.map((o) => o.name).join(', ') || 'none'}. ` +
    `Apex classes: ${meta.apex.map((a) => a.name).join(', ') || 'none'}. ` +
    `Flows: ${meta.flows.map((f) => f.label).join(', ') || 'none'}.`;
  try {
    // runAiPrompt resolves to { stdout, stderr, exitCode } (or null), not a
    // bare string — read .stdout, else the overview is silently always null.
    const res = await runAiPrompt(prompt, { config, aiEnabled: true });
    return typeof res?.stdout === 'string' ? res.stdout.trim() || null : null;
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
    ...(meta.lwc?.length ? ['  - Lightning Components:', ...meta.lwc.map((c) => `      - ${c.name}: lwc/${c.name}.md`)] : []),
  ];
  return [`site_name: ${name} Documentation`, 'theme:', '  name: material', ...nav, ''].join('\n');
}
