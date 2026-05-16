import { createBridgeAuthMiddleware, createBridgeCorsMiddleware } from './middleware.js';
import { readDisabledFeatures } from './feature-flags.js';
let _contract = null;
async function loadContract() {
  if (_contract) return _contract;
  _contract = await import('@sfdt/flow-core/bridge-contract');
  return _contract;
}
export function mountBridgeRoutes(app, { port, version, rateLimiter }) {
  const cors = createBridgeCorsMiddleware(port);
  const auth = createBridgeAuthMiddleware();
  const limiter = rateLimiter ?? ((_req, _res, next) => next());
async function dispatch(request, { version, makeSuccessResponse, makeErrorResponse }) {
  switch (request.kind) {
    case 'ping': {
      let disabledFeatures = [];
      try {
        disabledFeatures = await readDisabledFeatures(process.cwd());
      } catch {
      }
      return makeSuccessResponse(request.requestId, {
        pong: true,
        serverVersion: version,
        transport: 'localhost',
        disabledFeatures,
      });
    }
    case 'version':
      return makeSuccessResponse(request.requestId, { version });
    case 'quality': {
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
