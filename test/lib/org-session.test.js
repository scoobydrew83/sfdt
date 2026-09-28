import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { getOrgId, isSandboxOrg, getOrgUsername } from '../../src/lib/org-session.js';

const display = (result) => ({ stdout: JSON.stringify({ status: 0, result }) });

beforeEach(() => { vi.mocked(execa).mockReset(); });

describe('org-session accessors', () => {
  it('getOrgId returns the org ID from sf org display', async () => {
    vi.mocked(execa).mockResolvedValue(display({ id: '00D000000000001AAA', accessToken: 'x' }));
    await expect(getOrgId('prod')).resolves.toBe('00D000000000001AAA');
    expect(execa).toHaveBeenCalledWith('sf', ['org', 'display', '--target-org', 'prod', '--json']);
  });

  it('getOrgId never throws — a failed lookup is null', async () => {
    vi.mocked(execa).mockRejectedValue(Object.assign(new Error('boom'), { stdout: '{"message":"No authorization"}' }));
    await expect(getOrgId('prod')).resolves.toBeNull();
    vi.mocked(execa).mockResolvedValue(display({}));
    await expect(getOrgId('prod')).resolves.toBeNull();
    await expect(getOrgId(undefined)).resolves.toBeNull();
  });

  it('isSandboxOrg is true only for isSandbox: true', async () => {
    vi.mocked(execa).mockResolvedValue(display({ isSandbox: true }));
    await expect(isSandboxOrg('dev')).resolves.toBe(true);
    vi.mocked(execa).mockResolvedValue(display({}));
    await expect(isSandboxOrg('dev')).resolves.toBe(false);
  });

  it("getOrgUsername surfaces sf's structured error message", async () => {
    const execaErr = Object.assign(new Error('execa noise'), { stdout: '{"message":"No authorization found for dev"}' });
    vi.mocked(execa).mockRejectedValue(execaErr);
    let thrown;
    try {
      await getOrgUsername('dev');
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.message).toBe('No authorization found for dev');
  });
});
