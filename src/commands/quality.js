import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { getPrompt } from '../lib/prompts.js';
import { print, emitJson, emitJsonError } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { scanApexReadiness, shouldFailBuild, API_V67 } from '../lib/api-readiness.js';
import { runTestForHintsCheck } from '../lib/smart-deploy.js';
import { runApexGuruCheck, persistApexGuruSnapshot } from '../lib/apexguru-runner.js';
import {
  buildProjectContext,
  readLatestTestRuns,
  readLatestPreflight,
  buildContextBlock,
  formatTestRunsSection,
  formatPreflightSection,
} from '../lib/ai-context.js';

/**
 * Scan analyzer stdout for the "scan skipped" JSON marker emitted by
 * scripts/quality/code-analyzer.sh when the Salesforce Code Analyzer
 * (sf scanner) is not installed or its run failed. Returns the reason
 * string when found, or null when the output represents a real scan.
 */
export function detectSkippedScan(output) {
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && (parsed.status === 'skipped' || parsed._sfdt_unavailable)) {
        return parsed.reason || parsed._sfdt_unavailable || 'static scan skipped';
      }
    } catch {
      // Not a JSON line — keep scanning.
    }
  }
  return null;
}

const SEVERITY_COLORS = {
  error: chalk.red,
  warn: chalk.yellow,
  info: chalk.gray,
};

const FINDING_HINTS = {
  'security-enforced':
    'WITH SECURITY_ENFORCED does not compile at API v67 — migrate to WITH USER_MODE or Security.stripInaccessible().',
  'missing-sharing':
    "Classes with no sharing keyword default to 'with sharing' at API v67 — declare the intended sharing mode explicitly.",
  'system-mode-dml':
    "'without sharing' classes performing SOQL/DML rely on system mode — review whether user-mode-by-default changes their behaviour.",
};

/**
 * Run the API v67 (Summer '26) readiness scan and print/emit the report.
 * Exit code 1 when blocking errors exist AND the project already targets
 * sourceApiVersion >= 67; otherwise 0 (findings reported as warnings).
 */
/**
 * Run the RunRelevantTests hint check: flag @IsTest classes carrying no
 * @IsTest(testFor=...) annotation. Advisory only — exit code stays 0 (an
 * unhinted test is invisible to relevant-test selection, not a failure).
 */
async function runTestHintsScan(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const check = await runTestForHintsCheck(config._projectRoot, config);
    if (jsonMode) {
      emitJson(check);
      return;
    }
    print.header('RunRelevantTests hint check (@IsTest(testFor=...))');
    if (check.status === 'ok') {
      print.success(check.summary);
    } else {
      print.warning(check.summary);
      for (const f of check.findings) {
        console.log(chalk.yellow(`    ${f.className ?? f.name ?? JSON.stringify(f)}`));
      }
    }
  } catch (err) {
    if (jsonMode) {
      emitJsonError(err);
    } else {
      print.error(`Test-hint check failed: ${err.message}`);
    }
    process.exitCode = resolveExitCode(err);
  }
}

/**
 * Print an ApexGuru check result. The check is ADVISORY: whatever its status
 * (ok / warn / skipped), it never touches process.exitCode — a license/edition
 * gate or missing org must not change what Code Analyzer v5 alone would exit
 * with (gated-org-check policy).
 */
function renderApexGuruResult(check) {
  if (check.status === 'skipped') {
    print.warning(`ApexGuru: SKIPPED — ${check.summary}.`);
    print.warning('No org-side analysis was performed; this is NOT a clean result. ApexGuru is license/edition-gated and must be enabled in the org (advisory — does not affect the quality exit code).');
    return;
  }
  if (check.status === 'ok') {
    print.success(check.summary);
    return;
  }
  // warn — findings or a degraded (enabled-but-incomplete) analysis.
  print.warning(check.summary);
  for (const f of check.findings) {
    const where = `${f.file}${f.line != null ? `:${f.line}` : ''}`;
    console.log(chalk.yellow(`    [${f.type}] ${where}  ${f.description}`));
  }
  for (const d of check.degraded ?? []) {
    console.log(chalk.dim(`    (not analyzed) ${d.file} — ${d.error}`));
  }
}

/**
 * Run the ApexGuru org-side check additively after the Code Analyzer run.
 * Never throws and never sets an exit code — the snapshot write is itself
 * best-effort inside persistApexGuruSnapshot.
 */
async function runApexGuruSection(config, options) {
  try {
    const orgAlias = options.org ?? config.defaultOrg ?? '';
    print.info('Running ApexGuru org-side analysis...');
    const check = await runApexGuruCheck(orgAlias, config);
    renderApexGuruResult(check);
    await persistApexGuruSnapshot(config, check);
    return check;
  } catch (err) {
    // Defensive: even an unexpected bug in the check must not alter the
    // quality exit code.
    print.warning(`ApexGuru check skipped (unexpected failure): ${err.message}`);
    return null;
  }
}

