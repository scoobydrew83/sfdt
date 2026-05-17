// Bridge contract between the @sfdt/extension Chrome extension and either the
// running sfdt ui localhost server (HTTP transport) or the @sfdt/host native
// messaging app (stdio transport). The extension sends an SfdtRequest, the
// bridge resolves it through sfdt, and the extension receives an SfdtResponse.
//
// This module is consumed by:
//   - extension/lib/sfdt-bridge.ts        — chooses a transport and validates
//   - sfdt/src/lib/bridge/routes.js       — implements the HTTP routes
//   - host/src/index.js                   — implements the stdio router
//
// Keep wire shapes flat and JSON-safe (no Dates, no Maps, no functions).
// All optional fields are explicit so the runtime validators below stay
// straightforward.

export type SfdtRequestKind =
  | 'ping'
  | 'version'
  | 'deploy'
  | 'rollback'
  | 'quality'
  | 'ai'
  | 'drift'
  | 'scan'
  | 'compare';

export interface RequestEnvelope {
  // Client-generated correlation id. Servers MUST echo it back in the response
  // so the extension can pair concurrent requests.
  requestId: string;
}

export interface PingRequest extends RequestEnvelope {
  kind: 'ping';
}

export interface VersionRequest extends RequestEnvelope {
  kind: 'version';
}

export interface DeployRequest extends RequestEnvelope {
  kind: 'deploy';
  // The Flow Builder URL's flowId is a Salesforce Id (or a managed-package
  // path), not the developer name needed by `sf project deploy start
  // --metadata Flow:<name>`. The extension fetches metadata via Tooling
  // API to resolve the developer name, then sends `flowApiName`.
  flowApiName?: string;
  // Legacy field; the bridge falls back to this when flowApiName isn't
  // provided so existing callers don't break.
  flowId?: string;
  targetOrg?: string;
  // When true, the bridge runs a check-only deploy without committing.
  validateOnly?: boolean;
}

export interface RollbackRequest extends RequestEnvelope {
  kind: 'rollback';
  // Preferred. The Flow's developer name — what FlowDefinition.DeveloperName
  // stores, and what Tooling-API queries resolve against.
  flowApiName?: string;
  // Legacy field; the bridge falls back to this when flowApiName isn't
  // provided so existing callers don't break.
  flowId?: string;
  // Target FlowDefinition.Metadata.activeVersionNumber. A positive integer
  // sets that version active (rollback to an earlier version OR activate the
  // latest). Zero deactivates the flow entirely — Salesforce maps zero to a
  // null active version under the hood.
  toVersion: number;
  targetOrg?: string;
}

export interface QualityRequest extends RequestEnvelope {
  kind: 'quality';
  // The full Flow XML, exactly as Tooling API would return it. The bridge
  // delegates to @sfdt/flow-core for normalization + rules + scoring so the
  // extension and the CLI produce identical results.
  flowXml: string;
}

export interface AiRequest extends RequestEnvelope {
  kind: 'ai';
  prompt: string;
  context?: Record<string, unknown>;
}

export interface DriftRequest extends RequestEnvelope {
  kind: 'drift';
  component: string;
}

export interface ScanRequest extends RequestEnvelope {
  kind: 'scan';
  scanType: 'scheduled' | 'all';
}

export interface CompareRequest extends RequestEnvelope {
  kind: 'compare';
  left: string;
  right: string;
}

export type SfdtRequest =
  | PingRequest
  | VersionRequest
  | DeployRequest
  | RollbackRequest
  | QualityRequest
  | AiRequest
  | DriftRequest
  | ScanRequest
  | CompareRequest;

export interface SfdtSuccessResponse<T = unknown> {
  ok: true;
  requestId: string;
  data: T;
}

export interface SfdtErrorResponse {
  ok: false;
  requestId: string;
  error: string;
  // Optional error code for the extension to map to UI states. Stable values
  // intended for programmatic use:
  //   "BRIDGE_OFFLINE" — the bridge endpoint is unreachable
  //   "BRIDGE_UNAUTHORIZED" — bearer token missing / invalid
  //   "BRIDGE_FORBIDDEN" — origin not in allowlist
  //   "REQUEST_INVALID" — payload failed the contract validator
  //   "NOT_IMPLEMENTED" — known request kind but stub on this side
  //   "NOT_FOUND" — handler ran but the resource didn't exist (e.g. no
  //                 FlowDefinition with the given DeveloperName)
  //   "INTERNAL_ERROR" — unhandled exception
  code?:
    | 'BRIDGE_OFFLINE'
    | 'BRIDGE_UNAUTHORIZED'
    | 'BRIDGE_FORBIDDEN'
    | 'REQUEST_INVALID'
    | 'NOT_IMPLEMENTED'
    | 'NOT_FOUND'
    | 'INTERNAL_ERROR';
}

export type SfdtResponse<T = unknown> = SfdtSuccessResponse<T> | SfdtErrorResponse;

// Specific success payloads for the kinds where the response shape matters at
// compile time. Other kinds return arbitrary data shaped by their handlers
// (deploy/rollback streams, drift reports, etc.).

