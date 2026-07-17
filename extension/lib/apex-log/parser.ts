// Pure, synchronous Apex debug-log parser (P3-2 PR-1).
//
// string -> ParsedLog. Zero DOM, zero IO, zero chrome.*, no dependencies.
// Single pass over lines: a state machine with an explicit invocation stack that
// pushes on ENTRY tokens and pops on EXIT tokens, computing per-node durations at
// pop time. Degrades gracefully on the three truncation shapes; never throws.
//
// Out of scope for PR-1 (returns empty): limits, soql, dml, callouts (PR-2);
// worker/chunking for huge logs (PR-3).

import { ENTRY_KINDS, EXIT_KINDS, parseHeader, splitEventLine } from './tokens.js';
import type {
  InvocationNode,
  LogEvent,
  NamespaceLimits,
  ParsedLog,
  ParseOptions,
  TruncationReason,
} from './types.js';

const SKIPPED_BYTES_RE = /^\*+\s*Skipped\s+\d+\s+bytes of detailed log/i;
const MAX_SIZE_RE = /MAXIMUM DEBUG LOG SIZE REACHED/;

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
  const limits: NamespaceLimits[] = []; // TODO(P3-2 PR-2)

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
      // First non-event, non-marker line is the header (line 0-ish). Everything
      // else unmatched is limit-block body (PR-2) or ignorable noise.
      if (apiVersion === null) {
        const header = parseHeader(line);
        if (header) {
          apiVersion = header.apiVersion;
          debugLevels = header.debugLevels;
        }
      }
      continue;
    }

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
    soql: [], // TODO(P3-2 PR-2)
    dml: [], // TODO(P3-2 PR-2)
    callouts: [], // TODO(P3-2 PR-2)
    truncated,
    truncationReason,
    parseErrors,
    durationNanos,
  };
}
