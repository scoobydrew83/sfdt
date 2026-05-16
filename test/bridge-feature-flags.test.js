import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDisabledFeatures } from '../src/lib/bridge/feature-flags.js';
describe('readDisabledFeatures', () => {
  let tmp;
  beforeEach(async () => {
    tmp = join(tmpdir(), `sfdt-ff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp, { recursive: true });
    await mkdir(join(tmp, '.sfdt'), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  it('returns [] when feature-flags.json does not exist', async () => {
    expect(await readDisabledFeatures(tmp)).toEqual([]);
  });
  it('returns the disabled array when the file is well-formed', async () => {
    await writeFile(
      join(tmp, '.sfdt', 'feature-flags.json'),
      JSON.stringify({ disabled: ['canvas-search', 'flow-deploy'] }),
    );
    expect(await readDisabledFeatures(tmp)).toEqual(['canvas-search', 'flow-deploy']);
  });
  it('returns [] and logs a warning when JSON is malformed', async () => {
    await writeFile(join(tmp, '.sfdt', 'feature-flags.json'), '{ this is not json');
    const warnings = [];
    expect(
      await readDisabledFeatures(tmp, { onWarn: (m) => warnings.push(m) }),
    ).toEqual([]);
    expect(warnings.join('\n')).toContain('feature-flags.json');
  });
  it('returns [] when "disabled" is missing or wrong type', async () => {
    await writeFile(
      join(tmp, '.sfdt', 'feature-flags.json'),
      JSON.stringify({ disabled: 'not an array' }),
    );
    expect(await readDisabledFeatures(tmp)).toEqual([]);
  });
  it('filters non-string entries', async () => {
    await writeFile(
      join(tmp, '.sfdt', 'feature-flags.json'),
      JSON.stringify({ disabled: ['canvas-search', 42, null, 'flow-deploy'] }),
    );
    expect(await readDisabledFeatures(tmp)).toEqual(['canvas-search', 'flow-deploy']);
  });
});
