/**
 * Tests for POST /api/explain (source field + heuristic fallback)
 * and GET /api/logs/list.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../src/lib/log-writer.js', () => ({
  writeLog: vi.fn(),
  parseSfdtLogLines: vi.fn().mockReturnValue({ checks: [], components: [] }),
  readLatestLog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/update-checker.js', async (importActual) => ({
  ...(await importActual()),
  fetchLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

vi.mock('../../src/lib/config-utils.js', () => ({
  setNestedValue: vi.fn(),
  coerceConfigValue: vi.fn((v) => v),
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
    projectName: 'Test',
    defaultOrg: 'dev',
    logDir: '/project/logs',
    features: { ai: false },
  }),
  getConfigDir: vi.fn().mockReturnValue('/project/.sfdt'),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), mtimeMs: Date.now(), size: 100, isDirectory: () => false }),
    remove: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue(['/project/logs/deploy.log']),
}));

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn().mockResolvedValue(false),
  aiUnavailableMessage: vi.fn().mockReturnValue('AI not configured'),
  runAiPrompt: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '## Root Cause\nThe fix.' }),
}));

vi.mock('../../src/lib/ai-context.js', () => ({
  buildProjectContext: vi.fn().mockResolvedValue(null),
  readLatestTestRuns: vi.fn().mockResolvedValue([]),
  readLatestPreflight: vi.fn().mockResolvedValue(null),
  readDeployHistory: vi.fn().mockResolvedValue([]),
  buildContextBlock: vi.fn().mockReturnValue(''),
  formatTestRunsSection: vi.fn().mockReturnValue(''),
  formatPreflightSection: vi.fn().mockReturnValue(''),
  formatDeployHistorySection: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/lib/prompts.js', () => ({
  getPrompt: vi.fn().mockResolvedValue('Analyze this log:\n'),
  getAllPrompts: vi.fn().mockResolvedValue({}),
  setPromptOverride: vi.fn().mockResolvedValue(undefined),
  resetPromptOverride: vi.fn().mockResolvedValue(undefined),
  interpolate: vi.fn((s) => s),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { isAiAvailable, runAiPrompt } from '../../src/lib/ai.js';

// ─── Shared config ───────────────────────────────────────────────────────────

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test',
  defaultOrg: 'dev',
  logDir: '/project/logs',
  features: { ai: false },
};

const VERSION = '1.2.3';
const PORT = 7654;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectSseEvents(text) {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data:'))
    .map((chunk) => JSON.parse(chunk.replace(/^data:\s*/, '')));
}

async function setupLogFileMock() {
  const { default: fsMock } = await import('fs-extra');
  fsMock.pathExists.mockResolvedValue(true);
  fsMock.readFile.mockResolvedValue("No such column 'Amount' on entity 'Opportunity'");
  fsMock.stat.mockResolvedValue({ mtime: new Date(), mtimeMs: Date.now(), size: 100, isDirectory: () => false });
}

// ─── Reset mocks between tests ───────────────────────────────────────────────

beforeEach(async () => {
  vi.resetAllMocks();
  const { default: fsMock } = await import('fs-extra');
  fsMock.existsSync.mockReturnValue(false);
  fsMock.pathExists.mockResolvedValue(false);
  fsMock.readJson.mockResolvedValue({});
  fsMock.readdir.mockResolvedValue([]);
  fsMock.readFile.mockResolvedValue('');
  fsMock.outputJson.mockResolvedValue(undefined);
  fsMock.stat.mockResolvedValue({ mtime: new Date(), mtimeMs: Date.now(), size: 100, isDirectory: () => false });
  fsMock.remove.mockResolvedValue(undefined);
  fsMock.ensureDir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.writeJson.mockResolvedValue(undefined);

  vi.mocked(isAiAvailable).mockResolvedValue(false);
  vi.mocked(runAiPrompt).mockResolvedValue({ exitCode: 0, stdout: '## Root Cause\nThe fix.' });

  const { glob } = await import('glob');
  vi.mocked(glob).mockResolvedValue(['/project/logs/deploy.log']);
});

