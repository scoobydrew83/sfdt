/**
 * SFDT GUI Server
 *
 * Lightweight Express server that:
 *  - Serves the pre-built React/SLDS dashboard from gui/dist/
 *  - Exposes REST API endpoints that read sfdt config and log files
 */

import { spawn } from 'child_process';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import { createInterface } from 'readline';
import { fetchLatestVersion } from '../update-checker.js';
import { writeLog, parseSfdtLogLines, readLatestLog } from '../log-writer.js';
import { setNestedValue, coerceConfigValue } from '../config-utils.js';
import { loadConfig } from '../config.js';
import { getPrompt, getAllPrompts, setPromptOverride, resetPromptOverride, interpolate } from '../prompts.js';
import { buildScriptEnv } from '../script-runner.js';
import { fetchOrgInventory, fetchInventory } from '../org-inventory.js';
import { initCache, getDelta, updateCache } from '../pull-cache.js';
import { parallelRetrieve } from '../parallel-retrieve.js';
import { createCsrfToken, createOriginGuard, createRateLimiter, requireCsrfToken, requireCsrfTokenFromQueryOrHeader } from './security.js';
import { mountBridgeRoutes } from '../bridge/routes.js';
import { stripAnsi, tryReadJson, safeReaddir, buildPlaceholderHtml } from './shared.js';
import {
  parseTestRunLines, parseQualityLines,
  readTestRuns, readPreflight, readQuality, readDrift, readCompare, readScan,
} from './parsers.js';
import {
  removeComponentFromXml, addComponentToXml,
  retrieveComponentXml, batchRetrieveTypeMembers, readLocalComponentXml,
} from './handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// index.js lives at src/lib/gui-server/ — three levels up reaches the package root
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', '..', 'scripts');
const TEMPLATE_PATH = path.resolve(__dirname, '..', '..', 'templates', 'sfdt.config.json');

// gui/dist lives at <package-root>/gui/dist
const GUI_DIST = path.resolve(__dirname, '..', '..', '..', 'gui', 'dist');

// ─── Command runner config ────────────────────────────────────────────────────

// Commands that get written as structured logs via log-writer
const STRUCTURED_LOG_TYPES = new Set(['preflight', 'drift', 'test', 'quality']);

const COMMANDS = {
  preflight: {
    script: 'ops/preflight.sh',
    logFile: 'logs/preflight-latest.json',
  },
  drift: {
    script: 'ops/drift.sh',
    logFile: 'logs/drift-latest.json',
  },
  test: {
    script: 'core/enhanced-test-runner.sh',
    logFile: 'logs/test-results/latest.json',
  },
  quality: {
    script: 'quality/code-analyzer.sh',
    logFile: 'logs/quality-latest.json',
  },
  deploy: {
    script: 'core/deployment-assistant.sh',
    logFile: 'logs/deploy-latest.log',
  },
  rollback: {
    script: 'ops/rollback.sh',
    logFile: 'logs/rollback-latest.log',
  },
};

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and configure the Express app.
 *
 * @param {object} config  - Loaded sfdt config
 * @param {string} version - CLI version string
 * @returns {import('express').Application}
 */
