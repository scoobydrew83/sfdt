import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { generateDocs, collectProjectMetadata, buildErdMermaid } from '../lib/doc-generator.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

const DEFAULT_ROLES = ['developer', 'admin', 'user', 'devops'];

/**
 * Resolve the --roles flag value into a role list (or null when role guides
 * are off). Precedence: explicit --roles list > bare --roles > config
 * (`docs.roleGuides` enables guides for `docs.roles`, defaulting to all four).
 */
function resolveRoleOption(roleOption, config) {
  if (typeof roleOption === 'string') {
    return roleOption.split(',').map((r) => r.trim()).filter(Boolean);
  }
  // Bare --roles (boolean true), or flag absent with docs.roleGuides enabled:
  // fall back to config.docs.roles, then the built-in default list. The config
  // path additionally requires features.ai — role guides are AI-authored, and a
  // config-driven default must not turn a working `docs generate` into an
  // AI-unavailable error (an explicit --roles flag still may).
  if (roleOption === true || (roleOption == null && config.features?.ai && config.docs?.roleGuides)) {
    return config.docs?.roles?.length ? config.docs.roles : DEFAULT_ROLES;
  }
  return null;
}

/**
 * Resolve the effective AI toggle. --ai / --no-ai wins both ways; with no
 * flag, AI is on when `features.ai` is enabled and `docs.ai` is not false.
 */
function resolveAiOption(aiFlag, config) {
  if (aiFlag !== undefined) return !!aiFlag;
  return !!(config.features?.ai && config.docs?.ai !== false);
}

/**
 * Resolve the ER-diagram toggle. --no-diagrams wins; otherwise the standalone
 * diagram page is generated when `docs.diagrams` is enabled in config.
 */
function resolveDiagramOption(diagramFlag, config) {
  if (diagramFlag === false) return false;
  return config.docs?.diagrams === true;
}

async function executeGenerate(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const roles = resolveRoleOption(options.roles, config);
    const spinner = jsonMode ? null : ora('Generating documentation…').start();
    let result;
    try {
      result = await generateDocs(config, {
        ai: resolveAiOption(options.ai, config),
        diagrams: resolveDiagramOption(options.diagrams, config),
        roles,
        onProgress: spinner ? (msg) => { spinner.text = msg; } : undefined,
      });
      spinner?.succeed(`Documentation generated (${result.files.length} files)`);
    } catch (err) {
      spinner?.fail('Documentation generation failed');
      throw err;
    }
    if (jsonMode) {
      emitJson(result);
    } else {
      console.log('');
      console.log(`  Objects: ${result.counts.objects}`);
      console.log(`  Apex:    ${result.counts.apex}`);
      console.log(`  Flows:   ${result.counts.flows}`);
      console.log(`  LWC:     ${result.counts.lwc}`);
      console.log(`  AI overview: ${result.aiUsed ? 'yes' : 'no'}`);
      if (result.diagram) {
        console.log(`  ER diagram: ${result.diagram}`);
      }
      if (result.guides) {
        console.log(`  Role guides: ${result.guides.written} written for [${result.guides.roles.join(', ')}]`);
        if (result.guides.skipped.length) {
          console.log(chalk.yellow(`  Skipped (empty AI output): ${result.guides.skipped.length}`));
        }
      }
      console.log(chalk.green(`\nWritten to ${result.outputDir}`));
      console.log(chalk.dim('Serve with: npx mkdocs serve (requires mkdocs-material)'));
    }
  } catch (err) {
    if (jsonMode) {
      emitJsonError(err);
    } else {
      console.error(chalk.red(`Docs failed: ${err.message}`));
      process.exitCode = resolveExitCode(err);
    }
  }
}

async function executeDiagram(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const meta = await collectProjectMetadata(config);
    const mermaid = buildErdMermaid(meta.objects);
    if (jsonMode) {
      emitJson({ objects: meta.objects.length, mermaid });
      return;
    }
    if (options.output) {
      await fs.ensureDir(path.dirname(options.output));
      await fs.writeFile(options.output, mermaid + '\n');
      console.log(chalk.green(`ER diagram written to ${options.output}`));
    } else {
      console.log(mermaid);
    }
  } catch (err) {
    if (jsonMode) {
      emitJsonError(err);
    } else {
      console.error(chalk.red(`Diagram failed: ${err.message}`));
      process.exitCode = resolveExitCode(err);
    }
  }
}

export function registerDocsCommand(program) {
  const docs = program
    .command('docs')
    .description('Generate project documentation (objects, Apex, flows) with optional AI overview and diagrams');

  docs
    .command('generate', { isDefault: true })
    .description('Generate MkDocs-compatible markdown documentation for the project')
    .option('--ai', 'Enrich the index with an AI-written project overview (default: on when config features.ai and docs.ai allow)')
    .option('--no-ai', 'Skip the AI overview even when enabled in config')
    .option('--roles [list]', 'Also generate per-component Developer/Admin/User/DevOps guides (AI); optional comma list to subset, e.g. --roles developer,admin (default: config docs.roleGuides + docs.roles)')
    .option('--no-diagrams', 'Skip the standalone ER-diagram page even when docs.diagrams is enabled in config')
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeGenerate(options));

  docs
    .command('diagram')
    .description('Print (or write) a Mermaid ER diagram of the data model')
    .option('--output <file>', 'Write the diagram to this path instead of stdout')
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeDiagram(options));
}
