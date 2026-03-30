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

  it('print.header outputs formatted title', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    print.header('Test Header');
    // header calls console.log 4 times (blank, line, title, line, blank)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Test Header'));
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
});
