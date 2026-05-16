import { runAiPrompt, isAiAvailable, aiUnavailableMessage } from '../lib/ai.js';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
export function registerAiCommand(program) {
  const ai = program.command('ai').description('AI utilities');
  ai.command('prompt <text>')
    .description('Run a prompt through the configured AI provider and print the result')
    .action(async (text) => {
      let config;
      try {
        config = await loadConfig();
      } catch {
        config = {};
      }
      if (!(await isAiAvailable(config))) {
        print.error(aiUnavailableMessage(config));
        process.exitCode = 1;
        return;
      }
      const result = await runAiPrompt(text, { config, aiEnabled: true, interactive: true });
      if (!result || result.exitCode !== 0) process.exitCode = 1;
    });
}
