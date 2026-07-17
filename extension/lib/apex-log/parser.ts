// Pure, synchronous Apex debug-log parser (P3-2 PR-1).
//
// string -> ParsedLog. Zero DOM, zero IO, zero chrome.*, no dependencies.
// Single pass over lines: a state machine with an explicit invocation stack that
// pushes on ENTRY tokens and pops on EXIT tokens, computing per-node durations at
// pop time. Degrades gracefully on the three truncation shapes; never throws.
//
// PR-2 adds, in the same single pass: SOQL/DML/callout inventories (BEGIN records
// an entry back-referencing the current stack-top node; END completes it) and
// per-namespace governor-limit snapshots (LIMIT_USAGE_FOR_NS opens an indented
// sub-block of `label: used out of max` lines). Out of scope: worker/chunking for
// huge logs (PR-3).

import { ENTRY_KINDS, EXIT_KINDS, parseHeader, splitEventLine } from './tokens.js';
import type {
  CalloutEntry,
  DmlEntry,
  InvocationNode,
  LogEvent,
  NamespaceLimits,
  ParsedLog,
  ParseOptions,
  SoqlEntry,
  TruncationReason,
} from './types.js';

const SKIPPED_BYTES_RE = /^\*+\s*Skipped\s+\d+\s+bytes of detailed log/i;
const MAX_SIZE_RE = /MAXIMUM DEBUG LOG SIZE REACHED/;

// A limit-block body line: "  Number of SOQL queries: 3 out of 100".
const LIMIT_METRIC_RE = /^\s*(.+?):\s*(\d+)\s+out of\s+(\d+)\s*$/;

// Stable camelCase keys for the common governor metrics. Unmatched labels fall
// back to a normalized key (metricKey) so nothing is silently dropped.
const LIMIT_LABEL_MAP: Readonly<Record<string, string>> = {
  'Number of SOQL queries': 'soqlQueries',
  'Number of query rows': 'queryRows',
  'Number of SOSL queries': 'soslQueries',
  'Number of DML statements': 'dmlStatements',
  'Number of DML rows': 'dmlRows',
  'Maximum CPU time': 'cpuTime',
  'Maximum heap size': 'heapSize',
  'Number of callouts': 'callouts',
  'Number of future calls': 'futureCalls',
  'Number of queueable jobs added to the queue': 'queueableJobs',
  'Number of Email Invocations': 'emailInvocations',
};

function metricKey(label: string): string {
  const mapped = LIMIT_LABEL_MAP[label];
  if (mapped) return mapped;
  // Fallback: camelCase the words so an unmapped metric still lands somewhere.
  const words = label.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ');
  return words
    .map((w, i) =>
      i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join('');
}

/** Find the first `Rows:<n>` field (SOQL_EXECUTE_END, DML_BEGIN). */
function extractRows(fields: string[]): number | null {
  for (const f of fields) {
    const m = /Rows:(\d+)/.exec(f);
    if (m) return Number(m[1]);
  }
  return null;
}

/** DML op + sobject from `Op:Insert` / `Type:Account` fields. */
function extractDml(fields: string[]): { op: string; sobject: string } {
  let op = '';
  let sobject = '';
  for (const f of fields) {
    const o = /^Op:(.+)$/.exec(f);
    if (o) op = o[1]!.trim();
    const t = /^Type:(.+)$/.exec(f);
    if (t) sobject = t[1]!.trim();
  }
  return { op, sobject };
}

/** Callout method + endpoint from a `...[Endpoint=..., Method=...]` request field. */
function extractCalloutRequest(fields: string[]): { method: string; endpoint: string } {
  const joined = fields.join('|');
  const method = /Method=([^,\]|]+)/.exec(joined);
  const endpoint = /Endpoint=([^,\]|]+)/.exec(joined);
  return {
    method: method ? method[1]!.trim() : '',
    endpoint: endpoint ? endpoint[1]!.trim() : '',
  };
}

/** Callout status from a `...[Status=OK, StatusCode=200]` response field. */
function extractCalloutStatus(fields: string[]): string | null {
  const joined = fields.join('|');
  const status = /Status=([^,\]|]+)/.exec(joined);
  if (status) return status[1]!.trim();
  const code = /StatusCode=(\d+)/.exec(joined);
  return code ? code[1]! : null;
}

/** Managed-package methods appear as `ns.Class.method(...)`; unmanaged as `Class.method(...)`. */
function namespaceOf(signature: string): string | null {
  const beforeParen = signature.split('(')[0] ?? signature;
  const parts = beforeParen.split('.');
  return parts.length >= 3 ? (parts[0] || null) : null;
}

