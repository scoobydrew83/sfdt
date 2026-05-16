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
  flowApiName?: string;
  flowId?: string;
  targetOrg?: string;
  validateOnly?: boolean;
}
export interface RollbackRequest extends RequestEnvelope {
  kind: 'rollback';
  flowApiName?: string;
  flowId?: string;
  toVersion: number;
  targetOrg?: string;
}
export interface QualityRequest extends RequestEnvelope {
  kind: 'quality';
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
export interface PingResponseData {
  pong: true;
  serverVersion: string;
  transport: 'localhost' | 'native' | 'unknown';
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
      break;
    case 'deploy':
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
