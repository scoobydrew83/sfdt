/**
 * Bridge HTTP routes.
 *
 * Mounted under `/api/bridge/` by the gui server.
 *
 *  - GET  /api/bridge/ping       — CORS only. Discovery probe used by the
 *                                  extension to detect whether sfdt ui is
 *                                  running on localhost.
 *  - POST /api/bridge/exchange   — CORS + bearer token. The general-purpose
 *                                  request router driven by the
 *                                  @sfdt/flow-core SfdtRequest discriminated
 *                                  union.
 *
 * Each request envelope carries a `requestId`; the response echoes it back
 * so the extension can pair concurrent calls. The contract validator from
 * @sfdt/flow-core rejects malformed payloads before they reach a handler.
 */

import path from 'node:path';
import { createBridgeAuthMiddleware, createBridgeCorsMiddleware } from './middleware.js';
import { readDisabledFeatures } from './feature-flags.js';

// Hard cap on `quality.flowXml` payloads. Salesforce Flow JSON is typically
// tens of KB; the largest realistic flow we've measured is ~800 KB. 5 MB is a
// safe ceiling that still prevents memory-exhaustion via crafted JSON before
// JSON.parse runs.
const MAX_FLOW_XML_BYTES = 5 * 1024 * 1024;

// Lazy imports are used throughout this file (flow-core's bridge contract,
// flow-quality, flow-deploy-runner, flow-rollback-runner). Two reasons:
//
//  1. flow-core ships as a separate npm package whose `dist/` is produced by
//     a TypeScript build. `sfdt ui` must boot even before
//     `npm run build:flow-core` has run — eager static imports would crash
//     the server at module-load time.
//  2. The runners (flow-deploy-runner, flow-rollback-runner) spawn `sf`
//     subprocesses on demand. Static-importing them eagerly would defeat
//     code-splitting and force every dashboard cold-start to read modules
//     it may never use this session.
//
// The first call to each path pays a one-time import cost (cached via
// require/import's own module cache); subsequent calls are free.
let _contract = null;
async function loadContract() {
  if (_contract) return _contract;
  _contract = await import('@sfdt/flow-core/bridge-contract');
  return _contract;
}

/**
 * Resolve the project root that the bridge should read/write files against.
 * Prefers an explicit projectRoot from caller; falls back to deriving it
 * from configDir (one level up from `.sfdt/`). process.cwd() is intentionally
 * NOT consulted — the bridge runs inside `sfdt ui` whose working directory
 * may not be the project (per CLAUDE.md CRITICAL RULE).
 */
function resolveProjectRoot({ projectRoot, configDir }) {
  if (projectRoot) return projectRoot;
  if (configDir) return path.dirname(configDir);
  return null;
}

/**
 * Mount bridge routes onto the Express app.
 *
 * @param {import('express').Application} app
 * @param {object} opts
 * @param {number} opts.port              - The port the gui server is on.
 * @param {string} opts.version           - sfdt CLI version string.
 * @param {string} [opts.projectRoot]     - Absolute path to the user's
 *   Salesforce project. The bridge reads .sfdt/feature-flags.json and writes
 *   .sfdt/telemetry-snapshot.json against this root. If omitted, derived from
 *   `configDir`.
 * @param {string} [opts.configDir]       - Absolute path to the project's
 *   `.sfdt/` directory. Used as the fallback source for projectRoot.
 * @param {import('express').RequestHandler} [opts.rateLimiter]
 *   Optional rate limiter (uses gui-server's apiLimiter when supplied).
 */
