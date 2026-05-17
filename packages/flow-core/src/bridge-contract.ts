// Contract between the @sfdt/extension Chrome extension and either the sfdt
// ui localhost server (HTTP transport) or the @sfdt/host native messaging
// app (stdio transport).
//
// Keep wire shapes flat and JSON-safe (no Dates, no Maps, no functions);
// all optional fields are explicit so the runtime validators stay simple.

// Wire-protocol version exchanged on /api/bridge/ping. Bumped per semver
// against the request/response shape — NOT against the CLI release version,
// which moves independently. The extension and CLI compare this value to
// detect mismatched builds and warn (minor mismatch) or refuse (major
// mismatch). See negotiateProtocolVersion below.
//
// Bump rules:
//   - MINOR (1.0 → 1.1): additive, backward-compatible — a new
//     SfdtRequestKind, a new optional response field, a new error code.
//     Old clients keep working.
//   - MAJOR (1.x → 2.0): removed kind, changed field type, renamed required
//     field, removed legacy fallback. Old clients break and must refuse.
//
// Changelog:
//   1.0 — initial release. ping/version/deploy/rollback/quality/ai/drift/
//         scan/compare. Added disabledFeatures on the ping response.
//   1.1 — added telemetry.snapshot request kind.
export const PROTOCOL_VERSION = '1.1';

export type SfdtRequestKind =
  | 'ping'
  | 'version'
  | 'deploy'
  | 'rollback'
  | 'quality'
  | 'ai'
  | 'drift'
  | 'scan'
  | 'compare'
  | 'telemetry.snapshot';

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

/**
 * Push the extension's local telemetry counters to the bridge so the CLI
 * (`sfdt extension stats`) can show them. The extension calls this from the
 * options page on load when telemetry is opted in. The bridge writes the
 * payload to <project>/.sfdt/telemetry-snapshot.json.
 */
export interface TelemetrySnapshotRequest extends RequestEnvelope {
  kind: 'telemetry.snapshot';
  monthKey: string; // e.g. "2026-05"
  counters: Record<
    string,
    {
      activated: number;
      errored: number;
      disabled_remote: number;
    }
  >;
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
  | CompareRequest
  | TelemetrySnapshotRequest;

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
  // Wire-protocol semver — see PROTOCOL_VERSION above. Distinct from
  // serverVersion (the sfdt CLI release). Optional only for back-compat with
  // pre-1.0 bridge servers; new servers must set it.
  protocolVersion?: string;
  transport: 'localhost' | 'native' | 'unknown';
  /**
   * Feature ids the user (or CI) has disabled remotely via
   * .sfdt/feature-flags.json. Optional for back-compat with older bridge
   * servers that don't return the field — consumers treat undefined as [].
   */
  disabledFeatures?: readonly string[];
}

export type ProtocolNegotiation =
  | { ok: true; severity: 'ok' }
  | { ok: true; severity: 'warn'; message: string }
  | { ok: false; severity: 'error'; message: string };

/**
 * Compare a server-reported protocolVersion against the client's expected
 * version. Returns an explicit negotiation result so the client can decide
 * whether to log a warning, refuse to send requests, or proceed silently.
 *
 *   same major + same minor   → ok
 *   same major + diff minor   → warn (backward-compatible per semver)
 *   different major           → error (refuse)
 *   unparseable               → error (refuse, defensive)
 *
 * Treats a missing serverVersion as the legacy "0.0" so old bridge servers
 * which never sent the field surface as a major mismatch that prompts the
 * user to upgrade.
 */
export function negotiateProtocolVersion(
  serverVersion: string | undefined,
  clientVersion: string = PROTOCOL_VERSION,
): ProtocolNegotiation {
  const effectiveServer = serverVersion ?? '0.0';
  const parse = (v: string): { major: number; minor: number } | null => {
    const m = /^(\d+)\.(\d+)(?:\..*)?$/.exec(v);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]) };
  };
  const s = parse(effectiveServer);
  const c = parse(clientVersion);
  if (!s || !c) {
    return {
      ok: false,
      severity: 'error',
      message: `Could not parse protocol version: server="${effectiveServer}", client="${clientVersion}".`,
    };
  }
  if (s.major !== c.major) {
    const direction = s.major > c.major ? 'extension' : 'sfdt CLI';
    return {
      ok: false,
      severity: 'error',
      message: `Bridge protocol major version mismatch: server ${effectiveServer}, client ${clientVersion}. Upgrade the ${direction} to continue.`,
    };
  }
  if (s.minor !== c.minor) {
    return {
      ok: true,
      severity: 'warn',
      message: `Bridge protocol minor mismatch: server ${effectiveServer}, client ${clientVersion}. Compatible, but newer fields/kinds may be unavailable on the older side.`,
    };
  }
  return { ok: true, severity: 'ok' };
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

// Org alias regex mirrors what the gui-server enforces on the same value.
// Salesforce CLI aliases are alphanumerics plus a small punctuation set.
// Tightening here forecloses flag-injection attempts even though execa's
// array form already prevents shell-level command injection.
const ORG_ALIAS_RE = /^[A-Za-z0-9_.\-@]+$/;
function isValidOrgAlias(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && ORG_ALIAS_RE.test(v);
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
  'telemetry.snapshot',
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
      // flowApiName preferred; flowId is the legacy fallback.
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
      if (input.targetOrg !== undefined && !isValidOrgAlias(input.targetOrg)) {
        errors.push({
          field: 'targetOrg',
          reason: 'must match /^[A-Za-z0-9_.\\-@]+$/ if present',
        });
      }
      if (input.validateOnly !== undefined && typeof input.validateOnly !== 'boolean') {
        errors.push({ field: 'validateOnly', reason: 'must be a boolean if present' });
      }
      break;
    case 'rollback': {
      // flowApiName wins on the bridge side; flowId is the legacy fallback.
      const hasApiName = isNonEmptyString(input.flowApiName);
      const hasFlowId = isNonEmptyString(input.flowId);
      if (!hasApiName && !hasFlowId) {
        errors.push({ field: 'flowApiName', reason: 'must be a non-empty string (or pass flowId)' });
      }
      if (typeof input.toVersion !== 'number' || !Number.isInteger(input.toVersion) || input.toVersion < 0) {
        errors.push({ field: 'toVersion', reason: 'must be a non-negative integer (0 deactivates)' });
      }
      if (input.targetOrg !== undefined && !isValidOrgAlias(input.targetOrg)) {
        errors.push({
          field: 'targetOrg',
          reason: 'must match /^[A-Za-z0-9_.\\-@]+$/ if present',
        });
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
    case 'telemetry.snapshot':
      if (!isNonEmptyString(input.monthKey)) {
        errors.push({ field: 'monthKey', reason: "must be a non-empty string like '2026-05'" });
      } else if (!/^\d{4}-\d{2}$/.test(input.monthKey)) {
        errors.push({ field: 'monthKey', reason: "must match 'YYYY-MM'" });
      }
      if (!isObject(input.counters)) {
        errors.push({ field: 'counters', reason: 'must be an object keyed by featureId' });
      } else {
        for (const [id, counter] of Object.entries(input.counters)) {
          if (!isObject(counter)) {
            errors.push({ field: `counters.${id}`, reason: 'must be an object' });
            continue;
          }
          for (const k of ['activated', 'errored', 'disabled_remote']) {
            if (typeof counter[k] !== 'number' || !Number.isFinite(counter[k])) {
              errors.push({ field: `counters.${id}.${k}`, reason: 'must be a finite number' });
            }
          }
        }
      }
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