// ─── POST /api/explain — source field and heuristic fallback ─────────────────

describe('POST /api/explain — source field and heuristic fallback', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns source=heuristic result when AI is not available', async () => {
    await setupLogFileMock();
    vi.mocked(isAiAvailable).mockResolvedValue(false);

    const res = await request(app).post('/api/explain').send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const events = collectSseEvents(res.text);
    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent.source).toBe('heuristic');
    expect(resultEvent.exitCode).toBe(0);
    expect(resultEvent.content).toContain('Amount');
  });

  it('returns source=ai result when AI is available', async () => {
    await setupLogFileMock();
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    vi.mocked(runAiPrompt).mockResolvedValue({ exitCode: 0, stdout: '## Root Cause\nDetails.' });

    const res = await request(app).post('/api/explain').send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const events = collectSseEvents(res.text);
    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent.source).toBe('ai');
    expect(resultEvent.exitCode).toBe(0);
  });

  it('resolves a project-relative logPath from /api/logs/list and returns a result event', async () => {
    // Simulate the path returned by the fixed /api/logs/list: "logs/deploy-20260510.log"
    // path.resolve('/project', 'logs/deploy-20260510.log') => '/project/logs/deploy-20260510.log'
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(true);
    fsMock.readFile.mockResolvedValue("No such column 'CreatedDate' on entity 'Lead'");
    fsMock.stat.mockResolvedValue({ mtime: new Date(), mtimeMs: Date.now(), size: 200, isDirectory: () => false });
    vi.mocked(isAiAvailable).mockResolvedValue(false);

    const res = await request(app)
      .post('/api/explain')
      .send({ logPath: 'logs/deploy-20260510.log' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const events = collectSseEvents(res.text);
    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent.source).toBe('heuristic');
    expect(resultEvent.exitCode).toBe(0);
    // The resolved file content should be reflected in the explanation
    expect(resultEvent.content).toContain('CreatedDate');
  });
});

// ─── GET /api/logs/list ───────────────────────────────────────────────────────

describe('GET /api/logs/list', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns empty files array when log dir does not exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(false);

    const res = await request(app).get('/api/logs/list');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [] });
  });

  it('returns .log and .json filenames sorted newest-first as project-relative paths, including archives', async () => {
    const { default: fsMock } = await import('fs-extra');
    const { glob } = await import('glob');
    fsMock.pathExists.mockResolvedValue(true);
    vi.mocked(glob).mockResolvedValue([
      'new.log',
      'old.log',
      'deploy-results/archive.json'
    ]);
    const now = Date.now();
    fsMock.stat.mockImplementation(async (p) => {
      if (p.endsWith('new.log')) return { mtimeMs: now + 1000 };
      if (p.endsWith('old.log')) return { mtimeMs: now };
      if (p.endsWith('archive.json')) return { mtimeMs: now + 500 };
      return { mtimeMs: now - 1000 };
    });

    const res = await request(app).get('/api/logs/list');
    expect(res.status).toBe(200);
    // Paths should be relative to projectRoot (e.g. "logs/new.log")
    expect(res.body.files[0]).toBe('logs/new.log');
    expect(res.body.files[1]).toBe('logs/deploy-results/archive.json');
    expect(res.body.files[2]).toBe('logs/old.log');
  });

  it('caps at 50 files', async () => {
    const { default: fsMock } = await import('fs-extra');
    const { glob } = await import('glob');
    fsMock.pathExists.mockResolvedValue(true);
    const files = Array.from({ length: 60 }, (_, i) => `file${i}.log`);
    vi.mocked(glob).mockResolvedValue(files);
    const now = Date.now();
    fsMock.stat.mockImplementation(async () => ({ mtimeMs: now }));

    const res = await request(app).get('/api/logs/list');
    expect(res.status).toBe(200);
    expect(res.body.files.length).toBe(50);
  });
});
