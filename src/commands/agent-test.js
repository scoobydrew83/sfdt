import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { postPrComment } from '../lib/github-pr.js';
import { dispatch, notificationsConfigured } from '../lib/notifier.js';
import { buildAgentTestArgs, parseThreshold, parseAgentTestResult, computePassRate } from '../lib/agent-test.js';
import { recordRun } from '../lib/run-history.js';
import path from 'path';

/**
 * `sfdt agent-test` — run an Agentforce agent test (`sf agent test run`) as a
 * CI gate. Pass/fail is taken from the CLI's exit code (the reliable signal,
 * same convention as `sf apex run test`); optionally dispatches a notification
 * and decorates the current PR with the outcome.
 */
export function registerAgentTestCommand(program) {
  program
    .command('agent-test')
    .description('Run an Agentforce agent test as a CI gate (via `sf agent test run`), with pass/fail exit code, optional notification, and PR decoration')
    .requiredOption('--spec <apiName>', 'Agent test API name (AiEvaluationDefinition) to run')
    .option('--org <alias>', 'Target org (default: config.defaultOrg)')
    .option('--wait <minutes>', 'Wait timeout in minutes (default: 30)')
    .option('--threshold <percent>', 'Pass if the aggregate pass rate is >= this percent (0-100), rather than requiring every test to pass')
    .option('--notify', 'Dispatch an agent-test-success/failure notification via configured channels')
    .option('--pr-comment', 'Post the pass/fail result to the current PR (via gh)')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const org = options.org || config.defaultOrg;
        const args = buildAgentTestArgs(options, org); // throws on missing spec/org
        const threshold = parseThreshold(options.threshold); // throws on garbage

        print.header(`Agentforce agent test "${options.spec}" → ${org}`);
        print.info(`Running: sf ${args.join(' ')}`);

        let passed = false;
        let output = '';
        let stdout = '';
        let runError = null;
        try {
          const res = await execa('sf', args, { all: true });
          output = res.all || '';
          stdout = res.stdout || '';
          passed = true;
        } catch (err) {
          // A failing eval still exits non-zero but emits its JSON on stdout —
          // with --threshold we grade from that, not the exit code.
          output = err.all || err.stderr || err.stdout || err.message || '';
          stdout = err.stdout || '';
          runError = err;
        }
        if (output) console.log(output);

        let passRate = null;
        if (threshold != null) {
          // Threshold gate: grade on the aggregate pass rate, overriding the
          // exit-code result (which fails if *any* single test fails).
          const rate = computePassRate(parseAgentTestResult(stdout));
          if (!rate) {
            print.error('Cannot apply --threshold: no parseable test results in the run output.');
            process.exitCode = runError ? resolveExitCode(runError) : 1;
            passed = false;
          } else {
            passRate = rate;
            passed = rate.rate >= threshold;
            const pct = rate.rate.toFixed(1);
            print[passed ? 'success' : 'error'](
              `Pass rate ${pct}% (${rate.passed}/${rate.total}) ${passed ? '>=' : '<'} threshold ${threshold}%.`,
            );
            if (!passed) process.exitCode = runError ? resolveExitCode(runError) : 1;
          }
        } else if (passed) {
          print.success('Agent tests passed.');
        } else {
          print.error('Agent tests failed.');
          process.exitCode = resolveExitCode(runError);
        }

        // Index the run in history (best-effort).
        await recordRun(config.logDir ?? path.join(projectRoot, 'logs'), {
          type: 'agent-test',
          org,
          exitCode: passed ? 0 : (process.exitCode ?? 1),
          status: passed ? 'pass' : 'fail',
          summary: passRate
            ? { spec: options.spec, passed, rate: Number(passRate.rate.toFixed(1)), total: passRate.total, passedCount: passRate.passed }
            : { spec: options.spec, passed },
        });

        const event = passed ? 'agent-test-success' : 'agent-test-failure';

        // Optional notification.
        if (options.notify) {
          if (notificationsConfigured(config)) {
            const ctx = {
              org,
              projectName: config.projectName,
              message: `Agent test "${options.spec}" ${passed ? 'passed' : 'failed'}.`,
            };
            const results = await dispatch(event, ctx, config);
            const sent = results.filter((r) => r.ok).map((r) => r.channel);
            if (sent.length) print.info(`Notified: ${sent.join(', ')}`);
            else if (results.length === 0) print.info(`--notify: no channel subscribed to "${event}".`);
          } else {
            print.info('--notify: no notification channels configured.');
          }
        }

        // Optional PR decoration.
        if (options.prComment) {
          const body = [
            `### SFDT Agentforce Test — ${passed ? '✅ passed' : '❌ failed'}`,
            '',
            `- **Agent test:** \`${options.spec}\``,
            `- **Org:** ${org}`,
          ].join('\n');
          const res = await postPrComment(body, { cwd: projectRoot });
          if (res.ok) print.info('Posted agent-test result to PR.');
          else print.warning(`Could not post PR comment: ${res.error}`);
        }
      } catch (err) {
        print.error(`Agent test command failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
