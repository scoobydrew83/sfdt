import { describe, it, expect, beforeEach } from 'vitest';
import {
  APEX_KEYWORDS,
  SOQL_KEYWORDS,
  createCodeEditor,
  tokenizeCode,
} from '../lib/code-editor.js';

/** Concatenated token text must always reconstruct the input exactly. */
function roundTrip(src: string): string {
  return tokenizeCode(src)
    .map((t) => t.text)
    .join('');
}

function classOf(
  src: string,
  text: string,
  keywords: ReadonlySet<string> = APEX_KEYWORDS,
): string | undefined {
  return tokenizeCode(src, keywords).find((t) => t.text === text)?.cls;
}

describe('tokenizeCode', () => {
  it('is lossless — the tokens always rebuild the source', () => {
    // The single property that matters: the highlight layer must render the
    // same characters as the textarea it sits under. Any dropped or duplicated
    // character shifts every glyph after it out of alignment with the caret.
    const samples = [
      '',
      'x',
      "System.debug('hi');",
      '// trailing comment',
      '/* unclosed',
      "'unterminated string",
      '@isTest\nprivate class T {}',
      'List<Account> a = [SELECT Id FROM Account LIMIT 10];',
      '\n\n\t  \n',
      'a/*b*/c//d\ne',
    ];
    for (const src of samples) expect(roundTrip(src)).toBe(src);
  });

  it('classifies the six token roles', () => {
    const src = "@isTest\n// note\nInteger n = 42; String s = 'hi'; public void go() {}";
    expect(classOf(src, '@isTest')).toBe('a');
    expect(classOf(src, '// note')).toBe('c');
    expect(classOf(src, '42')).toBe('n');
    expect(classOf(src, "'hi'")).toBe('s');
    expect(classOf(src, 'public')).toBe('k');
    expect(classOf(src, 'Integer')).toBe('t');
  });

  it('treats CAPITALIZED words as types, not keywords', () => {
    // Apex is case-insensitive, so a fully case-insensitive keyword match would
    // paint Set/Date/Delete as keywords. Those appear far more often as types.
    expect(classOf('Set<Id> ids;', 'Set')).toBe('t');
    expect(classOf('Date d;', 'Date')).toBe('t');
    expect(classOf('set { x = 1; }', 'set')).toBe('k');
    expect(APEX_KEYWORDS.has('set')).toBe(true);
    expect(APEX_KEYWORDS.has('Set')).toBe(false);
  });

  it('DOES claim a shouted keyword, which is how SOQL is written', () => {
    // Exact-matching the lowercase set left `SELECT Id FROM Account` — the
    // conventional spelling of every query — with no highlighting whatsoever,
    // because each keyword was uppercase and fell through to the type rule.
    // Uniform case is the discriminator: shouted or quiet is a keyword,
    // Capitalized is a type or an sObject.
    expect(classOf('SELECT Id FROM Account', 'FROM', SOQL_KEYWORDS)).toBe('k');
    expect(classOf('SELECT Id FROM Account', 'SELECT', SOQL_KEYWORDS)).toBe('k');
    expect(classOf('select id from account', 'from', SOQL_KEYWORDS)).toBe('k');
    // …and the sObjects whose names ARE keywords stay sObjects, which is the
    // whole reason this is not just a `toLowerCase()` on both sides.
    expect(classOf('SELECT Id FROM Order', 'Order', SOQL_KEYWORDS)).toBe('t');
    expect(classOf('SELECT Id FROM Group', 'Group', SOQL_KEYWORDS)).toBe('t');
    // Apex gains the same fix for its inline SOQL, and keeps its type rule.
    expect(classOf('List<Account> a = [SELECT Id FROM Account];', 'SELECT')).toBe('k');
    expect(classOf('Delete d;', 'Delete')).toBe('t');
    expect(classOf('DELETE accounts;', 'DELETE')).toBe('k');
  });

  it('does not let an apostrophe inside a comment open a string', () => {
    const toks = tokenizeCode("// it's fine\nInteger n = 1;");
    expect(toks[0]).toEqual({ text: "// it's fine", cls: 'c' });
    // The rest of the line after the comment must still tokenize normally —
    // i.e. the apostrophe did not swallow it.
    expect(classOf("// it's fine\nInteger n = 1;", '1')).toBe('n');
  });

  it('keeps an unterminated string on its own line', () => {
    // Mid-keystroke state: the user has typed the opening quote and nothing
    // else. Without the newline bound this eats the remainder of the buffer.
    const src = "String s = 'oops\nInteger n = 7;";
    expect(classOf(src, '7')).toBe('n');
    expect(classOf(src, 'Integer')).toBe('t');
  });

  it('accepts an alternate keyword set', () => {
    expect(tokenizeCode('select', SOQL_KEYWORDS).find((t) => t.text === 'select')?.cls).toBe('k');
    expect(tokenizeCode('offset', SOQL_KEYWORDS).find((t) => t.text === 'offset')?.cls).toBe('k');
    expect(tokenizeCode('offset', APEX_KEYWORDS).find((t) => t.text === 'offset')?.cls).toBe('');
  });
});

