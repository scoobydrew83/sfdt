import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/ai.js', () => ({
  runAiPrompt: vi.fn().mockResolvedValue({ stdout: 'edited' }),
  providerSupportsAgenticTools: vi.fn(() => true),
}));
vi.mock('../../src/lib/prompts.js', () => ({ getPrompt: vi.fn().mockResolvedValue('FIX THIS:') }));

import { runAiPrompt, providerSupportsAgenticTools } from '../../src/lib/ai.js';
import { runFixLoop } from '../../src/lib/agent-loop.js';

const baseConfig = { ai: { provider: 'claude', agent: { enabled: true, allowWrite: true, maxTurns: 3 } } };

beforeEach(() => {
  vi.resetAllMocks();
  runAiPrompt.mockResolvedValue({ stdout: 'edited' });
  providerSupportsAgenticTools.mockReturnValue(true);
});

describe('runFixLoop gating', () => {
  it('does not run when agent.enabled is false', async () => {
    const r = await runFixLoop({ failureOutput: 'err', config: { ai: { agent: { enabled: false, allowWrite: true } } }, validate: vi.fn() });
    expect(r.ran).toBe(false);
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('does not run when allowWrite is false', async () => {
    const r = await runFixLoop({ failureOutput: 'err', config: { ai: { agent: { enabled: true, allowWrite: false } } }, validate: vi.fn() });
    expect(r.ran).toBe(false);
  });

  it('does not run for non-agentic (http) providers', async () => {
    providerSupportsAgenticTools.mockReturnValue(false);
    const r = await runFixLoop({ failureOutput: 'err', config: baseConfig, validate: vi.fn() });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/agentic CLI provider/);
  });

  it('does not run without a validate callback', async () => {
    const r = await runFixLoop({ failureOutput: 'err', config: baseConfig });
    expect(r.ran).toBe(false);
  });
});

describe('runFixLoop iteration', () => {
  it('stops as soon as validation passes', async () => {
    const validate = vi.fn().mockResolvedValueOnce({ ok: true, output: '' });
    const r = await runFixLoop({ failureOutput: 'boom', config: baseConfig, projectRoot: '/p', org: 'dev', validate });
    expect(r.fixed).toBe(true);
    expect(r.turns).toHaveLength(1);
    expect(runAiPrompt).toHaveBeenCalledTimes(1);
  });

  it('retries with the new output and gives up after maxTurns', async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, output: 'still failing 1' })
      .mockResolvedValueOnce({ ok: false, output: 'still failing 2' });
    const r = await runFixLoop({ failureOutput: 'boom', config: baseConfig, projectRoot: '/p', org: 'dev', validate, maxTurns: 2 });
    expect(r.fixed).toBe(false);
    expect(r.turns).toHaveLength(2);
    expect(runAiPrompt).toHaveBeenCalledTimes(2);
  });

  it('grants write tools to the AI session', async () => {
    const validate = vi.fn().mockResolvedValue({ ok: true });
    await runFixLoop({ failureOutput: 'boom', config: baseConfig, projectRoot: '/p', org: 'dev', validate });
    const opts = runAiPrompt.mock.calls[0][1];
    expect(opts.allowedTools).toContain('Edit');
    expect(opts.interactive).toBe(false);
  });

  it('clamps maxTurns into [1,20]', async () => {
    const validate = vi.fn().mockResolvedValue({ ok: false, output: 'x' });
    const r = await runFixLoop({ failureOutput: 'boom', config: baseConfig, projectRoot: '/p', org: 'dev', validate, maxTurns: 99 });
    expect(r.turns.length).toBeLessThanOrEqual(20);
  });
});
