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
//   1.2 — added org-health request kind (reads the latest audit/monitor
//         snapshots from logs/ over the bridge).
//   1.3 — added manifest.discover and manifest.render request kinds (the
//         read-only manifest-builder surface: org type/member discovery via
//         org-inventory, package.xml rendering via renderPackageXml).
//   1.4 — added the quality.results request kind (read-only: returns the
//         latest `sfdt quality` snapshot from logs/quality-latest.json, the
//         same payload the dashboard's /api/quality route serves).
export const PROTOCOL_VERSION = '1.4';

export type SfdtRequestKind =
  | 'ping'
  | 'version'
  | 'deploy'
  | 'rollback'
  | 'quality'
  | 'quality.results'
  | 'ai'
  | 'drift'
  | 'scan'
  | 'compare'
  | 'org-health'
  | 'telemetry.snapshot'
  | 'manifest.discover'
  | 'manifest.render';

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
  // Flow metadata payload. Despite the historical field name, the value is
  // JSON-stringified Tooling API `Flow.Metadata` (not XML) — the bridge
  // immediately JSON.parses it before passing to flow-core's normalize().
  // The field is kept named `flowXml` for protocol-version continuity with
  // extension clients already on the wire; a future major version of the
  // contract should rename it to `flowMetadata` and add a discriminator.
  flowXml: string;
}

/**
 * Read the latest `sfdt quality` run recorded in `logs/quality-latest.json`
 * (written when the command runs through `sfdt ui`). No request fields — the
 * bridge reads whatever is on disk for the active project, exactly like
 * `org-health`. Read-only by design: a Code Analyzer sweep is minutes of work
 * and must not be triggered by a browser click.
 */
export interface QualityResultsRequest extends RequestEnvelope {
  kind: 'quality.results';
}

export interface AiRequest extends RequestEnvelope {
  kind: 'ai';
  prompt: string;
  context?: Record<string, unknown>;
}