/**
 * `quality --apexguru`: run ONLY the ApexGuru org-side check (like --api67 /
 * --test-hints). Honors --json. Exit code stays 0 for ok/warn/skipped — the
 * check is advisory and never errors by policy.
 */
async function runApexGuruOnly(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const orgAlias = options.org ?? config.defaultOrg ?? '';
    const check = await runApexGuruCheck(orgAlias, config);
    await persistApexGuruSnapshot(config, check);
    if (jsonMode) {
      emitJson(check);
      return;
    }
    print.header('ApexGuru org-side analysis');
    renderApexGuruResult(check);
  } catch (err) {
    // Only infrastructure failures land here (e.g. unreadable .sfdt config) —
    // runApexGuruCheck itself never throws.
    if (jsonMode) {
      emitJsonError(err);
    } else {
      print.error(`ApexGuru check failed: ${err.message}`);
    }
    process.exitCode = resolveExitCode(err);
  }
}

async function runApi67Scan(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const report = await scanApexReadiness(config);
    const failing = shouldFailBuild(report);

    if (jsonMode) {
      emitJson(report);
      if (failing) process.exitCode = 1;
      return;
    }

    print.header(`API v${API_V67} Readiness (Summer '26 user-mode-by-default)`);
    print.info(
      `Project sourceApiVersion: ${report.apiVersion ?? 'unknown'} — scanned Apex classes and triggers.`,
    );
    console.log('');

    if (report.findings.length === 0) {
      print.success(`No API v${API_V67} readiness issues found.`);
    } else {
      const byType = new Map();
      for (const finding of report.findings) {
        if (!byType.has(finding.type)) byType.set(finding.type, []);
        byType.get(finding.type).push(finding);
      }
      for (const [type, findings] of byType) {
        const color = SEVERITY_COLORS[findings[0].severity] ?? chalk.white;
        console.log(color.bold(`  ${type} (${findings[0].severity}) — ${findings.length} finding(s)`));
        if (FINDING_HINTS[type]) console.log(chalk.dim(`    ${FINDING_HINTS[type]}`));
        for (const f of findings) {
          console.log(color(`    ${f.file}:${f.line}  ${f.snippet}`));
        }
        console.log('');
      }
    }

    const { errors, warnings, info } = report.summary;
    console.log(
      chalk.bold(
        `  Summary: ${chalk.red(`${errors} error(s)`)}, ${chalk.yellow(`${warnings} warning(s)`)}, ${chalk.gray(`${info} info`)}`,
      ),
    );

    if (failing) {
      print.error(
        `Blocking findings exist and sourceApiVersion (${report.apiVersion}) is already >= ${API_V67} — failing.`,
      );
      process.exitCode = 1;
    } else if (errors > 0) {
      print.warning(
        `Blocking findings exist but sourceApiVersion (${report.apiVersion ?? 'unknown'}) is below ${API_V67} — fix them before upgrading.`,
      );
    }
  } catch (err) {
    if (jsonMode) {
      emitJsonError(err);
    } else {
      print.error(`API v${API_V67} readiness scan failed: ${err.message}`);
      process.exitCode = resolveExitCode(err);
    }
  }
}