export function createGuiApp(config, version, port = 7654) {
  let updateInProgress = false;
  let sessionOrg = null;
  const csrfToken = createCsrfToken();
  const app = express();

  // Defense-in-depth response headers. Set globally before any route handler
  // runs so static assets and JSON responses both inherit them. The bind is
  // localhost-only so the exposure is low, but these are zero-cost and stop
  // browser-side MIME-sniffing/clickjacking edge cases dead.
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Body parsers split by route prefix so legitimately large bridge payloads
  // are not rejected by Express's 100 KB default. The bridge `quality`
  // handler accepts JSON-stringified Flow.Metadata, which for a complex flow
  // routinely runs 200–800 KB. Mounting a 6 MB parser on /api/bridge BEFORE
  // the global 100 KB default keeps every other endpoint conservative —
  // changelog/save and release-notes/save have their own 1 MB content caps
  // applied AFTER parsing, so the 100 KB Express default would actually
  // truncate legitimate writes there too. The MAX_FLOW_XML_BYTES check in
  // bridge/routes.js (5 MB) is now reachable as intended.
  app.use('/api/bridge', express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '2mb' }));

  let mcpClient = null;

  const logDir =
    config.logDir ||
    path.join(config._projectRoot || process.cwd(), 'logs');

  const apiLimiter = createRateLimiter(60, 60_000);
  const csrfLimiter = createRateLimiter(10, 60_000);

  // Bridge routes are mounted BEFORE the default origin guard because they
  // accept cross-origin requests from chrome-extension:// and *.salesforce.com.
  // Each bridge route applies its own origin allowlist + bearer-token auth
  // (see src/lib/bridge/middleware.js).
  mountBridgeRoutes(app, {
    port,
    version,
    projectRoot: config._projectRoot,
    configDir: config._configDir,
    rateLimiter: apiLimiter,
  });

  const originGuard = createOriginGuard(port);
  app.use('/api/', originGuard);

  // ── API routes ──────────────────────────────────────────────────────────────

  app.get('/api/health', apiLimiter, (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/csrf-token', csrfLimiter, (_req, res) => {
    res.json({ token: csrfToken });
  });

  let rawConfigPath = config._configDir
    ? path.join(config._configDir, 'config.json')
    : null;
  let initInProgress = false;

  app.get('/api/config', apiLimiter, async (_req, res) => {
    if (!rawConfigPath) return res.status(503).json({ error: 'Config dir unavailable' });
    try {
      const raw = await fs.readJson(rawConfigPath);
      res.json(raw);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Keys that must not be API-writable. Three categories:
  //   - Shell-command keys whose values would execute as commands.
  //   - `defaultOrg`: flows into `--target-org` for every sf invocation; the
  //     dashboard's intended path is POST /api/session/org which validates the
  //     alias against a strict regex. PATCH-ing it directly would let a write
  //     coerce sf to point at an attacker-controlled org.
  //   - `deployment.preflight.*`: silently flipping enforcement flags off
  //     (e.g. enforceGitClean) would let a subsequent deploy bypass the
  //     safety check that the operator deliberately enabled.
  //
  // The match check below is `key === prefix || key.startsWith(`${prefix}.`)`
  // — exact match OR a dot-bounded prefix. That means:
  //   - `defaultOrg` blocks the literal key (the schema's only legitimate
  //     shape — defaultOrg is a string, not a nested object).
  //   - `defaultOrgFoo` is NOT blocked (different key entirely; the dot
  //     boundary prevents over-broad matching).
  //   - `deployment.preflight` blocks every nested enforcement flag like
  //     `deployment.preflight.enforceGitClean` and `deployment.preflight.strict`.
  const BLOCKED_CONFIG_KEY_PREFIXES = [
    'mcp.salesforce.command',
    'mcp.salesforce.args',
    'defaultOrg',
    'deployment.preflight',
  ];
  // Path keys must resolve within projectRoot to prevent logDir/manifestDir redirection attacks.
  const PATH_KEYS_WITHIN_ROOT = new Set([
    'logDir',
    'manifestDir',
    'releaseNotesDir',
    'changelogDir',
    'defaultSourcePath',
  ]);

  app.patch('/api/config', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    if (!rawConfigPath) return res.status(503).json({ error: 'Config dir unavailable' });
    const { key, value } = req.body ?? {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key is required' });
    if (value === undefined || value === null) return res.status(400).json({ error: 'value is required' });
    if (BLOCKED_CONFIG_KEY_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))) {
      return res.status(403).json({ error: 'This config key cannot be set via the API' });
    }
    if (PATH_KEYS_WITHIN_ROOT.has(key)) {
      if (typeof value !== 'string') {
        return res.status(400).json({ error: 'value must be a string for path keys' });
      }
      const projectRoot = config._projectRoot || process.cwd();
      const resolved = path.resolve(projectRoot, value);
      const resolvedRoot = path.resolve(projectRoot);
      if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        return res.status(400).json({ error: `${key} must be within the project root` });
      }
    }
    try {
      const raw = await fs.readJson(rawConfigPath);
      const coerced = coerceConfigValue(String(value));
      setNestedValue(raw, key, coerced);
      await fs.writeJson(rawConfigPath, raw, { spaces: 2 });
      // Refresh in-memory config so subsequent script runs use updated values
      const fresh = await loadConfig(config._projectRoot);
      Object.assign(config, fresh);
      res.json({ ok: true, key, value: coerced });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/init', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const projectRoot = config._projectRoot || process.cwd();
      const configDir = path.join(projectRoot, '.sfdt');
      if (rawConfigPath || initInProgress) {
        return res.status(409).json({ error: 'Already initialized' });
      }
      initInProgress = true;
      if (await fs.pathExists(configDir)) {
        initInProgress = false;
        return res.status(409).json({ error: 'Already initialized' });
      }

      const { projectName = 'Salesforce Project', defaultOrg = '' } = req.body ?? {};
      if (!projectName.trim()) {
        initInProgress = false;
        return res.status(400).json({ error: 'projectName is required' });
      }
      if (!defaultOrg.trim()) {
        initInProgress = false;
        return res.status(400).json({ error: 'defaultOrg is required' });
      }

      const template = await fs.readJson(TEMPLATE_PATH);
      const configData = { ...template, projectName: projectName.trim(), defaultOrg };

      await fs.ensureDir(configDir);
      await fs.writeJson(path.join(configDir, 'config.json'), configData, { spaces: 2 });
      await fs.writeJson(path.join(configDir, 'environments.json'), {
        default: defaultOrg,
        orgs: defaultOrg ? [{ alias: defaultOrg, type: 'development', description: 'Default development org' }] : [],
      }, { spaces: 2 });
      await fs.writeJson(path.join(configDir, 'pull-config.json'), {
        metadataTypes: [
          'ApexClass', 'ApexTrigger', 'LightningComponentBundle', 'CustomObject',
          'CustomField', 'Layout', 'FlexiPage', 'PermissionSet', 'Flow',
        ],
        targetDir: 'force-app/main/default',
      }, { spaces: 2 });
      await fs.writeJson(path.join(configDir, 'test-config.json'), {
        coverageThreshold: template.deployment?.coverageThreshold ?? 75,
        testLevel: 'RunLocalTests',
        suites: [],
        testClasses: [],
        apexClasses: [],
      }, { spaces: 2 });

      rawConfigPath = path.join(configDir, 'config.json');

      // Reload in-memory config so all endpoints see the new values immediately
      const fresh = await loadConfig(projectRoot);
      Object.assign(config, fresh);

      initInProgress = false;
      res.json({ ok: true });
    } catch (err) {
      initInProgress = false;
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/ping', apiLimiter, (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/project', apiLimiter, (_req, res) => {
    res.json({
      name: config.projectName || 'Salesforce Project',
      org: config.defaultOrg || null,
      apiVersion: config.sourceApiVersion || null,
      coverageThreshold: config.deployment?.coverageThreshold ?? 75,
      features: config.features || {},
      version,
    });
  });

  app.get('/api/session/org', apiLimiter, (_req, res) => {
    res.json({ org: sessionOrg ?? config.defaultOrg ?? null });
  });

  app.post('/api/session/org', apiLimiter, (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    const { org } = req.body ?? {};
    if (!org || typeof org !== 'string') return res.status(400).json({ error: 'org is required' });
    const safe = org.trim().slice(0, 80);
    if (!safe) return res.status(400).json({ error: 'org is required' });
    // Match the bridge-contract ORG_ALIAS_RE and the /api/compare org checks:
    // first char must be alphanumeric or '@' (no leading '-' so a flag-style
    // value can't sneak into `sf --target-org`).
    if (!/^[A-Za-z0-9@][A-Za-z0-9_.\-@]*$/.test(safe)) {
      return res.status(400).json({ error: 'Invalid org alias' });
    }
    sessionOrg = safe;
    res.json({ org: sessionOrg });
  });

  app.get('/api/test/classes', apiLimiter, async (_req, res) => {
    try {
      const projectRoot = config._projectRoot ?? process.cwd();
      const sourcePath  = config.defaultSourcePath ?? 'force-app/main/default';
      const absSource   = path.join(projectRoot, sourcePath);

      const configured = config.testConfig?.testClasses ?? [];

      let discovered = [];
      if (await fs.pathExists(absSource)) {
        const { glob } = await import('glob');
        const files = await glob('**/*.cls', { cwd: absSource, nodir: true });
        discovered = files
          .map((f) => path.basename(f, '.cls'))
          .filter((name) => /(?:Test|Tests)$/i.test(name) && !configured.includes(name))
          .sort();
      }

      res.json({ configured, discovered });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/test/classes/sync', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const projectRoot = config._projectRoot ?? process.cwd();
      const sourcePath  = config.defaultSourcePath ?? 'force-app/main/default';
      const absSource   = path.join(projectRoot, sourcePath);
      const configPath  = path.join(projectRoot, '.sfdt', 'config.json');

      if (!(await fs.pathExists(absSource))) {
        return res.status(400).json({ error: `Source path not found: ${sourcePath}` });
      }

      const { glob } = await import('glob');
      const files = await glob('**/*.cls', { cwd: absSource, nodir: true });
      const discovered = files
        .map((f) => path.basename(f, '.cls'))
        .filter((name) => /(?:Test|Tests)$/i.test(name))
        .sort();

      if (discovered.length === 0) {
        return res.status(400).json({ error: 'No test classes found in source path' });
      }

      const existing = config.testConfig?.testClasses ?? [];
      const added    = discovered.filter((c) => !existing.includes(c)).length;
      const removed  = existing.filter((c) => !discovered.includes(c)).length;

      const raw = await fs.readJson(configPath);
      if (!raw.testConfig) raw.testConfig = {};
      raw.testConfig.testClasses = discovered;
      await fs.writeJson(configPath, raw, { spaces: 2 });

      // Refresh in-memory config so subsequent requests see the change
      const fresh = await loadConfig(config._projectRoot);
      Object.assign(config, fresh);

      res.json({ added, removed, total: discovered.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/test-runs', apiLimiter, async (_req, res) => {
    try {
      const runs = await readTestRuns(logDir);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/test-runs/:filename', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { filename } = req.params;
      if (!filename.endsWith('.json') || filename.includes('/') || filename.includes('..')) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
      const filePath = path.join(logDir, 'test-results', filename);
      if (!(await fs.pathExists(filePath))) return res.status(404).json({ error: 'Not found' });
      await fs.remove(filePath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/preflight', apiLimiter, async (_req, res) => {
    try {
      const data = await readPreflight(logDir);
      res.json(data ?? { date: null, status: null, checks: [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/drift', apiLimiter, async (_req, res) => {
    try {
      const data = await readDrift(logDir);
      res.json(data ?? { date: null, status: null, components: [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/quality', apiLimiter, async (_req, res) => {
    try {
      const data = await readQuality(logDir);
      res.json(data ?? { date: null, status: null, summary: { critical: 0, high: 0, medium: 0, low: 0 }, violations: [], unavailableMessage: null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Flow-specific quality endpoint: takes a Tooling-API-shaped Flow.Metadata
  // payload in the request body and returns the @sfdt/flow-core report.
  // The Chrome extension hits this via the bridge; the dashboard hits it
  // directly. Same engine in both paths, so results match the CLI's
  // `sfdt flow scan` output byte-for-byte.
  app.post('/api/flow/quality', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { runFlowQuality } = await import('../flow-quality.js');
      const metadata = req.body?.metadata;
      if (!metadata || typeof metadata !== 'object') {
        return res.status(400).json({ error: 'metadata (object) is required in the body' });
      }
      const report = runFlowQuality(metadata, {
        flowApiName: req.body?.flowApiName,
        flowVersionId: req.body?.flowVersionId,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pull/groups', apiLimiter, (_req, res) => {
    const pullGroups = config.pullConfig?.pullGroups ?? {};
    const groups = Object.entries(pullGroups).map(([key, g]) => ({
      key,
      description: g.description ?? key,
    }));
    res.json({ groups });
  });

  app.get('/api/logs', apiLimiter, async (req, res) => {
    try {
      const typeFilter = req.query.type ?? 'all';
      const archiveDirs = [
        { type: 'preflight', dir: 'preflight-results' },
        { type: 'drift',     dir: 'drift-results' },
        { type: 'quality',   dir: 'quality-results' },
        { type: 'test-run',  dir: 'test-results' },
      ].filter(({ type }) => typeFilter === 'all' || type === typeFilter);

      const logs = [];

      for (const { dir } of archiveDirs) {
        const archiveDir = path.join(logDir, dir);
        if (!(await fs.pathExists(archiveDir))) continue;

        let entries;
        try { entries = await fs.readdir(archiveDir); } catch { continue; }

        const jsonFiles = entries.filter((f) => f.endsWith('.json') && f !== 'latest.json');

        for (const file of jsonFiles) {
          const filePath = path.resolve(archiveDir, file);
          if (!filePath.startsWith(path.resolve(logDir) + path.sep)) continue; // path traversal guard
          const envelope = await tryReadJson(filePath);
          if (!envelope || envelope.schemaVersion !== '1') continue;
          logs.push(envelope);
        }
      }

      const rawArchiveDirs = [
        { type: 'deploy',   dir: 'deploy-results' },
        { type: 'rollback', dir: 'rollback-results' },
      ].filter(({ type }) => typeFilter === 'all' || type === typeFilter);

      for (const { dir } of rawArchiveDirs) {
        const archiveDir = path.join(logDir, dir);
        if (!(await fs.pathExists(archiveDir))) continue;

        let entries;
        try { entries = await fs.readdir(archiveDir); } catch { continue; }

        const jsonFiles = entries.filter((f) => f.endsWith('.json'));

        for (const file of jsonFiles) {
          const filePath = path.resolve(archiveDir, file);
          if (!filePath.startsWith(path.resolve(logDir) + path.sep)) continue;
          const envelope = await tryReadJson(filePath);
          if (!envelope || envelope.schemaVersion !== 'raw-1') continue;
          logs.push(envelope);
        }
      }

      logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Check for updates ──────────────────────────────────────────────────────

  app.get('/api/check-updates', apiLimiter, async (_req, res) => {
    try {
      const latest = await fetchLatestVersion();
      res.json({ current: version, latest, updateAvailable: latest !== version });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Update via npm (SSE) ────────────────────────────────────────────────────

  app.get('/api/update/stream', apiLimiter, (_req, res) => {
    res.status(405).json({ error: 'Use POST /api/update/stream' });
  });

  app.post('/api/update/stream', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    if (updateInProgress) {
      return res.status(409).json({ error: 'An update is already in progress' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    updateInProgress = true;
    let child;
    req.on('close', () => { if (child && !child.killed) child.kill(); });

    try {
      child = execa('npm', ['install', '--global', '@sfdt/cli@latest'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const streamLines = (readable) => {
        const rl = createInterface({ input: readable, crlfDelay: Infinity });
        rl.on('line', (line) => {
          const stripped = stripAnsi(line);
          if (!res.writableEnded && !stripped.startsWith('SFDT_LOG:')) {
            res.write('data: ' + JSON.stringify({ type: 'log', line: stripped, ts: new Date().toISOString() }) + '\n\n');
          }
        });
        return rl;
      };

      const rlOut = streamLines(child.stdout);
      const rlErr = streamLines(child.stderr);

      let exitCode = 0;
      try {
        await child;
      } catch (execErr) {
        // exitCode 1 covers both real errors and SIGKILL on client disconnect
        exitCode = execErr.exitCode ?? 1;
      } finally {
        rlOut.close();
        rlErr.close();
      }

      if (!res.writableEnded) {
        res.write('data: ' + JSON.stringify({ type: 'result', exitCode }) + '\n\n');
        if (exitCode === 0) {
          res.write('data: ' + JSON.stringify({ type: 'restarting' }) + '\n\n');
        }
        res.end();
      }

      if (exitCode === 0) {
        setTimeout(() => {
          const child = spawn(process.argv[0], [process.argv[1], 'ui'], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
            cwd: config._projectRoot || process.cwd(),
          });
          child.unref();
          process.exit(0);
        }, 500);
        return;
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.write('data: ' + JSON.stringify({ type: 'error', message: err.message }) + '\n\n');
        res.end();
      }
    } finally {
      updateInProgress = false;
    }
  });

  // ── Generic command runner (SSE) ───────────────────────────────────────────

  app.get('/api/command/run', apiLimiter, (_req, res) => {
    res.status(405).json({ error: 'Use POST /api/command/run' });
  });

  app.post('/api/command/run', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    const { command, classes, testLevel, targetOrg } = req.body ?? {};

    if (targetOrg !== undefined && !/^[A-Za-z0-9_.\-@]+$/.test(String(targetOrg))) {
      return res.status(400).json({ error: 'Invalid targetOrg' });
    }
    const cmd = COMMANDS[command];
    if (!cmd) {
      return res.status(400).json({ error: 'Unknown command' });
    }

    let requestedTestClasses = '';
    if (command === 'test' && classes) {
      const classNames = String(classes).split(',').map((c) => c.trim()).filter(Boolean);
      if (classNames.some((c) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(c))) {
        return res.status(400).json({ error: 'Invalid Apex class name in classes parameter' });
      }
      requestedTestClasses = classNames.join(',');
    }

    if (command === 'test' && testLevel !== undefined && testLevel !== null) {
      const VALID_TEST_LEVELS = ['RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg', 'NoTestRun'];
      if (!VALID_TEST_LEVELS.includes(testLevel)) {
        return res.status(400).json({ error: 'Invalid testLevel' });
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let child;
    const startTime = Date.now();

    req.on('close', () => {
      if (child && !child.killed) child.kill();
    });

    try {
      const { execa } = await import('execa');
      const { createInterface } = await import('readline');

      const projectRoot = config._projectRoot ?? process.cwd();
      const scriptPath = path.join(SCRIPTS_DIR, cmd.script);

      const scriptEnv = {
        ...buildScriptEnv(config),
        SFDT_TARGET_ORG: targetOrg ?? sessionOrg ?? config.defaultOrg ?? '',
        SFDT_NON_INTERACTIVE: 'true',
      };

      if (requestedTestClasses) {
        scriptEnv.SFDT_TEST_CLASSES = requestedTestClasses;
      }

      if (command === 'test' && testLevel) {
        scriptEnv.SFDT_TEST_LEVEL = testLevel;
      }

      child = execa('bash', [scriptPath], {
        env: { ...process.env, ...scriptEnv },
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const lines = [];

      const streamLines = (readable) => {
        const rl = createInterface({ input: readable, crlfDelay: Infinity });
        rl.on('line', (line) => {
          lines.push(line);
          const stripped = stripAnsi(line);
          if (!res.writableEnded && !stripped.startsWith('SFDT_LOG:')) {
            res.write('data: ' + JSON.stringify({ type: 'log', line: stripped, ts: new Date().toISOString() }) + '\n\n');
          }
        });
        return rl;
      };

      const rlStdout = streamLines(child.stdout);
      const rlStderr = streamLines(child.stderr);

      let exitCode = 0;
      try {
        await child;
      } catch (execErr) {
        exitCode = execErr.exitCode ?? 1;
      } finally {
        rlStdout.close();
        rlStderr.close();
      }

      const runDurationMs = Date.now() - startTime;
      if (STRUCTURED_LOG_TYPES.has(command)) {
        const logType = command === 'test' ? 'test-run' : command;
        let data;
        if (command === 'preflight') {
          const { checks } = parseSfdtLogLines(lines);
          const hasFailure = checks.some((c) => c.status === 'FAIL');
          const hasWarn = checks.some((c) => c.status === 'WARN');
          data = {
            status: hasFailure ? 'FAIL' : hasWarn ? 'WARN' : 'PASS',
            checks,
          };
        } else if (command === 'drift') {
          const { components } = parseSfdtLogLines(lines);
          data = {
            status: components.length > 0 ? 'drift' : 'clean',
            components,
          };
        } else if (command === 'test') {
          data = parseTestRunLines(lines);
        } else if (command === 'quality') {
          data = parseQualityLines(lines);
        } else {
          data = {};
        }
        await writeLog(logDir, logType, data, {
          org: config.defaultOrg ?? '',
          projectName: config.projectName ?? '',
          exitCode,
          durationMs: runDurationMs,
          retention: config.logRetention ?? 50,
        });
      } else {
        // Non-structured commands (deploy, rollback) keep raw format
        const logPayload = { date: new Date().toISOString(), command, exitCode, lines };
        const logFilePath = path.join(projectRoot, cmd.logFile);
        await fs.outputJson(logFilePath, logPayload, { spaces: 2 });
      }

      if (!res.writableEnded) {
        res.write('data: ' + JSON.stringify({ type: 'result', exitCode }) + '\n\n');
        res.end();
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.write('data: ' + JSON.stringify({ type: 'error', message: err.message }) + '\n\n');
        res.end();
      }
    }
  });

  // ── Pull endpoint (SSE) ────────────────────────────────────────────────────

  app.get('/api/pull', apiLimiter, (_req, res) => {
    res.status(405).json({ error: 'Use POST /api/pull' });
  });

  app.post('/api/pull', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit = (obj) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n');
    };

    const startTime = Date.now();
    const rawOrg = req.body?.targetOrg || config.defaultOrg;
    const mode = req.body?.mode ?? 'delta';
    const projectRoot = config._projectRoot ?? process.cwd();
    const cacheDir = path.join(config._configDir ?? path.join(projectRoot, '.sfdt'), 'cache');

    if (!rawOrg) {
      emit({ type: 'log', line: 'No target org configured. Set defaultOrg in .sfdt/config.json.' });
      emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed: 0 });
      res.end();
      return;
    }

    if (!/^[A-Za-z0-9_.\-@]+$/.test(String(rawOrg))) {
      emit({ type: 'log', line: 'Invalid org alias.' });
      emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed: 0 });
      res.end();
      return;
    }

    const org = rawOrg;
    const ac = new AbortController();
    let child;

    req.on('close', () => {
      ac.abort();
      if (child && !child.killed) child.kill();
    });

    const streamChild = (spawnedChild) => new Promise((resolve, reject) => {
      child = spawnedChild;
      child.on('error', reject);
      const rlStdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const rlStderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
      rlStdout.on('line', (line) => emit({ type: 'log', line: stripAnsi(line) }));
      rlStderr.on('line', (line) => emit({ type: 'log', line: stripAnsi(line) }));
      child.on('close', (code) => {
        rlStdout.close();
        rlStderr.close();
        resolve(code ?? 0);
      });
    });

    try {
      if (mode === 'delta') {
        emit({ type: 'log', line: 'Fetching org inventory…' });
        const freshInventory = await fetchOrgInventory(org, null, { withDates: true });
        const total = [...freshInventory.values()].reduce((n, m) => n + m.size, 0);
        emit({ type: 'log', line: `Fetched ${total} components from org` });

        const db = initCache(cacheDir, org);
        try {
          const delta = getDelta(db, freshInventory);
          const deltaCount = [...delta.values()].reduce((n, s) => n + s.size, 0);

          if (deltaCount === 0) {
            emit({ type: 'log', line: 'Nothing to pull — org is up to date' });
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            emit({ type: 'result', exitCode: 0, retrieved: 0, elapsed });
          } else {
            emit({ type: 'log', line: `${deltaCount} component(s) to retrieve` });
            const result = await parallelRetrieve(delta, config, {
              cwd: projectRoot,
              signal: ac.signal,
              onProgress: ({ retrieved, total: t }) => emit({ type: 'progress', retrieved, total: t }),
            });

            if (result.retrieved > 0) {
              const successSet = new Set(result.successfulMembers);
              const successInventory = new Map();
              for (const [type, members] of freshInventory) {
                const filtered = new Map();
                for (const [name, meta] of members) {
                  if (successSet.has(`${type}:${name}`)) filtered.set(name, meta);
                }
                if (filtered.size > 0) successInventory.set(type, filtered);
              }
              updateCache(db, successInventory);
            }

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            emit({ type: 'result', exitCode: result.errors.length > 0 ? 1 : 0, retrieved: result.retrieved, elapsed });
          }
        } finally {
          db.close();
        }
      } else if (mode === 'full') {
        const sourceDirArgs = (config.packageDirectories?.length
          ? config.packageDirectories.map((d) => d.path)
          : [config.defaultSourcePath ?? 'force-app/main/default']
        ).flatMap((d) => ['--source-dir', d]);
        const exitCode = await streamChild(spawn('sf', ['project', 'retrieve', 'start', ...sourceDirArgs, '--target-org', org], {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        emit({ type: 'result', exitCode, retrieved: 0, elapsed });
      } else if (mode === 'preview') {
        const sourceDirArgs = (config.packageDirectories?.length
          ? config.packageDirectories.map((d) => d.path)
          : [config.defaultSourcePath ?? 'force-app/main/default']
        ).flatMap((d) => ['--source-dir', d]);
        const exitCode = await streamChild(spawn('sf', ['project', 'retrieve', 'preview', ...sourceDirArgs, '--target-org', org], {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        emit({ type: 'result', exitCode, retrieved: 0, elapsed });
      } else if (mode === 'group') {
        const groupKey = req.body?.groupKey;
        if (!groupKey || !/^[A-Za-z0-9_-]+$/.test(groupKey)) {
          emit({ type: 'log', line: 'Invalid groupKey' });
          emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed: 0 });
          return;
        }
        const group = config.pullConfig?.pullGroups?.[groupKey];
        if (!group) {
          emit({ type: 'log', line: `Unknown pull group: ${groupKey}` });
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed });
        } else if (!group.metadata?.length) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          emit({ type: 'log', line: `Pull group "${groupKey}" has no metadata entries` });
          emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed });
        } else {
          const metadataPattern = /^[A-Za-z][A-Za-z0-9]*:[A-Za-z0-9_*.-]+$/;
          const invalidEntry = group.metadata.find((t) => !metadataPattern.test(String(t)));
          if (invalidEntry) {
            emit({ type: 'log', line: `Invalid metadata entry in pull group: ${invalidEntry}` });
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed });
            return;
          }
          const typeArgs = group.metadata.flatMap((t) => ['--metadata', t]);
          const exitCode = await streamChild(spawn('sf', ['project', 'retrieve', 'start', ...typeArgs, '--target-org', org], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
          }));
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          emit({ type: 'result', exitCode, retrieved: 0, elapsed });
        }
      } else {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        emit({ type: 'log', line: `Unknown pull mode: ${mode}` });
        emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed });
      }

      if (!res.writableEnded) res.end();
    } catch (err) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      emit({ type: 'log', line: `Pull failed: ${err.message}` });
      emit({ type: 'result', exitCode: 1, retrieved: 0, elapsed });
      if (!res.writableEnded) res.end();
    }
  });

  // ── Compare routes ─────────────────────────────────────────────────────────

  app.get('/api/orgs', apiLimiter, async (_req, res) => {
    try {
      const { execa } = await import('execa');
      let sfOrgs = [];
      try {
        const result = await execa('sf', ['org', 'list', '--json']);
        const parsed = JSON.parse(result.stdout);
        const allOrgs = [
          ...(parsed.result?.nonScratchOrgs ?? []),
          ...(parsed.result?.scratchOrgs ?? []),
        ];
        sfOrgs = allOrgs
          .filter((o) => o.alias)
          .map((o) => ({ alias: o.alias, username: o.username }));
      } catch {
        // sf not available or no orgs authorized
      }

      const configOrgs = (config.environments?.orgs ?? []).map((o) => ({
        alias: o.alias,
        username: o.username ?? '',
      }));

      // Merge, deduplicate by alias
      const byAlias = new Map();
      for (const org of [...sfOrgs, ...configOrgs]) {
        if (!byAlias.has(org.alias)) byAlias.set(org.alias, org);
      }

      res.json({ orgs: [...byAlias.values()] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compare', apiLimiter, async (_req, res) => {
    try {
      const data = await readCompare(logDir);
      res.json(data ?? { date: null, source: null, target: null, items: [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compare', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { source = 'local', target } = req.body ?? {};
      if (!target) return res.status(400).json({ error: 'target is required' });
      const ORG_ALIAS_RE = /^[A-Za-z0-9@][A-Za-z0-9_.\-@]*$/;
      if (!ORG_ALIAS_RE.test(source)) return res.status(400).json({ error: 'Invalid source org alias' });
      if (!ORG_ALIAS_RE.test(target)) return res.status(400).json({ error: 'Invalid target org alias' });

      const { fetchInventory } = await import('../org-inventory.js');
      const { diffInventories } = await import('../org-diff.js');

      const [sourceMap, targetMap] = await Promise.all([
        fetchInventory(source, config),
        fetchInventory(target, config),
      ]);

      const items = diffInventories(sourceMap, targetMap);
      const payload = { date: new Date().toISOString(), source, target, items };

      const fsExtra = (await import('fs-extra')).default;
      await fsExtra.outputJson(path.join(logDir, 'compare-latest.json'), payload, { spaces: 2 });

      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/scan', apiLimiter, async (_req, res) => {
    try {
      const data = await readScan(logDir);
      if (!data) return res.status(204).end();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Fetch complete metadata inventory from an org.
   * NOTE: For very large orgs (>10k components), the JSON payload can exceed 10MB.
   * Node.js/Express handles this in-memory; clients should expect multi-second transfers.
   */
  app.post('/api/scan', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { org } = req.body ?? {};
      if (!org || !org.trim()) return res.status(400).json({ error: 'org is required' });
      if (!/^[A-Za-z0-9@][A-Za-z0-9_.\-@]*$/.test(org.trim())) return res.status(400).json({ error: 'Invalid org alias' });

      const inventory = await fetchInventory(org, config);
      const summary = {
        totalTypes: inventory.size,
        totalMembers: [...inventory.values()].reduce((n, s) => n + s.size, 0),
      };
      const payload = {
        timestamp: new Date().toISOString(),
        org,
        inventory: Object.fromEntries([...inventory.entries()].map(([k, v]) => [k, [...v]])),
        summary,
      };

      await fs.outputJson(path.join(logDir, 'scan-latest.json'), payload, { spaces: 2 });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compare/stream', apiLimiter, async (req, res) => {
    // EventSource can't set custom headers, so accept the CSRF token from
    // `?csrf=`. The route spawns `sf project retrieve start` and creates temp
    // dirs — without this guard, any cross-origin page could trigger retrieves
    // by loading the URL in an <img> or via fetch.
    if (!requireCsrfTokenFromQueryOrHeader(req, res, csrfToken)) return;
    const data = await readCompare(logDir);
    if (!data) return res.status(404).json({ error: 'No comparison result found. Run compare first.' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let clientClosed = false;
    req.on('close', () => {
      clientClosed = true;
    });

    const os = await import('os');
    // mkdtemp creates a uniquely-named, mode-0700 directory atomically —
    // robust against the race where a predictable `${Date.now()}` name
    // already exists on a busy box.
    let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-compare-'));

    try {
      const bothItems = data.items.filter((i) => i.status === 'both');
      let completed = 0;

      const sendEvent = (payload) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      sendEvent({ type: 'progress', total: bothItems.length, completed: 0 });

      // Group by type so we can batch-retrieve all members of each type in one SF CLI call
      const byType = new Map();
      for (const item of bothItems) {
        if (!byType.has(item.type)) byType.set(item.type, []);
        byType.get(item.type).push(item.member);
      }

      for (const [type, members] of byType) {
        if (clientClosed || res.destroyed) break;

        // Batch-retrieve all members of this type from both sides in parallel
        const [targetXmlMap, sourceXmlMap] = await Promise.all([
          batchRetrieveTypeMembers(data.target, type, members, tmpDir),
          data.source !== 'local'
            ? batchRetrieveTypeMembers(data.source, type, members, tmpDir)
            : Promise.resolve(new Map()),
        ]);

        for (const member of members) {
          if (clientClosed || res.destroyed) break;

          const targetXml = targetXmlMap.get(member) ?? null;
          const sourceXml =
            data.source === 'local'
              ? await readLocalComponentXml(config, type, member)
              : sourceXmlMap.get(member) ?? null;

          const status =
            sourceXml && targetXml && sourceXml.trim() === targetXml.trim()
              ? 'identical'
              : 'modified';

          sendEvent({ type: 'diff', itemType: type, member, status });
          completed++;
          sendEvent({ type: 'progress', total: bothItems.length, completed });
        }
      }

      sendEvent({ type: 'done' });
    } catch (err) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      }
    } finally {
      if (!res.writableEnded) res.end();
      await fs.remove(tmpDir).catch(() => {});
    }
  });

  app.get('/api/release/suggest-version', apiLimiter, async (_req, res) => {
    try {
      const projectRoot = config._projectRoot ?? process.cwd();
      const manifestDir = path.join(projectRoot, config.manifestDir ?? 'manifest/release');
      
      let latestVersion = '';

      // Check manifest files (including deployed/ subdirectory)
      if (await fs.pathExists(manifestDir)) {
        const files = await fs.readdir(manifestDir);
        const deployedDir = path.join(manifestDir, 'deployed');
        const deployedFiles = await fs.pathExists(deployedDir) ? await fs.readdir(deployedDir) : [];
        const versions = [...files, ...deployedFiles]
          .filter(f => f.match(/^rl-(\d+\.\d+\.\d+)-package\.xml$/))
          .map(f => f.match(/^rl-(\d+\.\d+\.\d+)-package\.xml$/)[1]);
        
        if (versions.length > 0) {
          versions.sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < 3; i++) {
              if (pa[i] !== pb[i]) return pa[i] - pb[i];
            }
            return 0;
          });
          latestVersion = versions[versions.length - 1];
        }
      }

      // Fallback to git tags
      if (!latestVersion) {
        try {
          const { stdout } = await execa('git', ['tag', '--list', 'v*', '--sort=-version:refname'], { cwd: projectRoot });
          const topTag = stdout.split('\n')[0];
          if (topTag) latestVersion = topTag.replace(/^v/, '');
        } catch { /* ignore git errors */ }
      }

      if (!latestVersion) return res.json({ version: '0.1.0' });

      const parts = latestVersion.split('.').map(Number);
      if (parts.length === 3) {
        parts[2]++;
        return res.json({ version: parts.join('.') });
      }

      res.json({ version: '0.1.0' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compare/manifest', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { items = [], apiVersion, save = false, version, xml: rawXml } = req.body ?? {};
      if (rawXml && rawXml.length > 10_000_000) return res.status(413).json({ error: 'XML content too large (max 10 MB)' });
      const { renderPackageXml } = await import('../metadata-mapper.js');

      let xml = rawXml;
      if (!xml) {
        const metaMap = new Map();
        for (const { type, member } of items) {
          if (typeof type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(type)) continue;
          if (typeof member !== 'string') continue;
          if (!metaMap.has(type)) metaMap.set(type, []);
          metaMap.get(type).push(member);
        }
        const resolvedVersion = apiVersion ?? config.sourceApiVersion ?? '63.0';
        xml = renderPackageXml(Object.fromEntries(metaMap), resolvedVersion);
      }

      if (save) {
        if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
          return res.status(400).json({ error: 'Invalid version format. Expected X.Y.Z (e.g. 1.2.3).' });
        }
        const projectRoot = config._projectRoot ?? process.cwd();
        const manifestDir = path.join(projectRoot, config.manifestDir ?? 'manifest/release');
        await fs.ensureDir(manifestDir);

        const filename = path.basename(version ? `rl-${version}-package.xml` : `manifest-${Date.now()}.xml`);
        const filePath = path.join(manifestDir, filename);
        const resolvedManifestDir = path.resolve(manifestDir);
        if (!path.resolve(filePath).startsWith(resolvedManifestDir + path.sep)) {
          return res.status(400).json({ error: 'Invalid manifest path' });
        }
        if (version && await fs.pathExists(filePath)) {
          return res.status(409).json({ error: `${filename} already exists. Delete it or use a different version.` });
        }
        await fs.writeFile(filePath, xml);
        return res.json({ xml, filename, path: path.relative(projectRoot, filePath), ok: true });
      }

      res.json({ xml });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compare/diff', apiLimiter, async (req, res) => {
    const { type, member } = req.query;
    if (typeof type !== 'string' || typeof member !== 'string' || !type || !member) {
      return res.status(400).json({ error: 'type and member are required' });
    }
    // Block path traversal: null bytes, parent-directory sequences, absolute paths.
    // Dots and slashes are valid in Salesforce member names (e.g. CustomMetadata__mdt.Record, reports/Folder/Name).
    if (/[\x00]|\.\./.test(member) || /^[/\\]/.test(member)) {
      return res.status(400).json({ error: 'Invalid member name' });
    }

    const data = await readCompare(logDir);
    if (!data) return res.status(404).json({ error: 'No comparison result found.' });

    const os = await import('os');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-diff-'));

    try {
      const [sourceXml, targetXml] = await Promise.all([
        data.source === 'local'
          ? readLocalComponentXml(config, type, member)
          : retrieveComponentXml(data.source, type, member, tmpDir),
        retrieveComponentXml(data.target, type, member, tmpDir),
      ]);

      res.json({ sourceXml: sourceXml ?? '', targetXml: targetXml ?? '' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      await fs.remove(tmpDir).catch(() => {});
    }
  });

  // ── Manifest routes ────────────────────────────────────────────────────────

  app.get('/api/packages', apiLimiter, (_req, res) => {
    const packages = config.packageDirectories ?? [];
    // Return empty array for single-package (caller hides the picker)
    res.json({ packages: packages.length > 1 ? packages.map((p) => ({ name: p.name, path: p.path, default: p.default })) : [] });
  });

  app.get('/api/manifests', apiLimiter, async (_req, res) => {
    try {
      const projectRoot = config._projectRoot ?? process.cwd();
      const relManifestDir = config.manifestDir ?? 'manifest/release';
      const manifestReleaseDir = path.join(projectRoot, relManifestDir);
      const deployedDir = path.join(manifestReleaseDir, 'deployed');
      const manifests = [];

      const logFiles = await safeReaddir(logDir);
      for (const file of logFiles.filter((f) => f.match(/^compare-manifest-\d/)).sort().reverse()) {
        const filePath = path.join(logDir, file);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat) manifests.push({ name: file, source: 'compare', date: stat.mtime.toISOString(), size: stat.size, relPath: `logs/${file}` });
      }

      // Scan current release manifests
      const releaseFiles = await safeReaddir(manifestReleaseDir);
      for (const file of releaseFiles.filter((f) => f.endsWith('.xml')).sort().reverse()) {
        const filePath = path.join(manifestReleaseDir, file);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat) manifests.push({ name: file, source: 'release', date: stat.mtime.toISOString(), size: stat.size, relPath: `${relManifestDir}/${file}` });
      }

      // When using subpath layout, also scan one level of subdirectories
      if ((config.manifestLayout ?? 'flat') === 'subpath') {
        const subdirs = await safeReaddir(manifestReleaseDir);
        for (const subdir of subdirs) {
          const subdirPath = path.join(manifestReleaseDir, subdir);
          const subdirStat = await fs.stat(subdirPath).catch(() => null);
          if (!subdirStat?.isDirectory() || subdir === 'deployed') continue;
          const subdirFiles = await safeReaddir(subdirPath);
          for (const file of subdirFiles.filter((f) => f.endsWith('.xml')).sort().reverse()) {
            const filePath = path.join(subdirPath, file);
            const stat = await fs.stat(filePath).catch(() => null);
            if (stat) manifests.push({ name: `${subdir}/${file}`, source: 'release', date: stat.mtime.toISOString(), size: stat.size, relPath: `${relManifestDir}/${subdir}/${file}` });
          }
        }
      }

      // Scan deployed manifests
      const deployedFiles = await safeReaddir(deployedDir);
      for (const file of deployedFiles.filter((f) => f.endsWith('.xml')).sort().reverse()) {
        const filePath = path.join(deployedDir, file);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat) manifests.push({ name: file, source: 'deployed', date: stat.mtime.toISOString(), size: stat.size, relPath: `${relManifestDir}/deployed/${file}` });
      }

      res.json({ manifests });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/manifests/content', apiLimiter, async (req, res) => {
    try {
      const rawPath = req.query.path;
      const relPath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
      if (!relPath || path.isAbsolute(relPath) || relPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      const projectRoot = config._projectRoot ?? process.cwd();
      const absPath = path.resolve(projectRoot, relPath);
      if (!absPath.startsWith(projectRoot + path.sep) && absPath !== projectRoot) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const xml = await fs.readFile(absPath, 'utf8');
      res.json({ xml });
    } catch {
      res.status(404).json({ error: 'Not found' });
    }
  });

  app.post('/api/manifest/build', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { base = 'main', head = 'HEAD', package: pkg = 'all', name: releaseName } = req.body ?? {};
      // Refs that start with '-' are git option flags (e.g. --output, -c), not refs.
      const safeRefPattern = /^[A-Za-z0-9._/~^@:{}][A-Za-z0-9._/~^@:{}-]*$/;
      if (!safeRefPattern.test(String(base)) || !safeRefPattern.test(String(head))) {
        return res.status(400).json({ error: 'Invalid git ref' });
      }
      const packages = config.packageDirectories ?? [];
      const projectRoot = config._projectRoot ?? process.cwd();
      const sourcePath = config.defaultSourcePath ?? 'force-app/main/default';
      const apiVersion = config.sourceApiVersion ?? '63.0';

      const { parseDiffToMetadata, renderPackageXml: renderXml, countMembers } = await import('../metadata-mapper.js');

      const mergeBase = await execa('git', ['merge-base', base, head], { cwd: projectRoot, reject: false });
      const baseRef = (mergeBase.exitCode === 0 && mergeBase.stdout.trim()) ? mergeBase.stdout.trim() : base;

      let diffPaths;
      let diffSourcePath = sourcePath;
      if (pkg !== 'all' && packages.length > 0) {
        const matched = packages.find((p) => p.name === pkg);
        if (!matched) return res.status(400).json({ error: `Unknown package "${pkg}"` });
        diffPaths = [matched.path + '/'];
        diffSourcePath = matched.path;
      } else {
        diffPaths = packages.length > 0
          ? [...new Set(packages.map((p) => p.path.split('/')[0] + '/'))]
          : [sourcePath.split('/')[0] + '/'];
      }

      const diffResult = await execa(
        'git',
        ['diff', '--name-status', baseRef, head, '--', ...diffPaths],
        { cwd: projectRoot, reject: false }
      );

      if (diffResult.exitCode !== 0) {
        return res.status(500).json({ error: `git diff failed: ${diffResult.stderr || 'unknown error'}` });
      }

      const { additive, destructive } = parseDiffToMetadata(diffResult.stdout, { sourcePath: diffSourcePath });
      const addCount = countMembers(additive);
      const delCount = countMembers(destructive);
      const xml = renderXml(additive, apiVersion);

      const { version, save = false } = req.body ?? {};
      const effectiveName = releaseName || version || null;
      if (effectiveName && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(effectiveName)) {
        return res.status(400).json({ error: 'Invalid release label. Must start with alphanumeric.' });
      }
      let filename = `manifest-${Date.now()}.xml`;
      let savedPath = '';

      if (save || effectiveName) {
        const layout = config.manifestLayout ?? 'flat';
        const pkgSuffix = layout !== 'subpath' && pkg !== 'all' ? `-${pkg}` : '';
        const subdir = layout === 'subpath' ? path.basename(String(pkg)) : '';
        const manifestDir = path.join(projectRoot, config.manifestDir ?? 'manifest/release', subdir);

        filename = effectiveName ? `rl-${effectiveName}${pkgSuffix}-package.xml` : filename;
        const filePath = path.join(manifestDir, filename);
        const rawDestFilename = (delCount > 0 && effectiveName) ? `rl-${effectiveName}${pkgSuffix}-destructiveChanges.xml` : null;
        const destFilename = rawDestFilename ? path.basename(rawDestFilename) : null;
        const destFilePath = destFilename ? path.join(manifestDir, destFilename) : null;

        // Path-containment guard: ensure constructed paths stay within manifestDir parent
        const resolvedManifestBase = path.resolve(projectRoot, config.manifestDir ?? 'manifest/release');
        if (!path.resolve(filePath).startsWith(resolvedManifestBase + path.sep)) {
          return res.status(400).json({ error: 'Invalid manifest path' });
        }
        if (destFilePath && !path.resolve(destFilePath).startsWith(resolvedManifestBase + path.sep)) {
          return res.status(400).json({ error: 'Invalid destructive changes path' });
        }
        await fs.ensureDir(manifestDir);

        // Conflict check both files before writing either (avoid orphaned primary on 409)
        if (effectiveName && await fs.pathExists(filePath)) {
          return res.status(409).json({ error: `${filename} already exists.` });
        }
        if (destFilePath && effectiveName && await fs.pathExists(destFilePath)) {
          return res.status(409).json({ error: `${destFilename} already exists.` });
        }

        await fs.writeFile(filePath, xml);
        savedPath = path.relative(projectRoot, filePath);

        if (delCount > 0) {
          const destXml = renderXml(destructive, apiVersion);
          const resolvedDestFilename = destFilename ?? `destructive-${Date.now()}.xml`;
          const resolvedDestFilePath = destFilePath ?? path.join(manifestDir, resolvedDestFilename);
          await fs.writeFile(resolvedDestFilePath, destXml);
        }
      }

      res.json({ xml, addCount, delCount, filename, path: savedPath, ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Release Hub: deploy with options (SSE) ────────────────────────────────

  app.post('/api/release/deploy', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    const {
      dryRun = false,
      skipPreflight = false,
      notifySlack = false,
      tagRelease = false,
      createPR = false,
      org,
      manifest,
      sourceDir,
      testLevel,
      testClasses,
      destructiveTiming,
      validationJobId,
    } = req.body ?? {};

    const projectRoot = config._projectRoot ?? process.cwd();

    if (manifest !== undefined && manifest !== null) {
      if (typeof manifest !== 'string' || path.isAbsolute(manifest) || manifest.includes('..')) {
        return res.status(400).json({ error: 'Invalid manifest path' });
      }
      const absManifest = path.resolve(projectRoot, manifest);
      if (!absManifest.startsWith(projectRoot + path.sep)) {
        return res.status(400).json({ error: 'Invalid manifest path' });
      }
    }

    if (sourceDir !== undefined && sourceDir !== null) {
      if (typeof sourceDir !== 'string' || path.isAbsolute(sourceDir) || sourceDir.includes('..')) {
        return res.status(400).json({ error: 'Invalid sourceDir path' });
      }
      const absSourceDir = path.resolve(projectRoot, sourceDir);
      if (!absSourceDir.startsWith(projectRoot + path.sep)) {
        return res.status(400).json({ error: 'Invalid sourceDir path' });
      }
    }

    if (org !== undefined && org !== null) {
      if (typeof org !== 'string' || !/^[A-Za-z0-9_.\-@]+$/.test(org)) {
        return res.status(400).json({ error: 'Invalid org alias' });
      }
    }

    const VALID_TEST_LEVELS = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];
    if (testLevel !== undefined && testLevel !== null && !VALID_TEST_LEVELS.includes(testLevel)) {
      return res.status(400).json({ error: 'Invalid testLevel' });
    }

    if (destructiveTiming !== undefined && destructiveTiming !== null && !['pre', 'post', 'none', 'only'].includes(destructiveTiming)) {
      return res.status(400).json({ error: 'Invalid destructiveTiming' });
    }

    // Salesforce job IDs are 15- or 18-char alphanumeric — reject anything else so
    // we don't shell out with arbitrary user input.
    if (validationJobId !== undefined && validationJobId !== null) {
      if (typeof validationJobId !== 'string' || !/^[A-Za-z0-9]{15,18}$/.test(validationJobId)) {
        return res.status(400).json({ error: 'Invalid validationJobId' });
      }
    }

    const VALID_CLASS = /^[A-Za-z][A-Za-z0-9_]*$/;
    const classList = Array.isArray(testClasses)
      ? testClasses
      : typeof testClasses === 'string' && testClasses
        ? testClasses.split(',')
        : [];
    const normalizedList = classList.map((s) => String(s).trim()).filter(Boolean);
    if (normalizedList.some((c) => !VALID_CLASS.test(c))) {
      return res.status(400).json({ error: 'Invalid test class name' });
    }
    const normalizedTestClasses = normalizedList.join(' ');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let child;
    req.on('close', () => { if (child && !child.killed) child.kill(); });

    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'core', 'deployment-assistant.sh');

      const scriptEnv = {
        ...buildScriptEnv(config),
        SFDT_DEFAULT_ORG: org ?? config.defaultOrg ?? '',
        SFDT_TARGET_ORG: org ?? config.defaultOrg ?? '',
        SFDT_NON_INTERACTIVE: 'true',
        SFDT_DRY_RUN: dryRun ? 'true' : 'false',
        SFDT_SKIP_PREFLIGHT: skipPreflight ? 'true' : 'false',
        SFDT_NOTIFY_SLACK: notifySlack ? 'true' : 'false',
        SFDT_TAG_RELEASE: tagRelease ? 'true' : 'false',
        SFDT_CREATE_PR: createPR ? 'true' : 'false',
        SFDT_TEST_LEVEL: testLevel ?? '',
        SFDT_SPECIFIED_TESTS: normalizedTestClasses,
        SFDT_DESTRUCTIVE_TIMING: destructiveTiming ?? 'post',
        ...(manifest ? { SFDT_MANIFEST_PATH: path.join(projectRoot, manifest) } : {}),
        ...(sourceDir ? { SFDT_DEPLOY_SOURCE_DIR: sourceDir } : {}),
        ...(validationJobId ? { SFDT_VALIDATION_JOB_ID: validationJobId } : {}),
      };

      const lines = [];
      // Captured job id from a dry-run / validate flow, surfaced to the client
      // in the final `result` message so the next click can do a true quick deploy.
      let capturedValidationJobId = null;
      const JOB_ID_PATTERN = /Validation Job ID:\s*([A-Za-z0-9]{15,18})/;
      const streamLines = (readable) => {
        const rl = createInterface({ input: readable, crlfDelay: Infinity });
        rl.on('line', (line) => {
          lines.push(line);
          const stripped = stripAnsi(line);
          if (!capturedValidationJobId) {
            const m = stripped.match(JOB_ID_PATTERN);
            if (m) capturedValidationJobId = m[1];
          }
          if (!res.writableEnded && !stripped.startsWith('SFDT_LOG:'))
            res.write('data: ' + JSON.stringify({ type: 'log', line: stripped, ts: new Date().toISOString() }) + '\n\n');
        });
        return rl;
      };

      if (!skipPreflight) {
        const preflightPath = path.join(SCRIPTS_DIR, 'ops', 'preflight.sh');
        const pfChild = execa('bash', [preflightPath], {
          env: { ...process.env, ...scriptEnv },
          cwd: projectRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const rlPOut = streamLines(pfChild.stdout);
        const rlPErr = streamLines(pfChild.stderr);
        let pfExitCode = 0;
        try { await pfChild; } catch (e) { pfExitCode = e.exitCode ?? 1; } finally { rlPOut.close(); rlPErr.close(); }
        if (pfExitCode !== 0) {
          if (!res.writableEnded) {
            res.write('data: ' + JSON.stringify({ type: 'result', exitCode: pfExitCode }) + '\n\n');
            res.end();
          }
          return;
        }
      }

      child = execa('bash', [scriptPath], {
        env: { ...process.env, ...scriptEnv },
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const rlOut = streamLines(child.stdout);
      const rlErr = streamLines(child.stderr);

      let exitCode = 0;
      try {
        await child;
      } catch (execErr) {
        exitCode = execErr.exitCode ?? 1;
      } finally {
        rlOut.close();
        rlErr.close();
      }

      // Append to deploy history
      const historyPath = path.join(logDir, 'deploy-history.json');
      const history = await fs.readJson(historyPath).catch(() => []);
      history.unshift({
        date: new Date().toISOString(),
        manifest: manifest ?? null,
        org: org ?? config.defaultOrg ?? null,
        dryRun,
        skipPreflight,
        exitCode,
      });
      await fs.outputJson(historyPath, history.slice(0, 100), { spaces: 2 });

      if (!res.writableEnded) {
        const resultMsg = { type: 'result', exitCode };
        if (capturedValidationJobId) resultMsg.content = { validationJobId: capturedValidationJobId };
        res.write('data: ' + JSON.stringify(resultMsg) + '\n\n');
        res.end();
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.write('data: ' + JSON.stringify({ type: 'error', message: err.message }) + '\n\n');
        res.end();
      }
    }
  });

  // ── Release Hub: deployment history ───────────────────────────────────────

  app.get('/api/deploy/history', apiLimiter, async (_req, res) => {
    try {
      const historyPath = path.join(logDir, 'deploy-history.json');
      const history = await fs.readJson(historyPath).catch(() => []);
      res.json({ history });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Release Hub: path helpers ─────────────────────────────────────────────

  // Reject anything that could introduce a path separator or `..` traversal
  // segment once interpolated into a file path. Package names are simple
  // identifiers; versions may contain dots (semver) but never `..`.
  const PKG_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
  const VERSION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  function assertSafePkgSegment(value, label) {
    if (typeof value !== 'string' || !PKG_SEGMENT_RE.test(value)) {
      const err = new Error(`Invalid ${label}: must match ${PKG_SEGMENT_RE}`);
      err.statusCode = 400;
      throw err;
    }
  }

  function assertSafeVersionSegment(value) {
    if (
      typeof value !== 'string' ||
      !VERSION_SEGMENT_RE.test(value) ||
      value.includes('..')
    ) {
      const err = new Error(`Invalid version: must match ${VERSION_SEGMENT_RE} and not contain '..'`);
      err.statusCode = 400;
      throw err;
    }
  }

  function resolveChangelogFilePath(projectRoot, pkgName) {
    if (!pkgName) return path.join(projectRoot, 'CHANGELOG.md');
    assertSafePkgSegment(pkgName, 'package name');
    const changelogDir = config.changelogDir ?? 'changelogs';
    return path.join(projectRoot, changelogDir, `${pkgName}.md`);
  }

  function resolveNotesFilePath(projectRoot, pkgTarget, version) {
    const releaseNotesDir = config.releaseNotesDir ?? 'release-notes';
    const layout = config.manifestLayout ?? 'flat';
    const ts = new Date().toISOString().split('T')[0];
    if (version) assertSafeVersionSegment(version);
    if (!pkgTarget || pkgTarget === 'all') {
      const name = version ? `rl-${version}-RELEASE-NOTES.md` : `release-notes-${ts}.md`;
      return path.join(projectRoot, releaseNotesDir, name);
    }
    assertSafePkgSegment(pkgTarget, 'package target');
    if (layout === 'subpath') {
      const name = version ? `rl-${version}-RELEASE-NOTES.md` : `release-notes-${ts}.md`;
      return path.join(projectRoot, releaseNotesDir, pkgTarget, name);
    }
    const name = version ? `rl-${version}-${pkgTarget}-RELEASE-NOTES.md` : `release-notes-${pkgTarget}-${ts}.md`;
    return path.join(projectRoot, releaseNotesDir, name);
  }

  // ── Release Hub: changelog content ────────────────────────────────────────

  app.get('/api/changelog/content', apiLimiter, async (req, res) => {
    try {
      const projectRoot = config._projectRoot ?? process.cwd();
      const pkgName = String(req.query.package ?? '').trim();
      const changelogPath = resolveChangelogFilePath(projectRoot, pkgName);
      if (!path.resolve(changelogPath).startsWith(path.resolve(projectRoot) + path.sep)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (!(await fs.pathExists(changelogPath))) {
        return res.json({ content: '', exists: false, file: path.relative(projectRoot, changelogPath) });
      }

      const raw = await fs.readFile(changelogPath, 'utf8');
      const match = raw.match(/## \[Unreleased\]([\s\S]*?)(?=\n## \[|$)/);
      const content = match ? match[1].trim() : '';
      res.json({ content, exists: true, file: path.relative(projectRoot, changelogPath) });
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  app.post('/api/changelog/save', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { content, package: pkgName } = req.body ?? {};
      if (content === undefined) return res.status(400).json({ error: 'content is required' });
      if (content.length > 1_000_000) return res.status(413).json({ error: 'Content too large (max 1 MB)' });

      const projectRoot = config._projectRoot ?? process.cwd();
      const changelogPath = resolveChangelogFilePath(projectRoot, pkgName || '');
      if (!path.resolve(changelogPath).startsWith(path.resolve(projectRoot) + path.sep)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      await fs.ensureDir(path.dirname(changelogPath));

      let fullContent = '';
      if (await fs.pathExists(changelogPath)) {
        fullContent = await fs.readFile(changelogPath, 'utf8');
      } else {
        fullContent = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n';
      }

      const unreleasedHeader = '## [Unreleased]';
      const hasUnreleased = fullContent.includes(unreleasedHeader);

      let updated;
      if (hasUnreleased) {
        updated = fullContent.replace(
          /## \[Unreleased\]([\s\S]*?)(?=\n## \[|$)/,
          `## [Unreleased]\n\n${content.trim()}\n`
        );
      } else {
        const firstHeaderMatch = fullContent.match(/^# .*\n/);
        if (firstHeaderMatch) {
          updated = fullContent.replace(firstHeaderMatch[0], `${firstHeaderMatch[0]}\n## [Unreleased]\n\n${content.trim()}\n`);
        } else {
          updated = `## [Unreleased]\n\n${content.trim()}\n\n${fullContent}`;
        }
      }

      await fs.writeFile(changelogPath, updated);
      res.json({ ok: true, file: path.relative(projectRoot, changelogPath) });
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  app.post('/api/release-notes/save', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { content, package: pkgTarget, version } = req.body ?? {};
      if (content === undefined) return res.status(400).json({ error: 'content is required' });
      if (content.length > 1_000_000) return res.status(413).json({ error: 'Content too large (max 1 MB)' });

      const projectRoot = config._projectRoot ?? process.cwd();
      const notesPath = resolveNotesFilePath(projectRoot, pkgTarget || '', version || '');
      if (!path.resolve(notesPath).startsWith(path.resolve(projectRoot) + path.sep)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      await fs.ensureDir(path.dirname(notesPath));

      if (await fs.pathExists(notesPath)) {
        return res.status(409).json({ error: `${path.basename(notesPath)} already exists. Delete it to overwrite.` });
      }
      await fs.writeFile(notesPath, content);
      res.json({ ok: true, path: path.relative(projectRoot, notesPath) });
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  // ── Release Hub: AI changelog generation (SSE) ────────────────────────────

  app.post('/api/changelog/generate', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (payload) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    try {
      const { isAiAvailable: checkAi, runAiPrompt: runAi } = await import('../ai.js');
      const available = await checkAi(config);
      if (!available) {
        send({ type: 'error', message: 'AI is not available or not configured.' });
        res.end();
        return;
      }

      const projectRoot = config._projectRoot ?? process.cwd();
      const pkgName = String(req.body?.package ?? '').trim();
      const pkg = pkgName ? (config.packageDirectories ?? []).find((p) => p.name === pkgName) : null;
      const limit = 20;
      const changelogTemplate = await getPrompt('changelog', config._configDir);
      const prompt = interpolate(changelogTemplate, {
        limit,
        ...(pkg ? { packagePath: pkg.path, packageName: pkg.name } : {}),
      });

      const scopeDesc = pkg ? ` for package "${pkg.name}"` : '';
      send({ type: 'log', line: `Analyzing recent commits${scopeDesc} with AI...`, ts: new Date().toISOString() });

      const result = await runAi(prompt, {
        config,
        allowedTools: ['Bash(git log:*)', 'Read'],
        cwd: projectRoot,
        aiEnabled: true,
      });

      if (result?.stdout) {
        for (const line of result.stdout.split('\n')) {
          send({ type: 'log', line: stripAnsi(line), ts: new Date().toISOString() });
        }
      }
      send({ type: 'result', exitCode: result?.exitCode ?? 0, content: result?.stdout ?? '' });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ── Release Hub: AI release notes generation (SSE) ────────────────────────

  app.post('/api/release-notes/generate', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (payload) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    try {
      const { isAiAvailable: checkAi, runAiPrompt: runAi } = await import('../ai.js');
      const available = await checkAi(config);
      if (!available) {
        send({ type: 'error', message: 'AI is not available or not configured.' });
        res.end();
        return;
      }

      const projectRoot = config._projectRoot ?? process.cwd();
      const { package: pkgName, version } = req.body ?? {};
      const pkg = pkgName ? (config.packageDirectories ?? []).find((p) => p.name === pkgName) : null;
      const releaseNotesTemplate = await getPrompt('release-notes', config._configDir);
      const prompt = interpolate(releaseNotesTemplate, {
        version: version || 'unreleased',
        outputPath: '(streaming output — do not write to file)',
        ...(pkg ? { packageName: pkg.name } : {}),
      });

      send({ type: 'log', line: 'Generating release notes with AI...', ts: new Date().toISOString() });

      const result = await runAi(prompt, {
        config,
        allowedTools: ['Bash(git log:*)', 'Bash(git diff:*)', 'Read'],
        cwd: projectRoot,
        aiEnabled: true,
      });

      if (result?.stdout) {
        for (const line of result.stdout.split('\n')) {
          send({ type: 'log', line: stripAnsi(line), ts: new Date().toISOString() });
        }
      }
      send({ type: 'result', exitCode: result?.exitCode ?? 0, content: result?.stdout ?? '' });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ── Release Hub: remove component from manifest ────────────────────────────

  app.post('/api/manifest/remove-component', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { relPath, type, member } = req.body ?? {};
      if (!relPath || !type || !member) {
        return res.status(400).json({ error: 'relPath, type, and member are required' });
      }
      if (path.isAbsolute(relPath) || relPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      if (typeof type !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(type)) {
        return res.status(400).json({ error: 'Invalid type' });
      }
      if (typeof member !== 'string' || !member.trim()) {
        return res.status(400).json({ error: 'Invalid member' });
      }

      const projectRoot = config._projectRoot ?? process.cwd();
      const absPath = path.resolve(projectRoot, relPath);
      if (!absPath.startsWith(projectRoot + path.sep) && absPath !== projectRoot) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const deployedDir = path.join(projectRoot, config.manifestDir ?? 'manifest/release', 'deployed');
      if (absPath.startsWith(deployedDir + path.sep) || absPath === deployedDir) {
        return res.status(403).json({ error: 'Deployed manifests are read-only' });
      }

      const xml = await fs.readFile(absPath, 'utf8');
      const updatedXml = removeComponentFromXml(xml, type, member);
      await fs.writeFile(absPath, updatedXml);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Discover local components by metadata type ────────────────────────────
  app.get('/api/manifest/discover', apiLimiter, async (req, res) => {
    try {
      const { type, exclude, package: pkg } = req.query;
      if (!type) return res.status(400).json({ error: 'type is required' });

      const projectRoot = config._projectRoot ?? process.cwd();
      let sourcePath = config.defaultSourcePath ?? 'force-app/main/default';
      if (pkg && pkg !== 'all') {
        const packages = config.packageDirectories ?? [];
        const matched = packages.find((p) => p.name === pkg);
        if (matched) sourcePath = matched.path;
      }
      const absSource   = path.join(projectRoot, sourcePath);
      const { glob }    = await import('glob');

      // Already-in-manifest members to exclude
      const excluded = new Set(exclude ? String(exclude).split(',') : []);

      // Type → glob pattern + name extractor
      const TYPE_MAP = {
        ApexClass:               { pat: '**/classes/*.cls',                              ext: (f) => path.basename(f, '.cls') },
        ApexTrigger:             { pat: '**/triggers/*.trigger',                          ext: (f) => path.basename(f, '.trigger') },
        ApexPage:                { pat: '**/pages/*.page',                                ext: (f) => path.basename(f, '.page') },
        ApexComponent:           { pat: '**/components/*.component',                      ext: (f) => path.basename(f, '.component') },
        LightningComponentBundle:{ pat: '**/lwc/*/',                                      ext: (f) => path.basename(f) },
        AuraDefinitionBundle:    { pat: '**/aura/*/',                                     ext: (f) => path.basename(f) },
        Flow:                    { pat: '**/flows/*.flow-meta.xml',                        ext: (f) => path.basename(f, '.flow-meta.xml') },
        FlowDefinition:          { pat: '**/flowDefinitions/*.flowDefinition-meta.xml',    ext: (f) => path.basename(f, '.flowDefinition-meta.xml') },
        CustomObject:            { pat: '**/objects/*/*.object-meta.xml',                  ext: (f) => path.basename(path.dirname(f)) },
        CustomField:             { pat: '**/objects/*/fields/*.field-meta.xml',            ext: (f) => `${path.basename(path.dirname(path.dirname(f)))}.${path.basename(f, '.field-meta.xml')}` },
        Layout:                  { pat: '**/layouts/*.layout-meta.xml',                    ext: (f) => path.basename(f, '.layout-meta.xml') },
        FlexiPage:               { pat: '**/flexipages/*.flexipage-meta.xml',              ext: (f) => path.basename(f, '.flexipage-meta.xml') },
        PermissionSet:           { pat: '**/permissionsets/*.permissionset-meta.xml',      ext: (f) => path.basename(f, '.permissionset-meta.xml') },
        PermissionSetGroup:      { pat: '**/permissionsetgroups/*.permissionsetgroup-meta.xml', ext: (f) => path.basename(f, '.permissionsetgroup-meta.xml') },
        Profile:                 { pat: '**/profiles/*.profile-meta.xml',                  ext: (f) => path.basename(f, '.profile-meta.xml') },
        StaticResource:          { pat: '**/staticresources/*.resource-meta.xml',          ext: (f) => path.basename(f, '.resource-meta.xml') },
        ContentAsset:            { pat: '**/contentassets/*.asset-meta.xml',               ext: (f) => path.basename(f, '.asset-meta.xml') },
        CustomMetadata:          { pat: '**/customMetadata/*.md-meta.xml',                 ext: (f) => path.basename(f, '.md-meta.xml') },
        CustomPermission:        { pat: '**/customPermissions/*.customPermission-meta.xml',ext: (f) => path.basename(f, '.customPermission-meta.xml') },
        CustomTab:               { pat: '**/tabs/*.tab-meta.xml',                          ext: (f) => path.basename(f, '.tab-meta.xml') },
        ValidationRule:          { pat: '**/objects/*/validationRules/*.validationRule-meta.xml', ext: (f) => `${path.basename(path.dirname(path.dirname(f)))}.${path.basename(f, '.validationRule-meta.xml')}` },
        EmailTemplate:           { pat: '**/email/**/*.email-meta.xml',                    ext: (f) => path.basename(f, '.email-meta.xml') },
        Report:                  { pat: '**/reports/**/*.report-meta.xml',                 ext: (f) => path.basename(f, '.report-meta.xml') },
        Dashboard:               { pat: '**/dashboards/**/*.dashboard-meta.xml',           ext: (f) => path.basename(f, '.dashboard-meta.xml') },
      };

      const mapping = TYPE_MAP[String(type)];
      if (!mapping) return res.json({ members: [] });

      if (!(await fs.pathExists(absSource))) return res.json({ members: [] });

      const files = await glob(mapping.pat, { cwd: absSource, nodir: !mapping.pat.endsWith('/') });
      const members = files
        .map(mapping.ext)
        .filter((m) => m && !excluded.has(m))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      res.json({ members: [...new Set(members)] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/manifest/add-component', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { relPath, type, member } = req.body ?? {};
      if (!relPath || !type || !member) {
        return res.status(400).json({ error: 'relPath, type, and member are required' });
      }
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(String(type))) {
        return res.status(400).json({ error: 'Invalid metadata type name' });
      }
      if (path.isAbsolute(relPath) || !/^[A-Za-z0-9_.\-/]+$/.test(relPath) || relPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      const projectRoot = config._projectRoot ?? process.cwd();
      const absPath = path.resolve(projectRoot, relPath);
      if (!absPath.startsWith(projectRoot + path.sep) && absPath !== projectRoot) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const deployedDir = path.join(projectRoot, config.manifestDir ?? 'manifest/release', 'deployed');
      if (absPath.startsWith(deployedDir + path.sep) || absPath === deployedDir) {
        return res.status(403).json({ error: 'Deployed manifests are read-only' });
      }

      const xml = await fs.readFile(absPath, 'utf8');
      const updatedXml = addComponentToXml(xml, type, member);
      await fs.writeFile(absPath, updatedXml);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/manifest/detect-tests', apiLimiter, async (req, res) => {
    try {
      const { path: relPath } = req.query;
      if (!relPath) return res.status(400).json({ error: 'path is required' });

      const projectRoot = config._projectRoot ?? process.cwd();
      const absPath = path.resolve(projectRoot, String(relPath));
      if (!absPath.startsWith(projectRoot + path.sep)) return res.status(403).json({ error: 'Forbidden' });

      if (!(await fs.pathExists(absPath))) return res.status(404).json({ error: 'Manifest not found' });

      const xml = await fs.readFile(absPath, 'utf8');

      // Ported logic from deployment-assistant.sh:
      // Extract <types> block where <name>ApexClass</name> exists
      const typeBlocks = xml.split(/<\/types>/);
      const apexClasses = [];

      for (const block of typeBlocks) {
        if (block.includes('<name>ApexClass</name>')) {
          const members = block.match(/<members>([^<]+)<\/members>/g) || [];
          for (const m of members) {
            const name = m.replace(/<\/?members>/g, '');
            // Filter for classes likely to be tests: ends with Test, _Test, Tests, or has Test followed by capital
            if (/(?:Test|_Test|Tests)$/i.test(name) || /Test[A-Z]/.test(name)) {
              apexClasses.push(name);
            }
          }
        }
      }

      res.json({ tests: apexClasses });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Release Hub: AI code review (SSE) ─────────────────────────────────────

  app.post('/api/review', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    const { base = 'main' } = req.body ?? {};
    if (!/^[A-Za-z0-9._/~^@:{}][A-Za-z0-9._/~^@:{}-]*$/.test(base)) {
      return res.status(400).json({ error: 'Invalid base ref' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (payload) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    try {
      const { isAiAvailable: checkAi, runAiPrompt: runAi } = await import('../ai.js');
      const available = await checkAi(config);
      if (!available) {
        send({ type: 'error', message: 'AI is not available or not configured.' });
        res.end();
        return;
      }

      const projectRoot = config._projectRoot ?? process.cwd();
      const {
        buildProjectContext, readLatestTestRuns, readLatestPreflight,
        buildContextBlock, formatTestRunsSection, formatPreflightSection,
        formatMetadataTypesSection,
      } = await import('../ai-context.js');
      const { parseDiffToMetadata } = await import('../metadata-mapper.js');

      const [diffResult, nameStatusResult] = await Promise.all([
        execa('git', ['diff', `${base}...HEAD`], { cwd: projectRoot, reject: false }),
        execa('git', ['diff', '--name-status', `${base}...HEAD`], { cwd: projectRoot, reject: false }),
      ]);
      const diff = diffResult.stdout || '';

      if (!diff.trim()) {
        send({ type: 'log', line: `No changes found between ${base} and HEAD.`, ts: new Date().toISOString() });
        send({ type: 'result', exitCode: 0, content: '' });
        res.end();
        return;
      }

      const [projectCtx, testRuns, preflight] = await Promise.all([
        buildProjectContext(config),
        readLatestTestRuns(config, 3),
        readLatestPreflight(config),
      ]);
      const metadataTypes = parseDiffToMetadata(nameStatusResult.stdout || '');
      const contextBlock = buildContextBlock([
        projectCtx,
        formatMetadataTypesSection(metadataTypes),
        formatTestRunsSection(testRuns),
        formatPreflightSection(preflight),
      ]);

      const reviewPrompt = await getPrompt('review', config._configDir);

      send({ type: 'log', line: `Reviewing ${diff.split('\n').length} lines of diff vs ${base}...`, ts: new Date().toISOString() });

      const prompt = contextBlock ? `${contextBlock}\n\n${reviewPrompt}${diff}` : reviewPrompt + diff;
      const result = await runAi(prompt, {
        config,
        allowedTools: ['Read', 'Grep'],
        cwd: projectRoot,
        aiEnabled: true,
      });

      if (result?.stdout) {
        for (const line of result.stdout.split('\n')) {
          send({ type: 'log', line: stripAnsi(line), ts: new Date().toISOString() });
        }
      }
      send({ type: 'result', exitCode: result?.exitCode ?? 0, content: result?.stdout ?? '' });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ── Release Hub: AI explain (SSE) ─────────────────────────────────────────

  app.post('/api/explain', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    const { logPath } = req.body ?? {};

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (payload) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    try {
      const { isAiAvailable: checkAi, runAiPrompt: runAi } = await import('../ai.js');
      const projectRoot = config._projectRoot ?? process.cwd();

      // Resolve log file
      let resolvedLogPath;
      if (logPath) {
        if (path.isAbsolute(logPath) || logPath.includes('..')) {
          send({ type: 'error', message: 'Invalid path' });
          res.end();
          return;
        }
        const abs = path.resolve(projectRoot, logPath);
        if (!abs.startsWith(projectRoot + path.sep) && abs !== projectRoot) {
          send({ type: 'error', message: 'Forbidden path' });
          res.end();
          return;
        }
        resolvedLogPath = abs;
      } else {
        // Find most recent .log file
        const { glob } = await import('glob');
        const candidates = await glob('**/*.log', { cwd: logDir, absolute: true });
        if (candidates.length === 0) {
          send({ type: 'error', message: 'No log files found in logs directory.' });
          res.end();
          return;
        }
        const statted = await Promise.all(candidates.map(async (p) => ({ path: p, mtime: (await fs.stat(p)).mtimeMs })));
        statted.sort((a, b) => b.mtime - a.mtime);
        resolvedLogPath = statted[0].path;
        send({ type: 'log', line: `Analyzing log: ${path.relative(projectRoot, resolvedLogPath)}`, ts: new Date().toISOString() });
      }

      const MAX_LOG_BYTES = 512 * 1024;
      let logContent = await fs.readFile(resolvedLogPath, 'utf8');
      if (logContent.length > MAX_LOG_BYTES) logContent = logContent.slice(-MAX_LOG_BYTES);

      const available = await checkAi(config);
      if (!available) {
        const { runHeuristicAnalysis } = await import('../explain-heuristics.js');
        const { markdown } = runHeuristicAnalysis(logContent);
        send({ type: 'log', line: 'AI not configured — running heuristic pattern scan.', ts: new Date().toISOString() });
        send({ type: 'result', exitCode: 0, content: markdown, source: 'heuristic' });
        res.end();
        return;
      }

      const {
        buildProjectContext, readLatestTestRuns, readLatestPreflight, readDeployHistory,
        buildContextBlock, formatTestRunsSection, formatPreflightSection, formatDeployHistorySection,
      } = await import('../ai-context.js');

      const [projectCtx, testRuns, preflight, deployHistory] = await Promise.all([
        buildProjectContext(config),
        readLatestTestRuns(config, 1),
        readLatestPreflight(config),
        readDeployHistory(config, 3),
      ]);
      const contextBlock = buildContextBlock([
        projectCtx,
        formatTestRunsSection(testRuns),
        formatPreflightSection(preflight),
        formatDeployHistorySection(deployHistory),
      ]);

      const explainPrompt = await getPrompt('explain', config._configDir);

      const prompt = contextBlock ? `${contextBlock}\n\n${explainPrompt}${logContent}` : explainPrompt + logContent;
      const result = await runAi(prompt, {
        config,
        allowedTools: ['Read', 'Grep'],
        cwd: projectRoot,
        aiEnabled: true,
      });

      if (result?.stdout) {
        for (const line of result.stdout.split('\n')) {
          send({ type: 'log', line: stripAnsi(line), ts: new Date().toISOString() });
        }
      }
      send({ type: 'result', exitCode: result?.exitCode ?? 0, content: result?.stdout ?? '', source: 'ai' });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ── Explain: list available log files ─────────────────────────────────────

  app.get('/api/logs/list', apiLimiter, async (_req, res) => {
    try {
      if (!(await fs.pathExists(logDir))) {
        return res.json({ files: [] });
      }
      const { glob } = await import('glob');
      // Root .log files + deploy/rollback .json archives
      const patterns = ['*.log', 'deploy-results/*.json', 'rollback-results/*.json'];
      const logFiles = await glob(patterns, { cwd: logDir });

      const statted = await Promise.all(
        logFiles.map(async (name) => ({
          name,
          mtime: (await fs.stat(path.join(logDir, name))).mtimeMs,
        }))
      );
      statted.sort((a, b) => b.mtime - a.mtime);
      const projectRoot = config._projectRoot ?? process.cwd();
      const logRelDir = path.relative(projectRoot, logDir);
      res.json({ files: statted.slice(0, 50).map((f) => path.join(logRelDir, f.name)) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Quality: AI fix plan (SSE) ────────────────────────────────────────────

  app.post('/api/quality/fix-plan', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (payload) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    try {
      const { isAiAvailable: checkAi, runAiPrompt: runAi } = await import('../ai.js');
      const available = await checkAi(config);
      if (!available) {
        send({ type: 'error', message: 'AI is not available or not configured.' });
        res.end();
        return;
      }

      const {
        buildProjectContext, readLatestTestRuns, readLatestPreflight,
        buildContextBlock, formatTestRunsSection, formatPreflightSection,
      } = await import('../ai-context.js');

      const qualityLog = await readLatestLog(logDir, 'quality');

      const [projectCtx, testRuns, preflight] = await Promise.all([
        buildProjectContext(config),
        readLatestTestRuns(config, 5),
        readLatestPreflight(config),
      ]);

      const qualitySection = qualityLog
        ? `## QUALITY ANALYSIS RESULTS\n${JSON.stringify(qualityLog?.data ?? qualityLog, null, 2)}`
        : '';

      const fixPlanPrompt = await getPrompt('quality-fix-plan', config._configDir);

      const prompt = buildContextBlock([
        projectCtx,
        formatTestRunsSection(testRuns),
        formatPreflightSection(preflight),
        qualitySection,
        fixPlanPrompt,
      ]).trimEnd();
      const projectRoot = config._projectRoot ?? process.cwd();

      send({ type: 'log', line: 'Building AI fix plan...', ts: new Date().toISOString() });

      const result = await runAi(prompt, {
        config,
        allowedTools: ['Read', 'Grep'],
        cwd: projectRoot,
        aiEnabled: true,
      });

      if (result?.stdout) {
        for (const line of result.stdout.split('\n')) {
          send({ type: 'log', line: stripAnsi(line), ts: new Date().toISOString() });
        }
      }
      send({ type: 'result', exitCode: result?.exitCode ?? 0, content: result?.stdout ?? '' });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ── AI chat (SSE) ─────────────────────────────────────────────────────────

  app.post('/api/ai/chat', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    const { messages, pageContext } = req.body ?? {};

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let aborted = false;
    let aiProc = null;
    req.on('close', () => { aborted = true; if (aiProc && !aiProc.killed) aiProc.kill(); });

    const send = (payload) => {
      if (!res.writableEnded && !aborted) res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    try {
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        send({ type: 'error', message: 'messages array is required' });
        res.end();
        return;
      }

      const messagesValid = messages.every(
        (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      );
      if (!messagesValid) {
        send({ type: 'error', message: 'Each message must have role (user|assistant) and string content' });
        res.end();
        return;
      }
      if (messages.length > 100) {
        send({ type: 'error', message: 'Conversation too long (max 100 messages)' });
        res.end();
        return;
      }
      const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
      if (totalChars > 200_000) {
        send({ type: 'error', message: 'Message content too large' });
        res.end();
        return;
      }

      const rawContext = pageContext?.data ? JSON.stringify(pageContext.data, null, 2) : 'No context provided';
      const contextStr = rawContext.length > 32768 ? rawContext.slice(0, 32768) + '\n...(truncated)' : rawContext;
      const safePage = String(pageContext?.page || 'Dashboard').slice(0, 64);

      let devOpsSection = '';
      if (config.mcp?.enabled) {
        try {
          if (!mcpClient) {
            const { SalesforceMcpClient } = await import('../mcp-client.js');
            mcpClient = new SalesforceMcpClient(config);
          }
          const devOpsContext = await mcpClient.getDevOpsCenterContext();
          if (devOpsContext) {
            const cap = (str) => (str.length > 4096 ? str.slice(0, 4096) + '\n...(truncated)' : str);
            if (devOpsContext.pipeline) {
              devOpsSection += `\n\n--- DEVOPS CENTER: PIPELINE STATUS ---\n${cap(JSON.stringify(devOpsContext.pipeline, null, 2))}`;
            }
            if (devOpsContext.workItems) {
              devOpsSection += `\n\n--- DEVOPS CENTER: WORK ITEMS ---\n${cap(JSON.stringify(devOpsContext.workItems, null, 2))}`;
            }
          }
        } catch {
          // MCP unavailable — continue without it
        }
      }

      const chatTemplate = await getPrompt('ai-chat', config._configDir);
      const systemPrompt = interpolate(chatTemplate, {
        projectName: config.projectName || 'Salesforce Project',
        defaultOrg: config.defaultOrg || 'not set',
        sourceApiVersion: config.sourceApiVersion || 'not set',
        safePage,
        contextStr,
      }) + devOpsSection;

      const { isAiAvailable, streamAiResponse } = await import('../ai.js');
      if (!(await isAiAvailable(config))) {
        send({ type: 'error', message: 'AI is not available or not configured.' });
        res.end();
        return;
      }

      await streamAiResponse(messages, systemPrompt, { config }, (text) => send({ type: 'chunk', text }), (proc) => { aiProc = proc; });
      send({ type: 'done' });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ── Prompt management ─────────────────────────────────────────────────────

  app.get('/api/prompts', apiLimiter, async (_req, res) => {
    try {
      const prompts = await getAllPrompts(config._configDir);
      res.json({ prompts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/prompts/:key', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { key } = req.params;
      const { value } = req.body ?? {};
      if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
      if (!config._configDir) return res.status(503).json({ error: 'Project not initialized' });
      await setPromptOverride(key, value, config._configDir);
      res.json({ ok: true, key });
    } catch (err) {
      res.status(err.message.startsWith('Unknown') ? 404 : 500).json({ error: err.message });
    }
  });

  app.delete('/api/prompts/:key', apiLimiter, async (req, res) => {
    if (!requireCsrfToken(req, res, csrfToken)) return;
    try {
      const { key } = req.params;
      if (!config._configDir) return res.status(503).json({ error: 'Project not initialized' });
      await resetPromptOverride(key, config._configDir);
      res.json({ ok: true, key });
    } catch (err) {
      res.status(err.message.startsWith('Unknown') ? 404 : 500).json({ error: err.message });
    }
  });

  // ── Dependencies: Tooling API graph ───────────────────────────────────────

  /** 5-minute in-memory cache keyed by `org|types` */
  const depCache = new Map();
  const DEP_CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Parse a package.xml string and return a Set of component names.
   * Includes all <members> values regardless of metadata type.
   */
  function parseManifestComponents(xml) {
    const members = new Set();
    const matches = xml.matchAll(/<members>([^<]+)<\/members>/g);
    for (const m of matches) {
      const name = m[1].trim();
      if (name && name !== '*') members.add(name);
    }
    return members;
  }

  /** Standard Salesforce types that are always present in an org — skip missing checks for these. */
  const STANDARD_REF_TYPES = new Set([
    'CustomObject', 'StandardEntity', 'CustomField', 'FlowDefinition',
    'StandardField', 'AuraDefinitionBundle', 'LightningComponentBundle',
  ]);

  app.get('/api/dependencies', apiLimiter, async (req, res) => {
    try {
      const { org, types = 'ApexClass,ApexTrigger,ApexComponent,Flow' } = req.query;
      if (!org || typeof org !== 'string' || !org.trim()) {
        return res.status(400).json({ error: 'org is required' });
      }
      // Sanitize: org aliases are alphanumeric + hyphens/underscores/dots only
      const safeOrg = String(org).trim();
      if (!/^[A-Za-z0-9_.\-@]+$/.test(safeOrg)) {
        return res.status(400).json({ error: 'Invalid org alias' });
      }

      const typeList = String(types)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .filter((t) => /^[A-Za-z][A-Za-z0-9]*$/.test(t)); // only valid SF type names
      if (!typeList.length) {
        return res.status(400).json({ error: 'types must contain at least one valid metadata type' });
      }

      const cacheKey = `${safeOrg}|${typeList.sort().join(',')}`;
      const cached = depCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < DEP_CACHE_TTL_MS) {
        return res.json(cached.data);
      }

      const inClause = typeList.map((t) => `'${t}'`).join(',');
      const soql = [
        'SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType,',
        'RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType',
        'FROM MetadataComponentDependency',
        `WHERE MetadataComponentType IN (${inClause})`,
      ].join(' ');

      let records = [];
      try {
        const result = await execa('sf', [
          'data', 'query',
          '--use-tooling-api',
          '--query', soql,
          '--json',
          '--target-org', safeOrg,
        ]);
        const parsed = JSON.parse(result.stdout);
        records = parsed?.result?.records ?? [];
      } catch (execErr) {
        // Extract error message from sf CLI JSON output when possible
        let errMsg = execErr.message ?? 'sf command failed';
        try {
          const errParsed = JSON.parse(execErr.stdout ?? execErr.stderr ?? '{}');
          errMsg = errParsed?.message ?? errParsed?.result?.message ?? errMsg;
        } catch { /* ignore */ }
        return res.status(500).json({ error: errMsg });
      }

      // Build graph — deduplicate nodes by id
      const nodesById = new Map();
      const edges = [];
      const edgeSet = new Set();

      for (const rec of records) {
        const srcId = rec.MetadataComponentId;
        const srcName = rec.MetadataComponentName;
        const srcType = rec.MetadataComponentType;
        const refId = rec.RefMetadataComponentId;
        const refName = rec.RefMetadataComponentName;
        const refType = rec.RefMetadataComponentType;

        if (srcId && !nodesById.has(srcId)) {
          nodesById.set(srcId, { id: srcId, name: srcName, type: srcType });
        }
        if (refId && !nodesById.has(refId)) {
          nodesById.set(refId, { id: refId, name: refName, type: refType });
        }
        if (srcId && refId) {
          const edgeKey = `${srcId}|${refId}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({ source: srcId, target: refId });
          }
        }
      }

      const nodes = [...nodesById.values()];
      const payload = {
        nodes,
        edges,
        cachedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edges.length,
      };

      depCache.set(cacheKey, { ts: Date.now(), data: payload });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/dependencies/preflight', apiLimiter, async (req, res) => {
    try {
      const { manifest: manifestParam, org } = req.query;
      if (!manifestParam || typeof manifestParam !== 'string' || !manifestParam.trim()) {
        return res.status(400).json({ error: 'manifest is required' });
      }
      if (!org || typeof org !== 'string' || !org.trim()) {
        return res.status(400).json({ error: 'org is required' });
      }

      // Validate org alias
      const safeOrg = String(org).trim();
      if (!/^[A-Za-z0-9_.\-@]+$/.test(safeOrg)) {
        return res.status(400).json({ error: 'Invalid org alias' });
      }

      // Only accept relative paths; validate character set before resolving
      const projectRoot = config._projectRoot ?? process.cwd();
      if (path.isAbsolute(manifestParam) || !/^[A-Za-z0-9_.\-/]+$/.test(manifestParam) || manifestParam.includes('..')) {
        return res.status(400).json({ error: 'Invalid manifest path' });
      }
      const absManifest = path.resolve(projectRoot, manifestParam);
      if (!absManifest.startsWith(projectRoot + path.sep)) {
        return res.status(403).json({ error: 'Forbidden: manifest path outside project root' });
      }
      if (!(await fs.pathExists(absManifest))) {
        return res.status(404).json({ error: 'Manifest file not found' });
      }

      const xml = await fs.readFile(absManifest, 'utf8');
      const manifestComponents = parseManifestComponents(xml);

      if (!manifestComponents.size) {
        return res.json({ status: 'pass', missing: [], warnings: [] });
      }

      // Build SOQL scoped to the manifest's component names
      const nameList = [...manifestComponents].map((n) => `'${n.replace(/'/g, "''")}'`).join(',');

      // Guard against MALFORMED_QUERY: SOQL IN clause has a character limit
      if (nameList.length > 15000) {
        return res.status(200).json({
          status: 'warn',
          missing: [],
          warnings: [{ name: 'MANIFEST_TOO_LARGE', type: 'system', referencedBy: [`Manifest has ${manifestComponents.size} components; dependency check limited to first batch`] }],
        });
      }

      const soql = [
        'SELECT MetadataComponentName, MetadataComponentType,',
        'RefMetadataComponentName, RefMetadataComponentType',
        'FROM MetadataComponentDependency',
        `WHERE MetadataComponentName IN (${nameList})`,
      ].join(' ');

      let records = [];
      try {
        const result = await execa('sf', [
          'data', 'query',
          '--use-tooling-api',
          '--query', soql,
          '--json',
          '--target-org', safeOrg,
        ]);
        const parsed = JSON.parse(result.stdout);
        records = parsed?.result?.records ?? [];
      } catch (execErr) {
        let errMsg = execErr.message ?? 'sf command failed';
        try {
          const errParsed = JSON.parse(execErr.stdout ?? execErr.stderr ?? '{}');
          errMsg = errParsed?.message ?? errParsed?.result?.message ?? errMsg;
        } catch { /* ignore */ }
        return res.status(500).json({ error: errMsg });
      }

      // For each dependency: if RefMetadataComponentName is not in the manifest,
      // categorize as either warning (standard type) or missing (custom/unknown type).
      const missingMap = new Map(); // key: `type:name`, value: { name, type, referencedBy: [] }
      const warningsMap = new Map(); // key: `type:name`, value: { name, type, referencedBy: [] }

      for (const rec of records) {
        const refName = rec.RefMetadataComponentName;
        const refType = rec.RefMetadataComponentType;
        const srcName = rec.MetadataComponentName;

        if (!refName) continue;
        if (manifestComponents.has(refName)) continue; // deployed together — OK

        const key = `${refType}:${refName}`;
        const targetMap = STANDARD_REF_TYPES.has(refType) ? warningsMap : missingMap;

        if (!targetMap.has(key)) {
          targetMap.set(key, { name: refName, type: refType, referencedBy: [] });
        }
        const entry = targetMap.get(key);
        if (srcName && !entry.referencedBy.includes(srcName)) {
          entry.referencedBy.push(srcName);
        }
      }

      const missing = [...missingMap.values()];
      const warnings = [...warningsMap.values()];
      let status = 'pass';
      if (missing.length > 0) {
        status = 'fail';
      } else if (warnings.length > 0) {
        status = 'warn';
      }

      res.json({ status, missing, warnings });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI availability ────────────────────────────────────────────────────────

  app.get('/api/ai/available', apiLimiter, async (_req, res) => {
    try {
      const { isAiAvailable } = await import('../ai.js');
      const available = await isAiAvailable(config);
      res.json({ available, enabled: !!config.features?.ai, provider: config.ai?.provider ?? null });
    } catch {
      res.json({ available: false, enabled: false, provider: null });
    }
  });

  // ── Static: serve pre-built React app ──────────────────────────────────────

  if (fs.existsSync(GUI_DIST)) {
    app.use(express.static(GUI_DIST)); // codeql[js/missing-rate-limiting] - localhost-only dev server; static asset delivery does not require rate limiting

    // SPA fallback — all non-API routes return index.html
    app.use(apiLimiter, (_req, res) => {
      res.sendFile(path.join(GUI_DIST, 'index.html'));
    });
  } else {
    // GUI not built yet — serve a helpful plain-HTML placeholder
    app.get('/', (_req, res) => {
      res.send(buildPlaceholderHtml(version));
    });
  }

  app.cleanup = async () => {
    if (mcpClient) {
      await mcpClient.disconnect();
      mcpClient = null;
    }
  };

  return app;
}

/**
 * Start the GUI server.
 *
 * @param {number} port
 * @param {object} config
 * @param {string} version
 * @returns {Promise<import('http').Server>}
 */
export async function startGuiServer(port, config, version) {
  const app = createGuiApp(config, version, port);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      server.cleanup = app.cleanup;
      resolve(server);
    });
    server.once('error', reject);
  });
}

