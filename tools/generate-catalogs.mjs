/**
 * generate-catalogs — regenerates every surface catalog under generated/ from
 * the code that defines it. Code is authoritative; the catalogs are derived,
 * checked in, human-readable, and diffed in CI (tools/check-catalog-drift.mjs).
 *
 *   npm run generate:catalogs
 *
 * Sources (one concept, one registry):
 *   commands.json         createCli() Commander tree + src/lib/command-policy.js
 *   chrome-features.json  extension/lib/feature-manifests.json (parity-tested
 *                         against the real registrations by
 *                         extension/test/feature-manifests.test.ts)
 *   gui-pages.json        gui/src/routes.js GUI_ROUTES
 *   vscode-commands.json  vscode/package.json contributes + COMMAND_CATALOG
 *                         (vscode/src/lib/commands.ts, esbuild-transpiled)
 *   mcp-tools.json        src/lib/mcp-server.js TOOLS
 *   bridge-contract.json  @sfdt/flow-core/bridge-contract (built dist)
 *   ci-capabilities.json  src/lib/ci-capabilities.js
 *   packages.json         the workspace package manifests
 *   surface-parity.json   COMMAND_POLICY surfaces + mcp mappings
 *   summary.json          counts derived from all of the above
 *   catalog-version.json  schemaVersion + package versions + protocol
 *                         (deliberately NO timestamp / commit — output must be
 *                         byte-identical across runs of the same source)
 *
 * Requires a built @sfdt/flow-core (npm run build:flow-core) — same
 * prerequisite the CLI itself has.
 */

import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs-extra';
import { build } from 'esbuild';
import Ajv from 'ajv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'generated');
const SCHEMA_DIR = path.join(ROOT, 'schemas');

const { createCli } = await import(pathToFileURL(path.join(ROOT, 'src/cli.js')));
const { COMMAND_POLICY, MCP_INTERNAL_TOOLS } = await import(
  pathToFileURL(path.join(ROOT, 'src/lib/command-policy.js'))
);
const { TOOLS } = await import(pathToFileURL(path.join(ROOT, 'src/lib/mcp-server.js')));
const ciCapabilities = await import(pathToFileURL(path.join(ROOT, 'src/lib/ci-capabilities.js')));
const { GUI_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'gui/src/routes.js')));
const bridge = await import('@sfdt/flow-core/bridge-contract');

/** Import a TS module by transpiling it to a temp file with esbuild. */
async function importTs(relPath) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-catalog-'));
  const outfile = path.join(tmp, 'mod.mjs');
  await build({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    external: ['vscode'],
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile));
  await fs.remove(tmp);
  return mod;
}

// ---------------------------------------------------------------- commands

// Commands whose implementation file doesn't match `src/commands/<name>.js`.
const COMMAND_SOURCE_EXCEPTIONS = {
  'pr-description': 'src/commands/prDescription.js',
  version: 'src/cli.js', // registered inline by createCli()
};

function walkCommand(cmd, parentPath = []) {
  const cmdPath = [...parentPath, cmd.name()];
  return {
    id: cmdPath.join(' '),
    path: cmdPath,
    description: cmd.description() || '',
    aliases: cmd.aliases(),
    hidden: !!cmd._hidden,
    arguments: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
      description: a.description || '',
    })),
    options: cmd.options.map((o) => ({
      flags: o.flags,
      name: o.attributeName(),
      required: !!o.mandatory,
      default: o.defaultValue ?? null,
      description: o.description || '',
    })),
    subcommands: cmd.commands.map((sub) => walkCommand(sub, cmdPath)),
  };
}

