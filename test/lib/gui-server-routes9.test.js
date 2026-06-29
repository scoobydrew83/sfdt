/**
 * Route tests for the AI-available success paths (the existing suites only
 * exercise the AI-unavailable / validation branches) plus the manifest-saving
 * branches of the manifest/build and compare/manifest handlers:
 *
 *   POST /api/review               (AI review of a non-empty diff)
 *   POST /api/changelog/generate   (AI changelog, agentic + http-provider paths)
 *   POST /api/release-notes/generate (AI release notes)
 *   POST /api/manifest/build       (render + save package.xml + destructiveChanges)
 *   POST /api/compare/manifest     (render + save)
 *
 * ai.js / ai-context.js / prompts.js / metadata-mapper.js / git-utils.js are
 * mocked so the agentic collaborators are deterministic; execa returns a git
 * diff so the review/build paths run end to end.
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

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn().mockResolvedValue(true),
  aiUnavailableMessage: vi.fn().mockReturnValue('AI not configured'),
  runAiPrompt: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '## Result\nlooks good' }),
  providerSupportsAgenticTools: vi.fn().mockReturnValue(true),
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
  formatMetadataTypesSection: vi.fn().mockReturnValue(''),
  gatherGitLog: vi.fn().mockResolvedValue('abc123 commit one'),
  frameProvidedContext: vi.fn((label, body) => `\n[${label}]\n${body}`),
}));

vi.mock('../../src/lib/prompts.js', () => ({
  getPrompt: vi.fn().mockResolvedValue('PROMPT:\n'),
  getAllPrompts: vi.fn().mockResolvedValue({}),
  setPromptOverride: vi.fn().mockResolvedValue(undefined),
  resetPromptOverride: vi.fn().mockResolvedValue(undefined),
  interpolate: vi.fn((s) => s),
}));

vi.mock('../../src/lib/metadata-mapper.js', () => ({
  parseDiffToMetadata: vi.fn(() => ({
    additive: { ApexClass: ['Foo'] },
    destructive: { ApexClass: ['Bar'] },
  })),
  renderPackageXml: vi.fn(() => '<?xml version="1.0"?><Package/>'),
  countMembers: vi.fn(() => 2),
}));

vi.mock('../../src/lib/git-utils.js', () => ({
  isSafeGitRef: vi.fn(() => true),
  resolveBaseRef: vi.fn().mockResolvedValue('main'),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0, isDirectory: () => false }),
    remove: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import fs from 'fs-extra';
import { execa } from 'execa';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { isAiAvailable, runAiPrompt, providerSupportsAgenticTools } from '../../src/lib/ai.js';
import { gatherGitLog } from '../../src/lib/ai-context.js';

// ─── Shared config & helpers ──────────────────────────────────────────────────

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  sourceApiVersion: '59.0',
  defaultSourcePath: 'force-app/main/default',
  manifestDir: 'manifest/release',
  releaseNotesDir: 'release-notes',
  logDir: '/project/logs',
  packageDirectories: [{ name: 'core', path: 'force-app/main/default' }],
  features: { ai: true },
};

const VERSION = '0.0.0';
const PORT = 7654;

function collectSse(text) {
  return text
    .split('\n\n')
    .filter((c) => c.startsWith('data:'))
    .map((c) => JSON.parse(c.replace(/^data:\s*/, '')));
}

let app;
let csrf;
beforeAll(async () => {
  app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  csrf = (await request(app).get('/api/csrf-token')).body.token;
});
afterAll(async () => {
  await app.cleanup?.();
});
beforeEach(() => {
  vi.clearAllMocks();
  isAiAvailable.mockResolvedValue(true);
  runAiPrompt.mockResolvedValue({ exitCode: 0, stdout: '## Result\nlooks good' });
  providerSupportsAgenticTools.mockReturnValue(true);
  execa.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  fs.pathExists.mockResolvedValue(false);
});

// ─── POST /api/review — AI success ────────────────────────────────────────────

describe('POST /api/review — AI available', () => {
  it('runs the AI review over a non-empty diff and streams the result', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: '+ added line\n- removed line' });

    const res = await request(app)
      .post('/api/review')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main' });

    expect(res.status).toBe(200);
    expect(runAiPrompt).toHaveBeenCalledOnce();
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && /looks good/.test(e.line))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0 });
  });

  it('short-circuits when the diff is empty', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: '' });

    const res = await request(app)
      .post('/api/review')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main' });

    expect(runAiPrompt).not.toHaveBeenCalled();
    const events = collectSse(res.text);
    expect(events.some((e) => /No changes found/.test(e.line))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0, content: '' });
  });

  it('emits an SSE error when AI is unavailable', async () => {
    isAiAvailable.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/review')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main' });
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'error' && /not available/i.test(e.message))).toBe(true);
  });
});

