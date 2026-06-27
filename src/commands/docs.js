import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { generateDocs, collectProjectMetadata, buildErdMermaid } from '../lib/doc-generator.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

const DEFAULT_ROLES = ['developer', 'admin', 'user', 'devops'];

/** Resolve the --roles flag value into a role list (or null when the flag is absent). */
function resolveRoleOption(roleOption, config) {
  if (roleOption == null) return null; // flag not passed
  if (typeof roleOption === 'string') {
    return roleOption.split(',').map((r) => r.trim()).filter(Boolean);
  }
  // flag passed without a value (boolean true) → fall back to config, then default
  return config.docs?.roles?.length ? config.docs.roles : DEFAULT_ROLES;
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
        ai: !!options.ai,
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
    .option('--ai', 'Enrich the index with an AI-written project overview')
    .option('--roles [list]', 'Also generate per-component Developer/Admin/User/DevOps guides (AI); optional comma list to subset, e.g. --roles developer,admin')
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeGenerate(options));

  docs
    .command('diagram')
    .description('Print (or write) a Mermaid ER diagram of the data model')
    .option('--output <file>', 'Write the diagram to this path instead of stdout')
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeDiagram(options));
}
