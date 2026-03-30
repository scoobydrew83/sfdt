import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('fs-extra', () => ({
  default: {
    pathExistsSync: vi.fn(),
    readJson: vi.fn(),
  },
}));

import fs from 'fs-extra';
import { getProjectRoot, detectProject } from '../src/lib/project-detect.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getProjectRoot', () => {
  it('returns directory containing sfdx-project.json', () => {
    fs.pathExistsSync.mockImplementation((p) =>
      p === path.join('/project', 'sfdx-project.json')
    );

    const result = getProjectRoot('/project/src/classes');
    expect(result).toBe('/project');
  });

  it('throws when no sfdx-project.json found', () => {
    fs.pathExistsSync.mockReturnValue(false);
    expect(() => getProjectRoot('/fake/dir')).toThrow('Not inside a Salesforce DX project');
  });
});

describe('detectProject', () => {
  it('returns project metadata from sfdx-project.json', async () => {
    fs.pathExistsSync.mockImplementation((p) =>
      p === path.join('/project', 'sfdx-project.json')
    );

    fs.readJson.mockResolvedValue({
      name: 'my-app',
      sourceApiVersion: '61.0',
      namespace: 'myns',
      packageDirectories: [
        { path: 'force-app', default: true },
        { path: 'unpackaged' },
      ],
    });

    const result = await detectProject('/project');

    expect(result.projectRoot).toBe('/project');
    expect(result.name).toBe('my-app');
    expect(result.sourceApiVersion).toBe('61.0');
    expect(result.namespace).toBe('myns');
    expect(result.packageDirectories).toHaveLength(2);
    expect(result.packageDirectories[0].default).toBe(true);
    expect(result.defaultSourcePath).toBe(
      path.join('/project', 'force-app', 'main', 'default')
    );
  });

  it('throws when packageDirectories is empty', async () => {
    fs.pathExistsSync.mockImplementation((p) =>
      p === path.join('/project', 'sfdx-project.json')
    );

    fs.readJson.mockResolvedValue({ packageDirectories: [] });

    await expect(detectProject('/project')).rejects.toThrow(
      'No packageDirectories defined'
    );
  });

  it('throws when sfdx-project.json is unparseable', async () => {
    fs.pathExistsSync.mockImplementation((p) =>
      p === path.join('/project', 'sfdx-project.json')
    );

    fs.readJson.mockRejectedValue(new Error('Unexpected token'));

    await expect(detectProject('/project')).rejects.toThrow('Failed to parse');
  });

  it('uses basename when no name in project json', async () => {
    fs.pathExistsSync.mockImplementation((p) =>
      p === path.join('/project', 'sfdx-project.json')
    );

    fs.readJson.mockResolvedValue({
      packageDirectories: [{ path: 'force-app', default: true }],
    });

    const result = await detectProject('/project');
    expect(result.name).toBe('project');
  });

  it('uses first packageDirectory when none marked default', async () => {
    fs.pathExistsSync.mockImplementation((p) =>
      p === path.join('/project', 'sfdx-project.json')
    );

    fs.readJson.mockResolvedValue({
      packageDirectories: [{ path: 'src' }, { path: 'lib' }],
    });

    const result = await detectProject('/project');
    expect(result.defaultSourcePath).toBe(
      path.join('/project', 'src', 'main', 'default')
    );
  });
});
