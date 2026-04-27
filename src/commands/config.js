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

const VALID_KEY_SEGMENT = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const DENIED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateKeySegment(part) {
  if (!VALID_KEY_SEGMENT.test(part) || DENIED_KEYS.has(part)) {
    throw new Error(`Invalid key segment: ${part}`);
  }
}

function setNestedValue(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  for (const part of [...parts, last]) validateKeySegment(part);
  const target = parts.reduce((o, k) => {
    if (!Object.prototype.hasOwnProperty.call(o, k) || typeof o[k] !== 'object') o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
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
