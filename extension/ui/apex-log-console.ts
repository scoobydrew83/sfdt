// Raw-log console rendering.
//
// A debug log is line-oriented, not token-oriented: every line already declares
// what it is in its second pipe-delimited field. So unlike lib/code-editor.ts —
// which tokenizes *within* a line — this classifies whole lines by event type
// and puts one class on each. That is the entire technique, and it is why this
// is ~40 lines rather than a parser.
//
// The point is scanning. A FINEST log is mostly HEAP_ALLOCATE and
// STATEMENT_EXECUTE chatter; the three lines anyone opened it for are the
// USER_DEBUG output, the exception, and the limit block. Dimming the volume and
// lifting those three turns a wall of text into something readable without
// hiding anything.
//
// Two consumers: the Debug Logs viewer's log pane and Execute Anonymous's.

const FRAME_EVENTS: ReadonlySet<string> = new Set([
  'EXECUTION_STARTED',
  'EXECUTION_FINISHED',
  'CODE_UNIT_STARTED',
  'CODE_UNIT_FINISHED',
]);

const NOISE_EVENTS: ReadonlySet<string> = new Set([
  'HEAP_ALLOCATE',
  'HEAP_DEALLOCATE',
  'STATEMENT_EXECUTE',
]);

// Above this the pane renders as one plain text node. Element count, not byte
// count, is what makes a pane janky, and a 24 MB log would otherwise mean a
// quarter-million spans. The log stays fully readable — it just stops being
// tinted.
// ponytail: flat cutoff, no virtualisation. The analyzer is the tool for a log
// that large; this pane is for reading one.
export const MAX_TINTED_LINES = 5000;

/**
 * The `.sfdt-log-*` class for one raw log line, or `''` for no tint.
 *
 * Exported because the mapping is the part worth pinning: which events count as
 * noise is a judgement call, and a test asserting on it directly is clearer
 * than one asserting on rendered spans.
 */
export function classifyLogLine(line: string): string {
  // "19:55:30.0 (872383)|EXECUTION_STARTED" → field 1 is the event type. The
  // header line has no pipes at all and falls through to no tint.
  const type = line.split('|')[1] ?? '';
  if (!type) return '';
  if (type === 'USER_DEBUG') return 'sfdt-log-debug';
  if (type === 'FATAL_ERROR' || type === 'EXCEPTION_THROWN') return 'sfdt-log-error';
  if (type.startsWith('LIMIT_USAGE') || type.startsWith('CUMULATIVE_LIMIT')) return 'sfdt-log-limit';
  if (FRAME_EVENTS.has(type)) return 'sfdt-log-frame';
  if (NOISE_EVENTS.has(type) || type.startsWith('VARIABLE_') || type.startsWith('SYSTEM_')) {
    return 'sfdt-log-noise';
  }
  return '';
}

/**
 * Render a raw log body into a `.sfdt-console` element, tinted by event type.
 *
 * DOM discipline (CLAUDE.md rule 1): createElement + textContent throughout. A
 * debug log contains arbitrary org data — record names, exception messages,
 * query text — so this is exactly the input an innerHTML path would be wrong
 * about.
 */
export function renderApexLogBody(
  pre: HTMLElement,
  text: string,
  doc: Document = pre.ownerDocument ?? document,
): void {
  pre.textContent = '';
  const lines = text.split('\n');
  if (lines.length > MAX_TINTED_LINES) {
    pre.textContent = text;
    return;
  }
  lines.forEach((line, i) => {
    // Real newline text nodes between lines, NOT 'display: block' spans. The
    // console is 'white-space: pre-wrap', so this lays out identically — and it
    // is the only version where `pre.textContent` still equals the log and a
    // user's select-all-copy produces the log rather than one endless line.
    if (i) pre.appendChild(doc.createTextNode('\n'));
    const cls = classifyLogLine(line);
    if (!cls) {
      pre.appendChild(doc.createTextNode(line));
      return;
    }
    const el = doc.createElement('span');
    el.className = cls;
    el.textContent = line;
    pre.appendChild(el);
  });
}
