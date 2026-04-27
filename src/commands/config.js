import fs from 'fs-extra';
import path from 'path';
import { getConfigDir, loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !isNaN(value)) return Number(value);
  return value;
}

function getNestedValue(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj);
}

const VALID_CONFIG_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function setNestedValue(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();

  const target = parts.reduce((o, k) => {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype' || !VALID_CONFIG_KEY.test(k)) {
      throw new Error(`Invalid key segment: ${k}`);
    }
    const child =
      Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'object' && o[k] !== null
        ? o[k]
        : {};
    Object.defineProperty(o, k, { value: child, writable: true, enumerable: true, configurable: true });
    return child;
  }, obj);

  if (last === '__proto__' || last === 'constructor' || last === 'prototype' || !VALID_CONFIG_KEY.test(last)) {
    throw new Error(`Invalid key segment: ${last}`);
  }
  Object.defineProperty(target, last, { value, writable: true, enumerable: true, configurable: true });
}

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
        const coerced = coerceValue(value);
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
