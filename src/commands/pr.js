import path from 'path';
import fs from 'fs-extra';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { postPrComment } from '../lib/github-pr.js';
import { buildSnapshotMessage, renderMarkdown } from '../lib/notifier-formatters.js';
import { maxStatus } from '../lib/check-status.js';

async function snapshotMarkdown(type, config) {
  const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');
  const snapPath = path.join(logDir, `${type}-latest.json`);
  if (!(await fs.pathExists(snapPath))) {
    throw new Error(`No ${type} snapshot at ${snapPath} — run "sfdt ${type} all" first.`);
  }
  const snapshot = await fs.readJson(snapPath);
  const severity = maxStatus(snapshot.checks);
  const message = buildSnapshotMessage({ ...snapshot, _severity: severity }, type);
  return renderMarkdown(message);
}

async function runPrComment(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();

    let body;
    if (options.body) {
      body = options.body;
    } else if (options.file) {
      body = await fs.readFile(path.resolve(config._projectRoot, options.file), 'utf-8');
    } else {
      const type = options.type === 'audit' ? 'audit' : 'monitor';
      body = await snapshotMarkdown(type, config);
    }

    const result = await postPrComment(body, { pr: options.pr, cwd: config._projectRoot });
    if (jsonMode) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (result.ok) {
      print.success('Posted PR comment.');
    } else {
      print.error(`Could not post PR comment: ${result.error}`);
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    else print.error(`pr comment failed: ${err.message}`);
    process.exitCode = resolveExitCode(err);
  }
}

export function registerPrCommand(program) {
  const pr = program.command('pr').description('Pull-request helpers (post deploy/monitor/audit results as comments)');

  pr
    .command('comment')
    .description('Post a comment to the current PR (snapshot summary, a file, or inline text)')
    .option('--type <type>', 'Render the latest snapshot: audit | monitor', 'monitor')
    .option('--body <text>', 'Post this inline text instead of a snapshot')
    .option('--file <path>', 'Post the contents of this file (relative to project root)')
    .option('--pr <id>', 'Target PR number or URL (defaults to the current branch PR)')
    .option('--json', 'Emit the result as JSON')
    .action((options) => runPrComment(options));

  return pr;
}

export { runPrComment, snapshotMarkdown };
