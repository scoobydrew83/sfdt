import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
import { loadConfig } from '../../src/lib/config.js';
import { generateCi } from '../../src/commands/ci.js';

beforeEach(() => {
  vi.resetAllMocks();
  loadConfig.mockResolvedValue({ defaultOrg: 'devhub' });
});

describe('generateCi', () => {
  it('interpolates cron, org, and node into a github monitor template', async () => {
    const r = await generateCi({ provider: 'github', type: 'monitor', cron: '15 3 * * 1', node: '22' });
    expect(r.content).toContain("cron: '15 3 * * 1'");
    expect(r.content).toContain('--org devhub');
    expect(r.content).toContain("node-version: '22'");
    // GitHub ${{ secrets.X }} expressions must survive interpolation untouched.
    expect(r.content).toContain('${{ secrets.SFDX_AUTH_URL }}');
    expect(r.content).not.toMatch(/\{\{(cron|org|nodeVersion|deltaBase)\}\}/);
  });

  it('interpolates the delta base into a deploy template', async () => {
    const r = await generateCi({ provider: 'gitlab', type: 'deploy', org: 'uat' });
    expect(r.content).toContain('--org uat');
    expect(r.type).toBe('deploy');
  });

  it('falls back to a placeholder org when none is configured', async () => {
    loadConfig.mockRejectedValueOnce(new Error('no project'));
    const r = await generateCi({ provider: 'github', type: 'monitor' });
    expect(r.orgMissing).toBe(true);
    expect(r.content).toContain('YOUR_ORG_ALIAS');
  });

  it('rejects an unknown provider', async () => {
    await expect(generateCi({ provider: 'jenkins', type: 'monitor' })).rejects.toThrow('--provider');
  });

  it('rejects an unknown type', async () => {
    await expect(generateCi({ provider: 'github', type: 'bogus' })).rejects.toThrow('--type');
  });

  it('produces a template for every provider/type combination', async () => {
    for (const provider of ['github', 'gitlab', 'azure', 'bitbucket']) {
      for (const type of ['monitor', 'deploy']) {
        const r = await generateCi({ provider, type, org: 'x' });
        expect(r.content.length).toBeGreaterThan(0);
        expect(r.content).not.toMatch(/\{\{\w+\}\}/);
      }
    }
  });
});

describe('runCiInit (write)', () => {
  it('writes the workflow to the requested --out path', async () => {
    const { runCiInit } = await import('../../src/commands/ci.js');
    const out = path.join(os.tmpdir(), `sfdt-ci-${process.pid}-${Date.now()}.yml`);
    await runCiInit({ provider: 'github', type: 'monitor', org: 'dev', out, json: true });
    expect(await fs.pathExists(out)).toBe(true);
    const written = await fs.readFile(out, 'utf-8');
    expect(written).toContain('SFDT Org Monitoring');
    await fs.remove(out);
  });
});