export interface DriftRequest extends RequestEnvelope {
  kind: 'drift';
  component: string;
  /** When true, run drift live (heavy) before returning; otherwise return the
   *  latest snapshot. Defaults to false. */
  refresh?: boolean;
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
 * Read the latest org diagnose/audit and monitoring snapshots that the
 * `sfdt audit` / `sfdt monitor` commands wrote to `logs/audit-latest.json` and
 * `logs/monitor-latest.json`. No request fields — the bridge reads whatever is
 * on disk for the active project. Used by the extension's Org Health panel.
 */
export interface OrgHealthRequest extends RequestEnvelope {
  kind: 'org-health';
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

/**
 * Read-only org metadata discovery for the manifest builder. Two shapes,
 * discriminated by the presence of `type`:
 *   - no `type`  → list the org's metadata type names
 *                  (`sf org list metadata-types` via org-inventory).
 *   - with `type` → list the members of that one metadata type
 *                  (`sf org list metadata` via org-inventory).
 * A listMetadata failure surfaces as an error response — never a fabricated
 * empty tree.
 */
export interface ManifestDiscoverRequest extends RequestEnvelope {
  kind: 'manifest.discover';
  // Org alias to query. Optional — when absent the server falls back to the
  // project's configured defaultOrg and errors if none is set.
  org?: string;
  // Metadata type whose members to list. Absent → list type names instead.
  type?: string;
}

/**
 * Render selected components into manifest XML — pure, no org round-trip.
 * Every surface renders through the CLI's single writer
 * (`renderPackageXml` in src/lib/metadata-mapper.js), so bridge output is
 * byte-identical to what `sfdt manifest` and the GUI builder produce.
 * Destructive mode returns the pair `{destructiveChangesXml, emptyPackageXml}`
 * expected by `sf project deploy`.
 */
export interface ManifestRenderRequest extends RequestEnvelope {
  kind: 'manifest.render';
  items: Array<{ type: string; member: string }>;
  // Defaults to 'additive' when absent.
  mode?: 'additive' | 'destructive';
  // e.g. "63.0". Defaults to the project's sourceApiVersion server-side.
  apiVersion?: string;
}

export type SfdtRequest =
  | PingRequest
  | VersionRequest
  | DeployRequest
  | RollbackRequest
  | QualityRequest
  | QualityResultsRequest
  | AiRequest
  | DriftRequest
  | ScanRequest
  | CompareRequest
  | OrgHealthRequest
  | TelemetrySnapshotRequest
  | ManifestDiscoverRequest
  | ManifestRenderRequest;

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

/**
 * A single org-health snapshot as written by `sfdt audit` / `sfdt monitor`.
 * `data` is the `{ timestamp, org, checks, summary }` payload; it is left as an
 * open record so the contract doesn't have to track every check field.
 */
export interface OrgHealthSnapshot {
  timestamp: string;
  data: Record<string, unknown>;
}

export interface OrgHealthResponseData {
  // null when the corresponding logs/<area>-latest.json does not exist yet.
  audit: OrgHealthSnapshot | null;
  monitor: OrgHealthSnapshot | null;
}

/**
 * One Code Analyzer violation, already flattened by the CLI's
 * `parseQualityLines` (which absorbs the v5 / legacy-v4 output-shape split, so
 * every consumer sees this one shape). `severity` is the analyzer's 1–5 scale:
 * 1 = critical, 2 = high, 3 = medium, 4+ = low.
 */
export interface QualityViolation {
  file: string;
  line: number;
  rule: string;
  /** Analyzer engine attribution (pmd, eslint, …). Absent on legacy v4 output. */
  engine?: string;
  severity: number;
  message: string;
}

/**
 * quality.results success payload.
 *
 * `available: false` means no run has been recorded yet — `hint` says how to
 * record one. When available, `status` is the CLI's own verdict and carries a
 * third state beyond PASS/FAIL: **SKIPPED**, meaning Code Analyzer never ran.
 * A skipped scan MUST NOT be presented as a pass by any consumer; that is the
 * whole reason the marker exists (see scripts/quality/code-analyzer.sh).
 */
export interface QualityResultsResponseData {
  available: boolean;
  /** Present only when `available` is false. */
  hint?: string;
  timestamp?: string | null;
  status?: 'PASS' | 'FAIL' | 'SKIPPED' | null;
  summary?: { critical: number; high: number; medium: number; low: number };
  violations?: QualityViolation[];
  /** Why the scan was skipped. Non-null only when `status` is SKIPPED. */
  unavailableMessage?: string | null;
}

/**
 * manifest.discover success payload. Exactly one of `types` / `members` is
 * present, matching the request shape: type-less requests return `types`,
 * typed requests return `type` + `members`.
 */
export interface ManifestDiscoverResponseData {
  org: string;
  types?: string[];
  type?: string;
  members?: string[];
}

/** manifest.render success payload — additive mode. */
export interface ManifestRenderAdditiveData {
  mode: 'additive';
  xml: string;
}

/** manifest.render success payload — destructive mode (the paired files). */
export interface ManifestRenderDestructiveData {
  mode: 'destructive';
  destructiveChangesXml: string;
  emptyPackageXml: string;
}

export type ManifestRenderResponseData =
  | ManifestRenderAdditiveData
  | ManifestRenderDestructiveData;

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

// requestId is echoed back verbatim in every response, including validation
// error paths. Without a cap, a bearer-token-authenticated caller could
// submit a multi-MB requestId and force every error response to approach
// the 1 MB native messaging reply limit (see host/src/index.js writeFrame).
// 256 chars comfortably accommodates UUIDs, ULIDs, and prefixed correlation
// ids while bounding the worst-case echo.
const REQUEST_ID_MAX_LEN = 256;
function isValidRequestId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= REQUEST_ID_MAX_LEN;
}

// Hard cap on telemetry.snapshot.counters key count. Per-value shape is
// validated below, but without a key-count limit a caller could submit
// tens of thousands of distinct featureIds (within the 6 MB body limit)
// and force fsExtra.outputJson to write a multi-MB file on every call.
// 500 is well above the legitimate feature catalog size (~20-50).
const COUNTERS_MAX_KEYS = 500;

// Org alias regex mirrors what the gui-server enforces on the same value.
// Salesforce CLI aliases are alphanumerics plus a small punctuation set, and
// MUST start with an alphanumeric (or `@` for username-style aliases) so
// `--flag-injection` style values never pass: `sf` would otherwise interpret
// the value passed to `--target-org` as another option. Defence in depth on
// top of execa's array form, which already prevents shell injection.
//
// The length cap bounds runtime — Salesforce aliases are conventionally
// short (≤30 chars in most setups); 80 is a generous ceiling that prevents
// oversized aliases from being padded with bogus suffixes.
export const ORG_ALIAS_RE = /^[A-Za-z0-9@][A-Za-z0-9_.\-@]*$/;
export const ORG_ALIAS_MAX_LEN = 80;
export function isValidOrgAlias(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= ORG_ALIAS_MAX_LEN &&
    ORG_ALIAS_RE.test(v)
  );
}