// ─── POST /api/changelog/generate — AI success ────────────────────────────────

describe('POST /api/changelog/generate — AI available', () => {
  it('streams the AI changelog output (agentic provider)', async () => {
    const res = await request(app)
      .post('/api/changelog/generate')
      .set('X-SFDT-CSRF', csrf)
      .send({});

    expect(res.status).toBe(200);
    expect(runAiPrompt).toHaveBeenCalledOnce();
    expect(gatherGitLog).not.toHaveBeenCalled(); // agentic → no pre-gather
    const events = collectSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0 });
  });

  it('pre-gathers git log for non-agentic (http) providers and scopes to a package', async () => {
    providerSupportsAgenticTools.mockReturnValue(false);

    const res = await request(app)
      .post('/api/changelog/generate')
      .set('X-SFDT-CSRF', csrf)
      .send({ package: 'core' });

    expect(res.status).toBe(200);
    expect(gatherGitLog).toHaveBeenCalledOnce();
    const events = collectSse(res.text);
    expect(events.some((e) => /package "core"/.test(e.line))).toBe(true);
  });

  it('emits an SSE error when AI is unavailable', async () => {
    isAiAvailable.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/changelog/generate')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

// ─── POST /api/release-notes/generate — AI success ────────────────────────────

describe('POST /api/release-notes/generate — AI available', () => {
  it('streams the AI release notes output', async () => {
    const res = await request(app)
      .post('/api/release-notes/generate')
      .set('X-SFDT-CSRF', csrf)
      .send({ version: '1.2.3' });

    expect(res.status).toBe(200);
    expect(runAiPrompt).toHaveBeenCalledOnce();
    const events = collectSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0 });
  });

  it('surfaces the AI runner error as an SSE error', async () => {
    runAiPrompt.mockRejectedValue(new Error('model timeout'));
    const res = await request(app)
      .post('/api/release-notes/generate')
      .set('X-SFDT-CSRF', csrf)
      .send({ version: '1.2.3' });
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'error' && /model timeout/.test(e.message))).toBe(true);
  });
});

// ─── POST /api/manifest/build — render + save ─────────────────────────────────

describe('POST /api/manifest/build', () => {
  it('renders a package.xml without saving by default', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'A\tforce-app/main/default/classes/Foo.cls' });

    const res = await request(app)
      .post('/api/manifest/build')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main', head: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.addCount).toBe(2);
    expect(res.body.delCount).toBe(2);
    expect(res.body.path).toBe(''); // not saved
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('saves the package.xml and a destructiveChanges file when named', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'A\tforce-app/main/default/classes/Foo.cls' });

    const res = await request(app)
      .post('/api/manifest/build')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main', head: 'HEAD', name: '1.0.0', save: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.filename).toBe('rl-1.0.0-package.xml');
    expect(res.body.path).toContain('rl-1.0.0-package.xml');
    // primary + destructiveChanges (delCount > 0)
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('returns 409 when a named manifest already exists', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'A\tforce-app/main/default/classes/Foo.cls' });
    fs.pathExists.mockResolvedValue(true); // file already there

    const res = await request(app)
      .post('/api/manifest/build')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main', head: 'HEAD', name: '1.0.0', save: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('returns 400 for an invalid release label', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'A\tforce-app/main/default/classes/Foo.cls' });
    const res = await request(app)
      .post('/api/manifest/build')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main', head: 'HEAD', name: '../escape', save: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid release label/);
  });

  it('returns 500 when git diff fails', async () => {
    execa.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'fatal: bad revision' });
    const res = await request(app)
      .post('/api/manifest/build')
      .set('X-SFDT-CSRF', csrf)
      .send({ base: 'main', head: 'HEAD' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/git diff failed/);
  });
});

// ─── POST /api/compare/manifest — render + save ───────────────────────────────

describe('POST /api/compare/manifest', () => {
  it('renders xml from items without saving', async () => {
    const res = await request(app)
      .post('/api/compare/manifest')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: 'Foo' }] });

    expect(res.status).toBe(200);
    expect(res.body.xml).toContain('Package');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('saves a versioned manifest file', async () => {
    const res = await request(app)
      .post('/api/compare/manifest')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: 'Foo' }], save: true, version: '2.0.0' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.filename).toBe('rl-2.0.0-package.xml');
    expect(fs.writeFile).toHaveBeenCalledOnce();
  });

  it('rejects an invalid version format', async () => {
    const res = await request(app)
      .post('/api/compare/manifest')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [], save: true, version: 'not-a-version' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid version format/);
  });
});