/** Build the node name + namespace for an ENTRY event from its fields. */
function nodeIdentity(
  token: string,
  fields: string[],
): { name: string; namespace: string | null } {
  const last = fields.length > 0 ? fields[fields.length - 1]! : '';
  if (token === 'METHOD_ENTRY') {
    // [line] | classId | signature  → signature is the node name
    return { name: last || 'method', namespace: namespaceOf(last) };
  }
  if (token === 'CODE_UNIT_STARTED') {
    // [EXTERNAL] | (optional id) | label  → label is the node name
    return { name: last || 'code unit', namespace: null };
  }
  // EXECUTION_STARTED carries no fields.
  return { name: 'EXECUTION', namespace: null };
}

function closeNode(node: InvocationNode, exitLine: number, endNanos: number): void {
  node.exitLine = exitLine;
  node.endNanos = endNanos;
  const total = node.startNanos === null ? null : endNanos - node.startNanos;
  node.totalNanos = total;
  if (total === null) {
    node.selfNanos = null;
    return;
  }
  // selfNanos = total − Σ children.totalNanos, computed AT POP (children already
  // closed by construction). Truncated children contribute nothing (null).
  let childSum = 0;
  for (const child of node.children) {
    if (child.totalNanos !== null) childSum += child.totalNanos;
  }
  node.selfNanos = total - childSum;
}

