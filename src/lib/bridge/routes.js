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

import { createBridgeAuthMiddleware, createBridgeCorsMiddleware } from './middleware.js';

// Lazy import so flow-core's build is not required to start the server; the
// import happens the first time /api/bridge/exchange runs, by which point
// `npm run build:flow-core` should have produced dist/.
let _contract = null;
async function loadContract() {
  if (_contract) return _contract;
  _contract = await import('@sfdt/flow-core/bridge-contract');
  return _contract;
}

/**
 * Mount bridge routes onto the Express app.
 *
 * @param {import('express').Application} app
 * @param {object} opts
 * @param {number} opts.port              - The port the gui server is on.
 * @param {string} opts.version           - sfdt CLI version string.
 * @param {import('express').RequestHandler} [opts.rateLimiter]
 *   Optional rate limiter (uses gui-server's apiLimiter when supplied).
 */
export function mountBridgeRoutes(app, { port, version, rateLimiter }) {
  const cors = createBridgeCorsMiddleware(port);
  const auth = createBridgeAuthMiddleware();
  const limiter = rateLimiter ?? ((_req, _res, next) => next());

  // Mount CORS as a path-prefix middleware so it runs on every HTTP method —
  // including OPTIONS preflights — for any /api/bridge/* path. The middleware
  // short-circuits OPTIONS with 204 before falling through to the route
  // handlers. Doing it this way avoids Express 5's wildcard-route restrictions.
  app.use('/api/bridge', cors);

  // Discovery probe — no auth required so the extension can detect whether
  // localhost is reachable without prompting the user for a token first.
  app.get('/api/bridge/ping', limiter, (_req, res) => {
    res.json({
      ok: true,
      data: { pong: true, serverVersion: version, transport: 'localhost' },
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
      const response = await dispatch(request, { version, makeSuccessResponse, makeErrorResponse });
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
async function dispatch(request, { version, makeSuccessResponse, makeErrorResponse }) {
  switch (request.kind) {
    case 'ping':
      return makeSuccessResponse(request.requestId, {
        pong: true,
        serverVersion: version,
        transport: 'localhost',
      });
    case 'version':
      return makeSuccessResponse(request.requestId, { version });
    case 'quality': {
      // Phase 5: bridge wires `quality` through to flow-core. The contract's
      // `flowXml` field is named for the eventual XML-file path; for now we
      // accept JSON-stringified Tooling API Metadata so the Chrome extension
      // and the CLI dashboard share this path. Full XML parsing lands in
      // Phase 7's distribution work.
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