export function registerQualityCommand(program) {
  program
    .command('quality')
    .description('Run code quality analysis and optionally generate an AI fix plan')
    .option('--tests', 'Run test-analyzer only')
    .option('--all', 'Run both code-analyzer and test-analyzer')
    .option('--fix-plan', 'Generate an AI-powered fix plan from quality output')
    .option('--generate-stubs', 'Generate @IsTest stub classes for untested Apex classes')
    .option('--include-fixes', 'Ask Code Analyzer v5 for actionable fixes/suggestions in the scan output (feeds the AI fix plan)')
    .option('--output-file <path>', 'Also write the Code Analyzer v5 results to a file; the format follows the extension (e.g. .sarif for code-scanning upload)')
    .option('--dry-run', 'Preview --generate-stubs output without writing files')
    .option('--agent', 'Non-interactive agent mode (do not block waiting on the AI fix-plan session)')
    .option('--api67', "Run only the API v67 (Summer '26) user-mode readiness scan of local Apex sources")
    .option('--test-hints', "Run only the RunRelevantTests hint check: flag @IsTest classes with no @IsTest(testFor=...) annotation (Spring '26)")
    .option('--apexguru', 'Run only the ApexGuru org-side analysis check (license/edition-gated; degrades to skipped, never an error)')
    .option('--skip-apexguru', 'Skip the additive ApexGuru org-side check during analyzer runs')
    .option('--org <alias>', 'Target org for the ApexGuru check (defaults to defaultOrg from .sfdt/config.json)')
    .option('--json', 'Emit structured JSON to stdout (only honoured with --api67 / --test-hints / --apexguru)')
    .action(async (options) => {
      if (options.api67) {
        await runApi67Scan(options);
        return;
      }
      if (options.testHints) {
        await runTestHintsScan(options);
        return;
      }
      if (options.apexguru) {
        await runApexGuruOnly(options);
        return;
      }
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        print.header('Quality Analysis');

        let qualityOutput = '';

        // --include-fixes/--output-file only affect the Code Analyzer run
        // (test-analyzer ignores them); the shell script reads the SFDT_ vars.
        const analyzerEnv = {
          ...(options.includeFixes ? { SFDT_ANALYZER_INCLUDE_FIXES: 'true' } : {}),
          ...(options.outputFile ? { SFDT_ANALYZER_OUTPUT_FILE: options.outputFile } : {}),
        };

        const runAnalyzer = async (scriptPath, label, extraEnv = {}) => {
          print.info(`Running ${label}...`);
          try {
            const result = await runScript(scriptPath, config, {
              cwd: projectRoot,
              interactive: false,
              env: extraEnv,
            });
            const output = result.stdout || '';
            qualityOutput += `\n--- ${label} ---\n${output}\n`;
            const skippedReason = detectSkippedScan(output);
            if (skippedReason) {
              print.warning(`${label}: static violation scan was SKIPPED — ${skippedReason}.`);
              print.warning('No scan was performed; this is NOT a clean result. Code Analyzer auto-installs with a modern sf CLI, or run: sf plugins install code-analyzer');
              print.success(`${label} completed (scan skipped).`);
            } else {
              print.success(`${label} completed.`);
            }
            return output;
          } catch (err) {
            const output = err.stdout || err.message;
            qualityOutput += `\n--- ${label} ---\n${output}\n`;
            const skippedReason = detectSkippedScan(output);
            if (skippedReason) {
              print.warning(`${label}: static violation scan was SKIPPED — ${skippedReason}. Code Analyzer auto-installs with a modern sf CLI, or run: sf plugins install code-analyzer`);
            }
            print.warning(`${label} found issues: ${err.message}`);
            return output;
          }
        };

        if (options.tests) {
          await runAnalyzer('quality/test-analyzer.sh', 'Test Analyzer');
        } else if (options.all) {
          await runAnalyzer('quality/code-analyzer.sh', 'Code Analyzer', analyzerEnv);
          await runAnalyzer('quality/test-analyzer.sh', 'Test Analyzer');
        } else {
          await runAnalyzer('quality/code-analyzer.sh', 'Code Analyzer', analyzerEnv);
        }

        // Additive ApexGuru org-side pass alongside Code Analyzer v5 (not in
        // the --tests-only path). Advisory: a skipped/unavailable/finding-laden
        // ApexGuru never changes the exit code the analyzers produced.
        if (!options.tests && !options.skipApexguru) {
          const apexGuru = await runApexGuruSection(config, options);
          if (apexGuru) {
            qualityOutput += `\n--- ApexGuru ---\n${JSON.stringify(apexGuru, null, 2)}\n`;
          }
        }

        // AI fix plan
        if (options.fixPlan) {
          const aiEnabled = config.features?.ai;
          if (aiEnabled && (await isAiAvailable(config))) {
            print.info('Generating AI fix plan...');

            const [projectCtx, testRuns, preflight] = await Promise.all([
              buildProjectContext(config),
              readLatestTestRuns(config, 5),
              readLatestPreflight(config),
            ]);

            const contextBlock = buildContextBlock([
              projectCtx,
              formatTestRunsSection(testRuns),
              formatPreflightSection(preflight),
            ]);

            const fixPlanPrompt = await getPrompt('quality-fix-plan', config._configDir);
            const prompt = [
              ...(contextBlock ? [contextBlock, ''] : []),
              fixPlanPrompt,
              '',
              '--- Quality Report ---',
              qualityOutput,
            ].join('\n');

            await runAiPrompt(prompt, {
              config,
              allowedTools: ['Read', 'Grep'],
              cwd: projectRoot,
              aiEnabled: true,
              interactive: !options.agent,
            });
          } else {
            print.warning('AI features are not available. Skipping fix plan generation.');
          }
        }
        if (options.generateStubs) {
          print.info('Generating test stubs...');
          const stubEnv = options.dryRun ? { SFDT_DRY_RUN: 'true' } : {};
          try {
            await runScript('quality/generate-test-stubs.sh', config, {
              cwd: projectRoot,
              env: stubEnv,
              interactive: false,
            });
            print.success('Stub generation complete.');
          } catch (err) {
            print.warning(`Stub generation encountered issues: ${err.message}`);
          }
        }
      } catch (err) {
        print.error(`Quality analysis failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
