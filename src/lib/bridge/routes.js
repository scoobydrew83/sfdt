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
export function mountBridgeRoutes(app, { port, version, projectRoot, configDir, rateLimiter }) {
  const cors = createBridgeCorsMiddleware(port);
  const auth = createBridgeAuthMiddleware();
  const limiter = rateLimiter ?? ((_req, _res, next) => next());
  const resolvedProjectRoot = resolveProjectRoot({ projectRoot, configDir });

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
        projectRoot: resolvedProjectRoot,
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
 * Phase 2 implements ping/version inline. The other kinds return
 * NOT_IMPLEMENTED — the contract is wired up end-to-end so the extension
 * can be built (Phase 3), then individual handlers fill in as Phases 4–6
 * land.
 */
async function dispatch(request, { version, projectRoot, makeSuccessResponse, makeErrorResponse }) {
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
    case 'ai':
    case 'drift':
    case 'scan':
    case 'compare':
      return makeErrorResponse(
        request.requestId,
        `Request kind "${request.kind}" is not yet implemented on the bridge.`,
        'NOT_IMPLEMENTED',
      );
    default:
      return makeErrorResponse(
        request.requestId,
        `Unknown request kind: ${request.kind}`,
        'REQUEST_INVALID',
      );
  }
}
