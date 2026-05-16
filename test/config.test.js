import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
vi.mock('fs-extra', () => {
  return {
    default: {
      pathExistsSync: vi.fn(),
      pathExists: vi.fn(),
      readJson: vi.fn(),
    },
  };
});
import fs from 'fs-extra';
import { getConfigDir, loadConfig, validateConfig } from '../src/lib/config.js';
beforeEach(() => {
  vi.resetAllMocks();
});
describe('validateConfig', () => {
  it('throws when config is null', () => {
    expect(() => validateConfig(null)).toThrow('config must be a non-null object');
  });
  it('throws when config is not an object', () => {
    expect(() => validateConfig('string')).toThrow('config must be a non-null object');
  });
  it('throws when required keys are missing', () => {
    expect(() => validateConfig({})).toThrow('missing required keys: defaultOrg, features');
  });
  it('throws when features is not an object', () => {
    expect(() => validateConfig({ defaultOrg: 'dev', features: 'yes' })).toThrow(
      '"features" must be an object',
    );
  });
  it('passes with valid config', () => {
    expect(() => validateConfig({ defaultOrg: 'dev', features: { ai: true } })).not.toThrow();
  });
});
describe('getConfigDir', () => {
  it('returns .sfdt path when project root has both markers', () => {
    fs.pathExistsSync.mockImplementation((p) => {
      if (p.endsWith('sfdx-project.json')) return true;
      if (p.endsWith('.sfdt')) return true;
      return false;
    });
    const result = getConfigDir('/fake/project/subdir');
    expect(result).toMatch(/\.sfdt$/);
  });
  it('throws when sfdx-project.json found but no .sfdt dir', () => {
    fs.pathExistsSync.mockImplementation((p) => {
      if (p.endsWith('sfdx-project.json')) return true;
      return false;
    });
    expect(() => getConfigDir('/fake/project')).toThrow("Run 'sfdt init' first");
  });
  it('throws when no project found at all', () => {
    fs.pathExistsSync.mockReturnValue(false);
    expect(() => getConfigDir('/fake/project')).toThrow('Could not find a Salesforce DX project');
  });
});
describe('loadConfig', () => {
  const projectRoot = '/fake/project';
  const configDir = path.join(projectRoot, '.sfdt');
  beforeEach(() => {
    fs.pathExistsSync.mockImplementation((p) => {
      if (p.endsWith('sfdx-project.json')) return true;
      if (p.endsWith('.sfdt')) return true;
      return false;
    });
  });
  it('throws when config.json does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    await expect(loadConfig(projectRoot)).rejects.toThrow("Run 'sfdt init' first");
  });
  it('loads and merges config files', async () => {
    const baseConfig = { defaultOrg: 'dev', features: { ai: true } };
    fs.pathExists.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return true;
      if (p.endsWith('environments.json')) return true;
      if (p.endsWith('sfdx-project.json')) return true;
      return false;
    });
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return baseConfig;
      if (p.endsWith('environments.json')) return { default: 'dev', orgs: [] };
      if (p.endsWith('sfdx-project.json')) {
        return {
          sourceApiVersion: '61.0',
          packageDirectories: [{ path: 'force-app', default: true }],
        };
      }
      return {};
    });
    const result = await loadConfig(projectRoot);
    expect(result.defaultOrg).toBe('dev');
    expect(result.features.ai).toBe(true);
    expect(result.environments).toEqual({ default: 'dev', orgs: [] });
    expect(result._configDir).toBe(configDir);
    expect(result._projectRoot).toBe(projectRoot);
  });
  it('enriches config from sfdx-project.json when values not set', async () => {
    const baseConfig = { defaultOrg: 'dev', features: {} };
    fs.pathExists.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return true;
      if (p.endsWith('sfdx-project.json')) return true;
      return false;
    });
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return baseConfig;
      if (p.endsWith('sfdx-project.json')) {
        return {
          sourceApiVersion: '61.0',
          packageDirectories: [{ path: 'force-app', default: true }, { path: 'unpackaged' }],
        };
      }
      return {};
    });
    const result = await loadConfig(projectRoot);
    expect(result.sourceApiVersion).toBe('61.0');
    expect(result.defaultSourcePath).toBe('force-app/main/default');
    expect(result.packageDirectories).toEqual([
      {
        path: 'force-app',
        default: true,
        absolutePath: path.join(projectRoot, 'force-app'),
        name: 'force-app',
      },
      {
        path: 'unpackaged',
        default: false,
        absolutePath: path.join(projectRoot, 'unpackaged'),
        name: 'unpackaged',
      },
    ]);
    expect(result.manifestLayout).toBe('flat');
  });
  it('does not overwrite existing config values with sfdx-project.json', async () => {
    const baseConfig = {
      defaultOrg: 'dev',
      features: {},
      sourceApiVersion: '59.0',
      defaultSourcePath: 'custom/path',
    };
    fs.pathExists.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return true;
      if (p.endsWith('sfdx-project.json')) return true;
      return false;
    });
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return baseConfig;
      if (p.endsWith('sfdx-project.json')) {
        return {
          sourceApiVersion: '61.0',
          packageDirectories: [{ path: 'force-app', default: true }],
        };
      }
      return {};
    });
    const result = await loadConfig(projectRoot);
    expect(result.sourceApiVersion).toBe('59.0');
    expect(result.defaultSourcePath).toBe('custom/path');
    expect(result.packageDirectories).toEqual([
      {
        path: 'force-app',
        default: true,
        absolutePath: path.join(projectRoot, 'force-app'),
        name: 'force-app',
      },
    ]);
    expect(result.manifestLayout).toBe('flat');
  });
  it('uses first packageDirectory when none marked default', async () => {
    const baseConfig = { defaultOrg: 'dev', features: {} };
    fs.pathExists.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return true;
      if (p.endsWith('sfdx-project.json')) return true;
      return false;
    });
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return baseConfig;
      if (p.endsWith('sfdx-project.json')) {
        return {
          packageDirectories: [{ path: 'src' }, { path: 'lib' }],
        };
      }
      return {};
    });
    const result = await loadConfig(projectRoot);
    expect(result.defaultSourcePath).toBe('src/main/default');
    expect(result.packageDirectories).toEqual([
      {
        path: 'src',
        default: false,
        absolutePath: path.join(projectRoot, 'src'),
        name: 'src',
      },
      {
        path: 'lib',
        default: false,
        absolutePath: path.join(projectRoot, 'lib'),
        name: 'lib',
      },
    ]);
  });
  it('derives name from last path segment for nested package paths', async () => {
    const baseConfig = { defaultOrg: 'dev', features: {} };
    fs.pathExists.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return true;
      if (p.endsWith('sfdx-project.json')) return true;
      return false;
    });
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return baseConfig;
      if (p.endsWith('sfdx-project.json')) {
        return {
          packageDirectories: [{ path: 'force-app/feature-a', default: true }],
        };
      }
      return {};
    });
    const result = await loadConfig(projectRoot);
    expect(result.packageDirectories[0].name).toBe('feature-a');
  });
  it('respects manifestLayout when already set in config', async () => {
    const baseConfig = { defaultOrg: 'dev', features: {}, manifestLayout: 'subpath' };
    fs.pathExists.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return true;
      if (p.endsWith('sfdx-project.json')) return true;
      return false;
    });
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return baseConfig;
      if (p.endsWith('sfdx-project.json')) {
        return {
          packageDirectories: [{ path: 'force-app', default: true }],
        };
      }
      return {};
    });
    const result = await loadConfig(projectRoot);
    expect(result.manifestLayout).toBe('subpath');
  });
  it('defaults manifestLayout to flat when no sfdx-project.json', async () => {
    const baseConfig = { defaultOrg: 'dev', features: {} };
    fs.pathExists.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return true;
      return false;
    });
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('config.json')) return baseConfig;
      return {};
    });
    const result = await loadConfig(projectRoot);
    expect(result.manifestLayout).toBe('flat');
    expect(result.packageDirectories).toBeUndefined();
  });
});
