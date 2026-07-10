import { execa } from 'execa';
import { isToolAvailable } from './tool-check.js';

const NODE_FLOOR = [22, 15, 0]; // package.json engines: >=22.15.0

function coreResult(name, status, detail) {
  return { name, status, detail };
}

function satisfiesFloor(versionString, floor) {
  const parts = String(versionString).replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < floor.length; i++) {
    const got = parts[i] ?? 0;
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

export async function checkNode() {
  const current = process.versions.node;
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
