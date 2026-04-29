import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/org-inventory.js', () => ({ fetchOrgInventory: vi.fn() }));
vi.mock('../../src/lib/pull-cache.js', () => ({
  initCache: vi.fn(),
  getDelta: vi.fn(),
  updateCache: vi.fn(),
  getCacheStatus: vi.fn(),
  getLastSync: vi.fn(),
}));
vi.mock('../../src/lib/parallel-retrieve.js', () => ({ parallelRetrieve: vi.fn() }));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));
vi.mock('../../src/lib/output.js', () => ({
  print: { header: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('execa', () => ({ execa: vi.fn() }));

import { loadConfig } from '../../src/lib/config.js';
import { fetchOrgInventory } from '../../src/lib/org-inventory.js';
import { initCache, getDelta, updateCache, getCacheStatus } from '../../src/lib/pull-cache.js';
import { parallelRetrieve } from '../../src/lib/parallel-retrieve.js';
import inquirer from 'inquirer';
import { execa } from 'execa';
import { registerPullCommand } from '../../src/commands/pull.js';

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  defaultOrg: 'dev',
  pullCache: { enabled: true, parallelism: 5, batchSize: 100 },
};
const MOCK_DB = { close: vi.fn() };
const MOCK_INVENTORY = new Map([['ApexClass', new Map([['MyClass', '2026-04-10T00:00:00.000Z']])]]);

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPullCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(MOCK_CONFIG);
  initCache.mockReturnValue(MOCK_DB);
  getCacheStatus.mockReturnValue({ orgAlias: 'dev', componentCount: 10, lastSync: '2026-04-01T00:00:00.000Z' });
  fetchOrgInventory.mockResolvedValue(MOCK_INVENTORY);
  getDelta.mockReturnValue(new Map([['ApexClass', new Set(['MyClass'])]]));
  parallelRetrieve.mockResolvedValue({ retrieved: 1, total: 1, errors: [], successfulMembers: ['ApexClass:MyClass'] });
  execa.mockResolvedValue({ exitCode: 0 });
});

describe('pull --status', () => {
  it('prints cache status and exits without retrieving', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'pull', '--status']);
    expect(fetchOrgInventory).not.toHaveBeenCalled();
    expect(parallelRetrieve).not.toHaveBeenCalled();
    expect(getCacheStatus).toHaveBeenCalled();
  });
});

describe('pull smart delta (menu option: smart)', () => {
  beforeEach(() => { inquirer.prompt.mockResolvedValue({ action: 'smart' }); });

  it('fetches inventory with withDates, computes delta, and retrieves', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(fetchOrgInventory).toHaveBeenCalledWith('dev', null, { withDates: true });
    expect(getDelta).toHaveBeenCalled();
    expect(parallelRetrieve).toHaveBeenCalled();
    expect(updateCache).toHaveBeenCalled();
    expect(MOCK_DB.close).toHaveBeenCalled();
  });

  it('skips retrieve when delta is empty', async () => {
    getDelta.mockReturnValue(new Map());
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(parallelRetrieve).not.toHaveBeenCalled();
  });
});

describe('pull --full', () => {
  it('bypasses menu, retrieves all components, updates cache', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'pull', '--full']);
    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(parallelRetrieve).toHaveBeenCalled();
    expect(updateCache).toHaveBeenCalled();
  });
});

describe('pull --dry-run', () => {
  it('shows delta without retrieving or updating cache', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'smart' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull', '--dry-run']);
    expect(parallelRetrieve).not.toHaveBeenCalled();
    expect(updateCache).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  it('sets exitCode 1 when defaultOrg is not configured', async () => {
    loadConfig.mockResolvedValue({ ...MOCK_CONFIG, defaultOrg: undefined });
    await createProgram().parseAsync(['node', 'sfdt', 'pull', '--status']);
    expect(process.exitCode).toBe(1);
  });

  it('closes db even when parallelRetrieve throws', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'smart' });
    parallelRetrieve.mockRejectedValue(new Error('sf retrieve failed'));
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(MOCK_DB.close).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('does not update cache when no components succeed', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'smart' });
    parallelRetrieve.mockResolvedValue({ retrieved: 0, total: 2, errors: [{ batch: ['Flow:X'], error: 'failed' }], successfulMembers: [] });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(updateCache).not.toHaveBeenCalled();
    expect(MOCK_DB.close).toHaveBeenCalled();
  });
});

