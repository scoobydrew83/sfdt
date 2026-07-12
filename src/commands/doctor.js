// `sfdt doctor` — diagnose the local sfdt installation.
//
// Two diagnostic groups, both run by default (`--core` / `--extension` narrow
// to one). `--extension` answers "why isn't the Chrome extension talking to
// my sfdt?" so users don't have to walk through three pages of docs to triage:
//
//   1. sfdt ui reachable on the configured localhost port (GET /api/bridge/ping)
//   2. Native host installed for at least one browser (fallback transport)
//   3. .sfdt/feature-flags.json well-formed if present (no JSON errors)
//   4. .sfdt/telemetry-snapshot.json present (operator visibility)
//
// `--core` (see ../lib/doctor-runner.js) covers the base environment: sf CLI,
// node, git, config validity, AI provider, org connectivity.
//
// All checks are read-only. Returns an exit code of 1 if any FAIL-severity
// check fails — WARN-severity checks (snapshot absent, no native host) leave
// exit code 0 so this can run unattended in CI without false-positiving.

import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
// See src/commands/extension.js for the rationale: host/ ships bundled inside
// the @sfdt/cli tarball, @sfdt/host is private so a named-package dep would
// 404 on npm install. test/lib/host-installer-resolves.test.js guards the
// relative path from silently breaking.
import { nativeHostStatus } from '../../host/installers/install-host.js';
import { getConfigDir } from '../lib/config.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';
import { DEFAULT_UI_PORT } from '../lib/ui-port.js';
import { runCoreDoctor } from '../lib/doctor-runner.js';
import { maxStatus } from '../lib/check-status.js';

function symbol(status) {
  if (status === 'ok') return chalk.green('✓');
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
      status: 'ok',
      detail: `OK on port ${port} — sfdt v${data.serverVersion ?? '?'}, protocol ${data.protocolVersion ?? '<missing>'}`,
      data,
    };
  } catch (err) {
    return {
      name: 'sfdt ui bridge',
      status: 'fail',
      detail: `Could not reach ${url}: ${err.message ?? err}. Run \`sfdt ui\` from your project root (or pass --port if it runs on a non-default port).`,
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
      status: 'ok',
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
      status: 'ok',
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
      status: 'ok',
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
      status: 'ok',
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

export async function runExtensionDoctor({ port = DEFAULT_UI_PORT, fetchImpl = globalThis.fetch } = {}) {
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
    .description('Diagnose the local sfdt environment and extension stack')
    .option('--core', 'Run only the environment checks (sf, node, git, config, AI, org)')
    .option('--extension', 'Run only the extension-stack checks (bridge, native host, feature flags, telemetry)')
    .option('--org <alias>', 'Org alias for the connectivity check (default: config defaultOrg)')
    .option('--port <port>', 'Localhost port the bridge listens on', String(DEFAULT_UI_PORT))
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      try {
        const parsedPort = Number(options.port);
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
          throw new Error(`--port must be an integer in [1, 65535]. Got: ${options.port}`);
        }
        // No flag, or both flags → run everything.
        const runCore = options.core || !options.extension;
        const runExt = options.extension || !options.core;

        const results = [];
        if (runCore) {
          const core = await runCoreDoctor({ org: options.org });
          results.push(...core.results.map((r) => ({ ...r, group: 'core' })));
        }
        if (runExt) {
          const ext = await runExtensionDoctor({ port: parsedPort });
          results.push(...ext.results.map((r) => ({ ...r, group: 'extension' })));
        }
        const ok = maxStatus(results) !== 'fail';

        if (options.json) {
          emitJson({ ok, results });
          if (!ok) process.exitCode = 1;
          return;
        }

        const sections = [
          { group: 'core', title: 'Environment' },
          { group: 'extension', title: 'Extension stack' },
        ];
        for (const { group, title } of sections) {
          const groupResults = results.filter((r) => r.group === group);
          if (groupResults.length === 0) continue;
          console.log(chalk.bold(`\n${title} diagnostic\n`));
          for (const r of groupResults) {
            console.log(`  ${symbol(r.status)} ${chalk.bold(r.name)}`);
            console.log(`    ${chalk.dim(r.detail)}`);
          }
        }
        console.log('');
        if (!ok) {
          console.log(chalk.red('Some checks failed — fix the items marked ✗ before continuing.\n'));
          process.exitCode = 1;
        }
      } catch (err) {
        if (options.json) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`doctor failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