function buildCommandsCatalog(program) {
  return {
    commands: program.commands.map((cmd) => {
      const policy = COMMAND_POLICY[cmd.name()];
      if (!policy) throw new Error(`No COMMAND_POLICY entry for "${cmd.name()}" — add one to src/lib/command-policy.js`);
      const { mcpTools, surfaces, ...rest } = policy;
      return {
        ...walkCommand(cmd),
        ...rest,
        surfaces: {
          cli: true,
          sfPlugin: true, // code-generated from this same Commander tree
          ...surfaces,
        },
        mcpTools: Object.entries(mcpTools).map(([name, meta]) => ({ name, ...meta })),
        source: COMMAND_SOURCE_EXCEPTIONS[cmd.name()] ?? `src/commands/${cmd.name()}.js`,
      };
    }),
  };
}

// ------------------------------------------------------------------- main

const program = createCli();

const commandsCatalog = buildCommandsCatalog(program);

const featureManifests = await fs.readJson(path.join(ROOT, 'extension/lib/feature-manifests.json'));
const chromeCatalog = { features: featureManifests };

const guiCatalog = { pages: GUI_ROUTES };

const vscodePkg = await fs.readJson(path.join(ROOT, 'vscode/package.json'));
const { COMMAND_CATALOG } = await importTs('vscode/src/lib/commands.ts');
const vscodeCatalog = {
  contributedCommands: (vscodePkg.contributes?.commands ?? []).map((c) => ({
    command: c.command,
    title: c.title,
    icon: c.icon ?? null,
  })),
  cliCommandCatalog: COMMAND_CATALOG.map((e) => ({
    id: e.id,
    label: e.label,
    detail: e.detail ?? '',
    args: e.args,
    group: e.group ?? null,
  })),
};

const mcpCatalog = {
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description || '',
    confirmExecution: !!t.inputSchema?.properties?.confirmExecution,
    internal: MCP_INTERNAL_TOOLS.includes(t.name),
    inputProperties: Object.keys(t.inputSchema?.properties ?? {}),
  })),
};

// Kind classification: the native host is a read-only fallback transport —
// deploy/rollback/ai are bridge-only (host/src/index.js rejects them with
// NOT_IMPLEMENTED). Mutating kinds are the org-changing subset.
const BRIDGE_ONLY_KINDS = ['deploy', 'rollback', 'ai'];
const MUTATING_KINDS = ['deploy', 'rollback'];
const bridgeCatalog = {
  protocolVersion: bridge.PROTOCOL_VERSION,
  kinds: bridge.KNOWN_KINDS.map((kind) => ({
    kind,
    mutating: MUTATING_KINDS.includes(kind),
    nativeHost: !BRIDGE_ONLY_KINDS.includes(kind),
  })),
};

const ciCatalog = {
  providers: ciCapabilities.CI_PROVIDERS,
  types: ciCapabilities.CI_TYPES,
  authMethods: ciCapabilities.AUTH_METHODS,
  runners: ciCapabilities.CI_RUNNERS,
  actionRunnerTypes: ciCapabilities.ACTION_RUNNER_TYPES,
};

const PACKAGE_MANIFESTS = [
  'package.json',
  'extension/package.json',
  'gui/package.json',
  'host/package.json',
  'vscode/package.json',
  'packages/flow-core/package.json',
  'packages/plugin/package.json',
];
const packagesCatalog = {
  packages: await Promise.all(
    PACKAGE_MANIFESTS.map(async (rel) => {
      const pkg = await fs.readJson(path.join(ROOT, rel));
      return {
        path: rel,
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? null,
        private: !!pkg.private,
        engines: pkg.engines ?? null,
      };
    }),
  ),
};

const parityCatalog = {
  commands: commandsCatalog.commands.map((c) => ({
    id: c.id,
    surfaces: c.surfaces,
    mcpTools: c.mcpTools.map((t) => t.name),
    sideEffects: c.sideEffects ?? null,
  })),
  mcpInternalTools: MCP_INTERNAL_TOOLS,
};

const rootPkg = await fs.readJson(path.join(ROOT, 'package.json'));
const extPkg = await fs.readJson(path.join(ROOT, 'extension/package.json'));
const vscPkg = vscodePkg;
const fcPkg = await fs.readJson(path.join(ROOT, 'packages/flow-core/package.json'));

