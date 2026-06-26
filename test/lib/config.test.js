import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    pathExistsSync: vi.fn(),
    readJson: vi.fn(),
  },
}));

import fs from 'fs-extra';
import { loadConfig, validateConfig, ConfigError, getConfigDir } from '../../src/lib/config.js';

const PROJECT = '/proj';
const CONFIG_PATH = `${PROJECT}/.sfdt/config.json`;
const SFDX_PATH = `${PROJECT}/sfdx-project.json`;

const VALID_CONFIG = { defaultOrg: 'dev-org', features: { ai: false } };

/**
 * Configure the mocked filesystem. `existing` is the set of paths that exist
 * (both sync and async checks); `json` maps path → parsed content or Error.
 */
function setupFs({ existing = [], json = {} } = {}) {
  const exists = new Set(existing);
  fs.pathExistsSync.mockImplementation((p) => exists.has(p));
  fs.pathExists.mockImplementation(async (p) => exists.has(p));
  fs.readJson.mockImplementation(async (p) => {
    const value = json[p];
    if (value === undefined) {
      if (exists.has(p)) return {};
      throw new Error(`ENOENT: ${p}`);
    }
    if (value instanceof Error) throw value;
    return value;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('loads a valid config and applies defaults', async () => {
    setupFs({
      existing: [SFDX_PATH, `${PROJECT}/.sfdt`, CONFIG_PATH],
      json: { [CONFIG_PATH]: VALID_CONFIG },
    });

    const config = await loadConfig(PROJECT);
    expect(config.defaultOrg).toBe('dev-org');
    expect(config._configDir).toBe(`${PROJECT}/.sfdt`);
    expect(config._projectRoot).toBe(PROJECT);
    expect(config.manifestLayout).toBe('flat');
    expect(config.changelogDir).toBe('changelogs');
  });

  it('walks up from a nested directory to find the project root', async () => {
    setupFs({
      existing: [SFDX_PATH, `${PROJECT}/.sfdt`, CONFIG_PATH],
      json: { [CONFIG_PATH]: VALID_CONFIG },
    });

    const config = await loadConfig(`${PROJECT}/force-app/main/default`);
    expect(config._projectRoot).toBe(PROJECT);
  });

  it('merges sibling config files like environments.json', async () => {
    const envPath = `${PROJECT}/.sfdt/environments.json`;
    setupFs({
      existing: [SFDX_PATH, `${PROJECT}/.sfdt`, CONFIG_PATH, envPath],
      json: {
        [CONFIG_PATH]: VALID_CONFIG,
        [envPath]: { default: 'qa', orgs: [] },
      },
    });

    const config = await loadConfig(PROJECT);
    expect(config.environments).toEqual({ default: 'qa', orgs: [] });
  });

  it('enriches config from sfdx-project.json', async () => {
    setupFs({
      existing: [
        SFDX_PATH, `${PROJECT}/.sfdt`, CONFIG_PATH,
        `${PROJECT}/force-app`, `${PROJECT}/force-app/marketing`,
      ],
      json: {
        [CONFIG_PATH]: VALID_CONFIG,
        [SFDX_PATH]: {
          sourceApiVersion: '63.0',
          packageDirectories: [
            { path: 'force-app', default: true },
            { path: 'force-app/marketing', name: 'mkt' },
          ],
        },
      },
    });

    const config = await loadConfig(PROJECT);
    expect(config.sourceApiVersion).toBe('63.0');
    expect(config.defaultSourcePath).toBe('force-app/main/default');
    expect(config.packageDirectories).toEqual([
      { path: 'force-app', default: true, absolutePath: `${PROJECT}/force-app`, name: 'force-app' },
      { path: 'force-app/marketing', default: false, absolutePath: `${PROJECT}/force-app/marketing`, name: 'mkt' },
    ]);
  });

  it('warns when a packageDirectories path does not exist on disk', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupFs({
      // force-app exists, ghost-pkg does not
      existing: [SFDX_PATH, `${PROJECT}/.sfdt`, CONFIG_PATH, `${PROJECT}/force-app`],
      json: {
        [CONFIG_PATH]: VALID_CONFIG,
        [SFDX_PATH]: {
          packageDirectories: [
            { path: 'force-app', default: true },
            { path: 'ghost-pkg' },
          ],
        },
      },
    });

    await loadConfig(PROJECT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('ghost-pkg');
    expect(warnSpy.mock.calls[0][0]).not.toContain('force-app,');
  });

  it('does not warn when all packageDirectories exist', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupFs({
      existing: [SFDX_PATH, `${PROJECT}/.sfdt`, CONFIG_PATH, `${PROJECT}/force-app`],
      json: {
        [CONFIG_PATH]: VALID_CONFIG,
        [SFDX_PATH]: { packageDirectories: [{ path: 'force-app', default: true }] },
      },
    });

    await loadConfig(PROJECT);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws ConfigError pointing at sfdt init when config.json is missing', async () => {
    setupFs({ existing: [SFDX_PATH, `${PROJECT}/.sfdt`] });
    await expect(loadConfig(PROJECT)).rejects.toThrow(ConfigError);
    await expect(loadConfig(PROJECT)).rejects.toThrow(/sfdt init/);
  });

  it('throws ConfigError when config.json contains invalid JSON', async () => {
    setupFs({
      existing: [SFDX_PATH, `${PROJECT}/.sfdt`, CONFIG_PATH],
      json: { [CONFIG_PATH]: new SyntaxError('Unexpected token x') },
    });
    await expect(loadConfig(PROJECT)).rejects.toThrow(/valid JSON/);
  });

  it('throws ConfigError when an SFDX project has no .sfdt directory', async () => {
    setupFs({ existing: [SFDX_PATH] });
    await expect(loadConfig(PROJECT)).rejects.toThrow(/no \.sfdt\/ directory/);
  });

  it('throws ConfigError when no project is found walking up', async () => {
    setupFs({ existing: [] });
    await expect(loadConfig('/elsewhere/deep/dir')).rejects.toThrow(/Could not find a Salesforce DX project/);
  });
});

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(() => validateConfig(VALID_CONFIG)).not.toThrow();
  });

  it('rejects non-object configs', () => {
    expect(() => validateConfig(null)).toThrow(ConfigError);
    expect(() => validateConfig('nope')).toThrow(ConfigError);
  });

  it('reports missing required keys with a sfdt init hint', () => {
    expect(() => validateConfig({ features: {} })).toThrow(/missing required keys: defaultOrg/);
  });

  it('rejects wrong-typed fields', () => {
    expect(() => validateConfig({ defaultOrg: 'dev', features: {}, logRetention: 'lots' }))
      .toThrow(ConfigError);
  });

  it('accepts the mcp.parking block written by `sfdt init`', () => {
    // The config template (src/templates/sfdt.config.json) ships mcp.parking and
    // src/lib/mcp-parking.js consumes it — the schema must allow it.
    const config = {
      ...VALID_CONFIG,
      mcp: {
        enabled: true,
        salesforce: { transport: 'stdio', command: 'sf', args: ['mcp', 'start'] },
        parking: { enabled: true, thresholdBytes: 51200, ttlSeconds: 86400, cacheScope: 'session' },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('still rejects an unknown key under mcp.parking', () => {
    const config = { ...VALID_CONFIG, mcp: { parking: { enabled: true, bogusKey: 1 } } };
    expect(() => validateConfig(config)).toThrow(/"mcp\.parking" contains unknown key "bogusKey"/);
  });
});

describe('getConfigDir', () => {
  it('returns the .sfdt path for a valid project', () => {
    setupFs({ existing: [SFDX_PATH, `${PROJECT}/.sfdt`] });
    expect(getConfigDir(PROJECT)).toBe(`${PROJECT}/.sfdt`);
  });
});
