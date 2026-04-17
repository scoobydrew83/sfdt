/**
 * SFDT GUI Server
 *
 * Lightweight Express server that:
 *  - Serves the pre-built React/SLDS dashboard from gui/dist/
 *  - Exposes REST API endpoints that read sfdt config and log files
 */

import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// gui/dist lives at <package-root>/gui/dist
const GUI_DIST = path.resolve(__dirname, '..', '..', 'gui', 'dist');

// ─── Log parsers ─────────────────────────────────────────────────────────────

/**
 * Attempt to parse a JSON file; return null on any error.
 */
async function tryReadJson(filePath) {
  try {
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}

/**
 * Scan the test-results directory for sfdt result files.
 * Returns an array of run objects: { date, passed, failed, errors, coverage, duration }.
 */
async function readTestRuns(logDir) {
  const resultsDir = path.join(logDir, 'test-results');
  if (!(await fs.pathExists(resultsDir))) return [];

  let entries;
  try {
    entries = await fs.readdir(resultsDir);
  } catch {
    return [];
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse(); // newest first

  const runs = [];

  for (const file of jsonFiles) {
    const raw = await tryReadJson(path.join(resultsDir, file));
    if (!raw) continue;

    // Handle sf apex test run JSON output format
    if (raw.result) {
      const r = raw.result;
      runs.push({
        date: r.summary?.testStartTime ?? raw.timestamp ?? file,
        passed: r.summary?.passing ?? 0,
        failed: r.summary?.failing ?? 0,
        errors: r.summary?.skipped ?? 0,
        coverage: r.summary?.testRunCoverage
          ? parseFloat(r.summary.testRunCoverage)
          : undefined,
        duration: r.summary?.testExecutionTimeInMs ?? undefined,
      });
    } else if (raw.summary) {
      // Direct summary object
      runs.push({
        date: raw.summary.testStartTime ?? raw.timestamp ?? file,
        passed: raw.summary.passing ?? 0,
        failed: raw.summary.failing ?? 0,
        errors: raw.summary.skipped ?? 0,
        coverage: raw.summary.testRunCoverage
          ? parseFloat(raw.summary.testRunCoverage)
          : undefined,
        duration: raw.summary.testExecutionTimeInMs ?? undefined,
      });
    } else if (Array.isArray(raw)) {
      // Array of test results (simple format)
      const passed = raw.filter((t) => t.outcome === 'Pass').length;
      const failed = raw.filter((t) => t.outcome === 'Fail').length;
      runs.push({
        date: raw[0]?.testTimestamp ?? file,
        passed,
        failed,
        errors: 0,
      });
    }
  }

  return runs;
}

/**
 * Read the most recent preflight log.
 * Returns { date, status, checks: [{name, status, message}] } or null.
 */
async function readPreflight(logDir) {
  const preflightFile = path.join(logDir, 'preflight-latest.json');
  const data = await tryReadJson(preflightFile);
  if (data) return data;

  // Fallback: look for preflight_*.json
  const files = await safeReaddir(logDir);
  const preflightFiles = files
    .filter((f) => f.startsWith('preflight_') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (!preflightFiles.length) return null;
  return tryReadJson(path.join(logDir, preflightFiles[0]));
}

/**
 * Read the most recent drift log.
 * Returns { date, result, count, components: [{name, type, drift}] } or null.
 */
async function readDrift(logDir) {
  const driftFile = path.join(logDir, 'drift-latest.json');
  const data = await tryReadJson(driftFile);
  if (data) return data;

  const files = await safeReaddir(logDir);
  const driftFiles = files
    .filter((f) => f.startsWith('drift_') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (!driftFiles.length) return null;
  return tryReadJson(path.join(logDir, driftFiles[0]));
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Read the most recent compare result.
 * Returns { date, source, target, items: [{type, member, status}] } or null.
 */
async function readCompare(logDir) {
  return tryReadJson(path.join(logDir, 'compare-latest.json'));
}

/**
 * Run sf project retrieve for a single metadata component into a temp dir.
 * Returns the XML file contents or null on failure.
 */
async function retrieveComponentXml(orgAlias, type, member, tmpDir) {
  if (!orgAlias) return null;
  const { execa } = await import('execa');
  const outputDir = path.join(tmpDir, orgAlias.replace(/[^a-z0-9]/gi, '_'));
  try {
    await execa('sf', [
      'project',
      'retrieve',
      'start',
      '--metadata',
      `${type}:${member}`,
      '--target-org',
      orgAlias,
      '--output-dir',
      outputDir,
      '--json',
    ]);
    const { glob } = await import('glob');
    const files = await glob('**/*.xml', { cwd: outputDir, absolute: true });
    if (!files.length) return null;
    const fsExtra = (await import('fs-extra')).default;
    return fsExtra.readFile(files[0], 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read a metadata component's XML from the local source directory.
 */
async function readLocalComponentXml(config, type, member) {
  const { glob } = await import('glob');
  const fsExtra = (await import('fs-extra')).default;
  const sourcePath = config.defaultSourcePath ?? 'force-app/main/default';
  const root = config._projectRoot ?? process.cwd();
  const files = await glob(`**/${member}*`, {
    cwd: path.join(root, sourcePath),
    absolute: true,
    nodir: true,
  });
  const xmlFile = files.find((f) => f.endsWith('.xml') || f.endsWith('.cls') || f.endsWith('.trigger'));
  if (!xmlFile) return null;
  return fsExtra.readFile(xmlFile, 'utf8');
}

// ─── Command runner config ────────────────────────────────────────────────────

const COMMANDS = {
  preflight: {
    script: 'scripts/new/preflight.sh',
    logFile: 'logs/preflight-latest.json',
  },
  drift: {
    script: 'scripts/new/drift.sh',
    logFile: 'logs/drift-latest.json',
  },
  test: {
    script: 'scripts/new/smoke.sh',
    logFile: 'logs/test-results/latest.json',
  },
};

// ─── Rate limiter ─────────────────────────────────────────────────────────────

/**
 * Minimal in-process rate limiter — no external deps required.
 * Limits requests to maxRequests per windowMs across all local clients.
 */
function createRateLimiter(maxRequests = 60, windowMs = 60_000) {
  const timestamps = [];
  return (_req, res, next) => {
    const now = Date.now();
    const cutoff = now - windowMs;
    while (timestamps.length && timestamps[0] < cutoff) timestamps.shift();
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    timestamps.push(now);
    next();
  };
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and configure the Express app.
 *
 * @param {object} config  - Loaded sfdt config
 * @param {string} version - CLI version string
 * @returns {import('express').Application}
 */
export function createGuiApp(config, version) {
  const app = express();
  app.use(express.json());

  const logDir =
    config.logDir ||
    path.join(config._projectRoot || process.cwd(), 'logs');

  const apiLimiter = createRateLimiter(60, 60_000);

  // ── API routes ──────────────────────────────────────────────────────────────

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/project', (_req, res) => {
    res.json({
      name: config.projectName || 'Salesforce Project',
      org: config.defaultOrg || null,
      apiVersion: config.sourceApiVersion || null,
      coverageThreshold: config.deployment?.coverageThreshold ?? 75,
      features: config.features || {},
      version,
    });
  });

  app.get('/api/test-runs', apiLimiter, async (_req, res) => {
    try {
      const runs = await readTestRuns(logDir);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/preflight', apiLimiter, async (_req, res) => {
    try {
      const data = await readPreflight(logDir);
      res.json(data ?? {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/drift', apiLimiter, async (_req, res) => {
    try {
      const data = await readDrift(logDir);
      res.json(data ?? {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Generic command runner (SSE) ───────────────────────────────────────────

  app.get('/api/command/run', async (req, res) => {
    const { command } = req.query;
    const cmd = COMMANDS[command];
    if (!cmd) {
      return res.status(400).json({ error: 'Unknown command' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let child;

    req.on('close', () => {
      if (child && !child.killed) child.kill();
    });

    try {
      const { execa } = await import('execa');
      const { createInterface } = await import('readline');

      const projectRoot = config._projectRoot ?? process.cwd();
      const scriptPath = path.join(projectRoot, cmd.script);

      const scriptEnv = {
        SFDT_PROJECT_ROOT: projectRoot,
        SFDT_CONFIG_DIR: config._configDir ?? path.join(projectRoot, '.sfdt'),
        SFDT_DEFAULT_ORG: config.defaultOrg ?? '',
        SFDT_SOURCE_PATH: config.defaultSourcePath ?? 'force-app/main/default',
        SFDT_API_VERSION: config.sourceApiVersion ?? '',
        SFDT_NON_INTERACTIVE: 'true',
      };

      child = execa(scriptPath, [], {
        env: { ...process.env, ...scriptEnv },
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        shell: true,
      });

      const lines = [];

      const streamLines = (readable) => {
        const rl = createInterface({ input: readable, crlfDelay: Infinity });
        rl.on('line', (line) => {
          lines.push(line);
          if (!res.writableEnded) {
            res.write('data: ' + JSON.stringify({ type: 'log', line, ts: new Date().toISOString() }) + '\n\n');
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

      const logPayload = { date: new Date().toISOString(), command, exitCode, lines };
      const logFilePath = path.join(projectRoot, cmd.logFile);
      await fs.outputJson(logFilePath, logPayload, { spaces: 2 });

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

      const configOrgs = Object.keys(config.environments?.orgs ?? {}).map((alias) => ({
        alias,
        username: config.environments.orgs[alias],
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
      res.json(data ?? {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compare', apiLimiter, async (req, res) => {
    try {
      const { source = 'local', target } = req.body ?? {};
      if (!target) return res.status(400).json({ error: 'target is required' });

      const { fetchInventory } = await import('./org-inventory.js');
      const { diffInventories } = await import('./org-diff.js');

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

  app.get('/api/compare/stream', async (req, res) => {
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
    let tmpDir = path.join(os.tmpdir(), `sfdt-compare-${Date.now()}`);

    try {
      const bothItems = data.items.filter((i) => i.status === 'both');
      let completed = 0;

      const sendEvent = (payload) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      sendEvent({ type: 'progress', total: bothItems.length, completed: 0 });

      for (const item of bothItems) {
        if (clientClosed || res.destroyed) break;

        const [sourceXml, targetXml] = await Promise.all([
          data.source === 'local'
            ? readLocalComponentXml(config, item.type, item.member)
            : retrieveComponentXml(data.source, item.type, item.member, tmpDir),
          retrieveComponentXml(data.target, item.type, item.member, tmpDir),
        ]);

        const status =
          sourceXml && targetXml && sourceXml.trim() === targetXml.trim()
            ? 'identical'
            : 'modified';

        sendEvent({ type: 'diff', itemType: item.type, member: item.member, status });
        completed++;
        sendEvent({ type: 'progress', total: bothItems.length, completed });
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

  app.post('/api/compare/manifest', apiLimiter, async (req, res) => {
    try {
      const { items = [], apiVersion } = req.body ?? {};
      const { renderPackageXml } = await import('./metadata-mapper.js');

      const metaMap = {};
      for (const { type, member } of items) {
        if (!metaMap[type]) metaMap[type] = [];
        metaMap[type].push(member);
      }

      const resolvedVersion = apiVersion ?? config.sourceApiVersion ?? '63.0';
      const xml = renderPackageXml(metaMap, resolvedVersion);

      const fsExtra = (await import('fs-extra')).default;
      await fsExtra.outputFile(path.join(logDir, 'compare-manifest.xml'), xml);

      res.json({ xml });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compare/diff', apiLimiter, async (req, res) => {
    try {
      const { type, member } = req.query;
      if (!type || !member) return res.status(400).json({ error: 'type and member are required' });

      const data = await readCompare(logDir);
      if (!data) return res.status(404).json({ error: 'No comparison result found.' });

      const os = await import('os');
      const tmpDir = path.join(os.tmpdir(), `sfdt-diff-${Date.now()}`);

      const [sourceXml, targetXml] = await Promise.all([
        data.source === 'local'
          ? readLocalComponentXml(config, type, member)
          : retrieveComponentXml(data.source, type, member, tmpDir),
        retrieveComponentXml(data.target, type, member, tmpDir),
      ]);

      res.json({ sourceXml: sourceXml ?? '', targetXml: targetXml ?? '' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Static: serve pre-built React app ──────────────────────────────────────

  if (fs.existsSync(GUI_DIST)) {
    app.use(express.static(GUI_DIST));

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
  const app = createGuiApp(config, version);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

// ─── Placeholder HTML (when gui/dist hasn't been built yet) ──────────────────

function buildPlaceholderHtml(version) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>SFDT Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#f3f3f3;display:flex;align-items:center;
         justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:8px;padding:40px 48px;
          max-width:500px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,.1);
          border-top:4px solid #0176d3}
    h1{font-size:22px;color:#032d60;margin-bottom:8px}
    p{color:#706e6b;font-size:14px;line-height:1.6;margin-bottom:16px}
    code{background:#f3f3f3;padding:2px 6px;border-radius:4px;
         font-family:monospace;font-size:13px;color:#032d60}
    pre{background:#032d60;color:#fff;padding:16px 20px;border-radius:6px;
        font-size:13px;overflow-x:auto;margin-bottom:16px}
    .version{color:#919191;font-size:12px;margin-top:24px}
  </style>
</head>
<body>
  <div class="card">
    <h1>SFDT Dashboard — Build Required</h1>
    <p>The GUI hasn't been compiled yet. Run these commands from the
       <code>sfdt</code> package root to build it:</p>
    <pre>cd gui
npm install
npm run build</pre>
    <p>Or use the convenience script from the package root:</p>
    <pre>npm run build:gui</pre>
    <p>Then restart <code>sfdt ui</code> and refresh this page.</p>
    <p class="version">sfdt v${version}</p>
  </div>
</body>
</html>`;
}
