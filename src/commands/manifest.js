import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import {
  parseDiffToMetadata,
  renderPackageXml,
  countMembers,
} from '../lib/metadata-mapper.js';

const AI_DEPENDENCY_PROMPT = `You are a Salesforce release engineer reviewing a draft deployment manifest generated from a git diff. Your job is to flag likely missing dependencies that will cause deployment failures, without hallucinating.

Rules:
- Only suggest metadata that is COMMONLY required alongside what was changed (e.g., a new CustomField usually needs the enclosing CustomObject file, a new ApexClass referenced in a Flow needs the Flow, a new field on a PermissionSet needs the PermissionSet entry).
- Be conservative — do NOT suggest broad sweeps ("all profiles", "all layouts").
- Group output under headings: MISSING (must add), RISKY (verify before deploy), OK.
- Use the filesystem tools to inspect the actual metadata files before recommending.
- End with a one-line VERDICT: "Manifest looks complete" or "Manifest is missing N dependencies".

--- DRAFT MANIFEST ---
`;

export function registerManifestCommand(program) {
  program
    .command('manifest')
    .description('Smart package.xml generator from git diffs (with optional AI dependency cleanup)')
    .option('--base <ref>', 'Base git ref to diff from', 'main')
    .option('--head <ref>', 'Head git ref to diff to', 'HEAD')
    .option('--output <path>', 'Output path for package.xml (defaults to <manifestDir>/preview-package.xml)')
    .option('--destructive <path>', 'Write destructive changes to this path (otherwise skipped)')
    .option('--ai-cleanup', 'Run AI dependency analysis on the generated manifest')
    .option('--no-ai-cleanup', 'Skip AI dependency analysis even when AI is enabled')
    .option('--print', 'Print the generated package.xml to stdout instead of writing a file')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const sourcePath = config.defaultSourcePath || 'force-app/main/default';
        const apiVersion = config.sourceApiVersion || '63.0';
        const manifestDir = config.manifestDir || 'manifest/release';

        print.header(`Smart Manifest (${options.base}...${options.head})`);

        // Resolve base ref — if it's a branch name that's not reachable, fall back to merge-base
        const baseRef = await resolveBaseRef(options.base, options.head, projectRoot);
        if (baseRef !== options.base) {
          print.info(`Using merge-base ${baseRef.slice(0, 7)} as diff base`);
        }

        const diffResult = await execa(
          'git',
          ['diff', '--name-status', `${baseRef}`, options.head, '--', `${sourcePath.split('/')[0]}/`],
          { cwd: projectRoot, reject: false },
        );

        if (diffResult.exitCode !== 0) {
          print.error(`git diff failed: ${diffResult.stderr || 'unknown error'}`);
          process.exitCode = 1;
          return;
        }

        const { additive, destructive, unknown } = parseDiffToMetadata(diffResult.stdout, {
          sourcePath,
        });

        const addCount = countMembers(additive);
        const delCount = countMembers(destructive);

        if (addCount === 0 && delCount === 0) {
          print.warning('No metadata changes detected between refs.');
          return;
        }

        print.info(`Detected ${addCount} additive, ${delCount} destructive components.`);
        if (unknown.length > 0) {
          print.warning(
            `${unknown.length} file(s) could not be mapped to a metadata type (skipped):`,
          );
          for (const f of unknown.slice(0, 10)) {
            print.step(`  - ${f}`);
          }
          if (unknown.length > 10) {
            print.step(`  ... and ${unknown.length - 10} more`);
          }
        }

        const packageXml = renderPackageXml(additive, apiVersion);

        if (options.print) {
          console.log(packageXml);
        } else {
          const outputPath =
            options.output || path.join(projectRoot, manifestDir, 'preview-package.xml');
          const absolute = path.isAbsolute(outputPath)
            ? outputPath
            : path.join(projectRoot, outputPath);
          await fs.ensureDir(path.dirname(absolute));
          await fs.writeFile(absolute, packageXml);
          print.success(`Wrote package.xml → ${path.relative(projectRoot, absolute)}`);
        }

        if (delCount > 0 && options.destructive) {
          const destructiveXml = renderPackageXml(destructive, apiVersion);
          const destPath = path.isAbsolute(options.destructive)
            ? options.destructive
            : path.join(projectRoot, options.destructive);
          await fs.ensureDir(path.dirname(destPath));
          await fs.writeFile(destPath, destructiveXml);
          print.success(
            `Wrote destructiveChanges.xml → ${path.relative(projectRoot, destPath)}`,
          );
        } else if (delCount > 0) {
          print.warning(
            `${delCount} destructive components detected — rerun with --destructive <path> to emit destructiveChanges.xml`,
          );
        }

        // AI dependency cleanup
        const aiEnabled = config.features?.ai;
        const shouldRunAi = options.aiCleanup ?? aiEnabled;

        if (shouldRunAi && aiEnabled && (await isAiAvailable(config))) {
          print.header('AI Dependency Cleanup');
          print.info('Asking AI to check for missing dependencies...');

          await runAiPrompt(AI_DEPENDENCY_PROMPT + packageXml, {
            config,
            allowedTools: ['Read', 'Grep', 'Glob'],
            cwd: projectRoot,
            aiEnabled: true,
            interactive: true,
          });
        } else if (shouldRunAi && !aiEnabled) {
          print.info('AI features are disabled (features.ai=false) — skipping dependency cleanup.');
        } else if (shouldRunAi) {
          print.info('AI provider not available — skipping dependency cleanup.');
        }
      } catch (err) {
        print.error(`Manifest generation failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}

/**
 * Try to resolve a base ref. If the user passed a branch name and we're on
 * a feature branch, fall back to the merge-base to avoid pulling in changes
 * that are already on main.
 */
async function resolveBaseRef(base, head, cwd) {
  // If the caller passed a specific commit SHA we trust it as-is.
  if (/^[0-9a-f]{7,40}$/i.test(base)) return base;

  const mergeBase = await execa('git', ['merge-base', base, head], { cwd, reject: false });
  if (mergeBase.exitCode === 0 && mergeBase.stdout.trim()) {
    return mergeBase.stdout.trim();
  }
  return base;
}
