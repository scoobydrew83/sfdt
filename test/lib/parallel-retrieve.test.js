import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { parallelRetrieve } from '../../src/lib/parallel-retrieve.js';

const CONFIG = { pullCache: { batchSize: 2, parallelism: 2 } };

beforeEach(() => {
  vi.resetAllMocks();
  execa.mockResolvedValue({ exitCode: 0 });
});

describe('parallelRetrieve', () => {
  it('returns zero retrieved when delta is empty', async () => {
    const result = await parallelRetrieve(new Map(), CONFIG, { cwd: '/project' });
    expect(result).toEqual({ retrieved: 0, total: 0, errors: [] });
    expect(execa).not.toHaveBeenCalled();
  });

  it('calls sf project retrieve start with --metadata args', async () => {
    const delta = new Map([['ApexClass', new Set(['MyClass'])]]);
    const result = await parallelRetrieve(delta, CONFIG, { cwd: '/project' });
    expect(execa).toHaveBeenCalledWith(
      'sf',
      expect.arrayContaining(['project', 'retrieve', 'start', '--metadata', 'ApexClass:MyClass']),
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(result.retrieved).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('chunks members into batches of batchSize', async () => {
    const delta = new Map([['ApexClass', new Set(['A', 'B', 'C'])]]);
    await parallelRetrieve(delta, CONFIG, { cwd: '/project' });
    expect(execa).toHaveBeenCalledTimes(2);
  });

  it('collects errors without aborting other batches', async () => {
    execa.mockRejectedValueOnce(new Error('retrieve failed')).mockResolvedValueOnce({ exitCode: 0 });
    const delta = new Map([['ApexClass', new Set(['A', 'B', 'C'])]]);
    const result = await parallelRetrieve(delta, CONFIG, { cwd: '/project' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('retrieve failed');
    expect(result.retrieved).toBe(1);
  });

  it('calls onProgress callback after each window of batches', async () => {
    const onProgress = vi.fn();
    const delta = new Map([['ApexClass', new Set(['A', 'B', 'C'])]]);
    // parallelism: 1 → each batch is its own window → 2 batches → 2 onProgress calls
    await parallelRetrieve(delta, { pullCache: { batchSize: 2, parallelism: 1 } }, { cwd: '/project', onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});