export function parseApexLog(raw: string, opts: ParseOptions = {}): ParsedLog {
  const collectEvents = opts.collectEvents !== false;

  const roots: InvocationNode[] = [];
  const stack: InvocationNode[] = [];
  const events: LogEvent[] = [];
  const parseErrors: string[] = [];

  // Inventories: entries are pushed at BEGIN (document order) and completed at
  // END by mutation; pending stacks match END→BEGIN. A missing END (truncation)
  // leaves the entry with its END-derived field null.
  const soql: SoqlEntry[] = [];
  const dml: DmlEntry[] = [];
  const callouts: CalloutEntry[] = [];
  const pendingSoql: SoqlEntry[] = [];
  const pendingCallouts: CalloutEntry[] = [];

  // Governor-limit snapshots. `currentLimitBlock` is the open LIMIT_USAGE_FOR_NS
  // sub-block being filled from indented body lines; `cumulative` tracks whether
  // we're inside a CUMULATIVE_LIMIT_USAGE wrapper.
  const limits: NamespaceLimits[] = [];
  let currentLimitBlock: NamespaceLimits | null = null;
  let cumulative = false;
  const flushLimitBlock = (): void => {
    if (currentLimitBlock) {
      limits.push(currentLimitBlock);
      currentLimitBlock = null;
    }
  };

  let apiVersion: string | null = null;
  let debugLevels: Record<string, string> = {};
  let truncated = false;
  let truncationReason: TruncationReason | null = null;
  let minNanos: number | null = null;
  let maxNanos: number | null = null;

  const lines = raw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') continue;

    // Truncation markers (checked before header/event so a marker line is never
    // mistaken for a header).
    if (MAX_SIZE_RE.test(line)) {
      truncated = true;
      truncationReason = 'MAXIMUM_DEBUG_LOG_SIZE_REACHED';
      continue;
    }
    if (SKIPPED_BYTES_RE.test(line)) {
      truncated = true;
      // A later MAXIMUM marker outranks SKIPPED; don't overwrite one already set.
      if (truncationReason === null) truncationReason = 'SKIPPED_BYTES';
      continue;
    }

    const ev = splitEventLine(line);
    if (!ev) {
      // Inside an open LIMIT_USAGE_FOR_NS block, indented `label: used out of max`
      // lines fill the snapshot. A non-metric line (blank already skipped) leaves
      // the block open; the block closes when the next event line arrives.
      if (currentLimitBlock) {
        const m = LIMIT_METRIC_RE.exec(line);
        if (m) {
          currentLimitBlock.metrics[metricKey(m[1]!.trim())] = {
            used: Number(m[2]),
            max: Number(m[3]),
          };
          continue;
        }
      }
      // First non-event, non-marker line is the header (line 0-ish). Everything
      // else unmatched is ignorable noise.
      if (apiVersion === null) {
        const header = parseHeader(line);
        if (header) {
          apiVersion = header.apiVersion;
          debugLevels = header.debugLevels;
        }
      }
      continue;
    }

    // Any event line terminates an open limit sub-block.
    flushLimitBlock();

    if (collectEvents) {
      events.push({
        line: i,
        clockTime: ev.clockTime,
        timestampNanos: ev.nanos,
        type: ev.type,
        fields: ev.fields,
      });
    }
    if (minNanos === null || ev.nanos < minNanos) minNanos = ev.nanos;
    if (maxNanos === null || ev.nanos > maxNanos) maxNanos = ev.nanos;

    // Governor-limit snapshot framing.
    if (ev.type === 'CUMULATIVE_LIMIT_USAGE') {
      cumulative = true;
      continue;
    }
    if (ev.type === 'CUMULATIVE_LIMIT_USAGE_END') {
      cumulative = false;
      continue;
    }
    if (ev.type === 'LIMIT_USAGE_FOR_NS') {
      currentLimitBlock = {
        namespace: ev.fields[0] || '(default)',
        cumulative,
        metrics: {},
      };
      continue;
    }

    // Inventories. 1-based raw-body line so P3-3 can deep-link.
    const node = stack[stack.length - 1] ?? null;
    if (ev.type === 'SOQL_EXECUTE_BEGIN') {
      const entry: SoqlEntry = {
        line: i + 1,
        timestampNanos: ev.nanos,
        // Last field is the query text (after the [line] + Aggregations fields).
        query: ev.fields.length > 0 ? ev.fields[ev.fields.length - 1]! : '',
        rows: null,
        node,
      };
      soql.push(entry);
      pendingSoql.push(entry);
      continue;
    }
    if (ev.type === 'SOQL_EXECUTE_END') {
      const entry = pendingSoql.pop();
      if (entry) entry.rows = extractRows(ev.fields);
      continue;
    }
    if (ev.type === 'DML_BEGIN') {
      // DML rows travel on BEGIN (not END), so the entry is complete here; DML_END
      // carries no payload and is ignored.
      const { op, sobject } = extractDml(ev.fields);
      dml.push({
        line: i + 1,
        timestampNanos: ev.nanos,
        op,
        sobject,
        rows: extractRows(ev.fields),
        node,
      });
      continue;
    }
    if (ev.type === 'CALLOUT_REQUEST') {
      const { method, endpoint } = extractCalloutRequest(ev.fields);
      const entry: CalloutEntry = {
        line: i + 1,
        timestampNanos: ev.nanos,
        method,
        endpoint,
        status: null,
        node,
      };
      callouts.push(entry);
      pendingCallouts.push(entry);
      continue;
    }
    if (ev.type === 'CALLOUT_RESPONSE') {
      const entry = pendingCallouts.pop();
      if (entry) entry.status = extractCalloutStatus(ev.fields);
      continue;
    }

    const entryKind = ENTRY_KINDS[ev.type];
    if (entryKind) {
      const { name, namespace } = nodeIdentity(ev.type, ev.fields);
      const node: InvocationNode = {
        name,
        kind: entryKind,
        namespace,
        enterLine: i,
        exitLine: null,
        startNanos: ev.nanos,
        endNanos: null,
        totalNanos: null,
        selfNanos: null,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
      continue;
    }

    const exitKind = EXIT_KINDS[ev.type];
    if (exitKind) {
      const top = stack[stack.length - 1];
      if (top && top.kind === exitKind) {
        closeNode(top, i, ev.nanos);
        stack.pop();
        continue;
      }
      // Mismatch (typically after a Skipped-bytes gap ate the matching ENTRY):
      // pop up to the nearest frame of this kind, closing skipped frames as
      // truncated; if none match, drop the orphan EXIT.
      let matchIdx = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.kind === exitKind) {
          matchIdx = s;
          break;
        }
      }
      if (matchIdx === -1) {
        parseErrors.push(`Unmatched ${ev.type} at line ${i} (no open ${exitKind})`);
        continue;
      }
      parseErrors.push(
        `Mismatched ${ev.type} at line ${i}; closed ${stack.length - 1 - matchIdx} skipped frame(s)`,
      );
      for (let s = stack.length - 1; s > matchIdx; s--) {
        const skipped = stack[s]!;
        skipped.truncated = true;
        stack.pop();
      }
      closeNode(stack[matchIdx]!, i, ev.nanos);
      stack.pop();
    }
  }

  // A limit block still open at EOF (e.g. log ends inside the block) is kept.
  flushLimitBlock();

  // EOF with open frames → truncation. An explicit marker (if seen) is the real
  // cause; otherwise it's an abrupt EOF. Close every dangling frame with null
  // durations.
  if (stack.length > 0) {
    truncated = true;
    if (truncationReason === null) truncationReason = 'ABRUPT_EOF';
    for (const node of stack) {
      node.truncated = true;
      node.exitLine = null;
      node.endNanos = null;
      node.totalNanos = null;
      node.selfNanos = null;
    }
    stack.length = 0;
  }

  const durationNanos =
    minNanos === null || maxNanos === null ? null : maxNanos - minNanos;

  return {
    apiVersion,
    debugLevels,
    events,
    tree: roots,
    limits,
    soql,
    dml,
    callouts,
    truncated,
    truncationReason,
    parseErrors,
    durationNanos,
  };
}
