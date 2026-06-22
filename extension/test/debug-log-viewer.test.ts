import { describe, it, expect } from 'vitest';
import { _debugLogViewerTestApi } from '../features/debug-log-viewer.js';

const { buildApexLogQuery, formatBytes } = _debugLogViewerTestApi();

describe('debug-log-viewer — buildApexLogQuery', () => {
  it('queries ApexLog ordered by StartTime desc with the given limit', () => {
    const q = buildApexLogQuery(25);
    expect(q).toContain('FROM ApexLog');
    expect(q).toContain('ORDER BY StartTime DESC');
    expect(q).toContain('LIMIT 25');
    expect(q).toContain('LogUser.Name');
  });

  it('clamps the limit into a sane range', () => {
    expect(buildApexLogQuery(0)).toContain('LIMIT 1');
    expect(buildApexLogQuery(9999)).toContain('LIMIT 200');
    expect(buildApexLogQuery(10.7)).toContain('LIMIT 10');
  });
});

describe('debug-log-viewer — formatBytes', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