const catalogVersion = {
  schemaVersion: 1,
  cliVersion: rootPkg.version,
  extensionVersion: extPkg.version,
  vscodeVersion: vscPkg.version,
  flowCoreVersion: fcPkg.version,
  bridgeProtocol: bridge.PROTOCOL_VERSION,
};

const summary = {
  cli: {
    topLevelCommands: commandsCatalog.commands.length,
    jsonCapableCommands: commandsCatalog.commands.filter((c) => c.supportsJson).length,
    mutatingCommands: commandsCatalog.commands.filter((c) => c.mutating).length,
  },
  chrome: {
    registeredFeatures: chromeCatalog.features.length,
    displayTools: chromeCatalog.features.filter((f) => f.sideButton).length,
    workspaceTools: chromeCatalog.features.filter((f) => f.workspace).length,
    bridgeRequired: chromeCatalog.features.filter((f) => f.bridgeRequired).length,
    standalone: chromeCatalog.features.filter((f) => !f.bridgeRequired).length,
    syntheticMenuItems: 1, // __open-workspace__, never counted as a feature
  },
  gui: { pages: guiCatalog.pages.length },
  vscode: {
    contributedCommands: vscodeCatalog.contributedCommands.length,
    cliCatalogEntries: vscodeCatalog.cliCommandCatalog.length,
  },
  mcp: {
    tools: mcpCatalog.tools.length,
    confirmGated: mcpCatalog.tools.filter((t) => t.confirmExecution).length,
  },
  bridge: {
    protocolVersion: bridgeCatalog.protocolVersion,
    kinds: bridgeCatalog.kinds.length,
    nativeHostKinds: bridgeCatalog.kinds.filter((k) => k.nativeHost).length,
  },
  ci: {
    providers: ciCatalog.providers.length,
    types: ciCatalog.types.length,
  },
};

// ------------------------------------------------------ validate and write

const CATALOGS = {
  'catalog-version.json': catalogVersion,
  'commands.json': commandsCatalog,
  'chrome-features.json': chromeCatalog,
  'gui-pages.json': guiCatalog,
  'vscode-commands.json': vscodeCatalog,
  'mcp-tools.json': mcpCatalog,
  'bridge-contract.json': bridgeCatalog,
  'ci-capabilities.json': ciCatalog,
  'packages.json': packagesCatalog,
  'surface-parity.json': parityCatalog,
  'summary.json': summary,
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
for (const file of Object.keys(CATALOGS)) {
  const schemaPath = path.join(SCHEMA_DIR, file.replace('.json', '.schema.json'));
  if (await fs.pathExists(schemaPath)) {
    const validate = ajv.compile(await fs.readJson(schemaPath));
    if (!validate(CATALOGS[file])) {
      console.error(`Schema validation failed for ${file}:`);
      console.error(validate.errors);
      process.exit(1);
    }
  }
}

const checkMode = process.argv.includes('--check');

if (checkMode) {
  // Compare in memory against the checked-in files — never mutates the tree.
  const stale = [];
  for (const [file, data] of Object.entries(CATALOGS)) {
    const target = path.join(OUT_DIR, file);
    const expected = `${JSON.stringify(data, null, 2)}\n`;
    const actual = (await fs.pathExists(target)) ? await fs.readFile(target, 'utf-8') : null;
    if (actual !== expected) stale.push(file);
  }
  if (stale.length) {
    console.error(`Catalog drift detected in: ${stale.join(', ')}`);
    console.error('The code changed but generated/ was not regenerated. Run: npm run generate:catalogs');
    process.exit(1);
  }
  console.log(`Catalogs up to date (${Object.keys(CATALOGS).length} files).`);
} else {
  await fs.ensureDir(OUT_DIR);
  for (const [file, data] of Object.entries(CATALOGS)) {
    await fs.writeFile(path.join(OUT_DIR, file), `${JSON.stringify(data, null, 2)}\n`);
  }
  console.log(`Wrote ${Object.keys(CATALOGS).length} catalogs to generated/`);
  console.log(JSON.stringify(summary, null, 2));
}
