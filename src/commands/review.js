import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, aiUnavailableMessage, runAiPrompt } from '../lib/ai.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

const REVIEW_PROMPT = `You are a senior Salesforce developer reviewing a code diff. Analyze the following changes and report issues in these categories:

## Governor Limits & Performance
- SOQL or DML inside loops
- Unbulkified operations (not handling 200+ records)
- Missing LIMIT clauses on SOQL queries
- Inefficient collection usage

## Security
- Missing CRUD/FLS checks (Security.stripInaccessible or WITH SECURITY_ENFORCED)
- SOQL injection risks (string concatenation in queries instead of bind variables)
- Sensitive data exposure in debug logs

## Null Safety & Error Handling
- Missing null checks before property access
- Unhandled exceptions in AuraEnabled methods
- Missing try/catch around DML operations

## Test Coverage
- Changed Apex classes that lack corresponding test class changes
- Missing assertions in test methods
- Missing bulk test scenarios (200+ records)

## LWC Best Practices
- Wire vs imperative Apex usage (prefer wire for cacheable reads)
- Missing error handling in imperative calls
- Inline boolean expressions in HTML templates (should use getters)
- Missing disconnectedCallback cleanup

Provide specific line references from the diff. Rate each finding as CRITICAL, HIGH, MEDIUM, or LOW.
Use the allowed tools to explore the full source files for additional context when needed.

--- DIFF ---
`;

export function registerReviewCommand(program) {
  program
    .command('review')
    .description('AI-powered Salesforce code review of current branch changes')
    .option('--base <branch>', 'Base branch to diff against', 'main')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const aiEnabled = config.features?.ai;

        if (!aiEnabled) {
          print.error(
            'AI features are disabled. Enable them in .sfdt/config.json (features.ai: true).',
          );
          process.exitCode = 1;
          return;
        }

        if (!(await isAiAvailable(config))) {
          print.error(aiUnavailableMessage(config));
          process.exitCode = 1;
          return;
        }

        print.header(`Code Review (vs ${options.base})`);

        // Get the diff
        const diffResult = await execa('git', ['diff', `${options.base}...HEAD`], {
          cwd: projectRoot,
          reject: false,
        });

        const diff = diffResult.stdout || '';

        if (!diff.trim()) {
          print.warning(`No changes found between ${options.base} and HEAD.`);
          print.info('Make sure you have commits on your branch that differ from the base.');
          return;
        }

        print.info(`Reviewing ${diff.split('\n').length} lines of diff...`);

        const prompt = REVIEW_PROMPT + diff;

        await runAiPrompt(prompt, {
          config,
          allowedTools: ['Read', 'Grep'],
          cwd: projectRoot,
          aiEnabled: true,
          interactive: true,
        });
      } catch (err) {
        print.error(`Review failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
