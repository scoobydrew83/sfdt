import { describe, it, expect, vi, beforeEach } from 'vitest';

const execaSpy = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaSpy }));

import { isToolAvailable } from '../../src/lib/tool-check.js';

beforeEach(() => vi.resetAllMocks());

describe('isToolAvailable', () => {
  it('reports available with the first stdout line as version when exit code is 0', async () => {
    execaSpy.mockResolvedValue({ exitCode: 0, stdout: '@salesforce/cli/2.100.0 darwin-arm64\nnode-v22', stderr: '' });
    const res = await isToolAvailable('sf');
    expect(res).toEqual({ available: true, version: '@salesforce/cli/2.100.0 darwin-arm64' });
    expect(execaSpy).toHaveBeenCalledWith('sf', ['--version'], { reject: false });
  });

  it('reports unavailable when the binary is missing (non-zero exit)', async () => {
    execaSpy.mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'not found' });
    const res = await isToolAvailable('sf');
    expect(res).toEqual({ available: false, version: null });
  });

  it('reports unavailable when execa throws (ENOENT)', async () => {
    execaSpy.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const res = await isToolAvailable('git', ['--version']);
    expect(res).toEqual({ available: false, version: null });
  });
});
