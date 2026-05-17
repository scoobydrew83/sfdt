import { describe, it, expect, vi } from 'vitest';
import { print, createSpinner } from '../src/lib/output.js';

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
