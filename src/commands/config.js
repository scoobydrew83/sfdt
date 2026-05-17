import fs from 'fs-extra';
import path from 'path';
import { getConfigDir, loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { setNestedValue, getNestedValue, coerceConfigValue } from '../lib/config-utils.js';

export function registerConfigCommand(program) {
  const configCmd = program
    .command('config')
    .description('Read and write .sfdt config values');

  configCmd
    .command('set <key> <value>')
    .description('Set a config value using dot notation (e.g. deployment.coverageThreshold)')
    .action(async (key, value) => {
      try {
        const configDir = getConfigDir();
        const configPath = path.join(configDir, 'config.json');
        const obj = await fs.readJson(configPath);
        const coerced = coerceConfigValue(value);
        setNestedValue(obj, key, coerced);
        await fs.writeJson(configPath, obj, { spaces: 2 });
        print.success(`Set ${key} = ${coerced}`);
      } catch (err) {
        print.error(`config set failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });

  configCmd
    .command('get <key>')
    .description('Print a config value using dot notation (e.g. defaultOrg)')
    .action(async (key) => {
      try {
        const config = await loadConfig();
        const value = getNestedValue(config, key);
        if (value === undefined) {
          print.error(`Key not found: ${key}`);
          process.exitCode = 1;
          return;
        }
        console.log(value);
      } catch (err) {
        print.error(`config get failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
