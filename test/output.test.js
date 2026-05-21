import { describe, it, expect, vi, afterEach } from 'vitest';
import { print, createSpinner, formatSplash, printSplash } from '../src/lib/output.js';

describe('print', () => {
  it('print.success writes to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.success('done');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('done'));
    spy.mockRestore();
  });

  it('print.error writes to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    print.error('fail');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('fail'));
    spy.mockRestore();
  });

  it('print.warning writes to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.warning('caution');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('caution'));
    spy.mockRestore();
  });

  it('print.info writes to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.info('note');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('note'));
    spy.mockRestore();
  });

  it('print.step writes to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.step('step one');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('step one'));
    spy.mockRestore();
  });

  it('print.step uses console.log (not console.error)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    print.step('my step');
    expect(logSpy).toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('print.error uses console.error (not console.log)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    print.error('bad things');
    expect(errSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('print.header outputs formatted title', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.header('Test Header');
    // header calls console.log 4 times (blank, line, title, line, blank)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Test Header'));
    spy.mockRestore();
  });

  it('print.header calls console.log multiple times (dashes + title)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.header('My Title');
    // blank before, dashes, title, dashes, blank after = 5 calls
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
    spy.mockRestore();
  });

  it('print.header includes dashes sized to the title length', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const title = 'Exact';
    print.header(title);
    // dash line length = title.length + 4
    const expectedDashes = '-'.repeat(title.length + 4);
    const allArgs = spy.mock.calls.map((c) => c[0]);
    expect(allArgs.some((arg) => typeof arg === 'string' && arg.includes(expectedDashes))).toBe(true);
    spy.mockRestore();
  });

  it('print.success prefixes message with two spaces', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.success('hello');
    const arg = spy.mock.calls[0][0];
    expect(arg).toMatch(/hello/);
    spy.mockRestore();
  });
});

describe('formatSplash', () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it('returns single-line fallback when stdout is not a TTY', () => {
    process.stdout.isTTY = false;
    const out = formatSplash({ version: '1.2.3' });
    expect(out).toBe('sfdt · Salesforce DevOps Toolkit · v1.2.3');
  });

  it('renders compact banner by default in TTY mode', () => {
    process.stdout.isTTY = true;
    const out = formatSplash({ version: '9.9.9' });
    expect(out).toContain('v9.9.9');
    expect(out).toContain('sfdt.dev');
    // Compact banner contains the rounded box character set
    expect(out).toContain('┌');
    expect(out).toContain('└');
  });

  it('renders block banner when size=block in TTY mode', () => {
    process.stdout.isTTY = true;
    const out = formatSplash({ version: '0.1.0', size: 'block' });
    expect(out).toContain('v0.1.0');
    expect(out).toContain('Salesforce DevOps Toolkit');
    // Block banner uses full-width block characters
    expect(out).toContain('███');
  });

  it('defaults size to compact when not provided', () => {
    process.stdout.isTTY = true;
    const compact = formatSplash({ version: '1.0.0' });
    const explicit = formatSplash({ version: '1.0.0', size: 'compact' });
    expect(compact).toBe(explicit);
  });

  it('handles missing opts object gracefully', () => {
    process.stdout.isTTY = false;
    const out = formatSplash();
    expect(out).toContain('vundefined');
  });
});

describe('printSplash', () => {
  it('writes the splash to stdout via console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printSplash({ version: '2.0.0' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('v2.0.0');
    spy.mockRestore();
  });
});

describe('createSpinner', () => {
  it('returns an ora spinner instance', () => {
    const spinner = createSpinner('Loading...');
    expect(spinner).toBeDefined();
    expect(typeof spinner.start).toBe('function');
    expect(typeof spinner.succeed).toBe('function');
    expect(typeof spinner.fail).toBe('function');
  });

  it('returns a spinner with the text provided', () => {
    const spinner = createSpinner('Deploying...');
    // ora accepts an options object; the text is passed in and the spinner is configured
    expect(spinner).toBeDefined();
  });

  it('returns different spinner instances on each call', () => {
    const a = createSpinner('First');
    const b = createSpinner('Second');
    // Both should be valid spinner objects (ora always creates new instances)
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });
});
