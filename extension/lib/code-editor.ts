// Line-numbered, syntax-highlighted code editor.
//
// The technique is the boring one on purpose: a real `<textarea>` with
// transparent glyphs sits exactly on top of a `<pre>` that renders the same
// string as coloured spans, and a gutter beside them shares the scroll offset.
// The alternative — a `contenteditable` — means re-implementing the caret,
// selection, undo stack, IME composition and native find, all of which the
// textarea gives away for free. The cost is that three layers must agree on
// font, line-height and padding to the pixel; that agreement lives in the
// `.sfdt-editor*` rules in lib/ui-styles.ts, not here.
//
// Highlighting is a single-pass regex tokenizer, not a parser. It gets
// comments, strings, annotations, numbers, keywords and type-shaped words
// right, and it will happily mis-colour a pathological case (an apostrophe in a
// comment opening a "string"). That is the correct trade for a scratchpad: the
// text is never interpreted from the highlight, only read.
//
// DOM discipline (CLAUDE.md rule 1): tokens become elements via createElement +
// textContent. There is no innerHTML path, so no escaping question arises.

import { ensureComponentStyles } from './ui-styles.js';

/**
 * Apex reserved words, lowercase and matched case-sensitively.
 *
 * Apex itself is case-insensitive, so `PUBLIC` is legal — but matching
 * case-insensitively would colour `Set<Id>`, `Date` and `Integer` as keywords
 * rather than types, and those are far more common in real code than shouted
 * keywords. Case-sensitive matching lets the uppercase-initial rule below claim
 * them instead, which is what a reader expects to see.
 */
export const APEX_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'after', 'and', 'as', 'asc', 'before', 'break', 'catch', 'class',
  'continue', 'delete', 'desc', 'do', 'else', 'enum', 'extends', 'final',
  'finally', 'for', 'from', 'get', 'global', 'if', 'implements', 'insert',
  'instanceof', 'interface', 'like', 'limit', 'merge', 'new', 'not', 'null',
  'on', 'or', 'override', 'private', 'protected', 'public', 'return', 'select',
  'set', 'sharing', 'static', 'super', 'switch', 'testmethod', 'this', 'throw',
  'transient', 'trigger', 'try', 'undelete', 'update', 'upsert', 'virtual',
  'void', 'when', 'where', 'while', 'with', 'without', 'true', 'false',
]);

/** SOQL/SOSL reserved words, for a query editor. Same matching rules. */
export const SOQL_KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'asc', 'by', 'desc', 'find', 'from', 'group', 'having', 'in',
  'including', 'like', 'limit', 'not', 'null', 'nulls', 'offset', 'or',
  'order', 'returning', 'rollup', 'select', 'using', 'where', 'with',
]);

export type TokenClass = '' | 'k' | 't' | 's' | 'c' | 'n' | 'a';

export interface CodeToken {
  text: string;
  cls: TokenClass;
}

// Ordered alternation — the first branch that matches wins, which is what makes
// `// it's fine` a comment rather than a comment followed by a string. Strings
// are newline-bounded for the same reason: an unterminated quote must not
// swallow the rest of the file, which is exactly what happens while the user is
// mid-keystroke typing the opening one.
const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\\n]|\\[\s\S])*'?)|(@[A-Za-z_]\w*)|(\b\d[\d._]*\b)|([A-Za-z_]\w*)/g;

// Above this many characters the highlight layer renders as one plain text node.
// Tokenizing runs on every keystroke, and a 200KB paste (a whole class pasted in
// to poke at) would turn typing into a slideshow. The editor stays fully usable
// — it just stops being colourful.
// ponytail: flat cutoff, not incremental re-tokenizing. Revisit if anyone ever
// actually edits a file-sized buffer in here rather than a snippet.
const MAX_HIGHLIGHT_CHARS = 40_000;

/**
 * Split source into coloured spans. Exported for tests: the classification
 * rules are the part worth pinning, and asserting on them directly beats
 * asserting on rendered DOM.
 */
