import { describe, it, expect } from 'vitest';
import {
  MAX_TINTED_LINES,
  classifyLogLine,
  renderApexLogBody,
} from '../ui/apex-log-console.js';

const LOG = [
  '62.0 APEX_CODE,FINEST;APEX_PROFILING,INFO',
  '19:55:30.0 (872383)|EXECUTION_STARTED',
  '19:55:30.0 (894973)|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex',
  '19:55:30.0 (1184597)|HEAP_ALLOCATE|[95]|Bytes:3',
  '19:55:30.0 (1392010)|STATEMENT_EXECUTE|[1]',
  '19:55:30.0 (1397840)|USER_DEBUG|[1]|DEBUG|Hello from SFDT',
  '19:55:30.0 (1500000)|FATAL_ERROR|System.NullPointerException',
  '19:55:30.0 (1510000)|LIMIT_USAGE_FOR_NS|(default)|',
  '19:55:30.0 (1562301)|EXECUTION_FINISHED',
].join('\n');

describe('classifyLogLine', () => {
  it('lifts the three things anyone opened the log for', () => {
    expect(classifyLogLine('19:55:30.0 (1)|USER_DEBUG|[1]|DEBUG|hi')).toBe('sfdt-log-debug');
    expect(classifyLogLine('19:55:30.0 (1)|FATAL_ERROR|boom')).toBe('sfdt-log-error');
    expect(classifyLogLine('19:55:30.0 (1)|EXCEPTION_THROWN|[3]|boom')).toBe('sfdt-log-error');
    expect(classifyLogLine('19:55:30.0 (1)|LIMIT_USAGE_FOR_NS|(default)|')).toBe('sfdt-log-limit');
    expect(classifyLogLine('19:55:30.0 (1)|CUMULATIVE_LIMIT_USAGE')).toBe('sfdt-log-limit');
  });

  it('dims the chatter that makes up the bulk of a FINEST log', () => {
    expect(classifyLogLine('19:55:30.0 (1)|HEAP_ALLOCATE|[95]|Bytes:3')).toBe('sfdt-log-noise');
    expect(classifyLogLine('19:55:30.0 (1)|STATEMENT_EXECUTE|[1]')).toBe('sfdt-log-noise');
    expect(classifyLogLine('19:55:30.0 (1)|VARIABLE_SCOPE_BEGIN|[1]|x')).toBe('sfdt-log-noise');
    expect(classifyLogLine('19:55:30.0 (1)|SYSTEM_METHOD_ENTRY|[1]|f()')).toBe('sfdt-log-noise');
  });

  it('marks the execution frame', () => {
    expect(classifyLogLine('19:55:30.0 (1)|EXECUTION_STARTED')).toBe('sfdt-log-frame');
    expect(classifyLogLine('19:55:30.0 (1)|CODE_UNIT_FINISHED|x')).toBe('sfdt-log-frame');
  });

  it('leaves the header and unrecognised lines alone', () => {
    // The header has no pipes at all — it must not be read as an event type.
    expect(classifyLogLine('62.0 APEX_CODE,FINEST;DB,INFO')).toBe('');
    expect(classifyLogLine('')).toBe('');
    expect(classifyLogLine('19:55:30.0 (1)|SOME_FUTURE_EVENT|x')).toBe('');
  });
});

describe('renderApexLogBody', () => {
  function render(text: string): HTMLPreElement {
    const pre = document.createElement('pre');
    renderApexLogBody(pre, text, document);
    return pre;
  }

  it('is lossless — textContent still equals the log', () => {
    // This is what makes select-all-copy produce the log rather than one
    // unbroken line, and it is why the newlines are text nodes, not CSS.
    expect(render(LOG).textContent).toBe(LOG);
    expect(render('').textContent).toBe('');
    expect(render('a\n\nb\n').textContent).toBe('a\n\nb\n');
  });

  it('tints the lines that classify and leaves the rest as text', () => {
    const pre = render(LOG);
    expect(pre.querySelector('.sfdt-log-debug')?.textContent).toContain('Hello from SFDT');
    expect(pre.querySelector('.sfdt-log-error')?.textContent).toContain('NullPointerException');
    expect(pre.querySelectorAll('.sfdt-log-noise')).toHaveLength(2);
    expect(pre.querySelectorAll('.sfdt-log-frame')).toHaveLength(3);
    // The header line produced no element at all.
    expect(pre.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  it('falls back to plain text past the element-count cap', () => {
    // Element count, not byte count, is what makes a pane janky.
    const huge = Array.from({ length: MAX_TINTED_LINES + 1 }, () => '1|USER_DEBUG|x').join('\n');
    const pre = render(huge);
    expect(pre.querySelectorAll('span')).toHaveLength(0);
    expect(pre.textContent).toBe(huge);
  });

  it('renders org data as text, never as markup', () => {
    // A log carries arbitrary org content — record names, exception messages,
    // query text. This is exactly the input an innerHTML path gets wrong.
    const pre = render("19:55:30.0 (1)|USER_DEBUG|[1]|DEBUG|<img src=x onerror=1>");
    expect(pre.querySelector('img')).toBeNull();
    expect(pre.textContent).toContain('<img src=x onerror=1>');
  });

  it('replaces previous content rather than appending to it', () => {
    const pre = document.createElement('pre');
    renderApexLogBody(pre, 'first', document);
    renderApexLogBody(pre, 'second', document);
    expect(pre.textContent).toBe('second');
  });
});
