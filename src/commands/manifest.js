import fs from 'fs-extra';
import path from 'path';
import { loadConfig } from '../lib/config.js';
import { isSafeGitRef, resolveBaseRef, diffNameStatus } from '../lib/git-utils.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { getPrompt } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { safeResolvePath } from '../lib/project-detect.js';
import {
  parseDiffToMetadata,
  renderPackageXml,
  countMembers,
} from '../lib/metadata-mapper.js';


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
    .option('--package <name|all>', 'Package directory to diff: a short name matching packageDirectories or "all"', 'all')
    .option('--name <label>', 'Release label for output filename (semver, free-form, or "today")')
    .option('--version <label>', 'Alias for --name (backward compat)')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const sourcePath = config.defaultSourcePath || 'force-app/main/default';
        const apiVersion = config.sourceApiVersion || '63.0';
        const manifestDir = config.manifestDir || 'manifest/release';

        if (!isSafeGitRef(options.base) || !isSafeGitRef(options.head)) {
          print.error('Invalid git ref — refs must not start with "-" or contain shell metacharacters');
          process.exitCode = 1;
          return;
        }

        // Resolve release name
        let releaseName = options.name || options.version || null;
        if (releaseName === 'today') {
          releaseName = new Date().toISOString().slice(0, 10);
        }
        // Must start alphanumeric so labels like "..." or "-x" can't produce
        // confusing or path-traversing filenames (matches the GUI validation).
        if (releaseName && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(releaseName)) {
          print.error('--name must start with an alphanumeric character and contain only alphanumerics, dots, underscores, or hyphens');
          process.exitCode = 1;
          return;
        }

        // Resolve package target and git diff paths
        const pkgTarget = options.package || 'all';
        const packages = config.packageDirectories || [];

        let diffPaths; // array of path prefixes for git diff
        let diffSourcePath = sourcePath; // used for parseDiffToMetadata filtering
        if (pkgTarget !== 'all') {
          if (packages.length === 0) {
            print.error(`--package requires packageDirectories to be configured in .sfdt/config.json`);
            process.exitCode = 1;
            return;
          }
          const matched = packages.find((p) => p.name === pkgTarget);
          if (!matched) {
            print.error(`Unknown package "${pkgTarget}". Available: ${packages.map((p) => p.name).join(', ')}`);
            process.exitCode = 1;
            return;
          }
          diffPaths = [matched.path + '/'];
          diffSourcePath = matched.path;
        } else {
          // all packages — use top-level roots (deduplicated)
          diffPaths = packages.length > 0
            ? [...new Set(packages.map((p) => p.path.split('/')[0] + '/'))]
            : [sourcePath.split('/')[0] + '/'];
        }

        print.header(`Smart Manifest (${options.base}...${options.head})${pkgTarget !== 'all' ? ` [${pkgTarget}]` : ''}`);

        // Resolve base ref — if it's a branch name that's not reachable, fall back to merge-base
        const baseRef = await resolveBaseRef(options.base, options.head, projectRoot);
        if (baseRef !== options.base) {
          print.info(`Using merge-base ${baseRef.slice(0, 7)} as diff base`);
        }

        const diffResult = await diffNameStatus(baseRef, options.head, diffPaths, projectRoot);

        if (diffResult.exitCode !== 0) {
          print.error(`git diff failed: ${diffResult.stderr || 'unknown error'}`);
          process.exitCode = 1;
          return;
        }

        const { additive, destructive, unknown } = parseDiffToMetadata(diffResult.stdout, {
          sourcePath: diffSourcePath,
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
          // Compute output path
          let outputPath;
          if (options.output) {
            outputPath = safeResolvePath(projectRoot, options.output);
          } else if (releaseName) {
            const layout = config.manifestLayout || 'flat';
            let fileName;
            if (pkgTarget !== 'all') {
              fileName = `rl-${releaseName}-${pkgTarget}-package.xml`;
            } else {
              fileName = `rl-${releaseName}-package.xml`;
            }
            const subdir = layout === 'subpath' ? pkgTarget : '';
            outputPath = path.join(projectRoot, manifestDir, subdir, fileName);
          } else {
            outputPath = path.join(projectRoot, manifestDir, 'preview-package.xml');
          }
          await fs.ensureDir(path.dirname(outputPath));
          await fs.writeFile(outputPath, packageXml);
          print.success(`Wrote package.xml → ${path.relative(projectRoot, outputPath)}`);
        }

        if (delCount > 0 && options.destructive) {
          const destructiveXml = renderPackageXml(destructive, apiVersion);
          const destPath = safeResolvePath(projectRoot, options.destructive);
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

          const manifestPrompt = await getPrompt('manifest-dependency', config._configDir);
          await runAiPrompt(manifestPrompt + packageXml, {
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
