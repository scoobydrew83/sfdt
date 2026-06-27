/**
 * Tests for `sfdt flow scan` and `sfdt flow conflicts` — mocks execa so the
 * tests don't shell out to the real `sf` CLI. Each query returns canned
 * Tooling API responses; we then exercise the registered Commander command
 * directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// ─── Mock fs-extra so writeJson doesn't actually hit disk. ────────────────
vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Mock execa so each `sf data query` returns a deterministic Tooling
// API response. We dispatch on the SOQL text in the args. ─────────────────
const execaCalls = [];
let executor;

vi.mock('execa', () => ({
  execa: vi.fn(async (cmd, args) => {
    execaCalls.push({ cmd, args });
    if (executor) return executor(cmd, args);
    return { stdout: JSON.stringify({ result: { records: [] } }) };
  }),
}));

// ─── Mock loadConfig so the flow command doesn't need a .sfdt/ on disk. ──
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(async () => ({
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
    defaultOrg: 'dev',
    logDir: '/project/logs',
  })),
  ConfigError: class extends Error {},
}));

import { registerFlowCommand } from '../../src/commands/flow.js';
import fs from 'fs-extra';

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerFlowCommand(program);
  return program;
}

beforeEach(() => {
  execaCalls.length = 0;
  executor = null;
  vi.mocked(fs.writeJson).mockClear();
});

describe('sfdt flow scan', () => {
  it('queries FlowDefinitions, then fetches each active version and writes a report', async () => {
    executor = (_cmd, args) => {
      const soql = args[args.indexOf('-q') + 1] ?? '';
      if (soql.startsWith('SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition')) {
        return {
          stdout: JSON.stringify({
            result: {
              records: [
                { Id: '300A', DeveloperName: 'My_Flow', ActiveVersionId: '301A' },
              ],
            },
          }),
        };
      }
      if (soql.includes('FROM Flow WHERE Id =')) {
        return {
          stdout: JSON.stringify({
            result: {
              records: [
                {
                  Id: '301A',
                  MasterLabel: 'My Flow',
                  Status: 'Active',
                  VersionNumber: 1,
                  Metadata: {
                    label: 'My Flow',
                    description: 'present',
                    apiVersion: 62,
                    processType: 'Flow',
                  },
                },
              ],
            },
          }),
        };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }) };
    };

    const program = buildProgram();
    await program.parseAsync(['node', 'sfdt', 'flow', 'scan', '--org', 'dev']);

    expect(execaCalls).toHaveLength(2);
    // The flow command writes the report to logs/flow-scan-latest.json.
    expect(vi.mocked(fs.writeJson)).toHaveBeenCalledOnce();
    const [outPath, body] = vi.mocked(fs.writeJson).mock.calls[0];
    expect(outPath).toContain('flow-scan-latest.json');
    expect(body.org).toBe('dev');
    expect(body.totalFlows).toBe(1);
    expect(body.reports[0].overallScore).toBe(100);
    expect(body.reports[0].label).toBe('My Flow');
  });

  it('--json emits the report to stdout without writing a file', async () => {
    executor = () => ({
      stdout: JSON.stringify({ result: { records: [] } }),
    });

    const writes = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const program = buildProgram();
      await program.parseAsync(['node', 'sfdt', 'flow', 'scan', '--org', 'dev', '--json']);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(vi.mocked(fs.writeJson)).not.toHaveBeenCalled();
    const json = JSON.parse(writes.join(''));
    expect(json.status).toBe(0);
    expect(json.result.org).toBe('dev');
    expect(json.result.totalFlows).toBe(0);
  });
});

describe('sfdt flow conflicts', () => {
  it('detects record-triggered flows sharing the same object + timing + event', async () => {
    executor = (_cmd, args) => {
      const soql = args[args.indexOf('-q') + 1] ?? '';
      if (soql.startsWith('SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition')) {
        return {
          stdout: JSON.stringify({
            result: {
              records: [
                { Id: '300A', DeveloperName: 'Flow_A', ActiveVersionId: '301A' },
                { Id: '300B', DeveloperName: 'Flow_B', ActiveVersionId: '301B' },
              ],
            },
          }),
        };
      }
      if (soql.includes('301A')) {
        return {
          stdout: JSON.stringify({
            result: {
              records: [
                {
                  Id: '301A',
                  MasterLabel: 'Flow A',
                  Metadata: {
                    processType: 'AutoLaunchedFlow',
                    start: {
                      triggerType: 'RecordAfterSaveCreate',
                      recordTriggerType: 'Create',
                      object: 'Account',
                      filters: [{}],
                    },
                  },
                },
              ],
            },
          }),
        };
      }
      if (soql.includes('301B')) {
        return {
          stdout: JSON.stringify({
            result: {
              records: [
                {
                  Id: '301B',
                  MasterLabel: 'Flow B',
                  Metadata: {
                    processType: 'AutoLaunchedFlow',
                    start: {
                      triggerType: 'RecordAfterSaveCreate',
                      recordTriggerType: 'Create',
                      object: 'Account',
                    },
                  },
                },
              ],
            },
          }),
        };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }) };
    };

    const program = buildProgram();
    await program.parseAsync(['node', 'sfdt', 'flow', 'conflicts', '--org', 'dev']);

    const [, body] = vi.mocked(fs.writeJson).mock.calls[0];
    expect(body.totalGroups).toBe(1);
    expect(body.groups[0].objectApiName).toBe('Account');
    expect(body.groups[0].flows).toHaveLength(2);
    expect(body.groups[0].flows.map((f) => f.label).sort()).toEqual(['Flow A', 'Flow B']);
  });

  it('emits zero groups when no flows share object + timing + event', async () => {
    executor = (_cmd, args) => {
      const soql = args[args.indexOf('-q') + 1] ?? '';
      if (soql.startsWith('SELECT Id, DeveloperName')) {
        return {
          stdout: JSON.stringify({
            result: {
              records: [{ Id: '300', DeveloperName: 'Solo', ActiveVersionId: '301' }],
            },
          }),
        };
      }
      return {
        stdout: JSON.stringify({
          result: {
            records: [
              {
                Id: '301',
                MasterLabel: 'Solo',
                Metadata: {
                  processType: 'AutoLaunchedFlow',
                  start: {
                    triggerType: 'RecordAfterSaveCreate',
                    recordTriggerType: 'Create',
                    object: 'Account',
                  },
                },
              },
            ],
          },
        }),
      };
    };
    const program = buildProgram();
    await program.parseAsync(['node', 'sfdt', 'flow', 'conflicts', '--org', 'dev']);
    const [, body] = vi.mocked(fs.writeJson).mock.calls[0];
    expect(body.totalGroups).toBe(0);
  });
});
