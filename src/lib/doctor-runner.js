import path from 'path';
import { execa } from 'execa';
import fs from 'fs-extra';
import { isToolAvailable } from './tool-check.js';
import { getConfigDir, validateConfig, loadConfig } from './config.js';
import { isAiAvailable, aiUnavailableMessage } from './ai.js';
import { checkOrgInfo } from './monitor-runner.js';
import { maxStatus } from './check-status.js';

const NODE_FLOOR = [22, 15, 0]; // package.json engines: >=22.15.0

function coreResult(name, status, detail) {
  return { name, status, detail };
}

function satisfiesFloor(versionString, floor) {
  const parts = String(versionString).replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < floor.length; i++) {
    // A missing or unparseable segment counts as 0 (conservatively "below") so a
    // malformed version like "22.x.0" can never silently fall through as satisfied.
    const got = Number.isInteger(parts[i]) ? parts[i] : 0;
    if (got > floor[i]) return true;
    if (got < floor[i]) return false;
  }
  return true;
}

export async function checkSf() {
  const { available, version } = await isToolAvailable('sf');
  if (!available) {
    return coreResult('sf CLI', 'fail', 'Salesforce CLI (`sf`) not found on PATH — install it: https://developer.salesforce.com/tools/salesforcecli');
  }
  if (!version) {
    return coreResult('sf CLI', 'warn', 'Present, but `sf --version` output was unparseable — the binary on PATH may be broken.');
  }
  return coreResult('sf CLI', 'ok', `Present — ${version}`);
}

export async function checkNode(nodeVersion = process.versions.node) {
  const current = nodeVersion;
  if (satisfiesFloor(current, NODE_FLOOR)) {
    return coreResult('node', 'ok', `v${current} (satisfies >=${NODE_FLOOR.join('.')})`);
  }
  return coreResult('node', 'warn', `v${current} is below the supported floor >=${NODE_FLOOR.join('.')} — upgrade Node.`);
}

export async function checkGit() {
  const { available, version } = await isToolAvailable('git');
  if (!available) {
    return coreResult('git', 'fail', 'git not found on PATH — install git.');
  }
  const { exitCode } = await execa('git', ['rev-parse', '--is-inside-work-tree'], { reject: false });
  if (exitCode === 0) {
    return coreResult('git', 'ok', `Present (${version}) and inside a work tree.`);
  }
  return coreResult('git', 'warn', `Present (${version}) but the current directory is not a git repository.`);
}

export async function checkConfig(config, loadError) {
  let configDir;
  try {
    configDir = getConfigDir();
  } catch {
    return coreResult('config', 'warn', 'No .sfdt/ project found here — run `sfdt init` in your project root.');
  }
  const configPath = path.join(configDir, 'config.json'); // CONFIG_FILES.config in config.js
  if (!(await fs.pathExists(configPath))) {
    return coreResult('config', 'warn', `Not initialized (${configPath} absent) — run \`sfdt init\`.`);
  }
  if (loadError) {
    return coreResult('config', 'fail', `${configPath} present but failed to load: ${loadError.message}`);
  }
  try {
    validateConfig(config);
  } catch (err) {
    return coreResult('config', 'fail', `${configPath} is invalid: ${err.message}`);
  }
  return coreResult('config', 'ok', `Valid (${configPath}).`);
}

export async function checkAi(config) {
  if (!config) {
    return coreResult('AI provider', 'warn', 'Skipped — config could not be loaded.');
  }
  if (!config.features?.ai) {
    return coreResult('AI provider', 'warn', 'AI features are disabled (features.ai = false).');
  }
  if (await isAiAvailable(config)) {
    return coreResult('AI provider', 'ok', 'Configured provider is available.');
  }
  return coreResult('AI provider', 'warn', aiUnavailableMessage(config));
}

export async function checkOrg(orgAlias, timeoutMs = 5000) {
  if (!orgAlias) {
    return coreResult('org', 'warn', 'No default org configured — set config.defaultOrg or pass --org <alias> to check connectivity.');
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  let info;
  try {
    info = await Promise.race([checkOrgInfo(orgAlias, { timeoutMs }), timeout]);
  } catch (err) {
    return coreResult('org', 'warn', `Could not reach org "${orgAlias}": ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (info?.__timedOut) {
    return coreResult('org', 'warn', `Org "${orgAlias}" check timed out after ${timeoutMs}ms.`);
  }
  if (info?.status === 'ok') {
    return coreResult('org', 'ok', `Reachable — ${info.summary}`);
  }
  // Any non-ok (warn/error/fail) is reported as warn: this check never fails the run.
  return coreResult('org', 'warn', `Org "${orgAlias}": ${info?.summary ?? 'not reachable'}`);
}

export async function runCoreDoctor({ org, timeoutMs = 5000 } = {}) {
  let config = null;
  let loadError = null;
  try {
    config = await loadConfig();
  } catch (err) {
    loadError = err;
  }
  const orgAlias = org ?? config?.defaultOrg;
  const results = await Promise.all([
    checkSf(),
    checkNode(),
    checkGit(),
    checkConfig(config, loadError),
    checkAi(config),
    checkOrg(orgAlias, timeoutMs),
  ]);
  const ok = maxStatus(results) !== 'fail';
  return { results, ok };
}
