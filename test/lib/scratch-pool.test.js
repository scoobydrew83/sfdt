import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('fs-extra', () => ({ default: { readJson: vi.fn(), writeJson: vi.fn(), ensureDir: vi.fn() } }));

import { execa } from 'execa';
import fs from 'fs-extra';
import {
  buildCreateArgs,
  poolDeficit,
  poolFile,
  createScratch,
  deleteScratch,
  listScratch,
  ensurePool,
  readPool,
} from '../../src/lib/scratch-pool.js';

const config = { _projectRoot: '/project', scratch: { definitionFile: 'config/def.json', durationDays: 5, poolSize: 2 } };

beforeEach(() => vi.resetAllMocks());

describe('buildCreateArgs', () => {
  it('includes definition file, alias, and duration', () => {
    const args = buildCreateArgs({ definitionFile: 'config/def.json', alias: 'a', durationDays: 7 });
    expect(args).toEqual(expect.arrayContaining(['org', 'create', 'scratch', '--definition-file', 'config/def.json', '--alias', 'a', '--duration-days', '7', '--json']));
  });
  it('omits alias and duration when not provided', () => {
    const args = buildCreateArgs({ definitionFile: 'd.json' });
    expect(args).not.toContain('--alias');
    expect(args).not.toContain('--duration-days');
  });
});

describe('poolDeficit', () => {
  it('computes how many more orgs are needed', () => {
    expect(poolDeficit({ members: [1] }, 3)).toBe(2);
    expect(poolDeficit({ members: [1, 2, 3] }, 2)).toBe(0);
    expect(poolDeficit({}, 2)).toBe(2);
  });
});

describe('poolFile', () => {
  it('resolves under .sfdt', () => {
    expect(poolFile(config)).toBe('/project/.sfdt/scratch-pool.json');
  });
});

describe('createScratch', () => {
  it('creates from the configured definition file and parses the result', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: { username: 'u@scratch', orgId: '00D', expirationDate: '2026-07-01' } }) });
    const org = await createScratch(config, { alias: 'dev' });
    expect(org).toMatchObject({ alias: 'dev', username: 'u@scratch', orgId: '00D' });
    expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['--definition-file', 'config/def.json', '--duration-days', '5']));
  });
});

describe('deleteScratch', () => {
  it('deletes by target with --no-prompt', async () => {
    execa.mockResolvedValueOnce({ stdout: '{}' });
    expect(await deleteScratch('dev')).toEqual({ deleted: 'dev' });
    expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['org', 'delete', 'scratch', '--target-org', 'dev', '--no-prompt']));
  });
});

describe('listScratch', () => {
  it('maps the scratchOrgs array', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: { scratchOrgs: [{ alias: 'a', username: 'u', orgId: '1', expirationDate: 'd' }] } }) });
    const orgs = await listScratch();
    expect(orgs).toEqual([{ alias: 'a', username: 'u', orgId: '1', expirationDate: 'd', status: null }]);
  });
});

describe('ensurePool', () => {
  it('creates orgs to reach the desired size and persists state', async () => {
    fs.readJson.mockResolvedValueOnce({ size: 2, members: [] });
    execa.mockResolvedValue({ stdout: JSON.stringify({ result: { username: 'u@scratch', orgId: '00D' } }) });
    fs.ensureDir.mockResolvedValue(undefined);
    fs.writeJson.mockResolvedValue(undefined);
    const res = await ensurePool(config, { desiredSize: 2 });
    expect(res.created).toBe(2);
    expect(res.members).toHaveLength(2);
    expect(fs.writeJson).toHaveBeenCalled();
  });

  it('creates nothing when the pool is already full', async () => {
    fs.readJson.mockResolvedValueOnce({ size: 2, members: [{ username: 'a' }, { username: 'b' }] });
    fs.writeJson.mockResolvedValue(undefined);
    const res = await ensurePool(config, { desiredSize: 2 });
    expect(res.created).toBe(0);
    expect(execa).not.toHaveBeenCalled();
  });
});

describe('readPool', () => {
  it('falls back to a default pool when the file is missing', async () => {
    fs.readJson.mockRejectedValueOnce(new Error('ENOENT'));
    expect(await readPool(config)).toEqual({ size: 2, members: [] });
  });
});