export function tokenizeCode(
  src: string,
  keywords: ReadonlySet<string> = APEX_KEYWORDS,
): CodeToken[] {
  const out: CodeToken[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(src); m; m = TOKEN_RE.exec(src)) {
    const text = m[0];
    // A zero-length match would spin the loop forever. No current branch can
    // produce one, but the guard costs nothing and the failure mode is a hang.
    if (!text) {
      TOKEN_RE.lastIndex++;
      continue;
    }
    if (m.index > last) out.push({ text: src.slice(last, m.index), cls: '' });

    let cls: TokenClass = '';
    if (m[1]) cls = 'c';
    else if (m[2]) cls = 's';
    else if (m[3]) cls = 'a';
    else if (m[4]) cls = 'n';
    else if (m[5]) {
      // Case-insensitive, but ONLY for a token written in uniform case.
      //
      // Matching the lowercase set exactly was right for Apex and wrong for
      // SOQL, where the convention is `SELECT Id FROM Account` — every keyword
      // shouted, so nothing in a query highlighted at all. Matching fully
      // case-insensitively is wrong the other way: it paints `Set<Id>`, `Date`
      // and `Delete` in Apex, and `Order` and `Group` in SOQL, all of which are
      // far more often types and sObjects.
      //
      // Uniform case separates them cleanly. A keyword is shouted (`FROM`) or
      // quiet (`from`); a type or an sObject is Capitalized (`Order`), and the
      // API never spells one any other way.
      const lower = text.toLowerCase();
      const uniformCase = text === lower || text === text.toUpperCase();
      cls = uniformCase && keywords.has(lower) ? 'k' : /^[A-Z]/.test(text) ? 't' : '';
    }

    out.push({ text, cls });
    last = m.index + text.length;
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: '' });
  return out;
}

export interface CodeEditorOpts {
  /** Accessible name. The textarea has no visible label of its own. */
  ariaLabel: string;
  value?: string;
  placeholder?: string;
  keywords?: ReadonlySet<string>;
  doc?: Document;
}

export interface CodeEditor {
  /** Mount this. */
  root: HTMLElement;
  /** The real textarea — focus it, listen on it, read `.value` in a pinch. */
  input: HTMLTextAreaElement;
  getValue(): string;
  setValue(value: string): void;
  /** Re-render gutter + highlight. Call after mutating `input.value` directly. */
  refresh(): void;
}

export function createCodeEditor(opts: CodeEditorOpts): CodeEditor {
  const doc = opts.doc ?? document;
  const keywords = opts.keywords ?? APEX_KEYWORDS;
  ensureComponentStyles(doc);

  const root = doc.createElement('div');
  root.className = 'sfdt-editor';

  // Decorative: the numbers duplicate information the textarea already exposes
  // positionally, and a screen reader announcing "1 2 3 4 5" before the code
  // would be pure noise.
  const gutter = doc.createElement('div');
  gutter.className = 'sfdt-editor-gutter';
  gutter.setAttribute('aria-hidden', 'true');

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'sfdt-editor-body';

  const highlight = doc.createElement('pre');
  highlight.className = 'sfdt-editor-hl';
  highlight.setAttribute('aria-hidden', 'true');

  const input = doc.createElement('textarea');
  input.className = 'sfdt-editor-input';
  input.spellcheck = false;
  // Soft wrapping would put one logical line on several visual rows, and the
  // gutter — which counts logical lines — would drift further out of alignment
  // with every wrapped line. Horizontal scroll is also just what a code editor
  // does.
  input.setAttribute('wrap', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('aria-label', opts.ariaLabel);
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.value = opts.value ?? '';

  bodyEl.appendChild(highlight);
  bodyEl.appendChild(input);
  root.appendChild(gutter);
  root.appendChild(bodyEl);

  function paint(): void {
    const src = input.value;

    const lineCount = src.split('\n').length;
    const nums: string[] = [];
    for (let i = 1; i <= lineCount; i++) nums.push(String(i));
    gutter.textContent = nums.join('\n');

    highlight.textContent = '';
    if (src.length > MAX_HIGHLIGHT_CHARS) {
      highlight.textContent = src;
    } else {
      for (const tok of tokenizeCode(src, keywords)) {
        if (!tok.cls) {
          highlight.appendChild(doc.createTextNode(tok.text));
          continue;
        }
        const span = doc.createElement('span');
        span.className = `sfdt-tok-${tok.cls}`;
        span.textContent = tok.text;
        highlight.appendChild(span);
      }
    }
    // A `<pre>` drops a single trailing newline, so without this the highlight
    // layer is one line shorter than the textarea and the last line scrolls out
    // of sync at the bottom of a long buffer.
    highlight.appendChild(doc.createTextNode('\n'));
  }

  function sync(): void {
    highlight.scrollTop = input.scrollTop;
    highlight.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  }

  input.addEventListener('input', () => {
    paint();
    sync();
  });
  input.addEventListener('scroll', sync);

  paint();

  return {
    root,
    input,
    getValue: () => input.value,
    setValue(value: string) {
      input.value = value;
      paint();
      sync();
    },
    refresh() {
      paint();
      sync();
    },
  };
}