// Salesforce DeveloperName grammar: alphanumerics + underscore, must start
// with a letter. This is the same regex flow-deploy-runner.js and
// flow-rollback-runner.js enforce before any `sf` invocation; centralising
// it in the contract keeps the type definition self-documenting and lets the
// extension reject bad input client-side before a round-trip.
export const DEVELOPER_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
function isValidDeveloperName(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && DEVELOPER_NAME_RE.test(v);
}

// Salesforce metadata type xmlName grammar (ApexClass, CustomObject, …):
// alphanumerics only, must start with a letter. Mirrors what the gui-server
// enforces on /api/manifest/discover-org so `--flag-injection` style values
// never reach `sf org list metadata --metadata-type`.
export const METADATA_TYPE_RE = /^[A-Za-z][A-Za-z0-9]*$/;
function isValidMetadataType(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && METADATA_TYPE_RE.test(v);
}

// Hard cap on manifest.render items — mirrors the gui-server's
// POST /api/manifest/render limit so both surfaces refuse the same payloads.
export const MANIFEST_ITEMS_MAX = 20_000;

// package.xml <version> grammar, e.g. "63.0".
export const API_VERSION_RE = /^\d+\.\d+$/;

/**
 * Collapse `[{type, member}]` manifest items into the `{type: members[]}`
 * map that renderPackageXml consumes. Shared by the HTTP bridge, the native
 * host, and any other transport so the filtering semantics cannot drift
 * (mirrors the gui-server's collectManifestItems):
 *   - entries with a malformed type or empty member are skipped;
 *   - members containing XML-special or control characters are skipped so a
 *     request payload cannot inject markup into the rendered manifest;
 *   - a `*` member collapses the whole type to the wildcard.
 */
