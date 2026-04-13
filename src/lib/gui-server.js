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
import { loadConfig } from './config.js';

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

  app.get('/api/test-runs', async (_req, res) => {
    try {
      const runs = await readTestRuns(logDir);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/preflight', async (_req, res) => {
    try {
      const data = await readPreflight(logDir);
      res.json(data ?? {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/drift', async (_req, res) => {
    try {
      const data = await readDrift(logDir);
      res.json(data ?? {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Static: serve pre-built React app ──────────────────────────────────────

  if (fs.existsSync(GUI_DIST)) {
    app.use(express.static(GUI_DIST));

    // SPA fallback — all non-API routes return index.html
    app.get('*', (_req, res) => {
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
