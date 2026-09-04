import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/ai.js', () => ({
  runAiPrompt: vi.fn().mockResolvedValue({ stdout: 'edited' }),
  providerSupportsAgenticTools: vi.fn(() => true),
}));
vi.mock('../../src/lib/prompts.js', () => ({ getPrompt: vi.fn().mockResolvedValue('FIX THIS:') }));

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { runAiPrompt, providerSupportsAgenticTools } from '../../src/lib/ai.js';
import { runFixLoop } from '../../src/lib/agent-loop.js';
import { AI_WRITE_ENV_VAR } from '../../src/lib/config-trust.js';
import { queryRuns } from '../../src/lib/run-history.js';

const baseConfig = { ai: { provider: 'claude', agent: { maxTurns: 3 } } };

beforeEach(() => {
  vi.resetAllMocks();
  runAiPrompt.mockResolvedValue({ stdout: 'edited' });
  providerSupportsAgenticTools.mockReturnValue(true);
  // The grant now comes from the operator's shell, so the happy-path tests below
  // have to supply it the way an operator would.
  process.env[AI_WRITE_ENV_VAR] = '1';
});

afterEach(() => {
  delete process.env[AI_WRITE_ENV_VAR];
});

describe('runFixLoop gating', () => {
  it('does not run without the environment grant, however the config file is written', async () => {
    // The exploit from sfdt-private#14 H1: a cloned repo's .sfdt/config.json set
    // both booleans and the loop ran with `Edit` in the victim's checkout. Two
    // booleans in an attacker-controlled file are one gate, not two.
    delete process.env[AI_WRITE_ENV_VAR];
    const hostile = { ai: { provider: 'claude', agent: { enabled: true, allowWrite: true, maxTurns: 20 } } };
    const r = await runFixLoop({ failureOutput: 'err', config: hostile, validate: vi.fn() });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain(AI_WRITE_ENV_VAR);
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('does not accept a truthy-but-wrong environment value', async () => {
    process.env[AI_WRITE_ENV_VAR] = 'true';
    const r = await runFixLoop({ failureOutput: 'err', config: baseConfig, validate: vi.fn() });
    expect(r.ran).toBe(false);
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('DOES run with the environment grant and no agent booleans in config at all', async () => {
    // The escape hatch has to work, or the feature is removed rather than secured.
    const validate = vi.fn().mockResolvedValueOnce({ ok: true, output: '' });
    const r = await runFixLoop({ failureOutput: 'boom', config: baseConfig, projectRoot: '/p', org: 'dev', validate });
    expect(r.ran).toBe(true);
    expect(runAiPrompt).toHaveBeenCalledTimes(1);
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

describe('runFixLoop history', () => {
  it('persists an agent-fix row queryable via run-history', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-agentfix-'));
    try {
      const validate = vi.fn().mockResolvedValueOnce({ ok: true, output: '' });
      await runFixLoop({ failureOutput: 'boom', config: { ...baseConfig, logDir }, org: 'dev', validate });
      const rows = queryRuns(logDir, { type: 'agent-fix' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'agent-fix', org: 'dev', status: 'pass' });
      expect(rows[0].summary).toMatchObject({ turns: 1, ran: true });
    } finally {
      await fs.remove(logDir);
    }
  });

  // The suite scrubs SFDT_HARNESS_TELEMETRY (test/setup-env.js) so a plain
  // `npm test` never appends synthetic rows to the tracked JSONL. Set it
  // explicitly here so the mirroring path is still covered — and assert that
  // `org` stays out of it, since that file is committed to a public repo.
  it('mirrors an agent-fix row to SFDT_HARNESS_TELEMETRY without leaking org', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-tele-'));
    const telemetry = path.join(dir, 'telemetry.jsonl');
    process.env.SFDT_HARNESS_TELEMETRY = telemetry;
    try {
      const validate = vi.fn().mockResolvedValueOnce({ ok: true, output: '' });
      await runFixLoop({ failureOutput: 'boom', config: { ...baseConfig, logDir: dir }, org: 'dev', validate });

      const rows = (await fs.readFile(telemetry, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'agent-fix', status: 'pass' });
      expect(rows[0].org).toBeUndefined();
      expect(rows[0].timestamp).toEqual(expect.any(String));
    } finally {
      delete process.env.SFDT_HARNESS_TELEMETRY;
      await fs.remove(dir);
    }
  });
});