export function mountBridgeRoutes(app, { port, version, config, projectRoot, configDir, logDir, rateLimiter }) {
  const cors = createBridgeCorsMiddleware(port);
  const auth = createBridgeAuthMiddleware();
  const limiter = rateLimiter ?? ((_req, _res, next) => next());
  const resolvedProjectRoot = resolveProjectRoot({ projectRoot, configDir });
  // Where the CLI writes audit/monitor snapshots; mirrors gui-server so a custom
  // config.logDir is honoured instead of always reading <projectRoot>/logs.
  const resolvedLogDir = logDir || (resolvedProjectRoot ? path.join(resolvedProjectRoot, 'logs') : null);

  // Mount CORS as a path-prefix middleware so it runs on every HTTP method —
  // including OPTIONS preflights — for any /api/bridge/* path. The middleware
  // short-circuits OPTIONS with 204 before falling through to the route
  // handlers. Doing it this way avoids Express 5's wildcard-route restrictions.
  app.use('/api/bridge', cors);

  // Discovery probe — no auth required so the extension can detect whether
  // localhost is reachable without prompting the user for a token first.
  //
  // Security model: this endpoint deliberately exposes serverVersion,
  // protocolVersion, and the disabledFeatures kill-switch list to any
  // process able to reach localhost:7654. None of these are secrets, but on
  // a shared/containerised dev host other local users could enumerate them
  // (the bind is per-user but the loopback is shared). The bearer token —
  // the authoritative gate on mutating bridge calls — is NEVER exposed here.
  app.get('/api/bridge/ping', limiter, async (_req, res) => {
    let disabledFeatures = [];
    if (resolvedProjectRoot) {
      try {
        disabledFeatures = await readDisabledFeatures(resolvedProjectRoot);
      } catch {
        // readDisabledFeatures already handles known I/O / parse errors;
        // the try here is defensive against unforeseen throws so the ping
        // response always lands.
      }
    }
    const { PROTOCOL_VERSION } = await loadContract();
    res.json({
      ok: true,
      data: {
        pong: true,
        serverVersion: version,
        protocolVersion: PROTOCOL_VERSION,
        transport: 'localhost',
        disabledFeatures,
      },
    });
  });

  // General exchange endpoint. The body must be a valid SfdtRequest.
  app.post('/api/bridge/exchange', limiter, auth, async (req, res) => {
    const { validateSfdtRequest, makeErrorResponse, makeSuccessResponse } = await loadContract();

    const validation = validateSfdtRequest(req.body);
    if (!validation.ok) {
      const requestId =
        typeof req.body?.requestId === 'string' ? req.body.requestId : 'unknown';
      return res.status(400).json({
        ...makeErrorResponse(
          requestId,
          'Invalid request: ' + validation.errors.map((e) => `${e.field} ${e.reason}`).join('; '),
          'REQUEST_INVALID',
        ),
      });
    }

    const { request } = validation;
    try {
      const response = await dispatch(request, {
        version,
        config,
        projectRoot: resolvedProjectRoot,
        logDir: resolvedLogDir,
        makeSuccessResponse,
        makeErrorResponse,
      });
      return res.json(response);
    } catch (err) {
      return res.status(500).json(makeErrorResponse(request.requestId, err.message, 'INTERNAL_ERROR'));
    }
  });
}

/**
 * Dispatch a validated SfdtRequest to the correct handler.
 *
 * All contract kinds are now handled: ping/version inline; quality/deploy/
 * rollback/ai/scan/compare/drift/org-health/telemetry.snapshot via their
 * handlers (each keeps its own fetch/runner). Unknown kinds are rejected by
 * the contract validator before reaching here.
 */