describe('pull with pullCache disabled', () => {
  it('calls sf project retrieve start directly without using cache', async () => {
    loadConfig.mockResolvedValue({ ...MOCK_CONFIG, pullCache: { enabled: false } });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(execa).toHaveBeenCalledWith(
      'sf',
      ['project', 'retrieve', 'start', '--target-org', 'dev'],
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(fetchOrgInventory).not.toHaveBeenCalled();
    expect(parallelRetrieve).not.toHaveBeenCalled();
  });

  it('sets exitCode 1 when sf retrieve fails with cache disabled', async () => {
    loadConfig.mockResolvedValue({ ...MOCK_CONFIG, pullCache: { enabled: false } });
    execa.mockRejectedValue(new Error('sf retrieve error'));
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(process.exitCode).toBe(1);
  });
});

describe('pull --status when no cache exists', () => {
  it('prints a no-cache message without throwing', async () => {
    getCacheStatus.mockReturnValue({ orgAlias: 'dev', componentCount: 0, lastSync: null });
    await createProgram().parseAsync(['node', 'sfdt', 'pull', '--status']);
    expect(fetchOrgInventory).not.toHaveBeenCalled();
    expect(parallelRetrieve).not.toHaveBeenCalled();
  });
});

describe('pull menu option: preview', () => {
  it('calls sf project retrieve preview', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'preview' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(execa).toHaveBeenCalledWith(
      'sf',
      ['project', 'retrieve', 'preview', '--target-org', 'dev'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });
});

describe('pull menu option: conflict', () => {
  it('calls sf project retrieve start --verbose', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'conflict' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(execa).toHaveBeenCalledWith(
      'sf',
      ['project', 'retrieve', 'start', '--verbose', '--target-org', 'dev'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });
});

describe('pull menu option: reset', () => {
  it('calls sf project reset tracking --no-prompt', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'reset' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(execa).toHaveBeenCalledWith(
      'sf',
      ['project', 'reset', 'tracking', '--no-prompt', '--target-org', 'dev'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });
});

describe('pull menu option: profiles', () => {
  it('calls sf project retrieve start --metadata Profile', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'profiles' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(execa).toHaveBeenCalledWith(
      'sf',
      ['project', 'retrieve', 'start', '--metadata', 'Profile', '--target-org', 'dev'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });
});

describe('pull menu option: full', () => {
  it('calls smartPull with full:true, retrieves all components and updates cache', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'full' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(fetchOrgInventory).toHaveBeenCalledWith('dev', null, { withDates: true });
    expect(parallelRetrieve).toHaveBeenCalled();
    expect(updateCache).toHaveBeenCalled();
    expect(MOCK_DB.close).toHaveBeenCalled();
  });
});

describe('pull menu option: group', () => {
  const GROUP_CONFIG = {
    ...MOCK_CONFIG,
    pullConfig: {
      pullGroups: {
        mygroup: { description: 'My Group', metadata: ['ApexClass', 'CustomObject'] },
      },
    },
  };

  it('calls sf project retrieve start with metadata types from the group', async () => {
    loadConfig.mockResolvedValue(GROUP_CONFIG);
    inquirer.prompt.mockResolvedValue({ action: 'group:mygroup' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(execa).toHaveBeenCalledWith(
      'sf',
      [
        'project', 'retrieve', 'start',
        '--metadata', 'ApexClass',
        '--metadata', 'CustomObject',
        '--target-org', 'dev',
      ],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('sets exitCode 1 when the group key does not exist', async () => {
    loadConfig.mockResolvedValue(GROUP_CONFIG);
    inquirer.prompt.mockResolvedValue({ action: 'group:nonexistent' });
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(process.exitCode).toBe(1);
  });
});

describe('smartPull when inventory fetch fails', () => {
  it('sets exitCode 1 and does not retrieve', async () => {
    inquirer.prompt.mockResolvedValue({ action: 'smart' });
    fetchOrgInventory.mockRejectedValue(new Error('network error'));
    await createProgram().parseAsync(['node', 'sfdt', 'pull']);
    expect(parallelRetrieve).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
