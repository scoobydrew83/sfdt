import { describe, it, expect } from 'vitest';
import { buildSourceDirArgs } from '../../src/lib/source-dirs.js';

describe('buildSourceDirArgs', () => {
  it('builds args from packageDirectories', () => {
    const config = {
      packageDirectories: [
        { name: 'core', path: 'force-app/main/default' },
        { name: 'marketing', path: 'force-app/marketing' },
      ],
    };
    expect(buildSourceDirArgs(config)).toEqual([
      '--source-dir', 'force-app/main/default',
      '--source-dir', 'force-app/marketing',
    ]);
  });

  it('falls back to defaultSourcePath when packageDirectories is empty', () => {
    expect(buildSourceDirArgs({ packageDirectories: [], defaultSourcePath: 'src/main' }))
      .toEqual(['--source-dir', 'src/main']);
  });

  it('falls back to the conventional default when nothing is configured', () => {
    expect(buildSourceDirArgs({})).toEqual(['--source-dir', 'force-app/main/default']);
  });
});
