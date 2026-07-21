// Apex debug-log event tokens and the line splitter.
//
// An event line looks like:  HH:MM:SS.mmm (<nanos>)|<TOKEN>|<field>|<field>|...
// The (<nanos>) counter is monotonic nanoseconds from execution start — the
// timing spine. Wall-clock (HH:MM:SS.mmm) is display only.

export type NodeKind = 'execution' | 'code-unit' | 'method';

/** ENTRY tokens that push an InvocationNode → its node kind. */
export const ENTRY_KINDS: Readonly<Record<string, NodeKind>> = {
  EXECUTION_STARTED: 'execution',
  CODE_UNIT_STARTED: 'code-unit',
  METHOD_ENTRY: 'method',
};

/** EXIT tokens that pop an InvocationNode → the node kind they close. */
export const EXIT_KINDS: Readonly<Record<string, NodeKind>> = {
  EXECUTION_FINISHED: 'execution',
  CODE_UNIT_FINISHED: 'code-unit',
  METHOD_EXIT: 'method',
};

// Prefix: HH:MM:SS.mmm  (<nanos>) | TOKEN [ | fields... ]
const EVENT_LINE_RE =
  /^(\d{2}:\d{2}:\d{2}\.\d+)\s+\((\d+)\)\|([A-Z0-9_]+)(?:\|([\s\S]*))?$/;

// Header: "64.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;..."
const HEADER_RE = /^(\d+\.\d+)\s+(.+)$/;

export interface SplitEvent {
  clockTime: string;
  nanos: number;
  type: string;
  fields: string[];
}

/** Parse a single event line, or null if the line is not an event line. */
export function splitEventLine(line: string): SplitEvent | null {
  const m = EVENT_LINE_RE.exec(line);
  if (!m) return null;
  const rest = m[4];
  return {
    clockTime: m[1]!,
    nanos: Number(m[2]),
    type: m[3]!,
    // A token with no fields (e.g. EXECUTION_STARTED) yields []. split('|')
    // preserves genuinely-empty interior fields.
    fields: rest === undefined || rest === '' ? [] : rest.split('|'),
  };
}

export interface ParsedHeader {
  apiVersion: string;
  debugLevels: Record<string, string>;
}

/** Parse the header line ("64.0 CATEGORY,LEVEL;..."), or null if it isn't one. */
export function parseHeader(line: string): ParsedHeader | null {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  const debugLevels: Record<string, string> = {};
  for (const pair of m[2]!.split(';')) {
    const [category, level] = pair.split(',');
    if (category && level) debugLevels[category.trim()] = level.trim();
  }
  return { apiVersion: m[1]!, debugLevels };
}
