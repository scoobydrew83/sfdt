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

import fs from 'fs-extra';
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
    expect(generateDocs).toHaveBeenCalledWith(
      { _projectRoot: '/project' },
      expect.objectContaining({ ai: false, roles: null, diagrams: false }),
    );
  });

  it('passes --ai through', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--ai']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ ai: true }));
  });

  it('enables AI from config when features.ai is on and docs.ai is not false', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', features: { ai: true } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ ai: true }));
  });

  it('keeps AI off when config docs.ai is false and no flag is passed', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', features: { ai: true }, docs: { ai: false } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ ai: false }));
  });

  it('keeps AI off when features.ai is disabled even with docs.ai true', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', docs: { ai: true } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ ai: false }));
  });

  it('--no-ai forces AI off even when config enables it', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', features: { ai: true }, docs: { ai: true } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--no-ai']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ ai: false }));
  });

  it('--ai forces the option on even when config leaves AI off', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project' });
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

  it('enables role guides from config.docs.roleGuides when --roles is absent', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', features: { ai: true }, docs: { roleGuides: true, roles: ['admin'] } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ roles: ['admin'] }));
  });

  it('uses the default role list when docs.roleGuides is on without docs.roles', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', features: { ai: true }, docs: { roleGuides: true } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ roles: ['developer', 'admin', 'user', 'devops'] }),
    );
  });

  it('lets an explicit --roles list override config.docs.roleGuides roles', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', docs: { roleGuides: true, roles: ['admin'] } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--roles', 'developer']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ roles: ['developer'] }));
  });

  it('keeps role guides off when docs.roleGuides is false and no flag is passed', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', docs: { roleGuides: false, roles: ['admin'] } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ roles: null }));
  });

  it('runs the ER-diagram step when config.docs.diagrams is enabled', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', docs: { diagrams: true } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ diagrams: true }));
  });

  it('--no-diagrams overrides config.docs.diagrams', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', docs: { diagrams: true } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--no-diagrams']);
    expect(generateDocs).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ diagrams: false }));
  });

  it('prints the ER diagram path in pretty mode when one was written', async () => {
    generateDocs.mockResolvedValue({
      outputDir: '/project/docs',
      files: ['index.md', 'diagrams/erd.md'],
      counts: { objects: 1, apex: 0, flows: 0, lwc: 0 },
      aiUsed: false,
      guides: null,
      diagram: 'diagrams/erd.md',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('ER diagram: diagrams/erd.md');
    logSpy.mockRestore();
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

  it('prints role-guide counts (and skipped) in pretty mode', async () => {
    generateDocs.mockResolvedValue({
      outputDir: '/project/docs',
      files: ['index.md'],
      counts: { objects: 1, apex: 0, flows: 0, lwc: 0 },
      aiUsed: true,
      guides: { written: 3, roles: ['developer', 'admin'], skipped: ['x', 'y'] },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate', '--roles']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Role guides: 3 written');
    expect(out).toContain('Skipped (empty AI output): 2');
    logSpy.mockRestore();
  });

  it('reports a generation failure on stderr in pretty mode', async () => {
    generateDocs.mockRejectedValue(new Error('parse error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'generate']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('parse error'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
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

  it('writes the diagram to a file with --output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'diagram', '--output', 'out/erd.mmd']);
    expect(fs.ensureDir).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith('out/erd.mmd', expect.stringContaining('erDiagram'));
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('ER diagram written to');
    logSpy.mockRestore();
  });

  it('reports a diagram failure on stderr in pretty mode', async () => {
    collectProjectMetadata.mockRejectedValue(new Error('no metadata'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'diagram']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no metadata'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('reports a diagram failure as JSON', async () => {
    collectProjectMetadata.mockRejectedValue(new Error('no metadata'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'docs', 'diagram', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'no metadata' });
    writeSpy.mockRestore();
  });
});