async function dispatch(request, { version, config, projectRoot, logDir, makeSuccessResponse, makeErrorResponse }) {
  switch (request.kind) {
    case 'ping': {
      let disabledFeatures = [];
      if (projectRoot) {
        try {
          disabledFeatures = await readDisabledFeatures(projectRoot);
        } catch {
          // Defensive — readDisabledFeatures already swallows known errors.
        }
      }
      const { PROTOCOL_VERSION } = await loadContract();
      return makeSuccessResponse(request.requestId, {
        pong: true,
        serverVersion: version,
        protocolVersion: PROTOCOL_VERSION,
        transport: 'localhost',
        disabledFeatures,
      });
    }
    case 'version':
      return makeSuccessResponse(request.requestId, { version });
    case 'quality': {
      // Phase 5: bridge wires `quality` through to flow-core. The contract's
      // `flowXml` field is named for the eventual XML-file path; for now we
      // accept JSON-stringified Tooling API Metadata so the Chrome extension
      // and the CLI dashboard share this path. Full XML parsing lands in
      // Phase 7's distribution work.
      //
      // Size-cap the payload BEFORE JSON.parse so a multi-GB string from a
      // misbehaving caller can't exhaust memory. Measure in UTF-8 BYTES
      // (Buffer.byteLength) rather than String.length, which returns UTF-16
      // code units — a payload of mostly multibyte characters could otherwise
      // be up to 3× larger than length suggests. Flow XML is ASCII-heavy in
      // practice so the gap rarely bites, but the comment promised "before
      // JSON.parse a multi-GB string", and that promise needs byte
      // accuracy. Pairs with the per-route 6 MB express.json limit applied
      // in gui-server/index.js (defence in depth: parser rejects oversized
      // bodies first; this catches anything that slips past a reconfigured
      // limit or a non-HTTP entrypoint).
      if (
        typeof request.flowXml === 'string' &&
        Buffer.byteLength(request.flowXml, 'utf8') > MAX_FLOW_XML_BYTES
      ) {
        return makeErrorResponse(
          request.requestId,
          `quality.flowXml exceeds the ${MAX_FLOW_XML_BYTES}-byte limit`,
          'REQUEST_INVALID',
        );
      }
      const { runFlowQuality } = await import('../flow-quality.js');
      let metadata;
      try {
        metadata = JSON.parse(request.flowXml);
      } catch (err) {
        return makeErrorResponse(
          request.requestId,
          `quality request body must be JSON-stringified Flow.Metadata. Parse error: ${err.message}`,
          'REQUEST_INVALID',
        );
      }
      const report = runFlowQuality(metadata);
      return makeSuccessResponse(request.requestId, {
        overallScore: report.summary.overallScore,
        rating: report.summary.rating,
        severityCounts: report.summary.severityCounts,
        categoryCounts: report.summary.categoryCounts,
        issueFamilyCount: report.issueFamilies.length,
      });
    }
    case 'deploy': {
      // Spawns `sf project deploy start --metadata Flow:<name>`. The
      // extension's flow-deploy feature is expected to send `flowApiName`
      // (the Flow's developer name) rather than the URL's `flowId`, which
      // can be a Salesforce Id or a managed-package path neither of which
      // is the right metadata identifier for deploy.
      const { runFlowDeploy } = await import('../flow-deploy-runner.js');
      const flowApiName = request.flowApiName ?? request.flowId;
      const result = await runFlowDeploy({
        flowApiName,
        ...(request.targetOrg !== undefined ? { targetOrg: request.targetOrg } : {}),
        ...(request.validateOnly !== undefined ? { validateOnly: request.validateOnly } : {}),
      });
      return result.ok
        ? makeSuccessResponse(request.requestId, result.data)
        : makeErrorResponse(request.requestId, result.error, result.code ?? 'INTERNAL_ERROR');
    }
    case 'rollback': {
      // Salesforce activates / deactivates / rolls back via Tooling-API
      // PATCH on FlowDefinition.Metadata.activeVersionNumber. toVersion=0
      // is the documented way to deactivate. Like deploy, the canonical
      // identifier is flowApiName; flowId stays as a legacy fallback.
      const { runFlowRollback } = await import('../flow-rollback-runner.js');
      const flowApiName = request.flowApiName ?? request.flowId;
      const result = await runFlowRollback({
        flowApiName,
        toVersion: request.toVersion,
        ...(request.targetOrg !== undefined ? { targetOrg: request.targetOrg } : {}),
      });
      return result.ok
        ? makeSuccessResponse(request.requestId, result.data)
        : makeErrorResponse(request.requestId, result.error, result.code ?? 'INTERNAL_ERROR');
    }
    case 'telemetry.snapshot': {
      // Persist the extension-reported telemetry counters so
      // `sfdt extension stats` can read them. Writes are best-effort: a
      // failure to write the file should not break the extension.
      //
      // The snapshot must land in the project's .sfdt/ directory so
      // `sfdt extension stats` (which reads via getConfigDir()) finds it —
      // process.cwd() would point at wherever the user launched sfdt ui from,
      // not the project root, and the read would always miss.
      if (!projectRoot) {
        return makeErrorResponse(
          request.requestId,
          'Cannot persist telemetry snapshot: no project root resolved on the bridge',
          'INTERNAL_ERROR',
        );
      }
      const fsExtra = (await import('fs-extra')).default;
      const file = path.join(projectRoot, '.sfdt', 'telemetry-snapshot.json');
      try {
        await fsExtra.outputJson(
          file,
          {
            monthKey: request.monthKey,
            counters: request.counters,
            writtenAt: new Date().toISOString(),
          },
          { spaces: 2 },
        );
        return makeSuccessResponse(request.requestId, { writtenTo: file });
      } catch (err) {
        return makeErrorResponse(
          request.requestId,
          `Could not write telemetry snapshot: ${err.message}`,
          'INTERNAL_ERROR',
        );
      }
    }
    case 'org-health': {
      // Return the latest audit/monitor snapshots the CLI wrote under logs/.
      // Read-only; mirrors the gui-server /api/audit + /api/monitor routes.
      if (!projectRoot) {
        return makeErrorResponse(
          request.requestId,
          'Cannot read org health: no project root resolved on the bridge',
          'INTERNAL_ERROR',
        );
      }
      const fsExtra = (await import('fs-extra')).default;
      const readSnapshot = async (name) => {
        const file = path.join(logDir || path.join(projectRoot, 'logs'), name);
        if (!(await fsExtra.pathExists(file))) return null;
        try {
          const data = await fsExtra.readJson(file);
          return { timestamp: data?.timestamp ?? new Date().toISOString(), data };
        } catch {
          return null;
        }
      };
      const [audit, monitor] = await Promise.all([
        readSnapshot('audit-latest.json'),
        readSnapshot('monitor-latest.json'),
      ]);
      return makeSuccessResponse(request.requestId, { audit, monitor });
    }
    case 'scan': {
      // Live metadata inventory — the same `fetchInventory` the `sfdt scan`
      // command runs, so the bridge and CLI agree by construction.
      try {
        const { fetchInventory } = await import('../org-inventory.js');
        const org = config?.defaultOrg;
        if (!org) {
          return makeErrorResponse(request.requestId, 'No default org configured for scan', 'REQUEST_INVALID');
        }
        const inventory = await fetchInventory(org, config);
        return makeSuccessResponse(request.requestId, {
          org,
          scanType: request.scanType,
          totalTypes: inventory.size,
          totalMembers: [...inventory.values()].reduce((n, s) => n + s.size, 0),
          inventory: Object.fromEntries([...inventory.entries()].map(([k, v]) => [k, [...v]])),
        });
      } catch (err) {
        return makeErrorResponse(request.requestId, `Scan failed: ${err.message}`, 'INTERNAL_ERROR');
      }
    }
    case 'compare': {
      // Live inventory diff — the same `fetchInventory` + `diffInventories` the
      // `sfdt compare` command runs. `left`/`right` are org aliases or "local".
      try {
        const { fetchInventory } = await import('../org-inventory.js');
        const { diffInventories } = await import('../org-diff.js');
        const [leftMap, rightMap] = await Promise.all([
          fetchInventory(request.left, config),
          fetchInventory(request.right, config),
        ]);
        const items = diffInventories(leftMap, rightMap);
        return makeSuccessResponse(request.requestId, {
          left: request.left,
          right: request.right,
          sourceOnly: items.filter((i) => i.status === 'source-only').length,
          targetOnly: items.filter((i) => i.status === 'target-only').length,
          both: items.filter((i) => i.status === 'both').length,
          items,
        });
      } catch (err) {
        return makeErrorResponse(request.requestId, `Compare failed: ${err.message}`, 'INTERNAL_ERROR');
      }
    }
    case 'drift': {
      // `sfdt drift` is a heavy shell-based local-vs-org content diff. Rather than
      // trigger a multi-minute retrieve from a browser click, return the latest
      // snapshot the CLI wrote (read-only, consistent with the dashboard),
      // optionally scoped to a component.
      if (!projectRoot) {
        return makeErrorResponse(request.requestId, 'No project root resolved on the bridge', 'INTERNAL_ERROR');
      }
      const fsExtra = (await import('fs-extra')).default;
      const file = path.join(logDir || path.join(projectRoot, 'logs'), 'drift-latest.json');
      if (request.refresh) {
        // Run drift live (heavy: full retrieve + diff) before reading the fresh
        // snapshot — same `ops/drift.sh` the `sfdt drift` command runs.
        try {
          const { runScript } = await import('../script-runner.js');
          await runScript('ops/drift.sh', config ?? {}, {
            cwd: projectRoot,
            env: { SFDT_TARGET_ORG: config?.defaultOrg ?? '' },
          });
        } catch (err) {
          return makeErrorResponse(request.requestId, `Drift run failed: ${err.message}`, 'INTERNAL_ERROR');
        }
      }
      if (!(await fsExtra.pathExists(file))) {
        return makeSuccessResponse(request.requestId, {
          available: false,
          hint: 'No drift snapshot yet — run `sfdt drift` in your project to generate one.',
        });
      }
      let snapshot;
      try {
        snapshot = await fsExtra.readJson(file);
      } catch (err) {
        return makeErrorResponse(request.requestId, `Could not read drift snapshot: ${err.message}`, 'INTERNAL_ERROR');
      }
      let components = Array.isArray(snapshot?.components) ? snapshot.components : [];
      if (request.component) {
        const needle = request.component.toLowerCase();
        components = components.filter((c) =>
          `${c?.type ?? ''}.${c?.name ?? c?.member ?? ''}`.toLowerCase().includes(needle),
        );
      }
      return makeSuccessResponse(request.requestId, {
        available: true,
        org: snapshot?.org ?? null,
        driftStatus: snapshot?.driftStatus ?? null,
        timestamp: snapshot?.timestamp ?? snapshot?.date ?? null,
        component: request.component ?? null,
        components,
      });
    }
    case 'ai': {
      // Run the prompt through the project's configured AI provider — the same
      // `runAiPrompt` the `sfdt ai prompt` command uses, which already redacts
      // sensitive data, wraps an anti-injection preamble, and runs the provider
      // in a read-only tool sandbox. Gated on the project opting into AI.
      if (!config) {
        return makeErrorResponse(request.requestId, 'No config resolved on the bridge', 'INTERNAL_ERROR');
      }
      const { isAiAvailable, aiUnavailableMessage, runAiPrompt } = await import('../ai.js');
      if (!config.features?.ai) {
        return makeErrorResponse(
          request.requestId,
          'AI features are disabled for this project. Set "features.ai": true in .sfdt/config.json.',
          'REQUEST_INVALID',
        );
      }
      if (!(await isAiAvailable(config))) {
        return makeErrorResponse(request.requestId, aiUnavailableMessage(config), 'REQUEST_INVALID');
      }
      let prompt = request.prompt;
      if (request.context && typeof request.context === 'object' && Object.keys(request.context).length > 0) {
        prompt += `\n\n--- Context ---\n${JSON.stringify(request.context, null, 2)}`;
      }
      try {
        const result = await runAiPrompt(prompt, { config, aiEnabled: true, interactive: false });
        if (result == null) {
          return makeErrorResponse(request.requestId, 'AI provider returned no result.', 'INTERNAL_ERROR');
        }
        return makeSuccessResponse(request.requestId, {
          response: typeof result === 'string' ? result : String(result),
          provider: config.ai?.provider ?? 'claude',
        });
      } catch (err) {
        return makeErrorResponse(request.requestId, `AI request failed: ${err.message}`, 'INTERNAL_ERROR');
      }
    }
    default:
      return makeErrorResponse(
        request.requestId,
        `Unknown request kind: ${request.kind}`,
        'REQUEST_INVALID',
      );
  }
}
