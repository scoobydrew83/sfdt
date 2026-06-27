import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/doc-generator.js', () => ({
  generateDocs: vi.fn(),
  collectProjectMetadata: vi.fn(),
  buildErdMermaid: vi.fn(),
}));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('fs-extra', () => ({ default: { ensureDir: vi.fn(), writeFile: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { loadConfig } from '../../src/lib/config.js';
import { generateDocs, collectProjectMetadata, buildErdMermaid } from '../../src/lib/doc-generator.js';
import { registerDocsCommand } from '../../src/commands/docs.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDocsCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/project' });
  generateDocs.mockResolvedValue({
    outputDir: '/project/docs',
    files: ['index.md', 'objects/A.md'],
    counts: { objects: 1, apex: 0, flows: 0, lwc: 0 },
    aiUsed: false,
    guides: null,
  });
  collectProjectMetadata.mockResolvedValue({ objects: [{ name: 'A', fields: [] }] });
  buildErdMermaid.mockReturnValue('```mermaid\nerDiagram\n```');
});

describe('docs generate', () => {
  it('generates docs and prints a summary', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith({ _projectRoot: '/project' }, expect.objectContaining({ ai: false, roles: null }));
  });

  it('passes --ai through', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--ai']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ ai: true }));
  });

  it('defaults --roles to all four roles when no list is given', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--roles']);
    expect(generateDocs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ roles: ['developer', 'admin', 'user', 'devops'] }),
    );
  });

  it('subsets roles from a comma list', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--roles', 'developer,admin']);
    expect(generateDocs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ roles: ['developer', 'admin'] }),
    );
  });

  it('honors config.docs.roles when --roles has no list', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', docs: { roles: ['user'] } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--roles']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ roles: ['user'] }));
  });

  it('surfaces an AI-unavailable error from role generation', async () => {
    generateDocs.mockRejectedValue(new Error('AI features are disabled'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--roles', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'AI features are disabled' });
    expect(process.exitCode).toBe(1);
    writeSpy.mockRestore();
  });

  it('emits JSON in --json mode', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { counts: { objects: 1 } } });
    writeSpy.mockRestore();
  });

  it('reports errors as JSON', async () => {
    generateDocs.mockRejectedValue(new Error('boom'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'boom' });
    writeSpy.mockRestore();
  });
});

describe('docs diagram', () => {
  it('prints the mermaid diagram', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'diagram']);
    expect(buildErdMermaid).toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => c[0]).join('\n')).toContain('erDiagram');
    logSpy.mockRestore();
  });

  it('emits JSON with the mermaid string', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'diagram', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { mermaid: expect.stringContaining('erDiagram') } });
    writeSpy.mockRestore();
  });
});
