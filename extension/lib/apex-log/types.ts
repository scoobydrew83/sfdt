// Public types for the Apex debug-log parser (P3-2).
//
// PR-1 populates: apiVersion, debugLevels, events, tree, truncation, parseErrors,
// durationNanos. PR-2 populates the limits/soql/dml/callouts inventories.

export interface ParseOptions {
  /** Collect the flat events[] array. Default true. PR-3 sets false on huge logs. */
  collectEvents?: boolean;
}

export type TruncationReason =
  | 'MAXIMUM_DEBUG_LOG_SIZE_REACHED'
  | 'SKIPPED_BYTES'
  | 'ABRUPT_EOF';

export interface ParsedLog {
  apiVersion: string | null;
  debugLevels: Record<string, string>;
  events: LogEvent[]; // [] when collectEvents=false
  tree: InvocationNode[]; // roots
  limits: NamespaceLimits[]; // per-namespace governor-limit snapshots, document order
  soql: SoqlEntry[];
  dml: DmlEntry[];
  callouts: CalloutEntry[];
  truncated: boolean;
  truncationReason: TruncationReason | null;
  parseErrors: string[];
  durationNanos: number | null;
}

/** 0-based line index into the raw log body — `raw.split('\n')[i]`. Every
 *  `line` / `enterLine` / `exitLine` field in ParsedLog uses this one convention. */
export type RawLineIndex = number;

export interface LogEvent {
  line: RawLineIndex;
  clockTime: string | null;
  timestampNanos: number | null;
  type: string;
  fields: string[];
}

export interface InvocationNode {
  name: string;
  kind: 'execution' | 'code-unit' | 'method';
  namespace: string | null;
  enterLine: RawLineIndex;
  exitLine: RawLineIndex | null;
  startNanos: number | null;
  endNanos: number | null;
  totalNanos: number | null;
  selfNanos: number | null;
  children: InvocationNode[];
  truncated?: boolean;
}

export interface LimitPair {
  used: number;
  max: number;
}

export interface NamespaceLimits {
  namespace: string;
  cumulative: boolean;
  metrics: Record<string, LimitPair>;
}

export interface SoqlEntry {
  line: RawLineIndex;
  timestampNanos: number | null;
  query: string;
  rows: number | null;
  node: InvocationNode | null;
}

export interface DmlEntry {
  line: RawLineIndex;
  timestampNanos: number | null;
  op: string;
  sobject: string;
  rows: number | null;
  node: InvocationNode | null;
}

export interface CalloutEntry {
  line: RawLineIndex;
  timestampNanos: number | null;
  method: string;
  endpoint: string;
  status: string | null;
  node: InvocationNode | null;
}
