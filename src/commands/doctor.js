// `sfdt doctor` — diagnose the local sfdt installation.
//
// Initial scope: --extension. Runs every check needed to answer "why isn't
// the Chrome extension talking to my sfdt?" so users don't have to walk
// through three pages of docs to triage:
//
//   1. sfdt ui reachable on the configured localhost port (GET /api/bridge/ping)
//   2. Native host installed for at least one browser (fallback transport)
//   3. .sfdt/feature-flags.json well-formed if present (no JSON errors)
//   4. .sfdt/telemetry-snapshot.json present (operator visibility)
//
// All checks are read-only. Returns an exit code of 1 if any FAIL-severity
// check fails — WARN-severity checks (snapshot absent, no native host) leave
// exit code 0 so this can run unattended in CI without false-positiving.

import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { nativeHostStatus } from '../../host/installers/install-host.js';
import { getConfigDir } from '../lib/config.js';
import { resolveExitCode } from '../lib/exit-codes.js';

const DEFAULT_PORT = 7654;

function symbol(status) {
  if (status === 'pass') return chalk.green('✓');
  if (status === 'warn') return chalk.yellow('•');
  return chalk.red('✗');
}

async function checkBridgePing(port, fetchImpl) {
  const url = `http://127.0.0.1:${port}/api/bridge/ping`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    let res;
    try {
      res = await fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      return {
        name: 'sfdt ui bridge',
        status: 'fail',
        detail: `GET ${url} returned HTTP ${res.status}`,
      };
    }
    const body = await res.json().catch(() => null);
    const data = body?.data ?? {};
    return {
      name: 'sfdt ui bridge',
      status: 'pass',
      detail: `OK on port ${port} — sfdt v${data.serverVersion ?? '?'}, protocol ${data.protocolVersion ?? '<missing>'}`,
      data,
    };
  } catch (err) {
    return {
      name: 'sfdt ui bridge',
      status: 'fail',
      detail: `Could not reach ${url}: ${err.message ?? err}. Run \`sfdt ui\` from your project root.`,
    };
  }
}

async function checkNativeHost() {
  try {
    const status = await nativeHostStatus();
    const installed = status.browsers.filter((b) => b.installed);
    if (installed.length === 0) {
      return {
        name: 'native messaging host',
        status: 'warn',
        detail: `Not installed on any browser (${status.platform}). Run \`sfdt extension install-host --extension-id <id>\` to enable the fallback transport.`,
      };
    }
    return {
      name: 'native messaging host',
      status: 'pass',
      detail: `Installed for: ${installed.map((b) => b.browser).join(', ')}`,
    };
  } catch (err) {
    return {
      name: 'native messaging host',
      status: 'warn',
      detail: `Could not query: ${err.message}`,
    };
  }
}

async function checkFeatureFlags() {
  const file = path.join(getConfigDir(), 'feature-flags.json');
  if (!(await fs.pathExists(file))) {
    return {
      name: 'feature-flags.json',
      status: 'pass',
      detail: `Not present (default — all features enabled). Path: ${file}`,
    };
  }
  try {
    const flags = await fs.readJson(file);
    if (!flags || typeof flags !== 'object' || !Array.isArray(flags.disabled)) {
      return {
        name: 'feature-flags.json',
        status: 'fail',
        detail: `${file} is missing the "disabled" array. Expected shape: { "disabled": ["feature-id", ...] }`,
      };
    }
    return {
      name: 'feature-flags.json',
      status: 'pass',
      detail:
        flags.disabled.length === 0
          ? 'Present, no features disabled.'
          : `Present, disabling: ${flags.disabled.join(', ')}`,
    };
  } catch (err) {
    return {
      name: 'feature-flags.json',
      status: 'fail',
      detail: `${file} is unreadable / malformed: ${err.message}`,
    };
  }
}

async function checkTelemetrySnapshot() {
  const file = path.join(getConfigDir(), 'telemetry-snapshot.json');
  if (!(await fs.pathExists(file))) {
    return {
      name: 'telemetry-snapshot.json',
      status: 'warn',
      detail: `Not present. Open the extension options page with Telemetry enabled to populate it, then run \`sfdt extension stats\`.`,
    };
  }
  try {
    const snap = await fs.readJson(file);
    const featureCount = Object.keys(snap.counters ?? {}).length;
    return {
      name: 'telemetry-snapshot.json',
      status: 'pass',
      detail: `Present for ${snap.monthKey ?? '?'} (${featureCount} feature${featureCount === 1 ? '' : 's'}, written ${snap.writtenAt ?? '?'})`,
    };
  } catch (err) {
    return {
      name: 'telemetry-snapshot.json',
      status: 'fail',
      detail: `${file} is unreadable: ${err.message}`,
    };
  }
}

export async function runExtensionDoctor({ port = DEFAULT_PORT, fetchImpl = globalThis.fetch } = {}) {
  const results = await Promise.all([
    checkBridgePing(port, fetchImpl),
    checkNativeHost(),
    checkFeatureFlags(),
    checkTelemetrySnapshot(),
  ]);
  const failed = results.some((r) => r.status === 'fail');
  return { results, ok: !failed };
}

export function registerDoctorCommand(program) {
  program
    .command('doctor')
    .description('Diagnose the local sfdt install (use --extension to check the extension bridge stack)')
    .option('--extension', 'Run extension-stack checks (bridge ping, native host, feature flags, telemetry)')
    .option('--port <port>', `Localhost port the bridge listens on (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      try {
        if (!options.extension) {
          // For now `sfdt doctor` defaults to --extension. Reserved for future
          // top-level checks (config validity, sf CLI version, git status).
          console.log(chalk.dim('No diagnostic group selected; defaulting to --extension.'));
        }
        const port = Math.max(1, Number(options.port) || DEFAULT_PORT);
        const { results, ok } = await runExtensionDoctor({ port });
        if (options.json) {
          process.stdout.write(JSON.stringify({ ok, results }, null, 2) + '\n');
          if (!ok) process.exitCode = 1;
          return;
        }
        console.log(chalk.bold('\nExtension stack diagnostic\n'));
        for (const r of results) {
          console.log(`  ${symbol(r.status)} ${chalk.bold(r.name)}`);
          console.log(`    ${chalk.dim(r.detail)}`);
        }
        console.log('');
        if (!ok) {
          console.log(chalk.red('Some checks failed — fix the items marked ✗ before continuing.\n'));
          process.exitCode = 1;
        }
      } catch (err) {
        if (options.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          console.error(chalk.red(`doctor failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });
}