export interface PingResponseData {
  pong: true;
  serverVersion: string;
  transport: 'localhost' | 'native' | 'unknown';
  /**
   * Feature ids the user (or CI) has disabled remotely via
   * .sfdt/feature-flags.json. Optional for back-compat with older bridge
   * servers that don't return the field — consumers treat undefined as [].
   */
  disabledFeatures?: readonly string[];
}

export interface VersionResponseData {
  version: string;
}

export interface QualityResponseData {
  overallScore: number;
  rating: string;
  severityCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  issueFamilyCount: number;
}

// ----- Runtime validators --------------------------------------------------
//
// Hand-rolled to keep the package zero-dep. Returns a structured ValidationError
// rather than throwing so HTTP routes can map directly to a 400.

export interface ValidationError {
  field: string;
  reason: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

const KNOWN_KINDS: readonly SfdtRequestKind[] = [
  'ping',
  'version',
  'deploy',
  'rollback',
  'quality',
  'ai',
  'drift',
  'scan',
  'compare',
];

export function validateSfdtRequest(input: unknown): {
  ok: true;
  request: SfdtRequest;
} | {
  ok: false;
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: '(root)', reason: 'must be an object' }] };
  }
  if (!isNonEmptyString(input.requestId)) {
    errors.push({ field: 'requestId', reason: 'must be a non-empty string' });
  }
  if (!isNonEmptyString(input.kind) || !KNOWN_KINDS.includes(input.kind as SfdtRequestKind)) {
    errors.push({
      field: 'kind',
      reason: `must be one of: ${KNOWN_KINDS.join(', ')}`,
    });
    return { ok: false, errors };
  }
  const kind = input.kind as SfdtRequestKind;

  switch (kind) {
    case 'ping':
    case 'version':
      // No body fields.
      break;
    case 'deploy':
      // flowApiName is preferred; flowId is the legacy field. At least one
      // must be a non-empty string.
      if (!isNonEmptyString(input.flowApiName) && !isNonEmptyString(input.flowId)) {
        errors.push({
          field: 'flowApiName',
          reason: 'must be a non-empty string (or set flowId for legacy compatibility)',
        });
      }
      if (input.flowApiName !== undefined && !isNonEmptyString(input.flowApiName)) {
        errors.push({ field: 'flowApiName', reason: 'must be a non-empty string if present' });
      }
      if (input.flowId !== undefined && !isNonEmptyString(input.flowId)) {
        errors.push({ field: 'flowId', reason: 'must be a non-empty string if present' });
      }
      if (input.targetOrg !== undefined && !isNonEmptyString(input.targetOrg)) {
        errors.push({ field: 'targetOrg', reason: 'must be a non-empty string if present' });
      }
      if (input.validateOnly !== undefined && typeof input.validateOnly !== 'boolean') {
        errors.push({ field: 'validateOnly', reason: 'must be a boolean if present' });
      }
      break;
    case 'rollback': {
      // One of flowApiName / flowId must be present. flowApiName wins on the
      // bridge side; flowId stays as a back-compat field for older callers.
      const hasApiName = isNonEmptyString(input.flowApiName);
      const hasFlowId = isNonEmptyString(input.flowId);
      if (!hasApiName && !hasFlowId) {
        errors.push({ field: 'flowApiName', reason: 'must be a non-empty string (or pass flowId)' });
      }
      if (typeof input.toVersion !== 'number' || !Number.isInteger(input.toVersion) || input.toVersion < 0) {
        errors.push({ field: 'toVersion', reason: 'must be a non-negative integer (0 deactivates)' });
      }
      if (input.targetOrg !== undefined && !isNonEmptyString(input.targetOrg)) {
        errors.push({ field: 'targetOrg', reason: 'must be a non-empty string if present' });
      }
      break;
    }
    case 'quality':
      if (!isNonEmptyString(input.flowXml)) errors.push({ field: 'flowXml', reason: 'must be a non-empty string' });
      break;
    case 'ai':
      if (!isNonEmptyString(input.prompt)) errors.push({ field: 'prompt', reason: 'must be a non-empty string' });
      if (input.context !== undefined && !isObject(input.context)) {
        errors.push({ field: 'context', reason: 'must be an object if present' });
      }
      break;
    case 'drift':
      if (!isNonEmptyString(input.component)) errors.push({ field: 'component', reason: 'must be a non-empty string' });
      break;
    case 'scan':
      if (input.scanType !== 'scheduled' && input.scanType !== 'all') {
        errors.push({ field: 'scanType', reason: "must be 'scheduled' or 'all'" });
      }
      break;
    case 'compare':
      if (!isNonEmptyString(input.left)) errors.push({ field: 'left', reason: 'must be a non-empty string' });
      if (!isNonEmptyString(input.right)) errors.push({ field: 'right', reason: 'must be a non-empty string' });
      break;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, request: input as unknown as SfdtRequest };
}

export function makeErrorResponse(
  requestId: string,
  error: string,
  code?: SfdtErrorResponse['code'],
): SfdtErrorResponse {
  return code !== undefined
    ? { ok: false, requestId, error, code }
    : { ok: false, requestId, error };
}

export function makeSuccessResponse<T>(requestId: string, data: T): SfdtSuccessResponse<T> {
  return { ok: true, requestId, data };
}
