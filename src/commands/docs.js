import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { generateDocs, collectProjectMetadata, buildErdMermaid } from '../lib/doc-generator.js';
import { resolveExitCode } from '../lib/exit-codes.js';

async function executeGenerate(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const spinner = jsonMode ? null : ora('Generating documentation…').start();
    let result;
    try {
      result = await generateDocs(config, { ai: !!options.ai });
      spinner?.succeed(`Documentation generated (${result.files.length} files)`);
    } catch (err) {
      spinner?.fail('Documentation generation failed');
      throw err;
    }
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ status: 'success', ...result }, null, 2) + '\n');
    } else {
      console.log('');
      console.log(`  Objects: ${result.counts.objects}`);
      console.log(`  Apex:    ${result.counts.apex}`);
      console.log(`  Flows:   ${result.counts.flows}`);
      console.log(`  AI overview: ${result.aiUsed ? 'yes' : 'no'}`);
      console.log(chalk.green(`\nWritten to ${result.outputDir}`));
      console.log(chalk.dim('Serve with: npx mkdocs serve (requires mkdocs-material)'));
    }
  } catch (err) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
    } else {
      console.error(chalk.red(`Docs failed: ${err.message}`));
    }
    process.exitCode = resolveExitCode(err);
  }
}

async function executeDiagram(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const meta = await collectProjectMetadata(config);
    const mermaid = buildErdMermaid(meta.objects);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ status: 'success', objects: meta.objects.length, mermaid }, null, 2) + '\n');
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
      process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
    } else {
      console.error(chalk.red(`Diagram failed: ${err.message}`));
    }
    process.exitCode = resolveExitCode(err);
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
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeGenerate(options));

  docs
    .command('diagram')
    .description('Print (or write) a Mermaid ER diagram of the data model')
    .option('--output <file>', 'Write the diagram to this path instead of stdout')
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeDiagram(options));
}