export function collapseManifestItems(
  items: Array<{ type: string; member: string }>,
): Record<string, string[]> {
  const metaMap = new Map<string, Set<string>>();
  for (const { type, member } of items) {
    if (typeof type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(type)) continue;
    if (typeof member !== 'string' || !member.trim()) continue;
    if (/[<>&"']/.test(member) || [...member].some((c) => c.charCodeAt(0) < 0x20)) continue;
    if (!metaMap.has(type)) metaMap.set(type, new Set());
    metaMap.get(type)!.add(member.trim());
  }
  const out: Record<string, string[]> = {};
  for (const [type, members] of metaMap) {
    out[type] = members.has('*') ? ['*'] : [...members];
  }
  return out;
}

export const KNOWN_KINDS: readonly SfdtRequestKind[] = [
  'ping',
  'version',
  'deploy',
  'rollback',
  'quality',
  'quality.results',
  'ai',
  'drift',
  'scan',
  'compare',
  'org-health',
  'telemetry.snapshot',
  'manifest.discover',
  'manifest.render',
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
  if (!isValidRequestId(input.requestId)) {
    errors.push({
      field: 'requestId',
      reason: `must be a non-empty string of at most ${REQUEST_ID_MAX_LEN} characters`,
    });
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
      if (input.flowApiName !== undefined && !isValidDeveloperName(input.flowApiName)) {
        errors.push({
          field: 'flowApiName',
          reason: 'must match /^[A-Za-z][A-Za-z0-9_]*$/ if present',
        });
      }
      if (input.flowId !== undefined && !isNonEmptyString(input.flowId)) {
        errors.push({ field: 'flowId', reason: 'must be a non-empty string if present' });
      }
      if (input.targetOrg !== undefined && !isValidOrgAlias(input.targetOrg)) {
        errors.push({
          field: 'targetOrg',
          reason: 'must match /^[A-Za-z0-9@][A-Za-z0-9_.\\-@]*$/ if present (first char alphanumeric or @)',
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
      if (hasApiName && !isValidDeveloperName(input.flowApiName)) {
        errors.push({
          field: 'flowApiName',
          reason: 'must match /^[A-Za-z][A-Za-z0-9_]*$/',
        });
      }
      if (typeof input.toVersion !== 'number' || !Number.isInteger(input.toVersion) || input.toVersion < 0) {
        errors.push({ field: 'toVersion', reason: 'must be a non-negative integer (0 deactivates)' });
      }
      if (input.targetOrg !== undefined && !isValidOrgAlias(input.targetOrg)) {
        errors.push({
          field: 'targetOrg',
          reason: 'must match /^[A-Za-z0-9@][A-Za-z0-9_.\\-@]*$/ if present (first char alphanumeric or @)',
        });
      }
      break;
    }
    case 'quality':
      if (!isNonEmptyString(input.flowXml)) errors.push({ field: 'flowXml', reason: 'must be a non-empty string' });
      break;
    case 'quality.results':
      // No fields beyond the envelope; the bridge reads the snapshot from disk.
      break;
    case 'ai':
      if (!isNonEmptyString(input.prompt)) errors.push({ field: 'prompt', reason: 'must be a non-empty string' });
      if (input.context !== undefined && !isObject(input.context)) {
        errors.push({ field: 'context', reason: 'must be an object if present' });
      }
      break;
    case 'drift':
      if (!isNonEmptyString(input.component)) errors.push({ field: 'component', reason: 'must be a non-empty string' });
      if (input.refresh !== undefined && typeof input.refresh !== 'boolean') {
        errors.push({ field: 'refresh', reason: 'must be a boolean when present' });
      }
      break;
    case 'scan':
      if (input.scanType !== 'scheduled' && input.scanType !== 'all') {
        errors.push({ field: 'scanType', reason: "must be 'scheduled' or 'all'" });
      }
      break;
    case 'compare':
      // left/right are org aliases the bridge passes to `sf` — validate their
      // format here too (matching deploy/rollback's targetOrg), not just non-empty.
      if (!isValidOrgAlias(input.left)) {
        errors.push({ field: 'left', reason: 'must match /^[A-Za-z0-9@][A-Za-z0-9_.\\-@]*$/' });
      }
      if (!isValidOrgAlias(input.right)) {
        errors.push({ field: 'right', reason: 'must match /^[A-Za-z0-9@][A-Za-z0-9_.\\-@]*$/' });
      }
      break;
    case 'org-health':
      // No fields beyond the envelope; the bridge reads snapshots from disk.
      break;
    case 'telemetry.snapshot':
      if (!isNonEmptyString(input.monthKey)) {
        errors.push({ field: 'monthKey', reason: "must be a non-empty string like '2026-05'" });
      } else if (!/^\d{4}-\d{2}$/.test(input.monthKey)) {
        errors.push({ field: 'monthKey', reason: "must match 'YYYY-MM'" });
      }
      if (!isObject(input.counters)) {
        errors.push({ field: 'counters', reason: 'must be an object keyed by featureId' });
      } else if (Object.keys(input.counters).length > COUNTERS_MAX_KEYS) {
        errors.push({
          field: 'counters',
          reason: `must have at most ${COUNTERS_MAX_KEYS} keys`,
        });
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
    case 'manifest.discover':
      // Both fields optional: no `type` lists metadata types, `type` lists
      // that type's members. `org` falls back to the server's defaultOrg.
      if (input.org !== undefined && !isValidOrgAlias(input.org)) {
        errors.push({
          field: 'org',
          reason: 'must match /^[A-Za-z0-9@][A-Za-z0-9_.\\-@]*$/ if present (first char alphanumeric or @)',
        });
      }
      if (input.type !== undefined && !isValidMetadataType(input.type)) {
        errors.push({ field: 'type', reason: 'must match /^[A-Za-z][A-Za-z0-9]*$/ if present' });
      }
      break;
    case 'manifest.render': {
      if (!Array.isArray(input.items) || input.items.length === 0) {
        errors.push({ field: 'items', reason: 'must be a non-empty array of {type, member}' });
      } else if (input.items.length > MANIFEST_ITEMS_MAX) {
        errors.push({ field: 'items', reason: `must have at most ${MANIFEST_ITEMS_MAX} entries` });
      } else if (!input.items.every((it: unknown) => isObject(it))) {
        errors.push({ field: 'items', reason: 'every entry must be an object' });
      }
      if (input.mode !== undefined && input.mode !== 'additive' && input.mode !== 'destructive') {
        errors.push({ field: 'mode', reason: "must be 'additive' or 'destructive' if present" });
      }
      if (input.apiVersion !== undefined) {
        if (typeof input.apiVersion !== 'string' || !API_VERSION_RE.test(input.apiVersion)) {
          errors.push({ field: 'apiVersion', reason: "must match /^\\d+\\.\\d+$/ if present (e.g. '63.0')" });
        }
      }
      break;
    }
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
