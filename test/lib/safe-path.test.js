/**
 * Containment guards shared by the MCP and GUI surfaces (sfdt-private#5, #6).
 *
 * These are the checks that stop a model-supplied path argument from reaching
 * `sf apex run --file` or a data-set directory outside the project, so each
 * rejection case here is an exploit case in the issues.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { SET_RE, resolveInProject, assertSetName } from '../../src/lib/safe-path.js';
import { dataSetDir } from '../../src/lib/data-runner.js';

const ROOT = path.resolve('/tmp/sfdt-project');

describe('resolveInProject', () => {
  it('rejects an absolute path', () => {
    // path.resolve() returns an absolute input verbatim — this is the
    // sfdt_apex_run arbitrary-file-read case.
    expect(() => resolveInProject(ROOT, '/Users/victim/.sf/alias.json')).toThrow(/absolute/);
  });

  it('rejects a "../" escape', () => {
    expect(() => resolveInProject(ROOT, '../../etc/passwd')).toThrow(/\.\./);
  });

  it('rejects a "../" escape buried mid-path', () => {
    expect(() => resolveInProject(ROOT, 'force-app/../../outside/x.apex')).toThrow(/\.\./);
  });

  it('rejects backslash-separated traversal', () => {
    expect(() => resolveInProject(ROOT, '..\\..\\outside')).toThrow(/\.\./);
  });

  it('rejects a non-string and an empty string', () => {
    expect(() => resolveInProject(ROOT, null)).toThrow(/non-empty string/);
    expect(() => resolveInProject(ROOT, 42)).toThrow(/non-empty string/);
    expect(() => resolveInProject(ROOT, '')).toThrow(/non-empty string/);
  });

  it('resolves a legitimate in-project relative path', () => {
    expect(resolveInProject(ROOT, 'scripts/seed.apex')).toBe(path.join(ROOT, 'scripts', 'seed.apex'));
  });

  it('resolves "." to the root itself', () => {
    expect(resolveInProject(ROOT, '.')).toBe(ROOT);
  });

  it('does not accept a sibling directory sharing the root prefix', () => {
    // `/tmp/sfdt-project-evil` starts with the root string but is not inside
    // it — the separator in the containment check is what rejects it.
    expect(() => resolveInProject(ROOT, '../sfdt-project-evil/x')).toThrow();
  });

  it('names the parameter in the error so the caller knows which one failed', () => {
    expect(() => resolveInProject(ROOT, '/abs', 'manifest')).toThrow(/Invalid manifest/);
  });
});

describe('assertSetName / SET_RE', () => {
  it('rejects a traversal used as a data-set name', () => {
    // The sfdt_data_export case: no confirmExecution gates this tool.
    expect(() => assertSetName('../../../../tmp/stage')).toThrow(/Invalid data set name/);
  });

  it('rejects dots, slashes and a leading dash', () => {
    for (const bad of ['..', 'a/b', 'a.b', '-flag', '', 'a b']) {
      expect(SET_RE.test(bad), bad).toBe(false);
    }
  });

  it('accepts a legitimate set name', () => {
    expect(assertSetName('seed-data')).toBe('seed-data');
    expect(SET_RE.test('Accounts_v2')).toBe(true);
  });
});

describe('dataSetDir containment', () => {
  const config = { _projectRoot: ROOT };

  it('rejects a traversing set name at the sink', () => {
    // Guarding the sink rather than each handler is what covers sfdt_data_load
    // too — a fourth caller the original report did not list.
    expect(() => dataSetDir(config, '../../../../tmp/stage')).toThrow(/Invalid data set name/);
  });

  it('still resolves a legitimate set name under the data dir', () => {
    expect(dataSetDir(config, 'seed-data')).toBe(path.join(ROOT, '.sfdt/data', 'seed-data'));
  });

  it('honours a configured data dir', () => {
    expect(dataSetDir({ ...config, data: { dir: 'fixtures' } }, 'seed'))
      .toBe(path.join(ROOT, 'fixtures', 'seed'));
  });
});