describe('createCodeEditor', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  function mount(value = ''): ReturnType<typeof createCodeEditor> {
    const ed = createCodeEditor({ ariaLabel: 'Anonymous Apex', value });
    document.body.appendChild(ed.root);
    return ed;
  }

  it('numbers every line, and keeps the count in step with edits', () => {
    const ed = mount('a\nb\nc');
    const gutter = ed.root.querySelector('.sfdt-editor-gutter')!;
    expect(gutter.textContent).toBe('1\n2\n3');

    ed.setValue('a\nb\nc\nd\ne');
    expect(gutter.textContent).toBe('1\n2\n3\n4\n5');

    // A trailing newline opens a real (empty) line, and the caret can sit on it.
    ed.setValue('a\n');
    expect(gutter.textContent).toBe('1\n2');
  });

  it('renders the highlight layer with the same text as the textarea', () => {
    const ed = mount("System.debug('hi');");
    const hl = ed.root.querySelector('.sfdt-editor-hl')!;
    // The builder appends one trailing newline because <pre> swallows it.
    expect(hl.textContent).toBe("System.debug('hi');\n");
    expect(hl.querySelector('.sfdt-tok-s')?.textContent).toBe("'hi'");
  });

  it('repaints on input', () => {
    const ed = mount('');
    ed.input.value = 'Integer n = 1;';
    ed.input.dispatchEvent(new Event('input'));
    const hl = ed.root.querySelector('.sfdt-editor-hl')!;
    expect(hl.querySelector('.sfdt-tok-t')?.textContent).toBe('Integer');
    expect(ed.root.querySelector('.sfdt-editor-gutter')!.textContent).toBe('1');
  });

  it('gives the textarea an accessible name and hides the decorative layers', () => {
    const ed = mount('x');
    expect(ed.input.getAttribute('aria-label')).toBe('Anonymous Apex');
    expect(ed.root.querySelector('.sfdt-editor-gutter')!.getAttribute('aria-hidden')).toBe('true');
    expect(ed.root.querySelector('.sfdt-editor-hl')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not soft-wrap — wrapping would desync the gutter', () => {
    expect(mount('x').input.getAttribute('wrap')).toBe('off');
  });

  it('builds the highlight layer without innerHTML (markup in source stays text)', () => {
    // DOM discipline check with teeth: if any path ever used innerHTML, this
    // source would produce an element rather than a text node.
    const ed = mount("String s = '<img src=x onerror=1>';");
    const hl = ed.root.querySelector('.sfdt-editor-hl')!;
    expect(hl.querySelector('img')).toBeNull();
    expect(hl.textContent).toContain('<img src=x onerror=1>');
  });
});
